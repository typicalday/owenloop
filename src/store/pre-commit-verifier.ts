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
import { defDigest, parseWorkflowCoordinate } from './types.ts';
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
import { mergePolicyFloorWithLocal } from '../crypto/policy-floor.ts';
import {
  evaluateOriginRule,
  matchOriginRule,
  parseOriginRules,
  type OriginPolicy,
  type OriginRuleMatch,
  type OriginRules,
} from '../crypto/origin-rules.ts';
import { verifyOrigin, type OriginVerdict } from '../crypto/verify-origin.ts';
import type { PolicyFloor } from '../crypto/records.ts';
import { persistOriginEvidence, readOriginEvidence } from './origin-evidence.ts';
import { StoreDefinitionVerificationError, StoreOriginPolicyError } from './types.ts';

export interface PreCommitVerifierOptions {
  /** Environment used for policy and trust-root resolution. */
  env?: Record<string, string | undefined>;
  /** Base directory for relative bundle paths supplied through CliIO.cwd. */
  cwd?: string;
  /** Explicit publication policy, useful for embedding and hermetic tests. */
  policy?: DefPolicy;
  /** Explicit consumed-artifact policy, useful for embedding and hermetic tests. */
  artifactPolicy?: DefPolicy;
  /** Explicit origin policy, useful for embedding and hermetic tests. */
  originPolicy?: OriginPolicy;
  /** Explicit namespace-scoped origin rules. */
  originRules?: OriginRules;
  /** Already-verified organization floor; absent means local policy only. */
  policyFloor?: PolicyFloor;
  /** Diagnostic sink for `warn` policy decisions. */
  warn?: (line: string) => void;
  /** Optional signer seam for hermetic publication-verification tests. */
  signerForPrincipal?: VerifyPublicationOptions['signerForPrincipal'];
  /** SSHSIG namespace override for a host-specific signer adapter. */
  namespace?: string;
}

function resolvePolicyValue(
  env: Record<string, string | undefined>,
  explicit: DefPolicy | undefined,
  envKey: string,
  settingsKey: string,
  label: string,
): DefPolicy {
  if (explicit !== undefined) {
    if (!isDefPolicy(explicit)) throw new Error(`invalid ${label} '${String(explicit)}'`);
    return explicit;
  }

  const envValue = env[envKey];
  if (envValue !== undefined && envValue.trim() !== '') {
    if (!isDefPolicy(envValue)) {
      throw new Error(`invalid ${envKey} '${envValue}': expected enforce, warn, or off`);
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
  const value = raw?.[settingsKey];
  if (value === undefined) return 'warn';
  if (!isDefPolicy(value)) {
    throw new Error(`invalid settings file at ${path}: '${settingsKey}' must be 'enforce', 'warn', or 'off', got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Resolve publication policy with explicit > env > settings > default precedence. */
export function resolveDefPolicy(
  env: Record<string, string | undefined>,
  explicit?: DefPolicy,
): DefPolicy {
  return resolvePolicyValue(env, explicit, 'OWENLOOP_DEF_POLICY', 'defPolicy', 'defPolicy');
}

/** Resolve origin policy with the same four-layer precedence as defPolicy. */
export function resolveOriginPolicy(
  env: Record<string, string | undefined>,
  explicit?: OriginPolicy,
): OriginPolicy {
  return resolvePolicyValue(env, explicit, 'OWENLOOP_ORIGIN_POLICY', 'originPolicy', 'originPolicy');
}

/** Resolve consumed-artifact policy with the same four-layer precedence. */
export function resolveArtifactPolicy(
  env: Record<string, string | undefined>,
  explicit?: DefPolicy,
): DefPolicy {
  return resolvePolicyValue(env, explicit, 'OWENLOOP_ARTIFACT_POLICY', 'artifactPolicy', 'artifactPolicy');
}

/** Resolve namespace rules with explicit > settings > empty precedence. */
export function resolveOriginRules(
  env: Record<string, string | undefined>,
  explicit?: OriginRules,
): OriginRules {
  if (explicit !== undefined) return parseOriginRules(explicit);
  let path: string;
  try {
    path = owenloopSettingsPath(env);
  } catch {
    return parseOriginRules(undefined);
  }
  const raw = readOwenloopSettingsRaw(path);
  return parseOriginRules(raw?.['originRules']);
}

function filesystemSourcePath(source: BundleSource, cwd: string | undefined): string | undefined {
  if (source.kind !== 'file') return undefined;
  return isAbsolute(source.path) || cwd === undefined ? source.path : join(cwd, source.path);
}

function sidecarPath(source: BundleSource, cwd: string | undefined, suffix: '.dsse' | '.unsigned' | '.origin.dsse'): string | undefined {
  const bundlePath = filesystemSourcePath(source, cwd);
  return bundlePath === undefined ? undefined : `${bundlePath}${suffix}`;
}

interface Sidecars {
  dsseBytes?: Uint8Array;
  originDsseBytes?: Uint8Array;
  unsigned: boolean;
  contradiction: boolean;
  invalidReason?: string;
  originInvalidReason?: string;
}

function readSidecars(source: BundleSource, cwd: string | undefined): Sidecars {
  if (source.kind !== 'file') return { unsigned: false, contradiction: false };
  const dssePath = sidecarPath(source, cwd, '.dsse')!;
  const unsignedPath = sidecarPath(source, cwd, '.unsigned')!;
  const originPath = sidecarPath(source, cwd, '.origin.dsse')!;
  const dsseStat = lstatSync(dssePath, { throwIfNoEntry: false });
  const unsignedStat = lstatSync(unsignedPath, { throwIfNoEntry: false });
  const originStat = lstatSync(originPath, { throwIfNoEntry: false });
  const dssePresent = dsseStat !== undefined;
  const unsignedPresent = unsignedStat !== undefined;
  const originPresent = originStat !== undefined;
  if (dssePresent && unsignedPresent) {
    return {
      unsigned: true,
      contradiction: true,
      invalidReason: `both publication sidecars are present ('${dssePath}' and '${unsignedPath}')`,
    };
  }

  let originDsseBytes: Uint8Array | undefined;
  let originInvalidReason: string | undefined;
  if (originPresent) {
    if (originStat!.isSymbolicLink() || !originStat!.isFile()) {
      originInvalidReason = `origin sidecar is not a regular file: ${originPath}`;
    } else {
      try {
        originDsseBytes = readFileSync(originPath);
      } catch (error) {
        originInvalidReason = `origin sidecar could not be read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  if (unsignedPresent) {
    if (unsignedStat!.isSymbolicLink() || !unsignedStat!.isFile()) {
      return {
        unsigned: true,
        contradiction: false,
        originDsseBytes,
        originInvalidReason,
        invalidReason: `unsigned publication marker is not a regular file: ${unsignedPath}`,
      };
    }
    // The marker's existence is the producer's explicit unsigned declaration.
    // The policy layer intentionally treats it exactly like a missing .dsse.
    return { unsigned: true, contradiction: false, originDsseBytes, originInvalidReason };
  }
  if (!dssePresent) return { unsigned: true, contradiction: false, originDsseBytes, originInvalidReason };
  if (dsseStat!.isSymbolicLink() || !dsseStat!.isFile()) {
    return {
      unsigned: false,
      contradiction: false,
      originDsseBytes,
      originInvalidReason,
      invalidReason: `publication sidecar is not a regular file: ${dssePath}`,
    };
  }
  try {
    return { unsigned: false, contradiction: false, originDsseBytes, originInvalidReason, dsseBytes: readFileSync(dssePath) };
  } catch (error) {
    return {
      unsigned: false,
      contradiction: false,
      originDsseBytes,
      originInvalidReason,
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
  sidecars?: Sidecars,
): Promise<DefVerdict> {
  let resolvedSidecars = sidecars;
  if (resolvedSidecars === undefined) {
    try {
      resolvedSidecars = readSidecars(source, optionsForPublication.cwd);
    } catch (error) {
      return { kind: 'unverifiable', reason: `publication sidecar could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (resolvedSidecars.contradiction || resolvedSidecars.invalidReason !== undefined) {
    return { kind: 'invalid', reason: resolvedSidecars.invalidReason ?? 'publication sidecars contradict one another' };
  }
  if (resolvedSidecars.unsigned || resolvedSidecars.dsseBytes === undefined) return { kind: 'unsigned' };
  return verifyPublicationBytesAsync(digest, resolvedSidecars.dsseBytes, env, optionsForPublication);
}

async function verifyOriginBytesAsync(
  digest: DefDigest,
  dsseBytes: Uint8Array | undefined,
  env: Record<string, string | undefined>,
  optionsForOrigin: PreCommitVerifierOptions,
): Promise<OriginVerdict> {
  if (dsseBytes === undefined) return { kind: 'absent' };
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
  return verifyOrigin(
    { bundleDigest: digest, dsseBytes, allowedSignersText: roots.text },
    {
      ...(optionsForOrigin.signerForPrincipal !== undefined ? { signerForPrincipal: optionsForOrigin.signerForPrincipal } : {}),
      ...(optionsForOrigin.namespace !== undefined ? { namespace: optionsForOrigin.namespace } : {}),
    },
  );
}

async function verifyOriginAsync(
  source: BundleSource,
  digest: DefDigest,
  env: Record<string, string | undefined>,
  optionsForOrigin: PreCommitVerifierOptions,
  sidecars?: Sidecars,
): Promise<OriginVerdict> {
  let resolvedSidecars = sidecars;
  if (resolvedSidecars === undefined) {
    try {
      resolvedSidecars = readSidecars(source, optionsForOrigin.cwd);
    } catch (error) {
      return { kind: 'unverifiable', reason: `origin sidecar could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (resolvedSidecars.originInvalidReason !== undefined) {
    return { kind: 'invalid', reason: resolvedSidecars.originInvalidReason };
  }
  if (resolvedSidecars.unsigned) {
    return resolvedSidecars.originDsseBytes === undefined
      ? { kind: 'absent' }
      : { kind: 'invalid', reason: 'definition was published unsigned and cannot carry an origin' };
  }
  return verifyOriginBytesAsync(digest, resolvedSidecars.originDsseBytes, env, optionsForOrigin);
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

/** Input required by the execution-time origin verifier. */
export interface ExecutionOriginVerifierInput {
  bundleDigest: string;
  objectPath: string;
}

/**
 * Build the execution-time origin verifier. Installed origin evidence is read
 * from mutable store state and re-verified against the current allowed_signers
 * trust root; no cached origin verdict is trusted.
 */
export function createExecutionOriginVerifier(
  options: PreCommitVerifierOptions = {},
): (input: ExecutionOriginVerifierInput) => Promise<OriginVerdict> {
  const env = options.env ?? process.env;
  return async (input: ExecutionOriginVerifierInput): Promise<OriginVerdict> => {
    let digest: DefDigest;
    try {
      digest = defDigest(input.bundleDigest);
    } catch (error) {
      return { kind: 'unverifiable', reason: error instanceof Error ? error.message : String(error) };
    }

    let bytes: Uint8Array | undefined;
    try {
      bytes = readOriginEvidence(input.objectPath, digest);
    } catch (error) {
      return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    return verifyOriginBytesAsync(digest, bytes, env, options);
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

function absentOriginDetail(source: BundleSource, sidecars: Sidecars): string {
  if (source.kind !== 'file') {
    return 'cannot carry an origin: installed from a non-file source, where no sidecar is available';
  }
  if (sidecars.unsigned) {
    return 'cannot carry an origin: the definition was published unsigned';
  }
  return 'no origin was recorded';
}

function evaluateInstalledOrigin(
  source: BundleSource,
  sidecars: Sidecars,
  match: OriginRuleMatch | undefined,
  verdict: OriginVerdict,
): ReturnType<typeof evaluateOriginRule> {
  if (match === undefined) return { ok: true };
  const evaluation = evaluateOriginRule(match.value, verdict);
  if (!evaluation.ok && evaluation.kind === 'absent') {
    return { ok: false, kind: 'absent', detail: absentOriginDetail(source, sidecars) };
  }
  return evaluation;
}

function originWarningText(
  coordinate: WorkflowCoordinate,
  namespace: string,
  match: OriginRuleMatch,
  evaluation: Exclude<ReturnType<typeof evaluateOriginRule>, { ok: true }>,
): string {
  return `workflow definition '${coordinate}' was not admitted by originRules=${match.key} for namespace '${namespace}'; originPolicy=warn allows installation: ${evaluation.kind} — ${evaluation.detail}`;
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
      const namespace = parseWorkflowCoordinate(input.coordinate).namespace;
      const originRules = resolveOriginRules(env, options.originRules);
      const originMatch = matchOriginRule(originRules, namespace);
      const merged = mergePolicyFloorWithLocal(
        resolveDefPolicy(env, options.policy),
        options.policyFloor,
        resolveOriginPolicy(env, options.originPolicy),
        resolveArtifactPolicy(env, options.artifactPolicy),
      );
      const policy = merged.effective;
      const originPolicy = merged.originPolicy;

      let sidecars: Sidecars;
      try {
        sidecars = readSidecars(input.source, options.cwd);
      } catch (error) {
        const detail = `publication sidecar could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
        throw new StoreDefinitionVerificationError('unverifiable', policy, input.coordinate, detail);
      }

      const verdict = await verifyPublicationAsync(input.source, input.digest, env, options, sidecars);
      if (verdict.kind === 'invalid') {
        throw new StoreDefinitionVerificationError('invalid', policy, input.coordinate, verdict.reason);
      }
      if (policy === 'enforce' && verdict.kind !== 'verified') {
        throw new StoreDefinitionVerificationError(verdict.kind, policy, input.coordinate, verdict.kind === 'unverifiable' ? verdict.reason : 'definition is unsigned');
      }
      if (policy === 'warn' && verdict.kind !== 'verified') {
        (options.warn ?? ((line: string): void => void console.error(line)))(warningText(input.source, input.coordinate, verdict));
      }

      const originVerdict = await verifyOriginAsync(input.source, input.digest, env, options, sidecars);
      if (originVerdict.kind === 'invalid') {
        throw new StoreOriginPolicyError(
          input.coordinate,
          namespace,
          originMatch?.key ?? '<none>',
          'invalid',
          originVerdict.reason,
        );
      }
      const originEvaluation = evaluateInstalledOrigin(input.source, sidecars, originMatch, originVerdict);
      if (!originEvaluation.ok) {
        if (originPolicy === 'enforce') {
          throw new StoreOriginPolicyError(
            input.coordinate,
            namespace,
            originMatch!.key,
            originEvaluation.kind,
            originEvaluation.detail,
          );
        }
        if (originPolicy === 'warn') {
          (options.warn ?? ((line: string): void => void console.error(line)))(originWarningText(input.coordinate, namespace, originMatch!, originEvaluation));
        }
      }

      // Keep only exact signed evidence, never the derived verdict. Existing
      // evidence is replaced only by a newly verified statement for this digest.
      if (sidecars.dsseBytes !== undefined) {
        persistPublicationEvidence(input.objectDir, input.digest, sidecars.dsseBytes);
      }
      if (sidecars.originDsseBytes !== undefined && originVerdict.kind === 'verified') {
        persistOriginEvidence(input.objectDir, input.digest, sidecars.originDsseBytes);
      }
    },
  };
}

/** Alias emphasizing the adapter's role in the install transaction. */
export const createProductionPreCommitVerifier = createPreCommitVerifier;
