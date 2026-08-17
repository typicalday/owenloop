import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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

function runPrintedMigration(error: StrandedLegacyGrantsError): void {
  const match = error.message.match(/Run:  (.+)  then restart/);
  assert.ok(match !== null, error.message);
  execFileSync('/bin/sh', ['-c', match[1]!]);
}

function strandedError(env: Record<string, string | undefined>): StrandedLegacyGrantsError {
  let result: StrandedLegacyGrantsError | undefined;
  assert.throws(
    () => loadGrants(env),
    (thrown: unknown) => {
      if (!(thrown instanceof StrandedLegacyGrantsError)) return false;
      result = thrown;
      return true;
    },
  );
  assert.ok(result !== undefined);
  return result;
}

function assertManualRepair(error: StrandedLegacyGrantsError, path: string): void {
  assert.doesNotMatch(error.message, /Run:/);
  assert.ok(error.message.includes(path), error.message);
  assert.match(error.message, /Repair .* by hand/);
}

function assertInvalidLegacySource(env: Record<string, string | undefined>, path: string): void {
  const error = strandedError(env);
  assertManualRepair(error, path);
  assert.match(error.message, /legacy grants source/);
  assert.equal(existsSync(grantsDir(env)), false);
  assert.throws(() => loadGrants(env), StrandedLegacyGrantsError);
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
  writeFileSync(join(legacy, '.hidden.grant.dsse'), 'hidden-grant');

  const error = strandedError(env);
  assert.match(error.message, new RegExp(`'${grantsDir(env)}'`));
  assert.match(error.message, new RegExp(`'${legacy}'`));
  runPrintedMigration(error);
  assert.deepEqual(loadGrants(env).map((value) => Buffer.from(value).toString()), ['hidden-grant', 'legacy-grant']);
});

test('loadGrants refuses when the new directory has no grants and legacy grants exist', () => {
  const home = temp('owenloop-org-legacy-empty-new-');
  const env = { HOME: home };
  mkdirSync(grantsDir(env), { recursive: true });
  writeFileSync(join(grantsDir(env), 'README'), 'no grants here');
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  const error = strandedError(env);
  runPrintedMigration(error);
  assert.deepEqual(loadGrants(env).map((value) => Buffer.from(value).toString()), ['legacy-grant']);
});

test('loadGrants prints an executable migration command for config paths containing apostrophes', () => {
  const config = temp("owenloop-org-apostrophe-'");
  const env = { OWENLOOP_CONFIG_DIR: config };
  const legacy = join(config, 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  const error = strandedError(env);
  runPrintedMigration(error);
  assert.deepEqual(loadGrants(env).map((value) => Buffer.from(value).toString()), ['legacy-grant']);
});

test('loadGrants requires manual repair when the grants destination is a regular file', () => {
  const home = temp('owenloop-org-legacy-broken-new-');
  const env = { HOME: home };
  mkdirSync(join(home, '.owenloop'), { recursive: true });
  writeFileSync(grantsDir(env), 'not a directory');
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  assertManualRepair(strandedError(env), grantsDir(env));
  assert.throws(() => loadGrants(env), StrandedLegacyGrantsError);
});

test('loadGrants requires manual repair when the grants destination has a child directory', () => {
  const home = temp('owenloop-org-legacy-child-directory-');
  const env = { HOME: home };
  const grants = grantsDir(env);
  const child = join(grants, 'roster');
  mkdirSync(child, { recursive: true });
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  assertManualRepair(strandedError(env), child);
  assert.throws(() => loadGrants(env), StrandedLegacyGrantsError);
});

test('loadGrants requires manual repair when the grants destination has a foreign symlink', () => {
  const home = temp('owenloop-org-legacy-foreign-symlink-');
  const env = { HOME: home };
  const grants = grantsDir(env);
  mkdirSync(grants, { recursive: true });
  const target = join(home, 'target');
  writeFileSync(target, 'target');
  const foreign = join(grants, 'note.txt');
  symlinkSync(target, foreign);
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  assertManualRepair(strandedError(env), foreign);
  assert.throws(() => loadGrants(env), StrandedLegacyGrantsError);
});

test('loadGrants requires manual repair when the grants destination is a symlink', () => {
  const home = temp('owenloop-org-legacy-symlinked-destination-');
  const env = { HOME: home };
  const root = join(home, '.owenloop');
  mkdirSync(root, { recursive: true });
  const target = join(home, 'grants-target');
  mkdirSync(target);
  symlinkSync(target, grantsDir(env));
  const legacy = join(root, 'roster');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');

  assertManualRepair(strandedError(env), grantsDir(env));
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

test('loadGrants requires manual repair when the legacy source is not a directory', () => {
  const home = temp('owenloop-org-legacy-file-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(join(home, '.owenloop'), { recursive: true });
  writeFileSync(legacy, 'not a directory');

  assertInvalidLegacySource(env, legacy);
});

test('loadGrants requires manual repair when the legacy source is a symlink', () => {
  const home = temp('owenloop-org-legacy-symlink-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  const target = join(home, 'legacy-target');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'legacy.grant.dsse'), 'legacy-grant');
  mkdirSync(join(home, '.owenloop'), { recursive: true });
  symlinkSync(target, legacy);

  assertInvalidLegacySource(env, legacy);
});

test('loadGrants requires manual repair when a legacy grant entry is a symlink', () => {
  const home = temp('owenloop-org-legacy-grant-symlink-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  const target = join(home, 'legacy-target');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(target, 'legacy-grant');
  const entry = join(legacy, 'legacy.grant.dsse');
  symlinkSync(target, entry);

  assertInvalidLegacySource(env, entry);
});

test('loadGrants requires manual repair when a legacy grant entry is a directory', () => {
  const home = temp('owenloop-org-legacy-grant-directory-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  const entry = join(legacy, 'legacy.grant.dsse');
  mkdirSync(entry, { recursive: true });

  assertInvalidLegacySource(env, entry);
});

test('loadGrants requires manual repair when reading the legacy source fails', () => {
  const home = temp('owenloop-org-legacy-unreadable-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');
  chmodSync(legacy, 0o000);

  try {
    const error = strandedError(env);
    assertManualRepair(error, legacy);
    assert.match(error.message, /cannot inspect legacy grants source/);
  } finally {
    chmodSync(legacy, 0o700);
  }
  assert.equal(existsSync(grantsDir(env)), false);
});

test('loadGrants requires manual repair when locating the legacy source fails', () => {
  const home = temp('owenloop-org-legacy-source-unsearchable-');
  const env = { HOME: home };
  const root = join(home, '.owenloop');
  const legacy = join(root, 'roster');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'legacy.grant.dsse'), 'legacy-grant');
  // Missing search permission on the parent makes the source lstatSync fail.
  chmodSync(root, 0o600);

  try {
    const error = strandedError(env);
    assertManualRepair(error, legacy);
    assert.match(error.message, /cannot inspect legacy grants source/);
  } finally {
    chmodSync(root, 0o700);
  }
  assert.equal(existsSync(grantsDir(env)), false);
});

test('loadGrants requires manual repair when inspecting a legacy source entry fails', () => {
  const home = temp('owenloop-org-legacy-entry-unreadable-');
  const env = { HOME: home };
  const legacy = join(home, '.owenloop', 'roster');
  const entry = join(legacy, 'legacy.grant.dsse');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(entry, 'legacy-grant');
  // Read permission permits readdirSync, but the missing search permission
  // makes lstatSync of the returned child fail.
  chmodSync(legacy, 0o400);

  try {
    const error = strandedError(env);
    assertManualRepair(error, entry);
    assert.match(error.message, /cannot inspect legacy grants source entry/);
  } finally {
    chmodSync(legacy, 0o700);
  }
  assert.equal(existsSync(grantsDir(env)), false);
});
