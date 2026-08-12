import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TIER_MAP,
  EFFORT_LADDER,
  TierProfileError,
  createModelPolicy,
  parseModelEffort,
  pickModel,
  resolveModelTier,
  validateTierProfiles,
  type TierProfiles,
} from '../src/agent/model-policy.ts';

const policy = createModelPolicy();

/** A complete, valid set of profiles — the base every profile test varies. */
function profiles(overrides: Partial<TierProfiles> = {}): TierProfiles {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'];
  return {
    fast: { model: 'haiku', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    standard: { model: 'crew-standard', efforts: all, defaultEffort: 'high' },
    strong: { model: 'crew-strong', efforts: all, defaultEffort: 'xhigh' },
    strongest: { model: 'crew-strongest', efforts: all, defaultEffort: 'xhigh' },
    ...overrides,
  };
}

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
  // SCAFFOLDING: the deep floor is the TOP tier, not `strong`. Under a `strong`
  // floor the top tier was unreachable by lane — only a def authoring
  // `strongest` outright could enter it — which made "deep" mean "second best"
  // and gave the crew no way to say otherwise. Phase 2 deletes the lane clamp
  // for per-step model arms; until then, deep means the crew's best.
  assert.deepEqual(pickModel('standard', 'deep', 0, policy), { model: 'fable' });
  assert.deepEqual(pickModel('fast', 'deep', 0, policy), { model: 'fable' });
  assert.deepEqual(pickModel('opus', 'express', 0, policy), { model: 'opus' });
});

test('the express cap never downgrades the top tier', () => {
  // delivery.yaml states the rule directly: express caps the base at the
  // standard tier, deep floors it at the top, but `strongest` stays pinned
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

test('a configured escalation raises the lane-clamped tier and never lowers it', () => {
  const escalation = { model: 'strong', attempts: 3 };
  // Below the threshold the lane owns the tier: express caps `strong` at standard.
  assert.deepEqual(pickModel('strong', 'express', 0, policy, undefined, escalation), { model: 'sonnet' });

  // At the threshold the escalation applies MONOTONICALLY — it takes the higher
  // of {lane-clamped tier, escalation tier}. Here deep already floored the step
  // at the top tier, so an escalation naming `strong` leaves it there.
  //
  // Returning the escalation tier outright, as this did before, DEMOTED the
  // step: it moved to a weaker model at the exact moment three rejects said the
  // work was hard. The def author writes ONE escalation for a step that runs on
  // three lanes and cannot know which lane is live, so the escalation states a
  // floor, not a destination.
  assert.deepEqual(pickModel('standard', 'deep', 3, policy, undefined, escalation), { model: 'fable' });

  // It still RAISES where the lane left the step lower than the escalation.
  assert.deepEqual(pickModel('fast', 'express', 3, policy, undefined, escalation), { model: 'opus' });
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
  // The deep floor is the top tier, which this custom map did NOT override —
  // so it silently inherits Anthropic's `fable`. That merge is exactly the
  // footgun `tierProfiles` refuses to reproduce.
  assert.deepEqual(pickModel('standard', 'deep', 0, custom), { model: 'fable' });
});

// ---- tier profiles ---------------------------------------------------------

test('a tier profile supplies both the model and the effort', () => {
  const p = createModelPolicy({ tierProfiles: profiles() });
  // No effort authored anywhere: the profile's defaultEffort answers.
  assert.deepEqual(pickModel('strong', undefined, 0, p), { model: 'crew-strong', effort: 'xhigh' });
  assert.deepEqual(pickModel('standard', undefined, 0, p), { model: 'crew-standard', effort: 'high' });
  assert.deepEqual(pickModel('fast', undefined, 0, p), { model: 'haiku', effort: 'medium' });
});

test('an authored effort suffix still outranks the profile default', () => {
  // Not an endorsement — this is why delivery.yaml stopped authoring suffixes.
  // The behavior has to be defined, and "the def wins" is the only reading
  // consistent with the suffix being parsed from the def in the first place.
  const p = createModelPolicy({ tierProfiles: profiles() });
  assert.deepEqual(pickModel('strong:1', undefined, 0, p), { model: 'crew-strong', effort: 'low' });
});

test('a wanted rung the model does not offer snaps UP to the next one', () => {
  // The `fast` profile offers low/medium/high. Wanting xhigh has nowhere above
  // to go and throws (see below); wanting a rung INSIDE the range that is
  // merely absent snaps up, never down — under-thinking produces a wrong
  // answer that looks right, which is worse than paying for one rung more.
  const p = createModelPolicy({
    tierProfiles: profiles({
      strong: { model: 'gappy', efforts: ['low', 'xhigh'], defaultEffort: 'low' },
    }),
  });
  assert.deepEqual(pickModel('strong:3', undefined, 0, p), { model: 'gappy', effort: 'xhigh' });
  assert.deepEqual(pickModel('strong:2', undefined, 0, p), { model: 'gappy', effort: 'xhigh' });
  assert.deepEqual(pickModel('strong:1', undefined, 0, p), { model: 'gappy', effort: 'low' });
});

test('a wanted rung above the model ceiling FAILS CLOSED', () => {
  // There is nothing to snap up to. Silently running at `high` when the step
  // asked for `max` would bill for a result nobody chose the conditions of.
  const p = createModelPolicy({ tierProfiles: profiles() });
  assert.throws(() => pickModel('fast:5', undefined, 0, p), (e: unknown) => {
    assert.ok(e instanceof TierProfileError);
    assert.match((e as Error).message, /tops out below the requested effort 'max'/);
    return true;
  });
});

test('profiles must define every tier — they are not merged with defaults', () => {
  // tierMap merges, so a three-tier map silently inherits a fourth model the
  // crew never chose. Profiles refuse that: incomplete is a load-time error.
  const partial = profiles();
  const { strongest: _dropped, ...missing } = partial;
  assert.throws(() => createModelPolicy({ tierProfiles: missing as TierProfiles }), (e: unknown) => {
    assert.ok(e instanceof TierProfileError);
    assert.match((e as Error).message, /missing tier 'strongest'/);
    return true;
  });
});

test('profile validation rejects unknown rungs and an unofferable default', () => {
  assert.throws(
    () => validateTierProfiles(profiles({
      fast: { model: 'haiku', efforts: ['low', 'blazing'], defaultEffort: 'low' },
    })),
    /unknown rung 'blazing'/,
  );
  assert.throws(
    () => validateTierProfiles(profiles({
      fast: { model: 'haiku', efforts: ['low'], defaultEffort: 'max' },
    })),
    /defaultEffort 'max' is not in efforts \[low\]/,
  );
});

test('the lane picks the tier and the profile picks the effort for it', () => {
  // The two mechanisms compose without either knowing about the other: the
  // lane settles a TIER, the profile for that tier settles model and effort.
  // This is what the old `tier:N` form could not express — effort was parsed
  // once from the def and passed through unchanged, so every lane of a step
  // ran at the same effort however far the lane moved the model.
  const p = createModelPolicy({ tierProfiles: profiles() });
  assert.deepEqual(pickModel('strong', 'express', 0, p), { model: 'crew-standard', effort: 'high' });
  assert.deepEqual(pickModel('strong', undefined, 0, p), { model: 'crew-strong', effort: 'xhigh' });
  assert.deepEqual(pickModel('strong', 'deep', 0, p), { model: 'crew-strongest', effort: 'xhigh' });
});

test('escalation under profiles resolves through the escalated tier profile', () => {
  const p = createModelPolicy({ tierProfiles: profiles() });
  const escalation = { model: 'strongest', attempts: 3 };
  assert.deepEqual(pickModel('strong', undefined, 2, p, undefined, escalation), {
    model: 'crew-strong',
    effort: 'xhigh',
  });
  assert.deepEqual(pickModel('strong', undefined, 3, p, undefined, escalation), {
    model: 'crew-strongest',
    effort: 'xhigh',
  });
});

test('a literal model id bypasses profiles entirely', () => {
  // There is no tier to look a profile up by, so nothing supplies an effort.
  const p = createModelPolicy({ tierProfiles: profiles() });
  assert.deepEqual(pickModel('gpt-5.6-sol', undefined, 0, p), { model: 'gpt-5.6-sol' });
  assert.deepEqual(pickModel('strong', undefined, 0, p, 'gpt-5.6-sol'), { model: 'gpt-5.6-sol' });
});
