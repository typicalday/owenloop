# Agent runner and harness policy

`owenloop work agent-run` is the only supported dispatcher for workflow Step Agents. The Shift daemon starts `agent-run` children for agent orders. Plugins and skills supervise the Shift daemon; plugins do not package or dispatch a static workflow-worker agent.

The runtime worker resolves the verified workflow definition from the local workflow store, selects the final harness after CLI and environment overrides, and runs permission preflight before either a cold start or a resume. A policy refusal starts no model SDK, CLI, or app-server process. The worker prints every refusal reason, releases the held claim, and exits non-zero.

Runtime preflight is authoritative. `owenloop work lint` runs the same common and adapter checks for author feedback, but lint cannot account for a later `--harness` or `OWENLOOP_HARNESS` override.

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
| `filesystem: read-only` | with `network: unrestricted`, uses `Read`, `Glob`, `Grep`, `WebFetch`, and `WebSearch`; with `network: owenloop-only`, uses only `Read`, `Glob`, and `Grep` | maps to sandbox `read-only`; explicit external MCP, notification, hook, and plugin process config is refused |
| `filesystem: workspace-write` | refused; the adapter cannot enforce an exact workspace boundary | maps to sandbox `workspace-write`; explicit external MCP, notification, hook, and plugin process config is refused; additional writable roots are removed |
| `filesystem: unrestricted` | supported | maps to sandbox `danger-full-access`; external process config is permitted because no filesystem boundary is claimed |
| `network: owenloop-only` | supported through isolated settings, skills, MCP, and built-in tools | refused |
| `network: unrestricted` | supported | `workspace-write` sets `sandbox_workspace_write.network_access = true`; `danger-full-access` already includes unrestricted network; `read-only` is refused because Codex has no independent read-only network control |

The Codex adapter also accepts the legacy adapter extension `sandbox` only when the value is `read-only`, `workspace-write`, or `danger-full-access`. When both `filesystem` and `sandbox` are present, both fields must describe the same sandbox. Invalid or conflicting values are refused; the adapter never falls back to a weaker or broader default. Codex approval policy accepts only `untrusted`, `on-request`, or `never`.

Codex starts configured MCP servers, notification commands, hooks, and plugins beside the thread sandbox. A `read-only` or `workspace-write` sandbox therefore cannot prove that those host processes obey the thread filesystem boundary. The adapter refuses `mcpServers`, `codexConfig.mcp_servers`, and executable `codexConfig` notification/hook/plugin keys in those modes. The worker-created `owenloop` MCP mount remains available because the worker creates and overwrites that mount after extension validation.

Per-thread `config.mcp_servers` merges with the operator's Codex configuration instead of replacing it. For `read-only` and `workspace-write`, the adapter starts the app-server with a stable, config-free `CODEX_HOME` under the Owenloop cache. The isolated home links only the operator's `auth.json`; global config, MCP servers, plugins, and hooks are not inherited. The cwd-derived isolated path persists Codex rollout files so a later worker process can resume the same thread. `danger-full-access` keeps the operator's normal Codex home because that mode claims no filesystem restriction.

Codex 0.146.0 has no reliable app-server switch that disables project-local config, and the isolated `CODEX_HOME` does not stop `thread/start` from loading a project `.codex/config.toml`. Before either cold start or resume, a restricted Codex run therefore checks the normalized and canonical cwd ancestor chains through the detected `.git` project root. Restricted start and resume replace `codexConfig.project_root_markers` with `['.git']`, because custom or inherited markers can replace `.git` and extend project-config discovery beyond the checked chain. If any `.codex/config.toml` exists on either checked chain, the adapter refuses before spawning the app-server. Remove or rename the project-local `.codex/config.toml`, or use `filesystem: unrestricted` only when the workflow may trust that config. Unrestricted runs preserve custom project-root markers and continue to load project config normally.

Under `workspace-write`, the adapter reconstructs `sandbox_workspace_write` instead of spreading workflow or inherited session config. The adapter preserves only the narrowing `exclude_slash_tmp` and `exclude_tmpdir_env_var` booleans, sets `network_access: true` only for neutral `network: unrestricted`, and removes every authored or inherited `writable_roots` value. A restricted resume also removes a broader turn's inherited workspace-write map before adding the reconstructed map.

The Claude Code adapter refuses a `read-only` allow-list containing anything outside `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, and the born-bound control tools. With `network: owenloop-only`, the allowed read-only built-ins narrow to `Read`, `Glob`, and `Grep`; `WebFetch` and `WebSearch` remain available only with `network: unrestricted`. The Claude Code adapter refuses an `owenloop-only` allow-list containing Bash, web tools, skills, agent delegation, or any unaudited tool. The Claude Code adapter also refuses authored external MCP tool names because the current option surface cannot prove an exact per-tool allow-list for an external server.

## Owenloop control-plane exception

`network: owenloop-only` means that the Step Agent may reach only the born-bound Owenloop MCP control plane for the held order. The exception exists so the Step Agent can call `get_order` and `submit`; without those calls the Step Agent cannot inspect or complete the order.

For Claude Code isolation, the adapter sets `settingSources: []`, `strictMcpConfig: true`, disables skills, excludes hooks and external MCP servers, and mounts only the worker-created `owenloop` MCP server. The adapter also restricts built-in tools to an audited no-network set. The same option construction runs for cold start and resume.

The born-bound Owenloop MCP server is created by the worker from the live workflow, run, origin, account, Shift, and held claim. Workflow extension data cannot replace that mount. During isolation, the adapter adds `mcp__owenloop__get_order` and `mcp__owenloop__submit` to `allowedTools` so both control calls execute without an unattended permission prompt. A direct deny or an MCP wildcard deny that blocks Owenloop `get_order` or `submit` is refused.

## Security boundary

`x.harness` permission fields are enforced policy. Adapter preflight must prove that the selected adapter can implement each authored restriction exactly; unsupported policy fails closed.

`advisory.tools` is model guidance only. `advisory.tools` does not configure an adapter, does not remove a provider tool, and is not a security boundary.
