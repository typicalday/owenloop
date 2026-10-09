/** Parent-only nonrecursive dynamic relay source. A signed step and raw current
 * Service pair identify the sole key before the native producer relay is read. */
import { isDeepStrictEqual } from 'node:util';
import type { DefRef, InvocationBindingSource, InvocationRelayKey,
  VerifiedInvocationReceipt } from '../../../../src/types.ts';
import type { VerifiedDefinitionSelection } from '../../../../src/store/instruction-source.ts';
import type { OrderPacket } from '../hub/types.ts';
import { parseRoutedReferenceV2, parseRoutedClaimV2 } from '../hosted/trusted-routed-reference-v2.ts';
import { parseRecordedReferenceV2, parseRecordedClaimV2,
  type RecordedBindingV2 } from '../hosted/trusted-routed-recorded-v2.ts';
import type { RoutedInputPair, RoutedInputPhase } from '../hosted/trusted-input-admission.ts';

const refused = (): Error => new Error('routed invocation source refused');

/** The v2 input read intentionally omits get_order's mutable owed reason
 * threads, schema hints and advisory human proof. Compare only the claim-bound
 * identity and input version fields needed to choose the signed producer key;
 * the full v2 binder below still verifies the entire input witness. */
function samePreboundOrder(reference: OrderPacket, current: OrderPacket,
  rootWorkflow: string, selected: VerifiedDefinitionSelection): boolean {
  const binding = current.routing?.claim.binding;
  return reference.workflow === current.workflow && reference.run === current.run
    && reference.step === current.step && reference.key === current.key
    && reference.index === current.index && reference.defDigest === current.defDigest
    && reference.defDigest === selected.bundleDigest
    && reference.workdir === current.workdir
    && isDeepStrictEqual(reference.inputs, current.inputs)
    && isDeepStrictEqual(reference.consumedFingerprint, current.consumedFingerprint)
    && isDeepStrictEqual(reference.routing, current.routing)
    && binding?.runId === rootWorkflow && binding.frameId === current.workflow
    && binding.def.bundleDigest === `sha256:${selected.bundleDigest}`
    && binding.def.workflowName === selected.definition.name
    && isDeepStrictEqual(binding, current.routing?.decision.binding);
}

export function createParentRoutedInvocationSource(args: {
  expected: { workflow: string; run: string }; order: OrderPacket;
  selected: VerifiedDefinitionSelection; pair: RoutedInputPair; phase: RoutedInputPhase;
  readDirect: (key: InvocationRelayKey, phase: RoutedInputPhase,
    expected: { workflow: string; run: string }, binding?: RecordedBindingV2) =>
      Promise<VerifiedInvocationReceipt | undefined>;
  readCurrentPair: (phase: RoutedInputPhase, expected: { workflow: string; run: string }) =>
    Promise<RoutedInputPair>;
  verifyChild: (child: DefRef) => Promise<void>;
  stillAuthorized: () => boolean;
}): InvocationBindingSource {
  const parse = (pair: RoutedInputPair) => {
    const reference = args.phase === 'prestart'
      ? parseRoutedReferenceV2(pair.reference, args.expected)
      : parseRecordedReferenceV2(pair.reference, args.expected);
    const claim = args.phase === 'prestart'
      ? parseRoutedClaimV2(pair.claim, args.expected)
      : parseRecordedClaimV2(pair.claim, args.expected);
    if (reference.state !== 'available' || claim.state !== 'available'
      || !isDeepStrictEqual(reference.binding, claim.binding)
      || !isDeepStrictEqual(reference.order.routing, claim.routing)
      || !samePreboundOrder(reference.order, args.order, args.expected.workflow, args.selected)
      || reference.binding.frameWorkflow !== args.order.workflow)
      throw refused();
    return { reference, claim };
  };
  const initial = parse(args.pair);
  const parentDefRef = { bundleDigest: args.selected.bundleDigest,
    workflowName: args.selected.definition.name };
  return { async read(key) {
    if (!args.stillAuthorized() || key.parentWorkflow !== args.order.workflow
      || !isDeepStrictEqual(key.parentDefRef, parentDefRef)
      || !Number.isSafeInteger(key.parentArtifactVersion) || key.parentArtifactVersion < 1
      || args.order.consumedFingerprint?.[key.callPath] !== key.parentArtifactVersion
      || !Object.hasOwn(args.order.consumes, key.callPath)) throw refused();
    const producer = args.selected.definition.steps.filter(step =>
      step.callsInterface?.selection === 'invocation'
      && step.produces.some(produce => produce.stem === key.callPath));
    const witness = initial.reference.inputs.filter(input => input.path === key.callPath);
    if (producer.length !== 1 || witness.length !== 1 || witness[0]!.present !== true
      || witness[0]!.version !== key.parentArtifactVersion
      || !isDeepStrictEqual(witness[0]!.value, args.order.consumes[key.callPath])) throw refused();
    const binding = args.phase === 'recorded-live'
      ? initial.reference.binding as RecordedBindingV2 : undefined;
    const relay = await args.readDirect(key, args.phase, args.expected, binding);
    if (!relay || !args.stillAuthorized()) throw refused();
    await args.verifyChild(relay.receipt.childDefRef);
    if (!args.stillAuthorized()) throw refused();
    const current = parse(await args.readCurrentPair(args.phase, args.expected));
    if (!isDeepStrictEqual(current.reference, initial.reference)
      || !isDeepStrictEqual(current.claim, initial.claim)
      || !args.stillAuthorized()) throw refused();
    return relay;
  } };
}
