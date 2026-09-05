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
  getLoopSupervisor,
  type AgentCounts,
} from "./agent-manager.ts";
import { formatTierLabel } from "./config.ts";
import { speed, MAIN_TARGET, type SpeedSnapshot } from "./speed.ts";
import { TMG_SHORT, formatTmgStatus } from "./branding.ts";

/** Status dot colors (using theme color names) */
type ThemeColor = "success" | "accent" | "warning" | "error" | "dim" | "muted";

/**
 * TUI handle captured from the widget factories. pi only repaints when
 * something invalidates the UI; a main session that is just waiting for its
 * sub-agents never does, so streaming speeds would stay frozen. The refresh
 * ticker calls requestDashboardRender() to drive the update.
 */
let tuiRef: any = null;
export function requestDashboardRender(): void {
  try { tuiRef?.requestRender?.(); } catch { /* UI not available */ }
}

/** Count of cross-agent near-duplicate output pairs (Loop Supervisor). */
function redundancyBadge(): string {
  const ls = getLoopSupervisor();
  const st = ls?.getState();
  if (!st) return "";
  let n = 0;
  for (const t of ["active", "t1", "t2", "t3"] as const) n += st.tiers[t].crossDuplicates;
  return n > 0 ? `♻${n}` : "";
}

/** Compute session-wide token/cost totals from the live agents map */
function computeSessionTotals() {
  let totalInput = 0, totalOutput = 0, totalCost = 0, totalTurns = 0;
  let activeCount = 0;
  let activeOutput = 0, activeInput = 0;

  for (const agent of getAgents().values()) {
    totalInput += agent.usage.input;
    totalOutput += agent.usage.output;
    totalCost += agent.usage.cost;
    totalTurns += agent.usage.turns;

    if (agent.status === "running") {
      activeCount++;
      activeOutput += agent.usage.output;
      activeInput += agent.usage.input;
    }
  }

  return { totalInput, totalOutput, totalCost, totalTurns, activeCount, activeOutput, activeInput };
}

/**
 * Live throughput across the sub-agents: decode summed (they generate in
 * parallel) and prefill averaged (prompt processing is per target).
 */
function computeSessionSpeed() {
  let decodeSum = 0, prefillSum = 0, prefillCount = 0;
  for (const agent of getAgents().values()) {
    if (agent.status !== "running" && agent.status !== "waiting") continue;
    const s = speed.snapshot(agent.id);
    if (!s) continue;
    if (s.phase === "decode" && s.decodeTokPerSec > 0) {
      decodeSum += s.decodeTokPerSec;
    }
    if (s.prefillTokPerSec > 0) {
      prefillSum += s.prefillTokPerSec;
      prefillCount++;
    }
  }
  return {
    decodeSum,
    avgPrefill: prefillCount > 0 ? prefillSum / prefillCount : 0,
  };
}

/**
 * "↑prefill ↓decode" suffix for one streaming target.
 *   ↑…2.1s   prompt still being processed (live wait)
 *   ↑1875t/s trusted prefill throughput (large prompt: compute dominates)
 *   ↑817ms   time-to-first-token only — the prompt was too small for the
 *            number to be throughput rather than network latency
 *   ↓38.1t/s generation, live while streaming and authoritative afterwards
 */
function speedSuffix(s: SpeedSnapshot | null, fmt: (n: number) => string): string {
  if (!s) return "";
  const parts: string[] = [];
  if (s.phase === "prefill") {
    parts.push(`↑…${formatElapsed(s.prefillElapsedMs)}`);
  } else if (s.prefillTokPerSec > 0) {
    parts.push(`↑${fmt(s.prefillTokPerSec)}t/s`);
  } else if (s.ttftMs > 0) {
    parts.push(`↑${formatElapsed(s.ttftMs)}`);
  }
  if (s.decodeTokPerSec > 0) parts.push(`↓${fmt(s.decodeTokPerSec)}t/s`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
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
 * Build a widget (above editor) showing detailed agent list.
 */
export function createDashboardWidget(ctx: ExtensionContext) {
  return (tui: any, theme: any) => {
    tuiRef = tui;
    const agents = getAgents();

    return {
      invalidate() {},
      render(width: number): string[] {
        const agentList = Array.from(agents.values())
          .filter(a => a.status !== "idle")
          .sort((a, b) => b.startedAt - a.startedAt);

        const lines: string[] = [];
        lines.push(theme.fg("muted", theme.bold(`${TMG_SHORT} agents`)));

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

        if (agentList.length === 0) {
          // No sub-agents yet: the main session row still shows live speeds.
          const solo = speedSuffix(speed.snapshot(MAIN_TARGET), fmtSpeed);
          if (!solo) return [theme.fg("dim", formatTmgStatus(true, "idle"))];
          return [
            theme.fg("muted", theme.bold(formatTmgStatus(true))),
            theme.fg("muted", `  ⌁ main${solo}`),
          ].map((l) => truncateToWidth(l, width));
        }

        for (const agent of agentList.slice(0, 10)) {
          const dot = theme.fg(statusDot(agent.status), statusIcon(agent.status));
          const label = theme.fg("accent", `${agent.id}`);
          const elapsed = formatElapsed(Date.now() - agent.startedAt);
          const timeStr = theme.fg("dim", ` ${elapsed}`);
          const taskPreview = agent.task.length > 50 ? agent.task.slice(0, 50) + "…" : agent.task;

          let detailLine = `  ${dot} ${label} ${formatTierLabel(agent.tier)}${timeStr}`;

          // Continuous throughput: prefill ↑ and decode ↓, measured live
          if (agent.status === "running" || agent.status === "waiting") {
            detailLine += speedSuffix(speed.snapshot(agent.id), fmtSpeed);
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
            detailLine += speedSuffix(speed.snapshot(agent.id), fmtSpeed);
          }

          lines.push(detailLine);
        }

        if (agentList.length > 10) {
          lines.push(theme.fg("dim", `  ... and ${agentList.length - 10} more`));
        }

        // The main session is a streaming target too: it keeps answering while
        // its sub-agents work, and its speed matters just as much.
        const mainSuffix = speedSuffix(speed.snapshot(MAIN_TARGET), fmtSpeed);
        if (mainSuffix) {
          lines.push(theme.fg("muted", `  ⌁ main${mainSuffix}`));
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
          const sSpeed = computeSessionSpeed();
          if (sSpeed.decodeSum > 0) {
            sessionParts.push(`Σ↓${fmtSpeed(sSpeed.decodeSum)}t/s`);
          }
          if (sSpeed.avgPrefill > 0) {
            sessionParts.push(`↑${fmtSpeed(sSpeed.avgPrefill)}t/s avg`);
          }
          if (session.totalTurns > 0) {
            sessionParts.push(`🔄${session.totalTurns} turns`);
          }
          const redun = redundancyBadge();
          if (redun) sessionParts.push(theme.fg("warning", redun));
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
    tuiRef = tui;
    return {
      invalidate() {},
      render(width: number): string[] {
        const counts = getAgentCounts();
        const session = computeSessionTotals();

        // The active tier (t0) is a tier like any other: it must be counted,
        // otherwise a run that only uses t0 renders as empty.
        const total =
          counts.active.total + counts.t1.total + counts.t2.total + counts.t3.total;

        if (total === 0) return [];

        const active =
          counts.active.running + counts.active.waiting +
          counts.t1.running + counts.t1.waiting +
          counts.t2.running + counts.t2.waiting +
          counts.t3.running + counts.t3.waiting;

        const done = counts.active.done + counts.t1.done + counts.t2.done + counts.t3.done;

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
          let line = theme.fg("dim", formatTmgStatus(true, `${done}✓`));
          if (session.totalOutput > 0) {
            line += ` · 📥${fmtTokens(session.totalInput)} 📤${fmtTokens(session.totalOutput)}`;
          }
          if (session.totalCost > 0) {
            line += ` 💰${fmtCost(session.totalCost)}`;
          }
          const mainIdle = speedSuffix(speed.snapshot(MAIN_TARGET), fmtSpeed);
          if (mainIdle) line += ` ⌁ main${mainIdle}`;
          const redun = redundancyBadge();
          if (redun) line += theme.fg("warning", ` ${redun}`);
          lines.push(line);
          return lines.map(l => truncateToWidth(l, width));
        }

        // Active: aggregate metrics FIRST
        let line = theme.fg("muted", `${formatTmgStatus(true)} `);

        const aggParts: string[] = [];
        aggParts.push(theme.fg("accent", `${active} active`));
        const sSpeed = computeSessionSpeed();
        if (sSpeed.decodeSum > 0) {
          aggParts.push(theme.fg("accent", `↓${fmtSpeed(sSpeed.decodeSum)}t/s`));
        }
        if (sSpeed.avgPrefill > 0) {
          aggParts.push(`↑${fmtSpeed(sSpeed.avgPrefill)}t/s`);
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
        if (counts.active.total > 0 || counts.active.running > 0) {
          tierParts.push(theme.fg("text", `T0${countDisplay(counts, "active")}`));
        }
        if (counts.t1.total > 0 || counts.t1.running > 0) {
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

        const mainLive = speedSuffix(speed.snapshot(MAIN_TARGET), fmtSpeed);
        if (mainLive) {
          line += theme.fg("dim", ` ⌁ main${mainLive}`);
        }
        const redun = redundancyBadge();
        if (redun) line += theme.fg("warning", ` ${redun}`);

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
