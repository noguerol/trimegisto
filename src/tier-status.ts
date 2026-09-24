/**
 * Trimegisto - tier-status formatter
 *
 * Pure formatting helpers for everything the coordinator LLM reads about
 * tiers, policy and live agent state.
 *
 * WHY THIS FILE IS SHAPED THE WAY IT IS
 * -----------------------------------
 * `before_agent_start` injects a `role:"custom"` message, and pi's
 * `convertToLlm` turns custom messages into plain `role:"user"` messages
 * with NO marker of their origin (unlike compaction/branch summaries,
 * which pi wraps in their own prefix). Before this rewrite the whole
 * orchestration policy was pushed into that user channel every turn, AFTER
 * the user's own message. Measured on a real session: 57 chars of user
 * request vs 2,103 chars of imperative orchestration text — the last thing
 * the model read before answering was a wall of "your FIRST action MUST
 * be a trimegisto batch call". A cautious model read that as injected
 * instructions with no real request attached and refused to answer.
 *
 * Three rules follow from that, and the API here enforces them:
 *
 *  1. Anything we put in front of the model that is not the user's words
 *     gets delimited with `frameExtensionContext()` so its origin is
 *     explicit and it can never be mistaken for a request.
 *  2. Stable policy belongs in the SYSTEM PROMPT (`formatSystemPolicyContent`),
 *     where it does not compete with the user channel and stays cacheable.
 *  3. The per-turn user-channel message (`formatDirectiveContent`) carries
 *     only live state that cannot live in the system prompt, and returns ""
 *     when there is nothing to report so the caller injects nothing.
 *
 * The tone is deliberately advisory, not imperative: "prefer to delegate"
 * reads as guidance; "your FIRST action MUST be" reads as a hijack.
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
  /**
   * Optional parenthetical suffix appended after the cap, e.g. the ACTIVE
   * tier's "principal only — no spawn slots" when maxParallel = 1.
   */
  detail?: string;
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
  const detail = opts.detail && opts.detail.trim() ? ` (${opts.detail.trim()})` : "";
  return `- ${label}: ${mark}${why} [${opts.model}]${paused}${parallel}${detail}`;
}

/**
 * Join several tier-status lines into a single block. Empty input → "".
 */
export function joinTierStatusLines(lines: string[]): string {
  return lines.filter(l => l.trim().length > 0).join("\n");
}

/** Delimiters for extension-supplied text in the user channel. */
export const EXTENSION_CONTEXT_OPEN = "<trimegisto-context>";
export const EXTENSION_CONTEXT_CLOSE = "</trimegisto-context>";

/**
 * The notice that makes the origin of an injected block unambiguous. This is
 * the single line whose absence caused the model to answer "the message you
 * pasted contains instructions from an external system but no real
 * request". It states three things: who wrote it, that it is not a request,
 * and where the real request is.
 */
export const EXTENSION_CONTEXT_NOTICE =
  "Automatic context injected by the Trimegisto extension. This is NOT the user's message and NOT a new request. " +
  "The user's request is the message above; answer that. Everything below is reference about multi-agent availability, " +
  "and can be ignored entirely when the request needs no delegation.";

/**
 * Wrap extension-supplied body text so it is self-labelled and delimited.
 * Empty body → "" (nothing to frame, nothing to inject).
 */
export function frameExtensionContext(body: string): string {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return "";
  return `${EXTENSION_CONTEXT_OPEN}\n${EXTENSION_CONTEXT_NOTICE}\n\n${trimmed}\n${EXTENSION_CONTEXT_CLOSE}`;
}

/**
 * The stable orchestration policy, destined for the SYSTEM PROMPT.
 *
 * Deliberately free of live counters: nothing here changes between turns
 * unless the user edits /tmg config, so the system prompt keeps its
 * provider-side cache prefix. Live values (circuit-breaker countdowns,
 * running agents) go through `formatDirectiveContent` instead.
 */
export function formatSystemPolicyContent(opts: {
  proactivePolicy: string;
  rules: string[];
  tierLines: string[];
  /**
   * Optional per-run reinforcement derived from the raw user prompt
   * (`formatDecomposabilityNote`). Rendered LAST, after every stable line, so
   * only the tail of the block changes between prompts and the provider's
   * cached prefix survives. "" (or omitted) renders nothing.
   */
  decomposabilityNote?: string;
}): string {
  const rules = (opts.rules ?? []).filter(r => r && r.trim().length > 0);
  const note = (opts.decomposabilityNote ?? "").trim();
  return [
    "<trimegisto-policy>",
    "Injected by the Trimegisto extension. It gives this session a `trimegisto` tool that runs parallel sub-agents on other models. This block is stable reference; live agent status, if any, arrives separately in the user channel.",
    "",
    opts.proactivePolicy,
    "",
    "Delegation rules:",
    ...rules,
    "",
    "Tiers (roles and capacity; live availability may differ, see the per-turn context):",
    joinTierStatusLines(opts.tierLines),
    "Spawn only tiers marked ✓ ENABLED, and respect each tier's max parallel.",
    "Roles: active = mass worker; t1 = planning; t2 = reasoning; t3 = mechanical.",
    ...(note ? [note] : []),
    "</trimegisto-policy>",
  ].join("\n");
}

/**
 * The per-turn live-status block, destined for the user channel — framed,
 * short, and empty when there is nothing worth saying.
 *
 * Returns "" when no agents are running and no tier is under a circuit
 * breaker: the caller then injects nothing at all, which is the correct
 * message for an idle orchestrator.
 */
export function formatDirectiveContent(opts: {
  activeAgentCount: number;
  activeAgentsFormatted: string; // "- t0a [running]: task" joined, or "- none"
  pausedTierLines?: string[];    // tier lines currently carrying a ⛔ countdown
  manualControls?: string;
}): string {
  const manual = opts.manualControls ??
    "Manual controls: /tmg config, /tmg list, /t0, /t1, /t2, /t3, @t2b <instruction>.";
  const paused = (opts.pausedTierLines ?? []).filter(l => l && l.trim().length > 0);
  const count = Number.isFinite(opts.activeAgentCount) ? opts.activeAgentCount : 0;

  if (count <= 0 && paused.length === 0) return "";

  const parts: string[] = [];
  parts.push(`Active agents (${count}):`);
  parts.push(opts.activeAgentsFormatted && opts.activeAgentsFormatted.trim() ? opts.activeAgentsFormatted : "- none");
  if (paused.length > 0) {
    parts.push("");
    parts.push("Tiers under circuit breaker right now:");
    parts.push(joinTierStatusLines(paused));
  }
  parts.push("");
  parts.push(manual);

  return frameExtensionContext(parts.join("\n"));
}

/**
 * The "cannot spawn tier(s)" rejection message used by the tool's gate.
 * Same line format as the tier status lines so the coordinator can read
 * the per-tier cap straight off a rejection and retry with the right size.
 */
export function formatUnavailableTiersMessage(bad: string, availableLines: string[]): string {
  return [
    `❌ Cannot spawn tier(s): ${bad} — not available right now (disabled or no model configured).`,
    `Tiers now:`,
    joinTierStatusLines(availableLines),
    `Configure with /tmg config.`,
  ].join("\n");
}
