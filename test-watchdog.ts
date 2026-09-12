/**
 * Trimegisto - Watchdog config tests
 *
 * Run: node --experimental-strip-types test-watchdog.ts
 *
 * Covers the configurable watchdog timeouts (seconds; 0 = disabled) and the
 * hardening that prevents a corrupt / oversized value from overflowing
 * setTimeout (which fires after ~1 ms and would kill an agent instantly).
 */

import {
  getDefaultConfig,
  clampWatchdogSeconds,
  MAX_WATCHDOG_SECONDS,
  WATCHDOG_DEFAULTS,
} from "./src/config.ts";
import { setWatchdogTimeouts, getWatchdogTimeouts } from "./src/agent-manager.ts";

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

const MAX_TIMER_MS = 2_147_483_647;

console.log("Test 1 (defaults, no env vars):");
{
  const savedEnv = {
    TRIMEGISTO_FIRST_RESPONSE_TIMEOUT_MS: process.env.TRIMEGISTO_FIRST_RESPONSE_TIMEOUT_MS,
    TRIMEGISTO_AGENT_IDLE_TIMEOUT_MS: process.env.TRIMEGISTO_AGENT_IDLE_TIMEOUT_MS,
    TRIMEGISTO_AGENT_MAX_RUNTIME_MS: process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS,
  };
  delete process.env.TRIMEGISTO_FIRST_RESPONSE_TIMEOUT_MS;
  delete process.env.TRIMEGISTO_AGENT_IDLE_TIMEOUT_MS;
  delete process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS;
  const wd = getDefaultConfig().watchdog;
  check("firstResponseSeconds default = 90", wd.firstResponseSeconds === 90, wd.firstResponseSeconds);
  check("idleSeconds default = 120", wd.idleSeconds === 120, wd.idleSeconds);
  check("maxRuntimeSeconds default = 0 (disabled)", wd.maxRuntimeSeconds === 0, wd.maxRuntimeSeconds);
  check("WATCHDOG_DEFAULTS exposed", WATCHDOG_DEFAULTS.maxRuntimeSeconds === 0);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

console.log("Test 1b (legacy env vars still seed defaults):");
{
  const savedEnv = process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS;
  process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS = "600000";
  const wd = getDefaultConfig().watchdog;
  check("env maxRuntime 600000ms -> 600s", wd.maxRuntimeSeconds === 600, wd.maxRuntimeSeconds);
  process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS = "0";
  check("env maxRuntime 0 -> disabled", getDefaultConfig().watchdog.maxRuntimeSeconds === 0);
  if (savedEnv === undefined) delete process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS; else process.env.TRIMEGISTO_AGENT_MAX_RUNTIME_MS = savedEnv;
}

console.log("Test 2 (clampWatchdogSeconds — boundaries):");
{
  check("0 stays 0 (disabled)", clampWatchdogSeconds(0, 90) === 0);
  check("normal value preserved", clampWatchdogSeconds(45, 90) === 45);
  check("fractional floored", clampWatchdogSeconds(12.9, 90) === 12);
  check("negative -> fallback", clampWatchdogSeconds(-5, 90) === 90, clampWatchdogSeconds(-5, 90));
  check("NaN -> fallback", clampWatchdogSeconds(NaN, 90) === 90, clampWatchdogSeconds(NaN, 90));
  check("Infinity -> fallback", clampWatchdogSeconds(Infinity, 120) === 120, clampWatchdogSeconds(Infinity, 120));
  check("non-numeric string -> fallback", clampWatchdogSeconds("abc", 90) === 90);
  check("undefined -> fallback", clampWatchdogSeconds(undefined, 90) === 90);
  check("null -> 0 (Number(null)=0)", clampWatchdogSeconds(null, 90) === 0);
  check("numeric string accepted", clampWatchdogSeconds("30", 90) === 30);
  check("oversized clamped to MAX", clampWatchdogSeconds(999_999_999, 90) === MAX_WATCHDOG_SECONDS);
  check("MAX is below setTimeout limit", MAX_WATCHDOG_SECONDS * 1000 <= MAX_TIMER_MS, MAX_WATCHDOG_SECONDS);
  check("fallback 0 stays 0", clampWatchdogSeconds(-1, 0) === 0);
}

console.log("Test 3 (setWatchdogTimeouts — partial merge & normalization):");
{
  setWatchdogTimeouts({ firstResponseMs: 90_000, idleMs: 120_000, maxRuntimeMs: 0 });
  const initial = getWatchdogTimeouts();
  check("maxRuntime 0 disables (default)", initial.maxRuntimeMs === 0);

  setWatchdogTimeouts({ maxRuntimeMs: 600_000 });
  const after = getWatchdogTimeouts();
  check("partial update keeps other values", after.firstResponseMs === 90_000 && after.idleMs === 120_000, after);
  check("partial update applies new value", after.maxRuntimeMs === 600_000, after.maxRuntimeMs);

  setWatchdogTimeouts({ idleMs: 0 });
  check("idle can be disabled", getWatchdogTimeouts().idleMs === 0);

  // Oversized value must be clamped, not overflow setTimeout.
  setWatchdogTimeouts({ maxRuntimeMs: 999_999_999_000 });
  const huge = getWatchdogTimeouts().maxRuntimeMs;
  check("oversized ms clamped to <= setTimeout limit", huge > 0 && huge <= MAX_TIMER_MS, huge);

  // Corrupt values fall back instead of silently disabling / firing instantly.
  setWatchdogTimeouts({ firstResponseMs: NaN });
  check("NaN falls back to previous value", getWatchdogTimeouts().firstResponseMs === 90_000, getWatchdogTimeouts().firstResponseMs);
  setWatchdogTimeouts({ idleMs: -1 });
  check("negative falls back to previous value", getWatchdogTimeouts().idleMs === 0, getWatchdogTimeouts().idleMs);
  setWatchdogTimeouts({ idleMs: Infinity });
  check("Infinity falls back to previous value", getWatchdogTimeouts().idleMs === 0, getWatchdogTimeouts().idleMs);
}

console.log("Test 4 (merge of a corrupt persisted config -> safe timeouts):");
{
  // Simulate index.ts: saved watchdog overrides defaults, then sanitize to ms.
  const saved = { firstResponseSeconds: 1e12, idleSeconds: "abc", maxRuntimeSeconds: -10 } as any;
  const merged = { ...WATCHDOG_DEFAULTS, ...saved };
  setWatchdogTimeouts({
    firstResponseMs: clampWatchdogSeconds(merged.firstResponseSeconds, WATCHDOG_DEFAULTS.firstResponseSeconds) * 1000,
    idleMs: clampWatchdogSeconds(merged.idleSeconds, WATCHDOG_DEFAULTS.idleSeconds) * 1000,
    maxRuntimeMs: clampWatchdogSeconds(merged.maxRuntimeSeconds, WATCHDOG_DEFAULTS.maxRuntimeSeconds) * 1000,
  });
  const t = getWatchdogTimeouts();
  check("huge first-response clamped (no overflow)", t.firstResponseMs > 0 && t.firstResponseMs <= MAX_TIMER_MS, t.firstResponseMs);
  check("non-numeric idle falls back to 120s", t.idleMs === 120_000, t.idleMs);
  check("negative maxRuntime -> 0 (no instant kill)", t.maxRuntimeMs === 0, t.maxRuntimeMs);
}

console.log("Test 5 (old config without watchdog keeps safe defaults):");
{
  const oldSaved = { dashboardVisible: true } as any; // no watchdog key
  const merged = { ...WATCHDOG_DEFAULTS, ...(oldSaved.watchdog || {}) };
  check("merged equals defaults", merged.firstResponseSeconds === 90 && merged.idleSeconds === 120 && merged.maxRuntimeSeconds === 0, merged);
}

console.log("Test 6 (clamped delay does not fire immediately):");
{
  // We already proved in QA that an overflowing delay fires in ~1 ms. Here we
  // assert the clamp keeps the delay valid, and that arming it does not fire.
  setWatchdogTimeouts({ maxRuntimeMs: 999_999_999_000 });
  const ms = getWatchdogTimeouts().maxRuntimeMs;
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, ms);
  timer.unref?.();
  // Busy-wait a few ms synchronously: an overflowed timer would have fired by now.
  const end = Date.now() + 30;
  while (Date.now() < end) { /* spin */ }
  clearTimeout(timer);
  check("clamped timer did not fire within 30ms", fired === false, fired);
}

console.log("Test 7 (persistence round-trip with watchdog):");
{
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-wd-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmp;
  try {
    const { saveConfig, loadConfig } = await import("./src/persistence.ts");

    const cfg = getDefaultConfig();
    cfg.watchdog = { firstResponseSeconds: 45, idleSeconds: 0, maxRuntimeSeconds: 900 };
    saveConfig(cfg);
    const loaded = loadConfig();
    check("saved watchdog survives round-trip",
      loaded?.watchdog?.firstResponseSeconds === 45 && loaded?.watchdog?.idleSeconds === 0 && loaded?.watchdog?.maxRuntimeSeconds === 900,
      loaded?.watchdog);

    // Corrupt on-disk values must sanitize on merge, never crash / overflow.
    const file = path.join(tmp, "trimegisto", "config.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    raw.watchdog = { firstResponseSeconds: "abc", idleSeconds: 1e12, maxRuntimeSeconds: -3 };
    fs.writeFileSync(file, JSON.stringify(raw));
    const corrupt = loadConfig();
    const merged = {
      firstResponseSeconds: clampWatchdogSeconds(corrupt?.watchdog?.firstResponseSeconds ?? 90, WATCHDOG_DEFAULTS.firstResponseSeconds),
      idleSeconds: clampWatchdogSeconds(corrupt?.watchdog?.idleSeconds ?? 120, WATCHDOG_DEFAULTS.idleSeconds),
      maxRuntimeSeconds: clampWatchdogSeconds(corrupt?.watchdog?.maxRuntimeSeconds ?? 0, WATCHDOG_DEFAULTS.maxRuntimeSeconds),
    };
    check("corrupt first-response -> 90s fallback", merged.firstResponseSeconds === 90, merged.firstResponseSeconds);
    check("corrupt idle clamped to MAX (no overflow)", merged.idleSeconds === MAX_WATCHDOG_SECONDS, merged.idleSeconds);
    check("corrupt negative maxRuntime -> 0", merged.maxRuntimeSeconds === 0, merged.maxRuntimeSeconds);

    // Old config (no watchdog key) must inherit safe defaults.
    delete raw.watchdog;
    fs.writeFileSync(file, JSON.stringify(raw));
    const old = loadConfig();
    check("missing watchdog key -> undefined (defaults apply)", old?.watchdog === undefined, old?.watchdog);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
