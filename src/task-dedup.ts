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
 *   - forgetTask(task)        unregister a failed launch so a retry is allowed
 *   - wordSet / wordSetSimilarity  shared with the plan gate's clustering
 *
 * Within-batch duplication used to live here (`dedupeTaskBatch`); it now belongs
 * to the plan gate (`plan-graph.ts`), which merges duplicates, serialises
 * same-file writers and orders dependencies in one deterministic pass.
 *
 * Consumers:
 *   - agent-manager.processSpawnRequests (auto-spawn from sub-agents)
 *   - index.ts registerMainTool.execute (main `trimegisto` tool)
 *   - plan-graph.ts (duplicate clustering inside a batch)
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

/**
 * Word-set of a task: normalized, stopword-stripped, order-insensitive.
 * Exported so other pure modules (the plan gate) measure overlap the same way
 * the launch-time dedup does — shingles collapse on short task descriptions.
 */
export function wordSet(task: string): Set<string> {
  const words = normalizeText(task)
    .split(" ")
    .filter(Boolean)
    .filter(w => !STOPWORDS.has(w));
  return new Set(words);
}

export function wordSetSimilarity(a: Set<string>, b: Set<string>): number {
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
