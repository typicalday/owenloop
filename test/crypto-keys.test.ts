/**
 * `PrincipalKeyManager` — principal signing-key storage. Two layers:
 *
 * 1. FAKE-PLATFORM storage tests (no host keychain, no real ssh-keygen): the
 *    `KeyCommandRunner` seam emulates macOS `security` and Linux `secret-tool`
 *    in memory. Proves: backend selection (darwin → security; linux →
 *    secret-tool-when-present; `OWENLOOP_NO_KEYCHAIN=1` → file; forced
 *    override), secrets ride on child stdin with lookup stdout redirected to a
 *    pre-opened fd (never a pipe), a SELECTED backend's failure is a hard
 *    fixed error with NO fallback, records validate against their ref, corrupt
 *    records are refused, symlinked storage dirs are refused, modes are
 *    0700/0600, reuse is human-only with a hard conflict against existing
 *    keys, and concurrent `ensure` generates exactly once (file lock).
 *
 *    A POISON marker stands in for the generated private key; every test
 *    asserts it never appears in argv, captured stdout, or thrown messages.
 *
 * 2. REAL ssh-keygen tests (gated on `-Y` support): generation writes a real
 *    Ed25519 record, idempotent re-ensure is zero-write, `withSigningKey`
 *    materializes the key in a temp dir that is removed afterward, and
 *    `--reuse-ssh-key` validates a real candidate key through the sign/verify
 *    challenge and stores only the canonical path (never the private bytes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PrincipalKeyManager,
  assertKeyRef,
  canonicalKeyRef,
  keyRefHash,
  keyidFromBlob,
  keysDirFor,
  publicKeyDescriptor,
} from '../src/crypto/keys.ts';
import type { KeyCommandRunner, PrincipalKeyRef } from '../src/crypto/keys.ts';
import { CliError } from '../src/util.ts';
import { acquireFileLock, releaseFileLock } from '../src/lock.ts';

const POISON = 'POISON-PRIVATE-KEY-MARKER-8f3a';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'crypto');
const FIXTURE_PUB = readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8');

const REF: PrincipalKeyRef = { origin: 'https://hub.example', kind: 'human', id: 'user_abc' };

/** Does this host run a stock `ssh-keygen` that supports `-Y`? */
function sshKeygenWorks(): boolean {
  try {
    execFileSync('ssh-keygen', ['-Y', 'find-principals'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch (e) {
    return typeof (e as { status?: unknown }).status === 'number';
  }
}
const SKIP = !sshKeygenWorks() && 'host ssh-keygen lacks -Y support';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-keys-home-'));
}

// ---- the fake storage runner ---------------------------------------------------

interface RunRecord {
  cmd: string;
  args: string[];
  stdin: Buffer | undefined;
  stdoutFd: number | undefined;
  captureStdout: boolean | undefined;
}

/**
 * Emulates the storage commands in memory AND synthesizes ssh-keygen
 * generation/challenge results, so these tests never touch a real binary.
 * `store` maps backend-hash → record text.
 */
function makeFakeRunner(opts: { failLookup?: boolean; failStore?: boolean; secretToolLookupStatus?: number; derivedPubText?: string } = {}): {
  runner: KeyCommandRunner;
  runs: RunRecord[];
  store: Map<string, string>;
  generations: number;
} {
  const runs: RunRecord[] = [];
  const store = new Map<string, string>();
  let generations = 0;

  const runner: KeyCommandRunner = {
    run(cmd, args, o) {
      runs.push({ cmd, args, stdin: o.stdin, stdoutFd: o.stdoutFd, captureStdout: o.captureStdout });

      // --- synthesized ssh-keygen ---
      if (args.includes('-t') && args.includes('ed25519')) {
        // generation: `-q -t ed25519 -N '' -C <comment> -f <path>`
        generations++;
        const keyPath = args[args.indexOf('-f') + 1]!;
        writeFileSync(keyPath, `${POISON}-${generations}\n`, { mode: 0o600 });
        writeFileSync(`${keyPath}.pub`, FIXTURE_PUB);
        return { status: 0, stdout: Buffer.alloc(0) };
      }
      if (args[0] === '-y' && args[1] === '-f') {
        return { status: 0, stdout: Buffer.from(opts.derivedPubText ?? FIXTURE_PUB, 'utf8') };
      }
      if (args[0] === '-Y' && args[1] === 'sign') {
        return {
          status: 0,
          stdout: Buffer.from('-----BEGIN SSH SIGNATURE-----\nQUJD\n-----END SSH SIGNATURE-----\n', 'utf8'),
        };
      }
      if (args[0] === '-Y' && args[1] === 'verify') return { status: 0, stdout: Buffer.alloc(0) };

      // --- macOS security ---
      if (cmd === 'security' && args[0] === 'find-generic-password') {
        const hash = args[args.indexOf('-a') + 1]!;
        if (opts.failLookup) return { status: 3, stdout: Buffer.alloc(0) };
        if (o.stdoutFd === undefined) throw new Error('lookup must redirect stdout to an fd');
        const rec = store.get(hash);
        if (rec === undefined) return { status: 44, stdout: Buffer.alloc(0) }; // errSecItemNotFound
	// Faithful to the real tool: only `-w` prints the secret to stdout.
	// Without it, stdout carries the item's attribute dump — which is how
	// the missing `-w` regression looked in production (attribute text
	// fails JSON.parse and reads as a "corrupt" record).
	writeFileSync(o.stdoutFd, args.includes('-w') ? rec : `keychain: "login.keychain-db"\nclass: "genp"\nattributes:\n    0x00000007 <blob>="owenloop-signing"\n`);
        return { status: 0, stdout: Buffer.alloc(0) };
      }
      if (cmd === 'security' && args[0] === '-i') {
        if (opts.failStore) return { status: 1, stdout: Buffer.alloc(0) };
        // The record rides on stdin as a quoted command stream — extract it.
        const text = o.stdin!.toString('utf8');
        const hash = /-a '([0-9a-f]{64})'/.exec(text)![1]!;
        const body = text.slice(text.indexOf("-w '") + 4, text.lastIndexOf("'"));
	// Faithful to the real tool's tokenizer: inside single quotes, `\` is
	// still an escape character — `\X` collapses to `X` (so `\\`→`\`, and
	// an unescaped `\n` in the payload silently degrades to `n`). The
	// writer must pre-double backslashes for the payload to round-trip.
	store.set(hash, body.replace(/'\\''/g, "'").replace(/\\(.)/g, '$1'));
        return { status: 0, stdout: Buffer.alloc(0) };
      }

      // --- Linux secret-tool ---
      if (cmd === 'secret-tool' && args[0] === 'lookup') {
        const hash = args[args.length - 1]!;
        if (opts.secretToolLookupStatus !== undefined) return { status: opts.secretToolLookupStatus, stdout: Buffer.alloc(0) };
        if (opts.failLookup) return { status: 2, stdout: Buffer.alloc(0) };
        if (o.stdoutFd === undefined) throw new Error('lookup must redirect stdout to an fd');
        const rec = store.get(hash);
        if (rec !== undefined) writeFileSync(o.stdoutFd, rec);
        return { status: 0, stdout: Buffer.alloc(0) };
      }
      if (cmd === 'secret-tool' && args[0] === 'store') {
        if (opts.failStore) return { status: 2, stdout: Buffer.alloc(0) };
        const hash = args[args.length - 1]!;
        store.set(hash, o.stdin!.toString('utf8'));
        return { status: 0, stdout: Buffer.alloc(0) };
      }

      throw new Error(`fake runner: unexpected command ${cmd} ${args.join(' ')}`);
    },
  };
  return { runner, runs, store, generations };
}

/** Every assertion about the poison marker funnels through here. */
function assertNoPoison(label: string, ...texts: Array<string | undefined>): void {
  for (const t of texts) {
    assert.ok(t === undefined || !t.includes(POISON), `${label}: poison marker leaked`);
  }
}

function backendMarkerPath(home: string, ref: PrincipalKeyRef = REF): string {
  return join(home, '.owenloop', 'keys', `${keyRefHash(ref)}.backend`);
}

function validGeneratedRecord(): string {
  return JSON.stringify({
    version: 1,
    ref: REF,
    kind: 'generated',
    publicKey: FIXTURE_PUB.trim(),
    fingerprint: publicKeyDescriptor(FIXTURE_PUB).keyid,
    createdAt: new Date().toISOString(),
    privateKey: 'PRIVATE',
  });
}

function damagedMacosGeneratedRecord(): { damaged: string; privateKey: string } {
  const privateKey = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'A'.repeat(70),
    'B'.repeat(64),
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n');
  const healthy = JSON.stringify({
    version: 1,
    ref: REF,
    kind: 'generated',
    publicKey: FIXTURE_PUB.trim(),
    fingerprint: publicKeyDescriptor(FIXTURE_PUB).keyid,
    createdAt: new Date().toISOString(),
    privateKey,
  });
  return {
    privateKey,
    damaged: healthy.replace(/\\n/g, 'n'),
  };
}

function syntheticEd25519PublicKey(byte: number, comment: string): string {
  const blob = Buffer.alloc(4 + 11 + 4 + 32, byte);
  blob.writeUInt32BE(11, 0);
  blob.write('ssh-ed25519', 4, 'ascii');
  blob.writeUInt32BE(32, 15);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

// ---- backend selection (pure) ----------------------------------------------------

test('backend selection: darwin→macos-security, linux→secret-tool when present, else file', () => {
  const env: Record<string, string | undefined> = { HOME: '/nonexistent-home' };
  const mk = (platform: NodeJS.Platform, has: boolean) =>
    new PrincipalKeyManager({
      env,
      platform,
      commandExists: (c) => (c === 'secret-tool' ? has : false),
      runner: makeFakeRunner().runner,
    }).backend;
  assert.equal(mk('darwin', false), 'macos-security');
  assert.equal(mk('linux', true), 'secret-tool');
  assert.equal(mk('linux', false), 'file');
  assert.equal(mk('freebsd' as NodeJS.Platform, false), 'file');
});

test('backend selection: OWENLOOP_NO_KEYCHAIN=1 forces file on every platform', () => {
  const env: Record<string, string | undefined> = { HOME: '/nonexistent-home', OWENLOOP_NO_KEYCHAIN: '1' };
  for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
    const m = new PrincipalKeyManager({ env, platform, commandExists: () => true, runner: makeFakeRunner().runner });
    assert.equal(m.backend, 'file', platform);
  }
});

test('backend selection: an explicit backend option overrides platform logic; missing $HOME is an error', () => {
  const m = new PrincipalKeyManager({
    env: {},
    platform: 'darwin',
    backend: 'file',
    runner: makeFakeRunner().runner,
    homeDir: '/nonexistent-home',
  });
  assert.equal(m.backend, 'file');
  assert.throws(() => new PrincipalKeyManager({ env: {} }), CliError);
});

test('backend ownership markers are claimed on first read and first write for every backend', async () => {
  const record = validGeneratedRecord();
  for (const backend of ['file', 'macos-security', 'secret-tool'] as const) {
    const home = freshHome();
    const fake = makeFakeRunner();
    const manager = new PrincipalKeyManager({ env: {}, backend, runner: fake.runner, homeDir: home });
    const marker = backendMarkerPath(home);
    if (backend === 'file') {
      const keys = join(home, '.owenloop', 'keys');
      mkdirSync(keys, { recursive: true });
      writeFileSync(join(keys, `${keyRefHash(REF)}.json`), record, { mode: 0o600 });
    } else {
      fake.store.set(keyRefHash(REF), record);
    }
    assert.equal(existsSync(marker), false, `${backend}: marker starts absent`);
    const inspected = await manager.inspect(REF);
    assert.equal(inspected.exists, true, `${backend}: first read sees the stored record`);
    assert.equal(readFileSync(marker, 'utf8').trim(), backend, `${backend}: first read claims ownership`);

    const fresh = freshHome();
    const generated = new PrincipalKeyManager({ env: {}, backend, runner: makeFakeRunner().runner, homeDir: fresh });
    await generated.ensure(REF);
    assert.equal(readFileSync(backendMarkerPath(fresh), 'utf8').trim(), backend, `${backend}: first write claims ownership`);
  }
});

test('backend ownership refuses cross-backend reads, pre-marker file records, and corrupt markers', async () => {
  const home = freshHome();
  const file = new PrincipalKeyManager({ env: {}, backend: 'file', runner: makeFakeRunner().runner, homeDir: home });
  await file.ensure(REF);
  const secret = new PrincipalKeyManager({ env: {}, backend: 'secret-tool', runner: makeFakeRunner().runner, homeDir: home });
  await assert.rejects(secret.inspect(REF), /belongs to backend file/);

  const preMarkerHome = freshHome();
  const keys = join(preMarkerHome, '.owenloop', 'keys');
  mkdirSync(keys, { recursive: true });
  writeFileSync(join(keys, `${keyRefHash(REF)}.json`), validGeneratedRecord(), { mode: 0o600 });
  const selectedSecret = new PrincipalKeyManager({ env: {}, backend: 'secret-tool', runner: makeFakeRunner().runner, homeDir: preMarkerHome });
  await assert.rejects(selectedSecret.inspect(REF), /has a file-backed record/);

  const corruptHome = freshHome();
  const corruptKeys = join(corruptHome, '.owenloop', 'keys');
  mkdirSync(corruptKeys, { recursive: true });
  writeFileSync(backendMarkerPath(corruptHome), 'not-a-backend\n', { mode: 0o600 });
  const corrupt = new PrincipalKeyManager({ env: {}, backend: 'file', runner: makeFakeRunner().runner, homeDir: corruptHome });
  await assert.rejects(corrupt.inspect(REF), /backend ownership .* corrupt/);
});

// ---- fake-platform storage: macos-security ----------------------------------------

test('macos-security: create → record on stdin (never argv), lookup stdout to fd, second ensure is existing with zero writes', async () => {
  const home = freshHome();
  const { runner, runs, store } = makeFakeRunner();
  const m = new PrincipalKeyManager({ env: {}, backend: 'macos-security', runner, homeDir: home });
  assert.equal(m.backend, 'macos-security');

  const res = await m.ensure(REF);
  assert.equal(res.state, 'created');
  assert.equal(res.backend, 'macos-security');
  assert.equal(res.publicKey.keyid, publicKeyDescriptor(FIXTURE_PUB).keyid);

  // The stored record carries the poison; it arrived via the `-i` stdin stream.
  const stored = store.get(keyRefHash(REF))!;
  assert.ok(stored.includes(POISON), 'the generated key reached the store');
  // Round-trip fidelity: `security -i` treats `\` as an escape char even
  // inside single quotes, so the writer must pre-double backslashes or the
  // record's JSON `\n` escapes degrade to bare `n` in the stored secret.
  assert.equal((JSON.parse(stored) as { privateKey: string }).privateKey, `${POISON}-1\n`);
  const addRun = runs.find((r) => r.cmd === 'security' && r.args[0] === '-i')!;
  assert.ok(addRun.stdin!.toString('utf8').includes(POISON), 'secret rides on child stdin');
  for (const r of runs) {
    for (const a of r.args) assertNoPoison('security argv', a);
  }

  // Lookup redirected stdout to a pre-opened fd, never a pipe — and it must
  // pass `-w`, or stdout carries the attribute dump instead of the secret.
  const findRun = runs.find((r) => r.cmd === 'security' && r.args[0] === 'find-generic-password')!;
  assert.ok(typeof findRun.stdoutFd === 'number' && findRun.captureStdout === undefined);
  assert.ok(findRun.args.includes('-w'), 'lookup must print the secret, not the attribute dump');

  // Idempotent second ensure: no new store write.
  const writesBefore = store.size;
  const res2 = await m.ensure(REF);
  assert.equal(res2.state, 'existing');
  assert.equal(store.size, writesBefore);
  const addRuns = runs.filter((r) => r.cmd === 'security' && r.args[0] === '-i');
  assert.equal(addRuns.length, 1, 'no second write');
});

test('macos-security: inspect migrates the exact pre-fix newline damage without changing identity', async () => {
  const home = freshHome();
  const fake = makeFakeRunner();
  const seeded = damagedMacosGeneratedRecord();
  fake.store.set(keyRefHash(REF), seeded.damaged);
  const manager = new PrincipalKeyManager({
    env: {},
    backend: 'macos-security',
    runner: fake.runner,
    homeDir: home,
  });
  const fingerprint = publicKeyDescriptor(FIXTURE_PUB).keyid;

  const migrated = await manager.inspect(REF);
  assert.equal(migrated.exists, true);
  assert.equal(migrated.publicKey?.keyid, fingerprint);
  const repaired = JSON.parse(fake.store.get(keyRefHash(REF))!) as {
    privateKey: string;
    fingerprint: string;
  };
  assert.equal(repaired.privateKey, seeded.privateKey);
  assert.equal(repaired.fingerprint, fingerprint);
  assert.equal(
    fake.runs.filter((run) => run.cmd === 'security' && run.args[0] === '-i').length,
    1,
    'migration rewrites the verified record once',
  );

  const later = await manager.ensure(REF);
  assert.equal(later.state, 'existing');
  assert.equal(later.publicKey.keyid, fingerprint);
  assert.equal(
    fake.runs.filter((run) => run.cmd === 'security' && run.args[0] === '-i').length,
    1,
    'a healthy later ensure is idempotent',
  );
});

test('macos-security: migration reconstructs a real stock OpenSSH key before identity verification', { skip: SKIP }, async () => {
  const home = freshHome();
  const fixtureDir = mkdtempSync(join(tmpdir(), 'owenloop-damaged-real-key-'));
  try {
    const keyPath = join(fixtureDir, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'migration-fixture', '-f', keyPath]);
    const privateKey = readFileSync(keyPath, 'utf8');
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
    const fingerprint = publicKeyDescriptor(publicKey).keyid;
    const healthy = JSON.stringify({
      version: 1,
      ref: REF,
      kind: 'generated',
      publicKey,
      fingerprint,
      createdAt: new Date().toISOString(),
      privateKey,
    });
    const fake = makeFakeRunner();
    const runner: KeyCommandRunner = {
      run(cmd, args, opts) {
	if (cmd === 'ssh-keygen' && args[0] === '-y') {
	  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
	  return {
	    status: result.status ?? 1,
	    stdout: result.stdout,
	  };
	}
	return fake.runner.run(cmd, args, opts);
      },
    };
    fake.store.set(keyRefHash(REF), healthy.replace(/\\n/g, 'n'));
    const manager = new PrincipalKeyManager({
      env: {},
      backend: 'macos-security',
      runner,
      homeDir: home,
    });

    const materialized = await manager.withSigningKey(
      REF,
      async (materializedPath) => readFileSync(materializedPath, 'utf8'),
    );

    assert.equal(materialized, privateKey);
    const repaired = JSON.parse(fake.store.get(keyRefHash(REF))!) as {
      privateKey: string;
      fingerprint: string;
    };
    assert.equal(repaired.privateKey, privateKey);
    assert.equal(repaired.fingerprint, fingerprint);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('macos-security: damaged record migration refuses an unverifiable identity without rewriting', async () => {
  const home = freshHome();
  const alternate = syntheticEd25519PublicKey(0x42, 'alternate');
  const fake = makeFakeRunner({ derivedPubText: alternate });
  const seeded = damagedMacosGeneratedRecord();
  fake.store.set(keyRefHash(REF), seeded.damaged);
  const manager = new PrincipalKeyManager({
    env: {},
    backend: 'macos-security',
    runner: fake.runner,
    homeDir: home,
  });

  await assert.rejects(manager.inspect(REF), (error: Error) => {
    assert.match(error.message, /pre-fix macOS Keychain newline damage/);
    assert.match(error.message, /security delete-generic-password/);
    assert.match(error.message, /owenloop setup/);
    assertNoPoison('migration error', error.message);
    return true;
  });
  assert.equal(fake.store.get(keyRefHash(REF)), seeded.damaged);
  const lockPath = join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.lock`);
  assert.equal(existsSync(lockPath), true, 'failed migration keeps the persistent SQLite lock database');
  const probe = await acquireFileLock(lockPath, { waitMs: 100, pollMs: 5, label: 'test migration probe' });
  releaseFileLock(probe);
  assert.equal(
    fake.runs.filter((run) => run.cmd === 'security' && run.args[0] === '-i').length,
    0,
    'identity mismatch never rewrites or rotates the stored record',
  );
});

test('macos-security: a selected-backend failure is a hard fixed error with NO fallback and no poison in the message', async () => {
  const home = freshHome();
  const { runner } = makeFakeRunner({ failLookup: true });
  const m = new PrincipalKeyManager({ env: {}, backend: 'macos-security', runner, homeDir: home });
  await assert.rejects(m.ensure(REF), (e: Error) => {
    assert.ok(e instanceof CliError);
    assert.match(e.message, /signing-key storage \(macos-security\) failed/);
    assertNoPoison('backend error message', e.message);
    return true;
  });
  // No fallback: nothing landed in the file backend's directory.
  assert.ok(!existsSync(join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.json`)), 'no fallback file record');
});

// ---- fake-platform storage: secret-tool -------------------------------------------

test('secret-tool: create/lookup round-trip through stdin and fd redirection', async () => {
  const home = freshHome();
  const { runner, runs, store } = makeFakeRunner();
  const m = new PrincipalKeyManager({ env: {}, backend: 'secret-tool', runner, homeDir: home });

  const res = await m.ensure(REF);
  assert.equal(res.state, 'created');
  assert.equal(res.backend, 'secret-tool');
  const stored = store.get(keyRefHash(REF))!;
  assert.ok(stored.includes(POISON));
  const storeRun = runs.find((r) => r.cmd === 'secret-tool' && r.args[0] === 'store')!;
  assert.ok(storeRun.stdin!.toString('utf8').includes(POISON), 'secret on stdin');
  assert.deepEqual(
    storeRun.args.slice(0, 4),
    ['store', '--label', `owenloop signing key ${REF.kind}`, 'owenloop-service'],
  );
  const lookupRun = runs.find((r) => r.cmd === 'secret-tool' && r.args[0] === 'lookup')!;
  assert.ok(typeof lookupRun.stdoutFd === 'number' && lookupRun.captureStdout === undefined);

  const res2 = await m.ensure(REF);
  assert.equal(res2.state, 'existing');
});

test('secret-tool: lookup status 1 is an absent item, not a backend failure', async () => {
  const home = freshHome();
  const { runner, runs } = makeFakeRunner({ secretToolLookupStatus: 1 });
  const m = new PrincipalKeyManager({ env: {}, backend: 'secret-tool', runner, homeDir: home });
  const result = await m.inspect(REF);
  assert.deepEqual(result, { exists: false, source: undefined, backend: undefined, publicKey: undefined });
  const lookup = runs.find((r) => r.cmd === 'secret-tool' && r.args[0] === 'lookup');
  assert.ok(lookup, 'the status-1 lookup path was exercised');
});

test('secret-tool: store failure is a hard error, never a fallback', async () => {
  const home = freshHome();
  const { runner } = makeFakeRunner({ failStore: true });
  const m = new PrincipalKeyManager({ env: {}, backend: 'secret-tool', runner, homeDir: home });
  await assert.rejects(m.ensure(REF), /signing-key storage \(secret-tool\) failed/);
  assert.ok(!existsSync(join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.json`)));
});

// ---- file backend: modes, atomicity, symlink refusal, corruption -------------------

test('file backend: record is 0600, dirs are 0700, rewrite leaves no stray tmp files', { skip: SKIP }, async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  await m.ensure(REF);

  const dir = join(home, '.owenloop');
  const keys = join(dir, 'keys');
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(lstatSync(keys).mode & 0o777, 0o700);
  const recordPath = join(keys, `${keyRefHash(REF)}.json`);
  assert.equal(lstatSync(recordPath).mode & 0o777, 0o600);

  // Atomic rewrite leaves no .tmp files behind.
  const stray = readdirSync(keys).filter((f) => f.includes('.tmp'));
  assert.deepEqual(stray, []);
});

test('file backend: ensure writes the ref pointer on create and backfills it on existing', { skip: SKIP }, async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  const pointer = join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.ref`);

  const created = await m.ensure(REF);
  assert.equal(created.state, 'created');
  assert.equal(readFileSync(pointer, 'utf8'), canonicalKeyRef(REF));
  assert.equal(lstatSync(pointer).mode & 0o777, 0o600);

  rmSync(pointer);
  assert.equal(existsSync(pointer), false);
  const existing = await m.ensure(REF);
  assert.equal(existing.state, 'existing');
  assert.equal(readFileSync(pointer, 'utf8'), canonicalKeyRef(REF));
  assert.deepEqual(m.listRefs(), [REF]);
  assert.deepEqual(m.resolveRef(REF.origin, REF.kind), REF);
});

test('file backend: a symlinked keys dir is refused, never written through', async () => {
  const home = freshHome();
  const target = join(home, 'elsewhere');
  mkdirSync(target);
  mkdirSync(join(home, '.owenloop'));
  symlinkSync(target, join(home, '.owenloop', 'keys'));
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  await assert.rejects(m.ensure(REF), /symbolic link/);
  assert.deepEqual(readdirSync(target), [], 'the symlink target stayed empty');
});

test('file backend: corrupt record and ref-mismatch are hard failures — never used, never replaced', async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  const keys = join(home, '.owenloop', 'keys');
  mkdirSync(keys, { recursive: true });
  const recordPath = join(keys, `${keyRefHash(REF)}.json`);

  writeFileSync(recordPath, '{not json', { mode: 0o600 });
  await assert.rejects(m.ensure(REF), /corrupt — refusing to use or replace/);
  assert.equal(readFileSync(recordPath, 'utf8'), '{not json', 'the corrupt record is NOT clobbered');

  // A well-formed record for a DIFFERENT ref at this path.
  const other = JSON.stringify({
    version: 1,
    ref: { origin: 'https://other.example', kind: 'human', id: 'someone-else' },
    kind: 'generated',
    publicKey: FIXTURE_PUB.trim(),
    fingerprint: 'SHA256:x',
    createdAt: new Date().toISOString(),
    privateKey: 'PRIVATE',
  });
  writeFileSync(recordPath, other, { mode: 0o600 });
  await assert.rejects(m.ensure(REF), /does not match the requested ref/);

  // A generated record missing its key material is corrupt too.
  const noKey = JSON.stringify({
    version: 1,
    ref: REF,
    kind: 'generated',
    publicKey: FIXTURE_PUB.trim(),
    fingerprint: 'SHA256:x',
    createdAt: new Date().toISOString(),
  });
  writeFileSync(recordPath, noKey, { mode: 0o600 });
  await assert.rejects(m.ensure(REF), /corrupt \(missing key material\)/);
});

test('record schema rejects each strict invariant at the field that is malformed', async () => {
  const cases: Array<{ name: string; mutate: (record: Record<string, unknown>) => void; error: RegExp }> = [
    {
      name: 'fingerprint mismatch',
      mutate: (record) => { record.fingerprint = 'SHA256:wrong'; },
      error: /fingerprint mismatch/,
    },
    {
      name: 'non-canonical createdAt',
      mutate: (record) => { record.createdAt = '2020-01-01'; },
      error: /invalid createdAt/,
    },
    {
      name: 'generated record carries reused path',
      mutate: (record) => { record.path = '/not-a-secret-path'; },
      error: /unexpected reused path/,
    },
  ];
  for (const c of cases) {
    const home = freshHome();
    const m = new PrincipalKeyManager({ env: {}, backend: 'file', runner: makeFakeRunner().runner, homeDir: home });
    const record = JSON.parse(validGeneratedRecord()) as Record<string, unknown>;
    c.mutate(record);
    const keys = join(home, '.owenloop', 'keys');
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, `${keyRefHash(REF)}.json`), JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(m.inspect(REF), (e: Error) => {
      assert.match(e.message, c.error, c.name);
      return true;
    });
  }

  const reusedHome = freshHome();
  const reusedManager = new PrincipalKeyManager({ env: {}, backend: 'file', runner: makeFakeRunner().runner, homeDir: reusedHome });
  const reused = JSON.parse(validGeneratedRecord()) as Record<string, unknown>;
  reused.kind = 'reused';
  reused.path = '/not-a-secret-path';
  const reusedKeys = join(reusedHome, '.owenloop', 'keys');
  mkdirSync(reusedKeys, { recursive: true });
  writeFileSync(join(reusedKeys, `${keyRefHash(REF)}.json`), JSON.stringify(reused), { mode: 0o600 });
  await assert.rejects(reusedManager.inspect(REF), /reused record contains key material/);

  const alternate = syntheticEd25519PublicKey(0x42, 'alternate');
  const mismatchHome = freshHome();
  const mismatchManager = new PrincipalKeyManager({
    env: {},
    backend: 'file',
    runner: makeFakeRunner({ derivedPubText: FIXTURE_PUB }).runner,
    homeDir: mismatchHome,
  });
  const mismatch = JSON.parse(validGeneratedRecord()) as Record<string, unknown>;
  mismatch.publicKey = alternate;
  mismatch.fingerprint = publicKeyDescriptor(alternate).keyid;
  const mismatchKeys = join(mismatchHome, '.owenloop', 'keys');
  mkdirSync(mismatchKeys, { recursive: true });
  writeFileSync(join(mismatchKeys, `${keyRefHash(REF)}.json`), JSON.stringify(mismatch), { mode: 0o600 });
  await assert.rejects(mismatchManager.inspect(REF), /private\/public key mismatch/);
});

// ---- reuse rules --------------------------------------------------------------------

test('reuse: human-only — machine/agent refs reject --reuse-ssh-key before any storage', async () => {
  const home = freshHome();
  const { runner } = makeFakeRunner();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', runner, homeDir: home });
  const candidate = join(home, 'candidate');
  writeFileSync(candidate, 'candidate-bytes\n', { mode: 0o600 });
  writeFileSync(`${candidate}.pub`, FIXTURE_PUB);
  for (const kind of ['machine', 'agent'] as const) {
    await assert.rejects(
      m.ensure({ origin: REF.origin, kind, id: 'x' }, { reuse: { path: candidate } }),
      /explicit SSH key reuse applies only to the human principal key/,
    );
  }
});

test('reuse: an existing key + reuse request is a hard conflict (rotation is not part of WP-A2)', { skip: SKIP }, async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  await m.ensure(REF);
  const candidate = join(home, 'candidate');
  writeFileSync(candidate, 'candidate-bytes\n', { mode: 0o600 });
  writeFileSync(`${candidate}.pub`, FIXTURE_PUB);
  await assert.rejects(m.ensure(REF, { reuse: { path: candidate } }), (e: Error) => {
    assert.ok(e instanceof CliError);
    assert.match(e.message, /already exists/);
    assert.match(e.message, /rotation is not part of WP-A2/);
    return true;
  });
});

test('reuse: the candidate is validated with a sign/verify challenge; only path+pubkey stored (fake runner)', async () => {
  const home = freshHome();
  const { runner, runs } = makeFakeRunner();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', runner, homeDir: home });
  const candidate = join(home, 'my-key');
  writeFileSync(candidate, `${POISON}-candidate\n`, { mode: 0o600 });
  writeFileSync(`${candidate}.pub`, FIXTURE_PUB);

  const res = await m.ensure(REF, { reuse: { path: candidate } });
  assert.equal(res.state, 'reused');
  assert.equal(res.backend, 'reused');

  // The challenge ran: one sign + one verify through ssh-keygen.
  assert.ok(runs.some((r) => r.args[0] === '-Y' && r.args[1] === 'sign' && r.args.includes(realpathSync(candidate))));
  assert.ok(runs.some((r) => r.args[0] === '-Y' && r.args[1] === 'verify'));

  // The stored record has NO privateKey and NO poison — just path + pubkey.
  const rec = JSON.parse(readFileSync(join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.json`), 'utf8'));
  assert.equal(rec.kind, 'reused');
  assert.equal(rec.path, realpathSync(candidate));
  assert.equal(rec.privateKey, undefined);
  assertNoPoison('reused record', JSON.stringify(rec));

  // Reused record → withSigningKey passes the CANONICAL path (no copy).
  let seen: string | undefined;
  await m.withSigningKey(REF, async (p) => {
    seen = p;
  });
  assert.equal(seen, realpathSync(candidate));

  // A missing reused file is a hard error.
  rmSync(candidate);
  await assert.rejects(m.withSigningKey(REF, async () => {}), /reused .* signing key file is missing/);
});

// ---- concurrency ---------------------------------------------------------------------

/** A real spawnSync runner that counts `-t ed25519` generation calls. */
function realCountingRunner(counter: { n: number }): KeyCommandRunner {
  return {
    run(cmd, args, o) {
      if (args.includes('-t') && args.includes('ed25519')) counter.n += 1;
      const stdio: Array<'ignore' | 'pipe' | number> = [
        o.stdin !== undefined ? 'pipe' : 'ignore',
        o.stdoutFd !== undefined ? o.stdoutFd : o.captureStdout ? 'pipe' : 'ignore',
        'ignore',
      ];
      const r = spawnSync(cmd, args, { shell: false, input: o.stdin, stdio, timeout: o.timeoutMs ?? 15_000 });
      const stdout = o.captureStdout && r.stdout !== null && r.stdout !== undefined ? (r.stdout as Buffer) : Buffer.alloc(0);
      return { status: r.status, stdout };
    },
  };
}

test('concurrent ensure: the file lock serializes — exactly one generation', { skip: SKIP }, async () => {
  const home = freshHome();
  const counter = { n: 0 };
  const runner = realCountingRunner(counter);
  const opts = { env: {}, backend: 'file' as const, runner, homeDir: home };
  const m1 = new PrincipalKeyManager(opts);
  const m2 = new PrincipalKeyManager(opts);
  const [r1, r2] = await Promise.all([m1.ensure(REF), m2.ensure(REF)]);
  const states = [r1.state, r2.state].sort();
  assert.deepEqual(states, ['created', 'existing'], 'one creation, one observation');
  assert.equal(counter.n, 1, 'ssh-keygen generation ran exactly once');
});

test('the per-ref lock really blocks: a held lock makes a concurrent ensure wait', { skip: SKIP }, async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  mkdirSync(join(home, '.owenloop', 'keys'), { recursive: true });
  const lockPath = join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.lock`);
  const lock = await acquireFileLock(lockPath, { waitMs: 5_000, label: 'test' });
  let p: Promise<{ state: string }> | null = null;
  try {
    p = m.ensure(REF).then((r) => ({ state: r.state }));
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settled, false, 'ensure waits while another holder has the lock');
  } finally {
    releaseFileLock(lock);
  }
  const first = await p!;
  assert.equal(first.state, 'created');
});

// ---- real ssh-keygen: generation, idempotency, materialization, reuse ------------------

test('real keygen: generate stores a parseable Ed25519 record; re-ensure is zero-write', { skip: SKIP }, async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  const res = await m.ensure(REF);
  assert.equal(res.state, 'created');
  assert.equal(res.publicKey.keyType, 'ssh-ed25519');
  assert.match(res.publicKey.keyid, /^SHA256:/);

  const rec = JSON.parse(readFileSync(join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.json`), 'utf8'));
  assert.equal(rec.kind, 'generated');
  assert.match(rec.privateKey, /BEGIN OPENSSH PRIVATE KEY/, 'the record holds the private key');
  assert.equal(rec.publicKey.trim().split(' ')[0], 'ssh-ed25519');
  assert.equal(rec.fingerprint, res.publicKey.keyid);

  const before = readFileSync(join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.json`), 'utf8');
  const res2 = await m.ensure(REF);
  assert.equal(res2.state, 'existing');
  assert.deepEqual(res2.publicKey, res.publicKey);
  assert.equal(
    readFileSync(join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.json`), 'utf8'),
    before,
    'zero writes on re-ensure',
  );
});

test('real keygen: withSigningKey materializes a 0600 key in a temp dir that is removed afterward', { skip: SKIP }, async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  await m.ensure(REF);
  const observed = await m.withSigningKey(REF, async (p) => {
    const st = statSync(p);
    const obs = {
      path: p,
      mode: st.mode & 0o777,
      dirMode: statSync(dirname(p)).mode & 0o777,
      content: readFileSync(p, 'utf8'),
    };
    // The materialized key is usable by stock ssh-keygen.
    const lf = execFileSync('ssh-keygen', ['-lf', p], { encoding: 'utf8', timeout: 10_000 });
    assert.ok(lf.includes('(ED25519)'));
    return obs;
  });
  assert.equal(observed.mode, 0o600);
  assert.equal(observed.dirMode, 0o700);
  assert.match(observed.content, /BEGIN OPENSSH PRIVATE KEY/);
  assert.ok(!existsSync(observed.path), 'private file removed after the callback');
  assert.ok(!existsSync(dirname(observed.path)), 'temp dir removed after the callback');
});

test('real keygen: withSigningKey on a missing store errors pointing at setup', { skip: SKIP }, async () => {
  const home = freshHome();
  const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
  await assert.rejects(m.withSigningKey(REF, async () => {}), /run owenloop setup/);
});

test('real keygen: reuse stores the canonical path after a live sign/verify challenge', { skip: SKIP }, async () => {
  const home = freshHome();
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-reuse-'));
  try {
    const candidate = join(dir, 'existing_key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'reuse-me', '-f', candidate], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    const m = new PrincipalKeyManager({ env: {}, backend: 'file', homeDir: home });
    const res = await m.ensure(REF, { reuse: { path: candidate } });
    assert.equal(res.state, 'reused');
    assert.equal(res.backend, 'reused');
    const rec = JSON.parse(readFileSync(join(home, '.owenloop', 'keys', `${keyRefHash(REF)}.json`), 'utf8'));
    assert.equal(rec.kind, 'reused');
    assert.equal(rec.path, realpathSync(candidate));
    assert.equal(rec.privateKey, undefined, 'private bytes are NEVER copied for a reused key');
    assert.equal(rec.fingerprint, res.publicKey.keyid);

    // A non-Ed25519 candidate is rejected.
    const ecdsa = join(dir, 'ecdsa_key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-N', '', '-f', ecdsa], { stdio: 'ignore', timeout: 15_000 });
    const ref2: PrincipalKeyRef = { origin: REF.origin, kind: 'human', id: 'user_two' };
    await assert.rejects(m.ensure(ref2, { reuse: { path: ecdsa } }), /only Ed25519 keys are supported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- pure helpers -----------------------------------------------------------------------

test('assertKeyRef validates origin/kind/id; canonicalKeyRef is order-stable for hashing', () => {
  assert.throws(() => assertKeyRef({ origin: '', kind: 'human', id: 'i' }), CliError);
  assert.throws(() => assertKeyRef({ origin: 'o', kind: 'robot' as never, id: 'i' }), CliError);
  assert.throws(() => assertKeyRef({ origin: 'o', kind: 'human', id: ' ' }), CliError);
  assert.doesNotThrow(() => assertKeyRef(REF));

  const a: PrincipalKeyRef = { origin: REF.origin, kind: 'human', id: 'i' };
  const b: PrincipalKeyRef = { id: 'i', origin: REF.origin, kind: 'human' };
  assert.equal(canonicalKeyRef(a), canonicalKeyRef(b));
  assert.equal(keyRefHash(a), keyRefHash(b), 'hash ignores literal insertion order');
});

test('keyidFromBlob matches stock ssh-keygen -lf for the fixture key', { skip: SKIP }, () => {
  const desc = publicKeyDescriptor(FIXTURE_PUB);
  const blob = Buffer.from(FIXTURE_PUB.trim().split(/\s+/)[1]!, 'base64');
  assert.equal(keyidFromBlob(blob), desc.keyid, 'descriptor keyid is the blob fingerprint');
  const lf = execFileSync('ssh-keygen', ['-lf', join(FIXTURES, 'fixture-key.pub')], { encoding: 'utf8' });
  assert.ok(lf.includes(desc.keyid), `stock fingerprint matches ${desc.keyid}`);
});

test('publicKeyDescriptor rejects malformed Base64 instead of silently dropping characters', () => {
  assert.throws(() => publicKeyDescriptor('ssh-ed25519 !!! malformed'), /public key Base64 is malformed/);
  assert.throws(() => publicKeyDescriptor('ssh-ed25519 A=== malformed'), /public key Base64 is malformed/);
});

test('keysDirFor pins the storage layout $HOME/.owenloop/keys', () => {
  assert.equal(keysDirFor('/home/u'), join('/home/u', '.owenloop', 'keys'));
});
