/**
 * Trimegisto - progress-log deferral
 *
 * Sub-agent progress is streamed into the transcript as `trimegisto-log`
 * custom entries. pi renders a new custom entry *before* the assistant
 * component that is currently streaming (`addCustomEntryToChat` splices at the
 * streaming index so live text stays at the bottom).
 *
 * `TuiMainScreen` can only repaint differentially when every changed line sits
 * inside the visible viewport. Splicing a line into the middle of a streaming
 * assistant message taller than the viewport moves the message's first line
 * above the viewport, and the renderer answers with `fullRender(true)` — a
 * `\x1b[2J\x1b[H\x1b[3J` that clears the screen AND the scrollback and
 * reprints the whole transcript. With several agents streaming logs, that
 * happens many times per second and the whole TUI visibly re-scrolls on every
 * update.
 *
 * The fix is to hold progress entries while the main session is streaming and
 * release them as one entry once it stops: an append at the END of the
 * transcript never invalidates a line above the viewport, so pi only touches
 * the new lines. This class is the pure state machine for that; index.ts wires
 * it to the pi message events. Keeping it separate makes the semantics
 * unit-testable without a terminal.
 */

/** Cap on buffered entries so a stuck stream cannot grow memory without bound. */
export const MAX_DEFERRED_PROGRESS = 500;

export class ProgressLogBuffer {
  private deferred: string[] = [];
  private streaming = false;
  private readonly maxDeferred: number;

  constructor(maxDeferred: number = MAX_DEFERRED_PROGRESS) {
    this.maxDeferred = maxDeferred;
  }

  /** Whether the main session currently has a streaming assistant component. */
  isStreaming(): boolean {
    return this.streaming;
  }

  /**
   * Track the main session's streaming state. Called with `true` on an
   * assistant `message_start` and `false` on `message_end` / `agent_settled`.
   */
  setStreaming(streaming: boolean): void {
    this.streaming = streaming;
  }

  /**
   * Offer one progress entry. While streaming it is buffered and `null` is
   * returned (nothing may be appended above the streaming component). Otherwise
   * the caller should append the returned text immediately.
   */
  push(text: string): string | null {
    if (!text) return null;
    if (!this.streaming) return text;
    this.deferred.push(text);
    if (this.deferred.length > this.maxDeferred) this.deferred.shift();
    return null;
  }

  /**
   * Everything buffered while streaming, joined into a single entry, or
   * `null` when nothing was buffered. Clears the buffer.
   */
  drain(): string | null {
    if (this.deferred.length === 0) return null;
    const text = this.deferred.join("\n");
    this.deferred = [];
    return text;
  }

  /** Number of buffered entries (diagnostics/tests). */
  size(): number {
    return this.deferred.length;
  }
}
