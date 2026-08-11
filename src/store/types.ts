/**
 * The content-addressed workflow store's value types, constructors, and named
 * error classes.
 *
 * TWO DISTINCT "STORES" live in this package — do not conflate them:
 *   - `src/store.ts` — the SQLite RUNTIME store (`Store`/`openStore`): engine
 *     execution state (workflows, runs, artifacts).
 *   - `src/store/` (this directory) — the content-addressed WORKFLOW store:
 *     immutable, digest-addressed workflow-definition objects plus a
 *     coordinate→digest index, installed from `.wnlp` bundles. This module is
 *     its type surface.
 *
 * On-disk layout, at EACH of two levels (project = the resolved defs dir;
 * global = `~/.owenloop/workflows`):
 *
 *   <root>/index.json                    coordinate → digest (+ pinned) index
 *   <root>/objects/sha256/<64-hex>/      one immutable object per digest
 *
 * Identity rules: a digest is a lowercase 64-char SHA-256 hex value owned by
 * the bundle format module — this module only VALIDATES the
 * shape (rejecting uppercase/noncanonical input rather than normalizing
 * attacker-controlled data); it never recomputes bundle digests itself. A
 * coordinate is `namespace/name@version` (the FULL coordinate — this module
 * never derives one from a filename or URL). Object paths derive ONLY from
 * validated digests; a coordinate or source URL is never joined into a
 * filesystem path.
 */

import { join } from 'node:path';

/** A lowercase 64-char SHA-256 hex digest — the store's only object identity. */
export const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * One coordinate component (`namespace`, `name`, or `version`). The grammar is
 * deliberately broad: a component is a non-empty string free of control
 * characters and path-significant characters. This module deliberately does
 * NOT impose a semver grammar on `version` — the bundle format module owns
 * version content; this module only keeps components filesystem-safe and
 * unambiguous.
 */
// eslint-disable-next-line no-control-regex -- the control-character exclusion IS the point: components must be filesystem-safe, so the range is deliberate.
export const COORDINATE_COMPONENT_RE = /^[^\x00-\x1f\x7f\\/:%#?]+$/;

/**
 * A validated bundle object digest (lowercase 64-hex). Construct with
 * {@link defDigest}; the type is branded (a compile-time-only marker — no
 * runtime representation) so a raw string cannot be passed where a validated
 * digest is expected.
 */
export type DefDigest = string & { readonly __defDigest: true };

/**
 * A validated full workflow coordinate `namespace/name@version`. Construct
 * with {@link workflowCoordinate} (or parse one with {@link parseWorkflowCoordinate}).
 */
export type WorkflowCoordinate = string & { readonly __workflowCoordinate: true };

/**
 * A named store error: every fail-closed refusal the store produces carries a
 * stable machine-readable `code` alongside the human message, so callers
 * (CLI dispatch, resolution callers, tests) can branch on `instanceof` +
 * `code` instead of matching message text. `path`/`entry`/`coordinate` are
 * present only in messages, never trusted for control flow.
 */
export class WorkflowStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowStoreError';
    this.code = code;
  }
}

/** The index file failed to parse or failed fail-closed validation. */
export class StoreIndexError extends WorkflowStoreError {
  constructor(message: string) {
    super('index-invalid', message);
    this.name = 'StoreIndexError';
  }
}

/** A digest string failed validation (wrong length/case/charset). */
export class StoreDigestError extends WorkflowStoreError {
  constructor(message: string) {
    super('digest-invalid', message);
    this.name = 'StoreDigestError';
  }
}

/** A coordinate string failed construction/parsing validation. */
export class StoreCoordinateError extends WorkflowStoreError {
  constructor(message: string) {
    super('coordinate-invalid', message);
    this.name = 'StoreCoordinateError';
  }
}

/**
 * @deprecated Coordinate resolution is project-first and no longer throws this
 * error when project and global indexes name different digests. The export and
 * constructor remain for compatibility with older callers that import or
 * instantiate the error class.
 */
export class StoreAmbiguityError extends WorkflowStoreError {
  readonly coordinate: WorkflowCoordinate;
  readonly projectDigest: string;
  readonly globalDigest: string;
  constructor(coordinate: WorkflowCoordinate, projectDigest: string, globalDigest: string) {
    super(
      'coordinate-ambiguous',
      `coordinate '${coordinate}' resolves to different digests in the project store ` +
        `(${projectDigest}) and the global store (${globalDigest}) — ` +
        `resolve the ambiguity explicitly instead of guessing`,
    );
    this.name = 'StoreAmbiguityError';
    this.coordinate = coordinate;
    this.projectDigest = projectDigest;
    this.globalDigest = globalDigest;
  }
}

/** The coordinate was not found in any consulted level's index. */
export class StoreNotFoundError extends WorkflowStoreError {
  readonly coordinate: WorkflowCoordinate;
  constructor(coordinate: WorkflowCoordinate) {
    super('coordinate-not-found', `coordinate '${coordinate}' is not in the workflow store index`);
    this.name = 'StoreNotFoundError';
    this.coordinate = coordinate;
  }
}

/** An index entry names a digest whose object is missing or failed verification. */
export class StoreIntegrityError extends WorkflowStoreError {
  readonly digest: string;
  constructor(code: 'object-missing' | 'object-corrupt', digest: string, detail: string) {
    super(code, `object ${digest}: ${detail}`);
    this.name = 'StoreIntegrityError';
    this.digest = digest;
  }
}

/** Installing a coordinate the index already records at a DIFFERENT digest. */
export class StoreConflictError extends WorkflowStoreError {
  readonly coordinate: WorkflowCoordinate;
  readonly existingDigest: string;
  constructor(coordinate: WorkflowCoordinate, existingDigest: string) {
    super(
      'coordinate-conflict',
      `coordinate '${coordinate}' is already recorded at digest ${existingDigest} — ` +
        `an existing coordinate is never silently retargeted to a different digest ` +
        `(use an explicit pin/update)`,
    );
    this.name = 'StoreConflictError';
    this.coordinate = coordinate;
    this.existingDigest = existingDigest;
  }
}

/** The required bundle ingestion adapter was not supplied. Fail-closed. */
export class BundleIngestorUnavailableError extends WorkflowStoreError {
  constructor() {
    super(
      'bundle-ingestor-unavailable',
      'bundle ingestion is unavailable: no BundleIngestor adapter is bound — ' +
        'nothing was staged or committed',
    );
    this.name = 'BundleIngestorUnavailableError';
  }
}

/** The required pre-commit signature/policy verifier was not supplied. Fail-closed. */
export class PreCommitVerifierUnavailableError extends WorkflowStoreError {
  constructor() {
    super(
      'pre-commit-verifier-unavailable',
      'pre-commit verification is unavailable: no PreCommitVerifier adapter is bound — ' +
        'nothing was staged or committed',
    );
    this.name = 'PreCommitVerifierUnavailableError';
  }
}

/** A publication signature verdict was refused by the configured definition policy. */
export class StoreDefinitionVerificationError extends WorkflowStoreError {
  readonly verdict: 'unsigned' | 'unverifiable' | 'invalid';
  readonly policy: 'enforce' | 'warn' | 'off';
  readonly coordinate: WorkflowCoordinate;
  constructor(
    verdict: 'unsigned' | 'unverifiable' | 'invalid',
    policy: 'enforce' | 'warn' | 'off',
    coordinate: WorkflowCoordinate,
    reason: string,
  ) {
    super(
      'definition-verification-refused',
      `definition '${coordinate}' was refused by defPolicy=${policy}: ${verdict} — ${reason}`,
    );
    this.name = 'StoreDefinitionVerificationError';
    this.verdict = verdict;
    this.policy = policy;
    this.coordinate = coordinate;
  }
}

/** A provenance rule refused a workflow definition before execution or install. */
export class StoreOriginPolicyError extends WorkflowStoreError {
  readonly coordinate: WorkflowCoordinate;
  readonly namespace: string;
  readonly rule: string;
  readonly verdict: 'absent' | 'unverifiable' | 'invalid' | 'weaker';
  constructor(
    coordinate: WorkflowCoordinate,
    namespace: string,
    rule: string,
    verdict: 'absent' | 'unverifiable' | 'invalid' | 'weaker',
    detail: string,
  ) {
    super(
      'origin-policy-refused',
      `definition '${coordinate}' was refused by originRules=${rule} for namespace '${namespace}': ${verdict} — ${detail}`,
    );
    this.name = 'StoreOriginPolicyError';
    this.coordinate = coordinate;
    this.namespace = namespace;
    this.rule = rule;
    this.verdict = verdict;
  }
}

/** A store root, objects dir, index file, or state path failed a type/symlink guard. */
export class StorePathError extends WorkflowStoreError {
  constructor(message: string) {
    super('path-refused', message);
    this.name = 'StorePathError';
  }
}

/** Validate a raw string as a {@link DefDigest}; throw {@link StoreDigestError} otherwise. */
export function defDigest(raw: string): DefDigest {
  if (!DIGEST_RE.test(raw)) {
    throw new StoreDigestError(
      `invalid def digest ${JSON.stringify(raw)} — expected a lowercase 64-char sha256 hex value`,
    );
  }
  return raw as DefDigest;
}

/** True when `raw` is a well-formed digest (lowercase 64-hex). */
export function isDefDigest(raw: string): raw is DefDigest {
  return DIGEST_RE.test(raw);
}

function validateCoordinateComponent(kind: 'namespace' | 'name' | 'version', value: string): void {
  if (value === '') {
    throw new StoreCoordinateError(`invalid coordinate: ${kind} is empty`);
  }
  if (!COORDINATE_COMPONENT_RE.test(value)) {
    throw new StoreCoordinateError(
      `invalid coordinate: ${kind} ${JSON.stringify(value)} contains a control or path-significant character`,
    );
  }
}

/**
 * Construct a validated {@link WorkflowCoordinate} from its three parts.
 * Each part must be non-empty and free of control/path-significant characters;
 * a violation throws {@link StoreCoordinateError}. The full text
 * `namespace/name@version` is returned branded — the ONLY string shape the
 * store accepts as a coordinate key.
 */
export function workflowCoordinate(parts: {
  namespace: string;
  name: string;
  version: string;
}): WorkflowCoordinate {
  validateCoordinateComponent('namespace', parts.namespace);
  validateCoordinateComponent('name', parts.name);
  validateCoordinateComponent('version', parts.version);
  return `${parts.namespace}/${parts.name}@${parts.version}` as WorkflowCoordinate;
}

/**
 * Parse a full `namespace/name@version` coordinate text into its parts. The
 * version is split at the FINAL `@` and the name at the FIRST `/` before it
 * (a namespace/name itself never contains a slash); every component is
 * validated exactly as {@link workflowCoordinate} validates it. A malformed
 * shape throws {@link StoreCoordinateError}. Never used on untrusted input
 * that then bypasses validation — the returned parts are only as safe as this
 * function's checks.
 */
export function parseWorkflowCoordinate(text: string): {
  namespace: string;
  name: string;
  version: string;
} {
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) {
    throw new StoreCoordinateError(
      `invalid coordinate ${JSON.stringify(text)} — expected 'namespace/name@version'`,
    );
  }
  const namespaceAndName = text.slice(0, at);
  const version = text.slice(at + 1);
  const slash = namespaceAndName.indexOf('/');
  if (slash <= 0 || slash === namespaceAndName.length - 1) {
    throw new StoreCoordinateError(
      `invalid coordinate ${JSON.stringify(text)} — expected 'namespace/name@version'`,
    );
  }
  const namespace = namespaceAndName.slice(0, slash);
  const name = namespaceAndName.slice(slash + 1);
  if (name.includes('/')) {
    throw new StoreCoordinateError(
      `invalid coordinate ${JSON.stringify(text)} — expected exactly one '/' before the version`,
    );
  }
  const coordinate = workflowCoordinate({ namespace, name, version });
  // Defensive round-trip: the reconstructed full text must equal the input —
  // a coordinate is only ever stored/compared in its exact input form.
  if (coordinate !== text) {
    throw new StoreCoordinateError(`invalid coordinate ${JSON.stringify(text)} — non-canonical form`);
  }
  return { namespace, name, version };
}

/** The two store levels. Project = the resolved defs dir; global = `~/.owenloop/workflows`. */
export type StoreLevel = 'project' | 'global';

/** Where a resolution found its object (human-facing result metadata). */
export type ResolutionLevel = 'project' | 'global';

/** One index entry: the digest a coordinate currently records, plus its pin state. */
export interface WorkflowStoreIndexEntry {
  digest: string;
  pinned: boolean;
  /** Sorted workflow names carried by the installed bundle, when known. */
  workflows?: string[];
}

/**
 * The workflow-store index shape (one per store root). Keys are FULL
 * coordinates `namespace/name@version`; values record the coordinate's digest
 * and pin state. `version` is always exactly `1` (validated fail-closed on
 * read). Unknown additive fields are tolerated for forward compatibility;
 * required fields are enforced.
 */
export interface WorkflowStoreIndex {
  version: 1;
  entries: Record<string, WorkflowStoreIndexEntry>;
}

/** The index filename at a store root. */
export const WORKFLOW_STORE_INDEX_FILENAME = 'index.json';

/** The objects subtree at a store root: `objects/sha256/<digest>/`. */
export const WORKFLOW_OBJECTS_DIRNAME = 'objects';

/** The digest algorithm directory under `objects/` (sha256 is the only one). */
export const WORKFLOW_OBJECTS_ALGO = 'sha256';

/**
 * Derive the object directory for a validated digest under `root`. Digests are
 * validated BEFORE this joins anything: a coordinate or URL must never reach a
 * filesystem path. The digest is a single path segment by construction (64 hex
 * chars), so the join cannot escape `root`.
 */
export function objectDirForDigest(root: string, digest: DefDigest): string {
  // Re-assert the shape at the derivation site (belt-and-braces; the brand is
  // compile-time only).
  if (!DIGEST_RE.test(digest)) {
    throw new StoreDigestError(`refusing to derive an object path from ${JSON.stringify(digest)}`);
  }
  return join(root, WORKFLOW_OBJECTS_DIRNAME, WORKFLOW_OBJECTS_ALGO, digest);
}
