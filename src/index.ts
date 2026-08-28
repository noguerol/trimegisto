/**
 * Trimegisto — Multi-Agent Orchestration for pi
 *
 * Three agent tiers:
 *
 *   T1 — Coordinator & planner, 1 instance
 *   T2 — Complex problem solver, up to 4 parallel
 *   T3 — Fast worker / heavy lifter, up to 4 parallel
 *
 * Agent IDs: t1a, t1b, t2a, t2b, t3a, t3c...
 *   t = trimegisto, number = tier, letter = instance
 *
 * Features:
 *   - Launch agents with specific tasks and tier-appropriate models
 *   - Compact status line (does NOT replace pi's native footer)
 *   - Verbose agent logs visible in chat (per-agent progress)
 *   - @mention syntax: @t2b do something → send instruction to agent
 *   - Kill individual agents or halt all at once
 *   - Auto-spawning: agents can launch other agents via trimegisto_spawn tool
 *   - Configurable models, prompts, and tools per tier
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, getKeybindings, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTier, TierConfig, TrimegistoConfig, AgentLogEntry, AgentInstance } from "./types.ts";
import {
  buildTierConfig,
  getDefaultConfig,
  formatTierLabel,
  parseAgentId,
} from "./config.ts";
import {
  launchAgent,
  killAgent,
  haltAll,
  getAgents,
  getAgent,
  getAgentCounts,
  getActiveAgents,
  canSpawnPooled,
  getModelPool,
  selectAvailableModel,
  startAutoSpawnPolling,
  stopAutoSpawnPolling,
  setStateChangeCallback,
  setSubagentExtensionPath,
  setInstanceDir,
  setAgentLogCallback,
  processSpawnRequests,
  sendToAgent,
  notifyFileChange,
  setLoopSupervisor,
  getLoopSupervisor,
} from "./agent-manager.ts";
import {
  createStatusLine,
  createDashboardWidget,
  createCompactWidget,
} from "./dashboard.ts";
import { registerCommands } from "./commands.ts";
import { saveConfig as persistConfig, loadConfig } from "./persistence.ts";
import { getActiveLocks } from "./file-lock.ts";
import { broadcastFileChange, cleanupOldNotifications } from "./context-broker.ts";
import { LoopSupervisor, DEFAULT_LOOP_CONFIG, type LoopSupervisorConfig, type LoopAlert } from "./loop-supervisor.ts";

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
  description: "Agent tier. DEFAULT: 'active' (same model as the main session, mass parallel). t2/t3: minor/adjacent tasks if configured. t1: deep thinking only (may be an expensive cloud model).",
});

const TrimegistoTaskItem = Type.Object({
  tier: Type.Optional(TierEnum),
  task: Type.String({ description: "Task description for this agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this agent" })),
});

export default function (pi: ExtensionAPI) {
  // ── Mutable state ──────────────────────────────────────
  let config: TrimegistoConfig = getDefaultConfig();
  let dashboardVisible = true;
  let dashboardMode: "widget" | "compact" | "off" = "compact";
  let ctxRef: ExtensionContext | null = null;
  let disposed = false;

  /**
   * Timers and child-process callbacks can fire after /reload has replaced the
   * extension context. pi correctly rejects calls through that stale API; never
   * let those late callbacks crash the host process.
   */
  function safeSendMessage(message: any): void {
    if (disposed) return;
    try {
      pi.sendMessage(message);
    } catch {
      // Stale pi context after /reload/session replacement; ignore late log.
    }
  }

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

  // ── Loop Supervisor ───────────────────────────────────
  const loopSupervisor = new LoopSupervisor();
  setLoopSupervisor(loopSupervisor);

  // Loop alert → chat notification
  loopSupervisor.setOnAlert((alert: LoopAlert) => {
    const emoji = alert.strike >= 3 ? "🚨" : alert.strike >= 2 ? "⚠️" : "🔸";
    safeSendMessage({
      customType: "trimegisto-log",
      content: `${emoji} **[Loop Supervisor]** ${alert.message} (strike ${alert.strike}/3)`,
      display: true,
    });
    try {
      if (ctxRef?.hasUI) {
        ctxRef.ui.notify(
          `Loop: ${alert.tier} strike ${alert.strike}/3 — ${alert.message.slice(0, 80)}`,
          alert.strike >= 3 ? "error" : "warning",
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
      safeSendMessage({
        customType: "trimegisto-log",
        content: lines.join("\n"),
        display: true,
      });
      // Force TUI re-render so messages appear immediately
      try {
        if (ctxRef?.hasUI) {
          ctxRef.ui.setStatus("trimegisto", `◇ Trimegisto: ${formatTierLabel(getAgent(agentId)?.tier || "?")} ${agentId} active`);
        }
      } catch { /* ctx stale after session reload */ }
    }
  }

  function flushAllLogBuffers() {
    for (const agentId of logBuffers.keys()) {
      flushLogBuffer(agentId);
    }
  }

  function updateDashboard(): void {
    try {
      if (!ctxRef?.hasUI) return;

      // NOTE: We do NOT replace pi's native footer.
      // Instead we use setWidget (above/below editor) and the status bar.

      if (dashboardMode === "compact") {
        ctxRef.ui.setFooter(undefined); // ensure we don't override native footer
        ctxRef.ui.setWidget("trimegisto", undefined);
        ctxRef.ui.setWidget("trimegisto-compact", createCompactWidget(ctxRef), { placement: "belowEditor" });
      } else if (dashboardMode === "widget") {
        ctxRef.ui.setFooter(undefined);
        ctxRef.ui.setWidget("trimegisto", createDashboardWidget(ctxRef));
        ctxRef.ui.setWidget("trimegisto-compact", undefined);
      } else {
        ctxRef.ui.setFooter(undefined);
        ctxRef.ui.setWidget("trimegisto", undefined);
        ctxRef.ui.setWidget("trimegisto-compact", undefined);
      }
    } catch { /* ctx stale after session reload */ }
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
        stderr: `Tier ${formatTierLabel(tier)} is not available (disabled or no model configured). Enable it or set a model via /tmg-config.`,
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
        stderr: `No model configured for ${formatTierLabel(tier)} tier. Use /tmg-config to set one.`,
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
      ctx.ui.notify(`No model configured for ${formatTierLabel(tier)}. Use /tmg-config.`, "error");
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
      ctx.ui.notify(`No model configured for ${formatTierLabel(tier)}. Use /tmg-config.`, "error");
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
    return `- ${label}: ${mark}${why} [${model}]`;
  }

  function redundantSuffix(tier: string): string {
    if (!config.redundantAgents || tier === "active") return "";
    const rm = ((config as any)[tier]?.redundantModels as string[] | undefined) ?? [];
    return rm.length > 0 ? ` (+${rm.length} redundant)` : "";
  }

  function buildToolDescription(): string {
    return [
      "Launch Trimegisto sub-agents to handle tasks in parallel.",
      "",
      "AVAILABLE TIERS RIGHT NOW:",
      tierStatusLine("active"),
      tierStatusLine("t1"),
      tierStatusLine("t2"),
      tierStatusLine("t3"),
      "",
      "DEFAULT: tier 'active' (t0) — the SAME model as the main session. Parallel",
      "active-agents hit the same local server and share its speculative-decoding",
      "pool (ngram/MTP batching). Prefer spawning several active agents on the",
      "SAME repo/task family so their code output feeds each other's drafts.",
      "",
      "Tier roles:",
      "- active (t0, DEFAULT): same model as pi — MASS PARALLEL spawn. Use for almost everything.",
      "- t3: minor mechanical tasks (parsing, formatting, translation) — only if listed ENABLED.",
      "- t2: deeper reasoning — only if listed ENABLED.",
      "- t1: DEEP THINKING / planning ONLY (expensive model) — only if listed ENABLED.",
      "",
      "⚠️ NEVER spawn a tier listed as ✗ unavailable — it will fail. Only use the ✓ ENABLED tiers.",
      "Each agent runs in isolation with its own context window. Agent IDs: t0a, t0b, t1a, t2b, t3c...",
      "",
      "NOTE: If Trimegisto is disabled, this tool will return an error.",
    ].join("\n");
  }

  // ── Register the main Trimegisto tool ──────────────────
  function registerMainTool(): void {
  pi.registerTool({
    name: "trimegisto",
    label: "Trimegisto Multi-Agent",
    description: buildToolDescription(),
    promptSnippet: "Launch Trimegisto sub-agents for parallel task execution. DEFAULT: tier 'active'. Only use tiers marked ENABLED in the description.",
    parameters: Type.Object({
      tasks: Type.Array(TrimegistoTaskItem, {
        description: "Array of tasks to execute. Max 8 total tasks across all tiers. Tier defaults to 'active'. Per-tier limits configurable (active: 4, T1: 1, T2: 4, T3: 4).",
      }),
      cwd: Type.Optional(Type.String({ description: "Working directory for all tasks" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "Trimegisto is currently disabled. Use /tmg enable to activate it." }],
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

      // Reject tiers that are disabled or have no model — the coordinator should
      // only spawn tiers listed as ENABLED in this tool's description.
      const unavailable = params.tasks.filter((t: any) => !tierAvailable(t.tier));
      if (unavailable.length > 0) {
        const bad = [...new Set(unavailable.map((t: any) => t.tier))].join(", ");
        return {
          content: [{
            type: "text",
            text: `❌ Cannot spawn tier(s): ${bad} — not available right now (disabled or no model configured).\nAvailable tiers: ${["active","t1","t2","t3"].filter(tierAvailable).join(", ")}.\nConfigure with /tmg-config.`,
          }],
          details: { unavailable: bad, available: ["active","t1","t2","t3"].filter(tierAvailable) },
          isError: true,
        };
      }

      // Check tier limits
      const taskCounts: Record<string, number> = { active: 0, t1: 0, t2: 0, t3: 0 };
      for (const t of params.tasks) {
        taskCounts[t.tier] = (taskCounts[t.tier] || 0) + 1;
      }

      // Check tier limits — with redundant agents ON, capacity is maxParallel × pool size
      const effectiveLimit = (tier: AgentTier): number =>
        config[tier].maxParallel * Math.max(1, getModelPool(config[tier], config.redundantAgents).length);

      for (const t of ["active", "t1", "t2", "t3"] as const) {
        if (taskCounts[t] > effectiveLimit(t)) {
          return {
            content: [{ type: "text", text: `Too many ${formatTierLabel(t)} tasks (max ${effectiveLimit(t)}).` }],
            details: { tasks: [] },
          };
        }
      }

      // Check existing running agents vs limits (pooled capacity when redundant agents are ON)
      for (const t of params.tasks) {
        if (!canSpawnPooled(t.tier, config[t.tier], config.redundantAgents)) {
          const poolSize = getModelPool(config[t.tier], config.redundantAgents).length;
          return {
            content: [{
              type: "text",
              text: `Cannot spawn ${formatTierLabel(t.tier)}: max parallel limit (${config[t.tier].maxParallel}/model × ${poolSize} model(s)) reached.`,
            }],
            details: { tasks: [] },
          };
        }
      }

      // Launch all agents in background — DO NOT BLOCK
      const launchedAgents: AgentInstance[] = [];
      const collectedResults: any[] = [];
      const taskDetails: any[] = [];
      let completedCount = 0;

      for (const task of params.tasks) {
        const tier = task.tier;
        if (!tierHasModel(tier)) {
          const errResult = {
            agentId: `err-${tier}`,
            tier,
            task: task.task,
            status: "error",
            output: "",
            stderr: `No model configured for ${formatTierLabel(tier)}.`,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            log: [{ ts: Date.now(), level: "error", text: `No model configured for ${formatTierLabel(tier)}` }],
          };
          collectedResults.push(errResult);
          taskDetails.push(errResult);
          completedCount++;
          continue;
        }

        // Pick the least-loaded model from the tier pool when redundant agents are ON
        let taskModelOverride = spawnModelOverride(tier);
        if (config.redundantAgents && tier !== "active") {
          const pool = getModelPool(config[tier], true);
          const pick = selectAvailableModel(tier, pool, config[tier].maxParallel);
          if (pick) taskModelOverride = pick;
        }

        const agent = launchAgent(tier, task.task, config[tier], task.cwd || cwd, undefined, taskModelOverride, config.redundantAgents);
        launchedAgents.push(agent);
        taskDetails.push({
          agentId: agent.id,
          tier: agent.tier,
          task: agent.task,
          status: agent.status,
        });

        // Set resolve callback to collect results and send summary when all done
        agent.resolve = (result) => {
          collectedResults.push(result);
          completedCount++;

          // When all agents complete, send summary as a chat message
          if (completedCount >= params.tasks.length) {
            const successCount = collectedResults.filter(r => r.status === "done").length;
            const failCount = collectedResults.filter(r => r.status === "error" || r.status === "killed").length;

            const summaryLines: string[] = [
              `## Trimegisto Results: ${successCount}/${collectedResults.length} succeeded, ${failCount} failed`,
              "",
            ];

            for (const r of collectedResults) {
              const icon = r.status === "done" ? "✓" : "✗";
              const label = r.agentId || "?";

              summaryLines.push(`### ${icon} **\`${label}\`** ${r.task.slice(0, 80)}`);
              summaryLines.push("");

              if (r.output) {
                const outputPreview = r.output.slice(0, 2000).trim();
                summaryLines.push(`\`\`\`\n${outputPreview}\n\`\`\``);
              } else if (r.stderr) {
                summaryLines.push(`❌ ${r.stderr.slice(0, 500)}`);
              }

              if (r.usage?.turns > 0) {
                summaryLines.push(`  *${r.usage.turns} turns, ↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}*`);
              }
              summaryLines.push("");
              summaryLines.push("---");
              summaryLines.push("");
            }

            safeSendMessage({
              customType: "trimegisto-results",
              content: summaryLines.join("\n"),
              display: true,
            });
          }
        };
      }

      // Return immediately — don't block pi
      const taskList = taskDetails.map(t =>
        `- **${t.agentId}** [${formatTierLabel(t.tier)}]: ${t.task.slice(0, 80)}`
      ).join("\n");

      return {
        content: [{
          type: "text",
          text: `🚀 Launched ${params.tasks.length} Trimegisto agent(s):\n${taskList}\n\nResults will appear in chat as each agent completes.`,
        }],
        details: { tasks: taskDetails },
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
  pi.registerMessageRenderer("trimegisto-command", suppressHeader);

  // ── Register commands ──────────────────────────────────
  registerCommands(
    pi,
    { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
    doLaunch,
    process.cwd(),
    {
      isEnabled: () => config.enabled,
      setEnabled: (v: boolean) => {
        config.enabled = v;
        if (v) {
          updateDashboard();
          try { if (ctxRef) ctxRef.ui.setStatus("trimegisto", "◇ Trimegisto active"); } catch { /* stale */ }
        } else {
          haltAll();
          try {
            if (ctxRef) {
              ctxRef.ui.setFooter(undefined);
              ctxRef.ui.setWidget("trimegisto", undefined);
              ctxRef.ui.setWidget("trimegisto-compact", undefined);
              ctxRef.ui.setStatus("trimegisto", "◇ Trimegisto disabled");
            }
          } catch { /* ctx stale after session reload */ }
        }
        saveConfig();
      },
      haltAll,
      sendToAgent: (agentId: string, instruction: string) => {
        return sendToAgent(
          agentId,
          instruction,
          { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
          ctxRef?.cwd || process.cwd(),
          spawnModelOverride("active"),
          config.spawnOnlyOnActive,
          config.redundantAgents,
        );
      },
    },
  );

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
        dashboardVisible: savedConfig.dashboardVisible ?? config.dashboardVisible,
        loopSupervisor: { ...config.loopSupervisor, ...(savedConfig.loopSupervisor || {}) },
      };

      // Apply loop supervisor config
      if (savedConfig.loopSupervisor) {
        loopSupervisor.updateConfig(savedConfig.loopSupervisor);
      }
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
      ctx.ui.setStatus("trimegisto", "◇ Trimegisto active");
    } else {
      ctx.ui.setFooter(undefined);
      ctx.ui.setWidget("trimegisto", undefined);
      ctx.ui.setWidget("trimegisto-compact", undefined);
      ctx.ui.setStatus("trimegisto", "◇ Trimegisto disabled");
    }
  });

  pi.on("session_shutdown", async () => {
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
    // Use the lowest (most aggressive) threshold among enabled tiers
    const thresholds = [
      config.t1.compactionThreshold,
      config.t2.compactionThreshold,
      config.t3.compactionThreshold,
    ];
    return Math.min(...thresholds);
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

      if (usagePercent >= threshold) {
        compactionInProgress = true;
        ctx.compact({
          customInstructions: `Trimegisto proactive compaction triggered at ${usagePercent.toFixed(1)}% context usage (threshold: ${threshold}%). Prioritize keeping recent tool outputs and file changes.`,
          onComplete: () => {
            compactionInProgress = false;
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Trimegisto: proactive compaction completed (was at ${usagePercent.toFixed(0)}%, threshold ${threshold}%)`,
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
            `Trimegisto: triggering proactive compaction (${usagePercent.toFixed(0)}% ≥ ${threshold}%)`,
            "info",
          );
        }
      }
    } catch {
      // Context usage check can fail; ignore silently
    }
  }

  // ── Before agent start: inject trimegisto context ──────
  pi.on("before_agent_start", async (_event, ctx) => {
    // Check compaction proactively before the agent processes input
    maybeTriggerCompaction(ctx);

    if (!config.enabled) return;

    const activeAgents = getActiveAgents();
    if (activeAgents.length === 0) return;

    const agentList = activeAgents
      .map(a => `- ${a.id} [${a.status}]: ${a.task.slice(0, 80)}`)
      .join("\n");

    return {
      message: {
        customType: "trimegisto-context",
        content: `[Trimegisto Active Agents: ${activeAgents.length}]\n${agentList}\n\n⚠️ COST OPTIMIZATION: You are the most expensive agent. Use the trimegisto tool to DELEGATE as much work as possible to cheaper T3 and T2 agents. Never do work yourself that a cheaper agent can handle. T3 = cheapest (use for all mechanical tasks), T2 = medium (use for reasoning T3 can't do), T1 = expensive (avoid unless truly needed for planning).\n\nUse /tmg for manual control. Use @t2b <instruction> to send instructions to a specific agent.`,
        display: false,
      },
    };
  });

  // ── Periodically refresh status bar ────────────────────
  const dashboardRefreshInterval = setInterval(() => {
    if (disposed || !config.enabled) return;
    try {
      if (ctxRef?.hasUI) {
        const counts = getAgentCounts();
        const active = counts.t1.running + counts.t1.waiting +
          counts.t2.running + counts.t2.waiting +
          counts.t3.running + counts.t3.waiting;

        if (active > 0) {
          ctxRef.ui.setStatus("trimegisto", `◇ Trimegisto: ${active} active`);
        } else {
          const total = counts.t1.total + counts.t2.total + counts.t3.total;
          if (total > 0) {
            const done = counts.t1.done + counts.t2.done + counts.t3.done;
            ctxRef.ui.setStatus("trimegisto", `◇ Trimegisto: ${done} completed`);
          } else {
            ctxRef.ui.setStatus("trimegisto", "◇ Trimegisto");
          }
        }
      }
    } catch { /* ctx stale after session reload */ }
  }, 3000);

  // ── Persist config ─────────────────────────────────────
  function saveConfig(): void {
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
        dashboardVisible: config.dashboardVisible,
        loopSupervisor: config.loopSupervisor,
      });
    } catch {
      // Stale pi context after /reload/session replacement; file persistence above is enough.
    }
  }

  // ── Configuration command ──────────────────────────────
  pi.registerCommand("tmg-config", {
    description: "Configure Trimegisto agent models and settings",
    handler: async (_args, ctx) => {
      const models = await ctx.modelRegistry.getAvailable();
      const modelList = models.map(m => `${m.provider}/${m.id} — ${m.name || m.id}`);

      // Scrollable model picker — returns "provider/id" or undefined
      const pickModel = async (title: string): Promise<string | undefined> => {
        if (modelList.length === 0) {
          ctx.ui.notify("No models available. Configure API keys first.", "error");
          return undefined;
        }
        const choice = await ctx.ui.custom<string | undefined>(
          (tui, theme, keybindings, done) => {
            const maxVisible = 10;
            const items: string[] = modelList;
            let selectedIndex = 0;

            const listContainer = new Container();

            const render = () => {
              listContainer.clear();
              const len = items.length;
              const start = Math.max(0, Math.min(
                selectedIndex - Math.floor(maxVisible / 2),
                len - maxVisible
              ));
              const end = Math.min(start + maxVisible, len);

              for (let i = start; i < end; i++) {
                const isSelected = i === selectedIndex;
                listContainer.addChild(new Text(
                  isSelected
                    ? theme.fg("accent", `→ ${items[i]}`)
                    : `  ${items[i]}`,
                  1, 0
                ));
              }

              if (start > 0 || end < len) {
                listContainer.addChild(new Spacer(1));
                listContainer.addChild(new Text(
                  theme.fg("muted", `  (${selectedIndex + 1}/${len})`),
                  1, 0
                ));
              }
            };

            const root = new Container();
            root.addChild(new Spacer(1));
            root.addChild(new Text(
              theme.fg("accent", theme.bold(title)),
              1, 0
            ));
            root.addChild(new Spacer(1));
            root.addChild(listContainer);
            root.addChild(new Spacer(1));
            root.addChild(new Text(
              theme.fg("muted", `  ↑↓ scroll  Enter select  Esc cancel  (${items.length} models)`),
              1, 0
            ));

            render();

            (root as any).handleInput = (keyData: string) => {
              const kb = getKeybindings();
              if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
                selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
                render();
              } else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
                selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
                render();
              } else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
                if (items[selectedIndex]) done(items[selectedIndex]);
              } else if (kb.matches(keyData, "tui.select.cancel")) {
                done(undefined);
              }
            };

            return root;
          },
        );
        return choice ? choice.split(" — ")[0].trim() : undefined;
      };

      const tier = await ctx.ui.select("Select tier to configure:", [
        `Active (t0, same model as pi): ${config.active.enabled ? "ENABLED" : "DISABLED"} | max:${config.active.maxParallel} | compact@${config.active.compactionThreshold}%`,
        `T1 (deep thinking): ${config.t1.enabled ? "ENABLED" : "DISABLED"} | ${config.t1.model || "(not set)"} | max:${config.t1.maxParallel} | compact@${config.t1.compactionThreshold}%`,
        `T2 (solver): ${config.t2.enabled ? "ENABLED" : "DISABLED"} | ${config.t2.model || "(not set)"} | max:${config.t2.maxParallel} | compact@${config.t2.compactionThreshold}%`,
        `T3 (worker): ${config.t3.enabled ? "ENABLED" : "DISABLED"} | ${config.t3.model || "(not set)"} | max:${config.t3.maxParallel} | compact@${config.t3.compactionThreshold}%`,
        "Enabled: " + (config.enabled ? "ON" : "OFF"),
        "Auto-spawn: " + (config.autoSpawn ? "ON" : "OFF"),
        "Active model for agents: " + (config.useActiveModel ? "ON (same as pi)" : "OFF (per-tier models)"),
        "Spawn only on active (t0): " + (config.spawnOnlyOnActive ? "ON" : "OFF"),
        "Redundant agents: " + (config.redundantAgents ? "YES" : "NO"),
        "Dashboard: " + dashboardMode,
        "Done",
      ]);

      if (!tier || tier === "Done") return;

      if (tier.startsWith("Active model for agents")) {
        config.useActiveModel = !config.useActiveModel;
        ctx.ui.notify(
          `Trimegisto: agents will use ${config.useActiveModel ? `the ACTIVE model (${activeModel || "?"})` : "per-tier configured models"}`,
          "info",
        );
        saveConfig();
        registerMainTool();
        return;
      }

      if (tier.startsWith("Spawn only on active")) {
        config.spawnOnlyOnActive = !config.spawnOnlyOnActive;
        ctx.ui.notify(
          config.spawnOnlyOnActive
            ? "Spawn only on active: ON — all agents will spawn on t0 (the pi active model)"
            : "Spawn only on active: OFF — tiers t1/t2/t3 spawn with their configured models",
          "info",
        );
        saveConfig();
        registerMainTool(); // refresh tool description so the coordinator sees the new availability
        return;
      }

      if (tier.startsWith("Enabled")) {
        config.enabled = !config.enabled;
        ctx.ui.notify(`Trimegisto: ${config.enabled ? "ENABLED" : "DISABLED"}`, config.enabled ? "info" : "warning");
        registerMainTool();
        if (config.enabled) {
          updateDashboard();
          try { if (ctxRef) ctxRef.ui.setStatus("trimegisto", "◇ Trimegisto active"); } catch { /* stale */ }
        } else {
          haltAll();
          try {
            if (ctxRef) {
              ctxRef.ui.setFooter(undefined);
              ctxRef.ui.setWidget("trimegisto", undefined);
              ctxRef.ui.setWidget("trimegisto-compact", undefined);
              ctxRef.ui.setStatus("trimegisto", "◇ Trimegisto disabled");
            }
          } catch { /* ctx stale after session reload */ }
        }
        saveConfig();
        return;
      }

      if (tier.startsWith("Auto-spawn")) {
        config.autoSpawn = !config.autoSpawn;
        ctx.ui.notify(`Auto-spawn: ${config.autoSpawn ? "ON" : "OFF"}`, "info");
        saveConfig();
        return;
      }

      if (tier.startsWith("Redundant agents")) {
        config.redundantAgents = !config.redundantAgents;
        ctx.ui.notify(
          config.redundantAgents
            ? "Redundant agents: YES — t1/t2 spawn on the least-loaded model of their pool and fail over on provider errors"
            : "Redundant agents: NO — t1/t2 spawn only on their primary model",
          "info",
        );
        saveConfig();
        registerMainTool(); // refresh tool description (redundant model counts)
        return;
      }

      if (tier.startsWith("Dashboard")) {
        const modes: Array<"widget" | "compact" | "off"> = ["compact", "widget", "off"];
        const idx = modes.indexOf(dashboardMode);
        dashboardMode = modes[(idx + 1) % modes.length];
        config.dashboardVisible = dashboardMode !== "off";
        updateDashboard();
        ctx.ui.notify(`Dashboard: ${dashboardMode}`, "info");
        saveConfig();
        return;
      }

      // Tier model selection
      const tierKey = tier.startsWith("Active")
        ? "active"
        : tier.startsWith("T1") ? "t1" : tier.startsWith("T2") ? "t2" : "t3";

      const subOptions = [
        `Enabled: ${config[tierKey].enabled ? "ON" : "OFF"}`,
        `Model: ${config[tierKey].model || "(not set)"}`,
        ...((tierKey === "t1" || tierKey === "t2")
          ? [`Redundant models: ${(config[tierKey].redundantModels ?? []).length} configured`]
          : []),
        `Max Parallel: ${config[tierKey].maxParallel}`,
        `Compaction Threshold: ${config[tierKey].compactionThreshold}%`,
        "Back",
      ];

      // Sub-menu: what to configure for this tier
      const subAction = await ctx.ui.select(
        `Configure ${formatTierLabel(tierKey)}:`,
        subOptions,
      );

      if (!subAction || subAction === "Back") return;

      if (subAction.startsWith("Enabled")) {
        config[tierKey].enabled = !config[tierKey].enabled;
        ctx.ui.notify(`${formatTierLabel(tierKey)}: ${config[tierKey].enabled ? "ENABLED" : "DISABLED"}`, "info");
        saveConfig();
        registerMainTool(); // refresh tool description so the coordinator sees the new availability
        return;
      }

      if (subAction.startsWith("Model")) {
        const providerId = await pickModel(`Select model for ${formatTierLabel(tierKey)}:`);
        if (providerId) {
          config[tierKey].model = providerId;
          ctx.ui.notify(`${formatTierLabel(tierKey)} model: ${providerId}`, "info");
          saveConfig();
        }
      } else if (subAction.startsWith("Redundant models")) {
        const rm = config[tierKey].redundantModels ?? (config[tierKey].redundantModels = []);
        const rmChoice = await ctx.ui.select(
          `Redundant models for ${formatTierLabel(tierKey)} (pool for load-balancing + failover when "Redundant agents" is YES):`,
          [
            ...rm.map(m => `\u2715 Remove: ${m}`),
            "\uFF0B Add model...",
            "Back",
          ],
        );
        if (!rmChoice || rmChoice === "Back") return;

        if (rmChoice === "\uFF0B Add model...") {
          const providerId = await pickModel(`Add redundant model for ${formatTierLabel(tierKey)}:`);
          if (providerId) {
            if (providerId === config[tierKey].model || rm.includes(providerId)) {
              ctx.ui.notify(`${providerId} is already in the ${formatTierLabel(tierKey)} pool`, "warning");
            } else {
              rm.push(providerId);
              ctx.ui.notify(`${formatTierLabel(tierKey)} redundant model added: ${providerId} (${rm.length} total)`, "info");
              saveConfig();
              registerMainTool(); // refresh tool description (redundant counts)
            }
          }
        } else if (rmChoice.startsWith("\u2715 Remove: ")) {
          const m = rmChoice.slice("\u2715 Remove: ".length);
          config[tierKey].redundantModels = rm.filter(x => x !== m);
          ctx.ui.notify(`${formatTierLabel(tierKey)} redundant model removed: ${m}`, "info");
          saveConfig();
          registerMainTool();
        }
        return;
      } else if (subAction.startsWith("Max Parallel")) {
        const value = await ctx.ui.select(
          `Max parallel agents for ${formatTierLabel(tierKey)} (currently: ${config[tierKey].maxParallel}):`,
          ["1", "2", "3", "4", "5", "6", "7", "8"],
        );
        if (value) {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 1 && num <= 8) {
            config[tierKey].maxParallel = num;
            ctx.ui.notify(`${formatTierLabel(tierKey)} max parallel: ${num}`, "info");
            saveConfig();
          }
        }
      } else if (subAction.startsWith("Compaction Threshold")) {
        const value = await ctx.ui.select(
          `Compaction threshold for ${formatTierLabel(tierKey)} (currently: ${config[tierKey].compactionThreshold}%). Lower = compact sooner.`,
          ["50%", "55%", "60%", "65%", "70%", "75%", "80%", "85%", "90%", "95%"],
        );
        if (value) {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num >= 50 && num <= 95) {
            config[tierKey].compactionThreshold = num;
            ctx.ui.notify(`${formatTierLabel(tierKey)} compaction threshold: ${num}%`, "info");
            saveConfig();
          }
        }
      }
    },
  });
}
