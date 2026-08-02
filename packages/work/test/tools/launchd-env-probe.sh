#!/usr/bin/env bash
#
# PHASE 6, ITEM 3 — TIER 1: does a harness credential variable survive the trip
# through launchd and through `buildChildEnv`?
#
# THE QUESTION THIS ANSWERS. Under launchd the harness's Keychain OAuth read can
# fail, and `CLAUDE_CODE_OAUTH_TOKEN` is the fallback credential path. Item 5
# adds a filter to the environment every harness child receives. This probe runs
# a real launchd job, with a real `EnvironmentVariables` dictionary, and checks
# that:
#
#   1. the credential variable set in the plist actually ARRIVES in the job, and
#   2. it SURVIVES `buildChildEnv` (it is outside the `OWENLOOP_*` namespace, so
#      the allowlist cannot reach it), while
#   3. `OWENLOOP_TOKEN` set in the SAME plist does NOT survive `buildChildEnv`.
#
# WHAT THIS PROBE IS NOT. It runs no vendor binary, performs no login, and holds
# no real credential — the token value is the literal string
# `probe-not-a-real-token`. It proves the environment PLUMBING under launchd. It
# does not prove that a real order completes under a launchd-daemonized proxy;
# that is tier 2, is operator-run, and is marked UNVERIFIED in
# `docs/agent-runner.md` until a human runs it.
#
# ── REVERSIBLE BY CONSTRUCTION ───────────────────────────────────────────────
#
# Everything this script creates is removed by the same script run:
#
#   * The plist is written into a `mktemp -d` directory and NEVER into
#     `~/Library/LaunchAgents`. Nothing in a temp directory is auto-loaded by
#     launchd after a reboot, so an interrupted run cannot leave a job that comes
#     back later.
#   * The job declares no `RunAtLoad`, no `KeepAlive`, and no `StartInterval`, so
#     it runs only when this script explicitly kicks it.
#   * Teardown is unconditional, in a shell `trap` on EXIT: `launchctl bootout`
#     then `rm -rf`.
#   * The exact teardown commands are printed BEFORE anything is created, so a
#     human who interrupts the script can finish by hand.
#
# ── RUNNING IT ───────────────────────────────────────────────────────────────
#
#   OWENLOOP_LIVE_TESTS=1 bash test/tools/launchd-env-probe.sh
#
# It is gated on `OWENLOOP_LIVE_TESTS=1` and on macOS, and SKIPS (exit 0) rather
# than failing anywhere else, so CI on ubuntu-latest never attempts it.
# It requires `npm run build` to have produced `dist/packages/work/src/harness/child-env.js`.
set -euo pipefail

if [ "${OWENLOOP_LIVE_TESTS:-}" != "1" ]; then
  echo "SKIP: launchd env probe needs OWENLOOP_LIVE_TESTS=1"
  exit 0
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "SKIP: launchd env probe is macOS-only (uname=$(uname -s))"
  exit 0
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FILTER="$REPO/dist/packages/work/src/harness/child-env.js"
if [ ! -f "$FILTER" ]; then
  echo "FAIL: $FILTER is missing — run \`npm run build\` first" >&2
  exit 1
fi

LABEL="owenloop.envprobe.$$"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/owenloop-launchd-probe.XXXXXX")"
PLIST="$TMP/$LABEL.plist"
OUT="$TMP/observed.json"
JOBLOG="$TMP/job.log"

cat <<EOF
── teardown, if this script is interrupted ──────────────────────────────────
  launchctl bootout gui/$UID/$LABEL 2>/dev/null || true
  rm -rf $TMP
─────────────────────────────────────────────────────────────────────────────
EOF

cleanup() {
  launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# The job: read what launchd handed it, run it through the SHIPPED filter, and
# write both the raw arrival and the filtered result where the probe can read
# them. No vendor binary is involved.
JOB="$TMP/job.mjs"
cat >"$JOB" <<'NODEJS'
import { writeFileSync } from 'node:fs';
// A DYNAMIC import: the path to the built filter arrives in the environment, and
// a static `import ... from <expression>` is a syntax error.
const { filterOwenloopEnv } = await import(process.env.OWENLOOP_PROBE_FILTER);
const before = process.env;
const after = filterOwenloopEnv(before);
writeFileSync(process.env.OWENLOOP_PROBE_OUT, JSON.stringify({
  arrivedOauth: before.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  arrivedOwenloopToken: before.OWENLOOP_TOKEN ?? null,
  arrivedCacheDir: before.OWENLOOP_CACHE_DIR ?? null,
  survivedOauth: after.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  survivedOwenloopToken: 'OWENLOOP_TOKEN' in after ? after.OWENLOOP_TOKEN : null,
  survivedCacheDir: after.OWENLOOP_CACHE_DIR ?? null,
  survivedPath: after.PATH ?? null,
}, null, 2));
NODEJS

# NOTE ON THE PLIST: no RunAtLoad, no KeepAlive, no StartInterval — this job runs
# only when `launchctl kickstart` says so. The token value is a dummy literal;
# no real credential exists anywhere in this probe.
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$JOB</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_CODE_OAUTH_TOKEN</key><string>probe-not-a-real-token</string>
    <key>OWENLOOP_TOKEN</key><string>probe-not-a-real-bearer</string>
    <key>OWENLOOP_CACHE_DIR</key><string>$TMP/cache</string>
    <key>OWENLOOP_PROBE_FILTER</key><string>file://$FILTER</string>
    <key>OWENLOOP_PROBE_OUT</key><string>$OUT</string>
  </dict>
  <key>StandardOutPath</key><string>$JOBLOG</string>
  <key>StandardErrorPath</key><string>$JOBLOG</string>
</dict>
</plist>
EOF

echo "bootstrapping gui/$UID/$LABEL from $PLIST"
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

# `kickstart` returns as soon as the job is started, not when it finishes.
for _ in $(seq 1 50); do
  [ -s "$OUT" ] && break
  sleep 0.2
done

if [ ! -s "$OUT" ]; then
  echo "FAIL: the launchd job produced no output. Job log:" >&2
  cat "$JOBLOG" >&2 || true
  exit 1
fi

echo "── observed ────────────────────────────────────────────────────────────"
cat "$OUT"
echo "────────────────────────────────────────────────────────────────────────"

node -e '
const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const fail = (m) => { console.error("FAIL: " + m); process.exitCode = 1; };
// 1. launchd really delivered the plist environment to the job.
if (o.arrivedOauth !== "probe-not-a-real-token") fail("the OAuth variable did not arrive through launchd");
if (o.arrivedOwenloopToken !== "probe-not-a-real-bearer") fail("OWENLOOP_TOKEN did not arrive through launchd (the probe would be vacuous)");
// 2. ITEM 3: it survives the filter, because it is outside the OWENLOOP_ namespace.
if (o.survivedOauth !== "probe-not-a-real-token") fail("the OAuth variable did NOT survive buildChildEnv — headless auth would break under launchd");
// 3. ITEM 5: the hub bearer override does not.
if (o.survivedOwenloopToken !== null) fail("OWENLOOP_TOKEN survived the filter — item 5 is not in effect");
// 4. An admitted namespace variable still travels, and PATH is untouched.
if (o.survivedCacheDir === null) fail("OWENLOOP_CACHE_DIR is admitted but did not survive");
if (o.survivedPath === null) fail("PATH did not survive — every child would break");
if (!process.exitCode) console.log("PASS: launchd delivered the credential, the filter kept it, and the bearer override was dropped");
' "$OUT"
