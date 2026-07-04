# owenloop — design

A self-contained distillation of the dataflow-workflow-engine spec, restricted to
what the engine actually implements. The `§N` markers match the references in the
source (e.g. `model.ts` cites `§6`, `engine.ts` cites `§12`). Read it once and the
code reads as a transcription of these rules.

## §1 The inversion

A step has no status. It has **debts**. A step is eligible to run because of the
*state of its artifacts*, never because an orchestrator marked it ready. The
scheduler is therefore a pure function `state → eligible firings`; everything
else (knock-backs, fan-in, downstream invalidation) is a consequence of that
function rather than a feature bolted beside it.

## §2 Nodes

- **§2.1 Artifact** — a named value a step produces and others consume. Carries an
  `acceptance` state, a monotonic `version` (0 until first green, +1 each green
  re-production), an optional captured `value` (a handle, meaningful only when
  green), a `fingerprint` (the versions of its inputs at build time), an
  append-only `reasons` thread, and two stall counters — `judgmentRejects` (§6)
  and `schemaRejects` (§19).
- **§2.2 Task / lease** — the claimable unit of work-in-flight. One per
  `(step, key)`; `key` is `""` for plain/reduce/collection firings and the
  element path for a map firing.
- **§2.3 Run** — the audit/budget record created when a task is claimed; holds the
  claim's input **fingerprint** for the commit CAS.

## §3 The firing rule

A step's eligibility depends on its consume mode:

- **plain** `x` — eligible when it owes an output and every plain input is green.
- **map** `src[$i]` — one independent firing per collection element; the firing
  for element *i* is eligible when `src[i]` is green and the per-element output
  `src[i].…` is a debt. Concurrency is capped by the step's `parallel`.
- **reduce** `src[*]` — a single firing, eligible only when the collection's
  **seal** is green **and** every non-retracted bare member is green. It gates on
  the *members*, not on any per-element map output — so a map and a reduce over
  the same collection are concurrent branches, and the reduce's lever over a bad
  element is `retract`, not a verdict.

## §4 Reason threads

Every invalidating action (`reject`, `schema-reject`, `retract`, `skip`,
`reopen`, `retry`, `born-rejected`) appends a
`ReasonEntry { at, action, kind, by, text, fromVersion }`
to the artifact. The thread is append-only and travels with the artifact, so the
next order to (re)produce it carries the full feedback history in `owes[].reasons`.

### §4.1 Invalidation authority

A `reject` is an exercise of authority, and authority follows the consume edge:
**only a step that consumes an artifact's stem (or a human/engine) may
judgment-reject it** (`assertAuthority`). A step cannot dirty an artifact it has no
relationship with — this keeps a many-step graph's feedback aligned with its
dataflow, and it is a one-line rule.

The consequence for *authoring* is that `consumes` is **dual-purpose**. It declares a
step's inputs (the firing gate and fingerprint, §3/§7) **and** the set of artifacts
the step may send back. So to give a step the power to invalidate an artifact, make
it consume that artifact — *even when the step only judges the artifact rather than
transforming it*. The merger consuming `pr` is the canonical case: it lands the PR
and judges its mergeability, so a merge conflict is a legitimate judgment-`reject` of
`pr`, and the authority to issue it comes from the consume edge. A consume edge
declared only for authority is harmless to the firing rule: an input that is always
green by the time the step fires (because it is upstream of the step's other inputs)
never changes when the step becomes eligible.

This governs *judgment* rejects only. The engine's own **structural** re-arm when a
consumed input moves version (§7) is mechanical propagation, not a judgment, and is
performed by the engine without an authority check.

## §5 Lifecycle states

The six `acceptance` states (§11.3) partition into:

- **debt** = `{ owed, rejected }` — a producer owes work.
- **settled** = `{ green, retracted, skipped }` — never reads as "stuck".
- **outstanding** = debt ∪ `{ submitted }` — not a producer's debt, but not done
  either (§24). Used for completion checks; `submitted` is not itself a debt
  state, since the producer already discharged its half of the work.

`owed` is declared-but-unbuilt or re-armed. `green` is accepted. `rejected` is
built-then-judged-unfit (or structurally re-armed). `retracted` is a consumer
dropping a collection member — **terminal**, leaves the `[*]` set. `skipped` is a
producer declining its own output on a dead branch — settled but re-armable if
its inputs revive.

## §6 Liveness — stalls

Three reject **kinds** (§11.9) are tracked:

- **judgment** — a consumer's verdict that the artifact is wrong. Bumps
  `judgmentRejects`.
- **validation** — a produced value failed the artifact's declared JSON Schema;
  the engine refused the commit (§19). Bumps a *separate* `schemaRejects`
  counter.
- **structural** — engine bookkeeping (a forward-cascade re-arm, a born-rejected
  commit). Bumps **neither** counter.
- **invalidated-irreversible** — the artifact was rejected-and-held because its
  inputs moved and its producer declared `effect: { idempotent: false, onInvalidate: 'escalate' }` (§20). The producer does not auto-re-fire; a human must intervene.

A counter rides on the *judged artifact*. Once `judgmentRejects ≥ maxAttempts`
(or `schemaRejects ≥ maxSchemaFailures`, §19) the artifact is **stalled**: it
remains a debt, but `eligibleFirings` stops producing any firing that would
rebuild it. The step has demonstrably failed; a human must intervene.
`isStalled(a, cap)` and `isSchemaStalled(a, cap)` are the predicates;
`status.debts[].stalled` surfaces either; `blocked` deliberately excludes a
stalled step (it isn't waiting on an input — it's out of attempts).

`maxAttempts` (and `maxSchemaFailures`, §19) is set on the *step* and applies
to every one of its produces as a **default**. A `{name, ...}` produce entry
may override either cap for itself — `maxAttempts:` / `maxSchemaFailures:` on
the produce, not the step — when one output needs a tighter or looser bound
than its siblings (`group:` produce entries carry no such override; they
aren't a `{name, ...}` produce and always defer to the step). `cap` in
`isStalled`/`isSchemaStalled` above is resolved per-artifact by
`effectiveMaxAttempts()` / `effectiveMaxSchemaFailures()` (model.ts):
`produce?.maxAttempts ?? step.maxAttempts`, so an explicit `0` on the produce
is honored rather than falling through to the step default — only an
*absent* override inherits.

Held artifacts (`isHeld`, §20) also surface as `stalled: true` in
`workflowStatus.debts`. A held step is not waiting on an input — it fired an
irreversible side effect and must not silently re-fire; a human must `retry` or
fix the upstream cause.

A `reject()` (judgment verdict) requires the target to already be a *built*
version — `green` or `submitted` — and refuses otherwise (a thrown Error): an
`owed` artifact has no build to render a verdict on (rejecting it would burn a
`judgmentRejects` toward the cap above with zero build attempts, a silent
freeze), and a `retracted` collection member is terminal (§11.3) — no firing
shape can ever rebuild it, so flipping it back to a live `rejected` debt would
wedge the instance.

Clearing a stall:
- **`retry`** — reset *both* counters to 0 and re-owe the artifact (optionally
  with fresh guidance appended as a `retry` reason). The only path that resets
  the counters. Also clears the held condition: a `retry` appends a `'retry'`
  reason entry, so the last entry's `kind` is no longer `'invalidated-irreversible'`
  and `isHeld` returns false. Requires the same consume-edge authority as
  `reject`/`retract` (§4.1), and refuses a `retracted` target — retract is
  final, and a bare collection element has no producer firing that could ever
  rebuild it.
- **`retract`** — drop the member (collection elements), terminally. Requires
  the same consume-edge authority as `reject` (§4.1): only a step that
  consumes the member's stem (or human/engine) may retract it.

## §7 The forward cascade (level-triggered)

A green output is green **only while** every input it consumed is still green and
unmoved. After any mutation, `settle()`:

1. **materializes** owed outputs of fired steps, and
2. runs the cascade to a fixpoint — any green artifact whose fingerprint no longer
   matches its inputs' current versions (an input moved, or went non-green) falls
   back to a **structural** `rejected` (a re-arm), which itself may invalidate
   *its* dependents. Skips propagate to plain dependents; a skipped branch
   re-arms when its inputs revive; a retracted element tombstones its map child.

Because it is level-triggered (a function of current state) rather than
edge-triggered (reacting to the change event), the cascade is idempotent and
order-independent — re-running `settle()` on a healthy graph yields no ops.

## §11 Collections

- **§11.1 produce `src[]`** — the producer `emit`s an unknown number of bare
  elements (`src[0]`, `src[1]`, …), then `seal`s. The seal is itself an artifact
  (`sealOf = src`); the collection is "complete" when the seal is green.
- **§11.2 map `src[$i]`** — fan-out: one firing per element, `${INDEX}` bound.
- **§11.x reduce `src[*]`** — fan-in: see §3.
- **§11.x reduce with suffix `src[*].child`** — fan-in one level deeper: the
  gate is the seal green AND every surviving member's `.child` artifact
  green (not the bare member). Typically fans in over a map step's
  per-element output (`src[$i].child`). Resting inputs / cascade: the
  firing (and the reduce output's fingerprint) rest on the child paths, not
  the bare members — a child rejected or re-greened after the reduce fired
  knocks it back via the ordinary §11.8 forward cascade, no special-case
  machinery. One suffix level only (`src[*].a.b` is a parse error). Bare
  `src[*]` is unchanged (suffix is empty).
- **§11.3** — the six-state lifecycle (above).
- **§11.8** — the forward cascade (above).
- **§11.9** — the three reject kinds (above): judgment, validation (§19), structural.

## §12 Concurrency

- **§12.1 versions** — each artifact carries a monotonic version; a green bumps it.
- **§12.2 commit-fingerprint CAS** — when a run is claimed it records the version
  of every input it consumed (its `fingerprint`). At commit time the engine
  re-reads those inputs; if any moved or is no longer green, the commit is
  **born-rejected** (a structural reject with a `born-rejected` reason) instead of
  landing a green that already rests on stale inputs. This makes concurrent
  advancement safe without locking the graph: two workers can race, and at most
  one lands green; the loser is re-armed with an honest reason.
- **§12.3 Daily-budget windows are host-local** — `maxRunsPerDay` gates
  against a window starting at host-local midnight (`localMidnightMs` in
  util.ts), not UTC midnight. Two consequences worth knowing: (1) the day
  containing a DST transition is 23h or 25h, so a budget can reset
  slightly early/late that day; (2) if multiple hosts in different
  timezones drive the same store, they disagree on what "today" is and
  can therefore disagree on maxRunsPerDay accounting for the same step.
  Neither is currently a problem this project commits to solving — there
  is no documented multi-timezone deployment target — but if one emerges,
  switch to UTC midnight and update this note.

## §15 Completion

- **§15.1** — a workflow is `done` when no artifact is in a debt state.
- **§15.2 destructive completion** — a step marked `terminal: true` produces an
  output whose green is irreversible (a merge, a publish). Once green it is never
  re-armed by the forward cascade, even if an upstream input later moves. This is
  the one place the level-trigger is deliberately overridden, because the side
  effect cannot be taken back. See §20 for `effect:`, the forward spelling for
  this contract that adds the `escalate` routing option and finer-grained control.

## §16 Generated outputs (`generates:`)

A step may declare outputs it intentionally makes without any downstream consumer — audit
logs, external exports, dev-branch stubs — under `generates:`. The behavioral contract:

- **To the engine:** generated patterns are unioned into `produces` at def-build time.
  Every engine function (`pendingOwed`, `eligibleFirings`, `plainOutputs`, `buildTrace`,
  `buildGraph`, schema validation, the one-writer rule) treats them identically to
  declared-in-produces patterns. A generated artifact is schema-validated, fingerprinted,
  greenable, and visible in `status`/`show`/`trace`/`graph` — indistinguishable from a
  produced one.
- **To the linter only:** `deadEndWarnings` skips stems declared in `generates:`. A stem
  in `produces:` (not `generates:`) that nothing consumes still warns. The `generates:`
  field is the *only* place the engine consults to decide lint exemption.
- **`terminal:` vs `generates:`:** `terminal: true` marks a whole step as an intended
  sink and suppresses ALL dead-end warnings for it. `generates:` is more granular — it
  exempts specific output stems while leaving other outputs on the same step subject to the
  normal dead-end check.
- **Validation:** a stem listed in both `produces:` and `generates:` on the same step is a
  hard error. Two steps generating the same stem is a one-writer error (the same rule that
  applies to `produces:`).

## §17 Workflow outputs (`outputs:`)

A workflow may declare its public output stems — the leaves it intentionally produces as
its embedding interface — under a top-level `outputs:` field.

- **Lint exemption:** stems listed in `outputs:` are exempt from `deadEndWarnings`, as a
  third exemption alongside `terminal:` (step-level) and `generates:` (step-level). A
  declared public output is self-evidently an intentional leaf.
- **Re-armability:** unlike `terminal: true`, listing a stem in `outputs:` does NOT freeze
  re-arm. The cascade may re-arm an `outputs:`-listed artifact if its upstream inputs move.
- **Validation:** `validateDef` hard-errors if any `outputs:` entry names a stem that no
  step produces. Stems declared under `generates:` are unioned into `produces` at build
  time and therefore count as produced — naming them in `outputs:` is valid.
- **Composition boundary:** `outputs:` is the boundary contract for workflow composition
  (`include:` §22 / `calls:` §23) — a called or included workflow's declared public output
  is the artifact its parent consumes.

Relationship of the three exemption mechanisms:

| key | level | lint-exempt | re-armable | primary purpose |
|---|---|---|---|---|
| `terminal: true` | step | yes | no | destructive completion; green never re-armed |
| `generates:` | step | yes | yes | internal intentional sink, not the public interface |
| `outputs:` | workflow | yes | yes | public interface / composition boundary |

## §18 Derived status

`workflowStatus` is computed from artifact state on every call and never stored:

- `done` — no debts remain.
- `debts[]` — each non-green-owing artifact with its `acceptance`, `kind`
  (`judgment` / `validation` / `structural` / `unbuilt`), `stalled` flag, and
  latest `reason`.
- `eligible[]` — the firings that could run right now.
- `blocked[]` — steps that owe something but whose inputs aren't all green, with
  the specific non-green inputs holding them back (stalled steps excluded).

This is the operator's whole view, and because it is a pure read it can never
drift from the real state the engine acts on.

## §19 Schema validation

The engine is domain-neutral — it doesn't know what a `plan` *means*. But a
wiring may still want to guarantee its *shape*: that a `plan` is an object with
the fields its consumers expect, that an emitted `source` carries a `url`. An
artifact declaration (a `produces` entry or an `inputs` entry) may therefore
carry a `schema:` — a full **JSON Schema draft 2020-12** document, validated by
`@cfworker/json-schema` (zero codegen, near-zero transitive deps). A schema that
is itself malformed fails fast at **load** (`assertValidSchema` in defs.ts runs a
trial validation to force lazy `$ref` resolution), never at first commit.

**Enforcement is at commit time, and it is a refusal — not a verdict.** Shape is
the engine's business; *meaning* stays a consumer's `reject` (§6 judgment).

- **`green` (singleton / map output).** After the commit CAS (§12.2) passes, the
  value is validated against the produce's schema. On failure the green is
  refused: the artifact is written back `rejected` with `schemaRejects + 1`, a
  `schema-reject` reason (kind `validation`) carrying the summarized violations
  is appended, and the commit returns `outcome: 'schema-rejected'` **with the
  `issues[]`** — but the run/lease is *not* closed. The same worker can correct
  the value and re-`green` on the same open run; the per-artifact counter is the
  only bound, so a re-green can't bypass the stall.
- **`emit` (collection).** Every element is validated against the collection's
  schema *before any element is written*. One bad element refuses the **whole**
  emit atomically (nothing accretes), bumps the seal's `schemaRejects`, and
  returns `schema-rejected`. This stops a producer half-filling a collection with
  malformed members.
- **`provide` / `create` (inputs).** A `seedOwed` input supplied via `provide`,
  or an input supplied at `create`, is validated against the input's schema
  before it is seeded green. A violation is a hard error (non-zero CLI exit) —
  there is no producer to re-arm, so refusing outright is the only honest move.

**Liveness (§6 parallel).** Schema failures ride a counter *separate* from
judgment rejects, because they are categorically different — the engine refusing
a malformed value, not a consumer disagreeing with a sound one. Once
`schemaRejects ≥ maxSchemaFailures` the artifact is **schema-stalled**
(`isSchemaStalled`): it stays a debt but stops re-arming, exactly like a §6
judgment stall. The two caps (`maxSchemaFailures`, default 5; `maxAttempts`) are
tuned independently, a `maxSchemaFailures` of 0 disables the schema stall, and a
single `retry` resets *both* counters. Like `maxAttempts` (§6), `maxSchemaFailures`
is a step-level default that an individual `{name, ...}` produce may override;
the override rules are identical (`??` fallback, an explicit produce-level `0`
honored, `group:` entries unaffected). `validateValue` is total — a schema that
somehow throws at validate time (an unresolved `$ref`, a stack overflow on a
self-referential schema + deeply nested value) is folded into an ordinary
validation failure rather than crashing the commit, and the surrounding
transaction rolls back cleanly.

**Trust boundary.** A schema is *operator-authored configuration* loaded from the
trusted `--defs` directory; the value it validates comes from a worker. The
engine assumes the schema itself is benign — in particular, a `pattern` /
`patternProperties` regex is compiled with `new RegExp(…, 'u')`, so a
catastrophically-backtracking pattern is an operator foot-gun (it could stall the
single-threaded engine on an adversarial value), not an attacker lever. Keep
`pattern`s linear. Worker-supplied *values* need no such trust: a malformed value
is just a schema-reject, bounded by `maxSchemaFailures`, and CLI values are
additionally bounded by the OS argument limit.

## §20 The effect contract (`effect:`)

A step may declare `effect: { idempotent?, onInvalidate? }` to control how the
forward cascade routes when the step's green artifact's inputs move to a new
version (§7).

- **§20.1 idempotent (default `true`)** — when `true`, re-deriving the artifact
  after inputs move is safe; the engine re-arms it (structural reject) exactly as
  it does for any non-terminal green today. When `false`, re-running the step
  would cause an unretractable side effect (a publish, an external API mutation)
  and must not proceed silently.

- **§20.2 onInvalidate (consulted only when `idempotent: false`)** — defaults to
  `'escalate'`. Two values:
  - **`'pin'`** — the artifact stays green; its fingerprint is re-pointed to
    current input versions (the *pinned* condition). The producer does not
    re-fire. Use when the side effect is acceptable even with stale inputs (e.g.,
    a deployed artifact that does not need to track every upstream change).
  - **`'escalate'`** — the artifact is rejected-and-held (the *held* condition,
    `isHeld`, §6). The producer does not auto-re-fire; the debt surfaces as
    `stalled: true` with `kind: 'invalidated-irreversible'` in
    `workflowStatus.debts`, requiring human intervention (retry / accept-as-is /
    fix upstream).

- **§20.3 `terminal:` vs `effect:`** — `terminal: true` is the legacy spelling
  for `effect: { idempotent: false, onInvalidate: 'pin' }` plus the dead-end lint
  exemption. The two coexist on the same engine version; migration of `terminal:`
  to `effect:` is deferred. They are mutually exclusive on the same step
  (`validateDef` hard-errors if both are set).

- **§20.4 dead-input cascade is not gated by `effect:`** — when a non-idempotent
  artifact's input becomes settled-dead (retracted or skipped), the structural
  cascade (retract/skip) applies regardless of `effect:`. Only the moved-version
  re-arm path routes on `effect:`.

- **§20.5 convergence** — a `pin` op re-points the fingerprint to current input
  versions. On the next `maintainDecisions` pass, `fingerprintMatches` returns
  true for that artifact, so no op is generated — the cascade is stable after
  a single pass.

- **§20.6 named-handler routing** — `onInvalidate: <stepName>` routes
  invalidation to a compensating forward-action step. When L's green artifact's
  input moves and L declares `effect: { idempotent: false, onInvalidate: 'H' }`:
  1. **Pin L** — L's artifact stays green; its fingerprint is re-pointed to the
     current input versions (exactly as `onInvalidate: 'pin'`). L does not
     re-fire.
  2. **Arm H** — H's produced outputs are materialized as `owed` if absent, or
     re-armed from `green` to `owed` if H has already fired once (D-C
     re-invalidation). H is a normal forward-producer step — no new acceptance
     state; the engine sequences nothing beyond making H eligible.

  - **Armed-on-demand dormancy (D-A)** — H's outputs are NOT seeded `owed` at
    instance creation (`pendingOwed` skips handler steps). H is invisible to
    `eligibleFirings` until L is first invalidated. This avoids spurious firings
    on fresh instances where L's artifact has never greened.
  - **No-thrash (D-C)** — the `pin` op re-points L's fingerprint. On the very
    next `maintainDecisions` pass, `fingerprintMatches` returns true for L →
    no new pin, no new arm. `settle()` converges in at most two iterations.
  - **Re-invalidation (D-C re-arm)** — if the input moves again after H has
    greened, L's new fingerprint mismatches → pin L again + arm H again. The
    `arm` op finds H's output green and re-arms it to `owed`. H re-fires.
  - **D-D validation** — `validateDef` enforces: the handler step must exist in
    the same workflow; the handler must not be the same step (no self-handler);
    the handler must produce at least one output (otherwise `arm` would write
    no artifact to the store, creating no debt and no eligibility).
  - **§20 table extension**:

  | key | idempotent | onInvalidate | cascade behavior on input move |
  |---|---|---|---|
  | _(none)_ or `effect: { idempotent: true }` | true | — | re-arm (structural reject) |
  | `effect: { idempotent: false, onInvalidate: 'pin' }` | false | pin | stay green, re-point fingerprint |
  | `effect: { idempotent: false, onInvalidate: 'escalate' }` | false | escalate | reject-and-hold; stalled |
  | `effect: { idempotent: false, onInvalidate: '<H>' }` | false | stepName | pin original + arm H (D-A/D-B) |
  | `terminal: true` | false | pin | stay green + lint-exempt (legacy) |

  Cross-reference: §6.1 resolution 2; §6.6 (this is forward-action
  compensation, not auto-redo of the irreversible step).

## §21 Firing rules and the completion evaluator (`on:`)

Every step today is implicitly `on: [inputsGreen]` — fire when consumed inputs are green. `on:` makes the firing trigger explicit.

- **§21.1 `inputsGreen` (default)** — the existing behaviour, unchanged. A step whose `on:` is omitted, or explicitly set to `['inputsGreen']`, fires exactly as today.
- **§21.2 `allGreen`** — the step fires when the workflow is all-green: no outstanding debts among all artifacts *except the evaluator's own produced outputs* (bootstrap exclusion). Fires immediately on all-green (no delay — the `idle` trigger, which waits instead, is §21.8).
- **§21.3 Bootstrap exclusion** — the evaluator's own owed `outcome` is not counted among the debts in the all-green check. Without this, the evaluator's firing could never be triggered (its own debt would prevent all-green).
- **§21.4 Fall-out-of-done re-arm** — once `outcome` is green (done), if the workflow later falls out of all-green (a new debt appears — e.g. a re-provided input re-arms an upstream artifact), `maintainDecisions` detects that `outcome` is green but all-green no longer holds, and emits a structural reject to re-arm `outcome`. When the workflow returns to all-green, `eligibleFirings` offers the evaluator again. This is stable: `maintainDecisions` only emits the op when the workflow is NOT all-green but `outcome` IS green. After the reject is applied, `outcome` is a debt — the op is not re-emitted. **Exception — terminal-settle invariant (§15.2):** if any artifact with `terminal: true` is green, neither the `allGreen` re-arm nor the `idle` re-arm is emitted, even if the workflow falls out of all-green. A terminal-green artifact seals the workflow; re-arming a completion evaluator after that point would spuriously undo a finished workflow whose side effects are irreversible.
- **§21.5 Trigger-cause** — the engine threads the cause ('allGreen') onto the `Firing`, the `RunData`, and the `Order`. A worker can read `order.cause` to branch behaviour (e.g. inspect status, green `outcome`, message a human).
- **§21.6 One `outcome` output** — the evaluator step produces exactly one singleton `outcome` artifact. This is the embedding boundary contract (§17): the outer workflow or teardown step consumes the child's `outcome`.
- **§21.7 The `idle` trigger** — see §21.8 below.
- **§21.8 `idle` trigger** — a step with `on: ['idle']` (or `on: ['allGreen', 'idle']`) fires when the workflow is quiescent and a time threshold has elapsed. Eligibility requires: (a) the workflow is NOT all-green (allGreen owns the done condition — idle must not race it), (b) no run is in-flight (any claimed, lease-fresh task blocks idle; R12), and (c) `now >= threshold` where `threshold` is determined by §21.9–§21.10. When eligible, `eligibleFirings` emits a `Firing` with `cause: 'idle'`. The step must declare `idleAfter` (a duration string, e.g. `"30m"`); omitting `idleAfter` when `'idle'` is in `on:` is a hard `validateDef` error.
- **§21.9 Sliding window (relative alarm)** — by default the threshold is `last_progress + idleAfterMs`. `last_progress` is derived as `MAX(artifact.updated_at)` across all artifacts of the workflow (query: `SELECT MAX(updated_at) FROM artifact WHERE workflow = ?`, fallback 0 if none). Every artifact state change goes through `putArtifact`, which stamps `updated_at = nowMs()`, so `last_progress` reliably captures the most recent forward-progress event. Artifact births (owed materialisation), greens, and rejects all advance it. The window slides: if the workflow makes progress, the clock resets.
- **§21.10 Absolute alarm (override)** — a worker or external scheduler may call `engine.setAlarm(workflow, step, at)` to set an absolute wake-up time. This writes `alarm_at` (ms epoch) to the `task` row for `(workflow, step, key='')` and survives process restart (SQLite-persisted). When `alarm_at` is set, `threshold = alarm_at` takes precedence over the relative fallback. The alarm is consumed (cleared) by the engine when the idle firing is selected — a worker that wants a recurring heartbeat must call `setAlarm` again inside its body. `clearAlarm(workflow, step)` sets `alarm_at = NULL`.
- **§21.11 `setAlarm` / `clearAlarm`** — engine-level API. `engine.setAlarm(workflow, step, at: number)` and `engine.clearAlarm(workflow, step)` are thin wrappers over `store.setAlarm` / `store.clearAlarm`. The store methods upsert the task row if it does not yet exist (evaluator step may not have been ticked yet). `store.getAlarm(workflow, step)` returns the current `alarm_at` or `undefined`.
- **§21.12 Heartbeat re-arm** — once an idle firing greens `outcome`, the alarm is cleared. If the evaluator body calls `setAlarm` to schedule a follow-up, the engine's `maintainDecisions` call inside `settle` detects (on the next tick) that `outcome` is green and `idleEligible` is true (the new alarm elapsed), and emits a structural `reject` re-arm on `outcome`. This arms the idle step again without any extra state. Without a new alarm, and with `now < last_progress + idleAfterMs`, `idleEligible` returns false — no re-arm, no thrash.
- **§21.13 Purity discipline** — `src/model.ts` is clock-free. `eligibleFirings` and `maintainDecisions` accept an optional `TimeFacts` bag `{ now, lastProgressMs, inFlight, alarms }` as their third parameter. All clock reads happen at the engine boundary (`opts.now ?? nowMs()` in `engine.ts`). `TimeFacts` is assembled by `engine.computeTimeFacts` (a private method) before calling into the model. For a fixed `(arts, TimeFacts)` pair, `eligibleFirings` and `maintainDecisions` are deterministic and idempotent. `src/model.ts` imports no timer, no `Date`, and no `nowMs` — the purity is structural, not a convention.

## §22 Mode 1 compile-time workflow composition (`include:`)

A pure `defs.ts` feature — zero engine change. The loader produces an expanded `WorkflowDef` with the child's steps spliced in, stems prefixed, and inputs mapped or hoisted. The engine sees one flat graph.

### §22.1 Grammar

```yaml
steps:
  - include: <defName>      # child workflow name
    as: <prefix>            # namespace token; must match ^[a-z][a-zA-Z0-9_-]*$
    inputs:                 # optional: map child seedOwed inputs
      <childInputName>: <outerArtifactName>
```

### §22.2 Expand-then-validate pipeline

1. `buildDef` parses include directives from the step list into `WorkflowDef._includes`, leaving them out of `steps`.
2. `expandIncludes(def, resolve)` splices the prefixed child steps in place of each directive (M1-EXPAND).
3. `validateDef` runs on the expanded flat def — catching cross-boundary dangling consumes, two-producer conflicts, map/reduce shape errors, and cycles for free.

### §22.3 Prefixing semantics

Every child artifact and step name is prefixed with `${as}.`:
- Step name: `planner` → `deliver.planner`
- Produce stem: `plan` → `deliver.plan`
- Consume stem: `plan` → `deliver.plan`
- Collection stem `source[]` → `deliver.source[]` (seal and elements derived correctly from the prefixed stem)
- `invalidates` entries prefixed
- `effect.onInvalidate` step-name strings prefixed (but not `'pin'`/`'escalate'`)

### §22.4 Input rewiring

- **Mapped** (`inputs: { childInput: outerArtifact }`): the child input is not added to the parent's inputs. Every consume referencing `${as}.${childInput}` is rewritten to `outerArtifact`. The rewrite is a plain consume to an existing outer artifact (input or produce); the existing validator checks the reference for free.
- **Unmapped**: the child input is hoisted as `${as}.${childInput}`, preserving `seedOwed`, `producer`, and `schema`.

### §22.5 Recursion and cycle guard

`expandIncludes` maintains an include stack. If a def name appears already on the stack, it throws `DefError: include cycle: <a> -> <b> -> <a>`.


---

## §23 Mode 2 runtime workflow composition (`calls:`)

Mode 2 is the **runtime** sibling of Mode 1 (`include:`). Instead of inlining a child workflow's steps at compile time, a `calls:` step declares that a **separate child workflow instance** produces one of the parent's artifacts at runtime. The `calls:` step is machine-handled — it never emits a worker order.

Mode 2 ships in two layers, both implemented: a **static foundation** (grammar, validation, the cross-def cycle check, the `producedBy` parent-coordinate link, and `eligibleFirings` exclusion) and the **runtime cascade-up** behavior (spawn-on-eligible, cross-boundary outcome read, machine-green, re-attach, re-provide), documented in §23.6.

### §23.1 Grammar

```yaml
name: provisioned-delivery

inputs:
  - name: proposal
    seedOwed: true

steps:
  - name: deliver
    calls: delivery          # child workflow name (must exist in the same def directory)
    inputs:                  # optional: child input name → parent artifact name
      proposal: proposal
    produces: [delivered]    # exactly one parent artifact (the outcome artifact)

  - name: teardown
    consumes: [delivered]
    produces: [torn_down]
    terminal: true
    body: |
      Tear down and green `torn_down`.
```

Shape rules:
- `calls:` must name a workflow that exists in the same def directory (resolver namespace).
- `inputs:` keys must be declared inputs of the child workflow; values must be parent artifact names (inputs or step produces).
- `produces:` must declare exactly one artifact (the parent artifact the child outcome feeds).
- A `calls:` step must NOT have a `body:` (it is machine-handled).

### §23.2 `producedBy` parent-coordinate link

When the engine spawns a child instance, it passes `producedBy: { parentWf, parentPath }` to `createInstance`, which persists it via the store. The coordinate serves three duties:

1. **Re-attach on reap**: when a child run is reaped, the engine re-attaches via the stored link.
2. **Reverse lookup**: `store.findChildByParent(parentWf, parentPath)` — the never-duplicate guard.
3. **Cascade-up anchor**: the engine reads `producedBy` to propagate the child's outcome to the parent.

**Storage**: two nullable columns on the `workflow` table — `produced_by_wf TEXT` and `produced_by_path TEXT` (both null for a top-level instance). Two columns (not a JSON blob) because the reverse lookup `(parentWf, parentPath) → child` must be SQL-indexable. The index `workflow_produced_by ON workflow(produced_by_wf, produced_by_path)` makes the lookup O(1). Added by the additive migration in `store.migrate()` (schema version 3).

### §23.3 calls: steps are machine-handled

- **Excluded from `eligibleFirings`**: `model.ts` skips any step with `step.calls` set. No worker order is ever emitted for a `calls:` step.
- **Owed artifact seeded normally**: `pendingOwed` seeds the calls: step's one declared `produces` stem as owed at instance start (same code path as normal singleton produces).
- **Debt/done correctness**: an owed calls: artifact is a normal debt. The parent workflow is not done until the calls: output is green (same logic as any other owed artifact — no special casing needed).

### §23.4 Cross-def calls-cycle check

At `loadDefs` time, after all defs are expanded and per-def validated, `detectCallsCycles(defs)` performs a DFS over the `calls:` edge graph and throws `DefError: calls cycle: a -> b -> a` if a cycle exists.

This check is **separate** from the include-cycle guard in `expandIncludes` (§22.5) — they walk different edge kinds (`calls:` vs `include:`). An include cycle and a calls cycle can coexist independently and are reported with different messages (`calls cycle:` vs `include cycle:`).

### §23.5 `createInstance.producedBy`

`CreateOpts` gains `producedBy?: { parentWf: string; parentPath: string }`. When present, `createInstance` passes it to `insertWorkflow`, which stores both columns. The static layer changes nothing else — the field is wired end-to-end (store → engine → opts) so the runtime layer can call `createInstance({ producedBy })` without touching those layers.

### §23.6 Runtime cascade-up

The engine ships `maintainCalls` in `engine.ts` — the engine-internal method that drives the calls: lifecycle. All cross-instance behavior lives in the engine only; `model.ts` stays pure single-instance.

#### §23.6.1 `maintainCalls` algorithm

Called at the top of every parent `tick` (outside any transaction), after `provideInput` on the parent (so a newly-supplied human input is immediately re-provided to any mapped child), and as a cascade-up prompt after child progress. For each `calls:` step in the parent def:

1. **Gate check**: `gateStems = Object.values(callsInputs)` (parent artifact names wired to child inputs). Gate is ready when every gate stem is green.
2. **Re-attach guard**: `findChildByParent(parentWf, callsPath)` — spawn only when no child exists (`undefined`). This prevents duplicate children across crashes and re-ticks.
3. **Spawn**: if gate is ready and no child, `createInstance(step.calls, { producedBy, provide: gateValues })`. The parent calls: artifact stays `owed`.
4. **Outcome read**: read the child's declared `outputs:` artifact (exactly one, validated at load time). If it is green, machine-green the parent's calls: artifact.
5. **Re-provide**: for each `callsInputs` mapping, if the parent's value differs (deep-equal) from what the child holds, `provideInput(child, inputName, newValue)`. The child re-runs internally.
6. **Machine-green**: set parent calls: artifact to `acceptance: 'green'`, `version + 1`, `value = child outcome value`, `fingerprint = computeFingerprint(parentArts, gateStems)`. Then `settle(parentWf)` so downstream (teardown) fires. Do NOT set `terminal` — the calls: artifact must be re-armable if gate inputs move.
7. **Re-arm on child working**: if the child's outcome is no longer green (e.g. re-provide re-armed it) but the parent calls: artifact is green, re-arm the parent calls: artifact to `owed`. This handles gate re-arm correctly even though `deliver` step has `consumes: []` (the pure cascade cannot detect fingerprint mismatch for calls: steps).

#### §23.6.2 Cascade-up prompt

After a child `green` or `close`, `triggerParentIfChild(childWf)` reads the child's `producedBy` link and calls `maintainCalls(parentWf)`. This propagates the child's outcome to the parent immediately, instead of waiting for the next scheduled tick. Durability is free regardless: even without the prompt, the next parent tick calls `maintainCalls` and reads the persisted child outcome. The recursion guard (`_inMaintainCalls: Set<string>`) prevents `maintainCalls → provideInput → fireSettled → triggerParentIfChild → maintainCalls` infinite steps.

#### §23.6.3 `outputs:` as embedding interface

A workflow that can be called via `calls:` must declare exactly one `outputs:` stem (validated at `loadDefs` Phase 2). The called workflow's `outputs:[0]` is the artifact whose value is reflected up to the parent's calls: artifact when it greens. The `delivery` workflow declares `outputs: [merge]` — its merge artifact is the public outcome. A parent `calls: delivery` receives the merge value in its `delivered` artifact.

#### §23.6.4 Failure branch

A child that greens its declared outcome with a status-bearing value (e.g. `{status: 'failed'}`) propagates that value up unchanged. The parent's calls: artifact greens with the failure status, and teardown (or other consumers) receives it through the normal green gate. Teardown runs on success AND failure — there is no special consume mode for failure.

#### §23.6.5 Gate fingerprint and re-arm

The machine-green fingerprint covers only `gateStems` (the parent artifacts wired into the child via `callsInputs`). The child-outcome version is intentionally NOT included in the fingerprint — `fingerprintMatches` uses a key-count check that would fail if the child version key count differs from the gate stem count. The child-outcome re-green trigger is handled by `maintainCalls` value comparison (`deepEqual`), not by the pure cascade.

#### §23.6.6 Transaction composition

`maintainCalls` runs OUTSIDE any open `store.tx()`. Each mutating action (spawn via `createInstance`, re-provide via `provideInput`, machine-green) opens its own `store.tx()`. No nested transactions — node:sqlite does not support nested `BEGIN IMMEDIATE`.

## §24 Artifact judges (`judges:`)

A `produces` entry can declare one or more **judges**: deterministic
quality bars an artifact must clear before it counts as done, independent of
domain review. A judge is not a review step (that stays a normal `consumes:
[x] → produces: [approval]` node when it's actually domain work, e.g.
`delivery.yaml`'s `reviewer`); a judge is for criteria that would never merit
a node of their own — completeness, rigor, tone, format — evaluated by the
engine's own firing pipeline rather than by a human threading a review step
into the graph.

### §24.1 The `submitted` state

A sixth `acceptance` state, `submitted`: the producer has committed a
schema-valid value, but one or more declared judges haven't all signed off on
this version yet.

- **Reads as NOT green** for consumers — `isGreen` is `acceptance === 'green'`
  exactly, unchanged. A `submitted` artifact is invisible to downstream
  `inputsGreen`/`allGreen` triggers, exactly like `owed`.
- **Reads as OUTSTANDING for completion** — `OUTSTANDING_STATES = DEBT_STATES
  ∪ { submitted }` (§5). A workflow is not `done` while any artifact sits in
  `submitted`, even though the producer itself has no further debt.
- Artifacts whose `produces` entry declares no `judges:` never enter
  `submitted` — a plain commit lands `green` exactly as before. This is fully
  backward compatible: no judges declared, zero behavior change.

### §24.2 A judge is a synthesized `StepDef`

N `judges:` entries on one `produces` entry → N full synthesized `StepDef`s,
named `${producerStep}.${producedStem}.judges.${judgeName}`. Each judge step:

- `consumes: [judgedStem]` (+ the producer's own `consumes` if `inputs: true`,
  spliced in as read-only context). `assertAuthority` (engine.ts) scopes a
  judge's reject authority to exactly its own `judges:` stem, never to the
  full `consumes` list — a judge with `inputs: true` can see the producer's
  input stems for context but cannot invalidate them; only a non-judge
  step's authority follows the plain consume-edge rule.
- `produces: []` — a judge renders its verdict as a `green`/`reject` call
  against the judged stem, not by producing an artifact of its own.
- `judges: <judgedStem>` — the marker field that makes it a judge (mirrors
  `calls:`'s marker-field pattern), read by both layers:
  `eligibleFirings`/`applyOutcome` (model.ts) and `green()` (engine.ts).
- Everything else — throttles (`cadence`, `maxRunsPerDay`), retry/timeout,
  prompt surface (`body`/`bodyFile`/`model`), observability — is inherited
  from the ordinary `StepDef` shape, not respecified. A judge is not a
  special-cased mini-pipeline; it is a step.

**Wiring decision**: judges flow through the *normal* step-firing pipeline
(`eligibleFirings → applySchedule → claim → buildOrder`, plus `reap`), not
the `calls:`/`maintainCalls` bypass. A `calls:` step is machine-handled and
never emits a worker order; a judge step *is* worker-fired — it needs a real
order, a real lease, real retry/timeout, real throttles. Concretely, this is
a `step.judges` branch directly inside `eligibleFirings` (model.ts), parallel
to but structurally separate from the `step.calls` early-continue.

### §24.3 The sign-off ledger

`ArtifactData.approvals?: Record<judgeName, version>` — the per-version
sign-off ledger, present only while relevant (`undefined` once an artifact is
`green`/`rejected` cleanly, cleared on every reject/retry/fresh-submit).

- **Judge approve**: `approvals[judgeName] = artifact.version`. If every
  declared judge name now maps to the artifact's *current* version, the
  artifact transitions `submitted → green`. Otherwise it stays `submitted`
  with a partial ledger.
- **Judge reject**: any single reject wins immediately —
  `submitted → rejected`, bumps `judgmentRejects` **once per submission**
  (not once per judge), `approvals` cleared. The producer re-arms and, on its
  next successful commit, gets a fresh ledger (§24.1) — a sibling judge's
  stale partial approval from the rejected version is never carried forward.
- **Cascade discipline** (§4.3 of the proposal): an input-move cascade reject
  on a `submitted` artifact is a **structural** reject (§6), not a judgment —
  it must NOT bump `judgmentRejects`. `applyOp`'s generic reject-op handling
  already satisfies this; only the eligibility condition needed widening to
  admit `submitted` alongside `green` as a cascade-checkable state.
- **Terminal timing** (§4.8): for a `terminal: true` producer step with
  judges declared, the terminal flag is applied at judge-**approve** time
  (the moment `submitted → green` lands), never at producer-commit time. A
  `submitted` artifact — even a terminal one — must remain re-armable by a
  judge reject.

### §24.4 CAS and the stale-verdict race

Version bumps happen at producer-submit time (unchanged, §12.2). A judge's
run fingerprint captures the judged stem's version for free — `claim()`
already sets `f.inputs = step.consumes.map(c => c.stem)`, and a judge step's
synthesized `consumes` includes the judged stem, so `r.fingerprint[judgedStem]`
is populated by the existing machinery with no new capture code.

`judgeCasCheck` (engine.ts, sibling to `casCheck`) checks "the judged stem is
still `submitted` at the fingerprinted version" before applying a judge's
verdict:

- If the judged stem moved (producer resubmitted, a human bypassed it, or a
  sibling judge's reject already settled it) since this judge's order was
  claimed, the verdict is refused — **born-rejected**, exactly like a stale
  producer commit (§12.2). The in-flight judge's stale opinion never
  overwrites a newer submission or double-counts against an
  already-settled reject.
- This is symmetric with the producer's own `casCheck` — two independent CAS
  checks (`casCheck` for producer commits, `judgeCasCheck` for judge verdicts)
  guard the two different actors that can move a judged artifact.

### §24.5 Judge order failure ≠ judge reject

A judge order that dies (crash, timeout, no verdict rendered) is reaped by
the ordinary `reap()` path — the task goes back to `idle`, `attempts`
increments, and the judge re-fires on the next eligible tick. This is a
**structural** event, identical in kind to any other step's order-failure
handling; it must never bump `judgmentRejects`. A dead judge order is not an
opinion about the artifact's quality — it's a fact about worker
availability, and the two must stay uncorrelated so a flaky judge worker
cannot exhaust the producer's `maxAttempts` budget on its own.

### §24.6 Human override

Two human-facing bypass points, both reusing the existing `green`/`retry`
verbs with no new CLI surface:

- **`green(workflow, 'human', path, value)`** — the sentinel run id `'human'`
  in `Engine.green` skips lease/CAS entirely and does a full bypass:
  `submitted → green` immediately, ledger irrelevant, regardless of how many
  judges have or haven't signed off. This is a genuine full override (§4.11
  of the proposal), not one more ledger slot — a human's judgment supersedes
  the panel outright. The CLI's `green` command already takes `run` as a
  required positional argument, so this needs zero new flags:
  `owenloop green <wf> human <path> --value '{...}'`.
- **`retry`** — clears `approvals` in addition to the existing counter reset,
  so a human clearing a judge-reject stall doesn't leave a stale partial
  ledger for the rebuild to inherit.

A human bypass's scope is deliberately narrow: it skips the judge ledger and
the lease/CAS machinery, but not the artifact's declared output schema — a
human `green` on a produce with a `schema:` is validated exactly like a
producer commit (§18), refused with a thrown Error (no version bump, no
schemaRejects bump — there is no retry loop to protect on this path) rather
than silently landing a value downstream consumers assume is schema-valid.

### §24.7 `CommitResult['outcome']` — three success outcomes, two failure

`green()`'s result vocabulary grows by two, both **successes**:

- `'submitted'` — the producer's own commit landed in `submitted` because the
  produce declares judges. Exit code 0; this is the expected outcome for any
  judged produce's first (or re-)commit, not an error.
- `'approved'` — a judge recorded its ledger slot, but not all declared
  judges have signed the current version yet. Also exit code 0.
- `'green'` — unchanged: either a plain (unjudged) commit, or the *last*
  judge's approval completing the ledger.
- `'born-rejected'` / `'schema-rejected'` — unchanged, still the only failure
  outcomes. The CLI's `case 'green':` handler whitelists these two as the
  error branch; everything else (including the two new outcomes) is success
  — a change from the pre-judges CLI, which treated any outcome other than
  `'green'` as a failure and would have misreported a healthy
  producer-into-`submitted` commit as an error.

`reject()` grows a matching, smaller vocabulary: `{ outcome: 'rejected' |
'born-rejected'; reason?: string }` (previously `void`). `'rejected'` is the
normal case — unchanged behavior, exit 0. `'born-rejected'` is new: a judge's
verdict lost the CAS race in §24.4 (the judged stem moved since this judge's
order was claimed) and was refused rather than applied — the judged artifact
is untouched, `judgmentRejects` is not bumped, and the CLI's `case 'reject':`
handler (split out from the `retract`/`skip` block it used to share, since
those two verbs are still `void`) mirrors `green`'s born-rejected branch:
print the outcome, exit 1. Before this, the CLI discarded `reject()`'s return
value and always printed `{ok:true}` / exit 0 — a stale judge reject looked
like success on the wire, exactly the failure `judged-research.yaml`'s
documented `owenloop reject … --by researcher.report.judges.rigor` usage must
surface to a scripted caller.

### §24.8 YAML surface

```yaml
steps:
  - name: researcher
    consumes: [question]
    produces:
      - name: report
        schema: { type: object, required: [sections] }  # existing, optional
        judges:                                          # NEW, optional list
          - name: completeness
            body: |
              Evaluate `report`: every section present, no placeholder or TODO
              text, every claim carries a citation. If it falls short, reject
              `report` with the concrete gaps (this re-arms the researcher).
              Otherwise approve.
          - name: rigor
            bodyFile: judges/rigor.md # or a prompt loaded from disk (§16) —
                                      # body/bodyFile mutually exclusive
            model: strong             # optional, per-judge model
            inputs: true              # optional, default false — judge also
                                      # reads the producer's inputs (question)
        maxAttempts: 8    # optional, §6 — overrides the step default below
                          # just for `report`; absent caps still inherit
    maxAttempts: 5    # producer's cap (default for every produce on this step)
                      # — also bounds judge-reject → rebuild loops
```

- `name:` — required; keys the sign-off ledger and the audit trail.
- `body:` / `bodyFile:` — the judge agent's prompt (exactly one required,
  mutually exclusive, same rule as step bodies). `bodyFile` is resolved
  against the workflow's base directory and read eagerly at def-load.
- `model:` — optional model override for that judge's order. Opaque to the
  engine, like the step-level key: the recommended vocabulary is the quality
  tiers `fast` / `standard` / `strong` / `strongest`, resolved to a concrete
  model by the dispatcher; any other value passes through verbatim as a
  literal model id.
- `inputs:` — optional, default `false`: the judge sees only the judged value
  on its own merits; `true` adds read-only consume edges on the producer's
  inputs, for criteria that need "what was asked for" as context.
- `cadence:` / `maxRunsPerDay:` — optional throttles, same meaning as on
  steps; firing is event-driven (on submit), the throttles just cap the rate.

See `examples/workflows/judged-research.yaml` for a runnable end-to-end
example (mirrors this shape exactly, plus `examples/workflows/judges/rigor.md`
for the `bodyFile:` case). `delivery.yaml` is deliberately unchanged — PR
review there is domain work and stays a `reviewer` step.
- **Fan-out / many-output children** — D1/D2. The v1 one-output rule is enforced.

### §24.9 A narrower, accepted race: same-judge zombie verdicts

§24.4's CAS check (`judgeCasCheck`) closes every race where the *judged
artifact itself* moved off `submitted` before a verdict landed — a producer
resubmit, a sibling judge's reject, or a human bypass. It does not close a
narrower case: two different *runs of the same judge step* racing on the
*same* still-`submitted` version.

`reject()` takes no `run` parameter — by design, authority is step-scoped,
not run-scoped (§4.1: authority follows the consume edge, keyed by actor
name). Its CAS check therefore validates against whichever run currently
holds the judge step's task lease, not the specific run instance calling
`reject()`. The real-world pathway: a judge order is reaped (§24.5 — its task
goes back to `idle`, attempts increments) but the worker process keeps
executing anyway, and eventually posts a late verdict — after a fresh run of
the *same* judge step has already been claimed and is (or has already)
rendered its own verdict. The stale, "zombie" verdict and the fresh run's
verdict both read as "the currently-claimed run for this judge step," so the
CAS check cannot tell them apart. Fully closing this would require a
breaking signature change (`reject(workflow, path, by, text, run?)`) and is
left as a known, accepted limitation — see the doc comment on `reject()` in
`src/engine.ts`.

**Mitigations, for operators running judges with slow or expensive verdict
agents:**

- Keep `judges: <judgedStem>` steps at `parallel: 1` (the default) so there
  is only ever one live run of a given judge step at a time. This alone
  removes the "two different runs" precondition for the race.
- Set a generous `reapTtl:` on judge steps whose verdict agent is slow —
  reaping is what creates the zombie in the first place (§24.5); a judge
  that is legitimately still working should not be reaped out from under
  itself. A TTL sized to the judge's real worst-case latency, rather than
  the platform default, keeps `parallel: 1` actually sufficient in practice.

## §25 The model checker (`owenloop check`) — scope

`owenloop check <def>` (see `cli.ts` usage) runs a bounded reachability
search over `applyOutcome` transitions in `model.ts`, looking for
deadlocks, stuck artifacts, dead steps, and violations of any declared
invariants. It is a static analysis of a workflow definition's shape, not a
simulation of a running instance.

Two things it deliberately does not model, and why: **born-rejected
commits** — a stale-CAS refusal (§12.2, §24.4) is a refusal, not a state
transition, so it isn't a reachable state the search should explore; and
**human overrides** (`green(workflow, 'human', ...)`, §24.6) — a human can
always force any artifact green, so modeling that as an explorable
transition would make nearly every workflow trivially "completable,"
defeating the purpose of running the checker at all. Don't over-trust
`owenloop check` results for concurrency or liveness questions that hinge on
either of these — it answers "is this graph structurally sound," not "can a
human or a stale commit route around a stall." See README's Testing section
for how `owenloop check` fits alongside the test suite.

The checker also has no runtime `provide` values, so by default a
`seedOwed: true` input starts owed with no transition that can green it —
reported as a false depth-0 deadlock for a def whose inputs the operator
always supplies via `provide` at `create` time. Pass `--assume-provided`
(`assumeProvided` in `CheckOptions` when calling `modelCheck` directly) to
seed those inputs green instead, modeling "the operator already ran
`provide`." It only affects the initial seed — a genuine deadlock reachable
past the inputs is still reported.

## §26 Declarative exclusive produce-groups (`group:`)

A step's `produces:` list can carry a `group:` entry spanning two or more of
that *same step's* own singleton sibling stems, declaring a commit-exclusivity
contract the engine enforces directly — instead of the step's own body
manually calling `engine.skip()` on the branch it didn't take (§16.1 routing,
still supported, still the right tool when a step needs bespoke logic beyond
plain either/or routing).

```yaml
produces:
  - simple
  - urgent
  - group: route
    mode: exactlyOne       # exactlyOne | atMostOne | atLeastOne
    of: [simple, urgent]
```

- **`exactlyOne`** — one member is expected to go green; once it does, the
  engine refuses any further commit to a sibling (`'group-rejected'`) and
  auto-skips the untouched siblings in the same cascade that lands the
  winner.
- **`atMostOne`** — identical refusal/auto-skip mechanics to `exactlyOne`.
  The only difference is intent, not enforcement: a producer that routes to
  *neither* member (e.g. manually skips both) is a legal terminal state too —
  the engine has no way to verify "a real winner should have existed," so
  `exactlyOne` vs `atMostOne` is a documented contract for the workflow
  author, not a distinct runtime check.
- **`atLeastOne`** — never refuses a commit and never auto-skips. Once any
  one member is green, `workflowStatus`'s done-ness computation stops
  counting the other (still-`owed`) members as outstanding — the same
  discharge rule §17 already uses for other "good enough" completions. Stored
  acceptance is untouched; this is a done-ness read, not a state mutation.

### §26.1 Refusal timing

The refusal check (`groupCasCheck` in engine.ts, mirrored by `groupWouldReject`
in model.ts for the checker) runs *before* schema/CAS validation on every
commit attempt against a group member: does a **different** sibling in the
group already sit `green`? If so, the commit is refused with outcome
`'group-rejected'` — the value is not written, no counters move, the run/lease
is left open for the caller, exactly like `'schema-rejected'`. A judged
group member (`judges:` on the same produce) is checked at the judge-approve
moment (full ledger completion → `green`), not at the producer's initial
`submitted` — a judge-reject or a still-pending ledger must never trip a
sibling's auto-skip.

### §26.2 Auto-skip is a cascade op, not a special commit path

Auto-skip is implemented purely inside `maintainDecisions` (model.ts) — the
same pure, level-triggered fixpoint function §11.8/§12.3 already uses for
reject/retract/skip/rearm/pin/arm. For every `exactlyOne`/`atMostOne` group
with exactly one `green` member, every `owed`, `rejected`, **or `submitted`**
sibling gets a `skip` op with `rejectKind: 'exclusive'` (a new `RejectKind`,
alongside `judgment` / `structural` / `validation` / `invalidated-irreversible`
— a liveness-accounting category, distinct from the skip's `ReasonAction`,
which stays `'skip'`). Because `Engine.settle()` runs this cascade to a full
fixpoint synchronously at the end of every `green()` call, the auto-skip is
already visible by the time the winning `green()` call returns — a caller
never observes an intermediate state where the winner is green but the loser
is still `owed` or `submitted`.

A `submitted` sibling is an OUTSTANDING state (§15): left uncovered by this
cascade, a judged group member that submits before its sibling wins can never
be settled — its judge order is correctly suppressed by §26.5's eligibility
pre-filter, but the artifact itself just sits `submitted` forever, wedging the
instance out of `done: true` permanently. Covering `submitted` here closes
that gap. Skipping a `submitted` sibling also **clears its `approvals`
ledger** (mirrors the cascade-reject approvals-clear, §24 §4.3): a partial
judge sign-off recorded before the skip must never leak onto a later
resubmission if the winning sibling is later un-greened and the branch
revives — `Engine.applyOp`'s `'skip'` branch and its pure in-memory twin,
`applyOpInMemory`'s `'skip'` branch (the checker's own reimplementation, since
`settleInMemory` calls `maintainDecisions` directly and inherits the cascade
fix for free, but `applyOpInMemory` mirrors the engine's mutation 1:1 and
needs the same approvals-clear applied independently), both clear `approvals`
on the skipped artifact whenever its prior acceptance was `submitted`.

Re-arming an auto-skipped sibling needs zero group-specific code: it goes
through the exact same generic skip-re-arm mechanism (fingerprint-keyed,
§7) that already re-arms a manually-skipped branch when its upstream inputs
move. `rejectKind: 'exclusive'` only changes how the artifact is
*classified* for liveness accounting; it does not change how it re-arms — and
the cleared approvals ledger travels with it, so a re-armed (or freshly
re-produced) sibling always starts its judge ledger from empty.

### §26.3 Grammar and validation

`group:` is parsed alongside — not nested inside — a step's `produces:`
patterns (`parseGroup` in defs.ts), since a group spans multiple stems rather
than describing one. `validateDef` rejects, per step:

- an unknown `mode`;
- an `of:` list with fewer than two members;
- a member stem this step does not itself produce (whether that stem doesn't
  exist anywhere in the def, or is produced by a *different* step — group
  membership is scoped to the declaring step's own produces list either way);
- a member that is a collection/map produce (group membership is
  singleton-only in v1, same restriction as `judges:`);
- the same stem claimed by two different groups on one step.

A step may declare more than one group, as long as their `of:` sets are
disjoint. `group:` is rejected at build time on a `calls:` step's produces
and on a `generates:` entry — both are machine-handled shapes that don't fit
the "producer chooses which sibling to commit" model.

### §26.4 Model checker parity

`eligibleOutcomes` (model.ts) offers `'group-reject'` instead of `'green'`
for a firing whose output would violate its group's contract, so the BFS
explores the real refusal path rather than an impossible green — the same
differential-conformance test (`test/check.test.ts`'s pattern) that pins
every other outcome family to the live `Engine` covers this one too
(`test/groups.test.ts`, scenario (h)).

See `examples/workflows/routing-groups.yaml` for a runnable end-to-end
example (the same router shape as `routing.yaml`, with the manual
`engine.skip()` replaced by a declarative `group:`/`exactlyOne` contract).

### §26.5 Eligibility never offers a firing the commit check already refuses

`eligibleFirings` (model.ts) is pre-filtered by the same `groupBlockingWinner`
helper `groupCasCheck` (engine.ts) and `groupWouldReject` (model.ts, checker)
use — the three call sites share one source of truth for "does a different
sibling in this stem's group already sit green?" Every WORKER-firing branch
(plain, map, reduce, allGreen, idle, and the judge-step branch) excludes an
output path that is currently group-blocked, so the automatic sweep (`tick`)
never dispatches an order — in particular, never spawns a judge order for a
`submitted` sibling — that `groupCasCheck` is guaranteed to refuse the moment
it tries to land green. Historically this pre-filter was the only defense for
a `submitted` group loser: §26.2's cascade covered only `owed`/`rejected`
siblings, so a `submitted` member just sat there — its judge order suppressed
from firing again, but the artifact itself never settled, wedging the
instance out of `done: true` forever (a liveness bug, not merely wasted
spawns). §26.2 now also auto-skips a `submitted` loser in the same settle as
the winner's commit, so this eligibility pre-filter and that cascade converge:
a `submitted` sibling is skipped essentially as soon as it stops being newly
eligible (`test/groups.test.ts` scenario (f3)). `groupCasCheck` itself stays
load-bearing for a judge order that was already claimed (in flight) before the
winner landed — the pre-filter and the cascade both only act going forward, so
scenario (f) still exercises the commit-time refusal against that in-flight
race.

Suppression applies to the automatic sweep only. A human `retry` re-arms the
named artifact directly and does not itself run `eligibleFirings` — but the
artifact is still subject to `maintainDecisions`' own auto-skip cascade
(§26.2), which runs synchronously inside `retry`'s `settle()` call and
re-skips it immediately if the winning sibling is still green. Either way — a
retried stem is suppressed again on the next tick exactly like a
machine-originated re-arm, unless the winning sibling has been knocked down
first (`reject`/`retract`), which makes the *producer* eligible to re-fire
again (`test/groups.test.ts` scenario (i)). This mirrors the existing
human-bypass symmetry at `green()` (§24.6): a human bypasses the run/lease/CAS
machinery, never the group-exclusivity contract itself.

## §27 Engine-version contract and unknown-key rejection

Two independent load-time hardening changes, both aimed at the same failure
mode: a definition that *looks* fine but silently does not mean what the
author intended, discovered only once it misbehaves at runtime instead of
being caught the moment it's loaded.

### §27.1 `engine:` — a declared compatibility contract

A definition may declare `engine: <n>` at the top level. `buildDef` coerces
and checks it via `asEngineVersion`: it must be a positive integer no greater
than `SUPPORTED_ENGINE_VERSION` (defs.ts), a constant bumped whenever a future
engine generation makes a breaking change to definition semantics. Omitting
`engine:` defaults to `SUPPORTED_ENGINE_VERSION` — every `WorkflowDef` in
memory carries a definite `engine: number` (the field is required on the
type, never `undefined`), but no existing definition needs to change to keep
working.

The check is deliberately `>`, not `!==`: a definition declaring an older
supported `engine:` (or omitting it) must keep loading unchanged even after
`SUPPORTED_ENGINE_VERSION` is bumped — only a definition that requests a
version *ahead* of what the running binary understands is an error. That
error — `workflow '<name>' requires engine version <n> but this owenloop
only supports up to <max> — upgrade owenloop` — fires at load time, before
any instance is created, rather than as a confusing failure mid-run once the
engine's actual behavior diverges from what the definition assumes.

`engine:` is checked **per file**, not across `include:`/`calls:` edges: each
YAML file is parsed by its own `buildDef` call, independently of any parent
or child it's wired to. An included or called definition's `engine:` is
validated against `SUPPORTED_ENGINE_VERSION` exactly like a top-level one,
with no propagation or cross-checking between parent and child — `expandIncludes`
never reads or rewrites `WorkflowDef.engine`, so a parent's declared version
says nothing about a child's, and vice versa.

### §27.2 Unknown-key rejection

Every `Raw*` shape parsed from YAML (`RawDef`, `RawInput`, `RawStep`,
`RawCalls`, `RawInclude`, `RawProduce`, `RawGroup`, `RawJudge`) is a
*duck-typed* TypeScript interface — it describes what the parser reads, but
on its own does nothing to stop an author's typo (`bodyfile:` instead of
`bodyFile:`, `maxAttepts:` instead of `maxAttempts:`) or a stray/forward-looking
field from being silently accepted and then silently ignored. Before this
change, such a field parsed cleanly and simply never took effect — a
debugging trap with no error message pointing at the cause.

`assertNoUnknownKeys(obj, allowed, ctx)` closes that gap: called immediately
after each duck-type cast (`as RawX`) and before any field on that object is
read, it rejects any key not in a hand-maintained `RAW_*_KEYS` allowlist
declared next to the corresponding `Raw*` interface (e.g. `RAW_STEP_KEYS`
beside `RawStep`). A mismatch between the interface and its allowlist is a
correctness bug, not a type error — the two are kept adjacent in defs.ts
specifically so a reviewer adding a field to one sees the other.

It is wired into all eight parse sites: the top-level definition
(`RAW_DEF_KEYS`), a normal step (`RAW_STEP_KEYS`), a produce mapping entry
(`RAW_PRODUCE_KEYS`), a `group:` exclusivity entry in a `produces:` list
(`RAW_GROUP_KEYS`, §26), a judge entry (`RAW_JUDGE_KEYS`), an input entry
(`RAW_INPUT_KEYS`), and the two duck-typed step-list directives that are
distinguished from a normal step and from each other purely by which
discriminator key is present: a `calls:` step (`RAW_CALLS_KEYS`) and an
`include:` directive (`RAW_INCLUDE_KEYS`).

The `group:` site follows the same "smaller, different shape" rule as the
`calls:`/`include:` pair below, for the same reason: a `group:` entry
(`group`, `mode`, `of`) is not a produce entry with extra fields, it's a
distinct, smaller shape routed by `parseProduces` checking `'group' in
entry` before falling through to `RAW_PRODUCE_KEYS` — so it gets its own
allowlist rather than folding into one that would wrongly permit `name:` or
`schema:` on a group declaration.

That last pair (`calls:`/`include:`) is the other subtlety worth calling
out explicitly: `calls:` and `include:` steps are *smaller, different*
shapes from a normal step, not a normal step with extra fields. A `calls:`
step entry that also carries `body:` is not "a calls step with an unused
body field" — it's rejected as an unknown key, because `RAW_CALLS_KEYS`
(`name`, `calls`, `inputs`, `produces`) does not include `body`. The
routing itself (which allowlist an entry is checked against) is decided by
`isIncludeDirective` / `isCallsDirective` / the `rl.calls !== undefined`
check in `buildStep` — exactly the same discriminator logic already used to
dispatch parsing — so the unknown-key check can never accidentally validate
an entry against the wrong shape's allowlist.

### §27.3 `x:` — the opaque extension map

The unknown-key rejection above is deliberately strict, which raises the
obvious question: how does an external runner, a commercial platform layered
on top, or any third-party tooling attach its *own* configuration to a
workflow without either forking the engine or forcing allowlist churn for
every new knob? The answer is exactly one sanctioned escape hatch: **`x:`**,
accepted at the definition top level and on a normal step.

The engine's entire contract for `x:` is three clauses:

1. **Shape, not contents.** At load time `x:` must be a plain map (a YAML
   mapping) — anything else (`x: nope`, `x: [a, b]`, `x: 42`, `x: null`) is
   a `DefError` (`asExtension`, defs.ts). What's *inside* the map is never
   validated, read, or interpreted by the engine. Whoever owns the vocabulary
   inside `x:` (a runner, a platform) validates it against their own schema
   at their own load time.
2. **Pass-through, untouched.** A step-level `x:` is carried verbatim through
   `buildOrder()` onto the emitted `Order` (`Order.x`) — the same pass-through
   contract as `model` — so the runner consuming the order gets it without a
   second read of the YAML. The definition-level `x:` is exposed as
   `WorkflowDef.x` on the loaded def.
3. **Additive and inert.** A definition without `x:` is unchanged, byte for
   byte, in behavior and in `hashDef` terms. A definition *with* `x:` behaves
   identically to one without as far as the engine is concerned — eligibility,
   firing, acceptance, cascade, and the model checker are all blind to it.

This keeps external vocabularies out of the engine entirely: the same YAML
file is a single source of truth read by two consumers — the engine reads
the dataflow fields, the runner reads `x:` — with no allowlist churn as the
external tooling grows knobs, and no third-party schema leaking into the
engine's own.

Scope notes: `x:` is a key on the two *authored, engine-fired* shapes
(`RAW_DEF_KEYS`, `RAW_STEP_KEYS`). It is **not** in the smaller
`calls:`/`include:` directive shapes (same shape-routing rule as §27.2 —
those are machine-handled entries with no order for a runner to configure)
and not on produce/group/judge/input entries. Because `x:` rides inside the
def, it participates in §28 pinning like every other field: an instance sees
the `x:` snapshotted at `createInstance` time, and `hashDef` treats an `x:`
edit as real drift — which is correct, since the runner's behavior for that
instance depends on it. `expandIncludes` carries a child step's `x:` through
prefixing untouched (there are no stems inside `x:` to rewrite — it's
opaque); a child definition's own top-level `x:` stays on the child def and
is not merged into the parent's.

## §28 Instance-to-definition pinning

Every prior section treats a workflow *definition* as the stable thing and a
workflow *instance* as ephemeral state layered on top of it, resolved by
name each time the engine needs it (`resolveDef(wf.def)`). That's fine as
long as the YAML on disk doesn't change underneath a long-running instance —
but a dataflow engine's whole point is to outlive a single edit-deploy
cycle. Before this change, editing a definition's `body:`, adding a step, or
changing what a step consumes would silently rewire every in-flight instance
of that definition on its very next `tick`, mid-flight, with no record that
anything had shifted.

### §28.1 Snapshot + hash at `createInstance`

`createInstance` now stamps two extra columns on the `workflow` row:
`def_snapshot` (the fully-expanded `WorkflowDef` — post `include:`/`calls:`
expansion, i.e. exactly what the engine would otherwise have re-resolved by
name — serialized verbatim as JSON) and `def_hash` (`hashDef(def)`, defined
in defs.ts as `sha256(JSON.stringify(def)).slice(0, 16)`). Hashing is
deterministic because `buildDef`/`parseDef`/`expandIncludes` always
construct a `WorkflowDef` with stable field order and never leave stray
`_includes` remnants on an expanded def (`expandIncludes` explicitly sets
`_includes: undefined` once expansion is done).

This is a permanent, additive schema change (`SCHEMA_VERSION` bumped to
`'6'`), not a one-time migration script: rows written before this feature
shipped simply have `def_snapshot`/`def_hash` as `NULL`/absent, forever --
there is no backfill, and none is needed (see §28.2's fallback).

### §28.2 `defFor` — the resolution chokepoint, now pin-aware

`Engine.defFor(workflow)` is the single place the engine turns an instance
id into the `WorkflowDef` it should run against. It now prefers the pin:

```
private defFor(workflow: string): WorkflowDef {
  const wf = this.store.getWorkflow(workflow);
  if (!wf) throw new Error(`no such workflow instance: ${workflow}`);
  if (wf.defSnapshot !== undefined) return wf.defSnapshot;
  return this.resolveDef(wf.def);       // legacy fallback, not an error
}
```

A row with no snapshot (created before this feature existed) falls back to
today's by-name resolution, unchanged — this is permanent backward-compatible
behavior, not a deprecation path. Only two direct `resolveDef` calls remain
in engine.ts outside of `defFor` itself: `createInstance` (which has no
instance yet to pin against) and `adopt` (§28.4, which deliberately wants the
*current* live def, not the pin). Every other call site — including the
`calls:`/`include:` cascade paths `maintainCalls` (resolving a called child's
def) and `triggerParentIfChild` (resolving a parent's def when re-triggering
it) — goes through `defFor`, so a pinned child or parent instance is
respected during Mode 1/Mode 2 cascades too, not just on its own direct
`tick`.

### §28.3 `defDrift` — informational, never a refusal

`status()` now returns an extra optional field, `defDrift?: boolean`,
computed by re-resolving the definition by name and comparing its hash
against the pinned `defHash`:

- `false` — the live def (if it still resolves) hashes the same as the pin.
- `true` — the live def now resolves to something different.
- absent — the live def no longer resolves at all (deleted, renamed, defs
  dir doesn't have it) or the instance predates pinning and has never been
  hashed; `status()` tolerates this via try/catch rather than throwing.

Critically, `defDrift` is informational only. The engine keeps advancing the
instance off its pinned snapshot regardless of drift — there is no
refuse-to-tick, no thrown `DefDriftError`, no partial-degraded mode. Drift is
something an operator (or a wiring/dashboard) can *notice* and act on, not
something the engine enforces. This is a deliberate design choice: the
engine's job is to keep a running instance's contract stable, not to police
whether the source has moved on.

### §28.4 `adopt` — deliberate re-pinning

`owenloop adopt <wf>` (`Engine.adopt(workflow)`) is the only way an instance
moves off its original pin, and it is always an explicit operator action,
never automatic:

1. Re-resolve the definition by name (`resolveDef(wf.def)`) — the current
   live shape.
2. Re-hash it and overwrite the stored `def_snapshot`/`def_hash`
   (`Store.repinWorkflowDef`) in the same transaction as step 3.
3. Run `settle()` against the *new* def, so any debts the new shape
   introduces (new steps, new `consumes`/`produces`) materialize
   immediately rather than waiting to be discovered lazily.

`settle()`/`pendingOwed()` only ever materializes new **step outputs** as
debts — a workflow's declared `inputs:` are seeded exactly once, inside
`createInstance`. Adopting a def that adds a new input (rather than a new
step) will not retroactively ask for that input; only new step-level
`produces` show up as fresh debts after an `adopt`. This is worth knowing
before assuming `adopt` reconciles *every* possible shape of definition
change — it reconciles the step graph, not workflow-level input contracts.

The consequence is sharper than "not re-requested": the added input has no
artifact row in that instance, so `provide` refuses it (`no such input
artifact`) — the input is **unreachable for the life of the instance**, and
any step consuming it is blocked forever. When a mid-flight replan needs a
new external fact, don't add an `inputs:` entry; add a **consumeless intake
step** (`produces: [facts]`, no `consumes:`) and green it directly — being a
step output, it is exactly what `adopt` knows how to materialize.

`adopt` returns `{ workflow, defHash, previousHash? }` (`previousHash` is
omitted for a legacy pre-pinning row that had no prior hash to report).
