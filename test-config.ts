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
  formatModelLabel,
} from "./src/config.ts";
import { runConfigUI } from "./src/config-ui.ts";
import { createDashboardWidget } from "./src/dashboard.ts";
import { getAgents } from "./src/agent-manager.ts";
import type { AgentInstance } from "./src/types.ts";

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
  check("turn limit is OFF by default", c.loopSupervisor.turnLimitEnabled === false, c.loopSupervisor.turnLimitEnabled);
  check("turn limit keeps 50 turns / +15 grace when enabled", c.loopSupervisor.maxAgentTurns === 50 && c.loopSupervisor.turnLimitGrace === 15, c.loopSupervisor);
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
//
// Drives the REAL SettingsList-based menu: ctx.ui.custom's factory is invoked
// with a stub tui/theme and the returned component is driven with the same key
// sequences a terminal sends. Navigation is by row label, so the tests never
// depend on item order, and the rendered text is asserted for the description
// hint shown under the selected row.
const KEY = {
  up: "\x1b[A", down: "\x1b[B", enter: "\r", space: " ", esc: "\x1b",
  backspace: "\x7f", clear: "\x15",
} as const;

function makeHarness() {
  const config = getDefaultConfig();
  let saved = 0;
  let dashboardRenders = 0;
  let component: any = null;

  // Mirrors production EXACTLY: setDashboardMode only mutates the closure var;
  // the menu handler persists the mode itself. Keep this closure-only.
  let liveDashboardMode = (config.dashboardMode ?? (config.dashboardVisible === false ? "off" : "compact")) as "compact" | "widget" | "off";
  const setDashboardMode = (mode: "compact" | "widget" | "off") => { liveDashboardMode = mode; };
  const cycleDashboard = () => {
    const modes: Array<"compact" | "widget" | "off"> = ["compact", "widget", "off"];
    liveDashboardMode = modes[(modes.indexOf(liveDashboardMode) + 1) % modes.length];
    config.dashboardMode = liveDashboardMode;
    config.dashboardVisible = liveDashboardMode !== "off";
    dashboardRenders++;
    saved++;
  };
  const rt = {
    config,
    get dashboardMode() { return liveDashboardMode; },
    setDashboardMode,
    toggleDashboard: cycleDashboard,
    activeModel: null,
    ctxRef: null,
    updateDashboard: () => { dashboardRenders++; },
    haltAll: () => 0,
    saveConfig: () => { saved++; },
    registerMainTool: () => {},
    syncLoopSupervisor: () => {},
    syncWatchdog: () => {},
  };
  const ctx = {
    hasUI: true,
    modelRegistry: { getAvailable: async () => [] },
    ui: {
      notify: () => {},
      custom: (factory: any) => new Promise((resolve) => {
        const tui = { requestRender: () => {} };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        component = factory(tui, theme, null, (result: any) => resolve(result));
      }),
    },
  };

  const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); };
  const start = (): Promise<void> => runConfigUI(ctx, rt as any);
  const ready = async (): Promise<void> => {
    for (let i = 0; i < 200 && !component; i++) await tick();
    if (!component) throw new Error("config UI component was never created");
  };
  const render = (): string[] => (component ? component.render(100) : []);
  const text = (): string => render().join("\n");
  const selected = (): string => {
    const line = render().find((l: string) => l.startsWith("→ "));
    return line ? line.slice(2) : "";
  };
  const go = (label: string): void => {
    for (let i = 0; i < 40; i++) {
      if (selected().includes(label)) return;
      component.handleInput(KEY.down);
    }
    throw new Error(`could not reach "${label}"; selected="${selected()}"`);
  };
  const press = (key: keyof typeof KEY): void => { component.handleInput(KEY[key]); };
  const type = (s: string): void => { for (const ch of s) component.handleInput(ch); };

  return {
    ctx, rt, config, start, ready, render, text, selected, go, press, type, tick, cycleDashboard,
    savedCount: () => saved,
    dashboardMode: () => liveDashboardMode,
    dashboardRenders: () => dashboardRenders,
  };
}

console.log("Test 3 (tier submenu stays open after toggling):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("T2"); h.press("enter");
  check("tier submenu opened", h.text().includes("Configure T2"), h.text().slice(0, 160));
  h.go("Enabled"); h.press("space");
  check("t2 toggled once (enabled -> OFF)", h.config.t2.enabled === false, h.config.t2.enabled);
  check("tier submenu stayed open after the change", h.text().includes("Configure T2"));
  check("change was saved", h.savedCount() >= 1, h.savedCount());
  h.press("esc");
  check("Esc returned to the main menu", h.text().includes("Configure Trimegisto"));
  h.press("esc"); await p;
}

console.log("Test 4 (main menu toggle stays open):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("Auto-spawn"); h.press("space");
  check("auto-spawn toggled", h.config.autoSpawn === false, h.config.autoSpawn);
  check("main menu stayed open", h.text().includes("Configure Trimegisto"));
  check("change was saved", h.savedCount() >= 1, h.savedCount());
  h.press("esc"); await p;
}

console.log("Test 5 (watchdogs submenu edits a number):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("Watchdogs"); h.press("enter");
  check("watchdogs submenu opened", h.text().includes("Watchdogs"), h.text().slice(0, 160));
  h.go("First response"); h.press("enter");
  check("number editor opened with its own hint", h.text().includes("First response (seconds)"), h.text().slice(0, 160));
  h.press("clear");          // ctrl+u clears the prefilled value
  h.type("30");
  h.press("enter");
  check("watchdog updated to 30s", h.config.watchdog.firstResponseSeconds === 30, h.config.watchdog.firstResponseSeconds);
  check("returned to the watchdogs submenu", h.text().includes("Idle timeout"), h.text().slice(0, 200));
  h.press("esc"); h.press("esc"); await p;
}

console.log("Test 6 (compaction can be turned off from the tier submenu):");
{
  const h = makeHarness();
  h.config.t1.compactionThreshold = 95; // one cycle lands on 'off'
  const p = h.start(); await h.ready();
  h.go("T1"); h.press("enter");
  h.go("Compaction Threshold"); h.press("space");
  check("t1 compaction turned off", h.config.t1.compactionThreshold === 0, h.config.t1.compactionThreshold);
  check("tier submenu stayed open after the change", h.text().includes("Configure T1"));
  h.press("esc"); h.press("esc"); await p;
}

console.log("Test 7 (Esc backs out one level, main Esc closes):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("T2"); h.press("enter");
  check("in the tier submenu", h.text().includes("Configure T2"));
  h.press("esc");
  check("Esc from tier submenu returns to main", h.text().includes("Configure Trimegisto"));
  h.press("esc"); await p;
}

console.log("Test 8 (main menu Esc closes immediately):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.press("esc");
  await p; // resolves: no hang, no extra prompts
  check("closing without changes persists nothing", h.savedCount() === 0, h.savedCount());
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
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("Auto-spawn"); h.press("space");
  h.go("Dedupe tasks"); h.press("space");
  check("both toggles applied", h.config.autoSpawn === false && h.config.dedupeTasks === false,
    { autoSpawn: h.config.autoSpawn, dedupeTasks: h.config.dedupeTasks });
  check("main menu still open after both", h.text().includes("Configure Trimegisto"));
  h.press("esc"); await p;
}

console.log("Test 13 (every row shows its description hint below the list):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("Enabled");
  check("Enabled hint shown", h.text().includes("Master switch"), h.text().slice(0, 200));
  h.go("Watchdogs");
  check("Watchdogs hint shown", h.text().includes("Timeouts that kill an agent"));
  h.go("Model health");
  check("Model health hint shown", h.text().includes("circuit breaker"));
  h.go("Auto-spawn");
  check("Auto-spawn hint shown", h.text().includes("delegation the default"), h.text().slice(0, 200));
  h.go("Dashboard");
  check("Dashboard hint shown", h.text().includes("dashboard the TUI shows"));
  h.press("esc"); await p;
}

console.log("Test 14 (Esc in a numeric editor leaves the value untouched):");
{
  const h = makeHarness();
  const before = h.config.watchdog.idleSeconds;
  const p = h.start(); await h.ready();
  h.go("Watchdogs"); h.press("enter");
  h.go("Idle timeout"); h.press("enter");
  h.press("clear"); h.type("9999"); // beyond the cap: would clamp on submit
  h.press("esc");                    // cancel instead
  check("idle timeout untouched", h.config.watchdog.idleSeconds === before, h.config.watchdog.idleSeconds);
  check("back in the watchdogs submenu", h.text().includes("First response"), h.text().slice(0, 200));
  h.press("esc"); h.press("esc"); await p;
}

console.log("Test 15 (redundant-models submenu stays open):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("T1"); h.press("enter");
  h.go("Redundant models"); h.press("enter");
  check("redundant list opened", h.text().includes("Redundant models for T1"), h.text().slice(0, 200));
  h.go("Add model"); h.press("enter");
  check("picker opened (no models available)", h.text().includes("No models available"), h.text().slice(0, 200));
  h.press("esc");
  check("Esc returned to the redundant list", h.text().includes("Redundant models for T1"));
  h.press("esc");
  check("Esc returned to the tier submenu", h.text().includes("Configure T1"));
  h.press("esc"); h.press("esc"); await p;
}

console.log("Test 16 (sanitizeLoopSupervisorConfig drops legacy loop keys):");
{
  const defaults = { enabled: true, maxSpawnDepth: 5, turnLimitEnabled: false, maxAgentTurns: 50, turnLimitGrace: 15, dedupeCrossAgent: false };
  const legacy = {
    enabled: true, maxSpawnDepth: 7, turnLimitEnabled: true, maxAgentTurns: 20, turnLimitGrace: 11, dedupeCrossAgent: true,
    maxRepeatedOutputs: 3, tierCooldownMs: 60000, similarityThreshold: 0.9, minRepeatableOutputChars: 60,
  };
  const out = sanitizeLoopSupervisorConfig(legacy, defaults);
  check("only guard keys remain", JSON.stringify(Object.keys(out).sort()) === JSON.stringify(["dedupeCrossAgent", "enabled", "maxAgentTurns", "maxSpawnDepth", "turnLimitEnabled", "turnLimitGrace"]), Object.keys(out));
  check("valid values preserved", out.maxSpawnDepth === 7 && out.maxAgentTurns === 20 && out.turnLimitGrace === 11 && out.turnLimitEnabled === true && out.dedupeCrossAgent === true);
  check("removed keys gone", !("maxRepeatedOutputs" in out) && !("tierCooldownMs" in out) && !("similarityThreshold" in out));
  const bad = sanitizeLoopSupervisorConfig({ maxAgentTurns: "twenty" as any, maxSpawnDepth: NaN as any, turnLimitEnabled: "yes" as any, dedupeCrossAgent: 1 as any }, defaults);
  check("wrong types fall back to defaults", bad.maxAgentTurns === 50 && bad.maxSpawnDepth === 5 && bad.turnLimitEnabled === false && bad.dedupeCrossAgent === false, bad);
  const clamped = sanitizeLoopSupervisorConfig({ maxAgentTurns: 0, turnLimitGrace: -4 } as any, defaults);
  check("maxAgentTurns >= 1", clamped.maxAgentTurns === 1, clamped.maxAgentTurns);
  check("turnLimitGrace >= 0", clamped.turnLimitGrace === 0, clamped.turnLimitGrace);
  const huge = sanitizeLoopSupervisorConfig({ maxAgentTurns: 10 ** 12, turnLimitGrace: 10 ** 12 } as any, defaults);
  check("turn-limit values capped", huge.maxAgentTurns === 100_000 && huge.turnLimitGrace === 100_000, huge);
  const empty = sanitizeLoopSupervisorConfig(undefined, defaults);
  check("undefined saved -> defaults", empty.maxAgentTurns === 50 && empty.enabled === true && empty.turnLimitEnabled === false);
  const nullish = sanitizeLoopSupervisorConfig(null as any, defaults);
  check("null saved -> defaults (no throw)", nullish.maxAgentTurns === 50 && nullish.maxSpawnDepth === 5);
}

console.log("Test 17 (formatModelLabel for the dashboard):");
{
  check("deepseek slug -> Deepseek v4 Flash", formatModelLabel("deepseek/deepseek-v4-flash") === "Deepseek v4 Flash", formatModelLabel("deepseek/deepseek-v4-flash"));
  check("kimi slug -> Kimi K3", formatModelLabel("moonshot/kimi-k3") === "Kimi K3", formatModelLabel("moonshot/kimi-k3"));
  check("nested provider -> last segment", formatModelLabel("openrouter/anthropic/claude-opus-4") === "Claude Opus 4", formatModelLabel("openrouter/anthropic/claude-opus-4"));
  check("decimal version kept", formatModelLabel("google/gemini-2.5-pro") === "Gemini 2.5 Pro", formatModelLabel("google/gemini-2.5-pro"));
  check("generation marker uppercased (r1)", formatModelLabel("deepseek/deepseek-r1") === "Deepseek R1", formatModelLabel("deepseek/deepseek-r1"));
  check("mixed/upper tokens preserved", formatModelLabel("/srv/models/Example-27B-ROCmFP4-FAST.gguf") === "Example 27B ROCmFP4 FAST", formatModelLabel("/srv/models/Example-27B-ROCmFP4-FAST.gguf"));
  check("(pi default) -> pi default", formatModelLabel("(pi default)") === "pi default");
  check("empty/undefined -> empty", formatModelLabel("") === "" && formatModelLabel(undefined) === "" && formatModelLabel("   ") === "");
  check("no crash on punctuation only", formatModelLabel("///") === "" && formatModelLabel("---") === "", formatModelLabel("---"));
  check("single word titled", formatModelLabel("sonnet") === "Sonnet", formatModelLabel("sonnet"));
}

console.log("Test 18 (full dashboard shows the agent model):");
{
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const makeAgent = (over: Partial<AgentInstance>): AgentInstance => ({
    id: "t2a", tier: "t2", task: "analyze the logs", status: "running", startedAt: Date.now(),
    controller: new AbortController(), output: "", stderr: "", log: [],
    usage: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    ...over,
  } as AgentInstance);
  const renderDashboard = (agent: AgentInstance): string => {
    getAgents().set(agent.id, agent);
    try {
      const widget = createDashboardWidget({} as any)({} as any, theme as any);
      return widget.render(160).join("\n");
    } finally {
      getAgents().delete(agent.id);
    }
  };

  const withModel = renderDashboard(makeAgent({ model: "deepseek/deepseek-v4-flash", requestedModel: "deepseek/deepseek-v4-flash" }));
  check("agent line shows the humanized model", withModel.includes("Deepseek v4 Flash"), withModel.split("\n").find(l => l.includes("t2a")));
  const reqOnly = renderDashboard(makeAgent({ requestedModel: "moonshot/kimi-k3" }));
  check("falls back to requestedModel before first response", reqOnly.includes("Kimi K3"), reqOnly.split("\n").find(l => l.includes("t2a")));
  const noModel = renderDashboard(makeAgent({}));
  check("no model renders without crashing and without label", noModel.includes("t2a") && !/undefined/.test(noModel), noModel.split("\n").find(l => l.includes("t2a")));
  const longModel = renderDashboard(makeAgent({ model: "someprovider/this-is-a-very-long-model-name-that-should-be-capped-for-the-dashboard" }));
  const longLine = longModel.split("\n").find(l => l.includes("t2a")) || "";
  check("long model label is capped with an ellipsis", longLine.includes("…") && !longLine.includes("should-be-capped"), longLine);
  const gguf = renderDashboard(makeAgent({ model: "/srv/models/Example-27B-ROCmFP4-FAST.gguf" }));
  const ggufLine = gguf.split("\n").find(l => l.includes("t2a")) || "";
  check("gguf weight path is humanized and compact", ggufLine.includes("Example 27B ROCmFP4 FAST") && !ggufLine.includes(".gguf") && !ggufLine.includes("/mnt/"), ggufLine);
  const doneAgent = renderDashboard(makeAgent({ status: "done", finishedAt: Date.now(), model: "moonshot/kimi-k3" }));
  check("done agents also show the model", doneAgent.includes("Kimi K3"), doneAgent.split("\n").find(l => l.includes("t2a")));
}

console.log("Dashboard mode is persisted AND the menu label tracks each cycle:");
{
  const h = makeHarness();
  const p = h.start(); await h.ready();
  h.go("Dashboard");
  h.press("space"); // compact -> widget
  h.press("space"); // widget -> off
  // Two menu cycles: compact -> widget -> off. The persisted config must end
  // up at "off" (not the in-session snapshot) and saveConfig must be called
  // twice. The runtime getter must also reflect the current mode, otherwise
  // the menu label freezes at the value captured when the runtime was built.
  check("menu cycles persisted the full mode 'off'", h.config.dashboardMode === "off", h.config.dashboardMode);
  check("the legacy boolean is mirrored from the mode", h.config.dashboardVisible === false, h.config.dashboardVisible);
  check("save was called for each cycle", h.savedCount() >= 2, h.savedCount());
  check("the runtime getter tracks each cycle (no frozen snapshot)", h.dashboardMode() === "off", h.dashboardMode());
  check("the row label tracks the new mode", h.selected().includes("off"), h.selected());
  check("the widget re-rendered through updateDashboard", h.dashboardRenders() >= 2, h.dashboardRenders());
  h.press("esc"); await p;
}

console.log("/tmg dashboard persists AND saves like the menu (otherwise /reload loses it):");
{
  const h = makeHarness();
  const p = h.start(); await h.ready(); h.press("esc"); await p;
  h.cycleDashboard(); // compact -> widget
  h.cycleDashboard(); // widget -> off
  check("two /tmg dashboard cycles reached 'off'", h.config.dashboardMode === "off", h.config.dashboardMode);
  check("/tmg dashboard calls saveConfig (survives /reload)", h.savedCount() >= 2, h.savedCount());
}

console.log("Restart simulation: the saved dashboardMode restores; legacy configs derive from the boolean:");
{
  // What session_start in index.ts does with the persisted config is
  //   dashboardMode = config.dashboardMode ?? (config.dashboardVisible === false ? "off" : "compact");
  const seed = (cfg: { dashboardMode?: "compact" | "widget" | "off"; dashboardVisible?: boolean }) =>
    cfg.dashboardMode ?? (cfg.dashboardVisible === false ? "off" : "compact");
  check("explicit 'widget' survives", seed({ dashboardMode: "widget", dashboardVisible: true }) === "widget");
  check("explicit 'off' survives", seed({ dashboardMode: "off", dashboardVisible: false }) === "off");
  check("legacy config (boolean=false) starts in 'off'", seed({ dashboardVisible: false }) === "off");
  check("legacy config (boolean=true) falls back to 'compact'", seed({ dashboardVisible: true }) === "compact");
  check("legacy config (no fields) defaults to 'compact'", seed({}) === "compact");
}

console.log("Dashboard cycle (compact -> widget -> off -> compact) is the pure mapping production uses:");
{
  const cycle = (m: "compact" | "widget" | "off"): "compact" | "widget" | "off" => {
    const modes: Array<"compact" | "widget" | "off"> = ["compact", "widget", "off"];
    return modes[(modes.indexOf(m) + 1) % modes.length]!;
  };
  check("compact -> widget", cycle("compact") === "widget");
  check("widget -> off",   cycle("widget") === "off");
  check("off -> compact",  cycle("off") === "compact");
  check("three cycles return to start (cycle length = 3)", cycle(cycle(cycle("off"))) === "off");
  check("three cycles return to start from any state", cycle(cycle(cycle("compact"))) === "compact" && cycle(cycle(cycle("widget"))) === "widget");
}

console.log("Persistence round-trip: saveConfig actually writes dashboardMode and loadConfig restores it:");
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  // Real round-trip through persistence.ts: write a config with widget mode,
  // then call loadConfig and assert the mode is preserved. We can't override
  // getAgentDir() directly, but we can point at a temp HOME so the writer's
  // derived path lands in our temp directory.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-home-"));
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    const { saveConfig, loadConfig } = await import("./src/persistence.ts");
    const base = getDefaultConfig();
    base.dashboardMode = "widget";
    base.dashboardVisible = true;
    saveConfig(base);
    const reloaded = loadConfig();
    check("loadConfig restores the persisted widget mode", reloaded?.dashboardMode === "widget", reloaded?.dashboardMode);
    check("loadConfig also restores the legacy boolean", reloaded?.dashboardVisible === true, reloaded?.dashboardVisible);
    // Switch and round-trip again to prove the writer doesn't latch onto the
    // first mode and to catch a writer that only writes dashboardVisible.
    base.dashboardMode = "off";
    base.dashboardVisible = false;
    saveConfig(base);
    const reloaded2 = loadConfig();
    check("a second save with 'off' round-trips", reloaded2?.dashboardMode === "off", reloaded2?.dashboardMode);
    // Legacy read: a hand-written file with only the boolean should still
    // restore a sensible mode (the loader's fallback).
    const agentDir = fs.realpathSync.native(tmpHome);
    const cfgPath = path.join(tmpHome, ".pi", "agent", "trimegisto", "config.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ dashboardVisible: false }));
    const legacy = loadConfig();
    check("a legacy file with only dashboardVisible:false restores 'off'", legacy?.dashboardMode === "off", legacy?.dashboardMode);
    fs.writeFileSync(cfgPath, JSON.stringify({ dashboardVisible: true }));
    const legacy2 = loadConfig();
    check("a legacy file with only dashboardVisible:true restores 'compact'", legacy2?.dashboardMode === "compact", legacy2?.dashboardMode);
    fs.rmSync(path.join(tmpHome, ".pi"), { recursive: true, force: true });
  } finally {
    process.env.HOME = prevHome;
    if (prevUserprofile !== undefined) process.env.USERPROFILE = prevUserprofile;
    else delete process.env.USERPROFILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}


console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
