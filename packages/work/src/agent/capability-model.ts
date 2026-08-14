/**
 * Resolve an order's COMPOSED CAPABILITY to the model and reasoning effort this
 * machine runs it at.
 *
 * The hub decides WHAT grade of work an order is (`builder` composed with the
 * run's `deep` modifier → `builder:deep`). It never decides which model serves
 * that grade. That decision is local to the operator's machine, because it is a
 * statement about accounts, quotas and taste — three things a shared workflow
 * definition has no business asserting.
 *
 * So the settings file carries a flat map from capability to `{model, effort}`:
 *
 * ```json
 * {
 *   "capabilityModels": {
 *     "wise:deep":  { "model": "<model-id>", "effort": "xhigh" },
 *     "build:deep": { "model": "<model-id>", "effort": "xhigh" },
 *     "wise":       { "model": "<model-id>", "effort": "high" }
 *   }
 * }
 * ```
 *
 * `<model-id>` is whatever string the shift's harness accepts as a model. This
 * module never enumerates real model ids: it ships as neutral runtime, and
 * `test/vendor-gate.test.ts` forbids a harness vendor's names here. `README.md`
 * and `docs/` carry worked examples with real ids.
 *
 * THIS REPLACES `tierMap`/`tierProfiles` OUTRIGHT. A tier was an abstract rung
 * (`fast`/`standard`/`strong`/`strongest`) that a machine then mapped to a
 * model, and the tier ladder could not express the thing the operator actually
 * wanted: "Luna at low effort" and "Fable at max effort" are different routes,
 * but the ladder welded model choice and depth into one ordered axis, so one
 * could not vary without the other. A capability is just a name. What serves it
 * is a local lookup, and depth rides on the capability's modifier suffix rather
 * than on a rung.
 *
 * The one behavior worth carrying out of the tier code is EFFORT VALIDITY
 * CHECKING, which now happens at settings load rather than at resolution time.
 * It checks the effort against `EFFORT_LADDER` — the neutral start contract's
 * own five rungs — and nothing else.
 *
 * IT DELIBERATELY DOES NOT CHECK EFFORT AGAINST THE MODEL. Doing that would
 * require a table of real model ids in this file, which the vendor gate forbids
 * and which this repository has no ground truth for anyway. Look at what the
 * harness adapters in `src/harness/` actually enforce: one validates effort
 * against a closed union that is a property of THE HARNESS — every model that
 * harness runs accepts the same rungs — and the other passes effort through
 * without validating it at all. Neither knows a per-model constraint, so a
 * table here would be either a restatement of `EFFORT_LADDER` under
 * model-shaped keys, or an invention that blocks a valid operator config. The
 * real per-harness check belongs on the adapter contract; see the follow-up
 * noted in `validateCapabilityModels`.
 *
 * The old snap-up/ceiling-refusal logic in `resolveEffort` is gone with the
 * ladder it resolved through: there is no abstract rung left to snap.
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

/** One settings row: the model that serves a capability, and how hard it thinks. */
export interface CapabilityModelRow {
  model: string;
  effort: string;
}

/** The settings map, keyed by composed capability (`wise:deep`) or bare name (`wise`). */
export type CapabilityModelMap = Readonly<Record<string, CapabilityModelRow>>;

/** Thrown when the capability map is unusable. Never silently repaired. */
export class CapabilityModelError extends Error {}

function isEffort(value: string): value is Effort {
  return (EFFORT_LADDER as readonly string[]).includes(value);
}

/**
 * Validate the map, throwing on the first unusable row. Returns nothing: every
 * fault this function can see is certainly wrong.
 *
 * WHAT IT CATCHES — a capability key that is empty, a row that is not an object,
 * a missing or empty `model`, and an `effort` that is not one of
 * `EFFORT_LADDER`. Each is wrong under every harness and every model, and a
 * shift that started anyway would refuse or misroute its first matching order
 * hours later, far from the typo.
 *
 * WHAT IT DOES NOT CATCH — an effort a particular MODEL or HARNESS rejects, and
 * a model id that does not exist. Neither is knowable here (see this module's
 * header). FOLLOW-UP: `HarnessAdapter` is the right owner for the first one —
 * an adapter that validates effort against a closed union could declare that
 * union, and a composition root could check every row against every registered
 * adapter at shift start. Until then those faults surface at the vendor API on
 * the first order that lands on the bad row.
 */
export function validateCapabilityModels(
  map: Readonly<Record<string, unknown>>,
  ctx = 'capabilityModels',
): void {
  for (const [capability, raw] of Object.entries(map)) {
    if (capability.trim() === '') {
      throw new CapabilityModelError(`${ctx}: a capability key may not be empty`);
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new CapabilityModelError(
        `${ctx}['${capability}'] must be an object with 'model' and 'effort', got ${JSON.stringify(raw)}`,
      );
    }
    const row = raw as Record<string, unknown>;
    const model = row['model'];
    if (typeof model !== 'string' || model.trim() === '') {
      throw new CapabilityModelError(`${ctx}['${capability}'].model must be a non-empty string`);
    }
    const effort = row['effort'];
    if (typeof effort !== 'string' || !isEffort(effort)) {
      throw new CapabilityModelError(
        `${ctx}['${capability}'].effort must be one of ${EFFORT_LADDER.join(', ')}, got ${JSON.stringify(effort)}`,
      );
    }
  }
}

/** Which row served the order: its exact compound, or the bare name fallback. */
export type CapabilityMatch = 'exact' | 'bare';

export interface CapabilityResolution {
  /** The capability the winning row was keyed by (`wise:deep` or `wise`). */
  capability: string;
  match: CapabilityMatch;
  model: string;
  effort: string;
}

/**
 * Resolve an order's capabilities against the map: exact compound row first,
 * then the bare name-part row, else `undefined` (the caller REFUSES the order —
 * never a default model).
 *
 * TWO PASSES ACROSS ALL CAPABILITIES, NOT ONE PASS PER CAPABILITY. A step may
 * author several capabilities, and the hub's claim gate is itself exact-first
 * across the set (§4/§5: "lookup mirrors the claim rule"). Resolving capability
 * by capability instead would let a bare row on the FIRST capability beat an
 * exact row on the second — the shift would run a `builder:deep` order at the
 * bare `builder` grade purely because of authoring order.
 *
 * The bare row is what makes a NAME-MATCH FALLBACK order resolvable at all: the
 * hub stamps `wise:deep` on an order that a crew bound only to `wise:standard`
 * then claims, and that shift has no `wise:deep` row by construction.
 */
export function resolveCapabilityModel(
  map: CapabilityModelMap,
  capabilities: readonly string[],
): CapabilityResolution | undefined {
  for (const capability of capabilities) {
    const row = map[capability];
    if (row !== undefined) return { capability, match: 'exact', model: row.model, effort: row.effort };
  }
  for (const capability of capabilities) {
    const name = capabilityNamePart(capability);
    // Skip a capability that IS its own name part — the first pass already
    // tried that key, and reporting it as a `bare` match would misreport an
    // exact hit as a fallback in the resolution record.
    if (name === capability) continue;
    const row = map[name];
    if (row !== undefined) return { capability: name, match: 'bare', model: row.model, effort: row.effort };
  }
  return undefined;
}
