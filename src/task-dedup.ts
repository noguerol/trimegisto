/**
 * Trimegisto - Task Deduplication
 *
 * Pre-launch guard against redundant agent work. Before a task is launched,
 * it is fingerprinted (exact) and compared by word-set overlap (near-duplicate)
 * against tasks spawned recently. Near-duplicates are rejected so the swarm
 * never pays twice for effectively the same work.
 *
 * Word-set (order-insensitive, stopword-stripped) Jaccard is deliberately
 * robust to small rewordings ("count rows in logs.csv" vs "count the rows of
 * logs.csv") while still distinguishing genuinely different tasks that only
 * share a noun ("analyze src/a.ts" vs "analyze src/b.ts").
 *
 * API is split in two so callers only REGISTER a task once it is actually
 * about to launch (avoiding false "duplicate" on pre-flight failures):
 *   - isDuplicateTask(task)   check-only against the global registry
 *   - registerTask(tier, task)  commit a task to the registry at launch time
 *   - dedupeTaskBatch(tasks)  dedup a whole batch incl. within-batch overlaps
 *
 * Consumers:
 *   - agent-manager.processSpawnRequests (auto-spawn from sub-agents)
 *   - index.ts registerMainTool.execute (main `trimegisto` tool)
 */

import type { AgentTier } from "./types.ts";
import { normalizeText, quickHash } from "./similarity.ts";

// ── Tunables ────────────────────────────────────────────────
/** How long a spawned task stays "recent" for dedup purposes. */
const DEDUPE_WINDOW_MS = 5 * 60_000;
/** Word-set Jaccard threshold above which two tasks count as near-duplicates. */
const TASK_DEDUPE_SIMILARITY = 0.75;
/** Cap on the in-memory registry size. */
const DEDUPE_MAX_ENTRIES = 256;

/** Words that rarely disambiguate one task from another. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "for", "on", "with", "at",
  "by", "from", "into", "is", "are", "be", "this", "that", "these", "those",
  "please", "do", "it", "its", "file", "files", "me", "my", "i",
]);

interface TaskEntry {
  fingerprint: string;
  words: Set<string>;
  task: string;
  tier: AgentTier;
  ts: number;
}

export interface TaskDedupeResult {
  duplicate: boolean;
  matchedTask?: string;
  matchedTier?: AgentTier;
  similarity?: number;
}

const registry: TaskEntry[] = [];
let duplicatesSkipped = 0;

function fingerprintOf(task: string): string {
  const s = normalizeText(task);
  if (!s) return "";
  // 32-bit FNV-1a → base36 for a compact, stable key
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function wordSet(task: string): Set<string> {
  const words = normalizeText(task)
    .split(" ")
    .filter(Boolean)
    .filter(w => !STOPWORDS.has(w));
  return new Set(words);
}

function wordSetSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

function prune(now: number): void {
  while (registry.length > 0 && now - registry[0].ts > DEDUPE_WINDOW_MS) {
    registry.shift();
  }
  if (registry.length > DEDUPE_MAX_ENTRIES) {
    registry.splice(0, registry.length - DEDUPE_MAX_ENTRIES);
  }
}

/** Check a task against recently spawned tasks (does NOT register it). */
export function isDuplicateTask(task: string, now: number = Date.now()): TaskDedupeResult {
  const normalized = normalizeText(task);
  if (!normalized) return { duplicate: false };

  prune(now);
  const fingerprint = fingerprintOf(task);
  const words = wordSet(task);

  for (const entry of registry) {
    if (entry.fingerprint === fingerprint) {
      duplicatesSkipped++;
      return { duplicate: true, matchedTask: entry.task, matchedTier: entry.tier, similarity: 1 };
    }
    const sim = wordSetSimilarity(entry.words, words);
    if (sim >= TASK_DEDUPE_SIMILARITY) {
      duplicatesSkipped++;
      return { duplicate: true, matchedTask: entry.task, matchedTier: entry.tier, similarity: Math.round(sim * 1000) / 1000 };
    }
  }
  return { duplicate: false };
}

/** Commit a task to the registry. Call only once it is actually launching. */
export function registerTask(tier: AgentTier, task: string, now: number = Date.now()): void {
  const normalized = normalizeText(task);
  if (!normalized) return;
  prune(now);
  registry.push({ fingerprint: fingerprintOf(task), words: wordSet(task), task, tier, ts: now });
}

/**
 * Dedup an entire batch, catching near-duplicates both against the global
 * registry AND within the batch itself. Does NOT register anything — callers
 * must `registerTask` each accepted task at launch time.
 */
export function dedupeTaskBatch<T extends { tier: AgentTier; task: string }>(
  tasks: T[],
): {
  accepted: T[];
  skipped: Array<{ task: string; tier: AgentTier; matchedTask: string; matchedTier?: AgentTier; similarity?: number }>;
} {
  const accepted: T[] = [];
  const skipped: Array<{ task: string; tier: AgentTier; matchedTask: string; matchedTier?: AgentTier; similarity?: number }> = [];
  const local: TaskEntry[] = [];

  for (const t of tasks) {
    const normalized = normalizeText(t.task);
    if (!normalized) { accepted.push(t); continue; }

    const fingerprint = fingerprintOf(t.task);
    const words = wordSet(t.task);

    let dup: TaskDedupeResult = isDuplicateTask(t.task);
    if (!dup.duplicate) {
      for (const e of local) {
        if (e.fingerprint === fingerprint) {
          dup = { duplicate: true, matchedTask: e.task, matchedTier: e.tier, similarity: 1 };
          break;
        }
        const sim = wordSetSimilarity(e.words, words);
        if (sim >= TASK_DEDUPE_SIMILARITY) {
          dup = { duplicate: true, matchedTask: e.task, matchedTier: e.tier, similarity: Math.round(sim * 1000) / 1000 };
          break;
        }
      }
    }

    if (dup.duplicate) {
      skipped.push({ task: t.task, tier: t.tier, matchedTask: dup.matchedTask || "", matchedTier: dup.matchedTier, similarity: dup.similarity });
    } else {
      accepted.push(t);
      local.push({ fingerprint, words, task: t.task, tier: t.tier, ts: Date.now() });
    }
  }

  return { accepted, skipped };
}

/**
 * Remove a task from the registry (e.g. when a spawn that was accepted later
 * fails, so a legitimate retry is not blocked).
 */
export function forgetTask(task: string): void {
  const fingerprint = fingerprintOf(task);
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].fingerprint === fingerprint) {
      registry.splice(i, 1);
    }
  }
}

export function clearTaskDedupe(): void {
  registry.length = 0;
  duplicatesSkipped = 0;
}

export function getTaskDedupeStats(): { duplicatesSkipped: number; windowMs: number; activeEntries: number } {
  return { duplicatesSkipped, windowMs: DEDUPE_WINDOW_MS, activeEntries: registry.length };
}
