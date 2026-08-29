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
} from "./config.ts";
import {
  launchAgent,
  haltAll,
  getAgent,
  getAgentCounts,
  getActiveAgents,
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
} from "./agent-manager.ts";
import { saveConfig as persistConfig, loadConfig } from "./persistence.ts";
import { cleanupOldNotifications } from "./context-broker.ts";
import { LoopSupervisor, type LoopAlert } from "./loop-supervisor.ts";

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

const TrimegistoTaskItem = Type.Object({
  tier: Type.Optional(TierEnum),
  task: Type.String({ description: "Agent task" }),
  cwd: Type.Optional(Type.String({ description: "Agent cwd" })),
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
      "Launch parallel Trimegisto sub-agents.",
      "Tiers now:",
      tierStatusLine("active"),
      tierStatusLine("t1"),
      tierStatusLine("t2"),
      tierStatusLine("t3"),
      "Default active/t0 = main pi model; prefer several active agents for same repo/task family.",
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
    promptSnippet: "Spawn parallel agents. Default tier active. Use only ENABLED tiers.",
    parameters: Type.Object({
      tasks: Type.Array(TrimegistoTaskItem, {
        description: "Tasks. Max 8. Default tier active.",
      }),
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

  // ── Register commands (lazy handlers) ───────────────────
  const commandRuntime = () => ({
    configs: { active: config.active, t1: config.t1, t2: config.t2, t3: config.t3 },
    launchFn: doLaunch,
    cwd: process.cwd(),
    isEnabled: () => config.enabled,
    setEnabled: (v: boolean) => {
      config.enabled = v;
      if (v) {
        updateDashboard();
        try { if (ctxRef) ctxRef.ui.setStatus("trimegisto", "◇ Trimegisto active"); } catch {}
      } else {
        haltAll();
        try {
          if (ctxRef) {
            ctxRef.ui.setFooter(undefined);
            ctxRef.ui.setWidget("trimegisto", undefined);
            ctxRef.ui.setWidget("trimegisto-compact", undefined);
            ctxRef.ui.setStatus("trimegisto", "◇ Trimegisto disabled");
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
  });

  pi.registerCommand("tmg", {
    description: "Trimegisto control",
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
        content: `Tmg active agents (${activeAgents.length}):\n${agentList}\n\nAdvisory: delegate work via trimegisto. Prefer cheaper capable tiers: T3 mechanical, T2 reasoning, T1 only hard planning. Manual: /tmg, @t2b <instruction>.`,
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

  // ── Configuration command (lazy UI) ──────────────────
  pi.registerCommand("tmg-config", {
    description: "Configure Trimegisto",
    handler: async (_args, ctx) => {
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
      });
    },
  });
}
