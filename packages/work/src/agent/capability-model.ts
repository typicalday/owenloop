/**
 * Resolve an order's COMPOSED CAPABILITY to the local crew roster that serves
 * it. The hub decides what grade of work an order is; the machine decides
 * which locally available harness, model, and effort serve that grade.
 *
 * A crew roster is a capability-to-candidate-list table. It is deliberately
 * local: accounts, quotas, and operator preference do not belong in a shared
 * workflow definition. The candidates are ordered so an operator can express
 * a preferred harness with a deterministic fallback:
 *
 * ```json
 * {
 *   "roster": {
 *     "wise:deep": [
 *       { "harness": "<harness-id>", "model": "<model-id>", "effort": "xhigh" }
 *     ]
 *   }
 * }
 * ```
 *
 * The one behavior worth carrying out of the retired tier code is EFFORT
 * VALIDITY CHECKING. It happens at settings load and checks only the neutral
 * start contract's five rungs.
 *
 * IT DELIBERATELY DOES NOT CHECK EFFORT AGAINST THE MODEL. That would require a
 * table of model identifiers which this repository has no ground truth for.
 * Harnesses may validate effort as a harness-wide property or pass it through;
 * neither case establishes a per-model constraint. A table here would either
 * restate `EFFORT_LADDER` under model-shaped keys or invent a restriction that
 * rejects a valid operator config. A future per-harness check belongs on the
 * adapter contract, not in this neutral shape module.
 */

/** Reasoning rungs the neutral start contract accepts, weakest to strongest. */
export const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORT_LADDER)[number];

/**
 * What separates a capability's NAME PART from its MODIFIER: `wise:deep` is the
 * name `wise` at the modifier `deep`. Split on the FIRST separator, matching
 * the engine's own `capabilityName` — a capability name may not contain `:`
 * (install-time rule), so anything after the first one is modifier territory.
 */
export const MODIFIER_SEPARATOR = ':';

/** The bare capability name inside a composed capability. `wise:deep` → `wise`. */
export function capabilityNamePart(capability: string): string {
  const at = capability.indexOf(MODIFIER_SEPARATOR);
  return at === -1 ? capability : capability.slice(0, at);
}

/** One ordered candidate in a crew roster row. */
export interface RosterCandidate {
  harness: string;
  model: string;
  effort: string;
}

/** A crew roster keyed by composed capability (`wise:deep`) or bare name (`wise`). */
export type Roster = Readonly<Record<string, readonly RosterCandidate[]>>;

/** Thrown when the crew roster is unusable. Never silently repaired. */
export class RosterError extends Error {}

function isEffort(value: string): value is Effort {
  return (EFFORT_LADDER as readonly string[]).includes(value);
}

/**
 * Validate a crew roster, throwing on the first unusable row. Every fault this
 * function catches is certainly wrong: an empty capability, an old object row,
 * an empty candidate list, or a candidate missing any required part would make
 * routing ambiguous hours after the configuration mistake.
 *
 * It intentionally does not judge whether a model id exists or whether a
 * particular model accepts an effort; see this module's header.
 */
export function validateRoster(
  roster: Readonly<Record<string, unknown>>,
  ctx = 'roster',
): void {
  for (const [capability, rawCandidates] of Object.entries(roster)) {
    if (capability.trim() === '') {
      throw new RosterError(`${ctx}: a capability key may not be empty`);
    }
    if (!Array.isArray(rawCandidates)) {
      throw new RosterError(
        `${ctx}['${capability}'] must be a non-empty array of { harness: "<harness-id>", model: "<model-id>", effort: "high" }, got ${JSON.stringify(rawCandidates)}`,
      );
    }
    if (rawCandidates.length === 0) {
      throw new RosterError(`${ctx}['${capability}'] must be a non-empty array of candidates`);
    }
    for (const [index, rawCandidate] of rawCandidates.entries()) {
      const entryCtx = `${ctx}['${capability}'][${index}]`;
      if (typeof rawCandidate !== 'object' || rawCandidate === null || Array.isArray(rawCandidate)) {
        throw new RosterError(
          `${entryCtx} must be an object with exactly 'harness', 'model', and 'effort', got ${JSON.stringify(rawCandidate)}`,
        );
      }
      const candidate = rawCandidate as Record<string, unknown>;
      const keys = Object.keys(candidate);
      const unknown = keys.filter((key) => !['harness', 'model', 'effort'].includes(key));
      if (unknown.length > 0) {
        throw new RosterError(`${entryCtx} has unknown key(s): ${unknown.join(', ')}`);
      }
      for (const key of ['harness', 'model'] as const) {
        if (typeof candidate[key] !== 'string' || candidate[key].trim() === '') {
          throw new RosterError(`${entryCtx}.${key} must be a non-empty string`);
        }
      }
      const effort = candidate['effort'];
      if (typeof effort !== 'string' || !isEffort(effort)) {
        throw new RosterError(
          `${entryCtx}.effort must be one of ${EFFORT_LADDER.join(', ')}, got ${JSON.stringify(effort)}`,
        );
      }
    }
  }
}

/** Which roster row served the order: its exact compound, or the bare name fallback. */
export type CapabilityMatch = 'exact' | 'bare';

export interface CapabilityCandidates {
  /** The capability the winning row was keyed by (`wise:deep` or `wise`). */
  capability: string;
  match: CapabilityMatch;
  candidates: readonly RosterCandidate[];
}

/**
 * Resolve an order's capabilities against the merged roster: exact compound
 * row first, then the bare name-part row, else `undefined` (the caller
 * refuses the order — never a default model).
 *
 * TWO PASSES ACROSS ALL CAPABILITIES, NOT ONE PASS PER CAPABILITY. A step may
 * author several capabilities, and the hub's claim gate is itself exact-first
 * across the set. Resolving capability by capability instead would let a bare
 * row on the first capability beat an exact row on the second — the shift
 * would run a deep order at the bare grade purely because of authoring order.
 *
 * The bare row is what makes a name-match fallback order resolvable at all:
 * the hub can stamp `wise:deep` on an order that a crew bound only to
 * `wise:standard` then claims, and that shift has no `wise:deep` row by
 * construction.
 */
export function resolveCapabilityCandidates(
  roster: Roster,
  capabilities: readonly string[],
): CapabilityCandidates | undefined {
  for (const capability of capabilities) {
    const candidates = roster[capability];
    if (candidates !== undefined) return { capability, match: 'exact', candidates };
  }
  for (const capability of capabilities) {
    const name = capabilityNamePart(capability);
    // Skip a capability that IS its own name part — the first pass already
    // tried that key, and reporting it as a `bare` match would misreport an
    // exact hit as a fallback in the resolution record.
    if (name === capability) continue;
    const candidates = roster[name];
    if (candidates !== undefined) return { capability: name, match: 'bare', candidates };
  }
  return undefined;
}

export type SelectionOutcome =
  | { kind: 'selected'; candidate: RosterCandidate }
  | { kind: 'harness-policy'; offered: readonly string[] }
  | { kind: 'none-available'; offered: readonly string[] };

/**
 * Select the first usable candidate in roster order. A non-empty step harness
 * is a policy constraint; it narrows candidates before availability is tested.
 */
export function selectCandidate(
  candidates: readonly RosterCandidate[],
  stepHarness: string | undefined,
  isAvailable: (harnessId: string) => boolean,
): SelectionOutcome {
  const survivors =
    stepHarness !== undefined && stepHarness !== ''
      ? candidates.filter((candidate) => candidate.harness === stepHarness)
      : candidates;
  if (survivors.length === 0) {
    return { kind: 'harness-policy', offered: candidates.map((candidate) => candidate.harness) };
  }
  for (const candidate of survivors) {
    if (isAvailable(candidate.harness)) return { kind: 'selected', candidate };
  }
  return { kind: 'none-available', offered: survivors.map((candidate) => candidate.harness) };
}
