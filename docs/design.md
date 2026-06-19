# oweflow — design

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

- **§2.1 Artifact** — a named value a loop produces and others consume. Carries an
  `acceptance` state, a monotonic `version` (0 until first green, +1 each green
  re-production), an optional captured `value` (a handle, meaningful only when
  green), a `fingerprint` (the versions of its inputs at build time), an
  append-only `reasons` thread, and two stall counters — `judgmentRejects` (§6)
  and `schemaRejects` (§19).
- **§2.2 Task / lease** — the claimable unit of work-in-flight. One per
  `(loop, key)`; `key` is `""` for plain/reduce/collection firings and the
  element path for a map firing.
- **§2.3 Run** — the audit/budget record created when a task is claimed; holds the
  claim's input **fingerprint** for the commit CAS.

## §3 The firing rule

A loop's eligibility depends on its consume mode:

- **plain** `x` — eligible when it owes an output and every plain input is green.
- **map** `src[$i]` — one independent firing per collection element; the firing
  for element *i* is eligible when `src[i]` is green and the per-element output
  `src[i].…` is a debt. Concurrency is capped by the loop's `parallel`.
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

## §5 Lifecycle states

The five `acceptance` states (§11.3) partition into:

- **debt** = `{ owed, rejected }` — a producer owes work.
- **settled** = `{ green, retracted, skipped }` — never reads as "stuck".

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
rebuild it. The loop has demonstrably failed; a human must intervene.
`isStalled(a, cap)` and `isSchemaStalled(a, cap)` are the predicates;
`status.debts[].stalled` surfaces either; `blocked` deliberately excludes a
stalled loop (it isn't waiting on an input — it's out of attempts).

Held artifacts (`isHeld`, §20) also surface as `stalled: true` in
`workflowStatus.debts`. A held loop is not waiting on an input — it fired an
irreversible side effect and must not silently re-fire; a human must `retry` or
fix the upstream cause.

Clearing a stall:
- **`retry`** — reset *both* counters to 0 and re-owe the artifact (optionally
  with fresh guidance appended as a `retry` reason). The only path that resets
  the counters. Also clears the held condition: a `retry` appends a `'retry'`
  reason entry, so the last entry's `kind` is no longer `'invalidated-irreversible'`
  and `isHeld` returns false.
- **`retract`** — drop the member (collection elements).

## §7 The forward cascade (level-triggered)

A green output is green **only while** every input it consumed is still green and
unmoved. After any mutation, `settle()`:

1. **materializes** owed outputs of fired loops, and
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
- **§11.3** — the five-state lifecycle (above).
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

## §15 Completion

- **§15.1** — a workflow is `done` when no artifact is in a debt state.
- **§15.2 destructive completion** — a loop marked `terminal: true` produces an
  output whose green is irreversible (a merge, a publish). Once green it is never
  re-armed by the forward cascade, even if an upstream input later moves. This is
  the one place the level-trigger is deliberately overridden, because the side
  effect cannot be taken back. See §20 for `effect:`, the forward spelling for
  this contract that adds the `escalate` routing option and finer-grained control.

## §16 Generated outputs (`generates:`)

A loop may declare outputs it intentionally makes without any downstream consumer — audit
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
- **`terminal:` vs `generates:`:** `terminal: true` marks a whole loop as an intended
  sink and suppresses ALL dead-end warnings for it. `generates:` is more granular — it
  exempts specific output stems while leaving other outputs on the same loop subject to the
  normal dead-end check.
- **Validation:** a stem listed in both `produces:` and `generates:` on the same loop is a
  hard error. Two loops generating the same stem is a one-writer error (the same rule that
  applies to `produces:`).

## §17 Workflow outputs (`outputs:`)

A workflow may declare its public output stems — the leaves it intentionally produces as
its embedding interface — under a top-level `outputs:` field.

- **Lint exemption:** stems listed in `outputs:` are exempt from `deadEndWarnings`, as a
  third exemption alongside `terminal:` (loop-level) and `generates:` (loop-level). A
  declared public output is self-evidently an intentional leaf.
- **Re-armability:** unlike `terminal: true`, listing a stem in `outputs:` does NOT freeze
  re-arm. The cascade may re-arm an `outputs:`-listed artifact if its upstream inputs move.
- **Validation:** `validateDef` hard-errors if any `outputs:` entry names a stem that no
  loop produces. Stems declared under `generates:` are unioned into `produces` at build
  time and therefore count as produced — naming them in `outputs:` is valid.
- **Future use:** `outputs:` will become the boundary contract for workflow composition
  (`include:` / `calls:`). This wiring is not implemented yet.

Relationship of the three exemption mechanisms:

| key | level | lint-exempt | re-armable | primary purpose |
|---|---|---|---|---|
| `terminal: true` | loop | yes | no | destructive completion; green never re-armed |
| `generates:` | loop | yes | yes | internal intentional sink, not the public interface |
| `outputs:` | workflow | yes | yes | public interface / future composition boundary |

## §18 Derived status

`workflowStatus` is computed from artifact state on every call and never stored:

- `done` — no debts remain.
- `debts[]` — each non-green-owing artifact with its `acceptance`, `kind`
  (`judgment` / `validation` / `structural` / `unbuilt`), `stalled` flag, and
  latest `reason`.
- `eligible[]` — the firings that could run right now.
- `blocked[]` — loops that owe something but whose inputs aren't all green, with
  the specific non-green inputs holding them back (stalled loops excluded).

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
single `retry` resets *both* counters. `validateValue` is total — a schema that
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

A loop may declare `effect: { idempotent?, onInvalidate? }` to control how the
forward cascade routes when the loop's green artifact's inputs move to a new
version (§7).

- **§20.1 idempotent (default `true`)** — when `true`, re-deriving the artifact
  after inputs move is safe; the engine re-arms it (structural reject) exactly as
  it does for any non-terminal green today. When `false`, re-running the loop
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
  to `effect:` is deferred. They are mutually exclusive on the same loop
  (`validateDef` hard-errors if both are set).

- **§20.4 dead-input cascade is not gated by `effect:`** — when a non-idempotent
  artifact's input becomes settled-dead (retracted or skipped), the structural
  cascade (retract/skip) applies regardless of `effect:`. Only the moved-version
  re-arm path routes on `effect:`.

- **§20.5 convergence** — a `pin` op re-points the fingerprint to current input
  versions. On the next `maintainDecisions` pass, `fingerprintMatches` returns
  true for that artifact, so no op is generated — the cascade is stable after
  a single pass.

- **§20.6 named-handler routing** — `onInvalidate: <loopName>` routes
  invalidation to a compensating forward-action loop. When L's green artifact's
  input moves and L declares `effect: { idempotent: false, onInvalidate: 'H' }`:
  1. **Pin L** — L's artifact stays green; its fingerprint is re-pointed to the
     current input versions (exactly as `onInvalidate: 'pin'`). L does not
     re-fire.
  2. **Arm H** — H's produced outputs are materialized as `owed` if absent, or
     re-armed from `green` to `owed` if H has already fired once (D-C
     re-invalidation). H is a normal forward-producer loop — no new acceptance
     state; the engine sequences nothing beyond making H eligible.

  - **Armed-on-demand dormancy (D-A)** — H's outputs are NOT seeded `owed` at
    instance creation (`pendingOwed` skips handler loops). H is invisible to
    `eligibleFirings` until L is first invalidated. This avoids spurious firings
    on fresh instances where L's artifact has never greened.
  - **No-thrash (D-C)** — the `pin` op re-points L's fingerprint. On the very
    next `maintainDecisions` pass, `fingerprintMatches` returns true for L →
    no new pin, no new arm. `settle()` converges in at most two iterations.
  - **Re-invalidation (D-C re-arm)** — if the input moves again after H has
    greened, L's new fingerprint mismatches → pin L again + arm H again. The
    `arm` op finds H's output green and re-arms it to `owed`. H re-fires.
  - **D-D validation** — `validateDef` enforces: the handler loop must exist in
    the same workflow; the handler must not be the same loop (no self-handler);
    the handler must produce at least one output (otherwise `arm` would write
    no artifact to the store, creating no debt and no eligibility).
  - **§20 table extension**:

  | key | idempotent | onInvalidate | cascade behavior on input move |
  |---|---|---|---|
  | _(none)_ or `effect: { idempotent: true }` | true | — | re-arm (structural reject) |
  | `effect: { idempotent: false, onInvalidate: 'pin' }` | false | pin | stay green, re-point fingerprint |
  | `effect: { idempotent: false, onInvalidate: 'escalate' }` | false | escalate | reject-and-hold; stalled |
  | `effect: { idempotent: false, onInvalidate: '<H>' }` | false | loopName | pin original + arm H (D-A/D-B) |
  | `terminal: true` | false | pin | stay green + lint-exempt (legacy) |

  Cross-reference: §6.1 resolution 2; §6.6 (this is forward-action
  compensation, not auto-redo of the irreversible step).

## §21 Firing rules and the completion evaluator (`on:`)

Every loop today is implicitly `on: [inputsGreen]` — fire when consumed inputs are green. `on:` makes the firing trigger explicit.

- **§21.1 `inputsGreen` (default)** — the existing behaviour, unchanged. A loop whose `on:` is omitted, or explicitly set to `['inputsGreen']`, fires exactly as today.
- **§21.2 `allGreen`** — the loop fires when the workflow is all-green: no outstanding debts among all artifacts *except the evaluator's own produced outputs* (bootstrap exclusion). Fires immediately on all-green (no delay — the `idle` trigger, which waits, is a planned follow-up, PR3b).
- **§21.3 Bootstrap exclusion** — the evaluator's own owed `outcome` is not counted among the debts in the all-green check. Without this, the evaluator's firing could never be triggered (its own debt would prevent all-green).
- **§21.4 Fall-out-of-done re-arm** — once `outcome` is green (done), if the workflow later falls out of all-green (a new debt appears — e.g. a re-provided input re-arms an upstream artifact), `maintainDecisions` detects that `outcome` is green but all-green no longer holds, and emits a structural reject to re-arm `outcome`. When the workflow returns to all-green, `eligibleFirings` offers the evaluator again. This is stable: `maintainDecisions` only emits the op when the workflow is NOT all-green but `outcome` IS green. After the reject is applied, `outcome` is a debt — the op is not re-emitted.
- **§21.5 Trigger-cause** — the engine threads the cause ('allGreen') onto the `Firing`, the `RunData`, and the `Order`. A worker can read `order.cause` to branch behaviour (e.g. inspect status, green `outcome`, message a human).
- **§21.6 One `outcome` output** — the evaluator loop produces exactly one singleton `outcome` artifact. This is the embedding boundary contract (§17): the outer workflow or teardown step consumes the child's `outcome`.
- **§21.7 The `idle` trigger** — landed in PR3b. See §21.8 below.
- **§21.8 `idle` trigger** — a loop with `on: ['idle']` (or `on: ['allGreen', 'idle']`) fires when the workflow is quiescent and a time threshold has elapsed. Eligibility requires: (a) the workflow is NOT all-green (allGreen owns the done condition — idle must not race it), (b) no run is in-flight (any claimed, lease-fresh task blocks idle; R12), and (c) `now >= threshold` where `threshold` is determined by §21.9–§21.10. When eligible, `eligibleFirings` emits a `Firing` with `cause: 'idle'`. The loop must declare `idleAfter` (a duration string, e.g. `"30m"`); omitting `idleAfter` when `'idle'` is in `on:` is a hard `validateDef` error.
- **§21.9 Sliding window (relative alarm)** — by default the threshold is `last_progress + idleAfterMs`. `last_progress` is derived as `MAX(artifact.updated_at)` across all artifacts of the workflow (query: `SELECT MAX(updated_at) FROM artifact WHERE workflow = ?`, fallback 0 if none). Every artifact state change goes through `putArtifact`, which stamps `updated_at = nowMs()`, so `last_progress` reliably captures the most recent forward-progress event. Artifact births (owed materialisation), greens, and rejects all advance it. The window slides: if the workflow makes progress, the clock resets.
- **§21.10 Absolute alarm (override)** — a worker or external scheduler may call `engine.setAlarm(workflow, loop, at)` to set an absolute wake-up time. This writes `alarm_at` (ms epoch) to the `task` row for `(workflow, loop, key='')` and survives process restart (SQLite-persisted). When `alarm_at` is set, `threshold = alarm_at` takes precedence over the relative fallback. The alarm is consumed (cleared) by the engine when the idle firing is selected — a worker that wants a recurring heartbeat must call `setAlarm` again inside its body. `clearAlarm(workflow, loop)` sets `alarm_at = NULL`.
- **§21.11 `setAlarm` / `clearAlarm`** — engine-level API. `engine.setAlarm(workflow, loop, at: number)` and `engine.clearAlarm(workflow, loop)` are thin wrappers over `store.setAlarm` / `store.clearAlarm`. The store methods upsert the task row if it does not yet exist (evaluator loop may not have been ticked yet). `store.getAlarm(workflow, loop)` returns the current `alarm_at` or `undefined`.
- **§21.12 Heartbeat re-arm** — once an idle firing greens `outcome`, the alarm is cleared. If the evaluator body calls `setAlarm` to schedule a follow-up, the engine's `maintainDecisions` call inside `settle` detects (on the next tick) that `outcome` is green and `idleEligible` is true (the new alarm elapsed), and emits a structural `reject` re-arm on `outcome`. This arms the idle loop again without any extra state. Without a new alarm, and with `now < last_progress + idleAfterMs`, `idleEligible` returns false — no re-arm, no thrash.
- **§21.13 Purity discipline** — `src/model.ts` is clock-free. `eligibleFirings` and `maintainDecisions` accept an optional `TimeFacts` bag `{ now, lastProgressMs, inFlight, alarms }` as their third parameter. All clock reads happen at the engine boundary (`opts.now ?? nowMs()` in `engine.ts`). `TimeFacts` is assembled by `engine.computeTimeFacts` (a private method) before calling into the model. For a fixed `(arts, TimeFacts)` pair, `eligibleFirings` and `maintainDecisions` are deterministic and idempotent. `src/model.ts` imports no timer, no `Date`, and no `nowMs` — the purity is structural, not a convention.
