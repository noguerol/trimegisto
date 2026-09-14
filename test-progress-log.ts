/**
 * Trimegisto - progress-log deferral tests
 *
 * Run: node --experimental-strip-types test-progress-log.ts
 *
 * Covers the "the whole TUI re-scrolls on every update while agents stream"
 * bug. pi paints a new custom entry BEFORE the streaming assistant component;
 * when that component is taller than the viewport, TuiMainScreen answers each
 * splice with a full redraw that also clears the scrollback. ProgressLogBuffer
 * holds entries until the stream ends, so they append at the END instead.
 *
 * The renderer part drives pi-tui's real TuiMainScreen against a recording
 * terminal: it reproduces the scrollback-clearing redraw when entries are
 * spliced in mid-stream and proves the buffer removes it.
 */

import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { ProgressLogBuffer, MAX_DEFERRED_PROGRESS } from "./src/progress-log.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
}

class Line extends Container {
  text: string;
  constructor(text: string) { super(); this.text = text; }
  render(_width: number): string[] { return [this.text]; }
}
class Block extends Container {
  lines: string[];
  constructor(lines: string[]) { super(); this.lines = lines; }
  render(_width: number): string[] { return this.lines; }
}

/** Build a TuiMainScreen over a recording terminal. */
function makeRenderer() {
  const writes: string[] = [];
  const terminal: any = {
    columns: 80,
    rows: 24,
    write: (s: string) => writes.push(s),
    hideCursor() {}, showCursor() {}, setTitle() {}, setProgress() {},
    start() {}, stop() {}, clear() {},
  };
  const tui: any = new TuiMainScreen(terminal, false, "/tmp");
  return { tui, writes };
}

/**
 * Reproduce the streaming session: a short history, then the main assistant's
 * response (taller than the 24-row viewport) which streams while progress
 * entries arrive. `insertDuringStream` mimics pi splicing entries before the
 * streaming component; otherwise the ProgressLogBuffer defers them.
 */
function runSession(useBuffer: boolean): { fullRedraws: number; scrollClears: number } {
  const { tui, writes } = makeRenderer();
  const transcript = new Container();
  const streaming = new Block(Array.from({ length: 40 }, (_, k) => `stream-0-${k}`));
  tui.addChild(transcript);
  tui.addChild(streaming);
  for (let i = 0; i < 60; i++) transcript.addChild(new Line(`history ${i}`));
  tui.doRender();

  const buffer = new ProgressLogBuffer();
  const baseRedraws = tui.fullRedraws;
  let scrollClears = 0;

  if (useBuffer) buffer.setStreaming(true);
  for (let i = 0; i < 20; i++) {
    // The coordinator's response keeps streaming: one appended line per tick,
    // which only touches the tail of the component (inside the viewport).
    streaming.lines = [...streaming.lines, `stream-${i}`];

    const entry = `tmg log ${i}`;
    if (useBuffer) {
      const ready = buffer.push(entry);
      if (ready) tui.addChild(new Line(ready));
    } else {
      // pi's addCustomEntryToChat: splice before the streaming component.
      const idx = tui.children.indexOf(streaming);
      tui.children.splice(idx, 0, new Line(entry));
    }

    writes.length = 0;
    tui.doRender();
    if (writes.join("").includes("\x1b[3J")) scrollClears++;
  }

  if (useBuffer) {
    // message_end: the streaming component is now a finished child, so new
    // entries are appended at the END of the transcript.
    buffer.setStreaming(false);
    const drained = buffer.drain();
    if (drained) {
      writes.length = 0;
      for (const line of drained.split("\n")) tui.addChild(new Line(line));
      tui.doRender();
      if (writes.join("").includes("\x1b[3J")) scrollClears++;
    }
  }

  return { fullRedraws: tui.fullRedraws - baseRedraws, scrollClears };
}

console.log("ProgressLogBuffer defers while streaming and releases in order:");
{
  const b = new ProgressLogBuffer();
  check("not streaming: push returns the text immediately", b.push("a") === "a");
  check("empty text is ignored", b.push("") === null);
  b.setStreaming(true);
  check("streaming: push buffers and returns null", b.push("b") === null && b.push("c") === null);
  check("buffered entries are counted", b.size() === 2);
  check("drain joins buffered entries in order", b.drain() === "b\nc");
  check("drain clears the buffer", b.size() === 0 && b.drain() === null);
  b.setStreaming(false);
  check("after streaming ends: push is immediate again", b.push("d") === "d");
}

console.log("ProgressLogBuffer cap keeps memory bounded:");
{
  const b = new ProgressLogBuffer(3);
  b.setStreaming(true);
  for (let i = 0; i < 5; i++) b.push(`e${i}`);
  check("oldest entries are dropped past the cap", b.size() === 3, b.size());
  check("the newest entries survive", b.drain() === "e2\ne3\ne4");
  check("default cap is exported", MAX_DEFERRED_PROGRESS === 500, MAX_DEFERRED_PROGRESS);
}

console.log("Rendering regression (the reported symptom):");
{
  const buggy = runSession(false);
  check("splicing entries before a tall streaming component forces repeated full redraws",
    buggy.fullRedraws > 0 && buggy.scrollClears > 0, buggy);
  const fixed = runSession(true);
  check("with the buffer, entries append at the end: no scrollback-clearing redraw",
    fixed.fullRedraws === 0 && fixed.scrollClears === 0, fixed);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
