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
`--strict-inputs`, and the bare `--now` on `reap`) never take a following
value — the next token is always a positional or the next `--flag`, never
consumed as this flag's argument. Use `--flag=value` (e.g. `--now=<ms>` on
`tick`) for flags that do take a value.

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
| `add --recover` | finish or undo a crash-interrupted install, offline — no network call — see below |
| `login [--hub <url>] [--with-token] [--as <slot>]` | authenticate the CLI against a hub — loopback OAuth, or `--with-token` from stdin — see [Hub](#hub-login--connect--push--logout) |
| `connect [--hub <url>] [--as <slot>]` | bind this project to a hub (writes `.owenloop/hub.json`) and verify the credential |
| `push [<defName>...] [--force] [--dry-run] [--as <slot>]` | publish local workflow defs to the bound hub (idempotent against the hub's own def hashes) |
| `logout [--hub <url>] [--as <slot>]` | delete the stored credential for a hub |
| `agent new <name> [--pools <a,b>] [--hub <url>]` | mint a new agent identity on the hub and store its token in slot `agent:<name>` — the token is never printed — see [Hub](#hub-login--connect--push--logout) |
| `mcp [--hub <url>]` | serve the hub control plane to a local MCP host over stdio — spawned by MCP hosts, not run by humans — see [`mcp`](#mcp--stdio-control-plane-server-for-mcp-hosts) |
| `create <def> [--title t] [--provide name=json …] [--param k=v …]` | start an instance; prints `{workflow}` |
| `provide <wf> <name> [--value json]` | supply a seeded input after the fact |
| `tick <wf> [--now=<ms>] [--shallow] [--label <l>]…` | claim and emit eligible **orders** (the jobs to run); deep by default — also descends into live `calls:` children (`--shallow` = this instance only); repeatable `--label` claims unlabeled steps plus matching-label steps — see below |
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
whatever privileges the host process and its dispatcher grant their workers.
owenloop itself never executes a step body — `worker:`/`command:` are opaque
labels it carries through untouched and never shells out (see [What owenloop is
not](../README.md#what-owenloop-is-not) and
[`docs/authoring.md`](authoring.md#worker--declaring-the-executor)) — so the
real risk surface is the conductor or worker you point at these defs: the
prompts and `command:` strings that ship in a package are handed to agents that
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
body will do once a worker runs it. That trust decision stays yours.

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
  tarball download after 5 min, each surfacing as a friendly error.

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

Exact-match redirect URIs (no RFC 8252 variable-port allowance) and no
device-code grant remain recorded follow-ups on the service, not gaps in the
CLI.

### `agent new` — mint an agent token into a slot

`owenloop agent new <name>` mints a new agent identity on the hub (`POST
/api/mint_agent_token`, authenticated as your **human** credential) and stores
the returned `olp_` token in the local credential slot `agent:<name>` — the same
slot `login --as agent:<name>` writes and `push --as agent:<name>` reads. Use it
to provision an agent token without pasting one by hand: the mint and the store
happen in one step, and you never handle the secret.

**The token is never printed.** The minted `olp_` token goes process → store
only — it never appears on stdout, stderr, in an error, or in a log (identity
model §6, "rule of gates"). The confirmation JSON is built from a whitelist of
**non-secret** fields only: `hub`, `name`, `slot`, `pools` (the resolved pool
names), `scopes` (`["work"]`), `storage` (`keychain` | `file`), `agentId` (the
agent's id), and `tokenId` (a revocation handle). To use the agent afterwards,
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
production hub while you're logged into a dev one. Note that hub enumeration is
**file-store only** (shared with `owenloop mcp`): the keychain and the
external-command backend cannot list their entries, so on such a machine step 2
cannot enumerate the store and you must pass `--hub`.

**`--pools <a,b>`.** A comma-separated list of pool names the token is granted
on (trimmed, empties dropped). Omit the flag to let the hub default the token to
the minter's personal pool; `--pools ""` (or `--pools ,`) is a usage error. Pool
names are validated by the hub, not the client.

**A configured external credential command blocks the mint.** If
`OWENLOOP_CREDENTIAL_COMMAND` is set, that command — not the local store —
supplies credentials for the hub, so `agent new` refuses up front (it has
nowhere to write the minted token); unset the variable to use the local store.
This check, the name validation, and the empty-`--pools` check all run **before**
any network call, so a refusal never mints a server-side token first — a mint
that then failed to store would burn the agent name permanently.

**Exit codes.**

| code | meaning |
|---|---|
| `0` | minted and stored |
| `1` | generic failure — invalid or already-taken name, pool/shape rejection, network timeout, or a token that minted but couldn't be stored |
| `2` | the hub couldn't be resolved (no `--hub` and not exactly one stored hub) |
| `3` | the human credential is missing or irrecoverable — the error names the remedy `owenloop login --hub <origin>` |

## `mcp` — stdio control-plane server for MCP hosts

`owenloop mcp` is a long-running server that exposes the hub's **human control
plane** to a local MCP host (Claude Code, or any client that speaks MCP over
stdio). This is the `owenloop-cli-mcp` surface: an MCP host spawns it as a
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

### Choosing the hub origin

`owenloop mcp` binds to exactly one hub origin, resolved in this order:

1. `--hub <url>` flag.
2. `OWENLOOP_HUB` env var.
3. If the **file** credential backend holds exactly ONE hub with a valid `human`
   credential, that hub is used.
4. Otherwise it exits `2` and prints why to stderr (nothing is written to
   stdout — stdout is the protocol channel).

There is **no** silent default-hub fallback: a control-plane server must never
bind to a hub you did not name. The exit-`2` messages name both remedies:

- No hub credentials stored → `run \`owenloop login --hub <origin>\` first, or pass --hub <origin>`.
- More than one hub stored → the message lists every stored origin and says `pass --hub <origin>`.
- The credential store cannot be enumerated (macOS Keychain or an external
  credential command) → `pass --hub <origin> (or set OWENLOOP_HUB)`. Only the
  file backend can list stored origins, so on a Keychain-backed machine `mcp`
  effectively requires `--hub` or `OWENLOOP_HUB`.

A malformed `--hub`/`OWENLOOP_HUB` value is a normal exit-`1` error, like every
other command.

### Tools

The server exposes 17 baseline tools mirroring the hub's own MCP toolset, plus
`create_agent`. Each baseline tool's result is the hub REST response as one text
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
| `presence_ping` | register/refresh this conductor in the presence registry |
| `list_conductors` | your principal's registered conductors and their online/offline state |
| `wake` | cheap "has anything changed since cursor X" pre-check for a polling loop |
| `create_agent` | create a NEW agent identity and store its credential locally — **never returns the token** |

`create_agent {name, pools?}` mints a fresh agent identity on the hub with
`work` scope, then writes the minted `olp_` token straight to this machine's
credential store (slot `agent:<name>`). The token is **never** returned in the
tool result, printed, or logged — the result is `{name, pools, stored: true}`,
built from scratch. It refuses a name that is already taken (the hub's error
message is surfaced verbatim; error bodies never carry tokens). If the store
write fails, the result says so and tells you to revoke/re-key the agent from
the console.

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
| `OWENLOOP_HUB` | hub origin when `--hub` is absent (rung 2 of origin resolution) |
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

Playing every worker yourself is the fastest way to internalize the loop.
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

# the worker loop: tick → run → report
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
how fresh its claim is, for reclaiming a worker you know is dead without
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
reason goes to stderr. A successful call exits 0 — a worker should treat a
non-zero exit as a failure, not a success.

## What a job looks like

`tick` returns `{ workflow, orders, reaped }`. Each order is self-contained —
a worker needs nothing else to do the work:

```jsonc
{
  "run": "r_…",            // job id — pass it back to green/emit/seal/close
  "workflow": "wf_…",      // the instance this order belongs to — see deep tick below
  "step": "builder",       // which step this job is for
  "key": "",               // map jobs carry the element key + index
  "inputs":  ["plan"],
  "outputs": ["pr"],
  "prompt":  "…body with ${WORKFLOW}/${RUN}/${INDEX} filled in…",
  "consumes": { "plan": { /* the accepted input value */ } },
  "owes": [                // the feedback channel
    { "path": "pr", "acceptance": "rejected", "judgmentRejects": 2, "schemaRejects": 0,
      "reasons": [ { "action": "reject", "kind": "judgment", "by": "reviewer",
                     "text": "tests are missing", "at": 0 } ] }
  ]
}
```

A worker reads `prompt` + `consumes` + `owes`, does the work, reports with
`green` (or `emit`/`seal` for collections), then `close`s the job. The reject
counts in `owes[]` let a workflow escalate on its own — e.g. switch to a
stronger model after two rejections — before the engine stalls the step.

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

**Label routing (`--label`).** `tick <wf> --label <l>` (repeatable) filters
which steps this caller claims, but only steps that carry their own `labels:`
are ever excluded: a step is deferred with reason `label-mismatch` and left for
another caller **only** when its `labels:` are non-empty and share no value with
the filter you pass. A step with no `labels:` is claimed by every caller,
filtered or not, and a tick that passes no `--label` claims every eligible step
regardless of labels. This is **routing, not
authorization**: any caller that can reach the database can tick without a
filter and claim anything, so labels split work across cooperating
orchestrators, they never enforce a boundary. See
[`labels:`](authoring.md#labels--routing-a-step-to-a-particular-tick-caller) in
the authoring guide for the step-side declaration and the starvation hazard to
watch for.

**Child stalls on `status`.** `status <wf>`'s `calls:`-debt entries carry a
`child: { workflow, def, done, stalled, debts }` summary once a child has been
spawned. `child.stalled: true` means the child (or a grandchild below it) has a
worker stuck at `maxAttempts` with no green outcome — the parent debt is blocked
on stuck child work. This lets a conductor spot a wedged child from the parent
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
