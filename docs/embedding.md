# Embedding oweflow

oweflow is a library first and a CLI second. The `oweflow` binary in
[`src/cli.ts`](../src/cli.ts) is a thin adapter: it maps `argv` to method calls
on an `Engine` and prints the results as JSON. Everything it does, a host
process can do **in-process** — and get the lifecycle back as typed objects
rather than JSON on stdout.

This document covers option **A** of the engine's productization: a blessed,
documented in-process API. Two follow-ups are intentionally out of scope here —
packaging/publishing a built artifact (B), and push-style event hooks so a host
reacts without polling (C).

## The one-call factory

```ts
import { createEngine } from 'oweflow';

const { engine, store } = createEngine({
  db: '.oweflow/state.db',   // SQLite path; ':memory:' for ephemeral. Default: .oweflow/state.db
  defsDir: 'workflows',      // load *.yaml defs from a directory
});
```

`createEngine(opts)` returns `{ engine, store, defs }` and accepts:

| option      | meaning |
|-------------|---------|
| `db`        | SQLite path. `':memory:'` for an ephemeral store (great in tests). Defaults to `.oweflow/state.db`; parent dirs are created for a file path. |
| `defs`      | In-memory definitions as a `Map<string, WorkflowDef>` or an array of `WorkflowDef` (de-duped by name). Takes precedence over `defsDir`. |
| `defsDir`   | Directory of `*.yaml` definitions, loaded via `loadDefs`. A missing dir yields no defs (lenient, like the CLI), not an error. |
| `reapTtlMs` | Forwarded to the `Engine` — the stranded-lease reap TTL. |

It mirrors exactly what the CLI's `openCtx` wires up, so the binary and an
embedder drive the *same* engine the same way.

Prefer to wire it yourself? The pieces are all exported — `createEngine` is just
sugar over them:

```ts
import { Engine, openStore, loadDefs } from 'oweflow';

const store = openStore('.oweflow/state.db');
const defs = loadDefs('workflows');
const engine = new Engine(store, (name) => {
  const d = defs.get(name);
  if (!d) throw new Error(`unknown workflow definition '${name}'`);
  return d;
});
```

## The worker loop

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

## In-memory definitions

Defs don't have to come from disk. Build them in code and pass `defs` — useful
when a host generates workflows or keeps them out of the filesystem:

```ts
import { createEngine, parseDef } from 'oweflow';

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
…). For most hosts, `createEngine` + the engine methods + the `Order` /
`CommitResult` / `WorkflowStatus` types are the whole surface you need.
