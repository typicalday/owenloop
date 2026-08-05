#!/bin/sh
# SessionEnd hook: best-effort drain of this session's daemon-held claims.
#
# The owenloop work daemon tags a hold with a session id (OWENWORK_SESSION);
# `owenloop work release --session <id>` re-offers that session's agent-held
# claims immediately so a closed shift session doesn't leave orders parked
# until their lease TTL lapses. This is belt-and-braces: every holder also
# final-breath-releases on stdin EOF, and the lease TTL is the ultimate
# backstop. SessionEnd cannot block and must never wedge teardown, so this
# ALWAYS exits 0.

# Read the hook's stdin JSON payload (carries session_id, cwd, hook_event_name).
payload="$(cat)"

# Extract session_id without jq (not guaranteed installed) — flat string field.
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

# Nothing to drain without a session id, and no owenloop binary means no holds
# this hook could have created — no-op in both cases.
if [ -z "$session_id" ]; then
  exit 0
fi
if ! command -v owenloop >/dev/null 2>&1; then
  exit 0
fi

# Origin: `owenloop work release` resolves --origin flag > settings.hubOrigin
# (written by `owenloop setup`), no built-in default. OWENWORK_ORIGIN overrides
# when set; otherwise settings decide. On a legacy install with neither, the
# drain fails non-blockingly and claims fall back to their lease TTL — the
# designed backstop.
if [ -n "${OWENWORK_ORIGIN:-}" ]; then
  set -- --origin "$OWENWORK_ORIGIN"
else
  set --
fi
if ! owenloop work release --session "$session_id" "$@" 2>&1; then
  echo "owenloop SessionEnd: owenloop work release --session $session_id failed (claims fall back to lease TTL)" >&2
fi
exit 0
