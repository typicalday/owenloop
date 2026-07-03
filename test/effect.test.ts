/**
 * Tests for the step-level effect:{idempotent,onInvalidate} contract (design §6.5, §17).
 *
 * Tests (a)–(g) per the plan:
 *   (a) Back-compat: plain step re-arms on input move
 *   (b) Back-compat: terminal:true green never re-armed
 *   (c) idempotent:true explicit behaves like (a)
 *   (d) non-idempotent + pin: stays green, fingerprint updated, stable
 *   (e) non-idempotent + escalate: rejected-and-held, producer not eligible, surfaces as stalled
 *   (f) Def validation hard errors
 *   (g) Dead-input cascade for non-idempotent step — NOT gated by effect
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
import { buildDef, validateDef } from '../src/defs.ts';
import { arts, def, input, step } from './helpers.ts';
import type { ArtifactData } from '../src/types.ts';

// ---- (a) Back-compat: plain step re-arms on input move ----------------------

test('(a) back-compat: plain step re-arms on input move', () => {
  // Two-step def: planner→plan, builder→pr
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
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
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({ name: 'merger', consumes: ['plan'], produces: ['merge'], terminal: true }),
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
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'], effect: { idempotent: true } }),
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
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({
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
  assert.ok(!ef.some((f) => f.step === 'builder'),
    `builder must not be eligible after pin; eligible: ${ef.map((f) => f.step).join(', ')}`);

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
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({
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
  assert.ok(!ef.some((f) => f.step === 'builder'),
    `builder must not be eligible when held; eligible: ${ef.map((f) => f.step).join(', ')}`);

  // workflowStatus must surface pr as stalled with kind='invalidated-irreversible'
  const status = workflowStatus(d, settled);
  const prDebt = status.debts.find((dbt) => dbt.path === 'pr');
  assert.ok(prDebt !== undefined, 'pr must appear in debts');
  assert.equal(prDebt!.stalled, true, 'pr debt must be stalled');
  assert.equal(prDebt!.kind, 'invalidated-irreversible', 'pr debt kind must be invalidated-irreversible');
});

// ---- (f) Def validation hard errors -----------------------------------------

test('(f) def validation: unknown onInvalidate step name is a validateDef error', () => {
  // buildDef no longer throws for named-handler strings in buildStep;
  // validateDef (D-D) reports an error when the handler step doesn't exist.
  const d = buildDef({
    name: 'bad',
    inputs: [{ name: 'x' }],
    steps: [
      { name: 'foo', consumes: ['x'], produces: ['y'], effect: { onInvalidate: 'frobnicate' } },
    ],
  });
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('does not exist') || e.includes('frobnicate')),
    `expected error mentioning non-existent handler; errors: ${errors.join('; ')}`,
  );
});

test('(f) def validation: terminal:true and effect: are mutually exclusive', () => {
  // Build a step that has both terminal: and effect: via direct StepDef construction,
  // then call validateDef to get the accumulated errors.
  const d = def(
    'test',
    [input('x')],
    [step({ name: 'foo', consumes: ['x'], produces: ['y'], terminal: true, effect: { idempotent: false } })],
  );
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('terminal') && e.includes('effect')),
    `expected error mentioning 'terminal' and 'effect'; errors: ${errors.join('; ')}`,
  );
});

// ---- Alternative (f) tests using direct imports for cleaner coverage --------

test('(f) validateDef: onInvalidate=frobnicate → error mentioning non-existent handler', () => {
  // buildDef no longer throws for named-handler strings; validateDef (D-D) catches them.
  const d = buildDef({
    name: 'test',
    inputs: [{ name: 'src' }],
    steps: [
      { name: 'worker', consumes: ['src'], produces: ['out'], effect: { onInvalidate: 'frobnicate' } },
    ],
  });
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('does not exist') || e.includes('frobnicate')),
    `expected error mentioning non-existent handler; errors: ${errors.join('; ')}`,
  );
});

test('(f) validateDef: terminal:true + effect: → error mentions both', () => {
  // Build a step that has both terminal: and effect: — bypass buildDef by
  // constructing the StepDef directly via the helpers, then validating.
  const d = def(
    'test',
    [input('src')],
    [step({ name: 'worker', consumes: ['src'], produces: ['out'], terminal: true, effect: { idempotent: false } })],
  );
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('terminal') && e.includes('effect')),
    `expected error mentioning 'terminal' and 'effect'; got: ${errors.join('; ')}`,
  );
});

// ---- (g) Dead-input cascade for non-idempotent step — NOT gated by effect ---

test('(g) dead-input cascade for non-idempotent step is unconditionally structural', () => {
  // Use a pin step (strongest non-idempotent). When the input is retracted (dead),
  // the cascade must still be retract/skip — NOT a pin op.
  const d = def(
    'research',
    [input('question')],
    [
      step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] }),
      step({
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

// ---- (h) Back-compat: pin/escalate/idempotent unchanged by named-handler code ---

test('(h) back-compat: pin still pins (not armed) when onInvalidate=pin', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'], effect: { idempotent: false, onInvalidate: 'pin' } }),
    ],
  );

  // pr is green built on plan v1; plan has moved to v2
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]);

  const ops = maintainDecisions(d, a);
  // Must produce a pin op for pr — not an arm op
  assert.ok(ops.some((op) => op.kind === 'pin' && op.path === 'pr'),
    `expected pin op for 'pr'; got: ${JSON.stringify(ops)}`);
  assert.ok(!ops.some((op) => op.kind === 'arm'),
    `should not produce any arm op for pin behavior; got: ${JSON.stringify(ops)}`);
});

test('(h) back-compat: escalate still rejects-and-holds (not armed) when onInvalidate=escalate', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'], effect: { idempotent: false, onInvalidate: 'escalate' } }),
    ],
  );

  // pr is green built on plan v1; plan has moved to v2
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]);

  const ops = maintainDecisions(d, a);
  assert.ok(
    ops.some((op) => op.kind === 'reject' && op.path === 'pr' && 'held' in op && (op as { held?: boolean }).held === true),
    `expected reject+held op for 'pr'; got: ${JSON.stringify(ops)}`,
  );
  assert.ok(!ops.some((op) => op.kind === 'arm'),
    `should not produce any arm op for escalate behavior; got: ${JSON.stringify(ops)}`);
});

// ---- (i) Dormancy: handler has no owed output at creation, not eligible -------

test('(i) dormancy: handler output absent at creation, not eligible', () => {
  // def: proposal → planner → plan; planner → pr (effect.onInvalidate: 'reverter'); reverter → revert
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({
        name: 'builder',
        consumes: ['plan'],
        produces: ['pr'],
        effect: { idempotent: false, onInvalidate: 'reverter' },
      }),
      step({ name: 'reverter', consumes: ['pr'], produces: ['revert'] }),
    ],
  );

  // Only proposal is green; settle from seed
  const a: Map<string, ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
  ]) as Map<string, ArtifactData>;
  const settled = settleInMemory(d, a);

  // 'revert' must NOT be in arts as owed — handler output dormant at creation
  const revert = settled.get('revert');
  assert.ok(!revert || revert.acceptance !== 'owed',
    `handler output 'revert' must not be owed at creation; got: ${JSON.stringify(revert)}`);

  // No firing eligible for 'reverter'
  const ef = eligibleFirings(d, settled);
  assert.ok(!ef.some((f) => f.step === 'reverter'),
    `reverter must not be eligible at creation; eligible: ${ef.map((f) => f.step).join(', ')}`);
});

// ---- (j) Arm-on-invalidation: L pinned + H owed + H eligible after input moves ---

test('(j) arm-on-invalidation: L pinned, H owed, H eligible after input moves; green H → done', () => {
  // plan is green built on proposal v1; proposal moves to v2
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({
        name: 'builder',
        consumes: ['plan'],
        produces: ['pr'],
        effect: { idempotent: false, onInvalidate: 'reverter' },
      }),
      step({ name: 'reverter', consumes: ['pr'], produces: ['revert'] }),
    ],
  );

  // pr is green built on plan v1; plan has since moved to v2 (proposal changed, planner re-fired)
  const artMap: Map<string, ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 2 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]) as Map<string, ArtifactData>;

  // maintainDecisions: expect a pin op for pr AND an arm op with handlerStep='reverter'
  const ops = maintainDecisions(d, artMap);
  assert.ok(ops.some((op) => op.kind === 'pin' && op.path === 'pr'),
    `expected pin op for 'pr'; got: ${JSON.stringify(ops)}`);
  assert.ok(ops.some((op) => op.kind === 'arm' && op.handlerStep === 'reverter'),
    `expected arm op for 'reverter'; got: ${JSON.stringify(ops)}`);

  // settleInMemory: plan stays green, revert is owed
  const settled = settleInMemory(d, artMap);

  assert.equal(settled.get('pr')!.acceptance, 'green', 'pr must remain green after pin');
  assert.equal(settled.get('revert')?.acceptance, 'owed', `revert must be owed after arm; got: ${JSON.stringify(settled.get('revert'))}`);

  // eligibleFirings: reverter appears; builder does not (pr is green)
  const ef = eligibleFirings(d, settled);
  assert.ok(ef.some((f) => f.step === 'reverter'),
    `reverter must be eligible after arm; eligible: ${ef.map((f) => f.step).join(', ')}`);
  assert.ok(!ef.some((f) => f.step === 'builder'),
    `builder must not be eligible (pr is green); eligible: ${ef.map((f) => f.step).join(', ')}`);
});

// ---- (k) No-thrash: second pass yields no new op, H not re-armed twice --------

test('(k) no-thrash: second maintainDecisions pass yields no new arm op', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({
        name: 'builder',
        consumes: ['plan'],
        produces: ['pr'],
        effect: { idempotent: false, onInvalidate: 'reverter' },
      }),
      step({ name: 'reverter', consumes: ['pr'], produces: ['revert'] }),
    ],
  );

  // Start from state after first invalidation + pin (pr pinned with updated fingerprint, revert owed)
  const artMap: Map<string, ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 2 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 2 } }, // pinned: fp updated to plan v2
    { path: 'revert', producer: 'reverter', acceptance: 'owed', version: 0 },
  ]) as Map<string, ArtifactData>;

  const settled = settleInMemory(d, artMap);

  // Second pass on settled map: no op for pr, no arm for reverter
  const ops2 = maintainDecisions(d, settled);
  assert.ok(!ops2.some((op) => op.path === 'pr'),
    `second pass must yield no op for pr (no-thrash); got: ${JSON.stringify(ops2)}`);
  assert.ok(!ops2.some((op) => op.kind === 'arm'),
    `second pass must yield no arm op (no-thrash); got: ${JSON.stringify(ops2)}`);
});

// ---- (l) Re-invalidation: input moves to new version → pin again + H re-arms ---

test('(l) re-invalidation: input moves to v3 → pin again + H re-armed from green', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({
        name: 'builder',
        consumes: ['plan'],
        produces: ['pr'],
        effect: { idempotent: false, onInvalidate: 'reverter' },
      }),
      step({ name: 'reverter', consumes: ['pr'], produces: ['revert'] }),
    ],
  );

  // State: pr was built on plan v1, plan has since moved to v3 (re-invalidation scenario).
  // Revert fired once (green v1 on pr v1). pr.fingerprint still points to plan v1 → stale.
  const artMap: Map<string, ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 3 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 3, fingerprint: { proposal: 3 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
    { path: 'revert', producer: 'reverter', acceptance: 'green', version: 1, fingerprint: { pr: 1 } },
  ]) as Map<string, ArtifactData>;

  // maintainDecisions: expect pin for pr AND arm for reverter
  const ops = maintainDecisions(d, artMap);
  assert.ok(ops.some((op) => op.kind === 'pin' && op.path === 'pr'),
    `expected pin op for 'pr'; got: ${JSON.stringify(ops)}`);
  assert.ok(ops.some((op) => op.kind === 'arm' && op.handlerStep === 'reverter'),
    `expected arm op for 'reverter'; got: ${JSON.stringify(ops)}`);

  // After settleInMemory: revert re-armed to owed from green
  const settled = settleInMemory(d, artMap);
  assert.equal(settled.get('revert')?.acceptance, 'owed',
    `revert must be re-armed to owed after re-invalidation; got: ${JSON.stringify(settled.get('revert'))}`);
});

// ---- (m) Green H → workflow reaches done ---------------------------------------

test('(m) green H → workflow reaches done', () => {
  const d = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({
        name: 'builder',
        consumes: ['plan'],
        produces: ['pr'],
        effect: { idempotent: false, onInvalidate: 'reverter' },
      }),
      step({ name: 'reverter', consumes: ['pr'], produces: ['revert'] }),
    ],
  );

  // All artifacts green (after reverter fired and revert greened)
  const artMap: Map<string, ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1, fingerprint: { proposal: 2 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
    { path: 'revert', producer: 'reverter', acceptance: 'green', version: 1, fingerprint: { pr: 1 } },
  ]) as Map<string, ArtifactData>;

  const settled = settleInMemory(d, artMap);

  // No debts remain
  const status = workflowStatus(d, settled);
  assert.equal(status.done, true,
    `workflow must be done when all artifacts are green; debts: ${JSON.stringify(status.debts)}`);
});
