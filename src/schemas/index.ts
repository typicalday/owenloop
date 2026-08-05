/** Checked-in JSON Schemas for the launch wire contracts. */

import type { JsonSchema } from '../types.ts';
import {
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_ORIGIN,
  PAYLOAD_TYPE_POLICY_FLOOR,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
} from '../crypto/dsse.ts';
import type { DsseRecordPayloadType } from '../crypto/dsse.ts';

import enrollmentGrantSchema from './enrollment-grant.v1.schema.json' with { type: 'json' };
import orderSchema from './order.v1.schema.json' with { type: 'json' };
import policyFloorSchema from './policy-floor.v1.schema.json' with { type: 'json' };
import revocationSchema from './revocation.v1.schema.json' with { type: 'json' };
import submissionSchema from './submission.v1.schema.json' with { type: 'json' };

export {
  enrollmentGrantSchema,
  orderSchema,
  policyFloorSchema,
  revocationSchema,
  submissionSchema,
};

/** Schemas by the stable contract name used in source and documentation. */
export const WIRE_SCHEMAS = {
  enrollmentGrant: enrollmentGrantSchema,
  revocation: revocationSchema,
  submission: submissionSchema,
  policyFloor: policyFloorSchema,
  order: orderSchema,
} as const;

/** The four DSSE record schemas defined by this package. */
export const RECORD_SCHEMAS = {
  [PAYLOAD_TYPE_ENROLLMENT_GRANT]: enrollmentGrantSchema,
  [PAYLOAD_TYPE_REVOCATION]: revocationSchema,
  [PAYLOAD_TYPE_SUBMISSION]: submissionSchema,
  [PAYLOAD_TYPE_POLICY_FLOOR]: policyFloorSchema,
} as const satisfies Record<
  Exclude<DsseRecordPayloadType, typeof PAYLOAD_TYPE_ORIGIN>,
  JsonSchema
>;

/** Alias emphasizing that origin is intentionally not bound in this package. */
export const SCHEMA_BY_PAYLOAD_TYPE = RECORD_SCHEMAS;
