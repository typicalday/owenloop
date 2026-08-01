import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { fetchDef, validateFetchedDef } from '../src/bundle/fetch.ts';
import { HubError } from '../src/hub/types.ts';
import {
  collectPinnedHashes,
  hashDir,
  pruneSupersededHashes,
  readBundle,
  readDispatchBundle,
  readLatestBundle,
  readStepSpec,
  resolveCacheDir,
  resolvePinnedChild,
  writeBundle,
} from '../src/bundle/cache.ts';
import type { CachedBundle, FetchedDef, FetchedPin } from '../src/bundle/types.ts';

// ---- validateFetchedDef -----------------------------------------------------

const enriched = {
  text: 'ok',
  name: 'demo',
  hash: 'h1',
  version: 2,
  steps: [
    { name: 'builder', body: 'do it', model: 'opus', x: { harness: {} } },
    { name: 'runner', worker: 'command' }, // command step needs no body
  ],
};

test('validateFetchedDef accepts the enriched shape', () => {
  const def = validateFetchedDef(enriched, 'demo');
  assert.equal(def.hash, 'h1');
  assert.equal(def.version, 2);
  assert.equal(def.steps.length, 2);
  assert.equal(def.steps[0]!.body, 'do it');
});

test('validateFetchedDef flags the D1 hub gap (agent step with no body)', () => {
  const bodyless = { text: 'ok', name: 'demo', hash: 'h1', steps: [{ name: 'builder' }] };
  assert.throws(() => validateFetchedDef(bodyless, 'demo'), /does not serve step bodies yet/);
});

test('validateFetchedDef rejects a missing hash and a missing steps array', () => {
  assert.throws(() => validateFetchedDef({ text: 'x', steps: [] }, 'demo'), /missing a content hash/);
  assert.throws(() => validateFetchedDef({ text: 'x', hash: 'h' }, 'demo'), /missing a steps array/);
});

test('validateFetchedDef rejects a non-map x', () => {
  const bad = { text: 'x', hash: 'h', steps: [{ name: 'b', body: 'x', x: [] }] };
  assert.throws(() => validateFetchedDef(bad, 'demo'), /non-map x/);
});

// ---- the neutral harness carrier (D1) --------------------------------------

/** One agent step wrapped in a minimal def envelope, validated. */
const oneStep = (step: Record<string, unknown>) =>
  validateFetchedDef({ text: 'ok', name: 'demo', hash: 'h', steps: [{ body: 'b', ...step }] }, 'demo')
    .steps[0]!;

test('validateFetchedDef lifts harness out of x.harness.id and keeps the rest as options', () => {
  const s = oneStep({ name: 'builder', x: { harness: { id: 'codex', tools: 'Read,Bash', maxTurns: 4 } } });
  assert.equal(s.harness, 'codex');
  assert.deepEqual(s.harnessOptions, { tools: 'Read,Bash', maxTurns: 4 });
  // `id` is lifted, never left behind in the option bag.
  assert.ok(!Object.hasOwn(s.harnessOptions!, 'id'));
});

test('validateFetchedDef lifts a top-level harness, and it WINS over x.harness.id', () => {
  // Forward compat: owenloop's RAW_STEP_KEYS rejects this key at publish today.
  assert.equal(oneStep({ name: 'builder', harness: 'codex' }).harness, 'codex');
  const both = oneStep({ name: 'builder', harness: 'top', x: { harness: { id: 'bag' } } });
  assert.equal(both.harness, 'top');
});

test('validateFetchedDef leaves harness absent when the step declares none', () => {
  const s = oneStep({ name: 'builder' });
  assert.equal(s.harness, undefined);
  assert.equal(s.harnessOptions, undefined);
  // An x.harness with only an id yields no option bag at all, not an empty one.
  assert.equal(oneStep({ name: 'builder', x: { harness: { id: 'codex' } } }).harnessOptions, undefined);
});

test('validateFetchedDef leaves x.owenwork untouched alongside x.harness', () => {
  const s = oneStep({ name: 'builder', x: { harness: { id: 'codex' }, owenwork: { machine: 'winserver' } } });
  assert.deepEqual(s.x, { harness: { id: 'codex' }, owenwork: { machine: 'winserver' } });
});

test('validateFetchedDef errors honestly on a malformed harness carrier, naming the step', () => {
  assert.throws(
    () => oneStep({ name: 'builder', x: { harness: 'codex' } }),
    /step 'builder' has a non-map x\.harness/,
  );
  assert.throws(
    () => oneStep({ name: 'builder', x: { harness: [] } }),
    /step 'builder' has a non-map x\.harness/,
  );
  assert.throws(
    () => oneStep({ name: 'builder', x: { harness: { id: 7 } } }),
    /step 'builder' has a non-string x\.harness\.id/,
  );
  assert.throws(
    () => oneStep({ name: 'builder', harness: 7 }),
    /step 'builder' has a non-string harness/,
  );
});

// ---- hash-pinned multi-def bundle (E) --------------------------------------

/** A parent that pins one `calls:` child, with the frozen child in the flat map. */
const pinnedParent = () => ({
  text: 'ok',
  name: 'parent',
  hash: 'ph1',
  version: 4,
  steps: [
    { name: 'build', body: 'build it', x: { harness: {} } },
    { name: 'sub', calls: 'child' },
  ],
  pins: [{ call: 'sub', name: 'child', version: 2, hash: 'ch1' }],
  children: {
    ch1: {
      name: 'child',
      hash: 'ch1',
      version: 2,
      steps: [{ name: 'work', body: 'child work', x: { harness: {} } }],
    },
  },
});

test('validateFetchedDef parses pins + children into the extended shape', () => {
  const b = validateFetchedDef(pinnedParent(), 'parent');
  assert.deepEqual(b.pins, [{ call: 'sub', name: 'child', version: 2, hash: 'ch1' }]);
  assert.ok(b.children);
  const child = b.children!['ch1']!;
  assert.equal(child.name, 'child');
  assert.equal(child.hash, 'ch1');
  assert.equal(child.steps[0]!.body, 'child work');
});

test('validateFetchedDef with NEITHER key materializes no pins/children (byte-for-byte today)', () => {
  const b = validateFetchedDef(enriched, 'demo');
  assert.equal('pins' in b, false);
  assert.equal('children' in b, false);
});

test('validateFetchedDef parses a grandchild via a child’s own pins in the same flat map', () => {
  const payload = {
    text: 'ok',
    name: 'parent',
    hash: 'ph1',
    steps: [{ name: 'sub', calls: 'child' }],
    pins: [{ call: 'sub', name: 'child', version: 1, hash: 'ch1' }],
    children: {
      ch1: {
        name: 'child',
        hash: 'ch1',
        steps: [{ name: 'deep', calls: 'grand' }],
        pins: [{ call: 'deep', name: 'grand', version: 1, hash: 'gh1' }],
      },
      gh1: { name: 'grand', hash: 'gh1', steps: [{ name: 'leaf', body: 'l', x: { harness: {} } }] },
    },
  };
  const b = validateFetchedDef(payload, 'parent');
  assert.equal(b.children!['gh1']!.name, 'grand');
  assert.deepEqual(b.children!['ch1']!.pins, [{ call: 'deep', name: 'grand', version: 1, hash: 'gh1' }]);
});

test('validateFetchedDef throws when a children map key ≠ the entry hash', () => {
  const p = pinnedParent();
  (p.children as Record<string, { hash: string }>)['ch1']!.hash = 'DIFFERENT';
  assert.throws(() => validateFetchedDef(p, 'parent'), /key 'ch1' ≠ entry hash/);
});

test('validateFetchedDef throws on partial closure (a pin hash absent from children)', () => {
  const p = pinnedParent();
  p.pins[0]!.hash = 'missing';
  assert.throws(() => validateFetchedDef(p, 'parent'), /partial closure/);
});

test('validateFetchedDef throws when a pin name ≠ the children entry name', () => {
  const p = pinnedParent();
  p.pins[0]!.name = 'wrongname';
  assert.throws(() => validateFetchedDef(p, 'parent'), /names child 'wrongname' but/);
});

test('validateFetchedDef throws when pins is present without children (and inverse)', () => {
  const noChildren = { text: 'ok', name: 'p', hash: 'ph1', steps: [{ name: 'sub', calls: 'c' }], pins: [{ call: 'sub', name: 'c', version: 1, hash: 'ch1' }] };
  assert.throws(() => validateFetchedDef(noChildren, 'p'), /pins present without a children map/);
  const noPins = { text: 'ok', name: 'p', hash: 'ph1', steps: [{ name: 'b', body: 'x' }], children: { ch1: { name: 'c', hash: 'ch1', steps: [] } } };
  assert.throws(() => validateFetchedDef(noPins, 'p'), /children map present without pins/);
});

test('validateFetchedDef throws on a malformed pin (empty hash / non-int version / missing call)', () => {
  const base = () => ({ text: 'ok', name: 'p', hash: 'ph1', steps: [{ name: 'b', body: 'x' }], children: { ch1: { name: 'c', hash: 'ch1', steps: [] } } });
  assert.throws(() => validateFetchedDef({ ...base(), pins: [{ call: 'sub', name: 'c', version: 1, hash: '' }] }, 'p'), /missing a child hash/);
  assert.throws(() => validateFetchedDef({ ...base(), pins: [{ call: 'sub', name: 'c', version: 1.5, hash: 'ch1' }] }, 'p'), /non-integer version/);
  assert.throws(() => validateFetchedDef({ ...base(), pins: [{ name: 'c', version: 1, hash: 'ch1' }] }, 'p'), /missing a call step name/);
});

test('validateFetchedDef flags the D1 gap on a CHILD agent step, naming the child', () => {
  const p = pinnedParent();
  delete (p.children.ch1.steps[0] as { body?: string }).body; // child agent step now bodyless
  assert.throws(() => validateFetchedDef(p, 'parent'), /does not serve step bodies yet.*child@ch1/s);
});

// ---- fetchDef (mock server) -------------------------------------------------

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

test('fetchDef sends a bearer token and returns the validated def', async () => {
  let seenAuth = '';
  let seenUrl = '';
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    seenUrl = input.toString();
    seenAuth = (init?.headers as Record<string, string>)['authorization'] ?? '';
    return new Response(JSON.stringify(enriched), { status: 200 });
  }) as typeof fetch;
  const def = await fetchDef({ origin: 'https://hub.example/', name: 'demo', getToken: async () => 'tok', fetchImpl });
  assert.equal(seenUrl, 'https://hub.example/api/workflows/demo');
  assert.equal(seenAuth, 'Bearer tok');
  assert.equal(def.name, 'demo');
});

test('fetchDef maps a non-2xx to HubError', async () => {
  await assert.rejects(
    fetchDef({
      origin: 'https://h',
      name: 'demo',
      getToken: async () => 't',
      fetchImpl: fakeFetch(404, { error: 'not_found', message: 'no such workflow' }),
    }),
    (e: unknown) => e instanceof HubError && e.status === 404 && e.code === 'not_found',
  );
});

test('fetchDef rejects non-JSON 2xx', async () => {
  await assert.rejects(
    fetchDef({ origin: 'https://h', name: 'demo', getToken: async () => 't', fetchImpl: fakeFetch(200, 'not json') }),
    /non-JSON/,
  );
});

// ---- cache ------------------------------------------------------------------

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'owenwork-cache-'));
});
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

const mkDef = (hash: string): FetchedDef => ({ name: 'demo', hash, steps: [], version: 1 });
const mkBundle = (hash: string, fetchedAt = Date.now()): CachedBundle => ({
  def: mkDef(hash),
  fetchedAt,
  origin: 'https://h',
});
/** A cached bundle for an arbitrary workflow name at a given hash (no pins). */
const mkBundleChild = (name: string, hash: string, fetchedAt = Date.now()): CachedBundle => ({
  def: { name, hash, steps: [], version: 1 },
  fetchedAt,
  origin: 'https://h',
});

test('resolveCacheDir prefers env, then settings, then XDG, then HOME', () => {
  assert.equal(resolveCacheDir({ OWENWORK_CACHE_DIR: '/env' }, '/settings'), '/env');
  assert.equal(resolveCacheDir({}, '/settings'), '/settings');
  assert.equal(resolveCacheDir({ XDG_CACHE_HOME: '/xdg' }), join('/xdg', 'owenwork'));
  assert.equal(resolveCacheDir({ HOME: '/home/u' }), join('/home/u', '.cache', 'owenwork'));
  assert.throws(() => resolveCacheDir({}), /cannot locate a cache directory/);
});

test('writeBundle + readBundle round-trip, writing one steps/<step>.json per spec', () => {
  const spec = {
    step: 'builder',
    brief: 'BRIEF\n',
    harness: 'h-one',
    permissions: { tools: ['Read'], extensions: { extra: 1 } },
  };
  const loc = writeBundle(cacheDir, mkBundle('h1'), [spec]);
  assert.equal(loc, hashDir(cacheDir, 'demo', 'h1'));
  // The spec lands verbatim as JSON — no rendered `.md` artifact anywhere.
  assert.deepEqual(JSON.parse(readFileSync(join(loc, 'steps', 'builder.json'), 'utf8')), spec);
  assert.equal(existsSync(join(loc, 'templates')), false);
  assert.deepEqual(readStepSpec(cacheDir, 'demo', 'h1', 'builder'), spec);
  const b = readBundle(cacheDir, 'demo', 'h1');
  assert.equal(b!.def.hash, 'h1');
});

test('readBundle treats a corrupt bundle.json as absent', () => {
  const dir = hashDir(cacheDir, 'demo', 'h1');
  writeBundle(cacheDir, mkBundle('h1'), []);
  writeFileSync(join(dir, 'bundle.json'), '{ not json');
  assert.equal(readBundle(cacheDir, 'demo', 'h1'), null);
});

test('pruneSupersededHashes removes every hash dir except the kept one', () => {
  writeBundle(cacheDir, mkBundle('h1'), []);
  writeBundle(cacheDir, mkBundle('h2'), []);
  const pruned = pruneSupersededHashes(cacheDir, 'demo', 'h2');
  assert.deepEqual(pruned, ['h1']);
  assert.equal(existsSync(hashDir(cacheDir, 'demo', 'h1')), false);
  assert.equal(existsSync(hashDir(cacheDir, 'demo', 'h2')), true);
});

test('readLatestBundle picks the newest by fetchedAt', () => {
  writeBundle(cacheDir, mkBundle('h1', 1000), []);
  writeBundle(cacheDir, mkBundle('h2', 2000), []);
  assert.equal(readLatestBundle(cacheDir, 'demo')!.def.hash, 'h2');
  assert.equal(readLatestBundle(cacheDir, 'missing'), null);
});

// ---- pin-aware cache (E) ----------------------------------------------------

/** A cached bundle for `name`@`hash` that pins `pins` (its `def.pins`). */
const mkPinningBundle = (name: string, hash: string, pins: FetchedPin[], fetchedAt = Date.now()): CachedBundle => ({
  def: { name, hash, steps: [], version: 1, pins },
  fetchedAt,
  origin: 'https://h',
});
const pin = (call: string, name: string, hash: string, version = 1): FetchedPin => ({ call, name, version, hash });

test('resolvePinnedChild matches a calls step and misses a non-pinned one', () => {
  const def: FetchedDef = { name: 'parent', hash: 'ph1', steps: [], pins: [pin('sub', 'child', 'ch1')] };
  assert.deepEqual(resolvePinnedChild(def, 'sub'), { name: 'child', hash: 'ch1' });
  assert.equal(resolvePinnedChild(def, 'other'), null);
  assert.equal(resolvePinnedChild({ name: 'x', hash: 'h', steps: [] }, 'sub'), null);
});

test('collectPinnedHashes gathers a child name’s pins across multiple cached bundles', () => {
  writeBundle(cacheDir, mkPinningBundle('parentA', 'pa1', [pin('sub', 'child', 'ch1')]), []);
  writeBundle(cacheDir, mkPinningBundle('parentB', 'pb1', [pin('sub', 'child', 'ch2')]), []);
  writeBundle(cacheDir, mkPinningBundle('parentC', 'pc1', [pin('sub', 'other', 'oh1')]), []);
  assert.deepEqual([...collectPinnedHashes(cacheDir, 'child')].sort(), ['ch1', 'ch2']);
  assert.deepEqual([...collectPinnedHashes(cacheDir, 'other')], ['oh1']);
  assert.deepEqual([...collectPinnedHashes(cacheDir, 'nobody')], []);
});

test('pruneSupersededHashes keeps a pinned hash but prunes an unpinned superseded one', () => {
  // A parent pins child@ch1; the child has two cached hashes ch1 (pinned) and ch2 (unpinned).
  writeBundle(cacheDir, mkPinningBundle('parent', 'pa1', [pin('sub', 'child', 'ch1')]), []);
  writeBundle(cacheDir, mkBundleChild('child', 'ch1'), []);
  writeBundle(cacheDir, mkBundleChild('child', 'ch2'), []);
  // Prepare the child directly at ch2 (keepHash=ch2): ch1 is superseded but pinned → survives.
  const pruned = pruneSupersededHashes(cacheDir, 'child', 'ch2');
  assert.deepEqual(pruned, []); // ch1 protected by the parent's pin, ch2 is keepHash
  assert.equal(existsSync(hashDir(cacheDir, 'child', 'ch1')), true);
  assert.equal(existsSync(hashDir(cacheDir, 'child', 'ch2')), true);
});

test('pruneSupersededHashes prunes an unpinned hash and skips a corrupt bundle.json in the scan (fail-open)', () => {
  writeBundle(cacheDir, mkPinningBundle('parent', 'pa1', [pin('sub', 'child', 'ch1')]), []);
  writeBundle(cacheDir, mkBundleChild('child', 'ch1'), []);
  writeBundle(cacheDir, mkBundleChild('child', 'ch2'), []);
  // Corrupt the PARENT's bundle.json so the pin scan cannot read its pin → ch1 loses protection.
  writeFileSync(join(hashDir(cacheDir, 'parent', 'pa1'), 'bundle.json'), '{ not json');
  const pruned = pruneSupersededHashes(cacheDir, 'child', 'ch2');
  assert.deepEqual(pruned, ['ch1']); // no readable pin protects ch1 now → pruned
  assert.equal(existsSync(hashDir(cacheDir, 'child', 'ch1')), false);
});

test('readDispatchBundle: 0 pins ⇒ latest', () => {
  writeBundle(cacheDir, mkBundle('h1', 1000), []);
  writeBundle(cacheDir, mkBundle('h2', 2000), []);
  const r = readDispatchBundle(cacheDir, 'demo');
  assert.equal(r.warning, undefined);
  assert.equal(r.bundle!.def.hash, 'h2');
});

test('readDispatchBundle: exactly 1 pin ⇒ the pinned hash even when a NEWER unpinned hash exists', () => {
  writeBundle(cacheDir, mkPinningBundle('parent', 'pa1', [pin('sub', 'child', 'ch1')]), []);
  writeBundle(cacheDir, mkBundleChild('child', 'ch1', 1000), []); // pinned, older
  writeBundle(cacheDir, mkBundleChild('child', 'ch2', 5000), []); // newer, unpinned
  const r = readDispatchBundle(cacheDir, 'child');
  assert.equal(r.warning, undefined);
  assert.equal(r.bundle!.def.hash, 'ch1'); // pin wins over latest
});

test('readDispatchBundle: 1 pin but that bundle is not cached ⇒ null + warning (no fall back to latest)', () => {
  writeBundle(cacheDir, mkPinningBundle('parent', 'pa1', [pin('sub', 'child', 'chMISSING')]), []);
  writeBundle(cacheDir, mkBundleChild('child', 'chOTHER', 5000), []); // a different hash is cached
  const r = readDispatchBundle(cacheDir, 'child');
  assert.equal(r.bundle, null);
  assert.match(r.warning!, /pinned to hash chMISSING but that bundle is not cached/);
});

test('readDispatchBundle: 2 conflicting pins ⇒ null + warning (leave for pickup)', () => {
  writeBundle(cacheDir, mkPinningBundle('parentA', 'pa1', [pin('sub', 'child', 'ch1')]), []);
  writeBundle(cacheDir, mkPinningBundle('parentB', 'pb1', [pin('sub', 'child', 'ch2')]), []);
  writeBundle(cacheDir, mkBundleChild('child', 'ch1'), []);
  writeBundle(cacheDir, mkBundleChild('child', 'ch2'), []);
  const r = readDispatchBundle(cacheDir, 'child');
  assert.equal(r.bundle, null);
  assert.match(r.warning!, /pinned to 2 distinct hashes/);
});
