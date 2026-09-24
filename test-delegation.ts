/**
 * Trimegisto - delegation contract tests
 *
 * Run: node --experimental-strip-types test-delegation.ts
 *
 * The contract is the policy that makes delegation the DEFAULT when
 * Trimegisto is active. Its two halves are tested here:
 *
 *   1. the text the coordinator reads (default-delegate + capacity fill +
 *      atomic allowlist), which must never drift back into the old opt-in
 *      "prefer delegating" wording that left every slot idle; and
 *   2. the deterministic prompt analysis that reinforces it (and, just as
 *      important, stays QUIET on genuine one-liners so it does not nag).
 *
 * The detector is the only heuristic in the path, so its false-positive
 * corpus is deliberately adversarial.
 */

import {
  totalSlots,
  formatCapacitySummary,
  formatDelegationContract,
  analyzeDecomposability,
  formatDecomposabilityNote,
} from "./src/delegation.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

const slots = [
  { tier: "Active", slots: 2 },
  { tier: "T1", slots: 1 },
  { tier: "T2", slots: 4 },
  { tier: "T3", slots: 4 },
];

console.log("totalSlots / formatCapacitySummary: the capacity the coordinator must fill:");
{
  check("sums the positives", totalSlots(slots) === 11, totalSlots(slots));
  check("ignores zero / negative / non-finite entries",
    totalSlots([{ tier: "T2", slots: 0 }, { tier: "T3", slots: -3 }, { tier: "T1", slots: NaN } as any, { tier: "Active", slots: 2 }]) === 2);
  check("empty list is 0", totalSlots([]) === 0);
  check("summary names the total and every tier",
    formatCapacitySummary(slots) === "11 parallel slots configured (Active 2, T1 1, T2 4, T3 4).",
    formatCapacitySummary(slots));
  check("a single slot reads singular",
    formatCapacitySummary([{ tier: "Active", slots: 1 }]) === "1 parallel slot configured (Active 1).");
  check("no usable slots -> empty string (nothing to advertise)", formatCapacitySummary([]) === "");
  check("all-zero slots -> empty string",
    formatCapacitySummary([{ tier: "T2", slots: 0 }]) === "");
}

console.log("formatDelegationContract: auto-spawn ON inverts the default:");
{
  const out = formatDelegationContract({ autoSpawn: true, capacity: slots });
  check("declares delegate as the default", /default is to delegate/i.test(out), out);
  check("names the atomic allowlist (single question / one file / non-parallel command)",
    /single question/i.test(out) && /one small change in one file/i.test(out) && /cannot run in parallel/i.test(out));
  check("rejects 'I am faster' as an excuse", /faster.*not a reason/i.test(out));
  check("embeds the real capacity to fill", out.includes("11 parallel slots configured (Active 2, T1 1, T2 4, T3 4)."));
  check("requires disjoint units", /disjoint/i.test(out));
  check("requires one batch + integration", /one batch, then integrate/i.test(out));
  check("never contains the hijack phrasing", !/FIRST action MUST/i.test(out));
}

console.log("formatDelegationContract: ON without usable capacity still pushes the fill:");
{
  const out = formatDelegationContract({ autoSpawn: true, capacity: [] });
  check("keeps the fill rule with no numbers when capacity is unknown", /Fill the capacity/i.test(out) && !/parallel slots? configured/.test(out));
}

console.log("formatDelegationContract: auto-spawn OFF stays opt-in:");
{
  const out = formatDelegationContract({ autoSpawn: false, capacity: slots });
  check("says delegation is opt-in", /opt-in/i.test(out));
  check("does NOT advertise capacity (no batch is expected)", !out.includes("parallel slots configured"));
  check("still asks for disjoint units when it DOES delegate", /disjoint/i.test(out));
  check("does not carry the aggressive default", !/default is to delegate/i.test(out));
}

console.log("analyzeDecomposability: genuine one-liners must NOT be flagged:");
{
  const negatives = [
    "arregla el typo",
    "fix the typo",
    "\u00bfqu\u00e9 hace este archivo?",
    "what does this function do?",
    "mu\u00e9strame el contenido de src/index.ts",
    "explain src/delegation.ts",
    "compila el proyecto",
    "run the tests",
    "add a semicolon",
    "revisa esto y dime qu\u00e9 opinas",
  ];
  for (const p of negatives) {
    const a = analyzeDecomposability(p);
    check(`not decomposable: "${p.length > 48 ? p.slice(0, 45) + "..." : p}"`, !a.decomposable, `${a.score} [${a.signals.join(" | ")}]`);
  }
}

console.log("analyzeDecomposability: multi-unit requests ARE flagged:");
{
  const positives: Array<[string, string]> = [
    ["two files named", "arregla src/a.ts y a\u00f1ade un test en test-a.ts"],
    ["explicit list", "haz estas dos cosas:\n- arregla el parser\n- actualiza el README"],
    ["three actions", "crea el endpoint, a\u00f1ade tests y documenta la API"],
    ["two files + two verbs", "refactoriza src/index.ts and update test-index.ts"],
    ["long multi-part request", "necesito que revises el m\u00f3dulo de configuraci\u00f3n, que a\u00f1adas validaci\u00f3n a los campos, que actualices los tests de config.ts y que documentes el cambio en el README"],
  ];
  for (const [label, p] of positives) {
    const a = analyzeDecomposability(p);
    check(`decomposable (${label})`, a.decomposable, `${a.score} [${a.signals.join(" | ")}]`);
  }
}

console.log("analyzeDecomposability: edge inputs are safe:");
{
  check("empty string is not decomposable", !analyzeDecomposability("").decomposable);
  check("whitespace is not decomposable", !analyzeDecomposability("   \n \t ").decomposable);
  check("undefined-ish is not decomposable", !analyzeDecomposability(undefined as any).decomposable);
  check("a single file alone is not enough (score 1)", !analyzeDecomposability("src/a.ts").decomposable);
  check("signals are always an array", Array.isArray(analyzeDecomposability("x").signals));
  check("comma-separated paths all count (no run-on false negative)",
    analyzeDecomposability("diff src/a.ts,src/b.ts").signals.includes("2 files"),
    analyzeDecomposability("diff src/a.ts,src/b.ts").signals.join(" | "));
  check("paths inside a JSON array count",
    analyzeDecomposability('update ["src/a.ts","src/b.ts"]').signals.includes("2 files"));
  check("oversized payload does not throw or hang", (() => {
    const t0 = Date.now();
    const a = analyzeDecomposability("x ".repeat(60_000));
    return a.decomposable === false && Date.now() - t0 < 2_000;
  })());
}

console.log("formatDecomposabilityNote: speaks only when the prompt splits:");
{
  const note = formatDecomposabilityNote(analyzeDecomposability("arregla src/a.ts y a\u00f1ade un test en test-a.ts"));
  check("non-empty for a decomposable prompt", note.length > 0, note);
  check("names the signals", note.includes("files"), note);
  check("tells the coordinator to plan the batch BEFORE the first edit", /before your first edit/i.test(note));
  check("keeps the atomic escape hatch", /atomic/i.test(note));
  check("empty for an atomic prompt",
    formatDecomposabilityNote(analyzeDecomposability("fix the typo")) === "");
  check("empty for a missing analysis", formatDecomposabilityNote(undefined as any) === "");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
