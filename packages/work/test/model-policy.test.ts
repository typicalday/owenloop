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
  assert.deepEqual(pickModel('strongest', 'express', 0, policy), { model: 'sonnet' });
  assert.deepEqual(pickModel('standard', 'deep', 0, policy), { model: 'opus' });
  assert.deepEqual(pickModel('fast', 'deep', 0, policy), { model: 'opus' });
  assert.deepEqual(pickModel('opus', 'express', 0, policy), { model: 'opus' });
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
