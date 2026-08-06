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
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';
import { installProducerGrant, installRevocation, installWorkflow, makeTrustFixture, submissionProof, signerForPrincipal, type InstalledWorkflow, type TrustFixture } from './launch-gate/trust-fixture.ts';
import { startHostileHub } from './launch-gate/hostile-hub.ts';

/**
 * Claim 4 is split deliberately. The introduced-key and revoked-key cases run
 * through the production command driver. The widened-grant case below is
 * VERIFIER-LEVEL ONLY: packages/work/src/roles/exec.ts, agent-run.ts, and
 * hold.ts construct createConsumedVerifier without a demand, while
 * src/crypto/scope.ts checks only explicitly supplied demand axes. This test
 * pins the explicit-demand verifier behavior and does not claim driver-level
 * scope containment.
 */

const fixtures: InstalledWorkflow[] = [];
const trusts: TrustFixture[] = [];
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const EXEC = { kind: 'exec' as const, id: 'launch-gate-signer:exec' };
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
  return `name: launch-gate-signer
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
  const projectRoot = tempDir('owenloop-launch-gate-signer-project-');
  const markerDir = join(projectRoot, 'markers');
  mkdirSync(markerDir, { recursive: true });
  const marker = join(markerDir, 'command-ran.marker');
  const installed = await installWorkflow({
    name: 'launch-gate-signer',
    workflow: workflow(`touch ${marker}; printf "launch-gate-signer\\n"`),
    projectRoot,
  });
  fixtures.push(installed);
  rmSync(marker, { force: true });
  return { installed, marker };
}

function order(args: {
  defDigest: string;
  run: string;
  value: unknown;
  proof: string;
}): GetOrderResponse {
  const packet: OrderPacket = {
    run: args.run,
    workflow: 'wf-launch-gate-signer',
    step: 'builder',
    key: 'builder-key',
    inputs: ['input'],
    outputs: [],
    worker: 'command',
    defDigest: args.defDigest,
    consumes: { input: args.value },
    consumedFingerprint: { input: 1 },
    consumesProof: JSON.stringify({ input: args.proof }),
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

afterEach(() => {
  resetConsumedVerifierWarningsForTests();
  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture.objectPath, 0o755);
    rmSync(fixture.sourceDir, { recursive: true, force: true });
    rmSync(fixture.objectPath, { recursive: true, force: true });
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.globalRoot, { recursive: true, force: true });
  }
  for (const trust of trusts.splice(0)) rmSync(trust.directory, { recursive: true, force: true });
});

test('launch gate: an un-enrolled signer cannot deliver a consumed value to the shell', async () => {
  const { installed, marker } = await commandFixture();
  const trust = makeTrustFixture();
  trusts.push(trust);
  installProducerGrant(trust);
  const value = 'signed-by-enrolled-producer';
  const cleanProof = submissionProof({ artifact: 'input', value, producer: trust.producer, version: 1 });

  const clean = await runCommand(installed, trust, order({ defDigest: installed.defDigest, run: 'run-signer-clean', value, proof: cleanProof }));
  assert.equal(clean.outcome, 'submitted', 'L3: the enrolled producer value must reach the command surface');
  assert.equal(pathExists(marker), true);
  rmSync(marker, { force: true });

  const introducedProof = submissionProof({ artifact: 'input', value, producer: trust.alternate, version: 1 });
  const hostile = await runCommand(
    installed,
    trust,
    order({ defDigest: installed.defDigest, run: 'run-signer-introduced', value, proof: introducedProof }),
  );
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(hostile.errors.some((line) => line.includes('consumed artifact refusal (chain)')), hostile.errors.join('\n'));
  assert.equal(pathExists(marker), false);
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
  const served = servedOrder(hostile.served);
  assert.equal(
    served.order?.consumesProof,
    JSON.stringify({ input: introducedProof }),
    'L2: the proof naming the introduced signer was actually delivered',
  );
});

test('launch gate: a revoked signer cannot deliver a consumed value to the shell', async () => {
  const { installed, marker } = await commandFixture();
  const trust = makeTrustFixture();
  trusts.push(trust);
  installProducerGrant(trust);
  const value = 'signed-by-producer';
  const proof = submissionProof({ artifact: 'input', value, producer: trust.producer, version: 1 });

  const clean = await runCommand(installed, trust, order({ defDigest: installed.defDigest, run: 'run-revocation-clean', value, proof }));
  assert.equal(clean.outcome, 'submitted', 'L3: the enrolled producer value must reach the command surface before revocation');
  assert.equal(pathExists(marker), true);
  rmSync(marker, { force: true });

  installRevocation(trust, { revoked: trust.producer, effectiveFrom: 50 });
  const hostile = await runCommand(
    installed,
    trust,
    order({ defDigest: installed.defDigest, run: 'run-revoked-signer', value, proof }),
  );
  assert.equal(hostile.outcome, 'unresolved-instructions');
  assert.ok(hostile.errors.some((line) => line.includes('consumed artifact refusal (chain)')), hostile.errors.join('\n'));
  assert.equal(pathExists(marker), false);
  assert.equal(hostile.requests.filter((request) => request.path === 'submit').length, 0);
  const served = servedOrder(hostile.served);
  assert.equal(
    served.order?.consumesProof,
    JSON.stringify({ input: proof }),
    'L2: the proof naming the revoked signer was actually delivered',
  );
});

test('scope narrowing refuses a widened grant — VERIFIER-LEVEL: production drivers pass no demand, so this is not end-to-end', async () => {
  const trust = makeTrustFixture();
  trusts.push(trust);
  installProducerGrant(trust, {
    pools: ['allowed-pool'],
    labels: ['allowed-label'],
    namespaces: ['allowed-namespace'],
    delegation: { allowed: false },
  });
  const value = 'scope-tested-value';
  const proof = submissionProof({ artifact: 'input', value, producer: trust.producer, version: 1 });
  const packet = order({ defDigest: 'scope-test', run: 'run-scope', value, proof }).order!;

  const verifier = createConsumedVerifier({
    env: trust.env,
    artifactPolicy: 'off',
    demand: { pool: 'required-pool', label: 'required-label', namespace: 'required-namespace' },
    now: () => 100,
    signerForPrincipal,
  });
  const refused = await verifier(packet, { hardRule: true });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.reason, /consumed artifact refusal \(scope\)/, 'L1: explicit demand must name scope refusal');

  const permittedVerifier = createConsumedVerifier({
    env: trust.env,
    artifactPolicy: 'off',
    demand: { pool: 'allowed-pool', label: 'allowed-label', namespace: 'allowed-namespace' },
    now: () => 100,
    signerForPrincipal,
  });
  const permitted = await permittedVerifier(packet, { hardRule: true });
  assert.equal(permitted.ok, true, 'L3: the same verifier admits a value inside the grant scope');
});
