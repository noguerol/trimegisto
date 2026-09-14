// Functional tests for the Trimegisto swarm guard.
//
// Loop detection itself now lives in the `antiloop` extension, so these tests
// cover what remains here: spawn depth, turn limits and cross-agent duplicate
// (redundancy) detection.
//
// Run: node --experimental-strip-types test-loop.ts
import { LoopSupervisor, DEFAULT_LOOP_CONFIG } from "./src/loop-supervisor.ts";
import { sanitizeLoopSupervisorConfig, applyGuardConfig } from "./src/config.ts";
import { formatGuardTurnLimit } from "./src/commands.ts";
import { foldDedupeFlagIntoGuard } from "./src/config.ts";
import { setAgentStatus, agentIdleMs } from "./src/agent-manager.ts";
import type { AgentInstance } from "./src/types.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  const s = new LoopSupervisor({ enabled: true, turnLimitEnabled: true, maxAgentTurns: 5, turnLimitGrace: 3 });
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
  check("default turnLimitEnabled = false (off)", DEFAULT_LOOP_CONFIG.turnLimitEnabled === false);
  check("default maxAgentTurns = 50", DEFAULT_LOOP_CONFIG.maxAgentTurns === 50);
  check("default turnLimitGrace = 15", DEFAULT_LOOP_CONFIG.turnLimitGrace === 15);
  check("default dedupeCrossAgent = false", DEFAULT_LOOP_CONFIG.dedupeCrossAgent === false);
  check("loop-detection knobs removed", !("maxRepeatedOutputs" in DEFAULT_LOOP_CONFIG) && !("similarityThreshold" in DEFAULT_LOOP_CONFIG) && !("tierCooldownMs" in DEFAULT_LOOP_CONFIG));
}

console.log("Test 10 (killed/failed results still clean up guard state):");
{
  const s = new LoopSupervisor({ enabled: true, maxSpawnDepth: 1, dedupeCrossAgent: true });
  let dups = 0;
  s.setOnAlert(a => { if (a.type === "cross_agent_duplicate") dups++; });
  s.registerSpawn("t2a", "t2");
  check("active before", s.getState().tiers.t2.activeAgents === 1);
  check("spawn chain blocks at depth 1", !s.canSpawn("t2", "t2a").allowed);
  s.processResult(makeResult("t2a", "t2", CONTRACT + "partial", "killed"));
  check("killed agent removed from active", s.getState().tiers.t2.activeAgents === 0, s.getState().tiers.t2.activeAgents);
  check("spawn chain cleaned", s.canSpawn("t2", "t2a").allowed);
  check("killed result is not redundant work", dups === 0, dups);
}

console.log("Test 11 (boundary inputs are safe):");
{
  const s = new LoopSupervisor({ enabled: true, turnLimitEnabled: true, maxAgentTurns: 5, turnLimitGrace: 0, dedupeCrossAgent: true });
  let threw = false;
  try {
    s.processResult({ agentId: "x", tier: "t2", status: "done" } as any);       // no output/usage
    s.processResult({ agentId: "y", tier: "t2", status: "done", output: null, usage: null } as any);
  } catch { threw = true; }
  check("missing output/usage tolerated", !threw);
  check("negative turns no kill", s.checkTurnLimit("a", "t2", -1) === false);
  check("NaN turns no kill", s.checkTurnLimit("a", "t2", NaN) === false);
  check("Infinity turns counted (kill)", s.checkTurnLimit("a", "t2", Infinity) === true);
  check("unknown parent spawn allowed", s.canSpawn("t2", "nope").allowed);
  const empty = new LoopSupervisor({ enabled: true, dedupeCrossAgent: true });
  empty.processResult(makeResult("only", "t2", CONTRACT + "solo"));
  check("no cross-agent alert with a single agent", empty.getState().tiers.t2.crossDuplicates === 0);
}

console.log("Test 12 (turn limit is opt-in and configurable):");
{
  // Default: OFF. Even a runaway turn count produces no alert and no kill.
  const off = new LoopSupervisor({ enabled: true });
  let offAlerts = 0;
  off.setOnAlert(() => { offAlerts++; });
  off.registerSpawn("t2a", "t2");
  check("disabled by default: no kill at 999 turns", off.checkTurnLimit("t2a", "t2", 999) === false);
  check("disabled by default: no alert", offAlerts === 0, offAlerts);

  // Enabled: warning fires at the configured turn count, kill at +grace.
  const on = new LoopSupervisor({ enabled: true, turnLimitEnabled: true, maxAgentTurns: 10, turnLimitGrace: 2 });
  const kinds: string[] = [];
  on.setOnAlert(a => kinds.push(a.type));
  on.registerSpawn("t2a", "t2");
  check("at 10 turns: no kill", on.checkTurnLimit("t2a", "t2", 10) === false);
  check("at 11 turns: warn, no kill", on.checkTurnLimit("t2a", "t2", 11) === false);
  check("warning emitted once", kinds.filter(k => k === "turn_limit").length === 1, kinds);
  check("at 13 turns: hard kill (10+2+1)", on.checkTurnLimit("t2a", "t2", 13) === true);

  // Runtime toggle: turning it off disarms an enabled guard immediately.
  on.updateConfig({ turnLimitEnabled: false });
  on.registerSpawn("t2b", "t2");
  check("disabled at runtime: no kill", on.checkTurnLimit("t2b", "t2", 999) === false);
  // and turning it back on works with the configured turns.
  on.updateConfig({ turnLimitEnabled: true });
  on.registerSpawn("t2c", "t2");
  check("re-enabled at runtime: respects configured turns", on.checkTurnLimit("t2c", "t2", 12) === false && on.checkTurnLimit("t2c", "t2", 13) === true);
}

// ── Test: agent clock stops on stop, resumes on resume ─────
{
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const mk = (over: Partial<AgentInstance>): AgentInstance => ({
    id: "t2a", tier: "t2", task: "t", status: "running", startedAt: Date.now(),
    controller: new AbortController(), output: "", stderr: "", log: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    ...over,
  } as AgentInstance);
  const elapsed = (a: AgentInstance) => (Date.now() - a.startedAt) - agentIdleMs(a);

  console.log("Test (agent clock stops on stop, resumes on resume):");
  const a = mk({});
  check("active agent has zero idle", agentIdleMs(a) === 0);

  // Active for ~50ms, then finish: clock must freeze.
  await sleep(50);
  const activeMs = Date.now() - a.startedAt;
  setAgentStatus(a, "done");
  const e1 = elapsed(a);
  await sleep(40);
  const e2 = elapsed(a);
  check("done agent clock is frozen", Math.abs(e2 - e1) < 15, { e1, e2 });
  check("done agent elapsed ~= its active time", e1 >= activeMs - 20 && e1 <= activeMs + 20, { e1, activeMs });

  // Resume: clock continues from where it stopped (no jump backwards) and ticks again.
  setAgentStatus(a, "running");
  check("resume clears the frozen interval", a.idleSince === undefined);
  const e3 = elapsed(a);
  check("resume does not jump the clock backwards", e3 >= e1 - 15, { e1, e3 });
  await sleep(40);
  const e4 = elapsed(a);
  check("clock ticks again after resume", e4 > e3, { e3, e4 });

  // A second stop/resume cycle adds more idle (total idle keeps growing).
  const idleBefore = a.idleMs || 0;
  setAgentStatus(a, "error");
  await sleep(30);
  setAgentStatus(a, "running");
  check("second stop/resume adds idle", (a.idleMs || 0) > idleBefore, { idleBefore, idleMs: a.idleMs });

  // Terminal -> terminal does not double-count or reset idle.
  const t = mk({});
  setAgentStatus(t, "done");
  const ti = agentIdleMs(t);
  setAgentStatus(t, "killed");
  check("terminal->terminal keeps accumulating idle", agentIdleMs(t) >= ti && t.idleSince !== undefined);

  // Same-status transition is a no-op.
  const s = mk({});
  setAgentStatus(s, "running");
  check("same status is a no-op", s.idleSince === undefined && (s.idleMs || 0) === 0);
}

// ── turn-limit opt-in cannot be re-enabled by a stale partial push ──
console.log("Turn-limit opt-in / config drift:");
{
  // Mechanism behind the reported symptom: a partial update that omits the flag
  // PRESERVES the previous value, so a skipped "push the whole object" can leave
  // the guard ON while the UI shows OFF. These pin the two invariants the fix
  // relies on.
  const s = new LoopSupervisor({ enabled: true, turnLimitEnabled: true, maxAgentTurns: 20, turnLimitGrace: 15 });
  check("warning fires past the soft limit", s.checkTurnLimit("w", "active", 21) === false);
  check("kill fires past the grace", s.checkTurnLimit("k", "active", 36) === true);
  s.updateConfig({ maxAgentTurns: 20 });
  check("a partial update PRESERVES the flag (documented hazard)", s.getConfig().turnLimitEnabled === true);
  // The fix's choke point, exercised with the REAL supervisor: if someone drops
  // the applyGuardConfig call from a save path, the instance keeps killing while
  // the persisted config says OFF.
  check("applyGuardConfig reports success", applyGuardConfig(s, { enabled: true, maxSpawnDepth: 5, turnLimitEnabled: false, maxAgentTurns: 20, turnLimitGrace: 15, dedupeCrossAgent: false }) === true);
  check("pushing the whole object turns the limit off", s.getConfig().turnLimitEnabled === false);
  check("and then it never warns or kills", s.checkTurnLimit("c", "active", 999) === false);
  check("the push preserves guard state (no silent warning reset)", s.getState().tiers.active.turnWarned >= 1, s.getState().tiers.active.turnWarned);
  check("missing guard config is a safe no-op", applyGuardConfig(s, undefined) === false);
  check("non-object guard config is rejected", applyGuardConfig(s, "nope") === false && applyGuardConfig(s, [1]) === false);
  check("no supervisor is a safe no-op", applyGuardConfig(null, {}) === false);
  check("an empty guard object is rejected (no fake success)", applyGuardConfig(s, {}) === false);

  // Default-deny gate: these FAIL if the gate is a truthiness check (they used to
  // kill with turnLimitEnabled = 1 / "yes").
  const sloppyNum = new LoopSupervisor({ enabled: true, turnLimitEnabled: 1 as any, maxAgentTurns: 20, turnLimitGrace: 15 });
  check("a truthy 1 does NOT enable the limit", sloppyNum.checkTurnLimit("z", "active", 999) === false);
  const sloppyStr = new LoopSupervisor({ enabled: true, turnLimitEnabled: "yes" as any, maxAgentTurns: 20, turnLimitGrace: 15 });
  check('a truthy "yes" does NOT enable the limit', sloppyStr.checkTurnLimit("z", "active", 999) === false);
  const explicit = new LoopSupervisor({ enabled: true, turnLimitEnabled: true, maxAgentTurns: 20, turnLimitGrace: 15 });
  check("an explicit true still does", explicit.checkTurnLimit("z", "active", 36) === true);

  // sanitizeLoopSupervisorConfig always returns the flag explicitly, so a config
  // loaded from disk can never be pushed with the field missing.
  const d = { enabled: true, maxSpawnDepth: 5, turnLimitEnabled: false, maxAgentTurns: 50, turnLimitGrace: 15, dedupeCrossAgent: false };
  const out: any = sanitizeLoopSupervisorConfig({ maxAgentTurns: 20 }, d);
  check("sanitized config always carries turnLimitEnabled", typeof out.turnLimitEnabled === "boolean" && out.turnLimitEnabled === false, out.turnLimitEnabled);
}

// ── /tmg guard must SHOW a live-vs-saved divergence, not hide it ──
console.log("Guard display (live vs saved):");
{
  const off = { enabled: true, maxSpawnDepth: 5, turnLimitEnabled: false, maxAgentTurns: 20, turnLimitGrace: 15, dedupeCrossAgent: false };
  const on = { ...off, turnLimitEnabled: true };
  check("both OFF -> plain OFF", formatGuardTurnLimit(off, off) === "turn limit OFF");
  check("both ON -> the kill bound", formatGuardTurnLimit(on, on) === "turns ≤ 20+15");
  const diverged = formatGuardTurnLimit(on, off);
  check("LIVE ON but saved OFF is reported as live ON", diverged.startsWith("turns ≤ 20+15"));
  check("...and names the saved value", diverged.includes("saved: turn limit OFF"));
  check("...and tells the user how to apply it", diverged.includes("/reload"));
  const reverse = formatGuardTurnLimit(off, on);
  check("LIVE OFF but saved ON is reported as live OFF", reverse.startsWith("turn limit OFF") && reverse.includes("saved: turns ≤ 20+15"));
  check("missing saved config does not crash", formatGuardTurnLimit(on, undefined) === "turns ≤ 20+15");
  check("a partial config falls back to the documented defaults", formatGuardTurnLimit({ turnLimitEnabled: true }, undefined) === "turns ≤ 50+15");
  check("only an explicit true counts as ON in the display too", formatGuardTurnLimit({ turnLimitEnabled: 1 as any }, undefined) === "turn limit OFF");
}

// ── the top-level dedupe flag must be folded into the guard before pushing ──
console.log("Guard push folds the top-level dedupe flag:");
{
  // Legacy file: top-level true, block WITHOUT the key (pre-1.5.0 shape).
  const legacyBlock: any = { enabled: true, maxSpawnDepth: 5, turnLimitEnabled: false, maxAgentTurns: 20, turnLimitGrace: 15 };
  const cfg: any = { loopSupervisor: legacyBlock, dedupeCrossAgent: true };
  const folded = foldDedupeFlagIntoGuard(cfg);
  check("the fold returns the same block (in place)", folded === legacyBlock);
  check("top-level true is written into the block", legacyBlock.dedupeCrossAgent === true);
  const s = new LoopSupervisor({ dedupeCrossAgent: false });
  applyGuardConfig(s, folded);
  check("and the live guard ends up with dedupe ON", s.getConfig().dedupeCrossAgent === true);

  // The opposite direction: top-level OFF must not be overridden by a stale block.
  const staleBlock: any = { ...legacyBlock, dedupeCrossAgent: true };
  foldDedupeFlagIntoGuard({ loopSupervisor: staleBlock, dedupeCrossAgent: false });
  check("top-level false clears a stale block value", staleBlock.dedupeCrossAgent === false);

  check("no guard block -> nothing to push", foldDedupeFlagIntoGuard({ dedupeCrossAgent: true }) === undefined);
  check("a non-object guard block is ignored", foldDedupeFlagIntoGuard({ loopSupervisor: "nope", dedupeCrossAgent: true } as any) === undefined);
}

// ── the guard-config choke point cannot be bypassed ──
// src/index.ts cannot be imported by a unit test, so its wiring is protected
// statically: exactly one place in src/ may push config into the guard. This is
// what makes "add a save path that skips the fold" a CI failure instead of a
// silent divergence of the kind this series kept fixing.
console.log("Guard choke point (static invariant):");
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.join(here, "src");
  const violations: string[] = [];
  let chokeHits = 0;
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith(".ts")) continue;
    const src = fs.readFileSync(path.join(srcDir, f), "utf8");
    src.split("\n").forEach((line, i) => {
      if (!/\.updateConfig\s*\(/.test(line)) return;
      if (/[Mm]odelHealth/.test(line)) return; // the circuit breaker has its own config path
      if (f === "config.ts" && /supervisor\.updateConfig\(/.test(line)) { chokeHits++; return; }
      violations.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  check("no file bypasses applyGuardConfig to push guard config", violations.length === 0, violations);
  check("the choke point exists exactly once in src/config.ts", chokeHits === 1, chokeHits);

  // The choke point must not let junk reach the live guard (type hole found by
  // adversarial QA: it forwarded `unknown` straight into a merge).
  const guarded = new LoopSupervisor({ enabled: true, maxAgentTurns: 20, turnLimitGrace: 15, dedupeCrossAgent: false });
  applyGuardConfig(guarded, { turnLimitEnabled: 1 });
  check("a truthy 1 cannot be pushed into the live config", guarded.getConfig().turnLimitEnabled === false, guarded.getConfig().turnLimitEnabled);
  applyGuardConfig(guarded, { turnLimitEnabled: "yes" });
  check('a string "yes" cannot be pushed either', guarded.getConfig().turnLimitEnabled === false);
  applyGuardConfig(guarded, { maxAgentTurns: "5", turnLimitGrace: undefined, junkKey: 1 });
  check("a string limit is not forwarded (no string concat on the hard kill)", guarded.getConfig().maxAgentTurns === 20, guarded.getConfig().maxAgentTurns);
  check("the grace survives an undefined push", guarded.getConfig().turnLimitGrace === 15);
  check("junk keys are dropped, not merged in", !("junkKey" in guarded.getConfig()));
  check("a valid push still works", applyGuardConfig(guarded, { turnLimitEnabled: true }) === true && guarded.getConfig().turnLimitEnabled === true);
  check("and the gate then enforces it", guarded.checkTurnLimit("g", "active", 36) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
