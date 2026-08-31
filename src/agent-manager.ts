/**
 * Trimegisto - Agent Manager
 *
 * Manages agent lifecycle: spawn, track, kill, halt.
 * Each agent runs as a separate pi process.
 *
 * Agent IDs follow the format: t1a, t1b, t2a, t2b, t3a, t3c...
 *   t = trimegisto, number = tier, letter = instance
 *
 * KEY DESIGN: launchAgent() returns immediately after spawning the child process.
 * It does NOT block until the process exits. All process output is streamed via
 * the agent log callback. Completion is signaled via the resolve callback on the
 * AgentInstance. This allows pi to remain responsive while agents run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentInstance, AgentResult, AgentStatus, AgentTier, TierConfig, AgentLogEntry } from "./types.ts";
import { formatTierLabel } from "./config.ts";
import { scanSpawnRequests, writeSpawnResponse, cleanupStaleFiles, setInstanceDir as setIpcInstanceDir } from "./ipc.ts";
import { releaseAllAgentLocks, setInstanceDir as setLockInstanceDir } from "./file-lock.ts";
import { broadcastFileChange, clearAgentContext, setInstanceDir as setContextInstanceDir } from "./context-broker.ts";
import { type LoopSupervisor, type LoopAlert } from "./loop-supervisor.ts";
import { speed } from "./speed.ts";

/** Path to the sub-agent extension that provides trimegisto_spawn tool */
let subagentExtensionPath: string | null = null;

export function setSubagentExtensionPath(p: string): void {
  subagentExtensionPath = p;
}

/** Per-instance directory for this Trimegisto instance (isolates IPC, locks, context from other pi processes) */
let instanceDir: string | null = null;

/**
 * Set the per-instance directory for this Trimegisto instance.
 * This ensures IPC, locks, and context notifications are isolated
 * from other pi processes running concurrently.
 */
export function setInstanceDir(dir: string): void {
  instanceDir = dir;
  setIpcInstanceDir(dir);
  setLockInstanceDir(dir);
  setContextInstanceDir(dir);
}

function getSubagentExtensionPath(): string {
  if (subagentExtensionPath) return subagentExtensionPath;
  // Fallback: try to resolve relative to this file
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(thisDir, "subagent-extension.ts");
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* ESM/CJS mismatch in some runtimes */ }
  // Last resort: resolve from agent extensions dir
  const fallback = path.join(getAgentDir(), "extensions", "trimegisto", "subagent-extension.ts");
  return fallback;
}

/** Maps agent IDs to instances */
const agents = new Map<string, AgentInstance>();

/** Patterns in stderr that signal provider-side exhaustion (quota, rate limit, overload) */
const PROVIDER_EXHAUSTION_PATTERN = /429|rate.?limit|quota|insufficient|overload|exhausted|capacity|503|payment|billing|usage limit|limit reached|402/i;

/**
 * Watchdogs keep background workers from blocking orchestration forever.
 * Defaults are intentionally bounded: agents are scouts/workers, not a second
 * unbounded main session. Env overrides are useful while testing locally.
 */
const FIRST_RESPONSE_TIMEOUT_MS = parseInt(process.env.TRIMEGISTO_FIRST_RESPONSE_TIMEOUT_MS || "90000", 10);
const AGENT_IDLE_TIMEOUT_MS = parseInt(process.env.TRIMEGISTO_AGENT_IDLE_TIMEOUT_MS || "120000", 10);
const AGENT_MAX_RUNTIME_MS = parseInt(process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS || "300000", 10);

/**
 * Build the ordered model pool for a tier: primary model first, then redundant models.
 * Redundant models are only included when the redundant-agents feature is ON.
 */
export function getModelPool(tierConfig: TierConfig, redundantAgents: boolean): string[] {
  const pool: string[] = [];
  if (tierConfig.model) pool.push(tierConfig.model);
  if (redundantAgents && tierConfig.redundantModels) {
    for (const m of tierConfig.redundantModels) {
      if (m && !pool.includes(m)) pool.push(m);
    }
  }
  return pool;
}

/** Count agents of a tier currently running on a specific requested model */
function countRunningOnModel(tier: AgentTier, model: string): number {
  let n = 0;
  for (const a of agents.values()) {
    if (a.tier === tier && (a.status === "running" || a.status === "waiting") && a.requestedModel === model) n++;
  }
  return n;
}

/**
 * Pick the least-loaded model in the pool that still has capacity (< maxParallel running).
 * Returns null if every model in the pool is saturated.
 */
export function selectAvailableModel(tier: AgentTier, pool: string[], maxParallel: number): string | null {
  let best: string | null = null;
  let bestCount = Infinity;
  for (const model of pool) {
    const running = countRunningOnModel(tier, model);
    if (running < maxParallel && running < bestCount) {
      best = model;
      bestCount = running;
    }
  }
  return best;
}

/**
 * Pooled capacity check: the tier can spawn if ANY model in its pool has capacity.
 * Falls back to the classic per-tier count when redundancy is off or the pool has a single model.
 */
export function canSpawnPooled(tier: AgentTier, tierConfig: TierConfig, redundantAgents: boolean, parentId?: string): boolean {
  if (loopSupervisor) {
    const check = loopSupervisor.canSpawn(tier, parentId);
    if (!check.allowed) return false;
  }
  const pool = getModelPool(tierConfig, redundantAgents);
  if (pool.length <= 1) {
    const running = Array.from(agents.values()).filter(
      a => a.tier === tier && (a.status === "running" || a.status === "waiting")
    ).length;
    return running < tierConfig.maxParallel;
  }
  return selectAvailableModel(tier, pool, tierConfig.maxParallel) !== null;
}

/** Letter counters for generating sequential IDs per tier: a, b, c, d... */
const counters: Record<AgentTier, number> = { active: 0, t1: 0, t2: 0, t3: 0 };

/** Callback for dashboard updates */
let onStateChange: (() => void) | null = null;

/** Callback for streaming agent log updates */
let onAgentLog: ((agentId: string, entry: AgentLogEntry) => void) | null = null;

/** Interval for polling spawn requests */
let pollInterval: ReturnType<typeof setInterval> | null = null;

/** Extension context reference (set during init) */
let extCtx: ExtensionContext | null = null;

// ── Loop Supervisor ─────────────────────────────────────
let loopSupervisor: LoopSupervisor | null = null;

export function setLoopSupervisor(supervisor: LoopSupervisor): void {
  loopSupervisor = supervisor;
}

export function getLoopSupervisor(): LoopSupervisor | null {
  return loopSupervisor;
}

export function setStateChangeCallback(cb: () => void): void {
  onStateChange = cb;
}

export function setAgentLogCallback(cb: (agentId: string, entry: AgentLogEntry) => void): void {
  onAgentLog = cb;
}

export function setExtensionContext(ctx: ExtensionContext): void {
  extCtx = ctx;
}

function notifyStateChange(): void {
  if (onStateChange) onStateChange();
}

function notifyAgentLog(agentId: string, entry: AgentLogEntry): void {
  if (onAgentLog) onAgentLog(agentId, entry);
}

/**
 * Generate next agent ID in format: t1a, t1b, t2a, t2b, t3a, t3c...
 */
function nextId(tier: AgentTier): string {
  counters[tier]++;
  const letter = String.fromCharCode(96 + counters[tier]); // 97='a', 98='b', ...
  // "active" tier uses the t0 prefix for short IDs (t0a, t0b, ...)
  const prefix = tier === "active" ? "t0" : tier;
  return `${prefix}${letter}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * Spawn a new agent process. Returns IMMEDIATELY after spawning.
 * The agent runs in the background; output is streamed via notifyAgentLog.
 * Completion is signaled via instance.resolve callback.
 */
export function launchAgent(
  tier: AgentTier,
  task: string,
  config: TierConfig,
  cwd: string,
  parentId?: string,
  modelOverride?: string,
  redundantAgents: boolean = false,
): AgentInstance {
  const id = nextId(tier);
  const controller = new AbortController();

  const instance: AgentInstance = {
    id,
    tier,
    task,
    status: "running",
    startedAt: Date.now(),
    controller,
    output: "",
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    parentId,
    log: [],
  };

  // Ordered list of models to try: the primary model first, then redundant
  // fallbacks (only when the redundant-agents feature is ON).
  const primaryModel = modelOverride || config.model;
  const modelsToTry: string[] = [];
  if (primaryModel) modelsToTry.push(primaryModel);
  if (redundantAgents && config.redundantModels) {
    for (const m of config.redundantModels) {
      if (m && !modelsToTry.includes(m)) modelsToTry.push(m);
    }
  }
  let attemptIndex = 0;
  let responseTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let runtimeTimer: ReturnType<typeof setTimeout> | null = null;
  let gotFirstResponse = false;
  let lastProgressAt = Date.now();

  function clearAttemptWatchdogs(): void {
    if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    if (runtimeTimer) { clearTimeout(runtimeTimer); runtimeTimer = null; }
  }

  agents.set(id, instance);
  notifyStateChange();

  // Register with loop supervisor
  if (loopSupervisor) {
    loopSupervisor.registerSpawn(id, tier, parentId);
  }

  // Log agent start
  const startEntry: AgentLogEntry = {
    ts: Date.now(),
    level: "info",
    text: `Started: ${task.slice(0, 100)}`,
  };
  instance.log.push(startEntry);
  notifyAgentLog(id, startEntry);

  // Clean up stale IPC files periodically
  cleanupStaleFiles();

  // Spawn process in background — this IIFE runs asynchronously
  // so launchAgent returns the instance immediately
  (async () => {
    let promptFilePath: string | null = null;
    let promptDir: string | null = null;

    const cleanupPromptFiles = () => {
      if (promptFilePath) try { fs.unlinkSync(promptFilePath); } catch { /* ignore */ }
      if (promptDir) try { fs.rmdirSync(promptDir); } catch { /* ignore */ }
    };

    // Build result helper
    const buildResult = (): AgentResult => ({
      agentId: id,
      tier,
      task,
      status: instance.status,
      output: instance.output,
      stderr: instance.stderr,
      usage: instance.usage,
      model: instance.model,
      stopReason: instance.stopReason,
      log: instance.log,
    });

    /**
     * Decide whether the failed attempt qualifies for failover to the next
     * redundant model, and if so, start it. Keeps the SAME agent instance/ID
     * so IPC responses and tool result collection stay intact.
     *
     * Only fails over when the model did no real work (never produced output)
     * or the provider shows exhaustion (quota/rate-limit/overload). If the
     * model worked but the task itself failed, we don't waste retries.
     */
    function tryFailover(reason: string): boolean {
      if (!redundantAgents) return false;
      if (instance.status !== "error") return false;
      if (attemptIndex >= modelsToTry.length - 1) return false; // no more models to try

      const noWork = instance.usage.turns === 0 || instance.output.trim().length === 0;
      const exhausted = PROVIDER_EXHAUSTION_PATTERN.test(instance.stderr);
      if (!noWork && !exhausted) return false;

      clearAttemptWatchdogs();
      const nextModel = modelsToTry[++attemptIndex];
      const failoverEntry: AgentLogEntry = {
        ts: Date.now(),
        level: "info",
        text: `↻ ${reason} — failing over to redundant model ${nextModel} (attempt ${attemptIndex + 1}/${modelsToTry.length})`,
      };
      instance.log.push(failoverEntry);
      notifyAgentLog(id, failoverEntry);

      // Reset per-attempt state (keep accumulated log/usage for visibility)
      instance.status = "running";
      instance.stopReason = undefined;
      instance.finishedAt = undefined;
      instance.stderr = "";
      instance.proc = undefined;
      gotFirstResponse = false;
      lastProgressAt = Date.now();
      notifyStateChange();

      startAttempt(nextModel);
      return true;
    }

    function startAttempt(model: string): void {
      const attemptArgs: string[] = ["--mode", "json", "-p", "--no-session"];
      if (model) attemptArgs.push("--model", model);
      if (config.tools.length > 0) attemptArgs.push("--tools", config.tools.join(","));
      attemptArgs.push(...config.extraArgs);

      // Attach the sub-agent extension for auto-spawning tool
      const subExtPath = getSubagentExtensionPath();
      if (fs.existsSync(subExtPath)) attemptArgs.push("--extension", subExtPath);

      attemptArgs.push("--append-system-prompt", promptFilePath!);
      attemptArgs.push(`Task: ${task}`);

      instance.requestedModel = model || undefined;

      const invocation = getPiInvocation(attemptArgs);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // Pass per-instance directory to sub-agents for IPC/locks/context isolation
          TRIMEGISTO_INSTANCE_DIR: instanceDir || path.join(getAgentDir(), "trimegisto"),
          // Tell the sub-agent extension its own ID for lock/context tracking
          TRIMEGISTO_AGENT_ID: id,
        },
      });

      instance.proc = proc;
      notifyStateChange();

      let partialAssistantText = "";

      const terminateForWatchdog = (stopReason: string, message: string) => {
        if (instance.status !== "running") return;
        const timeoutEntry: AgentLogEntry = {
          ts: Date.now(),
          level: "error",
          text: message,
        };
        instance.log.push(timeoutEntry);
        notifyAgentLog(id, timeoutEntry);
        if (partialAssistantText.trim()) {
          const partial = partialAssistantText.trim();
          instance.output += partial + "\n";
          const partialEntry: AgentLogEntry = {
            ts: Date.now(),
            level: "output",
            text: `[partial before timeout]\n${partial}`,
          };
          instance.log.push(partialEntry);
          notifyAgentLog(id, partialEntry);
          partialAssistantText = "";
        }
        instance.stderr += `\n${message}`;
        instance.status = "error";
        instance.stopReason = stopReason;
        clearAttemptWatchdogs();
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
      };

      const markProgress = () => {
        lastProgressAt = Date.now();
      };

      // First-response watchdog: always armed. With redundant agents ON the
      // close handler may fail over; otherwise this resolves the worker quickly
      // instead of leaving the main session waiting forever.
      gotFirstResponse = false;
      lastProgressAt = Date.now();
      responseTimer = setTimeout(() => {
        if (!gotFirstResponse && instance.status === "running") {
          terminateForWatchdog(
            "first_response_timeout",
            `⏱ No first response from ${model || "default model"} within ${Math.round(FIRST_RESPONSE_TIMEOUT_MS / 1000)}s`,
          );
        }
      }, FIRST_RESPONSE_TIMEOUT_MS);

      idleTimer = setInterval(() => {
        if (instance.status !== "running") return;
        const idleMs = Date.now() - lastProgressAt;
        if (idleMs >= AGENT_IDLE_TIMEOUT_MS) {
          terminateForWatchdog(
            "idle_timeout",
            `⏱ No agent progress for ${Math.round(idleMs / 1000)}s (idle timeout ${Math.round(AGENT_IDLE_TIMEOUT_MS / 1000)}s)`,
          );
        }
      }, Math.min(15_000, Math.max(1_000, Math.floor(AGENT_IDLE_TIMEOUT_MS / 3))));

      runtimeTimer = setTimeout(() => {
        terminateForWatchdog(
          "max_runtime_timeout",
          `⏱ Agent exceeded max runtime ${Math.round(AGENT_MAX_RUNTIME_MS / 1000)}s`,
        );
      }, AGENT_MAX_RUNTIME_MS);

      let buffer = "";

      let thinkingLogged = false; // one "thinking" entry per attempt, no log scan per token

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        markProgress();

        // Track output from assistant messages
        if (event.type === "message_end" && event.message?.role === "assistant") {
          // First assistant message arrived — disarm the unresponsive watchdog
          if (!gotFirstResponse) {
            gotFirstResponse = true;
            if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
          }

          const msg = event.message;
          partialAssistantText = "";
          instance.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            // Authoritative prefill/decode throughput for the request that just finished.
            speed.endRequest(id, {
              input: usage.input || 0,
              cacheRead: usage.cacheRead || 0,
              cacheWrite: usage.cacheWrite || 0,
              output: usage.output || 0,
            });
            instance.usage.input += usage.input || 0;
            instance.usage.output += usage.output || 0;
            instance.usage.cacheRead += usage.cacheRead || 0;
            instance.usage.cacheWrite += usage.cacheWrite || 0;
            instance.usage.cost += usage.cost?.total || 0;
            instance.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!instance.model && msg.model) instance.model = msg.model;
          if (msg.stopReason) instance.stopReason = msg.stopReason;

          // ── Loop Supervisor: turn limit check ──────────
          // checkTurnLimit returns true ONLY when the HARD limit is exceeded.
          // Soft limit violations generate a warning alert but don't kill.
          if (loopSupervisor && loopSupervisor.checkTurnLimit(id, tier, instance.usage.turns)) {
            const limitEntry: AgentLogEntry = {
              ts: Date.now(),
              level: "error",
              text: `⛔ Hard turn limit exceeded (${instance.usage.turns} turns). Killing agent to prevent runaway loop.`,
            };
            instance.log.push(limitEntry);
            notifyAgentLog(id, limitEntry);
            // Kill via abort controller
            controller.abort();
          }

          // Extract text content and log it (verbatim, no truncation)
          for (const part of msg.content) {
            if (part.type === "text" && part.text) {
              instance.output += part.text + "\n";
              const logEntry: AgentLogEntry = {
                ts: Date.now(),
                level: "output",
                text: part.text,
              };
              instance.log.push(logEntry);
              notifyAgentLog(id, logEntry);
            }
          }

          notifyStateChange();
        }

        // Tool use events — show full details verbosely
        if (event.type === "tool_use_start" && event.tool) {
          let toolDesc = `🔧 ${event.tool.name}`;
          if (event.tool.input) {
            const input = event.tool.input;
            if (input.path) toolDesc += ` ${input.path}`;
            else if (input.command) toolDesc += ` ${input.command}`;
            else if (input.file_path) toolDesc += ` ${input.file_path}`;
            else toolDesc += ` ${JSON.stringify(input)}`;
          }
          const toolEntry: AgentLogEntry = {
            ts: Date.now(),
            level: "tool",
            text: toolDesc,
          };
          instance.log.push(toolEntry);
          notifyAgentLog(id, toolEntry);
        }

        // Tool result messages — show actual tool output verbosely
        if (event.type === "tool_result_end" && event.message) {
          let resultText = "";
          for (const part of event.message.content) {
            if (part.type === "text" && part.text) {
              resultText += part.text;
            }
          }
          const resultEntry: AgentLogEntry = {
            ts: Date.now(),
            level: "tool",
            text: resultText ? `  → ${resultText}` : "✓ done",
          };
          instance.log.push(resultEntry);
          notifyAgentLog(id, resultEntry);
        }

        // ── Speed telemetry ──────────────────────────────────────────
        // turn_start = a provider request begins: prefill phase starts here.
        if (event.type === "turn_start") {
          speed.startRequest(id);
        }

        // Message updates: streaming deltas. pi's JSON stream carries only
        // `usage` + `assistantMessageEvent` here — there is no `message` field,
        // so nothing may be gated on the message role in this branch.
        if (event.type === "message_update") {
          // Every streamed delta feeds the live decode estimate.
          const ev = event.assistantMessageEvent;
          if (ev && (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta")) {
            if (!gotFirstResponse) {
              gotFirstResponse = true;
              if (responseTimer) { clearTimeout(responseTimer); responseTimer = null; }
            }
            markProgress();
            if (ev.type === "text_delta" && typeof ev.delta === "string") partialAssistantText += ev.delta;
            speed.noteDelta(id, typeof ev.delta === "string" ? ev.delta.length : 0);
          }
          // Incremental usage, when the provider reports it, beats estimating.
          if (event.usage?.output) speed.noteLiveUsage(id, event.usage.output);
          if (!thinkingLogged) {
            thinkingLogged = true;
            const thinkingEntry: AgentLogEntry = {
              ts: Date.now(),
              level: "info",
              text: "💭 thinking...",
            };
            instance.log.push(thinkingEntry);
            notifyAgentLog(id, thinkingEntry);
          }
        }
      };

      proc.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
        notifyStateChange();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        markProgress();
        instance.stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearAttemptWatchdogs();

        // Process remaining buffer
        if (buffer.trim()) processLine(buffer);
        if (partialAssistantText.trim()) {
          const partial = partialAssistantText.trim();
          instance.output += partial + "\n";
          const partialEntry: AgentLogEntry = {
            ts: Date.now(),
            level: "output",
            text: `[partial before process exit]\n${partial}`,
          };
          instance.log.push(partialEntry);
          notifyAgentLog(id, partialEntry);
          partialAssistantText = "";
        }

        const exitCode = code ?? 0;
        if (exitCode !== 0 && instance.status === "running") {
          instance.status = "error";
          if (!instance.stopReason) instance.stopReason = `exit:${exitCode}`;
        } else if (instance.status === "running") {
          instance.status = "done";
        }

        // ── Redundant failover: retry on the next model ──
        if (instance.status === "error" && tryFailover(`Model ${model || "default"} failed`)) {
          return;
        }

        instance.finishedAt = Date.now();
        instance.proc = undefined;

        // Log finish
        const finishEntry: AgentLogEntry = {
          ts: Date.now(),
          level: instance.status === "done" ? "info" : "error",
          text: instance.status === "done"
            ? `✓ Completed (${instance.usage.turns} turns, ${instance.usage.output} tokens out)`
            : `✗ Failed: ${instance.stopReason || "unknown"}`,
        };
        instance.log.push(finishEntry);
        notifyAgentLog(id, finishEntry);

        // Clean up temp files
        cleanupPromptFiles();

        // Release file locks held by this agent
        releaseAllAgentLocks(id);
        // Clean up context tracking data
        clearAgentContext(id);
        // Freeze speed telemetry: keep last measured values, drop live phases
        speed.finalize(id);

        notifyStateChange();

        // ── Loop Supervisor: process result ──────────────
        if (loopSupervisor && instance.status !== "killed") {
          const loopResult = loopSupervisor.processResult(buildResult());
          if (loopResult.loopDetected) {
            const loopEntry: AgentLogEntry = {
              ts: Date.now(),
              level: "error",
              text: `⚠️ Loop detected (strike ${loopResult.strike}/3): ${instance.status === "error" ? "error pattern" : "output"} repeated`,
            };
            instance.log.push(loopEntry);
            notifyAgentLog(id, loopEntry);
          }
        }

        // Signal completion via resolve callback
        instance.resolve?.(buildResult());
      });

      proc.on("error", (err) => {
        clearAttemptWatchdogs();

        instance.status = "error";
        instance.stderr += err.message;
        instance.stopReason = "spawn_error";
        instance.finishedAt = Date.now();
        instance.proc = undefined;

        const errEntry: AgentLogEntry = {
          ts: Date.now(),
          level: "error",
          text: `Spawn error: ${err.message}`,
        };
        instance.log.push(errEntry);
        notifyAgentLog(id, errEntry);

        // ── Redundant failover: the process never started ──
        if (tryFailover(`Could not start ${model || "default model"}`)) {
          return;
        }

        cleanupPromptFiles();

        // Release file locks held by this agent
        releaseAllAgentLocks(id);
        // Clean up context tracking data
        clearAgentContext(id);
        speed.finalize(id);

        notifyStateChange();
        instance.resolve?.(buildResult());
      });
    }

    // Handle abort — kills whichever process is currently running for this agent
    const killCurrentProc = () => {
      clearAttemptWatchdogs();
      if (instance.status === "running") {
        instance.status = "killed";
        instance.stopReason = "killed";
        instance.finishedAt = Date.now();

        const killEntry: AgentLogEntry = {
          ts: Date.now(),
          level: "error",
          text: "⊘ Killed",
        };
        instance.log.push(killEntry);
        notifyAgentLog(id, killEntry);
      }
      const p = instance.proc;
      if (p) {
        p.kill("SIGTERM");
        setTimeout(() => {
          if (!p.killed) p.kill("SIGKILL");
        }, 5000);
      }
    };

    if (controller.signal.aborted) {
      // Defer until the first attempt has spawned its process
      const earlyKill = setInterval(() => {
        if (instance.proc || instance.status !== "running") {
          clearInterval(earlyKill);
          killCurrentProc();
        }
      }, 50);
    } else {
      controller.signal.addEventListener("abort", killCurrentProc, { once: true });
    }

    try {
      // Write the system prompt to a temp file
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "trimegisto-"));
      promptDir = tmpDir;
      promptFilePath = path.join(tmpDir, `system-prompt-${id}.md`);
      await fs.promises.writeFile(promptFilePath, config.systemPrompt, { encoding: "utf-8", mode: 0o600 });

      // Launch the first attempt on the primary model
      startAttempt(modelsToTry[0] || "");
    } catch (err: any) {
      instance.status = "error";
      instance.stderr = err?.message || String(err);
      instance.stopReason = "launch_error";
      instance.finishedAt = Date.now();

      const errEntry: AgentLogEntry = {
        ts: Date.now(),
        level: "error",
        text: `Launch error: ${err?.message || String(err)}`,
      };
      instance.log.push(errEntry);
      notifyAgentLog(id, errEntry);

      cleanupPromptFiles();
      notifyStateChange();
      instance.resolve?.(buildResult());
    }
  })();

  return instance;
}

/**
 * Stop a specific agent.
 */
export function killAgent(id: string): boolean {
  const agent = agents.get(id);
  if (!agent) return false;

  if (agent.status === "running" || agent.status === "waiting") {
    // Release all file locks held by this agent before killing
    releaseAllAgentLocks(id);
    clearAgentContext(id);

    agent.controller.abort();
    agent.status = "killed";
    agent.stopReason = "killed";
    agent.finishedAt = Date.now();
    if (agent.proc) {
      agent.proc.kill("SIGTERM");
      setTimeout(() => {
        if (agent.proc && !agent.proc.killed) agent.proc.kill("SIGKILL");
      }, 5000);
    }
    notifyStateChange();
    return true;
  }

  return false;
}

/**
 * Halt all agents (kill all running/waiting).
 */
export function haltAll(): number {
  let killed = 0;
  for (const [id, agent] of agents) {
    if (agent.status === "running" || agent.status === "waiting") {
      agent.controller.abort();
      agent.status = "killed";
      agent.stopReason = "halted";
      agent.finishedAt = Date.now();
      if (agent.proc) {
        agent.proc.kill("SIGTERM");
        setTimeout(() => {
          if (agent.proc && !agent.proc.killed) agent.proc.kill("SIGKILL");
        }, 5000);
      }
      releaseAllAgentLocks(id);
      clearAgentContext(id);
      killed++;
    }
  }
  notifyStateChange();
  return killed;
}

/**
 * Get all agents.
 */
export function getAgents(): Map<string, AgentInstance> {
  return agents;
}

/**
 * Get an agent by ID.
 */
export function getAgent(id: string): AgentInstance | undefined {
  return agents.get(id);
}

/**
 * Get agent counts by tier and status.
 */
export interface AgentCounts {
  active: { total: number; running: number; waiting: number; done: number; error: number; killed: number };
  t1: { total: number; running: number; waiting: number; done: number; error: number; killed: number };
  t2: { total: number; running: number; waiting: number; done: number; error: number; killed: number };
  t3: { total: number; running: number; waiting: number; done: number; error: number; killed: number };
}

export function getAgentCounts(): AgentCounts {
  const zero = () => ({ total: 0, running: 0, waiting: 0, done: 0, error: 0, killed: 0 });
  const counts: AgentCounts = { active: zero(), t1: zero(), t2: zero(), t3: zero() };

  for (const agent of agents.values()) {
    const c = counts[agent.tier];
    c.total++;
    switch (agent.status) {
      case "running": c.running++; break;
      case "waiting": c.waiting++; break;
      case "done": c.done++; break;
      case "error": c.error++; break;
      case "killed": c.killed++; break;
    }
  }

  return counts;
}

/**
 * Get agents that are currently active (running or waiting).
 */
export function getActiveAgents(): AgentInstance[] {
  return Array.from(agents.values()).filter(
    a => a.status === "running" || a.status === "waiting"
  );
}

/**
 * Check if a tier can spawn more agents.
 */
export function canSpawn(tier: AgentTier, maxParallel: number, parentId?: string): boolean {
  // Check loop supervisor spawn limits first
  if (loopSupervisor) {
    const check = loopSupervisor.canSpawn(tier, parentId);
    if (!check.allowed) return false;
  }

  const running = Array.from(agents.values()).filter(
    a => a.tier === tier && (a.status === "running" || a.status === "waiting")
  ).length;
  return running < maxParallel;
}

/**
 * Notify the context broker that an agent modified a file.
 * Called when agents use write/edit/bash tools on files.
 */
export function notifyFileChange(
  agentId: string,
  filePath: string,
  operation: "write" | "edit" | "bash",
  summary?: string,
): void {
  broadcastFileChange(filePath, agentId, operation, summary);
}

/**
 * Process pending auto-spawn requests from sub-agents.
 * Returns the number of requests processed.
 * launchAgent now returns immediately, so we set the resolve callback
 * to write the IPC response when the agent completes.
 */
export function processSpawnRequests(
  configs: Record<AgentTier, TierConfig>,
  cwd: string,
  modelOverride?: string,
  spawnOnlyOnActive: boolean = false,
  redundantAgents: boolean = false,
): number {
  const requests = scanSpawnRequests();
  let processed = 0;

  for (const request of requests) {
    // Spawn-only-on-active: force every sub-agent spawn request onto the active tier (t0)
    if (spawnOnlyOnActive && request.tier !== "active") {
      request.tier = "active";
    }
    const tier = request.tier;
    const tc = configs[tier];

    // Tier disabled or missing a model -> fail fast with a clear message
    if (!tc || tc.enabled === false || (tier !== "active" && !tc.model)) {
      writeSpawnResponse({
        requestId: request.requestId,
        result: {
          agentId: request.requestId,
          tier,
          task: request.task,
          status: "error",
          output: "",
          stderr: `Tier ${formatTierLabel(tier)} is not available (${tc?.enabled === false ? "disabled" : "no model configured"}). The coordinator should only spawn enabled tiers.`,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          log: [],
        },
      });
      processed++;
      continue;
    }

    if (!canSpawnPooled(tier, tc, redundantAgents, request.parentId)) {
      const running = Array.from(agents.values()).filter(
        a => a.tier === tier && (a.status === "running" || a.status === "waiting")
      ).length;
      const poolSize = getModelPool(tc, redundantAgents).length;
      const capacity = tc.maxParallel * poolSize;
      // Write error response
      writeSpawnResponse({
        requestId: request.requestId,
        result: {
          agentId: request.requestId,
          tier,
          task: request.task,
          status: "error",
          output: "",
          stderr: `Cannot spawn ${formatTierLabel(tier)}: max parallel limit reached (${running}/${capacity} agents active across ${poolSize} model(s)). Wait for running agents to complete, or increase the limit via /tmg-config.`,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          log: [],
        },
      });
      processed++;
      continue;
    }

    try {
      // Model selection:
      // - "active" tier: the pi active model
      // - t1/t2/t3 with redundant agents ON: least-loaded model in the pool
      // - otherwise: the tier's configured model (no override)
      let tierModelOverride: string | undefined;
      if (tier === "active") {
        tierModelOverride = modelOverride;
      } else if (redundantAgents) {
        const pool = getModelPool(tc, true);
        tierModelOverride = selectAvailableModel(tier, pool, tc.maxParallel) ?? undefined;
      }
      const agent = launchAgent(
        tier,
        request.task,
        tc,
        request.cwd || cwd,
        request.parentId,
        tierModelOverride,
        redundantAgents,
      );

      // Set resolve callback to write IPC response when agent completes
      agent.resolve = (result) => {
        writeSpawnResponse({
          requestId: request.requestId,
          result,
        });
      };

      // If already done/errored, write response immediately
      if (agent.status === "done" || agent.status === "error" || agent.status === "killed") {
        writeSpawnResponse({
          requestId: request.requestId,
          result: {
            agentId: agent.id,
            tier: agent.tier,
            task: agent.task,
            status: agent.status,
            output: agent.output,
            stderr: agent.stderr,
            usage: agent.usage,
            model: agent.model,
            stopReason: agent.stopReason,
            log: agent.log,
          },
        });
      }
    } catch (err: any) {
      writeSpawnResponse({
        requestId: request.requestId,
        result: {
          agentId: request.requestId,
          tier,
          task: request.task,
          status: "error",
          output: "",
          stderr: err?.message || String(err),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
          log: [],
        },
      });
    }

    processed++;
  }

  return processed;
}

/**
 * Start polling for auto-spawn requests.
 */
export function startAutoSpawnPolling(
  configs: Record<AgentTier, TierConfig>,
  cwd: string,
  modelOverride?: string,
  intervalMs: number = 500,
  spawnOnlyOnActive: boolean = false,
  redundantAgents: boolean = false,
): void {
  if (pollInterval) return;

  pollInterval = setInterval(() => {
    try {
      processSpawnRequests(configs, cwd, modelOverride, spawnOnlyOnActive, redundantAgents);
    } catch {
      // Silently ignore errors in polling
    }
  }, intervalMs);
}

/**
 * Stop auto-spawn polling.
 */
export function stopAutoSpawnPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Send a follow-up instruction to a running agent.
 * KILLS the existing agent process and spawns a NEW agent with the
 * combined context (old task + new instruction). The old agent cannot
 * receive new input mid-execution since it runs as a separate pi process.
 * Returns immediately — the new agent runs in the background.
 */
export function sendToAgent(
  agentId: string,
  instruction: string,
  configs: Record<AgentTier, TierConfig>,
  cwd: string,
  modelOverride?: string,
  spawnOnlyOnActive: boolean = false,
  redundantAgents: boolean = false,
): AgentInstance | null {
  const existing = agents.get(agentId);
  if (!existing) return null;

  // Spawn-only-on-active: respawn on the active tier (t0) instead of the original tier
  const tier = spawnOnlyOnActive ? "active" : existing.tier;

  // Kill the existing agent process if still running
  if (existing.status === "running" || existing.status === "waiting") {
    existing.controller.abort();
    existing.status = "killed";
    existing.stopReason = "replaced";
    existing.finishedAt = Date.now();
    if (existing.proc) {
      existing.proc.kill("SIGTERM");
      setTimeout(() => {
        if (existing.proc && !existing.proc.killed) existing.proc.kill("SIGKILL");
      }, 5000);
    }
    notifyStateChange();

    const killEntry: AgentLogEntry = {
      ts: Date.now(),
      level: "info",
      text: `⊘ Replaced by follow-up instruction`,
    };
    existing.log.push(killEntry);
    notifyAgentLog(agentId, killEntry);
  }

  // Build combined task with previous context
  let task = `[Follow-up to ${agentId}'s previous task]
Previous context: ${existing.task.slice(0, 200)}

New instruction: ${instruction}`;

  // ── Loop Supervisor: inject context shock if needed ────
  if (loopSupervisor) {
    const shock = loopSupervisor.getContextShockForRespawn(tier);
    if (shock) {
      task = `${shock.shockMessage}

---

${task}`;
    }
  }

  const tierModelOverride = tier === "active" ? modelOverride : undefined;
  return launchAgent(tier, task, configs[tier], cwd, agentId, tierModelOverride, redundantAgents);
}

/**
 * Format duration from milliseconds to human readable.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

/**
 * Format agent status for display.
 */
export function formatAgentStatus(agent: AgentInstance): string {
  const label = formatTierLabel(agent.tier);
  const duration = formatDuration(
    (agent.finishedAt || Date.now()) - agent.startedAt
  );

  let statusIcon: string;
  switch (agent.status) {
    case "running": statusIcon = "◌"; break;
    case "waiting": statusIcon = "◷"; break;
    case "done": statusIcon = "✓"; break;
    case "error": statusIcon = "✗"; break;
    case "killed": statusIcon = "⊘"; break;
    default: statusIcon = "·";
  }

  const modelStr = agent.model ? ` [${agent.model.split("/").pop()}]` : "";
  const taskPreview = agent.task.length > 40
    ? agent.task.slice(0, 40) + "..."
    : agent.task;

  return `${statusIcon} ${label} ${agent.id}${modelStr} ${duration} — ${taskPreview}`;
}
