/**
 * The Claude Code harness adapter — `HarnessAdapter` (`./contract.ts`)
 * implemented on top of `@anthropic-ai/claude-agent-sdk`.
 *
 * WHY THIS FILE IS ALLOWED TO NAME A VENDOR. `test/harness-isolation.test.ts`
 * greps `/claude|codex|anthropic|openai/i` over the full text — comments
 * included — of every `.ts` under `src/harness/`, and allowlists exactly two
 * paths: `claude.ts` and `codex.ts`. That is why this whole adapter lives in one
 * file. Do NOT split it into `src/harness/claude/*.ts` or a `claude-options.ts`
 * helper: those paths are not allowlisted and the isolation test fails on them.
 *
 * SHAPE. Every decision lives in the two exported pure-ish functions
 * (`buildChildEnv`, `buildClaudeOptions`); `start`/`deliver`/`stop` are thin I/O
 * shells over them. That split is what lets `test/harness-claude.test.ts` prove
 * the option mapping and the environment hygiene with no SDK process, no
 * network, and no login.
 *
 * NO PRINTING. There is zero `console.*` under `src/`. Diagnostics leave this
 * module as `{kind:'progress', text}` `AgentEvent`s through the caller's
 * `onEvent`, never as a print.
 *
 * NOTHING IMPORTS THIS YET. Phase 3's worker (the composition root) is the first
 * production importer; importing this module is what fires the module-scope
 * `register(claudeAdapter)` below and puts the adapter in the runtime registry.
 */
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources';

import {
  classifyExactWorkdirPath,
  classifyToolCall,
  EXACT_WORKDIR_DENIAL_MESSAGE,
  PATH_BEARING_TOOL_NAMES,
  READ_ONLY_TOOLS,
  type GatePolicy,
  type GateVerdict,
} from './gatekeeper.ts';
import { register } from './registry.ts';
import { filterOwenloopEnv } from './child-env.ts';
import { normalizeStepPermissions, validateHarnessOptions } from './permissions.ts';
import {
  HarnessIdleTimeoutError,
  HarnessTurnError,
  ResumeUnavailableError,
  NEUTRAL_PERMISSION_MODES,
	isHarnessTurnError,
  isNeutralPermissionMode,
} from './contract.ts';
import type { ApprovalRequester } from './contract.ts';
import type { LintFinding } from './types.ts';
import type {
  AgentEvent,
  DeliverArgs,
  HarnessAdapter,
  HarnessRecoveryPolicy,
  HarnessSessionRef,
  NeutralPermissionModeMap,
  PermissionIssue,
  StartArgs,
  StepPermissions,
} from './contract.ts';

/** The registry key — the id a step def names in `x.harness.id`, and the key
 *  `harness-versions.json` pins the CLI under. */
const HARNESS_ID = 'claude-code';

// ---------------------------------------------------------------------------
// Environment hygiene
// ---------------------------------------------------------------------------

/**
 * The variables deleted from the child environment unless API billing is
 * explicitly allowed.
 *
 * `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`: an inherited key SILENTLY
 * shadows the operator's subscription OAuth and bills API credits instead. That
 * shadowing is the entire reason this strip exists — it is a correctness
 * requirement, not hardening.
 *
 * `CLAUDECODE`: set by an already-running Claude Code process to mark "you are
 * inside me". Inheriting it confuses a nested launch, so it goes under the same
 * toggle — one flag, one list, no second knob.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` IS DELIBERATELY NOT IN THIS LIST AND MUST NEVER BE
 * ADDED TO IT: it is the subscription credential, and the launchd path needs it
 * to survive. `test/harness-claude.test.ts` asserts that explicitly so a future
 * "tidy up the strip list" edit fails loudly instead of silently breaking
 * headless auth. Phase 6 measured it end to end under a real launchd job —
 * `test/tools/launchd-env-probe.sh`, which observes the variable arriving in the
 * job AND surviving `buildChildEnv`, while `OWENLOOP_TOKEN` set in the same
 * plist does not survive.
 */
const STRIPPED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE'] as const;

/** The machine-level opt-out. Read from the environment INSIDE this module on
 *  purpose: the contract deliberately refused an `allowApiBilling` field on
 *  `StartArgs` (it is machine config, not per-start data) and `src/settings.ts`
 *  is shared surface another phase may be editing. */
const ALLOW_API_BILLING_VAR = 'OWENLOOP_ALLOW_API_BILLING';

/** Operator override for the CLI binary; see `resolveExecutable`. */
const BIN_OVERRIDE_VAR = 'OWENLOOP_CLAUDE_BIN';
/** Host-only opt-in liveness controller. Never admitted to the child env. */
export const CLAUDE_IDLE_TIMEOUT_VAR = 'OWENLOOP_CLAUDE_IDLE_TIMEOUT_MS';
/** Host-only opt-in for the exact snapshot-root Claude audit profile. */
export const CLAUDE_EXACT_WORKDIR_VAR = 'OWENLOOP_CLAUDE_EXACT_WORKDIR';
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 3_600_000;

/** Parse the one adapter-owned recovery setting without silently opting out. */
export function parseClaudeIdleTimeout(value: string | undefined): HarnessRecoveryPolicy | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new HarnessTurnError(
      'configuration',
      true,
      `${CLAUDE_IDLE_TIMEOUT_VAR} must be a canonical decimal integer between ${MIN_IDLE_TIMEOUT_MS} and ${MAX_IDLE_TIMEOUT_MS}`,
    );
  }
  const idleTimeoutMs = Number(value);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < MIN_IDLE_TIMEOUT_MS || idleTimeoutMs > MAX_IDLE_TIMEOUT_MS) {
    throw new HarnessTurnError(
      'configuration',
      true,
      `${CLAUDE_IDLE_TIMEOUT_VAR} must be a canonical decimal integer between ${MIN_IDLE_TIMEOUT_MS} and ${MAX_IDLE_TIMEOUT_MS}`,
    );
  }
  return { idleTimeoutMs };
}

export function claudeRecoveryPolicy(env: Record<string, string | undefined> = process.env): HarnessRecoveryPolicy | undefined {
  return parseClaudeIdleTimeout(env[CLAUDE_IDLE_TIMEOUT_VAR]);
}

/** Parse the strict profile as a boolean rather than passing its host spelling onward. */
export function parseClaudeExactWorkdir(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '1') return true;
  throw new HarnessTurnError(
    'configuration',
    true,
    `${CLAUDE_EXACT_WORKDIR_VAR} must be exactly 1 when present`,
  );
}

export function claudeExactWorkdir(env: Record<string, string | undefined> = process.env): boolean {
  return parseClaudeExactWorkdir(env[CLAUDE_EXACT_WORKDIR_VAR]);
}

/**
 * Build the environment the harness child runs under.
 *
 * WHY IT SPREADS RATHER THAN LISTS. The SDK's `Options.env` REPLACES the
 * subprocess environment entirely — it is NOT merged with `process.env` (see
 * that field's own JSDoc in the installed `sdk.d.ts`). Both halves of that bite:
 *
 *  - passing only the deltas would blow away `PATH`/`HOME` and break the child;
 *  - omitting `env` altogether would let an ambient API key through, which is
 *    exactly the bug this function exists to prevent.
 *
 * So the caller ALWAYS sets `env`, and this function always returns a full
 * environment: spread the source, then delete.
 *
 * `source` is a parameter rather than a read of `process.env` so the unit test
 * injects a fixture and never mutates the real environment. The input is not
 * mutated.
 *
 * `delete` is used rather than assigning `undefined`: an own key holding
 * `undefined` is not obviously equivalent to an absent key across the SDK's
 * serialization boundary, and deleting removes the question.
 *
 * TWO INDEPENDENT FILTERS RUN HERE, and conflating them would break one of
 * them:
 *
 *  1. `STRIPPED_ENV_KEYS` — the vendor API-key strip. It is specific to THIS
 *     adapter, it is a correctness requirement (an inherited key shadows the
 *     subscription and bills credits), and it is under the `allowApiBilling`
 *     opt-out.
 *  2. `filterOwenloopEnv` — Phase 6's `OWENLOOP_*` namespace allowlist, shared
 *     with the other adapter and NOT under any opt-out. It removes owenloop's
 *     own variables that no harness child has a consumer for — the hub bearer
 *     override above all — and touches nothing outside that namespace. In
 *     particular it cannot reach `CLAUDE_CODE_OAUTH_TOKEN`, which is not an
 *     `OWENLOOP_*` name and therefore survives by construction, which is what
 *     Phase 6 item 3 needs under launchd.
 *
 * Everything else survives: `PATH`, `HOME`, `TMPDIR`, proxy and TLS variables,
 * and the three admitted `OWENLOOP_*` names the mounted work-holder MCP child
 * actually reads.
 */
export function buildChildEnv(
  source: Record<string, string | undefined>,
  opts: { allowApiBilling: boolean },
): Record<string, string | undefined> {
  const result = filterOwenloopEnv(source);
  if (!opts.allowApiBilling) {
    for (const key of STRIPPED_ENV_KEYS) delete result[key];
  }
  return result;
}

/** Whether API billing is allowed, from a machine-level environment toggle.
 *  Default is OFF — the strip happens unless the operator opted in. */
export function allowApiBillingFrom(source: Record<string, string | undefined>): boolean {
  return source[ALLOW_API_BILLING_VAR] === '1';
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the CLI executable: `OWENLOOP_CLAUDE_BIN` → a `claude` on `PATH` →
 * `undefined`.
 *
 * `undefined` means the caller OMITS `pathToClaudeCodeExecutable` entirely and
 * lets the SDK use its own bundled executable. That third case is a decision,
 * not an oversight: the bundled executable is the same CLI reading the same
 * credential store, so subscription auth still works, whereas throwing would
 * make the adapter unusable on a machine where the CLI sits somewhere unusual.
 *
 * The `PATH` walk is done in-process (`accessSync` with `X_OK`) rather than by
 * shelling out: no shell, no extra child, and it is unit-testable against a
 * fixture `PATH` the test builds and `chmod`s itself.
 *
 * `source` is the CHILD environment (a spread of `process.env`), so the override
 * and the `PATH` searched are the same ones the child will see.
 */
export function resolveExecutable(source: Record<string, string | undefined>): string | undefined {
  const override = source[BIN_OVERRIDE_VAR];
  if (override !== undefined && override !== '') return override;

  const path = source['PATH'];
  if (path === undefined || path === '') return undefined;
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here (or not executable) — keep walking
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Option mapping
// ---------------------------------------------------------------------------

/**
 * The six-value closed union the SDK types `Options.permissionMode` as.
 * `StepPermissions.permissionMode` arrives as an UNVALIDATED non-empty string
 * (normalization passes it through by design and leaves validation to
 * `owenloop work lint`), so narrowing is mandatory, not defensive style.
 */
const PERMISSION_MODES: readonly string[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

/**
 * This adapter's neutral-vocabulary translation. Every value maps: this harness
 * draws all three distinctions itself, so none of them is refused here.
 *
 * - `ask` → `default`. The SDK's `default` routes each unapproved tool to the
 *   `canUseTool` callback — a human decision point — and denies when no callback
 *   is wired. That is the "human is the gate" position.
 * - `auto-safe` → `default`, with this adapter's own gatekeeper in the
 *   `canUseTool` callback. NOT the SDK's `auto`, and that is the substance of
 *   this mapping rather than a detail of it.
 *
 *   MEASURED against SDK 0.3.220, `canUseTool` wired throughout: `auto`'s
 *   model-side classifier consulted the host on NONE of five probe commands and
 *   emitted no `permission_denied` system message for any of them. Four ran,
 *   including `rm -rf` on an ABSOLUTE path outside the session cwd (verified by
 *   the target directory being gone afterwards), a `curl` to the public
 *   internet, and a read of a file under `$HOME` outside cwd.
 *
 *   So `auto` never reaches the callback and cannot escalate to anyone. The
 *   position `auto-safe` names — a classifier gates, a human is the exception
 *   path — is therefore not something `auto` can be configured into; it has to
 *   be built on the one mode that does route to the callback. `default` is that
 *   mode (measured on the same SDK build, including calls originating inside a
 *   subagent, which arrive carrying that subagent's `agentID`), so `auto-safe`
 *   and `ask` now share it and differ by the `GatePolicy` handed to the
 *   gatekeeper. The trade is deliberate: `auto` classifies with a model and this
 *   adapter classifies with path containment plus a short deny-list, which is
 *   the blunter instrument — but it is the only one of the two that can put a
 *   person in the loop, which is the whole of what the position promises.
 *
 *   NOT `acceptEdits`, which auto-approves filesystem operations by category and
 *   applies no judgment to anything else, and NOT `dontAsk`, which DENIES an
 *   unapproved tool rather than consulting anyone — silently narrower than what
 *   the step asked for.
 * - `full-access` → `bypassPermissions`. The only SDK mode that runs tools with
 *   no prompt at all, and the one the companion flag below exists for.
 *
 * `plan` has no neutral spelling on purpose: it is a different axis (what the
 * agent may DO — explore only) rather than who approves.
 */
const NEUTRAL_TO_SDK_MODE: NeutralPermissionModeMap = Object.freeze({
  'ask': 'default',
  'auto-safe': 'default',
  'full-access': 'bypassPermissions',
});

/** Values `preflight` accepts: the SDK's own union plus the neutral vocabulary. */
const ACCEPTED_PERMISSION_MODES: readonly string[] = [
  ...PERMISSION_MODES,
  ...NEUTRAL_PERMISSION_MODES,
];

/**
 * Authored `permissionMode` → the SDK mode to send.
 *
 * Total by construction: an out-of-union value returns `undefined` and the
 * caller drops it with a diagnostic, preserving the pre-existing behavior for a
 * bag that lint never saw. A neutral value this adapter refuses (a `null` in the
 * table) also returns `undefined`, and `preflight` has already refused it.
 */
function toSdkPermissionMode(mode: string): PermissionMode | undefined {
  if (isNeutralPermissionMode(mode)) {
    const mapped = NEUTRAL_TO_SDK_MODE[mode];
    return mapped === null ? undefined : (mapped as PermissionMode);
  }
  return PERMISSION_MODES.includes(mode) ? (mode as PermissionMode) : undefined;
}

/**
 * How hard the gatekeeper gates, from the mode the step ACTUALLY AUTHORED.
 *
 * Derived from the authored string rather than from the translated SDK mode
 * because the translation is deliberately lossy in exactly the place that
 * matters: `ask` and `auto-safe` both become `default`, and the whole difference
 * between them now lives here.
 *
 * WHY AN UNSET MODE CLASSIFIES RATHER THAN DENYING. A step that names no
 * `permissionMode` gets the SDK's own `default`, which routes to the callback.
 * Before a callback existed that meant the SDK denied every unapproved call —
 * silently, finally, with nobody prompted and nothing recorded. Treating the
 * unset case as `classifier` is not a widening of what those steps were promised;
 * it is the first time they get anything at all. The same reasoning covers a
 * step that named the vendor's `default` or `acceptEdits`.
 *
 * `dontAsk` is the one value that keeps its narrow meaning: it is documented as
 * "deny if not pre-approved", so it maps to the policy that denies rather than
 * being folded into the classifier. The SDK short-circuits that mode before the
 * callback, so this is a statement of intent more than a live path — but a
 * future SDK that does route it must not find it silently widened here.
 */
export function gatePolicyFor(authoredMode: string | undefined): GatePolicy {
  if (authoredMode === 'ask') return 'human-gate';
  if (authoredMode === 'dontAsk') return 'deny-unapproved';
  return 'classifier';
}

/**
 * What an escalated call tells the agent.
 *
 * This is the whole of the "human exception path" today, and it is a ROUTE
 * rather than an answer: no person is watching a headless run at the moment the
 * call is made, so the honest thing is to refuse the call and name the channel
 * that does reach one. `ask` is that channel — it freezes the owed artifact,
 * closes the run cheaply instead of burning attempts against a wall, and puts a
 * question on the operator's attention feed with an answer path back into the
 * next attempt.
 *
 * The message names the specific reason and tells the agent both of its real
 * options, because the wrong outcome here is an agent that reads a denial as
 * "try a different phrasing" and grinds through its attempt budget. Most
 * escalations have an ordinary alternative — the same work done inside the
 * step's own directory — and the message says so before it points at `ask`.
 */
function escalationMessage(reason: string): string {
  return [
    `Denied: ${reason}.`,
    'Nobody is watching this run to approve it, so this call cannot be granted here and rephrasing it will not change that.',
    'If the work has an equivalent inside your own working directory, do that instead.',
    'If it does not — if you genuinely cannot finish what you owe without this — call the `ask` tool on the mounted `owenloop` MCP server and state what you need and why. That reaches a person, and their answer comes back to you on your next attempt. Do not guess, and do not submit work that pretends this succeeded.',
  ].join(' ');
}

/**
 * What a call refused BY A PERSON, or by a wait that ran out, tells the agent.
 *
 * Kept distinct from `escalationMessage` because the two say different true
 * things. That one says nobody was asked; this one says somebody was, and the
 * answer was no. Telling an agent "nobody is watching" right after a person
 * declined would be a lie that invites it to keep trying, so the routing advice
 * is the same but the first sentence is not.
 */
function decisionMessage(reason: string, note: string | undefined): string {
  return [
    `Denied: ${reason}.`,
    ...(note !== undefined && note !== '' ? [`They said: ${note}`] : []),
    'This was a decision, not a missing approver — repeating the call will reach the same answer.',
    'If the work has an equivalent inside your own working directory, do that instead. If it does not, call the `ask` tool on the mounted `owenloop` MCP server and state what you need and why. Do not guess, and do not submit work that pretends this succeeded.',
  ].join(' ');
}

/** The only model-authored arguments safe to summarize for an approval prompt. */
const APPROVAL_FILE_PATH_ARGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['Read', ['file_path']],
  ['Write', ['file_path']],
  ['Edit', ['file_path']],
  ['NotebookRead', ['notebook_path']],
  ['NotebookEdit', ['notebook_path']],
  ['Glob', ['path']],
  ['Grep', ['path']],
]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A hostile model-authored input must not turn an approval into a hung callback. */
function inputString(input: Record<string, unknown>, key: string): string | undefined {
  try {
    return nonEmptyString(input[key]);
  } catch {
    return undefined;
  }
}

/**
 * Return the bounded one-line call detail an operator needs to approve Claude
 * tool use, without serializing the arbitrary model-authored input bag.
 */
function approvalTitle(toolName: string, input: Record<string, unknown>, suppliedTitle: unknown): string | undefined {
  let title = nonEmptyString(suppliedTitle);
  if (title === undefined && toolName === 'Bash') title = inputString(input, 'command');

  if (title === undefined) {
    const paths = (APPROVAL_FILE_PATH_ARGS.get(toolName) ?? [])
      .map((key) => inputString(input, key))
      .filter((path): path is string => path !== undefined);
    if (paths.length > 0) title = `${toolName} ${paths.join(', ')}`;
  }

  const selected = title ?? nonEmptyString(toolName);
  return selected === undefined ? undefined : cap(selected);
}

/**
 * The `canUseTool` callback, wired on every start.
 *
 * WIRED UNCONDITIONALLY, including under `bypassPermissions`, where the SDK
 * never consults it. A callback that is present but unreached costs nothing; a
 * callback wired only under the modes we predict will reach it is one SDK change
 * away from restoring the silent deny-everything behavior this exists to end.
 *
 * FAIL-CLOSED, deliberately. A throw inside this callback would leave the SDK
 * with no `control_response` and the tool blocked forever — permission prompts
 * have no park deadline. So the classification is wrapped: anything unexpected
 * becomes a denial with the same routing message rather than a hang. The same
 * rule governs the approval channel below: it is awaited inside a `try`, and a
 * requester that throws denies rather than hangs.
 *
 * THE APPROVAL CHANNEL, when `approvals` is supplied. An escalated call is put
 * to a PERSON and this callback waits for their answer, which is only safe
 * because the same absence of a park deadline that makes a throw fatal makes a
 * long wait harmless — and because the worker's lease heartbeat runs on its own
 * timer, so a blocked callback does not let the claim be reaped. `options.
 * toolUseID` is what makes the wait resumable and the question single: it is the
 * harness's own id for this exact call, so a re-sent request is the same
 * question rather than a second one.
 *
 * WITHOUT a requester — and for every outcome that is not an explicit approval —
 * the behavior is exactly what it was before: deny, and name `ask` as the
 * channel that does reach someone.
 */
function buildCanUseTool(
  cwd: string,
  policy: GatePolicy,
  filesystem: StepPermissions['filesystem'],
  onEvent: (e: AgentEvent) => void,
  approvals?: ApprovalRequester,
  exactWorkdir = false,
): CanUseTool {
  return async (toolName, input, options) => {
    let verdict: GateVerdict;
    try {
      verdict = classifyToolCall(
	{
	  toolName,
	  input,
	  workdir: cwd,
	  blockedPath: options.blockedPath,
	  filesystem,
	  exactWorkdir,
	},
        policy,
      );
    } catch (err) {
      verdict = { decision: 'escalate', reason: `the gatekeeper could not judge this call (${errText(err)})` };
    }
    if (verdict.decision === 'allow') return { behavior: 'allow' };

    // This is a host boundary, not a legacy escalation. It never enters the
    // approval channel and its fixed message cannot serialize a model path.
    if (verdict.decision === 'deny') {
      onEvent({ kind: 'progress', text: `exact work-root policy: ${toolName} denied` });
      return { behavior: 'deny', message: verdict.reason };
    }

    if (approvals !== undefined) {
      const title = approvalTitle(toolName, input, options.title);
      onEvent({
        kind: 'progress',
        text: `permission escalation: ${toolName} raised for approval — ${verdict.reason}`,
      });
      let outcome;
      try {
        outcome = await approvals({
          toolUseId: options.toolUseID,
          toolName,
          toolInput: input,
          reason: verdict.reason,
	  ...(title !== undefined ? { title } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (err) {
        // The requester owns its own failure modes and is documented never to
        // throw. If it does anyway, that is a bug in it, not a reason to leave
        // the harness with no answer.
        onEvent({
          kind: 'progress',
          text: `permission escalation: ${toolName} denied — the approval channel failed (${errText(err)})`,
        });
        return { behavior: 'deny', message: escalationMessage(verdict.reason) };
      }
      if (outcome.decision === 'approved') {
        onEvent({
          kind: 'progress',
          text: `permission escalation: ${toolName} approved by a human`,
        });
        return { behavior: 'allow' };
      }
      const why = outcome.reason ?? verdict.reason;
      onEvent({ kind: 'progress', text: `permission escalation: ${toolName} denied — ${why}` });
      return { behavior: 'deny', message: decisionMessage(why, outcome.note) };
    }

    // Recorded as well as returned: a denial the operator cannot see is how the
    // pre-callback behavior stayed invisible for as long as it did.
    onEvent({
      kind: 'progress',
      text: `permission escalation: ${toolName} denied — ${verdict.reason}`,
    });
    return { behavior: 'deny', message: escalationMessage(verdict.reason) };
  };
}

/** The five-value closed union the SDK types `Options.effort` as. */
const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Audited built-ins allowed when only the network is restricted. */
const OWENLOOP_ONLY_NETWORK_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'NotebookEdit',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
]);
/** The intersection when both restrictions apply: local reads only, with no
 *  unrestricted-network readers. */
const READ_ONLY_OWENLOOP_ONLY_NETWORK_TOOLS = [...READ_ONLY_TOOLS]
  .filter((tool) => OWENLOOP_ONLY_NETWORK_TOOLS.has(tool));
// The tools a born-bound step agent gets no matter how restricted it is.
// `ask` is here for the same reason `submit` is: without it a restricted agent
// has no legal way to END. It could previously only submit (fabricating when it
// did not know) or fall silent (re-arming the step into a retry storm). `ask` is
// about the agent's OWN owed artifact, so unlike `reject` it grants no authority
// over anyone else's work and there is no reason to withhold it under isolation.
const BORN_BOUND_OWENLOOP_TOOL_NAMES = ['get_order', 'submit', 'ask'] as const;
const BORN_BOUND_OWENLOOP_TOOLS = BORN_BOUND_OWENLOOP_TOOL_NAMES.map(
  (name) => `mcp__owenloop__${name}`,
);
const RESTRICTED_OWENLOOP_DENIED_TOOLS = ['mcp__owenloop__reject'] as const;
const EXACT_WORKDIR_BUILTINS = new Set(['Read', 'Glob', 'Grep']);
const OWENLOOP_CONTROL_TOOLS = new Set([
  ...BORN_BOUND_OWENLOOP_TOOLS,
  'mcp__plugin_owenloop_owenloop__get_order',
  'mcp__plugin_owenloop_owenloop__submit',
]);
const OWENLOOP_CONTROL_DENY_SPECS = new Set([
  ...OWENLOOP_CONTROL_TOOLS,
  'mcp__owenloop',
  'mcp__owenloop__*',
  'mcp__plugin_owenloop_owenloop',
  'mcp__plugin_owenloop_owenloop__*',
  'mcp__*',
]);

function effectiveClaudeTools(permissions: StepPermissions): readonly string[] | undefined {
  if (permissions.tools !== undefined) return permissions.tools;
  if (permissions.filesystem === 'read-only') {
    return permissions.network === 'owenloop-only'
      ? READ_ONLY_OWENLOOP_ONLY_NETWORK_TOOLS
      : [...READ_ONLY_TOOLS];
  }
  if (permissions.network === 'owenloop-only') return [...OWENLOOP_ONLY_NETWORK_TOOLS];
  return undefined;
}

function strictWorkdirToolIssue(permissions: StepPermissions): PermissionIssue | undefined {
  const effective = effectiveClaudeTools(permissions);
  if (effective === undefined) {
    return {
      field: 'tools',
      message: `${CLAUDE_EXACT_WORKDIR_VAR}=1 requires an explicit or derived built-in surface containing only Read, Glob, and Grep`,
    };
  }
  const unsafe = effective.filter(
    (tool) => !EXACT_WORKDIR_BUILTINS.has(tool) && !BORN_BOUND_OWENLOOP_TOOLS.includes(tool as typeof BORN_BOUND_OWENLOOP_TOOLS[number]),
  );
  if (unsafe.length === 0) return undefined;
  return {
    field: 'tools',
    message: `${CLAUDE_EXACT_WORKDIR_VAR}=1 permits only Read, Glob, Grep, and born-bound Owenloop controls; remove: ${unsafe.join(', ')}`,
  };
}

function claudePreflight(permissions: StepPermissions): PermissionIssue[] {
  const issues: PermissionIssue[] = [];
  let exactWorkdir = false;
  try {
    exactWorkdir = claudeExactWorkdir(process.env);
  } catch (error) {
    issues.push({ field: CLAUDE_EXACT_WORKDIR_VAR, message: errText(error) });
  }
  const authoredMode = permissions.permissionMode;
  if (authoredMode !== undefined) {
    if (!ACCEPTED_PERMISSION_MODES.includes(authoredMode)) {
      issues.push({
        field: 'permissionMode',
        message: `permissionMode must be one of ${ACCEPTED_PERMISSION_MODES.join('|')}`,
      });
    } else if (isNeutralPermissionMode(authoredMode) && NEUTRAL_TO_SDK_MODE[authoredMode] === null) {
      // Unreachable today — every neutral value maps here. Kept because the
      // table's `null` arm is a real contract option, and a refusal that only
      // exists once someone uses it is a refusal nobody has tested.
      issues.push({
        field: 'permissionMode',
        message: `permissionMode '${authoredMode}' is unsupported by this adapter`,
      });
    }
  }
  if (permissions.effort !== undefined && !EFFORT_LEVELS.includes(permissions.effort)) {
    issues.push({ field: 'effort', message: `effort must be one of ${EFFORT_LEVELS.join('|')}` });
  }
  if (permissions.filesystem === 'workspace-write') {
    issues.push({
      field: 'filesystem',
      message: "filesystem 'workspace-write' is unsupported by this adapter; use 'read-only' or 'unrestricted'",
    });
  }

  const allowed = permissions.tools;
  if (allowed !== undefined) {
    const unsupportedMcp = allowed.filter(
      (tool) => tool.startsWith('mcp__') && !OWENLOOP_CONTROL_TOOLS.has(tool),
    );
    if (unsupportedMcp.length > 0) {
      issues.push({
	field: 'tools',
	message:
	  `external MCP tools cannot be enforced by this adapter's exact allow-list: ` +
	  unsupportedMcp.join(', '),
      });
    }
  }
  if (permissions.filesystem === 'read-only' && allowed !== undefined) {
    const unsafe = allowed.filter(
      (tool) => !READ_ONLY_TOOLS.has(tool) && !OWENLOOP_CONTROL_TOOLS.has(tool),
    );
    if (unsafe.length > 0) {
      issues.push({
	field: 'tools',
	message: `filesystem 'read-only' cannot allow non-read-only tool(s): ${unsafe.join(', ')}`,
      });
    }
  }
  if (permissions.network === 'owenloop-only' && allowed !== undefined) {
    const unsafe = allowed.filter(
      (tool) => !OWENLOOP_ONLY_NETWORK_TOOLS.has(tool) && !OWENLOOP_CONTROL_TOOLS.has(tool),
    );
    if (unsafe.length > 0) {
      issues.push({
	field: 'tools',
	message: `network 'owenloop-only' cannot allow network-capable or unaudited tool(s): ${unsafe.join(', ')}`,
      });
    }
  }

  const deniedControl = (permissions.disallowedTools ?? []).filter((tool) => OWENLOOP_CONTROL_DENY_SPECS.has(tool));
  if (deniedControl.length > 0) {
    issues.push({
      field: 'disallowedTools',
      message: `the born-bound Owenloop control plane must retain get_order/submit access; remove: ${deniedControl.join(', ')}`,
    });
  }
  if (exactWorkdir) {
    const strictIssue = strictWorkdirToolIssue(permissions);
    if (strictIssue !== undefined) issues.push(strictIssue);
  }
  return issues;
}

/**
 * The error text a resume against a token the provider does not know is
 * expected to carry. SECONDARY detection only — `deliver` pre-checks with
 * `getSessionInfo`, which is deterministic. The exact provider string is
 * UNVERIFIED and can change between releases, which is precisely why it is not
 * the primary path.
 */
const RESUME_FAILURE_RE = /no conversation found|session not found|--resume/i;

function isPlainMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Programmatic PreToolUse guard for every path-bearing exposed built-in. */
export function buildExactWorkdirPreToolUse(cwd: string): HookCallback {
  return async (input) => {
    const deny = {
      continue: true,
      hookSpecificOutput: {
	hookEventName: 'PreToolUse' as const,
	permissionDecision: 'deny' as const,
	permissionDecisionReason: EXACT_WORKDIR_DENIAL_MESSAGE,
      },
    };
    try {
      if (input.hook_event_name !== 'PreToolUse' || !PATH_BEARING_TOOL_NAMES.has(input.tool_name)) return deny;
      if (!isPlainMap(input.tool_input)) return deny;
      const verdict = classifyExactWorkdirPath({
	toolName: input.tool_name,
	input: input.tool_input,
	workdir: cwd,
      });
      if (verdict.decision === 'deny') return deny;
      return {
	continue: true,
	hookSpecificOutput: {
	  hookEventName: 'PreToolUse' as const,
	  permissionDecision: 'allow' as const,
	},
      };
    } catch {
      return deny;
    }
  };
}

/** The mount for owenloop's own work-holder MCP surface, built from the worker's
 *  verbatim argv. `alwaysLoad` forces its tools into the turn-1 prompt instead of
 *  deferring them behind tool search — a step agent that cannot see `submit` on
 *  turn 1 cannot finish its order. */
function owenloopMount(mount: { command: string; args: string[] }): McpServerConfig {
  return { type: 'stdio', command: mount.command, args: mount.args, alwaysLoad: true };
}

/** Restricted sessions register a positive born-bound subset. The selector is
 * derived from the same names used by `allowedTools`, so the declared exception
 * and the MCP server's actual `tools/list` cannot drift within this adapter. */
function restrictedOwenloopMount(mount: { command: string; args: string[] }): McpServerConfig {
  return owenloopMount({
    command: mount.command,
    args: [...mount.args, `--mcp-tools=${BORN_BOUND_OWENLOOP_TOOL_NAMES.join(',')}`],
  });
}

/**
 * `mcpServers`, with the owenloop mount layered ON TOP of whatever the step's
 * bag declared. An author's own `owenloop` entry is overwritten, exactly as the
 * legacy frontmatter builder overwrites it today — the mount is born bound to a
 * specific order and a step def may not redirect it.
 */
function mergeMcpServers(
  bagServers: unknown,
  mount: { command: string; args: string[] },
): Record<string, McpServerConfig> {
  const base = isPlainMap(bagServers) ? (bagServers as Record<string, McpServerConfig>) : {};
  return { ...base, owenloop: owenloopMount(mount) };
}

/** Everything `buildClaudeOptions` reads for either cold start or resume. */
export interface ClaudeOptionInputs {
  cwd: string;
  owenloopMcp: { command: string; args: string[] };
  /** Per-start override; wins over `permissions.model`. */
  model?: string;
  /** Per-start override; wins over `permissions.effort`. */
  effort?: string;
  permissions: StepPermissions;
  /** The human approval channel, when this deployment has one. Absent keeps the
   *  refuse-and-route-to-`ask` behavior — see `buildCanUseTool`. */
  approvals?: ApprovalRequester;
  recoveryPolicy?: HarnessRecoveryPolicy;
  /** Host-parsed policy bit. Its environment spelling never enters Options. */
  exactWorkdir?: boolean;
}

/** The non-declarative bits a caller supplies per invocation. */
export interface ClaudeOptionExtras {
  /** The child environment, already built by `buildChildEnv`. Also the source
   *  `resolveExecutable` reads the binary override and `PATH` from. */
  env: Record<string, string | undefined>;
  abortController: AbortController;
  onEvent: (e: AgentEvent) => void;
  /** Preselected UUID for a cold start. Never set on a resume. */
  sessionId?: string;
  /** Set on a resume only. Never set on a start. */
  resume?: string;
}

/**
 * Map `StartArgs` + the Claude-owned extensions bag onto the SDK's `Options`.
 *
 * The mapping knowledge is PORTED from the legacy compile-time frontmatter
 * builder — the knowledge is correct, only the output format changed. Nothing is
 * imported from `src/adapters/`; the isolation test forbids that dependency
 * direction.
 */
export function buildClaudeOptions(
  inputs: ClaudeOptionInputs,
  extra: ClaudeOptionExtras,
): Options {
  const { permissions } = inputs;
	const exactWorkdir = inputs.exactWorkdir === true;
	const effectiveTools = effectiveClaudeTools(permissions);
	if (exactWorkdir) {
		const issue = strictWorkdirToolIssue(permissions);
		if (issue !== undefined) throw new HarnessTurnError('configuration', true, issue.message);
	}
	const diagnosticEvent = inputs.recoveryPolicy === undefined ? extra.onEvent : (_event: AgentEvent): void => {};
  const isolated =
    exactWorkdir ||
    permissions.tools !== undefined ||
    permissions.filesystem === 'read-only' ||
    permissions.network === 'owenloop-only';
  const options: Options = {
    cwd: inputs.cwd,
    env: extra.env,
    abortController: extra.abortController,
    mcpServers: isolated
      ? { owenloop: restrictedOwenloopMount(inputs.owenloopMcp) }
      : mergeMcpServers(permissions.extensions['mcpServers'], inputs.owenloopMcp),
    ...(isolated ? { settingSources: [], strictMcpConfig: true, skills: [] } : {}),
    stderr: (data: string) => {
	  // Recovery control state and worker logs are deliberately payload-free.
	  // Legacy turns keep their established stderr telemetry verbatim.
      const line = data.trimEnd();
	  diagnosticEvent({ kind: 'progress', text: `stderr: ${line}`, failure: cap(line) });
    },
    // Set here, before the `permissionMode` block below, because it is not
    // conditional on that block running: a step naming no mode at all is exactly
    // the case that used to reach the SDK's `default` and be denied wholesale.
    canUseTool: buildCanUseTool(
      inputs.cwd,
      gatePolicyFor(permissions.permissionMode),
      permissions.filesystem,
	  diagnosticEvent,
      inputs.approvals,
	  exactWorkdir,
    ),
  };

	if (exactWorkdir) {
		options.hooks = {
			PreToolUse: [{ matcher: [...PATH_BEARING_TOOL_NAMES].join('|'), hooks: [buildExactWorkdirPreToolUse(inputs.cwd)] }],
		};
	}

  // Partial messages are provider transport only: they reset liveness below but
  // are never mapped into progress/evidence output.
  if (inputs.recoveryPolicy !== undefined) options.includePartialMessages = true;

  // Omit the key entirely when nothing resolves — see `resolveExecutable`.
  const executable = resolveExecutable(extra.env);
  if (executable !== undefined) options.pathToClaudeCodeExecutable = executable;

  // PRECEDENCE, fixed by the contract: the per-start override wins over the
  // step's configured value, for both model and effort.
  const model = inputs.model ?? permissions.model;
  if (model !== undefined) options.model = model;

  const rawEffort = inputs.effort ?? permissions.effort;
  if (rawEffort !== undefined) {
    if (EFFORT_LEVELS.includes(rawEffort)) {
      options.effort = rawEffort as EffortLevel;
    } else {
      // Dropped rather than thrown or coerced — the same stance normalization
      // takes for a bad `maxTurns`. The linter only checks effort is a string,
      // so an unlintable-but-legal bag can carry an out-of-union value.
	  diagnosticEvent({
        kind: 'progress',
        text: `dropped out-of-range effort '${rawEffort}' (expected one of ${EFFORT_LEVELS.join('|')})`,
      });
    }
  }

  if (permissions.permissionMode !== undefined) {
    // Neutral `full-access` lands here as `bypassPermissions`, so the companion
    // flag below covers it too — that is the point of translating BEFORE the
    // pairing rather than after it. Neutral `ask` and `auto-safe` both land as
    // `default` and deliberately do NOT get the flag: `default` is the mode that
    // routes to `canUseTool`, which is where the difference between those two
    // positions is actually drawn (see `gatePolicyFor`).
    const mode = toSdkPermissionMode(permissions.permissionMode);
    if (mode !== undefined) {
      options.permissionMode = mode;
      // 'bypassPermissions' is IGNORED by the SDK without this companion flag.
      // Missing it is a silent downgrade to prompting, which in a headless run
      // means the step stalls forever on a prompt no human will answer.
      if (mode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    } else {
	  diagnosticEvent({
        kind: 'progress',
        text: `dropped unknown permissionMode '${permissions.permissionMode}' (expected one of ${ACCEPTED_PERMISSION_MODES.join('|')})`,
      });
    }
  }

  // `tools` and `allowedTools` are DIFFERENT SDK options and the step def's
  // single `tools:` field needs both: `tools` is the base set of AVAILABLE
  // built-in tools (what the legacy frontmatter `tools:` meant), `allowedTools`
  // is the set auto-allowed WITHOUT a permission prompt. Only `tools` leaves
  // every call waiting on a prompt nobody will answer headless; only
  // `allowedTools` fails to restrict the surface the author asked to restrict.
  //
  // ABSENT means "the step named no tools" and normally sets NEITHER key: the
  // SDK reads `tools: []` as "disable all built-in tools". Isolation is the
  // exception: the audited built-in list becomes explicit, and `allowedTools`
  // also auto-allows the born-bound get_order/submit MCP tools so the restricted
  // agent can inspect and finish its order without an unattended permission prompt.
  // The restricted MCP child itself registers exactly those born-bound tools; allowedTools
  // is permission automation, not an MCP visibility filter.
  if (effectiveTools !== undefined) {
    options.tools = effectiveTools.filter((tool) => !OWENLOOP_CONTROL_TOOLS.has(tool));
    options.allowedTools = [
      ...new Set([...effectiveTools, ...BORN_BOUND_OWENLOOP_TOOLS]),
    ];
  }
  if (isolated) {
    // Defense in depth only: the restricted MCP child does not register `reject`
    // at all. The deny protects against SDK/tool-surface regressions without being
    // the visibility boundary.
    options.disallowedTools = [
      ...new Set([
	...(permissions.disallowedTools ?? []),
	...RESTRICTED_OWENLOOP_DENIED_TOOLS,
      ]),
    ];
  } else if (permissions.disallowedTools !== undefined) {
    options.disallowedTools = [...permissions.disallowedTools];
  }
  // Normalization already guaranteed a positive integer or absence.
  if (permissions.maxTurns !== undefined) options.maxTurns = permissions.maxTurns;

  const skills = permissions.extensions['skills'];
  if (!isolated && (skills === 'all' || (Array.isArray(skills) && skills.every((s) => typeof s === 'string')))) {
    options.skills = skills as string[] | 'all';
  }

  if (extra.sessionId !== undefined) options.sessionId = extra.sessionId;
  if (extra.resume !== undefined) options.resume = extra.resume;

  // EXTENSIONS KEYS DELIBERATELY NOT MAPPED, so a reviewer reads intent rather
  // than an omission:
  //  - `hooks`: `Options.hooks` takes JS callback matchers, not the settings-file
  //    JSON shape a bag carries. Different types; a bag `hooks` map cannot be
  //    passed through.
  //  - `memory`, `background`, `isolation`, `color`, `initialPrompt`: Task-tool
  //    subagent-frontmatter concepts with no `Options` equivalent at this SDK
  //    version.
  // Unknown extension keys are ignored in silence — `owenloop work lint` is the place
  // that warns about them.
  //
  // Outside isolation, `settingSources` and `strictMcpConfig` stay unset so the
  // SDK preserves its normal settings and MCP behavior, including the full
  // get_order/submit/reject work-holder server. Isolation sets `settingSources: []`
  // and `strictMcpConfig: true` above, mounts the positive born-bound work-holder
  // subset, and removes settings, hooks, skills, or external MCP that could bypass
  // the authored restriction.
  // `persistSession` always stays unset: its default is `true`, and disabling it
  // would break resume-on-rejection.
  return options;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'close'>;

export interface ClaudeQueryArgs {
  prompt: string;
  options: Options;
}

export type ClaudeQueryFactory = (args: ClaudeQueryArgs) => ClaudeQuery;

export interface ClaudeStartDependencies {
  createSessionId: () => string;
  loadQuery: () => Promise<ClaudeQueryFactory>;
}

export interface ClaudeDeliverDependencies {
  loadQuery: () => Promise<ClaudeQueryFactory>;
  getSessionInfo: (token: string, opts: { dir: string }) => Promise<unknown>;
}

const DEFAULT_START_DEPENDENCIES: ClaudeStartDependencies = {
  createSessionId: randomUUID,
  loadQuery: async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    return (args) => query(args);
  },
};

const DEFAULT_DELIVER_DEPENDENCIES: ClaudeDeliverDependencies = {
  loadQuery: async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    return (args) => query(args);
  },
  getSessionInfo: async (token, opts) => {
    const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
    return getSessionInfo(token, opts);
  },
};

interface ClaudeSession {
  query: ClaudeQuery;
  abortController: AbortController;
  /** The resolved start options. Kept for live-session state only;
   *  `DeliverArgs.permissions` is authoritative when a resume rebuilds options. */
  options: Options;
}

/** Module-level, process-wide, keyed by session token. Only reachable from the
 *  process that started the session — which is exactly why `stop` is documented
 *  as a no-op on a token this process did not start. */
const SESSIONS = new Map<string, ClaudeSession>();

/** What one consumed turn tells the caller. */
export interface TurnOutcome {
  /** The session id from the `system/init` message, if one arrived. */
  sessionId: string | undefined;
  /** Whether the turn-end (`result`) message arrived. */
  sawResult: boolean;
}

/** Per-turn liveness machinery. All callbacks are payload-free by contract. */
export interface ConsumeTurnControl {
  idleTimeoutMs?: number;
	/** Suppress provider-controlled payload telemetry while retaining liveness and
	 * structured failure categories for a recovery-enabled turn. */
	sanitizeProviderTelemetry?: boolean;
  abortController?: AbortController;
  close?: () => void;
  onActivity?: (activity: { at: number; deadlineAt: number }) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** Strict profile's literal provider identity check, never a public arg. */
  expectedModel?: string;
}

/** Trim a progress line to something a log can hold. Mirrors the codex adapter's
 *  convention deliberately — the two adapters' logs are read side by side, so
 *  they truncate the same way. Kept local because this adapter must stay in one
 *  allowlisted file. */
const PROGRESS_TEXT_CAP = 2_000;

function cap(text: string): string {
  return text.length > PROGRESS_TEXT_CAP ? `${text.slice(0, PROGRESS_TEXT_CAP)}…` : text;
}

/** A payload-free failure line safe for recovery logs and durable telemetry. */
function sanitizedFailureText(error: unknown): string {
	const category = isHarnessTurnError(error) ? error.category : 'provider';
	return `provider failure category=${category} (details redacted)`;
}

/** Mark messages produced inside a Task-tool subagent. A flat log cannot
 *  otherwise tell a subagent's work from the main agent's. */
function origin(parentToolUseId: string | null): string {
  return parentToolUseId === null ? '' : `[subagent ${parentToolUseId}] `;
}

/** Flatten a tool_result body to loggable text. Non-text parts are named, not
 *  rendered — an image block has no useful string form. */
function toolResultText(content: ToolResultBlockParam['content']): string {
  if (content === undefined) return '(no content)';
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : `(${part.type})`)).join('\n');
}

/** One progress line per content block of an assistant message.
 *
 * TOOL INPUTS ARE NEVER LOGGED. A `tool_use` block's `input` can hold a Bash
 * command line carrying a secret. Only `name` and `id` are emitted — the same
 * two fields the codex adapter reveals for `item/started mcpToolCall`. */
function emitAssistant(message: SDKAssistantMessage, onEvent: (e: AgentEvent) => void): void {
  const from = origin(message.parent_tool_use_id);
  if (message.error !== undefined) {
    onEvent({
      kind: 'progress',
      text: `${from}assistant error: ${message.error}`,
      failure: cap(message.error),
    });
  }
  for (const block of message.message.content) {
    switch (block.type) {
      case 'text':
        onEvent({ kind: 'progress', text: cap(`${from}assistant: ${block.text}`) });
        break;
      case 'thinking':
        onEvent({ kind: 'progress', text: cap(`${from}thinking: ${block.thinking}`) });
        break;
      case 'redacted_thinking':
        onEvent({ kind: 'progress', text: `${from}thinking: (redacted)` });
        break;
      case 'tool_use':
      case 'mcp_tool_use':
        onEvent({ kind: 'progress', text: `${from}tool_use ${block.name} ${block.id}` });
        break;
      default:
        // Server-tool results, container uploads, compaction markers and any
        // block the vendor adds later. Naming the type keeps the line useful
        // without guessing at a shape this version does not define.
        onEvent({ kind: 'progress', text: `${from}${block.type} block` });
    }
  }
}

/** The reply a user would see from one top-level assistant message. This is
 * deliberately separate from `emitAssistant`: that function is operational
 * telemetry, while this value is emitted once at turn end as response evidence. */
function assistantResponse(message: SDKAssistantMessage): string | undefined {
  if (message.parent_tool_use_id !== null) return undefined;
  const text = message.message.content
    .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return text === '' ? undefined : text;
}

/** One progress line per content block of a user message — which on this path
 * means tool results coming back, plus any synthetic user text.
 *
 * Tool RESULTS are logged (capped); tool INPUTS are not. A result is what the
 * tool produced, and the codex adapter already logs the equivalent command
 * output. */
function emitUser(message: SDKUserMessage, onEvent: (e: AgentEvent) => void): void {
  const from = origin(message.parent_tool_use_id);
  const content = message.message.content;
  if (typeof content === 'string') {
    onEvent({ kind: 'progress', text: cap(`${from}user: ${content}`) });
    return;
  }
  for (const block of content) {
    switch (block.type) {
      case 'text':
        onEvent({ kind: 'progress', text: cap(`${from}user: ${block.text}`) });
        break;
      case 'tool_result': {
        const flag = block.is_error === true ? ' (error)' : '';
        const body = toolResultText(block.content);
        onEvent({
          kind: 'progress',
          text: cap(`${from}tool_result ${block.tool_use_id}${flag}: ${body}`),
        });
        break;
      }
      default:
        onEvent({ kind: 'progress', text: `${from}${block.type} block` });
    }
  }
}

/**
 * Drive the SDK message stream to TURN END and map it onto `AgentEvent`s.
 *
 * Resolves at the `result` message — turn end, per the contract — not at process
 * exit, and regardless of whether the result reports an error.
 *
 * `onInit` fires after a matching `system/init` confirms the preselected cold-
 * start session id. `startClaude` emits `{kind:'started'}` before query creation;
 * this callback marks the later provider confirmation, not the persistence gate.
 *
 * PHASE 6, ITEM 1 — EXPORTED, AND TYPED ON `AsyncIterable` RATHER THAN `Query`.
 * This is the one function that maps the SDK's message stream onto this
 * project's `AgentEvent` contract, so it is the only place a recorded transcript
 * can prove the mapping still matches a shipped vendor build without spawning
 * the vendor binary. `Query` is an `AsyncGenerator` PLUS control methods
 * (`interrupt`, `setModel`, …) that this function never calls; asking only for
 * what it uses is what lets a fixture drive it. A live `Query` still satisfies
 * the narrower type, so nothing at the call sites changes.
 */
export async function consumeTurn(
  q: AsyncIterable<SDKMessage>,
  onEvent: (e: AgentEvent) => void,
  onInit?: (sessionId: string) => void,
  expectedSessionId?: string,
  control: ConsumeTurnControl = {},
): Promise<TurnOutcome> {
  let sessionId: string | undefined;
  let sawInit = false;
  let finalResponse: string | undefined;
  let terminalFailure: HarnessTurnError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: Promise<never> | undefined;
  let idleTimeoutFailure: HarnessIdleTimeoutError | undefined;
  let timerGeneration = 0;
  let controlledQueryClosed = false;
	const recoveryEnabled = control.idleTimeoutMs !== undefined;
	const strictModelIdentity = control.expectedModel !== undefined;
	const sanitizeProviderTelemetry = control.sanitizeProviderTelemetry === true;
  const now = control.now ?? Date.now;
  const setTimer = control.setTimer ?? setTimeout;
  const clearTimer = control.clearTimer ?? clearTimeout;
  const closeControlledQuery = (): void => {
    if (controlledQueryClosed) return;
    controlledQueryClosed = true;
    try {
      control.close?.();
    } catch {
      // Turn classification is authoritative; exact-query cleanup is best effort.
    }
  };

  const arm = (): void => {
    const idleTimeoutMs = control.idleTimeoutMs;
    if (idleTimeoutMs === undefined) return;
    if (timer !== undefined) clearTimer(timer);
    const generation = ++timerGeneration;
    idleTimeoutFailure = undefined;
    const at = now();
    const deadlineAt = at + idleTimeoutMs;
    control.onActivity?.({ at, deadlineAt });
    timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimer(() => {
					if (generation !== timerGeneration) return;
					timer = undefined;
					idleTimeoutFailure = new HarnessIdleTimeoutError(idleTimeoutMs);
					// Latch and reject first so an iterator read that synchronously rejects
					// during abort/close cannot win the race as a generic provider failure.
					reject(idleTimeoutFailure);
					try {
						control.abortController?.abort();
				} catch {
					// An already-aborted controller is an equivalent successful teardown.
				}
					closeControlledQuery();
      }, idleTimeoutMs);
    });
  };

  const classifyAssistantError = (error: string | undefined): HarnessTurnError | undefined => {
	if (error === undefined) return undefined;
    if (error === 'authentication_failed' || error === 'oauth_org_not_allowed') {
      return new HarnessTurnError('authentication', true, `provider authentication failure (${error})`);
    }
    if (error === 'model_not_found') {
      return new HarnessTurnError('model-unavailable', true, 'provider model is unavailable');
    }
	return new HarnessTurnError('provider', false, 'provider reported an unclassified assistant failure');
  };
  const classifyResult = (message: SDKMessage): HarnessTurnError | undefined => {
    if (message.type !== 'result' || message.subtype === 'success') return undefined;
    const structured = message as unknown as { permission_denials?: unknown };
    if (Array.isArray(structured.permission_denials) && structured.permission_denials.length > 0) {
      return new HarnessTurnError('permission-policy', true, 'provider denied the configured permission policy');
    }
	return new HarnessTurnError('provider', false, 'provider returned an unclassified error result');
  };

  const iterator = q[Symbol.asyncIterator]();
  arm(); // Must cover silence before the first iterator result.
  try {
    for (;;) {
      const next = iterator.next();
      const item = timeout === undefined ? await next : await Promise.race([next, timeout]);
      if (item.done) {
		if (strictModelIdentity && !sawInit) {
			throw new HarnessTurnError('model-unavailable', true, 'provider did not confirm the configured literal model');
		}
		if ((recoveryEnabled || strictModelIdentity) && terminalFailure !== undefined) throw terminalFailure;
		return { sessionId, sawResult: false };
	  }
      const message = item.value;
      // Reset BEFORE mapping. A partial event stays transport-only but is still
      // proof of provider liveness.
      arm();
    if (message.type === 'system' && message.subtype === 'init') {
	  sawInit = true;
      if (expectedSessionId !== undefined && message.session_id !== expectedSessionId) {
		if (sanitizeProviderTelemetry) {
		  throw new HarnessTurnError('provider', false, 'provider session identity mismatch (details redacted)');
		}
	throw new Error(
	  `provider session id mismatch: expected ${expectedSessionId}, received ${message.session_id}`,
	);
      }
	  if (strictModelIdentity && message.model !== control.expectedModel) {
		throw new HarnessTurnError('model-unavailable', true, 'provider did not honor the configured literal model');
	  }
      sessionId = message.session_id;
      // The ONLY place these are observable. The live smoke asserts on the
      // `apiKeySource` here (subscription OAuth vs. an API key), and a later
      // phase's version-mismatch warning will want `claude_code_version`.
	  if (!sanitizeProviderTelemetry) {
		const servers = message.mcp_servers.map((s) => `${s.name}=${s.status}`).join(',');
		onEvent({
		  kind: 'progress',
		  text:
			`session ${message.session_id}: cliVersion=${message.claude_code_version} ` +
			`model=${message.model} apiKeySource=${message.apiKeySource} ` +
			`permissionMode=${message.permissionMode} cwd=${message.cwd} mcp=[${servers}]`,
		  model: cap(message.model),
		});
	  }
      onInit?.(sessionId);
    } else if (message.type === 'system' && message.subtype === 'model_refusal_fallback' && strictModelIdentity) {
		throw new HarnessTurnError('model-unavailable', true, 'provider attempted a model fallback');
    } else if (message.type === 'result') {
	  if (strictModelIdentity && !sawInit) {
		throw new HarnessTurnError('model-unavailable', true, 'provider did not confirm the configured literal model');
	  }
	  const classified = recoveryEnabled || strictModelIdentity ? terminalFailure ?? classifyResult(message) : undefined;
	  if (!sanitizeProviderTelemetry && finalResponse !== undefined) {
		onEvent({ kind: 'assistant_response', text: finalResponse });
	  }
      if (message.subtype !== 'success' || classified !== undefined) {
        // The contract's channel for "something went wrong that is not a resume
        // failure". Emitted BEFORE turn_ended so a caller reading events in
        // order sees the cause before the turn closes.
        onEvent({
          kind: 'exited',
          exitCode: null,
		  error: sanitizeProviderTelemetry || message.subtype === 'success'
			? sanitizedFailureText(classified)
			: message.errors.join('; ') || message.subtype,
        });
      }
      onEvent({ kind: 'turn_ended' });
	  if ((recoveryEnabled || strictModelIdentity) && classified !== undefined) throw classified;
      return { sessionId, sawResult: true };
    } else if (message.type === 'assistant') {
	  if (!sanitizeProviderTelemetry) {
		emitAssistant(message, onEvent);
		finalResponse = assistantResponse(message) ?? finalResponse;
	  }
	  if (recoveryEnabled || strictModelIdentity) terminalFailure ??= classifyAssistantError(message.error);
		} else if ((recoveryEnabled || strictModelIdentity) && message.type === 'auth_status' && message.error !== undefined) {
			// `error` is a structured SDK field. Its prose is deliberately neither
			// logged nor parsed for recovery decisions.
			throw new HarnessTurnError('authentication', true, 'provider authentication status failed');
    } else if (message.type === 'user') {
	  if (!sanitizeProviderTelemetry) emitUser(message, onEvent);
    }
    // `needs_input` is NEVER emitted: this SDK path has no blocking-question
    // channel that maps to it, and the contract has no reply channel by design.
    // `stream_event` is deliberately NOT mapped. Recovery-enabled options opt
    // into partial messages only to reset liveness; their payload would merely
    // duplicate the eventual assistant message and must not escape telemetry.
    // Other unrecognized types stay silent by design: the vendor adds message
    // kinds between releases, and a mapping that threw on one would turn a
    // routine CLI upgrade into a failed order.
    }
  } catch (error) {
		if (!recoveryEnabled && !strictModelIdentity) throw error;
		if (terminalFailure?.terminal === true) throw terminalFailure;
		if (idleTimeoutFailure !== undefined) throw idleTimeoutFailure;
		if (isHarnessTurnError(error)) throw error;
	// This is our own session-integrity guard, not a provider failure. Preserve
	// its actionable detail while normalizing all actual SDK failures below.
	if (error instanceof Error && error.message.startsWith('provider session id mismatch:')) throw error;
	// `deliverClaude` has a provider-specific, secondary resume-refusal fallback
	// behind its deterministic session-info preflight. Keep the original refusal
	// text intact until that boundary can translate it to ResumeUnavailableError;
	// wrapping it here would make an opt-out resume race look like a generic turn
	// failure and suppress the established same-firing cold replay.
	if (RESUME_FAILURE_RE.test(errText(error))) throw error;
	throw new HarnessTurnError('provider', false, 'provider SDK stream failed');
  } finally {
    timerGeneration += 1;
    if (timer !== undefined) clearTimer(timer);
    // Manual iterator driving does not perform AsyncIteratorClose when the
    // result message returns from inside the loop. Close this exact query before
    // a same-token recovery turn can replace it in SESSIONS.
    closeControlledQuery();
  }
}

/** The message text of an unknown thrown value, for an `exited` event. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startClaude(
  args: StartArgs,
  onEvent: (e: AgentEvent) => void,
  dependencies: ClaudeStartDependencies = DEFAULT_START_DEPENDENCIES,
): Promise<HarnessSessionRef> {
  // Parse and validate host policy before even emitting a start marker: a bad
  // audit configuration must not construct a provider query or a resumable row.
  const exactWorkdir = claudeExactWorkdir(process.env);
  if (exactWorkdir) {
    const issue = strictWorkdirToolIssue(args.permissions);
    if (issue !== undefined) throw new HarnessTurnError('configuration', true, issue.message);
  }
  // The provider token exists before any SDK work. `started` is synchronous by
  // contract, so the caller's fsynced active-row append must return before the
  // query factory can initialize a process or receive prompt bytes.
  const sessionId = dependencies.createSessionId();
  const ref: HarnessSessionRef = { harness: HARNESS_ID, token: sessionId };
  try {
    onEvent({ kind: 'started', ref });
  } catch (err) {
    try {
      onEvent({ kind: 'exited', exitCode: null, error: errText(err) });
    } catch {
      // Preserve the durable-persistence failure that closed the start gate.
    }
    throw err;
  }

  const env = buildChildEnv(process.env, { allowApiBilling: allowApiBillingFrom(process.env) });
  const abortController = new AbortController();
  const options = buildClaudeOptions({ ...args, exactWorkdir }, { env, abortController, onEvent, sessionId });

  let q: ClaudeQuery;
  try {
    // A plain STRING prompt, not an AsyncIterable. Query construction is the
    // provider-delivery boundary in the pinned SDK, so it must remain after the
    // `started` callback above. Streaming input buys this adapter nothing else.
    const query = await dependencies.loadQuery();
    q = query({ prompt: args.brief, options });
  } catch (err) {
    try {
      abortController.abort();
    } catch {
      // An already-aborted controller is equivalent to success.
    }
	if (args.recoveryPolicy === undefined) {
	  onEvent({ kind: 'exited', exitCode: null, error: errText(err) });
	  throw err;
	}
	const failure = isHarnessTurnError(err)
	  ? err
	  : new HarnessTurnError('provider', false, 'provider SDK query initialization failed');
	onEvent({
	  kind: 'exited',
	  exitCode: null,
	  error: sanitizedFailureText(failure),
	});
	throw failure;
  }

  SESSIONS.set(sessionId, { query: q, abortController, options });
  let exactClosed = false;
	let failureEventEmitted = false;
	const turnOnEvent = (event: AgentEvent): void => {
		if (event.kind === 'exited') failureEventEmitted = true;
		onEvent(event);
	};
  const closeExact = (): void => {
    if (exactClosed) return;
    exactClosed = true;
    if (SESSIONS.get(sessionId)?.query === q) SESSIONS.delete(sessionId);
    try {
      abortController.abort();
    } catch {
      // Best-effort, idempotent teardown.
    }
    try {
      q.close();
    } catch {
      // The timeout/failure remains authoritative.
    }
  };
  let initVerified = false;
  let outcome: TurnOutcome;
  try {
    outcome = await consumeTurn(
      q,
		turnOnEvent,
      () => {
	initVerified = true;
      },
      sessionId,
      {
				...(args.recoveryPolicy !== undefined ? { idleTimeoutMs: args.recoveryPolicy.idleTimeoutMs } : {}),
				sanitizeProviderTelemetry: args.recoveryPolicy !== undefined,
				abortController,
				close: closeExact,
				...(exactWorkdir && options.model !== undefined ? { expectedModel: options.model } : {}),
				onActivity: (activity) => onEvent({ kind: 'activity', ...activity }),
      },
    );
  } catch (err) {
    // An init mismatch or pre-init failure must not leave the preselected token
    // registered. `consumeTurn` closes every settled exact query; this explicit
    // delete preserves the cold-start gate even if that cleanup seam changes.
    if (!initVerified) SESSIONS.delete(sessionId);
    closeExact();
		if (!failureEventEmitted) {
			onEvent({
				kind: 'exited',
				exitCode: null,
				error: args.recoveryPolicy !== undefined ? sanitizedFailureText(err) : errText(err),
			});
		}
    throw err;
  }

  if (outcome.sessionId === undefined) {
    closeExact();
    const why = outcome.sawResult
      ? 'the turn ended without confirming the supplied session id'
      : 'the stream ended before confirming the supplied session id';
    onEvent({ kind: 'exited', exitCode: null, error: why });
    throw new Error(`harness start failed: ${why}`);
  }
  return ref;
}

export async function deliverClaude(
  ref: HarnessSessionRef,
  message: string,
  args: DeliverArgs,
  onEvent: (e: AgentEvent) => void,
  dependencies: ClaudeDeliverDependencies = DEFAULT_DELIVER_DEPENDENCIES,
): Promise<void> {
  // This must precede the session-info preflight too: an incompatible strict
  // profile is a configuration error, not a reason to ask the provider first.
  const exactWorkdir = claudeExactWorkdir(process.env);
  if (exactWorkdir) {
    const issue = strictWorkdirToolIssue(args.permissions);
    if (issue !== undefined) throw new HarnessTurnError('configuration', true, issue.message);
  }
  // Session lookup is scoped to the PROJECT DIRECTORY, so a deleted worktree can
  // never resume no matter how good the token is. Distinct message on purpose —
  // the caller reads these to tell the two failures apart.
  if (!existsSync(args.cwd)) {
	throw new ResumeUnavailableError(
	  args.recoveryPolicy !== undefined
		? 'recovery resume cwd is unavailable (details redacted)'
		: `resume cwd no longer exists: ${args.cwd}`,
	);
  }

  // Deterministic pre-check, rather than parsing a failed query's error text
  // (that string is unverified and can change between releases).
  //
  // KNOWN FALSE NEGATIVE, accepted: this also returns undefined for a session
  // that exists but has no extractable summary, which downgrades a resumable
  // session to a cold replay. The failure direction is a wasted replay — never a
  // hang and never a wrong-session resume — so it is the safe way to be wrong.
  let known = false;
  try {
    known = (await dependencies.getSessionInfo(ref.token, { dir: args.cwd })) !== undefined;
  } catch {
    known = false;
  }
  if (!known) {
	throw new ResumeUnavailableError(
	  args.recoveryPolicy !== undefined
		? 'provider no longer knows the recovery session (details redacted)'
		: `provider no longer knows session ${ref.token}`,
	);
  }

  const env = buildChildEnv(process.env, { allowApiBilling: allowApiBillingFrom(process.env) });
  const abortController = new AbortController();

  // PHASE 4: `args` IS THE SOURCE OF TRUTH, not `SESSIONS`.
  //
  // Until Phase 4 this branched on `SESSIONS.get(ref.token)` and, on a miss, built
  // a MINIMAL option set — no permission mode, no tool lists, no model. A resume
  // that happens in a different process from the start (a re-offered step is
  // dispatched as a fresh `owenloop work agent-run` child, so that is the normal case,
  // not the exotic one) therefore ran the resumed turn under weaker permissions
  // than the turn it continued, and stalled headless. `DeliverArgs` now carries
  // the same normalized `StepPermissions` the caller passed to `start`, so the
  // same mapping runs on both paths and the in-process map is no longer consulted
  // for options at all.
  //
  // A resumed turn does not inherit permission mode / tool lists / model from the
  // session — they are per-invocation flags — which is exactly why they must be
  // re-mapped here.
  const options: Options = buildClaudeOptions({ ...args, exactWorkdir }, {
    env,
    abortController,
    onEvent,
    resume: ref.token,
  });

  // `forkSession` is deliberately NOT set: a fork would mint a new session id the
  // caller does not know about, and resume must continue the SAME session.
	let q: ClaudeQuery;
	try {
		const query = await dependencies.loadQuery();
		q = query({ prompt: message, options });
	} catch (err) {
		if (args.recoveryPolicy === undefined) {
			onEvent({ kind: 'exited', exitCode: null, error: errText(err) });
			throw err;
		}
			const failure = isHarnessTurnError(err)
				? err
				: new HarnessTurnError('provider', false, 'provider SDK query initialization failed');
			onEvent({
				kind: 'exited',
				exitCode: null,
				error: sanitizedFailureText(failure),
			});
		throw failure;
	}
	  SESSIONS.set(ref.token, { query: q, abortController, options });
	  let exactClosed = false;
	let failureEventEmitted = false;
	const turnOnEvent = (event: AgentEvent): void => {
		if (event.kind === 'exited') failureEventEmitted = true;
		onEvent(event);
	};
	  const closeExact = (): void => {
    if (exactClosed) return;
    exactClosed = true;
    if (SESSIONS.get(ref.token)?.query === q) SESSIONS.delete(ref.token);
    try {
      abortController.abort();
    } catch {
      // Best-effort, idempotent teardown.
    }
    try {
      q.close();
    } catch {
      // The timeout/failure remains authoritative.
    }
  };

  try {
    // Never emits `started` — the contract forbids re-emitting it on a resume.
	    await consumeTurn(q, turnOnEvent, undefined, undefined, {
      ...(args.recoveryPolicy !== undefined ? { idleTimeoutMs: args.recoveryPolicy.idleTimeoutMs } : {}),
	  sanitizeProviderTelemetry: args.recoveryPolicy !== undefined,
      abortController,
      close: closeExact,
	  ...(exactWorkdir && options.model !== undefined ? { expectedModel: options.model } : {}),
      onActivity: (activity) => onEvent({ kind: 'activity', ...activity }),
    });
  } catch (err) {
    const text = errText(err);
    // Belt and braces behind the `getSessionInfo` pre-check.
    if (RESUME_FAILURE_RE.test(text)) {
	  throw new ResumeUnavailableError(
		args.recoveryPolicy !== undefined
		  ? 'provider refused recovery resume (details redacted)'
		  : `provider refused resume of session ${ref.token}: ${text}`,
	  );
    }
		if (!failureEventEmitted) {
			onEvent({
				kind: 'exited',
				exitCode: null,
				error: args.recoveryPolicy !== undefined ? sanitizedFailureText(err) : text,
			});
		}
    throw err;
  }
}

async function stop(ref: HarnessSessionRef): Promise<void> {
  const session = SESSIONS.get(ref.token);
  // Idempotent by contract: an already-dead session is not an error, and a
  // session started by a previous process is simply not reachable from here.
  if (session === undefined) return;
  SESSIONS.delete(ref.token);
  try {
    session.abortController.abort();
  } catch {
    // an already-aborted controller is exactly the not-an-error case
  }
  try {
    // Terminates the underlying process and cleans up pending requests, MCP
    // transports and the CLI subprocess. `interrupt()` is not usable here: it is
    // streaming-input-mode only, and this adapter sends a plain string prompt.
    session.query.close();
  } catch {
    // a close that throws on an already-exited child is likewise not an error
  }
}

/**
 * The singleton. Exported so tests use the object directly rather than through
 * registry state, even though importing this module also registers it.
 */

// ---------------------------------------------------------------------------
// Static option-bag check (`owenloop work lint`)
// ---------------------------------------------------------------------------

/**
 * The field vocabulary this harness understands inside a step's `x.harness` map.
 * Moved here from the deleted `src/adapters/claude-code.ts`: which option names
 * are legal is vendor knowledge, so it belongs in the vendor's own file and
 * nowhere else.
 *
 * `name` and `description` are RESERVED — owenloop generates the subagent
 * identity, so a def that sets them is overridden silently and is worth an error.
 */
const RESERVED_KEYS = ['name', 'description'] as const;

const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'tools',
  'disallowedTools',
  'filesystem',
  'network',
  'model',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
]);

const MEMORY_SCOPES = new Set(['user', 'project', 'local']);

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Check one step's `x.harness` option map against this harness's vocabulary.
 *
 * `bag` arrives with `id` already stripped by the def parser, so `id` is never
 * reported as an unknown field. Unknown fields are WARNINGS (a def may be written
 * against a newer CLI than this owenloop build); wrong types and reserved keys
 * are ERRORS. Never throws — a malformed bag produces findings.
 */
function lintStep(bag: Record<string, unknown>, step: string): LintFinding[] {
  const findings: LintFinding[] = [
    ...validateHarnessOptions(bag, step),
    ...claudePreflight(normalizeStepPermissions(bag)).map((issue) => ({
      severity: 'error' as const,
      step,
      message: issue.message,
      ...(issue.field !== undefined ? { field: issue.field } : {}),
    })),
  ];
  const err = (message: string, field?: string): void => {
    findings.push({ severity: 'error', step, message, ...(field !== undefined ? { field } : {}) });
  };
  const warn = (message: string, field?: string): void => {
    findings.push({ severity: 'warning', step, message, ...(field !== undefined ? { field } : {}) });
  };

  for (const key of RESERVED_KEYS) {
    if (key in bag) err(`'${key}' is generated and cannot be set in the bag`, key);
  }

  for (const key of Object.keys(bag)) {
    if (!KNOWN_FIELDS.has(key)) {
      warn(`unknown field '${key}' — known fields: ${[...KNOWN_FIELDS].join(', ')}`, key);
    }
  }

  const check = (field: string, ok: (v: unknown) => boolean, expected: string): void => {
    if (field in bag && !ok(bag[field])) {
      err(`${field} must be ${expected}, got ${typeName(bag[field])}`, field);
    }
  };

  check('skills', (v) => v === 'all' || (Array.isArray(v) && v.every((e) => typeof e === 'string')), "'all' or a string[]");
  check('background', (v) => typeof v === 'boolean', 'a boolean');
  check('mcpServers', isPlainMap, 'a map');
  check('hooks', isPlainMap, 'a map');

  if ('memory' in bag && !MEMORY_SCOPES.has(bag['memory'] as string)) {
    err(`memory must be one of ${[...MEMORY_SCOPES].join('|')}`, 'memory');
  }

  if (isPlainMap(bag['mcpServers']) && 'owenloop' in bag['mcpServers']) {
    warn('mcpServers.owenloop is reserved and is replaced by the worker at start', 'mcpServers');
  }

  return findings;
}

/**
 * The command a human runs to re-open this session in an interactive terminal.
 *
 * WHY IT RESOLVES THE BINARY RATHER THAN PRINTING A BARE NAME. An operator who
 * set `OWENLOOP_CLAUDE_BIN` did so because the plain name does not run on their
 * machine, and a listing that prints a command they cannot paste is worse than
 * printing nothing. `resolveExecutable` returns `undefined` when neither the
 * override nor a `PATH` hit exists; the bare CLI name is the honest fallback
 * there, since the SDK's own bundled executable has no stable path to name.
 *
 * It reads `process.env` and not the child environment: this is a command for
 * the OPERATOR's shell, not for a harness child.
 */
function resumeCommand(ref: HarnessSessionRef): { command: string; args: string[] } {
  return {
    command: resolveExecutable(process.env) ?? 'claude',
    args: ['--resume', ref.token],
  };
}

export const claudeAdapter: HarnessAdapter = {
  id: HARNESS_ID,
  // The provider stores the session and resumes it from the opaque token this
  // adapter puts in `HarnessSessionRef.token`.
  resumeTier: 'native-token',
  recoveryPolicy: () => claudeRecoveryPolicy(),
  preflight: claudePreflight,
  start: startClaude,
  deliver: deliverClaude,
  stop,
  lintStep,
  resumeCommand,
};

// Self-registration at import time: importing this module is what puts the
// adapter in the runtime registry. WHO imports it is a composition root's
// decision (`src/roles/agent-run.ts`, `src/roles/lint.ts`), not this module's.
register(claudeAdapter);
