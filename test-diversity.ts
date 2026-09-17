/**
 * Trimegisto - diversity / fresh-perspective tests
 *
 * Run: node --experimental-strip-types test-diversity.ts
 *
 * The paper's own remedy for its §4.4 regressions: keep an independent attempt
 * (a "fresh-perspective" worker) to compare against a plan that may have
 * anchored on a bad early approach (arXiv:2608.26480 §4.4).
 *
 * Covers:
 *  - `verify` / `context` / `diversity` survive the plan gate onto PlanNode
 *  - diversity nodes are exempt from duplicate merging (both twins launch)
 *  - the exemption does NOT leak: normal duplicates still merge, and a capped
 *    number of diversity nodes per batch prevents it becoming a dedup bypass
 */

import { planBatch } from "./src/plan-graph.ts";
import type { PlanTaskInput } from "./src/plan-graph.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const TASK = "optimize the range-query path in solver.py with a sparse table";

// ── field pass-through ────────────────────────────────────
console.log("\nfield pass-through");
{
  const d = planBatch([{ task: TASK, verify: "  pytest -q  ", context: "fresh", diversity: true }]);
  check("accepts the batch", d.accept === true);
  const n = d.nodes[0];
  check("verify trimmed", n.verify === "pytest -q", n.verify);
  check("context fresh", n.context === "fresh", n.context);
  check("diversity true", n.diversity === true);
}
{
  const d = planBatch([{ task: TASK } as PlanTaskInput]);
  check("absent verify stays undefined", d.nodes[0].verify === undefined);
  check("absent context stays undefined", d.nodes[0].context === undefined);
  check("absent diversity stays undefined", d.nodes[0].diversity === undefined);
}
{
  const d = planBatch([{ task: TASK, verify: "   ", context: "ledger" } as PlanTaskInput]);
  check("blank verify is dropped", d.nodes[0].verify === undefined);
  check("explicit ledger context kept", d.nodes[0].context === "ledger");
}
{
  // An invalid context value is not invented into a valid one.
  const d = planBatch([{ task: TASK, context: "weird" } as any]);
  check("invalid context dropped", d.nodes[0].context === undefined, d.nodes[0].context);
}

// ── diversity exemption ───────────────────────────────────
console.log("\ndiversity exemption from dedup");
{
  // Identical task, one plain + one diversity twin.
  const d = planBatch([{ task: TASK }, { task: TASK, diversity: true }]);
  check("both twins launch", d.launch.length === 2, d.launch.map(n => n.index));
  check("no duplicate merged", d.counts.duplicates === 0, d.counts);
  check("the diversity twin is the second", d.launch[1]?.diversity === true);
}
{
  // Both marked diversity: still both launch.
  const d = planBatch([{ task: TASK, diversity: true }, { task: TASK, diversity: true }]);
  check("two diversity twins both launch", d.launch.length === 2, d.launch.map(n => n.index));
}
{
  // A normal twin pair plus one diversity twin: the NORMAL pair merges, the
  // diversity node still runs. The exemption must not disable dedup globally.
  const d = planBatch([
    { task: TASK },                 // 1 normal
    { task: TASK, diversity: true },// 2 diversity (kept)
    { task: TASK },                 // 3 normal -> merges into 1
  ]);
  check("normal duplicate still merged", d.counts.duplicates === 1, d.counts);
  check("launch = normal rep + diversity twin", d.launch.length === 2, d.launch.map(n => n.index));
  const launchedIdx = d.launch.map(n => n.index).sort();
  check("launched indices are 1 and 2", launchedIdx.join(",") === "1,2", launchedIdx);
}

// ── diversity cap ─────────────────────────────────────────
console.log("\ndiversity cap (no dedup bypass)");
{
  const tasks: PlanTaskInput[] = [];
  for (let i = 0; i < 6; i++) tasks.push({ task: TASK, diversity: true });
  const d = planBatch(tasks);
  const stillDiverse = d.nodes.filter(n => n.diversity === true).length;
  check("at most 3 keep diversity", stillDiverse === 3, stillDiverse);
  check("the excess are merged away", d.counts.duplicates >= 2, d.counts);
  const capWarnings = d.nodes.flatMap(n => n.warnings).filter(w => /cap is 3/.test(w));
  check("cap warns on the excess", capWarnings.length === 3, capWarnings.length);
  check("launch is capped well below 6", d.launch.length <= 4, d.launch.length);
  check("batch still accepted", d.accept === true);
}

// ── interaction with needs + deterministic ────────────────
console.log("\ndiversity with dependencies + determinism");
{
  const d1 = planBatch([
    { task: "read the spec and list the constraints", id: 1 } as any,
    { task: TASK, diversity: true, needs: [1] },
    { task: TASK, diversity: true, needs: [1] },
  ]);
  check("accepts", d1.accept === true);
  check("both twins keep the dependency", d1.nodes.filter(n => n.index !== 1).every(n => n.needs.includes(1)));
  check("twins land in a later wave than the dep", d1.nodes.filter(n => n.index !== 1).every(n => n.wave > d1.nodes[0].wave));

  const d2 = planBatch([
    { task: "read the spec and list the constraints", id: 1 } as any,
    { task: TASK, diversity: true, needs: [1] },
    { task: TASK, diversity: true, needs: [1] },
  ]);
  check("deterministic between runs", d1.summary === d2.summary);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
