# Plan: one-command owenloop install for Claude Code **and** Codex

> **STATUS (2026-08-04): APPROVED FOR IMPLEMENTATION.** Decision A (§3.2) — move the driver pack from `owenloop-service` into `owenloop` — is **approved by Alex**, with one amendment: the old pack has no users, so the `owenloop-service` deletion happens in Phase 1 alongside the move; do not defer it. Decision B (monorepo merge) remains deferred. Implementing agents: work in a `dev` worktree, never in `main/`; make the first commit include this plan document.

**Goal.** A new user runs exactly this and ends up fully wired on every harness they have installed:

```bash
npm i -g owenloop && owenloop setup
```

`owenloop setup` must install the driver plugin (skills + MCP server) into Claude Code and into Codex, automatically, idempotently, and without network access beyond the npm install itself.

**Chosen approach — "Option B".** The plugin marketplace ships *inside* the `owenloop` npm package. `owenloop setup` points each harness's plugin CLI at a directory inside its own install tree. No second repo or git fetch is needed; release automation keeps the shipped version copies aligned, and runtime checks detect a stale installed plugin/CLI pair.

This document is written to be handed to an implementing agent with no prior context. Every claim below was verified against the working tree on 2026-08-04; file paths and line numbers are real.

> **Revision 2 (2026-08-04).** Three claims in revision 1 were wrong and are corrected here. (a) Codex **does** support hooks, including in plugins — §2.6. (b) Codex **does** support subagents, though not through the plugin system — §2.6. (c) `${CLAUDE_PLUGIN_ROOT}` **is** expanded inside a Claude Code plugin's `.mcp.json`, which closes former open question 6.1 — §2.7. Revision 2 also **reverses** the MCP launch recommendation from "bundled binary" to "`owenloop` on PATH", for the reason given in §2.8, and adds the CI enforcement section §9.

> **Revision 4 (2026-08-04).** Direction from Alex, reversing a revision 3 call: **hooks ship to BOTH harnesses, identically.** The plugin artifact is symmetric; Codex's hook-trust gate makes its hooks opt-in, and that is the user's choice, not a reason to ship a different plugin. Graceful degradation when hooks are unapproved is specified in Phase 3a item 14. Hook sources are single-sourced in `_hooks/` and copied into both trees, mirroring `_skills/` (§4, CI check 5).

> **Revision 3 (2026-08-04).** Independent review against both working trees confirmed every locally checkable claim in revision 2 (the `^0.4.1` pin, the 2.4.0 manifest, `serve.ts:783`, `server.ts:48`, the `files` allowlist, the live phantom `list_conductors` tool). Revision 3 closes four gaps: (a) the `OWENLOOP_PLUGIN_VERSION` env value is a **third copy of the version number** that release-please `linked-versions` does not bump — now covered by CI check 9 and an `extra-files` updater (§7, Phase 3a item 13); (b) the mismatch failure UX is now **specified**: strict equality, tool call fails with a message naming both versions and the remedy `owenloop setup` (§2.9); (c) Phase 7 now verifies the harness accepts a plugin version **decrease** — the live 2.4.0 must update to a 0.x number (Phase 7 item 28); (d) `owenloop doctor` now prints the detected harness CLI versions as the tripwire for Codex moving past 0.146.0 (Phase 4 item 20).

---

## 1. Current state (verified facts)

### 1.1 Repos

| Repo | Path | HEAD | Notes |
|---|---|---|---|
| `owenloop` (CLI + engine) | `~/code/owenloop/main` | `43d9503`, v0.5.0 | clean, matches `origin/main`. Globally npm-linked, so `owenloop` on PATH runs this tree. |
| `owenloop-service` (hub + driver pack) | `~/code/owenloop-service/main` | `4d28005` | matches `origin/main`. Has 4 untracked files under `docs/`. **`main` has no upstream tracking branch** — `git rev-parse @{u}` errors. |

Both are worktree layouts (`main/`, `wt/`). Per the user's standing rule, **do not develop in `main/` — cut a `dev` worktree.**

### 1.2 Where the driver pack lives today

`owenloop-service/main/packages/driver-claude-code/`:

```
marketplace/.claude-plugin/marketplace.json     ← marketplace manifest
marketplace/plugin/.claude-plugin/plugin.json   ← plugin manifest, version 2.4.0
marketplace/plugin/.mcp.json                    ← MCP server declaration
marketplace/plugin/agents/owenloop-worker.md    ← subagent, fixed tools allowlist (INV-39)
marketplace/plugin/hooks/hooks.json             ← SessionEnd hook
marketplace/plugin/hooks/session-end.sh
marketplace/plugin/skills/author/SKILL.md
marketplace/plugin/skills/conduct/SKILL.md
marketplace/plugin/skills/shift/SKILL.md
scripts/install-codex-skills.mjs                ← the hand-rolled Codex copy script to DELETE
test/plugin-shape.test.ts
test/codex-skill-install.test.ts                ← test for the script to DELETE
```

Marketplace name is `owenloop`, plugin name is `owenloop`, so the install selector is `owenloop@owenloop`.

### 1.3 How installation works today

- **Claude Code:** user manually runs `claude plugin marketplace add <local path>` then `claude plugin install owenloop@owenloop`. On this machine the marketplace is registered in `~/.claude/settings.json` under `extraKnownMarketplaces` as a `directory` source pointing at the service repo checkout.
- **Codex:** user manually runs `pnpm --filter @owenloop/driver-claude-code install:codex-skills`, which is a 25-line `copyFileSync` script that drops **only** `shift` and `conduct` `SKILL.md` into `~/.codex/skills/`. No MCP, no `author` skill.
- **`owenloop setup` installs nothing.** Its step 5 *prints* instructions. The word `codex` appears **zero times** in `src/cli.ts`.

### 1.4 The existing seam in the CLI

`~/code/owenloop/main/src/cli.ts`:

| Symbol | Line | What it is |
|---|---|---|
| `defaultRunCommand` | 228 | `spawnSync` wrapper returning `{status, stdout, stderr}` |
| `io.runCommand` | 187 (doc) | Injectable seam so tests stub shell-outs instead of spawning a real `claude` |
| `PLUGIN_CHECK_FATAL` | 3513 | `const … = false` — plugin failures never fail doctor |
| `commandOnPath(env, cmd)` | 3558 | PATH scan for an executable file |
| `probePlugin(io)` | 3766 | Returns `{claudeFound, installed}`; `installed` = `claude plugin list` stdout contains `owenloop` |
| `installPluginStep(io, state)` | 3781 | **The seam.** Prints manual instructions. Its doc comment: *"While the marketplace is unpublished this PRINTS the manual install instructions instead of shelling out — the single seam a real shell-out install would replace later. Never fails setup."* |
| setup step `[5/6] plugin` | ~3998 | Calls `probePlugin`, then either skips or calls `installPluginStep` |
| doctor check 6 | 4155–4163 | Renders the same probe as a ✓/✗ line |

Setup's six steps: `[1/6] inspect`, `[2/6] human login`, `[3/6] agent`, `[4/6] owenloop settings`, `[5/6] plugin`, `[6/6] doctor`.

**Setup's binding contracts** (from the doc comment at cli.ts:3465 and 3790) — the implementation must preserve all of these:
- **Idempotent:** a second run performs ZERO writes — no store mutation, no settings write, no browser, no mint/rekey/register POST. Each ACT is reached only through its probe failing.
- **Non-fatal plugin step:** never fails setup.
- **Secrets discipline (§6 "rule of gates"):** no code path passes a token to `io.out` / `io.err` / an `Error`.

### 1.5 The npm package

`~/code/owenloop/main/package.json`:
- `"files": ["dist", "bin", "examples/workflows", "docs", "CHANGELOG.md"]` — **anything new must be added here or it will not ship in the tarball.**
- `"bin": {"owenloop": "bin/owenloop.mjs"}`
- `bin/owenloop.mjs` is a thin shim importing `../dist/src/cli.js`.
- Build is `npm run clean && tsc -p tsconfig.build.json`; `prepack` runs build; `prepublishOnly` runs the full `check`.
- Precedent for resolving package-relative paths at runtime: `packages/work/src/shift/spawn.ts:77-78` uses `new URL('../../../../bin/owenloop.mjs', import.meta.url)` with a two-candidate fallback (source layout vs `dist/` layout).

### 1.6 The version-skew bug to fix on the way through

The plugin's `.mcp.json` currently declares:

```json
{"mcpServers": {"owenloop": {"type": "stdio", "command": "npx", "args": ["-y", "owenloop@^0.4.1", "mcp"]}}}
```

npm's caret on a `0.x` version means `>=0.4.1 <0.5.0`. Verified against the registry: published versions are `0.0.1, 0.2.0, 0.2.1, 0.3.1, 0.4.0, 0.4.1, 0.5.0`; `latest` is `0.5.0`; **`owenloop@^0.4.1` resolves to `0.4.1`**. So today the MCP server runs 0.4.1 while the CLI on PATH runs 0.5.0 — across a release that shipped breaking changes (folding `owenwork` into `owenloop work`, `binding rm` signature change, and a hub requirement for `add_label_binding`/`remove_label_binding`).

**The three artifacts on this machine right now, measured:**

| Artifact | Version | Resolved by |
|---|---|---|
| Plugin `owenloop@owenloop` | **2.4.0** | hand-edited `plugin.json` in `owenloop-service` |
| `owenloop` on PATH — used by all 3 skills and by `hooks/session-end.sh` | **0.5.0** | `npm link` of `~/code/owenloop/main` |
| MCP server | **0.4.1** | `npx -y owenloop@^0.4.1 mcp` out of the npx cache |

Diffing the MCP tool tables between 0.4.1 and 0.5.0, the live cost of the skew is:

- **missing from the running server** (exist in 0.5.0): `add_crew_member`, `create_crew`, `list_crews`, `list_shifts`, `remove_crew_member`
- **phantom on the running server** (deleted in 0.5.0): `list_conductors`

The pin was written on 2026-08-02 (commit `5a4e7c3`); 0.5.0 released 2026-08-04 (commit `43d9503`). The gap opened in 48 hours with no human error involved — it is a mechanical consequence of a pre-1.0 caret plus `bump-minor-pre-major: true` in the release-please config. Because release-please bumps the **minor** for breaking changes before 1.0, `^0.4.1` means "never cross a breaking change", which is semantically correct and operationally a permanent freeze.

Side effects also measured: `~/.npm/_npx` holds five separate owenloop installs (0.1.0, 0.2.1, 0.4.1 ×2, 0.5.0), one per historical pin; npx never garbage-collects.

**Three code defects found while measuring this. Fix them in the same branch — two are prerequisites for any version check:**

| File | Line | Defect |
|---|---|---|
| `src/mcp/serve.ts` | 783 | `serverInfo.version` is hardcoded to `'0.0.1'`. The one standard MCP field that could report the real software version reports a placeholder. |
| `src/mcp/server.ts` | 48 | `RECOGNIZED_PROTOCOL_VERSIONS` lists `'2025-11-05'`. The real MCP revision is `'2025-11-25'` — a typo. A client offering `2025-11-25` gets needlessly counter-offered `2025-06-18`. |
| `src/mcp/server.ts` | 48 | The current MCP revision is `2026-07-28`, which removed the `initialize` handshake entirely. Not urgent, but note it. |

Option B plus §2.8's launch change eliminates this class of bug: all four plugin surfaces resolve to one install.

---

## 2. Codex plugin system — verified capabilities

Probed against the installed `codex-cli 0.146.0` (`~/.local/bin/codex`) and its bundled marketplaces.

### 2.1 Commands that exist

```
codex plugin add <PLUGIN[@MARKETPLACE]> [--marketplace M] [--json]
codex plugin list
codex plugin remove
codex plugin marketplace add <SOURCE>     # local path, owner/repo[@ref], HTTPS or SSH git URL
codex plugin marketplace list
codex plugin marketplace upgrade
codex plugin marketplace remove <name>
codex mcp add <NAME> (--url <URL> | -- <COMMAND>...) [--env K=V] [--bearer-token-env-var VAR] [--oauth-client-id ID]
codex mcp list | get | remove | login | logout
```

`codex plugin list` currently shows three registered marketplaces: `openai-primary-runtime`, `openai-bundled`, `openai-curated`.

### 2.2 Layout comparison — the two systems are nearly identical

| Concern | Claude Code | Codex |
|---|---|---|
| Marketplace manifest | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` |
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| MCP declaration | `.mcp.json` at plugin root | `.mcp.json` at plugin root — **same filename** |
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` — **same layout** |
| Skill discovery | by convention | **must be declared**: `"skills": "./skills/"` |
| MCP discovery | by convention | **must be declared**: `"mcpServers": "./.mcp.json"` |
| Subagents in a plugin | `agents/*.md` | **not supported** — no `agents` key exists in the manifest parser |
| Subagents at all | `agents/*.md` (plugin or user dir) | **supported** — TOML files in `~/.codex/agents/` or `<repo>/.codex/agents/`, outside the plugin system. See §2.6 |
| Hooks in a plugin | `hooks/hooks.json` | **supported** — `hooks` key, same default path `hooks/hooks.json`. See §2.6 |
| Plugin-root placeholder in `hooks` | `${CLAUDE_PLUGIN_ROOT}` | **supported** — Codex injects `${PLUGIN_ROOT}`, `${PLUGIN_DATA}`, **and** `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` into hook commands, already in 0.146.0 |
| Plugin-root placeholder in `.mcp.json` | `${CLAUDE_PLUGIN_ROOT}` — **confirmed supported**, see §2.7 | **NOT supported on 0.146.0.** See §2.7 |

**Correction to revision 1.** The claim "Codex supports neither `agents` nor `hooks`" was derived only from inspecting which keys OpenAI's own bundled plugins happen to use. That is evidence about those plugins, not about the format. Reading the Codex Rust source at tag `rust-v0.146.0` gives the real answer, in §2.6.

Codex `plugin.json` top-level keys **actually accepted** by `RawPluginManifest` (`core-plugins/src/manifest.rs:34-57`, `rename_all = "camelCase"`, no `deny_unknown_fields`): `name`, `version`, `description`, `keywords`, `skills`, `mcpServers`, `apps`, `hooks`, `interface`, and `commands` (the last read by a separate deserializer and entirely undocumented).

Three traps in the keys observed in OpenAI's bundled manifests:
- `author`, `homepage`, `repository`, `license` are **documented and shipped by OpenAI, and silently ignored by the CLI** on this manifest path. They are not fields of `RawPluginManifest`.
- `bundledContentVariant` **does not exist anywhere in the Codex Rust source**, at `main` or at `rust-v0.146.0`. It is a ChatGPT-desktop-app concept, inert to `codex-cli`.
- OpenAI's `build-ios-apps` plugin ships an `agents/` directory containing one file, `agents/openai.yaml`, holding display metadata (`display_name`, `icon_small`, `default_prompt`). It is **not** a subagent definition and the loader never reads it. The directory name invites exactly the wrong conclusion.

### 2.3 Reference: a real Codex marketplace manifest

`~/.codex/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins/marketplace.json`:

```json
{
  "name": "openai-bundled",
  "interface": {"displayName": "OpenAI Bundled"},
  "plugins": [
    {
      "name": "computer-use",
      "source": {"source": "local", "path": "./plugins/computer-use"},
      "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
      "category": "Productivity"
    }
  ]
}
```

### 2.4 Reference: a real Codex plugin `.mcp.json`

`.../plugins/computer-use/.mcp.json`:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./bin/computer-use-client-launcher",
      "args": ["mcp"],
      "cwd": ".",
      "env_vars": ["CODEX_HOME"]
    }
  }
}
```

Note the shape differences from Claude Code's: relative `command` with `cwd: "."`, and **`env_vars` is an allowlist of environment variable *names* to pass through**, not a map of values. This matters — Codex does not give an MCP child the parent environment. The team already hit this: see the header comment in `~/code/owenloop/main/packages/work/src/harness/codex.ts`, which documents that codex hands a child only `HOME, LOGNAME, PATH, SHELL, TMPDIR, USER, __CF_USER_TEXT_ENCODING` plus `mcp_servers.<name>.env`, and that the owenloop mount died without an explicit `mountEnv`.

### 2.5 Consequence: Codex can have the `author` skill

`author` is excluded from Codex today only because Codex has no owenloop MCP server. A Codex plugin shipping `.mcp.json` removes that reason. Ship all three skills to Codex.

`author`'s frontmatter already lists both tool namespaces:
```
allowed-tools: mcp__plugin_owenloop_owenloop__create_workflow, mcp__plugin_owenloop_owenloop__start_run, mcp__owenloop__create_workflow, mcp__owenloop__start_run
```
Codex ignores `allowed-tools`, so the file is portable as-is. **Verify the tool namespace Codex actually assigns** to a plugin-provided MCP server (§6.2) — it may be neither of these two, in which case `author`'s frontmatter needs a third entry.

### 2.6 Codex hooks and subagents — corrected

Ground truth is the Codex Rust source at tag `rust-v0.146.0`, cross-checked against `main`. The plugin subsystem is byte-identical between the two for everything in this section.

#### Hooks — supported, and a plugin can declare them

**Manifest key:** `hooks`. Four accepted shapes (`RawPluginManifestHooks`, `core-plugins/src/manifest.rs:134-142`): a path string, an array of path strings, an inline object, or an array of inline objects. **When the key is absent the loader defaults to `hooks/hooks.json` under the plugin root** (`DEFAULT_HOOKS_CONFIG_FILE`, `core-plugins/src/loader.rs:66`) — the same convention Claude Code uses.

**Eleven events** (`protocol/src/protocol.rs:1499-1511`; JSON keys are PascalCase per `config/src/hook_config.rs:36-59`):

`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, **`SessionEnd`**, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`.

**File format:** event → matcher group (`matcher` regex + `hooks[]`) → handler. Handler `type` may be `command`, `prompt`, or `agent`, but **only `command` actually executes** — `prompt` and `agent` parse into empty structs and are skipped at dispatch. Command fields: `command`, `commandWindows`, `timeout`, `async`, `statusMessage`, `additionalContextLimit`.

**Two constraints that matter for owenloop's `SessionEnd` hook:**

1. **`SessionEnd` has a hard 3-second ceiling.** Its default timeout is 1s and its maximum is 3s, against a 600s default for every other event. `hooks/session-end.sh` runs `owenloop work release --session <id>`, which is a network call to the hub. Verify it completes inside 3s, or accept that the release falls back to the lease TTL under load. The Claude Code copy of the same hook declares `"timeout": 30` — that value is legal in Claude Code and will be **clamped** by Codex.
2. **Installing a plugin does not trust its hooks.** Non-managed command hooks are hash-pinned and **skipped until a human reviews them via `/hooks`**. So `owenloop setup` cannot make the Codex SessionEnd hook live on its own — the user must approve it once. `--dangerously-bypass-hook-trust` exists; **do not use it and do not tell users to.** Treat the Codex hook as opt-in, and say so in the docs.

Codex also supports hooks entirely outside the plugin system — `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, `[hooks]` in either `config.toml`, and enterprise `requirements.toml` managed hooks. Not needed here; noted so the distinction is not lost.

#### Subagents — supported by Codex, not declarable by a plugin

**A plugin cannot ship a subagent.** `PluginManifestPaths` (`plugin/src/manifest.rs:18-24`) has exactly four fields: `skills`, `mcpServers`, `apps`, `hooks`. There is no `agents` variant to deserialize into. A marketplace entry containing `"agents": [...]` survives into the synthesized fallback manifest via a `serde(flatten)` catch-all and is then **discarded** — there is a test in the Codex repo asserting exactly that (`core-plugins/src/marketplace_tests.rs:554,697`). The structural reason: plugin roots are never registered as config layers (`config/src/state.rs:210-221` registers only System/User `config.toml` parents and project `.codex` folders), and subagent roles are a config-layer concept.

**Codex supports subagents as a first-class feature, independently of plugins.** Definitions are standalone **TOML** files (`.toml` extension only, `agent_roles.rs:540`) in `~/.codex/agents/` (personal) or `<repo>/.codex/agents/` (project), or declared inline as `[agents.<name>]` in `config.toml`. An agent file is `name` + `description` + `nickname_candidates` flattened over a full `ConfigToml` (`RawAgentRoleFileToml`, `agent_roles.rs:216-222`), so it accepts any `config.toml` key: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`. `developer_instructions` is required.

**Can INV-39's allowlist be reproduced? Partially, and not the same way.** There is no `tools: [...]` field — `ToolsToml` (`config_toml.rs:632-640`) holds only `web_search`, `experimental_request_user_input`, `update_plan`. What a Codex agent role **can** pin, through its config layer:

| INV-39 requirement | Codex mechanism | Verdict |
|---|---|---|
| Allow only `submit` + `get_status` from the owenloop MCP server | `mcp_servers.owenloop.enabled_tools = ["submit", "get_status"]` | **Reproducible** |
| Deny `Edit` / `Write` | no built-in-tool allowlist; `sandbox_mode = "read-only"` is the nearest lever | **Approximate** |
| Deny `Agent` / `Task` (no nesting) | no equivalent field found | **Not reproducible** |

**Recommendation for this plan: still do not ship an `owenloop-worker` equivalent to Codex, but for a corrected reason.** The reason is no longer "Codex has no subagents". It is: (a) a plugin cannot carry one, so `owenloop setup` would have to write into `~/.codex/agents/` — a different config surface with a different idempotency story than `codex plugin add`; and (b) INV-39's no-nesting clause has no Codex enforcement mechanism, so the shipped artifact would not satisfy the invariant it is named after. `docs/drivers/codex-cli.md` already documents the governance difference; **update its wording** — the current text implies Codex lacks the capability, which is false. Revisit as separate scoped work if a Codex worker boundary is wanted.

### 2.7 Plugin-root path resolution — former open question 6.1, now resolved

**Claude Code: `${CLAUDE_PLUGIN_ROOT}` IS expanded inside `.mcp.json`.** Documented at <https://code.claude.com/docs/en/plugins-reference> with a worked example, and the substitution table names the fields: for `stdio` servers `command`, `args`, and `env`; for `http`/`sse`/`ws` servers `url`, `headers`, `headersHelper`. `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` expand in the same places.

**Codex 0.146.0: no placeholder in `.mcp.json`, but `cwd` is plugin-relative.** On the `.codex-plugin/plugin.json` + `.mcp.json` path (parser: `codex-mcp/src/plugin_config.rs`):

- `${PLUGIN_ROOT}` is **not** expanded in `command`, `args`, or `env`.
- `cwd` **is** rewritten: `normalize_plugin_mcp_server_value` joins any non-absolute `cwd` onto the plugin root (`plugin_config.rs:280-289`). This is the only path rewriting performed.
- `command` is **never** rewritten. It goes to `Command::new()` with `.current_dir(cwd)`. A bare name is a PATH lookup; a relative path resolves against `cwd`.
- **If `cwd` is omitted it falls back to the session working directory, not the plugin root** (`stdio_server_launcher.rs:269`). To launch a bundled file on 0.146.0 you must set `cwd` explicitly.

**A second Codex manifest format exists and behaves differently — do not confuse the two.** The "Agent Plugins" format (root-level `plugin.json` with `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, and `mcp.json` without the leading dot) **does** expand `${PLUGIN_ROOT}` and **does** default `cwd` to the plugin root. Its parser, `codex-mcp/src/agent_plugin_config.rs`, is 532 lines that **do not exist at tag `rust-v0.146.0`** — it landed after. The published Codex docs describe this format's behavior without flagging the split, which is the single most likely thing to mislead an implementer. **This plan targets the `.codex-plugin/plugin.json` format on 0.146.0.**

### 2.8 MCP launch form — revision 1's preference is REVERSED

Revision 1 preferred `command: "node", args: ["<bundled>/bin/owenloop.mjs", "mcp"]` on the grounds that it makes skew structurally impossible. That reasoning was incomplete.

**The plugin has four surfaces, and three of them already resolve `owenloop` from PATH:** `skills/conduct/SKILL.md`, `skills/shift/SKILL.md`, and `skills/author/SKILL.md` shell out to bare `owenloop` via Bash; `hooks/session-end.sh` does `command -v owenloop`. Only the MCP server bypasses PATH. Pinning the MCP server to a plugin-bundled binary does not remove a version axis — it **moves** it, from `MCP vs PATH-CLI` to `bundled-MCP vs PATH-CLI-used-by-skills-and-hook`. Same number of versions, differently paired.

**Use `command: "owenloop", args: ["mcp"]` in both plugins.** One install serves all four surfaces. Supporting evidence:

- Of the 278 plugins in Anthropic's official marketplace, **zero** pin an npx MCP server to a semver range. The owenloop config is unique in that corpus.
- The CLI-subcommand form is what GitLab (`glab mcp serve`), Docker (`docker mcp gateway run`), Railway, Heroku (`heroku mcp:start`), Azure (`azd mcp start`), Fly (`flyctl mcp server`), and SurrealDB all publish.
- Heroku documents the reason directly, and it applies verbatim to owenloop: the subcommand form *"uses your existing Heroku CLI authentication and doesn't require exposing your API key"*, unlike their `npx` alternative. owenloop's MCP server and CLI already share a file-locked credential store written by `owenloop setup`. Two different owenloop versions holding a lock on one unversioned credential file is a hazard this change removes.
- It is also the only form portable to Codex, whose `.mcp.json` has no plugin-root placeholder on 0.146.0.

**This is not free — it introduces two loud failure modes**, both closed by the version check in §2.9:

| Failure | Symptom |
|---|---|
| `owenloop` not on PATH | Harness reports the server failed to start. |
| `owenloop` on PATH but too old to have `mcp` | Opaque unknown-subcommand error. Railway shipped exactly this trap when it moved its MCP server into its CLI. |

Both are diagnosable, unlike today's silent five-missing-tools drift.

### 2.9 The version check — where it goes and how strict

MCP itself cannot solve this. The protocol negotiates a `YYYY-MM-DD` grammar revision, not software versions, and the current spec revision states outright that `serverInfo` and `clientInfo` *"are self-reported by the sender and are not verified by the protocol… Implementations SHOULD NOT use them to change the behavior of the client or server"*. Neither the TypeScript nor the Python MCP SDK contains a single line that reads `clientInfo.version` to gate behavior; both accessors are `@deprecated` in the v2 SDK. **A companion-binary version gate must be written by hand, outside MCP.**

Two placements, both worth having:

1. **A `SessionStart` hook** — Claude Code supports it; Codex supports it (see §2.6) subject to the hook-trust gate. The hook sends an MCP `initialize` request to `owenloop mcp` with a non-routable probe origin and reads `serverInfo.version`, because the root CLI has no supported `--version` flag. The hook compares that version to the plugin's own version and prints an actionable message on mismatch, a missing CLI, or an unparseable response. The hook catches "CLI missing" and "CLI too old" before any tool call and before the transport can fail opaquely. Before this change the plugin shipped **only** `SessionEnd`; this adds a new `SessionStart` hook with a different purpose.
2. **A check inside the MCP tool handlers.** Netlify's MCP server documents the reasoning in `src/utils/compatibility.ts`: *"It's best to run these in the tool calls so that it will inform the agent about compatibility issues. Bailing on start up hides the issue."* An early `process.exit` surfaces to the user as "server transport closed unexpectedly" with the real message buried in stderr; a throw inside a tool call puts a readable message in front of both the model and the human.

**Strictness:** model it on esbuild, which solves the identical shape (a JS host over stdio to a separately-installed binary). esbuild does **strict equality**, not a range — `if (binaryVersion !== "0.27.7") throw` — because host and binary share a private wire format where a mismatch corrupts rather than errors cleanly. Prisma does the softer warn-only version and has an open, unanswered request to make it an error. **For owenloop: strict equality on anything sharing the credential store's private format; a range is acceptable for tool-surface differences only.**

**Decided in revision 3 — the in-tool check uses strict equality, and the failure UX is part of the spec.** The thrown message must name both versions and the single remedy, e.g.: `owenloop plugin 0.6.0 does not match owenloop CLI 0.5.0. Run: owenloop setup`. This creates one known scenario, and it is intended: a user runs `npm i -g owenloop@<new>`, then opens a harness session **without** re-running `owenloop setup`. The harness's plugin cache still holds the old plugin version, so every owenloop MCP tool call fails with that message until `owenloop setup` runs once. A loud stop with a one-line fix replaces today's silent drift; the `SessionStart` hook (item 12) surfaces the same message before the first tool call on harnesses where the hook is trusted.

Prerequisite: `src/mcp/serve.ts:783` must stop hardcoding `serverInfo.version` to `'0.0.1'` before any of this can report a real number (§1.6).

---

## 3. Decision required before coding: where do the plugin sources live?

### 3.1 First, name the three things called "MCP" — only one of them moves

Precision here matters because "the MCP" is three distinct artifacts in this system, in two different repos, and only one is misplaced.

| # | Artifact | What it is | Repo today | Correct home |
|---|---|---|---|---|
| **1** | Hub MCP endpoint | The **server-side** HTTPS endpoint `api.owenloop.com/mcp`, a Cloudflare Worker route in `apps/hub-edge`. Serves browser surfaces (claude.ai, phone) and the headless bearer-token path. | `owenloop-service` | `owenloop-service`. **Correct. Does not move.** |
| **2** | Local stdio MCP server | The **client-side** process launched by `owenloop mcp`. Compiled from `src/mcp/serve.ts` into `dist/`, shipped in the `owenloop` npm package. Translates MCP tool calls into HTTPS calls to artifact #1. | `owenloop` | `owenloop`. **Correct. Does not move.** |
| **3** | The `.mcp.json` pointer | ~8 lines of JSON telling a harness *how to launch* artifact #2. Contains no logic. | `owenloop-service`, inside the plugin | **`owenloop`. This is the misplaced file.** |

**So yes — this is entirely about the client side, and specifically about a pointer file, not about server code.** Artifact #3 is a launch instruction for artifact #2, and it lives in a different repo from the thing it launches, with no build step or CI check connecting them. That gap is the whole bug: the pointer said `^0.4.1` while the target shipped 0.5.0, and nothing anywhere could notice.

Everything shipped alongside artifact #3 in the plugin — the three `SKILL.md` files, `hooks/session-end.sh`, `agents/owenloop-worker.md` — has the same property: each is text that invokes the `owenloop` CLI, versioned separately from the CLI it invokes.

### 3.2 The narrow move, and the monorepo question, are two separate decisions

Your instinct that this should be a monorepo is worth taking seriously, but it is a *different and larger* decision than the one this plan needs. Keeping them separate lets the bug get fixed now without blocking on the bigger call.

**Decision A — move the driver pack from `owenloop-service` into `owenloop`.** Small, mechanical, reversible. ~10 files, no build-system change: both the pack's destination and the `owenloop` package are already npm-workspaces + `node:test`. The one real cost is porting `test/plugin-shape.test.ts` from Vitest to `node:test`. This is the decision this plan needs.

**Decision B — merge `owenloop` and `owenloop-service` into one monorepo.** Large, and independent of A. Nothing in this plan requires it.

The argument that settles Decision A on its own, without touching B: **an artifact belongs in the repo that builds the thing it points at.** The plugin points at the `owenloop` CLI. Every surface it ships invokes that CLI. It belongs with the CLI. The hub Worker, the console SPA, the Durable Objects — none of them are invoked by the plugin, and none of them move.

### 3.3 What Decision B would actually cost, if you want it

Measured against both working trees, so the call is made on facts rather than vibes:

| Concern | `owenloop` | `owenloop-service` | Merge cost |
|---|---|---|---|
| Package manager | npm workspaces (`"workspaces": ["packages/work"]`) | **pnpm 10.11.0** (`packageManager` pinned, `pnpm-workspace.yaml`, `onlyBuiltDependencies` for esbuild/sharp/workerd) | **Real.** One must convert. pnpm is the more capable of the two and `owenloop-service` depends on its `onlyBuiltDependencies` behavior for native builds; converting `owenloop` to pnpm is the lower-risk direction. |
| Task runner | plain npm scripts (`npm run check` = typecheck + lint + build + test) | **Turbo** (`turbo.json`, `dependsOn: ["^build"]`, `outputs: ["dist/**"]`) | Moderate. `owenloop`'s scripts become Turbo tasks. |
| Test runner | `node:test` | **Vitest 3**, plus `@cloudflare/vitest-pool-workers` running inside real `workerd` | **Two runners coexist indefinitely.** The Workers tests cannot move to `node:test` — they need workerd. Turbo runs both fine, but the repo permanently has two. |
| Release tooling | **release-please** (`.release-please-manifest.json`), publishes to npm with a tag-equals-version gate | none — nothing is published | Low. release-please's manifest mode handles a repo where only some packages publish. |
| Deploy target | npm registry | Cloudflare (Workers, DOs, R2, wrangler) | Low — different `deploy` tasks, no conflict. |
| CI | npm-publish workflow with release gates | `.dev/checks.sh` | Moderate. Merge into one Turbo-driven pipeline. |

**Recommendation: do Decision A now, and treat Decision B as separate scoped work.** Decision A is a prerequisite for the CI enforcement in §9 (release-please's `linked-versions` plugin operates within one repo's manifest — it cannot link a version across two repositories, so no amount of CI fixes this while the pack stays put). Decision B buys convergence and a single `pnpm install`, but it buys nothing this plan needs, and the pnpm/npm and Vitest/`node:test` reconciliations are best done deliberately rather than as a side effect of a bug fix.

**Sign-off received:** Alex approved Decision A on 2026-08-04 (see STATUS block at the top), with immediate deletion of the old pack. Decision B is deferred. No further approval is needed to execute this plan.

---

## 4. Target layout

Inside the `owenloop` repo:

```
plugins/                                            ← NEW top-level dir, added to package.json "files"
  claude-code/
    .claude-plugin/marketplace.json
    plugin/
      .claude-plugin/plugin.json
      .mcp.json
      agents/owenloop-worker.md
      hooks/   → built from ../../_hooks/
      skills/  → built from ../../_skills/
  codex/
    .agents/plugins/marketplace.json
    plugins/owenloop/
      .codex-plugin/plugin.json
      .mcp.json
      hooks/   → built from ../../../_hooks/         ← revision 4: Codex ships the same hooks
      skills/  → built from ../../../_skills/
  _skills/                                          ← SINGLE SOURCE OF TRUTH
    author/SKILL.md
    conduct/SKILL.md
    shift/SKILL.md
  _hooks/                                           ← SINGLE SOURCE OF TRUTH (revision 4)
    hooks.json
    session-end.sh
    session-start.sh
```

**On the `_skills` → `skills` relationship:** prefer a build step that copies `_skills/` into both plugin trees, with a test asserting byte-equality, over symlinks. npm tarballs and Windows handle symlinks inconsistently, and a copy keeps each shipped plugin tree self-contained. If the copy is generated, either commit the output (and test that it is current) or generate it in `prepack` — pick one and make the test enforce it.

Note both plugin trees are already directly consumable as marketplaces (`plugins/claude-code` and `plugins/codex` are the two marketplace roots).

---

## 5. Work breakdown

### Phase 1 — Move the pack into `owenloop`

1. Cut a worktree: `dev` worktree off `owenloop`, not `main/`.
2. Copy the pack out of `owenloop-service/main/packages/driver-claude-code/marketplace/plugin/` into the §4 layout, respecting the single-source rule: `skills/*` → `plugins/_skills/`, `hooks/*` → `plugins/_hooks/` (revision 4), `agents/owenloop-worker.md` → the Claude Code tree only, manifests → their per-harness locations. Then add the build/copy step that materializes `_skills/` and `_hooks/` into both plugin trees, with the byte-equality test (CI check 5) enforcing it.
3. Add `"plugins"` to `package.json` `files`.
4. Verify inclusion: `npm pack --dry-run` and confirm every plugin file is listed.
5. Port `test/plugin-shape.test.ts` into the `owenloop` repo's test suite (it uses Vitest; `owenloop` uses `node --test` — port the assertions to `node:test`; do not add Vitest to a package that has no test runner conflict today). Then, in `owenloop-service`, delete `packages/driver-claude-code/` — including its pnpm workspace entry, the `install:codex-skills` script, and `test/codex-skill-install.test.ts` — and leave a README stub pointing at the new home. **Sign-off note (2026-08-04): Alex approved deleting immediately rather than waiting for Phase 7 verification — the old pack has no users, so the "plugin in neither repo" window is harmless.** The `owenloop-service` change is still a separate commit/PR in that repo, in its own `dev` worktree.

### Phase 2 — Author the Codex plugin tree

6. Write `plugins/codex/.agents/plugins/marketplace.json` following §2.3, with one plugin entry named `owenloop`, `source: {"source": "local", "path": "./plugins/owenloop"}`, `policy: {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}`, and an appropriate `category`.
7. Write `plugins/codex/plugins/owenloop/.codex-plugin/plugin.json`. Must include `"skills": "./skills/"` and `"mcpServers": "./.mcp.json"` — Codex will not discover either by convention. Keep `name`/`version` in lockstep with the Claude Code plugin manifest and with the npm package version (see Phase 5).
8. Write `plugins/codex/plugins/owenloop/.mcp.json` per §6.1's resolved answer, including an `env_vars` allowlist. Start from `["HOME", "PATH", "XDG_CONFIG_HOME"]` — `HOME`/`XDG_CONFIG_HOME` are what `owenloopSettingsPath` (`src/work-settings.ts:36-42`) reads to find `settings.json`, and the credential store lives alongside it. **Verify empirically** that the spawned server can read credentials; a silent empty-credential read is the failure mode.

### Phase 3 — Kill the npx pin

9. Change **both** plugins' `.mcp.json` to launch the PATH CLI, per §2.8. Exact contents:

    **`plugins/claude-code/plugin/.mcp.json`:**
    ```json
    {"mcpServers": {"owenloop": {"type": "stdio", "command": "owenloop", "args": ["mcp"]}}}
    ```

    **`plugins/codex/plugins/owenloop/.mcp.json`:**
    ```json
    {"mcpServers": {"owenloop": {"command": "owenloop", "args": ["mcp"], "env_vars": ["HOME", "PATH", "XDG_CONFIG_HOME"]}}}
    ```
    No `cwd` is needed on the Codex side because `command` is a bare name and therefore a PATH lookup, not a relative path (§2.7). `env_vars` is required because Codex hands an MCP child only `HOME, LOGNAME, PATH, SHELL, TMPDIR, USER, __CF_USER_TEXT_ENCODING` plus whatever the entry allowlists; `HOME` and `XDG_CONFIG_HOME` are what `owenloopSettingsPath` (`src/work-settings.ts:36-42`) reads to find `settings.json`, and the credential store sits alongside it. `HOME` and `PATH` are already in the default set — listing them is harmless and documents the dependency. **Verify empirically that the spawned server reads real credentials; a silent empty-credential read is the failure mode**, and it is exactly the class of bug the `packages/work/src/harness/codex.ts` header comment records the team hitting before.

10. Add a test asserting no `.mcp.json` in the repo contains the string `npx` or a version range — this bug must not come back.
11. **Fix the three MCP defects from §1.6 in this phase**, since two of them are prerequisites for Phase 4a: `src/mcp/serve.ts:783` must report the real package version instead of `'0.0.1'`; `src/mcp/server.ts:48` must list `'2025-11-25'` instead of the typo `'2025-11-05'`.

### Phase 3a — The compatibility check (new; see §2.9)

12. Add a `SessionStart` hook to **both plugin trees** (revision 4). The hook sends an MCP `initialize` request to `owenloop mcp` with a non-routable probe origin and reads `serverInfo.version`; it cannot use `owenloop --version` because the root CLI has no supported `--version` flag. It compares the returned version against the plugin's own version and prints an actionable message on mismatch, on the binary being absent, or when the response cannot be parsed. On Codex the hook runs only after the user approves it via `/hooks` (item 14); on Claude Code it runs after install with no extra step. It must never block session start. Its non-redundant value over the in-tool check: when `owenloop` is missing from PATH or too old to have the `mcp` subcommand, the MCP server never starts, no tool call ever happens, and this hook is the only surface that can print a useful remedy. Before this change the Claude Code pack shipped only `SessionEnd`; this is a new `SessionStart` hook with a different purpose, not a revival.
13. Add a version assertion inside the MCP tool handlers, not at server startup, per Netlify's documented reasoning in §2.9. Pass the expected version to the server via `env` in `.mcp.json` (for example `OWENLOOP_PLUGIN_VERSION`), and compare against the server's own package version. **Revision 3 warning: that env value is a third copy of the version number, embedded as a literal string in both `.mcp.json` files, and release-please's `linked-versions` plugin does not rewrite env values inside `.mcp.json`.** Cover it two ways: CI check 9 (§7) asserts both env values equal `package.json` `version`, and the release config gets a generic `extra-files` updater for both `.mcp.json` files so one release commit bumps all copies. Fallback if the updater proves awkward: derive the expected version by reading `plugin.json` via `${CLAUDE_PLUGIN_ROOT}` — but that placeholder does not exist in Codex 0.146.0's `.mcp.json` handling (§2.7), so the env-plus-updater approach is the default for both harnesses.
14. **Revision 4 decision (reverses revision 3): both plugins ship the same hooks — the Codex hooks are opt-in by Codex's own trust gate, and unapproved hooks must degrade gracefully.** Codex hash-pins a plugin's hooks and skips them until the user reviews them via `/hooks` (§2.6). We do not fight that gate; we ship the hooks and define what happens either way:
    - **User never runs `/hooks` (the default state):** Codex silently skips the hooks. Skills and MCP tools work fully. The two losses have fallbacks — a missed `SessionEnd` release falls back to the lease TTL, and a version mismatch is caught by the always-on in-tool check (item 13). No error, no prompt, no degraded session. This graceful path is structural; nothing extra needs to be built, only verified (Phase 7).
    - **User runs `/hooks` and approves:** both hooks go live, same behavior as Claude Code, subject to the `SessionEnd` 3s clamp (item 15).
    - **Discoverability, not nagging:** setup ends by printing one copy-pasteable line, clearly marked optional: "Optional: to enable owenloop's Codex hooks, run `codex`, type `/hooks`, and approve the two owenloop hooks. Everything else already works." Phase 7 tests two refinements: whether `codex "/hooks"` as the initial PROMPT argument opens the approval screen (if yes, the hint becomes that single command), and whether the hook-trust state under `~/.codex/` is readable (if yes, `owenloop doctor` gets a read-only line "codex hooks: pending approval (optional)").
    - **`--dangerously-bypass-hook-trust` — verified scope (revision 4).** The flag is real (OpenAI hooks docs; present in `codex --help` on 0.146.0) but it is a flag on the main `codex` invocation, NOT on `codex plugin add` (verified: no trust flag there), and it is per-invocation — it "run[s] enabled hooks without requiring persisted hook trust for this invocation" and never writes trust. Consequences: (a) `owenloop setup` cannot use it — wrong command, and there is no trust state it could set; (b) for interactive users it is strictly worse than the one-time `/hooks` approval (retyped every launch, skips review) — never recommend it to them; (c) its one legitimate use is headless/CI automation the user owns, which OpenAI scopes to "automation that already vets hook sources" — mention it only in the headless/CI section of `docs/drivers/codex-cli.md` (Phase 8 item 31), with that vetting caveat attached. Setup never launches Codex or prompts interactively for hook trust — no `codex hooks` subcommand exists (verified on 0.146.0), and an interactive setup breaks scripts/CI.
15. **Codex caveat on `SessionEnd`:** its timeout ceiling is 3s (default 1s), against 600s for other events. `hooks/session-end.sh` makes a network call to the hub. Either confirm it completes inside 3s, or accept the lease-TTL fallback — and verify in Phase 7 that a clamp-kill is silent (no error spew in the Codex session). The Claude Code copy's `"timeout": 30` is legal in both harnesses; Codex clamps it.

### Phase 4 — Rewrite the CLI's plugin step

All in `~/code/owenloop/main/src/cli.ts`.

16. **Add a self-path resolver** for the bundled marketplace roots. Follow the `spawn.ts:77-78` precedent: try candidates via `new URL(..., import.meta.url)` to cover both the source layout (`src/cli.ts`) and the shipped layout (`dist/src/cli.js`), and `existsSync`-check each. Return `null` when not found rather than throwing — a missing bundle must degrade to printing instructions, not crash setup.
17. **Generalize `probePlugin`** (line 3766) from Claude-only to a per-harness probe, and make it **version-aware**, not presence-aware. This is a change from revision 1 and it is load-bearing — see the note below. Suggested shape:
    ```ts
    interface HarnessPluginState {
      id: 'claude-code' | 'codex';
      cliName: string;          // 'claude' | 'codex'
      cliFound: boolean;
      installedVersion: string | null;   // null = not installed
    }
    ```
    - Claude Code: `claude plugin list`, parse the installed `owenloop` entry's version
    - Codex: `codex plugin list`, same
    Both go through `io.runCommand ?? defaultRunCommand` so tests can stub them. Both must tolerate a non-zero exit and a thrown spawn error by reporting `installedVersion: null` — the existing `try/catch` does this; keep it. **If a version cannot be parsed from either CLI's output, treat the value as unknown and fall back to presence-only behavior rather than reinstalling on every run** — reinstalling on every run would break the zero-writes contract.

    **Why version-aware.** `claude plugin install` copies the plugin into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. After `npm i -g owenloop@0.6.0`, that cache still holds 0.5.0 until an update runs. Claude Code decides "this is a new version" by comparing the `version` field in `plugin.json` (documented resolution order: `plugin.json` version → marketplace-entry version → source git SHA). Since Phase 5 makes `plugin.json` version equal the npm package version, a presence-only probe would report "installed" forever and the shipped plugin would silently lag the CLI — reintroducing, in a new place, the exact bug this plan exists to kill.
18. **Replace `installPluginStep`** (line 3781) with a real shell-out, per harness. Both CLIs are confirmed non-interactive — see §6.
    - **Fresh install, Claude Code:** `claude plugin marketplace add <bundledRoot>` then `claude plugin install owenloop@owenloop`
    - **Fresh install, Codex:** `codex plugin marketplace add <bundledRoot>` then `codex plugin add owenloop@owenloop`
    - **Upgrade path** (installed version ≠ package version): re-point the marketplace at the current bundled root, then update. Determine the exact update verb empirically — `claude plugin update` exists; Codex's is `codex plugin marketplace upgrade`.

    Rules:
    - Only act when the harness CLI is on PATH **and** the probe says either not-installed or version-mismatched. Preserves the zero-writes-on-second-run contract.
    - Never fail setup. A non-zero exit is reported on `io.err` and recorded as `noted`, not `done`.
    - When the bundled marketplace root cannot be resolved, fall back to today's print-instructions behavior.
    - Marketplace re-add is safe on both CLIs but has a Codex side effect — see §6.3.
19. **Update setup step 5** (~line 3998) to iterate harnesses and push one `SetupStep` per harness (`step: 'plugin (claude-code)'` / `'plugin (codex)'`), keeping `action` in the existing `skipped | done | noted` vocabulary. Update the `[5/6]` banner text if the step now covers two harnesses.
20. **Update doctor check 6** (lines 4155–4163) to render one line per harness, and to show the installed plugin version against the CLI version so a skew is visible at a glance. Keep `PLUGIN_CHECK_FATAL = false` — do not make a missing harness fail doctor; a user with only one harness installed is a normal, healthy state. Replace the hardcoded remedy string, which currently names only the Claude commands. **Revision 3: also print the detected harness CLI versions (`claude --version`, `codex --version`) on those doctor lines.** The Codex integration targets the `.codex-plugin/plugin.json` format as parsed by codex-cli 0.146.0, Codex releases fast, and a newer "Agent Plugins" format already exists (§2.7). The doctor line is the cheap tripwire: when a user's Codex has moved far past 0.146.0 and the plugin misbehaves, the Codex version is on screen instead of buried.
21. Consider a `--harness <claude-code|codex|all>` flag and/or `--skip-plugins` on `setup` for users who want to opt out. Nice-to-have; do not block on it.

### Phase 5 — Version lockstep

22. Make the plugin manifests' `version` match the npm package version. Options: generate the two `plugin.json` files at build time from `package.json`, or keep them static and add a test asserting equality. **A test is simpler and catches the drift at CI time — prefer it.** This is §7 checks 1–2.
23. Wire the version bump into the existing release-please flow using the `linked-versions` plugin, so a release updates all three in one commit — exact config in §7. The repo already uses release-please (`.release-please-manifest.json`; HEAD `43d9503` is a `chore(main): release 0.5.0` commit).

### Phase 6 — Tests

24. Port/extend the shape tests to cover all nine CI checks in §7.
25. New unit tests for the CLI, using the `io.runCommand` stub — no real `claude`/`codex` spawns in CI:
    - Neither CLI on PATH → both recorded `noted`, zero commands run, setup still exits per doctor's core.
    - `claude` present + plugin installed **at the matching version** → `skipped`, **zero commands run** (the idempotence contract).
    - `claude` present + plugin installed **at an older version** → the update commands run, `done`.
    - `claude` present + not installed → exactly the two expected commands, in order, `done`.
    - Same three cases for `codex`.
    - `codex` present + marketplace already registered at the same source → the marketplace add is **skipped** (§6.3's write side effect).
    - `claude` present, `codex` absent → only Claude commands run.
    - Install command exits non-zero → recorded `noted`, setup still exits 0 on core.
    - Bundled marketplace root unresolvable → falls back to printed instructions.
    - Plugin version unparseable from CLI output → falls back to presence-only, does **not** reinstall.
26. Assert no token ever reaches `io.out`/`io.err` in the new paths (secrets discipline).
27. Run the full gate: `npm run check` (typecheck + lint + build + tests).

### Phase 7 — Manual verification (cannot be automated; do it before release)

28. `npm pack`, install the tarball globally in a scratch environment, run `owenloop setup`, and confirm on a machine with **both** harnesses:
    - `claude plugin list` shows owenloop installed
    - `codex plugin list` shows owenloop installed
    - a fresh `claude` session exposes the three skills and the MCP tools
    - a fresh `codex` session exposes the three skills and the MCP tools
    - `owenloop setup` run a second time performs zero writes and reports both steps `skipped`
    - **Downgrade acceptance (revision 3).** On a machine with the legacy plugin 2.4.0 installed (Alex's machine is one), confirm the update path actually installs the new, numerically *lower* plugin version (2.4.0 → 0.x). The version-aware probe (Phase 4 item 17) treats any inequality as a mismatch, but the harness's own update command must accept a decrease. If `claude plugin update` refuses to go backwards, the migration steps in Phase 8 item 33 (remove the old marketplace, re-add, reinstall) become the **required** upgrade path for pre-existing installs, not an optional note.
    - **§6.4:** whether `codex plugin add` implies enable, or a third command is needed
    - **§6.2:** the tool namespace Codex assigns the plugin's MCP server, via `codex mcp list`. If it matches neither namespace in `author`'s `allowed-tools`, add a third entry.
    - **Unapproved-hooks graceful path (revision 4, item 14):** with the plugin installed and `/hooks` never run, confirm a Codex session works fully — skills present, MCP tools callable, and no hook-related error or prompt anywhere.
    - **Approved-hooks path (revision 4):** run `/hooks` in Codex, approve both owenloop hooks, and confirm they fire; confirm a `SessionEnd` kill at the 3s clamp is silent (item 15).
    - **Hook-approval shortcut (revision 4, needs a real TTY):** does `codex "/hooks"` open the hooks approval screen, or does it send `/hooks` to the model as a prompt? If it opens the screen, setup's printed hint becomes that single command.
    - **Hook-trust state readability (revision 4):** find where Codex records hook approval (somewhere under `~/.codex/`), and whether it is stable enough to read. If yes, add the read-only doctor line "codex hooks: pending approval (optional)". Read-only — doctor must never write or bypass the trust gate.
    - **The credential read.** Confirm the Codex-spawned MCP server reads real credentials, not an empty slot — the `env_vars` allowlist is the thing being tested.
29. Record the result in a runbook alongside `docs/runbooks/claude-code-driver-check.md`. Note that `docs/drivers/codex-cli.md` currently opens with a disclaimer that its Codex guidance is unverified against a live install — **this phase is the work that lets that disclaimer be removed.** Remove it only if the verification actually passes.

### Phase 8 — Docs and migration

30. Rewrite `packages/driver-claude-code/README.md`'s successor: new install story is `npm i -g owenloop && owenloop setup`. Delete the manual `claude plugin marketplace add` instructions and the entire "Install skills for Codex" section. Its current line *"The plugin ships no CLI — its single `owenloop` MCP pin is an npx-launched stdio server, not the `owenloop` executable on `PATH`"* becomes exactly backwards and must be rewritten.
31. Rewrite `docs/drivers/codex-cli.md`: Codex now installs a real plugin. Delete the `pnpm --filter … install:codex-skills` instructions and the hand-written `config.toml` snippet (keep a short note that `codex mcp add` remains available for headless/CI, mirroring the Claude Code headless section). **Correct the governance-difference section:** it currently reads *"Codex has no equivalent isolated worker boundary in this driver"* in a context implying Codex lacks the capability. The accurate statement is that Codex supports subagents via `~/.codex/agents/*.toml` but a plugin cannot declare one, and INV-39's no-nesting clause has no Codex enforcement mechanism — so owenloop ships no Codex worker by choice. See §2.6.
32. Update `docs/drivers/README.md`'s Codex bullet — it currently says "a `config.toml` MCP snippet + an `AGENTS.md` driver section", which becomes wrong.
33. **Migration note for existing installs (Alex's machine is one).** His `~/.claude/settings.json` has an `extraKnownMarketplaces` entry pointing at the old service-repo directory, and `~/.codex/skills/{shift,conduct}` may hold stale hand-copied files. Ship a short migration section: remove the old marketplace (`claude plugin marketplace remove owenloop`), delete the stale Codex skill dirs, then run `owenloop setup`. Consider having setup detect and warn about a stale directory-source marketplace — **warn only, never auto-remove another tool's config.**

---

## 6. Former open questions — now resolved from spec and source

Revision 1 listed five questions as "must be resolved empirically". Four are now answered from the official Claude Code documentation and the Codex Rust source. Only 6.4 still needs an experiment.

**6.1 — Plugin-root path resolution. RESOLVED.** Moved to §2.7. Claude Code expands `${CLAUDE_PLUGIN_ROOT}` inside `.mcp.json` (documented, with the exact field list). Codex 0.146.0 does not, on the `.codex-plugin/plugin.json` path, but rewrites a relative `cwd` onto the plugin root. **Moot for this plan anyway**, since §2.8 reverses the decision to `command: "owenloop"` — no plugin-relative path is used in either `.mcp.json`.

**6.2 — Tool namespace for a plugin-provided MCP server. RESOLVED for Claude Code; still open for Codex.**
Claude Code's convention is documented and stable: `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`, with any character outside `A-Za-z0-9_-` replaced by `_`. The docs state this name is what belongs in permission rules, skill `allowed-tools` frontmatter, subagent `tools` fields, and hook matchers, and warn that *"a matcher written against the bare server key never fires."* So `author`'s existing `mcp__plugin_owenloop_owenloop__*` entries are correct and stable for Claude Code.
Codex's namespacing for a plugin-provided server was not established from source. **Still needs `codex mcp list` against a real install.** If it differs from both namespaces already in `author`'s frontmatter, add a third entry.

**6.3 — Marketplace-add idempotency. RESOLVED, with one caveat to handle.**
*Claude Code:* documented — *"adding a second marketplace with the same name replaces the first."* Re-adding is safe.
*Codex:* conditional. Identical source + ref + sparse paths returns `already_added: true` with no re-clone — safe to re-run. Same name with a **different** source is a hard error ("already added from a different source; remove it before adding this source"). **Caveat:** even the no-op path calls `record_added_marketplace_entry`, which replaces the entire `[marketplaces.<name>]` TOML table — bumping `last_updated` and silently dropping any `last_revision` written by a previous `marketplace upgrade`. That is a write. **To honor the zero-writes-on-second-run contract, the Codex path must probe `codex plugin marketplace list` first and skip the add when the marketplace is already registered at the same source.**

**6.4 — Does Codex need a separate enable after `codex plugin add`? STILL OPEN.**
`codex plugin list` renders a `STATUS` column showing `installed, enabled` vs `not installed`. Not settled from source. If `add` does not imply enable, the install step needs a third command. **Resolve by experiment in Phase 7.**

**6.5 — Non-interactive install. RESOLVED. Both CLIs are non-interactive; no flag is needed.**
*Claude Code:* documented — *"To install without an interactive step, use the `claude plugin install` shell command."* The in-session `/plugin install` opens a scope dialog; the shell command does not. Flags: `-s, --scope <user|project|local>` (default `user`), `--config <key=value>`.
*Codex:* `codex plugin add` takes exactly three arguments — positional `PLUGIN[@MARKETPLACE]`, `--marketplace/-m`, `--json`. `--yes`, `-y`, `--force`, `--trust`, `--non-interactive`, `--scope` **do not exist**. `run_plugin_add` goes straight from argument parsing to `install_plugin()`; neither `dialoguer` nor `inquire` is a dependency of the crates involved, and the only stdin reference in the install path is `.stdin(Stdio::null())` on spawned `git` processes. There is nothing to suppress.
**Note where Codex does place a consent gate**, since it is not on install: the *model* asking to install a plugin (the `request_plugin_install` tool) requires explicit user approval, and a plugin's **hooks** require trust review before they run (§2.6). A human at a shell installing a plugin is never prompted.

---

## 7. What CI enforces once the pack lives in `owenloop`

This section answers the question directly: **once Decision A (§3.2) is done, the version-coupling problems become CI checks.** They cannot be CI checks before it, because release-please's `linked-versions` plugin — and every comparable tool — operates within a single repository's manifest. No CI job can link a version across two repos.

**Checks CI can enforce (all cheap, all in `npm run check`):**

| # | Check | Catches |
|---|---|---|
| 1 | `plugins/claude-code/plugin/.claude-plugin/plugin.json` `version` == `package.json` `version` | The 2.4.0-vs-0.5.0 skew |
| 2 | `plugins/codex/plugins/owenloop/.codex-plugin/plugin.json` `version` == `package.json` `version` | Same, Codex side |
| 3 | No `.mcp.json` in the repo contains `npx`, `@^`, `@~`, or any version range | The `^0.4.1` bug returning |
| 4 | `npm pack --dry-run` output includes every file under `plugins/` | The pack silently not shipping — the `files` array is an allowlist |
| 5 | `_skills/*/SKILL.md` and `_hooks/*` are byte-identical to both shipped `skills/` and `hooks/` copies | Skill or hook files drifting between harnesses (revision 4 adds hooks) |
| 6 | `agents/owenloop-worker.md` `tools:` list equals the INV-39 set exactly | Governance drift |
| 7 | No `.mcp.json` contains a credential-shaped string | Secret leak |
| 8 | Both marketplace manifests parse and their plugin `name` matches the selector `owenloop@owenloop` | Broken install selector |
| 9 | Both `.mcp.json` files' `env.OWENLOOP_PLUGIN_VERSION` == `package.json` `version` | The third copy of the version going stale (revision 3; Phase 3a item 13) |

**Release-time coupling:** wire release-please's `linked-versions` plugin so a version bump updates `package.json` and both `plugin.json` files in one release commit:
```json
{"plugins": [{"type": "linked-versions", "groupName": "owenloop", "components": ["owenloop", "plugin-claude-code", "plugin-codex"]}]}
```
Its documented behavior: *"When any component in the specified group is updated, we pick the highest version amongst the components and update all group components to the same version."* Check 1 and check 2 above then become the assertion that this actually happened.

**Revision 3 addition:** also register a generic `extra-files` updater for `plugins/claude-code/plugin/.mcp.json` and `plugins/codex/plugins/owenloop/.mcp.json`, so the same release commit bumps the `OWENLOOP_PLUGIN_VERSION` env literal. Checks 1, 2, and 9 together then assert the whole version set moved as one.

**What CI still cannot enforce, and why the runtime check in §2.9 is not redundant:** CI validates the repo. It cannot validate a user's machine, where `owenloop` on PATH is whatever npm last installed globally and the harness plugin cache is whatever `claude plugin install` last copied. The `SessionStart` hook plus the in-tool version assertion are the only things that see the actual runtime combination. Ship both.

---

## 8. Acceptance criteria

- [ ] `npm i -g owenloop && owenloop setup` on a clean machine with both harnesses installs the plugin, skills, and MCP server into both, with no other commands run.
- [ ] The same command on a machine with only one harness installs into that one and reports the other as absent, without failing.
- [ ] **Late-harness scenario (revision 3):** on a machine set up with only Claude Code, install Codex afterwards and re-run `owenloop setup` — the Claude Code step reports `skipped` with zero commands run against it, the Codex step performs a fresh install, and a third run reports both steps `skipped` with zero writes. `owenloop doctor` in the in-between state (Codex installed, plugin not yet) must name the remedy: run `owenloop setup`.
- [ ] Running `owenloop setup` a second time performs zero writes and reports both plugin steps `skipped`. **Including the Codex marketplace probe from §6.3** — a redundant `codex plugin marketplace add` is a write and must not happen.
- [ ] Upgrading the npm package and re-running `owenloop setup` updates the installed plugin in both harnesses to the new version (the version-aware probe, Phase 4 item 17).
- [ ] `owenloop doctor` renders one accurate line per harness, shows plugin version against CLI version, and never fails on a missing harness.
- [ ] No `.mcp.json` in the repo references `npx` or a version range; the MCP server and the CLI are the same install, resolved from PATH.
- [ ] Plugin manifest versions equal the npm package version, enforced by a test (§7 checks 1–2).
- [ ] `serverInfo.version` reports the real package version, not `'0.0.1'`.
- [ ] A CLI/plugin version mismatch produces a readable message from the `SessionStart` hook **and** from an MCP tool call, on at least Claude Code.
- [ ] All three skills (`author`, `conduct`, `shift`) are present and functional in both harnesses.
- [ ] **Hook symmetry (revision 4):** both shipped plugins contain the same hooks, built from `_hooks/`; a Codex session with hooks unapproved works fully with no hook-related error; setup prints the one-line optional `/hooks` hint.
- [ ] `scripts/install-codex-skills.mjs` and its test are deleted; no doc references them.
- [ ] All nine CI checks in §7 pass, and `npm run check` runs them.
- [ ] Phase 7 manual verification is recorded in a runbook.

---

## 9. Explicitly out of scope

- Publishing the marketplace to a public git repo (that was Option A, rejected).
- **Merging `owenloop` and `owenloop-service` into one monorepo** — Decision B in §3.2. Deferred, not rejected. Nothing in this plan depends on it.
- Shipping an `owenloop-worker` equivalent to Codex. **Note the reason changed in revision 2:** Codex *does* support subagents, but not through the plugin system, and INV-39's no-nesting clause has no Codex enforcement mechanism (§2.6). Revisit as separate scoped work if wanted. `docs/drivers/codex-cli.md` currently implies Codex lacks the capability — **that wording is wrong and must be corrected in Phase 8**, even though the shipped behavior does not change.
- Changing the hub, the auth model, or anything under `apps/hub-edge`.
- The headless/CI bearer-token path. It stays as-is for both harnesses; only the interactive install story changes.
- Adopting the post-0.146.0 Codex "Agent Plugins" manifest format (§2.7). This plan targets `.codex-plugin/plugin.json` on the current stable CLI.
- Supporting MCP revision `2026-07-28` (the handshake-free era). Noted in §1.6; separate work.
