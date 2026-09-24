/**
 * Trimegisto - delegation contract
 *
 * The coordinator only delegates when the SYSTEM PROMPT makes delegation the
 * default and tells it where the capacity is. This module owns that text and
 * the deterministic, model-free analysis behind it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The older policy was opt-in (it said to "prefer delegating" when the request
 * decomposed). Models read that as "delegate if you happen to feel like it" and
 * did the work serially, leaving every configured slot idle. Measured symptom:
 * `trimegisto` was available, enabled and advertised, and was simply not called.
 *
 * The contract inverts the default:
 *
 *   - delegate unless the request is PROVABLY atomic (the allowlist below);
 *   - fill the configured slots before falling back to solo work;
 *   - the units stay disjoint, so "fill the slots" can never mean padding the
 *     batch with redundant work.
 *
 * `analyzeDecomposability()` is the deterministic half: it reads the RAW user
 * prompt (available on `before_agent_start`) and, when the wording itself
 * splits into parts, appends a one-line reinforcement to the system prompt for
 * that run. It is deliberately conservative — a false positive only adds a
 * sentence to the system prompt, but it must not nag on genuine one-liners.
 *
 * Everything here is pure: same input -> same output. No config, no clock, no
 * I/O, so the contract text stays cacheable and the tests are exact.
 */

/** One enabled tier and its effective parallel capacity. */
export interface CapacitySlot {
  /** Display label, e.g. "Active (t0)" or "T2". */
  tier: string;
  /** Positive slot count; non-positive entries are ignored. */
  slots: number;
}

/** Sum of the positive slot counts. Empty/all-zero input -> 0. */
export function totalSlots(slots: CapacitySlot[]): number {
  return (slots ?? []).reduce((n, s) => n + (Number.isFinite(s.slots) && s.slots > 0 ? Math.floor(s.slots) : 0), 0);
}

/**
 * "6 parallel slots configured: Active (t0) 2, T2 2, T3 2."
 * Empty / all-zero input -> "" (nothing to advertise).
 */
export function formatCapacitySummary(slots: CapacitySlot[]): string {
  const usable = (slots ?? []).filter(s => Number.isFinite(s.slots) && s.slots > 0);
  const total = totalSlots(usable);
  if (total <= 0) return "";
  const breakdown = usable.map(s => `${s.tier} ${Math.floor(s.slots)}`).join(", ");
  return `${total} parallel slot${total === 1 ? "" : "s"} configured (${breakdown}).`;
}

/**
 * Action verbs as STEMS, so inflections match too ("añadas", "actualices",
 * "creating", "running"). Stems are chosen long enough that the suffix
 * check below cannot turn a noun into a false verb ("credencial" never
 * matches "cre", "movie" never matches "mov").
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

/** Common inflections appended to a stem, tried before the word-boundary check. */
const VERB_SUFFIX =
  "(?:e|a|o|y|s|es|ies|as|os|ar|er|ir|ed|ing|ning|ado|ada|idos|idas|ando|iendo|i\u00f3n|iones|amos|\u00e1is|an|en|\u00eda|\u00edas|\u00edan|\u00e9|\u00f3)?";

/** Distinct file paths with a recognised code/doc extension. */
const FILE_PATH_RE =
  /(?:^|[\s("'`,;:])((?:(?:\.{0,2}\/)?[\w.@-]+\/)*[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|cs|kt|swift|md|mdx|json|ya?ml|toml|css|scss|sass|less|html?|vue|svelte|sql|sh|bash|zsh|txt))(?=$|[\s)"'`,;:.!?])/gi;

/** A list item: "- x", "* x", "+ x", "1. x", "2) x". */
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/gm;

/** Coordinated clauses: "X y Z", "X also Z", "X then Z". */
const CONJUNCTION_RE = /\b(?:y|e|and|adem[aá]s|tambi[eé]n|as well as|plus|then|luego|despu[eé]s)\b/i;

function distinctMatches(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  // Clone so a caller's lastIndex (sticky/global regex reuse) cannot leak.
  const rx = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    out.add((m[1] ?? m[0]).toLowerCase());
    if (m.index === rx.lastIndex) rx.lastIndex++; // zero-length safety
  }
  return out;
}

export interface DecomposabilityAnalysis {
  /** True when the wording itself splits into independent parts. */
  decomposable: boolean;
  /** Weighted score; >= 3 is the threshold. Exposed for tests/telemetry. */
  score: number;
  /** Human-readable signals that contributed, in reading order. */
  signals: string[];
}

/**
 * Deterministic read of the RAW user prompt. Weights are intentionally coarse:
 * the goal is to catch requests that NAME several units (files, list items,
 * several actions) and to stay quiet on one-liners and pure questions.
 *
 *   >= 2 files          +3   (very strong: touches more than one artifact)
 *   list with >= 2 items +2
 *   >= 3 action verbs    +2
 *   2 action verbs       +1
 *   1 file               +1
 *   coordinated clauses  +1
 *   >= 3 clause breaks   +1
 *   length > 240 chars   +1
 *
 * Threshold 3. "fix the typo" scores 0; "arregla src/a.ts y añade tests"
 * scores 1+1+1 = 3 and is treated as decomposable.
 */
export function analyzeDecomposability(prompt: string): DecomposabilityAnalysis {
  const text = (prompt ?? "").trim();
  if (text.length === 0) return { decomposable: false, score: 0, signals: [] };

  const signals: string[] = [];
  let score = 0;

  const files = distinctMatches(text, FILE_PATH_RE);
  if (files.size >= 2) {
    score += 3;
    signals.push(`${files.size} files`);
  } else if (files.size === 1) {
    score += 1;
    signals.push("1 file");
  }

  const listItems = (text.match(LIST_ITEM_RE) ?? []).length;
  if (listItems >= 2) {
    score += 2;
    signals.push(`${listItems}-item list`);
  }

  const verbs = new Set<string>();
  for (const stem of ACTION_STEMS) {
    if (new RegExp(`(?:^|[^\\p{L}])${stem}${VERB_SUFFIX}(?![\\p{L}])`, "iu").test(text)) verbs.add(stem);
  }
  if (verbs.size >= 3) {
    score += 2;
    signals.push(`${verbs.size} action verbs`);
  } else if (verbs.size === 2) {
    score += 1;
    signals.push("2 action verbs");
  } else if (verbs.size === 1) {
    signals.push("1 action verb");
  }

  if (CONJUNCTION_RE.test(text)) {
    score += 1;
    signals.push("coordinated clauses");
  }

  const breaks = (text.match(/[;\n]|\.\s+\p{Lu}/gu) ?? []).length;
  if (breaks >= 3) {
    score += 1;
    signals.push(`${breaks} sentence breaks`);
  }

  if (text.length > 240) {
    score += 1;
    signals.push("long request");
  }

  return { decomposable: score >= 3, score, signals };
}

/**
 * One-line reinforcement for the system prompt, only when the prompt reads as
 * decomposable. "" otherwise, so an atomic request is not nagged.
 */
export function formatDecomposabilityNote(a: DecomposabilityAnalysis): string {
  if (!a || !a.decomposable) return "";
  const why = a.signals.length > 0 ? ` (${a.signals.join(", ")})` : "";
  return (
    `Decomposability check: this request reads as multiple independent units${why}. ` +
    `Plan the \`trimegisto\` batch before your first edit, and only fall back to solo work if it turns out to be atomic.`
  );
}

/**
 * The delegation contract, destined for the SYSTEM PROMPT.
 *
 * autoSpawn=true  -> default-delegate + capacity-fill + atomic allowlist.
 * autoSpawn=false -> delegation stays opt-in, phrased so the coordinator does
 *                    not invent a batch the user never asked for.
 */
export function formatDelegationContract(opts: { autoSpawn: boolean; capacity: CapacitySlot[] }): string {
  const capacity = formatCapacitySummary(opts.capacity ?? []);
  if (!opts.autoSpawn) {
    return [
      "DELEGATION: opt-in. Work solo unless the user explicitly asks for parallel agents or the request is large enough that delegation is obviously what they want.",
      "When you do delegate, make it one `trimegisto` batch of disjoint units and integrate its reconciliation yourself.",
    ].join("\n");
  }

  const lines = [
    "DELEGATION CONTRACT — the default is to delegate.",
    "- Before your first edit, read the request as a set of independent work units. If it splits into two or more, your first action is one `trimegisto` batch carrying all of them; do not do the split work serially and delegate only the leftovers.",
    "- Work solo only when the request is provably atomic: a single question or lookup, one small change in one file, or one command whose steps cannot run in parallel. \"Doing it myself is faster\" is not a reason to skip.",
  ];
  if (capacity) {
    lines.push(
      `- Fill the capacity. ${capacity} Split substantial requests along file/module/check boundaries until the batch uses the available slots, or until the remaining units stop being independent. Never pad the batch with redundant work.`,
    );
  } else {
    lines.push(
      "- Fill the capacity: split substantial requests along file/module/check boundaries until the batch uses every available slot, or until the remaining units stop being independent.",
    );
  }
  lines.push(
    "- Units stay disjoint: never two agents on the same file, question, or output.",
    "- One batch, then integrate: the batch's reconciliation is the final answer; do not re-spawn the same work.",
    "- If a tier is unavailable or the gate rejects the batch, adjust and relaunch instead of silently falling back to solo work.",
  );
  return lines.join("\n");
}
