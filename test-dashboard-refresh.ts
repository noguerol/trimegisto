/**
 * Trimegisto - dashboard refresh policy tests
 *
 * Run: node --experimental-strip-types test-dashboard-refresh.ts
 *
 * THE REGRESSION UNDER TEST
 * -------------------------
 * The refresh ticker asked pi for a repaint every 500 ms on top of the repaints
 * pi already performs while the main assistant streams. Each repaint
 * re-rendered the dashboard widget, whose elapsed/speed text changes on every
 * tick; the whole TUI blinked. The policy below is the single place that says
 * when the ticker may drive a repaint.
 */

import { shouldDriveDashboardRender } from "./src/tui-refresh.ts";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`, detail ?? ""); }
};

const base = { enabled: true, hasUI: true, liveAgents: 2, liveActivity: true, mainStreaming: false };

console.log("shouldDriveDashboardRender: the blink is pi's repaint being doubled:");
{
  check("main streaming -> do NOT drive a repaint (pi already renders)",
    shouldDriveDashboardRender({ ...base, mainStreaming: true }) === false);
  check("main streaming wins even with live agents and activity",
    shouldDriveDashboardRender({ enabled: true, hasUI: true, liveAgents: 9, liveActivity: true, mainStreaming: true }) === false);
  check("idle main + live agents -> drive the repaint",
    shouldDriveDashboardRender({ ...base, liveActivity: false }) === true);
  check("idle main + live activity only -> drive the repaint",
    shouldDriveDashboardRender({ ...base, liveAgents: 0 }) === true);
}

console.log("shouldDriveDashboardRender: negative paths never render:");
{
  check("disabled -> no render", shouldDriveDashboardRender({ ...base, enabled: false }) === false);
  check("no UI -> no render", shouldDriveDashboardRender({ ...base, hasUI: false }) === false);
  check("nothing live -> no render",
    shouldDriveDashboardRender({ ...base, liveAgents: 0, liveActivity: false }) === false);
  check("null input -> no render", shouldDriveDashboardRender(undefined as any) === false);
  check("NaN liveAgents with no activity -> no render",
    shouldDriveDashboardRender({ ...base, liveAgents: NaN, liveActivity: false }) === false);
  check("negative liveAgents with no activity -> no render",
    shouldDriveDashboardRender({ ...base, liveAgents: -3, liveActivity: false }) === false);
  check("NaN liveAgents with activity -> render",
    shouldDriveDashboardRender({ ...base, liveAgents: NaN, liveActivity: true }) === true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
