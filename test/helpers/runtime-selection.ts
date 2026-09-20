import assert from 'node:assert/strict';
import { createEngine } from '../../src/factory.ts';
import type { Engine } from '../../src/engine.ts';
import { withWorkflowSnapshotStoreGuard } from '../../src/store/snapshot-guard.ts';
import { loadCasDefs, verifyInvocationDefinition } from '../../src/store/def-source.ts';
import { installBundleFixture, writeBundleSource } from './store-fixture.ts';
import type { DecisionSnapshot, InvocationCandidate } from '../../src/types.ts';
export async function runtimeFixture(db = ':memory:', root?: string) {
  const child = (name: string) => `name: ${name}
x:
  implements: [{name: report, version: '1'}]
inputs: [{name: data, seedOwed: true, schema: true}]
steps:
  - name: work
    consumes: [data]
    produces: [{name: result, schema: true}]
    terminal: true
outputs: [result]
`;
  const left = await installBundleFixture({ root, sourceDir: writeBundleSource({ name: 'left', workflow: child('left') }) });
  const right = await installBundleFixture({ sourceDir: writeBundleSource({ name: 'right', workflow: child('right') }), root: left.root });
  const call = (name: string) => `  - name: ${name}
    callsInterface:
      name: report
      version: '1'
      selection: invocation
      signature:
        inputs: [{name: data, schema: true}]
        outputs: [{name: result, schema: true}]
      policy: {name: deterministic, version: '1', config: {}}
    inputs: {data: seed}
    produces: [${name}]
`;
  await installBundleFixture({ root: left.root, sourceDir: writeBundleSource({ name: 'parent', workflow: `name: parent
inputs: [{name: seed, seedOwed: true}]
steps:
${call('one')}${call('two')}  - name: finish
    consumes: [one, two]
    produces: [done]
    terminal: true
    executor: command
    command: 'printf runtime-selection'
outputs: [done]
` }) });
  const defs = new Map(loadCasDefs({ globalRoot: left.root, warn: () => {} }).map(r => [r.key, r.def]));
  const created = createEngine({ db, defs });
  const candidates: InvocationCandidate[] = [
    { target: 'left/left@1.0.0', DefRef: { bundleDigest: left.result.digest, workflowName: 'left' } },
    { target: 'right/right@1.0.0', DefRef: { bundleDigest: right.result.digest, workflowName: 'right' } },
  ];
  return { ...created, candidates, root: left.root };
}
export function ready(engine: Engine, workflow: string, path: string, candidates: InvocationCandidate[]): DecisionSnapshot {
  const r = engine.decisionSnapshot(workflow, path, candidates);
  assert.equal(r.kind, 'ready', JSON.stringify(r));
  if (r.kind !== 'ready') throw new Error('expected ready');
  return r.snapshot;
}


import { Engine as RuntimeEngine } from '../../src/engine.ts';
import { digestScopedCallsTargetKey, finalizeDefs, resolveCallsTarget } from '../../src/defs.ts';
import type { Store } from '../../src/store.ts';

export function reloadRuntimeEngine(store: Store, root: string, maxCallDepth?: number) {
  const defs = finalizeDefs(new Map(loadCasDefs({ globalRoot: root, warn: () => {} }).map(r => [r.key, r.def])));
  const engine = new RuntimeEngine(store, (name, from, digest) => {
    const d = digest ? defs.get(digestScopedCallsTargetKey(digest, name)) ?? defs.get(name)
      : from ? resolveCallsTarget(defs, name, from) : defs.get(name);
    if (!d) throw new Error(`unknown workflow definition '${name}'`);
    return d;
  }, { maxCallDepth, invocationAuthority: {
    verifyDefinition: verifyInvocationDefinition, withDefinitions: withWorkflowSnapshotStoreGuard,
  } });
  return { engine, defs };
}
