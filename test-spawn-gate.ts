/**
 * Trimegisto - spawn gate integration test
 *
 * Run: node --experimental-strip-types test-spawn-gate.ts
 *
 * THE REGRESSION UNDER TEST
 * -------------------------
 * The capacity gate lived only in the tool path (`canSpawnPooled` / the plan
 * gate). A MANUAL spawn (`@t0 <task>` or `/t0 <task>`) calls `doLaunch`, which
 * handed the work straight to `launchAgent` with no capacity check. With the
 * principal-slot semantics that meant `active.maxParallel = 1` advertised
 * "principal only — no spawn slots" in the config while `@t0` still launched an
 * agent — the promise and the behaviour disagreed.
 *
 * This drives the REAL extension factory with the REAL config loader, pointed
 * at a temporary agent dir holding `active.maxParallel = 1`, fires the real
 * `input` handler and asserts the manual spawn is refused. It never launches a
 * subprocess: with the gate working, `doLaunch` returns before `launchAgent`.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-spawn-gate-"));
  fs.mkdirSync(path.join(dir, "trimegisto"), { recursive: true });
  fs.writeFileSync(path.join(dir, "trimegisto", "config.json"), JSON.stringify(config));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function makeFakePi() {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const notifications: Array<{ message: string; level?: string }> = [];
  const noop = () => {};
  const pi: any = {
    on: (event: string, fn: (e: any, c: any) => any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn);
    },
    registerTool: noop, registerCommand: noop, registerShortcut: noop, registerFlag: noop,
    registerEntryRenderer: noop, registerMessageRenderer: noop, appendEntry: noop, sendMessage: noop,
    setActiveTools: noop, events: { on: noop, emit: noop },
  };
  return { pi, handlers, notifications };
}

function makeCtx(notifications: Array<{ message: string; level?: string }>) {
  return {
    cwd: process.cwd(), hasUI: false, mode: "print", model: {},
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    compact: async () => {},
    ui: {
      notify: (message: string, level?: string) => { notifications.push({ message, level }); },
      setStatus: () => {},
    },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
  } as any;
}

const dir1 = withConfig({ active: { maxParallel: 1 }, enabled: true, autoSpawn: true });
const { pi, handlers, notifications } = makeFakePi();
const mod: any = await import("./src/index.ts");
mod.default(pi);

const sessionStart = handlers.get("session_start");
const input = handlers.get("input");
check("the extension registers an input handler", !!input && input.length > 0);

// Boot the session so the saved config is loaded (the tool description and the
// runtime config are both refreshed there).
await sessionStart![sessionStart!.length - 1]({}, makeCtx(notifications));

const { getAgents } = await import("./src/agent-manager.ts");
check("no agents are registered before the manual spawn", getAgents().size === 0, getAgents().size);

const res: any = await input![input!.length - 1]({ text: "@t0 rewrite the deployment script" }, makeCtx(notifications));
check("the input event is handled (not passed through)", res?.action === "handled", res);
check("the manual @t0 spawn did NOT launch an agent", getAgents().size === 0, getAgents().size);
const refused = notifications.some(n => n.level === "error" && /cannot spawn/i.test(n.message));
check("the user gets an actionable refusal", refused, notifications.map(n => `${n.level}:${n.message}`).join(" | "));
check("the refusal explains the principal-only slot", notifications.some(n => /main session occupies the only t0 slot/i.test(n.message)), notifications);

fs.rmSync(dir1, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
