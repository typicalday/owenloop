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
| **modifier** | the **grade on the posting** | the starter at `start_run`, then the engine through a declared artifact bind | the run instance; an optional bound artifact is the writer |
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
   to the crew `openai` says: *every shift that serves the openai crew can do
   deep build work.* If one member cannot, the binding is wrong.
4. **The mapping is many-to-many, both directions.** One capability can be
   bound to several crews. One crew can be bound to several capabilities. One
   shift can serve several crews (`owenloop shift start anthropic openai`
   takes a list). On the staging hub every shift serves exactly one crew, so
   this shows the shape of the argument rather than a shift that exists today.

The final model choice is a separate **roster** cascade. A shift refreshes the
hub organization rosters into its local disk cache, then the spawned
`agent-run` child reads that cache offline. For a named crew the strongest-first
layers are machine `crews/<crew>.json`, machine `settings.json`, cached hub
crew roster, and cached hub org-global roster. The cached hub layers are
deliberately weakest; an unavailable cache is visible in `owenloop roster show`
but never makes a shift or order fail when a machine row can route it.

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
  - name: reviewer
    capabilities: [review]
  - name: provisioner
    capabilities: [utility]
```

This file names jobs. It names no models, no crews, no machines.

### 3b. The hub's `capability_routes` table — "who is certified?"

A table inside the hub, one row per `(capability string, crew)` pair. Written
with `owenloop capability bind <capability> <crew>`.

The staging hub's current rows are exactly these sixteen:

| capability | crew |
|---|---|
| `wise` | `anthropic` |
| `wise:express` | `anthropic` |
| `wise:standard` | `anthropic` |
| `wise:deep` | `anthropic` |
| `build` | `openai` |
| `build:express` | `openai` |
| `build:standard` | `openai` |
| `build:deep` | `openai` |
| `review` | `openai` |
| `review:express` | `openai` |
| `review:standard` | `openai` |
| `review:deep` | `openai` |
| `utility` | `openai` |
| `utility:express` | `openai` |
| `utility:standard` | `openai` |
| `utility:deep` | `openai` |

The live table gives the `anthropic` crew one job family and its modifiers:
the four `wise` strings. It gives the `openai` crew three job families and
their modifiers: `build`, `review`, and `utility`. A crew name says which
team; a capability says which job. Nothing in `anthropic` or `openai` tells
you what job it does, and that is correct — the crew name is not supposed to.

A capability can still be certified to a crew whose name has nothing to do with
the job. If an operator wanted deep build work on Anthropic models, the
operator would run:

```bash
owenloop capability bind build:deep anthropic
owenloop capability unbind build:deep openai
```

The *job* is still a build job. Only the *team* changes.

These are two commands, not one. `capability bind` on an already-bound
capability **adds** a crew; it never replaces one. With only the bind,
`build:deep` would be certified to both `openai` and `anthropic`, and
which crew's shift claims a given order would be a race. The unbind is what
makes it a move. This is verified by `src/cli.ts:5079` and independently by
`docs/authoring.md:254`.

That hypothetical move also needs a rate-card change. The shift first looks
for an exact `build:deep` row and then may fall back to a bare `build` row.
The `anthropic` card shown here has neither row, so after the rebind it would
refuse the order with `unresolvable-capability`, and the hub would re-offer it.
If the card had a bare `build` row, the shift would run that row's potentially
different model and effort instead. The operator must add an intentional
`build:deep` row to the `anthropic` card as part of the same move.

### 3c. The crew roster — “what can this machine run?”
A machine's global fallback lives under the `roster` key in
`~/.owenloop/settings.json`; a named crew's stronger layer is
`~/.owenloop/crews/<crew>.json`. Both files use the same top-level shape:

```json
{
  "roster": {
    "wise:deep": [
      { "harness": "claude-code", "model": "claude-fable-5", "effort": "xhigh" },
      { "harness": "codex", "model": "gpt-5.6-sol", "effort": "xhigh" }
    ],
    "wise": [
      { "harness": "claude-code", "model": "claude-opus-5", "effort": "high" }
    ]
  }
}
```

Every value is a non-empty ordered candidate array. The stronger crew layer
replaces a capability's full array from the machine-global layer; arrays are
never combined. Exact composed capability lookup runs before bare-name lookup
across all offered capabilities. The first candidate whose harness is
registered wins, unless a step's `x.harness.id` requires a different harness.
That mismatch is an `incompatible-harness-policy` release; no registered
candidate is `unresolvable-capability`.

### 4. The four things a shift is configured with

A shift start command names its crews, credentials, display identity, and
state directory. It no longer carries an operator-selected harness or a
per-shift config directory. Its crews are the worker → hub
`serve_crews` narrowing advertisement. It also sends a derived
`serve_capabilities` advertisement: the sorted raw keys from its effective
merged rosters, with bare names and exact compounds mixed. `[]` means
"clocked in, serving nothing." This can only narrow offers; it never grants
authority, and the shift passes NO crews to agent children. **Today's hub
ignores `serve_capabilities`; the hub-side intersect ships separately.** For a
capability-bearing order, the hub stamps its matched crews on the order and the
agent resolves those rosters in the stamped order.

| Name | What it selects |
|---|---|
| **crew** (positional) | worker → hub `serve_crews` offer scope; the hub-stamped `order.crews` resolves the agent worker's roster sequence |
| **`--as`** | which stored credential to authenticate with |
| **`--name`** | a display label for this shift |
| **`--state-dir`** | local socket and child-state storage |

Use `owenloop roster show [crew]` to see each selected candidate and the
layer that supplied it. `owenloop doctor` reports the same layers and whether
their candidate harnesses are registered.

## 5. What actually happens when an order is offered

Here is one order, end to end, in order.

**Step 1 — a human starts a run.**

```bash
owenloop start delivery --modifier deep \
  --provide proposal='{"text":"..."}' \
  --provide target='{"path":"/Users/alex/code/owenloop"}'
```

The hub creates an instance and stores `modifier = "deep"` on it as the run's
initial hint. A def may later declare one artifact with `bind: modifier`; when
that artifact is accepted, the engine synchronizes the instance's modifier in
the same acceptance transaction. There is still no general-purpose verb that
lets a worker write the column.

**Step 2 — a shift asks for work.**

The `openai-1` shift calls the hub verb `whats_next`, authenticating as
account `shift-openai-1`. Alongside its `serve_crews` scope it sends
`serve_capabilities`: raw keys from the merged roster cascade. A bare key is
not expanded locally, because the shift does not know the modifier vocabulary.

**Step 3 — the hub works out what this caller is authorized to do today.**

Today's hub still ignores the shift's `serve_capabilities` field. The
hub-side intersect-before-match is a separately shipped follow-up. Instead,
the current hub:

- it looks up which crews the account `shift-openai-1` belongs to;
- it reads every `capability_routes` row for those crews;
- the resulting list of capability strings is the caller's capability set.

The function is `listCapabilitiesForCrews(storage, memberCrewIds)`. For the
`openai-1` shift on staging that yields this set:

```
['build', 'build:deep', 'build:express', 'build:standard',
 'review', 'review:deep', 'review:express', 'review:standard',
 'utility', 'utility:deep', 'utility:express', 'utility:standard']
```

The strings are shown alphabetically for readability; their order is not
significant.

This is why point 3 in section 1 matters: **authority comes entirely from crew
membership.** A shift can advertise a local offer filter, but cannot claim,
declare, or negotiate authority for a capability.

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

- `build:deep` has a live row (crew `openai`) → match mode **`exact`**. Only
  crews certified for the exact string `build:deep` may claim.
- If it had no live row → see section 9.

**Step 6 — the match.**

`claimMatches(offered, caller, modes)`. Offered is `['build:deep']`. The
`openai-1` shift's caller set contains `build:deep`. Under `exact` mode
that is a match. The order is handed to `openai-1`, with
`order.capabilities = ['build:deep']`.

The `anthropic` shift, whose caller set is
`['wise', 'wise:deep', 'wise:express', 'wise:standard']`, does **not** match
— it is not certified for `build:deep`. That is the correct outcome, and it
is what stops a deep build job landing on the Anthropic shift. The two caller
sets do not overlap at all, which is exactly what it looks like when
eligibility comes entirely from crew membership and the crews are named after
teams.

**Step 7 — the worker picks the model.**

The agent reads `order.capabilities` — `['build:deep']` — plus the hub →
worker `order.crews` stamp, and resolves those merged crew rosters in order:

1. Try the **exact compound**: `build:deep` → an ordered candidate array. Found.
2. If not found, try the **bare name part**: `build`.
3. If neither is found, the worker **refuses the order** with
   `unresolvable-capability` and the hub re-offers it.

An absent, empty, malformed, or unreadable crew stamp is also refused and
released; there is no fallback to the crews the shift was started with. These
are real, deliberate refusals, not crashes. A worker that has no rate for a job
does not guess a model.

**Step 8 — the harness runs it.**

the selected roster candidate for the openai shifts, so the Codex CLI is spawned
with model `gpt-5.6-terra` and effort `xhigh`.

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

The `openai` crew has exactly two staging shifts: `openai-1` and `openai-2`.
Both run codex and carry the same rate card. Because a crew is a team, both
become eligible for that crew's jobs.

**This works, with one consequence you must accept: which member gets the order
is a race.** First claim wins. The hub does not choose between eligible
members.

That is fine for a job where you genuinely do not care which member claims it
— a generic `coder` posting where either shift is acceptable.

For this staging pair, the two `openai` shifts must carry byte-identical rate
cards. Crew membership is what makes a shift eligible, and both members are
eligible for every capability the crew is certified for. If `openai-2` were
missing a row that `openai-1` has, the hub would eventually hand `openai-2` an
order it cannot price; `openai-2` would refuse with
`unresolvable-capability`; the hub would re-offer the order. That is the
claim-refuse-reoffer loop, and nothing about it is visible from the hub side —
the routing table is identical in both cases. This is why section 3c says both
openai cards are byte-identical.

This is a property of these two shifts sharing the `codex` adapter, not a
universal rule for every pair of shifts serving one crew. Shifts on different
adapters may use different model ids and separate settings directories; the
invariant is that every eligible shift must be able to resolve every capability
the crew is certified for.

It is exactly wrong for `wise:deep`, where the entire point is "this specific
one must be claude-fable-5." `wise:deep` is certified to `anthropic`, and
the anthropic card serves it with `claude-fable-5`, a different model from
every other `wise` row. If you want a guarantee about *which model*, you need
a crew whose members all run that model, and you certify that crew for the
compound.

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

Escalation still does not rewrite the run's stored modifier. A separate,
def-declared `bind: modifier` is the engine's only post-start writer: it turns
an accepted artifact into the next routing value. A planner can reject that
artifact with `--requested <modifier>` (or the equivalent rejection path); the
producer can then re-emit the requested value, and downstream work is offered
with the synchronized modifier.

The binding is ordinary dataflow, not a hidden reroute. Only steps downstream
of the bound artifact are guaranteed to wait for its synchronized value. Claims
already in flight finish under the modifier stamped on their orders; later
offers compose from the new instance value. The artifact's version and reason
history records the rejected value, feedback, and replacement, while the order
records the modifier actually used for each firing.

For a command producer, remember that the accepted artifact value is the whole
`CommandReceipt`. If the command emits a payload marker such as
`##owenloop:payload## {"value":"deep"}`, use
`bind: {to: modifier, from: payload.value}`; a bare `from: value` would look for
a top-level field on the receipt.

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
['build:express']`, finds no `build:express` row in its `roster`,
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
| "Name the crew after the job it performs — call the crew that builds `build`." | A crew is named after the **team**, never after the job. When `build` is both a capability and a crew name the two lookups become invisible, and the reader cannot tell the hub-side routing table (`capability_routes`) from the shift-side rate card (`roster`). Name crews `anthropic` and `openai`. |
| "The capability says which model to use." | It says which *job*. The model comes from the shift's local `settings.json`, at the very last step. |
| "`build:deep` belongs to the openai crew." | No — `build:deep` is *certified to* the `openai` crew. Certify a second crew for it and both are eligible. Nothing owns it. |
| "A shift declares its capabilities." | A shift now advertises raw merged-roster keys as an offer filter, but that never grants authority. Authority remains crew-derived, and the worker's refusal backstop is unchanged. Today's hub ignores the field; the intersect ships separately. |
| "The shift's positional crews decide an agent worker's roster." | No. They only advertise worker → hub `serve_crews`; the hub-stamped `order.crews` list resolves each capability-bearing order's roster sequence. |
| "The shift that is clocked in has no rate for `build:deep`, so serve it something else." | Do not serve it at all. Certify the crew that *can* do it. That is what the binding is for. |
| "`--modifier` defaults to standard." | Omitting it means **no modifier**. Steps are offered on bare authored capabilities. |
| "A modifier means 'more effort'." | To the engine it is an opaque string. All meaning lives in the shift's `roster` map. |
| "A planner can decide the run needs to go deeper." | It rejects the bound modifier artifact with `requested: deep`; its producer re-emits the value and the engine synchronizes the run. |
| "Escalation upgrades the run." | It re-offers **one step**, temporarily. The run's stored modifier is untouched. |
| "If nobody serves the compound, close enough is fine." | Not any more. It holds and alerts. Substitution is something the operator configures on purpose (section 10). |
| "Two harnesses in one crew gives me control over which model runs." | It gives you *either* model. First claim wins. Use separate crews when you need a guarantee. |

---

## 12. One-screen summary

```
delivery.yaml          steps: [{ name: builder, capabilities: [build] }]
                            |
   owenloop start --modifier standard (initial hint; a bind may later change it)
                            |
   bound artifact accepted -> engine syncs the run modifier (audited in its history)
                            |
   engine composes          build  +  deep  ->  "build:deep"
                            |
   hub reads capability_routes:   build:deep -> crew "openai"
                            |
   hub derives caller set from the asking shift's crew memberships
   shift sends serve_crews plus raw merged-roster serve_capabilities
   (today's hub ignores serve_capabilities; the intersect ships separately)
                            |
   match: exact  ->  only crews certified for "build:deep" may claim
                            |
   the openai-1 shift claims; order.capabilities = ["build:deep"]
   order.crews = ["openai"]
                            |
   agent resolves the stamped crew roster:
       "build:deep": [{ harness: codex, model: gpt-5.6-terra, effort: xhigh }]
                            |
   the selected candidate spawns that model at that effort
```

If the lookup at step 3 finds nobody: the order **holds** and an alert is
written. If the operator has configured a reroute rule, the hub substitutes the
target capability and records `reroutedFrom` on the order.
