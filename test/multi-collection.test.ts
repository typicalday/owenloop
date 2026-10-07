import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDef } from '../src/defs.ts';
import { Engine } from '../src/engine.ts';
import { collectionLeaseSuccessors, computeFingerprint, hasDefiniteCheckDefect, modelCheck } from '../src/model.ts';
import type { CollectionCheckState, CollectionLease } from '../src/model.ts';
import { openStore } from '../src/store.ts';
import type { ArtifactData, WorkflowDef } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

function fixture(): WorkflowDef {
  const gather = step({ name: 'gather', consumes: ['seed'], produces: ['left[]', 'right[]'] });
  gather.produces[0]!.schema = { type: 'object', required: ['side'], properties: { side: { const: 'left' } } };
  gather.produces[1]!.schema = { type: 'object', required: ['side'], properties: { side: { const: 'right' } } };
  return def('two-collections', [input('seed', { seedOwed: false })], [gather]);
}

function fields(arts: Map<string, ArtifactData>) {
  return [...arts.values()].sort((a, b) => a.path.localeCompare(b.path)).map((art) => ({
    path: art.path, acceptance: art.acceptance, version: art.version,
    schemaRejects: art.schemaRejects, fingerprint: art.fingerprint,
  }));
}

test('plain multi-collection native verbs require an owed stem and preserve sibling debt', () => {
  const definition = fixture();
  assert.deepEqual(validateDef(definition), []);
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const order = engine.tick(wf).orders[0]!;
  assert.deepEqual(order.outputs, ['left.sealed', 'right.sealed']);
  assert.throws(() => engine.emit(wf, order.run, [{ value: { side: 'right' } }]), /specify a stem/);
  assert.throws(() => engine.seal(wf, order.run), /specify a stem/);
  assert.throws(() => engine.emit(wf, order.run, [], { stem: 'absent' }), /does not owe collection seal/);
  assert.equal(store.getArtifact(wf, 'right[0]'), undefined);

  const invalid = engine.emit(wf, order.run, [{ value: { side: 'left' } }], { stem: 'right' });
  assert.equal(invalid.outcome, 'schema-rejected');
  assert.equal(store.getArtifact(wf, 'right.sealed')?.schemaRejects, 1);
  assert.equal(store.getArtifact(wf, 'left.sealed')?.schemaRejects, 0);
  assert.deepEqual(engine.emit(wf, order.run, [{ value: { side: 'right' } }], { stem: 'right' }).created, ['right[0]']);
  assert.equal(engine.seal(wf, order.run, {}, { stem: 'right' }).outcome, 'green');
  assert.equal(store.getArtifact(wf, 'left.sealed')?.acceptance, 'owed');
  assert.equal(store.getRun(order.run)?.outcome, undefined);
  assert.equal(engine.emit(wf, order.run, [{ value: { side: 'right' } }], { stem: 'right' }).outcome, 'sealed-rejected');
  assert.deepEqual(engine.emit(wf, order.run, [{ value: { side: 'left' } }], { stem: 'left' }).created, ['left[0]']);
  assert.equal(engine.seal(wf, order.run, {}, { stem: 'left' }).outcome, 'green');
  engine.close(wf, order.run);
  assert.equal(store.getRun(order.run)?.outcome, 'ok');
});

test('one checker lease models both stems and matches native per-stem effects', () => {
  const definition = fixture();
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const order = engine.tick(wf).orders[0]!;
  const arts = () => new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = {
    step: 'gather', key: '', stem: 'left', stems: ['left', 'right'], inputs: ['seed'],
    fingerprint: computeFingerprint(arts(), ['seed']),
  };
  let model: CollectionCheckState = { arts: arts(), leases: [lease] };
  const move = (outcome: string, path: string, count?: number) => {
    const next = collectionLeaseSuccessors(definition, model, lease, 1).find((entry) =>
      entry.step.outcome === outcome && entry.step.path === path && entry.step.count === count);
    assert.ok(next, `${outcome} ${path} is a legal checker transition`);
    model = next.state;
    assert.deepEqual(fields(model.arts), fields(arts()), `${outcome} ${path} differs from Engine`);
  };

  assert.equal(engine.emit(wf, order.run, [{ value: { side: 'left' } }], { stem: 'right' }).outcome, 'schema-rejected');
  move('collection-schema-reject', 'right.sealed');
  engine.emit(wf, order.run, [{ value: { side: 'right' } }], { stem: 'right' });
  move('collection-emit', 'right.sealed', 1);
  engine.seal(wf, order.run, {}, { stem: 'right' });
  move('collection-seal', 'right.sealed');
  assert.ok(collectionLeaseSuccessors(definition, model, lease, 1).some((entry) =>
    entry.step.outcome === 'collection-emit' && entry.step.path === 'left.sealed'));
  assert.ok(!collectionLeaseSuccessors(definition, model, lease, 1).some((entry) =>
    entry.step.outcome === 'collection-emit' && entry.step.path === 'right.sealed'));
  engine.emit(wf, order.run, [{ value: { side: 'left' } }], { stem: 'left' });
  move('collection-emit', 'left.sealed', 1);
  engine.seal(wf, order.run, {}, { stem: 'left' });
  move('collection-seal', 'left.sealed');
  engine.close(wf, order.run);
  const close = collectionLeaseSuccessors(definition, model, lease, 1).find((entry) =>
    entry.step.outcome === 'collection-close');
  assert.ok(close);
  assert.deepEqual(close.state.leases, []);
});

test('moved input born-rejects the selected sibling seal and releases the one lease', () => {
  const definition = fixture();
  const store = openStore(':memory:');
  const engine = new Engine(store, () => definition);
  const wf = engine.createInstance(definition.name);
  const order = engine.tick(wf).orders[0]!;
  const initial = new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const lease: CollectionLease = {
    step: 'gather', key: '', stem: 'left', stems: ['left', 'right'], inputs: ['seed'],
    fingerprint: computeFingerprint(initial, ['seed']),
  };
  engine.provideInput(wf, 'seed', { changed: true });
  const before = new Map(store.listArtifacts(wf).map((art) => [art.path, art]));
  const born = collectionLeaseSuccessors(definition, { arts: before, leases: [lease] }, lease, 1)
    .find((entry) => entry.step.outcome === 'collection-born-reject'
      && entry.step.path === 'right.sealed');
  assert.ok(born);
  assert.equal(engine.emit(wf, order.run, [{ value: { side: 'right' } }], { stem: 'right' }).outcome,
    'born-rejected');
  assert.deepEqual(fields(born.state.arts), fields(new Map(store.listArtifacts(wf).map((art) => [art.path, art]))));
  assert.deepEqual(born.state.leases, []);
  assert.equal(store.getArtifact(wf, 'left.sealed')?.acceptance, 'owed');
  assert.equal(store.getArtifact(wf, 'right.sealed')?.acceptance, 'rejected');
});

test('checker explores second-stem seal and never calls its recoverable debt a definite deadlock', () => {
  const report = modelCheck(fixture(), { maxStates: 1000, maxDepth: 12, maxCollectionSize: 1 });
  assert.ok(report.stats.statesExplored > 0);
  assert.ok(report.coverageIncomplete.includes('collection-width-cap'));
  assert.equal(hasDefiniteCheckDefect(report), false);
  assert.ok(!report.stuck.some((finding) => finding.path.some((move) =>
    move.outcome === 'collection-seal' && move.path === 'right.sealed')));
});

test('checker reports an executable right-first invariant witness with its target path', () => {
  const definition = fixture();
  definition.invariants = [{
    name: 'left-before-right',
    when: { path: 'right.sealed', is: 'green' },
    requires: { path: 'left.sealed', is: 'green' },
  }];
  const report = modelCheck(definition, { maxStates: 1000, maxDepth: 12, maxCollectionSize: 1 });
  const violation = report.invariantViolations.find((finding) => finding.invariant === 'left-before-right');
  assert.ok(violation);
  assert.ok(violation.path.some((move) => move.outcome === 'collection-seal'
    && move.path === 'right.sealed'));
  assert.ok(!violation.path.some((move) => move.outcome === 'collection-seal'
    && move.path === 'left.sealed'));
});
