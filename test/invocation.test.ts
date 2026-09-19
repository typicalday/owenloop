import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateSetDigest, evidenceDigest, inheritedBindingAssessment, jsonOnly, validInvocationCall, assessContract } from '../src/invocation.ts';
import { valueDigestHex } from '../src/crypto/canonical.ts';
import { def, input, step } from './helpers.ts';
import type { AssessedCandidate, InvocationCall, InvocationEvidence } from '../src/types.ts';

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
