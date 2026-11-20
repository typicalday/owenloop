import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { packBundle, inspectBundle } from '../src/bundle/index.ts';
import { parseVersionedCallTarget } from '../src/bundle/manifest.ts';
import { finalizeDefs, parseDef, resolveCallsTarget, resolveExactBundleTarget, verifiedBundleDialect } from '../src/defs.ts';
import { Engine } from '../src/engine.ts';
import { createVerifiedBundleLockReader } from '../src/index.ts';
import { openStore } from '../src/store.ts';
import { loadCasDefs } from '../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

const parent = (name = 'routing/parent', call = 'routing/child') => `name: ${name}
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: invoke
    calls: ${call}
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
const child = (name = 'routing/child', body = 'signed-child') => `name: ${name}
inputs:
  - name: data
    seedOwed: true
steps:
  - name: work
    consumes: [data]
    produces: [result]
    terminal: true
    body: ${body}
outputs: [result]
`;

function qualifiedSource(args: { plainParent?: boolean; omitChild?: boolean; otherNamespace?: boolean } = {}): string {
  const root = tempDir('namespaced-bundle-');
  const parentName = args.plainParent ? 'parent' : 'routing/parent';
  const childName = args.otherNamespace ? 'other/child' : 'routing/child';
  const call = args.otherNamespace ? childName : 'routing/child';
  const workflows = [
    `  ${JSON.stringify(parentName)}: "parent.yaml"`,
    ...(args.omitChild ? [] : [`  ${JSON.stringify(childName)}: "child.yaml"`]),
  ];
  writeFileSync(join(root, 'bundle.yaml'), [
    'formatVersion: 2', 'package:', '  name: routing', '  version: 1.0.0',
    'workflows:', ...workflows, `default: ${JSON.stringify(parentName)}`,
    'platforms: []', 'integrity:', '  algorithm: sha256', '  files: {}',
    'capabilities: {}', 'lock: {}', '',
  ].join('\n'));
  writeFileSync(join(root, 'parent.yaml'), parent(parentName, call));
  if (!args.omitChild) writeFileSync(join(root, 'child.yaml'), child(childName));
  return root;
}

function loaded(root: string) {
  return finalizeDefs(new Map(loadCasDefs({ projectRoot: root, globalRoot: tempDir(), warn: () => {} })
    .map(record => [record.key, record.def])));
}

test('signed Hub-qualified manifest keeps authored bytes and resolves exact same-digest sibling', async () => {
  const source = qualifiedSource();
  const packed = packBundle(source);
  assert.equal(inspectBundle(packed.bytes).digest, packed.digest);
  assert.equal(packed.manifest.workflows['routing/parent'], 'parent.yaml');
  assert.equal(packed.manifest.workflows['routing/child'], 'child.yaml');
  assert.equal(readFileSync(join(source, 'parent.yaml'), 'utf8'), parent());
  const root = tempDir();
  const installed = await installBundleFixture({ sourceDir: source, root });
  assert.equal(installed.result.digest, packed.digest);
  const defs = loaded(root);
  const selected = resolveExactBundleTarget(defs, packed.digest, 'routing/parent');
  assert.equal(selected?.name, 'routing/parent');
  assert.equal(selected?.bundleDigest, packed.digest);
  assert.equal(verifiedBundleDialect(defs, packed.digest), 'hub-qualified');
  assert.equal(defs.has('routing/routing/child'), false, 'no three-segment ambient alias');
  assert.equal(resolveExactBundleTarget(defs, packed.digest, 'routing/routing/child'), undefined);
  const sibling = resolveCallsTarget(defs, 'routing/child', selected!);
  assert.equal(sibling?.name, 'routing/child');
  assert.equal(sibling?.bundleDigest, packed.digest);
  assert.equal(resolveExactBundleTarget(defs, packed.digest,
    'routing/routing@1.0.0#routing/child')?.name, 'routing/child');
  const conflicting = new Map(defs);
  conflicting.set('routing/child', { ...sibling!, bundleDigest: 'e'.repeat(64) });
  assert.equal(resolveCallsTarget(conflicting, 'routing/child', selected!)?.bundleDigest, packed.digest,
    'a same-name global alias cannot replace the signed sibling');
  assert.equal(resolveCallsTarget(conflicting, 'routing/pkg@1.0.0', selected!), undefined,
    'a Hub-qualified bundle cannot follow an unpinned versioned alias');
  assert.equal(resolveExactBundleTarget(defs, packed.digest, 'routing/absent'), undefined);
  assert.equal(resolveExactBundleTarget(defs, 'f'.repeat(64), 'routing/parent'), undefined);
  assert.deepEqual(parseVersionedCallTarget('routing/pkg@1.0.0#routing/child'),
    { coordinate: 'routing/pkg@1.0.0', workflow: 'routing/child' });

  const selectedKey = [...defs].find(([, def]) => def === selected)![0];
  const globalRoot = tempDir();
  const store = openStore(join(tempDir(), 'state.db'));
  try {
    const engine = new Engine(store, (name, from) => {
      const def = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from,
		from.bundleDigest === undefined ? undefined : verifiedBundleDialect(defs, from.bundleDigest));
      if (def === undefined) throw new Error(`missing ${name}`);
      return def;
    }, { readVerifiedBundleLock: createVerifiedBundleLockReader({ projectRoot: root, globalRoot }) });
    const instance = engine.createInstance(selectedKey, { provide: { seed: { go: true } } });
    engine.tick(instance, { deep: false });
    const spawned = store.findChildByParent(instance, 'delivered');
    assert.ok(spawned, 'the exact same-digest namespaced child is a real invocation candidate');
    assert.equal(spawned.defSnapshot?.name, 'routing/child');
    assert.equal(spawned.defSnapshot?.bundleDigest, packed.digest);
  } finally { store.close(); }
});

test('Hub dialect plain parent and persisted snapshot refuse incomplete-map global drift', async () => {
  const root = tempDir();
  const signed = await installBundleFixture({ sourceDir: qualifiedSource({ plainParent: true }), root });
  const defs = loaded(root);
  const parentDef = [...defs.values()].find(def => def.bundleDigest === signed.result.digest && def.name === 'parent')!;
  assert.equal(parentDef.bundleDialect, 'hub-qualified');
  const sibling = resolveCallsTarget(defs, 'routing/child', parentDef);
  assert.equal(sibling?.bundleDigest, signed.result.digest);
  const snapshot = JSON.parse(JSON.stringify(parentDef));
  assert.equal(snapshot.bundleDialect, undefined);
  assert.equal(resolveCallsTarget(defs, 'routing/child', snapshot,
    verifiedBundleDialect(defs, signed.result.digest))?.bundleDigest, signed.result.digest);
  const incomplete = new Map([...defs].filter(([, def]) => def.bundleDigest !== signed.result.digest));
  incomplete.set('routing/child', { ...sibling!, bundleDigest: 'f'.repeat(64) });
  assert.equal(verifiedBundleDialect(incomplete, signed.result.digest), undefined);
  assert.equal(resolveCallsTarget(incomplete, 'routing/child', snapshot,
    verifiedBundleDialect(incomplete, signed.result.digest)), undefined);
  assert.equal(resolveExactBundleTarget(incomplete, signed.result.digest, 'routing/child'), undefined);
});

test('ordinary plain bundle source and digest remain unchanged by qualified dialect support', () => {
  const source = writeBundleSource({ name: 'plain', workflow: child('plain', 'plain-body') });
  const first = packBundle(source);
  const second = packBundle(source);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.manifest.workflows.plain, 'workflow.yaml');
  assert.throws(() => parseDef({ name: 'routing/parent', inputs: [], steps: [] }), /name|invalid/i,
    'the standalone definition grammar remains portable');
  const golden = packBundle(join(import.meta.dirname, 'fixtures/bundle/golden-source'));
  const goldenBytes = readFileSync(join(import.meta.dirname, 'fixtures/bundle/golden.wnlp'));
  assert.deepEqual(gunzipSync(golden.bytes), gunzipSync(goldenBytes),
    'plain canonical tar bytes match the published golden fixture from the 6a source');
  assert.equal(golden.digest, '132888c4faf07f2e20f15eb7101d98ee0a80e9d4461375f69bb602b7ac8b9042');
});

test('qualified workflow grammar and signed manifest-to-definition identity refuse malformed names', () => {
  for (const bad of ['routing/child/extra', 'routing/', '/child', 'routing/child.name']) {
    const source = qualifiedSource();
    const manifestPath = join(source, 'bundle.yaml');
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('routing/child', bad));
    assert.throws(() => packBundle(source), /workflow|name|manifest/i, bad);
  }
  const source = qualifiedSource();
  writeFileSync(join(source, 'child.yaml'), child('routing/different'));
  assert.throws(() => packBundle(source), /definition name|workflow|expected/i);
});
