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

import { shouldDriveDashboardRender } from "../src/tui-refresh.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, readdirSync } from "node:fs";

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

console.log("metric line: padded to a constant width so digits never shift the layout:");
{
  const width = 60;
  // The premise: unpadded, a 3->4 digit change really does change the width.
  check("unpadded metric lines differ in width",
    visibleWidth(`  \u2301 main \u2191182ms \u2193114t/s`) !== visibleWidth(`  \u2301 main \u21911182ms \u2193114t/s`));
  // The fix: every widget line is truncated AND padded to the terminal width.
  for (const sample of ["  \u2301 main \u2191182ms \u2193114t/s", "  \u2301 main \u21911182ms \u2193114t/s", "  \u2301 main \u21911s \u2193114t/s", "  \u2301 main \u21911875t/s \u21939.9t/s"]) {
    check(`padded to exactly ${width} cols: "${sample.trim()}"`,
      visibleWidth(truncateToWidth(sample, width, "\u2026", true)) === width);
  }
  check("overlong lines still truncate to exactly the width",
    visibleWidth(truncateToWidth("x".repeat(200), width, "\u2026", true)) === width);
}

console.log("footer ownership: the shared footer slot is never touched:");
{
  // pi's footer is a SINGLE shared slot. Trimegisto renders its dashboard as a
  // widget and never installs a footer, so it must not call ui.setFooter() at
  // all: `setFooter(undefined)` clears the slot and erases whatever another
  // extension put there (@narumitw/pi-statusline being the usual victim). This
  // regressed twice, so it is pinned as a source-level policy. If trimegisto
  // ever genuinely needs a footer, record ownership and clear only its own.
  const srcDir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) continue;
    if (/\.setFooter\s*\(/.test(readFileSync(new URL(entry, srcDir), "utf8"))) offenders.push(entry);
  }
  check("no src/**.ts calls ui.setFooter()", offenders.length === 0, offenders);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
