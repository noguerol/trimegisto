/**
 * Trimegisto - metrics latch
 *
 * The dashboard's live throughput is sampled from whatever agents are running
 * *right now*. When agents churn (one finishes while the next starts) the sum
 * drops to 0 for a tick and the number vanishes from the widget/footer, then
 * reappears: visually noisy for no informational reason.
 *
 * A ValueLatch holds the last positive value for a short grace window, so a
 * brief gap between agents shows the value that was just live instead of
 * blinking the field away. It is NOT a rate limiter and does not change the
 * update frequency; it only decides whether a momentarily-zero metric should
 * render as zero or as "still effectively that".
 *
 * Pure and clock-injected so the hold/expire boundary is unit-tested.
 */

export const METRICS_HOLD_MS = 5_000;

export class ValueLatch {
  private held = new Map<string, { value: number; at: number }>();
  private readonly holdMs: number;

  constructor(holdMs: number = METRICS_HOLD_MS) {
    this.holdMs = Number.isFinite(holdMs) && holdMs >= 0 ? holdMs : METRICS_HOLD_MS;
  }

  /**
   * Record `value` for `key` at `now` and return what should be displayed:
   *   - a positive value is returned as-is (and remembered);
   *   - a zero/NaN/negative value returns the last positive one while it is
   *     within `holdMs`, otherwise 0.
   */
  update(key: string, value: number, now: number): number {
    const v = Number.isFinite(value) && value > 0 ? value : 0;
    if (v > 0) {
      this.held.set(key, { value: v, at: now });
      return v;
    }
    const prev = this.held.get(key);
    if (prev && now - prev.at <= this.holdMs) return prev.value;
    this.held.delete(key);
    return 0;
  }

  /** Drop every held value (session reset / disabled). */
  reset(): void {
    this.held.clear();
  }
}
