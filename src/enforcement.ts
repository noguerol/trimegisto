/**
 * Trimegisto - delegation enforcement gate
 *
 * The 'delegate by default' contract lives in `src/delegation.ts` as SYSTEM
 * PROMPT text. That contract is only advisory: models read it, say in
 * chain-of-thought that they will delegate, and then do all the work in the
 * main session with `edit` / `write` / `bash`.
 *
 * This module owns the deterministic half of the fix: the decision logic for a
 * HARD GATE at the tool-call boundary. Another module wires it into the
 * extension's `tool_call` hook:
 *
 *   - a mutating call (edit / write / mutating bash) while delegation is
 *     required and no `trimegisto` batch has been launched yet is BLOCKED;
 *   - the model is told, imperatively, to launch the batch before mutating;
 *   - after MAX_GATE_BLOCKS blocks the gate FAILS OPEN so a stuck model can
 *     still finish the work solo (never brick the session).
 *
 * Everything here is pure: same input -> same output. No config, no clock, no
 * I/O, no imports. The atomicity analysis deliberately re-declares the
 * ACTION_STEMS / VERB_SUFFIX / FILE_PATH_RE ideas from `delegation.ts` instead
 * of importing them, so this file stays standalone and `delegation.ts` is
 * never modified.
 */

/** Number of mutating calls the gate blocks before it fails open. */
export const MAX_GATE_BLOCKS = 2;

/** Inputs the wiring layer knows at tool-call time. */
export interface GateDecisionInput {
  /** Trimegisto is enabled for this session. */
  enabled: boolean;
  /** The delegation contract is in default-delegate mode. */
  autoSpawn: boolean;
  /** Total usable parallel slots (sum of positive tier capacities). */
  parallelSlots: number;
  /** The RAW user prompt for the current turn. */
  prompt: string;
}

// ---------------------------------------------------------------------------
// Prompt atomicity
// ---------------------------------------------------------------------------

/**
 * Action verbs as STEMS so inflections match ("añadas", "creating"). Stems are
 * long enough that a noun cannot be mistaken for a verb. Mirrors delegation.ts.
 */
const ACTION_STEMS = [
  // Spanish stems
  "arregl", "añad", "anad", "agreg", "cre", "implement", "refactoriz", "revis",
  "teste", "prueb", "actualiz", "document", "migr", "corrig", "optimiz", "limpi",
  "elimin", "borr", "renombr", "extra", "analiz", "audit", "valid", "verific",
  "configur", "integr", "public", "despleg", "diseñ", "disen", "escrib", "constru",
  "reemplaz", "muev", "adapt", "convert", "separ", "conect", "activ", "desactiv",
  "instal", "ejecut", "comprueb", "investig", "planific", "reescrib", "fusion", "divid",
  // English stems
  "fix", "add", "creat", "implement", "refactor", "review", "test", "updat", "document",
  "migrat", "correct", "optimiz", "clean", "remov", "delet", "renam", "extract",
  "analyz", "audit", "validat", "verif", "configur", "integrat", "publish", "deploy",
  "design", "writ", "build", "replac", "mov", "adapt", "convert", "split", "merg",
  "install", "run", "check", "investigat", "plan", "rewrit",
];

/** Common inflections appended to a stem. */
const VERB_SUFFIX =
  "(?:e|a|o|y|s|es|ies|as|os|ar|er|ir|ed|ing|ning|ado|ada|idos|idas|ando|iendo|i\u00f3n|iones|amos|\u00e1is|an|en|\u00eda|\u00edas|\u00edan|\u00e9|\u00f3)?";

/** Distinct file paths with a recognised code/doc extension. */
const FILE_PATH_RE =
  /(?:^|[\s("'`,;:])((?:(?:\.{0,2}\/)?[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|cs|kt|swift|md|mdx|json|ya?ml|toml|css|scss|sass|less|html?|vue|svelte|sql|sh|bash|zsh|txt))(?=$|[\s)"'`,;:.!?])/i;

/** Precompiled action-verb detectors (non-global: `.test()` is stateless). */
const ACTION_VERB_RES = ACTION_STEMS.map(
  (stem) => new RegExp(`(?:^|[^\\p{L}])${stem}${VERB_SUFFIX}(?![\\p{L}])`, "iu"),
);

function countActionVerbs(text: string): number {
  return ACTION_VERB_RES.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

function hasActionVerb(text: string): boolean {
  return countActionVerbs(text) > 0;
}

/** Distinct file paths in the text (lower-cased). */
function countFilePaths(text: string): number {
  const rx = new RegExp(FILE_PATH_RE.source, FILE_PATH_RE.flags + "g");
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    seen.add((m[1] ?? m[0]).toLowerCase());
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  return seen.size;
}

/** Coordinated clauses that usually mean more than one unit of work. */
const COORD_RE = /\b(?:y|e|and|adem[aá]s|tambi[eé]n|also|plus|then|luego|despu[eé]s)\b/i;
/** A list marker at the start of a line (no `g` flag: `.test()` must be stateless). */
const LIST_MARKER_RE = /(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/;

/**
 * Conservative read of the raw prompt. TRUE only when the request is genuinely
 * single-step; the DEFAULT is FALSE, so an unknown medium request is treated as
 * non-atomic and therefore requires delegation.
 *
 *   1. empty / whitespace-only            -> true
 *   2. trimmed starts with "/"            -> true (slash commands are one step)
 *   3. pure question: ends with "?", <= 160 chars, no action verb, no file path
 *   4. short ask: <= 12 words, no action verb, no file path
 *   5. one small change in EXACTLY one named file: <= 20 words, one file path,
 *      at most one action verb, no coordinator ("and"/"y"/...), no list
 *   otherwise -> false (the default: require delegation)
 *
 * (5) is what keeps a genuine one-line fix solo without opening a loophole:
 * a request with no named target stays gated, and two files or two verbs do.
 */
export function isAtomicPrompt(prompt: string): boolean {
  const text = String(prompt ?? "").trim();
  if (text.length === 0) return true;
  if (text.startsWith("/")) return true;

  const verbs = countActionVerbs(text);
  const paths = countFilePaths(text);
  const verb = verbs > 0;
  const path = paths > 0;

  if (text.endsWith("?") && text.length <= 160 && !verb && !path) return true;

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 12 && !verb && !path && !COORD_RE.test(text) && !LIST_MARKER_RE.test(text)) return true;

  if (words <= 20 && paths === 1 && verbs <= 1 && !COORD_RE.test(text) && !LIST_MARKER_RE.test(text)) {
    return true;
  }

  return false;
}

/**
 * TRUE when delegation is both possible and mandated for this turn:
 * enabled AND auto-spawn AND usable capacity AND the prompt is not atomic.
 */
export function shouldRequireDelegation(input: GateDecisionInput): boolean {
  if (!input) return false;
  if (!input.enabled || !input.autoSpawn) return false;
  const slots = Number(input.parallelSlots);
  if (!Number.isFinite(slots) || slots <= 0) return false;
  return !isAtomicPrompt(input.prompt);
}

// ---------------------------------------------------------------------------
// Mutating tool-call detection
// ---------------------------------------------------------------------------

/** Output redirection `>` / `>>`, ignoring `=>`, `->` and fd redirection `>&`. */
const REDIRECT_RE = /(?:^|[^-=<>])>{1,2}(?![=&])/;

/** Redirections to the null device (`/dev/null`, Windows `NUL`) discard
 * output and cannot mutate the workspace — strip them before the redirect
 * check so `grep -x 2>/dev/null` stays read-only. */
const NULL_REDIRECT_RE = /(?:^|[\s;|&\d])>{1,2}\s*(?:\/dev\/null|nul)\b/gi;
/** Heredoc. */
const HEREDOC_RE = /<</;
/** `tee <file>` writes through a pipe to a file. */
const TEE_RE = /\btee\s/;
/** In-place sed / perl. */
const SED_INPLACE_RE = /\bsed\b[^|;&\n]*?(?:\s-i\b|\s--in-place\b)/;
const PERL_INPLACE_RE = /\bperl\b[^|;&\n]*?(?:\s-i\b|\s--in-place\b)/;
/** Filesystem mutators. */
const FS_MUTATORS_RE = /\b(?:rm|mv|cp|ln|dd)\s|\b(?:mkdir|touch|chmod|chown|truncate)\b/;
/** `find ... -delete` removes files while keeping a read-only head. */
const FIND_DELETE_RE = /\bfind\b[^|;&\n]*-delete\b/;
/** Mutating git subcommand, allowing common global flags before it. */
const MUTATING_GIT_RE =
  /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--no-pager|--paginate|--exec-path)\s+\S+\s+)*(?:add|commit|push|reset|checkout|apply|merge|rebase|rm|clean|init|clone|fetch|pull|switch|restore|mv)\b/;
/** Package-manager installs / removals / upgrades. */
const PACKAGE_MUTATORS_RE =
  /\b(?:npm|yarn|pnpm|bun|pip|pip3|cargo|go|apt|apt-get|brew|dnf|yum)\s+(?:install|add|remove|upgrade|uninstall)\b/;
/** Inline interpreters capable of writing files. */
const PY_INLINE_RE = /\bpython[23]?\b[^|;&\n]*\s-c\b/;
const NODE_INLINE_RE = /\bnode\b[^|;&\n]*\s-e\b/;
/** A write inside inline code: open(...,'w'|'a'|'w+') or writeFile(Sync). */
const WRITE_CODE_RE = /\bwriteFile(?:Sync)?\b|open\s*\([^)]*['"][wa][+b]*['"]/;

/**
 * Command heads that only read. A command is treated as READ-ONLY only when
 * EVERY segment (`|`, `||`, `&&`, `;`, newline) starts with one of these AND no
 * explicit mutating pattern is present anywhere. The ALLOWLIST is deliberate:
 * anything unknown (`sh -c`, `xargs`, `curl -o`, `patch`, aliases, a new tool)
 * defaults to MUTATING, so the gate cannot be bypassed by a form the denylist
 * never anticipated. It is a nudge, not a sandbox.
 */
const READ_ONLY_HEADS = new Set([
  "ls", "cat", "bat", "rg", "ripgrep", "grep", "egrep", "fgrep", "find", "fd",
  "head", "tail", "wc", "awk", "sed", "perl", "sort", "uniq", "cut", "tr", "column",
  "nl", "tac", "rev", "jq", "yq", "xxd", "od", "hexdump", "strings", "md5sum",
  "sha1sum", "sha256sum", "shasum", "diff", "comm", "cmp", "pwd", "cd", "which",
  "whereis", "whoami", "id", "uname", "hostname", "date", "env", "printenv", "file",
  "stat", "du", "df", "tree", "realpath", "readlink", "basename", "dirname", "echo",
  "printf", "test", "[", "true", "false", "seq", "sleep", "ps", "free", "uptime",
  "nproc", "type", "command", "git",
]);

/** Git subcommands that never write the tree/index. */
const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree",
  "blame", "describe", "shortlog", "show-ref", "cat-file", "whatchanged", "grep",
  "for-each-ref",
]);

/** `git <safe>` with a per-subcommand guard for the ambiguous ones. */
function isReadOnlyGit(tokens: string[]): boolean {
  let i = 1;
  // Skip git global flags (and the value of the ones that take one).
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" ||
        t === "--namespace" || t === "--exec-path") { i += 2; continue; }
    if (t === "--no-pager" || t === "--paginate") { i += 1; continue; }
    if (t.startsWith("-")) return false; // unrecognised global flag: treat as mutating
    break;
  }
  const sub = tokens[i];
  if (!sub) return false;
  if (READ_ONLY_GIT.has(sub)) return true;
  const rest = tokens.slice(i + 1);
  if (sub === "config") return rest.some(a => a === "--get" || a === "--get-all" || a === "--get-regexp" || a === "--list" || a === "-l");
  if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "--verbose" || rest[0] === "show" || rest[0] === "get-url";
  if (sub === "branch") return rest.length === 0 || rest.every(a => /^-(a|r|v|vv|all|remotes|verbose|list)$|^--(all|remotes|verbose|list)$/.test(a));
  if (sub === "tag") return rest.length === 0 || rest.every(a => /^-l$|^--list$/.test(a));
  if (sub === "stash") return rest.length === 0 ? true : (rest[0] === "list" || rest[0] === "show");
  return false;
}

/** Probes / checks that run a binary but do not mutate the workspace. */
function isReadOnlyInvocation(tokens: string[]): boolean {
  const head = tokens[0];
  if (tokens.length <= 2 && /^(--version|-v|-V|--help|-h)$/.test(tokens[1] ?? "")) return true;
  if (head === "tsc") return tokens.slice(1).some(a => a === "--noEmit");
  if (head === "node") return tokens[1] === "--test";
  if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
    const a = tokens[1];
    const b = tokens[2];
    return a === "test" || (a === "run" && (b === "test" || b === "lint" || b === "typecheck" || b === "type-check"));
  }
  return false;
}

/** Split on shell separators, keeping only non-empty trimmed segments. */
function splitSegments(cmd: string): string[] {
  return cmd.split(/\|\||&&|[|;\n]/).map(s => s.trim()).filter(Boolean);
}

/** Strip leading `VAR=...` assignments so `FOO=bar npm install` is seen as npm. */
function stripEnvAssignments(command: string): string {
  let cmd = String(command ?? "").trim();
  const re = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
  let guard = 0;
  while (re.test(cmd) && guard++ < 64) {
    const next = cmd.replace(re, "");
    if (next === cmd) break;
    cmd = next;
  }
  return cmd.trim();
}

/**
 * TRUE when the command can change the workspace. ALLOWLIST-FIRST: an explicit
 * mutating pattern wins immediately; otherwise every shell segment must be an
 * allowlisted read-only head (or a read-only probe) or the command is mutating.
 */
export function isMutatingBashCommand(command: string): boolean {
  const cmd = stripEnvAssignments(String(command ?? ""));
  if (cmd.length === 0) return false;

  const nullStripped = cmd.replace(NULL_REDIRECT_RE, " ");
  if (REDIRECT_RE.test(nullStripped)) return true;
  if (HEREDOC_RE.test(cmd)) return true;
  if (TEE_RE.test(cmd)) return true;
  if (SED_INPLACE_RE.test(cmd)) return true;
  if (PERL_INPLACE_RE.test(cmd)) return true;
  if (FS_MUTATORS_RE.test(cmd)) return true;
  if (FIND_DELETE_RE.test(cmd)) return true;
  if (MUTATING_GIT_RE.test(cmd)) return true;
  if (PACKAGE_MUTATORS_RE.test(cmd)) return true;
  if ((PY_INLINE_RE.test(cmd) || NODE_INLINE_RE.test(cmd)) && WRITE_CODE_RE.test(cmd)) return true;

  for (const seg of splitSegments(cmd)) {
    const stripped = stripEnvAssignments(seg);
    if (stripped.length === 0) continue;
    const tokens = stripped.split(/\s+/);
    const head = tokens[0];
    if (!READ_ONLY_HEADS.has(head) && !isReadOnlyInvocation(tokens)) return true;
    if (head === "git" && !isReadOnlyGit(tokens)) return true;
  }
  return false;
}

/**
 * TRUE only for tool calls that mutate the workspace: `edit`, `write`, and
 * `bash` / `powershell` whose command is mutating. Reads, searches, plans,
 * `trimegisto*` and `file_*` stay open so the model can plan the batch.
 */
export function isMutatingToolCall(toolName: string, input: Record<string, unknown>): boolean {
  const name = String(toolName ?? "").toLowerCase();
  if (name === "edit" || name === "write") return true;
  if (name === "bash" || name === "powershell") {
    return isMutatingBashCommand(String(input?.command ?? ""));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Model-facing status / block messages
// ---------------------------------------------------------------------------

/**
 * Block message shown when a mutating call is refused. Imperative and short so
 * the model reads it and launches the batch instead of retrying blindly.
 */
export function formatDelegationGateReason(opts: {
  attempt: number;
  capacity: string;
  maxBlocks: number;
}): string {
  const attempt = Number(opts?.attempt ?? 0);
  const maxBlocks = Number(opts?.maxBlocks ?? MAX_GATE_BLOCKS);
  const capacity = typeof opts?.capacity === "string" ? opts.capacity.trim() : "";

  const lines = [
    "Delegation gate: this request is NOT atomic. Launching a `trimegisto` batch is REQUIRED before this edit/write/bash \u2014 do not do the work in the main session.",
  ];
  if (capacity) lines.push(capacity);
  lines.push("read/grep/find/ls stay open for planning; only mutating tool calls are blocked.");
  if (Number.isFinite(attempt) && Number.isFinite(maxBlocks) && attempt >= maxBlocks) {
    lines.push(
      `Hard block ${attempt}/${maxBlocks}: the gate FAILS OPEN on your NEXT mutating call. Launch the \`trimegisto\` batch NOW.`,
    );
  }
  return lines.join("\n");
}

/**
 * One-line dashboard/telemetry status, e.g.
 *   "gate: required, not launched, 1 block(s)"
 *   "gate: off"
 */
export function formatGateStatus(required: boolean, launched: boolean, blocks: number): string {
  if (!required) return "gate: off";
  const n = Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 0;
  return `gate: required, ${launched ? "launched" : "not launched"}, ${n} block(s)`;
}
