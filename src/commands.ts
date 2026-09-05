/** Trimegisto slash-command handlers (lazy-loaded by the entrypoint). */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgents, killAgent, haltAll as haltAllAgents, getAgent, getLoopSupervisor } from "./agent-manager.ts";
import { getActiveLocks } from "./file-lock.ts";
import { formatTierLabel, parseAgentId } from "./config.ts";
import type { AgentTier, TierConfig } from "./types.ts";

export interface CommandRuntime {
  configs?: Record<AgentTier, TierConfig>;
  launchFn: (tier: AgentTier, task: string, cwd: string, parentId?: string) => any | Promise<any>;
  cwd: string;
  isEnabled?: () => boolean;
  setEnabled?: (v: boolean) => void;
  haltAll?: () => number;
  sendToAgent?: (agentId: string, instruction: string) => any | Promise<any>;
  toggleDashboard?: () => void;
  openConfig?: (ctx: any) => void | Promise<void>;
}

const TIERS = ["active", "t1", "t2", "t3"] as const;
const disabledMsg = "Trimegisto disabled. Use /tmg enable.";
const statusIcon = (s: string) => s === "running" ? "◌" : s === "waiting" ? "◷" : s === "done" ? "✓" : s === "error" ? "✗" : s === "killed" ? "⊘" : "·";
const agentName = (a: any) => a?.agentId || a?.id;

function enabled(rt: CommandRuntime, ctx: any): boolean {
  if (rt.isEnabled && !rt.isEnabled()) {
    ctx.ui.notify(disabledMsg, "warning");
    return false;
  }
  return true;
}

export async function handleTmgCommand(pi: ExtensionAPI, args: string | undefined, ctx: any, rt: CommandRuntime): Promise<void> {
  const parts = (args || "").trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  switch (sub) {
    case "config":
    case "cfg":
      if (rt.openConfig) await rt.openConfig(ctx);
      else ctx.ui.notify("Config UI unavailable.", "warning");
      return;

    case "enable":
    case "on":
      rt.setEnabled ? (rt.setEnabled(true), ctx.ui.notify("Trimegisto: ON", "info")) : ctx.ui.notify("Enable unavailable", "warning");
      return;

    case "disable":
    case "off":
      rt.setEnabled ? (rt.setEnabled(false), ctx.ui.notify("Trimegisto: OFF", "warning")) : ctx.ui.notify("Disable unavailable", "warning");
      return;

    case "launch":
    case "l": {
      if (!enabled(rt, ctx)) return;
      if (parts.length < 3) return ctx.ui.notify("Usage: /tmg launch <active|t1|t2|t3> <task>", "error");
      const tier = (parts[1].toLowerCase() === "t0" ? "active" : parts[1].toLowerCase()) as AgentTier;
      if (!(TIERS as readonly string[]).includes(tier)) return ctx.ui.notify(`Unknown tier: ${tier}.`, "error");
      const task = parts.slice(2).join(" ");
      ctx.ui.notify(`Launching ${formatTierLabel(tier)}...`, "info");
      const agent = await rt.launchFn(tier, task, rt.cwd);
      ctx.ui.notify(`${agentName(agent)} ${agent?.status === "error" ? "failed" : "launched"}: ${task.slice(0, 60)}`, agent?.status === "error" ? "error" : "info");
      return;
    }

    case "tell":
    case "msg":
    case "say": {
      if (!enabled(rt, ctx)) return;
      if (parts.length < 3) return ctx.ui.notify("Usage: /tmg tell <agent-id> <instruction>", "error");
      const targetId = parts[1];
      const instruction = parts.slice(2).join(" ");
      if (!getAgent(targetId)) return ctx.ui.notify(`Agent ${targetId} not found.`, "error");
      ctx.ui.notify(`Sending to ${targetId}...`, "info");
      const newAgent = await rt.sendToAgent?.(targetId, instruction);
      ctx.ui.notify(newAgent ? `${targetId} → ${newAgent.id}` : `Failed to send to ${targetId}.`, newAgent ? "info" : "error");
      return;
    }

    case "kill":
    case "k": {
      if (!enabled(rt, ctx)) return;
      const id = parts[1];
      if (!id) return ctx.ui.notify("Usage: /tmg kill <agent-id>", "error");
      const killed = killAgent(id);
      ctx.ui.notify(killed ? `Agent ${id} killed.` : `Agent ${id} not found/running.`, killed ? "info" : "error");
      return;
    }

    case "halt":
    case "h": {
      if (!enabled(rt, ctx)) return;
      const killed = rt.haltAll ? rt.haltAll() : haltAllAgents();
      ctx.ui.notify(`Halted ${killed} agent(s).`, killed > 0 ? "info" : "warning");
      return;
    }

    case "list":
    case "ls": {
      if (rt.isEnabled && !rt.isEnabled()) return ctx.ui.notify("◇ Trimegisto: disabled.", "info");
      const agents = getAgents();
      if (agents.size === 0) return ctx.ui.notify("◇ Trimegisto: no agents.", "info");
      const lines: string[] = [];
      for (const [id, agent] of agents) {
        const elapsed = Date.now() - agent.startedAt;
        const age = elapsed < 60_000 ? `${Math.round(elapsed / 1000)}s` : `${Math.round(elapsed / 60_000)}m`;
        const task = agent.task.length > 60 ? agent.task.slice(0, 60) + "..." : agent.task;
        lines.push(`${statusIcon(agent.status)} ${formatTierLabel(agent.tier)} ${id} [${agent.status}] ${age} — ${task}`);
      }
      ctx.ui.notify(`◇ Trimegisto agents:\n${lines.join("\n")}`, "info");
      return;
    }

    case "switch":
    case "sw": {
      if (!enabled(rt, ctx)) return;
      const id = parts[1];
      if (!id) return ctx.ui.notify("Usage: /tmg switch <agent-id>", "error");
      const agent = getAgents().get(id);
      if (!agent) return ctx.ui.notify(`Agent ${id} not found.`, "error");
      const output = agent.output || "(no output yet)";
      ctx.ui.notify(`${agent.id} [${agent.status}]\n${agent.task}\n\nOutput:\n${output.length > 500 ? output.slice(0, 500) + "\n... (truncated)" : output}`, "info");
      return;
    }

    case "locks": {
      const locks = getActiveLocks();
      if (locks.length === 0) return ctx.ui.notify("◇ Trimegisto: no locks.", "info");
      const home = process.env.HOME || "/home";
      ctx.ui.notify([`◇ File locks (${locks.length}):`, ...locks.map(l => `  🔒 ${l.agentId} ${l.operation} → ${l.filePath.replace(home, "~")} (${Math.round((Date.now() - l.timestamp) / 1000)}s)`)].join("\n"), "info");
      return;
    }

    case "loops":
    case "loop": {
      const supervisor = getLoopSupervisor();
      if (!supervisor) return ctx.ui.notify("◇ Loop Supervisor unavailable.", "warning");
      if (parts[1] === "sensitivity") {
        const val = parseFloat(parts[2]);
        if (Number.isFinite(val) && val >= 0.5 && val <= 1) {
          supervisor.updateConfig({ similarityThreshold: val });
          ctx.ui.notify(`◇ Loop similarity: ${val}`, "info");
        } else ctx.ui.notify("◇ Usage: /tmg loops sensitivity <0.5..1>", "warning");
        return;
      }
      const state = supervisor.getState();
      const cfg = supervisor.getConfig();
      const lines = [`◇ Loop Supervisor (sim ≥ ${cfg.similarityThreshold ?? 0.92}${cfg.dedupeCrossAgent ? ", cross-agent ON" : ""})`];
      let totalDups = 0, totalWasted = 0;
      for (const tier of TIERS) {
        const ts = state.tiers[tier];
        totalDups += ts.crossDuplicates;
        totalWasted += ts.wastedTokens;
        lines.push(`  ${tier}: ${ts.activeAgents} active, ${ts.recentHashes} outputs${ts.strikes ? ` ⚡ ${ts.strikes}/3` : ""}${ts.turnWarned ? ` ⚠ ${ts.turnWarned}` : ""}${ts.crossDuplicates ? ` ♻ ${ts.crossDuplicates}` : ""}${ts.cooldownRemaining > 0 ? ` ⏳ ${(ts.cooldownRemaining / 1000).toFixed(0)}s` : ""}`);
      }
      if (totalDups > 0) {
        lines.push("", `  ♻ Redundancy: ${totalDups} duplicate pair(s), ~${totalWasted} tokens overlapped`);
      }
      if (state.alerts.length) lines.push("", ...state.alerts.slice(-10).map(a => `  ${a.strike >= 3 ? "🚨" : a.strike >= 2 ? "⚠️" : "🔸"} ${a.type} — ${a.message.slice(0, 80)} (${Math.round((Date.now() - a.timestamp) / 1000)}s)`));
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    case "reset-loops": {
      const supervisor = getLoopSupervisor();
      if (!supervisor) return ctx.ui.notify("◇ Loop Supervisor unavailable.", "warning");
      const tier = parts[1]?.toLowerCase() as AgentTier | undefined;
      if (tier && (TIERS as readonly string[]).includes(tier)) {
        supervisor.resetTier(tier);
        ctx.ui.notify(`◇ Loop reset: ${tier}.`, "info");
      } else {
        TIERS.forEach(t => supervisor.resetTier(t));
        ctx.ui.notify("◇ Loop reset: all.", "info");
      }
      return;
    }

    case "dashboard":
    case "dash":
    case "d":
      if (!enabled(rt, ctx)) return;
      (rt.toggleDashboard || (pi as any)._trimegistoToggleDashboard)?.();
      return;

    default:
      ctx.ui.notify(
        "Trimegisto commands:\n" +
        "  /tmg config\n" +
        "  /tmg launch <active|t1|t2|t3> <task>\n" +
        "  /tmg tell <agent-id> <msg>\n" +
        "  /tmg kill <id> | halt | list | switch <id>\n" +
        "  /tmg dashboard | locks | loops | reset-loops [tier]\n" +
        "  /tmg enable | disable\n" +
        "  @t2b <instruction>",
        "info",
      );
  }
}

export async function handleTierCommand(tier: AgentTier, cmd: string, args: string | undefined, ctx: any, rt: CommandRuntime): Promise<void> {
  if (!enabled(rt, ctx)) return;
  const task = (args || "").trim();
  if (!task) return ctx.ui.notify(`Usage: /${cmd} <task>  or  /${cmd}a <instruction>`, "error");
  ctx.ui.notify(`Launching ${formatTierLabel(tier)}...`, "info");
  const agent = await rt.launchFn(tier, task, rt.cwd);
  ctx.ui.notify(`${agentName(agent)} ${agent?.status === "error" ? "failed" : "launched"}: ${task.slice(0, 60)}`, agent?.status === "error" ? "error" : "info");
}

export async function handleMentionCommand(args: string | undefined, ctx: any, rt: CommandRuntime): Promise<void> {
  if (!enabled(rt, ctx)) return;
  const parts = (args || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ctx.ui.notify("Usage: @<agent-id> <instruction>\nExample: @t2b parse logs", "error");
  const targetId = parts[0].toLowerCase();
  const instruction = parts.slice(1).join(" ");
  const parsed = parseAgentId(targetId);
  if (!parsed) return ctx.ui.notify(`Invalid agent ID: ${targetId}. Use t1a, t2b, t3c...`, "error");
  const agent = getAgent(targetId);
  if (!agent) {
    ctx.ui.notify(`Agent ${targetId} not found. Launching ${formatTierLabel(parsed.tier)}...`, "info");
    const newAgent = await rt.launchFn(parsed.tier, instruction, rt.cwd, targetId);
    ctx.ui.notify(`${agentName(newAgent)} launched: ${instruction.slice(0, 60)}`, newAgent?.status === "error" ? "error" : "info");
    return;
  }
  ctx.ui.notify(`Sending to ${targetId}: ${instruction.slice(0, 60)}`, "info");
  const newAgent = await rt.sendToAgent?.(targetId, instruction);
  ctx.ui.notify(newAgent ? `${targetId} → ${newAgent.id}: ${instruction.slice(0, 50)}` : `Failed to send to ${targetId}.`, newAgent ? "info" : "error");
}

export async function handleHaltShortcut(ctx: any, rt: CommandRuntime): Promise<void> {
  const killed = rt.haltAll ? rt.haltAll() : haltAllAgents();
  ctx.ui.notify(`Trimegisto: halted ${killed} agent(s).`, killed > 0 ? "info" : "warning");
}

export function registerCommands(
  pi: ExtensionAPI,
  configs: Record<AgentTier, TierConfig>,
  launchFn: CommandRuntime["launchFn"],
  cwd: string,
  options?: Omit<CommandRuntime, "configs" | "launchFn" | "cwd">,
): void {
  const rt: CommandRuntime = { configs, launchFn, cwd, ...options };
  pi.registerCommand("tmg", { description: "Trimegisto control", handler: (args, ctx) => handleTmgCommand(pi, args, ctx, rt) });
  for (const tier of TIERS) {
    const cmd = tier === "active" ? "t0" : tier;
    pi.registerCommand(cmd, { description: `Launch ${formatTierLabel(tier)} agent`, handler: (args, ctx) => handleTierCommand(tier, cmd, args, ctx, rt) });
  }
  pi.registerCommand("@", { description: "Send to Trimegisto agent", handler: (args, ctx) => handleMentionCommand(args, ctx, rt) });
  pi.registerShortcut("ctrl+alt+h", { description: "Trimegisto: halt agents", handler: ctx => handleHaltShortcut(ctx, rt) });
}
