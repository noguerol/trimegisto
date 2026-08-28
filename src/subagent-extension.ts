/**
 * Trimegisto - Sub-agent Extension
 *
 * Loaded by sub-agent pi processes via --extension.
 * Registers the following tools for agents:
 *
 *   trimegisto_spawn  — Auto-spawning other agents (async, non-blocking)
 *   file_lock         — Acquire advisory lock before writing files
 *   file_unlock       — Release a file lock when done
 *   file_read_track   — Register a file read for context invalidation
 *
 * Additionally, polls for context-invalidation notifications
 * and spawn responses, injecting them as system messages when detected.
 *
 * KEY DESIGN: trimegisto_spawn is NON-BLOCKING. It writes spawn requests
 * and polls asynchronously for responses. Results are injected as system
 * messages so the agent can continue working while sub-agents run.
 *
 * The instance directory is passed via TRIMEGISTO_INSTANCE_DIR env var.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Per-instance IPC directory, set by the main extension via env var */
const INSTANCE_DIR = process.env.TRIMEGISTO_INSTANCE_DIR || path.join(
  process.env.HOME || "/home",
  ".pi/agent/trimegisto",
);

// ── Helpers ───────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeRequest(tier: string, task: string, parentId: string, cwd: string): string {
  const requestId = generateId();
  const request = { requestId, tier, task, parentId, cwd, timestamp: Date.now() };

  const requestsDir = path.join(INSTANCE_DIR, "requests");
  fs.mkdirSync(requestsDir, { recursive: true });

  const reqPath = path.join(requestsDir, `${requestId}.json`);
  fs.writeFileSync(reqPath, JSON.stringify(request), { encoding: "utf-8", mode: 0o600 });
  return requestId;
}

/**
 * Wait for a spawn response asynchronously (NON-BLOCKING).
 * Uses fs.promises + setTimeout polling instead of synchronous blocking.
 * This prevents freezing the sub-agent process during spawn-wait.
 */
async function waitForResponse(requestId: string, timeoutMs: number = 300_000): Promise<any> {
  const responsesDir = path.join(INSTANCE_DIR, "responses");
  const respPath = path.join(responsesDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const data = await fsp.readFile(respPath, "utf-8");
      const response = JSON.parse(data);
      // Clean up
      try { await fsp.unlink(respPath); } catch { /* ignore */ }
      try {
        const reqPath = path.join(INSTANCE_DIR, "requests", `${requestId}.json`);
        await fsp.unlink(reqPath);
      } catch { /* ignore */ }
      return response;
    } catch {
      // Not ready yet — wait 500ms asynchronously
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Timeout
  try {
    const reqPath = path.join(INSTANCE_DIR, "requests", `${requestId}.json`);
    await fsp.unlink(reqPath);
  } catch { /* ignore */ }

  return {
    requestId,
    result: {
      agentId: requestId,
      tier: "t3",
      task: "",
      status: "error",
      output: "",
      stderr: `Spawn request timed out after ${timeoutMs}ms. The spawned agent may still be running — check /tmg list.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    },
  };
}

/**
 * Poll for a response without blocking. Returns the response if ready, null otherwise.
 */
async function pollResponse(requestId: string): Promise<any | null> {
  const responsesDir = path.join(INSTANCE_DIR, "responses");
  const respPath = path.join(responsesDir, `${requestId}.json`);
  try {
    const data = await fsp.readFile(respPath, "utf-8");
    const response = JSON.parse(data);
    try { await fsp.unlink(respPath); } catch { /* ignore */ }
    try {
      const reqPath = path.join(INSTANCE_DIR, "requests", `${requestId}.json`);
      await fsp.unlink(reqPath);
    } catch { /* ignore */ }
    return response;
  } catch {
    return null;
  }
}

// ── File Lock helpers (mirrors file-lock.ts logic for sub-agent process) ──

interface LockInfo {
  lockId: string;
  agentId: string;
  filePath: string;
  operation: "write" | "edit" | "bash";
  timestamp: number;
  cwd: string;
}

function getLocksDir(): string {
  const dir = path.join(INSTANCE_DIR, "locks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
}

function acquireFileLock(
  agentId: string,
  filePath: string,
  operation: LockInfo["operation"],
  cwd: string,
): { acquired: boolean; lockId?: string; conflict?: { agentId: string; filePath: string } } {
  const absPath = resolvePath(filePath, cwd);
  const locksDir = getLocksDir();

  // Check existing locks
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(locksDir, { withFileTypes: true }); } catch { return { acquired: false }; }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.endsWith(".tmp")) continue;
    try {
      const data = fs.readFileSync(path.join(locksDir, entry.name), "utf-8");
      const lock = JSON.parse(data) as LockInfo;
      // Clean stale (>60s)
      if (now - lock.timestamp > 60_000) {
        try { fs.unlinkSync(path.join(locksDir, entry.name)); } catch { /* ignore */ }
        continue;
      }
      if (lock.filePath === absPath) {
        if (lock.agentId === agentId) {
          return { acquired: true, lockId: lock.lockId };
        }
        return {
          acquired: false,
          conflict: { agentId: lock.agentId, filePath: lock.filePath },
        };
      }
    } catch { /* corrupt */ }
  }

  // Create lock
  const lockId = `lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const lock: LockInfo = { lockId, agentId, filePath: absPath, operation, timestamp: now, cwd };
  const tmpPath = path.join(locksDir, `${lockId}.json.tmp`);
  const finalPath = path.join(locksDir, `${lockId}.json`);

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(lock), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
    return { acquired: true, lockId };
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { acquired: false };
  }
}

function releaseFileLock(lockId: string): boolean {
  const fPath = path.join(getLocksDir(), `${lockId}.json`);
  try {
    if (fs.existsSync(fPath)) {
      fs.unlinkSync(fPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Context tracking helpers ──────────────────────────────

function getNotificationsDir(): string {
  const dir = path.join(INSTANCE_DIR, "notifications");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function trackFileRead(agentId: string, filePath: string): void {
  const dir = getNotificationsDir();
  const registryFile = path.join(dir, `.readreg-${agentId}.json`);
  let files: string[] = [];
  try {
    if (fs.existsSync(registryFile)) {
      files = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
    }
  } catch { /* ignore */ }
  const absPath = path.resolve(filePath);
  if (!files.includes(absPath)) {
    files.push(absPath);
    if (files.length > 50) files = files.slice(-50);
    try {
      fs.writeFileSync(registryFile, JSON.stringify(files), { encoding: "utf-8", mode: 0o600 });
    } catch { /* ignore */ }
  }
}

function getReadFiles(agentId: string): Set<string> {
  const registryFile = path.join(getNotificationsDir(), `.readreg-${agentId}.json`);
  try {
    if (fs.existsSync(registryFile)) {
      const files = JSON.parse(fs.readFileSync(registryFile, "utf-8")) as string[];
      return new Set(files);
    }
  } catch { /* ignore */ }
  return new Set();
}

interface ContextAlert {
  alertId: string;
  filePath: string;
  modifiedBy: string;
  timestamp: number;
  message: string;
}

function pollContextAlerts(agentId: string): ContextAlert[] {
  const alerts: ContextAlert[] = [];
  const dir = getNotificationsDir();
  const watchedFiles = getReadFiles(agentId);

  if (watchedFiles.size === 0) return [];

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const processedFile = path.join(dir, `.processed-${agentId}`);
  let processed: string[] = [];
  try {
    if (fs.existsSync(processedFile)) {
      processed = JSON.parse(fs.readFileSync(processedFile, "utf-8"));
    }
  } catch { /* ignore */ }

  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    const fPath = path.join(dir, entry.name);
    try {
      const data = fs.readFileSync(fPath, "utf-8");
      const notif = JSON.parse(data);
      if (notif.modifiedBy === agentId) continue;
      if (processed.includes(notif.notificationId)) continue;
      const absNotifPath = path.resolve(notif.filePath);
      if (!watchedFiles.has(absNotifPath)) continue;

      alerts.push({
        alertId: notif.notificationId,
        filePath: notif.filePath,
        modifiedBy: notif.modifiedBy,
        timestamp: notif.timestamp,
        message: `⚠️ **Context Invalidation**: \`${path.basename(notif.filePath)}\` was modified by agent \`${notif.modifiedBy}\` (${notif.operation}). ` +
          `Your knowledge of this file may be stale — re-read it before making further changes.`,
      });
      processed.push(notif.notificationId);
    } catch { /* corrupt */ }
  }

  // Save processed IDs
  if (processed.length > 100) processed = processed.slice(-100);
  try {
    fs.writeFileSync(processedFile, JSON.stringify(processed), { encoding: "utf-8", mode: 0o600 });
  } catch { /* ignore */ }

  return alerts;
}

// ── Registered tools ──────────────────────────────────────

const TierEnum = StringEnum(["active", "t1", "t2", "t3"] as const, {
  description: "Type of agent to spawn. DEFAULT: 'active' (same model as main session). T2=solver, T3=worker, T1=deep thinking only.",
});

/** Single spawn task (kept for backward compatibility in arrays) */
const SpawnTaskItem = Type.Object({
  tier: Type.Optional(TierEnum),
  task: Type.String({ description: "Clear, specific task description for the agent to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
});

/** Legacy single-task params (kept for backward compatibility) */
const SpawnParams = Type.Object({
  tier: TierEnum,
  task: Type.String({ description: "Clear, specific task description for the agent to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory (defaults to current)" })),
});

/** Array-based spawn params (preferred — allows parallel spawning) */
const SpawnBatchParams = Type.Object({
  tasks: Type.Array(SpawnTaskItem, {
    description: "Array of tasks to spawn. Use this to launch multiple sub-agents in parallel.",
    minItems: 1,
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for all tasks (defaults to current)" })),
});

const LockOpEnum = StringEnum(["write", "edit", "bash"] as const, {
  description: "The type of file operation you are about to perform.",
});

const FileLockParams = Type.Object({
  file_path: Type.String({ description: "Path to the file you want to lock for writing" }),
  operation: LockOpEnum,
});

const FileUnlockParams = Type.Object({
  lock_id: Type.String({ description: "The lock ID returned by file_lock" }),
});

const FileReadTrackParams = Type.Object({
  file_path: Type.String({ description: "Path to the file you just read" }),
});

// ── Extension entry point ─────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Track files read by this agent for context invalidation
  const myReadFiles = new Set<string>();
  let myAgentId = "subagent"; // Will be overridden via env

  // Parse agent ID from env if available
  myAgentId = process.env.TRIMEGISTO_AGENT_ID || "subagent";

  // ── Tool: trimegisto_spawn ──────────────────────────────

  pi.registerTool({
    name: "trimegisto_spawn",
    label: "Trimegisto Spawn",
    description: [
      "Spawn one or more Trimegisto sub-agents to handle tasks. NON-BLOCKING: agents run in parallel.",
      "",
      "BY DEFAULT spawned agents use the ACTIVE pi model (tier 'active', useActiveModel=true),",
      "so parallel agents share the same local server and its speculative-decoding pool",
      "(ngram/MTP batching). Spawn as many 'active' agents as the task allows.",
      "",
      "PREFER BATCH MODE: pass {tasks: [{tier, task}, ...]} to spawn multiple agents at once.",
      "Single-task mode {tier, task} also works for backward compatibility.",
      "",
      "Tiers:",
      "- active (t0, DEFAULT): same model as the main session — mass parallel spawn.",
      "- t3: minor mechanical tasks, if t3 is configured.",
      "- t2: deeper reasoning tasks the active model can't handle, if t2 is configured.",
      "- t1: DEEP THINKING/planning ONLY (may be an expensive cloud model). Never for routine work.",
      "",
      "NOTE: If Trimegisto is disabled, this tool will return an error.",
    ].join("\n"),
    promptSnippet: "Spawn agents with the active model: trimegisto_spawn({tasks: [{tier:'active', task:'...'}, ...]})",
    parameters: SpawnBatchParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const parentId = myAgentId;

      // Normalize: support both batch {tasks: [...]} and legacy single {tier, task}
      let tasks: Array<{ tier: string; task: string; cwd: string }>;
      const defaultCwd = (params as any).cwd || ctx.cwd;

      if ("tasks" in params && Array.isArray((params as any).tasks)) {
        tasks = (params as any).tasks.map((t: any) => ({
          tier: t.tier || "active",
          task: t.task,
          cwd: t.cwd || defaultCwd,
        }));
      } else if ("tier" in params && "task" in params) {
        // Legacy single-task mode
        tasks = [{
          tier: (params as any).tier || "active",
          task: (params as any).task,
          cwd: (params as any).cwd || defaultCwd,
        }];
      } else {
        return {
          content: [{ type: "text", text: "Error: provide either {tasks: [{tier, task}]} (batch) or {tier, task} (single)." }],
          details: {},
          isError: true,
        };
      }

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No tasks provided." }],
          details: {},
        };
      }

      if (tasks.length > 8) {
        return {
          content: [{ type: "text", text: "Error: Too many tasks (max 8). Split into smaller batches." }],
          details: {},
          isError: true,
        };
      }

      if (!fs.existsSync(INSTANCE_DIR)) {
        return {
          content: [{
            type: "text",
            text: "Error: Trimegisto IPC directory not available. The parent Trimegisto instance may not be running or may be disabled. " +
              "Auto-spawning requires Trimegisto to be enabled (check with /tmg list). " +
              "Instance dir expected at: " + INSTANCE_DIR,
          }],
          details: { ipcDir: INSTANCE_DIR },
          isError: true,
        };
      }

      // Write ALL spawn requests first so they can be processed in parallel
      const requestIds: string[] = [];
      const taskDetailList: any[] = [];
      try {
        for (const task of tasks) {
          const requestId = writeRequest(task.tier, task.task, parentId, task.cwd);
          requestIds.push(requestId);
          taskDetailList.push({
            tier: task.tier,
            task: task.task.slice(0, 80),
            requestId,
          });
        }
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error writing spawn requests: ${err?.message || String(err)}` }],
          details: {},
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `⏳ Spawned ${tasks.length} sub-agent(s): ${tasks.map(t => t.tier + "('" + t.task.slice(0, 40) + "')").join(", ")}. Waiting for results...` }],
        details: { tasks: taskDetailList, status: "waiting" },
      });

      // Wait for ALL responses ASYNCHRONOUSLY (non-blocking — uses async polling, NOT synchronous sleep!)
      const results: any[] = [];
      const errors: string[] = [];
      const startTime = Date.now();
      const PER_REQUEST_TIMEOUT = 300_000; // 5 min per request

      try {
        for (const requestId of requestIds) {
          const elapsed = Date.now() - startTime;
          const remainingTimeout = Math.max(30_000, PER_REQUEST_TIMEOUT - elapsed);
          const response = await waitForResponse(requestId, remainingTimeout);

          if (!response || !response.result) {
            errors.push(`Request ${requestId}: no response (timeout after ${Math.round(elapsed / 1000)}s). The spawned agent may still be running.`);
            continue;
          }
          results.push(response.result);
        }
      } catch (err: any) {
        errors.push(`Spawn wait error: ${err?.message || String(err)}`);
      }

      // Build combined output
      const successCount = results.filter((r: any) => r.status === "done").length;
      const failCount = results.filter((r: any) => r.status === "error" || r.status === "killed").length;
      const timeoutCount = tasks.length - results.length - (errors.length > 0 ? errors.length : 0);

      if (results.length === 0 && errors.length > 0) {
        return {
          content: [{
            type: "text",
            text: `❌ All ${tasks.length} spawn request(s) failed:\n${errors.map((e: string) => `  - ${e}`).join("\n")}\n\nThis may happen if:\n- Trimegisto is disabled (check /tmg enable)\n- Max parallel limit reached for the target tier\n- The spawned agent process crashed\n- IPC directory permissions issue`,
          }],
          details: { errors },
          isError: true,
        };
      }

      let output = `## Spawn Results: ${successCount}/${tasks.length} succeeded`;
      if (failCount > 0) output += `, ${failCount} failed`;
      if (timeoutCount > 0) output += `, ${timeoutCount} timed out`;
      output += "\n\n";

      for (const r of results) {
        const icon = r.status === "done" ? "✓" : r.status === "killed" ? "⊘" : "✗";
        output += `### ${icon} **${r.agentId || "?"}** (${r.tier || "?"}) — ${(r.task || "").slice(0, 60)}\n`;

        if (r.output) {
          output += `\`\`\`\n${r.output.slice(0, 4000).trim()}\n\`\`\`\n`;
        } else if (r.stderr) {
          output += `❌ Error: ${r.stderr.slice(0, 1000)}\n`;
        } else {
          output += `_(no output)_\n`;
        }

        if (r.usage?.turns > 0) {
          output += `\n*${r.usage.turns} turns, ↑${r.usage.input} ↓${r.usage.output} tokens*\n`;
        }
        output += "\n---\n\n";
      }

      for (const err of errors) {
        output += `⚠️ ${err}\n\n`;
      }

      // Return isError only if ALL failed
      const allFailed = successCount === 0 && results.length > 0;

      return {
        content: [{ type: "text", text: output }],
        details: {
          tasks: taskDetailList,
          results,
          errors: errors.length > 0 ? errors : undefined,
        },
        isError: allFailed || undefined,
      };
    },
  });

  // ── Tool: file_lock ────────────────────────────────────

  pi.registerTool({
    name: "file_lock",
    label: "File Lock (Trimegisto)",
    description: [
      "Acquire an advisory lock on a file before modifying it.",
      "Use this BEFORE calling write or edit on any file to prevent",
      "concurrent modification conflicts with other Trimegisto agents.",
      "If the file is locked by another agent, this returns the conflict info.",
      "You should then wait and retry, or skip that file.",
      "",
      "IMPORTANT: Always call file_lock before write/edit when working",
      "alongside other Trimegisto agents. Call file_unlock when done.",
    ].join("\n"),
    promptSnippet: "Lock file before writing: file_lock(path, 'write')",
    parameters: FileLockParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = acquireFileLock(myAgentId, params.file_path, params.operation, ctx.cwd);

      if (result.acquired) {
        return {
          content: [{
            type: "text",
            text: `✓ Lock acquired on \`${params.file_path}\` (lock_id: \`${result.lockId}\`). You can now safely modify this file. Remember to call file_unlock when done.`,
          }],
          details: { lockId: result.lockId, filePath: params.file_path, operation: params.operation },
        };
      }

      return {
        content: [{
          type: "text",
          text: `⚠️ Cannot acquire lock on \`${params.file_path}\` — currently locked by agent \`${result.conflict?.agentId}\`. Wait for them to finish, or work on a different file.`,
        }],
        details: { conflict: result.conflict },
        isError: true,
      };
    },
  });

  // ── Tool: file_unlock ──────────────────────────────────

  pi.registerTool({
    name: "file_unlock",
    label: "File Unlock (Trimegisto)",
    description: [
      "Release a file lock previously acquired with file_lock.",
      "Call this after you're done writing/editing a file.",
    ].join("\n"),
    promptSnippet: "Unlock file after writing: file_unlock(lock_id)",
    parameters: FileUnlockParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const released = releaseFileLock(params.lock_id);
      return {
        content: [{
          type: "text",
          text: released
            ? `✓ Lock \`${params.lock_id}\` released.`
            : `⚠️ Lock \`${params.lock_id}\` not found or already released.`,
        }],
        details: { released },
      };
    },
  });

  // ── Tool: file_read_track ──────────────────────────────

  pi.registerTool({
    name: "file_read_track",
    label: "Track File Read (Trimegisto)",
    description: [
      "Register a file you've read for context invalidation tracking.",
      "If another agent modifies this file, you'll receive a notification",
      "that your context is stale and you should re-read the file.",
      "Call this after using the read tool on any file you'll reference later.",
      "",
      "This is optional but recommended for long-running tasks where",
      "other agents may modify shared files.",
    ].join("\n"),
    promptSnippet: "Track file for context invalidation: file_read_track(path)",
    parameters: FileReadTrackParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const absPath = path.resolve(params.file_path);
      myReadFiles.add(absPath);
      trackFileRead(myAgentId, params.file_path);
      return {
        content: [{
          type: "text",
          text: `✓ Now tracking \`${path.basename(params.file_path)}\` for context changes. You'll be alerted if another agent modifies it.`,
        }],
        details: { tracked: params.file_path, totalTracked: myReadFiles.size },
      };
    },
  });

  // ── Context Polling ────────────────────────────────────

  // Periodically check for context invalidation notifications
  // and inject them as system messages so the agent knows to re-read
  const pollInterval = setInterval(() => {
    try {
      const alerts = pollContextAlerts(myAgentId);
      for (const alert of alerts) {
        pi.sendMessage({
          customType: "trimegisto-alert",
          content: alert.message,
          display: false, // Injected as context, not shown to user
        });
      }
    } catch { /* silent */ }
  }, 5000);

  // Clean up on extension unload
  if (typeof pi.on === "function") {
    pi.on("shutdown", () => {
      clearInterval(pollInterval);
    });
  }
}
