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
function makeFakeRunner(opts: { failLookup?: boolean; failStore?: boolean } = {}): {
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
        return { status: 0, stdout: Buffer.from(FIXTURE_PUB, 'utf8') };
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
        writeFileSync(o.stdoutFd, rec);
        return { status: 0, stdout: Buffer.alloc(0) };
      }
      if (cmd === 'security' && args[0] === '-i') {
        if (opts.failStore) return { status: 1, stdout: Buffer.alloc(0) };
        // The record rides on stdin as a quoted command stream — extract it.
        const text = o.stdin!.toString('utf8');
        const hash = /-a '([0-9a-f]{64})'/.exec(text)![1]!;
        const body = text.slice(text.indexOf("-w '") + 4, text.lastIndexOf("'"));
        store.set(hash, body.replace(/'\\''/g, "'"));
        return { status: 0, stdout: Buffer.alloc(0) };
      }

      // --- Linux secret-tool ---
      if (cmd === 'secret-tool' && args[0] === 'lookup') {
        const hash = args[args.length - 1]!;
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
  const addRun = runs.find((r) => r.cmd === 'security' && r.args[0] === '-i')!;
  assert.ok(addRun.stdin!.toString('utf8').includes(POISON), 'secret rides on child stdin');
  for (const r of runs) {
    for (const a of r.args) assertNoPoison('security argv', a);
  }

  // Lookup redirected stdout to a pre-opened fd, never a pipe.
  const findRun = runs.find((r) => r.cmd === 'security' && r.args[0] === 'find-generic-password')!;
  assert.ok(typeof findRun.stdoutFd === 'number' && findRun.captureStdout === undefined);

  // Idempotent second ensure: no new store write.
  const writesBefore = store.size;
  const res2 = await m.ensure(REF);
  assert.equal(res2.state, 'existing');
  assert.equal(store.size, writesBefore);
  const addRuns = runs.filter((r) => r.cmd === 'security' && r.args[0] === '-i');
  assert.equal(addRuns.length, 1, 'no second write');
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

test('keysDirFor pins the storage layout $HOME/.owenloop/keys', () => {
  assert.equal(keysDirFor('/home/u'), join('/home/u', '.owenloop', 'keys'));
});
