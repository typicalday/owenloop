/**
 * `SshSigner` — SSHSIG sign/verify through stock OpenSSH `ssh-keygen -Y`.
 *
 * Two test layers:
 *
 * 1. INTEROP (real `ssh-keygen`, gated on `-Y` support): module sign → stock
 *    verify, stock sign → module verify, plus the tamper/wrong-namespace/
 *    wrong-principal/wrong-signer/empty/binary miss matrix. Ephemeral Ed25519
 *    keys are generated at test time; their PRIVATE files are deleted in
 *    `finally` — no private key material is ever committed.
 *
 * 2. SECRECY (hermetic, fake `SshProcessAdapter`): asserts the exact argv
 *    shape, that the message rides on child stdin ONLY (a poison marker never
 *    appears in argv), and the fixed failure classifications (timeout →
 *    truncation → signal → exit status). `new SshSigner(...)` is constructed
 *    directly so these tests never touch the host binary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SshSigner,
  SshSignerError,
  assertEd25519PubText,
  createSshSigner,
  probeSshKeygenY,
  resetSshKeygenProbe,
} from '../src/crypto/ssh.ts';
import type { SshProcessAdapter } from '../src/crypto/ssh.ts';
import { DSSE_SSH_NAMESPACE, preAuthEncode } from '../src/crypto/dsse.ts';
import { publicKeyDescriptor } from '../src/crypto/keys.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'crypto');

/** Does this host run a stock `ssh-keygen` that supports `-Y`? */
function sshKeygenWorks(): boolean {
  try {
    execFileSync('ssh-keygen', ['-Y', 'find-principals'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch (e) {
    const err = e as { status?: unknown };
    return typeof err.status === 'number';
  }
}
const SKIP = !sshKeygenWorks() && 'host ssh-keygen lacks -Y support';

/** Generate an ephemeral Ed25519 key in `dir`; the private file is the test's
 *  responsibility to remove (every caller does so in `finally`). */
function makeEphemeralKey(dir: string, name: string): { keyPath: string; pubText: string; keyid: string } {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'owenloop-test', '-f', join(dir, name)], {
    stdio: 'ignore',
    timeout: 15_000,
  });
  const pubText = readFileSync(join(dir, `${name}.pub`), 'utf8');
  const desc = publicKeyDescriptor(pubText);
  return { keyPath: join(dir, name), pubText, keyid: desc.keyid };
}

// ---- interop: module sign → stock verify -------------------------------------

test('interop: module sign verifies under STOCK ssh-keygen (and the keyid matches stock)', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-t-'));
  try {
    const { keyPath, pubText, keyid } = makeEphemeralKey(dir, 'signer');
    const signer = createSshSigner({ namespace: 'owenloop-test-ns', signKeyPath: keyPath });
    const message = Buffer.from('POISON-DO-NOT-LEAK interop sign message');
    const { keyid: signKeyid, sig } = await signer.sign(message);
    assert.equal(signKeyid, keyid, 'signer keyid equals the public-key fingerprint');
    assert.match(sig.toString('utf8'), /-----BEGIN SSH SIGNATURE-----/, 'armored output');

    // The stock keyid must equal `ssh-keygen -lf`'s.
    const lf = execFileSync('ssh-keygen', ['-lf', join(dir, 'signer.pub')], { encoding: 'utf8' });
    assert.ok(lf.includes(keyid), `stock fingerprint contains ${keyid}`);

    // Stock verify of the module's signature.
    const allowed = join(dir, 'allowed');
    const sigFile = join(dir, 'out.sig');
    writeFileSync(allowed, `testprincipal ${pubText.trim()}\n`, { mode: 0o600 });
    writeFileSync(sigFile, sig, { mode: 0o600 });
    const out = execFileSync('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', 'testprincipal', '-n', 'owenloop-test-ns', '-s', sigFile], {
      input: message,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    assert.match(out.toString('utf8'), /Good "owenloop-test-ns" signature/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- interop: stock sign → module verify -------------------------------------

test('interop: stock-signed message verifies through the module', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-t-'));
  try {
    const { keyPath, pubText, keyid } = makeEphemeralKey(dir, 'signer');
    const other = makeEphemeralKey(dir, 'other');
    const message = Buffer.from('stock-signed message bytes');
    const armored = execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', keyPath, '-n', 'ns-a'], { input: message, timeout: 10_000 });

    const signer = createSshSigner({
      namespace: 'ns-a',
      verify: { principal: 'alice', allowedSignersText: `alice ${other.pubText.trim()}\nalice ${pubText.trim()}\n` },
    });
    try {
      const res = await signer.verify(message, armored);
      assert.ok(res !== null, 'verification succeeds');
      assert.equal(res!.principal, 'alice');
      assert.equal(res!.format, 'sshsig');
      assert.equal(res!.keyid, keyid, 'verify reports the allowed key fingerprint');
    } finally {
      signer.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- interop: the miss matrix -------------------------------------------------

test('interop miss matrix: tampered message/sig, wrong namespace, wrong principal, wrong signer all return null', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-t-'));
  try {
    const { keyPath, pubText, keyid } = makeEphemeralKey(dir, 'signer');
    const other = makeEphemeralKey(dir, 'other');
    const message = Buffer.from('the message');
    const armored = execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', keyPath, '-n', 'ns-a'], { input: message, timeout: 10_000 });
    void keyid;
    // Tamper INSIDE the armored body (stock ignores anything after the END
    // marker): flip one base64 character of the first body line.
    const tamperedSig = (() => {
      const lines = armored.toString('utf8').split('\n');
      const body = lines[1]!;
      lines[1] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
      return Buffer.from(lines.join('\n'), 'utf8');
    })();

    const mk = (over: { principal?: string; allowed?: string; namespace?: string } = {}) =>
      new SshSigner({
        namespace: over.namespace ?? 'ns-a',
        verify: {
          principal: over.principal ?? 'alice',
          allowedSignersText: over.allowed ?? `alice ${pubText.trim()}\n`,
        },
      });

    const cases: { name: string; signer: SshSigner; msg: Buffer; sig: Buffer }[] = [
      { name: 'tampered message', signer: mk(), msg: Buffer.from('the message!'), sig: armored },
      { name: 'tampered signature', signer: mk(), msg: message, sig: tamperedSig },
      { name: 'wrong namespace', signer: mk({ namespace: 'ns-b' }), msg: message, sig: armored },
      { name: 'wrong principal', signer: mk({ principal: 'bob' }), msg: message, sig: armored },
      { name: 'wrong signer key', signer: mk({ allowed: `alice ${other.pubText.trim()}\n` }), msg: message, sig: armored },
    ];
    for (const c of cases) {
      try {
        const res = await c.signer.verify(c.msg, c.sig);
        assert.equal(res, null, `${c.name} is a normal miss → null (not a throw)`);
      } finally {
        c.signer.dispose();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interop: empty message and binary payload both sign and verify', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-t-'));
  try {
    const { keyPath, pubText } = makeEphemeralKey(dir, 'signer');
    const signer = createSshSigner({
      namespace: 'ns-e',
      signKeyPath: keyPath,
      verify: { principal: 'alice', allowedSignersText: `alice ${pubText.trim()}\n` },
    });
    try {
      for (const message of [Buffer.alloc(0), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]) {
        const { sig } = await signer.sign(message);
        const res = await signer.verify(message, sig);
        assert.ok(res !== null, `round trip for ${message.length}-byte message`);
        assert.equal(res!.principal, 'alice');
      }
    } finally {
      signer.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interop: the committed stock fixture signature verifies through the module (no private key involved)', { skip: SKIP }, async () => {
  const pubText = readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8');
  const message = readFileSync(join(FIXTURES, 'sshsig-hello.txt'));
  const armored = readFileSync(join(FIXTURES, 'sshsig-hello.armored'));
  const signer = new SshSigner({
    namespace: DSSE_SSH_NAMESPACE,
    verify: { principal: 'owenloop-fixture', allowedSignersText: `owenloop-fixture ${pubText.trim()}\n` },
  });
  try {
    const res = await signer.verify(message, armored);
    assert.ok(res !== null, 'the committed fixture signature verifies');
    assert.equal(res!.principal, 'owenloop-fixture');
    assert.equal(res!.keyid, publicKeyDescriptor(pubText).keyid);
  } finally {
    signer.dispose();
  }
});

test('interop: a DSSE PAE signed under the DSSE namespace verifies end to end', { skip: SKIP }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-t-'));
  try {
    const { keyPath, pubText } = makeEphemeralKey(dir, 'signer');
    const signer = createSshSigner({
      namespace: DSSE_SSH_NAMESPACE,
      signKeyPath: keyPath,
      verify: { principal: 'svc', allowedSignersText: `svc ${pubText.trim()}\n` },
    });
    try {
      const pae = preAuthEncode('application/vnd.owenloop.origin.v1+json', Buffer.from('{"origin":"https://hub"}'));
      const { sig } = await signer.sign(pae);
      const res = await signer.verify(pae, sig);
      assert.ok(res !== null);
      // The same PAE under a DIFFERENT namespace must miss.
      const otherNs = new SshSigner({
        namespace: 'other-namespace',
        verify: { principal: 'svc', allowedSignersText: `svc ${pubText.trim()}\n` },
      });
      try {
        assert.equal(await otherNs.verify(pae, sig), null);
      } finally {
        otherNs.dispose();
      }
    } finally {
      signer.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- capability probe -----------------------------------------------------------

test('probe: on a host with a working ssh-keygen, probeSshKeygenY reports ok and caches', { skip: SKIP }, () => {
  resetSshKeygenProbe();
  try {
    const first = probeSshKeygenY();
    assert.equal(first.ok, true);
    const second = probeSshKeygenY();
    assert.strictEqual(second, first, 'cached by identity');
  } finally {
    resetSshKeygenProbe();
  }
});

// ---- hermetic fake-adapter tests -------------------------------------------------

interface FakeCall {
  cmd: string;
  args: string[];
  stdin: Buffer | undefined;
  /** Contents of any temp files the signer wrote, captured synchronously. */
  filesSeen: Record<string, string>;
}

/** A fake adapter recording argv/stdin, scripted to return `next` results in order.
 *  Captures the contents of `-f`/`-s` file arguments while they still exist. */
function fakeAdapter(results: Array<{ status: number | null; stdout?: Buffer; timedOut?: boolean; truncated?: boolean }>): {
  adapter: SshProcessAdapter;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let i = 0;
  const adapter: SshProcessAdapter = {
    async run(cmd, args, opts) {
      const filesSeen: Record<string, string> = {};
      for (let a = 0; a < args.length - 1; a++) {
        if ((args[a] === '-f' || args[a] === '-s') && existsSync(args[a + 1]!)) {
          filesSeen[args[a + 1]!] = readFileSync(args[a + 1]!, 'utf8');
        }
      }
      calls.push({ cmd, args, stdin: opts.stdin, filesSeen });
      if (args[0] === '-y' && args[1] === '-f') {
        return {
          status: 0,
          stdout: readFileSync(join(FIXTURES, 'fixture-key.pub')),
          stderr: Buffer.alloc(0),
          timedOut: false,
          truncated: false,
        };
      }
      const r = results[Math.min(i++, results.length - 1)]!;
      return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: r.timedOut ?? false, truncated: r.truncated ?? false };
    },
  };
  return { adapter, calls };
}

const POISON = 'POISON-SECRET-NEVER-IN-ARGV';

test('fake sign: message rides on stdin only; argv is exactly [-Y sign -f <path> -n <ns>]; no poison in argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-fake-'));
  try {
    // The private path is derived through ssh-keygen -y; adjacent .pub text is not trusted.
    const pubText = readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8');
    const keyPath = join(dir, 'id');
    writeFileSync(`${keyPath}.pub`, pubText, { mode: 0o644 });
    const armored = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';
    const { adapter, calls } = fakeAdapter([{ status: 0, stdout: Buffer.from(armored, 'utf8') }]);
    const signer = new SshSigner({ namespace: 'ns-x', signKeyPath: keyPath, process: adapter });

    const message = Buffer.from(POISON);
    const res = await signer.sign(message);
    assert.equal(res.keyid, publicKeyDescriptor(pubText).keyid);
    assert.equal(res.sig.toString('utf8'), armored);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.args, ['-y', '-f', keyPath]);
    assert.deepEqual(calls[1]!.args, ['-Y', 'sign', '-f', keyPath, '-n', 'ns-x']);
    assert.ok(calls[1]!.stdin!.equals(message), 'the message arrives on child stdin');
    for (const call of calls) {
      for (const arg of call.args) {
        assert.ok(!arg.includes(POISON), `argv carries no poison: ${arg}`);
        assert.ok(!arg.includes(pubText.trim()), 'argv carries no key text');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fake sign: a non-armored stdout is a fixed SshSignerError (never the child output)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-fake-'));
  try {
    const keyPath = join(dir, 'id');
    writeFileSync(`${keyPath}.pub`, readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8'));
    const { adapter } = fakeAdapter([{ status: 0, stdout: Buffer.from('something went wrong: internal detail\n') }]);
    const signer = new SshSigner({ namespace: 'ns-x', signKeyPath: keyPath, process: adapter });
    await assert.rejects(signer.sign(Buffer.from('m')), (e: Error) => {
      assert.ok(e instanceof SshSignerError);
      assert.match(e.message, /no armored signature produced/);
      assert.ok(!e.message.includes('internal detail'), 'child output never reaches the message');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fake sign: classification order — timeout beats exit status; exit status reported fixedly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ssh-fake-'));
  try {
    const keyPath = join(dir, 'id');
    writeFileSync(`${keyPath}.pub`, readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8'));
    const mkSigner = (adapter: SshProcessAdapter) => new SshSigner({ namespace: 'n', signKeyPath: keyPath, process: adapter });

    // timeout + nonzero status → timeout wins
    await assert.rejects(mkSigner(fakeAdapter([{ status: 255, timedOut: true }]).adapter).sign(Buffer.from('m')), /timed out/);
    // truncation beats exit status
    await assert.rejects(mkSigner(fakeAdapter([{ status: 1, truncated: true }]).adapter).sign(Buffer.from('m')), /output exceeded the cap/);
    // signal death (status null) beats nothing else
    await assert.rejects(mkSigner(fakeAdapter([{ status: null }]).adapter).sign(Buffer.from('m')), /terminated by signal/);
    // plain nonzero exit
    await assert.rejects(
      mkSigner(fakeAdapter([{ status: 255, stdout: Buffer.from('leak-me stderr text') }]).adapter).sign(Buffer.from('m')),
      (e: Error) => {
        assert.match(e.message, /exited with status 255/);
        assert.ok(!e.message.includes('leak-me'), 'no child output in the fixed diagnostic');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fake sign: unconfigured signer throws a fixed error', async () => {
  const signer = new SshSigner({ namespace: 'n', process: fakeAdapter([]).adapter });
  await assert.rejects(signer.sign(Buffer.from('m')), /not configured for signing/);
});

test('fake verify: temp sig + allowed_signers files carry the exact bytes; argv uses -I principal and -n namespace', async () => {
  const pubText = readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8');
  const allowedText = `alice ${pubText.trim()}\n`;
  const { adapter, calls } = fakeAdapter([{ status: 0 }]);
  let tempDirMade: string | null = null;
  const signer = new SshSigner({
    namespace: 'ns-v',
    verify: { principal: 'alice', allowedSignersText: allowedText },
    process: adapter,
    tempDir: () => {
      tempDirMade = mkdtempSync(join(tmpdir(), 'owenloop-sshsig-inj-'));
      return tempDirMade;
    },
  });
  try {
    const message = Buffer.from(POISON);
    const sig = readFileSync(join(FIXTURES, 'sshsig-hello.armored'));
    const res = await signer.verify(message, sig);
    assert.ok(res !== null);
    assert.equal(res!.principal, 'alice');
    assert.equal(res!.keyid, publicKeyDescriptor(pubText).keyid, 'keyid from the verified SSHSIG public key');

    assert.equal(calls.length, 1);
    const args = calls[0]!.args;
    assert.equal(args[0], '-Y');
    assert.equal(args[1], 'verify');
    const fIdx = args.indexOf('-f');
    const iIdx = args.indexOf('-I');
    const nIdx = args.indexOf('-n');
    const sIdx = args.indexOf('-s');
    assert.equal(args[iIdx + 1], 'alice');
    assert.equal(args[nIdx + 1], 'ns-v');
    // The temp files, captured while they existed, carry the exact bytes.
    assert.equal(calls[0]!.filesSeen[args[fIdx + 1]!], allowedText, 'allowed_signers temp file = configured text');
    assert.equal(calls[0]!.filesSeen[args[sIdx + 1]!], sig.toString('utf8'), 'sig temp file = the armored signature');
    assert.ok(calls[0]!.stdin!.equals(message), 'message on stdin');
    for (const arg of args) assert.ok(!arg.includes(POISON), 'no poison in argv');
  } finally {
    signer.dispose();
    assert.ok(tempDirMade !== null && !existsSync(tempDirMade), 'dispose removes the injected temp dir');
  }
});

test('fake verify: normal miss (nonzero exit) → null; signal death → throw; unconfigured → throw', async () => {
  const allowedText = `alice ${readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8').trim()}\n`;
  {
    const { adapter } = fakeAdapter([{ status: 255 }]);
    const signer = new SshSigner({ namespace: 'n', verify: { principal: 'alice', allowedSignersText: allowedText }, process: adapter });
    try {
      assert.equal(await signer.verify(Buffer.from('m'), Buffer.from('s')), null, 'exit 255 is a normal miss');
    } finally {
      signer.dispose();
    }
  }
  {
    const { adapter } = fakeAdapter([{ status: null }]);
    const signer = new SshSigner({ namespace: 'n', verify: { principal: 'alice', allowedSignersText: allowedText }, process: adapter });
    try {
      await assert.rejects(signer.verify(Buffer.from('m'), Buffer.from('s')), /terminated by signal/);
    } finally {
      signer.dispose();
    }
  }
  {
    const signer = new SshSigner({ namespace: 'n', process: fakeAdapter([]).adapter });
    await assert.rejects(signer.verify(Buffer.from('m'), Buffer.from('s')), /not configured for verification/);
  }
});

test('constructor: an empty namespace is rejected', () => {
  assert.throws(() => new SshSigner({ namespace: '' }), /namespace must not be empty/);
});

// ---- Ed25519-only gate -----------------------------------------------------------

test('assertEd25519PubText accepts Ed25519 and rejects everything else with the label', () => {
  assert.doesNotThrow(() => assertEd25519PubText(readFileSync(join(FIXTURES, 'fixture-key.pub'), 'utf8'), 'candidate'));
  assert.throws(() => assertEd25519PubText('ssh-rsa AAAAB3 comment', 'candidate'), /candidate: only Ed25519 keys are supported/);
  assert.throws(() => assertEd25519PubText('', 'candidate'), /candidate: only Ed25519 keys are supported/);
});
