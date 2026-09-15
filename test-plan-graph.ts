/**
 * Trimegisto - plan-graph tests
 *
 * Run: node --experimental-strip-types test-plan-graph.ts
 *
 * Covers nodes, dependency/cycle validation, waves, duplicate merging,
 * same-file serialisation, lanes, code nodes, goal affinity and determinism.
 */

import {
  planBatch,
  nextWaveAction,
  classifyLane,
  looksLikeCodeNode,
  looksLikePipelineStep,
  goalAffinity,
  CLOSED_LANE_KEYWORDS,
  GATED_LANE_KEYWORDS,
  GOAL_STOPWORDS,
} from "./src/plan-graph.ts";
import type { PlanTaskInput, WaveState } from "./src/plan-graph.ts";
import { registerTask, forgetTask, isDuplicateTask } from "./src/task-dedup.ts";
import { haltAll, isHalted, clearHalted } from "./src/agent-manager.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const deep = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const has = (arr: string[], needle: string): boolean => arr.some(x => x.includes(needle));

// ── Pure helpers ─────────────────────────────────────────────
console.log("Helpers (classifyLane / code node / pipeline / affinity):");
{
  check("closed lane quotes keyword", classifyLane("deploy the service to production").lane === "closed", classifyLane("deploy the service to production"));
  check("closed reason quotes matched keyword", classifyLane("deploy the service to production").reason.includes('"deploy"'));
  check("gated lane detects shared utils", classifyLane("refactor the shared utils").lane === "gated");
  check("gated reason quotes matched keyword", classifyLane("refactor the shared utils").reason.includes('"shared utils"'));
  check("open lane is the default", classifyLane("write a haiku about rain").lane === "open");

  check("code node: mechanical verb only", looksLikeCodeNode("parse the CSV and count the rows") === true);
  check("code node: reasoning word vetoes", looksLikeCodeNode("review the design and decide") === false);
  check("code node: plain prose is not code", looksLikeCodeNode("think about the architecture") === false);

  check("pipeline: 'then'", looksLikePipelineStep("then format the output rows") === true);
  check("pipeline: 'its output'", looksLikePipelineStep("summarise its output for the user") === true);
  check("pipeline: plain task", looksLikePipelineStep("build the parser from scratch") === false);

  check("affinity: undefined goal is 0", goalAffinity(undefined, "anything") === 0);
  check("affinity: empty goal is 0", goalAffinity("  ", "anything") === 0);
  check("affinity: unrelated is 0", goalAffinity("improve onboarding documentation for contributors", "rename temporary scratch files in the build cache") === 0);
  check("affinity: related is > 0", goalAffinity("improve onboarding documentation for contributors", "update the onboarding documentation for contributors") > 0.5);

  check("CLOSED_LANE_KEYWORDS exported", Array.isArray(CLOSED_LANE_KEYWORDS) && CLOSED_LANE_KEYWORDS.includes("deploy"));
  check("GATED_LANE_KEYWORDS exported", Array.isArray(GATED_LANE_KEYWORDS) && GATED_LANE_KEYWORDS.includes("schema"));
  check("GOAL_STOPWORDS exported Set", GOAL_STOPWORDS instanceof Set && GOAL_STOPWORDS.has("the"));
}

// ── (a) independent tasks -> 1 parallel wave ────────────────
console.log("(a) independent tasks:");
{
  const d = planBatch([
    { task: "write the alpha module" },
    { task: "write the beta module" },
  ]);
  check("accepted", d.accept === true);
  check("2 nodes launched", d.launch.length === 2 && d.counts.launch === 2);
  check("single wave", d.waves.length === 1, d.waves);
  check("wave contains both indexes ascending", deep(d.waves[0], [1, 2]), d.waves);
  check("no serialisation", d.counts.serialized === 0);
}

// ── (b) declared chain 1 -> 2 -> 3 ──────────────────────────
console.log("(b) declared chain:");
{
  const d = planBatch([
    { task: "first stage research the topic" },
    { task: "second stage build the thing", needs: [1] },
    { task: "third stage verify the thing", needs: [2] },
  ]);
  check("accepted", d.accept === true);
  check("3 waves, one node each", deep(d.waves, [[1], [2], [3]]), d.waves);
  check("wave values are 1,2,3", d.nodes.map(n => n.wave).join(",") === "1,2,3");
  check("deps preserved", deep(d.nodes[1].needs, [1]) && deep(d.nodes[2].needs, [2]));
}

// ── (c) cycle broken deterministically ──────────────────────
console.log("(c) cycle:");
{
  const d = planBatch([
    { task: "cycle node alpha", needs: [3] },
    { task: "cycle node beta", needs: [1] },
    { task: "cycle node gamma", needs: [2] },
  ]);
  check("still launchable", d.accept === true && d.launch.length === 3);
  check("cycle warning recorded", has(d.warnings, "cycle detected (#1 → #2 → #3 → #1)"), d.warnings);
  check("highest-source edge dropped (#3 → #1)", deep(d.nodes[0].needs, []), d.nodes[0].needs);
  check("remaining edges kept", deep(d.nodes[1].needs, [1]) && deep(d.nodes[2].needs, [2]));
  check("repaired flag set", d.repaired === true);
  check("3 waves after break", deep(d.waves, [[1], [2], [3]]), d.waves);
}

// ── (d) duplicate pair merged ───────────────────────────────
console.log("(d) duplicates:");
{
  const text = "measure the latency of every request path and record the slowest operations found";
  const d = planBatch([{ task: text }, { task: text }]);
  check("both proposed nodes present", d.nodes.length === 2 && d.counts.proposed === 2);
  check("lowest index kept as node", d.launch.length === 1 && d.launch[0].index === 1);
  check("duplicateOf points at #1", d.nodes[1].duplicateOf === 1);
  check("duplicate not in waves", deep(d.waves, [[1]]), d.waves);
  check("counts.duplicates = 1", d.counts.duplicates === 1);
  check("merge warning present", has(d.warnings, "#2 duplicates #1 (100% similar) — merged"), d.warnings);
  check("repaired flag set", d.repaired === true);

  // Light rewording (the realistic coordinator repeat) is caught by the
  // stopword-stripped word set. 8-gram shingles alone score 0 here because a
  // short task description collapses to a single shingle.
  const reworded = planBatch([
    { task: "count rows in logs.csv" },
    { task: "count the rows of logs.csv" },
  ]);
  check("reworded short task is merged", reworded.counts.duplicates === 1, reworded.counts);
  check("reworded pair keeps the lowest index", reworded.launch.length === 1 && reworded.launch[0].index === 1, reworded.launch.map(n => n.index));

  // Documented limit: a HEAVY paraphrase shares too few content words to be
  // proven equivalent by a deterministic lexical metric, so it is NOT merged.
  const paraphrase = planBatch([
    { task: "map every place v1 manifests are parsed" },
    { task: "map all locations where v1 manifests get parsed" },
  ]);
  check("heavy paraphrase is not merged (lexical metric limit)", paraphrase.counts.duplicates === 0, paraphrase.counts);
}

// ── (e) same-file writers serialised ────────────────────────
console.log("(e) same-file collision:");
{
  const d = planBatch([
    { task: "update module alpha to add feature one", writes: ["src/alpha.ts"] },
    { task: "update module beta to add feature two", writes: ["src/alpha.ts"] },
  ]);
  check("accepted, both launch", d.accept === true && d.launch.length === 2);
  check("serialised into 2 waves", deep(d.waves, [[1], [2]]), d.waves);
  check("counts.serialized = 1", d.counts.serialized === 1);
  check("warning names file and both nodes", has(d.warnings, "#1") && has(d.warnings, "#2") && has(d.warnings, "src/alpha.ts"), d.warnings);
  check("no cycle introduced", d.nodes.every(n => n.wave >= 1) && d.accept);
}

// ── (f) closed lane -> refused ──────────────────────────────
console.log("(f) closed lane:");
{
  const d = planBatch([{ task: "delete the old production database" }]);
  check("refused", d.accept === false);
  check("blocker recorded", d.blockers.length >= 1 && has(d.blockers, "closed lane"), d.blockers);
  check("counts.closed = 1", d.counts.closed === 1);
  check("verdict REFUSED in summary", d.summary.includes("**Plan verdict:** REFUSED"));
  check("explicit closed override also refused", planBatch([{ task: "do something harmless", lane: "closed" }]).accept === false);
}

// ── (g) more than maxTasks -> refused ───────────────────────
console.log("(g) over maxTasks:");
{
  const tasks: PlanTaskInput[] = [];
  for (let i = 1; i <= 9; i++) tasks.push({ task: `write module number ${i}` });
  const d = planBatch(tasks);
  check("refused", d.accept === false);
  check("blocker mentions maxTasks", has(d.blockers, "maxTasks=8"), d.blockers);
  check("all 9 proposed", d.counts.proposed === 9);

  const small = planBatch([
    { task: "write module one" },
    { task: "write module two" },
    { task: "write module three" },
  ], { maxTasks: 2 });
  check("custom maxTasks respected", small.accept === false && has(small.blockers, "maxTasks=2"));
}

// ── (h) pipeline phrase without needs ───────────────────────
console.log("(h) pipeline phrase without needs:");
{
  const d = planBatch([
    { task: "first build the parser" },
    { task: "then format the output rows" },
  ]);
  check("warning recorded", has(d.warnings, "declares no needs"), d.warnings);
  check("no edge auto-added", d.nodes[1].needs.length === 0);
  check("single wave", d.waves.length === 1, d.waves);
}

// ── (i) code node flagged ───────────────────────────────────
console.log("(i) code node:");
{
  const d = planBatch([{ task: "parse the CSV and count the rows" }]);
  check("codeNode true", d.nodes[0].codeNode === true);
  check("code-node warning recorded", has(d.warnings, "bash/code node"), d.warnings);
  check("summary lists it", d.summary.includes("### Code nodes (no model needed)") && d.summary.includes("parse the CSV and count the rows"));
}

// ── (j) goal affinity warnings ──────────────────────────────
console.log("(j) goal affinity:");
{
  const goal = "improve onboarding documentation for contributors";
  const d = planBatch([
    { task: "update the onboarding documentation for contributors" },
    { task: "rename temporary scratch files in the build cache" },
  ], { goal });
  check("unrelated node warns", has(d.warnings, "#2 has no lexical link to the stated goal"), d.warnings);
  check("related node does not warn", !has(d.warnings, "#1 has no lexical link to the stated goal"), d.warnings);
  check("goal echoed in summary", d.summary.includes("**Goal:** " + goal));
}

// ── (k) no goal -> global warning ───────────────────────────
console.log("(k) no goal:");
{
  const d = planBatch([{ task: "write a report" }]);
  check("global no-goal warning", has(d.warnings, "no goal declared — relevance to the overall task cannot be checked"), d.warnings);
}

// ── (l) determinism ─────────────────────────────────────────
console.log("(l) determinism:");
{
  const input: PlanTaskInput[] = [
    { task: "research the ingestion path", why: "context" },
    { task: "then format the extracted rows", writes: ["src/out.ts"] },
    { task: "research the ingestion path", why: "context" },
  ];
  const a = planBatch(input, { goal: "improve the ingestion pipeline" });
  const b = planBatch(input, { goal: "improve the ingestion pipeline" });
  check("summaries are byte-identical", a.summary === b.summary);
  check("full decision deep-equal", deep(a, b));
  check("summary has no timestamp-ish clock", !/\d{4}-\d{2}-\d{2}T/.test(a.summary));
}

// ── (m) malformed input never throws ────────────────────────
console.log("(m) malformed input:");
{
  let threw = false;
  let d: ReturnType<typeof planBatch> | undefined;
  try {
    planBatch(null as unknown as PlanTaskInput[]);
    planBatch("not an array" as unknown as PlanTaskInput[]);
    planBatch({} as unknown as PlanTaskInput[]);
    planBatch([null, undefined, "", 0, false] as unknown as PlanTaskInput[]);
    d = planBatch([
      null,
      undefined,
      "",
      "just a string task",
      { task: "ok task here", needs: ["2", 99, -1, 1] as unknown as number[] },
      { task: "bad needs type", needs: "not-an-array" as unknown as number[] },
      { task: 42 as unknown as string },
    ] as unknown as PlanTaskInput[]);
  } catch (err) {
    threw = true;
    console.log("    threw:", err);
  }
  check("never throws", threw === false);
  check("falsy entries filtered", d !== undefined && d.counts.proposed === 4, d?.counts);
  check("string dep indexes coerced, invalid dropped", d !== undefined && deep(d.nodes[1].needs, [1]), d?.nodes[1].needs);
  check("empty batch is accepted", planBatch([]).accept === true);
}

// ── (n) wave scheduler decision (pure) ──────────────────────
console.log("(n) nextWaveAction — the scheduler's decision table:");
{
  const base: WaveState = { waveCount: 3, currentWave: -1, currentWaveTerminal: true, stopped: false, enabled: true, deadlineReached: false };
  const act = (over: Partial<WaveState>) => nextWaveAction({ ...base, ...over });

  check("fresh batch launches wave 1", act({}).action === "launch-next", act({}).reason);
  check("launches the next wave when the current one is terminal", act({ currentWave: 0 }).action === "launch-next");
  check("waits while the current wave runs", act({ currentWave: 0, currentWaveTerminal: false }).action === "wait");
  check("settles when the last wave is terminal", act({ currentWave: 2 }).action === "settle");
  check("last-wave reason is 'all waves complete'", act({ currentWave: 2 }).reason === "all waves complete");
  check("a single-wave plan settles after wave 0", act({ waveCount: 1, currentWave: 0 }).action === "settle");

  // Stop wins over everything: never launch dependents of work a human killed.
  const killed = act({ currentWave: 0, stopped: true });
  check("a kill/halt settles instead of launching the next wave", killed.action === "settle", killed);
  check("stop beats a still-running wave", act({ currentWave: 0, currentWaveTerminal: false, stopped: true }).action === "settle");
  check("stop reason names the cause", killed.reason.includes("stopped"));

  // Deadline and mid-batch disable.
  check("deadline settles a running wave", act({ currentWave: 0, currentWaveTerminal: false, deadlineReached: true }).action === "settle");
  check("deadline reason names the deadline", act({ currentWave: 0, deadlineReached: true }).reason.includes("deadline"));
  check("deadline settles between waves", act({ currentWave: 0, deadlineReached: true }).action === "settle");
  check("disabled mid-batch settles", act({ currentWave: 0, enabled: false }).action === "settle");
  check("disabled reason names trimegisto", act({ currentWave: 0, enabled: false }).reason.includes("disabled"));

  // Degenerate input never throws and never launches past the end.
  check("zero waves settle", act({ waveCount: 0 }).action === "settle");
  check("currentWave beyond the end settles", act({ currentWave: 9 }).action === "settle");
  check("NaN waveCount never launches", nextWaveAction({ ...base, waveCount: Number.NaN }).action === "settle");
  check("null-ish state settles instead of throwing", (() => {
    try { return nextWaveAction(undefined as unknown as WaveState).action === "settle"; } catch { return false; }
  })());
  check("always returns a reason", act({}).reason.length > 0);
  check("deterministic", deep(act({ currentWave: 0 }), act({ currentWave: 0 })));

  // CONTRACT: the caller only reports a stop once the wave is terminal, because
  // refusing the next wave must not discard siblings still running. The decision
  // table still encodes the early-abort semantics if a caller asks for it.
  check("stopped mid-wave aborts early (caller contract: only pass it when terminal)",
    act({ currentWave: 0, currentWaveTerminal: false, stopped: true }).action === "settle");
  check("a terminal wave with no stop advances",
    act({ currentWave: 0, currentWaveTerminal: true, stopped: false }).action === "launch-next");
}

// ── (o) lane precision: benign work must NOT be refused ─────
console.log("(o) lane precision (the expensive direction is a FALSE refusal):");
{
  // Every one of these was REFUSED by the first single-signal matcher. A gate
  // that blocks legitimate work is worse than no gate, so they are locked here.
  const benign = [
    "Delete the temporary files created by the test run",
    "Remove the unused imports from src/app.ts",
    "Delete the stale fixture files under test/fixtures",
    "Truncate the debug log to the last 100 lines",
    "Drop the unused local fixture column",
    "Migrate the test fixtures from yaml to json",
    "Deploy the docs site to a local container for a smoke test",
    "Publish the summarised report to the user",
    "Rotate the local test log file in /tmp",
    "Document the credential loading flow",
    "Wipe the local build cache directory",
    "Purge the stale entries from the local cache",
  ];
  const refused = benign.filter(t => classifyLane(t).lane === "closed");
  check("no benign task is refused", refused.length === 0, refused.map(t => `${t} -> ${classifyLane(t).reason}`));

  // …while genuinely irreversible work must still close, even when reworded.
  const dangerous = [
    "git push --force origin main",
    "Delete the production database",
    "Run the migrations on the staging database",
    "Wipe the user accounts table",
    "Drop table users",
    "Rotate the production credentials",
    "Deploy to production",
    "Publish to npm",
    "Terraform destroy the cluster",
    "Purge the remote backups",
  ];
  const missed = dangerous.filter(t => classifyLane(t).lane !== "closed");
  check("no dangerous task slips through", missed.length === 0, missed.map(t => `${t} -> ${classifyLane(t).lane}`));

  // The two-signal rule is what buys the precision: verb alone is not enough.
  check("verb alone does not close", classifyLane("delete the temp file").lane === "open");
  check("verb + severe target closes", classifyLane("delete the production data").lane === "closed");
  check("verb + durable target closes without a local qualifier", classifyLane("delete the session records").lane === "closed");
  check("a local qualifier neutralises a durable target", classifyLane("delete the session records from the local fixture").lane === "open");
  check("unconditional phrases still close", classifyLane("rm -rf /var/lib/data").lane === "closed");
  check("empty task is open, not refused", classifyLane("").lane === "open");
}

// ── (p) dedup registry symmetry (the trap the wave scheduler hit) ──
console.log("(p) registerTask/forgetTask must receive the SAME string:");
{
  // The scheduler launches a dependent task with an upstream preamble prepended.
  // registerTask stores the ORIGINAL text, so forgetTask must also get the
  // original — otherwise a failed wave-2 task stays "recent" and blocks its own
  // retry for the whole 5-minute dedup window.
  const original = "implement v2 parsing on top of the map";
  const launched = `Upstream results from this Trimegisto batch:\n- upstream #1 t0a [done]: Verdict: x\n\n${original}`;
  registerTask("active", original);
  check("registered original is seen as a duplicate", isDuplicateTask(original).duplicate === true);
  forgetTask(launched);
  check("forgetting the PREAMBLE text does not clear it (shows why the scheduler must pass the original)", isDuplicateTask(original).duplicate === true);
  forgetTask(original);
  check("forgetting the original clears it", isDuplicateTask(original).duplicate === false);
}

// ── (q) sticky halt flag (the scheduler's stop signal) ──────
console.log("(q) halt flag is sticky and survives an empty halt:");
{
  // `haltAll()` only kills agents that are running/waiting. If a wave is queued or
  // deferred, it kills zero — so the scheduler cannot rely on "was an agent
  // killed?" and needs this flag to honour the user's stop.
  clearHalted();
  check("starts clear", isHalted() === false);
  const killed = haltAll();
  check("haltAll kills whatever is running", killed >= 0);
  check("haltAll with nothing running still sets the flag", isHalted() === true);
  check("the flag is sticky (a second read still sees it)", isHalted() === true);
  clearHalted();
  check("clearHalted releases it", isHalted() === false);

  // The scheduler consults the flag for the terminal-most wave, so the halt is
  // honoured even when no agent exists yet (deferred first wave).
  check("a halted terminal wave settles instead of launching",
    nextWaveAction({ waveCount: 3, currentWave: -1, currentWaveTerminal: true, stopped: true, enabled: true, deadlineReached: false }).action === "settle");
}

// ── (r) regression: QA-found defects ────────────────────────
console.log("(r) QA regressions (edge-to-duplicate remap, oversized batch, lane precision):");
{
  // A `needs` target that gets merged as a duplicate must be REMAPPED to its
  // representative, not dropped: dropping it released the dependent in the same
  // wave as the node it consumes (real defect found by adversarial QA).
  const remap = planBatch([
    { task: "map the parser entry points in the codebase", writes: ["a.md"] },
    { task: "map the parser entry points in the codebase", writes: ["b.md"] },  // exact duplicate of #1
    { task: "implement the change on top of that map", needs: [2] },
  ]);
  check("duplicate target merged", remap.counts.duplicates === 1, remap.counts);
  check("dependent edge remapped to the representative", deep(remap.nodes[2].needs, [1]), remap.nodes[2].needs);
  check("dependent is in a LATER wave than its real dependency",
    remap.waves.length === 2 && remap.waves[0].includes(1) && remap.waves[1].includes(3), remap.waves);
  check("the remap is announced, not silent", has(remap.warnings, "was merged as a duplicate"), remap.warnings);

  // Oversized batch: refuse BEFORE any graph work (this also removes the stack
  // overflow that a very deep needs-chain could trigger in the reachability DFS).
  const huge = planBatch(Array.from({ length: 10000 }, (_, i) => ({ task: `task number ${i}`, needs: i ? [i] : undefined })));
  check("10k batch is refused, never throws", huge.accept === false, huge.counts);
  check("refusal is a maxTasks blocker", has(huge.blockers, "exceeds maxTasks"), huge.blockers);
  check("refused batch plans nothing", huge.waves.length === 0 && huge.launch.length === 0);
  check("refused summary still has a verdict line", huge.summary.includes("**Plan verdict:** REFUSED"));

  // Lane precision on presentation/in-memory work (QA found these refused).
  check("soft-delete in the UI is not high blast radius", classifyLane("implement soft delete for user records in the UI layer").lane !== "closed", classifyLane("implement soft delete for user records in the UI layer"));
  check("removing entries from an in-memory list is not closed", classifyLane("remove file entries from the in-memory list before rendering").lane !== "closed", classifyLane("remove file entries from the in-memory list before rendering"));
  check("a truncate helper for labels is not closed", classifyLane("add a truncate helper for long labels in the table").lane !== "closed", classifyLane("add a truncate helper for long labels in the table"));
  check("a severe target still wins over a safe qualifier", classifyLane("delete the production user records in the UI").lane === "closed", classifyLane("delete the production user records in the UI"));

  // QA found 25 more false refusals where a CRITICAL-tier word was matched in a
  // benign local/test context. Ambiguous targets now need the absence of a
  // local/ephemeral qualifier; only the critical tier overrides it.
  const stillBenign = [
    "remove the unused import from accounts.ts",
    "remove the dead code from the server module",
    "delete the stale cache on the local server",
    "remove the unused import from history.ts",
    "purge the local backup cache",
    "remove the secret santa script from the samples",
    "delete the local users fixture rows",
    "migrate the local db fixture",
    "overwrite the local server mock",
  ];
  const stillRefused = stillBenign.filter(t => classifyLane(t).lane === "closed");
  check("no ambiguous-target task is refused in a local context", stillRefused.length === 0, stillRefused);
  check("a critical target overrides a local qualifier", classifyLane("delete the local production records").lane === "closed", classifyLane("delete the local production records"));
  check("no negative wave is ever reported", nextWaveAction({ waveCount: 3, currentWave: -5, currentWaveTerminal: true, stopped: false, enabled: true, deadlineReached: false }).reason.includes("wave 1"));
}

// ── (s) transitive duplicate closure + normalised writer collisions ──
console.log("(s) transitive duplicates (union-find) and normalised writes:");
{
  // A~B and B~C are >= threshold but A~C is NOT. The old greedy pass kept A and
  // C apart and launched the same work twice; union-find closes the chain and
  // merges all three into ONE component anchored at the lowest index (#1).
  const A = "alpha bravo charlie delta echo";
  const B = "alpha bravo charlie delta echo foxtrot";
  const C = "alpha bravo charlie delta echo foxtrot golf";
  const leak = planBatch([{ task: A }, { task: B }, { task: C }]);
  check("3-chain collapses to one launched node", leak.launch.length === 1 && leak.counts.launch === 1, leak.counts);
  check("3-chain representative is the lowest index",
    leak.nodes[0].duplicateOf === undefined && leak.nodes[1].duplicateOf === 1 && leak.nodes[2].duplicateOf === 1,
    leak.nodes.map(n => n.duplicateOf));
  check("3-chain counts.duplicates = 2", leak.counts.duplicates === 2, leak.counts);
  check("3-chain duplicate #3 not in waves", deep(leak.waves, [[1]]), leak.waves);

  // A chain of four with ONE weak link (C~D < threshold) keeps two clusters: the
  // weak link must NOT over-merge #4 into the #1..#3 component.
  const chain4 = planBatch([
    { task: "alpha bravo charlie delta echo foxtrot golf hotel" },
    { task: "alpha bravo charlie delta echo foxtrot golf india" },
    { task: "alpha bravo charlie delta echo foxtrot golf juliet" },
    { task: "alpha bravo charlie delta echo kilo lima mike" },
  ]);
  check("weak link keeps two clusters", chain4.counts.duplicates === 2 && chain4.counts.launch === 2, chain4.counts);
  check("first cluster anchored at #1", chain4.nodes[1].duplicateOf === 1 && chain4.nodes[2].duplicateOf === 1, chain4.nodes.map(n => n.duplicateOf));
  check("weak-link node #4 stays unmerged", chain4.nodes[3].duplicateOf === undefined && deep(chain4.waves, [[1, 4]]), chain4.waves);

  // A fully connected cluster merges every non-representative: n-1.
  const text = "measure the latency of every request path and record the slowest operations found";
  const full = planBatch([{ task: text }, { task: text }, { task: text }, { task: text }]);
  check("fully connected cluster -> n-1 duplicates", full.counts.duplicates === 3 && full.counts.launch === 1, full.counts);

  // A `needs` pointing at ANY member of a multi-hop cluster is remapped to the
  // FINAL representative, and the dependent lands in a later wave.
  const remapChain = planBatch([
    { task: A },
    { task: B },
    { task: C },
    { task: "implement the change on top of that map", needs: [3] },
  ]);
  check("multi-hop member merged", remapChain.nodes[2].duplicateOf === 1, remapChain.nodes.map(n => n.duplicateOf));
  check("needs on deepest member remapped to #1", deep(remapChain.nodes[3].needs, [1]), remapChain.nodes[3].needs);
  check("dependent lands in a later wave",
    remapChain.waves.length === 2 && remapChain.waves[0].includes(1) && remapChain.waves[1].includes(4), remapChain.waves);

  // Writer collisions must survive spelling: `./`, backslashes, case and a
  // trailing slash all name the same file.
  const collide = (a: string, b: string) => planBatch([
    { task: "update the alpha module", writes: [a] },
    { task: "update the beta module", writes: [b] },
  ]);
  check("./src/a.ts vs src/a.ts serialise", collide("./src/a.ts", "src/a.ts").counts.serialized === 1);
  check("src\\a.ts vs SRC/A.TS serialise", collide("src\\a.ts", "SRC/A.TS").counts.serialized === 1);
  check("src/a.ts vs src/a.ts/ serialise", collide("src/a.ts", "src/a.ts/").counts.serialized === 1);

  // Different files still run in parallel.
  const distinct = collide("src/a.ts", "src/b.ts");
  check("different paths are not serialised", distinct.counts.serialized === 0 && distinct.waves.length === 1, distinct.counts);

  // Empty / whitespace-only / pure-dot writes never collide with each other.
  const empty = planBatch([
    { task: "update the alpha module", writes: [""] },
    { task: "update the beta module", writes: ["   "] },
  ]);
  check("empty writes never collide", empty.counts.serialized === 0 && empty.waves.length === 1, empty.counts);
  const dots = planBatch([
    { task: "update the alpha module", writes: ["."] },
    { task: "update the beta module", writes: ["/"] },
  ]);
  check("dot-only writes never collide", dots.counts.serialized === 0 && dots.waves.length === 1, dots.counts);
}

// ── (l) capacity-aware waves ─────────────────────────────────
// Regression: the plan gate planned a 5-wide t2 wave against a 2-slot config,
// and the launcher then refused the WHOLE batch. Planning must respect the
// per-tier concurrency cap instead of emitting a wave that can never start.
console.log("(l) tier capacity spread:");
{
  const allCap = (n: number) => ({ active: n, t1: n, t2: n, t3: n });
  const fiveT2: PlanTaskInput[] = [
    { task: "audit the authentication flow for timing leaks", tier: "t2" },
    { task: "rewrite the retry policy of the billing worker", tier: "t2" },
    { task: "profile the image resizer memory usage", tier: "t2" },
    { task: "document the webhook signature verification", tier: "t2" },
    { task: "verify the cache eviction invariants", tier: "t2" },
  ];
  const spread = planBatch(fiveT2, { tierCapacity: allCap(2) });
  check("capacity: batch still accepted", spread.accept === true, spread.blockers);
  check("capacity: all 5 launched", spread.counts.launch === 5, spread.counts);
  check("capacity: 5 t2 tasks split into 3 waves", spread.waves.length === 3, spread.waves);
  check("capacity: wave sizes are 2/2/1", deep(spread.waves.map(w => w.length), [2, 2, 1]), spread.waves);
  check("capacity: every wave stays within the cap", spread.waves.every(w => w.length <= 2), spread.waves);
  check("capacity: 3 nodes deferred", spread.counts.capacityDeferred === 3, spread.counts);
  check("capacity: real needs stay empty (no false dependency injected)",
    spread.launch.every(n => n.needs.length === 0), spread.launch.map(n => n.needs));
  check("capacity: summary explains the split",
    spread.summary.includes("### Capacity splits") && spread.summary.includes("tier `t2` cap 2/wave"), spread.summary);

  // Caps are PER TIER: a full t2 wave must not throttle independent active work.
  const perTier = planBatch([
    { task: "draft the rollout checklist for the new endpoint", tier: "active" },
    { task: "benchmark the parser on the sample corpus", tier: "active" },
    { task: "trace the slow query in the reporting service", tier: "active" },
    { task: "summarise the incident timeline from the logs", tier: "t2" },
    { task: "outline the retry semantics of the gateway", tier: "t2" },
    { task: "sketch the state machine of the job runner", tier: "t2" },
  ], { tierCapacity: allCap(2) });
  check("per-tier: accepted and fully launched", perTier.launch.length === 6, perTier.counts);
  check("per-tier: two waves, not three", perTier.waves.length === 2, perTier.waves);
  const tierCount = (w: number[], tier: string): number =>
    w.filter(i => perTier.nodes[i - 1].tier === tier).length;
  check("per-tier: wave 1 carries 2 active + 2 t2",
    tierCount(perTier.waves[0], "active") === 2 && tierCount(perTier.waves[0], "t2") === 2, perTier.waves);
  check("per-tier: wave 2 carries the remaining 1 + 1",
    tierCount(perTier.waves[1], "active") === 1 && tierCount(perTier.waves[1], "t2") === 1, perTier.waves);

  // A declared edge must survive the spread: #3 still runs after #1.
  const withDep = planBatch([
    { task: "audit the authentication flow for timing leaks", tier: "t2" },
    { task: "rewrite the retry policy of the billing worker", tier: "t2" },
    { task: "verify the cache eviction invariants", tier: "t2", needs: [1] },
    { task: "profile the image resizer memory usage", tier: "t2" },
  ], { tierCapacity: allCap(2) });
  const n1 = withDep.nodes[0];
  const n3 = withDep.nodes[2];
  check("dependency: #3 keeps needs [1]", deep(n3.needs, [1]), n3.needs);
  check("dependency: #3 stays strictly after #1", n3.wave > n1.wave, { n1: n1.wave, n3: n3.wave });
  check("dependency: waves respect the cap too", withDep.waves.every(w => w.length <= 2), withDep.waves);

  // Every spread plan must stay acyclic: a dep always lands in an earlier wave.
  const acyclic = withDep.launch.every(n => n.needs.every(d => withDep.nodes[d - 1].wave < n.wave));
  check("capacity: spreading never breaks the topological order", acyclic);

  // cap=1 is the strictest case: one node per wave, in index order.
  const serial = planBatch(fiveT2.slice(0, 3), { tierCapacity: allCap(1) });
  check("cap 1: three waves of one", deep(serial.waves, [[1], [2], [3]]), serial.waves);

  // "t0" is an alias of the active tier.
  const t0 = planBatch([
    { task: "draft the rollout checklist for the new endpoint", tier: "t0" },
    { task: "benchmark the parser on the sample corpus", tier: "t0" },
    { task: "trace the slow query in the reporting service", tier: "t0" },
  ], { tierCapacity: allCap(2) });
  check("t0 normalises to the active cap", t0.waves.length === 2 && t0.counts.capacityDeferred === 1, t0.waves);

  // Omitting the option is a no-op: old behaviour and old summary shape.
  const noCap = planBatch(fiveT2);
  check("no capacity option: single wave (previous behaviour)", noCap.waves.length === 1, noCap.waves);
  check("no capacity option: nothing deferred", noCap.counts.capacityDeferred === 0);
  check("no capacity option: no Capacity section in the summary", !noCap.summary.includes("### Capacity splits"));

  // Determinism holds with capacity spreading.
  const c1 = planBatch(fiveT2, { tierCapacity: allCap(2), goal: "harden the auth path" });
  const c2 = planBatch(fiveT2, { tierCapacity: allCap(2), goal: "harden the auth path" });
  check("capacity plan is byte-identical across runs", c1.summary === c2.summary);
  check("capacity plan deep-equal across runs", deep(c1, c2));
}

// ── (m) determinism (same-file serialisation input) ──────────
console.log("(m) determinism:");
{
  const A = "alpha bravo charlie delta echo";
  const B = "alpha bravo charlie delta echo foxtrot";
  const C = "alpha bravo charlie delta echo foxtrot golf";
  const detInput: PlanTaskInput[] = [
    { task: A, writes: ["./src/A.ts"] },
    { task: B },
    { task: C, needs: [2] },
    { task: "update the shared module", writes: ["src\\a.ts"] },
  ];
  const d1 = planBatch(detInput, { goal: "close the transitive duplicate leak" });
  const d2 = planBatch(detInput, { goal: "close the transitive duplicate leak" });
  check("transitive plan is byte-identical across runs", d1.summary === d2.summary);
  check("transitive plan deep-equal across runs", deep(d1, d2));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
