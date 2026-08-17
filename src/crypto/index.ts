/**
 * The public crypto surface of the owenloop engine (WP-A2).
 *
 * Three narrow capabilities that later trust work builds on:
 *   1. Principal signing keys — `PrincipalKeyManager` generates, stores, and
 *      materializes Ed25519 keys for the human/machine/agent principals
 *      (macOS Keychain, Linux libsecret, or a secure 0600 file store). No
 *      function here hands a caller private-key text.
 *   2. SSHSIG signing/verification — `SshSigner` (behind the format-neutral
 *      `Signer` interface) drives stock OpenSSH `ssh-keygen -Y`.
 *   3. DSSE envelopes — `dsseSignEnvelope`/`dsseVerifyEnvelope` plus the six
 *      versioned payload-type constants and record-class wrappers.
 *
 * Process/storage adapters stay internal unless a test seam needs the type.
 */

// ---- keys ----
export {
  PrincipalKeyManager,
  assertKeyRef,
  canonicalKeyRef,
  keyidFromBlob,
  keyRefHash,
  publicKeyDescriptor,
} from './keys.ts';
export type {
  EnsureKeyResult,
  InspectKeyResult,
  KeyCommandRunner,
  KeyStorageBackendKind,
  PrincipalKeyManagerOpts,
  PrincipalKeyRef,
  PrincipalKind,
  PublicKeyDescriptor,
} from './keys.ts';

// ---- signer / SSHSIG ----
export {
  SshSigner,
  SshSignerError,
  createSshSigner,
  assertEd25519PubText,
} from './ssh.ts';
export type {
  DetachedSignature,
  Signer,
  SshProcessAdapter,
  SshSignerConfig,
  VerifiedSignature,
} from './ssh.ts';

// ---- DSSE ----
export {
  DSSE_VERSION,
  DSSE_SSH_NAMESPACE,
  DSSE_RECORD_PAYLOAD_TYPES,
  isDsseRecordPayloadType,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_POLICY_FLOOR,
  PAYLOAD_TYPE_ORIGIN,
  PAYLOAD_TYPE_PUBLICATION,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
  DsseEnvelopeError,
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
  preAuthEncode,
} from './dsse.ts';
export type { DsseEnvelope, DsseRecordPayloadType, DsseSignature, DsseVerifyResult } from './dsse.ts';

// ---- wire records ----
export {
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
} from './records.ts';
export type {
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
} from './records.ts';

// ---- allowed_signers ----
export { parseAllowedSigners } from './allowed-signers.ts';
export type {
  AllowedSignerEntry,
  AllowedSignerOptions,
  AllowedSignersFile,
  AllowedSignersParseError,
} from './allowed-signers.ts';

// ---- publication and origin verification ----
export { allowedSignersPath, resolveAllowedSigners, resolveAllowedSignersFile } from './trust-roots.ts';
export type { AllowedSignersResolution, AllowedSignersPresent, AllowedSignersAbsent } from './trust-roots.ts';
export { isDefPolicy, verifyPublication, verifyPublicationSidecar } from './verify-publication.ts';
export type { DefPolicy, DefVerdict, VerifyPublicationInput, VerifyPublicationOptions } from './verify-publication.ts';
export { verifyOrigin, verifyOriginSidecar } from './verify-origin.ts';
export type { OriginVerdict, VerifyOriginInput, VerifyOriginOptions } from './verify-origin.ts';

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
} from './policy-floor.ts';
export type {
  PolicyFloorGap,
  PolicyFloorMergeResult,
  PolicyFloorVerdict,
  VerifyPolicyFloorInput,
  VerifyPolicyFloorOptions,
} from './policy-floor.ts';

// ---- WP-E2a origin execution policy ----
export {
  OriginRulesError,
  evaluateOriginRule,
  matchOriginRule,
  parseOriginRules,
  ORIGIN_SOURCE_RANK,
} from './origin-rules.ts';
export type {
  OriginPolicy,
  OriginRuleEvaluation,
  OriginRuleMatch,
  OriginRuleValue,
  OriginRules,
} from './origin-rules.ts';

// ---- WP-D1 enrollment ----
export {
  DEFAULT_MACHINE_SCOPE,
  buildEnrollmentGrant,
  verifyRosterEntry,
} from './enrollment.ts';
export type {
  BuildEnrollmentGrantArgs,
  EnrollmentChainValidator,
  RosterVerdict,
  VerifyRosterEntryInput,
  VerifyRosterEntryOptions,
} from './enrollment.ts';

// ---- enrollment chain ----
export {
  validateEnrollmentChain,
  validateProducer,
  revocationTemporalConsistency,
} from './chain.ts';
export type { ChainInput, ChainOptions, ChainVerdict } from './chain.ts';
export {
  attenuate,
  axisPermits,
  delegationPermits,
  ORG_ROOT_SCOPE,
  scopePermits,
} from './scope.ts';
export type { ScopeAxis } from './scope.ts';
export {
  loadGrants,
  loadRevocations,
  orgRootPrivateKeyPath,
  orgRootPublicKeyPath,
  resolveOrgRoot,
  revocationsDir,
  grantsDir,
  StrandedLegacyGrantsError,
} from './org-root.ts';
export type { OrgRootAbsent, OrgRootPresent, OrgRootResolution } from './org-root.ts';

// ---- WP-D2 signed submission records ----
export { canonicalValueBytes, valueDigestHex } from './canonical.ts';
export { buildSubmissionRecord, signSubmission } from './submission.ts';
export type { BuildSubmissionRecordInput, SubmissionProducedInput } from './submission.ts';

// ---- WP-D3 consume-side verification ----
export { verifyConsumed, verifyConsumedArtifact } from './verify-consumed.ts';
export type {
  ConsumedVerdict,
  VerifyConsumedInput,
  VerifyConsumedOptions,
} from './verify-consumed.ts';
