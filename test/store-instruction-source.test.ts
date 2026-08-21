import assert from 'node:assert/strict';
import { chmodSync, cpSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { defInstructionDigest } from '../src/order-resolver.ts';
import { packBundle } from '../src/bundle/index.ts';
import { finalizeDefs, loadDefFile } from '../src/defs.ts';
import {
  createBundleIngestor,
  createStoreInstructionSource,
  defDigest,
  globalStoreRoot,
  installWorkflowBundle,
  objectDirForDigest,
  readWorkflowStoreIndex,
  StoreIntegrityError,
  StoreInstructionSourceError,
  storeIndexPath,
  workflowStoreStatePaths,
  writeWorkflowStoreIndex,
} from '../src/store/index.ts';
import { createStoreInstructionResolver } from '../packages/work/src/exec/instructions.ts';
import type { OrderPacket } from '../packages/work/src/hub/types.ts';
import { installBundleFixture, installSignedBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

const WORKFLOW = `name: source-fixture
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: runner
    consumes: [seed]
    produces: [out]
    terminal: true
    executor: command
    command: 'printf "from-store\\n"'
    body: |
      Authored prompt for \${WORKFLOW}.
    x:
      harness:
        id: fixture-harness
        tools: [Read]
        permissionMode: strict
        cacheOnly: false
`;

function sourceDir(workflow = WORKFLOW, name = 'source-fixture'): string {
  return writeBundleSource({ name, workflow });
}

async function installedSource(workflow = WORKFLOW, name = 'source-fixture') {
  const installed = await installBundleFixture({ sourceDir: sourceDir(workflow, name) });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const defs = finalizeDefs(new Map([[loaded.name, loaded]]));
  const definition = defs.get(loaded.name);
  assert.ok(definition !== undefined);
  return { ...installed, definition };
}

function order(defDigest: string, step = 'runner'): OrderPacket {
  return {
    run: 'run-source',
    workflow: 'wf-source',
    step,
    key: '',
    defDigest,
    inputs: [],
    outputs: [],
    worker: 'command',
    consumes: {},
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
}

function addIndexEntry(root: string, coordinate: string, digest: string): void {
  const index = readWorkflowStoreIndex(storeIndexPath(root));
  index.entries[coordinate] = { digest, pinned: false };
  writeWorkflowStoreIndex(storeIndexPath(root), index);
}

function flattenRegularFileModes(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) flattenRegularFileModes(path);
    else if (stat.isFile()) chmodSync(path, 0o444);
  }
}

function makeRuntimeIncompatible(objectPath: string): void {
  const manifestPath = join(objectPath, 'bundle.yaml');
  chmodSync(objectPath, 0o755);
  chmodSync(manifestPath, 0o644);
  const manifest = readFileSync(manifestPath, 'utf8');
  assert.match(manifest, /version: "1\.0\.0"\nworkflows:/);
  writeFileSync(
    manifestPath,
    manifest.replace(
      'version: "1.0.0"\nworkflows:',
      'version: "1.0.0"\nruntime:\n  minVersion: "999.0.0"\nworkflows:',
    ),
  );
}

test('store instruction source: an empty store refuses an unknown projection digest', async () => {
  const source = createStoreInstructionSource({
    projectRoot: tempDir('owenloop-empty-project-'),
    globalRoot: tempDir('owenloop-empty-global-'),
    verifier: createBundleIngestor(),
  });
  assert.equal(await source.prime('a'.repeat(64)), 'unknown-digest');
  assert.deepEqual(source.lookup({ defDigest: 'a'.repeat(64), step: 'runner', key: '' }), { status: 'unknown-digest' });
});

test('store instruction source: a real installed bundle bridges bundle and order digests', async () => {
  const installed = await installedSource();
  const requested = defInstructionDigest(installed.definition);
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-source-global-'),
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(requested), 'resolved');
  const lookedUp = source.lookup({ defDigest: requested, step: 'runner', key: '' });
  assert.equal(lookedUp.status, 'resolved');
  if (lookedUp.status === 'resolved') {
    assert.equal(lookedUp.instructions.prompt, installed.definition.steps[0]!.body);
    assert.equal(lookedUp.instructions.command, 'printf "from-store\\n"');
    assert.equal(lookedUp.instructions.maxAttempts, installed.definition.steps[0]!.maxAttempts);
  }
  assert.deepEqual(source.lookup({ defDigest: requested, step: 'missing-step', key: '' }), { status: 'unknown-step' });
  assert.deepEqual(source.getVerifiedStep(requested, 'runner')?.x?.['harness'], installed.definition.steps[0]!.x?.['harness']);

  assert.equal(await source.prime(installed.result.digest), 'resolved');
  const bundleLookedUp = source.lookup({ defDigest: installed.result.digest, step: 'runner', key: '' });
  assert.equal(bundleLookedUp.status, 'resolved');
  assert.equal(source.getVerifiedDefinition(installed.result.digest, 'runner')?.name, 'source-fixture');
});

test('store instruction source: a project projection wins even when the matching global bundle digest sorts first', async () => {
  const first = await installBundleFixture({
    sourceDir: writeBundleSource({
      name: 'source-fixture',
      workflow: WORKFLOW,
      files: { 'notes/variant.txt': 'first auxiliary payload\n' },
    }),
  });
  const second = await installBundleFixture({
    sourceDir: writeBundleSource({
      name: 'source-fixture',
      workflow: WORKFLOW,
      files: { 'notes/variant.txt': 'second auxiliary payload\n' },
    }),
  });
  const installed = [first, second].sort((a, b) => a.result.digest.localeCompare(b.result.digest));
  const globalInstalled = installed[0]!;
  const projectInstalled = installed[1]!;
  assert.ok(
    globalInstalled.result.digest < projectInstalled.result.digest,
    'the fixture assigns the lexically earlier bundle to the global tier',
  );

  const loaded = loadDefFile(join(projectInstalled.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  const requested = defInstructionDigest(definition);
  const source = createStoreInstructionSource({
    projectRoot: projectInstalled.root,
    globalRoot: globalInstalled.root,
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(requested), 'resolved');
  assert.equal(source.getVerifiedObject(requested)?.bundleDigest, projectInstalled.result.digest);
  assert.equal(
    readFileSync(join(source.getVerifiedObject(requested)!.objectPath, 'notes/variant.txt'), 'utf8'),
    readFileSync(join(projectInstalled.result.objectPath, 'notes/variant.txt'), 'utf8'),
  );
});

test('store instruction source: a clean project match resolves before a corrupt global index is opened', async () => {
	const installed = await installedSource();
	const requested = defInstructionDigest(installed.definition);
	const globalRoot = tempDir('owenloop-corrupt-global-index-');
	writeFileSync(storeIndexPath(globalRoot), '{not-json');

	const source = createStoreInstructionSource({
		projectRoot: installed.root,
		globalRoot,
		verifier: createBundleIngestor(),
	});

	assert.equal(await source.prime(requested), 'resolved');
	assert.equal(source.getVerifiedObject(requested)?.bundleDigest, installed.result.digest);
});

test('store instruction source: an exact clean global bundle resolves before an unrelated corrupt project object', async () => {
  const projectInstalled = await installedSource(
    WORKFLOW.replace('name: source-fixture', 'name: unrelated-project'),
    'unrelated-project',
  );
  const globalInstalled = await installedSource();
  const target = join(projectInstalled.result.objectPath, 'workflow.yaml');
  chmodSync(projectInstalled.result.objectPath, 0o755);
  chmodSync(target, 0o644);
  writeFileSync(target, `${WORKFLOW.replace('name: source-fixture', 'name: unrelated-project')}# tampered\n`);

  const source = createStoreInstructionSource({
    projectRoot: projectInstalled.root,
    globalRoot: globalInstalled.root,
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(globalInstalled.result.digest), 'resolved');
  assert.equal(
    source.getVerifiedObject(globalInstalled.result.digest)?.bundleDigest,
    globalInstalled.result.digest,
  );
});

test('store instruction source: a missing exact project object falls through to the indexed global copy', async () => {
  const globalInstalled = await installedSource();
  const projectRoot = tempDir('owenloop-missing-exact-project-');
  addIndexEntry(projectRoot, 'stale/source-fixture@1.0.0', globalInstalled.result.digest);

  const source = createStoreInstructionSource({
    projectRoot,
    globalRoot: globalInstalled.root,
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(globalInstalled.result.digest), 'resolved');
  assert.equal(
    source.getVerifiedObject(globalInstalled.result.digest)?.objectPath,
    globalInstalled.result.objectPath,
  );
});

test('store instruction source: a same-root projection miss scans each indexed object once', async () => {
  const installed = await installedSource();
  const delegate = createBundleIngestor();
  let verifies = 0;
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: installed.root,
    verifier: {
      ingest: (input) => delegate.ingest(input),
      verifyInstalledObject: async (input) => {
	verifies++;
	await delegate.verifyInstalledObject(input);
      },
    },
  });

  assert.equal(await source.prime('f'.repeat(64)), 'unknown-digest');
  assert.equal(verifies, 1);
});

test('store instruction source: a corrupt exact project bundle blocks a clean global copy', async () => {
  const projectInstalled = await installedSource();
  const globalInstalled = await installedSource();
  assert.equal(projectInstalled.result.digest, globalInstalled.result.digest);

  const target = join(projectInstalled.result.objectPath, 'workflow.yaml');
  chmodSync(projectInstalled.result.objectPath, 0o755);
  chmodSync(target, 0o644);
  writeFileSync(target, `${WORKFLOW}# tampered project copy\n`);

  const source = createStoreInstructionSource({
    projectRoot: projectInstalled.root,
    globalRoot: globalInstalled.root,
    verifier: createBundleIngestor(),
  });

  await assert.rejects(
    source.prime(globalInstalled.result.digest),
    (error: unknown) => error instanceof StoreIntegrityError && error.code === 'object-corrupt',
  );
});

test('store instruction source: a corrupt project candidate blocks a clean matching global fallback', async () => {
	const projectInstalled = await installedSource(
		WORKFLOW.replace('name: source-fixture', 'name: unrelated-project'),
		'unrelated-project',
	);
	const globalInstalled = await installedSource();
	const requested = defInstructionDigest(globalInstalled.definition);
	const target = join(projectInstalled.result.objectPath, 'workflow.yaml');
	chmodSync(projectInstalled.result.objectPath, 0o755);
	chmodSync(target, 0o644);
	writeFileSync(target, `${WORKFLOW.replace('name: source-fixture', 'name: unrelated-project')}# tampered\n`);

	const source = createStoreInstructionSource({
		projectRoot: projectInstalled.root,
		globalRoot: globalInstalled.root,
		verifier: createBundleIngestor(),
	});

	await assert.rejects(
		source.prime(requested),
		(error: unknown) => error instanceof StoreIntegrityError && error.code === 'object-corrupt',
	);
});

test('store instruction source: a stale project row cannot borrow an unindexed global object', async () => {
	const globalInstalled = await installedSource();
	const requested = defInstructionDigest(globalInstalled.definition);
	const projectRoot = tempDir('owenloop-stale-project-row-');
	addIndexEntry(projectRoot, 'stale/source-fixture@1.0.0', globalInstalled.result.digest);

	const globalIndex = readWorkflowStoreIndex(storeIndexPath(globalInstalled.root));
	for (const [coordinate, entry] of Object.entries(globalIndex.entries)) {
		if (entry.digest === globalInstalled.result.digest) delete globalIndex.entries[coordinate];
	}
	writeWorkflowStoreIndex(storeIndexPath(globalInstalled.root), globalIndex);

	const source = createStoreInstructionSource({
		projectRoot,
		globalRoot: globalInstalled.root,
		verifier: createBundleIngestor(),
	});

	assert.equal(await source.prime(requested), 'unknown-digest');
	assert.deepEqual(source.lookup({ defDigest: requested, step: 'runner', key: '' }), { status: 'unknown-digest' });
});

test('store install: reinstalling original bytes repairs legacy execute-mode loss and preserves unrelated objects', async () => {
  const bundleSource = writeBundleSource({
    name: 'source-fixture',
    workflow: WORKFLOW,
    files: { 'bin/helper': '#!/bin/sh\nprintf "helper\\n"\n' },
  });
  chmodSync(join(bundleSource, 'bin', 'helper'), 0o755);
  const installed = await installBundleFixture({ sourceDir: bundleSource });
  const objectPath = installed.result.objectPath;
  const unrelatedDigest = '0'.repeat(64);
  const unrelatedObject = objectDirForDigest(installed.root, defDigest(unrelatedDigest));
  cpSync(objectPath, unrelatedObject, { recursive: true });
  chmodSync(unrelatedObject, 0o755);
  chmodSync(join(unrelatedObject, 'workflow.yaml'), 0o644);
  writeFileSync(join(unrelatedObject, 'workflow.yaml'), 'UNRELATED CORRUPTION');
  addIndexEntry(installed.root, 'unrelated/unrelated@1.0.0', unrelatedDigest);

  flattenRegularFileModes(objectPath);
  assert.equal(statSync(join(objectPath, 'bin', 'helper')).mode & 0o777, 0o444);
  const ingestor = createBundleIngestor();
  await assert.rejects(
    ingestor.verifyInstalledObject({ objectDir: objectPath, digest: defDigest(installed.packed.digest) }),
    /canonical bundle digest mismatch/,
  );
  const indexBefore = readFileSync(storeIndexPath(installed.root), 'utf8');
  const state = workflowStoreStatePaths(installed.root);

  const repaired = await installWorkflowBundle({
    bytes: installed.packed.bytes,
    source: installed.source,
    root: installed.root,
    level: 'project',
    lockPath: state.lockPath,
    journalPath: state.journalPath,
    recoveryMarkerDir: tempDir('owenloop-repair-markers-'),
    ingestor,
    verifier: { verify: async (): Promise<void> => {} },
  });

  assert.equal(repaired.installed, false);
  assert.equal(repaired.objectPath, objectPath);
  assert.equal(statSync(join(objectPath, 'bin', 'helper')).mode & 0o777, 0o555);
  assert.equal(readFileSync(storeIndexPath(installed.root), 'utf8'), indexBefore);
  assert.equal(readFileSync(join(unrelatedObject, 'workflow.yaml'), 'utf8'), 'UNRELATED CORRUPTION');

  const loaded = loadDefFile(join(objectPath, 'workflow.yaml'));
  const definitions = finalizeDefs(new Map([[loaded.name, loaded]]));
  const definition = definitions.get(loaded.name);
  assert.ok(definition !== undefined);
  const requested = defInstructionDigest(definition);
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-repaired-source-global-'),
    verifier: createBundleIngestor(),
  });
  assert.equal(await source.prime(requested), 'resolved');
  const lookedUp = source.lookup({ defDigest: requested, step: 'runner', key: '' });
  assert.equal(lookedUp.status, 'resolved');
  if (lookedUp.status === 'resolved') {
    assert.equal(lookedUp.instructions.prompt, definition.steps[0]!.body);
    assert.equal(lookedUp.instructions.command, 'printf "from-store\\n"');
  }

  const objectBeforeDedupe = statSync(objectPath);
  const deduped = await installWorkflowBundle({
    bytes: installed.packed.bytes,
    source: installed.source,
    root: installed.root,
    level: 'project',
    lockPath: state.lockPath,
    journalPath: state.journalPath,
    recoveryMarkerDir: tempDir('owenloop-rededupe-markers-'),
    ingestor: createBundleIngestor(),
    verifier: { verify: async (): Promise<void> => {} },
  });
  assert.equal(deduped.installed, false);
  assert.equal(readFileSync(storeIndexPath(installed.root), 'utf8'), indexBefore);
  const objectAfterDedupe = statSync(objectPath);
  assert.equal(objectAfterDedupe.ino, objectBeforeDedupe.ino, 'verified second reinstall did not swap the object');
  assert.equal(objectAfterDedupe.mtimeMs, objectBeforeDedupe.mtimeMs, 'verified second reinstall did not rewrite the object');
});

test('store instruction source: every workflow in a bundle is available by its instruction digest', async () => {
  const childWorkflow = WORKFLOW
    .replace('name: source-fixture', 'name: child-fixture')
    .replace('name: runner', 'name: child-runner')
    .replace('from-store', 'from-child');
  const sourceDir = writeBundleSource({
    name: 'source-fixture',
    workflow: WORKFLOW,
    workflows: { 'child-fixture': childWorkflow },
  });
  const installed = await installBundleFixture({ sourceDir });
  assert.deepEqual(installed.result.workflows, ['child-fixture', 'source-fixture']);

  const loaded = loadDefFile(join(installed.result.objectPath, 'child-fixture.yaml'));
  const finalized = finalizeDefs(new Map([[loaded.name, loaded]]));
  const child = finalized.get('child-fixture');
  assert.ok(child !== undefined);
  const requested = defInstructionDigest(child);
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-child-source-global-'),
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(requested), 'resolved');
  const lookedUp = source.lookup({ defDigest: requested, step: 'child-runner', key: '' });
  assert.equal(lookedUp.status, 'resolved');
  if (lookedUp.status === 'resolved') {
    assert.equal(lookedUp.instructions.prompt, child.steps[0]!.body);
    assert.equal(lookedUp.instructions.command, 'printf "from-child\\n"');
  }

  assert.equal(await source.prime(installed.result.digest), 'resolved');
  assert.equal(source.lookup({ defDigest: installed.result.digest, step: 'runner', key: '' }).status, 'resolved');
  assert.equal(source.lookup({ defDigest: installed.result.digest, step: 'child-runner', key: '' }).status, 'resolved');
  assert.equal(source.getVerifiedDefinition(installed.result.digest, 'child-runner')?.name, 'child-fixture');
});

test('store instruction source: a bundle digest refuses a step name shared by multiple workflows', async () => {
  const childWorkflow = WORKFLOW.replace('name: source-fixture', 'name: child-fixture');
  const sourceDir = writeBundleSource({
    name: 'source-fixture',
    workflow: WORKFLOW,
    workflows: { 'child-fixture': childWorkflow },
  });
  const installed = await installBundleFixture({ sourceDir });
  const globalRoot = tempDir('owenloop-ambiguous-source-global-');
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot,
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(installed.result.digest), 'resolved');
  assert.deepEqual(source.lookup({ defDigest: installed.result.digest, step: 'runner', key: '' }), { status: 'ambiguous-step' });
  assert.equal(source.getVerifiedStep(installed.result.digest, 'runner'), undefined);
  assert.equal(source.getVerifiedDefinition(installed.result.digest, 'runner'), undefined);

  const resolver = createStoreInstructionResolver({
    projectRoot: installed.root,
    globalRoot,
    verifier: createBundleIngestor(),
    source,
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
  });
  const resolved = await resolver.resolveCommand(order(installed.result.digest));
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.kind, 'ambiguous-step');
});

test('store instruction source: a stale index row does not poison a clean requested workflow', async () => {
  const installed = await installedSource();
  const requested = defInstructionDigest(installed.definition);
  addIndexEntry(installed.root, 'stale/stale@1.0.0', '0'.repeat(64));

  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-stale-global-'),
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(requested), 'resolved');
  assert.equal(source.lookup({ defDigest: requested, step: 'runner', key: '' }).status, 'resolved');
});

test('store instruction source: an unrelated tampered candidate does not poison a clean requested workflow', async () => {
  const installed = await installedSource();
  const requested = defInstructionDigest(installed.definition);
  const unrelatedDigest = '0'.repeat(64);
	assert.ok(unrelatedDigest < installed.result.digest, 'the corrupt sibling is scanned before the clean matching bundle');
  const unrelatedObject = objectDirForDigest(installed.root, defDigest(unrelatedDigest));
  cpSync(installed.result.objectPath, unrelatedObject, { recursive: true });
  chmodSync(unrelatedObject, 0o755);
  chmodSync(join(unrelatedObject, 'workflow.yaml'), 0o644);
  writeFileSync(join(unrelatedObject, 'workflow.yaml'), `${WORKFLOW}# unrelated tamper\\n`);
  addIndexEntry(installed.root, 'attacker/attacker@1.0.0', unrelatedDigest);

  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-unrelated-tamper-global-'),
    verifier: createBundleIngestor(),
  });

  assert.equal(await source.prime(requested), 'resolved');
  assert.equal(source.lookup({ defDigest: requested, step: 'runner', key: '' }).status, 'resolved');
});

test('store instruction source: missing-object recovery is called once and cannot invent instructions', async () => {
  let calls = 0;
  const source = createStoreInstructionSource({
    projectRoot: tempDir('owenloop-retry-project-'),
    globalRoot: tempDir('owenloop-retry-global-'),
    verifier: createBundleIngestor(),
    onMissing: {
      async onMissing(): Promise<'retry'> {
        calls++;
        return 'retry';
      },
    },
  });

  assert.equal(await source.prime('b'.repeat(64)), 'unknown-digest');
  assert.equal(calls, 1);
  assert.deepEqual(source.lookup({ defDigest: 'b'.repeat(64), step: 'runner', key: '' }), { status: 'unknown-digest' });
});

test('store instruction source: a recovered install re-primes once and a fresh source hits the installed store without fetching', async () => {
  const home = tempDir('owenloop-recovery-home-');
  const globalRoot = globalStoreRoot(home);
  const projectRoot = tempDir('owenloop-recovery-project-');
  const fixtureSource = sourceDir();
  let recoveryCalls = 0;
  let recoveredDigest = '';
  const recovering = createStoreInstructionSource({
    projectRoot,
    globalRoot,
    verifier: createBundleIngestor(),
    onMissing: {
		async onMissing(requestedDigest): Promise<'retry'> {
			recoveryCalls++;
			const installed = await installSignedBundleFixture({
				sourceDir: fixtureSource,
				root: globalRoot,
				home,
				env: { OWENLOOP_DEF_POLICY: 'enforce' },
			});
			recoveredDigest = installed.packed.digest;
			assert.equal(requestedDigest, recoveredDigest, 'the recovery install is pinned to the missing exact digest');
			return 'retry';
		},
    },
  });

  // The fixture bundle digest is the exact order-reference form used by the
  // remote recovery adapter; projection-digest mapping remains covered above.
  const expected = packBundle(fixtureSource).digest;
  assert.equal(await recovering.prime(expected), 'resolved');
  assert.equal(recoveryCalls, 1);
  assert.equal(recoveredDigest, expected);
  assert.equal(recovering.getVerifiedStep(expected, 'runner')?.command, 'printf "from-store\\n"');

  let unexpectedFetches = 0;
  const fresh = createStoreInstructionSource({
    projectRoot,
    globalRoot,
    verifier: createBundleIngestor(),
    onMissing: {
		async onMissing(): Promise<'retry'> {
			unexpectedFetches++;
			return 'retry';
		},
    },
  });
  assert.equal(await fresh.prime(expected), 'resolved');
  assert.equal(unexpectedFetches, 0, 'a process-fresh source reads the installed global object and issues no fetch');
});

test('store instruction source: a tampered installed object is an integrity refusal, not an unknown digest', async () => {
  const installed = await installedSource();
  const requested = defInstructionDigest(installed.definition);
  const target = join(installed.result.objectPath, 'workflow.yaml');
  chmodSync(installed.result.objectPath, 0o755);
  chmodSync(target, 0o644);
  const tampered = `${WORKFLOW}# changed after install\n`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(target, tampered);

  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-tampered-global-'),
    verifier: createBundleIngestor(),
  });
  await assert.rejects(
    source.prime(requested),
    (error: unknown) => error instanceof StoreIntegrityError && error.code === 'object-corrupt',
  );
});

test('store instruction source: a runtime-incompatible object never populates definition or instruction caches', async () => {
  const installed = await installedSource();
  const requested = defInstructionDigest(installed.definition);
  makeRuntimeIncompatible(installed.result.objectPath);
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-incompatible-global-'),
    verifier: createBundleIngestor(),
  });

  await assert.rejects(source.prime(requested), /requires Owenloop >= 999\.0\.0/);
  assert.equal(source.getVerifiedDefinition(requested), undefined);
  assert.equal(source.getVerifiedStep(requested, 'runner'), undefined);
  assert.equal(source.getVerifiedObject(requested), undefined);
  assert.deepEqual(source.lookup({ defDigest: requested, step: 'runner', key: '' }), { status: 'unknown-digest' });
});

test('store instruction source: a failed cache re-verification evicts every definition from the changed object', async () => {
  const childWorkflow = WORKFLOW
    .replace('name: source-fixture', 'name: child-fixture')
    .replace('name: runner', 'name: child-runner')
    .replace('from-store', 'from-child');
  const bundleSource = writeBundleSource({
    name: 'source-fixture',
    workflow: WORKFLOW,
    workflows: { 'child-fixture': childWorkflow },
  });
  const installed = await installBundleFixture({ sourceDir: bundleSource });
  const parent = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const child = loadDefFile(join(installed.result.objectPath, 'child-fixture.yaml'));
  const definitions = finalizeDefs(new Map([
    [parent.name, parent],
    [child.name, child],
  ]));
  const parentDefinition = definitions.get(parent.name);
  const childDefinition = definitions.get(child.name);
  assert.ok(parentDefinition !== undefined);
  assert.ok(childDefinition !== undefined);
  const parentDigest = defInstructionDigest(parentDefinition);
  const childDigest = defInstructionDigest(childDefinition);
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-incompatible-cache-global-'),
    verifier: createBundleIngestor(),
  });
  assert.equal(await source.prime(parentDigest), 'resolved');
  assert.equal(await source.prime(childDigest), 'resolved');
  assert.ok(source.getVerifiedDefinition(parentDigest) !== undefined);
  assert.ok(source.getVerifiedDefinition(childDigest) !== undefined);

  makeRuntimeIncompatible(installed.result.objectPath);
  await assert.rejects(source.prime(parentDigest), /requires Owenloop >= 999\.0\.0/);
  assert.equal(source.getVerifiedDefinition(parentDigest), undefined);
  assert.equal(source.getVerifiedDefinition(childDigest), undefined);
  assert.deepEqual(source.lookup({ defDigest: parentDigest, step: 'runner', key: '' }), { status: 'unknown-digest' });
  assert.deepEqual(source.lookup({ defDigest: childDigest, step: 'child-runner', key: '' }), { status: 'unknown-digest' });
});

test('store instruction resolver: runtime incompatibility refuses before definition verification or instruction return', async () => {
  const installed = await installedSource();
  const requested = defInstructionDigest(installed.definition);
  makeRuntimeIncompatible(installed.result.objectPath);
  let definitionVerifierCalls = 0;
  const resolver = createStoreInstructionResolver({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-incompatible-resolver-global-'),
    verifier: createBundleIngestor(),
    definitionVerifier: () => {
      definitionVerifierCalls++;
      return { kind: 'verified', publisherKeyId: '', principal: '' };
    },
  });

  const command = await resolver.resolveCommand(order(requested));
  assert.equal(command.ok, false);
  if (!command.ok) {
    assert.equal(command.kind, 'integrity');
    assert.match(command.reason, /requires Owenloop >= 999\.0\.0/);
  }
  const step = await resolver.resolveStep(order(requested));
  assert.equal(step.ok, false);
  if (!step.ok) assert.equal(step.kind, 'integrity');
  assert.equal(definitionVerifierCalls, 0);
});

test('store instruction source: digestOf refuses definitions that are not installed and primed', async () => {
  const installed = await installedSource();
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-digest-global-'),
    verifier: createBundleIngestor(),
  });

  assert.throws(
    () => source.digestOf(installed.definition),
    (error: unknown) => error instanceof StoreInstructionSourceError && error.code === 'digest-of-unavailable',
  );
});

test('store instruction resolver: verified step metadata is local-store data and missing command is named', async () => {
  const noCommandWorkflow = WORKFLOW
    .replace('name: source-fixture\n', 'name: no-command-fixture\n')
    .replace(/    executor: command\n    command: '[^\n]*'\n/, '    executor: agent\n');
  const installed = await installedSource(noCommandWorkflow, 'no-command-fixture');
  const requested = defInstructionDigest(installed.definition);
  const source = createStoreInstructionSource({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-resolver-global-'),
    verifier: createBundleIngestor(),
  });
  const resolver = createStoreInstructionResolver({
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-resolver-global-2-'),
    verifier: createBundleIngestor(),
    source,
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
  });

  const step = await resolver.resolveStep(order(requested));
  assert.equal(step.ok, true);
  if (step.ok) {
    assert.equal(step.step.body, installed.definition.steps[0]!.body);
    assert.deepEqual(step.step.x?.['harness'], installed.definition.steps[0]!.x?.['harness']);
  }
  const command = await resolver.resolveCommand(order(requested));
  assert.equal(command.ok, false);
  if (!command.ok) assert.equal(command.kind, 'missing-command');
  const missingStep = await resolver.resolveStep(order(requested, 'not-there'));
  assert.equal(missingStep.ok, false);
  if (!missingStep.ok) assert.equal(missingStep.kind, 'unknown-step');
});
