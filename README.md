# oweflow

[![CI](https://github.com/typicalday/oweflow/actions/workflows/ci.yml/badge.svg)](https://github.com/typicalday/oweflow/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A generic **dataflow workflow engine**. Steps don't have a status — they have
*debts*. A step becomes eligible to run purely because of the state of the
artifacts it consumes and produces, never because something flipped it to
"ready". That one inversion buys you a lot: knock-backs, fan-out/fan-in, and
"keep everything downstream honest when an upstream input changes" all fall out
of the same rule instead of being special-cased.

The engine is **domain-neutral**. It doesn't know what a "PR" or a "source" or a
"report" is. A concrete process — software delivery, research synthesis, triage
— is just a *wiring*: a set of workflow definitions (YAML) plus a worker that
executes the orders the engine hands out. The `oweflow` CLI is the seam between
the two: it speaks JSON on stdout so any worker can drive it.

```
                 wiring (YAML defs + a worker)
   ────────────────────────────────────────────────────────
   oweflow CLI   ──tick──►  orders  ──run──►  green / reject
   ────────────────────────────────────────────────────────
                 engine (debt model + forward cascade + CAS)
                 store  (better-sqlite3, WAL + commit CAS)
```

---

## The idea in one minute

A workflow is a graph of **loops** (steps) connected by the **artifacts** they
`consumes` and `produces`:

```yaml
loops:
  - name: planner
    consumes: [proposal]
    produces: [plan]
  - name: builder
    consumes: [plan]
    produces: [pr]
```

Every artifact sits in one of **five states**:

| state       | debt? | meaning                                                            |
|-------------|:-----:|-------------------------------------------------------------------|
| `owed`      |  yes  | declared but not built yet, or re-armed — the producer owes it     |
| `green`     |  no   | accepted; satisfies everyone who depends on it                    |
| `rejected`  |  yes  | built, then judged unfit (or structurally re-armed) — a debt       |
| `retracted` |  no   | a consumer dropped a collection member; terminal, leaves the set   |
| `skipped`   |  no   | a producer declined its own output on a dead branch                |

A loop is **eligible** to fire when it owes a debt (an `owed`/`rejected` output)
*and* every input it consumes is `green`. That's the whole scheduler. There is
no "status" column anywhere — `status` is derived from artifact state on every
read.

Three things make this more than a topological sort:

- **Forward cascade (level-triggered).** A green output is green *only while*
  every input it was built from is still green and unmoved. Re-plan the `plan`
  and the `pr`, its `verdict`, and the final `merge` all silently fall back to
  debts — no orchestration code required.
- **Reason threads.** A `reject` carries text. The next order for that artifact
  shows the accumulated `reasons`, so the worker knows *why* it's being asked
  again. Rejections come in three kinds: **judgment** (a consumer's verdict),
  **validation** (a produced value failed the artifact's declared JSON Schema —
  the engine's own refusal), and **structural** (engine bookkeeping from a
  cascade). Judgment and validation rejects count against liveness on separate
  counters; structural ones never do.
- **Schema validation (§19).** An artifact may declare a `schema:` (full JSON
  Schema draft 2020-12). A produced value is accepted only if it validates;
  otherwise the commit is refused (**schema-rejected**) with the violations
  attached, the value never greens, and the worker can correct it on the same
  open run. Shape is the engine's business; *meaning* stays a consumer's
  judgment.
- **Stalls (liveness, §6/§19).** If an artifact is judgment-rejected more than
  its loop's `maxAttempts` — or schema-rejected more than its `maxSchemaFailures`
  — the engine **stops re-arming it**. It stays a debt but no longer produces
  orders — the loop has demonstrably failed and a human is needed. `oweflow
  retry` resets both counters (optionally with new guidance); `oweflow retract`
  drops it (for collection members).

Collections add fan-out/fan-in:

- A loop can `produce` a **collection** (`gather.source[]`): it `emit`s an
  unknown number of elements, then `seal`s it.
- A **map** consume (`gather.source[$i]`) fires one run per element.
- A **reduce** consume (`gather.source[*]`) fires once, eligible only when the
  collection is sealed *and* every non-retracted member is green.

---

## Requirements

- **Node ≥ 22.6** — oweflow runs TypeScript directly via Node's native type
  stripping. There is no build step. (Developed on Node 25.)
- Runtime deps: `better-sqlite3` (storage), `yaml` (defs), and
  `@cfworker/json-schema` (artifact schema validation, §19) — all
  zero- or low-transitive.

```sh
git clone <repo> oweflow && cd oweflow
npm install
npm run check     # typecheck + full test suite
```

Or consume it as a dependency — oweflow ships its TypeScript source (no build
step), so the importing project just needs a Node ≥ 22.6 ESM host with
type-stripping (on by default in 23.6+):

```sh
npm install oweflow
```

```ts
import { createEngine } from 'oweflow';   // see "Programmatic / embedding" below
```

---

## Quick start

The bundled examples live in [`examples/workflows`](examples/workflows), each
demonstrating one idea: [`delivery`](examples/workflows/delivery.yaml)
(knock-backs), [`research`](examples/workflows/research.yaml) (collections),
[`routing`](examples/workflows/routing.yaml) (skip-cascade),
[`intake`](examples/workflows/intake.yaml) (schema validation, §19), and
[`sla-watchdog`](examples/workflows/sla-watchdog.yaml) (idle trigger, completion
evaluator, alarm — §21). Point
oweflow at them and drive one end to end. Every data command prints JSON, so the
snippet below pipes through `jq`.

```sh
export OWEFLOW_DEFS=examples/workflows
export OWEFLOW_DB=/tmp/oweflow-demo.db

oweflow defs                                  # what workflows are available

# start an instance; `proposal` is a seedOwed input so we provide it up front
wf=$(oweflow create delivery \
       --provide proposal='{"text":"add dark mode"}' | jq -r .workflow)

# the wiring/worker loop: tick → run → report
run=$(oweflow tick $wf | jq -r '.orders[0].run')   # claim the `planner` order
oweflow green  $wf $run plan --value '{"plan":"…"}' # report its output

oweflow status $wf                            # debts / eligible / blocked / done
```

`oweflow` here is `node bin/oweflow.mjs` — either run that directly, use the
`npm run oweflow --` script, or `npm link` to put `oweflow` on your PATH.

A **knock-back**: when an order for `reviewer` comes up, instead of greening its
`verdict` you can reject the PR —

```sh
oweflow reject $wf pr --by reviewer --text "tests are missing"
```

— which re-arms `builder` with that reason attached to its next order's `owes`.
Do it past `builder`'s `maxAttempts` and `pr` **stalls**; `oweflow retry $wf pr
--text "use the new fixture"` clears it.

The [`research`](examples/workflows/research.yaml) example demonstrates the
collection path (`emit` / `seal` / map / reduce / `retract`), and
[`intake`](examples/workflows/intake.yaml) demonstrates **schema validation**
(§19) — every artifact pins its shape, so a malformed `green`/`emit`/`provide`
is refused at commit. Each example's header comment walks through the commands.

---

## CLI reference

Global: `--db <path>` (env `OWEFLOW_DB`, default `.oweflow/state.db`) and
`--defs <dir>` (env `OWEFLOW_DEFS`, default `./workflows`).

| command | what it does |
|---|---|
| `defs` | list available workflow definitions |
| `create <def> [--title t] [--provide name=json …] [--param k=v …]` | start an instance; prints `{workflow}` |
| `provide <wf> <name> [--value json]` | supply a `seedOwed` input after the fact |
| `tick <wf> [--now <ms>]` | claim and emit eligible **orders** (the work to run) |
| `status <wf>` | derived view: `done`, `debts`, `eligible`, `blocked` |
| `show <wf>` | dump raw artifacts (debugging) |
| `list` | list instances |
| `green <wf> <run> <path> [--value json] [--terminal]` | accept an owed output |
| `emit <wf> <run> --items '[{…},{…}]'` | accrete collection elements |
| `seal <wf> <run> [--value json]` | mark a collection complete |
| `reject <wf> <path> --by <author> --text <msg>` | judgment-reject (re-arms producer) |
| `retract <wf> <path> --by <author> --text <msg>` | drop a collection member |
| `skip <wf> <path> --by <author> --text <msg>` | producer declines its own output |
| `retry <wf> <path> [--by a] [--text guidance]` | clear a §6 stall, reset the counter |
| `close <wf> <run> [--outcome ok\|no_work\|failed\|skipped] [--summary s]` | release a claimed run's lease |
| `delete <wf>` | delete an instance and all its rows |

### The order shape (what a worker consumes)

`tick` returns `{ workflow, orders, reaped }`. Each order is self-contained:

```jsonc
{
  "run": "r_…",            // lease id — pass back to green/emit/seal/close
  "loop": "builder",
  "key": "",               // map orders carry the element key + index
  "inputs":  ["plan"],
  "outputs": ["pr"],
  "prompt":  "…body with ${WORKFLOW}/${RUN}/${INDEX} substituted…",
  "consumes": { "plan": { /* captured green handle */ } },
  "owes": [                // the feedback channel
    { "path": "pr", "acceptance": "rejected", "judgmentRejects": 2, "schemaRejects": 0,
      "reasons": [ { "action": "reject", "kind": "judgment", "by": "reviewer",
                     "text": "tests are missing", "at": 0 } ] }
  ]
}
```

A worker reads `prompt` + `consumes` + `owes`, does the work, then reports the
result with `green` (or `emit`/`seal` for collections), and finally `close`s the
run. `owes[].judgmentRejects` (and `owes[].schemaRejects`, §19) let a wiring
escalate (e.g. switch to a stronger
model) before the engine stalls the artifact.

---

## Programmatic / embedding

The CLI is a thin adapter — it maps `argv` to engine calls and prints JSON. The
engine itself is an ordinary class, so you can drive it **in-process** and get
the same lifecycle back as typed objects (`Order`, `CommitResult`,
`WorkflowStatus`) instead of JSON on stdout — no subprocess, no parsing. The
[`oweflow`](package.json) package's entry point exports everything you need.

`createEngine` bundles the store + definition wiring into one call:

```ts
import { createEngine } from 'oweflow';

const { engine, store } = createEngine({
  db: '.oweflow/state.db',          // or ':memory:' for an ephemeral instance
  defsDir: 'workflows',             // load YAML defs from a dir … or pass `defs: [myDef]`
});

// start an instance (proposal is a seedOwed input, so provide it up front)
const wf = engine.createInstance('delivery', {
  provide: { proposal: { text: 'add dark mode' } },
});

// the wiring/worker loop: tick → run → report
const { orders } = engine.tick(wf);
for (const order of orders) {
  const result = await runYourWorker(order);            // ← your domain
  engine.green(wf, order.run, order.outputs[0], result); // typed CommitResult back
  engine.close(wf, order.run);
}

engine.status(wf);   // a typed WorkflowStatus: done / debts / eligible / blocked
store.close();        // on shutdown
```

Prefer to **react** instead of poll? `engine.subscribe(listener)` (or
`createEngine({ onEvent })`) pushes a typed `EngineEvent` the instant a mutation
commits — re-`tick` only when there's new eligible work, or resolve a promise
when the workflow is `done`. See [`examples/events.ts`](examples/events.ts).

The `engine`/`store` are meant to be long-lived (one per database). Concurrency
is the store's: better-sqlite3 is synchronous and single-writer-per-process,
with cross-process advancement made safe by the commit-fingerprint CAS — a good
fit for an embedded control-plane. See [`docs/embedding.md`](docs/embedding.md)
for the full surface, lifecycle, events, and trade-offs.

---

## Workflow definition format

A workflow is one self-contained YAML file under the `--defs` directory (either
`name.yaml`, or `name/workflow.yaml`). It is parsed, type-checked, and
**statically validated** before any instance is created — dangling consumes, two
producers for one artifact, map/reduce shape mismatches, and dependency cycles
are all caught up front.

```yaml
name: delivery                 # required; [a-z0-9][a-z0-9_-]*
title: Software delivery       # optional
description: …                 # optional

inputs:                        # external artifacts, seeded when an instance starts
  - name: proposal
    seedOwed: true             # true → starts owed (must be `provide`d to unblock)
    producer: human            # optional label for who supplies it (default: human)
    schema:                    # optional JSON Schema (2020-12); a `provide`d value
      type: object             #   that violates it is refused (§19)
      required: [text]

outputs:               # optional; workflow-level public leaves / embedding interface
  - summary            #   lint-exempt from dead-end warnings; must be produced by a loop;
  - outcome            #   does NOT freeze re-arm (unlike terminal: true)

loops:
  - name: planner
    consumes: [proposal]       # plain | map (src[$i]) | reduce (src[*])
    produces:                  # singleton | collection (src[]) | map (src[$i].x)
      - name: plan             # a produce may be a bare name, or {name, schema}:
        schema:                #   a green/emit whose value fails this is refused (§19)
          type: object
          required: [plan]
          properties: { plan: { type: string } }
    body: |                    # prompt; ${WORKFLOW} ${RUN} ${INDEX} are substituted
      Read the proposal and produce a `plan`.

    generates:                 # optional; outputs this loop intentionally makes but
      - audit_log              #   NO consumer is expected. Lint-exempt from dead-end
      - report[]               #   warnings. Engine behavior identical to produces:.

    # all optional, with defaults:
    maxAttempts: 3             # judgment-reject cap before the output stalls (§6)
    maxSchemaFailures: 5       # schema-reject cap before the output stalls (§19); 0 = off
    parallel: 1                # max concurrent runs (raise it to fan out a map)
    terminal: false            # true → a green output is a destructive completion,
                               #        never re-armed by the cascade (§15.2)
    effect:                    # optional; loop-level effect contract (§20)
      idempotent: true         #   true (default): safe to re-derive if inputs move → re-arms normally
                               #   false: loop fires irreversible side effects; do not re-fire silently
      onInvalidate: escalate   #   consulted only when idempotent: false
                               #   'pin'      → keep green, re-point fingerprint (stays up-to-date)
                               #   'escalate' → reject-and-hold; stall requires human intervention
                               #   Named-handler strings are a planned follow-up (hard error today)
    on: [inputsGreen]          # optional; firing trigger (§21). Values:
                               #   'inputsGreen' (default) — fire when consumed inputs are green
                               #   'allGreen'               — fire when workflow is done (completion evaluator)
                               #   'idle'                   — fire when quiescent past idleAfter threshold (§21.8)
                               #   Omit for classic inputsGreen behaviour; on:[] is a hard error.
    idleAfter: 30m             # required when 'idle' is in on:; duration string (e.g. "30m", "2h")
    invalidates: [plan]        # which input stems this loop may invalidate
                               #   (default: its consumed stems)
    cadence: "0s"              # min spacing between runs (e.g. "30m")
    maxRunsPerDay: 1000
    model: …                   # opaque hint passed through on the order
    workdir: main              # opaque hint passed through on the order
```

**Completion evaluator example:**

```yaml
- name: completion
  on: [allGreen]           # firing trigger: fires when the workflow is done
  generates: [outcome]     # evaluator's outcome — lint-exempt, public interface
  body: |
    # runs when the workflow is done; inspect and green outcome
```

### `produces:` vs `generates:`

A stem under `produces:` is expected to be consumed downstream; oweflow lint warns if it
isn't. A stem under `generates:` is intentionally consumed by nothing (an audit log, an
external artifact, or a dev-branch stub); lint leaves it alone. Generated artifacts are
identical to produced ones in every other respect: schema-validated, fingerprinted,
greenable, and visible in `status`/`show`/`trace`/`graph`.

### `outputs:` — the workflow interface

A top-level `outputs:` field declares which stems are this workflow's intentional public
leaves — the artifacts a parent workflow will later consume when this one is embedded
(`include:`/`calls:`, future feature). A stem listed in `outputs:` is exempt from
dead-end warnings (a third exemption alongside `generates:` and `terminal: true`), but
unlike `terminal:` it stays re-armable.

| key | level | lint-exempt | re-armable | meaning |
|---|---|---|---|---|
| `terminal: true` | loop | yes | **no** | destructive completion; never re-armed |
| `generates:` | loop | yes | yes | internal intentional sink, not the public interface |
| `outputs:` | workflow | yes | yes | public interface / future composition boundary |

Validation: every stem in `outputs:` must be produced by at least one loop (stems under
`generates:` count, since they are unioned into `produces` at build time).

### Workflow composition (Mode 1 — compile-time `include:`)

A loop-list entry may be an `include:` directive to splice another workflow's loops in at compile time (def-load time). This is pure `defs.ts` — zero engine change. The engine sees one expanded flat graph.

```yaml
name: full-cycle
inputs:
  - name: proposal
    seedOwed: true
outputs:
  - torn_down
loops:
  - name: provision
    consumes: [proposal]
    produces: [environment]
  - include: delivery           # splice delivery's loops in
    as: deliver                 # prefix: deliver.planner, deliver.plan, deliver.merge …
    inputs:
      proposal: proposal        # map child's seedOwed input to outer 'proposal' artifact
  - name: teardown
    consumes: [environment, deliver.merge]   # consume the inlined child artifact directly
    produces: [torn_down]
```

After loading, the expanded def's loops are:
`provision`, `deliver.planner`, `deliver.builder`, `deliver.reviewer`, `deliver.merger`, `teardown` — one flat instance, one cascade, one completion evaluator.

**Grammar rules:**
- `as:` is required; must match `^[a-z][a-zA-Z0-9_-]*$`; must be unique across all includes in the same parent; must not equal any sibling loop name.
- `inputs:` is optional; each key must be a real input of the child def.
- `include:` must name a workflow present in the same def directory.

**Semantics:**
- **Mapped inputs** (`inputs: { childInput: outerArtifact }`) become internal consume edges — `outerArtifact` is an existing artifact in the parent (input or produce), checked by `validateDef`.
- **Unmapped inputs** are hoisted as `${as}.${childInput}` outer inputs, preserving `seedOwed` and schema.
- **Collection loops** in the child prefix correctly: `source[]` → `deliver.source[]`; seal and element paths follow from the prefixed stem.
- **Nested includes** work recursively; cycles are a hard error.

**Constraint:** Mode 1 inlines the child's namespace into the parent. Use it for **brand-new combined workflows** where no downstream tooling expects the old loop names. The existing `delivery` workflow's loops (`planner`, `builder`, `reviewer`, `merger`) become `deliver.planner` etc. — correct for a new `full-cycle` workflow, but would break `dev` tooling that expects the original names. For embedding an existing workflow as an encapsulated unit, use Mode 2 (`calls:`).

### Workflow composition (Mode 2 — runtime `calls:`)

Mode 2 is the **runtime** sibling of Mode 1. Instead of inlining a child workflow's loops at compile time, a `calls:` loop delegates to a **separate child workflow instance** at runtime. The calls: loop is machine-handled — it never emits a worker order.

PR5b (this PR) delivers the full runtime behavior: spawn, cascade-up, outcome propagation, re-attach, and re-provide. The `provisioned-delivery` example is now drivable end-to-end.

```yaml
# delivery.yaml — the called workflow declares one public output
name: delivery
outputs: [merge]             # embedding interface: merge is the public outcome

inputs:
  - name: proposal
    seedOwed: true

loops:
  - name: planner
    consumes: [proposal]
    produces: [plan]
    # ...
  - name: merger
    consumes: [verdict]
    produces: [merge]
    terminal: true
```

```yaml
# provisioned-delivery.yaml — the parent calls delivery
name: provisioned-delivery

inputs:
  - name: proposal
    seedOwed: true

loops:
  - name: provision
    consumes: [proposal]
    produces: [sandbox]
    body: Provision environment.

  - name: deliver
    calls: delivery          # child workflow name (must exist in the same def directory)
    inputs:                  # child input name → parent artifact name (gate: sandbox green)
      proposal: proposal
    produces: [delivered]    # exactly one parent artifact; greens when delivery.merge greens

  - name: teardown
    consumes: [delivered]
    produces: [torn_down]
    terminal: true
    body: Tear down and green `torn_down`.
```

Runtime behavior (all engine-internal, zero event bus, zero new subsystem):
1. **Spawn**: when gate inputs (parent artifacts in `inputs:`) are green, `maintainCalls` creates the child instance with `producedBy` and seeds its declared inputs.
2. **Re-attach**: `findChildByParent(parentWf, callsPath)` — spawn is guarded; if a child already exists (crash/re-tick), it is re-attached rather than duplicated.
3. **Cascade-up**: when the child's declared `outputs:` artifact greens, the engine machine-greens the parent's calls: artifact (no worker run, no CAS). Durability is via the persisted `producedBy` link — even without the prompt, the next parent tick reads the child outcome.
4. **Re-provide**: if a mapped gate input moves to a new version/value, the engine re-provides it to the existing child (the child re-runs internally). No second child is spawned.
5. **Failure branch**: a child that greens its outcome with `{status: 'failed'}` propagates that value up unchanged. Teardown fires on success or failure.

Grammar rules:
- `calls:` names a workflow that exists in the same def directory (resolver namespace).
- The called workflow must declare exactly one `outputs:` stem (v1 rule; validated at load time).
- `inputs:` keys must be declared inputs of the child workflow; values must be real parent artifacts (inputs or loop produces).
- `produces:` must declare exactly one artifact (the parent artifact the child outcome feeds).
- A `calls:` loop has no `body:` — it is machine-handled, never a worker firing.
- Cross-def `calls:` cycles are detected at load time and reported as `calls cycle: a -> b -> a`. This check is separate from the `include:` cycle guard.

**Mode 1 vs Mode 2:**

| | Mode 1 `include:` | Mode 2 `calls:` |
|---|---|---|
| When | Compile-time (load time) | Runtime (per instance) |
| Loops | Inlined with `as:` prefix | Run in a separate child instance |
| Use for | New combined workflows | Embedding an existing workflow as a black box |
| Output visibility | All child stems visible in parent namespace | Only the declared `produces:` artifact |

### `effect:` — the loop effect contract

A loop may declare `effect: { idempotent?, onInvalidate? }` to control how the engine
routes when the loop's green artifact's inputs move to a newer version (§20):

- **`idempotent: true` (default)** — re-deriving the artifact is safe; the engine
  re-arms it as a normal structural reject, exactly as today. Any loop without an `effect:`
  field behaves as if `idempotent: true` were declared — no existing def or test is
  affected.
- **`idempotent: false`** — the loop fires an irreversible side effect (a deploy, a publish,
  an external API mutation). The engine must not silently re-fire it when upstream inputs
  move. `onInvalidate` specifies what happens instead:
  - **`onInvalidate: 'pin'`** — the artifact stays green; its fingerprint is re-pointed to
    the current input versions so the cascade sees it as up-to-date. The producer does not
    re-fire. Use when stale-but-shipped is acceptable.
  - **`onInvalidate: 'escalate'` (default when `idempotent: false`)** — the artifact is
    rejected-and-held (`isHeld`). The producer does not auto-re-fire; the debt surfaces as
    `stalled: true` with `kind: 'invalidated-irreversible'` in `oweflow status`, requiring
    human intervention (`oweflow retry` / fix upstream / accept-as-is).

`terminal: true` is the legacy spelling for `effect: { idempotent: false, onInvalidate: 'pin' }`
plus the dead-end lint exemption. The two coexist on the same engine version and are mutually
exclusive on the same loop. Dead-input cascade (a retracted or skipped input) is always
structural regardless of `effect:` — only the moved-version re-arm path routes on it.

| key | idempotent | onInvalidate | cascade behavior on input move |
|---|---|---|---|
| _(none)_ or `effect: { idempotent: true }` | true | — | re-arm (structural reject) as today |
| `effect: { idempotent: false, onInvalidate: 'pin' }` | false | pin | stay green, re-point fingerprint |
| `effect: { idempotent: false, onInvalidate: 'escalate' }` | false | escalate | reject-and-hold; stalled |
| `effect: { idempotent: false, onInvalidate: '<loopName>' }` | false | loopName | pin original + arm named handler |
| `terminal: true` | false | pin | stay green + lint-exempt (legacy) |

**`onInvalidate: '<loopName>'`** (named-handler routing) pins the original artifact
green and arms the named handler loop — materializing its outputs as `owed` so it becomes
eligible next tick. The handler is an ordinary forward-producer loop; the engine sequences
nothing beyond making it eligible. Example:

```yaml
loops:
  - name: merger
    consumes: [pr]
    produces: [merge]
    effect:
      idempotent: false
      onInvalidate: reverter    # arms the 'reverter' loop on invalidation
  - name: reverter
    consumes: [merge]           # reverter consumes whatever it needs to undo
    produces: [revert]          # normal forward producer
```

The handler is dormant at instance creation (its outputs are not seeded `owed` until L is
first invalidated). If the input moves again after the handler has greened, the handler is
re-armed automatically. This does NOT auto-redo the irreversible step — it routes a
compensating forward action (§6.6).

### `on:` — the loop firing trigger

By default, a loop fires when its consumed inputs are all green (`inputsGreen`). The optional `on:` field makes the trigger explicit and swappable.

- **`on:` omitted** — equivalent to `on: ['inputsGreen']`. All existing defs behave exactly as before.
- **`on: ['inputsGreen']`** — explicit default. Fire when consumed inputs are green.
- **`on: ['allGreen']`** — completion evaluator mode (§21). The loop fires when the workflow is "all-green" — no outstanding debts among all artifacts except the evaluator's own produced outputs (bootstrap exclusion). Use for a loop that inspects the completed workflow and emits an `outcome` artifact.
- **`on: ['idle']`** — idle trigger (§21.8). The loop fires when the workflow is quiescent and no progress has been made for longer than `idleAfter`. Use for a watchdog, a stuck-detector, or a timeout handler. Requires `idleAfter` (hard error if absent).
- **`on: ['allGreen', 'idle']`** — combined evaluator. Fires on completion (`allGreen`) and also fires if the workflow has been stuck past the idle threshold. A worker reads `order.cause` (`'allGreen'` or `'idle'`) to branch behaviour.
- **`on: []`** — hard error: a loop must have at least one firing trigger.

**`idleAfter`:** required when `'idle'` is in `on:`. A duration string (same format as `cadence`, e.g. `"30m"`, `"2h"`, `"1d"`). The loop fires when no artifact in the workflow has been updated for this long. Progress resets the clock: every state change (green, reject, owed) advances `last_progress`.

```yaml
- name: completion
  on: [allGreen, idle]
  idleAfter: 30m           # fire if the workflow is stuck for 30 minutes
  generates: [outcome]
  body: |
    # order.cause is 'allGreen' when done, 'idle' when stuck past 30m
```

**Alarm (absolute override):** a worker that needs a recurring heartbeat or a deadline can call `engine.setAlarm(workflow, loop, at)` with an absolute ms-epoch timestamp. The alarm overrides the relative `idleAfter` window and survives process restart (persisted in SQLite). The engine clears the alarm when idle fires; the worker must call `setAlarm` again inside its body to re-arm:

```typescript
// inside an idle-trigger worker body:
engine.setAlarm(workflowId, 'completion', Date.now() + 3_600_000); // re-arm in 1 hour
await oweflow.green(order.run, { /* ... */ });
```

**`engine.nextAlarm(workflow)`** returns `{ dueAt: number | null; isDue: boolean }` — the earliest pending idle threshold across all idle loops in the workflow. An external scheduler uses this to decide when to wake the instance.

**Bootstrap exclusion:** the evaluator's own `outcome` is excluded from the all-green check so that "all other artifacts are done" can be true before the evaluator runs.

**Re-arm:** once `outcome` is green, if the workflow later falls back out of all-green (e.g. an upstream input is re-provided), `maintainDecisions` detects that `outcome` is green but the workflow is no longer all-green, and emits a structural reject to re-arm `outcome`. The evaluator re-fires automatically when the workflow returns to all-green.

**`cause` in the order:** the engine threads the trigger onto `order.cause` (e.g. `'allGreen'` or `'idle'`). A worker can read `order.cause` to branch behaviour — for example, a completion evaluator may inspect status, green `outcome`, and message a human.

### Consume / produce grammar

| pattern | role | fires |
|---|---|---|
| `plan` | **plain** consume / **singleton** produce | when `plan` is green |
| `gather.source[]` | **collection** produce | producer `emit`s N elements, then `seal`s |
| `gather.source[$i]` | **map** | one run per element; binds `${INDEX}` |
| `gather.source[$i].verdict` | **map** produce | the per-element output of a map loop |
| `gather.source[*]` | **reduce** consume | once, when sealed + all surviving members green |

A loop consumes in exactly one mode — plain-only, a single map, or a single
reduce (a map loop must also declare its `[$i]` output, and vice-versa). These
rules are enforced by the validator, not left to runtime surprise.

---

## The wiring concept

oweflow deliberately stops at "here is an order; tell me the outcome." A
**wiring** supplies the two things the engine refuses to assume:

1. **What the steps mean** — the YAML definitions (the `delivery`/`research`
   examples are wirings).
2. **How an order gets executed** — a *worker* loop. In pseudocode:

   ```
   for each workflow:
     { orders } = oweflow tick $wf
     for each order:
       result = run(order.prompt, order.consumes, order.owes)   # ← your domain
       if result.ok:        oweflow green   $wf $order.run $output --value …
       else if rejected:    oweflow reject  $wf $artifact --by $loop --text …
       oweflow close $wf $order.run --outcome …
   ```

A coding agent that opens PRs is one such worker; a research bot that fetches and
fact-checks sources is another. Both layer onto the *same* engine — the engine
never learned what a PR or a source is. That decoupling is the whole point: the
debt model, forward cascade, stall liveness, and concurrency-safe commit live
once, in the engine, and every wiring inherits them.

---

## Architecture

| module | responsibility |
|---|---|
| [`src/types.ts`](src/types.ts) | shared types: the five-state lifecycle, reason threads, def shapes |
| [`src/paths.ts`](src/paths.ts) | parse/match the `src[$i]` / `src[*]` / `src[]` path grammar |
| [`src/defs.ts`](src/defs.ts) | load YAML → validated `WorkflowDef` (static wiring checks) |
| [`src/schema.ts`](src/schema.ts) | JSON Schema validation of artifact values (§19), via `@cfworker/json-schema` |
| [`src/model.ts`](src/model.ts) | the pure core: `eligibleFirings`, the cascade, `workflowStatus`, `isStalled`/`isSchemaStalled` |
| [`src/store.ts`](src/store.ts) | better-sqlite3 persistence; transactions; the commit CAS |
| [`src/engine.ts`](src/engine.ts) | the imperative shell: `tick`/`green`/`reject`/… → mutate → `settle()` |
| [`src/cli.ts`](src/cli.ts) | argv → engine calls, JSON on stdout |

**Invariant:** every engine mutation ends with `settle()` — materialize owed
outputs and run the forward cascade to a fixpoint — so `status()` is a pure read
over artifact state and never lies.

### Storage

State lives in a single SQLite database via **better-sqlite3** in WAL mode. There
is no separate graph engine: the flat artifact/task/run tables *are* the graph,
and the dependency structure is recomputed from the definition on each tick.
Concurrent advancement is made safe by a **commit-fingerprint CAS** — a run
records the version of every input it claimed, and its commit is rejected
("born-rejected") if any of those inputs moved underneath it. Each artifact
carries a monotonic version so the level-trigger can ask "is this green output
still resting on the inputs it was built from?".

---

## Testing

```sh
npm test          # node --test, spec reporter
npm run typecheck # tsc --noEmit (erasable-syntax only — verifies type-strip safety)
npm run check     # both
```

The suite (172 tests) spans unit tests (`paths`, `store`, `model`, `defs`,
`schema`, `util`, `cli`), engine integration tests (the cascade, the §6 stall,
schema validation/§19, concurrency/CAS), and **47 end-to-end tests** that spawn
the real `bin/oweflow.mjs` binary and drive the example workflows through their
full lifecycles.

Two e2e files carry most of that weight, by opposite intent.
[`test/edge.e2e.test.ts`](test/edge.e2e.test.ts) is a 26-case edge battery aimed
squarely at the corners the spec is most particular about: forward-cascade
invalidation, terminal completion surviving an upstream reject, empty /
fully-retracted / retract-after-green collections, the commit CAS (born-rejected
+ the reaped-run zombie guard), cadence / daily-budget gating, the skip-cascade
and its reversibility, the authority / version / reason-thread invariants, and
CLI robustness against malformed input.
[`test/scenarios.e2e.test.ts`](test/scenarios.e2e.test.ts) takes the opposite
tack — eight multi-step *positive* stories that confirm the behaviors the design
doc promises hold end to end: the map `parallel` cap (§3), map and reduce firing
as concurrent branches with the reduce gating on members not verdicts (§3/§11),
the reason thread riding the next order (§4), stall → retry → re-stall with
`blocked` excluding the stalled loop (§6/§18), and the level-trigger
re-firing on a re-provided input while staying idempotent on a healthy graph and
leaving a terminal output untouched (§7).
[`test/schema.e2e.test.ts`](test/schema.e2e.test.ts) drives the §19 surface end
to end against a schema-pinned fixture: a malformed singleton is schema-rejected
rather than greened, a corrected value greens on the same open run, repeated
failures trip the `maxSchemaFailures` stall and a `retry` clears it, a malformed
collection element refuses the whole `emit` atomically, and a schema-violating
input is refused at `create` with a non-zero exit.

---

## Design reference

oweflow is a faithful, decoupled implementation of an internal dataflow-engine
spec. [`docs/design.md`](docs/design.md) is a self-contained distillation —
the lifecycle, firing rule, forward cascade, the two reject kinds, §6 liveness,
and the concurrency model — cross-referenced from the source as `§N`.

---

## License

[Apache License 2.0](LICENSE) © Typical Day.
