import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
    assert.equal(absent[0]?.path, join(crews, 'absent.json'));
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
