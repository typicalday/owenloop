/**
 * Shared types for the oweflow engine.
 *
 * The engine is domain-neutral: nothing here knows what a "PR" or a "report"
 * is. A workflow is a graph of loops wired by the artifacts they consume and
 * produce; a step's eligibility to run is a pure function of artifact state.
 * See docs/design.md (a distillation of the dataflow-workflow-engine spec).
 */

/** The five-state artifact lifecycle (design §11.3). */
export type Acceptance =
  | 'owed' // declared-but-unbuilt, or re-armed: a debt the producer must discharge
  | 'green' // accepted; satisfies whoever depends on it
  | 'rejected' // produced then judged unfit (or structurally re-armed): a debt
  | 'retracted' // a consumer dropped a collection member; terminal, out of [*]
  | 'skipped'; // a producer declined its own output on a dead branch; settled, re-armable

/** A debt is an artifact a producer owes that is not green. */
export const DEBT_STATES: ReadonlySet<Acceptance> = new Set<Acceptance>(['owed', 'rejected']);
/** Settled-but-not-green states never read as "stuck". */
export const SETTLED_STATES: ReadonlySet<Acceptance> = new Set<Acceptance>([
  'green',
  'retracted',
  'skipped',
]);

/** Who/what authored a lifecycle action. */
export type Author = 'engine' | 'human' | string; // a loop name, or these specials

/**
 * The kind of an invalidation, for the §6 liveness accounting.
 *  - `judgment`: a consumer's verdict ("fix it") — counts toward the §6 stall.
 *  - `structural`: engine bookkeeping (cascade / born-rejected / re-arm) — does NOT count.
 *  - `validation`: a produced value failed its declared JSON Schema (§19) — counts
 *    toward a *separate* per-artifact stall bounded by the loop's `maxSchemaFailures`.
 *  - `invalidated-irreversible`: the artifact was rejected-and-held because its inputs
 *    moved and its producer loop declared `effect: { idempotent: false, onInvalidate: 'escalate' }`.
 *    The producer is NOT auto-eligible to re-fire; a human must intervene (retry / fix upstream).
 */
export type RejectKind = 'judgment' | 'structural' | 'validation' | 'invalidated-irreversible';

export type ReasonAction =
  | 'reject'
  | 'retract'
  | 'skip'
  | 'reopen'
  | 'retry'
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
  producer: string; // loop name that owns (produces) this artifact
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
}

/** A task/lease node — the claimable unit of work-in-flight (design §2.2). */
export interface TaskData {
  workflow: string;
  loop: string;
  key: string; // binding identity: "" for plain/reduce/collection, element path for map
  status: 'idle' | 'claimed';
  run?: string; // run uid holding the lease
  claimedAt?: number;
  attempts: number; // reaper strikes (lease churn), distinct from artifact judgmentRejects
  /** Persisted alarm time (ms epoch) for idle evaluator loops. Stored in task row. */
  alarmAt?: number;
}

/** A run node — audit/budget trail, and the holder of a claim's fingerprint. */
export interface RunData {
  workflow: string;
  loop: string;
  key?: string; // binding key of the claimed firing ("" for plain/reduce)
  outcome?: 'ok' | 'no_work' | 'failed' | 'skipped';
  summary?: string;
  sessionId?: string;
  /** the version of every consumed input at claim time (§12.2 commit CAS) */
  fingerprint?: Fingerprint;
  /** The firing trigger that woke this run (§21). Absent = 'inputsGreen'. */
  cause?: FiringTrigger;
}

export interface WorkflowData {
  def: string; // definition name
  title?: string;
  params?: Record<string, string>;
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

/** A parsed produce declaration. */
export interface ProducePattern {
  raw: string;
  kind: ProduceKind;
  stem: string;
  binder?: string; // for map outputs: binder name
  suffix: string;
  /** optional JSON Schema the produced value must satisfy at commit time (§19) */
  schema?: JsonSchema;
}

/**
 * A loop-level trigger token that controls when the loop is eligible to fire.
 * - 'inputsGreen' (default) — classic behaviour: fire when consumed inputs are green.
 * - 'allGreen' — fire when the workflow is all-green (no debts among non-evaluator artifacts).
 * - 'idle' — fire when the workflow is quiescent past the idleAfter threshold (§21.8).
 */
export type FiringTrigger = 'inputsGreen' | 'allGreen' | 'idle';

/**
 * Declared per-loop effect contract (design §6.5). Controls forward-cascade routing
 * when the loop's green artifact's inputs move to a new version.
 */
export interface EffectDef {
  /** If true (default), re-deriving the artifact after inputs move is safe.
   *  When false, the artifact must not silently re-fire. */
  idempotent?: boolean;
  /** Routing when idempotent:false and an input moves.
   *  'pin'        — keep the artifact green, re-point fingerprint to current inputs.
   *  'escalate'   — reject the artifact as held; producer not auto-re-eligible.
   *  '<loopName>' — pin the original AND arm the named handler loop (D-A/D-B).
   *  Defaults to 'escalate' when idempotent:false and omitted. */
  onInvalidate?: 'pin' | 'escalate' | string;
}

/** A loop (step) definition. */
export interface LoopDef {
  name: string;
  /** Inputs this loop reads — and, by the same declaration, the artifacts it has
   *  authority to judgment-`reject` (§4.1). Consuming is dual-purpose: it gates and
   *  fingerprints the loop's firing (§3/§7) AND confers the right to send that
   *  artifact back. To let a step invalidate an artifact, make it consume that
   *  artifact — even when the step only *judges* the artifact (e.g. the merger
   *  consuming `pr` to judge its mergeability) rather than transforming it. */
  consumes: ConsumePattern[];
  produces: ProducePattern[];
  /** Artifacts this loop generates that are intentionally NOT consumed downstream.
   *  Lint-exempt from dead-end warnings. Unioned into `produces` at def-build time. */
  generates?: ProducePattern[];
  /** input names this loop has authority to invalidate (defaults to its consumed stems) */
  invalidates: string[];
  cadence: string; // e.g. "30m"
  cadenceSecs: number;
  maxRunsPerDay: number;
  parallel: number;
  maxAttempts: number;
  /** §19: how many schema-validation failures an output may accrue before it stalls */
  maxSchemaFailures: number;
  model?: string;
  workdir: string;
  /** the loop's output is a destructive completion (e.g. a merge): green is terminal (§15.2) */
  terminal?: boolean;
  /** Loop-level effect contract (§6.5). Only consulted for non-terminal greens whose inputs move. */
  effect?: EffectDef;
  /** Loop-level firing trigger (§21). Omitted = ['inputsGreen'] (default behaviour). */
  on?: FiringTrigger[];
  /** Duration string for the idle threshold (e.g. "30m"). Required when 'idle' is in on:. */
  idleAfter?: string;
  /** Parsed idleAfter in milliseconds. */
  idleAfterMs?: number;
  body: string; // prompt body
  /** Mode 2 foundation: name of the child workflow this loop delegates to. Machine-handled, never a worker firing. */
  calls?: string;
  /** Mode 2 foundation: child input name → parent artifact name wiring for a calls: loop. */
  callsInputs?: Record<string, string>;
}

/** A workflow definition: a set of loops plus declared external inputs. */
export interface WorkflowDef {
  name: string;
  title?: string;
  description?: string;
  /** external inputs seeded as artifacts when an instance starts (e.g. "proposal") */
  inputs: InputDef[];
  /**
   * Fully-expanded loop list. Raw YAML may contain `include:` directives (Mode 1, §22)
   * that are expanded at load time by `expandIncludes`; the engine always sees a flat list.
   */
  loops: LoopDef[];
  /** Workflow-level public outputs / embedding interface (design doc §5.2).
   *  Declared stems are intentional leaves: lint-exempt from dead-end warnings.
   *  A stem listed here that no loop produces is a hard validateDef error. */
  outputs?: string[];
  dir?: string; // source directory, if loaded from disk
  /** Declared safety invariants verified by `modelCheck`/`oweflow check`. */
  invariants?: InvariantDef[];
  /**
   * @internal Mode 1 include directives before expansion. Set by `buildDef` when a
   * loop-list entry has an `include:` key. Consumed and removed by `expandIncludes`.
   * Never visible to the engine; always undefined on a fully-expanded def.
   */
  _includes?: Array<{ pos: number; defName: string; as: string; inputs: Record<string, string> }>;
}

export interface InputDef {
  name: string;
  /** who provides it: a human (pulled) or it is provided at start */
  producer: string; // "human" by convention, or any external label
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
 * which stems this loop is responsible for, but there is no stored FK linking
 * a specific run to the artifact version it produced. `consumedInputs` is from
 * the run's fingerprint (what versions of inputs were live at claim time) —
 * this IS a stored fact. The causal edge "run R produced version N of stem S"
 * is an inference, not a guarantee; see WorkflowTrace.inferenceNote.
 */
export interface TimelineEvent {
  seq: number;               // 1-based sequence number, stable across renders
  at: number;                // run.createdAt (ms since epoch)
  endedAt: number;           // run.updatedAt (ms since epoch, last mutation)
  loop: string;              // loop name
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
   * The stems this loop is declared to produce (from the def), not from a
   * stored link. For map loops this is the map pattern stem (e.g.
   * "gather.source[$i].formatcheck"); for collection producers it is the
   * collection stem (e.g. "gather.source"); for singletons it is the stem name.
   * This is structural, not temporal — it tells you what the loop *could*
   * produce, not which version it produced in this specific run.
   */
  producedStems: string[];
}

/** The lifecycle biography of one artifact: its current state + full event thread. */
export interface ArtifactBiography {
  path: string;
  producer: string;          // loop name
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
   *   - the loop that produced A (from A.producer = run.loop)
   *   - ordered by run.createdAt — the Nth 'ok' run of loop L is the likely
   *     producer of version N of that loop's output
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
  | 'none';      // no artifact data (static view or no artifacts yet)

/** One node in the wiring graph: either a loop or an external input. */
export interface GraphNode {
  id: string;              // stable identifier: loop name or input name
  kind: 'loop' | 'input';
  label: string;           // display label (same as id for now)
  terminal?: boolean;      // loops only: declared terminal
  parallel?: number;       // loops only: parallelism setting
  model?: string;          // loops only: model hint
  /** Overlay: present only when artifacts were supplied to buildGraph */
  state?: GraphNodeState;
  /** Overlay: true when any output artifact is stalled */
  stalled?: boolean;
}

/** One directed edge: producer → consumer. */
export interface GraphEdge {
  from: string;            // node id (loop name or input name)
  to: string;              // loop node id
  stem: string;            // the artifact stem crossing this edge
  mode: 'plain' | 'map' | 'reduce'; // consume mode at the to-node
  /** For map: the binder name (e.g. "i") — used for label generation */
  binder?: string;
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

/** One step on a BFS path: a loop fired, on which key, with which outcome. */
export interface CheckStep {
  loop: string;
  key: string;      // "" for plain/reduce; element path for map
  outcome: 'green' | 'judgment-reject' | 'schema-reject' | 'skip' | 'retract' | 'emit-seal';
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
}

/** The structured report produced by modelCheck. */
export interface CheckReport {
  def: string;
  /** True when any BFS bound was hit — verdicts are "within bounds", not global. */
  bounded: boolean;
  /** Which bounds were hit, for honest reporting. */
  boundsHit: ('maxDepth' | 'maxStates')[];
  /** Reachable states where done=false and eligibleFirings=[]: a genuine deadlock. */
  deadlocks: CheckFinding[];
  /** Reachable states that have a stalled debt (judgmentRejects >= cap). */
  stuck: CheckFinding[];
  /** Whether any explored state is done, and (when true) one example path to it. */
  completable: boolean;
  completePath?: CheckStep[];
  /**
   * Loop names that never appear as the firing loop in any explored transition
   * (dynamically dead within the bounded search).
   */
  deadLoops: string[];
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
