/**
 * Trimegisto - sequential active spawn integration test
 *
 * Run: node --experimental-strip-types test-sequential-active.ts
 *
 * THE FEATURE UNDER TEST
 * ----------------------
 * `sequential: true` on a trimegisto task forces ONE sub-agent onto the pi
 * ACTIVE model even when the active tier is disabled and/or has no free slot
 * (maxParallel = 1, principal-only). The coordinator blocks awaiting the
 * result, so the agent never runs concurrently with the principal — the
 * `enabled` gate and the principal-slot capacity math are wrong for this
 * awaited case and must be bypassed (the model-health breaker is kept).
 *
 * This drives the REAL extension factory with the REAL config loader, pointed
 * at a temporary agent dir holding `active.enabled = false` and
 * `active.maxParallel = 1`, and calls the real registered `trimegisto` tool.
 * It never launches a real subprocess: `process.argv[1]` is pointed at a
 * missing script and `PATH` at an empty dir, so `getPiInvocation` falls back
 * to the `pi` binary and the spawn fails with ENOENT — the agent is
 * registered and the launch path runs, but no child process ever starts.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-sequential-"));
  fs.mkdirSync(path.join(dir, "trimegisto"), { recursive: true });
  fs.writeFileSync(path.join(dir, "trimegisto", "config.json"), JSON.stringify(config));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function makeFakePi() {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const tools = new Map<string, any>();
  const notifications: Array<{ message: string; level?: string }> = [];
  const noop = () => {};
  const pi: any = {
    on: (event: string, fn: (e: any, c: any) => any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn);
    },
    registerTool: (t: any) => { tools.set(t.name, t); },
    registerCommand: noop, registerShortcut: noop, registerFlag: noop,
    registerEntryRenderer: noop, registerMessageRenderer: noop, appendEntry: noop, sendMessage: noop,
    setActiveTools: noop, events: { on: noop, emit: noop },
  };
  return { pi, handlers, tools, notifications };
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

// Active tier DISABLED and principal-only (maxParallel = 1): the config where
// every normal active spawn must be refused, and only a sequential one may run.
const dir1 = withConfig({
  active: { enabled: false, maxParallel: 1 },
  t3: { enabled: true, model: "test/t3-model", maxParallel: 2 },
  enabled: true,
  autoSpawn: true,
});
const { pi, handlers, tools, notifications } = makeFakePi();
const mod: any = await import("./src/index.ts");
mod.default(pi);

const sessionStart = handlers.get("session_start");
const input = handlers.get("input");
check("the extension registers an input handler", !!input && input.length > 0);

// Boot the session so the saved config is loaded.
await sessionStart![sessionStart!.length - 1]({}, makeCtx(notifications));

const tool = tools.get("trimegisto");
check("the extension registers the trimegisto tool", !!tool);
const seqSchema = tool?.parameters?.properties?.tasks?.items?.properties?.sequential;
check("the tool schema exposes the optional sequential parameter", !!seqSchema && seqSchema.type === "boolean", seqSchema);

const { getAgents } = await import("./src/agent-manager.ts");

// Make sure no real subprocess can start: getPiInvocation() falls back to the
// `pi` binary when process.argv[1] is not an existing script, and with an
// empty PATH that binary cannot be found, so every spawn dies with ENOENT.
process.argv[1] = path.join(os.tmpdir(), "tmg-sequential-no-such-script");
process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-sequential-empty-path-"));

const text = (res: any): string => res?.content?.[0]?.text ?? "";

// ── (a) sequential:true launches despite active.enabled=false, maxParallel=1 ──
const resA: any = await tool.execute("call-a", {
  goal: "QA the auth fix",
  tasks: [{
    task: "Adversarial QA of the auth flow: re-derive the expected behavior and report mismatches",
    sequential: true,
    context: "fresh",
  }],
}, undefined, undefined, makeCtx(notifications));
check("(a) the sequential call is accepted (not an error)", resA && resA.isError !== true, text(resA));
check("(a) the tool reports wave 1/1 running", /Wave 1\/1 running/.test(text(resA)), text(resA));
check("(a) the sequential node sits alone in its own wave", JSON.stringify(resA?.details?.plan?.waves) === JSON.stringify([[1]]), resA?.details?.plan?.waves);
check("(a) the sequential spawn launched ONE agent despite active.enabled=false and maxParallel=1", getAgents().size === 1, getAgents().size);
const agentA = [...getAgents().values()][0];
check("(a) the agent runs on the active tier", agentA?.tier === "active", agentA?.tier);

// ── (b) a normal active spawn is still refused under the same config ──
const resB: any = await tool.execute("call-b", {
  goal: "keep going with the billing work",
  tasks: [{ task: "Refactor the billing module retry logic", tier: "active" }],
}, undefined, undefined, makeCtx(notifications));
check("(b) the normal active spawn is refused", resB && resB.isError === true, text(resB));
check("(b) the refusal explains the active tier (principal-only cap or disabled)", /capacity is 0|principal-only|not available/i.test(text(resB)), text(resB));
check("(b) no extra agent was registered", getAgents().size === 1, getAgents().size);

// ── (c) non-sequential behaviour is unchanged ──────────────────────────────
// (c1) A manual @t0 still hits the principal-only refusal through doLaunch.
const before = getAgents().size;
const resManual: any = await input![input!.length - 1]({ text: "@t0 rewrite the deployment script" }, makeCtx(notifications));
check("(c1) the manual @t0 spawn is still handled, not passed through", resManual?.action === "handled", resManual);
check("(c1) the manual @t0 spawn still did NOT launch an agent", getAgents().size === before, getAgents().size);
// With active.enabled=false the manual spawn is refused at the enabled gate
// ("not available"); with it enabled the refusal would name the principal-only
// slot — both are the pre-existing doLaunch refusals, unchanged by this feature.
check("(c1) the manual refusal still comes from the pre-existing doLaunch gates", notifications.some(n => /main session occupies the only t0 slot|not available \(disabled or no model configured\)/i.test(n.message)), notifications.map(n => n.message).join(" | "));

// (c2) A mixed batch: the sequential node gets its OWN wave and only launches
// after the first wave settles; the normal t3 node launches as usual.
const resC: any = await tool.execute("call-c", {
  goal: "ship the parser and QA it",
  tasks: [
    { task: "Implement the CSV parser edge case handling", tier: "t3" },
    { task: "Adversarial QA of the CSV parser: craft malformed inputs and report failures", sequential: true },
  ],
}, undefined, undefined, makeCtx(notifications));
check("(c2) the mixed batch is accepted", resC && resC.isError !== true, text(resC));
check("(c2) the sequential node got its own wave (waves [[1],[2]])", JSON.stringify(resC?.details?.plan?.waves) === JSON.stringify([[1], [2]]), resC?.details?.plan?.waves);
check("(c2) wave 1 launched only the t3 agent (sequential still queued)", getAgents().size === before + 1, getAgents().size);
const t3Agent = [...getAgents().values()].find(a => a.tier === "t3");
check("(c2) the normal t3 agent launched on its tier", !!t3Agent, t3Agent?.id);

// The t3 agent dies with ENOENT (no real subprocess), the wave settles, and
// the sequential wave must launch on its own afterwards.
const deadline = Date.now() + 5000;
while (Date.now() < deadline && getAgents().size < before + 2) {
  await new Promise(r => setTimeout(r, 50));
}
check("(c2) the sequential wave launched after wave 1 settled", getAgents().size === before + 2, getAgents().size);
const seqAgent = [...getAgents().values()].find(a => a.tier === "active" && /CSV parser/.test(a.task));
check("(c2) the awaited sequential agent is on the active tier", seqAgent?.tier === "active", seqAgent?.id);

fs.rmSync(dir1, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
