/**
 * `fetchDef` — GET the published workflow def from the hub for `prepare`.
 *
 * Reuses C1's envelope/`HubError` conventions (bearer auth, `{ text, ...data }`
 * parse, non-2xx → `HubError`). It hits `GET /api/workflows/<name>` — the same
 * route `get-workflow.ts` serves — and requires the enriched steps shape C2
 * needs (see D1 / bundle/types.ts). Against TODAY's hub (which omits step
 * bodies) it fails with an actionable error naming the gap rather than caching
 * a bundle it cannot compile.
 *
 * Kept as a sibling of the C1 hub client (not a new method on `HubClient`) so
 * the client's tight verb surface stays untouched; it shares the same auth and
 * error conventions so there is still one error path.
 *
 * HASH-PINNED CLOSURE (E): when the parent version pins its `calls:` children,
 * the SAME `GET /api/workflows/:name` round-trip carries `pins` + a flat
 * hash-keyed `children` map. `fetchDef`/`validateFetchedDef` return a
 * `FetchedBundle` (a `FetchedDef` subtype) whose optional `children` hold the
 * frozen closure. The pin/children cross-checks (DD-5) are HARD fetch errors so
 * a broken closure fails at fetch, never mid-run — see `validateFetchedDef`.
 */
import { HubError } from '../hub/types.ts';
import type { FetchedBundle, FetchedDef, FetchedPin, FetchedStep } from './types.ts';

export interface FetchDefOptions {
  /** Hub origin, e.g. `https://hub.owenloop.dev` (trailing slash tolerated). */
  origin: string;
  /** Workflow name to fetch. */
  name: string;
  /** Resolves the bearer token — the same CredentialReader seam the client uses. */
  getToken: () => Promise<string>;
  /** Override the transport in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** A step is an agent step (spec candidate) when it is not a command/calls step. */
function isAgentStep(s: FetchedStep): boolean {
  return s.executor !== 'command' && s.calls === undefined;
}

/**
 * The ONE fixed, vendor-neutral sub-key of `x` that carries harness selection
 * and harness options: `x.harness = { id?: string, ...options }`.
 *
 * It is a CONSTANT, not a lookup key derived from a harness name. That is the
 * whole point: `src/agent/loop.ts` used to do `def.x[harnessId]`, which keyed a
 * data structure BY the vendor id and leaked the vendor into neutral code. A
 * fixed key does not.
 */
export const HARNESS_BAG_KEY = 'harness';

/**
 * The sub-key of `x` owenloop used BEFORE `HARNESS_BAG_KEY`. Retained for ONE
 * purpose: so `parseHarnessCarrier` can recognize a def still written to the old
 * grammar and REJECT it loudly. Nothing ever reads what is inside it.
 *
 * ISOLATION NOTE: this is the only harness-vendor-shaped string under `src/`
 * outside the two adapter modules (`src/harness/{claude,codex}.ts`) and the two
 * composition roots' import lines. It is deliberate and it is not a dispatch
 * decision — it names a DEAD key so the parser can tell an author exactly what
 * to rename. Phase 6's repo-wide vendor gate LANDED — `test/vendor-gate.test.ts`
 * — and this file is one of its four allowlist entries, which is the intended
 * outcome. Do NOT "fix" a gate failure here by deleting the check: deleting the
 * check restores the silent, fail-open degradation it exists to prevent.
 */
export const LEGACY_BAG_KEY = 'claude-code';

/** What `parseHarnessCarrier` lifts off one raw step. */
export interface HarnessCarrier {
  /** The harness id, when the step names one. */
  harness?: string;
  /** Every `x.harness` key except `id`; absent when there are none. */
  harnessOptions?: Record<string, unknown>;
}

function isPlainMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Lift the harness carrier off one RAW step object (D1).
 *
 * Precedence for the id: a TOP-LEVEL `harness` key wins over `x.harness.id`.
 * owenloop's `RAW_STEP_KEYS` rejects unknown top-level step keys at publish
 * today, so a top-level `harness` cannot actually ship yet — reading it is
 * forward compat for the day the grammar promotes the field, and it means the
 * promotion needs no owenloop change.
 *
 * Validation is loose but HONEST: a non-map `x.harness`, a non-string
 * `x.harness.id`, a non-string top-level `harness`, or a surviving legacy
 * `x.claude-code` bag is a def error naming the step, never a silent drop.
 * Absent keys are simply absent — a step with no harness declaration is
 * completely normal.
 *
 * `label` names the def, `stepName` the step, so an error in a pinned child is
 * attributable. Shared with `owenloop work lint`, which parses raw YAML defs.
 */
export function parseHarnessCarrier(
  s: Record<string, unknown>,
  label: string,
  stepName: string,
): HarnessCarrier {
  const where = `hub workflow '${label}': step '${stepName}'`;

  const topLevel = s['harness'];
  if (topLevel !== undefined && typeof topLevel !== 'string') {
    throw new Error(`${where} has a non-string harness`);
  }

  const x = s['x'];

  // A def still carrying the OLD bag key fails HARD here, before anything else
  // looks at `x`. Phase 5 renamed the carrier and shipped NO compatibility shim
  // on purpose; without this check a legacy def parses "cleanly" to
  // `harnessOptions === undefined` — a state indistinguishable from a step that
  // declares no options at all — and the step then runs with its `tools`
  // allow-list and its `disallowedTools` deny-list SILENTLY DROPPED. That is
  // fail-OPEN on permissions, and it is the opposite of the stance this phase
  // takes on the matching cache-format break (`readStepSpec` → `null` → the
  // observable `no-template` outcome). This is DETECTION, not a shim: the legacy
  // bag's contents are never read, only reported, and the message names the
  // exact rename so the failure is self-service.
  if (isPlainMap(x) && LEGACY_BAG_KEY in x) {
    throw new Error(
      `${where} carries a legacy 'x.${LEGACY_BAG_KEY}' bag — rename that key to ` +
        `'x.${HARNESS_BAG_KEY}' (the fields inside it are unchanged). owenloop no longer ` +
        `reads 'x.${LEGACY_BAG_KEY}', so running the step with it would silently drop the ` +
        `step's tools, disallowedTools, permissionMode, maxTurns and effort.`,
    );
  }

  const raw = isPlainMap(x) ? x[HARNESS_BAG_KEY] : undefined;
  if (raw !== undefined && !isPlainMap(raw)) {
    throw new Error(`${where} has a non-map x.${HARNESS_BAG_KEY}`);
  }

  let bagId: string | undefined;
  const options: Record<string, unknown> = {};
  if (raw !== undefined) {
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'id') {
        if (typeof v !== 'string') {
          throw new Error(`${where} has a non-string x.${HARNESS_BAG_KEY}.id`);
        }
        bagId = v;
        continue;
      }
      options[k] = v;
    }
  }

  const carrier: HarnessCarrier = {};
  const id = topLevel ?? bagId;
  if (id !== undefined) carrier.harness = id;
  if (Object.keys(options).length > 0) carrier.harnessOptions = options;
  return carrier;
}

/**
 * Validate one raw def envelope (hash + steps + per-step coercion + the D1 body
 * gap check) into a `FetchedDef`, WITHOUT the pins/children cross-validation. The
 * shared core for both the top-level parent and every child in the flat map.
 * `label` names the def in error messages: the workflow name for a parent, or
 * `<childName>@<childHash>` for a child, so a failure deep in the closure is
 * attributable. Throws a plain `Error` on any structural problem.
 */
function validateDefEnvelope(data: unknown, label: string): FetchedDef {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`hub returned a non-object workflow payload for '${label}'`);
  }
  const d = data as Record<string, unknown>;
  if (typeof d['hash'] !== 'string' || d['hash'] === '') {
    throw new Error(`hub workflow payload for '${label}' is missing a content hash`);
  }
  if (!Array.isArray(d['steps'])) {
    throw new Error(`hub workflow payload for '${label}' is missing a steps array`);
  }

  const steps: FetchedStep[] = (d['steps'] as unknown[]).map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`hub workflow '${label}': step[${i}] is not an object`);
    }
    const s = raw as Record<string, unknown>;
    if (typeof s['name'] !== 'string' || s['name'] === '') {
      throw new Error(`hub workflow '${label}': step[${i}] is missing a name`);
    }
    if (s['x'] !== undefined && (typeof s['x'] !== 'object' || s['x'] === null || Array.isArray(s['x']))) {
      throw new Error(`hub workflow '${label}': step '${s['name'] as string}' has a non-map x`);
    }
    // Lift the neutral harness carrier out of `x.harness` (D1). `x` itself is
    // still carried through verbatim — `x.owenloop` is a separate live
    // namespace that `src/shift/routing.ts` reads.
    const carrier = parseHarnessCarrier(s, label, s['name'] as string);
    return {
      name: s['name'] as string,
      consumes: Array.isArray(s['consumes']) ? (s['consumes'] as unknown[]) : undefined,
      produces: Array.isArray(s['produces']) ? (s['produces'] as unknown[]) : undefined,
      terminal: typeof s['terminal'] === 'boolean' ? (s['terminal'] as boolean) : undefined,
      body: typeof s['body'] === 'string' ? (s['body'] as string) : undefined,
      model: typeof s['model'] === 'string' ? (s['model'] as string) : undefined,
      executor: typeof s['executor'] === 'string' ? (s['executor'] as string) : undefined,
      ...carrier,
      x: s['x'] as Record<string, unknown> | undefined,
      calls: typeof s['calls'] === 'string' ? (s['calls'] as string) : undefined,
    };
  });

  // D1 hub-gap detection: an agent step with no body means the hub predates the
  // C2 bundle-field enrichment. Fail with a message that names the gap (per def,
  // so a bodyless CHILD agent step names that child, not the parent).
  const bodyless = steps.filter((s) => isAgentStep(s) && s.body === undefined);
  if (bodyless.length > 0) {
    const names = bodyless.map((s) => s.name).join(', ');
    throw new Error(
      `hub does not serve step bodies yet — get_workflow predates C2 bundle fields ` +
        `(agent step(s) with no body: ${names}). The hub's get-workflow.ts steps ` +
        `mapping needs the body/model/executor/x passthrough fields before prepare can compile '${label}'.`,
    );
  }

  const def: FetchedDef = {
    name: typeof d['name'] === 'string' ? (d['name'] as string) : label,
    steps,
    hash: d['hash'] as string,
    version: typeof d['version'] === 'number' ? (d['version'] as number) : undefined,
  };
  const pins = parsePins(d['pins'], label);
  if (pins !== undefined) def.pins = pins;
  return def;
}

/**
 * Parse an OPTIONAL `pins` array into `FetchedPin[]`, or `undefined` when the key
 * is absent. Throws on a malformed pin. `label` names the pinning def in errors.
 */
function parsePins(raw: unknown, label: string): FetchedPin[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`hub workflow '${label}': pins is present but not an array`);
  }
  return raw.map((p, i) => {
    if (typeof p !== 'object' || p === null) {
      throw new Error(`hub workflow '${label}': pins[${i}] is not an object`);
    }
    const pin = p as Record<string, unknown>;
    if (typeof pin['call'] !== 'string' || pin['call'] === '') {
      throw new Error(`hub workflow '${label}': pins[${i}] is missing a call step name`);
    }
    if (typeof pin['name'] !== 'string' || pin['name'] === '') {
      throw new Error(`hub workflow '${label}': pin for call '${pin['call'] as string}' is missing a child name`);
    }
    if (typeof pin['hash'] !== 'string' || pin['hash'] === '') {
      throw new Error(`hub workflow '${label}': pin for call '${pin['call'] as string}' is missing a child hash`);
    }
    if (typeof pin['version'] !== 'number' || !Number.isInteger(pin['version'])) {
      throw new Error(`hub workflow '${label}': pin for call '${pin['call'] as string}' has a non-integer version`);
    }
    return {
      call: pin['call'] as string,
      name: pin['name'] as string,
      version: pin['version'] as number,
      hash: pin['hash'] as string,
    };
  });
}

/**
 * Validate the raw `data` envelope into a `FetchedBundle`. Validates the parent
 * def envelope (hash/steps/coercion/D1 gap), then the OPTIONAL hash-pinned child
 * closure (E). Throws a plain `Error` on any structural problem.
 *
 * Pin/children cross-validation is a HARD fetch error (DD-5) — failing at fetch
 * beats failing mid-run and mirrors the hub's refuse-partial stance:
 *   - exactly one of `pins`/`children` present without the other;
 *   - a `children` map key that ≠ the entry's own `hash`;
 *   - any pin (parent's or a child's) whose `hash` is absent from the flat map
 *     (partial closure);
 *   - a pin whose `name` ≠ `children[hash].name`.
 * We do NOT re-walk the hub's name-consistency BFS (hub-enforced; duplicating it
 * buys nothing beyond the checks above). Absent both keys → exactly today's
 * shape (no `pins`/`children` materialized on the return).
 */
export function validateFetchedDef(data: unknown, name: string): FetchedBundle {
  const parent = validateDefEnvelope(data, name);
  const d = data as Record<string, unknown>;
  const rawChildren = d['children'];
  const hasPins = parent.pins !== undefined;
  const hasChildren = rawChildren !== undefined;

  // The hub emits both keys or neither (DD-5).
  if (hasPins !== hasChildren) {
    throw new Error(
      `hub workflow '${name}': ${hasPins ? 'pins present without a children map' : 'children map present without pins'} ` +
        `(the hub emits both or neither)`,
    );
  }

  const bundle: FetchedBundle = parent;
  if (!hasChildren) return bundle;

  if (typeof rawChildren !== 'object' || rawChildren === null || Array.isArray(rawChildren)) {
    throw new Error(`hub workflow '${name}': children is present but not a hash-keyed map`);
  }

  // Validate every child envelope; the map key MUST equal the entry's own hash.
  const children: Record<string, FetchedDef> = {};
  for (const [key, rawChild] of Object.entries(rawChildren as Record<string, unknown>)) {
    const child = validateDefEnvelope(rawChild, `${(rawChild as Record<string, unknown>)?.['name'] ?? '?'}@${key}`);
    if (child.hash !== key) {
      throw new Error(
        `hub workflow '${name}': children map key '${key}' ≠ entry hash '${child.hash}' for child '${child.name}'`,
      );
    }
    children[key] = child;
  }

  // Every pin (the parent's AND every child's, for grandchildren) must resolve
  // into the flat map by hash, and its name must match the entry's name.
  const allPinBearers: FetchedDef[] = [parent, ...Object.values(children)];
  for (const bearer of allPinBearers) {
    for (const pin of bearer.pins ?? []) {
      const target = children[pin.hash];
      if (target === undefined) {
        throw new Error(
          `hub workflow '${name}': pin '${pin.call}'→${pin.name}@${pin.hash} (in '${bearer.name}') ` +
            `has no entry in the children map (partial closure)`,
        );
      }
      if (target.name !== pin.name) {
        throw new Error(
          `hub workflow '${name}': pin '${pin.call}' names child '${pin.name}' but children['${pin.hash}'] ` +
            `is '${target.name}'`,
        );
      }
    }
  }

  bundle.children = children;
  return bundle;
}

/**
 * Fetch and validate a workflow def. Non-2xx becomes a `HubError` (status +
 * message, mirroring the hub client's parse); a 2xx body that is not the
 * enriched shape becomes a plain `Error` from `validateFetchedDef`.
 */
export async function fetchDef(opts: FetchDefOptions): Promise<FetchedBundle> {
  const base = opts.origin.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const token = await opts.getToken();

  const res = await fetchImpl(`${base}/api/workflows/${encodeURIComponent(opts.name)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });

  const raw = await res.text();
  if (!res.ok) {
    let code: string | undefined;
    let message = raw;
    try {
      const body = JSON.parse(raw) as { error?: string; message?: string };
      if (body && typeof body === 'object') {
        code = body.error;
        message = body.message ?? raw;
      }
    } catch {
      // Not JSON — keep the raw text as the message.
    }
    throw new HubError(res.status, message, code);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`hub returned non-JSON for workflow '${opts.name}'`);
  }
  // The envelope is `{ text, ...data }`; the fields we need live at the top level.
  return validateFetchedDef(parsed, opts.name);
}
