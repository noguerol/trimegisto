/**
 * Trimegisto - Config Persistence
 *
 * Saves and loads Trimegisto configuration to a dedicated JSON file
 * at ~/.pi/agent/trimegisto/config.json. This survives session
 * changes (/new, /resume, /fork) unlike pi.appendEntry which is
 * session-bound.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TrimegistoConfig } from "./types.ts";

function getConfigPath(): string {
  const dir = path.join(getAgentDir(), "trimegisto");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "config.json");
}

/**
 * Save Trimegisto config to disk.
 * Only saves the persisted fields (not runtime-only state).
 */
export function saveConfig(config: TrimegistoConfig): void {
  try {
    const toSave = {
      active: {
        model: config.active.model,
        tools: config.active.tools,
        extraArgs: config.active.extraArgs,
        systemPrompt: config.active.systemPrompt,
        maxParallel: config.active.maxParallel,
        compactionThreshold: config.active.compactionThreshold,
        enabled: config.active.enabled,
        redundantModels: config.active.redundantModels ?? [],
      },
      t1: {
        model: config.t1.model,
        tools: config.t1.tools,
        extraArgs: config.t1.extraArgs,
        systemPrompt: config.t1.systemPrompt,
        maxParallel: config.t1.maxParallel,
        compactionThreshold: config.t1.compactionThreshold,
        redundantModels: config.t1.redundantModels ?? [],
      },
      t2: {
        model: config.t2.model,
        tools: config.t2.tools,
        extraArgs: config.t2.extraArgs,
        systemPrompt: config.t2.systemPrompt,
        maxParallel: config.t2.maxParallel,
        compactionThreshold: config.t2.compactionThreshold,
        redundantModels: config.t2.redundantModels ?? [],
      },
      t3: {
        model: config.t3.model,
        tools: config.t3.tools,
        extraArgs: config.t3.extraArgs,
        systemPrompt: config.t3.systemPrompt,
        maxParallel: config.t3.maxParallel,
        compactionThreshold: config.t3.compactionThreshold,
        redundantModels: config.t3.redundantModels ?? [],
      },
      enabled: config.enabled,
      autoSpawn: config.autoSpawn,
      useActiveModel: config.useActiveModel,
      spawnOnlyOnActive: config.spawnOnlyOnActive,
      redundantAgents: config.redundantAgents,
      dashboardVisible: config.dashboardVisible,
      loopSupervisor: config.loopSupervisor,
      // Schema version for future migrations
      _schemaVersion: 2,
      _savedAt: new Date().toISOString(),
    };

    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch (err) {
    // Silently fail — config will use defaults next time
    console.error("[trimegisto] Failed to save config:", err);
  }
}

/**
 * Load Trimegisto config from disk.
 * Returns the saved TierConfig partials and top-level flags.
 * Returns null if no config file exists or it's corrupted.
 */
export function loadConfig(): {
  active?: Partial<{ model: string; tools: string[]; extraArgs: string[]; systemPrompt: string; maxParallel: number; compactionThreshold: number; enabled: boolean; redundantModels: string[] }>;
  t1?: Partial<{ model: string; tools: string[]; extraArgs: string[]; systemPrompt: string; maxParallel: number; compactionThreshold: number; redundantModels: string[] }>;
  t2?: Partial<{ model: string; tools: string[]; extraArgs: string[]; systemPrompt: string; maxParallel: number; compactionThreshold: number; redundantModels: string[] }>;
  t3?: Partial<{ model: string; tools: string[]; extraArgs: string[]; systemPrompt: string; maxParallel: number; compactionThreshold: number; redundantModels: string[] }>;
  enabled?: boolean;
  autoSpawn?: boolean;
  useActiveModel?: boolean;
  spawnOnlyOnActive?: boolean;
  redundantAgents?: boolean;
  dashboardVisible?: boolean;
  loopSupervisor?: Partial<{ enabled: boolean; maxRepeatedOutputs: number; maxSpawnDepth: number; maxAgentTurns: number; turnLimitGrace: number; tierCooldownMs: number }>;
} | null {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return null;

    const raw = fs.readFileSync(configPath, "utf-8");
    const data = JSON.parse(raw);

    // Basic validation
    if (!data || typeof data !== "object") return null;

    return {
      active: data.active,
      t1: data.t1,
      t2: data.t2,
      t3: data.t3,
      enabled: typeof data.enabled === "boolean" ? data.enabled : undefined,
      autoSpawn: typeof data.autoSpawn === "boolean" ? data.autoSpawn : undefined,
      useActiveModel: typeof data.useActiveModel === "boolean" ? data.useActiveModel : undefined,
      spawnOnlyOnActive: typeof data.spawnOnlyOnActive === "boolean" ? data.spawnOnlyOnActive : undefined,
      redundantAgents: typeof data.redundantAgents === "boolean" ? data.redundantAgents : undefined,
      dashboardVisible: typeof data.dashboardVisible === "boolean" ? data.dashboardVisible : undefined,
      loopSupervisor: data.loopSupervisor && typeof data.loopSupervisor === "object" ? data.loopSupervisor : undefined,
    };
  } catch (err) {
    console.error("[trimegisto] Failed to load config:", err);
    return null;
  }
}
