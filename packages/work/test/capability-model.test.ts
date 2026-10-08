/**
 * Crew-roster shape, exact-first lookup, and candidate-selection tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  capabilityNamePart,
  EFFORT_LADDER,
  extractAuthorizedCandidates,
  evaluateAuthorizedSelection,
  resolveCapabilityCandidates,
  RosterError,
  selectCandidate,
  validateRoster,
  type Roster,
  type AuthorizedSelectionInput,
} from '../src/agent/capability-model.ts';
import type { LocalModelTuple, LocalTupleEligibility, RoleModelPolicy } from '../src/hub/types.ts';

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

test('lookup accepts own prototype-colliding rows and ignores inherited ones', () => {
  const roster = Object.create(null) as Record<string, readonly { harness: string; model: string; effort: string }[]>;
  roster['__proto__'] = [{ harness: 'proto', model: 'proto-model', effort: 'high' }];
  roster['constructor'] = [{ harness: 'constructor', model: 'constructor-model', effort: 'high' }];
  roster['toString'] = [{ harness: 'stringify', model: 'stringify-model', effort: 'high' }];

  for (const capability of ['__proto__', 'constructor', 'toString']) {
    assert.equal(resolveCapabilityCandidates(roster, [capability])?.capability, capability);
  }
  assert.equal(resolveCapabilityCandidates({}, ['constructor']), undefined);
  assert.equal(resolveCapabilityCandidates({}, ['toString']), undefined);
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

const ASTRA: LocalModelTuple = { id: 'astra-high', harness: 'codex', model: 'gpt-6-astra', effort: 'high' };
const ASTRA_MAX: LocalModelTuple = { ...ASTRA, id: 'astra-max', effort: 'max' };
const LUNA: LocalModelTuple = { id: 'luna-high', harness: 'codex', model: 'gpt-5.6-luna', effort: 'high' };
const POLICY: RoleModelPolicy = {
  revision: 'policy-1', unknownRole: 'refuse',
  rules: [
    { model: ASTRA.model, roles: ['research', 'implementation', 'review', 'judge'] },
    { model: LUNA.model, roles: ['research'] },
  ],
};
const eligible = (tuple: LocalModelTuple): LocalTupleEligibility => ({ tuple, eligible: true, available: true });

function authorizedInput(): AuthorizedSelectionInput {
  const tuples = [eligible(ASTRA), eligible(ASTRA_MAX), eligible(LUNA)];
  return structuredClone({
    roster: { crew: 'delivery', rows: {
      'build:deep': { source: 'machine crew', candidates: [ASTRA, ASTRA_MAX, LUNA] },
      build: { source: 'hub crew', candidates: [LUNA] },
    } },
    authorizedRow: { crew: 'delivery', capability: 'build:deep', source: 'machine crew' },
    capabilities: ['build:deep'],
    binding: { issuedAt: 100, expiresAt: 300, revisions: { roster: 'generation-7', rolePolicy: 'policy-1' } },
    preference: {
      role: 'implementation', rolePolicy: POLICY, rosterRevision: 'content-abc', expiresAt: 250, tuples,
      offer: {
        version: 'shift-offer-v1', offerId: 'offer', orgId: 'org', principalId: 'principal',
        sessionId: 'session', shiftId: 'shift', willingness: { runIds: ['run'], crewIds: ['delivery'], capabilities: ['build:deep'] },
        rosterRevision: 'content-abc', rolePolicyRevision: 'policy-1', issuedAt: 100, expiresAt: 280, tuples,
      },
    },
    current: {
      now: 200, role: 'implementation', rolePolicy: POLICY, rosterRevision: 'content-abc',
      rosterGeneration: 'generation-7', tuples, installedHarnesses: ['codex'],
    },
  });
}

test('candidate extraction preserves authorized roster order for service assessment', () => {
  const input = authorizedInput();
  const extracted = extractAuthorizedCandidates(input);
  assert.equal(extracted.refusal, null);
  assert.deepEqual(extracted.candidates, [ASTRA, ASTRA_MAX]);
  assert.deepEqual(extracted.row, input.authorizedRow);
  assert.equal(extracted.match, 'exact');

  input.capabilities = ['build:express', 'build:deep'];
  const exactStillWins = extractAuthorizedCandidates(input);
  assert.deepEqual(exactStillWins.candidates, [ASTRA, ASTRA_MAX]);
  assert.equal(exactStillWins.match, 'exact');
});

function expectRefusal(input: AuthorizedSelectionInput, reason: string): void {
  const result = evaluateAuthorizedSelection(input);
  assert.equal(result.kind, 'refused');
  assert.equal(result.reason, reason);
  assert.equal(result.selected, null);
}

test('authorized selection retains tuple ID and distinct revision provenance', () => {
  const input = authorizedInput();
  input.preferred = ASTRA_MAX;
  const result = evaluateAuthorizedSelection(input);
  assert.equal(result.kind, 'selected');
  assert.equal(result.reason, 'preferred');
  assert.deepEqual(result.requested, ASTRA_MAX);
  assert.deepEqual(result.selected, ASTRA_MAX);
  assert.deepEqual(result.row, input.authorizedRow);
  assert.deepEqual(result.revisions, { rosterContent: 'content-abc', rosterGeneration: 'generation-7', rolePolicy: 'policy-1' });
  delete input.preferred;
  assert.equal(evaluateAuthorizedSelection(input).reason, 'roster-order');
  assert.deepEqual(evaluateAuthorizedSelection(input).selected, ASTRA);
});

test('authorized exact-before-bare lookup spans all capabilities', () => {
  const input = authorizedInput();
  input.capabilities = ['build:express', 'build:deep'];
  assert.deepEqual(evaluateAuthorizedSelection(input).selected, ASTRA);
  input.capabilities = ['build:express'];
  input.authorizedRow = { crew: 'delivery', capability: 'build', source: 'hub crew' };
  input.current.role = input.preference.role = 'research';
  assert.deepEqual(evaluateAuthorizedSelection(input).selected, LUNA);
  assert.equal(evaluateAuthorizedSelection(input).match, 'bare');
});

test('authorized lookup treats own prototype-name rows as data', () => {
  for (const capability of ['__proto__', 'constructor', 'toString']) {
    const input = authorizedInput();
    input.roster.rows = Object.fromEntries([[capability, { source: 'machine crew', candidates: [ASTRA] }]]);
    input.capabilities = [capability];
    input.authorizedRow.capability = capability;
    assert.deepEqual(evaluateAuthorizedSelection(input).selected, ASTRA);
    input.roster.rows = {};
    expectRefusal(input, 'no-row');
  }
});

test('selection refuses a different stamped crew, row, or stronger layer', () => {
  for (const key of ['crew', 'capability', 'source'] as const) {
    const input = authorizedInput();
    input.authorizedRow[key] = 'another';
    expectRefusal(input, 'unauthorized-row');
  }
});

test('an unavailable exact row never falls through to bare, another capability, or a weaker layer', () => {
  const input = authorizedInput();
  input.current.role = input.preference.role = 'research';
  input.roster.rows = {
    'build:deep': { source: 'machine crew', candidates: [ASTRA] },
    build: { source: 'hub crew', candidates: [LUNA] },
    'research:deep': { source: 'hub org', candidates: [LUNA] },
  };
  input.capabilities = ['build:deep', 'research:deep'];
  input.current.tuples = [eligible(LUNA)];
  input.preferred = LUNA;
  expectRefusal(input, 'none-eligible');
  // An explicitly empty strongest row is still the winner, never a signal
  // to recover candidates from a weaker source.
  input.roster.rows = { ...input.roster.rows, 'build:deep': { source: 'machine crew', candidates: [] } };
  expectRefusal(input, 'none-eligible');
});

test('unavailable or absent preference falls back deterministically within the same row', () => {
  const input = authorizedInput();
  input.preferred = ASTRA;
  input.current.tuples = [eligible(ASTRA_MAX), eligible(LUNA)];
  const result = evaluateAuthorizedSelection(input);
  assert.equal(result.kind, 'fallback');
  assert.equal(result.reason, 'preferred-ineligible');
  assert.deepEqual(result.requested, ASTRA);
  assert.deepEqual(result.selected, ASTRA_MAX);
  assert.deepEqual(result.row, input.authorizedRow);
  delete input.preferred;
  assert.equal(evaluateAuthorizedSelection(input).reason, 'roster-fallback');
});

test('a preferred ID requires exact harness, model, effort and row membership', () => {
  for (const replacement of [
    { id: 'unknown' }, { harness: 'other' }, { model: LUNA.model }, { effort: 'low' as const },
  ]) {
    const input = authorizedInput();
    input.preferred = { ...ASTRA_MAX, ...replacement };
    const result = evaluateAuthorizedSelection(input);
    assert.equal(result.kind, 'fallback');
    assert.deepEqual(result.selected, ASTRA);
  }
  const input = authorizedInput();
  input.roster.rows = { 'build:deep': { source: 'machine crew', candidates: [ASTRA] } };
  input.preferred = ASTRA_MAX;
  assert.deepEqual(evaluateAuthorizedSelection(input).selected, ASTRA);
});

test('offer, preference and current tuple eligibility are independent constraints', () => {
  for (const set of ['offer', 'preference', 'current'] as const) {
    for (const change of ['absent', 'ineligible', 'unavailable', 'components', 'ambiguous-id'] as const) {
      const input = authorizedInput();
      input.roster.rows = { 'build:deep': { source: 'machine crew', candidates: [ASTRA] } };
      input.preferred = ASTRA;
      const owner = set === 'offer' ? input.preference.offer! : input[set];
      owner.tuples = change === 'absent' ? []
        : change === 'ambiguous-id' ? [eligible(ASTRA), eligible({ ...ASTRA, model: LUNA.model })]
        : [{ tuple: change === 'components' ? { ...ASTRA, effort: 'low' } : ASTRA,
          eligible: change !== 'ineligible', available: change !== 'unavailable' }];
      expectRefusal(input, 'none-eligible');
    }
  }
});

test('same installed harness does not authorize a different model or unavailable tuple', () => {
  const input = authorizedInput();
  input.preferred = LUNA;
  input.current.tuples = [eligible(LUNA)];
  expectRefusal(input, 'none-eligible');
  input.current.role = input.preference.role = 'research';
  assert.deepEqual(evaluateAuthorizedSelection(input).selected, LUNA);
  input.current.installedHarnesses = [];
  expectRefusal(input, 'none-eligible');
});

test('hard harness filters before preference and availability', () => {
  const input = authorizedInput();
  const other: LocalModelTuple = { ...ASTRA, id: 'other-astra', harness: 'other' };
  input.roster.rows = { 'build:deep': { source: 'machine crew', candidates: [ASTRA, other] } };
  input.preference.tuples = input.preference.offer!.tuples = input.current.tuples = [eligible(ASTRA), eligible(other)];
  input.current.installedHarnesses = ['codex', 'other'];
  input.preferred = ASTRA;
  input.stepHarness = 'other';
  assert.deepEqual(evaluateAuthorizedSelection(input).selected, other);
  input.current.installedHarnesses = ['codex'];
  expectRefusal(input, 'none-eligible');
  input.stepHarness = 'absent';
  expectRefusal(input, 'harness-policy');
  input.stepHarness = '';
  assert.deepEqual(evaluateAuthorizedSelection(input).selected, ASTRA);
});

test('trusted policy keeps Luna research-only and Astra on implementation and review', () => {
  for (const role of ['research', 'implementation', 'review', 'judge']) {
    const input = authorizedInput();
    input.current.role = input.preference.role = role;
    input.preferred = LUNA;
    assert.deepEqual(evaluateAuthorizedSelection(input).selected, role === 'research' ? LUNA : ASTRA);
  }
  const input = authorizedInput();
  input.current.rolePolicy = { ...POLICY, rules: [{ model: LUNA.model, roles: ['research'] }] };
  expectRefusal(input, 'none-eligible');
  input.current.rolePolicy = { ...POLICY, rules: [] };
  expectRefusal(input, 'none-eligible');
});

test('unknown or changed roles and missing policy refuse instead of legacy fallback', () => {
  for (const role of ['unknown', 'design', 'constructor', '']) {
    const input = authorizedInput();
    input.current.role = input.preference.role = role;
    expectRefusal(input, 'role-policy');
  }
  const input = authorizedInput();
  input.current.role = 'research';
  expectRefusal(input, 'role-policy');
  for (const side of ['current', 'preference'] as const) {
    const missing = authorizedInput();
    missing[side].rolePolicy = null;
    expectRefusal(missing, 'role-policy');
  }
});

test('stale content, scoped generation or policy revisions refuse independently', () => {
  const cases: Array<(input: AuthorizedSelectionInput) => void> = [
    input => { input.current.rosterRevision = 'new-content'; },
    input => { input.preference.rosterRevision = 'old-content'; },
    input => { input.preference.offer!.rosterRevision = 'old-content'; },
    input => { input.current.rosterGeneration = 'generation-8'; },
    input => { input.binding.revisions.roster = 'generation-6'; },
    input => { input.binding.revisions.rolePolicy = 'policy-0'; },
    input => { input.preference.offer!.rolePolicyRevision = 'policy-0'; },
    input => { input.preference.rolePolicy = { ...POLICY, revision: 'policy-0' }; },
    input => { input.current.rolePolicy = { ...POLICY, revision: 'policy-2' }; },
    input => { input.current.rosterRevision = input.preference.rosterRevision = input.preference.offer!.rosterRevision = ''; },
  ];
  for (const change of cases) {
    const input = authorizedInput();
    change(input);
    expectRefusal(input, 'stale-revisions');
  }
});

test('expired, future or nonfinite time windows cannot be rescued by fallback', () => {
  for (const side of ['binding', 'preference', 'offer'] as const) {
    for (const expiresAt of [199, 200, NaN, Infinity]) {
      const input = authorizedInput();
      (side === 'offer' ? input.preference.offer! : input[side]).expiresAt = expiresAt;
      expectRefusal(input, 'stale-window');
    }
  }
  for (const side of ['binding', 'offer'] as const) {
    const input = authorizedInput();
    (side === 'offer' ? input.preference.offer! : input.binding).issuedAt = 201;
    expectRefusal(input, 'stale-window');
  }
  const input = authorizedInput();
  input.current.now = NaN;
  expectRefusal(input, 'stale-window');
  input.current.now = 200;
  input.preference.offer = null;
  expectRefusal(input, 'missing-offer');
});

test('authorized evaluator does not infer a provider taxonomy or mutate its snapshots', () => {
  const input = authorizedInput();
  const future: LocalModelTuple = { id: 'future-id', harness: 'future-harness', model: 'future-model', effort: 'high' };
  input.roster.rows = { 'build:deep': { source: 'machine crew', candidates: [future] } };
  input.preference.tuples = input.preference.offer!.tuples = input.current.tuples = [eligible(future)];
  input.preference.rolePolicy = input.current.rolePolicy = { ...POLICY, rules: [{ model: future.model, roles: ['implementation'] }] };
  input.current.installedHarnesses = [future.harness];
  input.preferred = future;
  const before = structuredClone(input);
  function freeze(value: unknown): void {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
  }
  freeze(input);
  const result = evaluateAuthorizedSelection(input);
  assert.deepEqual(result.selected, future);
  assert.deepEqual(input, before);
  assert.notEqual(result.selected, input.preferred);
  assert.notEqual(result.requested, input.preferred);
  assert.notEqual(result.row, input.authorizedRow);
});
