/** Read-only input witness for an already entered, parent-owned routed role. */
import type { RoutingChildClient } from '../hub/routing-child-client.ts';
import { isDeepStrictEqual } from 'node:util';
import {
  createRoutedV2Requester, parseRoutedClaimV2, parseRoutedReferenceV2,
  type RoutedClaimV2, type RoutedReferenceBindingV2, type RoutedReferenceV2,
  type RoutedV2TransportOptions,
} from './trusted-routed-reference-v2.ts';

export interface RecordedOccurrenceV2 {
  reservationId: string;
  reportDigest: string;
  recordedAt: number;
  attemptId: string;
}
export type RecordedBindingV2 = RoutedReferenceBindingV2 & { recordedOccurrence: RecordedOccurrenceV2 };
export type RecordedReferenceV2 =
  | (Omit<Extract<RoutedReferenceV2, { state: 'available' }>, 'protocol' | 'binding'> & {
      protocol: 'trusted-routed-recorded-reference-read-v2'; binding: RecordedBindingV2 })
  | { protocol: 'trusted-routed-recorded-reference-read-v2'; state: 'unavailable' | 'unsupported-feedback';
      workflow: string; run: string };
export type RecordedClaimV2 =
  | (Omit<Extract<RoutedClaimV2, { state: 'available' }>, 'protocol' | 'binding'> & {
      protocol: 'routing-recorded-claim-read-v2'; binding: RecordedBindingV2 })
  | { protocol: 'routing-recorded-claim-read-v2'; state: 'unavailable'; workflow: string; run: string };
export type RoutedServiceRecordedPairV2 = {
  reference: Extract<RecordedReferenceV2, { state: 'available' }>;
  claim: Extract<RecordedClaimV2, { state: 'available' }>;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);

function occurrence(raw: unknown, attemptId: unknown): RecordedOccurrenceV2 {
  const row = record(raw);
  if (!row || !keys(row, ['reservationId', 'reportDigest', 'recordedAt', 'attemptId'])
    || !id(row.reservationId) || typeof row.reportDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.reportDigest)
    || !Number.isSafeInteger(row.recordedAt) || (row.recordedAt as number) < 0
    || !id(row.attemptId) || row.attemptId !== attemptId)
    throw new Error('routed recorded occurrence refused');
  return row as unknown as RecordedOccurrenceV2;
}

function recordedBinding(raw: unknown, routing: unknown): {
  ordinary: RoutedReferenceBindingV2; full: RecordedBindingV2
} {
  const binding = record(raw);
  const claim = record(record(routing)?.claim);
  if (!binding || !claim || !Object.hasOwn(binding, 'recordedOccurrence'))
    throw new Error('routed recorded binding refused');
  const { recordedOccurrence, ...ordinary } = binding;
  const parsed = occurrence(recordedOccurrence, claim.attemptId);
  return { ordinary: ordinary as unknown as RoutedReferenceBindingV2,
    full: { ...ordinary, recordedOccurrence: parsed } as RecordedBindingV2 };
}

export function parseRecordedReferenceV2(raw: unknown,
  expected: { workflow: string; run: string }): RecordedReferenceV2 {
  const wire = record(raw);
  if (!wire || wire.protocol !== 'trusted-routed-recorded-reference-read-v2')
    throw new Error('routed recorded reference refused');
  if (wire.state !== 'available') {
    parseRoutedReferenceV2({ ...wire, protocol: 'trusted-routed-reference-read-v2' }, expected);
    return wire as RecordedReferenceV2;
  }
  const binding = recordedBinding(wire.binding, record(wire.order)?.routing);
  parseRoutedReferenceV2({ ...wire, protocol: 'trusted-routed-reference-read-v2',
    binding: binding.ordinary }, expected);
  return wire as RecordedReferenceV2;
}

export function parseRecordedClaimV2(raw: unknown,
  expected: { workflow: string; run: string }): RecordedClaimV2 {
  const wire = record(raw);
  if (!wire || wire.protocol !== 'routing-recorded-claim-read-v2')
    throw new Error('routed recorded claim refused');
  if (wire.state !== 'available') {
    parseRoutedClaimV2({ ...wire, protocol: 'routing-claim-read-v2' }, expected);
    return wire as RecordedClaimV2;
  }
  const binding = recordedBinding(wire.binding, wire.routing);
  parseRoutedClaimV2({ ...wire, protocol: 'routing-claim-read-v2', binding: binding.ordinary }, expected);
  return wire as RecordedClaimV2;
}

export function parseRoutedServiceRecordedPairV2(raw: unknown,
  expected: { workflow: string; run: string }): RoutedServiceRecordedPairV2 {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(raw)); }
  catch { throw new Error('routed recorded pair exceeds bounds'); }
  if (bytes > 4_100_000) throw new Error('routed recorded pair exceeds bounds');
  const wire = record(raw);
  if (!wire || wire.protocol !== 'routed-recorded-input-pair-v2' || wire.phase !== 'recorded-live'
    || !keys(wire, ['protocol', 'phase', 'reference', 'claim']))
    throw new Error('routed recorded pair envelope refused');
  const reference = parseRecordedReferenceV2(wire.reference, expected);
  if (reference.state !== 'available') {
    const skipped = record(wire.claim);
    if (!skipped || !keys(skipped, ['state']) || skipped.state !== 'skipped')
      throw new Error('routed recorded pair skip refused');
    throw new Error('routed recorded reference unavailable');
  }
  const claim = parseRecordedClaimV2(wire.claim, expected);
  if (claim.state !== 'available' || !isDeepStrictEqual(reference.binding, claim.binding)
    || !isDeepStrictEqual(reference.order.routing, claim.routing))
    throw new Error('routed recorded pair changed');
  return { reference, claim };
}

export function createRecordedRoutedInputPairV2Reader(options: RoutedV2TransportOptions): {
  read(): Promise<RoutedServiceRecordedPairV2>;
} {
  const { now, request } = createRoutedV2Requester(options);
  return { read: async () => parseRoutedServiceRecordedPairV2(
    await request('/api/read_routing_input_pair/live/v2', now()), options.expected) };
}

export function createRecordedRoutedV2Reader(options: RoutedV2TransportOptions): {
  readReference(): Promise<RecordedReferenceV2>; readClaim(): Promise<RecordedClaimV2>;
} {
  const { now, request } = createRoutedV2Requester(options);
  return {
    readReference: async () => parseRecordedReferenceV2(
      await request('/api/routing_reference_order/live/v2', now()), options.expected),
    readClaim: async () => parseRecordedClaimV2(
      await request('/api/read_routing_claim/live/v2', now()), options.expected),
  };
}

export function createBrokerRecordedRoutedV2Reader(client: Pick<RoutingChildClient,
  'readLiveRoutedReferenceV2' | 'readLiveRoutingClaimV2'>,
expected: { workflow: string; run: string }, now = () => performance.now()): {
  read(): Promise<{ reference: RecordedReferenceV2; claim: RecordedClaimV2 }>;
} {
  return { async read() {
    const started = now();
    const reference = parseRecordedReferenceV2(await client.readLiveRoutedReferenceV2(expected), expected);
    if (now() - started >= 5_000) throw new Error('routed recorded observation expired');
    if (reference.state !== 'available') return { reference,
      claim: { protocol: 'routing-recorded-claim-read-v2', state: 'unavailable', ...expected } };
    const claim = parseRecordedClaimV2(await client.readLiveRoutingClaimV2(expected), expected);
    if (now() - started >= 5_000) throw new Error('routed recorded observation expired');
    if (claim.state !== 'available') throw new Error('routed recorded claim unavailable');
    if (!isDeepStrictEqual(claim.binding, reference.binding)
      || !isDeepStrictEqual(claim.routing, reference.order.routing))
      throw new Error('routed recorded occurrence changed');
    return { reference, claim };
  } };
}
