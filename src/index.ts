/**
 * oweflow — a generic dataflow workflow engine.
 *
 * Loops owe and consume artifacts; a loop's eligibility to run is a pure
 * function of artifact state (debts + dependency satisfaction), not a status
 * enum. Rejection carries a reason thread; a forward cascade keeps the graph
 * honest ("an artifact is green only while every artifact it consumed is
 * green"); a commit-fingerprint CAS makes concurrent advancement safe.
 *
 * This is the public API. The engine is domain-neutral: a *wiring* (a set of
 * workflow definitions + a worker that executes orders) layers a concrete
 * process — software delivery, research, triage — on top of it.
 */

export { Engine } from './engine.ts';
export type {
  CommitResult,
  CreateOpts,
  DefResolver,
  EmitResult,
  EngineEvent,
  EngineListener,
  Order,
  TickResult,
} from './engine.ts';

export { createEngine } from './factory.ts';
export type { CreateEngineOpts, CreatedEngine } from './factory.ts';

export { Store, openStore } from './store.ts';
export type { ArtifactRow, RunRow, TaskRow, WorkflowRow } from './store.ts';

export { buildDef, DefError, lintDef, loadDefFile, loadDefs, parseDef, validateDef } from './defs.ts';

export {
  buildGraph,
  buildTrace,
  collectionProduces,
  eligibleFirings,
  graphToDot,
  graphToMermaid,
  isSchemaStalled,
  isStalled,
  maintainDecisions,
  mapProduce,
  singletonProduces,
  workflowStatus,
} from './model.ts';
export type { ArtifactMap, Blocker, CascadeOp, Firing, WorkflowStatus } from './model.ts';

export {
  parseConsume,
  parseProduce,
} from './paths.ts';

export { assertValidSchema, summarizeIssues, validateValue } from './schema.ts';
export type { SchemaCheck, SchemaIssue } from './schema.ts';

export { DEBT_STATES, SETTLED_STATES } from './types.ts';
export type {
  Acceptance,
  ArtifactBiography,
  ArtifactData,
  Author,
  ConsumePattern,
  Fingerprint,
  GraphEdge,
  GraphNode,
  GraphNodeState,
  InputDef,
  JsonSchema,
  LoopDef,
  ProducePattern,
  ReasonEntry,
  RejectKind,
  RunData,
  TaskData,
  TimelineEvent,
  WorkflowDef,
  WorkflowGraph,
  WorkflowTrace,
} from './types.ts';
