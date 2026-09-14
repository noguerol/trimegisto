/**
 * Trimegisto - Wave scheduler (the driver between plan nodes)
 *
 * `plan-graph.ts` decides WHICH nodes exist and their order (waves).
 * This module decides WHEN each wave runs: one wave at a time, the next only
 * after the current one is terminal, and exactly one settle at the end.
 *
 * It is extracted from the extension on purpose. Two of the nastiest defects of
 * the original inline version were invisible to unit tests:
 *
 *   1. RE-ENTRANCY. `launchAgent` calls `notifyStateChange()` synchronously
 *      while registering the agent, which drives the state-change callback back
 *      into the scheduler *before* `currentWave` had advanced and with an empty
 *      wave set. A nested `advanceWaves` therefore concluded "the wave is
 *      already finished" and either launched the next wave early (violating the
 *      declared dependency) or settled the whole batch with no results at all.
 *   2. RECURSION. The old "a wave may finish instantly" self-call grew the
 *      stack once per wave.
 *
 * Here the guard is a WeakSet keyed by the caller's state object and the walk is
 * an iterative loop, so both are exercised directly by `test-wave-scheduler.ts`.
 */

import { nextWaveAction } from "./plan-graph.ts";

/** Mutable per-batch scheduler state. The caller owns the object. */
export interface WaveRunState {
  /** Wave currently in flight; -1 before the first one is launched. */
  currentWave: number;
  /** Set by the caller (via `settle`) once the batch conclusion was emitted. */
  settled: boolean;
}

/** Everything the scheduler needs; all effects are injected. */
export interface WaveRunDeps {
  /** Total number of waves in the plan. */
  waveCount: number;
  /** Is the wave at this index (>= 0) finished? */
  isCurrentWaveTerminal(currentWave: number): boolean;
  /** An agent of the current wave was killed or halted. */
  isStopped(): boolean;
  /** A global halt is in force (sticky `/tmg halt`). */
  isHalted(): boolean;
  /** Trimegisto is still enabled. */
  isEnabled(): boolean;
  /** The batch deadline passed. */
  isDeadlineReached(): boolean;
  /** Launch wave `waveIndex` (0-based). Return false to defer (retry later). */
  launchWave(waveIndex: number): boolean;
  /** Emit the single conclusion. Must mark the state settled. */
  settle(reason: string): void;
}

/**
 * Internal safety net: the maximum number of wave launches a single
 * `advanceWaves` call may perform before stopping cleanly. With the entry
 * normalisation below the loop is already monotone for every input; this cap
 * bounds it even if an injected dependency tampers with the counter, so the
 * function terminates for EVERY input within
 * `min(waveCount, MAX_WAVE_ITERATIONS) + 1` loop passes.
 */
export const MAX_WAVE_ITERATIONS = 64;

/**
 * Normalise a wave counter to a safe integer >= -1.
 * NaN / ±Infinity / anything non-finite behaves like "before the first wave";
 * fractional values floor down; finite values beyond the safe-integer range
 * clamp to `Number.MAX_SAFE_INTEGER`.
 */
function normalizeWave(value: number): number {
  if (!Number.isFinite(value)) return -1;
  return Math.max(-1, Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
}

/**
 * States currently inside `advanceWaves`. A WeakSet keeps this leak-free: the
 * entry disappears with the batch object.
 */
const advancing = new WeakSet<WaveRunState>();

/** True while this state is inside `advanceWaves` (used by tests and callers). */
export function isAdvancing(state: WaveRunState): boolean {
  return advancing.has(state);
}

/**
 * Drive one batch across its waves. Idempotent, re-entrancy-safe and iterative.
 *
 * Precedence of the settle conditions lives in `nextWaveAction`; this function
 * only supplies the facts. Note the deliberate contract: `isStopped`/`isHalted`
 * are ANDed with "the current wave is terminal", so killing one agent does not
 * discard the results of its siblings that are still running — the wave is
 * awaited and only the NEXT one is refused. While a wave is running the only
 * thing that can settle is the deadline.
 */
export function advanceWaves(state: WaveRunState, deps: WaveRunDeps): void {
  if (!state || state.settled) return;
  if (advancing.has(state)) return; // nested call: the outer frame owns the truth
  // The scheduler owns this counter: normalise it at entry and WRITE the
  // normalised value back to the caller's object, so a non-finite or
  // fractional value can never survive a call (a raw NaN made the
  // `currentWave++` loop below non-terminating, and 1.5 / -2 passed
  // fractional or negative indexes to `launchWave`).
  state.currentWave = normalizeWave(state.currentWave);
  advancing.add(state);
  try {
    let iterations = 0;
    for (;;) {
      if (state.settled) return;

      const terminal = state.currentWave < 0 ? true : !!deps.isCurrentWaveTerminal(state.currentWave);
      // The deadline is the only thing that can settle while a wave is running.
      //
      // `isStopped()` ("an agent of the current wave was killed") is only
      // meaningful once a wave exists — before the first launch there is no
      // agent to kill, and treating a stale flag as a stop would settle the
      // batch before spawning anything. A HALT is global and does apply before
      // the first wave (that is what makes `/tmg halt` stick while a wave is
      // still queued for capacity).
      const stopped = terminal && ((state.currentWave >= 0 && deps.isStopped()) || deps.isHalted());

      const decision = nextWaveAction({
        waveCount: deps.waveCount,
        currentWave: state.currentWave,
        currentWaveTerminal: terminal,
        stopped,
        enabled: deps.isEnabled(),
        deadlineReached: deps.isDeadlineReached(),
      });

      if (decision.action === "wait") return;
      if (decision.action === "settle") {
        deps.settle(decision.reason);
        return;
      }

      // "launch-next": a wave that cannot start yet (tier capacity) defers the
      // whole batch; the caller retries later and nothing is half-launched.

      // Iteration cap: stop cleanly instead of spinning. Settles AT MOST once
      // and respects `state.settled` (the single-settle contract). The check
      // runs AFTER the decision so a batch that completes legitimately keeps
      // its real settle reason.
      if (++iterations > MAX_WAVE_ITERATIONS) {
        if (!state.settled) deps.settle(`wave iteration cap exceeded (${MAX_WAVE_ITERATIONS})`);
        return;
      }

      const nextWave = state.currentWave + 1;
      let started: boolean;
      try {
        started = !!deps.launchWave(nextWave);
      } catch (err) {
        // A `launchWave` that throws mid-wave can leave the adapter's wave set
        // inconsistent (e.g. still holding the PREVIOUS wave). Re-launching
        // the same index would then double-spawn agents, so the batch settles
        // exactly once and that index is never launched again.
        if (!state.settled) {
          deps.settle(`wave launch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      if (!started) return;
      // DOUBLE-SPAWN GUARD (invariant): this increment runs ONLY after
      // `launchWave` returned success. A deferred, failed or throwing launch
      // therefore leaves `currentWave` untouched and the scheduler can never
      // launch the same wave index twice.
      state.currentWave++;
      // Loop, do not recurse: a wave may be terminal immediately (e.g. every
      // node failed synthetically), and 1000 waves must not grow the stack.
    }
  } finally {
    advancing.delete(state);
  }
}
