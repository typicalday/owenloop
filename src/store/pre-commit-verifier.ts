/**
 * Production implementation of the workflow-store pre-commit verifier.
 *
 * The verifier runs after bundle/engine validation and before the install
 * transaction swaps an object or writes the index. It therefore refuses by
 * throwing, while warnings are sent through the injected diagnostic stream.
 * No verdict or sidecar is written into the immutable object directory.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { BundleSource, PreCommitVerifier } from './install.ts';
import { defDigest } from './types.ts';
import type { DefDigest, WorkflowCoordinate } from './types.ts';
import { readOwenloopSettingsRaw, owenloopSettingsPath } from '../work-settings.ts';
import {
  resolveAllowedSigners,
  type AllowedSignersResolution,
} from '../crypto/trust-roots.ts';
import {
  isDefPolicy,
  verifyPublication,
  type DefPolicy,
  type DefVerdict,
  type VerifyPublicationOptions,
} from '../crypto/verify-publication.ts';
import { StoreDefinitionVerificationError } from './types.ts';

export interface PreCommitVerifierOptions {
  /** Environment used for policy and trust-root resolution. */
  env?: Record<string, string | undefined>;
  /** Base directory for relative bundle paths supplied through CliIO.cwd. */
  cwd?: string;
  /** Explicit policy, useful for embedding and hermetic tests. */
  policy?: DefPolicy;
  /** Diagnostic sink for `warn` policy decisions. */
  warn?: (line: string) => void;
  /** Optional signer seam for hermetic publication-verification tests. */
  signerForPrincipal?: VerifyPublicationOptions['signerForPrincipal'];
  /** SSHSIG namespace override for a host-specific signer adapter. */
  namespace?: string;
}

/** Resolve the policy with the repository-wide precedence: explicit > env > file > default. */
export function resolveDefPolicy(
  env: Record<string, string | undefined>,
  explicit?: DefPolicy,
): DefPolicy {
  if (explicit !== undefined) {
    if (!isDefPolicy(explicit)) throw new Error(`invalid defPolicy '${String(explicit)}'`);
    return explicit;
  }

  const envValue = env.OWENLOOP_DEF_POLICY;
  if (envValue !== undefined && envValue.trim() !== '') {
    if (!isDefPolicy(envValue)) {
      throw new Error(`invalid OWENLOOP_DEF_POLICY '${envValue}': expected enforce, warn, or off`);
    }
    return envValue;
  }

  // A missing HOME/XDG_CONFIG_HOME means there is no settings file to read;
  // the built-in default remains usable. Any other settings read/parse error is
  // surfaced rather than weakened into the least restrictive policy.
  let path: string;
  try {
    path = owenloopSettingsPath(env);
  } catch {
    return 'warn';
  }
  const raw = readOwenloopSettingsRaw(path);
  const value = raw?.['defPolicy'];
  if (value === undefined) return 'warn';
  if (!isDefPolicy(value)) {
    throw new Error(`invalid settings file at ${path}: 'defPolicy' must be 'enforce', 'warn', or 'off', got ${JSON.stringify(value)}`);
  }
  return value;
}

function filesystemSourcePath(source: BundleSource, cwd: string | undefined): string | undefined {
  if (source.kind !== 'file') return undefined;
  return isAbsolute(source.path) || cwd === undefined ? source.path : join(cwd, source.path);
}

function sidecarPath(source: BundleSource, cwd: string | undefined, suffix: '.dsse' | '.unsigned'): string | undefined {
  const bundlePath = filesystemSourcePath(source, cwd);
  return bundlePath === undefined ? undefined : `${bundlePath}${suffix}`;
}

interface Sidecars {
  dsseBytes?: Uint8Array;
  unsigned: boolean;
  contradiction: boolean;
  invalidReason?: string;
}

function readSidecars(source: BundleSource, cwd: string | undefined): Sidecars {
  if (source.kind !== 'file') return { unsigned: false, contradiction: false };
  const dssePath = sidecarPath(source, cwd, '.dsse')!;
  const unsignedPath = sidecarPath(source, cwd, '.unsigned')!;
  const dsseStat = lstatSync(dssePath, { throwIfNoEntry: false });
  const unsignedStat = lstatSync(unsignedPath, { throwIfNoEntry: false });
  const dssePresent = dsseStat !== undefined;
  const unsignedPresent = unsignedStat !== undefined;
  if (dssePresent && unsignedPresent) {
    return {
      unsigned: true,
      contradiction: true,
      invalidReason: `both publication sidecars are present ('${dssePath}' and '${unsignedPath}')`,
    };
  }
  if (unsignedPresent) {
    if (unsignedStat!.isSymbolicLink() || !unsignedStat!.isFile()) {
      return { unsigned: true, contradiction: false, invalidReason: `unsigned publication marker is not a regular file: ${unsignedPath}` };
    }
    // The marker's existence is the producer's explicit unsigned declaration.
    // The policy layer intentionally treats it exactly like a missing .dsse.
    return { unsigned: true, contradiction: false };
  }
  if (!dssePresent) return { unsigned: false, contradiction: false };
  if (dsseStat!.isSymbolicLink() || !dsseStat!.isFile()) {
    return { unsigned: false, contradiction: false, invalidReason: `publication sidecar is not a regular file: ${dssePath}` };
  }
  try {
    return { unsigned: false, contradiction: false, dsseBytes: readFileSync(dssePath) };
  } catch (error) {
    return {
      unsigned: false,
      contradiction: false,
      invalidReason: `publication sidecar could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Verify supplied publication bytes against the injected trust roots. */
async function verifyPublicationBytesAsync(
  digest: DefDigest,
  dsseBytes: Uint8Array,
  env: Record<string, string | undefined>,
  optionsForPublication: PreCommitVerifierOptions,
): Promise<DefVerdict> {
  let roots: AllowedSignersResolution;
  try {
    roots = resolveAllowedSigners(env);
  } catch (error) {
    return { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (roots.kind === 'absent') {
    return {
      kind: 'unverifiable',
      reason: `allowed_signers trust root is absent at ${roots.path}; create that file with an authorized signer entry`,
    };
  }
  return verifyPublication(
    { bundleDigest: digest, dsseBytes, allowedSignersText: roots.text },
    {
      ...(optionsForPublication.signerForPrincipal !== undefined ? { signerForPrincipal: optionsForPublication.signerForPrincipal } : {}),
      ...(optionsForPublication.namespace !== undefined ? { namespace: optionsForPublication.namespace } : {}),
    },
  );
}

/** Resolve a source sidecar and trust roots before invoking the verifier. */
async function verifyPublicationAsync(
  source: BundleSource,
  digest: DefDigest,
  env: Record<string, string | undefined>,
  optionsForPublication: PreCommitVerifierOptions,
): Promise<DefVerdict> {
  let sidecars: Sidecars;
  try {
    sidecars = readSidecars(source, optionsForPublication.cwd);
  } catch (error) {
    return { kind: 'unverifiable', reason: `publication sidecar could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (sidecars.contradiction || sidecars.invalidReason !== undefined) {
    return { kind: 'invalid', reason: sidecars.invalidReason ?? 'publication sidecars contradict one another' };
  }
  if (sidecars.unsigned || sidecars.dsseBytes === undefined) return { kind: 'unsigned' };
  return verifyPublicationBytesAsync(digest, sidecars.dsseBytes, env, optionsForPublication);
}

function ensureDirectory(path: string): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`publication evidence directory is not a real directory: ${path}`);
    }
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Root of the workflow store for an install staging path (`root/.owenloop-staging/id`). */
function storeRootFromStaging(objectDir: string): string {
  return dirname(dirname(objectDir));
}

/** Root of the workflow store for an installed object (`root/objects/sha256/digest`). */
function storeRootFromObject(objectPath: string): string {
  return dirname(dirname(dirname(objectPath)));
}

function publicationEvidencePath(root: string, digest: string): string {
  return join(root, '.owenloop', 'publications', `${digest}.dsse`);
}

/**
 * Retain the exact signed sidecar outside the immutable object. The verdict is
 * never persisted: execution re-verifies these bytes against current trust
 * roots. Existing evidence is left intact when a later unsigned reinstall
 * deduplicates the same digest.
 */
function persistPublicationEvidence(objectDir: string, digest: DefDigest, dsseBytes: Uint8Array): void {
  const root = storeRootFromStaging(objectDir);
  const stateDir = join(root, '.owenloop');
  const evidenceDir = join(stateDir, 'publications');
  ensureDirectory(stateDir);
  ensureDirectory(evidenceDir);
  const target = publicationEvidencePath(root, digest);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temporary, dsseBytes, { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Build the execution-time verifier used by the production store resolver.
 * Installed objects carry exact signed evidence in the store state directory;
 * the verifier reads that evidence and performs a fresh signature decision.
 */
export interface ExecutionDefinitionVerifierInput {
  bundleDigest: string;
  objectPath: string;
}

export function createExecutionDefinitionVerifier(
  options: PreCommitVerifierOptions = {},
): (input: ExecutionDefinitionVerifierInput) => Promise<DefVerdict> {
  const env = options.env ?? process.env;
  return async (input: ExecutionDefinitionVerifierInput): Promise<DefVerdict> => {
    let digest: DefDigest;
    try {
      digest = defDigest(input.bundleDigest);
    } catch (error) {
      return { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error) };
    }
    const target = publicationEvidencePath(storeRootFromObject(input.objectPath), input.bundleDigest);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat === undefined) return { kind: 'unsigned' };
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { kind: 'invalid', reason: `stored publication evidence is not a regular file: ${target}` };
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(target);
    } catch (error) {
      return { kind: 'unverifiable', reason: `stored publication evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    return verifyPublicationBytesAsync(digest, bytes, env, options);
  };
}

function warningText(source: BundleSource, coordinate: WorkflowCoordinate, verdict: DefVerdict): string {
  const origin = source.kind === 'file' ? source.path : source.url;
  if (verdict.kind === 'unsigned') {
    return `workflow definition '${coordinate}' from ${origin} is unsigned; defPolicy=warn allows installation`;
  }
  if (verdict.kind === 'unverifiable') {
    return `workflow definition '${coordinate}' from ${origin} is unverifiable; defPolicy=warn allows installation: ${verdict.reason}`;
  }
  return `workflow definition '${coordinate}' from ${origin} was not verified`;
}

/** Production adapter bound by the root CLI's `defaultIO()`. */
export function createPreCommitVerifier(options: PreCommitVerifierOptions = {}): PreCommitVerifier {
  const env = options.env ?? process.env;
  return {
    async verify(input: {
      source: BundleSource;
      coordinate: WorkflowCoordinate;
      digest: DefDigest;
      objectDir: string;
    }): Promise<void> {
      // objectDir is deliberately unused: no provenance is written into the
      // immutable object, and object integrity is owned by BundleIngestor.
      void input.objectDir;
      const policy = resolveDefPolicy(env, options.policy);
      const verdict = await verifyPublicationAsync(input.source, input.digest, env, options);
      if (verdict.kind === 'invalid') {
        throw new StoreDefinitionVerificationError('invalid', policy, input.coordinate, verdict.reason);
      }
      if (policy === 'enforce' && verdict.kind !== 'verified') {
        throw new StoreDefinitionVerificationError(verdict.kind, policy, input.coordinate, verdict.kind === 'unverifiable' ? verdict.reason : 'definition is unsigned');
      }
      if (policy === 'warn' && verdict.kind !== 'verified') {
        (options.warn ?? ((line: string): void => void console.error(line)))(warningText(input.source, input.coordinate, verdict));
      }

      // Keep only exact signed evidence, never the derived verdict. Re-reading
      // the sidecar here avoids persisting any bytes for URL or unsigned input.
      let sidecars: Sidecars;
      try {
        sidecars = readSidecars(input.source, options.cwd);
      } catch (error) {
        throw new Error(`publication sidecar could not be retained: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (sidecars.dsseBytes !== undefined) {
        persistPublicationEvidence(input.objectDir, input.digest, sidecars.dsseBytes);
      }
    },
  };
}

/** Alias emphasizing the adapter's role in the install transaction. */
export const createProductionPreCommitVerifier = createPreCommitVerifier;
