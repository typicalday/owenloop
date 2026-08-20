/**
 * The harness contract — the ONLY thing every harness adapter implements, and
 * the only shapes the worker speaks.
 *
 * Why it exists: owenloop moved from writing per-order subagent files into
 * a vendor CLI's own directory and handing a lean order to an external Shift,
 * to HOSTING each step agent itself behind a per-harness adapter, with a
 * provider-native session token persisted per step attempt so a rejected step
 * can be RESUMED rather than restarted. This file is the seam that makes the
 * hosting side harness-agnostic.
 *
 * Failure stance: this module is pure declaration plus one error class. It
 * performs no I/O, spawns nothing, and cannot fail. Every runtime concern
 * (process launch, stream parsing, credential handling) belongs to an adapter.
 *
 * ISOLATION RULE (enforced by `test/harness-isolation.test.ts`): no file under
 * `src/harness/` may name a harness vendor except the per-harness adapter
 * modules themselves. That rule is why the comments in this file describe vendor
 * behavior generically instead of naming the vendor.
 */
import type { LintFinding } from './types.ts';

/**
 * How well a harness can pick a conversation back up.
 *
 *  - `native-token` — the provider stores the session and resumes it from an
 *    opaque token (the token in `HarnessSessionRef`).
 *  - `keep-alive`   — resume only works while the adapter's own process is
 *    still alive; a restart loses the session.
 *  - `replay`       — no resume at all; the caller re-sends the whole brief.
 *
 * Declarative metadata in Phase 1 — nothing branched on it then. Phase 4's
 * resume-on-rejection decision in `src/agent/loop.ts` is the first consumer: a
 * `replay`-tier adapter is never asked to `deliver`, it is always cold-started.
 */
export type ResumeTier = 'native-token' | 'keep-alive' | 'replay';

/** A handle to one live-or-resumable provider session. */
export interface HarnessSessionRef {
  /** Adapter id — the same string `HarnessAdapter.id` carries. */
  harness: string;
  /** Provider-native session/thread id. Opaque here; only its adapter parses it.
   *  Machine-local by design: it has no meaning off this machine and is NEVER
   *  sent to the hub. */
  token: string;
}

/**
 * Telemetry from a running turn.
 *
 * THE HUB IS TRUTH; THIS STREAM IS TELEMETRY + LIVENESS. The step agent signals
 * TASK completion by calling the `submit` MCP tool (registered in
 * `src/hold/mcp.ts` — locate `submitTool` by grep, not by line number). The
 * worker learns that the order finished from `Lease.outcome` on `get_order`
 * (the `outcome` field on `Lease` in `src/hub/types.ts`; the mechanism is
 * mapped in `docs/agent-runner.md` §(b)) — NEVER from an `exited` event. An
 * adapter that stops emitting says nothing about whether the work was accepted.
 */
export type AgentEvent =
  | {
      kind: 'started';
      ref: HarnessSessionRef;
      /** Provider-selected model when the session-start response exposes it. */
      model?: string;
    }
  /** Optional log line. Adapters may emit none; nothing may depend on it. */
  | { kind: 'progress'; text: string }
  /** The completed top-level assistant reply, assembled by the owning adapter.
   * Unlike `progress`, this is suitable for a caller that explicitly needs the
   * final response rather than transport, tool, reasoning, or stderr telemetry. */
  | { kind: 'assistant_response'; text: string }
  /** The harness surfaced a blocking question. Phase 1 defines the EVENT only —
   *  this contract has no reply channel, and adding one is Phase 3/4's call. */
  | { kind: 'needs_input'; question: string }
  /** The model turn completed (the SDK result message on an in-process SDK
   *  path; `turn/completed` on an app-server path). */
  | { kind: 'turn_ended' }
  | { kind: 'exited'; exitCode: number | null; error?: string };

/**
 * The step-def permission fields, normalized into a harness-neutral struct.
 *
 * Declared HERE rather than beside its normalizer in `permissions.ts` because
 * both adapters read the type as part of the contract surface: `permissions.ts`
 * imports this type, giving one dependency direction and no cycle.
 *
 * Produced by `normalizeStepPermissions` (`./permissions.ts`).
 */
export type FilesystemPermission = 'read-only' | 'workspace-write' | 'unrestricted';
export type NetworkPermission = 'owenloop-only' | 'unrestricted';

export interface StepPermissions {
  /** Allowed tool names. Absent when the step named no allow-list; `[]` means no built-in tools. */
  tools?: string[];
  /** Denied tool names. Absent when the step named no deny-list; an explicit `[]` is preserved. */
  disallowedTools?: string[];
  /** Filesystem authority requested by the workflow definition. */
  filesystem?: FilesystemPermission;
  /** Network authority requested by the workflow definition. */
  network?: NetworkPermission;
  /**
   * Adapter permission mode. Each adapter validates its own vocabulary, PLUS the
   * neutral values every adapter must either translate or refuse — see
   * `NEUTRAL_PERMISSION_MODES`.
   */
  permissionMode?: string;
  /** Only ever a positive integer; anything else was dropped in normalization. */
  maxTurns?: number;
  model?: string;
  effort?: string;
  /** Everything with no harness-neutral meaning, verbatim. Only the OWNING
   *  adapter reads its own keys. REQUIRED — always present, possibly `{}` — so
   *  no adapter needs a null check. */
  extensions: Record<string, unknown>;
}

/**
 * The HARNESS-NEUTRAL `permissionMode` vocabulary: three distinct positions on
 * ONE axis — how much a step may do before a human is consulted.
 *
 * WHY THIS EXISTS. `permissionMode` sits in `NEUTRAL_KEYS` (see
 * `./permissions.ts`) alongside `filesystem` and `network`, but it did not
 * behave like them. `filesystem: unrestricted` is an INTENT the step states and
 * each adapter translates into its own dialect — one shipped adapter turns it
 * into that vendor's own sandbox setting. `permissionMode` had no translation
 * layer at all: the authored string went to the adapter verbatim, and the
 * shipped adapters accept DISJOINT vocabularies for the same ideas, each
 * refusing the other's at preflight. A step therefore had to name one vendor's
 * word, which pinned it to that vendor as surely as an explicit `id:` would
 * have. That is exactly the pin the neutral-key contract exists to prevent.
 *
 * THE THREE POSITIONS ARE NOT INTERCHANGEABLE. Both shipped harnesses draw the
 * same three distinctions, so collapsing any two would lose a real one:
 *
 * - `ask` — the harness consults a human before anything beyond trivially safe
 *   reads. The human is the gate.
 * - `auto-safe` — a model-side classifier judges each action: it proceeds on
 *   ordinary work and consults a human only when an action is potentially
 *   dangerous. The classifier is the gate; a human is the exception path.
 * - `full-access` — nothing is gated. The harness never consults a human, and
 *   a failed action is simply reported back to the model.
 *
 * `auto-safe` is NOT a milder `full-access`: the position it names still has a
 * human exception path. A headless step that must not stall wants
 * `full-access`, and the two exist separately so that choice is stated rather
 * than inferred.
 *
 * WHO ACTUALLY DOES THE GATING, AND WHAT IT COSTS. The three positions above
 * describe the vocabulary, not a guarantee about how far any given VENDOR
 * classifier goes before it consults someone — and measurement showed the
 * vendor classifiers do not, in practice, consult anyone. One was probed with
 * five actions, among them a recursive delete on an absolute path outside the
 * session working directory, an outbound network request, and a read of a file
 * outside that directory; it consulted the host on none of them and reported no
 * auto-denial for any of them, and four ran. The other keys its judgment on
 * filesystem access being restricted, so a step that also declares
 * `filesystem: unrestricted` moves it close to `full-access` as well.
 *
 * So `auto-safe` is NOT implemented by handing the decision to a vendor
 * classifier and hoping. An adapter that can intercept its harness's tool calls
 * gates them itself (see `./gatekeeper.ts`) — path containment against the
 * step's own working directory, plus a short deny-list of destructive shell
 * patterns — which is a blunter instrument than a model-side classifier and the
 * only one of the two that can actually escalate. An adapter that CANNOT
 * intercept owes this vocabulary the other legitimate answer: refuse the value
 * in `preflight`, per "WHAT AN ADAPTER OWES THIS VOCABULARY" below.
 *
 * `ask` and `auto-safe` name positions where something is consulted. In a
 * Shift-dispatched run no person is watching at the moment of the call, so the
 * consultation cannot be synchronous: an adapter refuses the call and routes the
 * agent to the `ask` MCP tool, which freezes the owed artifact and puts the
 * question on a human's attention feed with an answer path back into the next
 * attempt. What an adapter must never do is leave the call waiting on a prompt
 * nobody will answer — that is a stall, and the hub re-arms the step into a
 * retry storm whose every worker dies in the same place. Nor may it silently
 * upgrade one value into another to avoid the problem.
 *
 * WHAT AN ADAPTER OWES THIS VOCABULARY. For each value an adapter must either
 * map it onto the vendor mode with the same meaning, or refuse it in
 * `preflight` with a `PermissionIssue` naming `permissionMode`. Refusing is a
 * legitimate answer and fails closed: the worker releases its claim and starts
 * no model process. Mapping a value onto a mode that grants MORE than the value
 * describes is never legitimate.
 *
 * VENDOR VALUES ARE UNCHANGED. Each adapter still accepts its own native
 * vocabulary and still refuses every other adapter's. These values are an
 * ADDITION, so no already-published definition changes meaning.
 */
export const NEUTRAL_PERMISSION_MODES = Object.freeze([
  'ask',
  'auto-safe',
  'full-access',
] as const);

export type NeutralPermissionMode = (typeof NEUTRAL_PERMISSION_MODES)[number];

/**
 * An adapter's neutral-vocabulary translation table.
 *
 * EXHAUSTIVE BY TYPE, and that is the point: adding a fourth neutral value
 * breaks compilation in every adapter until each one decides what it means
 * there. `null` is the explicit "this adapter has no equivalent" decision and
 * makes `preflight` refuse — distinct from an adapter that simply forgot.
 */
export type NeutralPermissionModeMap = Readonly<Record<NeutralPermissionMode, string | null>>;

export function isNeutralPermissionMode(value: string): value is NeutralPermissionMode {
  return (NEUTRAL_PERMISSION_MODES as readonly string[]).includes(value);
}

/** One fail-closed adapter preflight refusal. */
export interface PermissionIssue {
  /** The normalized permission field or extension key responsible, when one exists. */
  field?: string;
  message: string;
}

/**
 * ONE escalated tool call, as the adapter hands it to the approval channel.
 *
 * `toolUseId` is the HARNESS's own id for the blocked call. It is the approval's
 * identity, which is what makes a repeat of the same request the same question
 * rather than a second one — an adapter that polls does so by re-sending an
 * identical request.
 */
export interface ApprovalRequest {
  toolUseId: string;
  toolName: string;
  /** The call's arguments, as the harness presented them. */
  toolInput: unknown;
  /** Why the gatekeeper would not allow the call on its own. Shown to a person. */
  reason: string;
  /** The harness's own one-line rendering of the prompt, when it has one. */
  title?: string;
  /** Aborts the wait when the harness gives up on the call (session teardown). */
  signal?: AbortSignal;
}

/**
 * What came back. `note` is the deciding person's own words, when they left any.
 *
 * THERE IS NO THIRD OUTCOME. A timeout, a hub error, a lease that ended while
 * the worker waited — every one of them is `denied`, with a `reason` an adapter
 * can put in front of the agent. The alternative would be an adapter that has to
 * decide what "no answer" means at the moment it is least able to, and the
 * failure mode of guessing wrong is a tool call that runs because nobody said
 * no.
 */
export interface ApprovalOutcome {
  decision: 'approved' | 'denied';
  /** Why, when the decision was not a person's explicit yes. */
  reason?: string;
  note?: string;
}

/**
 * The channel an adapter uses to ask a PERSON about one tool call and wait.
 *
 * Supplied by the worker, not built by an adapter: it is the worker that holds
 * the hub client and knows which run this session is serving. An adapter that
 * receives no requester keeps its pre-existing behavior — refuse the call and
 * route the agent to `ask` — which is why this is optional rather than required.
 * Nothing about the shape is vendor-specific; every harness that can intercept a
 * tool call can use it.
 */
export type ApprovalRequester = (req: ApprovalRequest) => Promise<ApprovalOutcome>;

/** Everything an adapter needs to launch one step agent. */
export interface StartArgs {
  /** The fully rendered step prompt. */
  brief: string;
  /** The order's working directory (the provisioned worktree). */
  cwd: string;
  /**
   * PER-START OVERRIDE, not the step's configured model.
   *
   * PRECEDENCE — every adapter resolves `args.model ?? args.permissions.model`
   * (and `args.effort ?? args.permissions.effort`). `StepPermissions.model` is
   * the normalized step-def value; this field is the worker's override channel
   * (e.g. escalating the model on a retry). Stated here because plan §3 puts
   * `model`/`effort` on both shapes without saying which wins; left unresolved,
   * the parallel adapter tracks would each pick a different answer and the
   * divergence would only surface in production.
   */
  model?: string;
  /** Per-start override for reasoning effort. Same precedence rule as `model`. */
  effort?: string;
  /**
   * The stdio mount for owenloop's own born-bound work-holder MCP surface. The
   * default server registers `get_order`, `submit`, and `reject`. An adapter that
   * enforces a restricted session may append the hold role's positive selector so
   * the mounted server registers only the policy's exact subset. The command is
   * the current Node executable and the first argv item is this installation's
   * resolved `bin/owenloop.mjs`, so PATH cannot select a different Owenloop
   * installation.
   *
   * BUILT BY THE WORKER, NOT BY AN ADAPTER: `src/agent/brief.ts` constructs the
   * born-bound `hold --order <workflow>/<run> --origin <url> --as <account>
   * --shift=<cid> --mcp` argv from the live order. An adapter preserves the
   * born-bound command and identity arguments; an adapter may append only a
   * policy-owned tool-surface selector. The order id, origin, and account ride
   * argv, never the prompt.
   */
  owenloopMcp: { command: string; args: string[] };
  /** Normalized from the step def by `normalizeStepPermissions`. */
  permissions: StepPermissions;
  /**
   * The human approval channel for escalated tool calls, when this deployment
   * has one. ABSENT means the adapter's existing refuse-and-route-to-`ask`
   * behavior stands — that is a supported deployment, not a degraded one.
   */
  approvals?: ApprovalRequester;
}

/**
 * Everything an adapter needs to RESUME an existing session with one message.
 *
 * WHY IT CARRIES `permissions` (Phase 4). Phase 2A observation 1 and Phase 2B
 * observation 1 recorded the same defect from opposite ends: both adapters kept
 * the resolved vendor option set in an in-process map keyed by session token, and
 * `deliver` read that map as its source of truth. A resume that happens in a
 * DIFFERENT PROCESS from the `start` — which is exactly the Phase 4 case, because
 * a re-offer is dispatched as a fresh `owenloop work agent-run` child — misses the map
 * and used to degrade silently to a minimal option set. The resumed turn then ran
 * with weaker, looser permissions than the turn it was continuing.
 *
 * The fix is to pass the same normalized `StepPermissions` that `start` got. The
 * caller already has it: `src/agent/loop.ts` computes it with
 * `normalizeStepPermissions(rawBag, material.def)` from `material.def.x[<id>]` on
 * the resume path too. The rejected alternative was persisting the resolved
 * vendor options blob beside the `SessionRecord`, which would put vendor-shaped
 * data into the deliberately vendor-free session store and would need a migration
 * every time a vendor moved its option shape.
 *
 * CONTRACT FOR ADAPTERS: the passed `permissions` WINS. An adapter may keep its
 * in-memory map as a fast path for other state (an abort controller, a live
 * client), but it must map these `permissions` rather than whatever the map
 * happened to hold, and it must NOT fall back to a minimal option set on a map
 * miss.
 */
export type DeliverArgs = Pick<StartArgs, 'cwd' | 'owenloopMcp' | 'permissions'> &
  Pick<StartArgs, 'model' | 'effort' | 'approvals'>;

/**
 * One harness implementation.
 *
 * TURN END, NOT PROCESS END: both `start` and `deliver` resolve when the model
 * TURN ends — the SDK result message on an in-process SDK path, `turn/completed`
 * on an app-server path (verified present in the pinned app-server's default
 * schema, `docs/agent-runner.md` §(d)). They do NOT wait for the harness process
 * to exit, and resolving says nothing about whether the task succeeded (see
 * `AgentEvent`: the hub is truth).
 *
 * ERROR NORMALIZATION: a provider that no longer knows the session token must
 * surface as a rejected promise carrying `ResumeUnavailableError`, so the caller
 * can fall back to a cold replay. EVERY other failure surfaces as an `exited`
 * event carrying `error`.
 *
 * DELIBERATELY ABSENT — do not add either without re-opening the contract:
 *  - an `allowApiBilling` flag on `StartArgs`. Stripping inherited provider
 *    API-key environment variables from a child environment (they silently
 *    shadow subscription OAuth and bill API credits) is MACHINE-LEVEL config,
 *    not per-start data; the adapter that needs the toggle reads it from
 *    env/settings inside its own module.
 *  - a reply channel for `needs_input` (see that event's own note).
 */
export interface HarnessAdapter {
  /** Registry key — the adapter's own harness id. Stable across versions. */
  id: string;
  resumeTier: ResumeTier;
  /**
   * Mandatory permission preflight. Returns every restriction this adapter cannot
   * enforce exactly. The worker calls this before start or resume; a non-empty
   * result means no provider process may be started.
   */
  preflight(permissions: StepPermissions): PermissionIssue[];
  /**
   * Launch a NEW session. Resolves at turn end with the session ref.
   *
   * Emits `{kind:'started', ref}` BEFORE provider work begins and before it
   * resolves. The callback is a synchronous persistence gate: an adapter must
   * not start delivery until the callback returns, and a thrown callback must
   * abort/abandon the turn. The caller persists the token on that event so a
   * mid-turn crash leaves an authoritative active record behind.
   */
  start(args: StartArgs, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef>;
  /**
   * Deliver a message into an EXISTING session (resume). Resolves at turn end.
   * Rejects with `ResumeUnavailableError` when the provider no longer knows the
   * token — the caller then falls back to replay. Never re-emits `started`.
   *
   * `args.permissions` is authoritative — see `DeliverArgs`.
   */
  deliver(
    ref: HarnessSessionRef,
    message: string,
    args: DeliverArgs,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void>;
  /** Tear the session down. Idempotent; an already-dead session is not an error. */
  stop(ref: HarnessSessionRef): Promise<void>;
  /**
   * OPTIONAL static check of one step's harness option bag, for `owenloop work lint`.
   *
   * `bag` is the step's `x.harness` map with `id` already removed — the same
   * option map `normalizeStepPermissions` receives at prepare time. `step` is the
   * step name, used only to label findings.
   *
   * Optional because linting is a convenience, not part of running an order: an
   * adapter that declares nothing about its option vocabulary simply omits it and
   * `owenloop work lint` reports no findings for steps that select it. An adapter must
   * NOT throw from here — a lint pass over a malformed bag returns findings.
   */
  lintStep?(bag: Record<string, unknown>, step: string): LintFinding[];
  /**
   * OPTIONAL — the command a HUMAN would run to open this session interactively,
   * for `owenloop work sessions` to print.
   *
   * WHY THIS IS ON THE CONTRACT AND NOT IN THE SUBCOMMAND. The resume command is
   * vendor-specific by nature. A `switch (rec.harness)` in `src/roles/sessions.ts`
   * would put vendor BEHAVIOR outside `src/harness/`, which is the one thing the
   * harness layer exists to prevent; `test/vendor-gate.test.ts` would fail such a
   * file, correctly. The harness id in a `SessionRecord` is DATA — the mapping
   * from that data to a command is behavior, and behavior lives here.
   *
   * WHY IT RETURNS `{command, args}` AND NOT A STRING. The caller decides how to
   * render — shell-quoted, tabulated, or as JSON — so no adapter has to guess a
   * display format. An adapter must honour its own binary-override variable here,
   * so an operator who points an execution adapter at a non-default binary gets a command
   * that actually runs on their machine.
   *
   * WHY IT IS NOT PERSISTED IN `SessionRecord`. The session store is
   * deliberately vendor-free (see `DeliverArgs` above), and a rendered string
   * would go stale the moment a vendor changes its CLI.
   *
   * Optional, following `lintStep?`: an adapter with no interactive resume omits
   * it and `owenloop work sessions` prints a dash. An adapter must NOT throw from
   * here — this is display, and a listing that crashes on one row is worse than
   * a row with no command.
   */
  resumeCommand?(ref: HarnessSessionRef): { command: string; args: string[] };
}

/** The `code` every `ResumeUnavailableError` carries. Match on THIS, not on the class. */
export const RESUME_UNAVAILABLE = 'RESUME_UNAVAILABLE';

/**
 * The provider no longer knows the session token — resume is impossible and the
 * caller must fall back to a cold replay.
 *
 * Fields are assigned as class-field initializers / in the constructor body:
 * `erasableSyntaxOnly` is on in this repo, so constructor parameter properties
 * do not compile.
 */
export class ResumeUnavailableError extends Error {
  readonly code: string = RESUME_UNAVAILABLE;

  constructor(message: string) {
    super(message);
    this.name = 'ResumeUnavailableError';
  }
}

/**
 * The supported way to test for a resume failure. Checks the `code` FIELD, not
 * `instanceof`.
 *
 * Reason this is not `instanceof`: tests import from `src/` while the published
 * package resolves `dist/`. Two module instances of this file mean two distinct
 * class objects, and `instanceof` across them silently returns `false` — which
 * would make the resume fallback never fire, in exactly the dual-resolution
 * setup this repo has.
 */
export function isResumeUnavailable(err: unknown): err is ResumeUnavailableError {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === RESUME_UNAVAILABLE;
}
