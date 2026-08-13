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
   the receipt the worker submits to the hub. They are **not** in `<run>.log`.

So a `<run>.log` holds the worker's own diagnostics — "holding this order",
"running this step", the `workdir` fallback warning, a crash stack — and not the
command's output. One destination each, no duplication. `packages/work/test/
shift-logs-acceptance.test.ts` asserts both halves, the presence and the
absence.

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

The shift creates the directory at startup with `mkdirSync(…, {recursive:
true})`. If that fails it prints one line to its own stderr —

```
owenloop shift: cannot create shift log directory <dir>: <reason> — continuing with logging disabled
```

— and serves with no logging at all: no `shift.log`, and every worker launched
with `stdio: ['ignore','ignore','ignore']` exactly as before this feature
existed. **Losing observability never costs a dispatch.**

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
| `failed` | `workflow`, `run`, `step`, `kind`, `message`, optional `harness`, `executable`, `exitStatus`, `signal` | a worker died or could not be spawned |
| `capacity` | `inFlight`, `cap` | no free slot, so the hub was not polled — explains an idle shift. **Edge-triggered:** one record per unbroken stretch at capacity, not one per tick |
| `hub-error` | `op` (`wake`\|`whats_next`), `message`, optional `workflow` | a hub call failed |
| `bundle-miss` | `workflow`, `def` | a legacy order named a def with no cached bundle |
| `order-dropped` | `workflow`, `run`, `step`, `reason`, `message` | the shift refused one order and left it for hub pickup |
| `event-queue-overflow` | `dropped` | the socket FIFO evicted events; see below |
| `ended` | — | an operator ran `owenloop shift end` |
| `gate` | optional `workflow`, `run`, `name`, `question` | reserved; not emitted today |

`kind` is `'exec' | 'agent-run'`.

**Three of these are file-only.** `parked`, `capacity`, and
`event-queue-overflow` are written to `shift.log` and are never delivered over
the daemon's Unix socket to `owenloop shift next`. Every other type goes to
both. The routing rule is `FILE_ONLY_EVENTS` in
`packages/work/src/shift/runtime.ts`, applied at the one point where an event
fans out to its two sinks.

The split is not importance. It is what each consumer is:

- A record about a **unit of work** — `dispatched`, `reaped`, `failed`,
  `order-dropped`, `bundle-miss`, `hub-error`, `ended` — tells a socket client
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

`event-queue-overflow` has a second, independent reason: a record placed in the
queue that just overflowed would evict another event, overflow again, and
recurse under exactly the load that produced it. It is handed straight to the
log sink and never enters the fan-out at all.

Nothing is lost, because the file is the consumer with no envelope and no
context. `shift.log` has no per-response `cap`/`free`/`running`, so without
these three records a reader cannot tell an **idle** shift (no orders offered)
from a **saturated** one (orders offered, no slots), nor tell a quiet log from a
lossy one.

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
never-rotated file actively harms it. `hub-error` deliberately did **not** get
that treatment: it is level-triggered, so a hub that is unreachable for a day
writes roughly one record per poll interval per workflow (~17k/day at the 5s
default). The reasoning is that a repeated `capacity` says nothing new, whereas
each `hub-error` is a distinct failed attempt an operator may want to count and
time. If that trade proves wrong in practice, edge-triggering `hub-error` on
`(op, message)` transitions is the obvious change, and it belongs with the
rotation decision above rather than ahead of it.

## `<run>.log` — one worker's raw output

`<log-dir>/<run>.log`, where `<run>` is the run id sanitized by `safeRun`.

**Opaque.** No structure is imposed and none should be assumed. It is whatever
bytes the worker wrote to fd 1 and fd 2, interleaved by the kernel in write
order.

**Untrusted.** A worker runs authored workflow content. Treat the contents as
attacker-influenceable data: never echo it into a shell, an HTML page, or a log
viewer that interprets escape sequences. Untrusted is a reason not to *repeat*
those bytes, never a reason to discard them.

**Unbounded in size, by design.** No cap and no truncation. A cap would remove
exactly the pathological run you needed to read. Volume is bounded by age
instead — see retention.

**Append, never truncate.** A retried or re-armed run reuses its run id, and its
`<run>.log` keeps the previous attempt's output above the new one. Reading a log
top to bottom gives you every attempt in order.

### How the bytes get there

`createDefaultSpawner` (`packages/work/src/shift/spawn.ts`) opens the log once
with `openSync(path, 'a')` and hands **that one descriptor** to stdio slots 1
and 2 — the same redirection a shell writes as `2>&1`. The parent's copy is
closed in a `finally` immediately after `spawn` returns.

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
- **A stale claim is harmless.** A retired crew's state directory either no
  longer exists or holds no records; it contributes no match and costs one
  `stat`. Erring toward keeping a log costs disk. Erring the other way costs an
  operator the evidence they went looking for.
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
next shift startup*. There is no value that disables the sweep. An unparseable
or negative environment value is ignored and resolution falls through to the
next source — a typo in an env var must not stop a shift from serving.

**Never reaped at any age:** `shift.log`, `.owners/`, anything not ending in
`.log`, and any `*.log` whose basename is not a `run_…` id. The log directory
defaults to the state directory, which also holds `shift.sock`,
`.dispatch.lock`, and atomic-write temporaries; a sweep that removed by age
alone would eat them.

The sweep is best-effort and never throws. A locked, unreadable, or
concurrently-removed file costs that one entry, not the sweep, and never the
shift.

## Notes for an uploader

**Resume by byte offset.** Both file kinds are opened `O_APPEND` and only ever
grow while a shift is running. Record the offset you have consumed and resume
from it. This is why `shift.log` is not rotated.

**Interleaving is safe.** Each `shift.log` record is one complete `…\n` string
written with a **single** `appendFileSync` call. Two shifts sharing a log
directory both append with `O_APPEND`, so single-call writes cannot interleave
into a half-line. Lines stay individually parseable and `shiftId` says which
process wrote each one.

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

## Flags and settings

| Flag | Env | Setting | Default |
| --- | --- | --- | --- |
| `--log-dir <path>` | `OWENLOOP_SHIFT_LOG_DIR` | `shiftLogDir` | the state directory |
| `--log-max-age <ms>` | `OWENLOOP_SHIFT_LOG_MAX_AGE_MS` | `shiftLogMaxAgeMs` | `1209600000` (14 days) |

Both flags are accepted by `owenloop shift start` and `owenloop work shift`.

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
