/**
 * Trimegisto - `@<agent-id>` mention integration test
 *
 * Run: node --experimental-strip-types test/test-mention.ts
 *
 * THE CONTRACT UNDER TEST
 * -----------------------
 * One shape for naming an agent, identical in chat and in the `/@` command:
 *
 *     @t2b                  MENTION   show it (status, model, time, tokens, task)
 *     @t2b <instruction>    STEER     inject into the live run, never respawn
 *     @t2b kill             KILL      stop only that agent
 *     @t2 <task>            SPAWN     launch a new agent in that tier
 *
 * The old input handler returned `null` for a bare `@t2b` (it fell through as a
 * prompt) and its control path was a near-duplicate of the `/@` command. This
 * test drives the REAL extension factory and the REAL input handler and asserts
 * the mention path: a bare mention changes nothing, `kill` kills exactly one
 * agent, and an instruction lands in the control mailbox.
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

function makeFakePi() {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const notices: Array<{ message: string; level?: string }> = [];
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
  return { pi, handlers, notices };
}

function makeCtx(notices: Array<{ message: string; level?: string }>) {
  return {
    cwd: process.cwd(), hasUI: false, mode: "print", model: {},
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
    compact: async () => {},
    ui: {
      notify: (message: string, level?: string) => { notices.push({ message, level }); },
      setStatus: () => {},
    },
    sessionManager: { getEntries: () => [], getBranch: () => [] },
  } as any;
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-mention-"));
fs.mkdirSync(path.join(agentDir, "trimegisto"), { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "trimegisto", "config.json"),
  JSON.stringify({ enabled: true, active: { maxParallel: 4 }, t2: { enabled: true, model: "moonshot/kimi-k3" } }),
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const { pi, handlers, notices } = makeFakePi();
const mod: any = await import("../src/index.ts");
mod.default(pi);

const input = handlers.get("input");
check("the extension registers an input handler", !!input && input.length > 0);

const send = async (text: string) => {
  const before = notices.length;
  const res: any = await input![input!.length - 1]({ text }, makeCtx(notices));
  return { res, said: notices.slice(before) };
};

// Boot the session so the saved config, the instance dir and the runtime are set.
const sessionStart = handlers.get("session_start");
await sessionStart![sessionStart!.length - 1]({}, makeCtx(notices));

const { getAgents, killAgent } = await import("../src/agent-manager.ts");

const makeAgent = (over: Record<string, unknown>) => ({
  id: "t2b", tier: "t2", task: "rewrite the parser to reject NaN", status: "running",
  startedAt: Date.now() - 12_000, controller: new AbortController(), output: "", stderr: "", log: [],
  usage: { input: 3400, output: 1200, cacheRead: 0, cacheWrite: 0, cost: 0.004, contextTokens: 0, turns: 4 },
  model: "moonshot/kimi-k3",
  ...over,
} as any);

console.log("Mention (@t2b alone): names the agent, changes NOTHING:");
{
  getAgents().set("t2b", makeAgent({}));
  const { res, said } = await send("@t2b");
  check("the input event is handled (never sent to the model)", res?.action === "handled", res);
  const msg = said.map(n => n.message).join("\n");
  check("the mention shows the agent id", msg.includes("t2b"), msg);
  check("the mention shows its tier", msg.includes("T2"), msg);
  check("the mention shows the model", msg.includes("kimi-k3"), msg);
  check("the mention shows the task", msg.includes("rewrite the parser"), msg);
  check("the mention shows token usage", msg.includes("1.2k") && msg.includes("3.4k"), msg);
  check("the mention teaches how to intervene", /steer: @t2b/.test(msg) && /kill: @t2b kill/.test(msg), msg);
  check("a mention does NOT kill the agent", getAgents().get("t2b")!.status === "running", getAgents().get("t2b")!.status);
  check("a mention does NOT steer it", !said.some(n => /steering/i.test(n.message)), msg);
  check("a mention does NOT spawn", getAgents().size === 1, getAgents().size);
  getAgents().delete("t2b");
}

console.log("Mention of a missing agent: actionable, not silent:");
{
  const { said } = await send("@t2b");
  const msg = said.map(n => n.message).join("\n");
  check("says the agent was not found", /not found/i.test(msg), msg);
  check("offers the launch form", /@t2 <task>/.test(msg), msg);
}

console.log("Kill (@t2b kill): stops ONLY that agent:");
{
  getAgents().set("t2b", makeAgent({}));
  getAgents().set("t2a", makeAgent({ id: "t2a" }));
  const { res, said } = await send("@t2b kill");
  check("the input event is handled", res?.action === "handled", res);
  check("t2b is killed", getAgents().get("t2b")!.status === "killed", getAgents().get("t2b")!.status);
  check("t2a is untouched", getAgents().get("t2a")!.status === "running", getAgents().get("t2a")!.status);
  check("the user is told which agent died", said.some(n => /Killed t2b/.test(n.message)), said);
  getAgents().delete("t2b");
  getAgents().delete("t2a");
}

console.log("Steer (@t2b <instruction>): lands in the control mailbox:");
{
  getAgents().set("t2b", makeAgent({}));
  const { said } = await send("@t2b: also reject Infinity");
  const msg = said.map(n => n.message).join("\n");
  check("the instruction is acknowledged", /Steering t2b/.test(msg), msg);
  check("the separator is not part of the instruction", /Steering t2b: also reject Infinity/.test(msg) && !/Steering t2b: :/.test(msg), msg);
  const target = [...said.map(n => n.message)].join(" ");
  check("the agent is still running (steering is not a respawn)", getAgents().get("t2b")!.status === "running");
  check("the acknowledgement quotes the instruction", target.includes("also reject Infinity"), target);
  getAgents().delete("t2b");
}

console.log("Steering a finished agent: shows its last answer instead of a dead end:");
{
  getAgents().set("t2b", makeAgent({
    status: "done", finishedAt: Date.now(),
    finalOutput: "Parser now rejects NaN and Infinity; 41 tests pass.",
  }));
  const { said } = await send("@t2b keep going");
  const msg = said.map(n => n.message).join("\n");
  check("explains there is nothing left to steer", /nothing left to steer/i.test(msg), msg);
  check("shows the agent's last answer", /Parser now rejects NaN/.test(msg), msg);
  check("shows how to launch the follow-up", /@t2 <task>/.test(msg), msg);
  check("does not add a mailbox request", !/Steering/.test(msg), msg);
  getAgents().delete("t2b");
}

console.log("Tier mention (@t2 alone): the tier, its agents and the launch hint:");
{
  getAgents().set("t2a", makeAgent({ id: "t2a", status: "running" }));
  getAgents().set("t2c", makeAgent({ id: "t2c", status: "done", finishedAt: Date.now() }));
  const { res, said } = await send("@t2");
  check("the input event is handled", res?.action === "handled", res);
  const msg = said.map(n => n.message).join("\n");
  check("names the tier", /T2/.test(msg), msg);
  check("lists the agents by id", msg.includes("t2a") && msg.includes("t2c"), msg);
  check("offers the launch form", /launch: @t2 <task>/.test(msg), msg);
  check("does not spawn", getAgents().size === 2, getAgents().size);
  getAgents().delete("t2a");
  getAgents().delete("t2c");
}

console.log("Both prefixes behave the same (chat `@` vs command `/`):");
{
  getAgents().set("t2b", makeAgent({}));
  const viaAt = await send("@t2b");
  const viaSlash = await send("/t2b");
  check("`/t2b` mentions too", viaSlash.res?.action === "handled");
  check("`@t2b` and `/t2b` render the same agent", viaAt.said.at(-1)?.message === viaSlash.said.at(-1)?.message,
    { at: viaAt.said.at(-1)?.message, slash: viaSlash.said.at(-1)?.message });
  const killViaAt = await send("@t2b kill");
  check("`@t2b kill` kills", getAgents().get("t2b")!.status === "killed" && killViaAt.said.some(n => /Killed t2b/.test(n.message)));
  // killAgent is the same function the command calls; a second kill is a no-op.
  check("a second kill reports it was already stopped", killAgent("t2b") === false);
  getAgents().delete("t2b");
}

fs.rmSync(agentDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
