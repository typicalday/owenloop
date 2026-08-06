import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PAYLOAD_TYPE_SUBMISSION,
  buildSubmissionRecord,
  canonicalValueBytes,
  dsseVerifySubmission,
  signSubmission,
  valueDigestHex,
} from '../src/crypto/index.ts';
import { submissionSchema } from '../src/schemas/index.ts';
import { validateValue } from '../src/schema.ts';

const BASE = {
  run: 'run-1',
  workflow: 'wf-1',
  defDigest: 'def-1',
  step: 'producer',
  key: '',
  produced: [{ artifact: 'result', version: 1, value: { z: '終', a: [2, { b: true, a: 1 }] } }],
  consumedFingerprint: { input: 0, config: 2 },
  producerKeyId: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  timestamp: 1785800000000,
};

test('canonicalValueBytes sorts object keys recursively but preserves array order', () => {
  const left = { z: { b: 2, a: 1 }, list: [{ y: 'é', x: 3 }, 4] };
  const right = { list: [{ x: 3, y: 'é' }, 4], z: { a: 1, b: 2 } };
  assert.deepEqual(canonicalValueBytes(left), canonicalValueBytes(right));
  assert.equal(new TextDecoder().decode(canonicalValueBytes({ list: [2, 1] })), '{"list":[2,1]}');
  assert.equal(new TextDecoder().decode(canonicalValueBytes({ unicode: '雪' })), '{"unicode":"雪"}');
  assert.notEqual(valueDigestHex({ list: [2, 1] }), valueDigestHex({ list: [1, 2] }));
});

test('buildSubmissionRecord computes value digests and omits absent index', () => {
  const record = buildSubmissionRecord(BASE);
  assert.equal('index' in record, false);
  assert.equal(record.produced[0]!.valueDigest, valueDigestHex(BASE.produced[0]!.value));
  assert.deepEqual(record.consumedFingerprint, BASE.consumedFingerprint);
  assert.equal(validateValue(submissionSchema, record).valid, true);
  BASE.consumedFingerprint.input = 0;
});

test('buildSubmissionRecord rejects negative consumed and produced versions', () => {
  assert.throws(
    () => buildSubmissionRecord({ ...BASE, consumedFingerprint: { missing: -1 } }),
    /consumed fingerprint.*non-negative integer/,
  );
  assert.throws(
    () => buildSubmissionRecord({ ...BASE, produced: [{ artifact: 'result', version: -1, value: {} }] }),
    /produced version.*non-negative integer/,
  );
  assert.throws(() => buildSubmissionRecord({ ...BASE, produced: [] }), /at least one produced/);
});

test('signSubmission returns a DSSE envelope that round-trips through submission verification', async () => {
  const record = buildSubmissionRecord(BASE);
  const signature = Buffer.from('detached-signature');
  const signer = {
    async sign(bytes: Buffer) {
      assert.ok(bytes.length > 0);
      return { keyid: BASE.producerKeyId, sig: signature };
    },
    async verify(_bytes: Buffer, candidate: Buffer) {
      return candidate.equals(signature)
        ? { keyid: BASE.producerKeyId, principal: 'producer', format: 'sshsig' as const }
        : null;
    },
  };
  const serialized = await signSubmission(record, signer);
  const envelope = JSON.parse(serialized) as { payloadType: string; payload: string; signatures: unknown[] };
  assert.equal(envelope.payloadType, PAYLOAD_TYPE_SUBMISSION);
  assert.equal(envelope.signatures.length, 1);
  const verified = await dsseVerifySubmission(envelope, signer);
  assert.deepEqual(JSON.parse(verified.payloadBytes.toString('utf8')), record);
});
