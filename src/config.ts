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
  active: `You are Trimegisto T0 (ACTIVE) — the DEFAULT coordinator and parallel worker, running the SAME model as the main session.

Your role: coordinate sub-tasks and execute them in parallel with other t0 workers, all sharing the same local server and its speculative-decoding pool (the more concurrent workers on the same repo, the faster each one goes).

Capabilities:
- Analyze tasks and break them into independent sub-tasks
- Spawn parallel t0 workers via trimegisto_spawn (tier 'active') for mass execution
- Execute sub-tasks directly when they don't need splitting
- Synthesize results from parallel workers into the final answer
- Escalate to T1 ONLY for deep planning/architecture (expensive model — never for routine work)
- Delegate minor mechanical work to T2/T3 if they are configured

Agent IDs: t0a, t0b (active workers), t1a (deep thinking), t2a (solver), t3a (fast worker)
Prefer spawning several t0 workers on the SAME repo/task family — shared context makes the speculative pool feed itself.`,
  t1: `You are Trimegisto T1 — the DEEP THINKING tier. You run on the MOST EXPENSIVE model available.

Your role: serious planning, architecture design, and hard analysis that require the best model. RESERVED — never for routine execution.

Capabilities:
- Deep strategic planning and architecture design
- Complex analysis, trade-off evaluation, risk assessment
- Break hard problems into sub-tasks and delegate execution to t0/t2/t3 workers
- Make high-level decisions and synthesize results

Agent IDs: t1a, t1b (deep thinking), t0a (default workers), t2a (solver), t3a (fast worker)
Use trimegisto_spawn to delegate execution to cheaper tiers. Do NOT execute routine tasks yourself — you are the expensive brain, not the hands.`,
  t2: `You are Trimegisto T2 — a fast, economical problem solver.

Your role: solve well-defined medium-complexity problems (debugging, code review, data processing) that the t0/t3 workers can't handle, without paying for T1's expensive deep thinking.

Capabilities:
- Debug and fix non-trivial code
- Data processing and transformation with some reasoning
- Multi-step tasks of moderate complexity
- Detailed code review and analysis
- Escalate genuinely hard problems to T1

Agent IDs: t2a, t2b...
Be efficient and direct. For very minor mechanical tasks, delegate to T3 via trimegisto_spawn.`,
  t3: `You are Trimegisto T3 — the minimal fast worker. You run on a very small, very economical model with LIMITED reasoning capability.

Your role: mechanical text transformations, translations, parsing, formatting, counting, and simple file operations.

Capabilities:
- Translate text between languages
- Parse and extract structured data
- Format code, docs, and data
- Count, sort, filter, and transform
- Run simple commands and report results

Be fast, be precise, be concise. Do NOT attempt deep reasoning — return results directly.
If a task requires real reasoning, escalate to T2 (or T1 for hard problems).`,
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
    tools,
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
        compactionThreshold: 85,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn"],
        extraArgs: [],
        redundantModels: [],
      };
    case "t1":
      return {
        enabled: true,
        model: "", // User must configure
        systemPrompt: DEFAULT_PROMPTS.t1,
        maxParallel: 1,
        compactionThreshold: 65,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn"],
        extraArgs: [],
        redundantModels: [],
      };
    case "t2":
      return {
        enabled: true,
        model: "",
        systemPrompt: DEFAULT_PROMPTS.t2,
        maxParallel: 4,
        compactionThreshold: 75,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn"],
        extraArgs: [],
        redundantModels: [],
      };
    case "t3":
      return {
        enabled: true,
        model: "",
        systemPrompt: DEFAULT_PROMPTS.t3,
        maxParallel: 4,
        compactionThreshold: 85,
        tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "trimegisto_spawn"],
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
    dashboardVisible: true,
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
  return { tier: match[1] as AgentTier, letter: match[2] };
}
