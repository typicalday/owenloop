import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { test } from 'node:test';

import { explainRosterShadows, effectiveRosterLayers, mergeRosterLayers } from '../src/settings/roster.ts';
import {
  hubRosterCacheDir,
  hubRosterCachePath,
  readHubRosterCache,
  sanitizeOrgIdForFilename,
  sanitizeOriginForFilename,
  withHubRosterSyncTimeout,
  writeHubRosterCache,
} from '../src/settings/hub-roster-cache.ts';

const candidate = (harness: string, model: string) => [{ harness, model, effort: 'high' }];
const origin = 'https://hub.example.test';

function entry(over: Partial<Parameters<typeof writeHubRosterCache>[1]> = {}) {
  return {
    version: 1 as const,
    origin,
    orgId: 'org_1',
    orgName: 'Example',
    account: 'default',
    fetchedAt: 1_700_000_000_000,
    global: { global: candidate('hub-global', 'g') },
    crews: [{ crewId: 'crew_1', crewName: 'delivery', roster: { crew: candidate('hub-crew', 'c') } }],
    ...over,
  };
}

function withHome(run: (home: string, env: Record<string, string>) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-hub-roster-'));
  try {
    run(home, { HOME: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('effective roster cascade keeps machine layers strongest and retains hub-only global rows', () => {
  withHome((home, env) => {
    const config = join(home, '.owenloop');
    mkdirSync(join(config, 'crews'), { recursive: true });
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ roster: { build: candidate('settings', 's') } }));
    writeFileSync(join(config, 'crews', 'delivery.json'), JSON.stringify({ roster: { build: candidate('machine', 'm') } }));
    writeHubRosterCache(env, entry({
      global: { build: candidate('hub-global', 'g'), globalOnly: candidate('hub-global', 'only') },
      crews: [{ crewId: 'crew_1', crewName: 'delivery', roster: { build: candidate('hub-crew', 'c') } }],
    }));

    const layers = effectiveRosterLayers(env, 'delivery', { origin, account: 'default' });
    assert.equal(layers.length, 4);
    assert.match(layers[2]!.source, /^hub crew delivery/u);
    assert.match(layers[3]!.source, /^hub org-global/u);
    const merged = mergeRosterLayers(layers);
    assert.equal(merged.build?.source, 'machine crews/delivery.json');
    assert.equal(merged.globalOnly?.source.startsWith('hub org-global'), true);
  });
});

test('hub crew beats hub global but every machine row beats both; shadows identify the losing sources', () => {
  withHome((home, env) => {
    writeHubRosterCache(env, entry({
      global: { deploy: candidate('hub-global', 'g') },
      crews: [{ crewId: 'crew_1', crewName: 'delivery', roster: { deploy: candidate('hub-crew', 'c') } }],
    }));
    let layers = effectiveRosterLayers(env, 'delivery', { origin, account: 'default' });
    assert.equal(mergeRosterLayers(layers).deploy?.source.startsWith('hub crew delivery'), true);

    const config = join(home, '.owenloop');
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ roster: { deploy: candidate('settings', 's') } }));
    layers = effectiveRosterLayers(env, 'delivery', { origin, account: 'default' });
    assert.equal(mergeRosterLayers(layers).deploy?.source, 'machine settings.json');
    const detail = explainRosterShadows(layers).deploy!;
    assert.equal(detail.winner, 'machine settings.json');
    assert.deepEqual(detail.shadowed.map((row) => row.source.startsWith('hub ') ? 'hub' : row.source), ['hub', 'hub']);
  });
});

test('absent, mismatched, and corrupt caches are harmless misses; cache writes prune the old org and leave no temp file', () => {
  withHome((home, env) => {
    const absent = effectiveRosterLayers(env, 'delivery', { origin, account: 'default' });
    assert.equal(absent[2]?.roster, undefined);
    assert.match(absent[2]!.source, /no cache file/u);

    writeHubRosterCache(env, entry({ origin: 'https://other.example', orgId: 'other' }));
    const mismatch = readHubRosterCache(env, origin, 'default');
    assert.equal(mismatch.kind, 'miss');
    assert.match(mismatch.reason, /cache is for origin/u);

    rmSync(hubRosterCacheDir(env), { recursive: true, force: true });
    mkdirSync(hubRosterCacheDir(env), { recursive: true });
    const corruptPath = hubRosterCachePath(env, origin, 'bad');
    writeFileSync(corruptPath, '{"version":');
    const corrupt = readHubRosterCache(env, origin, 'default');
    assert.equal(corrupt.kind, 'miss');
    assert.match(corrupt.reason, /unreadable JSON/u);

    writeHubRosterCache(env, entry({ orgId: 'old-org' }));
    writeHubRosterCache(env, entry({ orgId: 'new-org' }));
    assert.equal(readHubRosterCache(env, origin, 'default').kind, 'hit');
    assert.equal(existsSync(hubRosterCachePath(env, origin, 'old-org')), false);
    assert.equal(readdirSync(hubRosterCacheDir(env)).some((name) => name.endsWith('.tmp')), false);
  });
});

test('cache filenames confine traversal-shaped org ids beneath hub-rosters', () => {
  withHome((home, env) => {
    const orgId = 'org/../../credentials';
    const path = hubRosterCachePath(env, origin, orgId);
    assert.equal(sanitizeOrgIdForFilename(orgId), 'org%2F..%2F..%2Fcredentials');
    assert.equal(relative(hubRosterCacheDir(env), path).startsWith('..'), false);
    writeHubRosterCache(env, entry({ orgId }));
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(join(home, '.owenloop', 'credentials.json')), false);
  });
});

test('cache reads choose the newest valid matching snapshot after an interrupted repoint', () => {
  withHome((_home, env) => {
    writeHubRosterCache(env, entry({ orgId: 'old-org', fetchedAt: 100 }));
    assert.throws(
      () => writeHubRosterCache(env, entry({ orgId: 'new-org', fetchedAt: 200 }), { remove: () => { throw new Error('unlink refused'); } }),
      /unlink refused/u,
    );
    assert.equal(existsSync(hubRosterCachePath(env, origin, 'old-org')), true, 'the failed prune leaves both snapshots');
    const read = readHubRosterCache(env, origin, 'default');
    assert.equal(read.kind, 'hit');
    assert.equal(read.data.orgId, 'new-org');
    assert.equal(read.data.fetchedAt, 200);
  });
});

test('different accounts and invalid roster shapes are harmless cache misses', () => {
  withHome((_home, env) => {
    writeHubRosterCache(env, entry({ account: 'other' }));
    const accountMismatch = readHubRosterCache(env, origin, 'default');
    assert.equal(accountMismatch.kind, 'miss');
    assert.match(accountMismatch.reason, /cache is for account other/u);
  });
  withHome((_home, env) => {
    const dir = hubRosterCacheDir(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      hubRosterCachePath(env, origin, 'invalid-roster'),
      JSON.stringify(entry({ orgId: 'invalid-roster', global: { build: [] } })),
    );
    const invalid = readHubRosterCache(env, origin, 'default');
    assert.equal(invalid.kind, 'miss');
    assert.match(invalid.reason, /invalid roster shape/u);
  });
});

test('same-org accounts and sanitizer-colliding origins retain distinct cache snapshots', () => {
  withHome((_home, env) => {
    const accountA = 'agent-a';
    const accountB = 'agent-b';
    writeHubRosterCache(env, entry({ account: accountA, global: { build: candidate('a', 'a-model') } }));
    writeHubRosterCache(env, entry({ account: accountB, global: { build: candidate('b', 'b-model') } }));

    const pathA = hubRosterCachePath(env, origin, 'org_1', accountA);
    const pathB = hubRosterCachePath(env, origin, 'org_1', accountB);
    assert.notEqual(pathA, pathB);
    assert.equal(existsSync(pathA), true);
    assert.equal(existsSync(pathB), true);
    const readA = readHubRosterCache(env, origin, accountA);
    const readB = readHubRosterCache(env, origin, accountB);
    assert.equal(readA.kind, 'hit');
    assert.equal(readB.kind, 'hit');
    if (readA.kind === 'hit' && readB.kind === 'hit') {
      assert.equal(readA.data.global.build?.[0]?.harness, 'a');
      assert.equal(readB.data.global.build?.[0]?.harness, 'b');
    }

    const collisionA = hubRosterCachePath(env, 'https://hub.example-a', 'org_1', 'default');
    const collisionB = hubRosterCachePath(env, 'https://hub.example/a', 'org_1', 'default');
    assert.equal(sanitizeOriginForFilename('https://hub.example-a'), sanitizeOriginForFilename('https://hub.example/a'));
    assert.notEqual(collisionA, collisionB, 'the actual key is injective even where legacy sanitization is not');
  });
});

test('an out-of-range fetchedAt is a harmless cache miss instead of a later display-time throw', () => {
  withHome((home, env) => {
    const dir = hubRosterCacheDir(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      hubRosterCachePath(env, origin, 'out-of-range'),
      JSON.stringify(entry({ orgId: 'out-of-range', fetchedAt: 1e300 })),
    );

    const read = readHubRosterCache(env, origin, 'default');
    assert.equal(read.kind, 'miss');
    assert.match(read.reason, /invalid cache fetchedAt/u);
    assert.doesNotThrow(() => effectiveRosterLayers(env, 'delivery', { origin, account: 'default' }));
  });
});

test('a cache path that is not a readable directory is a harmless miss', () => {
  withHome((home, env) => {
    mkdirSync(join(home, '.owenloop'), { recursive: true });
    writeFileSync(hubRosterCacheDir(env), 'not a directory');
    const read = readHubRosterCache(env, origin, 'default');
    assert.equal(read.kind, 'miss');
    assert.match(read.reason, /unreadable cache directory/u);
    assert.doesNotThrow(() => effectiveRosterLayers(env, 'delivery', { origin, account: 'default' }));
  });
});

test('cache filename sanitization keys an origin without trusting the filename', () => {
  assert.equal(sanitizeOriginForFilename('HTTPS://Hub.Example.com/x'), 'https---hub.example.com-x');
});

test('cache reads and paths canonicalize equivalent hub-origin spellings', () => {
  withHome((_home, env) => {
    const trailing = `${origin}/`;
    assert.equal(hubRosterCachePath(env, origin, 'org_1'), hubRosterCachePath(env, trailing, 'org_1'));
    writeHubRosterCache(env, entry({ origin: trailing }));
    const read = readHubRosterCache(env, origin, 'default');
    assert.equal(read.kind, 'hit');
    if (read.kind === 'hit') assert.equal(read.data.origin, origin);
    assert.equal(effectiveRosterLayers(env, 'delivery', { origin: trailing, account: 'default' })[2]?.roster?.crew?.[0]?.harness, 'hub-crew');
  });
});

test('a long normalized origin still produces a bounded cache filename and a readable snapshot', () => {
  withHome((_home, env) => {
    const longOrigin = `https://${'a'.repeat(180)}.example.test`;
    const path = hubRosterCachePath(env, longOrigin, 'org_1', 'default');
    assert.ok(Buffer.byteLength(basename(path), 'utf8') <= 255, 'cache filename must fit one filesystem component');
    writeHubRosterCache(env, entry({ origin: longOrigin }));
    const read = readHubRosterCache(env, longOrigin, 'default');
    assert.equal(read.kind, 'hit');
    if (read.kind === 'hit') assert.equal(read.path, path);
  });
});

test('a never-settling roster refresh is aborted and bounded', async () => {
  let aborted = false;
  await assert.rejects(
    withHubRosterSyncTimeout((signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }), 1),
    /aborted|timed out/u,
  );
  assert.equal(aborted, true);
});

test('an immediate roster-refresh failure aborts its still-pending sibling', async () => {
  let aborted = false;
  await assert.rejects(
    withHubRosterSyncTimeout((signal) => Promise.all([
      Promise.reject(new Error('whoami failed')),
      new Promise<void>((_resolve, reject) => {
	signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      }),
    ]), 1_000),
    /whoami failed/u,
  );
  assert.equal(aborted, true);
});
