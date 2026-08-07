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

export interface ModelPolicy {
  /** Resolved tier names; this map is merged with DEFAULT_TIER_MAP by createModelPolicy. */
  tierMap: Readonly<Record<string, string>>;
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
  escalateAt?: number;
  escalationExtensionKey?: string;
}

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  tierMap: DEFAULT_TIER_MAP,
  escalateAt: 3,
  escalationExtensionKey: 'delivery',
};

/** Build a normalized policy from optional machine-local settings. */
export function createModelPolicy(options: ModelPolicyOptions = {}): ModelPolicy {
  return {
    tierMap: { ...DEFAULT_TIER_MAP, ...(options.tierMap ?? {}) },
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
 * express caps at `standard` and deep floors at `strong`, with one exception:
 * the express cap never touches the TOP tier. A step authored at the top tier
 * is there because the judgment it makes is hard, so the lane's cost heuristic
 * must not downgrade it — the lane scales cost, it does not overrule an
 * explicit escalation of quality. The reference implementation gets this for
 * free by leaving the top tier out of its rank table; ranking in tier space
 * gives the top tier a rank, so the exclusion has to be stated here.
 */
function clampTierForLane(tier: number, lane: ModelLane | undefined): number {
  if (lane === 'express' && tier > TIER_INDEX['standard']! && tier !== TIER_INDEX['strongest']!) {
    return TIER_INDEX['standard']!;
  }
  if (lane === 'deep' && tier < TIER_INDEX['strong']!) return TIER_INDEX['strong']!;
  return tier;
}

/** Resolve a tier index back to a concrete model id through the policy map. */
function modelForTier(tier: number, tierMap: Readonly<Record<string, string>>): string {
  const name = TIER_NAMES[tier]!;
  return tierMap[name] ?? name;
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
  let model = resolveModelTier(modelPart, policy.tierMap);
  const inputTier = tierForInput(modelPart);

  if (escalation !== undefined) {
    const attempts = escalation.attempts ?? policy.escalateAt;
    if (judgmentRejects >= attempts) {
      const rung2Raw = typeof escalation.model === 'string' && escalation.model !== '' ? escalation.model : 'strong';
      const { modelPart: rung2Part, effortIndex: rung2Effort } = parseModelEffort(rung2Raw);
      return withEffort(resolveModelTier(rung2Part, policy.tierMap), rung2Effort);
    }

    if (inputTier !== undefined && !pinned) {
      model = modelForTier(clampTierForLane(inputTier, lane), policy.tierMap);
    }
    return withEffort(model, effortIndex);
  }

  const escalate = judgmentRejects >= policy.escalateAt;
  const nextEffort = effortIndex === undefined ? undefined : escalate ? effortIndex + 1 : effortIndex;

  // The lane adjusts the BASE. Track the resulting tier, because escalation
  // below is decided on the CLAMPED tier, not the authored one.
  let currentTier = inputTier;
  if (inputTier !== undefined && !pinned) {
    currentTier = clampTierForLane(inputTier, lane);
    model = modelForTier(currentTier, policy.tierMap);
  }

  // Model escalation fires when there was no effort suffix to bump instead, or
  // once the reject count reaches twice the threshold. It is upward-only and
  // ALWAYS wins over an express cap: a producer stuck on repeated rejects needs
  // more capability more than the lane needs the cheaper tier. Gating this on
  // the POST-clamp tier is what makes escalation beat the cap — gating it on
  // the authored tier would let an express-clamped `strong` step sit at the
  // standard tier forever, however many rejects accumulate.
  const modelEscalates = escalate && (effortIndex === undefined || judgmentRejects >= policy.escalateAt * 2);
  if (modelEscalates && currentTier !== undefined && currentTier < TIER_INDEX['strong']!) {
    model = policy.tierMap['strong'] ?? 'strong';
  }

  return withEffort(model, nextEffort);
}
