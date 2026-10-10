/** One exact native invocation relay read under the parent's original session.
 * This data is a producer witness, never a launch or child-selected authority. */
import { isDeepStrictEqual } from 'node:util';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { DefRef, InvocationBinding, InvocationRelayKey, VerifiedInvocationReceipt } from '../../../../src/types.ts';
import type { InvocationBindingReadResponse } from '../hub/types.ts';
import type { RecordedBindingV2 } from './trusted-routed-recorded-v2.ts';
import { createRoutedV2Requester, type RoutedV2TransportOptions } from './trusted-routed-reference-v2.ts';

export type RoutedInvocationPhase = 'prestart' | 'recorded-live';
export type RecordedInvocationBindingReadResponse = {
  protocol: 'owenloop-binding-recorded-v2'; state: 'available'; workflow: string; run: string;
  binding: RecordedBindingV2;
  invocation: InvocationBindingReadResponse['binding'];
  bindingJson: string; bindingDigest: string; parentDefRef: DefRef; childDefRef: DefRef;
  relay: VerifiedInvocationReceipt; freshness: 'fresh-at-read'; atomicLaunch: false;
  origin: string; orgId: string;
} | {
  protocol: 'owenloop-binding-recorded-v2'; state: 'unavailable'; workflow: string; run: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const sameRef = (left: unknown, right: DefRef): boolean => isDeepStrictEqual(left, right);
const refused = (): Error => new Error('routed invocation witness refused');

/** Strictly parse the versioned route and its existing prestart counterpart.
 * The complete canonical binding stays private; only the verified relay leaves. */
export function parseRoutedInvocationBinding(raw: unknown, args: {
  phase: RoutedInvocationPhase; key: InvocationRelayKey;
  expected: { workflow: string; run: string; origin: string; orgId: string;
    binding?: RecordedBindingV2 };
}): VerifiedInvocationReceipt | undefined {
  const wire = record(raw);
  if (!wire || Buffer.byteLength(JSON.stringify(raw)) > 2_000_000) throw refused();
  const live = args.phase === 'recorded-live';
  if (live && wire.protocol === 'owenloop-binding-recorded-v2' && wire.state === 'unavailable') {
    if (!exact(wire, ['protocol', 'state', 'workflow', 'run'])
      || wire.workflow !== args.expected.workflow || wire.run !== args.expected.run) throw refused();
    return undefined;
  }
  const common = ['origin', 'orgId', 'bindingJson', 'bindingDigest', 'parentDefRef',
    'childDefRef', 'relay', 'freshness', 'atomicLaunch'];
  if (live) {
    if (wire.protocol !== 'owenloop-binding-recorded-v2' || wire.state !== 'available'
      || !exact(wire, ['protocol', 'state', 'workflow', 'run', 'binding', 'invocation', ...common])
      || wire.workflow !== args.expected.workflow || wire.run !== args.expected.run
      || !args.expected.binding || !isDeepStrictEqual(wire.binding, args.expected.binding)) throw refused();
  } else if (wire.protocol !== 'owenloop-binding-v1'
    || !exact(wire, ['protocol', 'binding', ...common])) throw refused();
  if (wire.origin !== args.expected.origin || wire.orgId !== args.expected.orgId
    || wire.freshness !== 'fresh-at-read' || wire.atomicLaunch !== false
    || !sameRef(wire.parentDefRef, args.key.parentDefRef)
    || typeof wire.bindingJson !== 'string' || wire.bindingJson.length > 1_000_000
    || !hex(wire.bindingDigest)) throw refused();
  let complete: InvocationBinding;
  try {
    complete = JSON.parse(wire.bindingJson) as InvocationBinding;
    if (valueDigestHex(complete) !== wire.bindingDigest) throw refused();
  } catch { throw refused(); }
  const summary = record(live ? wire.invocation : wire.binding);
  const selected = record(summary?.selected);
  const relay = record(wire.relay);
  const receipt = record(relay?.receipt);
  if (!summary || !selected || !relay || !receipt
    || !exact(summary, ['id', 'key', 'admission', 'selected', 'policyDigest', 'candidateSetDigest'])
    || !exact(selected, ['target', 'DefRef'])
    || !exact(relay, ['receipt', 'receiptDigest'])
    || !exact(receipt, ['invocationId', 'parentDefRef', 'callPath', 'evidenceDigest',
      'parentArtifactVersion', 'childWorkflow', 'childDefRef', 'childOutcome', 'childOutcomeVersion'])
    || !hex(relay.receiptDigest) || valueDigestHex(receipt) !== relay.receiptDigest
    || !positive(receipt.parentArtifactVersion)
    || receipt.parentArtifactVersion !== args.key.parentArtifactVersion
    || receipt.callPath !== args.key.callPath
    || !sameRef(receipt.parentDefRef, args.key.parentDefRef)
    || !sameRef(wire.childDefRef, selected.DefRef as DefRef)
    || !sameRef(receipt.childDefRef, wire.childDefRef as DefRef)
    || !isDeepStrictEqual(summary.id, complete.id)
    || !isDeepStrictEqual(summary.key, complete.key)
    || !isDeepStrictEqual(summary.admission, complete.admission)
    || !isDeepStrictEqual(summary.policyDigest, complete.policyDigest)
    || !isDeepStrictEqual(summary.candidateSetDigest, complete.candidateSetDigest)
    || !isDeepStrictEqual(selected.target, complete.selected?.target)
    || !isDeepStrictEqual(selected.DefRef, complete.selected?.DefRef)
    || receipt.invocationId !== summary.id
    || receipt.evidenceDigest !== complete.key?.evidenceDigest
    || complete.key?.parentWorkflow !== args.key.parentWorkflow
    || !sameRef(complete.key?.parentDefRef, args.key.parentDefRef)
    || complete.key?.callPath !== args.key.callPath
    || typeof receipt.childWorkflow !== 'string' || !receipt.childWorkflow
    || typeof receipt.childOutcome !== 'string' || !receipt.childOutcome
    || !positive(receipt.childOutcomeVersion)) throw refused();
  return relay as unknown as VerifiedInvocationReceipt;
}

export function createDirectRoutedInvocationReader(options: RoutedV2TransportOptions & {
  orgId: string;
}): (key: InvocationRelayKey, phase: RoutedInvocationPhase,
  binding?: RecordedBindingV2) => Promise<VerifiedInvocationReceipt | undefined> {
  const { now, request } = createRoutedV2Requester(options);
  return async (key, phase, binding) => {
    if (!positive(key.parentArtifactVersion) || !key.parentWorkflow || !key.callPath
      || !key.parentDefRef.workflowName || !hex(key.parentDefRef.bundleDigest)) throw refused();
    const body = { workflow: options.expected.workflow, orderId: options.expected.run,
      parentWorkflow: key.parentWorkflow, parentDefRef: key.parentDefRef,
      callPath: key.callPath, parentArtifactVersion: key.parentArtifactVersion };
    const raw = await request(phase === 'prestart'
      ? '/api/read_invocation_binding' : '/api/read_invocation_binding/live/v2', now(), body);
    return parseRoutedInvocationBinding(raw, { phase, key,
      expected: { ...options.expected, origin: options.origin, orgId: options.orgId,
	...(binding ? { binding } : {}) } });
  };
}
