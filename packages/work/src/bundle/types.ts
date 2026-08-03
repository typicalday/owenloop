/**
 * Structural mirrors of the workflow-def shape `prepare` fetches from the hub.
 *
 * These intentionally mirror owenloop's def grammar (`~/code/owenloop/main`
 * `src/defs.ts` RAW_STEP_KEYS) rather than invent anything: a step carries
 * `name/consumes/produces/terminal` today plus the four fields C2 needs to
 * build a step spec — `body`, `model`, `executor`, and the opaque `x` extension
 * bag. Contents of `x` are otherwise NOT validated here (owenloop treats `x` as
 * a plain map with opaque contents).
 *
 * HARNESS CARRIER (Phase 5 / D1): ONE fixed, vendor-neutral sub-key of `x` —
 * `x.harness` — carries harness selection and harness options for a step:
 * `{ id?: string, ...options }`. `validateFetchedDef` LIFTS it into two
 * first-class neutral fields on the parsed step: `harness` (the id) and
 * `harnessOptions` (every remaining key). Nothing downstream keys a data
 * structure BY a harness name. `x.owenloop` (shift routing) is a separate live
 * namespace under `x` and is untouched by the lift.
 *
 * HUB GAP (see D1 / bundle/fetch.ts): today `GET /api/workflows/:name`
 * (`packages/hub-core/src/verbs/get-workflow.ts`) returns steps with only
 * `name/consumes/produces/terminal` — no `body/model/executor/x`. C2's client
 * contract is the natural enrichment of that same route; extending the hub's
 * steps mapping with those passthrough fields is a small owenloop-service
 * follow-up (out of scope here). Typed LOOSELY on purpose — honest-loose over
 * invented-precise; tighten when the hub's bundle surface firms up.
 *
 * HASH-PINNED MULTI-DEF BUNDLE (E / merged hub squash 60d3e2c1): when a fetched
 * PARENT version pins its `calls:` children by content hash, `GET
 * /api/workflows/:name` ADDITIONALLY carries two keys (present-only — a childless
 * def, or a calls-bearing version published pre-feature, emits NEITHER and the
 * wire is byte-identical to today):
 *   - `pins`: array of `{call, name, version, hash}` — one per `calls:` step the
 *     parent pins, `hash` being the frozen child content hash.
 *   - `children`: ONE FLAT map keyed by child CONTENT HASH; each entry is a full
 *     def envelope (`{name, version, hash, inputs, steps}`) plus its own optional
 *     `pins` (grandchild pins resolve into the SAME flat map — nesting is
 *     reconstructed by following each entry's `pins`, not by nesting the map).
 * These map onto `FetchedDef.pins` (legitimate on parent AND child) and
 * `FetchedBundle.children` below.
 *
 * PERSISTENCE (DD-2): `CachedBundle.def` stays a `FetchedDef` — the parent is
 * persisted WITH its `pins` but WITHOUT the `children` map; each child is cached
 * as its OWN first-class bundle at `bundles/<childName>/<childHash>/` (carrying
 * its own `pins`). So the cache itself becomes the pin index: scanning every
 * cached bundle.json's `pins` covers the transitive closure.
 */
import type { StepPermissions } from '../harness/contract.ts';

/** A single step as served in the fetched workflow def. */
export interface FetchedStep {
  name: string;
  consumes?: unknown[];
  produces?: unknown[];
  terminal?: boolean;
  /** Prompt body — the Markdown the step agent is briefed with (D6). */
  body?: string;
  /** First-class model field; wins over a harness-option `model` (D6). */
  model?: string;
  /** `'command'` steps are exec/engine concerns, never given a spec (D6). */
  executor?: string;
  /**
   * Which harness the `agent-run` runner should host this step agent in.
   * LIFTED by `validateFetchedDef` from `x.harness.id`, or from a top-level
   * `harness` key when the def carries one (top-level WINS — forward compat for
   * an owenloop grammar that promotes the field). Declaration only: nothing
   * validates the id here; `src/roles/agent-run.ts` resolves it, ranking BELOW
   * `--harness` and `OWENLOOP_HARNESS`, and fails honestly when the id names no
   * registered adapter.
   */
  harness?: string;
  /**
   * The harness option bag — every key of `x.harness` EXCEPT `id`. Lifted by
   * `validateFetchedDef` so no code outside `src/harness/` has to reach into
   * `x` for it. Fed to `normalizeStepPermissions` at prepare time (D4).
   */
  harnessOptions?: Record<string, unknown>;
  /**
   * Opaque extension bag. Two sub-keys are meaningful to owenloop: `x.harness`
   * (lifted into `harness`/`harnessOptions` above) and `x.owenloop` (shift
   * command routing, see `src/shift/routing.ts`). Everything else passes
   * through untouched.
   */
  x?: Record<string, unknown>;
  /** `calls:` child workflow name, when this is a composed-child step (D10). */
  calls?: string;
}

/**
 * One hash-pin the hub emits for a parent's `calls:` child (E). `call` is the
 * calls-step name in the parent; `name`/`version`/`hash` identify the FROZEN
 * child def that step must dispatch. Legitimate on a parent (pins its children)
 * AND on a cached child (a child carries its own pins for its grandchildren).
 */
export interface FetchedPin {
  call: string;
  name: string;
  version: number;
  hash: string;
}

/** The fetched workflow def envelope (`data` from `GET /api/workflows/:name`). */
export interface FetchedDef {
  name: string;
  steps: FetchedStep[];
  /** Def content hash — the cache key (D2). */
  hash: string;
  /** Def version when the hub knows it; metadata only (D2). */
  version?: number;
  /**
   * Hash-pins for this def's `calls:` children (E). Present only when the wire
   * carried a `pins` array (a pinned parent, or a cached child that itself pins
   * grandchildren); absent otherwise — a childless/pre-feature def has no key.
   */
  pins?: FetchedPin[];
}

/**
 * A fetched PARENT envelope that additionally carries the frozen child closure
 * (E). `children` is the hub's ONE FLAT map keyed by child CONTENT HASH — each
 * value is a full `FetchedDef` (carrying its own `pins` for grandchildren).
 * `FetchedBundle` is a strict subtype of `FetchedDef`, so every C1/C2 caller
 * that types a fetch result as `FetchedDef` keeps compiling unchanged (DD-1).
 * The `children` map is NEVER persisted inside the parent's bundle.json (DD-2);
 * prepare caches each child as its own bundle.
 */
export interface FetchedBundle extends FetchedDef {
  children?: Record<string, FetchedDef>;
}

/**
 * The normalized per-step spec `prepare` writes to `steps/<step>.json`, one file
 * per dispatchable agent step (D4). It replaces the legacy `templates/<step>.md`
 * compiled frontmatter entirely.
 *
 * What is DELIBERATELY not in here: the four substitution tokens
 * (`ORDER_TOKEN`, `ORIGIN_TOKEN`, `ACCOUNT_TOKEN`, `SHIFT_TOKEN`) and the
 * `mcpServers.owenloop` mount. Those are built at RUN time from the live order
 * by `src/agent/brief.ts` (`renderBrief` + `buildOwenloopMcp`), which is now the
 * only place they exist. A bundle is therefore order-independent.
 *
 * There is no `extensions` key at the top level: the lossless remainder of the
 * harness option bag already lives inside `permissions.extensions`.
 *
 * There is no format version and no migration. A hash dir cached before Phase 5
 * simply has no `steps/*.json`; `readStepSpec` fails honestly and the fix is to
 * re-run `owenloop work prepare`.
 */
export interface NormalizedStepSpec {
  /** The step name — the same string that names the file. */
  step: string;
  /** The step body verbatim: no frontmatter, no substitution applied yet. */
  brief: string;
  /** The harness id the def named, when it named one. Data, never a branch. */
  harness?: string;
  /** From `normalizeStepPermissions(step.harnessOptions, step)` at prepare time. */
  permissions: StepPermissions;
}

/** What we persist under a hash dir: the validated fetch plus provenance. */
export interface CachedBundle {
  def: FetchedDef;
  /** Epoch millis the bundle was fetched. */
  fetchedAt: number;
  /** The origin it was fetched from (provenance/debugging). */
  origin: string;
}
