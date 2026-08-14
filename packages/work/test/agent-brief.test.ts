import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCOUNT_TOKEN,
  SHIFT_TOKEN,
  ORDER_TOKEN,
  ORIGIN_TOKEN,
  buildOwenloopMcp,
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
  assert.equal(ORDER_TOKEN, '__OWENLOOP_ORDER__');
  assert.equal(ORIGIN_TOKEN, '__OWENLOOP_ORIGIN__');
  assert.equal(ACCOUNT_TOKEN, '__OWENLOOP_ACCOUNT__');
  assert.equal(SHIFT_TOKEN, '__OWENLOOP_SHIFT__');
});

test('renderBrief substitutes all four tokens, every occurrence', () => {
  const template = [
    `order=${ORDER_TOKEN}`,
    `origin=${ORIGIN_TOKEN}`,
    `account=${ACCOUNT_TOKEN}`,
    `cid=${SHIFT_TOKEN}`,
    `again=${ORDER_TOKEN}`,
  ].join('\n');
  const out = renderBrief(template, spec({ shiftId: 'shf_abc' }));
  assert.equal(
    out,
    ['order=wf1/run_11111111', 'origin=https://hub.example', 'account=default', 'cid=shf_abc', 'again=wf1/run_11111111'].join('\n'),
  );
  assert.equal(/__OWENLOOP_/.test(out), false, 'no token may survive substitution');
});

test('renderBrief: an absent shiftId substitutes the empty string', () => {
  assert.equal(renderBrief(`[${SHIFT_TOKEN}]`, spec()), '[]');
});

// ---- the routing line --------------------------------------------------------
//
// PREPENDED, not substituted through a token. The same authored step body runs
// at every modifier the def declares, so a token would only reach agents whose
// def author happened to write one — and the agents that most need to know they
// are on a deep run are the ones whose body was written before `modifiers:`
// existed. Prepending reaches all of them.
//
// DESCRIPTIVE, NOT DIRECTIVE. It states which depth the run was started at. It
// does not tell the agent to try harder or to spend more turns: the depth is
// already expressed in the model and effort the shift resolved for this order,
// and instructing the agent on top of that would double-count it.

test('renderBrief prepends the run modifier ahead of the substituted body', () => {
  const out = renderBrief(`order=${ORDER_TOKEN}`, spec({ modifier: 'deep' }));
  assert.equal(out, ["Routing: this run was started at the 'deep' depth modifier.", '', 'order=wf1/run_11111111'].join('\n'));
});

test('renderBrief says when the engine RE-OFFERED the step at a deeper modifier', () => {
  const out = renderBrief('body', spec({ modifier: 'deep', escalated: true }));
  assert.match(out, /^Routing: this run was started at the 'deep' depth modifier\. This step was RE-OFFERED/u);
  assert.match(out, /recovery attempt, not a first pass/u);
  assert.ok(out.endsWith('\n\nbody'));
});

test('renderBrief adds no routing line when the run has no modifier', () => {
  // A run started without one is not "at the default depth" — it is depth-less,
  // and a line claiming otherwise would be an invention.
  assert.equal(renderBrief('body', spec()), 'body');
  assert.equal(renderBrief('body', spec({ modifier: '' })), 'body');
  // `escalated` alone cannot produce a line either: the engine only sets it on
  // a re-offer, which by construction carries the escalation modifier.
  assert.equal(renderBrief('body', spec({ escalated: true })), 'body');
});

test('renderBrief leaves template text alone when it holds no tokens', () => {
  assert.equal(renderBrief('plain body $& \\1', spec()), 'plain body $& \\1');
});

test('buildOwenloopMcp emits the born-bound work-holder argv', () => {
  assert.deepEqual(buildOwenloopMcp(spec({ shiftId: 'shf_abc' }), '/same/bin/owenloop.mjs', '/same/node'), {
    command: '/same/node',
    args: ['/same/bin/owenloop.mjs', 'work',
      'hold',
      '--order',
      'wf1/run_11111111',
      '--origin',
      'https://hub.example',
      '--as',
      'default',
      '--shift=shf_abc',
      '--mcp',
      '--never-release',
    ],
  });
});

/**
 * The claim belongs to `agent-run`'s exec loop, not to this child. Dropping
 * `--never-release` re-opens the defect where the child's stdin EOF released a
 * run its own agent was still working, and the shift re-dispatched the order.
 */
test('buildOwenloopMcp never lets the child release the claim', () => {
  const { args } = buildOwenloopMcp(spec({ shiftId: 'shf_abc' }));
  assert.equal(args.includes('--never-release'), true);
});

test('buildOwenloopMcp cannot be hijacked by a stale owenloop earlier on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-stale-path-'));
  const marker = join(dir, 'stale-ran');
  const fake = join(dir, 'owenloop');
  try {
    writeFileSync(fake, `#!/bin/sh\nprintf stale > "${marker}"\nexit 91\n`);
    chmodSync(fake, 0o755);

    const mount = buildOwenloopMcp(spec());
    const entrypoint = mount.args[0]!;
    const probe = spawnSync(mount.command, [entrypoint, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
    });

    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /owenloop — a dataflow workflow engine/);
    assert.equal(existsSync(marker), false, 'stale PATH executable ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildOwenloopMcp: --shift is ONE argv element, empty value when absent', () => {
  const { args } = buildOwenloopMcp(spec());
  assert.equal(args.includes('--shift'), false, 'the two-element form is wrong');
  assert.equal(args.includes('--shift='), true);
});

/**
 * D10(a). The mount is a selector, never a secret: `--as <account>` names a
 * credential-store slot and the mounted work-holder resolves its own bearer.
 * A regression that started passing a token through argv would leak it into
 * every `ps` listing and into any harness rollout that records its child argv.
 */
test('buildOwenloopMcp carries no credential', () => {
  const token = 'sk_live_notarealsecret';
  const flat = JSON.stringify(buildOwenloopMcp(spec({ account: 'default', shiftId: 'shf_abc' })));
  assert.equal(flat.includes(token), false);
  assert.equal(/token|bearer|secret|password|api[-_]?key/i.test(flat), false, `credential-shaped text in the mount: ${flat}`);
});
