import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateSetDigest, evidenceDigest, inheritedBindingAssessment, jsonOnly, validInvocationCall, assessContract } from '../src/invocation.ts';
import { valueDigestHex } from '../src/crypto/canonical.ts';
import { def, input, step } from './helpers.ts';
import type { AssessedCandidate, InvocationCall, InvocationEvidence } from '../src/types.ts';
import { Engine } from '../src/engine.ts';
import { digestScopedCallsTargetKey, resolveCallsTarget } from '../src/defs.ts';
import { runtimeFixture, ready, reloadRuntimeEngine } from './helpers/runtime-selection.ts';
import type { InvocationHostAuthority, ReadyClaimPlan, ReadyFiring, WorkflowDef } from '../src/index.ts';
import { verifyInvocationDefinition } from '../src/store/def-source.ts';
import { withWorkflowSnapshotStoreGuard } from '../src/store/snapshot-guard.ts';
import { Store, type ArtifactRow } from '../src/store.ts';
import { installBundleFixture, writeBundleSource, tempDir } from './helpers/store-fixture.ts';
import { join } from 'node:path';

const opaqueSeed = { opaque: 'seed-1' };
const logicalSeed = { n: 1 };

// A deliberately limited host representation adapter: only ordinary reads of
// two known opaque values are hydrated. No authority, evidence, or write override.
class LogicalViewStore extends Store {
  private logicalValue: Record<string, unknown> | undefined;

  withLogicalValue<T>(value: Record<string, unknown>, operation: () => T): T {
    const previous = this.logicalValue;
    this.logicalValue = value;
    try { return operation(); } finally { this.logicalValue = previous; }
  }
  private logical(row: ArtifactRow): ArtifactRow {
    return this.logicalValue !== undefined && row.value !== undefined
      && [opaqueSeed, { opaque: 'seed-2' }].some(value => valueDigestHex(row.value) === valueDigestHex(value))
      ? { ...row, value: structuredClone(this.logicalValue) } : row;
  }
  override getArtifact(workflow: string, path: string): ArtifactRow | undefined {
    const row = super.getArtifact(workflow, path);
    return row && this.logical(row);
  }
  override listArtifacts(workflow: string): ArtifactRow[] {
    return super.listArtifacts(workflow).map(row => this.logical(row));
  }
}

async function logicalViewFixture() {
  const schema = '{type: object, required: [n], properties: {n: {type: integer}}, additionalProperties: false}';
  const installed = await installBundleFixture({ sourceDir: writeBundleSource({
    name: 'hydration',
    workflow: `name: hydration
inputs: [{name: seed, seedOwed: true}]
steps:
  - name: choose
    callsInterface:
      name: report
      version: '1'
      selection: invocation
      signature:
        inputs: [{name: data, schema: ${schema}}]
        outputs: [{name: result, schema: true}]
      policy: {name: deterministic, version: '1', config: {}}
    inputs: {data: seed}
    produces: [chosen]
    terminal: true
outputs: [chosen]
`,
    workflows: { child: `name: child
x:
  implements: [{name: report, version: '1'}]
inputs: [{name: data, seedOwed: true, schema: ${schema}}]
steps:
  - name: work
    consumes: [data]
    produces: [{name: result, schema: true}]
    terminal: true
outputs: [result]
` },
  }) });
  const db = join(tempDir('invocation-hydration-'), 'store.db');
  const store = new LogicalViewStore(db);
  const { engine } = reloadRuntimeEngine(store, installed.root);
  const workflow = engine.createInstance('hydration/hydration@1.0.0', { provide: { seed: opaqueSeed } });
  const candidate = { target: 'hydration/child@1.0.0',
    DefRef: { bundleDigest: installed.result.digest, workflowName: 'child' } };
  return { store, engine, workflow, candidate, db, root: installed.root };
}

test('durable invocation identity survives logical brackets, strict child lifecycle, and reopen', async (t) => {
  const f = await logicalViewFixture();
  t.after(() => f.store.close());
  const snapshot = ready(f.engine, f.workflow, 'chosen', [f.candidate]);
  assert.deepEqual(snapshot.evidence, [{ childInput: 'data', parentPath: 'seed', version: 1, value: opaqueSeed }]);
  f.store.withLogicalValue(logicalSeed, () => {
    assert.deepEqual(ready(f.engine, f.workflow, 'chosen', [f.candidate]), snapshot);
    assert.deepEqual(f.store.getArtifact(f.workflow, 'seed')!.value, logicalSeed);
    f.store.withLogicalValue({ n: 2 }, () => {
      assert.deepEqual(ready(f.engine, f.workflow, 'chosen', [f.candidate]), snapshot);
      assert.deepEqual(f.store.getArtifact(f.workflow, 'seed')!.value, { n: 2 });
    });
    assert.throws(() => f.store.withLogicalValue({ n: 3 }, () => { throw new Error('restore'); }), /restore/);
    assert.deepEqual(f.store.getArtifact(f.workflow, 'seed')!.value, logicalSeed);
    assert.equal(f.engine.applyChoice(snapshot, f.candidate).kind, 'bound');
  });
  assert.deepEqual(f.store.getArtifact(f.workflow, 'seed')!.value, opaqueSeed);
  assert.equal(f.engine.invocationStatus(f.workflow, 'chosen').kind, 'bound');
  assert.equal(f.engine.applyChoice(snapshot, f.candidate).kind, 'replayed');
  const order = f.store.withLogicalValue(logicalSeed, () => f.engine.tick(f.workflow).orders[0]!);
  assert.ok(order, 'strict child schema receives the hydrated object');
  assert.deepEqual(f.store.getArtifact(order.workflow, 'data')!.value, logicalSeed);
  const bound = f.engine.invocationStatus(f.workflow, 'chosen');
  assert.equal(bound.kind, 'bound');
  if (bound.kind !== 'bound') throw new Error('missing binding');
  assert.equal(bound.childWorkflow, order.workflow);
  assert.equal(f.engine.decisionSnapshot(f.workflow, 'chosen', [f.candidate]).kind, 'already-bound');
  f.store.withLogicalValue(logicalSeed, () => {
    f.engine.green(order.workflow, order.run, 'result', { ok: true });
    f.engine.close(order.workflow, order.run);
  });
  const key = { parentWorkflow: f.workflow, parentDefRef: snapshot.key.parentDefRef,
    callPath: 'chosen', parentArtifactVersion: f.store.getArtifact(f.workflow, 'chosen')!.version };
  const receipt = await f.engine.invocationBindingSource().read(key);
  assert.ok(receipt);
  assert.equal(receipt.receipt.evidenceDigest, snapshot.key.evidenceDigest);
  assert.deepEqual(f.store.getArtifactEvidence(f.workflow, 'seed')!.value, opaqueSeed);
  const reopened = new LogicalViewStore(f.db);
  t.after(() => reopened.close());
  const { engine } = reloadRuntimeEngine(reopened, f.root);
  assert.deepEqual(engine.invocationStatus(f.workflow, 'chosen'), bound);
  assert.equal(engine.applyChoice(snapshot, f.candidate).kind, 'replayed');
  assert.deepEqual(await engine.invocationBindingSource().read(key), receipt);
  reopened.withLogicalValue({ n: 7 }, () => {
    assert.deepEqual(engine.invocationStatus(f.workflow, 'chosen'), bound);
    assert.equal(engine.applyChoice(snapshot, f.candidate).kind, 'replayed');
  });
  assert.equal(reopened.listInvocations(f.workflow).length, 1);
  assert.equal(reopened.listWorkflows().length, 2);
});

test('strict child schemas reject opaque and invalid logical seeds without orphan children', async (t) => {
  const f = await logicalViewFixture();
  t.after(() => f.store.close());
  const snapshot = ready(f.engine, f.workflow, 'chosen', [f.candidate]);
  assert.equal(f.engine.applyChoice(snapshot, f.candidate).kind, 'bound');
  assert.equal(f.engine.tick(f.workflow).orders.length, 0, 'opaque durable value cannot satisfy the child schema');
  assert.equal(f.store.listWorkflows().length, 1);
  assert.equal(f.store.withLogicalValue({ n: 'invalid' }, () => f.engine.tick(f.workflow).orders.length), 0);
  assert.equal(f.store.listWorkflows().length, 1);
  assert.equal(f.store.listInvocations(f.workflow).length, 1, 'schema refusal cannot create another binding');
  assert.equal(f.engine.invocationStatus(f.workflow, 'chosen').kind, 'bound');
});

for (const movement of ['version', 'value', 'acceptance', 'missing', 'non-json'] as const) {
  for (const alreadyBound of [false, true]) {
    test(`durable ${movement} movement refuses ${alreadyBound ? 'replay' : 'apply'} despite unchanged logical value`, async (t) => {
      const f = await logicalViewFixture();
      t.after(() => f.store.close());
      const snapshot = f.store.withLogicalValue(logicalSeed, () => ready(f.engine, f.workflow, 'chosen', [f.candidate]));
      if (alreadyBound) assert.equal(f.engine.applyChoice(snapshot, f.candidate).kind, 'bound');
      const row = f.store.getArtifact(f.workflow, 'seed')!;
      if (movement === 'missing') f.store.deleteArtifact(f.workflow, 'seed');
      else f.store.putArtifact({ ...row,
        ...(movement === 'version' ? { version: row.version + 1 } : {}),
        ...(movement === 'value' ? { value: { opaque: 'seed-2' } } : {}),
        ...(movement === 'acceptance' ? { acceptance: 'rejected' as const } : {}),
        ...(movement === 'non-json' ? { value: undefined } : {}),
      });
      const changes = () => f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
      const before = changes();
      f.store.withLogicalValue(logicalSeed, () => {
        assert.equal(f.engine.applyChoice(snapshot, f.candidate).kind, 'stale-evidence');
        assert.equal(f.engine.invocationStatus(f.workflow, 'chosen').kind, alreadyBound ? 'stale' : 'unresolved');
        const fresh = f.engine.decisionSnapshot(f.workflow, 'chosen', [f.candidate]);
        if (movement === 'version' || movement === 'value') {
          assert.equal(fresh.kind, 'ready');
          if (fresh.kind === 'ready') assert.notEqual(fresh.snapshot.key.evidenceDigest, snapshot.key.evidenceDigest);
        } else assert.deepEqual(fresh, { kind: 'evidence-not-ready', paths: ['seed'] });
      });
      assert.equal(changes(), before, 'refusal and currentness reads have no SQLite effects');
      assert.equal(f.store.listWorkflows().length, 1);
      assert.equal(f.store.listInvocations(f.workflow).length, alreadyBound ? 1 : 0);
    });
  }
}

test('ordinary inline invocation evidence retains its exact value, digest, and replay identity', async (t) => {
  const f = await runtimeFixture();
  t.after(() => f.store.close());
  const value = { n: 1, nested: { message: 'inline', values: [true, null, 3] } };
  const workflow = f.engine.createInstance('parent/parent@1.0.0', { provide: { seed: value } });
  const snapshot = ready(f.engine, workflow, 'one', f.candidates);
  const expected = [{ childInput: 'data', parentPath: 'seed', version: 1, value }];
  assert.deepEqual(snapshot.evidence, expected);
  assert.equal(snapshot.key.evidenceDigest, evidenceDigest(expected));
  assert.deepEqual(f.store.getArtifactEvidence(workflow, 'seed'), f.store.getArtifact(workflow, 'seed'));
  const bound = f.engine.applyChoice(snapshot, f.candidates[0]!);
  const replay = f.engine.applyChoice(snapshot, f.candidates[0]!);
  assert.equal(bound.kind, 'bound');
  assert.equal(replay.kind, 'replayed');
  if (bound.kind === 'bound' && replay.kind === 'replayed') assert.deepEqual(replay.binding, bound.binding);
});

function authorityEngine(f: Pick<Awaited<ReturnType<typeof runtimeFixture>>, 'store' | 'defs'>,
  invocationAuthority?: InvocationHostAuthority) {
  return new Engine(f.store, (name, from, digest) => {
    const d = digest ? f.defs.get(digestScopedCallsTargetKey(digest, name)) ?? f.defs.get(name)
      : from ? resolveCallsTarget(f.defs, name, from) : f.defs.get(name);
    if (!d) throw new Error(`missing ${name}`);
    return d;
  }, { invocationAuthority });
}
const authorityReadyOpts = { now: 10, revision: 'host-test' };
function authorityPlan(firing: ReadyFiring): ReadyClaimPlan {
  return { firing, lane: { id: 'host-lane', slot: 'one', executorKind: firing.executorKind,
    capacity: 1, revision: 'host-v1', expiresAt: 1000 }, authorityRevision: 'host-v1',
    candidateDigest: 'a'.repeat(64), evidenceDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) };
}

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
  const eligible = f.engine.snapshotReady(workflow, authorityReadyOpts);
  assert.equal(eligible.kind, 'ready');
  if (eligible.kind !== 'ready') throw new Error('local readiness failed');
  const beforeClaim = changes();
  assert.equal(raw.claimReady(authorityPlan(eligible.firings[0]!), authorityReadyOpts).kind, 'unverified');
  assert.equal(changes(), beforeClaim, 'missing authority cannot claim or consume a dispatch slot');
  const order = f.engine.tick(workflow).orders[0]!;
  f.engine.green(order.workflow, order.run, 'result', { ok: true });
  f.engine.close(order.workflow, order.run);
  const key = { parentWorkflow: workflow, parentDefRef: snapshot.key.parentDefRef,
    callPath: 'one', parentArtifactVersion: f.store.getArtifact(workflow, 'one')!.version };
  assert.ok(await f.engine.invocationBindingSource().read(key));
  assert.equal(await raw.invocationBindingSource().read(key), undefined);
});

test('custom exact-definition authority drives selection, provision, guarded read/claim and relay', async (t) => {
  const f = await runtimeFixture();
  t.after(() => f.store.close());
  // A custom per-instance publication policy layered over real local CAS.
  // Native Store still owns its real guarded snapshot commits; this is no
  // substitute Store or service adapter.
  const defs = f.defs;
  const publications = new Map([...defs.values()].map(d => [valueDigestHex(d), structuredClone(d)]));
  const targets: Array<string | undefined> = [];
  let revoked = false, guarded = false, guardedReads = 0, guardedWrites = 0;
  const authority: InvocationHostAuthority = {
    verifyDefinition(d, target) {
      targets.push(target);
      const exact = publications.get(valueDigestHex(d));
      const alias = target === undefined ? exact : defs.get(digestScopedCallsTargetKey(d.bundleDigest!, target));
      return !revoked && exact !== undefined && alias !== undefined && valueDigestHex(alias) === valueDigestHex(d)
	&& verifyInvocationDefinition(d, target);
    },
    withDefinitions(ds, operation) {
      assert.equal(f.store.db.isTransaction, false, 'host guard precedes SQLite');
      return withWorkflowSnapshotStoreGuard(ds, () => {
	if (ds.some(d => !this.verifyDefinition(d))) throw new Error('publication refused');
	guarded = true;
	try { return operation(); } finally { guarded = false; }
      });
    },
  };
  const engine = authorityEngine({ store: f.store, defs }, authority);
  const workflow = engine.createInstance('parent/parent@1.0.0', { provide: { seed: { n: 1 } } });
  const snapshot = ready(engine, workflow, 'one', f.candidates);
  assert.equal(engine.applyChoice(snapshot, f.candidates[0]!).kind, 'bound');
  assert.equal(engine.applyChoice(snapshot, f.candidates[0]!).kind, 'replayed');
  const raw = authorityEngine({ store: f.store, defs });
  assert.deepEqual(raw.decisionSnapshot(workflow, 'two', f.candidates), { kind: 'parent-unverified' },
    'another instance cannot inherit authority from definitions or the first engine');
  assert.equal(raw.tick(workflow).orders.length, 0);
  const readTx = f.store.readTx.bind(f.store), tx = f.store.tx.bind(f.store);
  f.store.readTx = operation => readTx(() => {
    if (guarded) { assert.equal(f.store.db.isTransaction, true); guardedReads++; }
    return operation();
  });
  f.store.tx = operation => tx(() => {
    if (guarded) { assert.equal(f.store.db.isTransaction, true); guardedWrites++; }
    return operation();
  });
  const eligible = engine.snapshotReady(workflow, authorityReadyOpts);
  assert.equal(eligible.kind, 'ready');
  if (eligible.kind !== 'ready') throw new Error('custom readiness failed');
  assert.equal(eligible.firings.length, 1);
  const plan = authorityPlan(eligible.firings[0]!);
  assert.equal(guardedReads, 1, 'readiness is evaluated in the host guard and read transaction');
  const claimed = engine.claimReady(plan, authorityReadyOpts);
  assert.equal(claimed.kind, 'claimed');
  if (claimed.kind !== 'claimed') throw new Error('custom claim failed');
  assert.equal(guardedWrites, 1, 'the complete conditional claim stays inside the host guard');
  assert.equal(f.store.getDispatchSlot('host-lane', 'one')?.run, claimed.order.run);
  engine.green(claimed.order.workflow, claimed.order.run, 'result', { ok: true });
  engine.close(claimed.order.workflow, claimed.order.run);
  const key = { parentWorkflow: workflow, parentDefRef: snapshot.key.parentDefRef,
    callPath: 'one', parentArtifactVersion: f.store.getArtifact(workflow, 'one')!.version };
  const receipt = await engine.invocationBindingSource().read(key);
  assert.ok(receipt);
  assert.deepEqual(receipt.receipt.childDefRef, f.candidates[0]!.DefRef);
  assert.equal(guardedReads, 2, 'relay uses the host guard and current store read transaction');
  assert.ok(targets.includes(f.candidates[0]!.target));
  assert.ok(targets.includes(undefined), 'optional target is preserved');
  revoked = true;
  const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  assert.equal(await engine.invocationBindingSource().read(key), undefined);
  assert.equal(engine.claimReady(plan, authorityReadyOpts).kind, 'unverified');
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
});

for (const refused of ['parent', 'left'] as const) {
  test(`Store-owned revalidate repeats injected ${refused} authority before apply commit`, async (t) => {
    const f = await runtimeFixture();
    t.after(() => f.store.close());
    let insideRevalidate = false;
    const authority: InvocationHostAuthority = {
      verifyDefinition(d, target) {
	assert.equal(f.store.db.isTransaction, false, 'apply verification precedes the write transaction');
	return !(insideRevalidate && d.name === refused) && verifyInvocationDefinition(d, target);
      },
      withDefinitions: withWorkflowSnapshotStoreGuard,
    };
    const engine = authorityEngine(f, authority);
    const workflow = f.engine.createInstance('parent/parent@1.0.0', { provide: { seed: { n: 1 } } });
    const snapshot = ready(f.engine, workflow, 'one', f.candidates);
    const transact = f.store.txWithWorkflowSnapshots.bind(f.store);
    let revalidations = 0;
    f.store.txWithWorkflowSnapshots = (defs, operation, revalidate) => transact(defs, operation, () => {
      assert.ok(revalidate);
      assert.equal(f.store.db.isTransaction, false);
      insideRevalidate = true;
      revalidations++;
      try { revalidate(); } finally { insideRevalidate = false; }
    });
    const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const result = engine.applyChoice(snapshot, f.candidates[0]!);
    assert.equal(result.kind, refused === 'parent' ? 'invalid-decision' : 'candidate-invalid');
    assert.equal(revalidations, 1);
    assert.equal(f.store.listInvocations(workflow).length, 0);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  });
}

for (const movement of ['parent', 'child', 'missing child', 'admission'] as const) {
  test(`supplied relay guard rechecks ${movement} movement in its current read transaction`, async (t) => {
    const f = await runtimeFixture();
    t.after(() => f.store.close());
    const workflow = f.engine.createInstance('parent/parent@1.0.0', { provide: { seed: { n: 1 } } });
    const snapshot = ready(f.engine, workflow, 'one', f.candidates);
    f.engine.applyChoice(snapshot, f.candidates[0]!);
    const order = f.engine.tick(workflow).orders[0]!;
    f.engine.green(order.workflow, order.run, 'result', { ok: true });
    f.engine.close(order.workflow, order.run);
    const key = { parentWorkflow: workflow, parentDefRef: snapshot.key.parentDefRef,
      callPath: 'one', parentArtifactVersion: f.store.getArtifact(workflow, 'one')!.version };
    assert.ok(await f.engine.invocationBindingSource().read(key));
    let guarded = false, reads = 0;
    const readTx = f.store.readTx.bind(f.store);
    f.store.readTx = operation => readTx(() => {
      assert.equal(guarded, true);
      assert.equal(f.store.db.isTransaction, true);
      reads++;
      return operation();
    });
    const engine = authorityEngine(f, {
      verifyDefinition: verifyInvocationDefinition,
      withDefinitions(ds, operation) {
	return withWorkflowSnapshotStoreGuard(ds, () => {
	  // Simulate state moving after the optimistic reads, before readTx.
	  if (movement === 'admission') f.engine.cancelRun(workflow);
	  else if (movement === 'missing child') f.store.db.prepare('DELETE FROM workflow WHERE id = ?').run(order.workflow);
	  else {
	    const id = movement === 'parent' ? workflow : order.workflow;
	    const moved = { ...f.store.getWorkflow(id)!.defSnapshot!, name: 'moved' };
	    f.store.db.prepare('UPDATE workflow SET def_snapshot = ? WHERE id = ?').run(JSON.stringify(moved), id);
	  }
	  guarded = true;
	  try { return operation(); } finally { guarded = false; }
	});
      },
    });
    assert.equal(await engine.invocationBindingSource().read(key), undefined);
    assert.equal(reads, 1);
  });
}

const refusingAuthorities: Array<[string, InvocationHostAuthority | undefined]> = [
  ['missing', undefined],
  ['refusing', { verifyDefinition: () => false, withDefinitions: withWorkflowSnapshotStoreGuard }],
  ['throwing', { verifyDefinition: () => { throw new Error('host refusal'); }, withDefinitions: withWorkflowSnapshotStoreGuard }],
  // Deliberately ill-typed hosts model JavaScript callers. Production has no cast/default-allow adapter.
  // @ts-expect-error a truthy value is not exact verification
  ['non-boolean', { verifyDefinition: () => 'yes', withDefinitions: withWorkflowSnapshotStoreGuard }],
  // @ts-expect-error a verifier alone is not an authority
  ['missing guard', { verifyDefinition: verifyInvocationDefinition }],
  // @ts-expect-error serialized host data is not a capability
  ['malformed', { verifyDefinition: true, withDefinitions: 'guard' }],
];
for (const [name, authority] of refusingAuthorities) {
  test(`${name} authority cannot bind, provision, claim or attest`, async (t) => {
    const f = await runtimeFixture();
    t.after(() => f.store.close());
    const engine = authorityEngine(f, authority);
    const workflow = f.engine.createInstance('parent/parent@1.0.0', { provide: { seed: { n: 1 } } });
    const snapshot = ready(f.engine, workflow, 'one', f.candidates);
    const changes = () => f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const before = changes();
    if (name === 'throwing') {
      assert.throws(() => engine.decisionSnapshot(workflow, 'one', f.candidates), /host refusal/);
      assert.throws(() => engine.applyChoice(snapshot, f.candidates[0]!), /host refusal/);
    } else {
      assert.equal(engine.decisionSnapshot(workflow, 'one', f.candidates).kind, 'parent-unverified');
      assert.equal(engine.applyChoice(snapshot, f.candidates[0]!).kind, 'invalid-decision');
    }
    assert.equal(changes(), before);
    assert.equal(f.engine.applyChoice(snapshot, f.candidates[0]!).kind, 'bound');
    if (name === 'throwing') assert.throws(() => engine.tick(workflow), /host refusal/);
    else assert.equal(engine.tick(workflow).orders.length, 0);
    assert.equal(f.store.listWorkflows().length, 1);
    const eligible = f.engine.snapshotReady(workflow, authorityReadyOpts);
    if (eligible.kind !== 'ready') throw new Error('local readiness failed');
    const plan = authorityPlan(eligible.firings[0]!);
    const beforeClaim = changes();
    assert.equal(engine.claimReady(plan, authorityReadyOpts).kind, 'unverified');
    assert.equal(changes(), beforeClaim);
    assert.equal(f.store.getDispatchSlot('host-lane', 'one'), undefined);
    const order = f.engine.tick(workflow).orders[0]!;
    f.engine.green(order.workflow, order.run, 'result', { ok: true });
    f.engine.close(order.workflow, order.run);
    const key = { parentWorkflow: workflow, parentDefRef: snapshot.key.parentDefRef,
      callPath: 'one', parentArtifactVersion: f.store.getArtifact(workflow, 'one')!.version };
    assert.ok(await f.engine.invocationBindingSource().read(key));
    if (name === 'throwing') await assert.rejects(async () => engine.invocationBindingSource().read(key), /host refusal/);
    else assert.equal(await engine.invocationBindingSource().read(key), undefined);
  });
}

for (const mode of ['refusing', 'omitted callback', 'deferred callback'] as const) {
  test(`host guard ${mode} cannot claim or fabricate a trusted receipt`, async (t) => {
    const f = await runtimeFixture();
    t.after(() => f.store.close());
    let deferred: (() => unknown) | undefined;
    const authority: InvocationHostAuthority = {
      verifyDefinition: verifyInvocationDefinition,
      withDefinitions<T>(_defs: readonly WorkflowDef[], operation: () => T): T {
	if (mode === 'refusing') throw new Error('host guard refused');
	if (mode === 'deferred callback') deferred = operation;
	// Deliberately broken synchronous host; never a production fallback.
	return undefined!;
      },
    };
    const engine = authorityEngine(f, authority);
    const workflow = f.engine.createInstance('parent/parent@1.0.0', { provide: { seed: { n: 1 } } });
    const snapshot = ready(f.engine, workflow, 'one', f.candidates);
    f.engine.applyChoice(snapshot, f.candidates[0]!);
    const eligible = f.engine.snapshotReady(workflow, authorityReadyOpts);
    if (eligible.kind !== 'ready') throw new Error('local readiness failed');
    const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.throws(() => engine.snapshotReady(workflow, authorityReadyOpts), /host guard/);
    assert.throws(() => engine.claimReady(authorityPlan(eligible.firings[0]!), authorityReadyOpts), /host guard/);
    if (deferred) assert.throws(deferred, /synchronously/);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
    assert.equal(f.store.getDispatchSlot('host-lane', 'one'), undefined);
    const order = f.engine.tick(workflow).orders[0]!;
    f.engine.green(order.workflow, order.run, 'result', { ok: true });
    f.engine.close(order.workflow, order.run);
    const key = { parentWorkflow: workflow, parentDefRef: snapshot.key.parentDefRef,
      callPath: 'one', parentArtifactVersion: f.store.getArtifact(workflow, 'one')!.version };
    assert.ok(await f.engine.invocationBindingSource().read(key));
    await assert.rejects(async () => engine.invocationBindingSource().read(key), /host guard/);
    if (deferred) assert.throws(deferred, /synchronously/);
  });
}

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
