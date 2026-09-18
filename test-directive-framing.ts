/**
 * Trimegisto - directive framing integration test
 *
 * Run: node --experimental-strip-types test-directive-framing.ts
 *
 * Loads the REAL extension factory with a fake ExtensionAPI, drives the
 * `before_agent_start` handler, and pushes the result through pi's REAL
 * `convertToLlm` so the assertions describe what the model actually
 * receives — not what we hope the handler produced.
 *
 * THE REGRESSION UNDER TEST
 * -----------------------
 * The old handler injected the entire orchestration policy as a
 * `role:"custom"` message. pi's convertToLlm maps custom → plain
 * `role:"user"` with no origin marker, and pi appends it AFTER the user's
 * own message. On a real session that meant a 61-char request shared the
 * user channel with 2,103 chars of imperative boilerplate arriving last.
 * The model answered: "the message you pasted contains instructions from
 * an external system (TRIMEGISTO) but no real request" and refused.
 *
 * The fix has three parts, each asserted here:
 *   1. framing   — any injected block self-labels as extension context
 *   2. placement — stable policy moves to the system prompt, out of the
 *                  user channel entirely
 *   3. volume    — an idle turn injects nothing; a busy turn stays small
 */

import { EXTENSION_CONTEXT_NOTICE } from "./src/tier-status.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

/** Minimal ExtensionAPI: record handlers, swallow registrations. */
function makeFakePi() {
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const noop = () => {};
  const pi: any = {
    on: (event: string, fn: (e: any, c: any) => any) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn);
    },
    registerTool: noop,
    registerCommand: noop,
    registerShortcut: noop,
    registerFlag: noop,
    registerEntryRenderer: noop,
    registerMessageRenderer: noop,
    appendEntry: noop,
    sendMessage: noop,
  };
  return { pi, handlers };
}

/** Minimal ExtensionContext for the handler + compaction probe. */
const ctxStub: any = {
  cwd: process.cwd(),
  hasUI: false,
  model: { contextWindow: 200_000 },
  getContextUsage: () => ({ tokens: 0, contextWindow: 200_000 }),
  compact: async () => {},
  ui: { notify: () => {}, setStatus: () => {} },
};

/**
 * Resolve pi's real convertToLlm. pi's package "exports" map blocks
 * subpath resolution, so the file is located directly under node_modules.
 * If the layout ever changes the test degrades to a skip, not a false pass.
 */
async function loadConvertToLlm(): Promise<((m: any[]) => any[]) | null> {
  const here = new URL(".", import.meta.url);
  const candidates = [
    "./node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js",
    "../pi-coding-agent/dist/core/messages.js",
  ];
  for (const rel of candidates) {
    try {
      const mod = await import(new URL(rel, here).href);
      if (typeof mod.convertToLlm === "function") return mod.convertToLlm;
    } catch { /* try next */ }
  }
  return null;
}

/** Reproduce pi's turn assembly: user message first, custom messages after. */
function assembleTurn(userText: string, injected: any[]): any[] {
  const msgs: any[] = [
    { role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
  ];
  for (const m of injected) {
    msgs.push({
      role: "custom",
      customType: m.customType,
      content: m.content ?? [],
      display: m.display,
      timestamp: Date.now(),
    });
  }
  return msgs;
}

const userChannelText = (llmMsgs: any[]): string =>
  llmMsgs
    .filter(m => m.role === "user")
    .map(m => (Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("") : String(m.content)))
    .join("\n");

const REAL_REQUEST = "pues es que no veo los hints de ayuda en la config de pinball"; // 61 chars, verbatim

async function main() {
  const { pi, handlers } = makeFakePi();
  const mod = await import("./src/index.ts");
  const factory = (mod as any).default;
  if (typeof factory !== "function") {
    console.log("  \u2717 extension factory missing"); failed++; return;
  }
  factory(pi);

  const beforeStart = handlers.get("before_agent_start");
  check("the extension registers a before_agent_start handler", !!beforeStart && beforeStart.length > 0);
  if (!beforeStart || beforeStart.length === 0) return;
  const handler = beforeStart[beforeStart.length - 1];

  const convertToLlm = await loadConvertToLlm();
  check("pi's real convertToLlm resolved (assertions run against real pi)", convertToLlm !== null);

  console.log("\nPlacement: the stable policy lives in the SYSTEM PROMPT, not the user channel:");
  {
    const res = await handler({ systemPrompt: "BASE SYSTEM PROMPT" }, ctxStub);
    check("handler returns a systemPrompt", typeof res?.systemPrompt === "string", typeof res?.systemPrompt);
    check("the caller's base prompt is preserved", (res?.systemPrompt ?? "").startsWith("BASE SYSTEM PROMPT"));
    check("the policy block is appended to the system prompt", (res?.systemPrompt ?? "").includes("<trimegisto-policy>"));
    check("the policy carries the delegation rules", (res?.systemPrompt ?? "").includes("Delegation rules:"));
    check("the policy carries the tier capacity lines", (res?.systemPrompt ?? "").includes("parallel)"));
    check("the imperative that read as a hijack is gone",
      !/FIRST action MUST/i.test(res?.systemPrompt ?? ""), (res?.systemPrompt ?? "").match(/FIRST action MUST.*/) ?? "clean");
  }

  console.log("\nVolume: an idle orchestrator injects NOTHING into the user channel:");
  {
    const res = await handler({ systemPrompt: "BASE" }, ctxStub);
    check("no message is returned while idle", res?.message === undefined, res?.message);
    if (convertToLlm) {
      const llm = convertToLlm(assembleTurn(REAL_REQUEST, []));
      const chan = userChannelText(llm);
      check("user channel is exactly the user's request", chan === REAL_REQUEST, chan);
      check("no trimegisto text in the user channel at all", !chan.toLowerCase().includes("trimegisto"));
    }
  }

  console.log("\nStability: the system prompt must not churn between turns (prompt cache):");
  {
    const a = await handler({ systemPrompt: "BASE" }, ctxStub);
    const b = await handler({ systemPrompt: "BASE" }, ctxStub);
    check("turn N and turn N+1 produce an identical system prompt",
      a?.systemPrompt === b?.systemPrompt,
      a?.systemPrompt?.length !== b?.systemPrompt?.length ? `${a?.systemPrompt?.length} vs ${b?.systemPrompt?.length}` : "equal");
  }

  console.log("\nFraming: whatever IS injected must never be mistaken for the user's words:");
  {
    // Drive the busy path through the same formatter the handler uses, then
    // push it through pi's real conversion — the exact path that broke.
    const { formatDirectiveContent } = await import("./src/tier-status.ts");
    const busy = formatDirectiveContent({
      activeAgentCount: 3,
      activeAgentsFormatted: "- t0a [running]: audit config menu\n- t0b [running]: read commands.ts\n- t2c [running]: review hints renderer",
      pausedTierLines: ["- T2: \u2713 ENABLED [kimi-k3] \u26d4 paused 47s (max 4 parallel)"],
    });
    check("a busy turn produces a non-empty block", busy.length > 0);
    check("the block carries the not-the-user notice", busy.includes(EXTENSION_CONTEXT_NOTICE));
    if (convertToLlm) {
      const llm = convertToLlm(assembleTurn(REAL_REQUEST, [
        { customType: "trimegisto-context", content: busy, display: false },
      ]));
      const chan = userChannelText(llm);
      check("after pi's conversion the block is still user-role (so framing is the only defence)",
        chan.includes(EXTENSION_CONTEXT_NOTICE));
      check("the user's request still leads the channel", chan.startsWith(REAL_REQUEST));
      check("busy boilerplate stays under 12x the request (was 34:1)",
        busy.length < REAL_REQUEST.length * 12, `${busy.length} chars vs ${REAL_REQUEST.length}`);
    }
  }

  console.log("\nDedupe: an unchanged turn must not re-inject:");
  {
    // Two consecutive idle turns already proved the no-message path; here we
    // assert the guard is identity-based, so a real change still gets through.
    const { formatDirectiveContent } = await import("./src/tier-status.ts");
    const a = formatDirectiveContent({ activeAgentCount: 1, activeAgentsFormatted: "- t0a [running]: x" });
    const b = formatDirectiveContent({ activeAgentCount: 1, activeAgentsFormatted: "- t0a [running]: x" });
    check("identical state → identical string (=== dedupe is sound)", a === b);
    const c = formatDirectiveContent({ activeAgentCount: 2, activeAgentsFormatted: "- t0a [running]: x\n- t0b [running]: y" });
    check("changed state → different string (updates are not swallowed)", a !== c);
  }
}

main()
  .catch(e => { console.log("  \u2717 unexpected error:", e?.message ?? e); failed++; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    // The extension starts polling intervals; exit hard so they do not hang the run.
    process.exit(failed > 0 ? 1 : 0);
  });
