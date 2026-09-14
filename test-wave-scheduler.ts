/**
 * Trimegisto - Wave scheduler tests
 *
 * Run: node --experimental-strip-types test-wave-scheduler.ts
 *
 * The scheduler is the driver the adversarial QA pass broke twice, so it is
 * tested directly instead of through the extension:
 *  - one wave at a time; the next only when the current one is terminal
 *  - RE-ENTRANCY: `launchAgent` drives the scheduler synchronously while the
 *    agent registers, so a nested advance must be a no-op (the production bug
 *    launched the next wave early or settled with no results)
 *  - iterative: a thousand waves must not grow the stack
 *  - a stopped/halted wave is awaited, then refuses the NEXT wave
 *  - a deferred wave (no capacity) is retried, never half-launched
 */

import { advanceWaves, isAdvancing, type WaveRunDeps, type WaveRunState } from "./src/wave-scheduler.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

interface Rig {
  state: WaveRunState;
  deps: WaveRunDeps;
  launched: number[];
  settles: string[];
  /** Mark a wave terminal from the outside (simulates agents finishing). */
  finish(waveIndex: number): void;
}

function rig(waveCount: number, over: Partial<WaveRunDeps> = {}): Rig {
  const state: WaveRunState = { currentWave: -1, settled: false };
  const launched: number[] = [];
  const settles: string[] = [];
  const terminal = new Set<number>();
  const deps: WaveRunDeps = {
    waveCount,
    isCurrentWaveTerminal: (w) => terminal.has(w),
    isStopped: () => false,
    isHalted: () => false,
    isEnabled: () => true,
    isDeadlineReached: () => false,
    launchWave: (i) => { launched.push(i); return true; },
    settle: (reason) => { settles.push(reason); state.settled = true; },
    ...over,
  };
  return { state, deps, launched, settles, finish: (w) => terminal.add(w) };
}

console.log("Test 1 (one wave at a time):");
{
  const r = rig(3);
  advanceWaves(r.state, r.deps);
  check("launches exactly wave 0", r.launched.length === 1 && r.launched[0] === 0, r.launched);
  check("does not settle while the wave runs", r.settles.length === 0 && r.state.settled === false, r.settles);
  check("currentWave advanced once", r.state.currentWave === 0, r.state.currentWave);
  r.finish(0);
  advanceWaves(r.state, r.deps);
  check("after the wave finishes it launches wave 1", r.launched.join(",") === "0,1", r.launched);
  r.finish(1);
  advanceWaves(r.state, r.deps);
  check("then wave 2", r.launched.join(",") === "0,1,2", r.launched);
  check("still not settled (last wave running)", r.state.settled === false);
  r.finish(2);
  advanceWaves(r.state, r.deps);
  check("settles exactly once when the last wave is terminal", r.settles.length === 1, r.settles);
  check("settle reason is 'all waves complete'", r.settles[0] === "all waves complete", r.settles[0]);
  check("state is settled", r.state.settled === true);
  advanceWaves(r.state, r.deps);
  check("settled is a no-op afterwards", r.launched.length === 3 && r.settles.length === 1);
}

console.log("Test 2 (re-entrancy — the production bug):");
{
  // `launchWave` re-enters synchronously, exactly like launchAgent ->
  // notifyStateChange -> sweepBatches -> advanceWaves.
  let nestedCalls = 0;
  let sawGuard = false;
  const r = rig(2, {
    launchWave: (i) => {
      r.launched.push(i);
      sawGuard = sawGuard || isAdvancing(r.state);
      nestedCalls++;
      advanceWaves(r.state, r.deps); // <-- the re-entrant call
      return true;
    },
  });
  advanceWaves(r.state, r.deps);
  check("the outer frame stays inside advanceWaves during launch", sawGuard);
  check("the nested advance did not launch a second wave", r.launched.join(",") === "0", r.launched);
  check("the nested advance did not settle the batch", r.settles.length === 0 && r.state.settled === false, r.settles);
  check("launchWave was called once", nestedCalls === 1, nestedCalls);
  check("the guard is released after the outer frame", isAdvancing(r.state) === false);

  // Re-entrancy with a wave that is terminal immediately must still advance
  // through the loop, not through recursion.
  const instant = rig(3, {
    launchWave: (i) => { instant.launched.push(i); instant.finish(i); instant.deps.isCurrentWaveTerminal = () => true; return true; },
  });
  advanceWaves(instant.state, instant.deps);
  check("instant waves walk to the end in one call", instant.launched.join(",") === "0,1,2", instant.launched);
  check("and settle once", instant.settles.length === 1, instant.settles);
}

console.log("Test 3 (deferral for capacity):");
{
  let ok = false;
  const r = rig(2, { launchWave: (i) => { if (!ok) return false; r.launched.push(i); return true; } });
  advanceWaves(r.state, r.deps);
  check("a deferred wave launches nothing", r.launched.length === 0 && r.state.currentWave === -1, r.launched);
  check("a deferred wave does not settle", r.state.settled === false);
  ok = true;
  advanceWaves(r.state, r.deps);
  check("the retry launches it", r.launched.join(",") === "0", r.launched);
  check("currentWave only advances on a real launch", r.state.currentWave === 0, r.state.currentWave);
}

console.log("Test 4 (stop / halt):");
{
  const stopped = rig(3, { isStopped: () => true });
  advanceWaves(stopped.state, stopped.deps);
  check("a stop at a running wave does not settle yet (siblings keep running)", stopped.launched.length === 1 && stopped.settles.length === 0, stopped.settles);
  stopped.finish(0);
  advanceWaves(stopped.state, stopped.deps);
  check("once the wave is terminal the stop settles instead of launching", stopped.launched.length === 1 && stopped.settles.length === 1, stopped.settles);
  check("the stop reason names the cause", /stopped/.test(stopped.settles[0] || ""), stopped.settles[0]);

  const halted = rig(3, { isHalted: () => true });
  advanceWaves(halted.state, halted.deps);
  check("a global halt refuses the very first wave", halted.launched.length === 0 && halted.settles.length === 1, halted.settles);

  // Halt arriving while wave 0 is deferred (no agent exists to kill).
  const deferredHalt = rig(2, { isHalted: () => true, launchWave: () => false });
  advanceWaves(deferredHalt.state, deferredHalt.deps);
  check("a halt with a deferred first wave still settles", deferredHalt.settles.length === 1, deferredHalt.settles);
}

console.log("Test 5 (deadline / disabled):");
{
  const late = rig(3, { isDeadlineReached: () => true });
  advanceWaves(late.state, late.deps);
  check("an expired deadline refuses to start", late.launched.length === 0 && late.settles.length === 1, late.settles);
  check("deadline reason is reported", /deadline/.test(late.settles[0] || ""), late.settles[0]);

  const running = rig(3, { isDeadlineReached: () => true });
  let first = true;
  running.deps.isDeadlineReached = () => !first;   // deadline arrives while the wave runs
  advanceWaves(running.state, running.deps);
  check("the first wave starts before the deadline", running.launched.length === 1);
  first = false;
  running.deps.isCurrentWaveTerminal = () => false;
  advanceWaves(running.state, running.deps);
  check("a deadline while the wave runs settles it", running.settles.length === 1, running.settles);
  check("reason names the running wave", /while a wave was running/.test(running.settles[0] || ""), running.settles[0]);

  const disabled = rig(3, { isEnabled: () => false });
  advanceWaves(disabled.state, disabled.deps);
  check("disabled refuses to start", disabled.launched.length === 0 && disabled.settles.length === 1, disabled.settles);
}

console.log("Test 6 (scale + degenerate input):");
{
  const many = rig(1000);
  many.deps.isCurrentWaveTerminal = () => true;   // every wave finishes instantly
  advanceWaves(many.state, many.deps);
  check("1000 waves run iteratively without a stack overflow", many.launched.length === 1000, many.launched.length);
  check("and settle exactly once", many.settles.length === 1, many.settles);

  const zero = rig(0);
  advanceWaves(zero.state, zero.deps);
  check("zero waves settles immediately", zero.launched.length === 0 && zero.settles.length === 1, zero.settles);

  const done: WaveRunState = { currentWave: 1, settled: true };
  const r = rig(3);
  r.deps.settle = () => { throw new Error("must not be called"); };
  advanceWaves(done, r.deps);
  check("an already-settled state is a no-op", r.launched.length === 0);

  let threw = false;
  try { advanceWaves(undefined as unknown as WaveRunState, r.deps); } catch { threw = true; }
  check("undefined state does not throw", threw === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
