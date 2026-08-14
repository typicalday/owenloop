import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createBundleIngestor } from '../../../src/store/index.ts';
import { tempDir } from '../../../test/helpers/store-fixture.ts';
import { createFakeAdapter } from '../src/harness/fake.ts';
import { register, unregister } from '../src/harness/registry.ts';
import { run as agentRun } from '../src/roles/agent-run.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';
import { startHostileHub } from './launch-gate/hostile-hub.ts';
import { installWorkflow, type InstalledWorkflow } from './launch-gate/trust-fixture.ts';

/**
 * Claim 1 is tested through the agent-run driver, where `args.brief` is the
 * executable prompt surface. The hub is attacker-controlled. The production
 * driver resolves step instructions from the locally verified store, and the
 * production drivers do not consume any remote prompt field.
 */

const fixtures: InstalledWorkflow[] = [];
const homes: string[] = [];
const registeredIds: string[] = [];
const VERIFIED = () => ({ kind: 'verified' as const, publisherKeyId: 'fixture-publisher', principal: 'fixture' });

function agentWorkflow(body: string): string {
  const indented = body.split('\n').map((line) => `      ${line}`).join('\n');
  return `name: launch-gate-instruction
inputs: []
steps:
  - name: builder
    produces: [out]
    terminal: true
    executor: agent
    body: |
${indented}
`;
}

function order(defDigest: string, run: string): GetOrderResponse {
  const packet: OrderPacket = {
    run,
    workflow: 'wf-launch-gate-instruction',
    step: 'builder',
    key: 'builder-key',
    inputs: [],
    outputs: [],
    defDigest,
    consumes: {},
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  return { text: '', workflow: packet.workflow, run, order: packet, lease: { claimed: true } };
}

function useAdapter(id: string) {
  const adapter = createFakeAdapter({ id });
  register(adapter);
  registeredIds.push(id);
  return adapter;
}

function responseWithTerminalAfterFirst(
  mutate: ((path: string, body: unknown) => unknown) | undefined,
): (path: string, body: unknown) => unknown {
  let getOrderCount = 0;
  return (path, body) => {
    const next = mutate?.(path, body) ?? body;
    if (path !== 'get_order') return next;
    getOrderCount += 1;
    if (getOrderCount === 1) return next;
    if (typeof next !== 'object' || next === null) return next;
    const response = next as GetOrderResponse;
    return {
      ...response,
      order: null,
      lease: { claimed: false, outcome: 'ok' },
    } satisfies GetOrderResponse;
  };
}

async function runAgent(
  installed: InstalledWorkflow,
  response: GetOrderResponse,
  mutate?: (path: string, body: unknown) => unknown,
): Promise<{ code: number; calls: ReturnType<typeof useAdapter>['calls']; errors: string[]; served: unknown[] }> {
  const id = `launch-gate-fake-${Math.random().toString(16).slice(2)}`;
  const adapter = useAdapter(id);
  const home = tempDir('owenloop-launch-gate-agent-home-');
  homes.push(home);
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENLOOP_HARNESS: id,
  };
  const errors: string[] = [];
  const hub = await startHostileHub({
    order: response,
    tamper: responseWithTerminalAfterFirst(mutate),
  });
  try {
    const instructions = createStoreInstructionResolver({
      projectRoot: installed.projectRoot,
      globalRoot: installed.globalRoot,
      verifier: createBundleIngestor(),
      definitionVerifier: VERIFIED,
      env,
    });
    const code = await agentRun(
      [
        `${response.workflow}/${response.run}`,
        '--origin', hub.origin,
        '--harness', id,
        '--heartbeat-interval', '25',
        '--confirm-interval', '1',
        '--submit-grace', '100',
      ],
      {
        env,
        hub: createHubClient({ origin: hub.origin, getToken: async () => 'launch-gate-token' }),
        instructions,
        signalHost: {
          on() { return this; },
          exit() {},
        },
        holderId: 'launch-gate-agent:worker',
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

function servedOrder(served: unknown[]): GetOrderResponse {
  const response = served.find((body) =>
    typeof body === 'object' && body !== null && 'order' in body,
  ) as GetOrderResponse | undefined;
  assert.ok(response !== undefined, 'L2: the hostile fixture must serve an order response');
  return response;
}

function loadedStepBody(installed: InstalledWorkflow): string {
  const body = installed.definition.steps.find((step) => step.name === 'builder')?.body;
  assert.ok(typeof body === 'string' && body.length > 0, 'L4: leaked prompt content must come from non-empty loaded definition content');
  return body;
}

afterEach(() => {
  for (const id of registeredIds.splice(0)) unregister(id);
  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture.objectPath, 0o755);
    rmSync(fixture.sourceDir, { recursive: true, force: true });
    rmSync(fixture.objectPath, { recursive: true, force: true });
    rmSync(fixture.projectRoot, { recursive: true, force: true });
    rmSync(fixture.globalRoot, { recursive: true, force: true });
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('launch gate: altered instruction bytes refuse before an agent prompt is rendered', async () => {
  const body = 'Use the locally verified instruction.';
  const projectRoot = tempDir('owenloop-launch-gate-instruction-project-');
  const installed = await installWorkflow({
    name: 'launch-gate-instruction',
    workflow: agentWorkflow(body),
    projectRoot,
  });
  fixtures.push(installed);
  const expectedBody = loadedStepBody(installed);

  const clean = await runAgent(installed, order(installed.defDigest, 'run-instruction-clean'));
  assert.equal(clean.code, 0, 'L3: the untampered fixture must reach the agent surface');
  const cleanStart = clean.calls.find((call) => call.kind === 'start');
  assert.ok(cleanStart !== undefined && cleanStart.kind === 'start');
  // `endsWith`, not `equal`: `renderBrief` prepends engine-authored blocks (the
  // routing line, the submit contract) ahead of the authored body. What this
  // file guards is that the VERIFIED step body is what arrives and nothing from
  // the hub is spliced into it — so the assertion is that the body is present,
  // intact, and last.
  assert.ok(cleanStart.args.brief.endsWith(expectedBody), cleanStart.args.brief);

  const alteredBody = `${body}\nREMOTE SENTINEL ${Math.random().toString(16).slice(2)}`;
  const alteredWorkflow = agentWorkflow(alteredBody);
  chmodSync(installed.objectPath, 0o755);
  chmodSync(join(installed.objectPath, 'workflow.yaml'), 0o644);
  writeFileSync(join(installed.objectPath, 'workflow.yaml'), alteredWorkflow);

  const hostile = await runAgent(
    installed,
    order(installed.defDigest, 'run-instruction-altered'),
    (path, response) => {
      if (path !== 'get_order' || typeof response !== 'object' || response === null || !('order' in response)) return response;
      const packet = response as GetOrderResponse;
      const injected = packet.order as unknown as Record<string, unknown>;
      injected['defBytes'] = alteredWorkflow;
      return packet;
    },
  );
  assert.equal(hostile.code, 1);
  assert.ok(
    hostile.errors.some((line) => line.includes('instruction refusal (integrity)')),
    `L1: expected integrity refusal, got ${hostile.errors.join('\n')}`,
  );
  assert.equal(hostile.calls.some((call) => call.kind === 'start'), false);
  const served = servedOrder(hostile.served);
  assert.equal(
    (served.order as unknown as Record<string, unknown>)['defBytes'],
    alteredWorkflow,
    'L2: altered instruction bytes were actually delivered',
  );
});

test('launch gate: runtime incompatibility refuses before an agent harness or provider starts', async () => {
  const installed = await installWorkflow({
    name: 'launch-gate-instruction',
    workflow: agentWorkflow('Never render this incompatible prompt.'),
    projectRoot: tempDir('owenloop-launch-gate-instruction-project-'),
  });
  fixtures.push(installed);
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

  const hostile = await runAgent(
    installed,
    order(installed.defDigest, 'run-instruction-runtime-incompatible'),
  );
  assert.equal(hostile.code, 1);
  assert.ok(
    hostile.errors.some((line) => line.includes('instruction refusal (integrity)') && line.includes('requires Owenloop >= 999.0.0')),
    `expected runtime integrity refusal, got ${hostile.errors.join('\n')}`,
  );
  assert.equal(hostile.calls.some((call) => call.kind === 'start'), false);
});

test('launch gate: an unknown instruction digest refuses before an agent prompt is rendered', async () => {
  const body = 'Use the locally verified instruction.';
  const installed = await installWorkflow({
    name: 'launch-gate-instruction',
    workflow: agentWorkflow(body),
    projectRoot: tempDir('owenloop-launch-gate-instruction-project-'),
  });
  fixtures.push(installed);

  const clean = await runAgent(installed, order(installed.defDigest, 'run-instruction-unknown-clean'));
  assert.equal(clean.code, 0, 'L3: the untampered fixture must reach the agent surface');
  assert.ok(clean.calls.some((call) => call.kind === 'start'));

  const unknownBytes = `${agentWorkflow(body)}\n# remote bytes`;
  const hostile = await runAgent(
    installed,
    order('sha256:unknown-launch-gate-digest', 'run-instruction-unknown'),
    (path, response) => {
      if (path !== 'get_order' || typeof response !== 'object' || response === null || !('order' in response)) return response;
      const packet = response as GetOrderResponse;
      const injected = packet.order as unknown as Record<string, unknown>;
      injected['defBytes'] = unknownBytes;
      return packet;
    },
  );
  assert.equal(hostile.code, 1);
  assert.ok(
    hostile.errors.some((line) => line.includes('instruction refusal (unknown-digest)')),
    `L1: expected unknown-digest refusal, got ${hostile.errors.join('\n')}`,
  );
  assert.equal(hostile.calls.some((call) => call.kind === 'start'), false);
  const served = servedOrder(hostile.served);
  assert.equal(
    (served.order as unknown as Record<string, unknown>)['defBytes'],
    unknownBytes,
    'L2: bytes for the unknown digest were actually delivered',
  );
});

test('launch gate: a remote prompt field cannot alter the store-verified agent brief', async () => {
  const body = 'Use the locally verified instruction.';
  const installed = await installWorkflow({
    name: 'launch-gate-instruction',
    workflow: agentWorkflow(body),
    projectRoot: tempDir('owenloop-launch-gate-instruction-project-'),
  });
  fixtures.push(installed);
  const expectedBody = loadedStepBody(installed);

  const clean = await runAgent(installed, order(installed.defDigest, 'run-instruction-prompt-clean'));
  assert.equal(clean.code, 0, 'L3: the untampered fixture must reach the agent surface');
  assert.ok(clean.calls.some((call) => call.kind === 'start'));

  const sentinel = `REMOTE PROMPT SENTINEL ${Math.random().toString(16).slice(2)}`;
  const leakedPrompt = `${expectedBody}${sentinel}`;
  const hostile = await runAgent(
    installed,
    order(installed.defDigest, 'run-instruction-prompt'),
    (path, response) => {
      if (path !== 'get_order' || typeof response !== 'object' || response === null || !('order' in response)) return response;
      const packet = response as GetOrderResponse;
      const injected = packet.order as unknown as Record<string, unknown>;
      injected['prompt'] = leakedPrompt;
      return packet;
    },
  );
  assert.equal(hostile.code, 0, 'L1: the reference-mode leak is ignored and the verified step executes');
  const start = hostile.calls.find((call) => call.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  assert.ok(start.args.brief.endsWith(expectedBody), start.args.brief);
  assert.equal(start.args.brief.includes(sentinel), false);
  const served = servedOrder(hostile.served);
  assert.equal(
    (served.order as unknown as Record<string, unknown>)['prompt'],
    leakedPrompt,
    'L2: the real prompt leak was delivered by the hostile hub',
  );
});
