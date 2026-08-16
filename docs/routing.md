# Routing: how a step in a workflow reaches a model

This document explains the whole path from "a workflow definition says this
step needs a builder" to "a specific model, at a specific reasoning effort, on
a specific CLI, does the work."

It is written to be read once, start to finish, by someone who has never seen
the system. Every term is defined before it is used. Nothing is left implicit.

---

## 0. Status of this document

Sections 1 through 8 describe behavior that is live today.

Section 9 (**When nobody is certified**) describes a rule that is CHANGING.
Both the old rule and the new rule are stated, and it is marked which is which,
because a deployment running an older hub still does the old thing.

Section 10 (**Reroute rules**) describes a feature whose engine, hub and CLI
halves are now in place; the MCP surface is not. It is marked as such.

---

## 1. The four words

The single biggest source of confusion is the word **capability**. It sounds
like a property of a machine — "this box can run Opus." It is not that at all.

Use this mapping instead. It is exact, not a loose analogy.

| Term | Think of it as | Who writes it | Where it lives |
|---|---|---|---|
| **capability** | a **job posting** | the workflow author | the workflow definition file (`delivery.yaml`) |
| **modifier** | the **grade on the posting** | the person starting the run | chosen once at `start_run`, stored on the instance |
| **crew** | a **team certified for that posting** | the hub operator | the hub's `capability_routes` table |
| **shift** | a **team member clocking in** | whoever runs the machine | a local `settings.json` on that machine |

Read as one sentence:

> A **workflow definition** posts a job (`build`). The person starting the run
> stamps a grade on it (`deep`), making the posting `build:deep`. The **hub**
> looks up which **crews** are certified for `build:deep`. A **shift** — one
> member of a certified crew, currently clocked in — takes the job and decides,
> from its own local settings, which model and effort to run it on.

Four things follow from that sentence, and all four are places people get it
wrong:

1. **A capability never names a model.** `build` does not mean "Opus." It means
   "somebody who does building." The model is chosen at the very last step, by
   the shift, from its own settings file.
2. **A capability never names a machine.** Nothing in the definition or the hub
   knows what hardware or CLI exists.
3. **Certifying a crew is a promise about every member.** Binding `build:deep`
   to the crew `wise` says: *every shift that serves the wise crew can do deep
   build work.* If one member cannot, the binding is wrong.
4. **The mapping is many-to-many, both directions.** One capability can be
   bound to several crews. One crew can be bound to several capabilities. One
   shift can serve several crews (`owenloop shift start build wise` takes a
   list).

---

## 2. The three vocabularies, precisely

There are exactly three kinds of capability string, and they are different
things. Mixing them up is the second biggest source of confusion.

**Authored capability** — what a workflow step declares. Never contains a
colon.

```yaml
- name: builder
  capabilities: [build]      # <- authored capability
```

**Modifier** — one word, chosen once per run. The engine attaches *no meaning*
to it. `deep` is not "more" than `express` as far as any code is concerned;
they are just two different strings. A definition declares which ones it
accepts:

```yaml
modifiers: [express, standard, deep]
```

**Compound capability** — an authored capability with a modifier glued on by a
colon: `build:deep`. **Nobody writes this by hand in a workflow definition.**
It is composed by the engine at the moment an order is offered, by
`composeCapabilities(step.capabilities, modifier)` in `src/capabilities.ts`.

A run with no modifier composes to the bare authored capability. `build` stays
`build`. There is no default modifier — omitting `--modifier` does not mean
`standard`, it means *no modifier at all*.

---

## 3. Where each fact physically lives

Three files, three different owners, three different machines potentially.

### 3a. The workflow definition — "what job is this?"

A `.yaml` in a bundle, e.g. `owenloop-delivery/workflows/delivery.yaml`.

```yaml
modifiers: [express, standard, deep]

steps:
  - name: planner
    capabilities: [wise]
  - name: builder
    capabilities: [build]
  - name: provisioner
    capabilities: [utility]
```

This file names jobs. It names no models, no crews, no machines.

### 3b. The hub's `capability_routes` table — "who is certified?"

A table inside the hub, one row per `(capability string, crew)` pair. Written
with `owenloop capability bind <capability> <crew>`.

The staging hub's current rows:

| capability | crew |
|---|---|
| `build` | build |
| `build:standard` | build |
| `build:deep` | **wise** |
| `wise` | wise |
| `wise:standard` | wise |
| `utility` | utility |
| `utility:standard` | utility |

Note row 3. `build:deep` is certified to the **wise** crew, not the build crew.
That is deliberate and it is the whole point of the design: the build crew runs
on OpenAI models and the operator wants deep build work on an Anthropic model
instead. The *job* is still a build job. Only the *team* is different.

### 3c. The shift's `settings.json` — "what do I run it on?"

A file on the machine where the shift runs, e.g.
`~/.config/owenloop-shifts/wise/owenloop/settings.json`:

```json
{
  "hubOrigin": "https://api.stg.owenloop.com",
  "capabilityModels": {
    "wise:express":  { "model": "claude-opus-5",  "effort": "high"  },
    "wise:standard": { "model": "claude-opus-5",  "effort": "xhigh" },
    "wise:deep":     { "model": "claude-fable-5", "effort": "xhigh" },
    "wise":          { "model": "claude-opus-5",  "effort": "xhigh" },
    "build:deep":    { "model": "claude-opus-5",  "effort": "xhigh" }
  }
}
```

This is the **rate card**. It is the only place a model name appears anywhere in
the routing path. It is local to one machine and one operator, which is the
point — the person who owns the hardware and the API keys decides what runs
there.

---

## 4. The five things a shift is configured with

A shift is started with a command line. Five separate names appear in it, they
mean five different things, and they are routinely confused with each other.

```
env OWENLOOP_CONFIG_DIR=~/.config/owenloop-shifts/openai/owenloop \
    OWENLOOP_HARNESS=codex \
  owenloop shift start build \
    --origin https://api.stg.owenloop.com \
    --as shift-build \
    --name openai \
    --state-dir ~/.local/state/owenloop-shifts/openai
```

| Name | What it selects | In the example |
|---|---|---|
| **CONFIG_DIR** | which `settings.json` — i.e. which rate card | `.../openai/owenloop` |
| **crew** (positional) | which crew's jobs this shift serves | `build` |
| **`--as`** | which stored credential to authenticate with | `shift-build` |
| **`--name`** | a display label for this shift | `openai` |
| **`OWENLOOP_HARNESS`** | which CLI actually drives the model | `codex` |

**The harness is set only by the environment variable.** It is not in the
definition, not in the hub, not derived from the model name. `codex` drives the
OpenAI CLI; `claude-code` drives the Anthropic CLI. A machine that should run
both starts two shifts with different `OWENLOOP_HARNESS` values.

Note also what is *not* here: the shift does not tell the hub which
capabilities it has. It only names its crew. The hub derives the rest — see
next section.

---

## 5. What actually happens when an order is offered

Here is one order, end to end, in order.

**Step 1 — a human starts a run.**

```bash
owenloop start delivery --modifier deep \
  --provide proposal='{"text":"..."}' \
  --provide target='{"path":"/Users/alex/code/owenloop"}'
```

The hub creates an instance and stores `modifier = "deep"` on it. **This value
is set once and never changes for the life of the run.** There is no verb that
updates it.

**Step 2 — a shift asks for work.**

The wise shift calls the hub verb `whats_next`, authenticating as account
`shift-wise`.

**Step 3 — the hub works out what this caller can do.**

The hub does *not* read anything the shift sent about its abilities. Instead:

- it looks up which crews the account `shift-wise` belongs to;
- it reads every `capability_routes` row for those crews;
- the resulting list of capability strings is the caller's capability set.

The function is `listCapabilitiesForCrews(storage, memberCrewIds)`. For the
wise shift on staging that yields `['build:deep', 'wise', 'wise:standard']`.

This is why point 3 in section 1 matters: **eligibility comes entirely from
crew membership.** A shift cannot claim, declare, or negotiate a capability.

**Step 4 — the engine composes the posting.**

For the `builder` step, whose authored capability is `build`, and a run whose
modifier is `deep`:

```
composeCapabilities(['build'], 'deep')  ->  ['build:deep']
```

The order will be offered as `build:deep`.

**Step 5 — the hub decides how strictly to match.**

For each composed capability, the hub asks: *is any live crew certified for
this exact string?* "Live" means the `capability_routes` row exists **and** the
crew it names still exists — a row pointing at a deleted crew is dangling and
counts as nothing.

- `build:deep` has a live row (crew `wise`) → match mode **`exact`**. Only
  crews certified for the exact string `build:deep` may claim.
- If it had no live row → see section 9.

**Step 6 — the match.**

`claimMatches(offered, caller, modes)`. Offered is `['build:deep']`. The wise
shift's caller set contains `build:deep`. Under `exact` mode that is a match.
The order is handed to the wise shift, with `order.capabilities = ['build:deep']`.

The build shift, whose caller set is `['build', 'build:standard']`, does **not**
match — it is not certified for `build:deep`. That is the correct outcome, and
it is what stops a deep build job landing on the OpenAI shift.

**Step 7 — the shift picks the model.**

The wise shift reads `order.capabilities` — `['build:deep']` — and looks it up
in its own `capabilityModels`:

1. Try the **exact compound**: `build:deep` → `{model: claude-opus-5, effort: xhigh}`. Found.
2. If not found, try the **bare name part**: `build`.
3. If neither is found, the shift **refuses the order** with
   `unresolvable-capability` and the hub re-offers it.

That third case is a real, deliberate refusal, not a crash. A shift that has no
rate for a job does not guess a model.

**Step 8 — the harness runs it.**

`OWENLOOP_HARNESS=claude-code` for the wise shift, so the Anthropic CLI is
spawned with model `claude-opus-5` and effort `xhigh`.

Valid efforts, in order: `low`, `medium`, `high`, `xhigh`, `max`.

---

## 6. Why the model is chosen last, not first

A reasonable person asks: why not just write the model in the workflow
definition?

Because the definition is shared and the hardware is not. The same
`delivery.yaml` runs on a laptop with one API key, a CI box with another, and
someone else's fork entirely. A model name in the definition would be a promise
the author cannot keep.

So the definition says what *kind* of worker it needs. The hub says which
*teams* are certified. The machine owner says what those teams *run on*. Each
layer states only what it actually knows.

---

## 7. Two shifts, one crew — and when that is wrong

Because a crew is a team, you can put a codex shift and a claude-code shift in
the same crew. Both become eligible for that crew's jobs. Each reads its own
`settings.json`, so they can run entirely different models.

**This works, with one consequence you must accept: which member gets the order
is a race.** First claim wins. The hub does not choose between eligible
members.

That is fine for a job where you genuinely do not care — a generic `coder`
posting where either model is acceptable.

It is exactly wrong for `build:deep`, where the entire point was "this specific
one must be Opus." If you want a guarantee about *which model*, you need a crew
whose members all run that model, and you certify that crew for the compound.

One more failure mode: a step can declare a permission policy an adapter cannot
enforce (see `x.harness` in a step definition). A member on the wrong harness
releases the order with `incompatible-harness-policy`, and the hub re-offers it.
So a mixed crew can also produce a claim-then-release loop if the step's policy
is adapter-specific.

---

## 8. Escalation — the per-step, temporary grade change

A step can declare an escalation:

```yaml
  - name: builder
    capabilities: [build]
    escalation:
      after: 3
      modifier: deep
```

Read: *after this step's owed artifact has been judgment-rejected 3 times,
re-offer this step composed with `deep` instead of the run's own modifier.*

Four properties, all easy to get wrong:

1. **It is the engine's transition, not the worker's.** No agent reads this
   block. A worker cannot opt in or out.
2. **It is per step and per run.** The `builder` escalating does not change
   what `planner` or `reviewer` are offered as.
3. **It never rewrites the run's stored modifier.** The instance still says
   `modifier = "standard"`. Only that one step's offer moved.
4. **It is a no-op on a run that is already at the target grade.** A `deep` run
   whose builder escalates to `deep` just keeps re-offering `build:deep`.

The order carries a marker, `order.escalated = true`, so a reader can tell an
escalated re-offer from an ordinary one.

**A planner cannot upgrade the run's grade.** That feature does not exist. The
modifier is set at `start_run` and there is no code path that updates it. A
planner that thinks the human picked the wrong depth says so in its plan
document; it does not reroute itself.

---

## 9. When nobody is certified — the rule that is changing

This is the single line that has caused more confusion than everything else in
this document combined. It is worth reading twice.

**The situation:** a run is started with `--modifier express`. The `builder`
step composes to `build:express`. The hub looks in `capability_routes` and
finds **no live crew certified for `build:express`.**

### 9a. The OLD rule (what a current hub does)

The hub falls back to **name matching**: it offers the job to any crew
certified for anything whose name part is `build` — so the crew certified for
plain `build` claims it.

Why that is bad: the claiming shift receives `order.capabilities =
['build:express']`, finds no `build:express` row in its `capabilityModels`,
falls back to its bare `build` row, and runs on that model. The run believes it
got express service. It actually got whatever the generic build row happens to
be. Nothing failed, nothing was logged loudly, and the operator has no signal.

It converts the fact *"no shift is serving express right now"* into the
different fact *"the operator accepted a different grade of service."* Those
are not the same thing and the system had no business equating them.

### 9b. The NEW rule (what is being built)

**An unbound compound holds.** The hub keeps the mode at `exact`, so the order
simply waits until a crew certified for `build:express` clocks in. It does not
degrade to a generic worker.

**And the operator is told.** The hub writes a routing alert (kind
`binding-gap`) naming the capability that has no certified crew.

**Holding is not failure.** A held order is not dead. It is waiting. The
existing stall-notification system covers the case where a run sits too long,
and a crew that was restarted picks the work up when it comes back. There is no
built-in timer that silently downgrades the job.

The old behavior had a 15-minute escalation-fallback window baked in. That is
being removed. If an operator wants a timed fallback, they configure it; the
system does not assume it.

---

## 10. Reroute rules — saying "yes, substitute" on purpose

*(The engine half is in `owenloop`, the hub half is in `owenloop-service`, and
the CLI surface is `owenloop routing rule` — see
[Routing](cli.md#routing) in the CLI reference. The MCP surface follows.)*

Holding is the right default, but sometimes the operator genuinely does want a
substitution — "if nobody is serving `build:express` right now, `build:standard`
is fine." Section 9's rule makes that a decision the operator states, instead of
something the hub assumes.

A **reroute rule** is exactly that statement:

```
build:express  ->  build:standard
```

How it works, mechanically:

1. The hub composes the offer as usual and finds `build:express` has no live
   binding.
2. The hub consults the operator's reroute rules and finds a target,
   `build:standard`, that *does* have a live binding.
3. The hub hands the engine a **rewrite**: `{ 'build:express': 'build:standard' }`.
4. The engine **substitutes the string**. The order goes out as
   `build:standard`, and carries `reroutedFrom: ['build:express']`.
5. The hub writes a routing alert (kind `reroute`) recording that it happened.

**Why substitute the string rather than just loosen the match?** Because the
claiming shift resolves its model from `order.capabilities`. If the hub merely
widened the match, the shift would receive `build:express`, find no row for it,
and fall back to its bare `build` row — the wrong model, which is the exact bug
section 9a describes. Substituting means the shift receives `build:standard` and
resolves *standard's* model, which is what the operator asked for.

**Why two fields on the order?** A rerouted order has two simultaneously true
answers to "which capability is this?"

- `capabilities` — the capability **being served**. This is what the shift
  resolves its model against.
- `reroutedFrom` — the capability the definition **asked for**.

`reroutedFrom` is absent on every ordinary offer, so its presence alone tells a
reader the order is not running on what its definition requested. A single field
could only ever carry one of the two facts, and an operator asking "why did this
run on Opus?" would have no way back to "because we asked for express."

**The run's stored modifier is never touched by a reroute.** Re-reading the run
record still shows the grade of service that was requested. Only the offer
moved.

**Chains are resolved by the hub, not the engine.** If `a -> b` and `b -> c`,
the hub walks the chain and hands the engine the final answer. The engine
performs exactly one substitution and never looks a target up again, so a cycle
is impossible there rather than merely bounded.

### How an operator states and inspects all of this

The rules and the alerts are two separate command surfaces on one hub org — see
[Routing](cli.md#routing) in the CLI reference for flags, output shape and exit
codes.

| what you want | command |
|---|---|
| write the rule `build:express -> build:standard` | `owenloop routing rule add build:express build:standard` |
| put a rule ahead of the ones already there | `owenloop routing rule add build:express build --position 0` |
| see the rules in the order the hub tries them | `owenloop routing rule list` |
| take one rule back | `owenloop routing rule rm build:express build:standard` |
| see every hold, reroute, wait and fallback org-wide | `owenloop routing alerts` |
| see one run's routing timeline | `owenloop routing show <workflow>` |

**Three cautions the command names do not carry on their own.**

1. **A reroute rule is not a binding.** `routing rule add` writes a
   `capability_reroutes` row, which names no crew and grants nobody access.
   `capability bind` writes a `capability_routes` row, which does. A reroute
   only reaches a crew if its **target** capability has a live binding of its
   own, so adding a rule cannot by itself widen who may claim work.
2. **`routing rule list` order is meaning, not presentation.** Rows are grouped
   by source capability and ordered by ascending `position` — the first row for
   a capability is the first target the hub attempts.
3. **Removing the last rule for a capability restores holding.** With no rule
   left, an unbound compound waits again, exactly as section 9b describes. The
   CLI prints `remainingTargets: []` and says so on stderr.

---

## 11. The mistakes we keep making

Each of these has actually happened. Each has a one-line correction.

| Mistake | Correction |
|---|---|
| "The capability says which model to use." | It says which *job*. The model comes from the shift's local `settings.json`, at the very last step. |
| "`build:deep` belongs to the wise crew." | No — `build:deep` is *certified to* the wise crew. Certify a second crew for it and both are eligible. Nothing owns it. |
| "A shift declares its capabilities." | It declares its **crew**. The hub derives capabilities from crew membership via `listCapabilitiesForCrews`. |
| "The OpenAI shift has no `build:deep`, so serve it something else." | Do not serve it at all. Certify the crew that *can* do it. That is what the binding is for. |
| "`--modifier` defaults to standard." | Omitting it means **no modifier**. Steps are offered on bare authored capabilities. |
| "A modifier means 'more effort'." | To the engine it is an opaque string. All meaning lives in the shift's `capabilityModels` map. |
| "A planner can decide the run needs to go deeper." | It can *say so*. It cannot change the run's modifier — no code path does. |
| "Escalation upgrades the run." | It re-offers **one step**, temporarily. The run's stored modifier is untouched. |
| "If nobody serves the compound, close enough is fine." | Not any more. It holds and alerts. Substitution is something the operator configures on purpose (section 10). |
| "Two harnesses in one crew gives me control over which model runs." | It gives you *either* model. First claim wins. Use separate crews when you need a guarantee. |

---

## 12. One-screen summary

```
delivery.yaml          steps: [{ name: builder, capabilities: [build] }]
                            |
   owenloop start --modifier deep     (stored once, never changes)
                            |
   engine composes          build  +  deep  ->  "build:deep"
                            |
   hub reads capability_routes:   build:deep -> crew "wise"
                            |
   hub derives caller set from the asking shift's crew memberships
                            |
   match: exact  ->  only crews certified for "build:deep" may claim
                            |
   the wise shift claims; order.capabilities = ["build:deep"]
                            |
   shift reads its own settings.json capabilityModels:
       "build:deep": { model: claude-opus-5, effort: xhigh }
                            |
   OWENLOOP_HARNESS=claude-code spawns that model at that effort
```

If the lookup at step 3 finds nobody: the order **holds** and an alert is
written. If the operator has configured a reroute rule, the hub substitutes the
target capability and records `reroutedFrom` on the order.
