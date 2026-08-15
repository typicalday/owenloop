/**
 * The shared owenloop config-directory ladder.
 *
 * These assertions pin the PRECEDENCE, not merely the happy path. The whole
 * point of `OWENLOOP_CONFIG_DIR` is that an operator can scope owenloop's own
 * config without disturbing `XDG_CONFIG_HOME`, so a regression that let
 * `XDG_CONFIG_HOME` win again would silently reintroduce the failure this
 * variable exists to remove — a shift whose workers relocate `gh`'s, `git`'s,
 * and `gcloud`'s config along with owenloop's.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { owenloopConfigDir, owenloopConfigFile } from '../src/config-dir.ts';
import { configDir } from '../src/hub.ts';
import { allowedSignersPath } from '../src/crypto/trust-roots.ts';
import { owenloopSettingsPath } from '../src/work-settings.ts';

test('OWENLOOP_CONFIG_DIR wins over both XDG_CONFIG_HOME and HOME, and is used verbatim', () => {
  assert.equal(
    owenloopConfigDir({
      OWENLOOP_CONFIG_DIR: '/srv/shifts/utility/owenloop',
      XDG_CONFIG_HOME: '/xdg',
      HOME: '/home/u',
    }),
    '/srv/shifts/utility/owenloop',
  );
});

test('OWENLOOP_CONFIG_DIR has NO "owenloop" segment appended', () => {
  // The XDG rung appends one; this rung must not, or an operator pointing at an
  // existing config dir would silently read `<dir>/owenloop/settings.json`.
  assert.equal(owenloopConfigDir({ OWENLOOP_CONFIG_DIR: '/cfg' }), '/cfg');
});

test('XDG_CONFIG_HOME wins over HOME and appends the owenloop segment', () => {
  assert.equal(owenloopConfigDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }), '/xdg/owenloop');
});

test('HOME is the last rung', () => {
  assert.equal(owenloopConfigDir({ HOME: '/home/u' }), '/home/u/.config/owenloop');
});

test('blank and whitespace-only values are treated as unset at every rung', () => {
  assert.equal(
    owenloopConfigDir({ OWENLOOP_CONFIG_DIR: '  ', XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }),
    '/xdg/owenloop',
  );
  assert.equal(owenloopConfigDir({ OWENLOOP_CONFIG_DIR: '', XDG_CONFIG_HOME: '  ', HOME: '/home/u' }), '/home/u/.config/owenloop');
});

test('a relative OWENLOOP_CONFIG_DIR is a hard error naming the variable', () => {
  // A relative path would resolve against each step's own working directory,
  // and `workdirFrom` gives every step a different one.
  assert.throws(
    () => owenloopConfigDir({ OWENLOOP_CONFIG_DIR: 'cfg/owenloop', HOME: '/home/u' }),
    /OWENLOOP_CONFIG_DIR must be an absolute path/,
  );
});

test('an empty environment throws and names all three variables', () => {
  assert.throws(() => owenloopConfigDir({}), /set OWENLOOP_CONFIG_DIR, XDG_CONFIG_HOME, or HOME/);
});

test('owenloopConfigFile joins segments under the resolved directory', () => {
  assert.equal(
    owenloopConfigFile({ OWENLOOP_CONFIG_DIR: '/cfg' }, 'keys', 'stg.backend'),
    '/cfg/keys/stg.backend',
  );
});

test('every call site honours OWENLOOP_CONFIG_DIR, not just the resolver', () => {
  // Four functions used to carry four private copies of this ladder. If any one
  // of them drifts back to reading XDG_CONFIG_HOME directly, a shift reads its
  // settings from one directory and its credentials from another.
  const env = { OWENLOOP_CONFIG_DIR: '/cfg', XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' };
  assert.equal(configDir(env), '/cfg');
  assert.equal(owenloopSettingsPath(env), '/cfg/settings.json');
  assert.equal(allowedSignersPath(env), '/cfg/allowed_signers');
});

test('owenloopSettingsPath reports an unusable environment as a CliError', () => {
  // The CLI prints a CliError as an operator-facing message rather than a stack.
  assert.throws(() => owenloopSettingsPath({}), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /cannot locate a config directory for execution settings/);
    assert.match(err.message, /set OWENLOOP_CONFIG_DIR, XDG_CONFIG_HOME, or HOME/);
    return true;
  });
});
