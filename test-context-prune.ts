/**
 * Trimegisto - Context pruning tests
 *
 * Run: node --experimental-strip-types test-context-prune.ts
 *
 * Covers the "keep Trimegisto noise out of the model request" rule that
 * protects the coordinator from provider 400 invalid_request_error:
 *  - orchestration directives collapse to the newest copy
 *  - progress notes are capped to the newest N
 *  - empty custom messages are dropped (invalid content block for providers)
 *  - user/assistant/toolResult messages are NEVER touched (tool pairing safe)
 *  - pure: no mutation, order preserved, no-op returns the same array
 */

import {
  pruneContextMessages,
  messageText,
  MAX_PROGRESS_MESSAGES,
  type PrunableMessage,
} from "./src/context-prune.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

const user = (t: string): PrunableMessage => ({ role: "user", content: t });
const assistant = (t: string): PrunableMessage => ({ role: "assistant", content: [{ type: "text", text: t }] });
const toolResult = (): PrunableMessage => ({ role: "toolResult", content: [{ type: "text", text: "ok" }] });
const log = (i: number): PrunableMessage => ({ role: "custom", customType: "trimegisto-log", content: `log ${i}` });
const ctx = (i: number): PrunableMessage => ({ role: "custom", customType: "trimegisto-context", content: `directive ${i}` });

console.log("Test 1 (messageText):");
{
  check("string content", messageText("hi") === "hi");
  check("text parts joined", messageText([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "a\nb");
  check("non-text parts ignored", messageText([{ type: "image" }, { type: "text", text: "x" }]) === "x");
  check("undefined -> empty", messageText(undefined) === "");
  check("null -> empty", messageText(null) === "");
  check("number -> empty", messageText(42) === "");
}

console.log("Test 2 (non-custom messages are never touched):");
{
  const input = [user("a"), assistant("b"), toolResult(), log(1), user("c")];
  const out = pruneContextMessages(input);
  check("nothing dropped", out.length === input.length, out.length);
  check("same array returned when no change", out === input);
  const roles = out.map((m) => m.role).join(",");
  check("roles preserved in order", roles === "user,assistant,toolResult,custom,user", roles);
}

console.log("Test 3 (progress cap keeps the NEWEST N, in order):");
{
  const input: PrunableMessage[] = [];
  for (let i = 0; i < 20; i++) input.push(log(i));
  const out = pruneContextMessages(input, MAX_PROGRESS_MESSAGES);
  check(`keeps exactly ${MAX_PROGRESS_MESSAGES}`, out.length === MAX_PROGRESS_MESSAGES, out.length);
  check("kept ones are the newest", (out[0]!.content as string) === "log 12" && (out[7]!.content as string) === "log 19", out.map((m) => m.content));
  check("input array not mutated", input.length === 20, input.length);
  check("input contents untouched", (input[0]!.content as string) === "log 0");
  const cap2 = pruneContextMessages(input, 2);
  check("custom cap honoured", cap2.length === 2 && (cap2[1]!.content as string) === "log 19", cap2.map((m) => m.content));
  const zero = pruneContextMessages(input, 0);
  check("cap 0 drops all progress", zero.length === 0, zero.length);
  const bad = pruneContextMessages(input, Number.NaN);
  check("NaN cap falls back to default", bad.length === MAX_PROGRESS_MESSAGES, bad.length);
  const neg = pruneContextMessages(input, -5);
  check("negative cap clamps to 0", neg.length === 0, neg.length);
}

console.log("Test 4 (orchestration directive collapses to the newest copy):");
{
  const input = [ctx(1), user("hi"), ctx(2), ctx(3)];
  const out = pruneContextMessages(input);
  const ctxs = out.filter((m) => m.customType === "trimegisto-context");
  check("only one directive survives", ctxs.length === 1, ctxs.length);
  check("it is the newest", (ctxs[0]!.content as string) === "directive 3", ctxs[0]!.content);
  check("user message preserved", out.some((m) => m.role === "user" && m.content === "hi"));
}

console.log("Test 5 (empty custom messages are dropped, empty non-custom kept):");
{
  const input: PrunableMessage[] = [
    { role: "custom", customType: "trimegisto-log", content: "" },
    { role: "custom", customType: "trimegisto-log", content: "   " },
    { role: "custom", customType: "trimegisto-log" },
    { role: "custom", customType: "trimegisto-log", content: [{ type: "text", text: "  " }] },
    { role: "custom", customType: "trimegisto-command", content: "kept" },
  ];
  const out = pruneContextMessages(input);
  check("only the non-empty command survives", out.length === 1, out.length);
  check("survivor is the command", out[0]!.customType === "trimegisto-command");
  const empties = pruneContextMessages([{ role: "user", content: "" }, { role: "assistant", content: "" }]);
  check("empty user/assistant are NOT dropped", empties.length === 2, empties.length);
}

console.log("Test 6 (no-op detection + unknown custom types kept):");
{
  const input = [user("x"), { role: "custom", customType: "other-ext", content: "hey" }];
  const out = pruneContextMessages(input);
  check("unknown custom type kept", out.some((m) => m.customType === "other-ext"));
  check("no-op returns the same reference", out === input);
  const changed = pruneContextMessages([log(1), log(2)], 1);
  check("changed returns a different array", changed !== undefined && changed.length === 1);
}

console.log("Test 7 (tool pairing survives interleaved pruning):");
{
  const input: PrunableMessage[] = [
    assistant("call"),
    user("real"),
    ...Array.from({ length: 15 }, (_, i) => log(i)),
    toolResult(),
    ctx(1),
    ctx(2),
  ];
  const out = pruneContextMessages(input, 3);
  const users = out.filter((m) => m.role === "user").length;
  const assistants = out.filter((m) => m.role === "assistant").length;
  const tools = out.filter((m) => m.role === "toolResult").length;
  check("user preserved", users === 1, users);
  check("assistant preserved", assistants === 1, assistants);
  check("toolResult preserved", tools === 1, tools);
  check("3 newest logs kept", out.filter((m) => m.customType === "trimegisto-log").length === 3);
  check("1 directive kept", out.filter((m) => m.customType === "trimegisto-context").length === 1);
  // Order of the survivors must follow the original array.
  const order = out.map((m) => m.role + ":" + (m.customType ?? ""));
  check("relative order preserved", order.indexOf("toolResult:") > order.indexOf("assistant:") && order.indexOf("custom:trimegisto-context") > order.indexOf("toolResult:"), order);
}

console.log("Test 8 (degenerate inputs):");
{
  check("empty array", pruneContextMessages([]).length === 0);
  check("null-ish tolerated", pruneContextMessages(undefined as unknown as PrunableMessage[]).length === 0);
  check("null entries do not crash and are kept", pruneContextMessages([null as unknown as PrunableMessage, user("x")]).length === 2);
  check("non-custom entry without role is kept", pruneContextMessages([{ content: "x" }]).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
