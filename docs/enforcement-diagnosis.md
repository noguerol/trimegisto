# Enforcement diagnosis — why the delegation contract is advisory, and what else blocks a batch

- **Date:** 2026-09-24
- **Scope:** `src/index.ts` (read-only), `src/subagent-extension.ts` (read-only), `src/agent-manager.ts` (read-only), `src/task-dedup.ts` (read-only), `src/plan-graph.ts` (read-only), docs from the pi extension API.
- **Constraint:** no source file was modified; the only write is this report.
- **Related plan tasks:** #62 (decision core), #63 (wiring), #64 (wording), #65 (this diagnosis + review).

---

## 1. Root cause: text cannot order two tool calls

The contract is injected in `before_agent_start` (`src/index.ts:2310`) into the **system prompt**
(`src/index.ts:2299`, via `formatDelegationContract` / `formatDecomposabilityNote`). That is the whole
mechanism. It is a sentence the model *may* follow; nothing observes or denies a later tool call.

The only boundary in pi that can deny a call is the `tool_call` event:

> `tool_call` can mutate input or block execution. — `docs/extensions.md:103`

`grep -rn "tool_call\|tool_before\|before_tool" src/` returns **zero matches**. Trimegisto registers no
`tool_call` handler, so there is no code point at which "you must launch the batch first" can become a
constraint. The model complies in chain-of-thought (it read the contract) and then emits `edit`/`write`/
`bash` anyway, because tool ordering is not model-enforced:

> Tool calls from one assistant message can run in parallel. — `docs/extensions.md:112`

So the model can emit `trimegisto` **and** an `edit` in the same assistant message, with no guarantee the
`trimegisto` call executes (or succeeds) before the `edit`. A purely advisory contract loses this race by
construction. **Enforcement must live at the `tool_call` boundary, not in the prompt.**

---

## 2. The launcher path: every check between "model calls `trimegisto`" and "a worker starts"

Numbered in execution order, with `file:line`. A hard gate that clears its state on *any* `trimegisto`
call (instead of on a **successful launch**) will be bypassed by every one of these refusal paths.

| # | Check | Where | Effect |
|---|---|---|---|
| 1 | `config.enabled` | `src/index.ts:1286` | returns `isError:true`, nothing launches |
| 2 | empty / >8 tasks | `src/index.ts:1295`, `:1303` | rejects the batch |
| 3 | per-call dedup drop-all | `src/index.ts:1355` (`isDuplicateTask`), result at `:1371`; window/logic `src/task-dedup.ts:107-146` | **returns success-shaped result with no `isError`**, "No new agents launched" |
| 4 | plan gate tier capacity | `src/plan-graph.ts:578` `enforceTierCapacity`, called at `:1041` | defers/rejects nodes so a wave may fit fewer than declared |
| 5 | feasibility gate (`canSpawnPooled`) | `src/index.ts:532`; helper `src/agent-manager.ts:439-455` | false ⇒ caller must retry |
| 6 | wave launch capacity pre-check | `src/index.ts:517-537` (`launchWave`): `canSpawnPooled` + `inFlight + n > tierCapacity(tier)` | returns `false`, **silently no-ops the wave** (retried on the next sweep) |
| 7 | `tierAvailable` | `src/index.ts:960` (`doLaunch`) | error result (tier disabled / no model) |
| 8 | model required for t1/t2/t3 | `src/index.ts:972` | error result |
| 9 | model circuit breaker | `src/index.ts:982` `getTierModelBlock` | error result (cooldown) |
| 10 | principal-only capacity | `src/index.ts:1002-1030` `spawnCap <= 0` | error result: "`maxParallel is 1 and the main session occupies the only t0 slot`" |
| 11 | `spawnOnlyOnActive` | `src/index.ts:1333` (tool), `:950` (`doLaunch`) | forces every node to `active`; combined with #10 makes a full batch refuse |
| 12 | `sequential:true` bypass | `src/index.ts:953-956`, `:1006` (`&& sequential !== true`), `:521-524` (`launchWave` skips it) | **the only path that ignores the enabled/capacity gates** |
| 13 | nested spawn from a worker | tool registered at `src/subagent-extension.ts:387`; request path `:43-60`; re-check `src/agent-manager.ts:1469` `canSpawnPooled` | worker-driven spawns are capacity- and depth-checked |

`tierCapacity(tier)` itself is `effectiveSpawnCapacity(...)` (`src/index.ts:455-461`), and the ACTIVE tier
subtracts the main session, so with `active.maxParallel = 1` the pool is **0** (`src/agent-manager.ts:428`).

---

## 3. Ranked secondary blockers a hard gate must not regress

**High**

1. **`spawnOnlyOnActive` + `active.maxParallel = 1` refuses the whole batch.** Tool forces every node to
   `active` (`src/index.ts:1333`) → `doLaunch` sees `spawnCap = 0` (`:1006`) → error per node. The only
   escape is `sequential:true` (`:953-956`). A gate that unblocks on "called `trimegisto`" rather than on
   "a worker actually launched" would let a model proceed solo after a batch that never ran.
2. **Dedup drop-all is a success-shaped no-op.** `src/index.ts:1371` returns without `isError`. The gate
   must read `details.tasks.length` (or an explicit launched flag), not mere invocation.
3. **Circuit-breaker / tier-availability refusals** (#7–#9): also return `isError:true`; same rule.

**Medium**

4. **Plan-gate capacity deferral** (`src/plan-graph.ts:1041`): a valid batch can be reduced, so "launched"
   must mean every accepted node launched, or at least one worker.
5. **`launchWave` silent false** (`src/index.ts:517`): a first batch can be accepted but not started until
   a later sweep; gate state must not treat "pending" as "done" forever, nor as failure forever.

**Low**

6. Empty / >8 tasks (#2) and model-block messages (#9) — should still count as *not launched*.

---

## 4. How to test (exact commands)

```bash
cd /home/j/repos/trimegisto
node --experimental-strip-types test-delegation.ts        # contract wording + detector
node --experimental-strip-types test-spawn-gate.ts        # @t0 refusal when t0=1
node --experimental-strip-types test-spawn-capacity.ts    # effectiveSpawnCapacity edges
node --experimental-strip-types test-sequential-active.ts # sequential bypass of enabled/capacity
```

The new gate test (`test-delegation-gate.ts`, wired by #63) should drive the real extension factory the
way `test-spawn-gate.ts` does and assert, for a non-atomic prompt: (a) first `edit` blocked; (b) `read`
allowed; (c) `edit` allowed after a **successful** `trimegisto` call; (d) still blocked after a
`trimegisto` call that returned `isError` or launched zero tasks; (e) allowed for a worker process
(`TRIMEGISTO_AGENT_ID` set); (f) allowed for an atomic prompt.
