/**
 * The two hub endpoints `owenloop install` needs, deliberately confined to this
 * one file.
 *
 * ## Read this before changing a path or a body key
 *
 * The READ half is LIVE. `owenloop-service` ships
 * `GET /api/capability_mappings` (optional `?def=<name>`), backed by the
 * `capability_mappings` table PR #222 built and the offer-time resolver that
 * consumes it. Its body is a ROW ARRAY, not the compact map this file first
 * proposed — `asCapabilityMappings` accepts both and the difference is
 * explained there, not here.
 *
 * The WRITE half `install` needs is STILL MISSING, and the gap is narrower than
 * it looks. The hub ships `POST /api/set_capability_mapping` — SINGULAR, ONE
 * ROW per call, `{defName, authored, target}` — which is the right shape for an
 * operator repointing one capability by hand. `install` needs the PLURAL
 * `POST /api/set_capability_mappings` `{def, mappings}` instead, and the plural
 * is not sugar over N singular calls:
 *
 *  - **One transaction or none.** `install` publishes the def the instant this
 *    returns. A loop that fails on its fourth capability leaves three rows
 *    written and then either publishes a half-scoped def or must unwind writes
 *    it cannot unwind atomically. The whole reason the mapping is recorded
 *    BEFORE the publish is that a failure must leave NOTHING applied.
 *  - **One audit act.** An install remaps a def's whole vocabulary in one
 *    operator decision. N audit rows for one act is a worse record of it.
 *
 * `POST /api/create_workflow`'s input surface is `yaml`, `bundle_digest`,
 * `owner_crew_id`. An extra body key on it would be **silently ignored, not
 * rejected** — the mapping would vanish with no error, the worst available
 * failure mode. That is why the mapping travels as its own call and why this
 * module is a single reconciliation point.
 *
 * ## Contract
 *
 * ```
 * GET  /api/capability_mappings?def=<name>          ← LIVE
 *      200 { mappings: [ { defName, authored, target, … }, … ] }
 *      200 { ok: true, mappings: { <authored>: <orgName>, … } }   (older hubs)
 *      404 | 501  → the hub does not implement it
 *
 * POST /api/set_capability_mappings                 ← NOT YET SHIPPED
 *      body { def: <name>, mappings: { <authored>: <orgName>, … } }
 *      200 { ok: true }
 *      404 | 501  → the hub does not implement it
 * ```
 *
 * Identity entries (`orgName === authored`) are dropped hub-side by the
 * resolver, so a caller whose every entry is the identity must skip the write
 * entirely rather than post a no-op — see `dispatchInstall`.
 *
 * ## Transport
 *
 * Both calls take an injected `CapabilityMappingTransport` rather than
 * importing a fetch helper: `cli.ts` builds it from `authedGet` / `authedPost`,
 * so these calls inherit `ensureFreshOAuth`, the single 401-refresh-and-retry,
 * `hubFetch`'s 30s deadline, its bounded body read and `redirect: 'error'`,
 * without this module importing `cli.ts` (which would be an import cycle and a
 * boundary violation).
 *
 * Error discipline mirrors `dispatchCapability`: a 401 that survived the retry
 * is the "credential rejected" wording the caller upgrades to exit 3; any other
 * non-2xx surfaces the hub's typed `message` VERBATIM and never raw body text;
 * a malformed JSON body is a FIXED string, never V8's `SyntaxError` (which
 * embeds a snippet of the body).
 */
import { asCapabilityMappings } from './hub.ts';
import { CliError } from './util.ts';

/** `GET`/`POST` against the resolved hub with a bearer credential already applied. */
export interface CapabilityMappingTransport {
  get(path: string): Promise<Response>;
  post(path: string, body: unknown): Promise<Response>;
}

/** Read half of the contract — shipped. */
export const CAPABILITY_MAPPINGS_READ_PATH = '/api/capability_mappings';
/** Write half of the contract — the PLURAL verb no shipped hub has yet. */
export const CAPABILITY_MAPPINGS_WRITE_PATH = '/api/set_capability_mappings';

/**
 * A status that means "this hub build does not have the endpoint at all",
 * as distinct from "the endpoint rejected this request".
 *
 * `404` is what a hub edge with no such route answers; `501` is what one that
 * knows the route but has not implemented the verb would answer. Both are
 * capability probes, never request-level failures — no other status is treated
 * as one, so a `400` or `403` stays a loud error.
 */
function isUnimplemented(status: number): boolean {
  return status === 404 || status === 501;
}

/** The hub's typed `message`, or `undefined` when the body carries none. */
async function hubMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    if (typeof body === 'object' && body !== null) {
      const m = (body as Record<string, unknown>).message;
      if (typeof m === 'string' && m !== '') return m;
    }
  } catch {
    // Non-JSON body — the caller falls through to a generic status message.
  }
  return undefined;
}

/** The 401-then-non-2xx ladder both calls share, worded per endpoint. */
async function assertCallOk(res: Response, origin: string): Promise<void> {
  if (res.status === 401) {
    // Survived the transport's one refresh-and-retry. The caller's catch
    // upgrades this exact wording to exit 3, the way `dispatchCapability` does.
    throw new CliError('credential rejected by the hub — run `owenloop login`');
  }
  if (!res.ok) {
    throw new CliError((await hubMessage(res)) ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  }
}

/**
 * Read the `authored → org` mappings already recorded for `defName`.
 *
 * Returns `'unsupported'` — a sentinel, not an empty map — when the hub has no
 * such endpoint. The distinction is load-bearing: an empty map means "this def
 * has no mapping recorded", so nothing needs carrying forward, while
 * `'unsupported'` means "this hub cannot tell you", and the caller must warn
 * before it asks the operator about capabilities that may already be linked.
 */
export async function fetchCapabilityMappings(
  transport: CapabilityMappingTransport,
  defName: string,
  origin: string,
): Promise<Record<string, string> | 'unsupported'> {
  const res = await transport.get(`${CAPABILITY_MAPPINGS_READ_PATH}?def=${encodeURIComponent(defName)}`);
  if (isUnimplemented(res.status)) return 'unsupported';
  await assertCallOk(res, origin);
  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new CliError('capability_mappings: malformed success response — body is not valid JSON');
  }
  try {
    return asCapabilityMappings(body, defName);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

/**
 * Record `authored → org` mappings for `defName`, replacing what is stored for
 * the authored names it names.
 *
 * A hub without the endpoint is a **hard, exit-2 failure naming the missing
 * verb** — never a warning and never a silent skip. `install` calls this BEFORE
 * it publishes precisely so this failure leaves nothing half-applied: no def
 * has been pushed, so the org vocabulary is untouched.
 */
export async function recordCapabilityMappings(
  transport: CapabilityMappingTransport,
  defName: string,
  mappings: Record<string, string>,
  origin: string,
): Promise<void> {
  const res = await transport.post(CAPABILITY_MAPPINGS_WRITE_PATH, { def: defName, mappings });
  if (isUnimplemented(res.status)) {
    throw new CliError(
      `hub ${origin} does not implement POST ${CAPABILITY_MAPPINGS_WRITE_PATH} (HTTP ${res.status}) — ` +
        'it cannot record a def\'s mapping in one transaction, so this def was NOT published. ' +
        'This hub may still have the SINGULAR /api/set_capability_mapping, which writes one row per ' +
        'call; install does not use it, because a partial write followed by a publish is exactly the ' +
        'half-applied state recording-before-publishing exists to prevent. Until the batch verb ships, ' +
        'only an identity mapping (every capability keeping its authored name) can be installed.',
      { exitCode: 2 },
    );
  }
  await assertCallOk(res, origin);
}
