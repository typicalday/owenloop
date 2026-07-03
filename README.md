# owenloop

[![CI](https://github.com/typicalday/owenloop/actions/workflows/ci.yml/badge.svg)](https://github.com/typicalday/owenloop/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/owenloop.svg)](https://www.npmjs.com/package/owenloop)
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
# workflows/delivery.yaml — a four-step agent pipeline, complete and runnable
name: delivery
inputs:
  - name: proposal
    seedOwed: true    # supplied when the instance starts
steps:
  - name: planner
    consumes: [proposal]
    produces: [plan]
    body: Read the proposal and produce an implementation plan as `plan`.
  - name: builder
    consumes: [plan]
    produces: [pr]
    body: Implement `plan`, open a PR, and green `pr` with its url.
  - name: reviewer
    consumes: [pr]
    produces: [verdict]
    body: Review `pr` — reject it with reasons, or green `verdict`.
  - name: merger
    consumes: [verdict]
    produces: [merge]
    terminal: true    # a merge is a destructive completion — never re-armed
    body: Merge the PR and green `merge`.
```

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
step **owes**. Every output is in one of six states:

| state       | still owed? | meaning                                                          |
|-------------|:-----------:|------------------------------------------------------------------|
| `owed`      |     yes     | declared but not produced yet, or re-armed — the step owes it     |
| `green`     |     no      | accepted; satisfies everything downstream that depends on it      |
| `rejected`  |     yes     | produced, then judged unfit (or knocked back by a change) — a debt |
| `retracted` |     no      | a member dropped from a collection; gone for good                 |
| `skipped`   |     no      | a step declined its own output on a dead branch                   |
| `submitted` |   no*       | produced, awaiting sign-off from one or more declared judges       |

\* `submitted` isn't a producer debt — the producer already did its job — but the
workflow isn't done while it sits there either. See
[`judges:`](docs/authoring.md#judges---quality-gates-before-green).

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
  the feedback in hand.
- **It knows when to give up.** If an output is rejected more times than its step's
  `maxAttempts`, the engine stops re-arming it and waits for a human. `owenloop
  retry` resets the counter (optionally with new guidance).

That's the core. Collections add fan-out/fan-in — a step emits N items, a `map`
runs once per item, a `reduce` runs once they're all in — see
[`research`](examples/workflows/research.yaml).

owenloop is deliberately **not** a scheduler with its own clock (nothing wakes up
on a timer — your outer loop initiates every tick), **not** shared state across
instances (each instance is its own island), and **not** a dynamic graph at
runtime (collections give a workflow dynamic *width*, but the wiring is fixed when
the definition loads).

### Driving it with a loop

owenloop never runs anything itself. It hands out jobs and waits to hear back —
something has to tick it, run the work, and report the result. That something can be
as simple as a `while` loop around an agent. The [Ralph
technique](https://ghuntley.com/ralph/) — keep an agent ticking with a fresh context
each pass — is exactly this kind of outer loop, and owenloop is the half it's
missing: the persistent state and the brakes. The loop is the muscle, owenloop is
the memory.

This repo ships that muscle as agent skills:
[`skills/owenloop-conduct`](skills/owenloop-conduct/SKILL.md) drives an instance to
done (one fresh subagent per job, honest reporting, human escalation), and
[`skills/owenloop-author`](skills/owenloop-author/SKILL.md) turns a goal into a
validated workflow file. One command installs them into your agent of choice:

```sh
npx skills add typicalday/owenloop
```

## Quick start

You need Node ≥ 22.13 (storage is Node's built-in `node:sqlite`; no native
dependencies, nothing to compile). Save the YAML at the top of this page as
`workflows/delivery.yaml` in an empty directory, then:

```sh
# start an instance; `proposal` is seeded as owed, so provide it up front
wf=$(npx owenloop create delivery \
       --provide proposal='{"text":"add dark mode"}' | jq -r .workflow)

# the worker loop: tick → work → report → close
run=$(npx owenloop tick $wf | jq -r '.orders[0].run')     # claim the planner job
npx owenloop green $wf $run plan --value '{"plan":"…"}'    # report its output
npx owenloop close $wf $run                                # release the job

npx owenloop status $wf     # owed / eligible / blocked / done
```

Every command prints JSON (hence the `jq`). State lands in `.owenloop/state.db`;
`--db` / `--defs` (or `OWENLOOP_DB` / `OWENLOOP_DEFS`) point elsewhere.

Here you're playing the worker by hand — greening `plan` with a placeholder. The
real setup hands each job to an agent, which does the work and reports back
through the same three commands. That's the whole worker protocol.

**A knock-back.** When the reviewer's job comes up, instead of greening its
`verdict` you can reject the PR:

```sh
npx owenloop reject $wf pr --by reviewer --text "tests are missing"
```

That re-arms `builder` with the reason attached to its next job. Do it past
`builder`'s `maxAttempts` and `pr` **stalls** — owenloop stops re-arming it and
waits for a human. `npx owenloop retry $wf pr --text "use the new fixture"` clears
the stall and resets the counter.

**More workflows.** [`examples/workflows`](examples/workflows) has a workflow per
idea, each header comment a runnable walkthrough:
[`delivery`](examples/workflows/delivery.yaml) (the pipeline above, with fuller prompts),
[`ship`](examples/workflows/ship.yaml) (delivery grown up: the full production
line with provisioned workspaces, an adversarial reviewer, a doc pass, and
teardown owned as a step),
[`research`](examples/workflows/research.yaml) (collections),
[`routing`](examples/workflows/routing.yaml) (skip a dead branch),
[`intake`](examples/workflows/intake.yaml) (schema validation),
[`sla-watchdog`](examples/workflows/sla-watchdog.yaml) (idle timers and deadlines), and
[`improve`](examples/workflows/improve.yaml) (a codebase-advisor pipeline
combining collections, a mid-flight human gate, per-element knock-backs, and
suffixed-reduce fan-ins).

## The CLI at a glance

| command | what it does |
|---|---|
| `defs` / `list` | list definitions / instances |
| `create <def> --provide name=json …` | start an instance; prints `{workflow}` |
| `tick <wf>` | claim and emit eligible **orders** (the jobs to run) |
| `green <wf> <run> <path> --value json` | accept an owed output |
| `emit` / `seal` | add collection elements / mark the collection complete |
| `reject` / `retract` / `skip` | the verdicts: knock back, drop a member, decline a dead branch |
| `retry <wf> <path>` | clear a stall, reset the counter |
| `close <wf> <run>` | release a claimed job |
| `status <wf>` / `wait <wf> --until …` | derived state / block until it changes |
| `lint` / `check <def>` | validate defs / model-check a def's state space |

Full detail — the complete table, the order payload a worker receives, in-flight
observation and reaping, instance pinning — lives in [docs/cli.md](docs/cli.md).

## Writing workflows

The YAML grammar goes well past the pipeline above: per-artifact **JSON schemas**
the engine enforces on commit, **judges** (quality gates an output must clear
before it counts as green), **collections** with map/reduce fan-out,
**produce-groups** for routing, composition via **`include:`**/**`calls:`**,
side-effect policy (**`effect:`**), and alternate firing triggers (**`on:`**
allGreen/idle for watchdogs and completion evaluators).

The full authoring reference is [docs/authoring.md](docs/authoring.md);
`owenloop lint` validates a def, and `owenloop check` model-checks its reachable
state space before you ever run an instance.

## Embedding it

The CLI is a thin adapter over an ordinary class — drive the engine **in-process**
and get typed objects back (`Order`, `CommitResult`, `WorkflowStatus`):

```ts
import { createEngine } from 'owenloop';   // npm install owenloop

const { engine, store } = createEngine({ db: '.owenloop/state.db', defsDir: 'workflows' });
const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'add dark mode' } } });

const { orders } = engine.tick(wf);
for (const order of orders) {
  const result = await runYourAgent(order);              // ← your domain
  engine.green(wf, order.run, order.outputs[0], result);
  engine.close(wf, order.run);
}
```

Prefer to react instead of poll? `engine.subscribe(listener)` pushes a typed event
the instant a mutation commits. The full surface, lifecycle, and concurrency notes
are in [docs/embedding.md](docs/embedding.md).

## Docs

- [docs/authoring.md](docs/authoring.md) — the complete workflow-authoring reference
- [docs/cli.md](docs/cli.md) — the complete CLI reference
- [docs/embedding.md](docs/embedding.md) — the in-process API
- [docs/design.md](docs/design.md) — the engine design: lifecycle, firing rule,
  cascade, liveness, concurrency — cross-referenced from the source
- [CONTRIBUTING.md](CONTRIBUTING.md) — working from source, architecture, testing

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
