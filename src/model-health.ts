/**
 * Trimegisto — Model health (circuit breaker)
 *
 * When a provider/model goes bad (HTTP 400 invalid_request_error, 5xx,
 * rate limits, connection resets, provider hangs), every spawn against that
 * model fails fast. Because a failed process frees its parallel slot almost
 * immediately, the coordinator can retry in a tight loop and spawn an
 * unbounded number of doomed agents ("spawn storm").
 *
 * This module tracks consecutive MODEL-LEVEL failures per model and opens a
 * circuit breaker after `failureThreshold` of them:
 *
 *   - While open, spawns targeting that model are refused with a clear
 *     message (and a retry hint), instead of launching a doomed agent.
 *   - The breaker is HALF-OPEN after the cooldown: the next attempt is
 *     allowed; if it fails the breaker re-opens with exponential backoff
 *     (base × 2^(trips-1), capped at maxCooldownSeconds).
 *   - A single success resets the streak and clears the block.
 *   - Changing the model (or /tmg reset-models) clears the block immediately.
 *
 * Only model-level failures count. A task that fails after the model actually
 * worked (produced turns/output) is NOT a model failure and never trips.
 */

import type { AgentTier, ModelHealthConfig } from "./types.ts";

export type { ModelHealthConfig } from "./types.ts";

export const MODEL_HEALTH_DEFAULTS: ModelHealthConfig = {
  enabled: true,
  failureThreshold: 2,
  cooldownSeconds: 60,
  maxCooldownSeconds: 600,
};

export type ModelFailureKind = "provider" | "timeout" | "spawn";

export interface ModelHealthEntry {
  /** Effective model key (see `modelKey`) */
  model: string;
  /** Consecutive model-level failures (reset on success) */
  failures: number;
  /** Lifetime model-level failures (observability) */
  totalFailures: number;
  /** Successful attempts since the last failure (observability) */
  successes: number;
  /** Number of times the breaker has opened (drives the backoff) */
  trips: number;
  /** Epoch ms until which spawns are refused (0 = available) */
  blockedUntil: number;
  /** Cooldown applied on the last trip (ms) */
  cooldownMs: number;
  lastFailureAt: number;
  lastFailureKind?: ModelFailureKind;
  lastReason?: string;
  /** Tiers where this model has been failing (observability) */
  tiers: AgentTier[];
}

export interface ModelBlockInfo {
  model: string;
  reason: string;
  /** ms left before the half-open probe is allowed */
  remainingMs: number;
  /** Epoch ms of the half-open probe */
  retryAt: number;
  failures: number;
}

/**
 * Provider-side error signatures in stderr. Deliberately conservative: it is
 * only consulted when the agent also failed to do any work, so matching a
 * number inside legit output is not a concern (legit output implies work).
 */
const PROVIDER_ERROR_PATTERN =
  /invalid_request_error|invalid request|rate.?limit|quota exceeded|insufficient quota|overload|payment required|billing|usage limit|limit reached|econnrefused|econnreset|enotfound|etimedout|socket hang up|fetch failed|connection (refused|reset|closed|error)|network error|\b(400|401|402|403|429|500|502|503|504)\b/i;

const TIMEOUT_STOP_REASONS = new Set(["first_response_timeout", "idle_timeout", "unresponsive"]);
const SPAWN_STOP_REASONS = new Set(["spawn_error", "launch_error"]);

/** Minimal shape needed to classify a finished agent. */
export interface ModelFailureInput {
  status: string;
  turns: number;
  output: string;
  stderr: string;
  stopReason?: string;
}

export interface ModelFailureClassification {
  /** True when the failure is attributable to the model/provider, not the task. */
  modelLevel: boolean;
  kind: ModelFailureKind;
  reason: string;
}

/**
 * Decide whether a finished agent result is a MODEL-level failure.
 *
 * Model-level means the agent never got usable work out:
 *   - spawn/launch error (the process never started)
 *   - first-response / idle watchdog timeout (provider hang)
 *   - exit with zero turns and no assistant output
 *   - exit with no assistant output and an explicit provider error signature
 *     in stderr (e.g. an HTTP 400/5xx while the agent was still on tool calls)
 *
 * A failure that produced assistant output text is treated as a task failure
 * and never trips the breaker, so one bad request cannot pause a good model.
 *
 * `done` results count only when they clearly did nothing: a successful agent
 * always finishes at least one turn, so a zero-turn / error-stopped run with no
 * output is provider no-op noise (e.g. pi exiting 0 after a 400).
 */
export function classifyModelFailure(input: ModelFailureInput): ModelFailureClassification {
  const reason = (input.stopReason || "").trim();
  const stderr = input.stderr || "";
  const detail = reason || stderr.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) || "unknown error";

  const noOutput = (input.output || "").trim().length === 0;
  const aborted = /^(error|aborted)$/i.test(reason);
  const failed =
    input.status === "error" ||
    (input.status === "done" && noOutput && (input.turns === 0 || aborted));
  if (!failed) {
    return { modelLevel: false, kind: "provider", reason: detail };
  }

  if (SPAWN_STOP_REASONS.has(reason)) {
    return { modelLevel: true, kind: "spawn", reason: detail };
  }

  if (TIMEOUT_STOP_REASONS.has(reason)) {
    return { modelLevel: true, kind: "timeout", reason: detail };
  }

  // The provider itself reported an error/abort and no answer text was produced.
  if (aborted) {
    return { modelLevel: true, kind: "provider", reason: detail };
  }

  if (noOutput && input.turns === 0) {
    return { modelLevel: true, kind: "provider", reason: detail };
  }

  // Provider error while the agent had produced no answer text yet (all of its
  // turns were tool calls): still a model/provider failure.
  if (noOutput && PROVIDER_ERROR_PATTERN.test(stderr)) {
    return { modelLevel: true, kind: "provider", reason: detail };
  }

  return { modelLevel: false, kind: "provider", reason: detail };
}

/** Normalize a model identifier into a stable key. */
export function modelKey(model?: string): string {
  const m = (model || "").trim();
  return m || "(pi default)";
}

function clampSeconds(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Clamp a config block read from disk into a safe shape. */
export function sanitizeModelHealthConfig(
  saved: Partial<Record<string, unknown>> | undefined,
  defaults: ModelHealthConfig = MODEL_HEALTH_DEFAULTS,
): ModelHealthConfig {
  const d = defaults;
  const bool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb);
  const threshold = typeof saved?.failureThreshold === "number" && Number.isFinite(saved.failureThreshold)
    ? Math.max(1, Math.min(10, Math.floor(saved.failureThreshold as number)))
    : d.failureThreshold;
  const maxCooldown = clampSeconds(saved?.maxCooldownSeconds, d.maxCooldownSeconds, 86_400);
  return {
    enabled: bool(saved?.enabled, d.enabled),
    failureThreshold: threshold,
    cooldownSeconds: clampSeconds(saved?.cooldownSeconds, d.cooldownSeconds, maxCooldown),
    maxCooldownSeconds: maxCooldown,
  };
}

export class ModelHealth {
  private config: ModelHealthConfig;
  private entries = new Map<string, ModelHealthEntry>();
  private onTrip: ((entry: ModelHealthEntry, info: ModelBlockInfo) => void) | null = null;
  private readonly now: () => number;

  constructor(config?: Partial<ModelHealthConfig>, now?: () => number) {
    this.config = sanitizeModelHealthConfig(config as any, MODEL_HEALTH_DEFAULTS);
    this.now = now ?? (() => Date.now());
  }

  updateConfig(partial: Partial<ModelHealthConfig>): void {
    this.config = sanitizeModelHealthConfig(partial as any, this.config);
  }

  getConfig(): ModelHealthConfig {
    return { ...this.config };
  }

  setOnTrip(cb: (entry: ModelHealthEntry, info: ModelBlockInfo) => void): void {
    this.onTrip = cb;
  }

  /** Record a successful attempt on a model: clears streak and block. */
  recordSuccess(model: string): void {
    const key = modelKey(model);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.successes++;
    entry.failures = 0;
    entry.trips = 0;
    entry.cooldownMs = 0;
    entry.blockedUntil = 0;
  }

  /**
   * Record a model-level failure. Opens the breaker once the consecutive
   * failure count reaches the threshold. Returns the block info when the
   * breaker opens (or is already open), so callers can notify.
   */
  recordFailure(
    model: string,
    kind: ModelFailureKind,
    reason: string,
    tier?: AgentTier,
  ): ModelBlockInfo | null {
    if (!this.config.enabled) return null;

    const key = modelKey(model);
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        model: key,
        failures: 0,
        totalFailures: 0,
        successes: 0,
        trips: 0,
        blockedUntil: 0,
        cooldownMs: 0,
        lastFailureAt: now,
        tiers: [],
      };
      this.entries.set(key, entry);
    }

    entry.failures++;
    entry.totalFailures++;
    entry.lastFailureAt = now;
    entry.lastFailureKind = kind;
    entry.lastReason = reason;
    if (tier && !entry.tiers.includes(tier)) entry.tiers.push(tier);

    const alreadyBlocked = entry.blockedUntil > now;
    if (entry.failures >= this.config.failureThreshold && !alreadyBlocked) {
      // Half-open probe failed again (or threshold just reached): re-open with
      // exponential backoff so repeated failure cycles slow down instead of
      // hammering the provider forever.
      entry.trips++;
      const baseMs = this.config.cooldownSeconds * 1000;
      const maxMs = this.config.maxCooldownSeconds * 1000;
      const cooldownMs = Math.min(baseMs * Math.pow(2, entry.trips - 1), maxMs);
      entry.cooldownMs = cooldownMs;
      entry.blockedUntil = now + cooldownMs;
      const info = this.blockInfo(entry, now);
      if (this.onTrip) this.onTrip({ ...entry, tiers: [...entry.tiers] }, info);
      return info;
    }

    return alreadyBlocked ? this.blockInfo(entry, now) : null;
  }

  /** True while the model's breaker is open. */
  isBlocked(model: string, now: number = this.now()): boolean {
    if (!this.config.enabled) return false;
    const entry = this.entries.get(modelKey(model));
    return !!entry && entry.blockedUntil > now;
  }

  /** Block details, or null when the model is available. */
  getBlock(model: string, now: number = this.now()): ModelBlockInfo | null {
    if (!this.config.enabled) return null;
    const entry = this.entries.get(modelKey(model));
    if (!entry || entry.blockedUntil <= now) return null;
    return this.blockInfo(entry, now);
  }

  /** ms left before the half-open probe; 0 when available. */
  cooldownRemainingMs(model: string, now: number = this.now()): number {
    const entry = this.entries.get(modelKey(model));
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - now);
  }

  /** Clear one model (or all when omitted). Returns how many were cleared. */
  clear(model?: string): number {
    if (model === undefined) {
      const n = this.entries.size;
      this.entries.clear();
      return n;
    }
    const key = modelKey(model);
    const existed = this.entries.delete(key);
    return existed ? 1 : 0;
  }

  /** Snapshot of every tracked model, most recently failed first. */
  list(now: number = this.now()): ModelHealthEntry[] {
    return [...this.entries.values()]
      .map(e => ({ ...e, tiers: [...e.tiers] }))
      .sort((a, b) => b.lastFailureAt - a.lastFailureAt)
      .map(e => ({ ...e, blockedUntil: e.blockedUntil > now ? e.blockedUntil : 0 }));
  }

  private blockInfo(entry: ModelHealthEntry, now: number): ModelBlockInfo {
    return {
      model: entry.model,
      reason: entry.lastReason || "model-level failure",
      remainingMs: Math.max(0, entry.blockedUntil - now),
      retryAt: entry.blockedUntil,
      failures: entry.failures,
    };
  }
}
