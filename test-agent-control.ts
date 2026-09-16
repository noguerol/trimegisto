/**
 * Trimegisto - Agent control channel tests
 *
 * Run: node --experimental-strip-types test-agent-control.ts
 *
 * Covers the pure command parser (`@t2b halt` / `/t2b compact` / steer) and the
 * parent->child file mailbox that lets a RUNNING agent be steered or compacted
 * instead of being killed and respawned.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseAgentCommand,
  writeAgentControl,
  drainAgentControls,
  clearAgentControls,
  agentControlDir,
  condenseForCompaction,
  CONTROL_REQUEST_TTL_MS,
} from "./src/agent-control.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

console.log("Parser (@tier[letter] + verb):");
{
  const halt = parseAgentCommand("@t2b halt");
  check("@t2b halt -> halt", halt?.verb === "halt" && halt.agentId === "t2b" && halt.tier === "t2", halt);
  check("@t2b halt has no instruction text", halt?.text === "", halt?.text);

  check("verb is case-insensitive", parseAgentCommand("@t2b HALT")?.verb === "halt");
  check("kill maps to halt", parseAgentCommand("/t2b kill")?.verb === "halt");
  check("stop maps to halt", parseAgentCommand("@t2b stop")?.verb === "halt");
  check("compact maps to compact", parseAgentCommand("@t2b compact")?.verb === "compact");
  check("compaction maps to compact", parseAgentCommand("/t2b compaction")?.verb === "compact");

  const active = parseAgentCommand("@t0a halt");
  check("@t0a collapses to the active tier", active?.tier === "active" && active.agentId === "t0a", active);

  const steer = parseAgentCommand("@t2b rewrite the parser to reject NaN");
  check("instruction is a steer", steer?.verb === "steer" && steer.agentId === "t2b", steer);
  check("steer keeps the full text", steer?.text === "rewrite the parser to reject NaN", steer?.text);

  const multi = parseAgentCommand("@t3c fix the\nmulti-line issue");
  check("steer preserves newlines", multi?.text === "fix the\nmulti-line issue", multi?.text);

  const spawn = parseAgentCommand("@t2 count the rows");
  check("bare tier spawns", spawn?.verb === "spawn" && spawn.agentId === null, spawn);
  check("bare tier keeps the task", spawn?.text === "count the rows", spawn?.text);

  const slashTier = parseAgentCommand("/t1 plan the refactor");
  check("slash bare tier spawns", slashTier?.verb === "spawn" && slashTier.tier === "t1", slashTier);

  const slashAgent = parseAgentCommand("/t1b continue");
  check("slash with letter steers", slashAgent?.verb === "steer" && slashAgent.agentId === "t1b", slashAgent);

  // A word that merely STARTS with a verb is an instruction, not a control verb.
  check("`halt the server` is a steer", parseAgentCommand("@t2b halt the server")?.verb === "steer");
  check("`compact the logs` is a steer", parseAgentCommand("@t2b compact the logs")?.verb === "steer");
  check("`@t2b kill-9 the process` is a steer", parseAgentCommand("@t2b kill-9 the process")?.verb === "steer");

  check("empty body is not a command", parseAgentCommand("@t2b ") === null);
  check("unknown tier is not a command", parseAgentCommand("@t5 do x") === null);
  check("plain text is not a command", parseAgentCommand("hello world") === null);
  check("email-ish text is not a command", parseAgentCommand("mail me at a@t2b.com") === null);
}

console.log("Mailbox (write / drain / clear):");
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-control-"));
  try {
    check("write steer returns true", writeAgentControl(base, "t2b", "steer", { text: "do the thing" }) === true);
    const drained = drainAgentControls(base, "t2b");
    check("drain returns the steer", drained.length === 1 && drained[0].kind === "steer", drained);
    check("drain preserves the text", drained[0]?.text === "do the thing", drained[0]);
    check("drain consumes the file", drainAgentControls(base, "t2b").length === 0);
    check("consumed file is gone from disk",
      fs.readdirSync(agentControlDir(base, "t2b")!).filter(f => f.endsWith(".json")).length === 0);

    check("write a second steer returns true", writeAgentControl(base, "t2b", "steer", { text: "and the other thing" }) === true);
    const second = drainAgentControls(base, "t2b");
    check("drain returns the second steer",
      second.length === 1 && second[0].kind === "steer" && second[0].text === "and the other thing", second);

    // Isolation between agents.
    writeAgentControl(base, "t1a", "steer", { text: "for t1a" });
    const forT2 = drainAgentControls(base, "t2b");
    const forT1 = drainAgentControls(base, "t1a");
    check("agents have separate mailboxes", forT2.length === 0 && forT1.length === 1 && forT1[0].text === "for t1a", { forT1, forT2 });

    // Path traversal must be rejected, not escaped.
    check("invalid agent id is rejected", writeAgentControl(base, "../evil", "steer", { text: "x" }) === false);
    check("invalid agent id drains nothing", drainAgentControls(base, "../evil").length === 0);

    // A file with the old `compact` kind is not a valid control request anymore.
    const dirC = agentControlDir(base, "t3c")!;
    fs.mkdirSync(dirC, { recursive: true });
    fs.writeFileSync(path.join(dirC, "c.json"), JSON.stringify({ id: "c", kind: "compact", ts: Date.now() }));
    check("an unknown control kind is dropped, not delivered", drainAgentControls(base, "t3c").length === 0);
    check("an unknown control kind is swept", fs.readdirSync(dirC).length === 0);

    // Stale requests are swept, not delivered.
    const dir = agentControlDir(base, "t3a")!;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify({ id: "old", kind: "steer", text: "old", ts: Date.now() - CONTROL_REQUEST_TTL_MS - 1000 }));
    check("stale request is not delivered", drainAgentControls(base, "t3a").length === 0);
    check("stale request is swept", fs.readdirSync(dir).length === 0);

    // Corrupt files never throw and are cleaned up.
    const dir2 = agentControlDir(base, "t3b")!;
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, "bad.json"), "{not json");
    check("corrupt request does not throw", drainAgentControls(base, "t3b").length === 0);
    check("corrupt request is removed", fs.readdirSync(dir2).length === 0);

    // clear removes the whole mailbox directory.
    writeAgentControl(base, "t2c", "steer", { text: "pending" });
    clearAgentControls(base, "t2c");
    check("clear removes the mailbox", !fs.existsSync(agentControlDir(base, "t2c")!));
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log("Compaction digest:");
{
  check("short text is unchanged", condenseForCompaction("hello world") === "hello world");
  check("whitespace is trimmed", condenseForCompaction("  hi  ") === "hi");
  check("empty text stays empty", condenseForCompaction("") === "");

  const long = "H".repeat(5000) + "T".repeat(5000);
  const digest = condenseForCompaction(long, 1000);
  check("long text is bounded", digest.length <= 1000 + 80, digest.length);
  check("digest keeps the head", digest.startsWith("HHHH"));
  check("digest keeps the tail", digest.endsWith("TTTT"));
  check("digest marks the omission", digest.includes("chars omitted"));
  check("exactly at the limit is unchanged", condenseForCompaction("x".repeat(1000), 1000) === "x".repeat(1000));
  check("invalid maxChars falls back to a safe default", condenseForCompaction(long, NaN).length <= 6000 + 80);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
