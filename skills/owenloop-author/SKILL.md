---
name: owenloop-author
description: Build and run an owenloop workflow from a plain-English goal. Use when a human wants to turn a multi-step process — a research pipeline, content production, data processing, document review, an agent delivery loop — into a deterministic owenloop workflow. You interview them, compile the goal into a validated workflow def, present it back in plain English for approval, then drive the tick→work→report loop to a finished result. The human never has to read YAML. Two phases: COMPILE (interactive, with the human) and RUN (deterministic; a fresh session can just run a finished def).
---

# owenloop-author: goal → workflow → run

You are the **compiler**. The human brings a fuzzy goal ("I want to turn a topic
into a fact-checked report", "take a folder of clips and produce a cut video").
You turn it into an owenloop workflow — a small YAML file of steps wired by their
inputs and outputs — then drive the engine that runs it. The human speaks in goals
and judges results in plain English. **You** hold the YAML, the CLI, and the engine.
They never have to.

owenloop is the deterministic part: given the wiring, it computes what runs next,
what to re-run when something changes, and when to stop. Your job in COMPILE is to
get the wiring right *with the human*; your job in RUN is to do each step's work and
report it honestly.

Two phases, kept separate:

- **COMPILE** — interactive, one-time per workflow. Interview → draft the def →
  validate → present it in plain English → iterate until the human says "yes, that's
  the process." The output is a durable `.yaml` file.
- **RUN** — deterministic, repeatable. Drive `tick → do the work → report`. A
  *fresh* session with no memory of the compile conversation can run a finished def
  start to finish — that's the point.

---

## 0. Setup — get the engine running

owenloop needs **Node ≥ 22.6** (it runs TypeScript directly; no build step) and has
no native dependencies. Get it and put the `owenloop` command on PATH:

```sh
git clone https://github.com/typicalday/owenloop && cd owenloop
npm install
npm link            # puts `owenloop` on PATH; or run `node bin/owenloop.mjs` directly
```

You drive every instance with two settings — pass as flags or export once:

```sh
export OWENLOOP_DEFS=./workflows          # the DIR your workflow .yaml files live in
export OWENLOOP_DB=./.owenloop/state.db    # the sqlite file holding instance state
```

`--defs <dir>` defaults to `./workflows`; `--db <path>` defaults to
`.owenloop/state.db`. One DB can hold many instances of many workflows. If the human
is non-technical, you do all of this for them — clone, install, set the paths,
create the defs dir. They never touch a terminal.

Confirm it works: `owenloop defs` lists every workflow def found under `--defs`.

---

## 1. The mental model you must hold (so you author correct graphs)

You don't sequence steps by hand. You declare what each step **consumes** and
**produces**, and the engine derives the order. Hold these facts:

- **Artifacts, not tasks.** A workflow is a set of named artifacts (`plan`, `pr`,
  `draft`) produced by steps. A step `consumes:` some artifacts and `produces:`
  others. The wiring *is* the dependency graph.
- **Owed, not done.** The engine tracks what each step still **owes**. Every
  artifact is in one of five states:
  `owed` (declared, not produced — a debt) · `green` (accepted) · `rejected`
  (produced then judged unfit — a debt again) · `retracted` (a collection member
  dropped for good) · `skipped` (a step declined its output on a dead branch).
- **Firing rule.** A step is **eligible** the moment it owes a debt AND every input
  it consumes is `green`. No status field to flip, nothing to order by hand.
- **Forward cascade.** Re-green an early artifact and everything built on it falls
  back to a debt automatically — no stale results slip through. This is why
  re-running one step is safe: the engine re-derives only what depended on it.
- **Knock-backs carry reasons.** A reviewer-style step can `reject` an artifact; the
  reason text rides along to the producer's next job, so the worker sees *why* it's
  being asked again.
- **Stalls.** If an artifact is rejected more than its step's `maxAttempts`, the
  engine stops re-arming it and waits for a human. `owenloop retry` clears the stall.
- **Collections (fan-out/fan-in).** A step can `emit` N elements then `seal` a
  collection; a **map** step runs once per element; a **reduce** step runs once when
  all surviving members are green. Use for "do the same thing to an unknown number of
  items, then combine."
- **Skip / routing.** A router greens a `route`; both branches become eligible; the
  dead branch's producer `skip`s its own output and the engine cascades the skip down
  that subtree. A skipped artifact is not a debt, so the workflow can still finish.
- **Composition.** `include:` splices another def's steps in at load time (one flat
  graph). `calls:` delegates to a separate child instance at runtime (a black box).
  Reach for these only once a workflow is big enough to reuse pieces.

If you want the deep version, the engine repo's `README.md` and `docs/design.md`
are the source of truth — read them before authoring anything non-obvious.

---

## 2. COMPILE — turn the goal into a workflow

### 2a. Interview (keep it short, in their words)

Get just enough to wire a graph. Ask, conversationally:

1. **The end result.** "When this is done, what do you have?" → that's the final
   artifact (often `terminal: true`).
2. **The starting input.** "What do you give it to begin?" → a seeded input
   (`seedOwed: true`).
3. **The steps between, as verbs.** "Walk me through what happens, step by step." →
   each verb is a candidate step; the thing it makes is an artifact.
4. **Quality gates.** "Is there a check where, if it's not good enough, you'd send it
   back?" → a reject/knock-back loop.
5. **Repetition.** "Is there a part you do once per item for a list of things?" → a
   collection + map (+ reduce to combine).
6. **Forks.** "Does it ever split — do this OR that depending on something?" →
   routing + skip.
7. **Humans in the loop.** "Where would a person need to look or decide?" → a step
   whose output a human greens, or an escalation point.

Don't over-interview. You can draft from a rough answer and let the human correct
the draft — that's faster than extracting a perfect spec up front.

### 2b. Decompose into artifacts + steps

- **One step = one job.** If a step does two things, split it. The whole value is
  each agent getting one clear job.
- **Name artifacts as nouns** (`plan`, `sources`, `verdict`, `final_cut`), steps as
  roles/verbs (`planner`, `gather`, `reviewer`, `editor`).
- **Wire by data, not by order.** Don't think "step 3 runs after step 2" — think
  "the editor consumes the approved draft." Order falls out of the wiring.
- **Every produced artifact should be consumed** by something (or be a declared
  top-level `output:`, or a `generates:` sink) — otherwise the loader warns it's a
  dead end.

### 2c. Pick the shape

| If the process is… | use… | example |
|---|---|---|
| a straight line, maybe with a quality gate that loops back | linear + `reject` | `delivery` |
| "do X to each of an unknown number of items, then combine" | collection `emit`/`seal` + `map` + `reduce` | `research` |
| "branch: do this OR that based on a decision" | router + `skip` | `routing` |
| built out of workflows you already have | `include:` / `calls:` | `full-cycle` |

The three core patterns, distilled:

**Linear with a knock-back** (the bread-and-butter shape):
```yaml
name: delivery
outputs: [merge]
inputs:
  - name: proposal
    seedOwed: true                # stays blocked until provided
steps:
  - name: planner
    consumes: [proposal]
    produces: [plan]
    body: |
      Read the proposal and produce a concrete `plan`.
  - name: builder
    consumes: [plan]
    produces: [pr]
    maxAttempts: 5                 # gets re-armed a lot by reviewer rejects
    body: |
      Implement `plan`, open a PR, green `pr`. If `pr` carries reject reasons,
      address them and re-green.
  - name: reviewer
    consumes: [pr]
    produces: [verdict]
    body: |
      Review `pr`. If not mergeable, `reject` pr with a reason (re-arms builder).
      Otherwise green `verdict`.
  - name: merger
    consumes: [verdict]
    produces: [merge]
    terminal: true                # a final, destructive completion; never re-armed
    body: |
      Merge the PR and green `merge`.
```

**Collection (fan-out / fan-in):**
```yaml
steps:
  - name: gather
    consumes: [question]
    produces: ["gather.source[]"]        # a collection: emit elements, then seal
    body: Find sources; `emit` each, then `seal` when you have enough.
  - name: check
    consumes: ["gather.source[$i]"]      # MAP: one run per element, binds ${INDEX}
    produces: ["gather.source[$i].verdict"]
    parallel: 8                           # fan out — check concurrently
    body: Fact-check this one source; green its `.verdict`, or `retract` it if unusable.
  - name: synth
    consumes: ["gather.source[*].verdict"]  # SUFFIXED REDUCE: fires when every survivor's .verdict is green
    produces: [draft]
    body: Synthesize the surviving sources' verdicts into a `draft`.
```

A bare `gather.source[*]` reduce (no suffix) also exists — it gates only on
the members themselves, firing as soon as all survivors are green,
regardless of any per-element child artifact.

**Routing (skip the dead branch):**
```yaml
steps:
  - name: triage
    consumes: [ticket]
    produces: [route]
    body: Green `route` with {"branch":"refund"} or {"branch":"deny"}.
  - name: refund
    consumes: [route]
    produces: [refund_done]
    body: If route.branch is "refund", process and green `refund_done`. Else `skip refund_done --by refund`.
  - name: deny
    consumes: [route]
    produces: [denial]
    body: If route.branch is "deny", green `denial`. Else `skip denial --by deny`.
```

### 2d. The grammar you'll need

```yaml
name: my-workflow              # required; [a-z0-9][a-z0-9_-]*
title: Human Readable Name     # optional
description: …                 # optional
outputs: [final]               # optional; the public results (exempt from dead-end lint)

inputs:                        # external artifacts, seeded when an instance starts
  - name: brief
    seedOwed: true             # true → starts owed; must be provided to unblock
    schema:                    # optional JSON Schema (2020-12); a bad value is refused
      type: object
      required: [text]

steps:
  - name: worker
    consumes: [brief]          # plain | map src[$i] | reduce src[*] or src[*].child
    produces:                  # singleton | collection src[] | map src[$i].x
      - name: result           # a produce can be a bare name OR {name, schema}
        schema: { type: object, required: [ok] }
    body: |                    # the prompt handed to the worker; ${WORKFLOW}
      Do the one job and green `result`.   # ${RUN} ${INDEX} are filled in
    bodyFile: path/to.md       # load body from a file, relative to this workflow's dir; mutually exclusive with body
    generates: [audit_log]     # optional; outputs nothing consumes (no dead-end warning)
    maxAttempts: 3             # reject cap before the output stalls (default 3)
    parallel: 1                # max concurrent runs (raise to fan out a map)
    terminal: false            # true → green output is final, never re-armed
    on: [inputsGreen]          # firing trigger: inputsGreen (default) | allGreen | idle
    idleAfter: 30m             # required when 'idle' is in on:
```

Consume/produce path grammar:

| pattern | meaning |
|---|---|
| `plan` | plain consume / singleton produce |
| `gather.source[]` | collection produce (emit N, then seal) |
| `gather.source[$i]` | map (one run per element; binds `${INDEX}`) |
| `gather.source[$i].verdict` | a map step's per-element output |
| `gather.source[*]` | reduce (fires once sealed and all surviving *members* are green) |
| `gather.source[*].verdict` | suffixed reduce (fires once sealed and every surviving member's `.verdict` is green) |

A step consumes in exactly one mode (plain, map, or reduce) — the loader enforces it.

### 2e. Validate (the loader is your first reviewer)

owenloop type-checks and validates a def before any instance exists — dangling
consumes, two producers for one artifact, map/reduce mismatches, and dependency
cycles are all caught up front. Trigger it by listing or creating:

```sh
owenloop defs                                          # parses every def; surfaces load errors
wf=$(owenloop create my-workflow --provide brief='{"text":"…"}' | jq -r .workflow)
owenloop status $wf                                    # done / debts / eligible / blocked
```

If `create` or `defs` errors, the message names the wiring fault — fix the YAML and
re-run. Do not move on with a def that doesn't load.

### 2f. Present it to the human IN PLAIN ENGLISH for approval

**This is the step that makes the workflow theirs.** A non-technical human can't read
YAML — but they *can* judge a process. Describe the compiled workflow as a numbered
list, in their domain language, never as code:

> Here's the process I built. Tell me if it's right:
> 1. You give it **a topic**.
> 2. It **finds sources** on that topic (as many as it needs).
> 3. It **fact-checks each source** on its own — bad ones get dropped.
> 4. It **writes a draft** from the sources that held up.
> 5. A **reviewer checks the draft**; if it's weak, it goes back to step 4 (up to 5
>    tries) — otherwise you get the **final report**.
> Where would *you* want to look or approve something?

Then make their judgment easy: confirm the start, the end, each gate, each fork, and
each human touchpoint. When they say "actually, the reviewer should also check X" or
"there's no fact-check, just use everything" — that's the compile loop working. Edit
the YAML, re-validate (2e), re-present. Iterate until they say "yes, that's it."

**Watch for the real failure mode:** the human nodding along without actually being
able to tell whether the process is right. Probe — "what would a *bad* source look
like?", "what happens if the reviewer keeps rejecting?" — so their approval is real,
not polite. If they genuinely can't judge it, that's signal, not failure: note it.

### 2g. The def is now a durable artifact

Save it under the defs dir as `my-workflow.yaml` (or `my-workflow/workflow.yaml`).
That file is the whole compiled workflow. Anyone — including a fresh session — can
now run it without the compile conversation.

---

## 3. RUN — drive the loop

Running is the deterministic phase. The engine never executes anything itself: it
hands out **orders** (jobs) and waits to hear back. You tick, do the work, report.

```sh
# start an instance, seeding the input the workflow owes up front
wf=$(owenloop create my-workflow --provide brief='{"text":"…"}' | jq -r .workflow)

# the worker loop — repeat until status shows done:
owenloop tick $wf                 # claim eligible orders → JSON {orders:[…]}
# for each order: read order.prompt + order.consumes + order.owes, do that one job, then:
owenloop green $wf <run> <path> --value '<json>'   # report a normal output
owenloop status $wf               # done / debts / eligible / blocked
```

**What an order gives you** (everything you need, nothing else):
`run` (job id — pass back to green/close), `step`, `key` (element key for map jobs),
`inputs`, `outputs`, `prompt` (with `${WORKFLOW}`/`${RUN}`/`${INDEX}` filled in),
`consumes` (the accepted input values), and `owes` (the feedback channel — reject
reasons and counts so you can escalate before the engine stalls the step).

**Reporting verbs** (match the step's shape):

| verb | when |
|---|---|
| `green $wf <run> <path> --value <json>` | accept a normal/singleton output |
| `emit $wf <run> --items '[{…},{…}]'` | add elements to a collection |
| `seal $wf <run> [--value <json>]` | mark a collection complete |
| `reject $wf <path> --by <who> --text <msg>` | knock back an output (re-arms its producer) |
| `retract $wf <path> --by <who> --text <msg>` | drop a collection member |
| `skip $wf <path> --by <who> --text <msg>` | decline an output on a dead branch |
| `close $wf <run> [--outcome ok\|failed\|…] [--summary s]` | release a claimed job |

**Exit-code contract — critical.** `green`/`emit`/`seal` exit **non-zero** when the
engine refuses the commit (the value was born-rejected because an input moved, or it
failed its schema). The result JSON still prints to stdout; the reason goes to
stderr. **Treat a non-zero exit as failure, not success** — don't close the run `ok`.

**A fresh session can do all of this.** Running a finished def needs no memory of how
it was compiled — just the def, the db, and this loop. That separation is the
product: compile once with a human, run anytime, anywhere, deterministically.

### Stalls

If a step's output is rejected past `maxAttempts`, it **stalls** — the engine stops
re-arming it and a human is needed. Clear it (optionally with new guidance):

```sh
owenloop retry $wf <path> --text "use the new fixture"   # resets the counter, re-arms
```

---

## 4. Iterate on a running (or finished) workflow

Two distinct channels — pick by *what changed*:

- **Re-arm a step (the wiring is right, the output was wrong).** `reject` or `retry`
  the artifact with guidance. The forward cascade re-derives only what depended on
  it. Use for "redo this step, here's why."
- **Re-author the def (the *process itself* was wrong).** The human realized a step
  is missing, a gate is in the wrong place, or a branch is needed. Go back to COMPILE
  (§2): edit the YAML, re-validate, re-present. New instances use the new def; the
  def file is the source of truth.

Don't fix a process problem by hand-nudging a running instance, and don't re-author
the whole def to fix one bad output. Match the channel to the change.

---

## Hard rules / gotchas

- **One producer per artifact.** Two steps can't both produce `plan`. The loader
  rejects it.
- **A step consumes in one mode only** — plain, one map, or one reduce. Not a mix.
- **`terminal: true` is final.** A terminal green is a destructive completion and is
  never re-armed by the cascade. Use it for merges, publishes, sends — real
  irreversible endings. For *other* side-effecting steps that shouldn't silently
  re-fire when inputs move, use `effect: { idempotent: false, onInvalidate: … }`
  (`pin` / `escalate` / a named compensating step) — see the engine README.
- **Schema-validate the inputs and outputs that matter.** A JSON Schema on an input
  or a produce makes the engine refuse malformed values instead of letting them
  green — cheap insurance on the artifacts a human or a downstream step relies on.
- **Honest `failed` over a fake green.** If a worker can't do its job, `close … 
  --outcome failed` — don't green a lie. The engine's stall/retry machinery exists
  to handle this honestly.
- **Don't sequence by hand.** If you're tempted to add a step "just to make B run
  after A", you've mis-wired — make B consume what A produces instead.
- **The human judges in plain English; you hold the YAML.** Never make a
  non-technical human read or edit the def. Describe, confirm, edit on their behalf.
