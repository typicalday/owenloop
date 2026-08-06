# CLI reference

The `owenloop` binary is a thin adapter over the engine: it maps `argv` to
engine calls and prints JSON to stdout. Everything here has a typed,
in-process equivalent — see [`docs/embedding.md`](embedding.md).

Global flags: `--db <path>` (env `OWENLOOP_DB`, default `.owenloop/state.db`) and
`--defs <dir>` (env `OWENLOOP_DEFS`, default `./workflows`). Nothing is
remembered between invocations — pass both on every command. Opening the
**default** db path refuses a symlinked `.owenloop` directory — and a symlinked
`state.db` file (or any of its SQLite `-wal`/`-shm`/`-journal` sidecars) inside
a real `.owenloop` — rather than following it (filesystem-isolation guard
against a hostile checkout redirecting state writes); an explicit
`--db`/`OWENLOOP_DB` is operator intent and is created/opened as-is.

An unrecognized `--option` for a command is rejected — nonzero exit, the
offending flag named, and the nearest valid option suggested when close
enough — before any filesystem, keychain, or network effect (e.g. `push
--dryrn` no longer does a real push). `--db`/`--defs` remain accepted on
every command, as above. `--help` on any command (or bare `-h`/`help`)
prints this usage and exits 0 without doing any work.

Boolean flags (`--force`, `--dry-run`, `--all`, `--open`, `--terminal`,
`--recursive`, `--with-token`, `--shallow`, `--assume-provided`,
`--strict-inputs`, `--unsigned`, and the bare `--now` on `reap`) never take a
following value — the next token is always a positional or the next `--flag`,
never consumed as this flag's argument. Use `--flag=value` (e.g. `--now=<ms>`
on `tick`) for flags that do take a value.

`owenloop check <def>` defaults to treating `seedOwed` inputs as provided
(`assumeProvided: true`), so a def whose only initial gate is an unprovided
seeded input no longer reports a false depth-0 `True deadlocks` and doesn't
exit nonzero for it. `--strict-inputs` opts back out to the previous
seedOwed-starts-owed behavior, and when that's the def's only blocker also
prints a one-line hint naming the responsible input(s). `--assume-provided`
is still accepted (never errors) but is now redundant with the default; if
both flags are passed, `--strict-inputs` wins. See
[`docs/design.md` §25](design.md#25-the-model-checker-owenloop-check--scope)
for the full breakdown.

## Commands

| command | what it does |
|---|---|
| `defs` | list available workflow definitions |
| `add <owner>/<repo>[@ref]` | fetch, validate, and install a repo's workflow defs from GitHub (public repos only) — see below |
| `add <bundle.wnlp \| https://url> [--global]` | install a workflow bundle into the content-addressed store — project store under the defs dir by default, `<home>/.owenloop/workflows` with `--global` — see below |
| `add --recover [--global]` | finish or undo a crash-interrupted install, offline — no network call (`--global` recovers the global store) — see below |
| `bundle pack <source-dir> [--output <bundle.wnlp>]` | create a deterministic `.wnlp` package without opening the local store — see [Bundles](#bundles) |
| `bundle unpack <bundle.wnlp> <destination-dir>` | strictly validate and atomically extract a `.wnlp` package — see [Bundles](#bundles) |
| `bundle inspect <bundle.wnlp>` | strictly validate a `.wnlp` package and print its manifest and file metadata — see [Bundles](#bundles) |
| `bundle digest <bundle.wnlp>` | print the SHA-256 digest of the uncompressed canonical tar — see [Bundles](#bundles) |
| `login [--hub <url>] [--with-token] [--as <slot>]` | authenticate the CLI against a hub — loopback OAuth, or `--with-token` from stdin — see [Hub](#hub-login--connect--push--logout) |
| `connect [--hub <url>] [--as <slot>]` | bind this project to a hub (writes `.owenloop/hub.json`) and verify the credential |
| `push [<defName>...] [--force] [--dry-run] [--as <slot>]` | publish local workflow defs to the bound hub (idempotent against the hub's own def hashes) |
| `publish <source-dir> [--output <bundle.wnlp>] [--source <json>] [--unsigned]` | pack a canonical workflow bundle and publish a signed publication sidecar, with an optional signed origin sidecar, or an explicitly unsigned marker |
| `logout [--hub <url>] [--as <slot>]` | delete the stored credential for a hub |
| `agent new <name> [--crews <a,b>] [--scopes <a,b>] [--shift] [--hub <url>]` | mint a new Scoped Identity on the hub and store its token in slot `agent:<name>` — the token is never printed; `--shift` = `--scopes work,run` — see [Hub](#hub-login--connect--push--logout) |
| `capability bind <capability> <crew> [--hub <url>]` | add a crew to a workflow capability on the hub org — a capability may route to many crews (admin; human credential) — see [Capability routes](#capability-routes) |
| `capability unbind <capability> <crew> [--hub <url>]` | remove one `(capability, crew)` route — see [Capability routes](#capability-routes) |
| `capability list [--hub <url>]` | list the hub org's capability routes — see [Capability routes](#capability-routes) |
| `crew list [--hub <url>]` | list the hub org's crews with their members (includes the orphan crew once one exists) — see [Crews](#crews) |
| `crew new <name> --kind personal\|shared [--owner <memberId>] [--hub <url>]` | create a crew on the hub org (admin, or own personal crew; human credential) — see [Crews](#crews) |
| `crew rm <crewId> [--hub <url>]` | delete a crew; work stamped to it moves to the org's orphan crew — see [Crews](#crews) |
| `crew member add <crewId> <principalKind> <principalId> [--hub <url>]` | add a member or agent to a crew — see [Crews](#crews) |
| `crew member rm <crewId> <principalId> [--hub <url>]` | remove a principal from a crew — see [Crews](#crews) |
| `setup [--hub <url>] [--new-agent <name> \| --replace-agent <name>] [--crews <a,b>] [--scopes <a,b>] [--reuse-ssh-key <path>]` | onboard this machine: may store human and Scoped Identity credentials, ensure the three principal signing keys, relay the machine enrollment grant, write only execution-settings `hubOrigin`, and converge the bundled plugins for Claude Code and Codex — see [`setup`](#setup--onboard-a-machine) |
| `enrollments [--hub <url>]` | read and locally classify the hub's relayed machine enrollment grants; never creates keys or writes the roster — see [`enrollments`](#enrollments--inspect-machine-enrollment) |
| `doctor [--hub <url>]` | read-only check of this machine's owenloop install, one ✓/✗ line per piece — see [`doctor`](#doctor--check-a-machines-install) |
| `mcp [--hub <url>]` | serve the hub control plane to a local MCP host over stdio — spawned by MCP hosts, not run by humans — see [`mcp`](#mcp--stdio-control-plane-server-for-mcp-hosts) |
| `shift start <crew...>`, `shift next`, `shift status`, `shift end` | run the foreground shift daemon and its local clients — see [`shift`](#shift--foreground-daemon-and-client) |
| `work <subcommand> [options]` | run the execution-side CLI companion — see [`work`](#work--execution-side-cli-companion) |
| `trust init\|grant\|revoke` | create and sign local enrollment trust records offline — see [`trust`](#trust--local-enrollment-trust) |
| `create <def> [--title t] [--provide name=json …] [--param k=v …]` | start an instance; prints `{workflow}` |
| `provide <wf> <name> [--value json]` | supply a seeded input after the fact |
| `tick <wf> [--now=<ms>] [--shallow] [--capability <l>]…` | claim and emit eligible **orders** (the jobs to run); deep by default — also descends into live `calls:` children (`--shallow` = this instance only); repeatable `--capability` claims steps without capabilities plus matching-capability steps — see below |
| `reap <wf> [--now]` | run the reaper; `--now` forces every claim stale (TTL 0) — see below |
| `runs <wf> [--open]` | list this instance's runs, joining claim state for open ones |
| `status <wf>` | derived view: `done`, `debts`, `eligible`, `blocked`, `inFlight` |
| `wait <wf> --until eligible\|done [--timeout <dur>]` | block until engine state matches, then print `status` |
| `show <wf>` | dump raw artifacts (debugging) |
| `list` | list instances |
| `green <wf> <run> <path> [--value json] [--terminal]` | accept an owed output |
| `emit <wf> <run> --items '[{…},{…}]'` | add collection elements |
| `seal <wf> <run> [--value json]` | mark a collection complete |
| `reject <wf> <path> --by <author> --text <msg>` | reject an output (re-arms its producer) |
| `retract <wf> <path> --by <author> --text <msg>` | drop a collection member |
| `skip <wf> <path> --by <author> --text <msg>` | a step declines its own output |
| `retry <wf> <path> [--by a] [--text guidance]` | clear a stall, reset the counter |
| `close <wf> <run> [--outcome ok\|no_work\|failed\|skipped] [--summary s]` | release a claimed job |
| `delete <wf>` | delete an instance and all its rows |
| `adopt <wf>` | re-pin an instance to the current definition and settle any new debts |

## Bundles

Bundle commands are deliberately dispatched before the CLI opens the engine
store. `bundle pack`, `bundle inspect`, `bundle digest`, and `bundle unpack`
read or write only the paths named by the command; they do not create
`.owenloop/state.db`, contact a remote coordinator, or use workflow definitions
from `--defs`. Successful commands print one JSON object on stdout. Failures
print a diagnostic on stderr and exit nonzero.

```text
owenloop bundle pack <source-dir> [--output <bundle.wnlp>]
owenloop bundle unpack <bundle.wnlp> <destination-dir>
owenloop bundle inspect <bundle.wnlp>
owenloop bundle digest <bundle.wnlp>
```

`pack` requires a source directory containing root `bundle.yaml` and
`workflow.yaml`. The source manifest is not modified. If `--output` is omitted,
the output is `<package-name>-<version>.wnlp` next to the source directory. An
explicit output path must be outside the source directory. A regular file at
the output path may be replaced; a directory or other non-regular path is
rejected.

`inspect` performs bounded gzip inflation, strict POSIX/PAX tar validation,
manifest validation, workflow validation, lock coverage checks, and per-file
integrity checks without extracting files. `digest` performs bounded inflation
and returns the lowercase SHA-256 of the exact uncompressed canonical tar; the
gzip wrapper bytes are not the identity.

`unpack` performs the complete `inspect` validation before creating anything.
The destination must be absent. Files are written into a fresh sibling staging
directory and the staging directory is renamed into place only after all files
are written. Existing symlinked destination ancestors are rejected.

The manifest and archive rules are documented in
[`docs/bundles.md`](bundles.md). The public in-process equivalents are
`packBundle`, `inspectBundle`, `digestBundle`, and `unpackBundle` from the
package barrel.

## `shift` — foreground daemon and client

`owenloop shift` is the public local dispatch surface. `shift start` runs the
self-driven dispatch loop as a foreground process and listens on
`<stateDir>/shift.sock`. Each client connection carries one JSON-line request
and one JSON-line response. The daemon keeps polling and dispatching while no
`shift next` client is attached.

The `shift start` positional argument is a **crew** name. The routing API calls
that field a **crew**: `serve_crews` contains the selected crew names. Passing
`--all` maps to an empty `serve_crews` list, which means all crews available to
the Scoped Identity. Do not treat `attended_at` as a liveness signal: every
accepted `shift next` records attendance and makes the next presence ping due,
but attendance is advisory and observability-only. Attendance never changes
routing, dispatch, or lease behavior.

The execution settings file is `$XDG_CONFIG_HOME/owenloop/settings.json` when
`XDG_CONFIG_HOME` is set to a non-blank value; otherwise it is
`$HOME/.config/owenloop/settings.json`.

### `shift start <crew...>`

```text
owenloop shift start <crew...> [--all] [--origin <url>] [--as <account>] [--name <n>]
[--cap <n>] [--max-agents <n>] [--poll-interval <ms>] [--once]
[--cache-dir <p>] [--state-dir <p>]
```

At least one named crew is required unless `--all` is present. `--all` and
named crews are mutually exclusive. Duplicate named crews collapse to one
entry before routing. The daemon owns one socket at a time; a second start
against the same socket is refused. There is no detach mode. `--once` performs
one loop sweep and exits instead of keeping the foreground daemon running.

| option | default and behavior |
|---|---|
| `--origin <url>` | use this hub origin; otherwise use `hubOrigin` from the execution settings file; there is no hub-origin fallback |
| `--as <account>` | use this Scoped Identity account; defaults to `default` |
| `--name <n>` | use this shift name; otherwise generate one from the host and current directory with a process/shift suffix |
| `--cap <n>` | dispatch capacity; precedence is flag, then `settings.dispatchCap`, then `3` |
| `--max-agents <n>` | concurrent agent limit; precedence is flag, then `settings.maxConcurrentAgents`, then `4` |
| `--poll-interval <ms>` | loop polling interval; defaults to `5000` milliseconds |
| `--once` | run one loop sweep and exit; without it, keep the daemon in the foreground |
| `--cache-dir <p>` | cache root; precedence is flag, then `OWENLOOP_CACHE_DIR`, then `settings.cacheDir`, then `$XDG_CACHE_HOME/owenloop`, then `$HOME/.cache/owenloop` |
| `--state-dir <p>` | socket and child-state root; precedence is flag, then `OWENLOOP_STATE_DIR`, then `settings.stateDir`, then `$XDG_STATE_HOME/owenloop/exec`, then `$HOME/.local/state/owenloop/exec`; the socket is `shift.sock` inside this directory |

A clean start or `--once` completion exits `0`. `owenloop shift --help` also
exits `0`. Runtime failures such as credential reads or socket/runtime setup
exit `1`. Usage and
precondition failures — including no crew or `--all`, invalid flags, a missing
hub origin, or a missing Scoped Identity credential — exit `2`. The foreground
daemon's normal lifecycle line is written to stdout when it stays running;
diagnostics go to stderr.

### `shift next [--wait <seconds>]`

```text
owenloop shift next [--wait <seconds>] [--state-dir <p>]
```

`--wait` accepts a finite, non-negative number of seconds and defaults to `90`.
`--state-dir` selects the daemon socket. Only one `next` call may be parked at
a time. A second parked call returns this error and exits `1`:

```text
whats_next is already parked — one park at a time (cancel it or wait for it to return)
```

When a `next` request is accepted, the daemon stamps `attended_at`. The call
returns promptly when an event is queued, the wait expires, or the shift
explicitly ends. A normal timeout exits `0` and prints the current capacity
object, for example `{ "cap": 3, "free": 3, "running": 0, "events": [] }`.
Successful responses use the same capacity shape and may include queued event
objects. For `dispatched`, `reaped`, and `failed`, `kind` is either `exec` or
`agent-run`:

- `dispatched`: `{ "type": "dispatched", "workflow": "...", "run": "...", "step": "...", "kind": "exec", "pid": 123 }`
- `reaped`: `{ "type": "reaped", "workflow": "...", "run": "...", "kind": "exec", "pid": 123 }`
- `failed`: `{ "type": "failed", "workflow": "...", "run": "...", "step": "...", "kind": "exec", "message": "..." }`
- `ended`: `{ "type": "ended" }`, delivered to a parked `next` when `shift end` explicitly shuts down the daemon

`gate` is a reserved protocol shape for a future local representation of a
pending hub gate. Production code does not construct live hub gate events yet;
the local FIFO test and drill scope are recorded in
[`packages/work/test/shift-walkthrough.manual.md`](../packages/work/test/shift-walkthrough.manual.md).

If no daemon is listening, `next` exits `1` and prints the exact start guidance:

```text
no shift daemon at <stateDir>/shift.sock — start one with: owenloop shift start <crew…>
```

Invalid arguments exit `2`. Other client or daemon runtime failures exit `1`.
All successful client output is one JSON object on stdout; diagnostics are on
stderr.

### `shift status [--state-dir <path>]`

```text
owenloop shift status [--state-dir <p>]
```

With a daemon, status exits `0` and prints:

```json
{ "name": "host/project#abc123", "serve_crews": ["alpha"], "cap": 3, "free": 3, "running": 0, "attended_at": null, "started_at": 1738000000000 }
```

`attended_at` remains `null` until the first accepted `next` request. Without a
daemon, status is still a successful question: it exits `0` and prints
`{ "status": "no daemon", "socket": "<path>" }`. Invalid arguments exit `2`;
other client/runtime errors exit `1`.

### `shift end [--state-dir <path>]`

```text
owenloop shift end [--state-dir <p>]
```

An explicit end stops the loop, resolves an in-flight `next` with an `ended`
event, sends the final presence update with `attended_at` omitted so the hub
clears the attendance stamp, closes the socket, and prints
`{ "ok": true, "ended": true }` with exit `0`. Detached `exec` and `agent-run`
children remain alive to finish under their own leases. Signal shutdown (for
example, Ctrl-C) stops the daemon but does not synthesize the `ended` event or
perform the explicit attendance-clearing update.

If no daemon is listening, `end` exits `1` with the same start guidance as
`next`. Invalid arguments exit `2`; other client/runtime errors exit `1`.

## `work` — execution-side CLI companion

The execution-side commands ship in the same `owenloop` npm package and use the
same `owenloop` binary. Replace the old separate `owenwork` invocation directly:

```text
owenwork <subcommand> ...    →    owenloop work <subcommand> ...
```

The transplanted subcommand names remain. The standing Shift daemon is
only the root `owenloop shift` command; `owenloop work` has no standing-daemon alias.
`hold --mcp` remains because the machine-attached hold mount still exists.
Run `owenloop work --help` for the full role-specific usage.

The execution settings file is `$XDG_CONFIG_HOME/owenloop/settings.json` when
`XDG_CONFIG_HOME` is set to a non-blank value; otherwise it is
`$HOME/.config/owenloop/settings.json`.

| subcommand | what it does |
|---|---|
| `hold --order <id> [options]` | hold an order with a heartbeating lease |
| `exec <order-id> [options]` | run a command order in a self-leasing loop |
| `agent-run <order-id> [options]` | host an agent order's Step Agent in a harness and self-leasing loop |
| `prepare <workflow> [--origin <url>]` | fetch, cache, and normalize step specs |
| `lint <workflow-name \| path>` | lint `x.harness` option bags in a workflow definition |
| `sessions [--all] [--json]` | list recorded harness sessions and how to reopen them |
| `release --session <id> [options]` | drain a session's held claims |
| `settings` | print the resolved execution settings file |
| `join <code> [--hub <origin>] [--as <account>]` | redeem a join code and store the Scoped Identity credential |

## `trust` — local enrollment trust

The `trust` commands create the local enrollment root and signed enrollment
records. The commands are offline: they do not contact a hub or other remote
coordinator, and the remote side cannot create, sign, or endorse these records.
The org root is stored separately from `PrincipalKeyManager` at the injected
configuration root described in [Signing and key storage](crypto.md#enrollment-chains-attenuation-and-revocation).

```text
owenloop trust init [--force]
owenloop trust grant --key <pubkey-path> --principal <human|machine|agent>:<id> \
  [--pools a,b|*] [--labels a,b|*] [--namespaces a,b|*] \
  [--delegate no|<n>|unbounded] [--signing-key <path>] [--output <file>]
owenloop trust revoke --key <SHA256:…> --principal <kind>:<id> \
  [--reason <text>] [--effective-from <epochMs>] \
  [--signing-key <path>] [--output <file>]
```

- `trust init` generates an Ed25519 org-root key pair under the local config
  directory. The containing directory is `0700`, the private key is `0600`,
  and the public key is `0644`. Existing root files are refused unless
  `--force` is supplied. The command prints paths and status, never private key
  bytes.
- `trust grant` reads an Ed25519 public key from `--key`, assigns it to the
  `--principal`, and signs an `EnrollmentGrantRecord`. Each scope axis defaults
  to an empty array (deny by default); `--delegate` defaults to `no`. The
  signing key defaults to the local org root unless `--signing-key` is given.
  The signed DSSE envelope is written to `--output`, or to the local roster
  directory using a SHA-256 hash of the enrolled key ID as its filename.
- `trust revoke` signs a `RevocationRecord` for the `SHA256:…` key in `--key`.
  The signing key defaults to the local org root. Without `--effective-from`,
  the cut starts at issuance. With an earlier `--effective-from`, the CLI
  derives `backdated: true`; the flag is never accepted as an independent
  boolean. The signed envelope is written to `--output`, or to the local
  revocations directory using a SHA-256 hash of the revoked key ID.

These commands print one JSON result on success. They refuse malformed
principals, fingerprints, scope lists, delegation values, and timestamps before
performing the related filesystem or signing work. Trust records are only
local inputs to the chain validator; transporting a signed envelope is a
separate concern.

## `add` — installing shared workflow defs from GitHub

`owenloop add <owner>/<repo>[@ref]` fetches a public GitHub repo's
`workflows/**` folder (via GitHub's REST API and Node's built-in `fetch` — no
new dependency), validates every def with the same lint/validate/`check`
machinery `owenloop lint`/`owenloop check` use — plus a strict cross-def
backstop (include expansion, `calls:` target/inputs/output-count checks,
cycle detection) on the staged tree, so an error `loadDefsRaw` would
otherwise swallow still refuses the install — and only then installs them
under `<defsDir>/<owner>-<repo>-<hash>/`, where `<hash>` is the first 8 hex
characters of `sha256(owner/repo)`. The hash keeps distinct sources that used
to collide on the same `<owner>-<repo>` folder (e.g. `a-b/c` and `a/b-c`)
from clobbering each other. `owner` and `repo` are restricted to the
GitHub-legal charset (letters, digits, `.`, `_`, `-`) so the folder is always
a single safe path segment. A def that fails parse, lint, validation, or has
a definite `check` defect refuses the **whole** add — nothing is written,
and every reason is printed.

`ref` defaults to `HEAD` (the repo's default branch) and is pinned to the
resolved commit sha before anything is fetched or installed. Provenance is
recorded in `.owenloop/installed.json`:

```jsonc
{
  "version": 1,
  "installed": {
    "<owner>/<repo>": {
      "source": "<owner>/<repo>",
      "ref": "HEAD",
      "sha": "<40-char-commit-sha>",
      "installedAt": 1699999999999,
      "path": "<owner>-<repo>-<hash>",
      "files": ["foo.yaml", "sub/bar.yaml"]
    }
  }
}
```

Re-running `add` for the same repo is idempotent: the fetch is staged under
`<defsDir>/.owenloop-staging/`, validated, and swapped into place with an
atomic rename, replacing the previous install and lockfile entry so a file
removed upstream disappears locally too. The directory swap and the lockfile
write are one recoverable operation: the install is *committed* only when
`.owenloop/installed.json` is atomically replaced, and the displaced previous
directory (and any old-name directory) is kept until that write succeeds. Any
failure before that commit point — a validation error, a lock timeout, an
interrupted rename, a failure parking the old-name directory during migration,
or a lockfile-write failure *after* the directory swap — rolls the directory
state back, restoring the previous install and any old-name directory and
leaving the lockfile unchanged, with no staging debris. The one deliberate
exception is a rollback double fault — the follow-on step fails *and* restoring
the directory state fails too. For a lockfile-write double fault, the
displaced previous content is intentionally preserved under
`<defsDir>/.owenloop-staging/` and the error names that path; recover it
before re-running `add`. For a park double fault during old-name migration,
there's no staging backup to preserve — the old-name directory was never
moved, so it stays intact at its original path, and the error instead names
the newly installed content stranded at the destination path; re-running
`add` recovers automatically, discarding the stranded content and leaving the
previous install in place.

Those rollbacks cover *in-process* failures — a thrown error `add` catches. A
hard kill (a process crash, SIGKILL, or other termination) partway through the
commit skips them entirely, so `add` also keeps a one-record crash-recovery
journal at `.owenloop/add.journal`: it is written just before the first
destructive step (phase `applying`), advanced to `finalizing` the instant the
lockfile write — the commit point — succeeds, and removed once the install
finishes. The next `add` reads it under the same lock, *before* clearing
staging, and brings the tree back to a consistent (defs ⇔ ledger) state: at or
past the commit point it rolls **forward** (discards the retained backup and
finishes the install); before it, it rolls **back** (restores the previous
install, or discards an orphaned fresh-install directory *only* when the ledger
corroborates an interrupted old-name migration — a journal naming an existing
directory with no corroborating ledger, staging, or backup evidence is refused
fail-closed and never deletes it, and the error names the manual remedy).
Recovery is idempotent and re-derives
every path it touches from the current defs directory, so a crash *during*
recovery just replays. The journal is treated as hostile input exactly like the
lockfile: it is validated fail-closed (every path field a safe single segment),
its recorded defs directory must match this run's, and a symlink where a
directory is expected is refused — any bad shape, mismatch, or contradictory
on-disk state refuses with no filesystem mutation and leaves the journal in
place as evidence. A rollback double fault likewise leaves the journal behind,
so the next `add` retries the restore automatically before touching staging.

`add --recover` runs that same recovery on demand, standalone, with **no
network call** — for a machine that crashed mid-install and is still offline
when you need the tree usable again, rather than waiting on the normal `add`
path (which also recovers inline, but only after its SHA and tarball fetches).
It takes no `<owner>/<repo>` argument — `add --recover acme/widgets` refuses
rather than guessing whether you meant "recover then install" (that's just a
plain `owenloop add acme/widgets`, which recovers inline anyway). It acquires
the same `.owenloop/add.lock`, calls `recoverInterruptedInstall`, and prints
one of three outcomes: `{"ok":true,"recovered":false,...}` when there was no
journal to act on, or `{"ok":true,"recovered":true,"outcome":"rolled-forward"|"rolled-back",...}`
when it finished or undid the interrupted install. A refusal (bad, mismatched,
or contradictory journal) throws the same as the inline path: exit 1, nothing
mutated, the journal left in place as evidence.

The recovery guarantee covers *process* death — a crash, SIGKILL, or
termination — not sudden power loss. Journal and lockfile writes are atomic
tmp-file-plus-rename *without* `fsync`/`fdatasync` or a directory sync, so an
atomic rename prevents partially-visible JSON but does not force the data or the
directory entry to durable storage: a power failure can lose the journal or a
just-written ledger entry entirely. Real fsync-based durability across power
loss is a tracked follow-up, deliberately out of scope here.

Concurrent `add` runs in the same project serialize on a `.owenloop/add.lock`
file; one that can't acquire the lock within 10s fails cleanly instead of
interleaving with another install. `add` also refuses to replace a
destination folder the lockfile doesn't record this source as owning (e.g. a
hand-placed folder that happens to collide) — remove it manually or fix the
lockfile to proceed. A repo previously installed under the old
`<owner>-<repo>` naming is migrated to the new hashed folder automatically,
and the old one is removed only once the new lockfile entry is durably written.

The lock's stale-reclaim is liveness-aware, not purely age-based: a lock
whose recorded pid is alive on this host is never reclaimed no matter how
long it's held, and one whose pid is dead is reclaimed immediately. Age (the
10-minute window) governs reclaim only as a fail-closed fallback for a lock
this process can't attribute to a live owner — unparseable, or missing a
pid. A lock recorded from a **different host** is never age-reclaimed
either, since a pid liveness check proves nothing about a foreign PID space;
it's held until its own machine clears it. Each acquisition writes a
per-lock ownership token, and release only deletes the file if that token
still matches — so a holder that loses a race can never delete a lock a
fresh owner has since re-acquired. A lock file that can be `stat`'d but not
read (e.g. root-owned, or mid-write) no longer spins the acquire loop
sleeplessly; it falls through to the normal poll sleep and still respects
the `waitMs` timeout.

`add` never trusts `.owenloop/installed.json` for filesystem paths: the lockfile
is validated fail-closed on read. A file that parses but is structurally invalid
— an unsupported `version`, a malformed or key-mismatched entry, a non-hex
`sha`, an escaping `files` entry, or a `path` that is not a single safe folder
segment (any `..`, absolute, or separator-bearing `path` is refused, never
normalized) — is a hard error naming the offending entry and field, never
silently reset to empty (which would erase ownership records). This closes a
directory-migration path where a crafted committed lockfile could make `add`
move and then delete a directory outside the defs dir.

`add` also refuses a symlinked project `.owenloop` directory and a symlinked
**default** defs dir before any state write — the same filesystem-isolation
guard used elsewhere, closing the one spot `add` hadn't yet applied it to. A
hostile checkout shipping `.owenloop -> /elsewhere` or a symlinked `./workflows`
could otherwise redirect `add.lock`, `installed.json`, and the staged/committed
defs outside the project. `.owenloop` is guarded unconditionally, since its
lock and lockfile paths are always `cwd`-derived in `add` with no override; the
defs dir is guarded only on the default `cwd/workflows` fallback — an explicit
`--defs`/`OWENLOOP_DEFS` is operator intent and is installed through as-is,
matching the `--db`/`OWENLOOP_DB` rule above.

**Installed-def discovery.** Defs installed by `add` are discovered by default:
a plain `owenloop defs`/`create`/`tick` against the DEFAULT defs dir
(`cwd/workflows`) sees them by name, no `--defs` flag needed. `loadDefs` itself
stays a pure dir-scanner (top-level `*.yaml` plus immediate-subdir
`workflow.yaml`); the CLI folds installed subfolders in on top, ledger-driven and
bounded — it only loads folders named by the fail-closed-validated
`.owenloop/installed.json` entries, never a raw recurse of the tree.

- **Only under the default defs dir.** An explicit `--defs`/`OWENLOOP_DEFS` is
  operator intent to target a literal dir and keeps the pure-scan behavior with
  no fold-in — the rule is "was an override given", so even
  `OWENLOOP_DEFS=$PWD/workflows` counts as an override and stays literal.
  Pointing `--defs` straight at an install folder
  (`--defs workflows/<owner>-<repo>-<hash>`) still works exactly as before.
- **Precedence.** Project-local (top-level) defs win over installed defs; among
  installed entries the ledger sources are iterated in sorted order and the
  first-loaded def with a given name wins. Every shadowed def is reported as a
  `warning:` on stderr (stdout JSON stays clean), never a silent clobber.
- **Fail-open.** The fold-in never breaks base loading. A corrupt or
  structurally-invalid `installed.json`, a missing install folder, or an install
  folder that fails to load each emits a `warning:` on stderr and is skipped;
  your project defs still load and the command still exits 0. The add-time
  fail-closed lockfile validation is unchanged — discovery consumes it and simply
  refuses to act on a bad ledger rather than crashing.

Public repos only — no auth/token support yet; a private repo (or a bad
ref) surfaces as a 404 from the sha-resolve step.

**Trust model — what `add` does and does not protect.** Installing a package
executes nothing at install time: `add` only fetches, validates, and writes
YAML under the defs dir. But an installed def's steps *run* later, with
whatever privileges the host process and its dispatcher grant their Step Agents.
owenloop itself never executes a step body — `executor:`/`command:` are opaque
fields it carries through untouched and never shells out (see [What owenloop is
not](../README.md#what-owenloop-is-not) and
[`docs/authoring.md`](authoring.md#executor--declaring-the-executor)) — so the
real risk surface is the Shift or Step Agent you point at these defs: the
prompts and `command:` strings that ship in a package are handed to Step Agents that
typically run with your full local privileges. **Install only sources you
trust.**

**Pin a commit SHA for anything you re-add.** `owenloop add <owner>/<repo>@<ref>`
takes a branch, tag, or commit SHA as `<ref>` — all three resolve through
GitHub's `GET /repos/<owner>/<repo>/commits/<ref>`. A branch or tag can move
under you between re-adds; only a SHA guarantees the same bytes every time.
`add` already resolves whatever `ref` you give (default `HEAD`) to a concrete
commit sha before fetching, and records that sha in `.owenloop/installed.json`
(above) — so a single install is already pinned by that record; the SHA
recommendation is about following a *moving* ref across later re-adds/updates.

The protections described under **Untrusted-archive safety** below guard the
install *step* — staged all-or-nothing validation with an atomic swap, path
containment (including symlink-aware `bodyFile` checks), and archive resource
bounds — not the def *content* that later executes. `add` validates a def's
structure and contains its paths; it does not sandbox or sanitize what a step
body will do once a Step Agent runs it. That trust decision stays yours.

**Untrusted-archive safety.** `add` treats the fetched repo as untrusted and
refuses the whole install (nothing written) on any of these:

- **Path containment.** An archive entry whose path would escape the install
  dir (absolute, or a `..` component) is rejected, and every offender is named.
  A def's `bodyFile` is likewise resolved symlink-aware and must be a regular
  file inside the def's own directory — an absolute path, a `..` component, or
  a symlink pointing outside is refused (both while staging and when a
  previously-installed package is later loaded).
- **Resource bounds on extraction.** The download is capped at 256 MiB
  compressed and 1 GiB expanded (a gzip bomb aborts at inflate time rather than
  exhausting memory), 50k files, 100 MiB per file, and 1024-char entry paths.
  The 256 MiB compressed cap is enforced *during* the download by a bounded
  streaming reader — a response advertising an oversize `Content-Length` is
  refused before any body is read, and a body that streams past the cap is
  cancelled the moment it crosses it, so an oversized archive is never fully
  buffered into memory (the extraction limits above still re-check the size once
  the bytes are in hand).
- **Request timeouts.** The sha-resolve fetch times out after 30s and the
  tarball download after 5 min, each surfacing as a friendly error. The
  bundle route applies the same 256 MiB cap and 5 min timeout to its file
  read and URL fetch (see the next section).

## `add` with bundles — the content-addressed workflow store

`owenloop add <owner>/<repo>[@ref]` (the previous section) installs
GitHub repos by name into `<defsDir>/<owner>-<repo>-<hash>/`. The **bundle**
route is a separate, content-addressed installation path for `.wnlp` workflow
bundles:

```text
owenloop add widget.wnlp                 # install into the PROJECT store
owenloop add ./packs/widget.wnlp --global   # install into the GLOBAL store
owenloop add https://example.com/widget.wnlp
owenloop add --recover [--global]        # offline crash recovery (per root)
```

The source is classified before anything else: `owner/repo[@ref]` keeps the
GitHub route byte-for-byte unchanged; a path ending in `.wnlp` is a bundle
file; an `http:`/`https:` URL is a bundle URL. Any other URL scheme
(`ftp:`, `file:`, …) is refused — never a silent fallback. `--global` applies
only to `.wnlp` bundle sources; a GitHub source with `--global` is refused
before any network request. The source string is origin data only (diagnostics
and messages); it is never joined into a filesystem path and never part of a
bundle's identity. Identity comes from the bundle's own
`namespace/name@version` coordinate and its canonical content digest.

**The `.wnlp` route requires two adapters and fails closed without them.**
Bundle ingestion (unpacking, manifest integrity, canonical digest,
coordinate) and pre-commit verification are separate modules with no
permissive fallback: with either adapter missing, `add` refuses with a named
error before any staging, journal, or index write. The default CLI binds both
production adapters. The pre-commit verifier consumes the publication sidecars
written by `publish` and applies the local `defPolicy` before the object or index
commit. Hosts that provide both adapters can install real `.wnlp` output from
`packBundle`; use the `publish` command to create the `.wnlp` bundle plus a
signed or explicitly unsigned sidecar.

### Definition publication policy

`defPolicy` is the local execution and installation policy for workflow
publication signatures. The settings file is
`$XDG_CONFIG_HOME/owenloop/settings.json` when `XDG_CONFIG_HOME` is non-blank,
otherwise `$HOME/.config/owenloop/settings.json`. To set the policy in the
settings file, write a JSON object such as:

```json
{
  "defPolicy": "enforce"
}
```

For a one-off CLI invocation, set `OWENLOOP_DEF_POLICY` in the environment, for
example `OWENLOOP_DEF_POLICY=enforce owenloop add widget.wnlp`. The local
precedence is explicit host-provided policy, then `OWENLOOP_DEF_POLICY`, then
the settings file, then the built-in default `warn`. An invalid environment or
settings-file value fails loudly; it never degrades to `off`.

When a host supplies an already-verified organization policy floor through the
`policyFloor` option seam, the floor is applied **after** that local precedence.
`unsignedDefs: warn` raises the minimum to `warn`; `unsignedDefs: refuse` raises
the minimum to `enforce`; the effective policy is the stricter of local policy
and the floor. **Therefore, local `off` no longer means “no enforcement” when a
verified org floor is present.** A local operator cannot use `off` to opt out of
a verified floor. A missing, malformed, unsigned, wrongly signed, or
under-scoped floor leaves the local policy unchanged.

The current CLI and production configuration do not load or verify a floor.
`policyFloor` is an injection seam only, so this feature is inert until a host
wires floor loading and verification into that seam.

The policy applies at install time and again at execution time. The following
table describes the local policy result before any verified floor is applied.
The table uses these verdicts:

- `verified` — the publication sidecar verifies against the bundle digest and a
  signer in the local trust root.
- `unsigned` — the bundle has no publication signature (including an explicit
  `.wnlp.unsigned` sidecar).
- `unverifiable` — verification could not be completed, such as when the trust
  root is missing or malformed.
- `invalid` — a present publication signature fails verification, including a
  digest or signer mismatch.

| publication verdict | `enforce` | `warn` | `off` |
|---|---|---|---|
| `verified` | Install succeeds; agent and command execution proceed. | Install succeeds; agent and command execution proceed. | Install succeeds; agent and command execution proceed. |
| `unsigned` or `unverifiable` | Install refuses; agent and command execution refuse. | Install warns to stderr and succeeds; agent execution warns and proceeds; command execution refuses. | Install succeeds silently; agent execution proceeds silently; command execution refuses. |
| `invalid` | Install refuses; agent and command execution refuse. | Install refuses; agent and command execution refuse. | Install refuses; agent and command execution refuse. |

**Command-worker hard rule.** A `worker: command` order requires full
enforcement in every policy value, including `off`: the definition must be
verified, the enrollment chain must be verified, and the signer scope must be
checked. `off` does not disable command-worker enforcement. `warn` and `off`
never allow an unsigned, unverifiable, or invalid definition to reach the
shell. The command check runs before the policy value is read, and a refusal
uses the normal `InstructionRefusal` path so the lease stops before command
execution. A policy floor cannot relax this gate; the gate also fails closed
regardless of any floor. If an execution host has no publication verifier
configured, the definition is `unverifiable`; command workers therefore refuse
rather than treating installed bytes as published trust.

The local SSHSIG trust root is
`$XDG_CONFIG_HOME/owenloop/allowed_signers`, or
`$HOME/.config/owenloop/allowed_signers` when `XDG_CONFIG_HOME` is blank. A
missing or malformed trust root is `unverifiable`, not `unsigned`.

### The two store roots

A store root holds exactly this layout:

```text
<root>/
  index.json                       # coordinate → {digest, pinned} index
  objects/
    sha256/
      <64-hex-content-digest>/     # one immutable object per digest
        …                          # the bundle's files
  .owenloop/                       # per-root lock + crash journal
    add.lock
    add.journal
  .owenloop-staging/               # transient staging (cleared on exit)
```

- **Project store root** = the resolved defs directory itself (`--defs`,
  `OWENLOOP_DEFS`, or `./workflows`). The project's pins are reviewable in
  git there, and the nested `objects/sha256/<digest>/` layout stays below
  the def loader's scan depth.
- **Global store root** = `<home>/.owenloop/workflows`. `--global` selects it;
  it cannot be combined with `--defs` (the global store has a fixed
  home-directory location, so an override would only create ambiguity —
  refused with a clear message). The global root is never used by the
  GitHub route.

**Injected home requirement.** `<home>` is the first non-blank value from the
caller-injected `HOME` and `USERPROFILE` environment variables (`HOME` wins).
The `.wnlp` bundle route uses the same injected home for its default external
recovery-marker directory, `<home>/.owenloop/recovery-markers`, even when the
bundle targets the project store. If neither variable is supplied, bundle
installation refuses before any object or index commit; it never falls back to
the process user's ambient home. `add --recover --global` has the same
requirement. Project recovery of a v2 fresh-install journal also refuses when
its recovery marker requires a home and neither variable is supplied.

Every object path derives ONLY from its validated digest (lowercase 64-hex).
Coordinates, source strings, and version text never join into a path.

### What an install does, in order

1. Read the bundle bytes (file or URL) *before* taking the lock — a slow
   download never holds the project lock. A local `.wnlp` must be a bounded
   regular file: missing, symlinked, non-regular, or over the 256 MiB cap
   (checked before *and* after the read) is refused naming the path as
   given. A URL fetch uses the same 5 min timeout, refuses redirects
   (`redirect: 'error'`) instead of following them silently, and streams
   through the same bounded reader.
2. Acquire the canonical root lock at `<root>/.owenloop/add.lock`. A GitHub
   install also retains its legacy cwd-derived lock for compatibility and, when
   the resolved `--defs` root differs from that cwd, acquires both locks in a
   fixed order. The canonical lock makes bundle installs from different cwd
   values serialize when they target one shared `--defs` root; the additional
   GitHub lock keeps the legacy route compatible.
3. Recover a prior interrupted install (before clearing staging — the
   backups a rollback needs live under the staging root).
4. Reread and validate the index **inside** the lock (a corrupt index is a
   hard error, never a silent reset).
5. Ingest via the bundle adapter: unpack into staging, check manifest
   integrity, compute the canonical digest, extract the full coordinate. A
   tampered or malformed bundle stops here — staging debris only, nothing
   committed.
6. Validate the staged tree with the engine's strict pass — the exact bytes
   that will be committed (parse/lint/validate/bounded `check` + the strict
   cross-def backstop). For a real `.wnlp`, validation loads the bundle's root
   `workflow.yaml` entrypoint directly; the package manifest `bundle.yaml` is
   not treated as a workflow definition. Any problem refuses the whole install
   and prints every reason.
7. Run the pre-commit verifier (after content validation, before any swap or
   index write). A rejection commits nothing.
8. Write the `applying` crash journal (v2 — its commit-point evidence is the
   hash of the post-install index bytes).
9. Atomically swap the staged object into `objects/sha256/<digest>`
   (retaining any displaced content on the commit handle), then harden it
   in place: files read-only (`0o444`), directories non-writable (`0o555`).
   Hardening is defense in depth, not the integrity proof — verification is.
   A hardening failure rolls the swap back; a partially hardened object is
   never committed. If the digest's object already exists, the install
   verifies the existing object through the ingest adapter and commits an
   index-only change instead (dedupe) — a corrupt existing object is a hard
   integrity error, never replaced and never fallen through.
10. Atomically write `index.json` — the **durable commit point**. Past here
    a crash rolls forward; before it, everything rolls back. An index-write
    failure rolls the directory state back and leaves the previous object
    and index exactly as they were.
11. Advance the journal to `finalizing`, discard the retained backup and
    staging, remove the journal, release the lock.

On success `add` prints the structured result:

```jsonc
{
  "ok": true,
  "source": "widget.wnlp",              // or the URL
  "level": "project",                    // or "global"
  "coordinate": "acme/widget@1.0.0",
  "digest": "<64-hex>",
  "objectPath": "<root>/objects/sha256/<64-hex>",
  "installed": true                      // false when deduplicated
}
```

**Conflict and re-install.** An existing coordinate at a DIFFERENT digest is
a conflict error — no implicit retarget; the original digest is retained and
nothing is written. An existing coordinate at the SAME digest deduplicates
(`installed: false`), verifying the existing object before trusting it.

**Crash recovery** is the same two-phase discipline as the GitHub route,
generalized: the v2 journal's commit-point test compares the hash of the
current `index.json` bytes against the journal's recorded metadata hash
(route-neutral — no GitHub ledger involved). A fresh v2 install also writes a
single-use external recovery marker under the user's recovery-marker directory
(default `<home>/.owenloop/recovery-markers`, derived from the injected home
described above) before the applying journal. If a crash leaves the destination
present with no staging or backup, recovery
discards that destination only when the marker exactly matches the store root,
destination segments, staging id, and `hadDest: false`; a missing or mismatched
marker refuses and preserves the destination and journal. `add --recover --global`
runs the store's recovery standalone against the global root with no network
and prints `{"ok":true,"recovered":false|true,"outcome":…}` exactly
like the project variant. A v1 (GitHub-schema) journal found at the global root
is refused fail-closed — there is no ledger there to vouch for it — and a
journal recorded against a *different* store root is refused rather than
trusting its absolute path. Refusals leave the journal in place as evidence.

### Resolving what is installed — two separate APIs

Resolution is deliberately split so execution code cannot accidentally call
human-name resolution. Both are library APIs (exported from the package
root); every successful resolution verifies the object through the ingest
adapter before returning a path — permissions and object shape on disk are
defense in depth, not an integrity proof.

- **Digest resolution (execution).** `resolveWorkflowDigest({digest,
  projectRoot?, globalRoot, verifier})` — digest only; no index and no
  workflow name participate. The project object path is tested first when a
  project root exists; an ABSENT project object may fall through to global,
  but a PRESENT project object that fails its type probe or verification is
  a hard integrity error — project tampering is never hidden by falling back
  to a valid global copy. When both levels hold the same digest, ONE result
  comes back (level `project`, with presence metadata), not two candidates.
  Absent at both levels ⇒ `object-missing` integrity error.
- **Coordinate resolution (human/CLI).** `resolveWorkflowCoordinate({coordinate,
  projectRoot?, globalRoot, verifier})` reads BOTH indexes, fail-closed (a
  corrupt index is a hard error, never silently empty). No entry at either
  level ⇒ a structured **not-found** error. The SAME digest at both levels
  deduplicates to one result (project path wins). DIFFERENT digests at the
  two levels ⇒ a structured **ambiguity** error carrying the coordinate and
  both digests — resolution never silently picks the project copy. An index
  entry whose object is missing or corrupt is an integrity error, never a
  returned path.

Store roots and object directories are probed with `lstat`, never `stat`:
a symlink or non-directory squatting at a root, an index path, or an object
path is refused outright, and reads never follow a link outside the
intended tree.

**GitHub-route compatibility.** The bundle route changes nothing about
`add <owner>/<repo>[@ref]`: the same inputs reach the same parser, the
`<owner>-<repo>-<hash>` namespace is untouched, `.owenloop/installed.json`
keeps its schema and validation, and an explicit `--defs`/`OWENLOOP_DEFS`
still installs through a symlinked defs dir (operator intent). The routes
share the canonical resolved-store lock, while the GitHub route retains its
legacy cwd-derived lock and journal for compatibility. Recovery checks both
journal locations and dispatches by journal version; a v2 store journal uses
`index.json` metadata and a v1 GitHub journal uses `installed.json` ledger
corroboration.

## Hub (`login` / `connect` / `push` / `logout`)

These four commands publish local workflow defs to a hosted **hub** (default
`https://api.owenloop.com`; override per-command with `--hub <url>` or the
`OWENLOOP_HUB` env var). They are the only network-bound commands besides
`add`, and they talk only to endpoints the hub exposes today — no new
service-side surface. The hub URL is normalized to its origin
(`scheme://host[:port]`); path/query are dropped. `https` is required for
every hub origin except the loopback hosts (`127.0.0.1`, `::1`, `localhost`),
which may use `http` for local development — a remote `http` URL is rejected at
normalization time so a plaintext origin can never be persisted as a credential
key or project binding. A legacy `hub.json` carrying a remote-http origin is
likewise refused at push time, with a hint to re-run `owenloop connect`. The CLI
also never follows an HTTP redirect from a hub — a 3xx response to any hub/auth
request is treated as an error — so a compromised or misconfigured hub cannot
bounce credentials or workflow YAML to another origin (same-origin validation
covers only the initial URL; a redirect would otherwise re-send the request body
cross-origin).

**Request timeouts.** Every hub call — OAuth discovery, client registration,
code exchange, token refresh, `whoami`, the workflow list, and each push — is
bounded by a 30s deadline; a stalled hub surfaces as a friendly `hub did not
respond within 30s` error instead of hanging. `OWENLOOP_HUB_TIMEOUT_MS`
overrides the budget (a test knob).

**Response-size cap.** Every hub/auth response body is read through the same
bounded streaming reader, capped at 8 MiB — hub responses are small JSON
round-trips, so a body advertising or streaming past that cap is refused (the
stream cancelled) rather than buffered, closing the same memory-exhaustion gap
on the hub path that the `add` download cap closes on the archive path.
`OWENLOOP_HUB_MAX_RESPONSE_BYTES` overrides the cap (a test knob).

### `login` — authenticate the CLI against a hub

Two ways to get a credential, both of which **verify before storing** (a token
that can't call the hub is never written to disk):

- **Loopback OAuth (default).** `owenloop login` binds a single-use catcher on
  `127.0.0.1:<random-port>`, dynamically registers a public client
  (`token_endpoint_auth_method: none`), opens your browser to the hub's
  authorize endpoint with an auth-code + PKCE (S256) challenge, and exchanges
  the returned code for an access/refresh token. State is checked on the
  callback (CSRF guard) and the flow times out after 5 minutes. The exact
  loopback `redirect_uri` is sent in the registration because the hub matches
  redirect URIs by exact string (no RFC 8252 variable-port allowance).
- **Paste a token.** `… | owenloop login --with-token` reads a single token
  from stdin (never argv, so it stays out of your shell history and the process
  table). An `olp_`-prefixed **agent** token or an `mcpat_`-prefixed **access**
  token is accepted; anything else is rejected before any network call.

**Credential slots (`--as`).** A hub origin holds more than one credential, each
in a named **slot**, so a human sign-in and any number of agent tokens coexist
on the same machine without overwriting each other:

| `--as` value | slot | who it is |
|---|---|---|
| *(omitted)* | depends on the credential — see below | |
| `human` | `human` | you, via loopback OAuth or a pasted `mcpat_` token |
| `agent` | `agent:default` | an agent token with no account name |
| `agent:<account>` | `agent:<account>` | a named agent, e.g. `agent:ci` |

An account name is 1–64 characters matching `[A-Za-z0-9][A-Za-z0-9._-]*`;
anything else is a usage error. With `--as` omitted, a credential lands in the
slot it belongs to: loopback OAuth and pasted `mcpat_` tokens go to `human`,
`olp_` agent tokens go to `agent:default`. The two contradictions are refused as
usage errors **before any network call**, so nothing unverified is stored:
`--as human` with an `olp_` token, and `--as agent[:…]` with an OAuth or pasted
human credential. `login`'s JSON reports the `slot` it wrote.

`connect`, `push`, and `logout` take the same `--as` and act on exactly that
slot — there is no fallback to another slot, so `push --as agent:ci` with an
empty `agent:ci` fails rather than quietly pushing as you. `logout` without
`--as` removes only `human`.

**Where the credential lands.** On macOS it goes into the login **Keychain**
(`security`, service `owenloop:<hub origin>`, one item per slot, with the slot
name as the account) with the secret fed over stdin, never on the command line.
Elsewhere — or with `OWENLOOP_NO_KEYCHAIN=1` — it falls back to a `0600` file at
`$XDG_CONFIG_HOME/owenloop/credentials.json` (or `~/.config/owenloop/…`) inside
a `0700` directory, keyed `hubs[origin][slot]`. Either way the token is never
written into the repo or a `.env`. `login`'s JSON reports `storage: "keychain" |
"file"` and `kind`, and prints **no token value** to stdout/stderr. A credential
stored by an earlier release used a different keying and is **not** read; there
is deliberately no migration, so re-run `owenloop login`.

The backend is chosen once from your platform and env and then used for every
read and write — a keychain-backed CLI never silently drops to the file store.
If the keychain write fails (locked or unavailable), `login` errors out instead
of writing the secret elsewhere: unlock the keychain, or set
`OWENLOOP_NO_KEYCHAIN=1` to select the file store up front. Programmatic hosts
can read (only read) a stored credential through the same backend logic via the
package's exported `readStoredCredential` — see
[Embedding](embedding.md#whats-exported).

**Serializing writes (`credentials.lock`).** A store write — a refreshed OAuth
token, or a `login`/`logout` that stores or deletes a slot — is serialized by a
lockfile at `credentials.lock`, a sibling of `credentials.json` in the config
dir (created for the keychain backend too, since the race it closes is
backend-independent). The concern is a token-refresh race: two owenloop
processes hitting an expiring OAuth token at once would each POST a refresh and
each persist, and because refresh tokens rotate, the second write clobbers the
first with a token whose refresh link is already spent — silently killing the
credential. Under the lock a process re-reads the slot after acquiring it and,
if another process already refreshed, **adopts** that fresh token instead of
refreshing again — one network refresh, one write, no lost token. The lock
matters only for OAuth refresh and store/delete; read paths and the external-
command mode (which never writes the local store) do not take it. Staleness is
liveness-based: a lock held by a dead same-host process is reclaimed at once, an
unparseable or pid-less lockfile is reclaimed once older than the ~30s TTL, and
a lock held by a live process is never age-reclaimed. If the lock can't be
acquired within the wait budget the CLI fails loudly (`another owenloop process
is using the credential store … — timed out waiting after Ns`) rather than
refreshing unlocked. Three test knobs override the timings:
`OWENLOOP_CRED_LOCK_WAIT_MS` (default 45000), `OWENLOOP_CRED_LOCK_STALE_MS`
(default 30000), and `OWENLOOP_CRED_LOCK_POLL_MS` (default 100). No token value
ever appears in the lockfile or the timeout message.

**Supplying the credential from your own tooling.** If your secrets live in a
secret manager, or you run on a host with no keychain, set
`OWENLOOP_CREDENTIAL_COMMAND` to a shell command line that prints a credential.
It takes precedence over both stores, so the full order is **external command →
keychain → file**, still chosen once. Nothing is auto-detected: the variable is
the only way to turn this on, and an unset or blank value leaves everything
exactly as described above.

The contract:

- The command runs as `/bin/sh -c "<your command>"`, so a pipeline or arguments
  work (`my-helper --hub prod`).
- Context arrives in the **environment**, not on the command line:
  `OWENLOOP_CREDENTIAL_ORIGIN` (the normalized hub origin) and
  `OWENLOOP_CREDENTIAL_SLOT` (`human` or `agent:<account>`). Your command should
  return the credential for exactly that pair.
- `OWENLOOP_CREDENTIAL_COMMAND` is **removed** from the command's own
  environment, so a helper that shells back into `owenloop` cannot recurse.
- It must print a credential as a JSON object on **stdout** — the same shape
  stored in `credentials.json`, e.g. `{"kind":"agent","accessToken":"olp_…"}` or
  a full `{"kind":"oauth", …}` object. A bare token is not accepted. stdout is
  captured and never logged; the command's **stderr passes straight through** to
  your terminal, so put diagnostics there — never the secret.
- It must finish within 10s, overridable with
  `OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS`.

A configured command is **authoritative**: a nonzero exit, a timeout, empty
output, or output that is not a well-formed credential is a hard error naming
the hub and the slot — never a quiet fall back to a keychain or file entry,
which would risk handing back a stale key. For the same reason `login` refuses
to run while the variable is set (unset it if you want to use the local store
again), and a refreshed OAuth token is not written to the local store — your
command owns the credential's lifecycle. `logout` still clears local entries.

Both branches verify the credential against `GET /api/whoami` before storing
it — a `401` there means the credential is never written to disk. On success
`login`'s JSON reports the org and identity it authenticated as (`org`,
`orgId`, `identity`, and `email` when the hub returns one), read straight from
`whoami`.

**Recording the hub for `owenloop mcp` (`~/.owenloop/config.json`).** After the
credential above is verified and stored, `login` makes one more best-effort
write: it records the hub origin it just authenticated against in
`~/.owenloop/config.json` (`{"version": 1, "hub": "<origin>"}` — never a
secret, just the origin). This file is separate from both the credential store
above and from `owenloop setup`'s `~/.config/owenloop/settings.json`; its only
reader is `owenloop mcp`'s [origin resolution](#choosing-the-hub-origin),
which needs to know your hub without enumerating the credential store (the
Keychain and external-command backends can't be listed at all — see below). A
failure to write this file is a **warning** printed to stderr, never a fatal
error and never blocking `login` itself, since the credential is already
safely stored by the time this write is attempted. Logging into a second hub
overwrites this file — "last login wins" — so if you routinely switch between
hubs, pass `--hub` explicitly to `owenloop mcp` (or set `OWENLOOP_HUB`) rather
than relying on whichever `login` ran most recently.

### `connect` — bind a project to a hub

`owenloop connect` writes `.owenloop/hub.json` recording which hub this project
publishes to, after re-verifying the stored credential against `GET
/api/whoami`. Run `login` first. The JSON reports the same org/identity fields
as `login`; re-connecting to the **same** origin reports no `switchedFrom`,
switching to a **different** hub reports `switchedFrom: <old origin>` and
rebinds the project to the new one.

A symlinked project `.owenloop` directory is refused with a clear error rather
than followed: a hostile checkout cannot ship `.owenloop -> /elsewhere` to
redirect the `hub.json` write outside the project (filesystem-isolation
guarantee). The same refusal covers the default `state.db` FILE (and its SQLite
`-wal`/`-shm`/`-journal` sidecars) inside a real `.owenloop` — a symlinked db
file would otherwise redirect the store's writes, since SQLite follows file
symlinks.

### `push` — publish local defs to the bound hub

`owenloop push [<defName>...]` publishes the project's workflow defs (all of
them, or just the named ones) to the hub the project is `connect`ed to. It
reuses the **exact** all-or-nothing validation gate `add` uses — lint, validate,
and a bounded `check` — across every selected def before a single byte is sent;
any definite defect aborts the whole push. stdout is machine-parseable JSON;
the human-readable diff (`+ new`, `~ changed`, `= unchanged`, `! failed`) goes
to stderr.

**Idempotency is server-side truth, not a client ledger.** `push` fetches the
hub's own view of every def (`GET /api/workflows`, which reports each def's
`hash`) and diffs local content against it directly — there is no
`.owenloop/hub.json` push ledger to go stale, drift, or need migrating. A def
whose content hash matches the hub's is `unchanged` and is never sent at all.
`--dry-run` reports the plan (`new`/`changed`/`unchanged`, and `wouldPush`)
without sending anything. A real push that does go out can still come back
`noop`: the hub's `create_workflow` is itself idempotent by content hash, so
if server truth and local truth briefly disagree (e.g. `--force` re-sending
content that's actually already there), the hub reports `{unchanged: true}`
and no new version is minted — `push`'s JSON distinguishes `pushed`
(version-forwarded) from `noop` (server said unchanged) from `unchanged`
(skipped locally, never sent). `--force` re-sends every selected def
regardless of the local diff. A `<defName>` that doesn't resolve is an error;
an `{ok:false}` (or a malformed `2xx` whose identity fields don't match the
pushed def) from the hub mid-batch records that def under `failed`, keeps the
defs that did land, and exits 1. A `429` (rate limited) instead halts the whole
batch: the current def is recorded as `failed`, the not-yet-attempted remainder
is reported under a `skipped` output key, and any `Retry-After` the hub sent is
surfaced in the error.

The def hash is computed by re-parsing the raw YAML with no checkout-specific
`baseDir` — the same canonicalization the hub applies — so it's portable
across checkouts and machines by construction: a fresh clone at a different
path diffs identically to the original checkout, with no one-time migration
or forced re-push. It's stable only within a pinned engine version; a
version bump that changes how defs canonicalize will read as `changed` on the
next push, not as an error, since `create_workflow` is idempotent either way.

On a `401`, an OAuth credential is refreshed once and the request retried; an
agent (`olp_`) token has no refresh path, so a `401` is a hard "re-mint it"
error.

**Include and bodyFile limitations.** A def whose file uses `include:` is
refused (`uses include:, not hub-pushable`): the hub's `create_workflow`
parses the raw YAML without include expansion, and a re-serialized expanded
def isn't round-trippable. A def using `bodyFile:` is refused the same way
(`uses bodyFile:, not hub-pushable`) — there's no checkout `baseDir` to
resolve the external file against once the YAML leaves this machine. Inline
both before pushing.

### `publish` — pack and publish a workflow bundle

```text
owenloop publish <source-dir> [--output <bundle.wnlp>] [--source <json>] [--unsigned]
```

`publish` is separate from both [`bundle pack`](#bundles) and [`push`](#push--publish-local-defs-to-the-bound-hub). It packs one source directory with the same deterministic `packBundle` implementation as `bundle pack`, then publishes the bundle beside a local publication sidecar and, optionally, a signed origin sidecar. The command requires the project to be bound with `owenloop connect`, because the binding supplies the hub origin used to select the local author key.

Signed publication is the default. In signed mode, `publish` requires the human principal signing key for the bound hub. Run `owenloop setup` before the first signed publication. `publish` never creates or repairs a signing key: an older key store that already contains the key but lacks the non-secret `<hash>.ref` pointer must be repaired by a setup run, whose `ensure` step backfills the pointer without regenerating or replacing the private key. If the author-key reference or key record is missing, `publish` fails and suggests `owenloop setup` or the explicit unsigned mode; the command does not silently downgrade to unsigned output.

In signed mode, `publish` confirms the existing key and probes the signer before `packBundle` runs, then signs the publication record before any bundle or sidecar is written. A signing failure therefore leaves no half-published artifact. The signature covers a DSSE publication record whose `digest` is the lowercase SHA-256 digest of the uncompressed canonical tar inside the `.wnlp` file. When `--source <json>` is supplied, the command signs a separate origin record with the same signer and digest, then writes `<output>.origin.dsse` beside the publication sidecar. The remote hub is not involved in this local signing operation and never produces or completes either signature.

`--source` is signer-supplied provenance, not a hub-derived label. The JSON value must be one of these closed forms:

- `{"kind":"git","repo":"<repo>","commit":"<40- or 64-hex commit SHA>"}`;
- `{"kind":"console","user":"<authoring user>"}`, which requires a client-side signing ceremony; or
- `{"kind":"agent","agent":"<agent identity>","session":"<session>"}`.

The origin record is part of the signed content. The hub or another relay stores and relays the signed record but cannot write, derive, default, or stamp an origin value. `attesterKeyId` in the record is only a candidate-selection hint; verification cross-checks the hint against the signer that produced the verified signature. `--source` cannot be combined with `--unsigned`. The CLI currently rejects the `console` form because that form requires a client-side signing ceremony rather than this command's local signing path.

`--unsigned` is an explicit opt-in. Unsigned mode still packs the canonical bundle, but writes an unauthenticated author-intent marker rather than a DSSE envelope. Anyone can write such a marker; consumers must treat missing and unverifiable signatures as unsigned regardless of whether the marker is present. Publication and unsigned sidecars are mutually exclusive:

- signed mode writes `<output>.wnlp.dsse` and removes a stale `<output>.wnlp.unsigned`;
- `--unsigned` writes `<output>.wnlp.unsigned` and removes a stale `<output>.wnlp.dsse`.

A signed publish without `--source` removes a stale `<output>.origin.dsse`. Unsigned mode also removes a stale origin sidecar because an unsigned origin would only be an unsigned label.

The output defaults to `<package-name>-<version>.wnlp` next to the source directory. `--output` must name a path outside the source directory. Existing regular output and sidecar files may be replaced; directories and other non-regular paths are rejected.

Successful invocations print exactly one machine-readable JSON object to stdout. Signed output without an origin has this shape:

```json
{
  "ok": true,
  "bundle": "/absolute/path/report-1.2.0.wnlp",
  "digest": "<64 lowercase hex characters>",
  "name": "report",
  "version": "1.2.0",
  "signed": true,
  "envelope": "/absolute/path/report-1.2.0.wnlp.dsse"
}
```

When `--source` is supplied, signed output also includes `"origin": "/absolute/path/report-1.2.0.wnlp.origin.dsse"`. Unsigned output has the same `ok`, `bundle`, `digest`, `name`, and `version` fields, with `"signed": false` and `"marker": "/absolute/path/report-1.2.0.wnlp.unsigned"` instead of `envelope`. Diagnostics and failures go to stderr and exit nonzero. `bundle pack` and `push` are unchanged by this command.

Exact-match redirect URIs (no RFC 8252 variable-port allowance) and no
device-code grant remain recorded follow-ups on the service, not gaps in the
CLI.

### `agent new` — mint an agent token into a slot

`owenloop agent new <name>` mints a new Scoped Identity on the hub (`POST
/api/mint_agent_token`, authenticated as your **human** credential) and stores
the returned `olp_` token in the local credential slot `agent:<name>` — the same
slot `login --as agent:<name>` writes and `push --as agent:<name>` reads. Use it
to provision an agent token without pasting one by hand: the mint and the store
happen in one step, and you never handle the secret.

**The token is never printed.** The minted `olp_` token goes process → store
only — it never appears on stdout, stderr, in an error, or in a log (identity
model §6, "rule of gates"). The confirmation JSON is built from a whitelist of
**non-secret** fields only: `hub`, `name`, `slot`, `crews` (the resolved crew
names), `scopes` (the minted token's scopes — `["work"]` by default, or whatever
`--scopes`/`--shift` selected), `storage` (`keychain` | `file`), `agentId` (the
Scoped Identity's id), and `tokenId` (a revocation handle). To use the Scoped Identity afterwards,
pass `--as agent:<name>` to `connect`/`push`; to revoke it, use its `tokenId`
on the hub.

**Which hub gets minted on (`--hub`).** Resolution is deliberately narrow —
minting on the wrong org is not undone by a retry:

1. `--hub <origin>` if given (normalized the same way as everywhere else).
2. Otherwise the **one** hub your credential *file* stores — if exactly one is
   present, it's used.
3. Otherwise the command **exits 2** naming both remedies (pass `--hub`, or log
   in to exactly one hub); when more than one hub is stored their origins are
   listed back so you can pick.

Unlike other commands this does **not** fall back to `OWENLOOP_HUB` or the
built-in default hub — silently defaulting a mint would risk minting on the
production hub while you're logged into a dev one. This is deliberately
stricter than [`owenloop mcp`'s origin resolution](#choosing-the-hub-origin):
`mcp` exposes both reads and writes, including `create_agent` (which mints and
stores an agent token), `create_workflow`, `publish_event`, `submit`,
`stage_enrollment`, and crew mutations. The default remains acceptable for
`mcp` because each tool call authenticates against the resolved origin; when no
human credential exists there, the existing `loginHint` surfaces the origin
and asks for `owenloop login --hub <origin>` before the tool-specific action
runs. If a credential does exist at an unintended origin and `create_agent`
mints there, the stored agent token is revocable; `--hub` and `OWENLOOP_HUB`
remain available when the operator wants to avoid inference. `agent new`
**mints** a new credential directly, a side effect a retry cannot undo, so it
stops at step 3 instead of ever guessing. Note that hub enumeration itself is
**file-store only**: the keychain and the external-command backend cannot list
their entries, so on such a machine step 2 cannot enumerate the store and you
must pass `--hub`.

**`--crews <a,b>`.** A comma-separated list of crew names the token is granted
on (trimmed, empties dropped). Omit the flag to let the hub default the token to
the minter's personal crew; `--crews ""` (or `--crews ,`) is a usage error. Crew
names are validated by the hub, not the client.

**`--scopes <a,b>` / `--shift`.** A comma-separated list of scopes the minted
token carries (trimmed, empties dropped). Omit both flags to mint **work-only**
(the default). `--shift` is shorthand for `--scopes work,run` — the identity
a service account needs to both serve and *start* runs. The two flags are
mutually exclusive (`--scopes … --shift` together is a usage error), and
`--scopes ""` (or `--scopes ,`) is a usage error. Scope names are validated by
the hub, not the client.

**A configured external credential command blocks the mint.** If
`OWENLOOP_CREDENTIAL_COMMAND` is set, that command — not the local store —
supplies credentials for the hub, so `agent new` refuses up front (it has
nowhere to write the minted token); unset the variable to use the local store.
This check, the name validation, the empty-`--crews` check, the empty-`--scopes`
check, and the `--scopes`/`--shift` mutual-exclusivity check all run
**before** any network call, so a refusal never mints a server-side token first
— a mint that then failed to store would burn the agent name permanently.

**Exit codes.**

| code | meaning |
|---|---|
| `0` | minted and stored |
| `1` | generic failure — invalid or already-taken name, crew/shape rejection, network timeout, or a token that minted but couldn't be stored |
| `2` | the hub couldn't be resolved (no `--hub` and not exactly one stored hub) |
| `3` | the human credential is missing or irrecoverable — the error names the remedy `owenloop login --hub <origin>` |

## Capability routes

A **capability route** maps a workflow-def **capability** (a logical capability tag a
def author writes, like `gpu` or `repo-access`) to a **crew** on one hub org.
Def authors write capabilities; an org admin binds each capability to at least one crew.
That indirection is what keeps deployment facts out of portable defs — see
[`capabilities:`](authoring.md#capabilities--logical-capability-tags) in the authoring guide
for the step-side declaration.

**A route is one `(capability, crew)` PAIR, and a capability may bind MANY crews.** The
pair is the unit that is created and destroyed: `capability bind` adds one, `capability unbind` removes one, and `capability list` returns one row per pair — so a capability bound
to three crews appears as three rows. A **dangling route** is one whose crew
row was deleted; it survives in the table, routes nothing, and never widens
access. A capability with **zero live routes** is **parked**: its steps wait.

**Resolution is live.** `start_run` only *checks* that every capability a run's steps
use is currently bound — it stamps no crew for a capability-routed step. Every later
routing decision (which Shift is offered the step, and whether a claim is
allowed) re-reads the route table as it stands at that moment.

**These edits take effect on work already in flight.**

- **Adding.** Running `capability bind` on a capability that is **already bound** ADDS the
  named crew — it never displaces a crew already bound. Adding widens who can
  serve the capability, live at the next poll of every in-flight run using it. Re-adding
  a pair that is already there is a normal success, not an error (`alreadyRouted:
  true`).
- **Removing.** Running `capability unbind` removes exactly ONE pair. If the capability still
  has other live routes, it simply routes to a narrower set and nothing pauses.
  If the removal takes away the **last live** route, the capability is **parked**:
  the in-flight steps that use it are offered to no Shift and accept no
  claim — until it is bound again. Nothing is lost; the work resumes on re-bind.
  `remainingCrewIds: []` on stdout is that signal, and stderr says so in words.
- **Retargeting is two acts, not one.** There is no retarget command: add the new
  crew, then remove the old one. Each is separately audited on the hub, and in
  between **BOTH** crews serve the capability. The CLI deliberately does not chain the
  two for you — the intermediate state is a real state an operator may want to sit
  in, and collapsing it would hide a widened access window.

A capability route is **not** the project↔hub binding `owenloop connect` writes to
`.owenloop/hub.json` — that one records which hub *this project directory*
publishes to; a capability route is an org-scoped capability→crew row on the hub.

### `capability bind <capability> <crew>`

`POST /api/add_capability_route`, authenticated as your **human** credential;
requires the **admin** role on the hub. ADDS the crew named `<crew>` to
`<capability>`'s routes. `<crew>` is a crew **name** — the hub resolves it to a crew
id; the CLI does no crew lookup and performs no client-side validation of either
argument (the hub is the enforcement of record).

**Adding is idempotent per pair.** Re-adding a `(capability, crew)` pair that is
already bound is a normal success — the hub answers `200` with `alreadyRouted:
true` and changes nothing (the original row keeps its creator and timestamp).
`routedCrewCount` reports how many **live** crews the capability binds after the write.

### `capability unbind <capability> <crew>`

`POST /api/remove_capability_route`, authenticated as your **human** credential;
requires the **admin** role on the hub. Removes the ONE `(capability, crew)` route
you name. `<crew>` is **required**: a capability may bind many crews, so a capability-only
removal would unbind more than you asked for.

`<crew>` accepts the crew's **name**, or its raw **`crew_id`**. The raw-id form
is the only way to remove a **dangling** route — one whose crew row was
deleted, so there is no name left to resolve. `capability list` shows such a row
with `crewName: null`; take its `crewId` from there.

**`rm` is idempotent.** Removing a pair that is **not** bound is a normal
success — the hub answers `200` with `removed: false` rather than a `404` — and
the CLI prints a full document plus a stderr line saying nothing was removed. A
script can call `capability unbind` unconditionally without branching on whether the
pair was bound. On that tolerant path `crewId` is `null`, because the argument
matched neither a live crew name nor one of the capability's own rows.

**Removing the last live route parks the capability**, and stderr says so. See
"These edits take effect on work already in flight" above.

### `capability list`

`GET /api/capability_routes`, authenticated as your **human** credential. Lists the
org's routes, ONE row per `(capability, crew)` pair ordered by capability then crew id —
so a capability bound to several crews appears as several rows. An org with no
routes yet is a normal success (exit 0) with an empty `routes` array.

A row whose `crewName` is `null` is a **dangling route**: the crew it names was
deleted. Such a row routes nothing and never widens access, and it is shown
rather than hidden precisely so you can clean it up — remove it with `capability unbind
<capability> <crewId>`.

**Flags.** `--hub <url>` only (plus the global `--db`/`--defs`).

**Which hub gets acted on (`--hub`).** Resolution is deliberately narrow — the
same stance `agent new` takes, because a route written against the wrong org
is not undone by a retry, and under live resolution it also moves in-flight
work:

1. `--hub <origin>` if given (normalized the same way as everywhere else).
2. Otherwise the **one** hub your credential *file* stores — if exactly one is
   present, it's used.
3. Otherwise the command **exits 2** naming both remedies (pass `--hub`, or log
   in to exactly one hub); when more than one hub is stored their origins are
   listed back so you can pick.

This does **not** fall back to `OWENLOOP_HUB` or the built-in default hub. Note
that hub enumeration is **file-store only**: the keychain and the
external-command backend cannot list their entries, so on such a machine step 2
cannot enumerate the store and you must pass `--hub`.

**Printed JSON.** stdout is exactly one whitelisted JSON document per
invocation, built from named fields — never a raw hub body — so `| jq` always
works. Human progress lines (the two `capability unbind` warnings) go to stderr only.

| subcommand | stdout |
|---|---|
| `capability bind` | `{ "ok": true, "hub": "<origin>", "capability": "gpu", "crew": "ml-crew", "alreadyRouted": false, "routedCrewCount": 2 }` |
| `capability unbind` | `{ "ok": true, "hub": "<origin>", "capability": "gpu", "crewId": "crw_1", "removed": true, "remainingCrewIds": ["crw_2"] }` |
| `capability list` | `{ "ok": true, "hub": "<origin>", "routes": [ { "capability": "gpu", "crewId": "crw_1", "crewName": "ml-crew", "createdBy": "u_1", "createdAt": 1738000000000 } ] }` |

Every added field carries the **hub's own name**, verbatim — the same words its
audit log and the web console use — so correlating stdout against them never
needs a translation step.

- `alreadyRouted` (`capability bind`) — was this exact `(capability, crew)` pair already
  bound before the call? `false` means the pair was created by it.
- `routedCrewCount` (`capability bind`) — how many **live** crews the capability binds
  after the write. A dangling route routes nothing and is not counted.
- `removed` (`capability unbind`) — did this call actually remove a pair? `false` is the
  tolerant "it was never bound" case, not an error.
- `remainingCrewIds` (`capability unbind`) — the **live** crews the capability still binds.
  `[]` means the capability is now **parked**: `jq '.remainingCrewIds | length == 0'`.
  It can be `[]` while a dangling row survives, because such a row routes nothing.
- `crewId` (`capability unbind`) — the crew the hub resolved your `<crew>` argument to.
  It is `null` on the tolerant `removed: false` path, where the argument matched
  neither a live crew name nor one of the capability's own route rows. `capability unbind`
  never prints a crew *name*: `remove_capability_route` does not return one, and
  inventing one from argv would not be the hub's answer.
- `capability` and `crew` (`capability bind`) are the values the **hub** echoed back, not
  your argv: if the hub normalized either, stdout tells the truth about what was
  stored.

**Exit codes.**

| code | meaning |
|---|---|
| `0` | the crew was added to the capability (or was already bound), the route was removed (or was already absent), or the routes were listed |
| `1` | runtime or hub error — an unknown crew name (`capability bind` only; `capability unbind` answers a tolerant `removed: false` instead), a capability that fails the hub's name rules, a `403` for a non-admin, a malformed response, or a network timeout |
| `2` | the hub couldn't be resolved (no `--hub` and not exactly one stored hub) |
| `3` | the human credential is missing or irrecoverable — the error names the remedy `owenloop login --hub <origin>` |

## Crews

A **crew** is an org-scoped queue that agent work is stamped to. Every hub org
can have, in addition to any crews an admin creates, one **orphan crew** (name
`orphan:unrouted`, `kind: "orphan"`) that the hub itself owns as the landing
zone for work whose crew was deleted out from under it. It is materialized
**lazily**, the first time a crew holding stamped work is deleted — an org
that has never deleted a crew with stamped work has no orphan crew at all, and
`crew list` shows none. Once it exists, `crew list` includes it — it is
marked, never hidden, via a derived `orphan: true` boolean on its row (see the
Printed JSON table below).

This family is independent of [capability routes](#capability-routes): a capability routes
to a crew by *name*, and a crew is where agent work actually queues. Deleting a
crew a capability still points at does not error — the capability's routing simply
resolves nowhere useful until it is rebound.

### `crew list`

`GET /api/crews`, authenticated as your **human** credential. Lists the org's
crews, each with its member rows (`principalKind`/`principalId`/`addedBy`/
`addedAt`). An org with no crews at all — including one that has never
materialized an orphan crew — is still a normal success (exit 0) with an empty
`crews` array.

### `crew new <name> --kind personal|shared [--owner <memberId>]`

`POST /api/create_crew`, authenticated as your **human** credential; requires
the **admin** role on the hub, **or** — for `--kind personal --owner
<memberId>` where `<memberId>` is the caller's own member id — no admin role
at all: a human may self-service additional personal crews for themself
without being an admin (`assertPoolMutationAllowed`, hub-core
`manage-crews.ts:211-214`). Every other combination (a `shared` crew, or a
`personal` crew owned by someone else) still requires admin. `--kind` is **required** but its value is
forwarded to the hub **verbatim and unvalidated** — the hub is the enforcement
of record for which kind values are legal (today `personal`/`shared`; `orphan`
is reserved for the hub's own crew). `--owner <memberId>` is optional and is
omitted from the request body entirely when not given — a `personal` crew
with no owner is the hub's own error to raise, not a client-side rule
duplicated here.

### `crew rm <crewId>`

`POST /api/delete_crew`, authenticated as your **human** credential; requires
the **admin** role on the hub for every crew kind, including a personal one —
`deletePool` bypasses the self-service gate that `crew new`/`crew member
add`/`crew member rm` use, and is admin-only unconditionally
(`manage-crews.ts:629`). Deletes the crew. The crew's **membership rows are
deleted outright, not moved** — `deleteAllPoolMembers` (`manage-crews.ts:706`)
runs unconditionally in the same transaction, whether or not any stamps
transfer; `membersRemoved` on stdout is a count of those deletions, since the
orphan crew's own membership is derived (always the org's current admins) and
cannot accept arbitrary members. Only the crew's **run stamps and
queued/running work** move to the org's orphan crew — memberships are never
among what moves.

**`rm` is idempotent.** Deleting a `<crewId>` that does not exist is a normal
success — the hub answers `200` with `deleted: false` rather than a `404` —
and the CLI prints this honestly (see below), plus a stderr line naming the
crew id, rather than inventing an error.

**Like [`capability unbind`](#capability-unbind-capability-crew), `crew rm` prints its tolerant
boolean on stdout** — `deleted` here, `removed` there. Both families report
honestly whether the call actually changed anything, and both narrate the
no-op case on stderr, so a script can branch on the boolean and a human reading
the terminal is told in words.

**The transfer fields are present on stdout if and only if the wire sent
them** — `membersRemoved`, `orphanCrewId`, `orphanCrewName`,
`stampsTransferred`, `runsTransferred` (an array of run ids, not a count), and
`runningRunsTransferred` (the subset still running, also an array) are never
defaulted to `0`/`null`/`[]`. Their absence means nothing moved; their
presence means a transfer happened, and stderr also gets a one-line human
summary naming the destination crew.

### `crew member add <crewId> <principalKind> <principalId>`

`POST /api/add_crew_member` authenticated as your **human** credential;
requires the **admin** role on the hub, **or** the owner of the personal crew
being acted on (same self-service carve-out as `crew new`, gated on the
fetched crew row rather than the raw request — `manage-crews.ts:300`). Adds
`<principalId>` (a member id or an agent id) to the crew as a
`<principalKind>` (`member` or `agent`) member. `<principalKind>` is forwarded
verbatim and unvalidated, same stance as `--kind` on `crew new`.

**The hub refuses this outright against the org's orphan crew, for every
caller — including an admin.** `assertNotOrphanPool` (`manage-crews.ts:307`)
throws before the add ever reaches the membership table, and it is a `400`,
never a `403`: the refusal is identity-independent (true for every caller, not
a permissions question), so a `403` would wrongly point the caller at their
own role. The orphan crew's membership is derived — always the org's current
admins, reconciled automatically on every membership change — and cannot be
edited directly.

### `crew member rm <crewId> <principalId>`

`POST /api/remove_crew_member`, authenticated as your **human** credential;
requires the **admin** role on the hub, **or** the owner of the personal crew
being acted on (`manage-crews.ts:356`). Removes `<principalId>` from the crew.

**`member rm` is idempotent**, mirroring `crew rm`: removing a principal that
was never a member of `<crewId>` is a normal `200` with `removed: false`, never
a `404`. The CLI prints `removed: false` on stdout and a stderr line naming
the principal and crew, rather than treating it as an error.

**Same orphan-crew refusal as `crew member add`.** Targeting the orphan crew
is a `400` here too (`assertNotOrphanPool`, `manage-crews.ts:363`), for every
caller including an admin, and for the same reason: the membership is derived,
not editable.

**Flags.** `--hub <url>` only (plus the global `--db`/`--defs`), except `crew
new`, which also takes `--kind` (required) and `--owner` (optional).

**Which hub gets acted on (`--hub`).** Identical resolution to the capability-route family: `--hub` if given, else the one hub your credential file stores, else
exit 2 naming both remedies (and, on a multi-hub machine, listing the stored
origins). No fallback to `OWENLOOP_HUB`
or the built-in default hub; hub enumeration is file-store only.

**Printed JSON.** stdout is exactly one whitelisted JSON document per
invocation — never a raw hub body — so `| jq` always works. Human-facing
lines (the tolerant-false notices, the transfer summary) go to stderr only.

| subcommand | stdout |
|---|---|
| `crew list` | `{ "ok": true, "hub": "<origin>", "crews": [ { "id": "crw_1", "name": "team-a", "kind": "shared", "ownerMemberId": null, "createdBy": "u_1", "createdAt": 1738000000000, "orphan": false, "members": [ { "principalKind": "member", "principalId": "u_2", "addedBy": "u_1", "addedAt": 1738000000000 } ] } ] }` |
| `crew new` | `{ "ok": true, "hub": "<origin>", "crewId": "crw_1", "name": "team-a", "kind": "shared", "ownerMemberId": null }` |
| `crew rm` (no transfer) | `{ "ok": true, "hub": "<origin>", "crewId": "crw_1", "deleted": true, "membersRemoved": 2 }` |
| `crew rm` (with transfer) | `{ "ok": true, "hub": "<origin>", "crewId": "crw_1", "deleted": true, "membersRemoved": 2, "orphanCrewId": "crw_orphan", "orphanCrewName": "orphan:unrouted", "stampsTransferred": 5, "runsTransferred": ["run_1", "run_2"], "runningRunsTransferred": ["run_2"] }` |
| `crew rm` (unknown id) | `{ "ok": true, "hub": "<origin>", "crewId": "crw_bogus", "deleted": false }` |
| `crew member add` | `{ "ok": true, "hub": "<origin>", "crewId": "crw_1", "principalKind": "member", "principalId": "u_2" }` |
| `crew member rm` | `{ "ok": true, "hub": "<origin>", "crewId": "crw_1", "principalId": "u_2", "removed": true }` |

**Exit codes.**

| code | meaning |
|---|---|
| `0` | the crew/membership was listed, created, removed (or was already absent) |
| `1` | runtime or hub error — an unknown crew id on a member add/rm, a crew with active work refusing deletion, a `403` for a non-admin, a malformed response, or a network timeout |
| `2` | the hub couldn't be resolved (no `--hub` and not exactly one stored hub) |
| `3` | the human credential is missing or irrecoverable — the error names the remedy `owenloop login --hub <origin>` |

## `setup` — onboard a machine

`owenloop setup` is the one-shot onboarding command. It runs seven ordered steps.
Depending on the machine state, setup may store the human credential, mint or
rekey and store a Scoped Identity credential, ensure the three principal
signing keys, relay a signed machine enrollment grant, and write only
`hubOrigin` in the execution settings file while preserving its other keys.
The plugin step probes and, when needed, converges the bundled `owenloop` plugin
for each available harness: Claude Code and Codex. Plugin convergence is
non-fatal and setup continues when a harness is missing, the bundled marketplace
root is unavailable, or a plugin command fails. A second run with the expected
plugin version already installed performs no plugin writes. The steps:

1. **inspect** — read-only report of what's already present (human credential,
   execution settings, `claude` and `codex` on PATH, agent slots). No writes.
2. **human login** — verify the stored **human** credential, or run the same
   loopback-OAuth browser flow as `owenloop login` when none is present or it no
   longer verifies. This is the gate that makes step 3's mint/rekey legal.
3. **agent** — find a local `agent:<name>` slot that verifies live against the
   hub and reuse it; otherwise **mint** a new Scoped Identity or **rekey**
   (replace the credential of) an existing one. How the target is chosen is
   [below](#choosing-the-scoped-identity-flow-a-vs-flow-b).
4. **signing keys** — ensure an Ed25519 signing key for each of the three local
   principals, in order: human, machine, agent. Details
   [below](#signing-keys-step-4). After key convergence, setup performs the
   enrollment relay sub-step described below.
5. **execution settings** — write only `hubOrigin` into the execution settings
   file so the local Step Agent talks to this hub, preserving every other key
   (skipped when `hubOrigin` already matches).
6. **plugin** — probe and converge the bundled `owenloop` plugin separately
   for Claude Code and Codex. When the installed plugin is missing or its
   version differs from the CLI package, setup adds the bundled marketplace
   when needed and installs or updates the plugin. Claude Code uses
   `claude plugin install` for a fresh install and `claude plugin update` for
   an existing plugin. Codex uses `codex plugin add owenloop@owenloop` for both
   fresh installs and upgrades; setup does not call
   `codex plugin marketplace upgrade`, which applies only to Git marketplaces.
   **Non-fatal:** a missing harness or failed convergence is reported as
   `noted` and never fails setup. If the bundled marketplace root is
   unavailable, setup prints manual commands instead.
7. **doctor** — a final [`doctor`](#doctor--check-a-machines-install) pass over
   the same surfaces, whose result becomes setup's exit code.

Progress lines (the `[n/7]` headers and `✓`/`✗` marks) go to **stderr**; the
final machine-readable summary — `{ ok, hub, steps, doctor }` — goes to
**stdout**.

### Choosing the Scoped Identity (Flow A vs Flow B)

When step 3 has to act (no reusable local agent slot), it decides *which* Scoped Identity
to connect this machine to:

- **Flow A — fresh org (no Scoped Identities on the hub):** setup asks you to
  **name** the Scoped Identity, prefilled with a sanitized form of the machine hostname.
  The name is a suggestion — any label matching `[A-Za-z0-9][A-Za-z0-9._-]*`
  (1–64 chars) is accepted. It then **mints** that Scoped Identity.
- **Flow B — org already has Scoped Identities (succession):** setup shows the existing
  Scoped Identities (each with its name, when it was **last active**, and its **crews**)
  and asks whether this is a *new* installation or one that *replaces* an
  existing Scoped Identity. Choosing **new** mints a fresh Scoped Identity; choosing **replace**
  **rekeys** the chosen Scoped Identity — which **revokes that Scoped Identity's current
  credential**, so if it is still running elsewhere it will be disconnected
  there.

**Non-interactive runs must pass a bypass flag.** When stdin is not a TTY (a
scripted or piped run) and step 3 needs to act, setup will not block on a
prompt — it errors unless you pre-decide with one of:

- `--new-agent <name>` — mint a new Scoped Identity named `<name>` (skips Flow A's name
  prompt and Flow B's succession prompt).
- `--replace-agent <name>` — rekey the existing Scoped Identity named `<name>` (skips the
  succession prompt); errors if no such Scoped Identity exists on the hub.

The two flags are mutually exclusive. `--crews <a,b>` applies **only** to a mint
(`--new-agent` or a fresh org); combining it with `--replace-agent` is a usage
error, because rekeying preserves the Scoped Identity's existing crews (manage those in
the console). `--scopes <a,b>` likewise applies **only** to a mint — it selects
the minted token's scopes (default `work`); combining it with `--replace-agent`
is a usage error, because rekeying preserves the Scoped Identity's existing scopes (mint a
new Scoped Identity to change scopes). `setup` has no `--shift` shorthand — spell the
scopes out with `--scopes work,run`.

### Signing keys (step 4)

Step 4 ensures one Ed25519 signing key per local principal — human, machine,
agent — keyed by `{ hub origin, kind, principal id }`. It is **idempotent**:
an existing key reports `existing` and is never regenerated or rewritten. A
second full setup run performs zero key writes.

**Storage backends.** The key record goes to the macOS Keychain
(`security`), to Linux libsecret (`secret-tool`) when that binary is on
`PATH`, and otherwise to a `0600` file under `$HOME/.owenloop/keys/` (both
parent directories forced `0700`, symlinks refused). One backend is selected
once and a failure is a hard error — there is never a fallback to another
backend, because a fallback could mint a second, different key for the same
principal. `OWENLOOP_NO_KEYCHAIN=1` forces the file backend. Private bytes
never appear on argv or in setup output.

**`--reuse-ssh-key <path>`** records your own existing Ed25519 SSH key for the
**human** principal instead of generating one. The candidate is validated with
a non-secret sign/verify challenge before anything is recorded, and only its
canonical path + public key are stored — the private key is never copied. It
applies to the human key only (machine and agent always get generated keys),
and it is a **hard conflict** when a human key already exists: setup keeps the
existing key and errors rather than rotating (rotation is not part of this
work package). A nonexistent path fails up front, before any browser opens.

**Secret-output guarantee.** Step 4 prints only `kind state (backend)` — e.g.
`✓ signing keys: human created (macos-security), machine created (file), agent
existing (macos-security)` — never key bytes, fingerprints, or secret-store
values. The full storage and signing model is in
[Signing and key storage](crypto.md).

### Machine enrollment relay

After the three keys are ensured, setup tries to register the machine public key
with the hub. The relay is deliberately subordinate to local key convergence:

1. Read-only inspect the human signing key. If no human signing key is present,
   setup records `skipped` and performs no enrollment request.
2. `GET /api/enrollments` with the human credential. If the hub is unavailable,
   returns an unsupported status such as `404`, returns `500`, or returns an
   unusable response, setup records `noted` and continues.
3. If the machine public-key fingerprint is already present, setup records
   `skipped` and does not sign or POST a duplicate.
4. Otherwise, the human signing key signs an `EnrollmentGrantRecord` locally.
   The grant names the machine principal `{ kind: "machine", id: "local" }`,
   uses the default least-privilege machine scope, and sets `grantedBy` to the
   human public-key fingerprint.
5. `POST /api/enrollments` receives only `{ envelope }`, where `envelope` is the
   signed DSSE enrollment grant. The machine private key, human private key
   bytes, key-store values, and private-key paths never enter the request body.
   HTTP `409` means already registered and becomes `skipped`; other transport or
   hub failures become `noted` and do not undo local key creation.

The relay is idempotent (repeating the operation after the first successful
registration changes nothing) and the hub is only a storage/relay endpoint. The
hub does not create, sign, or endorse the grant.

## `enrollments` — inspect machine enrollment

`owenloop enrollments [--hub <url>]` fetches the hub's relayed DSSE envelopes and
verifies each entry locally. The command is read-only: it does not call key
creation, does not sign a grant, and does not POST to the hub. The command uses
the local `allowed_signers` trust root when one is configured.

The command prints `{ ok, hub, enrollments }` on stdout. Each entry has one of
four verdicts:

| verdict | meaning |
|---|---|
| `enrolled` | the grant payload and DSSE signature are valid, the signer is in the local `allowed_signers` root, and an enrollment-chain validator approved the grant |
| `unenrolled` | no envelope was supplied for the roster entry |
| `unverifiable` | verification cannot establish trust, including a missing `allowed_signers` root or the D1 fail-closed state where no chain validator is installed |
| `invalid` | the envelope, payload, schema, signer authorization, signature, or chain-validator result is invalid |

WP-D1 intentionally does not install an enrollment-chain validator. Therefore a
well-formed, correctly signed D1 grant is reported as `unverifiable` until WP-D4
installs the validator. This prevents a signature from being mistaken for proof
that the grantor is enrolled.

A missing human credential is exit `3`; hub, malformed-response, and other
runtime failures are exit `1`; successful classification is exit `0`.

### Hub resolution differs from `agent new`

`setup` (and `doctor`) resolve the target hub like `agent new` with **one**
deliberate difference: a brand-new machine with **no** stored hub falls back to
the built-in **default hub** (printing a `targeting <hub>` notice to stderr)
instead of exiting 2. That is safe here because the mint happens only *after*
you sign in through that hub's own browser consent, and the target is printed
first. Resolution order:

1. `--hub <origin>` if given.
2. Otherwise the **one** hub your credential *file* stores, if exactly one is
   present.
3. More than one stored hub → **exit 2**, listing them so you can pass `--hub`.
4. Zero stored hubs (or a keychain/external backend that can't enumerate) →
   the **default hub**, with a printed notice.

### A configured external credential command blocks setup

If `OWENLOOP_CREDENTIAL_COMMAND` is set, that command — not the local store —
supplies this hub's credentials, so setup **refuses up front**, *before any
browser opens*. Its human-login and agent-mint steps would write keys nobody
reads; unset the variable to use `owenloop login` and the local store. (This is
the same guard `agent new` applies, just moved ahead of the OAuth round-trip so
the flagship command never opens a browser only to fail at the store.)

### After setup

If the connected agent account is anything other than `default`, setup prints a
reminder to run `owenloop work` with `OWENLOOP_ACCOUNT=<name>` so the Step Agent
reads the right slot.

**Exit codes.**

| code | meaning |
|---|---|
| `0` | every step ended skipped/done/noted **and** doctor's core checks (1–5) passed |
| `1` | setup ran but doctor's core checks did not all pass |
| non-zero (thrown) | a hard failure — bad flags, unresolvable hub (2), 403 from the hub (setup needs an admin credential to manage Scoped Identities), a named `--replace-agent` that doesn't exist, or a configured external credential command |

## `doctor` — check a machine's install

`owenloop doctor` is the **read-only** diagnostic behind setup's final step. It
probes the same install surfaces and prints one `✓`/`✗` line per check to
stderr, plus a `{ ok, hub, checks }` summary to stdout. It performs **no
configuration writes** — no mint, rekey, slot create/delete, settings write, or
browser. (The one unavoidable carve-out: verifying the human credential may
rotate-and-persist an *expiring* human OAuth token, exactly as every authed
command does — refreshing without persisting would strand the rotated refresh
token and corrupt the install.)

The checks, in order:

| # | check | ✓ means | core |
|---|---|---|---|
| 1 | human credential | a human credential is stored for this hub | yes |
| 2 | human plane | that credential verifies live against the hub (`whoami`) | yes |
| 3 | agent slot | an `agent:<name>` credential is stored | yes |
| 4 | agent plane | that agent credential verifies live against the hub | yes |
| 5 | execution settings | the settings file's `hubOrigin` matches this hub | yes |
| 6 | plugin (claude-code) | the Claude Code `owenloop` plugin is installed at the package version | **no** (rendered only) |
| 7 | plugin (codex) | the Codex `owenloop` plugin is installed at the package version | **no** (rendered only) |

The plugin checks also report the detected harness CLI version. An installed
plugin whose version cannot be parsed is reported as `version unknown` and is
not treated as a failure. A parsed plugin version that differs from the
package version is reported as version skew with the remedy `run owenloop
setup`. A missing harness reports that the harness is not on `PATH`; a missing
plugin reports the harness-specific marketplace and install command.

Each `✗` line names its own remedy (`run owenloop setup`, `owenloop login --hub
<origin>`, re-run setup's Replace, and so on). doctor never short-circuits — a
machine with no working human credential still renders the later checks,
degrading honestly rather than dropping them.

**Exit code.** `0` when the **core** checks (1–5) all pass, `1` otherwise. Both
plugin checks (6–7) are *rendered* but do not affect the exit code.

## `mcp` — stdio control-plane server for MCP hosts

`owenloop mcp` is a long-running server that exposes the hub's **human control
plane** to a local MCP host (Claude Code, Codex, or any client that speaks MCP
over stdio). The shipped Claude Code and Codex plugins launch this command from
`PATH`. This is the `owenloop-cli-mcp` surface: an MCP host spawns it as a
subprocess — **you do not run it yourself at a prompt**. It reads
newline-delimited JSON-RPC 2.0 on stdin, translates each `tools/call` into one
authenticated HTTPS request to the hub's `/api/*` REST mirror, and writes the
JSON-RPC reply on stdout. It runs until stdin closes (EOF), then exits `0`.

It authenticates as the logged-in **human**, using the same stored credential
`login` writes and the same locked OAuth-refresh path the other hub commands
use. It is never interactive: it never opens a browser and never starts a
loopback listener. If no human credential is stored, a tool call returns an
error telling you to run `owenloop login --hub <origin>` in a terminal and retry
(see [Authentication and secrets](#authentication-and-secrets) below).

### Plugin/CLI version alignment

The shipped Claude Code and Codex plugins launch `owenloop mcp` from `PATH` and
carry the plugin version in `.mcp.json` as `OWENLOOP_PLUGIN_VERSION`. The MCP
server compares that expected version with its own package version on every
recognized `tools/call`. The comparison is strict equality: a mismatch returns
a tool error that names both versions and says `Run: owenloop setup`. The
server does not reject the MCP startup handshake, so the diagnostic reaches the
model and the human instead of appearing only as a transport-closed error.

Each plugin also declares a `SessionStart` hook. The hook reads the plugin
manifest version, sends an MCP `initialize` request to `owenloop mcp` using a
non-routable probe origin, and reads `serverInfo.version`; the root CLI has no
supported `owenloop --version` flag. The hook reports a missing CLI, an
unparseable version, or a mismatch to stderr and always exits successfully, so
a diagnostic cannot block session startup. Claude Code runs the hook after
installation. Codex runs plugin hooks only after the user approves them in
`/hooks`; if the user does not approve Codex hooks, the always-on MCP check
still catches a version mismatch when a tool call is made.

If the versions differ, run `owenloop setup` and follow the printed plugin
installation instructions before retrying the MCP tool call.

### Choosing the hub origin

`owenloop mcp` binds to exactly one hub origin, resolved in this order:

1. `--hub <url>` flag.
2. `OWENLOOP_HUB` env var.
3. `~/.owenloop/config.json` — see below.
4. If the **file** credential backend holds exactly ONE hub with a valid
   `human` credential, that hub is used (kept for back-compat with installs
   from before step 3 existed).
5. The built-in **default hub**, `https://api.owenloop.com`.

Every inference rung after the first two **falls through silently** rather
than stopping the server: a missing or corrupt config file, a `hub` value in
it that doesn't parse as a valid origin, an unenumerable credential store
(macOS Keychain or an external credential command — only the file backend can
be listed at all), zero stored hubs, and more than one stored hub all just
move on to the next rung. `owenloop mcp` never exits for an inferred-origin
reason — this is deliberate: it is a long-running process spawned
automatically by an MCP host on every session start, not a one-shot command a
human is watching, so a hard stop here would silently break the plugin on any
machine using the Keychain backend (the macOS default) unless the operator
remembered to set `--hub` or `OWENLOOP_HUB` first.

The MCP surface is not read-only. It includes `create_agent`, which mints and
stores a new agent token, plus state-changing tools such as `create_workflow`,
`publish_event`, `submit`, `stage_enrollment`, and the crew mutations. The
server still authenticates each tool call against the resolved origin. When no
human credential exists at that origin, the first authenticated tool call
returns `loginHint` with the origin and asks for `owenloop login --hub
<origin>` before the tool-specific action runs. If a credential does exist at
an unintended origin and `create_agent` mints there, the stored agent token is
revocable; explicit `--hub` and `OWENLOOP_HUB` remain available to avoid
inference. Contrast this with [`agent new`](#agent-new--mint-an-agent-token-into-a-slot),
which **mints** a new credential directly and therefore stops rather than
ever guessing — a wrong guess there is a side effect a retry cannot undo.

**`~/.owenloop/config.json`** is written by
[`login`](#login--authenticate-the-cli-against-a-hub): a small, non-secret
JSON file (`{"version": 1, "hub": "<origin>"}`) recording the hub `login` most
recently authenticated against. It exists specifically so `mcp` can learn
your hub without enumerating the credential store — see `login`'s own section
for exactly when it's written and what happens if the write fails.

A malformed `--hub`/`OWENLOOP_HUB` value is still a normal exit-`1` error,
like every other command — an explicit bad value is reported, never silently
skipped, precisely because rungs 1–2 come from something the operator typed
or set, not from inference.

### Tools

The server exposes 17 baseline tools mirroring the hub's own MCP toolset, plus
`create_agent`, plus four [crew](#crews) tools (`list_crews`, `create_crew`,
`add_crew_member`, `remove_crew_member`) that do not mirror the hub's own MCP
toolset. Each baseline tool's result is the hub REST response as one text
block; a non-2xx response comes back as an error result.

| tool | what it does |
|---|---|
| `whats_next` | tick a workflow and get the next work order(s), or the inbox of started instances |
| `submit` | submit a work order output |
| `reject_artifact` | send an upstream artifact back to its producer with a reason |
| `provide_input` | answer a human gate — provide a value for a seeded/owed input |
| `start_run` | create a new instance from a definition name |
| `create_workflow` | parse + load a workflow def YAML (the authoring hard gate) |
| `get_workflow` | fetch one loaded definition |
| `list_workflows` | names, titles, step counts, and def hash/version of every loaded def |
| `get_status` | `engine.status` verbatim plus a plain-English rendering |
| `heartbeat` | touch the liveness timestamp on an open run so it is not reaped mid-step |
| `get_order` | re-fetch the persisted order packet and lease state for a run you hold |
| `release` | give back a claim so its order is re-offered without waiting out the reap TTL |
| `publish_event` | publish an event against a contract, starting one run per matched subscription |
| `list_subscriptions` | the org's contract subscriptions |
| `presence_ping` | register/refresh this Shift's presence — name, crews served (empty/omitted `serve_crews` means every crew this principal belongs to), and optionally which process incarnation is reporting (`shift_id`/`started_at`); observability only, a separate mechanism from the `heartbeat` lease tool above |
| `list_shifts` | your principal's registered Shifts — online/offline derived at read time from last ping, crews served (returned as `crews`; empty means every crew this principal belongs to), and each one's reporting incarnation (`shiftId`/`startedAt`) when the hub recorded one |
| `wake` | cheap "has anything changed since cursor X" pre-check for a polling loop |
| `create_agent` | create a NEW Scoped Identity and store its credential locally — **never returns the token** |
| `list_crews` | list the org's crews, each with its member rows inline — a plain passthrough, no filtering |
| `create_crew` | create a crew (`name`, `kind`, optional `ownerMemberId`) |
| `add_crew_member` | add a member or agent principal to a crew |
| `remove_crew_member` | remove a principal from a crew (tolerant: removing a non-member is a normal result, not an error) |

`create_agent {name, crews?, scopes?}` mints a fresh Scoped Identity on the hub
with `work` scope by default; pass `scopes` (e.g. `["work","run"]`) to choose the
minted token's scopes. It then writes the minted `olp_` token straight to this
machine's credential store (slot `agent:<name>`). The token is **never** returned in the
tool result, printed, or logged — the result is `{name, crews, stored: true}`,
built from scratch. It refuses a name that is already taken (the hub's error
message is surfaced verbatim; error bodies never carry tokens). If the store
write fails, the result says so and tells you to revoke/re-key the agent from
the console.

**The four crew tools** (`list_crews`, `create_crew`, `add_crew_member`,
`remove_crew_member`) cover the same four operations as the [`crew` CLI
family](#crews) — `crew list`, `crew new`, `crew member add`, `crew member
rm` — over the same `/api/*` routes and the same RBAC, but they are not an
exact mirror of it: `crew rm` (crew deletion) has no MCP counterpart at all
(see below), and where the CLI narrows each hub response into one
whitelisted JSON document per invocation (`asPools`, `asPoolCreated`, etc.,
so `| jq` always works), these MCP tools are plain passthroughs — the raw
hub REST body maps straight to the tool result with no narrowing. Each
argument schema deliberately has **no `enum`** on `kind`/`principalKind`,
since the hub, not this client, is the enforcement of record for which
values are legal.

Access is **not uniformly admin-only**: `create_crew`, `add_crew_member`, and
`remove_crew_member` all carry the same self-service carve-out as their CLI
counterparts — a human acting on a **personal crew they own** needs no admin
role at all (`assertPoolMutationAllowed`); every other target (a `shared`
crew, or a `personal` crew owned by someone else) still requires the admin
role. `list_crews` is readable by any of `admin`/`author`/`operator`.
`remove_crew_member` is **tolerant**: removing a principal that was never a
member is a normal `200` result with `removed: false`, never a tool error.
`add_crew_member` is **not** tolerant the same way — adding a principal that
is already a member is a hub error, mapped to an `isError` result. Both
`add_crew_member` and `remove_crew_member` refuse the org's orphan crew
(`orphan:unrouted`) as a `400`, never a `403` — the refusal is
identity-independent (it objects to the target crew, not the caller's role),
since that crew's membership is derived from the org's current admins and
cannot be edited directly.

**`delete_crew` is deliberately NOT a tool here.** Deleting a crew is a
one-way-door operation gated admin-only unconditionally on the hub (unlike
the other three verbs, which have the self-service carve-out above), and it
was excluded from this MCP surface by design. `owenloop crew rm` on the CLI
remains the only way to delete a crew; removing a single **member** (above)
is a different, reversible operation and stays in scope for MCP.

One further tool, `stage_enrollment`, is **conditionally** registered — it
appears only when the hub advertises the staging endpoint (or when
`OWENLOOP_MCP_ENROLLMENT=1` forces it on). It returns a join code the new agent
redeems; a join code is transferred authority, not a credential, so it is safe
to surface in a tool result. When the endpoint is absent, the tool is hidden
(fail-closed).

### Authentication and secrets

Every tool call re-reads the stored `human` credential, refreshes it through the
shared locked OAuth path if it is near expiry, and attaches it only as the
`Authorization` header — the bearer never rides a tool result. Minted agent
tokens (`create_agent`) are written to the local credential store and **never
appear in any tool result, stderr line, or log**. If authentication fails
(missing credential, refresh failure, or a final 401), the tool returns an error
result whose text names the fix — run `owenloop login --hub <origin>` in a
terminal — rather than prompting; the server itself never authenticates
interactively.

### Environment knobs

| variable | effect |
|---|---|
| `OWENLOOP_HUB` | development override for the hub origin (rung 2, above `~/.owenloop/config.json`) |
| `OWENLOOP_MCP_ENROLLMENT` | `1` forces `stage_enrollment` on, `0` off; unset = probe the hub |
| `OWENLOOP_MCP_PROBE_TIMEOUT_MS` | deadline for the `stage_enrollment` capability probe (default `3000`) |
| `OWENLOOP_HUB_TIMEOUT_MS` | per-request hub timeout (shared with the other hub commands) |
| `OWENLOOP_CRED_LOCK_WAIT_MS` / `OWENLOOP_CRED_LOCK_POLL_MS` | credential-lock wait/poll knobs (shared) |

## Hand-driven walkthrough

The [`examples/workflows`](../examples/workflows) folder has a workflow per
idea: [`delivery`](../examples/workflows/delivery.yaml) (a review knock-back
loop), [`ship`](../examples/workflows/ship.yaml) (delivery grown up: the full
production line with provisioned workspaces, an adversarial reviewer, a doc
pass, and teardown owned as a step),
[`research`](../examples/workflows/research.yaml) (collections),
[`routing`](../examples/workflows/routing.yaml) (skip a dead branch),
[`intake`](../examples/workflows/intake.yaml) (schema validation),
[`sla-watchdog`](../examples/workflows/sla-watchdog.yaml) (idle timers and
deadlines), and [`improve`](../examples/workflows/improve.yaml) (a
codebase-advisor pipeline combining collections, a mid-flight human gate,
per-element knock-backs, and suffixed-reduce fan-ins). Each example's header
comment walks through its commands end to end.

Playing every Step Agent yourself is the fastest way to internalize the loop.
Every command prints JSON, so the snippet below pipes through `jq`:

```sh
git clone https://github.com/typicalday/owenloop && cd owenloop
npm install && npm run build

export OWENLOOP_DEFS=examples/workflows
export OWENLOOP_DB=/tmp/owenloop-demo.db

owenloop() { node bin/owenloop.mjs "$@"; }   # or `npm link` to put it on PATH

owenloop defs                                  # what workflows are available

# start an instance; `proposal` is seeded as owed, so we provide it up front
wf=$(owenloop create delivery \
       --provide proposal='{"text":"add dark mode"}' | jq -r .workflow)

# the Step Agent loop: tick → run → report
run=$(owenloop tick $wf | jq -r '.orders[0].run')   # claim the planner job
owenloop green $wf $run plan --value '{"plan":"…"}'  # report its output

owenloop status $wf                            # owed / eligible / blocked / done
```

**A knock-back.** When the reviewer's job comes up, instead of greening its
`verdict` you can reject the PR:

```sh
owenloop reject $wf pr --by reviewer --text "tests are missing"
```

That re-arms `builder` with the reason attached to its next job. Do it past
`builder`'s `maxAttempts` and `pr` **stalls** — owenloop stops re-arming it
and waits for a human. `owenloop retry $wf pr --text "use the new fixture"`
clears the stall and resets the counter.

## `reap`, `runs`, and `status.inFlight` — observing and clearing in-flight work

`tick` already reaps stranded leases as a side effect (a dead/closed run, or a
claim past its TTL), but sometimes an orchestrator needs to act deliberately
instead of waiting for the next tick. `owenloop reap <wf>` runs that same
cleanup on demand, applying the normal per-step/engine TTL rules — usually a
no-op (`{ reaped: 0, details: [] }`). `owenloop reap <wf> --now` is the admin
stand-down: it forces every currently-claimed task stale (TTL 0) regardless of
how fresh its claim is, for reclaiming a Step Agent you know is dead without
waiting out the TTL. Reaping re-arms the task immediately, so **the run that
held the cleared lease can no longer commit** — its next `green`/`close` fails
with `run <id> no longer holds its lease (reaped or superseded)`, the same
error a normal TTL-expired reap produces. Each entry in `details` carries a
`reason` explaining why that lease was cleared: `heartbeat-lost` (no beat within
the reap TTL — the job went silent), `max-lease-exceeded` (a configured
`maxLeaseMs`/`maxLease:` cap expired a still-beating lease — only ever seen when
a cap is set), `run-missing` / `run-closed` (the owning run is gone or already
closed), or `forced` (a `--now` stand-down cleared a lease that was still fresh
under the real TTL — reported instead of a misleading liveness reason).
`owenloop runs <wf> [--open]` and
`status <wf>`'s `inFlight` array are the read side: `runs` lists every run
this instance has ever had (with `--open` filtering to still-open ones, each
joined with its owning task's `claimedAt`/`heartbeatAt`/`attempts`), while
`status.inFlight` is the currently-claimed subset in the same shape, for a
quick "what's running right now" check without listing full run history.

## `wait` — blocking on engine state instead of polling

`owenloop wait <wf> --until eligible|done` sits in a loop, re-checking
`status <wf>` every 250ms, until `--until eligible` sees a non-empty
`eligible` list or `--until done` sees `done: true` — then it prints that
`status` (same shape `status <wf>` would) and exits 0. `--timeout <dur>`
(default `10m`, same duration format as `reap`/cadence — `90m`, `2h`, `45s`)
bounds the wait: on timeout it exits 1 with
`{ok:false, error:"timeout", until, timeout, status}` on stdout, where
`status` is the last-observed state so the caller sees what's still unmet. An
unknown workflow id fails the same way `status <wf>` does. Use it in an
orchestrator or agent script to block for engine state change without
burning inference on a poll loop.

## Exit codes for `green` / `emit` / `seal` / `reject`

These exit non-zero when the engine refuses the commit or verdict
(born-rejected, or a schema failure for `green` / `emit` / `seal`). `reject`
can be born-rejected too — a [judge's](authoring.md#judges--quality-gates-before-green)
verdict lands on a stale `submitted` version (a sibling judge already settled
it, the producer resubmitted, or a human bypassed it) and the CAS guard
refuses it. The result JSON is always written to stdout; the human-readable
reason goes to stderr. A successful call exits 0 — a Step Agent should treat a
non-zero exit as a failure, not a success.

## What a job looks like

`tick` returns `{ workflow, orders, reaped }`. Each order is a **reference
packet**: it carries the routing fields and run-time context for the job — the
run id, the captured input values, the owed outputs with their reason threads
— plus a `defDigest` that names *which definition snapshot* holds the authored
instructions. The instructions themselves (the step's `body:` prompt, any
`command:` text) are **not** on the order, and `tick`/`order` never print
them.

```jsonc
{
  "run": "r_…",            // job id — pass it back to green/emit/seal/close
  "workflow": "wf_…",      // the instance this order belongs to — see deep tick below
  "step": "builder",       // which step this job is for
  "key": "",               // map jobs carry the element key + index
  "defDigest": "9f2c…",    // identifies the definition snapshot to resolve instructions from
  "inputs":  ["plan"],
  "outputs": ["pr"],
  "worker":  "command",    // the authored step's executor:, mapped verbatim (absent = 'agent')
  "consumes": { "plan": { /* the accepted input value */ } },
  "owes": [                // the feedback channel
    { "path": "pr", "judgmentRejects": 2, "schemaRejects": 0,
      "reasons": [ { "action": "reject", "kind": "judgment", "by": "reviewer",
                     "text": "tests are missing", "at": 0 } ] }
  ]
}
```

A worker first **resolves the reference**: the `(defDigest, step, key)`
boundary maps the order to the exact authored instructions from the worker's
trusted local definition source — the same resolver the embedded engine and
the CLI use. Resolution returns the authored `prompt` (with
`${WORKFLOW}`/`${RUN}`/`${STEP}`/`${KEY}`/`${INDEX}`/`${MAX_ATTEMPTS}`
materialized), the authored `command` if the step has one, and nothing
fabricated. If the worker's source does not know the digest — the definition
was never delivered, or the current on-disk definition no longer matches the
pinned digest — resolution raises `UnknownDefDigestError`. If the digest is
known but the referenced step is absent, resolution raises the distinct
`UnknownInstructionError` and identifies the digest, step, and key. The worker
must refuse either malformed reference rather than guess instructions by step
name or fetch unverified text. Once resolved, the worker reads the resolved
prompt + `consumes` + `owes`, does the work, reports with `green` (or
`emit`/`seal` for collections), then `close`s the job. The reject counts in
`owes[]` let a workflow escalate on its own — e.g. switch to a stronger model
after two rejections — before the engine stalls the step.

Static authored text (prompts, commands) travels by digest reference; dynamic
data — `consumes` values and the rejection `reasons` threads — stays on the
order because it exists only for this run. A remote coordinator or transport
that relays these packets never sees authored instruction text and never needs
to: instructions resolve at the worker, from a source the worker trusts.

**Deep tick and `order.workflow`.** `tick <wf>` is **deep by default**: it ticks
`<wf>` and then descends into every live `calls:` child, folding their orders
into the one result. So an order in the list may belong to a child instance,
not `<wf>` — always dispatch and commit (`green`/`emit`/`seal`/`close`) against
`order.workflow`, not the id you passed to `tick`. `--shallow` ticks only the
one instance (every order then carries `<wf>` itself); use it for a deliberate
single-instance drive. `reaped` sums across the tree and `dueAt` (when present)
is the earliest wake across all levels. A folded deferral in the deep result
carries its own `workflow` (absent = the root you ticked, present = a
descendant).

**Capability routing (`--capability`).** `tick <wf> --capability <l>` (repeatable) filters
which steps this caller claims, but only steps that carry their own `capabilities:`
are ever excluded: a step is deferred with reason `capability-mismatch` and left for
another caller **only** when its `capabilities:` are non-empty and share no value with
the filter you pass. A step with no `capabilities:` is claimed by every caller,
filtered or not, and a tick that passes no `--capability` claims every eligible step
regardless of capabilities. This is **routing, not
authorization**: any caller that can reach the database can tick without a
filter and claim anything, so capabilities split work across cooperating
orchestrators, they never enforce a boundary. See
[`capabilities:`](authoring.md#capabilities--logical-capability-tags) in
the authoring guide for the step-side declaration and the starvation hazard to
watch for.

**Child stalls on `status`.** `status <wf>`'s `calls:`-debt entries carry a
`child: { workflow, def, done, stalled, debts }` summary once a child has been
spawned. `child.stalled: true` means the child (or a grandchild below it) has a
Step Agent stuck at `maxAttempts` with no green outcome — the parent debt is blocked
on stuck child work. This lets a Shift spot a wedged child from the parent
`status` alone, without separately walking into the child's own `status`.

**`wait --until` is single-instance.** `wait <wf> --until eligible|done` polls
`status <wf>`, which is that one instance's derived view — it does **not** see a
child's `eligible` orders or wait on child completion. To block on a tree, wait
on the instance that actually owes the work (often a child), or poll deep
`tick`/`status` yourself.

## Instance pinning — editing a workflow definition mid-flight

`create` snapshots the fully-expanded definition (post `include:`/`calls:`) onto the
instance, along with a content hash. Every later `tick`/`status`/`green`/etc. on that
instance resolves against its own snapshot, not the live YAML — so editing a
definition's `body:`, adding a step, or changing what a step consumes never rewires an
instance that's already in flight. Instances created before this feature shipped have
no snapshot and keep resolving by name, as before — that fallback is permanent, not a
deprecation path.

`status` surfaces this as an informational `defDrift: true|false` (or omitted, if the
live definition no longer resolves at all): the engine never refuses to advance a
drifted instance, it just tells you the source has moved on. To deliberately move an
instance onto the current definition, run `owenloop adopt <wf>` — it re-snapshots and
re-hashes the pin, then settles the instance so any debts the new shape introduces
(new steps, changed `consumes`/`produces`) show up right away. `adopt` only surfaces
new **step** outputs as debts; a workflow's `inputs:` are seeded once at `create` and
are not retroactively re-requested — in fact an input added mid-flight can never be
supplied to that instance (`provide` refuses it). Need a new external fact after a
replan? Add a consumeless intake step and green it directly (see
[`docs/design.md` §28.4](design.md)).
