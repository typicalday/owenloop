/** Bind model-visible order paths to the locally resolved workflow step. */
import { bindProduce, elementPath, matchConsume, sealPath } from '../../../src/paths.ts';
import type { ProducePattern, StepDef } from '../../../src/types.ts';
import type { OrderPacket } from './hub/types.ts';

function concreteOutput(produce: ProducePattern, order: OrderPacket): string | undefined {
  if (produce.kind === 'singleton') return produce.stem;
  if (produce.kind === 'collection') return sealPath(produce.stem);
  if (!Number.isSafeInteger(order.index) || order.index! < 0) return undefined;
  return bindProduce(produce, order.index!);
}

export function outputFor(step: StepDef, order: OrderPacket, path: string): ProducePattern | undefined {
  const mode = step.consumes.some((pattern) => pattern.mode === 'map') ? 'map'
    : step.consumes.some((pattern) => pattern.mode === 'reduce') ? 'reduce' : 'plain';
  return step.produces.find((produce) =>
    (mode === 'plain' ? produce.kind !== 'map' : produce.kind === (mode === 'map' ? 'map' : 'singleton'))
    && concreteOutput(produce, order) === path);
}

export function validConsumedPaths(step: StepDef, order: OrderPacket): boolean {
  if (!Array.isArray(order.inputs) || order.inputs.some((path) => typeof path !== 'string')
    || order.consumes === null || typeof order.consumes !== 'object' || Array.isArray(order.consumes)) return false;
  const expected = new Set(order.inputs);
  const delivered = Object.keys(order.consumes);
  if (expected.size !== order.inputs.length || expected.size !== delivered.length
    || delivered.some((path) => !expected.has(path))) return false;
  const map = step.consumes.find((pattern) => pattern.mode === 'map');
  if (map) {
    if (!Number.isSafeInteger(order.index) || order.index! < 0
      || order.key !== elementPath(map.stem, order.index!)
      || !expected.has(elementPath(map.stem, order.index!, map.suffix))) return false;
  } else if (order.key !== '' || order.index !== undefined) return false;
  if (step.consumes.some((pattern) =>
    (pattern.mode === 'plain' && !expected.has(pattern.stem))
    || (pattern.mode === 'reduce' && !expected.has(sealPath(pattern.stem))))) return false;
  if (order.cause === undefined) {
    if (!(step.on ?? ['inputsGreen']).includes('inputsGreen')) return false;
  } else if ((order.cause !== 'allGreen' && order.cause !== 'idle')
    || !step.on?.includes(order.cause) || expected.size !== 0) return false;
  return delivered.every((path) => step.consumes.some((pattern) => {
    if (pattern.mode === 'reduce' && path === sealPath(pattern.stem)) return true;
    const matched = matchConsume(pattern, path);
    return matched !== null && (pattern.mode !== 'map' || matched.index === order.index);
  }));
}

/** A static cwd is an instruction from the local definition, not the relay.
 * Dynamic `workdirFrom` paths need their own value/proof binding and are not
 * covered by this comparison. A step declaring neither must receive neither. */
export function validFixedWorkdir(step: StepDef, order: OrderPacket): boolean {
  return step.workdirFrom !== undefined || order.workdir === step.workdir;
}

/** The old packet fallback has outputs but no owes; every present path still
 * has to be declared by the local step. Current get_order projects both sets. */
export function validModelOrderFields(step: StepDef, order: OrderPacket): boolean {
  if (order.step !== step.name || !validConsumedPaths(step, order) || !validFixedWorkdir(step, order)
    || !Array.isArray(order.outputs) || !Array.isArray(order.owes)) return false;
  const outputs = order.outputs;
  if (order.owes.some((owed) => owed === null || typeof owed !== 'object'
    || !Array.isArray(owed.reasons)
    || !Number.isSafeInteger(owed.judgmentRejects) || owed.judgmentRejects < 0
    || !Number.isSafeInteger(owed.schemaRejects) || owed.schemaRejects < 0
    || (owed.version !== undefined && (!Number.isSafeInteger(owed.version) || owed.version < 1)))) return false;
  const owedPaths = order.owes.map((owed) => owed.path);
  if (outputs.some((path) => typeof path !== 'string')
    || owedPaths.some((path) => typeof path !== 'string')
    || new Set(outputs).size !== outputs.length || new Set(owedPaths).size !== owedPaths.length) return false;
  if (owedPaths.length > 0
    && (outputs.length !== owedPaths.length || owedPaths.some((path) => !outputs.includes(path)))) return false;
  // Synthesized judges issue a verdict on the locally declared judged stem.
  // They intentionally have no `produces`; Engine still offers that stem in
  // outputs/owes so the judge can act on the submitted artifact. Require the
  // sole exact stem and its consume edge rather than widening outputFor.
  if (step.judges !== undefined) {
    return step.judges !== '' && step.produces.length === 0 && order.cause === undefined
      && step.consumes.some((consume) => consume.mode === 'plain' && consume.stem === step.judges)
      && outputs.length === 1 && outputs[0] === step.judges;
  }
  return [...outputs, ...owedPaths].every((path) => outputFor(step, order, path) !== undefined);
}
