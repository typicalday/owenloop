import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDef } from '../../../src/defs.ts';
import type { OrderPacket } from '../src/hub/types.ts';
import type { InstructionResolver } from '../src/exec/instructions.ts';
import { createRoutedAgentStepLoader } from '../src/roles/routing-agent-step.ts';

const step = buildDef({ name: 'wf', steps: [{ name: 'build', body: 'Write the result.',
  produces: ['out'] }] }).steps[0]!;
const packet: OrderPacket = { workflow: 'wf', run: 'run', step: 'build', key: '',
  defDigest: 'a'.repeat(64), inputs: [], outputs: ['out'], consumes: {},
  owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] };

function loader(): { load: ReturnType<typeof createRoutedAgentStepLoader>; errors: string[] } {
  const errors: string[] = [];
  const instructions: InstructionResolver = {
    resolveCommand: async () => ({ ok: false, kind: 'unknown-step', reason: 'unused' }),
    resolveStep: async () => ({ ok: true, step, bundleDir: '/private/public-bundle' }),
  };
  return { load: createRoutedAgentStepLoader({ instructions,
    instructionCwd: '/private/stage', workflow: 'wf', run: 'run',
    err: line => errors.push(line) }), errors };
}

test('routed step loader uses locally resolved signed bytes and binds owed paths', async () => {
  const { load, errors } = loader();
  const previous = { bundle: process.env.OWENLOOP_BUNDLE_DIR,
    cwd: process.env.OWENLOOP_INSTRUCTION_CWD,
    workflow: process.env.OWENLOOP_WORKFLOW, run: process.env.OWENLOOP_RUN };
  try {
    const resolved = await load(packet);
    assert.equal(resolved?.brief, 'Write the result.');
    assert.equal(resolved?.step, 'build');
    assert.equal(process.env.OWENLOOP_BUNDLE_DIR, '/private/public-bundle');
    assert.equal(process.env.OWENLOOP_INSTRUCTION_CWD, '/private/stage');
    assert.deepEqual(errors, []);
    assert.equal(await load({ ...packet, outputs: ['forged'] }), null);
    assert.match(errors.at(-1)!, /routed signed step refused/);
  } finally {
    for (const [key, value] of Object.entries({ OWENLOOP_BUNDLE_DIR: previous.bundle,
      OWENLOOP_INSTRUCTION_CWD: previous.cwd, OWENLOOP_WORKFLOW: previous.workflow,
      OWENLOOP_RUN: previous.run })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
