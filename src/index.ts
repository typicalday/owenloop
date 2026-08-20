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

export { CallsPinError, Engine, ModifierRefusalError } from './engine.ts';
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

// Routing capabilities: offer-time composition and the claim-side match. The
// hub imports these to reason about the same compounds the engine composes.
export {
  applyCapabilityMappings,
  applyCapabilityRewrites,
  capabilityName,
  claimMatches,
  composeCapabilities,
  DEFAULT_MATCH_MODE,
  MODIFIER_SEPARATOR,
} from './capabilities.ts';
export type { CapabilityMappings, CapabilityRewrites, CrewStamps, MatchMode } from './capabilities.ts';

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

export { Store, openStore, readRuntimeSnapshotBundlePins, StoreVersionError } from './store.ts';
export type { ArtifactRow, RunRow, RuntimeSnapshotBundlePins, TaskRow, WorkflowRow } from './store.ts';

// The content-addressed WORKFLOW store (distinct from the SQLite runtime
// store above): two-level digest-addressed workflow objects + coordinate
// index, `.wnlp` bundle installation, and fail-closed resolution.
export {
  defDigest,
  collectWorkflowStoreGarbage,
  emptyWorkflowStoreIndex,
  globalStoreRoot,
  hardenObjectModes,
  installWorkflowBundle,
  inspectCasDefs,
  isDefDigest,
  loadCasDefs,
  planWorkflowStoreGc,
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
  StoreOriginPolicyError,
  StorePathError,
  BundleIngestorUnavailableError,
  PreCommitVerifierUnavailableError,
  createExecutionOriginVerifier,
  originEvidencePath,
  persistOriginEvidence,
  readOriginEvidence,
} from './store/index.ts';
export type {
  BundleInstallResult,
  BundleIngestor,
  BundleSource,
  CasDefInspectionResult,
  CasDefRegistration,
  DefDigest,
  LoadCasDefsArgs,
  CollectWorkflowStoreGcArgs,
  InstallWorkflowBundleArgs,
  PreCommitVerifier,
  PlanWorkflowStoreGcArgs,
  ExecutionOriginVerifierInput,
  RecoverWorkflowStoreArgs,
  ResolvedWorkflowObject,
  ResolveWorkflowCoordinateArgs,
  ResolveWorkflowDigestArgs,
  ResolutionLevel,
  StoreLevel,
  WorkflowCoordinate,
  WorkflowStoreIndex,
  WorkflowStoreIndexEntry,
  WorkflowStoreGcObject,
  WorkflowStoreGcPlan,
  WorkflowStoreGcReport,
  WorkflowStoreStatePaths,
} from './store/index.ts';

export { buildDef, cancelCleanupSteps, DefError, expandIncludes, finalizeDefs, hashDef, lintDef, loadDefFile, loadDefs, loadDefsRaw, parseDef, resolveCallsTarget, SUPPORTED_ENGINE_VERSION, validateDef } from './defs.ts';
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
  verifyOrigin,
  verifyOriginSidecar,
  verifyPublication,
  verifyPublicationSidecar,
  verifyConsumed,
  verifyConsumedArtifact,
  DEFAULT_MACHINE_SCOPE,
  buildEnrollmentGrant,
  verifyRosterEntry,
  validateEnrollmentChain,
  validateProducer,
  revocationTemporalConsistency,
  attenuate,
  axisPermits,
  delegationPermits,
  ORG_ROOT_SCOPE,
  scopePermits,
  loadGrants,
  loadRevocations,
  orgRootPrivateKeyPath,
  orgRootPublicKeyPath,
  resolveOrgRoot,
  revocationsDir,
  grantsDir,
  StrandedLegacyGrantsError,
  ENROLLMENT_GRANT_FIELDS,
  ENROLLMENT_KEY_FIELDS,
  GRANT_DELEGATION_ALLOWED_FIELDS,
  GRANT_DELEGATION_DENIED_FIELDS,
  GRANT_SCOPE_FIELDS,
  ORDER_FIELDS,
  ORDER_OWED_FIELDS,
  ORDER_REASON_FIELDS,
  ORIGIN_FIELDS,
  ORIGIN_SOURCE_AGENT_FIELDS,
  ORIGIN_SOURCE_CONSOLE_FIELDS,
  ORIGIN_SOURCE_GIT_FIELDS,
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
  OriginVerdict,
  VerifyOriginInput,
  VerifyOriginOptions,
  ConsumedVerdict,
  VerifyConsumedInput,
  VerifyConsumedOptions,
  VerifyPublicationInput,
  VerifyPublicationOptions,
  BuildEnrollmentGrantArgs,
  EnrollmentChainValidator,
  RosterVerdict,
  VerifyRosterEntryInput,
  VerifyRosterEntryOptions,
  ChainInput,
  ChainOptions,
  ChainVerdict,
  ScopeAxis,
  OrgRootAbsent,
  OrgRootPresent,
  OrgRootResolution,
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
  OriginRecord,
  OriginSource,
  OriginSourceAgent,
  OriginSourceConsole,
  OriginSourceGit,
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

// ---- policy floors ----
export {
  DEF_POLICY_RANK,
  POLICY_FLOOR_PRESETS,
  artifactPolicyMinimum,
  floorDefPolicyMinimum,
  mergePolicyFloorWithLocal,
  originRulesMinimum,
  policyFloorGaps,
  stricterDefPolicy,
  verifyPolicyFloorRecord,
} from './crypto/index.ts';
export type {
  PolicyFloorGap,
  PolicyFloorMergeResult,
  PolicyFloorVerdict,
  VerifyPolicyFloorInput,
  VerifyPolicyFloorOptions,
} from './crypto/index.ts';

// ---- WP-E2a origin execution policy ----
export {
  ORIGIN_SOURCE_RANK,
  OriginRulesError,
  evaluateOriginRule,
  matchOriginRule,
  parseOriginRules,
} from './crypto/index.ts';
export type {
  OriginPolicy,
  OriginRuleEvaluation,
  OriginRuleMatch,
  OriginRuleValue,
  OriginRules,
} from './crypto/index.ts';

export {
  buildGraph,
  buildTrace,
  eligibleFirings,
  graphToDot,
  graphToMermaid,
  isHeld,
  isStalled,
  modelCheck,
  openQuestion,
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
  originSchema,
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
  BundleRuntimeRequirements,
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
  OnCancelDef,
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

// ---- WP-D2 signed submission records ----
export { canonicalValueBytes, valueDigestHex, buildSubmissionRecord, signSubmission } from './crypto/index.ts';
export type { BuildSubmissionRecordInput, SubmissionProducedInput } from './crypto/index.ts';
