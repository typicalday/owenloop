/**
 * `codexAdapter` — the `HarnessAdapter` for OpenAI's `codex app-server`
 * (pinned to `codex-cli 0.146.0`, the `"codex"` key in `harness-versions.json`).
 *
 * THIS IS THE ONLY FILE UNDER `src/harness/` ALLOWED TO KNOW THE NAME `codex`.
 * `test/harness-isolation.test.ts` allowlists `src/harness/codex.ts` by exact
 * path; every other module in the layer, including `./jsonrpc-stdio.ts`, is
 * checked against `/claude|codex|anthropic|openai/i` over its full text,
 * comments included. Keep vendor knowledge — argv, method names, param shapes,
 * notification names — inside this file.
 *
 * Attribution: the JSON-RPC client in `./jsonrpc-stdio.ts` was adapted from the
 * kanna project (`github.com/jakemor/kanna`), specifically the knowledge in its
 * `src/server/codex-app-server.ts` and `src/server/codex-app-server-protocol.ts`
 * — knowledge only, no source, and kanna is not a dependency. Copyright (c) 2025
 * Jake Mor. Its LICENSE is the MIT text with the grant narrowed to "any person
 * other than Jacob Eiting and RevenueCat, Inc." (which is why GitHub reports
 * NOASSERTION rather than MIT). That carve-out does not name typicalday, so the
 * port is permitted; the permission notice requires the copyright line be
 * reproduced, which it is here and in `./jsonrpc-stdio.ts`.
 *
 * PROTOCOL FACTS THIS FILE IS BUILT ON (all probed against the pinned binary on
 * 2026-07-30; the full account is `docs/agent-runner.md`, "Phase 2B"):
 *  - `thread/start` does NOT carry the brief. The brief rides a separate
 *    `turn/start`.
 *  - There is a mandatory `initialize` request followed by an `initialized`
 *    notification. Both are in the DEFAULT (non-experimental) method set.
 *  - Inbound frames omit the `jsonrpc` member entirely.
 *  - An unknown method sent as a REQUEST (one carrying an `id`) IS answered, but
 *    with `-32600 Invalid request: unknown variant '<method>', expected one of
 *    ...` — NOT the `-32601 Method not found` the JSON-RPC spec reserves for it.
 *    Sent as a NOTIFICATION (no `id`) it is silently dropped, which is correct.
 *    Malformed params on a KNOWN method also come back as `-32600`
 *    (`Invalid request: missing field 'threadId'`). So `-32600` is this server's
 *    catch-all for "I could not make sense of your request" — see below.
 *  - An unknown thread id on `thread/resume` returns `-32600` with the message
 *    `no rollout found for thread id <id>`. Because `-32600` is the catch-all
 *    above, the resume-unavailable test matches the code AND the message.
 *  - `turn/start`'s RESPONSE is an ACK: it came back in 5 ms carrying the created
 *    `Turn` with `status:'inProgress'`, while the turn actually ended 7.4 s later
 *    with a `turn/completed` notification. Resolving `start`/`deliver` on the
 *    response would report a finished turn that had barely begun. Both recorded
 *    timings are visible in `test/fixtures/codex-app-server-session.jsonl`.
 *  - The owenwork MCP mount is `config.mcp_servers.<name>`, a PER-THREAD option
 *    that MERGES with `~/.codex/config.toml` rather than replacing it.
 *  - An MCP server child does NOT inherit this process's environment. codex hands
 *    it only `HOME, LOGNAME, PATH, SHELL, TMPDIR, USER, __CF_USER_TEXT_ENCODING`
 *    plus `mcp_servers.<name>.env`. See `mountEnv` — without it the owenwork
 *    mount dies before its MCP `initialize` reply and the step agent has no
 *    `submit` tool.
 *
 * ENVIRONMENT IS INHERITED UNTOUCHED — a decision, not an omission. `codex`
 * reads its own `~/.codex/auth.json` or the OS keyring, and there is no API-key
 * environment variable on this side that silently shadows subscription auth and
 * bills API credits. The Claude adapter strips its child environment for exactly
 * that reason; copying the strip here would be cargo-culted protection against a
 * failure mode that does not exist. So: no `env` on the spawn, no strip list, no
 * billing opt-out flag.
 *
 * Failure stance: every diagnostic leaves as `{kind:'progress'}` through
 * `onEvent` — nothing under `src/` prints. A resume against a token the provider
 * has forgotten rejects with `ResumeUnavailableError`; every other failure emits
 * `{kind:'exited'}` and rejects with the underlying error.
 */
import { existsSync } from 'node:fs';

import { ResumeUnavailableError } from './contract.ts';
import type {
  AgentEvent,
  DeliverArgs,
  HarnessAdapter,
  HarnessSessionRef,
  StartArgs,
} from './contract.ts';
import { register } from './registry.ts';
import { ADMITTED_OWENWORK_KEYS, filterOwenworkEnv } from './child-env.ts';
import { JsonRpcError, startStdioRpc, type StdioRpcClient } from './jsonrpc-stdio.ts';

/** The adapter id. Matches the `"codex"` key in `harness-versions.json`, so the
 *  runner can use one string for both the version pin and the adapter lookup. */
export const HARNESS_ID = 'codex';

/** The MCP server name the step agent's `get_order` / `submit` tools live under. */
const OWENWORK_MCP_NAME = 'owenwork';

/** `codex app-server` — the subcommand that speaks JSON-RPC over stdio. */
const APP_SERVER_ARGS = ['app-server'] as const;

/** Client identity sent on `initialize`. Version is informational only. */
const CLIENT_INFO = { name: 'owenwork', version: '0.1.0' } as const;

/** Handshake and thread setup are fast; a long budget would only mask a hang. */
const SETUP_TIMEOUT_MS = 30_000;
/**
 * Budget for the `turn/start` ACK only — measured at 5 ms, so this is enormous
 * slack, deliberately. It costs nothing: the gate settles on `turn/completed`
 * independently, so a generous ack budget can never delay a finished turn, while
 * a tight one could fail a healthy turn on a slow machine.
 */
const TURN_START_TIMEOUT_MS = 15 * 60_000;
/** `turn/interrupt` is best-effort during teardown; never block on it. */
const INTERRUPT_TIMEOUT_MS = 5_000;
/**
 * How long teardown waits, AFTER an accepted `turn/interrupt`, for the server to
 * emit the `turn/completed` that carries `status:'interrupted'`.
 *
 * Without this wait, teardown would kill the child while the in-flight
 * `start`/`deliver` promise is still parked on the gate; the child's death then
 * REJECTS that promise through `onExit`, and a caller who asked for an orderly
 * stop gets a process-death error instead of an interrupted turn. Bounded, so a
 * server that never answers cannot stall teardown.
 */
const INTERRUPT_SETTLE_MS = 5_000;
/** `item/commandExecution/outputDelta` can be enormous; cap what reaches the log. */
const PROGRESS_TEXT_CAP = 2_000;

/**
 * The resume-failure signature, in ONE place.
 *
 * Observed verbatim on 0.146.0: `no rollout found for thread id <uuid>` with
 * code `-32600`. The `thread not found` alternative is defensive against a
 * wording change.
 *
 * Matching `-32600` ALONE would be actively wrong, and that is measured, not
 * assumed: the same code and no other comes back for an unknown method name
 * (`unknown variant '<method>'`) and for a missing required param
 * (`missing field 'threadId'`). A client that read bare `-32600` as
 * "thread is gone" would answer a typo in a method name by throwing away a live
 * thread and cold-replaying the entire step.
 */
export const RESUME_UNAVAILABLE_MESSAGE_RE = /no rollout found|thread not found/i;
/** The JSON-RPC code the resume failure rides. Never sufficient on its own. */
export const RESUME_UNAVAILABLE_CODE = -32600;

/** True only when BOTH the code and the message say "I do not know this thread". */
export function isResumeMiss(err: unknown): boolean {
  if (!(err instanceof JsonRpcError)) return false;
  return err.code === RESUME_UNAVAILABLE_CODE && RESUME_UNAVAILABLE_MESSAGE_RE.test(err.message);
}

/** The three legal `SandboxMode` values in 0.146.0. */
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
/**
 * Default sandbox. A delivery-line step agent must be able to edit its own
 * worktree, so `read-only` would fail every builder step; `danger-full-access`
 * is available when a step asks for it, but granting it silently is not this
 * adapter's call.
 */
const DEFAULT_SANDBOX = 'workspace-write';

/**
 * `AskForApproval` values this adapter passes through untouched (the server's
 * own vocabulary). Anything else maps to `'never'`.
 */
const NATIVE_APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never']);

/**
 * `permissionMode` → `approvalPolicy`.
 *
 * `'never'` is the default for everything unrecognized, and that is a decision:
 * this runs headless with no human on the other end, so any policy that can
 * raise a `requestApproval` server request converts a stalled approval into an
 * order that hangs past the runner's lease. The adapter still answers those
 * requests defensively (see `handleServerRequest`) — belt and braces, because
 * `approvalPolicy` does not govern every request kind.
 */
function toApprovalPolicy(mode: string | undefined): string {
  if (mode === undefined) return 'never';
  if (NATIVE_APPROVAL_POLICIES.has(mode)) return mode;
  return 'never';
}

function isPlainMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One entry in `config.mcp_servers`. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Non-`OWENWORK_*` variables the owenwork CLI reads and the mount must carry.
 * `HOME` is already in codex's own core set; re-supplying it costs nothing and
 * keeps this list a complete statement of what the child needs.
 */
const MOUNT_ENV_KEEP = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const;

/**
 * The environment for the owenwork mount, forwarded from THIS process.
 *
 * MEASURED, not assumed: `codex app-server` 0.146.0 does NOT give an MCP server
 * child its own environment. It hands the child exactly
 * `HOME, LOGNAME, PATH, SHELL, TMPDIR, USER, __CF_USER_TEXT_ENCODING`
 * plus whatever `mcp_servers.<name>.env` supplies. So `OWENWORK_TOKEN` never
 * arrives on its own, `owenloop work hold --mcp` exits 2 before answering
 * `initialize`, and codex reports the mount as
 * `status:'failed'` / `handshaking with MCP server failed: connection closed:
 * initialize response`. The agent then has no `submit` tool and the order can
 * never complete. The Claude adapter never needed this because Claude Code
 * passes its own environment to MCP children.
 *
 * PHASE 6 NARROWED THE `OWENWORK_*` HALF FROM A PREFIX TO AN ALLOWLIST. It used
 * to forward the whole `OWENWORK_*` prefix so a new variable could not silently
 * stop reaching the mount. That default is now inverted: `ADMITTED_OWENWORK_KEYS`
 * (`src/harness/child-env.ts`) enumerates the names a harness child may see, and
 * a new `OWENWORK_*` variable does NOT reach the mount until somebody adds it
 * there with a named consumer. The reason is the same fact that made the prefix
 * rule better than `{...process.env}`: `thread/start` params are persisted in
 * codex's rollout file, so anything that reaches this mount has a path to disk —
 * and the hub bearer override in particular must not take it.
 *
 * `MOUNT_ENV_KEEP` is unchanged. Note that the mount's environment is exactly
 * what this function returns, so an ambient variable that is neither admitted
 * nor in `MOUNT_ENV_KEEP` reaches the mount only through codex's own core set.
 *
 * This does not contradict "environment inherited untouched": that was about the
 * `codex app-server` SPAWN, which now applies the same namespace filter and
 * nothing else. This function restores what codex strips back off one specific
 * child — the unified owenloop binary's work-holder command.
 */
function mountEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ADMITTED_OWENWORK_KEYS.has(key) || (MOUNT_ENV_KEEP as readonly string[]).includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

/** The mount for owenwork's own work-holder MCP surface, verbatim from the runner. */
function owenworkMount(mcp: { command: string; args: string[] }): McpServerSpec {
  return { command: mcp.command, args: [...mcp.args], env: mountEnv() };
}

/**
 * Build the `thread/start` params. PURE — exported for tests.
 *
 * Takes `DeliverArgs`, not `StartArgs`, because it never reads `brief` and Phase
 * 4's `deliver` needs the identical mapping (`StartArgs` is assignable to
 * `DeliverArgs`, so every `start` call site is unaffected).
 *
 * Deliberately unmapped, so a reader sees intent rather than oversight:
 *  - `permissions.tools` / `permissions.disallowedTools`: 0.146.0 has no
 *    per-thread built-in-tool allow-list; the sandbox and the approval policy
 *    are the levers it does have.
 *  - `permissions.maxTurns`: no `thread/start` or `turn/start` equivalent.
 *  - `permissions.effort`: not a `ThreadStartParams` field — it is a
 *    `turn/start` param, so it lands in `buildTurnStartParams`.
 *  - every `extensions` key other than `mcpServers`, `codexConfig` and
 *    `sandbox`: those are the other harness's frontmatter concepts (`hooks`,
 *    `memory`, `skills`, `background`, `isolation`, `color`, `initialPrompt`).
 *    Unknown keys are ignored silently; `owenloop work lint` is where an unknown key
 *    gets warned about.
 */
export function buildThreadStartParams(
  args: DeliverArgs,
  onEvent?: (e: AgentEvent) => void,
): Record<string, unknown> {
  const ext = args.permissions.extensions;

  // The escape hatch: any other config key, without re-opening the contract.
  // `mcp_servers` is merged in AFTER it, so the owenwork mount always wins.
  const extraConfig = isPlainMap(ext['codexConfig']) ? { ...ext['codexConfig'] } : {};

  const bagServers = isPlainMap(ext['mcpServers']) ? ext['mcpServers'] : {};
  const configuredServers = isPlainMap(extraConfig['mcp_servers']) ? extraConfig['mcp_servers'] : {};
  const mcpServers: Record<string, unknown> = {
    ...configuredServers,
    ...bagServers,
    // The owenwork mount wins on a key clash, mirroring how the legacy
    // frontmatter builder overwrites an author's own `owenwork` entry. Without
    // it the agent has no `submit` tool and the order can never complete.
    [OWENWORK_MCP_NAME]: owenworkMount(args.owenworkMcp),
  };

  const config: Record<string, unknown> = { ...extraConfig, mcp_servers: mcpServers };

  const params: Record<string, unknown> = {
    cwd: args.cwd,
    config,
    approvalPolicy: toApprovalPolicy(args.permissions.permissionMode),
    sandbox: resolveSandbox(ext['sandbox'], onEvent),
  };

  if (
    args.permissions.permissionMode !== undefined &&
    !NATIVE_APPROVAL_POLICIES.has(args.permissions.permissionMode)
  ) {
    onEvent?.({
      kind: 'progress',
      text: `permissionMode '${args.permissions.permissionMode}' has no approval-policy equivalent; using 'never'`,
    });
  }

  // Phase 1's precedence rule, verbatim: the per-start override beats the
  // normalized step-def value. Omit the KEY entirely when neither is set —
  // sending `model: null` would pin the thread to a null model rather than
  // letting the server pick its default.
  const model = args.model ?? args.permissions.model;
  if (model !== undefined) params['model'] = model;

  return params;
}

/** Validate an `extensions.sandbox` override, dropping anything illegal loudly. */
function resolveSandbox(raw: unknown, onEvent?: (e: AgentEvent) => void): string {
  if (raw === undefined) return DEFAULT_SANDBOX;
  if (typeof raw === 'string' && SANDBOX_MODES.has(raw)) return raw;
  onEvent?.({
    kind: 'progress',
    text: `ignoring unrecognized sandbox '${String(raw)}'; using '${DEFAULT_SANDBOX}'`,
  });
  return DEFAULT_SANDBOX;
}

/**
 * Build the `turn/start` params. PURE — exported for tests.
 *
 * `input` is an ARRAY of `UserInput`; the text variant is `{type:'text', text}`.
 * A bare string is the natural wrong guess and the server rejects it.
 */
export function buildTurnStartParams(
  threadId: string,
  text: string,
  effort?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId,
    input: [{ type: 'text', text }],
  };
  // `ReasoningEffort` is `{"type":"string","minLength":1}` — an OPEN string, not
  // a closed union, so a non-empty value passes through unnarrowed.
  if (effort !== undefined && effort !== '') params['effort'] = effort;
  return params;
}

/**
 * Build the `thread/resume` params. PURE — exported for tests.
 *
 * `base` is the resolved `thread/start` params from the session map when this
 * process started the thread. `ThreadResumeParams` accepts `approvalPolicy`,
 * `sandbox`, `model` and `config`, and a resumed thread that does not re-supply
 * them reverts to the server's defaults.
 *
 * PHASE 4 CLOSED CONTRACT OBSERVATION 1. `deliver`'s third argument used to carry
 * only `cwd` and `owenworkMcp`, so a resume in a different process from the start
 * (the normal case for a re-offered step) had nothing to rebuild `approvalPolicy`
 * / `sandbox` / `model` from and silently reverted to server defaults. It now
 * carries the normalized `StepPermissions`, so this function derives the SAME
 * params `buildThreadStartParams` would, and `args` WINS over `base` on every
 * key — `base` only fills in what a `DeliverArgs` cannot express.
 *
 * The owenwork mount is ALWAYS re-supplied. Without it the resumed agent has no
 * `submit` tool — a silent, total failure.
 */
export function buildThreadResumeParams(
  threadId: string,
  args: DeliverArgs,
  base?: Record<string, unknown>,
  onEvent?: (e: AgentEvent) => void,
): Record<string, unknown> {
  const fromArgs = buildThreadStartParams(args, onEvent);

  const baseConfig = base !== undefined && isPlainMap(base['config']) ? base['config'] : {};
  const argsConfig = isPlainMap(fromArgs['config']) ? fromArgs['config'] : {};
  const baseServers = isPlainMap(baseConfig['mcp_servers']) ? baseConfig['mcp_servers'] : {};
  const argsServers = isPlainMap(argsConfig['mcp_servers']) ? argsConfig['mcp_servers'] : {};

  const params: Record<string, unknown> = {
    ...(base ?? {}),
    ...fromArgs,
    threadId,
    config: {
      ...baseConfig,
      ...argsConfig,
      // `argsServers` already carries the owenwork mount and is spread last, so
      // the mount still wins over anything `base` held under the same name.
      mcp_servers: { ...baseServers, ...argsServers },
    },
  };
  return params;
}

// ---- notification mapping ---------------------------------------------------

/** Trim a progress line to something a log can hold. */
function cap(text: string): string {
  return text.length > PROGRESS_TEXT_CAP ? `${text.slice(0, PROGRESS_TEXT_CAP)}…` : text;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function asMap(v: unknown): Record<string, unknown> {
  return isPlainMap(v) ? v : {};
}

/** The turn-end shape `mapNotification` reports for a `turn/completed` frame. */
export interface TurnOutcome {
  status: string;
  turnId: string | undefined;
  error: string | undefined;
}

/**
 * Read a `turn/completed` frame's outcome. PURE — exported for tests.
 * Returns `undefined` for anything that is not a `turn/completed`.
 */
export function readTurnCompleted(method: string, params: unknown): TurnOutcome | undefined {
  if (method !== 'turn/completed') return undefined;
  const turn = asMap(asMap(params)['turn']);
  const err = asMap(turn['error']);
  const message = str(err['message']);
  const details = str(err['additionalDetails']);
  return {
    status: str(turn['status']) ?? 'completed',
    turnId: str(turn['id']),
    error:
      message === undefined
        ? undefined
        : details === undefined
          ? message
          : `${message} (${details})`,
  };
}

/**
 * Map one server→client notification to an `AgentEvent`.
 *
 * PURE and TOTAL — this is the function the recorded fixture replays through, so
 * it must never throw on a shape it has not seen. `undefined` means "not worth
 * surfacing"; nothing may depend on any particular progress line existing.
 *
 * `thread/started` maps to nothing on purpose: `start` emits `{kind:'started'}`
 * itself from the `thread/start` RESPONSE, so the token is captured even if the
 * notification ordering changes.
 */
export function mapNotification(method: string, params: unknown): AgentEvent | undefined {
  const p = asMap(params);
  switch (method) {
    case 'thread/started':
      return undefined;

    case 'turn/started': {
      const id = str(asMap(p['turn'])['id']) ?? '(unknown)';
      return { kind: 'progress', text: `turn ${id} started` };
    }

    case 'turn/completed': {
      const outcome = readTurnCompleted(method, params);
      if (outcome === undefined) return undefined;
      return { kind: 'progress', text: `turn ${outcome.turnId ?? '(unknown)'} ${outcome.status}` };
    }

    case 'item/agentMessage/delta': {
      const delta = str(p['delta']) ?? str(p['text']);
      return delta === undefined ? undefined : { kind: 'progress', text: cap(delta) };
    }

    case 'item/started':
    case 'item/completed': {
      const item = asMap(p['item']);
      const kind = str(item['type']) ?? str(item['itemType']) ?? 'item';
      const id = str(item['id']) ?? '(unknown)';
      return { kind: 'progress', text: `${method} ${kind} ${id}` };
    }

    case 'item/commandExecution/outputDelta': {
      const chunk = str(p['chunk']) ?? str(p['delta']) ?? str(p['output']);
      return chunk === undefined ? undefined : { kind: 'progress', text: cap(chunk) };
    }

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/plan/delta': {
      const delta = str(p['delta']) ?? str(p['text']);
      return delta === undefined ? undefined : { kind: 'progress', text: cap(delta) };
    }

    case 'turn/plan/updated':
    case 'turn/diff/updated':
      return { kind: 'progress', text: method };

    case 'mcpServer/startupStatus/updated': {
      const name = str(p['name']) ?? '(unnamed)';
      const status = str(p['status']) ?? '(unknown)';
      const err = str(p['error']);
      return {
        kind: 'progress',
        text: cap(`MCP server '${name}' status ${status}${err === undefined ? '' : `: ${err}`}`),
      };
    }

    case 'error': {
      // The top-level error notification carries a `TurnError`.
      const message = str(asMap(p['error'])['message']) ?? 'unspecified error';
      return { kind: 'exited', exitCode: null, error: message };
    }

    default:
      return undefined;
  }
}

/**
 * Read an `mcpServer/startupStatus/updated` frame for the owenwork mount's
 * FAILURE only. PURE — exported for tests.
 *
 * Gates on an explicit `'failed'`, never on the absence of a `'ready'`: absence
 * of a notification is not proof of failure, and gating on ever seeing `'ready'`
 * would deadlock the moment the notification is renamed.
 */
export function readOwenworkMountFailure(method: string, params: unknown): string | undefined {
  if (method !== 'mcpServer/startupStatus/updated') return undefined;
  const p = asMap(params);
  if (str(p['name']) !== OWENWORK_MCP_NAME) return undefined;
  if (str(p['status']) !== 'failed') return undefined;
  const err = str(p['error']) ?? str(p['failureReason']) ?? 'no reason reported';
  return `owenwork MCP server failed to start: ${err}`;
}

// ---- the adapter ------------------------------------------------------------

/** One live session, keyed by thread id. */
interface CodexSession {
  client: StdioRpcClient;
  /**
   * The LIVE turn's gate, stored on the session the moment the thread exists —
   * before `turn/start` is even sent.
   *
   * This is what makes a MID-TURN `stop(ref)` able to interrupt. `turn/interrupt`
   * needs BOTH the thread id and the turn id, `stop(ref)` carries only the thread
   * id, and the turn id is not known until the `turn/started` notification
   * arrives — which is exactly while the turn is running and `stop` is the only
   * thing that can be called. Reading it off the gate (`currentTurnId()`) is
   * therefore mandatory: recording it after the turn settles would mean the id is
   * available only once interrupting it is pointless.
   */
  gate?: TurnGate;
  /** The last SETTLED turn's id, kept so a post-turn `stop` still has something
   *  to name. `gate.currentTurnId()` supersedes it while a turn is live. */
  turnId?: string;
  /** The resolved `thread/start` params, replayed on an in-process resume. */
  startParams?: Record<string, unknown>;
}

/**
 * Module-level, process-wide. `stop` on a token this process did not start is a
 * documented no-op — `HarnessSessionRef` carries no pid, so cross-process
 * teardown is impossible under the current contract (observation 2).
 */
const SESSIONS = new Map<string, CodexSession>();

/** The binary. `OWENWORK_CODEX_BIN` overrides; otherwise `PATH` resolves `codex`. */
function resolveBin(): string {
  return process.env['OWENWORK_CODEX_BIN'] ?? 'codex';
}

/**
 * Everything one turn needs to settle: the promise the caller is waiting on,
 * plus the notification/server-request wiring that settles it.
 */
interface TurnGate {
  /** Resolves at turn end, rejects on a mount failure or a pre-turn death. */
  promise: Promise<void>;
  /** Feed every notification through this; it maps, emits, and may settle. */
  onNotification(method: string, params: unknown): void;
  /** The last `turn/started` id seen. */
  currentTurnId(): string | undefined;
  fail(err: Error): void;
}

/**
 * Wire one turn's settle semantics.
 *
 * TURN END, NOT PROCESS END. `turn/completed` settles the promise:
 *  - `completed`   → emit `turn_ended`, resolve.
 *  - `failed`      → emit `exited` carrying the error FIRST, then `turn_ended`,
 *                    then resolve. The contract says everything except a resume
 *                    failure surfaces as an `exited` event; resolving after it is
 *                    the shape both adapters picked, and they must not diverge.
 *  - `interrupted` → emit `turn_ended`, resolve. `stop()` caused it.
 *  - `inProgress`  → ignore; the turn is not over.
 *
 * If the child dies before any `turn/completed`, the promise REJECTS with that
 * error and no `turn_ended` is synthesized — a dead process did not finish a turn.
 */
function createTurnGate(onEvent: (e: AgentEvent) => void): TurnGate {
  let settle: ((err?: Error) => void) | undefined;
  let turnId: string | undefined;
  let settled = false;

  const promise = new Promise<void>((resolve, reject) => {
    settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err !== undefined) reject(err);
      else resolve();
    };
  });
  // The gate can reject with NOBODY awaiting it. Both setup failure paths do
  // exactly that: `thread/start` or `thread/resume` throws, the handler calls
  // `dispose()`, disposal kills the child, `onExit` fires, and `gate.fail(...)`
  // rejects a promise `runTurn` was never reached to await. Node then raises an
  // unhandledRejection and takes the process down — turning a clean, correctly
  // reported ResumeUnavailableError into a crash. (Caught by the live smoke,
  // not by any unit test; the ordering only happens against a real child.)
  //
  // A no-op handler marks the ORIGINAL promise handled. It does not swallow the
  // rejection for real awaiters: `promise.catch(noop)` returns a new promise,
  // and a later `await promise` in `runTurn` still rejects exactly as before.
  promise.catch(() => {});
  // The executor above runs synchronously, so `settle` is assigned by here.
  const done = settle as (err?: Error) => void;

  return {
    promise,
    currentTurnId: () => turnId,
    fail: (err: Error) => done(err),
    onNotification(method: string, params: unknown): void {
      if (method === 'turn/started') {
        turnId = str(asMap(asMap(params)['turn'])['id']);
      }

      const mounted = readOwenworkMountFailure(method, params);
      const event = mapNotification(method, params);
      if (event !== undefined) onEvent(event);

      if (mounted !== undefined) {
        // A silent dead order otherwise: with no `submit` tool the agent can
        // never complete the order, so burning the turn's tokens is pointless.
        onEvent({ kind: 'exited', exitCode: null, error: mounted });
        done(new Error(mounted));
        return;
      }

      const outcome = readTurnCompleted(method, params);
      if (outcome === undefined) return;
      if (outcome.status === 'inProgress') return;
      if (outcome.status === 'failed') {
        onEvent({ kind: 'exited', exitCode: null, error: outcome.error ?? 'turn failed' });
      }
      onEvent({ kind: 'turn_ended' });
      done();
    },
  };
}

/**
 * Answer every server→client request. An unanswered one hangs the turn past the
 * runner's lease, which is the single worst outcome available in this file.
 *
 * Exactly ONE thing is auto-approved — a tool call on owenwork's own MCP mount,
 * see the `mcpServer/elicitation/request` case. Everything else is refused:
 * under `approvalPolicy:'never'` a command/file approval request should not
 * arrive at all; if one does, throwing (which the client turns into a JSON-RPC
 * error reply) is a loud, non-hanging failure, whereas inventing an approval the
 * policy said would never be asked for is a security decision this adapter is
 * not authorized to make.
 *
 * `item/tool/requestUserInput` and every non-owenwork elicitation emit
 * `needs_input` and then throw: the Phase 1 contract deliberately has no reply
 * channel, so replying `{answers:{}}` would be fabricating a user's answer. The
 * error reply surfaces to the model as a failed tool call — the least-wrong
 * behavior available (contract observation 3).
 */
function handleServerRequest(onEvent: (e: AgentEvent) => void) {
  return async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case 'item/tool/requestUserInput': {
        const questions = asMap(params)['questions'];
        const asked = Array.isArray(questions)
          ? questions.map((q) => str(asMap(q)['question']) ?? str(asMap(q)['header']) ?? '').filter((q) => q !== '')
          : [];
        const question = asked.length > 0 ? asked.join(' / ') : 'the harness asked for user input';
        onEvent({ kind: 'needs_input', question: cap(question) });
        throw new Error('owenwork hosts this session headlessly and cannot answer user input');
      }

      case 'mcpServer/elicitation/request': {
        const p = asMap(params);

        // MEASURED: `approvalPolicy:'never'` does NOT cover MCP tool calls in
        // 0.146.0. Every single call to an MCP tool arrives here first as an
        // elicitation carrying `_meta.codex_approval_kind:'mcp_tool_call'`, and
        // an error reply is recorded as `user rejected MCP tool call`. Refusing
        // therefore does not fail safe — it makes `submit` impossible, so the
        // agent can never green its artifact and every codex order dies owing.
        //
        // This grants exactly one thing: a call to a tool on owenwork's OWN
        // mount. That mount is not third-party code — this adapter wrote it into
        // `thread/start` itself, and `buildThreadStartParams` lets the owenwork
        // entry win any key clash, so `serverName === 'owenwork'` cannot be some
        // other server wearing the name. Any other server, and any elicitation
        // that is not a tool-call approval, still gets `needs_input` + a throw.
        if (
          str(p['serverName']) === OWENWORK_MCP_NAME &&
          str(asMap(p['_meta'])['codex_approval_kind']) === 'mcp_tool_call'
        ) {
          return { action: 'accept', content: {} };
        }

        const message = str(p['message']) ?? 'an MCP server asked for user input';
        onEvent({ kind: 'needs_input', question: cap(message) });
        throw new Error('owenwork hosts this session headlessly and cannot answer an elicitation');
      }

      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'applyPatchApproval':
      case 'execCommandApproval': {
        onEvent({
          kind: 'progress',
          text: `refusing '${method}': owenwork runs with approvalPolicy 'never' and does not grant approvals`,
        });
        throw new Error(`'${method}' is not answerable by a headless host`);
      }

      default: {
        onEvent({ kind: 'progress', text: `refusing unsupported server request '${method}'` });
        throw new Error(`'${method}' is not supported by this host`);
      }
    }
  };
}

/** A spawned, handshaken app-server plus the one-shot `exited` reporter for it. */
interface OpenedClient {
  client: StdioRpcClient;
  /**
   * Emit `{kind:'exited'}` for THIS child at most once, whoever notices first.
   *
   * Two observers race to report the same death: the failure handler that
   * decided to tear the child down, and `onExit` firing because the teardown
   * killed it. Both must call this — the handler because a child that never
   * spawned (a bad `OWENWORK_CODEX_BIN`) emits `error` and `close` but never
   * `exit`, so `onExit` alone would report nothing; `onExit` because a child that
   * dies on its own is nobody else's news. The latch is what keeps the pair from
   * emitting two `exited` events for one death, and first-caller-wins is
   * deliberate: the handler's message names the actual failure, while `onExit`'s
   * only names the signal that teardown itself sent.
   */
  reportExit(exitCode: number | null, error: string | undefined): void;
}

/** Spawn one app-server, complete the handshake, and return the wired client. */
async function openClient(
  cwd: string,
  onEvent: (e: AgentEvent) => void,
  gate: TurnGate,
): Promise<OpenedClient> {
  let exitReported = false;
  const reportExit = (exitCode: number | null, error: string | undefined): void => {
    if (exitReported) return;
    exitReported = true;
    onEvent({ kind: 'exited', exitCode, ...(error !== undefined ? { error } : {}) });
  };

  const client = startStdioRpc({
    command: resolveBin(),
    args: [...APP_SERVER_ARGS],
    cwd,
    // PHASE 6 ITEM 5 — the `OWENWORK_*` namespace filter, and ONLY that.
    //
    // This is NOT the other adapter's vendor API-key strip, and it must not
    // drift into one: `ANTHROPIC_*` and `OPENAI_*` continue to reach this
    // app-server untouched, which is the recorded decision in
    // `docs/agent-runner.md`. What changes is that owenwork's own variables with
    // no consumer inside this process tree — the hub bearer override above all —
    // stop arriving, because this server persists `thread/start` params under
    // `~/.codex/sessions/` and an inherited secret therefore reaches disk.
    //
    // The value is a FULL environment (`process.env` minus the denied names),
    // because supplying `env` to the transport replaces the child's environment
    // rather than merging into it.
    env: filterOwenworkEnv(process.env),
    // Every unknown notification lands here and is ignored by `mapNotification`
    // — unsolicited traffic arrives before any request completes, and throwing
    // on one would kill a healthy session.
    onNotification: (method, params) => gate.onNotification(method, params),
    onServerRequest: handleServerRequest(onEvent),
    onStderr: (line) => onEvent({ kind: 'progress', text: cap(line) }),
    onExit: (code, signal) => {
      reportExit(code, signal === null ? undefined : `killed by ${signal}`);
      // Resolve-on-turn-end means a death BEFORE `turn/completed` is a failure,
      // not a finished turn. If the turn already ended this is a no-op.
      gate.fail(new Error(`app-server exited (code=${String(code)}, signal=${String(signal)})`));
    },
  });

  try {
    const init = await client.request<Record<string, unknown>>(
      'initialize',
      { clientInfo: CLIENT_INFO },
      SETUP_TIMEOUT_MS,
    );
    client.notify('initialized', {});
    // The only place the running binary's own version is observable, and the
    // intended input to a `harness-versions.json` mismatch WARNING that is still
    // NOT BUILT as of Phase 6 — see the "known gap" entry in
    // `docs/agent-runner.md`. This line only surfaces the value; nothing reads
    // it back. `test/harness-contract-fixtures.test.ts` pins the line's shape so
    // a future consumer has something stable to parse.
    onEvent({
      kind: 'progress',
      text: `app-server ready: userAgent=${str(init['userAgent']) ?? '(unknown)'}`,
    });
    return { client, reportExit };
  } catch (err) {
    // THE HANDSHAKE IS INSIDE THE TRY FOR A REASON. It is spawn-adjacent, so it
    // is tempting to treat it as part of "starting up" and leave the failure to
    // the caller — but the child is ALREADY SPAWNED and, being `detached`, it is
    // the leader of its own process group. A wedged binary, a wrong
    // `OWENWORK_CODEX_BIN`, or an `initialize` that times out would otherwise
    // leave that group running with nobody holding a handle to it, and the caller
    // would see a rejection with no `exited` event to explain it.
    reportExit(null, describe(err));
    await client.dispose();
    throw err;
  }
}

/** The message text for an `exited` event or a progress line. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A timer that cannot by itself hold the event loop — or a test runner — open. */
function sleepUnref(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

/**
 * Tear one session's child down: interrupt the live turn if there is one, wait
 * briefly for the interruption to land, then dispose.
 *
 * Shared by `stop` and by the failure path of a turn that never ended, because
 * both need the same thing and the failure path is the easier one to get wrong:
 * a turn whose gate rejected (an owenwork mount failure is the case that
 * matters) is still RUNNING on the server, and leaving it alone burns tokens on
 * an answer nobody will ever read.
 *
 * Never throws. Every step is best-effort: an already-finished turn, a dead
 * child, and a timeout all mean the same thing at teardown — the child is going
 * away — and none of them is a failure of `stop`.
 */
async function teardownSession(token: string, session: CodexSession): Promise<void> {
  const turnId = session.gate?.currentTurnId() ?? session.turnId;
  if (turnId !== undefined) {
    try {
      await session.client.request(
        'turn/interrupt',
        { threadId: token, turnId },
        INTERRUPT_TIMEOUT_MS,
      );
      // The interrupt was accepted; give the server its beat to emit
      // `turn/completed{status:'interrupted'}` so a caller parked on the gate
      // sees an interrupted turn rather than the child's death.
      const gate = session.gate;
      if (gate !== undefined) {
        await Promise.race([gate.promise.then(noop, noop), sleepUnref(INTERRUPT_SETTLE_MS)]);
      }
    } catch {
      // Best effort — see the doc comment.
    }
  }

  try {
    await session.client.dispose();
  } catch {
    // Disposal of an already-exited child is exactly the case the contract
    // calls not-an-error.
  }
}

function noop(): void {
  /* a settled gate is information, not an outcome, at teardown */
}

/**
 * A turn that rejected did NOT end — drop the session and tear the child down.
 *
 * The case this exists for is the owenwork mount failure: the gate rejects the
 * instant `mcpServer/startupStatus/updated` reports `failed`, but the SERVER is
 * still happily running the turn, and an agent with no `submit` tool can only
 * spend tokens on an order it cannot possibly complete. A child death or a
 * `turn/start` ACK timeout land here too, and the same answer fits: nothing more
 * will come of this turn, so nothing should still be running for it.
 *
 * The resume token stays valid — the rollout on disk outlives the child, so a
 * later `deliver` can still resume the thread with a fresh app-server.
 */
async function abandonTurn(token: string, session: CodexSession): Promise<void> {
  if (SESSIONS.get(token) === session) SESSIONS.delete(token);
  await teardownSession(token, session);
}

async function runTurn(
  client: StdioRpcClient,
  gate: TurnGate,
  params: Record<string, unknown>,
): Promise<void> {
  // The RESPONSE acknowledges the turn's creation; it is NOT turn end. Awaiting
  // both means a server that answers late still cannot make us miss the
  // `turn/completed` that already settled the gate.
  await Promise.all([client.request('turn/start', params, TURN_START_TIMEOUT_MS), gate.promise]);
}

export const codexAdapter: HarnessAdapter = {
  id: HARNESS_ID,
  resumeTier: 'native-token',

  /**
   * The command a human runs to re-open this thread in an interactive terminal.
   *
   * It goes through `resolveBin`, the SAME resolution the app-server spawn uses,
   * so an operator who set `OWENWORK_CODEX_BIN` is handed a command that runs on
   * their machine rather than a bare name their shell cannot find. The token in
   * `HarnessSessionRef` is the thread id, which is exactly what the CLI's
   * `resume` subcommand takes.
   */
  resumeCommand(ref: HarnessSessionRef): { command: string; args: string[] } {
    return { command: resolveBin(), args: ['resume', ref.token] };
  },

  async start(args: StartArgs, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef> {
    const gate = createTurnGate(onEvent);
    const startParams = buildThreadStartParams(args, onEvent);
    // Handshake failure disposes the child inside `openClient` — see the catch
    // there. Nothing is spawned and unowned by the time this rejects.
    const { client, reportExit } = await openClient(args.cwd, onEvent, gate);

    let threadId: string;
    try {
      const res = await client.request<Record<string, unknown>>(
        'thread/start',
        startParams,
        SETUP_TIMEOUT_MS,
      );
      const id = str(asMap(res['thread'])['id']);
      if (id === undefined) throw new Error('thread/start returned no thread id');
      threadId = id;
    } catch (err) {
      // No token exists yet, so there is nothing to hand back and nothing to
      // invent. Report, tear down, reject.
      reportExit(null, describe(err));
      await client.dispose();
      throw err;
    }

    const ref: HarnessSessionRef = { harness: HARNESS_ID, token: threadId };
    // The gate goes on the session BEFORE the turn is started, so a `stop` that
    // lands mid-turn can read the live turn id off it and interrupt.
    const session: CodexSession = { client, startParams, gate };
    SESSIONS.set(threadId, session);
    // BEFORE the turn runs and before resolving: the caller persists the token
    // on this event, so a mid-turn crash still leaves a resumable record.
    onEvent({ kind: 'started', ref });

    try {
      await runTurn(
        client,
        gate,
        buildTurnStartParams(threadId, args.brief, args.effort ?? args.permissions.effort),
      );
    } catch (err) {
      await abandonTurn(threadId, session);
      throw err;
    } finally {
      session.turnId = gate.currentTurnId();
      delete session.gate;
    }
    return ref;
  },

  async deliver(
    ref: HarnessSessionRef,
    message: string,
    args: DeliverArgs,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> {
    // A rollout records its cwd; a vanished worktree cannot host the resumed
    // turn, and finding that out from the server takes a spawn plus a handshake.
    if (!existsSync(args.cwd)) {
      throw new ResumeUnavailableError(`resume cwd no longer exists: ${args.cwd}`);
    }

    const gate = createTurnGate(onEvent);
    const previous = SESSIONS.get(ref.token);
    // PHASE 4: the map is no longer the source of truth for thread configuration.
    // `args.permissions` is, and `buildThreadResumeParams` maps it. `startParams`
    // survives only as a filler for keys a `DeliverArgs` cannot express, and a
    // miss is now an ordinary cross-process resume rather than a degraded one —
    // which is why the "minimal thread configuration" warning is gone.
    const startParams = previous?.startParams;
    if (previous !== undefined) {
      // ALWAYS a fresh app-server, even when this process still holds a live one.
      // A live client's notifications are bound to the gate it was opened with,
      // and the client exposes no rewire; reusing it would route this turn's
      // `turn/completed` to the PREVIOUS turn's already-settled gate and hang
      // this one forever. Resume is cheap; a hung order is not.
      SESSIONS.delete(ref.token);
      await previous.client.dispose();
    }

    const { client, reportExit } = await openClient(args.cwd, onEvent, gate);

    const resumeParams = buildThreadResumeParams(ref.token, args, startParams, onEvent);
    try {
      await client.request('thread/resume', resumeParams, SETUP_TIMEOUT_MS);
    } catch (err) {
      if (isResumeMiss(err)) {
        // The ONLY failure that rejects with ResumeUnavailableError. The caller
        // owns the cold-replay fallback; this adapter only reports. The `exited`
        // event for the disposed child comes from `onExit`, unchanged — a
        // forgotten thread is reported by the rejection, not by a second
        // synthesized failure message.
        await client.dispose();
        throw new ResumeUnavailableError(
          `provider no longer knows thread ${ref.token}: ${describe(err)}`,
        );
      }
      reportExit(null, describe(err));
      await client.dispose();
      throw err;
    }

    const session: CodexSession = {
      client,
      gate,
      ...(startParams !== undefined ? { startParams } : {}),
    };
    SESSIONS.set(ref.token, session);

    try {
      // NEVER re-emits `started` — the contract forbids it on a resume.
      await runTurn(
        client,
        gate,
        // Phase 4: effort is a `turn/start` param, so a resumed turn has to
        // re-supply it exactly as `start` does — same precedence rule.
        buildTurnStartParams(ref.token, message, args.effort ?? args.permissions.effort),
      );
    } catch (err) {
      await abandonTurn(ref.token, session);
      throw err;
    } finally {
      session.turnId = gate.currentTurnId();
      delete session.gate;
    }
  },

  async stop(ref: HarnessSessionRef): Promise<void> {
    const session = SESSIONS.get(ref.token);
    // A miss is NOT an error: the contract requires idempotence, an already-dead
    // session is fine, and a session started by another process is simply not
    // reachable from here.
    if (session === undefined) return;
    SESSIONS.delete(ref.token);
    await teardownSession(ref.token, session);
  },
};

// Adapters self-register at IMPORT time; whoever imports this module is what
// puts it in the runtime registry. Phase 3's runner owns that import — this
// phase only makes the import sufficient.
register(codexAdapter);
