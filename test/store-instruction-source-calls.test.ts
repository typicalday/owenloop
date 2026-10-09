import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createBundleIngestor,
  createStoreInstructionSource,
  readWorkflowStoreIndex,
  StoreIntegrityError,
  storeIndexPath,
  verifyInstalledWorkflowMember,
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

function qualifyFixtureMember(sourceDir: string, alias: string, authoredName: string): string {
  const path = join(sourceDir, 'bundle.yaml');
  const manifest = readFileSync(path, 'utf8');
  const from = `  ${alias}: "${alias}.yaml"`;
  assert.equal(manifest.split(from).length, 2);
  writeFileSync(path, manifest.replace(from, `  ${authoredName}: "${alias}.yaml"`));
  return sourceDir;
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

test('routed calls graph keeps two native occurrences of one signed member separate', async () => {
  const root = tempDir('owenloop-concrete-occurrences-');
  const carrier = (name: string) => `name: ${name}\ninputs: []\nsteps:\n  - name: noop\n    consumes: []\n    produces: [result]\n    terminal: true\n    executor: command\n    command: echo carrier\noutputs: [result]\n`;
  const live = (command: string) => `name: routing/live\ninputs: []\nsteps:\n  - name: make\n    consumes: []\n    produces: [result]\n    terminal: true\n    executor: command\n    command: ${command}\noutputs: [result]\n`;
  const first = await installBundleFixture({ root, sourceDir: qualifyFixtureMember(writeBundleSource({
    name: 'live-b', workflow: carrier('live-b'), version: '1.0.0',
    workflows: { live: live('echo B') }, defaultWorkflow: 'routing/live',
  }), 'live', 'routing/live') });
  const second = await installBundleFixture({ root, sourceDir: qualifyFixtureMember(writeBundleSource({
    name: 'live-c', workflow: carrier('live-c'), version: '2.0.0',
    workflows: { live: live('echo C') }, defaultWorkflow: 'routing/live',
  }), 'live', 'routing/live') });
  const parent = await installBundleFixture({ root, deferHubLiveCallsAtStorage: true,
    sourceDir: qualifyFixtureMember(
    qualifyFixtureMember(writeBundleSource({
    name: 'routing-parent', workflow: carrier('routing-parent'),
    defaultWorkflow: 'routing/parent',
    workflows: { parent: `name: routing/parent\ninputs: []\nsteps:\n  - name: left\n    calls: sub\n    produces: [left]\n  - name: right\n    calls: sub\n    produces: [right]\n  - name: finish\n    consumes: [left, right]\n    produces: [out]\n    terminal: true\n    executor: command\n    command: echo done\noutputs: [out]\n`,
      sub: `name: sub\ninputs: []\nsteps:\n  - name: delegate\n    calls: routing/live\n    produces: [result]\noutputs: [result]\n`,
      sibling: `name: routing/live\ninputs: []\nsteps:\n  - name: other\n    consumes: []\n    produces: [different]\n    terminal: true\n    executor: command\n    command: echo sibling\noutputs: [different]\n` },
  }), 'parent', 'routing/parent'), 'sibling', 'routing/live') });
  const observed: string[] = [];
  const source = createStoreInstructionSource({ globalRoot: root,
    verifier: createBundleIngestor(), routedConcreteCalls: {
      rootWorkflow: 'wf_root', frameWorkflow: 'wf_frame', run: 'run_one',
      frameDefRef: { bundleDigest: parent.result.digest, workflowName: 'routing/parent' },
      stillAuthorized: () => true,
      observe: async request => {
	const branch = request.ancestry[0]?.callStep;
	assert.ok(branch === 'left' || branch === 'right');
	observed.push(branch);
	return { kind: 'selected-native-concrete-child', parentWorkflow: `wf_${branch}`,
	  childWorkflow: branch === 'left' ? 'wf_B' : 'wf_C',
	  childDefRef: { bundleDigest: branch === 'left' ? first.result.digest : second.result.digest,
	    workflowName: 'routing/live' }, receiptDigest: 'a'.repeat(64) };
      },
    } });
  assert.equal(await source.prime(parent.result.digest), 'resolved');
  assert.deepEqual(observed, ['left', 'right']);
  const selected = source.selectVerifiedDefinition(parent.result.digest, 'routing/parent', 'finish');
  assert.ok(selected);
  assert.deepEqual(new Set(selected.support.map(item => item.bundleDigest)),
    new Set([parent.result.digest, first.result.digest, second.result.digest]));
  assert.equal(source.selectVerifiedDefinition(parent.result.digest, 'sub', 'delegate'), undefined);
  assert.equal(source.getRoutedSelections?.(parent.result.digest, 'routing/parent')?.length, 2);
  await assert.rejects(sourceAt(root).prime(parent.result.digest), /calls names workflow|does not exist|declares no outputs/);
  await assert.rejects(source.prime(first.result.digest), /cannot prime another occurrence/);
  assert.equal(source.selectVerifiedWorkflow(first.result.digest, 'routing/live'), undefined);
});

test('installer stores an unresolved Hub live slash but ordinary execution stays strict', async () => {
  const root = tempDir('owenloop-concrete-install-');
  const authored = (name: string) => `name: ${name}\ninputs: []\nsteps:\n  - name: delegate\n    calls: routing/missing\n    produces: [child]\n  - name: finish\n    consumes: [child]\n    produces: [out]\n    terminal: true\n    executor: command\n    command: echo done\noutputs: [out]\n`;
  const hubSource = qualifyFixtureMember(writeBundleSource({
    name: 'hub-parent', workflow: `name: hub-parent\ninputs: []\nsteps:\n  - name: command\n    consumes: []\n    produces: [out]\n    terminal: true\n    executor: command\n    command: echo carrier\noutputs: [out]\n`,
    workflows: { parent: authored('routing/parent') }, defaultWorkflow: 'routing/parent',
  }), 'parent', 'routing/parent');
  const defaultRoot = tempDir('owenloop-concrete-default-install-');
  await assert.rejects(installBundleFixture({ root: defaultRoot, sourceDir: hubSource }),
  /cross-definition validation failed|calls names workflow/);
  const installed = await installBundleFixture({ root, sourceDir: hubSource,
    deferHubLiveCallsAtStorage: true });
  await assert.rejects(sourceAt(root).prime(installed.result.digest), /calls names workflow/);

  const plainRoot = tempDir('owenloop-concrete-plain-install-');
  await assert.rejects(installBundleFixture({ root: plainRoot,
    deferHubLiveCallsAtStorage: true,
    sourceDir: writeBundleSource({ name: 'plain-parent', workflow: authored('plain-parent') }) }),
  /cross-definition validation failed|calls names workflow/);

  const lockedRoot = tempDir('owenloop-concrete-locked-install-');
  const lockedSource = qualifyFixtureMember(writeBundleSource({
    name: 'hub-locked', workflow: `name: hub-locked\ninputs: []\nsteps:\n  - name: command\n    consumes: []\n    produces: [out]\n    terminal: true\n    executor: command\n    command: echo carrier\noutputs: [out]\n`,
    workflows: { parent: authored('routing/parent')
      .replace('calls: routing/missing', 'calls: routing/missing@1.0.0') },
    defaultWorkflow: 'routing/parent', lock: { 'routing/missing@1.0.0': 'f'.repeat(64) },
  }), 'parent', 'routing/parent');
  const locked = await installBundleFixture({ root: lockedRoot, sourceDir: lockedSource,
    deferHubLiveCallsAtStorage: true });
  await assert.rejects(sourceAt(lockedRoot).prime(locked.result.digest),
    (error: unknown) => error instanceof StoreIntegrityError
      && error.code === 'dependency-missing' && error.digest === 'f'.repeat(64));
});

test('integrity-only selected member recovery never creates executable cache', async () => {
  const publisher = tempDir('owenloop-selected-member-publisher-');
  const worker = tempDir('owenloop-selected-member-worker-');
  const sourceDir = qualifyFixtureMember(writeBundleSource({ name: 'selected-live',
    workflow: CHILD.replaceAll('change-unit', 'selected-live'),
    workflows: { live: CHILD.replaceAll('change-unit', 'routing/live') },
    defaultWorkflow: 'routing/live' }), 'live', 'routing/live');
  const installed = await installBundleFixture({ root: publisher, sourceDir });
  const requested: string[] = [];
  const selected = await verifyInstalledWorkflowMember({ globalRoot: worker,
    verifier: createBundleIngestor(), bundleDigest: installed.result.digest,
    workflowName: 'routing/live', onMissing: { onMissing: async digest => {
      requested.push(digest);
      await installBundleFixture({ root: worker, sourceDir });
      return 'retry';
    } } });
  assert.deepEqual(requested, [installed.result.digest]);
  assert.equal(selected.bundleDigest, installed.result.digest);
  assert.equal(selected.definition.name, 'routing/live');
  const routed = createStoreInstructionSource({ globalRoot: worker,
    verifier: createBundleIngestor(), routedConcreteCalls: {
      rootWorkflow: 'wf_root', frameWorkflow: 'wf_frame', run: 'run_one',
      frameDefRef: { bundleDigest: 'b'.repeat(64), workflowName: 'routing/parent' },
      stillAuthorized: () => true, observe: async () => { throw new Error('unreachable'); },
    } });
  assert.equal(routed.selectVerifiedWorkflow(installed.result.digest, 'routing/live'), undefined);
  await assert.rejects(routed.prime(installed.result.digest), /cannot prime another occurrence/);
});

test('integrity-only selected member preserves strict locked-child closure', async () => {
  const store = await parentOnlyStore();
  await assert.rejects(verifyInstalledWorkflowMember({ globalRoot: store.worker,
    verifier: createBundleIngestor(), bundleDigest: store.parentDigest,
    workflowName: 'parent' }), (error: unknown) => error instanceof StoreIntegrityError
      && error.code === 'dependency-missing' && error.digest === store.childDigest);
  await installBundleFixture({ root: store.worker, sourceDir: store.childSource });
  const selected = await verifyInstalledWorkflowMember({ globalRoot: store.worker,
    verifier: createBundleIngestor(), bundleDigest: store.parentDigest,
    workflowName: 'parent' });
  assert.deepEqual(new Set(selected.support.map(object => object.bundleDigest)),
    new Set([store.parentDigest, store.childDigest]));
});
