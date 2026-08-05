import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { defInstructionDigest } from '../src/order-resolver.ts';
import { finalizeDefs, loadDefFile } from '../src/defs.ts';
import {
  createBundleIngestor,
  createStoreInstructionSource,
  StoreIntegrityError,
  StoreInstructionSourceError,
} from '../src/store/index.ts';
import { createStoreInstructionResolver } from '../packages/work/src/exec/instructions.ts';
import type { OrderPacket } from '../packages/work/src/hub/types.ts';
import { installBundleFixture, tempDir, writeBundleSource } from './helpers/store-fixture.ts';

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
