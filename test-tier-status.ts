/**
 * Trimegisto - tier-status formatter tests
 *
 * Run: node --experimental-strip-types test-tier-status.ts
 *
 * Covers the pure helpers in src/tier-status.ts that assemble the per-tier
 * lines used by the tool description, the per-turn directive and the gate
 * rejection message. These are the messages that reach the coordinator LLM
 * — if any of them drift, the coordinator spawns the wrong tier or the
 * wrong number of agents and bounces off the gate.
 */

import {
  formatTierStatusLine,
  joinTierStatusLines,
  formatDirectiveContent,
  formatUnavailableTiersMessage,
} from "./src/tier-status.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

console.log("formatTierStatusLine: the basic shapes:");
{
  check("enabled line marks with ✓ ENABLED and includes the model",
    formatTierStatusLine("T2", { enabled: true, reason: "", model: "deepseek-v4-flash", pausedSeconds: null, maxParallel: 4 })
      === "- T2: ✓ ENABLED [deepseek-v4-flash] (max 4 parallel)");
  check("disabled line marks with ✗ unavailable and includes the reason",
    formatTierStatusLine("T1", { enabled: false, reason: " (no model)", model: "no model", pausedSeconds: null, maxParallel: 4 })
      === "- T1: ✗ unavailable (no model) [no model] (max 4 parallel)");
  check("active tier renders Active (t0) when label is set that way",
    formatTierStatusLine("Active (t0)", { enabled: true, reason: "", model: "main pi model", pausedSeconds: null, maxParallel: 4 })
      === "- Active (t0): ✓ ENABLED [main pi model] (max 4 parallel)");
}

console.log("formatTierStatusLine: parallel cap is the only signal the coordinator has for slot count:");
{
  // This is THE regression case from the user: t2 with maxParallel=2 must be
  // visible in the message so the coordinator does not try to spawn 6.
  const line = formatTierStatusLine("T2", { enabled: true, reason: "", model: "deepseek-v4-flash", pausedSeconds: null, maxParallel: 2 });
  check("t2 with 2 slots shows 'max 2 parallel'", line.includes("max 2 parallel"), line);
  check("t2 with 2 slots does NOT show 6 or any larger cap", !/(max [3-9]|max [1-9]\d)/.test(line), line);
}

console.log("formatTierStatusLine: paused / max-parallel compose without dropping info:");
{
  const line = formatTierStatusLine("T2", { enabled: true, reason: "", model: "kimi-k3", pausedSeconds: 47, maxParallel: 4 });
  check("paused line includes the cooldown AND the cap", line === "- T2: ✓ ENABLED [kimi-k3] \u26d4 paused 47s (max 4 parallel)", line);
}

console.log("formatTierStatusLine: null/undefined values are omitted cleanly:");
{
  check("no cap when maxParallel is null", formatTierStatusLine("T2", { enabled: true, reason: "", model: "x", pausedSeconds: null, maxParallel: null }) === "- T2: ✓ ENABLED [x]");
  check("no pause when pausedSeconds is null", formatTierStatusLine("T2", { enabled: true, reason: "", model: "x", pausedSeconds: null, maxParallel: 4 }) === "- T2: ✓ ENABLED [x] (max 4 parallel)");
  check("no reason when enabled (even if reason is non-empty)",
    formatTierStatusLine("T2", { enabled: true, reason: " (orphan text)", model: "x", pausedSeconds: null, maxParallel: 4 }) === "- T2: ✓ ENABLED [x] (max 4 parallel)");
}

console.log("joinTierStatusLines: empty / single / multiple:");
{
  check("empty array → empty string", joinTierStatusLines([]) === "");
  check("single line is unchanged", joinTierStatusLines(["- T2: ✓ ENABLED [x]"]) === "- T2: ✓ ENABLED [x]");
  check("two lines joined with newline", joinTierStatusLines(["- T2: ✓ ENABLED [x]", "- T3: ✗ unavailable (no model) [no model]"]) === "- T2: ✓ ENABLED [x]\n- T3: ✗ unavailable (no model) [no model]");
  check("filters out empty lines (defensive)", joinTierStatusLines(["- T2: ✓ ENABLED [x]", "", "  "]) === "- T2: ✓ ENABLED [x]");
}

console.log("formatDirectiveContent: the coordinator sees the live tier picture AND active agents AND controls:");
{
  const out = formatDirectiveContent({
    proactivePolicy: "TRIMEGISTO ACTIVE. First check for 2+ subtasks.",
    tierLines: [
      "- Active (t0): ✓ ENABLED [main pi model] (max 4 parallel)",
      "- T1: ✗ unavailable (no model) [no model] (max 4 parallel)",
      "- T2: ✓ ENABLED [deepseek-v4-flash] (max 2 parallel)",
      "- T3: ✗ unavailable (no model) [no model] (max 4 parallel)",
    ],
    activeAgentCount: 2,
    activeAgentsFormatted: "- t0a [running]: task A\n- t2b [running]: task B",
  });
  check("includes the proactive policy verbatim", out.startsWith("TRIMEGISTO ACTIVE. First check for 2+ subtasks."));
  check("includes the live tier header", out.includes("Tiers now (live from /tmg config):"));
  check("includes all 4 tier lines", out.includes("Active (t0): ✓ ENABLED") && out.includes("T1: ✗ unavailable") && out.includes("T2: ✓ ENABLED") && out.includes("T3: ✗ unavailable"));
  check("shows the parallel cap (max 2 parallel) so the coordinator caps the batch", out.includes("(max 2 parallel)"));
  check("includes the spawn rule", out.includes("Spawn ONLY \u2713 ENABLED tiers and respect per-tier max parallel"));
  check("includes the role hint", out.includes("Roles: active=mass worker; t1=planning; t2=reasoning; t3=mechanical."));
  check("includes the active-agents count and list", out.includes("Active agents (2):") && out.includes("- t0a [running]: task A") && out.includes("- t2b [running]: task B"));
  check("includes the manual controls footer", out.includes("Manual controls: /tmg config, /tmg list, /t0, /t1, /t2, /t3, @t2b <instruction>."));
}

console.log("formatDirectiveContent: with no active agents, the list shows '- none' and count is 0:");
{
  const out = formatDirectiveContent({
    proactivePolicy: "TRIMEGISTO ACTIVE.",
    tierLines: ["- Active (t0): \u2713 ENABLED [main pi model] (max 4 parallel)"],
    activeAgentCount: 0,
    activeAgentsFormatted: "- none",
  });
  check("count of 0 + '- none' marker", out.includes("Active agents (0):\n- none"));
}

console.log("formatUnavailableTiersMessage: gate rejection includes the same per-tier lines as the directive:");
{
  const out = formatUnavailableTiersMessage("active, t1", [
    "- Active (t0): ✗ unavailable (disabled) [no active model]",
    "- T2: ✓ ENABLED [deepseek-v4-flash] (max 2 parallel)",
  ]);
  check("rejection message names the bad tier(s)", out.includes("Cannot spawn tier(s): active, t1"));
  check("rejection explains the failure", out.includes("not available right now (disabled or no model configured)"));
  check("rejection includes the live tier list (so a retry knows what IS available)", out.includes("Tiers now:") && out.includes("- T2: ✓ ENABLED [deepseek-v4-flash] (max 2 parallel)"));
  check("rejection ends with the config hint", out.trimEnd().endsWith("Configure with /tmg config."));
}

console.log("Format invariants the regression depends on (so a 'fix' can't silently remove them):");
{
  // If any of these keywords disappear the bug returns: the coordinator
  // stops seeing per-tier parallel capacity, the disabled reason, or the
  // spawn rule. Each is unit-tested.
  const line = formatTierStatusLine("T2", { enabled: true, reason: "", model: "x", pausedSeconds: null, maxParallel: 2 });
  check("'max N parallel' substring is mandatory in any enabled line", line.includes("max 2 parallel"));
  const dir = formatDirectiveContent({
    proactivePolicy: "x", tierLines: [line], activeAgentCount: 0, activeAgentsFormatted: "- none",
  });
  check("'Spawn ONLY \u2713 ENABLED tiers' is mandatory in any directive", dir.includes("Spawn ONLY \u2713 ENABLED tiers"));
  check("'Roles: active=mass worker' is mandatory so the coordinator picks the right tier per task", dir.includes("Roles: active=mass worker"));
  check("the 'live from /tmg config' header is mandatory so stale directives are obviously stale", dir.includes("Tiers now (live from /tmg config):"));
  const rej = formatUnavailableTiersMessage("t3", [line]);
  check("the gate rejection MUST mirror the directive's tier format", rej.includes("- T2:") && rej.includes("(max 2 parallel)"));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
