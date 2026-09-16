/**
 * Trimegisto - Idle watchdog compaction-exemption tests
 *
 * Run: node --experimental-strip-types test-agent-watchdog.ts
 *
 * Regression: a compaction is a silent one-off summarization call. On a big
 * local model it can stay quiet for minutes, and the idle watchdog was killing
 * the agent mid-compaction — which is exactly the reported "the agents ran out
 * of context and could not compact".
 */

import { shouldIdleKill, DEFAULT_COMPACTION_GRACE_MS } from "./src/agent-manager.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = 1_000_000_000;
const idle = (over: Partial<Parameters<typeof shouldIdleKill>[0]> = {}) =>
  shouldIdleKill({ now: NOW, lastProgressAt: NOW - 999_999, idleMs: 120_000, compactingSince: null, ...over });

console.log("Idle watchdog:");
{
  check("disabled watchdog (idleMs 0) never kills", idle({ idleMs: 0 }) === false);
  check("negative idleMs never kills", idle({ idleMs: -1 }) === false);
  check("idle under the limit does not kill", idle({ lastProgressAt: NOW - 60_000 }) === false);
  check("idle over the limit kills when NOT compacting", idle({ lastProgressAt: NOW - 130_000 }) === true);

  check("compacting suspends the idle kill past the limit",
    idle({ lastProgressAt: NOW - 130_000, compactingSince: NOW - 120_000 }) === false);
  check("compacting just started, long idle, still safe",
    idle({ lastProgressAt: NOW - 10 * 60_000, compactingSince: NOW - 1_000 }) === false);
  check("compaction past the grace falls through to the idle check",
    idle({ lastProgressAt: NOW - 10 * 60_000, compactingSince: NOW - DEFAULT_COMPACTION_GRACE_MS - 1 }) === true);
  check("compaction exactly at the grace is still exempt",
    idle({ lastProgressAt: NOW - 10 * 60_000, compactingSince: NOW - DEFAULT_COMPACTION_GRACE_MS }) === false);
  check("a custom grace is honored",
    idle({ lastProgressAt: NOW - 5_000, idleMs: 1_000, compactingSince: NOW - 4_000, compactionGraceMs: 10_000 }) === false);
  check("a custom grace can expire",
    idle({ lastProgressAt: NOW - 5_000, idleMs: 1_000, compactingSince: NOW - 4_000, compactionGraceMs: 2_000 }) === true);

  check("NaN compactingSince is ignored", idle({ lastProgressAt: NOW - 130_000, compactingSince: NaN }) === true);
  check("undefined compactingSince is ignored", idle({ lastProgressAt: NOW - 130_000, compactingSince: undefined }) === true);
  check("default grace is 30 minutes", DEFAULT_COMPACTION_GRACE_MS === 30 * 60_000);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
