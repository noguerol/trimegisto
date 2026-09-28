/**
 * Trimegisto - harvest rendering tests
 *
 * Run: node --experimental-strip-types test-harvest-render.ts
 *
 * THE REGRESSION UNDER TEST
 * -------------------------
 * `trimegisto_harvest` is a MODEL-facing snapshot: its result markdown carries
 * agent tasks and output/prompt excerpts. With no custom renderer pi printed the
 * whole thing in the transcript, so every harvest cluttered the stream with
 * text the user cannot use. The fix collapses the block to nothing (the text
 * still reaches the model) and keeps it inspectable behind Ctrl+O.
 *
 * Drives the real extension factory with a fake pi that captures the registered
 * tools, then renders the harvest tool's own renderCall/renderResult.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

// The expanded branch renders Markdown, which needs a global theme.
initTheme("dark");

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-harvest-"));
fs.mkdirSync(path.join(dir, "trimegisto"), { recursive: true });
fs.writeFileSync(path.join(dir, "trimegisto", "config.json"), JSON.stringify({ enabled: true, autoSpawn: true }));
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.TRIMEGISTO_AGENT_ID;

const tools: any[] = [];
const handlers = new Map<string, Array<(e: any, c: any) => any>>();
const noop = () => {};
const pi: any = {
  on: (event: string, fn: any) => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event)!.push(fn); },
  registerTool: (t: any) => tools.push(t),
  registerCommand: noop, registerShortcut: noop, registerFlag: noop,
  registerEntryRenderer: noop, registerMessageRenderer: noop, appendEntry: noop, sendMessage: noop,
  setActiveTools: noop, events: { on: noop, emit: noop },
};

const mod: any = await import("./src/index.ts");
mod.default(pi);

const harvest = tools.find(t => t.name === "trimegisto_harvest");
check("the harvest tool is registered", !!harvest);

const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const HIDDEN = (lines: string[]) => lines.every(l => l.trim() === "");

console.log("collapsed (normal work): the harvest block shows nothing:");
{
  const callLines = harvest.renderCall({}, theme, {}).render(80);
  check("renderCall renders no lines", HIDDEN(callLines), callLines);
  const result = { content: [{ type: "text", text: "## Trimegisto harvest\nsecret prompt excerpt" }], details: { agents: [] } };
  const collapsed = harvest.renderResult(result, { expanded: false }, theme, {}).render(80);
  check("collapsed renderResult renders no lines", HIDDEN(collapsed), collapsed);
  check("collapsed result never leaks the text", !collapsed.join("\n").includes("secret prompt"), collapsed);
}

console.log("expanded (Ctrl+O): the text is still inspectable:");
{
  const result = { content: [{ type: "text", text: "## Trimegisto harvest\nvisible on demand" }], details: {} };
  const expanded = harvest.renderResult(result, { expanded: true }, theme, {}).render(80);
  check("expanded renderResult shows the text", expanded.join("\n").includes("visible on demand"), expanded);
}

console.log("edge: missing/odd content is safe:");
{
  for (const bad of [undefined, {}, { content: [] }, { content: [{ type: "image" }] }, { content: "not-an-array" }]) {
    const r = harvest.renderResult(bad as any, { expanded: true }, theme, {}).render(80);
    check(`expanded with ${JSON.stringify(bad)} does not throw`, Array.isArray(r), r);
  }
  const collapsedBad = harvest.renderResult(undefined as any, { expanded: false }, theme, {}).render(80);
  check("collapsed with undefined result is empty", HIDDEN(collapsedBad), collapsedBad);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
