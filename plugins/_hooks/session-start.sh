#!/bin/sh
# SessionStart hook: report a CLI/plugin version mismatch before MCP calls begin.
#
# The plugin and the PATH-resolved owenloop CLI update independently. Read the
# plugin manifest at runtime so this hook does not add another copied version
# literal, and always exit 0 so a diagnostic never blocks session startup.

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
plugin_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | sed -n '1p')"
if [ -z "$plugin_version" ]; then
  echo "owenloop plugin version could not be determined. Run: owenloop setup" >&2
  exit 0
fi

if ! command -v owenloop >/dev/null 2>&1; then
  echo "owenloop plugin $plugin_version does not match owenloop CLI not found. Run: owenloop setup" >&2
  exit 0
fi

cli_output="$(owenloop --version 2>&1)"
cli_status=$?
cli_version="$(printf '%s\n' "$cli_output" | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | sed -n '1p')"
if [ "$cli_status" -ne 0 ] || [ -z "$cli_version" ]; then
  echo "owenloop plugin $plugin_version does not match owenloop CLI unknown. Run: owenloop setup" >&2
  exit 0
fi

if [ "$plugin_version" != "$cli_version" ]; then
  echo "owenloop plugin $plugin_version does not match owenloop CLI $cli_version. Run: owenloop setup" >&2
fi
exit 0
