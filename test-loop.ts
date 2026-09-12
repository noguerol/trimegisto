// Functional tests for the Trimegisto swarm guard.
//
// Loop detection itself now lives in the `antiloop` extension, so these tests
// cover what remains here: spawn depth, turn limits and cross-agent duplicate
// (redundancy) detection.
//
// Run: node --experimental-strip-types test-loop.ts
import { LoopSupervisor, DEFAULT_LOOP_CONFIG } from "./src/loop-supervisor.ts";

const CONTRACT = `Clause 12.1 - Prestation terms. The contractor shall provide the services described in Annex A
for a total consideration of EUR 240,000 payable in four equal instalments. Any delay in payment
shall accrue interest at the statutory rate. The parties agree that force majeure events including
but not limited to natural disasters, pandemics, and governmental action shall suspend performance
obligations for the duration of the event. Compliance with the pact compensation rules is a
condition precedent to any claim for damages arising out of or in connection with this agreement.
Ancillary obligations include confidentiality, non-solicitation, and the duty to maintain adequate
insurance coverage throughout the term. Disputes shall be resolved by arbitration in accordance
with the rules of the Chamber of Commerce. `;

function makeResult(agentId: string, tier: "t1" | "t2" | "t3", output: string, status: "done" | "error" = "done", stderr = "", usage?: { input: number; output: number }) {
  return {
    agentId, tier, task: "analyze contract",
    status, output, stderr,
    usage: { turns: 1, input: usage?.input ?? 0, output: usage?.output ?? 0, cost: 0 },
    log: [],
  } as any;
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`); }
}

// ── Test 1: spawn depth limit ─────────────────────────────
{
  const s = new LoopSupervisor({ enabled: true, maxSpawnDepth: 2 });
  const alerts: string[] = [];
  s.setOnAlert(a => alerts.push(a.type));
  console.log("Test 1 (spawn depth):");
  check("root can spawn (no parent)", s.canSpawn("t2").allowed);
  s.registerSpawn("t2a", "t2");                    // depth 1
  s.registerSpawn("t2b", "t2", "t2a");             // depth 2
  s.registerSpawn("t2c", "t2", "t2b");             // depth 3
  check("depth 1 parent allowed", s.canSpawn("t2", "t2a").allowed);
  check("depth 2 parent blocked", !s.canSpawn("t2", "t2b").allowed);
  check("depth 3 parent blocked", !s.canSpawn("t2", "t2c").allowed);
  check("spawn_depth alert emitted", alerts.includes("spawn_depth"));
}

// ── Test 2: turn limit soft warning then hard kill ────────
{
  const s = new LoopSupervisor({ enabled: true, maxAgentTurns: 5, turnLimitGrace: 3 });
  const turnAlerts: Array<{ msg: string }> = [];
  s.setOnAlert(a => { if (a.type === "turn_limit") turnAlerts.push(a); });
  console.log("Test 2 (turn limit):");
  s.registerSpawn("t2a", "t2");
  check("at soft limit no kill", s.checkTurnLimit("t2a", "t2", 5) === false);
  check("just over soft warns, no kill", s.checkTurnLimit("t2a", "t2", 6) === false);
  check("soft warning emitted once", turnAlerts.length === 1, turnAlerts.length);
  s.checkTurnLimit("t2a", "t2", 7);
  check("still only one soft warning", turnAlerts.length === 1, turnAlerts.length);
  check("hard limit kills (5+3+1)", s.checkTurnLimit("t2a", "t2", 9) === true);
  check("hard kill emitted a second alert", turnAlerts.length === 2, turnAlerts.length);
  check("turnWarned cleared after kill", s.getState().tiers.t2.turnWarned === 0);
}

// ── Test 3: cross-agent duplicate detection (redundancy) ──
{
  const s = new LoopSupervisor({ enabled: true, dedupeCrossAgent: true });
  const dups: any[] = [];
  s.setOnAlert(a => { if (a.type === "cross_agent_duplicate") dups.push(a); });
  console.log("Test 3 (cross-agent redundancy):");
  s.registerSpawn("t2a", "t2");
  s.registerSpawn("t2b", "t2");
  s.processResult(makeResult("t2a", "t2", CONTRACT + "agent A conclusion", "done", "", { input: 100, output: 50 }));
  s.processResult(makeResult("t2b", "t2", CONTRACT + "agent A conclusion", "done", "", { input: 100, output: 50 }));
  check("duplicate pair detected", dups.length === 1, dups.length);
  check("reports the other agent", dups[0]?.duplicateAgentId === "t2a", dups[0]?.duplicateAgentId);
  check("reports wasted tokens", dups[0]?.wastedTokens === 150, dups[0]?.wastedTokens);
  check("counter incremented", s.getState().tiers.t2.crossDuplicates === 1);
  // A genuinely different output must NOT be flagged
  s.processResult(makeResult("t2c", "t2", CONTRACT.replace("240,000", "900,000") + " a completely different analysis with fresh numbers and a distinct plan of action for the quarter", "done"));
  check("different output not flagged", s.getState().tiers.t2.crossDuplicates === 1, s.getState().tiers.t2.crossDuplicates);
}

// ── Test 4: dedupeCrossAgent OFF => no alerts ─────────────
{
  const s = new LoopSupervisor({ enabled: true, dedupeCrossAgent: false });
  let dups = 0;
  s.setOnAlert(a => { if (a.type === "cross_agent_duplicate") dups++; });
  console.log("Test 4 (cross-agent OFF):");
  s.processResult(makeResult("t2a", "t2", CONTRACT + "same"));
  s.processResult(makeResult("t2b", "t2", CONTRACT + "same"));
  check("no redundancy alert when disabled", dups === 0, dups);
}

// ── Test 5: repetition is NOT trimegisto's job anymore ────
{
  const s = new LoopSupervisor({ enabled: true, dedupeCrossAgent: true });
  let alerts = 0;
  s.setOnAlert(() => { alerts++; });
  console.log("Test 5 (no loop detection here):");
  for (let i = 0; i < 5; i++) s.processResult(makeResult("t2a", "t2", CONTRACT + "identical output every single time"));
  check("same-agent repetition produces no alert", alerts === 0, alerts);
  check("no strikes/cooldown state exists", !("strikes" in s.getState().tiers.t2));
}

// ── Test 6: failures and short outputs are ignored ────────
{
  const s = new LoopSupervisor({ enabled: true, dedupeCrossAgent: true });
  let dups = 0;
  s.setOnAlert(a => { if (a.type === "cross_agent_duplicate") dups++; });
  console.log("Test 6 (failures / short outputs):");
  s.processResult(makeResult("t2a", "t2", CONTRACT + "err", "error"));
  s.processResult(makeResult("t2b", "t2", CONTRACT + "err", "error"));
  check("errors never flagged as redundant", dups === 0, dups);
  s.processResult(makeResult("t2c", "t2", "done"));
  s.processResult(makeResult("t2d", "t2", "done"));
  check("short outputs (acks) ignored", dups === 0, dups);
}

// ── Test 7: resetTier clears counters ─────────────────────
{
  const s = new LoopSupervisor({ enabled: true, dedupeCrossAgent: true });
  s.processResult(makeResult("t2a", "t2", CONTRACT + "x"));
  s.processResult(makeResult("t2b", "t2", CONTRACT + "x"));
  console.log("Test 7 (reset):");
  check("counter before reset", s.getState().tiers.t2.crossDuplicates === 1);
  s.resetTier("t2");
  const st = s.getState().tiers.t2;
  check("counter cleared", st.crossDuplicates === 0 && st.wastedTokens === 0);
}

// ── Test 8: disabled guard does nothing ───────────────────
{
  const s = new LoopSupervisor({ enabled: false, maxSpawnDepth: 1, maxAgentTurns: 1 });
  let alerts = 0;
  s.setOnAlert(() => { alerts++; });
  console.log("Test 8 (disabled):");
  s.registerSpawn("t2a", "t2");
  s.registerSpawn("t2b", "t2", "t2a");
  check("canSpawn always allowed", s.canSpawn("t2", "t2a").allowed);
  check("turn limit never kills", s.checkTurnLimit("t2a", "t2", 999) === false);
  check("no alerts", alerts === 0, alerts);
}

// ── Test 9: defaults still expose the guard knobs ─────────
{
  console.log("Test 9 (defaults):");
  check("default maxSpawnDepth = 5", DEFAULT_LOOP_CONFIG.maxSpawnDepth === 5);
  check("default maxAgentTurns = 50", DEFAULT_LOOP_CONFIG.maxAgentTurns === 50);
  check("default turnLimitGrace = 15", DEFAULT_LOOP_CONFIG.turnLimitGrace === 15);
  check("default dedupeCrossAgent = false", DEFAULT_LOOP_CONFIG.dedupeCrossAgent === false);
  check("loop-detection knobs removed", !("maxRepeatedOutputs" in DEFAULT_LOOP_CONFIG) && !("similarityThreshold" in DEFAULT_LOOP_CONFIG) && !("tierCooldownMs" in DEFAULT_LOOP_CONFIG));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
