/**
 * Trimegisto - Commands
 *
 * User-facing slash commands for managing agents.
 * Supports @mention syntax: @t2b do something
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgents, killAgent, haltAll, getAgentCounts, getAgent, sendToAgent, getLoopSupervisor, type AgentCounts } from "./agent-manager.ts";
import { getActiveLocks, releaseAllAgentLocks } from "./file-lock.ts";
import { buildTierConfig, formatTierLabel, parseAgentId } from "./config.ts";
import type { AgentTier, TierConfig } from "./types.ts";

export function registerCommands(
  pi: ExtensionAPI,
  configs: Record<AgentTier, TierConfig>,
  launchFn: (tier: AgentTier, task: string, cwd: string, parentId?: string) => any,
  cwd: string,
  options?: {
    isEnabled: () => boolean;
    setEnabled: (v: boolean) => void;
    haltAll: () => number;
    sendToAgent: (agentId: string, instruction: string) => any;
  },
) {
  // ── /tmg ──────────────────────────────────────────────
  pi.registerCommand("tmg", {
    description: "Trimegisto agent control. Subcommands: launch, kill, halt, list, switch, tell, enable, disable, dashboard",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const rest = parts.slice(1).join(" ");

      switch (sub) {
        case "enable":
        case "on": {
          if (options?.setEnabled) {
            options.setEnabled(true);
            ctx.ui.notify("Trimegisto: ENABLED", "info");
          } else {
            ctx.ui.notify("Trimegisto: enable not available from this context", "warning");
          }
          return;
        }

        case "disable":
        case "off": {
          if (options?.setEnabled) {
            options.setEnabled(false);
            ctx.ui.notify("Trimegisto: DISABLED", "warning");
          } else {
            ctx.ui.notify("Trimegisto: disable not available from this context", "warning");
          }
          return;
        }

        case "launch":
        case "l": {
          if (options?.isEnabled && !options.isEnabled()) {
            ctx.ui.notify("Trimegisto is disabled. Use /tmg enable to activate it.", "warning");
            return;
          }
          if (parts.length < 3) {
            ctx.ui.notify("Usage: /tmg launch <active|t1|t2|t3> <task>", "error");
            return;
          }
          const tierArg = parts[1].toLowerCase();
          const tier: AgentTier = tierArg === "t0" ? "active" : tierArg as AgentTier;
          if (!["active", "t1", "t2", "t3"].includes(tier)) {
            ctx.ui.notify(`Unknown tier: ${tier}. Use active, t1, t2, or t3.`, "error");
            return;
          }
          const task = parts.slice(2).join(" ");
          ctx.ui.notify(`Launching ${formatTierLabel(tier)} agent...`, "info");
          // Fire-and-forget: launchAgent returns immediately
          const agent = launchFn(tier, task, cwd);
          ctx.ui.notify(
            `${(agent as any).agentId || (agent as any).id} ${(agent as any).status === "error" ? "failed" : "launched"}: ${task.slice(0, 60)}`,
            (agent as any).status === "error" ? "error" : "info",
          );
          return;
        }

        case "tell":
        case "msg":
        case "say": {
          if (options?.isEnabled && !options.isEnabled()) {
            ctx.ui.notify("Trimegisto is disabled. Use /tmg enable to activate it.", "warning");
            return;
          }
          if (parts.length < 3) {
            ctx.ui.notify("Usage: /tmg tell <agent-id> <instruction>", "error");
            return;
          }
          const targetId = parts[1];
          const instruction = parts.slice(2).join(" ");
          const agent = getAgent(targetId);
          if (!agent) {
            ctx.ui.notify(`Agent ${targetId} not found.`, "error");
            return;
          }
          ctx.ui.notify(`Sending instruction to ${targetId}...`, "info");
          // Fire-and-forget: spawns new agent, returns immediately
          const newAgent = options?.sendToAgent(targetId, instruction);
          if (newAgent) {
            ctx.ui.notify(`${targetId} stopped → ${newAgent.id} launched with new instruction.`, "info");
          } else {
            ctx.ui.notify(`Failed to send to ${targetId}.`, "error");
          }
          return;
        }

        case "kill":
        case "k": {
          if (options?.isEnabled && !options.isEnabled()) {
            ctx.ui.notify("Trimegisto is disabled. Use /tmg enable to activate it.", "warning");
            return;
          }
          const id = parts[1];
          if (!id) {
            ctx.ui.notify("Usage: /tmg kill <agent-id>", "error");
            return;
          }
          if (killAgent(id)) {
            ctx.ui.notify(`Agent ${id} killed.`, "info");
          } else {
            ctx.ui.notify(`Agent ${id} not found or not running.`, "error");
          }
          return;
        }

        case "halt":
        case "h": {
          if (options?.isEnabled && !options.isEnabled()) {
            ctx.ui.notify("Trimegisto is disabled. Use /tmg enable to activate it.", "warning");
            return;
          }
          const killed = haltAll();
          ctx.ui.notify(`Halted ${killed} agent(s).`, killed > 0 ? "info" : "warning");
          return;
        }

        case "list":
        case "ls": {
          if (options?.isEnabled && !options.isEnabled()) {
            ctx.ui.notify("◇ Trimegisto: Disabled.", "info");
            return;
          }
          const agents = getAgents();
          if (agents.size === 0) {
            ctx.ui.notify("◇ Trimegisto: No agents.", "info");
            return;
          }

          const lines: string[] = [];
          for (const [id, agent] of agents) {
            const status = agent.status;
            const tier = formatTierLabel(agent.tier);
            const elapsed = Date.now() - agent.startedAt;
            const elapsedStr = elapsed < 60000
              ? `${Math.round(elapsed / 1000)}s`
              : `${Math.round(elapsed / 60000)}m`;
            const task = agent.task.length > 60 ? agent.task.slice(0, 60) + "..." : agent.task;
            lines.push(`${statusIcon(status)} ${tier} ${id} [${status}] ${elapsedStr} — ${task}`);
          }

          ctx.ui.notify(`◇ Trimegisto Agents:\n${lines.join("\n")}`, "info");
          return;
        }

        case "switch":
        case "sw": {
          if (options?.isEnabled && !options.isEnabled()) {
            ctx.ui.notify("Trimegisto is disabled. Use /tmg enable to activate it.", "warning");
            return;
          }
          const id = parts[1];
          if (!id) {
            ctx.ui.notify("Usage: /tmg switch <agent-id>", "error");
            return;
          }
          const agent = getAgents().get(id);
          if (!agent) {
            ctx.ui.notify(`Agent ${id} not found.`, "error");
            return;
          }
          // Show the agent's output in a notification
          const output = agent.output || "(no output yet)";
          const preview = output.length > 500 ? output.slice(0, 500) + "\n... (truncated)" : output;
          ctx.ui.notify(
            `${agent.id} [${agent.status}]\n${agent.task}\n\nOutput:\n${preview}`,
            "info",
          );
          return;
        }

        case "locks": {
          const locks = getActiveLocks();
          if (locks.length === 0) {
            ctx.ui.notify("◇ Trimegisto: No active file locks.", "info");
            return;
          }
          const lines: string[] = [`◇ Trimegisto File Locks (${locks.length}):`];
          for (const lock of locks) {
            const age = Math.round((Date.now() - lock.timestamp) / 1000);
            lines.push(`  🔒 ${lock.agentId} ${lock.operation} → ${lock.filePath.replace(process.env.HOME || "/home", "~")} (${age}s ago)`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        case "loops":
        case "loop": {
          const supervisor = getLoopSupervisor();
          if (!supervisor) {
            ctx.ui.notify("◇ Trimegisto: Loop Supervisor not available.", "warning");
            return;
          }

          // /tmg loops sensitivity <0.5..1> — tune similarity threshold at runtime
          if (parts[1] === "sensitivity") {
            const val = parseFloat(parts[2]);
            if (Number.isFinite(val) && val >= 0.5 && val <= 1) {
              supervisor.updateConfig({ similarityThreshold: val });
              ctx.ui.notify(`◇ Loop Supervisor: similarity threshold set to ${val} (higher = fewer false positives)`, "info");
            } else {
              ctx.ui.notify("◇ Usage: /tmg loops sensitivity <0.5..1>", "warning");
            }
            return;
          }

          const state = supervisor.getState();
          const cfg = supervisor.getConfig();
          const lines: string[] = [`◇ Trimegisto Loop Supervisor (similarity ≥ ${cfg.similarityThreshold ?? 0.92})`];
          for (const tier of ["active", "t1", "t2", "t3"] as const) {
            const ts = state.tiers[tier];
            const cooldownStr = ts.cooldownRemaining > 0
              ? ` ⏳ cooldown ${(ts.cooldownRemaining / 1000).toFixed(0)}s`
              : "";
            const strikeStr = ts.strikes > 0
              ? ` ⚡ strikes: ${ts.strikes}/3`
              : "";
            const warnStr = (ts as any).turnWarned > 0
              ? ` ⚠️ turn-warned: ${(ts as any).turnWarned}`
              : "";
            lines.push(`  ${tier}: ${ts.activeAgents} active, ${ts.recentHashes} outputs tracked${strikeStr}${warnStr}${cooldownStr}`);
          }
          if (state.alerts.length > 0) {
            lines.push(`\n  Recent alerts (${state.alerts.length}):`);
            for (const alert of state.alerts.slice(-10)) {
              const age = Math.round((Date.now() - alert.timestamp) / 1000);
              lines.push(`    ${alert.strike >= 3 ? "🚨" : alert.strike >= 2 ? "⚠️" : "🔸"} ${alert.type} — ${alert.message.slice(0, 80)} (${age}s ago)`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        case "reset-loops": {
          const supervisor = getLoopSupervisor();
          if (!supervisor) {
            ctx.ui.notify("◇ Trimegisto: Loop Supervisor not available.", "warning");
            return;
          }
          const tierArg = parts[1]?.toLowerCase();
          if (tierArg === "active" || tierArg === "t1" || tierArg === "t2" || tierArg === "t3") {
            supervisor.resetTier(tierArg);
            ctx.ui.notify(`◇ Loop Supervisor: ${tierArg} strikes reset.`, "info");
          } else {
            supervisor.resetTier("active");
            supervisor.resetTier("t1");
            supervisor.resetTier("t2");
            supervisor.resetTier("t3");
            ctx.ui.notify("◇ Loop Supervisor: all strikes reset.", "info");
          }
          return;
        }

        case "dash":
        case "d": {
          if (options?.isEnabled && !options.isEnabled()) {
            ctx.ui.notify("Trimegisto is disabled. Dashboard is not available.", "warning");
            return;
          }
          // Toggle handled via the main extension state
          if (typeof pi._trimegistoToggleDashboard === "function") {
            pi._trimegistoToggleDashboard();
          }
          return;
        }

        default: {
          ctx.ui.notify(
            "Trimegisto commands:\n" +
            "  /tmg launch <t1|t2|t3> <task>  — Launch an agent\n" +
            "  /tmg tell <agent-id> <msg>       — Send instruction to agent\n" +
            "  /tmg kill <id>                    — Kill an agent\n" +
            "  /tmg halt                         — Halt all agents\n" +
            "  /tmg list                         — List all agents\n" +
            "  /tmg switch <id>                  — Show agent output\n" +
            "  /tmg dashboard                    — Toggle dashboard\n" +
            "  /tmg locks                        — Show active file locks\n" +
            "  /tmg loops                        — Show loop supervisor state\n" +
            "  /tmg reset-loops [t1|t2|t3]      — Reset loop strikes\n" +
            "  /tmg enable | disable             — Enable/disable Trimegisto\n" +
            "  @t2b <instruction>                — Shortcut for /tmg tell",
            "info",
          );
        }
      }
    },
  });

  // ── /t0 /t1 /t2 /t3 shortcuts ─────────────────────────
  function registerTierCommand(tier: AgentTier) {
    // "active" uses the /t0 command name (t0a, t0b... agent IDs)
    const cmd = tier === "active" ? "t0" : tier;
    pi.registerCommand(cmd, {
      description: `Launch a Trimegisto ${formatTierLabel(tier)} agent. Usage: /${cmd} <task> or /${cmd}a <instruction>`,
      handler: async (args, ctx) => {
        if (options?.isEnabled && !options.isEnabled()) {
          ctx.ui.notify("Trimegisto is disabled. Use /tmg enable to activate it.", "warning");
          return;
        }
        if (!args || !args.trim()) {
          ctx.ui.notify(`Usage: /${cmd} <task>  or  /${cmd}a <instruction>`, "error");
          return;
        }
        ctx.ui.notify(`Launching ${formatTierLabel(tier)} agent...`, "info");
        const agent = launchFn(tier, args.trim(), cwd);
        ctx.ui.notify(
          `${(agent as any).agentId || (agent as any).id} ${(agent as any).status === "error" ? "failed" : "launched"}: ${args.trim().slice(0, 60)}`,
          (agent as any).status === "error" ? "error" : "info",
        );
      },
    });
  }
  registerTierCommand("active");
  registerTierCommand("t1");
  registerTierCommand("t2");
  registerTierCommand("t3");

  // ── @mention command ───────────────────────────────────
  // Allows: @t2b do something → sends instruction to agent t2b
  pi.registerCommand("@", {
    description: "Send instruction to a Trimegisto agent. Usage: @t2b do something",
    handler: async (args, ctx) => {
      if (options?.isEnabled && !options.isEnabled()) {
        ctx.ui.notify("Trimegisto is disabled. Use /tmg enable to activate it.", "warning");
        return;
      }

      const parts = (args || "").trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify("Usage: @<agent-id> <instruction>\nExample: @t2b parse the logs", "error");
        return;
      }

      const targetId = parts[0].toLowerCase();
      const instruction = parts.slice(1).join(" ");

      // Validate agent ID format
      const parsed = parseAgentId(targetId);
      if (!parsed) {
        ctx.ui.notify(`Invalid agent ID: ${targetId}. Use format: t1a, t2b, t3c, etc.`, "error");
        return;
      }

      const agent = getAgent(targetId);
      if (!agent) {
        // Agent doesn't exist yet — auto-launch one of the right tier
        ctx.ui.notify(`Agent ${targetId} not found. Launching new ${formatTierLabel(parsed.tier)}...`, "info");
        // Fire-and-forget: launchAgent returns immediately
        const newAgent = launchFn(parsed.tier, instruction, cwd, targetId);
        ctx.ui.notify(
          `${(newAgent as any).agentId || (newAgent as any).id} launched: ${instruction.slice(0, 60)}`,
          (newAgent as any).status === "error" ? "error" : "info",
        );
        return;
      }

      ctx.ui.notify(`Sending to ${targetId}: ${instruction.slice(0, 60)}`, "info");
      // Fire-and-forget: spawns new agent, returns immediately
      const newAgent = options?.sendToAgent(targetId, instruction);
      if (newAgent) {
        ctx.ui.notify(`${targetId} stopped → ${newAgent.id} processing: ${instruction.slice(0, 50)}`, "info");
      } else {
        ctx.ui.notify(`Failed to send to ${targetId}.`, "error");
      }
    },
  });

  // ── Shortcuts ───────────────────────────────────────────
  // Halt on Ctrl+Alt+H
  pi.registerShortcut("ctrl+alt+h", {
    description: "Trimegisto: halt all agents",
    handler: async (ctx) => {
      const killed = haltAll();
      ctx.ui.notify(`Trimegisto: halted ${killed} agent(s).`, killed > 0 ? "info" : "warning");
    },
  });
}

function statusIcon(status: string): string {
  switch (status) {
    case "running": return "◌";
    case "waiting": return "◷";
    case "done": return "✓";
    case "error": return "✗";
    case "killed": return "⊘";
    default: return "·";
  }
}
