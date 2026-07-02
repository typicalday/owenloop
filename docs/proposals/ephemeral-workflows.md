# Ephemeral workflows — an agent's plan-with-teeth

Status: accepted (explored 2026-07-02). Tooling fixes S2+S3 landed in PR #63,
S4 in PR #64; the S1 skill ships alongside this document as
`skills/owenloop-ephemeral/SKILL.md`.

owenloop today is used for durable defs: written once, run many times. This
proposal makes it cheap and natural for an agent, **mid-task**, to author a
one-time throwaway workflow to structure its own complex work — drive it,
finish, and discard it. The engine becomes the agent's external plan with
teeth: persistent memory between steps, honest invalidation when upstream
changes, reject-with-reasons rework loops, bounded fan-out, and brakes
(`maxAttempts`) so unattended work can't spin forever. A further payoff is
**fresh context per step**: each order carries only `prompt + consumes + owes`,
so every step can run in a clean subagent at full coherence instead of dragging
a long degraded session behind it.

Everything below was validated by actually authoring three throwaway defs and
driving them end to end with the real CLI (fan-out-review, pipeline-with-
knock-back including a stall → `retry`, and gather-distill-solve with a judge),
plus a mid-flight `adopt` and a battery of deliberately broken defs. The
friction log at the end records exactly what was observed.

**Headline conclusion:** the ephemeral path already works with **zero engine
changes**. What's missing is (a) a decision rubric, (b) conventions (dir
layout, driving loop, adopt discipline, cleanup), best delivered as a skill,
and (c) three small **tooling** fixes — error-file attribution, lint parity
with the loader, and a checker flag — none of which touch engine semantics.

---

## 1. The decision rubric: todo list vs ephemeral owenloop

A todo list is free. An ephemeral workflow costs ~10–20 minutes of authoring +
~4 CLI calls per step of driving. It pays for itself only when the engine's
machinery — cascade, reasons, brakes, fan-out — actually gets exercised.

**Use an ephemeral workflow when ≥ 2 of these are true** (checkable, not
vibes):

| # | Signal | Concrete test |
|---|---|---|
| R1 | **Rework loop** | There is a verify/review step that will plausibly send work back with reasons at least once (tests, builds, quality bars). |
| R2 | **Fan-out** | The same operation runs over N items where N is discovered at runtime and N > 3 (call sites, files, sources, tickets). |
| R3 | **Quality gate** | Downstream work must not proceed until an artifact clears a bar you can state as a judge prompt. |
| R4 | **Survival** | The work must outlive this context window / session, or be resumable by a different session. |
| R5 | **Upstream volatility** | An early artifact (plan, diagnosis, scout list) will plausibly be revised after downstream work exists — you want the cascade to invalidate honestly. |
| R6 | **Unattended brakes** | Parts run without a human watching, and a step failing repeatedly must stall rather than loop burning tokens. |

**Never use it when any of these hold:**

- The task is a straight line of ≤ ~5 steps with no plausible rework — a todo
  list (or TaskCreate) wins outright.
- A step is smaller than roughly one coherent agent-turn of work. Steps that
  take 30 seconds each make the tick/green/close overhead dominate.
- You can't yet name the artifacts. If you can't write each step as "consumes
  X, produces Y" in one sitting, you don't understand the task's structure —
  explore inline first, author the workflow after the shape is known. (Partial
  escape hatch: structure discovery *inside* the workflow as a scout step that
  emits a collection — that's R2 — but the step graph itself must be nameable
  up front.)
- The whole task fits comfortably in the current context and nothing will be
  rejected. The engine's value is memory + honesty across boundaries; if there
  are no boundaries, it's ceremony.

Rule of thumb from the experiments: "migrate all call sites of X" (R1+R2+R5)
and "investigate flaky test and fix" (R1+R4, plus R6 if unattended) are solidly
in; "rename this function and update three imports" is solidly out.

---

## 2. The recommended flow, end to end

Zero engine changes; zero code changes. This works today.

### 2.1 Layout — one directory per ephemeral run

```
<scratch-or-project>/.owenloop-eph/<slug>/
  workflow.yaml     # the throwaway def (name: <slug>)
  state.db          # OWENLOOP_DB
  trace.txt         # saved post-mortem (written at the end, §2.5)
```

One def per dir, one dir per run. This is not just tidiness — it is load-time
isolation: `loadDefs` parses **every** file in the defs dir eagerly, and a
single broken def (even a typo'd key) fails *all* loads in that dir, including
`create` of unrelated defs (observed; see friction F3). A shared "ephemeral
defs" dir would let one bad authoring attempt poison every other run. A
dedicated dir also makes cleanup `rm -rf` simple and safe.

Where the dir lives: the session scratchpad for work that dies with the
session; the project (e.g. `.owenloop-eph/`, gitignored) for work that must
survive across sessions (R4) — the def + db *are* the handoff to a future
session.

`:memory:` is for the embedding API only. The CLI is one process per call, so
ephemeral-via-CLI means a throwaway db *file*, which is exactly what you want
anyway for R4 and for crash recovery.

### 2.2 Author

Write `workflow.yaml` from one of the three canonical templates (§4). Keep it
small: 3–6 steps, one seeded input, one declared `outputs:` stem.
Authoring guardrails that matter for an LLM writing YAML on the fly (§5 has
the observed failure modes):

- Start from a template, don't freestyle the grammar. The collection path
  grammar (`x[]` / `x[$i]` / `x[$i].y` / `x[*].y`) is the #1 wiring trap.
- One seeded input only (`seedOwed: true`), provided at `create`. Any *other*
  external fact should enter as a **consumeless intake step** the driver
  greens directly (validated: a step with no `consumes:` is legal and eligible
  immediately) — this keeps the def adopt-safe (§3).
- Schemas on the 1–2 artifacts a downstream step or human actually relies on;
  don't schema everything. Schema-rejects have their own counter and stall.
- `maxAttempts: 2–3` on any step inside a rework loop. That is the brake.
- Prompts (`body:`) should name the verbs the worker must use (`green` /
  `emit`+`seal` / `reject <path>`), because the worker is a fresh-context
  subagent that knows nothing else.

### 2.3 Validate

```sh
export OWENLOOP_DEFS=<dir> OWENLOOP_DB=<dir>/state.db
owenloop lint <slug>          # wiring: dangling consumes, two producers, cycles, dead ends
owenloop defs                 # parse gate: catches what lint silently skips (F4!)
```

Run **both**. `lint` uses a lenient loader that *silently drops* files that
fail to parse (unknown key, bad path grammar) — a def with `maxAttepts:` is
simply absent from `lint`'s output and `lint <slug>` says "unknown workflow
definition", while `create` would die on it. `owenloop defs` uses the strict
loader and surfaces the real parse error. Until F4 is fixed, the pair is the
gate. *(Since fixed — PR #63: `lint` now reports per-file parse failures and
exits 1, so `lint <slug>` alone is the gate.)*

`owenloop check` (the model checker) is **not usable directly** on a def with
`seedOwed: true` inputs: the checker seeds them owed and has no `provide`
transition, so every such def — including the shipped examples — reports a
depth-0 deadlock with all steps dead. Workaround, validated: copy the def to a
temp dir with `sed 's/seedOwed: true/seedOwed: false/'` and check that. For
small ephemeral defs this is usually overkill; lint + load-time validation +
tight `maxAttempts` covered everything the experiments hit. See sugar S4.
*(Since fixed — PR #64: `owenloop check <slug> --assume-provided` replaces the
sed workaround.)*

### 2.4 Create and drive

```sh
wf=$(owenloop create <slug> --provide brief='{...}' | jq -r .workflow)
```

Def-to-first-order is three commands (`lint`, `create`, `tick`) and under a
second of overhead; each CLI call costs ~150 ms.

**The driving loop** (the agent that authored the def is the orchestrator;
owenloop never runs anything):

```
loop:
  out = owenloop tick $wf
  if out.orders is non-empty:
      for each order:                     # sequentially, or genuinely in parallel
          do the work                     #   ideally: hand order.prompt+consumes+owes
                                          #   to a FRESH subagent (the coherence win)
          report: green | emit+seal | reject <path> | skip   (non-zero exit = refused, NOT done)
          close $run [--outcome ...]
      continue
  s = owenloop status $wf
  if s.done:            break             # success — go to §2.5
  if s.debts[].stalled: break             # brakes fired — escalate to human, or replan (§3)
  if s.inFlight:        recover           # a claimed order was dropped (see below)
  if s.blocked only:    provide/fix what it's blocked on
```

Rules learned the hard way:

- **`tick` claims.** The orders are printed once; if you drop the JSON, the
  next `tick` returns `[]` and the job is invisible until its lease expires
  (default TTL **2h**). Recovery: `status.inFlight` / `runs --open` give you
  the run id — you can still `green` against it — or `owenloop reap $wf --now`
  to force the lease stale and re-tick. Convention: **capture tick output to a
  file** in the run dir before acting on it.
- **On resuming a dead session, `reap --now` first.** In the ephemeral
  single-driver case there are no other workers by definition, so force-reaping
  every claim is always safe and beats waiting out a 2h TTL. (This is the
  answer to "agent dies mid-flight": the db survives, the lease is the only
  thing dangling, and one command clears it.)
- **Exit codes are the contract.** `green`/`emit`/`seal` exit non-zero on
  schema-reject or born-rejected. Treat that as "my work was refused", fix,
  re-`green` on the same open run — never `close --outcome ok` after a refusal.
- **Judges drive through the same loop.** A judged commit returns
  `outcome: "submitted"` (exit 0, success); the judge's order arrives on the
  next tick as step `<producer>.<stem>.judges.<name>`; the judge approves with
  `green $wf <judgeRun> <stem>` (no `--value`) or rejects with reasons.
- **Fan-out parallelism is real.** `parallel: N` on a map step yields N orders
  in one tick; each can go to its own subagent concurrently. Reporting is
  safe under the commit CAS.
- `wait --until eligible|done` exists for blocking instead of poll-ticking,
  but in the self-driving case the driver is the only mutator, so it's rarely
  needed (`engine.subscribe` is the embedding-API equivalent; also not needed
  here).

**Stall handling is the payoff of R6.** When `status` shows
`debts[].stalled: true`, `eligible` is empty — the loop has a clean, honest
"stop and think" signal instead of a spin. From there: escalate to the human,
`retry <path> --text "<new guidance>"` (the guidance rides the reason thread
into the next order), or replan the structure via `adopt` (§3). Observed: the
full reject → rework → reject → stall → retry-with-guidance → green cycle
works exactly as documented.

### 2.5 Finish and clean up

What's worth keeping is the **reason threads and timeline**, not the db:

```sh
owenloop trace $wf --format text > trace.txt   # timeline + artifact biographies
owenloop delete $wf                            # or: rm -rf the run dir
```

`trace` was the standout audit surface in the experiments: it shows every run
with what it consumed (at which versions) and every reject with author and
text — a complete post-mortem of *why* the work took the path it took, in a
few dozen lines. Convention: always save `trace.txt` before deleting; for
scratchpad runs, deleting the dir is the cleanup; for project-dir runs, keep
`trace.txt`, delete `state.db`.

Orphan policy: an ephemeral db that was never cleaned up is visible via
`owenloop list` / `status --all` against its dir. Because the layout is
one-dir-per-run, a sweeping policy is trivial (delete run dirs whose mtime is
old and whose status is done); a `dev loop` scanner could do this, but that's
outside owenloop's scope.

---

## 3. Mid-flight replanning (`adopt`) — what works, what to avoid

Stress-tested: started the flaky-test pipeline, drove it into a stall, then
edited the def (added a `fixture_audit` step, rewired `fix` to consume its
output, *and* added a new workflow-level input) and ran `adopt`.

**What works (observed):**

- `status.defDrift` flips true the moment the YAML changes; the instance keeps
  advancing off its pin regardless.
- `adopt` re-pins and settles: the new step's output materialized as a debt
  and the new step was **eligible on the very next tick**. The rewired `fix`
  correctly consumed both its old and new inputs on re-fire.
- Stall counters ride the artifact, so a stalled debt **stays stalled across
  adopt** — replanning doesn't silently un-brake a failing step. (`retry`
  after adopt is the deliberate un-brake, and its `--text` guidance lands in
  the next order.)
- The whole thing is audited: `previousHash` → `defHash` in the adopt result,
  and the def file itself shows the new shape.

**The sharp edge (observed):** `adopt` reconciles the **step graph only**.
Workflow-level `inputs:` are seeded once at `create`; a new input added
mid-flight is not re-requested, and — worse — **cannot be supplied at all**:
`owenloop provide $wf <newInput>` fails with `no such input artifact`. The
input is unreachable for that instance, and any step consuming it is blocked
forever.

**Conventions that make adopt safe:**

1. **Never add `inputs:` in a replan.** New external facts enter as a
   **consumeless intake step** (`produces: [facts]`, no `consumes:`) that the
   driver greens directly. Validated: fires immediately, unblocks consumers,
   and — being a step — is exactly what `adopt` knows how to materialize.
2. Additive replans (new step, new judge, new consume edge on a not-yet-green
   step) are the safe class. Rewiring the inputs of an already-green step
   knocks it back via the fingerprint check — that's the honest cascade doing
   its job, but be aware you're signing up for the re-work.
3. Lint the edited def **before** `adopt` (adopt loads the live def; a broken
   edit fails the adopt, which is safe but wastes a cycle).
4. Don't use adopt to fix a bad *output* — that's `reject`/`retry` with
   reasons. Adopt is for when the *process* was wrong. (Same channel
   discipline as the authoring skill, and it held up in practice.)

---

## 4. The canonical templates (all three validated by real runs)

Three shapes cover essentially every ephemeral use seen or imagined during the
exploration. The skill should ship them as copy-paste templates.

### 4.1 `pipeline` — linear with a verify knock-back

For: investigate-and-fix, produce-and-check, anything R1-shaped.

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

### 4.2 `fan-out-review` — scout, map, reduce-verify

For: migrate-all-call-sites, process-N-files, R2-shaped work with a whole-set
verification at the end.

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

Drive notes (observed): rejecting `scout.site[1].patch` from `verify` re-armed
*only element 1*; the reduce re-fired after the rework with the patched
version (v2) in its fingerprint. Authority for the per-element reject flows
from the reduce's consume edge — no extra wiring needed. An unusable element
is `retract`, not reject (it leaves the reduce's gate entirely).

### 4.3 `gather-distill-solve` — collection in, judged synthesis, act

For: research-then-act, root-cause-then-fix; R3-shaped quality bars that are
criteria (completeness, rigor), not domain review.

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

Drive notes (observed): the producer's green lands `submitted` (exit 0); the
judge order arrives on the next tick as `distill.brief.judges.completeness`;
approval is `green $wf <judgeRun> brief` with no value. `solve` stays blocked
until the ledger completes — the gate is real.

---

## 5. Authoring reliability — where an LLM goes wrong, and what catches it

Observed/probed failure modes, ranked by how well the existing tooling catches
them:

| Failure | Caught by | Quality |
|---|---|---|
| Dangling consume (typo'd artifact name) | `lint` / load | Excellent — names step and stem |
| Two producers for one stem | `lint` / load | Excellent |
| Map over a non-collection (`plan[$i]` with no `plan[]`) | `lint` / load | Excellent |
| Dependency cycle | `lint` / load | Excellent — prints the cycle |
| Dead-end output | `lint` warning | Excellent — suggests all three fixes |
| Unknown key (`maxAttepts:`) | strict load only | **Trap** — `lint` silently omits the file (F4); `defs`/`create` error **doesn't name the file** (F3) |
| Bad path grammar (`x[*].a.b`) | strict load only | Same trap as above |
| Semantic mistakes the grammar permits | nothing static | see below |

The grammar-permitted semantic mistakes the skill must teach (none are
catchable by lint, all were near-misses during authoring):

- **Bare vs suffixed reduce.** `x[*]` fires when *members* are green — it does
  NOT wait for a map's per-element outputs. If a map step produces
  `x[$i].patch`, the fan-in must consume `x[*].patch` or it fires early. This
  is the single most likely silent-wrong-behavior authoring bug.
- **Over-engineering.** Judges for what should be a reviewer step (or vice
  versa), `group:` routing where a linear pipeline does, schemas on every
  artifact, six steps where three do. Ephemeral defs should be boring; the
  three templates are deliberately the whole vocabulary.
- **Sequencing by hand** — adding fake consume edges "so B runs after A"
  instead of consuming what A actually produces.
- **Forgetting the verbs in `body:`.** A fresh-context worker only sees the
  prompt; if it doesn't say "green `x`" / "`emit` then `seal`" / "`reject
  <path>` on failure", the worker won't know the reporting contract.

Load-time validation + `lint` get you ~80% of the way; the templates close
most of the rest; the two tooling gaps (F3, F4) account for the remaining
debugging traps.

---

## 6. Proposed sugar — all zero-engine-change

Bias honored: **no engine changes are proposed at all.** Items are ordered by
value. S1 is the substantive deliverable; S2–S4 are small tooling fixes in
`defs.ts`/`cli.ts` that never touch `model.ts`/`engine.ts`/`store.ts`
semantics.

**S1. Skill: `owenloop-ephemeral` (or an "ephemeral mode" section in
`owenloop-author`). Zero code change.** *(Implemented — see
`skills/owenloop-ephemeral/SKILL.md`, shipped alongside this document.)* The
entire flow is conventions:
the rubric (§1), the dir-per-run layout (§2.1), author→validate→create→drive→
cleanup (§2.2–§2.5), the driving loop with its recovery rules, adopt
discipline (§3), and the three templates (§4) as copy-paste blocks. A separate
skill (rather than growing `owenloop-author`) is recommended because the two
have opposite postures: author is interactive, human-approving, durable-def
producing; ephemeral is autonomous, self-approving, throwaway — an agent
loading the author skill's "present in plain English for approval" step
mid-task would be following the wrong script. Keep the shared mental-model
section by reference, not duplication.

**S2. Name the file in strict-load errors. `defs.ts` only.** *(Implemented —
PR #63.)* Today a parse error (`unknown key 'maxAttepts'`) poisons every load
from that dir with no file attribution (semantic errors do name the file;
parse errors don't). One string-prefix in `loadDefs`'s per-file catch. This is
the cheapest fix with the highest debugging value, and it benefits durable
users equally.

**S3. `lint` parity with the strict loader. `cli.ts`/`defs.ts` only.**
*(Implemented — PR #63.)* `loadDefsRaw`'s silent skip means the advertised
authoring gate can't see the most common LLM authoring errors (typo'd keys,
bad path grammar). `lint` should report per-file parse failures as errors
(file, message) instead of omitting the file. With S2+S3, `lint <slug>`
becomes the single authoring gate and the `defs`-as-second-gate convention in
§2.3 disappears.

**S4. `check --assume-provided`. Checker only (`model.ts` check harness,
not engine semantics).** *(Implemented — PR #64.)* Seeds `seedOwed` inputs
green (exactly what the `sed` workaround does) so the model checker is usable
on real defs. Low urgency for ephemeral use (lint + brakes covered everything
in practice), but today `check` reports a false deadlock on every shipped
example, which undermines trust in the tool generally.

**Considered and NOT proposed:**

- **`owenloop create <file.yaml>` / `run --def -` (create from a path or
  stdin).** CLI-only and tempting, but the dir-per-run convention already
  gives isolation, and a def that exists only in a shell pipe leaves no
  artifact for a future session to resume from — which throws away R4, one of
  the main reasons to use the engine at all. The file-on-disk friction is one
  `mkdir` + one `Write`; not worth a new resolution mode with its own
  edge cases (name-vs-path ambiguity, relative `bodyFile:` resolution).
- **`create --tick` / combined create+first-tick.** Saves one 150 ms call;
  complicates the output contract (create prints `{workflow}`, tick prints
  orders). Not worth it.
- **Auto-delete on done.** Cleanup must stay explicit: the reason threads are
  the post-mortem material, and "done" is exactly when you want to read them.
  The skill's save-trace-then-delete convention covers it.
- **A `--json` def format or programmatic def builder for agents.** The YAML
  is already the agent-friendly surface; templates beat builders.

---

## 7. Friction log (raw observations behind the above)

- **F1 — `tick` claims; dropped output = invisible job.** Second `tick`
  returns `[]`; the run id is recoverable via `status.inFlight` / `runs
  --open`; `reap --now` is the force-release. Default lease TTL is 2h
  (`DEFAULT_REAP_TTL_MS`, engine.ts). Convention fix (capture tick output;
  `reap --now` on resume), no code needed.
- **F2 — `check` false-deadlocks on `seedOwed: true`.** `seedArts` in
  model.ts seeds owed with no provide transition; all shipped examples report
  a depth-0 deadlock, exit 1. `sed`-flip to `seedOwed: false` in a temp copy
  makes the search real (verified: states explored, exit 0). → S4.
- **F3 — one broken def poisons the whole defs dir, parse errors unnamed.**
  `create b6` in a dir containing an unrelated `b2-typokey.yaml` fails with
  `error: steps[0]: unknown key 'maxAttepts'` — no filename, wrong def.
  Semantic errors *do* name the file. → dir-per-run convention + S2.
- **F4 — `lint` and the loader disagree.** `lint` (lenient `loadDefsRaw`)
  silently drops unparseable files; `lint <name>` then claims the def doesn't
  exist while `create` shows the real error. → §2.3 double-gate + S3.
- **F5 — post-adopt inputs are unreachable.** `provide` on an input added
  after `create` fails with `no such input artifact` (§28.4 says "not
  re-requested"; in practice it's "cannot be supplied at all"). → intake-step
  convention (§3). Worth a one-line warning in the `adopt` docs.
- **F6 — everything else just worked.** Per-element reject authority via the
  reduce edge; reason threads riding orders; stall/retry with guidance;
  judge submit/approve flow; adopt materializing new debts instantly; stall
  surviving adopt; consumeless steps; `trace` as post-mortem; ~150 ms/call
  CLI overhead; 3 commands from def to first order.

## 8. Open questions

- **Subagent-per-order vs driver-does-work.** The coherence win argues for
  handing each order to a fresh subagent, but for small steps the spawn cost
  dominates. Likely rubric: subagent when the step is > ~1 turn of work or
  needs isolation; inline otherwise. Needs practice data.
- **Skill packaging.** Separate `owenloop-ephemeral` skill (recommended in S1)
  vs a mode-switch inside `owenloop-author`. If the author skill grows a
  compile-for-myself mode instead, the interview section must be explicitly
  bypassed.
- **Sweeping orphans.** One-dir-per-run makes a "delete done runs older than
  N days" sweep trivial, but who runs it (a `dev loop`, a shell alias, nobody)
  is a host-environment question, not an owenloop one.
- **Does `adopt` deserve a def-diff preview?** A `owenloop adopt --dry-run`
  showing which debts would materialize would make mid-flight replans less of
  a leap of faith. Deliberately not proposed yet — the observed adopt behavior
  was predictable enough that conventions may suffice; revisit after real use.
