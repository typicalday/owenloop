# owenloop

[![CI](https://github.com/typicalday/owenloop/actions/workflows/ci.yml/badge.svg)](https://github.com/typicalday/owenloop/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**owenloop is deterministic rails for agentic workflows.**

Most agent workflows today run on hope. You write careful instructions in a
prompt or a skill — update the state file, run the verifier, stop when it's
done — hand them to an agent, and trust it to follow through. Sometimes it does.

owenloop replaces the hope with guarantees. You declare the steps and what each
depends on; the engine enforces the rest. A step runs only when everything it
needs is actually done. When a result changes, everything built on it is
invalidated and redone. When a step keeps failing, it's stopped and flagged for
a human instead of retried forever. The agents stay probabilistic — that's what
makes them useful. The workflow around them doesn't.

## See it work

A research pipeline: a researcher gathers findings, a writer turns them into
a report, and an independent reviewer must sign off before the report counts.
Every clause of that sentence is *enforced* below, not requested:

```yaml
# workflows/report.yaml
name: report
inputs:
  - name: question
    seedOwed: true
steps:
  - name: researcher
    consumes: [question]
    produces:
      - name: findings
        schema: { type: object, required: [claims, sources] }
    body: Research the question. Every claim needs a source.
  - name: writer
    consumes: [findings]
    produces:
      - name: report
        judges:
          - name: reviewer
            body: Reject the report if any claim lacks a citation
                  or drifts from the findings. Otherwise approve.
    maxAttempts: 3
    body: Write the report from the findings, citations inline.
```

You don't drive this by hand. An orchestrator — an agent skill, a plain
`while` loop, your own code — ticks the engine, hands each job to an agent,
and reports results back. Here's what the engine enforces as that loop runs:

1. **The writer cannot start early.** The first tick emits exactly one order —
   the researcher's. There is no writer job to hand out, so no eager agent can
   write a report from findings that don't exist. The hope version is a
   prompt: *"wait until research is complete before writing."*

2. **Malformed output never enters the pipeline.** The researcher reports
   findings missing `sources` — the engine *refuses the commit* at the schema,
   and the retry order carries the validation errors as feedback. The hope
   version: the bad output flows downstream and fails somewhere confusing.

3. **The report can't approve itself.** When the writer commits `report`, it
   lands in `submitted`, not done. The reviewer is a separate order to a
   separate agent — one that never saw the writer's reasoning. A rejection
   re-arms the writer with the reviewer's reasons attached to its next job.
   The hope version: *"review your work before finishing"* — the fox
   auditing the henhouse.

4. **Failure has a floor.** Third rejected attempt and `report` **stalls**:
   the engine stops issuing jobs for it and flags it for a human, instead of
   letting an agent grind the same mistake all night on your API bill.

5. **"Done" stays honest.** Sharpen the `question` after the run finishes and
   `findings` and `report` fall back to owed — the finished workflow un-does
   itself, automatically, rather than standing on inputs that no longer exist.

None of this depends on an agent reading carefully, remembering instructions,
or being honest about its own work. And notice that you never defined a state
or a transition — only what each step consumes and produces. This isn't a
state machine an agent is asked to role-play from a prompt; the states live
in the engine, and the engine doesn't negotiate. The agents stay
probabilistic; the bookkeeping around them never is. The [Quick
start](#quick-start) gets you running in two commands, and [Driving it with a
loop](#driving-it-with-a-loop) covers orchestrators — including the shipped
skills that do it for you.

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

Hope is not a control flow.

## The mental model: owed, not done

**The checklist your agents can't cheat.**

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
workflow isn't done while it sits there either. See [judges](#judges-enforced-independent-verification).

A step is **eligible to run** when it owes a debt (an `owed` or `rejected` output)
and every input it consumes is `green`. Status is never stored — it's computed from
these states on every read, so it can't drift out of sync.

Two things make this more than running steps in dependency order:

- **Outputs stay honest as inputs move.** A green output counts as done *only while*
  the inputs it was built from are still green and unchanged. Re-run an early step and
  everything built on it quietly falls back to a debt — no code required to invalidate it.
- **Rejections carry reasons.** When a reviewer rejects an output, the text rides along.
  The next job for the producer shows *why* it's being asked again, so the agent has
  the feedback in hand. (Three flavors: a reviewer's **judgment**, the engine's own
  **schema** refusal of a malformed value, and **structural** knock-backs from a
  change cascading downstream.)

### What owenloop is not

- **Not a scheduler with its own clock.** `cadence:` and `maxRunsPerDay:`
  cap how *often* an eligible step can fire, but nothing in owenloop wakes up
  on a timer — the outer loop (see below) is what initiates every tick.
- **Not shared state across instances.** Every workflow instance is its own
  island — artifacts, tasks, and runs are all scoped to one instance. The one
  deliberate exception is the `calls:`/`producedBy` link between a parent
  instance and the child it explicitly spawned.
- **Not a dynamic graph at runtime.** Collections give a workflow dynamic
  *width* — a producer can emit any number of elements — but the wiring graph
  itself (which steps exist, what each consumes and produces) is fixed when
  the definition loads, not mutable while an instance runs.

---

## It scales up when you do

Each of these is a small addition to the base model above — most workflows
use only a few. Skim the ones that sound relevant; every entry links to the
full reference.

### Judges — enforced independent verification

A `produces:` entry can declare one or more **judges**: deterministic quality
bars an artifact must clear before it counts as `green`. This is the
independent-verifier pattern, enforced structurally instead of remembered as a
convention: the artifact lands in `submitted`, not `green`, and *cannot* move
further until a separate order — with no view of the producer's reasoning —
signs off. A rejection carries its reason back to the producer's next job, the
same as any other knock-back. See [`docs/authoring.md`](docs/authoring.md#judges--quality-gates-before-green)
and [`judged-research.yaml`](examples/workflows/judged-research.yaml).

### Durable by default

State lives in a single SQLite file, not in a session or a context window.
Kill the process, come back next week, run `owenloop tick` — the engine knows
exactly what's owed and picks up where it left off. The workflow outlives the
process, the session, and the model that's driving it. See
[Storage](#how-its-built).

### Stall detection — the token-burn stopper

If an output is rejected more times than its step's `maxAttempts`, the engine
stops re-arming it. It stays a debt, but produces no more jobs — the step has
demonstrably failed, and it's flagged for a human instead of looping forever.
`owenloop retry` clears the stall and resets the counter, optionally with new
guidance. See [`docs/cli.md`](docs/cli.md).

### Schema refusal

A `produces:` entry can carry a JSON Schema; a `green`/`emit`/`seal` whose
value fails it is refused at the engine, not silently accepted and discovered
downstream. Repeated schema failures trip the same stall mechanism as
judgment rejections. See [`docs/authoring.md`](docs/authoring.md).

### Cascade invalidation

Think of it like a build system: change a header file and `make` knows every
object file that includes it needs recompiling, without you tracking that by
hand. owenloop does the same thing for agent outputs — change an early step's
result and everything built on it automatically falls back to "not done," and
gets redone the next time its inputs are green. No manual invalidation code,
no stale results slipping downstream. See
[`docs/design.md` §7](docs/design.md).

### Collections — fan-out/fan-in

A step can emit any number of elements at runtime; a `map` step runs once per
element, and a `reduce` step runs once after they're all in (or, with a
suffixed reduce, once every element's own per-element output is in). See
[`docs/authoring.md`](docs/authoring.md#consume--produce-grammar) and
[`research.yaml`](examples/workflows/research.yaml).

### Composition — `include:` and `calls:`

Build a workflow out of other workflows two ways: `include:` splices another
def's steps directly into the parent at load time (one flat graph); `calls:`
delegates to a separate child instance at runtime, keeping its internals
hidden as a black box. See [`docs/authoring.md`](docs/authoring.md#composition--include-compile-time-and-calls-runtime).

### Side-effect policies — `effect:`

Most steps are safe to re-derive when their inputs move — that's what the
cascade assumes by default. A step with an irreversible side effect (a
deploy, a publish, an external write) can declare `effect: { idempotent:
false, onInvalidate: … }` to tell the engine to pin the old result, escalate
to a human, or run a compensating step instead of silently re-firing. See
[`docs/authoring.md`](docs/authoring.md#effect--re-running-steps-with-side-effects).

### Model tiers

`model: fast | standard | strong | strongest` declares intent, not a vendor
id — the engine passes it through untouched to whatever dispatches your
workers. A portable workflow says "this step needs strong judgment"; the
host binds that to whatever model it runs on. `strong` is a high-capability
workhorse tier, not the host's single most capable model — that's what the
opt-in `strongest` tier is for, reserved for the rare step where nothing less
will do. See
[`docs/authoring.md`](docs/authoring.md#model--quality-tiers-not-vendor-ids).

### Event subscription — for embedding

Driving the engine in-process doesn't require polling: `engine.subscribe(...)`
pushes a typed event the instant a mutation commits, so a host can react
instead of ticking on a timer. See [Embedding it](#embedding-it) and
[`docs/embedding.md`](docs/embedding.md).

---

## Driving it with a loop

owenloop never runs anything itself. It hands out jobs and waits to hear back —
something has to tick it, run the work, and report the result. That something can be
as simple as a `while` loop around an agent. The [Ralph
loop](https://ghuntley.com/ralph/) — keep an agent ticking with a fresh context
each pass — is exactly this kind of outer loop, and owenloop is the half it's
missing: the persistent state and the brakes. The loop keeps going; owenloop
remembers what's owed, what failed and why, and when the whole thing is actually
done. They work side by side — the loop is the muscle, owenloop is the memory.

The outer loop is deliberately not owenloop's business, which means it can be
anything that can run a CLI command or call a function. In practice that
looks like:

- **Your own harness** — a `while` loop, a cron job, a CI stage: tick, run
  each order with whatever executes your work (an agent CLI, an API call, a
  script), report, repeat. Fully deterministic dispatch if you want it —
  see [Embedding it](#embedding-it) for the in-process version.
- **An agent as the orchestrator** — point any tool-using agent (Claude Code,
  Codex, Gemini CLI, anything that can run a shell command) at the CLI and
  tell it to drive the instance to done. A slash command or skill that wraps
  this turns "run the release workflow" into one line.
- **An agent structuring its own work, inline** — mid-task, an agent authors
  a throwaway workflow, drives itself through it, and deletes it: the engine
  as scratch discipline rather than standing infrastructure.

The engine doesn't know or care which of these is ticking it — an order is an
order. For Claude Code specifically, three shipped skills implement these
patterns ready-made:

- [`owenloop-conduct`](skills/owenloop-conduct/SKILL.md) — drive an existing
  workflow instance to done: tick, dispatch each order to a fresh subagent,
  report honestly.
- [`owenloop-author`](skills/owenloop-author/SKILL.md) — turn a plain-English
  goal into a validated workflow def, interactively, then drive it.
- [`owenloop-ephemeral`](skills/owenloop-ephemeral/SKILL.md) — author and
  drive a throwaway workflow to structure an agent's own mid-task work, then
  delete it.

---

## Quick start

Install the owenloop skills for whatever agent you use — Claude Code, Codex,
Cursor, and most others:

```sh
npx skills add typicalday/owenloop
```

Then ask your agent for what you want:

> Use owenloop-author to build me a workflow that researches a topic, writes
> a report, and doesn't accept it until an independent reviewer signs off —
> then run it on "tidepools".

The skill interviews you for anything missing, writes and validates the YAML
definition, then conducts the instance to done — dispatching each order to a
fresh subagent, relaying knock-backs, and escalating stalls to you. Already
have a def? *"Conduct the report workflow"* hands it to
[`owenloop-conduct`](skills/owenloop-conduct/SKILL.md). The engine itself
arrives via `npx owenloop` — no clone, no build, no environment variables, no
CLI verbs to memorize.

**Want to see or drive the machinery yourself?** Everything above goes
through the same small CLI (`create`, `tick`, `green`, `reject`, …).
[`docs/cli.md`](docs/cli.md) has the full command reference and a hand-driven
walkthrough of a pipeline — including a rejection knock-back and a stall —
and [`examples/workflows`](examples/workflows) has seven runnable defs, from a
minimal review loop ([`delivery`](examples/workflows/delivery.yaml)) to a
full production line ([`ship`](examples/workflows/ship.yaml)) and a
collections-heavy research pipeline
([`research`](examples/workflows/research.yaml)). Full YAML grammar:
[`docs/authoring.md`](docs/authoring.md). Driving it from your own code:
[Embedding it](#embedding-it).

---

## Requirements

- **Node ≥ 22.13.** Storage is Node's built-in `node:sqlite`, which is available
  unflagged from 22.13 onward (it still prints an experimental warning until it
  stabilises in Node 24.15 / 25.7). owenloop is an ESM-only package.
- **No native dependencies.** `node:sqlite` is built in, so there's nothing to
  compile. The only runtime deps are `yaml` (parsing defs) and
  `@cfworker/json-schema` (optional per-artifact schema validation).

```sh
npm install owenloop
```

```ts
import { createEngine } from 'owenloop';   // see "Embedding it" below
```

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
[Storage](#how-its-built)). See [`docs/embedding.md`](docs/embedding.md) for the full
surface, lifecycle, and trade-offs.

---

## How it's built

owenloop is small and split along a pure-core / imperative-shell line:

| module | responsibility |
|---|---|
| [`src/types.ts`](src/types.ts) | shared types: the six-state lifecycle, reason threads, def shapes |
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

## Testing

```sh
npm test          # node --test, spec reporter
npm run typecheck # tsc --noEmit (type-checks the source)
npm run check     # both
npm run build     # compile src/ → dist/ (also runs automatically on npm pack/publish)
```

The suite is **579 tests**: unit tests (`paths`, `store`, `model`, `defs`, `schema`,
`util`, `cli`), engine integration tests (the cascade, the stall, schema validation,
the concurrency check, `judges:` sign-off/CAS/throttling in `test/judges.test.ts`),
and end-to-end tests that spawn the real `bin/owenloop.mjs` binary and drive the
example workflows through their full lifecycles.

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

owenloop is a faithful, decoupled implementation of a dataflow-engine spec.
[`docs/design.md`](docs/design.md) is a self-contained walkthrough — the lifecycle,
firing rule, forward cascade, the reject kinds, the liveness rules, and the concurrency
model — cross-referenced from the source. [`docs/cli.md`](docs/cli.md) has the full
command reference, and [`docs/authoring.md`](docs/authoring.md) has the full YAML
grammar.

---

## License

[Apache-2.0](LICENSE) © Typical Day LLC.

owenloop is permissively licensed — use, modify, self-host, and redistribute
it, including in proprietary or closed-source products, under the terms of
the Apache License 2.0.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Note that
owenloop requires every contributor to sign a **Contributor License Agreement**
that assigns copyright in contributions to Typical Day LLC, so the project can
be maintained — and relicensed in the future if ever needed — under one clear
owner. The process is a one-time comment on your first pull request.
