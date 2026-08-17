import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  grantsDir,
  loadRevocations,
  orgRootPrivateKeyPath,
  orgRootPublicKeyPath,
  resolveOrgRoot,
  revocationsDir,
  loadGrants,
  StrandedLegacyGrantsError,
} from '../src/crypto/org-root.ts';

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('org-root paths use HOME/.owenloop and ignore XDG_CONFIG_HOME', () => {
  const xdg = temp('owenloop-org-xdg-');
  const home = temp('owenloop-org-home-');
  assert.equal(orgRootPublicKeyPath({ XDG_CONFIG_HOME: xdg, HOME: home }), join(home, '.owenloop', 'org-root.pub'));
  assert.equal(orgRootPrivateKeyPath({ XDG_CONFIG_HOME: xdg, HOME: home }), join(home, '.owenloop', 'org-root'));
  assert.equal(grantsDir({ XDG_CONFIG_HOME: xdg, HOME: home }), join(home, '.owenloop', 'grants'));
  assert.equal(revocationsDir({ XDG_CONFIG_HOME: xdg, HOME: home }), join(home, '.owenloop', 'revocations'));
  assert.equal(orgRootPublicKeyPath({ XDG_CONFIG_HOME: '  ', HOME: home }), join(home, '.owenloop', 'org-root.pub'));
  assert.throws(() => orgRootPublicKeyPath({}), /cannot locate an allowed_signers path/);
});

test('resolveOrgRoot distinguishes absence from a present regular public file', () => {
  const xdg = temp('owenloop-org-xdg-');
  const env = { HOME: xdg };
  const path = orgRootPublicKeyPath(env);
  assert.deepEqual(resolveOrgRoot(env), { kind: 'absent', path });
  mkdirSync(join(xdg, '.owenloop'), { recursive: true });
  writeFileSync(path, 'ssh-ed25519 AAAA fixture\n');
  assert.deepEqual(resolveOrgRoot(env), { kind: 'present', path, publicKey: 'ssh-ed25519 AAAA fixture\n' });
});

test('org-root loader refuses symlinked anchor, grants, and revocation entries', () => {
  const xdg = temp('owenloop-org-xdg-');
  const env = { HOME: xdg };
  const rootDir = join(xdg, '.owenloop');
  mkdirSync(rootDir, { recursive: true });
  const target = join(xdg, 'target');
  writeFileSync(target, 'ssh-ed25519 AAAA fixture\n');
  symlinkSync(target, orgRootPublicKeyPath(env));
  assert.throws(() => resolveOrgRoot(env), /org-root public key path is a symlink/);

  const grants = grantsDir(env);
  mkdirSync(grants, { recursive: true });
  symlinkSync(target, join(grants, 'rogue.grant.dsse'));
  assert.throws(() => loadGrants(env), /grants entry is a symlink/);

  const revocations = revocationsDir(env);
  mkdirSync(revocations, { recursive: true });
  symlinkSync(target, join(revocations, 'rogue.revocation.dsse'));
  assert.throws(() => loadRevocations(env), /revocations entry is a symlink/);

  const dangling = temp('owenloop-org-dangling-');
  const danglingEnv = { HOME: dangling };
  mkdirSync(join(dangling, '.owenloop'), { recursive: true });
  symlinkSync(join(dangling, 'missing-root'), orgRootPublicKeyPath(danglingEnv));
  assert.throws(() => resolveOrgRoot(danglingEnv), /org-root public key path is a symlink/);
  symlinkSync(join(dangling, 'missing-grants'), grantsDir(danglingEnv));
  assert.throws(() => loadGrants(danglingEnv), /grants directory is a symlink/);
});

test('loaders return sorted matching envelope bytes and ignore unrelated regular files', () => {
  const xdg = temp('owenloop-org-xdg-');
  const env = { HOME: xdg };
  mkdirSync(grantsDir(env), { recursive: true });
  mkdirSync(revocationsDir(env), { recursive: true });
  writeFileSync(join(grantsDir(env), 'b.grant.dsse'), 'grant-b');
  writeFileSync(join(grantsDir(env), 'a.grant.dsse'), 'grant-a');
  writeFileSync(join(grantsDir(env), 'README'), 'ignore');
  writeFileSync(join(revocationsDir(env), 'b.revocation.dsse'), 'rev-b');
  writeFileSync(join(revocationsDir(env), 'a.revocation.dsse'), 'rev-a');
  assert.deepEqual(loadGrants(env).map((value) => Buffer.from(value).toString()), ['grant-a', 'grant-b']);
  assert.deepEqual(loadRevocations(env).map((value) => Buffer.from(value).toString()), ['rev-a', 'rev-b']);
});

test('loadGrants refuses when legacy grants are stranded and the new directory is absent', () => {
  const home = temp('owenloop-org-legacy-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  assert.throws(
    () => loadGrants(env),
    (error: unknown) => error instanceof StrandedLegacyGrantsError
      && error.message.includes(grantsDir(env))
      && error.message.includes(legacy)
      && error.message.includes('mv '),
  );
});

test('loadGrants refuses when the new directory has no grants and legacy grants exist', () => {
  const home = temp('owenloop-org-legacy-empty-new-');
  const env = { HOME: home };
  mkdirSync(grantsDir(env), { recursive: true });
  writeFileSync(join(grantsDir(env), 'README'), 'no grants here');
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  assert.throws(() => loadGrants(env), StrandedLegacyGrantsError);
});

test('loadGrants uses only populated new grants when both directories contain grants', () => {
  const home = temp('owenloop-org-both-grants-');
  const env = { HOME: home };
  mkdirSync(grantsDir(env), { recursive: true });
  writeFileSync(join(grantsDir(env), 'new.grant.dsse'), 'new-grant');
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  assert.deepEqual(loadGrants(env).map((value) => Buffer.from(value).toString()), ['new-grant']);
});

test('loadGrants returns an empty list when both grants directories are absent', () => {
  const env = { HOME: temp('owenloop-org-no-grants-') };
  assert.deepEqual(loadGrants(env), []);
});

test('loadGrants returns an empty list when legacy has no grant envelopes', () => {
  const home = temp('owenloop-org-empty-legacy-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'README'), 'no grants here');

  assert.deepEqual(loadGrants(env), []);
});

test('loadGrants ignores an unreadable legacy path used only as a diagnostic hint', () => {
  const home = temp('owenloop-org-legacy-file-');
  const env = { HOME: home };
  mkdirSync(join(home, '.owenloop'), { recursive: true });
  writeFileSync(join(home, '.owenloop', 'roster'), 'not a directory');

  assert.deepEqual(loadGrants(env), []);
});
