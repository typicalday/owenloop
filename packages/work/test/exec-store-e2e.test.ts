import assert from 'node:assert/strict';
import { accessSync, chmodSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { createBundleIngestor } from '../../../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import type { InstructionResolver } from '../src/exec/instructions.ts';
import { createExecLoop } from '../src/exec/loop.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { CommandReceipt } from '../src/exec/receipt.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';

const CWD = tempDir('owenloop-exec-store-e2e-cwd-');
const EXEC = { kind: 'exec' as const, id: 'store-e2e:worker' };
const LOCAL_COMMAND = 'printf "store-run\\n"';
const STORE_WORKFLOW = `name: exec-store-fixture
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: builder
    consumes: [seed]
    produces: [out]
    terminal: true
    executor: command
    command: '${LOCAL_COMMAND}'
    body: ""
`;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface HubReq {
  verb: string;
  body: Record<string, unknown> | undefined;
}

async function startHub(order: GetOrderResponse): Promise<{ origin: string; reqs: HubReq[]; server: Server }> {
  const reqs: HubReq[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const verb = (req.url ?? '').replace(/^\/api\//, '');
      reqs.push({ verb, body: raw === '' ? undefined : JSON.parse(raw) as Record<string, unknown> });
      res.setHeader('content-type', 'application/json');
      if (verb === 'get_order') res.end(JSON.stringify(order));
      else if (verb === 'submit') res.end(JSON.stringify({ text: '', outcome: 'green' }));
      else res.end(JSON.stringify({ text: '' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, reqs, server };
}

function order(defDigest: string, remoteCommand: string): GetOrderResponse {
  const packet = {
    run: 'run1',
    workflow: 'wf1',
    step: 'builder',
    key: 'k',
    inputs: [],
    outputs: [],
    worker: 'command',
    defDigest,
    consumes: {},
    owes: [{ path: 'artifacts/build', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  // Deliberately add an untrusted additive field at runtime. The production
  // resolver must ignore it because the local digest is the only instruction
  // authority.
  (packet as unknown as Record<string, unknown>)['command'] = remoteCommand;
  return { text: '', workflow: 'wf1', run: 'run1', order: packet, lease: { claimed: true } };
}

function makeLoop(origin: string, resolver: InstructionResolver): ReturnType<typeof createExecLoop> {
  return createExecLoop({
    hub: createHubClient({ origin, getToken: async () => 'store-e2e-token' }),
    runner: createDefaultRunner(),
    workflow: 'wf1',
    run: 'run1',
    holder: EXEC,
    instructions: resolver,
    cwd: CWD,
    sleep: realSleep,
    now: () => Date.now(),
    out: () => {},
    err: () => {},
    heartbeatIntervalMs: 25,
  });
}

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

test('exec store e2e: empty store refuses, installed bytes run, and tampering refuses without a child', async () => {
  const projectRoot = join(CWD, 'workflows');
  const sourceDir = writeBundleSource({ name: 'exec-store-fixture', workflow: STORE_WORKFLOW });
  const installed = await installBundleFixture({ sourceDir, root: projectRoot });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const def = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(def !== undefined);
  const requested = defInstructionDigest(def);
  const globalRoot = tempDir('owenloop-exec-store-global-');
  const resolver = createStoreInstructionResolver({
    projectRoot,
    globalRoot,
    verifier: createBundleIngestor(),
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
  });
  const marker = join(CWD, 'remote-command-ran');
  const remoteCommand = `touch ${marker}`;
  const first = await startHub(order(requested, remoteCommand));
  try {
    assert.equal(await makeLoop(first.origin, resolver).run(), 'submitted');
    const submit = first.reqs.find((request) => request.verb === 'submit');
    assert.ok(submit !== undefined);
    const receipt = submit.body?.['value'] as CommandReceipt;
    assert.equal(receipt.command, LOCAL_COMMAND);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.outputHash, `sha256:${createHash('sha256').update('store-run\n').digest('hex')}`);
    assert.equal(first.reqs.filter((request) => request.verb === 'release').length, 0);
    assert.equal(pathExists(marker), false, 'the remote packet command was never spawned');
  } finally {
    first.server.close();
  }

  // A fresh resolver re-verifies the installed object. The old projection digest
  // remains on the packet, so changing workflow.yaml must refuse before spawn.
  chmodSync(installed.result.objectPath, 0o755);
  chmodSync(join(installed.result.objectPath, 'workflow.yaml'), 0o644);
  writeFileSync(join(installed.result.objectPath, 'workflow.yaml'), `${STORE_WORKFLOW}# tampered\n`);
  const tamperedResolver = createStoreInstructionResolver({
    projectRoot,
    globalRoot,
    verifier: createBundleIngestor(),
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
  });
  const second = await startHub(order(requested, remoteCommand));
  try {
    assert.equal(await makeLoop(second.origin, tamperedResolver).run(), 'unresolved-instructions');
    assert.equal(second.reqs.filter((request) => request.verb === 'submit').length, 0);
    assert.equal(second.reqs.filter((request) => request.verb === 'release').length, 1);
  } finally {
    second.server.close();
  }

  const emptyResolver = createStoreInstructionResolver({
    projectRoot: tempDir('owenloop-exec-empty-project-'),
    globalRoot: tempDir('owenloop-exec-empty-global-'),
    verifier: createBundleIngestor(),
  });
  const empty = await startHub(order('a'.repeat(64), remoteCommand));
  try {
    assert.equal(await makeLoop(empty.origin, emptyResolver).run(), 'unresolved-instructions');
    assert.equal(empty.reqs.filter((request) => request.verb === 'submit').length, 0);
    assert.equal(empty.reqs.filter((request) => request.verb === 'release').length, 1);
  } finally {
    empty.server.close();
  }
});

test('exec store e2e: installed bundle scripts run and loose definitions get the absence error', async () => {
  const command = 'node "$OWENLOOP_BUNDLE_DIR/scripts/provision.mjs"';
  const workflow = `name: exec-bundle-assets-fixture
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: builder
    consumes: [seed]
    produces: [out]
    terminal: true
    executor: command
    command: '${command}'
    body: ""
`;
  const sourceDir = writeBundleSource({
    name: 'exec-bundle-assets-fixture',
    workflow,
    files: {
      'scripts/provision.mjs': "process.stdout.write('bundle-script\\n');\n",
    },
  });
  const projectRoot = join(tempDir('owenloop-exec-bundle-project-'), 'workflows');
  const installed = await installBundleFixture({ sourceDir, root: projectRoot });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const def = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(def !== undefined);
  const requested = defInstructionDigest(def);
  const resolver = createStoreInstructionResolver({
    projectRoot,
    globalRoot: tempDir('owenloop-exec-bundle-global-'),
    verifier: createBundleIngestor(),
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
  });

  const bundled = await startHub(order(requested, 'printf "remote command must not run\\n"'));
  try {
    assert.equal(await makeLoop(bundled.origin, resolver).run(), 'submitted');
    const submit = bundled.reqs.find((request) => request.verb === 'submit');
    assert.ok(submit !== undefined);
    const receipt = submit.body?.['value'] as CommandReceipt;
    assert.equal(receipt.command, command);
    assert.equal(receipt.exitCode, 0, receipt.outputTail);
    assert.match(receipt.outputTail, /bundle-script/);
  } finally {
    bundled.server.close();
  }

  const looseCommand = 'if [ -z "${OWENLOOP_BUNDLE_DIR:-}" ]; then printf "this workflow must run from an installed bundle\\n" >&2; exit 64; fi; node "$OWENLOOP_BUNDLE_DIR/scripts/provision.mjs"';
  const looseResolver: InstructionResolver = {
    resolveCommand: async () => ({ ok: true, command: looseCommand }),
    resolveStep: async () => ({ ok: false, kind: 'unknown-step', reason: 'not used' }),
  };
  const savedBundleDir = process.env['OWENLOOP_BUNDLE_DIR'];
  delete process.env['OWENLOOP_BUNDLE_DIR'];
  const loose = await startHub(order('loose-def', 'ignored remote command'));
  try {
    assert.equal(await makeLoop(loose.origin, looseResolver).run(), 'submitted');
    const submit = loose.reqs.find((request) => request.verb === 'submit');
    assert.ok(submit !== undefined);
    const receipt = submit.body?.['value'] as CommandReceipt;
    assert.equal(receipt.exitCode, 64);
    assert.match(receipt.outputTail, /this workflow must run from an installed bundle/);
  } finally {
    loose.server.close();
    if (savedBundleDir === undefined) delete process.env['OWENLOOP_BUNDLE_DIR'];
    else process.env['OWENLOOP_BUNDLE_DIR'] = savedBundleDir;
  }
});
