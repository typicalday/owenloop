/**
 * Shared types for the owenloop engine.
 *
 * The engine is domain-neutral: nothing here knows what a "PR" or a "report"
 * is. A workflow is a graph of steps wired by the artifacts they consume and
 * produce; a step's eligibility to run is a pure function of artifact state.
 * See docs/design.md (a distillation of the dataflow-workflow-engine spec).
 */

/** The six-state artifact lifecycle (design §11.3, extended by §24 judges). */
export type Acceptance =
  | 'owed' // declared-but-unbuilt, or re-armed: a debt the producer must discharge
  | 'green' // accepted; satisfies whoever depends on it
  | 'rejected' // produced then judged unfit (or structurally re-armed): a debt
  | 'retracted' // a consumer dropped a collection member; terminal, out of [*]
  | 'skipped' // a producer declined its own output on a dead branch; settled, re-armable
  | 'submitted'; // built + schema-valid, awaiting judge sign-off (§24); not green, not a producer debt

/** A debt is an artifact a producer owes that is not green. */
export const DEBT_STATES: ReadonlySet<Acceptance> = new Set<Acceptance>(['owed', 'rejected']);
/** Settled-but-not-green states never read as "stuck". */
export const SETTLED_STATES: ReadonlySet<Acceptance> = new Set<Acceptance>([
  'green',
  'retracted',
  'skipped',
]);
/**
 * States that make a workflow "not done" / an artifact "not yet usable" (§24 §4.7).
 * Superset of DEBT_STATES: adds `submitted`, which is not a producer debt (the
 * producer already discharged it) but is also not usable by consumers. Use this
 * set for every "anything outstanding?" question (done-ness, allGreen); keep
 * DEBT_STATES for strictly producer-owed semantics.
 */
export const OUTSTANDING_STATES: ReadonlySet<Acceptance> = new Set<Acceptance>([
  ...DEBT_STATES,
  'submitted',
]);

/** Who/what authored a lifecycle action. */
export type Author = 'engine' | 'human' | string; // a step name, or these specials

/**
 * The kind of an invalidation, for the §6 liveness accounting.
 *  - `judgment`: a consumer's verdict ("fix it") — counts toward the §6 stall.
 *  - `structural`: engine bookkeeping (cascade / born-rejected / re-arm) — does NOT count.
 *  - `validation`: a produced value failed its declared JSON Schema (§19) — counts
 *    toward a *separate* per-artifact stall bounded by the step's `maxSchemaFailures`.
 *  - `invalidated-irreversible`: the artifact was rejected-and-held because its inputs
 *    moved and its producer step declared `effect: { idempotent: false, onInvalidate: 'escalate' }`.
 *    The producer is NOT auto-eligible to re-fire; a human must intervene (retry / fix upstream).
 *  - `question`: the producing step ASKED a human and stopped, via `Engine.ask`.
 *    Holds exactly like `invalidated-irreversible` — the producer is not auto-eligible,
 *    so the step does not spin re-answering its own unanswered question — but it is a
 *    separate kind because the CAUSE is different and the audit trail should say so:
 *    nothing moved upstream, an agent decided it could not proceed honestly.
 *    Counts toward NO stall budget. A question is not a failed attempt.
 */
export type RejectKind =
  | 'judgment'
  | 'structural'
  | 'validation'
  | 'invalidated-irreversible'
  | 'question'
  | 'exclusive';

export type ReasonAction =
  | 'reject'
  | 'retract'
  | 'skip'
  | 'reopen'
  | 'retry'
  | 'ask'
  | 'born-rejected'
  | 'schema-reject'
  | 'pinned';

/** A JSON Schema, as authored in a definition: an object, or a boolean (allow/deny all). */
export type JsonSchema = Record<string, unknown> | boolean;

/** One entry in an artifact's append-only reason thread (design §4). */
export interface ReasonEntry {
  at: number;
  action: ReasonAction;
  kind: RejectKind;
  by: Author;
  text: string;
  /** version the artifact was at when this entry was written (provenance) */
  fromVersion?: number;
  /** Machine-readable correction supplied when rejecting a bound artifact. */
  requested?: string;
}

/**
 * The fingerprint: the version of every consumed input at claim time
 * (design §12.2). A green output stores it so the level-trigger can re-derive
 * "is this still resting on the inputs it was built from?".
 */
export type Fingerprint = Record<string, number>;

/** An artifact node's data payload. */
export interface ArtifactData {
  workflow: string; // workflow-instance uid
  path: string; // provenance path, e.g. "plan" or "gather.source[3]"
  producer: string; // step name that owns (produces) this artifact
  acceptance: Acceptance;
  version: number; // 0 until first green; bumps by 1 on each green (re)production
  value?: Record<string, unknown>; // captured handles (only meaningful when green)
  fingerprint?: Fingerprint; // inputs' versions at build time (on green outputs)
  reasons: ReasonEntry[]; // append-only thread
  judgmentRejects: number; // §6 stall counter — judgment rejects only
  schemaRejects: number; // §19 stall counter — schema-validation rejects only
  /** marks a seal artifact; carries the collection name it seals */
  sealOf?: string;
  /** a green that fired irreversible cleanup cannot be re-armed (design §15.2) */
  terminal?: boolean;
  /** §24 judges: sign-off ledger — judge name → version that judge approved */
  approvals?: Record<string, number>;
}

/** An immutable payload snapshot made whenever an artifact receives a new version. */
export interface ArtifactVersion {
  id: string;
  workflow: string;
  path: string;
  version: number;
  producer: string;
  value?: Record<string, unknown>;
  fingerprint?: Fingerprint;
  initialAcceptance: Acceptance;
  createdAt: number;
}

/** One immutable lifecycle transition for an artifact version (version 0 is valid). */
export interface ArtifactEvent {
  id: string;
  workflow: string;
  path: string;
  version: number;
  action: string;
  actor: Author;
  reason?: string;
  timestamp: number;
  kind?: RejectKind;
  metadata?: Record<string, unknown>;
}

/** Narrow history read used by consumers that open a single artifact. */
export interface ArtifactHistory {
  current: ArtifactData & { id: string; updatedAt: number };
  versions: Array<ArtifactVersion & { events: ArtifactEvent[] }>;
  /** Events associated with version zero, before a payload has been produced. */
  events: ArtifactEvent[];
}

/** A task/lease node — the claimable unit of work-in-flight (design §2.2). */
export interface TaskData {
  workflow: string;
  step: string;
  key: string; // binding identity: "" for plain/reduce/collection, element path for map
  status: 'idle' | 'claimed';
  run?: string; // run uid holding the lease
  claimedAt?: number;
  /** Last heartbeat timestamp (ms epoch). Updated by Engine.heartbeat(). */
  heartbeatAt?: number;
  attempts: number; // reaper strikes (lease churn), distinct from artifact judgmentRejects
  /** Persisted alarm time (ms epoch) for idle evaluator steps. Stored in task row. */
  alarmAt?: number;
}

/** A run node — audit/budget trail, and the holder of a claim's fingerprint. */
/**
 * A reference-mode unit of work emitted by a tick (WP-B1). The order is a
 * REFERENCE packet: `defDigest` identifies the pinned definition snapshot
 * that emitted it, and the authored static instruction bytes (prompt,
 * command, acceptance) ride the resolver boundary instead — see
 * `OrderResolver` in order-resolver.ts. An order NEVER carries authored
 * prompt or command text, nor `owes[].acceptance` (the artifact lifecycle
 * state is dynamic engine state, not channel-1 instructions). It does carry
 * the routing/reference fields, the dynamic consumed input values, and the
 * dynamic rejection feedback. One shape serves both local (`owenloop tick`)
 * and embedded/library callers — there is no verify-mode or legacy branch.
 */
export interface Order {
  run: string;
  workflow: string;
  step: string;
  key: string;
  index?: number;
  /** The digest of the definition snapshot this order was emitted against.
   *  Resolves static instructions through the `(defDigest, step, key)`
   *  boundary; an unknown digest is a named refusal (UnknownDefDigestError). */
  defDigest: string;
  inputs: string[];
  outputs: string[];
  workdir?: string;
  model?: string;
  /** Declares which kind of worker this order is for. Absent = 'agent'
   *  (today's behavior). Opaque to the engine; carried through verbatim from
   *  the authored step's `executor:` field (the YAML grammar is unchanged),
   *  same pass-through contract as `model`/`x`. */
  worker?: string;
  /** The artifact stem this order's judge step is verdicting, when present. */
  judge?: string;
  /**
   * The COMPOSED routing capabilities this order was offered under — the
   * step's authored capabilities each suffixed with the run's modifier
   * (`wise` → `wise:deep`), or the authored names verbatim when the run
   * carries no modifier. Absent when the step authored none.
   *
   * This is the value a claiming crew's bindings are matched against and the
   * value the shift's settings map is keyed by. It is a snapshot of the offer:
   * an already-claimed order is never recomposed, so re-reading it later
   * always shows what the claim was actually judged on.
   *
   * When `reroutedFrom` is present this field holds the REROUTE TARGET, not
   * what the def composed. That is deliberate: this is the capability being
   * served, so it is the one a shift must resolve its model against.
   */
  capabilities?: string[];
  /**
   * Ordered crews the offering side matched for this order's capabilities.
   * Absent when the caller supplied no stamps. Hub → worker, NOT the separate
   * worker → hub `serve_crews` narrowing advertisement.
   */
  crews?: string[];
  /**
   * The composed capabilities this order WOULD have been offered under, present
   * only when a caller-supplied reroute rule substituted something else into
   * `capabilities` above.
   *
   * Absent on every ordinary offer, so its presence is itself the signal that
   * the order is not running on the capability its def asked for. Kept separate
   * from `capabilities` rather than replacing it because both facts are true at
   * once and an operator needs each for a different question: `capabilities`
   * answers "what is serving this", `reroutedFrom` answers "what did we ask
   * for". A single field could only ever answer one.
   */
  reroutedFrom?: string[];
  /**
   * The modifier this order was composed with. Normally the run's modifier;
   * on an escalated re-offer, the step's escalation target instead (the run's
   * own modifier is left alone). Carried separately from `capabilities` so a
   * brief can surface the requested depth without re-parsing a compound.
   */
  modifier?: string;
  /**
   * `true` when `modifier` above is the step's ESCALATION TARGET rather than
   * the run's own modifier — i.e. this offer is a recovery re-offer made
   * after the step's produce accumulated `escalation.after` judgment
   * rejections. Absent on every ordinary offer.
   *
   * The engine decides the transition; this flag is how the decision reaches
   * the layer that acts on it, instead of that layer re-deriving it by
   * diffing `modifier` against the run record. A brief reads it to tell the
   * worker it is on the recovery path.
   *
   * An escalated offer gets NO special wait or fallback treatment. It routes by
   * exactly the same rules as any other offer, because "this run is recovering"
   * is not evidence that its operator wants a lower grade of service — see
   * `wait-policy.ts` in the hub.
   */
  escalated?: true;
  /** Opaque config object for a non-agent/non-command worker type (or
   *  alongside a command). Carried through untouched, contents never read. */
  spec?: Record<string, unknown>;
  /** §27.3: the step's opaque `x:` extension map, carried through untouched
   *  (same pass-through contract as `model`). The engine never reads it —
   *  it exists for the external runner/tooling consuming this order. */
  x?: Record<string, unknown>;
  /** captured handles of the green inputs this run builds on */
  consumes: Record<string, unknown>;
  /**
   * The versions of the consumed inputs captured at claim time. Drivers cover
   * this map in a submission signature instead of recomputing it from values.
   */
  consumedFingerprint?: Fingerprint;
  /** the owed outputs and their accumulated reason threads (the feedback channel) */
  owes: Array<{
    path: string;
    /** The target version this claim's next successful producer commit lands
     *  (committed version + 1), issued by the engine inside the claim
     *  transaction. This is the version a producer signs in a submission
     *  proof and a downstream consumer checks it against. Absent when the hub
     *  is not version-aware, which leaves the producer submit unsigned. */
    version?: number;
    judgmentRejects: number;
    schemaRejects: number;
    reasons: ReasonEntry[];
    /**
     * The JSON Schema the engine will enforce on this output at commit time,
     * copied verbatim off the owning produce entry. Absent when that produce
     * declares none — the common case, and the engine then accepts any JSON.
     *
     * WHY IT IS ON THE ORDER. `schemaRejects` and the `'schema'` reason entries
     * already travel here, so a producer is told AFTER the fact that the shape
     * it submitted was wrong, and told the cap it is burning down. It was never
     * told the shape. A re-offered agent reading "your last submission failed
     * its schema" has the same information it had the first time and no more,
     * which is why the same malformed shape gets resubmitted until the counter
     * stalls the step. This closes that: the requirement is stated up front,
     * from the same declaration the refusal will be measured against.
     *
     * It is a COPY, not a reference. The order is immutable once written
     * (`RunData.order`), so this is the schema as it stood at claim time; a def
     * edited mid-run leaves the projected schema and the enforced one able to
     * disagree, exactly as `defDigest` already records for the rest of the
     * order.
     */
    schema?: JsonSchema;
    /**
     * What `schema` governs. Present exactly when `schema` is.
     *
     * - `'value'` — the submitted value itself. Singleton produces, and one
     *   element of a map produce.
     * - `'member'` — EACH member emitted into this collection. NOT the seal
     *   value at the path this entry names. A collection's owed path is its
     *   seal (`model.ts` `plainOutputs` pushes `sealPath(stem)`), while the
     *   declared schema is checked per member on `emit`, so projecting it
     *   without this discriminator would tell a producer to shape the seal
     *   like a member.
     */
    schemaAppliesTo?: 'value' | 'member';
    /** Opaque proof/signature placeholder for future WP-A4-signed reason
     *  threads. Data-only today: no cryptographic code attaches or verifies
     *  it — the slot exists so signed dynamic data can land without changing
     *  the reference-mode wire shape. */
    proof?: string;
  }>;
  /** Opaque proof/signature placeholder for future WP-A4-signed dynamic
   *  consume values. Data-only today — same contract as `owes[].proof`. */
  consumesProof?: string;
  /** The trigger that woke this firing (§21). Absent = 'inputsGreen'. */
  cause?: FiringTrigger;
}

export interface RunData {
  workflow: string;
  step: string;
  key?: string; // binding key of the claimed firing ("" for plain/reduce)
  outcome?: 'ok' | 'no_work' | 'failed' | 'skipped';
  summary?: string;
  sessionId?: string;
  /** the version of every consumed input at claim time (§12.2 commit CAS) */
  fingerprint?: Fingerprint;
  /** The firing trigger that woke this run (§21). Absent = 'inputsGreen'. */
  cause?: FiringTrigger;
  /** The flattened order packet issued at claim time (§8 / Gap 1) — the exact
   *  Order buildOrder emitted, written in the SAME transaction that created
   *  this run. Immutable after insert: updateRun never touches it. The
   *  replay/eval/paper-trail record (buildOrder is deterministic modulo run
   *  id). Absent on runs created before schema v7. */
  order?: Order;
}

export interface WorkflowData {
  def: string; // definition name
  title?: string;
  params?: Record<string, string>;
  /**
   * The ONE modifier this run carries, validated against the def's declared
   * `modifiers` set when the run is created and immutable thereafter — no
   * step, worker or judge can write it (only `start_run` sets it; escalation
   * overrides it per-offer without changing it here).
   *
   * Absent = an unmodified run: every step is offered on bare capabilities.
   * Deletes with the run, like the rest of the row.
   */
  modifier?: string;
  /** Engine-written, non-routing metadata populated by artifact binds. */
  meta?: Record<string, unknown>;
  /** Instance-to-definition pinning (§28): the compiled def this instance was
   *  created against, snapshotted verbatim as JSON. Absent on rows created
   *  before this feature shipped — those instances fall back to today's
   *  name-resolution behavior (see Engine.defFor). */
  defSnapshot?: WorkflowDef;
  /** Content hash of `defSnapshot` at the time it was stamped (or last
   *  re-pinned via `adopt`). Absent iff `defSnapshot` is absent. */
  defHash?: string;
}

// ---- workflow definitions ----------------------------------------------------

export type ConsumeMode = 'plain' | 'map' | 'reduce';

/** A parsed consume pattern. */
export interface ConsumePattern {
  raw: string;
  mode: ConsumeMode;
  stem: string; // collection/name stem
  binder?: string; // for map: the binder variable name (e.g. "i")
  suffix: string; // text after the index token (e.g. ".formatcheck"), "" if none
}

export type ProduceKind = 'singleton' | 'collection' | 'map';

export type GroupMode = 'exactlyOne' | 'atMostOne' | 'atLeastOne';

/**
 * §26 declarative exclusive produce-groups: a step-level (not stem-level)
 * `produces:` entry naming a set of sibling singleton stems (`of:`) and the
 * commit-exclusivity contract (`mode:`) the engine enforces across them:
 *   - 'exactlyOne'  — exactly one member may ever be green; the engine refuses
 *                      a second commit and auto-skips the untouched siblings
 *                      once the first winner lands.
 *   - 'atMostOne'   — same refusal/auto-skip behaviour, but zero winners is a
 *                      legal end state too (no member ever commits).
 *   - 'atLeastOne'  — no commit-time refusal; `workflowStatus`/the checker
 *                      simply stop counting the other members as outstanding
 *                      once one member is green.
 * Lives alongside a step's `produces` list (not nested in a `ProducePattern`)
 * because a group spans multiple stems.
 */
export interface GroupDef {
  group: string;
  mode: GroupMode;
  of: string[];
}

/** A normalized artifact-to-instance routing write declared on a produce. */
export interface ArtifactBind {
  to: string;
  from: string;
}

/** A parsed produce declaration. */
export interface ProducePattern {
  raw: string;
  kind: ProduceKind;
  stem: string;
  binder?: string; // for map outputs: binder name
  suffix: string;
  /** optional JSON Schema the produced value must satisfy at commit time (§19) */
  schema?: JsonSchema;
  /** Optional normalized artifact-to-instance write applied on acceptance. */
  bind?: ArtifactBind;
  /** §6/§18 per-produce override of the step's maxAttempts (judgment-reject
   *  stall cap). Falls back to the owning step's maxAttempts when absent —
   *  see model.ts effectiveMaxAttempts(). Only meaningful on {name,...}
   *  produces (not group: declarations, which don't produce a ProducePattern
   *  at all). */
  maxAttempts?: number;
  /** §6/§18 per-produce override of the step's maxSchemaFailures. Same
   *  fallback rule as maxAttempts. */
  maxSchemaFailures?: number;
  /**
   * §24 judges: optional quality gate(s) on this produce entry. v1: singleton
   * produces only (validateDef hard-errors otherwise). Each entry is resolved
   * (bodyFile read eagerly) into a plain `body` at parse time — no `bodyFile`
   * on the parsed shape, mirroring StepDef.
   */
  judges?: Array<{
    name: string;
    body: string;
    model?: string;
    inputs?: boolean; // default false: judge sees only the judged value
    cadence?: string;
    maxRunsPerDay?: number;
    /** Declares which kind of executor this judge's synthesized order is for.
     *  Same opaque-passthrough contract as StepDef.executor — default 'agent'
     *  when omitted. */
    executor?: string;
    /** Required when executor is 'command'; the command string for that executor
     *  to run. Opaque to the engine — never parsed, never shelled out. */
    command?: string;
    /** Optional opaque config object for a non-agent/non-command executor type
     *  (or additionally alongside `command`). Shape-checked as a plain map
     *  only (mirrors `x:`'s asExtension contract) — contents never read. */
    spec?: Record<string, unknown>;
    /** Routing capabilities for this judge's synthesized step. Omitted =
     *  INHERIT the producing step's `capabilities`, so a judge routes to the
     *  same grade of crew as the work it judges instead of being claimable by
     *  anyone. Set explicitly to route a judge somewhere else; an explicit
     *  empty list is not accepted (it would reopen the def-silent hole
     *  deliberately, which no author means to do). */
    capabilities?: string[];
  }>;
}

/**
 * A step-level trigger token that controls when the step is eligible to fire.
 * - 'inputsGreen' (default) — classic behaviour: fire when consumed inputs are green.
 * - 'allGreen' — fire when the workflow is all-green (no debts among non-evaluator artifacts).
 * - 'idle' — fire when the workflow is quiescent past the idleAfter threshold (§21.8).
 */
export type FiringTrigger = 'inputsGreen' | 'allGreen' | 'idle';

/**
 * Declared per-step effect contract (design §6.5). Controls forward-cascade routing
 * when the step's green artifact's inputs move to a new version.
 */
export interface EffectDef {
  /** If true (default), re-deriving the artifact after inputs move is safe.
   *  When false, the artifact must not silently re-fire. */
  idempotent?: boolean;
  /** Routing when idempotent:false and an input moves.
   *  'pin'        — keep the artifact green, re-point fingerprint to current inputs.
   *  'escalate'   — reject the artifact as held; producer not auto-re-eligible.
   *  '<stepName>' — pin the original AND arm the named handler step (D-A/D-B).
   *  Defaults to 'escalate' when idempotent:false and omitted. */
  onInvalidate?: 'pin' | 'escalate' | string;
}

/** A step (step) definition. */
/**
 * A step's escalation rule (def-authored, engine-applied).
 *
 * There is NO rung order anywhere in this system — `modifier` is an explicit
 * target drawn from the def's declared `modifiers` set, never "the next one
 * up". Escalation therefore cannot be expressed as arithmetic on a ladder, and
 * nothing here is comparable to anything else.
 *
 * `after` must be strictly less than the effective `maxAttempts` of every
 * produce on the owning step. At `judgmentRejects >= maxAttempts` the engine
 * freezes the artifact (`model.ts` `isStalled`), so an escalation authored at
 * or past that threshold would re-offer a step that can never run again —
 * deterministically dead. `validateDef` rejects it rather than accepting a
 * rule that silently does nothing.
 */
export interface EscalationDef {
  /** Judgment-reject count that triggers the escalated re-offer. */
  after: number;
  /** Target modifier, a member of the def's declared `modifiers` set. */
  modifier: string;
}

export interface StepDef {
  name: string;
  /** Inputs this step reads — and, by the same declaration, the artifacts it has
   *  authority to judgment-`reject` (§4.1). Consuming is dual-purpose: it gates and
   *  fingerprints the step's firing (§3/§7) AND confers the right to send that
   *  artifact back. To let a step invalidate an artifact, make it consume that
   *  artifact — even when the step only *judges* the artifact (e.g. the merger
   *  consuming `pr` to judge its mergeability) rather than transforming it. */
  consumes: ConsumePattern[];
  produces: ProducePattern[];
  /** Artifacts this step generates that are intentionally NOT consumed downstream.
   *  Lint-exempt from dead-end warnings. Unioned into `produces` at def-build time. */
  generates?: ProducePattern[];
  /** input names this step has authority to invalidate (defaults to its consumed stems) */
  invalidates: string[];
  cadence: string; // e.g. "30m"
  cadenceSecs: number;
  maxRunsPerDay: number;
  parallel: number;
  /** §6/§18: judgment-reject stall cap. This is the step-level DEFAULT for
   *  this step's produces — an individual produce may override it via
   *  ProducePattern.maxAttempts (see model.ts effectiveMaxAttempts()). */
  maxAttempts: number;
  /** §19: how many schema-validation failures an output may accrue before it
   *  stalls. Step-level DEFAULT for this step's produces — an individual
   *  produce may override it via ProducePattern.maxSchemaFailures (see
   *  model.ts effectiveMaxSchemaFailures()). */
  maxSchemaFailures: number;
  model?: string;
  /** Declares which kind of executor this step's order is for. Default
   *  'agent' when omitted (today's behavior — every existing def is
   *  unchanged). Opaque to the engine beyond the shape rules validateDef
   *  enforces; carried through verbatim on the Order, same contract as
   *  `model`. */
  executor?: string;
  /** Required when executor is 'command'; the command string for that executor
   *  to run. Opaque to the engine — never parsed, never shelled out. */
  command?: string;
  /** Optional opaque config object for a non-agent/non-command executor type
   *  (or additionally alongside `command`). Shape-checked as a plain map
   *  only (mirrors `x:`'s asExtension contract) — contents never read. */
  spec?: Record<string, unknown>;
  /** opaque location hint passed through on the order; no default — absent unless the def sets it */
  workdir?: string;
  /**
   * Resolve the order's workdir from `<consumedStem>.<dotted.path>` in a consumed
   * artifact value. Mutually exclusive with workdir; the stem must be a plain
   * consume so the value passes the engine's consume-side verification gate.
   */
  workdirFrom?: string;
  /** the step's output is a destructive completion (e.g. a merge): green is terminal (§15.2) */
  terminal?: boolean;
  /** Step-level effect contract (§6.5). Only consulted for non-terminal greens whose inputs move. */
  effect?: EffectDef;
  /** Step-level firing trigger (§21). Omitted = ['inputsGreen'] (default behaviour). */
  on?: FiringTrigger[];
  /** Duration string for the idle threshold (e.g. "30m"). Required when 'idle' is in on:. */
  idleAfter?: string;
  /** Parsed idleAfter in milliseconds. */
  idleAfterMs?: number;
  /** Per-step reap TTL override in milliseconds. Falls back to the engine's DEFAULT_REAP_TTL_MS. */
  reapTtlMs?: number;
  /** A2: opaque routing capabilities for peer-orchestrator claim filtering. A tick
   *  caller passing a capability filter only claims steps whose capabilities intersect it;
   *  absent (or empty, normalized to absent at parse) = claimable by any caller.
   *  Distinct from `executor`/`executors` (executor-kind), which this never touches.
   *
   *  AUTHORED NAMES ONLY — never a compound. A `:` is rejected at parse
   *  (`buildStep`) because the suffix position is engine-owned: the engine
   *  composes `<capability>:<modifier>` at offer time (see
   *  `WorkflowDef.modifiers` and `Order.capabilities`). */
  capabilities?: string[];
  /** Per-step escalation rule: after `after` judgment rejections of this
   *  step's produced artifact, the engine re-offers THIS step composed with
   *  `modifier` instead of the run's modifier. Step-scoped — the run's own
   *  modifier is never changed. Absent = the step never escalates and
   *  rejections run the normal retry path until the stall brake. */
  escalation?: EscalationDef;
  /** A3 (REL-8): per-step OPT-IN max total lease lifetime override in
   *  milliseconds — the cap on `claimedAt + maxLease` past which renewals can no
   *  longer keep a lease fresh. Overrides the engine `maxLeaseMs`; when both are
   *  unset there is NO cap and heartbeats extend the lease indefinitely. */
  maxLeaseMs?: number;
  body: string; // prompt body
  /** Mode 2 foundation: name of the child workflow this step delegates to. Machine-handled, never a worker firing. */
  calls?: string;
  /** Mode 2 foundation: child input name → parent artifact name wiring for a calls: step. */
  callsInputs?: Record<string, string>;
  /** §24 judges: marker naming the produce stem this synthesized step judges. Mirrors `calls?`. */
  judges?: string;
  /** §26: declarative exclusive produce-groups spanning two or more of this step's own produces. */
  groups?: GroupDef[];
  /** §27.3: opaque step-level extension map (`x:`). Validated as a plain map at
   *  load time, never interpreted by the engine — carried untouched through
   *  `buildOrder` onto the Order for an external runner/tooling to read. */
  x?: Record<string, unknown>;
}

/** A workflow definition: a set of steps plus declared external inputs. */
export interface WorkflowDef {
  name: string;
  /** Declared engine-version contract (§26). Must be a positive integer no
   *  greater than SUPPORTED_ENGINE_VERSION (defs.ts) at load time (forward-
   *  compatible: any def requesting a version at or below the running
   *  binary's supported version loads unchanged); populated by buildDef so
   *  every WorkflowDef in memory carries a definite, already-checked version. */
  engine: number;
  title?: string;
  description?: string;
  /** external inputs seeded as artifacts when an instance starts (e.g. "proposal") */
  inputs: InputDef[];
  /**
   * Fully-expanded step list. Raw YAML may contain `include:` directives (Mode 1, §22)
   * that are expanded at load time by `expandIncludes`; the engine always sees a flat list.
   */
  steps: StepDef[];
  /**
   * The def's declared modifier vocabulary — an UNORDERED SET of plain names
   * (e.g. `[express, standard, deep]`). The engine attaches no meaning, no
   * order and no arithmetic to these values; it only checks membership.
   *
   * A run may carry ONE of them (`WorkflowData.modifier`, set at start and
   * never changed afterwards). At offer time the engine composes each of a
   * step's capabilities with it — `wise` + `deep` → `wise:deep` — and that
   * compound is what a crew binding is matched against.
   *
   * Absent = this def cannot receive a modifier at all, and every step is
   * offered on its bare capabilities exactly as before this feature existed.
   */
  modifiers?: string[];
  /** Workflow-level public outputs / embedding interface (design doc §5.2).
   *  Declared stems are intentional leaves: lint-exempt from dead-end warnings.
   *  A stem listed here that no step produces is a hard validateDef error. */
  outputs?: string[];
  dir?: string; // source directory, if loaded from disk
  /** Declared safety invariants verified by `modelCheck`/`owenloop check`. */
  invariants?: InvariantDef[];
  /** §27.3: opaque workflow-level extension map (`x:`). Validated as a plain
   *  map at load time, never interpreted by the engine. */
  x?: Record<string, unknown>;
  /** Optional allow-list of executor values; when present, validateDef errors
   *  on any step/judge whose `executor` is not in this list (typo guard).
   *  Absent = any executor string accepted. */
  executors?: string[];
  /**
   * @internal Mode 1 include directives before expansion. Set by `buildDef` when a
   * step-list entry has an `include:` key. Consumed and removed by `expandIncludes`.
   * Never visible to the engine; always undefined on a fully-expanded def.
   */
  _includes?: Array<{ pos: number; defName: string; as: string; inputs: Record<string, string> }>;
  /**
   * @internal WS-6 CAS provenance: the `package.name` of the installed bundle
   * this def was loaded from (the namespace half of its coordinate). Set ONLY by
   * the content-addressed-store def loader (`loadCasDefs`); always `undefined`
   * for a def scanned off the filesystem or handed to `createEngine({ defs })`.
   * Read by the scope-aware `DefResolver` to build the qualified key
   * `<bundlePackage>/<name>`.
   */
  bundlePackage?: string;
  /**
   * @internal WS-6 CAS provenance: the canonical BUNDLE digest (lowercase
   * 64-hex SHA-256 over the uncompressed canonical tar) of the store object this
   * def was loaded from. NOT a `defInstructionDigest` (which projects ONE
   * definition) and NOT a `hashDef` (a 16-hex whole-def drift hash) — one bundle
   * digest covers every workflow in that bundle. Two defs are siblings exactly
   * when their `bundleDigest` values are equal, which is the pin a bare `calls:`
   * between them is checked against at spawn (`provisionCallsChild`); the v2
   * bundle format carries no per-workflow digest to check instead.
   */
  bundleDigest?: string;
  /**
   * @internal WS-6 CAS provenance: a COPY of the containing bundle manifest's
   * `lock` map (explicit `namespace/name@version` reference text → the canonical
   * bundle digest that reference is pinned to). Carried on the def so the
   * engine's spawn-time pin check is a pure in-memory comparison and never
   * performs filesystem I/O inside the SQLite write transaction that creates the
   * child. Set only by `loadCasDefs`; `undefined` everywhere else. Bare
   * (same-bundle) `calls:` targets never appear here — `assertLockCoverage`
   * requires lock entries only for the explicit versioned form, and a sibling's
   * pin is its containing bundle's own digest.
   */
  bundleLock?: Record<string, string>;
}

export interface InputDef {
  name: string;
  /** who provides it: a human (pulled) or it is provided at start */
  producer: string; // "human" by convention, or any external provider name
  /** if true, instance start leaves it owed; otherwise it must be provided at start */
  seedOwed: boolean;
  /** optional JSON Schema a provided input value must satisfy (§19) */
  schema?: JsonSchema;
}

// ---- trace types (§18 derived view: temporal causal timeline) ----------------

/**
 * One chronological event in the workflow's execution history: a single run
 * from claim to close. The causal links (consumedInputs, producedStems) are
 * derived from the run's fingerprint and the workflow definition respectively.
 *
 * NOTE on causality: `producedStems` is structural (from the def) — we know
 * which stems this step is responsible for, but there is no stored FK linking
 * a specific run to the artifact version it produced. `consumedInputs` is from
 * the run's fingerprint (what versions of inputs were live at claim time) —
 * this IS a stored fact. The causal edge "run R produced version N of stem S"
 * is an inference, not a guarantee; see WorkflowTrace.inferenceNote.
 */
export interface TimelineEvent {
  seq: number;               // 1-based sequence number, stable across renders
  at: number;                // run.createdAt (ms since epoch)
  endedAt: number;           // run.updatedAt (ms since epoch, last mutation)
  step: string;              // step name
  key: string;               // binding key ("" for plain/reduce, element path for map)
  outcome: string | undefined; // 'ok' | 'no_work' | 'failed' | 'skipped' | undefined (open)
  summary: string | undefined;
  sessionId: string | undefined;
  /**
   * The versions of consumed inputs at claim time (run.fingerprint).
   * Absent if the run was claimed without a fingerprint (should not happen in
   * normal operation, but open/zero-output runs may lack one).
   */
  consumedInputs: Fingerprint | undefined;
  /**
   * The stems this step is declared to produce (from the def), not from a
   * stored link. For map steps this is the map pattern stem (e.g.
   * "gather.source[$i].formatcheck"); for collection producers it is the
   * collection stem (e.g. "gather.source"); for singletons it is the stem name.
   * This is structural, not temporal — it tells you what the step *could*
   * produce, not which version it produced in this specific run.
   */
  producedStems: string[];
}

/** The lifecycle biography of one artifact: its current state + full event thread. */
export interface ArtifactBiography {
  path: string;
  producer: string;          // step name
  terminal: boolean;
  acceptance: Acceptance;
  version: number;
  judgmentRejects: number;
  schemaRejects: number;
  /**
   * The artifact's append-only reason thread, already in chronological order
   * (each entry was appended at action time; the array is authoritative).
   * Contains every reject/retract/skip/reopen/retry/born-rejected/schema-reject
   * that touched this artifact, across all versions.
   */
  events: ReasonEntry[];
  /** §24: per-version sign-off ledger (judge name -> approved version), if any judges are declared. */
  approvals?: Record<string, number>;
}

/** The full derived trace for one workflow instance. */
export interface WorkflowTrace {
  workflow: string;
  /**
   * Chronological firing log, ordered by run.createdAt then rowid-stable
   * insertion order (no two rows with the same createdAt should exist in
   * practice, but the sort is stable: the secondary tiebreak is the run id,
   * which is a random string — this gives a deterministic ordering even in
   * test environments where nowMs() does not advance between insertions).
   */
  timeline: TimelineEvent[];
  /** One biography per artifact, ordered by path. */
  artifacts: ArtifactBiography[];
  summary: {
    totalRuns: number;
    byOutcome: Record<string, number>; // 'ok'|'no_work'|'failed'|'skipped'|'open' → count
    totalRejects: number;              // sum of all reasons with action 'reject'|'born-rejected'|'schema-reject' across all artifacts
    totalRetries: number;              // sum of all reasons with action 'retry' across all artifacts
    stalledArtifacts: string[];        // paths of artifacts that are currently stalled (acceptance=rejected AND judgmentRejects≥producer.maxAttempts OR schemaRejects≥producer.maxSchemaFailures)
    done: boolean;                     // reuses workflowStatus(def, arts).done
  };
  /**
   * Honest representation of the inference gap: a green run does not append a
   * ReasonEntry and there is no stored produced_by_run FK. The causal edge
   * "run R produced version N of artifact A" is inferred by matching:
   *   - the step that produced A (from A.producer = run.step)
   *   - ordered by run.createdAt — the Nth 'ok' run of step L is the likely
   *     producer of version N of that step's output
   * This is a heuristic and not guaranteed to be correct in the presence of
   * concurrent processes or clock skew. Do not rely on it for correctness
   * decisions; it is provided only for human readability.
   */
  inferenceNote: string;
}

// ---- graph types (§spatial view: wiring + live-state overlay) ----------------

/** The "color" of a node in a live-overlay graph. Derived from artifact acceptance + stall state. */
export type GraphNodeState =
  | 'green'      // all outputs are green
  | 'owed'       // at least one output is owed (in-flight or unbuilt)
  | 'rejected'   // at least one rejected, none stalled
  | 'stalled'    // at least one rejected AND past its producer cap
  | 'skipped'    // all outputs are skipped (dead branch)
  | 'retracted'  // all outputs are retracted
  | 'submitted'  // at least one submitted (awaiting judge sign-off), none owed/rejected/stalled
  | 'none';      // no artifact data (static view or no artifacts yet)

/** One node in the wiring graph: either a step or an external input. */
export interface GraphNode {
  id: string;              // stable identifier: step name or input name
  kind: 'step' | 'input';
  label: string;              // display label (same as id for now)
  terminal?: boolean;      // steps only: declared terminal
  parallel?: number;       // steps only: parallelism setting
  model?: string;          // steps only: model hint
  /** Overlay: present only when artifacts were supplied to buildGraph */
  state?: GraphNodeState;
  /** Overlay: true when any output artifact is stalled */
  stalled?: boolean;
}

/** One directed edge: producer → consumer. */
export interface GraphEdge {
  from: string;            // node id (step name or input name)
  to: string;              // step node id
  stem: string;            // the artifact stem crossing this edge
  mode: 'plain' | 'map' | 'reduce'; // consume mode at the to-node
  /** For map: the binder name (e.g. "i") — used for label generation */
  binder?: string;
  /** For reduce: the suffix, if any (e.g. ".child") — used for label generation */
  suffix?: string;
}

/** The complete wiring graph for one workflow definition. */
export interface WorkflowGraph {
  def: string;             // workflow definition name
  nodes: GraphNode[];      // sorted by id for determinism
  edges: GraphEdge[];      // sorted by (from, to, stem) for determinism
  /** true when artifacts were provided (overlay mode) */
  hasOverlay: boolean;
}

// ---- model-checker types (§check) -------------------------------------------

/** One step on a BFS path: a step fired, on which key, with which outcome. */
export interface CheckStep {
  step: string;
  key: string;      // "" for plain/reduce; element path for map
  outcome:
    | 'green' | 'judgment-reject' | 'schema-reject' | 'skip' | 'retract' | 'emit-seal'
    // §24: outcomes for a synthesized judge step's own firing (against the judged stem)
    | 'judge-approve' | 'judge-reject'
    // §26: a commit refused because it would violate its group's exactlyOne/atMostOne contract
    | 'group-reject';
}

/** A finding with its shortest witness path from the initial state. */
export interface CheckFinding {
  path: CheckStep[];
}

/** Options for modelCheck — all optional; sane defaults apply. */
export interface CheckOptions {
  maxDepth?: number;         // default 50
  maxStates?: number;        // default 5000
  maxCollectionSize?: number; // default 2 — max members when fan-out from an emit
  /**
   * Seed `seedOwed: true` inputs green, as if `provide` already ran. The checker
   * has no runtime provide values, so without this every seedOwed input starts
   * owed with no transition that can green it — a def whose inputs the operator
   * supplies at create time reports a false depth-0 deadlock. Default (this
   * field, when calling `modelCheck` directly) is false — that library default
   * is unchanged. The `owenloop check` CLI command, however, now defaults this
   * to true (seedOwed inputs are assumed provided by default, modeling the
   * operator's `provide` at create); its `--strict-inputs` flag opts back out
   * to false, restoring the seedOwed-starts-owed behavior described above.
   */
  assumeProvided?: boolean;
}

/** The structured report produced by modelCheck. */
export interface CheckReport {
  def: string;
  /** True when any BFS bound was hit — verdicts are "within bounds", not global. */
  bounded: boolean;
  /** Which bounds were hit, for honest reporting. */
  boundsHit: ('maxDepth' | 'maxStates')[];
  /**
   * Reachable non-done states with zero eligible firings that have NO path to
   * completion even at unlimited attempts — i.e. recomputing eligibility with
   * all freezes lifted (a human `retry` = unlimited attempts) STILL yields
   * zero firings. A genuine structural dead-end (TRUE deadlock). A definite
   * defect only when the search was exhaustive (`!bounded`) — the
   * maxCollectionSize cap can otherwise manufacture a spurious no-moves
   * state. Always present ([] when none).
   */
  deadlocks: CheckFinding[];
  /**
   * Reachable non-done states with zero eligible firings whose ONLY blocker
   * is a frozen/stalled debt (maxAttempts / maxSchemaFailures / held).
   * Recomputing eligibility with all freezes lifted (a human `retry` =
   * unlimited attempts) yields >= 1 firing, so a producer would re-arm and
   * the line could move. These are the DESIGNED human-escalation brakes —
   * EXPECTED, never a defect; they do not affect the exit code. Always
   * present ([] when none).
   */
  stallStates: CheckFinding[];
  /**
   * Reachable states that have a stalled debt (maxAttempts/maxSchemaFailures/
   * held) BUT still have >= 1 eligible firing — a brake tripped on one branch
   * while the line can still move on another. Informational; NOT a defect on
   * its own. A no-moves state whose only blocker is a frozen debt is recorded
   * under `stallStates` instead, never here — so no state appears in both
   * `stuck` and `stallStates`/`deadlocks`.
   */
  stuck: CheckFinding[];
  /** Whether any explored state is done, and (when true) one example path to it. */
  completable: boolean;
  completePath?: CheckStep[];
  /**
   * Step names that never appear as the firing step in any explored transition,
   * AND a static "can this step ever fire?" check (independent of bounds) is
   * CERTAIN no firing can ever be pushed for it (see model.ts `canEverFire`).
   * A genuine wiring defect — always present ([] when none), and (unlike
   * `unreachedSteps`) ALWAYS a definite finding regardless of `bounded`,
   * because the check needs no search bounds to be certain.
   */
  structurallyDeadSteps: string[];
  /**
   * Step names that never appear as the firing step in any explored transition,
   * but the static `canEverFire` check says they COULD fire in principle — the
   * bounded search just didn't reach them before exhausting `--max-states`/
   * `--max-depth`. Informational only, NOT a defect: a bounds artifact. Raising
   * the search bounds may make the step fire. Always present ([] when none).
   */
  unreachedSteps: string[];
  /**
   * Invariants that are violated in some reachable state. Always present ([]
   * when no invariants declared or none violated). Each entry is deduplicated by
   * invariant name — BFS guarantees the stored path is the shortest counterexample.
   */
  invariantViolations: InvariantViolation[];
  /** Metadata about the search. */
  stats: {
    statesExplored: number;
    depthReached: number;
  };
}

// ---- invariant types ---------------------------------------------------------

/**
 * A structured, total, recursive predicate over artifact state. Exactly one
 * discriminant key is present per object.
 *
 * Safety properties only — no liveness / temporal operators. The bounded BFS
 * soundly finds safety VIOLATIONS (a reachable witness) but cannot prove
 * liveness; the existing `completable` covers "a done state is reachable".
 */
export type InvariantPredicate =
  | { path: string; is: Acceptance | 'present' | 'absent' }  // atom: artifact state / presence
  | { state: 'done' }                                          // true iff workflow is done
  | { all: InvariantPredicate[] }                              // conjunction (AND)
  | { any: InvariantPredicate[] }                              // disjunction (OR)
  | { not: InvariantPredicate };                               // negation

/**
 * One declared safety invariant. Semantics: "in every reachable state,
 * `when` (default TRUE) implies `requires`". A state VIOLATES the invariant
 * iff eval(when ?? TRUE) && !eval(requires).
 */
export interface InvariantDef {
  name: string;
  description?: string;
  /** Activation guard. Omitted = always active (TRUE). */
  when?: InvariantPredicate;
  /** The property that must hold whenever `when` is true. */
  requires: InvariantPredicate;
}

/**
 * A counterexample: the invariant name + the shortest BFS path from the seed
 * state to a state that violates the invariant. The path is a real executable
 * witness — each step was produced by applyOutcome/settleInMemory, the same
 * transitions the conformance test pins to the live Engine.
 */
export interface InvariantViolation {
  /** The `InvariantDef.name` of the violated invariant. */
  invariant: string;
  /** Shortest BFS path of firings from the seed state to the violating state. */
  path: CheckStep[];
}
