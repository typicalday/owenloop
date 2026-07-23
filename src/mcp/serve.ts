/**
 * `owenloop mcp` — the owenloop-cli-mcp stdio control-plane surface (O2).
 *
 * TWO-PLANE MODEL (identity-and-setup-model doc, §5/§6/§8, in the
 * owenloop-service repo): owenloop runs two distinct planes. The HUMAN control
 * plane is the everyday operator surface — starting runs, answering gates,
 * pushing defs — and it authenticates as the logged-in human. The AGENT plane
 * is what a Step Agent uses with its own `olp_` bearer. This module
 * serves the HUMAN plane to a local MCP host (Claude Code) over stdio: it reads
 * newline-delimited JSON-RPC 2.0 on stdin, translates each `tools/call` into one
 * authenticated HTTPS request to the hub's `/api/*` REST mirror, and writes the
 * JSON-RPC reply on stdout. It is spawned by hosts, never run by a human at a
 * prompt.
 *
 * The model doc's cardinal rule (§6): the MODEL must never see a live token.
 * Two consequences are load-bearing here:
 *   1. Every hub call reads the stored `human` credential fresh and refreshes it
 *      through O1's locked path (`ensureFreshOAuth`/`refreshOAuth` in
 *      `src/credentials.ts`); the bearer only ever rides the `Authorization`
 *      header, never a tool result. The server holds NO credential state between
 *      calls — its only state is the resolved origin and the fixed tool list.
 *   2. `create_agent` MINTS an `olp_` agent token and writes it straight to the
 *      local store (`storeCredential`, slot `agent:<name>`, caller-chosen scopes,
 *      default `['work']`);
 *      the token is NEVER returned in a tool result, printed, or logged. The
 *      mint response body carries the plaintext in TWO fields (`data.token` AND
 *      the human `text` "Store this secret now…"), so the handler builds its
 *      result object FROM SCRATCH (`{name, pools, stored:true}`) and never
 *      passes any field of the raw body outbound.
 *
 * The transport core is in `./server.ts` (a copy of owenwork's; see its header).
 * Everything owenloop-specific — origin resolution, the authenticated hub
 * client, the tool registrations, the enrollment capability gate, and the
 * command body — lives here.
 */

import { CliError } from '../util.ts';
import {
  authHeader,
  ensureFreshOAuth,
  hubFetch,
  refreshOAuth,
  storeCredential,
} from '../credentials.ts';
import type { CredentialIO } from '../credentials.ts';
import {
  credentialBackend,
  listStoredHubOrigins,
  normalizeOrigin,
  readStoredCredential,
  resolveEndpoint,
} from '../hub.ts';
import type { Credential, CredentialSlotSelector } from '../hub.ts';
import { createMcpServer, pumpStdin, textResult } from './server.ts';
import type { LineStream, ToolRegistration, ToolResult } from './server.ts';

/**
 * The IO surface `runMcpCommand` needs — a strict subset of the CLI's `CliIO`,
 * which structurally satisfies it, so `dispatchMcp` passes its `io` unchanged.
 * `stdinStream` is the injectable transport (tests feed a `PassThrough`; the
 * command falls back to `process.stdin`).
 */
export interface McpIo extends CredentialIO {
  out: (line: string) => void;
  err: (line: string) => void;
  stdinStream?: LineStream;
}

/** The resolved server context handed to every tool handler. */
interface McpDeps {
  io: McpIo;
  origin: string;
}

/** The human control plane authenticates as the human slot, always. */
const HUMAN: CredentialSlotSelector = { principal: 'human' };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- origin resolution ------------------------------------------------------

/** The exit-2 ambiguity outcome; the caller prints `message` to stderr and returns 2. */
type OriginResolution = { origin: string } | { exitCode: 2; message: string };

/**
 * Resolve the hub origin this server binds to, precedence:
 *   1. `--hub <origin>` flag,
 *   2. `OWENLOOP_HUB` env,
 *   3. if the FILE credential backend holds exactly ONE hub with a valid `human`
 *      slot, use it,
 *   4. else exit 2 with a message naming BOTH remedies.
 *
 * Rungs 1–2 normalize the origin (a malformed value throws a `CliError` → the
 * command's exit-1 path via `mainAsync`'s catch, matching every other command).
 * Rung 3 is file-backend-only because only the file backend can enumerate
 * (`listStoredHubOrigins`); `null` (cannot enumerate — keychain/external), `[]`
 * (nothing stored), and length>1 (ambiguous) each get a tailored exit-2 message.
 *
 * DELIBERATELY there is NO silent production fallback (the CLI's `resolveHub`
 * `DEFAULT_HUB` rung): a control-plane server must never bind to a hub the
 * operator did not name.
 */
export function resolveMcpOrigin(io: McpIo, hubFlag: string | undefined): OriginResolution {
  const explicit = hubFlag ?? io.env.OWENLOOP_HUB;
  if (explicit !== undefined && explicit.trim() !== '') {
    try {
      return { origin: normalizeOrigin(explicit) };
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  }
  const origins = listStoredHubOrigins(io.env, io.keychain);
  if (origins === null) {
    const backend = credentialBackend(io.env, io.keychain);
    const which = backend.kind === 'external' ? 'external-command' : 'keychain';
    return {
      exitCode: 2,
      message:
        `cannot list stored hubs from the ${which} credential store — ` +
        'pass --hub <origin> (or set OWENLOOP_HUB)',
    };
  }
  if (origins.length === 0) {
    return {
      exitCode: 2,
      message: 'no hub credentials stored — run `owenloop login --hub <origin>` first, or pass --hub <origin>',
    };
  }
  if (origins.length > 1) {
    return {
      exitCode: 2,
      message: `multiple hubs in the credential store (${origins.join(', ')}) — pass --hub <origin>`,
    };
  }
  return { origin: origins[0]! };
}

// ---- the authenticated hub client -------------------------------------------

/** The non-interactive "you are not authenticated" instruction (Decision 8). */
function loginHint(origin: string): string {
  return `not logged in to ${origin} — run \`owenloop login --hub ${origin}\` in a terminal, then retry`;
}

interface HubCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** A pre-built query string beginning with `?`, or omitted. */
  query?: string;
}

interface HubCallResult {
  status: number;
  json: unknown;
  /** True when the call could not authenticate (missing/expired/rejected credential). */
  authFailed?: boolean;
  /** The tool-facing message for an `authFailed` result — always names the fix. */
  authMessage?: string;
}

/**
 * Make ONE authenticated hub call for the current `tools/call`, mirroring the
 * CLI's `authedGet` refresh-and-retry discipline (cli.ts):
 *   1. read the `human` slot fresh (picks up a `login` performed while the
 *      server runs) — missing → `authFailed`;
 *   2. `ensureFreshOAuth` (persist=true → O1's locked, double-checked refresh) —
 *      a `CliError` → `authFailed` with its message + the login hint;
 *   3. the HTTP call with `Authorization: authHeader(cred)`;
 *   4. on a 401 with an oauth credential, exactly ONE `refreshOAuth` + one
 *      retry; a final 401 → `authFailed`.
 * The response body is parsed leniently (a parse failure yields `{}`, status
 * preserved). The bearer never leaves the `Authorization` header.
 */
async function callHub(deps: McpDeps, req: HubCall): Promise<HubCallResult> {
  const { io, origin } = deps;

  let cred: Credential | null;
  try {
    cred = readStoredCredential(origin, { principal: 'human', env: io.env, keychain: io.keychain });
  } catch (e) {
    // External-command backend failing to supply a credential is an auth failure.
    return { status: 0, json: undefined, authFailed: true, authMessage: `${(e as Error).message}\n${loginHint(origin)}` };
  }
  if (cred === null) {
    return { status: 0, json: undefined, authFailed: true, authMessage: loginHint(origin) };
  }

  let current: Credential;
  try {
    current = await ensureFreshOAuth(io, origin, HUMAN, cred);
  } catch (e) {
    return { status: 0, json: undefined, authFailed: true, authMessage: `${(e as Error).message}\n${loginHint(origin)}` };
  }

  const fetchOnce = async (c: Credential): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: authHeader(c),
      Accept: 'application/json',
      ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };
    return hubFetch(io, resolveEndpoint(origin, req.path + (req.query ?? '')), {
      method: req.method,
      headers,
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
  };

  let res = await fetchOnce(current);
  if (res.status === 401 && current.kind === 'oauth') {
    try {
      current = await refreshOAuth(io, origin, HUMAN, current as Extract<Credential, { kind: 'oauth' }>);
    } catch (e) {
      return { status: 401, json: undefined, authFailed: true, authMessage: `${(e as Error).message}\n${loginHint(origin)}` };
    }
    res = await fetchOnce(current);
  }
  if (res.status === 401) {
    return { status: 401, json: undefined, authFailed: true, authMessage: loginHint(origin) };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

/** Whether an HTTP status is a 2xx success. */
const isOk = (status: number): boolean => status >= 200 && status < 300;

/**
 * The MCP tool result for a baseline REST passthrough: 2xx → the body as one
 * text block; non-2xx → an `isError` result carrying the body's `message` when
 * it parses as `{error, message}`, else `HTTP <status>`.
 */
function toolResultFromRest(r: HubCallResult): ToolResult {
  if (isOk(r.status)) return textResult(r.json);
  let error = `http_${r.status}`;
  let message = `HTTP ${r.status}`;
  if (isObject(r.json)) {
    if (typeof r.json['error'] === 'string') error = r.json['error'];
    if (typeof r.json['message'] === 'string') message = r.json['message'];
  }
  return textResult({ error, message }, true);
}

/** An `isError` result whose single text block is `text` verbatim (not JSON). */
function errorText(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---- tool table -------------------------------------------------------------

/** JSON-Schema fragment for a `{kind:'session'|'exec', id}` holder tag. */
const HOLDER_SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['session', 'exec'] }, id: { type: 'string' } },
  required: ['kind', 'id'],
  additionalProperties: false,
} as const;

/** Build a baseline passthrough handler from a request-builder. */
function passthrough(deps: McpDeps, build: (args: Record<string, unknown>) => HubCall): ToolRegistration['handler'] {
  return async (args) => {
    const r = await callHub(deps, build(args));
    if (r.authFailed) return errorText(r.authMessage ?? loginHint(deps.origin));
    return toolResultFromRest(r);
  };
}

/**
 * The 17 baseline tools — names, descriptions, and schemas mirror the hub's own
 * HTTP-MCP toolset (owenloop-service `apps/hub-edge/src/mcp/tools.ts`); each maps
 * to an H3 `/api/*` REST mirror. Descriptions say "Scoped Identity" for the identity
 * (wire names keep `agent`), never "tool" (model-doc §0/§10).
 */
function buildBaselineTools(deps: McpDeps): ToolRegistration[] {
  return [
    {
      name: 'whats_next',
      description:
        'THE verb. With workflow: ticks it and returns the next work order(s), or a status summary if none. Without workflow: the inbox of started instances. Serves only YOUR OWN runs by default. Pass serve_pools to partition your own runs further (intersects with each step\'s labels; absent or [] = no label filter). serve_pools is ignored in inbox mode (no workflow).',
      inputSchema: {
        type: 'object',
        properties: { workflow: { type: 'string' }, serve_pools: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/whats_next', body: a })),
    },
    {
      name: 'submit',
      description:
        'Submit a work order output. On schema-rejected the run stays open — fix the value and submit again with the same run.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string' },
          run: { type: 'string' },
          path: { type: 'string' },
          value: { type: 'object', additionalProperties: true },
          done: { type: 'boolean' },
        },
        required: ['workflow', 'run', 'path', 'value'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/submit', body: a })),
    },
    {
      name: 'reject_artifact',
      description: 'Reject an upstream artifact, sending it back to its producer with a reason.',
      inputSchema: {
        type: 'object',
        properties: { workflow: { type: 'string' }, path: { type: 'string' }, reason: { type: 'string' } },
        required: ['workflow', 'path', 'reason'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/reject_artifact', body: a })),
    },
    {
      name: 'provide_input',
      description: 'The human-gate answer path: provide a value for a seeded/owed input.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: { type: 'string' },
          name: { type: 'string' },
          value: { type: 'object', additionalProperties: true },
        },
        required: ['workflow', 'name', 'value'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/provide_input', body: a })),
    },
    {
      name: 'start_run',
      description: 'Create a new workflow instance from a definition name, optionally seeding provided inputs.',
      inputSchema: {
        type: 'object',
        properties: { workflow_name: { type: 'string' }, provide: { type: 'object', additionalProperties: true } },
        required: ['workflow_name'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/start_run', body: a })),
    },
    {
      name: 'create_workflow',
      description:
        'The authoring hard gate: parse + load a workflow def YAML through the engine. Only stored if it loads clean. On failure returns the engine/parser error verbatim. Idempotent: re-pushing identical content is a no-op success (unchanged: true with the existing version); changed content version-forwards.',
      inputSchema: {
        type: 'object',
        properties: { yaml: { type: 'string' } },
        required: ['yaml'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/create_workflow', body: a })),
    },
    {
      name: 'get_workflow',
      description:
        'Def summary and full workflow bundle: steps with consumes/produces, schemas, judges, each step\'s prompt body, model/worker/command, and x extension bags, plus mermaid source and the def content hash/version.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({
        method: 'GET',
        path: `/api/workflows/${encodeURIComponent(String(a['name'] ?? ''))}`,
      })),
    },
    {
      name: 'list_workflows',
      description: 'Names, titles, step counts, and def content hash/version of every loaded workflow definition.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/workflows' })),
    },
    {
      name: 'get_status',
      description: 'engine.status verbatim plus a plain-English one-paragraph rendering.',
      inputSchema: {
        type: 'object',
        properties: { workflow: { type: 'string' } },
        required: ['workflow'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({
        method: 'GET',
        path: `/api/status/${encodeURIComponent(String(a['workflow'] ?? ''))}`,
      })),
    },
    {
      name: 'heartbeat',
      description:
        'Touch the liveness timestamp on an open run so it is not reaped mid-step (the design-doc "renew"). The first heartbeat on a freshly served claim is "first contact" — it closes the ~2-minute pickup window. Optionally tag who holds the claim (session or exec).',
      inputSchema: {
        type: 'object',
        properties: { workflow: { type: 'string' }, run: { type: 'string' }, holder: HOLDER_SCHEMA },
        required: ['workflow', 'run'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/heartbeat', body: a })),
    },
    {
      name: 'get_order',
      description:
        'Re-fetch the persisted order packet for a run you hold, plus its live lease state (claimed/claimedAt/heartbeatAt/outcome) — for a holder rebinding to work it already had served. Optionally tag who holds the claim.',
      inputSchema: {
        type: 'object',
        properties: { workflow: { type: 'string' }, run: { type: 'string' }, holder: HOLDER_SCHEMA },
        required: ['workflow', 'run'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/get_order', body: a })),
    },
    {
      name: 'release',
      description:
        'Voluntarily give back a claim so its order is re-offered without waiting out the reap TTL. Either target one run (`workflow`+`run`) or drain a session (`session`). Idempotent: releasing an unheld/closed run is a no-op, never an error.',
      inputSchema: {
        type: 'object',
        properties: { workflow: { type: 'string' }, run: { type: 'string' }, session: { type: 'string' } },
        additionalProperties: false,
      },
      handler: async (a) => {
        // Mirror the hub tool's client-side "either session or workflow+run" guard.
        const hasSession = a['session'] !== undefined;
        const hasRunPair = a['workflow'] !== undefined && a['run'] !== undefined;
        if (!hasSession && !hasRunPair) {
          return errorText('release requires either `session`, or both `workflow` and `run`.');
        }
        const r = await callHub(deps, { method: 'POST', path: '/api/release', body: a });
        if (r.authFailed) return errorText(r.authMessage ?? loginHint(deps.origin));
        return toolResultFromRest(r);
      },
    },
    {
      name: 'publish_event',
      description:
        'Publish an event against a contract: validate the payload against the pinned contract version schema, then start one run per matched active subscription (best-effort, per-target isolation). Returns the per-match outcome. Requires agent scope `run`.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'integer', minimum: 1 },
          payload: {},
        },
        required: ['name', 'payload'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/publish_event', body: a })),
    },
    {
      name: 'list_subscriptions',
      description:
        "The org's contract subscriptions — what a publish will cascade into. Creating/revoking a subscription is admin-only and deliberately not exposed here.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/subscriptions' })),
    },
    {
      name: 'presence_ping',
      description:
        'Register or refresh this Conductor in the presence registry (name + the labels it serves). Call it on a ~60s cadence; the entry reads as offline after ~3 min of missed pings. Observability only. Omitting serve_pools stores an empty label set (overwrite, NOT keep-previous).',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, serve_pools: { type: 'array', items: { type: 'string' } } },
        required: ['name'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/presence_ping', body: a })),
    },
    {
      name: 'list_conductors',
      description:
        "Your principal's registered Conductors, each with an online/offline flag (derived from its last ping), the labels it serves, and how long since it was last seen.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/conductors' })),
    },
    {
      name: 'wake',
      description:
        'A cheap "has anything relevant to you changed since cursor X" pre-check for a polling loop — returns { cursor, changed }. Keep the returned cursor and pass it next time; call whats_next ONLY when changed is true. Omit cursor to bootstrap. NOT a substitute for whats_next — it never returns work orders, only whether to ask.',
      inputSchema: {
        type: 'object',
        properties: { cursor: { type: 'integer', minimum: 0 } },
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => {
        const cursor = a['cursor'];
        const query = typeof cursor === 'number' ? `?cursor=${encodeURIComponent(String(cursor))}` : undefined;
        return { method: 'GET', path: '/api/wake', query };
      }),
    },
  ];
}

/** Legal agent name, mirroring hub.ts's `ACCOUNT_RE` shape — advisory in the schema, ENFORCED in the handler. */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Tool 18 — `create_agent`. Mints a NEW Scoped Identity and writes its `olp_`
 * token straight to the local store; NEVER returns the token. Decision 6: the
 * mint response leaks the plaintext in `data.token` AND the human `text` field,
 * so this handler never passes the raw body outbound — it takes only the
 * validated `token` (to store) and the safe `pools` names (to report), and
 * builds `{name, pools, stored:true}` from scratch.
 */
function createAgentTool(deps: McpDeps): ToolRegistration {
  return {
    name: 'create_agent',
    description:
      'Create a NEW Scoped Identity on the hub and store its credential locally. NEVER returns the token — it is written to this machine\'s credential store only. Refuses a name that is already taken. Mints with `work` scope by default; pass `scopes` (e.g. ["work","run"]) to choose.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        pools: { type: 'array', items: { type: 'string' } },
        scopes: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const name = args['name'];
      // Re-validate the name BEFORE any network call — the advertised schema is
      // advisory (hosts may not enforce it); `credentialSlot` is the backstop.
      if (typeof name !== 'string' || !AGENT_NAME_RE.test(name)) {
        return errorText('invalid agent name — expected 1-64 chars matching [A-Za-z0-9][A-Za-z0-9._-]*');
      }
      // `scopes` is optional. When present it must be a non-empty array of
      // non-empty strings — validated BEFORE any network call (the schema is
      // advisory). Absent → the `work`-only default. No scope-NAME check: the
      // hub is the enforcement of record (same stance as pools).
      const scopesArg = args['scopes'];
      let scopes: string[] | undefined;
      if (scopesArg !== undefined) {
        if (!Array.isArray(scopesArg) || scopesArg.length === 0 || !scopesArg.every((s) => typeof s === 'string' && s !== '')) {
          return errorText('invalid scopes — expected a non-empty array of scope name strings');
        }
        scopes = scopesArg as string[];
      }
      const pools = args['pools'];
      const body: Record<string, unknown> = { name, scopes: scopes ?? ['work'] };
      if (Array.isArray(pools)) body.pools = pools;

      const r = await callHub(deps, { method: 'POST', path: '/api/mint_agent_token', body });
      if (r.authFailed) return errorText(r.authMessage ?? loginHint(deps.origin));
      if (!isOk(r.status)) {
        // Surface the hub's `message` ONLY (error bodies never carry tokens, but
        // never echo the whole body regardless).
        const message = isObject(r.json) && typeof r.json['message'] === 'string' ? r.json['message'] : `HTTP ${r.status}`;
        return errorText(message);
      }

      // 2xx: extract and validate the token WITHOUT echoing the body.
      const token = isObject(r.json) ? r.json['token'] : undefined;
      if (typeof token !== 'string' || !token.startsWith('olp_')) {
        return errorText('hub response did not include an agent token');
      }
      try {
        await storeCredential(deps.io, deps.origin, { principal: 'agent', account: name }, { kind: 'agent', accessToken: token });
      } catch (e) {
        return errorText(
          `${(e as Error).message} — the minted token was NOT stored — revoke/re-key the Scoped Identity '${name}' from the console`,
        );
      }
      // Success: built from scratch. `pools` (poolNames) is safe; token/text/id
      // /agentId/poolIds from the body must never reach an outbound frame.
      const outPools = isObject(r.json) && Array.isArray(r.json['pools']) ? r.json['pools'] : [];
      return textResult({ name, pools: outPools, stored: true });
    },
  };
}

/** Tool 19 (gated) — `stage_enrollment`: a plain passthrough (join codes are transcript-legal per model-doc §6). */
function stageEnrollmentTool(deps: McpDeps): ToolRegistration {
  return {
    name: 'stage_enrollment',
    description:
      'Stage a Scoped Identity enrollment on the hub, returning a join code the enrolling machine redeems. A join code is transferred authority, not a credential — it is safe to surface.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        pools: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/stage_enrollment', body: a })),
  };
}

// ---- enrollment capability gate (Decision 7) --------------------------------

/** The probe deadline; `OWENLOOP_MCP_PROBE_TIMEOUT_MS` overrides the 3000ms default. */
function probeTimeoutMs(env: Record<string, string | undefined>): number {
  const override = Number(env.OWENLOOP_MCP_PROBE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 3000;
}

/**
 * Decide, ONCE at startup, whether `stage_enrollment` is registered (the core's
 * tool list is fixed at construction). `OWENLOOP_MCP_ENROLLMENT=1` → yes; `=0` →
 * no; unset → PROBE. Probe (only when a human credential is stored): a
 * short-deadline `POST /api/stage_enrollment {}` via the authed client; register
 * iff the call completes with a status that is neither 404 nor 401 (a registered
 * route answers 400/403/2xx to an empty body; an unregistered route 404s). Any
 * network error, timeout, refresh failure, or missing credential → NOT
 * registered (fail-closed: worst case the tool is hidden until H4/H7 revisit).
 */
async function shouldRegisterEnrollment(deps: McpDeps): Promise<boolean> {
  const flag = deps.io.env.OWENLOOP_MCP_ENROLLMENT;
  if (flag === '1') return true;
  if (flag === '0') return false;
  try {
    const cred = readStoredCredential(deps.origin, { principal: 'human', env: deps.io.env, keychain: deps.io.keychain });
    if (cred === null) return false;
    const probeTimeout = probeTimeoutMs(deps.io.env);
    const probeIo: McpIo = { ...deps.io, env: { ...deps.io.env, OWENLOOP_HUB_TIMEOUT_MS: String(probeTimeout) } };
    const r = await callHub({ io: probeIo, origin: deps.origin }, { method: 'POST', path: '/api/stage_enrollment', body: {} });
    if (r.authFailed) return false;
    return r.status !== 404 && r.status !== 401;
  } catch {
    return false;
  }
}

// ---- command body -----------------------------------------------------------

/**
 * Run the `owenloop mcp` command: resolve the origin, decide the enrollment
 * gate, build the tool list, construct the JSON-RPC server, and pump stdin until
 * EOF. Returns the process exit code: 2 on an origin-ambiguity (message to
 * stderr, nothing to stdout — stdout is the protocol channel), else 0 on stdin
 * EOF. A malformed `--hub`/`OWENLOOP_HUB` throws a `CliError` (exit-1 path).
 */
export async function runMcpCommand(io: McpIo, opts: { hubFlag?: string }): Promise<number> {
  const resolved = resolveMcpOrigin(io, opts.hubFlag);
  if ('exitCode' in resolved) {
    io.err(resolved.message);
    return resolved.exitCode;
  }
  const deps: McpDeps = { io, origin: resolved.origin };

  const tools = [...buildBaselineTools(deps), createAgentTool(deps)];
  if (await shouldRegisterEnrollment(deps)) tools.push(stageEnrollmentTool(deps));

  const server = createMcpServer({
    name: 'owenloop-cli-mcp',
    version: '0.0.1',
    tools,
    write: (msg) => io.out(JSON.stringify(msg)),
    err: (line) => io.err(line),
  });

  return new Promise<number>((resolve) => {
    const stream = io.stdinStream ?? (process.stdin as unknown as LineStream);
    pumpStdin(stream, server, () => resolve(0));
  });
}
