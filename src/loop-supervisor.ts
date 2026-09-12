/**
 * Trimegisto — Swarm Supervisor
 *
 * Reasoning/output loop detection deliberately lives in the separate `antiloop`
 * pi extension: antiloop is discovered by every sub-agent process (pi discovers
 * ~/.pi/agent/extensions unless --no-extensions is passed, which Trimegisto does
 * not) and acts mid-run (warn → force break → abort). Trimegisto no longer
 * duplicates that logic.
 *
 * What remains here is orchestration-level guarding that antiloop cannot see
 * because it is cross-process:
 *   1. Spawn chain depth — prevents recursive auto-spawning.
 *   2. Turn limit — soft warning + hard kill for runaway agents.
 *   3. Cross-agent duplicate detection — flags redundant parallel work (NOT a
 *      loop) and reports wasted tokens, so the swarm never pays twice.
 *
 * Repetition is tracked PER AGENT for redundancy (two different agents sharing
 * common material must never look like redundant work by themselves).
 */

import type { AgentResult, AgentTier, LoopSupervisorConfig } from "./types.ts";
import { shingleHashes, jaccardSimilarity } from "./similarity.ts";

// Re-export LoopSupervisorConfig from types
export type { LoopSupervisorConfig } from "./types.ts";

export interface LoopAlert {
  type: "spawn_depth" | "turn_limit" | "cross_agent_duplicate";
  tier: AgentTier;
  agentId: string;
  message: string;
  timestamp: number;
  /** For cross_agent_duplicate: the other agent whose output was near-identical */
  duplicateAgentId?: string;
  /** For cross_agent_duplicate: approximate tokens spent producing redundant output */
  wastedTokens?: number;
  /** For cross_agent_duplicate: shingle Jaccard similarity (0..1) */
  similarity?: number;
}

// ── Defaults ────────────────────────────────────────────────

export const DEFAULT_LOOP_CONFIG: LoopSupervisorConfig = {
  enabled: true,
  maxSpawnDepth: 5,
  maxAgentTurns: 50,
  turnLimitGrace: 15,
  dedupeCrossAgent: false,
};

/** Shingle Jaccard above which two different agents' outputs count as redundant. */
const CROSS_AGENT_SIMILARITY = 0.92;
/** Outputs shorter than this are ignored for cross-agent redundancy (acks/status). */
const CROSS_AGENT_MIN_CHARS = 80;

// ── Supervisor State ────────────────────────────────────────

interface AgentState {
  /** Shingle signature of the agent's last output (cross-agent redundancy only) */
  lastSignature: number[] | null;
  /** Timestamp of last result processed (used to prune stale agents) */
  lastSeen: number;
}

interface TierState {
  /** Per-agent redundancy evidence (keyed by agent ID) */
  agents: Map<string, AgentState>;
  /** Agents currently running in this tier */
  activeAgentIds: Set<string>;
  /** Agents that have received a turn-limit warning (soft limit). */
  turnWarnedAgents: Set<string>;
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

function emptyTierState(): TierState {
  return {
    agents: new Map(),
    activeAgentIds: new Set(),
    turnWarnedAgents: new Set(),
    crossDuplicates: 0,
    wastedTokens: 0,
  };
}

export class LoopSupervisor {
  private config: LoopSupervisorConfig;
  private tiers: Record<AgentTier, TierState>;
  private spawnChains: Map<string, SpawnChainNode> = new Map();
  private alerts: LoopAlert[] = [];
  private onAlert: ((alert: LoopAlert) => void) | null = null;

  constructor(config?: Partial<LoopSupervisorConfig>) {
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    this.tiers = {
      active: emptyTierState(),
      t1: emptyTierState(),
      t2: emptyTierState(),
      t3: emptyTierState(),
    };
  }

  // ── Callbacks ──────────────────────────────────────────────

  setOnAlert(cb: (alert: LoopAlert) => void): void {
    this.onAlert = cb;
  }

  // ── Public API ─────────────────────────────────────────────

  /** Check spawn depth limit */
  canSpawn(tier: AgentTier, parentId?: string): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true };

    if (parentId) {
      const parent = this.spawnChains.get(parentId);
      if (parent && parent.depth >= this.config.maxSpawnDepth) {
        this.emitAlert({
          type: "spawn_depth",
          tier,
          agentId: parentId,
          message: `Spawn depth ${parent.depth} exceeds max ${this.config.maxSpawnDepth}`,
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
   * Two-stage: turns > maxAgentTurns → warning alert, agent keeps running;
   * turns > maxAgentTurns + turnLimitGrace → kill agent.
   *
   * Returns true if the agent should be killed (hard limit exceeded).
   */
  checkTurnLimit(agentId: string, tier: AgentTier, turns: number): boolean {
    if (!this.config.enabled) return false;

    const softLimit = this.config.maxAgentTurns;
    const hardLimit = softLimit + (this.config.turnLimitGrace ?? 15);
    const state = this.tiers[tier];

    if (turns <= softLimit) return false;

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
          timestamp: Date.now(),
        });
      }
      return false; // Don't kill — give agent time to finish
    }

    // Hard limit exceeded — kill
    state.turnWarnedAgents.delete(agentId);
    this.emitAlert({
      type: "turn_limit",
      tier,
      agentId,
      message: `Agent ${agentId} exceeded hard turn limit (${turns}/${hardLimit}). ` +
        `Killing agent to prevent resource exhaustion. The task may need to be split into smaller sub-tasks.`,
      timestamp: Date.now(),
    });

    return true; // Kill the agent
  }

  /**
   * Process a finished agent result.
   *
   * Loop detection is NOT done here (that is antiloop's job). This only records
   * the output for cross-agent redundancy detection and cleans up guard state.
   */
  processResult(result: AgentResult): void {
    const state = this.tiers[result.tier];
    state.activeAgentIds.delete(result.agentId);
    state.turnWarnedAgents.delete(result.agentId);
    this.spawnChains.delete(result.agentId);

    if (!this.config.enabled) return;

    // Failures are never redundant work.
    const isFailure = result.status === "error" || result.status === "killed";
    if (isFailure) return;

    const output = result.output || "";
    if (output.trim().length < CROSS_AGENT_MIN_CHARS) return;

    const now = Date.now();

    // Prune stale agents (IDs are unique per spawn, so entries can pile up)
    if (state.agents.size > 64) {
      const stale = [...state.agents.entries()]
        .filter(([, s]) => s.lastSeen < now - 60_000)
        .map(([id]) => id);
      for (const id of stale) state.agents.delete(id);
    }

    // Cap at 6KB for performance; shingle similarity handles the rest
    const sig = shingleHashes(output.slice(0, 6000));

    // ── Cross-agent duplicate detection (opt-in, non-punitive) ──
    // Two DIFFERENT agents producing near-identical output = redundant work.
    // Emits an alert and accumulates a wasted-token metric.
    if (this.config.dedupeCrossAgent) {
      for (const [otherId, other] of state.agents) {
        if (otherId === result.agentId || !other.lastSignature) continue;
        const sim = jaccardSimilarity(sig, other.lastSignature);
        if (sim >= CROSS_AGENT_SIMILARITY) {
          const wasted = (result.usage?.input || 0) + (result.usage?.output || 0);
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
            timestamp: now,
          });
          break;
        }
      }
    }

    state.agents.set(result.agentId, { lastSignature: sig, lastSeen: now });
  }

  /** Reset redundancy counters and guard state for a tier */
  resetTier(tier: AgentTier): void {
    const state = this.tiers[tier];
    state.agents.clear();
    state.turnWarnedAgents.clear();
    state.crossDuplicates = 0;
    state.wastedTokens = 0;
  }

  /** Get current state snapshot (for /tmg guard command) */
  getState(): {
    tiers: Record<AgentTier, { activeAgents: number; recentHashes: number; turnWarned: number; crossDuplicates: number; wastedTokens: number }>;
    alerts: LoopAlert[];
  } {
    const snapshot = (tier: AgentTier) => {
      const s = this.tiers[tier];
      return {
        activeAgents: s.activeAgentIds.size,
        recentHashes: [...s.agents.values()].reduce((n, a) => n + (a.lastSignature ? 1 : 0), 0),
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
