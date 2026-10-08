import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDef } from '../../../src/defs.ts';
import { Engine } from '../../../src/engine.ts';
import { openStore } from '../../../src/store.ts';
import type { StepDef } from '../../../src/types.ts';
import type { OrderPacket } from '../src/hub/types.ts';
import { validModelOrderFields } from '../src/order-definition-binding.ts';

function step(raw: Record<string, unknown>): StepDef {
  return buildDef({ name: 'binding', steps: [raw] }).steps[0]!;
}

function packet(stepName: string, outputs: string[], inputs: string[] = [], key = '', index?: number): OrderPacket {
  return {
    workflow: 'wf', run: 'run', step: stepName, key, ...(index === undefined ? {} : { index }),
    defDigest: 'digest', inputs, outputs,
    consumes: Object.fromEntries(inputs.map((path) => [path, 'value'])),
    consumedFingerprint: {},
    owes: outputs.map((path) => ({ path, judgmentRejects: 0, schemaRejects: 0, reasons: [] })),
  };
}

test('local binding accepts route siblings and legacy outputs but refuses undeclared owed paths', () => {
  const local = step({ name: 'route', produces: ['out', 'sibling'] });
  const offered = packet('route', ['out', 'sibling']);
  assert.equal(validModelOrderFields(local, offered), true);
  assert.equal(validModelOrderFields(local, { ...offered, owes: [] }), true, 'old packet output fallback');
  assert.equal(validModelOrderFields(local, { ...offered, owes: [
    { path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] },
    { path: 'hostile-owed', judgmentRejects: 0, schemaRejects: 0, reasons: [] },
  ] }), false);
  assert.equal(validModelOrderFields(local, { ...offered, outputs: ['hostile-output'] }), false);
  assert.equal(validModelOrderFields(local, { ...offered, step: 'hostile-step' }), false);
  assert.equal(validModelOrderFields(local, { ...offered, owes: [{
    path: 'out', version: Number.POSITIVE_INFINITY, judgmentRejects: 0, schemaRejects: 0, reasons: [],
  }] }), false);
  assert.equal(validModelOrderFields(local, { ...offered, owes: [{
    path: 'out', version: 0, judgmentRejects: 0, schemaRejects: 0, reasons: [],
  }] }), false);
  assert.equal(validModelOrderFields(local, { ...offered, owes: [{
    path: 'out', judgmentRejects: -1, schemaRejects: 0, reasons: [],
  }] }), false);
});

test('local model order binds an authored static workdir and rejects a forged sibling or omission', () => {
  const local = step({ name: 'route', produces: ['out'], workdir: '/allowed/project-a' });
  const offered = { ...packet('route', ['out']), workdir: '/allowed/project-a' };
  assert.equal(validModelOrderFields(local, offered), true);
  assert.equal(validModelOrderFields(local, { ...offered, workdir: '/allowed/project-b' }), false);
  assert.equal(validModelOrderFields(local, { ...offered, workdir: undefined }), false);

  const inherited = step({ name: 'inherited', produces: ['out'] });
  assert.equal(validModelOrderFields(inherited, packet('inherited', ['out'])), true);
  assert.equal(validModelOrderFields(inherited, { ...packet('inherited', ['out']), workdir: '/allowed/project-b' }), false);

  const dynamic = step({ name: 'dynamic', consumes: ['seed'], produces: ['out'], workdirFrom: 'seed.cwd' });
  assert.equal(validModelOrderFields(dynamic, {
    ...packet('dynamic', ['out'], ['seed']),
    consumes: { seed: { cwd: '/allowed/project-b' } },
    workdir: '/allowed/project-b',
  }), true, 'dynamic value binding is a separate gate');
});

test('local binding accepts a collection seal and bound map member, then refuses key/index/path drift', () => {
  const collect = step({ name: 'collect', produces: ['items[]'] });
  assert.equal(validModelOrderFields(collect, packet('collect', ['items.sealed'])), true);
  assert.equal(validModelOrderFields(collect, packet('collect', ['items[0]'])), false);

  const map = step({ name: 'annotate', consumes: ['items[$i]'], produces: ['items[$i].note'] });
  const offered = packet('annotate', ['items[0].note'], ['items[0]'], 'items[0]', 0);
  assert.equal(validModelOrderFields(map, offered), true);
  assert.equal(validModelOrderFields(map, { ...offered, key: 'items[1]' }), false);
  assert.equal(validModelOrderFields(map, { ...offered, index: 1 }), false);
  assert.equal(validModelOrderFields(map, { ...offered, outputs: ['items[1].note'] }), false);
});

test('local binding accepts reduce member and seal consumes and refuses forged input', () => {
  const reduce = step({ name: 'summarize', consumes: ['items[*]', 'policy'], produces: ['summary'] });
  const offered = packet('summarize', ['summary'], ['items[0]', 'items.sealed', 'policy']);
  assert.equal(validModelOrderFields(reduce, offered), true);
  const forged = packet('summarize', ['summary'], ['items[0]', 'items.sealed', 'hostile']);
  assert.equal(validModelOrderFields(reduce, forged), false);
});

test('local binding accepts an Engine-issued judge order and refuses a different judged path', () => {
  const definition = buildDef({
    name: 'judged-binding',
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [{ name: 'researcher', consumes: ['question'], produces: [{ name: 'report',
      judges: [{ name: 'completeness', body: 'Check report.', inputs: true }],
    }] }],
  });
  const store = openStore(':memory:');
  try {
    const engine = new Engine(store, () => definition);
    const workflow = engine.createInstance(definition.name, { provide: { question: { text: 'prompt' } } });
    const producer = engine.tick(workflow).orders.find((order) => order.step === 'researcher')!;
    assert.equal(engine.green(workflow, producer.run, 'report', { text: 'draft' }).outcome, 'submitted');
    engine.close(workflow, producer.run);
    const judge = engine.tick(workflow).orders.find((order) => order.step.endsWith('.judges.completeness'))!;
    const local = definition.steps.find((step) => step.name === judge.step)!;
    assert.equal(local.judges, 'report');
    assert.deepEqual(local.produces, []);
    assert.deepEqual(judge.inputs, ['report', 'question']);
    assert.deepEqual(judge.outputs, ['report']);
    assert.deepEqual(judge.owes.map((owed) => owed.path), ['report']);
    assert.equal(validModelOrderFields(local, judge), true);
    const forged = structuredClone(judge);
    forged.outputs = ['hostile-stem'];
    forged.owes[0]!.path = 'hostile-stem';
    assert.equal(validModelOrderFields(local, forged), false);
    const missingInheritedInput = structuredClone(judge);
    missingInheritedInput.inputs = ['report'];
    delete missingInheritedInput.consumes['question'];
    assert.equal(validModelOrderFields(local, missingInheritedInput), false);
    const forgedCause = { ...judge, cause: 'allGreen' as const };
    assert.equal(validModelOrderFields(local, forgedCause), false);
  } finally {
    store.close();
  }
});
