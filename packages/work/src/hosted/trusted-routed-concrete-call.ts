/** Parent-only structural selection for one Service-owned concrete call edge.
 * It carries no folded value or producer proof. */
import { isDeepStrictEqual } from 'node:util';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { DefRef } from '../../../../src/types.ts';
import type { RoutedConcreteCallObservation, RoutedConcreteCallRequest } from '../../../../src/store/instruction-source.ts';
import { createRoutedV2Requester, type RoutedV2TransportOptions } from './trusted-routed-reference-v2.ts';

export type ConcreteCallPhase = 'prestart' | 'recorded-live';
const refused = (): Error => new Error('routed concrete call structure refused');
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
const ref = (value: unknown): value is DefRef => {
  const row = record(value);
  return !!row && exact(row, ['bundleDigest', 'workflowName'])
    && hex(row.bundleDigest) && nonempty(row.workflowName);
};

const EDGE = ['kind', 'parentDefRef', 'callStep', 'callPath', 'target', 'childDefRef'];
function validEdge(value: unknown): value is Record<string, unknown> {
  const row = record(value);
  if (!row || !ref(row.parentDefRef) || !ref(row.childDefRef)
    || !nonempty(row.callStep) || !nonempty(row.callPath) || !nonempty(row.target)) return false;
  if (row.receiptDigest !== undefined) return false;
  const keys = EDGE;
  switch (row.kind) {
    case 'selected-native-concrete-child':
      return exact(row, [...keys, 'parentWorkflow', 'childWorkflow'])
	&& nonempty(row.parentWorkflow) && nonempty(row.childWorkflow);
    case 'prestart-live-concrete-child':
      return exact(row, [...keys, 'parentWorkflow', 'observedLiveVersion'])
	&& nonempty(row.parentWorkflow) && positive(row.observedLiveVersion);
    case 'virtual-live-concrete-child':
      return exact(row, [...keys, 'observedLiveVersion']) && positive(row.observedLiveVersion);
    case 'prestart-exact-concrete-child':
      return exact(row, [...keys, 'parentWorkflow']) && nonempty(row.parentWorkflow);
    case 'virtual-exact-concrete-child':
      return exact(row, keys);
    default: return false;
  }
}

/** Strictly bind every ancestry prediction and the final authored edge to the
 * original-session response. The Service observes native snapshots itself;
 * request child refs are assertions, never selection authority. */
export function parseRoutedConcreteCallStructure(raw: unknown, args: {
  request: RoutedConcreteCallRequest; phase: ConcreteCallPhase;
  expected: { workflow: string; run: string; origin: string; orgId: string;
    binding: unknown };
}): RoutedConcreteCallObservation {
  const wire = record(raw);
  if (!wire || Buffer.byteLength(JSON.stringify(raw)) > 2_000_000
    || !exact(wire, ['protocol', 'state', 'workflow', 'run', 'origin', 'orgId',
      'binding', 'selected', 'freshness', 'atomicLaunch'])
    || wire.protocol !== (args.phase === 'prestart'
      ? 'owenloop-concrete-call-structure-v1' : 'owenloop-concrete-call-structure-recorded-v1')
    || wire.state !== 'available' || wire.workflow !== args.expected.workflow
    || wire.run !== args.expected.run || wire.origin !== args.expected.origin
    || wire.orgId !== args.expected.orgId || wire.freshness !== 'fresh-at-read'
    || wire.atomicLaunch !== false || !isDeepStrictEqual(wire.binding, args.expected.binding))
    throw refused();
  const selected = record(wire.selected);
  const receipt = record(selected?.receipt);
  if (!selected || !exact(selected, ['receipt', 'receiptDigest'])
    || !hex(selected.receiptDigest) || !receipt
    || valueDigestHex(receipt) !== selected.receiptDigest
    || !exact(receipt, ['kind', 'rootWorkflow', 'frameWorkflow', 'frameDefRef', 'ancestry', 'edge'])
    || receipt.kind !== 'root-bound-concrete-structure'
    || receipt.rootWorkflow !== args.request.rootWorkflow
    || receipt.frameWorkflow !== args.request.frameWorkflow
    || !isDeepStrictEqual(receipt.frameDefRef, args.request.frameDefRef)
    || !Array.isArray(receipt.ancestry)
    || receipt.ancestry.length !== args.request.ancestry.length
    || receipt.ancestry.length >= 64) throw refused();
  for (let index = 0; index < receipt.ancestry.length; index++) {
    const observed = receipt.ancestry[index];
    const predicted = args.request.ancestry[index]!;
    if (!validEdge(observed)
      || !isDeepStrictEqual(observed.parentDefRef, predicted.parentDefRef)
      || observed.callStep !== predicted.callStep || observed.callPath !== predicted.callPath
      || observed.target !== predicted.target
      || !isDeepStrictEqual(observed.childDefRef, predicted.childDefRef)
      || (predicted.selectionSource === 'service-observed' ? !hex(predicted.receiptDigest)
	|| valueDigestHex({ kind: receipt.kind, rootWorkflow: receipt.rootWorkflow,
	  frameWorkflow: receipt.frameWorkflow, frameDefRef: receipt.frameDefRef,
	  ancestry: receipt.ancestry.slice(0, index), edge: observed }) !== predicted.receiptDigest
	: predicted.selectionSource !== 'signed-static'
	  || predicted.receiptDigest !== undefined)) throw refused();
  }
  const edge = receipt.edge;
  if (!validEdge(edge) || !['selected-native-concrete-child', 'prestart-live-concrete-child',
    'virtual-live-concrete-child'].includes(String(edge.kind))
    || !isDeepStrictEqual(edge.parentDefRef, args.request.edge.parentDefRef)
    || edge.callStep !== args.request.edge.callStep || edge.callPath !== args.request.edge.callPath
    || edge.target !== args.request.edge.target
    || (args.request.parentWorkflow !== undefined && edge.parentWorkflow !== args.request.parentWorkflow))
    throw refused();
  return { kind: edge.kind, childDefRef: edge.childDefRef,
    ...(edge.parentWorkflow === undefined ? {} : { parentWorkflow: edge.parentWorkflow }),
    ...(edge.childWorkflow === undefined ? {} : { childWorkflow: edge.childWorkflow }),
    ...(edge.observedLiveVersion === undefined ? {} : { observedLiveVersion: edge.observedLiveVersion }),
    receiptDigest: selected.receiptDigest } as RoutedConcreteCallObservation;
}

export function createDirectRoutedConcreteCallReader(options: RoutedV2TransportOptions & {
  orgId: string;
}): (request: RoutedConcreteCallRequest, phase: ConcreteCallPhase,
  binding: unknown) => Promise<RoutedConcreteCallObservation> {
  const { now, request } = createRoutedV2Requester(options);
  return async (selection, phase, binding) => {
    if (selection.rootWorkflow !== options.expected.workflow
      || selection.run !== options.expected.run
      || !ref(selection.frameDefRef)
      || !ref(selection.edge.parentDefRef)
      || selection.ancestry.length >= 64
      || selection.ancestry.some(edge => !ref(edge.parentDefRef)
	|| !ref(edge.childDefRef) || !nonempty(edge.callStep)
	|| !nonempty(edge.callPath) || !nonempty(edge.target)
	|| (edge.selectionSource === 'service-observed'
	  ? !hex(edge.receiptDigest)
	  : edge.selectionSource !== 'signed-static'
	    || edge.receiptDigest !== undefined))) throw refused();
    const body = { workflow: options.expected.workflow, orderId: options.expected.run,
      frameDefRef: selection.frameDefRef,
      ancestry: selection.ancestry.map(edge => ({ parentDefRef: edge.parentDefRef,
	callStep: edge.callStep, callPath: edge.callPath, childDefRef: edge.childDefRef,
	...(edge.receiptDigest === undefined ? {} : { receiptDigest: edge.receiptDigest }) })),
      callStep: selection.edge.callStep, callPath: selection.edge.callPath };
    const raw = await request(phase === 'prestart'
      ? '/api/read_concrete_call_structure' : '/api/read_concrete_call_structure/live/v2',
    now(), body);
    return parseRoutedConcreteCallStructure(raw, { request: selection, phase,
      expected: { ...options.expected, origin: options.origin, orgId: options.orgId,
	binding } });
  };
}
