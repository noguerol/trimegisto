/**
 * Trimegisto - Agent control channel (parent -> child)
 *
 * Sub-agents run as one-shot `pi -p` processes with stdin ignored, so the
 * coordinator cannot write to them directly. This module is the contract both
 * sides share:
 *
 *   1. `parseAgentCommand` is the PURE parser for the user-facing commands
 *      `@t2b` (mention), `@t2b kill`, `@t2b do this` (steer) and `@t2 spawn
 *      that` (launch). It is pure so it can be tested without the extension
 *      runtime. ONE shape for every entry point: whatever the user types after
 *      `@` (or `/`) means the same thing in chat and in the `/@` command.
 *   2. `writeAgentControl` / `drainAgentControls` implement a tiny file mailbox
 *      under `<instanceDir>/control/<agentId>/`. The parent drops a steer
 *      request and the child's extension polls it, injecting the instruction
 *      into the LIVE run. This replaces the old "kill the agent and respawn it
 *      with the instruction" behaviour, which lost the agent's whole context.
 *      (`@<id> compact` is handled parent-side as a restart with a bounded
 *      digest, because pi's manual compaction aborts a one-shot sub-agent.)
 *
 * No pi imports here on purpose: the sub-agent process and the parent both load
 * it, and tests load it with no runtime at all.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTier } from "./types.ts";

// ── Command parsing ─────────────────────────────────────────

/**
 * What a `@tier[letter] [body]` / `/tier[letter] [body]` command means.
 *
 *   mention  `@t2b`            — show that agent (status, tokens, task)
 *   steer    `@t2b do this`    — inject the instruction into the live run
 *   halt     `@t2b kill`      — stop ONLY that agent (halt/stop are aliases)
 *   compact  `@t2b compact`   — restart it with a bounded progress digest
 *   spawn    `@t2 <task>`     — launch a new agent in that tier
 */
export type AgentControlVerb = "spawn" | "steer" | "halt" | "compact" | "mention";

export interface AgentCommand {
  /** Original trimmed text, for echoing. */
  raw: string;
  /** Tier the prefix names (t0 collapses to "active"). */
  tier: AgentTier;
  /** Explicit agent id (e.g. "t2b"), or null for a bare tier mention. */
  agentId: string | null;
  verb: AgentControlVerb;
  /** Instruction text (steer/spawn); empty for mention/halt/compact. */
  text: string;
}

/** Words that, alone, mean "stop this agent". `kill` is the canonical one. */
const HALT_WORDS = new Set(["kill", "halt", "stop"]);
/** Words that, alone, mean "compact this agent". */
const COMPACT_WORDS = new Set(["compact", "compaction"]);

/** `@`/`/` + tier + optional instance letter + the rest, unvalidated. */
const COMMAND_RE = /^[/@]\s*t([0123])([a-z]?)([\s\S]*)$/i;
/** The id must be followed by whitespace or one of these separators. */
const SEPARATOR_RE = /^[\s:,\u2014]/;

/**
 * Parse `@t2b` (mention), `@t2b kill`, `@t2b compact`, `@t2b <instruction>`
 * (steer) or `@t2 <task>` (launch). Both `@` and `/` prefixes work.
 *
 * A trailing standalone `kill`/`halt`/`stop`/`compact` is a control verb;
 * anything else after an explicit agent id is a steer instruction. A bare tier
 * (`@t2`) with no task mentions the TIER; with a task it spawns.
 *
 * Returns null when the text is not an agent command at all.
 */
export function parseAgentCommand(text: string): AgentCommand | null {
  const raw = text.trim();
  const m = raw.match(COMMAND_RE);
  if (!m) return null;

  const tierWord = `t${m[1]}`.toLowerCase();
  const tier = (tierWord === "t0" ? "active" : tierWord) as AgentTier;
  const letter = (m[2] || "").toLowerCase();
  // "@t2bdo" is not agent t2b with task "do": an id is only an id when the
  // text after it is separated (`@t2b: fix`, `@t2b, fix`, `@t2b fix`).
  const rest = m[3] || "";
  if (rest && !SEPARATOR_RE.test(rest)) return null;
  const body = rest.replace(/^[\s:,\u2014]+/, "").trim();
  const agentId = letter ? `${tierWord}${letter}` : null;

  if (!body) {
    // Mention: `@t2b` alone shows that agent, `@t2` alone shows the tier.
    return { raw, tier, agentId, verb: "mention", text: "" };
  }

  // Ignore trailing sentence punctuation when matching a one-word verb:
  // `@t2b kill.` and `@t2b kill!` still mean kill, not "steer an instruction
  // called kill". A word that merely STARTS with a verb stays an instruction
  // (`@t2b kill-9 the process`).
  const low = body.toLowerCase().replace(/[.!]+$/, "");

  if (agentId && HALT_WORDS.has(low)) {
    return { raw, tier, agentId, verb: "halt", text: "" };
  }
  if (agentId && COMPACT_WORDS.has(low)) {
    return { raw, tier, agentId, verb: "compact", text: "" };
  }
  return { raw, tier, agentId, verb: agentId ? "steer" : "spawn", text: body };
}

// ── Control mailbox ─────────────────────────────────────────

export type AgentControlKind = "steer";

export interface AgentControlRequest {
  id: string;
  kind: AgentControlKind;
  /** Instruction text for `steer`. */
  text?: string;
  ts: number;
}

/** Request files older than this are ignored and swept (a dead agent never reads them). */
export const CONTROL_REQUEST_TTL_MS = 10 * 60_000;

/** Agent ids are generated by us; reject anything that could escape the dir. */
function safeAgentId(agentId: string): string | null {
  return /^[A-Za-z0-9_-]{1,32}$/.test(agentId) ? agentId : null;
}

/** `<baseDir>/control/<agentId>` */
export function agentControlDir(baseDir: string, agentId: string): string | null {
  const safe = safeAgentId(agentId);
  if (!safe) return null;
  return path.join(baseDir, "control", safe);
}

/**
 * Drop a control request for `agentId`. Atomic (tmp + rename) so the child can
 * never read a half-written file. Returns false on an invalid id or I/O error —
 * the caller degrades to a notify, never throws.
 */
export function writeAgentControl(
  baseDir: string,
  agentId: string,
  kind: AgentControlKind,
  opts: { text?: string } = {},
): boolean {
  const dir = agentControlDir(baseDir, agentId);
  if (!dir) return false;
  const request: AgentControlRequest = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    ts: Date.now(),
  };
  if (kind === "steer" && opts.text) request.text = opts.text;

  try {
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `${request.id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(request), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and CONSUME every pending control request for `agentId`, oldest first.
 * Corrupt files are deleted; stale files (older than the TTL) are swept without
 * being returned. Never throws.
 */
export function drainAgentControls(baseDir: string, agentId: string): AgentControlRequest[] {
  const dir = agentControlDir(baseDir, agentId);
  if (!dir) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const now = Date.now();
  const out: AgentControlRequest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentControlRequest;
      if (typeof parsed?.id !== "string" || parsed.kind !== "steer") {
        fs.unlinkSync(filePath);
        continue;
      }
      if (now - (parsed.ts || 0) > CONTROL_REQUEST_TTL_MS) {
        fs.unlinkSync(filePath);
        continue;
      }
      out.push(parsed);
      fs.unlinkSync(filePath);
    } catch {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }
  return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

/** Remove the whole control directory for an agent (called when it is killed). */
export function clearAgentControls(baseDir: string, agentId: string): void {
  const dir = agentControlDir(baseDir, agentId);
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Compaction digest ───────────────────────────────────────

/**
 * Condense an agent's accumulated output into a progress digest.
 *
 * Sub-agents are one-shot `pi -p` processes with an ephemeral session, so pi's
 * manual compaction (which aborts the run) cannot survive: the process exits
 * before the compaction finishes and the ephemeral session is discarded. The
 * honest "compact this agent" is therefore a restart carrying a BOUNDED digest
 * of what it had produced. We keep the head (the setup) and the tail (the
 * latest state) — exactly what a human skimming a long log would keep.
 */
export function condenseForCompaction(text: string, maxChars: number = 6000): string {
  const clean = (text || "").trim();
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 6000;
  if (clean.length <= limit) return clean;
  const head = Math.floor(limit * 0.35);
  const tail = Math.max(0, limit - head - 40);
  const omitted = clean.length - head - tail;
  return `${clean.slice(0, head)}\n\n\u2026 [${omitted} chars omitted during compaction] \u2026\n\n${clean.slice(-tail)}`;
}
