/**
 * The public surface of the content-addressed WORKFLOW store (this `store/`
 * package). Distinct from `src/store.ts` — the SQLite RUNTIME store
 * (`Store`/`openStore`): this package holds immutable, digest-addressed
 * workflow-definition objects installed from `.wnlp` bundles, plus the
 * coordinate→digest index at two levels (project = the resolved defs dir;
 * global = `~/.owenloop/workflows`).
 *
 * Names here are deliberately `Workflow*`-qualified so nothing can collide
 * with the runtime store's `Store`.
 */

export {
  COORDINATE_COMPONENT_RE,
  DIGEST_RE,
  defDigest,
  isDefDigest,
  objectDirForDigest,
  parseWorkflowCoordinate,
  workflowCoordinate,
  WORKFLOW_OBJECTS_ALGO,
  WORKFLOW_OBJECTS_DIRNAME,
  WORKFLOW_STORE_INDEX_FILENAME,
  WorkflowStoreError,
  StoreIndexError,
  StoreDigestError,
  StoreCoordinateError,
  StoreAmbiguityError,
  StoreNotFoundError,
  StoreIntegrityError,
  StoreConflictError,
  StoreDefinitionVerificationError,
  StoreOriginPolicyError,
  StorePathError,
  BundleIngestorUnavailableError,
  PreCommitVerifierUnavailableError,
} from './types.ts';
export type {
  DefDigest,
  ResolutionLevel,
  StoreLevel,
  WorkflowCoordinate,
  WorkflowStoreIndex,
  WorkflowStoreIndexEntry,
} from './types.ts';

export {
  emptyWorkflowStoreIndex,
  parseWorkflowStoreIndex,
  readWorkflowStoreIndex,
  serializeWorkflowStoreIndex,
  WORKFLOW_STORE_INDEX_VERSION,
  writeWorkflowStoreIndex,
} from './index-file.ts';

export {
  globalStoreRoot,
  projectStoreRoot,
  probeObjectDir,
  probeStoreRoot,
  resolveWorkflowCoordinate,
  resolveWorkflowDigest,
  storeIndexPath,
  workflowStoreStatePaths,
} from './resolve.ts';
export type {
  ResolvedWorkflowObject,
  ResolveWorkflowCoordinateArgs,
  ResolveWorkflowDigestArgs,
  WorkflowStoreStatePaths,
} from './resolve.ts';

export {
  hardenObjectModes,
  installWorkflowBundle,
  objectDestRelPath,
  recoverWorkflowStore,
} from './install.ts';
export { createBundleIngestor } from './ingestor.ts';
export type { BundleIngestorOptions } from './ingestor.ts';

// ---- WP-E2a origin execution policy ----
export {
  originEvidencePath,
  persistOriginEvidence,
  readOriginEvidence,
} from './origin-evidence.ts';

export {
  createStoreInstructionSource,
  isResolvableOrderDigest,
  StoreInstructionSourceError,
} from './instruction-source.ts';
export type {
  MissingObjectHandler,
  StoreInstructionSource,
  StoreInstructionSourceArgs,
} from './instruction-source.ts';
export type {
  BundleInstallResult,
  BundleIngestor,
  BundleSource,
  InstallWorkflowBundleArgs,
  PreCommitVerifier,
  RecoverWorkflowStoreArgs,
} from './install.ts';
export {
  createExecutionDefinitionVerifier,
  createExecutionOriginVerifier,
  createPreCommitVerifier,
  createProductionPreCommitVerifier,
  resolveDefPolicy,
  resolveOriginPolicy,
  resolveOriginRules,
} from './pre-commit-verifier.ts';
export type {
  ExecutionDefinitionVerifierInput,
  ExecutionOriginVerifierInput,
  PreCommitVerifierOptions,
} from './pre-commit-verifier.ts';
