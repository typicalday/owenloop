/**
 * `owenloop work prepare <workflow> [--origin <url>]` — fetch a published workflow
 * def from the hub, cache it by content hash, and normalize each agent step
 * into a harness-neutral `steps/<step>.json` spec. Then prune superseded cache
 * revisions.
 *
 * NORMALIZED, NOT COMPILED (Phase 5 / D4): prepare no longer renders any
 * harness-specific artifact. Per agent step it writes a `NormalizedStepSpec` —
 * the step body verbatim as `brief`, the declared harness id, and
 * `normalizeStepPermissions(step.harnessOptions, step)`. The four substitution
 * tokens and the owenwork MCP mount are NOT baked in; `src/agent/brief.ts`
 * builds those at run time from the live order, so a bundle is order-independent
 * and reusable across every order of that step.
 *
 * HASH-PINNED CHILDREN (E): when the fetched parent pins its `calls:` children
 * (the wire carries `pins` + a flat hash-keyed `children` map — see
 * bundle/fetch.ts), the SAME round-trip brings the frozen child closure. prepare
 * caches each child (and grandchild — the map is flat) as its OWN bundle at
 * `bundles/<childName>/<childHash>/`, persists the parent WITH its `pins` but
 * WITHOUT the children map (DD-2), and prunes pin-aware so a superseded-but-still-
 * pinned hash survives (DD-3). An UNPINNED calls step (pre-feature publish) keeps
 * a visible "not pinned" gap line.
 *
 * Resolution (D4/D5):
 *   origin — `--origin` flag → `settings.hubOrigin` → usage error (exit 2)
 *   bearer — owenloop's store via `resolveBearer`: the `agent:<account>` slot for
 *            `OWENWORK_ACCOUNT` (default `default`), with `OWENWORK_TOKEN` as a
 *            documented dev-only override. A missing Scoped Identity key is a refuse
 *            (exit 2) naming the origin + a runnable `owenloop login` command. prepare
 *            has no `--as` flag — a Conductor sets `OWENWORK_ACCOUNT` for a
 *            non-default account.
 *   cache  — `OWENWORK_CACHE_DIR` env → `settings.cacheDir` → XDG default.
 *
 * Exit codes: 0 ok · 1 runtime failure (fetch/hub-gap/cache write) · 2 usage.
 * prepare is the entry point, NOT fail-open: a real fetch or cache error surfaces.
 */
import { fetchDef } from '../bundle/fetch.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { readBundle, resolveCacheDir, pruneSupersededHashes, writeBundle } from '../bundle/cache.ts';
import type { CachedBundle, FetchedDef, NormalizedStepSpec } from '../bundle/types.ts';
import { normalizeStepPermissions } from '../harness/permissions.ts';
import { loadSettings } from '../settings/settings.ts';
import { HubError } from '../hub/types.ts';

interface ParsedArgs {
  workflow?: string;
  origin?: string;
  error?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  let workflow: string | undefined;
  let origin: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--origin') {
      const v = args[i + 1];
      if (v === undefined) return { error: 'missing value for --origin' };
      origin = v;
      i++;
    } else if (a.startsWith('--origin=')) {
      origin = a.slice('--origin='.length);
    } else if (a.startsWith('-')) {
      return { error: `unknown option '${a}'` };
    } else if (workflow === undefined) {
      workflow = a;
    } else {
      return { error: `unexpected argument '${a}'` };
    }
  }
  return { workflow, origin };
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop work prepare: ${parsed.error}\n`);
    process.stderr.write('usage: owenloop work prepare <workflow> [--origin <url>]\n');
    return 2;
  }
  if (parsed.workflow === undefined) {
    process.stderr.write('owenloop work prepare: missing required <workflow>\n');
    process.stderr.write('usage: owenloop work prepare <workflow> [--origin <url>]\n');
    return 2;
  }
  const workflow = parsed.workflow;

  const env = process.env;
  let settings;
  try {
    settings = loadSettings(env);
  } catch (err) {
    process.stderr.write(`owenloop work prepare: ${errMsg(err)}\n`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    process.stderr.write(
      'owenloop work prepare: no hub origin — pass --origin <url> or set hubOrigin in settings\n',
    );
    return 2;
  }

  const account = env['OWENWORK_ACCOUNT'] ?? 'default';
  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    process.stderr.write(`owenloop work prepare: ${bearer.message}\n`);
    return bearer.code;
  }
  const token = bearer.token;

  let cacheDir: string;
  try {
    cacheDir = resolveCacheDir(env, settings.cacheDir);
  } catch (err) {
    process.stderr.write(`owenloop work prepare: ${errMsg(err)}\n`);
    return 1;
  }

  // Fetch + validate (throws HubError on non-2xx, Error on the D1 hub gap).
  let def;
  try {
    def = await fetchDef({ origin, name: workflow, getToken: async () => token });
  } catch (err) {
    if (err instanceof HubError) {
      process.stderr.write(`owenloop work prepare: hub error ${err.status}: ${err.message}\n`);
    } else {
      process.stderr.write(`owenloop work prepare: ${errMsg(err)}\n`);
    }
    return 1;
  }

  const out = process.stdout;
  out.write(`prepare ${workflow} @ ${origin}\n`);
  out.write(`  def hash ${def.hash}${def.version !== undefined ? ` (version ${def.version})` : ''}\n`);

  const already = readBundle(cacheDir, def.name, def.hash);
  const idempotent = already !== null;

  // Normalize the parent's agent steps into per-step specs.
  const parent = normalizeDef(def);

  // Persist the parent (unless byte-identical hash already cached). Strip the
  // `children` map from what we persist (DD-2) — children are cached as their own
  // bundles below; the parent keeps only its `pins`.
  const { children, ...parentDefRaw } = def;
  const parentDef: FetchedDef = parentDefRaw;
  let cacheLocation = '';
  if (!idempotent) {
    const bundle: CachedBundle = { def: parentDef, fetchedAt: Date.now(), origin };
    try {
      cacheLocation = writeBundle(cacheDir, bundle, parent.specs);
    } catch (err) {
      process.stderr.write(`owenloop work prepare: cache write failed: ${errMsg(err)}\n`);
      return 1;
    }
  }

  // Cache every hash-pinned child (and grandchild — the map is flat and already
  // proven closed by validateFetchedDef, so a plain iteration suffices; no
  // recursion). Each child is written as its own first-class bundle at
  // bundles/<childName>/<childHash>/, skipping any hash already cached
  // (idempotent — a re-prepare, or a child shared across parents). ALL writes
  // land before ANY prune, so the fresh parent's pins protect the fresh children.
  const childLines: string[] = [];
  const childNames = new Set<string>();
  const childEntries = Object.entries(children ?? {});
  for (const [childHash, childDef] of childEntries) {
    childNames.add(childDef.name);
    const childAlready = readBundle(cacheDir, childDef.name, childHash);
    if (childAlready !== null) {
      childLines.push(`  cached pinned child '${childDef.name}'@${childHash} (idempotent — already cached)`);
      continue;
    }
    const normalized = normalizeDef(childDef);
    try {
      writeBundle(cacheDir, { def: childDef, fetchedAt: Date.now(), origin }, normalized.specs);
    } catch (err) {
      process.stderr.write(`owenloop work prepare: cache write failed for child '${childDef.name}'@${childHash}: ${errMsg(err)}\n`);
      return 1;
    }
    childLines.push(`  cached pinned child '${childDef.name}'@${childHash} (${normalized.specs.length} step spec(s))`);
  }

  // Prune AFTER all writes: parent name first, then each DISTINCT child name
  // (keepHash = that child's own cached hash). pruneSupersededHashes is pin-aware
  // (DD-3), so a superseded-but-still-pinned hash survives.
  const pruned = pruneSupersededHashes(cacheDir, def.name, def.hash);
  const childPruned: string[] = [];
  for (const childName of childNames) {
    if (childName === def.name) continue; // parent name already pruned above
    // keepHash = the hash of this child we just cached under this parent.
    const keep = childEntries.find(([, cd]) => cd.name === childName)?.[0] ?? '';
    for (const h of pruneSupersededHashes(cacheDir, childName, keep)) childPruned.push(`${childName}@${h}`);
  }
  // Summary.
  out.write(`  normalized ${parent.specs.length} step spec(s)${idempotent ? ' (idempotent — hash already cached, not rewritten)' : ` -> ${cacheLocation}`}\n`);
  if (parent.noHarnessOptions.length > 0) out.write(`  no harness options declared: ${parent.noHarnessOptions.join(', ')}\n`);
  if (parent.commandSkipped.length > 0) out.write(`  skipped (worker:command): ${parent.commandSkipped.join(', ')}\n`);
  // calls-step messaging (DD-6): pinned children are cached (per-child lines);
  // an UNPINNED calls step (pre-feature publish, no children on the wire) keeps a
  // visible gap line.
  for (const line of childLines) out.write(`${line}\n`);
  if (children === undefined) {
    for (const child of parent.callsSteps) {
      out.write(`  calls-step child '${child}' not pinned — child not included in bundle\n`);
    }
  }
  if (pruned.length > 0) out.write(`  pruned superseded hash(es): ${pruned.join(', ')}\n`);
  if (childPruned.length > 0) out.write(`  pruned superseded child hash(es): ${childPruned.join(', ')}\n`);

  return 0;
}

interface NormalizedDef {
  /** One spec per dispatchable agent step, in def order. */
  specs: NormalizedStepSpec[];
  /**
   * Agent steps that carry no harness OPTIONS — either `x.harness` was absent
   * entirely or it was present but empty (or held only `id`). Reported so an
   * operator can see at a glance which steps run on bare defaults; it is normal,
   * not a warning.
   */
  noHarnessOptions: string[];
  commandSkipped: string[];
  /** `calls:` child workflow names (the child a calls step composes). */
  callsSteps: string[];
}

/**
 * Normalize every agent step of one def into a `NormalizedStepSpec`, classifying
 * the rest (command / calls). Pure over the cache — the caller persists. Shared
 * by the parent path and each pinned child.
 *
 * There is no adapter lookup and no "empty compile" case any more: every agent
 * step yields exactly one spec. A step with no `x.harness` is completely normal
 * and simply gets empty permissions. A step with no `body` cannot reach here —
 * `validateFetchedDef` already refused the def (the D1 hub gap).
 */
function normalizeDef(def: FetchedDef): NormalizedDef {
  const specs: NormalizedStepSpec[] = [];
  const noHarnessOptions: string[] = [];
  const commandSkipped: string[] = [];
  const callsSteps: string[] = [];

  for (const step of def.steps) {
    if (step.worker === 'command') {
      commandSkipped.push(step.name);
      continue;
    }
    if (step.calls !== undefined) {
      callsSteps.push(step.calls);
      continue;
    }
    if (step.harnessOptions === undefined) noHarnessOptions.push(step.name);
    const spec: NormalizedStepSpec = {
      step: step.name,
      brief: step.body ?? '',
      permissions: normalizeStepPermissions(step.harnessOptions, step),
    };
    if (step.harness !== undefined) spec.harness = step.harness;
    specs.push(spec);
  }

  return { specs, noHarnessOptions, commandSkipped, callsSteps };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
