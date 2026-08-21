---
name: plan
description: Compile a novel multi-domain task into a checked, approval-gated ephemeral composite that delegates selected library playbooks. Use when no single catalog workflow covers the task and composition has real value.
allowed-tools: mcp__plugin_owenloop_owenloop__list_workflows, mcp__plugin_owenloop_owenloop__search_workflows, mcp__plugin_owenloop_owenloop__get_workflow, mcp__plugin_owenloop_owenloop__create_workflow, mcp__plugin_owenloop_owenloop__start_run, mcp__plugin_owenloop_owenloop__pending_gates, mcp__plugin_owenloop_owenloop__provide_input, mcp__plugin_owenloop_owenloop__get_status, mcp__plugin_owenloop_owenloop__delete_workflow, mcp__owenloop__list_workflows, mcp__owenloop__search_workflows, mcp__owenloop__get_workflow, mcp__owenloop__create_workflow, mcp__owenloop__start_run, mcp__owenloop__pending_gates, mcp__owenloop__provide_input, mcp__owenloop__get_status, mcp__owenloop__delete_workflow, Write, Bash(mktemp:*), Bash(owenloop:*), Bash(rm:*)
---

# plan

`plan` is a compiler, not a worker. It turns a novel, multi-domain task into
one checked, ephemeral composite workflow, obtains an explicit human decision
from that composite's parked gate, and then hands the released run to the
selected crews. It never performs composite step work inline and never submits
artifacts for a composite run. After approval, execution belongs to the crews
and supervision belongs to `conduct` or `shift`.

This is deliberately a mixed MCP-plus-CLI permission surface: MCP discovers,
publishes, reads back, parks, and releases live definitions; the narrowly
scoped `owenloop` CLI performs the local full-closure model check. `Write` and
the three scoped shell prefixes are only for staging that checked closure. Do
not use an unscoped shell, `Edit`, worker lifecycle tools, or a conversational
substitute for the durable gate.

## Decision gate

Use this compiler only when **no single catalog definition covers the task**
and composition has meaningful value: normally at least two inspected library
playbooks plus one coherent bespoke gap. If one existing playbook fits, use it
directly. If the work cannot be expressed as one coherent composite, explain
that limitation rather than forcing a graph.

Never invent rejected candidates. A definition may appear in the plan only
after it was returned by discovery and inspected with `get_workflow`.

## Discover and select real library definitions

1. Call `list_workflows` first. This is the catalog baseline and, with
   `include_ephemeral: true`, is also the later collision check.
2. Call `search_workflows` to narrow the catalog by the task's domains and
   likely interfaces. Search results are leads, not proof of compatibility.
3. Call `get_workflow` for every promising candidate before selecting it.
   Read each declared input, single public output, version, content hash,
   Mermaid, and whether it is a usable live definition.
4. Select only compatible targets whose declared child input can be produced
   after approval. Record every considered definition, selected or not.

Generate a legal lowercase collision-safe root name, for example
`eph-plan-<short-task-slug>-<unix-ms>-<random-hex>`. Refuse an exact-name
collision from the inclusive listing. A successful inclusive listing is **not**
remote capability attestation: `create_workflow({ yaml, ephemeral: true })`
performs the remote ephemeral preflight. Do not infer support merely because a
local tool lists a field.

## Compile one canonical `compiledPlan` artifact

Make the root declare `task`, `compiledPlan`, and `planApproval` as inputs.
`compiledPlan` is a schema-bearing `seedOwed` input supplied at start; it is
the single authoritative plan artifact, not an adjacent prose rationale. Its
schema must be closed wherever its fields are known and require at least the
following shape (add task-specific schema detail without weakening it):

```yaml
name: compiledPlan
seedOwed: true
producer: plan-compiler
schema:
  type: object
  required: [brief, launchInputs, candidates, selectedTargets, rootYaml, checkJson, checkSummary, mermaid, publishedRoot]
  properties:
    brief: { type: string, minLength: 1 }
    launchInputs: { type: object, minProperties: 1 }
    candidates:
     type: array
     minItems: 2
     items:
      type: object
      required: [coordinate, selected, reason]
      properties:
       coordinate: { type: string, minLength: 1 }
       selected: { type: boolean }
       reason: { type: string, minLength: 1 }
      additionalProperties: false
    selectedTargets:
     type: array
     minItems: 2
     items:
      type: object
      required: [coordinate, name, version, contentHash]
      properties:
       coordinate: { type: string, minLength: 1 }
       name: { type: string, minLength: 1 }
       version: { type: integer, minimum: 1 }
       contentHash: { type: string, minLength: 1 }
      additionalProperties: false
    rootYaml: { type: string, minLength: 1 }
    checkJson: { type: string, minLength: 1 }
    checkSummary:
     type: object
     required: [completable, bounded, deadlocks, stallStates, stuck, structurallyDeadSteps, unreachedSteps, invariantViolations]
     properties:
      completable: { const: true }
      bounded: { const: false }
      deadlocks: { type: array, maxItems: 0 }
      stallStates: { type: array, maxItems: 0 }
      stuck: { type: array, maxItems: 0 }
      structurallyDeadSteps: { type: array, maxItems: 0 }
      unreachedSteps: { type: array, maxItems: 0 }
      invariantViolations: { type: array, maxItems: 0 }
     additionalProperties: false
    mermaid: { type: string, minLength: 1 }
    publishedRoot:
     type: object
     required: [name, version, contentHash]
     properties:
      name: { type: string, minLength: 1 }
      version: { type: integer, minimum: 1 }
      contentHash: { type: string, minLength: 1 }
     additionalProperties: false
  additionalProperties: false
```

`candidates` contains exactly the definitions actually considered. An item can
be `selected: false` only when that candidate was returned and inspected; its
non-empty `reason` explains the compatibility, coverage, or selection choice.
The read-back name, version, and content hash in `selectedTargets` pin the
called definitions, while `publishedRoot` pins the resulting composite.

The separate human input must remain owed at launch and be an object, never a
bare boolean:

```yaml
- name: planApproval
  seedOwed: true
  producer: human
  schema:
    type: object
    required: [approved]
    properties:
      approved: { const: true }
      notes: { type: string }
    additionalProperties: false
```

Every execution path must stay downstream of this debt. The first executable
bespoke step consumes `task`, `compiledPlan`, and `planApproval`; it performs
real task decomposition and produces the typed inputs used by every selected
`calls:` step. No other step may consume a separately seeded input that makes
it eligible before approval. Each `calls:` entry maps a declared child input
to one of those post-approval artifacts and exposes that child's single
declared output. Fan the called results into a bespoke synthesis/final step.

For a canned proof, re-read the live catalog before choosing them; current
`research` and `investigate` are likely candidates because each accepts one
`request` input and exposes one `report` output. A suitable root has an
approval-gated bespoke `decompose` step, both library `calls:`, and a bespoke
`synthesize` step. Do not pretend a no-op gate is the bespoke work.

If the composite allocates a workspace, account, deployment, or other
resource, include an appropriate deprovision/cleanup step and an `onCancel:`
declaration with the exact artifacts it needs. A declined plan is cancelled;
its declared cleanup/deprovision path must be allowed to run before retirement.

## Model-check the complete exact calls closure

`create_workflow` is a parse-and-load gate, not a model check. Before
publication, create one unique temporary definitions directory **outside the
repository** with `mktemp`. Write the exact proposed root YAML and every exact
selected `calls:` target into that staging universe, preserving the qualified
or versioned identifiers actually used by the root. Do not silently rewrite a
target to a bare name merely to make validation pass. If the exact catalog
closure cannot be represented locally, stop and report that model-checking is
blocked.

Run both commands against the complete staged closure:

```sh
owenloop lint --defs <staging-dir>
owenloop check <composite-name> --defs <staging-dir> --format json
```

Parse and retain the full check JSON; exit zero alone is not success. Require
`completable === true`, `bounded === false`, and empty `deadlocks`,
`stallStates`, `stuck`, `structurallyDeadSteps`, `unreachedSteps`, and
`invariantViolations`. Revise the exact YAML and rerun the full closure on any
validation error or non-clean field. `owenloop graph <composite-name> --defs
<staging-dir> --format mermaid` may help diagnose local wiring, but the
human-facing Mermaid must come from the later `get_workflow` read-back. Remove
only that exact temporary directory with `rm` after capturing the clean JSON.

## Publish, park, present, and release

Follow this order exactly:

1. Call `create_workflow` with the clean exact root YAML and `ephemeral: true`.
2. Call `get_workflow` for the generated name. Require `ephemeral: true` and
   the expected name, version, and content hash. A create success alone is not
   enough. Take the human-facing Mermaid from this read-back.
3. Finalize `compiledPlan` with the root YAML, full clean check JSON and
   summary, structured candidates, selected-target identities, Mermaid, and
   published-root identity.
4. Call `start_run` with `task`, `compiledPlan`, and every other required
   seeded launch value, but deliberately omit `planApproval`.
5. Immediately call `get_status`. Require `eligible: []`; then call
   `pending_gates` and require an owed `planApproval` gate for this exact
   workflow. If a step is eligible or that gate is absent, do not claim
   approval safety or proceed.
6. Present the exact `compiledPlan`, read-back Mermaid, candidate rationale,
   and parked workflow identity to the human. Gate visibility is evidence that
   the run is parked, not approval.
7. On explicit approval, call `provide_input` for `planApproval` exactly once
   with the schema-valid affirmative object. Call `get_status` again and
   require the intended first step to be eligible or already claimed, proving
   release.
8. On decline, do not provide the input. Run `owenloop cancel <workflow>
   --reason "compiled plan declined"`, report cancellation and cleanup state,
   and retire only after terminal cleanup.
9. On approval, hand the live run to selected crews and `conduct`/`shift`.

The parked instance intentionally occupies an inbox/quota slot before
approval. Do not create a pre-run approval workflow to avoid that consequence.

## Retire the ephemeral definition safely

Only after a terminal run, call `get_workflow` again and compare its name,
version, and content hash with the values recorded at publication. If any
differ, do not delete: a concurrent publisher owns the live pointer. If they
match, call `delete_workflow` once. Historical pinned definition versions are
not retired. Report exact preflight, read-back, check, cancellation, or delete
refusals rather than guessing that cleanup succeeded.

## Evidence to preserve

For a canned multi-domain execution, preserve the exact composite YAML, full
check JSON, read-back Mermaid, parked `eligible: []` status, matching pending
gate, one approval/release status, and final run id/status. If the live hub,
library definitions, routes, or crews prevent execution, preserve the exact
blocker; do not replace it with a smaller claim.
