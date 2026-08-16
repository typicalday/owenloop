import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  allowedSignersPath,
  resolveAllowedSigners,
} from '../src/crypto/trust-roots.ts';

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('allowed_signers path uses HOME/.owenloop and ignores XDG_CONFIG_HOME', () => {
  const xdg = temp('owenloop-xdg-');
  const home = temp('owenloop-home-');
  assert.equal(
    allowedSignersPath({ XDG_CONFIG_HOME: xdg, HOME: home }),
    join(home, '.owenloop', 'allowed_signers'),
  );
});

test('allowed_signers path uses HOME when XDG_CONFIG_HOME is blank', () => {
  const home = temp('owenloop-home-');
  assert.equal(
    allowedSignersPath({ XDG_CONFIG_HOME: '  ', HOME: home }),
    join(home, '.owenloop', 'allowed_signers'),
  );
});

test('allowed_signers path refuses when neither environment root is present', () => {
  assert.throws(
    () => allowedSignersPath({}),
    /cannot locate an allowed_signers path: .*set OWENLOOP_CONFIG_DIR or HOME/,
  );
});

test('resolveAllowedSigners distinguishes an absent file from a present file', () => {
  const xdg = temp('owenloop-xdg-');
  const env = { HOME: xdg };
  assert.deepEqual(resolveAllowedSigners(env), {
    kind: 'absent',
    path: join(xdg, '.owenloop', 'allowed_signers'),
  });

  const path = join(xdg, '.owenloop', 'allowed_signers');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'publisher ssh-ed25519 AAAA fixture\n');
  assert.deepEqual(resolveAllowedSigners(env), {
    kind: 'present',
    path,
    text: 'publisher ssh-ed25519 AAAA fixture\n',
  });
});

test('resolveAllowedSigners refuses symlinks and non-regular files', () => {
  const xdg = temp('owenloop-xdg-');
  const env = { HOME: xdg };
  const path = join(xdg, '.owenloop', 'allowed_signers');
  mkdirSync(join(path, '..'), { recursive: true });
  const target = join(xdg, 'target');
  writeFileSync(target, 'publisher ssh-ed25519 AAAA fixture\n');
  symlinkSync(target, path);
  assert.throws(() => resolveAllowedSigners(env), /allowed_signers path is a symlink/);

  const xdgDir = temp('owenloop-xdg-dir-');
  const dirPath = join(xdgDir, '.owenloop', 'allowed_signers');
  mkdirSync(dirPath, { recursive: true });
  assert.throws(
    () => resolveAllowedSigners({ HOME: xdgDir }),
    /allowed_signers path is not a regular file/,
  );
});
