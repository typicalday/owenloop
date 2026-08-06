import assert from 'node:assert/strict';
import { accessSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createBundleIngestor } from '../../../src/store/index.ts';
import { tempDir } from '../../../test/helpers/store-fixture.ts';
import { createExecLoop } from '../src/exec/loop.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';
import { startHostileHub } from './launch-gate/hostile-hub.ts';
import { installWorkflow, type InstalledWorkflow } from './launch-gate/trust-fixture.ts';

/** The permitted-stall contract: withheld transport progress never degrades to execution. */

const fixtures: InstalledWorkflow[] = [];
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const EXEC = { kind: 'exec' as const, id: 'launch-gate-stall:exec' };
const VERIFIED = () => ({ kind: 'verified' as const, publisherKeyId: 'fixture-publisher', principal: 'fixture' });

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function workflow(command: string): string {
  return `name: launch-gate-stall
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

function order(defDigest: string, run: string): GetOrderResponse {
  const packet: OrderPacket = {
    run,
    workflow: 'wf-launch-gate-stall',
    step: 'builder',
    key: 'builder-key',
    inputs: [],
    outputs: [],
    worker: 'command',
    defDigest,
    consumes: {},
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  return { text: '', workflow: packet.workflow, run, order: packet, lease: { claimed: true } };
}

async function commandFixture(): Promise<{ installed: InstalledWorkflow; marker: string }> {
  const projectRoot = tempDir('owenloop-launch-gate-stall-project-');
  const markerDir = join(projectRoot, 'markers');
  mkdirSync(markerDir, { recursive: true });
  const marker = join(markerDir, 'command-ran.marker');
  const installed = await installWorkflow({
    name: 'launch-gate-stall',
    workflow: workflow(`touch ${marker}; printf "launch-gate-stall\\n"`),
    projectRoot,
  });
  fixtures.push(installed);
  rmSync(marker, { force: true });
  return { installed, marker };
}

async function runCommand(
  installed: InstalledWorkflow,
  response: GetOrderResponse,
  options: { withhold?: readonly ('get_order' | 'heartbeat' | 'release' | 'submit')[] } = {},
): Promise<{ outcome: Awaited<ReturnType<ReturnType<typeof createExecLoop>['run']>>; served: unknown[]; requests: Array<{ path: string; body: unknown }>; errors: string[] }> {
  const errors: string[] = [];
  const hub = await startHostileHub({ order: response, withhold: options.withhold });
  try {
    const resolver = createStoreInstructionResolver({
      projectRoot: installed.projectRoot,
      globalRoot: installed.globalRoot,
      verifier: createBundleIngestor(),
      definitionVerifier: VERIFIED,
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
    return { outcome, served: hub.served, requests: hub.requests, errors };
  } finally {
    await hub.close();
  }
}

function servedWithholding(served: unknown[]): GetOrderResponse {
  const response = served.find((body) =>
    typeof body === 'object' && body !== null && 'lease' in body,
  ) as GetOrderResponse | undefined;
  assert.ok(response !== undefined, 'L2: the fixture must record the withheld response');
  return response;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture.objectPath, 0o755);
    rmSync(fixture.sourceDir, { recursive: true, force: true });
    rmSync(fixture.objectPath, { recursive: true, force: true });
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.globalRoot, { recursive: true, force: true });
  }
});

test('launch gate: a withheld order stalls without spawn, submit, or marker creation', async () => {
  const { installed, marker } = await commandFixture();

  const clean = await runCommand(installed, order(installed.defDigest, 'run-stall-clean'));
  assert.equal(clean.outcome, 'submitted', 'L3: the normal fixture must execute and submit');
  assert.equal(pathExists(marker), true);
  assert.equal(clean.requests.filter((request) => request.path === 'submit').length, 1);
  rmSync(marker, { force: true });

  const stalled = await runCommand(
    installed,
    order(installed.defDigest, 'run-stall-withheld'),
    { withhold: ['get_order'] },
  );
  assert.equal(stalled.outcome, 'lease-lost', 'L1: withheld first contact must produce the named lease-lost outcome');
  assert.equal(pathExists(marker), false, 'the stalled driver must not execute a command');
  assert.equal(stalled.requests.filter((request) => request.path === 'submit').length, 0);
  const withheld = servedWithholding(stalled.served);
  assert.equal(withheld.order, null, 'L2: the empty withheld order response was actually served');
  assert.equal(withheld.lease.claimed, false);
});
