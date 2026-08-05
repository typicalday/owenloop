#!/bin/sh
# SessionStart hook: report a CLI/plugin version mismatch before MCP calls begin.
#
# The root CLI has no --version flag, so ask its MCP initialize response for the
# server version instead. Read the plugin manifest at runtime so this hook does
# not add another copied version literal, and always exit 0 so a diagnostic never
# blocks session startup.

plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$plugin_root" ]; then
  exit 0
fi

manifest="$plugin_root/.claude-plugin/plugin.json"
if [ ! -f "$manifest" ]; then
  manifest="$plugin_root/.codex-plugin/plugin.json"
fi
if [ ! -f "$manifest" ]; then
  exit 0
fi

# Extract the first flat JSON version field without jq (not guaranteed installed).
plugin_version="$(tr ',' '\n' < "$manifest" | sed -n 's/[^\"]*"version"[[:space:]]*:[[:space:]]*"\([^\"]*\)".*/\1/p' | sed -n '1p')"
if [ -z "$plugin_version" ]; then
  echo "owenloop plugin version could not be determined. Run: owenloop setup" >&2
  exit 0
fi

if ! command -v owenloop >/dev/null 2>&1; then
  echo "owenloop CLI was not found on PATH. Run: owenloop setup" >&2
  exit 0
fi

# The initialize response is the root CLI's supported version surface. It is
# also safe for old CLIs: one that lacks `mcp` fails below and gets a diagnosis.
initialize_request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
cli_output="$(printf '%s\n' "$initialize_request" | owenloop mcp 2>&1)"
cli_status=$?
cli_version="$(printf '%s\n' "$cli_output" | tr ',' '\n' | sed -n 's/[^\"]*"version"[[:space:]]*:[[:space:]]*"\([^\"]*\)".*/\1/p' | sed -n '1p')"
if [ "$cli_status" -ne 0 ] || [ -z "$cli_version" ]; then
  echo "owenloop plugin $plugin_version could not determine the owenloop CLI version. Run: owenloop setup" >&2
  exit 0
fi

if [ "$plugin_version" != "$cli_version" ]; then
  echo "owenloop plugin $plugin_version does not match owenloop CLI $cli_version. Run: owenloop setup" >&2
fi
exit 0
