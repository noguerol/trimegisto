/**
 * Trimegisto - delegation enforcement gate unit tests
 *
 * Run: node --experimental-strip-types test-enforcement.ts
 *
 * The hard gate is only as good as its two deterministic decisions:
 *   1. WHEN delegation is required (isAtomicPrompt / shouldRequireDelegation),
 *      which must be conservative: the default is "non-atomic, delegate", and
 *      only a genuine one-liner / single-file change escapes.
 *   2. WHAT counts as mutating work (isMutatingToolCall / isMutatingBashCommand),
 *      which is an ALLOWLIST on purpose: an unknown command form defaults to
 *      mutating so the gate cannot be bypassed by a shape nobody anticipated.
 */

import {
  MAX_GATE_BLOCKS,
  shouldRequireDelegation,
  isAtomicPrompt,
  isMutatingBashCommand,
  isMutatingToolCall,
  formatDelegationGateReason,
  formatGateStatus,
} from "./src/enforcement.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

console.log("isAtomicPrompt: only genuine one-liners escape the gate:");
{
  check("empty string is atomic", isAtomicPrompt("") === true);
  check("whitespace is atomic", isAtomicPrompt("   \n ") === true);
  check("null/undefined are atomic", isAtomicPrompt(undefined as any) === true && isAtomicPrompt(null as any) === true);
  check("slash command is atomic", isAtomicPrompt("/tmg config") === true);
  check("question is atomic", isAtomicPrompt("\u00bfqu\u00e9 hace este repo?") === true);
  check("english question is atomic", isAtomicPrompt("how does the ledger work?") === true);
  check("short read-only ask is atomic", isAtomicPrompt("resume el repo") === true);
  check("one small change in ONE named file is atomic",
    isAtomicPrompt("fix the typo in src/a.ts") === true);
  check("no named target stays NON-atomic (forcing)",
    isAtomicPrompt("implementa login") === false);
  check("one file + two verbs is NON-atomic",
    isAtomicPrompt("arregla src/a.ts y a\u00f1ade tests") === false);
  check("coordinated multi-action is NON-atomic",
    isAtomicPrompt("refactor the auth module and add tests") === false);
  check("two files is NON-atomic",
    isAtomicPrompt("update src/a.ts and src/b.ts") === false);
  check("a list is NON-atomic",
    isAtomicPrompt("do this:\n- one\n- two") === false);
}

console.log("shouldRequireDelegation: needs capacity AND the default-delegate contract:");
{
  const base = { enabled: true, autoSpawn: true, parallelSlots: 4, prompt: "implementa autenticaci\u00f3n con login/logout y tests" };
  check("non-atomic + capacity -> required", shouldRequireDelegation(base) === true);
  check("disabled -> not required", shouldRequireDelegation({ ...base, enabled: false }) === false);
  check("autoSpawn off -> not required", shouldRequireDelegation({ ...base, autoSpawn: false }) === false);
  check("zero slots -> not required (no deadlock)", shouldRequireDelegation({ ...base, parallelSlots: 0 }) === false);
  check("negative/NaN slots -> not required",
    shouldRequireDelegation({ ...base, parallelSlots: -1 }) === false &&
    shouldRequireDelegation({ ...base, parallelSlots: NaN }) === false);
  check("atomic prompt -> not required", shouldRequireDelegation({ ...base, prompt: "fix the typo in src/a.ts" }) === false);
  check("missing input -> not required", shouldRequireDelegation(undefined as any) === false);
}

console.log("isMutatingBashCommand: allowlist-first, unknown defaults to mutating:");
{
  const mutating = [
    ["sed -i 's/a/b/' src/a.ts", "in-place sed"],
    ["echo x > file.txt", "output redirection"],
    ["cat <<EOF\nhi\nEOF", "heredoc"],
    ["git commit -m x", "git commit"],
    ["git add -A", "git add"],
    ["npm install", "npm install"],
    ["FOO=bar npm install", "env-prefixed install"],
    [`python -c "open('x','w')"`, "python inline write"],
    [`node -e "require('fs').writeFileSync('x','y')"`, "node inline write"],
    ["sh -c 'rm -rf /tmp/x'", "sh -c wrapper"],
    ["xargs rm", "xargs"],
    ["find . -delete", "find -delete"],
    ["patch < p.diff", "patch"],
    ["curl -o f http://x", "curl -o"],
    ["tee /etc/hosts", "tee"],
    ["dd if=/dev/zero of=f", "dd"],
    ["git push", "git push"],
  ] as const;
  for (const [cmd, label] of mutating) check(`mutating: ${label}`, isMutatingBashCommand(cmd) === true, cmd);

  const readOnly = [
    ["rg foo", "rg"],
    ["grep -rn bar src", "grep"],
    ["git diff", "git diff"],
    ["git status --short", "git status"],
    ["ls -la", "ls"],
    ["sed -n '1,5p' f", "sed print"],
    ["cat f", "cat"],
    ["head -20 f | tail -5", "pipeline"],
    ["find . -name '*.ts'", "find"],
    ["npm test", "npm test"],
    ["node --version", "node --version"],
    ["tsc --noEmit", "tsc --noEmit"],
    ["git config --get core.editor", "git config get"],
    ["git stash list", "git stash list"],
    ["cd src && rg foo", "cd + rg"],
    ["", "empty"],
  ] as const;
  for (const [cmd, label] of readOnly) check(`read-only: ${label}`, isMutatingBashCommand(cmd) === false, cmd);

  check("null command is not mutating", isMutatingBashCommand(null as any) === false);
}

console.log("isMutatingToolCall: reads and trimegisto stay open:");
{
  check("edit is mutating", isMutatingToolCall("edit", {}) === true);
  check("write is mutating", isMutatingToolCall("write", {}) === true);
  check("bash mutating command", isMutatingToolCall("bash", { command: "rm -rf build" }) === true);
  check("bash read-only command", isMutatingToolCall("bash", { command: "rg foo" }) === false);
  check("powershell mutating", isMutatingToolCall("powershell", { command: "mkdir x" }) === true);
  check("read is not mutating", isMutatingToolCall("read", {}) === false);
  check("grep is not mutating", isMutatingToolCall("grep", {}) === false);
  check("find/ls are not mutating", isMutatingToolCall("find", {}) === false && isMutatingToolCall("ls", {}) === false);
  check("trimegisto is not mutating", isMutatingToolCall("trimegisto", {}) === false);
  check("trimegisto_harvest is not mutating", isMutatingToolCall("trimegisto_harvest", {}) === false);
  check("file_lock is not flagged", isMutatingToolCall("file_lock", {}) === false);
  check("BASH is case-insensitive", isMutatingToolCall("BASH", { command: "rm x" }) === true);
}

console.log("messages:");
{
  const reason = formatDelegationGateReason({ attempt: 1, capacity: "3 parallel slots configured.", maxBlocks: MAX_GATE_BLOCKS });
  check("reason names the tool", /trimegisto/.test(reason), reason);
  check("reason says NOT atomic", /not atomic/i.test(reason), reason);
  check("reason carries capacity", /3 parallel slots/.test(reason), reason);
  check("reason does not claim fail-open before the limit", !/fails open/i.test(reason), reason);
  const last = formatDelegationGateReason({ attempt: MAX_GATE_BLOCKS, capacity: "", maxBlocks: MAX_GATE_BLOCKS });
  check("last block warns about fail-open", /fails open/i.test(last), last);
  check("formatGateStatus off", formatGateStatus(false, false, 0) === "gate: off");
  check("formatGateStatus required", /required/.test(formatGateStatus(true, false, 1)));
  check("formatGateStatus launched", /launched/.test(formatGateStatus(true, true, 2)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
