# Embedding owenloop

owenloop is a library first and a CLI second. The `owenloop` binary in
[`src/cli.ts`](../src/cli.ts) is a thin adapter: it maps `argv` to method calls
on an `Engine` and prints the results as JSON. Everything it does, a host
process can do **in-process** — and get the lifecycle back as typed objects
rather than JSON on stdout.

This document covers the in-process API: the one-call factory, the worker step,
in-memory definitions, lifecycle/concurrency, and **push-style events** so a host
can react the instant the graph advances instead of polling.

## The one-call factory

```ts
import { createEngine } from 'owenloop';

const { engine, store } = createEngine({
  db: '.owenloop/state.db',   // SQLite path; ':memory:' for ephemeral. Default: .owenloop/state.db
  defsDir: 'workflows',      // load *.yaml defs from a directory
});
```

`createEngine(opts)` returns `{ engine, store, defs }` and accepts:

| option      | meaning |
|-------------|---------|
| `db`        | SQLite path. `':memory:'` for an ephemeral store (great in tests). Defaults to `.owenloop/state.db`; parent dirs are created for a file path. |
| `defs`      | In-memory definitions as a `Map<string, WorkflowDef>` or an array of `WorkflowDef` (de-duped by name). Takes precedence over `defsDir`. |
| `defsDir`   | Directory of `*.yaml` definitions, loaded via `loadDefs`. A missing dir yields no defs (lenient, like the CLI), not an error. |
| `reapTtlMs` | Forwarded to the `Engine` — the stranded-lease reap TTL. |
| `onEvent`   | A push-style observer registered at construction (equivalent to `engine.subscribe`). See [Events](#events). |
| `onListenerError` | Where a throwing listener's error is routed (default: swallowed). |

It mirrors exactly what the CLI's `openCtx` wires up, so the binary and an
embedder drive the *same* engine the same way.

Prefer to wire it yourself? The pieces are all exported — `createEngine` is just
sugar over them:

```ts
import { Engine, openStore, loadDefs } from 'owenloop';

const store = openStore('.owenloop/state.db');
const defs = loadDefs('workflows');
const engine = new Engine(store, (name) => {
  const d = defs.get(name);
  if (!d) throw new Error(`unknown workflow definition '${name}'`);
  return d;
});
```

## The worker step

The shape is the same as a CLI wiring — `tick` to pull orders, run them, then
report with `green` / `emit` / `seal` / `reject`, and `close` the run:

```ts
const wf = engine.createInstance('delivery', {
  provide: { proposal: { text: 'add dark mode' } },
});

const { orders } = engine.tick(wf);
for (const order of orders) {
  const result = await runYourWorker(order);              // ← your domain
  const commit = engine.green(wf, order.run, order.outputs[0], result);
  if (commit.outcome !== 'green') {
    // born-rejected (an input moved) or schema-rejected (§18) — inspect commit.reason
  }
  engine.close(wf, order.run);
}

const status = engine.status(wf);   // { done, debts, eligible, blocked }
```

Each `order` is self-contained: `prompt`, `consumes` (the captured green
inputs), `owes` (the owed outputs + their accumulated reason threads), plus
`inputs`/`outputs`/`model`. A consumer rejecting an upstream artifact is just
`engine.reject(wf, path, by, text)`; the forward cascade and stall liveness
behave exactly as they do under the CLI, because it's the same engine.

A runnable version of this lives at [`examples/embed.ts`](../examples/embed.ts):

```sh
node examples/embed.ts
```

## Events

The worker step above pulls work with `tick`. A host can instead **react** to
changes: `engine.subscribe(listener)` registers a synchronous observer and
returns an idempotent unsubscribe. Each listener is handed a typed `EngineEvent`
the instant a mutation commits — so a host re-`tick`s only when there is new
eligible work, resolves a promise when the terminal seals, or streams progress,
without ever polling `status` on a timer.

```ts
const off = engine.subscribe((event) => {
  switch (event.type) {
    case 'instance':  /* a new workflow was created */ break;
    case 'commit':    /* a verb landed on event.path (event.action / event.outcome) */ break;
    case 'closed':    /* a run's lease was released */ break;
    case 'settled':   // the derived post-cascade view — the no-poll signal:
      if (event.done) resolveComplete();
      else if (event.eligible.length) engine.tick(event.workflow);
      break;
  }
});
// …later…
off();   // stop receiving events
```

Or register one up front via the factory — equivalent to subscribing immediately:

```ts
const { engine } = createEngine({ db: ':memory:', defsDir: 'workflows', onEvent: (e) => log(e) });
```

The event union (exported as `EngineEvent`):

| `type`     | fields | fired when |
|------------|--------|-----------|
| `instance` | `workflow`, `def` | a workflow instance was created and seeded |
| `commit`   | `workflow`, `path`, `action`, `run?`, `outcome?` | a state-changing verb landed — `action` is one of `green`/`emit`/`seal`/`reject`/`retract`/`skip`/`retry`/`provide`; `outcome` is present for the producer verbs (`green`/`emit`/`seal`), and carries a refusal (`born-rejected`/`schema-rejected`) too |
| `closed`   | `workflow`, `run`, `outcome` | a run's lease was released by `close` |
| `settled`  | `workflow`, `done`, `eligible` | the derived state **after** the forward cascade — `eligible` is the step names with work to do; `done` is workflow completion |

**Guarantees.**

- **After-commit ordering.** Events fire *after* the mutation's transaction
  commits (and the cascade has already settled inside that tx), so a listener
  that calls `status`/`tick`/`green` observes fully-committed, settled state —
  there is no open transaction to corrupt. A state-changing verb fires its
  specific `commit`/`instance` event followed by a `settled`; `close` fires only
  `closed` (it releases a lease, it doesn't touch artifact state); `tick` fires
  nothing (it hands you orders directly).
- **Synchronous, registration order.** The engine is single-writer and
  synchronous; listeners fire in the order they subscribed, on the calling
  thread. This is an in-process observer, not an async/cross-process bus —
  cross-process hosts still coordinate through the CAS and their own reads.
- **Error isolation.** A throwing listener cannot roll back the already-committed
  write or starve its siblings: each listener call is wrapped, and a throw is
  routed to `onListenerError(err, event)` (default: swallowed, never rethrown).
- **Backwards compatible.** With no subscribers the engine does zero extra work
  and behaves identically — the hook is purely additive.

A runnable, poll-free worker driven entirely by events lives at
[`examples/events.ts`](../examples/events.ts):

```sh
node examples/events.ts
```

## In-memory definitions

Defs don't have to come from disk. Build them in code and pass `defs` — useful
when a host generates workflows or keeps them out of the filesystem:

```ts
import { createEngine, parseDef } from 'owenloop';

const research = parseDef(/* a WorkflowDef-shaped object or YAML you parsed */);
const { engine } = createEngine({ db: ':memory:', defs: [research] });
```

## Lifecycle & concurrency

- **Long-lived.** Create the `engine`/`store` once per database and reuse them;
  call `store.close()` on shutdown. There's no per-call open/close cost like the
  CLI pays.
- **Synchronous, single-writer-per-process.** The store is better-sqlite3: every
  engine call is synchronous and blocks the event loop for its (short) duration,
  and there is one writer connection per process. This suits an embedded
  control-plane/orchestrator; it is not a high-QPS request path.
- **Concurrency-safe across processes.** A `BEGIN IMMEDIATE` transaction wraps
  each mutation and a commit-fingerprint CAS rejects a commit whose inputs moved
  underneath it (see [`src/store.ts`](../src/store.ts) and `docs/design.md`
  §12). Multiple processes can drive the same database safely.
- **Errors.** Most failures throw an `Error` (e.g. unknown instance/def, a
  closed run); schema failures on `green`/`emit` are returned as a
  `CommitResult`/`EmitResult` with `outcome: 'schema-rejected'` rather than
  thrown (§18). Handle both.

## What's exported

The package entry ([`src/index.ts`](../src/index.ts)) re-exports the engine
(`Engine`, `createEngine`), the store (`openStore`, `Store`), the definition
loaders (`loadDefs`, `parseDef`, `buildDef`, …), the pure model functions
(`eligibleFirings`, `workflowStatus`, `isStalled`, …), the schema helpers, and
all the shared types (`Order`, `CommitResult`, `WorkflowStatus`, `WorkflowDef`,
`EngineEvent`, `EngineListener`, …). For most hosts, `createEngine` + the engine methods + the `Order` /
`CommitResult` / `WorkflowStatus` types are the whole surface you need.
