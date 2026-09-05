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
  /** The child process (if running) */
  proc?: import("node:child_process").ChildProcess;
  /** Abort controller for this agent */
  controller: AbortController;
  /** Accumulated output so far */
  output: string;
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
  /** Compaction threshold: % of context window at which to trigger proactive compaction (0-100). Lower = compact sooner. Default: 65 (t1), 75 (t2), 85 (t3) */
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

export interface LoopSupervisorConfig {
  enabled: boolean;
  maxRepeatedOutputs: number;
  maxSpawnDepth: number;
  /** Soft turn limit — agent receives a warning here but is NOT killed. Default: 50 */
  maxAgentTurns: number;
  /** Extra turns granted after the soft limit before hard kill. Default: 15 (hard limit = soft + grace) */
  turnLimitGrace: number;
  tierCooldownMs: number;
  /**
   * Similarity threshold (0..1) for output repetition. Two outputs count as
   * "the same" when their word-shingle Jaccard similarity is >= this.
   * Higher values = fewer false positives when agents legitimately share
   * common material (same contract, same codebase) while making real
   * progress. Default: 0.92
   */
  similarityThreshold?: number;
  /**
   * Outputs shorter than this many chars are not checked for output-loop
   * repetition (they're usually acks/status pings, not loop evidence).
   * Default: 80
   */
  minRepeatableOutputChars?: number;
  /**
   * When true, ALSO detect near-identical outputs between DIFFERENT agents in
   * the same tier (redundant parallel work). Emits a `cross_agent_duplicate`
   * alert and accumulates a wasted-token metric, but never inflates loop
   * strikes (overlap is not a loop). Default: false.
   */
  dedupeCrossAgent?: boolean;
}

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
   * When ON, the Loop Supervisor also flags near-identical outputs from
   * DIFFERENT agents (redundant parallel work) and reports wasted tokens.
   */
  dedupeCrossAgent: boolean;
  /** Whether the dashboard is visible */
  dashboardVisible: boolean;
  /** Loop supervisor settings */
  loopSupervisor: Partial<LoopSupervisorConfig>;
}

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
