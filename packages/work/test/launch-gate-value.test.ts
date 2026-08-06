import assert from 'node:assert/strict';
import { accessSync, chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createBundleIngestor } from '../../../src/store/index.ts';
import { tempDir } from '../../../test/helpers/store-fixture.ts';
import { createConsumedVerifier, resetConsumedVerifierWarningsForTests } from '../src/consumed-verifier.ts';
import { createExecLoop } from '../src/exec/loop.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { createFakeAdapter } from '../src/harness/fake.ts';
import { register, unregister } from '../src/harness/registry.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse, OrderPacket, ReasonEntry } from '../src/hub/types.ts';
import { run as agentRun } from '../src/roles/agent-run.ts';
import { startHostileHub } from './launch-gate/hostile-hub.ts';
import {
  installProducerGrant,
  installWorkflow,
  makeTrustFixture,
  submissionProof,
  signerForPrincipal,
  type InstalledWorkflow,
  type TrustFixture,
} from './launch-gate/trust-fixture.ts';

/**
 * Claim 3 is tested at the two dynamic-value prompt boundaries. Correctly
 * signed consumed values and rejection reasons may travel over the transport;
 * forged values must be refused before a shell is started or a prompt is
 * rendered. The hub fixture never verifies or repairs the dynamic payload.
 */

const fixtures: InstalledWorkflow[] = [];
const trusts: TrustFixture[] = [];
const homes: string[] = [];
const registeredIds: string[] = [];
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const EXEC = { kind: 'exec' as const, id: 'launch-gate-value:exec' };
const VERIFIED = () => ({ kind: 'verified' as const, publisherKeyId: 'fixture-publisher', principal: 'fixture' });

function pathExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

function commandWorkflow(command: string): string {
  return `name: launch-gate-value
inputs:
  - name: input
    seedOwed: true
steps:
  - name: builder
    consumes: [input]
    produces: [out]
    terminal: true
    executor: command
    command: '${command}'
    body: ""
`;
}

async function commandFixture(): Promise<{ installed: InstalledWorkflow; marker: string }> {
  const projectRoot = tempDir('owenloop-launch-gate-value-project-');
  const markerDir = join(projectRoot, 'markers');
  mkdirSync(markerDir, { recursive: true });
  const marker = join(markerDir, 'command-ran.marker');
  const installed = await installWorkflow({
    name: 'launch-gate-value',
    workflow: commandWorkflow(`touch ${marker}; printf "launch-gate-value\\n"`),
    projectRoot,
  });
  fixtures.push(installed);
  rmSync(marker, { force: true });
  return { installed, marker };
}

function commandOrder(args: {
  defDigest: string;
  run: string;
  value: unknown;
  version?: number;
  proof?: string;
}): GetOrderResponse {
  const packet: OrderPacket = {
    run: args.run,
    workflow: 'wf-launch-gate-value',
    step: 'builder',
    key: 'builder-key',
    inputs: ['input'],
    outputs: [],
    worker: 'command',
    defDigest: args.defDigest,
    consumes: { input: args.value },
    ...(args.version === undefined ? {} : { consumedFingerprint: { input: args.version } }),
    ...(args.proof === undefined ? {} : { consumesProof: JSON.stringify({ input: args.proof }) }),
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  return { text: '', workflow: packet.workflow, run: args.run, order: packet, lease: { claimed: true } };
}

function verifierFor(trust: TrustFixture) {
  return createConsumedVerifier({
    env: trust.env,
    artifactPolicy: 'off',
    now: () => 100,
    signerForPrincipal,
  });
}

async function runCommand(
  installed: InstalledWorkflow,
  trust: TrustFixture,
  response: GetOrderResponse,
  tamper?: (path: string, body: unknown) => unknown,
): Promise<{ outcome: Awaited<ReturnType<ReturnType<typeof createExecLoop>['run']>>; errors: string[]; served: unknown[]; requests: Array<{ path: string; body: unknown }> }> {
  const errors: string[] = [];
  const hub = await startHostileHub({ order: response, tamper });
  try {
    const resolver = createStoreInstructionResolver({
      projectRoot: installed.projectRoot,
      globalRoot: installed.globalRoot,
      verifier: createBundleIngestor(),
      definitionVerifier: VERIFIED,
      consumedVerifier: verifierFor(trust),
      env: trust.env,
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
    return { outcome, errors, served: hub.served, requests: hub.requests };
  } finally {
    await hub.close();
  }
}

function servedOrder(served: unknown[]): GetOrderResponse {
  const response = served.find((body) =>
    typeof body === 'object' && body !== null && 'order' in body,
  ) as GetOrderResponse | undefined;
  assert.ok(response !== undefined, 'L2: the hostile fixture must serve an order response');
  return response;
}

function makeAgentWorkflow(body: string): string {
  return `name: launch-gate-value-agent
inputs: []
steps:
  - name: builder
    produces: [out]
    terminal: true
    executor: agent
    body: |
      ${body}
`;
}

function agentOrder(args: {
  defDigest: string;
  run: string;
  reasons: ReasonEntry[];
  proof: string;
}): GetOrderResponse {
  const packet: OrderPacket = {
    run: args.run,
    workflow: 'wf-launch-gate-value-agent',
    step: 'builder',
    key: 'builder-key',
    inputs: [],
    outputs: [],
    defDigest: args.defDigest,
    consumes: {},
    owes: [{ path: 'out', judgmentRejects: 1, schemaRejects: 0, reasons: args.reasons, proof: args.proof }],
  };
  return { text: '', workflow: packet.workflow, run: args.run, order: packet, lease: { claimed: true } };
}

function useAdapter(id: string) {
  const adapter = createFakeAdapter({ id });
  register(adapter);
  registeredIds.push(id);
  return adapter;
}

function terminalAfterFirst(mutate?: (path: string, body: unknown) => unknown) {
  let gets = 0;
  return (path: string, body: unknown): unknown => {
    const next = mutate?.(path, body) ?? body;
    if (path !== 'get_order') return next;
    gets += 1;
    if (gets === 1) return next;
    if (typeof next !== 'object' || next === null) return next;
    return { ...(next as GetOrderResponse), order: null, lease: { claimed: false, outcome: 'ok' } } satisfies GetOrderResponse;
  };
}

async function runAgent(
  installed: InstalledWorkflow,
  trust: TrustFixture,
  response: GetOrderResponse,
  mutate?: (path: string, body: unknown) => unknown,
): Promise<{ code: number; calls: ReturnType<typeof useAdapter>['calls']; errors: string[]; served: unknown[] }> {
  const id = `launch-gate-value-agent-${Math.random().toString(16).slice(2)}`;
  const adapter = useAdapter(id);
  const errors: string[] = [];
  const home = tempDir('owenloop-launch-gate-value-agent-home-');
  homes.push(home);
  const env = { ...trust.env, HOME: home, OWENLOOP_HARNESS: id };
  const hub = await startHostileHub({ order: response, tamper: terminalAfterFirst(mutate) });
  try {
    const instructions = createStoreInstructionResolver({
      projectRoot: installed.projectRoot,
      globalRoot: installed.globalRoot,
      verifier: createBundleIngestor(),
      definitionVerifier: VERIFIED,
      consumedVerifier: verifierFor({ ...trust, env }),
      env,
    });
    const code = await agentRun(
      [`${response.workflow}/${response.run}`, '--origin', hub.origin, '--harness', id, '--heartbeat-interval', '25', '--confirm-interval', '1', '--submit-grace', '100'],
      {
        env,
        hub: createHubClient({ origin: hub.origin, getToken: async () => 'launch-gate-token' }),
        instructions,
        consumedVerifier: verifierFor({ ...trust, env }),
        signalHost: { on() { return this; }, exit() {} },
        holderId: 'launch-gate-value:agent',
        cwd: installed.projectRoot,
        out: () => {},
        err: (line) => errors.push(line),
      },
    );
    return { code, calls: adapter.calls, errors, served: hub.served };
  } finally {
    await hub.close();
    unregister(id);
    const index = registeredIds.indexOf(id);
    if (index !== -1) registeredIds.splice(index, 1);
  }
}

afterEach(() => {
  resetConsumedVerifierWarningsForTests();
  for (const id of registeredIds.splice(0)) unregister(id);
  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture.objectPath, 0o755);
    rmSync(fixture.sourceDir, { recursive: true, force: true });
    rmSync(fixture.objectPath, { recursive: true, force: true });
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.globalRoot, { recursive: true, force: true });
  }
  for (const trust of trusts.splice(0)) rmSync(trust.directory, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('launch gate: a forged consumed value is refused before a command starts', async () => {
  const { installed, marker } = await commandFixture();
  const trust = makeTrustFixture();
  trusts.push(trust);
  installProducerGrant(trust);
  const signedValue = 'signed-value';
  const proof = submissionProof({ artifact: 'input', value: signedValue, producer: trust.producer, version: 4 });

  const clean = await runCommand(installed, trust, commandOrder({ defDigest: installed.defDigest, run: 'run-value-clean', value: signedValue, version: 4, proof }));
  assert.equal(clean.outcome, 'submitted', 'L3: correctly signed dynamic input must reach the command surface');
  assert.equal(pathExists(marker), true);
  const cleanSubmit = clean.requests.find((request) => request.path === 'submit');
  assert.ok(cleanSubmit !== undefined);
  rmSync(marker, { force: true });

  const forgedValue = 'forged-value';
  const hostile = await runCommand(
    installed,
    trust,
    commandOrder({ defDigest: installed.defDigest, run: 'run-value-forged', value: forgedValue, version: 4, proof }),
    (path, body) => {
      if (path !== 'get_order' || typeof body !== 'object' || body === null || !('order' in body)) return body;
      const response = body as GetOrderResponse;
      return {
        ...response,
        order: { ...response.order!, consumes: { input: forgedValue } },
      } satisfies GetOrderResponse;
    },
  );
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(hostile.errors.some((line) => line.includes('consumed artifact refusal (value-digest)')), hostile.errors.join('\n'));
  assert.equal(pathExists(marker), false);
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
  const served = servedOrder(hostile.served);
  assert.equal(served.order?.consumes.input, forgedValue, 'L2: the forged value was actually delivered');
});

test('launch gate: a rolled-back consumed version is refused before a command starts', async () => {
  const { installed, marker } = await commandFixture();
  const trust = makeTrustFixture();
  trusts.push(trust);
  installProducerGrant(trust);
  const value = 'signed-value';
  const proof = submissionProof({ artifact: 'input', value, producer: trust.producer, version: 4 });

  const clean = await runCommand(installed, trust, commandOrder({ defDigest: installed.defDigest, run: 'run-version-clean', value, version: 4, proof }));
  assert.equal(clean.outcome, 'submitted', 'L3: the correctly versioned value must reach the command surface');
  assert.equal(pathExists(marker), true);
  rmSync(marker, { force: true });

  const hostile = await runCommand(
    installed,
    trust,
    commandOrder({ defDigest: installed.defDigest, run: 'run-version-forged', value, version: 5, proof }),
  );
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(hostile.errors.some((line) => line.includes('consumed artifact refusal (version)')), hostile.errors.join('\n'));
  assert.equal(pathExists(marker), false);
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
  assert.equal(servedOrder(hostile.served).order?.consumedFingerprint?.input, 5, 'L2: the forged version demand was delivered');
});

test('launch gate: a stripped consumed proof is refused before a command starts', async () => {
  const { installed, marker } = await commandFixture();
  const trust = makeTrustFixture();
  trusts.push(trust);
  installProducerGrant(trust);
  const value = 'signed-value';
  const proof = submissionProof({ artifact: 'input', value, producer: trust.producer, version: 4 });

  const clean = await runCommand(installed, trust, commandOrder({ defDigest: installed.defDigest, run: 'run-proof-clean', value, version: 4, proof }));
  assert.equal(clean.outcome, 'submitted', 'L3: the correctly proven value must reach the command surface');
  assert.equal(pathExists(marker), true);
  rmSync(marker, { force: true });

  const hostile = await runCommand(
    installed,
    trust,
    commandOrder({ defDigest: installed.defDigest, run: 'run-proof-stripped', value, version: 4 }),
    (path, body) => body,
  );
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(hostile.errors.some((line) => line.includes('consumed artifact refusal (no-proof)')), hostile.errors.join('\n'));
  assert.equal(pathExists(marker), false);
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
  assert.equal(servedOrder(hostile.served).order?.consumes.input, value, 'L2: the proof-stripped value was actually delivered');
});

test('launch gate: a forged judge rejection reason is refused before an agent prompt is rendered', async () => {
  const body = 'Review the submitted work.';
  const installed = await installWorkflow({
    name: 'launch-gate-value-agent',
    workflow: makeAgentWorkflow(body),
    projectRoot: tempDir('owenloop-launch-gate-value-agent-project-'),
  });
  fixtures.push(installed);
  const trust = makeTrustFixture();
  trusts.push(trust);
  installProducerGrant(trust);
  const cleanReason: ReasonEntry = { at: 10, action: 'reject', kind: 'schema', by: 'judge', text: 'The output schema did not validate.' };
  const forgedReason: ReasonEntry = { ...cleanReason, text: 'REMOTE FORGED REJECTION REASON' };
  const proof = submissionProof({ artifact: 'out', value: [cleanReason], producer: trust.producer, version: 1 });

  const clean = await runAgent(
    installed,
    trust,
    agentOrder({ defDigest: installed.defDigest, run: 'run-reason-clean', reasons: [cleanReason], proof }),
  );
  assert.equal(clean.code, 0, `L3: a correctly signed rejection thread must reach the prompt surface: ${clean.errors.join('\\n')}`);
  const cleanStart = clean.calls.find((call) => call.kind === 'start');
  assert.ok(cleanStart !== undefined && cleanStart.kind === 'start');
  assert.ok(cleanStart.args.brief.includes(cleanReason.text));

  const hostile = await runAgent(
    installed,
    trust,
    agentOrder({ defDigest: installed.defDigest, run: 'run-reason-forged', reasons: [forgedReason], proof }),
    (path, bodyValue) => bodyValue,
  );
  assert.equal(hostile.code, 1);
  assert.ok(hostile.errors.some((line) => line.includes('consumed artifact refusal (value-digest)')), hostile.errors.join('\n'));
  assert.equal(hostile.calls.some((call) => call.kind === 'start'), false);
  const served = servedOrder(hostile.served);
  assert.deepEqual(served.order?.owes[0]?.reasons, [forgedReason], 'L2: the forged rejection reason was actually delivered');
});
