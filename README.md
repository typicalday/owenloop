# owenloop

[![CI](https://github.com/typicalday/owenloop/actions/workflows/ci.yml/badge.svg)](https://github.com/typicalday/owenloop/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**owenloop runs multi-step agent workflows.** You describe a pipeline of steps in
a YAML file — usually one AI agent per step — and owenloop works out what's ready
to run, hands you one job at a time, and keeps the whole pipeline honest as things
change. It's the memory and the coordination between agent runs; you bring the
agents.

It was built for AI agent workflows — a planner agent writes a plan, a builder
agent turns it into a PR, a reviewer agent checks it, a merger ships it — but the
engine doesn't know what a "PR" or a "plan" is. Any multi-step process where steps
depend on each other fits: research pipelines, data processing, document review,
triage.

```yaml
# delivery.yaml — a four-step agent pipeline
steps:
  - name: planner
    consumes: [proposal]
    produces: [plan]
  - name: builder
    consumes: [plan]
    produces: [pr]
  - name: reviewer
    consumes: [pr]
    produces: [verdict]
  - name: merger
    consumes: [verdict]
    produces: [merge]
    terminal: true
```

---

## Why it exists

Agents are good at doing one task. They're bad at the bookkeeping *around* a task:
remembering what's already done, noticing when an earlier step's output changed,
retrying the right number of times, and knowing when to stop. Wire a few agents
together by hand and you end up writing a pile of glue — who runs next, what to
re-run when something upstream moves, when to give up and ask a human.

owenloop is that glue, written once and tested hard. You declare the steps; it
handles the three things that are tedious to get right:

- **What runs next.** A step is ready the moment everything it depends on is
  accepted *and* it still owes an output. That's the whole scheduler — there's no
  status field to flip, nothing to sequence by hand.
- **What to re-run.** Change an early step's output and everything built on it
  automatically falls back to "not done." No manual invalidation, no stale results
  slipping through.
- **When to stop.** If a step keeps getting rejected past its limit, owenloop stops
  re-running it and flags it for a human — instead of looping forever burning
  tokens.

### The mental model: owed, not done

owenloop doesn't track whether a step is "running" or "done." It tracks what each
step **owes**. Every output is in one of five states:

| state       | still owed? | meaning                                                          |
|-------------|:-----------:|------------------------------------------------------------------|
| `owed`      |     yes     | declared but not produced yet, or re-armed — the step owes it     |
| `green`     |     no      | accepted; satisfies everything downstream that depends on it      |
| `rejected`  |     yes     | produced, then judged unfit (or knocked back by a change) — a debt |
| `retracted` |     no      | a member dropped from a collection; gone for good                 |
| `skipped`   |     no      | a step declined its own output on a dead branch                   |

A step is **eligible to run** when it owes a debt (an `owed` or `rejected` output)
and every input it consumes is `green`. Status is never stored — it's computed from
these states on every read, so it can't drift out of sync.

Three things make this more than running steps in dependency order:

- **Outputs stay honest as inputs move.** A green output counts as done *only while*
  the inputs it was built from are still green and unchanged. Re-run the `plan` and
  the `pr`, its `verdict`, and the final `merge` all quietly fall back to debts — no
  code required to invalidate them.
- **Rejections carry reasons.** When a reviewer rejects a PR, the text rides along.
  The next job for the builder shows *why* it's being asked again, so the agent has
  the feedback in hand. (Three flavors: a reviewer's **judgment**, the engine's own
  **schema** refusal of a malformed value, and **structural** knock-backs from a
  change cascading downstream.)
- **It knows when to give up.** If an output is rejected more times than its step's
  `maxAttempts`, the engine stops re-arming it. It stays a debt but produces no more
  jobs — the step has demonstrably failed and a human is needed. `owenloop retry`
  resets the counter (optionally with new guidance).

That's the core. Collections add fan-out/fan-in (a step emits N items, a `map` runs
once per item, a `reduce` runs once they're all in) — see
[`research`](examples/workflows/research.yaml).

### Driving it with a loop

owenloop never runs anything itself. It hands out jobs and waits to hear back —
something has to tick it, run the work, and report the result. That something can be
as simple as a `while` loop around an agent. The [Ralph
technique](https://ghuntley.com/ralph/) — keep an agent ticking with a fresh context
each pass — is exactly this kind of outer loop, and owenloop is the half it's
missing: the persistent state and the brakes. The loop keeps going; owenloop
remembers what's owed, what failed and why, and when the whole thing is actually
done. They work side by side — the loop is the muscle, owenloop is the memory.

---

## Requirements

- **Node ≥ 22.6.** owenloop runs TypeScript directly via Node's built-in type
  stripping — there's no build step.
- **No native dependencies.** Storage is Node's built-in `node:sqlite`, so there's
  nothing to compile. The only runtime deps are `yaml` (parsing defs) and
  `@cfworker/json-schema` (optional per-artifact schema validation).

```sh
git clone https://github.com/typicalday/owenloop && cd owenloop
npm install
npm run check     # typecheck + full test suite
```

Or use it as a dependency — owenloop ships its TypeScript source (no build step), so
you just need a Node ≥ 22.6 ESM host:

```sh
npm install owenloop
```

```ts
import { createEngine } from 'owenloop';   // see "Embedding it" below
```

---

## Quick start

The [`examples/workflows`](examples/workflows) folder has a workflow per idea:
[`delivery`](examples/workflows/delivery.yaml) (a review knock-back loop),
[`research`](examples/workflows/research.yaml) (collections),
[`routing`](examples/workflows/routing.yaml) (skip a dead branch),
[`intake`](examples/workflows/intake.yaml) (schema validation), and
[`sla-watchdog`](examples/workflows/sla-watchdog.yaml) (idle timers and deadlines).
Every command prints JSON, so the snippet below pipes through `jq`.

```sh
export OWENLOOP_DEFS=examples/workflows
export OWENLOOP_DB=/tmp/owenloop-demo.db

owenloop defs                                  # what workflows are available

# start an instance; `proposal` is seeded as owed, so we provide it up front
wf=$(owenloop create delivery \
       --provide proposal='{"text":"add dark mode"}' | jq -r .workflow)

# the worker loop: tick → run → report
run=$(owenloop tick $wf | jq -r '.orders[0].run')   # claim the planner job
owenloop green $wf $run plan --value '{"plan":"…"}'  # report its output

owenloop status $wf                            # owed / eligible / blocked / done
```

`owenloop` here is `node bin/owenloop.mjs` — run that directly, use the `npm run
owenloop --` script, or `npm link` to put `owenloop` on your PATH.

**A knock-back.** When the reviewer's job comes up, instead of greening its `verdict`
you can reject the PR:

```sh
owenloop reject $wf pr --by reviewer --text "tests are missing"
```

That re-arms `builder` with the reason attached to its next job. Do it past
`builder`'s `maxAttempts` and `pr` **stalls** — owenloop stops re-arming it and waits
for a human. `owenloop retry $wf pr --text "use the new fixture"` clears the stall and
resets the counter.

Each example's header comment walks through its commands end to end.

---

## CLI reference

Global flags: `--db <path>` (env `OWENLOOP_DB`, default `.owenloop/state.db`) and
`--defs <dir>` (env `OWENLOOP_DEFS`, default `./workflows`).

| command | what it does |
|---|---|
| `defs` | list available workflow definitions |
| `create <def> [--title t] [--provide name=json …] [--param k=v …]` | start an instance; prints `{workflow}` |
| `provide <wf> <name> [--value json]` | supply a seeded input after the fact |
| `tick <wf> [--now <ms>]` | claim and emit eligible **orders** (the jobs to run) |
| `status <wf>` | derived view: `done`, `debts`, `eligible`, `blocked` |
| `show <wf>` | dump raw artifacts (debugging) |
| `list` | list instances |
| `green <wf> <run> <path> [--value json] [--terminal]` | accept an owed output |
| `emit <wf> <run> --items '[{…},{…}]'` | add collection elements |
| `seal <wf> <run> [--value json]` | mark a collection complete |
| `reject <wf> <path> --by <author> --text <msg>` | reject an output (re-arms its producer) |
| `retract <wf> <path> --by <author> --text <msg>` | drop a collection member |
| `skip <wf> <path> --by <author> --text <msg>` | a step declines its own output |
| `retry <wf> <path> [--by a] [--text guidance]` | clear a stall, reset the counter |
| `close <wf> <run> [--outcome ok\|no_work\|failed\|skipped] [--summary s]` | release a claimed job |
| `delete <wf>` | delete an instance and all its rows |

**Exit codes for `green` / `emit` / `seal`:** these exit non-zero when the engine
refuses the commit (the value was born-rejected or failed its schema). The result JSON
is always written to stdout; the human-readable reason goes to stderr. A successful
commit exits 0 — a worker should treat a non-zero exit as a failure, not a success.

### What a job looks like

`tick` returns `{ workflow, orders, reaped }`. Each order is self-contained — a worker
needs nothing else to do the work:

```jsonc
{
  "run": "r_…",            // job id — pass it back to green/emit/seal/close
  "step": "builder",       // which step this job is for
  "key": "",               // map jobs carry the element key + index
  "inputs":  ["plan"],
  "outputs": ["pr"],
  "prompt":  "…body with ${WORKFLOW}/${RUN}/${INDEX} filled in…",
  "consumes": { "plan": { /* the accepted input value */ } },
  "owes": [                // the feedback channel
    { "path": "pr", "acceptance": "rejected", "judgmentRejects": 2, "schemaRejects": 0,
      "reasons": [ { "action": "reject", "kind": "judgment", "by": "reviewer",
                     "text": "tests are missing", "at": 0 } ] }
  ]
}
```

A worker reads `prompt` + `consumes` + `owes`, does the work, reports with `green`
(or `emit`/`seal` for collections), then `close`s the job. The reject counts in
`owes[]` let a workflow escalate on its own — e.g. switch to a stronger model after
two rejections — before the engine stalls the step.

---

## Embedding it

The CLI is a thin adapter: it maps `argv` to engine calls and prints JSON. The engine
is an ordinary class, so you can drive it **in-process** and get typed objects back
(`Order`, `CommitResult`, `WorkflowStatus`) — no subprocess, no JSON parsing.

```ts
import { createEngine } from 'owenloop';

const { engine, store } = createEngine({
  db: '.owenloop/state.db',         // or ':memory:' for an ephemeral instance
  defsDir: 'workflows',             // load YAML defs from a dir … or pass `defs: [myDef]`
});

// start an instance (proposal is seeded as owed, so provide it up front)
const wf = engine.createInstance('delivery', {
  provide: { proposal: { text: 'add dark mode' } },
});

// the worker loop: tick → run → report
const { orders } = engine.tick(wf);
for (const order of orders) {
  const result = await runYourAgent(order);              // ← your domain
  engine.green(wf, order.run, order.outputs[0], result); // typed CommitResult back
  engine.close(wf, order.run);
}

engine.status(wf);   // typed WorkflowStatus: done / debts / eligible / blocked
store.close();        // on shutdown
```

Prefer to **react** instead of poll? `engine.subscribe(listener)` (or
`createEngine({ onEvent })`) pushes a typed event the instant a mutation commits — so
you can re-`tick` only when there's new work, or resolve a promise when the workflow is
`done`. See [`examples/events.ts`](examples/events.ts).

The `engine`/`store` pair is meant to be long-lived (one per database). Concurrency is
the store's job: `node:sqlite` is synchronous and single-writer-per-process, and
cross-process safety comes from a commit fingerprint check (described under
[Storage](#storage)). See [`docs/embedding.md`](docs/embedding.md) for the full
surface, lifecycle, and trade-offs.

---

## Writing a workflow

A workflow is one self-contained YAML file under the `--defs` directory (either
`name.yaml` or `name/workflow.yaml`). It's parsed, type-checked, and **validated**
before any instance is created — dangling consumes, two producers for one artifact,
map/reduce mismatches, and dependency cycles are all caught up front.

```yaml
name: delivery                 # required; [a-z0-9][a-z0-9_-]*
title: Software delivery       # optional
description: …                 # optional

inputs:                        # external artifacts, seeded when an instance starts
  - name: proposal
    seedOwed: true             # true → starts owed (must be `provide`d to unblock)
    producer: human            # optional label for who supplies it (default: human)
    schema:                    # optional JSON Schema (2020-12); a provided value
      type: object             #   that violates it is refused
      required: [text]

outputs:               # optional; the workflow's public outputs (its interface when
  - summary            #   embedded in another workflow). Exempt from dead-end lint
  - outcome            #   warnings; must be produced by a step.

steps:
  - name: planner
    consumes: [proposal]       # plain | map (src[$i]) | reduce (src[*])
    produces:                  # singleton | collection (src[]) | map (src[$i].x)
      - name: plan             # a produce can be a bare name, or {name, schema}:
        schema:                #   a green/emit whose value fails this is refused
          type: object
          required: [plan]
          properties: { plan: { type: string } }
    body: |                    # the prompt; ${WORKFLOW} ${RUN} ${INDEX} are filled in
      Read the proposal and produce a `plan`.
    bodyFile: path/to.md       # load body from a file, relative to this workflow's dir; mutually exclusive with body

    generates:                 # optional; outputs this step makes that NO step
      - audit_log              #   consumes. Exempt from dead-end lint; otherwise
      - report[]               #   identical to produces:.

    # all optional, with defaults:
    maxAttempts: 3             # reject cap before the output stalls
    maxSchemaFailures: 5       # schema-reject cap before the output stalls; 0 = off
    parallel: 1                # max concurrent runs (raise it to fan out a map)
    terminal: false            # true → a green output is a final result, never
                               #        re-armed by the cascade
    effect:                    # optional; how to handle re-running side-effecting steps
      idempotent: true         #   true (default): safe to re-derive if inputs move
      onInvalidate: escalate   #   consulted only when idempotent: false (see below)
    on: [inputsGreen]          # optional; firing trigger (see below)
    idleAfter: 30m             # required when 'idle' is in on:
    invalidates: [plan]        # which input stems this step may invalidate
    cadence: "0s"              # min spacing between runs (e.g. "30m")
    maxRunsPerDay: 1000
    model: …                   # opaque hint passed through on the order
    workdir: main              # opaque hint passed through on the order
```

### `produces:` vs `generates:`

A stem under `produces:` is expected to be consumed downstream — owenloop's lint warns
if nothing consumes it. A stem under `generates:` is deliberately consumed by nothing
(an audit log, an external artifact, a stub); lint leaves it alone. Generated artifacts
are otherwise identical: schema-validated, fingerprinted, greenable, and visible in
`status`/`show`.

### `outputs:` — the workflow's interface

Top-level `outputs:` declares which stems are the workflow's intentional public results
— what a parent workflow consumes when this one is embedded. Listed stems are exempt
from dead-end warnings, but unlike `terminal:` they stay re-armable.

| key | level | lint-exempt | re-armable | meaning |
|---|---|---|---|---|
| `terminal: true` | step | yes | **no** | final result; never re-armed |
| `generates:` | step | yes | yes | internal sink, not the public interface |
| `outputs:` | workflow | yes | yes | public interface / composition boundary |

### Composition — `include:` (compile-time) and `calls:` (runtime)

Two ways to build a workflow out of other workflows:

**`include:` (Mode 1, compile-time)** splices another workflow's steps directly into
the parent when the def is loaded. The engine sees one flat graph; child steps get an
`as:` prefix.

```yaml
name: full-cycle
inputs:
  - name: proposal
    seedOwed: true
outputs:
  - torn_down
steps:
  - name: provision
    consumes: [proposal]
    produces: [environment]
  - include: delivery           # splice delivery's steps in
    as: deliver                 # prefix: deliver.planner, deliver.plan, deliver.merge …
    inputs:
      proposal: proposal        # map the child's seeded input to the outer 'proposal'
  - name: teardown
    consumes: [environment, deliver.merge]   # consume the inlined child output directly
    produces: [torn_down]
```

After loading, the steps are `provision`, `deliver.planner`, `deliver.builder`,
`deliver.reviewer`, `deliver.merger`, `teardown` — one flat instance. Use `include:`
for brand-new combined workflows where nothing downstream expects the original step
names.

**`calls:` (Mode 2, runtime)** delegates to a **separate child instance** at runtime
instead of inlining. The `calls:` step is machine-handled — it never emits a worker
job. Use it to embed an existing workflow as a black box, keeping its internals hidden.

```yaml
# provisioned-delivery.yaml — the parent calls delivery as a child instance
name: provisioned-delivery
inputs:
  - name: proposal
    seedOwed: true
steps:
  - name: provision
    consumes: [proposal]
    produces: [sandbox]
    body: Provision environment.
  - name: deliver
    calls: delivery          # child workflow name (must exist in the same def dir)
    inputs:                  # child input → parent artifact (gate: sandbox green)
      proposal: proposal
    produces: [delivered]    # one parent artifact; greens when delivery's output greens
  - name: teardown
    consumes: [delivered]
    produces: [torn_down]
    terminal: true
    body: Tear down and green `torn_down`.
```

The engine spawns the child when the gate inputs are green, greens the parent's
`calls:` output when the child's declared output greens (no worker run), and re-provides
inputs to the existing child if a gate input changes — it never spawns a duplicate.

| | `include:` (Mode 1) | `calls:` (Mode 2) |
|---|---|---|
| When | Compile-time (load) | Runtime (per instance) |
| Steps | Inlined with `as:` prefix | Run in a separate child instance |
| Use for | New combined workflows | Embedding an existing workflow as a black box |
| Visibility | All child stems visible in the parent | Only the declared `produces:` artifact |

### `effect:` — re-running steps with side effects

By default a step is **idempotent** — safe to re-run if its inputs move, which is what
the cascade does. But some steps fire irreversible side effects (a deploy, a publish, an
external API write). For those, declare `effect: { idempotent: false, onInvalidate: … }`
to tell the engine what to do when the inputs move instead of silently re-firing:

- **`pin`** — keep the output green and re-point its fingerprint to the new inputs. The
  step does not re-fire. Use when stale-but-shipped is acceptable.
- **`escalate`** (default when `idempotent: false`) — reject and hold. The step does not
  auto-re-fire; the debt shows up as `stalled` in `status`, waiting for a human.
- **`<stepName>`** — pin the original output and arm a named compensating step (e.g. a
  `reverter`) instead of redoing the irreversible work.

`terminal: true` is the legacy shorthand for "irreversible, pin on invalidation" plus
the dead-end lint exemption.

### `on:` — when a step fires

By default a step fires when its consumed inputs are all green (`inputsGreen`). The
`on:` field makes the trigger explicit and swappable:

- **`inputsGreen`** (default) — fire when the consumed inputs are green.
- **`allGreen`** — fire when the whole workflow is otherwise done. Use for a *completion
  evaluator*: a final step that inspects the finished workflow and greens an `outcome`.
- **`idle`** — fire when the workflow has made no progress for longer than `idleAfter`
  (required). Use for a watchdog, a stuck-detector, or a timeout handler.
- **`[allGreen, idle]`** — both. The worker reads `order.cause` (`'allGreen'` or
  `'idle'`) to branch.

```yaml
- name: completion
  on: [allGreen, idle]
  idleAfter: 30m           # fire if the workflow is stuck for 30 minutes
  generates: [outcome]
  body: |
    # order.cause is 'allGreen' when done, 'idle' when stuck past 30m
```

**Alarms.** A worker that needs a heartbeat or a deadline can call
`engine.setAlarm(workflow, step, at)` with an absolute timestamp — it overrides the
relative `idleAfter` window and survives a process restart.
`engine.nextAlarm(workflow)` tells an external scheduler when to wake the instance.

### Consume / produce grammar

| pattern | role | fires |
|---|---|---|
| `plan` | **plain** consume / **singleton** produce | when `plan` is green |
| `gather.source[]` | **collection** produce | the producer `emit`s N elements, then `seal`s |
| `gather.source[$i]` | **map** | one run per element; binds `${INDEX}` |
| `gather.source[$i].verdict` | **map** produce | the per-element output of a map step |
| `gather.source[*]` | **reduce** consume | once, when sealed and all surviving members green |

A step consumes in exactly one mode — plain, a single map, or a single reduce. The
validator enforces this at load time, so you don't hit it as a runtime surprise.

---

## How it's built

owenloop is small and split along a pure-core / imperative-shell line:

| module | responsibility |
|---|---|
| [`src/types.ts`](src/types.ts) | shared types: the five-state lifecycle, reason threads, def shapes |
| [`src/paths.ts`](src/paths.ts) | parse/match the `src[$i]` / `src[*]` / `src[]` path grammar |
| [`src/defs.ts`](src/defs.ts) | load YAML → validated `WorkflowDef` (the static wiring checks) |
| [`src/schema.ts`](src/schema.ts) | JSON Schema validation of artifact values, via `@cfworker/json-schema` |
| [`src/model.ts`](src/model.ts) | the pure core: what's eligible, the cascade, status, stall detection |
| [`src/store.ts`](src/store.ts) | `node:sqlite` persistence; transactions; the commit check |
| [`src/engine.ts`](src/engine.ts) | the imperative shell: `tick`/`green`/`reject`/… → mutate → `settle()` |
| [`src/cli.ts`](src/cli.ts) | argv → engine calls, JSON on stdout |

**Invariant:** every engine mutation ends with `settle()` — materialize owed outputs and
run the cascade to a fixpoint — so `status()` is a pure read over artifact state and
never lies.

### Storage

State lives in a single SQLite database via Node's built-in **`node:sqlite`** in WAL
mode — no native module to compile, no separate graph engine. The flat
artifact/task/run tables *are* the graph; the dependency structure is recomputed from
the definition on each tick. Concurrent advancement is made safe by a **commit
fingerprint check**: a run records the version of every input it claimed, and its commit
is rejected ("born-rejected") if any of those inputs moved underneath it. Each artifact
carries a monotonic version, so the engine can always ask "is this green output still
resting on the inputs it was built from?".

---

## Testing

```sh
npm test          # node --test, spec reporter
npm run typecheck # tsc --noEmit (verifies the source is type-strip-safe)
npm run check     # both
```

The suite is **432 tests**: unit tests (`paths`, `store`, `model`, `defs`, `schema`,
`util`, `cli`), engine integration tests (the cascade, the stall, schema validation,
the concurrency check), and **49 end-to-end tests** that spawn the real
`bin/owenloop.mjs` binary and drive the example workflows through their full lifecycles.

Two e2e files carry most of the weight, by opposite intent.
[`test/edge.e2e.test.ts`](test/edge.e2e.test.ts) is a 26-case edge battery aimed at the
corners the design is most particular about: cascade invalidation, terminal completion
surviving an upstream reject, empty / fully-retracted collections, the commit check,
cadence and daily-budget gating, the skip-cascade, and CLI robustness against malformed
input. [`test/scenarios.e2e.test.ts`](test/scenarios.e2e.test.ts) takes the opposite
tack — eight multi-step *positive* stories that confirm the documented behaviors hold
end to end: the map `parallel` cap, map and reduce firing as concurrent branches, the
reason thread riding the next job, stall → retry → re-stall, and the cascade re-firing on
a re-provided input while leaving a healthy graph and a terminal output untouched.
[`test/schema.e2e.test.ts`](test/schema.e2e.test.ts) drives schema validation end to end:
a malformed value is rejected rather than greened, a corrected value greens on the same
open job, repeated failures trip the stall and a `retry` clears it.

---

## Design reference

owenloop is a faithful, decoupled implementation of an internal dataflow-engine spec.
[`docs/design.md`](docs/design.md) is a self-contained walkthrough — the lifecycle,
firing rule, forward cascade, the reject kinds, the liveness rules, and the concurrency
model — cross-referenced from the source.

---

## License

[GNU AGPLv3](LICENSE) © Typical Day.

You may use, modify, self-host, and redistribute owenloop under the terms of the
AGPLv3. If you modify owenloop and make it available to users over a network, you
must provide the corresponding source for the modified work.

A **commercial license** is available for organizations that want to use owenloop in
proprietary products or closed-source/network services without AGPLv3 obligations —
contact Typical Day.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Note that
owenloop requires every contributor to sign a **Contributor License Agreement**
that assigns copyright in contributions to Typical Day LLC, so the project can be
dual-licensed (AGPLv3 + commercial). The process is a one-time comment on your
first pull request.
