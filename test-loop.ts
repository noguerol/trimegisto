// Functional test for the per-agent loop detection fix.
// Run: node --experimental-strip-types test-loop.ts
import { LoopSupervisor, DEFAULT_LOOP_CONFIG } from "./src/loop-supervisor.ts";

// --- Shared "common material": a contract excerpt that agents keep citing ---
const CONTRACT = `Clause 12.1 - Prestation terms. The contractor shall provide the services described in Annex A
for a total consideration of EUR 240,000 payable in four equal instalments. Any delay in payment
shall accrue interest at the statutory rate. The parties agree that force majeure events including
but not limited to natural disasters, pandemics, and governmental action shall suspend performance
obligations for the duration of the event. Compliance with the pact compensation rules is a
condition precedent to any claim for damages arising out of or in connection with this agreement.
Ancillary obligations include confidentiality, non-solicitation, and the duty to maintain adequate
insurance coverage throughout the term. Disputes shall be resolved by arbitration in accordance
with the rules of the Chamber of Commerce. `;

const sig = (n: string) => `${CONTRACT}${CONTRACT.slice(0, 1800)}${n}`;

function makeResult(agentId: string, tier: "t1" | "t2" | "t3", output: string, status: "done" | "error" = "done", stderr = "") {
  return {
    agentId, tier, task: "analyze contract",
    status, output, stderr,
    usage: { turns: 1, input: 0, output: 0, cost: 0 },
    log: [],
  } as any;
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`); }
}

// ── Test 1: 3 DIFFERENT t2 agents, shared contract material, different progress
//    (this is the exact false positive from the user's log — must NOT strike)
{
  const s = new LoopSupervisor({ enabled: true });
  let strikes = 0;
  s.setOnAlert((a) => { if (a.strike > strikes) strikes = a.strike; });
  const r1 = s.processResult(makeResult("t2a", "t2", sig("Deciding to exclude concrete prestation terms")));
  const r2 = s.processResult(makeResult("t2b", "t2", sig("Assessing compliance pact compensation risks")));
  const r3 = s.processResult(makeResult("t2c", "t2", sig("Designing optional ancillary obligations clause")));
  console.log("Test 1 (3 agents, common material):");
  check("no loop detected for any agent", !r1.loopDetected && !r2.loopDetected && !r3.loopDetected);
  check("zero strikes accumulated", strikes === 0);
  const st = s.getState().tiers.t2;
  check("t2 not in cooldown", st.cooldownRemaining === 0 && st.strikes === 0);
}

// ── Test 2: SAME agent repeating identical output 3x (real loop — must strike)
{
  const s = new LoopSupervisor({ enabled: true });
  let strikes = 0;
  s.setOnAlert((a) => { if (a.strike > strikes) strikes = a.strike; });
  const out = sig("The answer is the same every time. Final answer: exclude clause 12.1 entirely.");
  s.processResult(makeResult("t2a", "t2", out));
  s.processResult(makeResult("t2a", "t2", out));
  const r3 = s.processResult(makeResult("t2a", "t2", out));
  console.log("Test 2 (same agent, identical output x3):");
  check("loop detected on 3rd result", r3.loopDetected);
  check("strike count = 1", r3.strike === 1);
  check("alert emitted", strikes === 1);
}

// ── Test 3: same agent, output ~85% common material but different conclusion
//    (legitimate progress — must NOT strike)
{
  const s = new LoopSupervisor({ enabled: true });
  const base = CONTRACT;
  const o1 = base + " Step one: identify the parties and the payment schedule. Step two: verify force majeure scope.";
  const o2 = base + " Step one: identify the parties and the payment schedule. Step two: analyze the arbitration clause.";
  const o3 = base + " Step one: identify the parties and the payment schedule. Step two: draft the waiver provision.";
  const r3 = s.processResult(makeResult("t2a", "t2", o1));
  const r4 = s.processResult(makeResult("t2a", "t2", o2));
  const r5 = s.processResult(makeResult("t2a", "t2", o3));
  console.log("Test 3 (same agent, shared material, real progress):");
  check("no loop detected", !r3.loopDetected && !r4.loopDetected && !r5.loopDetected);
  check("no strikes", s.getState().tiers.t2.strikes === 0);
}

// ── Test 4: same agent, nearly-identical outputs with tiny variation
//    (genuine loop behavior — should strike)
{
  const s = new LoopSupervisor({ enabled: true });
  const o = sig("Final: everything is correct as written. No changes needed. Sign as-is.");
  const o2 = o.slice(0, o.length - 3) + "…."; // ~99.9% identical
  s.processResult(makeResult("t2a", "t2", o));
  s.processResult(makeResult("t2a", "t2", o2));
  const r3 = s.processResult(makeResult("t2a", "t2", o));
  console.log("Test 4 (same agent, ~identical outputs x3):");
  check("loop detected", r3.loopDetected);
}

// ── Test 5: interleaved agents must not accumulate strikes
{
  const s = new LoopSupervisor({ enabled: true });
  const o = "repeated output content that is exactly the same string every time";
  s.processResult(makeResult("t2a", "t2", o));
  s.processResult(makeResult("t2b", "t2", "different output from a different agent working on its own thing"));
  s.processResult(makeResult("t2a", "t2", o));
  s.processResult(makeResult("t2b", "t2", "different again, some other legit work"));
  const r5 = s.processResult(makeResult("t2a", "t2", o));
  console.log("Test 5 (interleaved same-agent repeats):");
  check("no loop despite 3 repeats non-consecutive", !r5.loopDetected);
  check("no strikes", s.getState().tiers.t2.strikes === 0);
}

// ── Test 6: error pattern, same agent 3x consecutive (real)
{
  const s = new LoopSupervisor({ enabled: true });
  s.processResult(makeResult("t2a", "t2", "", "error", "Error: cannot parse clause 14 at line 42"));
  s.processResult(makeResult("t2a", "t2", "", "error", "Error: cannot parse clause 14 at line 42"));
  const r3 = s.processResult(makeResult("t2a", "t2", "", "error", "Error: cannot parse clause 14 at line 42"));
  console.log("Test 6 (same agent, same error x3):");
  check("loop detected via error pattern", r3.loopDetected);
}

// ── Test 7: different agents, same error each (common infra error — must NOT strike)
{
  const s = new LoopSupervisor({ enabled: true });
  s.processResult(makeResult("t2a", "t2", "", "error", "Error: model overloaded, retry later"));
  s.processResult(makeResult("t2b", "t2", "", "error", "Error: model overloaded, retry later"));
  const r3 = s.processResult(makeResult("t2c", "t2", "", "error", "Error: model overloaded, retry later"));
  console.log("Test 7 (3 agents, same infra error):");
  check("no loop detected", !r3.loopDetected);
}

// ── Test 8: full escalation — consecutive identical outputs → strikes 1..3 → cooldown
// Sliding window: 3rd identical output = strike 1, each further one escalates.
{
  const s = new LoopSupervisor({ enabled: true });
  const strikes: number[] = [];
  s.setOnAlert((a) => strikes.push(a.strike));
  const o = "I have examined this and the answer remains: reject the clause. Reject it again. Same reasoning.";
  const r1 = s.processResult(makeResult("t2a", "t2", o));
  const r2 = s.processResult(makeResult("t2a", "t2", o));
  const r3 = s.processResult(makeResult("t2a", "t2", o));   // strike 1
  const r4 = s.processResult(makeResult("t2a", "t2", o));   // strike 2
  const r5 = s.processResult(makeResult("t2a", "t2", o));   // strike 3
  console.log("Test 8 (full escalation to cooldown):");
  check("strikes escalate 1,2,3", r3.strike === 1 && r4.strike === 2 && r5.strike === 3);
  check("no strikes before 3rd output", r1.strike === 0 && r2.strike === 0);
  check("tier in cooldown after strike 3", s.getState().tiers.t2.cooldownRemaining > 0);
  check("canSpawn blocked during cooldown", !s.canSpawn("t2").allowed);
  check("strike_three alert emitted", strikes.includes(3));
}

// ── Test 9: short outputs (acks/status) are never flagged ──
{
  const s = new LoopSupervisor({ enabled: true });
  const r = s.processResult(makeResult("t2a", "t2", "done"));
  check("short output not flagged", !r.loopDetected);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
