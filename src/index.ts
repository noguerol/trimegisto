/** Trimegisto: tiered parallel sub-agents for pi. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTier, TrimegistoConfig, AgentLogEntry, AgentInstance } from "./types.ts";
import {
  buildTierConfig,
  getDefaultConfig,
  formatTierLabel,
  clampWatchdogSeconds,
  WATCHDOG_DEFAULTS,
  migrateSavedCompaction,
  effectiveCompactionThreshold,
  sanitizeLoopSupervisorConfig,
  applyGuardConfig,
  foldDedupeFlagIntoGuard,
} from "./config.ts";
import {
  launchAgent,
  haltAll,
  isHalted,
  getAgent,
  getAgentCounts,
  getActiveAgents,
  getAgents,
  canSpawnPooled,
  getModelPool,
  selectAvailableModel,
  stopAutoSpawnPolling,
  setStateChangeCallback,
  setSubagentExtensionPath,
  setInstanceDir,
  setAgentLogCallback,
  processSpawnRequests,
  sendToAgent,
  setLoopSupervisor,
  setWatchdogTimeouts,
  setModelHealth,
  getTierModelBlock,
  formatModelBlockMessage,
} from "./agent-manager.ts";
import { isDuplicateTask, registerTask, forgetTask } from "./task-dedup.ts";
import { saveConfig as persistConfig, loadConfig } from "./persistence.ts";
import { cleanupOldNotifications } from "./context-broker.ts";
import { reconcileBatch, decideBatchSettle, distillConclusion } from "./reconcile.ts";
import { planBatch, type PlanNode, type PlanTaskInput } from "./plan-graph.ts";
import { advanceWaves } from "./wave-scheduler.ts";
import { ProviderDiagnostics, diagnosticsEnabledFromEnv } from "./diagnostics.ts";
import { pruneContextMessages, MAX_PROGRESS_MESSAGES } from "./context-prune.ts";
import { LoopSupervisor, type LoopAlert } from "./loop-supervisor.ts";
import { ModelHealth, sanitizeModelHealthConfig, MODEL_HEALTH_DEFAULTS } from "./model-health.ts";
import { speed, MAIN_TARGET } from "./speed.ts";
import { formatTmgStatus } from "./branding.ts";

// ── Configuration entry type ────────────────────────────
const CONFIG_ENTRY = "trimegisto-config-v1";

// ── Instance isolation ──────────────────────────────────
/** Unique ID for this pi instance, used to isolate IPC/locks/context from other concurrent pi processes */
let instanceId: string | null = null;

function getInstanceDir(): string {
  return path.join(getAgentDir(), "trimegisto", "instances", instanceId!);
}

function generateInstanceId(): string {
  return `pid-${process.pid}-${Date.now()}`;
}

/** Clean up orphaned instance directories from previous runs that are no longer alive */
function cleanupOrphanedInstances(): void {
  const instancesDir = path.join(getAgentDir(), "trimegisto", "instances");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(instancesDir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pidMatch = entry.name.match(/^pid-(\d+)-/);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1], 10);
    if (isNaN(pid)) continue;
    try {
      process.kill(pid, 0);
    } catch {
      try { fs.rmSync(path.join(instancesDir, entry.name), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ── Determine the subagent extension path ─────────────────
function findSubagentExtensionPath(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(thisDir, "subagent-extension.ts");
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* runtime may not support import.meta.url */ }

  const agentDir = getAgentDir();
  return path.join(agentDir, "extensions", "trimegisto", "subagent-extension.ts");
}

// ── The Trimegisto tool (exposed to the main LLM) ────────
const TierEnum = StringEnum(["active", "t1", "t2", "t3"] as const, {
  description: "Tier. Default active. Use only enabled tiers.",
});

const LaneEnum = StringEnum(["open", "gated", "closed"] as const, {
  description: "Blast-radius lane. 'closed' = irreversible/high-consequence (deploy, migrate, drop, force-push, credentials) and is REFUSED: ask the user to decide instead. 'gated' = wide but reversible (shared utils, schema, public API, config). 'open' = contained/reversible (default).",
});

const TrimegistoTaskItem = Type.Object({
  tier: Type.Optional(TierEnum),
  task: Type.String({ description: "Agent task (one bounded unit of work, one input in, one output out)." }),
  cwd: Type.Optional(Type.String({ description: "Agent cwd" })),
  needs: Type.Optional(Type.Array(Type.Number(), {
    description: "1-based indices of OTHER tasks in THIS same call whose output this task consumes. Declare an edge only if this task genuinely reads their result; two tasks with no edge run in parallel. Example: needs: [1,2].",
  })),
  why: Type.Optional(Type.String({
    description: "One line: which part of the overall goal this task serves. Required in practice — a task that cannot name its need should not be spawned.",
  })),
  writes: Type.Optional(Type.Array(Type.String(), {
    description: "Files this task will write. Two tasks writing the same file are serialised automatically instead of racing.",
  })),
  lane: Type.Optional(LaneEnum),
});

export default function (pi: ExtensionAPI) {
  // ── Mutable state ──────────────────────────────────────
  let config: TrimegistoConfig = getDefaultConfig();
  let dashboardVisible = true;
  let dashboardMode: "widget" | "compact" | "off" = "compact";
  let ctxRef: ExtensionContext | null = null;
  let disposed = false;

  /**
   * Push watchdog timeouts (stored in seconds) into the agent manager.
   * 0 disables that watchdog; maxRuntime defaults to 0 (disabled), so agents
   * that keep making progress are never killed on a wall-clock cap alone.
   */
  function applyWatchdogConfig(): void {
    setWatchdogTimeouts({
      firstResponseMs: clampWatchdogSeconds(config.watchdog?.firstResponseSeconds, WATCHDOG_DEFAULTS.firstResponseSeconds) * 1000,
      idleMs: clampWatchdogSeconds(config.watchdog?.idleSeconds, WATCHDOG_DEFAULTS.idleSeconds) * 1000,
      maxRuntimeMs: clampWatchdogSeconds(config.watchdog?.maxRuntimeSeconds, WATCHDOG_DEFAULTS.maxRuntimeSeconds) * 1000,
    });
  }
  applyWatchdogConfig();

  /**
   * Timers and child-process callbacks can fire after /reload has replaced the
   * extension context. pi correctly rejects calls through that stale API; never
   * let those late callbacks crash the host process.
   */
  function safeSendMessage(message: any, options?: any): void {
    if (disposed) return;
    try {
      pi.sendMessage(message, options);
    } catch {
      // Stale pi context after /reload/session replacement; ignore late log.
    }
  }

  /**
   * TUI-only extension entry. Unlike pi.sendMessage(), custom entries do NOT
   * participate in LLM context, so live agent progress can stream into the
   * transcript without flooding the main model's conversation (which is what
   * makes the coordinator's requests fail with provider 400s). The single
   * reconciliation message is the only Trimegisto output that reaches the model.
   */
  function safeAppendEntry(customType: string, data: unknown): void {
    if (disposed) return;
    try {
      pi.appendEntry(customType, data);
    } catch {
      // Stale pi context after /reload/session replacement; ignore late entry.
    }
  }

  // ── Guaranteed reconciliation: session-wide batch registry ───────────────
  // Every trimegisto batch registers here. A batch settles EXACTLY ONCE and
  // always emits one deterministic conclusion, however the agents end:
  // resolved, killed, watchdog-terminated, or past the hard deadline. This is
  // what makes Trimegisto always reconcile instead of leaving fragments around.
  interface PendingBatch {
    id: string;
    startedAt: number;
    deadlineAt: number;
    agentIds: string[];
    skipped: { task: string; tier: string; matchedTask: string; matchedTier?: string }[];
    results: Map<string, any>;
    settled: boolean;
    // ── plan-graph state (dependency-aware waves) ──
    /** Overall objective the batch must advance (from the coordinator). */
    goal?: string;
    cwd: string;
    /** Launched waves, each a list of plan nodes that run in parallel. */
    waves: PlanNode[][];
    /** Index of the wave currently in flight; -1 before the first one. */
    currentWave: number;
    /** Agent ids belonging to the CURRENT wave (terminality is per wave). */
    waveAgentIds: string[];
    /** plan index (1-based) -> normalised task spec {tier, task, cwd}. */
    taskByIndex: Map<number, any>;
    /** plan index -> agent id actually launched for it. */
    nodeAgent: Map<number, string>;
    /** plan indexes that were launched at least once. */
    launched: Set<number>;
    taskDetails: any[];
    /** Deterministic plan-gate summary, echoed to the coordinator. */
    planSummary: string;
  }
  const pendingBatches: PendingBatch[] = [];
  let batchSeq = 0;
  /** Max chars of an upstream verdict carried across a dependency edge. */
  const UPSTREAM_VERDICT_CHARS = 700;
  const BATCH_DEADLINE_MS = (() => {
    const raw = Number(process.env.TRIMEGISTO_BATCH_DEADLINE_MS);
    return Number.isFinite(raw) && raw > 0 ? Math.max(60_000, raw) : 30 * 60_000;
  })();

  /** Normalize an AgentResult or an AgentInstance into the reconciler shape. */
  function toRecon(a: any): any {
    return {
      agentId: a.agentId ?? a.id ?? "?",
      tier: a.tier ?? "?",
      task: a.task ?? "",
      status: a.status ?? "killed",
      output: a.output ?? "",
      finalOutput: a.finalOutput ?? "",
      stderr: a.stderr ?? "",
      stopReason: a.stopReason,
      usage: a.usage,
    };
  }

  /**
   * Settle a batch: build the deterministic reconciliation from whatever is
   * known (captured results, live agent state, or an explicit "never reported"
   * placeholder) and deliver it as ONE message. Must be idempotent.
   */
  function settleBatch(batch: PendingBatch, reason: string): void {
    if (batch.settled) return;
    batch.settled = true;
    try {

    const results = batch.agentIds.map((id) => {
      const captured = batch.results.get(id);
      if (captured) return toRecon(captured);
      const live = getAgent(id);
      if (live) return toRecon(live);
      return {
        agentId: id,
        tier: "?",
        task: "",
        status: "killed",
        output: "",
        finalOutput: "",
        stderr: `agent ${id} never reported a result`,
        stopReason: "no_result",
        usage: { turns: 0, input: 0, output: 0, cost: 0 },
      };
    });

    // Nodes the scheduler never got to launch (deadline, halt, capacity) must
    // appear in the conclusion as incomplete instead of vanishing silently.
    for (const wave of batch.waves) {
      for (const node of wave) {
        if (batch.launched.has(node.index)) continue;
        const spec = batch.taskByIndex.get(node.index);
        results.push({
          agentId: `#${node.index}`,
          tier: spec?.tier ?? "?",
          task: spec?.task ?? node.task,
          status: "error",
          output: "",
          finalOutput: "",
          stderr: "not launched (the batch stopped before this wave)",
          stopReason: "not_launched",
          usage: { turns: 0, input: 0, output: 0, cost: 0 },
        });
      }
    }

    let markdown: string;
    let headline: string;
    try {
      const out = reconcileBatch(results, {
        batchId: batch.id.replace(/^batch-/, ""),
        startedAt: batch.startedAt,
        now: Date.now(),
        skipped: batch.skipped,
      });
      markdown = out.markdown;
      headline = out.headline;
    } catch (err: any) {
      // The reconciliation itself must never be why the user gets no answer.
      const done = results.filter((r: any) => r.status === "done").length;
      headline = `${done}/${results.length} done (fallback reconciliation)`;
      const lines: string[] = [
        "## 🪡 Trimegisto — final reconciliation (fallback)",
        "",
        `Batch \`${batch.id}\` settled (${reason}) but the reconciler failed: ${err?.message || String(err)}`,
        "",
      ];
      for (const r of results) {
        lines.push(`- **${r.agentId}** [${r.tier}] — ${r.status}: ${(r.task || "").slice(0, 120)}`);
      }
      lines.push("", `**Trimegisto conclusion:** ${done}/${results.length} agents completed.`);
      markdown = lines.join("\n");
    }

    // The message is rendered the instant it is sent, so the user always gets
    // the conclusion even if the main model's next request fails. followUp +
    // triggerTurn asks for exactly ONE reconciling turn without interrupting
    // work that is still in flight.
    safeSendMessage(
      {
        customType: "trimegisto-results",
        content: markdown,
        display: true,
        details: { batchId: batch.id, reason },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    try { ctxRef?.ui?.notify(`Trimegisto: ${headline}`, "info"); } catch { /* no UI */ }
    } finally {
      // A batch marked settled must never stay in the registry: an unexpected
      // throw above would otherwise leak it AND suppress its conclusion forever
      // (the deadline rescue skips batches that are already `settled`).
      const idx = pendingBatches.indexOf(batch);
      if (idx >= 0) pendingBatches.splice(idx, 1);
    }
  }

  // ── Dependency-aware wave scheduler ───────────────────────────────────────
  // The plan gate decides WHICH nodes exist and their order; this decides WHEN
  // each one runs. A wave is launched only when the previous wave is terminal,
  // so a declared edge really carries data (the upstream verdict is prepended
  // to the dependent task) instead of being cosmetic.
  function tierCapacity(tier: AgentTier): number {
    return config[tier].maxParallel * Math.max(1, getModelPool(config[tier], config.redundantAgents).length);
  }

  function zeroUsage() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  }

  /** Verdicts crossing a dependency edge, bounded so a wave cannot explode. */
  function buildUpstreamBlock(node: PlanNode, batch: PendingBatch): string {
    if (!node.needs || node.needs.length === 0) return "";
    const parts: string[] = [];
    for (const dep of node.needs) {
      const agentId = batch.nodeAgent.get(dep);
      if (!agentId) continue;
      // `agent-manager`'s close handler calls notifyStateChange() (which drives
      // this scheduler) BEFORE instance.resolve(), so the captured result may not
      // be in `batch.results` yet when the next wave launches. Fall back to the
      // live agent, which is already terminal and holds its finalOutput — without
      // this the edge would inject "(no result reported)" in the common path.
      const source = batch.results.get(agentId) ?? getAgent(agentId);
      const verdict = source ? distillConclusion(toRecon(source), UPSTREAM_VERDICT_CHARS) : "(no result reported)";
      parts.push(`- upstream #${dep} ${agentId} [${source?.status ?? "unknown"}]: ${verdict}`);
    }
    if (parts.length === 0) return "";
    return `Upstream results from this Trimegisto batch (you depend on them — build on them, do not re-derive):\n${parts.join("\n")}\n\n`;
  }

  /** Every agent of the CURRENT wave reached a terminal state. */
  function waveFinished(batch: PendingBatch): boolean {
    if (batch.waveAgentIds.length === 0) return true;
    const statuses: Record<string, string | undefined> = {};
    for (const id of batch.waveAgentIds) statuses[id] = getAgent(id)?.status;
    // Single source of truth for "terminal": the tested pure decision helper.
    return decideBatchSettle(
      batch.waveAgentIds,
      statuses,
      new Set(batch.results.keys()),
      Date.now(),
      Number.POSITIVE_INFINITY,
    ).settle;
  }

  /**
   * Launch one wave. Returns false (without launching anything) when the tier
   * capacity is not available yet, so the caller can retry on the next sweep
   * instead of half-launching or failing the batch.
   */
  function launchWave(batch: PendingBatch, wave: PlanNode[]): boolean {
    if (!wave || wave.length === 0) return true;

    // Pre-check capacity for the WHOLE wave: never half-launch a wave.
    const projected: Record<string, number> = { active: 0, t1: 0, t2: 0, t3: 0 };
    for (const node of wave) {
      const tier = (batch.taskByIndex.get(node.index)?.tier as AgentTier) || "active";
      if (tierHasModel(tier)) projected[tier] = (projected[tier] || 0) + 1;
    }
    const counts = getAgentCounts();
    for (const tier of ["active", "t1", "t2", "t3"] as const) {
      const n = projected[tier] || 0;
      if (n === 0) continue;
      // Keep the swarm guard's spawn-depth check in the loop (it used to live in
      // the pre-flight capacity check that the wave scheduler replaced).
      if (!canSpawnPooled(tier, config[tier], config.redundantAgents, undefined, spawnModelOverride(tier))) return false;
      const inFlight = counts[tier].running + counts[tier].waiting;
      if (inFlight + n > tierCapacity(tier)) return false;
    }

    batch.waveAgentIds = [];
    for (const node of wave) {
      // Defense in depth: one node index must never spawn twice. Today this is
      // guaranteed by `currentWave` monotonicity, but that guarantee is emergent;
      // making it local means a future refactor cannot silently double-spawn.
      if (batch.launched.has(node.index)) {
        // Already launched: keep it inside this wave's terminality set so
        // waveFinished still covers the whole wave.
        const known = batch.nodeAgent.get(node.index);
        if (known) batch.waveAgentIds.push(known);
        continue;
      }
      const spec = batch.taskByIndex.get(node.index);
      const tier: AgentTier = (spec?.tier as AgentTier) || "active";
      const taskText = spec?.task ?? node.task;
      const syntheticId = `#${node.index}-${node.task.slice(0, 24)}`;

      if (!tierHasModel(tier)) {
        const agentId = `err-${tier}-${batch.agentIds.length + 1}`;
        batch.agentIds.push(agentId);
        batch.waveAgentIds.push(agentId);
        batch.launched.add(node.index);
        batch.results.set(agentId, {
          agentId,
          tier,
          task: taskText,
          status: "error",
          output: "",
          finalOutput: "",
          stderr: `No model configured for ${formatTierLabel(tier)}.`,
          stopReason: "no_model",
          usage: zeroUsage(),
        });
        batch.taskDetails.push({ agentId, tier, task: taskText, status: "error", wave: node.wave, needs: node.needs });
        continue;
      }

      let taskModelOverride = spawnModelOverride(tier);
      if (config.redundantAgents && tier !== "active") {
        const pool = getModelPool(config[tier], true);
        const pick = selectAvailableModel(tier, pool, config[tier].maxParallel);
        if (pick) taskModelOverride = pick;
      }

      const upstream = buildUpstreamBlock(node, batch);
      const launchTaskText = upstream ? `${upstream}${taskText}` : taskText;

      try {
        // Register the ORIGINAL task text (not the upstream preamble) so the
        // cross-call dedup registry keeps comparing like with like.
        if (config.dedupeTasks) registerTask(tier, taskText);
        const agent = launchAgent(tier, launchTaskText, config[tier], spec?.cwd || batch.cwd, undefined, taskModelOverride, config.redundantAgents);
        batch.agentIds.push(agent.id);
        batch.waveAgentIds.push(agent.id);
        batch.nodeAgent.set(node.index, agent.id);
        batch.launched.add(node.index);
        batch.taskDetails.push({
          agentId: agent.id,
          tier: agent.tier,
          task: taskText,
          status: agent.status,
          wave: node.wave,
          needs: node.needs,
        });
        // Hand the ORIGINAL task text to the result collector. The launched text
        // carries the upstream preamble, and using it downstream breaks two
        // things: `forgetTask(result.task)` no longer matches the string that
        // `registerTask` stored (so a legitimate retry is blocked as a duplicate
        // for the whole 5-minute window), and the reconciliation would print the
        // injected preamble in the task column.
        agent.resolve = (result) => recordResult(batch, { ...result, task: taskText });
      } catch (err: any) {
        const agentId = syntheticId;
        // The task was registered just before launchAgent; a launch failure must
        // unregister it or the next legitimate retry is rejected as a duplicate.
        if (config.dedupeTasks) forgetTask(taskText);
        batch.agentIds.push(agentId);
        batch.waveAgentIds.push(agentId);
        batch.launched.add(node.index);
        batch.results.set(agentId, {
          agentId,
          tier,
          task: taskText,
          status: "error",
          output: "",
          finalOutput: "",
          stderr: `Launch failed: ${err?.message || String(err)}`,
          stopReason: "launch_error",
          usage: zeroUsage(),
        });
        batch.taskDetails.push({ agentId, tier, task: taskText, status: "error", wave: node.wave, needs: node.needs });
      }
    }
    return true;
  }

  function recordResult(batch: PendingBatch, result: any): void {
    if (batch.settled) return;
    // Allow a legitimate retry if the accepted spawn failed outright
    if (result.status === "error" || result.status === "killed") forgetTask(result.task);
    batch.results.set(result.agentId, result);
    // This runs inside agent-manager's child-process close callback
    // (`instance.resolve?.(buildResult())`), which has NO handler of its own: an
    // exception here would propagate into pi's process exit path and can take the
    // host down. No scheduling bookkeeping is worth crashing pi for — report it
    // and let the deadline sweep settle the batch.
    try {
      advanceBatch(batch);
    } catch (err: any) {
      safeAppendEntry("trimegisto-log", {
        text: `⚠️ Scheduler error while handling a result for ${batch.id}: ${err?.message || String(err)}`,
      });
    }
  }

  /**
   * Drive a batch across its waves and settle it exactly once at the end.
   *
   * The loop, the "one wave at a time" rule and the RE-ENTRANCY guard live in
   * `src/wave-scheduler.ts` (tested directly by `test-wave-scheduler.ts`); this
   * adapter only injects the batch's facts and effects. Re-entrancy is real:
   * `launchAgent` calls `notifyStateChange()` synchronously while registering the
   * agent, which drives the state-change callback back through `sweepBatches`
   * before `currentWave` has advanced.
   */
  function advanceBatch(batch: PendingBatch): void {
    advanceWaves(batch, {
      waveCount: batch.waves.length,
      isCurrentWaveTerminal: (currentWave) => (currentWave < 0 ? true : waveFinished(batch)),
      isStopped: () => batch.waveAgentIds.some((id) => {
        // Read the LIVE agent state too: a kill without a close event never
        // produces a captured result.
        const r = batch.results.get(id);
        const live = getAgent(id);
        const status = r?.status ?? live?.status;
        const stopReason = r?.stopReason ?? live?.stopReason;
        return status === "killed" || stopReason === "halted" || stopReason === "killed";
      }),
      isHalted: () => isHalted(),
      isEnabled: () => config.enabled,
      isDeadlineReached: () => Date.now() >= batch.deadlineAt,
      launchWave: (waveIndex) => launchWave(batch, batch.waves[waveIndex]),
      settle: (reason) => settleBatch(batch, reason),
    });
  }

  /** Settle every batch whose current wave is done, or that passed its deadline. */
  function sweepBatches(): void {
    if (pendingBatches.length === 0) return;
    for (const batch of [...pendingBatches]) {
      if (batch.settled) continue;
      try { advanceBatch(batch); } catch { /* never break the host on a sweep */ }
    }
  }

  // Safety net for agents killed without a close event (killAgent/haltAll) and
  // for batches whose watchdog is disabled: never leave a batch unsettled.
  const batchSweepInterval = setInterval(() => {
    if (disposed) return;
    try { sweepBatches(); } catch { /* never crash the session on a sweep */ }
  }, 2000);
  (batchSweepInterval as any).unref?.();

  // ── Model health (circuit breaker) ─────────────────────
  // Pauses spawns on a model that keeps failing at the provider level, so a
  // broken model cannot trigger an uncontrolled spawn storm.
  const modelHealth = new ModelHealth();
  setModelHealth(modelHealth);

  function applyModelHealthConfig(): void {
    modelHealth.updateConfig(config.modelHealth ?? MODEL_HEALTH_DEFAULTS);
  }
  applyModelHealthConfig();

  modelHealth.setOnTrip((entry, info) => {
    const secs = Math.max(1, Math.ceil(info.remainingMs / 1000));
    safeAppendEntry("trimegisto-log", {
      text: `🚫 **[Trimegisto model health]** ${entry.model} paused after ${entry.failures} model-level failure(s) — ${entry.lastReason || "provider error"}. Spawns on it are refused for ~${secs}s. Switch model via /tmg config or clear with /tmg reset-models.`,
    });
    try {
      if (ctxRef?.hasUI) ctxRef.ui.notify(`Model ${entry.model} paused (~${secs}s): spawns refused`, "error");
    } catch { /* stale ctx after session reload */ }
  });

  // Active pi model (used for spawning agents with the same model by default)
  let activeModel: string | null = null;

  function captureActiveModel(ctx: any): string | null {
    const m = ctx?.model as any;
    if (!m) return null;
    // Some runtimes expose the model as a plain string
    if (typeof m === "string") return m || null;
    if (m?.provider && m?.id) {
      return `${m.provider}/${m.id}`;
    }
    if (m?.id) return String(m.id);
    if (m?.name) return String(m.name);
    return null;
  }

  /**
   * Whether a tier currently has a usable model.
   * The ACTIVE tier runs the pi ACTIVE model (captured from ctx), NOT a static
   * config.model. pi always has an active model (it's the one in use), so the
   * tier is available as long as it's enabled. activeModel is used only for the
   * tool description and for the --model override.
   */
  function tierHasModel(tier: AgentTier): boolean {
    if (tier === "active") {
      return config.active.enabled;
    }
    const tc = config[tier];
    return !!tc && tc.enabled && !!tc.model;
  }

  /**
   * Model to use for spawned agents, by tier:
   * - "active" (t0): the pi ACTIVE model (default for mass parallel spawn)
   * - t1/t2/t3: their own configured models (no override)
   */
  function spawnModelOverride(tier?: string): string | undefined {
    if (tier && tier !== "active") return undefined;
    return config.useActiveModel && activeModel ? activeModel : undefined;
  }

  // ── Swarm guard ───────────────────────────────────────
  const loopSupervisor = new LoopSupervisor();
  setLoopSupervisor(loopSupervisor);

  // Guard alert → chat notification (loop detection itself lives in antiloop)
  loopSupervisor.setOnAlert((alert: LoopAlert) => {
    const isDup = alert.type === "cross_agent_duplicate";
    const isTurn = alert.type === "turn_limit";
    const emoji = isDup ? "♻️" : isTurn ? "⏳" : "🚧";
    const label = isDup ? "Redundancy" : isTurn ? "Turn limit" : "Spawn depth";
    safeAppendEntry("trimegisto-log", {
      text: `${emoji} **[Trimegisto ${label}]** ${alert.message}`,
    });
    try {
      if (ctxRef?.hasUI) {
        ctxRef.ui.notify(
          `${label}: ${alert.tier} — ${alert.message.slice(0, 80)}`,
          isDup || isTurn ? "warning" : "error",
        );
      }
    } catch { /* ctx stale after session reload */ }
  });

  // Store toggle function on pi for commands to access
  (pi as any)._trimegistoToggleDashboard = () => {
    // Cycle through modes: compact -> widget -> off -> compact
    const modes: Array<"widget" | "compact" | "off"> = ["compact", "widget", "off"];
    const idx = modes.indexOf(dashboardMode);
    dashboardMode = modes[(idx + 1) % modes.length];
    updateDashboard();
  };

  // ── Agent log buffers for chat streaming ──────────────
  const logBuffers = new Map<string, { entries: AgentLogEntry[]; timer: ReturnType<typeof setTimeout> | null }>();

  function flushLogBuffer(agentId: string) {
    const buf = logBuffers.get(agentId);
    if (disposed) {
      if (buf?.timer) clearTimeout(buf.timer);
      if (buf) { buf.timer = null; buf.entries = []; }
      return;
    }
    if (!buf || buf.entries.length === 0) return;
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }

    const entries = buf.entries.splice(0);
    const lines: string[] = [];
    for (const entry of entries) {
      switch (entry.level) {
        case "info":
          if (entry.text.startsWith("Started:")) {
            lines.push(`🔹 **[${agentId}]** started`);
          } else if (entry.text.startsWith("✓")) {
            lines.push(`✅ **[${agentId}]** ${entry.text.slice(2)}`);
          } else if (entry.text.startsWith("✗")) {
            lines.push(`❌ **[${agentId}]** ${entry.text.slice(2)}`);
          } else if (entry.text.startsWith("💭")) {
            lines.push(`💭 **[${agentId}]** thinking...`);
          } else {
            lines.push(`ℹ️ **[${agentId}]**: ${entry.text}`);
          }
          break;
        case "output":
          lines.push(`**[${agentId}]** ${entry.text}`);
          break;
        case "tool":
          lines.push(`🔧 **[${agentId}]** ${entry.text}`);
          break;
        case "error":
          lines.push(`❌ **[${agentId}]** ${entry.text}`);
          break;
      }
    }
    if (lines.length > 0) {
      safeAppendEntry("trimegisto-log", { text: lines.join("\n") });
      // Force TUI re-render so messages appear immediately
      try {
        if (ctxRef?.hasUI) {
          ctxRef.ui.setStatus("trimegisto", formatTmgStatus(true, `${formatTierLabel(getAgent(agentId)?.tier || "?")} ${agentId} active`));
        }
      } catch { /* ctx stale after session reload */ }
    }
  }

  function flushAllLogBuffers() {
    for (const agentId of logBuffers.keys()) {
      flushLogBuffer(agentId);
    }
  }

  let dashboardImport: Promise<typeof import("./dashboard.ts")> | null = null;
  function loadDashboard() {
    return dashboardImport ??= import("./dashboard.ts");
  }

  async function updateDashboard(): Promise<void> {
    try {
      if (!ctxRef?.hasUI) return;
      ctxRef.ui.setFooter(undefined);
      if (dashboardMode === "off") {
        ctxRef.ui.setWidget("trimegisto", undefined);
        ctxRef.ui.setWidget("trimegisto-compact", undefined);
        return;
      }
      const { createDashboardWidget, createCompactWidget } = await loadDashboard();
      if (dashboardMode === "compact") {
        ctxRef.ui.setWidget("trimegisto", undefined);
        ctxRef.ui.setWidget("trimegisto-compact", createCompactWidget(ctxRef), { placement: "belowEditor" });
      } else {
        ctxRef.ui.setWidget("trimegisto", createDashboardWidget(ctxRef));
        ctxRef.ui.setWidget("trimegisto-compact", undefined);
      }
    } catch { /* stale ctx/reload */ }
  }

  // ── Launch helper (for commands and tool) ──────────────
  function doLaunch(tier: AgentTier, task: string, cwd: string, parentId?: string): AgentInstance | { agentId: string; tier: AgentTier; task: string; status: "error"; output: string; stderr: string; usage: any; log: AgentLogEntry[] } {
    // Spawn-only-on-active: force all spawns onto the active tier (t0)
    if (config.spawnOnlyOnActive && tier !== "active") tier = "active";
    const tierConfig = config[tier];

    if (!tierAvailable(tier)) {
      return {
        agentId: `error-${Date.now()}`,
        tier,
        task,
        status: "error" as const,
        output: "",
        stderr: `Tier ${formatTierLabel(tier)} is not available (disabled or no model configured). Enable it or set a model via /tmg config.`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        log: [] as AgentLogEntry[],
      };
    }

    // The ACTIVE tier has no static model — it uses the pi ACTIVE model (or pi's
    // default when useActiveModel is OFF). Only t1/t2/t3 need a configured model.
    if (tier !== "active" && !tierConfig.model) {
      return {
        agentId: `error-${Date.now()}`,
        tier,
        task,
        status: "error" as const,
        output: "",
        stderr: `No model configured for ${formatTierLabel(tier)} tier. Use /tmg config to set one.`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        log: [] as AgentLogEntry[],
      };
    }

    // Model-level circuit breaker: refuse to launch on a model in cooldown.
    const modelBlock = getTierModelBlock(tier, tierConfig, config.redundantAgents, spawnModelOverride(tier));
    if (modelBlock) {
      return {
        agentId: `error-${Date.now()}`,
        tier,
        task,
        status: "error" as const,
        output: "",
        stderr: formatModelBlockMessage(modelBlock, formatTierLabel(tier)),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        log: [] as AgentLogEntry[],
      };
    }

    // Pick the least-loaded model from the tier pool when redundant agents are ON
    let modelOverride = spawnModelOverride(tier);
    if (config.redundantAgents && tier !== "active") {
      const pool = getModelPool(tierConfig, true);
      const pick = selectAvailableModel(tier, pool, tierConfig.maxParallel);
      if (pick) modelOverride = pick;
    }

    return launchAgent(tier, task, tierConfig, cwd, parentId, modelOverride, config.redundantAgents);
  }

  // ── /t1 /t2 /t3 slash-command interception ────────────
  // Intercept "/t2 task" (spawn) or "/t2b instruction" (steer) before the main LLM sees them.
  pi.on("input", async (event, ctx) => {
    if (!config.enabled) return { action: "continue" as const };

    const text = event.text.trim();
    const slashMatch = text.match(/^\/(t[123])([a-z])?\s+(.+)/);
    if (!slashMatch) return { action: "continue" as const };

    const tier = slashMatch[1] as AgentTier;
    const letter = slashMatch[2] || "";
    const task = slashMatch[3].trim();

    if (!config[tier].model) {
      ctx.ui.notify(`No model configured for ${formatTierLabel(tier)}. Use /tmg config.`, "error");
      return { action: "handled" as const };
    }

    // Echo the user's command to chat so it's visible
    safeSendMessage({
      customType: "trimegisto-command",
      content: `/${tier}${letter} ${task}`,
      display: true,
    });

    if (letter) {
      const targetId = `${tier}${letter}`;
      const existing = getAgent(targetId);
      if (existing && (existing.status === "running" || existing.status === "waiting")) {
        ctx.ui.notify(`Steering ${targetId} with new instruction...`, "info");
        const agent = sendToAgent(targetId, task, { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 }, ctx.cwd, undefined, config.spawnOnlyOnActive, config.redundantAgents);
        if (agent) {
          ctx.ui.notify(`${targetId} stopped → ${agent.id} launched with new instruction`, "info");
        } else {
          ctx.ui.notify(`Error steering ${targetId}`, "error");
        }
        return { action: "handled" as const };
      }
      // Letter specified but agent doesn't exist → spawn with that specific ID
      ctx.ui.notify(`Agent ${targetId} not found. Spawning new ${formatTierLabel(tier)} as ${targetId}...`, "info");
      const agent = doLaunch(tier, task, ctx.cwd, targetId);
      if ("status" in agent && agent.status === "error") {
        ctx.ui.notify(`${(agent as any).agentId} failed: ${agent.stderr.slice(0, 100)}`, "error");
      } else {
        const a = agent as AgentInstance;
        ctx.ui.notify(`${a.id} [${formatTierLabel(tier)}] launched`, "info");
      }
      return { action: "handled" as const };
    }

    // No letter → spawn new agent
    ctx.ui.notify(`Launching ${formatTierLabel(tier)} agent...`, "info");
    const agent = doLaunch(tier, task, ctx.cwd);
    if ("status" in agent && agent.status === "error") {
      ctx.ui.notify(`${(agent as any).agentId} failed: ${agent.stderr.slice(0, 100)}`, "error");
    } else {
      const a = agent as AgentInstance;
      ctx.ui.notify(`${a.id} [${formatTierLabel(tier)}] launched`, "info");
    }

    return { action: "handled" as const };
  });

  // ── @agent input interception ──────────────────────────
  // Intercept "@t2 task" or "@t3b instruction" before the main LLM sees them.
  pi.on("input", async (event, ctx) => {
    if (!config.enabled) return { action: "continue" as const };

    const text = event.text.trim();
    const match = text.match(/^@(t[123])([a-z])?\s+(.+)/);
    if (!match) return { action: "continue" as const };

    const tier = match[1] as AgentTier;
    const letter = match[2] || "";
    const task = match[3].trim();

    if (!task) {
      ctx.ui.notify("Usage: @t2 <task> (new) or @t2b <instruction> (existing)", "error");
      return { action: "handled" as const };
    }

    if (!config[tier].model) {
      ctx.ui.notify(`No model configured for ${formatTierLabel(tier)}. Use /tmg config.`, "error");
      return { action: "handled" as const };
    }

    // Echo the user's command to chat so it's visible
    safeSendMessage({
      customType: "trimegisto-command",
      content: `@${tier}${letter} ${task}`,
      display: true,
    });

    if (letter) {
      const targetId = `${tier}${letter}`;
      const existing = getAgent(targetId);
      if (existing && (existing.status === "running" || existing.status === "waiting")) {
        ctx.ui.notify(`Sending to ${targetId}...`, "info");
        // Kill old agent and launch a new one with the combined instruction
        const agent = sendToAgent(targetId, task, { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 }, ctx.cwd, undefined, config.spawnOnlyOnActive, config.redundantAgents);
        if (agent) {
          ctx.ui.notify(`${targetId} stopped → ${agent.id} launched with new instruction`, "info");
        } else {
          ctx.ui.notify(`Error sending to ${targetId}`, "error");
        }
        return { action: "handled" as const };
      }
      // Letter specified but agent doesn't exist → spawn with that specific ID
      ctx.ui.notify(`Agent ${targetId} not found. Spawning new ${formatTierLabel(tier)} as ${targetId}...`, "info");
      const agent = doLaunch(tier, task, ctx.cwd, targetId);
      if ("status" in agent && agent.status === "error") {
        ctx.ui.notify(`${(agent as any).agentId} failed: ${agent.stderr.slice(0, 100)}`, "error");
      } else {
        const a = agent as AgentInstance;
        ctx.ui.notify(`${a.id} [${formatTierLabel(tier)}] launched`, "info");
      }
      return { action: "handled" as const };
    }

    ctx.ui.notify(`Launching ${formatTierLabel(tier)} agent...`, "info");
    // Fire-and-forget: spawns agent, returns immediately
    const agent = doLaunch(tier, task, ctx.cwd);
    if ("status" in agent && agent.status === "error") {
      ctx.ui.notify(`${(agent as any).agentId} failed: ${agent.stderr.slice(0, 100)}`, "error");
    } else {
      const a = agent as AgentInstance;
      ctx.ui.notify(`${a.id} [${formatTierLabel(tier)}] launched`, "info");
    }

    return { action: "handled" as const };
  });

  // ── Auto-spawning logic ────────────────────────────────
  const spawnPollInterval = setInterval(() => {
    if (disposed || !config.enabled) return;
    if (config.autoSpawn) {
      try {
        const cwd = ctxRef?.cwd || process.cwd();
        processSpawnRequests(
          { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
          cwd,
          spawnModelOverride("active"),
          config.spawnOnlyOnActive,
          config.redundantAgents,
          config.dedupeTasks,
        );
      } catch { /* silently ignore polling errors */ }
    }
    // Clean up old context notifications periodically
    try { cleanupOldNotifications(); } catch { /* ignore */ }
  }, 500);

  // ── Tool availability (so the coordinator knows what it can spawn) ──
  function tierAvailable(tier: string): boolean {
    if (tier === "active") {
      // pi always has an active model (the one in use), so this tier is
      // available whenever it's enabled. activeModel is only informational.
      return config.active.enabled;
    }
    // Spawn-only-on-active: t1/t2/t3 are never spawnable
    if (config.spawnOnlyOnActive) return false;
    const tc = (config as any)[tier];
    if (!tc) return false;
    return tc.enabled && !!tc.model;
  }

  function tierStatusLine(tier: AgentTier): string {
    const label = formatTierLabel(tier);
    const avail = tierAvailable(tier);
    const mark = avail ? "✓ ENABLED" : "✗ unavailable";
    const model = tier === "active"
      ? (activeModel || "no active model")
      : ((config as any)[tier]?.model || "no model") + redundantSuffix(tier);
    let why = "";
    if (!avail) {
      if (tier === "active") why = config.active.enabled ? " (no active model)" : " (disabled)";
      else if (config.spawnOnlyOnActive) why = " (spawn-only-on-active)";
      else why = ` (${(config as any)[tier]?.enabled === false ? "disabled" : "no model"})`;
    }
    // Surface an open circuit breaker so the coordinator does not try a model
    // that will be refused, and knows roughly when it comes back.
    const block = avail ? getTierModelBlock(tier, (config as any)[tier], config.redundantAgents, spawnModelOverride(tier)) : null;
    const paused = block ? ` ⛔ paused ${Math.max(1, Math.ceil(block.remainingMs / 1000))}s` : "";
    return `- ${label}: ${mark}${why} [${model}]${paused}`;
  }

  function redundantSuffix(tier: string): string {
    if (!config.redundantAgents || tier === "active") return "";
    const rm = ((config as any)[tier]?.redundantModels as string[] | undefined) ?? [];
    return rm.length > 0 ? ` (+${rm.length} redundant)` : "";
  }

  function buildToolDescription(): string {
    return [
      "Launch parallel Trimegisto sub-agents.",
      "PROACTIVE POLICY: when Trimegisto is enabled, decompose and call this tool FIRST for any request with 2+ independent subtasks/files/areas. Skip only for a single indivisible/non-parallelizable/trivial task or explicit user opt-out. Assign DISJOINT, non-overlapping subtasks so no two agents redo the same work; only spawn redundant scouts (same task, different angle) when you explicitly need verification/consensus. After launching, NEVER sleep/poll/wait idly for agents; continue useful foreground work or call trimegisto_harvest for an instant snapshot.",
      "Tiers now:",
      tierStatusLine("active"),
      tierStatusLine("t1"),
      tierStatusLine("t2"),
      tierStatusLine("t3"),
      "Default active/t0 = main pi model; prefer several active agents for mass parallel work across DIFFERENT files/areas.",
      "PLAN CONTRACT (this is what keeps cost down): always pass `goal` (the overall objective) and, per task, `why` (the part of the goal it serves). Declare `needs: [i]` ONLY when a task really reads another task's output — a declared edge runs in waves and the upstream verdict is injected into the dependent task; tasks WITHOUT an edge run in parallel. Declare `writes: [paths]` when you know the files a task will write: writers of the same file are serialised automatically. Pass `lane` only to override the automatic blast-radius lane.",
      "A deterministic plan gate runs BEFORE anything is spawned: it merges near-duplicate tasks inside the batch, serialises same-file writers, warns when a task looks like a pure code transformation (do it with bash instead of a model), warns when `needs` reads like a pipeline step but no edge was declared, and REFUSES the batch when any task lands in the closed lane (irreversible/high-consequence: deletions, deploy, publish, migrations, production data, credentials). Design the graph, never a flat pile: parallel only what is independent, serialise what is not, and never re-spawn work already in flight.",
      "When a batch settles, Trimegisto sends ONE deterministic reconciliation (per-agent verdicts, status counts, overlaps, INCOMPLETE list). When you receive it, write the unified final answer for the user; do not re-spawn the same work, and do not answer before it arrives.",
      "Roles: active=t0 mass worker; t3=mechanical; t2=reasoning; t1=deep planning only.",
      "Only spawn ✓ ENABLED tiers; ✗ unavailable fails. IDs: t0a,t1a,t2b,t3c... Disabled tool returns error.",
    ].join("\n");
  }

  // ── Register the main Trimegisto tool ──────────────────
  function registerMainTool(): void {
  pi.registerTool({
    name: "trimegisto",
    label: "Trimegisto Multi-Agent",
    description: buildToolDescription(),
    promptSnippet: "TRIMEGISTO ACTIVE: spawn parallel agents before decomposable work. After launch, never sleep/poll to wait; continue work or call trimegisto_harvest. Default tier active; use only ENABLED tiers.",
    parameters: Type.Object({
      tasks: Type.Array(TrimegistoTaskItem, {
        description: "Tasks. Max 8. Default tier active. Tasks without a 'needs' edge run in parallel; declared dependencies are executed in waves.",
      }),
      goal: Type.Optional(Type.String({
        description: "The overall objective this batch must advance. Used by the plan gate to check that every task serves a real need.",
      })),
      cwd: Type.Optional(Type.String({ description: "Shared cwd" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "Trimegisto disabled. Use /tmg enable." }],
          details: { enabled: false },
          isError: true,
        };
      }

      // Keep the active model fresh (in case the user switched models mid-session)
      const freshModel = captureActiveModel(ctx);
      if (freshModel) activeModel = freshModel;

      if (!params.tasks || params.tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks provided." }],
          details: { tasks: [] },
        };
      }

      if (params.tasks.length > 8) {
        return {
          content: [{ type: "text", text: "Too many tasks (max 8)." }],
          details: { tasks: [] },
        };
      }

      const cwd = params.cwd || ctx.cwd;

      // Normalize: tier defaults to "active" (same model as the main session)
      for (const t of params.tasks) {
        if (!t.tier) t.tier = "active" as any;
      }

      // Spawn-only-on-active: force every task onto the active tier (t0)
      if (config.spawnOnlyOnActive) {
        for (const t of params.tasks) {
          if (t.tier !== "active") t.tier = "active" as any;
        }
      }

      // ── Pre-launch registry dedup (cross-call, check-only) ───
      // Compared against tasks spawned in the last few minutes. A duplicate is
      // NOT registered so it can still be retried later. Original 1-based
      // indices are preserved in `remap` so the coordinator's `needs` still line
      // up with what it proposed.
      const dedupedTasks: any[] = [];
      const skippedTasks: { task: string; tier: string; matchedTask: string; matchedTier?: string }[] = [];
      const origToKept = new Map<number, number>();
      params.tasks.forEach((t: any, i: number) => {
        const origIndex = i + 1;
        if (config.dedupeTasks) {
          const dup = isDuplicateTask(t.task);
          if (dup.duplicate) {
            skippedTasks.push({ task: t.task, tier: t.tier, matchedTask: dup.matchedTask ?? "", matchedTier: dup.matchedTier });
            return;
          }
        }
        origToKept.set(origIndex, dedupedTasks.length + 1);
        dedupedTasks.push(t);
      });

      if (dedupedTasks.length === 0) {
        return {
          content: [{
            type: "text",
            text: `⏭ All ${params.tasks.length} task(s) are near-duplicates of already-spawned work:\n` +
              skippedTasks.map(s => `  - "${s.task.slice(0, 80)}" ≈ "${s.matchedTask.slice(0, 80)}"${s.matchedTier ? ` [${s.matchedTier}]` : ""}`).join("\n") +
              `\n\nNo new agents launched. The original agents' results are already being reconciled.`,
          }],
          details: { tasks: [], skipped: skippedTasks },
        };
      }

      // ── Plan gate: validate the batch as a GRAPH before spending anything ──
      // Which nodes exist, which are duplicates, which must be serialised and
      // which must not run at all. Deterministic and model-free.
      const droppedNeeds: string[] = [];
      const planInputs: PlanTaskInput[] = dedupedTasks.map((t: any, i: number) => {
        const declared = Array.isArray(t.needs) ? t.needs : [];
        const needs: number[] = [];
        for (const raw of declared) {
          const n = Number(raw);
          const mapped = origToKept.get(n);
          if (!Number.isFinite(n)) continue;
          if (mapped === undefined) {
            droppedNeeds.push(`task #${i + 1} declared a dependency on #${n}, which was skipped as already-spawned work — the edge was dropped`);
          } else if (!needs.includes(mapped)) {
            needs.push(mapped);
          }
        }
        return {
          task: String(t.task ?? ""),
          needs: needs.length > 0 ? needs : undefined,
          why: typeof t.why === "string" ? t.why : undefined,
          writes: Array.isArray(t.writes) ? t.writes.map(String) : undefined,
          lane: t.lane,
          cwd: t.cwd,
        } as PlanTaskInput;
      });

      const planGoal = typeof params.goal === "string" && params.goal.trim() ? params.goal.trim() : undefined;
      const plan = planBatch(planInputs, planGoal ? { goal: planGoal, maxTasks: 8 } : { maxTasks: 8 });
      const planDetails = {
        accept: plan.accept,
        counts: plan.counts,
        waves: plan.waves,
        warnings: plan.warnings,
        blockers: plan.blockers,
      };

      // Human-readable notes about how the plan was reshaped. Computed here so
      // EVERY branch (including the refusals) can report what changed.
      const planNotes: string[] = [];
      if (plan.counts.duplicates > 0) planNotes.push(`⏭ Merged ${plan.counts.duplicates} duplicate task(s) inside this batch.`);
      if (plan.counts.serialized > 0) planNotes.push(`🔗 Serialised ${plan.counts.serialized} task(s) that would race on the same file.`);
      for (const w of droppedNeeds) planNotes.push(`⚠️ ${w}`);
      if (skippedTasks.length > 0) {
        planNotes.push(`⏭ Skipped ${skippedTasks.length} near-duplicate task(s) of already-spawned work:\n` +
          skippedTasks.map(s => `  - "${s.task.slice(0, 60)}" ≈ "${s.matchedTask.slice(0, 60)}"`).join("\n"));
      }
      if (!plan.accept) {
        return {
          content: [{
            type: "text",
            text: `${plan.summary}\n\n⛔ **No agents launched.** Trimegisto refuses high-consequence work (closed lane). ` +
              `Resolve the blockers, move the task to an open lane, or ask the user to decide explicitly.` +
              (planNotes.length > 0 ? `\n\n${planNotes.join("\n")}` : ""),
          }],
          details: { plan: planDetails, tasks: [] },
          isError: true,
        };
      }

      // Per-wave feasibility: a wave larger than the tier capacity could never
      // start (the scheduler would defer it until the deadline), so refuse it
      // with an actionable message instead of hanging silently.
      for (let w = 0; w < plan.waves.length; w++) {
        const perTier: Record<string, number> = { active: 0, t1: 0, t2: 0, t3: 0 };
        for (const idx of plan.waves[w]) {
          const t = (dedupedTasks[idx - 1]?.tier as AgentTier) || "active";
          perTier[t] = (perTier[t] || 0) + 1;
        }
        for (const tier of ["active", "t1", "t2", "t3"] as const) {
          if (perTier[tier] > tierCapacity(tier)) {
            return {
              content: [{
                type: "text",
                text: `${plan.summary}\n\n❌ **No agents launched.** Wave ${w + 1} needs ${perTier[tier]} ${formatTierLabel(tier)} agent(s) ` +
                  `but the capacity is ${tierCapacity(tier)}. Split that wave with explicit \`needs\` so it runs in more waves, ` +
                  `reduce the batch, or raise maxParallel via /tmg config.` +
                  (planNotes.length > 0 ? `\n\n${planNotes.join("\n")}` : ""),
              }],
              details: { plan: planDetails, tasks: [] },
              isError: true,
            };
          }
        }
      }

      // Reject tiers that are disabled or have no model — the coordinator should
      // only spawn tiers listed as ENABLED in this tool's description.
      const unavailable = dedupedTasks.filter((t: any) => !tierAvailable(t.tier));
      if (unavailable.length > 0) {
        const bad = [...new Set(unavailable.map((t: any) => t.tier))].join(", ");
        return {
          content: [{
            type: "text",
            text: `❌ Cannot spawn tier(s): ${bad} — not available right now (disabled or no model configured).\nAvailable tiers: ${["active","t1","t2","t3"].filter(tierAvailable).join(", ")}.\nConfigure with /tmg config.`,
          }],
          details: { unavailable: bad, available: ["active","t1","t2","t3"].filter(tierAvailable) },
          isError: true,
        };
      }

      // ── Model circuit breaker: refuse a batch that targets a paused model ──
      // (e.g. provider returning 400s). Retrying here is exactly what caused
      // the uncontrolled spawn storm, so the whole call is rejected with the
      // cooldown info and the healthy alternatives.
      const blockedTiers = new Map<AgentTier, string>();
      for (const t of dedupedTasks) {
        const tier = t.tier as AgentTier;
        if (blockedTiers.has(tier)) continue;
        const info = getTierModelBlock(tier, config[tier], config.redundantAgents, spawnModelOverride(tier));
        if (info) blockedTiers.set(tier, formatModelBlockMessage(info, formatTierLabel(tier)));
      }
      if (blockedTiers.size > 0) {
        const healthy = (["active", "t1", "t2", "t3"] as const)
          .filter(x => tierAvailable(x) && !blockedTiers.has(x));
        return {
          content: [{
            type: "text",
            text: [...blockedTiers.values()].join("\n\n") +
              `\n\nSpawn refused. Healthy tiers right now: ${healthy.length ? healthy.join(", ") : "none"}. ` +
              `Do not retry the paused tier; continue with healthy work or fix the model via /tmg config.`,
          }],
          details: { blocked: [...blockedTiers.keys()], tasks: [] },
          isError: true,
        };
      }

      // (Capacity is checked per wave by the scheduler, which defers a wave
      // instead of refusing it when the tier is momentarily full.)

      // ── Register the batch and launch its FIRST wave ──────────
      const taskByIndex = new Map<number, any>();
      dedupedTasks.forEach((spec: any, i: number) => taskByIndex.set(i + 1, spec));
      const nodeByIndex = new Map<number, PlanNode>();
      for (const n of plan.launch) nodeByIndex.set(n.index, n);
      const waves: PlanNode[][] = plan.waves
        .map((w) => w.map((i) => nodeByIndex.get(i)).filter((n): n is PlanNode => !!n))
        .filter((w) => w.length > 0);

      const batch: PendingBatch = {
        id: `batch-${++batchSeq}`,
        startedAt: Date.now(),
        deadlineAt: Date.now() + BATCH_DEADLINE_MS,
        agentIds: [],
        skipped: skippedTasks,
        results: new Map(),
        settled: false,
        goal: planGoal,
        cwd,
        waves,
        currentWave: -1,
        waveAgentIds: [],
        taskByIndex,
        nodeAgent: new Map(),
        launched: new Set(),
        taskDetails: [],
        planSummary: plan.summary,
      };
      pendingBatches.push(batch);
      advanceBatch(batch);

      const taskDetails = batch.taskDetails;
      const taskList = taskDetails.map((t: any) =>
        `- **${t.agentId}**${t.wave ? ` (wave ${t.wave})` : ""} [${formatTierLabel(t.tier)}]: ${t.task.slice(0, 80)}`
      ).join("\n");

      // Wave 1 deferred because the tier was momentarily full: say so and ask the
      // coordinator NOT to retry (a retry would duplicate the whole plan).
      if (taskDetails.length === 0 && !batch.settled) {
        return {
          content: [{
            type: "text",
            text: plan.summary +
              `\n\n⏳ **Queued, not spawned yet:** ${waves[0]?.length ?? 0} task(s) waiting for tier capacity. ` +
              `Trimegisto launches them automatically as soon as a slot frees and still delivers ONE reconciliation. ` +
              `Do NOT call trimegisto again for this work — retrying would duplicate it.` +
              (planNotes.length > 0 ? `\n\n${planNotes.join("\n")}` : ""),
          }],
          details: { tasks: [], plan: planDetails },
        };
      }

      // Already settled while launching (e.g. every node of wave 1 failed
      // instantly): the reconciliation was delivered, so say so instead of
      // claiming a launch.
      if (batch.settled && taskDetails.length > 0) {
        return {
          content: [{
            type: "text",
            text: plan.summary +
              `\n\n⚠️ The batch settled immediately without any runnable work. The reconciliation above was already delivered to the chat.` +
              (planNotes.length > 0 ? `\n\n${planNotes.join("\n")}` : ""),
          }],
          details: { tasks: taskDetails, plan: planDetails },
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: plan.summary +
            `\n\n🚀 **Wave 1 of ${waves.length} is running now: ${taskDetails.length} of ${plan.launch.length} planned agent(s).**` +
            `\nThe list below is wave 1 only — later waves start when their dependencies settle:\n${taskList}` +
            (planNotes.length > 0 ? `\n\n${planNotes.join("\n")}` : "") +
            `\n\nA wave only starts when the previous one is terminal, so a declared \`needs\` edge really carries the upstream verdict. ` +
            `Do not block or sleep waiting: Trimegisto delivers ONE reconciliation with every agent's conclusion when the whole batch settles — even if an agent is killed or times out. For an on-demand snapshot, call trimegisto_harvest.`,
        }],
        details: { tasks: taskDetails, plan: planDetails },
      };
    },

    renderCall(args, theme, _context) {
      if (!config.enabled) {
        return new Text(theme.fg("dim", "◇ trimegisto disabled"), 0, 0);
      }
      if (!args.tasks || args.tasks.length === 0) {
        return new Text(theme.fg("muted", "trimegisto: no tasks"), 0, 0);
      }
      let text = theme.fg("toolTitle", theme.bold("◇ trimegisto ")) +
        theme.fg("accent", `${args.tasks.length} agents`);
      for (const t of args.tasks.slice(0, 5)) {
        const label = formatTierLabel(t.tier);
        const preview = t.task.length > 50 ? t.task.slice(0, 50) + "..." : t.task;
        text += `\n  ${theme.fg("muted", label)} ${theme.fg("dim", preview)}`;
      }
      if (args.tasks.length > 5) {
        text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 5} more`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { tasks: any[]; enabled?: boolean } | undefined;

      if (details?.enabled === false) {
        return new Text(theme.fg("muted", "◇ trimegisto disabled"), 0, 0);
      }

      if (!details || !details.tasks || details.tasks.length === 0) {
        return new Text(result.content?.[0]?.text || "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();
      const tasks = details.tasks;
      const successCount = tasks.filter((t: any) => t.status === "done").length;
      const launchedCount = tasks.filter((t: any) => t.status === "launched" || t.status === "running").length;

      if (expanded || tasks.some((t: any) => t.log && t.log.length > 0)) {
        const container = new Container();
        let icon: string;
        if (successCount === tasks.length) icon = "✓";
        else if (launchedCount > 0 || successCount > 0) icon = "◐";
        else icon = "✗";
        container.addChild(new Text(
          `${theme.fg("success", icon)} ${theme.fg("toolTitle", theme.bold("◇ Trimegisto "))}${theme.fg("accent", `${successCount}/${tasks.length} done`)}`,
          0, 0,
        ));

        for (const t of tasks) {
          const tStatus = t.status || "launched";
          const tIcon = tStatus === "done" ? "✓" : tStatus === "running" || tStatus === "launched" ? "◌" : "✗";
          const iconColor = tStatus === "done" ? "success" : tStatus === "running" || tStatus === "launched" ? "warning" : "error";

          container.addChild(new Spacer(1));
          const agentLabel = t.agentId ? theme.fg("accent", theme.bold(t.agentId)) : "?";
          container.addChild(new Text(
            `${theme.fg("muted", "───")} ${agentLabel} ${theme.fg(iconColor, tIcon)} ${theme.fg("dim", (t.task || "").slice(0, 60))}`,
            0, 0,
          ));

          // Show agent log entries
          if (t.log && t.log.length > 0) {
            for (const entry of t.log) {
              const levelColor = entry.level === "error" ? "error" : entry.level === "tool" ? "warning" : "dim";
              const prefix = entry.level === "error" ? "✗" : entry.level === "tool" ? "🔧" : "│";
              container.addChild(new Text(
                `  ${theme.fg(levelColor, prefix)} ${theme.fg("dim", entry.text.slice(0, 120))}`,
                0, 0,
              ));
            }
          } else if (t.output) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(t.output.trim().slice(0, 800), 0, 0, mdTheme));
          } else if (t.stderr) {
            container.addChild(new Text(theme.fg("error", t.stderr), 0, 0));
          } else if (tStatus === "launched") {
            container.addChild(new Text(theme.fg("dim", "  ⏳ running — see chat for live output"), 0, 0));
          }

          if (t.usage?.turns > 0) {
            container.addChild(new Text(
              theme.fg("dim", `  ${t.usage.turns} turns, ↑${t.usage.input} ↓${t.usage.output} $${t.usage.cost.toFixed(4)}`),
              0, 0,
            ));
          }
        }

        return container;
      }

      // Collapsed view with per-agent summary
      let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("◇ Trimegisto "))}${theme.fg("accent", `${successCount}/${tasks.length} done`)}`;
      for (const t of tasks) {
        const tStatus = t.status || "launched";
        const tIcon = tStatus === "done" ? "✓" : tStatus === "running" || tStatus === "launched" ? "◌" : "✗";
        const iconColor = tStatus === "done" ? "success" : tStatus === "running" || tStatus === "launched" ? "warning" : "error";
        const agentLabel = t.agentId ? theme.fg("accent", theme.bold(t.agentId)) : "?";
        const preview = (t.output || t.stderr || (tStatus === "running" || tStatus === "launched" ? "running…" : "(no output)")).slice(0, 60);
        text += `\n  ${theme.fg(iconColor, tIcon)} ${agentLabel} ${theme.fg("dim", preview)}`;
      }
      if (tasks.length > 3) {
        text += `\n  ${theme.fg("muted", "(Ctrl+O to expand)")}`;
      }
      return new Text(text, 0, 0);
    },
  });
  }
  registerMainTool();

  pi.registerTool({
    name: "trimegisto_harvest",
    label: "Trimegisto Harvest",
    description: "Instant, non-blocking snapshot of Trimegisto agents. Use this instead of sleep/polling when you need to integrate available results. Never waits for running agents.",
    promptSnippet: "Use trimegisto_harvest for immediate available results; never run sleep/poll loops waiting for agents.",
    parameters: Type.Object({
      includeOutput: Type.Optional(Type.Boolean({ description: "Include output previews (default true)" })),
      maxOutputChars: Type.Optional(Type.Number({ description: "Max chars per agent output preview (default 1200)" })),
    }),
    async execute(_toolCallId, params) {
      const includeOutput = params.includeOutput !== false;
      const maxOutputChars = Math.max(200, Math.min(8000, Math.floor(params.maxOutputChars || 1200)));
      const agents = Array.from(getAgents().values()).sort((a, b) => a.startedAt - b.startedAt);
      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No Trimegisto agents in this session." }], details: { agents: [] } };
      }

      const lines: string[] = ["## Trimegisto harvest (instant snapshot)", ""];

      // Redundancy metric: near-duplicate outputs detected across agents
      {
        const ls = loopSupervisor.getState();
        let totalDups = 0, totalWasted = 0;
        for (const t of ["active", "t1", "t2", "t3"] as const) {
          totalDups += ls.tiers[t].crossDuplicates;
          totalWasted += ls.tiers[t].wastedTokens;
        }
        if (totalDups > 0) {
          lines.push(`♻️ **Redundancy:** ${totalDups} near-duplicate output pair(s), ~${totalWasted} tokens overlapped.`, "");
        }
      }

      // Model-health: tell the coordinator which models are paused right now so
      // it does not try to respawn onto a known-broken provider.
      {
        const paused = modelHealth.list().filter(e => e.blockedUntil > Date.now());
        if (paused.length > 0) {
          const parts = paused.map(e => `${e.model} (~${Math.max(1, Math.ceil((e.blockedUntil - Date.now()) / 1000))}s)`);
          lines.push(`⛔ **Paused models:** ${parts.join(", ")}. Do not spawn on them; retry after the cooldown or switch via /tmg config.`, "");
        }
      }
      const details: any[] = [];
      for (const a of agents) {
        const elapsed = Math.round(((a.finishedAt || Date.now()) - a.startedAt) / 1000);
        const statusIcon = a.status === "done" ? "✅" : a.status === "running" || a.status === "waiting" ? "⏳" : "⚠️";
        lines.push(`### ${statusIcon} ${a.id} [${formatTierLabel(a.tier)}] — ${a.status} (${elapsed}s)`);
        lines.push(`Task: ${a.task.slice(0, 180)}`);
        if (includeOutput) {
          const out = a.output.trim();
          const err = a.stderr.trim();
          if (out) lines.push("", "```", out.slice(0, maxOutputChars), "```");
          else if (err) lines.push("", `Error/partial stderr: ${err.slice(0, Math.min(1000, maxOutputChars))}`);
          else lines.push("", "_(no output yet — do not wait idly; continue other work)_");
        }
        if (a.usage.turns > 0) lines.push(`*${a.usage.turns} turns, ↑${a.usage.input} ↓${a.usage.output}*`);
        lines.push("");
        details.push({ agentId: a.id, tier: a.tier, task: a.task, status: a.status, output: a.output, stderr: a.stderr, usage: a.usage, elapsedSeconds: elapsed });
      }
      const active = agents.filter(a => a.status === "running" || a.status === "waiting").length;
      lines.push(active > 0 ? `_${active} agent(s) still running; this harvest did not wait._` : "_All agents settled._");
      return { content: [{ type: "text", text: lines.join("\n") }], details: { agents: details } };
    },
  });

  // ── Suppress custom message headers via custom renderers ──
  const suppressHeader = (msg: any) => {
    const mdTheme = getMarkdownTheme();
    const text = typeof msg.content === "string" ? msg.content :
      (Array.isArray(msg.content) ? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "");
    const container = new Container();
    container.addChild(new Markdown(text, 0, 0, mdTheme));
    return container;
  };
  pi.registerMessageRenderer("trimegisto-log", suppressHeader);
  pi.registerMessageRenderer("trimegisto-results", suppressHeader);
  pi.registerMessageRenderer("trimegisto-harvest", suppressHeader);
  pi.registerMessageRenderer("trimegisto-command", suppressHeader);

  // TUI-only progress entries. These render in the transcript exactly like the
  // old log messages but never reach the model's conversation.
  const renderLogEntry = (entry: any): Container => {
    const mdTheme = getMarkdownTheme();
    const data: any = entry?.data ?? {};
    const text = typeof data === "string" ? data : String(data.text ?? data.markdown ?? "");
    const container = new Container();
    container.addChild(new Markdown(text, 0, 0, mdTheme));
    return container;
  };
  pi.registerEntryRenderer("trimegisto-log", renderLogEntry);

  // ── Register commands (lazy handlers) ───────────────────
  const commandRuntime = () => ({
    configs: { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
    // Lets /tmg guard show LIVE vs SAVED instead of making a divergence invisible.
    guardConfig: () => config.loopSupervisor,
    launchFn: doLaunch,
    cwd: process.cwd(),
    isEnabled: () => config.enabled,
    setEnabled: (v: boolean) => {
      config.enabled = v;
      if (v) {
        updateDashboard();
        try { if (ctxRef) ctxRef.ui.setStatus("trimegisto", formatTmgStatus(true)); } catch {}
      } else {
        haltAll();
        try {
          if (ctxRef) {
            ctxRef.ui.setFooter(undefined);
            ctxRef.ui.setWidget("trimegisto", undefined);
            ctxRef.ui.setWidget("trimegisto-compact", undefined);
            ctxRef.ui.setStatus("trimegisto", formatTmgStatus(false));
          }
        } catch {}
      }
      saveConfig();
    },
    haltAll,
    sendToAgent: (agentId: string, instruction: string) => sendToAgent(
      agentId,
      instruction,
      { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
      ctxRef?.cwd || process.cwd(),
      spawnModelOverride("active"),
      config.spawnOnlyOnActive,
      config.redundantAgents,
    ),
    toggleDashboard: (pi as any)._trimegistoToggleDashboard,
    openConfig: async (ctx: any) => {
      const { runConfigUI } = await import("./config-ui.ts");
      return runConfigUI(ctx, {
        config,
        dashboardMode,
        setDashboardMode: (mode) => { dashboardMode = mode; },
        activeModel,
        ctxRef,
        updateDashboard,
        haltAll,
        saveConfig,
        registerMainTool,
        syncLoopSupervisor: () => {
          // Push the whole guard config (turn limit included) and keep the
          // top-level dedupeCrossAgent flag in sync with the guard's copy.
          // IMPORTANT: mutate the existing object in place — the config UI holds
          // a reference to it across submenu edits; reassigning would orphan
          // later edits.
          if (!config.loopSupervisor) config.loopSupervisor = {};
          applyGuardConfig(loopSupervisor, foldDedupeFlagIntoGuard(config) ?? config.loopSupervisor);
        },
        syncWatchdog: applyWatchdogConfig,
        syncModelHealth: applyModelHealthConfig,
        clearModelHealth: (model?: string) => { modelHealth.clear(model); registerMainTool(); },
      });
    },
  });

  pi.registerCommand("tmg", {
    description: "Trimegisto control",
    getArgumentCompletions: (prefix: string) => {
      const first = prefix.trim().split(/\s+/)[0]?.toLowerCase() || "";
      const subs = ["config", "enable", "disable", "launch", "tell", "kill", "halt", "list", "switch", "dashboard", "locks", "guard", "loops", "reset-guard", "reset-loops", "models", "reset-models"];
      const items = subs.filter(s => s.startsWith(first)).map(s => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => (await import("./commands.ts")).handleTmgCommand(pi, args, ctx, commandRuntime()),
  });
  for (const tier of ["active", "t1", "t2", "t3"] as const) {
    const cmd = tier === "active" ? "t0" : tier;
    pi.registerCommand(cmd, {
      description: `Launch ${formatTierLabel(tier)} agent`,
      handler: async (args, ctx) => (await import("./commands.ts")).handleTierCommand(tier, cmd, args, ctx, commandRuntime()),
    });
  }
  pi.registerCommand("@", {
    description: "Send to Trimegisto agent",
    handler: async (args, ctx) => (await import("./commands.ts")).handleMentionCommand(args, ctx, commandRuntime()),
  });
  pi.registerShortcut("ctrl+alt+h", {
    description: "Trimegisto: halt agents",
    handler: async ctx => (await import("./commands.ts")).handleHaltShortcut(ctx, commandRuntime()),
  });

  // ── Session lifecycle ──────────────────────────────────
  // Keep the active model fresh when the user switches models mid-session
  // (e.g. /model). Without this, spawned "active" agents would use a stale model.
  pi.on("model_select", async (_event, ctx) => {
    try {
      activeModel = captureActiveModel(ctx);
      // Refresh the tool description so the coordinator sees the current model
      try { registerMainTool(); } catch { /* tool not registered yet */ }
    } catch { /* stale ctx */ }
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;

    // Track the active pi model so spawned agents can reuse it by default
    activeModel = captureActiveModel(ctx);

    // ── Instance isolation: create per-instance directory ──
    instanceId = generateInstanceId();
    const instDir = getInstanceDir();
    fs.mkdirSync(instDir, { recursive: true });
    setInstanceDir(instDir);
    cleanupOrphanedInstances();

    // Resolve the subagent extension path
    const subExtPath = findSubagentExtensionPath();
    setSubagentExtensionPath(subExtPath);

    // Restore config from dedicated config file first (survives sessions),
    // then merge with session entries as fallback.
    const saved = loadConfig();
    const entries = ctx.sessionManager.getEntries();
    const configEntry = entries
      .filter((e: any) => e.type === "custom" && e.customType === CONFIG_ENTRY)
      .pop() as any;

    // Dedicated file has priority; session entry is fallback
    const savedConfig = (saved || (configEntry?.data as Partial<TrimegistoConfig> | undefined)) as Partial<TrimegistoConfig> | undefined;

    if (savedConfig) {
      config = {
        active: buildTierConfig("active", ctx.cwd, savedConfig.active),
        t1: buildTierConfig("t1", ctx.cwd, savedConfig.t1),
        t2: buildTierConfig("t2", ctx.cwd, savedConfig.t2),
        t3: buildTierConfig("t3", ctx.cwd, savedConfig.t3),
        enabled: savedConfig.enabled ?? config.enabled,
        autoSpawn: savedConfig.autoSpawn ?? config.autoSpawn,
        useActiveModel: savedConfig.useActiveModel ?? config.useActiveModel,
        spawnOnlyOnActive: savedConfig.spawnOnlyOnActive ?? config.spawnOnlyOnActive,
        redundantAgents: savedConfig.redundantAgents ?? config.redundantAgents,
        dedupeTasks: savedConfig.dedupeTasks ?? config.dedupeTasks,
        dedupeCrossAgent: savedConfig.dedupeCrossAgent ?? config.dedupeCrossAgent,
        dashboardVisible: savedConfig.dashboardVisible ?? config.dashboardVisible,
        watchdog: {
          firstResponseSeconds: clampWatchdogSeconds(savedConfig.watchdog?.firstResponseSeconds ?? config.watchdog.firstResponseSeconds, WATCHDOG_DEFAULTS.firstResponseSeconds),
          idleSeconds: clampWatchdogSeconds(savedConfig.watchdog?.idleSeconds ?? config.watchdog.idleSeconds, WATCHDOG_DEFAULTS.idleSeconds),
          maxRuntimeSeconds: clampWatchdogSeconds(savedConfig.watchdog?.maxRuntimeSeconds ?? config.watchdog.maxRuntimeSeconds, WATCHDOG_DEFAULTS.maxRuntimeSeconds),
        },
        // Sanitize: legacy configs still carry removed loop-detection keys.
        loopSupervisor: sanitizeLoopSupervisorConfig(savedConfig.loopSupervisor as any, config.loopSupervisor),
        // Sanitize: clamp thresholds/cooldowns and fall back to defaults.
        modelHealth: sanitizeModelHealthConfig(savedConfig.modelHealth as any, config.modelHealth ?? MODEL_HEALTH_DEFAULTS),
      };

      // Apply watchdog timeouts (seconds → ms) to the agent manager
      applyWatchdogConfig();
      // Apply model-health circuit breaker settings.
      applyModelHealthConfig();

      // Migrate pre-v3 compaction thresholds: old built-in defaults forced
      // early compaction; reset them to 0 so pi's native setting decides.
      const migratedCompaction = migrateSavedCompaction(
        savedConfig as any,
        (savedConfig as any)._schemaVersion,
      );
      for (const tier of ["active", "t1", "t2", "t3"] as const) {
        const migrated = migratedCompaction[tier];
        if (migrated !== undefined) config[tier].compactionThreshold = migrated;
      }
      // Persist the migration once (bumps _schemaVersion) so a later manual
      // value equal to an old default is not reset on every load.
      if (Object.keys(migratedCompaction).length > 0) saveConfig();

      // Apply the swarm guard config through the SAME choke point the save path
      // uses: fold the top-level dedupe flag into the guard block, then push once.
      // This was two ordered pushes whose correctness depended on the bare
      // `{dedupeCrossAgent}` one running last — an ordering accident, not a
      // guarantee (ANGLE A of the guard QA: fragile-order dependency).
      applyGuardConfig(loopSupervisor, foldDedupeFlagIntoGuard(config) ?? config.loopSupervisor);
    }

    // If config was loaded from session entry but not yet in the file, sync it
    if (!saved && configEntry?.data) {
      saveConfig();
    }

    // Refresh the trimegisto tool description so the coordinator sees the
    // current tier availability (enabled/disabled, models loaded)
    try { registerMainTool(); } catch { /* tool not registered yet on first load */ }

    dashboardVisible = config.dashboardVisible;

    // Dashboard reactivity — uses callbacks, NOT footer replacement
    setStateChangeCallback(() => {
      // Safety net: a batch settles as soon as every agent is terminal, even if
      // no resolve callback ran (killed without a close event, watchers off).
      try { sweepBatches(); } catch { /* never break the host on a sweep error */ }
      if (ctx.hasUI && dashboardVisible) {
        // Widgets re-render on each tui.requestRender cycle
      }
    });

    // Streaming log callback for real-time agent updates in chat
    setAgentLogCallback((agentId: string, entry: AgentLogEntry) => {
      if (disposed || !config.enabled) return;

      // Get or create buffer for this agent
      let buf = logBuffers.get(agentId);
      if (!buf) {
        buf = { entries: [], timer: null };
        logBuffers.set(agentId, buf);
      }
      buf.entries.push(entry);

      // Flush aggressively for real-time verbosity (50ms debounce to coalesce same-tick bursts)
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(() => flushLogBuffer(agentId), 50);
    });

    if (config.enabled) {
      updateDashboard();
      ctx.ui.setStatus("trimegisto", formatTmgStatus(true));
    } else {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget("trimegisto", undefined);
      ctx.ui.setWidget("trimegisto-compact", undefined);
      ctx.ui.setStatus("trimegisto", formatTmgStatus(false));
    }
  });

  pi.on("session_shutdown", async () => {
    clearInterval(batchSweepInterval);
    // Flush any unsettled batch BEFORE disposed=true so a reload/kill still
    // produces a conclusion instead of leaving orphaned fragments.
    for (const batch of [...pendingBatches]) {
      try { settleBatch(batch, "session shutdown"); } catch { /* ignore */ }
    }
    disposed = true;
    // Stop late callbacks before pi invalidates this extension context on /reload.
    setAgentLogCallback(() => {});
    setStateChangeCallback(() => {});
    for (const buf of logBuffers.values()) {
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = null;
      buf.entries = [];
    }
    // Save config to dedicated file before shutdown. Do not append to the old
    // session after reload/session replacement.
    persistConfig(config);
    clearInterval(spawnPollInterval);
    clearInterval(dashboardRefreshInterval);
    clearInterval(speedRefreshInterval);
    stopAutoSpawnPolling();
    haltAll();
    ctxRef = null;

    // Clean up instance directory
    if (instanceId) {
      try { fs.rmSync(getInstanceDir(), { recursive: true, force: true }); } catch { /* ignore */ }
      instanceId = null;
    }
  });

  // ── Proactive compaction monitor ────────────────────────
  let compactionInProgress = false;
  let lastCompactionCheck = 0;
  const COMPACTION_COOLDOWN_MS = 60_000; // 1 min between checks

  function getEffectiveCompactionThreshold(): number {
    // Lowest enabled threshold across all tiers (active included, since the
    // main session runs the active model). 0 means every tier is off, so
    // Trimegisto never forces compaction and pi's native setting decides.
    return effectiveCompactionThreshold(config);
  }

  function maybeTriggerCompaction(ctx: ExtensionContext): void {
    if (!config.enabled) return;
    if (compactionInProgress) return;

    const now = Date.now();
    if (now - lastCompactionCheck < COMPACTION_COOLDOWN_MS) return;
    lastCompactionCheck = now;

    try {
      const usage = ctx.getContextUsage();
      if (!usage || !usage.tokens) return;

      // Get model context window (fallback to 200K if unknown)
      const contextWindow = (ctx.model as any)?.contextWindow ?? 200_000;
      const usagePercent = (usage.tokens / contextWindow) * 100;
      const threshold = getEffectiveCompactionThreshold();

      // 0 = disabled: let pi decide when to compact (native setting).
      if (threshold <= 0) return;

      if (usagePercent >= threshold) {
        compactionInProgress = true;
        ctx.compact({
          customInstructions: `Trimegisto compaction at ${usagePercent.toFixed(1)}% (threshold ${threshold}%). Keep recent tool outputs/file changes.`,
          onComplete: () => {
            compactionInProgress = false;
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Trimegisto: compaction done (${usagePercent.toFixed(0)}%/${threshold}%)`,
                "info",
              );
            }
          },
          onError: (err) => {
            compactionInProgress = false;
            console.error("[trimegisto] Proactive compaction failed:", err?.message || err);
          },
        });

        if (ctx.hasUI) {
          ctx.ui.notify(
            `Trimegisto: compacting (${usagePercent.toFixed(0)}% ≥ ${threshold}%)`,
            "info",
          );
        }
      }
    } catch {
      // Context usage check can fail; ignore silently
    }
  }

  // ── Provider diagnostics (opt-in, off by default) ─────────────────────────
  // The exact cause of the repeated `400 invalid_request_error` is still a
  // hypothesis because nobody has seen the rejected payload. Capturing every
  // request would be invasive, so this is a POST-MORTEM window instead: nothing
  // is written until a provider answers >= 400, and then the *next* requests are
  // recorded for a bounded period. `TRIMEGISTO_CAPTURE_PAYLOADS=1` forces it on.
  const CAPTURE_WINDOW_MS = 10 * 60_000;
  let captureUntil = 0;
  let providerDiagnostics: ProviderDiagnostics | null = null;
  const diagnostics = (): ProviderDiagnostics => {
    if (!providerDiagnostics) providerDiagnostics = new ProviderDiagnostics({ enabled: true });
    return providerDiagnostics;
  };
  const captureActive = (): boolean => diagnosticsEnabledFromEnv() || Date.now() <= captureUntil;

  // MUST NOT return a value: a returned payload would replace the real request.
  pi.on("before_provider_request", (event) => {
    if (disposed || !config.enabled || !captureActive()) return;
    try { diagnostics().recordRequest(event.payload); } catch { /* diagnostics never break a request */ }
  });

  pi.on("after_provider_response", (event) => {
    if (disposed || !config.enabled) return;
    try {
      if (event.status >= 400) {
        const wasArmed = Date.now() <= captureUntil;
        captureUntil = Date.now() + CAPTURE_WINDOW_MS;
        if (!wasArmed && !diagnosticsEnabledFromEnv()) {
          safeAppendEntry("trimegisto-log", {
            text: `📸 Provider answered **${event.status}** — capturing request payloads for 10 min so the next failure can be diagnosed (see the diagnostics file path in /tmg diagnostics).`,
          });
        }
      }
      if (captureActive()) diagnostics().recordResponse(event.status, event.headers);
    } catch { /* diagnostics never break a request */ }
  });

  // ── Context hygiene: keep Trimegisto noise out of the model request ──
  // Progress is now TUI-only, but a session can still carry old trimegisto-*
  // custom messages (reloaded sessions, earlier versions) plus one
  // orchestration directive per turn. Providers that validate message order or
  // size answer 400 invalid_request_error, so prune them before every call.
  // Non-custom messages are never touched (tool pairing is safe).
  pi.on("context", async (event) => {
    if (!config.enabled) return;
    const messages: any[] = event.messages as any[];
    if (!Array.isArray(messages) || messages.length === 0) return;
    const pruned = pruneContextMessages(messages, MAX_PROGRESS_MESSAGES);
    if (pruned !== messages) return { messages: pruned };
  });

  // ── Before agent start: inject trimegisto context ──────
  pi.on("before_agent_start", async (_event, ctx) => {
    // Check compaction proactively before the agent processes input
    maybeTriggerCompaction(ctx);

    if (!config.enabled) return;

    const activeAgents = getActiveAgents();
    const agentList = activeAgents.length > 0
      ? activeAgents
          .map(a => `- ${a.id} [${a.status}]: ${a.task.slice(0, 80)}`)
          .join("\n")
      : "- none";

    const availableTiers = (["active", "t1", "t2", "t3"] as const)
      .filter(tierAvailable)
      .map(t => t === "active" ? "active/t0" : t.toUpperCase())
      .join(", ") || "none";

    const proactivePolicy = config.autoSpawn
      ? [
          "TRIMEGISTO IS ACTIVE: you are operating in multi-agent mode.",
          "For every user request, first decide whether it has 2+ independent subtasks/files/areas/checks.",
          "If it is decomposable, your FIRST assistant action MUST be a `trimegisto` batch tool call that launches parallel agents; then do only coordination and synthesis while they run.",
          "Do NOT solve decomposable work entirely in the main agent before spawning. Use the main agent for orchestration, final integration, and genuinely single-threaded steps.",
          "Assign DISJOINT, non-overlapping subtasks so no two agents redo the same work. Never give two agents the same file or the same question.",
          "Draw the graph before spawning: pass a `goal` plus a one-line `why` per task, declare `needs` only for real data dependencies (those run in waves, not in parallel), and `writes` for known output files (same-file writers are serialised). A task that cannot state which part of the goal it serves should not be spawned.",
          "Prefer one agent per independent unit of work. If two proposed tasks would read the same inputs and produce overlapping answers, they are ONE task, not two. If a step is a mechanical transformation (parse, count, rename, format, diff), do it with bash yourself instead of paying a model for it. Work that cannot be undone (deletions, deploy, publish, migrations, production data, credentials) is refused: ask the user instead.",
          "Only spawn redundant 'scout' agents (same task, different angle) when you explicitly need verification/consensus — not by default.",
          "Skip spawning only when the task is trivial, a single indivisible/non-parallelizable step, or the user explicitly asks not to delegate.",
          "Assign DISJOINT, non-overlapping subtasks; never two agents on the same file/question. Only spawn redundant scouts when you need verification/consensus.",
          "After spawning, never run sleep/poll loops just to wait. Continue useful foreground work; Trimegisto injects ONE final reconciliation with every agent's conclusion when the batch settles — use it to write the unified final answer instead of re-spawning or answering early. Call `trimegisto_harvest` only for an explicit on-demand snapshot.",
        ].join("\n")
      : "Trimegisto is enabled but auto-spawn is OFF: delegate only when explicitly requested or clearly useful.";

    return {
      message: {
        customType: "trimegisto-context",
        content: `${proactivePolicy}\n\nAvailable tiers: ${availableTiers}. Prefer active/t0 for mass parallel work; T3 mechanical, T2 reasoning, T1 only hard planning.\nActive agents (${activeAgents.length}):\n${agentList}\n\nManual controls: /tmg config, /tmg list, /t0, /t1, /t2, /t3, @t2b <instruction>.`,
        display: false,
      },
    };
  });

  /** Total running/waiting agents across every tier, the active tier included. */
  function liveAgentCount(): number {
    const c = getAgentCounts();
    return c.active.running + c.active.waiting +
      c.t1.running + c.t1.waiting +
      c.t2.running + c.t2.waiting +
      c.t3.running + c.t3.waiting;
  }

  // ── Periodically refresh status bar ────────────────────
  const dashboardRefreshInterval = setInterval(() => {
    if (disposed || !config.enabled) return;
    try {
      speed.prune(); // drop long-idle targets from the telemetry map
      if (ctxRef?.hasUI) {
        const counts = getAgentCounts();
        const active = liveAgentCount();

        if (active > 0) {
          ctxRef.ui.setStatus("trimegisto", formatTmgStatus(true, `${active}↻`));
        } else {
          const total = counts.active.total + counts.t1.total + counts.t2.total + counts.t3.total;
          if (total > 0) {
            const done = counts.active.done + counts.t1.done + counts.t2.done + counts.t3.done;
            ctxRef.ui.setStatus("trimegisto", formatTmgStatus(true, `${done}✓`));
          } else {
            ctxRef.ui.setStatus("trimegisto", formatTmgStatus(true));
          }
        }
      }
    } catch { /* ctx stale after session reload */ }
  }, 3000);

  // ── Streaming speed ticker ─────────────────────────────
  // pi only redraws widgets when something invalidates the UI. A main session
  // waiting on sub-agents never does, so prefill/decode speeds would freeze at
  // whatever the last keystroke showed. Tick while anything is streaming.
  const speedRefreshInterval = setInterval(() => {
    if (disposed || !config.enabled) return;
    try {
      if (!ctxRef?.hasUI) return;
      if (liveAgentCount() === 0 && !speed.hasLiveActivity()) return;
      // dashboard.ts is lazy-loaded; Node caches it after the first import.
      import("./dashboard.ts")
        .then((m) => m.requestDashboardRender())
        .catch(() => { /* module or UI unavailable */ });
    } catch { /* ignore */ }
  }, 500);

  // ── Main session telemetry ─────────────────────────────
  // The main session talks to its provider just like the sub-agents do: the
  // same events carry its prefill/decode timings.
  pi.on("turn_start", () => {
    speed.startRequest(MAIN_TARGET);
  });

  pi.on("message_update", (event: any) => {
    if (event?.message?.role !== "assistant") return;
    const ev = event.assistantMessageEvent;
    if (!ev || (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta")) return;
    speed.noteDelta(MAIN_TARGET, typeof ev.delta === "string" ? ev.delta.length : 0);
    // Some providers already report usage while streaming; that beats estimating.
    if (event.message.usage?.output) speed.noteLiveUsage(MAIN_TARGET, event.message.usage.output);
  });

  pi.on("message_end", (event: any) => {
    const msg = event?.message;
    if (msg?.role !== "assistant" || !msg.usage) return;
    speed.endRequest(MAIN_TARGET, {
      input: msg.usage.input || 0,
      cacheRead: msg.usage.cacheRead || 0,
      cacheWrite: msg.usage.cacheWrite || 0,
      output: msg.usage.output || 0,
    });
  });

  // Nothing in flight any more: keep the last measurements, stop live phases.
  pi.on("agent_settled", () => {
    speed.finalize(MAIN_TARGET);
  });

  // ── Persist config ─────────────────────────────────────
  function saveConfig(): void {
    // Whatever was just edited must reach the LIVE guard as well. The config UI
    // and the supervisor are two views of the same settings, and a save whose
    // push was skipped leaves the guard running on a stale value — the reported
    // symptom being "the UI says turn limit OFF while agents are still killed at
    // the hard limit". Pushing the whole object on every save makes that
    // divergence impossible through the config path.
    // Single choke point: see applyGuardConfig's contract note. The top-level
    // dedupe flag is folded in first, otherwise saving an unrelated setting would
    // push a stale in-block value and silently turn cross-agent dedup off.
    applyGuardConfig(loopSupervisor, foldDedupeFlagIntoGuard(config));
    // Save to dedicated config file (survives session changes)
    persistConfig(config);
    if (disposed) return;
    // Also save as session entry for backup
    try {
      pi.appendEntry(CONFIG_ENTRY, {
        active: { model: config.active.model, tools: config.active.tools, extraArgs: config.active.extraArgs, systemPrompt: config.active.systemPrompt, maxParallel: config.active.maxParallel, compactionThreshold: config.active.compactionThreshold },
        t1: { model: config.t1.model, tools: config.t1.tools, extraArgs: config.t1.extraArgs, systemPrompt: config.t1.systemPrompt, maxParallel: config.t1.maxParallel, compactionThreshold: config.t1.compactionThreshold, redundantModels: config.t1.redundantModels ?? [] },
        t2: { model: config.t2.model, tools: config.t2.tools, extraArgs: config.t2.extraArgs, systemPrompt: config.t2.systemPrompt, maxParallel: config.t2.maxParallel, compactionThreshold: config.t2.compactionThreshold, redundantModels: config.t2.redundantModels ?? [] },
        t3: { model: config.t3.model, tools: config.t3.tools, extraArgs: config.t3.extraArgs, systemPrompt: config.t3.systemPrompt, maxParallel: config.t3.maxParallel, compactionThreshold: config.t3.compactionThreshold, redundantModels: config.t3.redundantModels ?? [] },
        enabled: config.enabled,
        autoSpawn: config.autoSpawn,
        useActiveModel: config.useActiveModel,
        spawnOnlyOnActive: config.spawnOnlyOnActive,
        redundantAgents: config.redundantAgents,
        dedupeTasks: config.dedupeTasks,
        dedupeCrossAgent: config.dedupeCrossAgent,
        dashboardVisible: config.dashboardVisible,
        watchdog: config.watchdog,
        loopSupervisor: config.loopSupervisor,
        modelHealth: config.modelHealth,
      });
    } catch {
      // Stale pi context after /reload/session replacement; file persistence above is enough.
    }
  }

}
