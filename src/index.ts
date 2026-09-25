/** Trimegisto: tiered parallel sub-agents for pi. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatTierStatusLine, formatDirectiveContent, formatSystemPolicyContent, formatUnavailableTiersMessage } from "./tier-status.ts";
import { formatDelegationContract, analyzeDecomposability, formatDecomposabilityNote, type CapacitySlot } from "./delegation.ts";
import { fileURLToPath } from "node:url";

import type { AgentTier, TrimegistoConfig, AgentLogEntry, AgentInstance, ReaperConfig } from "./types.ts";
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
  killAgent,
  getAgent,
  getAgentCounts,
  getActiveAgents,
  getAgents,
  canSpawnPooled,
  effectiveSpawnCapacity,
  getModelPool,
  selectAvailableModel,
  stopAutoSpawnPolling,
  setStateChangeCallback,
  setSubagentExtensionPath,
  setInstanceDir,
  setAgentLogCallback,
  processSpawnRequests,
  compactAgent,
  setLoopSupervisor,
  setWatchdogTimeouts,
  setReaperConfig,
  reapFinishedAgents,
  touchAgent,
  setModelHealth,
  getTierModelBlock,
  formatModelBlockMessage,
} from "./agent-manager.ts";
import { isDuplicateTask, registerTask, forgetTask } from "./task-dedup.ts";
import { saveConfig as persistConfig, loadConfig } from "./persistence.ts";
import { REAPER_DEFAULTS } from "./types.ts";
import { cleanupOldNotifications } from "./context-broker.ts";
import { reconcileBatch, decideBatchSettle, distillConclusion } from "./reconcile.ts";
import { runVerification, normalizeVerify, waveHasPendingVerification } from "./verify.ts";
import {
  initLedger, writeLedger, updateLedgerTask, setLedgerTaskAgent, writeLedgerNotes,
  pruneLedgers, DEFAULT_LEDGER_MAX_AGE_MS, type LedgerState,
} from "./ledger.ts";
import { readNotesSnapshot } from "./shared-context.ts";
import { planBatch, type PlanNode, type PlanTaskInput } from "./plan-graph.ts";
import { parseAgentCommand, writeAgentControl, type AgentCommand } from "./agent-control.ts";
import { advanceWaves } from "./wave-scheduler.ts";
import { LoopSupervisor, type LoopAlert } from "./loop-supervisor.ts";
import { ModelHealth, sanitizeModelHealthConfig, MODEL_HEALTH_DEFAULTS } from "./model-health.ts";
import { sanitizeReaperConfig } from "./config.ts";
import { speed, MAIN_TARGET } from "./speed.ts";
import { formatTmgStatus } from "./branding.ts";
import { ProgressLogBuffer } from "./progress-log.ts";

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
  description: "Blast radius. 'closed' = irreversible (deploy, migrate, drop, force-push, credentials) => REFUSED, ask the user. 'gated' = wide but reversible (shared utils, schema, public API, config). 'open' = contained (default).",
});

const TrimegistoTaskItem = Type.Object({
  tier: Type.Optional(TierEnum),
  task: Type.String({ description: "Task: one bounded unit, one input in, one output out." }),
  cwd: Type.Optional(Type.String({ description: "Agent cwd" })),
  needs: Type.Optional(Type.Array(Type.Number(), {
    description: "1-based indices of tasks in THIS call whose output this one consumes. Declare only real deps; no edge = parallel. e.g. [1,2].",
  })),
  why: Type.Optional(Type.String({
    description: "One line: which part of the goal this serves. Omit it and the task should not spawn.",
  })),
  writes: Type.Optional(Type.Array(Type.String(), {
    description: "Files this task writes. Same-file writers are serialised, not raced.",
  })),
  lane: Type.Optional(LaneEnum),
  verify: Type.Optional(Type.String({
    description: "Shell command that must exit 0 for this task to count as verified. Run by Trimegisto AFTER the worker finishes (not by the worker, so it cannot fake the verdict). A failure is reported as VERIFY FAILED and the agent's 'done' is not trusted. Opt-in, per task.",
  })),
  context: Type.Optional(StringEnum(["ledger", "fresh"] as const, {
    description: "Ambient context the worker starts with. 'ledger' (default) injects other agents' notes/read files; 'fresh' suppresses it so the worker gets an independent attempt. Explicit `needs` edges are injected either way.",
  })),
  diversity: Type.Optional(Type.Boolean({
    description: "Mark a deliberate parallel attempt (same question, different angle). Exempt from duplicate merging so a fresh twin runs alongside its ledger-aware counterpart. Cap: 3 per batch.",
  })),
  sequential: Type.Optional(Type.Boolean({
    description: "Run this task alone, awaited, on the ACTIVE/main model, even if the active tier is disabled or has no free slot; the coordinator blocks until it returns so it never runs concurrently with the principal.",
  })),
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

  /** Push reaper settings (seconds → ms) into the agent manager. */
  function applyReaperConfig(): void {
    const rp = config.reaper;
    setReaperConfig({
      enabled: rp?.enabled ?? REAPER_DEFAULTS.enabled,
      terminalIdleMs: clampWatchdogSeconds(rp?.terminalIdleSeconds ?? REAPER_DEFAULTS.terminalIdleSeconds, REAPER_DEFAULTS.terminalIdleSeconds) * 1000,
    });
  }
  applyReaperConfig();

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

  // Progress entries must not land in the transcript while the main session is
  // streaming: pi splices a new custom entry BEFORE the streaming assistant
  // component, and when that component is taller than the viewport every
  // splice forces TuiMainScreen into a full redraw that also clears the
  // scrollback — the "whole TUI re-scrolls on every update" symptom. Buffering
  // until the stream ends keeps every entry appended at the end of the
  // transcript, where the differential renderer only touches the new lines.
  const progressLog = new ProgressLogBuffer();
  function appendProgress(text: string): void {
    const ready = progressLog.push(text);
    if (!ready) return;
    // A buffer left over from a stream that just ended is released together
    // with this entry, so nothing is dropped and order is preserved.
    const deferred = progressLog.drain();
    safeAppendEntry("trimegisto-log", { text: deferred ? `${deferred}\n${ready}` : ready });
  }
  function flushDeferredProgress(): void {
    if (progressLog.isStreaming()) return;
    const text = progressLog.drain();
    if (text) safeAppendEntry("trimegisto-log", { text });
  }
  /**
   * Release buffered progress on the NEXT task. pi emits an event to
   * extensions BEFORE its own listeners run, and the interactive listener is
   * what drops the streaming component; flushing synchronously here would race
   * it and splice before the still-present component. A 0ms timer runs after
   * the whole event dispatch, when appending is back to end-of-transcript.
   */
  function scheduleFlushDeferredProgress(): void {
    const timer = setTimeout(() => { if (!disposed) flushDeferredProgress(); }, 0);
    (timer as any).unref?.();
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
    /**
     * agentId -> verify command for a task whose verification is still in
     * flight. The wave scheduler must treat such a wave as NOT terminal, or the
     * batch would settle (and inject an unverified verdict downstream) before
     * the command finishes. Entries are removed once the result is recorded.
     */
    verifyByAgent: Map<string, string>;
    /**
     * Per-batch on-disk ledger (plan.md / tasks.json / notes.md). A RECORD, not
     * a source of truth: null when it could not be created. Writes never throw.
     */
    ledger: LedgerState | null;
    ledgerDir: string | null;
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
      verification: a.verification,
    };
  }

  /**
   * Best-effort ledger update. The ledger is a RECORD, never a source of truth:
   * a filesystem failure must not affect the batch, so this never throws.
   */
  function ledgerMark(
    batch: PendingBatch,
    match: { agentId?: string; index?: number },
    patch: { status?: string; verdict?: string; verification?: any },
  ): void {
    if (!batch.ledger || !batch.ledgerDir) return;
    try {
      if (updateLedgerTask(batch.ledger, match, patch)) writeLedger(batch.ledgerDir, batch.ledger);
    } catch { /* the ledger must never break a batch */ }
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
      if (live) { touchAgent(id); return toRecon(live); }
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

    // ── Ledger finalization (best-effort): snapshot the published notes and
    // point the coordinator at the recorded plan/tasks. The ledger is a RECORD;
    // a filesystem failure must never block the conclusion. ──
    if (batch.ledger && batch.ledgerDir) {
      try {
        writeLedgerNotes(batch.ledgerDir, instanceId ? readNotesSnapshot(getInstanceDir()) : []);
        writeLedger(batch.ledgerDir, batch.ledger);
        markdown += `\n_Ledger: \`${batch.ledgerDir}\` (plan.md, tasks.json, notes.md)._\n`;
      } catch { /* never block the conclusion */ }
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
    // effectiveSpawnCapacity already excludes the main session from the ACTIVE
    // tier's budget (t0 = 1 is principal-only), so the planner and the tool's
    // feasibility gate never plan a wave the launcher must refuse.
    return effectiveSpawnCapacity(tier, config[tier].maxParallel, Math.max(1, getModelPool(config[tier], config.redundantAgents).length));
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
      if (source) touchAgent(agentId); // a live read keeps the reaper off it
      const verdict = source ? distillConclusion(toRecon(source), UPSTREAM_VERDICT_CHARS) : "(no result reported)";
      parts.push(`- upstream #${dep} ${agentId} [${source?.status ?? "unknown"}]: ${verdict}`);
    }
    if (parts.length === 0) return "";
    return `Upstream results from this Trimegisto batch (you depend on them — build on them, do not re-derive):\n${parts.join("\n")}\n\n`;
  }

  /** Every agent of the CURRENT wave reached a terminal state. */
  function waveFinished(batch: PendingBatch): boolean {
    if (batch.waveAgentIds.length === 0) return true;
    // A wave with a verification still in flight is NOT terminal: the verdict
    // must carry the verify outcome before the next wave (or the conclusion)
    // can see it. `notifyStateChange` fires before `resolve`, so without this
    // gate the batch would settle on the worker's own unverified `done`.
    if (waveHasPendingVerification(batch.waveAgentIds, batch.verifyByAgent)) return false;
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
      // A sequential node is a single awaited spawn: the enabled/capacity
      // gates do not apply to it (its own doLaunch path enforces its rules).
      if (node.sequential === true) continue;
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
      const sequential = node.sequential === true;
      const tier: AgentTier = sequential ? "active" : (spec?.tier as AgentTier) || "active";
      const taskText = spec?.task ?? node.task;
      const syntheticId = `#${node.index}-${node.task.slice(0, 24)}`;

      if (!tierHasModel(tier) && !sequential) {
        const agentId = `err-${tier}-${batch.agentIds.length + 1}`;
        batch.agentIds.push(agentId);
        batch.waveAgentIds.push(agentId);
        batch.launched.add(node.index);
        ledgerMark(batch, { index: node.index }, { status: "error", verdict: `no model configured for ${tier}` });
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
        let agent: AgentInstance;
        if (sequential) {
          // Sequential active: doLaunch forces the active tier and bypasses
          // the enabled/capacity gates for this single awaited spawn (the
          // model-health breaker is still enforced inside it).
          const launched = doLaunch("active", launchTaskText, spec?.cwd || batch.cwd, undefined, true, spec?.context === "fresh");
          if ("status" in launched && launched.status === "error") {
            throw new Error(launched.stderr);
          }
          agent = launched;
        } else {
          agent = launchAgent(tier, launchTaskText, config[tier], spec?.cwd || batch.cwd, undefined, taskModelOverride, config.redundantAgents, spec?.context === "fresh");
        }
        batch.agentIds.push(agent.id);
        batch.waveAgentIds.push(agent.id);
        batch.nodeAgent.set(node.index, agent.id);
        batch.launched.add(node.index);
        setLedgerTaskAgent(batch.ledger, node.index, agent.id);
        ledgerMark(batch, { index: node.index }, { status: "running" });
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
        // ── Per-task verification (opt-in) ──────────────────────────────
        // The EXTENSION, not the worker, runs the caller-supplied command, so a
        // confidently-wrong worker cannot report `done` and be believed. The id
        // is registered as verify-pending BEFORE resolve: `notifyStateChange`
        // fires synchronously before `resolve`, and `waveFinished` refuses to
        // settle a wave while this map holds one of its agents.
        const verifyCommand = normalizeVerify(spec?.verify)?.command;
        if (verifyCommand) batch.verifyByAgent.set(agent.id, verifyCommand);
        agent.resolve = (result) => {
          if (!verifyCommand) { recordResult(batch, { ...result, task: taskText }); return; }
          const settle = (verification: any): void => {
            batch.verifyByAgent.delete(result.agentId);
            recordResult(batch, { ...result, task: taskText, verification });
          };
          // Only a worker that itself succeeded is worth verifying. A failed or
          // killed worker keeps its own verdict; the gate is cleared so the wave
          // can settle.
          if (result.status !== "done") { settle(undefined); return; }
          // `runVerification` never rejects; the second handler is belt-and-braces
          // so a bug in it can never leave the wave gate stuck forever.
          void runVerification({ command: verifyCommand }, spec?.cwd || batch.cwd).then(settle, (err: any) =>
            settle({
              command: verifyCommand, ran: false, passed: false, exitCode: null, signal: null,
              timedOut: false, durationMs: 0, output: "", error: String(err?.message ?? err),
            }),
          );
        };
      } catch (err: any) {
        const agentId = syntheticId;
        // The task was registered just before launchAgent; a launch failure must
        // unregister it or the next legitimate retry is rejected as a duplicate.
        if (config.dedupeTasks) forgetTask(taskText);
        batch.agentIds.push(agentId);
        batch.waveAgentIds.push(agentId);
        batch.launched.add(node.index);
        ledgerMark(batch, { index: node.index }, { status: "error", verdict: `launch failed: ${err?.message || String(err)}` });
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
    // Mirror the settled task into the on-disk ledger (status, verify verdict,
    // bounded conclusion). Best-effort by construction.
    ledgerMark(batch, { agentId: result.agentId }, {
      status: result.status,
      verification: result.verification,
      verdict: distillConclusion(toRecon(result), 240),
    });
    // This runs inside agent-manager's child-process close callback
    // (`instance.resolve?.(buildResult())`), which has NO handler of its own: an
    // exception here would propagate into pi's process exit path and can take the
    // host down. No scheduling bookkeeping is worth crashing pi for — report it
    // and let the deadline sweep settle the batch.
    try {
      advanceBatch(batch);
    } catch (err: any) {
      appendProgress(`⚠️ Scheduler error while handling a result for ${batch.id}: ${err?.message || String(err)}`);
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
  // Also auto-reaps finished agents: once a terminal agent is no longer
  // referenced by any batch or watcher and has been idle long enough, its
  // memory/locks/context/telemetry are freed and it drops off the lists.
  const batchSweepInterval = setInterval(() => {
    if (disposed) return;
    try { sweepBatches(); } catch { /* never crash the session on a sweep */ }
    try {
      const reaped = reapFinishedAgents((a) => batchReferencesAgent(a.id));
      if (reaped.length > 0) {
        appendProgress(`🧹 [Trimegisto reaper] freed ${reaped.length} finished agent(s): ${reaped.join(", ")}`);
      }
    } catch { /* never crash the session on a sweep */ }
  }, 2000);
  (batchSweepInterval as any).unref?.();

  /**
   * True while a batch still needs the agent's identity or output: an
   * unsettled batch lists it among its agentIds. Settled batches already
   * captured every result (or an explicit placeholder), so they keep no
   * reference. Reaped agents must not lose their results out from under a
   * pending batch.
   */
  function batchReferencesAgent(agentId: string): boolean {
    return pendingBatches.some((b) => !b.settled && b.agentIds.includes(agentId));
  }

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
    appendProgress(`🚫 **[Trimegisto model health]** ${entry.model} paused after ${entry.failures} model-level failure(s) — ${entry.lastReason || "provider error"}. Spawns on it are refused for ~${secs}s. Switch model via /tmg config or clear with /tmg reset-models.`);
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
    appendProgress(`${emoji} **[Trimegisto ${label}]** ${alert.message}`);
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
    // Cycle through modes: compact -> widget -> off -> compact. Persist the FULL
    // mode (not just the boolean legacy field) and save so the choice survives
    // a restart; otherwise dashboardMode resets to the hardcoded default on the
    // next session and the cycle looks like it never happened.
    const modes: Array<"widget" | "compact" | "off"> = ["compact", "widget", "off"];
    const idx = modes.indexOf(dashboardMode);
    dashboardMode = modes[(idx + 1) % modes.length];
    config.dashboardMode = dashboardMode;
    config.dashboardVisible = dashboardMode !== "off";
    void updateDashboard();
    saveConfig();
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
      appendProgress(lines.join("\n"));
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
      // ponytail: removed setFooter(undefined) — stomps @narumitw/pi-statusline's footer on every 500ms render. Session-restore branches keep theirs (upstream intent); add back if dashboard needs native-footer reset.
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
  function doLaunch(tier: AgentTier, task: string, cwd: string, parentId?: string, sequential?: boolean, freshContext?: boolean): AgentInstance | { agentId: string; tier: AgentTier; task: string; status: "error"; output: string; stderr: string; usage: any; log: AgentLogEntry[] } {
    // Spawn-only-on-active: force all spawns onto the active tier (t0)
    if (config.spawnOnlyOnActive && tier !== "active") tier = "active";
    // Sequential active: ONE awaited spawn on the main model. The coordinator
    // blocks until it returns, so it never runs concurrently with the
    // principal — the `enabled` gate and the principal-slot capacity math
    // below do not apply to this path (the model-health breaker still does).
    if (sequential === true) tier = "active";
    const tierConfig = config[tier];

    if (!tierAvailable(tier) && sequential !== true) {
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

    // Zero-spawn tiers must refuse on EVERY path, including a manual @t0. With
    // the principal-slot semantics active.maxParallel = 1 means "principal
    // only": the main session already occupies the tier's only slot, so there
    // is nothing to launch. A positive maxParallel stays a soft cap a manual
    // spawn may exceed, exactly as before.
    const spawnCap = effectiveSpawnCapacity(
      tier,
      tierConfig.maxParallel,
      Math.max(1, getModelPool(tierConfig, config.redundantAgents).length),
    );
    if (spawnCap <= 0 && sequential !== true) {
      const reason = tier === "active"
        ? `maxParallel is ${tierConfig.maxParallel} and the main session occupies the only t0 slot`
        : `maxParallel is ${tierConfig.maxParallel}`;
      return {
        agentId: `error-${Date.now()}`,
        tier,
        task,
        status: "error" as const,
        output: "",
        stderr: `${formatTierLabel(tier)} cannot spawn: ${reason}. Raise it via /tmg config.`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        log: [] as AgentLogEntry[],
      };
    }

    // Pick the least-loaded model from the tier pool when redundant agents are ON
    let modelOverride = spawnModelOverride(tier);
    // A sequential spawn IS the active model by definition: force it even when
    // `useActiveModel` is off (that switch keeps the PARALLEL tiers on their own
    // models; it must not change what "the active model" means for an awaited
    // same-model spawn).
    if (sequential === true && tier === "active" && activeModel) modelOverride = activeModel;
    if (config.redundantAgents && tier !== "active") {
      const pool = getModelPool(tierConfig, true);
      const pick = selectAvailableModel(tier, pool, tierConfig.maxParallel);
      if (pick) modelOverride = pick;
    }

    return launchAgent(tier, task, tierConfig, cwd, parentId, modelOverride, config.redundantAgents, sequential === true && freshContext === true);
  }

  // ── @tier[letter] / /tier[letter] interception ─────────
  // ONE handler for both prefixes, parsed by the pure `parseAgentCommand`:
  //   @t2 <task>          -> spawn a new T2 agent (a bare tier has no target)
  //   @t2b <instruction>  -> STEER the running t2b (never kill/respawn it)
  //   @t2b halt           -> kill ONLY t2b
  //   @t2b compact        -> free t2b's context (restart with a progress digest)
  // The old code killed the target and launched a new agent for a steer, which
  // is the reported "it spawned a new agent instead of sending my instruction".
  function dispatchAgentTarget(cmd: AgentCommand, ctx: any): void {
    const targetId = cmd.agentId as string;

    if (cmd.verb === "halt") {
      const killed = killAgent(targetId);
      ctx.ui.notify(
        killed ? `Halted ${targetId}.` : `Agent ${targetId} not found or already stopped.`,
        killed ? "info" : "warning",
      );
      return;
    }

    const existing = getAgent(targetId);
    if (!existing) {
      ctx.ui.notify(`Agent ${targetId} not found. Spawn one with @${targetId.slice(0, 2)} <task>.`, "error");
      return;
    }

    if (existing.status !== "running" && existing.status !== "waiting") {
      ctx.ui.notify(
        `Agent ${targetId} is ${existing.status} — ${cmd.verb} only works while it runs. ` +
        `Launch a new one with @${targetId.slice(0, 2)} <task>.`,
        "warning",
      );
      return;
    }

    if (cmd.verb === "compact") {
      // pi's manual compaction aborts the one-shot process before it finishes,
      // so Trimegisto compacts by restarting the agent with a bounded digest of
      // its progress. See compactAgent() in agent-manager.ts.
      const replacement = compactAgent(
        targetId,
        { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
        ctx.cwd,
        config.spawnOnlyOnActive,
        config.redundantAgents,
      );
      ctx.ui.notify(
        replacement
          ? `Compacted ${targetId} → relaunched as ${replacement.id} with a condensed context.`
          : `Could not compact ${targetId}.`,
        replacement ? "info" : "error",
      );
      return;
    }

    // steer
    if (!instanceId) {
      ctx.ui.notify("Trimegisto: control channel unavailable (no instance directory).", "error");
      return;
    }
    const ok = writeAgentControl(getInstanceDir(), targetId, "steer", { text: cmd.text });
    ctx.ui.notify(
      ok ? `Steering ${targetId}: ${cmd.text.slice(0, 60)}` : `Could not reach ${targetId}.`,
      ok ? "info" : "error",
    );
  }

  pi.on("input", async (event, ctx) => {
    if (!config.enabled) return { action: "continue" as const };
    const cmd = parseAgentCommand(event.text);
    if (!cmd) return { action: "continue" as const };

    // Echo the command to chat so it stays visible.
    safeSendMessage({ customType: "trimegisto-command", content: cmd.raw, display: true });

    // Explicit agent id -> control an EXISTING agent (halt/compact/steer).
    if (cmd.agentId) {
      dispatchAgentTarget(cmd, ctx);
      return { action: "handled" as const };
    }

    // Bare tier -> spawn a new agent.
    if (cmd.tier !== "active" && !config[cmd.tier].model) {
      ctx.ui.notify(`No model configured for ${formatTierLabel(cmd.tier)}. Use /tmg config.`, "error");
      return { action: "handled" as const };
    }
    ctx.ui.notify(`Launching ${formatTierLabel(cmd.tier)} agent...`, "info");
    const agent = doLaunch(cmd.tier, cmd.text, ctx.cwd);
    if ("status" in agent && agent.status === "error") {
      ctx.ui.notify(`${(agent as any).agentId} failed: ${agent.stderr.slice(0, 100)}`, "error");
    } else {
      const a = agent as AgentInstance;
      ctx.ui.notify(`${a.id} [${formatTierLabel(cmd.tier)}] launched`, "info");
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
    // Bound ledger growth in a long-lived session (ledger dirs are also removed
    // with the instance on dispose; this only covers a session that runs for days).
    try { if (instanceId) pruneLedgers(getInstanceDir(), DEFAULT_LEDGER_MAX_AGE_MS); } catch { /* ignore */ }
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

  function tierStatusLine(tier: AgentTier, opts?: { includePaused?: boolean }): string {
    // The actual string assembly lives in src/tier-status.ts so the shape of
    // the message the model sees is unit-tested. This function is just the
    // adapter: resolve the live values, then hand them to the pure helper.
    const avail = tierAvailable(tier);
    const model = tier === "active"
      ? (activeModel || "no active model")
      : ((config as any)[tier]?.model || "no model") + redundantSuffix(tier);
    let reason = "";
    if (!avail) {
      if (tier === "active") reason = config.active.enabled ? " (no active model)" : " (disabled)";
      else if (config.spawnOnlyOnActive) reason = " (spawn-only-on-active)";
      else reason = ` (${(config as any)[tier]?.enabled === false ? "disabled" : "no model"})`;
    }
    // Surface an open circuit breaker so the coordinator does not try a model
    // that will be refused, and knows roughly when it comes back.
    const block = avail ? getTierModelBlock(tier, (config as any)[tier], config.redundantAgents, spawnModelOverride(tier)) : null;
    // The breaker countdown ticks every second, so it is a cache-killer in any
    // long-lived prompt. Callers that build stable text pass includePaused:false
    // and surface the breaker through the per-turn status block instead.
    const showPaused = opts?.includePaused !== false;
    const paused = showPaused && block ? Math.max(1, Math.ceil(block.remainingMs / 1000)) : null;
    // The ACTIVE tier shares its budget with the main session, so the
    // coordinator-facing cap is the SPAWNABLE count (t0 maxParallel - 1).
    // When that is 0 (active.maxParallel = 1) say so explicitly instead of
    // showing "max 1 parallel", which the coordinator would misread as one slot.
    const configured = (config as any)[tier]?.maxParallel;
    const spawnCap = tier === "active" ? tierCapacity("active") : configured;
    const principalOnly = tier === "active" && spawnCap === 0;
    const parallel = Number.isFinite(spawnCap) && spawnCap > 0 ? spawnCap : null;
    return formatTierStatusLine(formatTierLabel(tier), {
      enabled: avail,
      reason,
      model,
      pausedSeconds: paused,
      maxParallel: parallel,
      detail: principalOnly ? "principal only — no spawn slots" : "",
    });
  }

  function redundantSuffix(tier: string): string {
    if (!config.redundantAgents || tier === "active") return "";
    const rm = ((config as any)[tier]?.redundantModels as string[] | undefined) ?? [];
    return rm.length > 0 ? ` (+${rm.length} redundant)` : "";
  }

  /**
 * ONE source of truth for the coordinator rules, reused by the tool description
 * and by the per-turn policy so the same instruction is not stored twice.
 */
const RULE_DISJOINT = "Subtasks must be DISJOINT: never two agents on the same file or question.";
const RULE_SCOUTS = "Redundant scouts (same task, different angle) only when you need verification/consensus.";
const RULE_VERIFY = "Attach `verify` (a shell command that must exit 0) to any task whose success is checkable: Trimegisto runs it AFTER the worker, so a wrong `done` is reported as VERIFY FAILED. The worker never runs it.";
const RULE_FRESH = "For a risky/anchored plan, spawn a `diversity:true` twin with `context:\"fresh\"` (no shared notes) to get an independent attempt to compare against.";
const RULE_GRAPH = "Pass `goal`; per task: `why` (need it serves), `needs:[i]` ONLY for real data deps (those run in waves), `writes` for known files (same-file writers are serialised).";
const RULE_ONENEED = "A task that cannot name the need it serves, or that duplicates another task's inputs and answer, should not be spawned.";
const RULE_SERIAL = "Mechanical steps (parse, count, rename, format, diff) go in bash, not a model. Irreversible work (delete, deploy, publish, migrate, production data, credentials) is refused: ask the user.";
const RULE_SETTLE = "Trimegisto delivers ONE reconciliation when the batch settles: use it for the unified final answer; do not re-spawn or answer early.";
const RULE_NOWAIT = "Never sleep/poll waiting for agents; `trimegisto_harvest` only for an explicit snapshot.";

/**
 * The rule set the coordinator is taught, in the order it should read it.
 * Reused verbatim by the system-prompt policy so the rules exist once.
 */
const COORDINATOR_RULES: string[] = [
  RULE_DISJOINT,
  RULE_SCOUTS,
  RULE_GRAPH,
  RULE_VERIFY,
  RULE_FRESH,
  RULE_ONENEED,
  RULE_SERIAL,
  RULE_SETTLE,
  RULE_NOWAIT,
];

let contextPruneImport: Promise<typeof import("./context-prune.ts")> | null = null;
  const loadContextPrune = () => (contextPruneImport ??= import("./context-prune.ts"));

  function buildToolDescription(): string {
    return [
      "Launch parallel Trimegisto sub-agents.",
      "Default to delegating: for any request that splits into 2+ independent, disjoint units, your first action is one batch carrying them all — do not work serially first. Work solo only for provably atomic requests (one question, one small single-file change, one non-parallel command).",
      "Assign DISJOINT subtasks so no two agents redo the same work; scouts only for verification.",
      RULE_GRAPH,
      RULE_VERIFY,
      RULE_FRESH,
      RULE_SETTLE,
      "Tiers now:",
      tierStatusLine("active", { includePaused: false }),
      tierStatusLine("t1", { includePaused: false }),
      tierStatusLine("t2", { includePaused: false }),
      tierStatusLine("t3", { includePaused: false }),
      "Default active/t0 = main pi model; prefer several active agents for mass parallel work across DIFFERENT files/areas.",
      "Roles: active=t0 mass worker; t3 mechanical; t2 reasoning; t1 planning only.",
      "Only spawn ✓ ENABLED tiers; ✗ fails. IDs: t0a,t1a,t2b,t3c. Disabled tool returns error.",
    ].join("\n");
  }
  // ── Register the main Trimegisto tool ──────────────────
  function registerMainTool(): void {
  pi.registerTool({
    name: "trimegisto",
    label: "Trimegisto Multi-Agent",
    description: buildToolDescription(),
    promptSnippet: "Delegate by default: one batch for any request that splits; fill every ENABLED slot; never poll to wait.",
    parameters: Type.Object({
      tasks: Type.Array(TrimegistoTaskItem, {
        description: "Tasks (max 8). No `needs` edge = runs in parallel; declared deps run in waves.",
      }),
      goal: Type.Optional(Type.String({
        description: "Overall objective of the batch; the plan gate checks every task serves it.",
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

      // Sequential tasks run on the ACTIVE/main model by definition; force the
      // tier here so every downstream gate (plan, feasibility, availability)
      // sees the tier the launch will actually use. doLaunch re-forces it.
      for (const t of params.tasks) {
        if (t.sequential === true) t.tier = "active" as any;
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
        // A `diversity` task is an intentional parallel attempt: it must not be
        // rejected as an already-spawned duplicate. (In-batch twins are kept by
        // the plan gate's diversity exemption.) A `sequential` task is the
        // awaited verdict (e.g. adversarial QA re-checking recently spawned
        // work), so it must not be skipped as a near-duplicate of that work.
        if (config.dedupeTasks && t.diversity !== true && t.sequential !== true) {
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
          tier: typeof t.tier === "string" ? t.tier : undefined,
          lane: t.lane,
          cwd: t.cwd,
          verify: normalizeVerify(t.verify)?.command,
          context: t.context === "fresh" ? "fresh" : t.context === "ledger" ? "ledger" : undefined,
          diversity: t.diversity === true,
          sequential: t.sequential === true,
        } as PlanTaskInput;
      });

      // The planner must know each tier's REAL concurrency cap: planning a wave
      // wider than the config allows made the launcher refuse the whole batch.
      // `tierCapacity` is the same effective capacity the launch path enforces.
      const planCapacity: Record<string, number> = {
        active: tierCapacity("active"),
        t1: tierCapacity("t1"),
        t2: tierCapacity("t2"),
        t3: tierCapacity("t3"),
      };

      const planGoal = typeof params.goal === "string" && params.goal.trim() ? params.goal.trim() : undefined;
      const plan = planBatch(planInputs, {
        maxTasks: 8,
        tierCapacity: planCapacity,
        ...(planGoal ? { goal: planGoal } : {}),
      });
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
      if (plan.counts.duplicates > 0) planNotes.push(`⏭ Merged ${plan.counts.duplicates} in-batch duplicate(s).`);
      if (plan.counts.serialized > 0) planNotes.push(`🔗 Serialised ${plan.counts.serialized} same-file racer(s).`);
      if (plan.counts.capacityDeferred > 0) planNotes.push(`📐 Deferred ${plan.counts.capacityDeferred} node(s) to a later wave to respect the per-tier parallel cap.`);
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

      // Per-wave feasibility: defense-in-depth. The planner is capacity-aware
      // now and spreads an oversized wave across waves, so this should not fire
      // — it catches only a config change between planning and this point.
      // A wave larger than the tier capacity could never start (the scheduler
      // would defer it until the deadline), so refuse it with an actionable
      // message instead of hanging silently.
      for (let w = 0; w < plan.waves.length; w++) {
        const perTier: Record<string, number> = { active: 0, t1: 0, t2: 0, t3: 0 };
        for (const idx of plan.waves[w]) {
          const t = dedupedTasks[idx - 1];
          // A sequential node is a single awaited spawn that runs alone in its
          // own wave: the tier capacity does not apply to it.
          if (t?.sequential === true) continue;
          const tier = (t?.tier as AgentTier) || "active";
          perTier[tier] = (perTier[tier] || 0) + 1;
        }
        for (const tier of ["active", "t1", "t2", "t3"] as const) {
          const cap = tierCapacity(tier);
          if (perTier[tier] > cap) {
            // A 0-capacity ACTIVE tier means maxParallel = 1: the principal IS
            // the only t0 slot, so there is nothing to split — the fix is to
            // raise the cap, not to add `needs`.
            const principalOnly = tier === "active" && cap === 0;
            const advice = principalOnly
              ? `t0 is configured as principal-only (active.maxParallel = 1), so it cannot spawn. ` +
                `Raise active maxParallel to 2 or more via /tmg config, or spawn these tasks on another tier.`
              : `Split that wave with explicit \`needs\` so it runs in more waves, ` +
                `reduce the batch, or raise maxParallel via /tmg config.`;
            return {
              content: [{
                type: "text",
                text: `${plan.summary}\n\n❌ **No agents launched.** Wave ${w + 1} needs ${perTier[tier]} ${formatTierLabel(tier)} agent(s) ` +
                  `but the capacity is ${cap}. ${advice}` +
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
      // Sequential tasks are exempt: their whole point is to run on the active
      // model even when the active tier is disabled or principal-only.
      const unavailable = dedupedTasks.filter((t: any) => t.sequential !== true && !tierAvailable(t.tier));
      if (unavailable.length > 0) {
        const bad = [...new Set(unavailable.map((t: any) => t.tier))].join(", ");
        return {
          content: [{
            type: "text",
            // Same line format as the directive so a retry can read the cap
            // straight off the rejection message. Assembled by a pure helper
            // so the rejection shape is unit-tested.
            text: formatUnavailableTiersMessage(
              bad,
              (["active", "t1", "t2", "t3"] as const).filter(tierAvailable).map(t => tierStatusLine(t)),
            ),
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

      // ── Per-batch on-disk ledger (a record; never a source of truth) ──
      const batchId = `batch-${++batchSeq}`;
      const ledgerState: LedgerState | null = instanceId ? {
        version: 1,
        batchId,
        goal: planGoal,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tasks: plan.launch.map((n) => {
          const spec = taskByIndex.get(n.index);
          return {
            index: n.index,
            tier: (spec?.tier as string) || "active",
            task: String(spec?.task ?? n.task ?? ""),
            wave: n.wave,
            needs: Array.isArray(n.needs) && n.needs.length > 0 ? n.needs.slice() : undefined,
            verify: normalizeVerify(spec?.verify)?.command,
            status: "pending",
          };
        }),
      } : null;
      const batchLedgerDir = ledgerState ? initLedger(getInstanceDir(), ledgerState) : null;

      const batch: PendingBatch = {
        id: batchId,
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
        verifyByAgent: new Map(),
        ledger: ledgerState,
        ledgerDir: batchLedgerDir,
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
              `\n\n⏳ **Queued:** ${waves[0]?.length ?? 0} task(s) waiting for capacity; they launch when a slot frees and still yield ONE reconciliation. ` +
              `Do NOT re-call trimegisto for this work — a retry duplicates it.` +
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
              `\n\n⚠️ Batch settled with no runnable work; the reconciliation is already in chat.` +
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
            `\n\n🚀 **Wave 1/${waves.length} running: ${taskDetails.length}/${plan.launch.length} planned.**` +
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
    promptSnippet: "Instant agent snapshot; never poll waiting.",
    parameters: Type.Object({
      includeOutput: Type.Optional(Type.Boolean({ description: "Include output previews (default true)" })),
      maxOutputChars: Type.Optional(Type.Number({ description: "Max chars per agent output preview (default 1200)" })),
    }),
    async execute(_toolCallId, params) {
      const includeOutput = params.includeOutput !== false;
      const maxOutputChars = Math.max(200, Math.min(8000, Math.floor(params.maxOutputChars || 1200)));
      const agents = Array.from(getAgents().values()).sort((a, b) => a.startedAt - b.startedAt);
      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No agents this session." }], details: { agents: [] } };
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
    haltAgent: (agentId: string) => killAgent(agentId),
    steerAgent: (agentId: string, text: string) => {
      if (!instanceId) return false;
      return writeAgentControl(getInstanceDir(), agentId, "steer", { text });
    },
    compactAgent: (agentId: string) => compactAgent(
      agentId,
      { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
      ctxRef?.cwd || process.cwd(),
      config.spawnOnlyOnActive,
      config.redundantAgents,
    ),
    toggleDashboard: (pi as any)._trimegistoToggleDashboard,
    openConfig: async (ctx: any) => {
      const { runConfigUI } = await import("./config-ui.ts");
      return runConfigUI(ctx, {
        config,
        // Live getter on `dashboardMode` so the menu label "Dashboard: …" reads
        // the CURRENT value each time the menu is rendered, not the stale value
        // captured at the moment the runtime was built. Without this the label
        // freezes at the initial mode after the first cycle and the selector
        // looks broken.
        get dashboardMode() { return dashboardMode; },
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
        syncReaper: applyReaperConfig,
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
        // Restore the dashboard mode from saved config; legacy entries that
        // only kept the boolean get the matching mode. The closure variable is
        // separately synced in this session_start after the config merge below.
        dashboardMode: savedConfig.dashboardMode ?? (savedConfig.dashboardVisible === false ? "off" : "compact"),
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
        // Sanitize: clamp seconds and fall back to defaults (0 = instant reap).
        reaper: sanitizeReaperConfig(savedConfig.reaper as any, config.reaper),
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

    // Restore the dashboard mode from config; legacy saved configs that only
    // store dashboardVisible get a sensible mode derived from it (false -> off).
    dashboardMode = config.dashboardMode ?? (config.dashboardVisible === false ? "off" : "compact");
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
    // Release buffered progress before disposed=true: the streaming component is
    // gone on shutdown, so an append here is safe and nothing is lost.
    progressLog.setStreaming(false);
    flushDeferredProgress();
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
  let diagnosticsImport: Promise<typeof import("./diagnostics.ts")> | null = null;
  let providerDiagnostics: import("./diagnostics.ts").ProviderDiagnostics | null = null;
  /** Lazily loaded (the module pulls fs/os/path): pi awaits these handlers, so
   * awaiting here adds no turn latency beyond the first capture. */
  const diagnosticsModule = async () => (diagnosticsImport ??= import("./diagnostics.ts"));
  const ensureDiagnostics = async () => {
    const { ProviderDiagnostics } = await diagnosticsModule();
    return (providerDiagnostics ??= new ProviderDiagnostics({ enabled: true }));
  };
  const captureActive = async (): Promise<boolean> => {
    if (Date.now() <= captureUntil) return true;
    const { diagnosticsEnabledFromEnv } = await diagnosticsModule();
    return diagnosticsEnabledFromEnv();
  };

  // MUST NOT return a value: a returned payload would replace the real request.
  pi.on("before_provider_request", async (event) => {
    if (disposed || !config.enabled || !(await captureActive())) return;
    try { (await ensureDiagnostics()).recordRequest(event.payload); } catch { /* never break a request */ }
  });

  pi.on("after_provider_response", async (event) => {
    if (disposed || !config.enabled) return;
    try {
      if (event.status >= 400) {
        const wasArmed = Date.now() <= captureUntil;
        captureUntil = Date.now() + CAPTURE_WINDOW_MS;
        const { diagnosticsEnabledFromEnv } = await diagnosticsModule();
        if (!wasArmed && !diagnosticsEnabledFromEnv()) {
          appendProgress(`📸 Provider answered **${event.status}** — capturing request payloads for 10 min so the next failure can be diagnosed (see the diagnostics file path in /tmg diagnostics).`);
        }
      }
      if (Date.now() <= captureUntil) (await ensureDiagnostics()).recordResponse(event.status, event.headers);
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
    const { pruneContextMessages, MAX_PROGRESS_MESSAGES } = await loadContextPrune();
    const pruned = pruneContextMessages(messages, MAX_PROGRESS_MESSAGES);
    if (pruned !== messages) return { messages: pruned };
  });

  // ── Before agent start: policy → system prompt, live status → user channel ──
  //
  // Split deliberately. pi turns a `before_agent_start` custom message into a
  // plain role:"user" message with no origin marker (convertToLlm, messages.js),
  // so whatever is injected there competes with the user's own words — and it
  // lands AFTER them. Injecting the whole policy there produced a 31:1 ratio of
  // boilerplate to user text and made cautious models refuse the real request.
  // See the "directive framing" gotcha in pi.md.
  //
  // Now: stable policy is appended to the SYSTEM PROMPT (does not compete with
  // the user, keeps the provider cache prefix because it carries no live
  // counters), and the user channel carries only a short, explicitly framed
  // status block — nothing at all when the orchestrator is idle.

  /** Last status block injected, so an unchanged turn injects nothing. */
  let lastTurnStatus = "";

  /**
   * The delegation contract. The old wording was opt-in ("prefer delegating
   * them") and models read it as optional, leaving every configured slot
   * idle. The contract now inverts the default — delegate unless provably
   * atomic — and names the capacity to fill. It still avoids the hijack tone
   * ("your FIRST action MUST be") that made cautious models refuse.
   *
   * `decomposabilityNote` is the deterministic per-run reinforcement: when the
   * raw user prompt itself names several units, it is appended for that run.
   * The shared helper lives in src/delegation.ts so the text is unit-tested.
   */
  function computeCapacitySlots(): CapacitySlot[] {
    return (["active", "t1", "t2", "t3"] as const)
      .filter(t => tierAvailable(t))
      .map(t => ({ tier: formatTierLabel(t), slots: tierCapacity(t) }));
  }

  function buildSystemPolicy(event: any): string {
    const decomposabilityNote = formatDecomposabilityNote(
      analyzeDecomposability(typeof event?.prompt === "string" ? event.prompt : ""),
    );
    return formatSystemPolicyContent({
      proactivePolicy: formatDelegationContract({ autoSpawn: config.autoSpawn, capacity: computeCapacitySlots() }),
      rules: COORDINATOR_RULES,
      tierLines: (["active", "t1", "t2", "t3"] as const).map(t => tierStatusLine(t, { includePaused: false })),
      ...(decomposabilityNote ? { decomposabilityNote } : {}),
    });
  }

  pi.on("before_agent_start", async (event: any, ctx) => {
    // Check compaction proactively before the agent processes input
    maybeTriggerCompaction(ctx);

    if (!config.enabled) {
      // Forget the last injected block so re-enabling mid-session re-injects
      // instead of being suppressed by a stale identity match.
      lastTurnStatus = "";
      return;
    }

    const ALL_TIERS = ["active", "t1", "t2", "t3"] as const;

    // Stable policy → system prompt. Only moves when /tmg config changes, or
    // when the current prompt itself reads as decomposable (the note is the
    // tail of the block, so the provider's cached prefix survives).
    // Listing ALL tiers — not just available ones — lets the coordinator see
    // why a tier is unavailable (disabled vs no model) and its parallel cap.
    const systemPrompt = `${event?.systemPrompt ?? ""}\n\n${buildSystemPolicy(event)}`;

    // Live status → user channel, framed, only when there is something to say.
    const activeAgents = getActiveAgents();
    const agentList = activeAgents.length > 0
      ? activeAgents
          .map(a => `- ${a.id} [${a.status}]: ${a.task.slice(0, 80)}`)
          .join("\n")
      : "- none";
    const pausedTierLines = ALL_TIERS
      .map(t => tierStatusLine(t, { includePaused: true }))
      .filter(l => l.includes("⛔"));

    const status = formatDirectiveContent({
      activeAgentCount: activeAgents.length,
      activeAgentsFormatted: agentList,
      pausedTierLines,
    });

    // Idle, or identical to what we injected last turn: inject nothing. The
    // previous block is still in the transcript, so the model keeps the
    // information without paying for it again every turn.
    if (!status || status === lastTurnStatus) return { systemPrompt };
    lastTurnStatus = status;

    return {
      systemPrompt,
      message: {
        customType: "trimegisto-context",
        content: status,
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

  // An assistant message is about to stream into the transcript. pi renders
  // custom entries BEFORE this component, so from here until `message_end`
  // progress entries must be buffered instead of appended.
  pi.on("message_start", (event: any) => {
    if (event?.message?.role !== "assistant") return;
    progressLog.setStreaming(true);
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
    if (msg?.role !== "assistant") return;
    // The streaming component is consumed here: deferred progress can now be
    // appended at the end of the transcript without forcing a full redraw.
    progressLog.setStreaming(false);
    scheduleFlushDeferredProgress();
    if (!msg.usage) return;
    speed.endRequest(MAIN_TARGET, {
      input: msg.usage.input || 0,
      cacheRead: msg.usage.cacheRead || 0,
      cacheWrite: msg.usage.cacheWrite || 0,
      output: msg.usage.output || 0,
    });
  });

  // Nothing in flight any more: keep the last measurements, stop live phases,
  // and make sure no buffered progress is left behind by an interrupted stream.
  pi.on("agent_settled", () => {
    speed.finalize(MAIN_TARGET);
    progressLog.setStreaming(false);
    scheduleFlushDeferredProgress();
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
        reaper: config.reaper,
      });
    } catch {
      // Stale pi context after /reload/session replacement; file persistence above is enough.
    }
  }

}
