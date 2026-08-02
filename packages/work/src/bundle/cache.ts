/**
 * Bundle cache: where `prepare` persists a fetched def and its normalized step
 * specs, keyed by the def CONTENT HASH so a republished def (new hash)
 * invalidates automatically (D2).
 *
 * Layout (D3, as of Phase 5):
 *   <cacheDir>/bundles/<workflow-name>/<hash>/
 *     bundle.json          the validated CachedBundle
 *     steps/<step>.json    one NormalizedStepSpec per dispatchable agent step
 *
 * There is NO format version and NO migration. A hash dir cached before Phase 5
 * holds `templates/*.md` and no `steps/*.json`, so `readStepSpec` returns null
 * and the caller says so honestly; re-running `owenloop work prepare` is the fix, and
 * content-hash dirs are cheap to re-fetch.
 *
 * Cache-dir resolution order (D3): `OWENLOOP_CACHE_DIR` env → `settings.cacheDir`
 * → `$XDG_CACHE_HOME/owenloop` → `$HOME/.cache/owenloop`; throws when none is
 * available (same stance as settingsPath — never guess a home dir). The env
 * override is primarily how tests point everything at a temp dir.
 *
 * Writes are atomic (temp file + rename) so a concurrent prepare for the same
 * def cannot expose a half-written file — both callers render byte-identical
 * content, so the last rename simply wins (dev's documented concurrency stance).
 *
 * `prepare` is the entry point, NOT fail-open: an unwritable cache dir is a
 * real error the user must see (contrast the GC, which is fail-open). So the
 * write helpers here let fs errors propagate.
 *
 * PINNED-IS-IMMORTAL (E, DD-3 — consumer mirror of hub INV-96): because each
 * hash-pinned child is cached as its own bundle at `bundles/<childName>/<hash>/`
 * and every cached bundle's `def.pins` names the child hashes it froze, the
 * cache itself is the pin index. `pruneSupersededHashes` is pin-aware: a hash
 * pinned by ANY still-cached bundle is never pruned, even when superseded.
 * Lazy cascade (accepted): pruning a superseded PARENT hash removes its pins, so
 * a child hash that thereby becomes unpinned is only reclaimed on the NEXT prune
 * of that child's name, not immediately. All pin scanning is fail-open — a
 * corrupt/unreadable bundle.json is skipped, never fatal.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CachedBundle, FetchedDef, NormalizedStepSpec } from './types.ts';

/** Resolve the cache root from env → settings → XDG → HOME. */
export function resolveCacheDir(
  env: Record<string, string | undefined>,
  settingsCacheDir?: string,
): string {
  const override = env['OWENLOOP_CACHE_DIR'];
  if (override !== undefined && override.trim() !== '') return override;
  if (settingsCacheDir !== undefined && settingsCacheDir.trim() !== '') return settingsCacheDir;
  const xdg = env['XDG_CACHE_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return join(xdg, 'owenloop');
  const home = env['HOME'];
  if (home !== undefined && home.trim() !== '') return join(home, '.cache', 'owenloop');
  throw new Error('cannot locate a cache directory: set OWENLOOP_CACHE_DIR, XDG_CACHE_HOME, or HOME');
}

/** `<cacheDir>/bundles/<name>` — the dir holding every hash for one workflow. */
export function workflowDir(cacheDir: string, name: string): string {
  return join(cacheDir, 'bundles', name);
}

/** `<cacheDir>/bundles/<name>/<hash>` — one specific cached def revision. */
export function hashDir(cacheDir: string, name: string, hash: string): string {
  return join(workflowDir(cacheDir, name), hash);
}

/**
 * A step name becomes a FILE NAME under `steps/`, so it must not be able to
 * escape the hash dir. Carried over verbatim from the deleted compile layer's
 * `assertSafeStep` — the def is remote input and a step named `../../x` would
 * otherwise write outside the cache.
 */
function assertSafeStep(step: string): void {
  if (step.includes('/') || step.includes('\\') || step.includes('..')) {
    throw new Error(`unsafe step name '${step}': must not contain '/', '\\', or '..'`);
  }
}

/** Atomic write: temp file + rename into place. Fs errors propagate. */
function atomicWrite(filePath: string, content: string): void {
  const dir = join(filePath, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Math.random().toString(36).slice(2)}-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Write a cached bundle + its normalized step specs under the hash dir. Returns
 * the hash dir path. Overwrites are fine — atomic per file. Each spec lands at
 * `steps/<spec.step>.json`.
 */
export function writeBundle(
  cacheDir: string,
  bundle: CachedBundle,
  specs: NormalizedStepSpec[],
): string {
  const dir = hashDir(cacheDir, bundle.def.name, bundle.def.hash);
  atomicWrite(join(dir, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  for (const spec of specs) {
    assertSafeStep(spec.step);
    atomicWrite(join(dir, 'steps', `${spec.step}.json`), JSON.stringify(spec, null, 2) + '\n');
  }
  return dir;
}

/**
 * Read a cached bundle for `(name, hash)`, or `null` when absent or corrupt.
 * A corrupt `bundle.json` is treated as absent (refetch), not an error — a
 * cache read must never harden into a failure the user cannot clear by
 * re-fetching.
 */
export function readBundle(cacheDir: string, name: string, hash: string): CachedBundle | null {
  const file = join(hashDir(cacheDir, name, hash), 'bundle.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CachedBundle;
  } catch {
    return null;
  }
}

/**
 * Read the most-recently-fetched cached bundle for `name`, or `null` when none
 * is cached. After a prepare only one hash dir survives (the others are pruned),
 * but if several exist the newest by `fetchedAt` wins. Corrupt `bundle.json`
 * files are skipped, not fatal.
 */
export function readLatestBundle(cacheDir: string, name: string): CachedBundle | null {
  const dir = workflowDir(cacheDir, name);
  let hashes: string[];
  try {
    hashes = readdirSync(dir);
  } catch {
    return null;
  }
  let best: CachedBundle | null = null;
  for (const hash of hashes) {
    const b = readBundle(cacheDir, name, hash);
    if (b === null) continue;
    if (best === null || b.fetchedAt > best.fetchedAt) best = b;
  }
  return best;
}

/**
 * Read the normalized step spec for `(name, hash, step)`, or `null` when it is
 * absent, unreadable, or not valid JSON. Layout mirrors `writeBundle`:
 * `<cacheDir>/bundles/<name>/<hash>/steps/<step>.json`.
 *
 * Never throws — a missing spec is a normal case the caller reports and moves
 * past (a command step has no spec by design, and a hash dir prepared before
 * Phase 5 has none at all). There is deliberately NO fallback to the legacy
 * `templates/<step>.md`: silently running a stale compiled template would be
 * worse than an honest "re-run `owenloop work prepare`".
 */
export function readStepSpec(
  cacheDir: string,
  name: string,
  hash: string,
  step: string,
): NormalizedStepSpec | null {
  try {
    assertSafeStep(step);
  } catch {
    return null;
  }
  const file = join(hashDir(cacheDir, name, hash), 'steps', `${step}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as NormalizedStepSpec;
    if (typeof parsed?.step !== 'string' || typeof parsed?.brief !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Scan every cached bundle's `def.pins` across the whole cache, yielding each
 * pin target as `{name, hash}`. Reads every `bundles/<name>/<hash>/bundle.json`;
 * a corrupt or unreadable bundle.json is skipped (fail-open — a bad file degrades protection
 * toward keeping less, never crashes prepare). Internal: shared by
 * `pruneSupersededHashes`, `collectPinnedHashes`, and `readDispatchBundle`.
 */
function scanCachedPins(cacheDir: string): Array<{ name: string; hash: string }> {
  const out: Array<{ name: string; hash: string }> = [];
  const bundlesRoot = join(cacheDir, 'bundles');
  let names: string[];
  try {
    names = readdirSync(bundlesRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    let hashes: string[];
    try {
      hashes = readdirSync(workflowDir(cacheDir, name));
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const b = readBundle(cacheDir, name, hash);
      if (b === null) continue; // absent/corrupt → skipped (fail-open)
      for (const pin of b.def.pins ?? []) {
        if (typeof pin?.name === 'string' && typeof pin?.hash === 'string') {
          out.push({ name: pin.name, hash: pin.hash });
        }
      }
    }
  }
  return out;
}

/**
 * Every distinct hash of workflow `name` that some still-cached bundle (any
 * name, including a parent, a sibling child, or `name` itself) currently pins.
 * The protected set for pruning and the pin-index for dispatch resolution.
 * Fail-open via `scanCachedPins`.
 */
export function collectPinnedHashes(cacheDir: string, name: string): Set<string> {
  const set = new Set<string>();
  for (const pin of scanCachedPins(cacheDir)) {
    if (pin.name === name) set.add(pin.hash);
  }
  return set;
}

/**
 * Delete hash dirs under `<name>` except the protected set (DD-3): `keepHash`
 * plus every hash of `name` pinned by any still-cached bundle (pinned-is-immortal
 * — the consumer mirror of the hub's INV-96). Signature unchanged from D2, so
 * every existing call site inherits the rule. Fail-open: a prune error is
 * swallowed (the fresh bundle is already written; a leftover stale dir is
 * harmless), and a corrupt bundle.json in the pin scan is skipped rather than
 * fatal.
 */
export function pruneSupersededHashes(cacheDir: string, name: string, keepHash: string): string[] {
  const dir = workflowDir(cacheDir, name);
  const pruned: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return pruned;
  }
  const protectedHashes = collectPinnedHashes(cacheDir, name);
  for (const entry of entries) {
    if (entry === keepHash) continue;
    if (protectedHashes.has(entry)) continue; // pinned by some cached bundle → immortal
    try {
      rmSync(join(dir, entry), { recursive: true, force: true });
      pruned.push(entry);
    } catch {
      // best-effort per dir
    }
  }
  return pruned;
}

/**
 * The dispatch-time bundle selection for `name` (DD-4), used by the proxy sweep
 * in place of a bare `readLatestBundle`. `whats_next` serves only the def NAME
 * (no hash, no parent linkage), so per-instance pin disambiguation must come
 * from the local cache's pin index:
 *   - 0 pinned hashes for `name` → `readLatestBundle` (today's behavior, byte
 *     for byte for the common, unpinned case).
 *   - exactly 1 pinned hash h → the bundle AT that hash (single-resolution
 *     honored, even when a NEWER unpinned hash of `name` is cached). If that
 *     bundle is missing/corrupt we do NOT fall back to latest (that would
 *     silently run the wrong version): return `{ bundle: null, warning }` naming
 *     `owenloop work prepare <parent>` as the fix — orders lapse via the pickup window.
 *   - >1 distinct pinned hashes (two cached parents pin DIFFERENT versions of
 *     one child name — legal across parents; the hub only forbids it inside one
 *     parent's tree) → ambiguous per-instance, so refuse: `{ bundle: null,
 *     warning }`, leave orders for the pickup window. Deliberate fail-safe —
 *     never guess a version. Reversible once the hub enriches `whats_next` with a
 *     def hash (owenloop-service follow-up, out of scope here).
 */
export function readDispatchBundle(
  cacheDir: string,
  name: string,
): { bundle: CachedBundle | null; warning?: string } {
  const pinned = collectPinnedHashes(cacheDir, name);
  if (pinned.size === 0) {
    return { bundle: readLatestBundle(cacheDir, name) };
  }
  if (pinned.size > 1) {
    const hashes = [...pinned].sort().join(', ');
    return {
      bundle: null,
      warning:
        `def '${name}' is pinned to ${pinned.size} distinct hashes (${hashes}) by different cached parents — ` +
        `cannot disambiguate per-instance (whats_next carries no def hash); leaving orders for the pickup window`,
    };
  }
  const [hash] = [...pinned];
  const bundle = readBundle(cacheDir, name, hash!);
  if (bundle === null) {
    return {
      bundle: null,
      warning:
        `def '${name}' is pinned to hash ${hash} but that bundle is not cached — ` +
        `run \`owenloop work prepare\` for the pinning parent; leaving orders for the pickup window`,
    };
  }
  return { bundle };
}

/**
 * Resolve the pinned child target for a parent's `calls:` step (pure). Matches
 * `def.pins[].call` against `callStep`, returning `{name, hash}` for the frozen
 * child that step must dispatch, or `null` when the def has no matching pin. The
 * parent-pin → child-bundle resolvable path (item 3 of the brief); D-work builds
 * child-run spawning on top of it.
 */
export function resolvePinnedChild(def: FetchedDef, callStep: string): { name: string; hash: string } | null {
  for (const pin of def.pins ?? []) {
    if (pin.call === callStep) return { name: pin.name, hash: pin.hash };
  }
  return null;
}
