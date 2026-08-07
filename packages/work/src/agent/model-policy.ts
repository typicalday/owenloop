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
      if (lane === 'express' && inputTier > TIER_INDEX['standard']!) model = policy.tierMap['standard'] ?? 'standard';
      else if (lane === 'deep' && inputTier < TIER_INDEX['strong']!) model = policy.tierMap['strong'] ?? 'strong';
    }
    return withEffort(model, effortIndex);
  }

  const escalate = judgmentRejects >= policy.escalateAt;
  const nextEffort = effortIndex === undefined ? undefined : escalate ? effortIndex + 1 : effortIndex;

  if (inputTier !== undefined && !pinned) {
    if (lane === 'express' && inputTier > TIER_INDEX['standard']!) model = policy.tierMap['standard'] ?? 'standard';
    else if (lane === 'deep' && inputTier < TIER_INDEX['strong']!) model = policy.tierMap['strong'] ?? 'strong';
  }

  const modelEscalates = escalate && (effortIndex === undefined || judgmentRejects >= policy.escalateAt * 2);
  if (modelEscalates && inputTier !== undefined && inputTier < TIER_INDEX['strong']!) {
    model = policy.tierMap['strong'] ?? 'strong';
  }

  return withEffort(model, nextEffort);
}
