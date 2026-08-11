import assert from 'node:assert/strict';
import { accessSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createBundleIngestor } from '../../../src/store/index.ts';
import { startHostileHub } from './launch-gate/hostile-hub.ts';
import { installWorkflow, type InstalledWorkflow } from './launch-gate/trust-fixture.ts';
import { tempDir } from '../../../test/helpers/store-fixture.ts';
import { createExecLoop } from '../src/exec/loop.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';

const EXEC = { kind: 'exec' as const, id: 'launch-gate-command:worker' };
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const fixtures: InstalledWorkflow[] = [];

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function packet(defDigest: string, command: string, run: string): GetOrderResponse {
  const order: OrderPacket = {
    run,
    workflow: 'wf-launch-gate-command',
    step: 'builder',
    key: 'builder-key',
    inputs: [],
    outputs: [],
    worker: 'command',
    defDigest,
    consumes: {},
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  // This field is deliberately absent from OrderPacket. It is the remote
  // command injection the harness must prove cannot reach the shell.
  (order as unknown as Record<string, unknown>)['command'] = command;
  return { text: '', workflow: order.workflow, run, order, lease: { claimed: true } };
}

function cleanWorkflow(command: string): string {
  return `name: launch-gate-command
inputs: []
steps:
  - name: builder
    produces: [out]
    terminal: true
    executor: command
    command: '${command}'
    body: ""
`;
}

async function commandFixture(): Promise<{
  installed: InstalledWorkflow;
  localMarker: string;
  remoteMarker: string;
}> {
  const projectRoot = tempDir('owenloop-launch-gate-command-project-');
  const markerDir = join(projectRoot, 'launch-gate-markers');
  mkdirSync(markerDir, { recursive: true });
  const localMarker = join(markerDir, 'local.marker');
  const remoteMarker = join(markerDir, 'remote.marker');
  const command = `touch ${localMarker}; printf "launch-gate-local\\n"`;
  const installed = await installWorkflow({
    name: 'launch-gate-command',
    workflow: cleanWorkflow(command),
    projectRoot,
  });
  rmSync(localMarker, { force: true });
  rmSync(remoteMarker, { force: true });
  fixtures.push(installed);
  return { installed, localMarker, remoteMarker };
}

async function runCommand(
  installed: InstalledWorkflow,
  response: GetOrderResponse,
  options: {
    definitionVerifier?: () => { kind: 'verified'; publisherKeyId: string; principal: string };
    defPolicy?: 'enforce' | 'warn' | 'off';
    env?: Record<string, string | undefined>;
    tamper?: (path: string, body: unknown) => unknown;
  } = {},
): Promise<{
  outcome: Awaited<ReturnType<ReturnType<typeof createExecLoop>['run']>>;
  served: unknown[];
  errors: string[];
  requests: Array<{ path: string; body: unknown }>;
}> {
  const errors: string[] = [];
  const hub = await startHostileHub({ order: response, tamper: options.tamper });
  try {
    const resolver = createStoreInstructionResolver({
      projectRoot: installed.projectRoot,
      globalRoot: installed.globalRoot,
      verifier: createBundleIngestor(),
      ...(options.definitionVerifier === undefined ? {} : { definitionVerifier: options.definitionVerifier }),
      ...(options.defPolicy === undefined ? {} : { defPolicy: options.defPolicy }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const loop = createExecLoop({
      hub: createHubClient({ origin: hub.origin, getToken: async () => 'launch-gate-token' }),
      runner: createDefaultRunner(),
      workflow: response.workflow,
      run: response.run,
      holder: EXEC,
      instructions: resolver,
      cwd: installed.projectRoot,
      sleep: realSleep,
      now: () => Date.now(),
      out: () => {},
      err: (line) => errors.push(line),
      heartbeatIntervalMs: 25,
    });
    const outcome = await loop.run();
    return { outcome, served: hub.served, errors, requests: hub.requests };
  } finally {
    await hub.close();
  }
}

const verified = () => ({ kind: 'verified' as const, publisherKeyId: 'fixture-publisher', principal: 'fixture' });

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture.objectPath, 0o755);
    rmSync(fixture.sourceDir, { recursive: true, force: true });
    rmSync(fixture.objectPath, { recursive: true, force: true });
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.globalRoot, { recursive: true, force: true });
  }
});

test('launch gate: an additive remote command field never reaches the shell', async () => {
  const { installed, localMarker, remoteMarker } = await commandFixture();
  const authoredCommand = installed.definition.steps.find((step) => step.name === 'builder')?.command;
  assert.ok(authoredCommand !== undefined && authoredCommand.length > 0, 'L4: injected command source must be non-empty loaded definition content');
  const injectedCommand = `${authoredCommand}; touch ${remoteMarker}; printf "remote-command\\n"`;

  const clean = await runCommand(installed, packet(installed.defDigest, 'ignored', 'run-command-clean'), {
    definitionVerifier: verified,
  });
  assert.equal(clean.outcome, 'submitted', 'positive control must execute and submit');
  assert.equal(pathExists(localMarker), true, 'the installed command reached the shell in the positive control');
  assert.equal(pathExists(remoteMarker), false);
  rmSync(localMarker, { force: true });

  const hostile = await runCommand(
    installed,
    packet(installed.defDigest, injectedCommand, 'run-command-additive'),
    {
      definitionVerifier: verified,
      tamper: (_path, body) => body,
    },
  );
  assert.equal(hostile.outcome, 'submitted');
  assert.equal(pathExists(localMarker), true, 'the clean local command still reached the shell');
  assert.equal(pathExists(remoteMarker), false, 'the remote packet command was never spawned');
  const servedOrder = hostile.served.find((body) =>
    typeof body === 'object' && body !== null && 'order' in body,
  ) as GetOrderResponse | undefined;
  assert.ok(servedOrder !== undefined);
  const servedPacket = servedOrder.order as unknown as Record<string, unknown>;
  assert.equal(servedPacket['command'], injectedCommand, 'L2: injected command was actually delivered');
  const submit = hostile.requests.find((request) => request.path === 'submit');
  assert.ok(submit !== undefined, 'positive execution surface must submit');
  const receipt = submit.body as { value?: { command?: string } };
  assert.equal(receipt.value?.command, installed.definition.steps[0]?.command);
});

test('launch gate: altered definition bytes for a pinned digest refuse before spawn', async () => {
  const { installed, localMarker, remoteMarker } = await commandFixture();
  const cleanCommand = installed.definition.steps.find((step) => step.name === 'builder')?.command;
  assert.ok(cleanCommand !== undefined && cleanCommand.length > 0, 'L4: installed command must be non-empty');
  const alteredCommand = `touch ${remoteMarker}; printf "altered-command\\n"`;

  const clean = await runCommand(installed, packet(installed.defDigest, 'ignored', 'run-command-tamper-clean'), {
    definitionVerifier: verified,
  });
  assert.equal(clean.outcome, 'submitted', 'L3: untampered fixture must execute');
  assert.equal(pathExists(localMarker), true);
  rmSync(localMarker, { force: true });

  chmodSync(installed.objectPath, 0o755);
  chmodSync(join(installed.objectPath, 'workflow.yaml'), 0o644);
  const altered = cleanWorkflow(alteredCommand);
  writeFileSync(join(installed.objectPath, 'workflow.yaml'), altered);

  const hostile = await runCommand(
    installed,
    packet(installed.defDigest, 'ignored', 'run-command-tamper'),
    {
      definitionVerifier: verified,
      tamper: (_path, body) => {
        if (typeof body !== 'object' || body === null || !('order' in body)) return body;
        const response = body as GetOrderResponse;
        const injected = response.order as unknown as Record<string, unknown>;
        injected['defBytes'] = altered;
        return response;
      },
    },
  );
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(
    hostile.errors.some((line) => line.includes('instruction refusal (integrity)')),
    `L1: expected integrity refusal, got ${hostile.errors.join('\n')}`,
  );
  assert.equal(pathExists(remoteMarker), false, 'altered command never reached the shell');
  const servedOrder = hostile.served.find((body) =>
    typeof body === 'object' && body !== null && 'order' in body,
  ) as GetOrderResponse | undefined;
  assert.ok(servedOrder !== undefined);
  const servedPacket = servedOrder.order as unknown as Record<string, unknown>;
  assert.equal(servedPacket['defBytes'], altered, 'L2: altered definition bytes were actually delivered');
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
});

test('launch gate: runtime incompatibility refuses before a command process starts', async () => {
  const { installed, localMarker } = await commandFixture();
  const manifestPath = join(installed.objectPath, 'bundle.yaml');
  chmodSync(installed.objectPath, 0o755);
  chmodSync(manifestPath, 0o644);
  const manifest = readFileSync(manifestPath, 'utf8');
  writeFileSync(
    manifestPath,
    manifest.replace(
      'version: "1.0.0"\nworkflows:',
      'version: "1.0.0"\nruntime:\n  minVersion: "999.0.0"\nworkflows:',
    ),
  );

  const hostile = await runCommand(
    installed,
    packet(installed.defDigest, 'ignored', 'run-command-runtime-incompatible'),
    { definitionVerifier: verified },
  );
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(
    hostile.errors.some((line) => line.includes('instruction refusal (integrity)') && line.includes('requires Owenloop >= 999.0.0')),
    `expected runtime integrity refusal, got ${hostile.errors.join('\n')}`,
  );
  assert.equal(pathExists(localMarker), false, 'the locally authored command process never started');
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
});

test('launch gate: an unverified definition refuses a command order under the normal policy', async () => {
  const { installed, localMarker, remoteMarker } = await commandFixture();
  const clean = await runCommand(installed, packet(installed.defDigest, 'ignored', 'run-command-unverified-clean'), {
    definitionVerifier: verified,
  });
  assert.equal(clean.outcome, 'submitted', 'L3: verified positive control must execute');
  assert.equal(pathExists(localMarker), true);
  rmSync(localMarker, { force: true });

  const hostile = await runCommand(installed, packet(installed.defDigest, 'ignored', 'run-command-unverified'), {
    defPolicy: 'enforce',
    tamper: (_path, body) => body,
  });
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(
    hostile.errors.some((line) => line.includes('instruction refusal (unverified-def)')),
    `L1: expected unverified-def refusal, got ${hostile.errors.join('\n')}`,
  );
  assert.equal(pathExists(remoteMarker), false);
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
  assert.ok(
    hostile.served.some((body) => typeof body === 'object' && body !== null && 'order' in body),
    'L2: the hostile order was served before the refusal',
  );
});

test('launch gate: worker: command refuses an unverified definition even when defPolicy is off', async () => {
  const { installed, localMarker, remoteMarker } = await commandFixture();
  const clean = await runCommand(installed, packet(installed.defDigest, 'ignored', 'run-command-off-clean'), {
    definitionVerifier: verified,
  });
  assert.equal(clean.outcome, 'submitted', 'L3: the same fixture executes when trusted');
  assert.equal(pathExists(localMarker), true);
  rmSync(localMarker, { force: true });

  const hostile = await runCommand(installed, packet(installed.defDigest, 'ignored', 'run-command-off'), {
    defPolicy: 'off',
    env: { OWENLOOP_DEF_POLICY: 'off' },
    tamper: (_path, body) => body,
  });
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(
    hostile.errors.some((line) => line.includes('instruction refusal (unverified-def)')),
    `L1: hard rule must name unverified-def, got ${hostile.errors.join('\n')}`,
  );
  assert.equal(pathExists(remoteMarker), false);
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
  assert.ok(
    hostile.served.some((body) => typeof body === 'object' && body !== null && 'order' in body),
    'L2: the off-policy hostile order was actually served',
  );
});
