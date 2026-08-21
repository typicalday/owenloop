import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { main, mainAsync } from '../src/cli.ts';
import { installFolder, writeAddJournal, writeLockfile } from '../src/add.ts';
import { finalizeDefs, resolveCallsTarget } from '../src/defs.ts';
import { rmRecursiveForce } from '../src/install.ts';
import { openStore, readRuntimeSnapshotBundlePins, StoreVersionError } from '../src/store.ts';
import {
  collectWorkflowStoreGarbage,
  compareStoreText,
  loadCasDefs,
  objectDirForDigest,
  planWorkflowStoreGc,
  readWorkflowStoreIndex,
  recoverWorkflowStore,
  storeIndexPath,
  workflowCoordinate,
  workflowStoreStatePaths,
  writeWorkflowStoreIndex,
} from '../src/store/index.ts';
import type { DefDigest, RuntimeSnapshotBundlePins } from '../src/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

function workflowYaml(name: string, marker: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: work',
    '    consumes: [seed]',
    '    produces: [done]',
    '    terminal: true',
    '    body: |',
    `      ${marker}`,
    'outputs: [done]',
    '',
  ].join('\n');
}

async function installVersion(args: {
  name?: string;
  version: string;
  marker?: string;
  root?: string;
  level?: 'project' | 'global';
  projectRoot?: string;
  globalRoot?: string;
  workflow?: string;
  workflows?: Record<string, string>;
  lock?: Record<string, string>;
  defaultWorkflow?: string;
}): Promise<{ root: string; digest: DefDigest }> {
  const name = args.name ?? 'widget';
  const sourceDir = writeBundleSource({
    name,
    version: args.version,
    workflow: args.workflow ?? workflowYaml(name, args.marker ?? `${name}-${args.version}`),
    ...(args.workflows === undefined ? {} : { workflows: args.workflows }),
    ...(args.defaultWorkflow === undefined ? {} : { defaultWorkflow: args.defaultWorkflow }),
    ...(args.lock === undefined ? {} : { lock: args.lock }),
  });
  const installed = await installBundleFixture({
    sourceDir,
    ...(args.root === undefined ? {} : { root: args.root }),
    ...(args.level === undefined ? {} : { level: args.level }),
    ...(args.projectRoot === undefined ? {} : { projectRoot: args.projectRoot }),
    ...(args.globalRoot === undefined ? {} : { globalRoot: args.globalRoot }),
  });
  return { root: installed.root, digest: installed.result.digest };
}

async function installThree(): Promise<{
  root: string;
  digests: Record<'1.0.0' | '1.1.0' | '2.0.0', DefDigest>;
}> {
  const one = await installVersion({ version: '1.0.0' });
  const two = await installVersion({ version: '1.1.0', root: one.root });
  const three = await installVersion({ version: '2.0.0', root: one.root });
  return {
    root: one.root,
    digests: { '1.0.0': one.digest, '1.1.0': two.digest, '2.0.0': three.digest },
  };
}

function emptyRoot(): string {
  return tempDir('owenloop-gc-empty-');
}

const barrierWord = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function waitForPath(path: string, label: string, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    Atomics.wait(barrierWord, 0, 0, 10);
  }
}

function plan(args: {
  projectRoot: string;
  globalRoot?: string;
  level?: 'project' | 'global';
  keep?: number;
  pins?: RuntimeSnapshotBundlePins[];
  exactCalls?: string[];
}) {
  return planWorkflowStoreGc({
    projectRoot: args.projectRoot,
    globalRoot: args.globalRoot ?? emptyRoot(),
    level: args.level ?? 'project',
    keep: args.keep ?? 2,
    snapshotPins: args.pins ?? [],
    exactCalls: args.exactCalls ?? [],
  });
}

test('bundle GC dry-run is deterministic and default keep=2 preserves current plus rollback', async () => {
  const installed = await installThree();
  const indexBefore = readFileSync(storeIndexPath(installed.root));
  const oldObject = objectDirForDigest(installed.root, installed.digests['1.0.0']);
  const modeBefore = lstatSync(oldObject).mode & 0o777;

  const first = plan({ projectRoot: installed.root });
  const second = plan({ projectRoot: installed.root });
  assert.deepEqual(first, second);
  assert.deepEqual(first.report.coordinates, ['widget/widget@1.0.0']);
  assert.equal(first.report.count, 1);
  assert.equal(first.report.objects[0]?.digest, installed.digests['1.0.0']);
  assert.equal(first.report.objects[0]?.bytes, first.report.bytes);
  assert.ok(first.report.bytes > 0);
  assert.deepEqual(readFileSync(storeIndexPath(installed.root)), indexBefore, 'dry run leaves index bytes unchanged');
  assert.equal(lstatSync(oldObject).mode & 0o777, modeBefore, 'dry run leaves hardened modes unchanged');
  assert.equal(existsSync(oldObject), true);
});

test('applied no-candidate GC preserves additive index and retained-entry metadata', async () => {
  const installed = await installVersion({ version: '1.0.0' });
  const indexPath = storeIndexPath(installed.root);
  const coordinate = 'widget/widget@1.0.0';
  const index = readWorkflowStoreIndex(indexPath);
  const retainedEntry = {
    ...index.entries[coordinate]!,
    signature: { algorithm: 'future', value: 'retain-entry-metadata' },
  };
  const forwardCompatibleIndex = {
    ...index,
    entries: { [coordinate]: retainedEntry },
    formatNote: { generation: 2, value: 'retain-top-level-metadata' },
  };
  writeFileSync(indexPath, `${JSON.stringify(forwardCompatibleIndex, null, 3)}\n`);
  const indexBefore = readFileSync(indexPath);

  const applied = await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot: emptyRoot(),
    level: 'project',
    keep: 2,
    yes: true,
    readSnapshotPins: () => [],
  });

  assert.deepEqual(applied.coordinates, []);
  assert.deepEqual(applied.objects, []);
  assert.deepEqual(readFileSync(indexPath), indexBefore, 'a no-op apply does not narrow or rewrite the index');
  const retained = JSON.parse(readFileSync(indexPath, 'utf8')) as {
    entries: Record<string, { signature?: unknown }>;
    formatNote?: unknown;
  };
  assert.deepEqual(retained.formatNote, forwardCompatibleIndex.formatNote);
  assert.deepEqual(retained.entries[coordinate]?.signature, forwardCompatibleIndex.entries[coordinate]?.signature);
});

test('bundle GC keep=1 ranks canonical SemVer; all-non-SemVer groups remain protected', async () => {
  const installed = await installThree();
  const one = plan({ projectRoot: installed.root, keep: 1 }).report;
  assert.deepEqual(one.coordinates, ['widget/widget@1.0.0', 'widget/widget@1.1.0']);
  assert.deepEqual(one.objects.map((object) => object.digest).sort(), [
    installed.digests['1.0.0'],
    installed.digests['1.1.0'],
  ].sort());

  const nightly = await installVersion({ version: 'nightly' });
  await installVersion({ version: 'edge', root: nightly.root });
  assert.deepEqual(plan({ projectRoot: nightly.root, keep: 1 }).report.objects, []);
});

test('selected winners, explicit pins, runtime pins, and transitive bundle locks are retained', async () => {
  const installed = await installThree();
  const indexPath = storeIndexPath(installed.root);
  const index = readWorkflowStoreIndex(indexPath);
  index.entries['widget/widget@1.0.0']!.pinned = true;
  writeWorkflowStoreIndex(indexPath, index);
  const pinnedPlan = plan({
    projectRoot: installed.root,
    keep: 1,
    pins: [{ bundleDigest: installed.digests['1.1.0'], bundleLock: [] }],
  });
  assert.deepEqual(pinnedPlan.report.objects, []);

  const childV1 = await installVersion({ name: 'child', version: '1.0.0' });
  const childV2 = await installVersion({ name: 'child', version: '2.0.0', root: childV1.root });
  const target = 'child/child@1.0.0';
  await installVersion({
    name: 'caller',
    version: '1.0.0',
    root: childV1.root,
		workflow: [
			'name: caller',
			'inputs:',
			'  - name: seed',
			'    seedOwed: true',
			'steps:',
			'  - name: invoke',
			`    calls: ${target}`,
			'    inputs:',
			'      seed: seed',
			'    produces: [done]',
			'outputs: [done]',
			'',
		].join('\n'),
    lock: { [target]: childV1.digest },
  });
  const lockedPlan = plan({ projectRoot: childV1.root, keep: 1 });
  assert.equal(lockedPlan.report.objects.some((object) => object.digest === childV1.digest), false);
  assert.equal(lockedPlan.report.objects.some((object) => object.digest === childV2.digest), false);
});

test('retained unpinned snapshot exact calls protect coordinates outside the keep window', async () => {
  const childV1 = await installVersion({ name: 'child', version: '1.0.0' });
  await installVersion({ name: 'child', version: '2.0.0', root: childV1.root });
  const target = 'child/child@1.0.0';

  const report = plan({
    projectRoot: childV1.root,
    keep: 1,
    pins: [{ bundleLock: [], exactCalls: [target] }],
  }).report;

  assert.equal(report.objects.some((object) => object.digest === childV1.digest), false);
  assert.equal(report.coordinates.includes(target), false);
});

test('applied CLI GC preserves exact calls from retained unpinned runtime snapshots', async () => {
  const cwd = tempDir('owenloop-gc-snapshot-exact-call-');
  const home = join(cwd, 'home');
  const projectRoot = join(cwd, 'workflows');
  mkdirSync(home);
  const childV1 = await installVersion({ name: 'child', version: '1.0.0', root: projectRoot });
  await installVersion({ name: 'child', version: '2.0.0', root: projectRoot });

  const dbPath = join(cwd, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE workflow (id TEXT PRIMARY KEY, def_snapshot TEXT, created_at INTEGER)');
  db.prepare('INSERT INTO workflow (id, def_snapshot, created_at) VALUES (?, ?, ?)').run(
    'wf_legacy_parent',
    JSON.stringify({
      bundleLock: {},
      steps: [{ calls: 'child/child@1.0.0' }],
    }),
    1,
  );
  db.close();

  const out: string[] = [];
  const err: string[] = [];
  const code = await mainAsync(['bundle', 'gc', '--keep', '1', '--yes', '--db', dbPath], {
    cwd,
    env: { HOME: home },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  assert.equal(code, 0, err.join('\n'));
  assert.equal(JSON.parse(out.join('\n')).count, 0);
  assert.equal(existsSync(objectDirForDigest(projectRoot, childV1.digest)), true);
});

test('applied CLI GC protects exact calls from current project and add definitions', async () => {
  const cwd = tempDir('owenloop-gc-non-cas-calls-');
  const home = join(cwd, 'home');
  const projectRoot = join(cwd, 'workflows');
  mkdirSync(home);
  const childV1 = await installVersion({ name: 'child', version: '1.0.0', root: projectRoot });
  const childV2 = await installVersion({ name: 'child', version: '2.0.0', root: projectRoot });
  await installVersion({ name: 'child', version: '3.0.0', root: projectRoot });

  const callsWorkflow = (name: string, target: string) => [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: invoke',
    `    calls: ${target}`,
    '    inputs:',
    '      seed: seed',
    '    produces: [done]',
    'outputs: [done]',
    '',
  ].join('\n');
  writeFileSync(join(projectRoot, 'project-parent.yaml'), callsWorkflow('project-parent', 'child/child@1.0.0'));

  const source = 'acme/parents';
  const folder = installFolder('acme', 'parents');
  const installedDir = join(projectRoot, folder);
  mkdirSync(installedDir);
  writeFileSync(join(installedDir, 'workflow.yaml'), callsWorkflow('add-parent', 'child/child@2.0.0'));
  const stateDir = join(cwd, '.owenloop');
  mkdirSync(stateDir);
  writeLockfile(join(stateDir, 'installed.json'), {
    version: 1,
    installed: {
      [source]: {
			source,
			ref: 'HEAD',
			sha: 'a'.repeat(40),
			installedAt: 1,
			path: folder,
			files: ['workflow.yaml'],
      },
    },
  });

  const out: string[] = [];
  const err: string[] = [];
  const code = await mainAsync(['bundle', 'gc', '--keep', '1', '--yes', '--db', join(cwd, 'missing.db')], {
    cwd,
    env: { HOME: home },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  assert.equal(code, 0, err.join('\n'));
  assert.equal(JSON.parse(out.join('\n')).count, 0);
  assert.equal(existsSync(objectDirForDigest(projectRoot, childV1.digest)), true);
  assert.equal(existsSync(objectDirForDigest(projectRoot, childV2.digest)), true);
});

test('global CLI GC protects an exact global call from a current project definition', async () => {
  const cwd = tempDir('owenloop-gc-global-non-cas-call-');
  const home = join(cwd, 'home');
  const projectRoot = join(cwd, 'workflows');
  const globalRoot = join(home, '.owenloop', 'workflows');
  mkdirSync(home);
  mkdirSync(projectRoot);
  const childV1 = await installVersion({ name: 'child', version: '1.0.0', root: globalRoot });
  await installVersion({ name: 'child', version: '2.0.0', root: globalRoot });
  writeFileSync(join(projectRoot, 'project-parent.yaml'), [
    'name: project-parent',
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: invoke',
    '    calls: child/child@1.0.0',
    '    inputs:',
    '      seed: seed',
    '    produces: [done]',
    'outputs: [done]',
    '',
  ].join('\n'));

  const out: string[] = [];
  const err: string[] = [];
  const code = await mainAsync(['bundle', 'gc', '--global', '--keep', '1', '--yes', '--db', join(cwd, 'missing.db')], {
    cwd,
    env: { HOME: home },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  assert.equal(code, 0, err.join('\n'));
  assert.equal(JSON.parse(out.join('\n')).count, 0);
  assert.equal(existsSync(objectDirForDigest(globalRoot, childV1.digest)), true);
});

test('same-root planning and HOME-unavailable CLI preserve fixed-point exact locks', async () => {
  const cwd = tempDir('owenloop-gc-same-root-');
  const root = join(cwd, 'workflows');
  const callsWorkflow = (name: string, target: string) => [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: invoke',
    `    calls: ${target}`,
    '    inputs:',
    '      seed: seed',
    '    produces: [done]',
    'outputs: [done]',
    '',
  ].join('\n');

  const leafV1 = await installVersion({ name: 'leaf', version: '1.0.0', root });
  const leafV2 = await installVersion({ name: 'leaf', version: '2.0.0', root });
  const leafOldTarget = 'leaf/leaf@1.0.0';
  const leafCurrentTarget = 'leaf/leaf@2.0.0';
  const middleV1 = await installVersion({
    name: 'middle',
    version: '1.0.0',
    root,
    workflow: callsWorkflow('middle', leafOldTarget),
    lock: { [leafOldTarget]: leafV1.digest },
  });
  await installVersion({
    name: 'middle',
    version: '2.0.0',
    root,
    workflow: callsWorkflow('middle', leafCurrentTarget),
    lock: { [leafCurrentTarget]: leafV2.digest },
  });
  const middleOldTarget = 'middle/middle@1.0.0';
  await installVersion({
    name: 'parent',
    version: '1.0.0',
    root,
    workflow: callsWorkflow('parent', middleOldTarget),
    lock: { [middleOldTarget]: middleV1.digest },
  });

  const dry = plan({ projectRoot: root, globalRoot: root, keep: 1 }).report;
  assert.equal(dry.objects.some((object) => object.digest === middleV1.digest), false);
  assert.equal(dry.objects.some((object) => object.digest === leafV1.digest), false);

  const out: string[] = [];
  const err: string[] = [];
  const code = await mainAsync(['bundle', 'gc', '--keep', '1', '--yes'], {
    cwd,
    env: {
      HOME: undefined,
      USERPROFILE: undefined,
      OWENLOOP_DB: join(cwd, 'missing-state.db'),
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  assert.equal(code, 0, err.join('\n'));
  const applied = JSON.parse(out.join('\n')) as { objects: Array<{ digest: string }> };
  assert.equal(applied.objects.some((object) => object.digest === middleV1.digest), false);
  assert.equal(applied.objects.some((object) => object.digest === leafV1.digest), false);

  const registrations = loadCasDefs({ globalRoot: root, warn: () => {} });
  const defs = finalizeDefs(new Map(registrations.map((registration) => [registration.key, registration.def])));
  const parent = defs.get('parent/parent@1.0.0');
  assert.ok(parent);
  const middle = resolveCallsTarget(defs, middleOldTarget, parent);
  assert.equal(middle?.bundleDigest, middleV1.digest);
  assert.equal(resolveCallsTarget(defs, leafOldTarget, middle!)?.bundleDigest, leafV1.digest);
});

test('bundle install refuses a locked multi-workflow coordinate with no callable default before mutation', async () => {
  const child = await installVersion({
    name: 'child',
    version: '1.0.0',
    workflows: { helper: workflowYaml('helper', 'helper') },
  });
  const target = 'child/child@1.0.0';
  const indexPath = storeIndexPath(child.root);
  const indexBefore = readFileSync(indexPath);
  const objectsRoot = join(child.root, 'objects', 'sha256');
  const objectsBefore = readdirSync(objectsRoot).sort(compareStoreText);

  await assert.rejects(
    installVersion({
      name: 'caller',
      version: '1.0.0',
      root: child.root,
      workflow: [
		'name: caller',
		'inputs:',
		'  - name: seed',
		'    seedOwed: true',
		'steps:',
		'  - name: invoke',
		`    calls: ${target}`,
		'    inputs:',
		'      seed: seed',
		'    produces: [done]',
		'outputs: [done]',
		'',
      ].join('\n'),
      lock: { [target]: child.digest },
    }),
    /lock target 'child\/child@1\.0\.0'.*no longer exactly callable/u,
  );

  assert.deepEqual(readFileSync(indexPath), indexBefore, 'the caller index entry is never committed');
  assert.deepEqual(readdirSync(objectsRoot).sort(compareStoreText), objectsBefore, 'no caller object is committed');
  assert.equal(readWorkflowStoreIndex(indexPath).entries['caller/caller@1.0.0'], undefined);
});

test('bundle GC refuses both target modes when a global index row has bytes only in project', async () => {
	const project = await installVersion({ name: 'shared', version: '1.0.0', marker: 'identical' });
	const global = await installVersion({ name: 'shared', version: '1.0.0', marker: 'identical' });
	assert.equal(project.digest, global.digest, 'fixture stores must contain the same immutable bundle');
	rmRecursiveForce(objectDirForDigest(global.root, global.digest));

	const projectIndexBefore = readFileSync(storeIndexPath(project.root));
	const globalIndexBefore = readFileSync(storeIndexPath(global.root));
	const projectObjectsRoot = join(project.root, 'objects', 'sha256');
	const globalObjectsRoot = join(global.root, 'objects', 'sha256');
	const projectObjectsBefore = readdirSync(projectObjectsRoot).sort(compareStoreText);
	const globalObjectsBefore = readdirSync(globalObjectsRoot).sort(compareStoreText);

	for (const level of ['project', 'global'] as const) {
		assert.throws(
			() => plan({ projectRoot: project.root, globalRoot: global.root, level, keep: 1 }),
			/indexed by global coordinate 'shared\/shared@1\.0\.0'.*no verified object directory exists/u,
			`${level} planning must reject the broken global store instead of borrowing project bytes`,
		);
		assert.deepEqual(readFileSync(storeIndexPath(project.root)), projectIndexBefore);
		assert.deepEqual(readFileSync(storeIndexPath(global.root)), globalIndexBefore);
		assert.deepEqual(readdirSync(projectObjectsRoot).sort(compareStoreText), projectObjectsBefore);
		assert.deepEqual(readdirSync(globalObjectsRoot).sort(compareStoreText), globalObjectsBefore);
	}
});

test('locked bundle install refuses a broken global replica before committing caller state', async () => {
	const project = await installVersion({ name: 'shared', version: '1.0.0', marker: 'identical' });
	const global = await installVersion({ name: 'shared', version: '1.0.0', marker: 'identical' });
	assert.equal(project.digest, global.digest, 'fixture stores must contain the same immutable bundle');
	rmRecursiveForce(objectDirForDigest(global.root, global.digest));

	const projectIndexBefore = readFileSync(storeIndexPath(project.root));
	const globalIndexBefore = readFileSync(storeIndexPath(global.root));
	const projectObjectsRoot = join(project.root, 'objects', 'sha256');
	const globalObjectsRoot = join(global.root, 'objects', 'sha256');
	const projectObjectsBefore = readdirSync(projectObjectsRoot).sort(compareStoreText);
	const globalObjectsBefore = readdirSync(globalObjectsRoot).sort(compareStoreText);
	const target = 'shared/shared@1.0.0';

	await assert.rejects(
		installVersion({
			name: 'caller',
			version: '1.0.0',
			root: project.root,
			level: 'project',
			projectRoot: project.root,
			globalRoot: global.root,
			workflow: [
				'name: caller',
				'inputs:',
				'  - name: seed',
				'    seedOwed: true',
				'steps:',
				'  - name: invoke',
				`    calls: ${target}`,
				'    inputs:',
				'      seed: seed',
				'    produces: [done]',
				'outputs: [done]',
				'',
			].join('\n'),
			lock: { [target]: project.digest },
		}),
		/indexed by global coordinate 'shared\/shared@1\.0\.0'.*no verified object directory exists/u,
	);

	assert.deepEqual(readFileSync(storeIndexPath(project.root)), projectIndexBefore);
	assert.deepEqual(readFileSync(storeIndexPath(global.root)), globalIndexBefore);
	assert.deepEqual(readdirSync(projectObjectsRoot).sort(compareStoreText), projectObjectsBefore);
	assert.deepEqual(readdirSync(globalObjectsRoot).sort(compareStoreText), globalObjectsBefore);
	assert.equal(readWorkflowStoreIndex(storeIndexPath(project.root)).entries['caller/caller@1.0.0'], undefined);
});

test('project GC follows locks from every retained global caller version', async () => {
	const projectV1 = await installVersion({ name: 'child', version: '1.0.0' });
	const projectV2 = await installVersion({ name: 'child', version: '2.0.0', root: projectV1.root });
	const globalRoot = emptyRoot();
	const callerWorkflow = (target: string, marker: string) => [
		'name: caller',
		'inputs:',
		'  - name: seed',
		'    seedOwed: true',
		'steps:',
		'  - name: invoke',
		`    calls: ${target}`,
		'    inputs:',
		'      seed: seed',
		'    produces: [done]',
		'outputs: [done]',
		`# ${marker}`,
		'',
	].join('\n');
	const oldTarget = 'child/child@1.0.0';
	const currentTarget = 'child/child@2.0.0';
	await installVersion({
		name: 'caller',
		version: '1.0.0',
		root: globalRoot,
		level: 'global',
		projectRoot: projectV1.root,
		globalRoot,
		workflow: callerWorkflow(oldTarget, 'old-global-caller'),
		lock: { [oldTarget]: projectV1.digest },
	});
	await installVersion({
		name: 'caller',
		version: '2.0.0',
		root: globalRoot,
		level: 'global',
		projectRoot: projectV1.root,
		globalRoot,
		workflow: callerWorkflow(currentTarget, 'current-global-caller'),
		lock: { [currentTarget]: projectV2.digest },
	});

	const dry = plan({
		projectRoot: projectV1.root,
		globalRoot,
		level: 'project',
		keep: 1,
	}).report;
	assert.equal(
		dry.objects.some((object) => object.digest === projectV1.digest),
		false,
		'the shadowed but retained global caller keeps its older project-only child',
	);

	const applied = await collectWorkflowStoreGarbage({
		projectRoot: projectV1.root,
		globalRoot,
		level: 'project',
		keep: 1,
		yes: true,
		readSnapshotPins: () => [],
	});
	assert.equal(applied.objects.some((object) => object.digest === projectV1.digest), false);
	assert.equal(existsSync(objectDirForDigest(projectV1.root, projectV1.digest)), true);

	const registrations = loadCasDefs({ projectRoot: projectV1.root, globalRoot, warn: () => {} });
	const defs = finalizeDefs(new Map(registrations.map((registration) => [registration.key, registration.def])));
	const oldCaller = defs.get('caller/caller@1.0.0');
	assert.ok(oldCaller, 'the shadowed global caller remains exactly resolvable');
	const resolved = resolveCallsTarget(defs, oldTarget, oldCaller);
	assert.equal(resolved?.bundleDigest, projectV1.digest);
});

test('identical non-target history does not prevent target keep pruning', async () => {
  const projectV1 = await installVersion({ version: '1.0.0' });
  const projectV2 = await installVersion({ version: '2.0.0', root: projectV1.root });
  const projectV3 = await installVersion({ version: '3.0.0', root: projectV1.root });
  const globalRoot = emptyRoot();
  const globalV1 = await installVersion({ version: '1.0.0', root: globalRoot });
  const globalV2 = await installVersion({ version: '2.0.0', root: globalRoot });
  const globalV3 = await installVersion({ version: '3.0.0', root: globalRoot });
  assert.deepEqual(
    [globalV1.digest, globalV2.digest, globalV3.digest],
    [projectV1.digest, projectV2.digest, projectV3.digest],
    'the roots carry identical immutable history',
  );

  const dry = plan({
    projectRoot: projectV1.root,
    globalRoot,
    level: 'project',
    keep: 1,
  }).report;
  assert.deepEqual(dry.coordinates, ['widget/widget@1.0.0', 'widget/widget@2.0.0']);
  assert.deepEqual(
    dry.objects.map((object) => object.digest).sort(compareStoreText),
    [projectV1.digest, projectV2.digest].sort(compareStoreText),
  );

  const applied = await collectWorkflowStoreGarbage({
    projectRoot: projectV1.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });
  assert.deepEqual({ ...applied, dryRun: true }, dry);
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: projectV1.root, globalRoot, warn: () => {} }));
  const registrations = loadCasDefs({ projectRoot: projectV1.root, globalRoot, warn: () => {} });
  for (const coordinate of ['widget/widget@1.0.0', 'widget/widget@2.0.0']) {
    assert.ok(registrations.some((registration) => registration.key === coordinate));
  }
});

test('a runtime-pinned orphan and project exact-digest fallback into global are retained', async () => {
	const orphaned = await installThree();
	const orphanIndexPath = storeIndexPath(orphaned.root);
	const orphanIndex = readWorkflowStoreIndex(orphanIndexPath);
	delete orphanIndex.entries['widget/widget@1.0.0'];
	writeWorkflowStoreIndex(orphanIndexPath, orphanIndex);
	const orphanPlan = plan({
		projectRoot: orphaned.root,
		keep: 1,
		pins: [{ bundleDigest: orphaned.digests['1.0.0'], bundleLock: [] }],
	});
	assert.equal(orphanPlan.report.objects.some((object) => object.digest === orphaned.digests['1.0.0']), false);

	const global = await installThree();
	const projectRoot = tempDir('owenloop-gc-project-fallback-');
	const globalIndex = readWorkflowStoreIndex(storeIndexPath(global.root));
	writeWorkflowStoreIndex(storeIndexPath(projectRoot), {
		version: 1,
		entries: {
			'widget/widget@1.0.0': { ...globalIndex.entries['widget/widget@1.0.0']! },
		},
	});
	const globalPlan = plan({
		projectRoot,
		globalRoot: global.root,
		level: 'global',
		keep: 1,
	});
	assert.equal(
		globalPlan.report.objects.some((object) => object.digest === global.digests['1.0.0']),
		false,
		'project-indexed global fallback remains installed with its global alias',
	);
});

test('an interface binding digest is a runtime retention root before child spawn', async () => {
  const installed = await installThree();
  const selected = installed.digests['1.0.0'];
  const result = plan({
    projectRoot: installed.root,
    keep: 1,
    pins: [{ bundleLock: [], interfaceBindingDigests: [selected] }],
  });
  assert.equal(
    result.report.objects.some((object) => object.digest === selected),
    false,
    'the start-bound implementation object remains reachable without a child workflow row',
  );
  assert.equal(
    result.report.coordinates.includes('widget/widget@1.0.0'),
    false,
    'the selected implementation coordinate is retained with its object',
  );
});

test('global GC retains every digest named by the project index even when project bytes exist', async () => {
  const project = await installThree();
  const global = await installThree();
  assert.deepEqual(global.digests, project.digests, 'both roots carry identical immutable history');

  const projectIndexBefore = readFileSync(storeIndexPath(project.root));
  const globalIndexBefore = readFileSync(storeIndexPath(global.root));
  const globalObjectsRoot = join(global.root, 'objects', 'sha256');
  const globalObjectsBefore = readdirSync(globalObjectsRoot).sort(compareStoreText);

  const dry = plan({
    projectRoot: project.root,
    globalRoot: global.root,
    level: 'global',
    keep: 1,
  }).report;
  assert.deepEqual(dry.objects, [], 'project-indexed replicas are external protection roots for global GC');

  const applied = await collectWorkflowStoreGarbage({
    projectRoot: project.root,
    globalRoot: global.root,
    level: 'global',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });
  assert.deepEqual(applied.objects, []);
  assert.deepEqual(readFileSync(storeIndexPath(project.root)), projectIndexBefore);
  assert.deepEqual(readFileSync(storeIndexPath(global.root)), globalIndexBefore);
  assert.deepEqual(readdirSync(globalObjectsRoot).sort(compareStoreText), globalObjectsBefore);
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: project.root, globalRoot: global.root, warn: () => {} }));
});

test('multi-workflow objects and multiple coordinates are pruned atomically', async () => {
  const extraV1 = workflowYaml('helper', 'helper-v1');
  const extraV2 = workflowYaml('helper', 'helper-v2');
  const old = await installVersion({ version: '1.0.0', workflows: { helper: extraV1 } });
  await installVersion({ version: '2.0.0', root: old.root, workflows: { helper: extraV2 } });
  const indexPath = storeIndexPath(old.root);
  const index = readWorkflowStoreIndex(indexPath);
  index.entries[workflowCoordinate({ namespace: 'alias', name: 'widget', version: '1.0.0' })] = {
    ...index.entries['widget/widget@1.0.0']!,
  };
  writeWorkflowStoreIndex(indexPath, index);

  const report = plan({ projectRoot: old.root, keep: 1 }).report;
  assert.equal(report.count, 1);
  assert.deepEqual(report.objects[0], {
    digest: old.digest,
    bytes: report.bytes,
    coordinates: ['alias/widget@1.0.0', 'widget/widget@1.0.0'],
  });
  assert.deepEqual(report.coordinates, ['alias/widget@1.0.0', 'widget/widget@1.0.0']);
});

test('bundle GC --yes removes exactly an unchanged dry run and strict loading still succeeds', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const dry = await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: false,
    readSnapshotPins: () => [],
  });
  const applied = await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });
  assert.deepEqual({ ...applied, dryRun: true }, dry);
  for (const object of applied.objects) {
    assert.equal(existsSync(objectDirForDigest(installed.root, object.digest as DefDigest)), false);
  }
  const remaining = readWorkflowStoreIndex(storeIndexPath(installed.root));
  assert.deepEqual(Object.keys(remaining.entries), ['widget/widget@2.0.0']);
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));
});

test('GC excludes a two-connection stale snapshot writer from the scan-to-delete window', async () => {
  const includedParent = (version: string) => [
    'name: widget',
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - include: helper',
    '    as: helper',
    '    inputs:',
    '      seed: seed',
    `# ${version}`,
    '',
  ].join('\n');
  const old = await installVersion({
    version: '1.0.0',
    workflow: includedParent('old'),
    workflows: { helper: workflowYaml('helper', 'old-helper') },
    defaultWorkflow: 'widget',
  });
  const current = await installVersion({
    version: '2.0.0',
    root: old.root,
    workflow: includedParent('current'),
    workflows: { helper: workflowYaml('helper', 'current-helper') },
    defaultWorkflow: 'widget',
  });
  const installed = {
    root: old.root,
    digests: { '1.0.0': old.digest, '2.0.0': current.digest },
  };
  const globalRoot = emptyRoot();
  const controlDir = tempDir('owenloop-gc-snapshot-barrier-');
  const dbPath = join(controlDir, 'state.db');
  const readyPath = join(controlDir, 'ready');
  const attemptPath = join(controlDir, 'attempt');
  const resultPath = join(controlDir, 'result.json');
  const target = 'widget/widget@1.0.0';
  const childScript = `
    const { writeFileSync } = await import('node:fs');
    const { Engine } = await import(${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)});
    const { finalizeDefs } = await import(${JSON.stringify(new URL('../src/defs.ts', import.meta.url).href)});
    const { openStore } = await import(${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)});
    const { loadCasDefs } = await import(${JSON.stringify(new URL('../src/store/index.ts', import.meta.url).href)});
    const registrations = loadCasDefs({
      projectRoot: process.env.GC_PROJECT_ROOT,
      globalRoot: process.env.GC_GLOBAL_ROOT,
      warn: () => {},
    });
    const parent = registrations.find((registration) => registration.key === process.env.GC_TARGET);
    const helper = registrations.find((registration) =>
      registration.bundleDigest === parent?.bundleDigest && registration.def.name === 'helper');
    if (parent === undefined || helper === undefined) throw new Error('missing include-bearing CAS fixture definitions');
    const defs = finalizeDefs(new Map([
      [process.env.GC_TARGET, parent.def],
      ['helper', helper.def],
    ]));
    const store = openStore(process.env.GC_DB_PATH);
    const engine = new Engine(store, (name) => {
      const def = defs.get(name);
      if (def === undefined) throw new Error('missing stale test definition ' + name);
      return def;
    });
    writeFileSync(process.env.GC_READY_PATH, 'ready');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    writeFileSync(process.env.GC_ATTEMPT_PATH, 'attempt');
    try {
      const workflow = engine.createInstance(process.env.GC_TARGET);
      writeFileSync(process.env.GC_RESULT_PATH, JSON.stringify({ ok: true, workflow }));
    } catch (error) {
      writeFileSync(process.env.GC_RESULT_PATH, JSON.stringify({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      store.close();
    }
  `;
  const registrations = loadCasDefs({
    projectRoot: installed.root,
    globalRoot,
    warn: () => {},
  });
  const parent = registrations.find((registration) => registration.key === target);
  const helper = registrations.find((registration) =>
    registration.bundleDigest === parent?.bundleDigest && registration.def.name === 'helper');
  assert.ok(parent && helper, 'the exact parent and its same-bundle include target load');
  const finalized = finalizeDefs(new Map([
    [target, parent.def],
    ['helper', helper.def],
  ]));
  const finalizedTarget = finalized.get(target);
  assert.ok(finalizedTarget, 'the exact include-bearing CAS definition finalizes');
  assert.deepEqual(finalizedTarget.bundleStoreRoots, [installed.root]);
  assert.equal(
    Object.getOwnPropertyDescriptor(finalizedTarget, 'bundleStoreRoots')?.enumerable,
    false,
    'runtime provenance remains non-enumerable after include expansion',
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', childScript], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GC_PROJECT_ROOT: installed.root,
      GC_GLOBAL_ROOT: globalRoot,
      GC_DB_PATH: dbPath,
      GC_READY_PATH: readyPath,
      GC_ATTEMPT_PATH: attemptPath,
      GC_RESULT_PATH: resultPath,
      GC_TARGET: target,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { childError += chunk; });
  const childDone = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`snapshot writer exited ${String(code)}/${String(signal)}: ${childError}`));
    });
  });

  waitForPath(readyPath, 'stale snapshot writer to load its definition');
  const applied = await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => readRuntimeSnapshotBundlePins(dbPath),
    hooks: {
      afterSnapshotPinsRead: () => {
		child.stdin.write('commit\n');
		waitForPath(attemptPath, 'second connection to attempt its snapshot');
      },
    },
  });
  child.stdin.end();
  await childDone;

  assert.ok(applied.objects.some((object) => object.digest === installed.digests['1.0.0']));
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { ok: boolean; error?: string };
  assert.equal(result.ok, false, 'the stale snapshot must not commit after GC wins the shared lock');
  assert.match(result.error ?? '', /no longer indexed with verified object bytes/u);
  assert.deepEqual(readRuntimeSnapshotBundlePins(dbPath), [], 'the second SQLite connection landed no snapshot row');
});

test('GC-first cross-root race makes a stale non-target caller install fail before commit', async () => {
  const projectV1 = await installVersion({ name: 'child', version: '1.0.0' });
  await installVersion({ name: 'child', version: '2.0.0', root: projectV1.root });
  const globalRoot = emptyRoot();
  const target = 'child/child@1.0.0';
  const callerSource = writeBundleSource({
    name: 'caller',
    version: '1.0.0',
    workflow: [
      'name: caller',
      'inputs:',
      '  - name: seed',
      '    seedOwed: true',
      'steps:',
      '  - name: invoke',
      `    calls: ${target}`,
      '    inputs:',
      '      seed: seed',
      '    produces: [done]',
      'outputs: [done]',
      '',
    ].join('\n'),
    lock: { [target]: projectV1.digest },
  });
  const controlDir = tempDir('owenloop-gc-install-barrier-');
  const readyPath = join(controlDir, 'ready');
  const attemptPath = join(controlDir, 'attempt');
  const resultPath = join(controlDir, 'result.json');
  const childScript = `
    const { writeFileSync } = await import('node:fs');
    const { installBundleFixture } = await import(${JSON.stringify(new URL('./helpers/store-fixture.ts', import.meta.url).href)});
    writeFileSync(process.env.GC_READY_PATH, 'ready');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    writeFileSync(process.env.GC_ATTEMPT_PATH, 'attempt');
    try {
      await installBundleFixture({
		sourceDir: process.env.GC_CALLER_SOURCE,
		root: process.env.GC_GLOBAL_ROOT,
		level: 'global',
		projectRoot: process.env.GC_PROJECT_ROOT,
		globalRoot: process.env.GC_GLOBAL_ROOT,
      });
      writeFileSync(process.env.GC_RESULT_PATH, JSON.stringify({ ok: true }));
    } catch (error) {
      writeFileSync(process.env.GC_RESULT_PATH, JSON.stringify({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', childScript], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GC_PROJECT_ROOT: projectV1.root,
      GC_GLOBAL_ROOT: globalRoot,
      GC_CALLER_SOURCE: callerSource,
      GC_READY_PATH: readyPath,
      GC_ATTEMPT_PATH: attemptPath,
      GC_RESULT_PATH: resultPath,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { childError += chunk; });
  const childDone = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`caller installer exited ${String(code)}/${String(signal)}: ${childError}`));
    });
  });

  waitForPath(readyPath, 'stale non-target installer');
  const applied = await collectWorkflowStoreGarbage({
    projectRoot: projectV1.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
    hooks: {
      afterSnapshotPinsRead: () => {
		child.stdin.write('commit\n');
		waitForPath(attemptPath, 'non-target install lock attempt');
      },
    },
  });
  child.stdin.end();
  await childDone;

  assert.ok(applied.objects.some((object) => object.digest === projectV1.digest));
  const result = JSON.parse(readFileSync(resultPath, 'utf8')) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /no longer exactly callable/u);
  assert.equal(readWorkflowStoreIndex(storeIndexPath(globalRoot)).entries['caller/caller@1.0.0'], undefined);
});

test('GC journal restores a live object interrupted in the temporary chmod window', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const gcJournal = join(installed.root, '.owenloop', 'gc.journal');
  let interruptedObject: string | undefined;
  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
      hooks: {
		afterLiveObjectMadeWritable: (path) => {
		  interruptedObject = path;
		  assert.equal(existsSync(gcJournal), true);
		  assert.notEqual(lstatSync(path).mode & 0o200, 0);
		  throw new Error('injected process interruption after live chmod');
		},
      },
    }),
    /injected process interruption after live chmod/u,
  );
  assert.ok(interruptedObject);
  assert.equal(existsSync(gcJournal), true);

  await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });
  assert.equal(existsSync(gcJournal), false);
  assert.equal(existsSync(interruptedObject), false);
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));
});

test('ordinary install resolves a durable parked-object journal before shared staging cleanup', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const gcJournal = join(installed.root, '.owenloop', 'gc.journal');
  let parkedObject: string | undefined;
  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
      hooks: {
		afterObjectParked: (path) => {
		  parkedObject = path;
		  assert.equal(lstatSync(path).mode & 0o777, 0o555, 'the parked object is re-hardened');
		  assert.equal(existsSync(gcJournal), true, 'durable evidence remains through parent fsyncs');
		  throw new Error('injected process interruption after durable park');
		},
      },
    }),
    /injected process interruption after durable park/u,
  );
  assert.ok(parkedObject);
  assert.equal(existsSync(parkedObject), true);
  assert.equal(existsSync(gcJournal), true);
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));

  await installVersion({ version: '3.0.0', root: installed.root });
  assert.equal(existsSync(parkedObject), false, 'the install recovers GC evidence before clearing staging');
  assert.equal(existsSync(gcJournal), false);
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));
});

test('offline workflow-store recovery removes only its parked GC object from shared staging', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const gcJournal = join(installed.root, '.owenloop', 'gc.journal');
  let parkedObject: string | undefined;
  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
      hooks: {
		afterObjectParked: (path) => {
		  parkedObject = path;
		  assert.equal(existsSync(gcJournal), true);
		  assert.equal(lstatSync(path).mode & 0o777, 0o555);
		  throw new Error('injected process interruption after durable park');
		},
      },
    }),
    /injected process interruption after durable park/u,
  );
  assert.ok(parkedObject);
  assert.equal(existsSync(parkedObject), true);
  assert.equal(existsSync(gcJournal), true);
  const unrelated = join(installed.root, '.owenloop-staging', 'unrelated', 'keep.txt');
  mkdirSync(join(unrelated, '..'), { recursive: true });
  writeFileSync(unrelated, 'keep');

  const state = workflowStoreStatePaths(installed.root);
  const recovery = await recoverWorkflowStore({
    root: installed.root,
    lockPath: state.lockPath,
    journalPath: state.journalPath,
  });
  assert.equal(recovery, 'no-journal');
  assert.equal(existsSync(gcJournal), false, 'offline recovery resolves GC evidence first');
  assert.equal(existsSync(parkedObject), false, 'the journal-authenticated parked object is removed');
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep', 'unrelated staging evidence is preserved');
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));
});

test('ordinary bundle install restores a parked GC object when the durable index still names its digest', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const indexPath = storeIndexPath(installed.root);
  const indexBefore = readFileSync(indexPath);
  const gcJournal = join(installed.root, '.owenloop', 'gc.journal');
  let parkedObject: string | undefined;
  let parkedDigest: DefDigest | undefined;
  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
      hooks: {
		afterObjectParked: (path) => {
		  parkedObject = path;
		  const match = /\/gc-([0-9a-f]{64})-park_[0-9a-f]{24}$/u.exec(path);
		  assert.ok(match);
		  parkedDigest = match[1] as DefDigest;
		  throw new Error('injected parked-object interruption');
		},
      },
    }),
    /injected parked-object interruption/u,
  );
  assert.ok(parkedObject && parkedDigest);
  assert.equal(existsSync(objectDirForDigest(installed.root, parkedDigest)), false);

  // Model a crash where the index rename was not the state recovered by the
  // filesystem. Recovery must consult these current durable bytes rather than
  // assuming every parked digest is doomed.
  writeFileSync(indexPath, indexBefore);
  await installVersion({ version: '3.0.0', root: installed.root });
  const restored = objectDirForDigest(installed.root, parkedDigest);
  assert.equal(existsSync(restored), true, 'the indexed parked object returns to its canonical path');
  assert.equal(lstatSync(restored).mode & 0o777, 0o555);
  assert.equal(existsSync(parkedObject), false);
  assert.equal(existsSync(gcJournal), false);
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));
});

test('GC journal recovery refuses a symlinked parked-object root before chmod', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const outside = tempDir('owenloop-gc-journal-escape-');
  const digest = 'a'.repeat(64) as DefDigest;
  const parkedName = `gc-${digest}-park_${'b'.repeat(24)}`;
  const outsideObject = join(outside, parkedName);
  mkdirSync(outsideObject);
  const outsideMode = lstatSync(outsideObject).mode & 0o7777;
  symlinkSync(outside, join(installed.root, '.owenloop-staging'));
  const journalPath = join(installed.root, '.owenloop', 'gc.journal');
  writeFileSync(journalPath, `${JSON.stringify({
    version: 1,
    digest,
    parkedName,
    originalMode: 0o555,
  })}\n`);
  const indexBefore = readFileSync(storeIndexPath(installed.root));

  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
    }),
    /workflow store staging directory.*symlink/u,
  );
  assert.equal(lstatSync(outsideObject).mode & 0o7777, outsideMode, 'recovery never chmods through the link');
  assert.deepEqual(readFileSync(storeIndexPath(installed.root)), indexBefore, 'recovery refusal never mutates the index');
  assert.equal(existsSync(journalPath), true, 'untrusted evidence remains for manual inspection');
});

test('GC refuses a symlinked shared staging root before index mutation', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const outside = tempDir('owenloop-gc-journal-escape-');
  const outsideSentinel = join(outside, 'keep.txt');
  writeFileSync(outsideSentinel, 'keep');
  symlinkSync(outside, join(installed.root, '.owenloop-staging'));
  const indexBefore = readFileSync(storeIndexPath(installed.root));

  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
    }),
    /workflow store staging directory.*symlink/u,
  );
  assert.equal(readFileSync(outsideSentinel, 'utf8'), 'keep');
  assert.deepEqual(readFileSync(storeIndexPath(installed.root)), indexBefore);
});

test('project and global GC mutate only the selected target root', async () => {
  const project = await installThree();
  const globalOne = await installVersion({ name: 'global-widget', version: '1.0.0' });
  await installVersion({ name: 'global-widget', version: '1.1.0', root: globalOne.root });
  await installVersion({ name: 'global-widget', version: '2.0.0', root: globalOne.root });
  const global = { root: globalOne.root };
  const projectIndexBefore = readFileSync(storeIndexPath(project.root));
  const globalIndexBefore = readFileSync(storeIndexPath(global.root));

	  const globalApplied = await collectWorkflowStoreGarbage({
    projectRoot: project.root,
    globalRoot: global.root,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });
  assert.deepEqual(readFileSync(storeIndexPath(global.root)), globalIndexBefore);

  await collectWorkflowStoreGarbage({
    projectRoot: project.root,
    globalRoot: global.root,
    level: 'global',
    keep: 1,
    yes: true,
	    readSnapshotPins: () => [],
	  });
	  assert.equal(globalApplied.count, 2);
	  assert.notDeepEqual(readFileSync(storeIndexPath(global.root)), globalIndexBefore);
	  assert.notDeepEqual(readFileSync(storeIndexPath(project.root)), projectIndexBefore);
});

test('failure after index commit leaves a loadable index and a rerunnable orphan', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
      hooks: { afterIndexWrite: () => { throw new Error('injected after-index failure'); } },
    }),
    /injected after-index failure/u,
  );
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));
  assert.equal(existsSync(objectDirForDigest(installed.root, installed.digests['1.0.0'])), true);

  const rerun = await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });
  assert.ok(rerun.objects.some((object) => object.digest === installed.digests['1.0.0']));
  assert.equal(existsSync(objectDirForDigest(installed.root, installed.digests['1.0.0'])), false);
});

test('failed parked-object removal keeps durable evidence for the next project GC run', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const gcJournal = join(installed.root, '.owenloop', 'gc.journal');
  let parkedObject: string | undefined;
  let removedEntry: string | undefined;

  await assert.rejects(
    collectWorkflowStoreGarbage({
      projectRoot: installed.root,
      globalRoot,
      level: 'project',
      keep: 1,
      yes: true,
      readSnapshotPins: () => [],
      hooks: {
		removeParkedObject: (path) => {
		  parkedObject = path;
		  chmodSync(path, 0o755);
		  const victim = readdirSync(path)
			.find((entry) => lstatSync(join(path, entry)).isFile());
		  assert.ok(victim, 'fixture has a regular file to remove before the injected failure');
		  removedEntry = join(path, victim);
		  rmSync(removedEntry, { force: true });
		  throw new Error('injected parked-object removal failure');
		},
      },
    }),
    /injected parked-object removal failure/u,
  );

  assert.ok(parkedObject);
  assert.equal(existsSync(parkedObject), true);
  assert.ok(removedEntry);
  assert.equal(existsSync(removedEntry), false, 'the first cleanup attempt removed part of the bundle');
  assert.notEqual(lstatSync(parkedObject).mode & 0o200, 0, 'partial cleanup left the doomed tree writable');
  assert.equal(existsSync(gcJournal), true, 'failed cleanup retains its authenticated retry evidence');
  const unrelated = join(installed.root, '.owenloop-staging', 'unrelated', 'keep.txt');
  mkdirSync(dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, 'keep');

  await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });

  assert.equal(existsSync(parkedObject), false, 'the next run retries the journal-owned parked path');
  assert.equal(existsSync(gcJournal), false, 'evidence clears only after durable removal');
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep', 'unrelated shared staging remains untouched');
  assert.doesNotThrow(() => loadCasDefs({ projectRoot: installed.root, globalRoot, warn: () => {} }));
});

test('malformed or symlinked object state fails closed without deletion', async () => {
  const installed = await installThree();
  const badDigest = 'f'.repeat(64);
  symlinkSync(
    objectDirForDigest(installed.root, installed.digests['2.0.0']),
    join(installed.root, 'objects', 'sha256', badDigest),
  );
  const indexBefore = readFileSync(storeIndexPath(installed.root));
  const objectsBefore = readdirSync(join(installed.root, 'objects', 'sha256')).sort();
  assert.throws(() => plan({ projectRoot: installed.root, keep: 1 }), /symlink/u);
  assert.deepEqual(readFileSync(storeIndexPath(installed.root)), indexBefore);
  assert.deepEqual(readdirSync(join(installed.root, 'objects', 'sha256')).sort(), objectsBefore);
});

test('applied project GC refuses a symlinked global-store parent before creating coordination state', async () => {
  const cwd = tempDir('owenloop-gc-symlinked-global-parent-');
  const home = join(cwd, 'home');
  const projectRoot = join(cwd, 'workflows');
  const redirected = tempDir('owenloop-gc-symlink-target-');
  mkdirSync(home);
  symlinkSync(redirected, join(home, '.owenloop'), 'dir');
  await installVersion({ version: '1.0.0', root: projectRoot });
  await installVersion({ version: '2.0.0', root: projectRoot });
  await installVersion({ version: '3.0.0', root: projectRoot });

  const indexBefore = readFileSync(storeIndexPath(projectRoot));
  const objectsRoot = join(projectRoot, 'objects', 'sha256');
  const objectsBefore = readdirSync(objectsRoot).sort(compareStoreText);
  const redirectedBefore = readdirSync(redirected).sort(compareStoreText);
  const err: string[] = [];
  const code = await mainAsync(['bundle', 'gc', '--keep', '1', '--yes'], {
    cwd,
    env: { HOME: home },
    out: () => {},
    err: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.match(err.join('\n'), /workflow store root.*symbolic link/u);
  assert.deepEqual(readFileSync(storeIndexPath(projectRoot)), indexBefore);
  assert.deepEqual(readdirSync(objectsRoot).sort(compareStoreText), objectsBefore);
  assert.deepEqual(
    readdirSync(redirected).sort(compareStoreText),
    redirectedBefore,
    'the symlink target receives no counterpart root or lock state',
  );
});

test('runtime snapshot pin reader is read-only, legacy-aware, and fails closed on bad digests', () => {
  const dir = tempDir('owenloop-gc-db-');
  const dbPath = join(dir, 'state.db');
  assert.deepEqual(readRuntimeSnapshotBundlePins(dbPath), []);
  assert.equal(existsSync(dbPath), false, 'missing DB is not created');

  const digest = 'a'.repeat(64);
  const dependency = 'b'.repeat(64);
  const selected = 'c'.repeat(64);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE workflow (id TEXT PRIMARY KEY, def_snapshot TEXT, interface_bindings TEXT, created_at INTEGER)');
  db.prepare('INSERT INTO workflow (id, def_snapshot, interface_bindings, created_at) VALUES (?, ?, ?, ?)').run(
    'wf_good',
    JSON.stringify({
      bundleDigest: digest,
      bundleLock: { 'dep/dep@1.0.0': dependency },
      steps: [{ calls: 'legacy/child@1.0.0' }, { calls: 'dep/dep@1.0.0' }],
    }),
    JSON.stringify([{
      interface: { name: 'research-report', version: '1' },
      target: 'implementations/report@1.0.0',
      digest: selected,
      signature: { inputs: [], outputs: [] },
    }]),
    1,
  );
  db.close();
  const bytesBefore = readFileSync(dbPath);
  assert.deepEqual(readRuntimeSnapshotBundlePins(dbPath), [{
    bundleDigest: digest,
    bundleLock: [dependency],
    exactCalls: ['legacy/child@1.0.0'],
    interfaceBindingDigests: [selected],
  }]);
  assert.deepEqual(readFileSync(dbPath), bytesBefore);
  assert.equal(existsSync(`${dbPath}-wal`), false);

  const corrupt = new DatabaseSync(dbPath);
  corrupt.prepare('UPDATE workflow SET def_snapshot = ? WHERE id = ?').run(
    JSON.stringify({ bundleDigest: 'NOT-A-DIGEST' }),
    'wf_good',
  );
  corrupt.close();
  assert.throws(() => readRuntimeSnapshotBundlePins(dbPath), /noncanonical/u);

  const corruptBinding = new DatabaseSync(dbPath);
  corruptBinding.prepare('UPDATE workflow SET def_snapshot = ?, interface_bindings = ? WHERE id = ?').run(
    JSON.stringify({ bundleDigest: digest }),
    JSON.stringify([{
      interface: { name: 'research-report', version: '1' },
      target: 'implementations/report@1.0.0',
      digest: 'NOT-A-DIGEST',
      signature: { inputs: [], outputs: [] },
    }]),
    'wf_good',
  );
  corruptBinding.close();
  assert.throws(() => readRuntimeSnapshotBundlePins(dbPath), /interface_bindings\[0\]\.digest is noncanonical/u);

  const legacyPath = join(dir, 'legacy.db');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec('CREATE TABLE workflow (id TEXT PRIMARY KEY, created_at INTEGER)');
  legacy.close();
  assert.deepEqual(readRuntimeSnapshotBundlePins(legacyPath), []);
});

test('create and adopt refuse snapshot locks through a symlinked global parent', async () => {
  const cwd = tempDir('owenloop-snapshot-global-parent-');
  const realHome = join(cwd, 'real-home');
  const linkedHome = join(cwd, 'linked-home');
  const realOwenloop = join(realHome, '.owenloop');
  const globalRoot = join(realOwenloop, 'workflows');
  mkdirSync(realHome);
  mkdirSync(linkedHome);
  await installVersion({ version: '1.0.0', root: globalRoot });
  rmRecursiveForce(join(globalRoot, '.owenloop'));
  symlinkSync(realOwenloop, join(linkedHome, '.owenloop'));

  const dbPath = join(cwd, 'explicit-state.db');
  const invoke = async (argv: string[]) => {
    const err: string[] = [];
    const code = await mainAsync([...argv, '--db', dbPath], {
      cwd,
      env: { HOME: linkedHome },
      out: () => {},
      err: (line) => err.push(line),
    });
    return { code, error: err.join('\n') };
  };

  const created = await invoke(['create', 'widget/widget']);
  assert.equal(created.code, 1);
  assert.match(created.error, /workflow store root.*parent.*symbolic link/u);
  assert.equal(
    existsSync(join(globalRoot, '.owenloop')),
    false,
    'create writes no snapshot lock state through the symlinked global parent',
  );

  const store = openStore(dbPath);
  store.tx(() => store.insertWorkflow('wf_legacy', { def: 'widget/widget' }));
  store.close();

  const adopted = await invoke(['adopt', 'wf_legacy']);
  assert.equal(adopted.code, 1);
  assert.match(adopted.error, /workflow store root.*parent.*symbolic link/u);
  assert.equal(
    existsSync(join(globalRoot, '.owenloop')),
    false,
    'adopt writes no snapshot lock state through the symlinked global parent',
  );
  const reopened = openStore(dbPath);
  assert.equal(reopened.getWorkflow('wf_legacy')?.defSnapshot, undefined, 'failed adopt leaves the legacy row unpinned');
  reopened.close();
});

test('destructive bundle GC refuses a newer runtime DB schema without changing the store', async () => {
  const cwd = tempDir('owenloop-gc-newer-db-');
  const home = join(cwd, 'home');
  const projectRoot = join(cwd, 'workflows');
  mkdirSync(home);
  await installVersion({ version: '1.0.0', root: projectRoot });
  await installVersion({ version: '2.0.0', root: projectRoot });
  await installVersion({ version: '3.0.0', root: projectRoot });

  const stateDir = join(cwd, '.owenloop');
  const dbPath = join(stateDir, 'state.db');
  mkdirSync(stateDir);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', '99');
  db.close();

  const indexBefore = readFileSync(storeIndexPath(projectRoot));
  const objectsRoot = join(projectRoot, 'objects', 'sha256');
  const objectsBefore = readdirSync(objectsRoot).sort(compareStoreText);
  const dbBefore = readFileSync(dbPath);
  assert.throws(
    () => readRuntimeSnapshotBundlePins(dbPath),
    (error: unknown) => error instanceof StoreVersionError && /schema_version 99 is newer/u.test(error.message),
  );

  const err: string[] = [];
  const code = await mainAsync(['bundle', 'gc', '--keep', '1', '--yes', '--db', dbPath], {
    cwd,
    env: { HOME: home },
    out: () => {},
    err: (line) => err.push(line),
  });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /schema_version 99 is newer/u);
  assert.deepEqual(readFileSync(storeIndexPath(projectRoot)), indexBefore);
  assert.deepEqual(readdirSync(objectsRoot).sort(compareStoreText), objectsBefore);
  assert.deepEqual(readFileSync(dbPath), dbBefore);
});

test('destructive bundle gc rejects missing or blank DB/defs paths before touching store state', async () => {
  const cwd = tempDir('owenloop-gc-path-validation-');
  const home = join(cwd, 'home');
  const projectRoot = join(cwd, 'workflows');
  mkdirSync(home);
  const v1 = await installVersion({ version: '1.0.0', root: projectRoot });
  await installVersion({ version: '2.0.0', root: projectRoot });
  await installVersion({ version: '3.0.0', root: projectRoot });

  const stateDir = join(cwd, '.owenloop');
  mkdirSync(stateDir);
  const dbPath = join(stateDir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE workflow (id TEXT PRIMARY KEY, def_snapshot TEXT, created_at INTEGER)');
  db.prepare('INSERT INTO workflow (id, def_snapshot, created_at) VALUES (?, ?, ?)').run(
    'wf_pinned',
    JSON.stringify({ bundleDigest: v1.digest, bundleLock: {} }),
    1,
  );
  db.close();

  const indexBefore = readFileSync(storeIndexPath(projectRoot));
  const dbBefore = readFileSync(dbPath);
  const objectsDir = join(projectRoot, 'objects', 'sha256');
  const objectsBefore = readdirSync(objectsDir).sort();
  const globalRoot = join(home, '.owenloop', 'workflows');
  const legacyLock = join(stateDir, 'add.lock');

  const invoke = async (argv: string[], env: Record<string, string | undefined> = {}) => {
    const err: string[] = [];
    const code = await mainAsync(argv, {
      cwd,
      env: { HOME: home, ...env },
      out: () => {},
      err: (line) => err.push(line),
    });
    return { code, err: err.join('\n') };
  };
  const cases: Array<{ argv: string[]; env?: Record<string, string | undefined>; pattern: RegExp }> = [
    { argv: ['bundle', 'gc', '--keep', '1', '--yes', '--db', '--yes'], pattern: /--db requires a non-empty path/u },
    { argv: ['bundle', 'gc', '--keep', '1', '--yes', '--db='], pattern: /--db requires a non-empty path/u },
    { argv: ['bundle', 'gc', '--keep', '1', '--yes', '--db=   '], pattern: /--db requires a non-empty path/u },
    { argv: ['bundle', 'gc', '--keep', '1', '--yes', '--defs', '--yes'], pattern: /--defs requires a non-empty path/u },
    { argv: ['bundle', 'gc', '--keep', '1', '--yes', '--defs='], pattern: /--defs requires a non-empty path/u },
    { argv: ['bundle', 'gc', '--keep', '1', '--yes', '--defs=   '], pattern: /--defs requires a non-empty path/u },
    {
      argv: ['bundle', 'gc', '--keep', '1', '--yes'],
      env: { OWENLOOP_DB: '   ' },
      pattern: /OWENLOOP_DB must be a non-empty path/u,
    },
    {
      argv: ['bundle', 'gc', '--keep', '1', '--yes'],
      env: { OWENLOOP_DEFS: '' },
      pattern: /OWENLOOP_DEFS must be a non-empty path/u,
    },
  ];
  for (const input of cases) {
    const result = await invoke(input.argv, input.env);
    assert.equal(result.code, 1, `${input.argv.join(' ')} should fail`);
    assert.match(result.err, input.pattern);
    assert.deepEqual(readFileSync(storeIndexPath(projectRoot)), indexBefore);
    assert.deepEqual(readdirSync(objectsDir).sort(), objectsBefore);
    assert.deepEqual(readFileSync(dbPath), dbBefore);
    assert.equal(existsSync(objectDirForDigest(projectRoot, v1.digest)), true, 'the real DB pin remains usable');
    assert.equal(existsSync(globalRoot), false, 'validation precedes cross-root lock creation');
    assert.equal(existsSync(legacyLock), false, 'validation precedes the legacy writer lock');
  }
});

test('project bundle gc recovers a pending GitHub replacement before shared staging cleanup', async () => {
  const cwd = tempDir('owenloop-gc-github-recovery-');
  const home = join(cwd, 'home');
  const projectRoot = join(cwd, 'workflows');
  mkdirSync(home);
  const v1 = await installVersion({ version: '1.0.0', root: projectRoot });
  await installVersion({ version: '2.0.0', root: projectRoot });
  await installVersion({ version: '3.0.0', root: projectRoot });

  const owner = 'acme';
  const repo = 'widgets';
  const source = `${owner}/${repo}`;
  const folder = installFolder(owner, repo);
  const stagingId = 'stg_pending_github_replacement';
  const stagingRoot = join(projectRoot, '.owenloop-staging');
  const backupDir = join(stagingRoot, `${stagingId}-old`);
  const destination = join(projectRoot, folder);
  mkdirSync(destination, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(destination, 'github.yaml'), 'NEW');
  writeFileSync(join(backupDir, 'github.yaml'), 'PREVIOUS');

  const stateDir = join(cwd, '.owenloop');
  mkdirSync(stateDir);
  const journalPath = join(stateDir, 'add.journal');
  const lockfilePath = join(stateDir, 'installed.json');
  const previousSha = 'a'.repeat(40);
  const replacementSha = 'b'.repeat(40);
  writeLockfile(lockfilePath, {
    version: 1,
    installed: {
      [source]: {
		source,
		ref: 'HEAD',
		sha: previousSha,
		installedAt: 1,
		path: folder,
		files: ['github.yaml'],
      },
    },
  });
  writeAddJournal(journalPath, {
    version: 1,
    phase: 'applying',
    source,
    sha: replacementSha,
    folder,
    stagingId,
    hadDest: true,
    defsDir: projectRoot,
    ref: 'HEAD',
    startedAt: 1,
  });

  const out: string[] = [];
  const err: string[] = [];
  const code = await mainAsync(['bundle', 'gc', '--keep', '1', '--yes'], {
    cwd,
    env: { HOME: home },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(JSON.parse(out.join('\n')).count, 2);
  assert.equal(readFileSync(join(destination, 'github.yaml'), 'utf8'), 'PREVIOUS');
  assert.equal(existsSync(backupDir), false, 'recovery consumes the retained backup instead of GC deleting it');
  assert.equal(existsSync(journalPath), false, 'the recovered GitHub transaction clears its journal');
  assert.equal(existsSync(objectDirForDigest(projectRoot, v1.digest)), false, 'GC still removes its own candidate');
});

test('project GC without legacy coordination preserves unrelated shared-staging evidence', async () => {
  const installed = await installThree();
  const globalRoot = emptyRoot();
  const retainedBackup = join(installed.root, '.owenloop-staging', 'stg_unknown-owner-old', 'workflow.yaml');
  mkdirSync(dirname(retainedBackup), { recursive: true });
  writeFileSync(retainedBackup, 'ONLY SURVIVING COPY');

  const result = await collectWorkflowStoreGarbage({
    projectRoot: installed.root,
    globalRoot,
    level: 'project',
    keep: 1,
    yes: true,
    readSnapshotPins: () => [],
  });
  assert.equal(result.count, 2);
  assert.equal(readFileSync(retainedBackup, 'utf8'), 'ONLY SURVIVING COPY');
});

test('bundle gc CLI validates before mutation, dry-runs without creating state, and sync gc refuses clearly', async () => {
  const cwd = tempDir('owenloop-gc-cli-');
  const home = join(cwd, 'home');
  mkdirSync(home);
  const invoke = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await mainAsync(argv, {
      cwd,
      env: { HOME: home },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  const dry = await invoke('bundle', 'gc');
  assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(JSON.parse(dry.out), {
    ok: true,
    dryRun: true,
    level: 'project',
    root: join(cwd, 'workflows'),
    keep: 2,
    count: 0,
    bytes: 0,
    coordinates: [],
    objects: [],
  });
  assert.equal(existsSync(join(cwd, 'workflows')), false);
  assert.equal(existsSync(join(cwd, '.owenloop')), false);

  for (const argv of [
    ['bundle', 'gc', '--keep'],
    ['bundle', 'gc', '--keep=0'],
    ['bundle', 'gc', '--keep=1.5'],
    ['bundle', 'gc', 'extra'],
  ]) {
    const result = await invoke(...argv);
    assert.equal(result.code, 1, `${argv.join(' ')} should fail`);
  }
  assert.match((await invoke('bundle', 'gc', '--global', '--defs', 'elsewhere')).err, /cannot be combined/u);
  assert.match((await invoke('bundle', 'inspect', 'missing.wnlp', '--yes')).err, /only valid for bundle gc/u);

  const syncErr: string[] = [];
  assert.equal(main(['bundle', 'gc'], {
    cwd,
    env: { HOME: home },
    out: () => {},
    err: (line) => syncErr.push(line),
  }), 1);
  assert.match(syncErr.join('\n'), /requires the async entry point/u);
});

test('CLI --verbose restores detailed superseded notices while default emits one note', async () => {
	const cwd = tempDir('owenloop-gc-verbose-cli-');
	const projectRoot = join(cwd, 'workflows');
	const home = join(cwd, 'home');
	mkdirSync(home);
	await installVersion({ version: '1.0.0', root: projectRoot });
	await installVersion({ version: '2.0.0', root: projectRoot });
	const run = (...argv: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const code = main(argv, {
			cwd,
			env: { HOME: home, OWENLOOP_DB: join(cwd, 'state.db') },
			out: (line) => out.push(line),
			err: (line) => err.push(line),
		});
		return { code, out, err };
	};

	const ordinary = run('defs');
	assert.equal(ordinary.code, 0, ordinary.err.join('\n'));
	assert.deepEqual(ordinary.err, ['note: 1 superseded bundle version hidden; --verbose to list them']);
	const verbose = run('defs', '--verbose');
	assert.equal(verbose.code, 0, verbose.err.join('\n'));
	assert.equal(verbose.err.length, 1);
	assert.match(verbose.err[0]!, /^warning: workflow 'widget\/widget'.*does not hold that name/u);
	assert.equal(verbose.err.some((line) => line.startsWith('note:')), false);
});
