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

import type {
  DecisionBindingV1,
  LocalModelTuple,
  LocalTupleEligibility,
  ReferenceRouting,
  RoleModelPolicy,
  TaskRole,
} from '../hub/types.ts';

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

/** Read only a declared roster row; inherited Object.prototype names are never capabilities. */
function ownCandidates(roster: Roster, capability: string): readonly RosterCandidate[] | undefined {
  return Object.prototype.hasOwnProperty.call(roster, capability) ? roster[capability] : undefined;
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
    const candidates = ownCandidates(roster, capability);
    if (candidates !== undefined) return { capability, match: 'exact', candidates };
  }
  for (const capability of capabilities) {
    const name = capabilityNamePart(capability);
    // Skip a capability that IS its own name part — the first pass already
    // tried that key, and reporting it as a `bare` match would misreport an
    // exact hit as a fallback in the resolution record.
    if (name === capability) continue;
    const candidates = ownCandidates(roster, name);
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

/** The winning row's identity, supplied by the trusted crew/roster resolver. */
export interface AuthorizedRowIdentity {
  crew: string;
  capability: string;
  source: string;
}

export interface AuthorizedSelectionInput {
  /** Only the authorized crew, with strongest-layer rows already merged atomically.
   * Weaker rows and other crews are deliberately not fallback inputs. */
  roster: {
    crew: string;
    rows: Readonly<Record<string, { source: string; candidates: readonly RosterCandidate[] }>>;
  };
  authorizedRow: AuthorizedRowIdentity;
  capabilities: readonly string[];
  binding: Pick<DecisionBindingV1, 'issuedAt' | 'expiresAt'> & {
    revisions: Pick<DecisionBindingV1['revisions'], 'roster' | 'rolePolicy'>;
  };
  /** Authenticated service snapshot, including the exact submitted offer. */
  preference: ReferenceRouting['preference'];
  current: {
    now: number;
    /** Trusted current task role; an arbitrary or unknown string must refuse. */
    role: string;
    rolePolicy: RoleModelPolicy | null;
    /** Roster CONTENT identity, comparable to offer/preference.rosterRevision. */
    rosterRevision: string;
    /** Scoped generation, comparable only to binding.revisions.roster. */
    rosterGeneration: string;
    /** Current authoritative tuple eligibility and model-specific availability.
     * The caller supplies any required quota checks; installation alone is insufficient. */
    tuples: readonly LocalTupleEligibility[];
    installedHarnesses: readonly string[];
  };
  stepHarness?: string;
  /** Optional ranking hint, never authority. IDs and every component must match. */
  preferred?: LocalModelTuple;
}

export type AuthorizedSelectionRefusal =
  | 'no-row' | 'unauthorized-row' | 'missing-offer' | 'role-policy'
  | 'stale-revisions' | 'stale-window' | 'harness-policy' | 'none-eligible';

export interface AuthorizedSelectionProvenance {
  requested: LocalModelTuple | null;
  row: AuthorizedRowIdentity | null;
  match: CapabilityMatch | null;
  revisions: { rosterContent: string; rosterGeneration: string; rolePolicy: string | null };
}

/**
 * The trusted, ordered tuple set that may be sent to the routing service.
 * This is deliberately separate from selection: an advisory can only rank
 * candidates already admitted by the local authorization snapshot.
 */
export interface AuthorizedCandidateExtraction extends AuthorizedSelectionProvenance {
  candidates: readonly LocalModelTuple[];
  refusal: AuthorizedSelectionRefusal | null;
}

export type AuthorizedSelectionOutcome = AuthorizedSelectionProvenance & (
  | { kind: 'refused'; reason: AuthorizedSelectionRefusal; selected: null }
  | { kind: 'selected'; reason: 'preferred' | 'roster-order'; selected: LocalModelTuple }
  | { kind: 'fallback'; reason: 'preferred-ineligible' | 'roster-fallback'; selected: LocalModelTuple }
);

function knownTaskRole(role: string): role is TaskRole {
  // Exhaustive against the shared DTO, without defining a competing role type.
  const roles = { research: true, implementation: true, review: true, judge: true } satisfies Record<TaskRole, true>;
  return Object.prototype.hasOwnProperty.call(roles, role);
}

function sameModel(a: RosterCandidate, b: RosterCandidate): boolean {
  return a.harness === b.harness && a.model === b.model && a.effort === b.effort;
}

function sameTuple(a: LocalModelTuple, b: LocalModelTuple): boolean {
  return a.id === b.id && sameModel(a, b);
}

function copyTuple(tuple: LocalModelTuple): LocalModelTuple {
  return { id: tuple.id, harness: tuple.harness, model: tuple.model, effort: tuple.effort };
}

function eligibleTuple(rows: readonly LocalTupleEligibility[], tuple: LocalModelTuple): boolean {
  const matches = rows.filter(row => row.tuple.id === tuple.id);
  // Conflicting components or flags under the same ID are not usable authority.
  return matches.length === 1 && matches[0]!.eligible === true && matches[0]!.available === true
    && sameTuple(matches[0]!.tuple, tuple);
}

function policyAllows(policy: RoleModelPolicy, role: TaskRole, model: string): boolean {
  return policy.rules.some(rule => rule.model === model && rule.roles.includes(role));
}

function currentWindow(window: { issuedAt: number; expiresAt: number }, now: number): boolean {
  return Number.isFinite(window.issuedAt) && Number.isFinite(window.expiresAt)
    && window.issuedAt <= now && now < window.expiresAt;
}

/**
 * Pure opt-in model selection over one trusted, current authorization snapshot.
 * The caller must authenticate account/session/claim and supply the authoritative
 * crew, winning row, role, policy and current availability. This function does
 * not establish those authorities or authorize a future process launch.
 *
 * Resolve exact-before-bare across all capabilities once, lock the winning row,
 * then intersect local installation, full service tuple identities, current
 * eligibility/availability, both policies and the hard harness before ranking.
 * Failure is terminal for this opt-in path: callers must not retry legacy crew
 * or layer fallback. The separate no-model command path is outside this API.
 */
export function extractAuthorizedCandidates(input: AuthorizedSelectionInput): AuthorizedCandidateExtraction {
  const { current, preference, binding } = input;
  const rows = input.roster.rows;
  const roster: Record<string, readonly RosterCandidate[]> = Object.create(null);
  for (const capability of Object.keys(rows)) roster[capability] = rows[capability]!.candidates;
  const resolved = resolveCapabilityCandidates(roster, input.capabilities);
  const row = resolved ? {
    crew: input.roster.crew, capability: resolved.capability, source: rows[resolved.capability]!.source,
  } : null;
  const provenance: AuthorizedSelectionProvenance = {
    requested: input.preferred ? copyTuple(input.preferred) : null,
    row,
    match: resolved?.match ?? null,
    revisions: {
      rosterContent: current.rosterRevision,
      rosterGeneration: current.rosterGeneration,
      rolePolicy: current.rolePolicy?.revision ?? null,
    },
  };
  const refuse = (reason: AuthorizedSelectionRefusal): AuthorizedCandidateExtraction => (
    { ...provenance, candidates: [], refusal: reason }
  );
  if (!resolved || !row) return refuse('no-row');
  if (!row.crew || !row.source || row.crew !== input.authorizedRow.crew
    || row.capability !== input.authorizedRow.capability || row.source !== input.authorizedRow.source) {
    return refuse('unauthorized-row');
  }
  const offer = preference.offer;
  if (!offer) return refuse('missing-offer');
  const policy = current.rolePolicy;
  const offeredPolicy = preference.rolePolicy;
  if (!knownTaskRole(current.role) || preference.role !== current.role
    || !policy || !offeredPolicy || policy.unknownRole !== 'refuse' || offeredPolicy.unknownRole !== 'refuse') {
    return refuse('role-policy');
  }
  if (!current.rosterRevision || !current.rosterGeneration || !policy.revision
    || current.rosterRevision !== preference.rosterRevision || current.rosterRevision !== offer.rosterRevision
    || current.rosterGeneration !== binding.revisions.roster
    || policy.revision !== offeredPolicy.revision || policy.revision !== offer.rolePolicyRevision
    || policy.revision !== binding.revisions.rolePolicy) return refuse('stale-revisions');
  if (!Number.isFinite(current.now) || !currentWindow(binding, current.now) || !currentWindow(offer, current.now)
    || !Number.isFinite(preference.expiresAt) || current.now >= preference.expiresAt) return refuse('stale-window');

  const hardHarness = input.stepHarness;
  const constrained = resolved.candidates.filter(candidate => !hardHarness || candidate.harness === hardHarness);
  if (resolved.candidates.length > 0 && constrained.length === 0) return refuse('harness-policy');
  const role = current.role;
  const eligible = constrained.flatMap(candidate => {
    if (!current.installedHarnesses.includes(candidate.harness)
      || !policyAllows(policy, role, candidate.model) || !policyAllows(offeredPolicy, role, candidate.model)) return [];
    return offer.tuples.filter(({ tuple }) => tuple.id.trim() !== '' && sameModel(tuple, candidate)
      && eligibleTuple(offer.tuples, tuple) && eligibleTuple(preference.tuples, tuple)
      && eligibleTuple(current.tuples, tuple)).map(({ tuple }) => copyTuple(tuple));
  });
  return { ...provenance, candidates: eligible, refusal: eligible.length === 0 ? 'none-eligible' : null };
}

export function evaluateAuthorizedSelection(input: AuthorizedSelectionInput): AuthorizedSelectionOutcome {
  const extracted = extractAuthorizedCandidates(input);
  const provenance: AuthorizedSelectionProvenance = {
    requested: extracted.requested,
    row: extracted.row,
    match: extracted.match,
    revisions: extracted.revisions,
  };
  if (extracted.refusal) {
    return { ...provenance, kind: 'refused', reason: extracted.refusal, selected: null };
  }
  const eligible = extracted.candidates;
  const preferred = input.preferred && eligible.find(tuple => sameTuple(tuple, input.preferred!));
  if (preferred) return { ...provenance, kind: 'selected', reason: 'preferred', selected: copyTuple(preferred) };
  const first = eligible[0];
  if (!first) return { ...provenance, kind: 'refused', reason: 'none-eligible', selected: null };
  if (input.preferred) {
    return { ...provenance, kind: 'fallback', reason: 'preferred-ineligible', selected: copyTuple(first) };
  }
  const rowCandidates = extracted.row
    ? input.roster.rows[extracted.row.capability]?.candidates
    : undefined;
  if (!rowCandidates?.[0] || !sameModel(first, rowCandidates[0])) {
    return { ...provenance, kind: 'fallback', reason: 'roster-fallback', selected: copyTuple(first) };
  }
  return { ...provenance, kind: 'selected', reason: 'roster-order', selected: copyTuple(first) };
}
