import { dsseSignSubmission } from './dsse.ts';
import { valueDigestHex, canonicalValueBytes } from './canonical.ts';
import type { Signer } from './ssh.ts';
import type { Fingerprint } from '../types.ts';
import type { SubmissionRecord } from './records.ts';

/** One value supplied to a submission record builder. */
export interface SubmissionProducedInput {
  artifact: string;
  version: number;
  value: unknown;
}

/** Inputs for constructing the frozen `submission.v1` record shape. */
export interface BuildSubmissionRecordInput {
  run: string;
  workflow: string;
  defDigest: string;
  step: string;
  key: string;
  index?: number;
  produced: SubmissionProducedInput[];
  consumedFingerprint: Fingerprint;
  producerKeyId: string;
  timestamp: number;
}

/**
 * Build the frozen submission record without signing or mutating the input.
 * Every consumed fingerprint entry is retained; negative values are rejected
 * because `submission.v1` only represents non-negative artifact versions.
 */
export function buildSubmissionRecord(input: BuildSubmissionRecordInput): SubmissionRecord {
  if (input.produced.length === 0) throw new RangeError('submission must contain at least one produced artifact');
  for (const [path, version] of Object.entries(input.consumedFingerprint)) {
    if (!Number.isInteger(version) || version < 0) {
      throw new RangeError(`consumed fingerprint for '${path}' must be a non-negative integer`);
    }
  }

  const produced = input.produced.map((entry) => {
    if (!Number.isInteger(entry.version) || entry.version < 0) {
      throw new RangeError(`produced version for '${entry.artifact}' must be a non-negative integer`);
    }
    return {
      artifact: entry.artifact,
      version: entry.version,
      valueDigest: valueDigestHex(entry.value),
    };
  });

  return {
    run: input.run,
    workflow: input.workflow,
    defDigest: input.defDigest,
    step: input.step,
    key: input.key,
    ...(input.index !== undefined ? { index: input.index } : {}),
    produced,
    consumedFingerprint: { ...input.consumedFingerprint },
    producerKeyId: input.producerKeyId,
    timestamp: input.timestamp,
  };
}

/**
 * Canonically serialize a submission record and sign it as a DSSE submission
 * envelope. The returned string is the opaque proof carried by a submit call.
 */
export async function signSubmission(record: SubmissionRecord, signer: Pick<Signer, 'sign'>): Promise<string> {
  const payload = Buffer.from(canonicalValueBytes(record));
  const { envelope } = await dsseSignSubmission(payload, signer);
  return Buffer.from(canonicalValueBytes(envelope)).toString('utf8');
}
