/**
 * Trimegisto - compact widget agent ids
 *
 * Run: node --experimental-strip-types test/test-agent-list.ts
 *
 * THE REGRESSION UNDER TEST
 * -------------------------
 * The compact widget (below the editor) summarised agents per TIER only:
 * `T2 3r 1✓`. The user could see three T2 agents were running but had no id to
 * type, so `@t2b kill` was impossible from the always-visible list — the fix is
 * to render the real ids (`◌t2a ◌t2b ✓t3a`), live agents first, with a `+N`
 * overflow instead of silently dropping them.
 */

import { agentChips, pickAgents, statusGlyph } from "../src/agent-list.ts";
import { getAgents } from "../src/agent-manager.ts";
import { createCompactWidget } from "../src/dashboard.ts";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

const a = (id: string, status: string, startedAt = 0) => ({ id, status, startedAt });

console.log("agentChips: the id (tier + letter) is what the widget must show:");
{
  check("one running agent -> its id, not just the tier",
    agentChips([a("t2b", "running")]).join(" ") === "\u25cct2b", agentChips([a("t2b", "running")]));
  check("several agents keep their letters",
    agentChips([a("t2a", "running", 1), a("t2b", "running", 2)]).join(" ") === "\u25cct2a \u25cct2b",
    agentChips([a("t2a", "running", 1), a("t2b", "running", 2)]));
  check("the active tier is nameable too",
    agentChips([a("t0a", "running")])[0] === "\u25cct0a");
  check("status glyph follows the agent", statusGlyph("done") === "\u2713" && statusGlyph("error") === "\u2717" && statusGlyph("killed") === "\u2298" && statusGlyph("waiting") === "\u25f7");
  check("unknown status falls back to a neutral dot", statusGlyph("weird") === "\u00b7");
}

console.log("agentChips: live agents survive the overflow cut:");
{
  const many = [
    a("t3a", "done", 1), a("t3b", "done", 2), a("t3c", "done", 3),
    a("t2a", "running", 4), a("t2b", "running", 5),
  ];
  const chips = agentChips(many, 3);
  check("running agents come first", chips.slice(0, 2).every(c => c.startsWith("\u25cc")), chips);
  check("the remaining done agents collapse into +N", chips[2] === "\u2713t3a" && chips[3] === "+2", chips);
  check("watching agents (waiting) count as live", agentChips([a("t1a", "done", 1), a("t1b", "waiting", 2)], 1)[0] === "\u25f7t1b");
  check("max=1 never returns an empty list", agentChips([a("t2a", "running"), a("t2b", "running")], 1).length === 2);
  check("no agents -> no chips", agentChips([]).length === 0);
}

console.log("pickAgents: deterministic order and an honest hidden count:");
{
  const { shown, hidden } = pickAgents([a("t2b", "running", 20), a("t2a", "running", 10), a("t3a", "done", 30)], 8);
  check("live agents first, in launch order", shown.map(s => s.id).join(",") === "t2a,t2b,t3a", shown.map(s => s.id));
  check("nothing hidden when everything fits", hidden === 0, hidden);
  check("hidden counts what did not fit", pickAgents([a("t2a", "running"), a("t2b", "running")], 1).hidden === 1);
}

console.log("compact widget: the rendered line carries the ids (real render):");
{
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const makeAgent = (id: string, status: string, startedAt: number) => ({
    id, tier: id.slice(0, 2) === "t0" ? "active" : id.slice(0, 2), task: "do the thing", status, startedAt,
    controller: new AbortController(), output: "", stderr: "", log: [],
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
  } as any);

  const render = (agents: any[]): string => {
    for (const agent of agents) getAgents().set(agent.id, agent);
    try {
      const widget = createCompactWidget({} as any)({} as any, theme as any);
      return widget.render(200).join("\n");
    } finally {
      for (const agent of agents) getAgents().delete(agent.id);
    }
  };

  const live = render([
    makeAgent("t2a", "running", Date.now() - 5000),
    makeAgent("t2b", "running", Date.now() - 4000),
    makeAgent("t3a", "done", Date.now() - 3000),
  ]);
  check("live run shows every id, not tier counts", live.includes("t2a") && live.includes("t2b") && live.includes("t3a"), live);
  check("tier-count noise is gone", !/T2\d/.test(live), live);
  check("status glyphs still tell running from done", live.includes("\u25cct2a") && live.includes("\u2713t3a"), live);

  const idle = render([makeAgent("t2c", "done", Date.now() - 1000)]);
  check("an idle session still names its finished agents", idle.includes("t2c"), idle);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
