/**
 * Trimegisto - `@<agent-id>` mentions
 *
 * A mention is the user-facing way to LOOK at an agent without changing it:
 *
 *     @t2b                  show t2b (status, model, time, tokens, task)
 *     @t2b <instruction>    steer it in place
 *     @t2b kill             stop only that agent
 *     @t2 <task>            launch a new T2 agent
 *
 * The rendering lives here, pure and small, so the ONE shape of a mention is
 * unit-tested instead of being re-implemented by every entry point (chat input
 * interception, the `/@` command and the help text).
 *
 * No pi imports: the caller passes the tier label in, so this module can be
 * loaded by a plain `node --experimental-strip-types` test.
 */

import { displayTaskOf, type TaskBearing } from "./task-display.ts";

/** The slice of an agent a mention renders (structurally an AgentInstance). */
export interface Mentionable extends TaskBearing {
  id: string;
  tier: string;
  status: string;
  model?: string;
  requestedModel?: string;
  startedAt: number;
  /** Accumulated time in a terminal/stopped state (freezes the clock). */
  idleMs?: number;
  /** When the agent last entered a terminal/stopped state. */
  idleSince?: number;
  usage?: { input?: number; output?: number; cost?: number; turns?: number };
  /** The agent's own final answer (terminal agents only). */
  finalOutput?: string;
}

export interface MentionFormatOptions {
  /** Human tier label ("Active", "T2", …). Defaults to the raw tier. */
  tierLabel?: (tier: string) => string;
  /** Clock, injectable for tests. */
  now?: number;
}

const STATUS_ICON: Record<string, string> = {
  running: "◌",
  waiting: "◷",
  done: "✓",
  error: "✗",
  killed: "⊘",
  idle: "·",
};

const isLive = (status: string): boolean => status === "running" || status === "waiting";

/** 1234 -> "1.2k"; 1250000 -> "1.3M" */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 1234 -> "1.2s"; 61000 -> "1m1s" */
export function formatMentionElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(safe < 10_000 ? 1 : 0)}s`;
  const mins = Math.floor(safe / 60_000);
  const secs = Math.floor((safe % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

/** Model id -> its last segment, capped so one long id cannot fill the line. */
function modelLabel(agent: Mentionable): string {
  const raw = (agent.model || agent.requestedModel || "").trim();
  if (!raw) return "";
  const short = raw.split("/").filter(Boolean).pop() || raw;
  return short.length > 28 ? `${short.slice(0, 27)}…` : short;
}

/** Wall time minus the time the agent spent stopped (the clock freezes). */
function liveElapsed(agent: Mentionable, now: number): number {
  let idle = agent.idleMs || 0;
  if (agent.idleSince !== undefined) idle += now - agent.idleSince;
  return Math.max(0, now - agent.startedAt - idle);
}

function clip(text: string, max: number): string {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** First meaningful line of the agent's own answer, for a terminal mention. */
function lastAnswer(agent: Mentionable): string {
  const source = (agent.finalOutput || "").trim();
  if (!source) return "";
  const line = source.split("\n").map(l => l.trim()).find(l => l.length > 0) || "";
  return clip(line, 140);
}

/**
 * Render one agent mention.
 *
 *   ◌ t2b · T2 · Kimi K3 · 12.3s · 📤1.2k 📥3.4k · 4 turns · ~$0.004 — rewrite…
 *      steer: @t2b <instruction> · kill: @t2b kill · compact: @t2b compact
 *
 * A finished agent has nothing to steer, so its hint points at a fresh launch
 * and its last answer is shown instead.
 */
export function formatAgentMention(agent: Mentionable, opts: MentionFormatOptions = {}): string {
  const now = opts.now ?? Date.now();
  const tierLabel = opts.tierLabel ? opts.tierLabel(agent.tier) : agent.tier;
  const icon = STATUS_ICON[agent.status] || "·";
  const live = isLive(agent.status);

  const parts: string[] = [`${icon} ${agent.id}`, tierLabel];
  const model = modelLabel(agent);
  if (model) parts.push(model);
  parts.push(formatMentionElapsed(liveElapsed(agent, now)));

  const usage = agent.usage || {};
  const flow: string[] = [];
  if ((usage.output || 0) > 0) flow.push(`📤${formatTokens(usage.output || 0)}`);
  if ((usage.input || 0) > 0) flow.push(`📥${formatTokens(usage.input || 0)}`);
  if ((usage.turns || 0) > 0) flow.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if ((usage.cost || 0) > 0) flow.push(`~$${(usage.cost || 0).toFixed(4)}`);
  if (flow.length > 0) parts.push(flow.join(" "));

  if (!live) parts.push(agent.status);

  const task = clip(displayTaskOf(agent), 90);
  const head = `${parts.join(" · ")}${task ? ` — ${task}` : ""}`;

  const hint = live
    ? `steer: @${agent.id} <instruction> · kill: @${agent.id} kill · compact: @${agent.id} compact`
    : `finished — mention shows its last answer; new work: @${agent.tier === "active" ? "t0" : agent.tier} <task>`;

  const lines = [head];
  const last = live ? "" : lastAnswer(agent);
  if (last) lines.push(`   last: ${last}`);
  lines.push(`   ${hint}`);
  return lines.join("\n");
}

/**
 * Render a bare tier mention (`@t2`): the tier line plus every agent it owns.
 * Never spawns — a tier mention with no task is informational.
 */
export function formatTierMention(
  tierLabel: string,
  agents: Mentionable[],
  opts: MentionFormatOptions & { statusLine?: string; spawnId?: string } = {},
): string {
  const now = opts.now ?? Date.now();
  const spawnId = opts.spawnId || "t2";
  const counts: Record<string, number> = {};
  for (const a of agents) counts[a.status] = (counts[a.status] || 0) + 1;
  const summary = Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(" · ");

  const head = opts.statusLine
    ? opts.statusLine
    : `${tierLabel}${summary ? ` · ${summary}` : " · no agents yet"}`;

  const lines = [head];
  if (agents.length > 0) {
    const list = agents
      .slice(0, 6)
      .map(a => `${STATUS_ICON[a.status] || "·"}${a.id} ${formatMentionElapsed(liveElapsed(a, now))}`)
      .join(" · ");
    lines.push(`   ${list}${agents.length > 6 ? ` · +${agents.length - 6}` : ""}`);
  }
  lines.push(`   launch: @${spawnId} <task>`);
  return lines.join("\n");
}

/** One-line usage string shared by every entry point (and the help text). */
export const MENTION_USAGE =
  "Usage: @<agent-id> [instruction|kill|compact]\n" +
  "  @t2b                 show t2b (status, model, time, tokens, task)\n" +
  "  @t2b <instruction>   steer it in place\n" +
  "  @t2b kill            stop only that agent\n" +
  "  @t2b compact         free its context (restart with a digest)\n" +
  "  @t2 <task>           launch a new T2 agent";
