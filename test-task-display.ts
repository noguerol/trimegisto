/**
 * Trimegisto - display-task tests
 *
 * Run: node --experimental-strip-types test-task-display.ts
 *
 * The upstream-dependency preamble is scaffolding for the worker; it must never
 * reach the user. `displayTaskOf` is the one place that decides what a human
 * sees, so every render path can call it.
 */

import { displayTaskOf } from "./src/task-display.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

const PREAMBLE = "Upstream results from this Trimegisto batch (you depend on them — build on them, do not re-derive):\n- upstream #1 t0a [done]: verdict\n\n";

console.log("displayTaskOf: the original task wins over the launched text:");
{
  check("displayTask is preferred",
    displayTaskOf({ task: `${PREAMBLE}implementa login`, displayTask: "implementa login" }) === "implementa login");
  check("falls back to task when displayTask is absent",
    displayTaskOf({ task: "solo task" }) === "solo task");
  check("falls back to task when displayTask is empty",
    displayTaskOf({ task: "solo task", displayTask: "" }) === "solo task");
  check("falls back to task when displayTask is whitespace",
    displayTaskOf({ task: "solo task", displayTask: "   " }) === "solo task");
  check("null/undefined is empty", displayTaskOf(null) === "" && displayTaskOf(undefined) === "");
  check("non-string displayTask falls back", displayTaskOf({ task: "t", displayTask: 42 as any }) === "t");
  check("missing both is empty", displayTaskOf({} as any) === "");
  check("the preamble never leaks through when displayTask is set",
    !displayTaskOf({ task: `${PREAMBLE}x`, displayTask: "x" }).includes("Upstream results"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
