import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  crewNameFromEncodedRosterFilename,
  crewNameFromRosterFilename,
  discoverCrewRosterFiles,
  crewRosterPath,
  decodeCrewRosterFilename,
  encodedCrewRosterDir,
  encodeCrewRosterFilename,
  isNativeCrewRosterFilename,
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
    assert.equal(absent[0]?.path, join(crews, 'absent.json'));
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
      assert.equal(existsSync(join(encodedCrewRosterDir({ HOME: home }), encodeCrewRosterFilename(crew))), false, `no duplicate created for ${crew}`);
      const encoded = encodeCrewRosterFilename(crew);
      assert.equal(decodeCrewRosterFilename(encoded), crew);
      assert.equal(crewNameFromEncodedRosterFilename(encoded), crew);
    }
    assert.equal(crewNameFromRosterFilename('percent%crew.json'), 'percent%crew', 'a legacy percent is never decoded twice');
    assert.equal(crewNameFromRosterFilename(encodeCrewRosterFilename('delivery')), encodeCrewRosterFilename('delivery').slice(0, -'.json'.length), 'root-level codec-looking names retain legacy semantics');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a POSIX legacy roster with a literal backslash remains the strongest layer after upgrade', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-backslash-'));
  try {
    const crew = 'foo\\bar';
    const legacy = join(home, '.owenloop', 'crews', `${crew}.json`);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ roster: { build: candidate('legacy', 'backslash-model') } }));

    assert.equal(crewRosterPath({ HOME: home }, crew), legacy, 'the host-valid existing legacy file wins over a new codec target');
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, crew)).build?.candidates[0]?.model, 'backslash-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a contained nested-slash legacy roster remains the strongest layer after upgrade', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-nested-'));
  try {
    const crew = 'foo/bar';
    const legacy = join(home, '.owenloop', 'crews', 'foo', 'bar.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ roster: { build: candidate('legacy', 'nested-model') } }));

    assert.equal(crewRosterPath({ HOME: home }, crew), legacy, 'an existing contained hierarchy is a legacy migration target');
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, crew)).build?.candidates[0]?.model, 'nested-model');
    assert.equal(existsSync(join(encodedCrewRosterDir({ HOME: home }), encodeCrewRosterFilename(crew))), false, 'setup must not create an empty encoded duplicate');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('shared roster discovery makes nested legacy files visible to both doctor and the resolver', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-discovery-'));
  try {
    const crew = 'foo/bar';
    const legacy = join(home, '.owenloop', 'crews', 'foo', 'bar.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ roster: { build: candidate('legacy', 'nested-model') } }));

    const discovered = discoverCrewRosterFiles({ HOME: home });
    assert.deepEqual(discovered, [{ crew, path: legacy, kind: 'legacy' }]);
    assert.equal(crewRosterPath({ HOME: home }, crew), discovered[0]!.path);
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, crew)).build?.candidates[0]?.model, 'nested-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('new literal crew roster names obey Windows component rules', () => {
  assert.equal(isNativeCrewRosterFilename('delivery', 'win32'), true);
  assert.equal(isNativeCrewRosterFilename('personal:alex', 'win32'), false, 'a colon would select an ADS path');
  assert.equal(isNativeCrewRosterFilename('CON', 'win32'), false, 'reserved DOS device names are not files');
  assert.equal(isNativeCrewRosterFilename('LPT9', 'win32'), false, 'the complete reserved-device set is rejected');
  assert.equal(isNativeCrewRosterFilename('personal:alex', 'darwin'), true, 'a POSIX filename keeps rollback compatibility');
});

test('traversal-shaped crews use the confined reversible filename codec', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-codec-'));
  try {
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const crew = '../../package';
    const path = crewRosterPath({ HOME: home }, crew);
    assert.equal(relative(crews, path).startsWith('..'), false);
    assert.equal(path, join(encodedCrewRosterDir({ HOME: home }), encodeCrewRosterFilename(crew)));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ roster: { build: candidate('confined', 'model') } }));
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, crew)).build?.candidates[0]?.harness, 'confined');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('maximum-width Unicode crews keep a bounded, rollback-safe literal filename', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-unicode-'));
  try {
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const crew = '語'.repeat(64);
    const path = crewRosterPath({ HOME: home }, crew);
    assert.equal(path, join(crews, `${crew}.json`), 'safe existing naming remains readable by older versions');
    assert.ok(Buffer.byteLength(basename(path), 'utf8') <= 240, 'the materialized component fits common filesystem limits');
    assert.ok(Buffer.byteLength(encodeCrewRosterFilename(crew), 'utf8') <= 240, 'the fallback codec is bounded too');
    writeFileSync(path, JSON.stringify({ roster: { build: candidate('unicode', 'model') } }));
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, crew)).build?.candidates[0]?.harness, 'unicode');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codec storage namespace cannot collide with a legacy crew named like an encoded filename', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-namespace-'));
  try {
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const delivery = 'delivery';
    const legacyNamedLikeCodec = encodeCrewRosterFilename(delivery).slice(0, -'.json'.length);
    const legacyPath = join(crews, `${legacyNamedLikeCodec}.json`);
    writeFileSync(legacyPath, JSON.stringify({ roster: { build: candidate('legacy', 'legacy-model') } }));

    const deliveryPath = crewRosterPath({ HOME: home }, delivery);
    const legacyCrewPath = crewRosterPath({ HOME: home }, legacyNamedLikeCodec);
    assert.notEqual(deliveryPath, legacyCrewPath);
    assert.equal(legacyCrewPath, legacyPath);
    mkdirSync(dirname(deliveryPath), { recursive: true });
    writeFileSync(deliveryPath, JSON.stringify({ roster: { build: candidate('encoded', 'delivery-model') } }));
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, delivery)).build?.candidates[0]?.model, 'delivery-model');
    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, legacyNamedLikeCodec)).build?.candidates[0]?.model, 'legacy-model');
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

test('machineRosterLayers fails closed for a malformed bounded-hash crew roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-hash-invalid-'));
  try {
    // This hub-valid name is unsafe as a literal path and too wide for the
    // reversible codec, so its filename is a non-reversible bounded hash.
    const crew = `../${'語'.repeat(61)}`;
    const path = crewRosterPath({ HOME: home }, crew);
    assert.match(basename(path), /^crew-hash--.*\.json$/u);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"crew":');

    assert.throws(
      () => machineRosterLayers({ HOME: home }, crew),
      /invalid crew roster at .*crew-hash--.*\.json/u,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
