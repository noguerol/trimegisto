/**
 * Trimegisto - Type Definitions
 *
 * Agent tiers:
 * - ACTIVE: the pi active model (local, fast, shared speculative pool). DEFAULT for mass parallel spawn.
 * - T1: deep thinking / coordinator (may be an expensive cloud model). RESERVED.
 * - T2: complex problem solver (additional, if configured)
 * - T3: fast worker for minor tasks (additional, if configured)
 *
 * Agent IDs: t0a (active), t1a, t2b, t3c...
 */

export type AgentTier = "t1" | "t2" | "t3" | "active";

export type AgentStatus =
  | "idle"       // Not yet started
  | "running"    // Actively processing
  | "waiting"    // Waiting for sub-agent result or user input
  | "done"       // Completed successfully
  | "error"      // Completed with error
  | "killed";    // Terminated by user

export interface AgentInstance {
  /** Unique agent ID (e.g., t1a, t2b, t3c) */
  id: string;
  /** Agent tier */
  tier: AgentTier;
  /** Task description */
  task: string;
  /** Current status */
  status: AgentStatus;
  /** Spawn timestamp */
  startedAt: number;
  /** Completion timestamp (if done/error/killed) */
  finishedAt?: number;
  /** Accumulated time (ms) the agent spent in a terminal/stopped state. */
  idleMs?: number;
  /** When the agent last entered a terminal/stopped state (undefined while active). */
  idleSince?: number;
  /** The child process (if running) */
  proc?: import("node:child_process").ChildProcess;
  /** Abort controller for this agent */
  controller: AbortController;
  /** Accumulated output so far */
  output: string;
  /** Last assistant message text (the agent's own final answer), replaced on each assistant message */
  finalOutput: string;
  /** Error output */
  stderr: string;
  /** Usage stats */
  usage: UsageStats;
  /** Model used */
  model?: string;
  /** Model requested for the current spawn attempt (for pool load-balancing/failover) */
  requestedModel?: string;
  /** Stop reason */
  stopReason?: string;
  /** Tags for tracking spawn source */
  parentId?: string;
  /** Resolve function for when this agent finishes */
  resolve?: (value: AgentResult) => void;
  /** Per-line output log for streaming display */
  log: AgentLogEntry[];
}

export interface AgentLogEntry {
  /** Timestamp */
  ts: number;
  /** Log level: info, output, error, tool */
  level: "info" | "output" | "error" | "tool";
  /** Log message */
  text: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface AgentResult {
  agentId: string;
  tier: AgentTier;
  task: string;
  status: AgentStatus;
  output: string;
  finalOutput?: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  log: AgentLogEntry[];
}

export interface TierConfig {
  /** Whether this tier is enabled (spawnable). Disabled tiers are reported to the coordinator so it doesn't try and fail. */
  enabled: boolean;
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-20250514") */
  model: string;
  /** System prompt (base instructions for this tier) */
  systemPrompt: string;
  /** Max parallel instances */
  maxParallel: number;
  /**
   * Proactive compaction threshold: % of the context window at which Trimegisto
   * forces compaction. 0 = OFF (default): let pi decide with its native setting.
   */
  compactionThreshold: number;
  /** Allowed tools */
  tools: string[];
  /** Extra pi args (e.g., thinking level) */
  extraArgs: string[];
  /**
   * Redundant/fallback models for this tier (same thinking level, other providers).
   * When "redundant agents" is ON, the tier spawns on the least-loaded model in
   * [model, ...redundantModels] (each with its own maxParallel capacity) and
   * fails over to the next model on spawn errors, provider exhaustion (429/quota)
   * or first-response timeout.
   */
  redundantModels?: string[];
}

/**
 * Watchdog timeouts for spawned agents, in seconds.
 * A value of 0 disables that watchdog.
 */
export interface WatchdogConfig {
  /**
   * Seconds to wait for the FIRST assistant response before killing the agent
   * (provider hang / model never starts). 0 = disabled. Default: 90.
   */
  firstResponseSeconds: number;
  /**
   * Seconds without any agent progress (no stream events) before killing it.
   * 0 = disabled. Default: 120.
   */
  idleSeconds: number;
  /**
   * Maximum wall-clock seconds per agent attempt. 0 = disabled (agent may run
   * for as long as it keeps making progress). Default: 0 (disabled).
   */
  maxRuntimeSeconds: number;
}

export interface LoopSupervisorConfig {
  enabled: boolean;
  /** Max recursive auto-spawn depth (structural guard; antiloop cannot see it). */
  maxSpawnDepth: number;
  /**
   * Whether the turn limit is enforced at all. OFF by default: an agent is
   * never warned or killed for its turn count unless this is enabled.
   */
  turnLimitEnabled: boolean;
  /** Soft turn limit — agent receives a warning here but is NOT killed. Default: 50 */
  maxAgentTurns: number;
  /** Extra turns granted after the soft limit before hard kill. Default: 15 (hard limit = soft + grace) */
  turnLimitGrace: number;
  /**
   * When true, flag near-identical outputs from DIFFERENT agents (redundant
   * parallel work) and report wasted tokens. This is overlap detection, not
   * loop detection. Default: false.
   */
  dedupeCrossAgent?: boolean;
}

export interface ModelHealthConfig {
  /** Whether the model circuit breaker is active. */
  enabled: boolean;
  /** Consecutive model-level failures before the breaker opens. */
  failureThreshold: number;
  /** Base cooldown (seconds) applied when the breaker opens. */
  cooldownSeconds: number;
  /** Cap for the exponential backoff (seconds). */
  maxCooldownSeconds: number;
}

/**
 * Reaping settings for finished agents, in seconds. A value of 0 disables the
 * corresponding rule; `enabled: false` disables the whole reaper.
 */
export interface ReaperConfig {
  /**
   * Master switch for auto-reaping of finished agents. ON by default: agents
   * that are done/error/killed and are no longer referenced by any batch or
   * watcher are reaped (memory, locks, context and telemetry freed, and the
   * line drops off the dashboard list and /tmg list) after
   * `terminalIdleSeconds`.
   */
  enabled: boolean;
  /**
   * Seconds a terminal agent must have been sitting unused before it is
   * reaped. 0 = reap immediately on the first sweep after the agent settles.
   * Default: 300.
   */
  terminalIdleSeconds: number;
}

/** Default reaper settings (seconds). */
export const REAPER_DEFAULTS: ReaperConfig = {
  enabled: true,
  terminalIdleSeconds: 300,
} as const;

export interface TrimegistoConfig {
  /** Active model tier (default for mass parallel spawn; uses the pi active model) */
  active: TierConfig;
  t1: TierConfig;
  t2: TierConfig;
  t3: TierConfig;
  /** Whether Trimegisto is globally enabled */
  enabled: boolean;
  /** Whether auto-spawning is enabled */
  autoSpawn: boolean;
  /**
   * Whether spawned agents use the ACTIVE pi model instead of the per-tier
   * configured model. Default true: parallel agents hit the same server,
   * sharing its speculative-decoding pool (ngram/MTP batching).
   */
  useActiveModel: boolean;
  /**
   * When ON, every spawn request (from the main tool, slash commands, or
   * sub-agent auto-spawn) is forced onto the "active" tier (t0), using the
   * pi active model. Tiers t1/t2/t3 are never spawned.
   */
  spawnOnlyOnActive: boolean;
  /**
   * When ON, tiers use their redundantModels pool: spawns go to the least-loaded
   * model and fail over to the next one on provider errors/exhaustion/timeouts.
   */
  redundantAgents: boolean;
  /**
   * When ON (default), near-duplicate tasks are rejected before launch so the
   * swarm never pays twice for effectively the same work.
   */
  dedupeTasks: boolean;
  /**
   * When ON, the swarm guard also flags near-identical outputs from
   * DIFFERENT agents (redundant parallel work) and reports wasted tokens.
   */
  dedupeCrossAgent: boolean;
  /** Dashboard mode (persisted). "off" implies dashboardVisible = false. */
  dashboardMode: DashboardMode;
  /** Legacy boolean mirror of dashboardMode ("off" -> false, anything else -> true). */
  dashboardVisible: boolean;
  /** Watchdog timeouts (seconds; 0 disables that watchdog) */
  watchdog: WatchdogConfig;
  /** Auto-reaping of finished (terminal) agents (seconds; 0 disables the idle rule) */
  reaper: ReaperConfig;
  /** Loop supervisor settings */
  loopSupervisor: Partial<LoopSupervisorConfig>;
  /** Model-level circuit breaker (pauses spawns on a failing model) */
  modelHealth: ModelHealthConfig;
}

export type DashboardMode = "compact" | "widget" | "off";

export interface SpawnRequest {
  requestId: string;
  tier: AgentTier;
  task: string;
  parentId: string;
  cwd: string;
  timestamp: number;
}

export interface SpawnResponse {
  requestId: string;
  result: AgentResult;
}
