# Writing a workflow

A workflow is one self-contained YAML file under the `--defs` directory (either
`name.yaml` or `name/workflow.yaml`). It's parsed, type-checked, and **validated**
before any instance is created — dangling consumes, two producers for one artifact,
map/reduce mismatches, and dependency cycles are all caught up front. An unrecognized
key anywhere in the grammar (a typo like `bodyfile:`, a stray field) is also a
load-time error, naming the offending key — nothing is silently ignored.

```yaml
name: delivery                 # required; [a-z0-9][a-z0-9_-]*
engine: 1                      # optional; declares the engine generation this def targets —
                                #   omit it and it defaults to the version this build supports.
                                #   A mismatch is a load-time DefError, not a confusing runtime failure.
title: Software delivery       # optional
description: …                 # optional
x:                              # optional; opaque extension map for external runners/
  anything: goes                #   tooling — shape-checked (must be a map), contents
                                #   never read or interpreted by the engine (design.md §27.3)

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
      - name: plan             # a produce can be a bare name, or {name, schema, ...}:
        schema:                #   a green/emit whose value fails this is refused
          type: object
          required: [plan]
          properties: { plan: { type: string } }
        # maxAttempts: 2       # optional; overrides the step's maxAttempts (below)
        # maxSchemaFailures: 1 #   just for this produce — see design.md §6
    body: |                    # the prompt; ${WORKFLOW} ${RUN} ${INDEX} are filled in
      Read the proposal and produce a `plan`.
    bodyFile: path/to.md       # load body from a file, relative to this workflow's dir; mutually exclusive with body

    generates:                 # optional; outputs this step makes that NO step
      - audit_log              #   consumes. Exempt from dead-end lint; otherwise
      - report[]               #   identical to produces:.

    # all optional, with defaults:
    maxAttempts: 3             # reject cap before the output stalls — default for
                               #   every produce on this step; a produce can override
    maxSchemaFailures: 5       # schema-reject cap before the output stalls; 0 = off —
                               #   same per-produce override rule as maxAttempts
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
    model: standard            # quality tier (fast | standard | strong |
                               #   strongest) or a literal model id — opaque
                               #   to the engine, passed through on the order
                               #   (see below)
    workdir: …                 # opaque hint passed through on the order; omitted when unset
    x:                          # optional; opaque extension map, passed through
      anything: goes            #   untouched onto the order (Order.x); see design.md §27.3
```

## `model:` — quality tiers, not vendor ids

The engine never calls a model; `model:` is an opaque string that rides the
order to whatever dispatches your workers (an agent skill, a runner, your own
loop). Portable workflows should declare **intent** with one of four tier
names and let the dispatcher bind them to the host it runs on — Claude Code,
Codex, Gemini CLI, whatever:

- `fast` — mechanical work: grounded reading, extraction, formatting
- `standard` — everyday judgment: routing, merging, most judges
- `strong` — the expensive step the workflow exists for: synthesis, final
  artifacts, high-stakes judges. This is a high-capability **workhorse**
  tier — the ceiling a normal workflow should reach for — not the host's
  single most capable model.
- `strongest` — the rare step where nothing less will do, cost accepted: the
  single most capable model the host offers. This tier is never a sensible
  default and a def must opt into it explicitly for one specific step; most
  workflows never need it.

A value that isn't one of the four tiers should be passed through verbatim as
a literal model id. Pin an exact model when you need reproducibility — just
know the def is now host-specific, on purpose. Omit `model:` entirely and the
dispatcher uses its default.

## `produces:` vs `generates:`

A stem under `produces:` is expected to be consumed downstream — owenloop's lint warns
if nothing consumes it. A stem under `generates:` is deliberately consumed by nothing
(an audit log, an external artifact, a stub); lint leaves it alone. Generated artifacts
are otherwise identical: schema-validated, fingerprinted, greenable, and visible in
`status`/`show`.

## `judges:` — quality gates before green

A `produces` entry can declare one or more **judges**: deterministic quality
bars an artifact must clear before it counts as `green`. Judges are an
enforced form of the independent-verifier pattern — a separate order, with no
view of the maker's reasoning, has to sign off before the artifact counts as
done. Use judges for criteria that would never merit a review step of their
own — completeness, rigor, tone, format. If it's actual domain work (a PR
review, a legal sign-off), that stays a normal step, like `delivery.yaml`'s
`reviewer`.

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
            bodyFile: judges/rigor.md # or a prompt loaded from disk —
                                      # body/bodyFile mutually exclusive
            model: strong             # optional, per-judge model tier
            inputs: true              # optional, default false — judge also
                                      # reads the producer's inputs (question)
    maxAttempts: 5    # producer's cap (default for every produce on this step)
                      # — also bounds judge-reject → rebuild loops; `report`
                      # above could set its own maxAttempts: to override it
```

Each judge is a real step under the hood — it fires its own worker order
through the normal pipeline, with its own throttles (`cadence:`,
`maxRunsPerDay:`) and retry/timeout behavior. When `researcher` commits
`report`, it lands `submitted` (not `green`) instead — schema-valid, but
waiting on sign-off. Each judge evaluates it and calls the *same*
`green`/`reject` verbs you already use, targeted at `report` — no new CLI
surface. Once every declared judge has approved the current version, `report`
goes `green`. A single reject sends it straight to `rejected` and re-arms
`researcher`; a rebuild starts every judge's ledger fresh, so a sibling
judge's earlier approval never carries over to a new version.

A judge's `reject` is itself CAS-guarded against staleness: if the judged
artifact has already moved past the version this judge was looking at (a
sibling judge rejected it first, the producer resubmitted, or a human
bypassed the ledger), the reject is refused — `born-rejected`, exit code 1 —
instead of silently corrupting the newer submission's ledger.

A human can always short-circuit the panel:

```bash
owenloop green $wf human report --value '{"sections":[...],"approvedManually":true}'
```

The sentinel run id `human` bypasses the ledger outright, regardless of how
many judges have signed off. See
[`judged-research.yaml`](../examples/workflows/judged-research.yaml) for a
runnable example, and [`docs/design.md` §24](design.md) for the full
design (the `submitted` state, the sign-off ledger, the stale-verdict race,
and how judge order failures are kept separate from judge rejects).

## `group:` — exclusive/inclusive produce groups

A step's `produces:` list can carry a `group:` entry naming two or more of
that step's own singleton sibling stems and the commit-exclusivity contract
the engine enforces across them — no more manually calling `engine.skip()`
on the branch a router step didn't take.

```yaml
produces:
  - simple
  - urgent
  - group: route
    mode: exactlyOne       # exactlyOne | atMostOne | atLeastOne
    of: [simple, urgent]
```

- **`exactlyOne`** / **`atMostOne`** — once one member goes `green`, the
  engine refuses any commit to a sibling (`'group-rejected'`, like
  `'schema-rejected'` — value not written, run left open) and auto-skips the
  untouched siblings in the same step. The two modes differ only in intent:
  `atMostOne` also tolerates a producer that routes to *neither* member.
- **`atLeastOne`** — no refusal, no auto-skip; once any one member is green,
  the rest no longer count as outstanding for done-ness.

A group's auto-skip re-arms exactly like a manual skip (same fingerprint
mechanism) if the upstream inputs it depended on move. See
[`routing-groups.yaml`](../examples/workflows/routing-groups.yaml) for a
runnable example, and [`docs/design.md` §26](design.md) for the full
design (refusal timing, the judges interaction, and the model-checker parity
guarantee).

Eligibility (the automatic sweep) is pre-filtered the same way commit-time
refusal is: a group-blocked stem — including a `submitted` stem still waiting
on a judge, per `judges:` above — is never offered as a firing while a
different sibling already sits green. A human `retry` re-arms it, but the
group suppression re-applies on the next tick unless the winning sibling is
knocked down first.

## `outputs:` — the workflow's interface

Top-level `outputs:` declares which stems are the workflow's intentional public results
— what a parent workflow consumes when this one is embedded. Listed stems are exempt
from dead-end warnings, but unlike `terminal:` they stay re-armable.

| key | level | lint-exempt | re-armable | meaning |
|---|---|---|---|---|
| `terminal: true` | step | yes | **no** | final result; never re-armed |
| `generates:` | step | yes | yes | internal sink, not the public interface |
| `outputs:` | workflow | yes | yes | public interface / composition boundary |

## Composition — `include:` (compile-time) and `calls:` (runtime)

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

## `effect:` — re-running steps with side effects

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

## `on:` — when a step fires

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

## Consume / produce grammar

| pattern | role | fires |
|---|---|---|
| `plan` | **plain** consume / **singleton** produce | when `plan` is green |
| `gather.source[]` | **collection** produce | the producer `emit`s N elements, then `seal`s |
| `gather.source[$i]` | **map** | one run per element; binds `${INDEX}` |
| `gather.source[$i].verdict` | **map** produce | the per-element output of a map step |
| `gather.source[*]` | **reduce** consume | once, when sealed and all surviving members green |
| `gather.source[*].verdict` | **reduce** consume (suffixed) | once, when sealed and every surviving member's `.verdict` is green |

A step consumes in exactly one mode — plain, a single map, or a single reduce. The
validator enforces this at load time, so you don't hit it as a runtime surprise.

Collections add fan-out/fan-in on top of the base grammar: a step emits N
items, a `map` runs once per item, a `reduce` runs once they're all in, and a
suffixed reduce (`src[*].child`) can fan in on a map's per-element output
instead of the bare elements. See [`research.yaml`](../examples/workflows/research.yaml)
for a runnable example.

## Artifact values are JSON, and secrets don't belong in them

An artifact's `value` is always a JSON object (`Record<string, unknown>`,
never a raw string or binary blob) — this is enforced by the type, not just
convention. For anything large or not naturally JSON — a big document, a
binary file, a build artifact — put a *handle* in the value (`{url: …}`,
`{path: …}`, `{sha: …}`) that points at the real payload stored elsewhere,
rather than inlining the payload itself.

Don't put credentials or secrets in an artifact value. Values are persisted
as plaintext in the SQLite store (no encryption at rest) and are copied
verbatim into the prompt/context of every order that consumes them — anyone
who can read the database or a downstream job's prompt can read it.
