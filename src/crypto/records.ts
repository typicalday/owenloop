/**
 * Type-level definitions for the versioned records carried in DSSE envelopes.
 *
 * This module defines shapes only. Signing, verification, enrollment, revocation
 * processing, scope attenuation, and policy evaluation belong to later layers.
 * Field manifests intentionally sit beside each type: TypeScript checks the
 * manifest against the type, while the wire-contract test checks the manifest
 * against the checked-in JSON Schema. Neither side is generated from the other,
 * so a drift changes a deliberate check into a failure instead of being hidden.
 */

import {
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_ORIGIN,
  PAYLOAD_TYPE_POLICY_FLOOR,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
} from './dsse.ts';
import type { DsseRecordPayloadType } from './dsse.ts';
import type { PrincipalKeyRef, PublicKeyDescriptor } from './keys.ts';
import type { Fingerprint, Order } from '../types.ts';

/** The fields that are mandatory or optional on a record type. */
export type RequiredKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? never : K;
}[keyof T];

export type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

export type FieldManifest<T> = {
  [K in RequiredKeys<T>]: 'required';
} & {
  [K in OptionalKeys<T>]: 'optional';
};

/** One value produced by a submission record. */
export interface SubmissionProducedArtifact {
  artifact: string;
  version: number;
  valueDigest: string;
}

/**
 * A countersigned description of one producer result. `defDigest` is a
 * non-empty opaque reference to the instruction snapshot used for the run;
 * the resolver seam deliberately permits values that are not a hex digest.
 * `producerKeyId` uses the existing `SHA256:<unpadded-base64>` public-key
 * fingerprint convention.
 */
export interface SubmissionRecord {
  run: string;
  workflow: string;
  defDigest: string;
  step: string;
  key: string;
  index?: number;
  produced: SubmissionProducedArtifact[];
  consumedFingerprint: Fingerprint;
  producerKeyId: string;
  timestamp: number;
}

export const SUBMISSION_FIELDS = {
  run: 'required',
  workflow: 'required',
  defDigest: 'required',
  step: 'required',
  key: 'required',
  index: 'optional',
  produced: 'required',
  consumedFingerprint: 'required',
  producerKeyId: 'required',
  timestamp: 'required',
} as const satisfies FieldManifest<SubmissionRecord>;

export const SUBMISSION_PRODUCED_FIELDS = {
  artifact: 'required',
  version: 'required',
  valueDigest: 'required',
} as const satisfies FieldManifest<SubmissionProducedArtifact>;

/**
 * The public key descriptor embedded in an enrollment grant. The field names
 * reuse `PublicKeyDescriptor`; `comment` remains optional on the wire because
 * a grant does not need a human-readable label.
 */
export type EnrollmentKeyDescriptor = Pick<
  PublicKeyDescriptor,
  'keyid' | 'keyType' | 'openSshPublicKey'
> & {
  comment?: string;
};

/** A principal identity without the local key-store origin. */
export type PrincipalReference = Pick<PrincipalKeyRef, 'kind' | 'id'>;

/** The three scope axes and the delegation limit on an enrollment grant. */
export interface GrantScope {
  /** `'*'` means every pool; `[]` means no pools. */
  pools: string[] | '*';
  /** `'*'` means every label; `[]` means no labels. */
  labels: string[] | '*';
  /** `'*'` means every namespace; `[]` means no namespaces. */
  namespaces: string[] | '*';
  delegation: GrantDelegation;
}

/** A grant that cannot delegate. `maxDepth` is intentionally unreachable. */
export interface GrantDelegationDenied {
  allowed: false;
}

/** A grant that can delegate up to a finite depth or without a depth bound. */
export interface GrantDelegationAllowed {
  allowed: true;
  maxDepth: number | 'unbounded';
}

export type GrantDelegation = GrantDelegationDenied | GrantDelegationAllowed;

/**
 * A signed enrollment grant. The scope is complete: each axis is required,
 * and `'*'` is distinct from an empty list so later attenuation cannot guess
 * whether an omitted or empty value means nothing or everything.
 */
export interface EnrollmentGrantRecord {
  newKey: EnrollmentKeyDescriptor;
  principal: PrincipalReference;
  scope: GrantScope;
  grantedBy: string;
  validFrom: number;
}

export const ENROLLMENT_GRANT_FIELDS = {
  newKey: 'required',
  principal: 'required',
  scope: 'required',
  grantedBy: 'required',
  validFrom: 'required',
} as const satisfies FieldManifest<EnrollmentGrantRecord>;

export const ENROLLMENT_KEY_FIELDS = {
  keyid: 'required',
  keyType: 'required',
  openSshPublicKey: 'required',
  comment: 'optional',
} as const satisfies FieldManifest<EnrollmentKeyDescriptor>;

export const PRINCIPAL_REFERENCE_FIELDS = {
  kind: 'required',
  id: 'required',
} as const satisfies FieldManifest<PrincipalReference>;

export const GRANT_SCOPE_FIELDS = {
  pools: 'required',
  labels: 'required',
  namespaces: 'required',
  delegation: 'required',
} as const satisfies FieldManifest<GrantScope>;

export const GRANT_DELEGATION_DENIED_FIELDS = {
  allowed: 'required',
} as const satisfies FieldManifest<GrantDelegationDenied>;

export const GRANT_DELEGATION_ALLOWED_FIELDS = {
  allowed: 'required',
  maxDepth: 'required',
} as const satisfies FieldManifest<GrantDelegationAllowed>;

/**
 * A forward or backdated revocation declaration. Verification must cross-check
 * `backdated` against the two timestamps; keeping both fields makes the cut
 * point explicit while making the signer intent structurally visible.
 */
export interface RevocationRecord {
  revokedKey: string;
  principal: PrincipalReference;
  revokedBy: string;
  issuedAt: number;
  effectiveFrom: number;
  backdated: boolean;
  reason?: string;
}

export const REVOCATION_FIELDS = {
  revokedKey: 'required',
  principal: 'required',
  revokedBy: 'required',
  issuedAt: 'required',
  effectiveFrom: 'required',
  backdated: 'required',
  reason: 'optional',
} as const satisfies FieldManifest<RevocationRecord>;

/** The normative axes in a relayed policy floor. */
export interface PolicyFloor {
  trustMode: 'seamless' | 'strict' | 'paranoid';
  unsignedDefs: 'warn' | 'refuse';
  unsignedArtifacts: 'warn' | 'refuse';
  originRules: 'advisory' | 'enforced';
}

/**
 * An admin-signed minimum policy. A local driver may require more than this
 * floor; the record has no ceiling that a relaying transport could use to
 * weaken local policy. `preset` is a label, not a replacement for `floor`.
 */
export interface PolicyFloorRecord {
  org: string;
  issuedAt: number;
  signedBy: string;
  floor: PolicyFloor;
  preset?: 'L0' | 'L1' | 'L2';
}

export const POLICY_FLOOR_RECORD_FIELDS = {
  org: 'required',
  issuedAt: 'required',
  signedBy: 'required',
  floor: 'required',
  preset: 'optional',
} as const satisfies FieldManifest<PolicyFloorRecord>;

export const POLICY_FLOOR_FIELDS = {
  trustMode: 'required',
  unsignedDefs: 'required',
  unsignedArtifacts: 'required',
  originRules: 'required',
} as const satisfies FieldManifest<PolicyFloor>;

/** The existing frozen reference-mode Order is the fifth launch contract. */
export const ORDER_FIELDS = {
  run: 'required',
  workflow: 'required',
  step: 'required',
  key: 'required',
  index: 'optional',
  defDigest: 'required',
  inputs: 'required',
  outputs: 'required',
  workdir: 'optional',
  model: 'optional',
  worker: 'optional',
  spec: 'optional',
  x: 'optional',
  consumes: 'required',
  owes: 'required',
  consumesProof: 'optional',
  cause: 'optional',
} as const satisfies FieldManifest<Order>;

/** Indexed access pins the already-emitted nested Order shape without cloning it. */
export const ORDER_OWED_FIELDS = {
  path: 'required',
  judgmentRejects: 'required',
  schemaRejects: 'required',
  reasons: 'required',
  proof: 'optional',
} as const satisfies FieldManifest<Order['owes'][number]>;

export const ORDER_REASON_FIELDS = {
  at: 'required',
  action: 'required',
  kind: 'required',
  by: 'required',
  text: 'required',
  fromVersion: 'optional',
} as const satisfies FieldManifest<Order['owes'][number]['reasons'][number]>;

/**
 * Bind the four record definitions in this package to the frozen DSSE media
 * types. The origin payload type is deliberately reserved for the origin work
 * package; it is not silently accepted as an arbitrary fifth binding here.
 */
export const RECORD_PAYLOAD_TYPES = {
  enrollmentGrant: PAYLOAD_TYPE_ENROLLMENT_GRANT,
  revocation: PAYLOAD_TYPE_REVOCATION,
  submission: PAYLOAD_TYPE_SUBMISSION,
  policyFloor: PAYLOAD_TYPE_POLICY_FLOOR,
} as const satisfies Record<
  'enrollmentGrant' | 'revocation' | 'submission' | 'policyFloor',
  Exclude<DsseRecordPayloadType, typeof PAYLOAD_TYPE_ORIGIN>
>;
