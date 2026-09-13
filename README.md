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

## Usage

### The `trimegisto` tool (LLM-facing)

When Trimegisto is enabled, a hidden orchestration directive is injected before each main-agent turn: decomposable work must be delegated first, and the main agent should keep coordination/synthesis. The main model can delegate work in a single non-blocking call:

```json
{
  "tasks": [
    { "tier": "active", "task": "parse logs.csv and count rows" },
    { "tier": "active", "task": "extract the 10 most common error codes" },
    { "tier": "t2",     "task": "analyze the extracted codes and find root causes" }
  ],
  "cwd": "/path/to/work"
}
```

- `tier` defaults to `active`; max 8 tasks per call (per-tier capacity = `maxParallel`, higher with redundant model pools).
- The tool **returns immediately**; agents run in the background and results are harvested into chat as they complete.
- The tool description always lists which tiers are ENABLED right now — the LLM only spawns those.
- `trimegisto_harvest` returns the current agent snapshot immediately. It never waits; use it instead of sleep/poll loops.

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
└── test-speed.ts               # speed-tracker unit tests
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
```

## License

[MIT](LICENSE) — © trimegisto contributors
