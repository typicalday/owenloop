/**
 * Routing capabilities: composition at offer time, and the claim-side match.
 *
 * Three vocabularies meet here and must not be confused:
 *
 *   - **Authored capability** — what a def writes on a step (`wise`). Never
 *     contains the separator; the parser rejects one that does.
 *   - **Modifier** — the ONE plain name a run carries (`deep`). Optional. The
 *     engine attaches no meaning, no order and no arithmetic to it.
 *   - **Compound capability** — `<authored>:<modifier>` (`wise:deep`), composed
 *     by the engine when it builds an order. Only the engine composes it.
 *
 * Nothing here reads the store, the def or the clock. Composition is a pure
 * function of (authored capabilities, modifier); matching is a pure function of
 * (offered capabilities, caller capabilities, per-capability match mode).
 */

/**
 * The character the engine reserves as the capability/modifier separator.
 *
 * A def author never writes it. `wise:deep` is a value the ENGINE composes at
 * offer time from an authored capability plus the run's modifier, and a crew
 * binding is matched against that composed form. If an author could also write
 * a literal `wise:deep` capability, two different things — an authored name and
 * a composed compound — would be indistinguishable downstream, and the name
 * part of a compound would stop being recoverable by splitting on the first
 * colon. So the position is reserved, and reserving it is enforced in the def
 * parser (`assertAuthoredCapability`).
 */
export const MODIFIER_SEPARATOR = ':';

/**
 * How a claim is matched against one offered capability.
 *
 * - `'exact'` — the caller must present the offered string literally. Stamped
 *   by the hub when at least one crew is bound to the exact compound
 *   (Scenario A): the binding exists, so the order belongs to the crews that
 *   opted into serving that slice, and a name-part-only crew must not take it.
 * - `'name'` — the caller matches on the name part alone, modifier ignored
 *   both sides. Stamped when no binding for the compound exists (Scenario B),
 *   and re-stamped when a wait policy degrades an Scenario-A order.
 *
 * The mode is a HUB decision — it depends on `capability_routes`, which the
 * pure engine cannot see. The engine only enforces the mode it is handed, and
 * defaults to `'name'` for any capability the caller says nothing about.
 */
export type MatchMode = 'exact' | 'name';

/** The default when a caller supplies no mode for an offered capability. */
export const DEFAULT_MATCH_MODE: MatchMode = 'name';

/**
 * The name part of a capability: everything before the FIRST separator.
 *
 * Split on the first, not the last: an authored name can never contain the
 * separator, so the first occurrence is always the one the engine composed at.
 * A bare capability is its own name part.
 */
export function capabilityName(capability: string): string {
  const i = capability.indexOf(MODIFIER_SEPARATOR);
  return i === -1 ? capability : capability.slice(0, i);
}

/**
 * Compose a step's authored capabilities against a run's modifier.
 *
 * No modifier (an unmodified run) returns the authored list unchanged — the
 * order is offered on bare capabilities, exactly as before modifiers existed.
 * An empty authored list stays empty: a capability-silent step has nothing to
 * compose onto, and inventing a lone `:deep` would be meaningless.
 */
export function composeCapabilities(
  authored: readonly string[] | undefined,
  modifier: string | undefined,
): string[] {
  if (authored === undefined || authored.length === 0) return [];
  if (modifier === undefined) return [...authored];
  return authored.map((c) => `${c}${MODIFIER_SEPARATOR}${modifier}`);
}

/** True when one caller capability satisfies one offered capability under `mode`. */
function matchesOne(offered: string, caller: string, mode: MatchMode): boolean {
  return mode === 'exact' ? caller === offered : capabilityName(caller) === capabilityName(offered);
}

/**
 * The claim-side match: may a caller presenting `caller` claim a step offered
 * on `offered`?
 *
 * `caller` distinguishes two states that must not be collapsed:
 *
 *   - `undefined` — **no filter presented**. The caller is not claiming as a
 *     crew at all (a local operator running `owenloop tick`, a test driver).
 *     Everything matches, exactly as before capabilities existed.
 *   - `[]` — **a caller that serves nothing**. A crew presenting an empty
 *     capability list. This matches only capability-silent steps (case 2).
 *
 * Four cases, kept explicit because they are genuinely different rules:
 *
 *   1. **No filter presented** — always matches. See above.
 *   2. **Capability-silent step** (`offered` empty) — claimable by anyone,
 *      including a caller presenting an empty list. Unchanged behavior: a def
 *      that authors no capabilities expresses no routing preference.
 *   3. **Empty caller list, capabilities offered** — NO match. This is the A2
 *      caller-side change: today an empty list bypasses the filter and can
 *      claim every step, including compounds its shift cannot resolve, costing
 *      a claim/release cycle per order and able to hot-loop. Such a caller now
 *      matches only case 2.
 *   4. **Both non-empty** — match when SOME offered capability is satisfied by
 *      SOME caller capability under that offered capability's own mode. The
 *      mode is looked up per offered capability, so an order carrying two
 *      compounds with different bindings is judged correctly on each.
 */
export function claimMatches(
  offered: readonly string[],
  caller: readonly string[] | undefined,
  modes: Readonly<Record<string, MatchMode>> = {},
): boolean {
  if (caller === undefined) return true;
  if (offered.length === 0) return true;
  if (caller.length === 0) return false;
  return offered.some((o) => {
    const mode = modes[o] ?? DEFAULT_MATCH_MODE;
    return caller.some((c) => matchesOne(o, c, mode));
  });
}
