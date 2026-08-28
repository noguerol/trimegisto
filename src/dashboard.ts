/**
 * Trimegisto - Dashboard
 *
 * Renders widgets showing agent counts and statuses.
 * Does NOT replace pi's native footer — uses compact status bar and
 * optional widget panels instead.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  getAgentCounts,
  getAgents,
  type AgentCounts,
} from "./agent-manager.ts";
import { formatTierLabel } from "./config.ts";

/** Status dot colors (using theme color names) */
type ThemeColor = "success" | "accent" | "warning" | "error" | "dim" | "muted";

/** Compute session-wide token/cost totals from the live agents map */
function computeSessionTotals() {
  let totalInput = 0, totalOutput = 0, totalCost = 0, totalTurns = 0;
  let activeCount = 0;
  let totalSpeed = 0;
  let activeOutput = 0, activeInput = 0;
  const now = Date.now();

  for (const agent of getAgents().values()) {
    totalInput += agent.usage.input;
    totalOutput += agent.usage.output;
    totalCost += agent.usage.cost;
    totalTurns += agent.usage.turns;

    if (agent.status === "running") {
      activeCount++;
      activeOutput += agent.usage.output;
      activeInput += agent.usage.input;
      // Speed estimate: output / elapsed seconds, summed across agents
      const elapsed = (now - agent.startedAt) / 1000;
      if (elapsed > 1 && agent.usage.output > 0) {
        totalSpeed += agent.usage.output / elapsed;
      }
    }
  }

  return {
    totalInput,
    totalOutput,
    totalCost,
    totalTurns,
    activeCount,
    totalSpeed,
    activeOutput,
    activeInput,
  };
}

/** Crude per-agent token speed estimate (output / elapsed) */
function computeAgentSpeed(agentId: string): { outputSpeed: number } | null {
  const agents = getAgents();
  const agent = agents.get(agentId);
  if (!agent || agent.status !== "running") return null;
  const elapsed = (Date.now() - agent.startedAt) / 1000;
  if (elapsed < 1 || agent.usage.output < 1) return null;
  return { outputSpeed: agent.usage.output / elapsed };
}

function statusDot(status: string): ThemeColor {
  switch (status) {
    case "running": return "accent";
    case "waiting": return "warning";
    case "done": return "success";
    case "error": return "error";
    case "killed": return "dim";
    default: return "muted";
  }
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

function countDisplay(counts: AgentCounts, tier: "active" | "t1" | "t2" | "t3"): string {
  const t = counts[tier];
  const parts: string[] = [];
  if (t.running > 0) parts.push(`${t.running}r`);
  if (t.waiting > 0) parts.push(`${t.waiting}w`);
  if (t.done > 0) parts.push(`${t.done}✓`);
  if (t.error > 0) parts.push(`${t.error}✗`);
  if (t.killed > 0) parts.push(`${t.killed}⊘`);
  return parts.length > 0 ? parts.join(" ") : "—";
}

/**
 * Build a compact status line that appears in the status bar.
 * Shows per-agent token speed and session-wide totals.
 * Does NOT replace the footer — pi's native footer stays intact.
 */
export function createStatusLine(ctx: ExtensionContext) {
  return (tui: any, theme: any, footerData: any) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        const counts = getAgentCounts();
        const agents = getAgents();
        const session = computeSessionTotals();

        const totalActive =
          counts.t1.running + counts.t1.waiting +
          counts.t2.running + counts.t2.waiting +
          counts.t3.running + counts.t3.waiting;

        const totalDone = counts.t1.done + counts.t2.done + counts.t3.done;
        const totalError = counts.t1.error + counts.t2.error + counts.t3.error;
        const total = totalActive + totalDone + totalError;

        if (total === 0) {
          return [truncateToWidth(theme.fg("dim", "◇ Trimegisto: idle"), width)];
        }

        // Helper: format token count (1.2k, 3.4M)
        const fmtTokens = (n: number): string => {
          if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
          if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
          return String(n);
        };

        // Helper: format tokens/s (show integer or one decimal)
        const fmtSpeed = (n: number): string => n >= 10 ? `${Math.round(n)}` : n.toFixed(1);

        // Helper: format cost in cents or dollars
        const fmtCost = (n: number): string => {
          if (n >= 1) return `$${n.toFixed(3)}`;
          if (n >= 0.001) return `${(n * 100).toFixed(1)}¢`;
          return `${(n * 1000).toFixed(0)}m¢`;
        };

        // Build active agent details with token speed
        const activeAgents = Array.from(agents.values())
          .filter(a => a.status === "running" || a.status === "waiting")
          .slice(0, 3);

        const agentParts: string[] = [];
        for (const a of activeAgents) {
          const speed = computeAgentSpeed(a.id);
          let label = `${statusIcon(a.status)} ${a.id}`;

          if (speed && speed.outputSpeed > 0) {
            label += ` ⚡${fmtSpeed(speed.outputSpeed)}t/s`;
          }
          if (a.usage.output > 0) {
            label += ` 📤${fmtTokens(a.usage.output)}`;
          }
          if (a.usage.input > 0) {
            label += ` 📥${fmtTokens(a.usage.input)}`;
          }
          agentParts.push(theme.fg("accent", label));
        }

        // Build tier summary
        const tierParts: string[] = [];
        if (counts.active.total > 0 || counts.active.running > 0) {
          tierParts.push(`${theme.fg("text", "T0")}${countDisplay(counts, "active")}`);
        }
        if (counts.t1.total > 0 || counts.t1.running > 0) {
          tierParts.push(`${theme.fg("accent", "T1")}${countDisplay(counts, "t1")}`);
        }
        if (counts.t2.total > 0) {
          tierParts.push(`${theme.fg("warning", "T2")}${countDisplay(counts, "t2")}`);
        }
        if (counts.t3.total > 0) {
          tierParts.push(`${theme.fg("success", "T3")}${countDisplay(counts, "t3")}`);
        }

        // Build aggregate metrics (shown first after tier summary)
        const aggParts: string[] = [];
        if (session.activeCount > 0) {
          aggParts.push(theme.fg("accent", `${session.activeCount} active`));
        }
        if (session.totalSpeed > 0) {
          aggParts.push(`⚡${fmtSpeed(session.totalSpeed)}t/s`);
        }
        if (session.activeOutput > 0) {
          aggParts.push(`📤${fmtTokens(session.activeOutput)}`);
        }
        if (session.activeInput > 0) {
          aggParts.push(`📥${fmtTokens(session.activeInput)}`);
        }

        // Build session-wide totals (secondary)
        const totalParts: string[] = [];
        if (session.totalInput > 0 || session.totalOutput > 0) {
          totalParts.push(`∑📥${fmtTokens(session.totalInput)}`);
          totalParts.push(`📤${fmtTokens(session.totalOutput)}`);
        }
        if (session.totalCost > 0) {
          totalParts.push(`💰${fmtCost(session.totalCost)}`);
        }

        // Assemble the line: tier summary → aggregate → per-agent → session totals
        let line = theme.fg("muted", "◇ ") + tierParts.join(" ");

        if (aggParts.length > 0) {
          line += " · " + aggParts.join(" ");
        }

        if (agentParts.length > 0) {
          line += "  " + agentParts.join("  ");
        }

        if (totalActive > 3) {
          line += theme.fg("dim", `  +${totalActive - 3} more`);
        }

        if (totalParts.length > 0) {
          line += " · " + totalParts.join(" ");
        }

        return [truncateToWidth(line, width)];
      },
    };
  };
}

/**
 * Build a widget (above editor) showing detailed agent list.
 */
export function createDashboardWidget(ctx: ExtensionContext) {
  return (tui: any, theme: any) => {
    const agents = getAgents();

    return {
      invalidate() {},
      render(width: number): string[] {
        const agentList = Array.from(agents.values())
          .filter(a => a.status !== "idle")
          .sort((a, b) => b.startedAt - a.startedAt);

        if (agentList.length === 0) {
          return [theme.fg("dim", "◇ Trimegisto: no active agents")];
        }

        const lines: string[] = [];
        lines.push(theme.fg("muted", theme.bold("◇ Trimegisto Agents")));

        // Helper: format token count
        const fmtTokens = (n: number): string => {
          if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
          if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
          return String(n);
        };
        const fmtSpeed = (n: number): string => n >= 10 ? `${Math.round(n)}` : n.toFixed(1);
        const fmtCost = (n: number): string => {
          if (n >= 1) return `$${n.toFixed(3)}`;
          if (n >= 0.001) return `${(n * 100).toFixed(1)}¢`;
          return `${(n * 1000).toFixed(0)}m¢`;
        };

        for (const agent of agentList.slice(0, 10)) {
          const dot = theme.fg(statusDot(agent.status), statusIcon(agent.status));
          const label = theme.fg("accent", `${agent.id}`);
          const elapsed = formatElapsed(Date.now() - agent.startedAt);
          const timeStr = theme.fg("dim", ` ${elapsed}`);
          const taskPreview = agent.task.length > 50 ? agent.task.slice(0, 50) + "…" : agent.task;

          let detailLine = `  ${dot} ${label} ${formatTierLabel(agent.tier)}${timeStr}`;

          // Add token speed for active agents
          if (agent.status === "running" || agent.status === "waiting") {
            const speed = computeAgentSpeed(agent.id);
            if (speed && speed.outputSpeed > 0) {
              detailLine += ` ⚡${fmtSpeed(speed.outputSpeed)}t/s`;
            }
            if (agent.usage.output > 0) {
              detailLine += ` 📤${fmtTokens(agent.usage.output)}`;
            }
            if (agent.usage.input > 0) {
              detailLine += ` 📥${fmtTokens(agent.usage.input)}`;
            }
            detailLine += ` — ${theme.fg("dim", taskPreview)}`;
          } else if (agent.usage.output > 0) {
            // Done agents show final token counts
            detailLine += ` 📤${fmtTokens(agent.usage.output)}`;
            if (agent.usage.input > 0) {
              detailLine += ` 📥${fmtTokens(agent.usage.input)}`;
            }
            if (agent.usage.cost > 0) {
              detailLine += ` 💰${fmtCost(agent.usage.cost)}`;
            }
          }

          lines.push(detailLine);
        }

        if (agentList.length > 10) {
          lines.push(theme.fg("dim", `  ... and ${agentList.length - 10} more`));
        }

        // Session-wide totals line
        const session = computeSessionTotals();
        if (session.totalInput > 0 || session.totalOutput > 0) {
          const sessionParts: string[] = [];
          sessionParts.push(`∑ 📥${fmtTokens(session.totalInput)}`);
          sessionParts.push(`📤${fmtTokens(session.totalOutput)}`);
          if (session.totalCost > 0) {
            sessionParts.push(`💰${fmtCost(session.totalCost)}`);
          }
          if (session.activeCount > 0 && session.totalSpeed > 0) {
            sessionParts.push(`⚡${fmtSpeed(session.totalSpeed)}t/s Σ`);
          }
          if (session.totalTurns > 0) {
            sessionParts.push(`🔄${session.totalTurns} turns`);
          }
          lines.push(`  ${theme.fg("dim", sessionParts.join(" "))}`);
        }

        return lines.map(l => truncateToWidth(l, width));
      },
    };
  };
}

/**
 * Build a compact widget (below editor) showing aggregate metrics first,
 * then tier breakdown.
 */
export function createCompactWidget(ctx: ExtensionContext) {
  return (tui: any, theme: any) => {
    return {
      invalidate() {},
      render(width: number): string[] {
        const counts = getAgentCounts();
        const session = computeSessionTotals();

        const total =
          counts.t1.total + counts.t2.total + counts.t3.total;

        if (total === 0) return [];

        const active =
          counts.t1.running + counts.t1.waiting +
          counts.t2.running + counts.t2.waiting +
          counts.t3.running + counts.t3.waiting;

        const done = counts.t1.done + counts.t2.done + counts.t3.done;

        const fmtTokens = (n: number): string => {
          if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
          if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
          return String(n);
        };
        const fmtSpeed = (n: number): string => n >= 10 ? `${Math.round(n)}` : n.toFixed(1);
        const fmtCost = (n: number): string => {
          if (n >= 1) return `$${n.toFixed(3)}`;
          if (n >= 0.001) return `${(n * 100).toFixed(1)}¢`;
          return `${(n * 1000).toFixed(0)}m¢`;
        };

        const lines: string[] = [];

        if (active === 0 && done > 0) {
          // Idle: show session totals
          let line = theme.fg("dim", `◇ Trimegisto: ${done} done`);
          if (session.totalOutput > 0) {
            line += ` · 📥${fmtTokens(session.totalInput)} 📤${fmtTokens(session.totalOutput)}`;
          }
          if (session.totalCost > 0) {
            line += ` 💰${fmtCost(session.totalCost)}`;
          }
          lines.push(line);
          return lines.map(l => truncateToWidth(l, width));
        }

        // Active: aggregate metrics FIRST
        let line = theme.fg("muted", "◇ Trimegisto ");

        const aggParts: string[] = [];
        aggParts.push(theme.fg("accent", `${active} active`));
        if (session.totalSpeed > 0) {
          aggParts.push(theme.fg("accent", `⚡${fmtSpeed(session.totalSpeed)}t/s`));
        }
        if (session.activeOutput > 0) {
          aggParts.push(`📤${fmtTokens(session.activeOutput)}`);
        }
        if (session.activeInput > 0) {
          aggParts.push(`📥${fmtTokens(session.activeInput)}`);
        }
        line += aggParts.join(" ");

        // Tier breakdown
        const tierParts: string[] = [];
        if (counts.t1.total > 0 || counts.t1.running > 0) {
          tierParts.push(theme.fg("text", `T0${countDisplay(counts, "active")}`));
          tierParts.push(theme.fg("accent", `T1${countDisplay(counts, "t1")}`));
        }
        if (counts.t2.total > 0) {
          tierParts.push(theme.fg("warning", `T2${countDisplay(counts, "t2")}`));
        }
        if (counts.t3.total > 0) {
          tierParts.push(theme.fg("success", `T3${countDisplay(counts, "t3")}`));
        }
        if (tierParts.length > 0) {
          line += " · " + tierParts.join(" ");
        }

        if (done > 0) {
          line += theme.fg("dim", ` (${done} done)`);
        }

        lines.push(line);
        return lines.map(l => truncateToWidth(l, width));
      },
    };
  };
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}
