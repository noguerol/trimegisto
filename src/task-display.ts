/**
 * Trimegisto - user-facing task text
 *
 * A dependent worker is launched with an internal preamble prepended to its
 * task ("Upstream results from this Trimegisto batch …"). That preamble MUST
 * reach the worker process (and survive compaction), but it is scaffolding: the
 * user should only see the task they asked for. `agent.task` keeps the full
 * launched text; `agent.displayTask` carries the original, user-facing task and
 * every render path goes through this helper instead of reading `.task`.
 *
 * Pure and trivial so the rule (displayTask wins, task is the fallback) is
 * unit-tested and cannot silently regress at one of the many call sites.
 */

export interface TaskBearing {
  /** Full text handed to the worker (may carry an internal preamble). */
  task?: string | null;
  /** Original, user-facing task; preferred when present. */
  displayTask?: string | null;
}

/** The task text to show a human: displayTask when set, else the raw task. */
export function displayTaskOf(agent: TaskBearing | null | undefined): string {
  if (!agent) return "";
  const display = agent.displayTask;
  if (typeof display === "string" && display.trim().length > 0) return display;
  return typeof agent.task === "string" ? agent.task : "";
}
