import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { main, mainAsync } from '../src/cli.ts';
import { readRuntimeSnapshotBundlePins } from '../src/store.ts';
import {
  collectWorkflowStoreGarbage,
  loadCasDefs,
  objectDirForDigest,
  planWorkflowStoreGc,
  readWorkflowStoreIndex,
  storeIndexPath,
  workflowCoordinate,
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
  workflow?: string;
  workflows?: Record<string, string>;
  lock?: Record<string, string>;
}): Promise<{ root: string; digest: DefDigest }> {
  const name = args.name ?? 'widget';
  const sourceDir = writeBundleSource({
    name,
    version: args.version,
    workflow: args.workflow ?? workflowYaml(name, args.marker ?? `${name}-${args.version}`),
    ...(args.workflows === undefined ? {} : { workflows: args.workflows }),
    ...(args.lock === undefined ? {} : { lock: args.lock }),
  });
  const installed = await installBundleFixture({
    sourceDir,
    ...(args.root === undefined ? {} : { root: args.root }),
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

function plan(args: {
  projectRoot: string;
  globalRoot?: string;
  level?: 'project' | 'global';
  keep?: number;
  pins?: RuntimeSnapshotBundlePins[];
}) {
  return planWorkflowStoreGc({
    projectRoot: args.projectRoot,
    globalRoot: args.globalRoot ?? emptyRoot(),
    level: args.level ?? 'project',
    keep: args.keep ?? 2,
    snapshotPins: args.pins ?? [],
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

test('project and global GC mutate only the selected target root', async () => {
  const project = await installThree();
  const global = await installThree();
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

test('runtime snapshot pin reader is read-only, legacy-aware, and fails closed on bad digests', () => {
  const dir = tempDir('owenloop-gc-db-');
  const dbPath = join(dir, 'state.db');
  assert.deepEqual(readRuntimeSnapshotBundlePins(dbPath), []);
  assert.equal(existsSync(dbPath), false, 'missing DB is not created');

  const digest = 'a'.repeat(64);
  const dependency = 'b'.repeat(64);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE workflow (id TEXT PRIMARY KEY, def_snapshot TEXT, created_at INTEGER)');
  db.prepare('INSERT INTO workflow (id, def_snapshot, created_at) VALUES (?, ?, ?)').run(
    'wf_good',
    JSON.stringify({ bundleDigest: digest, bundleLock: { 'dep/dep@1.0.0': dependency } }),
    1,
  );
  db.close();
  const bytesBefore = readFileSync(dbPath);
  assert.deepEqual(readRuntimeSnapshotBundlePins(dbPath), [{ bundleDigest: digest, bundleLock: [dependency] }]);
  assert.deepEqual(readFileSync(dbPath), bytesBefore);
  assert.equal(existsSync(`${dbPath}-wal`), false);

  const corrupt = new DatabaseSync(dbPath);
  corrupt.prepare('UPDATE workflow SET def_snapshot = ? WHERE id = ?').run(
    JSON.stringify({ bundleDigest: 'NOT-A-DIGEST' }),
    'wf_good',
  );
  corrupt.close();
  assert.throws(() => readRuntimeSnapshotBundlePins(dbPath), /noncanonical/u);

  const legacyPath = join(dir, 'legacy.db');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec('CREATE TABLE workflow (id TEXT PRIMARY KEY, created_at INTEGER)');
  legacy.close();
  assert.deepEqual(readRuntimeSnapshotBundlePins(legacyPath), []);
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
