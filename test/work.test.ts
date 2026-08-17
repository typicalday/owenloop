/**
 * `src/work-settings.ts` — the owenloop CLI's key-preserving writer for the EXECUTION
 * `owenloop` tool's `settings.json`. Proves: only `hubOrigin` changes (every
 * other key byte-identical), a corrupt file is a hard error that never clobbers,
 * a missing directory is created, HOME supplies the default, and the
 * written file never contains an `olp_` token (nothing secret is ever in scope).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { configDir, credentialFilePath } from '../src/hub.ts';
import { owenloopSettingsPath, readOwenloopSettingsRaw, writeOwenloopHubOrigin } from '../src/work-settings.ts';
import { recordHubOrigin } from '../packages/work/src/settings/provision.ts';
import { settingsPath as workSettingsPath } from '../packages/work/src/settings/settings.ts';

/** A throwaway HOME dir for one test. */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-owenloop-home-'));
}

test('owenloopSettingsPath: HOME supplies the default and ignores XDG_CONFIG_HOME', () => {
  const home = freshHome();
  const xdg = freshHome();
  assert.equal(owenloopSettingsPath({ HOME: home, XDG_CONFIG_HOME: xdg }), join(home, '.owenloop', 'settings.json'));
  assert.equal(owenloopSettingsPath({ HOME: home, XDG_CONFIG_HOME: '   ' }), join(home, '.owenloop', 'settings.json'));
  assert.equal(owenloopSettingsPath({ HOME: home }), join(home, '.owenloop', 'settings.json'));
});

test('owenloopSettingsPath: throws when no rung of the config ladder is usable', () => {
  assert.throws(() => owenloopSettingsPath({}), /set OWENLOOP_CONFIG_DIR or HOME/);
});

test('owenloopSettingsPath: OWENLOOP_CONFIG_DIR wins over XDG_CONFIG_HOME and HOME', () => {
  assert.equal(
    owenloopSettingsPath({ OWENLOOP_CONFIG_DIR: '/cfg', XDG_CONFIG_HOME: '/x', HOME: '/home/me' }),
    join('/cfg', 'settings.json'),
  );
});

test('writeOwenloopHubOrigin: merge-write preserves every unknown key byte-for-byte', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenloopSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ hubOrigin: 'http://other', dispatchCap: 5, customKey: 'x', nested: { a: 1 } }));

  const result = writeOwenloopHubOrigin(env, 'https://api.owenloop.com');
  assert.equal(result.path, path);
  assert.equal(result.previous, 'http://other');

  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.hubOrigin, 'https://api.owenloop.com', 'hubOrigin updated');
  assert.equal(parsed.dispatchCap, 5, 'unknown key preserved');
  assert.equal(parsed.customKey, 'x', 'unknown key preserved');
  assert.deepEqual(parsed.nested, { a: 1 }, 'nested key preserved');
});

test('writeOwenloopHubOrigin: a corrupt (non-object) settings file is a hard error naming the path, file untouched', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenloopSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true });

  // Invalid JSON.
  writeFileSync(path, '{ not valid json');
  assert.throws(() => writeOwenloopHubOrigin(env, 'https://api.owenloop.com'), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(readFileSync(path, 'utf8'), '{ not valid json', 'corrupt file never clobbered');

  // Valid JSON but an array (not an object).
  writeFileSync(path, '[1,2,3]');
  assert.throws(() => writeOwenloopHubOrigin(env, 'https://api.owenloop.com'), /not a JSON object/);
  assert.equal(readFileSync(path, 'utf8'), '[1,2,3]', 'array file never clobbered');
});

test('writeOwenloopHubOrigin: creates the settings directory when missing, previous is undefined', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenloopSettingsPath(env);
  assert.equal(existsSync(dirname(path)), false, 'dir absent before write');

  const result = writeOwenloopHubOrigin(env, 'https://api.owenloop.com');
  assert.equal(result.previous, undefined, 'no previous hubOrigin on a fresh install');
  assert.equal(existsSync(path), true, 'settings file written');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hubOrigin, 'https://api.owenloop.com');
});

test('readOwenloopSettingsRaw: a missing file is null (not an error)', () => {
  const home = freshHome();
  assert.equal(readOwenloopSettingsRaw(owenloopSettingsPath({ HOME: home })), null);
});

test('writeOwenloopHubOrigin: the written settings file never contains an olp_ token', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenloopSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ hubOrigin: 'http://old' }));

  writeOwenloopHubOrigin(env, 'https://api.owenloop.com');
  assert.doesNotMatch(readFileSync(path, 'utf8'), /olp_/, 'no secret ever reaches the settings file');
});

test('shared owenloop config keeps credentials and lock siblings byte-identical through both settings writers', () => {
  for (const writeSettings of [
    (env: Record<string, string | undefined>) => writeOwenloopHubOrigin(env, 'https://api.owenloop.com'),
    (env: Record<string, string | undefined>) => recordHubOrigin(env, 'https://api.owenloop.com'),
  ]) {
    const xdg = mkdtempSync(join(tmpdir(), 'owenloop-shared-config-'));
    const home = mkdtempSync(join(tmpdir(), 'owenloop-shared-home-'));
    try {
      const env = { XDG_CONFIG_HOME: xdg, HOME: home };
      const config = configDir(env);
      const settings = owenloopSettingsPath(env);
      const credentials = credentialFilePath(env);
      const lock = join(config, 'credentials.lock');
      mkdirSync(config, { recursive: true });
      const credentialBytes = '{"version":2,"hubs":{"https://hub.example":{"kind":"oauth"}}}\\n';
      const lockBytes = 'lock-owner\\n';
      writeFileSync(credentials, credentialBytes);
      writeFileSync(lock, lockBytes);

      assert.equal(settings, workSettingsPath(env));
      assert.equal(dirname(settings), config);
      assert.equal(dirname(credentials), config);
      assert.equal(dirname(lock), config);
      assert.deepEqual(
        new Set([settings, credentials, lock].map((path) => basename(path))),
        new Set(['settings.json', 'credentials.json', 'credentials.lock']),
      );

      writeSettings(env);

      assert.equal(readFileSync(credentials, 'utf8'), credentialBytes);
      assert.equal(readFileSync(lock, 'utf8'), lockBytes);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});
