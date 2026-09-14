/**
 * Trimegisto - tier-status formatter
 *
 * Pure formatting helpers for the per-tier status lines used by both the
 * tool description (so the coordinator's system prompt is correct) and the
 * per-turn directive (so the coordinator's user-prompt context is correct).
 *
 * Keeping this separate from index.ts lets the regression tests verify the
 * shape of the message that reaches the model — including the per-tier
 * parallel cap, which is the only way the coordinator learns that t2 only
 * has 2 slots without trying and bouncing off the wave-capacity gate.
 */

export interface TierStatusOpts {
  /** Whether the tier is currently spawnable (model configured + enabled). */
  enabled: boolean;
  /** Short reason for !enabled, e.g. " (disabled)", " (no model)" — empty when enabled. */
  reason: string;
  /** Humanised model id (already with the redundant-models suffix if any). */
  model: string;
  /** Remaining seconds on the circuit breaker, or null when not paused. */
  pausedSeconds: number | null;
  /** Per-tier parallel capacity, or null when unknown / not applicable. */
  maxParallel: number | null;
}

/**
 * Build the single-tier status line. Pure: same input → same output.
 *   `- T2: ✓ ENABLED [deepseek-v4-flash] (max 2 parallel)`
 *   `- T1: ✗ unavailable (no model) [no model]`
 *   `- t2: ✓ ENABLED [...] ⛔ paused 47s (max 4 parallel)`
 */
export function formatTierStatusLine(label: string, opts: TierStatusOpts): string {
  const mark = opts.enabled ? "✓ ENABLED" : "✗ unavailable";
  const why = opts.enabled ? "" : opts.reason;
  const paused = opts.pausedSeconds ? ` ⛔ paused ${opts.pausedSeconds}s` : "";
  const parallel = opts.maxParallel ? ` (max ${opts.maxParallel} parallel)` : "";
  return `- ${label}: ${mark}${why} [${opts.model}]${paused}${parallel}`;
}

/**
 * Join several tier-status lines into a single block. Empty input → "".
 */
export function joinTierStatusLines(lines: string[]): string {
  return lines.filter(l => l.trim().length > 0).join("\n");
}

/**
 * Build the directive content the model sees every turn. Pure: it does not
 * read any live state; the caller passes in the values. The single source of
 * truth for the message shape lives here, so a regression in the directive
 * can be caught by a single unit test.
 */
export function formatDirectiveContent(opts: {
  proactivePolicy: string;
  tierLines: string[];
  activeAgentCount: number;
  activeAgentsFormatted: string; // "- t0a [running]: task" joined, or "- none"
  manualControls?: string;
}): string {
  const manual = opts.manualControls ?? "Manual controls: /tmg config, /tmg list, /t0, /t1, /t2, /t3, @t2b <instruction>.";
  return [
    opts.proactivePolicy,
    "",
    `Tiers now (live from /tmg config):`,
    joinTierStatusLines(opts.tierLines),
    "",
    "Spawn ONLY ✓ ENABLED tiers and respect per-tier max parallel; ✗ tiers are unavailable right now.",
    "Roles: active=mass worker; t1=planning; t2=reasoning; t3=mechanical.",
    "",
    `Active agents (${opts.activeAgentCount}):`,
    opts.activeAgentsFormatted,
    "",
    manual,
  ].join("\n");
}

/**
 * The "cannot spawn tier(s)" rejection message used by the tool's gate.
 * Same line format as the directive so the coordinator can read the per-tier
 * cap straight off a rejection and retry with the right size.
 */
export function formatUnavailableTiersMessage(bad: string, availableLines: string[]): string {
  return [
    `❌ Cannot spawn tier(s): ${bad} — not available right now (disabled or no model configured).`,
    `Tiers now:`,
    joinTierStatusLines(availableLines),
    `Configure with /tmg config.`,
  ].join("\n");
}
