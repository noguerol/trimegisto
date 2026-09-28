/**
 * Trimegisto - dashboard refresh policy
 *
 * The dashboard widget is a live view (elapsed seconds, prefill/decode speeds),
 * so something has to ask pi to repaint it while the main session sits idle
 * waiting on sub-agents.
 *
 * The bug this module prevents: the refresh ticker asked for a repaint every
 * 500 ms ON TOP of the repaints pi already does while the MAIN assistant message
 * streams. Each repaint re-renders the widget, whose visible text changes on
 * every tick (elapsed seconds, `↑…509ms`, `↓75t/s` — even 3→4 digits changes the
 * line width), and the whole TUI visibly blinks. pi's own stream repaints
 * already re-render the widget, so the ticker must stay quiet while the main
 * session is streaming; when idle it may drive the update, but no faster than
 * once per second.
 *
 * Pure and dependency-free so the policy is unit-tested without a terminal.
 */

export interface DashboardRefreshInput {
  /** Trimegisto is enabled for this session. */
  enabled: boolean;
  /** The renderer has a UI (TUI/RPC). */
  hasUI: boolean;
  /** Running/waiting sub-agents across every tier. */
  liveAgents: number;
  /** Live throughput samples (main or sub-agent). */
  liveActivity: boolean;
  /** The MAIN session currently has a streaming assistant message. */
  mainStreaming: boolean;
}

/**
 * Whether the refresh ticker should ask pi for a repaint.
 *
 *   - no UI / disabled          -> no
 *   - main session streaming    -> no (pi repaints on every delta already; a
 *                                  second repaint per tick is what blinked)
 *   - nothing live              -> no
 *   - otherwise                 -> yes
 */
export function shouldDriveDashboardRender(input: DashboardRefreshInput): boolean {
  if (!input) return false;
  if (!input.enabled || !input.hasUI) return false;
  if (input.mainStreaming) return false;
  const agents = Number.isFinite(input.liveAgents) ? input.liveAgents : 0;
  return agents > 0 || input.liveActivity === true;
}
