# CLI reference

The `owenloop` binary is a thin adapter over the engine: it maps `argv` to
engine calls and prints JSON to stdout. Everything here has a typed,
in-process equivalent — see [`docs/embedding.md`](embedding.md).

Global flags: `--db <path>` (env `OWENLOOP_DB`, default `.owenloop/state.db`) and
`--defs <dir>` (env `OWENLOOP_DEFS`, default `./workflows`). Nothing is
remembered between invocations — pass both on every command.

Boolean flags (`--force`, `--dry-run`, `--all`, `--open`, `--terminal`,
`--recursive`, `--with-token`, `--shallow`, `--assume-provided`, and the bare
`--now` on `reap`) never take a following value — the next token is always a
positional or the next `--flag`, never consumed as this flag's argument. Use
`--flag=value` (e.g. `--now=<ms>` on `tick`) for flags that do take a value.

## Commands

| command | what it does |
|---|---|
| `defs` | list available workflow definitions |
| `add <owner>/<repo>[@ref]` | fetch, validate, and install a repo's workflow defs from GitHub (public repos only) — see below |
| `login [--hub <url>] [--with-token]` | authenticate the CLI against a hub — loopback OAuth, or `--with-token` from stdin — see [Hub](#hub-login-connect-push-logout) |
| `connect [--hub <url>]` | bind this project to a hub (writes `.owenloop/hub.json`) and verify the credential |
| `push [<defName>...] [--force] [--dry-run]` | publish local workflow defs to the bound hub (idempotent against the hub's own def hashes) |
| `logout [--hub <url>]` | delete the stored credential for a hub |
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
interrupted rename, or a lockfile-write failure *after* the directory swap —
rolls the directory state back, restoring the previous install and any
old-name directory and leaving the lockfile unchanged, with no staging debris.
Concurrent `add` runs in the same project serialize on a `.owenloop/add.lock`
file; one that can't acquire the lock within 10s fails cleanly instead of
interleaving with another install. `add` also refuses to replace a
destination folder the lockfile doesn't record this source as owning (e.g. a
hand-placed folder that happens to collide) — remove it manually or fix the
lockfile to proceed. A repo previously installed under the old
`<owner>-<repo>` naming is migrated to the new hashed folder automatically,
and the old one is removed only once the new lockfile entry is durably written.

**Discovery limitation.** `defs`/`loadDefs` only scan the defs dir's
top-level `*.yaml` files and immediate-subdir `workflow.yaml` files — they
don't recurse into `<owner>-<repo>-<hash>/*.yaml`. Defs installed by `add`
are validated and recorded, but a plain `owenloop tick`/`create` against the
default defs dir won't see them until you point `--defs` (or
`OWENLOOP_DEFS`) directly at the installed subfolder, e.g. `--defs
workflows/<owner>-<repo>-<hash>` — the exact folder name is in
`.owenloop/installed.json`'s `path` field. Auto-discovering installed defs is
a deliberate follow-up, not yet implemented.

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
likewise refused at push time, with a hint to re-run `owenloop connect`.

**Request timeouts.** Every hub call — OAuth discovery, client registration,
code exchange, token refresh, `whoami`, the workflow list, and each push — is
bounded by a 30s deadline; a stalled hub surfaces as a friendly `hub did not
respond within 30s` error instead of hanging. `OWENLOOP_HUB_TIMEOUT_MS`
overrides the budget (a test knob).

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

**Where the credential lands.** On macOS it goes into the login **Keychain**
(`security`, service `owenloop-hub`, one item per hub origin) with the secret
fed over stdin, never on the command line. Elsewhere — or with
`OWENLOOP_NO_KEYCHAIN=1` — it falls back to a `0600` file at
`$XDG_CONFIG_HOME/owenloop/credentials.json` (or `~/.config/owenloop/…`) inside
a `0700` directory. Either way the token is never written into the repo or a
`.env`. `login`'s JSON reports `storage: "keychain" | "file"` and `kind`, and
prints **no token value** to stdout/stderr.

The backend is chosen once from your platform and env and then used for every
read and write — a keychain-backed CLI never silently drops to the file store.
If the keychain write fails (locked or unavailable), `login` errors out instead
of writing the secret elsewhere: unlock the keychain, or set
`OWENLOOP_NO_KEYCHAIN=1` to select the file store up front.

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
