/**
 * Tests for the loop-level effect:{idempotent,onInvalidate} contract (design §6.5, §17).
 *
 * Tests (a)–(g) per the plan:
 *   (a) Back-compat: plain loop re-arms on input move
 *   (b) Back-compat: terminal:true green never re-armed
 *   (c) idempotent:true explicit behaves like (a)
 *   (d) non-idempotent + pin: stays green, fingerprint updated, stable
 *   (e) non-idempotent + escalate: rejected-and-held, producer not eligible, surfaces as stalled
 *   (f) Def validation hard errors
 *   (g) Dead-input cascade for non-idempotent loop — NOT gated by effect
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eligibleFirings,
  isHeld,
  maintainDecisions,
  settleInMemory,
  workflowStatus,
} from '../src/model.ts';
import { buildDef, DefError, validateDef } from '../src/defs.ts';
import { arts, def, input, loop } from './helpers.ts';
import type { ArtifactData } from '../src/types.ts';

// ---- (a) Back-compat: plain loop re-arms on input move ----------------------

test('(a) back-compat: plain loop re-arms on input move', () => {
  // Two-loop def: planner→plan, builder→pr
  const d = def(
    'delivery',
    [input('proposal')],
    [
      loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      loop({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    ],
  );

  // plan is green built on proposal v1; proposal has since moved to v2
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'owed' },
  ]);

  const ops = maintainDecisions(d, a);
  assert.ok(ops.some((op) => op.kind === 'reject' && op.path === 'plan' && !('held' in op && op.held)),
    `expected a plain reject op for 'plan'; got: ${JSON.stringify(ops)}`);
  assert.ok(!ops.some((op) => op.kind === 'pin'), 'should not produce a pin op');
});

// ---- (b) Back-compat: terminal:true green never re-armed --------------------

test('(b) back-compat: terminal:true green never re-armed on input move', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      loop({ name: 'merger', consumes: ['plan'], produces: ['merge'], terminal: true }),
    ],
  );

  // merge is green+terminal built on plan v1; plan has since moved to v2
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 1 } },
    { path: 'merge', producer: 'merger', acceptance: 'green', version: 1, fingerprint: { plan: 1 }, terminal: true },
  ]);

  const ops = maintainDecisions(d, a);
  // plan should be re-armed (proposal fingerprint is now current, no-op for plan itself)
  // merge must NOT be touched — it is terminal
  assert.ok(!ops.some((op) => op.path === 'merge'),
    `merge (terminal) must not receive any op; got: ${JSON.stringify(ops)}`);
});

// ---- (c) idempotent:true explicit behaves like (a) --------------------------

test('(c) idempotent:true explicit — re-arms on input move like default', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      loop({ name: 'builder', consumes: ['plan'], produces: ['pr'], effect: { idempotent: true } }),
    ],
  );

  // pr is green built on plan v1; plan has moved to v2
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]);

  const ops = maintainDecisions(d, a);
  assert.ok(ops.some((op) => op.kind === 'reject' && op.path === 'pr' && !('held' in op && op.held)),
    `expected a plain reject op for 'pr'; got: ${JSON.stringify(ops)}`);
  assert.ok(!ops.some((op) => op.kind === 'pin'), 'should not produce a pin op');
});

// ---- (d) non-idempotent + pin: stays green, fingerprint updated, stable -----

test('(d) non-idempotent + pin: stays green, fingerprint updated, second pass stable', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      loop({
        name: 'builder',
        consumes: ['plan'],
        produces: ['pr'],
        effect: { idempotent: false, onInvalidate: 'pin' },
      }),
    ],
  );

  // pr is green built on plan v1; plan has moved to v2
  const artMap: Map<string, ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]) as Map<string, ArtifactData>;

  // First pass: should produce a pin op
  const ops = maintainDecisions(d, artMap);
  assert.ok(ops.some((op) => op.kind === 'pin' && op.path === 'pr'),
    `expected a pin op for 'pr'; got: ${JSON.stringify(ops)}`);
  assert.ok(!ops.some((op) => op.kind === 'reject'), 'should not produce a reject op');

  // Apply ops via settleInMemory
  const settled = settleInMemory(d, artMap);

  // Acceptance must still be green
  const pr = settled.get('pr')!;
  assert.equal(pr.acceptance, 'green', 'pr must remain green after pin');

  // Fingerprint must now reflect plan v2
  assert.deepEqual(pr.fingerprint, { plan: 2 }, 'fingerprint must be updated to plan v2');

  // Eligibility: builder must NOT appear in eligible firings (pr is green)
  const ef = eligibleFirings(d, settled);
  assert.ok(!ef.some((f) => f.loop === 'builder'),
    `builder must not be eligible after pin; eligible: ${ef.map((f) => f.loop).join(', ')}`);

  // Reasons: a 'pinned' entry should be appended
  assert.ok(pr.reasons.some((r) => r.action === 'pinned' && r.kind === 'structural'),
    `expected a 'pinned' reason entry; reasons: ${JSON.stringify(pr.reasons)}`);

  // Stability: second call to maintainDecisions must yield NO op for pr
  const ops2 = maintainDecisions(d, settled);
  assert.ok(!ops2.some((op) => op.path === 'pr'),
    `second maintainDecisions pass must yield no op for pr (stability); got: ${JSON.stringify(ops2)}`);
});

// ---- (e) non-idempotent + escalate: rejected-and-held -----------------------

test('(e) non-idempotent + escalate: rejected-and-held, not eligible, surfaces as stalled', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      loop({
        name: 'builder',
        consumes: ['plan'],
        produces: ['pr'],
        effect: { idempotent: false, onInvalidate: 'escalate' },
      }),
    ],
  );

  // pr is green built on plan v1; plan has moved to v2
  const artMap: Map<string, ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]) as Map<string, ArtifactData>;

  // First pass: should produce a reject+held op
  const ops = maintainDecisions(d, artMap);
  assert.ok(ops.some((op) => op.kind === 'reject' && op.path === 'pr' && 'held' in op && (op as { held?: boolean }).held === true),
    `expected a reject op with held:true for 'pr'; got: ${JSON.stringify(ops)}`);

  // Apply ops via settleInMemory
  const settled = settleInMemory(d, artMap);

  const pr = settled.get('pr')!;

  // Acceptance must be rejected
  assert.equal(pr.acceptance, 'rejected', 'pr must be rejected after escalate');

  // isHeld must return true
  assert.ok(isHeld(pr), 'pr must be held (isHeld=true)');

  // Eligibility: builder must NOT appear in eligible firings (held = frozen)
  const ef = eligibleFirings(d, settled);
  assert.ok(!ef.some((f) => f.loop === 'builder'),
    `builder must not be eligible when held; eligible: ${ef.map((f) => f.loop).join(', ')}`);

  // workflowStatus must surface pr as stalled with kind='invalidated-irreversible'
  const status = workflowStatus(d, settled);
  const prDebt = status.debts.find((dbt) => dbt.path === 'pr');
  assert.ok(prDebt !== undefined, 'pr must appear in debts');
  assert.equal(prDebt!.stalled, true, 'pr debt must be stalled');
  assert.equal(prDebt!.kind, 'invalidated-irreversible', 'pr debt kind must be invalidated-irreversible');
});

// ---- (f) Def validation hard errors -----------------------------------------

test('(f) def validation: unknown onInvalidate string is a hard error', () => {
  // buildDef throws DefError for invalid onInvalidate string in buildLoop
  assert.throws(
    () => {
      buildDef({
        name: 'bad',
        inputs: [{ name: 'x' }],
        loops: [
          { name: 'foo', consumes: ['x'], produces: ['y'], effect: { onInvalidate: 'frobnicate' } },
        ],
      });
    },
    (err: unknown) => {
      const msg = (err as Error).message;
      return msg.includes('not yet supported') || msg.includes('named-handler');
    },
    'should throw mentioning named-handler / not yet supported',
  );
});

test('(f) def validation: terminal:true and effect: are mutually exclusive', () => {
  // Build a loop that has both terminal: and effect: via direct LoopDef construction,
  // then call validateDef to get the accumulated errors.
  const d = def(
    'test',
    [input('x')],
    [loop({ name: 'foo', consumes: ['x'], produces: ['y'], terminal: true, effect: { idempotent: false } })],
  );
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('terminal') && e.includes('effect')),
    `expected error mentioning 'terminal' and 'effect'; errors: ${errors.join('; ')}`,
  );
});

// ---- Alternative (f) tests using direct imports for cleaner coverage --------

test('(f) buildDef: onInvalidate=frobnicate throws DefError', () => {
  // buildDef throws DefError immediately for an unknown onInvalidate string.
  assert.throws(
    () => buildDef({
      name: 'test',
      inputs: [{ name: 'src' }],
      loops: [
        { name: 'worker', consumes: ['src'], produces: ['out'], effect: { onInvalidate: 'frobnicate' } },
      ],
    }),
    DefError,
    'buildDef must throw DefError for unknown onInvalidate string',
  );
});

test('(f) validateDef: terminal:true + effect: → error mentions both', () => {
  // Build a loop that has both terminal: and effect: — bypass buildDef by
  // constructing the LoopDef directly via the helpers, then validating.
  const d = def(
    'test',
    [input('src')],
    [loop({ name: 'worker', consumes: ['src'], produces: ['out'], terminal: true, effect: { idempotent: false } })],
  );
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('terminal') && e.includes('effect')),
    `expected error mentioning 'terminal' and 'effect'; got: ${errors.join('; ')}`,
  );
});

// ---- (g) Dead-input cascade for non-idempotent loop — NOT gated by effect ---

test('(g) dead-input cascade for non-idempotent loop is unconditionally structural', () => {
  // Use a pin loop (strongest non-idempotent). When the input is retracted (dead),
  // the cascade must still be retract/skip — NOT a pin op.
  const d = def(
    'research',
    [input('question')],
    [
      loop({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] }),
      loop({
        name: 'checker',
        consumes: ['gather.source[$i]'],
        produces: ['gather.source[$i].check'],
        effect: { idempotent: false, onInvalidate: 'pin' },
      }),
    ],
  );

  // checker's map child is green, but its input element is retracted
  const a = arts([
    { path: 'question', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'green', version: 1, sealOf: 'gather.source' },
    { path: 'gather.source[0]', producer: 'gather', acceptance: 'retracted', version: 1 },
    {
      path: 'gather.source[0].check',
      producer: 'checker',
      acceptance: 'green',
      version: 1,
      fingerprint: { 'gather.source[0]': 1 },
    },
  ]);

  const ops = maintainDecisions(d, a);
  // The map child should get a retract op (its input was retracted)
  const checkOp = ops.find((op) => op.path === 'gather.source[0].check');
  assert.ok(checkOp !== undefined,
    `expected an op for gather.source[0].check; got: ${JSON.stringify(ops)}`);
  assert.equal(checkOp!.kind, 'retract',
    `expected retract (structural dead-input cascade), not pin; got: ${checkOp!.kind}`);
});
