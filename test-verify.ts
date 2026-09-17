/**
 * Trimegisto - per-task verification tests
 *
 * Run: node --experimental-strip-types test-verify.ts
 *
 * Covers the "verification instead of trust" import (arXiv:2608.26480 §3.1/§4.4):
 *  - normalizeVerify / timeout clamping / output truncation / badges
 *  - the wave gate helper (a wave with a verification in flight is not terminal)
 *  - runVerification: exit 0, non-zero, timeout, cwd, output capture, and the
 *    hard guarantee that it NEVER rejects (a bad command must not take the host
 *    down or leave a wave gate stuck)
 *  - reconcileBatch: a `done` agent whose verify failed is surfaced as
 *    VERIFY FAILED, not counted as a success, and never double-listed as
 *    "unverified"
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizeVerify,
  verifyTimeoutMs,
  truncateVerifyOutput,
  verificationBadge,
  waveHasPendingVerification,
  lightRedact,
  runVerification,
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_OUTPUT_CHARS,
  type VerificationResult,
} from "./src/verify.ts";
import { reconcileBatch, distillConclusion, isVerifyFailed } from "./src/reconcile.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

async function main(): Promise<void> {
  // ── normalizeVerify ─────────────────────────────────────
  console.log("\nnormalizeVerify");
  check("plain string", normalizeVerify("npm test")?.command === "npm test");
  check("trims", normalizeVerify("  npm test  ")?.command === "npm test");
  check("blank string → undefined", normalizeVerify("   ") === undefined);
  check("undefined → undefined", normalizeVerify(undefined) === undefined);
  check("null → undefined", normalizeVerify(null) === undefined);
  check("empty object → undefined", normalizeVerify({}) === undefined);
  check("object with command", normalizeVerify({ command: "pytest -q" })?.command === "pytest -q");
  check("object blank command → undefined", normalizeVerify({ command: "  " }) === undefined);
  check("number → undefined", normalizeVerify(7) === undefined);

  // ── verifyTimeoutMs ─────────────────────────────────────
  console.log("\nverifyTimeoutMs");
  const savedEnv = process.env.TRIMEGISTO_VERIFY_TIMEOUT_MS;
  delete process.env.TRIMEGISTO_VERIFY_TIMEOUT_MS;
  check("default", verifyTimeoutMs() === DEFAULT_VERIFY_TIMEOUT_MS);
  check("explicit value", verifyTimeoutMs(5_000) === 5_000);
  check("below floor clamps to 1s", verifyTimeoutMs(50) === 1_000);
  check("above ceiling clamps", verifyTimeoutMs(99_999_999) === MAX_VERIFY_TIMEOUT_MS);
  check("NaN → default", verifyTimeoutMs("nope") === DEFAULT_VERIFY_TIMEOUT_MS);
  check("negative → default", verifyTimeoutMs(-5) === DEFAULT_VERIFY_TIMEOUT_MS);
  process.env.TRIMEGISTO_VERIFY_TIMEOUT_MS = "3000";
  check("env override used when arg omitted", verifyTimeoutMs() === 3_000);
  check("explicit arg beats env", verifyTimeoutMs(4_000) === 4_000);
  if (savedEnv === undefined) delete process.env.TRIMEGISTO_VERIFY_TIMEOUT_MS;
  else process.env.TRIMEGISTO_VERIFY_TIMEOUT_MS = savedEnv;

  // ── truncateVerifyOutput ────────────────────────────────
  console.log("\ntruncateVerifyOutput");
  check("short unchanged", truncateVerifyOutput("ok") === "ok");
  const long = "H".repeat(3_000) + "TAILSENTINEL";
  const trunc = truncateVerifyOutput(long, 200);
  check("long is truncated", trunc.length <= 200);
  check("keeps the head", trunc.startsWith("H"));
  check("keeps the tail", trunc.endsWith("TAILSENTINEL"));
  check("marks the cut", trunc.includes("truncated"));
  check("default limit applies", truncateVerifyOutput("x".repeat(MAX_VERIFY_OUTPUT_CHARS + 500)).length <= MAX_VERIFY_OUTPUT_CHARS);

  // ── lightRedact ─────────────────────────────────────────
  console.log("\nlightRedact");
  check("masks sk- key", lightRedact("key sk-abcdef0123456789 done") === "key <redacted> done");
  check("masks ghp token", lightRedact("ghp_ABCDEFGH12345678").includes("<redacted>"));
  check("masks Bearer", lightRedact("Authorization: Bearer abcdefgh12345678").includes("<redacted>"));
  check("does NOT mangle a path with digits", lightRedact("/tmp/trimegisto-a1b2c3/tests") === "/tmp/trimegisto-a1b2c3/tests");
  check("does NOT mangle a hash", lightRedact("commit 9f8e7d6c5b4a3210") === "commit 9f8e7d6c5b4a3210");
  check("does NOT mangle a version", lightRedact("v1.6.20") === "v1.6.20");

  // ── verificationBadge ───────────────────────────────────
  console.log("\nverificationBadge");
  check("none → empty", verificationBadge(undefined) === "");
  const passedV: VerificationResult = { command: "npm test", ran: true, passed: true, exitCode: 0, signal: null, timedOut: false, durationMs: 12, output: "" };
  check("passed badge", verificationBadge(passedV).includes("✅"));
  const failedV: VerificationResult = { command: "npm test", ran: true, passed: false, exitCode: 2, signal: null, timedOut: false, durationMs: 9, output: "boom" };
  check("failed badge has exit code", verificationBadge(failedV).includes("❌") && verificationBadge(failedV).includes("exit 2"));
  const timeoutV: VerificationResult = { command: "sleep 999", ran: true, passed: false, exitCode: null, signal: "SIGTERM", timedOut: true, durationMs: 1_200, output: "" };
  check("timeout badge", verificationBadge(timeoutV).includes("timeout"));
  const notRunV: VerificationResult = { command: "nope", ran: false, passed: false, exitCode: null, signal: null, timedOut: false, durationMs: 1, output: "", error: "spawn failed" };
  check("not-run badge", verificationBadge(notRunV).includes("not run"));

  // ── waveHasPendingVerification ──────────────────────────
  console.log("\nwaveHasPendingVerification");
  const pending = new Set(["t1a"]);
  check("detects a pending id", waveHasPendingVerification(["t1a", "t1b"], pending) === true);
  check("false when none pending", waveHasPendingVerification(["t1b"], pending) === false);
  check("false for empty wave", waveHasPendingVerification([], pending) === false);
  check("false for missing set", waveHasPendingVerification(["t1a"], undefined) === false);
  check("non-array is safe", waveHasPendingVerification(undefined as any, pending) === false);

  // ── runVerification ─────────────────────────────────────
  console.log("\nrunVerification (real subprocesses)");
  const ok = await runVerification({ command: 'node -e "process.exit(0)"' }, process.cwd());
  check("exit 0 → ran+passed", ok.ran === true && ok.passed === true && ok.exitCode === 0);
  check("captures duration", ok.durationMs >= 0);

  const bad = await runVerification({ command: 'node -e "console.error(\'boom\');process.exit(3)"' }, process.cwd());
  check("exit 3 → ran, not passed", bad.ran === true && bad.passed === false && bad.exitCode === 3);
  check("captures stderr", bad.output.includes("boom"));

  const empty = await runVerification(undefined, process.cwd());
  check("missing command never throws → ran:false", empty.ran === false && !!empty.error);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trimegisto-verify-"));
  const realTmp = fs.realpathSync(tmp);
  const cwdRun = await runVerification({ command: 'node -e "process.stdout.write(process.cwd())"' }, tmp);
  check("runs in the task cwd", fs.realpathSync(cwdRun.output.trim()) === realTmp, { got: cwdRun.output, want: realTmp });
  fs.rmSync(tmp, { recursive: true, force: true });

  const to = await runVerification({ command: 'node -e "setTimeout(()=>{},60000)"' }, process.cwd(), { timeoutMs: 1_000 });
  check("timeout is reported", to.timedOut === true && to.passed === false);
  check("timeout still returns output string", typeof to.output === "string");

  // A command whose own output is huge must not blow up and must be truncated.
  const big = await runVerification({ command: 'node -e "process.stdout.write(\'x\'.repeat(200000))"' }, process.cwd());
  check("large output truncated", big.output.length <= MAX_VERIFY_OUTPUT_CHARS);

  // ── reconcile integration ───────────────────────────────
  console.log("\nreconcile + verification");
  const verifyFailedResult = {
    agentId: "t1a", tier: "t1", task: "fix the parser",
    status: "done", finalOutput: "I fixed the parser.", output: "",
    stderr: "", stopReason: "completed",
    verification: { command: "npm test", ran: true, passed: false, exitCode: 1, timedOut: false, durationMs: 40, output: "FAIL src/parser.test.ts\n  expected 3 got 4" },
  };
  check("isVerifyFailed true", isVerifyFailed(verifyFailedResult) === true);
  check("distill prefixes VERIFY FAILED", distillConclusion(verifyFailedResult as any).includes("VERIFY FAILED"));
  const onlyDone = reconcileBatch([verifyFailedResult as any]);
  check("headline flags verify-failed", onlyDone.headline.includes("verify-failed"), onlyDone.headline);
  check("counts.verifyFailed === 1", onlyDone.counts.verifyFailed === 1);
  check("counts.verified === 0", onlyDone.counts.verified === 0);
  check("markdown has the section", onlyDone.markdown.includes("Verification failed"));
  check("markdown shows the command", onlyDone.markdown.includes("npm test"));
  check("markdown shows the failing line", onlyDone.markdown.includes("expected 3 got 4"));
  check("conclusion warns not to trust it", onlyDone.markdown.includes("do not trust"));
  check("NOT double-listed as unverified", !onlyDone.markdown.includes("Unverified (reported success"));

  const verifyPassedResult = {
    agentId: "t1b", tier: "t1", task: "add the endpoint",
    status: "done", finalOutput: "Added the endpoint.", output: "", stderr: "",
    verification: { command: "npm test", ran: true, passed: true, exitCode: 0, timedOut: false, durationMs: 30, output: "ok" },
  };
  const okBatch = reconcileBatch([verifyPassedResult as any]);
  check("headline counts verified", okBatch.headline.includes("1 verified"), okBatch.headline);
  check("no verify-failed section", !okBatch.markdown.includes("Verification failed"));
  check("per-agent verify line present", okBatch.markdown.includes("verify ✅"));

  const mixed = reconcileBatch([verifyFailedResult as any, verifyPassedResult as any]);
  check("mixed counts", mixed.counts.done === 2 && mixed.counts.verified === 1 && mixed.counts.verifyFailed === 1);
  check("mixed headline", mixed.headline.includes("verify-failed") && mixed.headline.includes("verified"));

  const legacy = reconcileBatch([{ agentId: "t2a", tier: "t2", task: "x", status: "done", finalOutput: "done", output: "", stderr: "" } as any]);
  check("no-verify output unchanged (no verify bits)", !legacy.markdown.includes("verify") && legacy.counts.verifyFailed === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("test harness crashed:", err); process.exit(1); });
