/**
 * Trimegisto - Model health (circuit breaker) tests
 *
 * Run: node --experimental-strip-types test-model-health.ts
 *
 * Covers the failure classifier and the per-model breaker that stops an
 * uncontrolled spawn storm when a provider/model starts failing (e.g. HTTP
 * 400 invalid_request_error): spawns are refused during a cooldown that
 * doubles on repeated trips, and a success (or model change) clears it.
 */

import {
  ModelHealth,
  classifyModelFailure,
  modelKey,
  sanitizeModelHealthConfig,
  MODEL_HEALTH_DEFAULTS,
} from "./src/model-health.ts";
import {
  setModelHealth,
  selectAvailableModel,
  canSpawnPooled,
  getTierModelBlock,
  formatModelBlockMessage,
  tierModelCandidates,
  processSpawnRequests,
  getAgents,
  setInstanceDir,
} from "./src/agent-manager.ts";
import { writeSpawnRequest } from "./src/ipc.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TierConfig } from "./src/types.ts";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`);
  }
}

function tierConfig(model: string, redundantModels: string[] = []): TierConfig {
  return {
    enabled: true,
    model,
    systemPrompt: "",
    maxParallel: 4,
    compactionThreshold: 0,
    tools: [],
    extraArgs: [],
    redundantModels,
  };
}

// ── Test 1: failure classifier ─────────────────────────────
console.log("Test 1 (classifyModelFailure):");
{
  const provider400 = classifyModelFailure({
    status: "error",
    turns: 0,
    output: "",
    stderr: '400: {"code":null,"message":"The request contains invalid parameters...","type":"invalid_request_error"}',
    stopReason: "exit:1",
  });
  check("400 + no work -> model-level provider", provider400.modelLevel && provider400.kind === "provider", provider400);

  const withWork = classifyModelFailure({
    status: "error",
    turns: 2,
    output: "did some work",
    stderr: "400 invalid_request_error",
  });
  check("400 but model produced work -> NOT model-level", !withWork.modelLevel, withWork);

  const providerMidRun = classifyModelFailure({
    status: "error",
    turns: 3,
    output: "",
    stderr: '500: {"message":"internal server error"}',
  });
  check("provider error with turns but no answer text -> model-level", providerMidRun.modelLevel, providerMidRun);

  const cmdNotFound = classifyModelFailure({
    status: "error",
    turns: 2,
    output: "",
    stderr: "bash: foo: command not found",
  });
  check("shell 'command not found' -> NOT model-level", !cmdNotFound.modelLevel, cmdNotFound);

  const done = classifyModelFailure({ status: "done", turns: 3, output: "ok", stderr: "" });
  check("done -> not model-level", !done.modelLevel);

  const doneNoop = classifyModelFailure({ status: "done", turns: 0, output: "", stderr: "", stopReason: "" });
  check("done with zero turns/no output -> provider no-op", doneNoop.modelLevel, doneNoop);

  const doneToolOnly = classifyModelFailure({ status: "done", turns: 2, output: "", stderr: "", stopReason: "stop" });
  check("done tool-only (no text) -> NOT model-level", !doneToolOnly.modelLevel, doneToolOnly);

  const doneAborted = classifyModelFailure({ status: "done", turns: 2, output: "", stderr: "", stopReason: "error" });
  check("done but stopped with error -> model-level", doneAborted.modelLevel, doneAborted);

  const timeout = classifyModelFailure({
    status: "error", turns: 0, output: "", stderr: "⏱ No first response", stopReason: "first_response_timeout",
  });
  check("first-response timeout -> model-level timeout", timeout.modelLevel && timeout.kind === "timeout", timeout);

  const idle = classifyModelFailure({
    status: "error", turns: 0, output: "", stderr: "", stopReason: "idle_timeout",
  });
  check("idle timeout -> model-level timeout", idle.modelLevel && idle.kind === "timeout");

  const spawn = classifyModelFailure({
    status: "error", turns: 0, output: "", stderr: "spawn ENOENT", stopReason: "spawn_error",
  });
  check("spawn error -> model-level spawn", spawn.modelLevel && spawn.kind === "spawn", spawn);

  const taskFail = classifyModelFailure({
    status: "error", turns: 4, output: "partial", stderr: "compilation failed",
  });
  check("task failure after work -> NOT model-level", !taskFail.modelLevel, taskFail);

  check("empty model key -> (pi default)", modelKey("") === "(pi default)" && modelKey(undefined) === "(pi default)");
  check("model key trimmed", modelKey("  foo/bar ") === "foo/bar");
}

// ── Test 2: breaker lifecycle with a fake clock ────────────
console.log("Test 2 (breaker lifecycle):");
{
  let t = 1_000_000;
  const mh = new ModelHealth({ enabled: true, failureThreshold: 2, cooldownSeconds: 60, maxCooldownSeconds: 600 }, () => t);
  const trips: number[] = [];
  mh.setOnTrip((_e, info) => trips.push(info.remainingMs));

  check("healthy model not blocked", !mh.isBlocked("m"));
  check("first failure: no block", mh.recordFailure("m", "provider", "400") === null && !mh.isBlocked("m"));
  check("second failure: opens", !!mh.recordFailure("m", "provider", "400"));
  check("blocked after threshold", mh.isBlocked("m"));
  check("cooldown is base 60s", mh.cooldownRemainingMs("m") === 60_000, mh.cooldownRemainingMs("m"));
  check("onTrip fired once", trips.length === 1 && trips[0] === 60_000, trips);

  // Failures while already blocked must not inflate the backoff.
  mh.recordFailure("m", "provider", "400");
  check("in-flight failure keeps cooldown unchanged", mh.cooldownRemainingMs("m") === 60_000, mh.cooldownRemainingMs("m"));

  // Half-open: after the cooldown the next attempt is allowed.
  t += 60_001;
  check("available after cooldown", !mh.isBlocked("m"));

  // Probe fails -> re-open with doubled backoff.
  mh.recordFailure("m", "provider", "400 again");
  check("half-open probe failure re-opens", mh.isBlocked("m"));
  check("backoff doubled to 120s", mh.cooldownRemainingMs("m") === 120_000, mh.cooldownRemainingMs("m"));

  t += 120_001;
  mh.recordFailure("m", "provider", "x");
  check("backoff tripled-cycle -> 240s", mh.cooldownRemainingMs("m") === 240_000, mh.cooldownRemainingMs("m"));

  // A success clears everything.
  const before = mh.list()[0];
  check("trips counted", before.trips === 3, before.trips);
  mh.recordSuccess("m");
  check("success clears block", !mh.isBlocked("m"));
  check("success resets failures", mh.list()[0].failures === 0, mh.list()[0].failures);
}

// ── Test 3: backoff cap + threshold 1 + disable + clear ────
console.log("Test 3 (cap, threshold 1, disable, clear):");
{
  let t = 0;
  const mh = new ModelHealth({ enabled: true, failureThreshold: 1, cooldownSeconds: 100, maxCooldownSeconds: 250 }, () => t);
  mh.recordFailure("m", "provider", "x");
  check("threshold 1 opens on first failure", mh.cooldownRemainingMs("m") === 100_000);
  t += 100_001; mh.recordFailure("m", "provider", "x");
  check("second trip = 200s", mh.cooldownRemainingMs("m") === 200_000);
  t += 200_001; mh.recordFailure("m", "provider", "x");
  check("cap at 250s", mh.cooldownRemainingMs("m") === 250_000);
  t += 250_001; mh.recordFailure("m", "provider", "x");
  check("stays capped at 250s", mh.cooldownRemainingMs("m") === 250_000);

  check("clear(model) unblocks", mh.clear("m") === 1 && !mh.isBlocked("m"));
  mh.recordFailure("a", "provider", "x");
  mh.recordFailure("b", "provider", "x");
  check("clear() clears all", mh.clear() === 2 && mh.list().length === 0);

  const off = new ModelHealth({ enabled: false }, () => t);
  off.recordFailure("m", "provider", "x");
  check("disabled: no entry / not blocked", !off.isBlocked("m") && off.list().length === 0);
}

// ── Test 4: config sanitizer ───────────────────────────────
console.log("Test 4 (sanitizeModelHealthConfig):");
{
  const d = sanitizeModelHealthConfig(undefined);
  check("undefined -> defaults", d.enabled === true && d.failureThreshold === 2 && d.cooldownSeconds === 60 && d.maxCooldownSeconds === 600);

  const s = sanitizeModelHealthConfig({
    enabled: "yes", failureThreshold: 99, cooldownSeconds: -5, maxCooldownSeconds: 10 ** 9,
  } as any);
  check("bad enabled falls back", s.enabled === MODEL_HEALTH_DEFAULTS.enabled);
  check("threshold clamped to <=10", s.failureThreshold === 10, s.failureThreshold);
  check("bad cooldown falls back", s.cooldownSeconds === MODEL_HEALTH_DEFAULTS.cooldownSeconds, s.cooldownSeconds);
  check("max cooldown clamped to 1 day", s.maxCooldownSeconds === 86_400, s.maxCooldownSeconds);

  const clamp = sanitizeModelHealthConfig({ failureThreshold: 0, cooldownSeconds: 999, maxCooldownSeconds: 120 } as any);
  check("threshold at least 1", clamp.failureThreshold === 1);
  check("cooldown clamped to max", clamp.cooldownSeconds === 120, clamp.cooldownSeconds);
}

// ── Test 5: spawn-path integration ─────────────────────────
console.log("Test 5 (spawn-path integration):");
{
  let t = 0;
  const mh = new ModelHealth({ enabled: true, failureThreshold: 2, cooldownSeconds: 60, maxCooldownSeconds: 600 }, () => t);
  setModelHealth(mh);

  const single = tierConfig("broken/model");
  check("tier spawns before any failure", canSpawnPooled("t2", single, false));

  mh.recordFailure("broken/model", "provider", "400 invalid_request_error");
  mh.recordFailure("broken/model", "provider", "400 invalid_request_error");

  check("blocked single-model tier cannot spawn", !canSpawnPooled("t2", single, false));
  const block = getTierModelBlock("t2", single, false);
  check("getTierModelBlock reports the pause", !!block && block.model === "broken/model");
  const msg = formatModelBlockMessage(block!, "T2");
  check("message names model + retry + fix hint", msg.includes("broken/model") && /Retry in ~\d+s/.test(msg) && msg.includes("/tmg config"));

  // Pooled tier with one healthy redundant model keeps working.
  const pooled = tierConfig("broken/model", ["healthy/model"]);
  check("pooled tier can use the healthy model", canSpawnPooled("t2", pooled, true));
  check("no tier-level block when a candidate is healthy", getTierModelBlock("t2", pooled, true) === null);
  check("selectAvailableModel skips the blocked model", selectAvailableModel("t2", ["broken/model", "healthy/model"], 4) === "healthy/model");

  // All candidates blocked -> tier blocked, model candidates exposed.
  mh.recordFailure("healthy/model", "provider", "x");
  mh.recordFailure("healthy/model", "provider", "x");
  check("all candidates blocked -> cannot spawn", !canSpawnPooled("t2", pooled, true));
  check("tierModelCandidates lists both", tierModelCandidates("t2", pooled, true).length === 2);
  const allBlocked = getTierModelBlock("t2", pooled, true);
  check("block reported when all are paused", !!allBlocked);

  // A success on one model reopens that candidate.
  mh.recordSuccess("healthy/model");
  check("success unblocks just that model", canSpawnPooled("t2", pooled, true) && getTierModelBlock("t2", pooled, true) === null);

  // Clearing re-enables everything.
  mh.clear();
  check("clear restores spawning", canSpawnPooled("t2", single, false) && getTierModelBlock("t2", single, false) === null);

  setModelHealth(null);
}

// ── Test 6: active-tier override + runtime config changes ──
console.log("Test 6 (active override, runtime config, state safety):");
{
  let t = 0;
  const mh = new ModelHealth({ enabled: true, failureThreshold: 1, cooldownSeconds: 30 }, () => t);
  setModelHealth(mh);

  // The ACTIVE tier's model is not in tierConfig.model; it comes from the pi
  // session. canSpawnPooled must honor the override or it would wrongly report
  // a paused active tier as spawnable.
  const active = tierConfig("");
  mh.recordFailure("deepseek/x", "provider", "400");
  check("active tier blocked with override", !canSpawnPooled("active", active, false, undefined, "deepseek/x"));
  check("getTierModelBlock agrees with the override", !!getTierModelBlock("active", active, false, "deepseek/x"));
  check("active tier not blocked for a different model", canSpawnPooled("active", active, false, undefined, "other/model"));

  // Disabling the breaker unblocks immediately; the window survives re-enable.
  mh.updateConfig({ enabled: false });
  check("disable unblocks", !mh.isBlocked("deepseek/x"));
  mh.updateConfig({ enabled: true });
  check("re-enable restores open window", mh.isBlocked("deepseek/x"));

  // list() returns defensive copies (no internal mutation through the snapshot).
  const snap = mh.list();
  snap[0].tiers.push("t3" as any);
  snap[0].model = "hacked";
  check("list snapshot is a copy", mh.list()[0].model === "deepseek/x" && !mh.list()[0].tiers.includes("t3" as any));

  // A success fully resets the backoff so the next trip starts at base again.
  mh.recordSuccess("deepseek/x");
  mh.recordFailure("deepseek/x", "provider", "x");
  check("success resets backoff", mh.cooldownRemainingMs("deepseek/x") === 30_000, mh.cooldownRemainingMs("deepseek/x"));

  setModelHealth(null);
}

// ── Test 7: IPC spawn path refuses while paused ────────────
console.log("Test 7 (IPC processSpawnRequests gate):");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-qa-"));
  try {
    setInstanceDir(dir);
    let t = 0;
    const mh = new ModelHealth({ enabled: true, failureThreshold: 1, cooldownSeconds: 60 }, () => t);
    setModelHealth(mh);
    mh.recordFailure("broken/t2", "provider", "400 invalid_request_error");

    const before = getAgents().size;
    const reqId = writeSpawnRequest("t2", "do something", "t0a", "/tmp");
    const configs: Record<string, TierConfig> = { active: tierConfig(""), t1: tierConfig(""), t2: tierConfig("broken/t2"), t3: tierConfig("") };
    const n = processSpawnRequests(configs as any, "/tmp", undefined, false, false, false);
    const respPath = path.join(dir, "responses", `${reqId}.json`);
    let resp: any = null;
    try { resp = JSON.parse(fs.readFileSync(respPath, "utf-8")); } catch { /* missing */ }
    check("one request processed", n === 1, n);
    check("response written", !!resp);
    check("response refuses with cooldown text", !!resp && resp.result.status === "error" && /paused|Retry in/i.test(resp.result.stderr), resp?.result?.stderr);
    check("no agent process was launched", getAgents().size === before, { before, after: getAgents().size });

    mh.clear("broken/t2");
    check("gate allows again after clear", getTierModelBlock("t2", tierConfig("broken/t2"), false) === null);
  } finally {
    setModelHealth(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
