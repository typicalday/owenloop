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

test('settingsPath: throws when neither HOME nor XDG_CONFIG_HOME is usable', () => {
  assert.throws(() => settingsPath({}), /set HOME or XDG_CONFIG_HOME/);
  assert.throws(() => settingsPath({ HOME: '', XDG_CONFIG_HOME: '' }), /set HOME or XDG_CONFIG_HOME/);
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
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ commandRouting: 'conductor' }));
    assert.equal(loadSettings({ XDG_CONFIG_HOME: xdg }).commandRouting, 'conductor');
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
      commandRouting: 'conductor',
      maxConcurrentAgents: 2,
    }),
  );
  try {
    const s = loadSettings({ XDG_CONFIG_HOME: xdg });
    assert.equal(s.hubOrigin, 'https://hub.example');
    assert.equal(s.cacheDir, '/c');
    assert.equal(s.stateDir, '/s');
    assert.equal(s.dispatchCap, 7);
    assert.equal(s.commandRouting, 'conductor');
    assert.equal(s.maxConcurrentAgents, 2);
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
    assert.throws(() => loadSettings({ XDG_CONFIG_HOME: xdg }), /'commandRouting' must be 'proxy' or 'conductor'/);
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
