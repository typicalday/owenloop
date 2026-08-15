import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { settingsPath, loadSettings, validateSettings, inspectSettings, KNOWN_SETTINGS_KEYS } from '../src/settings/settings.ts';

/** Write a settings.json under a fresh temp XDG dir; returns the XDG root. */
function withSettingsFile(contents: string): string {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  const dir = join(xdg, 'owenloop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), contents);
  return xdg;
}

// Every fixture materializes its OWN ambient state (temp HOME / XDG dir it
// creates) — never the developer's or CI runner's real home.

test('settingsPath: XDG_CONFIG_HOME wins over HOME when set and non-empty', () => {
  assert.equal(
    settingsPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }),
    join('/xdg', 'owenloop', 'settings.json'),
  );
  assert.equal(
    settingsPath({ XDG_CONFIG_HOME: '  ', HOME: '/home/u' }),
    join('/home/u', '.config', 'owenloop', 'settings.json'),
  );
  assert.equal(
    settingsPath({ HOME: '/home/u' }),
    join('/home/u', '.config', 'owenloop', 'settings.json'),
  );
});

test('settingsPath: OWENLOOP_CONFIG_DIR wins over XDG_CONFIG_HOME and HOME', () => {
  // The variable an operator running SEVERAL shifts should set. `XDG_CONFIG_HOME`
  // reaches every worker and every command-step child, so scoping owenloop with
  // it also relocates `gh`, `git`, and `gcloud` for the workflow's own scripts.
  assert.equal(
    settingsPath({ OWENLOOP_CONFIG_DIR: '/srv/utility/owenloop', XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }),
    join('/srv/utility/owenloop', 'settings.json'),
  );
  // No `owenloop` segment is appended to it, unlike the XDG rung.
  assert.equal(settingsPath({ OWENLOOP_CONFIG_DIR: '/cfg' }), join('/cfg', 'settings.json'));
  // Blank reads as unset, so the ladder falls through.
  assert.equal(
    settingsPath({ OWENLOOP_CONFIG_DIR: '  ', XDG_CONFIG_HOME: '/xdg' }),
    join('/xdg', 'owenloop', 'settings.json'),
  );
});

test('settingsPath: throws when no rung of the ladder is usable', () => {
  assert.throws(() => settingsPath({}), /set OWENLOOP_CONFIG_DIR, XDG_CONFIG_HOME, or HOME/);
  assert.throws(
    () => settingsPath({ HOME: '', XDG_CONFIG_HOME: '' }),
    /set OWENLOOP_CONFIG_DIR, XDG_CONFIG_HOME, or HOME/,
  );
});

test('loadSettings: absent file yields {}', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  try {
    assert.deepEqual(loadSettings({ HOME: home }), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadSettings: present file is parsed', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  try {
    const dir = join(xdg, 'owenloop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hello: 'world' }));
    assert.deepEqual(loadSettings({ XDG_CONFIG_HOME: xdg }), { hello: 'world' } as Record<string, unknown>);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: commandRouting passes through when set', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  try {
    const dir = join(xdg, 'owenloop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ commandRouting: 'manual' }));
    assert.equal(loadSettings({ XDG_CONFIG_HOME: xdg }).commandRouting, 'manual');
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: malformed JSON throws a clear, path-named error', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  try {
    const dir = join(xdg, 'owenloop');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ not json');
    assert.throws(() => loadSettings({ XDG_CONFIG_HOME: xdg }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /malformed settings file/);
      assert.match(err.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

// ---- C6: the full knob surface + validation --------------------------------

test('loadSettings: each C6 knob loads with its value', () => {
  const xdg = withSettingsFile(
    JSON.stringify({
      hubOrigin: 'https://hub.example',
      cacheDir: '/c',
      stateDir: '/s',
      dispatchCap: 7,
      commandRouting: 'manual',
      maxConcurrentAgents: 2,
    }),
  );
  try {
    const s = loadSettings({ XDG_CONFIG_HOME: xdg });
    assert.equal(s.hubOrigin, 'https://hub.example');
    assert.equal(s.cacheDir, '/c');
    assert.equal(s.stateDir, '/s');
    assert.equal(s.dispatchCap, 7);
    assert.equal(s.commandRouting, 'manual');
    assert.equal(s.maxConcurrentAgents, 2);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: capabilityModels loads as a flat capability → { model, effort } map', () => {
  const xdg = withSettingsFile(
    JSON.stringify({
      capabilityModels: {
        'build:deep': { model: 'claude-opus-5', effort: 'xhigh' },
        build: { model: 'claude-sonnet-5', effort: 'high' },
      },
    }),
  );
  try {
    const s = loadSettings({ XDG_CONFIG_HOME: xdg });
    assert.deepEqual(s.capabilityModels, {
      'build:deep': { model: 'claude-opus-5', effort: 'xhigh' },
      build: { model: 'claude-sonnet-5', effort: 'high' },
    });
    assert.ok(KNOWN_SETTINGS_KEYS.includes('capabilityModels'));
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: capabilityModels rejects malformed rows at LOAD time, not at dispatch', () => {
  // Every one of these would otherwise surface as a vendor API error in the
  // middle of somebody's order, hours after the file was edited.
  const cases: Array<[string, unknown, RegExp]> = [
    ['not an object', 'nope', /'capabilityModels' must be an object/],
    ['an array', [], /'capabilityModels' must be an object/],
    ['an empty capability key', { '': { model: 'claude-opus-5', effort: 'high' } }, /may not be empty/u],
    ['a non-object row', { build: 'claude-opus-5' }, /build/u],
    ['an empty model', { build: { model: '', effort: 'high' } }, /model/u],
    ['an off-ladder effort', { build: { model: 'some-model', effort: 'turbo' } }, /turbo/u],
    ['a missing effort', { build: { model: 'some-model' } }, /effort/u],
  ];
  for (const [label, value, expected] of cases) {
    const xdg = withSettingsFile(JSON.stringify({ capabilityModels: value }));
    try {
      assert.throws(() => loadSettings({ XDG_CONFIG_HOME: xdg }), expected, `${label} should be rejected`);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }
});

test('loadSettings: any model id loads — owenloop never gatekeeps which models exist', () => {
  // The effort must be a real rung, but WHICH model serves a capability is the
  // operator's call and their harness's business. A model released after this
  // build shipped is the expected case, not an error, and there is no warning
  // for it either: owenloop has nothing true to say about it.
  const xdg = withSettingsFile(
    JSON.stringify({ capabilityModels: { wise: { model: 'some-brand-new-model', effort: 'max' } } }),
  );
  try {
    const i = inspectSettings({ XDG_CONFIG_HOME: xdg });
    assert.deepEqual(i.warnings, []);
    assert.deepEqual(i.settings.capabilityModels?.['wise'], { model: 'some-brand-new-model', effort: 'max' });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: the retired tier keys are a HARD ERROR, naming their replacement', () => {
  // Not merely unrecognized. Passing `tierMap` over silently would start the
  // shift with NO capability map, and every agent order would then be refused
  // at dispatch citing capabilities the operator never wrote.
  for (const retired of ['tierMap', 'tierProfiles'] as const) {
    const xdg = withSettingsFile(JSON.stringify({ [retired]: { strong: 'custom-strong' } }));
    try {
      assert.throws(
        () => loadSettings({ XDG_CONFIG_HOME: xdg }),
        new RegExp(`'${retired}' was removed .* 'capabilityModels'`, 'su'),
        `${retired} should be a hard error`,
      );
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }
});

test('loadSettings: the retired escalation keys only WARN — ignoring them changes no behavior', () => {
  // The opposite case from `tierMap`. Retry escalation moved INTO the engine,
  // which re-offers a rejected step at the def's `escalation.modifier`. So a
  // file still carrying these describes a mechanism that no longer runs, but
  // escalation itself still happens correctly without them.
  const xdg = withSettingsFile(JSON.stringify({ escalateAt: 5, escalationExtensionKey: 'delivery-extra' }));
  try {
    const i = inspectSettings({ XDG_CONFIG_HOME: xdg });
    assert.equal(i.warnings.length, 2);
    assert.ok(i.warnings.every((w) => w.includes('no longer does anything')));
    assert.ok(i.warnings.some((w) => w.includes('escalateAt')));
    assert.ok(i.warnings.some((w) => w.includes('escalationExtensionKey')));
    // Warnings are NOT unrecognized keys: the file means something real, it
    // just no longer takes effect.
    assert.deepEqual(i.unrecognized, []);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: absent knobs default to undefined (empty file)', () => {
  const xdg = withSettingsFile('{}');
  try {
    const s = loadSettings({ XDG_CONFIG_HOME: xdg });
    assert.equal(s.hubOrigin, undefined);
    assert.equal(s.stateDir, undefined);
    assert.equal(s.dispatchCap, undefined);
    assert.equal(s.maxConcurrentAgents, undefined);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: a wrong-typed known key errors, naming key + path', () => {
  const xdg = withSettingsFile(JSON.stringify({ hubOrigin: 42 }));
  const file = join(xdg, 'owenloop', 'settings.json');
  try {
    assert.throws(() => loadSettings({ XDG_CONFIG_HOME: xdg }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /'hubOrigin' must be a string/);
      assert.match(err.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: dispatchCap rejects 0, negative, and non-integer', () => {
  for (const bad of [0, -1, 2.5]) {
    const xdg = withSettingsFile(JSON.stringify({ dispatchCap: bad }));
    try {
      assert.throws(
        () => loadSettings({ XDG_CONFIG_HOME: xdg }),
        /'dispatchCap' must be a positive integer/,
        `dispatchCap ${bad} should be rejected`,
      );
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }
});

test('loadSettings: commandRouting rejects an unknown literal', () => {
  const xdg = withSettingsFile(JSON.stringify({ commandRouting: 'nope' }));
  try {
    assert.throws(() => loadSettings({ XDG_CONFIG_HOME: xdg }), /'commandRouting' must be 'shift' or 'manual'/);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('validateSettings: unrecognized keys are surfaced, not fatal, and retained', () => {
  const { settings, unrecognized } = validateSettings(
    { hubOrigin: 'https://h', typo: 1, another: 'x' },
    '/some/path',
  );
  assert.equal(settings.hubOrigin, 'https://h');
  // Unknown keys pass through untouched (forward compatible).
  assert.equal((settings as Record<string, unknown>)['typo'], 1);
  assert.deepEqual(unrecognized.sort(), ['another', 'typo']);
});

test('validateSettings: a non-object top level is an error', () => {
  assert.throws(() => validateSettings([1, 2], '/p'), /expected a JSON object, got array/);
  assert.throws(() => validateSettings('str', '/p'), /expected a JSON object, got string/);
  assert.throws(() => validateSettings(null, '/p'), /expected a JSON object, got null/);
});

test('inspectSettings: reports path + exists:false for a missing file', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  try {
    const i = inspectSettings({ HOME: home });
    assert.equal(i.exists, false);
    assert.deepEqual(i.settings, {});
    assert.deepEqual(i.unrecognized, []);
    assert.match(i.path, /owenloop[/\\]settings\.json$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('inspectSettings: reports exists:true + validated contents + unrecognized', () => {
  const xdg = withSettingsFile(JSON.stringify({ dispatchCap: 9, mystery: true }));
  try {
    const i = inspectSettings({ XDG_CONFIG_HOME: xdg });
    assert.equal(i.exists, true);
    assert.equal(i.settings.dispatchCap, 9);
    assert.deepEqual(i.unrecognized, ['mystery']);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

// ---- maxConcurrentAgents ----------------------------------------------------

test('loadSettings: maxConcurrentAgents rejects 0, negative, and non-integer', () => {
  for (const bad of [0, -1, 1.5, '3']) {
    const xdg = withSettingsFile(JSON.stringify({ maxConcurrentAgents: bad }));
    try {
      assert.throws(
        () => loadSettings({ XDG_CONFIG_HOME: xdg }),
        /'maxConcurrentAgents' must be a positive integer/,
        `maxConcurrentAgents ${JSON.stringify(bad)} should be rejected`,
      );
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }
});

/** The deleted stamp-path keys must now read as UNRECOGNIZED, not be silently
 *  accepted — an operator with a stale settings file gets told. */
test('the deleted stamp-path settings keys are reported as unrecognized', () => {
  const xdg = withSettingsFile(JSON.stringify({ agentsDir: '/a', runnerDispatch: true }));
  try {
    assert.deepEqual(inspectSettings({ XDG_CONFIG_HOME: xdg }).unrecognized.sort(), ['agentsDir', 'runnerDispatch']);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('KNOWN_SETTINGS_KEYS carries maxConcurrentAgents, so it is not "unrecognized"', () => {
  const xdg = withSettingsFile(JSON.stringify({ maxConcurrentAgents: 4 }));
  try {
    assert.deepEqual(inspectSettings({ XDG_CONFIG_HOME: xdg }).unrecognized, []);
    assert.ok(KNOWN_SETTINGS_KEYS.includes('maxConcurrentAgents'));
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: defPolicy accepts enforce, warn, and off', () => {
  for (const defPolicy of ['enforce', 'warn', 'off'] as const) {
    const xdg = withSettingsFile(JSON.stringify({ defPolicy }));
    try {
      assert.equal(loadSettings({ XDG_CONFIG_HOME: xdg }).defPolicy, defPolicy);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }
});

test('loadSettings: defPolicy rejects an unknown value and wrong types', () => {
  for (const defPolicy of ['strict', 1, null]) {
    const xdg = withSettingsFile(JSON.stringify({ defPolicy }));
    try {
      assert.throws(
		() => loadSettings({ XDG_CONFIG_HOME: xdg }),
		/'defPolicy' must be 'enforce', 'warn', or 'off'/,
      );
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }
});

test('KNOWN_SETTINGS_KEYS carries defPolicy and absent defPolicy remains undefined for the loader', () => {
  const xdg = withSettingsFile('{}');
  try {
    assert.ok(KNOWN_SETTINGS_KEYS.includes('defPolicy'));
    assert.equal(loadSettings({ XDG_CONFIG_HOME: xdg }).defPolicy, undefined);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});
