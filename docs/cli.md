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
| `create <def> [--title t] [--provide name=json …] [--param k=v …]` | start an instance; prints `{workflow}` |
| `provide <wf> <name> [--value json]` | supply a seeded input after the fact |
| `tick <wf> [--now <ms>]` | claim and emit eligible **orders** (the jobs to run) |
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
