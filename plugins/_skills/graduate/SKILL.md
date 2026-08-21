---
name: graduate
description: Promote evidence from a successful completed ephemeral composite into a reusable library candidate and admission-evidence record. Use when a plan-compiled ephemeral workflow has finished done and a target library needs a policy-conformant candidate definition.
allowed-tools: mcp__plugin_owenloop_owenloop__get_workflow, mcp__plugin_owenloop_owenloop__get_status, mcp__owenloop__get_workflow, mcp__owenloop__get_status, Write, Bash(mktemp:*), Bash(owenloop:*), Bash(rm:*)
---

# graduate

`graduate` prepares a reusable library candidate from one successful,
completed plan-compiled ephemeral composite. It produces a candidate YAML/path
and an admission-evidence record for the receiving library's policy gate. It
does not publish a bundle, pack a repository, assign stability, or say that a
graduation succeeded. The receiving library's clean-export/vendor/pack policy
remains the publication boundary.

This is deliberately a narrow, mixed permission surface. MCP supplies the
immutable source facts and terminal proof. `Write`, `Bash(mktemp:*)`,
`Bash(owenloop:*)`, and `Bash(rm:*)` exist only to stage and model-check one
exact temporary definition universe. Do not use `Edit`, a bare shell,
authoring or run-lifecycle tools, deletion verbs, or worker verbs.

## Required evidence and ordering

Require all of the following before proposing a candidate:

- the originating ephemeral definition name, version, and content hash;
- the originating workflow instance ID;
- the plan skill's preserved evidence: the exact `compiledPlan` with its
  candidate and selection rationale, exact composite YAML, full clean check
  JSON, read-back Mermaid, parked gate proof, approval/release proof, and final
  run ID/status.

Retirement closes the live-name window. Follow this order:

1. Call `get_workflow(<ephemeral-name>)` **before retirement** and capture its
   complete bundle. Require `ephemeral: true` and exact agreement with the
   preserved name, version, and content hash. Its declared inputs, full step
   bodies and schemas, `pins`, and hash-keyed frozen `children` closure are
   the source definition.
2. If the live pointer was already retired, proceed only when the exact
   publication-time full bundle was preserved. Otherwise stop rather than
   reconstructing it.
3. Call `get_status(<workflow-id>)`. Require `terminal === true` and
   `instanceStatus === "done"`. Failed or cancelled terminal runs are not
   graduation evidence.
4. Take the selection rationale from the preserved `compiledPlan`.
   `get_status` does not return artifact payloads; never use it to read
   `compiledPlan` back.
5. Cite the originating workflow ID. Do not attempt a receipt read: receipt
   bodies are unavailable on the agent-facing MCP and CLI surface, and the
   receiving policy expressly allows a workflow ID instead.

After `delete_workflow` removes an ephemeral live pointer,
`get_workflow` by that name returns an unknown-definition error. Historical
definition rows and pins can remain, and a still-live parent can still expose a
frozen child, but that is not name resolution. Graduation must therefore happen
before retirement or use the exact full bundle captured at publication.

## Generalize the captured composite

Rebuild the candidate from the captured root and frozen `calls:` closure
without inventing workflow content. Preserve reusable behavior and exact
compatible child coordinates, but remove one-run compiler scaffolding and
parameterize task-specific literals.

Treat each root seed explicitly:

- `task`: replace the one-off value with the concrete reusable domain inputs
  the composite actually consumed. Give every resulting top-level input a
  descriptive name and explicit JSON Schema. Retain a generic `task` input
  only when it is deliberately the reusable public contract, never as a
  shortcut.
- `compiledPlan`: remove it from candidate runtime inputs and every runtime
  consume. Preserve its `candidates`, `selectedTargets`, and reasons in the
  admission-evidence record, where the one-run compiler rationale belongs.
- `planApproval`: remove the ephemeral compiler-release gate. If the reusable
  workflow genuinely needs human authorization on every run, design a newly
  named, domain-specific, schema-bearing human input/gate and wire all
  applicable effects behind it; do not carry `planApproval` forward by
  inertia.

Replace embedded one-run values in step bodies and mappings with references to
the new declared inputs. Require an explicit schema on every top-level input
and every authored `produces`/`generates` artifact, including internal
artifacts. Require every top-level output name to resolve to a schema-bearing
declaration. Preserve the complete exact `calls:` closure needed for local
checking.

Before proposing the candidate, compare every candidate step name with every
step name across the target library's complete clean-export workflow set.
Rename collisions coherently, update references, and re-run every check. A
per-definition lint or check is not sufficient for this archive-wide
invariant.

## Discovery metadata and local model check

Give the candidate an `x.discovery` object containing exactly
`description`, non-empty `whenToUse`, non-empty `notFor`, and
`interface`. `interface.inputs` and `interface.outputs` must cover every
declared input and public output exactly once, with no unknown or duplicate
names. Each entry must contain exactly a non-empty `name`, non-empty
`summary`, and `schemaRef`. Every `schemaRef` must be a local JSON Pointer
beginning `#/` and resolve to that declaration's existing schema, for example
`#/inputs/0/schema` or `#/steps/2/produces/0/schema`; never copy a schema
into discovery metadata.

Stage the candidate and every exact `calls:` target in one unique
`mktemp` directory outside the repository. Run:

```sh
owenloop lint --defs <staging-dir>
owenloop check <candidate-name> --defs <staging-dir> --format json
```

Require lint to have zero errors and zero warnings. Parse the check JSON and
require `completable === true`, `bounded === false`, and empty
`deadlocks`, `stallStates`, `stuck`, `structurallyDeadSteps`,
`unreachedSteps`, and `invariantViolations`. Revise and repeat on any
failure, then remove only that exact temporary directory. Do not pack.

Hand the candidate to the target library's W2.1 clean-export/vendor/pack policy
gate. Those repository-owned rules remain the publication boundary.

## Deliver the candidate and evidence record

Deliver two explicit results:

1. The candidate YAML and its intended target path.
2. An evidence record retaining the source ephemeral name/version/hash and
   workflow ID; terminal `done` proof; preserved `compiledPlan` selection
   rationale and selected target coordinates; generalized-input mapping; final
   lint/check evidence; archive-wide step-name comparison; and ready-to-use
   version-bump narration.

The narration must expose these policy fields separately:

- `workflowCoordinate` — target package/workflow coordinate;
- `workflowVersion` — candidate receiving-bundle version;
- `originatingWorkflowId`;
- `completionResult` — `done`;
- `date` — `YYYY-MM-DD`.

If the preserved evidence lacks an actual completion timestamp, use the UTC
date on which `get_status` was re-verified and label it the verification date;
do not invent a completion time.

Prepare, but do not edit, the receiving repository's house-form comment
immediately above `package.version`:

```yaml
# <bundle-version>: graduated <workflow-coordinate>@<workflow-version>; originating workflow <wf_...>; completion result done; verified YYYY-MM-DD.
```

Do not edit `owenloop-playbooks/bundle.yaml`, assign stability, pack a bundle,
or claim publication or graduation completed. The receiving policy gate decides
those outcomes.
