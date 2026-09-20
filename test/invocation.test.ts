import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateSetDigest, evidenceDigest, inheritedBindingAssessment, jsonOnly, validInvocationCall, assessContract } from '../src/invocation.ts';
import { valueDigestHex } from '../src/crypto/canonical.ts';
import { def, input, step } from './helpers.ts';
import type { AssessedCandidate, InvocationCall, InvocationEvidence } from '../src/types.ts';
import { Engine } from '../src/engine.ts';
import { digestScopedCallsTargetKey, resolveCallsTarget } from '../src/defs.ts';
import { runtimeFixture, ready } from './helpers/runtime-selection.ts';

test('raw Engine without host authority refuses real invocation transitions', async (t) => {
  const f = await runtimeFixture();
  t.after(() => f.store.close());
  const raw = new Engine(f.store, (name, from, digest) => {
    const d = digest ? f.defs.get(digestScopedCallsTargetKey(digest, name)) ?? f.defs.get(name)
      : from ? resolveCallsTarget(f.defs, name, from) : f.defs.get(name);
    if (!d) throw new Error(`missing ${name}`);
    return d;
  });
  const workflow = f.engine.createInstance('parent/parent@1.0.0', { provide: { seed: { n: 1 } } });
  const snapshot = ready(f.engine, workflow, 'one', f.candidates);
  const changes = () => f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const before = changes();
  assert.deepEqual(raw.decisionSnapshot(workflow, 'one', f.candidates), { kind: 'parent-unverified' });
  assert.equal(raw.applyChoice(snapshot, f.candidates[0]!).kind, 'invalid-decision');
  assert.equal(changes(), before, 'refusal cannot insert a binding');
  assert.equal(f.engine.applyChoice(snapshot, f.candidates[0]!).kind, 'bound');
  assert.equal(raw.tick(workflow).orders.length, 0);
  assert.equal(f.store.listWorkflows().length, 1, 'stored selection cannot authorize child provisioning');
  assert.equal(raw.snapshotReady(workflow, { now: 10, revision: 'test' }).kind, 'unverified');
  const order = f.engine.tick(workflow).orders[0]!;
  f.engine.green(order.workflow, order.run, 'result', { ok: true });
  f.engine.close(order.workflow, order.run);
  const key = { parentWorkflow: workflow, parentDefRef: snapshot.key.parentDefRef,
    callPath: 'one', parentArtifactVersion: f.store.getArtifact(workflow, 'one')!.version };
  assert.ok(await f.engine.invocationBindingSource().read(key));
  assert.equal(await raw.invocationBindingSource().read(key), undefined);
});

const contract: InvocationCall = { name: 'i', version: '1', selection: 'invocation',
  signature: { inputs: [{ name: 'data', schema: true }], outputs: [{ name: 'result', schema: true }] },
  policy: { name: 'local', version: '1', config: {} } };
const evidence: InvocationEvidence[] = [{ childInput: 'z', parentPath: 'b', version: 2, value: { b: 2, a: 1 } },
  { childInput: 'a', parentPath: 'x', version: 1, value: { x: true } }];

test('canonical invocation fixed vectors preserve algorithm and explicit ordering', () => {
  assert.equal(valueDigestHex({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.equal(evidenceDigest(evidence), 'e45adbc15a0d22f710cf13dda2efd07f82b3eae6a2615f62ec10ada84b757a3f');
  assert.equal(evidenceDigest(evidence), evidenceDigest([...evidence].reverse()));
  const candidates: AssessedCandidate[] = ['b', 'a'].map(n => ({ candidate: { target: `${n}/${n}@1.0.0`,
    DefRef: { bundleDigest: n.repeat(64), workflowName: n } }, assessment: { kind: 'eligible' } }));
  assert.equal(candidateSetDigest(candidates), '357e08d09223cf9e22a9def604ecd1f0a9f476ebb5b8d01a7cae95d5d0cd2284');
  assert.equal(candidateSetDigest(candidates), candidateSetDigest([...candidates].reverse()));
  const ordered: AssessedCandidate[] = [
    ['a', 'a', 'a'], ['a', 'a', 'b'], ['a', 'b', 'a'], ['b', 'a', 'a'],
  ].map(([target, digest, workflowName]) => ({ candidate: { target: `${target}/${target}@1.0.0`,
    DefRef: { bundleDigest: digest!.repeat(64), workflowName: workflowName! } }, assessment: { kind: 'eligible' } }));
  assert.equal(candidateSetDigest([...ordered].reverse()), valueDigestHex(ordered), 'preserve all three typed sort fields');
  const moved = structuredClone(candidates);
  moved[0]!.assessment = { kind: 'ineligible', code: 'legacy-binding-missing' };
  assert.notEqual(candidateSetDigest(candidates), candidateSetDigest(moved));
});

test('strict JSON policy refuses coercions, cycles, accessors and symbols', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const bad of [undefined, NaN, Infinity, 1n, new Date(), () => {}, cycle, { toJSON: () => ({}) },
    { [Symbol('hidden')]: 1 }, { get x() { return 1; } }]) {
    assert.equal(jsonOnly(bad), false);
    assert.equal(validInvocationCall({ ...contract, policy: { ...contract.policy, config: bad } }), false);
  }
  assert.equal(validInvocationCall(contract), true);
});

test('candidate structural precedence and shared inherited missing-before-wiring guard', () => {
  const target = { ...def('child', [{ ...input('data'), schema: true }],
    [step({ name: 'work', produces: ['result'] })]), outputs: ['result'], x: { implements: [{ name: 'i', version: '1' }] } };
  target.steps[0]!.produces[0]!.schema = true;
  const assess = () => assessContract(contract, { data: 'seed' }, target);
  assert.deepEqual(assess(), { kind: 'eligible' });
  target.x.implements = [];
  assert.deepEqual(assess(), { kind: 'ineligible', code: 'implements' });
  target.x.implements = [{ name: 'i', version: '1' }];
  assert.deepEqual(assessContract(contract, { absent: 'seed' }, target), { kind: 'ineligible', code: 'wiring' });
  target.outputs.push('other');
  assert.deepEqual(assess(), { kind: 'ineligible', code: 'output' });
  target.outputs.pop(); target.inputs[0]!.schema = false;
  assert.deepEqual(assess(), { kind: 'ineligible', code: 'signature' });
  const legacy = (name: string, mapped: string) => ({ ...step({ name, produces: [name] }),
    callsInterface: { name, version: '1' }, callsInputs: { [mapped]: 'data' } });
  target.steps.push(legacy('bound', 'wrong'), legacy('missing', 'data'));
  const bindings = [{ interface: { name: 'bound', version: '1' }, target: 'x/x@1.0.0', digest: 'a'.repeat(64), signature: contract.signature }];
  assert.deepEqual(inheritedBindingAssessment(target, bindings), { kind: 'ineligible', code: 'legacy-binding-missing' });
  target.steps.reverse();
  assert.deepEqual(inheritedBindingAssessment(target, bindings), { kind: 'ineligible', code: 'legacy-binding-missing' });
  target.steps = target.steps.filter(s => s.name !== 'missing');
  assert.deepEqual(inheritedBindingAssessment(target, bindings), { kind: 'ineligible', code: 'legacy-binding-wiring' });
});
