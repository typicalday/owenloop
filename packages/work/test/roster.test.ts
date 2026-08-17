import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  crewNameFromRosterFilename,
  crewRosterPath,
  decodeCrewRosterFilename,
  encodeCrewRosterFilename,
  machineRosterLayers,
  mergeRosterLayers,
  type RosterLayer,
} from '../src/settings/roster.ts';

const candidate = (harness: string, model: string) => [{ harness, model, effort: 'high' }] as const;

test('mergeRosterLayers keeps the first complete row and accepts arbitrary layer count', () => {
  const layers: RosterLayer[] = [
    { source: 'crew', roster: { build: candidate('crew', 'crew-model') } },
    { source: 'machine', roster: { wise: candidate('machine', 'machine-model') } },
    {
      source: 'hub crew',
      roster: {
        build: candidate('hub', 'must-not-merge'),
        review: candidate('hub', 'third-layer-model'),
      },
    },
    { source: 'hub global', roster: { final: candidate('global', 'fourth-layer-model') } },
  ];
  const merged = mergeRosterLayers(layers);
  assert.deepEqual(merged.build, { candidates: candidate('crew', 'crew-model'), source: 'crew' });
  assert.deepEqual(merged.review, { candidates: candidate('hub', 'third-layer-model'), source: 'hub crew' });
  assert.deepEqual(merged.final, { candidates: candidate('global', 'fourth-layer-model'), source: 'hub global' });
});

test('mergeRosterLayers preserves prototype-colliding capability keys as own rows', () => {
  const roster = Object.create(null) as Record<string, ReturnType<typeof candidate>>;
  roster['__proto__'] = candidate('proto', 'proto-model');
  roster['constructor'] = candidate('constructor', 'constructor-model');
  roster['toString'] = candidate('stringify', 'stringify-model');

  const merged = mergeRosterLayers([{ source: 'machine', roster }]);
  assert.equal(Object.getPrototypeOf(merged), null);
  assert.deepEqual(merged['__proto__'], { candidates: candidate('proto', 'proto-model'), source: 'machine' });
  assert.deepEqual(merged['constructor'], { candidates: candidate('constructor', 'constructor-model'), source: 'machine' });
  assert.deepEqual(merged['toString'], { candidates: candidate('stringify', 'stringify-model'), source: 'machine' });
});

test('machineRosterLayers prefers a present crew roster and retains absent paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-'));
  try {
    const dir = join(home, '.owenloop');
    const crews = join(dir, 'crews');
    mkdirSync(crews, { recursive: true });
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ roster: { build: candidate('global', 'global-model') } }),
    );
    writeFileSync(
      join(crews, 'delivery.json'),
      JSON.stringify({ roster: { build: candidate('crew', 'crew-model') } }),
    );
    const layers = machineRosterLayers({ HOME: home }, 'delivery');
    assert.equal(layers[0]?.source, 'machine crews/delivery.json');
    assert.equal(layers[0]?.path, join(crews, 'delivery.json'));
    assert.equal(layers[1]?.source, 'machine settings.json');
    assert.deepEqual(mergeRosterLayers(layers).build, {
      candidates: candidate('crew', 'crew-model'),
      source: 'machine crews/delivery.json',
    });

    const absent = machineRosterLayers({ HOME: home }, 'absent');
    assert.equal(absent[0]?.roster, undefined);
    assert.equal(absent[0]?.path, join(crews, encodeCrewRosterFilename('absent')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('crew filename codec round-trips new names while preserving every safe legacy roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-codec-'));
  try {
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    for (const crew of ['space crew', 'personal:alex', 'percent%crew', '日本語']) {
      const legacy = join(crews, `${crew}.json`);
      writeFileSync(legacy, JSON.stringify({ roster: { build: candidate('legacy', crew) } }));
      const resolved = crewRosterPath({ HOME: home }, crew);
      assert.equal(resolved, legacy, `upgrade keeps legacy ${crew} in place`);
      assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, crew)).build?.candidates[0]?.model, crew);
      assert.equal(existsSync(join(crews, encodeCrewRosterFilename(crew))), false, `no duplicate created for ${crew}`);
      const encoded = encodeCrewRosterFilename(crew);
      assert.equal(decodeCrewRosterFilename(encoded), crew);
      assert.equal(crewNameFromRosterFilename(encoded), crew);
    }
    assert.equal(crewNameFromRosterFilename('percent%crew.json'), 'percent%crew', 'a legacy percent is never decoded twice');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('traversal-shaped crews use the confined reversible filename codec', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-codec-'));
  try {
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const crew = '../../package';
    const path = crewRosterPath({ HOME: home }, crew);
    assert.equal(relative(crews, path).startsWith('..'), false);
    assert.equal(path, join(crews, encodeCrewRosterFilename(crew)));
    writeFileSync(path, JSON.stringify({ roster: { build: candidate('confined', 'model') } }));
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, crew)).build?.candidates[0]?.harness, 'confined');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('machineRosterLayers names an invalid crew file path', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-'));
  try {
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const path = join(crews, 'bad.json');
    writeFileSync(path, JSON.stringify({ roster: { build: { model: 'old', effort: 'high' } } }));
    assert.throws(() => machineRosterLayers({ HOME: home }, 'bad'), /invalid crew roster at .*bad\.json/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
