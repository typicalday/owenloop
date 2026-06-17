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
 *  - `validation`: a produced value failed its declared JSON Schema (§18) — counts
 *    toward a *separate* per-artifact stall bounded by the loop's `maxSchemaFailures`.
 */
export type RejectKind = 'judgment' | 'structural' | 'validation';

export type ReasonAction =
  | 'reject'
  | 'retract'
  | 'skip'
  | 'reopen'
  | 'retry'
  | 'born-rejected'
  | 'schema-reject';

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
  schemaRejects: number; // §18 stall counter — schema-validation rejects only
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
  /** optional JSON Schema the produced value must satisfy at commit time (§18) */
  schema?: JsonSchema;
}

/** A loop (step) definition. */
export interface LoopDef {
  name: string;
  consumes: ConsumePattern[];
  produces: ProducePattern[];
  /** input names this loop has authority to invalidate (defaults to its consumed stems) */
  invalidates: string[];
  cadence: string; // e.g. "30m"
  cadenceSecs: number;
  maxRunsPerDay: number;
  parallel: number;
  maxAttempts: number;
  /** §18: how many schema-validation failures an output may accrue before it stalls */
  maxSchemaFailures: number;
  model?: string;
  workdir: string;
  /** the loop's output is a destructive completion (e.g. a merge): green is terminal (§15.2) */
  terminal?: boolean;
  body: string; // prompt body
}

/** A workflow definition: a set of loops plus declared external inputs. */
export interface WorkflowDef {
  name: string;
  title?: string;
  description?: string;
  /** external inputs seeded as artifacts when an instance starts (e.g. "proposal") */
  inputs: InputDef[];
  loops: LoopDef[];
  dir?: string; // source directory, if loaded from disk
}

export interface InputDef {
  name: string;
  /** who provides it: a human (pulled) or it is provided at start */
  producer: string; // "human" by convention, or any external label
  /** if true, instance start leaves it owed; otherwise it must be provided at start */
  seedOwed: boolean;
  /** optional JSON Schema a provided input value must satisfy (§18) */
  schema?: JsonSchema;
}

// ---- trace types (§17 derived view: temporal causal timeline) ----------------

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
