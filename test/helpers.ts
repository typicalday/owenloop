/** Shared test fixtures — inline workflow/step builders and an artifact-map helper. */

import { parseConsume, parseProduce } from '../src/paths.ts';
import type { ArtifactData, EffectDef, FiringTrigger, GroupDef, InputDef, StepDef, WorkflowDef } from '../src/types.ts';
import type { ArtifactMap } from '../src/model.ts';

export interface StepSpec {
  name: string;
  consumes?: string[];
  produces?: string[];
  groups?: GroupDef[];
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
  effect?: EffectDef;
  on?: FiringTrigger[];
  idleAfter?: string;
  idleAfterMs?: number;
  reapTtlMs?: number;
}

export function step(spec: StepSpec): StepDef {
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
    ...(spec.effect !== undefined ? { effect: spec.effect } : {}),
    ...(spec.on !== undefined ? { on: spec.on } : {}),
    ...(spec.idleAfter !== undefined ? { idleAfter: spec.idleAfter } : {}),
    ...(spec.idleAfterMs !== undefined ? { idleAfterMs: spec.idleAfterMs } : {}),
    ...(spec.reapTtlMs !== undefined ? { reapTtlMs: spec.reapTtlMs } : {}),
    ...(spec.groups !== undefined ? { groups: spec.groups } : {}),
    workdir: spec.workdir ?? 'main',
    body: spec.body ?? `run ${spec.name}`,
  };
}

export function def(name: string, inputs: InputDef[], steps: StepDef[]): WorkflowDef {
  return { name, engine: 1, inputs, steps };
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
