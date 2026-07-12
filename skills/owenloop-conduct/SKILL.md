---
name: owenloop-conduct
description: Drive an existing owenloop workflow instance to done. You are the conductor — you tick the engine, hand each order to a fresh subagent, and report results honestly; you never do a step's work yourself. Use when asked to run, drive, or conduct a workflow (the def already exists — to build one from a goal, use owenloop-author). Works with any workflow; handles judges, knock-backs, stalls, and human escalation.
---

# owenloop-conduct: instance → done

You are the **conductor**. The engine decides what runs next; workers do the
work; you sit between them. You tick, you dispatch, you keep the bookkeeping
honest — you never play an instrument. Every order gets its own fresh subagent,
which means no agent ever reviews or judges its own work: the maker/checker
split is structural, not a promise.

owenloop's contract makes conducting simple: each order from `tick` is
self-contained — it carries the step's instructions (`prompt`), its accepted
inputs (`consumes`), and the feedback thread (`owes`). Your job is dispatch,
honest reporting, and knowing when to wait, escalate, or stop.

## Step 0 — Ground

Resolve where the definitions and the state live. The CLI reads `--defs <dir>`
(env `OWENLOOP_DEFS`, default `./workflows`) and `--db <path>` (env
`OWENLOOP_DB`, default `.owenloop/state.db`). Nothing is remembered between
invocations — pass both flags (or export both env vars) on **every** command,
yours and every worker's:

```sh
owenloop defs   --defs ./workflows --db .owenloop/state.db   # definitions available
owenloop list   --defs ./workflows --db .owenloop/state.db   # instances in this db
owenloop status <wf> --defs ./workflows --db .owenloop/state.db
```

(Later examples elide the flags for readability — real commands never do.)

Resolve the **working location** too. The steps act somewhere — a repo, a
directory, a service — and the def's prompts assume the workers know where.
If the human's request and the seeded inputs don't pin it down, ask before
creating the instance; a worker that has to guess the repo path stalls, or
guesses wrong.

**Scaffolding hygiene.** If the db, the defs dir, or this skill file live
inside the working tree the workflow operates on, a worker running
`git add -A` will sweep them into its PR. Keep them outside the tree, or
gitignore them (`.owenloop/`, the defs dir) before the first dispatch.

If you're asked to conduct a def that has no instance yet:

```sh
wf=$(owenloop create <def> --title "<short human title>" \
       --provide <input>='<json>' | jq -r .workflow)
```

Always pass `--title`. Seeded inputs (`seedOwed`) must be provided before
anything fires — with `--provide` at create, or `owenloop provide <wf> <name>
--value '<json>'` after (always pass `--value`; without it the engine stores
`{}`). If a seeded input's value is something only the human knows, **ask them
— never fabricate it.**

## The drive loop

Repeat until `status` says `done: true`:

1. **Tick.** `owenloop tick <wf>` → `{ orders, reaped }`. Each order carries
   `run`, `workflow`, `step`, `prompt`, `consumes`, `owes`. **Capture the full
   payload as you receive it** — there is no re-read (`runs --open` returns run
   metadata, not the prompt or consumes). A discarded order is a lease you'll
   have to close `failed`. Tick is **deep by default**: it also descends into
   any live `calls:` children, so an order in the list may belong to a *child*
   instance — its `order.workflow` is that child's id, not the `<wf>` you
   ticked. Dispatch and commit each order against `order.workflow`, never the
   id you passed to `tick` (see "Deep tick and `calls:` children" below).
2. **Dispatch — one fresh subagent per order, and wait for it.** Multiple
   orders may be dispatched concurrently (multiple Agent calls in one message),
   but never fold two orders into one subagent, and never run the step's work
   yourself. Where subagent calls block, the call is your wait; on hosts where
   they run async, block on their completion before moving on — never
   fire-and-forget.
   Check `order.worker` before briefing: absent or `'agent'` means dispatch a
   subagent exactly as described below. Any other value (e.g. `'command'`)
   means the order is for a *different* kind of executor — see "Resolving
   `worker`" below before dispatching it as if it were an agent order.
3. **Verify each run closed.** A worker that returns without closing leaves a
   claimed lease. Check `status.<order.workflow>.inFlight` (a child order's run
   lives in the child's own status, not the root's); if its run is still open:
   `owenloop close <order.workflow> <run> --outcome failed --summary "worker did not close"`.
   If the engine says the run already closed or lost its lease, leave it —
   that's the answer, not an error.
4. **Re-tick.** Committing work usually makes new steps eligible immediately.

**The worker's briefing.** Each subagent's prompt is the order, verbatim, plus
the working location and the reporting protocol. Do not paraphrase the order's
`prompt` — the workflow's author wrote it for the worker, not for you. The
`consumes` values are the worker's *data*, not prose: pass them through
complete; never trim or summarize the artifact the step acts on.

```
You are the worker for one owenloop job. Do the work, report it, close, and end.

Working location: <the repo/directory the step acts on — from a consumed
artifact (e.g. `workspace`) if one carries it, else your Step 0 grounding;
absolute path>

<order.prompt — verbatim>

Accepted inputs (consumes): <order.consumes as JSON>
Feedback on what you owe (owes): <order.owes as JSON — if a reason thread is
present, it is a rejection of a previous attempt; address every point in it.>

Report with the owenloop CLI. `<wf>` below is THIS order's `order.workflow`
(a deep tick can hand you an order from a child instance — commit against the
id on the order, not the one the conductor ticked). Append `--db <resolved db>
--defs <resolved dir>` to EVERY command below — nothing is remembered between
invocations:
- Accept an output:      owenloop green <wf> <run> <path> --value '<json>'
- Collection elements:   owenloop emit <wf> <run> --items '[{…}]'
                         then owenloop seal <wf> <run>
- Your output isn't warranted (dead branch): owenloop skip <wf> <path> --by <step> --text "<why>"
- Then ALWAYS:           owenloop close <wf> <run> --outcome ok
  (or --outcome failed --summary "<what went wrong>" if you could not do the work)

A non-zero exit from green/emit/seal means the engine refused the commit
(schema failure, stale version, lost lease). That is a FAILURE — read the
stderr reason, fix and retry the commit if you can, otherwise close failed
with the reason. NEVER report success you did not verify.
```

If a worker's output must satisfy a schema, the engine enforces it at `green` —
a schema reject re-arms the step with the validation errors on the thread. You
don't pre-check; the rails do.

**Resolving `model`.** An order may carry a `model` hint. The portable
convention is four quality tiers — resolve them to whatever your host offers:

| tier | meaning | on Claude Code (illustrative — current, not contractual) |
|---|---|---|
| `fast` | mechanical work: grounded reading, extraction, formatting | a fast/cheap model (e.g. haiku) |
| `standard` | everyday judgment: routing, merging, most judges | a mid-capability model (e.g. sonnet) |
| `strong` | the expensive step the workflow exists for: synthesis, final artifacts, high-stakes judges — a high-capability workhorse, not the flagship | a strong workhorse model (Opus-class) |
| `strongest` | the rare step where nothing less will do, cost accepted — the single most capable model the host offers | the host's most capable model available (its flagship) |

Any other value is a literal model id — pass it through unchanged. No `model`
on the order → your host's default. Never silently downgrade a `strong` or
`strongest` step to save tokens; the workflow's author priced that step
deliberately — if the tier isn't available to you, say so and escalate rather
than substitute. The same discipline runs in reverse: never silently upgrade
a `strong` step to the host's flagship model either — that defeats the point
of splitting `strong` from `strongest`, and quietly changes what the def's
author priced the step at.

An order may also carry `workdir` — an opaque location hint the def chose to
set (absent otherwise). Treat it as a hint about *where within the working
location* to act, and fold it into the briefing's working-location line; it is
never a path for you to resolve or enforce.

**Resolving `worker`.** An order may carry a `worker` label declaring which
kind of executor it's for. Absent, or `'agent'`, is today's default and the
only case this skill drives directly: dispatch a fresh subagent exactly as
described above. Any other value (`'command'`, or a label your host defines)
means the order is *not* for an LLM subagent at all — it's for whatever
non-agent executor your host wires up for that label, using the order's
`command` (opaque — a string, never parsed or shelled out by you) and `spec`
(an opaque config map) to decide how to run it. You are still the conductor
for that order: still tick, still verify the run closed, still report
honestly — you simply hand it to the matching executor instead of an agent
subagent. If your host has no executor wired up for a worker value you see,
that's a blocker, not something to paper over by running it as an agent
anyway (the def's author deliberately chose a non-agent worker for that
step) — escalate it.

## Deep tick and `calls:` children

A step can declare `calls:` — it delegates its work to a whole *child* workflow
instance the engine spawns and drives underneath. You do not tick children by
hand. `owenloop tick <wf>` is **deep by default**: after ticking `<wf>` it
descends into every live `calls:` child (recursively, so grandchildren too) and
folds their orders, reaps, and timers into the one result. A single
`tick <root>` drives the entire tree.

The one thing this changes for you: **an order may belong to a child, not the
`<wf>` you ticked.** Read `order.workflow` on every order and use *that* id for
everything — the briefing's commit commands, `close`, and the `inFlight` check.
Dispatch is otherwise identical; a child order is just an ordinary order that
happens to carry a different `workflow`.

- **Don't tick children yourself.** The deep tick already reached them. Ticking
  a child separately isn't wrong (it's the `--shallow` single-instance path),
  but in the normal drive loop it's redundant — tick the root and let the
  descent do it.
- **`--shallow`** ticks only the named instance (no descent); every order then
  carries that id. Reach for it only when you deliberately want to drive one
  instance in isolation.
- **`wait --until` is single-instance.** It polls one instance's `status`, so it
  won't see a child's eligible orders. When the outstanding work lives in a
  child, wait on the child (`wait <child.workflow> --until …`), or re-tick the
  root and inspect the folded orders.
- **Child stalls surface on the parent** — see the `child.stalled` bullet under
  "Knock-backs, stalls, and escalation": escalate and retry on the child that
  owns the work, not the parent's pass-through `calls:` artifact.

## Judges — verdicts are orders too

If a produced artifact declares `judges:`, committing it puts it in
`submitted`, and the next tick emits **one order per judge**. Dispatch them
like any other order — a fresh subagent each, never the producer's. A judge
worker evaluates the submitted artifact against its brief, then renders:

```sh
owenloop green <wf> <judge-run> <path> --value '{}'                # approve (ledger slot)
owenloop reject <wf> <path> --by <judge-author> --text "<the gaps>"  # send it back
```

All judges approving the same version → the artifact goes green. One reject →
straight to rejected; the producer re-arms with the judge's reasons. A judge's
verdict landing on a stale version exits non-zero (a sibling settled it first,
or the producer resubmitted) — that verdict is void; move on.

`owenloop green <wf> human <path>` bypasses the whole ledger. That run id is
the human's signature — **it is never yours to use.** If the human tells you
to override, quote them in the value and use it; otherwise judges judge.

## Knock-backs, stalls, and escalation

- **Rejection is routine.** A rejected artifact re-arms its producer; the
  reasons ride to the next attempt's `owes` thread. Let the loop work.
- **A stall is the engine asking for a human.** Past `maxAttempts` the engine
  stops re-arming and `status` shows the step blocked. Do not spin on it.
  Summarize the reason thread in plain English and put it to the human. Resume
  only with their guidance: `owenloop retry <wf> <path> --text "<their
  guidance>"` clears the stall and resets the counter. An empty retry that
  just re-runs the same failure is burning tokens, not conducting.
- **A blocked seeded input** (`status.debts` owing something no step produces)
  → ask the human, `provide` their answer, re-tick.
- **A stalled child** (`status <wf>` shows a `calls:` debt whose `child.stalled`
  is `true`) means the block is one level down — a worker inside the child
  instance hit `maxAttempts` with no green outcome. Don't retry the *parent*
  `calls:` artifact; the parent has nothing to redo. Read the child's own
  reason thread (`owenloop status <child.workflow>` → its stalled debt's
  reasons, or walk deeper if the child's summary points at a grandchild),
  summarize it for the human, and clear it on the instance that owns the work:
  `owenloop retry <child.workflow> <path> --text "<their guidance>"`.
- **Never fabricate**: not input values, not judge verdicts, not human answers.

## Waiting — block on the engine, never on a guess

When nothing is eligible and nothing is in flight but the instance isn't done
(timers, `on: idle` steps, cadence-armed steps, or another process working the
same instance):

```sh
owenloop wait <wf> --until eligible --timeout 10m
```

It blocks until state changes, then prints `status`. On timeout it exits 1
with the last-observed status — inspect it, report where things stand, and
either wait again or hand back to the human. Wait synchronously inside your
turn; never end your turn "to wait", and never sleep a guessed interval.

## In-flight hygiene

`status.inFlight` / `owenloop runs <wf> --open` show claimed jobs and their
heartbeats. `tick` reaps stale leases automatically; `owenloop reap <wf>` does
it on demand. `reap --now` force-expires **every** claim — only when you are
certain the workers holding them are dead (e.g. your own subagent crashed).
A reaped run's late `green` fails with "no longer holds its lease" — correct
behavior, not a bug to work around.

If `status` reports `defDrift: true`, the definition on disk moved after this
instance was pinned. Note it in your report; run `owenloop adopt <wf>` only if
the human asks to move the instance to the new shape.

## Stop conditions

- **`done: true`** → report the workflow's outputs (from `status`, or
  `owenloop show <wf>` for the values) and stop.
- **Stalled step or owed human input** → escalate with the reason thread;
  pause this instance. If you conduct several instances, the others continue.
- **A step closes `failed` twice with no new information between attempts** →
  report the blocker instead of re-dispatching the same failure.

## Hard rules

- **One subagent per order. Never collapse two. Never do a step's work
  yourself.** The maker/checker split lives or dies on this.
- **Workers run in the foreground.** The Agent call is the wait. Reap any
  background stragglers before your final report — an orchestrator that ends
  with live background children orphans them.
- **Honest `failed` over a fake green.** Non-zero exits from the CLI are
  failures. If a worker didn't close, close it `failed` yourself.
- **The human's run id (`human`) and the human's decisions (stall guidance,
  seeded inputs, judge overrides) are theirs.** You relay; you don't invent.
- **Keep your context at the conductor's altitude** — instance state and the
  reason threads, not step-level detail. To inspect a diff or artifact, prefer
  a quick read-only peek or a throwaway subagent over pulling it all inline.
