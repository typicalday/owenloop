/**
 * Coverage for the fixture-hermeticity helpers (`test/helpers/ambient-env.ts`).
 *
 * These helpers are test infrastructure, but they carry a contract the rest of
 * the suite now leans on, and getting that contract wrong FAILS OPEN — a strip
 * that quietly misses a key leaves the suite reading the operator's real
 * environment, which is the exact bug the helpers exist to kill. So the contract
 * is pinned here rather than assumed.
 *
 * Three claims, one test each:
 *   1. the strip covers the whole `OWENLOOP_*` namespace, not a named subset;
 *   2. it touches nothing outside that namespace;
 *   3. the restore is exact — absent keys stay absent, present keys come back
 *      with their original values.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { stripAmbientOwenloopEnv, strippedOwenloopEnv } from './helpers/ambient-env.ts';

/**
 * Keys this file writes into the REAL `process.env`. Cleared after every test so
 * a failure part-way through cannot leak into the next one.
 */
const SCRATCH = ['OWENLOOP_SCRATCH_ONE', 'OWENLOOP_SCRATCH_TWO', 'OWENLOOPISH_SCRATCH', 'SCRATCH_OWENLOOP_TAIL'];
afterEach(() => {
  for (const key of SCRATCH) delete process.env[key];
});

test('strippedOwenloopEnv maps every OWENLOOP_ key to undefined and leaves the rest alone', () => {
  const source = {
    OWENLOOP_TOKEN: 'tok',
    OWENLOOP_CONFIG_DIR: '/real/config',
    OWENLOOP_ALLOWED_WORKDIR_ROOTS: '/Users/me/code',
    // A variable no fixture has heard of. The whole point: it is denied because
    // of its PREFIX, not because someone remembered to name it.
    OWENLOOP_SOME_FUTURE_KNOB: 'on',
    HOME: '/home/me',
    XDG_CONFIG_HOME: '/home/me/.config',
    PATH: '/usr/bin',
  };

  const stripped = strippedOwenloopEnv(source);

  assert.deepEqual(stripped, {
    OWENLOOP_TOKEN: undefined,
    OWENLOOP_CONFIG_DIR: undefined,
    OWENLOOP_ALLOWED_WORKDIR_ROOTS: undefined,
    OWENLOOP_SOME_FUTURE_KNOB: undefined,
  });
  // Nothing outside the namespace appears at all — not as a key, not as
  // `undefined`. Spreading this object must not disturb HOME/XDG/PATH.
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'PATH']) {
    assert.equal(key in stripped, false, `${key} must not be in the strip`);
  }

  // The prefix is a PREFIX, not a substring: `OWENLOOPISH_` starts with neither
  // `OWENLOOP_` nor anything this should match, and a trailing occurrence is not
  // a match either.
  assert.deepEqual(strippedOwenloopEnv({ OWENLOOPISH_SCRATCH: 'x', SCRATCH_OWENLOOP_TAIL: 'y' }), {});
});

test('a fixture value spread AFTER the strip survives it', () => {
  // The documented calling order. If a fixture spreads the strip first and then
  // sets OWENLOOP_NO_KEYCHAIN, the explicit value must be what the child sees.
  const childEnv: Record<string, string | undefined> = {
    ...strippedOwenloopEnv({ OWENLOOP_NO_KEYCHAIN: '0', OWENLOOP_TOKEN: 'ambient' }),
    OWENLOOP_NO_KEYCHAIN: '1',
  };

  assert.equal(childEnv['OWENLOOP_NO_KEYCHAIN'], '1');
  assert.equal(childEnv['OWENLOOP_TOKEN'], undefined);
});

test('stripAmbientOwenloopEnv removes the namespace from process.env and restores it exactly', () => {
  process.env['OWENLOOP_SCRATCH_ONE'] = 'value-one';
  process.env['OWENLOOP_SCRATCH_TWO'] = '';
  process.env['OWENLOOPISH_SCRATCH'] = 'outside-the-namespace';
  delete process.env['OWENLOOP_SCRATCH_ABSENT'];

  const restore = stripAmbientOwenloopEnv();

  // Removed, not blanked: `'OWENLOOP_SCRATCH_ONE' in process.env` must be false,
  // because a key present with an empty string is a DIFFERENT input to owenloop's
  // env readers than a key that is absent.
  assert.equal('OWENLOOP_SCRATCH_ONE' in process.env, false);
  assert.equal('OWENLOOP_SCRATCH_TWO' in process.env, false);
  // Outside the namespace, untouched.
  assert.equal(process.env['OWENLOOPISH_SCRATCH'], 'outside-the-namespace');

  // A fixture sets its own value on top of the cleared namespace...
  process.env['OWENLOOP_SCRATCH_ABSENT'] = 'set-by-the-fixture';

  restore();

  // ...and the restore puts back exactly the pre-strip state: the two keys that
  // held values (including the empty string) return, and the key that was ABSENT
  // before the strip is absent again rather than keeping the fixture's value.
  assert.equal(process.env['OWENLOOP_SCRATCH_ONE'], 'value-one');
  assert.equal(process.env['OWENLOOP_SCRATCH_TWO'], '');
  assert.equal('OWENLOOP_SCRATCH_ABSENT' in process.env, false);
  assert.equal(process.env['OWENLOOPISH_SCRATCH'], 'outside-the-namespace');
});
