/**
 * Trimegisto - batch ledger tests
 *
 * Run: node --experimental-strip-types test-ledger.ts
 *
 * The ledger is the on-disk substrate from arXiv:2608.26480 §3.1 (plan.md,
 * tasks.json, notes.md), adapted to a batch and deliberately loop-ready.
 *
 * Covers: path safety, init/read round-trip, task linking/updating, plan and
 * notes rendering, pruning, and the hard guarantee that every write is
 * best-effort (a read-only / bogus location must never throw).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ledgerRoot,
  ledgerDir,
  initLedger,
  writeLedger,
  readLedger,
  setLedgerTaskAgent,
  updateLedgerTask,
  renderPlanMd,
  renderNotesMd,
  writeLedgerNotes,
  pruneLedgers,
  DEFAULT_LEDGER_MAX_AGE_MS,
  type LedgerState,
} from "./src/ledger.ts";
import { readNotesSnapshot, publishNote } from "./src/shared-context.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "trimegisto-ledger-"));

function freshState(batchId = "batch-1"): LedgerState {
  return {
    version: 1,
    batchId,
    goal: "harden the parser",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks: [
      { index: 1, tier: "active", task: "read parser.ts | map it", wave: 1, status: "pending", verify: "npm test" },
      { index: 2, tier: "t2", task: "fix the empty-input branch", wave: 2, needs: [1], status: "pending" },
    ],
  };
}

// ── paths ─────────────────────────────────────────────────
console.log("\npaths");
check("root under instance", ledgerRoot(instanceDir) === path.join(instanceDir, "batches"));
check("dir uses batchId", ledgerDir(instanceDir, "batch-3") === path.join(instanceDir, "batches", "batch-3"));
check("path traversal cannot escape root", path.resolve(ledgerDir(instanceDir, "../../etc")).startsWith(path.resolve(ledgerRoot(instanceDir)) + path.sep));
check("spaces/colons sanitised", ledgerDir(instanceDir, "a b:c").endsWith("a_b_c"));
check("empty batchId has a fallback", ledgerDir(instanceDir, "").endsWith("batch"));

// ── init / read round-trip ────────────────────────────────
console.log("\ninit + read round-trip");
const dir = initLedger(instanceDir, freshState());
check("init returns a dir", typeof dir === "string" && dir!.length > 0);
check("plan.md written", fs.existsSync(path.join(dir!, "plan.md")));
check("tasks.json written", fs.existsSync(path.join(dir!, "tasks.json")));
check("no .tmp leftovers", fs.readdirSync(dir!).every(f => !f.includes(".tmp-")));
const round = readLedger(dir!);
check("read back the batchId", round?.batchId === "batch-1");
check("read back 2 tasks", round?.tasks.length === 2);
check("verify survived", round?.tasks[0].verify === "npm test");
check("goal survived", round?.goal === "harden the parser");

// ── task linking / updating ───────────────────────────────
console.log("\ntask linking + updating");
const st = freshState("batch-2");
check("link task 1", setLedgerTaskAgent(st, 1, "t0a") === true);
check("link unknown index is false", setLedgerTaskAgent(st, 99, "t0z") === false);
check("update by agentId", updateLedgerTask(st, { agentId: "t0a" }, { status: "done", verdict: "ok" }) === true);
check("status applied", st.tasks[0].status === "done");
check("update by index on unlinked task", updateLedgerTask(st, { index: 2 }, { status: "error" }) === true);
check("index update applied", st.tasks[1].status === "error");
check("unknown match is false", updateLedgerTask(st, { agentId: "nope" }, { status: "done" }) === false);
check("verification attached", (() => {
  updateLedgerTask(st, { agentId: "t0a" }, { verification: { ran: true, passed: false, exitCode: 1 } });
  return st.tasks[0].verification?.passed === false;
})());
check("null state is safe", updateLedgerTask(null, { index: 1 }, { status: "done" }) === false);
check("stamps updatedAt", typeof st.tasks[0].updatedAt === "number");

// ── rendering ─────────────────────────────────────────────
console.log("\nrendering");
const md = renderPlanMd(freshState("batch-9"));
check("plan has a header", md.includes("# 🪡 Trimegisto ledger · batch-9"));
check("plan shows the goal", md.includes("harden the parser"));
check("plan has a task table", md.includes("| # | wave | tier | status | verify | task |"));
check("plan shows the verify command", md.includes("`npm test`"));
check("plan escapes pipes in cells", md.includes("read parser.ts \\| map it"));
check("plan is loop-ready", md.includes("manager-loop would curate"));
const nmd = renderNotesMd([{ agentId: "t2a", text: "found a\nmultiline fact", ts: 1 }]);
check("notes lists the agent", nmd.includes("**[t2a]**"));
check("notes flatten newlines", nmd.includes("found a multiline fact"));
check("empty notes have a placeholder", renderNotesMd([]).includes("no notes were published"));

// ── notes snapshot from shared-context ────────────────────
console.log("\nnotes snapshot");
publishNote(instanceDir, "t1a", "the parser rejects empty input");
publishNote(instanceDir, "t2b", "the fix is in parse()");
const snap = readNotesSnapshot(instanceDir);
check("snapshot reads both notes", snap.length === 2, snap.length);
check("snapshot is ascending by ts", snap[0].ts <= snap[1].ts);
check("snapshot carries agentId", snap.some(n => n.agentId === "t1a"));
check("writeLedgerNotes writes notes.md", writeLedgerNotes(dir!, snap) && fs.existsSync(path.join(dir!, "notes.md")));
check("notes.md has the facts", fs.readFileSync(path.join(dir!, "notes.md"), "utf-8").includes("rejects empty input"));

// ── best-effort (never throws) ────────────────────────────
console.log("\nbest-effort guarantees");
let threw = false;
try {
  check("initLedger with empty dir → null", initLedger("", freshState()) === null);
  check("writeLedger with empty dir → false", writeLedger("", freshState()) === false);
  check("readLedger on missing → null", readLedger(path.join(instanceDir, "nope")) === null);
  check("writeLedgerNotes on missing dir → false", writeLedgerNotes("", []) === false);
  const filePath = path.join(instanceDir, "a-file");
  fs.writeFileSync(filePath, "x");
  check("init under a FILE path → null (no throw)", initLedger(filePath, freshState()) === null);
  check("prune on missing root → 0", pruneLedgers(path.join(instanceDir, "missing"), 1) === 0);
} catch { threw = true; }
check("no call threw", threw === false);

// ── pruning ───────────────────────────────────────────────
console.log("\npruning");
const oldDir = initLedger(instanceDir, freshState("batch-old"));
const newDir = initLedger(instanceDir, freshState("batch-new"));
const old = (Date.now() - DEFAULT_LEDGER_MAX_AGE_MS - 60_000) / 1000;
fs.utimesSync(oldDir!, old, old);
const removed = pruneLedgers(instanceDir, DEFAULT_LEDGER_MAX_AGE_MS);
check("one old ledger pruned", removed === 1, removed);
check("old dir gone", !fs.existsSync(oldDir!));
check("new dir kept", fs.existsSync(newDir!));
check("pruning again is a no-op", pruneLedgers(instanceDir, DEFAULT_LEDGER_MAX_AGE_MS) === 0);

fs.rmSync(instanceDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
