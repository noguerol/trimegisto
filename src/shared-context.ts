/**
 * Trimegisto - Shared Context
 *
 * Builds a compact preamble of what OTHER agents already explored, so a newly
 * spawned agent can avoid redundant re-reading and re-derivation.
 *
 * Data sources (all under the per-instance IPC dir):
 *   - notifications/.readreg-<agentId>.json   files each agent read (via file_read_track)
 *   - notes/*.json                            facts published via trimegisto_note
 *
 * The preamble is injected into the system prompt of each new agent before
 * launch. It is intentionally small (capped chars) to stay cheap.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface PublishedNote {
  noteId: string;
  agentId: string;
  text: string;
  ts: number;
}

const MAX_FILES_LISTED = 40;
const MAX_NOTES = 12;
const MAX_TOTAL_CHARS = 2400;

function readRegFiles(instanceDir: string, excludeAgentId: string): Set<string> {
  const files = new Set<string>();
  const dir = path.join(instanceDir, "notifications");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }

  for (const entry of entries) {
    if (!entry.name.startsWith(".readreg-") || !entry.name.endsWith(".json")) continue;
    const agentId = entry.name.slice(".readreg-".length, -".json".length);
    if (agentId === excludeAgentId) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf-8")) as string[];
      for (const f of data) files.add(f);
    } catch { /* ignore corrupt */ }
  }
  return files;
}

function readNotes(instanceDir: string, excludeAgentId: string): PublishedNote[] {
  const notes: PublishedNote[] = [];
  const dir = path.join(instanceDir, "notes");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return notes; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const n = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf-8")) as PublishedNote;
      if (n.agentId === excludeAgentId) continue;
      if (typeof n.text === "string" && n.text.trim()) notes.push(n);
    } catch { /* ignore corrupt */ }
  }

  return notes.sort((a, b) => a.ts - b.ts).slice(-MAX_NOTES);
}

/**
 * Build the shared-context preamble for a new agent, or "" when there is
 * nothing worth sharing.
 */
export function buildSharedContextPreamble(instanceDir: string, agentId: string): string {
  let body = "";

  const readFiles = [...readRegFiles(instanceDir, agentId)];
  if (readFiles.length > 0) {
    const shown = readFiles.slice(0, MAX_FILES_LISTED);
    const extra = readFiles.length - shown.length;
    body += `### Files already read by other agents (avoid re-reading them cold)\n`;
    body += shown.map(f => `- \`${f}\``).join("\n");
    if (extra > 0) body += `\n- _(+${extra} more)_`;
    body += "\n\n";
  }

  const notes = readNotes(instanceDir, agentId);
  if (notes.length > 0) {
    body += `### Facts already established by other agents\n`;
    for (const n of notes) {
      body += `- [${n.agentId}] ${n.text.trim()}\n`;
    }
    body += "\n";
  }

  body = body.trim();
  if (!body) return "";
  if (body.length > MAX_TOTAL_CHARS) {
    body = body.slice(0, MAX_TOTAL_CHARS) + "\n…(shared context truncated)";
  }

  return `## 🔎 Shared context from other agents\n\n${body}`;
}

/**
 * Publish a fact/note from an agent. Called by the trimegisto_note tool in
 * the sub-agent extension (writes a file the main process can read when
 * building the next agent's preamble).
 */
export function publishNote(instanceDir: string, agentId: string, text: string): { ok: boolean; noteId?: string; error?: string } {
  const clean = (text || "").trim();
  if (!clean) return { ok: false, error: "empty note" };
  if (clean.length > 2000) return { ok: false, error: "note too long (max 2000 chars)" };

  const dir = path.join(instanceDir, "notes");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const noteId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const note: PublishedNote = { noteId, agentId, text: clean, ts: Date.now() };
    fs.writeFileSync(path.join(dir, `${noteId}.json`), JSON.stringify(note), { encoding: "utf-8", mode: 0o600 });
    return { ok: true, noteId };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
