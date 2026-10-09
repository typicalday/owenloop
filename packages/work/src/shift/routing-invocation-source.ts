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
      || !isDeepStrictEqual(reference.order, args.order)
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
