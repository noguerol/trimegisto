/**
 * Trimegisto - load-time payload budget test
 *
 * Run: node --experimental-strip-types test-payload-budget.ts
 *
 * The `trimegisto` tool schema is re-sent in every request's tool list, so its
 * serialized size is paid on every turn. docs/payload-audit.md measured the
 * load-time payload at 4127 chars; the pruning pass must bring it under 2850
 * (>=30% smaller) WITHOUT dropping the functional facts the coordinator needs
 * at call time: the delegation default, the live tier lines and role mapping,
 * and the meaning of every task parameter.
 *
 * Loads the REAL extension factory with a capturing ExtensionAPI, so the
 * assertions describe the actual registered schema, not a transcription.
 */

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

const BASELINE = 4127; // docs/payload-audit.md, load-time/default config
const TARGET = 2850;   // >=30% reduction

async function main() {
  const tools: any[] = [];
  const noop = () => {};
  const pi: any = {
    on: noop,
    registerTool: (t: any) => tools.push(t),
    registerCommand: noop,
    registerShortcut: noop,
    registerFlag: noop,
    registerEntryRenderer: noop,
    registerMessageRenderer: noop,
    appendEntry: noop,
    sendMessage: noop,
  };
  const mod = await import("./src/index.ts");
  const factory = (mod as any).default;
  if (typeof factory !== "function") {
    console.log("  \u2717 extension factory missing");
    failed++;
    return;
  }
  factory(pi);

  const tool = tools.find(t => t?.name === "trimegisto");
  check("the extension registers the `trimegisto` tool", !!tool);
  if (!tool) return;

  const serialized = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
  const size = [...serialized].length;
  const reduction = ((BASELINE - size) / BASELINE) * 100;
  console.log(`\n  payload: ${BASELINE} -> ${size} chars (${reduction.toFixed(1)}% smaller)`);
  check(`serialized tool <= ${TARGET} (baseline ${BASELINE})`, size <= TARGET, `${size} chars`);
  check("the reduction is at least 30%", reduction >= 30, `${reduction.toFixed(1)}%`);

  console.log("\nThe functional facts survive the prune:");
  const desc = String(tool.description ?? "");
  check("keeps the delegation default", /delegate by default/i.test(desc));
  check("keeps the tier status lines header", desc.includes("Tiers now:"));
  check("keeps the tier role mapping", desc.includes("active=t0") && desc.includes("planning only"));
  check("keeps the enabled-tier rule", /ENABLED/i.test(desc));

  console.log("\nEvery task parameter keeps its meaning (present in the schema):");
  const taskProps = tool.parameters?.properties?.tasks?.items?.properties ?? {};
  const expected = ["tier", "task", "cwd", "needs", "why", "writes", "lane", "verify", "context", "diversity", "sequential"];
  for (const p of expected) {
    check(`task param \`${p}\` is present`, !!taskProps[p], Object.keys(taskProps));
  }
  console.log("\nTool-level params:");
  const topProps = tool.parameters?.properties ?? {};
  for (const p of ["tasks", "goal", "cwd"]) {
    check(`tool param \`${p}\` is present`, !!topProps[p], Object.keys(topProps));
  }
}

main()
  .catch(e => { console.log("  \u2717 unexpected error:", e?.message ?? e); failed++; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
