/** Shared test fixtures — inline workflow/loop builders and an artifact-map helper. */

import { parseConsume, parseProduce } from '../src/paths.ts';
import type { ArtifactData, InputDef, LoopDef, WorkflowDef } from '../src/types.ts';
import type { ArtifactMap } from '../src/model.ts';

export interface LoopSpec {
  name: string;
  consumes?: string[];
  produces?: string[];
  invalidates?: string[];
  cadence?: string;
  cadenceSecs?: number;
  maxRunsPerDay?: number;
  parallel?: number;
  maxAttempts?: number;
  maxSchemaFailures?: number;
  model?: string;
  workdir?: string;
  body?: string;
  terminal?: boolean;
}

export function loop(spec: LoopSpec): LoopDef {
  const consumes = (spec.consumes ?? []).map(parseConsume);
  const produces = (spec.produces ?? []).map(parseProduce);
  return {
    name: spec.name,
    consumes,
    produces,
    invalidates: spec.invalidates ?? consumes.map((c) => c.stem),
    cadence: spec.cadence ?? '0s',
    cadenceSecs: spec.cadenceSecs ?? 0,
    maxRunsPerDay: spec.maxRunsPerDay ?? 1000,
    parallel: spec.parallel ?? 100,
    maxAttempts: spec.maxAttempts ?? 3,
    maxSchemaFailures: spec.maxSchemaFailures ?? 5,
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.terminal !== undefined ? { terminal: spec.terminal } : {}),
    workdir: spec.workdir ?? 'main',
    body: spec.body ?? `run ${spec.name}`,
  };
}

export function def(name: string, inputs: InputDef[], loops: LoopDef[]): WorkflowDef {
  return { name, inputs, loops };
}

export function input(name: string, opts: { producer?: string; seedOwed?: boolean } = {}): InputDef {
  return { name, producer: opts.producer ?? 'human', seedOwed: opts.seedOwed ?? false };
}

/** Build an artifact map from terse specs (defaults: producer 'p', owed, v0). */
export function arts(
  specs: Array<Partial<ArtifactData> & { path: string }>,
): ArtifactMap {
  const m = new Map<string, ArtifactData>();
  for (const s of specs) {
    m.set(s.path, {
      workflow: 'wf',
      path: s.path,
      producer: s.producer ?? 'p',
      acceptance: s.acceptance ?? 'owed',
      version: s.version ?? 0,
      reasons: s.reasons ?? [],
      judgmentRejects: s.judgmentRejects ?? 0,
      schemaRejects: s.schemaRejects ?? 0,
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.fingerprint !== undefined ? { fingerprint: s.fingerprint } : {}),
      ...(s.sealOf !== undefined ? { sealOf: s.sealOf } : {}),
      ...(s.terminal !== undefined ? { terminal: s.terminal } : {}),
    });
  }
  return m;
}
