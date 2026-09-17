/**
 * Trimegisto - per-batch on-disk ledger
 *
 * The shared filesystem workspace from arXiv:2608.26480 §3.1, adapted to
 * Trimegisto's unit of work. The paper's ledger holds `plan.md`, `tasks.json`
 * and `notes.md` so that state lives on disk instead of in one growing context
 * window, and so a manager can re-read and re-curate the task list. Trimegisto
 * has no manager loop yet (deliberately, v1), so this ledger is the SUBSTRATE:
 * it makes the batch's plan and per-task statuses inspectable and gives a future
 * loop the exact artifact it would curate.
 *
 * Layout: <instanceDir>/batches/<batchId>/{plan.md, tasks.json, notes.md}
 *
 * The ledger is a RECORD, never a source of truth: orchestration lives in the
 * extension's in-memory batch state. Every write is best-effort and never
 * throws — a read-only home directory must not break a batch.
 *
 * `tasks[]` is intentionally loop-ready: a future manager would mark items done,
 * merge duplicates and append a next task to this same array.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface LedgerVerification {
  command?: string;
  ran: boolean;
  passed: boolean;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  durationMs?: number;
  output?: string;
  error?: string;
}

export interface LedgerTask {
  /** 1-based index as the coordinator saw it. */
  index: number;
  agentId?: string;
  tier: string;
  task: string;
  wave?: number;
  needs?: number[];
  verify?: string;
  /** pending | running | done | error | killed */
  status: string;
  verification?: LedgerVerification;
  /** Bounded distilled verdict of the agent's final message. */
  verdict?: string;
  updatedAt?: number;
}

export interface LedgerState {
  version: 1;
  batchId: string;
  goal?: string;
  createdAt: number;
  updatedAt: number;
  tasks: LedgerTask[];
}

export interface PublishedNote {
  agentId: string;
  text: string;
  ts: number;
}

export const LEDGER_SUBDIR = "batches";
export const LEDGER_TASKS_FILE = "tasks.json";
export const LEDGER_PLAN_FILE = "plan.md";
export const LEDGER_NOTES_FILE = "notes.md";
/** Ledger dirs in a long-lived session are pruned after this age. */
export const DEFAULT_LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TASK_CHARS = 240;

export function ledgerRoot(instanceDir: string): string {
  return path.join(String(instanceDir ?? ""), LEDGER_SUBDIR);
}

/** Filesystem-safe per-batch dir. Never escapes `ledgerRoot`. */
export function ledgerDir(instanceDir: string, batchId: string): string {
  const safe = String(batchId ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "batch";
  return path.join(ledgerRoot(instanceDir), safe);
}

/**
 * Create the batch dir and write plan.md + tasks.json. Returns the dir, or
 * null when the ledger could not be created (never throws).
 */
export function initLedger(instanceDir: string, state: LedgerState): string | null {
  if (!instanceDir || !state) return null;
  const dir = ledgerDir(instanceDir, state.batchId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, LEDGER_PLAN_FILE), renderPlanMd(state));
    writeLedger(dir, state);
    return dir;
  } catch {
    return null;
  }
}

/** Rewrite tasks.json atomically (temp + rename, so a reader never sees a half file). */
export function writeLedger(dir: string, state: LedgerState): boolean {
  if (!dir || !state) return false;
  const next: LedgerState = { ...state, updatedAt: Date.now() };
  return writeFileAtomic(path.join(dir, LEDGER_TASKS_FILE), JSON.stringify(next, null, 2));
}

export function readLedger(dir: string): LedgerState | null {
  try {
    const raw = fs.readFileSync(path.join(dir, LEDGER_TASKS_FILE), "utf-8");
    const parsed = JSON.parse(raw) as LedgerState;
    if (!parsed || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Link a launched agent to its task. Pure; returns true when matched. */
export function setLedgerTaskAgent(state: LedgerState | null, index: number, agentId: string): boolean {
  if (!state || !Array.isArray(state.tasks)) return false;
  const task = state.tasks.find(t => t.index === index);
  if (!task) return false;
  task.agentId = agentId;
  return true;
}

/**
 * Apply a result patch to the task identified by agentId (or, failing that,
 * by index). Pure; returns true when a task was updated.
 */
export function updateLedgerTask(
  state: LedgerState | null,
  match: { agentId?: string; index?: number },
  patch: Partial<Pick<LedgerTask, "status" | "verification" | "verdict" | "agentId">>,
): boolean {
  if (!state || !Array.isArray(state.tasks) || !match) return false;
  const task = (match.agentId !== undefined ? state.tasks.find(t => t.agentId === match.agentId) : undefined)
    ?? (match.index !== undefined ? state.tasks.find(t => t.index === match.index) : undefined);
  if (!task) return false;
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.verification !== undefined) task.verification = patch.verification;
  if (patch.verdict !== undefined) task.verdict = patch.verdict;
  if (patch.agentId !== undefined) task.agentId = patch.agentId;
  task.updatedAt = Date.now();
  return true;
}

/** The plan as markdown. Deterministic for a given state (createdAt excepted). */
export function renderPlanMd(state: LedgerState, now: number = Date.now()): string {
  const lines: string[] = [];
  lines.push(`# 🪡 Trimegisto ledger · ${state.batchId}`);
  lines.push("");
  if (state.goal) lines.push(`**Goal:** ${escapeCell(state.goal)}`);
  lines.push(`**Created:** ${isoOrDash(state.createdAt)} · **Tasks:** ${state.tasks.length}`);
  lines.push("");
  lines.push("| # | wave | tier | status | verify | task |");
  lines.push("|---|------|------|--------|--------|------|");
  for (const t of state.tasks) {
    lines.push(`| ${t.index} | ${t.wave ?? "-"} | ${escapeCell(t.tier)} | ${escapeCell(t.status)} | ${t.verify ? `\`${escapeCell(t.verify)}\`` : "-"} | ${escapeCell(truncate(t.task, MAX_TASK_CHARS))} |`);
  }
  lines.push("");
  // Keep the seam explicit: this array is what a future manager loop curates.
  lines.push("<!-- tasks.json is the unit a manager-loop would curate (statuses, merged tasks, next task). -->");
  lines.push(`<!-- rendered ${new Date(Number.isFinite(now) ? now : Date.now()).toISOString()} -->`);
  return lines.join("\n") + "\n";
}

export function renderNotesMd(notes: PublishedNote[]): string {
  const list = Array.isArray(notes) ? notes : [];
  const lines: string[] = ["# 📝 Notes (snapshot at batch settle)", ""];
  if (list.length === 0) {
    lines.push("_(no notes were published by the batch's agents)_");
  } else {
    for (const n of list) {
      lines.push(`- **[${escapeCell(n.agentId)}]** ${String(n.text ?? "").replace(/\s+/g, " ").trim()}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function writeLedgerNotes(dir: string, notes: PublishedNote[]): boolean {
  if (!dir) return false;
  return writeFileAtomic(path.join(dir, LEDGER_NOTES_FILE), renderNotesMd(notes));
}

/**
 * Remove ledger dirs older than `maxAgeMs` under the instance root. Returns the
 * number removed. Never throws.
 */
export function pruneLedgers(instanceDir: string, maxAgeMs: number, now: number = Date.now()): number {
  const root = ledgerRoot(instanceDir);
  const age = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_LEDGER_MAX_AGE_MS;
  let removed = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs > age) { fs.rmSync(full, { recursive: true, force: true }); removed++; }
    } catch { /* skip unreadable entry */ }
  }
  return removed;
}

// ── internals ───────────────────────────────────────────────

function writeFileAtomic(file: string, content: string): boolean {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

function escapeCell(s: unknown): string {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function truncate(s: string, max: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, Math.max(0, max - 1)) + "…" : flat;
}

function isoOrDash(ts: number): string {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : "-";
}
