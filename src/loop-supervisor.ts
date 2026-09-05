/**
 * Trimegisto — Loop Supervisor
 *
 * Deterministic loop detection and prevention for sub-agents.
 * Lives in the main process, monitors agent outputs post-execution.
 *
 * Four detection mechanisms:
 *   1. Output Similarity — same agent repeating (nearly) identical outputs 3+ times consecutively
 *   2. Spawn Chain Depth — prevents circular auto-spawning beyond max depth
 *   3. Turn Limit — kills agents that exceed max turns
 *   4. Strike System — 3 strikes → context shock → tier cooldown
 *
 * Repetition is tracked PER AGENT (not per tier): different agents that
 * legitimately share common material (same contract, same codebase) must
 * never look like one agent looping.
 */

import type { AgentResult, AgentTier, LoopSupervisorConfig } from "./types.ts";
import { shingleHashes, jaccardSimilarity } from "./similarity.ts";

// ── Types ──────────────────────────────────────────────────

// Re-export LoopSupervisorConfig from types
export type { LoopSupervisorConfig } from "./types.ts";

export interface LoopAlert {
  type: "output_repeat" | "spawn_depth" | "turn_limit" | "strike_three" | "cross_agent_duplicate";
  tier: AgentTier;
  agentId: string;
  message: string;
  strike: number;
  timestamp: number;
  /** For cross_agent_duplicate: the other agent whose output was near-identical */
  duplicateAgentId?: string;
  /** For cross_agent_duplicate: approximate tokens spent producing redundant output */
  wastedTokens?: number;
  /** For cross_agent_duplicate: shingle Jaccard similarity (0..1) */
  similarity?: number;
}

export interface ContextShock {
  /** Whether to prune last N messages from context */
  pruneLastTurns: number;
  /** Injected message to force strategy change */
  shockMessage: string;
}

// ── Defaults ────────────────────────────────────────────────

export const DEFAULT_LOOP_CONFIG: LoopSupervisorConfig = {
  enabled: true,
  maxRepeatedOutputs: 3,
  maxSpawnDepth: 5,
  maxAgentTurns: 50,
  turnLimitGrace: 15,
  tierCooldownMs: 60_000,
  similarityThreshold: 0.92,
  minRepeatableOutputChars: 80,
  dedupeCrossAgent: false,
};

/**
 * Normalize an error message for pattern matching.
 */
function normalizeError(err: string): string {
  return err
    .slice(0, 500)
    .replace(/\d+/g, "N")
    .replace(/\/[^\s]+/g, "/PATH")
    .trim()
    .toLowerCase();
}

// ── Supervisor State ────────────────────────────────────────

/** Per-agent loop evidence (tracked separately so that DIFFERENT agents
 *  sharing common material never look like one agent looping). */
interface AgentLoopState {
  /** Last N output shingle-signatures for this agent (most recent last) */
  outputSignatures: number[][];
  /** Last N normalized errors for this agent */
  errorPatterns: string[];
  /** Normalized tail (last ~800 chars) of the previous output — the tail is
   *  where real progress shows up even when the body is shared material. */
  lastTail: string | null;
  /** Timestamp of last result processed (used to prune stale agents) */
  lastSeen: number;
}

interface TierState {
  /** Per-agent loop evidence (keyed by agent ID) */
  agents: Map<string, AgentLoopState>;
  /** Strike counter (0-3) */
  strikes: number;
  /** Timestamp when tier was put in cooldown (0 = not in cooldown) */
  cooldownUntil: number;
  /** Agents currently running in this tier */
  activeAgentIds: Set<string>;
  /** Agents that have received a turn-limit warning (soft limit).
   *  Cleared when the agent completes or is killed. */
  turnWarnedAgents: Set<string>;
  /** ID of the last agent whose result was processed (for consecutiveness) */
  lastProcessedAgentId: string | null;
  /** How many consecutive results the last agent has produced without
   *  another agent interleaving. Repetition only counts when >= 3. */
  consecutiveSameAgent: number;
  /** Number of cross-agent near-duplicate output pairs detected */
  crossDuplicates: number;
  /** Approximate tokens wasted on cross-agent duplicate work */
  wastedTokens: number;
}

interface SpawnChainNode {
  agentId: string;
  tier: AgentTier;
  parentId?: string;
  depth: number;
}

export class LoopSupervisor {
  private config: LoopSupervisorConfig;
  private tiers: Record<AgentTier, TierState>;
  private spawnChains: Map<string, SpawnChainNode> = new Map();
  private alerts: LoopAlert[] = [];
  private onAlert: ((alert: LoopAlert) => void) | null = null;
  private onShock: ((shock: ContextShock, tier: AgentTier) => void) | null = null;

  constructor(config?: Partial<LoopSupervisorConfig>) {
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    this.tiers = {
      active: { agents: new Map(), strikes: 0, cooldownUntil: 0, activeAgentIds: new Set(), turnWarnedAgents: new Set(), lastProcessedAgentId: null, consecutiveSameAgent: 0, crossDuplicates: 0, wastedTokens: 0 },
      t1: { agents: new Map(), strikes: 0, cooldownUntil: 0, activeAgentIds: new Set(), turnWarnedAgents: new Set(), lastProcessedAgentId: null, consecutiveSameAgent: 0, crossDuplicates: 0, wastedTokens: 0 },
      t2: { agents: new Map(), strikes: 0, cooldownUntil: 0, activeAgentIds: new Set(), turnWarnedAgents: new Set(), lastProcessedAgentId: null, consecutiveSameAgent: 0, crossDuplicates: 0, wastedTokens: 0 },
      t3: { agents: new Map(), strikes: 0, cooldownUntil: 0, activeAgentIds: new Set(), turnWarnedAgents: new Set(), lastProcessedAgentId: null, consecutiveSameAgent: 0, crossDuplicates: 0, wastedTokens: 0 },
    };
  }

  // ── Callbacks ──────────────────────────────────────────────

  setOnAlert(cb: (alert: LoopAlert) => void): void {
    this.onAlert = cb;
  }

  setOnShock(cb: (shock: ContextShock, tier: AgentTier) => void): void {
    this.onShock = cb;
  }

  // ── Public API ─────────────────────────────────────────────

  /** Check if tier is currently in cooldown (3 strikes) */
  isTierCooledDown(tier: AgentTier): boolean {
    if (!this.config.enabled) return false;
    const state = this.tiers[tier];
    if (state.cooldownUntil === 0) return false;

    if (Date.now() > state.cooldownUntil) {
      state.cooldownUntil = 0;
      state.strikes = 0;
      return false;
    }
    return true;
  }

  /** Get cooldown remaining ms (0 if not in cooldown) */
  getCooldownRemaining(tier: AgentTier): number {
    const state = this.tiers[tier];
    if (state.cooldownUntil === 0) return 0;
    const remaining = state.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /** Check spawn depth limit */
  canSpawn(tier: AgentTier, parentId?: string): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true };
    if (this.isTierCooledDown(tier)) {
      return { allowed: false, reason: `Tier ${tier} is in cooldown (loop detected)` };
    }

    if (parentId) {
      const parent = this.spawnChains.get(parentId);
      if (parent && parent.depth >= this.config.maxSpawnDepth) {
        this.emitAlert({
          type: "spawn_depth",
          tier,
          agentId: parentId,
          message: `Spawn depth ${parent.depth} exceeds max ${this.config.maxSpawnDepth}`,
          strike: 0,
          timestamp: Date.now(),
        });
        return {
          allowed: false,
          reason: `Max spawn depth (${this.config.maxSpawnDepth}) exceeded`,
        };
      }
    }

    return { allowed: true };
  }

  /** Register a spawn event */
  registerSpawn(agentId: string, tier: AgentTier, parentId?: string): void {
    const state = this.tiers[tier];
    state.activeAgentIds.add(agentId);
    // Clean up stale turn warnings from previous runs of this agent ID
    state.turnWarnedAgents.delete(agentId);

    const parentDepth = parentId ? (this.spawnChains.get(parentId)?.depth ?? 0) : 0;
    this.spawnChains.set(agentId, {
      agentId,
      tier,
      parentId,
      depth: parentDepth + 1,
    });
  }

  /**
   * Check agent turn count against limits.
   *
   * Uses a TWO-STAGE system (unlike old single-limit kill):
   *   Stage 1 (SOFT LIMIT):  turns > maxAgentTurns → warning alert, agent keeps running
   *   Stage 2 (HARD LIMIT):  turns > maxAgentTurns + turnLimitGrace → kill agent
   *
   * This prevents killing agents doing legitimate long-running work
   * while still catching genuinely runaway/infinite-loop agents.
   *
   * Returns true if the agent should be killed (hard limit exceeded).
   */
  checkTurnLimit(agentId: string, tier: AgentTier, turns: number): boolean {
    if (!this.config.enabled) return false;

    const softLimit = this.config.maxAgentTurns;
    const hardLimit = softLimit + (this.config.turnLimitGrace ?? 15);
    const state = this.tiers[tier];

    // Below soft limit — everything is fine
    if (turns <= softLimit) return false;

    // Between soft and hard limit — warn once, don't kill
    if (turns <= hardLimit) {
      if (!state.turnWarnedAgents.has(agentId)) {
        state.turnWarnedAgents.add(agentId);
        const remaining = hardLimit - turns;
        this.emitAlert({
          type: "turn_limit",
          tier,
          agentId,
          message: `Agent ${agentId} approaching turn limit (${turns}/${softLimit}+${turns - softLimit}). ` +
            `${remaining} turns remaining before hard kill at ${hardLimit}. Finish your task soon.`,
          strike: 1, // Strike 1: warning only
          timestamp: Date.now(),
        });
      }
      return false; // Don't kill — give agent time to finish
    }

    // Hard limit exceeded — kill with context shock
    state.turnWarnedAgents.delete(agentId); // clean up tracking
    state.strikes = Math.min(state.strikes + 1, 3);

    this.emitAlert({
      type: "turn_limit",
      tier,
      agentId,
      message: `Agent ${agentId} exceeded hard turn limit (${turns}/${hardLimit}). ` +
        `Killing agent to prevent resource exhaustion. The task may need to be split into smaller sub-tasks.`,
      strike: Math.min(state.strikes + 1, 3),
      timestamp: Date.now(),
    });

    return true; // Kill the agent
  }

  /** Process agent completion — detect loops via per-agent output similarity */
  processResult(result: AgentResult): {
    loopDetected: boolean;
    contextShock?: ContextShock;
    strike: number;
  } {
    if (!this.config.enabled) {
      return { loopDetected: false, strike: 0 };
    }

    const state = this.tiers[result.tier];
    state.activeAgentIds.delete(result.agentId);

    // Clean up turn warning tracking
    state.turnWarnedAgents.delete(result.agentId);

    // Clean up spawn chain
    this.spawnChains.delete(result.agentId);

    // Consecutiveness: repetition only counts when the SAME agent produces
    // consecutive results without another agent interleaving. Different
    // agents working on shared material must never look like one loop.
    if (state.lastProcessedAgentId === result.agentId) {
      state.consecutiveSameAgent = Math.min(
        state.consecutiveSameAgent + 1,
        this.config.maxRepeatedOutputs,
      );
    } else {
      state.consecutiveSameAgent = 1;
      state.lastProcessedAgentId = result.agentId;
    }

    const isFailure = result.status === "error" || result.status === "killed";
    const output = result.output || result.stderr || "";

    if (!output.trim()) {
      return { loopDetected: false, strike: 0 };
    }

    // Get (or create) per-agent loop evidence
    const now = Date.now();
    let agentState = state.agents.get(result.agentId);
    if (!agentState) {
      agentState = { outputSignatures: [], errorPatterns: [], lastTail: null, lastSeen: now };
      state.agents.set(result.agentId, agentState);
    }
    agentState.lastSeen = now;

    // Prune stale agents (IDs are unique per spawn, so entries can pile up)
    if (state.agents.size > 64) {
      const stale = [...state.agents.entries()]
        .filter(([, s]) => s.lastSeen < now - 60_000)
        .map(([id]) => id);
      for (const id of stale) state.agents.delete(id);
    }

    // ── 1. Output repetition (per-agent, similarity-based) ──
    const minChars = this.config.minRepeatableOutputChars ?? 80;
    const threshold = this.config.similarityThreshold ?? 0.92;
    const maxHistory = this.config.maxRepeatedOutputs + 2;

    let outputRepeat = false;
    if (!isFailure && output.trim().length >= minChars) {
      // Cap at 6KB for performance; shingle similarity handles the rest
      const sig = shingleHashes(output.slice(0, 6000));
      agentState.outputSignatures.push(sig);
      if (agentState.outputSignatures.length > maxHistory) {
        agentState.outputSignatures = agentState.outputSignatures.slice(-maxHistory);
      }

      // Tail check: even when the body is dominated by shared material, real
      // progress shows up at the end. If consecutive tails differ, it's not a loop.
      const tail = output
        .slice(-800)
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
      const tailSimilar = agentState.lastTail === null ||
        jaccardSimilarity(shingleHashes(tail), shingleHashes(agentState.lastTail)) >= threshold;
      agentState.lastTail = tail;

      const recent = agentState.outputSignatures.slice(-this.config.maxRepeatedOutputs);
      outputRepeat = recent.length >= this.config.maxRepeatedOutputs &&
        state.consecutiveSameAgent >= this.config.maxRepeatedOutputs &&
        tailSimilar &&
        recent.every(s => jaccardSimilarity(s, recent[0]) >= threshold);

      // ── 1b. Cross-agent duplicate detection (opt-in, non-punitive) ──
      // Two DIFFERENT agents producing near-identical output = redundant work,
      // not a loop. Detected separately so it never inflates loop strikes: it
      // only emits an alert and accumulates a wasted-token metric.
      if (this.config.dedupeCrossAgent) {
        for (const [otherId, other] of state.agents) {
          if (otherId === result.agentId) continue;
          const otherSig = other.outputSignatures[other.outputSignatures.length - 1];
          if (!otherSig) continue;
          const sim = jaccardSimilarity(sig, otherSig);
          if (sim >= threshold) {
            const wasted = (result.usage.input || 0) + (result.usage.output || 0);
            state.crossDuplicates++;
            state.wastedTokens += wasted;
            this.emitAlert({
              type: "cross_agent_duplicate",
              tier: result.tier,
              agentId: result.agentId,
              duplicateAgentId: otherId,
              similarity: Math.round(sim * 1000) / 1000,
              wastedTokens: wasted,
              message: `Redundant output: ${result.agentId} ≈ ${otherId} (${(sim * 100).toFixed(0)}% similar) — ~${wasted} tokens duplicated`,
              strike: 0,
              timestamp: now,
            });
            break;
          }
        }
      }
    }

    // ── 2. Error pattern detection (per-agent, consecutive) ──
    let errorRepeat = false;
    if (isFailure && result.stderr) {
      const normalized = normalizeError(result.stderr);
      agentState.errorPatterns.push(normalized);
      if (agentState.errorPatterns.length > 5) {
        agentState.errorPatterns = agentState.errorPatterns.slice(-5);
      }

      const errRecent = agentState.errorPatterns.slice(-this.config.maxRepeatedOutputs);
      errorRepeat = errRecent.length >= this.config.maxRepeatedOutputs &&
        state.consecutiveSameAgent >= this.config.maxRepeatedOutputs &&
        errRecent.every(e => e === errRecent[0]);
    }

    const repeated = outputRepeat || errorRepeat;

    if (repeated) {
      state.strikes = Math.min(state.strikes + 1, 3);

      const kind = errorRepeat ? "error pattern" : "output";
      const alert: LoopAlert = {
        type: "output_repeat",
        tier: result.tier,
        agentId: result.agentId,
        message: `${kind} loop: ${this.config.maxRepeatedOutputs} consecutive identical ${kind}s from agent ${result.agentId} (tier ${result.tier})`,
        strike: state.strikes,
        timestamp: now,
      };
      this.emitAlert(alert);

      if (state.strikes >= 2) {
        // Strike 2+: produce context shock
        const shock: ContextShock = {
          pruneLastTurns: state.strikes >= 3 ? 3 : 2,
          shockMessage: state.strikes >= 3
            ? `CRITICAL: You are stuck in a loop. Your last ${this.config.maxRepeatedOutputs} results were identical. Your current approach has failed systematically. You MUST propose a completely different strategy. Do NOT repeat your previous reasoning. Start fresh with a radically different approach.`
            : `WARNING: Your last 2 results were nearly identical. You may be looping. Pause your current line of reasoning and try a different approach.`,
        };

        if (this.onShock) this.onShock(shock, result.tier);

        if (state.strikes >= 3) {
          // Strike 3: tier cooldown
          state.cooldownUntil = now + this.config.tierCooldownMs;
          this.emitAlert({
            type: "strike_three",
            tier: result.tier,
            agentId: result.agentId,
            message: `Tier ${result.tier} entering cooldown for ${this.config.tierCooldownMs / 1000}s (3 strikes)`,
            strike: 3,
            timestamp: now,
          });
        }

        return { loopDetected: true, contextShock: shock, strike: state.strikes };
      }

      return { loopDetected: true, strike: state.strikes };
    }

    // ── Success without repetition decays strikes ──────────
    if (!isFailure && !outputRepeat) {
      state.strikes = Math.max(0, state.strikes - 1);
    }

    return { loopDetected: false, strike: state.strikes };
  }

  /** Reset strikes for a tier (e.g., on manual intervention) */
  resetTier(tier: AgentTier): void {
    const state = this.tiers[tier];
    state.strikes = 0;
    state.cooldownUntil = 0;
    state.agents.clear();
    state.turnWarnedAgents.clear();
    state.lastProcessedAgentId = null;
    state.consecutiveSameAgent = 0;
    state.crossDuplicates = 0;
    state.wastedTokens = 0;
  }

  /** Get current state snapshot (for /tmg loops command) */
  getState(): {
    tiers: Record<AgentTier, { strikes: number; cooldownRemaining: number; activeAgents: number; recentHashes: number; turnWarned: number; crossDuplicates: number; wastedTokens: number }>;
    alerts: LoopAlert[];
  } {
    const snapshot = (tier: AgentTier) => {
      const s = this.tiers[tier];
      return {
        strikes: s.strikes,
        cooldownRemaining: this.getCooldownRemaining(tier),
        activeAgents: s.activeAgentIds.size,
        recentHashes: [...s.agents.values()].reduce((n, a) => n + a.outputSignatures.length, 0),
        turnWarned: s.turnWarnedAgents.size,
        crossDuplicates: s.crossDuplicates,
        wastedTokens: s.wastedTokens,
      };
    };
    return {
      tiers: {
        active: snapshot("active"),
        t1: snapshot("t1"),
        t2: snapshot("t2"),
        t3: snapshot("t3"),
      },
      alerts: [...this.alerts].slice(-20),
    };
  }

  /** Get context shock for an agent re-spawn (used by sendToAgent) */
  getContextShockForRespawn(tier: AgentTier): ContextShock | null {
    const state = this.tiers[tier];
    if (state.strikes >= 2) {
      return {
        pruneLastTurns: state.strikes >= 3 ? 3 : 2,
        shockMessage: state.strikes >= 3
          ? `[LOOP SUPERVISOR] Your tier (${tier}) has been flagged for repetitive output (${state.strikes} strikes). You MUST take a completely different approach. Do NOT repeat your previous strategy. Think differently.`
          : `[LOOP SUPERVISOR] Warning: repetitive pattern detected. Try a different approach this time.`,
      };
    }
    return null;
  }

  // ── Internal ─────────────────────────────────────────────

  private emitAlert(alert: LoopAlert): void {
    this.alerts.push(alert);
    if (this.alerts.length > 50) {
      this.alerts = this.alerts.slice(-50);
    }
    if (this.onAlert) this.onAlert(alert);
  }

  /** Update config at runtime */
  updateConfig(partial: Partial<LoopSupervisorConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): LoopSupervisorConfig {
    return { ...this.config };
  }
}
