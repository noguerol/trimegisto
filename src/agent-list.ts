/**
 * Trimegisto - the agent list you can NAME from
 *
 * The compact widget (below the editor) used to summarise agents as tier counts
 * only — `T2 3r 1✓` — so the user could see that three T2 agents were running
 * but had no id to type: `@t2b kill` was impossible without `/tmg list`. The
 * chips below render the REAL agent ids (`◌t2a ◌t2b ✓t3a`), live agents first
 * so a busy session never hides the one that can still be steered.
 *
 * Pure on purpose: the rule (ids, ordering, the `+N` overflow) is unit-tested
 * without a terminal, and the widget only applies theme colors on top.
 */

export interface ListedAgent {
  id: string;
  status: string;
  startedAt: number;
}

/** Same glyphs the dashboard/full list use, so a chip reads the same everywhere. */
const STATUS_GLYPH: Record<string, string> = {
  running: "◌",
  waiting: "◷",
  done: "✓",
  error: "✗",
  killed: "⊘",
  idle: "·",
};

export function statusGlyph(status: string): string {
  return STATUS_GLYPH[status] || "·";
}

const isLive = (status: string): boolean => status === "running" || status === "waiting";

/**
 * Pick the agents the widget shows, and how many were left out.
 *
 * - Live agents (running/waiting) come first: they are the ones that accept a
 *   steer or a kill, so they must survive the overflow cut.
 * - Then terminal agents (done/error/killed), in launch order.
 * - At most `max` ids; the rest collapse into `hidden`.
 */
export function pickAgents(agents: ListedAgent[], max = 6): { shown: ListedAgent[]; hidden: number } {
  const cap = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 6;
  const ordered = [...agents].sort((a, b) => {
    const liveA = isLive(a.status) ? 0 : 1;
    const liveB = isLive(b.status) ? 0 : 1;
    if (liveA !== liveB) return liveA - liveB;
    return (a.startedAt || 0) - (b.startedAt || 0);
  });
  const shown = ordered.slice(0, cap);
  return { shown, hidden: ordered.length - shown.length };
}

/** Text-only form of the chips: `["◌t2a", "◌t2b", "✓t3a", "+2"]`. */
export function agentChips(agents: ListedAgent[], max = 6): string[] {
  const { shown, hidden } = pickAgents(agents, max);
  const chips = shown.map(a => `${statusGlyph(a.status)}${a.id}`);
  if (hidden > 0) chips.push(`+${hidden}`);
  return chips;
}
