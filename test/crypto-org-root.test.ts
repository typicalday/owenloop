import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  loadRevocations,
  loadRoster,
  orgRootPrivateKeyPath,
  orgRootPublicKeyPath,
  resolveOrgRoot,
  revocationsDir,
  rosterDir,
} from '../src/crypto/org-root.ts';

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('org-root paths prefer XDG_CONFIG_HOME and fall back to HOME/.config', () => {
  const xdg = temp('owenloop-org-xdg-');
  const home = temp('owenloop-org-home-');
  assert.equal(orgRootPublicKeyPath({ XDG_CONFIG_HOME: xdg, HOME: home }), join(xdg, 'owenloop', 'org-root.pub'));
  assert.equal(orgRootPrivateKeyPath({ XDG_CONFIG_HOME: xdg, HOME: home }), join(xdg, 'owenloop', 'org-root'));
  assert.equal(rosterDir({ XDG_CONFIG_HOME: xdg, HOME: home }), join(xdg, 'owenloop', 'roster'));
  assert.equal(revocationsDir({ XDG_CONFIG_HOME: xdg, HOME: home }), join(xdg, 'owenloop', 'revocations'));
  assert.equal(orgRootPublicKeyPath({ XDG_CONFIG_HOME: '  ', HOME: home }), join(home, '.config', 'owenloop', 'org-root.pub'));
  assert.throws(() => orgRootPublicKeyPath({}), /cannot locate an allowed_signers path/);
});

test('resolveOrgRoot distinguishes absence from a present regular public file', () => {
  const xdg = temp('owenloop-org-xdg-');
  const env = { XDG_CONFIG_HOME: xdg };
  const path = orgRootPublicKeyPath(env);
  assert.deepEqual(resolveOrgRoot(env), { kind: 'absent', path });
  mkdirSync(join(xdg, 'owenloop'), { recursive: true });
  writeFileSync(path, 'ssh-ed25519 AAAA fixture\n');
  assert.deepEqual(resolveOrgRoot(env), { kind: 'present', path, publicKey: 'ssh-ed25519 AAAA fixture\n' });
});

test('org-root loader refuses symlinked anchor, roster, and revocation entries', () => {
  const xdg = temp('owenloop-org-xdg-');
  const env = { XDG_CONFIG_HOME: xdg };
  const rootDir = join(xdg, 'owenloop');
  mkdirSync(rootDir, { recursive: true });
  const target = join(xdg, 'target');
  writeFileSync(target, 'ssh-ed25519 AAAA fixture\n');
  symlinkSync(target, orgRootPublicKeyPath(env));
  assert.throws(() => resolveOrgRoot(env), /org-root public key path is a symlink/);

  const roster = rosterDir(env);
  mkdirSync(roster, { recursive: true });
  symlinkSync(target, join(roster, 'rogue.grant.dsse'));
  assert.throws(() => loadRoster(env), /roster entry is a symlink/);

  const revocations = revocationsDir(env);
  mkdirSync(revocations, { recursive: true });
  symlinkSync(target, join(revocations, 'rogue.revocation.dsse'));
  assert.throws(() => loadRevocations(env), /revocations entry is a symlink/);

  const dangling = temp('owenloop-org-dangling-');
  const danglingEnv = { XDG_CONFIG_HOME: dangling };
  mkdirSync(join(dangling, 'owenloop'), { recursive: true });
  symlinkSync(join(dangling, 'missing-root'), orgRootPublicKeyPath(danglingEnv));
  assert.throws(() => resolveOrgRoot(danglingEnv), /org-root public key path is a symlink/);
  symlinkSync(join(dangling, 'missing-roster'), rosterDir(danglingEnv));
  assert.throws(() => loadRoster(danglingEnv), /roster directory is a symlink/);
});

test('loaders return sorted matching envelope bytes and ignore unrelated regular files', () => {
  const xdg = temp('owenloop-org-xdg-');
  const env = { XDG_CONFIG_HOME: xdg };
  mkdirSync(rosterDir(env), { recursive: true });
  mkdirSync(revocationsDir(env), { recursive: true });
  writeFileSync(join(rosterDir(env), 'b.grant.dsse'), 'grant-b');
  writeFileSync(join(rosterDir(env), 'a.grant.dsse'), 'grant-a');
  writeFileSync(join(rosterDir(env), 'README'), 'ignore');
  writeFileSync(join(revocationsDir(env), 'b.revocation.dsse'), 'rev-b');
  writeFileSync(join(revocationsDir(env), 'a.revocation.dsse'), 'rev-a');
  assert.deepEqual(loadRoster(env).map((value) => Buffer.from(value).toString()), ['grant-a', 'grant-b']);
  assert.deepEqual(loadRevocations(env).map((value) => Buffer.from(value).toString()), ['rev-a', 'rev-b']);
});
