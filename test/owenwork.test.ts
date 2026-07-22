/**
 * `src/owenwork.ts` — the owenloop CLI's key-preserving writer for the SIBLING
 * `owenwork` tool's `settings.json`. Proves: only `hubOrigin` changes (every
 * other key byte-identical), a corrupt file is a hard error that never clobbers,
 * a missing directory is created, `XDG_CONFIG_HOME` wins over `HOME`, and the
 * written file never contains an `olp_` token (nothing secret is ever in scope).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { owenworkSettingsPath, readOwenworkSettingsRaw, writeOwenworkHubOrigin } from '../src/owenwork.ts';

/** A throwaway HOME dir for one test. */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-owenwork-home-'));
}

test('owenworkSettingsPath: XDG_CONFIG_HOME wins over HOME', () => {
  const home = freshHome();
  const xdg = freshHome();
  assert.equal(owenworkSettingsPath({ HOME: home, XDG_CONFIG_HOME: xdg }), join(xdg, 'owenwork', 'settings.json'));
  // Blank XDG falls back to HOME.
  assert.equal(owenworkSettingsPath({ HOME: home, XDG_CONFIG_HOME: '   ' }), join(home, '.config', 'owenwork', 'settings.json'));
  assert.equal(owenworkSettingsPath({ HOME: home }), join(home, '.config', 'owenwork', 'settings.json'));
});

test('owenworkSettingsPath: throws when neither HOME nor XDG_CONFIG_HOME is set', () => {
  assert.throws(() => owenworkSettingsPath({}), /HOME or XDG_CONFIG_HOME/);
});

test('writeOwenworkHubOrigin: merge-write preserves every unknown key byte-for-byte', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenworkSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ hubOrigin: 'http://other', dispatchCap: 5, customKey: 'x', nested: { a: 1 } }));

  const result = writeOwenworkHubOrigin(env, 'https://api.owenloop.com');
  assert.equal(result.path, path);
  assert.equal(result.previous, 'http://other');

  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(parsed.hubOrigin, 'https://api.owenloop.com', 'hubOrigin updated');
  assert.equal(parsed.dispatchCap, 5, 'unknown key preserved');
  assert.equal(parsed.customKey, 'x', 'unknown key preserved');
  assert.deepEqual(parsed.nested, { a: 1 }, 'nested key preserved');
});

test('writeOwenworkHubOrigin: a corrupt (non-object) settings file is a hard error naming the path, file untouched', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenworkSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true });

  // Invalid JSON.
  writeFileSync(path, '{ not valid json');
  assert.throws(() => writeOwenworkHubOrigin(env, 'https://api.owenloop.com'), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(readFileSync(path, 'utf8'), '{ not valid json', 'corrupt file never clobbered');

  // Valid JSON but an array (not an object).
  writeFileSync(path, '[1,2,3]');
  assert.throws(() => writeOwenworkHubOrigin(env, 'https://api.owenloop.com'), /not a JSON object/);
  assert.equal(readFileSync(path, 'utf8'), '[1,2,3]', 'array file never clobbered');
});

test('writeOwenworkHubOrigin: creates the settings directory when missing, previous is undefined', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenworkSettingsPath(env);
  assert.equal(existsSync(dirname(path)), false, 'dir absent before write');

  const result = writeOwenworkHubOrigin(env, 'https://api.owenloop.com');
  assert.equal(result.previous, undefined, 'no previous hubOrigin on a fresh install');
  assert.equal(existsSync(path), true, 'settings file written');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hubOrigin, 'https://api.owenloop.com');
});

test('readOwenworkSettingsRaw: a missing file is null (not an error)', () => {
  const home = freshHome();
  assert.equal(readOwenworkSettingsRaw(owenworkSettingsPath({ HOME: home })), null);
});

test('writeOwenworkHubOrigin: the written settings file never contains an olp_ token', () => {
  const home = freshHome();
  const env = { HOME: home };
  const path = owenworkSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ hubOrigin: 'http://old' }));

  writeOwenworkHubOrigin(env, 'https://api.owenloop.com');
  assert.doesNotMatch(readFileSync(path, 'utf8'), /olp_/, 'no secret ever reaches the settings file');
});
