---
name: owenloop-ephemeral
description: Author and drive a one-time throwaway owenloop workflow to structure your own complex work mid-task. Use when an agent (you) is facing a task with rework loops, runtime fan-out, quality gates, cross-session survival, or unattended execution — and a todo list isn't enough. You write the def, you validate it, you tick and do every step yourself (ideally in fresh subagents), you save the trace, you delete the run. No human in the loop, no durable def produced. For interactive, human-approved, durable workflows use the owenloop-author skill instead.
---

# owenloop-ephemeral: a plan with teeth, then throw it away

You are both the author and the driver. Mid-task, you write a small throwaway
workflow def, create one instance, drive it to done, keep the trace, and delete
everything. The engine gives your plan teeth: persistent memory between steps,
honest invalidation when upstream changes, reject-with-reasons rework loops,
bounded fan-out, and brakes (`maxAttempts`) so unattended work stalls instead
of spinning. A further payoff is **fresh context per step**: each order carries
only `prompt + consumes + owes`, so every step can run in a clean subagent at
full coherence.

Posture, versus `owenloop-author`: autonomous, self-approving, throwaway. Do
not interview anyone, do not present the def for approval, do not keep the
def afterward. The shared mental model (debts, cascade, path grammar, judges)
is in `docs/design.md`; this skill only adds the ephemeral conventions.

---

## 1. Decide first: todo list or ephemeral workflow?

A todo list is free. An ephemeral workflow costs ~10–20 minutes of authoring
plus ~4 CLI calls per step. **Use it only when ≥ 2 of these are true:**

| # | Signal | Concrete test |
|---|---|---|
| R1 | Rework loop | A verify/review step will plausibly send work back with reasons at least once. |
| R2 | Fan-out | The same operation runs over N items, N discovered at runtime, N > 3. |
| R3 | Quality gate | Downstream work must not proceed until an artifact clears a bar you can state as a judge prompt. |
| R4 | Survival | The work must outlive this context window / session, or be resumable by another session. |
| R5 | Upstream volatility | An early artifact (plan, scout list, diagnosis) will plausibly be revised after downstream work exists. |
| R6 | Unattended brakes | Parts run with no human watching; repeated failure must stall, not loop. |

**Never use it when any of these hold:**

- Straight line of ≤ ~5 steps, no plausible rework → todo list wins outright.
- Steps smaller than one coherent agent-turn — tick/green/close overhead dominates.
- You can't yet write each step as "consumes X, produces Y" in one sitting —
  explore inline first, author after the shape is known. (Runtime *item*
  discovery is fine — that's a scout step emitting a collection — but the step
  graph itself must be nameable up front.)
- Everything fits comfortably in the current context and nothing will be
  rejected. The engine's value is memory + honesty across boundaries.

Rule of thumb: "migrate all call sites of X" (R1+R2+R5) and "investigate flaky
test and fix" (R1+R4) are in; "rename a function and update three imports" is out.

---

## 2. Layout — one directory per run

```
<scratch-or-project>/.owenloop-eph/<slug>/
  workflow.yaml     # the throwaway def (name: <slug>)
  state.db          # OWENLOOP_DB
  tick-*.json       # captured tick outputs (see §4)
  trace.txt         # post-mortem, written at the end (§6)
```

One def per dir, one dir per run — this is load-time isolation, not tidiness:
`loadDefs` parses every file in the defs dir eagerly, so a broken def fails all
loads in that dir, including `create` of unrelated defs. A shared ephemeral
defs dir would let one bad authoring attempt poison every other run.

Where it lives: session scratchpad for work that dies with the session; the
project (gitignored `.owenloop-eph/`) for work that must survive across
sessions (R4) — the def + db *are* the handoff. The CLI is one process per
call, so use a db file, never `:memory:`.

```sh
export OWENLOOP_DEFS=<dir> OWENLOOP_DB=<dir>/state.db
```

---

## 3. Author — start from a template, don't freestyle

Copy one of the three templates in §7 and edit. Keep it boring: 3–6 steps, one
seeded input, one declared `outputs:` stem. The templates are deliberately the
whole vocabulary — if the task doesn't fit one, reconsider §1.

Guardrails (each corresponds to an observed authoring failure):

- **The collection path grammar is the #1 wiring trap.** `x[]` produce,
  `x[$i]` map consume, `x[$i].y` map produce, `x[*].y` suffixed reduce.
  Critically: bare `x[*]` fires when *members* are green — it does NOT wait
  for a map's per-element outputs. If a map produces `x[$i].patch`, the fan-in
  must consume `x[*].patch` or it fires early. This is the most likely
  silent-wrong-behavior bug and nothing static catches it.
- **One seeded input only** (`seedOwed: true`), provided at `create`. Any
  other external fact enters as a **consumeless intake step** (`produces:
  [facts]`, no `consumes:`) that you green directly — legal, eligible
  immediately, and adopt-safe (§5).
- **Schemas only on the 1–2 artifacts something downstream actually relies
  on.** Schema-rejects have their own counter and stall.
- **`maxAttempts: 2–3` on any step inside a rework loop.** That is the brake
  (R6). Without it an unattended loop burns tokens forever.
- **Name the verbs in every `body:`.** The worker is a fresh-context subagent
  that sees only the prompt: say "green `x`", "`emit` one element per …, then
  `seal`", "`reject <path> --by <step>` with the failure". If the prompt
  doesn't state the reporting contract, the worker won't know it.
- Don't hand-sequence with fake consume edges; consume what the upstream step
  actually produces. Don't add judges where a reviewer step does (judges are
  for criteria bars — completeness, rigor; a reviewer step is for domain
  review that produces its own artifact).

---

## 4. Validate, create, drive

```sh
owenloop lint <slug>                      # single gate: parse + wiring; exit 1 on any error
owenloop check <slug> --assume-provided   # optional, for defs with tricky wiring
wf=$(owenloop create <slug> --provide brief='{...}' | jq -r .workflow)
```

`lint` reports both wiring errors and files that fail to parse (with file and
message), and exits non-zero on either — it is a truthful preflight for
`create`. `check --assume-provided` runs the bounded model checker with seeded
inputs treated as provided (without the flag, any `seedOwed: true` def reports
a false depth-0 deadlock). For small template-shaped defs, lint + brakes are
usually enough; reach for `check` when you've deviated from the templates.

**The driving loop** — you are the orchestrator; owenloop never runs anything:

```
loop:
  out = owenloop tick $wf        # CAPTURE THIS to tick-<n>.json before acting
  if out.orders non-empty:
      for each order:            # sequentially, or genuinely in parallel
          do the work            # ideally in a FRESH subagent: prompt + consumes + owes
          report: green | emit…seal | reject <path> | skip
          close $run [--outcome ...]
      continue
  s = owenloop status $wf
  if s.done:            break    # success → §6
  if s.debts[].stalled: break    # brakes fired → stall handling below
  if s.inFlight:        recover  # dropped order — see below
  if s.blocked only:    provide/green what it's blocked on
```

Rules learned the hard way:

- **`tick` claims.** Orders print once; drop the JSON and the next tick
  returns `[]` while the job sits invisible behind a 2h lease. Always capture
  tick output to a file first. Recovery: `status.inFlight` / `runs --open`
  give the run id (you can still `green` against it), or `owenloop reap $wf
  --now` to force the lease stale and re-tick.
- **On resuming a dead session, `reap --now` first.** Single-driver means no
  other workers exist, so force-reaping every claim is always safe and beats
  waiting out the TTL. The db survives the crash; the lease is the only thing
  dangling.
- **Exit codes are the contract.** `green`/`emit`/`seal` exit non-zero on
  schema-reject or born-rejected: that means "my work was refused". Fix and
  re-`green` on the same open run. Never `close --outcome ok` after a refusal.
- **Judges drive through the same loop.** A judged green lands `submitted`
  (exit 0); the judge's order arrives on the next tick as
  `<producer>.<stem>.judges.<name>`; approve with `green $wf <judgeRun>
  <stem>` (no `--value`) or reject with reasons.
- **Fan-out parallelism is real.** `parallel: N` on a map step yields N orders
  in one tick; each can go to its own subagent concurrently; reporting is safe
  under the commit CAS.

**Stall handling is the payoff of R6.** `debts[].stalled: true` with empty
`eligible` is the honest "stop and think" signal. From there, exactly three
moves: escalate to the human; `retry <path> --text "<new guidance>"` (the
guidance rides the reason thread into the next order); or replan the structure
via `adopt` (§5). Reject/retry is for a bad *output*; adopt is for a wrong
*process* — don't cross the channels.

---

## 5. Mid-flight replanning (`adopt`)

Edit `workflow.yaml`, `owenloop lint <slug>`, then `owenloop adopt $wf`. The
instance re-pins to the new def; new step debts materialize immediately (a new
step can be eligible on the very next tick); stalled debts **stay stalled**
across adopt (`retry` is the deliberate un-brake).

**The sharp edge: `adopt` reconciles the step graph only.** Workflow-level
`inputs:` are seeded once at `create`. An input added mid-flight is not
re-requested and **cannot be supplied at all** — `provide` fails with `no such
input artifact`, and any step consuming it is blocked forever.

Conventions that keep adopt safe:

1. **Never add `inputs:` in a replan.** New external facts enter as a
   consumeless intake step you green directly — being a step, it is exactly
   what adopt knows how to materialize.
2. Additive replans (new step, new judge, new consume edge on a not-yet-green
   step) are the safe class. Rewiring an already-green step's inputs knocks it
   back via the fingerprint — honest cascade, but you're signing up for rework.
3. Lint before adopt (a broken edit fails the adopt — safe, but a wasted cycle).
4. Bad output → `reject`/`retry`. Wrong process → `adopt`. Never adopt to
   dodge a reject.

---

## 6. Finish and clean up

What's worth keeping is the reason threads and timeline, not the db:

```sh
owenloop trace $wf --format text > trace.txt   # timeline + artifact biographies
owenloop delete $wf                            # then rm -rf the run dir (scratchpad)
```

`trace` shows every run with what it consumed at which versions and every
reject with author and text — the complete post-mortem in a few dozen lines.
Always save `trace.txt` before deleting. Scratchpad runs: delete the dir.
Project-dir runs: keep `trace.txt`, delete `state.db`. Cleanup stays explicit —
"done" is exactly when the reason threads are worth reading, so nothing
auto-deletes.

---

## 7. The three templates (all validated by real runs)

### 7.1 `pipeline` — linear with a verify knock-back (R1)

```yaml
name: <slug>
outputs: [verdict]
inputs:
  - name: ticket
    seedOwed: true
steps:
  - name: reproduce
    consumes: [ticket]
    produces:
      - name: repro
        schema: { type: object, required: [command, failure_rate] }
    body: |
      Reproduce the problem in `ticket`. Green `repro` with {command, failure_rate}.
  - name: diagnose
    consumes: [repro]
    produces: [diagnosis]
    body: |
      Find the root cause from `repro`. Green `diagnosis` with {cause, evidence, fix_sketch}.
  - name: fix
    consumes: [diagnosis]
    produces: [patch]
    maxAttempts: 2            # the brake on the rework loop
    body: |
      Implement `diagnosis`. Green `patch` with {diff}. If `patch` carries
      reject reasons, address them before re-greening.
  - name: verify
    consumes: [patch]
    produces: [verdict]
    body: |
      Verify the fix. If it fails, `reject patch --by verify` with the output.
      Otherwise green `verdict`.
```

Drive notes: reject twice → `patch` stalls, `eligible` empties; `retry patch
--text "<guidance>"` re-arms with the guidance in the reason thread.

### 7.2 `fan-out-review` — scout, map, reduce-verify (R2)

```yaml
name: <slug>
outputs: [report]
inputs:
  - name: brief
    seedOwed: true
    schema: { type: object, required: [old_api, new_api] }
steps:
  - name: scout
    consumes: [brief]
    produces: ["scout.site[]"]
    body: |
      Find every occurrence. `emit` one element per site ({file, line, snippet}),
      then `seal`.
  - name: migrate
    consumes: ["scout.site[$i]"]
    produces: ["scout.site[$i].patch"]
    parallel: 4
    maxAttempts: 3
    body: |
      Element ${INDEX}: rewrite this one site. Green `.patch` with {file, diff}.
      Address any reject reasons riding on `.patch`.
  - name: verify
    consumes: ["scout.site[*].patch"]     # suffixed reduce: waits for every survivor's patch
    produces: [report]
    body: |
      All patches are in. Build + test the combined change. If one patch is wrong,
      `reject scout.site[<i>].patch --by verify` with the failure — only that
      element re-arms. Otherwise green `report`.
```

Drive notes: rejecting `scout.site[1].patch` from `verify` re-arms only
element 1; the reduce re-fires with the reworked version in its fingerprint.
Per-element reject authority flows from the reduce's consume edge — no extra
wiring. An element that turns out not to apply is `retract`, not reject (it
leaves the reduce's gate entirely).

### 7.3 `gather-distill-solve` — collection in, judged synthesis, act (R3)

```yaml
name: <slug>
outputs: [solution]
inputs:
  - name: incident
    seedOwed: true
steps:
  - name: gather
    consumes: [incident]
    produces: ["gather.evidence[]"]
    body: |
      Collect evidence. `emit` one element per finding, then `seal`.
  - name: distill
    consumes: ["gather.evidence[*]"]      # bare reduce: gates on members only
    produces:
      - name: brief
        judges:
          - name: completeness
            body: |
              Check `brief`: explains every evidence item, names one root cause,
              cites indices. Reject with the gaps, else approve.
    body: |
      Reduce the evidence into `brief`: {root_cause, supporting_evidence}.
  - name: solve
    consumes: [brief]
    produces: [solution]
    body: |
      Fix brief.root_cause. Green `solution`.
```

Drive notes: the producer's green lands `submitted` (exit 0); the judge order
arrives on the next tick as `distill.brief.judges.completeness`; approve with
`green $wf <judgeRun> brief` (no value). `solve` stays blocked until the
ledger completes — the gate is real.

---

Every convention here was validated by authoring throwaway defs and driving
them end to end with the real CLI (fan-out review, pipeline-with-knock-back
including a stall → `retry`, and gather-distill-solve with a judge). It builds
only on already-shipped engine features — no engine changes are required.
