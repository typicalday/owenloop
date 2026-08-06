import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { createBundleIngestor, defDigest } from '../../../src/store/index.ts';
import type { StoreInstructionSource } from '../../../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import type { OriginVerdict } from '../../../src/crypto/verify-origin.ts';
import type { WorkflowDef } from '../../../src/types.ts';
import {
  createStoreInstructionResolver,
  type InstructionRefusal,
} from '../src/exec/instructions.ts';
import type { OrderPacket } from '../src/hub/types.ts';

const WORKFLOW = `name: origin-fixture
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: command-step
    consumes: [seed]
    produces: [command-out]
    terminal: true
    executor: command
    command: 'printf "origin-command\\n"'
    body: ""
  - name: agent-step
    consumes: [seed]
    produces: [agent-out]
    terminal: true
    body: "Do the origin work."
`;

const gitOrigin: OriginVerdict = {
  kind: 'verified',
  source: { kind: 'git', repo: 'https://example.test/repo', commit: 'a'.repeat(40) },
  attesterKeyId: 'SHA256:test',
  principal: 'publisher',
};
const consoleOrigin: OriginVerdict = {
  kind: 'verified',
  source: { kind: 'console', user: 'operator' },
  attesterKeyId: 'SHA256:test',
  principal: 'publisher',
};

interface Fixture {
  defDigest: string;
  projectRoot: string;
  globalRoot: string;
  objectPath: string;
  definition: WorkflowDef;
}

async function fixture(): Promise<Fixture> {
  const sourceDir = writeBundleSource({ name: 'origin-fixture', workflow: WORKFLOW });
  const installed = await installBundleFixture({ sourceDir, root: tempDir('owenloop-origin-project-') });
  const loaded = loadDefFile(`${installed.result.objectPath}/workflow.yaml`);
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  return {
    defDigest: defInstructionDigest(definition),
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-origin-global-'),
    objectPath: installed.result.objectPath,
    definition,
  };
}

function order(defDigest: string, step: 'command-step' | 'agent-step', worker?: 'command'): OrderPacket {
  return {
    run: 'run-origin',
    workflow: 'wf-origin',
    step,
    key: 'key-origin',
    defDigest,
    inputs: [],
    outputs: [],
    ...(worker === undefined ? {} : { worker }),
    consumes: {},
    owes: [],
  };
}

function resolverFor(
  installed: Fixture,
  origin: OriginVerdict,
  options: {
    originPolicy?: 'enforce' | 'warn' | 'off';
    originRules?: Record<string, 'git' | 'console' | 'agent' | 'any'>;
    warn?: string[];
    source?: StoreInstructionSource;
    projectRoot?: string;
    globalRoot?: string;
  } = {},
) {
  return createStoreInstructionResolver({
    projectRoot: options.projectRoot ?? installed.projectRoot,
    globalRoot: options.globalRoot ?? installed.globalRoot,
    verifier: createBundleIngestor(),
    ...(options.source === undefined ? {} : { source: options.source }),
    defPolicy: 'enforce',
    originPolicy: options.originPolicy ?? 'enforce',
    originRules: options.originRules ?? { local: 'git' },
    warn: (line) => options.warn?.push(line),
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: 'SHA256:test', principal: 'publisher' }),
    originVerifier: () => origin,
  });
}

for (const origin of [consoleOrigin, { ...consoleOrigin, source: { kind: 'agent', agent: 'builder', session: 'session-1' } } as OriginVerdict]) {
  test(`execution origin policy refuses weaker provenance: ${origin.kind === 'verified' ? origin.source.kind : 'unknown'}`, async () => {
    const installed = await fixture();
    const result = await resolverFor(installed, origin).resolveStep(order(installed.defDigest, 'agent-step'));
    assert.equal(result.ok, false);
    assert.equal((result as InstructionRefusal).kind, 'origin-policy');
    assert.match((result as InstructionRefusal).reason, /origin-policy/);
  });
}

test('command publication hard rule runs before origin policy resolution', async () => {
  const installed = await fixture();
  let originCalled = false;
  const resolver = createStoreInstructionResolver({
    projectRoot: installed.projectRoot,
    globalRoot: installed.globalRoot,
    verifier: createBundleIngestor(),
    definitionVerifier: () => ({ kind: 'unsigned' }),
    originPolicy: 'off',
    originRules: { 'bad?': 'git' },
    originVerifier: () => {
      originCalled = true;
      return gitOrigin;
    },
  });
  const result = await resolver.resolveCommand(order(installed.defDigest, 'command-step', 'command'));
  assert.equal(result.ok, false);
  assert.equal((result as InstructionRefusal).kind, 'unverified-def');
  assert.equal(originCalled, false);
});

test('same digest under namespaces with equivalent rules deduplicates', async () => {
  const installed = await fixture();
  const globalRoot = installed.globalRoot;
  mkdirSync(globalRoot, { recursive: true });
  const indexPath = join(globalRoot, 'index.json');
  const projectIndex = JSON.parse(readFileSync(join(installed.projectRoot, 'index.json'), 'utf8')) as {
    entries: Record<string, { digest: string; pinned: boolean }>;
  };
  const digest = Object.values(projectIndex.entries)[0]!.digest;
  writeFileSync(indexPath, JSON.stringify({
    version: 1,
    entries: { 'prod/origin-fixture@1.0.0': { digest, pinned: false } },
  }));
  const result = await resolverFor(installed, gitOrigin, {
    originRules: { local: 'git', prod: 'git' },
  }).resolveStep(order(installed.defDigest, 'agent-step'));
  assert.equal(result.ok, true);
});

test('same digest under namespaces with different rules refuses by named ambiguity', async () => {
  const installed = await fixture();
  const globalRoot = installed.globalRoot;
  mkdirSync(globalRoot, { recursive: true });
  const projectIndex = JSON.parse(readFileSync(join(installed.projectRoot, 'index.json'), 'utf8')) as {
    entries: Record<string, { digest: string; pinned: boolean }>;
  };
  const digest = Object.values(projectIndex.entries)[0]!.digest;
  writeFileSync(join(globalRoot, 'index.json'), JSON.stringify({
    version: 1,
    entries: { 'prod/origin-fixture@1.0.0': { digest, pinned: false } },
  }));
  const result = await resolverFor(installed, gitOrigin, {
    originRules: { local: 'git', prod: 'console' },
  }).resolveStep(order(installed.defDigest, 'agent-step'));
  assert.equal(result.ok, false);
  assert.equal((result as InstructionRefusal).kind, 'origin-policy');
  assert.match((result as InstructionRefusal).reason, /different origin rules/);
  assert.match((result as InstructionRefusal).reason, /local/);
  assert.match((result as InstructionRefusal).reason, /prod/);
});

test('digest with no indexed namespace is mode-dependent and never defaults to local', async () => {
  const installed = await fixture();
  const source: StoreInstructionSource = {
    digestOf: () => { throw new Error('not used'); },
    lookup: () => ({ status: 'unknown-digest' }),
    prime: async () => 'resolved',
    getVerifiedStep: () => installed.definition.steps.find((step) => step.name === 'agent-step'),
    getVerifiedDefinition: () => installed.definition,
    getVerifiedObject: () => ({ bundleDigest: defDigest(installed.objectPath.split('/').at(-1)!), objectPath: installed.objectPath }),
  };
  for (const policy of ['enforce', 'warn', 'off'] as const) {
    const warnings: string[] = [];
    const result = await resolverFor(installed, gitOrigin, {
      source,
      projectRoot: tempDir('owenloop-origin-empty-project-'),
      globalRoot: tempDir('owenloop-origin-empty-global-'),
      originPolicy: policy,
      originRules: { local: 'git' },
      warn: warnings,
    }).resolveStep(order(installed.defDigest, 'agent-step'));
    if (policy === 'enforce') {
      assert.equal(result.ok, false);
      assert.equal((result as InstructionRefusal).kind, 'origin-policy');
      assert.match((result as InstructionRefusal).reason, /not indexed under any namespace/);
    } else {
      assert.equal(result.ok, true);
      if (policy === 'warn') assert.equal(warnings.length, 1);
      else assert.deepEqual(warnings, []);
    }
  }
});
