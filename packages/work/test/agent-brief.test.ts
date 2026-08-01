import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCOUNT_TOKEN,
  CONDUCTOR_TOKEN,
  ORDER_TOKEN,
  ORIGIN_TOKEN,
  buildOwenworkMcp,
  renderBrief,
  type BriefSpec,
} from '../src/agent/brief.ts';

const spec = (over: Partial<BriefSpec> = {}): BriefSpec => ({
  workflow: 'wf1',
  run: 'run_11111111',
  origin: 'https://hub.example',
  account: 'default',
  ...over,
});

/**
 * The token VALUES are a wire contract with the hub, not an internal detail: a
 * published step body contains these exact strings, so changing one here without
 * republishing every def would ship an unsubstituted placeholder to the model.
 *
 * Phase 5 note: this used to compare `src/agent/brief.ts`'s constants against a
 * second copy in the deleted legacy stamp module. With one copy left there is
 * nothing to drift against, so the guard pins the literals instead.
 */
test('the four substitution tokens are the exact strings published defs embed', () => {
  assert.equal(ORDER_TOKEN, '__OWENWORK_ORDER__');
  assert.equal(ORIGIN_TOKEN, '__OWENWORK_ORIGIN__');
  assert.equal(ACCOUNT_TOKEN, '__OWENWORK_ACCOUNT__');
  assert.equal(CONDUCTOR_TOKEN, '__OWENWORK_CONDUCTOR__');
});

test('renderBrief substitutes all four tokens, every occurrence', () => {
  const template = [
    `order=${ORDER_TOKEN}`,
    `origin=${ORIGIN_TOKEN}`,
    `account=${ACCOUNT_TOKEN}`,
    `cid=${CONDUCTOR_TOKEN}`,
    `again=${ORDER_TOKEN}`,
  ].join('\n');
  const out = renderBrief(template, spec({ conductorId: 'cnd_abc' }));
  assert.equal(
    out,
    ['order=wf1/run_11111111', 'origin=https://hub.example', 'account=default', 'cid=cnd_abc', 'again=wf1/run_11111111'].join('\n'),
  );
  assert.equal(/__OWENWORK_/.test(out), false, 'no token may survive substitution');
});

test('renderBrief: an absent conductorId substitutes the empty string', () => {
  assert.equal(renderBrief(`[${CONDUCTOR_TOKEN}]`, spec()), '[]');
});

test('renderBrief leaves template text alone when it holds no tokens', () => {
  assert.equal(renderBrief('plain body $& \\1', spec()), 'plain body $& \\1');
});

test('buildOwenworkMcp emits the born-bound work-holder argv', () => {
  assert.deepEqual(buildOwenworkMcp(spec({ conductorId: 'cnd_abc' })), {
    command: 'owenloop',
    args: ['work', 
      'hold',
      '--order',
      'wf1/run_11111111',
      '--origin',
      'https://hub.example',
      '--as',
      'default',
      '--conductor=cnd_abc',
      '--mcp',
    ],
  });
});

test('buildOwenworkMcp: --conductor is ONE argv element, empty value when absent', () => {
  const { args } = buildOwenworkMcp(spec());
  assert.equal(args.includes('--conductor'), false, 'the two-element form is wrong');
  assert.equal(args.includes('--conductor='), true);
});

/**
 * D10(a). The mount is a selector, never a secret: `--as <account>` names a
 * credential-store slot and the mounted work-holder resolves its own bearer.
 * A regression that started passing a token through argv would leak it into
 * every `ps` listing and into any harness rollout that records its child argv.
 */
test('buildOwenworkMcp carries no credential', () => {
  const token = 'sk_live_notarealsecret';
  const flat = JSON.stringify(buildOwenworkMcp(spec({ account: 'default', conductorId: 'cnd_abc' })));
  assert.equal(flat.includes(token), false);
  assert.equal(/token|bearer|secret|password|api[-_]?key/i.test(flat), false, `credential-shaped text in the mount: ${flat}`);
});
