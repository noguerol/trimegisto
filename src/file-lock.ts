/**
 * Trimegisto - File Lock System
 *
 * Advisory file-locking mechanism to prevent concurrent edits from
 * multiple Trimegisto agents. Agents acquire locks before using
 * write/edit tools and release them when done.
 *
 * Locks are stored as JSON files in:
 *   ~/.pi/agent/trimegisto/locks/
 *
 * Key design decisions:
 * - Advisory only (does NOT enforce at OS level)
 * - Lock timeout (stale locks auto-expire after 60s)
 * - Lock conflict returns {locked: true, owner, filePath} so agents can wait/retry
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Maximum age of a lock before it's considered stale (60 seconds) */
const LOCK_TIMEOUT_MS = 60_000;

/** Per-instance base directory for locks. Set by the main extension at startup. */
let instanceDir: string | null = null;

/**
 * Set the per-instance lock directory.
 * Must be called before any lock operations.
 */
export function setInstanceDir(dir: string): void {
  instanceDir = dir;
}

export interface LockInfo {
  lockId: string;
  agentId: string;
  filePath: string;
  operation: "write" | "edit" | "bash";
  timestamp: number;
  cwd: string;
}

export interface LockResult {
  acquired: boolean;
  lockId?: string;
  /** If acquisition failed, who holds the lock */
  conflict?: {
    agentId: string;
    filePath: string;
    operation: string;
    lockedAt: number;
  };
}

function getLocksDir(): string {
  if (!instanceDir) {
    throw new Error("Trimegisto file-lock: instanceDir not set. Call setInstanceDir() first.");
  }
  const dir = path.join(instanceDir, "locks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function lockFilePath(lockId: string): string {
  return path.join(getLocksDir(), `${lockId}.json`);
}

/** Generate a unique lock ID */
function generateLockId(): string {
  return `lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Resolve a file path to an absolute path */
function resolvePath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath);
}

/**
 * Acquire a lock on a file. Returns {acquired: true, lockId} on success,
 * or {acquired: false, conflict} if another agent holds the lock.
 */
export function acquireLock(
  agentId: string,
  filePath: string,
  operation: LockInfo["operation"],
  cwd: string,
): LockResult {
  const absPath = resolvePath(filePath, cwd);
  const locksDir = getLocksDir();

  // Clean stale locks first
  cleanupStaleLocks();

  // Check if any active lock exists for this file
  const existing = findLockForFile(absPath);
  if (existing) {
    // If same agent already holds a lock on this file, allow (re-lock)
    if (existing.agentId === agentId) {
      return { acquired: true, lockId: existing.lockId };
    }
    return {
      acquired: false,
      conflict: {
        agentId: existing.agentId,
        filePath: existing.filePath,
        operation: existing.operation,
        lockedAt: existing.timestamp,
      },
    };
  }

  const lockId = generateLockId();
  const lock: LockInfo = {
    lockId,
    agentId,
    filePath: absPath,
    operation,
    timestamp: Date.now(),
    cwd,
  };

  try {
    // Atomic write: write to temp file then rename
    const tmpPath = lockFilePath(lockId) + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(lock, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmpPath, lockFilePath(lockId));
    return { acquired: true, lockId };
  } catch (err) {
    // Clean up temp file
    try { fs.unlinkSync(lockFilePath(lockId) + ".tmp"); } catch { /* ignore */ }
    return {
      acquired: false,
      conflict: {
        agentId: "system",
        filePath: absPath,
        operation: "error",
        lockedAt: Date.now(),
      },
    };
  }
}

/**
 * Release a specific lock by its ID.
 */
export function releaseLock(lockId: string): boolean {
  const fPath = lockFilePath(lockId);
  try {
    if (fs.existsSync(fPath)) {
      fs.unlinkSync(fPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Release all locks held by a specific agent.
 * Called when an agent completes, is killed, or halted.
 */
export function releaseAllAgentLocks(agentId: string): number {
  const locksDir = getLocksDir();
  let released = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(locksDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.endsWith(".tmp")) continue;
    try {
      const data = fs.readFileSync(path.join(locksDir, entry.name), "utf-8");
      const lock = JSON.parse(data) as LockInfo;
      if (lock.agentId === agentId) {
        fs.unlinkSync(path.join(locksDir, entry.name));
        released++;
      }
    } catch {
      // Corrupt lock file, clean it up
      try { fs.unlinkSync(path.join(locksDir, entry.name)); } catch { /* ignore */ }
    }
  }

  return released;
}

/**
 * Find an active lock for a given file path.
 * Returns null if no lock exists.
 */
export function findLockForFile(filePath: string): LockInfo | null {
  const absPath = resolvePath(filePath, process.cwd());
  const locksDir = getLocksDir();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(locksDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.endsWith(".tmp")) continue;
    try {
      const data = fs.readFileSync(path.join(locksDir, entry.name), "utf-8");
      const lock = JSON.parse(data) as LockInfo;
      if (lock.filePath === absPath || lock.filePath === path.resolve(filePath)) {
        // Check if lock is stale
        if (Date.now() - lock.timestamp > LOCK_TIMEOUT_MS) {
          try { fs.unlinkSync(path.join(locksDir, entry.name)); } catch { /* ignore */ }
          continue;
        }
        return lock;
      }
    } catch {
      // Corrupt
      try { fs.unlinkSync(path.join(locksDir, entry.name)); } catch { /* ignore */ }
    }
  }

  return null;
}

/**
 * Get all active locks.
 */
export function getActiveLocks(): LockInfo[] {
  const locksDir = getLocksDir();
  const locks: LockInfo[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(locksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  cleanupStaleLocks();

  // Re-read after cleanup
  try {
    entries = fs.readdirSync(locksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.endsWith(".tmp")) continue;
    try {
      const data = fs.readFileSync(path.join(locksDir, entry.name), "utf-8");
      const lock = JSON.parse(data) as LockInfo;
      locks.push(lock);
    } catch {
      try { fs.unlinkSync(path.join(locksDir, entry.name)); } catch { /* ignore */ }
    }
  }

  return locks.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Get all locks held by a specific agent.
 */
export function getAgentLocks(agentId: string): LockInfo[] {
  return getActiveLocks().filter(l => l.agentId === agentId);
}

/**
 * Check if any agent holds a lock on a file (and it's not the requesting agent).
 * Returns true if the file is free (no lock or lock held by the same agent).
 */
export function canEditFile(filePath: string, agentId: string): { canEdit: boolean; lock?: LockInfo } {
  const existing = findLockForFile(filePath);
  if (!existing) return { canEdit: true };
  if (existing.agentId === agentId) return { canEdit: true };
  return { canEdit: false, lock: existing };
}

/**
 * Clean up stale locks (older than LOCK_TIMEOUT_MS).
 */
function cleanupStaleLocks(): number {
  const locksDir = getLocksDir();
  let cleaned = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(locksDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.name.endsWith(".json") || entry.name.endsWith(".tmp")) continue;
    try {
      const fPath = path.join(locksDir, entry.name);
      const stat = fs.statSync(fPath);
      if (now - stat.mtimeMs > LOCK_TIMEOUT_MS) {
        fs.unlinkSync(fPath);
        cleaned++;
      }
    } catch {
      try { fs.unlinkSync(path.join(locksDir, entry.name)); } catch { /* ignore */ }
    }
  }

  return cleaned;
}
