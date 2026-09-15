/**
 * Trimegisto - Plan graph
 *
 * Pure, deterministic planner that turns a batch of proposed sub-agent tasks
 * into a validated PLAN GRAPH: which tasks are real nodes, which are duplicates,
 * which must run in SERIES (an edge) and which can run in PARALLEL, which should
 * not use a model at all, and which must not run.
 *
 * Design constraints (load-bearing):
 *   - no pi imports, no I/O, no `Date.now()`, no randomness;
 *   - never throws on malformed input;
 *   - same input => byte-identical `summary`.
 *
 * It reuses the shared similarity primitives so the plan gate measures overlap
 * exactly like `task-dedup` does.
 */

import { normalizeText, shingleHashes, jaccardSimilarity } from "./similarity.ts";
import { wordSet, wordSetSimilarity } from "./task-dedup.ts";

// ── Frozen public interface ─────────────────────────────────

export interface PlanTaskInput {
  task: string;
  /** 1-based index of another task in the SAME batch that must finish first. */
  needs?: number[];
  /** One line: which part of the overall goal this task serves. */
  why?: string;
  /** Files this task will write (optional; used to serialise colliding writers). */
  writes?: string[];
  /** Execution tier ("active" | "t1" | "t2" | "t3"); used for capacity-aware waves. */
  tier?: string;
  /** Explicit lane override; when absent the lane is derived from the task text. */
  lane?: "open" | "gated" | "closed";
  cwd?: string;
}

export type PlanLane = "open" | "gated" | "closed";

export interface PlanNode {
  index: number;          // 1-based, as the coordinator sees it
  task: string;
  needs: number[];        // validated deps (1-based, same batch)
  tier: string;           // "active" | "t1" | "t2" | "t3"
  wave: number;           // 1-based topological level
  lane: PlanLane;
  laneReason: string;
  warnings: string[];
  codeNode: boolean;
  duplicateOf?: number;   // 1-based index of the node it duplicates
}

export interface PlanDecision {
  accept: boolean;
  repaired: boolean;
  nodes: PlanNode[];      // every proposed task, including duplicates
  launch: PlanNode[];     // nodes that will actually run (duplicates removed)
  waves: number[][];      // 1-based indices per wave, ascending
  warnings: string[];
  blockers: string[];
  summary: string;        // deterministic human-readable markdown
  counts: { proposed: number; launch: number; duplicates: number; serialized: number; closed: number; capacityDeferred: number };
}

export interface PlanOptions {
  goal?: string;
  duplicateThreshold?: number;  // default 0.72
  maxTasks?: number;            // default 8
  /**
   * Per-tier concurrency caps ("active" | "t1" | "t2" | "t3" => max parallel).
   * When a wave would exceed a tier's cap the planner defers nodes to the NEXT
   * wave instead of planning a wave the launcher could never start. Omitted or
   * non-finite values mean "unlimited" (previous behaviour).
   */
  tierCapacity?: Record<string, number>;
}

// ── Tunables ────────────────────────────────────────────────

const DEFAULT_DUPLICATE_THRESHOLD = 0.72;
const DEFAULT_MAX_TASKS = 8;
const GOAL_AFFINITY_FLOOR = 0.06;

// ── Lane keywords (exported for tests) ──────────────────────

/** Irreversible on their own: matched as whole phrases, no target needed. */
export const CLOSED_PRIMARY_PHRASES: string[] = [
  "force push", "force-push", "push --force", "git push -f", "reset --hard",
  "rm -rf", "drop table", "drop database", "drop schema", "truncate table",
  "production data", "live database", "live data", "private key", "api key",
  "rotate keys", "rotate the keys", "rotate credentials", "revoke access",
  "run the migration", "run the migrations", "apply the migration", "apply the migrations",
  "database migration", "schema migration", "npm publish", "publish to npm",
  "deploy to production", "deploy to prod", "release to production",
  "terraform destroy", "kubectl delete", "aws s3 rm", "delete from production",
];

/**
 * Destructive / high-consequence verbs. These close the lane ONLY together with
 * a high-blast-radius target — matching the verb alone would refuse benign work
 * like "delete the temporary files" (the first version did exactly that and
 * refused 13 of 15 realistic tasks).
 */
export const CLOSED_ACTION_VERBS: string[] = [
  "delete", "deletes", "deleted", "deleting", "deletion", "deletions",
  "remove", "removes", "removed", "removing",
  "drop", "drops", "dropped", "dropping",
  "truncate", "truncates", "truncating",
  "wipe", "wipes", "wiping", "purge", "purges", "purging",
  "destroy", "destroys", "destroying", "unlink", "rm",
  "migrate", "migrates", "migrating", "deploy", "deploys", "deploying",
  "publish", "publishes", "publishing", "release", "releases", "releasing",
  "overwrite", "overwrites", "overwriting", "rotate", "rotates", "rotating",
  "revoke", "revokes", "revoking",
];

/**
 * Targets whose loss is NOT recoverable from the repo. These close the lane even
 * when a local/ephemeral qualifier is present, because "local production db" is
 * still production.
 */
export const CLOSED_CRITICAL_TARGETS: string[] = [
  "production", "prod", "production data", "live data", "live database",
  "credentials", "private key", "api key",
  "registry", "infrastructure", "infra", "terraform state", "kubernetes", "k8s",
  "payment", "payments", "money",
];

/**
 * Ambiguous targets: ordinary words that are dangerous only in context. They
 * close the lane ONLY when no local/ephemeral qualifier is present ("the local
 * server module", "the accounts.ts import", "the secret santa sample" are all
 * benign).
 */
export const CLOSED_ORDINARY_TARGETS: string[] = [
  "database", "databases", "db", "users", "accounts", "customers", "secrets", "secret",
  "remote", "origin", "upstream", "history", "backup", "backups", "bucket", "cluster",
  "servers", "server", "table", "tables", "column", "columns", "schema", "records", "record",
  "rows", "row", "file", "files", "branch", "branches", "tag", "tags", "package", "release",
  "version", "artifacts", "artifact", "volume", "queue", "topic", "namespace", "live",
];

/** Legacy alias: every target that can close a lane in some context. */
export const CLOSED_SEVERE_TARGETS: string[] = [...CLOSED_CRITICAL_TARGETS, ...CLOSED_ORDINARY_TARGETS];


/**
 * Ephemeral / local / VCS-safe targets. Their presence neutralises the
 * verb+target rule (deleting a temp file or a fixture is not high blast radius).
 */
export const CLOSED_SAFE_TARGETS: string[] = [
  "temp", "tmp", "temporary", "cache", "cached", "build", "dist", "output", "scratch",
  "fixture", "fixtures", "log", "logs", "node_modules", "generated", "debug",
  "local", "locally", "test", "tests", "testing", "sample", "samples", "mock", "mocks",
  "docs", "documentation", "report", "summary", "comment", "comments", "unused",
  "stale", "dead code", "duplicate", "duplicates", "whitespace", "typo", "typos",
  // Presentation / in-process surfaces: a "table" that is rendered or a "users"
  // list held in memory is not high blast radius. These only neutralise the
  // VERB+MEDIUM rule — an explicit severe target (production, origin, real DB)
  // still closes the lane.
  "ui", "ui layer", "view", "views", "render", "renders", "rendering", "display",
  "in-memory", "in memory", "label", "labels", "string", "strings", "text",
  "cosmetic", "formatting", "placeholder", "message", "messages", "tooltip",
];

/**
 * Backwards-compatible view of "what can put a task in the closed lane"
 * (unconditional phrases + the destructive verbs). Exported for tests/UI.
 */
export const CLOSED_LANE_KEYWORDS: string[] = [...CLOSED_PRIMARY_PHRASES, ...CLOSED_ACTION_VERBS];

/** Wide but reversible surfaces. Matching any of these -> gated lane. */
export const GATED_LANE_KEYWORDS: string[] = [
  "shared util", "shared utils", "shared utility", "shared utilities",
  "common util", "common utils", "helpers",
  "schema", "schemas", "migration file",
  "public api", "api surface", "public interface", "interface", "interfaces",
  "auth", "authentication", "authorization", "login",
  "config", "configuration", "settings",
  "lockfile", "lock file", "package-lock", "package lock",
  "yarn.lock", "pnpm-lock", "cargo.lock",
  "ci", "continuous integration", "workflow", "workflows",
  "github action", "github actions", "build config",
  "index.ts", "types.ts",
];

/** Words that rarely disambiguate a goal from a task. */
export const GOAL_STOPWORDS: Set<string> = new Set([
  "this", "that", "these", "those", "with", "from", "into", "your", "yours",
  "have", "has", "will", "would", "should", "could", "then", "than", "them",
  "they", "their", "there", "where", "when", "what", "which", "while", "about",
  "after", "before", "between", "during", "under", "over", "also", "just",
  "like", "make", "made", "need", "needs", "must", "only", "same", "some",
  "such", "very", "well", "more", "most", "much", "many", "each", "other",
  "onto", "upon", "does", "doing", "done", "been", "being", "were", "are",
  "for", "and", "the", "task", "tasks", "goal", "work", "please", "able",
  "want", "help",
]);

// ── Mechanical / reasoning vocabularies ─────────────────────

const MECHANICAL_VERBS: string[] = [
  "parse", "count", "sort", "dedupe", "deduplicate", "rename", "format",
  "convert", "extract", "list", "grep", "sum", "merge", "compare", "diff",
  "validate", "regex", "scan", "find",
];

const REASONING_WORDS: string[] = [
  "decide", "judge", "assess", "evaluate", "design", "review", "summarise",
  "summarize", "investigate", "debug", "diagnose", "why", "root cause",
  "advise", "recommend", "propose", "hypothesis",
];

// Phrases that name a consumed upstream output.
const PIPELINE_PATTERNS: RegExp[] = [
  /\bthen\b/i,
  /\bafter that\b/i,
  /\bafterwards\b/i,
  /\bbased on the (result|results|output|outputs|finding|findings)\b/i,
  /\busing the (result|results|output|outputs)\b/i,
  /\bonce\b[\s\S]{0,60}\bis done\b/i,
  /\bfrom the previous\b/i,
  /\bthe findings\b/i,
  /\bits output\b/i,
  /\bthe above\b/i,
  /\bfollow[- ]?up to\b/i,
  /\bcontinue from\b/i,
];

// ── Small pure helpers ──────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchKeyword(text: string, keywords: string[]): string | null {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`);
    if (re.test(lower)) return kw;
  }
  return null;
}

function containsWord(text: string, word: string): boolean {
  const re = new RegExp(`\\b${escapeRegExp(word)}(?:s|es|ed|d|ing)?\\b`, "i");
  return re.test(text);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function formatIndices(indices: number[]): string {
  if (indices.length === 0) return "";
  if (indices.length === 1) return `#${indices[0]}`;
  if (indices.length === 2) return `#${indices[0]} and #${indices[1]}`;
  return indices.slice(0, -1).map(i => `#${i}`).join(", ") + " and #" + indices[indices.length - 1];
}

/**
 * Pure, dependency-free normalisation used ONLY to compare two `writes` paths
 * for the same physical file. Raw string equality missed `./src/a.ts` vs
 * `src/a.ts`, `src\\a.ts`, `SRC/A.TS` and `src/a.ts/`, so two agents were
 * launched to write the same file. No `node:path` (this module is pure and
 * import-free apart from the shared similarity primitives).
 *
 * Returns "" when the path normalises away entirely (empty, whitespace, ".",
 * "/", "./"); callers must skip those so one empty path never collides with
 * another.
 */
function normalizeWritePath(p: string): string {
  const parts: string[] = [];
  for (const seg of String(p ?? "").trim().replace(/\\/g, "/").toLowerCase().split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

// ── Public classifiers ──────────────────────────────────────

/**
 * Derive the lane from the task text. Closed wins over gated; open is default.
 * The reason always quotes the matched keyword so the coordinator can see WHY.
 */
export function classifyLane(task: string): { lane: PlanLane; reason: string } {
  const text = typeof task === "string" ? task : String(task ?? "");
  if (!text.trim()) return { lane: "open", reason: "open lane: empty task" };

  // 1) Unconditionally irreversible phrases (a verb alone says nothing).
  const primary = matchKeyword(text, CLOSED_PRIMARY_PHRASES);
  if (primary) {
    return { lane: "closed", reason: `closed lane: irreversible phrase "${primary}" (high blast radius)` };
  }

  // 2) Destructive verb + target. The verb alone says nothing (the first version
  //    refused "delete the temporary files"), the target alone neither. CRITICAL
  //    targets close outright; ambiguous ones only close when the task shows no
  //    local/ephemeral qualifier, because "the local server module" and "the
  //    accounts.ts import" are ordinary work.
  const action = matchKeyword(text, CLOSED_ACTION_VERBS);
  if (action) {
    const critical = matchKeyword(text, CLOSED_CRITICAL_TARGETS);
    if (critical) {
      return { lane: "closed", reason: `closed lane: "${action}" targets "${critical}" (irreversible / high blast radius)` };
    }
    const safe = matchKeyword(text, CLOSED_SAFE_TARGETS);
    if (!safe) {
      const target = matchKeyword(text, CLOSED_ORDINARY_TARGETS);
      if (target) {
        return { lane: "closed", reason: `closed lane: "${action}" targets "${target}" with no local/ephemeral qualifier` };
      }
    }
  }

  const gated = matchKeyword(text, GATED_LANE_KEYWORDS);
  if (gated) {
    return { lane: "gated", reason: `gated lane: matches "${gated}" (wide but reversible surface)` };
  }
  return { lane: "open", reason: "open lane: no high-risk surface keyword detected" };
}

/**
 * True when the task is a mechanical transformation that a bash/code node can do
 * with no model: it must contain a mechanical verb and NO reasoning word.
 */
export function looksLikeCodeNode(task: string): boolean {
  const text = typeof task === "string" ? task : String(task ?? "");
  if (!text.trim()) return false;
  const mechanical = MECHANICAL_VERBS.some(v => containsWord(text, v));
  if (!mechanical) return false;
  const reasoning = REASONING_WORDS.some(w => containsWord(text, w));
  return !reasoning;
}

/**
 * True when the task text clearly consumes an upstream output ("then", "its
 * output", "based on the findings", ...). Used to warn about a missing `needs`.
 */
export function looksLikePipelineStep(text: string): boolean {
  const t = typeof text === "string" ? text : String(text ?? "");
  if (!t.trim()) return false;
  return PIPELINE_PATTERNS.some(re => re.test(t));
}

/**
 * Very light, deterministic singularisation. Lexical overlap must not fail on
 * "manifests" vs "manifest" — a noisy relevance check is an ignored one.
 * Deliberately naive (no dictionary, no ambiguity handling): strip one plural
 * suffix from words long enough that the stem stays meaningful.
 */
function stem(word: string): string {
  if (word.length >= 6 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length >= 6 && (word.endsWith("es") || word.endsWith("ed"))) return word.slice(0, -2);
  if (word.length >= 5 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function goalTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeText(text).split(" ")) {
    if (raw.length >= 4 && !GOAL_STOPWORDS.has(raw)) out.add(stem(raw));
  }
  return out;
}

/**
 * Deterministic 0..1 lexical overlap between the goal and a task (+ optional
 * `why` line). Returns 0 when the goal is empty/undefined.
 */
export function goalAffinity(goal: string | undefined, task: string, why?: string): number {
  if (goal === undefined || goal === null) return 0;
  const g = typeof goal === "string" ? goal : String(goal);
  if (!normalizeText(g)) return 0;
  const gt = goalTokens(g);
  if (gt.size === 0) return 0;
  const tt = goalTokens(`${typeof task === "string" ? task : String(task ?? "")} ${typeof why === "string" ? why : ""}`);
  let inter = 0;
  for (const w of tt) if (gt.has(w)) inter++;
  return inter / gt.size;
}

// ── Internal model ──────────────────────────────────────────

interface InternalNode {
  index: number;
  task: string;
  why?: string;
  writes: string[];
  needs: number[];
  tier: string;
  lane: PlanLane;
  laneReason: string;
  warnings: string[];
  codeNode: boolean;
  duplicateOf?: number;
  duplicateNote?: string;
  wave: number;
}

interface Entry {
  task: string;
  needs: unknown;
  writes: unknown;
  why: unknown;
  lane: unknown;
  tier: unknown;
}

function entryOf(raw: unknown): Entry | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    return { task: raw, needs: undefined, writes: undefined, why: undefined, lane: undefined, tier: undefined };
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return { task: String(raw), needs: undefined, writes: undefined, why: undefined, lane: undefined, tier: undefined };
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return {
      task: o.task === null || o.task === undefined ? "" : String(o.task),
      needs: o.needs,
      writes: o.writes,
      why: o.why,
      lane: o.lane,
      tier: o.tier,
    };
  }
  return null;
}

function coerceWrites(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const w of raw) {
    if (w === null || w === undefined) continue;
    const s = String(w).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// ── Graph helpers ───────────────────────────────────────────

function rebuildFeeds(indices: number[], needsOf: Map<number, number[]>): Map<number, number[]> {
  const feeds = new Map<number, number[]>();
  for (const i of indices) feeds.set(i, []);
  for (const i of indices) {
    for (const d of needsOf.get(i) || []) {
      const arr = feeds.get(d);
      if (arr) arr.push(i);
    }
  }
  for (const i of indices) (feeds.get(i) || []).sort((a, b) => a - b);
  return feeds;
}

/** Return one cycle as an ordered node list, or null. Edges are dep -> dependent. */
function findCycle(indices: number[], feeds: Map<number, number[]>): number[] | null {
  const state = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  let cycle: number[] | null = null;

  const dfs = (u: number): boolean => {
    state.set(u, 1);
    onStack.add(u);
    stack.push(u);
    for (const v of feeds.get(u) || []) {
      if (cycle) return true;
      const s = state.get(v) ?? 0;
      if (s === 1 && onStack.has(v)) {
        cycle = stack.slice(stack.indexOf(v));
        return true;
      }
      if (s === 0 && dfs(v)) return true;
    }
    stack.pop();
    onStack.delete(u);
    state.set(u, 2);
    return false;
  };

  for (const i of indices) {
    if ((state.get(i) ?? 0) === 0 && dfs(i)) break;
  }
  return cycle;
}

function reachable(feeds: Map<number, number[]>, start: number, target: number): boolean {
  const seen = new Set<number>();
  const stack: number[] = [start];
  while (stack.length > 0) {
    const u = stack.pop() as number;
    if (u === target) return true;
    if (seen.has(u)) continue;
    seen.add(u);
    for (const v of feeds.get(u) || []) if (!seen.has(v)) stack.push(v);
  }
  return false;
}

// ── Tier capacity spread ────────────────────────────────────

/** Canonical tier key: "t0"/"active" collapse to "active"; unknown values are kept lowercased. */
function normalizeTierKey(tier: unknown): string {
  if (typeof tier !== "string") return "active";
  const t = tier.trim().toLowerCase();
  return t === "" || t === "t0" || t === "active" ? "active" : t;
}

/**
 * Defer nodes to later waves until no wave exceeds its tier's concurrency cap.
 *
 * Only WAVE NUMBERS move: `needs` keeps the task's real data dependencies, so
 * the scheduler still passes an upstream verdict only where the coordinator
 * asked for one. Two nodes that already share a wave are mutually unreachable
 * (an edge between them would have put them in different topological levels),
 * so deferring one behind the other can never introduce a cycle.
 *
 * The plan gate used to hand a 5-wide t2 wave to a 2-slot config; the launcher
 * then refused the WHOLE batch because it could never start that wave. This is
 * the planning half of that fix.
 *
 * Deterministic: waves ascend, tiers are visited in sorted order and nodes in
 * ascending index order. Every deferral strictly increases a node's wave, and a
 * wave can never exceed the node count, so the loop always terminates.
 */
function enforceTierCapacity(
  launched: InternalNode[],
  feedsOf: Map<number, number[]>,
  waveOf: Map<number, number>,
  capacity: Record<string, number> | undefined,
): { deferred: number; notes: string[] } {
  if (!capacity || launched.length === 0) return { deferred: 0, notes: [] };

  const tierOf = new Map<number, string>();
  const initial = new Map<number, number>();
  for (const nd of launched) {
    tierOf.set(nd.index, normalizeTierKey(nd.tier));
    initial.set(nd.index, waveOf.get(nd.index) || 1);
  }
  const capOf = (tier: string): number => {
    const raw = capacity[tier];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : Infinity;
  };

  const maxMoves = launched.length * launched.length + launched.length + 1;
  let moves = 0;

  /** Move `start` to at least `minWave`, then pull its dependents forward after it. */
  const bump = (start: number, minWave: number): void => {
    if ((waveOf.get(start) || 1) >= minWave) return;
    waveOf.set(start, minWave);
    moves++;
    const queue = [start];
    while (queue.length > 0 && moves <= maxMoves) {
      const u = queue.shift() as number;
      const need = (waveOf.get(u) || 1) + 1;
      for (const v of feedsOf.get(u) || []) {
        if ((waveOf.get(v) || 1) < need) {
          waveOf.set(v, need);
          moves++;
          queue.push(v);
        }
      }
    }
  };

  for (;;) {
    if (moves > maxMoves) break;
    // Index the CURRENT waves by tier so the overflow of the earliest wave is
    // pushed first (deterministic and keeps the deferral minimal-ish).
    const byWave = new Map<number, Map<string, number[]>>();
    let maxWave = 0;
    for (const nd of launched) {
      const w = waveOf.get(nd.index) || 1;
      if (w > maxWave) maxWave = w;
      let tm = byWave.get(w);
      if (!tm) { tm = new Map(); byWave.set(w, tm); }
      const t = tierOf.get(nd.index) || "active";
      const arr = tm.get(t);
      if (arr) arr.push(nd.index);
      else tm.set(t, [nd.index]);
    }
    let changed = false;
    for (let w = 1; w <= maxWave && !changed; w++) {
      const tm = byWave.get(w);
      if (!tm) continue;
      for (const tier of [...tm.keys()].sort()) {
        const cap = capOf(tier);
        if (!Number.isFinite(cap)) continue;
        const group = (tm.get(tier) as number[]).slice().sort((a, b) => a - b);
        if (group.length <= cap) continue;
        // Keep the first `cap` in this wave; defer the rest. `bump` also moves
        // any dependent that would otherwise overtake a deferred node.
        for (const idx of group.slice(cap)) bump(idx, w + 1);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  const movedByTier = new Map<string, number[]>();
  for (const nd of launched) {
    const from = initial.get(nd.index) || 1;
    const to = waveOf.get(nd.index) || 1;
    if (to <= from) continue;
    const t = tierOf.get(nd.index) || "active";
    const arr = movedByTier.get(t);
    if (arr) arr.push(nd.index);
    else movedByTier.set(t, [nd.index]);
  }

  const notes: string[] = [];
  let deferred = 0;
  for (const tier of [...movedByTier.keys()].sort()) {
    const idxs = (movedByTier.get(tier) as number[]).slice().sort((a, b) => a - b);
    deferred += idxs.length;
    notes.push(`tier \`${tier}\` cap ${capOf(tier)}/wave: deferred ${idxs.length} node(s) to a later wave — ${idxs.map(i => `#${i}`).join(", ")}`);
  }
  return { deferred, notes };
}

// ── Planner ─────────────────────────────────────────────────

export function planBatch(tasks: PlanTaskInput[], options?: PlanOptions): PlanDecision {
  const opts = options && typeof options === "object" ? options : ({} as PlanOptions);
  const goalRaw = typeof opts.goal === "string" ? opts.goal.trim() : "";
  const goal = goalRaw ? goalRaw : undefined;
  const threshold = typeof opts.duplicateThreshold === "number" && Number.isFinite(opts.duplicateThreshold)
    ? opts.duplicateThreshold
    : DEFAULT_DUPLICATE_THRESHOLD;
  const maxTasks = typeof opts.maxTasks === "number" && Number.isFinite(opts.maxTasks)
    ? opts.maxTasks
    : DEFAULT_MAX_TASKS;

  const rawList: unknown[] = Array.isArray(tasks) ? (tasks as unknown[]) : [];

  // Hard ceiling that does NOT depend on the caller's maxTasks: the cycle and
  // same-file reachability checks are recursive, so an enormous batch must be
  // refused up front rather than traversed (a deep `needs` chain used to blow the
  // stack when a caller raised maxTasks).
  const HARD_MAX_TASKS = 500;
  const taskCeiling = Math.min(maxTasks, HARD_MAX_TASKS);

  // Bail out BEFORE any graph work (dedup clustering and the cycle/serialisation
  // DFS are super-linear): a huge batch must be refused, not analysed.
  if (rawList.length > taskCeiling) {
    const refusedNodes: PlanNode[] = rawList.map((raw, i) => ({
      index: i + 1,
      task: typeof (raw as any)?.task === "string" ? String((raw as any).task) : "",
      needs: [],
      wave: 0,
      lane: "open",
      laneReason: "not analysed (batch too large)",
      warnings: [],
      codeNode: false,
    }));
    const blocker = `${rawList.length} tasks proposed — exceeds maxTasks=${maxTasks} (hard ceiling ${taskCeiling}); split the batch or raise the limit`;
    return {
      accept: false,
      repaired: false,
      nodes: refusedNodes,
      launch: [],
      waves: [],
      warnings: [],
      blockers: [blocker],
      summary: [
        "## 🧭 Trimegisto plan gate",
        "",
        `\`${rawList.length} proposed · 0 to launch · 0 merged duplicates · 0 serialised · 0 closed\``,
        "",
        "### Blockers",
        `- ${blocker}`,
        "",
        `**Plan verdict:** REFUSED — 0 of ${rawList.length} tasks, 0 wave(s).`,
      ].join("\n"),
      counts: { proposed: rawList.length, launch: 0, duplicates: 0, serialized: 0, closed: 0 },
    };
  }

  const entries: Entry[] = [];
  for (const raw of rawList) {
    const e = entryOf(raw);
    if (e) entries.push(e);
  }

  const globalWarnings: string[] = [];
  const blockers: string[] = [];
  let repaired = false;

  const n = entries.length;
  const nodes: InternalNode[] = [];

  // 1) Build nodes: task text, writes, lane, needs validation, per-node warnings.
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const index = i + 1;
    const warnings: string[] = [];

    let lane: PlanLane;
    let laneReason: string;
    if (e.lane === "open" || e.lane === "gated" || e.lane === "closed") {
      lane = e.lane;
      laneReason = `explicit lane override: "${lane}"`;
    } else {
      const c = classifyLane(e.task);
      lane = c.lane;
      laneReason = c.reason;
    }

    const needs: number[] = [];
    if (Array.isArray(e.needs)) {
      for (const rawDep of e.needs as unknown[]) {
        let dep = NaN;
        if (typeof rawDep === "number") dep = rawDep;
        else if (typeof rawDep === "string" && rawDep.trim() !== "" && Number.isFinite(Number(rawDep))) dep = Number(rawDep);
        if (!Number.isInteger(dep)) {
          warnings.push(`#${index} dependency ${JSON.stringify(rawDep) ?? "undefined"} is not a task index — dropped`);
          repaired = true;
          continue;
        }
        if (dep < 1 || dep > n) {
          warnings.push(`#${index} depends on #${dep}, which is outside this batch — dropped`);
          repaired = true;
          continue;
        }
        if (dep === index) {
          warnings.push(`#${index} depends on itself — dropped`);
          repaired = true;
          continue;
        }
        if (needs.includes(dep)) {
          warnings.push(`#${index} lists #${dep} twice — dropped`);
          repaired = true;
          continue;
        }
        needs.push(dep);
      }
    }

    const codeNode = looksLikeCodeNode(e.task);
    if (looksLikePipelineStep(e.task) && needs.length === 0) {
      warnings.push(`#${index} reads like a step that consumes another task's output but declares no needs — declare the dependency or split it`);
    }
    if (codeNode) {
      warnings.push(`#${index} looks like a pure transformation — do it with a bash/code node, not a model`);
    }

    nodes.push({
      index,
      task: e.task,
      why: typeof e.why === "string" ? e.why : undefined,
      writes: coerceWrites(e.writes),
      needs,
      tier: normalizeTierKey(e.tier),
      lane,
      laneReason,
      warnings,
      codeNode,
      wave: 0,
    });
  }

  // 2) Break cycles deterministically: drop the edge with the HIGHEST source index.
  const needsOf = new Map<number, number[]>();
  for (const nd of nodes) needsOf.set(nd.index, nd.needs);
  let guard = 0;
  while (guard++ <= nodes.length + 1) {
    const feeds = rebuildFeeds(nodes.map(nd => nd.index), needsOf);
    const cycle = findCycle(nodes.map(nd => nd.index), feeds);
    if (!cycle) break;
    let best = 0;
    for (let k = 1; k < cycle.length; k++) if (cycle[k] > cycle[best]) best = k;
    const source = cycle[best];
    const target = cycle[(best + 1) % cycle.length];
    const targetNeeds = needsOf.get(target) || [];
    const at = targetNeeds.indexOf(source);
    if (at >= 0) targetNeeds.splice(at, 1);
    const printed = cycle.map(c => `#${c}`).join(" → ") + ` → #${cycle[0]}`;
    const owner = nodes.find(nd => nd.index === target);
    if (owner) owner.warnings.push(`cycle detected (${printed}) — dropped edge #${source} → #${target} to break it`);
    repaired = true;
  }

  // 3) Duplicate clustering: keep the LOWEST index, merge the rest.
  // Two signals, because each fails where the other works: n-gram shingles
  // collapse to ONE hash on a short task description (so two reworded short
  // tasks score 0), while the stopword-stripped word set is order-insensitive
  // and catches exactly that case ("count rows in logs.csv" vs "count the rows
  // of logs.csv") — which is the dedup the launch path already uses.
  const shingles = nodes.map(nd => shingleHashes(nd.task));
  const wordSets = nodes.map(nd => wordSet(nd.task));
  const similarity = (a: number, b: number): number => Math.max(
    jaccardSimilarity(shingles[a], shingles[b]),
    wordSetSimilarity(wordSets[a], wordSets[b]),
  );

  // UNION-FIND over ALL similar pairs, not a greedy "similar to an already-kept
  // representative" pass. The greedy version leaked a real cluster: A~B >= t and
  // B~C >= t but A~C < t left A and C in different groups, so the same work ran
  // twice — the exact cost the feature exists to prevent. Union-find closes that
  // transitively (A, B and C become ONE component). Pairs are visited in
  // ascending order and the representative is always the LOWEST index of the
  // component, so the output stays deterministic.
  const parent: number[] = nodes.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) { const next = parent[x]; parent[x] = root; x = next; }
    return root;
  };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (similarity(i, j) >= threshold) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[rj] = ri;
      }
    }
  }

  // Lowest index per component is the representative (deterministic anchor).
  const componentRep = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const root = find(i);
    const cur = componentRep.get(root);
    if (cur === undefined || i < cur) componentRep.set(root, i);
  }

  let duplicates = 0;
  for (let i = 0; i < nodes.length; i++) {
    const rep = componentRep.get(find(i)) as number;
    if (rep === i) continue;
    const dupOf = nodes[rep].index;
    const dupSim = similarity(rep, i);
    const note = `#${nodes[i].index} duplicates #${dupOf} (${Math.round(dupSim * 100)}% similar) — merged`;
    nodes[i].duplicateOf = dupOf;
    nodes[i].duplicateNote = note;
    nodes[i].warnings.push(note);
    duplicates++;
    repaired = true;
  }

  // 4) Launch set + goal-affinity warnings (non-duplicates only).
  const launchSet = new Set<number>();
  for (const nd of nodes) if (nd.duplicateOf === undefined) launchSet.add(nd.index);

  /** Follow duplicateOf chains to the node that will actually be launched. */
  const representativeOf = (index: number): number => {
    let cur = index;
    const seen = new Set<number>();
    while (!seen.has(cur)) {
      seen.add(cur);
      const next = nodes.find(n => n.index === cur)?.duplicateOf;
      if (next === undefined) break;
      cur = next;
    }
    return cur;
  };
  const launchedInternals = nodes.filter(nd => nd.duplicateOf === undefined);

  if (!goal) {
    globalWarnings.push("no goal declared — relevance to the overall task cannot be checked");
  } else {
    for (const nd of launchedInternals) {
      const aff = goalAffinity(goal, nd.task, nd.why);
      if (aff < GOAL_AFFINITY_FLOOR) {
        nd.warnings.push(`#${nd.index} has no lexical link to the stated goal — confirm it serves a real need`);
      }
    }
  }

  // 5) Same-file writers: serialise colliding launched writers (never creating a cycle).
  const launchNeeds = new Map<number, number[]>();
  const launchFeeds = new Map<number, number[]>();
  for (const nd of launchedInternals) { launchNeeds.set(nd.index, []); launchFeeds.set(nd.index, []); }
  for (const nd of launchedInternals) {
    const deps: number[] = [];
    for (const d of nd.needs) {
      // A dependency merged as an in-batch duplicate must be remapped to its
      // representative instead of dropped: dropping it would release the
      // dependent in the same wave as the node it consumes and silently lose the
      // declared edge (and the runtime lookup of the upstream verdict).
      const target = representativeOf(d);
      if (target !== d) {
        nd.warnings.push(`dependency #${d} was merged as a duplicate — the edge now points at #${target} instead of being dropped`);
      }
      if (launchSet.has(target) && !deps.includes(target)) deps.push(target);
    }
    launchNeeds.set(nd.index, deps);
    // Publish the EFFECTIVE dependencies: the scheduler resolves upstream agents
    // through this list.
    nd.needs = deps;
    for (const d of deps) (launchFeeds.get(d) as number[]).push(nd.index);
  }

  const edgeNotes: string[] = [];
  for (const nd of launchedInternals) {
    const deps = (launchNeeds.get(nd.index) || []).slice().sort((a, b) => a - b);
    for (const d of deps) edgeNotes.push(`#${d} → #${nd.index} (declared dependency)`);
  }

  let serialized = 0;
  for (let a = 0; a < launchedInternals.length; a++) {
    for (let b = a + 1; b < launchedInternals.length; b++) {
      const from = launchedInternals[a];
      const to = launchedInternals[b];
      if (from.writes.length === 0 || to.writes.length === 0) continue;
      // Compare NORMALISED paths on both sides; the warning keeps the caller's
      // own spelling. Empty/whitespace entries normalise to "" and are skipped
      // so they never collide with each other.
      const toNormalised = new Set<string>();
      for (const w of to.writes) {
        const key = normalizeWritePath(w);
        if (key) toNormalised.add(key);
      }
      let file: string | null = null;
      for (const w of from.writes) {
        const key = normalizeWritePath(w);
        if (key && toNormalised.has(key)) { file = w; break; }
      }
      if (!file) continue;
      if ((launchNeeds.get(to.index) || []).includes(from.index)) continue; // edge already exists
      if (reachable(launchFeeds, to.index, from.index)) {
        to.warnings.push(`#${from.index} and #${to.index} both write \`${file}\` but serialising them would create a cycle — edge not added`);
        continue;
      }
      (launchNeeds.get(to.index) as number[]).push(from.index);
      (launchFeeds.get(from.index) as number[]).push(to.index);
      serialized++;
      repaired = true;
      edgeNotes.push(`#${from.index} → #${to.index} (both write \`${file}\`)`);
      to.warnings.push(`#${from.index} and #${to.index} both write \`${file}\` — serialised #${from.index} → #${to.index}`);
    }
  }

  // 6) Waves: 1 + max(wave of its deps), computed after all edges exist.
  const indeg = new Map<number, number>();
  for (const nd of launchedInternals) indeg.set(nd.index, (launchNeeds.get(nd.index) || []).length);
  const queue: number[] = launchedInternals
    .map(nd => nd.index)
    .filter(i => (indeg.get(i) || 0) === 0)
    .sort((a, b) => a - b);
  const waveOf = new Map<number, number>();
  for (const i of queue) waveOf.set(i, 1);
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    const cur = waveOf.get(u) || 1;
    const succs = (launchFeeds.get(u) || []).slice().sort((a, b) => a - b);
    for (const v of succs) {
      if ((waveOf.get(v) || 0) < cur + 1) waveOf.set(v, cur + 1);
      const left = (indeg.get(v) || 0) - 1;
      indeg.set(v, left);
      if (left === 0) queue.push(v);
    }
  }
  for (const nd of launchedInternals) if (!waveOf.has(nd.index)) waveOf.set(nd.index, 1);

  // 6b) Capacity: keep every wave within its tier's concurrency cap. Planning a
  // wave the launcher can never start is what made the whole batch get refused.
  // Deferring is free — it only moves wave numbers; `needs` (the real data
  // edges) is left untouched, so no false upstream dependency is injected.
  const capacityResult = enforceTierCapacity(launchedInternals, launchFeeds, waveOf, opts.tierCapacity);

  const waveMap = new Map<number, number[]>();
  for (const nd of launchedInternals) {
    nd.wave = waveOf.get(nd.index) || 1;
    if (!waveMap.has(nd.wave)) waveMap.set(nd.wave, []);
    (waveMap.get(nd.wave) as number[]).push(nd.index);
  }
  for (const arr of waveMap.values()) arr.sort((a, b) => a - b);
  const waves: number[][] = [...waveMap.keys()].sort((a, b) => a - b).map(w => waveMap.get(w) as number[]);

  for (const nd of nodes) {
    if (nd.duplicateOf !== undefined) nd.wave = waveOf.get(nd.duplicateOf) || 1;
  }

  // 7) Blockers: > maxTasks, or a closed-lane node.
  if (nodes.length > maxTasks) {
    blockers.push(`${nodes.length} tasks proposed — exceeds maxTasks=${maxTasks}; split the batch or raise the limit`);
  }
  for (const nd of nodes) {
    if (nd.lane === "closed") {
      blockers.push(`#${nd.index} is in the closed lane (${nd.laneReason}) — irreversible work needs explicit approval`);
    }
  }

  const accept = blockers.length === 0;

  // 8) Materialise the public nodes.
  const planNodes: PlanNode[] = nodes.map(nd => {
    const pn: PlanNode = {
      index: nd.index,
      task: nd.task,
      needs: nd.needs.slice(),
      tier: nd.tier,
      wave: nd.wave,
      lane: nd.lane,
      laneReason: nd.laneReason,
      warnings: nd.warnings.slice(),
      codeNode: nd.codeNode,
    };
    if (nd.duplicateOf !== undefined) pn.duplicateOf = nd.duplicateOf;
    return pn;
  });
  const launch = planNodes.filter(pn => pn.duplicateOf === undefined);

  const warnings = globalWarnings.concat(nodes.flatMap(nd => nd.warnings));
  const dupNotes = nodes.filter(nd => nd.duplicateNote).map(nd => nd.duplicateNote as string);
  const codeNotes = launch.filter(pn => pn.codeNode);

  const counts = {
    proposed: nodes.length,
    launch: launch.length,
    duplicates,
    serialized,
    closed: nodes.filter(nd => nd.lane === "closed").length,
    capacityDeferred: capacityResult.deferred,
  };

  const taskByIndex = new Map<number, string>();
  for (const nd of nodes) taskByIndex.set(nd.index, nd.task);

  const lines: string[] = [];
  lines.push("## 🧭 Trimegisto plan gate");
  lines.push("");
  if (goal) {
    lines.push(`**Goal:** ${collapse(goal)}`);
    lines.push("");
  }
  lines.push(`\`${counts.proposed} proposed · ${counts.launch} to launch · ${counts.duplicates} merged duplicates · ${counts.serialized} serialised · ${counts.closed} closed\``);
  lines.push("");

  lines.push("### Waves");
  if (waves.length === 0) {
    lines.push("None.");
  } else {
    waves.forEach((wave, i) => {
      const k = i + 1;
      const head = `**Wave ${k}**${wave.length > 1 ? " (parallel)" : ""}: ` +
        wave.map(idx => `#${idx} ${collapse(taskByIndex.get(idx) || "")}`).join(", ");
      lines.push(head);
      if (wave.length > 1) lines.push(`→ ${formatIndices(wave)} run in parallel.`);
    });
  }
  lines.push("");

  lines.push("### Serialised (explicit edges)");
  if (edgeNotes.length === 0) lines.push("None.");
  else for (const e of edgeNotes) lines.push(`- ${e}`);
  lines.push("");

  // Only emitted when a tier cap actually reshaped the plan, so plans that fit
  // their configuration keep byte-identical summaries.
  if (capacityResult.notes.length > 0) {
    lines.push("### Capacity splits");
    for (const note of capacityResult.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push("### Duplicates merged");
  if (dupNotes.length === 0) lines.push("None.");
  else for (const d of dupNotes) lines.push(`- ${d}`);
  lines.push("");

  lines.push("### Code nodes (no model needed)");
  if (codeNotes.length === 0) lines.push("None.");
  else for (const pn of codeNotes) lines.push(`- #${pn.index} ${collapse(pn.task)}`);
  lines.push("");

  lines.push("### Warnings");
  if (warnings.length === 0) lines.push("None.");
  else for (const w of warnings) lines.push(`- ${w}`);
  lines.push("");

  lines.push("### Blockers");
  if (blockers.length === 0) lines.push("✅ No blockers.");
  else for (const b of blockers) lines.push(`- ${b}`);
  lines.push("");

  lines.push(`**Plan verdict:** ${accept ? "LAUNCH" : "REFUSED"} — ${counts.launch} of ${counts.proposed} tasks, ${waves.length} wave(s).`);

  return {
    accept,
    repaired,
    nodes: planNodes,
    launch,
    waves,
    warnings,
    blockers,
    summary: lines.join("\n"),
    counts,
  };
}

// ── Wave scheduler decision (pure, testable) ────────────────
//
// The scheduler that runs a plan lives in the extension (it spawns processes),
// but its one non-obvious decision — what to do after a wave — is pure and
// lives here so it can be proven by execution instead of by reading.

/** Everything the scheduler needs to decide the next move. */
export interface WaveState {
  /** Total number of waves in the plan. */
  waveCount: number;
  /** Wave currently in flight; -1 before the first one is launched. */
  currentWave: number;
  /** Every agent of the current wave reached a terminal state. */
  currentWaveTerminal: boolean;
  /** A human or the guard stopped the current wave (kill/halt). */
  stopped: boolean;
  /** Trimegisto is still enabled. */
  enabled: boolean;
  /** The batch deadline has passed. */
  deadlineReached: boolean;
}

export type WaveAction = "launch-next" | "wait" | "settle";

/**
 * Decide the next scheduler action. Pure and total.
 *
 * Order matters: a stop wins over launching (never start dependents of work a
 * human killed), then a running wave is waited on, then a missed deadline or a
 * mid-batch disable settles the batch, and only then is the next wave launched.
 *
 * CONTRACT for the caller: report `stopped` only once the current wave is
 * TERMINAL. Killing one agent must not discard the results of its siblings that
 * are still running — the wave is awaited to completion and only the NEXT one is
 * refused. A caller that passes `stopped` mid-wave is asking to abort early.
 */
export function nextWaveAction(state: WaveState): { action: WaveAction; reason: string } {
  const waveCount = Number.isFinite(state?.waveCount) ? Math.max(0, Math.floor(state.waveCount)) : 0;
  const raw = Number.isFinite(state?.currentWave) ? Math.floor(state.currentWave) : -1;
  // Anything below "before the first wave" behaves like it; never report a
  // negative wave number.
  const currentWave = Math.max(-1, raw);

  if (state?.stopped) return { action: "settle", reason: "stopped (killed/halted) between waves" };

  if (currentWave >= 0 && !state?.currentWaveTerminal) {
    if (state?.deadlineReached) return { action: "settle", reason: "batch deadline reached while a wave was running" };
    return { action: "wait", reason: "the current wave is still running" };
  }

  if (currentWave + 1 >= waveCount) return { action: "settle", reason: "all waves complete" };
  if (!state?.enabled) return { action: "settle", reason: "trimegisto disabled between waves" };
  if (state?.deadlineReached) return { action: "settle", reason: "batch deadline reached" };

  return { action: "launch-next", reason: `launching wave ${currentWave + 2} of ${waveCount}` };
}
