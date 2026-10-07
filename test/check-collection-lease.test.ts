/** Differential controls for checker collection leases (Engine #236). */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { buildDef } from '../src/defs.ts';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import {
  collectionCheckKey, collectionLeaseSuccessors, collectionValueWitnesses,
  computeFingerprint, eligibleFirings, modelCheck,
} from '../src/model.ts';
import type { CollectionCheckState, CollectionLease } from '../src/model.ts';
import type { ArtifactData, WorkflowDef } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

function fixture(): WorkflowDef {
  const gather = step({
    name: 'gather', consumes: ['q'], produces: ['items[]'], maxSchemaFailures: 1,
  });
  gather.produces[0]!.schema = {
    type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } },
  };
  return def('collection-lease', [input('q', { seedOwed: false })], [
    gather,
    step({ name: 'inspect', consumes: ['items[$i]'], produces: ['items[$i].checked'] }),
  ]);
}

function fields(arts: Map<string, ArtifactData>) {
  return [...arts.values()].sort((a, b) => a.path.localeCompare(b.path)).map((art) => ({
    path: art.path, acceptance: art.acceptance, version: art.version,
    judgmentRejects: art.judgmentRejects, schemaRejects: art.schemaRejects,
    fingerprint: art.fingerprint,
  }));
}

test('checker initial modifier preflight agrees with Engine starts', () => {
  const definition = buildDef({ name: 'initial-route', modifiers: ['standard', 'deep'],
    inputs: [{ name: 'q', seedOwed: false }],
    steps: [{ name: 'work', consumes: ['q'], produces: ['out'], body: 'work' }] });
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  for (const modifier of [undefined, 'standard', 'deep']) {
    assert.doesNotThrow(() => engine.createInstance(definition.name, { modifier }));
    assert.doesNotThrow(() => modelCheck(definition, { modifier, maxStates: 100 }));
  }
  assert.throws(() => engine.createInstance(definition.name, { modifier: 'undeclared' }), /not declared/);
  assert.throws(() => modelCheck(definition, { modifier: 'undeclared' }), /not declared/);
});

test('collection lease: emit, later schema refusal, same-run correction after cap, and seal match Engine', () => {
  const definition = fixture();
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);

  const arts = () => new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = {
    step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(arts(), ['q']),
  };
  let model: CollectionCheckState = { arts: arts(), leases: [lease] };
  assert.notEqual(collectionCheckKey(definition, model),
    collectionCheckKey(definition, { arts: model.arts, leases: [] }),
    'an open task must have a distinct checker key even with identical artifacts');
  const witnesses = collectionValueWitnesses(definition.steps[0]!.produces[0]!.schema);
  assert.deepEqual(witnesses.valid, { ok: true });
  assert.deepEqual(witnesses.invalid, {});
  const move = (outcome: string, count?: number): void => {
    const next = collectionLeaseSuccessors(definition, model, lease, 2).find((entry) =>
      entry.step.outcome === outcome && entry.step.count === count);
    assert.ok(next, `expected ${outcome}${count === undefined ? '' : `(${count})`}`);
    model = next.state;
    assert.deepEqual(fields(model.arts), fields(arts()), `model/runtime diverged after ${outcome}`);
  };

  assert.deepEqual(engine.emit(wf, run.run, [{ value: witnesses.valid }]).created, ['items[0]']);
  move('collection-emit', 1);
  assert.equal(store.getArtifact(wf, 'items.sealed')?.acceptance, 'owed');
  assert.ok(eligibleFirings(definition, model.arts).some((firing) => firing.step === 'inspect'),
    'map work is eligible while the producer seal is unsealed');
  assert.ok(engine.tick(wf, { now: 2000 }).orders.some((order) => order.step === 'inspect'));

  const refused = engine.emit(wf, run.run, [
    { value: witnesses.valid }, { value: witnesses.invalid },
  ]);
  assert.equal(refused.outcome, 'schema-rejected');
  assert.deepEqual(refused.created, [], 'mixed good/bad batch accretes atomically');
  move('collection-schema-reject');
  assert.equal(store.getArtifact(wf, 'items[0]')?.acceptance, 'green');
  assert.equal(store.getArtifact(wf, 'items.sealed')?.schemaRejects, 1);

  assert.deepEqual(engine.emit(wf, run.run, [{ value: witnesses.valid }]).created, ['items[1]']);
  move('collection-emit', 1);
  assert.equal(store.getArtifact(wf, 'items.sealed')?.acceptance, 'rejected');
  assert.equal(engine.seal(wf, run.run).outcome, 'green');
  move('collection-seal');
  assert.equal(engine.emit(wf, run.run, [{ value: witnesses.valid }]).outcome, 'sealed-rejected');
  assert.ok(!collectionLeaseSuccessors(definition, model, lease, 2).some((entry) =>
    entry.step.outcome === 'collection-emit'), 'a green seal rejects later emits');
  assert.equal(engine.seal(wf, run.run).outcome, 'green', 'a still-open run may seal again');
  move('collection-seal');
  assert.equal(store.getArtifact(wf, 'items.sealed')?.version, 2);
  engine.close(wf, run.run);
  move('collection-close');
  assert.deepEqual(model.leases, []);
});

test('collection lease: moved claim input born-rejects the seal before emit or seal', () => {
  const definition = fixture();
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  const initial = new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = {
    step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(initial, ['q']),
  };
  engine.provideInput(wf, 'q', { newer: true });
  const modelArts = new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const before = { arts: modelArts, leases: [lease] };
  const born = collectionLeaseSuccessors(definition, before, lease, 2).find((entry) =>
    entry.step.outcome === 'collection-born-reject');
  assert.ok(born);
  assert.equal(engine.emit(wf, run.run, [{ value: { ok: true } }]).outcome, 'born-rejected');
  assert.deepEqual(fields(born.state.arts), fields(new Map(store.listArtifacts(wf).map((art) => [art.path, art]))));
  assert.deepEqual(born.state.leases, []);
});

test('collection lease: checker reaches unsealed member and schema refusal as separate states', () => {
  const definition = fixture();
  definition.invariants = [
    { name: 'member-requires-seal', when: { path: 'items[0]', is: 'green' },
      requires: { path: 'items.sealed', is: 'green' } },
    { name: 'seal-never-rejected', requires: { not: { path: 'items.sealed', is: 'rejected' } } },
  ];
  const report = modelCheck(definition, {
    maxStates: 2000, maxDepth: 30, maxCollectionSize: 2, assumeProvided: true,
  });
  assert.equal(report.collectionCapApplied, true);
  assert.equal(report.collectionSchemaValuesSampled, true);
  const beforeSeal = report.invariantViolations.find((finding) => finding.invariant === 'member-requires-seal');
  assert.ok(beforeSeal);
  assert.ok(beforeSeal.path.some((move) => move.outcome === 'collection-emit'));
  assert.ok(!beforeSeal.path.some((move) => move.outcome === 'collection-seal'));
  const refused = report.invariantViolations.find((finding) => finding.invariant === 'seal-never-rejected');
  assert.ok(refused?.path.some((move) => move.outcome === 'collection-schema-reject'));
});

test('collection lease: invocation wait does not hide an open producer run', () => {
  const definition = def('invocation-with-collection', [input('q', { seedOwed: false })], [
    step({ name: 'gather', consumes: ['q'], produces: ['items[]'] }),
    {
      ...step({ name: 'choose', produces: ['choice'] }),
      callsInterface: {
	name: 'report', version: '1', selection: 'invocation',
	signature: { inputs: [{ name: 'data', schema: true }], outputs: [{ name: 'result', schema: true }] },
	policy: { name: 'local', version: '1', config: {} },
      },
      callsInputs: { data: 'q' },
    },
  ]);
  definition.invariants = [{
    name: 'member-requires-seal', when: { path: 'items[0]', is: 'green' },
    requires: { path: 'items.sealed', is: 'green' },
  }];
  const report = modelCheck(definition, {
    maxStates: 2000, maxDepth: 20, maxCollectionSize: 1, assumeProvided: true,
  });
  const beforeSeal = report.invariantViolations.find((finding) => finding.invariant === 'member-requires-seal');
  assert.ok(beforeSeal?.path.some((move) => move.outcome === 'collection-emit'),
    'an unrelated invocation wait must not suppress valid lease transitions');
  assert.ok(report.externalSelectionWait?.length,
    'the checker still reports the invocation wait after other work stops');
});

test('collection lease: a capped schema-refused seal is recoverable while its producer run remains open', () => {
  const report = modelCheck(fixture(), {
    maxStates: 2000, maxDepth: 30, maxCollectionSize: 1, assumeProvided: true,
  });
  const outcomes = (path: { outcome: string }[]) => path.map((move) => move.outcome).join(',');
  const stillOpen = 'collection-claim,collection-emit,collection-schema-reject';
  assert.ok(!report.stuck.some((finding) => outcomes(finding.path) === stillOpen),
    'a schema-capped seal is not stuck while the same claimed run can correct and seal');
  assert.ok(report.stuck.some((finding) => outcomes(finding.path) === `${stillOpen},collection-close`),
    'closing the run at the cap can leave a real stalled debt while map work continues');
});

test('collection lease: mixed producer emits before singleton green on one runtime run', () => {
  const definition = def('mixed-collection-lease', [input('q', { seedOwed: false })], [
    step({ name: 'gather', consumes: ['q'], produces: ['note', 'items[]'] }),
    step({ name: 'inspect', consumes: ['items[$i]'], produces: ['items[$i].checked'] }),
  ]);
  definition.invariants = [{
    name: 'member-needs-note', when: { path: 'items[0]', is: 'green' },
    requires: { path: 'note', is: 'green' },
  }];
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  assert.ok(run.owes.some((owed) => owed.path === 'note'));
  assert.ok(run.owes.some((owed) => owed.path === 'items.sealed'));
  const arts = () => new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = {
    step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(arts(), ['q']),
  };
  let model: CollectionCheckState = { arts: arts(), leases: [lease] };
  const move = (outcome: string, path?: string) => {
    const transition = collectionLeaseSuccessors(definition, model, lease, 1).find((entry) =>
      entry.step.outcome === outcome && entry.step.path === path);
    assert.ok(transition, `expected same-run ${outcome} ${path ?? ''}`);
    model = transition.state;
    assert.deepEqual(fields(model.arts), fields(arts()));
  };

  assert.deepEqual(engine.emit(wf, run.run, [{ value: {} }]).created, ['items[0]']);
  move('collection-emit', 'items.sealed');
  assert.equal(store.getArtifact(wf, 'note')?.acceptance, 'owed');
  assert.ok(engine.tick(wf, { now: 2000 }).orders.some((order) => order.step === 'inspect'));
  assert.equal(engine.green(wf, run.run, 'note', {}).outcome, 'green');
  move('green', 'note');
  assert.equal(engine.seal(wf, run.run).outcome, 'green');
  move('collection-seal', 'items.sealed');

  // The same claimed-run verbs can occur in the reverse order as well.
  const wfReverse = engine.createInstance(definition.name);
  const runReverse = engine.tick(wfReverse, { now: 3000 }).orders.find((order) => order.step === 'gather');
  assert.ok(runReverse);
  const reverseArts = () => new Map(store.listArtifacts(wfReverse).map((art) => [art.path, art]));
  const reverseLease: CollectionLease = {
    step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(reverseArts(), ['q']),
  };
  let reverse: CollectionCheckState = { arts: reverseArts(), leases: [reverseLease] };
  const reverseMove = (outcome: string, path?: string) => {
    const transition = collectionLeaseSuccessors(definition, reverse, reverseLease, 1).find((entry) =>
      entry.step.outcome === outcome && entry.step.path === path);
    assert.ok(transition, `expected reverse-order ${outcome}`);
    reverse = transition.state;
    assert.deepEqual(fields(reverse.arts), fields(reverseArts()));
  };
  assert.equal(engine.green(wfReverse, runReverse.run, 'note', {}).outcome, 'green');
  reverseMove('green', 'note');
  assert.deepEqual(engine.emit(wfReverse, runReverse.run, [{ value: {} }]).created, ['items[0]']);
  reverseMove('collection-emit', 'items.sealed');
  assert.equal(engine.seal(wfReverse, runReverse.run).outcome, 'green');
  reverseMove('collection-seal', 'items.sealed');

  const report = modelCheck(definition, {
    maxStates: 1000, maxDepth: 20, maxCollectionSize: 1, assumeProvided: true,
  });
  const witness = report.invariantViolations.find((finding) => finding.invariant === 'member-needs-note');
  assert.deepEqual(witness?.path.map((step) => step.outcome), ['collection-claim', 'collection-emit']);
  assert.equal(report.bounded, false, 'BFS can exhaust its finite model');
  assert.deepEqual(report.coverageIncomplete, ['collection-width-cap'],
    'finite width stays explicit rather than being confused with BFS exhaustion');
});

test('collection lease: scoped singleton judge uses the selected modifier on the same run', () => {
  const definition = buildDef({
    name: 'scoped-mixed-collection', modifiers: ['standard', 'deep'],
    inputs: [{ name: 'q', seedOwed: false }],
    steps: [{
      name: 'gather', consumes: ['q'], body: 'gather',
      produces: [
        { name: 'note', judges: [{ name: 'review', body: 'review', modifiers: ['deep'] }] },
        'items[]',
      ],
    }],
  });
  for (const [modifier, expected] of [['standard', 'green'], ['deep', 'submitted']] as const) {
    const store = openStore(':memory:');
    const engine = new Engine(store, () => definition);
    const wf = engine.createInstance(definition.name, { modifier });
    const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
    assert.ok(run);
    const arts = new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
    const lease: CollectionLease = {
      step: 'gather', key: '', stem: 'items', inputs: ['q'], fingerprint: computeFingerprint(arts, ['q']),
    };
    const modeled = collectionLeaseSuccessors(definition, { arts, leases: [lease] }, lease, 1, modifier)
      .find((move) => move.step.outcome === 'green' && move.step.path === 'note');
    assert.ok(modeled);
    assert.equal(engine.green(wf, run.run, 'note', {}).outcome, expected);
    assert.equal(modeled.state.arts.get('note')?.acceptance, expected);
    assert.deepEqual(fields(modeled.state.arts), fields(new Map(store.listArtifacts(wf).map((art) => [art.path, art]))));
    const repeated = collectionLeaseSuccessors(definition, modeled.state, lease, 1, modifier)
      .find((move) => move.step.outcome === 'green' && move.step.path === 'note');
    assert.ok(repeated, 'an open run can commit a singleton again after its first accepted version');
    assert.equal(engine.green(wf, run.run, 'note', {}).outcome, expected);
    assert.equal(repeated.state.arts.get('note')?.version, 2);
    assert.deepEqual(fields(repeated.state.arts), fields(new Map(store.listArtifacts(wf).map((art) => [art.path, art]))));
    const sealed = collectionLeaseSuccessors(definition, repeated.state, lease, 1, modifier)
      .find((move) => move.step.outcome === 'collection-seal');
    assert.ok(sealed);
    engine.seal(wf, run.run);
    assert.deepEqual(fields(sealed.state.arts), fields(new Map(store.listArtifacts(wf).map((art) => [art.path, art]))));
    const afterSeal = collectionLeaseSuccessors(definition, sealed.state, lease, 1, modifier)
      .find((move) => move.step.outcome === 'green' && move.step.path === 'note');
    assert.ok(afterSeal, 'sealing does not close the run or make its singleton output immutable');
    assert.equal(engine.green(wf, run.run, 'note', {}).outcome, expected);
    assert.equal(afterSeal.state.arts.get('note')?.version, 3);
    assert.deepEqual(fields(afterSeal.state.arts), fields(new Map(store.listArtifacts(wf).map((art) => [art.path, art]))));
  }

  definition.invariants = [{
    name: 'note-before-seal', when: { path: 'note', is: 'green' },
    requires: { path: 'items.sealed', is: 'green' },
  }];
  const check = (modifier: string) => modelCheck(definition, {
    modifier, maxDepth: 2, maxStates: 1000, maxCollectionSize: 1, assumeProvided: true,
  });
  assert.ok(check('standard').invariantViolations.some((finding) => finding.invariant === 'note-before-seal'));
  assert.ok(!check('deep').invariantViolations.some((finding) => finding.invariant === 'note-before-seal'),
    'the active judge submits the note; green requires a separate approval outside this two-move prefix');
});

test('collection lease: concrete modifier binds, refusal, and same-value rebind match Engine routing', () => {
  const definition = buildDef({
    name: 'mixed-routing', modifiers: ['standard', 'deep'],
    inputs: [{ name: 'q', seedOwed: false }],
    steps: [{ name: 'gather', consumes: ['q'], body: 'gather', produces: [
      { name: 'selection', schema: { type: 'object', required: ['modifier'],
	properties: { modifier: { type: 'string' } } }, bind: 'modifier' },
      'items[]',
    ] }],
  });
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name, { modifier: 'standard' });
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  const arts = () => new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = { step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(arts(), ['q']) };
  let model: CollectionCheckState = { arts: arts(), leases: [lease], modifier: 'standard' };
  for (const selected of ['standard', 'deep', 'bogus', 'deep']) {
    const actual = engine.green(wf, run.run, 'selection', { modifier: selected });
    const wanted = selected === 'bogus' ? 'schema-reject' : 'green';
    const moves = collectionLeaseSuccessors(definition, model, lease, 1)
      .filter((move) => move.step.outcome === wanted && move.step.path === 'selection');
    const next = moves.find((move) => wanted === 'schema-reject'
      || move.state.modifier === selected);
    assert.ok(next, `checker needs concrete ${selected} branch`);
    if (wanted === 'green') assert.equal(next.step.selectedModifier, selected);
    assert.equal(actual.outcome, selected === 'bogus' ? 'schema-rejected' : 'green');
    model = next.state;
    assert.equal(model.modifier, store.getWorkflow(wf)?.modifier);
    assert.deepEqual(fields(model.arts), fields(arts()));
  }
  const standard = { ...model, modifier: 'standard' };
  assert.notEqual(collectionCheckKey(definition, standard), collectionCheckKey(definition, model));
});

test('collection lease: judged bind keeps routing pending and replaces it on repeated submission', () => {
  const definition = buildDef({ name: 'judged-mixed-route', modifiers: ['standard', 'deep'],
    inputs: [{ name: 'q', seedOwed: false }],
    steps: [{ name: 'gather', consumes: ['q'], body: 'gather', produces: [
      { name: 'selection', bind: 'modifier', judges: [{ name: 'review', body: 'review' }] },
      'items[]',
    ] }],
  });
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name, { modifier: 'standard' });
  const run = engine.tick(wf).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  const arts = () => new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = { step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(arts(), ['q']) };
  let model: CollectionCheckState = { arts: arts(), leases: [lease], modifier: 'standard' };
  for (const selected of ['deep', 'standard']) {
    assert.equal(engine.green(wf, run.run, 'selection', { modifier: selected }).outcome, 'submitted');
    const next = collectionLeaseSuccessors(definition, model, lease, 1).find((move) =>
      move.step.outcome === 'green' && move.step.path === 'selection'
      && move.step.selectedModifier === selected);
    assert.ok(next);
    model = next.state;
    assert.equal(model.modifier, 'standard');
    assert.equal(model.pendingModifiers?.selection, selected);
    assert.equal(store.getWorkflow(wf)?.modifier, 'standard');
    assert.deepEqual(fields(model.arts), fields(arts()));
  }
  assert.notEqual(collectionCheckKey(definition, model), collectionCheckKey(definition,
    { ...model, pendingModifiers: { selection: 'deep' } }),
  'pending choice changes the future final-approval route');
  const moved = new Map(model.arts);
  moved.set('selection', { ...moved.get('selection')!, acceptance: 'rejected' });
  assert.equal(collectionCheckKey(definition, { ...model, arts: moved }),
    collectionCheckKey(definition, { ...model, arts: moved, pendingModifiers: { selection: 'deep' } }),
    'a stale choice on a non-submitted artifact cannot affect future eligibility');
  const judge = engine.tick(wf).orders.find((order) => order.step.endsWith('.review'));
  assert.ok(judge);
  assert.equal(engine.green(wf, judge.run, 'selection', {}).outcome, 'green');
  assert.equal(store.getWorkflow(wf)?.modifier, 'standard', 'the latest submitted value wins');
});

test('checker reaches modifier-scoped judges after approved bind, from an absent initial modifier', () => {
  const definition = buildDef({
    name: 'judged-routing', modifiers: ['standard', 'deep'],
    inputs: [{ name: 'q', seedOwed: false }],
    steps: [
      { name: 'select', consumes: ['q'], body: 'select', produces: [
	{ name: 'selection', bind: { from: 'payload.modifier', to: 'modifier' },
	  schema: { type: 'object', required: ['kind', 'payload'], properties: {
	    kind: { const: 'receipt' },
	    payload: { type: 'object', required: ['modifier'], properties: {
	      modifier: { type: 'string', enum: ['standard', 'deep'] },
	    } },
	  } }, judges: [
	  { name: 'approve', body: 'approve' },
	] },
      ] },
      { name: 'use', consumes: ['selection'], body: 'use', produces: [
	{ name: 'result', judges: [{ name: 'deepReview', body: 'review', modifiers: ['deep'] }] },
      ] },
    ],
  });
  definition.invariants = [{ name: 'requires-result', when: { path: 'selection', is: 'green' },
    requires: { path: 'result', is: 'green' } }];
  const report = modelCheck(definition, { maxDepth: 8, maxStates: 5000, assumeProvided: true });
  assert.ok(!report.coverageIncomplete.includes('singleton-bind-modifier'),
    'both declared modifiers have concrete schema-valid complete payloads');
  const witness = report.invariantViolations.find((finding) => finding.invariant === 'requires-result');
  assert.ok(witness);
  const submitted = witness.path.find((entry) => entry.step === 'select' && entry.outcome === 'green');
  const approved = witness.path.find((entry) => entry.outcome === 'judge-approve');
  assert.ok(submitted?.selectedModifier);
  assert.equal(approved?.selectedModifier, submitted.selectedModifier,
    'a trace records the pending choice at submission and its later approval');
  assert.ok(!report.structurallyDeadSteps.includes('use.result.judges.deepReview'));
  assert.ok(!report.unreachedSteps.includes('use.result.judges.deepReview'),
    'deep judge must become eligible after final approval changes routing');
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const producer = engine.tick(wf).orders.find((order) => order.step === 'select');
  assert.ok(producer);
  assert.equal(engine.green(wf, producer.run, 'selection',
    { kind: 'receipt', payload: { modifier: 'deep' } }).outcome, 'submitted');
  assert.equal(store.getWorkflow(wf)?.modifier, undefined, 'submission has not changed routing');
  const judge = engine.tick(wf).orders.find((order) => order.step.endsWith('.approve'));
  assert.ok(judge);
  assert.equal(engine.green(wf, judge.run, 'selection', {}).outcome, 'green');
  assert.equal(store.getWorkflow(wf)?.modifier, 'deep');
  const worker = engine.tick(wf).orders.find((order) => order.step === 'use');
  assert.ok(worker);
  assert.equal(engine.green(wf, worker.run, 'result', {}).outcome, 'submitted');
  assert.ok(engine.tick(wf).orders.some((order) => order.step.endsWith('.deepReview')));
});

test('collection lease: losing group sibling refuses before stale-input CAS', () => {
  const definition = buildDef({
    name: 'mixed-group-stale',
    inputs: [{ name: 'q', seedOwed: false }],
    steps: [{
      name: 'gather', consumes: ['q'], body: 'gather', terminal: true,
      produces: [
        'left', 'right', 'items[]',
        { group: 'choice', mode: 'exactlyOne', of: ['left', 'right'] },
      ],
    }],
  });
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const arts = () => new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  const lease: CollectionLease = {
    step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(arts(), ['q']),
  };
  assert.equal(engine.green(wf, run.run, 'left', {}).outcome, 'green');
  assert.equal(store.getArtifact(wf, 'right')?.acceptance, 'skipped');
  assert.equal(engine.green(wf, 'human', 'q', {}).outcome, 'green');
  const before = arts();
  const refused = collectionLeaseSuccessors(definition, { arts: before, leases: [lease] }, lease, 1)
    .find((move) => move.step.outcome === 'group-reject' && move.step.path === 'right');
  assert.ok(refused);
  assert.equal(engine.green(wf, run.run, 'right', {}).outcome, 'group-rejected');
  assert.equal(refused.state.leases.length, 1, 'group refusal leaves the claimed run open');
  assert.deepEqual(fields(refused.state.arts), fields(arts()));
});

test('collection lease: stale CAS uses rebound modifier for scoped group precedence', () => {
  const definition = buildDef({ name: 'rebound-stale-group', modifiers: ['standard', 'deep'],
    inputs: [{ name: 'q', seedOwed: false }],
    steps: [{ name: 'gather', consumes: ['q'], body: 'gather', produces: [
      { name: 'selection', bind: 'modifier' },
      'left',
      { name: 'right', judges: [{ name: 'review', body: 'review', modifiers: ['deep'] }] },
      'items[]',
      { group: 'choice', mode: 'exactlyOne', of: ['left', 'right'] },
    ] }],
  });
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name, { modifier: 'standard' });
  const run = engine.tick(wf).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  const arts = () => new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = { step: 'gather', key: '', stem: 'items', inputs: ['q'],
    fingerprint: computeFingerprint(arts(), ['q']) };
  assert.equal(engine.green(wf, run.run, 'left', {}).outcome, 'green');
  assert.equal(engine.green(wf, run.run, 'selection', { modifier: 'deep' }).outcome, 'green');
  assert.equal(store.getWorkflow(wf)?.modifier, 'deep');
  engine.green(wf, 'human', 'q', { changed: true });
  const model: CollectionCheckState = { arts: arts(), leases: [lease], modifier: 'deep' };
  const next = collectionLeaseSuccessors(definition, model, lease, 1).find((move) =>
    move.step.path === 'right' && move.step.outcome === 'collection-born-reject');
  assert.ok(next, 'deep judge defers group exclusion, so stale CAS born-rejects');
  assert.equal(engine.green(wf, run.run, 'right', {}).outcome, 'born-rejected');
  assert.deepEqual(fields(next.state.arts), fields(arts()));
});

test('collection lease: unsampled real schema-valid value is an incomplete check, not a clean archive proof', () => {
  const gather = step({ name: 'gather', consumes: ['q'], produces: ['items[]'] });
  gather.produces[0]!.schema = {
    type: 'object', required: ['code'],
    properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } },
  };
  const definition = def('regex-collection', [input('q', { seedOwed: false })], [
    gather,
    step({ name: 'inspect', consumes: ['items[$i]'], produces: ['items[$i].checked'] }),
  ]);
  const witnesses = collectionValueWitnesses(gather.produces[0]!.schema);
  assert.equal(witnesses.valid, undefined, 'the finite sampler does not discover ABC');
  assert.equal(witnesses.validClassKnown, false);
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  assert.deepEqual(engine.emit(wf, run.run, [{ value: { code: 'ABC' } }]).created, ['items[0]'],
    'a real valid runtime payload is omitted by the candidate sampler');

  const report = modelCheck(definition, {
    maxStates: 1000, maxCollectionSize: 1, assumeProvided: true,
  });
  assert.equal(report.bounded, false, 'finite BFS exhaustion is a separate fact');
  assert.ok(report.coverageIncomplete.includes('collection-schema-validity'));
  assert.ok(report.coverageIncomplete.includes('collection-width-cap'));

  const defs = mkdtempSync(join(tmpdir(), 'owenloop-check-regex-'));
  writeFileSync(join(defs, `${definition.name}.yaml`), [
    `name: ${definition.name}`,
    'inputs: [{ name: q, seedOwed: false }]',
    'steps:',
    '  - name: gather',
    '    consumes: [q]',
    '    produces:',
    '      - name: "items[]"',
    '        schema:',
    '          type: object',
    '          required: [code]',
    '          properties:',
    '            code: { type: string, pattern: "^[A-Z]{3}$" }',
    '    body: gather',
    '  - name: inspect',
    '    consumes: ["items[$i]"]',
    '    produces: ["items[$i].checked"]',
    '    body: inspect',
  ].join('\n'));
  const runCheck = (format: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(['check', definition.name, '--format', format, '--max-collection', '1'], {
      cwd: defs, env: { OWENLOOP_DEFS: defs, OWENLOOP_DB: join(defs, 'state.db') },
      out: (line) => out.push(line), err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const text = runCheck('text');
  assert.equal(text.code, 0, 'unknown schema-value classes remain diagnostic');
  assert.match(text.out, /Status: INCOMPLETE/);
  assert.match(text.out, /MODEL COVERAGE INCOMPLETE/);
  assert.doesNotMatch(text.err, /model coverage incomplete/);
  assert.doesNotMatch(text.err, /definite defects found/);
  const json = runCheck('json');
  assert.equal(json.code, 0);
  assert.ok(JSON.parse(json.out).coverageIncomplete.includes('collection-schema-validity'));
});

test('collection lease: object-only schema cannot prove all JS emit payloads valid', () => {
  const schema = { type: 'object' } as const;
  const witnesses = collectionValueWitnesses(schema);
  assert.equal(witnesses.invalid, undefined, 'the object candidate sampler finds no refusal');
  assert.equal(witnesses.invalidClassKnown, false, 'the runtime does not enforce the TS Record shape');
  assert.equal(collectionValueWitnesses({}).invalidClassKnown, true, 'unconstrained schema has no refusal class');

  const gather = step({ name: 'gather', consumes: ['q'], produces: ['items[]'] });
  gather.produces[0]!.schema = schema;
  const definition = def('object-only-collection', [input('q', { seedOwed: false })], [gather]);
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  const invalid = engine.emit(wf, run.run, [{ value: [] as unknown as Record<string, unknown> }]);
  assert.equal(invalid.outcome, 'schema-rejected');
  assert.deepEqual(invalid.created, []);
  const report = modelCheck(definition, { maxStates: 1000, maxCollectionSize: 1, assumeProvided: true });
  assert.ok(report.coverageIncomplete.includes('collection-schema-refusal'));
});

test('collection lease: mixed singleton schema with no valid value cannot invent a green witness', () => {
  const gather = step({ name: 'gather', consumes: ['q'], produces: ['note', 'items[]'] });
  gather.produces.find((produce) => produce.stem === 'note')!.schema = false;
  const definition = def('mixed-impossible-note', [input('q', { seedOwed: false })], [gather]);
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const run = engine.tick(wf, { now: 1000 }).orders.find((order) => order.step === 'gather');
  assert.ok(run);
  assert.equal(engine.green(wf, run.run, 'note', {}).outcome, 'schema-rejected');
  const arts = new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = {
    step: 'gather', key: '', stem: 'items', inputs: ['q'], fingerprint: computeFingerprint(arts, ['q']),
  };
  const moves = collectionLeaseSuccessors(definition, { arts, leases: [lease] }, lease, 1);
  assert.ok(!moves.some((move) => move.step.outcome === 'green' && move.step.path === 'note'));
  assert.ok(moves.some((move) => move.step.outcome === 'schema-reject' && move.step.path === 'note'));
  const report = modelCheck(definition, { maxStates: 1000, maxCollectionSize: 1, assumeProvided: true });
  assert.ok(report.coverageIncomplete.includes('collection-mixed-output-values'));
});
