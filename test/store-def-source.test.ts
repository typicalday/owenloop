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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { mainAsync } from '../src/cli.ts';
import { Engine, CallsPinError } from '../src/engine.ts';
import { finalizeDefs, resolveCallsTarget, DefError } from '../src/defs.ts';
import { openStore } from '../src/store.ts';
import type { WorkflowDef } from '../src/types.ts';
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

/**
 * Install one two-workflow bundle (`parent` + `child`) into a fresh PROJECT
 * store root and return the loaded registrations.
 */
async function installPair(args: {
  name: string;
  version: string;
  marker: string;
  root?: string;
}): Promise<{ root: string; digest: string }> {
  const sourceDir = writeBundleSource({
    name: args.name,
    version: args.version,
    workflow: parentYaml(args.marker),
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

function load(projectRoot: string | undefined, globalRoot: string): {
  registrations: ReturnType<typeof loadCasDefs>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const registrations = loadCasDefs({
    ...(projectRoot === undefined ? {} : { projectRoot }),
    globalRoot,
    warn: (line) => warnings.push(line),
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

  const globalScoped = registrations.find(
    (r) => r.bundleDigest === global.digest && r.bare === 'parent',
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
  // finalizeDefs runs detectCallsCycles; a false cycle would throw DefError here.
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

test('explicit versioned calls enforce the manifest lock before child creation', async () => {
  const installed = await installVersionedCall({
    marker: 'LOCK-MISMATCH',
    lockDigest: 'f'.repeat(64),
  });
  const dir = tempDir('owenloop-versioned-mismatch-');
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

    assert.equal(store.findChildByParent(parent, 'delivered'), undefined, 'no mismatched child is created');
    assert.match(
      store.getArtifact(parent, 'delivered')?.reasons.at(-1)?.text ?? '',
      /parent bundle pins .* but the resolved definition comes from/u,
    );
  } finally {
    store.close();
  }
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
