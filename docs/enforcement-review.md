# Independent adversarial review — proposed hard `tool_call` gate

- **Date:** 2026-09-24
- **Reviewer stance:** adversarial. The design under review: for a **non-atomic** request, the **first**
  `edit`, `write`, or **mutating** `bash` call is **blocked** (error) until the model has called
  `trimegisto` at least once; `read`/`grep`/`find`/`ls` stay open so the batch can be planned; if the model
  never launches, `agent_before_settle` nudges it to launch before settling; a worker guard exempts
  spawned sub-agents.
- **Constraint:** no source file was modified. Grounded in `src/delegation.ts`, `src/index.ts`,
  `src/subagent-extension.ts`, `src/agent-manager.ts`, `docs/extensions.md` (pi).

Verdict: **the design is sound in shape but incomplete.** It blocks the common silent-solo path, but it
must be defined in terms of a *successful launch*, not a *tool invocation*, and it must classify `bash`
deterministically. Findings are ranked; each has a `file:line` anchor.

---

## 1. Bypasses

### 1.1 HIGH — "called `trimegisto`" ≠ "launched a worker"

`trimegisto.execute` has several refusal paths that still return as ordinary results:
`config.enabled` (`src/index.ts:1286`), empty/>8 tasks (`:1295`,`:1303`), **dedup drop-all returns a
success-shaped result with no `isError`** (`:1371`), and every `doLaunch` error (`:960`,`:972`,`:982`,
`:1006`). If the gate clears on invocation, a model can call the tool once, get "No new agents launched",
and edit freely — the exact behaviour the gate exists to stop.
**Fix:** clear the gate only when `details.tasks.length > 0` **and** at least one agent registered (not
`isError`). See `docs/enforcement-diagnosis.md` §3.

### 1.2 HIGH — `bash` mutation classification is a parser, not a sandbox

`bash` is one tool; the gate must decide per command. Anything that defaults to "read-only" is a bypass:
`sed -i`, `tee`, `>`/`>>`, `rm`, `mv`, `cp`, `patch`, `git commit|push|reset`, `npm install`, `node -e "…"`,
`python -c "…"`, `chmod`, `mkdir`, `truncate`, `curl -o`, `dd`. Conversely, blocking *all* bash produces
false positives for `grep`, `cat`, `ls`, `git diff/status`, `npm test`.
**Fix:** allowlist read-only prefixes and treat everything else as mutating; document that this is a
**nudge**, not a security boundary (a model can always embed a mutation in an allowlisted shape). Never
claim sandbox semantics.

### 1.3 HIGH — parallel tool calls in one assistant message

> Tool calls from one assistant message can run in parallel. — `docs/extensions.md:112`

If the model emits `trimegisto` **and** `edit` in the same message, there is no guaranteed ordering: the
`edit` handler can run before the tool's `execute`. Two acceptable behaviours: (a) block the `edit` for
this turn — the retry happens in the next assistant message, by which time the `trimegisto` call has
executed; or (b) require the `trimegisto` call to be the *first* tool in the message. **Test both.**

### 1.4 MED — gate state lifetime

The gate is per main session/run. It must **reset on `before_agent_start`** (new user prompt) unless a
batch is pending, otherwise one early `trimegisto` call unblocks the session forever. It must also be
idempotent across retries/compaction (pi can re-enter a turn after recovery, `docs/compaction.md:98`).

### 1.5 MED — worker guard placement

The gate must never apply to spawned sub-agents: they exist to edit files. The main extension's
`tool_call` handler does not run inside the worker process (`src/subagent-extension.ts` is a separate pi
instance, `:32-60`), so the safe rule is "apply only when `TRIMEGISTO_AGENT_ID` is unset / role is main".
If the decision core is shared, default the worker flag to **off (gated)** only for the main session and
assert the exemption in a test.

---

## 2. False positives (blocking legitimate ATOMIC work)

`analyzeDecomposability` (`src/delegation.ts:131`) uses a threshold of 3 with coarse weights. Several
genuinely atomic requests score ≥ 3: e.g. `fix the typo in src/a.ts and run the tests` = 1 file (+1) +
2 verbs (+1) + coordinated clause (+1) = **3 ⇒ "decomposable" ⇒ blocked**. That is the intended reading of
the contract, but it will block a single one-line fix.
**Fix:** keep the atomic escape hatch explicit in the message the user sees, and let the model satisfy the
gate with any successful launch (not necessarily a *large* batch). Consider raising the coordinated-clause
weight or requiring ≥2 files for the hard block. **Any change here must keep `test-delegation.ts` green
(51/0 today).**

---

## 3. Ordering / race issues

- The gate needs the prompt analysis computed in `before_agent_start` (`src/index.ts:2310`, note built at
  `:2299`). Cache it on a session-scoped variable; do **not** recompute from the last user message in
  `tool_call` (compaction/omission can change it).
- The `trimegisto` tool call and the blocked mutation can be in the same batch (§1.3). Decide and test.
- `agent_before_settle` can request **one** continuation (`docs/extensions.md:66,109`). The nudge must be
  guarded by a "nudged this run" flag, or an unconditional `continue:true` loops.
- Do not clear the gate from `tool_result`: a failed result still reaches `tool_result`.

---

## 4. Interaction with the existing spawn gate and `sequential`

- `sequential:true` is the only path that ignores `enabled`/capacity (`src/index.ts:953-956`,`:1006`,
  `:521-524`). A successful sequential launch must count as "launched".
- `spawnOnlyOnActive` + `active.maxParallel = 1` refuses every non-sequential node
  (`src/index.ts:1333` → `:1006`). In that config the gate would block `edit`, the tool call would refuse,
  and the run would deadlock in "blocked, nothing launches". **The gate must fall back to the atomic
  escape hatch (or nudge a `sequential:true` launch) rather than hard-blocking when capacity is provably
  zero.** This is the highest-risk interaction.
- The existing spawn gate tests must stay green: `test-spawn-gate.ts`, `test-spawn-capacity.ts`,
  `test-sequential-active.ts`.

---

## 5. Minimal test matrix (severity of a missing case in brackets)

| # | Scenario | Expected | Priority |
|---|---|---|---|
| 1 | non-atomic prompt, first tool = `edit` | blocked error [HIGH] | P0 |
| 2 | non-atomic prompt, `read`/`grep`/`find`/`ls` | allowed | P0 |
| 3 | non-atomic prompt, successful `trimegisto` then `edit` | allowed | P0 |
| 4 | `trimegisto` returns `isError` / 0 tasks, then `edit` | still blocked [HIGH] | P0 |
| 5 | atomic prompt ("fix the typo"), first tool = `edit` | allowed | P0 |
| 6 | worker process (`TRIMEGISTO_AGENT_ID` set), `edit` | allowed | P0 |
| 7 | same-message `trimegisto` + `edit` | `edit` blocked; next turn allowed [HIGH] | P1 |
| 8 | never launches, reaches `agent_before_settle` | exactly one nudge | P1 |
| 9 | `sequential:true` launch succeeds | gate cleared | P1 |
| 10 | `spawnOnlyOnActive` + `active.maxParallel=1` | no deadlock: atomic/sequential path | P0 |

Commands: `node --experimental-strip-types test/test-delegation-gate.ts` (new, #63), plus the existing
`test/test-delegation.ts`, `test/test-spawn-gate.ts`, `test/test-spawn-capacity.ts`, `test/test-sequential-active.ts`.

---

## 6. Summary of concrete recommendations

1. Gate clears on **successful launch**, never on invocation (P0).
2. Deterministic `bash` read-only allowlist; label the gate a nudge, not a sandbox (P0).
3. Handle same-message ordering explicitly and test it (P0).
4. Exempt workers by role env, with a test (P0).
5. Never hard-block when capacity is provably zero (`spawnOnlyOnActive`+t0=1) — use the atomic/sequential
   escape hatch (P0).
6. Reset per run; guard the settle nudge to one continuation (P1).
