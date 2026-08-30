/**
 * Trimegisto - Speed telemetry
 *
 * Measures prefill (prompt processing) and decode (generation) throughput for
 * every streaming target: each sub-agent process and the main pi session.
 *
 * The model is provider-agnostic and reads the token stream itself:
 *   prefill tok/s = uncached prompt tokens / time-to-first-token
 *   decode  tok/s = generated tokens / time since first token
 * Providers only report usage at the END of a message, so between those
 * reports decode is estimated live from streamed delta characters, calibrated
 * with a per-target tokens-per-char ratio learned from real usage.
 */

export const MAIN_TARGET = "main";

export type SpeedPhase = "prefill" | "decode" | "idle";

export interface SpeedUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface SpeedSnapshot {
  id: string;
  phase: SpeedPhase;
  /** ms spent in the current prefill (0 unless phase is "prefill") */
  prefillElapsedMs: number;
  /** live decode throughput in tok/s (estimated while streaming, authoritative after) */
  decodeTokPerSec: number;
  /** last measured prefill throughput in tok/s (smoothed) */
  prefillTokPerSec: number;
  /** last measured decode throughput in tok/s (smoothed) */
  genTokPerSec: number;
  /** time-to-first-token of the last measured request */
  ttftMs: number;
  /** prompt tokens that had to be processed on the last request */
  promptTokens: number;
  /** prompt tokens served from cache on the last request */
  cachedTokens: number;
  /** generated tokens of the last request */
  outputTokens: number;
  /** learned chars→tokens ratio for this target */
  tokPerChar: number;
  /** timestamp of the last stream activity */
  activeAt: number;
}

interface TargetState {
  reqStartAt: number;
  firstTokenAt: number;
  lastTokenAt: number;
  deltaChars: number;
  /** tokens reported by the provider for the request in flight (0 until known) */
  usageOutput: number;
  streaming: boolean;
  closed: boolean;
  ttftMs: number;
  prefillTokPerSec: number;
  genTokPerSec: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  tokPerChar: number;
}

/** Typical tokens-per-char for prose/code streams; refined per target from usage. */
const DEFAULT_TOK_PER_CHAR = 0.35;
const MIN_TTFT_MS = 120;
/**
 * A prefill sample is only trusted when the prompt was big enough that compute
 * dominates the round trip. A 100-token prompt over a network hop measures
 * latency, not prompt throughput, so it is reported as TTFT instead.
 */
const MIN_PREFILL_SAMPLE_TOKENS = 500;
const MIN_PREFILL_SAMPLE_MS = 1_000;
const MIN_DECODE_MS = 400;
/** No stream activity for this long means the target is idle (not mid-generation). */
const IDLE_AFTER_MS = 2_000;
/** Smoothing between successive measured samples. */
const EMA_ALPHA = 0.35;
/** Drop targets untouched for this long (keeps long sessions bounded). */
const PRUNE_AFTER_MS = 15 * 60_000;

const MAX_SPEED = 1_000_000;

function clampSpeed(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_SPEED);
}

function ema(prev: number, sample: number): number {
  if (prev <= 0) return clampSpeed(sample);
  return clampSpeed(prev * (1 - EMA_ALPHA) + sample * EMA_ALPHA);
}

function newState(): TargetState {
  return {
    reqStartAt: 0,
    firstTokenAt: 0,
    lastTokenAt: 0,
    deltaChars: 0,
    usageOutput: 0,
    streaming: false,
    closed: false,
    ttftMs: 0,
    prefillTokPerSec: 0,
    genTokPerSec: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    tokPerChar: DEFAULT_TOK_PER_CHAR,
  };
}

export class SpeedTracker {
  private states = new Map<string, TargetState>();

  /** Called when a provider request begins (start of the prefill phase). */
  startRequest(id: string): void {
    const prev = this.states.get(id);
    const s = newState();
    s.reqStartAt = Date.now();
    s.streaming = true;
    // Carry the learned ratio across requests; it is a property of the model.
    s.tokPerChar = prev?.tokPerChar ?? DEFAULT_TOK_PER_CHAR;
    s.prefillTokPerSec = prev?.prefillTokPerSec ?? 0;
    s.genTokPerSec = prev?.genTokPerSec ?? 0;
    s.ttftMs = prev?.ttftMs ?? 0;
    this.states.set(id, s);
  }

  /** Called for every streamed delta (text, thinking or tool-call arguments). */
  noteDelta(id: string, chars: number): void {
    if (chars <= 0) return;
    let s = this.states.get(id);
    if (!s) {
      s = newState();
      s.reqStartAt = Date.now();
      this.states.set(id, s);
    }
    s.streaming = true;
    s.closed = false;
    const now = Date.now();
    if (!s.firstTokenAt) s.firstTokenAt = now;
    s.lastTokenAt = now;
    s.deltaChars += chars;
  }

  /**
   * Provider-reported tokens for the request in flight. Some providers already
   * report usage on stream events; when they do, the live estimate uses the
   * real count instead of the character calibration.
   */
  noteLiveUsage(id: string, outputTokens: number): void {
    if (outputTokens <= 0) return;
    const s = this.states.get(id);
    if (!s || !s.streaming) return;
    s.usageOutput = Math.max(s.usageOutput, outputTokens);
  }

  /** Called when the assistant message finishes and real usage is known. */
  endRequest(id: string, usage: SpeedUsage): void {
    const s = this.states.get(id);
    if (!s) return;
    const now = Date.now();
    s.streaming = false;

    s.promptTokens = (usage.input || 0) + (usage.cacheWrite || 0);
    s.cachedTokens = usage.cacheRead || 0;
    s.outputTokens = usage.output || 0;

    // Prefill sample: only meaningful when the model actually had to chew
    // through a non-trivial number of uncached tokens.
    if (s.firstTokenAt) {
      const ttft = s.firstTokenAt - s.reqStartAt;
      if (ttft >= MIN_TTFT_MS) {
        s.ttftMs = ttft;
        if (ttft >= MIN_PREFILL_SAMPLE_MS && s.promptTokens >= MIN_PREFILL_SAMPLE_TOKENS) {
          s.prefillTokPerSec = ema(s.prefillTokPerSec, (s.promptTokens * 1000) / ttft);
        }
      }

      // Decode sample: authoritative for this request.
      const genMs = now - s.firstTokenAt;
      if (genMs >= MIN_DECODE_MS && s.outputTokens > 0) {
        s.genTokPerSec = ema(s.genTokPerSec, (s.outputTokens * 1000) / genMs);
        // Calibrate the live estimator with what the stream really cost.
        const ratio = s.outputTokens / s.deltaChars;
        if (ratio > 0.05 && ratio < 2) s.tokPerChar = ema(s.tokPerChar, ratio) || s.tokPerChar;
      }
    }
  }

  /** Target finished (agent done/killed, or main run settled): keep last values. */
  finalize(id: string): void {
    const s = this.states.get(id);
    if (!s) return;
    s.streaming = false;
    s.closed = true;
  }

  /** Drop the target entirely. */
  forget(id: string): void {
    this.states.delete(id);
  }

  /** Current view of a target, or null if it was never seen. */
  snapshot(id: string): SpeedSnapshot | null {
    const s = this.states.get(id);
    if (!s) return null;
    return this.view(id, s);
  }

  /** All known targets, most recently active first. */
  snapshots(): SpeedSnapshot[] {
    const now = Date.now();
    const out: SpeedSnapshot[] = [];
    for (const [id, s] of this.states) {
      void now;
      out.push(this.view(id, s));
    }
    out.sort((a, b) => b.activeAt - a.activeAt);
    return out;
  }

  /** True when any target is currently prefilling or generating. */
  hasLiveActivity(): boolean {
    const now = Date.now();
    for (const s of this.states.values()) {
      if (s.closed) continue;
      if (s.streaming && now - s.lastTokenAt < IDLE_AFTER_MS) return true;
      if (s.reqStartAt && !s.firstTokenAt && now - s.reqStartAt < IDLE_AFTER_MS * 30) return true;
    }
    return false;
  }

  /** Remove long-idle targets (never the main session). */
  prune(): void {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    for (const [id, s] of this.states) {
      if (id === MAIN_TARGET) continue;
      const active = Math.max(s.lastTokenAt, s.reqStartAt);
      if (active < cutoff) this.states.delete(id);
    }
  }

  private view(id: string, s: TargetState): SpeedSnapshot {
    const now = Date.now();
    let phase: SpeedPhase = "idle";
    let prefillElapsedMs = 0;

    if (!s.closed && s.reqStartAt && !s.firstTokenAt) {
      // Request open with no token yet: the model is processing the prompt.
      const elapsed = now - s.reqStartAt;
      if (elapsed >= MIN_TTFT_MS) {
        phase = "prefill";
        prefillElapsedMs = elapsed;
      }
    }
    if (!s.closed && s.streaming && s.firstTokenAt && now - s.lastTokenAt < IDLE_AFTER_MS) {
      phase = "decode";
    }

    // Live decode estimate: whole-request average, stable against burst jitter.
    // Provider-reported tokens win over the character calibration when present.
    let decodeTokPerSec = s.genTokPerSec;
    if (phase === "decode") {
      const elapsedSec = (now - s.firstTokenAt) / 1000;
      const tokens = s.usageOutput > 0 ? s.usageOutput : s.deltaChars * s.tokPerChar;
      if (elapsedSec * 1000 >= MIN_DECODE_MS && tokens > 0) {
        decodeTokPerSec = clampSpeed(tokens / elapsedSec);
      }
    }

    return {
      id,
      phase,
      prefillElapsedMs,
      decodeTokPerSec,
      prefillTokPerSec: s.prefillTokPerSec,
      genTokPerSec: s.genTokPerSec,
      ttftMs: s.ttftMs,
      promptTokens: s.promptTokens,
      cachedTokens: s.cachedTokens,
      outputTokens: s.outputTokens,
      tokPerChar: s.tokPerChar,
      activeAt: Math.max(s.lastTokenAt, s.reqStartAt),
    };
  }
}

/** Shared tracker: sub-agents (keyed by agent id) plus the main session. */
export const speed = new SpeedTracker();
