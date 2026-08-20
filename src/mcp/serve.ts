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
 *      result object FROM SCRATCH (`{name, crews, stored:true}`) and never
 *      passes any field of the raw body outbound.
 *
 * The transport core is in `./server.ts` (a copy of owenloop's; see its header).
 * Everything owenloop-specific — origin resolution, the authenticated hub
 * client, the tool registrations, the enrollment capability gate, and the
 * command body — lives here.
 */

import { packageVersion } from '../package-version.ts';
import { CliError } from '../util.ts';
import {
  DSSE_SSH_NAMESPACE,
  PrincipalKeyManager,
  buildSubmissionRecord,
  createSshSigner,
  signSubmission,
} from '../crypto/index.ts';
import {
  authHeader,
  ensureFreshOAuth,
  hubFetch,
  refreshOAuth,
  storeCredential,
} from '../credentials.ts';
import type { CredentialIO } from '../credentials.ts';
import {
  DEFAULT_HUB,
  listStoredHubOrigins,
  normalizeOrigin,
  readStoredCredential,
  resolveEndpoint,
} from '../hub.ts';
import type { Credential, CredentialSlotSelector } from '../hub.ts';
import type { Order } from '../types.ts';
import type { SshProcessAdapter } from '../crypto/ssh.ts';
import { globalConfigPath, readGlobalConfig } from '../global-config.ts';
import { createMcpServer, pumpStdin, textResult } from './server.ts';
import type { LineStream, ToolRegistration, ToolResult } from './server.ts';

/**
 * The IO surface `runMcpCommand` needs — a strict subset of the CLI's `CliIO`,
 * which structurally satisfies it, so `dispatchMcp` passes its `io` unchanged.
 * `stdinStream` is the injectable transport (tests feed a `PassThrough`; the
 * command falls back to `process.stdin`).
 */
export interface McpIo extends CredentialIO {
  /** The session's working directory — the repo the MCP host was launched in. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  stdinStream?: LineStream;
  /**
   * Local command runner, used only to read the git `origin` remote for the
   * `start_run` scope default. Without it the default cannot be resolved.
  */
  runCommand?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  principalKeys?: Pick<PrincipalKeyManager, 'inspect' | 'resolveRef' | 'withSigningKey'>;
  /** Injectable ssh-keygen seam for hermetic submit-proof tests. */
  sshProcess?: SshProcessAdapter;
}

/** The resolved server context handed to every tool handler. */
interface McpDeps {
  io: McpIo;
  origin: string;
  /** Repo-name scope default for `start_run`, resolved once at startup. */
  repoScope?: string;
}

/** The human control plane authenticates as the human slot, always. */
const HUMAN: CredentialSlotSelector = { principal: 'human' };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- origin resolution ------------------------------------------------------

/**
 * Resolve the hub origin this server binds to, precedence:
 *   1. `--hub <origin>` flag,
 *   2. `OWENLOOP_HUB` env,
 *   3. `~/.owenloop/config.json` (written by `owenloop login`; see
 *      `src/global-config.ts`'s header for why this is a separate file from
 *      the execution plane's `settings.json`),
 *   4. if the FILE credential backend holds exactly ONE hub with a valid
 *      `human` slot, use it (back-compat for a login that predates rung 3),
 *   5. else `DEFAULT_HUB` (`src/hub.ts`) — the production hub.
 *
 * Rungs 1–2 normalize the origin (a malformed value throws a `CliError` → the
 * command's exit-1 path via `mainAsync`'s catch, matching every other
 * command). Rung 3 reads `home` from `io.env.HOME`/`io.env.USERPROFILE` (the
 * first non-blank of the two, mirroring `src/cli.ts`'s `workflowHome`) — but
 * unlike `workflowHome`, an absent home does NOT throw here: it just means
 * this rung has nothing to offer, same as a missing or malformed config file
 * (`readGlobalConfig` never throws; see its doc comment in
 * `src/global-config.ts`). Rung 4 is file-backend-only because only the file
 * backend can enumerate (`listStoredHubOrigins`); `null` (cannot enumerate —
 * keychain/external), `[]` (nothing stored), and length>1 (ambiguous) are ALL
 * just "this rung has nothing to offer" and fall through to rung 5 — none of
 * them is an error here.
 *
 * This function used to stop at what is now rung 4 and exit 2 instead of
 * falling through, with a comment reading: "DELIBERATELY there is NO silent
 * production fallback (the CLI's `resolveHub` `DEFAULT_HUB` rung): a
 * control-plane server must never bind to a hub the operator did not name."
 * Two things were wrong with that rule:
 *   1. `resolveHub` (`src/cli.ts:2667-2674`) — used by `login` (`:2869`),
 *      `logout` (`:3173`), and `connect` (`:3193`) — ALREADY falls back to
 *      `DEFAULT_HUB`. `capability` and `crew` use `resolveAgentHub` instead;
 *      that resolver has no `DEFAULT_HUB` rung and still exits 2. The `login`
 *      command that CREATES credentials defaults to production while MCP's
 *      startup origin resolution exited 2 before it could reach any read or
 *      write tool. That asymmetry was the real inconsistency.
 *   2. The no-fallback rule bought no safety. With no credential for the
 *      resolved origin, the server fails at the FIRST TOOL CALL with
 *      `loginHint` (below): "not logged in to <origin> — run `owenloop login
 *      --hub <origin>` in a terminal, then retry". That is a strictly better
 *      failure than dying before `initialize` — the host shows an actionable
 *      tool error instead of a dead server.
 */
export function resolveMcpOrigin(io: McpIo, hubFlag: string | undefined): string {
  const explicit = hubFlag ?? io.env.OWENLOOP_HUB;
  if (explicit !== undefined && explicit.trim() !== '') {
    try {
      return normalizeOrigin(explicit);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  }
  const home = [io.env.HOME, io.env.USERPROFILE].find((value) => value !== undefined && value.trim() !== '');
  if (home !== undefined) {
    const config = readGlobalConfig(globalConfigPath(home));
    if (config !== null) return config.hub;
  }
  const origins = listStoredHubOrigins(io.env, io.keychain);
  if (origins !== null && origins.length === 1) {
    return origins[0]!;
  }
  return DEFAULT_HUB;
}

/** Repo-name charset — kept local so this module does not depend on the installer. */
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The default `scope` for a run started from inside a repo session: the repo
 * name, taken from the `origin` remote's URL (last path segment, trailing
 * `.git` removed). Worktree-stable by construction — every checkout of one repo
 * reports the same remote, whereas the directory name differs per worktree.
 *
 * Returns `undefined` — meaning "send no scope at all" — for every failure:
 * no runner seam, not a git repo, no `origin` remote, empty or unparseable URL,
 * or a segment outside the legal charset. Never guesses a label.
 */
export function resolveRepoScope(io: McpIo): string | undefined {
  if (io.runCommand === undefined) return undefined;
  const r = io.runCommand('git', ['-C', io.cwd, 'remote', 'get-url', 'origin']);
  if (r.status !== 0) return undefined;
  const url = r.stdout.trim().replace(/\/+$/, '');
  if (url === '') return undefined;
  const segment = (url.split(/[/:]/).pop() ?? '').replace(/\.git$/, '');
  return REPO_SEGMENT_RE.test(segment) ? segment : undefined;
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

let warnedMcpUnsigned = false;

/** Sign the baseline MCP submit when a claimed order can be resolved locally. */
async function signMcpSubmit(deps: McpDeps, args: Record<string, unknown>): Promise<string | undefined> {
  const workflow = args['workflow'];
  const run = args['run'];
  const path = args['path'];
  if (typeof workflow !== 'string' || typeof run !== 'string' || typeof path !== 'string' || !('value' in args)) {
    return undefined;
  }

  let keys: Pick<PrincipalKeyManager, 'inspect' | 'resolveRef' | 'withSigningKey'>;
  try {
    keys = deps.io.principalKeys ?? new PrincipalKeyManager({ env: deps.io.env });
  } catch (e) {
    warnMcpUnsigned(deps, `machine signing is unavailable (${(e as Error).message}); submitting without a proof`);
    return undefined;
  }

  const ref = keys.resolveRef(deps.origin, 'machine');
  if (ref === null) {
    warnMcpUnsigned(deps, `no machine signing key for ${deps.origin}; submitting without a proof`);
    return undefined;
  }
  const inspected = await keys.inspect(ref);
  if (!inspected.exists || inspected.publicKey === undefined) {
    warnMcpUnsigned(deps, `machine signing key for ${deps.origin} is unavailable; submitting without a proof`);
    return undefined;
  }

  const orderResponse = await callHub(deps, {
    method: 'POST',
    path: '/api/get_order',
    body: { workflow, run },
  });
  if (!isOk(orderResponse.status) || !isObject(orderResponse.json) || !isObject(orderResponse.json['order'])) {
    warnMcpUnsigned(deps, `order metadata for ${workflow}/${run} was unavailable; submitting without a proof`);
    return undefined;
  }

  const order = orderResponse.json['order'] as unknown as Order;
  const version = outputVersion(order, path);
  if (version === undefined) {
    warnMcpUnsigned(deps, `order ${workflow}/${run} omitted authoritative version metadata for output '${path}'; submitting without a proof`);
    return undefined;
  }
  const consumedFingerprint = submissionFingerprint(order, deps);
  if (consumedFingerprint === undefined) return undefined;

  const record = buildSubmissionRecord({
    run: order.run,
    workflow: order.workflow,
    defDigest: order.defDigest,
    step: order.step,
    key: order.key,
    ...(order.index !== undefined ? { index: order.index } : {}),
    produced: [{ artifact: path, version, value: args['value'] }],
    consumedFingerprint,
    producerKeyId: inspected.publicKey.keyid,
    timestamp: Date.now(),
  });

  return keys.withSigningKey(ref, async (keyPath) => {
    const signer = createSshSigner({
      namespace: DSSE_SSH_NAMESPACE,
      signKeyPath: keyPath,
      ...(deps.io.sshProcess !== undefined ? { process: deps.io.sshProcess } : {}),
    });
    return signSubmission(record, signer);
  });
}

function submissionFingerprint(order: Order, deps: McpDeps): NonNullable<Order['consumedFingerprint']> | undefined {
  if (order.consumedFingerprint !== undefined) return order.consumedFingerprint;
  if (order.inputs.length > 0 || Object.keys(order.consumes).length > 0) {
    warnMcpUnsigned(deps, `order ${order.workflow}/${order.run} omitted its consumed fingerprint; submitting without a proof`);
    return undefined;
  }
  return {};
}

/**
 * Resolve a signed submit version from authoritative immutable metadata only.
 * Judge claims name the already-submitted version in their fingerprint; the
 * judge-approve commit does not increment it. Producer claims name
 * `owes[].version`, the target the engine issued for this owed output inside
 * the claim transaction — the version the next successful commit lands, and
 * the version the consumer checks the proof against. It is re-read off the
 * order on every submit and never cached, because a reject that re-arms an
 * open claim re-stamps it. See `outputVersionForSubmission` in
 * packages/work/src/submit-proof.ts for the retry-safety argument; this is the
 * same rule on the local MCP path.
 */
function outputVersion(order: Order, path: string): number | undefined {
  if (order.judge === path) return order.consumedFingerprint?.[path];
  const target = order.owes.find((owed) => owed.path === path)?.version;
  // Only a positive integer is a target this protocol issued; see
  // outputVersionForSubmission for why 0 submits unsigned instead.
  return typeof target === 'number' && Number.isInteger(target) && target > 0 ? target : undefined;
}

function warnMcpUnsigned(deps: McpDeps, reason: string): void {
  if (warnedMcpUnsigned) return;
  warnedMcpUnsigned = true;
  deps.io.err(`owenloop mcp: ${reason}`);
}

/**
 * The 22 baseline tools — names, descriptions, and schemas mirror the hub's own
 * HTTP-MCP toolset (owenloop-service `apps/hub-edge/src/mcp/tools.ts`); each maps
 * to an H3 `/api/*` REST mirror. Descriptions say "Scoped Identity" for the identity
 * (wire names keep `agent`), never "tool" (model-doc §0/§10).
 *
 * This is not the server's whole tool list. `runMcpCommand` assembles the full
 * set: these 22, plus `createAgentTool`, plus the four crew tools from
 * `buildCrewTools` (below — deliberately NOT folded in here, since they do not
 * mirror the hub's own MCP toolset), plus the conditionally-registered
 * `stageEnrollmentTool`.
 */
function buildBaselineTools(deps: McpDeps): ToolRegistration[] {
  return [
    {
      name: 'whats_next',
      description:
		'The chief-of-staff follow-up, tick, and inbox operation: relay returned work or status to the human and let crews execute it rather than treating orders as inline scratchpad work. With workflow: ticks it and returns the next work order(s), or a status summary if none. Without workflow: the inbox of started instances. Serves only YOUR OWN runs by default. Pass serve_crews to partition your own runs further (intersects with each step\'s capabilities; absent or [] = no capability filter). serve_crews is ignored in inbox mode (no workflow).',
      inputSchema: {
        type: 'object',
	properties: {
	  workflow: { type: 'string' },
	  serve_crews: { type: 'array', items: { type: 'string' } },
	  serve_capabilities: {
	    type: 'array',
	    items: { type: 'string' },
	    description:
	      'Raw capability keys this caller serves (bare names and exact compounds). ' +
	      'Shifts derive them from their effective rosters; other callers normally omit them.',
	  },
	},
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/whats_next', body: a })),
    },
    {
      name: 'pending_gates',
      description:
		'Find workflow gates currently waiting on a person. A gate is an owed workflow input that no worker can supply; call this after starting or attending runs, or whenever the human asks what decisions or values need attention. Pass serve_crews to narrow the result to those crews.',
      inputSchema: {
		type: 'object',
		properties: { serve_crews: { type: 'array', items: { type: 'string' } } },
		additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/pending_gates', body: a })),
    },
    {
      name: 'submit',
      description:
		'A crew member or held-order holder returns an owed output here; a chief of staff must not use it to fabricate inline step progress. On schema rejection the run stays open — fix the value and submit again with the same run.',
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
      handler: async (args) => {
        let proof: string | undefined;
        try {
          proof = await signMcpSubmit(deps, args);
        } catch (e) {
          // A configured signer/tool failure is a submit error, not an
          // unsigned fallback. The missing-key cases are handled inside the
          // helper and remain compatible with pre-WP-D2 clients.
          return errorText((e as Error).message);
        }
        const body = proof === undefined ? args : { ...args, proof };
        const r = await callHub(deps, { method: 'POST', path: '/api/submit', body });
        if (r.authFailed) return errorText(r.authMessage ?? loginHint(deps.origin));
        return toolResultFromRest(r);
      },
    },
    {
      name: 'reject_artifact',
      description:
		'Surface actionable feedback on a real upstream defect by sending it to its producer with a concrete reason. Rejection must be handled, never bypassed to force progress.',
      inputSchema: {
        type: 'object',
		properties: {
			workflow: { type: 'string' },
			path: { type: 'string' },
			reason: { type: 'string' },
			requested: { type: 'string' },
		},
        required: ['workflow', 'path', 'reason'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/reject_artifact', body: a })),
    },
    {
      name: 'retry_artifact',
      description:
	"The deliberate human stall-clear and worker-`ask` answer path: re-arm a stalled or rejected artifact to 'owed', resetting its " +
	'reject counters, but never use it to bypass unresolved rejection feedback. `text` rides to the next producer on ' +
	"the artifact's reason thread; omit it only for a bare stall-clear.",
      inputSchema: {
	type: 'object',
	properties: { workflow: { type: 'string' }, path: { type: 'string' }, text: { type: 'string' } },
	required: ['workflow', 'path'],
	additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/retry_artifact', body: a })),
    },
    {
      name: 'provide_input',
      description: 'Relay a human answer into a seeded or owed gate by providing its input value.',
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
      description:
		'For a fitting multi-step playbook, start a run from its selected definition name and let its crews execute; optionally seed provided inputs. ' +
		'`scope` is a free routing label recorded on the run; when omitted it defaults to this ' +
		"session's repository name (the `origin` remote's last path segment) when one can be " +
		'determined, and is sent as nothing otherwise. `priority` is the rate-limit band; omit it ' +
		'and the hub applies `normal`.',
      inputSchema: {
        type: 'object',
		properties: {
			workflow_name: { type: 'string' },
			provide: { type: 'object', additionalProperties: true },
			scope: { type: 'string' },
			// Unlike crew `kind`/`principalKind`, this is a fixed local wire
			// contract, so the MCP schema rejects an out-of-set value too.
			priority: { type: 'string', enum: ['low', 'normal', 'high'] },
		},
        required: ['workflow_name'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({
		method: 'POST',
		path: '/api/start_run',
		// A default, never an override: explicit `scope`, including '', wins.
		body: deps.repoScope !== undefined && !('scope' in a) ? { ...a, scope: deps.repoScope } : a,
      })),
    },
    {
      name: 'create_workflow',
      description:
		'Only when no catalog entry fits and the human chooses ordinary authoring, use this parse-and-load hard gate for a workflow definition YAML. It is stored only if it loads clean; failures return the engine/parser error verbatim. Idempotent: re-pushing identical content is a no-op success (unchanged: true with the existing version); changed content version-forwards.',
      inputSchema: {
        type: 'object',
		properties: { yaml: { type: 'string' }, bundle_digest: { type: 'string' }, ephemeral: { type: 'boolean' } },
        required: ['yaml'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/create_workflow', body: a })),
    },
    {
      name: 'get_workflow',
      description:
		'Inspect a promising catalog entry in full before selecting it: def summary and bundle with steps, consumes/produces, schemas, judges, each step\'s prompt body, model/executor/command, and x extension bags, plus mermaid source and the def content hash/version.',
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
      description: 'Discover published workflow definitions and decide which one fits a task.',
      inputSchema: { type: 'object', properties: { include_ephemeral: { type: 'boolean' } }, additionalProperties: false },
      handler: passthrough(deps, (a) => ({
		method: 'GET',
		path: '/api/workflows',
		...('include_ephemeral' in a ? { query: `?include_ephemeral=${String(a['include_ephemeral'])}` } : {}),
      })),
    },
    {
      name: 'delete_workflow',
      description:
		'Retire an ephemeral workflow live name. Refuses while an active root references its exact pinned definition closure.',
      inputSchema: {
		type: 'object',
		properties: { name: { type: 'string', minLength: 1 } },
		required: ['name'],
		additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/delete_workflow', body: a })),
    },
    {
      name: 'get_status',
      description: 'Inspect and relay a run\'s current state rather than performing its work: engine.status verbatim plus a plain-English one-paragraph rendering.',
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
		'A held-run liveness and first-contact signal, distinct from Shift presence: touch an open run so it is not reaped mid-step (the design-doc "renew"). The first heartbeat on a freshly served claim closes the ~2-minute pickup window. Optionally tag who holds the claim (session or exec).',
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
		'For a holder rebinding to a persisted order already served to it, re-fetch that packet and its live lease state (claimed/claimedAt/heartbeatAt/outcome); this is not workflow discovery. Optionally tag who holds the claim.',
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
		'Give a held claim back so its order can be re-offered without waiting for the reap TTL. Either target one run (`workflow`+`run`) or drain a session (`session`). Idempotent: releasing an unheld/closed run is a no-op, never an error.',
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
		'Delegate event-driven work through matching subscriptions: validate the payload against the pinned contract version schema, then start one run per matched active subscription (best-effort, per-target isolation). Returns the per-match outcome. Requires agent scope `run`.',
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
		"Preview which playbooks a publish may start through the org's contract subscriptions. Creating or revoking a subscription is admin-only and deliberately not exposed here.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/subscriptions' })),
    },
    {
      name: 'presence_ping',
      description:
		'Report Shift availability only by registering or refreshing its presence: name, crews served, and optionally process incarnation. Call it on a ~60s cadence; the entry reads as offline once ~3 min have passed since its last ping — derived when the registry is read, nothing sweeps it. Observability only: it never affects serving and never wakes anyone. This is NOT the lease `heartbeat`, which is per claimed run and whose lapse reaps that claim. Every field overwrites, not keeps-previous: omitting serve_crews stores an empty set, meaning every crew this principal belongs to (the same reading whats_next gives an empty serve_crews), not no crews; omitting shift_id/started_at clears them.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          serve_crews: { type: 'array', items: { type: 'string' } },
	  serve_capabilities: {
	    type: 'array',
	    items: { type: 'string' },
	    description:
	      'Raw capability keys this caller serves (bare names and exact compounds). ' +
	      'Shifts derive them from their effective rosters; other callers normally omit them.',
	  },
          shift_id: { type: 'string' },
          started_at: { type: 'number' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/presence_ping', body: a })),
    },
    {
      name: 'list_shifts',
      description:
		"Show available or offline execution coverage for this principal so gaps can be relayed: registered Shifts with an online/offline flag (derived at read time from its last ping, ~3 min), last-seen age, crews served (returned as `crews`; an empty list means every crew this principal belongs to, not none), and recorded process incarnation (`shiftId`/`startedAt`).",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/shifts' })),
    },
    {
      name: 'get_rosters',
      description:
	"Inspect post-crew routing choices rather than execute work: the org's roster cascade has one org-global capability table plus optional per-crew tables, whose rows select harness/model/effort after the hub has already routed work to a crew.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/rosters' })),
    },
    {
      name: 'list_harness_models',
      description:
	"Read-only roster-planning data: the hub's known harnesses and model snapshots, including each model's supported effort values. Roster writes stay in the terminal CLI.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/harness_models' })),
    },
    {
      name: 'wake',
      description:
		'The cheap place to park between changes: a polling pre-check returning only { cursor, changed }. Keep the returned cursor and pass it next time; call whats_next ONLY when changed is true. Omit cursor to bootstrap. It is not a substitute for whats_next — it never returns work orders, only whether to ask.',
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
 * validated `token` (to store) and the safe `crews` names (to report), and
 * builds `{name, crews, stored:true}` from scratch.
 */
function createAgentTool(deps: McpDeps): ToolRegistration {
  return {
    name: 'create_agent',
    description:
      'Administrative setup that enables crews to execute runs, not the normal task path: create a NEW Scoped Identity on the hub and store its credential locally. NEVER returns the token — it is written to this machine\'s credential store only. Refuses a name that is already taken. Mints with `work` scope by default; pass `scopes` (e.g. ["work","run"]) to choose.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        crews: { type: 'array', items: { type: 'string' } },
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
      // hub is the enforcement of record (same stance as crews).
      const scopesArg = args['scopes'];
      let scopes: string[] | undefined;
      if (scopesArg !== undefined) {
        if (!Array.isArray(scopesArg) || scopesArg.length === 0 || !scopesArg.every((s) => typeof s === 'string' && s !== '')) {
          return errorText('invalid scopes — expected a non-empty array of scope name strings');
        }
        scopes = scopesArg as string[];
      }
      const crews = args['crews'];
      const body: Record<string, unknown> = { name, scopes: scopes ?? ['work'] };
      if (Array.isArray(crews)) body.crews = crews;

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
      // Success: built from scratch. `crews` (crewNames) is safe; token/text/id
      // /agentId/crewIds from the body must never reach an outbound frame.
      const outCrews = isObject(r.json) && Array.isArray(r.json['crews']) ? r.json['crews'] : [];
      return textResult({ name, crews: outCrews, stored: true });
    },
  };
}

/** Tool 20 (gated) — `stage_enrollment`: a plain passthrough (join codes are transcript-legal per model-doc §6). */
function stageEnrollmentTool(deps: McpDeps): ToolRegistration {
  return {
    name: 'stage_enrollment',
    description:
      'Administrative setup that enables crews to execute runs, not the normal task path: stage a Scoped Identity enrollment on the hub, returning a join code the enrolling machine redeems. A join code is transferred authority, not a credential — it is safe to surface.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        crews: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/stage_enrollment', body: a })),
  };
}

/**
 * Crew management — the MCP counterpart to the `owenloop crew` CLI family
 * (`src/cli.ts`'s `dispatchCrew`, merged as PR #88). All FOUR tools below are
 * plain `passthrough` registrations: the hub's crew response bodies carry no
 * secret (unlike `create_agent`'s mint body), so there is no reason to
 * hand-build a result, and the hub's `/api/*` routes plus the verbs underneath
 * them are already the enforcement of record for every field — a client-side
 * copy of that validation would just be a second place for the rules to drift.
 *
 * CREDENTIAL PLANE: unchanged, and worth restating because it is what makes
 * crew mutation reachable at all from this server. `callHub` always
 * authenticates as the `human` slot (`HUMAN`, above) — `owenloop mcp` never
 * calls the hub as a Scoped Identity. On the hub, `createCrew`, `addCrewMember`,
 * and `removeCrewMember` gate through `assertCrewMutationAllowed`
 * (`packages/hub-core/src/verbs/manage-crews.ts`), which falls through to
 * `assertAllowed(actor, 'manage_crews')` — a verb with NO entry in
 * `AGENT_SCOPE_FOR_VERB` (`rbac.ts`), so an agent-kind actor is refused
 * `ForbiddenError` there no matter what scopes it holds. Because this server
 * always authenticates as a human, that refusal never applies to it. `listCrews`
 * is gated on the separate, agent-reachable `list` verb instead.
 *
 * `delete_crew` IS DELIBERATELY ABSENT, and stays absent — a decision by the
 * repo's human owner, not a technical gap. Deleting a crew transfers its live
 * `order_crews` stamps onto the org's orphan crew and deletes the crew's own
 * membership rows outright; that is not an operation a model-driven host
 * should be able to trigger. Do not add a `delete_crew` tool, an env-flag
 * variant, or a confirmation-style variant — `owenloop crew rm` on the CLI
 * remains the only way to delete a crew. Removing a single MEMBER (below) is a
 * different, reversible operation and stays in scope.
 */
function buildCrewTools(deps: McpDeps): ToolRegistration[] {
  return [
    {
      name: 'list_crews',
      description:
		"Inspect execution capacity and membership before a run or membership change: the org's crews, each with its membership rows inline (principalKind/principalId/addedBy/addedAt) — " +
        'one call, no per-crew fan-out. An org with no crews at all is a normal empty result, not an error. ' +
        "The org's reserved ORPHAN crew (kind: \"orphan\", or a name starting \"orphan:\") IS returned when it " +
        'exists and is deliberately NOT filtered out — it is where the hub re-homes work whose crew was ' +
        'deleted, so a caller has to be able to see where that work went. It is materialized LAZILY: a fresh ' +
        "org has none. Its membership is derived (always the org's current admins) and cannot be edited — " +
        'add_crew_member/remove_crew_member both refuse it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: passthrough(deps, () => ({ method: 'GET', path: '/api/crews' })),
    },
    {
      name: 'create_crew',
      description:
		"Configure who can execute by creating a crew on the hub org. `kind` is 'personal' or 'shared', forwarded verbatim — the hub is the " +
        "enforcement of record for legal values ('orphan' is reserved for the hub's own crew and is refused). " +
        "`ownerMemberId` is required for a 'personal' crew and is simply omitted from the request when not " +
        'passed. NOT admin-only: an org admin may create any crew, AND a non-admin may create a personal crew ' +
        'they own by passing kind:"personal" with ownerMemberId set to their own member id (the ' +
        'self-service branch of the mutation gate). A non-admin asking for a shared crew, for a personal crew ' +
        'owned by someone else, or for a personal crew with ownerMemberId OMITTED, is refused 403 — the hub ' +
        'deliberately does not infer the caller as the owner.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string' },
          ownerMemberId: { type: 'string' },
        },
        required: ['name', 'kind'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/create_crew', body: a })),
    },
    {
      name: 'add_crew_member',
      description:
		"Configure who can execute by adding one principal to a crew. `principalKind` is 'member' (a human) or 'agent' (a Scoped Identity), " +
        'forwarded verbatim; the hub validates it. NOT admin-only: an org admin may act on any crew, AND the ' +
        'OWNER of a personal crew may add members to that crew without being an admin. HTTP 400 (not a ' +
        'permissions error, and NOT tolerant): an unknown crewId, an unknown principalId, or a principal that ' +
        'is ALREADY a member — a duplicate add IS an error, unlike remove_crew_member below. REFUSED OUTRIGHT ' +
        "against the org's orphan crew, for every caller including an admin, as a 400 (never a 403 — the " +
        "refusal is identity-independent: it objects to the target crew, not the caller's role). The orphan " +
        "crew's membership is the derived org admin roster and cannot be edited this way.",
      inputSchema: {
        type: 'object',
        properties: {
          crewId: { type: 'string' },
          principalKind: { type: 'string' },
          principalId: { type: 'string' },
        },
        required: ['crewId', 'principalKind', 'principalId'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/add_crew_member', body: a })),
    },
    {
      name: 'remove_crew_member',
      description:
		'Configure who can execute by removing one principal from a crew. TOLERANT: removing a principal that was never a member is a normal ' +
        'success — HTTP 200 with removed:false, NOT a 404. Read the `removed` boolean rather than treating a ' +
        'false as a failure. An unknown crewId is DIFFERENT and is an HTTP 400 error. NOT admin-only: same ' +
        'self-service carve-out as add_crew_member — an org admin, or the owner of the personal crew being ' +
        "acted on. REFUSED OUTRIGHT against the org's orphan crew, for every caller including an admin, as a " +
        '400 — and that orphan refusal is NOT tolerant: it throws even when the principal was never a member, ' +
        'because the objection is to the target crew and is decided before the hub looks at the membership ' +
        'row. Removing a member is reversible. DELETING a crew is deliberately NOT available on this server at ' +
        'all — use the `owenloop crew rm` CLI command for that.',
      inputSchema: {
        type: 'object',
        properties: {
          crewId: { type: 'string' },
          principalId: { type: 'string' },
        },
        required: ['crewId', 'principalId'],
        additionalProperties: false,
      },
      handler: passthrough(deps, (a) => ({ method: 'POST', path: '/api/remove_crew_member', body: a })),
    },
  ];
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
 * EOF. Returns the process exit code: always 0 on stdin EOF — origin
 * resolution has no exit-2 path of its own anymore (see `resolveMcpOrigin`;
 * it always resolves to some origin, falling back as far as `DEFAULT_HUB`).
 * A malformed `--hub`/`OWENLOOP_HUB` still throws a `CliError` (exit-1 path,
 * via `mainAsync`'s catch).
 */
export async function runMcpCommand(io: McpIo, opts: { hubFlag?: string }): Promise<number> {
  const origin = resolveMcpOrigin(io, opts.hubFlag);
  const deps: McpDeps = { io, origin, repoScope: resolveRepoScope(io) };

  const tools = [...buildBaselineTools(deps), createAgentTool(deps), ...buildCrewTools(deps)];
  if (await shouldRegisterEnrollment(deps)) tools.push(stageEnrollmentTool(deps));

  const server = createMcpServer({
    name: 'owenloop-cli-mcp',
    version: packageVersion(),
    tools,
    write: (msg) => io.out(JSON.stringify(msg)),
    err: (line) => io.err(line),
  });

  return new Promise<number>((resolve) => {
    const stream = io.stdinStream ?? (process.stdin as unknown as LineStream);
    pumpStdin(stream, server, () => resolve(0));
  });
}
