import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  crewNameFromEncodedRosterFilename,
  crewNameFromRosterFilename,
  type CrewRosterFilesystem,
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

/** Emulates case-folding exists() while preserving the directory's real names. */
const caseInsensitiveFilesystem = (): CrewRosterFilesystem => ({
  pathExists: (path) => {
    try {
      const wanted = basename(path).toLowerCase();
      return readdirSync(dirname(path)).some((entry) => entry.toLowerCase() === wanted);
    } catch {
      return false;
    }
  },
  directoryEntries: (path) => readdirSync(path),
});

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

test('case-folding filesystems preserve only an exactly spelled legacy crew file', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-case-fold-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    const lower = 'delivery';
    const upper = 'Delivery';
    const lowerPath = join(crews, `${lower}.json`);
    mkdirSync(crews, { recursive: true });
    writeFileSync(lowerPath, JSON.stringify({ roster: { build: candidate('lower', 'lower-model') } }));

    const filesystem = caseInsensitiveFilesystem();
    assert.equal(crewRosterPath(env, lower, filesystem), lowerPath, 'the original exact legacy spelling remains readable');
    const upperPath = crewRosterPath(env, upper, filesystem);
    assert.equal(upperPath, join(encodedCrewRosterDir(env), encodeCrewRosterFilename(upper)), 'a case-folded sibling is not accepted as Delivery');
    assert.notEqual(upperPath, lowerPath);
    mkdirSync(dirname(upperPath), { recursive: true });
    writeFileSync(upperPath, JSON.stringify({ crew: upper, roster: { build: candidate('upper', 'upper-model') } }));

    assert.equal(mergeRosterLayers(machineRosterLayers(env, lower)).build?.candidates[0]?.model, 'lower-model');
    assert.equal(mergeRosterLayers(machineRosterLayers(env, upper)).build?.candidates[0]?.model, 'upper-model');
    assert.deepEqual(
      discoverCrewRosterFiles(env).map((file) => file.crew).sort(),
      [lower, upper].sort(),
      'doctor discovery retains both distinct hub crew identities',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the hexadecimal codec cannot alias distinct crews under case folding', () => {
  const first = '//G';
  const second = '//a';
  const firstFilename = encodeCrewRosterFilename(first);
  const secondFilename = encodeCrewRosterFilename(second);
  assert.notEqual(firstFilename, secondFilename);
  assert.notEqual(firstFilename.toLowerCase(), secondFilename.toLowerCase(), 'lowercase-hex payloads stay distinct after case folding');
  assert.equal(firstFilename, firstFilename.toLowerCase(), 'the codec emits nothing for a filesystem to fold');
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

test('normalized contained legacy crew paths keep their pre-codec strongest roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-normalized-legacy-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const cases = [
      { crew: 'foo/../bar', legacy: join(crews, 'bar.json') },
      { crew: 'foo/./bar', legacy: join(crews, 'foo', 'bar.json') },
      { crew: 'foo//bar', legacy: join(crews, 'foo', 'bar.json') },
    ];
    for (const { legacy } of cases) {
      mkdirSync(dirname(legacy), { recursive: true });
      writeFileSync(legacy, JSON.stringify({ roster: { build: candidate('legacy', 'normalized-model') } }));
    }

    for (const { crew, legacy } of cases) {
      assert.equal(crewRosterPath(env, crew), legacy, `${crew} preserves its existing normalized legacy target`);
      assert.equal(mergeRosterLayers(machineRosterLayers(env, crew)).build?.candidates[0]?.model, 'normalized-model');
      assert.equal(existsSync(join(encodedCrewRosterDir(env), encodeCrewRosterFilename(crew))), false, `${crew} does not select an empty encoded duplicate`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a leading-separator legacy crew retains its pre-codec strongest roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-leading-separator-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    const crew = '/bar';
    const legacy = join(crews, 'bar.json');
    mkdirSync(crews, { recursive: true });
    writeFileSync(legacy, JSON.stringify({ roster: { build: candidate('legacy', 'leading-separator-model') } }));

    assert.equal(crewRosterPath(env, crew), legacy, 'the old join-normalized target remains selected');
    assert.equal(mergeRosterLayers(machineRosterLayers(env, crew)).build?.candidates[0]?.model, 'leading-separator-model');
    assert.equal(existsSync(join(encodedCrewRosterDir(env), encodeCrewRosterFilename(crew))), false, 'no encoded duplicate is selected for an existing legacy roster');
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

test('a codec-looking pre-upgrade nested legacy roster keeps its own crew identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-codec-migration-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    const decodedCrew = 'foo/bar';
    const encodedFilename = encodeCrewRosterFilename(decodedCrew);
    const legacyCrew = `.owenloop-encoded-rosters/${encodedFilename.slice(0, -'.json'.length)}`;
    const legacyPath = join(crews, `${legacyCrew}.json`);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ roster: { build: candidate('legacy', 'legacy-model') } }));

    // A codec-shaped basename inside an ordinary nested legacy directory is
    // not proof that the file belongs to foo/bar. It remains the literal crew.
    assert.equal(crewRosterPath(env, legacyCrew), legacyPath);
    const codecPath = crewRosterPath(env, decodedCrew);
    assert.equal(codecPath, join(encodedCrewRosterDir(env), encodedFilename));
    assert.notEqual(codecPath, legacyPath);
    mkdirSync(dirname(codecPath), { recursive: true });
    writeFileSync(codecPath, JSON.stringify({ crew: decodedCrew, roster: { build: candidate('codec', 'codec-model') } }));

    assert.equal(mergeRosterLayers(machineRosterLayers(env, legacyCrew)).build?.candidates[0]?.model, 'legacy-model');
    assert.equal(mergeRosterLayers(machineRosterLayers(env, decodedCrew)).build?.candidates[0]?.model, 'codec-model');
    assert.deepEqual(
      discoverCrewRosterFiles(env).map((file) => `${file.crew}\0${file.path}`).sort(),
      [`${legacyCrew}\0${legacyPath}`, `${decodedCrew}\0${codecPath}`].sort(),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a setup-stamped legacy roster is not preserved for a distinct aliasing crew', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-owner-alias-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    const owner = 'bar';
    const alias = 'foo/../bar';
    mkdirSync(crews, { recursive: true });
    // Setup records the owning crew in every file it materializes.
    const ownerPath = crewRosterPath(env, owner);
    assert.equal(ownerPath, join(crews, 'bar.json'));
    writeFileSync(ownerPath, JSON.stringify({ crew: owner, roster: { build: candidate('owner', 'owner-model') } }));

    // The aliasing crew join-normalizes onto the same legacy path but must not
    // inherit bar's strongest layer; it receives its own codec target.
    const aliasPath = crewRosterPath(env, alias);
    assert.notEqual(aliasPath, ownerPath);
    assert.equal(aliasPath, join(encodedCrewRosterDir(env), encodeCrewRosterFilename(alias)));
    mkdirSync(dirname(aliasPath), { recursive: true });
    writeFileSync(aliasPath, JSON.stringify({ crew: alias, roster: { build: candidate('alias', 'alias-model') } }));

    assert.equal(mergeRosterLayers(machineRosterLayers(env, owner)).build?.candidates[0]?.model, 'owner-model');
    assert.equal(mergeRosterLayers(machineRosterLayers(env, alias)).build?.candidates[0]?.model, 'alias-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('aliasing crews stay isolated in the reverse materialization order', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-owner-alias-reverse-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    const alias = 'foo/../bar';
    const owner = 'bar';
    mkdirSync(crews, { recursive: true });
    // The aliasing crew materializes first: with no existing legacy file to
    // preserve, its non-native name goes straight to the codec directory.
    const aliasPath = crewRosterPath(env, alias);
    assert.equal(aliasPath, join(encodedCrewRosterDir(env), encodeCrewRosterFilename(alias)));
    mkdirSync(dirname(aliasPath), { recursive: true });
    writeFileSync(aliasPath, JSON.stringify({ crew: alias, roster: { build: candidate('alias', 'alias-model') } }));

    const ownerPath = crewRosterPath(env, owner);
    assert.equal(ownerPath, join(crews, 'bar.json'), 'bar keeps its literal file untouched by the alias');
    writeFileSync(ownerPath, JSON.stringify({ crew: owner, roster: { build: candidate('owner', 'owner-model') } }));

    assert.equal(mergeRosterLayers(machineRosterLayers(env, owner)).build?.candidates[0]?.model, 'owner-model');
    assert.equal(mergeRosterLayers(machineRosterLayers(env, alias)).build?.candidates[0]?.model, 'alias-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an ownerless pre-codec operator roster keeps join semantics for every alias', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-ownerless-legacy-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const path = join(crews, 'bar.json');
    // A pre-codec operator file records no crew identity.
    writeFileSync(path, JSON.stringify({ roster: { build: candidate('operator', 'operator-model') } }));

    assert.equal(crewRosterPath(env, 'bar'), path);
    assert.equal(crewRosterPath(env, 'foo/../bar'), path, 'an ownerless file preserves the pre-codec join behavior');
    assert.equal(mergeRosterLayers(machineRosterLayers(env, 'foo/../bar')).build?.candidates[0]?.model, 'operator-model');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a corrupt preserved legacy roster fails closed instead of falling to a codec target', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-corrupt-legacy-'));
  try {
    const env = { HOME: home };
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(crews, { recursive: true });
    const path = join(crews, 'bar.json');
    writeFileSync(path, '{"crew":');

    // An unparseable file makes no ownership claim; the resolver still selects
    // it so the read errors instead of silently using an empty codec roster.
    assert.equal(crewRosterPath(env, 'bar'), path);
    assert.throws(() => machineRosterLayers(env, 'bar'), /invalid crew roster at .*bar\.json/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('codec-directory discovery keeps a 64-character unowned child as a legacy roster', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-codec-boundary-'));
  try {
    const env = { HOME: home };
    const codecDir = encodedCrewRosterDir(env);
    const crew = `${basename(codecDir)}/x`;
    assert.equal(crew.length, 64, 'boundary crew remains hub-valid');
    const legacy = join(codecDir, 'x.json');
    mkdirSync(codecDir, { recursive: true });
    writeFileSync(legacy, JSON.stringify({ roster: { build: candidate('legacy', 'boundary-model') } }));

    assert.equal(crewRosterPath(env, crew), legacy, 'resolver preserves the contained legacy file');
    assert.equal(mergeRosterLayers(machineRosterLayers(env, crew)).build?.candidates[0]?.model, 'boundary-model');
    assert.deepEqual(discoverCrewRosterFiles(env), [{ crew, path: legacy, kind: 'legacy' }], 'doctor discovery uses the same ownership classification');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('routing directly probes one crew without traversing unrelated roster subtrees', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-direct-probe-'));
  const unreadable = join(home, '.owenloop', 'crews', 'unreadable');
  try {
    const crews = join(home, '.owenloop', 'crews');
    mkdirSync(unreadable, { recursive: true });
    writeFileSync(join(crews, 'delivery.json'), JSON.stringify({ roster: { build: candidate('machine', 'model') } }));
    chmodSync(unreadable, 0o000);

    assert.equal(mergeRosterLayers(machineRosterLayers({ HOME: home }, 'delivery')).build?.candidates[0]?.harness, 'machine');
  } finally {
    chmodSync(unreadable, 0o700);
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
    writeFileSync(path, JSON.stringify({ crew, roster: { build: candidate('confined', 'model') } }));
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
    assert.match(basename(path), /^crew-hex-hash--.*\.json$/u);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"crew":');

    assert.throws(
      () => machineRosterLayers({ HOME: home }, crew),
      /invalid crew roster at .*crew-hex-hash--.*\.json/u,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
