/**
 * Principal signing-key management: generate, store, and materialize Ed25519
 * keys for owenloop's three local principals (human, machine, agent).
 *
 * **Key handles are namespaced by `{ origin, kind, id }`** — the normalized
 * hub origin plus a stable principal identity:
 *   - human:   `id` = the hub actor id (`whoami.actor.id`)
 *   - machine: `id` = `"local"` (the local store already supplies host scope;
 *              origin prevents cross-hub collision and linkability)
 *   - agent:   `id` = the agent identity id (`agentId`)
 * Rekeying an existing agent credential retains the agent's signing key (the
 * `agentId` is unchanged); minting a new agent gets a new key.
 *
 * **One selected backend, chosen once, never error-fallback** (REL-6 — a
 * fallback after a selected store fails can create two different private keys
 * for the same principal, a "shadow identity"):
 *   1. macOS: `security` generic-password entries;
 *   2. Linux: `secret-tool` when the executable is on `PATH`;
 *   3. otherwise: one atomic `0600` record file under `$HOME/.owenloop/keys/`
 *      (both `$HOME/.owenloop` and `keys` forced to `0700`, symlinked or
 *      non-directory paths refused).
 * `OWENLOOP_NO_KEYCHAIN=1` forces the file backend — the same explicit
 * override the credential store uses.
 *
 * **Private bytes never leave the store.** `security`/`secret-tool` receive
 * records on child stdin, and their lookup commands' secret-bearing stdout is
 * redirected directly to a pre-opened `0600` temp file descriptor — never
 * captured, inherited, logged, or interpolated into an error message. Child
 * failures produce fixed operation/status messages. A generated key
 * materializes for `ssh-keygen` only inside a unique `0700` temp dir as a
 * `0600` file, removed in `finally`; a reused key passes only its canonical
 * path. No public API hands a caller private-key text.
 *
 * `ensure` is serialized per key ref by the repo's file lock
 * (`$HOME/.owenloop/keys/<hash>.lock`): acquire → re-read → generate only when
 * still absent. A corrupt/unreadable existing key is a hard failure, never a
 * silent rotation.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { acquireFileLock, releaseFileLock } from '../lock.ts';
import type { FileLockHandle } from '../lock.ts';
import { normalizeOrigin, writeFileAtomic } from '../hub.ts';
import { assertEd25519PubText } from './ssh.ts';
import { CliError } from '../util.ts';

/** The three local principal kinds. */
export type PrincipalKind = 'human' | 'machine' | 'agent';

/**
 * The stable identity of one local signing key: the normalized hub origin +
 * principal kind + stable principal id (see the module doc).
 */
export interface PrincipalKeyRef {
  origin: string;
  kind: PrincipalKind;
  id: string;
}

/** Non-secret public-key descriptors. Never carries private material. */
export interface PublicKeyDescriptor {
  /** The `SHA256:<unpadded-base64>` fingerprint of the public-key blob. */
  keyid: string;
  /** The key type, e.g. `ssh-ed25519`. */
  keyType: string;
  /** The full OpenSSH public-key line (`keytype base64 [comment]`). */
  openSshPublicKey: string;
  /** The key's comment (may be empty). */
  comment: string;
}

/** Which backend stored (or would store) a key. */
export type KeyStorageBackendKind = 'macos-security' | 'secret-tool' | 'file';

/** The result of `ensure`. */
export interface EnsureKeyResult {
  ref: PrincipalKeyRef;
  /** `created` = generated now; `existing` = already present; `reused` = an explicit SSH key recorded. */
  state: 'created' | 'existing' | 'reused';
  /** The backend name, or `reused` for an explicit SSH key. */
  backend: KeyStorageBackendKind | 'reused';
  publicKey: PublicKeyDescriptor;
}

/** The result of `inspect` — non-secret storage state. */
export interface InspectKeyResult {
  exists: boolean;
  source: 'generated' | 'reused' | undefined;
  backend: KeyStorageBackendKind | 'reused' | undefined;
  publicKey: PublicKeyDescriptor | undefined;
}

/**
 * The stored key record. `privateKey` is present ONLY on generated records and
 * never leaves the store through any public API. Reused records carry the
 * canonical path of the user's own key instead — its private bytes are never
 * copied.
 */
interface KeyRecord {
  version: 1;
  ref: PrincipalKeyRef;
  kind: 'generated' | 'reused';
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  privateKey?: string;
  /** Reused keys only: the canonical path to the user's key file. */
  path?: string;
}

/**
 * A minimal child-process seam for the storage commands and `ssh-keygen`.
 * `shell: false` always. The default implementation never captures
 * secret-bearing output: stdout goes to an fd (lookup commands), to the
 * caller when explicitly requested (public data only), or is discarded.
 */
export interface KeyCommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: {
      stdin?: Buffer;
      timeoutMs?: number;
      /** Redirect child stdout into this pre-opened fd (lookup commands). */
      stdoutFd?: number;
      /** Capture stdout (PUBLIC data only — armored signatures, keygen probes). */
      captureStdout?: boolean;
    },
  ): { status: number | null; stdout: Buffer };
}

/** Injection seams for hermetic tests. All optional. */
export interface PrincipalKeyManagerOpts {
  env: Record<string, string | undefined>;
  /** Force a backend (fake-platform tests). */
  backend?: KeyStorageBackendKind;
  /** Force the platform string (`darwin`/`linux`) for selection tests. */
  platform?: NodeJS.Platform;
  /** `secret-tool`-on-PATH probe (defaults to a PATH scan). */
  commandExists?: (cmd: string) => boolean;
  /** Child-process seam (fake storage adapters in tests). */
  runner?: KeyCommandRunner;
  /** Override `$HOME` (defaults to `env.HOME`). */
  homeDir?: string;
  /** Override the OS temp dir for generation/materialization. */
  tempDir?: string;
  /** The ssh-keygen binary (defaults to `ssh-keygen` on PATH). */
  sshKeygen?: string;
}

/** Fixed error for a backend operation. Never includes child output. */
function backendError(backend: string, detail: string): CliError {
  return new CliError(`signing-key storage (${backend}) failed: ${detail}`);
}

/** Canonical, order-stable serialization of a key ref (for hashing). */
export function canonicalKeyRef(ref: PrincipalKeyRef): string {
  assertKeyRef(ref);
  return JSON.stringify({ origin: ref.origin, kind: ref.kind, id: ref.id });
}

/** Validate a key ref shape. Throws a fixed `CliError` on any bad field. */
export function assertKeyRef(ref: PrincipalKeyRef): void {
  if (typeof ref.origin !== 'string' || ref.origin.trim() === '') {
    throw new CliError('signing-key ref: origin must be a non-empty string');
  }
  let normalized: string;
  try {
    normalized = normalizeOrigin(ref.origin);
  } catch {
    throw new CliError('signing-key ref: origin must be a valid normalized http(s) origin');
  }
  if (normalized !== ref.origin) {
    throw new CliError('signing-key ref: origin must be a normalized origin');
  }
  if (ref.kind !== 'human' && ref.kind !== 'machine' && ref.kind !== 'agent') {
    throw new CliError(`signing-key ref: kind must be human, machine, or agent (got '${String(ref.kind)}')`);
  }
  if (typeof ref.id !== 'string' || ref.id.trim() === '') {
    throw new CliError('signing-key ref: id must be a non-empty string');
  }
}

/** The SHA-256 hex of the canonical ref — file name / keychain account. */
export function keyRefHash(ref: PrincipalKeyRef): string {
  return createHash('sha256').update(canonicalKeyRef(ref)).digest('hex');
}

/** Compute the `SHA256:<unpadded-base64>` fingerprint of a public-key blob. */
export function keyidFromBlob(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Decode a standard OpenSSH public-key blob without Node's permissive Base64 rules. */
function decodePublicKeyBlob(text: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 === 1) {
    throw new CliError('public key Base64 is malformed');
  }
  const body = text.replace(/=+$/, '');
  const expectedPadding = body.length % 4 === 0 ? 0 : 4 - (body.length % 4);
  if (text.length - body.length !== expectedPadding) throw new CliError('public key Base64 is malformed');
  const blob = Buffer.from(text, 'base64');
  if (blob.length === 0) throw new CliError('public key blob is empty');
  return blob;
}

/** Parse an OpenSSH public-key line into a descriptor (never reads private bytes). */
export function publicKeyDescriptor(pubText: string): PublicKeyDescriptor {
  const line = pubText.split(/\r?\n/).find((l) => l.trim() !== '');
  if (line === undefined) throw new CliError('public key file is empty');
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) throw new CliError('public key line is malformed');
  const keyType = parts[0]!;
  const blob = decodePublicKeyBlob(parts[1]!);
  const comment = parts.slice(2).join(' ');
  return { keyid: keyidFromBlob(blob), keyType, openSshPublicKey: parts.slice(0, 2).join(' ') + (comment ? ` ${comment}` : ''), comment };
}

const KEYGEN_TIMEOUT_MS = 15_000;

/** The default `spawnSync` runner — `shell: false`, never inherits stdio. */
const defaultRunner: KeyCommandRunner = {
  run(cmd, args, opts) {
    const stdio: Array<'ignore' | 'pipe' | number> = [
      opts.stdin !== undefined ? 'pipe' : 'ignore',
      opts.stdoutFd !== undefined ? opts.stdoutFd : opts.captureStdout ? 'pipe' : 'ignore',
      'ignore',
    ];
    const r = spawnSync(cmd, args, {
      shell: false,
      input: opts.stdin,
      stdio,
      timeout: opts.timeoutMs ?? KEYGEN_TIMEOUT_MS,
    });
    const stdout = opts.captureStdout && r.stdout !== null && r.stdout !== undefined ? (r.stdout as Buffer) : Buffer.alloc(0);
    return { status: r.status, stdout };
  },
};

/**
 * The principal key manager. One backend is selected at construction; all
 * operations use it exclusively (no error-fallback — see the module doc).
 */
export class PrincipalKeyManager {
  private readonly env: Record<string, string | undefined>;
  private readonly backendKind: KeyStorageBackendKind;
  private readonly runner: KeyCommandRunner;
  private readonly homeDir: string;
  private readonly tempBase: string;
  private readonly sshKeygen: string;

  constructor(opts: PrincipalKeyManagerOpts) {
    this.env = opts.env;
    this.runner = opts.runner ?? defaultRunner;
    this.tempBase = opts.tempDir ?? tmpdir();
    this.sshKeygen = opts.sshKeygen ?? 'ssh-keygen';
    const home = opts.homeDir ?? opts.env.HOME;
    if (!home || home.trim() === '') {
      throw new CliError('signing-key storage needs $HOME to be set');
    }
    this.homeDir = home;
    this.backendKind = opts.backend ?? this.selectBackend(opts.platform ?? process.platform, opts.commandExists);
  }

  /** Which backend was selected (non-secret; printable). */
  get backend(): KeyStorageBackendKind {
    return this.backendKind;
  }

  /**
   * Backend selection: `OWENLOOP_NO_KEYCHAIN=1` forces `file`; macOS uses
   * `security`; Linux uses `secret-tool` when present on PATH; everything else
   * falls back to the secure file store.
   */
  private selectBackend(platform: NodeJS.Platform, commandExists?: (cmd: string) => boolean): KeyStorageBackendKind {
    if (this.env.OWENLOOP_NO_KEYCHAIN === '1') return 'file';
    if (platform === 'darwin') return 'macos-security';
    if (platform === 'linux') {
      const probe = commandExists ?? ((cmd: string) => commandOnPath(this.env, cmd));
      return probe('secret-tool') ? 'secret-tool' : 'file';
    }
    return 'file';
  }

  /** `$HOME/.owenloop`. */
  private baseDir(): string {
    return join(this.homeDir, '.owenloop');
  }

  /** `$HOME/.owenloop/keys`. */
  private keysDir(): string {
    return join(this.baseDir(), 'keys');
  }

  /** Force `0700`, refusing symlinked / non-directory paths. */
  private ensureSecureDir(dir: string): void {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (st !== undefined) {
      if (st.isSymbolicLink()) throw new CliError(`refusing to write under ${dir}: it is a symbolic link`);
      if (!st.isDirectory()) throw new CliError(`refusing to write under ${dir}: it is not a directory`);
    } else {
      mkdirSync(dir);
    }
    chmodSync(dir, 0o700);
  }

  /** Ensure both storage dirs exist with the required modes. */
  private ensureDirs(): void {
    this.ensureSecureDir(this.baseDir());
    this.ensureSecureDir(this.keysDir());
  }

  /** The file-backend record path for a ref. */
  private recordPath(ref: PrincipalKeyRef): string {
    return join(this.keysDir(), `${keyRefHash(ref)}.json`);
  }

  /** The per-ref lock path. */
  private lockPath(ref: PrincipalKeyRef): string {
    return join(this.keysDir(), `${keyRefHash(ref)}.lock`);
  }

  /** A non-secret per-ref ownership marker that prevents backend shadowing. */
  private backendMarkerPath(ref: PrincipalKeyRef): string {
    return join(this.keysDir(), `${keyRefHash(ref)}.backend`);
  }

  /** A non-secret pointer that lets offline callers recover the principal ref. */
  private refPointerPath(ref: PrincipalKeyRef): string {
    return join(this.keysDir(), `${keyRefHash(ref)}.ref`);
  }

  private readBackendOwner(ref: PrincipalKeyRef): KeyStorageBackendKind | null {
    const marker = this.backendMarkerPath(ref);
    if (!existsSync(marker)) return null;
    const value = readFileSync(marker, 'utf8').trim();
    if (value !== 'macos-security' && value !== 'secret-tool' && value !== 'file') {
      throw new CliError(`signing-key backend ownership for ${ref.kind}:${ref.id} is corrupt`);
    }
    return value;
  }

  /** Refuse a selected backend that differs from the persisted owner. */
  private assertBackendOwner(ref: PrincipalKeyRef): void {
    const owner = this.readBackendOwner(ref);
    if (owner !== null && owner !== this.backendKind) {
      throw new CliError(
        `signing-key ref ${ref.kind}:${ref.id} belongs to backend ${owner}, not the selected backend ${this.backendKind}`,
      );
    }
    // A pre-marker file record is detectable even when PATH now selects a
    // different backend. Refuse the new backend rather than creating a shadow.
    if (owner === null && this.backendKind !== 'file' && existsSync(this.recordPath(ref))) {
      throw new CliError(
        `signing-key ref ${ref.kind}:${ref.id} has a file-backed record, but the selected backend is ${this.backendKind}`,
      );
    }
  }

  /** Claim ownership before the first write; marker writes are non-secret. */
  private claimBackend(ref: PrincipalKeyRef): void {
    this.assertBackendOwner(ref);
    const marker = this.backendMarkerPath(ref);
    if (!existsSync(marker)) {
      writeFileAtomic(marker, `${this.backendKind}\n`, { mode: 0o600 });
      chmodSync(marker, 0o600);
    }
  }

  // ---- backend read/write ---------------------------------------------------

  /** Read the raw record text from the selected backend, or `null` when absent. */
  private readRecordText(ref: PrincipalKeyRef): string | null {
    this.ensureDirs();
    this.assertBackendOwner(ref);
    const hash = keyRefHash(ref);
    if (this.backendKind === 'file') {
      const path = this.recordPath(ref);
      if (!existsSync(path)) return null;
      const text = readFileSync(path, 'utf8');
      this.claimBackend(ref);
      return text;
    }
    // security / secret-tool: redirect the lookup's secret-bearing stdout to a
    // pre-opened 0600 temp fd; command, read, close, and unlink all share one
    // outer finally so every return and every failure cleans up the temp file.
    const tmpPath = join(this.tempBase, `owenloop-keyread-${randomBytes(8).toString('hex')}`);
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      let r: { status: number | null };
      if (this.backendKind === 'macos-security') {
        // `-w` is what makes `security` print the secret itself; without it
        // stdout carries the item's attribute dump, which is not the record.
        r = this.runner.run('security', ['find-generic-password', '-s', 'owenloop-signing', '-a', hash, '-w'], {
          stdoutFd: fd,
        });
        // 44 = errSecItemNotFound — a clean absence.
        if (r.status === 44) return null;
        if (r.status !== 0) throw backendError('macos-security', `lookup exited with status ${r.status}`);
      } else {
        r = this.runner.run(
          'secret-tool',
          ['lookup', 'owenloop-service', 'owenloop-signing', 'owenloop-ref', hash],
          { stdoutFd: fd },
        );
        // libsecret uses status 1 for an absent item. It is not a backend
        // failure; all other nonzero statuses remain hard failures.
        if (r.status === 1) return null;
        if (r.status !== 0) throw backendError('secret-tool', `lookup exited with status ${r.status}`);
      }
      const text = readFileSync(tmpPath, 'utf8');
      if (text === '') return null;
      this.claimBackend(ref);
      return text;
    } finally {
      try {
        closeSync(fd);
      } finally {
        rmSync(tmpPath, { force: true });
      }
    }
  }

  /** Write the raw record text to the selected backend. Loud failure, fixed message. */
  private writeRecordText(ref: PrincipalKeyRef, recordText: string): void {
    this.ensureDirs();
    this.claimBackend(ref);
    const hash = keyRefHash(ref);
    if (this.backendKind === 'file') {
      writeFileAtomic(this.recordPath(ref), recordText, { mode: 0o600 });
      chmodSync(this.recordPath(ref), 0o600);
      return;
    }
    if (this.backendKind === 'macos-security') {
      // The secret rides on the `-i` command stream's stdin (single-quoted),
      // never on argv. Same escaping as hub.ts's defaultKeychain. `security -i`
      // treats `\` as an escape character even inside single quotes, so
      // backslashes must be doubled FIRST (before quote-escaping inserts its
      // own), or the record's JSON `\n` escapes degrade to bare `n` on store.
      const sq = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, `'\\''`)}'`;
      const cmd = `add-generic-password -U -s ${sq('owenloop-signing')} -a ${sq(hash)} -w ${sq(recordText)}\n`;
      const r = this.runner.run('security', ['-i'], { stdin: Buffer.from(cmd, 'utf8') });
      if (r.status !== 0) throw backendError('macos-security', `store exited with status ${r.status}`);
      return;
    }
    const r = this.runner.run(
      'secret-tool',
      ['store', '--label', `owenloop signing key ${ref.kind}`, 'owenloop-service', 'owenloop-signing', 'owenloop-ref', hash],
      { stdin: Buffer.from(recordText, 'utf8') },
    );
    if (r.status !== 0) throw backendError('secret-tool', `store exited with status ${r.status}`);
  }

  /** Derive a public key from generated private material without exposing it. */
  private deriveGeneratedPublic(privateKey: string): PublicKeyDescriptor {
    const dir = this.mkTempKeyDir();
    try {
      const keyPath = join(dir, 'id');
      writeFileAtomic(keyPath, privateKey, { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      const result = this.runner.run(this.sshKeygen, ['-y', '-f', keyPath], { captureStdout: true });
      if (result.status !== 0) throw new Error('derivation failed');
      const text = result.stdout.toString('utf8');
      const descriptor = publicKeyDescriptor(text);
      assertEd25519PubText(text, 'stored signing key');
      return descriptor;
    } catch {
      throw new CliError('signing-key record is corrupt (private key does not derive a valid Ed25519 public key)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Parse + validate a record against the requested ref. Corrupt = hard error. */
  private parseRecord(ref: PrincipalKeyRef, text: string): KeyRecord {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt — refusing to use or replace it`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt — refusing to use or replace it`);
    }
    const rec = raw as Partial<KeyRecord> & { ref?: Partial<PrincipalKeyRef> };
    if (
      rec.version !== 1 ||
      rec.ref === undefined ||
      rec.ref.origin !== ref.origin ||
      rec.ref.kind !== ref.kind ||
      rec.ref.id !== ref.id
    ) {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} does not match the requested ref — refusing to use it`);
    }
    if (rec.kind !== 'generated' && rec.kind !== 'reused') {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (unknown key kind) — refusing to use it`);
    }
    if (rec.kind === 'generated' && (typeof rec.privateKey !== 'string' || rec.privateKey === '')) {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (missing key material) — refusing to use it`);
    }
    if (rec.kind === 'reused' && (typeof rec.path !== 'string' || rec.path === '')) {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (missing reused path) — refusing to use it`);
    }
    if (typeof rec.publicKey !== 'string' || typeof rec.fingerprint !== 'string' || typeof rec.createdAt !== 'string') {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (invalid record fields) — refusing to use it`);
    }
    let descriptor: PublicKeyDescriptor;
    try {
      descriptor = publicKeyDescriptor(rec.publicKey);
      assertEd25519PubText(rec.publicKey, 'stored signing key');
    } catch {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (invalid Ed25519 public key) — refusing to use it`);
    }
    if (!/^SHA256:[A-Za-z0-9+/]+$/.test(rec.fingerprint) || rec.fingerprint !== descriptor.keyid) {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (fingerprint mismatch) — refusing to use it`);
    }
    try {
      if (new Date(rec.createdAt).toISOString() !== rec.createdAt) throw new Error('not canonical ISO-8601');
    } catch {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (invalid createdAt) — refusing to use it`);
    }
    if (rec.kind === 'generated') {
      if (rec.path !== undefined) {
        throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (unexpected reused path) — refusing to use it`);
      }
      const derived = this.deriveGeneratedPublic(rec.privateKey!);
      if (derived.keyid !== descriptor.keyid) {
        throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (private/public key mismatch) — refusing to use it`);
      }
    } else if (rec.privateKey !== undefined) {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (reused record contains key material) — refusing to use it`);
    }
    return rec as KeyRecord;
  }

  /** Read + validate the stored record for a ref, or `null` when absent. */
  private readRecord(ref: PrincipalKeyRef): KeyRecord | null {
    assertKeyRef(ref);
    const text = this.readRecordText(ref);
    if (text === null) return null;
    return this.parseRecord(ref, text);
  }

  // ---- public API ------------------------------------------------------------

  /**
   * Non-secret inspection: does a key exist for this ref, and what is its
   * public descriptor / source / backend? For generated records, validation
   * temporarily materializes private bytes in a 0600 file so stock ssh-keygen
   * can derive and compare the public half; private bytes never enter the
   * returned result.
   */
  async inspect(ref: PrincipalKeyRef): Promise<InspectKeyResult> {
    assertKeyRef(ref);
    if (this.backendKind === 'file') this.ensureDirs();
    const rec = this.readRecord(ref);
    if (rec === null) return { exists: false, source: undefined, backend: undefined, publicKey: undefined };
    const desc = publicKeyDescriptor(rec.publicKey);
    return {
      exists: true,
      source: rec.kind,
      backend: rec.kind === 'reused' ? 'reused' : this.backendKind,
      publicKey: desc,
    };
  }

  /** Write the non-secret ref pointer with strict file permissions. */
  private writeRefPointer(ref: PrincipalKeyRef): void {
    writeFileAtomic(this.refPointerPath(ref), canonicalKeyRef(ref), { mode: 0o600 });
    chmodSync(this.refPointerPath(ref), 0o600);
  }

  /**
   * List valid non-secret principal-ref pointers. Malformed, symlinked, and
   * mismatched entries are ignored so a stray file cannot block key discovery.
   */
  listRefs(): PrincipalKeyRef[] {
    // Resolution is a read-only discovery operation. Do not create the key
    // store merely because a signed publish is probing for a missing key.
    const base = this.baseDir();
    const baseStat = lstatSync(base, { throwIfNoEntry: false });
    if (baseStat === undefined) return [];
    if (baseStat.isSymbolicLink()) throw new CliError(`refusing to read under ${base}: it is a symbolic link`);
    if (!baseStat.isDirectory()) throw new CliError(`refusing to read under ${base}: it is not a directory`);
    const keys = this.keysDir();
    const keysStat = lstatSync(keys, { throwIfNoEntry: false });
    if (keysStat === undefined) return [];
    if (keysStat.isSymbolicLink()) throw new CliError(`refusing to read under ${keys}: it is a symbolic link`);
    if (!keysStat.isDirectory()) throw new CliError(`refusing to read under ${keys}: it is not a directory`);
    const refs: PrincipalKeyRef[] = [];
    for (const name of readdirSync(keys)) {
      if (!name.endsWith('.ref')) continue;
      const path = join(this.keysDir(), name);
      try {
        const st = lstatSync(path);
        if (!st.isFile()) continue;
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const value = raw as Record<string, unknown>;
        if (typeof value.origin !== 'string' || typeof value.kind !== 'string' || typeof value.id !== 'string') continue;
        const ref = { origin: value.origin, kind: value.kind, id: value.id } as PrincipalKeyRef;
        assertKeyRef(ref);
        if (name !== `${keyRefHash(ref)}.ref` || JSON.stringify(raw) !== canonicalKeyRef(ref)) continue;
        refs.push(ref);
      } catch {
        // A malformed pointer cannot identify a signing key; skip it.
      }
    }
    refs.sort((a, b) => canonicalKeyRef(a).localeCompare(canonicalKeyRef(b)));
    return refs;
  }

  /** Resolve one principal ref by origin and kind for offline signing. */
  resolveRef(origin: string, kind: PrincipalKind): PrincipalKeyRef | null {
    let normalized: string;
    try {
      normalized = normalizeOrigin(origin);
    } catch {
      throw new CliError('signing-key ref: origin must be a valid normalized http(s) origin');
    }
    if (kind !== 'human' && kind !== 'machine' && kind !== 'agent') {
      throw new CliError(`signing-key ref: kind must be human, machine, or agent (got '${String(kind)}')`);
    }
    const matches = this.listRefs().filter((ref) => ref.origin === normalized && ref.kind === kind);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new CliError(
        `multiple ${kind} signing-key refs found for ${normalized} — run owenloop setup to repair the key store`,
      );
    }
    return matches[0]!;
  }

  /**
   * Idempotently ensure a key exists for `ref`.
   *
   * - Present key ⇒ `{ state: 'existing' }` (zero key-record writes; the
   *   non-secret ref pointer is backfilled when needed).
   * - `opts.reuse` on an ABSENT human key ⇒ validate the candidate SSH key
   *   (Ed25519 only) with a non-secret sign/verify challenge, then store only
   *   its canonical path + public key + fingerprint (`state: 'reused'`). The
   *   candidate's private bytes are never copied.
   * - `opts.reuse` against a PRESENT key ⇒ hard conflict error (no rotation in
   *   WP-A2).
   * - Otherwise generate a dedicated Ed25519 key in a unique `0700` temp dir
   *   and store it through the selected backend (`state: 'created'`).
   *
   * Serialized per ref by the file lock; after acquiring, the store is
   * re-read before generating.
   */
  async ensure(ref: PrincipalKeyRef, opts?: { reuse?: { path: string } }): Promise<EnsureKeyResult> {
    assertKeyRef(ref);
    this.ensureDirs();
    let lock: FileLockHandle | null = null;
    try {
      lock = await acquireFileLock(this.lockPath(ref), {
        waitMs: 30_000,
        label: 'owenloop signing-key creation',
      });
      const existing = this.readRecord(ref);
      if (existing !== null) {
        if (opts?.reuse !== undefined) {
          throw new CliError(
            `a ${ref.kind} signing key already exists for ${ref.origin} — rotation is not part of WP-A2; ` +
              `the existing key is kept`,
          );
        }
        this.writeRefPointer(ref);
        return {
          ref,
          state: 'existing',
          backend: existing.kind === 'reused' ? 'reused' : this.backendKind,
          publicKey: publicKeyDescriptor(existing.publicKey),
        };
      }
      if (opts?.reuse !== undefined) {
        if (ref.kind !== 'human') {
          throw new CliError('explicit SSH key reuse applies only to the human principal key');
        }
        const result = this.storeReused(ref, opts.reuse.path);
        this.writeRefPointer(ref);
        return result;
      }
      const result = this.generate(ref);
      this.writeRefPointer(ref);
      return result;
    } finally {
      if (lock !== null) releaseFileLock(lock);
    }
  }

  /** Derive a candidate's public key from a public path, adjacent `.pub`, or private path. */
  private candidatePublicText(canonicalPath: string): string {
    try {
      const ownText = readFileSync(canonicalPath, 'utf8');
      const first = ownText.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
      if (/^(?:ssh-|ecdsa-|sk-)/.test(first)) return ownText;
    } catch {
      // Let ssh-keygen produce the fixed derivation failure below.
    }
    // A private path is always derived by stock ssh-keygen. An adjacent .pub
    // file is deliberately ignored because it may be stale or mismatched.
    const result = this.runner.run(this.sshKeygen, ['-y', '-f', canonicalPath], { captureStdout: true });
    if (result.status !== 0) throw new Error('public-key derivation failed');
    return result.stdout.toString('utf8');
  }

  /** Validate + record an explicit SSH key (human principal only). */
  private storeReused(ref: PrincipalKeyRef, rawPath: string): EnsureKeyResult {
    const lexical = isAbsolute(rawPath) ? resolve(rawPath) : resolve(process.cwd(), rawPath);
    if (!existsSync(lexical)) {
      throw new CliError('--reuse-ssh-key: no such file');
    }
    let canonical: string;
    try {
      canonical = realpathSync(lexical);
    } catch {
      throw new CliError('--reuse-ssh-key: cannot resolve the key path');
    }
    const st = statSync(canonical);
    if (!st.isFile()) throw new CliError('--reuse-ssh-key: key path is not a regular file');
    let pubText: string;
    try {
      pubText = this.candidatePublicText(canonical);
    } catch {
      throw new CliError('--reuse-ssh-key: cannot derive an Ed25519 public key from the candidate');
    }
    try {
      assertEd25519PubText(pubText, 'candidate key');
    } catch {
      throw new CliError('--reuse-ssh-key: only Ed25519 keys are supported');
    }
    const desc = publicKeyDescriptor(pubText);
    // Non-secret sign/verify challenge with the CANDIDATE key: proves the
    // private half is usable (directly, or through ssh-agent for a public-key
    // path) before the reference is recorded.
    this.challengeSignVerify(canonical, desc);
    const rec: KeyRecord = {
      version: 1,
      ref,
      kind: 'reused',
      publicKey: desc.openSshPublicKey,
      fingerprint: desc.keyid,
      createdAt: new Date().toISOString(),
      path: canonical,
    };
    this.writeRecordText(ref, JSON.stringify(rec));
    return { ref, state: 'reused', backend: 'reused', publicKey: desc };
  }

  /**
   * Sign a fixed challenge message with the candidate key and verify it with
   * stock `ssh-keygen -Y verify` against the candidate's own public key as the
   * sole allowed signer. Public-key-only inputs; the message is public.
   */
  private challengeSignVerify(candidatePath: string, desc: PublicKeyDescriptor): void {
    const dir = this.mkTempKeyDir();
    try {
      const message = Buffer.from(`owenloop key validation challenge ${randomBytes(16).toString('hex')}`, 'utf8');
      const principal = `owenloop-validate-${randomBytes(4).toString('hex')}`;
      // sign: `-f <candidate>` — works for a private key path OR a public key
      // whose private half is in ssh-agent; the message rides on stdin.
      const signRes = this.runner.run(this.sshKeygen, ['-Y', 'sign', '-f', candidatePath, '-n', 'owenloop-key-validation'], {
        stdin: message,
        captureStdout: true,
      });
      if (signRes.status !== 0) {
        throw new CliError(
          '--reuse-ssh-key: the private half of the candidate is not usable (sign failed) — ' +
            'for a public-key path the key must be loaded in ssh-agent',
        );
      }
      const armored = signRes.stdout.toString('utf8');
      if (!armored.includes('-----BEGIN SSH SIGNATURE-----')) {
        throw new CliError('--reuse-ssh-key: sign produced no armored signature');
      }
      const sigPath = join(dir, 'challenge.sig');
      const allowedPath = join(dir, 'challenge.allowed');
      writeFileAtomic(sigPath, armored, { mode: 0o600 });
      writeFileAtomic(allowedPath, `${principal} ${desc.openSshPublicKey}\n`, { mode: 0o600 });
      const verifyRes = this.runner.run(
        this.sshKeygen,
        ['-Y', 'verify', '-f', allowedPath, '-I', principal, '-n', 'owenloop-key-validation', '-s', sigPath],
        { stdin: message },
      );
      if (verifyRes.status !== 0) {
        throw new CliError('--reuse-ssh-key: validation signature did not verify against the candidate public key');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Generate a dedicated Ed25519 key and store it through the backend. */
  private generate(ref: PrincipalKeyRef): EnsureKeyResult {
    const dir = this.mkTempKeyDir();
    try {
      const keyPath = join(dir, 'id');
      const genRes = this.runner.run(
        this.sshKeygen,
        ['-q', '-t', 'ed25519', '-N', '', '-C', `owenloop-${ref.kind}`, '-f', keyPath],
        { stdin: Buffer.alloc(0) },
      );
      if (genRes.status !== 0) {
        throw new CliError(`signing-key generation failed (ssh-keygen exited with status ${genRes.status ?? 'null'})`);
      }
      const pubText = readFileSync(`${keyPath}.pub`, 'utf8');
      const desc = publicKeyDescriptor(pubText);
      if (desc.keyType !== 'ssh-ed25519') {
        throw new CliError(`signing-key generation produced a non-Ed25519 key (${desc.keyType})`);
      }
      const privateKey = readFileSync(keyPath, 'utf8');
      const rec: KeyRecord = {
        version: 1,
        ref,
        kind: 'generated',
        publicKey: desc.openSshPublicKey,
        fingerprint: desc.keyid,
        createdAt: new Date().toISOString(),
        privateKey,
      };
      this.writeRecordText(ref, JSON.stringify(rec));
      return { ref, state: 'created', backend: this.backendKind, publicKey: desc };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Materialize the signing key for `ref` as a filesystem path and pass it to
   * `callback`. Generated keys on keychain backends materialize as a `0600`
   * file inside a unique `0700` temp dir, removed in `finally`; the file
   * backend passes its persistent `0600` record's key file path indirectly by
   * materializing the record's private material the same way (one code path —
   * the record file is a JSON document, not a key file). Reused keys pass only
   * their canonical path. No private text is returned to the caller.
   */
  async withSigningKey<T>(ref: PrincipalKeyRef, callback: (keyPath: string) => Promise<T>): Promise<T> {
    assertKeyRef(ref);
    this.ensureDirs();
    const rec = this.readRecord(ref);
    if (rec === null) {
      throw new CliError(`no ${ref.kind} signing key stored for ${ref.origin} — run owenloop setup`);
    }
    if (rec.kind === 'reused') {
      if (rec.path === undefined || !existsSync(rec.path)) {
        throw new CliError(`the reused ${ref.kind} signing key file is missing — re-run owenloop setup --reuse-ssh-key`);
      }
      let currentPath: string;
      try {
        currentPath = realpathSync(rec.path);
      } catch {
        throw new CliError(`the reused ${ref.kind} signing key file is missing — re-run owenloop setup --reuse-ssh-key`);
      }
      if (currentPath !== rec.path) {
        throw new CliError(`the reused ${ref.kind} signing key path changed — re-run owenloop setup --reuse-ssh-key`);
      }
      let current: PublicKeyDescriptor;
      try {
        current = publicKeyDescriptor(this.candidatePublicText(currentPath));
        assertEd25519PubText(current.openSshPublicKey, 'reused signing key');
      } catch {
        throw new CliError(`the reused ${ref.kind} signing key is no longer a valid Ed25519 key`);
      }
      if (current.keyid !== rec.fingerprint) {
        throw new CliError(`the reused ${ref.kind} signing key identity changed — re-run owenloop setup --reuse-ssh-key`);
      }
      return callback(currentPath);
    }
    if (rec.privateKey === undefined) {
      throw new CliError(`signing-key record for ${ref.kind}:${ref.id} is corrupt (missing key material)`);
    }
    const dir = this.mkTempKeyDir();
    try {
      const keyPath = join(dir, 'id');
      writeFileAtomic(keyPath, rec.privateKey, { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      // ssh-keygen wants a matching .pub next to the private key for -Y sign.
      writeFileAtomic(`${keyPath}.pub`, `${rec.publicKey}\n`, { mode: 0o644 });
      return await callback(keyPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Create a unique `0700` temp dir under the configured temp base. */
  private mkTempKeyDir(): string {
    const dir = join(this.tempBase, `owenloop-key-${randomBytes(8).toString('hex')}`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }
}

/** PATH scan for an executable (pure fs, hermetic-testable via `env.PATH`). */
function commandOnPath(env: Record<string, string | undefined>, cmd: string): boolean {
  const path = env.PATH;
  if (!path) return false;
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const full = join(dir, cmd);
    try {
      const st = statSync(full);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch {
      // not here — keep scanning
    }
  }
  return false;
}

/** Convenience: the directory name helper is reused by tests. */
export function keysDirFor(homeDir: string): string {
  return join(homeDir, '.owenloop', 'keys');
}
