/** Quality-tier resolution and retry escalation for agent orders. */

/** Shipped quality tiers. A settings tierMap may override any entry. */
export const DEFAULT_TIER_MAP = {
  fast: 'haiku',
  standard: 'sonnet',
  strong: 'opus',
  strongest: 'fable',
} as const;

/** Reasoning rungs accepted by the neutral start contract. */
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const TIER_INDEX: Readonly<Record<string, number>> = {
  fast: 0,
  standard: 1,
  strong: 2,
  strongest: 3,
};

/** Tier index -> tier name, so a clamp can resolve to an id at the very end. */
const TIER_NAMES = ['fast', 'standard', 'strong', 'strongest'] as const;

export type ModelLane = 'express' | 'standard' | 'deep';

export interface ModelEscalation {
  model?: string;
  attempts?: number;
}

/**
 * What ONE tier means to ONE crew: which model, which reasoning rungs that
 * model actually supports, and how hard it thinks when the workflow does not
 * say.
 *
 * This exists because `tierMap` can only answer half the question. A tierMap
 * entry is a bare model id, so a workflow that wanted a specific reasoning
 * effort had to write it into the def as a `tier:N` suffix — and a def is
 * shared by every crew that runs it, while reasoning support is a property of
 * the specific model a crew happens to bind. The suffix therefore leaked a
 * crew-local fact into a crew-neutral file, and it outranked the crew besides:
 * an authored effort is parsed once from the def and passed through unchanged.
 *
 * `efforts` is the crew's honest statement of what its model accepts. It is
 * NOT a preference list — see resolveEffort for how a gap is handled and why
 * exceeding the ceiling is an error rather than a downgrade.
 */
export interface TierProfile {
  /** The concrete model id this tier resolves to for this crew. */
  model: string;
  /** The reasoning rungs `model` supports, as EFFORT_LADDER names. */
  efforts: readonly string[];
  /** The rung used when the workflow authored no effort. Must be in `efforts`. */
  defaultEffort: string;
}

/** One profile per tier. Every tier in TIER_NAMES must be present. */
export type TierProfiles = Readonly<Record<string, TierProfile>>;

export interface ModelPolicy {
  /** Resolved tier names; this map is merged with DEFAULT_TIER_MAP by createModelPolicy. */
  tierMap: Readonly<Record<string, string>>;
  /**
   * Per-tier model AND effort. When present this REPLACES tierMap for every
   * tier-named input: the profile decides both halves. Absent, resolution is
   * exactly the tierMap behavior that shipped before profiles existed.
   */
  tierProfiles?: TierProfiles;
  /** Reject count at which the default policy escalates. */
  escalateAt: number;
  /** Extension namespace containing the authored escalation object. */
  escalationExtensionKey: string;
}

export interface PickModelResult {
  model: string;
  effort?: string;
}

export interface ModelPolicyOptions {
  tierMap?: Record<string, string>;
  tierProfiles?: TierProfiles;
  escalateAt?: number;
  escalationExtensionKey?: string;
}

/** Thrown when a crew's tier profiles are unusable. Never silently repaired. */
export class TierProfileError extends Error {}

/**
 * Reject profiles that would resolve wrongly rather than loudly.
 *
 * COMPLETENESS IS THE POINT. `tierMap` is MERGED over DEFAULT_TIER_MAP, so a
 * crew that names three tiers silently inherits the built-in default for the
 * fourth — a step lands on a model the crew never chose and nothing says so.
 * Profiles are not merged. All four tiers or the load fails.
 */
export function validateTierProfiles(profiles: TierProfiles, ctx = 'tierProfiles'): void {
  for (const tier of TIER_NAMES) {
    const profile = profiles[tier];
    if (profile === undefined) {
      throw new TierProfileError(
        `${ctx}: missing tier '${tier}' — all of ${TIER_NAMES.join(', ')} must be defined (profiles are not merged with defaults)`,
      );
    }
    if (typeof profile.model !== 'string' || profile.model.trim() === '') {
      throw new TierProfileError(`${ctx}.${tier}.model must be a non-empty string`);
    }
    if (!Array.isArray(profile.efforts) || profile.efforts.length === 0) {
      throw new TierProfileError(`${ctx}.${tier}.efforts must be a non-empty list of ${EFFORT_LADDER.join('|')}`);
    }
    for (const effort of profile.efforts) {
      if (!EFFORT_LADDER.includes(effort as (typeof EFFORT_LADDER)[number])) {
        throw new TierProfileError(`${ctx}.${tier}.efforts: unknown rung '${effort}' (expected one of ${EFFORT_LADDER.join(', ')})`);
      }
    }
    if (!profile.efforts.includes(profile.defaultEffort)) {
      throw new TierProfileError(
        `${ctx}.${tier}.defaultEffort '${profile.defaultEffort}' is not in efforts [${profile.efforts.join(', ')}]`,
      );
    }
  }
}

/**
 * Resolve a wanted rung against the rungs a model actually supports.
 *
 * TWO DIFFERENT SITUATIONS, TWO DIFFERENT ANSWERS.
 *
 *   GAP — the wanted rung sits between supported rungs (want `high`, model
 *   supports low/xhigh). Snap UP to the next supported rung. Snapping down
 *   would quietly give a step less thinking than the workflow asked for, and
 *   the failure of under-thinking is a wrong answer that looks right.
 *
 *   CEILING — the wanted rung is above everything the model supports (want
 *   `max`, model tops out at `high`). There is nothing to snap up to. This
 *   THROWS. It is a crew configuration error: the crew bound a tier to a model
 *   that cannot do the work the tier was asked for, and the honest response is
 *   to say so at the point of resolution rather than run the step at a rung
 *   nobody chose and bill for the result.
 */
export function resolveEffort(profile: TierProfile, wanted: string, ctx: string): string {
  const wantedIndex = EFFORT_LADDER.indexOf(wanted as (typeof EFFORT_LADDER)[number]);
  if (wantedIndex === -1) throw new TierProfileError(`${ctx}: unknown effort '${wanted}'`);

  let best: { name: string; index: number } | undefined;
  for (const supported of profile.efforts) {
    const index = EFFORT_LADDER.indexOf(supported as (typeof EFFORT_LADDER)[number]);
    if (index < wantedIndex) continue;
    if (best === undefined || index < best.index) best = { name: supported, index };
  }
  if (best === undefined) {
    throw new TierProfileError(
      `${ctx}: model '${profile.model}' supports [${profile.efforts.join(', ')}], which tops out below the requested effort '${wanted}'`,
    );
  }
  return best.name;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  tierMap: DEFAULT_TIER_MAP,
  escalateAt: 3,
  escalationExtensionKey: 'delivery',
};

/** Build a normalized policy from optional machine-local settings. */
export function createModelPolicy(options: ModelPolicyOptions = {}): ModelPolicy {
  if (options.tierProfiles !== undefined) validateTierProfiles(options.tierProfiles);
  return {
    tierMap: { ...DEFAULT_TIER_MAP, ...(options.tierMap ?? {}) },
    ...(options.tierProfiles !== undefined ? { tierProfiles: options.tierProfiles } : {}),
    escalateAt: options.escalateAt ?? DEFAULT_MODEL_POLICY.escalateAt,
    escalationExtensionKey:
      options.escalationExtensionKey ?? DEFAULT_MODEL_POLICY.escalationExtensionKey,
  };
}

/** Resolve a tier name, passing through a literal model id unchanged. */
export function resolveModelTier(
  model: string,
  tierMap: Readonly<Record<string, string>> = DEFAULT_TIER_MAP,
): string {
  return tierMap[model] ?? model;
}

/** Split a trailing positive integer effort suffix from a model string. */
export function parseModelEffort(raw: string): { modelPart: string; effortIndex?: number } {
  const separator = raw.lastIndexOf(':');
  if (separator === -1) return { modelPart: raw };
  const tail = raw.slice(separator + 1);
  if (!/^[1-9]\d*$/.test(tail)) return { modelPart: raw };
  return { modelPart: raw.slice(0, separator), effortIndex: Number(tail) };
}

function tierForInput(modelPart: string): number | undefined {
  return TIER_INDEX[modelPart];
}

/**
 * Apply the lane to a tier index, in tier space.
 *
 * express caps at `standard`, with one exception: the express cap never touches
 * the TOP tier. A step authored at the top tier is there because the judgment
 * it makes is hard, so the lane's cost heuristic must not downgrade it — the
 * lane scales cost, it does not overrule an explicit escalation of quality. The
 * reference implementation gets this for free by leaving the top tier out of
 * its rank table; ranking in tier space gives the top tier a rank, so the
 * exclusion has to be stated here.
 *
 * SCAFFOLDING — the deep floor. Deep floors at `strongest`, not `strong`, so
 * that a plan marked deep actually reaches the crew's best model. Under the
 * previous `strong` floor the top tier was unreachable by lane at all: it could
 * only ever be entered by a def authoring `strongest` outright, which made
 * "deep lane" mean "second best" and left the crew no way to say otherwise.
 *
 * This is a blunt instrument and it is meant to be temporary. It cannot express
 * "deep means opus for the builder but fable for the reviewer" except by giving
 * those steps different crews, and it treats a `fast` step marked deep the same
 * as a `strong` one. Phase 2 replaces the whole lane clamp with per-step model
 * arms resolved from instance facts, at which point THIS FUNCTION IS DELETED.
 * Do not build on it.
 */
function clampTierForLane(tier: number, lane: ModelLane | undefined): number {
  if (lane === 'express' && tier > TIER_INDEX['standard']! && tier !== TIER_INDEX['strongest']!) {
    return TIER_INDEX['standard']!;
  }
  if (lane === 'deep' && tier < TIER_INDEX['strongest']!) return TIER_INDEX['strongest']!;
  return tier;
}

/** Resolve a tier index back to a concrete model id through the policy map. */
function modelForTier(tier: number, tierMap: Readonly<Record<string, string>>): string {
  const name = TIER_NAMES[tier]!;
  return tierMap[name] ?? name;
}

/**
 * Turn a settled tier index plus a wanted effort into the final order.
 *
 * This is the ONLY place a tier becomes a model, so it is the only place the
 * profile/tierMap fork lives. A profile answers both halves; without one this
 * is exactly the tierMap behavior that shipped before.
 *
 * Reached only when the input named a TIER. A literal model id (`sonnet`,
 * `gpt-5.6-sol`) or a `--model` override that is not a tier name never lands
 * here: there is no tier to look a profile up by, so it passes through with
 * whatever effort was authored beside it.
 */
function resultForTier(
  tier: number,
  effortIndex: number | undefined,
  policy: ModelPolicy,
  ctx: string,
): PickModelResult {
  const name = TIER_NAMES[tier]!;
  const profile = policy.tierProfiles?.[name];
  if (profile === undefined) return withEffort(modelForTier(tier, policy.tierMap), effortIndex);
  const wanted = effortIndex === undefined ? profile.defaultEffort : effortName(effortIndex);
  return { model: profile.model, effort: resolveEffort(profile, wanted, `${ctx} tier '${name}'`) };
}

function effortName(index: number): string {
  const clamped = Math.min(Math.max(index, 1), EFFORT_LADDER.length) - 1;
  return EFFORT_LADDER[clamped]!;
}

function withEffort(model: string, effortIndex: number | undefined): PickModelResult {
  return effortIndex === undefined ? { model } : { model, effort: effortName(effortIndex) };
}

function normalizePolicy(policyOrAt: ModelPolicy | number | undefined): ModelPolicy {
  if (typeof policyOrAt === 'number') {
    return createModelPolicy({ escalateAt: policyOrAt });
  }
  if (policyOrAt === undefined) return DEFAULT_MODEL_POLICY;
  return createModelPolicy({
    tierMap: { ...policyOrAt.tierMap },
    // Must be carried through. This function rebuilds the policy on EVERY
    // pickModel call, so anything it forgets is silently absent at resolution
    // time even though the caller supplied it.
    ...(policyOrAt.tierProfiles !== undefined ? { tierProfiles: policyOrAt.tierProfiles } : {}),
    escalateAt: policyOrAt.escalateAt,
    escalationExtensionKey: policyOrAt.escalationExtensionKey,
  });
}

/**
 * Pick the model and effort for one agent order.
 *
 * The fourth argument accepts a ModelPolicy. A numeric value is also accepted as
 * the reject threshold for compatibility with the reference function's shape.
 */
export function pickModel(
  stepYamlModel: string,
  lane: ModelLane | undefined,
  judgmentRejects: number,
  policyOrAt: ModelPolicy | number = DEFAULT_MODEL_POLICY,
  override?: string,
  escalation?: ModelEscalation,
): PickModelResult {
  const policy = normalizePolicy(policyOrAt);
  const pinned = typeof override === 'string' && override !== '';
  const rawInput = pinned ? override : stepYamlModel;
  const { modelPart, effortIndex } = parseModelEffort(rawInput);
  // Only used when the input did NOT name a tier — a literal model id or a
  // non-tier override. Every tier-named path resolves through resultForTier.
  const model = resolveModelTier(modelPart, policy.tierMap);
  const inputTier = tierForInput(modelPart);

  if (escalation !== undefined) {
    const attempts = escalation.attempts ?? policy.escalateAt;
    const clampedTier = inputTier !== undefined && !pinned ? clampTierForLane(inputTier, lane) : inputTier;

    if (judgmentRejects >= attempts) {
      const rung2Raw = typeof escalation.model === 'string' && escalation.model !== '' ? escalation.model : 'strong';
      const { modelPart: rung2Part, effortIndex: rung2Effort } = parseModelEffort(rung2Raw);
      const rung2Tier = tierForInput(rung2Part);
      if (rung2Tier === undefined) {
        // The escalation named a literal model id, not a tier. Nothing to
        // compare it against in tier space, so it wins outright.
        return withEffort(resolveModelTier(rung2Part, policy.tierMap), rung2Effort);
      }
      // MONOTONIC. An escalation exists to RAISE capability after repeated
      // rejects, so it takes the higher of the two tiers, never the escalation
      // tier outright. Returning it outright let the escalation DEMOTE a step
      // the lane had already lifted: a `deep` step floored to the top tier,
      // rejected three times, would drop to whatever the def authored as its
      // escalation — moving to a weaker model at the exact moment the evidence
      // says the work is hard. The def author writes one escalation for a step
      // that runs on three lanes and cannot know which one is live.
      return resultForTier(Math.max(clampedTier ?? rung2Tier, rung2Tier), rung2Effort, policy, 'escalation');
    }

    if (clampedTier !== undefined) return resultForTier(clampedTier, effortIndex, policy, 'step');
    return withEffort(model, effortIndex);
  }

  const escalate = judgmentRejects >= policy.escalateAt;
  const nextEffort = effortIndex === undefined ? undefined : escalate ? effortIndex + 1 : effortIndex;

  // The lane adjusts the BASE. Track the resulting tier, because escalation
  // below is decided on the CLAMPED tier, not the authored one.
  let currentTier = inputTier;
  if (inputTier !== undefined && !pinned) currentTier = clampTierForLane(inputTier, lane);

  // Model escalation fires when there was no effort suffix to bump instead, or
  // once the reject count reaches twice the threshold. It is upward-only and
  // ALWAYS wins over an express cap: a producer stuck on repeated rejects needs
  // more capability more than the lane needs the cheaper tier. Gating this on
  // the POST-clamp tier is what makes escalation beat the cap — gating it on
  // the authored tier would let an express-clamped `strong` step sit at the
  // standard tier forever, however many rejects accumulate.
  const modelEscalates = escalate && (effortIndex === undefined || judgmentRejects >= policy.escalateAt * 2);
  if (modelEscalates && currentTier !== undefined && currentTier < TIER_INDEX['strong']!) {
    currentTier = TIER_INDEX['strong']!;
  }

  if (currentTier !== undefined) return resultForTier(currentTier, nextEffort, policy, 'step');
  return withEffort(model, nextEffort);
}
