/**
 * Trimegisto - sticky-halt recovery regression test
 *
 * Run: node --experimental-strip-types test/test-halt-recovery.ts
 *
 * THE REGRESSION UNDER TEST
 * -------------------------
 * `/tmg disable` calls `haltAll()`, which sets the STICKY global halt flag.
 * `/tmg enable` used to set `config.enabled = true` but never cleared that flag.
 *
 * The wave scheduler asks `isHalted()` BEFORE it calls `launchWave()`, and the
 * only caller of `clearHalted()` is `launchAgent()` (reached from inside
 * `launchWave`). So once `halted` was set, the tool path could never clear it:
 * every `trimegisto` batch settled with
 * "stopped (killed/halted) between waves" and launched nothing — the exact
 * `not_launched` verdict reported in the field.
 *
 * This drives the REAL extension factory, fires the REAL `/tmg` command
 * handlers (`disable` followed by `enable`) and asserts the sticky halt is
 * lifted. Before the fix the second check fails because the flag survives.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

/** Fresh temp agent dir carrying a saved config, and the env that points at it. */
function withConfig(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-halt-recovery-"));
  fs.mkdirSync(path.join(dir, "trimegisto"), { recursive: true });
  fs.writeFileSync(path.join(dir, "trimegisto", "config.json"), JSON.stringify(config));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

const notifications: Array<{ message: string; level?: string }> = [];
function makeCtx() {
  return {
    cwd: process.cwd(), hasUI: false, mode: "print", model: {},
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    compact: async () => {},
    ui: {
      notify: (message: string, level?: string) => { notifications.push({ message, level }); },
      setStatus: () => {},
      setFooter: () => {},
      setWidget: () => {},
    },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
  } as any;
}

const dir = withConfig({ enabled: true, autoSpawn: true });
const handlers = new Map<string, Array<(e: any, c: any) => any>>();
const commands = new Map<string, any>();
const noop = () => {};

const pi: any = {
  on: (event: string, fn: (e: any, c: any) => any) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(fn);
  },
  registerTool: noop,
  registerCommand: (name: string, opts: any) => { commands.set(name, opts); },
  registerShortcut: noop,
  registerFlag: noop,
  registerEntryRenderer: noop,
  registerMessageRenderer: noop,
  appendEntry: noop,
  sendMessage: noop,
  setActiveTools: noop,
  events: { on: noop, emit: noop },
};

const mod: any = await import("../src/index.ts");
mod.default(pi);

const { isHalted } = await import("../src/agent-manager.ts");

check("the extension registered the /tmg command", commands.has("tmg"));
check("no halt is in force at boot", isHalted() === false, { isHalted: isHalted() });

// Boot the session so the saved config is loaded by the real factory.
const sessionStart = handlers.get("session_start");
if (sessionStart && sessionStart.length > 0) {
  await sessionStart[sessionStart.length - 1]({}, makeCtx());
}

const tmg = commands.get("tmg");
check("the /tmg command exposes a handler", typeof tmg?.handler === "function");

// `/tmg disable` -> setEnabled(false) -> haltAll(): the sticky flag is set.
await tmg.handler("disable", makeCtx());
check("disable() sets the sticky halt", isHalted() === true, { isHalted: isHalted() });

// `/tmg enable` must lift the halt; otherwise the tool path is bricked forever.
await tmg.handler("enable", makeCtx());
check("enable() clears the sticky halt", isHalted() === false, { isHalted: isHalted() });
check("enable() notifies the user", notifications.some(n => /Trimegisto: ON/.test(n.message)), notifications);

// `/tmg halt` alone must not brick the next enable either.
await tmg.handler("halt", makeCtx());
check("halt() sets the sticky halt", isHalted() === true, { isHalted: isHalted() });
await tmg.handler("enable", makeCtx());
check("a later enable() clears a bare halt", isHalted() === false, { isHalted: isHalted() });

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
