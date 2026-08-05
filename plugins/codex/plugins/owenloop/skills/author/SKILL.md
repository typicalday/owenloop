---
name: author
description: Author a new owenloop workflow through owenloop's create_workflow gate — interview, draft YAML, validate, approve. Use when asked to design/create/author a new workflow for owenloop.
allowed-tools: mcp__plugin_owenloop_owenloop__create_workflow, mcp__plugin_owenloop_owenloop__start_run, mcp__owenloop__create_workflow, mcp__owenloop__start_run
---

# author

Authoring through the service. You draft the YAML; the engine (via
`create_workflow`) is the validator, not you. Never trust your own read of
the grammar over what the engine actually accepts.

## Tool names

This plugin attaches the owenloop MCP server, so its tools show up namespaced as
`mcp__plugin_owenloop_owenloop__<tool>`, e.g.
`mcp__plugin_owenloop_owenloop__create_workflow` and
`mcp__plugin_owenloop_owenloop__start_run`. If tool calls by that name fail,
run `claude mcp list` to confirm the real names before proceeding.

## Steps

1. **Interview the human** for the goal, in plain English. Ask what the
   steps are, what each step needs and produces, and where a human needs to
   sign off. Do not show YAML during this conversation.
2. **Draft the def YAML yourself** — name, inputs, steps, consumes/produces,
   schemas on outputs where it makes sense to enforce a shape.
3. **Call `create_workflow`** with the draft.
4. **If errors come back:** fix the YAML and resubmit. This is a loop — the
   engine's error text is ground truth, not a suggestion. Cap it at ~5
   attempts; if still failing, show the human the raw error and the current
   draft and ask for help.
5. **On success:** show the human the returned mermaid diagram and a
   plain-English step list (not the raw YAML) for approval.
6. **Offer `start_run`** once approved, with any inputs the human already
   knows they want to seed.

## Stamped-agent dispatch (`x.claude-code` bag)

A step that should be dispatched to a stamped Claude Code subagent (the
`owenloop` Shift daemon's dispatch path, which the `conduct` and `shift` skills
attend) carries an `x.claude-code` bag in its def — the frontmatter/prompt
template the daemon stamps into a per-order agent file. Steps without a valid
bag are never stamped-dispatched; they fall to the hub's own pickup window
(conduct's fallback path). When a def is meant for stamped dispatch, validate
its bags before handing it off: ask the human to run `owenloop work lint
<workflow-name | path>` in their own shell — this skill grants no Bash tool, so
you cannot run it yourself. Exit `0` is clean or warnings-only, exit `1` means it
found an error to fix. This is optional authoring polish, not part of
`create_workflow`'s own validation.

## Rules

- Never show raw YAML unless the human explicitly asks to see it.
- The engine's error text is ground truth — pass it through verbatim, don't
  paraphrase or guess at a fix without reading it.
- Schemas on outputs are encouraged, not optional busywork — that's the
  actual enforcement mechanism (tight schemas catch sloppy workers; loose
  ones are a deliberate choice for a happy-path step, not an oversight).
- **Never write a Crew name in a def.** A def is portable; a Crew name is one
  org's deployment fact. `personal:` names in particular are rejected as
  Capability names.
- **Default to no `capabilities:`.** A step with no `capabilities:` is
  def-silent and routes to the run's default Crew — the starter's personal Crew
  unless the starter chooses otherwise. That is the normal case; most defs
  should carry no Capability requirement.
- **Use a Capability only when a step genuinely needs a specific fleet**
  (`gpu`, `repo-access` — a routing requirement, not a team name, machine, or
  Crew). An admin binds that Capability to one or more Crews per hub; the def
  never learns which Crews.
- **An unbound Capability fails the whole run at start**, not at the step:
  `start_run` is refused with `capability_route_invalid` naming the Capability
  and the fix. If you introduce a Capability, tell the human that the hub needs
  `owenloop capability bind <capability> <crew>` (or Console → Settings →
  Capabilities) before the def can run.

## Setup (once per machine)

- Install the plugin (adds the owenloop MCP server automatically). Until this
  pack is published to a public marketplace, add it via its local path in
  this repo:
  ```
  claude plugin marketplace add ./packages/driver-claude-code/marketplace
  claude plugin install owenloop@owenloop
  ```
- Run `owenloop setup` once — its single loopback OAuth is the only browser
  step; target a non-prod owenloop server with `owenloop setup --hub <origin>`.
  The owenloop stdio server then spawns pre-trusted in every session — no
  per-session consent, no token to copy for interactive use.
  Headless/CI setups instead add a separate server with an admin-minted
  `olp_...` token (`OWENLOOP_TOKEN`) — see the pack's `README.md` for the
  full install + connection walkthrough, both paths.
