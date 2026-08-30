// Functional tests for the prefill/decode speed tracker.
// Run: node --experimental-strip-types test-speed.ts
import { SpeedTracker, MAIN_TARGET } from "./src/speed.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? ` (${extra})` : ""}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${extra ? ` (${extra})` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stream `deltas` chunks, `gapMs` apart. */
async function stream(t: SpeedTracker, id: string, chunks: number, gapMs: number) {
  for (let i = 0; i < chunks; i++) {
    t.noteDelta(id, 20);
    await sleep(gapMs);
  }
}

// ── Test 1: live decode speed is available WHILE streaming ──────────────
{
  const t = new SpeedTracker();
  t.startRequest("t0a");
  await sleep(150); // let TTFT grow past the measurement gate
  await stream(t, "t0a", 12, 50); // ~600ms of stream
  const mid = t.snapshot("t0a");
  check("live decode phase", mid?.phase === "decode", `phase=${mid?.phase}`);
  check("live decode > 0 during stream", (mid?.decodeTokPerSec || 0) > 0, `${mid?.decodeTokPerSec?.toFixed(1)} tok/s`);
  t.endRequest("t0a", { input: 300, cacheRead: 0, cacheWrite: 0, output: 42 });
  const after = t.snapshot("t0a");
  check("authoritative decode after usage", Math.abs((after?.genTokPerSec || 0) - (after?.decodeTokPerSec || 0)) < 1e-9,
    `${after?.genTokPerSec?.toFixed(1)} tok/s`);
  check("short prompt: TTFT recorded, no fake throughput", (after?.ttftMs || 0) > 0 && (after?.prefillTokPerSec || 0) === 0,
    `ttft=${after?.ttftMs}ms, ${after?.prefillTokPerSec} tok/s`);
}

// ── Test 2: prefill phase + trusted large-prompt samples only ────────────
{
  const t = new SpeedTracker();
  t.startRequest("t1a");
  await sleep(300); // long prompt processing, nothing streamed yet
  const pre = t.snapshot("t1a");
  check("prefill phase before first token", pre?.phase === "prefill", `phase=${pre?.phase}`);
  check("prefill elapsed ~300ms", (pre?.prefillElapsedMs || 0) >= 280, `${pre?.prefillElapsedMs}ms`);
  check("no decode during prefill", (pre?.decodeTokPerSec || 0) === 0);
  await sleep(900); // total wait > 1.2s, so throughput means something
  t.noteDelta("t1a", 5);
  t.endRequest("t1a", { input: 9000, cacheRead: 0, cacheWrite: 0, output: 10 });
  const post = t.snapshot("t1a");
  // 9000 tokens / ~1.2s ≈ 7500 tok/s (loose bounds: machine scheduling)
  check("large prompt measured as prefill tok/s", (post?.prefillTokPerSec || 0) > 3000,
    `${post?.prefillTokPerSec?.toFixed(0)} tok/s`);
  // A small prompt on the same target must not dilute the trusted sample.
  t.startRequest("t1a");
  await sleep(20);
  t.noteDelta("t1a", 5);
  t.endRequest("t1a", { input: 40, cacheRead: 0, cacheWrite: 0, output: 10 });
  const small = t.snapshot("t1a");
  check("small prompt does not dilute the sample",
    Math.abs((small?.prefillTokPerSec || 0) - (post?.prefillTokPerSec || 0)) < 1e-9,
    `${post?.prefillTokPerSec?.toFixed(0)} → ${small?.prefillTokPerSec?.toFixed(0)}`);
}

// ── Test 3: cached prompt is not reported as prefill throughput ──────────
{
  const t = new SpeedTracker();
  t.startRequest("t2a");
  t.noteDelta("t2a", 30); // first token immediately → no prefill work
  t.endRequest("t2a", { input: 8, cacheRead: 12_000, cacheWrite: 0, output: 50 });
  const s = t.snapshot("t2a");
  check("cache hit does not fake prefill", (s?.prefillTokPerSec || 0) === 0, `${s?.prefillTokPerSec} tok/s`);
  check("sub-threshold decode window is not measured", (s?.genTokPerSec || 0) === 0);
}

// ── Test 4: tokens-per-char ratio calibrated from real usage ─────────────
{
  const t = new SpeedTracker();
  const initial = DEFAULT_RATIO();
  t.startRequest("t3a");
  await sleep(60);
  await stream(t, "t3a", 10, 60); // 200 chars over ~600ms
  t.endRequest("t3a", { input: 100, cacheRead: 0, cacheWrite: 0, output: 100 }); // ratio 0.5
  const s = t.snapshot("t3a");
  check("ratio calibrated toward usage", (s?.tokPerChar || 0) > initial && (s?.tokPerChar || 0) <= 0.5,
    `${initial} → ${s?.tokPerChar?.toFixed(3)}`);
  t.startRequest("t3a");
  const carried = t.snapshot("t3a");
  check("ratio carried to next request", (carried?.tokPerChar || 0) > 0.35, `${carried?.tokPerChar?.toFixed(3)}`);
}
function DEFAULT_RATIO() { return 0.35; }

// ── Test 5: finalize keeps values but stops live phases ─────────────────
// (decode-only: the prompt here is deliberately too small for a prefill sample)
{
  const t = new SpeedTracker();
  t.startRequest("t0b");
  await sleep(160);
  await stream(t, "t0b", 12, 50);
  t.endRequest("t0b", { input: 200, cacheRead: 0, cacheWrite: 0, output: 30 });
  t.finalize("t0b");
  const s = t.snapshot("t0b");
  check("finalize clears live phase", s?.phase === "idle", `phase=${s?.phase}`);
  check("finalize keeps last measurements", (s?.genTokPerSec || 0) > 0 && (s?.ttftMs || 0) > 0,
    `↓${s?.genTokPerSec?.toFixed(1)}t/s ↑${s?.ttftMs}ms`);
}

// ── Test 6: idle detection after the stream stops ────────────────────────
{
  const t = new SpeedTracker();
  t.startRequest(MAIN_TARGET);
  await sleep(60);
  await stream(t, MAIN_TARGET, 4, 30);
  const live = t.snapshot(MAIN_TARGET);
  check("main session tracked as live", live?.phase === "decode" && t.hasLiveActivity(), `phase=${live?.phase}`);
  await sleep(2200); // silence longer than IDLE_AFTER_MS
  const idle = t.snapshot(MAIN_TARGET);
  check("silence flips to idle", idle?.phase === "idle", `phase=${idle?.phase}`);
  check("no live activity after silence", !t.hasLiveActivity());
}

// ── Test 7: provider-reported tokens beat the character estimate ─────────
{
  const t = new SpeedTracker();
  t.startRequest("t0c");
  t.noteDelta("t0c", 10); // chars alone would suggest ~3.5 tokens
  t.noteLiveUsage("t0c", 400); // provider already reported 400 tokens
  await sleep(500);
  const s = t.snapshot("t0c");
  const charEstimate = (10 * 0.35) / 0.5;
  check("live usage replaces the char estimate", (s?.decodeTokPerSec || 0) > charEstimate * 10,
    `${s?.decodeTokPerSec?.toFixed(0)} vs ~${charEstimate.toFixed(0)} tok/s`);
}

// ── Test 8: snapshots sorted, prune forgets stale agents ─────────────────
{
  const t = new SpeedTracker();
  t.startRequest(MAIN_TARGET);
  t.noteDelta(MAIN_TARGET, 10);
  t.startRequest("t0x");
  t.noteDelta("t0x", 10);
  const all = t.snapshots();
  check("snapshots include both targets", all.length === 2, `${all.length}`);
  t.forget("t0x");
  check("forget drops target", t.snapshot("t0x") === null && t.snapshot(MAIN_TARGET) !== null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
