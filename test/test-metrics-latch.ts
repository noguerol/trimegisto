/**
 * Trimegisto - metrics latch tests
 *
 * Run: node --experimental-strip-types test-metrics-latch.ts
 *
 * Agents churn: a sum that is live one second is zero the next, and the widget
 * blinked the field away. The latch holds the last positive value for a short
 * grace window without changing the update frequency.
 */

import { ValueLatch, METRICS_HOLD_MS } from "../src/metrics-latch.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

console.log("ValueLatch: hold a momentarily-zero metric, then let it go:");
{
  const latch = new ValueLatch(5_000);
  check("positive value passes through", latch.update("a", 42, 1000) === 42);
  check("zero within the window holds the last value", latch.update("a", 0, 3000) === 42);
  check("still held at the boundary", latch.update("a", 0, 6000) === 42);
  check("expires just past the window", latch.update("a", 0, 6001) === 0);
  check("after expiry it stays 0", latch.update("a", 0, 7000) === 0);
  check("a new positive value re-arms it", latch.update("a", 7, 8000) === 7);
  check("hold window restarts from the new sample", latch.update("a", 0, 12_000) === 7);
}

console.log("ValueLatch: keys are independent and junk is ignored:");
{
  const latch = new ValueLatch(1_000);
  latch.update("x", 5, 0);
  latch.update("y", 9, 0);
  check("x holds while y updates", latch.update("x", 0, 500) === 5 && latch.update("y", 3, 500) === 3);
  check("unknown key is 0", latch.update("z", 0, 500) === 0);
  check("NaN is treated as zero and holds", latch.update("x", NaN, 600) === 5);
  check("negative is treated as zero and holds", latch.update("x", -4, 700) === 5);
  latch.reset();
  check("reset clears the held values", latch.update("x", 0, 700) === 0 && latch.update("y", 0, 700) === 0);
}

console.log("ValueLatch: hold window sanity:");
{
  const latch = new ValueLatch(0);
  latch.update("a", 1, 0);
  check("holdMs=0 does not hold a zero", latch.update("a", 0, 1) === 0);
  const junk = new ValueLatch(NaN as any);
  junk.update("a", 3, 0);
  check("NaN holdMs falls back to the default window", junk.update("a", 0, 1) === 3);
  check("default export is 5s", METRICS_HOLD_MS === 5000);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
