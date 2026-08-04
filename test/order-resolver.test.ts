/**
 * WP-B1: the reference-mode instruction resolver — unit coverage for the
 * `(defDigest, step, key)` boundary: byte-exact authored values, runtime
 * placeholder materialization, the named unknown-digest refusal, and the
 * fallback digest's identity behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefInstructionSource,
  defInstructionDigest,
  OrderResolver,
  UnknownDefDigestError,
} from '../src/order-resolver.ts';
import type { Order } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

// A verified fixture with DELIBERATE whitespace and newlines in every field —
// the resolver must round-trip these byte-for-byte (no trim, no normalize).
const PROMPT = '  leading and trailing spaces  \n\ninterior\nnewlines\tand a tab  ';
const COMMAND = ' echo "padded command"  \n';
const fixtureDef = def(
  'resolverfixture',
  [input('proposal')],
  [
    step({ name: 'agentstep', consumes: ['proposal'], produces: ['plan'], body: PROMPT }),
    step({
      name: 'cmdstep',
      consumes: ['plan'],
      produces: ['result'],
      executor: 'command',
      command: COMMAND,
      body: '', // a command step may carry an empty body — no fabricated prompt
    }),
  ],
);

function orderOf(over: Partial<Order>): Order {
  return {
    run: 'run_r',
    workflow: 'wf_r',
    step: 'agentstep',
    key: '',
    defDigest: 'irrelevant-until-lookup',
    inputs: [],
    outputs: [],
    consumes: {},
    owes: [],
    ...over,
  };
}

test('resolver returns byte-exact prompt and command values (whitespace preserved)', () => {
  const source = createDefInstructionSource([fixtureDef]);
  const digest = defInstructionDigest(fixtureDef);
  const resolver = new OrderResolver(source);

  const agent = resolver.resolve({ defDigest: digest, step: 'agentstep', key: '' });
  assert.equal(agent.prompt, PROMPT, 'prompt bytes round-trip exactly');
  assert.equal(agent.command, undefined, 'no fabricated command');
  assert.equal(agent.acceptance, undefined, 'no fabricated acceptance');

  const cmd = resolver.resolve({ defDigest: digest, step: 'cmdstep', key: '' });
  assert.equal(cmd.command, COMMAND, 'command bytes round-trip exactly');
  assert.equal(cmd.prompt, undefined, 'an empty body resolves as no prompt — never fabricated');
});

test('runtime placeholder materialization matches the pre-reference substitution behavior', () => {
  const materialDef = def(
    'materialize',
    [input('proposal')],
    [
      step({
        name: 'mat',
        consumes: ['proposal'],
        produces: ['out'],
        maxAttempts: 7,
        body:
          'wf=${WORKFLOW} run=${RUN} step=${STEP} key=${KEY} index=${INDEX} cap=${MAX_ATTEMPTS} unknown=${NOT_A_VAR}',
      }),
      step({
        name: 'nomax',
        consumes: ['out'],
        produces: ['done'],
        maxAttempts: 2,
        body: 'k=${KEY} i=${INDEX} cap=${MAX_ATTEMPTS}',
      }),
    ],
  );
  const source = createDefInstructionSource([materialDef]);
  const digest = defInstructionDigest(materialDef);
  const resolver = new OrderResolver(source);

  // plain firing: INDEX renders empty (absent index), MAX_ATTEMPTS is the
  // authored step default, unknown placeholders stay untouched
  const plain = resolver.resolveOrder(
    orderOf({ defDigest: digest, step: 'mat', workflow: 'wf_42', run: 'run_9', key: '' }),
  );
  assert.equal(
    plain.prompt,
    'wf=wf_42 run=run_9 step=mat key= index= cap=7 unknown=${NOT_A_VAR}',
  );

  // map element firing: KEY passes through unchanged, INDEX renders the number
  const mapped = resolver.resolveOrder(
    orderOf({ defDigest: digest, step: 'nomax', workflow: 'wf_42', run: 'run_9', key: 'gather.src[3].formatcheck', index: 3 }),
  );
  assert.equal(mapped.prompt, 'k=gather.src[3].formatcheck i=3 cap=2');
});

test('an unknown digest throws UnknownDefDigestError — no name fallback, no empty instructions', () => {
  const source = createDefInstructionSource([fixtureDef]);
  const resolver = new OrderResolver(source);

  // the digest is unknown even though a def with a matching NAME is loaded
  assert.throws(
    () => resolver.resolve({ defDigest: 'ffffffff'.repeat(8), step: 'agentstep', key: '' }),
    (err: unknown) => {
      assert.ok(err instanceof UnknownDefDigestError, 'named refusal class');
      assert.equal(err.name, 'UnknownDefDigestError');
      assert.equal((err as UnknownDefDigestError).defDigest, 'ffffffff'.repeat(8), 'digest retained on the instance');
      assert.match(err.message, /ffffffff/, 'message names the rejected digest');
      return true;
    },
  );

  // resolveOrder takes the same refusal
  assert.throws(
    () => resolver.resolveOrder(orderOf({ defDigest: 'deadbeef' })),
    UnknownDefDigestError,
  );
});

test('identical content from different directories digests identically; dir never changes identity', () => {
  const a = { ...fixtureDef, dir: '/tmp/load-site-a' };
  const b = { ...fixtureDef, dir: '/somewhere/else/b' };
  const plain = { ...fixtureDef };
  delete plain.dir;
  assert.equal(defInstructionDigest(a), defInstructionDigest(b));
  assert.equal(defInstructionDigest(a), defInstructionDigest(plain));
});

test('prompt, command, and routing-shape changes each change the digest', () => {
  const base = defInstructionDigest(fixtureDef);

  const promptChanged = def(
    'resolverfixture',
    [input('proposal')],
    [
      step({ name: 'agentstep', consumes: ['proposal'], produces: ['plan'], body: 'a different body' }),
      fixtureDef.steps[1]!,
    ],
  );
  assert.notEqual(defInstructionDigest(promptChanged), base, 'prompt change must change the digest');

  const commandChanged = def(
    'resolverfixture',
    [input('proposal')],
    [
      fixtureDef.steps[0]!,
      step({
        name: 'cmdstep',
        consumes: ['plan'],
        produces: ['result'],
        executor: 'command',
        command: 'echo changed',
        body: '',
      }),
    ],
  );
  assert.notEqual(defInstructionDigest(commandChanged), base, 'command change must change the digest');

  const consumesChanged = def(
    'resolverfixture',
    [input('proposal'), input('extra')],
    [
      step({ name: 'agentstep', consumes: ['proposal', 'extra'], produces: ['plan'], body: PROMPT }),
      fixtureDef.steps[1]!,
    ],
  );
  assert.notEqual(defInstructionDigest(consumesChanged), base, 'routing-shape change must change the digest');
});

test('digestOf registers the exact snapshot it digested — resolution survives source change', () => {
  const source = createDefInstructionSource();
  const digest = source.digestOf(fixtureDef);

  // resolve after registration — the snapshot passed to digestOf is the one served
  const resolver = new OrderResolver(source);
  assert.equal(resolver.resolve({ defDigest: digest, step: 'agentstep', key: '' }).prompt, PROMPT);
});

test('the engine default-construction adapter behaves the same way (no-source Engine path)', () => {
  // createEngine/factory/CLI seed the source; a bare `new Engine` relies on
  // digestOf-registering. Both must produce identical resolution results.
  const seeded = createDefInstructionSource([fixtureDef]);
  const bare = createDefInstructionSource();
  const digestSeeded = seeded.digestOf(fixtureDef);
  const digestBare = bare.digestOf(fixtureDef);
  assert.equal(digestSeeded, digestBare);
  const a = new OrderResolver(seeded).resolve({ defDigest: digestSeeded, step: 'cmdstep', key: '' });
  const b = new OrderResolver(bare).resolve({ defDigest: digestBare, step: 'cmdstep', key: '' });
  assert.deepEqual(a, b);
});
