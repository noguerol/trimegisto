/**
 * Trimegisto - hard delegation gate integration test
 *
 * Run: node --experimental-strip-types test-delegation-gate.ts
 *
 * Drives the REAL extension factory with a fake pi and asserts the gate the
 * system-prompt contract promised:
 *   - the first `edit` / mutating `bash` of a non-atomic turn is BLOCKED;
 *   - reads (read/grep/read-only bash) stay open for planning;
 *   - a `trimegisto` call only clears the gate when a batch REALLY launched
 *     (a refused batch returns `isError` / `tasks: []`);
 *   - after MAX_GATE_BLOCKS refusals it fails open (never bricks the session);
 *   - atomic prompts are never gated;
 *   - spawned workers (TRIMEGISTO_AGENT_ID set) are never gated;
 *   - the settle nudge fires at most once per turn.
 *
 * It never launches a subprocess: tool calls/results are fired at the handlers
 * directly, so the gate logic is exercised in isolation from the launcher.
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

function withConfig(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-delegation-gate-"));
  fs.mkdirSync(path.join(dir, "trimegisto"), { recursive: true });
  fs.writeFileSync(path.join(dir, "trimegisto", "config.json"), JSON.stringify(config));
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

function makeFakePi() {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
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
  return { pi, handlers };
}

function makeCtx() {
  return {
    cwd: process.cwd(), hasUI: false, mode: "print", model: {},
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    compact: async () => {},
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
  } as any;
}

const mod: any = await import("./src/index.ts");
const dir = withConfig({ enabled: true, autoSpawn: true, active: { maxParallel: 4 } });

async function boot(withWorkerEnv: boolean) {
  if (withWorkerEnv) process.env.TRIMEGISTO_AGENT_ID = "t0a";
  else delete process.env.TRIMEGISTO_AGENT_ID;
  const { pi, handlers } = makeFakePi();
  mod.default(pi);
  const ctx = makeCtx();
  const sessionStart = handlers.get("session_start");
  if (sessionStart && sessionStart.length > 0) await sessionStart[sessionStart.length - 1]({}, ctx);
  const last = (name: string, ...args: any[]) => {
    const arr = handlers.get(name);
    if (!arr || arr.length === 0) throw new Error(`handler ${name} not registered`);
    return arr[arr.length - 1](...args);
  };
  return { handlers, ctx, fire: last };
}

// ── Worker exemption first (env must be set when the factory reads it) ──
{
  const w = await boot(true);
  await w.fire("before_agent_start", { prompt: "implementa autenticaci\u00f3n con login/logout y tests", systemPrompt: "" }, w.ctx);
  const r = await w.fire("tool_call", { toolName: "edit", input: {}, toolCallId: "w1" }, w.ctx);
  check("worker (TRIMEGISTO_AGENT_ID set) is never gated", !r?.block, r);
  delete process.env.TRIMEGISTO_AGENT_ID;
}

// ── Main coordinator session ──
const { ctx, fire } = await boot(false);

console.log("turn A: gate blocks, refused batch does NOT clear, successful batch does:");
{
  await fire("before_agent_start", { prompt: "implementa autenticaci\u00f3n con login/logout y tests", systemPrompt: "" }, ctx);

  let r = await fire("tool_call", { toolName: "read", input: {}, toolCallId: "a1" }, ctx);
  check("read is allowed while gated", !r?.block, r);
  r = await fire("tool_call", { toolName: "grep", input: {}, toolCallId: "a2" }, ctx);
  check("grep is allowed while gated", !r?.block, r);
  r = await fire("tool_call", { toolName: "bash", input: { command: "rg foo" }, toolCallId: "a3" }, ctx);
  check("read-only bash is allowed while gated", !r?.block, r);

  r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "a4" }, ctx);
  check("first edit of a non-atomic turn is BLOCKED", r?.block === true, r);
  check("block reason names trimegisto", /trimegisto/.test(String(r?.reason ?? "")), r);
  check("block reason says NOT atomic", /not atomic/i.test(String(r?.reason ?? "")), r);

  r = await fire("tool_call", { toolName: "trimegisto", input: { tasks: [] }, toolCallId: "a5" }, ctx);
  check("the trimegisto call itself is not blocked", !r?.block, r);

  await fire("tool_result", { toolName: "trimegisto", isError: true, details: { tasks: [] }, content: [], input: {}, toolCallId: "a5" }, ctx);
  r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "a6" }, ctx);
  check("a REFUSED batch (isError) does not clear the gate", r?.block === true, r);

  await fire("tool_result", { toolName: "trimegisto", isError: false, details: { tasks: [{ agentId: "t0a" }] }, content: [], input: {}, toolCallId: "a5" }, ctx);
  r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "a7" }, ctx);
  check("a SUCCESSFUL launch clears the gate", !r?.block, r);
  r = await fire("tool_call", { toolName: "write", input: {}, toolCallId: "a8" }, ctx);
  check("write stays allowed after a successful launch", !r?.block, r);
}

console.log("turn A2: success-shaped no-ops (queued / dedup drop-all) do NOT clear either:");
{
  await fire("before_agent_start", { prompt: "añade paginación a la API y documenta los endpoints", systemPrompt: "" }, ctx);
  let r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "q1" }, ctx);
  check("edit is blocked before any batch", r?.block === true, r);
  // The dedup drop-all / "queued, waiting for capacity" paths return
  // `isError:false` with `tasks: []` (src/index.ts ~1371 / ~1618).
  await fire("tool_result", { toolName: "trimegisto", isError: false, details: { tasks: [] }, content: [], input: {}, toolCallId: "q2" }, ctx);
  r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "q3" }, ctx);
  check("a success-shaped no-op (tasks: []) does NOT clear the gate", r?.block === true, r);
}

console.log("turn B: fail-open after MAX_GATE_BLOCKS mutating refusals:");
{
  await fire("before_agent_start", { prompt: "migra la base de datos y actualiza los endpoints", systemPrompt: "" }, ctx);
  let r = await fire("tool_call", { toolName: "bash", input: { command: "echo x > f" }, toolCallId: "b1" }, ctx);
  check("mutating bash is blocked", r?.block === true, r);
  r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "b2" }, ctx);
  check("second mutating call is blocked", r?.block === true, r);
  r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "b3" }, ctx);
  check("third mutating call FAILS OPEN (no deadlock)", !r?.block, r);
}

console.log("atomic prompts are never gated:");
{
  await fire("before_agent_start", { prompt: "\u00bfqu\u00e9 hace este repo?", systemPrompt: "" }, ctx);
  let r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "c1" }, ctx);
  check("pure question: edit allowed", !r?.block, r);

  await fire("before_agent_start", { prompt: "fix the typo in src/a.ts", systemPrompt: "" }, ctx);
  r = await fire("tool_call", { toolName: "edit", input: {}, toolCallId: "c2" }, ctx);
  check("one small change in one file: edit allowed", !r?.block, r);
}

console.log("settle nudge fires at most once:");
{
  await fire("before_agent_start", { prompt: "refactoriza el m\u00f3dulo de auth y a\u00f1ade tests de integraci\u00f3n", systemPrompt: "" }, ctx);
  const first = await fire("agent_before_settle", {}, ctx);
  check("first settle nudges to launch", first?.continue === true && Array.isArray(first?.entries) && first.entries.length === 1, first);
  const second = await fire("agent_before_settle", {}, ctx);
  check("second settle does NOT nudge again", second === undefined, second);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
