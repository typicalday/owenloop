/**
 * WS-6 — CAS <-> `calls:` unification.
 *
 * Three BEHAVIORAL acceptance criteria, each written so it FAILS if the
 * behavior regresses (each was verified against a deliberately reintroduced
 * defect before being committed):
 *
 *   (a) A bundle where workflow A `calls:` workflow B by BARE name spawns B's
 *       PINNED version — the sibling inside A's own bundle, never a same-named
 *       workflow from a different bundle.
 *   (b) Installing a NEWER version of the same bundle does not retroactively
 *       change what an ALREADY-RUNNING parent's `calls:` resolves to.
 *   (c) A digest mismatch at spawn produces a VISIBLE error debt on the parent's
 *       `calls:` artifact, not a silent divergent run.
 *
 * HERMETIC: every store root, HOME, and database path is materialized by the
 * fixture from its first write. Nothing reads the developer's or CI runner's
 * ambient home, defs dir, or git identity.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { mainAsync } from '../src/cli.ts';
import { Engine, CallsPinError } from '../src/engine.ts';
import { digestScopedCallsTargetKey, finalizeDefs, resolveCallsTarget, DefError } from '../src/defs.ts';
import { openStore } from '../src/store.ts';
import type { InterfaceCallBinding, WorkflowDef } from '../src/types.ts';
import {
  inspectCasDefs,
  loadCasDefs,
  readWorkflowStoreIndex,
  storeIndexPath,
  workflowCoordinate,
  writeWorkflowStoreIndex,
} from '../src/store/index.ts';
import { makeIo, routedFetch } from './hubkit.ts';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

// ---- fixtures ----------------------------------------------------------------

/**
 * A parent that `calls:` `child` by BARE name — the edge under test.
 *
 * The `calls:` gate is wired to the workflow INPUT `seed`, mirroring
 * examples/workflows/provisioned-delivery.yaml (`proposal: proposal`). That
 * detail is load-bearing, not cosmetic: wiring the gate to `sandbox` instead
 * makes the def genuinely undeliverable, because `provision` can outcome
 * `skip`, and a skipped gate strands `delivered` owed forever —
 * `Engine.maintainCalls` `continue`s on a non-green gate and never spawns the
 * child, while the skip does not cascade onto `delivered` either (a calls:
 * step's `consumes` is `[]`, so `requiredInputs` sees no offender). `modelCheck`
 * reports that as a true deadlock and `installWorkflowBundle` refuses the
 * bundle, so the shape below is the only one that installs.
 *
 * `teardown` consumes `sandbox` so `provision` still has a downstream reader —
 * without it the produced `sandbox` would dangle.
 */
function parentYaml(marker: string): string {
  return `name: parent
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: provision
    consumes: [seed]
    produces: [sandbox]
    body: |
      provision ${marker}
  - name: deliver
    calls: child
    inputs:
      data: seed
    produces: [delivered]
  - name: teardown
    consumes: [delivered, sandbox]
    produces: [torn_down]
    terminal: true
    body: |
      teardown ${marker}
outputs: [delivered]
`;
}

/** The sibling the parent calls. `marker` distinguishes bundle versions. */
function childYaml(marker: string): string {
  return `name: child
inputs:
  - name: data
    seedOwed: true
steps:
  - name: work
    consumes: [data]
    produces: [result]
    terminal: true
    body: |
      child body ${marker}
outputs: [result]
`;
}

function versionedParentYaml(target: string, marker: string): string {
  return `name: caller
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: deliver
    calls: ${target}
    inputs:
      data: seed
    produces: [delivered]
  - name: finish
    consumes: [delivered]
    produces: [done]
    terminal: true
    body: |
      finish ${marker}
outputs: [delivered]
`;
}

const interfaceTarget = 'report/report@1.0.0';
const interfaceClaim = { name: 'research-report', version: '1' } as const;
const interfaceSignature = {
  inputs: [{
    name: 'payload',
    schema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  }],
  outputs: [{
    name: 'result',
    schema: {
      type: 'object',
      properties: { report: { type: 'string' } },
      required: ['report'],
      additionalProperties: false,
    },
  }],
};

function interfaceParentYaml(): string {
  return `name: caller
inputs:
  - name: payload
    seedOwed: true
    schema:
      type: object
      properties:
        message: { type: string }
      required: [message]
      additionalProperties: false
steps:
  - name: deliver
    callsInterface:
      name: research-report
      version: "1"
    inputs:
      payload: payload
    produces: [delivered]
  - name: finish
    consumes: [delivered]
    produces: [done]
    body: finish
outputs: [delivered]
`;
}

function interfaceImplementationYaml(marker: string): string {
  return `name: report
x:
  implements:
    - name: research-report
      version: "1"
inputs:
  - name: payload
    seedOwed: true
    schema:
      type: object
      properties:
        message: { type: string }
      required: [message]
      additionalProperties: false
steps:
  - name: work
    consumes: [payload]
    produces:
      - name: result
        schema:
          type: object
          properties:
            report: { type: string }
          required: [report]
          additionalProperties: false
    body: implementation ${marker}
outputs: [result]
`;
}

async function installInterfaceShadowFixture(): Promise<{
  projectRoot: string;
  globalRoot: string;
  callerDigest: string;
  selectedDigest: string;
  shadowDigest: string;
}> {
  const globalSource = writeBundleSource({
    name: 'report',
    version: '1.0.0',
    workflow: interfaceImplementationYaml('GLOBAL-SELECTED'),
  });
  const selected = await installBundleFixture({ sourceDir: globalSource });
  const projectRoot = tempDir('owenloop-interface-project-');
  const shadowSource = writeBundleSource({
    name: 'report',
    version: '1.0.0',
    workflow: interfaceImplementationYaml('PROJECT-SHADOW'),
  });
  const shadow = await installBundleFixture({ sourceDir: shadowSource, root: projectRoot });
  const callerSource = writeBundleSource({
    name: 'caller',
    version: '1.0.0',
    workflow: interfaceParentYaml(),
  });
  const caller = await installBundleFixture({ sourceDir: callerSource, root: projectRoot });
  return {
    projectRoot,
    globalRoot: selected.root,
    callerDigest: caller.result.digest,
    selectedDigest: selected.result.digest,
    shadowDigest: shadow.result.digest,
  };
}

function interfaceBinding(digest: string): InterfaceCallBinding {
  return {
    interface: { ...interfaceClaim },
    target: interfaceTarget,
    digest,
    signature: structuredClone(interfaceSignature),
  };
}

/**
 * Install one two-workflow bundle (`parent` + `child`) into a fresh PROJECT
 * store root and return the loaded registrations.
 */
async function installPair(args: {
  name: string;
  version: string;
  marker: string;
  root?: string;
  runtimeYaml?: string;
}): Promise<{ root: string; digest: string }> {
  const sourceDir = writeBundleSource({
    name: args.name,
    version: args.version,
    workflow: parentYaml(args.marker),
    ...(args.runtimeYaml === undefined ? {} : { runtimeYaml: args.runtimeYaml }),
    workflows: { child: childYaml(args.marker) },
    defaultWorkflow: 'parent',
  });
  // `writeBundleSource` names the entry workflow file `workflow.yaml` and keys
  // it under the PACKAGE name, so the package must be `parent` for the manifest
  // and the def name to agree (install validates name === key).
  const installed = await installBundleFixture({
    sourceDir,
    ...(args.root === undefined ? {} : { root: args.root }),
  });
  return { root: installed.root, digest: installed.result.digest };
}

async function installVersionedCall(args: {
  marker: string;
  lockDigest?: string;
  root?: string;
}): Promise<{ root: string; childDigest: string; callerDigest: string; target: string }> {
  const target = 'dep/child@1.0.0';
  const childSource = writeBundleSource({
    name: 'child',
    version: '1.0.0',
    workflow: childYaml(args.marker),
  });
  const child = await installBundleFixture({
    sourceDir: childSource,
    ...(args.root === undefined ? {} : { root: args.root }),
  });
  const childIndex = readWorkflowStoreIndex(storeIndexPath(child.root));
  addIndexCoordinate(child.root, target, { ...childIndex.entries['child/child@1.0.0']! });

  const callerSource = writeBundleSource({
    name: 'caller',
    version: '1.0.0',
    workflow: versionedParentYaml(target, args.marker),
    lock: { [target]: args.lockDigest ?? child.result.digest },
  });
  const caller = await installBundleFixture({ sourceDir: callerSource, root: child.root });
  return {
    root: child.root,
    childDigest: child.result.digest,
    callerDigest: caller.result.digest,
    target,
  };
}

/** A global root that exists but holds nothing — never the developer's real home. */
function emptyGlobalRoot(): string {
  const home = tempDir('owenloop-ws6-home-');
  const root = join(home, '.owenloop', 'workflows');
  mkdirSync(root, { recursive: true });
  return root;
}

function load(projectRoot: string | undefined, globalRoot: string, options: { verbose?: boolean } = {}): {
  registrations: ReturnType<typeof loadCasDefs>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const registrations = loadCasDefs({
    ...(projectRoot === undefined ? {} : { projectRoot }),
    globalRoot,
    warn: (line) => warnings.push(line),
		...(options.verbose === undefined ? {} : { verbose: options.verbose }),
  });
  return { registrations, warnings };
}

/** Build the flat def map the CLI would build from a set of registrations. */
function removeInstalledObject(root: string, digest: string): void {
  const objectDir = join(root, 'objects', 'sha256', digest);
  chmodSync(objectDir, 0o755);
  for (const entry of readdirSync(objectDir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodSync(join(objectDir, entry.name), 0o755);
  }
  rmSync(objectDir, { recursive: true, force: true });
}

function addIndexCoordinate(
  root: string,
  coordinate: string,
  entry: { digest: string; pinned: boolean; workflows?: string[] },
): void {
  const path = storeIndexPath(root);
  const index = readWorkflowStoreIndex(path);
  index.entries[workflowCoordinate(parseCoordinateParts(coordinate))] = entry;
  writeWorkflowStoreIndex(path, index);
}

function parseCoordinateParts(coordinate: string): { namespace: string; name: string; version: string } {
  const match = /^([^/]+)\/([^@]+)@(.+)$/u.exec(coordinate);
  if (match === null) throw new Error(`bad fixture coordinate: ${coordinate}`);
  return { namespace: match[1]!, name: match[2]!, version: match[3]! };
}

function defMap(registrations: ReturnType<typeof loadCasDefs>): Map<string, WorkflowDef> {
  const raw = new Map<string, WorkflowDef>();
  for (const r of registrations) raw.set(r.key, r.def);
  return finalizeDefs(raw);
}

function findByBundle(defs: Map<string, WorkflowDef>, name: string, digest: string): WorkflowDef {
  for (const def of defs.values()) {
    if (def.name === name && def.bundleDigest === digest) return def;
  }
  throw new Error(`no def '${name}' from bundle ${digest}`);
}

// ---- loader ------------------------------------------------------------------

test('WS-6 loader: every CAS workflow is registered qualified, carries provenance, and no bare key leaks into the map', async () => {
  const { root, digest } = await installPair({ name: 'parent', version: '1.0.0', marker: 'v1' });
  const { registrations, warnings } = load(root, emptyGlobalRoot());

  assert.deepEqual(warnings, [], 'a clean store produces no warnings');
  assert.deepEqual(
    registrations.filter((r) => r.kind === 'workflow').map((r) => r.key).sort(),
    ['parent/child', 'parent/parent'],
    'both workflows register under <package>/<workflow>',
  );
  assert.equal(
    registrations.find((r) => r.key === 'parent/parent@1.0.0')?.def.name,
    'parent',
    'the full coordinate aliases the explicit default workflow',
  );
  for (const r of registrations) {
    assert.equal(r.bundleDigest, digest, 'provenance carries the canonical BUNDLE digest');
    assert.equal(r.bundlePackage, 'parent');
    assert.equal(r.def.bundleDigest, digest, 'the def itself carries the digest the resolver reads');
    assert.equal(r.def.bundlePackage, 'parent');
		assert.deepEqual(r.def.bundleStoreRoots, [root], 'snapshot writers inherit the canonical store root');
		assert.equal(
			Object.prototype.propertyIsEnumerable.call(r.def, 'bundleStoreRoots'),
			false,
			'live store provenance does not alter hashes or persisted snapshots',
		);
    assert.equal(r.key.includes('/'), true, 'every registered key contains "/"');
  }

  // The BARE name must never be a flat-map key — that is what would let one
  // bundle's `child` be reached from an unrelated def.
  const defs = defMap(registrations);
  assert.equal(defs.has('child'), false, 'a bare CAS name is never a flat-map key');
  assert.equal(defs.has('parent'), false);
});

test('WS-6 loader: a CAS key can never shadow a project-local def (the "/" separator is unforgeable)', async () => {
  const { root } = await installPair({ name: 'parent', version: '1.0.0', marker: 'v1' });
  const { registrations } = load(root, emptyGlobalRoot());

  // A def NAME must match /^[a-z0-9][a-z0-9_-]*$/i, which excludes "/". So no
  // filesystem def can ever occupy a key a CAS registration uses.
  for (const r of registrations) {
    assert.match(r.bare, /^[a-z0-9][a-z0-9_-]*$/i, 'the bare name is a legal def name');
    assert.equal(/^[a-z0-9][a-z0-9_-]*$/i.test(r.key), false, 'the registered key is NOT a legal def name');
  }
});

test('WS-6 loader: a project bundle overrides a different global bundle with the same qualified workflow name', async () => {
  const project = await installPair({ name: 'parent', version: '1.0.0', marker: 'PROJECT' });
  const global = await installPair({ name: 'parent', version: '1.0.0', marker: 'GLOBAL' });
  assert.notEqual(project.digest, global.digest, 'the fixtures must exercise different definitions');

  const { registrations, warnings } = load(project.root, global.root);
  const qualified = registrations.find((r) => r.key === 'parent/parent');
  assert.ok(qualified, 'the normal qualified name is registered');
  assert.equal(qualified.level, 'project');
  assert.equal(qualified.bundleDigest, project.digest, 'project holds the user-facing name');
  assert.match(qualified.def.steps[0]!.body, /PROJECT/);
  const coordinateAlias = registrations.find((registration) => registration.key === 'parent/parent@1.0.0');
  assert.equal(coordinateAlias?.bundleDigest, project.digest, 'the full coordinate also obeys project precedence');

  // `kind` is part of the query, not an afterthought: the shadowed global object
  // also carries a digest-scoped COORDINATE alias whose `bare` is likewise
  // 'parent', and the assertions below are about the WORKFLOW registration.
  const globalScoped = registrations.find(
    (r) => r.bundleDigest === global.digest && r.bare === 'parent' && r.kind === 'workflow',
  );
  assert.ok(globalScoped, 'the shadowed global copy remains available for pinned execution');
  assert.equal(globalScoped.key, `${global.digest}/parent`);
  assert.match(globalScoped.def.steps[0]!.body, /GLOBAL/);
  assert.equal(warnings.length > 0, true, 'the shadowing decision is visible');
});

test('WS-6 executable discovery fails closed on a corrupt project index before a global decoy can win', async () => {
  const project = await installPair({ name: 'parent', version: '1.0.0', marker: 'PROJECT' });
  const global = await installPair({ name: 'parent', version: '1.0.0', marker: 'GLOBAL-DECOY' });
  writeFileSync(storeIndexPath(project.root), '{ this is not json');

  assert.throws(
    () => load(project.root, global.root),
    /corrupt workflow store index/u,
  );
});

test('WS-6 read-only inspection marks a corrupt project index incomplete', async () => {
  const { root } = await installPair({ name: 'parent', version: '1.0.0', marker: 'v1' });
  writeFileSync(storeIndexPath(root), '{ this is not json');
  const warnings: string[] = [];

  const inspected = inspectCasDefs({
    projectRoot: root,
    globalRoot: emptyGlobalRoot(),
    warn: (line) => warnings.push(line),
  });

  assert.equal(inspected.complete, false);
  assert.deepEqual(inspected.registrations, []);
  assert.match(warnings.join('\n'), /incomplete project workflow store/u);
});

test('CLI execution fails before runtime DB or network mutation when the project index is corrupt', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  const projectRoot = join(t.cwd, 'workflows');
  const globalRoot = join(t.home, '.owenloop', 'workflows');
  await installPair({ name: 'parent', version: '1.0.0', marker: 'PROJECT', root: projectRoot });
  await installPair({ name: 'parent', version: '1.0.0', marker: 'GLOBAL-DECOY', root: globalRoot });
  writeFileSync(storeIndexPath(projectRoot), '{ broken');

  const code = await mainAsync(['create', 'parent/parent'], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /corrupt workflow store index/u);
  assert.equal(existsSync(join(t.cwd, '.owenloop', 'state.db')), false);
  assert.equal(calls.length, 0);
});

test('CLI status uses explicitly incomplete tolerant inspection for a corrupt project index', async () => {
  const t = makeIo();
  const projectRoot = join(t.cwd, 'workflows');
  const globalRoot = join(t.home, '.owenloop', 'workflows');
  await installPair({ name: 'parent', version: '1.0.0', marker: 'PROJECT', root: projectRoot });
  await installPair({ name: 'parent', version: '1.0.0', marker: 'GLOBAL-DECOY', root: globalRoot });
  writeFileSync(storeIndexPath(projectRoot), '{ broken');

  const code = await mainAsync(['status', '--all'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')), []);
  assert.match(t.err.join('\n'), /status is incomplete/u);
});

test('CLI status returns a runtime row when tolerant inspection skips its corrupt calls child', async () => {
	const t = makeIo();
	const projectRoot = join(t.cwd, 'workflows');
	const installed = await installVersionedCall({ marker: 'STATUS-PARTIAL', root: projectRoot });

	const createCode = await mainAsync(['create', 'caller/caller@1.0.0'], t.io);
	assert.equal(createCode, 0, t.err.join('\n'));
	const created = JSON.parse(t.out.join('\n')) as { workflow: string };
	t.out.length = 0;
	t.err.length = 0;

	const childPath = join(projectRoot, 'objects', 'sha256', installed.childDigest, 'workflow.yaml');
	chmodSync(childPath, 0o644);
	writeFileSync(childPath, `${readFileSync(childPath, 'utf8')}# corrupt child\n`);

	const statusCode = await mainAsync(['status', '--all'], t.io);

	assert.equal(statusCode, 0, t.err.join('\n'));
	const statuses = JSON.parse(t.out.join('\n')) as Array<Record<string, unknown>>;
	assert.equal(statuses.length, 1);
	assert.equal(statuses[0]?.workflow, created.workflow);
	assert.equal(statuses[0]?.def, 'caller/caller@1.0.0');
	assert.equal('error' in statuses[0]!, false, 'the surviving caller definition remains readable');
	assert.match(t.err.join('\n'), /incomplete project workflow coordinate 'dep\/child@1\.0\.0'/u);
	assert.match(t.err.join('\n'), /status is incomplete because workflow definition discovery skipped corrupt store state/u);
});

test('WS-6 executable discovery fails closed when an indexed object is missing', async () => {
  const { root, digest } = await installPair({ name: 'parent', version: '1.0.0', marker: 'v1' });
  // The store hardens every installed object to 0o444 files inside a 0o555 dir
  // (install.ts `hardenObject`), so the bytes cannot be unlinked until the
  // containing directories are writable again. Restore the write bit top-down,
  // then remove — this simulates an object whose bytes vanished (operator
  // cleanup, a half-restored backup) while `index.json` still lists the digest.
  removeInstalledObject(root, digest);

  assert.throws(
    () => load(root, emptyGlobalRoot()),
    /no verified object directory exists/u,
  );
});

test('WS-6 loader is fail-OPEN: an indexed runtime-incompatible object warns and contributes no definitions', async () => {
  const { root, digest } = await installPair({
    name: 'parent',
    version: '1.0.0',
    marker: 'v1',
    runtimeYaml: 'minVersion: "0.5.0"',
  });
  const objectDir = join(root, 'objects', 'sha256', digest);
  const manifestPath = join(objectDir, 'bundle.yaml');
  chmodSync(objectDir, 0o755);
  chmodSync(manifestPath, 0o644);
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, 'utf8').replace('minVersion: "0.5.0"', 'minVersion: "999.0.0"'),
  );

  const { registrations, warnings } = load(root, emptyGlobalRoot());
  assert.deepEqual(registrations, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /skipping project workflow object/);
  assert.match(warnings[0]!, /requires Owenloop >= 999\.0\.0/);
});

test('WS-6 loader: no store at either root loads nothing and warns nothing (zero drift on the no-CAS path)', () => {
  const { registrations, warnings } = load(tempDir('owenloop-ws6-noproject-'), emptyGlobalRoot());
  assert.deepEqual(registrations, []);
  assert.deepEqual(warnings, []);
});

test('WS-6 genuine project absence falls back to the global coordinate', async () => {
  const global = await installPair({ name: 'parent', version: '1.0.0', marker: 'GLOBAL' });
  const projectRoot = tempDir('owenloop-ws6-absent-project-');

  const { registrations } = load(projectRoot, global.root);
  const alias = registrations.find((registration) => registration.key === 'parent/parent@1.0.0');

  assert.ok(alias);
  assert.equal(alias.level, 'global');
  assert.equal(alias.bundleDigest, global.digest);
});

test('WS-6 missing project bytes fall back only to the exact digest indexed globally', async () => {
  const project = await installPair({ name: 'parent', version: '1.0.0', marker: 'SAME' });
  const global = await installPair({ name: 'parent', version: '1.0.0', marker: 'SAME' });
  assert.equal(project.digest, global.digest, 'fixture stores must index identical bytes');
  removeInstalledObject(project.root, project.digest);

  const { registrations } = load(project.root, global.root);
  const alias = registrations.find((registration) => registration.key === 'parent/parent@1.0.0');

  assert.ok(alias);
  assert.equal(alias.bundleDigest, project.digest);
  assert.equal(alias.level, 'global', 'verified bytes came from the exact-digest global fallback');
	assert.deepEqual(
		alias.def.bundleStoreRoots,
		[global.root, project.root].sort(),
		'the writer locks both the naming project index and the global object store',
	);
});

test('WS-6 a project copy cannot mask missing bytes for the same digest indexed globally', async () => {
	const project = await installPair({ name: 'parent', version: '1.0.0', marker: 'SAME' });
	const global = await installPair({ name: 'parent', version: '1.0.0', marker: 'SAME' });
	assert.equal(project.digest, global.digest, 'fixture stores must index identical bytes');
	removeInstalledObject(global.root, global.digest);

	assert.throws(
		() => load(project.root, global.root),
		/indexed by global coordinate 'parent\/parent@1\.0\.0'.*no verified object directory exists/u,
		'a global index row must prove its own physical copy even when project has the digest',
	);

	const warnings: string[] = [];
	const inspected = inspectCasDefs({
		projectRoot: project.root,
		globalRoot: global.root,
		warn: (line) => warnings.push(line),
	});
	assert.equal(inspected.complete, false);
	assert.ok(
		inspected.registrations.some((registration) => (
			registration.key === 'parent/parent@1.0.0'
			&& registration.bundleDigest === project.digest
			&& registration.level === 'project'
		)),
		'tolerant inspection retains the independently verified project registration',
	);
	assert.match(
		warnings.join('\n'),
		/incomplete global workflow coordinate 'parent\/parent@1\.0\.0'.*no verified object directory exists/u,
	);
});

test('WS-6 a corrupt project object is never masked by a same-coordinate global decoy', async () => {
  const project = await installPair({ name: 'parent', version: '1.0.0', marker: 'PROJECT' });
  const global = await installPair({ name: 'parent', version: '1.0.0', marker: 'GLOBAL-DECOY' });
  const workflowPath = join(project.root, 'objects', 'sha256', project.digest, 'workflow.yaml');
  chmodSync(workflowPath, 0o644);
  writeFileSync(workflowPath, `${readFileSync(workflowPath, 'utf8')}# corruption\n`);

  assert.throws(
    () => load(project.root, global.root),
    /object .*corrupt|digest|integrity/iu,
  );
});

test('versioned coordinate uses the sole workflow as an implicit default', async () => {
  const sourceDir = writeBundleSource({
    name: 'child',
    version: '1.0.0',
    workflow: childYaml('IMPLICIT'),
  });
  const installed = await installBundleFixture({ sourceDir });

  const defs = defMap(load(installed.root, emptyGlobalRoot()).registrations);

  assert.equal(defs.get('child/child@1.0.0')?.name, 'child');
  assert.equal(defs.get('child/child@1.0.0')?.bundleDigest, installed.result.digest);
});

test('versioned coordinate uses an explicit default in a multi-workflow bundle', async () => {
  const sourceDir = writeBundleSource({
    name: 'parent',
    version: '1.0.0',
    workflow: parentYaml('EXPLICIT'),
    workflows: { child: childYaml('EXPLICIT') },
    defaultWorkflow: 'child',
  });
  const installed = await installBundleFixture({ sourceDir });

  const defs = defMap(load(installed.root, emptyGlobalRoot()).registrations);

  assert.equal(defs.get('parent/parent@1.0.0')?.name, 'child');
});

test('versioned coordinate refuses a multi-workflow bundle without a default', async () => {
  const sourceDir = writeBundleSource({
    name: 'parent',
    version: '1.0.0',
    workflow: parentYaml('AMBIGUOUS'),
    workflows: { child: childYaml('AMBIGUOUS') },
  });
  const installed = await installBundleFixture({ sourceDir });

  const { registrations, warnings } = load(installed.root, emptyGlobalRoot());

  assert.equal(registrations.some((registration) => registration.key === 'parent/parent@1.0.0'), false);
  assert.equal(registrations.some((registration) => registration.key === 'parent/parent'), true);
  assert.equal(registrations.some((registration) => registration.key === 'parent/child'), true);
  assert.match(warnings.join('\n'), /multiple workflows and has no default/u);
});

test('multiple namespace coordinates may intentionally alias the same verified digest', async () => {
  const sourceDir = writeBundleSource({
    name: 'child',
    version: '1.0.0',
    workflow: childYaml('ALIASED'),
  });
  const installed = await installBundleFixture({ sourceDir });
  const index = readWorkflowStoreIndex(storeIndexPath(installed.root));
  const original = index.entries['child/child@1.0.0']!;
  addIndexCoordinate(installed.root, 'dep/child@1.0.0', { ...original });

  const { registrations } = load(installed.root, emptyGlobalRoot());
  const defs = defMap(registrations);

  assert.equal(defs.get('child/child@1.0.0')?.bundleDigest, installed.result.digest);
  assert.equal(defs.get('dep/child@1.0.0')?.bundleDigest, installed.result.digest);
  assert.equal(
    registrations.filter((registration) => registration.kind === 'workflow').length,
    1,
    'the object workflows load once while both coordinate aliases remain present',
  );
});

test('coordinate identity must match manifest package name and version', async () => {
  const sourceDir = writeBundleSource({
    name: 'child',
    version: '1.0.0',
    workflow: childYaml('IDENTITY'),
  });
  const installed = await installBundleFixture({ sourceDir });
  const index = readWorkflowStoreIndex(storeIndexPath(installed.root));
  addIndexCoordinate(installed.root, 'dep/wrong@1.0.0', { ...index.entries['child/child@1.0.0']! });

  assert.throws(
    () => load(installed.root, emptyGlobalRoot()),
    /does not match manifest package/u,
  );
});

// ---- acceptance (a): a bare sibling call spawns the PINNED sibling -----------

test('WS-6 (a): a bare calls: resolves to the sibling in the SAME bundle, never a same-named workflow from another bundle', async () => {
  const globalRoot = emptyGlobalRoot();
  const a = await installPair({ name: 'parent', version: '1.0.0', marker: 'A' });
  // A SECOND, unrelated bundle that also exports a workflow named `child`.
  const otherSource = writeBundleSource({
    name: 'other',
    version: '1.0.0',
    workflow: childYaml('OTHER'),
  });
  // Rename so the package's entry workflow is itself named `child`: this is the
  // decoy that a bare-name-keyed resolver would wrongly bind to.
  writeFileSync(join(otherSource, 'bundle.yaml'), [
    'formatVersion: 2',
    'package:',
    '  name: other',
    '  version: 1.0.0',
    'workflows:',
    '  child: "workflow.yaml"',
    'platforms: []',
    'integrity:',
    '  algorithm: sha256',
    '  files: {}',
    'capabilities: {}',
    'lock: {}',
    '',
  ].join('\n'));
  const other = await installBundleFixture({ sourceDir: otherSource, root: a.root });

  const { registrations, warnings } = load(a.root, globalRoot);
  assert.deepEqual(warnings, [], 'two bundles exporting `child` under DIFFERENT packages is not a conflict');
  const defs = defMap(registrations);

  assert.equal(defs.has('parent/child'), true);
  assert.equal(defs.has('other/child'), true);

  const parentDef = findByBundle(defs, 'parent', a.digest);
  const resolved = resolveCallsTarget(defs, 'child', parentDef);
  assert.ok(resolved, 'the bare sibling resolves');
  assert.equal(
    resolved.bundleDigest,
    a.digest,
    'the bare `calls: child` binds to the sibling in the PARENT\'s own bundle',
  );
  assert.notEqual(resolved.bundleDigest, other.result.digest, 'and never to the decoy bundle');
  assert.match(resolved.steps[0]!.body, /child body A/, 'it is the pinned body, not the decoy body');
});

test('WS-6 (a): the two same-named children stay DISTINCT nodes — cycle detection does not fuse them', async () => {
  // Two bundles each exporting `parent` -> calls -> `child`. Keying the cycle
  // walk by the bare edge text would fuse both `child` nodes into one and could
  // report a cycle that does not exist. finalizeDefs must accept this set.
  const a = await installPair({ name: 'parent', version: '1.0.0', marker: 'A' });
  const b = await installPair({ name: 'parent', version: '2.0.0', marker: 'B', root: a.root });
  assert.notEqual(a.digest, b.digest, 'the two installs are different bundle digests');

  const { registrations } = load(a.root, emptyGlobalRoot());
  // finalizeDefs runs the bounded calls-cycle DFS; a false cycle would throw DefError here.
  const defs = defMap(registrations);
  assert.equal(
    new Set([...defs.values()].map((def) => `${def.bundleDigest}/${def.name}`)).size,
    4,
    'both bundles contributed both workflow identities despite coordinate aliases',
  );
});

test('WS-6 (a): a bare calls: naming a NON-sibling still produces the existing "does not exist" error', async () => {
  const { root } = await installPair({ name: 'parent', version: '1.0.0', marker: 'A' });
  const { registrations } = load(root, emptyGlobalRoot());
  const raw = new Map<string, WorkflowDef>();
  for (const r of registrations) if (r.bare !== 'child') raw.set(r.key, r.def);

  assert.throws(
    () => finalizeDefs(raw),
    (e: unknown) =>
      e instanceof DefError && /calls names workflow 'child' which does not exist/.test(e.message),
    'the pre-existing message is preserved, not replaced by a scope-specific one',
  );
});

// ---- acceptance (b): a newer install does not retarget a running parent ------

test('WS-6 (b): installing a NEWER version of the same bundle does not change what a running parent resolves', async () => {
  const globalRoot = emptyGlobalRoot();
  const v1 = await installPair({ name: 'parent', version: '1.0.0', marker: 'V1' });

  // What the parent resolved BEFORE the newer install.
  const before = defMap(load(v1.root, globalRoot).registrations);
  const parentV1Before = findByBundle(before, 'parent', v1.digest);
  const childBefore = resolveCallsTarget(before, 'child', parentV1Before);
  assert.ok(childBefore);
  assert.match(childBefore.steps[0]!.body, /child body V1/);

  // Install a NEWER version of the SAME package into the SAME root.
  const v2 = await installPair({ name: 'parent', version: '2.0.0', marker: 'V2', root: v1.root });
  assert.notEqual(v1.digest, v2.digest);

  const after = load(v1.root, globalRoot);
  const defs = defMap(after.registrations);

  // The v1 parent — the def a running instance is PINNED to (§28) — must still
  // resolve its own v1 sibling. This is the regression the criterion names.
  const parentV1After = findByBundle(defs, 'parent', v1.digest);
  const childAfter = resolveCallsTarget(defs, 'child', parentV1After);
  assert.ok(childAfter, 'the v1 parent still resolves a sibling after the v2 install');
  assert.equal(childAfter.bundleDigest, v1.digest, 'and it is still the v1 sibling');
  assert.match(childAfter.steps[0]!.body, /child body V1/, 'the v1 body, not the v2 body');

  // And the v2 parent independently resolves the v2 sibling.
  const parentV2 = findByBundle(defs, 'parent', v2.digest);
  const childV2 = resolveCallsTarget(defs, 'child', parentV2);
  assert.ok(childV2);
  assert.equal(childV2.bundleDigest, v2.digest);
  assert.match(childV2.steps[0]!.body, /child body V2/);

  // The loser of the qualified-key race stays REACHABLE under a digest-scoped
  // key — dropping it is what would break the pinned parent.
  const workflowKeys = after.registrations
    .filter((registration) => registration.kind === 'workflow')
    .map((registration) => registration.key)
    .sort();
  assert.equal(workflowKeys.length, 4, 'all four workflows are registered');
  assert.equal(new Set(workflowKeys).size, 4, 'under four distinct workflow keys');
});

test('WS-6 (b) end-to-end: an already-running parent spawns the PINNED child body after a newer install', async () => {
  const globalRoot = emptyGlobalRoot();
  const v1 = await installPair({ name: 'parent', version: '1.0.0', marker: 'V1' });

  const dir = tempDir('owenloop-ws6-engine-');
  const store = openStore(join(dir, 'state.db'));
  try {
    // The live def map the engine resolves through — rebuilt from the store on
    // every load, exactly as `openCtx` does.
    let defs = defMap(load(v1.root, globalRoot).registrations);
    const engine = new Engine(store, (name, from) => {
      const d = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
      if (!d) throw new Error(`unknown workflow definition '${name}'`);
      return d;
    });

    const parentKey = [...defs.entries()].find(([, d]) => d.name === 'parent' && d.bundleDigest === v1.digest)![0];
    // Create the instance WITHOUT seeding `seed`. `seed` is the `calls:` gate
    // (see parentYaml), so withholding it holds the gate closed and keeps the
    // child unspawned across the first tick — which is the whole point of this
    // test. Seeding it up front would spawn the child before V2 is installed
    // and make the pin assertion below vacuous; the PRECONDITION guards that.
    const parentWf = engine.createInstance(parentKey);

    engine.tick(parentWf, { deep: false });
    assert.equal(
      store.findChildByParent(parentWf, 'delivered'),
      undefined,
      'PRECONDITION: the child must NOT have spawned yet, or the pin assertion below is vacuous',
    );

    // NOW install a newer version — while the parent is mid-flight and its
    // `calls:` step has not yet spawned.
    const v2 = await installPair({ name: 'parent', version: '2.0.0', marker: 'V2', root: v1.root });
    assert.notEqual(v1.digest, v2.digest);
    defs = defMap(load(v1.root, globalRoot).registrations);

    // Open the gate only now, against the already-running parent.
    engine.provideInput(parentWf, 'seed', { v: 'go' });
    engine.tick(parentWf, { deep: false }); // spawns the child

    const child = store.findChildByParent(parentWf, 'delivered');
    assert.ok(child, 'the parent spawned a child');
    const childRow = store.getWorkflow(child.id)!;
    const pinned = childRow.defSnapshot;
    assert.ok(pinned, 'the child is pinned (§28)');
    assert.equal(
      pinned.bundleDigest,
      v1.digest,
      'the running parent spawned the V1 child even though V2 is now installed',
    );
    assert.match(pinned.steps[0]!.body, /child body V1/, 'the V1 body, not the V2 body');
  } finally {
    store.close();
  }
});

test('explicit versioned calls resolve end-to-end and spawn the lock-pinned child', async () => {
  const installed = await installVersionedCall({ marker: 'VERSIONED' });
  const dir = tempDir('owenloop-versioned-call-');
  const store = openStore(join(dir, 'state.db'));
  try {
    const defs = defMap(load(installed.root, emptyGlobalRoot()).registrations);
    const engine = new Engine(store, (name, from) => {
      const def = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
      if (def === undefined) throw new Error(`unknown workflow definition '${name}'`);
      return def;
    });

    const parent = engine.createInstance('caller/caller@1.0.0', {
      provide: { seed: { ready: true } },
    });
    engine.tick(parent, { deep: false });

    const child = store.findChildByParent(parent, 'delivered');
    assert.ok(child, 'the explicit versioned target spawned');
    assert.equal(store.getWorkflow(child.id)?.defSnapshot?.bundleDigest, installed.childDigest);
  } finally {
    store.close();
  }
});

test('interface binding resolves through its digest-scoped alias despite a project coordinate shadow', async () => {
  const installed = await installInterfaceShadowFixture();
  const defs = defMap(load(installed.projectRoot, installed.globalRoot).registrations);
  assert.equal(defs.get(interfaceTarget)?.bundleDigest, installed.shadowDigest, 'direct coordinate has project precedence');
  assert.equal(
    defs.get(digestScopedCallsTargetKey(installed.selectedDigest, interfaceTarget))?.bundleDigest,
    installed.selectedDigest,
    'the selected global implementation remains addressable by exact digest',
  );

  const store = openStore(join(tempDir('owenloop-interface-shadow-db-'), 'state.db'));
  try {
    const resolutionTransactions: boolean[] = [];
    const engine = new Engine(store, (name, from, digest) => {
      if (digest !== undefined) resolutionTransactions.push(store.db.isTransaction);
      const resolved = digest !== undefined
        ? defs.get(digestScopedCallsTargetKey(digest, name)) ?? defs.get(name)
        : from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
      if (resolved === undefined) throw new Error(`unknown workflow definition '${name}'`);
      return resolved;
    });
    const parent = engine.createInstance('caller/caller@1.0.0', {
      provide: { payload: { message: 'go' } },
      interfaceBindings: [interfaceBinding(installed.selectedDigest)],
    });
    engine.tick(parent, { deep: false });

    const child = store.findChildByParent(parent, 'delivered');
    assert.ok(child);
    assert.equal(child.def, interfaceTarget);
    assert.equal(child.defSnapshot?.bundleDigest, installed.selectedDigest);
    assert.match(child.defSnapshot!.steps[0]!.body, /GLOBAL-SELECTED/u);
    assert.ok(resolutionTransactions.length >= 2, 'binding resolves at start and again before spawn');
    assert.ok(resolutionTransactions.every((inside) => !inside), 'exact target resolution never occurs inside SQLite');
  } finally {
    store.close();
  }
});

test('interface binding adversarial repoint becomes one visible structural refusal with no child', async () => {
  const installed = await installInterfaceShadowFixture();
  const defs = defMap(load(installed.projectRoot, installed.globalRoot).registrations);
  const store = openStore(join(tempDir('owenloop-interface-repoint-db-'), 'state.db'));
  try {
    let repoint = false;
    const resolutionTransactions: boolean[] = [];
    const engine = new Engine(store, (name, from, digest) => {
      if (digest !== undefined) {
        resolutionTransactions.push(store.db.isTransaction);
        if (repoint) return defs.get(name)!;
        const exact = defs.get(digestScopedCallsTargetKey(digest, name));
        if (exact !== undefined) return exact;
      }
      const resolved = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
      if (resolved === undefined) throw new Error(`unknown workflow definition '${name}'`);
      return resolved;
    });
    const binding = interfaceBinding(installed.selectedDigest);
    const parent = engine.createInstance('caller/caller@1.0.0', { interfaceBindings: [binding] });
    repoint = true;
    resolutionTransactions.length = 0;
    engine.provideInput(parent, 'payload', { message: 'open gate' });
    assert.doesNotThrow(() => engine.tick(parent, { deep: false }));

    assert.equal(store.findChildByParent(parent, 'delivered'), undefined);
    const delivered = store.getArtifact(parent, 'delivered')!;
    assert.equal(delivered.acceptance, 'rejected');
    assert.equal(delivered.schemaRejects, 0, 'pin refusals are structural, not schema failures');
    assert.match(delivered.reasons.at(-1)!.text, /interface call 'research-report@1'.*immutable start-time pin check/u);
    assert.deepEqual(store.getWorkflow(parent)?.interfaceBindings, [binding]);
    assert.ok(resolutionTransactions.length > 0);
    assert.ok(resolutionTransactions.every((inside) => !inside), 'adversarial resolution still occurs before BEGIN IMMEDIATE');

    const reasonsBefore = delivered.reasons.length;
    engine.tick(parent, { deep: false });
    assert.equal(store.getArtifact(parent, 'delivered')?.reasons.length, reasonsBefore, 'unchanged gate does not duplicate refusal reasons');
  } finally {
    store.close();
  }
});

test('an already-running explicit-version parent follows its global lock after a project coordinate shadows it', async () => {
	const global = await installVersionedCall({ marker: 'GLOBAL-PINNED' });
	const projectRoot = tempDir('owenloop-versioned-project-shadow-');
	const dir = tempDir('owenloop-versioned-global-parent-');
	const store = openStore(join(dir, 'state.db'));
	try {
		let defs = defMap(load(projectRoot, global.root).registrations);
		const engine = new Engine(store, (name, from) => {
			const def = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
			if (def === undefined) throw new Error(`unknown workflow definition '${name}'`);
			return def;
		});

		const parent = engine.createInstance('caller/caller@1.0.0');
		engine.tick(parent, { deep: false });
		assert.equal(store.findChildByParent(parent, 'delivered'), undefined);

		const projectChildSource = writeBundleSource({
			name: 'child',
			version: '1.0.0',
			workflow: childYaml('PROJECT-SHADOW'),
		});
		const projectChild = await installBundleFixture({
			sourceDir: projectChildSource,
			root: projectRoot,
		});
		const projectIndex = readWorkflowStoreIndex(storeIndexPath(projectRoot));
		addIndexCoordinate(projectRoot, global.target, {
			...projectIndex.entries['child/child@1.0.0']!,
		});
		defs = defMap(load(projectRoot, global.root).registrations);

		assert.equal(
			defs.get(global.target)?.bundleDigest,
			projectChild.result.digest,
			'direct coordinate lookup retains project precedence',
		);
		const parentSnapshot = store.getWorkflow(parent)?.defSnapshot;
		assert.ok(parentSnapshot);
		const resolved = resolveCallsTarget(defs, global.target, parentSnapshot);
		assert.ok(resolved, 'the running parent resolves its lock-pinned coordinate');
		assert.equal(resolved.bundleDigest, global.childDigest);
		assert.match(resolved.steps[0]!.body, /GLOBAL-PINNED/u);

		engine.provideInput(parent, 'seed', { ready: true });
		engine.tick(parent, { deep: false });

		const child = store.findChildByParent(parent, 'delivered');
		assert.ok(child, 'the running parent spawns a child after the project shadow appears');
		const childSnapshot = store.getWorkflow(child.id)?.defSnapshot;
		assert.ok(childSnapshot);
		assert.equal(childSnapshot.bundleDigest, global.childDigest);
		assert.notEqual(childSnapshot.bundleDigest, projectChild.result.digest);
		assert.match(childSnapshot.steps[0]!.body, /GLOBAL-PINNED/u);
	} finally {
		store.close();
	}
});

test('an already-running explicit-version parent stays pinned after a newer child version installs', async () => {
  const installed = await installVersionedCall({ marker: 'V1' });
  const dir = tempDir('owenloop-versioned-running-parent-');
  const store = openStore(join(dir, 'state.db'));
  try {
    let defs = defMap(load(installed.root, emptyGlobalRoot()).registrations);
    const engine = new Engine(store, (name, from) => {
      const def = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
      if (def === undefined) throw new Error(`unknown workflow definition '${name}'`);
      return def;
    });
    const parent = engine.createInstance('caller/caller@1.0.0');
    engine.tick(parent, { deep: false });
    assert.equal(store.findChildByParent(parent, 'delivered'), undefined);

    const childV2Source = writeBundleSource({
      name: 'child',
      version: '2.0.0',
      workflow: childYaml('V2'),
    });
    const childV2 = await installBundleFixture({ sourceDir: childV2Source, root: installed.root });
    const childV2Index = readWorkflowStoreIndex(storeIndexPath(installed.root));
    addIndexCoordinate(installed.root, 'dep/child@2.0.0', {
      ...childV2Index.entries['child/child@2.0.0']!,
    });
    defs = defMap(load(installed.root, emptyGlobalRoot()).registrations);

    engine.provideInput(parent, 'seed', { ready: true });
    engine.tick(parent, { deep: false });

    const child = store.findChildByParent(parent, 'delivered');
    assert.ok(child);
    assert.equal(store.getWorkflow(child.id)?.defSnapshot?.bundleDigest, installed.childDigest);
    assert.notEqual(store.getWorkflow(child.id)?.defSnapshot?.bundleDigest, childV2.result.digest);
  } finally {
    store.close();
  }
});

test('explicit versioned calls with a stale manifest lock are rejected before install commit', async () => {
  const root = tempDir('owenloop-versioned-mismatch-');
  await assert.rejects(
    installVersionedCall({
      marker: 'LOCK-MISMATCH',
      lockDigest: 'f'.repeat(64),
      root,
    }),
    /lock target 'dep\/child@1\.0\.0'.*no longer exactly callable/u,
  );
  const index = readWorkflowStoreIndex(storeIndexPath(root));
  assert.equal(index.entries['caller/caller@1.0.0'], undefined);
  assert.ok(index.entries['dep/child@1.0.0'], 'the already-installed dependency remains unchanged');
});

test('reinstall repairs a locked same-digest bundle after legacy executable-mode loss', async () => {
  const target = 'dep/child@1.0.0';
  const childSource = writeBundleSource({
    name: 'child',
    version: '1.0.0',
    workflow: childYaml('LOCKED-REPAIR'),
  });
  const child = await installBundleFixture({ sourceDir: childSource });
  const childIndex = readWorkflowStoreIndex(storeIndexPath(child.root));
  addIndexCoordinate(child.root, target, { ...childIndex.entries['child/child@1.0.0']! });

  const unrelatedSource = writeBundleSource({
    name: 'unrelated',
    version: '1.0.0',
    workflow: childYaml('UNRELATED').replace('name: child\n', 'name: unrelated\n'),
    files: { 'bin/run.sh': '#!/bin/sh\nprintf "unrelated\\n"\n' },
  });
  chmodSync(join(unrelatedSource, 'bin', 'run.sh'), 0o755);
  const unrelated = await installBundleFixture({ sourceDir: unrelatedSource, root: child.root });

  const callerSource = writeBundleSource({
    name: 'caller',
    version: '1.0.0',
    workflow: versionedParentYaml(target, 'LOCKED-REPAIR'),
    lock: { [target]: child.result.digest },
    files: { 'bin/run.sh': '#!/bin/sh\nprintf "ok\\n"\n' },
  });
  chmodSync(join(callerSource, 'bin', 'run.sh'), 0o755);
  const caller = await installBundleFixture({ sourceDir: callerSource, root: child.root });
  const executable = join(caller.result.objectPath, 'bin', 'run.sh');
  const unrelatedExecutable = join(unrelated.result.objectPath, 'bin', 'run.sh');
  assert.equal(statSync(executable).mode & 0o7777, 0o555);
  const indexBefore = readFileSync(storeIndexPath(child.root));

  chmodSync(executable, 0o444);
  chmodSync(unrelatedExecutable, 0o444);
  assert.throws(
    () => loadCasDefs({ projectRoot: child.root, globalRoot: child.root, warn: () => {} }),
    /canonical bundle digest mismatch|expected hardened store mode/u,
  );

  await assert.rejects(
    installBundleFixture({ sourceDir: callerSource, root: child.root }),
    (error: unknown) => error instanceof Error && error.message.includes(unrelated.result.digest),
    'repair exclusion must not hide an unrelated corrupt indexed object',
  );
  assert.equal(statSync(executable).mode & 0o7777, 0o444, 'failed validation does not start caller repair');

  const unrelatedRepair = await installBundleFixture({ sourceDir: unrelatedSource, root: child.root });
  assert.equal(unrelatedRepair.result.installed, false);
  assert.equal(statSync(unrelatedExecutable).mode & 0o7777, 0o555);

  const repaired = await installBundleFixture({ sourceDir: callerSource, root: child.root });
  assert.equal(repaired.result.installed, false, 'same-digest reinstall takes the repair path');
  assert.equal(statSync(executable).mode & 0o7777, 0o555, 'repair restores the executable bit');
  assert.deepEqual(readFileSync(storeIndexPath(child.root)), indexBefore, 'repair preserves index bytes');
  assert.doesNotThrow(
    () => loadCasDefs({ projectRoot: child.root, globalRoot: child.root, warn: () => {} }),
  );
});

test('locked global same-digest repair preserves project exact-digest fallback', async () => {
  const projectRoot = tempDir('owenloop-locked-global-repair-project-');
  const globalRoot = emptyGlobalRoot();
  const target = 'dep/child@1.0.0';
  const childSource = writeBundleSource({
    name: 'child',
    version: '1.0.0',
    workflow: childYaml('GLOBAL-REPAIR-DEPENDENCY'),
  });
  const child = await installBundleFixture({
    sourceDir: childSource,
    root: globalRoot,
    level: 'global',
    projectRoot,
    globalRoot,
  });
  const globalChildIndex = readWorkflowStoreIndex(storeIndexPath(globalRoot));
  addIndexCoordinate(globalRoot, target, { ...globalChildIndex.entries['child/child@1.0.0']! });

  const callerSource = writeBundleSource({
    name: 'caller',
    version: '1.0.0',
    workflow: versionedParentYaml(target, 'GLOBAL-REPAIR-CALLER'),
    lock: { [target]: child.result.digest },
    files: { 'bin/run.sh': '#!/bin/sh\nprintf "ok\\n"\n' },
  });
  chmodSync(join(callerSource, 'bin', 'run.sh'), 0o755);
  const caller = await installBundleFixture({
    sourceDir: callerSource,
    root: globalRoot,
    level: 'global',
    projectRoot,
    globalRoot,
  });
  const globalIndex = readWorkflowStoreIndex(storeIndexPath(globalRoot));
  addIndexCoordinate(projectRoot, 'caller/caller@1.0.0', {
    ...globalIndex.entries['caller/caller@1.0.0']!,
  });
  const projectIndexBefore = readFileSync(storeIndexPath(projectRoot));
  const globalIndexBefore = readFileSync(storeIndexPath(globalRoot));
  const executable = join(caller.result.objectPath, 'bin', 'run.sh');

  chmodSync(executable, 0o444);
  assert.throws(
    () => loadCasDefs({ projectRoot, globalRoot, warn: () => {} }),
    /canonical bundle digest mismatch|expected hardened store mode/u,
  );

  const repaired = await installBundleFixture({
    sourceDir: callerSource,
    root: globalRoot,
    level: 'global',
    projectRoot,
    globalRoot,
  });
  assert.equal(repaired.result.installed, false, 'same-digest global reinstall takes the repair path');
  assert.equal(statSync(executable).mode & 0o7777, 0o555, 'repair restores the executable bit');
  assert.deepEqual(readFileSync(storeIndexPath(projectRoot)), projectIndexBefore, 'project index stays unchanged');
  assert.deepEqual(readFileSync(storeIndexPath(globalRoot)), globalIndexBefore, 'global index stays unchanged');

  const { registrations } = load(projectRoot, globalRoot);
  const alias = registrations.find((registration) => registration.key === 'caller/caller@1.0.0');
  assert.ok(alias, 'the project index row remains callable through global fallback');
  assert.equal(alias.bundleDigest, caller.result.digest);
  assert.equal(alias.level, 'global');
  assert.deepEqual(
    alias.def.bundleStoreRoots,
    [globalRoot, projectRoot].sort(),
    'the repaired fallback still coordinates the naming and supplying roots',
  );
});

// ---- acceptance (c): a pin mismatch is a visible debt, not a silent run ------

test('WS-6 (c): a bare calls: that resolves OUTSIDE the parent bundle is refused as a visible debt, not run', async () => {
  const globalRoot = emptyGlobalRoot();
  const v1 = await installPair({ name: 'parent', version: '1.0.0', marker: 'V1' });
  const v2 = await installPair({ name: 'parent', version: '2.0.0', marker: 'V2', root: v1.root });

  const dir = tempDir('owenloop-ws6-mismatch-');
  const store = openStore(join(dir, 'state.db'));
  try {
    const defs = defMap(load(v1.root, globalRoot).registrations);
    const parentV1 = findByBundle(defs, 'parent', v1.digest);
    const childV2 = findByBundle(defs, 'child', v2.digest);

    // Simulate exactly the defect the criterion protects against: the resolver
    // hands back the WRONG-bundle child (what a bare-name flat lookup would do
    // after a newer install). The engine must refuse rather than run it.
    const engine = new Engine(store, (name, from) => {
      if (name === 'child' && from !== undefined) return childV2;
      const d = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
      if (!d) throw new Error(`unknown workflow definition '${name}'`);
      return d;
    });

    const parentKey = [...defs.entries()].find(([, d]) => d === parentV1)![0];
    const parentWf = engine.createInstance(parentKey, { provide: { seed: { v: 'go' } } });
    const tick = engine.tick(parentWf, { deep: false });
    const provision = tick.orders.find((o) => o.step === 'provision')!;
    engine.green(parentWf, provision.run, 'sandbox', { env: 'v1' });
    engine.close(parentWf, provision.run);

    engine.tick(parentWf, { deep: false }); // attempts the spawn

    // NO divergent child ran.
    assert.equal(store.findChildByParent(parentWf, 'delivered'), undefined, 'no child was spawned');
    assert.equal(store.listChildrenByParent(parentWf).length, 0, 'no orphan child row');

    // A VISIBLE debt landed on the parent's calls artifact.
    const art = store.getArtifact(parentWf, 'delivered')!;
    assert.equal(art.acceptance, 'rejected', 'the parent calls artifact is rejected');
    const last = art.reasons.at(-1)!;
    assert.equal(last.action, 'reject');
    assert.equal(last.kind, 'structural', 'a pin refusal is structural, not a schema failure');
    assert.equal(last.by, 'engine');
    assert.equal(art.schemaRejects, 0, 'and it does not count against the schema-reject budget');
    assert.match(last.text, /failed its pin check/, 'the reason names the pin check');
    assert.match(last.text, new RegExp(v1.digest), 'and names the bundle the parent was pinned to');
  } finally {
    store.close();
  }
});

test('WS-6 (c): the pin refusal does not crash-loop — a second tick re-stamps nothing new (F2 guard)', async () => {
  const globalRoot = emptyGlobalRoot();
  const v1 = await installPair({ name: 'parent', version: '1.0.0', marker: 'V1' });
  const v2 = await installPair({ name: 'parent', version: '2.0.0', marker: 'V2', root: v1.root });

  const dir = tempDir('owenloop-ws6-loop-');
  const store = openStore(join(dir, 'state.db'));
  try {
    const defs = defMap(load(v1.root, globalRoot).registrations);
    const parentV1 = findByBundle(defs, 'parent', v1.digest);
    const childV2 = findByBundle(defs, 'child', v2.digest);
    const engine = new Engine(store, (name, from) => {
      if (name === 'child' && from !== undefined) return childV2;
      const d = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
      if (!d) throw new Error(`unknown workflow definition '${name}'`);
      return d;
    });

    const parentKey = [...defs.entries()].find(([, d]) => d === parentV1)![0];
    const parentWf = engine.createInstance(parentKey, { provide: { seed: { v: 'go' } } });
    const tick = engine.tick(parentWf, { deep: false });
    const provision = tick.orders.find((o) => o.step === 'provision')!;
    engine.green(parentWf, provision.run, 'sandbox', { env: 'v1' });
    engine.close(parentWf, provision.run);

    engine.tick(parentWf, { deep: false });
    const afterFirst = store.getArtifact(parentWf, 'delivered')!.reasons.length;
    engine.tick(parentWf, { deep: false });
    engine.tick(parentWf, { deep: false });
    const afterThird = store.getArtifact(parentWf, 'delivered')!.reasons.length;

    assert.equal(afterThird, afterFirst, 'the gate fingerprint guard stops the re-attempt loop');
    assert.equal(store.listChildrenByParent(parentWf).length, 0, 'still no child row');
  } finally {
    store.close();
  }
});

test('WS-6 (c): CallsPinError is a distinct error type carrying the target and the violation', () => {
  const err = new CallsPinError('child', 'bundles differ');
  assert.equal(err.name, 'CallsPinError');
  assert.equal(err.target, 'child');
  assert.equal(err.detail, 'bundles differ');
  assert.match(err.message, /calls target 'child' failed its pin check: bundles differ/);
});

// ---- non-regression: nothing changes without CAS provenance ------------------

test('WS-6: a def with NO bundle provenance takes the unchanged flat-map path', () => {
  const plain: WorkflowDef = {
    name: 'plain',
    engine: 1,
    inputs: [],
    steps: [],
  };
  const target: WorkflowDef = {
    name: 'target',
    engine: 1,
    inputs: [],
    steps: [],
  };
  const defs = new Map([['plain', plain], ['target', target]]);

  assert.equal(resolveCallsTarget(defs, 'target', plain), target, 'plain flat lookup');
  assert.equal(resolveCallsTarget(defs, 'missing', plain), undefined, 'a miss is still a miss');
  // A qualified name never falls back to a bare lookup — that fallback is the
  // shadowing this workstream exists to prevent.
  assert.equal(resolveCallsTarget(defs, 'pkg/target', plain), undefined, 'no bare fallback for a qualified key');
});

// ---- deterministic version selection -----------------------------------------

/**
 * Which installed version holds an unqualified `package/workflow` name must be
 * a decision, not a side effect of arrival order.
 *
 * Before this section existed the loader took whichever indexed coordinate it
 * processed FIRST, and it processed them in coordinate-string order — so
 * `parent/parent` silently meant the OLDEST install (`0.1.0` beat `0.1.7`), and
 * `0.1.10` beat `0.1.2` because the comparison was lexicographic. A build that
 * happened to sort by digest instead picked a third answer. Each test below
 * fails against that behavior.
 */

/** Install several versions of the same package into ONE store root. */
async function installVersions(
  versions: readonly string[],
  root?: string,
): Promise<{ root: string; digests: Map<string, string> }> {
  let current = root;
  const digests = new Map<string, string>();
  for (const version of versions) {
    const installed = await installPair({
      name: 'parent',
      version,
      marker: `V${version}`,
      ...(current === undefined ? {} : { root: current }),
    });
    current = installed.root;
    digests.set(version, installed.digest);
  }
  return { root: current as string, digests };
}

/** Rewrite index.json with its coordinate keys in an explicitly chosen order. */
function rewriteIndexKeyOrder(root: string, order: (keys: string[]) => string[]): void {
  const path = storeIndexPath(root);
  const index = readWorkflowStoreIndex(path);
  const reordered: typeof index.entries = {};
  for (const key of order(Object.keys(index.entries))) reordered[key] = index.entries[key]!;
  writeWorkflowStoreIndex(path, { version: 1, entries: reordered });
}

/** The marker body of whichever def holds the unqualified `parent/parent` key. */
function selectedMarker(registrations: ReturnType<typeof loadCasDefs>): string | undefined {
  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');
  return winner?.def.steps[0]!.body.trim();
}

test('version selection: the HIGHEST SemVer holds the unqualified name, not the first coordinate walked', async () => {
  const { root, digests } = await installVersions(['0.1.0', '0.1.1', '0.1.6', '0.1.7']);
  const { registrations } = load(root, emptyGlobalRoot());

  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');
  assert.ok(winner, 'the unqualified name is registered');
  assert.equal(winner.bundleDigest, digests.get('0.1.7'), '0.1.7 is the selected version');
  assert.match(winner.def.steps[0]!.body, /V0\.1\.7/);
  // The pre-fix loader returned 0.1.0 here: coordinate strings sort ascending and
  // the first walked coordinate claimed the name.
  assert.doesNotMatch(winner.def.steps[0]!.body, /V0\.1\.0/, 'the OLDEST version must not win');
});

test('version selection: 0.1.10 outranks 0.1.2 — SemVer precedence, never string order', async () => {
  const { root, digests } = await installVersions(['0.1.2', '0.1.10']);
  const { registrations } = load(root, emptyGlobalRoot());

  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');
  assert.equal(winner?.bundleDigest, digests.get('0.1.10'));
});

test('version selection: a prerelease never outranks its own release', async () => {
  const { root, digests } = await installVersions(['1.0.0-rc.1', '1.0.0']);
  const { registrations } = load(root, emptyGlobalRoot());

  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');
  assert.equal(winner?.bundleDigest, digests.get('1.0.0'));
});

test('version selection: install order, index key order, and digest order do not move the winner', async () => {
  const forward = await installVersions(['0.1.0', '0.1.1', '0.1.6', '0.1.7']);
  const reverse = await installVersions(['0.1.7', '0.1.6', '0.1.1', '0.1.0']);
  const shuffled = await installVersions(['0.1.6', '0.1.0', '0.1.7', '0.1.1']);

  // Digest order is independent of version order by construction: the markers
  // differ per install, so each root's digests sort differently.
  rewriteIndexKeyOrder(forward.root, (keys) => [...keys].reverse());
  rewriteIndexKeyOrder(shuffled.root, (keys) => [...keys].sort());

  for (const installed of [forward, reverse, shuffled]) {
    const { registrations } = load(installed.root, emptyGlobalRoot());
    assert.equal(
      selectedMarker(registrations),
      'provision V0.1.7',
      'every arrival order selects the same version',
    );
  }
});

test('version selection: workflow registration order is sorted by qualified name', async () => {
  // `writeBundleSource` always emits the package's own workflow FIRST, so a
  // package named `parent` carrying an extra workflow named `aaa` produces a
  // manifest whose `workflows:` keys are {parent, aaa} — deliberately not
  // alphabetical. Registration order must not follow that.
  const sourceDir = writeBundleSource({
    name: 'parent',
    version: '1.0.0',
    workflow: parentYaml('MANIFEST-ORDER'),
    workflows: {
      aaa: childYaml('MANIFEST-ORDER').replace('name: child', 'name: aaa'),
      child: childYaml('MANIFEST-ORDER'),
    },
    defaultWorkflow: 'parent',
  });
  const manifest = readFileSync(join(sourceDir, 'bundle.yaml'), 'utf8');
  assert.match(
    manifest,
    /workflows:\n {2}parent:.*\n {2}aaa:/u,
    'fixture must actually list the workflows out of alphabetical order',
  );

  const installed = await installBundleFixture({ sourceDir });
  const { registrations } = load(installed.root, emptyGlobalRoot());

  assert.deepEqual(
    registrations.filter((r) => r.kind === 'workflow').map((r) => r.key),
    ['parent/aaa', 'parent/child', 'parent/parent'],
    'workflow registrations come out sorted by qualified name',
  );
});

test('version selection: default discovery hides detailed notices behind one stable summary', async () => {
  // Two installs of the same versions differing only in the order they were
  // added must produce byte-identical warnings, in the same order, and pick the
  // same winner.
  const ordered = await installVersions(['0.1.0', '0.1.7']);
  const first = load(ordered.root, emptyGlobalRoot());

  const reordered = await installVersions(['0.1.7', '0.1.0']);
  const second = load(reordered.root, emptyGlobalRoot());

  assert.equal(selectedMarker(first.registrations), selectedMarker(second.registrations));
  assert.deepEqual(
    first.registrations.filter((r) => r.kind === 'workflow').map((r) => r.key),
    second.registrations.filter((r) => r.kind === 'workflow').map((r) => r.key),
    'registration order itself is stable, not merely the set of keys',
  );
	  assert.deepEqual(first.warnings, second.warnings, 'summary text and order are identical');
	  assert.deepEqual(first.warnings, [
	    'note: 1 superseded bundle version hidden; --verbose to list them',
	  ]);
	  assert.equal(first.warnings.some((line) => line.startsWith('warning:')), false);
});

test('version selection: verbose restores every detailed shadowing notice in stable order', async () => {
	const { root, digests } = await installVersions(['0.1.0', '0.1.7']);
	const { warnings } = load(root, emptyGlobalRoot(), { verbose: true });
	const oldDigest = digests.get('0.1.0') as string;
	const newDigest = digests.get('0.1.7') as string;
	assert.deepEqual(warnings, [
		`warning: workflow 'parent/child' from project-indexed bundle ${oldDigest} (version 0.1.0) ` +
			`does not hold that name — project-indexed bundle ${newDigest} (version 0.1.7) is the selected ` +
			`version; this copy stays reachable as '${oldDigest}/child'`,
		`warning: workflow 'parent/parent' from project-indexed bundle ${oldDigest} (version 0.1.0) ` +
			`does not hold that name — project-indexed bundle ${newDigest} (version 0.1.7) is the selected ` +
			`version; this copy stays reachable as '${oldDigest}/parent'`,
	]);
});

test('version selection: a project pin whose BYTES came from global still outranks a higher global version', async () => {
  // `resolveObject` lets a project-indexed coordinate whose object directory is
  // missing locally fall through to the SAME digest in the global store. Such an
  // object reports `level: 'global'` for byte provenance, but the PROJECT index
  // is what names it, so it must still compete — and win — as a project pin.
  const pinned = await installVersions(['0.1.0']);
  const pinnedDigest = pinned.digests.get('0.1.0') as string;

  // The global store holds both the pinned digest (so the fallback can find it)
  // and a strictly higher version that must NOT be selected.
  const globalStore = await installPair({ name: 'parent', version: '0.1.0', marker: 'V0.1.0' });
  assert.equal(globalStore.digest, pinnedDigest, 'fixture stores must index identical bytes');
  await installPair({ name: 'parent', version: '0.9.9', marker: 'V0.9.9', root: globalStore.root });

  removeInstalledObject(pinned.root, pinnedDigest);

  const { registrations } = load(pinned.root, globalStore.root);
  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');

  assert.ok(winner, 'the unqualified name is registered');
  assert.equal(winner.bundleDigest, pinnedDigest, 'the project-indexed 0.1.0 pin holds the name');
  assert.match(winner.def.steps[0]!.body, /V0\.1\.0/);
  assert.equal(winner.level, 'global', 'byte provenance is still reported honestly');
});

test('version selection: a project install outranks a HIGHER global version', async () => {
  const project = await installVersions(['0.1.0']);
  const global = await installVersions(['0.1.7']);

  const { registrations } = load(project.root, global.root);
  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');
  assert.equal(winner?.level, 'project', 'the project store stays the deterministic override');
  assert.equal(winner?.bundleDigest, project.digests.get('0.1.0'));
  // The global copy is shadowed for the bare name but never lost.
  const shadowed = registrations.find(
    (r) => r.kind === 'workflow' && r.bare === 'parent'
      && r.bundleDigest === global.digests.get('0.1.7'),
  );
  assert.equal(shadowed?.key, `${global.digests.get('0.1.7')}/parent`);
});

test('version selection: every EXACT coordinate resolves to its own version, whoever holds the bare name', async () => {
  const versions = ['0.1.0', '0.1.1', '0.1.6', '0.1.7'];
  const { root, digests } = await installVersions(versions);
  const { registrations } = load(root, emptyGlobalRoot());

  for (const version of versions) {
    const alias = registrations.find((r) => r.key === `parent/parent@${version}`);
    assert.ok(alias, `coordinate parent/parent@${version} is registered`);
    assert.equal(alias.bundleDigest, digests.get(version), 'the coordinate keeps its own object');
    assert.match(alias.def.steps[0]!.body, new RegExp(`V${version.replace(/\./gu, '\\.')}`));
  }
});

test('version selection: a shadowed version stays reachable by digest for pinned execution', async () => {
  const { root, digests } = await installVersions(['0.1.0', '0.1.7']);
  const { registrations } = load(root, emptyGlobalRoot());
  const oldDigest = digests.get('0.1.0') as string;

  const scopedWorkflow = registrations.find(
    (r) => r.kind === 'workflow' && r.key === `${oldDigest}/parent`,
  );
  assert.ok(scopedWorkflow, 'the shadowed version keeps a digest-scoped workflow key');
  assert.match(scopedWorkflow.def.steps[0]!.body, /V0\.1\.0/);

  const scopedCoordinate = registrations.find(
    (r) => r.kind === 'coordinate' && r.key === `${oldDigest}/parent/parent@0.1.0`,
  );
  assert.ok(scopedCoordinate, 'a pinned parent can still follow its lock digest');
  assert.equal(scopedCoordinate.bundleDigest, oldDigest);
});

test('version selection: the refusal never calls a level-outranked SemVer version non-SemVer', async () => {
  // Project-indexed `nightly` and `edge` refuse the name between themselves. A
  // global `1.0.0` also exists, but it lost on LEVEL and was never judged on its
  // version — the warning must not sweep it into "none of these is SemVer",
  // which would send an operator hunting a defect in a valid version string.
  const project = await installVersions(['nightly', 'edge']);
  const oneGlobal = await installVersions(['1.0.0']);

  const refusalFor = (globalRoot: string): string => {
    const { registrations, warnings } = load(project.root, globalRoot);
    assert.equal(
      registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow'),
      undefined,
      'the unqualified name is still refused',
    );
    const line = warnings.find((warning) => warning.includes("'parent/parent' has no selectable"));
    assert.ok(line, 'the refusal is reported');
    return line;
  };

  const singular = refusalFor(oneGlobal.root);
  // Assert against the competing LIST itself, not the surrounding sentence, so
  // rewording the message cannot silently turn this into a no-op assertion.
  const competingList = /competing versions \(([^)]*)\)/u.exec(singular)?.[1];
  assert.ok(competingList, 'the refusal names the competing versions');
  assert.deepEqual([...competingList.split(', ')].sort(), ['edge', 'nightly']);
  assert.ok(
    !competingList.includes('1.0.0'),
    'the level-outranked SemVer version is not listed among the non-SemVer competitors',
  );
  assert.match(
    singular,
    /1 further global-indexed version never competed/u,
    'the outranked SemVer version is reported separately, with the real reason',
  );

  // A second outranked version must pluralize rather than read "2 further ... version".
  const twoGlobal = await installVersions(['1.0.0', '2.0.0']);
  assert.match(refusalFor(twoGlobal.root), /2 further global-indexed versions never competed/u);
});

test('version selection: several non-SemVer versions fail closed instead of guessing', async () => {
  const { root, digests } = await installVersions(['nightly', 'edge']);
  const { registrations, warnings } = load(root, emptyGlobalRoot());

	  assert.equal(
    registrations.find((r) => r.key === 'parent/parent'),
    undefined,
    'no version may claim the unqualified name when none can be ordered',
	  );
	  assert.equal(warnings.some((line) => line.startsWith('note:')), false, 'actionable warnings are never hidden');
  assert.equal(
    warnings.some((line) => line.includes("workflow 'parent/parent' has no selectable version")),
    true,
    'the refusal is visible, and names the fix',
  );
  for (const version of ['nightly', 'edge']) {
    const digest = digests.get(version) as string;
    assert.ok(
      registrations.find((r) => r.kind === 'workflow' && r.key === `${digest}/parent`),
      `${version} stays reachable by digest`,
    );
    assert.ok(
      registrations.find((r) => r.key === `parent/parent@${version}`),
      `${version} stays reachable by exact coordinate`,
    );
  }
});

test('version selection: a SINGLE non-SemVer version still holds its name', async () => {
	  const { root, digests } = await installVersions(['nightly']);
	  const { registrations, warnings } = load(root, emptyGlobalRoot());

  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');
	  assert.equal(winner?.bundleDigest, digests.get('nightly'), 'nothing to order, so nothing to refuse');
	  assert.deepEqual(warnings, [], 'one version has no hidden-history summary');
});

test('version selection: a SemVer version outranks a non-SemVer one rather than tying', async () => {
  const { root, digests } = await installVersions(['nightly', '0.1.7']);
  const { registrations } = load(root, emptyGlobalRoot());

  const winner = registrations.find((r) => r.key === 'parent/parent' && r.kind === 'workflow');
  assert.equal(winner?.bundleDigest, digests.get('0.1.7'));
});

test('version selection: the shadowing warning names both versions, not just the digests', async () => {
	  const { root, digests } = await installVersions(['0.1.0', '0.1.7']);
	  const { warnings } = load(root, emptyGlobalRoot(), { verbose: true });

  const line = warnings.find((w) => w.includes(digests.get('0.1.0') as string));
  assert.ok(line, 'the shadowed copy is reported');
  assert.match(line, /version 0\.1\.0/u, 'the shadowed version is named');
  assert.match(line, /version 0\.1\.7.*is the selected version/u, 'the winning version is named');
});
