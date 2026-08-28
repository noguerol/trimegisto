/**
 * Trimegisto - Context Broker
 *
 * Watches for file modifications by Trimegisto agents and broadcasts
 * context-invalidation notifications to other active agents.
 *
 * When Agent A modifies a file, the Context Broker:
 * 1. Records the modification event
 * 2. Writes a notification to ~/.pi/agent/trimegisto/notifications/
 * 3. Sub-agent extensions poll for notifications relevant to files they've read
 * 4. On context invalidation, agents receive a system message alerting them
 *
 * Architecture:
 *   Agent A writes file  ──→  Context Broker detects change
 *                                    │
 *                           ┌────────▼────────┐
 *                           │  notifications/  │
 *                           │  {agentId}.json  │
 *                           └────────┬────────┘
 *                                    │
 *   Agent B polls ──→ finds notification ──→ gets context alert
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Per-instance base directory for context notifications. Set by the main extension at startup. */
let instanceDir: string | null = null;

/**
 * Set the per-instance context broker directory.
 * Must be called before any context broker operations.
 */
export function setInstanceDir(dir: string): void {
  instanceDir = dir;
}

export interface FileChangeNotification {
  notificationId: string;
  filePath: string;
  modifiedBy: string;       // agent ID that made the change
  operation: "write" | "edit" | "bash";
  timestamp: number;
  /** Brief description of what changed */
  summary: string;
}

export interface ContextAlert {
  alertId: string;
  filePath: string;
  modifiedBy: string;
  timestamp: number;
  message: string;
}

function getNotificationsDir(): string {
  if (!instanceDir) {
    throw new Error("Trimegisto context-broker: instanceDir not set. Call setInstanceDir() first.");
  }
  const dir = path.join(instanceDir, "notifications");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateId(): string {
  return `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Broadcast a file change notification to all agents.
 * Called by the main extension when an agent modifies a file.
 */
export function broadcastFileChange(
  filePath: string,
  modifiedBy: string,
  operation: FileChangeNotification["operation"],
  summary: string = "",
): FileChangeNotification {
  const notification: FileChangeNotification = {
    notificationId: generateId(),
    filePath: path.resolve(filePath),
    modifiedBy,
    operation,
    timestamp: Date.now(),
    summary: summary || `${modifiedBy} ${operation}d ${path.basename(filePath)}`,
  };

  const dir = getNotificationsDir();
  // Write a notification file that all agents can discover
  const file = path.join(dir, `${notification.notificationId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(notification, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch { /* ignore write errors */ }

  return notification;
}

/**
 * Poll for new context notifications relevant to a set of files.
 * Called by sub-agent extensions periodically.
 *
 * @param agentId - The calling agent's ID
 * @param watchedFiles - Set of file paths this agent cares about
 * @returns Array of new alerts for this agent
 */
export function pollContextAlerts(
  agentId: string,
  watchedFiles: Set<string>,
): ContextAlert[] {
  const alerts: ContextAlert[] = [];
  const dir = getNotificationsDir();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const watchedAbs = new Set(
    Array.from(watchedFiles).map(f => path.resolve(f)),
  );

  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;

    const filePath = path.join(dir, entry.name);
    try {
      const data = fs.readFileSync(filePath, "utf-8");
      const notification = JSON.parse(data) as FileChangeNotification;

      // Skip notifications from self
      if (notification.modifiedBy === agentId) continue;

      // Skip notifications for files we don't care about
      if (!watchedAbs.has(notification.filePath)) continue;

      // Skip if this notification was already processed by this agent
      const processedFile = path.join(dir, `.processed-${agentId}`);
      const processed: string[] = loadProcessedIds(processedFile);
      if (processed.includes(notification.notificationId)) continue;

      // Create alert
      alerts.push({
        alertId: notification.notificationId,
        filePath: notification.filePath,
        modifiedBy: notification.modifiedBy,
        timestamp: notification.timestamp,
        message: `⚠️ **Context Invalidation**: \`${path.basename(notification.filePath)}\` was modified by agent \`${notification.modifiedBy}\` (${notification.operation}). Your knowledge of this file may be stale — re-read it before making further changes.`,
      });

      // Mark as processed
      processed.push(notification.notificationId);
      saveProcessedIds(processedFile, processed);
    } catch {
      // Corrupt notification, clean up
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  return alerts;
}

/**
 * Register which files an agent has read (for context tracking).
 * Called by sub-agent extensions when an agent uses the `read` tool.
 */
export function trackFileRead(
  agentId: string,
  filePath: string,
): void {
  const dir = getNotificationsDir();
  const registryFile = path.join(dir, `.readreg-${agentId}.json`);

  let files: string[] = [];
  try {
    if (fs.existsSync(registryFile)) {
      files = JSON.parse(fs.readFileSync(registryFile, "utf-8"));
    }
  } catch { /* ignore */ }

  const absPath = path.resolve(filePath);
  if (!files.includes(absPath)) {
    files.push(absPath);
    // Keep only last 50 files to avoid bloat
    if (files.length > 50) files = files.slice(-50);
    try {
      fs.writeFileSync(registryFile, JSON.stringify(files), { encoding: "utf-8", mode: 0o600 });
    } catch { /* ignore */ }
  }
}

/**
 * Get the set of files an agent has read.
 */
export function getReadFiles(agentId: string): Set<string> {
  const registryFile = path.join(getNotificationsDir(), `.readreg-${agentId}.json`);
  try {
    if (fs.existsSync(registryFile)) {
      const files = JSON.parse(fs.readFileSync(registryFile, "utf-8")) as string[];
      return new Set(files);
    }
  } catch { /* ignore */ }
  return new Set();
}

/**
 * Clear read registry and processed notifications for an agent.
 * Called when an agent finishes.
 */
export function clearAgentContext(agentId: string): void {
  const dir = getNotificationsDir();
  const registryFile = path.join(dir, `.readreg-${agentId}.json`);
  const processedFile = path.join(dir, `.processed-${agentId}.json`);
  try { fs.unlinkSync(registryFile); } catch { /* ignore */ }
  try { fs.unlinkSync(processedFile); } catch { /* ignore */ }
}

/**
 * Clean up notifications older than maxAgeMs.
 */
export function cleanupOldNotifications(maxAgeMs: number = 300_000): number {
  const dir = getNotificationsDir();
  let cleaned = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    try {
      const fPath = path.join(dir, entry.name);
      const stat = fs.statSync(fPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fPath);
        cleaned++;
      }
    } catch { /* ignore */ }
  }

  return cleaned;
}

// ── Helpers ───────────────────────────────────────────────

function loadProcessedIds(filePath: string): string[] {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as string[];
    }
  } catch { /* ignore */ }
  return [];
}

function saveProcessedIds(filePath: string, ids: string[]): void {
  // Keep only last 100 entries
  if (ids.length > 100) ids = ids.slice(-100);
  try {
    fs.writeFileSync(filePath, JSON.stringify(ids), { encoding: "utf-8", mode: 0o600 });
  } catch { /* ignore */ }
}
