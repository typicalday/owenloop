import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

import { assertLockCoverage, parseManifestBytes, parseVersionedCallTarget } from '../src/bundle/manifest.ts';
import { digestScopedCallsTargetKey, finalizeDefs, resolveCallsTarget } from '../src/defs.ts';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import {
  createBundleIngestor,
  createStoreInstructionSource,
  loadCasDefs,
  planWorkflowStoreGc,
  readWorkflowStoreIndex,
  storeIndexPath,
  writeWorkflowStoreIndex,
} from '../src/store/index.ts';
import { join } from 'node:path';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

const base = 'dep/delivery@1.0.0';
const exact = `${base}#precision-map`;
const child = (name: string, marker: string) => `name: ${name}
inputs:
  - name: data
    seedOwed: true
steps:
  - name: work
    consumes: [data]
    produces: [result]
    terminal: true
    body: ${marker}
outputs: [result]
`;
const parent = (target: string) => `name: caller
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: invoke
    calls: ${target}
    inputs:
      data: seed
    produces: [delivered]
  - name: finish
    consumes: [delivered]
    produces: [done]
    terminal: true
    body: finish
outputs: [delivered]
`;

function alias(root: string, coordinate: string, digest: string): void {
  const index = readWorkflowStoreIndex(storeIndexPath(root));
  index.entries[coordinate] = { digest, pinned: false };
  writeWorkflowStoreIndex(storeIndexPath(root), index);
}

async function installChild(root: string, marker: string, withDefault = true) {
  const installed = await installBundleFixture({
    root,
    sourceDir: writeBundleSource({
      name: 'delivery',
      workflow: child('delivery', `default-${marker}`),
      workflows: { 'precision-map': child('precision-map', `selected-${marker}`) },
      ...(withDefault ? { defaultWorkflow: 'delivery' } : {}),
    }),
  });
  alias(root, base, installed.result.digest);
  return installed;
}

async function installParent(root: string, digest: string, target = exact) {
  return installBundleFixture({
    root,
    sourceDir: writeBundleSource({
      name: 'caller',
      workflow: parent(target),
      lock: { [base]: digest },
      runtimeYaml: 'features:\n  - exact-workflow-selector.v1',
    }),
  });
}

function defs(projectRoot: string, globalRoot: string) {
  return finalizeDefs(new Map(loadCasDefs({ projectRoot, globalRoot, warn: () => {} }).map((r) => [r.key, r.def])));
}

test('named exact call selects the nondefault workflow for coordinator spawn and worker replay', async () => {
  const root = tempDir();
  const global = tempDir();
  const installedChild = await installChild(root, 'A');
  const installedParent = await installParent(root, installedChild.result.digest);
  const definitions = defs(root, global);
  assert.match(definitions.get(base)!.steps[0]!.body, /default-A/);
  assert.match(definitions.get(exact)!.steps[0]!.body, /selected-A/);
  const caller = definitions.get('caller/caller@1.0.0')!;
  assert.match(resolveCallsTarget(definitions, exact, caller)!.steps[0]!.body, /selected-A/);

  const store = openStore(join(tempDir(), 'state.db'));
  try {
    const engine = new Engine(store, (name, from) => {
      const resolved = from === undefined ? definitions.get(name) : resolveCallsTarget(definitions, name, from);
      if (resolved === undefined) throw new Error(`missing ${name}`);
      return resolved;
    });
    const instance = engine.createInstance('caller/caller@1.0.0', { provide: { seed: { go: true } } });
    engine.tick(instance, { deep: false });
    const spawned = store.findChildByParent(instance, 'delivered');
    assert.ok(spawned);
    assert.match(spawned.defSnapshot!.steps[0]!.body, /selected-A/);
    assert.equal(spawned.defSnapshot!.bundleDigest, installedChild.result.digest);
  } finally {
    store.close();
  }

  const source = createStoreInstructionSource({ projectRoot: root, globalRoot: global, verifier: createBundleIngestor() });
  assert.equal(await source.prime(installedParent.result.digest), 'resolved');
  const selected = source.getVerifiedCallsChild!(installedParent.result.digest, 'invoke', 'invoke');
  assert.equal(selected?.definition.name, 'precision-map');
  assert.equal(selected?.bundleDigest, installedChild.result.digest);
});

test('selector works without a default and stays on its global digest under a project shadow', async () => {
  const global = tempDir();
  const project = tempDir();
  const selected = await installChild(global, 'GLOBAL', false);
  const installedParent = await installParent(global, selected.result.digest);
  const shadow = await installChild(project, 'PROJECT', false);
  const definitions = defs(project, global);
  assert.equal(definitions.get(base), undefined);
  assert.equal(definitions.get(exact)?.bundleDigest, shadow.result.digest);
  const caller = definitions.get('caller/caller@1.0.0')!;
  assert.equal(resolveCallsTarget(definitions, exact, caller)?.bundleDigest, selected.result.digest);
  assert.equal(
    resolveCallsTarget(definitions, exact, { ...caller, bundleDigest: undefined, bundleLock: undefined })?.bundleDigest,
    shadow.result.digest,
    'a local unpinned definition follows the direct project coordinate',
  );
  assert.equal(definitions.get(digestScopedCallsTargetKey(selected.result.digest, exact))?.bundleDigest, selected.result.digest);
  const source = createStoreInstructionSource({ projectRoot: project, globalRoot: global, verifier: createBundleIngestor() });
  assert.equal(await source.prime(installedParent.result.digest), 'resolved');
  assert.equal(source.getVerifiedCallsChild!(installedParent.result.digest, 'invoke', 'invoke')?.bundleDigest, selected.result.digest);

  const store = openStore(join(tempDir(), 'state.db'));
  try {
    const engine = new Engine(store, (name) => {
      const resolved = definitions.get(name);
      if (resolved === undefined) throw new Error(`missing ${name}`);
      return resolved;
    });
    const instance = engine.createInstance('caller/caller@1.0.0', { provide: { seed: { go: true } } });
    engine.tick(instance, { deep: false });
    assert.equal(store.findChildByParent(instance, 'delivered'), undefined);
    assert.match(store.getArtifact(instance, 'delivered')!.reasons.at(-1)!.text, /failed its pin check/);
  } finally {
    store.close();
  }
});

test('install refuses missing named workflow or mismatched lock before caller commit', async () => {
  const root = tempDir();
  const selected = await installChild(root, 'A');
  await assert.rejects(installParent(root, selected.result.digest, `${base}#absent`), /no longer exactly callable/);
  await assert.rejects(installParent(root, 'f'.repeat(64)), /no longer exactly callable/);
  assert.equal(readWorkflowStoreIndex(storeIndexPath(root)).entries['caller/caller@1.0.0'], undefined);
});

test('coordinate identity and corrupt child bytes fail closed for selected calls', async () => {
  const root = tempDir();
  const other = await installBundleFixture({
    root,
    sourceDir: writeBundleSource({
      name: 'other',
      workflow: child('other', 'wrong-package'),
      workflows: { 'precision-map': child('precision-map', 'wrong-package') },
    }),
  });
  alias(root, base, other.result.digest);
  await assert.rejects(installParent(root, other.result.digest), /does not match manifest package/);

  const clean = tempDir();
  const installed = await installChild(clean, 'CLEAN');
  const workflowPath = join(installed.result.objectPath, 'precision-map.yaml');
  chmodSync(workflowPath, 0o644);
  writeFileSync(workflowPath, `${readFileSync(workflowPath, 'utf8')}# tampered\n`);
  await assert.rejects(installParent(clean, installed.result.digest), /integrity mismatch|object-corrupt/);
});

test('GC retains an exact selected workflow without a default', async () => {
  const root = tempDir();
  const selected = await installChild(root, 'V1', false);
  await installBundleFixture({
    root,
    sourceDir: writeBundleSource({
      name: 'delivery',
      version: '2.0.0',
      workflow: child('delivery', 'default-V2'),
      workflows: { 'precision-map': child('precision-map', 'selected-V2') },
    }),
  });
  const plan = planWorkflowStoreGc({
    projectRoot: root,
    globalRoot: root,
    level: 'project',
    keep: 1,
    snapshotPins: [],
    exactCalls: [exact],
  });
  assert.equal(plan.report.objects.some((object) => object.digest === selected.result.digest), false);
});

test('selector grammar rejects malformed calls and selector lock keys', () => {
  assert.throws(
    () => assertLockCoverage({ lock: {} } as unknown as Parameters<typeof assertLockCoverage>[0], [exact]),
    /requires a lock entry for 'dep\/delivery@1\.0\.0'/,
  );
  for (const malformed of [`${base}#`, `${base}#bad_name`, `${base}#precision-map#extra`, `${base}#../other`]) {
    assert.throws(() => parseVersionedCallTarget(malformed));
    assert.throws(() => assertLockCoverage({ lock: { [base]: 'a'.repeat(64) } } as unknown as Parameters<typeof assertLockCoverage>[0], [malformed]), /malformed exact/);
  }
  const manifest = `formatVersion: 2\npackage:\n  name: caller\n  version: 1.0.0\nworkflows:\n  caller: workflow.yaml\nplatforms: []\nintegrity:\n  algorithm: sha256\n  files: {}\ncapabilities: {}\nlock:\n  "${exact}": "${'a'.repeat(64)}"\n`;
  assert.throws(() => parseManifestBytes(Buffer.from(manifest)), /lock.*key/);
});
