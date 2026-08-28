/**
 * Trimegisto - IPC Module
 *
 * File-based IPC for auto-spawning between sub-agents and the main extension.
 * Sub-agent processes write spawn requests as JSON files to a watched directory.
 * The main extension processes them and writes response files.
 *
 * Directory structure:
 *   ~/.pi/agent/trimegisto/
 *     requests/    <- spawn requests written by sub-agents
 *     responses/   <- spawn responses written by extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SpawnRequest, SpawnResponse } from "./types.ts";

/** Per-instance base directory for IPC. Set by the main extension at startup. */
let instanceDir: string | null = null;

/**
 * Set the per-instance IPC directory.
 * Must be called before any IPC operations.
 */
export function setInstanceDir(dir: string): void {
  instanceDir = dir;
}

function getIpcDir(): string {
  if (!instanceDir) {
    throw new Error("Trimegisto IPC: instanceDir not set. Call setInstanceDir() first.");
  }
  fs.mkdirSync(instanceDir, { recursive: true });
  return instanceDir;
}

function getRequestsDir(): string {
  const dir = path.join(getIpcDir(), "requests");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getResponsesDir(): string {
  const dir = path.join(getIpcDir(), "responses");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Generate a unique request ID */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write a spawn request (called from sub-agent process).
 * Returns the requestId for polling.
 */
export function writeSpawnRequest(tier: string, task: string, parentId: string, cwd: string): string {
  const requestId = generateId();
  const request: SpawnRequest = {
    requestId,
    tier: tier as SpawnRequest["tier"],
    task,
    parentId,
    cwd,
    timestamp: Date.now(),
  };

  const reqPath = path.join(getRequestsDir(), `${requestId}.json`);
  fs.writeFileSync(reqPath, JSON.stringify(request), { encoding: "utf-8", mode: 0o600 });
  return requestId;
}

/**
 * Poll for a spawn response asynchronously (called from sub-agent process).
 * Uses fs.promises + setTimeout polling instead of synchronous blocking.
 * Returns a SpawnResponse (never null — timeouts return an error response).
 */
export async function pollSpawnResponse(requestId: string, timeoutMs: number = 300_000): Promise<SpawnResponse> {
  const respPath = path.join(getResponsesDir(), `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const data = await fs.promises.readFile(respPath, "utf-8");
      const response = JSON.parse(data) as SpawnResponse;
      // Clean up
      try { await fs.promises.unlink(respPath); } catch { /* ignore */ }
      try {
        const reqPath = path.join(getRequestsDir(), `${requestId}.json`);
        await fs.promises.unlink(reqPath);
      } catch { /* ignore */ }
      return response;
    } catch {
      // File doesn't exist yet — wait 500ms asynchronously
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Timeout - clean up request file
  try {
    const reqPath = path.join(getRequestsDir(), `${requestId}.json`);
    await fs.promises.unlink(reqPath);
  } catch { /* ignore */ }

  return {
    requestId,
    result: {
      agentId: requestId,
      tier: "t3",
      task: "",
      status: "error",
      output: "",
      stderr: `Spawn request timed out after ${timeoutMs}ms`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      log: [],
    },
  };
}

/**
 * Write a spawn response (called from extension).
 */
export function writeSpawnResponse(response: SpawnResponse): void {
  const respPath = path.join(getResponsesDir(), `${response.requestId}.json`);
  fs.writeFileSync(respPath, JSON.stringify(response), { encoding: "utf-8", mode: 0o600 });
}

/**
 * Scan for pending spawn requests (called from extension).
 * Returns array of requests sorted by timestamp.
 */
export function scanSpawnRequests(): SpawnRequest[] {
  const requestsDir = getRequestsDir();
  const requests: SpawnRequest[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(requestsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) continue;

    try {
      const data = fs.readFileSync(path.join(requestsDir, entry.name), "utf-8");
      const request = JSON.parse(data) as SpawnRequest;
      // Verify it hasn't already been responded to
      const respPath = path.join(getResponsesDir(), `${request.requestId}.json`);
      if (!fs.existsSync(respPath)) {
        requests.push(request);
      }
    } catch {
      // Corrupt request file, clean it up
      try { fs.unlinkSync(path.join(requestsDir, entry.name)); } catch { /* ignore */ }
    }
  }

  return requests.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Clean up stale request/response files older than the given age.
 */
export function cleanupStaleFiles(maxAgeMs: number = 3600_000): void {
  const now = Date.now();
  const dirs = [getRequestsDir(), getResponsesDir()];

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      } catch { /* ignore */ }
    }
  }
}
