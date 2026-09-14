<div align="center">

![Trimegisto banner](https://raw.githubusercontent.com/noguerol/trimegisto/main/docs/banner.jpeg)

</div>

# Trimegisto — Multi-Agent Orchestration for pi

Trimegisto turns pi into a multi-agent runtime. It launches **parallel sub-agent processes** organized in four tiers, lets you (or the main LLM) delegate work to them, and keeps the whole swarm under control with a swarm guard, advisory file locks, a context broker and a live dashboard — without ever replacing pi's native UI. (Reasoning-loop detection is delegated to the separate [`antiloop`](https://github.com/noguerol/antiloop) extension.)

Every sub-agent is a real `pi` process (`pi -p --mode json`), so agents run in complete isolation with their own context window, tools and model.

---

## Tiers

| Tier | Role | Model | Max Parallel | Compaction | Agent IDs |
|------|------|-------|--------------|------------|-----------|
| **active** (t0) | Default worker. Runs the **same model as your main session** — mass-parallel by default. | the pi active model | 4 | 85% | `t0a`, `t0b`... |
| **t1** | Deep thinking / planning. RESERVED for expensive models. | configured | 1 | 65% | `t1a`, `t1b`... |
| **t2** | Complex problem solver (reasoning above the active model's reach). | configured | 4 | 75% | `t2a`, `t2b`... |
| **t3** | Fast, cheap worker for mechanical tasks (parsing, formatting, translation, file ops). | configured | 4 | 85% | `t3a`, `t3b`... |

- The **active** tier is always available (it uses the model pi is currently running, captured live — even if you switch models mid-session with `/model`).
- **t1/t2/t3** are only available once you give each tier a model via `/tmg config` (or a config file / agent file). Unavailable tiers are reported to the LLM so it never tries to spawn them.
- Agent IDs: `t` + tier number + instance letter (`t0a`, `t2b`, `t3c`...).

## Install

Trimegisto is a [pi package](https://pi.dev/packages): one extension (`src/index.ts`) plus three tier skills (`agents/`), declared in `package.json`.

```bash
# From GitHub (recommended)
pi install git:github.com/noguerol/trimegisto

# Pin a tag/commit (refs are never moved by `pi update`)
pi install git:github.com/noguerol/trimegisto@v1.0.0

# Local checkout (development)
pi install /path/to/trimegisto

# Try it for one run only, without installing
pi -e git:github.com/noguerol/trimegisto
```

```bash
pi list                     # show installed packages
pi remove git:github.com/noguerol/trimegisto
pi update --extensions      # reconcile pinned git refs
```

> **Security:** pi packages run with full system access — extensions execute arbitrary code and spawn processes. Install only packages you trust and review.

**Requirements:** a working pi installation and at least one usable model. Sub-agents inherit your providers/API keys; local servers (ollama, vLLM, LM Studio, llama.cpp, ...) work fine if configured as pi providers.

## Quick Start

```
# Open the interactive config (pick a model for each tier, tune limits)
/tmg config

# Launch agents from the prompt
/t0 analyze the CSVs in ./data and summarize the columns
/t2b fix the failing test in src/parser.ts
@t3c translate the docs to Spanish

# Or just ask normally — when enabled, the main LLM is instructed to
# spawn first for any decomposable/parallelizable request.
"Review the diff, run the relevant tests, and summarize risks."

# Inspect & control
/tmg list
/tmg dashboard
/tmg halt            # or Ctrl+Alt+H
/tmg config          # ...
```

Results are harvested into the chat as each agent finishes, with per-agent logs, token/cost usage and a `✓ n/m done` summary. The main agent is explicitly instructed not to `sleep`/poll waiting for workers; it can call `trimegisto_harvest` for an instant non-blocking snapshot instead.

### Live throughput in the dashboard

While agents run, the dashboard shows **continuous prefill and generation speeds** for every target (each sub-agent plus the main session), updating ~every 500 ms without any input from you:

```text
🧙 Tmg:on 3 active ↓246.7t/s ↑1890t/s T2 2r T3 1r · ⌁ main ↓38.1t/s
```

- `↓NNNt/s` — decode/generation (summed across agents), **live** while streaming
- `↑NNNt/s` — prefill/prompt-processing throughput (averaged), only when the prompt is big enough that compute dominates the round trip
- `↑817ms` — a small prompt: time-to-first-token is shown instead of a fake throughput (TTFT includes network latency)
- `↑…2.1s` — the model is still chewing on the prompt, nothing generated yet
- `⌁ main` — the main session's own speed, while it answers in between agent results

The values are measured from the token stream itself (provider-agnostic), calibrated per model from real usage, and smoothed with an EMA so bursts don't flicker.

The **full widget** (`/tmg dashboard` → `widget`) lists each agent with its **model** right after the agent id, so you can tell which model each worker is using (handy with redundant-model pools):

```text
  ◌ t2a Deepseek v4 Flash · T2 12s ↓38t/s 📤1.2k 📥3.4k — analyze the logs
```

Model ids are humanized — last path segment, separators to spaces, version prefixes kept lower-case (`deepseek/deepseek-v4-flash` → `Deepseek v4 Flash`, `moonshot/kimi-k3` → `Kimi K3`, `.../Qwen3.8-27B-ROCmFP4-FAST.gguf` → `Qwen3.8 27B ROCmFP4 FAST`). Long labels are capped with `…`. Before a worker's first response the label falls back to the requested model.

**The clock is honest.** Each agent's timer shows total time since it started, but it **freezes the moment the agent finishes, errors or is killed** (it no longer counts up for a finished worker), and **resumes without jumping backwards if the agent comes back to life** (e.g. a failover retry). The number is wall-clock time — it does not try to measure how long the model actually spent processing, only how long the agent has been alive.

## Usage

### The `trimegisto` tool (LLM-facing)

When Trimegisto is enabled, a hidden orchestration directive is injected before each main-agent turn: decomposable work must be delegated first, and the main agent should keep coordination/synthesis. The main model can delegate work in a single non-blocking call:

```json
{
  "goal": "make the parser accept v2 manifests without breaking v1",
  "tasks": [
    { "tier": "active", "task": "map every place v1 manifests are parsed", "why": "locate the parser entry points", "writes": ["docs/parser-map.md"] },
    { "tier": "active", "task": "port the v1 tests to v2 fixtures", "why": "agree on the expected behaviour", "writes": ["test/manifest.test.ts"] },
    { "tier": "t2",     "task": "implement v2 parsing on top of that map", "why": "the change itself", "needs": [1], "writes": ["src/manifest.ts"] }
  ],
  "cwd": "/path/to/work"
}
```

- `tier` defaults to `active`; max 8 tasks per call (per-tier capacity = `maxParallel`, higher with redundant model pools).
- **`goal`** is the overall objective. **`why`** is one line saying which part of it a task serves. A task that cannot name its need should not be spawned.
- **`needs: [i]`** declares a real data dependency (1-based indices inside the same call). Declared dependencies run in **waves**: wave 2 starts only when wave 1 is terminal, and the upstream **verdict is injected into the dependent task**, so the edge actually carries data instead of being cosmetic. Tasks with no edge run in parallel — that is what to parallelise.
- **`writes: [paths]`** lists files a task will write. Two tasks writing the same file are **serialised automatically** instead of racing (and instead of being silently rejected by the file lock at runtime).
- **`lane`** overrides the automatic blast-radius classification: `open` (contained/reversible), `gated` (wide but reversible), `closed` (irreversible/high-consequence). A `closed` task makes the whole call **refuse to launch** — that lane does not open.
- The tool **returns immediately**; agents run in the background and the batch **always ends with one reconciliation** (see [Guaranteed reconciliation](#guaranteed-reconciliation)).
- The tool description always lists which tiers are ENABLED right now — the LLM only spawns those.
- `trimegisto_harvest` returns the current agent snapshot immediately. It never waits; use it instead of sleep/poll loops.

#### Plan gate (stop paying for work that should not run)

Before anything is spawned, a **deterministic, model-free** gate (`src/plan-graph.ts`) turns the batch into a graph and rejects or repairs it:

- **Duplicates merged.** Two tasks that would produce the same answer are one node, not two. Near-duplicate text inside the batch is clustered (shingle + Jaccard) and only the lowest index is launched; the rest are reported as merged. This is on top of the cross-call registry dedup (a task that duplicates something spawned in the last 5 minutes is skipped and never registered, so it can be retried later).
- **Dependencies enforced.** `needs` is validated (out-of-range, self-references and cycles are dropped deterministically with a warning) and topologically sorted into waves. If a task *reads like* a pipeline step (`then`, `based on the findings`, `using the output`…) but declares no `needs`, the gate warns instead of guessing — an edge is only an edge when the next node actually reads the previous output.
- **Same-file writers serialised.** No two launched nodes write the same file in the same wave.
- **Code nodes flagged.** A task that is a pure transformation (parse, count, rename, format, diff…) is flagged: do it with bash instead of paying a model for a step that has exactly one correct answer.
- **Relevance checked.** With a `goal` and a `why` per task, the gate computes a deterministic lexical overlap and warns when a task has no link to the stated objective. Without a `goal` it says so once and cannot check relevance at all.
- **Closed lanes refused.** Irreversible, high-blast-radius work (deletions, `force-push`, deploy/publish, migrations, production data, credential rotation) is never launched automatically, whatever the confidence — the human decides.
- **Feasible waves only.** A wave larger than the tier capacity is refused with an actionable message (split it with `needs`, or raise `maxParallel`); a wave that merely arrives when the tier is busy is **queued** and launched when a slot frees, not refused.
- The gate's verdict is returned in the tool result (`### Waves`, `### Serialised`, `### Duplicates merged`, `### Code nodes`, `### Warnings`, `### Blockers` and the final `**Plan verdict:**` line), so the coordinator can see exactly why its plan was reshaped.

#### Guaranteed reconciliation

A spawn call is a **batch**, and a batch always produces exactly one final answer:

- Each agent's **last assistant message** is captured separately as its verdict (not a head-truncated slice of its whole transcript), and the reconciler distils `final verdict > last meaningful output block > stderr`. Free-text fields are collapsed to one line before rendering, so an agent id, status or task containing newlines cannot forge a heading or a fake conclusion line.
- The batch settles — and emits **one** `🪡 Trimegisto — final reconciliation` message — as soon as every agent is terminal (`done` / `error` / `killed`), or when the **hard batch deadline** expires (`TRIMEGISTO_BATCH_DEADLINE_MS`, default 30 min, minimum 1 min). Killed agents, watchdog kills and agents that never report still count as settled, so the conclusion is never lost.
- The message lists per-agent verdicts, status counts, usage, **overlapping results** (near-duplicate verdicts collapsed with a similarity note), an explicit `INCOMPLETE:` list for anything that did not settle, and closes with the shared conclusion line. Agents that reported success but produced no usable verdict — empty output, or a raw provider error as their last message — are listed under **Unverified** with a `⚠️` icon instead of a silent `✅`, so the conclusion never over-claims. The reconciler is pure and deterministic (`src/reconcile.ts`); if it ever throws, a minimal fallback conclusion is still emitted.
- Delivery uses `deliverAs: followUp` + `triggerTurn`, so the main model gets **exactly one** turn to write the unified final answer on top of the deterministic conclusion — without interrupting work in flight. The conclusion is rendered the moment it is sent, so it reaches you even when the main model's next request fails (e.g. a provider `400`).
- Live agent progress and logs are **TUI-only entries**: they render in the transcript but are *not* sent to the main model. Only the reconciliation participates in the main conversation, which keeps the coordinator's context small and avoids the provider-400 storms an unbounded stream of injected messages used to cause. The `context` hook additionally drops empty Trimegisto messages and caps retained progress notes.

### Slash commands (user-facing)

| Command | Description |
|---------|-------------|
| `/t0 <task>` `/t1 <task>` `/t2 <task>` `/t3 <task>` | Spawn a new agent of the tier |
| `/t2b <instruction>` | Steer an existing agent (kill + relaunch with combined context); spawns one with that ID if it doesn't exist |
| `@t2b <instruction>` | Same, @-mention syntax (intercepted before the LLM sees it) |
| `/tmg launch <tier> <task>` | Launch an agent (verbose) |
| `/tmg tell <agent-id> <msg>` | Send an instruction to a running agent |
| `/tmg kill <id>` | Kill one agent |
| `/tmg halt` | Halt all agents (shortcut: **Ctrl+Alt+H**) |
| `/tmg list` | List all agents, status, elapsed, task |
| `/tmg switch <id>` | Show an agent's output |
| `/tmg dashboard` | Cycle dashboard mode (compact → widget → off) |
| `/tmg enable` / `/tmg disable` | Toggle Trimegisto globally |
| `/tmg locks` | Show active file locks |
| `/tmg guard` (alias `/tmg loops`) | Show guard state (spawn depth, turn warnings, redundancy, paused models) |
| `/tmg reset-guard [active\|t1\|t2\|t3]` | Reset guard/redundancy counters for a tier (or all) |
| `/tmg models` | Show model-health state (failures + paused models) |
| `/tmg reset-models [model]` | Clear the circuit breaker for one model (or all) |
| `/tmg config` | Interactive configuration (models, limits, flags) |

### Steering

Because each agent is a separate process, "steering" means **replacing**: Trimegisto kills the agent and relaunches a new one (same ID, same tier) with the previous task + your new instruction combined. (Loop-stuck sub-agents are handled in-process by antiloop, which warns, force-breaks and finally aborts the run — no respawn needed.)

## Configuration

### `/tmg config` (interactive)

Menu → per-tier submenu:

- **Model** — scrollable picker over your pi model registry (`provider/model`)
- **Max Parallel** — 1–8 concurrent agents per tier (× pool size when redundant agents are on)
- **Compaction Threshold** — `off (pi default)` or 50–95% of context window for forced proactive compaction. Off (default) leaves compaction to pi's native setting.
- **Redundant models** (t1/t2) — pool for load-balancing + automatic failover
- **Enabled** — toggle the tier

Changing any setting keeps you in the same menu, so you can flip several options in one session; `Back`/`Esc` goes up one level and `Done` closes.

Global flags in the main menu:

| Flag | Default | Effect |
|------|---------|--------|
| `enabled` | `true` | Master switch for the whole extension |
| `autoSpawn` | `true` | Enables proactive delegation guidance and lets sub-agents spawn other agents (`trimegisto_spawn`) |
| `useActiveModel` | `true` | `active` tier agents use the pi active model (OFF → pi default model) |
| `spawnOnlyOnActive` | `false` | Force **all** spawns onto the `active` tier (t0); t1/t2/t3 never spawn |
| `redundantAgents` | `false` | t1/t2 spawn on the least-loaded model of their pool and fail over on provider errors/exhaustion/timeouts |
| `dedupeTasks` | `true` | Reject near-duplicate tasks before launch (exact + word-set similarity, 5 min window) |
| `dedupeCrossAgent` | `false` | Flag near-identical outputs from *different* agents and report wasted tokens |
| `loopSupervisor.turnLimitEnabled` | `false` | Opt-in turn limit: warn at `maxAgentTurns` (50) then kill at `+turnLimitGrace` (65). Off = never killed on turn count |
| `dashboard` | `compact` | UI mode: `compact` / `widget` / `off` |
| `modelHealth` | on, 2 fails → 60 s→600 s | Circuit breaker that pauses spawns on a model failing at the provider level |

### Config file

Settings persist in **`~/.pi/agent/trimegisto/config.json`** — created automatically on first save and surviving `/new`, `/resume`, `/fork`. Edit it by hand anytime (a ready-to-adapt template lives in [config.example.json](config.example.json) in this repo). A session entry is also written as a fallback via `pi.appendEntry()`.

### Tier agent files (optional)

Each tier can be customized with a markdown agent file, discovered from your user or project agent directories:

```markdown
---
name: trimegisto-t3
description: My custom T3 worker
tools: read,bash,edit,write,grep,find,ls,trimegisto_spawn
model: openrouter/google/gemini-flash-1.5
---
Your custom system prompt for this tier...
```

- `~/.pi/agent/agents/trimegisto-{active,t1,t2,t3}.md` — user scope
- `.pi/agents/trimegisto-{active,t1,t2,t3}.md` — project scope (walks up from cwd)

Precedence: **saved config > agent file > built-in defaults** (per field: model, tools, systemPrompt, maxParallel, compactionThreshold, enabled).

### Provider diagnostics (opt-in)

Twice now the coordinator has died with a provider `400 invalid_request_error` and the rejected payload was never seen, so the cause stayed a hypothesis. Capturing every request would be invasive, so this is a **post-mortem window** instead:

- Nothing is written while the provider behaves. When it answers **≥ 400**, Trimegisto starts recording the next requests and responses for **10 minutes** and says so in the transcript.
- Set `TRIMEGISTO_CAPTURE_PAYLOADS=1` to force capture on from the start (or `0`/`false`/`off` to disable the automatic window).
- Records go to `<instance dir>/diagnostics/provider.jsonl` as JSONL. Secret-named keys (`api_key`, `authorization`, `token`, `secret`, …) are always `<redacted>`, and a long token that **mixes character classes** is redacted too, and a credential embedded inside a longer string (a sentence, a URL, a header value) is redacted in place — while prose, file paths and low-entropy filler are preserved, because blanking the payload would defeat the purpose.
- Diagnostics can never break a request: recording is wrapped, the parent directory is created lazily and any filesystem error is swallowed.

### Loop detection (antiloop) & Swarm Guard

Reasoning/output loop detection lives in the separate **[antiloop](https://github.com/noguerol/antiloop)** extension. Antiloop is discovered by every sub-agent process (pi discovers `~/.pi/agent/extensions`; Trimegisto does not pass `--no-extensions`) and acts **mid-run** (warn → force break → abort). Trimegisto does not duplicate it — **keep antiloop installed for loop protection.**

Trimegisto's main-process guard only covers what antiloop cannot see, because it is cross-process orchestration:

| Mechanism | Detects | Default |
|-----------|---------|---------|
| **Spawn Depth** | Recursive auto-spawn chains | 5 levels |
| **Turn Limit (opt-in)** | Agent exceeds `maxAgentTurns` → **warning only**, then `+turnLimitGrace` → **kill**. Only enforced when `turnLimitEnabled` is ON | **OFF** (`turnLimitEnabled: false`); when enabled: warn at 50, kill at 65 |
| **Cross-agent duplicate** | Two *different* agents producing near-identical output (redundant parallel work) | opt-in via `dedupeCrossAgent`, shingle Jaccard ≥ 0.92 |

Redundancy is tracked **per agent** and never flags same-agent repetition — repeated output from one agent is a reasoning loop, which antiloop owns. With `dedupeCrossAgent` ON, near-identical results across different agents in the same tier get a `♻` alert + wasted-token metric.

The turn limit is **off by default** so long-running agents are never killed on turn count alone. Enable it and set the counts in `/tmg config → Turn limit` (`Enabled`, `Warn at`, `Kill after`); the values are clamped (turns ≥ 1, grace ≥ 0) and persisted in `config.json`. Pre-existing configs that never set `turnLimitEnabled` behave as off.

Inspect with `/tmg guard` (alias `/tmg loops`), clear with `/tmg reset-guard`.

### Model health (circuit breaker)

When a provider/model starts failing at the protocol level — HTTP `400 invalid_request_error`, 5xx, quota/rate limits, connection resets, or a provider hang — every spawn against it fails **fast**. Because a dead process frees its parallel slot immediately, the coordinator (or a sub-agent's `trimegisto_spawn`) can otherwise retry in a tight loop and launch an unbounded number of doomed agents: a **spawn storm**.

Trimegisto classifies each finished attempt as a *model-level* failure only when the model never produced an answer (spawn/launch error, first-response/idle timeout, zero turns with no output, a provider error with no answer text, or `stopReason: error/aborted`). A task that fails after the model actually answered is **never** counted.

After `modelHealth.failureThreshold` consecutive model-level failures (default **2**), the breaker opens and **refuses spawns on that model** for a cooldown:

- Base cooldown **60 s**, doubling on each re-trip up to **600 s** (`cooldownSeconds` / `maxCooldownSeconds`).
- While paused, the `trimegisto` tool, `trimegisto_spawn`, `/t0..t3`, `/tmg launch` and `@` all return a clear *“Model X is paused … retry in ~Ns”* message instead of launching.
- The breaker is **half-open** after the cooldown: one attempt is allowed; a success clears everything, a failure re-opens with a longer cooldown.
- Changing a tier's model in `/tmg config`, adding a redundant model, `/tmg reset-models [model]`, or a successful run clears the block immediately.
- With `redundantAgents` on, a paused model is skipped and the pool keeps working on a healthy candidate; the tier only blocks when **every** candidate is paused.

This is tuned in `/tmg config → Model health` (`enabled`, failures before pause, base/max cooldown) and persisted in `config.json`. Inspect with `/tmg models` or `/tmg guard`.

## How It Works

```
┌────────────────────────────────────────────────────────┐
│                     pi (main)                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │            Trimegisto Extension                  │  │
│  │  commands (/tmg, /t0..t3, @)   trimegisto tool   │  │
│  │  dashboard + status line        config manager   │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │            Agent Manager                   │  │  │
│  │  │  t0 x4  t1 x1  t2 x4  t3 x4  (per-model   │  │  │
│  │  │  pools, failover, guarded)               │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  │  Swarm Guard · File Locks · Context Broker        │  │
│  └──────────────────────────────────────────────────┘  │
└───────────────▲────────────────────────────────────────┘
                │ file-based IPC (requests/ + responses/)
                │ per-instance isolation dir
┌───────────────┴────────────────────────────────────────┐
│  sub-agent = pi -p --mode json --no-session            │
│    --model <tier model> --tools <tier tools>           │
│    --extension subagent-extension.ts                   │
│    tools: trimegisto_spawn (batch, non-blocking),      │
│           file_lock, file_unlock, file_read_track,     │
│           trimegisto_note                              │
└────────────────────────────────────────────────────────┘
```

- **IPC** — sub-agents write spawn requests as JSON files; the main extension polls (500 ms), launches, and writes response files. All communication lives under a **per-instance directory** (`~/.pi/agent/trimegisto/instances/pid-<pid>-<ts>/`), so multiple pi processes running Trimegisto at the same time never interfere.
- **Auto-spawn** — with `autoSpawn` on, the main agent receives a strong hidden policy to spawn first for decomposable work, then continue without idle sleeps. Sub-agents can spawn more agents via `trimegisto_spawn` (batch mode preferred: `{tasks: [...]}` runs everything in parallel). Spawning is **non-blocking** (async polling, no frozen process) and depth-limited by the guard.
- **Task deduplication** — before any launch, the task is fingerprinted and compared (exact + word-set similarity) against tasks spawned in the last 5 minutes. Near-duplicates are skipped with a `⏭` note so the swarm never pays twice for the same work. Disable with `dedupeTasks: false`.
- **Shared context** — each new agent receives a compact preamble of files already read and facts already published (via `trimegisto_note`) by other agents, so it avoids redundant re-reading and re-derivation.
- **File locks** — advisory, 60 s stale timeout. Agents call `file_lock` before write/edit and `file_unlock` after; conflicts return the lock owner so agents can wait or move on. Locks are released automatically when an agent finishes, is killed or halted. Inspect with `/tmg locks`.
- **Context broker** — when an agent modifies a file, other agents that previously read it (via `file_read_track`) get a compact system alert: "⚠️ Stale file: `x.ts` changed by `t3a` — re-read before editing."
- **Proactive compaction** — opt-in. Trimegisto can watch the **main session's** context usage and force pi compaction when it crosses the lowest enabled tier threshold (60 s cooldown). By default all thresholds are **0 (off)**, so pi's native compaction setting decides and we never force an early compaction; set a per-tier 50–95% via `/tmg config` to re-enable it. Pre-v3 configs that still hold the old built-in defaults (85/65/75/85) are migrated to off automatically.
- **Plan graph (waves)** — a spawn call is a graph, not a pile. The gate (`src/plan-graph.ts`) merges in-batch duplicates, serialises same-file writers, flags mechanical work that needs no model, refuses irreversible lanes and sorts declared `needs` into topological waves. The scheduler launches one wave at a time, injects each upstream verdict into its dependents, defers a wave when the tier is momentarily full, and stops advancing if a human halts or kills the wave (dependents are reported as not launched instead of being spawned anyway).
- **Guaranteed reconciliation** — a batch never ends in scattered fragments. On top of the per-agent harvests, every batch is tracked in a session-wide registry and produces exactly one deterministic final-reconciliation message when all agents are terminal or the batch deadline expires (killed/timed-out agents included). Verdicts come from each agent's own final message, near-duplicate verdicts are flagged, and failures are listed as `INCOMPLETE:` instead of being presented as answers. See [Guaranteed reconciliation](#guaranteed-reconciliation).
- **Context hygiene** — sub-agent progress goes to TUI-only entries and never to the main model. Before every LLM call a pure pruner (`src/context-prune.ts`) keeps only the newest orchestration directive, caps retained progress notes (8), and drops empty custom messages, so the coordinator's requests stay small and well-formed (an unbounded pile of injected user-role messages is a common source of provider `400 invalid_request_error`). Non-custom messages are never touched, so tool_use ↔ tool_result pairing is safe.
- **Watchdogs & failover** — every worker has bounded first-response and idle-progress watchdogs (defaults: 90 s / 120 s). The wall-clock **max-runtime watchdog is disabled by default** (`maxRuntimeSeconds: 0`), so an agent that keeps making progress may run for as long as it needs. All three are configurable in seconds via `/tmg config → Watchdogs` (0 = off) and persisted in `~/.pi/agent/trimegisto/config.json`. Precedence: saved config > `TRIMEGISTO_FIRST_RESPONSE_TIMEOUT_MS` / `TRIMEGISTO_AGENT_IDLE_TIMEOUT_MS` / `TRIMEGISTO_AGENT_MAX_RUNTIME_MS` env vars > built-in defaults. Values are clamped to a safe range so an oversized number can never overflow the timer. A stuck sub-agent is killed and harvested instead of blocking orchestration forever. With `redundantAgents` on, provider failures/no first response can fail over to the next model in the pool. Repeated **model-level** failures additionally trip the per-model circuit breaker (see *Model health* above) so a broken provider can't trigger a retry storm.

### Data layout

```
~/.pi/agent/trimegisto/
├── config.json          # persisted settings (auto-created)
├── instances/
│   └── pid-12345-1719.../   # one dir per running pi instance
│       ├── requests/        # sub-agent spawn requests
│       ├── responses/       # spawn results
│       ├── locks/           # advisory file locks
│       └── notifications/   # context-invalidation events
└── (locks/, notifications/ at the top level for legacy single-instance runs)
```

Orphan instance directories from dead pi processes are cleaned up on every start.

## The Three Tier Skills

The package ships compact `agents/t1.md`, `t2.md`, `t3.md` skills. They teach each tier's role, cost discipline ("T1 plans, T2 solves, T3 executes") and batch-spawn etiquette without adding long prompt payloads.

## Load Footprint

The extension keeps startup lean: `src/index.ts` registers public commands/tools immediately, while command handlers, the dashboard renderer and `/tmg config` UI are lazy-loaded on first use. Runtime strings and tier skill prompts are intentionally compact; keep long explanations in this README, not in loaded prompt/tool metadata.

## Package Structure

```
trimegisto/
├── package.json            # pi manifest: 1 extension + 3 skills, peer deps on pi core
├── config.example.json     # template for ~/.pi/agent/trimegisto/config.json
├── src/
│   ├── index.ts                # startup shell: tool, lifecycle, lazy command/UI hooks
│   ├── agent-manager.ts        # spawn/track/kill, model pools, failover
│   ├── subagent-extension.ts   # injected into every sub-agent process
│   ├── loop-supervisor.ts      # swarm guard: spawn depth, turn limits, redundancy
│   ├── plan-graph.ts           # pre-spawn plan gate: duplicates, deps→waves, lanes, code nodes
│   ├── wave-scheduler.ts       # wave driver: one wave at a time, re-entrancy-safe, iterative
│   ├── diagnostics.ts          # opt-in provider payload/response capture (post-mortem window)
│   ├── reconcile.ts            # deterministic final reconciliation (guaranteed batch conclusion)
│   ├── context-prune.ts        # pure LLM-context pruner (keeps coordinator requests small)
│   ├── model-health.ts         # per-model circuit breaker (pauses spawns on failing models)
│   ├── file-lock.ts            # advisory file locking
│   ├── context-broker.ts       # cross-agent file-change notifications
│   ├── ipc.ts                  # file-based request/response IPC
│   ├── config.ts               # tier config + agent-file discovery
│   ├── speed.ts                # prefill/decode telemetry (token stream, provider-agnostic)
│   ├── dashboard.ts            # lazy TUI widgets: live ↑prefill / ↓decode speeds
│   ├── commands.ts             # lazy /tmg*, /t0..t3, @mention, shortcut handlers
│   ├── config-ui.ts            # lazy /tmg config UI
│   └── types.ts
├── agents/
│   ├── t1.md  t2.md  t3.md     # tier skills
├── test-loop.ts                # swarm-guard unit tests
├── test-config.ts              # config defaults, compaction migration, /tmg config menus
├── test-watchdog.ts            # watchdog config tests
├── test-model-health.ts        # model-health circuit-breaker tests
├── test-speed.ts               # speed-tracker unit tests
├── test-reconcile.ts           # reconciliation + batch-settle guarantee tests
├── test-plan-graph.ts          # plan gate: duplicates, waves, lanes, code nodes
├── test-wave-scheduler.ts      # wave driver: re-entrancy, deferral, stop, deadline
├── test-diagnostics.ts         # payload capture: redaction, ring buffer, opt-in no-op
└── test-context-prune.ts       # LLM-context pruner tests
```

## Development

```bash
git clone https://github.com/noguerol/trimegisto
cd trimegisto
pi install .                 # local-path install
node --experimental-strip-types test-loop.ts      # swarm-guard tests
node --experimental-strip-types test-config.ts    # config/compaction/UI tests
node --experimental-strip-types test-watchdog.ts  # watchdog config tests
node --experimental-strip-types test-model-health.ts # model-health circuit-breaker tests
node --experimental-strip-types test-speed.ts     # speed-tracker tests
node --experimental-strip-types test-reconcile.ts # reconciliation + settle guarantee tests
node --experimental-strip-types test-plan-graph.ts # plan gate tests
node --experimental-strip-types test-wave-scheduler.ts # wave driver tests
node --experimental-strip-types test-diagnostics.ts # payload-capture tests
node --experimental-strip-types test-context-prune.ts # context-pruner tests
```

## License

[MIT](LICENSE) — © Javier Noguerol
