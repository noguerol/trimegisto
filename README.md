<div align="center">

![Trimegisto banner](https://raw.githubusercontent.com/noguerol/trimegisto/main/docs/banner.jpeg)

</div>

# Trimegisto — advanced multi-agent management for pi

**Trimegisto is for control freaks.**

Most multi-agent tools hide the machine: they pick the model, plan the swarm, deliver a result. Trimegisto is the opposite — multi-agent management where every parameter of behaviour is yours. Which model runs each tier. How many agents in parallel. When an agent gets warned, when it gets killed, when a batch reconciles. Nothing automatic that you didn't switch on; nothing hidden you can't inspect. If you want software that decides for you, look elsewhere. If you want to know exactly what each of your agents is doing, on which model, and why one stopped — keep reading.

Here's the machine: pi becomes a multi-agent runtime. Every sub-agent is a real, isolated `pi` process (`pi -p --mode json`) with its own context window, tools and model. You — or your main model, if you let it — delegate work; the swarm runs in the background; each batch comes back as **one** final report. It sits beside pi's native UI and never replaces it.

(Loop detection inside a single agent's reasoning lives in the companion [`antiloop`](https://github.com/noguerol/antiloop) extension. Keep it installed; Trimegisto only manages what's cross-process.)

## Tiers

| Tier | Role | Max parallel | Model |
|------|------|--------------|-------|
| **active** (t0) | Default worker, mass-parallel. Always available. | 4 | the same model as your main session, live — even when you switch mid-session with `/model` |
| **t1** | Planning / deep thinking. Reserved for expensive models. | 1 | you assign it |
| **t2** | Hard-problem solver. | 4 | you assign it |
| **t3** | Fast, cheap mechanical work. | 4 | you assign it |

Agent ids are `t` + tier + instance: `t0a`, `t2b`, `t3c`… t1/t2/t3 become usable once you give them a model in `/tmg config`; the tool description always shows the LLM exactly which tiers are enabled right now, so it never tries to spawn what you haven't armed.

## Install

Trimegisto is a [pi package](https://pi.dev/packages): one extension plus three tier skills.

```bash
pi install git:github.com/noguerol/trimegisto    # from GitHub (recommended)
pi install git:github.com/noguerol/trimegisto@v1.0.0  # pinned tag — `pi update` never moves it
pi install /path/to/trimegisto                   # local checkout (development)
pi -e git:github.com/noguerol/trimegisto        # try it for one run, no install

pi list · pi remove git:github.com/noguerol/trimegisto · pi update --extensions
```

> **Security:** pi packages run with full system access. Install only what you trust and review.

You need a working pi with at least one usable model. Sub-agents inherit your providers and API keys — local servers (ollama, vLLM, LM Studio, llama.cpp…) work fine if configured as pi providers.

## Quick start

```
/tmg config                # pick a model per tier, tune the knobs
/t2 fix the failing test in src/parser.ts
@t2b now also cover the empty-input case      # steer a running agent in place
@t2b halt                                     # stop only that agent
@t2b compact                                  # free its context now
"Review the diff, run the tests, summarize risks."   # or just ask — if
                                                 # auto-spawn is on, the main
                                                 # model delegates first
/tmg list · /tmg dashboard · /tmg halt        # watch and control (Ctrl+Alt+H)
```

Results land in the chat as agents finish, with per-agent logs, tokens and cost, and a `✓ n/m done` summary. The main model is explicitly told never to `sleep`/poll waiting for workers — `trimegisto_harvest` gives it an instant snapshot instead.

## Every knob is yours

**Per tier** — model (scrollable picker over your registry), max parallel 1–8, compaction threshold (off, or 50–95% of the context window), redundant-model pools with load-balancing and automatic failover. Each tier can also carry its own agent file (`trimegisto-t2.md`: system prompt, tools, model) in your user or project agents directory. Precedence: saved config > agent file > defaults.

**Orchestration** — `autoSpawn` (the hidden per-turn policy that makes the main model delegate first — off = it only spawns when you tell it), task dedupe before launch, cross-agent output dedupe (flags two agents producing the same answer, with wasted tokens), `spawnOnlyOnActive` to force everything onto t0.

**Limits** — spawn-depth cap (default 5, so agents can't chain forever); turn limit **off by default** (when you enable it: warn at 50 turns, kill at 65 — an agent never dies on turn count because of someone else's default); watchdogs for first response, idle and max runtime, all configurable, runtime kill off so a productive agent runs as long as it needs.

**Auto-purge (reaper)** — finished agents don't pile up forever. When an agent is terminal (`done`/`error`/`killed`), no longer referenced by any live batch, and has been idle for `terminalIdleSeconds` (default 300 s), the reaper frees it: memory, file locks, context tracking, speed telemetry, and its line drops off the dashboard and `/tmg list`. **On by default**; disable or tune the timeout in `/tmg config` → Reaper.

**Failure** — a per-model circuit breaker: two model-level failures in a row pause that model (60 s, doubling to 600 s) so a dead provider can't trigger a spawn storm; it clears on a success, a model change, or `/tmg reset-models`. And when a provider answers `400`, a post-mortem window captures the next requests for 10 minutes — secrets always redacted — so you can finally see what killed the coordinator.

**UI** — dashboard in three modes (compact / full / off): live prefill and decode speeds per agent measured from the token stream, model used per worker, timers that freeze honestly when an agent dies.

All of it is editable in `/tmg config` and persists in `~/.pi/agent/trimegisto/config.json` (template: [config.example.json](config.example.json)); it survives `/new`, `/resume`, `/fork`.

## What a batch guarantees

You delegate in one non-blocking call: a `goal`, and tasks with `tier`, `task`, a `why` (a task that can't name what it serves shouldn't spawn), optional `needs` (data dependencies), `writes` (files it will touch) and `lane` (blast radius). Max 8 per call. Then, deterministically:

- **Nothing runs twice, nothing races.** A pre-launch gate merges duplicate tasks, topologically sorts real `needs` into waves (wave 2 starts when wave 1 is terminal, and the upstream verdict is injected into the dependent), and serialises two agents that want to write the same file.
- **The plan fits the config.** Waves are also capped by each tier's `maxParallel`, so five `t2` tasks against a two-slot config become a 2/2/1 plan instead of a five-wide wave the launcher would have to refuse. Deferring moves wave numbers only; real `needs` edges are never invented.
- **Mechanical work gets flagged, not paid for.** A task that is one pure transformation (count, rename, diff) has one correct answer; the gate says "do it with bash".
- **Irreversible never auto-spawns.** Deploys, drops, force-pushes, credential rotation classify as a `closed` lane and the whole call refuses — the human decides. Wide-but-reversible surfaces (shared utils, public APIs, config) classify as `gated`: flagged with a reason, still launched.
- **One batch, one conclusion.** Every agent's final message is its verdict; when all are terminal — or the batch deadline expires, killed and stuck agents counting as settled — a single final reconciliation is emitted **deterministically, without asking the main model**. It survives the model dying on a provider error. The model then gets exactly one turn to synthesise the answer on top of it.
- **Your context stays clean.** Agent progress and logs go to the TUI only — the main model never sees them, only the reconciliation. That keeps coordinator requests small and well-formed (unbounded injected messages are a classic source of provider `400`s).
- **Verified, or flagged.** Give a task a `verify` command and Trimegisto runs it **after** the worker — itself, not through the worker — and marks a wrong `done` as `VERIFY FAILED`. A confidently-wrong agent can no longer be believed.

Inside a batch, sub-agents can spawn their own workers (`trimegisto_spawn`, batch, non-blocking), coordinate with advisory file locks and stale-file alerts (if agent `t3a` rewrites a file `t2b` read, `t2b` is told to re-read before editing), and publish facts to a shared-context preamble so later agents don't re-derive them.

## Verify, fresh perspectives & the batch ledger

Three opt-in additions, all zero-shot and deterministic (no training, no hidden automation).

**`verify` — verification instead of trust.** Any task may carry `verify: "npm test"` (or `pytest -q`, `go test ./...`, a `bash` one-liner…). When the worker finishes, **Trimegisto** runs the command in the task's `cwd` and records the exit code. Exit `0` → the task is verified; anything else → the reconciliation shows `🚫 VERIFY FAILED` with the command, the exit code and the failing output, the headline counts it as `verify-failed`, and **downstream `needs` edges see the failure instead of a fake success**. The command is chosen by the coordinator, never by the worker, so the worker cannot pick a command that makes it pass (it can still edit project test files — v1 reports, it does not sandbox). Only a worker that itself succeeded is verified; timeout defaults to 120 s (`TRIMEGISTO_VERIFY_TIMEOUT_MS` to change).

**`context: "fresh"` + `diversity: true` — an independent second opinion.** A `fresh` worker is launched **without** the shared-context preamble (no other agents' notes or read-files), so it attacks the task from scratch. Marking it `diversity: true` exempts it from duplicate merging, so it runs **alongside** its ledger-aware twin instead of being deduped away — then the reconciliation lets the main model compare the two. Diversity is capped at 3 per batch, so it can never become a blanket dedup bypass. Use it when a plan may have anchored on a bad early approach.

**The batch ledger.** Every batch writes an inspectable record on disk under the per-instance directory: `<instanceDir>/batches/<batchId>/{plan.md, tasks.json, notes.md}`. `plan.md` is the deterministic plan gate's output plus the goal; `tasks.json` carries each task's status, verify verdict and a bounded conclusion; `notes.md` snapshots the facts the batch's agents published. The reconciliation ends with the ledger path, so the main model (or you) can `read` it. It is a **record, never a source of truth** — every write is best-effort and a read-only disk never breaks a batch — and it is loop-ready: `tasks.json` is exactly the array a future manager-loop would curate. Ledgers are pruned after 24 h and removed with the instance.

## Commands

| | |
|---|---|
| `/t0 … /t3 <task>` | spawn an agent in that tier |
| `/t2b <ins>` or `@t2b <ins>` | steer a running agent **in place** (the instruction is injected into the live run; nothing is killed or respawned) |
| `@t2b halt` · `@t2b compact` | stop only that agent · free that agent's context (since a sub-agent is a one-shot process, this restarts it with a bounded progress digest) |
| `/tmg launch · tell · kill · halt · list · switch · locks` | direct control; **Ctrl+Alt+H** halts everything; `/tmg kill <id>` and `@<id> halt` stop one agent |
| `/tmg dashboard` | cycle compact → full → off |
| `/tmg guard` `/tmg models` | live state of limits and circuit breakers; `reset-guard` / `reset-models` clear them |
| `/tmg enable · disable` | master switch |
| `/tmg config` | the interactive version of everything above |

## How it hangs together

Sub-agents talk to the main extension through file-based IPC under a per-instance directory, so several pi processes running Trimegisto at once never interfere. Orphaned directories clean themselves up at startup. Beyond that, read the source or ask the agent — the behaviour is documented by ~900 regression checks that run with `node --experimental-strip-types test-*.ts`.

## Development

```bash
git clone https://github.com/noguerol/trimegisto && cd trimegisto
pi install .
node --experimental-strip-types test-loop.ts      # …each suite runs standalone; no build step
```

## License

[MIT](LICENSE) — © trimegisto contributors
