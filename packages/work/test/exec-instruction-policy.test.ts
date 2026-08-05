import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { createBundleIngestor } from '../../../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import type { DefPolicy, DefVerdict } from '../../../src/crypto/verify-publication.ts';
import {
  createStoreInstructionResolver,
  type InstructionRefusal,
} from '../src/exec/instructions.ts';
import type { OrderPacket } from '../src/hub/types.ts';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';

const COMMAND = 'printf "local-command\\n"';
const WORKFLOW = `name: policy-fixture
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: command-step
    consumes: [seed]
    produces: [command-out]
    terminal: true
    executor: command
    command: '${COMMAND}'
    body: ""
  - name: agent-step
    consumes: [seed]
    produces: [agent-out]
    terminal: true
    body: "Do the local work."
`;

interface Fixture {
  defDigest: string;
  projectRoot: string;
  globalRoot: string;
}

async function fixture(): Promise<Fixture> {
  const sourceDir = writeBundleSource({ name: 'policy-fixture', workflow: WORKFLOW });
  const installed = await installBundleFixture({ sourceDir, root: tempDir('owenloop-policy-project-') });
  const loaded = loadDefFile(`${installed.result.objectPath}/workflow.yaml`);
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  return {
    defDigest: defInstructionDigest(definition),
    projectRoot: installed.root,
    globalRoot: tempDir('owenloop-policy-global-'),
  };
}

function order(defDigest: string, step: string, worker?: 'command'): OrderPacket {
  return {
    run: 'run-policy',
    workflow: 'wf-policy',
    step,
    key: 'key-policy',
    defDigest,
    inputs: [],
    outputs: [],
    ...(worker === undefined ? {} : { worker }),
    consumes: {},
    owes: [],
  };
}

function verdict(kind: 'verified' | 'unsigned' | 'invalid'): DefVerdict {
  if (kind === 'verified') return { kind, publisherKeyId: 'SHA256:test', principal: 'publisher' };
  if (kind === 'unsigned') return { kind };
  return { kind, reason: 'publication signature could not be verified' };
}

function refusal(result: unknown): asserts result is InstructionRefusal {
  assert.equal((result as { ok?: boolean }).ok, false);
  assert.equal((result as InstructionRefusal).kind, 'unverified-def');
}

for (const fixtureKind of ['signed', 'unsigned', 'tampered'] as const) {
  for (const policy of ['enforce', 'warn', 'off'] as const satisfies readonly DefPolicy[]) {
    for (const worker of ['agent', 'command'] as const) {
      const command = worker === 'command';
      const name =
        fixtureKind === 'unsigned' && policy === 'off' && command
          ? 'SECURITY: command order with an unsigned def is REFUSED even when defPolicy=off'
          : fixtureKind === 'tampered' && policy === 'off' && command
            ? 'SECURITY: command order with a tampered def is REFUSED even when defPolicy=off'
            : fixtureKind === 'unsigned' && command
              ? `HARD RULE: command order with an unsigned def is REFUSED when defPolicy=${policy}`
              : fixtureKind === 'tampered' && command
                ? `HARD RULE: command order with a tampered def is REFUSED when defPolicy=${policy}`
                : `execution policy matrix: ${fixtureKind} × ${policy} × ${worker}`;

      test(name, async () => {
        const installed = await fixture();
        const warnings: string[] = [];
        const resolver = createStoreInstructionResolver({
          projectRoot: installed.projectRoot,
          globalRoot: installed.globalRoot,
          verifier: createBundleIngestor(),
          defPolicy: policy,
          warn: (line) => warnings.push(line),
          definitionVerifier: () => verdict(fixtureKind === 'signed' ? 'verified' : fixtureKind === 'unsigned' ? 'unsigned' : 'invalid'),
        });
        const packet = order(installed.defDigest, command ? 'command-step' : 'agent-step', command ? 'command' : undefined);
        const result = command ? await resolver.resolveCommand(packet) : await resolver.resolveStep(packet);

        if (fixtureKind === 'signed') {
          assert.equal(result.ok, true);
          assert.deepEqual(warnings, []);
          if (command) assert.equal((result as { ok: true; command: string }).command, COMMAND);
          return;
        }

        if (command || policy === 'enforce' || fixtureKind === 'tampered') {
          refusal(result);
          assert.match(result.reason, /unverified-def/);
          if (fixtureKind === 'tampered') assert.match(result.reason, /invalid|publication signature/i);
          else assert.match(result.reason, /unsigned/);
          assert.deepEqual(warnings, []);
          return;
        }

        assert.equal(result.ok, true);
        if (policy === 'warn') {
          assert.equal(warnings.length, 1);
          assert.match(warnings[0]!, /defPolicy=warn allows agent execution/);
          assert.match(warnings[0]!, new RegExp(fixtureKind));
        } else {
          assert.deepEqual(warnings, []);
        }
      });
    }
  }
}

test('command hard rule refuses without an execution verifier before reading defPolicy', async () => {
  const installed = await fixture();
  const resolver = createStoreInstructionResolver({
    projectRoot: installed.projectRoot,
    globalRoot: installed.globalRoot,
    verifier: createBundleIngestor(),
    env: { OWENLOOP_DEF_POLICY: 'not-a-policy' },
  });
  const result = await resolver.resolveCommand(order(installed.defDigest, 'command-step', 'command'));
  refusal(result);
  assert.match(result.reason, /unverifiable: execution-time publication verifier is not configured/);
});
