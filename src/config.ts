/**
 * Trimegisto - Configuration
 *
 * Manages tier configurations with persistence via pi.appendEntry().
 * Agents are defined as markdown files in ~/.pi/agent/agents/ and .pi/agents/.
 * Falls back to built-in defaults when no agent files are found.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TrimegistoConfig, TierConfig, AgentTier, LoopSupervisorConfig, ReaperConfig } from "./types.ts";
import { MODEL_HEALTH_DEFAULTS } from "./model-health.ts";
import { REAPER_DEFAULTS } from "./types.ts";

const CONFIG_ENTRY_TYPE = "trimegisto-config";

/** Default system prompts for each tier */
const DEFAULT_PROMPTS: Record<string, string> = {
  active: `You are Trimegisto T0 (ACTIVE): default coordinator/worker using the main pi model.

Operational rule:
- 2+ independent subtasks/files/areas/checks => your FIRST action is a trimegisto_spawn batch; never do decomposable work serially first, then integrate and synthesize the workers' results.
- Subtasks must be DISJOINT: never two agents on the same file or question. "Scouts" (same task, different angle) only for verification/consensus.
- Skip spawning only for trivial/indivisible work. Prefer active/t0 for mass parallel work across DIFFERENT files/areas.
- Publish key findings with trimegisto_note so other agents can reuse them instead of re-deriving.
- Track files you read with file_read_track so other agents are alerted when they change and can reuse your exploration.
- Escalate only hard planning/architecture to T1; use T2/T3 only if configured.

IDs: t0a/t0b active, t1a planner, t2a solver, t3a worker.`,
  t1: `You are Trimegisto T1: expensive deep-planning tier.

Use for architecture, strategy, hard analysis, trade-offs, risk, synthesis.
Delegate routine execution to t0/t2/t3 with trimegisto_spawn.
Decomposable => batch-spawn first; never do routine/mechanical work yourself.

IDs: t1a/t1b; workers: t0a/t2a/t3a.`,
  t2: `You are Trimegisto T2: economical solver.

Handle medium-complexity debugging, review, data transforms, and multi-step tasks.
Be direct. Decomposable => batch-spawn subtasks first; delegate trivial mechanical work to T3, escalate genuinely hard work to T1.`,
  t3: `You are Trimegisto T3: fast mechanical worker with limited reasoning.

Handle translation, parsing, formatting, counting, sorting, filtering, simple file ops/commands.
Be fast, precise, concise. Decomposable => batch-spawn subtasks first. No deep reasoning; escalate that to T2/T1.`,
};

/** Agent definition from markdown file */
interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  maxParallel?: number;
  compactionThreshold?: number;
}

function parseAgentFile(filePath: string): AgentDef | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Simple YAML frontmatter parsing (no dependency needed)
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatterStr = match[1];
  const body = match[2].trim();

  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterStr.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }

  if (!frontmatter.name || !frontmatter.description) return null;

  const maxParallel = frontmatter.maxParallel ? parseInt(frontmatter.maxParallel, 10) : undefined;
  const compactionThreshold = frontmatter.compactionThreshold ? parseInt(frontmatter.compactionThreshold, 10) : undefined;

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: frontmatter.tools?.split(",").map(t => t.trim()).filter(Boolean),
    model: frontmatter.model,
    systemPrompt: body,
    maxParallel: !isNaN(maxParallel as number) ? maxParallel : undefined,
    compactionThreshold: !isNaN(compactionThreshold as number) ? compactionThreshold : undefined,
  };
}

function discoverAgentFiles(cwd: string): { userDir: string; projectDir: string | null } {
  const userDir = path.join(getAgentDir(), "agents");

  // Walk up from cwd to find .pi/agents
  let projectDir: string | null = null;
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) {
        projectDir = candidate;
        break;
      }
    } catch { /* not found */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { userDir, projectDir };
}

function loadAgentFromDir(dir: string, name: string): AgentDef | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const agent = parseAgentFile(path.join(dir, entry.name));
      if (agent && agent.name === name) return agent;
    }
  } catch { /* dir doesn't exist */ }
  return null;
}

/**
 * Build tier configuration from agent files or defaults.
 * Priority: project agent > user agent > built-in default
 */
export function buildTierConfig(
  tier: AgentTier,
  cwd: string,
  savedConfig?: Partial<TierConfig>,
): TierConfig {
  const { userDir, projectDir } = discoverAgentFiles(cwd);

  // Try to load from agent files
  let agentDef: AgentDef | null = null;
  if (projectDir) agentDef = loadAgentFromDir(projectDir, `trimegisto-${tier}`);
  if (!agentDef) agentDef = loadAgentFromDir(userDir, `trimegisto-${tier}`);

  const defaults = getTierDefaults(tier);

  const systemPrompt = savedConfig?.systemPrompt
    || agentDef?.systemPrompt
    || defaults.systemPrompt;

  // A model override in saved config takes precedence
  const model = savedConfig?.model || agentDef?.model || defaults.model;

  const tools = savedConfig?.tools || agentDef?.tools || defaults.tools;

  // Internal Trimegisto tools are always available: they power auto-spawn,
  // shared context (file_read_track / trimegisto_note) and file locking.
  // Union them in so existing saved configs and agent files that predate a
  // tool still get it, without clobbering user-configured extras.
  const ESSENTIAL_TOOLS = ["trimegisto_spawn", "file_read_track", "trimegisto_note", "file_lock", "file_unlock"];
  const resolvedTools = [...new Set([...(Array.isArray(tools) ? tools : []), ...ESSENTIAL_TOOLS])];

  const extraArgs = savedConfig?.extraArgs || defaults.extraArgs;

  // maxParallel and compactionThreshold: saved config > agent file > defaults
  // Agent files can set these via frontmatter: maxParallel and compactionThreshold
  const maxParallel = savedConfig?.maxParallel
    ?? agentDef?.maxParallel
    ?? defaults.maxParallel;
  const compactionThreshold = savedConfig?.compactionThreshold
    ?? agentDef?.compactionThreshold
    ?? defaults.compactionThreshold;
  // enabled: saved config > agent file > defaults
  const enabled = savedConfig?.enabled ?? defaults.enabled;

  // redundantModels: saved config > defaults (never from agent files)
  const redundantModels = savedConfig?.redundantModels ?? defaults.redundantModels ?? [];

  return {
    enabled,
    model,
    systemPrompt,
    maxParallel: typeof maxParallel === "number" ? maxParallel : defaults.maxParallel,
    compactionThreshold: typeof compactionThreshold === "number" ? compactionThreshold : defaults.compactionThreshold,
    tools: resolvedTools,
    extraArgs,
    redundantModels,
  };
}

function getTierDefaults(tier: AgentTier): TierConfig {
  switch (tier) {
    case "active":
      return {
        enabled: true,
        model: "", // uses the pi ACTIVE model (useActiveModel)
        systemPrompt: DEFAULT_PROMPTS.active,
        maxParallel: 4,
        compactionThreshold: 0,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn", "file_read_track", "trimegisto_note"],
        extraArgs: [],
        redundantModels: [],
      };
    case "t1":
      return {
        enabled: true,
        model: "", // User must configure
        systemPrompt: DEFAULT_PROMPTS.t1,
        maxParallel: 1,
        compactionThreshold: 0,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn", "file_read_track", "trimegisto_note"],
        extraArgs: [],
        redundantModels: [],
      };
    case "t2":
      return {
        enabled: true,
        model: "",
        systemPrompt: DEFAULT_PROMPTS.t2,
        maxParallel: 4,
        compactionThreshold: 0,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn", "file_read_track", "trimegisto_note"],
        extraArgs: [],
        redundantModels: [],
      };
    case "t3":
      return {
        enabled: true,
        model: "",
        systemPrompt: DEFAULT_PROMPTS.t3,
        maxParallel: 4,
        compactionThreshold: 0,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn", "file_read_track", "trimegisto_note"],
        extraArgs: [],
        redundantModels: [],
      };
  }
}

export function getDefaultConfig(): TrimegistoConfig {
  return {
    active: getTierDefaults("active"),
    t1: getTierDefaults("t1"),
    t2: getTierDefaults("t2"),
    t3: getTierDefaults("t3"),
    enabled: true,
    autoSpawn: true,
    useActiveModel: true,
    spawnOnlyOnActive: false,
    redundantAgents: false,
    dedupeTasks: true,
    dedupeCrossAgent: false,
    dashboardMode: "compact",
    dashboardVisible: true,
    watchdog: {
      firstResponseSeconds: envWatchdogSeconds("TRIMEGISTO_FIRST_RESPONSE_TIMEOUT_MS", WATCHDOG_DEFAULTS.firstResponseSeconds),
      idleSeconds: envWatchdogSeconds("TRIMEGISTO_AGENT_IDLE_TIMEOUT_MS", WATCHDOG_DEFAULTS.idleSeconds),
      maxRuntimeSeconds: envWatchdogSeconds("TRIMEGISTO_AGENT_MAX_RUNTIME_MS", WATCHDOG_DEFAULTS.maxRuntimeSeconds),
    },
    loopSupervisor: {
      enabled: true,
      maxSpawnDepth: 5,
      turnLimitEnabled: false,
      maxAgentTurns: 50,
      turnLimitGrace: 15,
      dedupeCrossAgent: false,
    },
    modelHealth: { ...MODEL_HEALTH_DEFAULTS },
    reaper: {
      enabled: REAPER_DEFAULTS.enabled,
      terminalIdleSeconds: envWatchdogSeconds("TRIMEGISTO_REAPER_TERMINAL_IDLE_MS", REAPER_DEFAULTS.terminalIdleSeconds),
    },
  };
}

/**
 * Coerce a reaper block (possibly from a corrupt/legacy config file) into a
 * safe `ReaperConfig`. Missing keys fall back to the defaults; bad values are
 * clamped so a hostile file can never disable `setTimeout` overflow or flip
 * the feature flag on accident.
 */
export function sanitizeReaperConfig(partial: unknown, base: ReaperConfig): ReaperConfig {
  const out: ReaperConfig = {
    enabled: base.enabled,
    terminalIdleSeconds: base.terminalIdleSeconds,
  };
  if (partial && typeof partial === "object" && !Array.isArray(partial)) {
    const p = partial as Record<string, unknown>;
    if (typeof p.enabled === "boolean") out.enabled = p.enabled;
    if (typeof p.terminalIdleSeconds === "number" && Number.isFinite(p.terminalIdleSeconds) && p.terminalIdleSeconds >= 0) {
      out.terminalIdleSeconds = Math.min(Math.floor(p.terminalIdleSeconds), MAX_WATCHDOG_SECONDS);
    }
  }
  return out;
}

export const DEFAULT_PROMPTS_MAP = DEFAULT_PROMPTS;

/**
 * Node's setTimeout limit is 2^31-1 ms; any larger delay overflows and fires
 * after ~1 ms. Clamp watchdog seconds below that so an oversized value can
 * never kill an agent instantly.
 */
export const MAX_WATCHDOG_SECONDS = Math.floor(2_147_483_647 / 1000); // ~24.8 days

/** Default watchdog timeouts in seconds (0 = disabled). */
/**
 * Push the persisted guard config onto the live supervisor.
 *
 * EVERY save/sync path must go through this. `LoopSupervisor.updateConfig`
 * MERGES, so a path that forgets to push leaves the instance on a stale value
 * while the file (and therefore the UI) says otherwise — the reported "turn
 * limit OFF but agents still warned and killed at the hard limit" divergence.
 * Single choke point on purpose: it is the one place that can be tested without
 * importing the extension, and the one place a future save path has to call.
 *
 * Returns true when a config was applied.
 */
/**
 * Fold the TOP-LEVEL `dedupeCrossAgent` flag into the guard config before pushing it.
 *
 * There are two copies of that setting (a top-level shortcut and the guard's own
 * field) and a legacy config file written before they existed kept only the
 * top-level one. Pushing the guard block without this fold silently reverted
 * cross-agent dedup to the stale in-block value whenever any unrelated setting was
 * saved — the same file/instance divergence class as the turn-limit bug.
 *
 * Mutates `config.loopSupervisor` in place on purpose: the config UI holds a
 * reference to it across submenu edits.
 */
export function foldDedupeFlagIntoGuard(config: { loopSupervisor?: any; dedupeCrossAgent?: boolean }): any | undefined {
  if (!config || !config.loopSupervisor || typeof config.loopSupervisor !== "object") return undefined;
  config.loopSupervisor.dedupeCrossAgent = config.dedupeCrossAgent === true;
  return config.loopSupervisor;
}

export function applyGuardConfig(
  supervisor: { updateConfig(partial: any): void; getConfig?(): any } | null | undefined,
  guardConfig: unknown,
): boolean {
  if (!supervisor || typeof supervisor.updateConfig !== "function") return false;
  // try/catch around EVERY property access: even the shape checks touch the
  // argument, and a hostile object (Proxy throwing on get/ownKeys) must never
  // propagate into the save/UI path that calls this. On any failure nothing is
  // pushed and we report false.
  try {
    if (!guardConfig || typeof guardConfig !== "object" || Array.isArray(guardConfig)) return false;
    // An empty object would apply nothing while reporting success, which is the
    // kind of silent no-op a caller would trust.
    if (Object.keys(guardConfig as Record<string, unknown>).length === 0) return false;
    // Coerce BEFORE it reaches the live guard. This is the only place config can
    // enter the supervisor, so it must not forward junk keys, a string limit
    // (which turns `softLimit + grace` into string concatenation and silently
    // moves the hard kill), or a truthy non-boolean `turnLimitEnabled`. Missing
    // keys fall back to the guard's CURRENT values, so a partial push cannot be
    // poisoned.
    const base = (typeof supervisor.getConfig === "function" ? supervisor.getConfig() : null)
      ?? getDefaultConfig().loopSupervisor;
    const clean = sanitizeLoopSupervisorConfig(guardConfig as Record<string, unknown>, base);
    supervisor.updateConfig(clean);
    return true;
  } catch {
    return false;
  }
}

export const WATCHDOG_DEFAULTS = {
  firstResponseSeconds: 90,
  idleSeconds: 120,
  maxRuntimeSeconds: 0,
} as const;

/** Current on-disk config schema version. Bumped when a migration is needed. */
export const SCHEMA_VERSION = 3;

/**
 * Built-in compaction thresholds shipped before schema v3. Trimegisto used to
 * force proactive compaction at these percentages; from v3 on, 0 means "off"
 * (let pi decide with its native setting).
 */
export const OLD_DEFAULT_COMPACTION: Record<AgentTier, number> = {
  active: 85,
  t1: 65,
  t2: 75,
  t3: 85,
};

/**
 * Migrate pre-v3 saved compaction thresholds.
 *
 * Any saved value that still equals one of the old built-in defaults is reset
 * to 0 (off) so we stop forcing early compaction; values the user deliberately
 * set to something else are preserved. Returns only the tiers that change.
 */
export function migrateSavedCompaction(
  saved: Partial<Record<AgentTier, { compactionThreshold?: number }>> | undefined,
  savedSchemaVersion: number | undefined,
): Partial<Record<AgentTier, number>> {
  const out: Partial<Record<AgentTier, number>> = {};
  if ((savedSchemaVersion ?? 0) >= SCHEMA_VERSION) return out;
  for (const tier of ["active", "t1", "t2", "t3"] as const) {
    const value = saved?.[tier]?.compactionThreshold;
    if (typeof value === "number" && value === OLD_DEFAULT_COMPACTION[tier]) {
      out[tier] = 0;
    }
  }
  return out;
}

/**
 * Lowest ACTIVE proactive-compaction threshold across all tiers.
 * The monitor compacts the MAIN session (running the active model), so the
 * active tier's threshold counts too — otherwise setting it in /tmg config
 * would be a silent no-op. Values <= 0 are disabled and ignored; returns 0
 * when every threshold is off (meaning: let pi decide with its native setting).
 */
export function effectiveCompactionThreshold(
  tiers: Pick<Record<AgentTier, { compactionThreshold: number }>, "active" | "t1" | "t2" | "t3">,
): number {
  const thresholds = [
    tiers.active.compactionThreshold,
    tiers.t1.compactionThreshold,
    tiers.t2.compactionThreshold,
    tiers.t3.compactionThreshold,
  ].filter(t => t > 0);
  if (thresholds.length === 0) return 0;
  return Math.min(...thresholds);
}

/**
 * Sanitize a persisted loopSupervisor block.
 *
 * Loop detection moved to the `antiloop` extension, so legacy configs still
 * carry removed keys (maxRepeatedOutputs, tierCooldownMs, similarityThreshold,
 * minRepeatableOutputChars). Keep only the fields the guard still honors and
 * fall back to the given defaults for missing/wrongly-typed values.
 */
export function sanitizeLoopSupervisorConfig(
  saved: Partial<Record<string, unknown>> | undefined,
  defaults: Partial<LoopSupervisorConfig>,
): Partial<LoopSupervisorConfig> {
  const num = (v: unknown, fb: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  const bool = (v: unknown, fb: boolean | undefined) => (typeof v === "boolean" ? v : fb);
  // Clamp the turn-limit knobs so a corrupt/hand-edited value cannot make the
  // guard fire on every turn (0/negative) or overflow the comparison.
  const clampInt = (v: unknown, fb: number, min: number, max: number) => {
    const n = num(v, undefined);
    if (n === undefined) return fb;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  return {
    enabled: bool(saved?.enabled, defaults.enabled),
    maxSpawnDepth: num(saved?.maxSpawnDepth, defaults.maxSpawnDepth),
    turnLimitEnabled: bool(saved?.turnLimitEnabled, defaults.turnLimitEnabled ?? false),
    maxAgentTurns: clampInt(saved?.maxAgentTurns, defaults.maxAgentTurns ?? 50, 1, 100_000),
    turnLimitGrace: clampInt(saved?.turnLimitGrace, defaults.turnLimitGrace ?? 15, 0, 100_000),
    dedupeCrossAgent: bool(saved?.dedupeCrossAgent, defaults.dedupeCrossAgent),
  };
}

/**
 * Coerce a watchdog value (seconds) to a safe integer in [0, MAX_WATCHDOG_SECONDS].
 * Non-finite / negative / non-numeric values fall back to `fallback`; oversized
 * values are clamped so setTimeout never overflows (which would fire immediately).
 */
export function clampWatchdogSeconds(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    const f = Math.floor(fallback);
    return Number.isFinite(f) && f > 0 ? Math.min(f, MAX_WATCHDOG_SECONDS) : 0;
  }
  return Math.min(Math.floor(n), MAX_WATCHDOG_SECONDS);
}

/**
 * Read a legacy ms env override and convert it to whole seconds.
 * Keeps `TRIMEGISTO_*_MS` working now that watchdogs live in the config file:
 * precedence is saved config > env var > built-in default.
 */
function envWatchdogSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const ms = parseInt(raw, 10);
  if (!Number.isFinite(ms) || ms < 0) return fallback;
  if (ms === 0) return 0; // explicit disable
  // Sub-second values round up to 1s instead of silently disabling the watchdog
  // (config is in seconds; 500ms previously became 0 = off).
  return clampWatchdogSeconds(Math.max(1, Math.round(ms / 1000)), fallback);
}

export function formatTierLabel(tier: string): string {
  switch (tier) {
    case "active": return "Active";
    case "t1": return "T1";
    case "t2": return "T2";
    case "t3": return "T3";
    default: return tier;
  }
}

/**
 * Human-readable label for a model id, used by the dashboard agent list.
 *
 *   "deepseek/deepseek-v4-flash"   -> "Deepseek v4 Flash"
 *   "moonshot/kimi-k3"            -> "Kimi K3"
 *   "openrouter/anthropic/claude-opus-4" -> "Claude Opus 4"
 *   "(pi default)" / "" / undefined -> "pi default" / ""
 *
 * Takes the last path segment (so provider and local weight paths drop away),
 * strips common weight extensions and turns separators into spaces. Tokens are
 * title-cased, except `v<digits>` version prefixes which stay lower-case and
 * already-mixed/upper-case tokens which are preserved (`ROCmFP4`, `27B`).
 */
export function formatModelLabel(model?: string): string {
  if (!model) return "";
  let slug = model.trim();
  if (!slug) return "";
  if (slug === "(pi default)") return "pi default";

  const slash = slug.lastIndexOf("/");
  if (slash >= 0) slug = slug.slice(slash + 1);
  slug = slug.replace(/\.(gguf|ggml|safetensors|bin|pt|onnx)$/i, "");
  slug = slug.replace(/[-_:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!slug) return "";

  return slug.split(" ").map(humanizeModelToken).join(" ");
}

function humanizeModelToken(tok: string): string {
  if (!tok) return tok;
  // Version prefixes keep their conventional lower-case form (v4, v2.5).
  if (/^v\d/i.test(tok)) return tok.toLowerCase();
  // Preserve acronyms / mixed case coming from the id (ROCmFP4, 27B, GPT).
  if (/[A-Z]/.test(tok)) return tok;
  // Short generation markers: k3 -> K3, r1 -> R1, gpt4 -> GPT4.
  if (/^[a-z]{1,4}\d+$/.test(tok)) return tok.toUpperCase();
  // Numeric / date-like tokens stay untouched.
  if (/^\d/.test(tok)) return tok;
  const lower = tok.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Parse an agent ID like "t2b" into { tier: "t2", letter: "b" }
 */
export function parseAgentId(id: string): { tier: AgentTier; letter: string } | null {
  const match = id.match(/^(t[0123])([a-z])$/);
  if (!match) return null;
  return { tier: (match[1] === "t0" ? "active" : match[1]) as AgentTier, letter: match[2] };
}
