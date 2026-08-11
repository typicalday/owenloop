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
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Engine, CallsPinError } from '../src/engine.ts';
import { finalizeDefs, resolveCallsTarget, DefError } from '../src/defs.ts';
import { openStore } from '../src/store.ts';
import type { WorkflowDef } from '../src/types.ts';
import { loadCasDefs, storeIndexPath } from '../src/store/index.ts';
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
    registrations.map((r) => r.key).sort(),
    ['parent/child', 'parent/parent'],
    'both workflows register under <package>/<workflow>',
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

test('WS-6 loader is fail-OPEN: a corrupt index warns and is skipped, it does not throw', async () => {
  const { root } = await installPair({ name: 'parent', version: '1.0.0', marker: 'v1' });
  writeFileSync(storeIndexPath(root), '{ this is not json');

  const { registrations, warnings } = load(root, emptyGlobalRoot());
  assert.deepEqual(registrations, [], 'nothing loads from a corrupt index');
  assert.equal(warnings.length, 1, 'exactly one warning');
  assert.match(warnings[0]!, /skipping project workflow store index/);
});

test('WS-6 loader is fail-OPEN: an indexed object whose bytes are gone warns and is skipped', async () => {
  const { root, digest } = await installPair({ name: 'parent', version: '1.0.0', marker: 'v1' });
  // The store hardens every installed object to 0o444 files inside a 0o555 dir
  // (install.ts `hardenObject`), so the bytes cannot be unlinked until the
  // containing directories are writable again. Restore the write bit top-down,
  // then remove — this simulates an object whose bytes vanished (operator
  // cleanup, a half-restored backup) while `index.json` still lists the digest.
  const objectDir = join(root, 'objects', 'sha256', digest);
  chmodSync(objectDir, 0o755);
  for (const entry of readdirSync(objectDir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodSync(join(objectDir, entry.name), 0o755);
  }
  rmSync(objectDir, { recursive: true, force: true });

  const { registrations, warnings } = load(root, emptyGlobalRoot());
  assert.deepEqual(registrations, [], 'the missing object contributes nothing');
  assert.deepEqual(warnings, [], 'an absent object at one level is not an error — the other root may hold it');
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
  assert.equal(defs.size, 4, 'both bundles contributed both workflows');
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
  const keys = after.registrations.map((r) => r.key).sort();
  assert.equal(keys.length, 4, 'all four workflows are registered');
  assert.equal(new Set(keys).size, 4, 'under four distinct keys');
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
