/**
 * Trimegisto - Provider Diagnostics
 *
 * OPT-IN capture of the real provider request payload and response status, so
 * a future `400 invalid_request_error` can be explained with the actual body
 * instead of a hypothesis.
 *
 * Design constraints:
 *   - `enabled=false` is a hard no-op: no string is built, no file is touched.
 *   - It must be impossible for a capture to leak a secret into logs.
 *   - A filesystem failure must never break the agent (all I/O is swallowed).
 *   - The pure helpers (`sanitizePayload`, `redactSecrets`,
 *     `diagnosticsEnabledFromEnv`) do no I/O and never throw.
 *
 * Run: node --experimental-strip-types test-diagnostics.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DiagnosticsOptions {
  enabled?: boolean;
  /** Where to append JSONL captures. Default: <TRIMEGISTO_INSTANCE_DIR or os.tmpdir()>/diagnostics/provider.jsonl */
  filePath?: string;
  /** Cap on the sanitized payload string. Default 20000. */
  maxChars?: number;
  /** Ring-buffer size. Default 50. */
  maxEntries?: number;
}

export interface CapturedExchange {
  ts: number;
  kind: "request" | "response";
  model?: string;
  status?: number;
  /** Sanitized, truncated JSON string. Never contains raw secrets. */
  body: string;
}

const DEFAULT_MAX_CHARS = 20000;
const DEFAULT_MAX_ENTRIES = 50;
const DEPTH_LIMIT = 6;
const REDACTED = "<redacted>";
const UNRESOLVABLE = "<unserializable>";

/** Keys whose VALUE is always replaced, whatever it contains. */
const SECRET_KEY_RE =
  /^(api[-_]?key|authorization|auth|token|access[-_]?token|refresh[-_]?token|secret|password|passwd|cookie|set[-_]?cookie|x-api-key|bearer)$/i;

/** Values that look like credentials: long, high-entropy, no prose. */
const SECRET_VALUE_RE =
  /^(sk-|pk-|ghp_|gho_|github_pat_|Bearer\s|[A-Za-z0-9_-]{32,})$/;

const WANTED_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "x-request-id",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Short, safe marker for exotic objects (Error, Date, Buffer, Map, ...). */
function markerFor(value: object): string {
  try {
    if (value instanceof Error) return `[Error: ${value.name}]`;
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? `[Date: ${value.toISOString()}]` : "[Date: invalid]";
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return `[Buffer ${value.length}]`;
    }
    if (value instanceof Map) return `[Map ${value.size}]`;
    if (value instanceof Set) return `[Set ${value.size}]`;
    if (value instanceof RegExp) return `[RegExp ${value.source}]`;
    return "[Unserializable]";
  } catch {
    return "[Unserializable]";
  }
}

/**
 * True for strings that really look like credentials.
 *
 * The generic rule is deliberately not "any long token": redacting a filler
 * string ("AAAAAAAA…"), a long identifier or a minified snippet would destroy the
 * payload we are capturing to diagnose a failure, and it also masked the
 * truncation marker. A generic token must therefore mix at least two character
 * classes, which is what real keys do.
 */
function looksLikeCredential(value: string): boolean {
  if (/^(sk-|pk-|ghp_|gho_|github_pat_|Bearer\s)/.test(value)) return true;
  if (!/^[A-Za-z0-9_-]{32,}$/.test(value)) return false;
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  if (/[_-]/.test(value)) classes++;
  return classes >= 2;
}

/** Redact a bare string value that looks like a credential, never prose/paths. */
function maybeRedactString(value: string): string {
  if (value.length >= 20 && looksLikeCredential(value)) return REDACTED;
  return value;
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  try {
    if (value === null) return null;
    const type = typeof value;
    if (type === "string") return maybeRedactString(value as string);
    if (type === "number" || type === "boolean" || type === "undefined") return value;
    if (type === "bigint") return value;
    if (type === "function") return "[Function]";
    if (type === "symbol") return "[Symbol]";

    const obj = value as object;
    if (depth > DEPTH_LIMIT) return "[MaxDepth]";
    if (seen.has(obj)) return "[Circular]";

    if (Array.isArray(obj)) {
      seen.add(obj);
      const out = obj.map((item) => redactInner(item, depth + 1, seen));
      seen.delete(obj);
      return out;
    }

    if (!isPlainObject(obj)) return markerFor(obj);

    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactInner((obj as Record<string, unknown>)[key], depth + 1, seen);
    }
    seen.delete(obj);
    return out;
  } catch {
    return "[Unserializable]";
  }
}

/**
 * Redact secret-looking values and truncate. Pure, deterministic, never throws.
 */
export function sanitizePayload(payload: unknown, maxChars?: number): string {
  let json: string;
  try {
    json = JSON.stringify(redactSecrets(payload));
  } catch {
    return UNRESOLVABLE;
  }
  if (typeof json !== "string") return UNRESOLVABLE;

  const limit =
    typeof maxChars === "number" && maxChars >= 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  if (json.length <= limit) return json;
  const removed = json.length - limit;
  return json.slice(0, limit) + `\n…[truncated ${removed} chars]`;
}

/**
 * Replace the value of secret-named keys with "<redacted>" and redact any
 * credential-looking string. Cycle-safe and depth-limited. Never throws.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  return redactInner(value, depth, new WeakSet<object>());
}

/**
 * Enabled unless TRIMEGISTO_CAPTURE_PAYLOADS is explicitly "0" / "false" / "off".
 */
export function diagnosticsEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env ? env.TRIMEGISTO_CAPTURE_PAYLOADS : undefined;
  if (raw === undefined || raw === null) return true;
  const value = String(raw).trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

function defaultFilePath(): string {
  const base = process.env.TRIMEGISTO_INSTANCE_DIR || os.tmpdir();
  return path.join(base, "diagnostics", "provider.jsonl");
}

export class ProviderDiagnostics {
  private readonly _enabled: boolean;
  private readonly filePath: string;
  private readonly maxChars: number;
  private readonly maxEntries: number;
  private readonly buffer: CapturedExchange[] = [];

  constructor(options: DiagnosticsOptions = {}) {
    this._enabled = options.enabled ?? false;
    this.filePath = options.filePath ?? defaultFilePath();
    this.maxChars =
      typeof options.maxChars === "number" && options.maxChars >= 0
        ? Math.floor(options.maxChars)
        : DEFAULT_MAX_CHARS;
    this.maxEntries =
      typeof options.maxEntries === "number" && options.maxEntries >= 1
        ? Math.floor(options.maxEntries)
        : DEFAULT_MAX_ENTRIES;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  recordRequest(payload: unknown, model?: string): void {
    if (!this._enabled) return;
    const exchange: CapturedExchange = {
      ts: Date.now(),
      kind: "request",
      body: sanitizePayload(payload, this.maxChars),
    };
    if (model !== undefined) exchange.model = model;
    this.push(exchange);
  }

  recordResponse(
    status: number,
    headers?: Record<string, string | undefined>,
    model?: string,
  ): void {
    if (!this._enabled) return;

    const subset: Record<string, string> = {};
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (WANTED_RESPONSE_HEADERS.has(lower) && value !== undefined) {
          subset[lower] = value;
        }
      }
    }

    const exchange: CapturedExchange = {
      ts: Date.now(),
      kind: "response",
      status,
      body: sanitizePayload({ headers: subset }, this.maxChars),
    };
    if (model !== undefined) exchange.model = model;
    this.push(exchange);
  }

  recent(n?: number): CapturedExchange[] {
    const count =
      typeof n === "number" && n >= 0 ? Math.floor(n) : this.buffer.length;
    if (count >= this.buffer.length) return this.buffer.slice();
    return this.buffer.slice(this.buffer.length - count);
  }

  summary(): string {
    const lines: string[] = [
      `Provider diagnostics: ${this._enabled ? "ON" : "OFF"} — ${this.filePath}`,
    ];
    if (!this._enabled) return lines.join("\n");
    if (this.buffer.length === 0) {
      lines.push("(no captures)");
      return lines.join("\n");
    }
    for (const entry of this.buffer) {
      const parts: string[] = [new Date(entry.ts).toISOString(), entry.kind];
      if (entry.model) parts.push(entry.model);
      if (entry.status !== undefined) parts.push(String(entry.status));
      const snippet = entry.body.length > 200 ? `${entry.body.slice(0, 200)}…` : entry.body;
      lines.push(`${parts.join(" ")} ${snippet}`);
    }
    return lines.join("\n");
  }

  clear(): void {
    this.buffer.length = 0;
  }

  private push(exchange: CapturedExchange): void {
    this.buffer.push(exchange);
    while (this.buffer.length > this.maxEntries) this.buffer.shift();
    this.appendLine(exchange);
  }

  /** Best-effort JSONL append. Any filesystem error is swallowed on purpose. */
  private appendLine(exchange: CapturedExchange): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(exchange)}\n`, "utf-8");
    } catch {
      // Diagnostics must never break the agent.
    }
  }
}
