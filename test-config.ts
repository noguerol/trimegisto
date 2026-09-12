/**
 * Trimegisto - Config defaults, compaction migration and /tmg config menu tests
 *
 * Run: node --experimental-strip-types test-config.ts
 *
 * Covers:
 *  - compaction thresholds default to 0 (off) so pi decides
 *  - pre-v3 migration resets old built-in defaults to off, preserves explicit values
 *  - the config UI keeps the same menu level open after a change (main, tier and
 *    watchdogs submenus) instead of closing
 */

import {
  getDefaultConfig,
  migrateSavedCompaction,
  OLD_DEFAULT_COMPACTION,
  SCHEMA_VERSION,
  effectiveCompactionThreshold,
  sanitizeLoopSupervisorConfig,
} from "./src/config.ts";
import { runConfigUI } from "./src/config-ui.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

console.log("Test 1 (compaction defaults are off):");
{
  const c = getDefaultConfig();
  check("active compactionThreshold = 0", c.active.compactionThreshold === 0, c.active.compactionThreshold);
  check("t1 compactionThreshold = 0", c.t1.compactionThreshold === 0, c.t1.compactionThreshold);
  check("t2 compactionThreshold = 0", c.t2.compactionThreshold === 0, c.t2.compactionThreshold);
  check("t3 compactionThreshold = 0", c.t3.compactionThreshold === 0, c.t3.compactionThreshold);
}

console.log("Test 2 (migrateSavedCompaction):");
{
  const oldSaved = {
    active: { compactionThreshold: 85 },
    t1: { compactionThreshold: 65 },
    t2: { compactionThreshold: 75 },
    t3: { compactionThreshold: 85 },
  };
  const m = migrateSavedCompaction(oldSaved as any, 2);
  check("schema 2 -> old defaults reset to off", m.active === 0 && m.t1 === 0 && m.t2 === 0 && m.t3 === 0, m);
  check("schema 3 -> no migration", Object.keys(migrateSavedCompaction(oldSaved as any, SCHEMA_VERSION)).length === 0);
  check("undefined schema -> migrates", migrateSavedCompaction(oldSaved as any, undefined).t1 === 0);
  const custom = { t1: { compactionThreshold: 70 }, t2: { compactionThreshold: 75 } };
  const cm = migrateSavedCompaction(custom as any, 2);
  check("explicit non-default NOT migrated (70 untouched)", cm.t1 === undefined, cm.t1);
  check("matching old default migrated (75 -> 0)", cm.t2 === 0, cm.t2);
  check("empty saved -> {}", Object.keys(migrateSavedCompaction(undefined, 2)).length === 0);
  check("string value ignored", Object.keys(migrateSavedCompaction({ t1: { compactionThreshold: "65" as any } } as any, 2)).length === 0);
  check("old defaults documented", OLD_DEFAULT_COMPACTION.t1 === 65 && OLD_DEFAULT_COMPACTION.t2 === 75);
}

// ── Config UI harness ────────────────────────────────────
/** Script entry: a token resolved against the offered options, or a literal answer. */
type Step = string | undefined;

function makeHarness(script: Step[], inputAnswer: string | undefined = undefined) {
  const calls: Array<{ title: string; options: string[] }> = [];
  const config = getDefaultConfig();
  let saved = 0;

  // Tokens map to an option prefix; unknown strings are returned verbatim.
  const TOKENS: Record<string, (opts: string[]) => string | undefined> = {
    "__MAIN_DONE__": (o) => o.find(x => x === "Done"),
    "__AUTO__": (o) => o.find(x => x.startsWith("Auto-spawn")),
    "__DEDUPE__": (o) => o.find(x => x.startsWith("Dedupe tasks")),
    "__REDUNDANT__": (o) => o.find(x => x.startsWith("Redundant models")),
    "__ADD__": (o) => o.find(x => x === "＋ Add model..."),
    "__WD__": (o) => o.find(x => x.startsWith("Watchdogs")),
    "__FIRST__": (o) => o.find(x => x.startsWith("First response")),
    "__T1__": (o) => o.find(x => x.startsWith("T1")),
    "__T2__": (o) => o.find(x => x.startsWith("T2")),
    "__COMPACT__": (o) => o.find(x => x.startsWith("Compaction Threshold")),
    "__COMPACT_OFF__": (o) => o.find(x => x === "Off (pi default)"),
    "__BACK__": (o) => o.find(x => x === "Back"),
  };

  const ctx = {
    hasUI: true,
    modelRegistry: { getAvailable: async () => [] },
    ui: {
      select: async (title: string, options: string[]) => {
        calls.push({ title, options });
        const step = script.shift();
        if (step === undefined) return undefined;
        return TOKENS[step] ? TOKENS[step](options) : step;
      },
      notify: () => {},
      input: async () => inputAnswer,
      custom: async () => undefined,
    },
  };
  const rt = {
    config,
    dashboardMode: "compact" as const,
    setDashboardMode: () => {},
    activeModel: null,
    ctxRef: null,
    updateDashboard: () => {},
    haltAll: () => 0,
    saveConfig: () => { saved++; },
    registerMainTool: () => {},
    syncLoopSupervisor: () => {},
    syncWatchdog: () => {},
  };
  return { ctx, rt, calls, config, savedCount: () => saved };
}

console.log("Test 3 (tier submenu stays open after toggling):");
{
  const h = makeHarness(["__T2__", "Enabled: ON", "__BACK__", "Done"]);
  await runConfigUI(h.ctx, h.rt as any);
  const titles = h.calls.map(c => c.title);
  check("sequence: main -> tier -> tier -> main",
    titles[0] === "Configure Trimegisto:" && titles[1]!.startsWith("Configure T2:") && titles[2]!.startsWith("Configure T2:") && titles[3] === "Configure Trimegisto:",
    titles);
  check("change was saved", h.savedCount() >= 1, h.savedCount());
  check("t2 toggled once (enabled -> OFF)", h.config.t2.enabled === false, h.config.t2.enabled);
}

console.log("Test 4 (main menu toggle stays open):");
{
  const h = makeHarness(["__AUTO__", "Done"]);
  await runConfigUI(h.ctx, h.rt as any);
  check("auto-spawn toggled", h.config.autoSpawn === false, h.config.autoSpawn);
  check("main menu re-rendered (2 calls)",
    h.calls.length === 2 && h.calls[1].title === "Configure Trimegisto:",
    h.calls.map(c => c.title));
}

console.log("Test 5 (watchdogs submenu stays open after editing):");
{
  const h = makeHarness(["__WD__", "__FIRST__", "__BACK__", "Done"], "30");
  await runConfigUI(h.ctx, h.rt as any);
  const titles = h.calls.map(c => c.title);
  check("watchdog updated to 30s", h.config.watchdog.firstResponseSeconds === 30, h.config.watchdog.firstResponseSeconds);
  check("sequence: main -> wd -> wd -> main",
    titles[0] === "Configure Trimegisto:" && titles[1] === "Watchdogs (0 = off):" && titles[2] === "Watchdogs (0 = off):" && titles[3] === "Configure Trimegisto:",
    titles);
}

console.log("Test 6 (compaction can be turned off from the tier submenu):");
{
  const h = makeHarness(["__T1__", "__COMPACT__", "__COMPACT_OFF__", "__BACK__", "Done"]);
  h.config.t1.compactionThreshold = 65; // simulate a user who had it on
  await runConfigUI(h.ctx, h.rt as any);
  check("t1 compaction turned off", h.config.t1.compactionThreshold === 0, h.config.t1.compactionThreshold);
  check("compaction menu offered Off option",
    h.calls.some(c => c.options.includes("Off (pi default)")), h.calls.map(c => c.options.slice(0, 2)));
  const titles = h.calls.map(c => c.title);
  check("returned to tier submenu after change", titles[3]!.startsWith("Configure T1:"), titles);
}

console.log("Test 7 (Esc backs out one level, main Esc closes):");
{
  const h = makeHarness(["__T2__", undefined, "Done"]);
  await runConfigUI(h.ctx, h.rt as any);
  const titles = h.calls.map(c => c.title);
  check("Esc from tier submenu returns to main",
    titles.length === 3 && titles[1]!.startsWith("Configure T2:") && titles[2] === "Configure Trimegisto:",
    titles);
}

console.log("Test 8 (main menu Esc closes immediately):");
{
  const h = makeHarness([undefined]);
  await runConfigUI(h.ctx, h.rt as any);
  check("only one select call then return", h.calls.length === 1, h.calls.map(c => c.title));
}

console.log("Test 9 (load + migrate real persisted v2 config):");
{
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-cfg-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmp;
  try {
    const dir = path.join(tmp, "trimegisto");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({
      _schemaVersion: 2,
      active: { compactionThreshold: 85 },
      t1: { compactionThreshold: 65 },
      t2: { compactionThreshold: 70 }, // explicit non-default
      t3: { compactionThreshold: 85 },
    }));
    const { loadConfig } = await import("./src/persistence.ts");
    const saved = loadConfig();
    const migrated = migrateSavedCompaction(saved as any, saved?._schemaVersion);
    check("loaded schema 2", saved?._schemaVersion === 2, saved?._schemaVersion);
    check("old defaults migrated to off", migrated.active === 0 && migrated.t1 === 0 && migrated.t3 === 0, migrated);
    check("explicit t2=70 preserved (not in migration)", migrated.t2 === undefined, migrated.t2);

    // Simulate what index.ts does after migrating: persist once -> schema bumps.
    const { saveConfig } = await import("./src/persistence.ts");
    const cfg = getDefaultConfig();
    saveConfig(cfg);
    const afterSave = loadConfig();
    check("saveConfig writes SCHEMA_VERSION", afterSave?._schemaVersion === SCHEMA_VERSION, afterSave?._schemaVersion);
    check("reload after migration does not re-migrate",
      Object.keys(migrateSavedCompaction(afterSave as any, afterSave?._schemaVersion)).length === 0);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("Test 10 (effectiveCompactionThreshold):");
{
  const t = (a: number, b: number, c: number, d: number) => effectiveCompactionThreshold({
    active: { compactionThreshold: a }, t1: { compactionThreshold: b }, t2: { compactionThreshold: c }, t3: { compactionThreshold: d },
  });
  check("all off -> 0", t(0, 0, 0, 0) === 0, t(0, 0, 0, 0));
  check("only t1 -> that value", t(0, 60, 0, 0) === 60, t(0, 60, 0, 0));
  check("only active -> that value", t(50, 0, 0, 0) === 50, t(50, 0, 0, 0));
  check("lowest enabled wins (incl. active)", t(45, 60, 50, 0) === 45, t(45, 60, 50, 0));
  check("negatives ignored", t(0, -5, 70, 0) === 70, t(0, -5, 70, 0));
  check("100 is valid", t(0, 0, 0, 100) === 100, t(0, 0, 0, 100));
  check("default config -> 0", effectiveCompactionThreshold(getDefaultConfig()) === 0);
}

console.log("Test 11 (migration extra edges):");
{
  check("100 (non-default) not migrated", migrateSavedCompaction({ t1: { compactionThreshold: 100 } } as any, 2).t1 === undefined);
  check("0 already off not re-reported", migrateSavedCompaction({ t1: { compactionThreshold: 0 } } as any, 2).t1 === undefined);
  check("negative not migrated", migrateSavedCompaction({ t1: { compactionThreshold: -3 } } as any, 2).t1 === undefined);
  check("schema 3 never migrates old default", migrateSavedCompaction({ t1: { compactionThreshold: 65 } } as any, 3).t1 === undefined);
  const a = migrateSavedCompaction({ t1: { compactionThreshold: 65 } } as any, 2);
  const b = migrateSavedCompaction({ t1: { compactionThreshold: 65 } } as any, 2);
  check("idempotent", JSON.stringify(a) === JSON.stringify(b), [a, b]);
}

console.log("Test 12 (several changes in one session stay in main menu):");
{
  const h = makeHarness(["__AUTO__", "__DEDUPE__", "Done"]);
  await runConfigUI(h.ctx, h.rt as any);
  check("both toggles applied", h.config.autoSpawn === false && h.config.dedupeTasks === false,
    { autoSpawn: h.config.autoSpawn, dedupeTasks: h.config.dedupeTasks });
  check("main re-rendered each time (3 calls)", h.calls.length === 3 && h.calls.every(c => c.title === "Configure Trimegisto:"), h.calls.map(c => c.title));
}

console.log("Test 13 (empty selection from main closes):");
{
  const h = makeHarness([""]);
  await runConfigUI(h.ctx, h.rt as any);
  check("empty string treated as cancel", h.calls.length === 1, h.calls.map(c => c.title));
}

console.log("Test 14 (Esc in compaction picker returns to tier submenu):");
{
  const h = makeHarness(["__T1__", "__COMPACT__", undefined, "__BACK__", "Done"]);
  await runConfigUI(h.ctx, h.rt as any);
  const titles = h.calls.map(c => c.title);
  check("t1 threshold untouched", h.config.t1.compactionThreshold === 0, h.config.t1.compactionThreshold);
  check("sequence main -> tier -> compact -> tier -> main",
    titles[0] === "Configure Trimegisto:" && titles[1]!.startsWith("Configure T1:") && titles[2]!.startsWith("Compaction for") && titles[3]!.startsWith("Configure T1:") && titles[4] === "Configure Trimegisto:",
    titles);
}

console.log("Test 15 (redundant-models submenu stays open after Add attempt):");
{
  const h = makeHarness(["__T1__", "__REDUNDANT__", "__ADD__", "__BACK__", "__BACK__", "Done"]);
  await runConfigUI(h.ctx, h.rt as any);
  const titles = h.calls.map(c => c.title);
  check("sequence main -> tier -> redundant -> redundant -> tier -> main",
    titles[0] === "Configure Trimegisto:" && titles[1]!.startsWith("Configure T1:") && titles[2]!.startsWith("Redundant models for") && titles[3]!.startsWith("Redundant models for") && titles[4]!.startsWith("Configure T1:") && titles[5] === "Configure Trimegisto:",
    titles);
}

console.log("Test 16 (sanitizeLoopSupervisorConfig drops legacy loop keys):");
{
  const defaults = { enabled: true, maxSpawnDepth: 5, maxAgentTurns: 50, turnLimitGrace: 15, dedupeCrossAgent: false };
  const legacy = {
    enabled: true, maxSpawnDepth: 7, maxAgentTurns: 20, turnLimitGrace: 11, dedupeCrossAgent: true,
    maxRepeatedOutputs: 3, tierCooldownMs: 60000, similarityThreshold: 0.9, minRepeatableOutputChars: 60,
  };
  const out = sanitizeLoopSupervisorConfig(legacy, defaults);
  check("only guard keys remain", JSON.stringify(Object.keys(out).sort()) === JSON.stringify(["dedupeCrossAgent", "enabled", "maxAgentTurns", "maxSpawnDepth", "turnLimitGrace"]), Object.keys(out));
  check("valid values preserved", out.maxSpawnDepth === 7 && out.maxAgentTurns === 20 && out.turnLimitGrace === 11 && out.dedupeCrossAgent === true);
  check("removed keys gone", !("maxRepeatedOutputs" in out) && !("tierCooldownMs" in out) && !("similarityThreshold" in out));
  const bad = sanitizeLoopSupervisorConfig({ maxAgentTurns: "twenty" as any, maxSpawnDepth: NaN as any, dedupeCrossAgent: 1 as any }, defaults);
  check("wrong types fall back to defaults", bad.maxAgentTurns === 50 && bad.maxSpawnDepth === 5 && bad.dedupeCrossAgent === false, bad);
  const empty = sanitizeLoopSupervisorConfig(undefined, defaults);
  check("undefined saved -> defaults", empty.maxAgentTurns === 50 && empty.enabled === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
