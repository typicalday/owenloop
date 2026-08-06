import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OriginRulesError,
  evaluateOriginRule,
  matchOriginRule,
  parseOriginRules,
} from '../src/crypto/origin-rules.ts';
import type { OriginVerdict } from '../src/crypto/verify-origin.ts';

const git: OriginVerdict = {
  kind: 'verified',
  source: { kind: 'git', repo: 'https://example.test/repo', commit: 'a'.repeat(40) },
  attesterKeyId: 'SHA256:test',
  principal: 'publisher',
};
const consoleOrigin: OriginVerdict = {
  kind: 'verified',
  source: { kind: 'console', user: 'alex' },
  attesterKeyId: 'SHA256:test',
  principal: 'publisher',
};
const agent: OriginVerdict = {
  kind: 'verified',
  source: { kind: 'agent', agent: 'builder', session: 'session-1' },
  attesterKeyId: 'SHA256:test',
  principal: 'publisher',
};

for (const [name, verdict] of [['git', git], ['console', consoleOrigin], ['agent', agent]] as const) {
  test(`origin rule requires git: ${name} is refused unless strong enough`, () => {
    const result = evaluateOriginRule('git', verdict);
    if (name === 'git') assert.deepEqual(result, { ok: true });
    else {
      assert.equal(result.ok, false);
      assert.equal(result.kind, 'weaker');
      assert.match(result.detail, /weaker/);
    }
  });
}

test('origin verdict states remain distinct under the weakest agent rule', () => {
  for (const verdict of [
    { kind: 'absent' } as const,
    { kind: 'unverifiable', reason: 'trust root missing' } as const,
    { kind: 'invalid', reason: 'bad signature' } as const,
  ]) {
    const result = evaluateOriginRule('agent', verdict);
    assert.equal(result.ok, false);
    assert.equal(result.kind, verdict.kind);
    assert.ok(result.detail.length > 0);
  }
});

test('origin requirements are floors: console admits git and console, agent admits all', () => {
  assert.equal(evaluateOriginRule('console', git).ok, true);
  assert.equal(evaluateOriginRule('console', consoleOrigin).ok, true);
  assert.equal(evaluateOriginRule('console', agent).ok, false);
  assert.equal(evaluateOriginRule('agent', git).ok, true);
  assert.equal(evaluateOriginRule('agent', consoleOrigin).ok, true);
  assert.equal(evaluateOriginRule('agent', agent).ok, true);
  assert.equal(evaluateOriginRule('any', { kind: 'absent' }).ok, true);
  assert.equal(evaluateOriginRule('any', { kind: 'invalid', reason: 'bad' }).ok, false);
});

test('exact rules beat prefixes and longest prefixes beat catch-all', () => {
  const rules = parseOriginRules({ '*': 'agent', 'prod*': 'console', prod: 'git' });
  assert.deepEqual(matchOriginRule(rules, 'prod'), { key: 'prod', value: 'git' });
  assert.deepEqual(matchOriginRule(rules, 'production'), { key: 'prod*', value: 'console' });
  assert.deepEqual(matchOriginRule(rules, 'sandbox'), { key: '*', value: 'agent' });
});

test('trailing namespace/name sugar and catch-all sugar normalize', () => {
  const rules = parseOriginRules({ 'prod/*': 'git', '*/*': 'any' });
  assert.deepEqual(matchOriginRule(rules, 'prod'), { key: 'prod/*', value: 'git' });
  assert.deepEqual(matchOriginRule(rules, 'other'), { key: '*/*', value: 'any' });
});

test('equal-specificity duplicate rules are named settings errors', () => {
  assert.throws(
    () => parseOriginRules({ prod: 'git', 'prod/*': 'console' }),
    (error: unknown) => {
      assert.ok(error instanceof OriginRulesError);
      assert.match(error.message, /prod/);
      assert.match(error.message, /prod\/\*/);
      return true;
    },
  );
});

test('malformed origin rule keys and values fail closed', () => {
  for (const raw of [
    { '': 'git' },
    { 'prod**': 'git' },
    { 'pr*od': 'git' },
    { 'prod?': 'git' },
    { 'prod/[x]': 'git' },
    { prod: 'unknown' },
  ]) {
    assert.throws(() => parseOriginRules(raw), OriginRulesError);
  }
});
