/**
 * Trimegisto - provider diagnostics tests
 *
 * Run: node --experimental-strip-types test-diagnostics.ts
 *
 * Covers the hard no-op when disabled, JSONL capture, the ring buffer,
 * secret redaction (keys + credential-looking values), cycle/depth safety,
 * unserializable/truncation markers, response-header subsetting, summary,
 * env parsing and temp-file cleanup. No test writes inside the repo.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProviderDiagnostics,
  sanitizePayload,
  redactSecrets,
  diagnosticsEnabledFromEnv,
} from "./src/diagnostics.ts";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else {
    failed++;
    let shown: string;
    try { shown = JSON.stringify(detail); } catch { shown = String(detail); }
    console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${shown}` : ""}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tmg-diag-"));
const tmpFile = (name: string): string => path.join(tmpRoot, name);
const readLines = (p: string): string[] =>
  fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.length > 0);

let cleanupOk = false;
try {
  // ── disabled is a hard no-op ──────────────────────────────
  console.log("Disabled:");
  {
    const p = path.join(tmpRoot, "non-existent-dir", "x.jsonl");
    const d = new ProviderDiagnostics({ enabled: false, filePath: p });
    let threw = false;
    try {
      d.recordRequest({ api_key: "sk-" + "a".repeat(40) }, "m");
      d.recordResponse(400, { authorization: "Bearer zzzzzzzzzzzzzzzzzzzz" }, "m");
    } catch { threw = true; }
    check("no throw even with unwritable-looking path", !threw);
    check("enabled getter is false", d.enabled === false);
    check("no file created", !fs.existsSync(p));
    check("no parent dir created", !fs.existsSync(path.dirname(p)));
    check("recent() stays empty", d.recent(10).length === 0);
    check("summary states OFF", d.summary().includes("OFF"));
    check("summary shows path", d.summary().includes(p));
  }

  // ── enabled writes a JSONL line ───────────────────────────
  console.log("Enabled capture:");
  {
    const p = tmpFile("basic.jsonl");
    const d = new ProviderDiagnostics({ enabled: true, filePath: p });
    d.recordRequest({ model: "gpt-x", input: "hello" }, "gpt-x");
    check("file exists", fs.existsSync(p));
    const lines = readLines(p);
    check("one JSONL line written", lines.length === 1, lines.length);
    let parsed: any = null;
    try { parsed = JSON.parse(lines[0]); } catch { parsed = null; }
    check("line is valid JSON", parsed !== null && typeof parsed === "object");
    check("kind is request", parsed?.kind === "request");
    check("model captured", parsed?.model === "gpt-x");
    check("ts is a number", typeof parsed?.ts === "number");
  }

  // ── ring buffer caps and drops oldest ─────────────────────
  console.log("Ring buffer:");
  {
    const p = tmpFile("ring.jsonl");
    const d = new ProviderDiagnostics({ enabled: true, filePath: p, maxEntries: 3 });
    for (let i = 0; i < 5; i++) d.recordRequest({ i }, `m${i}`);
    const models = d.recent(10).map((e) => e.model);
    check("capped at maxEntries", models.length === 3, models);
    check("oldest two dropped", models.join(",") === "m2,m3,m4", models);
    check("recent(1) returns last only", d.recent(1).length === 1 && d.recent(1)[0].model === "m4");
    check("recent(0) is empty", d.recent(0).length === 0);
    check("file still appends every entry", readLines(p).length === 5, readLines(p).length);
  }

  // ── secret-key redaction ──────────────────────────────────
  console.log("Redaction (keys):");
  {
    const out: any = redactSecrets({
      api_key: "supersecret",
      Authorization: "Bearer abc",
      token: "xyz",
      "Api-Key": "kk",
      cookie: "c",
      set_cookie: "sc",
      secret: "s",
      passwd: "pw",
      auth: "au",
      bearer: "b",
      "x-api-key": "x2",
      access_token: "at",
      refresh_token: "rt",
      nested: { password: "p", token: "t" },
    });
    const keys = ["api_key", "Authorization", "token", "Api-Key", "cookie", "set_cookie",
      "secret", "passwd", "auth", "bearer", "x-api-key", "access_token", "refresh_token"];
    const leaked = keys.filter((k) => out[k] !== "<redacted>");
    check("all secret-named keys redacted", leaked.length === 0, leaked);
    check("nested password redacted", out.nested.password === "<redacted>", out.nested);
    check("nested token redacted", out.nested.token === "<redacted>", out.nested);
  }

  // ── non-secret values preserved ───────────────────────────
  console.log("Redaction (preservation):");
  {
    const keep: any = redactSecrets({
      n: 42, b: true, z: null, arr: [1, "two", false], obj: { a: 1 },
    });
    check("number preserved", keep.n === 42);
    check("boolean preserved", keep.b === true);
    check("null preserved", keep.z === null);
    check("array preserved", Array.isArray(keep.arr) && keep.arr.length === 3 && keep.arr[0] === 1);
    check("nested object preserved", keep.obj.a === 1);
  }

  // ── credential-looking values vs prose/paths ──────────────
  console.log("Redaction (values):");
  {
    const sk = "sk-" + "a".repeat(40);
    const ghp = "ghp_" + "b".repeat(40);
    // A real digest mixes character classes. Forty identical characters is the
    // textbook LOW-entropy filler, and redacting it would blank out the payload a
    // failure diagnosis depends on (and masked the truncation marker upstream).
    const hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
    const filler = "c".repeat(40);
    const prose = "This is just a long natural language sentence.";
    const filePath = "/home/user/projects/very-long-directory-name/src/file.ts";
    const bearer = "Bearer " + "d".repeat(40);
    const r: any = redactSecrets({ sk, ghp, hex, filler, prose, filePath, bearer });
    check("sk- value redacted", r.sk === "<redacted>", r.sk);
    check("ghp_ value redacted", r.ghp === "<redacted>", r.ghp);
    check("long high-entropy value redacted", r.hex === "<redacted>", r.hex);
    check("repeated-character filler is NOT redacted (low entropy)", r.filler === filler, r.filler);
    check("Bearer value redacted", r.bearer === "<redacted>", r.bearer);
    check("prose sentence NOT redacted", prose.length >= 20 && r.prose === prose, r.prose);
    check("long file path NOT redacted", r.filePath === filePath, r.filePath);
  }

  // ── non-plain objects become markers ──────────────────────
  console.log("Redaction (exotic objects):");
  {
    const r: any = redactSecrets({
      err: new Error("boom"),
      when: new Date(0),
      buf: Buffer.from("x"),
      map: new Map([["a", 1]]),
      set: new Set([1, 2]),
    });
    check("Error becomes marker", typeof r.err === "string" && r.err.startsWith("[Error"), r.err);
    check("Date becomes marker", typeof r.when === "string" && r.when.startsWith("[Date"), r.when);
    check("Buffer becomes marker", typeof r.buf === "string" && r.buf.startsWith("[Buffer"), r.buf);
    check("Map becomes marker", typeof r.map === "string" && r.map.startsWith("[Map"), r.map);
    check("Set becomes marker", typeof r.set === "string" && r.set.startsWith("[Set"), r.set);
  }

  // ── circular + unserializable + truncation ────────────────
  console.log("Sanitizer:");
  {
    const o: any = { a: 1 };
    o.self = o;
    let circular = "";
    let threw = false;
    try { circular = sanitizePayload(o); } catch { threw = true; }
    check("circular payload does not throw", !threw);
    check("circular payload returns a string", typeof circular === "string");
    check("circular payload is not the marker", circular !== "<unserializable>", circular);
    check("circular payload marks the cycle", circular.includes("[Circular]"), circular);

    let big = "";
    let bigThrew = false;
    try { big = sanitizePayload({ big: BigInt(10) }); } catch { bigThrew = true; }
    check("BigInt payload does not throw", !bigThrew);
    check("unserializable payload returns marker", big === "<unserializable>", big);

    const trunc = sanitizePayload({ x: "lorem ipsum dolor sit amet ".repeat(10) }, 20);
    check("truncation appends marker", trunc.includes("[truncated"), trunc);
    check("truncation reports removed count", /\[truncated \d+ chars\]/.test(trunc), trunc);
    check("truncated prefix <= maxChars",
      trunc.slice(0, trunc.indexOf("\n…[truncated")).length <= 20, trunc.length);

    const short = sanitizePayload({ a: 1 });
    check("short payload not truncated", !short.includes("[truncated"), short);
    check("short payload equals JSON", short === JSON.stringify({ a: 1 }), short);
    const exact = JSON.stringify({ a: "b" });
    check("exact maxChars not truncated", sanitizePayload({ a: "b" }, exact.length) === exact);

    check("deterministic output", sanitizePayload(o) === circular);
    const input = { a: [1, 2, { token: "x" }], b: "ok" };
    const before = JSON.stringify(input);
    sanitizePayload(input);
    check("input not mutated", JSON.stringify(input) === before, input);
  }

  // ── depth limit stops recursion ───────────────────────────
  console.log("Depth limit:");
  {
    let deep: any = "leaf";
    for (let i = 0; i < 12; i++) deep = { level: i, child: deep };
    let out: any;
    let threw = false;
    try { out = redactSecrets(deep); } catch { threw = true; }
    check("deep object does not throw", !threw);
    check("deep object returns an object", out !== null && typeof out === "object");
    check("deep object hits MaxDepth marker", JSON.stringify(out).includes("[MaxDepth]"));
    const shallow: any = redactSecrets({ token: "shallow-secret" });
    check("within-depth secret still redacted", shallow.token === "<redacted>", shallow);
  }

  // ── response records status + redacted header subset ──────
  console.log("Response capture:");
  {
    const p = tmpFile("resp.jsonl");
    const d = new ProviderDiagnostics({ enabled: true, filePath: p });
    d.recordResponse(400, {
      "Content-Type": "application/json",
      "Authorization": "Bearer sekretsekretsekretsekret",
      "Retry-After": "30",
      "X-Request-Id": "req-123",
      "X-Custom": "should-not-appear",
    }, "gpt-x");
    const r = d.recent(1)[0];
    check("kind is response", r.kind === "response");
    check("status recorded", r.status === 400);
    check("model recorded", r.model === "gpt-x");
    check("content-type kept", r.body.includes("content-type") && r.body.includes("application/json"), r.body);
    check("retry-after kept", r.body.includes("retry-after") && r.body.includes("30"), r.body);
    check("x-request-id kept", r.body.includes("x-request-id") && r.body.includes("req-123"), r.body);
    check("authorization dropped",
      !r.body.toLowerCase().includes("authorization") && !r.body.includes("sekret"), r.body);
    check("unknown header dropped", !r.body.toLowerCase().includes("x-custom"), r.body);
  }

  // ── sanitized output never leaks a raw secret ─────────────
  console.log("Leak check:");
  {
    const secret = "sk-" + "z".repeat(48);
    const s = sanitizePayload({
      headers: { authorization: `Bearer ${secret}` },
      body: { api_key: secret },
    });
    check("no raw secret in output", !s.includes(secret), s);
    check("redaction marker present", s.includes("<redacted>"), s);
  }

  // ── summary() ─────────────────────────────────────────────
  console.log("Summary:");
  {
    const p = tmpFile("summary.jsonl");
    const d = new ProviderDiagnostics({ enabled: true, filePath: p });
    d.recordRequest({ q: 1 }, "model-a");
    d.recordResponse(429, { "content-type": "application/json" }, "model-a");
    const s = d.summary();
    check("summary states ON", s.includes("ON"));
    check("summary shows file path", s.includes(p));
    check("summary shows model", s.includes("model-a"));
    check("summary shows status", s.includes("429"));
    check("summary shows request kind", s.includes("request"));
    check("summary shows response kind", s.includes("response"));
    check("summary is multi-line", s.split("\n").length >= 3, s);
  }

  // ── clear() ───────────────────────────────────────────────
  console.log("Clear:");
  {
    const p = tmpFile("clear.jsonl");
    const d = new ProviderDiagnostics({ enabled: true, filePath: p });
    d.recordRequest({ a: 1 });
    check("buffer populated before clear", d.recent(10).length === 1);
    d.clear();
    check("buffer emptied by clear", d.recent(10).length === 0);
  }

  // ── env parsing ───────────────────────────────────────────
  console.log("Env parsing:");
  {
    const on = (v?: string): boolean => diagnosticsEnabledFromEnv({ TRIMEGISTO_CAPTURE_PAYLOADS: v });
    check("unset => true", diagnosticsEnabledFromEnv({}) === true);
    check("undefined => true", on(undefined) === true);
    check('"1" => true', on("1") === true);
    check('"0" => false', on("0") === false);
    check('"false" => false', on("false") === false);
    check('"off" => false', on("off") === false);
    check('"OFF" => false', on("OFF") === false);
    check('"False" => false', on("False") === false);
    check('"  off  " => false', on("  off  ") === false);
    check('"true" => true', on("true") === true);
  }

  check("temp dir is under os.tmpdir()", tmpRoot.startsWith(os.tmpdir()), tmpRoot);
} catch (err) {
  failed++;
  console.log(`  ✗ FAIL: uncaught test error — ${String(err)}`);
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  cleanupOk = !fs.existsSync(tmpRoot);
}
check("temp dir cleaned up", cleanupOk);

console.log("Embedded credentials (QA: a key pasted into prose was written in clear):");
{
  const key = "sk-proj-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c";
  const r: any = redactSecrets({
    sentence: `my key is ${key} ok`,
    url: `https://api.example.com?token=${key}`,
    header: `Bearer ${key}`,
  });
  const dump = JSON.stringify(r);
  check("a key inside a sentence is redacted", !dump.includes(key), r.sentence);
  check("a key inside a URL is redacted", !dump.includes(key), r.url);
  check("the rest of the sentence survives", String(r.sentence).includes("my key is") && String(r.sentence).includes("ok"), r.sentence);
  // Over-redaction is the safe direction here, but a long hyphenated path segment
  // is not a credential and must survive (it has no digit).
  const pathy = "very-long-directory-name-here";
  check("a long hyphenated non-credential token survives", redactSecrets({ p: pathy }).p === pathy);
}

console.log("Short prefixed secrets and credential-shaped object keys (QA leak probe):");
{
  const cases: Array<[string, string]> = [
    ["short sk- secret", "sk-1234567890"],
    ["short ghp_ secret", "ghp_abc12345"],
    ["short Bearer token", "Bearer abcd"],
  ];
  const dump = JSON.stringify(redactSecrets(Object.fromEntries(cases.map(([n, v]) => [n, v]))));
  for (const [n, v] of cases) check(`${n} redacted`, !dump.includes(v), dump.slice(0, 200));
  const keyed = redactSecrets({ "sk-1234567890": "value" } as any);
  check("a credential used as an OBJECT KEY is redacted", !JSON.stringify(keyed).includes("sk-1234567890"), keyed);
  check("normal short values survive", redactSecrets({ v: "hello" }).v === "hello");
}

/* ════════════════════════════════════════════════════════════════════════
 * PROPERTY / FUZZ SUITE (deterministic, seeded)
 *
 * The literal QA checks above kept passing while the redaction rules were
 * wrong three times in a row because they only asserted the examples the
 * author thought of. These blocks assert the PROPERTY:
 *   ∀ canary c, ∀ carrier shape s:  c ∉ sanitizePayload(s(c))
 *   ∀ ordinary string o (non-credential-shaped): sanitizePayload({o}) ⊇ o
 *   sanitizePayload is pure: same bytes on repeat, input never mutated.
 * A future heuristic change that re-opens any of these gaps fails CI.
 *
 * Leak probes for shapes the CURRENT implementation does not claim to cover
 * (short prefixed bodies < 8 chars after prefix, secrets embedded inside a
 * longer object KEY, digit-less two-class tokens) are printed as LEAK lines
 * but not asserted — they are reported separately, never patched over.
 * ════════════════════════════════════════════════════════════════════════ */
console.log("Property: canaries never survive any carrier shape:");
{
  // Deterministic PRNG (mulberry32). No Math.random, no Date.now.
  const seedState = { s: 0x9e3779b9 ^ 20260215 };
  function rnd(): number {
    seedState.s = (seedState.s + 0x6d2b79f5) | 0;
    let t = Math.imul(seedState.s ^ (seedState.s >>> 15), 1 | seedState.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const ri = (n: number): number => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)];
  const LOWER = "abcdefghijklmnopqrstuvwxyz";
  const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const DIGIT = "0123456789";
  const fill = (set: string, n: number): string => {
    let s = "";
    for (let i = 0; i < n; i++) s += set[ri(set.length)];
    return s;
  };

  // Canary shapes required by the brief:
  //   a) known prefixes sk-/sk-proj-/pk-/ghp_/gho_/github_pat_/"Bearer "
  //      (body >= 8 chars so the current PREFIXED_SECRET_RE contract holds;
  //       for non-anchored carriers the body also carries a digit + >= 20 chars),
  //   b) mixed-class alphanumerics of length 20..64 (>= 2 classes, digit always:
  //      the whole-value AND embedded contracts),
  //   c) tokens with - / _ / . inside (segments >= 8 chars, digit guaranteed).
  const canaries: string[] = [];
  const seen = new Set<string>();
  const pushCanary = (c: string): void => {
    if (!seen.has(c) && c.length >= 20) { seen.add(c); canaries.push(c); }
  };
  const seg = (): string =>
    pick([fill(LOWER + DIGIT, 8 + ri(14)), fill(LOWER + UPPER + DIGIT, 8 + ri(14)), fill(UPPER + DIGIT, 8 + ri(12))]);
  const tokenWithSeparators = (): string => {
    const n = 2 + ri(3);
    const parts: string[] = [seg()];
    for (let i = 1; i < n; i++) parts.push(seg());
    let s = "";
    for (let i = 0; i < parts.length; i++) {
      s += parts[i];
      if (i < parts.length - 1) s += pick(["-", "_", "."]);
    }
    return s;
  };
  for (const p of ["sk-", "sk-proj-", "pk-", "ghp_", "gho_", "github_pat_", "Bearer "]) {
    for (let i = 0; i < 24; i++) {
      const body = i % 3 === 0 ? tokenWithSeparators() : fill(LOWER + UPPER + DIGIT, 20 + ri(40));
      pushCanary(p + body);
    }
  }
  while (canaries.length < 210) pushCanary(tokenWithSeparators());

  // Carrier shapes: whole value, prose, URL query, header values (known-secret
  // key, generic key, bare string), object KEY, arrays, depth 1..8, JSON-string
  // blob (as value AND as key), truncation (canary first / canary last).
  const carriers: Array<{ name: string; make: (c: string) => unknown }> = [
    { name: "whole-value", make: (c) => ({ value: c }) },
    { name: "sentence", make: (c) => ({ note: `the token ${c} was rejected by upstream` }) },
    { name: "url-query", make: (c) => ({ url: `https://api.example.com/v1?key=${c}&other=1` }) },
    { name: "header-authorization", make: (c) => ({ headers: { Authorization: c } }) },
    { name: "header-cookie", make: (c) => ({ headers: { Cookie: `sid=9; x=${c}` } }) },
    { name: "header-generic", make: (c) => ({ headers: { "X-Trace": c } }) },
    { name: "header-bare-string", make: (c) => c },
    { name: "object-key", make: (c) => ({ [c]: "value" }) },
    { name: "array", make: (c) => ({ items: ["filler", c, 7] }) },
    { name: "nested-depth-1", make: (c) => ({ a: c }) },
    { name: "nested-depth-2", make: (c) => ({ a: { b: c } }) },
    { name: "nested-depth-3", make: (c) => ({ a: { b: { c: c } } }) },
    { name: "nested-depth-4", make: (c) => ({ a: { b: { c: { d: c } } } }) },
    { name: "nested-depth-5", make: (c) => ({ a: { b: { c: { d: { e: c } } } } }) },
    { name: "nested-depth-6", make: (c) => ({ a: { b: { c: { d: { e: { f: c } } } } } }) },
    { name: "nested-depth-7", make: (c) => ({ a: { b: { c: { d: { e: { f: { g: c } } } } } } }) },
    { name: "nested-depth-8", make: (c) => ({ a: { b: { c: { d: { e: { f: { g: { h: c } } } } } } } }) },
    { name: "json-blob-value", make: (c) => ({ blob: JSON.stringify({ context: 1, key: c, tail: "z" }) }) },
    { name: "json-blob-key", make: (c) => ({ blob: JSON.stringify({ context: 1, [c]: "v" }) }) },
    { name: "trunc-head-16", make: (c) => ({ canary: c, filler: "y".repeat(400) }) },
    { name: "trunc-head-24", make: (c) => ({ canary: c, filler: "y".repeat(400) }) },
    { name: "trunc-tail-16", make: (c) => ({ filler: "y".repeat(400), canary: c }) },
    { name: "trunc-tail-24", make: (c) => ({ filler: "y".repeat(400), canary: c }) },
  ];

  let assertions = 0;
  const totalLeaks: string[] = [];
  for (const s of carriers) {
    const shapeLeaks: string[] = [];
    for (const c of canaries) {
      for (const limit of [16, 24, undefined]) {
        if (limit !== undefined && !s.name.startsWith("trunc")) continue;
        const out = sanitizePayload(s.make(c), limit);
        assertions++;
        if (out.includes(c)) shapeLeaks.push(`limit=${limit ?? "-"} canary=${c} out=${out.slice(0, 90)}`);
      }
    }
    totalLeaks.push(...shapeLeaks.map((l) => `${s.name} ${l}`));
    check(`[${s.name}] no canary survives (${canaries.length} canaries)`, shapeLeaks.length === 0, shapeLeaks.slice(0, 3));
  }
  console.log(`    (${canaries.length} canaries x ${carriers.length} shapes = ${assertions} sanitize assertions, ${totalLeaks.length} leaks)`);
}

console.log("Property: ordinary data survives (no over-redaction):");
{
  const seedState = { s: 0x1234abcd ^ 424242 };
  function rnd(): number {
    seedState.s = (seedState.s + 0x6d2b79f5) | 0;
    let t = Math.imul(seedState.s ^ (seedState.s >>> 15), 1 | seedState.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const ri = (n: number): number => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[ri(xs.length)];

  // Ordinary (non-credential-shaped) strings: prose, absolute and relative
  // paths, hyphenated directory names (< 32 chars or with slashes), numbers,
  // identifiers, code snippets with spaces. Each is long enough (>= 20 chars)
  // to reach the redactors, and must land in the output verbatim.
  const words = ["the","quick","brown","fox","jumps","over","lazy","dog","config","payload","model","error","retry","stream","token","window","buffer","socket","header","engine"];
  const ordinary: string[] = [];
  for (let i = 0; i < 40; i++) {
    let s = pick(words);
    while (s.length < 20) s += " " + pick(words);
    ordinary.push(s + ".");
  }
  const dirs = ["src","lib","node-modules","dist","test-fixtures","tools","scripts","packages","agent-core","data-tmp"];
  for (let i = 0; i < 30; i++) {
    let p = i % 2 === 0 ? "/home/j" : "";
    for (let k = 0; k < 3; k++) p += "/" + pick(dirs);
    ordinary.push(p + "/file" + i + ".ts");
  }
  const segments = ["my-project","data-pipeline","agent-core","ui-components","state-machine","config-files","long-but-plain-name","back-reference","token-bucket"];
  for (let i = 0; i < 20; i++) {
    let s = pick(segments);
    while (s.length < 20) s += "-" + pick(segments);
    ordinary.push(s);
  }
  for (let i = 0; i < 20; i++) {
    ordinary.push(pick([`turnLimitEnabled_${i}`, `retry_after_${i}`, `x-request-id-${i}`, `contentLength=${i}`, `maxEntries=${i}`]));
  }
  for (let i = 0; i < 15; i++) {
    ordinary.push(pick([
      `if (value >= ${i} && out !== null) return out;`,
      `const result = await compute(i * ${i + 7}, opts);`,
      `export function sanitizePayload(x) { return x } // ${i}`,
      `// TODO(j): revisit this heuristic #${i}`,
    ]));
  }

  const categories: Array<{ name: string; items: string[] }> = [
    { name: "prose", items: ordinary.slice(0, 40) },
    { name: "paths", items: ordinary.slice(40, 70) },
    { name: "hyphenated-names", items: ordinary.slice(70, 90) },
    { name: "identifiers", items: ordinary.slice(90, 110) },
    { name: "code-snippets", items: ordinary.slice(110, 125) },
  ];
  let checked = 0;
  for (const cat of categories) {
    const bad: string[] = [];
    for (const o of cat.items) {
      checked++;      const asVal = sanitizePayload({ note: o });
      if (asVal.includes("<redacted>") || !asVal.includes(o)) bad.push(`value:${o} => ${asVal.slice(0, 90)}`);
      const asKey = sanitizePayload({ [o]: `text ${o} tail` });
      if (asKey.includes("<redacted>") || !asKey.includes(o)) bad.push(`key:${o} => ${asKey.slice(0, 90)}`);
    }
    check(`ordinary ${cat.name} survive as value AND key (${cat.items.length} strings)`, bad.length === 0, bad.slice(0, 4));
  }
  const arrayOut = sanitizePayload({ items: ordinary });
  check(`array of ${ordinary.length} ordinary strings survives intact`, !arrayOut.includes("<redacted>"), arrayOut.slice(0, 120));
  console.log(`    (${checked} ordinary strings x value+key = ${checked * 2 + 1} sanitize assertions)`);
}

console.log("Property: purity (no input mutation, byte-identical repeats):");
{
  const seedState = { s: 0x77770001 ^ 987654 };
  function rnd(): number {
    seedState.s = (seedState.s + 0x6d2b79f5) | 0;
    let t = Math.imul(seedState.s ^ (seedState.s >>> 15), 1 | seedState.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const classes = ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789", "-_" ];
  const gen = (n: number): string => {
    let s = "";
    for (let i = 0; i < n; i++) s += classes[i % classes.length][Math.floor(rnd() * classes[i % classes.length].length)];
    return s;
  };

  let mutated = 0, nondet = 0, threw = 0;
  for (let i = 0; i < 25; i++) {
    const payload: unknown = {
      model: "gpt-x",
      headers: { authorization: `Bearer ${gen(32)}`, "x-request-id": `req-${gen(8)}` },
      body: { input: [{ text: gen(40) }, { nested: { api_key: gen(24), list: [gen(20), 1, true, null] } }] },
      arr: [gen(34), { token: gen(18) }, gen(50)],
    };
    const before = JSON.stringify(payload);
    let a: string, b: string;
    try {
      a = sanitizePayload(payload, i % 7 === 0 ? 24 : undefined);
      b = sanitizePayload(payload, i % 7 === 0 ? 24 : undefined);
    } catch { threw++; continue; }
    if (JSON.stringify(payload) !== before) mutated++;
    if (a !== b) nondet++;
  }
  check("sanitizePayload never throws on mixed payloads", threw === 0, threw);
  check("input payload is never mutated (25 deep payloads)", mutated === 0, mutated);
  check("output is byte-identical across repeat calls (25 payloads)", nondet === 0, nondet);
}

console.log("Residual-risk probes (NOT asserted; reported, not patched):");
{
  // Cases the current heuristics demonstrably miss. Printed for visibility in
  // CI output but asserted neither way, so the required properties above stay
  // the pass/fail signal. Each line is a minimal repro for the report.
  const probes: Array<[string, unknown]> = [
    ["prefixed body < 8 chars (whole value)", { v: "sk-Abcdefg" }],
    ["secret embedded inside a longer object KEY", redactSecrets({ "cfg sk-Abcdefghijklmnopqrst end": 1 })],
    ["two-class token without any digit (embedded)", redactSecrets({ x: "use aaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb now" })],
  ];
  for (const [name, payload] of probes) {
    const out = typeof payload === "object" && payload !== null && "v" in (payload as object)
      ? sanitizePayload(payload)
      : JSON.stringify(payload);
    const frag = name.includes("object KEY") ? "sk-Abcdefghijklmnopqrst"
      : name.includes("digit") ? "aaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb"
      : "sk-Abcdefg";
    console.log(`  ${out.includes(frag) ? "✗ LEAK" : "✓ ok  "} ${name} — "${frag}" ${out.includes(frag) ? "survived" : "redacted"}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
