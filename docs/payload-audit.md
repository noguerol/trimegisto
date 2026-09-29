# Trimegisto load-time payload audit

**Scope.** Everything the model pays for at load time for the `trimegisto` extension:

1. the `trimegisto` tool description (`buildToolDescription()`),
2. the full serialized `trimegisto` tool (`name + description + parameters`, including `TrimegistoTaskItem` and every parameter description),
3. the `<trimegisto-policy>` system-prompt block emitted by `formatSystemPolicyContent()`,
4. the `trimegisto_harvest` tool,
5. whether the `settings.json` + `~/.pi/agent/extensions` double config makes pi load the extension twice.

Source revision: working tree at `3cb037a` (package `trimegisto@1.6.32`).
Method: the extension was imported with a stub `ExtensionAPI` and `pi.registerTool()` calls were captured, so all strings/schemas are the **real** runtime objects, not hand-transcribed. Counts are Unicode codepoints (`[...str].length`), which equals chars for this ASCII text except the `✓/✗/⛔/—` glyphs (still 1 codepoint each).

> No source file was edited to produce this audit. All work is read-only measurement.

---

## 1. Exact char counts

Two configurations matter:

- **load-time / default config** — the state at tool-registration time, before `captureActiveModel()` binds the session model. Tier lines fall back to `no active model` / `no model` and to `getDefaultConfig()` caps.
- **real config** — with `~/.pi/agent/trimegisto/config.json` applied (`active.maxParallel: 3` → 2 spawnable slots, T1/T2/T3 `spawn-only-on-active`, real model ids).

| # | Payload | Load-time / default | Real config |
|---|---|---:|---:|
| 1 | `buildToolDescription()` output | **1 587** | **1 725** |
| 2 | `trimegisto.parameters` JSON schema | 2 472 | 2 472 |
| 3 | `trimegisto` full tool `{name,description,parameters}` | **4 127** | **4 265** |
| 3b | same + `label` + `promptSnippet` (`{name,label,description,promptSnippet,parameters}`) | 4 283 | 4 421 |
| 4 | `<trimegisto-policy>` block, no decomposability note | — | **3 131** |
| 4b | `<trimegisto-policy>` block, with note | — | 3 237 |
| 5 | `trimegisto_harvest` full tool `{name,description,parameters}` | — | **447** |
| 5b | same + `label` + `promptSnippet` | — | 538 |

Component breakdown of #1 (config-independent lines, default-config tier lines):

| line | chars | content |
|---|---:|---|
| 0 | 38 | `Launch parallel Trimegisto sub-agents.` |
| 1 | 282 | `Default to delegating: … one small single-file change, one non-parallel command).` |
| 2 | 91 | `Assign DISJOINT subtasks … scouts only for verification.` |
| 3 | 165 | `RULE_GRAPH` |
| 4 | 201 | `RULE_VERIFY` |
| 5 | 147 | `RULE_FRESH` |
| 6 | 132 | `RULE_SETTLE` |
| 7 | 10 | `Tiers now:` |
| 8–11 | 54+58+58+58 = 228 | tier status lines (default config) |
| 12 | 116 | `Default active/t0 = main pi model; prefer several active agents …` |
| 13 | 76 | `Roles: active=t0 mass worker; …` |
| 14 | 87 | `Only spawn ✓ ENABLED tiers; ✗ fails. IDs: … Disabled tool returns error.` |
| | **1 587** | (+14 `\n` joins) |

Real-config tier lines (also used in the policy, produced by the same `tierStatusLine()`):

| tier | chars |
|---|---:|
| `- Active: ✓ ENABLED [deepseek/deepseek-flash] (max 2 parallel)` | 62 |
| `- T1: ✗ unavailable (spawn-only-on-active) [llama-infra/qwen3.8-flash-next (bruma:8081)] (max 1 parallel)` | 105 |
| `- T2: ✗ unavailable (spawn-only-on-active) [llama-infra/qwen3.8-27b (luna:8081)] (max 1 parallel)` | 97 |
| `- T3: ✗ unavailable (spawn-only-on-active) [llama-infra/Apodex1.1-mini (sombra:8081)] (max 8 parallel)` | 102 |

Policy block #4 composition (real config, current source): `formatDelegationContract()` = 1 030 chars, the 9 `COORDINATOR_RULES` joined = 1 208 chars, tier lines = 366 chars, plus the fixed preamble/labels/roles (~527).

`trimegisto_harvest` breakdown: `name` 18, `label` 18, `description` 164, `promptSnippet` 43, `parameters` 223.

### Which number is the user-reported 4 127?

**`4 127` = the FULL serialized `trimegisto` tool = `JSON.stringify({ name: "trimegisto", description: buildToolDescription(), parameters: <TypeBox schema> })` at load time (default config).**

- `description + parameters` = 1 587 + 2 472 = 4 059 → no.
- `name + description + parameters` string concat = 4 069 → no.
- Adding `label` (22) or `promptSnippet` (104) overshoots (4 160 / 4 283) → no.
- The object serialization `{name,description,parameters}` is exactly **4 127**, reproducible to the char.

With the real session config the same serialization is **4 265** (Δ +138 from the longer tier lines). The 4 127 figure therefore corresponds to the tool payload as it exists **at registration/load time**, before the active model and live tier state are bound — which is precisely the "load-time payload" this audit is about.

---

## 2. Duplication map

`COORDINATOR_RULES` (9 rules, 1 208 chars joined) is injected in full into the system policy. Four of those nine rules are **also** spliced verbatim into `buildToolDescription()` (index.ts:1263–1276), and the four tier lines are emitted into **both** payloads by the same `tierStatusLine()` call.

### 2a. Byte-identical duplication (tool description ↔ system policy)

| Fragment | Chars | In tool description | In system policy |
|---|---:|:---:|:---:|
| `RULE_GRAPH` | 165 | ✔ (line 3) | ✔ (`COORDINATOR_RULES[2]`) |
| `RULE_VERIFY` | 201 | ✔ (line 4) | ✔ (`COORDINATOR_RULES[3]`) |
| `RULE_FRESH` | 147 | ✔ (line 5) | ✔ (`COORDINATOR_RULES[4]`) |
| `RULE_SETTLE` | 132 | ✔ (line 6) | ✔ (`COORDINATOR_RULES[7]`) |
| 4 × tier status line | 366 (real) / 228 (default) | ✔ (lines 8–11) | ✔ (`tierLines`) |
| **Total exact duplication** | **1 011 (real)** | | |

The remaining five rules (`RULE_DISJOINT` 73, `RULE_SCOUTS` 88, `RULE_ONENEED` 119, `RULE_SERIAL` 187, `RULE_NOWAIT` 88 = 555) live **only** in the policy — but their content is paraphrased in the tool description:
`RULE_DISJOINT` + `RULE_SCOUTS` → tool line 2 (`Assign DISJOINT subtasks … scouts only for verification.`, 91 chars).

### 2b. Semantic duplication (paraphrase, not byte-identical)

| Tool-description fragment | Chars | Policy counterpart |
|---|---:|---|
| line 0 `Launch parallel Trimegisto sub-agents.` + line 1 delegation paragraph | 320 | `DELEGATION CONTRACT …` (1 030) |
| line 2 `Assign DISJOINT subtasks …` | 91 | `RULE_DISJOINT` + `RULE_SCOUTS` |
| line 7 `Tiers now:` | 10 | `Tiers (roles and capacity; live availability may differ…)` |
| line 12 `Default active/t0 = main pi model; prefer several active agents …` | 116 | `DELEGATION CONTRACT` (§ capacity fill / tier roles) |
| line 13 `Roles: active=t0 mass worker; t3 mechanical; t2 reasoning; t1 planning only.` | 76 | `Roles: active = mass worker; t1 = planning; t2 = reasoning; t3 = mechanical.` |
| line 14 `Only spawn ✓ ENABLED tiers; ✗ fails. IDs: …` | 87 | `Spawn only tiers marked ✓ ENABLED, and respect each tier's max parallel.` |

### 2c. Duplication between `COORDINATOR_RULES` and the TypeBox parameter schema

The 1 208-char rules section is itself largely a prose restatement of the 2 472-char `parameters` schema that ships in the same tool object:

| Rule | Chars | Parameter description(s) that already say it | Chars |
|---|---:|---|---:|
| `RULE_GRAPH` | 165 | `goal` 74 + `why` 84 + `needs` 125 + `writes` 68 | 351 |
| `RULE_VERIFY` | 201 | `verify` | 258 |
| `RULE_FRESH` | 147 | `context` 211 + `diversity` 177 | 388 |

So ~513 of the 1 208 rule chars are paid a third time on top of the tool description and the schema. The comment at `src/index.ts:1230` ("ONE source of truth … so the same instruction is not stored twice") is true only for tool-desc ↔ policy; the parameter descriptions are a separate hand-authored copy.

---

## 3. Double-load diagnosis (`settings.json` packages + `extensions/` symlink)

**Verdict: pi loads the extension ONCE. The policy block and the `trimegisto` tool are paid once, not twice.**

### The two candidate entries

The config produces two *different path strings* that point at the same file:

| Route | Produced path string | How it is produced |
|---|---|---|
| `~/.pi/agent/settings.json` → `packages: ["../../repos/trimegisto"]` | `/home/j/repos/trimegisto/src/index.ts` | `collectPackageResources()` reads `package.json` → `pi.extensions: ["./src/index.ts"]` → `addManifestEntries()` (`package-manager.js:1817–1830`) |
| `~/.pi/agent/extensions/trimegisto` → symlink to `/home/j/repos/trimegisto/src` | `/home/j/.pi/agent/extensions/trimegisto/index.ts` | `collectAutoExtensionEntries()` (`package-manager.js:405–470`); the symlink target `src/` has **no** `package.json`, so `resolveExtensionEntries()` (`package-manager.js:377`) falls through to `index.ts` |

Both path strings exist and are valid:
`/home/j/repos/trimegisto/src/index.ts` and `/home/j/.pi/agent/extensions/trimegisto/index.ts`.

### Why they collapse to one

`mergePaths()` in `core/resource-loader.js:656–668` is the gate:

```js
mergePaths(primary, additional) {
    const merged = []; const seen = new Set();
    for (const p of [...primary, ...additional]) {
        const resolved = this.resolveResourcePath(p);
        const canonicalPath = canonicalizePath(resolved);   // realpathSync
        if (seen.has(canonicalPath)) continue;
        seen.add(canonicalPath);
        merged.push(resolved);
    }
    return merged;
}
```

and `canonicalizePath` is `realpathSync` (`utils/paths.js`):

```js
export function canonicalizePath(path) {
    try { return realpathSync(path); } catch { return path; }
}
```

Verified on this machine:

```
/home/j/repos/trimegisto/src/index.ts                      -> /home/j/repos/trimegisto/src/index.ts
/home/j/.pi/agent/extensions/trimegisto/index.ts           -> /home/j/repos/trimegisto/src/index.ts
same canonical: true
```

`realpathSync` resolves the `trimegisto → …/src` directory symlink, so both entries canonicalize to the **same** string and the second is dropped by `seen`.

### The full call path (all in `core/resource-loader.js` unless noted)

1. The app uses `DefaultResourceLoader` (`core/agent-session-services.js:63`).
2. `reload()` builds `enabledExtensions = getEnabledPaths(resolvedPaths.extensions)` (line 295–296) and then
   `extensionPaths = this.mergePaths(cliEnabledExtensions, enabledExtensions)` (line 316–318) → **dedup happens here**, before any module is imported.
3. If project-trust resolution is requested, a bootstrap pass runs `loadProjectTrustExtensions()` → `loadCurrentExtensionSet()`, which applies the *same* `mergePaths` (line 411) — still one entry.
4. `loadFinalExtensionSet(extensionPaths, preTrustExtensions)` (line 424) indexes the already-loaded bootstrap set by `resolvedPath`, computes `remainingPaths` = `extensionPaths` minus those `resolveExtensionLoadPath()` values (line 421 = plain `resolvePath`, **no** realpath), and calls `loadExtensionsCached(remainingPaths, …)`. Since `extensionPaths` already has one entry and it is the preloaded one, `remainingPaths` is empty → nothing re-imported.
5. `loadExtensionsCached` → `loadExtensionsInternal` (`core/extensions/loader.js:485–506`) iterates the surviving single path and calls `loadExtension()` once.

### What actually does *not* save you (and what would break)

- `loadExtensionsCached`'s cache is keyed by the **path string** (`loader.js:394–425`, `extensionCache.get(extensionPath)`), not by realpath. On its own it would **not** dedup `…/src/index.ts` vs `…/extensions/trimegisto/index.ts`; jiti also runs with `moduleCache: false`. The safety net is `mergePaths`' realpath canonicalization, nothing else.
- The exported legacy helper `discoverAndLoadExtensions()` (`loader.js:596–633`) uses a *different* dedup: `seen.add(path.resolve(p))` — **no realpath** — and calls the **uncached** `loadExtensions()`. Fed this same configuration it *would* import both strings and run the factory twice (double `registerTool` → tool-conflict diagnostics; double `before_agent_start` handler → the policy block built and injected twice). `DefaultResourceLoader` never calls it, so the shipped app is safe; any SDK consumer that does call it with this config is not.

**Conclusion:** the duplicate configuration is real on disk but harmless to pi's default loader. Nothing is paid twice. The `4127`-char tool and the `3131`-char policy block are each sent once per request.

### How to confirm empirically (no source edits)

Run pi with the timing probe enabled and look for duplicate factory timings for trimegisto:

```bash
PI_TIMING=1 pi ...
# loader.js calls time(`${extensionPath} factory`, "extensions") per loaded path.
# One line for trimegisto => loaded once; two lines (two different path strings) => loaded twice.
```

---

## 4. Ranked pruning candidates

Ranked by *savings × confidence ÷ risk*. "Tool block" = the `{name,description,parameters}` payload (#3); "policy" = the system-prompt block (#4). Savings are measured chars, not estimates, except where a range is given for rewritten text.

| Rank | Candidate | Where | Est. saving | Risk |
|---:|---|---|---:|---|
| 1 | Drop the 4 `RULE_*` from `buildToolDescription()` (lines 3–6): `RULE_GRAPH`, `RULE_VERIFY`, `RULE_FRESH`, `RULE_SETTLE`. They are byte-identical in `COORDINATOR_RULES`. | `src/index.ts:1268–1271` | **−649** tool block (**−651** serialized: `RULE_FRESH` adds 2 JSON escapes) | Very low — verbatim copy remains in the policy; content also in param descriptions |
| 2 | Fold the tool-description delegation text (lines 0, 1, 12 = 436) into one line (`Delegate by default: one batch for any request that splits; fill ENABLED slots.`, ~80). | `src/index.ts:1264–1265,1277` | **−356** tool block | Medium — the authoritative contract stays in the policy, but the call-time cue shrinks |
| 3 | Trim verbose TypeBox param descriptions: `lane` 216→~40, `sequential` 202→~40, `verify` 258→~90, `context` 211→~70, `diversity` 177→~60. Rare/opt-in fields; move detail to README/skill. | `src/index.ts:136–160` | **−500 … −800** tool block | Low–medium — opt-in params, but `lane` semantics gate irreversible actions |
| 4 | Drop the 4 tier lines + `Tiers now:` from `buildToolDescription()` (lines 7–11). Live availability is already in the policy **and** re-injected per turn by `formatDirectiveContent()`. | `src/index.ts:1272–1276` | **−377** (real) / **−239** (default) tool block | Medium — a caller that suppresses the policy loses availability from the tool card |
| 5 | Compress policy rules that duplicate the schema: `RULE_VERIFY` 201→~60, `RULE_GRAPH` 165→~45, `RULE_FRESH` 147→~40. | `src/index.ts:1236–1238` + policy | **−368** policy | Low — param descriptions keep the detail |
| 6 | Shorten tier model strings to short ids (`qwen3.8-flash-next`, `qwen3.8-27b`, `Apodex1.1-mini`; drop `(bruma:8081)` etc.). | `tierStatusLine()` consumers | **−~200** policy (and −~200 tool block if candidate 4 is not applied) | Medium — the host tag aids routing diagnostics |
| 7 | Remove the two role/spawn lines (13, 14; 163) from the tool description, keeping only `IDs: t0a,t1a,t2b,t3c.` (~26). | `src/index.ts:1278–1279` | **−137** tool block | Low — both statements exist verbatim-ish in the policy |
| 8 | Shorten the policy preamble line (`Injected by the Trimegisto extension…`, ~230) to ~60 while keeping the origin/not-a-request framing. | `src/tier-status.ts:125` | **−170** policy | Medium — this line exists to stop "instructions with no request" refusals |
| 9 | Fold `trimegisto_harvest` into the main tool (e.g. `harvest: true` / a `mode` param) and drop the second registration. | `src/index.ts:1775` | **−447** tool schema (**−538** full object) | Medium–high — removes a tool slot from the model's choice set; RULE_NOWAIT still points at harvest |
| 10 | Drop `promptSnippet` (104) and `label` (22), or trim the snippet to the tool-desc first line. | `src/index.ts:1282,1286` | **−126** full tool object (not in the 4 127) | Low for label; medium for snippet (cache-stable short cue) |
| 11 | Merge `RULE_DISJOINT` + `RULE_SCOUTS` (73 + 88) into one ~95-char line. | `src/index.ts:1234–1235` | **−66** policy | Low |
| 12 | Unify the two `cwd` fields (tool-level 10-char desc vs task-level 9-char desc). | `src/index.ts:143,1294` | ~10 | Very low |

### Cumulative effect

- Applying **1 + 4 + 7** alone: tool block `4 265 → 3 100` (real) / `4 127 → 3 100` (default), with **zero information loss** — every dropped fragment remains byte-identical elsewhere in the same request.
- Applying **1 + 2 + 3 + 4 + 7**: tool block `4 265 → ~2 100` (description collapses to roughly 200 chars; `parameters` ~1 900).
- Applying **5 + 6 + 8 + 11**: policy `3 131 → ~2 300`.
- Combined realistic ceiling: **~3 000 fewer chars** across the tool block + policy per request, before touching behaviour or provider-visible semantics.

Caveats on the ranking:

- Candidate 1 is the only change that removes *provable byte-identical* duplication without rewording anything; it should go first.
- Candidates 4 and 6 overlap (both shrink the same tier lines); do not sum them.
- Candidates 1 and 7 move the "how to delegate" load entirely into the system prompt. If any code path ever suppresses `formatSystemPolicyContent()` (e.g. a non-coordinator worker), the tool card becomes much thinner — verify the worker path first.
- `trimegisto_harvest` (candidate 9) is cheap in chars but is a distinct tool-choice affordance; keep it unless tool-list size is the actual constraint.

---

## 5. Caveats / observations

- **Counts are from the working tree** (`3cb037a`, `trimegisto@1.6.32`), as requested.
- **Version skew in the live process:** the `<trimegisto-policy>` block injected into the currently running session does **not** match the working tree's `formatDelegationContract()` output — it carries the longer pre-`16be337` wording plus a longer `ENFORCED` line. The running pi process therefore holds an earlier revision of the extension in memory (or the session's system prompt predates the current file). This affects the *live* policy size only; it does **not** change the double-load verdict or the `4 127` identification, which reproduce exactly against the working tree.
- **Cost model:** the tool payload is re-sent in every request's tool list (cache-friendly but context-consuming); the policy block is a stable system-prompt prefix (cacheable). Ranks 1–4 reduce the tool schema; ranks 5–8 reduce the system prefix.
- **The double-load is a latent trap, not an active bug.** pi's default `DefaultResourceLoader` dedups by realpath and loads the extension once. The legacy `discoverAndLoadExtensions()` export dedups by `path.resolve` only and *would* double-load this exact configuration; that is the real risk to document for SDK consumers.
