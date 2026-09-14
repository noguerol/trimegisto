/**
 * Trimegisto - LLM context pruning (pure logic)
 *
 * Sub-agent progress used to be injected with `pi.sendMessage`, which makes it
 * part of the main model's conversation. A long run therefore accumulated an
 * unbounded pile of user-role custom messages, and providers that validate
 * message order/size answer `400 invalid_request_error` — the failure this
 * pruning exists to prevent.
 *
 * Two rules, both proven by `test-context-prune.ts`:
 *   1. The orchestration directive (`trimegisto-context`) is re-injected every
 *      turn and fully supersedes its previous copies → keep only the newest.
 *   2. Progress notes (`trimegisto-log` / `trimegisto-harvest`) are ephemeral →
 *      keep only the newest `maxProgress`.
 *   3. Empty custom messages are dropped: an empty text block is rejected by
 *      several providers.
 *
 * Non-custom messages (user / assistant / toolResult) are NEVER touched, so
 * tool_use <-> tool_result pairing cannot be broken. Pure: no I/O, no clock,
 * never mutates the input array or its entries.
 */

/** Default number of progress messages kept in the model's context. */
export const MAX_PROGRESS_MESSAGES = 8;

/** Custom types whose history is superseded by the newest copy. */
export const SINGLETON_CUSTOM_TYPES = ["trimegisto-context"] as const;

/** Custom types that are pure progress and can be capped. */
export const PROGRESS_CUSTOM_TYPES = ["trimegisto-log", "trimegisto-harvest"] as const;

const PROGRESS = new Set<string>(PROGRESS_CUSTOM_TYPES);
const SINGLETON = new Set<string>(SINGLETON_CUSTOM_TYPES);

export interface PrunableMessage {
  role?: string;
  customType?: string;
  content?: unknown;
}

/** Plain text of a message content (string or text parts). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text as string)
      .join("\n");
  }
  return "";
}

/**
 * Return the messages that should be sent to the model.
 *
 * Order is preserved. Returns a NEW array; returns the input array itself only
 * when nothing would change, so callers can cheaply detect a no-op.
 */
export function pruneContextMessages<T extends PrunableMessage>(
  messages: T[],
  maxProgress: number = MAX_PROGRESS_MESSAGES,
): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages ?? [];

  const cap = Number.isFinite(maxProgress) ? Math.max(0, Math.floor(maxProgress)) : MAX_PROGRESS_MESSAGES;

  // Walk backwards so the most recent entries win.
  const drop = new Set<number>();
  let keptProgress = 0;
  let keptSingleton = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as PrunableMessage | undefined;
    if (!m || m.role !== "custom") continue;

    const ct = String(m.customType ?? "");
    if (PROGRESS.has(ct)) {
      if (keptProgress >= cap) { drop.add(i); continue; }
      keptProgress++;
    } else if (SINGLETON.has(ct)) {
      if (keptSingleton >= 1) { drop.add(i); continue; }
      keptSingleton++;
    }

    // Empty custom messages are invalid for several providers regardless of type.
    if (!messageText(m.content).trim()) drop.add(i);
  }

  if (drop.size === 0) return messages;

  const out: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!drop.has(i)) out.push(messages[i]!);
  }
  return out;
}
