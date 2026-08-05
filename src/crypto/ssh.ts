/**
 * SSHSIG signing/verification through stock OpenSSH, behind one async
 * `Signer` interface.
 *
 * **Why stock OpenSSH (and not a pure-JS SSHSIG implementation):** invoking
 * `ssh-keygen -Y sign` / `ssh-keygen -Y verify` gives byte-level
 * interoperability with the system verifier, adds no cryptographic
 * parser/encoder dependency, and delegates SSHSIG format and `allowed_signers`
 * policy semantics to maintained OpenSSH code. The portability cost is an
 * external runtime requirement: `ssh-keygen` must support `-Y`. Support is
 * PROBED (a harmless capability invocation), never inferred from a version
 * string; when unavailable the probe result is an actionable error.
 *
 * **Secrecy discipline.** Private key material never appears in argv, captured
 * stdout/stderr, thrown messages, or logs:
 *   - every invocation is `shell: false` (argv is a vector, never a shell line);
 *   - the message bytes ride on child stdin; the private key rides only as a
 *     `-f <path>` argument (a PATH — never the key contents);
 *   - child stdout/stderr is captured only where it is public by nature (the
 *     armored SSH signature; verification status). A verification failure
 *     throws a FIXED diagnostic that never interpolates child output.
 *
 * **Signer semantics.** `verify` returns a `VerifiedSignature` descriptor on a
 * successful OpenSSH verification against the configured principal +
 * `allowed_signers` content, or `null` on a normal verification miss. A
 * tool/configuration failure (no binary, missing `-Y` support, timeout,
 * oversized output) THROWS — a miss and a broken toolchain are different
 * facts. Authorization is decided by OpenSSH itself; a signature's `keyid`
 * (candidate hint) is never treated as identity.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllowedSigners } from './allowed-signers.ts';

/** The result of signing: which key signed (`keyid`) and the signature bytes. */
export interface DetachedSignature {
  /** The signer's keyid (the `SHA256:<b64>` public-key fingerprint). */
  keyid: string;
  /**
   * The signature bytes. For the SSH signer this is the ARMORED SSH signature
   * text (`-----BEGIN SSH SIGNATURE-----` …) as UTF-8 bytes — the armored form
   * is what OpenSSH consumes and emits, and it is public information.
   */
  sig: Buffer;
}

/** Describes a signature that verified — non-secret public descriptors only. */
export interface VerifiedSignature {
  /** The verified signer's keyid (fingerprint of the verifying public key). */
  keyid: string;
  /** The SSH principal (signer identity) OpenSSH matched in allowed_signers. */
  principal: string;
  /** The format that produced the signature, e.g. `'sshsig'`. */
  format: 'sshsig';
}

/**
 * The async, format-neutral signer contract. DSSE depends only on this
 * interface, so a future Sigstore signer can implement the same contract
 * without changing DSSE. `sign` produces a detached signature over EXACT
 * bytes; `verify` returns the verified descriptor or `null` on a normal miss
 * (tool failures throw).
 */
export interface Signer {
  sign(exactBytes: Buffer): Promise<DetachedSignature>;
  verify(exactBytes: Buffer, signature: Buffer): Promise<VerifiedSignature | null>;
}

/** The SSH signer's configuration. */
export interface SshSignerConfig {
  /** The SSHSIG namespace (the `-n` domain string). Required. */
  namespace: string;
  /**
   * Signing key handle — a filesystem path to a PRIVATE key (or to a public
   * key whose private half is reachable through ssh-agent). Present ⇒ this
   * signer can sign; absent ⇒ verify-only.
   */
  signKeyPath?: string;
  /**
   * Verification context: the expected signer principal (`-I`) and the raw
   * `allowed_signers` file content. Present ⇒ this signer can verify.
   */
  verify?: { principal: string; allowedSignersText: string };
  /** Injectable process adapter (hermetic tests). */
  process?: SshProcessAdapter;
  /** Injectable temp-dir factory (hermetic tests). */
  tempDir?: (prefix: string) => string;
  /** Per-invocation timeout in ms (default 10s). */
  timeoutMs?: number;
}

/**
 * The minimal process seam the SSH signer needs. Defaults to a `spawn` wrapper
 * (`shell: false`, never inherits stdio); tests inject a fake to assert argv
 * and stdin secrecy without a real `ssh-keygen`.
 */
export interface SshProcessAdapter {
  run(cmd: string, args: string[], opts: { stdin?: Buffer; timeoutMs: number; maxBuffer?: number }): Promise<{
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
    timedOut: boolean;
    truncated: boolean;
  }>;
  /** Synchronous, non-secret feature probe used by createSshSigner. */
  probe?(cmd: string, args: string[], opts: { timeoutMs: number }): {
    status: number | null;
    stderr: Buffer;
    errorCode?: string;
    timedOut?: boolean;
  };
}

/** Thrown for SSHSIG tool/configuration failures. Message is fixed, non-secret. */
export class SshSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshSignerError';
  }
}

/** Default per-invocation timeout. */
const SSH_DEFAULT_TIMEOUT_MS = 10_000;
/** Cap on captured child output (signatures and status lines are small). */
const SSH_MAX_BUFFER = 1024 * 256;

/** The default `spawn`-based adapter: `shell: false`, captured stdio, timeout + output cap. */
export const defaultSshProcess: SshProcessAdapter = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outLen = 0;
      let errLen = 0;
      let truncated = false;
      let timedOut = false;
      const cap = opts.maxBuffer ?? SSH_MAX_BUFFER;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
      child.stdout.on('data', (c: Buffer) => {
        outLen += c.length;
        if (outLen <= cap) stdout.push(c);
        else truncated = true;
      });
      child.stderr.on('data', (c: Buffer) => {
        errLen += c.length;
        if (errLen <= cap) stderr.push(c);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, truncated: false });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          status: code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          timedOut,
          truncated,
        });
      });
      if (opts.stdin && opts.stdin.length > 0) child.stdin.write(opts.stdin);
      child.stdin.end();
    });
  },
  probe(cmd, args, opts) {
    const result = spawnSync(cmd, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: opts.timeoutMs,
      maxBuffer: SSH_MAX_BUFFER,
    });
    const err = result.error as NodeJS.ErrnoException | undefined;
    return {
      status: result.status,
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
      errorCode: err?.code,
      timedOut: err?.code === 'ETIMEDOUT',
    };
  },
};

/**
 * Probe whether the system `ssh-keygen` supports the feature-specific `-Y`
 * command group. The probe is routed through the injected process adapter so
 * tests cannot accidentally execute the host toolchain. A supported command is
 * allowed to return a normal nonzero policy/input status; only an unknown option,
 * missing executable, timeout, or signal failure means the feature is absent.
 */
let sshCapability: { ok: boolean; detail: string } | null = null;
export function probeSshKeygenY(adapter?: SshProcessAdapter, tempDir?: (prefix: string) => string): { ok: boolean; detail: string } {
  if (sshCapability !== null) return sshCapability;
  const makeDir = tempDir ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
  const proc = adapter ?? defaultSshProcess;
  if (proc.probe === undefined) {
    return (sshCapability = { ok: false, detail: 'ssh-keygen capability probe is unavailable' });
  }
  const dir = makeDir('owenloop-sshprobe-');
  try {
    const allowed = join(dir, 'allowed_signers');
    writeFileSync(allowed, '');
    const result = proc.probe('ssh-keygen', ['-Y', 'find-principals', '-f', allowed, '-s', allowed], {
      timeoutMs: SSH_DEFAULT_TIMEOUT_MS,
    });
    const diagnostics = result.stderr.toString('utf8');
    if (result.timedOut || result.errorCode === 'ETIMEDOUT') {
      return (sshCapability = { ok: false, detail: 'ssh-keygen capability probe timed out' });
    }
    if (result.errorCode === 'ENOENT') {
      return (sshCapability = { ok: false, detail: 'ssh-keygen is not available (ENOENT)' });
    }
    if (result.status === null) {
      return (sshCapability = { ok: false, detail: 'ssh-keygen capability probe terminated by signal' });
    }
    if (/unknown option|illegal option|unrecognized option/i.test(diagnostics)) {
      return (sshCapability = { ok: false, detail: 'ssh-keygen does not support -Y (OpenSSH >= 8.1 required)' });
    }
    return (sshCapability = { ok: true, detail: 'ssh-keygen supports -Y' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reset the cached capability (tests only). */
export function resetSshKeygenProbe(): void {
  sshCapability = null;
}

/**
 * Run one `ssh-keygen` invocation through the adapter with fixed failure
 * classification, in the plan's order: timeout, output-cap, exit-status,
 * signal. Child output NEVER reaches the thrown message.
 */
function classify(r: { status: number | null; stdout: Buffer; stderr: Buffer; timedOut: boolean; truncated: boolean }, what: string): void {
  if (r.timedOut) throw new SshSignerError(`${what}: timed out`);
  if (r.truncated) throw new SshSignerError(`${what}: output exceeded the cap`);
  if (r.status === null) throw new SshSignerError(`${what}: child terminated by signal`);
  if (r.status !== 0) throw new SshSignerError(`${what}: exited with status ${r.status}`);
}

/**
 * The OpenSSH SSHSIG signer. Construct via `createSshSigner`. Signing and
 * verification are separate capabilities configured at construction; using an
 * unconfigured capability throws a fixed `SshSignerError`.
 */
export class SshSigner implements Signer {
  private readonly config: SshSignerConfig;
  private readonly proc: SshProcessAdapter;
  private readonly makeTempDir: (prefix: string) => string;
  /** The verification temp dir (created lazily), removed in `dispose`. */
  private verifyDir: string | null = null;

  constructor(config: SshSignerConfig) {
    if (config.namespace === '') throw new SshSignerError('the SSHSIG namespace must not be empty');
    this.config = config;
    this.proc = config.process ?? defaultSshProcess;
    this.makeTempDir = config.tempDir ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix)));
  }

  /**
   * Sign `exactBytes` by placing the private key path in `-f`, the configured
   * namespace in `-n`, and the message on stdin. The armored SSH signature is
   * captured from stdout (public information). Payload and private bytes never
   * appear in argv.
   */
  async sign(exactBytes: Buffer): Promise<DetachedSignature> {
    const keyPath = this.config.signKeyPath;
    if (keyPath === undefined) {
      throw new SshSignerError('this signer is not configured for signing (no signKeyPath)');
    }
    const publicText = await publicTextForSigningPath(keyPath, this.proc, this.config.timeoutMs ?? SSH_DEFAULT_TIMEOUT_MS);
    assertEd25519PubText(publicText, 'signing key');
    const keyid = fingerprintForPubText(publicText);
    const r = await this.proc.run(
      'ssh-keygen',
      ['-Y', 'sign', '-f', keyPath, '-n', this.config.namespace],
      { stdin: exactBytes, timeoutMs: this.config.timeoutMs ?? SSH_DEFAULT_TIMEOUT_MS },
    );
    classify(r, 'sshsig sign');
    const armored = r.stdout.toString('utf8');
    if (!armored.includes('-----BEGIN SSH SIGNATURE-----')) {
      throw new SshSignerError('sshsig sign: no armored signature produced');
    }
    return { keyid, sig: Buffer.from(armored, 'utf8') };
  }

  /**
   * Verify `exactBytes` against a detached armored signature. Writes the
   * armored signature and the raw `allowed_signers` text to temporary
   * NON-SECRET files, passes the expected principal with `-I`, the namespace
   * with `-n`, and the message on stdin.
   *
   * Zero exit ⇒ valid: returns `{ keyid, principal, format: 'sshsig' }`.
   * A normal verification miss ⇒ `null`. Tool/configuration failures throw a
   * fixed diagnostic that includes no child output.
   */
  async verify(exactBytes: Buffer, signature: Buffer): Promise<VerifiedSignature | null> {
    const ctx = this.config.verify;
    if (ctx === undefined) {
      throw new SshSignerError('this signer is not configured for verification (no principal/allowedSignersText)');
    }
    const policy = parseAllowedSigners(ctx.allowedSignersText);
    if (policy.errors.length > 0 || policy.entries.length === 0) {
      throw new SshSignerError('sshsig verify: malformed allowed_signers policy');
    }
    if (policy.entries.some((entry) => entry.keyType !== 'ssh-ed25519')) {
      throw new SshSignerError('sshsig verify: only Ed25519 allowed_signers keys are supported');
    }
    if (this.verifyDir === null) {
      this.verifyDir = this.makeTempDir('owenloop-sshsig-');
      chmodSync(this.verifyDir, 0o700);
    }
    const sigPath = join(this.verifyDir, `sig-${Math.random().toString(36).slice(2)}.armored`);
    const allowedPath = join(this.verifyDir, `allowed-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(sigPath, signature, { mode: 0o600 });
    // Preserve the accepted policy text byte-for-byte for stock OpenSSH.
    writeFileSync(allowedPath, ctx.allowedSignersText, { mode: 0o600 });
    try {
      const r = await this.proc.run(
        'ssh-keygen',
        [
          '-Y', 'verify',
          '-f', allowedPath,
          '-I', ctx.principal,
          '-n', this.config.namespace,
          '-s', sigPath,
        ],
        { stdin: exactBytes, timeoutMs: this.config.timeoutMs ?? SSH_DEFAULT_TIMEOUT_MS },
      );
      if (r.timedOut) throw new SshSignerError('sshsig verify: timed out');
      if (r.truncated) throw new SshSignerError('sshsig verify: output exceeded the cap');
      if (r.status === 0) {
        try {
          const keyid = fingerprintForSshsigPublicKey(signature);
          return { keyid, principal: ctx.principal, format: 'sshsig' };
        } catch {
          throw new SshSignerError('sshsig verify: verified signature has no valid Ed25519 public key');
        }
      }
      if (r.status === 255 && isCryptographicMiss(r.stdout, r.stderr)) return null;
      if (r.status !== null) throw new SshSignerError(`sshsig verify: exited with status ${r.status}`);
      throw new SshSignerError('sshsig verify: child terminated by signal');
    } finally {
      rmSync(sigPath, { force: true });
      rmSync(allowedPath, { force: true });
    }
  }

  /** Remove the verification temp dir. */
  dispose(): void {
    if (this.verifyDir !== null) {
      rmSync(this.verifyDir, { recursive: true, force: true });
      this.verifyDir = null;
    }
  }

}

/** Read the actual public half for a signing path. Private paths are derived
 * through stock ssh-keygen; adjacent `.pub` text is never trusted for them. */
async function publicTextForSigningPath(keyPath: string, proc: SshProcessAdapter, timeoutMs: number): Promise<string> {
  try {
    const text = readFileSync(keyPath, 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
    if (/^(?:ssh-|ecdsa-|sk-)/.test(line)) return text;
  } catch {
    // Derivation below reports a fixed error.
  }
  const result = await proc.run('ssh-keygen', ['-y', '-f', keyPath], { timeoutMs });
  classify(result, 'sshsig public-key derivation');
  return result.stdout.toString('utf8');
}

function fingerprintForPubText(pubText: string): string {
  const line = pubText.split(/\r?\n/).find((l) => l.trim() !== '');
  if (line === undefined) throw new SshSignerError('public key file is empty');
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) throw new SshSignerError('public key line is malformed');
  assertEd25519PubText(pubText, 'public key');
  return fingerprintFromBase64(parts[1]!);
}

function fingerprintFromBase64(b64: string): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new SshSignerError('public key Base64 is malformed');
  }
  const body = b64.replace(/=+$/, '');
  const expectedPad = body.length % 4 === 0 ? 0 : 4 - (body.length % 4);
  if (b64.length - body.length !== expectedPad) throw new SshSignerError('public key Base64 is malformed');
  const blob = Buffer.from(b64, 'base64');
  if (blob.length === 0) throw new SshSignerError('public key blob is empty');
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** Extract the embedded public-key field from a verified SSHSIG armor. */
function fingerprintForSshsigPublicKey(armored: Buffer): string {
  const text = armored.toString('utf8');
  const begin = '-----BEGIN SSH SIGNATURE-----';
  const end = '-----END SSH SIGNATURE-----';
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (start < 0 || finish <= start) throw new Error('malformed armor');
  const body = text.slice(start + begin.length, finish).replace(/[\r\n]/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 === 1) throw new Error('malformed armor');
  const raw = Buffer.from(body, 'base64');
  let offset = 0;
  const take = (label: string): Buffer => {
    if (offset + 4 > raw.length) throw new Error(`missing ${label}`);
    const length = raw.readUInt32BE(offset);
    offset += 4;
    if (length > raw.length - offset) throw new Error(`bad ${label} length`);
    const value = raw.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  if (raw.subarray(0, 6).toString('ascii') !== 'SSHSIG') throw new Error('bad magic');
  offset = 6;
  if (offset + 4 > raw.length || raw.readUInt32BE(offset) !== 1) throw new Error('unsupported SSHSIG version');
  offset += 4;
  const publicKeyField = take('public key');
  const keyType = (() => {
    let p = 0;
    if (publicKeyField.length < 4) throw new Error('bad public key');
    const n = publicKeyField.readUInt32BE(p);
    p += 4;
    if (n > publicKeyField.length - p) throw new Error('bad key type length');
    return publicKeyField.subarray(p, p + n).toString('ascii');
  })();
  if (keyType !== 'ssh-ed25519') throw new Error('non-Ed25519 public key');
  return `SHA256:${createHash('sha256').update(publicKeyField).digest('base64').replace(/=+$/, '')}`;
}

function isCryptographicMiss(stdout: Buffer, stderr: Buffer): boolean {
  const diagnostics = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`;
  return stdout.length === 0 && stderr.length === 0 || /could not verify signature|namespace does not match/i.test(diagnostics);
}

/**
 * Create an `SshSigner` from a config. Verifies the capability probe once
 * (cached for the process lifetime) and throws an actionable error when the
 * system `ssh-keygen` lacks `-Y`.
 */
export function createSshSigner(config: SshSignerConfig): SshSigner {
  const cap = probeSshKeygenY(config.process, config.tempDir);
  if (!cap.ok) throw new SshSignerError(cap.detail);
  return new SshSigner(config);
}

/**
 * Validate that a candidate SSH key is Ed25519 by reading its public key text
 * (private bytes are never read). Throws a fixed error for non-Ed25519 keys —
 * WP-A2 rejects them even though `allowed_signers` can represent other stock
 * key types.
 */
export function assertEd25519PubText(pubText: string, label: string): void {
  const line = pubText.split(/\r?\n/).find((l) => l.trim() !== '');
  const keyType = line?.trim().split(/\s+/)[0];
  if (keyType !== 'ssh-ed25519') {
    throw new SshSignerError(`${label}: only Ed25519 keys are supported in WP-A2 (found ${keyType ?? 'no key type'})`);
  }
}
