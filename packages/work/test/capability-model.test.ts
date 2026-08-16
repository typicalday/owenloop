/**
 * Crew-roster shape, exact-first lookup, and candidate-selection tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  capabilityNamePart,
  EFFORT_LADDER,
  resolveCapabilityCandidates,
  RosterError,
  selectCandidate,
  validateRoster,
  type Roster,
} from '../src/agent/capability-model.ts';

test('capabilityNamePart splits on the first separator only', () => {
  assert.equal(capabilityNamePart('wise:deep'), 'wise');
  assert.equal(capabilityNamePart('wise:deep:extra'), 'wise');
  assert.equal(capabilityNamePart('wise'), 'wise');
  assert.equal(capabilityNamePart(''), '');
});

const ROSTER: Roster = {
  'wise:deep': [{ harness: 'first', model: 'fable', effort: 'xhigh' }],
  'build:deep': [{ harness: 'first', model: 'opus', effort: 'xhigh' }],
  wise: [{ harness: 'first', model: 'opus', effort: 'high' }],
  build: [{ harness: 'first', model: 'sonnet', effort: 'high' }],
};

test('an exact compound roster row wins and names the key that matched', () => {
  assert.deepEqual(resolveCapabilityCandidates(ROSTER, ['wise:deep']), {
    capability: 'wise:deep',
    match: 'exact',
    candidates: [{ harness: 'first', model: 'fable', effort: 'xhigh' }],
  });
});

test('a compound with no exact row falls back to its bare roster row', () => {
  assert.deepEqual(resolveCapabilityCandidates(ROSTER, ['wise:express']), {
    capability: 'wise',
    match: 'bare',
    candidates: [{ harness: 'first', model: 'opus', effort: 'high' }],
  });
});

test('an exact row on a later capability beats a bare row on an earlier one', () => {
  const got = resolveCapabilityCandidates(ROSTER, ['build:express', 'wise:deep']);
  assert.equal(got?.capability, 'wise:deep');
  assert.equal(got?.match, 'exact');
});

test('a bare capability that hits its own row reports exact, never bare', () => {
  assert.equal(resolveCapabilityCandidates(ROSTER, ['wise'])?.match, 'exact');
});

test('no roster row resolves to undefined', () => {
  assert.equal(resolveCapabilityCandidates(ROSTER, ['paint:deep']), undefined);
  assert.equal(resolveCapabilityCandidates({}, []), undefined);
});

test('validateRoster rejects old and malformed candidate shapes', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['empty capability', { '': [{ harness: 'h', model: 'm', effort: 'high' }] }, /may not be empty/u],
    ['old object row', { wise: { model: 'm', effort: 'high' } }, /non-empty array.*harness/u],
    ['empty array', { wise: [] }, /non-empty array/u],
    ['missing harness', { wise: [{ model: 'm', effort: 'high' }] }, /\[0\]\.harness/u],
    ['missing model', { wise: [{ harness: 'h', effort: 'high' }] }, /\[0\]\.model/u],
    ['missing effort', { wise: [{ harness: 'h', model: 'm' }] }, /\[0\]\.effort/u],
    ['unknown key', { wise: [{ harness: 'h', model: 'm', effort: 'high', extra: true }] }, /unknown key/u],
    ['off ladder effort', { wise: [{ harness: 'h', model: 'm', effort: 'higher' }] }, /one of/u],
  ];
  for (const [label, roster, expected] of cases) {
    assert.throws(() => validateRoster(roster), RosterError, label);
    assert.throws(() => validateRoster(roster), expected, label);
  }
});

test('validateRoster accepts every ladder effort and does not judge model ids', () => {
  for (const effort of EFFORT_LADDER) {
    validateRoster({ wise: [{ harness: 'future-harness', model: 'future-model', effort }] });
  }
});

test('selectCandidate uses the first available candidate in roster order', () => {
  const candidates = [
    { harness: 'first', model: 'm1', effort: 'high' },
    { harness: 'second', model: 'm2', effort: 'high' },
  ] as const;
  assert.deepEqual(selectCandidate(candidates, undefined, (id) => id === 'first'), {
    kind: 'selected',
    candidate: candidates[0],
  });
  assert.deepEqual(selectCandidate(candidates, undefined, (id) => id === 'second'), {
    kind: 'selected',
    candidate: candidates[1],
  });
});

test('selectCandidate applies step harness policy before availability', () => {
  const candidates = [
    { harness: 'first', model: 'm1', effort: 'high' },
    { harness: 'second', model: 'm2', effort: 'high' },
  ] as const;
  assert.deepEqual(selectCandidate(candidates, 'second', () => true), {
    kind: 'selected',
    candidate: candidates[1],
  });
  assert.deepEqual(selectCandidate(candidates, 'third', () => true), {
    kind: 'harness-policy',
    offered: ['first', 'second'],
  });
  assert.deepEqual(selectCandidate(candidates, 'second', () => false), {
    kind: 'none-available',
    offered: ['second'],
  });
});
