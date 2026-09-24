/**
 * Trimegisto - spawn capacity tests
 *
 * Run: node --experimental-strip-types test-spawn-capacity.ts
 *
 * The ACTIVE tier (t0) shares its budget with the main session: the coordinator
 * itself is one t0 worker. `active.maxParallel = 1` therefore means "principal
 * only, spawn nothing" — the fix this suite locks in.
 *
 * `effectiveSpawnCapacity` is the one pure place that models that rule; every
 * gate (`canSpawnPooled`, `canSpawn`) and the wave planner read it, so a
 * regression here would silently over- or under-spawn the whole swarm.
 */

import { effectiveSpawnCapacity, canSpawnPooled, canSpawn } from "./src/agent-manager.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

const tierConfig = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  model: "",
  systemPrompt: "",
  maxParallel: 4,
  compactionThreshold: 0,
  tools: [],
  extraArgs: [],
  redundantModels: [],
  ...over,
}) as any;

console.log("effectiveSpawnCapacity: t0 spends one slot on the principal:");
{
  check("active 1/1 -> 0 (principal only, no spawn)", effectiveSpawnCapacity("active", 1, 1) === 0);
  check("active 2/1 -> 1 (principal + 1)", effectiveSpawnCapacity("active", 2, 1) === 1);
  check("active 4/1 -> 3 (principal + 3, the documented default)", effectiveSpawnCapacity("active", 4, 1) === 3);
  check("active 8/1 -> 7", effectiveSpawnCapacity("active", 8, 1) === 7);
  check("active 1/2 redundant pool -> 0 (t0=1 means no spawn on EVERY config)", effectiveSpawnCapacity("active", 1, 2) === 0);
  check("active 4/2 -> 6 (principal removed before pool scaling)", effectiveSpawnCapacity("active", 4, 2) === 6);
}

console.log("effectiveSpawnCapacity: every other tier has no principal:");
{
  check("t1 1/1 -> 1", effectiveSpawnCapacity("t1", 1, 1) === 1);
  check("t2 4/1 -> 4", effectiveSpawnCapacity("t2", 4, 1) === 4);
  check("t2 2/3 -> 6 (capacity scales with the redundant pool)", effectiveSpawnCapacity("t2", 2, 3) === 6);
  check("t3 8/2 -> 16", effectiveSpawnCapacity("t3", 8, 2) === 16);
}

console.log("effectiveSpawnCapacity: boundaries clamp, never NaN/negative/Infinity:");
{
  check("0 -> 0 on active", effectiveSpawnCapacity("active", 0, 1) === 0);
  check("0 -> 0 on t2", effectiveSpawnCapacity("t2", 0, 1) === 0);
  check("negative maxParallel -> 0", effectiveSpawnCapacity("active", -3, 1) === 0);
  check("NaN maxParallel -> 0", effectiveSpawnCapacity("active", NaN, 1) === 0);
  check("Infinity maxParallel -> 0 (corrupt config cannot open the gate)", effectiveSpawnCapacity("active", Infinity, 1) === 0);
  check("NaN poolSize falls back to 1", effectiveSpawnCapacity("t2", 4, NaN) === 4);
  check("0 poolSize falls back to 1", effectiveSpawnCapacity("t2", 4, 0) === 4);
  check("negative poolSize falls back to 1", effectiveSpawnCapacity("active", 4, -2) === 3);
  check("decimal 2.9 floors to 2 (active -> 1)", effectiveSpawnCapacity("active", 2.9, 1) === 1);
  check("huge values stay finite", effectiveSpawnCapacity("t2", 1e6, 1) === 1e6);
}

console.log("canSpawnPooled: the live gate honours the principal slot (zero agents registered):");
{
  const active1 = tierConfig({ maxParallel: 1 });
  const active2 = tierConfig({ maxParallel: 2 });
  const t2one = tierConfig({ model: "x/y", maxParallel: 1 });
  check("active maxParallel=1 with 0 spawned -> NO spawn", canSpawnPooled("active", active1, false) === false);
  check("active maxParallel=2 with 0 spawned -> CAN spawn 1", canSpawnPooled("active", active2, false) === true);
  check("t2 maxParallel=1 with 0 spawned -> CAN spawn (no principal)", canSpawnPooled("t2", t2one, false) === true);
  check("active maxParallel=0 -> NO spawn", canSpawnPooled("active", tierConfig({ maxParallel: 0 }), false) === false);
  check("canSpawn(active, 1) mirrors the pooled gate", canSpawn("active", 1) === false);
  check("canSpawn(active, 2) mirrors the pooled gate", canSpawn("active", 2) === true);
  check("canSpawn(t2, 1) is unaffected", canSpawn("t2", 1) === true);
  // The t0=1 rule must hold even when a redundant pool multiplies the tier.
  check("active maxParallel=1 + redundant pool of 2 -> NO spawn", canSpawnPooled("active", tierConfig({ maxParallel: 1, redundantModels: ["a/x", "b/y"] }), true) === false);
  check("active maxParallel=2 + redundant pool of 2 -> can spawn", canSpawnPooled("active", tierConfig({ maxParallel: 2, redundantModels: ["a/x", "b/y"] }), true) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
