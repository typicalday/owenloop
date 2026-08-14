# Agent runner and harness policy

`owenloop work agent-run` is the only supported dispatcher for workflow Step Agents. The Shift daemon starts `agent-run` children for agent orders. Plugins and skills supervise the Shift daemon; plugins do not package or dispatch a static workflow-worker agent.

The runtime worker resolves the verified workflow definition from the local workflow store, selects the final harness after CLI and environment overrides, and runs permission preflight before either a cold start or a resume. A policy refusal starts no model SDK, CLI, or app-server process. The worker prints every refusal reason, releases the held claim, and exits non-zero.

Runtime preflight is authoritative. `owenloop work lint` runs the same common and adapter checks for author feedback, but lint cannot account for a later `--harness` or `OWENLOOP_HARNESS` override.

Native judge entries do not carry a separately authored `x` map. The definition
compiler deep-clones the producer step's complete parsed `x` map onto every
synthesized judge step, and generated and persisted judge orders expose that
map as `Order.x`. The worker therefore reads the current judge's inherited
`x.harness` from the same verified definition snapshot used for the judge's
instructions. Final-adapter selection and mandatory preflight apply before
both judge cold starts and judge resumes. A judge entry's first-class `model`
continues to win over an inherited `x.harness.model` value.

## `x.harness` permission fields

The reserved neutral fields are:

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

- `tools` and `disallowedTools` accept a comma-separated string or a string array.
- An absent `tools` field means that the workflow did not declare a built-in-tool allow-list.
- `tools: []` is an explicit empty allow-list and disables all built-in tools on adapters that support tool lists.
- `filesystem` is one of `read-only`, `workspace-write`, or `unrestricted`.
- `network` is one of `owenloop-only` or `unrestricted`.
- `permissionMode` accepts each adapter's own vocabulary, plus three neutral values: `ask`, `auto-safe`, and `full-access`.
- `tools` and `disallowedTools` must not overlap.
- Invalid types, invalid closed-set values, generated `name`/`description` fields, and the legacy `x.claude-code` carrier are definition errors.
- Unknown `x.harness` keys remain opaque extension data. The selected adapter may interpret or warn about those keys.

A cache created by an older CLI may contain `filesystem` or `network` under `permissions.extensions`. The cache reader and final permission preflight refuse that shape because the old normalization would ignore the restriction. Run `owenloop work prepare <workflow>` again.

## Capability matrix

| Restriction | Claude Code adapter | Codex adapter |
|---|---|---|
| absent `tools` | preserves the normal SDK built-in-tool default unless another restriction requires an audited set | supported only because no tool list was authored |
| `tools: []` | disables all built-in tools; only the born-bound Owenloop control tools remain | refused; Codex cannot enforce per-thread tool lists |
| non-empty `tools` | enforced through both `tools` and `allowedTools`; settings, skills, and external MCP are isolated so unlisted tools cannot widen the surface | refused |
| `disallowedTools` | enforced through `disallowedTools` | refused |
| `filesystem: read-only` | with `network: unrestricted`, uses `Read`, `Glob`, `Grep`, `WebFetch`, and `WebSearch`; with `network: owenloop-only`, uses only `Read`, `Glob`, and `Grep` | refused; Codex cannot prove a complete neutral read-only boundary because app-server configuration layers are outside the thread sandbox |
| `filesystem: workspace-write` | refused; the adapter cannot enforce an exact workspace boundary | refused; Codex cannot prove a complete neutral workspace-write boundary because app-server configuration layers are outside the thread sandbox |
| `filesystem: unrestricted` | supported | maps to sandbox `danger-full-access`; open-ended `codexConfig`, external MCP, and operator configuration remain backward compatible because no filesystem boundary is claimed |
| `network: owenloop-only` | supported through isolated settings, skills, MCP, and built-in tools | refused |
| `network: unrestricted` | supported | supported with `filesystem: unrestricted`, or with an omitted filesystem field and legacy sandbox `workspace-write` / `danger-full-access`; legacy sandbox `read-only` is refused because Codex has no independent read-only network control |
| `maxTurns` | enforced by the SDK | refused; Codex app-server has no thread or turn limit parameter |
| `permissionMode: ask` | translated to `default` | translated to `approvalPolicy: untrusted` |
| `permissionMode: auto-safe` | translated to `auto`, without the danger companion flag | translated to `approvalPolicy: on-request` |
| `permissionMode: full-access` | translated to `bypassPermissions` plus the SDK's `allowDangerouslySkipPermissions` companion flag | translated to `approvalPolicy: never` |
| another adapter's `permissionMode` value | refused; the Claude Code adapter accepts only its own SDK union plus the three neutral values | refused; the Codex adapter accepts only `untrusted`, `on-request`, `never`, plus the three neutral values |

Codex refusal of explicit `filesystem: read-only` and `filesystem: workspace-write` is intentional and runs before both cold start and resume. Codex app-server loads configuration from thread, project, global/managed, and persisted session layers. The pinned Codex version has no reliable switch that isolates every layer, and some layers can introduce host processes, providers, endpoints, MCP servers, or additional writable roots outside the thread sandbox. Partial filtering would claim a boundary the adapter cannot prove, so the adapter starts no app-server process and the worker releases the held claim.

Codex also refuses every defined `maxTurns` value before both cold start and resume. Codex app-server has no thread or turn limit parameter, so accepting `maxTurns` would silently discard an authored execution limit. The adapter starts no app-server process and the worker releases the held claim.

An omitted `filesystem` field preserves the existing Codex default sandbox behavior. `filesystem: unrestricted` preserves the existing explicit `danger-full-access` behavior. The legacy adapter extension `sandbox` remains available with `read-only`, `workspace-write`, or `danger-full-access` for backward compatibility, but `sandbox` is a vendor-specific pass-through rather than Owenloop's neutral filesystem guarantee. A workflow that requires an enforceable neutral read-only policy must select the Claude Code adapter.

The worker-created `owenloop` MCP mount still wins any `mcp_servers.owenloop` name clash. The default unrestricted mount registers `get_order`, `submit`, and `reject`. Codex approval policy still accepts only `untrusted`, `on-request`, or `never` as vendor values.

## Neutral approval modes

`permissionMode` names how much a step may do before a human is consulted. It is the one neutral field whose values were vendor-specific: Claude Code's never-prompt mode is `bypassPermissions` and Codex's is `never`, and each adapter refuses the other's. A step that must never prompt therefore had to name one vendor's word, which pinned the step to that vendor exactly as an explicit `id:` would.

The neutral vocabulary is three positions on one axis, and both shipped harnesses draw all three distinctions themselves:

| Neutral value | What is the gate | Claude Code | Codex |
|---|---|---|---|
| `ask` | a human, before anything beyond trivially safe reads | `default` | `untrusted` |
| `auto-safe` | a model-side classifier; it proceeds on ordinary work and consults a human only when an action is potentially dangerous | `auto` | `on-request` |
| `full-access` | nothing; the harness never consults a human and a failed action is reported back to the model | `bypassPermissions` + `allowDangerouslySkipPermissions` | `never` |

`auto-safe` is not a milder `full-access`. It can still stop and ask, which is the whole point of it, so an adapter must never map it onto a never-ask mode. The two exist separately so a definition states the choice rather than having it inferred.

`ask` and `auto-safe` are meaningful only where something can answer a prompt. In a Shift-dispatched run nothing can today, so a prompt is a stall: the Step Agent stops mid-turn, submits nothing, and the hub re-arms the step into a retry storm whose every worker dies in the same place. That is a reason for a definition author to choose `full-access` for headless steps, not a reason for an adapter to silently upgrade one value into another.

For each neutral value an adapter must either map it onto the vendor mode with the same meaning, or refuse it in preflight. Refusal is a legitimate answer and fails closed: the worker releases its claim and starts no model process. Mapping a value onto a mode that grants more than the value describes is never legitimate.

Each adapter still accepts its own vendor vocabulary and still refuses the other's, so no already-published definition changes meaning. A definition that uses a neutral value must declare the `neutral-approval-modes.v1` runtime feature. On a CLI that predates the feature, both shipped adapters refuse the neutral value as out-of-vocabulary and the step fails closed, but the message names a bad permission mode rather than an old runtime; the feature declaration moves that diagnosis to the bundle compatibility check, before any order is offered.

The Claude Code adapter refuses a `read-only` allow-list containing anything outside `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, and the born-bound control tools. With `network: owenloop-only`, the allowed read-only built-ins narrow to `Read`, `Glob`, and `Grep`; `WebFetch` and `WebSearch` remain available only with `network: unrestricted`. The Claude Code adapter refuses an `owenloop-only` allow-list containing Bash, web tools, skills, agent delegation, or any unaudited tool. The Claude Code adapter also refuses authored external MCP tool names because the current option surface cannot prove an exact per-tool allow-list for an external server.

## Owenloop control-plane exception

`network: owenloop-only` means that the Step Agent may reach only the born-bound Owenloop MCP control plane for the held order. The exception exists so the Step Agent can call `get_order` and `submit`; without those calls the Step Agent cannot inspect or complete the order.

For Claude Code isolation, the adapter sets `settingSources: []`, `strictMcpConfig: true`, disables skills, excludes hooks and external MCP servers, and mounts only the worker-created `owenloop` MCP server. The restricted MCP child positively registers exactly `get_order` and `submit`; the restricted MCP child does not register `reject`. A future work-holder tool therefore does not enter restricted sessions unless the adapter explicitly adds the tool to the positive registration list. The adapter also restricts built-in tools to an audited no-network set. The same option construction runs for cold start and resume.

The born-bound Owenloop MCP server is created by the worker from the live workflow, run, origin, account, Shift, and held claim. Workflow extension data cannot replace that mount. During isolation, the adapter adds `mcp__owenloop__get_order` and `mcp__owenloop__submit` to `allowedTools` so both control calls execute without an unattended permission prompt. `allowedTools` controls permission automation; `allowedTools` does not filter the MCP server's `tools/list` response. The positive registration list on the MCP child is the visibility boundary. The adapter also adds `mcp__owenloop__reject` to `disallowedTools` as defense in depth. A direct deny or an MCP wildcard deny that blocks Owenloop `get_order` or `submit` is refused.

Outside Claude Code isolation, the default work-holder MCP child continues to register `get_order`, `submit`, and `reject`.

## Security boundary

`x.harness` permission fields are enforced policy. Adapter preflight must prove that the selected adapter can implement each authored restriction exactly; unsupported policy fails closed.

`advisory.tools` is model guidance only. `advisory.tools` does not configure an adapter, does not remove a provider tool, and is not a security boundary.
