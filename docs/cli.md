# CLI reference

The `owenloop` binary is a thin adapter over the engine: it maps `argv` to
engine calls and prints JSON to stdout. Everything here has a typed,
in-process equivalent — see [`docs/embedding.md`](embedding.md).

Global flags: `--db <path>` (env `OWENLOOP_DB`, default `.owenloop/state.db`) and
`--defs <dir>` (env `OWENLOOP_DEFS`, default `./workflows`). Nothing is
remembered between invocations — pass both on every command.

## Commands

| command | what it does |
|---|---|
| `defs` | list available workflow definitions |
| `add <owner>/<repo>[@ref]` | fetch, validate, and install a repo's workflow defs from GitHub (public repos only) — see below |
| `login [--hub <url>] [--with-token]` | authenticate the CLI against a hub — loopback OAuth, or `--with-token` from stdin — see [Hub](#hub-login-connect-push-logout) |
| `connect [--hub <url>]` | bind this project to a hub (writes `.owenloop/hub.json`) and verify the credential |
| `push [<defName>...] [--force] [--dry-run]` | publish local workflow defs to the bound hub (client-side idempotent) |
| `logout [--hub <url>]` | delete the stored credential for a hub |
| `create <def> [--title t] [--provide name=json …] [--param k=v …]` | start an instance; prints `{workflow}` |
| `provide <wf> <name> [--value json]` | supply a seeded input after the fact |
| `tick <wf> [--now <ms>] [--shallow]` | claim and emit eligible **orders** (the jobs to run); deep by default — also descends into live `calls:` children (`--shallow` = this instance only) |
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
machinery `owenloop lint`/`owenloop check` use, and only then installs them
under `<defsDir>/<owner>-<repo>/`. A def that fails parse, lint, validation,
or has a definite `check` defect refuses the **whole** add — nothing is
written, and every reason is printed.

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
      "path": "<owner>-<repo>",
      "files": ["foo.yaml", "sub/bar.yaml"]
    }
  }
}
```

Re-running `add` for the same repo is idempotent: it clears the previous
install at `<defsDir>/<owner>-<repo>/` and replaces the lockfile entry, so a
file removed upstream disappears locally too.

**Discovery limitation.** `defs`/`loadDefs` only scan the defs dir's
top-level `*.yaml` files and immediate-subdir `workflow.yaml` files — they
don't recurse into `<owner>-<repo>/*.yaml`. Defs installed by `add` are
validated and recorded, but a plain `owenloop tick`/`create` against the
default defs dir won't see them until you point `--defs` (or
`OWENLOOP_DEFS`) directly at the installed subfolder, e.g. `--defs
workflows/<owner>-<repo>`. Auto-discovering installed defs is a deliberate
follow-up, not yet implemented.

Public repos only — no auth/token support yet; a private repo (or a bad
ref) surfaces as a 404 from the sha-resolve step.

## Hub (`login` / `connect` / `push` / `logout`)

These four commands publish local workflow defs to a hosted **hub** (default
`https://api.owenloop.com`; override per-command with `--hub <url>` or the
`OWENLOOP_HUB` env var). They are the only network-bound commands besides
`add`, and they talk only to endpoints the hub exposes today — no new
service-side surface. The hub URL is normalized to its origin
(`scheme://host[:port]`); path/query are dropped.

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

There is no `whoami` endpoint yet, so `login` can confirm a credential works
but can't name the org it belongs to — check the hub console for that.

### `connect` — bind a project to a hub

`owenloop connect` writes `.owenloop/hub.json` recording which hub this project
publishes to, after re-verifying the stored credential (`GET /api/workflows`).
Run `login` first. Re-connecting to the **same** origin preserves the existing
push state; switching to a **different** hub resets it (and the JSON reports
`switchedFrom` + `pushStateReset: true`).

### `push` — publish local defs to the bound hub

`owenloop push [<defName>...]` publishes the project's workflow defs (all of
them, or just the named ones) to the hub the project is `connect`ed to. It
reuses the **exact** all-or-nothing validation gate `add` uses — lint, validate,
and a bounded `check` — across every selected def before a single byte is sent;
any definite defect aborts the whole push. stdout is machine-parseable JSON;
the human-readable diff (`+ new`, `~ changed`, `= unchanged`, `! failed`) goes
to stderr.

**Idempotency is client-side, and the hub is push-blind.** The service's
`create_workflow` is append-only — it mints a new version on every call and
exposes no def hash in its read APIs. So `push` records what it sent in
`.owenloop/hub.json` (`localHash` = `sha256(JSON.stringify(def))[:16]`, plus the
returned `remoteVersion`/`remoteHash`) and skips a def whose local hash is
unchanged since the last push — that's what makes a re-push a no-op. Because the
hub can't be consulted for drift, this state is **local to the machine**: a
fresh clone (or a second developer) has no push state and will re-push
everything once. `--force` re-pushes even unchanged defs; `--dry-run` reports
the plan and writes nothing (no state, no network). A `<defName>` that doesn't
resolve is an error; a `{ok:false}` from the hub mid-batch records the defs that
did land and exits 1.

On a `401`, an OAuth credential is refreshed once and the request retried; an
agent (`olp_`) token has no refresh path, so a `401` is a hard "re-mint it"
error.

**Include limitation.** A def whose file uses `include:` is refused
(`uses include:, not hub-pushable yet`): the hub's `create_workflow` parses the
raw YAML without include expansion, and a re-serialized expanded def isn't
round-trippable. Inline such defs before pushing. This, the missing `whoami`,
the absent def hash in read APIs, exact-match redirect URIs, no device-code
grant, and no server-side idempotency key are all recorded follow-ups on the
service, not gaps in the CLI.

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
error a normal TTL-expired reap produces. `owenloop runs <wf> [--open]` and
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
