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
        # bind: modifier       # accepted value's `modifier` key writes through to run routing
    body: |                    # the prompt; runtime placeholders are filled in when available
      Read the proposal and produce a `plan`.
    bodyFile: path/to.md       # load body from a file, relative to this workflow's dir (must resolve inside it); mutually exclusive with body

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
    onCancel:                  # optional cleanup declaration (see below)
      consumes: [workspace]    #   plain consume subset needed after cancellation
    invalidates: [plan]        # which input stems this step may invalidate
    cadence: "0s"              # min spacing between runs (e.g. "30m")
    maxRunsPerDay: 1000
    reapTtl: 30m               # duration; per-step stranded-lease TTL (overrides
                               #   engine reapTtlMs; default 2h). A beat within it
                               #   keeps the lease fresh.
    maxLease: 2h               # duration; opt-in cap on TOTAL lease lifetime,
                               #   enforced regardless of heartbeats. Omitted =
                               #   no cap (heartbeats extend indefinitely). Set it
                               #   only as a runaway backstop — it can reap a
                               #   still-beating job.
    model: standard            # quality tier (fast | standard | strong |
                               #   strongest) or a literal model id — opaque
                               #   to the engine, passed through on the order
                               #   (see below)
    workdir: …                 # opaque hint passed through on the order; omitted when unset
    workdirFrom: workspace.payload.worktreePath  # resolve workdir from a consumed value
    executor: agent               # opaque executor value (default: agent); see below
    command: …                  # required when executor: command; opaque, never shelled out
    spec:                       # optional opaque config map, shape-checked like x: (a plain map)
      anything: goes            #   contents never read by the engine; see below
    capabilities: [nightly, batch]    # optional routing capabilities for peer-orchestrator
                                #   claim filtering (tick --capability); empty = absent; see below
    x:                          # optional; opaque extension map, passed through
      anything: goes            #   untouched onto the order (Order.x); see design.md §27.3
```

## x.discovery — advisory workflow discovery metadata

x.discovery is an Owenloop-owned convention inside the otherwise opaque
top-level x: map. It lets a person or catalog tool understand what a workflow
does, when to choose it, when a close-looking workflow is the wrong choice, and
how to seed/read its public interface:

~~~yaml
x:
  discovery:
    description: >-
      One non-empty paragraph explaining the workflow in colleague-facing language.
    whenToUse:
      - a non-empty trigger phrase
    notFor:
      - a non-empty anti-trigger phrase
    interface:
      inputs:
        - name: proposal
          summary: A non-empty description of the seed value.
          schemaRef: "#/inputs/0/schema"
      outputs:
        - name: merge
          summary: A non-empty description of the public result.
          schemaRef: "#/steps/6/produces/0/schema"
~~~

The bag itself is optional today, so existing definitions remain compatible.
Its absence is a lint warning, not a loading or execution failure. Once the bag
is present, all four top-level fields are required: catalog browsing
(description), positive routing (whenToUse), false-positive avoidance (notFor),
and usable seeding/result information (interface) answer separate questions. In
particular, an anti-trigger is not redundant with a trigger: it rules out the
nearby cases that would otherwise appear to match.

description must be a non-empty string. whenToUse and notFor must each be
non-empty arrays of non-empty strings. interface.inputs and interface.outputs
are required arrays, though either can be empty when the workflow genuinely has
no declared inputs or no public outputs. Each entry must have a non-empty name,
summary, and schemaRef. The entries cover every declared input and every public
outputs: name exactly once; no unknown or duplicate names are allowed. Their
named artifacts must carry schemas. schemaRef is a local JSON Pointer beginning
#/ to that existing machine schema, not a second copy of the schema.

owenloop lint reports missing or malformed discovery data as field-specific
warnings. These warnings do not fail lint, loading, packing, publishing, pushing,
or execution. Other x vocabularies remain opaque and unrestricted; only this
authoring-lint convention is recognized.

## x.implements — advisory external interface claims

When present, x.implements must be a non-empty array of external interface
coordinates a definition claims to satisfy:

~~~yaml
x:
  implements:
    - name: research-report
      version: "1"
    - name: auditable-report
      version: "2026-08"
~~~

Every entry contains exactly non-empty string name and version fields. More
than one claim is allowed, but an exact name/version coordinate may appear only
once. Version is intentionally an opaque string here: Owenloop does not impose
SemVer or catalog policy. Malformed claims are warning-only authoring lint, so
they neither stop lint nor turn loading or execution into a failure. Keeping
the field under x also means binaries at engine version 1 ignore it and continue
to load definitions written before or after the convention.

x.discovery.interface and x.implements answer different questions.
x.discovery.interface describes this definition's own inputs and public outputs
and owns the local schemaRef vocabulary. x.implements only names an external
catalog contract; it deliberately copies no schemas, artifact mappings, or
summaries and introduces no second pointer convention. Catalog lookup and
publish-time rejection are hub responsibilities, not owenloop lint.

## `model:` — quality tiers, not vendor ids

The engine never calls a model; `model:` is an opaque string that rides the
order to whatever dispatches your Step Agents (an agent skill, a runner, your own
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

## `workdirFrom:` — resolve a local workdir from a consumed value or a declared input

`workdirFrom:` sets the existing `Order.workdir` from a nested field in a green
artifact. The grammar is `<stem>.<dotted.value.path>`, and the stem may name
either one of the step's own plain consumes or one of the definition's declared
inputs:

```yaml
inputs:
  - name: target          # where the run should do its work
    seedOwed: true
steps:
  - name: provisioner
    consumes: []          # a command step that creates the worktree
    produces: [workspace]
    workdirFrom: target.path
  - name: builder
    consumes: [workspace]
    produces: [pr]
    workdirFrom: workspace.payload.worktreePath
```

A consume always wins when a stem could be read either way, so a step that
consumes the artifact it takes its workdir from keeps reading out of that
firing's consume binding. The consume must be plain rather than map (`[$i]`) or
reduce (`[*]`). The engine resolves the longest matching stem prefix when an
artifact stem itself contains dots. `workdir:` and `workdirFrom:` are mutually
exclusive.

Reach for the **input** form when the step cannot consume the value. The clearest
case is a `command` step: command orders are gated with the hard consumed-artifact
rule, which refuses any consumed value that carries no producer signature — and a
human-supplied seed input never has one. Naming the input in `workdirFrom:`
routes the value through `Order.workdir`, a spawn parameter the engine resolves
itself, rather than through `consumes`. This is also the only way a
run-supplied value reaches a `command:` string's context, because a command's
argv is passed to `/bin/sh -c` verbatim and is never interpolated.

Naming an input creates an ordering edge without a consume: while that input is
still owed, the firing defers with `workdir-unresolved` and detail
`input '<name>' is not green yet`, exactly as a consume would have made it wait.
The value does not appear in `Order.consumes`.

At order-build time the engine walks the resolved value using the dotted path.
A missing field, non-object intermediate, array, non-string final value, empty
string, or whitespace-only string defers the firing with reason
`workdir-unresolved`; the engine emits no order and inserts no run. The engine
passes a valid path through unchanged: the engine does not resolve or normalize
a relative path and does not change the worker's current-directory semantics.
The producer and worker must therefore run on the same machine. A permanently
unresolvable path remains deferred until a valid value arrives.

`Order.workdir` is an opaque location hint that no proof covers, whichever form
produced it. What bounds where a worker may actually run is machine-side and
belongs to the operator running the shift, not to the definition.

## `executor:` — declaring the executor

Every step in every def written before this feature dispatches to an LLM
agent — that's still the default, and omitting `executor:` entirely leaves a
def byte-for-byte unchanged. `executor:` lets a step opt into a *different*
kind of executor instead: a shell command, a webhook, a browser-automation
runner, anything a dispatcher on the other end of `tick` knows how to run.
The engine never executes anything itself — `executor:` is an opaque field
that rides the order (same pass-through contract as `model`) for whatever
drives your Step Agents to switch on.

```yaml
steps:
  - name: tester
    consumes: [reviewed_plan]
    produces: [result]
    executor: command              # opaque to the engine; default is 'agent'
    command: npm test            # required when executor: command; never parsed or shelled out
    spec:                        # optional opaque config for the dispatcher
      timeout: 300
      workdir: .
    body: ""                     # not required for executor: command
```

Two shape rules, both enforced at load time, everything else opaque:

- **`executor: command` requires `command:`.** A `command`-executor step with no
  `command:` is a load-time `DefError` — the dispatcher would have nothing to
  run.
- **`executor: agent` (explicit) requires a real `body:`.** Omitting `executor:`
  still defaults to `'agent'` and still needs no body-shape check beyond
  today's behavior — this rule only fires when a step *explicitly* writes
  `executor: agent` and leaves `body:` empty, which is almost certainly a
  mistake (an agent step with no prompt).

Any other `executor` value (`browser-automation`, `webhook`, your own executor value) is
fully opaque — no `body:`/`command:` requirement at all. A definition can
optionally declare `executors: [agent, command]` at the top level as a typo
guard; when present, `validateDef` rejects any step (or judge — see below)
whose effective executor (after the `agent` default) isn't in the list:

```yaml
name: my-workflow
executors: [agent, command]   # optional allow-list; absent = any executor string accepted
```

`command:` and `spec:` are opaque the same way `x:` is: `command` is
shape-checked as a string, `spec` as a plain map, and neither is ever read or
interpreted by the engine beyond that. All three (`executor`, `command`,
`spec`) ride through `buildOrder` onto the emitted `Order` untouched, exactly
like `model` and `workdir`. See [`docs/design.md` §27.4](design.md) for the
full contract.

A command step's `consumes:` reach the command through its environment, not its
working directory: `owenloop work exec` sets `OWENLOOP_CONSUMES` with the JSON
inline, or `OWENLOOP_CONSUMES_FILE` with a path to it once that JSON exceeds
64 KiB. The worker also supplies rejection feedback and the order's current
modifier through `OWENLOOP_FEEDBACK`/`OWENLOOP_FEEDBACK_FILE` and
`OWENLOOP_MODIFIER`. See [`docs/bundles.md` § Consumed inputs for command
steps](bundles.md#consumed-inputs-for-command-steps) for the reader snippet and
the omitted-key rule.

## `capabilities:` — logical capability tags

`capabilities:` is an optional list of strings on a step naming what that step
*needs* — `gpu`, `repo-access` — not where it runs. They are part of **your**
vocabulary as a def author: a capability tag, chosen to describe the work.
An empty `capabilities:` list normalizes to absent.

**Never write a crew name in a def.** A crew is a deployment fact belonging to
one org on one hub; a def is portable. The indirection below is what keeps the
two apart.

**Golden path: most defs need no capabilities at all.** A step **without capabilities** routes
to the run's `defaultCrew` param if one was given, else to the starter's
personal crew. That is the default path, and it is the right one until you have
a fleet with genuinely different machines in it. Capabilities and routes are the
"advanced: teams & fleets" path — reach for a capability only when a step needs a
*specific* kind of machine.

### On a hub: an admin binds each capability to a crew

On a hub, every capability a step uses must be **bound to at least one crew by an org
admin** — `owenloop capability bind <capability> <crew>`, or Console → Settings → Capabilities.
A capability may bind several crews, and each `capability bind` ADDS one. See
[capability routes](cli.md#capability-routes) for the commands.

- **An unbound capability fails the run at `start_run`**, with an error naming the
  capability and carrying the exact fix command. That fail-fast is deliberate: the
  old behavior was an order that sat unserved forever. Route is **explicit
  only** — there is no implicit fallback in which an unbound capability routes
  somewhere by itself.
- **Routes are live, and that is the headline.** Adding a crew to a capability
  widens who serves it at the next poll of every in-flight run; removing the
  capability's **last live** route pauses the steps that use it until it is bound
  again. As an author this means your def does **not** need re-publishing when
  the fleet moves: the operator ADDS the new crew — from that moment both crews
  serve the capability — and then REMOVES the old one, and your running work follows
  across without a restart.

### Locally: capabilities are a tick filter

The local/OSS engine has no capability route table; there, the same capabilities act as a
work-splitting filter so several orchestrators ticking the *same* database can
divide the work. A tick caller may pass one or more `--capability <x>` filters (CLI)
or `engine.tick(wf, { capabilities: [...] })` (embedding), and a step is left for a
*different* caller only when **both** the caller's filter and the step's own
`capabilities:` are non-empty and share no value — that step's firings defer with
reason `capability-mismatch` until a caller whose filter matches (or a caller with
no filter at all) ticks it.

Capabilities are logical tags in both worlds; only the hub adds the route
indirection. Two consequences of the local filter are worth stating plainly:

- **Routing, not authorization.** A caller that passes *no* filter claims every
  step, with capabilities or not — and any Step Agent that can reach the database can tick
  without a filter. Locally, capabilities are a work-splitting convenience, never a security
  boundary; never rely on them to keep a step away from a Step Agent that shouldn't
  run it.
- **Starvation hazard.** If every live caller ticks with a capability filter and
  none of them intersects a given step's capabilities, that step's orders sit
  deferred forever with `capability-mismatch` — no caller ever claims them.
  Operators running capability-filtered callers should monitor the deferred/blocked entries
  (each folded deferral in a `TickResult` carries its `reason`) so a
  permanently unclaimed step is caught rather than silently stuck.

A `workdirFrom` firing can also remain deferred forever with
`workdir-unresolved`. That reason means no usable nested path has been supplied:
the artifact is not green yet, or its value is missing, has an invalid shape, or
is not a non-empty string. Fix whoever supplies that artifact — the producing
step for a consumed stem, or the human starting the run for a declared input.
Changing the consumer's worker does not bypass the engine's workdir resolution
check.

`capabilities:` is distinct from [`executor:`](#executor--declaring-the-executor):
`executor:` says what *kind* of executor should run an order once it's claimed;
`capabilities:` says *which* caller may claim it in the first place — a tick filter
locally, a bound crew on a hub.

### The trust boundary: publishing shares, installing scopes

`push` and `install` both put a def on your hub, and they treat its capabilities
differently on purpose.

`owenloop push` publishes defs **your org authored**. Their capabilities join the
org's **shared** vocabulary as written: two of your own defs that both author
`review` deliberately mean the same `review`, served by the same crews. That is
the whole value of a shared vocabulary.

`owenloop install <owner>/<repo>` publishes a def **someone else authored**. An
outside author writing `review` is not making your org's claim, so every
capability an installed def authors becomes `<def-name>.<capability>` —
`analyzer.review`, not `review` — unless you say otherwise, once, at install
time. Scoping is the default because the failure it prevents is silent: an
outside def entering the shared vocabulary starts drawing orders from the crews
already bound to that name.

Link deliberately, when you actually mean it. If your `reviewers` crew genuinely
should serve the installed def's `review`, answer the install prompt with
`code-review` (or whatever your org calls it), or pass
`--map review=code-review`. Then the org name it takes is the one your crews are
already bound to, and it draws from them by design rather than by collision.

**Never edit a def's content to get the mapping you want.** The mapping is
org-side data, recorded against `(def, authored-name)` on your hub; the def stays
byte-for-byte as its author wrote it, so upstream updates keep applying. Editing
`capabilities:` in a def you did not author forks it.

Four names, in the order the engine derives them:

| Vocabulary | Where it comes from |
| --- | --- |
| **authored** | what the def's YAML says, e.g. `review` |
| **mapped** | the org name a capability mapping gives it, e.g. `analyzer.review` |
| **composed** | the mapped name plus the run's modifier, e.g. `analyzer.review:deep` |
| **offered** | the composed name after any capability reroute rewrites it |

The two rewrite points key on different halves and fire at different times.
**Mappings key on the AUTHORED name and apply BEFORE composition** — they answer
"what does this def's `review` mean here". **Reroutes key on the COMPOSED string
and apply AFTER composition** — they answer "where should `analyzer.review:deep`
go right now". A reroute is therefore the operational lever (move traffic
today); a mapping is the identity decision (what this def's capability *is* in
your org).

## `produces:` vs `generates:`

A stem under `produces:` is expected to be consumed downstream — owenloop's lint warns
if nothing consumes it. A stem under `generates:` is deliberately consumed by nothing
(an audit log, an external artifact, a stub); lint leaves it alone. Generated artifacts
are otherwise identical: schema-validated, fingerprinted, greenable, and visible in
`status`/`show`.

## `bind:` — write an accepted artifact into run state

A produce mapping may declare a `bind:` target. When that artifact is accepted,
the engine writes the selected value into the run instance in the same
acceptance transaction. The artifact's own version and event history remains the
record of the value and any later rejection; the bind adds the engine's sync
event.

The short form reads the accepted object's key named after the final segment of
the target. Here, the producer submits an object such as
`{ modifier: 'deep' }`; `bind: modifier` reads its `modifier` key.

```yaml
modifiers: [express, standard, deep]
steps:
  - name: choose_modifier
    produces:
      - name: modifier
        bind: modifier
```

The mapping form selects a dotted object path. It is equivalent to the short
form when `from` is omitted: `bind: { to: meta.customer }` reads the
accepted object's `customer` key.

```yaml
      - { name: customer, bind: { to: meta.customer } }
      - name: decision
        bind: { to: modifier, from: payload.value }
```

The two supported target families are:

- `modifier` — the extracted value must be one member of the workflow's
  declared `modifiers:` list. A name with whitespace cannot be in that list
  because `modifiers:` refuses it at definition-parse time. A workflow may bind
  `modifier` only once. A value outside the list is refused at submit time.
- `meta.<key>` — writes any JSON value into non-routing instance metadata.
  Metadata never changes capability composition or routing.

`from` is always a dot-separated path through object keys; there is no
whole-value form. Arrays, escaping, and array indexes are not part of this
grammar. A missing path is a submit-time refusal.
Bindings are supported on singleton and map produces, not collection produces.
Only a green acceptance applies the bind: a producer submission that is waiting
for judges has not synchronized the run yet.

When a capability-bearing step can run before the modifier-bound artifact is
accepted, lint warns that the step is not downstream of the bound artifact.
Wire the dependency explicitly if that step must use the synchronized modifier.

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
          - name: ci-gate
            body: "unused by a command judge, but still a required field" # every
                                      # judge needs body/bodyFile regardless of executor
            executor: command           # judges can be deterministic too — same
            command: scripts/ci-gate.sh  #   executor:/command: contract as a normal step
    maxAttempts: 5    # producer's cap (default for every produce on this step)
                      # — also bounds judge-reject → rebuild loops; `report`
                      # above could set its own maxAttempts: to override it
```

A judge entry accepts the same `executor:`/`command:`/`spec:` fields as a
normal step (see [`executor:` above](#executor--declaring-the-executor)) — a
judge can be a deterministic check (a script's exit status) instead of an
LLM verdict. Note `body:`/`bodyFile:` is still required on every judge
regardless of `executor:` — that requirement is orthogonal to this feature and
applies even to a `executor: command` judge (the field just goes unread by a
non-agent dispatcher).

Author `x:` on the producer step, not on individual judge entries. Every native
judge synthesized from that producer inherits the producer's complete parsed
`x:` map. Each judge receives an independent deep clone, so runner-side
mutation of the producer or one judge cannot alter a sibling judge. When the
producer omits `x:`, synthesized judges omit `x:` too. In particular, a
producer's `x.harness` policy governs both the producer order and every native
judge order. A judge entry's first-class `model:` remains authoritative over an
inherited `x.harness.model` value.

Each judge is a real step under the hood — it fires its own Worker order
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

A manual/branch skip re-arms only after its upstream inputs move. An exclusive
group skip has an additional inverse: if the green winner is rejected or
retracted, a sibling whose latest skip reason is `exclusive` immediately
returns to `owed`; a structurally skipped sibling does not. See
[`routing-groups.yaml`](../examples/workflows/routing-groups.yaml) for a
runnable example, and [`docs/design.md` §26](design.md) for the full design
(refusal timing, the judges interaction, and the model-checker parity
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
instead of inlining. The `calls:` step is machine-handled — it never emits a Worker
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
    calls: delivery          # bare local name; use <package>/<workflow> for a CAS target
    inputs:                  # child input → parent artifact (gate: sandbox green)
      proposal: proposal
    produces: [delivered]    # mirrors a green/value-defined output only after delivery is done
  - name: teardown
    consumes: [delivered]
    produces: [torn_down]
    terminal: true
    body: Tear down and green `torn_down`.
```

The engine spawns the child when the gate inputs are green and keeps the parent's
`calls:` output owed until the child's declared output is green/value-defined **and**
`workflowDone(childDef, childArts)` says the whole child is done. Only then does it
mirror that value into the parent (no Worker run). A child with cleanup or a manually
supplied input still outstanding keeps the parent output owed. If a gate input changes,
the engine re-provides it to the existing child — it never spawns a duplicate.

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
- **`[allGreen, idle]`** — both. The Step Agent reads `order.cause` (`'allGreen'` or
  `'idle'`) to branch.

```yaml
- name: completion
  on: [allGreen, idle]
  idleAfter: 30m           # fire if the workflow is stuck for 30 minutes
  generates: [outcome]
  body: |
    # order.cause is 'allGreen' when done, 'idle' when stuck past 30m
```

An `allGreen`/`idle` step must not also declare `consumes:` — both firing kinds
carry an empty input fingerprint, so a commit can never satisfy it, and
`owenloop lint` hard-errors on it. Declare the step's output under
`produces:`/`generates:` only.

**Alarms.** A Step Agent that needs a heartbeat or a deadline can call
`engine.setAlarm(workflow, step, at)` with an absolute timestamp — it overrides the
relative `idleAfter` window and survives a process restart.
`engine.nextAlarm(workflow)` tells an external scheduler when to wake the instance.

## `onCancel:` — cleanup that survives cancellation

`onCancel:` declares that a step is cleanup a control plane should dispatch when
it cancels a run. It is **not** an `on:` firing trigger: the standalone engine
has no run-cancellation state and never schedules it. A host that supports
cancellation reads this declaration separately.

The declaration names the inputs needed on the cancel path:

```yaml
- name: deprovisioner
  consumes: [merge, workspace]  # normal path
  onCancel:
    consumes: [workspace]       # cancel path
```

The subset is explicit because cancellation can leave a normal input permanently
non-green. In this example, `merge` is terminal and will not green after a
cancel, so the control plane must not guess whether to wait for it or omit it.

`onCancel:` must be a mapping with a required `consumes:` list; an empty list
is allowed. Each listed name must be one of the step's own plain consumes, and a
name may appear only once. Map (`[$i]`) and reduce (`[*]`) consumes are not
allowed because a cancellation firing is keyless and runs once. The key is not
valid on a `calls:` step. An `allGreen` or `idle` evaluator may carry
`onCancel:`, but because evaluators cannot consume inputs, its list must be
empty.

`terminal: true` and `onCancel:` are deliberately compatible. Whether running
a destructive step during cleanup is sensible is the workflow author's decision,
not an engine policy.

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

A reduce step needs at least one singleton produce (via `produces:` or `generates:`)
to discharge into — reducing into collection produces only leaves nothing for the
step to fire, and `owenloop lint` hard-errors on it.

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
verbatim onto every order that consumes them — anyone who can read the
database, or a downstream worker's resolved context, can read them.

Those values are also *retained*, not just transiently persisted: every
artifact version is kept (the store never overwrites a prior version in place),
and every run's issued order packet — the dynamic input values it consumed
and its accumulated rejection reasons — is written to the SQLite `run` table
at claim time and stays there after the run closes and the workflow finishes.
The step's authored prompt and command text are *not* in that packet: orders
are reference packets (design doc §29) and carry a `defDigest` pointing at
the definition snapshot instead, so instruction text is retained once, in the
definition, not duplicated per firing. A secret that flowed through an input
therefore lives on in the database until the file itself is disposed of — see
[Storage](../README.md#storage) for the operator's disposal responsibility.
