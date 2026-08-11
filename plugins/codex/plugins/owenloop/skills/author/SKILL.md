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
6. **If any step carries `x.harness`:** ask the human to run `owenloop work lint
   <workflow-name | path>` in their own shell. This skill grants no Bash tool, so
   you cannot run the command yourself. Exit `0` is clean or warnings-only; exit
   `1` means the definition has an error to fix and resubmit through
   `create_workflow`. Runtime permission preflight remains authoritative because
   a later CLI or environment override can select a different adapter.
7. **Offer `start_run`** once approved and free of lint errors, with any inputs
   the human already knows they want to seed.

## Step Agent dispatch and `x.harness`

`owenloop work agent-run` is the only supported dispatcher for workflow Step
Agents. The Shift daemon starts an `agent-run` child for each agent order. The
`conduct` and `shift` skills supervise the Shift daemon; plugin-packaged workers
do not dispatch workflow steps.

A step carries adapter selection and policy under the fixed, vendor-neutral
`x.harness` map:

```yaml
x:
  harness:
    id: claude-code
    tools: [Read, Glob]
    disallowedTools: [Bash]
    filesystem: read-only
    network: owenloop-only
    permissionMode: default
    maxTurns: 20
    model: sonnet
    effort: high
```

`id` is optional. When `id` is absent, the runtime may select the registered
default adapter; `--harness` and `OWENLOOP_HARNESS` overrides take precedence
over the definition. Keep policy in `x.harness` even when `id` is absent.

The eight neutral fields are:

- `tools`: a comma-separated string or string array. An absent field declares no
  allow-list. `tools: []` explicitly disables all built-in tools on an adapter
  that supports tool allow-lists.
- `disallowedTools`: a comma-separated string or string array. `tools` and
  `disallowedTools` must not overlap.
- `filesystem`: `read-only`, `workspace-write`, or `unrestricted`.
- `network`: `owenloop-only` or `unrestricted`.
- `permissionMode`: a non-empty adapter-native mode listed below.
- `maxTurns`: a positive integer.
- `model`: a non-empty model id. A first-class step `model` field takes
  precedence when present.
- `effort`: a non-empty effort value accepted by the selected adapter.

Do not put generated `name` or `description` fields in `x.harness`. Unknown
keys remain opaque adapter extension data; an adapter may interpret or warn
about those keys, but unknown keys do not create a neutral security boundary.

### Exact adapter support

| Policy | Claude Code adapter | Codex adapter |
|---|---|---|
| absent `tools` | Preserves the normal built-in-tool default unless `filesystem` or `network` requires an audited set. | Supported only because no tool list was authored. |
| `tools: []` or a non-empty `tools` list | Enforced through both the available and auto-allowed tool sets. Settings, skills, and external MCP are isolated so unlisted tools cannot widen the surface. Authored external MCP tool names are refused. | Refused because Codex cannot enforce a per-thread built-in-tool list. |
| `disallowedTools` | Enforced. A deny that blocks the born-bound Owenloop `get_order` or `submit` control tools is refused. | Refused. |
| `filesystem: read-only` | Enforced. With unrestricted network the audited defaults are `Read`, `Glob`, `Grep`, `WebFetch`, and `WebSearch`; with `network: owenloop-only` the defaults narrow to `Read`, `Glob`, and `Grep`. | Refused because app-server configuration layers sit outside the thread sandbox. |
| `filesystem: workspace-write` | Refused because the adapter cannot prove an exact workspace boundary. | Refused because app-server configuration layers sit outside the thread sandbox. |
| `filesystem: unrestricted` | Supported. | Supported as sandbox `danger-full-access`; a conflicting vendor `sandbox` extension is refused. |
| `network: owenloop-only` | Enforced by isolating settings, skills, MCP, and built-in tools while retaining only the born-bound Owenloop control plane. | Refused. |
| `network: unrestricted` | Supported. | Supported with `filesystem: unrestricted`, or with omitted `filesystem` and sandbox `workspace-write` or `danger-full-access`; refused with sandbox `read-only`. |
| `permissionMode` | `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, or `auto`. | `untrusted`, `on-request`, or `never`. |
| `maxTurns` | Enforced. | Not mapped by the Codex adapter; do not author it for a Codex-selected step. |
| `model` | Supported. | Supported. |
| `effort` | `low`, `medium`, `high`, `xhigh`, or `max`. | Passed to Codex `turn/start`; use a value supported by the selected Codex runtime. |

The Claude Code adapter also refuses a `read-only` allow-list containing
non-read-only tools, an `owenloop-only` allow-list containing network-capable or
unaudited tools, and any policy that denies the required Owenloop control tools.

### Fail-closed rule

`x.harness` security restrictions are enforced policy. Runtime preflight must
prove that the final selected adapter can implement every authored restriction
exactly. An unsupported adapter restriction is refused: no model SDK, CLI, or
app-server process starts, the worker releases the held claim, and `agent-run`
exits non-zero with every refusal reason.

`advisory.tools` is model guidance only. `advisory.tools` does not configure an
adapter, does not remove a provider tool, and is not a security boundary.

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
