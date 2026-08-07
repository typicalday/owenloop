import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TIER_MAP,
  EFFORT_LADDER,
  createModelPolicy,
  parseModelEffort,
  pickModel,
  resolveModelTier,
} from '../src/agent/model-policy.ts';

const policy = createModelPolicy();

test('model policy resolves the four quality tiers and passes literal ids through', () => {
  assert.deepEqual(DEFAULT_TIER_MAP, {
    fast: 'haiku',
    standard: 'sonnet',
    strong: 'opus',
    strongest: 'fable',
  });
  assert.equal(resolveModelTier('fast'), 'haiku');
  assert.equal(resolveModelTier('literal-model'), 'literal-model');
  assert.deepEqual(pickModel('fast', undefined, 0, policy), { model: 'haiku' });
  assert.deepEqual(pickModel('standard', undefined, 0, policy), { model: 'sonnet' });
  assert.deepEqual(pickModel('strong', undefined, 0, policy), { model: 'opus' });
  assert.deepEqual(pickModel('strongest', undefined, 0, policy), { model: 'fable' });
});

test('model policy parses effort suffixes on the last colon and clamps to the ladder', () => {
  assert.deepEqual(parseModelEffort('strong:3'), { modelPart: 'strong', effortIndex: 3 });
  assert.deepEqual(parseModelEffort('some:weird:id'), { modelPart: 'some:weird:id' });
  assert.deepEqual(parseModelEffort('sonnet:0'), { modelPart: 'sonnet:0' });
  assert.equal(EFFORT_LADDER.length, 5);
  assert.deepEqual(pickModel('strong:3', undefined, 0, policy), { model: 'opus', effort: 'high' });
  assert.deepEqual(pickModel('sonnet:9', undefined, 0, policy), { model: 'sonnet', effort: 'max' });
  assert.deepEqual(pickModel('some:weird:id', undefined, 0, policy), { model: 'some:weird:id' });
  assert.deepEqual(pickModel('sonnet:0', undefined, 0, policy), { model: 'sonnet:0' });
});

test('model policy applies express caps and deep floors in tier space', () => {
  assert.deepEqual(pickModel('strong', 'express', 0, policy), { model: 'sonnet' });
  assert.deepEqual(pickModel('standard', 'deep', 0, policy), { model: 'opus' });
  assert.deepEqual(pickModel('fast', 'deep', 0, policy), { model: 'opus' });
  assert.deepEqual(pickModel('opus', 'express', 0, policy), { model: 'opus' });
});

test('the express cap never downgrades the top tier', () => {
  // delivery.yaml states the rule directly: express caps the base at the
  // standard tier, deep floors it at strong, but `strongest` stays pinned
  // because a mentor consult exists precisely because judgment is hard — the
  // lane never downgrades it. The reference implementation gets this free by
  // leaving the top tier out of its rank table; ranking in tier space gives it
  // a rank, so the exclusion is explicit and must stay tested.
  assert.deepEqual(pickModel('strongest', 'express', 0, policy), { model: 'fable' });
  assert.deepEqual(pickModel('strongest', 'express', 6, policy), { model: 'fable' });
  assert.deepEqual(pickModel('strongest:3', 'express', 0, policy), { model: 'fable', effort: 'high' });
  // The deep floor leaves the top tier alone too — it is already above it.
  assert.deepEqual(pickModel('strongest', 'deep', 0, policy), { model: 'fable' });
});

test('reject escalation beats the express cap instead of being suppressed by it', () => {
  // The regression this pins: escalation used to be decided on the tier of the
  // ORIGINALLY AUTHORED model rather than the post-clamp one, so an
  // express-clamped `strong` step sat at the standard tier at every reject
  // count and never escalated. Escalation is upward-only and always wins over
  // an express cap — a producer stuck on repeated rejects needs capability more
  // than the lane needs the cheaper tier.
  assert.deepEqual(pickModel('strong', 'express', 0, policy), { model: 'sonnet' });
  assert.deepEqual(pickModel('strong', 'express', 3, policy), { model: 'opus' });
  assert.deepEqual(pickModel('strong', 'express', 6, policy), { model: 'opus' });
  assert.deepEqual(pickModel('fast', 'express', 3, policy), { model: 'opus' });
  assert.deepEqual(pickModel('standard', 'express', 3, policy), { model: 'opus' });

  // The delivery line's `reviewer` step is authored `model: strong:4`. With an
  // effort suffix present the threshold bumps effort first and only escalates
  // the model at twice the threshold — but it DOES escalate, which is the
  // failure this workstream exists to fix.
  assert.deepEqual(pickModel('strong:4', 'express', 0, policy), { model: 'sonnet', effort: 'xhigh' });
  assert.deepEqual(pickModel('strong:4', 'express', 3, policy), { model: 'sonnet', effort: 'max' });
  assert.deepEqual(pickModel('strong:4', 'express', 6, policy), { model: 'opus', effort: 'max' });
});

test('default retry escalation bumps effort first, then model at twice the threshold', () => {
  assert.deepEqual(pickModel('standard:2', undefined, 0, policy), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(pickModel('standard:2', undefined, 3, policy), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(pickModel('standard:2', undefined, 6, policy), { model: 'opus', effort: 'high' });
  assert.deepEqual(pickModel('standard', undefined, 3, policy), { model: 'opus' });
  assert.deepEqual(pickModel('standard:5', undefined, 3, policy), { model: 'sonnet', effort: 'max' });
});

test('configured retry escalation uses rung one below attempts and pinned rung two at attempts', () => {
  const escalation = { model: 'strong:3', attempts: 3 };
  assert.deepEqual(pickModel('standard:2', 'express', 2, policy, undefined, escalation), {
    model: 'sonnet',
    effort: 'medium',
  });
  assert.deepEqual(pickModel('standard:2', 'express', 3, policy, undefined, escalation), {
    model: 'opus',
    effort: 'high',
  });
  assert.deepEqual(pickModel('standard:2', undefined, 3, policy, undefined, {}), { model: 'opus' });
});

test('configured rung one respects the lane while rung two ignores it', () => {
  const escalation = { model: 'strong', attempts: 3 };
  assert.deepEqual(pickModel('strong', 'express', 0, policy, undefined, escalation), { model: 'sonnet' });
  assert.deepEqual(pickModel('standard', 'deep', 3, policy, undefined, escalation), { model: 'opus' });
});

test('explicit overrides replace the base and are pinned against both lane directions', () => {
  assert.deepEqual(pickModel('standard', 'express', 0, policy, 'strongest'), { model: 'fable' });
  assert.deepEqual(pickModel('strong', 'deep', 0, policy, 'standard'), { model: 'sonnet' });
  assert.deepEqual(pickModel('standard', 'express', 3, policy, 'standard'), { model: 'opus' });
  assert.deepEqual(pickModel('standard', 'express', 0, policy, 'strong:4'), { model: 'opus', effort: 'xhigh' });
});

test('tier map settings merge over defaults without removing other tiers', () => {
  const custom = createModelPolicy({ tierMap: { standard: 'custom-standard', strong: 'custom-strong' } });
  assert.deepEqual(custom.tierMap, {
    fast: 'haiku',
    standard: 'custom-standard',
    strong: 'custom-strong',
    strongest: 'fable',
  });
  assert.deepEqual(pickModel('strong', 'express', 0, custom), { model: 'custom-standard' });
  assert.deepEqual(pickModel('standard', 'deep', 0, custom), { model: 'custom-strong' });
});
