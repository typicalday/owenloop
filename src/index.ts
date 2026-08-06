/**
 * owenloop — a generic dataflow workflow engine.
 *
 * Steps owe and consume artifacts; a step's eligibility to run is a pure
 * function of artifact state (debts + dependency satisfaction), not a status
 * enum. Rejection carries a reason thread; a forward cascade keeps the graph
 * honest ("an artifact is green only while every artifact it consumed is
 * green"); a commit-fingerprint CAS makes concurrent advancement safe.
 *
 * This is the public API. The engine is domain-neutral: a *wiring* (a set of
 * workflow definitions + a Step Agent that executes orders) layers a concrete
 * process — software delivery, research, triage — on top of it.
 */

export { Engine } from './engine.ts';
export type {
  CommitResult,
  CreateOpts,
  DefResolver,
  DeferredFiring,
  DeferredReason,
  EmitResult,
  EngineEvent,
  EngineListener,
  EngineWorkflowStatus,
  Order,
  ReapDetail,
  ReapReason,
  TickResult,
} from './engine.ts';

export { createEngine } from './factory.ts';
export type { CreateEngineOpts, CreatedEngine } from './factory.ts';

export {
  createDefInstructionSource,
  defInstructionDigest,
  OrderResolver,
  substituteOrderVars,
  UnknownDefDigestError,
  UnknownInstructionError,
} from './order-resolver.ts';
export type {
  OrderInstructionLookup,
  OrderInstructionRef,
  OrderInstructionSource,
  OrderRuntimeVars,
  ResolvedInstructionRecord,
  ResolvedInstructions,
} from './order-resolver.ts';

export { Store, openStore, StoreVersionError } from './store.ts';
export type { ArtifactRow, RunRow, TaskRow, WorkflowRow } from './store.ts';

// The content-addressed WORKFLOW store (distinct from the SQLite runtime
// store above): two-level digest-addressed workflow objects + coordinate
// index, `.wnlp` bundle installation, and fail-closed resolution.
export {
  defDigest,
  emptyWorkflowStoreIndex,
  globalStoreRoot,
  hardenObjectModes,
  installWorkflowBundle,
  isDefDigest,
  objectDestRelPath,
  objectDirForDigest,
  parseWorkflowCoordinate,
  parseWorkflowStoreIndex,
  projectStoreRoot,
  probeObjectDir,
  probeStoreRoot,
  readWorkflowStoreIndex,
  recoverWorkflowStore,
  resolveWorkflowCoordinate,
  resolveWorkflowDigest,
  serializeWorkflowStoreIndex,
  storeIndexPath,
  workflowCoordinate,
  workflowStoreStatePaths,
  WORKFLOW_STORE_INDEX_VERSION,
  WorkflowStoreError,
  StoreIndexError,
  StoreDigestError,
  StoreCoordinateError,
  StoreAmbiguityError,
  StoreNotFoundError,
  StoreIntegrityError,
  StoreConflictError,
  StoreDefinitionVerificationError,
  StorePathError,
  BundleIngestorUnavailableError,
  PreCommitVerifierUnavailableError,
} from './store/index.ts';
export type {
  BundleInstallResult,
  BundleIngestor,
  BundleSource,
  DefDigest,
  InstallWorkflowBundleArgs,
  PreCommitVerifier,
  RecoverWorkflowStoreArgs,
  ResolvedWorkflowObject,
  ResolveWorkflowCoordinateArgs,
  ResolveWorkflowDigestArgs,
  ResolutionLevel,
  StoreLevel,
  WorkflowCoordinate,
  WorkflowStoreIndex,
  WorkflowStoreIndexEntry,
  WorkflowStoreStatePaths,
} from './store/index.ts';

export { buildDef, DefError, expandIncludes, finalizeDefs, hashDef, lintDef, loadDefFile, loadDefs, loadDefsRaw, parseDef, SUPPORTED_ENGINE_VERSION, validateDef } from './defs.ts';
export { credentialSlot, hashDefForHub, keychainServiceFor, normalizeOrigin, readStoredCredential } from './hub.ts';
export type { Credential, CredentialSlotSelector, Keychain, ReadStoredCredentialOpts } from './hub.ts';
export type { DefLoadFailure } from './defs.ts';

export { deleteCredential, ensureFreshOAuth, storeCredential } from './credentials.ts';
export type { CredentialIO } from './credentials.ts';

export {
  DSSE_SSH_NAMESPACE,
  DSSE_VERSION,
  DSSE_RECORD_PAYLOAD_TYPES,
  DsseEnvelopeError,
  isDsseRecordPayloadType,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_ORIGIN,
  PAYLOAD_TYPE_POLICY_FLOOR,
  PAYLOAD_TYPE_PUBLICATION,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
  PrincipalKeyManager,
  SshSigner,
  SshSignerError,
  assertEd25519PubText,
  assertKeyRef,
  canonicalKeyRef,
  createSshSigner,
  decodeBase64Strict,
  dsseSignEnrollmentGrant,
  dsseSignEnvelope,
  dsseSignOrigin,
  dsseSignPolicyFloor,
  dsseSignPublication,
  dsseSignRecord,
  dsseSignRevocation,
  dsseSignSubmission,
  dsseVerifyEnrollmentGrant,
  dsseVerifyEnvelope,
  dsseVerifyOrigin,
  dsseVerifyPolicyFloor,
  dsseVerifyPublication,
  dsseVerifyRecord,
  dsseVerifyRevocation,
  dsseVerifySubmission,
  encodeBase64,
  keyidFromBlob,
  keyRefHash,
  parseAllowedSigners,
  preAuthEncode,
  publicKeyDescriptor,
  allowedSignersPath,
  resolveAllowedSigners,
  resolveAllowedSignersFile,
  isDefPolicy,
  verifyPublication,
  verifyPublicationSidecar,
  DEFAULT_MACHINE_SCOPE,
  buildEnrollmentGrant,
  verifyRosterEntry,
  ENROLLMENT_GRANT_FIELDS,
  ENROLLMENT_KEY_FIELDS,
  GRANT_DELEGATION_ALLOWED_FIELDS,
  GRANT_DELEGATION_DENIED_FIELDS,
  GRANT_SCOPE_FIELDS,
  ORDER_FIELDS,
  ORDER_OWED_FIELDS,
  ORDER_REASON_FIELDS,
  POLICY_FLOOR_FIELDS,
  POLICY_FLOOR_RECORD_FIELDS,
  PRINCIPAL_REFERENCE_FIELDS,
  PUBLICATION_FIELDS,
  RECORD_PAYLOAD_TYPES,
  REVOCATION_FIELDS,
  SUBMISSION_FIELDS,
  SUBMISSION_PRODUCED_FIELDS,
} from './crypto/index.ts';
export type {
  AllowedSignerEntry,
  AllowedSignerOptions,
  AllowedSignersFile,
  AllowedSignersParseError,
  AllowedSignersResolution,
  AllowedSignersPresent,
  AllowedSignersAbsent,
  DefPolicy,
  DefVerdict,
  VerifyPublicationInput,
  VerifyPublicationOptions,
  BuildEnrollmentGrantArgs,
  EnrollmentChainValidator,
  RosterVerdict,
  VerifyRosterEntryInput,
  VerifyRosterEntryOptions,
  DetachedSignature,
  DsseEnvelope,
  DsseRecordPayloadType,
  DsseSignature,
  DsseVerifyResult,
  EnsureKeyResult,
  InspectKeyResult,
  KeyStorageBackendKind,
  PrincipalKeyRef,
  PrincipalKind,
  PublicKeyDescriptor,
  EnrollmentGrantRecord,
  EnrollmentKeyDescriptor,
  FieldManifest,
  GrantDelegation,
  GrantDelegationAllowed,
  GrantDelegationDenied,
  GrantScope,
  OptionalKeys,
  PolicyFloor,
  PolicyFloorRecord,
  PrincipalReference,
  PublicationRecord,
  RequiredKeys,
  RevocationRecord,
  SubmissionProducedArtifact,
  SubmissionRecord,
  Signer,
  SshProcessAdapter,
  SshSignerConfig,
  VerifiedSignature,
} from './crypto/index.ts';

export {
  buildGraph,
  buildTrace,
  eligibleFirings,
  graphToDot,
  graphToMermaid,
  isStalled,
  modelCheck,
  workflowStatus,
} from './model.ts';
export type { ArtifactMap, Blocker, Firing, TimeFacts, WorkflowStatus } from './model.ts';

export {
  parseConsume,
  parseProduce,
} from './paths.ts';

export { assertValidSchema, summarizeIssues, validateValue } from './schema.ts';
export type { SchemaCheck, SchemaIssue } from './schema.ts';
export {
  enrollmentGrantSchema,
  orderSchema,
  policyFloorSchema,
  publicationSchema,
  RECORD_SCHEMAS,
  revocationSchema,
  SCHEMA_BY_PAYLOAD_TYPE,
  submissionSchema,
  WIRE_SCHEMAS,
} from './schemas/index.ts';

// Deterministic `.wnlp` bundle format (WP-A1) — the HIGH-LEVEL API only:
// pack/inspect/digest/unpack plus result/manifest types, limits/options, and
// typed errors. Low-level tar builders and add install primitives are
// deliberately NOT exported through this surface (see docs/bundles.md).
export { BundleError, DEFAULT_BUNDLE_LIMITS, digestBundle, inspectBundle, packBundle, unpackBundle } from './bundle/index.ts';
export type {
  BundleEntryInfo,
  BundleErrorCode,
  BundleLimits,
  BundleManifest,
  InspectOptions,
  InspectResult,
  PackOptions,
  PackResult,
} from './bundle/index.ts';

export { DEBT_STATES, SETTLED_STATES } from './types.ts';
export type {
  Acceptance,
  ArtifactBiography,
  ArtifactData,
  Author,
  CheckFinding,
  CheckOptions,
  CheckReport,
  CheckStep,
  ConsumePattern,
  FiringTrigger,
  Fingerprint,
  GraphEdge,
  GraphNode,
  GraphNodeState,
  InputDef,
  InvariantDef,
  InvariantPredicate,
  InvariantViolation,
  JsonSchema,
  StepDef,
  ProducePattern,
  ReasonEntry,
  RejectKind,
  RunData,
  TaskData,
  TimelineEvent,
  WorkflowDef,
  WorkflowGraph,
  WorkflowTrace,
} from './types.ts';
