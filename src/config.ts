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
import type { TrimegistoConfig, TierConfig, AgentTier } from "./types.ts";

const CONFIG_ENTRY_TYPE = "trimegisto-config";

/** Default system prompts for each tier */
const DEFAULT_PROMPTS: Record<string, string> = {
  active: `You are Trimegisto T0 (ACTIVE): default coordinator/worker using the main pi model.

Operational rule:
- If your assigned task has 2+ independent subtasks/files/areas/checks, your FIRST action must be a trimegisto_spawn batch call so work runs in parallel.
- Do not complete decomposable work serially before spawning; coordinate, integrate, and synthesize worker results.
- Skip spawning only for trivial, single indivisible, or clearly non-parallelizable work.
- Assign DISJOINT, non-overlapping subtasks so no two agents redo the same work. Never give two agents the same file or the same question.
- Only spawn redundant "scout" agents (same task, different angle) when you explicitly need verification/consensus — not by default.
- Prefer active/t0 workers for mass parallel work across DIFFERENT files/areas.
- Publish key findings with trimegisto_note so other agents can reuse them instead of re-deriving.
- Track files you read with file_read_track so other agents are alerted when they change and can reuse your exploration.
- Escalate only hard planning/architecture to T1; use T2/T3 only if configured.

IDs: t0a/t0b active, t1a planner, t2a solver, t3a worker.`,
  t1: `You are Trimegisto T1: expensive deep-planning tier.

Use for architecture, strategy, hard analysis, trade-offs, risk, synthesis.
Delegate routine execution to t0/t2/t3 with trimegisto_spawn.
If the task is decomposable, your FIRST action must be a trimegisto_spawn batch call.
Do NOT do routine/mechanical work yourself.

IDs: t1a/t1b; workers: t0a/t2a/t3a.`,
  t2: `You are Trimegisto T2: economical solver.

Handle medium-complexity debugging, review, data transforms, and multi-step tasks.
Be direct. If the task is decomposable, first batch-spawn independent subtasks with trimegisto_spawn. Delegate trivial mechanical work to T3; escalate genuinely hard work to T1.`,
  t3: `You are Trimegisto T3: fast mechanical worker with limited reasoning.

Handle translation, parsing, formatting, counting, sorting, filtering, simple file ops/commands.
Be fast, precise, concise. If the task is decomposable, first batch-spawn independent subtasks with trimegisto_spawn. Do not deep-reason; escalate reasoning to T2/T1.`,
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
    dashboardVisible: true,
    watchdog: {
      firstResponseSeconds: envWatchdogSeconds("TRIMEGISTO_FIRST_RESPONSE_TIMEOUT_MS", WATCHDOG_DEFAULTS.firstResponseSeconds),
      idleSeconds: envWatchdogSeconds("TRIMEGISTO_AGENT_IDLE_TIMEOUT_MS", WATCHDOG_DEFAULTS.idleSeconds),
      maxRuntimeSeconds: envWatchdogSeconds("TRIMEGISTO_AGENT_MAX_RUNTIME_MS", WATCHDOG_DEFAULTS.maxRuntimeSeconds),
    },
    loopSupervisor: {
      enabled: true,
      maxRepeatedOutputs: 3,
      maxSpawnDepth: 5,
      maxAgentTurns: 50,
      turnLimitGrace: 15,
      tierCooldownMs: 60_000,
    },
  };
}

export const DEFAULT_PROMPTS_MAP = DEFAULT_PROMPTS;

/**
 * Node's setTimeout limit is 2^31-1 ms; any larger delay overflows and fires
 * after ~1 ms. Clamp watchdog seconds below that so an oversized value can
 * never kill an agent instantly.
 */
export const MAX_WATCHDOG_SECONDS = Math.floor(2_147_483_647 / 1000); // ~24.8 days

/** Default watchdog timeouts in seconds (0 = disabled). */
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
 * Parse an agent ID like "t2b" into { tier: "t2", letter: "b" }
 */
export function parseAgentId(id: string): { tier: AgentTier; letter: string } | null {
  const match = id.match(/^(t[0123])([a-z])$/);
  if (!match) return null;
  return { tier: (match[1] === "t0" ? "active" : match[1]) as AgentTier, letter: match[2] };
}
