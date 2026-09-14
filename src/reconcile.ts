/**
 * Trimegisto - Deterministic final reconciliation of sub-agent results
 *
 * Pure logic module: no pi imports, no side effects, no I/O.
 *
 * Turns a raw array of sub-agent results into ONE guaranteed-deterministic
 * final-reconciliation block: per-agent distilled verdicts, status counts,
 * overlapping (duplicate) result detection and an explicit list of anything
 * that did NOT settle. The orchestrator reads this and writes the unified
 * final answer; it must never re-spawn the same work.
 *
 * Determinism: identical input + identical options => byte-identical output.
 * `Date.now()` is never called; when elapsed time is wanted the caller injects
 * `now` (and `startedAt`).
 *
 * Used by:
 *   - harvest/vote finalizer (single reconciled answer after a spawn batch)
 *   - loop supervisor (detect agents that never settled)
 */

import { normalizeText, shingleHashes, jaccardSimilarity } from "./similarity.ts";

export interface ReconResult {
  agentId: string;
  tier: string;
  task: string;
  status: string;            // done | error | killed | running | waiting | idle | timeout
  output?: string;           // full accumulated stdout text
  finalOutput?: string;      // last assistant message = the agent's own conclusion
  stderr?: string;
  stopReason?: string;
  usage?: { turns?: number; input?: number; output?: number; cost?: number };
}

export interface ReconcileOptions {
  batchId?: string;
  startedAt?: number;
  verdictChars?: number;          // max chars per distilled verdict, default 700
  similarityThreshold?: number;   // 0..1, default 0.72
  skipped?: { task: string; tier: string; matchedTask: string; matchedTier?: string }[];
  now?: number;                   // injected clock for tests
}

export interface ReconcileDuplicate { a: string; b: string; similarity: number }

export interface ReconcileOutput {
  markdown: string;
  headline: string;
  counts: { total: number; done: number; failed: number; other: number };
  duplicates: ReconcileDuplicate[];
}

// ── Constants ────────────────────────────────────────────

const DEFAULT_VERDICT_CHARS = 700;
const DEFAULT_SIMILARITY_THRESHOLD = 0.72;
const MAX_DUPLICATE_PAIRS = 10;
const MIN_DUPLICATE_CHARS = 80;
const FAILED_MARKER_CHARS = 240;
const TASK_HEAD_CHARS = 90;

/** Unsettled/failed statuses. Anything else (running/waiting/idle) is pending. */
const FAILED_STATUSES = new Set(["error", "killed", "timeout", "failed"]);

// ── Status helpers ───────────────────────────────────────

export function isDoneStatus(status: string | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === "done";
}

export function isFailedStatus(status: string | undefined): boolean {
  return FAILED_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

/** running / waiting / idle / unknown — never a success. */
export function isPendingStatus(status: string | undefined): boolean {
  return !isDoneStatus(status) && !isFailedStatus(status);
}

// ── Error-text detection ─────────────────────────────────

const ERROR_LINE_RE = /^\s*(?:error|fatal|exception|failed)\b\s*[:：]/i;

/**
 * True when a block of text is (or is mainly) a provider/tool error message
 * rather than an answer: `Error: 400`, `invalid_request_error`, bare `Error:`.
 */
export function looksLikeErrorText(s: string | undefined): boolean {
  const text = String(s ?? "");
  if (!text.trim()) return false;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;

  // Deliberately narrow: an error must be at the HEAD of the text or dominate
  // it. Broad substring matching would rewrite legitimate prose that merely
  // mentions an error (e.g. "there is no error 400 in this log").
  const isErrorLine = (l: string): boolean =>
    ERROR_LINE_RE.test(l) || /invalid_request_error/i.test(l) || /^(?:error|fatal)\s*[:：]\s*\d{3}/i.test(l);

  if (isErrorLine(lines[0]!)) return true;
  const errorLines = lines.filter(isErrorLine).length;
  return errorLines / lines.length >= 0.5;
}

/** Longest text that can still be "a raw error and nothing else". */
const RAW_ERROR_MAX_CHARS = 400;

/**
 * Stricter sibling of `looksLikeErrorText` for agents that reported SUCCESS.
 *
 * A `done` agent can still have a provider error as its last message (a child
 * that pi exits 0 on after a swallowed failure). Presenting that under a ✅ as
 * if it were the agent's conclusion is exactly the "half-incoherent result"
 * failure mode, so those are marked UNVERIFIED instead.
 *
 * Deliberately narrow to avoid flagging a legitimate answer that merely talks
 * about HTTP errors: it must be SHORT and be either a provider-specific
 * `invalid_request_error`, or an `Error: <3 digits>:` line with the payload
 * colon. "Error: 404 is returned by the endpoint" does not match.
 */
export function looksLikeRawProviderError(s: string | undefined): boolean {
  const text = String(s ?? "").trim();
  if (!text || text.length > RAW_ERROR_MAX_CHARS) return false;
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (/invalid_request_error/i.test(first)) return true;
  return /^(?:error|fatal)\s*[:：]\s*\d{3}\s*[:：]/i.test(first);
}

// ── Text helpers ─────────────────────────────────────────

/** Tool/narration prefixes that are never part of the agent's conclusion. */
const NOISE_PREFIX_RE = /^(?:[›⏺✦•→…✓✗]|\$\s|\[tool|<\/?tool\b|assistant\s*:|user\s*:|system\s*:|thinking\s*:|tool\s*:|read\s*\(|bash\s*\(|edit\s*\(|write\s*\(|grep\s*\(|find\s*\(|run\s*:|```)/i;
const NOISE_ONLY_RE = /^[-─═=*_#~`•.\s]+$/;

function isNoiseLine(raw: string): boolean {
  const line = raw.trim();
  if (!line) return true;
  if (line.length <= 12) return true; // pure narration / labels
  if (NOISE_ONLY_RE.test(line)) return true;
  if (NOISE_PREFIX_RE.test(line)) return true;
  return false;
}

/** Last block (blank-line separated) of `output` that still carries content. */
function lastMeaningfulBlock(output: string): string {
  if (!output.trim()) return "";
  const blocks = output.split(/\n\s*\n/);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const kept = blocks[i]!
      .split(/\r?\n/)
      .filter((l) => !isNoiseLine(l))
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim().length > 0);
    if (kept.length) return kept.join("\n").trim();
    // A block made only of short lines can still be a legitimate terse verdict
    // ("Verdict: YES"). Keep it rather than reporting '(no output)', but still
    // drop tool-machinery lines.
    const terse = blocks[i]!
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !NOISE_ONLY_RE.test(l) && !NOISE_PREFIX_RE.test(l));
    if (terse.length) return terse.join("\n").trim();
  }
  return "";
}

function cleanText(s: string): string {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}

function firstLine(s: string): string {
  const line = String(s ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? String(s ?? "").trim()).replace(/\s+/g, " ");
}

/** Keep the HEAD (verdicts start with 'Verdict:'/'Conclusion:'), append '…'. */
function truncateHead(s: string, maxChars: number): string {
  const max = Math.max(1, Math.floor(maxChars));
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+$/, "") + "…";
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

function shortTask(task: string): string {
  const t = String(task ?? "").replace(/\s+/g, " ").trim();
  return t.length > TASK_HEAD_CHARS ? `${t.slice(0, TASK_HEAD_CHARS - 1)}…` : t;
}

/**
 * Collapse arbitrary text into a single safe markdown line.
 *
 * All free-text fields (agent id, tier, status, stopReason, batch id, skipped
 * tasks) are interpolated into the conclusion document. A newline in any of
 * them can forge a `## heading`, a fake bullet, or an unquoted
 * `**Trimegisto conclusion:**` line, so every field goes through here.
 */
function oneLine(value: unknown, maxChars: number): string {
  const t = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t;
}

/** Finite number or undefined — never let NaN/Infinity reach the document. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

// ── Distillation ─────────────────────────────────────────

/**
 * Distil one agent result into the agent's own conclusion.
 *
 * Priority: finalOutput (non-blank) > last meaningful block of output > stderr.
 * A non-done result whose text is a provider error is returned as
 * `FAILED: <first line>` so it can never be read as an answer.
 * Returns '(no output)' when nothing usable exists.
 */
export function distillConclusion(r: ReconResult, maxChars: number = DEFAULT_VERDICT_CHARS): string {
  const limit = positiveInt(maxChars, DEFAULT_VERDICT_CHARS);
  const status = String(r?.status ?? "").trim().toLowerCase();
  const finalOutput = typeof r?.finalOutput === "string" ? r.finalOutput : "";
  const output = typeof r?.output === "string" ? r.output : "";
  const stderr = typeof r?.stderr === "string" ? r.stderr : "";

  // Error text from a settled-failed/unsettled agent is a FAILURE, not an answer.
  if (status !== "done") {
    for (const src of [finalOutput, output, stderr]) {
      if (src.trim() && looksLikeErrorText(src)) {
        return truncateHead(`FAILED: ${firstLine(src)}`, FAILED_MARKER_CHARS);
      }
    }
  }

  let text = "";
  if (finalOutput.trim()) {
    text = finalOutput;
  } else {
    const block = lastMeaningfulBlock(output);
    if (block) text = block;
    else if (stderr.trim()) text = stderr;
  }

  const clean = cleanText(text);
  if (!clean.trim()) return "(no output)";
  // A "successful" agent whose only text is a raw provider error did not really
  // answer. Flag it so the reconciliation never presents it as a verdict.
  if (status === "done" && looksLikeRawProviderError(clean)) {
    return truncateHead(`⚠️ UNVERIFIED (provider error, not an answer): ${firstLine(clean)}`, FAILED_MARKER_CHARS);
  }
  return truncateHead(clean, limit);
}

// ── Batch settle decision ────────────────────────────────

/** Terminal agent statuses: once every agent is here, a batch must reconcile. */
const TERMINAL_STATUSES = new Set(["done", "error", "killed"]);

export interface SettleDecision {
  settle: boolean;
  reason?: "all-terminal" | "deadline";
}

/**
 * Decide whether a batch must settle NOW. Pure, so the "Trimegisto always
 * reconciles" guarantee is unit-testable.
 *
 * A batch settles when every agent has either already delivered a result or
 * reached a terminal status, OR when the hard deadline has passed (an agent
 * whose watchdog is disabled must never leave the batch unanswered).
 *
 * @param statuses agentId -> current status (anything non-terminal = pending)
 * @param captured agentIds that already delivered a result
 */
export function decideBatchSettle(
  agentIds: string[],
  statuses: Record<string, string | undefined>,
  captured: Set<string> | string[],
  now: number,
  deadlineAt: number,
): SettleDecision {
  const cap = captured instanceof Set
    ? captured
    : Array.isArray(captured)
      ? new Set(captured)
      : new Set<string>();
  const allTerminal = (Array.isArray(agentIds) ? agentIds : []).every((id) => {
    if (cap.has(id)) return true;
    const s = String(statuses?.[id] ?? "").trim().toLowerCase();
    return TERMINAL_STATUSES.has(s);
  });
  if (allTerminal) return { settle: true, reason: "all-terminal" };
  if (Number.isFinite(deadlineAt) && now >= deadlineAt) return { settle: true, reason: "deadline" };
  return { settle: false };
}

// ── Reconciliation ───────────────────────────────────────

function similarityOf(a: string, b: string): number {
  return jaccardSimilarity(shingleHashes(a, 8), shingleHashes(b, 8));
}

function detectDuplicates(verdicts: string[], results: ReconResult[], threshold: number): ReconcileDuplicate[] {
  const eligible: number[] = [];
  for (let i = 0; i < results.length; i++) {
    if (isDoneStatus(results[i]!.status) && normalizeText(verdicts[i]!).length > MIN_DUPLICATE_CHARS) {
      eligible.push(i);
    }
  }
  const dupes: ReconcileDuplicate[] = [];
  for (let x = 0; x < eligible.length && dupes.length < MAX_DUPLICATE_PAIRS; x++) {
    for (let y = x + 1; y < eligible.length && dupes.length < MAX_DUPLICATE_PAIRS; y++) {
      const i = eligible[x]!;
      const j = eligible[y]!;
      const sim = similarityOf(verdicts[i]!, verdicts[j]!);
      if (sim >= threshold) {
        dupes.push({ a: results[i]!.agentId, b: results[j]!.agentId, similarity: Math.round(sim * 10000) / 10000 });
      }
    }
  }
  return dupes;
}

function usageMetaLine(u: ReconResult["usage"]): string {
  const turns = finiteNumber(u?.turns);
  if (turns === undefined || !(turns > 0)) return "";
  const bits: string[] = [`${turns} turn${turns === 1 ? "" : "s"}`];
  const input = finiteNumber(u?.input);
  const output = finiteNumber(u?.output);
  if (input !== undefined || output !== undefined) {
    bits.push(`↑${fmtNum(input ?? 0)} ↓${fmtNum(output ?? 0)}`);
  }
  const cost = finiteNumber(u?.cost);
  if (cost !== undefined) bits.push(`$${cost.toFixed(4)}`);
  return `*${bits.join(" · ")}*`;
}

/**
 * Reconcile a whole batch into a deterministic final-conclusion document.
 * Pure: same arguments => byte-identical output.
 */
export function reconcileBatch(results: ReconResult[], options: ReconcileOptions = {}): ReconcileOutput {
  const list: ReconResult[] = Array.isArray(results) ? results.filter((r): r is ReconResult => !!r) : [];
  const opts = options ?? {};
  const verdictChars = positiveInt(opts.verdictChars, DEFAULT_VERDICT_CHARS);
  const rawThreshold = typeof opts.similarityThreshold === "number" && Number.isFinite(opts.similarityThreshold)
    ? opts.similarityThreshold
    : DEFAULT_SIMILARITY_THRESHOLD;
  const threshold = Math.min(1, Math.max(0, rawThreshold));

  const total = list.length;
  let done = 0;
  let failed = 0;
  let other = 0;
  for (const r of list) {
    if (isDoneStatus(r.status)) done++;
    else if (isFailedStatus(r.status)) failed++;
    else other++;
  }

  const verdicts = list.map((r) => distillConclusion(r, verdictChars));
  const duplicates = detectDuplicates(verdicts, list, threshold);

  // Agents that claim success but delivered no usable verdict (empty output, or
  // a raw provider error): counted as done (their own status) but surfaced as
  // UNVERIFIED so a conclusion never silently relies on them.
  const unverified: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (!isDoneStatus(list[i]!.status)) continue;
    const v = verdicts[i]!;
    if (v === "(no output)" || v.startsWith("⚠️ UNVERIFIED")) unverified.push(i);
  }

  // Usage totals (only when the caller actually reported usage). Non-finite
  // values are ignored rather than rendered as NaN/Infinity.
  let totTurns = 0;
  let totIn = 0;
  let totOut = 0;
  let totCost = 0;
  let anyUsage = false;
  for (const r of list) {
    const u = r.usage;
    if (!u) continue;
    const t = finiteNumber(u.turns);
    const i = finiteNumber(u.input);
    const o = finiteNumber(u.output);
    const c = finiteNumber(u.cost);
    if (t !== undefined || i !== undefined || o !== undefined || c !== undefined) anyUsage = true;
    totTurns += t ?? 0;
    totIn += i ?? 0;
    totOut += o ?? 0;
    totCost += c ?? 0;
  }

  let elapsedSec: number | undefined;
  if (typeof opts.startedAt === "number" && Number.isFinite(opts.startedAt)) {
    const end = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : opts.startedAt;
    elapsedSec = Math.max(0, Math.round(((end - opts.startedAt) / 1000) * 10) / 10);
  }

  // ── Markdown ──
  const out: string[] = [];
  out.push(
    opts.batchId
      ? `## 🪡 Trimegisto — final reconciliation · batch ${oneLine(opts.batchId, 60)}`
      : "## 🪡 Trimegisto — final reconciliation",
  );
  out.push("");

  const summaryBits = [`${total} agents`, `${done} done`, `${failed} failed`, `${other} pending`];
  if (unverified.length > 0) summaryBits.push(`${unverified.length} unverified`);
  let summary = `**${summaryBits.join(" · ")}**`;
  const usageBits: string[] = [];
  if (anyUsage) {
    if (totTurns > 0) usageBits.push(`${totTurns} turns`);
    usageBits.push(`↑${fmtNum(totIn)} ↓${fmtNum(totOut)}`);
    usageBits.push(`$${totCost.toFixed(4)}`);
  }
  if (elapsedSec !== undefined) usageBits.push(`${elapsedSec.toFixed(1)}s elapsed`);
  if (usageBits.length) summary += ` — ${usageBits.join(" · ")}`;
  out.push(summary);
  out.push("");

  out.push("### Conclusions");
  out.push("");
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    const icon = unverified.includes(i)
      ? "⚠️"
      : isDoneStatus(r.status) ? "✅" : isFailedStatus(r.status) ? "❌" : "⏳";
    out.push(`#### ${icon} ${oneLine(r.agentId, 80) || "?"} [${oneLine(r.tier, 24) || "?"}] — ${shortTask(r.task)}`);
    const verdict = verdicts[i]!;
    for (const line of verdict.split("\n")) out.push(`> ${line}`.replace(/\s+$/, ""));
    const meta = usageMetaLine(r.usage);
    if (meta) out.push("", meta);
    out.push("");
  }

  if (unverified.length > 0) {
    out.push("### ⚠️ Unverified (reported success, no usable verdict)");
    out.push("");
    for (const i of unverified) {
      out.push(`- ${oneLine(list[i]!.agentId, 80)} — status=${oneLine(list[i]!.status, 24)}, no usable conclusion; verify before relying on it`);
    }
    out.push("");
  }

  if (duplicates.length > 0) {
    out.push("### Overlapping results");
    out.push("");
    for (const d of duplicates) {
      out.push(`- ${d.a} ≈ ${d.b} (${Math.round(d.similarity * 100)}% similar) — consolidated`);
    }
    out.push("");
  }

  if (failed + other > 0) {
    out.push("### Not settled / incomplete");
    out.push("");
    for (const r of list) {
      if (isDoneStatus(r.status)) continue;
      const reason = r.stopReason ? ` (stopReason: ${oneLine(r.stopReason, 60)})` : "";
      out.push(`- INCOMPLETE: ${oneLine(r.agentId, 80)} — status=${oneLine(r.status, 24)}${reason}`);
    }
    out.push("");
  } else {
    out.push("✅ All agents settled.");
    out.push("");
  }

  if (Array.isArray(opts.skipped) && opts.skipped.length > 0) {
    const rows = opts.skipped
      .filter((s) => !!s)
      .map((s) => {
        const matchedTier = s.matchedTier ? ` [${oneLine(s.matchedTier, 24)}]` : "";
        return `- \`${oneLine(s.task, 120)}\` [${oneLine(s.tier, 24)}] ≈ \`${oneLine(s.matchedTask, 120)}\`${matchedTier}`;
      });
    if (rows.length > 0) {
      out.push("### Skipped (near-duplicates)");
      out.push("");
      out.push(...rows);
      out.push("");
    }
  }

  const unverifiedNote = unverified.length > 0
    ? ` ${unverified.length} reported success without a usable verdict (unverified).`
    : "";
  out.push(
    `**Trimegisto conclusion:** ${done}/${total} agents completed.${unverifiedNote} Read the verdicts above and write the unified final answer; do not re-spawn the same work.`,
  );

  const headline = `${done}/${total} done, ${failed} failed${other > 0 ? `, ${other} pending` : ""}${unverified.length > 0 ? `, ${unverified.length} unverified` : ""}`;

  return {
    markdown: `${out.join("\n")}\n`,
    headline,
    counts: { total, done, failed, other },
    duplicates,
  };
}
