/**
 * Trimegisto - per-task verification
 *
 * Orchestration layer, NOT the worker's own claim. When a task carries a
 * `verify` command, the EXTENSION (never the worker) runs it in the task's cwd
 * after the worker finishes. A non-zero exit marks the result VERIFY FAILED and
 * the reconciliation surfaces it, so a confidently-wrong worker cannot report
 * `done` and be believed.
 *
 * This is the "verification instead of trust" import from
 * arXiv:2608.26480 (§3.1 step 5 / §4.4): the paper's regressions all came from
 * the manager accepting a worker's solved report at face value.
 *
 * Trust boundary (documented, not enforced): the command is chosen by the
 * coordinator, not by the worker, so the worker cannot pick a command that makes
 * it pass — but it CAN still edit the project's own test files. v1 reports; it
 * does not sandbox. Verify never runs for `closed`-lane work (those batches are
 * refused before launch) and never runs when the worker itself failed.
 *
 * The only I/O is the subprocess. It never throws: a failure to run is a
 * `ran: false` result, never an exception that could take the host down.
 */

import { spawn } from "node:child_process";

/**
 * Light, prefix-only redaction for verify output. Deliberately NOT the
 * diagnostics redactor: that one treats any digit+letter token as a credential,
 * which would mangle the very signal a failing test prints (paths, hashes,
 * versions, test names). Only well-known credential prefixes are masked.
 */
const SECRET_PREFIX_RE = /\b(?:sk|pk)-[A-Za-z0-9._-]{8,}\b|\b(?:ghp|gho)_[A-Za-z0-9]{8,}\b|\bgithub_pat_[A-Za-z0-9_]{8,}\b/g;
const BEARER_RE = /\bBearer\s+\S{8,}/g;

export function lightRedact(text: string): string {
  return String(text ?? "")
    .replace(SECRET_PREFIX_RE, "<redacted>")
    .replace(BEARER_RE, "Bearer <redacted>");
}

export interface VerifySpec {
  command: string;
}

export interface VerificationResult {
  /** The command as supplied by the coordinator. */
  command: string;
  /** Whether the command actually started (false on spawn failure/empty command). */
  ran: boolean;
  /** Exit code 0 and not timed out. */
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Combined stdout+stderr, redacted and truncated. */
  output: string;
  /** Spawn-level failure (ENOENT, empty command, ...). */
  error?: string;
}

/** Default and ceiling for a verify run, in ms (env-overridable by the caller). */
export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const MAX_VERIFY_TIMEOUT_MS = 600_000;
/** Chars kept after truncation (head+tail) when rendering/attaching output. */
export const MAX_VERIFY_OUTPUT_CHARS = 4_000;
/** Hard cap on bytes buffered from a runaway command. */
const MAX_COLLECT_BYTES = 128 * 1024;
const TRUNCATE_MARK = "\n…(truncated)…\n";
const COLLECT_LIMIT_MARK = "\n…(output beyond 128 KB not captured)…\n";

/**
 * Coerce a raw `verify` field into a spec, or undefined when absent/blank.
 * Accepts a plain string (the common case) or `{ command }` for forward
 * compatibility with a future structured form.
 */
export function normalizeVerify(raw: unknown): VerifySpec | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") {
    const command = raw.trim();
    return command ? { command } : undefined;
  }
  if (typeof raw === "object") {
    const candidate = (raw as Record<string, unknown>).command;
    if (typeof candidate === "string" && candidate.trim()) return { command: candidate.trim() };
  }
  return undefined;
}

/** Clamp a caller/env timeout into [1s, 10min]; invalid values use the default. */
export function verifyTimeoutMs(raw?: unknown): number {
  const source = raw === undefined ? process.env.TRIMEGISTO_VERIFY_TIMEOUT_MS : raw;
  const n = typeof source === "number" ? source : Number(source);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VERIFY_TIMEOUT_MS;
  return Math.min(MAX_VERIFY_TIMEOUT_MS, Math.max(1_000, Math.floor(n)));
}

/**
 * Keep the head (setup/warnings) and the tail (the actual failure) of a long
 * output. Middle-truncation, because a test runner's verdict is at the end and
 * its command context at the beginning.
 */
export function truncateVerifyOutput(text: string, max = MAX_VERIFY_OUTPUT_CHARS): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  const limit = Number.isFinite(max) && (max as number) > 0 ? Math.floor(max as number) : MAX_VERIFY_OUTPUT_CHARS;
  if (s.length <= limit) return s;
  const budget = Math.max(0, limit - TRUNCATE_MARK.length);
  const head = Math.ceil(budget * 0.4);
  const tail = budget - head;
  return s.slice(0, head) + TRUNCATE_MARK + (tail > 0 ? s.slice(s.length - tail) : "");
}

/** A one-line, human-facing badge for the reconciliation. "" when no verify ran. */
export function verificationBadge(v: VerificationResult | undefined): string {
  if (!v) return "";
  if (!v.ran) return v.error ? `verify: ⚠️ not run (${oneLine(v.error, 120)})` : "verify: ⚠️ not run";
  if (v.passed) return `verify: ✅ \`${oneLine(v.command, 120)}\` (${v.durationMs}ms)`;
  const why = v.timedOut ? `timeout after ${v.durationMs}ms` : `exit ${v.exitCode ?? "?"}`;
  return `verify: ❌ \`${oneLine(v.command, 120)}\` — ${why}`;
}

/**
 * True while any agent of the CURRENT wave still has a verification in flight.
 * The wave scheduler must not treat such a wave as terminal, or the batch would
 * settle (and inject an unverified verdict downstream) before the command ends.
 */
export function waveHasPendingVerification(
  agentIds: readonly string[],
  pending: { has(id: string): boolean } | undefined,
): boolean {
  if (!pending || !Array.isArray(agentIds)) return false;
  for (const id of agentIds) if (pending.has(id)) return true;
  return false;
}

/**
 * Run the verify command. Resolves ALWAYS (never rejects): the caller attaches
 * the result to the agent's verdict.
 */
export function runVerification(
  spec: VerifySpec | undefined,
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<VerificationResult> {
  const command = typeof spec?.command === "string" ? spec.command.trim() : "";
  const startedAt = Date.now();
  const base: VerificationResult = {
    command,
    ran: false,
    passed: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    output: "",
  };
  if (!command) {
    return Promise.resolve({ ...base, error: "no verify command" });
  }

  const timeoutMs = verifyTimeoutMs(options.timeoutMs);
  const env = options.env ?? process.env;

  return new Promise<VerificationResult>((resolve) => {
    let settled = false;
    let collected = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (extra: Partial<VerificationResult>): void => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      let raw = Buffer.concat(chunks).toString("utf-8");
      if (overflowed) raw += COLLECT_LIMIT_MARK;
      resolve({
        ...base,
        ...extra,
        durationMs: Math.max(0, Date.now() - startedAt),
        output: truncateVerifyOutput(lightRedact(raw)),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd: cwd && typeof cwd === "string" ? cwd : process.cwd(),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve({ ...base, error: errMessage(err), durationMs: Math.max(0, Date.now() - startedAt) });
      return;
    }

    const collect = (data: Buffer): void => {
      if (collected >= MAX_COLLECT_BYTES) { overflowed = true; return; }
      collected += data.length;
      chunks.push(data);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      // Escalate if it ignores SIGTERM. Kept unref'd so a stuck child cannot
      // keep the host process alive.
      const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2_000);
      if (typeof (killer as any).unref === "function") (killer as any).unref();
      if (typeof (timer as any)?.unref === "function") (timer as any).unref();
    }, timeoutMs);

    child.on("error", (err) => finish({ ran: false, error: errMessage(err) }));
    child.on("close", (code, signal) => {
      const timedOut = !settled && Date.now() - startedAt >= timeoutMs;
      finish({
        ran: true,
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
        timedOut,
        passed: !timedOut && code === 0,
      });
    });
  });
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "unknown error");
}

function oneLine(s: string, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, Math.max(0, max - 1)) + "…" : flat;
}
