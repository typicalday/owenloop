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

### §4.1 Invalidation authority

A `reject` is an exercise of authority, and authority follows the consume edge:
**only a loop that consumes an artifact's stem (or a human/engine) may
judgment-reject it** (`assertAuthority`). A loop cannot dirty an artifact it has no
relationship with — this keeps a many-loop graph's feedback aligned with its
dataflow, and it is a one-line rule.

The consequence for *authoring* is that `consumes` is **dual-purpose**. It declares a
loop's inputs (the firing gate and fingerprint, §3/§7) **and** the set of artifacts
the loop may send back. So to give a step the power to invalidate an artifact, make
it consume that artifact — *even when the step only judges the artifact rather than
transforming it*. The merger consuming `pr` is the canonical case: it lands the PR
and judges its mergeability, so a merge conflict is a legitimate judgment-`reject` of
`pr`, and the authority to issue it comes from the consume edge. A consume edge
declared only for authority is harmless to the firing rule: an input that is always
green by the time the loop fires (because it is upstream of the loop's other inputs)
never changes when the loop becomes eligible.

This governs *judgment* rejects only. The engine's own **structural** re-arm when a
consumed input moves version (§7) is mechanical propagation, not a judgment, and is
performed by the engine without an authority check.

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

## §22 Mode 1 compile-time workflow composition (`include:`)

A pure `defs.ts` feature — zero engine change. The loader produces an expanded `WorkflowDef` with the child's loops spliced in, stems prefixed, and inputs mapped or hoisted. The engine sees one flat graph.

### §22.1 Grammar

```yaml
loops:
  - include: <defName>      # child workflow name
    as: <prefix>            # namespace token; must match ^[a-z][a-zA-Z0-9_-]*$
    inputs:                 # optional: map child seedOwed inputs
      <childInputName>: <outerArtifactName>
```

### §22.2 Expand-then-validate pipeline

1. `buildDef` parses include directives from the loop list into `WorkflowDef._includes`, leaving them out of `loops`.
2. `expandIncludes(def, resolve)` splices the prefixed child loops in place of each directive (M1-EXPAND).
3. `validateDef` runs on the expanded flat def — catching cross-boundary dangling consumes, two-producer conflicts, map/reduce shape errors, and cycles for free.

### §22.3 Prefixing semantics

Every child artifact and loop name is prefixed with `${as}.`:
- Loop name: `planner` → `deliver.planner`
- Produce stem: `plan` → `deliver.plan`
- Consume stem: `plan` → `deliver.plan`
- Collection stem `source[]` → `deliver.source[]` (seal and elements derived correctly from the prefixed stem)
- `invalidates` entries prefixed
- `effect.onInvalidate` loop-name strings prefixed (but not `'pin'`/`'escalate'`)

### §22.4 Input rewiring

- **Mapped** (`inputs: { childInput: outerArtifact }`): the child input is not added to the parent's inputs. Every consume referencing `${as}.${childInput}` is rewritten to `outerArtifact`. The rewrite is a plain consume to an existing outer artifact (input or produce); the existing validator checks the reference for free.
- **Unmapped**: the child input is hoisted as `${as}.${childInput}`, preserving `seedOwed`, `producer`, and `schema`.

### §22.5 Recursion and cycle guard

`expandIncludes` maintains an include stack. If a def name appears already on the stack, it throws `DefError: include cycle: <a> -> <b> -> <a>`.

### §22.6 Dev-tooling note (deferred)

Mode 1's name-prefixing (`deliver.plan`, `deliver.merge`) affects `dev` tooling that keys on loop names (worktree wiring, dashboard rendering, fleet shape-matching). Making those prefix-aware is deferred to the dev-tooling PR. Mode 1 v1 is the right tool for **brand-new combined workflows** authored fresh; not for re-skinning an existing delivery line (use Mode 2 for that).


---

## §23 Mode 2 runtime workflow composition (`calls:`)

Mode 2 is the **runtime** sibling of Mode 1 (`include:`). Instead of inlining a child workflow's loops at compile time, a `calls:` loop declares that a **separate child workflow instance** produces one of the parent's artifacts at runtime. The `calls:` loop is machine-handled — it never emits a worker order.

> **PR5a** delivers the static foundation: grammar, validation, the cross-def cycle check, the `producedBy` parent-coordinate link, and `eligibleFirings` exclusion. **PR5b** will add the runtime cascade-up behavior (spawn-on-eligible, cross-boundary outcome read, machine-green, re-attach, re-provide).

### §23.1 Grammar

```yaml
name: provisioned-delivery

inputs:
  - name: proposal
    seedOwed: true

loops:
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
- `inputs:` keys must be declared inputs of the child workflow; values must be parent artifact names (inputs or loop produces).
- `produces:` must declare exactly one artifact (the parent artifact the child outcome feeds).
- A `calls:` loop must NOT have a `body:` (it is machine-handled).

### §23.2 `producedBy` parent-coordinate link

When PR5b spawns a child instance, it passes `producedBy: { parentWf, parentPath }` to `createInstance`, which persists it via the store. The coordinate serves three duties:

1. **Re-attach on reap**: when a child run is reaped, the engine re-attaches via the stored link.
2. **Reverse lookup**: `store.findChildByParent(parentWf, parentPath)` — the never-duplicate guard in PR5b.
3. **Cascade-up anchor**: the engine reads `producedBy` to propagate the child's outcome to the parent.

**Storage**: two nullable columns on the `workflow` table — `produced_by_wf TEXT` and `produced_by_path TEXT` (both null for a top-level instance). Two columns (not a JSON blob) because the reverse lookup `(parentWf, parentPath) → child` must be SQL-indexable. The index `workflow_produced_by ON workflow(produced_by_wf, produced_by_path)` makes the lookup O(1). Added by the additive migration in `store.migrate()` (schema version 3).

### §23.3 calls: loops are machine-handled

- **Excluded from `eligibleFirings`**: `model.ts` skips any loop with `loop.calls` set. No worker order is ever emitted for a `calls:` loop.
- **Owed artifact seeded normally**: `pendingOwed` seeds the calls: loop's one declared `produces` stem as owed at instance start (same code path as normal singleton produces).
- **Debt/done correctness**: an owed calls: artifact is a normal debt. The parent workflow is not done until the calls: output is green (same logic as any other owed artifact — no special casing needed).

### §23.4 Cross-def calls-cycle check

At `loadDefs` time, after all defs are expanded and per-def validated, `detectCallsCycles(defs)` performs a DFS over the `calls:` edge graph and throws `DefError: calls cycle: a -> b -> a` if a cycle exists.

This check is **separate** from the include-cycle guard in `expandIncludes` (§22.5) — they walk different edge kinds (`calls:` vs `include:`). An include cycle and a calls cycle can coexist independently and are reported with different messages (`calls cycle:` vs `include cycle:`).

### §23.5 `createInstance.producedBy`

`CreateOpts` gains `producedBy?: { parentWf: string; parentPath: string }`. When present, `createInstance` passes it to `insertWorkflow`, which stores both columns. No other behavior changes in PR5a — the field is wired end-to-end (store → engine → opts) so PR5b can call `createInstance({ producedBy })` without touching those layers.

### §23.6 Runtime cascade-up (PR5b)

PR5b ships `maintainCalls` in `engine.ts` — the engine-internal method that drives the calls: lifecycle. All cross-instance behavior lives in the engine only; `model.ts` stays pure single-instance.

#### §23.6.1 `maintainCalls` algorithm

Called at the top of every parent `tick` (outside any transaction) and as a cascade-up prompt after child progress. For each `calls:` loop in the parent def:

1. **Gate check**: `gateStems = Object.values(callsInputs)` (parent artifact names wired to child inputs). Gate is ready when every gate stem is green.
2. **Re-attach guard**: `findChildByParent(parentWf, callsPath)` — spawn only when no child exists (`undefined`). This prevents duplicate children across crashes and re-ticks.
3. **Spawn**: if gate is ready and no child, `createInstance(loop.calls, { producedBy, provide: gateValues })`. The parent calls: artifact stays `owed`.
4. **Outcome read**: read the child's declared `outputs:` artifact (exactly one, validated at load time). If it is green, machine-green the parent's calls: artifact.
5. **Re-provide**: for each `callsInputs` mapping, if the parent's value differs (deep-equal) from what the child holds, `provideInput(child, inputName, newValue)`. The child re-runs internally.
6. **Machine-green**: set parent calls: artifact to `acceptance: 'green'`, `version + 1`, `value = child outcome value`, `fingerprint = computeFingerprint(parentArts, gateStems)`. Then `settle(parentWf)` so downstream (teardown) fires. Do NOT set `terminal` — the calls: artifact must be re-armable if gate inputs move.
7. **Re-arm on child working**: if the child's outcome is no longer green (e.g. re-provide re-armed it) but the parent calls: artifact is green, re-arm the parent calls: artifact to `owed`. This handles gate re-arm correctly even though `deliver` loop has `consumes: []` (the pure cascade cannot detect fingerprint mismatch for calls: loops).

#### §23.6.2 Cascade-up prompt

After a child `green` or `close`, `triggerParentIfChild(childWf)` reads the child's `producedBy` link and calls `maintainCalls(parentWf)`. This propagates the child's outcome to the parent immediately, instead of waiting for the next scheduled tick. Durability is free regardless: even without the prompt, the next parent tick calls `maintainCalls` and reads the persisted child outcome. The recursion guard (`_inMaintainCalls: Set<string>`) prevents `maintainCalls → provideInput → fireSettled → triggerParentIfChild → maintainCalls` infinite loops.

#### §23.6.3 `outputs:` as embedding interface

A workflow that can be called via `calls:` must declare exactly one `outputs:` stem (validated at `loadDefs` Phase 2). The called workflow's `outputs:[0]` is the artifact whose value is reflected up to the parent's calls: artifact when it greens. The `delivery` workflow declares `outputs: [merge]` — its merge artifact is the public outcome. A parent `calls: delivery` receives the merge value in its `delivered` artifact.

#### §23.6.4 Failure branch

A child that greens its declared outcome with a status-bearing value (e.g. `{status: 'failed'}`) propagates that value up unchanged. The parent's calls: artifact greens with the failure status, and teardown (or other consumers) receives it through the normal green gate. Teardown runs on success AND failure — there is no special consume mode for failure.

#### §23.6.5 Gate fingerprint and re-arm

The machine-green fingerprint covers only `gateStems` (the parent artifacts wired into the child via `callsInputs`). The child-outcome version is intentionally NOT included in the fingerprint — `fingerprintMatches` uses a key-count check that would fail if the child version key count differs from the gate stem count. The child-outcome re-green trigger is handled by `maintainCalls` value comparison (`deepEqual`), not by the pure cascade.

#### §23.6.6 Transaction composition

`maintainCalls` runs OUTSIDE any open `store.tx()`. Each mutating action (spawn via `createInstance`, re-provide via `provideInput`, machine-green) opens its own `store.tx()`. No nested transactions — better-sqlite3 does not support nested `BEGIN IMMEDIATE`.

#### §23.6.7 Deferred

- **Live cross-instance addressing** (`<step>.<child-path>` syntax) — §4.7 O7.
- **GC of orphaned children** on parent delete — §4.8 D3.
- **Fan-out / many-output children** — D1/D2. The v1 one-output rule is enforced.
