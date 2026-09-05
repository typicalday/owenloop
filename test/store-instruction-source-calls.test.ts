import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createBundleIngestor,
  createStoreInstructionSource,
  readWorkflowStoreIndex,
  StoreIntegrityError,
  storeIndexPath,
  writeWorkflowStoreIndex,
} from '../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

// The verified calls-child view a command consumer corroborates a relayed
// child proof against: the child definition and the exact bundle digest the
// parent's verified bytes pin it at, per calls step.

const CHILD = `name: change-unit
inputs:
  - name: data
    seedOwed: true
steps:
  - name: change
    consumes: [data]
    produces: [result]
    terminal: true
    executor: command
    command: 'printf "change-unit-ran\\n"'
    body: ""
outputs: [result]
`;

function parent(name: string, target: string): string {
  return `name: ${name}
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: planner
    consumes: [seed]
    produces: [plan]
    executor: command
    command: 'printf "planner-ran\\n"'
    body: ""
  - name: unit1
    calls: ${target}
    inputs:
      data: seed
    produces: [u1]
  - name: integrate
    consumes: [plan, u1]
    produces: [out]
    terminal: true
    executor: command
    command: 'printf "integrate-ran\\n"'
    body: ""
outputs: [out]
`;
}

function addIndexEntry(root: string, coordinate: string, digest: string): void {
  const index = readWorkflowStoreIndex(storeIndexPath(root));
  index.entries[coordinate] = { digest, pinned: false };
  writeWorkflowStoreIndex(storeIndexPath(root), index);
}

function sourceAt(root: string) {
  return createStoreInstructionSource({
    projectRoot: tempDir('owenloop-calls-child-project-'),
    globalRoot: root,
    verifier: createBundleIngestor(),
  });
}

test('store instruction source: a locked qualified calls target resolves to the child bundle the parent pins', async () => {
  const root = tempDir('owenloop-calls-child-root-');
  const target = 'dep/change-unit@1.0.0';
  const child = await installBundleFixture({ root, sourceDir: writeBundleSource({ name: 'change-unit', workflow: CHILD }) });
  addIndexEntry(root, target, child.result.digest);
  const installed = await installBundleFixture({
    root,
    sourceDir: writeBundleSource({
      name: 'calls-parent',
      workflow: parent('calls-parent', target),
      lock: { [target]: child.result.digest },
    }),
  });
  const source = sourceAt(root);
  assert.equal(await source.prime(installed.result.digest), 'resolved');
  assert.ok(source.getVerifiedCallsChild !== undefined);

  const resolved = source.getVerifiedCallsChild(installed.result.digest, 'integrate', 'unit1');
  assert.ok(resolved !== undefined);
  assert.equal(resolved.bundleDigest, child.result.digest);
  assert.notEqual(resolved.bundleDigest, installed.result.digest);
  assert.equal(resolved.target, target);
  assert.equal(resolved.definition.name, 'change-unit');
  assert.deepEqual(resolved.definition.outputs, ['result']);

  // Only a calls step has a child; unknown digests and steps yield nothing.
  assert.equal(source.getVerifiedCallsChild(installed.result.digest, 'integrate', 'integrate'), undefined);
  assert.equal(source.getVerifiedCallsChild(installed.result.digest, 'integrate', 'planner'), undefined);
  assert.equal(source.getVerifiedCallsChild(installed.result.digest, 'not-a-step', 'unit1'), undefined);
  assert.equal(source.getVerifiedCallsChild('a'.repeat(64), 'integrate', 'unit1'), undefined);
});

test('store instruction source: a bare sibling calls target resolves to the parent bundle itself', async () => {
  const root = tempDir('owenloop-calls-sibling-root-');
  const installed = await installBundleFixture({
    root,
    sourceDir: writeBundleSource({
      name: 'sibling-parent',
      workflow: parent('sibling-parent', 'change-unit'),
      workflows: { 'change-unit': CHILD },
      defaultWorkflow: 'sibling-parent',
    }),
  });
  const source = sourceAt(root);
  assert.equal(await source.prime(installed.result.digest), 'resolved');
  assert.ok(source.getVerifiedCallsChild !== undefined);

  const resolved = source.getVerifiedCallsChild(installed.result.digest, 'integrate', 'unit1');
  assert.ok(resolved !== undefined);
  assert.equal(resolved.bundleDigest, installed.result.digest);
  assert.equal(resolved.target, 'change-unit');
  assert.equal(resolved.definition.name, 'change-unit');
  assert.deepEqual(resolved.definition.outputs, ['result']);
});

// A worker store that holds the parent alone. The parent's install-time lock
// revalidation needs the child callable somewhere, so the child lives in a
// separate publisher store that the worker's source never configures — the
// shape a worker is in after authenticated recovery pulled the parent bundle.
async function parentOnlyStore() {
  const target = 'dep/change-unit@1.0.0';
  const publisher = tempDir('owenloop-calls-publisher-');
  const worker = tempDir('owenloop-calls-worker-');
  const childSource = writeBundleSource({ name: 'change-unit', workflow: CHILD });
  const child = await installBundleFixture({ root: publisher, sourceDir: childSource });
  addIndexEntry(publisher, target, child.result.digest);
  const installed = await installBundleFixture({
    root: worker,
    level: 'global',
    projectRoot: publisher,
    globalRoot: worker,
    sourceDir: writeBundleSource({
      name: 'parent',
      workflow: parent('parent', target),
      lock: { [target]: child.result.digest },
    }),
  });
  return { worker, childSource, target, childDigest: child.result.digest, parentDigest: installed.result.digest };
}

function workerSource(root: string, onMissing?: (defDigest: string) => Promise<'retry' | 'refuse'>) {
  return createStoreInstructionSource({
    projectRoot: tempDir('owenloop-calls-worker-project-'),
    globalRoot: root,
    verifier: createBundleIngestor(),
    ...(onMissing === undefined ? {} : { onMissing: { onMissing } }),
  });
}

test('a lock-pinned child absent from every store root is recovered through onMissing with the CHILD digest', async () => {
  const store = await parentOnlyStore();
  const requested: string[] = [];
  const source = workerSource(store.worker, async (defDigest) => {
    requested.push(defDigest);
    // The pull supplies the child; only then does the parent re-resolve.
    await installBundleFixture({ root: store.worker, sourceDir: store.childSource });
    return 'retry';
  });

  assert.equal(await source.prime(store.parentDigest), 'resolved');
  assert.deepEqual(requested, [store.childDigest]);
  assert.ok(source.getVerifiedCallsChild !== undefined);
  const resolved = source.getVerifiedCallsChild(store.parentDigest, 'integrate', 'unit1');
  assert.ok(resolved !== undefined);
  assert.equal(resolved.bundleDigest, store.childDigest);
  assert.equal(resolved.target, store.target);
});

test('a lock-pinned child still absent after recovery is the named dependency-missing refusal, asked for once', async () => {
  const store = await parentOnlyStore();
  const isNamedMissingChild = (error: unknown): boolean =>
    error instanceof StoreIntegrityError
    && error.code === 'dependency-missing'
    && error.digest === store.childDigest
    && new RegExp(`locked calls target '${store.target.replace(/[.\/]/g, '\\$&')}' digest ${store.childDigest} pinned by parent bundle ${store.parentDigest} is absent from every configured workflow store root`).test(error.message);

  // Recovery answers `retry` without supplying the object: one ask, then the
  // named outcome — never `unknown-digest` (which would re-offer the order),
  // never `object-corrupt` (nothing failed verification).
  const requested: string[] = [];
  const retrying = workerSource(store.worker, async (defDigest) => {
    requested.push(defDigest);
    return 'retry';
  });
  await assert.rejects(retrying.prime(store.parentDigest), isNamedMissingChild);
  assert.deepEqual(requested, [store.childDigest]);

  const refusing: string[] = [];
  const refused = workerSource(store.worker, async (defDigest) => {
    refusing.push(defDigest);
    return 'refuse';
  });
  await assert.rejects(refused.prime(store.parentDigest), isNamedMissingChild);
  assert.deepEqual(refusing, [store.childDigest]);

  // No recovery configured at all: the same named outcome.
  await assert.rejects(workerSource(store.worker).prime(store.parentDigest), isNamedMissingChild);
});
