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
  const ordinary = sourceAt(root);
  assert.equal(await ordinary.prime(parent.result.digest), 'resolved');
  const ordinarySibling = ordinary.selectVerifiedDefinition(parent.result.digest, 'sub', 'delegate')
    ?.callsChild('delegate');
  assert.equal(ordinarySibling?.bundleDigest, parent.result.digest);
  assert.equal(ordinarySibling?.definition.name, 'routing/live');
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
  await assert.rejects(installBundleFixture({ root: lockedRoot, sourceDir: lockedSource,
    deferHubLiveCallsAtStorage: true }),
  /lock target 'routing\/missing@1\.0\.0' pinned to f{64} is no longer exactly callable/);
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
  const childObject = selected.support.find(object => object.bundleDigest === store.childDigest);
  assert.ok(childObject);
  writeFileSync(join(childObject.objectPath, 'workflow.yaml'), '\ncorrupted: true\n');
  await assert.rejects(verifyInstalledWorkflowMember({ globalRoot: store.worker,
    verifier: createBundleIngestor(), bundleDigest: store.parentDigest,
    workflowName: 'parent' }), (error: unknown) => error instanceof StoreIntegrityError
      && error.code === 'object-corrupt' && error.digest === store.childDigest);
});

test('selected invocation child verifies signed support before its own live calls occurrence', async () => {
  const root = tempDir('owenloop-nested-live-child-');
  const external = await installBundleFixture({ root, sourceDir: qualifyFixtureMember(writeBundleSource({
    name: 'external-child', workflow: `name: external-child\ninputs: []\nsteps:\n  - name: make\n    consumes: []\n    produces: [result]\n    terminal: true\n    executor: command\n    command: echo external\noutputs: [result]\n`,
    workflows: { external: `name: routing/external\ninputs: []\nsteps:\n  - name: make\n    consumes: []\n    produces: [result]\n    terminal: true\n    executor: command\n    command: echo external\noutputs: [result]\n` },
    defaultWorkflow: 'routing/external',
  }), 'external', 'routing/external') });
  const child = await installBundleFixture({ root, deferHubLiveCallsAtStorage: true,
    sourceDir: qualifyFixtureMember(writeBundleSource({
      name: 'selected-child', workflow: `name: selected-child\ninputs: []\nsteps:\n  - name: make\n    consumes: []\n    produces: [result]\n    terminal: true\n    executor: command\n    command: echo selected\noutputs: [result]\n`,
      workflows: { child: `name: routing/child\ninputs: []\nsteps:\n  - name: delegate\n    calls: routing/external\n    produces: [result]\noutputs: [result]\n` },
      defaultWorkflow: 'routing/child',
    }), 'child', 'routing/child') });
  const selected = await verifyInstalledWorkflowMember({ globalRoot: root,
    verifier: createBundleIngestor(), bundleDigest: child.result.digest,
    workflowName: 'routing/child' });
  assert.equal(selected.definition.name, 'routing/child');
  assert.deepEqual(new Set(selected.support.map(object => object.bundleDigest)),
    new Set([child.result.digest]));
  await assert.rejects(sourceAt(root).prime(child.result.digest), /calls names workflow/);

  let observed = false;
  const supportOnly = createStoreInstructionSource({ globalRoot: root,
    verifier: createBundleIngestor(), integrityOnlyHubLive: {
      workflowName: 'routing/child', accept: () => { observed = true; },
    } });
  assert.equal(await supportOnly.prime(child.result.digest), 'resolved');
  assert.equal(observed, true);
  assert.equal(supportOnly.selectVerifiedDefinition(child.result.digest, 'routing/child', 'delegate'), undefined);
  assert.equal(supportOnly.lookup({ defDigest: child.result.digest, step: 'delegate', key: '' }).status,
    'unknown-digest');

  const later = createStoreInstructionSource({ globalRoot: root,
    verifier: createBundleIngestor(), routedConcreteCalls: {
      rootWorkflow: 'wf_root', frameWorkflow: 'wf_child', run: 'run_child',
      frameDefRef: { bundleDigest: child.result.digest, workflowName: 'routing/child' },
      stillAuthorized: () => true,
      observe: async request => {
	assert.equal(request.edge.target, 'routing/external');
	assert.equal(request.frameWorkflow, 'wf_child');
	return { kind: 'prestart-live-concrete-child', parentWorkflow: 'wf_child',
	  childDefRef: { bundleDigest: external.result.digest,
	    workflowName: 'routing/external' },
	  observedLiveVersion: 1, receiptDigest: 'a'.repeat(64) };
      },
    } });
  assert.equal(await later.prime(child.result.digest), 'resolved');
  assert.deepEqual(new Set(later.selectVerifiedDefinition(child.result.digest,
    'routing/child', 'delegate')?.support.map(object => object.bundleDigest)),
  new Set([child.result.digest, external.result.digest]));
});

test('data-only selected child defers an included Hub live call after signed expansion', async () => {
  const root = tempDir('owenloop-included-live-child-');
  const sourceDir = qualifyFixtureMember(writeBundleSource({
    name: 'included-child',
    workflow: `name: included-child\ninputs: []\nsteps:\n  - name: make\n    produces: [result]\n    terminal: true\n    executor: command\n    command: echo included\noutputs: [result]\n`,
    workflows: {
      child: `name: routing/child\ninputs: []\nsteps:\n  - include: helper\n    as: nested\noutputs: [nested.result]\n`,
      helper: `name: helper\ninputs: []\nsteps:\n  - name: delegate\n    calls: routing/external\n    produces: [result]\noutputs: [result]\n`,
    },
    defaultWorkflow: 'routing/child',
  }), 'child', 'routing/child');
  const installed = await installBundleFixture({ root, sourceDir,
    deferHubLiveCallsAtStorage: true });
  const selected = await verifyInstalledWorkflowMember({ globalRoot: root,
    verifier: createBundleIngestor(), bundleDigest: installed.result.digest,
    workflowName: 'routing/child' });
  assert.equal(selected.definition.steps[0]?.name, 'nested.delegate');
  assert.equal(selected.definition.steps[0]?.calls, 'routing/external');
  await assert.rejects(sourceAt(root).prime(installed.result.digest),
    /calls names workflow 'routing\/external' which does not exist/);
});

test('included exact locked call is recovered and verified before data-only or ordinary selection', async () => {
  const publisher = tempDir('owenloop-included-lock-publisher-');
  const worker = tempDir('owenloop-included-lock-worker-');
  const target = 'dep/change-unit@1.0.0';
  const childSource = writeBundleSource({ name: 'change-unit', workflow: CHILD });
  const child = await installBundleFixture({ root: publisher, sourceDir: childSource });
  addIndexEntry(publisher, target, child.result.digest);
  const parentSource = writeBundleSource({
    name: 'included-parent',
    workflow: `name: included-parent\ninputs: []\nsteps:\n  - include: helper\n    as: nested\noutputs: [nested.result]\n`,
    workflows: { helper: `name: helper\ninputs: []\nsteps:\n  - name: delegate\n    calls: ${target}\n    produces: [result]\noutputs: [result]\n` },
    lock: { [target]: child.result.digest },
  });
  const parentBundle = await installBundleFixture({ root: worker,
    level: 'global', projectRoot: publisher, globalRoot: worker,
    sourceDir: parentSource });
  const select = () => verifyInstalledWorkflowMember({ globalRoot: worker,
    verifier: createBundleIngestor(), bundleDigest: parentBundle.result.digest,
    workflowName: 'included-parent' });
  await assert.rejects(select(), (error: unknown) => error instanceof StoreIntegrityError
    && error.code === 'dependency-missing' && error.digest === child.result.digest);
  const requested: string[] = [];
  const selected = await verifyInstalledWorkflowMember({ globalRoot: worker,
    verifier: createBundleIngestor(), bundleDigest: parentBundle.result.digest,
    workflowName: 'included-parent', onMissing: { onMissing: async digest => {
      requested.push(digest);
      await installBundleFixture({ root: worker, sourceDir: childSource });
      return 'retry';
    } } });
  assert.deepEqual(requested, [child.result.digest]);
  assert.deepEqual(new Set(selected.support.map(object => object.bundleDigest)),
    new Set([parentBundle.result.digest, child.result.digest]));
  assert.equal(await sourceAt(worker).prime(parentBundle.result.digest), 'resolved');
  const childObject = selected.support.find(object => object.bundleDigest === child.result.digest);
  assert.ok(childObject);
  writeFileSync(join(childObject.objectPath, 'workflow.yaml'), '\ncorrupted: true\n');
  await assert.rejects(select(), (error: unknown) => error instanceof StoreIntegrityError
    && error.code === 'object-corrupt' && error.digest === child.result.digest);
});

test('locked child includes resolve from the child archive despite a same-named parent member', async () => {
  const root = tempDir('owenloop-local-include-root-');
  const target = 'dep/change-unit@1.0.0';
  const child = await installBundleFixture({ root, sourceDir: writeBundleSource({
    name: 'change-unit',
    defaultWorkflow: 'change-unit',
    workflow: `name: change-unit\ninputs: []\nsteps:\n  - include: helper\n    as: nested\noutputs: [nested.result]\n`,
    workflows: { helper: `name: helper\ninputs: []\nsteps:\n  - name: good\n    produces: [result]\n    terminal: true\n    executor: command\n    command: echo child\noutputs: [result]\n` },
  }) });
  addIndexEntry(root, target, child.result.digest);
  const parentBundle = await installBundleFixture({ root, sourceDir: writeBundleSource({
    name: 'parent',
    workflow: `name: parent\ninputs: []\nsteps:\n  - name: delegate\n    calls: ${target}\n    produces: [result]\noutputs: [result]\n`,
    workflows: { helper: `name: helper\ninputs: []\nsteps:\n  - name: wrong\n    produces: [other]\n    terminal: true\n    executor: command\n    command: echo parent\noutputs: [other]\n` },
    lock: { [target]: child.result.digest },
  }) });
  const selected = await verifyInstalledWorkflowMember({ globalRoot: root,
    verifier: createBundleIngestor(), bundleDigest: parentBundle.result.digest,
    workflowName: 'parent' });
  assert.deepEqual(new Set(selected.support.map(object => object.bundleDigest)),
    new Set([parentBundle.result.digest, child.result.digest]));
  const source = sourceAt(root);
  assert.equal(await source.prime(parentBundle.result.digest), 'resolved');
  const callsChild = source.getVerifiedCallsChild?.(parentBundle.result.digest,
    'delegate', 'delegate');
  assert.equal(callsChild?.bundleDigest, child.result.digest);
  assert.deepEqual(callsChild?.definition.steps.map(step => step.name), ['nested.good']);
  assert.deepEqual(callsChild?.definition.outputs, ['nested.result']);
});

test('included exact named lock checks its selected member before bundle commit', async () => {
  const publisher = tempDir('owenloop-included-named-publisher-');
  const worker = tempDir('owenloop-included-named-worker-');
  const coordinate = 'dep/change-unit@1.0.0';
  const child = await installBundleFixture({ root: publisher,
    sourceDir: writeBundleSource({ name: 'change-unit', workflow: CHILD }) });
  addIndexEntry(publisher, coordinate, child.result.digest);
  const target = `${coordinate}#missing`;
  const parentSource = writeBundleSource({
    name: 'parent',
    workflow: `name: parent\ninputs: []\nsteps:\n  - include: helper\n    as: nested\noutputs: [nested.result]\n`,
    workflows: { helper: `name: helper\ninputs: []\nsteps:\n  - name: delegate\n    calls: ${target}\n    produces: [result]\noutputs: [result]\n` },
    lock: { [coordinate]: child.result.digest },
  });
  await assert.rejects(installBundleFixture({ root: worker, level: 'global',
    projectRoot: publisher, globalRoot: worker, sourceDir: parentSource }),
  /lock target 'dep\/change-unit@1\.0\.0' pinned to [0-9a-f]{64} is no longer exactly callable/);
  assert.deepEqual(readWorkflowStoreIndex(storeIndexPath(worker)).entries, {});
});
