/** Parent-owned folded proof for one already selected native concrete child.
 * Structural preview is intentionally excluded: it has no producer authority. */
import { isDeepStrictEqual } from 'node:util';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { DefRef } from '../../../../src/types.ts';
import { createRoutedV2Requester, type RoutedV2TransportOptions } from './trusted-routed-reference-v2.ts';

export interface ConcreteCallBindingKey {
  parentWorkflow: string;
  parentDefRef: DefRef;
  callPath: string;
  parentArtifactVersion: number;
}
export interface ConcreteCallBindingReceipt {
  kind: 'concrete-call';
  parentWorkflow: string;
  parentDefRef: DefRef;
  callStep: string;
  callPath: string;
  parentArtifactVersion: number;
  childWorkflow: string;
  childDefRef: DefRef;
  childOutcome: string;
  childOutcomeVersion: number;
  foldedValueDigest: string;
}
export interface VerifiedConcreteCallReceipt {
  receipt: ConcreteCallBindingReceipt;
  receiptDigest: string;
  proof: string;
}
export interface ConcreteCallBindingSource {
  read(key: ConcreteCallBindingKey): Promise<VerifiedConcreteCallReceipt | undefined>;
}

const refused = (): Error => new Error('routed concrete call binding refused');
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
const version = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const defRef = (value: unknown): value is DefRef => {
  const ref = record(value);
  return !!ref && exact(ref, ['bundleDigest', 'workflowName'])
    && digest(ref.bundleDigest) && text(ref.workflowName);
};

export function parseRoutedConcreteCallBinding(raw: unknown, args: {
  key: ConcreteCallBindingKey;
  phase: 'prestart' | 'recorded-live';
  expected: { workflow: string; run: string; origin: string; orgId: string; binding: unknown };
}): VerifiedConcreteCallReceipt | undefined {
  const wire = record(raw);
  const protocol = args.phase === 'prestart'
    ? 'owenloop-concrete-call-v1' : 'owenloop-concrete-call-recorded-v1';
  if (!wire || Buffer.byteLength(JSON.stringify(raw)) > 30_000_000
    || wire.protocol !== protocol || wire.workflow !== args.expected.workflow
    || wire.run !== args.expected.run) throw refused();
  if (wire.state === 'unavailable') {
    if (!exact(wire, ['protocol', 'state', 'workflow', 'run'])) throw refused();
    return undefined;
  }
  if (!exact(wire, ['protocol', 'state', 'workflow', 'run', 'origin', 'orgId',
    'binding', 'selected', 'freshness', 'atomicLaunch'])
    || wire.state !== 'available' || wire.origin !== args.expected.origin
    || wire.orgId !== args.expected.orgId || wire.freshness !== 'fresh-at-read'
    || wire.atomicLaunch !== false
    || !isDeepStrictEqual(wire.binding, args.expected.binding)) throw refused();
  const selected = record(wire.selected);
  const receipt = record(selected?.receipt);
  if (!selected || !exact(selected, ['receipt', 'receiptDigest', 'proof'])
    || !digest(selected.receiptDigest)
    || typeof selected.proof !== 'string' || selected.proof.length < 1
    || Buffer.byteLength(selected.proof, 'utf8') > 25_000_000
    || !receipt || !exact(receipt, ['kind', 'parentWorkflow', 'parentDefRef',
      'callStep', 'callPath', 'parentArtifactVersion', 'childWorkflow',
      'childDefRef', 'childOutcome', 'childOutcomeVersion', 'foldedValueDigest'])
    || receipt.kind !== 'concrete-call'
    || receipt.parentWorkflow !== args.key.parentWorkflow
    || !isDeepStrictEqual(receipt.parentDefRef, args.key.parentDefRef)
    || receipt.callPath !== args.key.callPath
    || receipt.parentArtifactVersion !== args.key.parentArtifactVersion
    || !text(receipt.callStep) || !text(receipt.childWorkflow)
    || !defRef(receipt.childDefRef) || !text(receipt.childOutcome)
    || !version(receipt.childOutcomeVersion) || !digest(receipt.foldedValueDigest)
    || valueDigestHex(receipt) !== selected.receiptDigest) throw refused();
  return { receipt: receipt as unknown as ConcreteCallBindingReceipt,
    receiptDigest: selected.receiptDigest, proof: selected.proof };
}

export function createDirectRoutedConcreteCallBindingReader(options:
  RoutedV2TransportOptions & { orgId: string },
): (key: ConcreteCallBindingKey, phase: 'prestart' | 'recorded-live', binding: unknown) =>
    Promise<VerifiedConcreteCallReceipt | undefined> {
  const { now, request } = createRoutedV2Requester(options);
  return async (key, phase, binding) => {
    const body = concreteBindingRequestBody(key, options.expected);
    const raw = await request(phase === 'prestart'
      ? '/api/read_concrete_call_binding' : '/api/read_concrete_call_binding/live/v2',
    now(), body);
    return parseRoutedConcreteCallBinding(raw, { key, phase,
      expected: { ...options.expected, origin: options.origin, orgId: options.orgId,
	binding } });
  };
}

/** The selected native key remains exact in both standalone and composite reads. */
export function concreteBindingRequestBody(key: ConcreteCallBindingKey,
  expected: { workflow: string; run: string }) {
  if (!text(key.parentWorkflow) || !defRef(key.parentDefRef)
    || !text(key.callPath) || !version(key.parentArtifactVersion)) throw refused();
  return { workflow: expected.workflow, orderId: expected.run,
    parentWorkflow: key.parentWorkflow, parentDefRef: key.parentDefRef,
    callPath: key.callPath, parentArtifactVersion: key.parentArtifactVersion };
}
