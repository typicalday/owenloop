# Shift logs

A shift writes two kinds of file into one directory:

| File | What it holds | Format |
| --- | --- | --- |
| `shift.log` | the shift process's own dispatch record | JSON Lines, one `ShiftEvent` per line |
| `<run>.log` | one worker process's raw stdout and stderr | opaque bytes, no format at all |

Both are **append-only** and both **outlive the shift process**. That is the
point of the feature: before it, a shift's dispatch record existed only in the
socket FIFO of a running daemon, and a dispatched worker's output was written to
`/dev/null`. If a shift died, why it died died with it.

This page is a **contract**, not a description. `owenloop-service` implements a
log uploader against it. Fields, filenames, and resolution order stated here are
stable; anything not stated here is not promised.

## Three processes, three different things

Do not collapse these — the rest of this page depends on telling them apart.

1. **The shift process** — `owenloop shift start` (or `owenloop work shift`).
   Writes `shift.log`. One per machine, per state directory.
2. **A worker process** — `owenloop work exec` or `owenloop work agent-run`,
   spawned detached by the shift, one per dispatched order. Its stdout and
   stderr are what `<run>.log` holds.
3. **The command a worker runs** — the `command:` text of a command step,
   executed by the worker under `/bin/sh -c`. **Its** streams are captured into
   the receipt the worker submits to the hub, and the worker relays the captured
   tail (≤4 KiB) into its own output so a copy reaches `<run>.log`.

The worker never **inherits** the command's streams. Every relayed line carries
the literal `  | ` prefix. Both the receipt and `<run>.log` contain the
captured tail; full streams are represented only by the receipt's output hash
and stdout/stderr byte counts.

| Command outcome | Worker channel | Header |
| --- | --- | --- |
| exit 0 and no machinery error | stdout | `… the command for step 'X' succeeded; its output follows` |
| anything else | stderr | `… the command for step 'X' exited N` / `was killed by …` / `could not be run (…)`; `its last output follows` |

Under shift dispatch fd 1 and fd 2 both point at the same file, so the header —
not the channel — is what tells these outcomes apart in `<run>.log`. The two
channels still matter: stderr is what a reader treats as trouble, and routine
success output there would make every green step look like a problem.

A command that printed nothing gets `  (the command produced no output)` on both
paths, because a gate that prints nothing is itself a diagnosis. The relay is
unconditional and has no off switch.
`packages/work/test/shift-logs-acceptance.test.ts` asserts that the marker
appears in `<run>.log` exactly once, as `  | <marker>`.

## Where the directory is

Resolution order, highest priority first:

1. `--log-dir <path>` on `owenloop shift start` or `owenloop work shift`
2. `OWENLOOP_SHIFT_LOG_DIR`
3. `shiftLogDir` in settings
4. **the resolved state directory** — the default

Defaulting to the state directory is what makes correlation free: `<run>.log`
lands beside the `<run>.json` in-flight record the shift already writes, with
the same basename.

**The correlation key is the BASENAME, not the adjacency.** `<run>.log` and
`<run>.json` are sanitized by the same function (`safeRun` in
`packages/work/src/shift/state.ts`), so pointing `--log-dir` at a different
filesystem moves the logs away from the records and correlation still holds.

The shift creates the directory at startup with `mkdirSync(…, {recursive: true,
mode: 0o700})`. If that fails it prints one line to its own stderr —

```
owenloop shift: cannot create shift log directory <dir>: <reason> — continuing with logging disabled
```

— and serves with no logging at all: no `shift.log`, and every worker launched
with `stdio: ['ignore','ignore','ignore']` exactly as before this feature
existed. **Losing observability never costs a dispatch.**

## Permissions

Every file this feature creates is **owner-only**, and the mode is explicit at
every creation site rather than inherited from the umask:

| Path | Mode | Created by |
| --- | --- | --- |
| `<log-dir>/` | `0700` *when this feature creates it* — see below | `prepareShiftLogDir` (`logretention.ts`) |
| `<log-dir>/shift.log` | `0600` | `createShiftLogSink` (`logsink.ts`) |
| `<log-dir>/<run>.log` | `0600` | `createDefaultSpawner` (`spawn.ts`) |
| `<log-dir>/.owners/` | `0700` | `registerShiftLogOwner` (`logretention.ts`) |
| `<log-dir>/.owners/<hash>` | `0600` | `registerShiftLogOwner` (`logretention.ts`) |

**Why, specifically.** Before this feature a worker's stdout and stderr went to
`/dev/null`; this is the change that makes them persist. `<run>.log` is raw
output from authored workflow content, so a step that echoes a token puts that
token in the file, and `shift.log` quotes hub and workflow messages verbatim in
its `hub-error` and `order-dropped` records. That is the same data class as the
receipt artifact `packages/work/src/exec/loop.ts` already writes with
`mode: 0o600`, and the rule this repository states there — "the file is `0600`
because its content is agent-produced artifact data" — applies here unchanged.
Without an explicit mode these files would be `0666 & ~umask`, which is `0644`
under the usual `022`: readable by every local account on the machine.

**A mode applies only when the call CREATES the path.** Three consequences worth
knowing before you rely on it:

- **In the DEFAULT configuration the log directory is `0755`, not `0700`.** With
  no `--log-dir`, the log directory *is* the state directory, and the state
  directory is created earlier in the same startup by `ensureStateDir`
  (`packages/work/src/shift/state.ts`) with `mkdirSync(stateDir, {recursive:
  true})` and no `mode` — `0755` under the usual umask `022`.
  `prepareShiftLogDir` then calls `mkdirSync(dir, {mode: 0o700})` on a directory
  that already exists, which does not chmod it. So on a fresh machine running
  the defaults, any local account can list the directory and read the run ids in
  it. **The files inside are still `0600`**, so no log content is exposed — only
  its filenames. `chmod 700` the state directory if the names matter to you.
- A `<run>.log`, a `shift.log`, or a `.owners/` directory left behind by a build
  from before this was explicit **keeps its old, wider permissions**. Nothing
  re-chmods an existing path. Fix those with one `chmod` if it matters to you;
  we do not tighten a file an operator may already have handed to something
  else.
- `mkdirSync` does not chmod a directory that already exists, and that is the
  supported escape hatch for a **shared drop directory**: pre-create
  `--log-dir` with the owner, group, and mode a separate uploader account
  needs, and the shift leaves it exactly as it found it.

**The two log files stay `0600` either way.** A shared *directory* is an
operator's decision to make; it does not make the bytes inside less sensitive.
So an uploader running as a different account cannot read `shift.log` or
`<run>.log` out of the box. The intended deployment is an uploader running as
the **same user as the shift**. If you need a genuinely separate uploader
account, that is an explicit operator act today — a group-readable ACL on the
directory plus a deliberate `chmod` of the files, or a small privileged shipper
— and it is not something this feature arranges for you.

## `shift.log` — the structured log

One JSON object per line, `\n`-terminated, UTF-8. Every line is independently
parseable; there is no header, no framing, and no trailer other than the
optional `ended` record described below.

### The envelope, on every record

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | string | the discriminator; see the table below |
| `ts` | string | ISO-8601 UTC with milliseconds, e.g. `2026-08-13T18:04:11.412Z` |
| `shift` | string | the shift's human name |
| `shiftId` | string | `shf_<uuid>` — the shift **process incarnation** |

On the wire and on disk those four fields sit flat alongside the record's own
fields, which is all a JSON consumer needs. A consumer that MIRRORS the source
types should know the split is drawn one field further in: `ShiftEventEnvelope`
in `packages/work/src/shift/protocol.ts` is `ts`/`shift`/`shiftId` only, and
`type` is the discriminator on each event body, not part of the envelope type.
Same bytes, different type decomposition.

Two properties an uploader can rely on:

- **`shiftId` is stable for the life of one process and unique across
  processes.** Two shifts sharing a log directory interleave their records into
  one `shift.log`; `shiftId` is how you separate them. It is `''` only for an
  emitter that declared no shift id, which the shipped runtime never does.
  (Sharing a log directory across shifts with separate state directories is
  supported for retention too — see [The owner registry](#the-owner-registry--log-dirowners).)
- **`shift` is NOT stable.** `clock_in` renames a running shift, and each record
  carries the name in force when it was written. Group by `shiftId`, display
  `shift`.

### Record types

| `type` | Fields beyond the envelope | Meaning |
| --- | --- | --- |
| `parked` | `origin`, `cap`, `serveCrews[]`, `hostname`, `cwd` | the shift started serving; see below |
| `dispatched` | `workflow`, `run`, `step`, `kind`, `pid` | a worker was spawned |
| `reaped` | `workflow`, `run`, `kind`, `pid` | a worker exited and was collected |
| `failed` | `workflow`, `run`, `step`, `kind`, `message`, and — from the exit path only — `executable`, `exitStatus`, `signal`, optional `harness` | a worker died or could not be spawned; **two producers, two shapes** — see below |
| `capacity` | `inFlight`, `cap` | no free slot, so the `whats_next` sweep was deferred — explains a shift running nothing new while work is outstanding. **Edge-triggered**, and emitted only on a *changed* wake — see below |
| `hub-error` | `op` (`wake`\|`whats_next`), `message`, optional `workflow` | a hub call failed. `workflow` present = the targeted `whats_next` for that one workflow; `workflow` absent with `op: 'whats_next'` = the untargeted inbox call, which aborts the whole sweep. **File-only** — see below |
| `bundle-miss` | `workflow`, `def` | a legacy order named a def with no cached bundle |
| `order-dropped` | `workflow`, `run`, `step`, `reason`, `message` | the shift refused one order and left it for hub pickup |
| `event-queue-overflow` | `dropped` | the socket FIFO evicted events; see below |
| `ended` | — | an operator ran `owenloop shift end` |
| `gate` | optional `workflow`, `run`, `name`, `question` | reserved; not emitted today |

`kind` is `'exec' | 'agent-run'`.

**Four of these are file-only.** `parked`, `capacity`, `hub-error`, and
`event-queue-overflow` are written to `shift.log` and are never delivered over
the daemon's Unix socket to `owenloop shift next`. Every other type goes to
both. The routing rule is `FILE_ONLY_EVENTS` in
`packages/work/src/shift/runtime.ts`, applied at the one point where an event
fans out to its two sinks.

The split is not importance. It is what each consumer is:

- A record about a **unit of work that moved** — `dispatched`, `reaped`,
  `failed`, `order-dropped`, `bundle-miss`, `ended` — tells a socket client
  something it cannot otherwise learn. Both sinks get it.
- A record about the **shift's own condition** is redundant or harmful on the
  socket, and load-bearing in the file.

For `parked` and `capacity`, the socket-side objection is concrete: an idle
shift's `next` must **block** until there is work to report, and either record
sitting in the queue satisfies it instantly with news that nothing happened. A
`parked` record would make the first `next` after every start return
immediately; a `capacity` record would wake every attending terminal to say the
shift is full. Neither adds information — every `next` response already carries
live `cap`, `free`, and `running` in its own envelope, which is exactly what
`capacity` restates, and a socket client already knows which shift it reached
because it connected to that shift's socket (`op: 'status'` answers name,
crews, and cap on demand).

`hub-error` is file-only for the same reason plus a volume argument that makes
it a correctness matter rather than a tidiness one. **A failed hub call is not a
unit of work moving** — nothing was dispatched, reaped, or dropped; the shift
failed to ask — so it cannot claim the "a socket client cannot learn it
otherwise" justification, and it is subject to the blocking contract that
`parked` and `capacity` are subject to.

It is also the one record type that cannot self-limit. `hub-error` is
**level-triggered**: one record per failed call, for as long as the failure
lasts. The loop backs off only for HTTP 429 (`noteServerBackoff` requires a
`HubError` with `status === 429`), so an unreachable hub — `ECONNREFUSED`, DNS
failure, timeout, HTTP 500 — produces one record per poll tick with nothing
slowing it down: roughly 720 per hour per workflow at the 5s default. The socket
FIFO holds 1000 records and evicts the **oldest**, so about 83 minutes of outage
would evict every `dispatched`, `failed`, and `reaped` record a parked client
was waiting for, and every `owenloop shift next` during the outage would return
instantly carrying something that is not work.

The file keeps all of them. `shift.log` is append-only and unbounded, so an
operator can still count and time every attempt — which was the reason to record
each one, and it is a reason about the *file*, not about the wire.

`event-queue-overflow` has a second, independent reason: a record placed in the
queue that just overflowed would evict another event, overflow again, and
recurse under exactly the load that produced it. It is handed straight to the
log sink and never enters the fan-out at all.

Nothing is lost, because the file is the consumer with no envelope and no
context. `shift.log` has no per-response `cap`/`free`/`running`, so without
these four records a reader cannot tell an **idle** shift (no orders offered)
from a **saturated** one (orders offered, no slots) from a **stranded** one (hub
unreachable, so nothing was ever offered), nor tell a quiet log from a lossy
one.

`order-dropped.reason` is the stable machine discriminator and is one of
`malformed-digest`, `malformed-worker`, `unsupported-worker`,
`verification-failed`, `metadata-unavailable`. `message` is human text — match
on `reason`, display `message`.

### The first record is self-describing

A shift's first record is `parked`, and it exists so a reader holding only the
file can resolve every later record. Later records identify the shift by `shift`
and `shiftId` alone; `parked` is what those names mean:

```json
{"type":"parked","origin":"https://hub.example","cap":3,"serveCrews":["crew-a"],
 "hostname":"box.local","cwd":"/srv/work","ts":"2026-08-13T18:04:11.412Z",
 "shift":"box.local/work#a1b2c3","shiftId":"shf_…"}
```

`--once` suppresses it, matching the console `parked as …` line: a one-shot
drain is not a parked shift.

**`serveCrews: []` means EVERY crew, not none.** `owenloop shift start --all`
maps to the empty array, so an empty list is the widest possible scope rather
than the narrowest (`packages/work/src/shift/loop.ts`, `setShift`/`getShift`). A
non-empty list is the crews named on the command line. Anything joining on this
field must special-case the empty array or it will report the busiest shifts on
a host as serving nothing.

The value is the one in force AT STARTUP. `clock_in` can change a running
shift's crew set, and `parked` is written once, so a long-lived shift's current
scope is not recoverable from this record alone.

### The two `failed` shapes

`failed` has two producers and they do not emit the same fields. A consumer that
types the record off one of them rejects the other.

- **The exit path** — `reportWorkerFailure` in
  `packages/work/src/shift/runtime.ts`, reached when a worker process was
  spawned and then died. It ALWAYS includes `executable`, `exitStatus` and
  `signal`. `exitStatus` and `signal` are commonly JSON `null` (a process that
  exits on its own has no signal; one killed by a signal has no exit status), so
  type them as nullable-and-present, not optional. `harness` is the one
  genuinely optional field here — present only for an `agent-run` worker.
- **The spawn-threw path** — `emit()` in `packages/work/src/shift/loop.ts`,
  reached when `spawn()` itself threw and no process ever existed. It carries
  `workflow`, `run`, `step`, `kind` and `message` and OMITS `executable`,
  `exitStatus`, `signal` and `harness` entirely — there was no process to
  describe.

So `message` is the only failure detail present in both. Treat the four process
fields as "absent means the worker never started", not as "unknown".

One sentinel to know: on the exit path `step` is `"(unknown)"` — that literal
string, not `null` or an absent field — when the failure could not be attributed
to a named step. Anything indexing or joining on `step` must exclude it.

### The last record, when there is one

`ended` is written **only** when an operator ran `owenloop shift end`. A signal
(`SIGINT`, `SIGTERM`), a loop failure, or a `kill -9` ends the process without
one.

So, for a consumer: a `shift.log` whose last record is `ended` describes a shift
that stopped on purpose. A `shift.log` with no trailing `ended` describes a
shift that is still running, or one that stopped some other way. Those are two
different questions and the file answers both; do not treat a missing `ended` as
corruption.

### Line size

Each line is bounded at **512 KiB** (`MAX_RESPONSE_LINE_BYTES`) — the same
ceiling the Unix socket applies to a response, so the file never carries a
record the wire protocol would have refused, and an uploader can size its reads
from one number.

A record that would exceed it has its string fields shortened, largest first,
halving each pass, with the removed tail replaced by the literal marker
`[truncated]`. A field reduced to nothing becomes exactly `[truncated]`.

`type`, `ts`, and `shiftId` are **protected**: they are never shortened, because
a line must stay attributable and placeable in time even when its payload is
gone. `shift` is deliberately **not** protected — it is operator-supplied,
unbounded input, and the name is recoverable from any other record carrying the
same `shiftId`.

One consequence to code against: the 512 KiB bound applies to **string** fields
only. If some future record's non-string payload alone exceeded the ceiling, the
writer emits the oversized line rather than blank the identity that makes it
readable. No shipped record type can reach that case; an uploader should still
read lines with a bound rather than assume one.

### Overflow records

The shift daemon's in-memory socket FIFO holds 1000 events for parked
`owenloop shift next` clients. When it overflows it evicts the oldest event and
counts the loss.

`event-queue-overflow` records that count **into `shift.log`**, never back into
the queue that just overflowed. `dropped` is **cumulative for the process**, so
the newest such record states the running total lost so far, not a delta.

Records are written at powers of ten — the 1st, 10th, 100th, 1000th eviction and
so on. That gives an immediate first record, an always-current total, and at
most a handful of records for any real run. It is a deliberate trade: reporting
every eviction would roughly double the volume of a file this feature does not
rotate, and reporting only the first would leave an unattended shift claiming
`dropped: 1` forever.

**Loss is bounded to the socket, not the file.** `shift.log` gets every record;
only a parked client's view can lose events.

### Known limitation: `shift.log` is never rotated or reaped

It grows without bound for the life of a log directory, and the retention sweep
below explicitly refuses to touch it.

This is a decision, not an oversight. Rotation renames or truncates the file,
and byte-offset resumption (below) is defined against a file that only ever
grows. Making the file rotatable and making it resumable by offset are mutually
exclusive; resumability won because the uploader is the reason the file exists.
Bounding `shift.log` — by size cap, by rotation with an uploader-visible
sequence number, or by moving the whole directory per shift — is open.

Volume is low: a handful of records per dispatch. This is a slow leak, not a
fast one.

**One asymmetry to know about.** `capacity` is edge-triggered — one record when
the shift becomes full, not one per poll — precisely because repetition into a
never-rotated file actively harms it.

Read `capacity` as *at most* one record per at-capacity stretch, not exactly
one. Two things narrow it, both visible in `packages/work/src/shift/loop.ts`:

- **The hub IS still polled while a shift is full.** `opts.hub.wake(cursor)`
  runs every tick regardless of local capacity. Only the follow-up `whats_next`
  sweep is deferred. So a `capacity` record means "there was news and I could
  not go get it", never "I stopped talking to the hub".
- **The emit sits inside the `changed && k <= 0` branch.** It fires only on a
  wake that reports a *changed* cursor. A shift that fills up and stays full
  while the hub reports nothing new produces **no `capacity` record at all**.
  The absence of a record is therefore not evidence the shift had free slots.

An uploader should treat `capacity` as a hint about a moment, and derive
occupancy from `dispatched`/`reaped`/`failed` pairs, which are unconditional.

`hub-error` deliberately did **not** get
that treatment **in the file**: it is level-triggered, so a hub that is
unreachable for a day writes roughly one record per poll interval per workflow
(~17k/day at the 5s default). The reasoning is that a repeated `capacity` says
nothing new, whereas each `hub-error` is a distinct failed attempt an operator
may want to count and time. If that trade proves wrong in practice,
edge-triggering `hub-error` on `(op, message)` transitions is the obvious
change, and it belongs with the rotation decision above rather than ahead of it.

Keep the two questions apart, because they have different answers for the same
record type. **Frequency** is a property of the file: how many records one
outage writes into an append-only file that is never rotated — still open, as
above. **Routing** is a property of the wire: whether those records reach a
parked `owenloop shift next` at all — decided, and the answer is no.
`hub-error` is in `FILE_ONLY_EVENTS` precisely *because* it is level-triggered
into a socket queue that is bounded at 1000 and evicts the oldest. Neither
decision substitutes for the other.

## `<run>.log` — one worker's raw output

`<log-dir>/<run>.log`, where `<run>` is the run id sanitized by `safeRun`.

**Opaque.** No structure is imposed and none should be assumed. It is whatever
bytes the worker wrote to fd 1 and fd 2, interleaved by the kernel in write
order.

**Untrusted.** A worker runs authored workflow content. Treat the contents as
attacker-influenceable data: never echo it into a shell, an HTML page, or a log
viewer that interprets escape sequences. Untrusted is a reason not to *repeat*
those bytes, never a reason to discard them.

**Owner-only on disk.** See [Permissions](#permissions) — the file is created
`0600`, so an uploader that runs as a different account cannot read it until an
operator decides otherwise.

**Unbounded in size, by design.** No cap and no truncation. A cap would remove
exactly the pathological run you needed to read. Volume is bounded by age
instead — see retention.

**Append, never truncate.** A retried or re-armed run reuses its run id, and its
`<run>.log` keeps the previous attempt's output above the new one. Reading a log
top to bottom gives you every attempt in order.

### How the bytes get there

`createDefaultSpawner` (`packages/work/src/shift/spawn.ts`) opens the log once
with `openSync(path, 'a', 0o600)` and hands **that one descriptor** to stdio
slots 1 and 2 — the same redirection a shell writes as `2>&1`. The parent's copy
is closed in a `finally` immediately after `spawn` returns.

Three details that are load-bearing:

- **Open once, use twice.** Opening the path twice would create two independent
  file offsets on one file and silently corrupt the output.
- **A file descriptor is not a pipe.** The invariant the spawner protects is
  that no worker stdio slot is a *parent-owned pipe*: a detached worker that
  outlives its shift would keep writing into a pipe whose reader has vanished. A
  file descriptor survives the parent's exit, needs no reader, and cannot raise
  `EPIPE`.
- **Close the parent's copy.** One leaked descriptor per dispatch reaches
  `EMFILE` and stops dispatch entirely.

If the log cannot be opened, the shift prints one line —

```
owenloop shift: could not open worker log <path>: <reason> — dispatching with its output discarded
```

— and spawns the worker with its output discarded. The dispatch still happens.

That line is reported **once per shift**, not once per dispatch: every condition
that stops a log from opening — a full disk, a read-only directory, a log
directory deleted underneath a running shift — persists across the dispatches
that follow, so an unlatched report would write one stderr line per dispatch for
as long as the shift runs. The event sink latches its own failure report the
same way.

## Retention

Runs **once, at shift startup**, before any dispatch. It removes **worker logs
only**.

A `<run>.log` is removed when **both** hold:

1. no `<run>.json` in-flight record exists in **any state directory that writes
   logs into this directory** (see *The owner registry* below), **and**
2. the log's own mtime is at least `maxAge` old.

Condition 1 is not tidiness. A live worker holds an open descriptor on its log;
on POSIX, unlinking that file leaves the child writing into an orphaned inode —
bytes produced, charged against the filesystem, and unreadable. The in-flight
gate is what prevents that data loss.

### The owner registry — `<log-dir>/.owners/`

`OWENLOOP_SHIFT_LOG_DIR` is a single global setting, so pointing several crews'
shifts at **one** log directory while each crew keeps its **own** state
directory is a supported and natural layout. It is also what makes condition 1
non-trivial: a sweeping shift can only see the `<run>.json` records in the state
directory it owns. Another shift's live `<run>.log` has no record the sweeper can
see, so a naive sweep would classify it as finished and unlink it — precisely
the orphaned-inode loss the gate exists to prevent. At the 14-day default that
needs a worker quiet for 14 days; at a reduced `--log-max-age` it would fire
against **every** live worker of every other shift.

So each shift, at startup and before it sweeps, writes one claim:

```
<log-dir>/.owners/<sha256(stateDir)[0:16]>.json   →   {"stateDir":"/abs/path"}
```

The sweep reads every claim and treats a run as in flight if **any** claimed
state directory still holds its `<run>.json`. Properties that matter:

- **One file per shift, named by a hash of the state directory it names.** Two
  shifts starting simultaneously each write their own path, so no
  read-modify-write can lose a claim.
- **A stale claim errs safe, but it is not free.** If the retired shift's state
  directory no longer exists, or exists and holds no `<run>.json`, the claim
  contributes no match and costs one `stat` per candidate log. That is the
  common case and it is genuinely harmless.

  The case to know about is a state directory that **survives with records in
  it**. `<run>.json` is removed by `reconcileInFlight`, which only ever runs
  against a state directory a live shift is attending
  (`packages/work/src/shift/state.ts`). A retired crew's directory that no shift
  attends again keeps its records indefinitely — and `isShiftLogReapable`
  returns false whenever `hasRunRecord`, so every matching `<run>.log` becomes
  permanently un-reapable. The cost is unbounded disk, not one `stat`.

  The direction is deliberate: erring toward keeping a log costs disk, erring
  the other way costs an operator the evidence they went looking for, and an
  orphaned inode is unrecoverable while a wasted byte is not. **Operationally**:
  deleting a retired shift's state directory outright also retires its claim's
  effect, because a claim naming a directory that does not exist matches
  nothing. Deleting the claim file alone is not enough if some *other* shift
  also claims that directory.
- **A corrupt or unreadable claim costs only its claimant**, never the sweep,
  and the sweeping shift's own state directory is always consulted regardless.
- If the claim cannot be written, the shift reports one line to its stderr and
  keeps dispatching — its logs are then at risk from another shift sharing the
  directory, which is the only reason that line exists.

`.owners/` is not a log. It is never swept, and an uploader should ignore it.

`maxAge` resolution, highest priority first:

1. `--log-max-age <ms>`
2. `OWENLOOP_SHIFT_LOG_MAX_AGE_MS`
3. `shiftLogMaxAgeMs` in settings
4. **14 days** — the default

`0` is a real choice, not "off": it means *reap every completed run's log at the
next shift startup*. There is no value that disables the sweep.

The environment variable is accepted only as a **non-negative integer number of
milliseconds**. An unparseable value, a negative one, and a non-integer one
(`86400000.5` is dropped, not rounded) are all ignored, and resolution falls
through to the next source — a typo in an env var must not stop a shift from
serving. The ignoring is silent, so a shift running on the default after a typo
looks exactly like a shift running on the default on purpose.

**Never reaped at any age:** `shift.log`, `.owners/`, anything not ending in
`.log`, and any `*.log` whose basename is not a `run_…` id. The log directory
defaults to the state directory, which also holds `shift.sock`,
`.dispatch.lock`, and atomic-write temporaries; a sweep that removed by age
alone would eat them.

The sweep is best-effort and never throws. A locked, unreadable, or
concurrently-removed file costs that one entry, not the sweep, and never the
shift.

### Rolling back leaves the files behind

Downgrading to a build from before this feature is safe but not self-cleaning.
`shift.log`, every `<run>.log`, and `.owners/` stay in the log directory, and
under the default configuration that directory is the state directory the older
build still uses.

- **The old build ignores them.** `readStateRecords` reads only names ending in
  `.json`, so reconciliation and `owenloop shift status` behave exactly as they
  did — a `.log` file and the `.owners/` directory are invisible to them.
- **Nothing removes them.** The retention sweep is part of this feature, so the
  older build has no reaper. The files persist at whatever size they had reached
  until an operator deletes them by hand.

Delete `shift.log`, `run_*.log`, and `.owners/` from the log directory if the
disk matters; leave them if you intend to roll forward again, because a
re-upgraded shift resumes appending to the same `shift.log`.

## Notes for an uploader

**Resume by byte offset.** Both file kinds are opened `O_APPEND` and only ever
grow while a shift is running. Record the offset you have consumed and resume
from it. This is why `shift.log` is not rotated.

**Interleaving is safe on a local filesystem.** Each `shift.log` record is one
complete `…\n` string written with a **single** `appendFileSync` call, and two
shifts sharing a log directory both append with `O_APPEND`. Lines stay
individually parseable and `shiftId` says which process wrote each one.

Be precise about where that comes from, because it bounds where it holds: the
guarantee is a property of an `O_APPEND` `write(2)` to a **regular file on a
local filesystem**, not of `appendFileSync` itself. `appendFileSync` loops on a
short write, and a second process can append between iterations of that loop. At
the sizes involved — one record, bounded at 512 KiB — a local filesystem does
not short-write, which is why it holds in practice. On NFS it is not promised.
Parse whole lines either way and carry a trailing fragment forward, as below.

**Durability over throughput.** `shift.log` holds no descriptor between writes:
every line is on disk before `write()` returns. A buffered stream would lose its
tail in exactly the crash the log exists to explain. There is consequently
nothing to flush and no `close()` to call.

**The writer never redacts; the uploader must.** The writer's job is to lose
nothing. Deciding what may leave the machine — and stripping it — belongs to
whatever ships the bytes off the machine. Assume `<run>.log` can contain
anything a workflow author's step printed.

**A record you cannot parse is a bug to report, not a line to drop silently.**
The writer bounds and escapes every line; a malformed one means something else
wrote to the file.

**A trailing line with no `\n` is not yet a record.** Split on `\n` and parse
only complete lines; carry the remainder into the next read. A live shift may be
mid-append when you read, and a shift that was killed can leave a final
fragment. This is the one parse failure that is expected rather than a bug —
which is why it is stated as "not yet a record" rather than as an exception to
the rule above.

**Run as the same user as the shift, or arrange access deliberately.**
`shift.log` and `<run>.log` are created `0600` — always, in every configuration
— see [Permissions](#permissions). An uploader under a different account gets
`EACCES` on the files until an operator widens something on purpose, and it gets
that even where the *directory* happens to be traversable, which under the
defaults it is.

## Flags and settings

| Flag | Env | Setting | Default |
| --- | --- | --- | --- |
| `--log-dir <path>` | `OWENLOOP_SHIFT_LOG_DIR` | `shiftLogDir` | the state directory |
| `--log-max-age <ms>` | `OWENLOOP_SHIFT_LOG_MAX_AGE_MS` | `shiftLogMaxAgeMs` | `1209600000` (14 days) |

Both flags are accepted by `owenloop shift start` and `owenloop work shift`.

`owenloop work settings` prints `shiftLogDir = (unset)` and
`shiftLogMaxAgeMs = (unset)` when the settings file names neither. `(unset)`
there means *this file sets no value*, not *no default applies* — the defaults
in the table above are the ones in force. Only a few keys (`dispatchCap` and
friends) carry their built-in default into that listing.

## Source map

| Concern | File |
| --- | --- |
| event shapes, the envelope, `stampShiftEvent` | `packages/work/src/shift/protocol.ts` |
| the `shift.log` sink | `packages/work/src/shift/logsink.ts` |
| paths, resolution, the reap gate, the sweep | `packages/work/src/shift/logretention.ts` |
| line-size bounding | `packages/work/src/shift/truncate.ts` |
| worker stdio wiring | `packages/work/src/shift/spawn.ts` |
| where the emitters are wired together | `packages/work/src/shift/runtime.ts` |
| the socket FIFO and its overflow | `packages/work/src/shift/server.ts` |
