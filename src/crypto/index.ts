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
 *   3. DSSE envelopes — `dsseSignEnvelope`/`dsseVerifyEnvelope` plus the five
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
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
  DsseEnvelopeError,
  decodeBase64Strict,
  dsseSignEnrollmentGrant,
  dsseSignEnvelope,
  dsseSignOrigin,
  dsseSignPolicyFloor,
  dsseSignRecord,
  dsseSignRevocation,
  dsseSignSubmission,
  dsseVerifyEnrollmentGrant,
  dsseVerifyEnvelope,
  dsseVerifyOrigin,
  dsseVerifyPolicyFloor,
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
  POLICY_FLOOR_FIELDS,
  POLICY_FLOOR_RECORD_FIELDS,
  PRINCIPAL_REFERENCE_FIELDS,
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
  PolicyFloor,
  PolicyFloorRecord,
  PrincipalReference,
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
