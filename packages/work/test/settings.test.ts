import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { settingsPath, loadSettings, validateSettings, inspectSettings, KNOWN_SETTINGS_KEYS } from '../src/settings/settings.ts';

/** Write a settings.json under a fresh temporary HOME; returns that HOME. */
function withSettingsFile(contents: string): string {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  const dir = join(xdg, '.owenloop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), contents);
  return xdg;
}

// Every fixture materializes its OWN ambient state (temp HOME / XDG dir it
// creates) — never the developer's or CI runner's real home.

test('settingsPath: XDG_CONFIG_HOME is ignored and HOME supplies the default', () => {
  assert.equal(
    settingsPath({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }),
    join('/home/u', '.owenloop', 'settings.json'),
  );
  assert.equal(
    settingsPath({ XDG_CONFIG_HOME: '  ', HOME: '/home/u' }),
    join('/home/u', '.owenloop', 'settings.json'),
  );
  assert.equal(settingsPath({ HOME: '/home/u' }), join('/home/u', '.owenloop', 'settings.json'));
});

test('settingsPath: OWENLOOP_CONFIG_DIR wins over HOME', () => {
  assert.equal(
    settingsPath({ OWENLOOP_CONFIG_DIR: '/srv/utility/owenloop', XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }),
    join('/srv/utility/owenloop', 'settings.json'),
  );
  assert.equal(settingsPath({ OWENLOOP_CONFIG_DIR: '/cfg' }), join('/cfg', 'settings.json'));
  assert.equal(
    settingsPath({ OWENLOOP_CONFIG_DIR: '  ', XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }),
    join('/home/u', '.owenloop', 'settings.json'),
  );
});

test('settingsPath: throws when no rung of the ladder is usable', () => {
  assert.throws(() => settingsPath({}), /set OWENLOOP_CONFIG_DIR or HOME/);
  assert.throws(() => settingsPath({ HOME: '', XDG_CONFIG_HOME: '' }), /set OWENLOOP_CONFIG_DIR or HOME/);
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
    const dir = join(xdg, '.owenloop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hello: 'world' }));
    assert.deepEqual(loadSettings({ HOME: xdg }), { hello: 'world' } as Record<string, unknown>);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: commandRouting passes through when set', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  try {
    const dir = join(xdg, '.owenloop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ commandRouting: 'manual' }));
    assert.equal(loadSettings({ HOME: xdg }).commandRouting, 'manual');
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: malformed JSON throws a clear, path-named error', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-'));
  try {
    const dir = join(xdg, '.owenloop');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ not json');
    assert.throws(() => loadSettings({ HOME: xdg }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /malformed settings file/);
      assert.match(err.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

// ---- allowedWorkdirRoots ----------------------------------------------------

test('loadSettings: allowedWorkdirRoots loads as an array of absolute paths', () => {
  const xdg = withSettingsFile(JSON.stringify({ allowedWorkdirRoots: ['/Users/me/code', '/srv/work'] }));
  try {
    assert.deepEqual(loadSettings({ HOME: xdg }).allowedWorkdirRoots, ['/Users/me/code', '/srv/work']);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: allowedWorkdirRoots rejects non-arrays, non-strings, blanks, and relative paths', () => {
  // A RELATIVE root is rejected rather than resolved, because the directory it
  // would resolve against is whichever one the shift happened to be launched
  // in — so the same settings file would grant different permissions depending
  // on where the operator was standing.
  const cases: Array<[string, unknown, RegExp]> = [
    ['a bare string', '/code', /'allowedWorkdirRoots' must be an array/],
    ['an object', { a: 1 }, /'allowedWorkdirRoots' must be an array/],
    ['a non-string entry', ['/code', 7], /'allowedWorkdirRoots' must be an array/],
    ['a blank entry', ['/code', '  '], /NON-EMPTY/],
    ['a relative entry', ['code'], /must be an absolute path/],
  ];
  for (const [label, value, expected] of cases) {
    const xdg = withSettingsFile(JSON.stringify({ allowedWorkdirRoots: value }));
    try {
      assert.throws(() => loadSettings({ HOME: xdg }), expected, `${label} should be rejected`);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
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
    const s = loadSettings({ HOME: xdg });
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

test('loadSettings: roster loads as capability → ordered candidates', () => {
  const xdg = withSettingsFile(
    JSON.stringify({
      roster: {
        'build:deep': [{ harness: 'first', model: 'large', effort: 'xhigh' }],
        build: [{ harness: 'second', model: 'small', effort: 'high' }],
      },
    }),
  );
  try {
    const s = loadSettings({ HOME: xdg });
    assert.deepEqual(s.roster, {
      'build:deep': [{ harness: 'first', model: 'large', effort: 'xhigh' }],
      build: [{ harness: 'second', model: 'small', effort: 'high' }],
    });
    assert.ok(KNOWN_SETTINGS_KEYS.includes('roster'));
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: roster rejects malformed candidates at load time', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['not an object', 'nope', /'roster' must be a JSON object/],
    ['old object row', { build: { model: 'm', effort: 'high' } }, /array/u],
    ['empty candidate array', { build: [] }, /non-empty array/u],
    ['missing harness', { build: [{ model: 'm', effort: 'high' }] }, /harness/u],
    ['off-ladder effort', { build: [{ harness: 'h', model: 'm', effort: 'turbo' }] }, /turbo/u],
  ];
  for (const [label, value, expected] of cases) {
    const xdg = withSettingsFile(JSON.stringify({ roster: value }));
    try {
      assert.throws(() => loadSettings({ HOME: xdg }), expected, label);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  }
});

test('loadSettings: legacy capabilityModels is a hard error showing roster candidates', () => {
  const xdg = withSettingsFile(JSON.stringify({ capabilityModels: { build: { model: 'm', effort: 'high' } } }));
  try {
    assert.throws(() => loadSettings({ HOME: xdg }), /capabilityModels.*replaced by 'roster'.*harness/su);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: the retired escalation keys only WARN — ignoring them changes no behavior', () => {
  // The opposite case from `tierMap`. Retry escalation moved INTO the engine,
  // which re-offers a rejected step at the def's `escalation.modifier`. So a
  // file still carrying these describes a mechanism that no longer runs, but
  // escalation itself still happens correctly without them.
  const xdg = withSettingsFile(JSON.stringify({ escalateAt: 5, escalationExtensionKey: 'delivery-extra' }));
  try {
    const i = inspectSettings({ HOME: xdg });
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
    const s = loadSettings({ HOME: xdg });
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
  const file = join(xdg, '.owenloop', 'settings.json');
  try {
    assert.throws(() => loadSettings({ HOME: xdg }), (err: unknown) => {
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
        () => loadSettings({ HOME: xdg }),
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
    assert.throws(() => loadSettings({ HOME: xdg }), /'commandRouting' must be 'shift' or 'manual'/);
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
    const i = inspectSettings({ HOME: xdg });
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
        () => loadSettings({ HOME: xdg }),
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
    assert.deepEqual(inspectSettings({ HOME: xdg }).unrecognized.sort(), ['agentsDir', 'runnerDispatch']);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('KNOWN_SETTINGS_KEYS carries maxConcurrentAgents, so it is not "unrecognized"', () => {
  const xdg = withSettingsFile(JSON.stringify({ maxConcurrentAgents: 4 }));
  try {
    assert.deepEqual(inspectSettings({ HOME: xdg }).unrecognized, []);
    assert.ok(KNOWN_SETTINGS_KEYS.includes('maxConcurrentAgents'));
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('loadSettings: defPolicy accepts enforce, warn, and off', () => {
  for (const defPolicy of ['enforce', 'warn', 'off'] as const) {
    const xdg = withSettingsFile(JSON.stringify({ defPolicy }));
    try {
      assert.equal(loadSettings({ HOME: xdg }).defPolicy, defPolicy);
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
		() => loadSettings({ HOME: xdg }),
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
    assert.equal(loadSettings({ HOME: xdg }).defPolicy, undefined);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});
