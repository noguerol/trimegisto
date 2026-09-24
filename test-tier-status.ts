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
  formatSystemPolicyContent,
  frameExtensionContext,
  EXTENSION_CONTEXT_NOTICE,
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

console.log("formatTierStatusLine: the optional detail suffix (t0 principal-only note):");
{
  const line = formatTierStatusLine("Active", { enabled: true, reason: "", model: "main pi model", pausedSeconds: null, maxParallel: null, detail: "principal only — no spawn slots" });
  check("detail renders parenthesised when the cap is absent",
    line === "- Active: ✓ ENABLED [main pi model] (principal only — no spawn slots)", line);
  const composed = formatTierStatusLine("T2", { enabled: true, reason: "", model: "x", pausedSeconds: null, maxParallel: 2, detail: "principal only" });
  check("detail composes after the cap", composed === "- T2: ✓ ENABLED [x] (max 2 parallel) (principal only)", composed);
  check("blank detail renders nothing (backward compatible)",
    formatTierStatusLine("T2", { enabled: true, reason: "", model: "x", pausedSeconds: null, maxParallel: 2, detail: "   " }) === "- T2: ✓ ENABLED [x] (max 2 parallel)");
  check("omitted detail renders nothing",
    formatTierStatusLine("T2", { enabled: true, reason: "", model: "x", pausedSeconds: null, maxParallel: 2 }) === "- T2: ✓ ENABLED [x] (max 2 parallel)");
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

console.log("frameExtensionContext: every injected block declares it is NOT the user's message:");
{
  const out = frameExtensionContext("Active agents (1):\n- t0a [running]: x");
  check("opens with the <trimegisto-context> tag", out.startsWith("<trimegisto-context>"), out.slice(0, 40));
  check("closes with the closing tag", out.trimEnd().endsWith("</trimegisto-context>"));
  check("carries the not-the-user notice", out.includes("This is NOT the user's message and NOT a new request"));
  check("points at where the real request lives", out.includes("The user's request is the message above"));
  check("says it can be ignored when no delegation is needed", out.includes("when the request needs no delegation"));
  check("empty body → empty string (nothing to frame, nothing to inject)", frameExtensionContext("   ") === "");
}

console.log("formatSystemPolicyContent: stable policy for the SYSTEM PROMPT, no live counters:");
{
  const out = formatSystemPolicyContent({
    proactivePolicy: "Prefer a batch when the request decomposes.",
    rules: ["- Rule one", "- Rule two"],
    tierLines: [
      "- Active (t0): ✓ ENABLED [main pi model] (max 4 parallel)",
      "- T2: ✓ ENABLED [deepseek-v4-flash] (max 2 parallel)",
    ],
  });
  check("self-labelled with <trimegisto-policy>", out.startsWith("<trimegisto-policy>") && out.trimEnd().endsWith("</trimegisto-policy>"));
  check("includes the proactive policy", out.includes("Prefer a batch when the request decomposes."));
  check("includes every rule passed in", out.includes("- Rule one") && out.includes("- Rule two"));
  check("includes the tier capacity lines", out.includes("(max 2 parallel)") && out.includes("Active (t0): ✓ ENABLED"));
  check("includes the role hint", out.includes("Roles: active = mass worker; t1 = planning; t2 = reasoning; t3 = mechanical."));
  check("NO imperative first-action phrasing (the tone that read as a hijack)", !/FIRST action MUST/i.test(out));
  check("no live countdown in the stable block (keeps the prompt cache prefix)", !out.includes("paused"));
  check("without a per-run note the block is unchanged", !out.includes("Decomposability check:"));
}

console.log("formatSystemPolicyContent: the per-run decomposability note is optional and additive:");
{
  const out = formatSystemPolicyContent({
    proactivePolicy: "contract",
    rules: ["- Rule one"],
    tierLines: ["- T2: ✓ ENABLED [x] (max 2 parallel)"],
    decomposabilityNote: "Decomposability check: this request reads as multiple independent units (2 files).",
  });
  check("the note is rendered when provided", out.includes("Decomposability check: this request reads as multiple independent units"));
  const without = formatSystemPolicyContent({
    proactivePolicy: "contract",
    rules: ["- Rule one"],
    tierLines: ["- T2: ✓ ENABLED [x] (max 2 parallel)"],
  });
  const stablePrefix = without.replace("</trimegisto-policy>", "");
  check("the note is appended at the TAIL, after every stable line (prompt cache prefix survives a per-run note)",
    out.indexOf("Decomposability check") > out.indexOf("Roles: active") && out.slice(0, stablePrefix.length) === stablePrefix,
    `len ${out.length} vs prefix ${stablePrefix.length}`);
  check("empty note renders nothing", !formatSystemPolicyContent({
    proactivePolicy: "contract",
    rules: ["- Rule one"],
    tierLines: ["- T2: ✓ ENABLED [x] (max 2 parallel)"],
    decomposabilityNote: "   ",
  }).includes("Decomposability check:"));
}

console.log("formatDirectiveContent: per-turn block is framed, short, and only live state:");
{
  const out = formatDirectiveContent({
    activeAgentCount: 2,
    activeAgentsFormatted: "- t0a [running]: task A\n- t2b [running]: task B",
    pausedTierLines: ["- T2: ✓ ENABLED [kimi-k3] ⛔ paused 47s (max 4 parallel)"],
  });
  check("framed as extension context, not a user request", out.startsWith("<trimegisto-context>") && out.includes(EXTENSION_CONTEXT_NOTICE));
  check("shows the active-agents count and list", out.includes("Active agents (2):") && out.includes("- t0a [running]: task A") && out.includes("- t2b [running]: task B"));
  check("surfaces the circuit breaker the stable system prompt omits", out.includes("⛔ paused 47s"));
  check("keeps the manual controls footer", out.includes("Manual controls: /tmg config, /tmg list, /t0, /t1, /t2, /t3, @t2b <instruction>."));
  check("far smaller than the old 2103-char per-turn directive", out.length < 800, out.length);
}

console.log("formatDirectiveContent: an idle orchestrator injects NOTHING:");
{
  check("0 agents + no breaker → empty string",
    formatDirectiveContent({ activeAgentCount: 0, activeAgentsFormatted: "- none", pausedTierLines: [] }) === "");
  check("0 agents but a breaker still reports the breaker",
    formatDirectiveContent({ activeAgentCount: 0, activeAgentsFormatted: "- none", pausedTierLines: ["- T2: ✓ ENABLED [x] ⛔ paused 9s"] }).includes("⛔ paused 9s"));
  check("non-finite count is treated as idle", formatDirectiveContent({ activeAgentCount: NaN, activeAgentsFormatted: "" }) === "");
}

console.log("formatUnavailableTiersMessage: gate rejection includes the same per-tier lines as the policy:");
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
  const policy = formatSystemPolicyContent({ proactivePolicy: "x", rules: ["r"], tierLines: [line] });
  check("the policy block MUST carry the tier capacity", policy.includes("(max 2 parallel)"));
  check("the policy block MUST carry the roles so the right tier is picked per task", policy.includes("Roles: active = mass worker"));
  const status = formatDirectiveContent({ activeAgentCount: 1, activeAgentsFormatted: "- t0a [running]: x" });
  check("any injected status MUST carry the not-the-user notice", status.includes(EXTENSION_CONTEXT_NOTICE));
  const rej = formatUnavailableTiersMessage("t3", [line]);
  check("the gate rejection MUST mirror the tier format", rej.includes("- T2:") && rej.includes("(max 2 parallel)"));
}

console.log("The actual incident: the user channel must never drown the user's request:");
{
  // The real message that got refused, verbatim, 61 chars.
  const userRequest = "pues es que no veo los hints de ayuda en la config de pinball";
  check("the reproduced request is the real length", userRequest.length === 61, userRequest.length);
  check("idle turn: 0 chars injected, so the request is 100% of the user channel",
    formatDirectiveContent({ activeAgentCount: 0, activeAgentsFormatted: "- none" }) === "");
  const busy = formatDirectiveContent({
    activeAgentCount: 3,
    activeAgentsFormatted: "- t0a [running]: a\n- t0b [running]: b\n- t2c [running]: c",
  });
  // Old ratio was 2103:61 ≈ 34:1 and the model refused. Cap the busy turn well below it.
  check("busy turn: boilerplate stays under 12x the user's message", busy.length < userRequest.length * 12, busy.length);
  check("busy turn: still framed, so origin is never ambiguous", busy.includes(EXTENSION_CONTEXT_NOTICE));
}

console.log("Idempotence: an unchanged turn must be detectable as unchanged by the caller:");
{
  const a = formatDirectiveContent({ activeAgentCount: 1, activeAgentsFormatted: "- t0a [running]: x" });
  const b = formatDirectiveContent({ activeAgentCount: 1, activeAgentsFormatted: "- t0a [running]: x" });
  check("same inputs → byte-identical output (so === dedupe works)", a === b);
  const c = formatDirectiveContent({ activeAgentCount: 2, activeAgentsFormatted: "- t0a [running]: x\n- t0b [running]: y" });
  check("changed inputs → different output (so the dedupe does not swallow updates)", a !== c);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
