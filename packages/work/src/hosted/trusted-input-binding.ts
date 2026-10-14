/** Local-definition gate for Service v2 witnesses. Declared inputs are
 * trusted Service observations at the claim version; producer artifacts keep
 * the unchanged hard signature/chain verifier. */
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import { parseWorkdirFrom } from '../../../../src/paths.ts';
import type { InputDef, StepDef } from '../../../../src/types.ts';

import type { ConsumedVerifier, VerifiedCallsProducer } from '../consumed-verifier.ts';
import type { OrderPacket } from '../hub/types.ts';
import { outputFor, validConsumedStructureV2 } from '../order-definition-binding.ts';
import type { TrustedReferenceV2 } from './trusted-reference-v2.ts';

export type TrustedBinding = { ok: true; order: OrderPacket; witnessDigest: string } |
  { ok: false; reason: string };

const refuse = (reason: string): TrustedBinding => ({ ok: false, reason });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a: unknown, b: unknown): boolean => {
  try { return valueDigestHex(a) === valueDigestHex(b); }
  catch { return false; }
};

function dotted(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (!record(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function proofMap(raw: unknown, allowed: Set<string>): Record<string, string> | undefined {
  if (raw === undefined) return {};
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { return undefined; }
  if (!record(parsed)) return undefined;
  for (const [path, proof] of Object.entries(parsed)) {
    if (!allowed.has(path) || typeof proof !== 'string' || !proof) return undefined;
  }
  return parsed as Record<string, string>;
}

/** Called only after the pinned local publication and step were verified. */
export async function bindTrustedReferenceV2(args: {
  response: TrustedReferenceV2;
  expected: { workflow: string; run: string; defDigest: string; step: string; key: string };
  step: StepDef;
  declaredInputs: readonly InputDef[];
  consumedVerifier: ConsumedVerifier;
  callsProducers: Readonly<Record<string, VerifiedCallsProducer>>;
}): Promise<TrustedBinding> {
  const { response, expected, step } = args;
  const order = response.order;
  if (order.workflow !== expected.workflow || order.run !== expected.run || order.defDigest !== expected.defDigest
    || order.step !== expected.step || order.step !== step.name || order.key !== expected.key
    || !validConsumedStructureV2(step, order)) return refuse('order-structure-mismatch');
  if (order.outputs.length !== order.owes.length || new Set(order.outputs).size !== order.outputs.length
    || new Set(order.owes.map(owed => owed.path)).size !== order.owes.length
    || order.owes.some(owed => !order.outputs.includes(owed.path) || outputFor(step, order, owed.path) === undefined)) {
    return refuse('output-structure-mismatch');
  }
  const declared = new Map(args.declaredInputs.map(input => [input.name, input]));
  const witnesses = new Map(response.inputs.map(input => [input.path, input]));
  if (witnesses.size !== order.inputs.length || Object.keys(order.consumedFingerprint ?? {}).length !== order.inputs.length) {
    return refuse('witness-set-mismatch');
  }
  const producerPaths = new Set<string>();
  for (const path of order.inputs) {
    const witness = witnesses.get(path);
    const input = declared.get(path);
    if (!witness || witness.version !== order.consumedFingerprint?.[path]) return refuse('witness-version-mismatch');
    const present = Object.hasOwn(order.consumes, path);
    if (witness.present !== present || (present && !equal(order.consumes[path], witness.value))) {
      return refuse('witness-value-mismatch');
    }
    if (!present && (!input || input.seedOwed !== false)) return refuse('unwitnessed-absence');
    if (!input) producerPaths.add(path);
  }
  if (Object.keys(order.consumes).some(path => !witnesses.has(path))) return refuse('extra-consumed-path');
  const proofs = proofMap(order.consumesProof, producerPaths);
  if (!proofs) return refuse('producer-proof-map-mismatch');
  if (order.consumesProofRelay !== undefined && (!record(order.consumesProofRelay)
    || Object.keys(order.consumesProofRelay).some(path => !producerPaths.has(path)))) {
    return refuse('producer-relay-map-mismatch');
  }

  if (step.workdirFrom === undefined) {
    if (response.workdirInput !== undefined || order.workdir !== step.workdir) return refuse('workdir-mismatch');
  } else {
    const source = parseWorkdirFrom(step.workdirFrom, step.consumes, args.declaredInputs.map(input => input.name));
    if (!source || source.mode !== 'plain') return refuse('workdir-source-mismatch');
    let value: unknown;
    if (source.source === 'consume') {
      if (response.workdirInput !== undefined) return refuse('extra-workdir-witness');
      value = witnesses.get(source.stem)?.value;
      if (!witnesses.get(source.stem)?.present) return refuse('workdir-source-absent');
    } else {
      if (!response.workdirInput || response.workdirInput.stem !== source.stem
	|| order.inputs.includes(source.stem) || !Number.isSafeInteger(response.workdirInput.version)
	|| response.workdirInput.version < 1) return refuse('workdir-witness-mismatch');
      value = response.workdirInput.value;
    }
    const cwd = dotted(value, source.path);
    if (typeof cwd !== 'string' || !cwd.trim() || order.workdir !== cwd) return refuse('workdir-value-mismatch');
  }

  const verifiedOrder: OrderPacket = { ...order,
    consumes: Object.fromEntries(Object.entries(order.consumes).filter(([path]) => producerPaths.has(path))),
    consumedFingerprint: Object.fromEntries(Object.entries(order.consumedFingerprint ?? {})
      .filter(([path]) => producerPaths.has(path))),
    consumesProof: JSON.stringify(proofs),
    consumesProofRelay: order.consumesProofRelay,
    owes: order.owes.map(owed => ({ ...owed, reasons: [], judgmentRejects: 0, schemaRejects: 0 })),
  };
  let verdict: Awaited<ReturnType<ConsumedVerifier>>;
  try { verdict = await args.consumedVerifier(verifiedOrder, { hardRule: true, callsProducers: args.callsProducers }); }
  catch { return refuse('producer-verifier-unavailable'); }
  if (!verdict.ok) return refuse('producer-proof-refused');
  return { ok: true, order: { ...order,
    owes: verifiedOrder.owes,
  }, witnessDigest: valueDigestHex({ inputs: response.inputs, workdirInput: response.workdirInput ?? null }) };
}
