---
name: ephemeral
description: Create, self-drive, and retire a collision-safe hub ephemeral workflow for your own complex one-off work. Use when rework, fan-out, quality gates, session survival, or unattended brakes make a todo list insufficient.
allowed-tools: mcp__plugin_owenloop_owenloop__list_workflows, mcp__plugin_owenloop_owenloop__create_workflow, mcp__plugin_owenloop_owenloop__get_workflow, mcp__plugin_owenloop_owenloop__start_run, mcp__plugin_owenloop_owenloop__whats_next, mcp__plugin_owenloop_owenloop__heartbeat, mcp__plugin_owenloop_owenloop__get_order, mcp__plugin_owenloop_owenloop__submit, mcp__plugin_owenloop_owenloop__reject_artifact, mcp__plugin_owenloop_owenloop__get_status, mcp__plugin_owenloop_owenloop__delete_workflow, mcp__owenloop__list_workflows, mcp__owenloop__create_workflow, mcp__owenloop__get_workflow, mcp__owenloop__start_run, mcp__owenloop__whats_next, mcp__owenloop__heartbeat, mcp__owenloop__get_order, mcp__owenloop__submit, mcp__owenloop__reject_artifact, mcp__owenloop__get_status, mcp__owenloop__delete_workflow
---

# ephemeral

Use this only for a caller-owned, one-off workflow on the hub. You author it,
perform its real served work, and retire its live name when it is complete.
This is the explicit exception to the ordinary chief-of-staff posture: never
use it to fabricate progress for an unrelated crew run.

## Decision gate

A todo list is free. An ephemeral workflow costs authoring and lifecycle
overhead. Use it only when **at least two** signals apply:

| # | Signal | Concrete test |
|---|---|---|
| R1 | Rework loop | A verify or review step will plausibly send work back with reasons at least once. |
| R2 | Fan-out | The same operation runs over N items discovered at runtime, where N > 3. |
| R3 | Quality gate | Downstream work must not proceed until an artifact clears a bar you can state as a judge prompt. |
| R4 | Survival | The work must outlive this context window or session, or be resumable by another session. |
| R5 | Upstream volatility | An early artifact such as a plan, scout list, or diagnosis will plausibly be revised after downstream work exists. |
| R6 | Unattended brakes | Parts run with no human watching; repeated failure must stall rather than loop. |

Never use it when any of these hold:

- Straight line of at most about five steps with no plausible rework: use a todo list.
- Steps are smaller than one coherent agent turn; lifecycle overhead dominates.
- You cannot yet name each step as “consumes X, produces Y” in one sitting. Explore inline first; runtime item discovery is fine after the graph is nameable.
- Everything fits comfortably in the current context and nothing will be rejected. The value here is memory and honesty across boundaries.

## Capability preflight

Before drafting YAML, call `list_workflows` with `include_ephemeral: true` for
the later collision check. A 200 inclusive listing is **not** a capability
attestation: the mounted CLI proxy can advertise new fields while an older
selected hub silently ignores them.

The `create_workflow` call with `ephemeral: true` must first perform the
remote MCP capability preflight, before it sends any create request. It must
attest that the selected hub's own `tools/list` exposes
`create_workflow.ephemeral`, `list_workflows.include_ephemeral`, and
`delete_workflow`. If that preflight returns an error, stop and report its
exact response. Never fall back to a durable definition or infer support from
the proxy's local tool surface.

## Publish a unique ephemeral definition

1. Generate a legal lowercase per-run name such as
   `eph-<short-task-slug>-<unix-ms>-<random-hex>`. Friendly or reusable names
   are forbidden.
2. Use the inclusive listing and refuse to create if that exact name already
   exists.
3. Draft the small workflow YAML in memory, then call `create_workflow` with
   the YAML and `ephemeral: true`.
4. Immediately call `get_workflow` for the generated name. Require read-back
   proof that `ephemeral: true`; a successful create response is insufficient
   because an unknown body key can be ignored. Record the returned live name,
   version, and hash.

## Self-drive honestly

Call `start_run` for the generated definition. Loop with `whats_next` for
that workflow. For every served order, make first contact with `heartbeat`
or `get_order`, perform the order's actual work, and `submit` every owed
value from the held run. Use `reject_artifact` only for a real upstream
defect with a concrete reason.

When no order is returned, use `get_status`. Stop only after terminal
completion. Do not use conduct or shift, and do not wait for an ordinary crew:
this deliberately ephemeral, caller-owned run is yours to execute. Do not
submit invented artifacts.

## Retire safely

After terminal status, call `get_workflow` again and compare its name,
version, and hash with the values recorded after publication. If any differ,
do not delete: a concurrent publisher owns the live pointer. If they match,
call `delete_workflow` exactly once.

Retirement removes only the live catalog pointer. Historical pinned definition
versions remain reachable and are never deleted.

Classify a `workflow_delete_refused` response by its message, never its HTTP
status alone. “Active root references” is potentially retryable only after
rechecking terminal status. “No live definition” and “not ephemeral” are
permanent refusals. Do not blindly loop on every 409 or every
`workflow_delete_refused`.

If preflight fails, read-back does not prove `ephemeral: true`, the live
version or hash changed, or retirement is permanently refused, stop and
surface the exact response. Do not claim cleanup succeeded.
