/** Parent-only specific observations. Each result is fresh for this operation;
 * local signed-source/producer verification and later reopens remain separate. */
import { isDeepStrictEqual } from 'node:util';

import type { RoutedConcreteCallObservation, RoutedConcreteCallRequest } from '../../../../src/store/instruction-source.ts';
import type { ContactHolder, GetOrderResponse } from '../hub/types.ts';
import type { RoutedInputPair, RoutedInputPhase } from './trusted-input-admission.ts';
import { concreteBindingRequestBody, parseRoutedConcreteCallBinding,
  type ConcreteCallBindingKey, type VerifiedConcreteCallReceipt } from './trusted-routed-concrete-binding.ts';
import { concreteStructureRequestBody, parseRoutedConcreteCallStructure } from './trusted-routed-concrete-call.ts';
import { parseRoutedServiceRecordedPairV2 } from './trusted-routed-recorded-v2.ts';
import { createRoutedV2Requester, parseRoutedServicePrestartPairV2,
  type RoutedV2TransportOptions } from './trusted-routed-reference-v2.ts';

export type StructurePairObservation = { pair: RoutedInputPair; selected: RoutedConcreteCallObservation };
export type FoldedPairObservation = { pair: RoutedInputPair; selected: VerifiedConcreteCallReceipt | undefined };
export type OrderPairObservation = { response: GetOrderResponse; pair: RoutedInputPair };
type Domain = 'structure' | 'folded' | 'order';
const PROTOCOL = { structure: 'owenloop-concrete-structure-pair-v3',
  folded: 'owenloop-concrete-binding-pair-v3', order: 'owenloop-routing-order-pair-v3' };
const ROUTE = { structure: 'read_concrete_structure_pair', folded: 'read_concrete_binding_pair',
  order: 'read_routing_order_pair' };
const object = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);
const refused = () => new Error('routed coherent observation refused');
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
function bounded(value: unknown, bytes: number, nodesLimit = 150_000, depthLimit = 128) {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > nodesLimit || entry.depth > depthLimit) throw refused();
    if (entry.value !== null && typeof entry.value === 'object')
      for (const value of Object.values(entry.value)) pending.push({ value, depth: entry.depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(value)) > bytes) throw refused();
}
export function parseCoherentObservation(raw: unknown, domain: Domain, phase: RoutedInputPhase,
  expected: { workflow: string; run: string; origin: string; orgId: string }) {
  bounded(raw, domain === 'structure' ? 6_200_000 : 34_200_000);
  if (!object(raw) || raw.protocol !== PROTOCOL[domain] || raw.phase !== phase
    || raw.workflow !== expected.workflow || raw.run !== expected.run) throw refused();
  if (raw.state === 'unavailable') {
    if (!exact(raw, ['protocol', 'phase', 'state', 'workflow', 'run'])) throw refused();
    throw new Error('routed coherent observation unavailable');
  }
  if (raw.state !== 'available' || raw.origin !== expected.origin || raw.orgId !== expected.orgId
    || !exact(raw, ['protocol', 'phase', 'state', 'workflow', 'run', 'origin', 'orgId', 'pair', domain])) throw refused();
  bounded(raw.pair, 4_100_000, 50_000, 64);
  if (!object(raw.pair)) throw refused();
  bounded(raw.pair.reference, 2_000_000, 50_000, 64);
  bounded(raw.pair.claim, 2_000_000, 50_000, 64);
  const pair = phase === 'prestart' ? parseRoutedServicePrestartPairV2(raw.pair, expected)
    : parseRoutedServiceRecordedPairV2(raw.pair, expected);
  bounded(raw[domain], domain === 'structure' ? 2_000_000 : 30_000_000, 50_000, 64);
  return { pair, member: raw[domain] };
}
export function createCoherentRoutingReaders(options: RoutedV2TransportOptions & { orgId: string }) {
  const { now, request } = createRoutedV2Requester(options);
  const expected = { ...options.expected, origin: options.origin, orgId: options.orgId };
  const read = async (domain: Domain, phase: RoutedInputPhase, body: unknown) => {
    if (Buffer.byteLength(JSON.stringify(body)) > (domain === 'order' ? 2_048 : 16_384)) throw refused();
    const started = now();
    const raw = await request(`/api/${ROUTE[domain]}${phase === 'prestart' ? '/v3' : '/live/v3'}`, started, body);
    const checkDeadline = () => { if (now() - started >= 5_000) throw new Error('routed coherent observation deadline'); };
    const parsed = parseCoherentObservation(raw, domain, phase, expected);
    checkDeadline();
    return { ...parsed, checkDeadline };
  };
  return {
    async structure(selection: RoutedConcreteCallRequest, phase: RoutedInputPhase): Promise<StructurePairObservation> {
      const { pair, member, checkDeadline } = await read('structure', phase, concreteStructureRequestBody(selection, options.expected));
      const selected = parseRoutedConcreteCallStructure(member, { request: selection, phase,
	expected: { ...expected, binding: pair.reference.binding } });
      checkDeadline();
      return { pair, selected };
    },
    async folded(key: ConcreteCallBindingKey, phase: RoutedInputPhase): Promise<FoldedPairObservation> {
      const { pair, member, checkDeadline } = await read('folded', phase, concreteBindingRequestBody(key, options.expected));
      const selected = parseRoutedConcreteCallBinding(member, { key, phase,
	expected: { ...expected, binding: pair.reference.binding } });
      checkDeadline();
      return { pair, selected };
    },
    async order(holder: ContactHolder | undefined, phase: RoutedInputPhase): Promise<OrderPairObservation> {
      if (holder !== undefined && (!object(holder) || !['session', 'exec'].includes(holder.kind)
	|| typeof holder.id !== 'string' || holder.id.length < 1 || holder.id.length > 512
	|| (holder.shiftId !== undefined && (typeof holder.shiftId !== 'string'
	  || holder.shiftId.length < 1 || holder.shiftId.length > 512))
	|| !exact(holder, holder.shiftId === undefined ? ['kind', 'id'] : ['kind', 'id', 'shiftId']))) throw refused();
      const { pair, member, checkDeadline } = await read('order', phase,
	{ workflow: options.expected.workflow, run: options.expected.run, ...(holder === undefined ? {} : { holder }) });
      // Preserve the entire normal get_order projection. Broker and stage still
      // validate its private packet, lease, owes, relays and signed definition.
      if (!object(member) || typeof member.text !== 'string' || !object(member.lease)
	|| member.lease.claimed !== true || !object(member.order)
	|| member.run !== options.expected.run || member.workflow !== pair.reference.binding.frameWorkflow
	|| member.order.workflow !== member.workflow || member.order.run !== member.run
	|| !isDeepStrictEqual(member.order.routing, pair.claim.routing)) throw refused();
      checkDeadline();
      return { pair, response: member as unknown as GetOrderResponse };
    },
  };
}
