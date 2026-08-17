import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { explainRosterShadows, effectiveRosterLayers, mergeRosterLayers } from '../src/settings/roster.ts';
import {
  hubRosterCacheDir,
  hubRosterCachePath,
  readHubRosterCache,
  sanitizeOriginForFilename,
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

    const corruptPath = hubRosterCachePath(env, origin, 'bad');
    writeFileSync(corruptPath, '{"version":');
    const corrupt = readHubRosterCache(env, origin, 'default');
    assert.equal(corrupt.kind, 'miss');
    assert.match(corrupt.reason, /unreadable JSON/u);

    writeHubRosterCache(env, entry({ orgId: 'old-org' }));
    writeHubRosterCache(env, entry({ orgId: 'new-org' }));
    assert.equal(readHubRosterCache(env, origin, 'default').kind, 'hit');
    assert.equal(hubRosterCachePath(env, origin, 'old-org').includes('old-org'), true);
    assert.equal(existsSync(hubRosterCachePath(env, origin, 'old-org')), false);
    assert.equal(existsSync(`${hubRosterCachePath(env, origin, 'new-org')}.tmp`), false);
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
