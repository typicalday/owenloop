/** Bind model-visible order paths to the locally resolved workflow step. */
import { bindProduce, elementPath, matchConsume, parseWorkdirFrom, sealPath } from '../../../src/paths.ts';
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

function validConsumedShape(step: StepDef, order: OrderPacket, allowAbsent: boolean): boolean {
  if (!Array.isArray(order.inputs) || order.inputs.some((path) => typeof path !== 'string')
    || order.consumes === null || typeof order.consumes !== 'object' || Array.isArray(order.consumes)) return false;
  const expected = new Set(order.inputs);
  const delivered = Object.keys(order.consumes);
  if (expected.size !== order.inputs.length || (!allowAbsent && expected.size !== delivered.length)
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

/** Legacy consume membership remains exact. The v2 input witness gate calls
 * the shared shape check separately, then proves each absent declared input. */
export function validConsumedPaths(step: StepDef, order: OrderPacket): boolean {
  return validConsumedShape(step, order, false);
}

export function validConsumedStructureV2(step: StepDef, order: OrderPacket): boolean {
  return validConsumedShape(step, order, true);
}

/** Bind an order cwd to the local definition. A consumed `workdirFrom` value
 * is independently verified by the consume gate before use. A declared input
 * that the step does not consume is absent from this packet and still needs a
 * separate authenticated input-value binding. */
export function validFixedWorkdir(step: StepDef, order: OrderPacket, inputNames?: readonly string[]): boolean {
  if (step.workdirFrom === undefined) return order.workdir === step.workdir;
  // The full definition input list is required: a dotted input can be a
  // longer match than a consumed stem (for example `a.b` versus `a`).
  if (inputNames === undefined) return false;
  const parsed = parseWorkdirFrom(step.workdirFrom, step.consumes, inputNames);
  if (parsed === null) return false;
  if (parsed.source === 'input') return true; // Input value is not in order.consumes.
  if (parsed.mode !== 'plain' || parsed.source !== 'consume'
    || order.consumes === null || typeof order.consumes !== 'object') return false;
  let value: unknown = order.consumes[parsed.stem];
  for (const segment of parsed.path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !Object.prototype.hasOwnProperty.call(value, segment)) return false;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' && value.trim().length > 0 && order.workdir === value;
}

/** The old packet fallback has outputs but no owes; every present path still
 * has to be declared by the local step. Current get_order projects both sets. */
export function validModelOrderFields(step: StepDef, order: OrderPacket, inputNames?: readonly string[]): boolean {
  if (order.step !== step.name || !validConsumedPaths(step, order) || !validFixedWorkdir(step, order, inputNames)
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
