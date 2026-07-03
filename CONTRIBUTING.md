# Contributing to owenloop

Thanks for your interest in owenloop. Before your first pull request can be merged,
there's one required step: signing our Contributor License Agreement.

## Contributor License Agreement (required)

owenloop is owned by **Typical Day LLC**. The project is released under the
[GNU AGPLv3](LICENSE), and a separate commercial license is offered to
organizations that don't want AGPLv3 obligations. To keep this dual-licensing
possible — and to keep ownership of the codebase clear and in one place — Typical
Day must be the sole owner of the project's copyright.

So we ask every contributor to sign a **Contributor License Agreement (CLA)** that
**assigns copyright** in your contributions to Typical Day LLC. In plain terms:

- You **transfer ownership** of the code you contribute to Typical Day LLC.
- You get a **license back** to keep using your own contributions for anything you
  like.
- Typical Day can license and **relicense** owenloop — AGPLv3, commercial, or
  otherwise — without needing to track down every contributor.

This is a deliberate choice. If assigning copyright isn't something you're willing
to do, that's completely fine — but we won't be able to merge the contribution.

- **Individuals:** [.github/CLA.md](.github/CLA.md)
- **Contributing on behalf of an employer:** [.github/CORPORATE-CLA.md](.github/CORPORATE-CLA.md)

### How signing works

When you open a pull request, an automated check (CLA Assistant) posts a comment.
If you haven't signed yet, it asks you to reply on the PR with:

> I have read the CLA Document and I hereby sign the CLA

That records your signature (keyed to your GitHub account) so you only ever do it
once, across all your future PRs. The check then turns green and the PR can be
merged. Corporate contributors should additionally have an authorized signatory
complete [the Corporate CLA](.github/CORPORATE-CLA.md) and send it to us.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change. Keep it focused — one logical change per PR.
3. Run the checks locally before pushing:
   ```bash
   npm ci
   bash .dev/checks.sh
   ```
4. Open a pull request against `main`. CI runs on Node 22 and 24.
5. Sign the CLA when prompted (see above).

## Working from source

```sh
git clone https://github.com/typicalday/owenloop && cd owenloop
npm install
npm run check     # typecheck + full test suite
npm run build     # compile src/ → dist/ (what gets published)
```

During development, `owenloop` is `node bin/owenloop.mjs` — run that directly,
use the `npm run owenloop --` script, or `npm link` to put `owenloop` on your
PATH.

## How it's built

owenloop is small and split along a pure-core / imperative-shell line:

| module | responsibility |
|---|---|
| [`src/types.ts`](src/types.ts) | shared types: the six-state lifecycle, reason threads, def shapes |
| [`src/paths.ts`](src/paths.ts) | parse/match the `src[$i]` / `src[*]` / `src[]` path grammar |
| [`src/defs.ts`](src/defs.ts) | load YAML → validated `WorkflowDef` (the static wiring checks) |
| [`src/schema.ts`](src/schema.ts) | JSON Schema validation of artifact values, via `@cfworker/json-schema` |
| [`src/model.ts`](src/model.ts) | the pure core: what's eligible, the cascade, status, stall detection |
| [`src/store.ts`](src/store.ts) | `node:sqlite` persistence; transactions; the commit check |
| [`src/engine.ts`](src/engine.ts) | the imperative shell: `tick`/`green`/`reject`/… → mutate → `settle()` |
| [`src/cli.ts`](src/cli.ts) | argv → engine calls, JSON on stdout |

**Invariant:** every engine mutation ends with `settle()` — materialize owed outputs and
run the cascade to a fixpoint — so `status()` is a pure read over artifact state and
never lies.

### Storage

State lives in a single SQLite database via Node's built-in **`node:sqlite`** in WAL
mode — no native module to compile, no separate graph engine. The flat
artifact/task/run tables *are* the graph; the dependency structure is recomputed from
the definition on each tick. Concurrent advancement is made safe by a **commit
fingerprint check**: a run records the version of every input it claimed, and its commit
is rejected ("born-rejected") if any of those inputs moved underneath it. Each artifact
carries a monotonic version, so the engine can always ask "is this green output still
resting on the inputs it was built from?".

## Testing

```sh
npm test          # node --test, spec reporter
npm run typecheck # tsc --noEmit (type-checks the source)
npm run check     # both
npm run build     # compile src/ → dist/ (also runs automatically on npm pack/publish)
```

The suite is **579 tests**: unit tests (`paths`, `store`, `model`, `defs`, `schema`,
`util`, `cli`), engine integration tests (the cascade, the stall, schema validation,
the concurrency check, `judges:` sign-off/CAS/throttling in `test/judges.test.ts`),
and end-to-end tests that spawn the real `bin/owenloop.mjs` binary and drive the
example workflows through their full lifecycles.

Two e2e files carry most of the weight, by opposite intent.
[`test/edge.e2e.test.ts`](test/edge.e2e.test.ts) is a 26-case edge battery aimed at the
corners the design is most particular about: cascade invalidation, terminal completion
surviving an upstream reject, empty / fully-retracted collections, the commit check,
cadence and daily-budget gating, the skip-cascade, and CLI robustness against malformed
input. [`test/scenarios.e2e.test.ts`](test/scenarios.e2e.test.ts) takes the opposite
tack — eight multi-step *positive* stories that confirm the documented behaviors hold
end to end: the map `parallel` cap, map and reduce firing as concurrent branches, the
reason thread riding the next job, stall → retry → re-stall, and the cascade re-firing on
a re-provided input while leaving a healthy graph and a terminal output untouched.
[`test/schema.e2e.test.ts`](test/schema.e2e.test.ts) drives schema validation end to end:
a malformed value is rejected rather than greened, a corrected value greens on the same
open job, repeated failures trip the stall and a `retry` clears it.

## Reporting bugs and proposing features

Open an issue. For a security vulnerability, please **do not** open a public
issue — contact Typical Day directly so it can be handled responsibly.
