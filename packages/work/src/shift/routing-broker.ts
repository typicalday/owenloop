/**
 * Private, per-Shift routed child transport. The Shift retains both Hub
 * credentials; a child receives only a random, one-dispatch socket capability.
 * No caller may choose a URL, header, verb, workflow, run or session.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chmodSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RoutingHubClient } from '../hub/client.ts';
import { parseRoutedClaimV2, parseRoutedReferenceV2,
  type RoutedClaimV2, type RoutedReferenceV2,
  type RoutedReferenceBindingV2 } from '../hosted/trusted-routed-reference-v2.ts';
import { parseRecordedClaimV2, parseRecordedReferenceV2,
  type RecordedClaimV2, type RecordedReferenceV2,
  type RecordedBindingV2 } from '../hosted/trusted-routed-recorded-v2.ts';
import { HubError, type ContactHolder, type FileArtifactPointer, type GetOrderResponse, type LaunchReportV1,
  type LaunchReservationRequestV1, type ReferenceRouting, type PutFileArtifactResponse,
  type RoutedCollectionHolder, type RoutedMemberIssueRequest, type RoutedMemberIssueResponse,
  type RoutedMemberEmitRequest, type RoutedCollectionSealRequest,
  type RoutedCollectionWriteResponse } from '../hub/types.ts';
import type { ChildRecord, ChildReservation } from './state.ts';
import { retainedChildLive, type RetainedChildCustody } from './spawn.ts';
import type { RoutedSubmissionAuthority } from './routing-submit-authority.ts';
import { outputVersionForSubmission } from '../submit-proof.ts';
import { normalizeSubmitValue } from '../submit-value.ts';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { RoutedInputPair, RoutedInputPhase } from '../hosted/trusted-input-admission.ts';
import type { InvocationRelayKey, VerifiedInvocationReceipt } from '../../../../src/types.ts';
import { commandPostrunBodyDigest, snapshotCommandPostrun, type CommandPostrunResponse,
  type CommandPostrunStatus,
  type CommandPostrunSnapshot } from './routing-command-postrun.ts';

// Service permits artifact values up to 25 MB. Leave bounded JSON overhead
// while allowing a normal submit receipt through this private transport.
const MAX_LINE = 32 * 1024 * 1024;
const CONDITIONAL_ACK_READ_MS = 30_000;
const MAX_FILE = 500_000_000;
const MAX_UPLOAD_HEADER = 4096;
// Service reserves a routed upload for 15 minutes. End our request early so
// abort and staged-object cleanup can settle before that reservation expires.
const UPLOAD_IDLE_MS = 4 * 60_000;
const UPLOAD_ABSOLUTE_MS = 14 * 60_000;
const MAX_SOCKETS = 16;
const QUIESCE_DRAIN_MS = 10_000;
const CAP = /^[a-f0-9]{64}$/;
// Observation only: neither these counters nor their flags authorize a request.
const DIAGNOSTIC_LIMIT = 65_535;
/** @internal Pure arithmetic seam; cannot read or mutate a broker grant. */
export function advanceRoutingDiagnosticCounter(value: number): {
  value: number; overflow: boolean; incomplete: boolean;
} {
  if (!Number.isSafeInteger(value) || value < 0 || value > DIAGNOSTIC_LIMIT)
    return { value: 0, overflow: false, incomplete: true };
  return value === DIAGNOSTIC_LIMIT
    ? { value, overflow: true, incomplete: false }
    : { value: value + 1, overflow: false, incomplete: false };
}
function newDiagnostics() {
  return {
    protocol: 'routing-broker-diagnostics-v1' as const,
    holderSubmitsAccepted: 0, roleSubmitsAccepted: 0,
    pendingSubmitReceiptReads: 0, retryIssuesDispatched: 0,
    initialConditionalMutationsDispatched: 0, replayConditionalMutationsDispatched: 0,
    quiesceAccepted: 0, agentOutcomeAccepted: 0, agentOutcomeRecoveryEntries: 0,
    agentOutcomeReceiptReads: 0, agentOutcomeCommittedClosedReceipts: 0,
    agentOutcomeRecoveredClosedSubmits: 0, agentOutcomeClosedReturns: 0,
    agentOutcomeHeldReturns: 0, agentOutcomeUncertainReturns: 0,
    agentFinishAccepted: 0, releaseDispatched: 0, terminalReceiptReads: 0,
    overflow: false, incomplete: false,
  };
}
export type RoutingBrokerDiagnostics = Readonly<ReturnType<typeof newDiagnostics>>;
type DiagnosticCounter = Exclude<keyof RoutingBrokerDiagnostics, 'protocol' | 'overflow' | 'incomplete'>;
function countDiagnostic(grant: Grant, key: DiagnosticCounter): void {
  const next = advanceRoutingDiagnosticCounter(grant.diagnostics[key]);
  grant.diagnostics[key] = next.value;
  grant.diagnostics.overflow ||= next.overflow;
  grant.diagnostics.incomplete ||= next.incomplete;
}

type Identity = { sessionId: string; shiftId: string; orgId: string; principalId: string; expiresAt: number };
type Method = 'get_order' | 'get_launch_order' | 'read_routing_claim' | 'assess_local_model' | 'reserve_launch' | 'report_launch'
  | 'read_routed_reference_v2' | 'read_routing_claim_v2' | 'read_routed_pair_v2'
  | 'read_live_routed_reference_v2' | 'read_live_routing_claim_v2'
  | 'heartbeat' | 'submit' | 'release' | 'ask' | 'reject' | 'request_approval'
  | 'read_invocation_binding' | 'collection_target' | 'emit_member' | 'seal_collection' | 'quiesce'
  | 'command_postrun' | 'command_postrun_status' | 'command_finish' | 'agent_outcome' | 'agent_finish';
type CapScope = 'role' | 'holder';
export type RoutedQuiesceResult = { quiescing: true; effects: 'settled' | 'uncertain' };
interface Grant {
  diagnostics: ReturnType<typeof newDiagnostics>;
  active: boolean;
  ready: boolean;
  liveChild?: { custody: RetainedChildCustody; pid: number; spawnedAt: number;
    incarnation: string; nonce: string; gateSignalled: boolean; entered: boolean; terminal: boolean };
  execHolderId?: string;
  allowedPaths?: Set<string>;
  consumedPaths?: Set<string>;
  consumedFiles?: Map<string, FileArtifactPointer>;
  uploadControllers: Set<AbortController>;
  /** Active mutation streams; downloads are cancelled but are not writes. */
  uploadEffectControllers: Set<AbortController>;
  /** Local irreversible freeze. This is not a native/fleet terminal seal. */
  quiescing: boolean;
  inFlightEffects: Set<Promise<void>>;
  uncertainEffects: Set<Method | 'upload_file'>;
  /** One entry per dispatched child mutation with a lost/malformed ACK. The
   * method set above remains a coarse quarantine signal for stream effects. */
  effectLedger: Map<number, { method: Method; requestDigest?: string }>;
  nextEffectId: number;
  effectLedgerOverflow: boolean;
  syncUncertainty?: () => void;
  quiesceResult?: Promise<RoutedQuiesceResult>;
  observeQuiesce?: (result: Promise<RoutedQuiesceResult>) => void;
  reservation: ChildReservation;
  routing: ReferenceRouting;
  identity: Identity;
  currentIdentity: () => Identity | undefined;
  hub: RoutingHubClient;
  routedV2Read?: (kind: 'reference' | 'claim', expected: { workflow: string; run: string }) =>
    Promise<RoutedReferenceV2 | RoutedClaimV2>;
  routedLiveV2Read?: (kind: 'reference' | 'claim', expected: { workflow: string; run: string }) =>
    Promise<RecordedReferenceV2 | RecordedClaimV2>;
  inputAuthority?: RoutedInputAuthority;
  referenceOrderDigest?: string;
  referenceBinding?: RoutedReferenceBindingV2;
  reservationRequest?: LaunchReservationRequestV1;
  launchReservationId?: string;
  launchExpiresAt?: number;
  acceptedLaunchReport?: string;
  submissionAuthority?: RoutedSubmissionAuthority;
  submitBusy?: boolean;
  pendingSubmit?: { intent: string; binding: string;
    request: import('../hub/types.ts').ConditionalSubmitRequest;
    intentId: string; requestDigest: string; rawBody: string; generationToken?: string };
  conditionalTouched?: boolean;
  launchAuthority?: RoutedLaunchAuthority;
  collectionBusy?: boolean;
  collectionMember?: { intent: string; issue: RoutedMemberIssueRequest;
    issued?: RoutedMemberIssueResponse; emit?: RoutedMemberEmitRequest;
    result?: RoutedCollectionWriteResponse; done: boolean; sealId?: string };
  collectionSeal?: { intent: string; request?: RoutedCollectionSealRequest;
    result?: RoutedCollectionWriteResponse };
  commandFor?: (order: import('../hub/types.ts').OrderPacket) => Promise<string>;
  postrun?: { intent: string; bodyDigest: string; childGeneration: NonNullable<Grant['liveChild']>;
    command: string; step: string;
    snapshot: CommandPostrunSnapshot; nextOwe: number;
    paths: Array<{ path: string; kind: 'singleton' | 'collection' }>;
    judge?: string; rejectDone: boolean; askOrRejectDispatched: boolean;
    terminalClosed?: boolean;
    result?: CommandPostrunResponse };
  postrunBusy?: boolean;
  postrunRelease?: { reason: string; dispatched: boolean; response?: import('../hub/types.ts').ReleaseResponse };
  /** Authenticated Service mutation results only. A model claim is never an ACK. */
  agentAcks: Array<{ method: 'submit' | 'ask' | 'reject' | 'seal_collection'; closed: boolean }>;
  agentAckOverflow: boolean;
  agentOutcome?: 'closed' | 'held';
  agentRelease?: { dispatched: boolean; response?: import('../hub/types.ts').ReleaseResponse };
  terminalReason?: 'normal-close' | 'receipt-pending' | 'revoked';
  receiptUntil?: number;
  revokeResult?: Promise<void>;
}
export interface RoutedLaunchAuthority {
  /** Parent-owned current machine roster and adapter availability. */
  verifySelection(order: import('../hub/types.ts').OrderPacket, request: LaunchReservationRequestV1): Promise<void>;
}
/** Parent-owned input observation. The caller never supplies the phase or a URL. */
export interface RoutedInputAuthority {
  /** Fresh full getSessionOrder+pair, verified by the parent stage before return.
   * Never reused across another consequence or local await. */
  observeOrder?(holder: ContactHolder | undefined, phase: RoutedInputPhase,
    expected: { workflow: string; run: string }): Promise<{ response: GetOrderResponse; pair: RoutedInputPair }>;
  observe(response: GetOrderResponse, phase: RoutedInputPhase): Promise<RoutedInputPair>;
  validateInvocationKey?(key: InvocationRelayKey): boolean;
  observeInvocation?(response: GetOrderResponse, phase: RoutedInputPhase,
    key: InvocationRelayKey): Promise<{ pair: RoutedInputPair; relay: VerifiedInvocationReceipt | undefined }>;
}
export interface RoutingBroker {
  issue(args: { reservation: ChildReservation; routing: ReferenceRouting; identity: Identity;
    currentIdentity: () => Identity | undefined; hub: RoutingHubClient;
    routedV2Read?: Grant['routedV2Read'];
    routedLiveV2Read?: Grant['routedLiveV2Read'];
    submissionAuthority?: RoutedSubmissionAuthority; launchAuthority?: RoutedLaunchAuthority;
    inputAuthority?: RoutedInputAuthority;
    commandFor?: Grant['commandFor'] }): {
      socketPath: string; cap: string; holder?: { socketPath: string; cap: string };
      /** Parent-only observation; never an authority witness or child method. */
      diagnosticsSnapshot(): RoutingBrokerDiagnostics;
      activate(record: ChildRecord): void;
      bindChild(record: ChildRecord, custody: RetainedChildCustody,
	handoff: { incarnation: string; nonce: string }): void;
      markGateSignalled(record: ChildRecord): void;
      markChildEntered(record: ChildRecord): void;
      canAllowEntry(record: ChildRecord): boolean;
      /** Parent-initiated local freeze; no child packet is required. */
      quiesce(): Promise<RoutedQuiesceResult>;
      terminal(reason?: 'normal-close' | 'child-exit' | 'revoked'): Promise<void> | void;
    };
  close(options?: { revokeNormalReceipts?: boolean }): Promise<void>;
  /** Extinguish one incarnation locally before awaiting its Service revocation. */
  revokeSession(sessionId: string): Promise<void>;
  socketPath: string;
}

function liveChildValid(grant: Grant, now: number): boolean {
  const child = grant.liveChild;
  return !!child && child.gateSignalled && child.entered && !child.terminal
    && retainedChildLive(child.custody, child.pid) && grant.ready && validateSessionGrant(grant, now);
}

function recordedBindingMatches(grant: Grant, binding: RecordedBindingV2): boolean {
  const claim = grant.routing.claim;
  const { recordedOccurrence, ...initial } = binding;
  return binding.rootWorkflow === grant.reservation.workflow && binding.run === grant.reservation.run
    && binding.frameWorkflow === claim.binding.frameId
    && binding.claimId === claim.claimId && binding.decisionId === claim.decisionId
    && binding.sessionId === grant.identity.sessionId && binding.shiftId === grant.identity.shiftId
    && !!grant.referenceBinding && isDeepStrictEqual(initial, grant.referenceBinding)
    && binding.orderDigest === grant.referenceOrderDigest
    && binding.routingDigest === valueDigestHex(grant.routing)
    && recordedOccurrence.reservationId === grant.launchReservationId
    && recordedOccurrence.reportDigest === grant.acceptedLaunchReport
    && recordedOccurrence.attemptId === claim.attemptId;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
function sameTuple(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
function exactBinding(grant: Grant, value: { claimId: string; decisionId: string; binding: unknown;
  orderId: string; attemptId: string }): boolean {
  const claim = grant.routing.claim;
  return value.claimId === claim.claimId && value.decisionId === claim.decisionId
    && value.orderId === claim.orderId && value.attemptId === claim.attemptId
    && isDeepStrictEqual(value.binding, claim.binding);
}
function orderedCandidates(grant: Grant, ids: unknown): ids is string[] {
  if (!Array.isArray(ids) || ids.length > 16 || !ids.every(id => typeof id === 'string')) return false;
  const allowed = grant.routing.preference.tuples.filter(t => t.eligible && t.available).map(t => t.tuple.id);
  let at = -1;
  for (const id of ids) {
    at = allowed.indexOf(id, at + 1);
    if (at < 0) return false;
  }
  return true;
}
function selectedTuple(grant: Grant, tuple: unknown): boolean {
  return tuple === null || grant.routing.preference.tuples.some(t =>
    t.eligible && t.available && sameTuple(t.tuple, tuple));
}
function exactObservation(value: unknown, selected: unknown): boolean {
  if (!value || typeof value !== 'object' || !('state' in value)) return false;
  const observation = value as Record<string, unknown>;
  if (observation.state === 'unknown') return exactKeys(observation, ['state']);
  if (observation.state === 'reported') return exactKeys(observation, ['state', 'tuple'])
    && sameTuple(observation.tuple, selected);
  if (observation.state === 'observed') return exactKeys(observation, ['state', 'tuple', 'pid', 'argv', 'evidence'])
    && sameTuple(observation.tuple, selected) && typeof observation.pid === 'number'
    && Number.isSafeInteger(observation.pid) && observation.pid > 0
    && Array.isArray(observation.argv) && observation.argv.every((arg: unknown) => typeof arg === 'string')
    && observation.evidence !== null && typeof observation.evidence === 'object';
  return false;
}
function validateSessionGrant(grant: Grant, now: number): boolean {
  const { reservation, routing, identity } = grant;
  const claim = routing.claim;
  const current = grant.currentIdentity();
  return grant.active && current !== undefined && current.sessionId === identity.sessionId
    && current.shiftId === identity.shiftId && current.orgId === identity.orgId
    && current.principalId === identity.principalId && now < current.expiresAt
    && claim.state === 'claimed'
    && /^[a-f0-9]{32}$/.test(reservation.token)
    && (reservation.childKind === 'exec' || reservation.childKind === 'agent-run')
    && claim.claimId === reservation.run && claim.orderId === reservation.run
    && typeof claim.attemptId === 'string' && claim.attemptId.length > 0 && claim.attemptId.length <= 512
    && claim.sessionId === identity.sessionId && claim.shiftId === identity.shiftId
    && claim.principalId === identity.principalId && claim.binding.orgId === identity.orgId
    && claim.binding.runId === reservation.workflow
    && claim.binding.authority.sessionId === identity.sessionId
    && claim.binding.authority.principalId === identity.principalId
    && routing.decision.decisionId === claim.decisionId
    && isDeepStrictEqual(routing.decision.binding, claim.binding);
}

function validateLaunchGrant(grant: Grant, now: number): boolean {
  return validateSessionGrant(grant, now) && now < grant.routing.preference.expiresAt
    && now < grant.routing.claim.binding.expiresAt;
}

function validHolder(grant: Grant, scope: CapScope, value: unknown): value is ContactHolder {
  if (!exactKeys(value, ['kind', 'id', 'shiftId'])) return false;
  if (value.shiftId !== grant.identity.shiftId) return false;
  if (scope === 'role') return value.kind === 'exec' && value.id === grant.execHolderId;
  return grant.reservation.childKind === 'agent-run' && value.kind === 'session'
    && value.id === grant.identity.sessionId;
}

function validOrderResponse(grant: Grant, value: unknown): value is GetOrderResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  // The scoped request names the root workflow, but a nested native firing
  // returns its actual frame. The new input gate binds that exact frame to
  // the persisted claim; legacy strict grants keep their existing shape.
  const expectedWorkflow = grant.inputAuthority
    ? grant.routing.claim.binding.frameId : grant.reservation.workflow;
  if (response.workflow !== expectedWorkflow || response.run !== grant.reservation.run
    || !response.lease || typeof response.lease !== 'object'
    || typeof (response.lease as { claimed?: unknown }).claimed !== 'boolean') return false;
  if (response.order === null) return true;
  if (!response.order || typeof response.order !== 'object') return false;
  const order = response.order as Record<string, unknown>;
  return order.workflow === expectedWorkflow && order.run === grant.reservation.run
    && Array.isArray(order.owes)
    && order.owes.every(owe => owe && typeof owe === 'object' && typeof owe.path === 'string')
    && Array.isArray(order.outputs) && order.outputs.every(path => typeof path === 'string');
}

function consumedFiles(response: GetOrderResponse): Map<string, FileArtifactPointer> {
  const found = new Map<string, FileArtifactPointer>();
  const order = response.order;
  if (!response.lease.claimed || !order || !Array.isArray(order.inputs)
    || !order.consumes || typeof order.consumes !== 'object') return found;
  const walk = (path: string, value: unknown, depth: number): void => {
    if (depth > 32 || !value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (typeof row.__file === 'string' && typeof row.hash === 'string'
      && /^[a-f0-9]{64}$/.test(row.hash) && typeof row.size === 'number'
      && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= MAX_FILE
      && typeof row.contentType === 'string' && row.contentType.length > 0) {
      found.set(`${path}\0${row.__file}`, row as unknown as FileArtifactPointer);
      return;
    }
    if (Array.isArray(value)) for (const item of value) walk(path, item, depth + 1);
    else for (const item of Object.values(row)) walk(path, item, depth + 1);
  };
  for (const path of order.inputs) if (Object.hasOwn(order.consumes, path))
    walk(path, order.consumes[path], 0);
  return found;
}

async function checked<T>(grant: Grant, call: Promise<T>, now: () => number, launch = false): Promise<T> {
  const valid = () => grant.ready && (launch ? validateLaunchGrant(grant, now()) : validateSessionGrant(grant, now()));
  try {
    const value = await call;
    if (!valid()) throw new Error('routing broker grant expired');
    return value;
  } catch (error) {
    if (!valid()) throw new Error('routing broker grant expired');
    throw error;
  }
}

/** Refuse a Hub mutation that reached its wire boundary after parent freeze. */
const effectContext = new AsyncLocalStorage<{ dispatched: boolean; parentPostrun?: boolean }>();
function startEffect<T>(grant: Grant, send: () => Promise<T>): Promise<T> {
  const context = effectContext.getStore();
  if (grant.quiescing && !context?.parentPostrun) throw new Error('routing broker quiescing');
  if (context) context.dispatched = true;
  return send();
}

/** Track the whole validated broker operation, not just the fetch. A malformed
 * or lost ACK after Service commit remains uncertain at the quiesce boundary. */
function trackEffect<T>(grant: Grant, method: Method, send: () => Promise<T>): Promise<T> {
  const context = { dispatched: false };
  const id = ++grant.nextEffectId;
  const priorSubmitDigest = method === 'submit' ? grant.pendingSubmit?.requestDigest : undefined;
  const operation = effectContext.run(context, send);
  const settled = operation.then(() => {
    // These three operations have an exact conditional replay/receipt path.
    // A later acknowledged replay resolves only its original frozen intent.
    if (method === 'submit' || method === 'emit_member' || method === 'seal_collection') {
      if (method === 'submit' && priorSubmitDigest)
	for (const [effectId, entry] of grant.effectLedger)
	  if (entry.method === 'submit' && entry.requestDigest === priorSubmitDigest)
	    grant.effectLedger.delete(effectId);
      grant.uncertainEffects.delete(method);
      grant.syncUncertainty?.();
    }
  }, () => {
    if (context.dispatched) {
      grant.uncertainEffects.add(method);
      if (grant.effectLedger.size >= 256) grant.effectLedgerOverflow = true;
      else grant.effectLedger.set(id, { method,
	...(method === 'submit' && grant.pendingSubmit
	  ? { requestDigest: grant.pendingSubmit.requestDigest } : {}) });
      grant.syncUncertainty?.();
    }
  });
  grant.inFlightEffects.add(settled);
  void settled.finally(() => { grant.inFlightEffects.delete(settled); });
  return operation;
}

function recordAgentAck(grant: Grant, method: 'submit' | 'ask' | 'reject' | 'seal_collection',
  closed: boolean): void {
  if (grant.reservation.childKind !== 'agent-run') return;
  if (grant.agentAcks.length >= 256) { grant.agentAckOverflow = true; return; }
  grant.agentAcks.push({ method, closed });
}

/** Parent-owned irreversible local effect freeze. A successful reply proves
 * only the broker's state and bounded in-flight observations, never process
 * death, native release or permission to publish a postrun result. */
function quiesceGrant(grant: Grant): Promise<RoutedQuiesceResult> {
  if (grant.quiesceResult) return grant.quiesceResult;
  grant.quiescing = true;
  if (grant.uploadEffectControllers.size > 0) grant.uncertainEffects.add('upload_file');
  for (const controller of grant.uploadControllers) controller.abort();
  grant.quiesceResult = (async () => {
    const pending = [...grant.inFlightEffects];
    if (pending.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(resolve => {
	timer = setTimeout(() => resolve('timeout'), QUIESCE_DRAIN_MS);
	timer.unref();
      });
      const result = await Promise.race([
	Promise.allSettled(pending).then(() => 'settled' as const), timeout,
      ]);
      if (timer) clearTimeout(timer);
      if (result === 'timeout' || grant.inFlightEffects.size > 0)
	grant.uncertainEffects.add('upload_file');
    }
    // These exact requests are retained for the existing bounded replay or
    // receipt path. An unknown outcome never becomes a fresh child write.
    if (grant.collectionMember?.emit && !grant.collectionMember.result)
      grant.uncertainEffects.add('emit_member');
    if (grant.collectionSeal?.request && !grant.collectionSeal.result)
      grant.uncertainEffects.add('seal_collection');
    grant.syncUncertainty?.();
    return { quiescing: true, effects: grant.uncertainEffects.size ? 'uncertain' : 'settled' };
  })();
  grant.observeQuiesce?.(grant.quiesceResult);
  return grant.quiesceResult;
}

/** Apply the same exact grant binding to a pair already fully verified by the
 * parent stage. This is synchronous and never caches a witness across reads. */
function acceptVerifiedPair(grant: Grant, pair: RoutedInputPair,
  phase: RoutedInputPhase, now: () => number): void {
  if (phase === 'prestart' ? !validateLaunchGrant(grant, now())
    : !grant.acceptedLaunchReport || !liveChildValid(grant, now()))
    throw new Error('routing input grant changed');
  if (phase === 'prestart') {
    const expected = { workflow: grant.reservation.workflow, run: grant.reservation.run };
    const reference = parseRoutedReferenceV2(pair.reference, expected);
    const claim = parseRoutedClaimV2(pair.claim, expected);
    if (reference.state !== 'available' || claim.state !== 'available'
      || reference.binding.frameWorkflow !== grant.routing.claim.binding.frameId
      || reference.binding.sessionId !== grant.identity.sessionId
      || reference.binding.shiftId !== grant.identity.shiftId
      || reference.binding.claimId !== grant.routing.claim.claimId
      || reference.binding.decisionId !== grant.routing.claim.decisionId
      || reference.binding.routingDigest !== valueDigestHex(grant.routing)
      || !isDeepStrictEqual(reference.binding, claim.binding)
      || !isDeepStrictEqual(reference.order.routing, claim.routing)
      || (grant.referenceBinding && !isDeepStrictEqual(grant.referenceBinding, reference.binding))
      || (grant.referenceOrderDigest && grant.referenceOrderDigest !== reference.binding.orderDigest))
      throw new Error('routing prestart input changed');
    grant.referenceBinding = structuredClone(reference.binding);
    grant.referenceOrderDigest = reference.binding.orderDigest;
  } else {
    const expected = { workflow: grant.reservation.workflow, run: grant.reservation.run };
    const reference = parseRecordedReferenceV2(pair.reference, expected);
    const claim = parseRecordedClaimV2(pair.claim, expected);
    if (reference.state !== 'available' || claim.state !== 'available'
      || !isDeepStrictEqual(reference.binding, claim.binding)
      || !isDeepStrictEqual(reference.order.routing, claim.routing)
      || !recordedBindingMatches(grant, reference.binding)
      || !liveChildValid(grant, now()))
      throw new Error('routing recorded input changed');
  }
}

async function verifyParentOrder(grant: Grant, response: GetOrderResponse,
  phase: RoutedInputPhase, now: () => number): Promise<RoutedInputPair | undefined> {
  const authority = grant.submissionAuthority;
  if (!authority || !response.lease.claimed || !response.order)
    throw new Error('routing order authority unavailable');
  // The legacy strict verifier continues to cover the v1 path. Optional and
  // human input admission requires this additional parent-owned Service pair.
  if (!grant.inputAuthority) {
    await checked(grant, authority.verifyOrder(response), now);
    return undefined;
  }
  if (phase === 'recorded-live' && (!grant.acceptedLaunchReport || !liveChildValid(grant, now())))
    throw new Error('routing recorded occurrence unavailable');
  const pair = await checked(grant, grant.inputAuthority.observe(response, phase),
    now, phase === 'prestart');
  acceptVerifiedPair(grant, pair, phase, now);
  return pair;
}

/** Replace only an existing get_order followed by parent pair verification. */
async function readVerifiedParentOrder(grant: Grant, holder: ContactHolder | undefined,
  phase: RoutedInputPhase, now: () => number, signal: AbortSignal,
  expectedOrder?: NonNullable<GetOrderResponse['order']>):
  Promise<{ response: GetOrderResponse; pair: RoutedInputPair | undefined }> {
  if (!grant.submissionAuthority) throw new Error('routing order authority unavailable');
  if (grant.inputAuthority?.observeOrder) {
    if (signal.aborted) throw new Error('routing order observation aborted');
    if (phase === 'recorded-live' && (!grant.acceptedLaunchReport || !liveChildValid(grant, now())))
      throw new Error('routing recorded occurrence unavailable');
    const observed = await checked(grant, grant.inputAuthority.observeOrder(holder, phase,
      { workflow: grant.reservation.workflow, run: grant.reservation.run }), now, phase === 'prestart');
    if (signal.aborted) throw new Error('routing order observation aborted');
    if (!validOrderResponse(grant, observed.response) || !observed.response.lease.claimed || !observed.response.order)
      throw new Error('routing current order unavailable');
    if (expectedOrder && !isDeepStrictEqual(observed.response.order, expectedOrder))
      throw new Error('routing launch order changed');
    acceptVerifiedPair(grant, observed.pair, phase, now);
    return observed;
  }
  const response = await checked(grant, grant.hub.getOrder({ workflow: grant.reservation.workflow,
    run: grant.reservation.run, holder }, signal), now, phase === 'prestart');
  if (!validOrderResponse(grant, response)) throw new Error('routing current order unavailable');
  // Preserve the legacy final-launch order comparison before another awaited
  // input read; composite callbacks separately verify their captured packet.
  if (expectedOrder && !isDeepStrictEqual(response.order, expectedOrder))
    throw new Error('routing launch order changed');
  const pair = response.lease.claimed && response.order
    ? await verifyParentOrder(grant, response, phase, now) : undefined;
  return { response, pair };
}

async function verifyCurrentConsequence(grant: Grant, scope: CapScope,
  now: () => number, signal: AbortSignal,
  phase: RoutedInputPhase = 'recorded-live'): Promise<GetOrderResponse | undefined> {
  if (!grant.inputAuthority) return undefined;
  if (!grant.execHolderId) throw new Error('routing order holder unavailable');
  if (phase === 'recorded-live' && !liveChildValid(grant, now()))
    throw new Error('routing recorded occurrence unavailable');
  const holder: ContactHolder = scope === 'role'
    ? { kind: 'exec', id: grant.execHolderId, shiftId: grant.identity.shiftId }
    : { kind: 'session', id: grant.identity.sessionId, shiftId: grant.identity.shiftId };
  const { response } = await readVerifiedParentOrder(grant, holder, phase, now, signal);
  if (!validOrderResponse(grant, response) || !response.lease.claimed || !response.order)
    throw new Error('routing current order unavailable');
  return response;
}

/** Only metadata the exact submit proof and target condition bind. The parent
 * also verifies the entire packet against its signed source on every read. */
function submissionBinding(response: GetOrderResponse, path: string, grant: Grant): string {
  const order = response.order;
  if (!validOrderResponse(grant, response) || !response.lease.claimed || !order
    || !order.routing || !isDeepStrictEqual(order.routing.claim, grant.routing.claim)
    || !isDeepStrictEqual(order.routing.decision.binding, grant.routing.claim.binding)
    || order.routing.decision.decisionId !== grant.routing.claim.decisionId
    || !order.consumedFingerprint || typeof order.consumedFingerprint !== 'object'
    || Array.isArray(order.consumedFingerprint)
    || Object.values(order.consumedFingerprint).some(v => !Number.isSafeInteger(v) || v < 0)
    || !(order.owes.length ? order.owes.some(owe => owe.path === path) : order.outputs.includes(path)))
    throw new Error('routing submission order refused');
  const version = outputVersionForSubmission(order, path);
  if (!Number.isSafeInteger(version) || version! < 1) throw new Error('routing submission target refused');
  return valueDigestHex({ workflow: order.workflow, run: order.run, defDigest: order.defDigest,
    step: order.step, key: order.key, index: order.index ?? null, workdir: order.workdir ?? null,
    inputs: order.inputs, consumes: order.consumes, consumedFingerprint: order.consumedFingerprint,
    judge: order.judge ?? null, path, version });
}

async function submitFromParent(grant: Grant, body: Record<string, unknown>, now: () => number,
  signal: AbortSignal, parentPostrun = false): Promise<unknown> {
  if (grant.quiescing && !parentPostrun) throw new Error('routing broker quiescing');
  const authority = grant.submissionAuthority;
  if (!authority || grant.submitBusy) throw new Error('routing submission authority unavailable');
  grant.submitBusy = true;
  try {
    const path = body.path as string;
    const holder = body.holder as ContactHolder;
    const value = normalizeSubmitValue(body.value);
    // The versioned REST contract admits only object values. A correctable
    // input refusal is not an uncertain write and must not poison retry state.
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('routing submission value refused');
    const intent = valueDigestHex({ path, value, done: body.done ?? null, holder });
    if (grant.pendingSubmit && grant.pendingSubmit.intent !== intent)
      throw new Error('routing submission outcome unresolved');
    if (grant.pendingSubmit) {
      const pending = grant.pendingSubmit;
      const reference = { workflow: pending.request.workflow, run: pending.request.run,
	intentId: pending.intentId, requestDigest: pending.requestDigest,
	holder: pending.request.holder as import('../hub/types.ts').RoutedCollectionHolder };
      countDiagnostic(grant, 'pendingSubmitReceiptReads');
      const observed = await checked(grant, grant.hub.routingConditionalReceipt(reference, signal), now);
      if (observed.state === 'committed') {
	const response = observed.result;
	if (!validConditionalReceiptResponse(response))
	  throw new Error('routing submission receipt refused');
	if (!parentPostrun || response.outcome === 'green' || response.outcome === 'submitted'
	  || response.outcome === 'approved') grant.pendingSubmit = undefined;
	return response;
      }
      if (observed.state !== 'unavailable' || !pending.binding)
	throw new Error('routing submission outcome unresolved');
      // Only Service can terminalize the old generation. Its issued token
      // permits the identical frozen bytes once under the original live claim.
      countDiagnostic(grant, 'retryIssuesDispatched');
      const issued = await checked(grant, grant.hub.routingConditionalRetryIssue(reference, signal), now);
      if (!issued || issued.requestDigest !== pending.requestDigest
	|| !Number.isSafeInteger(issued.generation) || issued.generation < 1
	|| !/^[a-f0-9]{64}$/.test(issued.generationToken))
	throw new Error('routing submission retry authority refused');
      const { response: fresh } = await readVerifiedParentOrder(grant, holder, 'recorded-live', now, signal);
      if (submissionBinding(fresh, path, grant) !== pending.binding
	|| authority.canReplay?.(fresh.order!, path) !== true)
	throw new Error('routing submission retry order changed');
      pending.generationToken = issued.generationToken;
      const replay = await checked(grant, startEffect(grant, () => {
	countDiagnostic(grant, 'replayConditionalMutationsDispatched');
	return grant.hub.routingConditionalMutation({
	intentId: pending.intentId, rawBody: pending.rawBody,
	generationToken: pending.generationToken }, signal);
      }), now);
      if (!validConditionalReceiptResponse(replay))
	throw new Error('routing submission retry response refused');
	if (!parentPostrun || replay.outcome === 'green' || replay.outcome === 'submitted'
	  || replay.outcome === 'approved') grant.pendingSubmit = undefined;
	return replay;
    }
    const { response: fresh } = await readVerifiedParentOrder(grant, holder, 'recorded-live', now, signal);
    const binding = submissionBinding(fresh, path, grant);
    if (authority.canSubmit?.(fresh.order!, path) !== true)
      throw new Error('routing submission kind unavailable');
    {
      const proof = await checked(grant, authority.sign(fresh.order!, path, value), now);
      if (typeof proof !== 'string' || !proof) throw new Error('routing submission proof refused');
      // Signing and source verification await external work. Refresh again;
      // the Service enforces the exact version at its final transaction too.
      const { response: current } = await readVerifiedParentOrder(grant, holder, 'recorded-live', now, signal);
      if (submissionBinding(current, path, grant) !== binding)
	throw new Error('routing submission order changed');
      const request = { workflow: grant.reservation.workflow, run: grant.reservation.run, path,
	value, holder, proof, expectedVersion: outputVersionForSubmission(fresh.order!, path)!,
	done: body.done === undefined ? true : body.done as boolean };
      const rawBody = JSON.stringify(request);
      if (Buffer.byteLength(rawBody, 'utf8') > MAX_LINE)
	throw new Error('routing submission frame refused');
      grant.pendingSubmit = { intent, binding, request,
	intentId: randomBytes(16).toString('hex'), rawBody,
	requestDigest: createHash('sha256').update(rawBody, 'utf8').digest('hex') };
      grant.conditionalTouched = true;
    }
    let response: import('../hub/types.ts').RoutedConditionalMutationResponse;
    try {
      response = await checked(grant,
	startEffect(grant, () => {
	  countDiagnostic(grant, 'initialConditionalMutationsDispatched');
	  return grant.hub.routingConditionalMutation({
	    intentId: grant.pendingSubmit!.intentId, rawBody: grant.pendingSubmit!.rawBody }, signal);
	}), now);
      if (!validConditionalReceiptResponse(response))
	throw new Error('routing broker response refused');
    } catch (error) {
      // Crossing the client send boundary is not proof the bytes reached
      // Worker. Recover only an exact committed result through Service's
      // original-session receipt read while this direct role child is live.
      if (!parentPostrun || !effectContext.getStore()?.dispatched) throw error;
      response = await readDispatchedConditionalAck(grant, now, signal, 'command-postrun');
    }
    // A missing/malformed/failed acknowledgement preserves the one exact
    // request, including its signature. It cannot become a new signed write.
    if (!parentPostrun || response.outcome === 'green' || response.outcome === 'submitted'
      || response.outcome === 'approved') grant.pendingSubmit = undefined;
    return response;
  } finally { grant.submitBusy = false; }
}

async function verifyParentLaunch(grant: Grant, request: LaunchReservationRequestV1,
  now: () => number, signal: AbortSignal): Promise<void> {
  if (!grant.submissionAuthority || !grant.launchAuthority || !grant.execHolderId)
    throw new Error('routing launch authority unavailable');
  const fresh = await checked(grant, grant.hub.getOrder({ workflow: grant.reservation.workflow,
    run: grant.reservation.run, holder: { kind: 'exec', id: grant.execHolderId,
      shiftId: grant.identity.shiftId } }, signal), now, true);
  if (!validOrderResponse(grant, fresh) || !fresh.lease.claimed || !fresh.order)
    throw new Error('routing launch order unavailable');
  // The selection check is read-only. With routed input authority, verify
  // the complete witness once against the fresh, byte-equal order below,
  // after selection has finished. The legacy verifier keeps its old path.
  if (!grant.inputAuthority) await verifyParentOrder(grant, fresh, 'prestart', now);
  await checked(grant, grant.launchAuthority.verifySelection(fresh.order, structuredClone(request)), now, true);
  if (grant.inputAuthority) {
    const { response: final } = await readVerifiedParentOrder(grant,
      { kind: 'exec', id: grant.execHolderId, shiftId: grant.identity.shiftId }, 'prestart', now, signal, fresh.order);
    if (!validOrderResponse(grant, final) || !final.lease.claimed || !final.order
      || !isDeepStrictEqual(final.order, fresh.order))
      throw new Error('routing launch order changed');
  }
}

function collectionResponse(value: unknown, kind: 'member' | 'seal'): value is RoutedCollectionWriteResponse {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.outcome === 'string' && row.outcome.length > 0
    && typeof row.closed === 'boolean'
    && row.conditionApplied === (kind === 'member'
      ? 'routed-collection-member-v1' : 'routed-collection-seal-v1');
}

function collectionOriginalSession(grant: Grant, now: () => number): boolean {
  const current = grant.currentIdentity();
  return !!current && current.sessionId === grant.identity.sessionId
    && current.shiftId === grant.identity.shiftId && current.orgId === grant.identity.orgId
    && current.principalId === grant.identity.principalId && now() < current.expiresAt;
}

function collectionReceiptOnly(grant: Grant, now: () => number): boolean {
  return (grant.terminalReason === 'normal-close' || grant.terminalReason === 'receipt-pending')
    && grant.receiptUntil !== undefined
    && now() < grant.receiptUntil && collectionOriginalSession(grant, now);
}

function conditionalReceiptRequest(grant: Grant) {
  const pending = grant.pendingSubmit;
  if (!pending) throw new Error('routing submission receipt unavailable');
  return { workflow: pending.request.workflow, run: pending.request.run,
    intentId: pending.intentId, requestDigest: pending.requestDigest,
    holder: pending.request.holder as import('../hub/types.ts').RoutedCollectionHolder };
}
function validConditionalReceiptResponse(value: unknown): value is import('../hub/types.ts').RoutedConditionalMutationResponse {
  if (!value || typeof value !== 'object'
    || (value as { conditionApplied?: unknown }).conditionApplied !== 'routed-conditional-receipt-v1')
    return false;
  const response = value as { outcome?: unknown; closed?: unknown };
  if (response.outcome === 'green' || response.outcome === 'submitted' || response.outcome === 'approved')
    return typeof response.closed === 'boolean';
  if (response.outcome === 'born-rejected') return response.closed === true;
  return (response.outcome === 'schema-rejected' || response.outcome === 'group-rejected')
    && response.closed === undefined;
}
/** A failed first mutation ACK may hide an already committed native result.
 * Read only the one frozen request's receipt while its original role child and
 * session remain live. This path never issues a retry generation or write. */
async function readDispatchedConditionalAck(grant: Grant, now: () => number,
  signal: AbortSignal, diagnosticOrigin: 'command-postrun' | 'agent-outcome'): Promise<import('../hub/types.ts').RoutedConditionalMutationResponse> {
  const pending = grant.pendingSubmit;
  const commandPostrun = grant.postrun;
  const agentSolePending = grant.reservation.childKind === 'agent-run'
    && grant.uncertainEffects.size === 1 && grant.uncertainEffects.has('submit')
    && !grant.effectLedgerOverflow && grant.effectLedger.size === 1
    && [...grant.effectLedger.values()][0]?.method === 'submit'
    && [...grant.effectLedger.values()][0]?.requestDigest === pending?.requestDigest
    && grant.inFlightEffects.size === 0;
  if (!pending || !grant.quiescing || (!commandPostrun && !agentSolePending))
    throw new Error('routing submission outcome unresolved');
  const query = conditionalReceiptRequest(grant);
  const started = performance.now();
  let backoff = 100;
  const stillOwned = () => {
    const elapsed = performance.now() - started;
    return grant.pendingSubmit === pending && !signal.aborted
      && grant.postrun === commandPostrun && liveChildValid(grant, now())
      && (commandPostrun !== undefined || grant.uncertainEffects.size === 1
	&& grant.uncertainEffects.has('submit') && grant.inFlightEffects.size === 0
	&& !grant.effectLedgerOverflow && grant.effectLedger.size === 1
	&& [...grant.effectLedger.values()][0]?.requestDigest === pending.requestDigest)
      && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < CONDITIONAL_ACK_READ_MS;
  };
  while (stillOwned()) {
    const remaining = CONDITIONAL_ACK_READ_MS - (performance.now() - started);
    if (!Number.isFinite(remaining) || remaining <= 0) break;
    const readSignal = AbortSignal.any([signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(10_000, remaining))))]);
    try {
      if (diagnosticOrigin === 'agent-outcome' && agentSolePending && !commandPostrun)
	countDiagnostic(grant, 'agentOutcomeReceiptReads');
      const observed = await checked(grant,
	grant.hub.routingConditionalReceipt(query, readSignal), now);
      if (!stillOwned()) break;
      if (!observed || typeof observed !== 'object') break;
      if (observed.state === 'committed') {
	if (!validConditionalReceiptResponse(observed.result)) break;
	if (diagnosticOrigin === 'agent-outcome' && agentSolePending && !commandPostrun
	  && observed.result.closed === true
	  && (observed.result.outcome === 'green' || observed.result.outcome === 'submitted'
	    || observed.result.outcome === 'approved'))
	  countDiagnostic(grant, 'agentOutcomeCommittedClosedReceipts');
	return observed.result;
      }
      if (observed.state !== 'pending') break;
    } catch (error) {
      if (!stillOwned() || error instanceof HubError && error.status !== 429) break;
      if (error instanceof HubError && error.retryAfterMs)
	backoff = Math.max(backoff, error.retryAfterMs);
    }
    const left = CONDITIONAL_ACK_READ_MS - (performance.now() - started);
    if (!Number.isFinite(left) || left <= 0) break;
    try { await delay(Math.min(backoff, left), undefined, { signal }); }
    catch { break; }
    backoff = Math.min(backoff * 2, 2_000);
  }
  throw new Error('routing submission outcome unresolved');
}
async function conditionalReconcile(grant: Grant, now: () => number,
  signal: AbortSignal): Promise<import('../hub/types.ts').RoutedConditionalMutationResponse> {
  if (!collectionReceiptOnly(grant, now)) throw new Error('routing submission receipt unavailable');
  const request = conditionalReceiptRequest(grant);
  countDiagnostic(grant, 'terminalReceiptReads');
  const result = await grant.hub.routingConditionalReceipt(request, signal);
  if (!collectionReceiptOnly(grant, now) || result.state !== 'committed'
    || !validConditionalReceiptResponse(result.result))
    throw new Error('routing submission outcome unresolved');
  return result.result;
}

async function collectionOrder(grant: Grant, sealPath: string, holder: RoutedCollectionHolder,
  now: () => number, signal: AbortSignal): Promise<{ response: GetOrderResponse; binding: string; version: number }> {
  const authority = grant.submissionAuthority;
  if (!authority || !grant.ready || !validateSessionGrant(grant, now()))
    throw new Error('routing collection authority unavailable');
  const { response } = await readVerifiedParentOrder(grant, holder, 'recorded-live', now, signal);
  if (!response.lease.claimed || !response.order) throw new Error('routing collection claim unavailable');
  const binding = submissionBinding(response, sealPath, grant);
  if (authority.canCollect?.(response.order, sealPath) !== true
    || submissionBinding(response, sealPath, grant) !== binding)
    throw new Error('routing collection target unavailable');
  const version = outputVersionForSubmission(response.order, sealPath);
  if (!Number.isSafeInteger(version) || version! < 1) throw new Error('routing collection target unavailable');
  return { response, binding, version: version! };
}

async function collectionFresh(grant: Grant, sealPath: string, holder: RoutedCollectionHolder,
  binding: string, now: () => number, signal: AbortSignal): Promise<void> {
  const fresh = await collectionOrder(grant, sealPath, holder, now, signal);
  if (fresh.binding !== binding) throw new Error('routing collection order changed');
}

function collectionReceiptQuery(grant: Grant, kind: 'member' | 'seal') {
  const { workflow, run } = grant.reservation;
  if (kind === 'member') {
    const pending = grant.collectionMember;
    if (!pending?.issued || !pending.emit) throw new Error('routing collection receipt unavailable');
    return { workflow, run, kind, id: pending.issue.emissionId,
      sealPath: pending.issue.sealPath, sealTargetVersion: pending.issued.sealTargetVersion,
      requestDigest: valueDigestHex(pending.issue), proofDigest: valueDigestHex(pending.emit.proof),
      holder: pending.issue.holder } as const;
  }
  const request = grant.collectionSeal?.request;
  if (!request) throw new Error('routing collection receipt unavailable');
  return { workflow, run, kind, id: request.sealId, sealPath: request.sealPath,
    sealTargetVersion: request.sealTargetVersion, requestDigest: valueDigestHex(request),
    holder: request.holder } as const;
}

async function collectionReconcile(grant: Grant, kind: 'member' | 'seal', now: () => number,
  signal: AbortSignal): Promise<RoutedCollectionWriteResponse> {
  if (!collectionReceiptOnly(grant, now)) throw new Error('routing collection receipt unavailable');
  const receipt = await grant.hub.routingCollectionReceipt(collectionReceiptQuery(grant, kind), signal);
  if (!collectionReceiptOnly(grant, now) || !receipt || receipt.state === 'pending'
    || !collectionResponse(receipt.result, kind)) throw new Error('routing collection outcome unresolved');
  return receipt.result;
}

async function collectionSeal(grant: Grant, sealPath: string, sealId: string,
  holder: RoutedCollectionHolder, now: () => number, signal: AbortSignal): Promise<RoutedCollectionWriteResponse> {
  const intent = valueDigestHex({ sealPath, sealId, holder });
  if (grant.collectionSeal && grant.collectionSeal.intent !== intent)
    throw new Error('routing collection seal outcome unresolved');
  grant.collectionSeal ??= { intent };
  if (grant.collectionSeal.result) return grant.collectionSeal.result;
  if (collectionReceiptOnly(grant, now)) {
    const result = await collectionReconcile(grant, 'seal', now, signal);
    grant.collectionSeal.result = result;
    return result;
  }
  if (!grant.collectionSeal.request) {
    const { response, binding, version } = await collectionOrder(grant, sealPath, holder, now, signal);
    const proof = await checked(grant, grant.submissionAuthority!.sign(response.order!, sealPath, {}, version), now);
    if (typeof proof !== 'string' || !proof) throw new Error('routing collection proof unavailable');
    await collectionFresh(grant, sealPath, holder, binding, now, signal);
    grant.collectionSeal.request = { workflow: grant.reservation.workflow, run: grant.reservation.run,
      sealPath, sealTargetVersion: version, sealId, proof, holder };
  }
  const result = await startEffect(grant, () => grant.hub.routingCollectionSeal(grant.collectionSeal!.request!, signal));
  if (!collectionResponse(result, 'seal') || (!validateSessionGrant(grant, now())
    && !collectionReceiptOnly(grant, now))) throw new Error('routing collection seal outcome unresolved');
  grant.collectionSeal.result = result;
  recordAgentAck(grant, 'seal_collection', result.closed === true);
  grant.uncertainEffects.delete('seal_collection');
  grant.syncUncertainty?.();
  return result;
}

async function collectionEmit(grant: Grant, body: Record<string, unknown>, now: () => number,
  signal: AbortSignal): Promise<unknown> {
  const sealPath = body.sealPath as string;
  const emissionId = body.emissionId as string;
  const holder = body.holder as RoutedCollectionHolder;
  const value = normalizeSubmitValue(body.value);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('routing collection value refused');
  const done = body.done as boolean;
  const intent = valueDigestHex({ sealPath, emissionId, value, done, holder });
  if (grant.collectionMember && grant.collectionMember.intent !== intent) {
    if (!grant.collectionMember.result
      || (grant.collectionMember.done && grant.collectionMember.result.outcome === 'emitted')
      || grant.collectionSeal && !grant.collectionSeal.result)
      throw new Error('routing collection outcome unresolved');
    grant.collectionMember = undefined;
  }
  grant.collectionMember ??= { intent, done, issue: {
    workflow: grant.reservation.workflow, run: grant.reservation.run, sealPath,
    emissionId, valueDigest: valueDigestHex(value), holder } };
  const pending = grant.collectionMember;
  if (!pending.result) {
    if (collectionReceiptOnly(grant, now)) {
      pending.result = await collectionReconcile(grant, 'member', now, signal);
    } else {
      const { response, binding, version } = await collectionOrder(grant, sealPath, holder, now, signal);
      pending.issued ??= await checked(grant,
	startEffect(grant, () => grant.hub.routingCollectionIssue(pending.issue, signal)), now);
      const issued = pending.issued;
      if (!issued || issued.emissionId !== emissionId || issued.sealPath !== sealPath
	|| issued.sealTargetVersion !== version || issued.memberVersion !== 1
	|| issued.valueDigest !== pending.issue.valueDigest
	|| issued.conditionApplied !== 'routed-collection-member-v1'
	|| typeof issued.memberPath !== 'string' || !issued.memberPath)
	throw new Error('routing collection issued target refused');
      if (!pending.emit) {
	await collectionFresh(grant, sealPath, holder, binding, now, signal);
	const proof = await checked(grant, grant.submissionAuthority!.sign(response.order!,
	  issued.memberPath, value, issued.memberVersion), now);
	if (typeof proof !== 'string' || !proof) throw new Error('routing collection proof unavailable');
	await collectionFresh(grant, sealPath, holder, binding, now, signal);
	pending.emit = { workflow: grant.reservation.workflow, run: grant.reservation.run,
	  emissionId, memberPath: issued.memberPath, memberVersion: 1,
	  value: value as Record<string, unknown>, proof, holder };
      }
      const emitRequest = pending.emit;
      if (!emitRequest) throw new Error('routing collection request unavailable');
      const result = await startEffect(grant, () => grant.hub.routingCollectionEmit(emitRequest, signal));
      if (!collectionResponse(result, 'member') || (!validateSessionGrant(grant, now())
	&& !collectionReceiptOnly(grant, now))) throw new Error('routing collection outcome unresolved');
      pending.result = result;
      grant.uncertainEffects.delete('emit_member');
      grant.syncUncertainty?.();
    }
  }
  const member = pending.result;
  if (!member || !pending.issued) throw new Error('routing collection outcome unresolved');
  if (!done || member.outcome !== 'emitted') return { member, issued: pending.issued };
  pending.sealId ??= createHash('sha256').update(`routed-seal:${emissionId}`).digest('hex').slice(0, 32);
  const seal = await collectionSeal(grant, sealPath, pending.sealId, holder, now, signal);
  return { member, seal, issued: pending.issued };
}

function postrunHolder(grant: Grant): ContactHolder {
  if (!grant.execHolderId) throw new Error('routing command holder unavailable');
  return { kind: 'exec', id: grant.execHolderId, shiftId: grant.identity.shiftId };
}

async function postrunClaim(grant: Grant, now: () => number,
  signal: AbortSignal): Promise<'held'> {
  const phase: RoutedInputPhase = grant.acceptedLaunchReport ? 'recorded-live' : 'prestart';
  const { response } = await readVerifiedParentOrder(grant, postrunHolder(grant), phase, now, signal);
  if (!validOrderResponse(grant, response)) throw new Error('routing command claim unavailable');
  if (!response.lease.claimed || !response.order)
    throw new Error('routing command claim unavailable');
  return 'held';
}

/** This is the sole post-freeze write path. The role packet supplies data only;
 * the parent derives every target and the original-session holder. */
async function commandPostrun(grant: Grant, body: unknown, now: () => number,
  signal: AbortSignal): Promise<CommandPostrunResponse> {
  if (grant.reservation.childKind !== 'exec' || !grant.quiescing || !grant.quiesceResult
    || !grant.acceptedLaunchReport || !grant.launchReservationId || !grant.commandFor
    || !grant.submissionAuthority || !grant.inputAuthority || !liveChildValid(grant, now())
    || grant.postrunBusy) throw new Error('routing command postrun unavailable');
  grant.postrunBusy = true;
  try {
    const frozen = await grant.quiesceResult;
    if (frozen.effects !== 'settled' || [...grant.uncertainEffects].some(method =>
      !grant.postrun || method !== 'submit' && method !== 'emit_member'
      && method !== 'seal_collection'))
      throw new Error('routing command prior effects unresolved');
    const current = grant.postrun ? undefined : await verifyCurrentConsequence(grant, 'role', now, signal);
    if (!grant.postrun && (!current?.order || !current.lease.claimed
      || current.order.worker !== 'command' || current.order.owes.length === 0))
      throw new Error('routing command order unavailable');
    const command = grant.postrun?.command ?? await checked(grant, grant.commandFor(current!.order!), now);
    if (!command || !command.trim()) throw new Error('routing command definition unavailable');
    if (current) {
      const repeat = await verifyCurrentConsequence(grant, 'role', now, signal);
      if (!repeat?.order || !isDeepStrictEqual(repeat.order, current.order))
        throw new Error('routing command order changed');
    }
    const snapshot = snapshotCommandPostrun(body, { command,
      orchestrator: postrunHolder(grant).id, workflow: grant.reservation.workflow,
      run: grant.reservation.run, step: grant.postrun?.step ?? current!.order!.step });
    const intent = valueDigestHex({ receipt: snapshot.canonical, result: snapshot.result,
      parsed: snapshot.parsed, group: { scope: 'original-posix-group', state: 'empty' } });
    if (grant.postrun && grant.postrun.intent !== intent)
      throw new Error('routing command postrun intent changed');
    if (!grant.postrun) {
      const paths = current!.order!.owes.map(owe => ({ path: owe.path,
        kind: grant.submissionAuthority!.canCollect?.(current!.order!, owe.path) === true
          ? 'collection' as const : 'singleton' as const }));
      if (paths.some(row => row.kind === 'singleton'
        && grant.submissionAuthority!.canSubmit(current!.order!, row.path) !== true))
        throw new Error('routing command output kind unavailable');
	grant.postrun = { intent, bodyDigest: commandPostrunBodyDigest(body),
	  childGeneration: grant.liveChild!, command, step: current!.order!.step, snapshot, paths, nextOwe: 0,
        ...(current!.order!.judge ? { judge: current!.order!.judge } : {}),
        rejectDone: false, askOrRejectDispatched: false };
    }
    const pending = grant.postrun;
    if (pending.result) return pending.result;
    const value = pending.snapshot.receipt();
    const parsed = pending.snapshot.parsed;
    const holder = postrunHolder(grant);
    const perform = async <T>(method: Method, send: () => Promise<T>): Promise<T> => {
      const context = { dispatched: false, parentPostrun: true };
      try { return await effectContext.run(context, send); }
      catch (error) {
        if (context.dispatched) {
          grant.uncertainEffects.add(method); grant.syncUncertainty?.();
        }
        throw error;
      }
    };
    const reject = async (path: string, text: string): Promise<'closed' | 'held'> => {
      if (pending.askOrRejectDispatched) throw new Error('routing command reject outcome unresolved');
      const fresh = await verifyCurrentConsequence(grant, 'role', now, signal);
      if (!fresh?.order || !fresh.order.inputs.includes(path)
        && fresh.order.judge !== path)
        throw new Error('routing command reject target changed');
      pending.askOrRejectDispatched = true;
      const response = await perform('reject', () => startEffect(grant, () =>
        grant.hub.routingReject({ workflow: grant.reservation.workflow,
          run: grant.reservation.run, path, text }, signal)));
      if (!response || response.ok !== true || typeof response.closed !== 'boolean')
        throw new Error('routing command reject outcome unresolved');
      if (!response.closed) await postrunClaim(grant, now, signal);
      grant.uncertainEffects.delete('reject'); grant.syncUncertainty?.();
      return response.closed ? 'closed' : 'held';
    };
    if (!pending.rejectDone && !pending.judge && parsed.reject) {
      const tail = value.outputTail.replace(/\n+$/, '');
      const text = tail ? `${parsed.reject.text}\n\n--- command output (last ${Buffer.byteLength(tail, 'utf8')} bytes) ---\n${tail}`
	: parsed.reject.text;
      const claim = await reject(parsed.reject.path, text);
      pending.rejectDone = true;
      pending.askOrRejectDispatched = false;
      if (claim === 'closed') return pending.result = { outcome: 'rejected', claim };
    }
    if (pending.judge && pending.snapshot.result.exitCode !== 0) {
      const reason = value.payload && typeof value.payload === 'object'
        && !Array.isArray(value.payload) && typeof (value.payload as Record<string, unknown>).reason === 'string'
        ? (value.payload as Record<string, string>).reason : undefined;
      const text = reason?.trim() || value.outputTail ||
        `judge command exited with code ${pending.snapshot.result.exitCode}`;
      const claim = await reject(pending.judge, text);
      return pending.result = { outcome: 'judge-rejected', claim };
    }
    if (pending.snapshot.result.exitCode !== 0) {
      if (pending.askOrRejectDispatched) throw new Error('routing command ask outcome unresolved');
      const path = pending.paths[0]!.path;
      const fresh = await verifyCurrentConsequence(grant, 'role', now, signal);
      if (!fresh?.order?.owes.some(owe => owe.path === path))
        throw new Error('routing command ask target changed');
      pending.askOrRejectDispatched = true;
      const question = `the command for step '${value.step}' exited ${value.exitCode}, so '${path}' was not produced and no receipt was submitted`;
      const response = await perform('ask', () => startEffect(grant, () =>
        grant.hub.routingAsk({ workflow: grant.reservation.workflow, run: grant.reservation.run,
          path, question, context: pending.snapshot.canonical.slice(0, 16_384) }, signal)));
      if (!response || response.ok !== true || response.closed !== true)
        throw new Error('routing command ask outcome unresolved');
      grant.uncertainEffects.delete('ask'); grant.syncUncertainty?.();
      return pending.result = { outcome: 'command-failed', claim: 'closed' };
    }
    while (pending.nextOwe < pending.paths.length) {
      const { path, kind } = pending.paths[pending.nextOwe]!;
      // An exact seal may already have closed the claim while its ACK was
      // lost. Service permits only the latched identical seal replay under
      // the original session; a fresh get_order now correctly refuses.
      const exactSealReplay = kind === 'collection' && !!grant.collectionSeal?.request
        && !grant.collectionSeal.result;
      // A terminal conditional submit may have committed before its ACK was
      // lost. Its frozen receipt is readable without get_order; the closed
      // native claim deliberately refuses a fresh order read.
      const exactSubmitReplay = kind === 'singleton' && !!grant.pendingSubmit;
      if (!exactSealReplay && !exactSubmitReplay) {
        const fresh = await verifyCurrentConsequence(grant, 'role', now, signal);
        if (!fresh?.order?.owes.some(owe => owe.path === path))
          throw new Error('routing command output target changed');
      }
      if (kind === 'collection') {
        const emissionId = createHash('sha256').update(`routed-command:${pending.intent}:${path}`).digest('hex').slice(0, 32);
        const answer = await perform('emit_member', () => collectionEmit(grant,
          { sealPath: path, emissionId, value: pending.snapshot.receipt(), done: true, holder },
          now, signal)) as { member?: RoutedCollectionWriteResponse; seal?: RoutedCollectionWriteResponse };
        if (answer.member?.outcome !== 'emitted' || answer.seal?.outcome !== 'sealed')
          throw new Error('routing command collection outcome unresolved');
        pending.terminalClosed = answer.seal.closed;
      } else {
	const answer = await perform('submit', () => submitFromParent(grant,
	  { path, value: pending.snapshot.receipt(), holder }, now, signal, true)) as
	  import('../hub/types.ts').RoutedConditionalMutationResponse;
	if (answer.outcome !== 'green' && answer.outcome !== 'submitted') {
	  // Native CAS loss is an authenticated failed-run close. Schema and
		  // other accepted refusals require a fresh held-claim witness before the
		  // role can finish. No later owed path receives this immutable receipt.
	  const claim = answer.closed === true ? 'closed' : await postrunClaim(grant, now, signal);
	  grant.pendingSubmit = undefined;
	  grant.uncertainEffects.delete('submit'); grant.syncUncertainty?.();
	  return pending.result = { outcome: 'submit-rejected', claim };
	}
        if (typeof answer.closed !== 'boolean')
          throw new Error('routing command submit closure unavailable');
        pending.terminalClosed = answer.closed;
      }
      grant.uncertainEffects.delete(kind === 'collection' ? 'emit_member' : 'submit');
      grant.syncUncertainty?.();
      pending.nextOwe += 1;
      if (pending.terminalClosed && pending.nextOwe < pending.paths.length)
        throw new Error('routing command closed before all outputs');
    }
    const claim = pending.terminalClosed ? 'closed' : await postrunClaim(grant, now, signal);
    return pending.result = { outcome: 'submitted', claim };
  } finally { grant.postrunBusy = false; }
}

/** A lost child-facing ACK can read only a result already authenticated and
 * cached by this parent. It never invokes Hub or advances a postrun intent. */
async function commandPostrunStatus(grant: Grant, body: unknown, now: () => number,
  signal: AbortSignal): Promise<CommandPostrunStatus> {
  if (!exactKeys(body, ['bodyDigest']) || typeof body.bodyDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(body.bodyDigest)
    || grant.reservation.childKind !== 'exec' || !grant.quiescing || !grant.quiesceResult
    || !grant.acceptedLaunchReport || signal.aborted || !liveChildValid(grant, now()))
    throw new Error('routing command postrun status unavailable');
  const postrun = grant.postrun;
  if (!postrun || postrun.bodyDigest !== body.bodyDigest
    || postrun.childGeneration !== grant.liveChild)
    return { state: 'unavailable' };
  const frozen = await grant.quiesceResult;
  if (signal.aborted || !liveChildValid(grant, now())
    || postrun !== grant.postrun || postrun.childGeneration !== grant.liveChild)
    throw new Error('routing command postrun status revoked');
  if (frozen.effects !== 'settled' || grant.pendingSubmit
    || grant.inFlightEffects.size || grant.uncertainEffects.size || grant.effectLedger.size
    || grant.effectLedgerOverflow || grant.collectionBusy
    || grant.postrunRelease?.dispatched && !grant.postrunRelease.response
    || grant.collectionMember?.emit && !grant.collectionMember.result
    || grant.collectionSeal?.request && !grant.collectionSeal.result)
    return { state: 'unavailable' };
  if (!postrun.result) return { state: grant.postrunBusy ? 'pending' : 'unavailable' };
  if (postrun.result.claim === 'uncertain') return { state: 'unavailable' };
  return { state: 'committed', result: postrun.result };
}

async function commandFinish(grant: Grant, body: unknown, now: () => number,
  signal: AbortSignal): Promise<{ state: 'released' | 'already-closed' | 'uncertain' }> {
  const noStart = exactKeys(body, ['observation']) && body.observation === 'not-started';
  const settledGroup = exactKeys(body, ['group']) && exactKeys(body.group, ['scope', 'state'])
    && body.group.scope === 'original-posix-group' && body.group.state === 'empty';
  if (!noStart && !settledGroup)
    throw new Error('routing command group unsettled');
  if (grant.reservation.childKind !== 'exec' || !grant.quiescing || !grant.quiesceResult
    || (settledGroup && !grant.acceptedLaunchReport)
    || (noStart && grant.postrun)
    || !liveChildValid(grant, now()) || grant.postrunBusy)
    throw new Error('routing command finish unavailable');
  const frozen = await grant.quiesceResult;
  if (frozen.effects !== 'settled' || grant.uncertainEffects.size)
    return { state: 'uncertain' };
  if (grant.postrun && !grant.postrun.result) return { state: 'uncertain' };
  if (grant.postrunRelease?.response) return { state: 'released' };
  if (grant.postrunRelease?.dispatched) return { state: 'uncertain' };
  if (grant.postrun?.result?.claim === 'closed') return { state: 'already-closed' };
  if (noStart && !grant.acceptedLaunchReport) {
    // The scoped claim read still applies Service's startup preference bound.
    // A refusal at that boundary remains held for native TTL/reap; it cannot
    // authorize a stale new start or an unscoped release fallback.
    const current = await checked(grant, grant.hub.readRoutingClaim({ workflow: grant.reservation.workflow,
      run: grant.reservation.run }, signal), now);
    if (current.freshness !== 'fresh-at-read' || current.atomicLaunch !== false
      || !isDeepStrictEqual(current.routing, grant.routing))
      throw new Error('routing command claim changed');
  } else await postrunClaim(grant, now, signal);
  const reason = 'routed-command-finished';
  grant.postrunRelease = { reason, dispatched: true };
  const context = { dispatched: false, parentPostrun: true };
  try {
    const response = await effectContext.run(context, () => startEffect(grant, () => {
      countDiagnostic(grant, 'releaseDispatched');
      return grant.hub.routingRelease({ workflow: grant.reservation.workflow,
	run: grant.reservation.run, reason }, signal);
    }));
    if (!response || response.released !== true)
      throw new Error('routing command release outcome unresolved');
    grant.postrunRelease.response = response;
    return { state: 'released' };
  } catch {
    grant.uncertainEffects.add('command_finish'); grant.syncUncertainty?.();
    return { state: 'uncertain' };
  }
}

/** A routed agent may inspect only parent-retained Service mutation results
 * after the role and holder are frozen and its original group is observed
 * empty. An exact conditional receipt may resolve its own lost ACK, but never
 * an unrelated upload, collection, ask or reject effect. */
async function agentOutcome(grant: Grant, body: unknown, now: () => number,
  signal: AbortSignal): Promise<{ claim: 'closed' | 'held' | 'uncertain' }> {
  const groupEmpty = exactKeys(body, ['group']) && exactKeys(body.group, ['scope', 'state'])
    && body.group.scope === 'original-posix-group' && body.group.state === 'empty';
  if (!groupEmpty || grant.reservation.childKind !== 'agent-run' || !grant.quiescing
    || !grant.quiesceResult || !grant.acceptedLaunchReport || !grant.launchReservationId
    || signal.aborted || !liveChildValid(grant, now())) throw new Error('routing agent outcome unavailable');
  countDiagnostic(grant, 'agentOutcomeAccepted');
  await grant.quiesceResult;
  if (signal.aborted || !liveChildValid(grant, now())) {
    countDiagnostic(grant, 'agentOutcomeUncertainReturns');
    return { claim: 'uncertain' };
  }
  if (grant.inFlightEffects.size > 0) {
    countDiagnostic(grant, 'agentOutcomeUncertainReturns');
    return { claim: 'uncertain' };
  }
  if (grant.pendingSubmit && grant.uncertainEffects.size === 1
    && grant.uncertainEffects.has('submit')) {
    try {
      countDiagnostic(grant, 'agentOutcomeRecoveryEntries');
      const response = await readDispatchedConditionalAck(grant, now, signal, 'agent-outcome');
      if (!liveChildValid(grant, now())) {
	countDiagnostic(grant, 'agentOutcomeUncertainReturns');
	return { claim: 'uncertain' };
      }
      const [effectId, effect] = [...grant.effectLedger.entries()][0] ?? [];
      if (effectId === undefined || effect?.method !== 'submit'
	|| effect.requestDigest !== grant.pendingSubmit?.requestDigest) {
	countDiagnostic(grant, 'agentOutcomeUncertainReturns');
	return { claim: 'uncertain' };
      }
      if (response.closed === true && (response.outcome === 'green'
	|| response.outcome === 'submitted' || response.outcome === 'approved'))
	countDiagnostic(grant, 'agentOutcomeRecoveredClosedSubmits');
      recordAgentAck(grant, 'submit', response.closed === true);
      grant.pendingSubmit = undefined;
      grant.effectLedger.delete(effectId);
      grant.uncertainEffects.delete('submit'); grant.syncUncertainty?.();
    } catch {
      countDiagnostic(grant, 'agentOutcomeUncertainReturns');
      return { claim: 'uncertain' };
    }
  }
  if (grant.pendingSubmit || grant.uncertainEffects.size > 0
    || grant.effectLedgerOverflow || grant.effectLedger.size > 0 || grant.agentAckOverflow) {
    countDiagnostic(grant, 'agentOutcomeUncertainReturns');
    return { claim: 'uncertain' };
  }
  if (grant.agentAcks.some(ack => ack.closed)) {
    grant.agentOutcome = 'closed';
    countDiagnostic(grant, 'agentOutcomeClosedReturns');
    return { claim: 'closed' };
  }
  try {
    const current = await verifyCurrentConsequence(grant, 'role', now, signal);
    if (!current?.lease.claimed || !current.order || !liveChildValid(grant, now())) {
      countDiagnostic(grant, 'agentOutcomeUncertainReturns');
      return { claim: 'uncertain' };
    }
    grant.agentOutcome = 'held';
    countDiagnostic(grant, 'agentOutcomeHeldReturns');
    return { claim: 'held' };
  } catch {
    countDiagnostic(grant, 'agentOutcomeUncertainReturns');
    return { claim: 'uncertain' };
  }
}

/** Release is a separate, one-use parent operation. A closed ACK needs no
 * follow-up get_order; a held result needs a fresh parent-internal witness. */
async function agentFinish(grant: Grant, body: unknown, now: () => number,
  signal: AbortSignal): Promise<{ state: 'released' | 'already-closed' | 'uncertain' }> {
  const noStart = exactKeys(body, ['observation']) && body.observation === 'not-started';
  const groupEmpty = exactKeys(body, ['group']) && exactKeys(body.group, ['scope', 'state'])
    && body.group.scope === 'original-posix-group' && body.group.state === 'empty';
  if ((!noStart && !groupEmpty) || grant.reservation.childKind !== 'agent-run'
    || !grant.quiescing || !grant.quiesceResult || signal.aborted || !liveChildValid(grant, now())
    || groupEmpty && !grant.acceptedLaunchReport)
    throw new Error('routing agent finish unavailable');
  countDiagnostic(grant, 'agentFinishAccepted');
  await grant.quiesceResult;
  if (signal.aborted || !liveChildValid(grant, now())) return { state: 'uncertain' };
  if (grant.inFlightEffects.size || grant.uncertainEffects.size || grant.pendingSubmit)
    return { state: 'uncertain' };
  if (grant.agentRelease?.response) return { state: 'released' };
  if (grant.agentRelease?.dispatched) return { state: 'uncertain' };
  if (grant.agentOutcome === 'closed') return { state: 'already-closed' };
  if (groupEmpty) {
    if (grant.agentOutcome !== 'held') return { state: 'uncertain' };
    try {
      const current = await verifyCurrentConsequence(grant, 'role', now, signal);
      if (!current?.lease.claimed || !current.order || !liveChildValid(grant, now()))
	return { state: 'uncertain' };
    }
    catch { return { state: 'uncertain' }; }
  } else {
    // Before the start latch, no worker result exists. An original-session
    // current claim read still obeys the startup preference fence.
    if (grant.agentOutcome || grant.agentAcks.length || grant.agentAckOverflow)
      return { state: 'uncertain' };
    try {
      const current = await checked(grant, grant.hub.readRoutingClaim({
	workflow: grant.reservation.workflow, run: grant.reservation.run }, signal), now);
      if (current.freshness !== 'fresh-at-read' || current.atomicLaunch !== false
	|| current.routing.claim.state !== 'claimed'
	|| !isDeepStrictEqual(current.routing, grant.routing)) return { state: 'uncertain' };
    } catch { return { state: 'uncertain' }; }
  }
  grant.agentRelease = { dispatched: true };
  const context = { dispatched: false, parentPostrun: true };
  try {
    if (signal.aborted || !liveChildValid(grant, now()))
      throw new Error('routing agent release revoked');
    const response = await effectContext.run(context, () => startEffect(grant, () => {
      countDiagnostic(grant, 'releaseDispatched');
      return grant.hub.routingRelease({ workflow: grant.reservation.workflow,
	run: grant.reservation.run, reason: 'routed-agent-finished' }, signal);
    }));
    if (!response || response.released !== true || signal.aborted
      || !liveChildValid(grant, now()))
      throw new Error('routing agent release outcome unresolved');
    grant.agentRelease.response = response;
    return { state: 'released' };
  } catch {
    grant.uncertainEffects.add('agent_finish'); grant.syncUncertainty?.();
    return { state: 'uncertain' };
  }
}

async function invoke(grant: Grant, scope: CapScope, method: Method, body: unknown, now: () => number,
  signal: AbortSignal): Promise<unknown> {
  if (method === 'quiesce') {
    if (scope !== 'role' || !exactKeys(body, []) || !grant.ready
      || !validateSessionGrant(grant, now())) throw new Error('routing broker request refused');
    countDiagnostic(grant, 'quiesceAccepted');
    return quiesceGrant(grant);
  }
  if (method === 'command_postrun') {
    if (scope !== 'role') throw new Error('routing broker request refused');
    return commandPostrun(grant, body, now, signal);
  }
  if (method === 'command_postrun_status') {
    if (scope !== 'role') throw new Error('routing broker request refused');
    return commandPostrunStatus(grant, body, now, signal);
  }
  if (method === 'command_finish') {
    if (scope !== 'role') throw new Error('routing broker request refused');
    return commandFinish(grant, body, now, signal);
  }
  if (method === 'agent_outcome' || method === 'agent_finish') {
    if (scope !== 'role') throw new Error('routing broker request refused');
    return method === 'agent_outcome' ? agentOutcome(grant, body, now, signal)
      : agentFinish(grant, body, now, signal);
  }
  if (grant.quiescing && method !== 'heartbeat'
    && !((method === 'emit_member' || method === 'seal_collection')
      && collectionReceiptOnly(grant, now))) throw new Error('routing broker quiescing');
  if (scope === 'holder' && method !== 'get_order' && method !== 'heartbeat' && method !== 'submit'
    && method !== 'ask' && method !== 'reject' && method !== 'emit_member'
    && method !== 'seal_collection' && method !== 'collection_target')
    throw new Error('routing broker request refused');
  if (method === 'emit_member' || method === 'seal_collection') {
    if (!exactKeys(body, method === 'emit_member'
      ? ['sealPath', 'emissionId', 'value', 'done', 'holder']
      : ['sealPath', 'sealId', 'holder'])
      || typeof body.sealPath !== 'string' || !body.sealPath
      || !grant.allowedPaths?.has(body.sealPath)
      || !validHolder(grant, scope, body.holder)
      || (method === 'emit_member' && (!/^[a-f0-9]{32,64}$/.test(body.emissionId as string)
	|| typeof body.done !== 'boolean'))
      || (method === 'seal_collection' && !/^[a-f0-9]{32,64}$/.test(body.sealId as string))
      || grant.collectionBusy
      || !(validateSessionGrant(grant, now()) || collectionReceiptOnly(grant, now)))
      throw new Error('routing broker request refused');
    grant.collectionBusy = true;
    try {
      return method === 'emit_member' ? await collectionEmit(grant, body, now, signal)
	: await collectionSeal(grant, body.sealPath, body.sealId as string,
	  body.holder as RoutedCollectionHolder, now, signal);
    } finally { grant.collectionBusy = false; }
  }
  const launch = method === 'get_launch_order' || method === 'assess_local_model'
    || method === 'reserve_launch' || method === 'report_launch'
    || method === 'read_routed_reference_v2' || method === 'read_routing_claim_v2'
    || method === 'read_routed_pair_v2';
  if (!grant.ready || !(launch ? validateLaunchGrant(grant, now()) : validateSessionGrant(grant, now())))
    throw new Error('routing broker grant expired');
  const { workflow, run, childKind } = grant.reservation;
  switch (method) {
    case 'collection_target': {
      if (!exactKeys(body, ['path', 'holder']) || typeof body.path !== 'string'
	|| !grant.allowedPaths?.has(body.path) || !validHolder(grant, scope, body.holder))
	throw new Error('routing broker request refused');
      const { response } = await readVerifiedParentOrder(grant, body.holder as ContactHolder,
	'recorded-live', now, signal);
      if (!validOrderResponse(grant, response) || !response.lease.claimed || !response.order
	|| !grant.submissionAuthority) throw new Error('routing collection order unavailable');
	  return { collection: grant.submissionAuthority.canCollect?.(response.order, body.path) === true };
    }
    case 'get_launch_order':
    case 'get_order': {
      if (!exactKeys(body, ['holder']) || !validHolder(grant, scope, body.holder)) throw new Error('routing broker request refused');
      if (!grant.submissionAuthority) throw new Error('routing order authority unavailable');
      const prestart = method === 'get_launch_order';
      if (prestart && (!grant.reservationRequest || !grant.acceptedLaunchReport || !grant.launchAuthority
	|| grant.launchExpiresAt === undefined || now() >= grant.launchExpiresAt))
	throw new Error('routing launch report unavailable');
      // General get_order also observes closure/lease loss. Preserve its plain
      // read and claimed-only verification; no composite-failure downgrade.
      let response = await checked(grant, grant.hub.getOrder({ workflow, run,
	holder: body.holder }, signal), now, prestart);
      if (!validOrderResponse(grant, response)) throw new Error('routing broker response refused');
      if (response.lease.claimed && response.order && (!prestart || !grant.inputAuthority))
	await verifyParentOrder(grant, response, prestart || scope === 'role'
	  && (!grant.acceptedLaunchReport || !liveChildValid(grant, now()))
	  ? 'prestart' : 'recorded-live', now);
      if (prestart) {
	if (!response.lease.claimed || !response.order) throw new Error('routing launch order unavailable');
	await checked(grant, grant.launchAuthority!.verifySelection(response.order,
	  structuredClone(grant.reservationRequest!)), now, true);
	if (now() >= grant.launchExpiresAt!) throw new Error('routing launch reservation expired');
	if (grant.inputAuthority) {
	  const { response: final } = await readVerifiedParentOrder(grant, body.holder as ContactHolder,
	    'prestart', now, signal, response.order);
	  if (!validOrderResponse(grant, final) || !final.lease.claimed || !final.order
	    || !isDeepStrictEqual(final.order, response.order))
	    throw new Error('routing launch order changed');
	  response = final;
	}
      }
      const order = response.order;
      grant.allowedPaths = order && response.lease.claimed
	? new Set((order.owes.length ? order.owes.map(owe => owe.path) : order.outputs))
	: undefined;
      grant.consumedPaths = order && response.lease.claimed && order.consumes
	&& typeof order.consumes === 'object' && !Array.isArray(order.consumes)
	? new Set(Object.keys(order.consumes)) : undefined;
      grant.consumedFiles = consumedFiles(response);
      return response;
    }
    case 'read_routing_claim':
      if (!exactKeys(body, [])) throw new Error('routing broker request refused');
      return checked(grant, grant.hub.readRoutingClaim({ workflow, run }, signal), now);
    case 'read_routed_pair_v2': {
      // This is one parent observation. The underlying Service reference and
      // claim reads remain sequential and are independently checked by the
      // input authority; no result is cached across child requests.
      if (scope !== 'role' || !exactKeys(body, []) || !grant.inputAuthority
	|| !grant.execHolderId) throw new Error('routing broker pair refused');
      const holder: ContactHolder = { kind: 'exec', id: grant.execHolderId,
	shiftId: grant.identity.shiftId };
      const { response, pair } = await readVerifiedParentOrder(grant, holder, 'prestart', now, signal);
      if (!validOrderResponse(grant, response) || !response.lease.claimed || !response.order)
	throw new Error('routing broker pair refused');
      if (!pair || !validateLaunchGrant(grant, now()) || !grant.active || !grant.ready)
	throw new Error('routing broker pair refused');
      const reference = parseRoutedReferenceV2(pair.reference, { workflow, run });
      const claim = parseRoutedClaimV2(pair.claim, { workflow, run });
      if (reference.state !== 'available' || claim.state !== 'available'
	|| reference.binding.frameWorkflow !== grant.routing.claim.binding.frameId
	|| reference.binding.run !== run
	|| reference.binding.rootWorkflow !== workflow
	|| reference.binding.sessionId !== grant.identity.sessionId
	|| reference.binding.shiftId !== grant.identity.shiftId
	|| reference.binding.routingDigest !== valueDigestHex(grant.routing)
	|| !isDeepStrictEqual(reference.binding, claim.binding)
	|| !isDeepStrictEqual(reference.order.routing, claim.routing))
	throw new Error('routing broker pair refused');
      return { protocol: 'routed-prestart-pair-v2', phase: 'prestart', reference, claim };
    }
    case 'read_routed_reference_v2':
    case 'read_routing_claim_v2': {
      if (!exactKeys(body, []) || !grant.routedV2Read) throw new Error('routing broker request refused');
      const kind = method === 'read_routed_reference_v2' ? 'reference' : 'claim';
      const expected = { workflow, run };
      if (grant.inputAuthority) {
	if (!grant.execHolderId) throw new Error('routing order holder unavailable');
	const holder: ContactHolder = scope === 'role'
	  ? { kind: 'exec', id: grant.execHolderId, shiftId: grant.identity.shiftId }
	  : { kind: 'session', id: grant.identity.sessionId, shiftId: grant.identity.shiftId };
	const { pair } = await readVerifiedParentOrder(grant, holder, 'prestart', now, signal);
	if (!pair) throw new Error('routing input observation unavailable');
	return kind === 'reference' ? pair.reference : pair.claim;
      }
      const result = await checked(grant, grant.routedV2Read(kind, expected), now, true);
      if (kind === 'reference') {
	const parsed = parseRoutedReferenceV2(result, expected);
	if (parsed.state === 'available') {
	  if (parsed.binding.sessionId !== grant.identity.sessionId
	    || parsed.binding.shiftId !== grant.identity.shiftId
	    || parsed.binding.claimId !== grant.routing.claim.claimId
	    || parsed.binding.decisionId !== grant.routing.claim.decisionId
	    || parsed.binding.routingDigest !== valueDigestHex(grant.routing)
	    || (grant.referenceOrderDigest && grant.referenceOrderDigest !== parsed.binding.orderDigest))
	    throw new Error('routing broker reference changed');
	  if (grant.referenceBinding && !isDeepStrictEqual(grant.referenceBinding, parsed.binding))
	    throw new Error('routing broker reference changed');
	  grant.referenceOrderDigest = parsed.binding.orderDigest;
	  grant.referenceBinding = structuredClone(parsed.binding);
	}
	return parsed;
      }
      return parseRoutedClaimV2(result, expected);
    }
    case 'read_live_routed_reference_v2':
    case 'read_live_routing_claim_v2': {
      if (scope !== 'role' || !exactKeys(body, []) || !grant.routedLiveV2Read
	|| !grant.referenceOrderDigest || !grant.launchReservationId || !grant.acceptedLaunchReport
	|| !liveChildValid(grant, now())) throw new Error('routing broker live read refused');
      const kind = method === 'read_live_routed_reference_v2' ? 'reference' : 'claim';
      const expected = { workflow, run };
      if (grant.inputAuthority) {
	if (!grant.execHolderId) throw new Error('routing order holder unavailable');
	const holder: ContactHolder = { kind: 'exec', id: grant.execHolderId,
	  shiftId: grant.identity.shiftId };
	const { pair } = await readVerifiedParentOrder(grant, holder, 'recorded-live', now, signal);
	if (!pair || !liveChildValid(grant, now()))
	  throw new Error('routing recorded input changed');
	return kind === 'reference' ? pair.reference : pair.claim;
      }
      let result: RecordedReferenceV2 | RecordedClaimV2;
      try { result = await grant.routedLiveV2Read(kind, expected); }
      catch (error) {
	if (!liveChildValid(grant, now())) throw new Error('routing broker live read revoked');
	throw error;
      }
      if (!liveChildValid(grant, now())) throw new Error('routing broker live read revoked');
      if (kind === 'reference') {
	const parsed = parseRecordedReferenceV2(result, expected);
	if (parsed.state === 'available' && !recordedBindingMatches(grant, parsed.binding))
	  throw new Error('routing broker recorded occurrence changed');
	if (!liveChildValid(grant, now())) throw new Error('routing broker live read revoked');
	return parsed;
      }
      const parsed = parseRecordedClaimV2(result, expected);
      if (parsed.state === 'available' && !recordedBindingMatches(grant, parsed.binding))
	throw new Error('routing broker recorded occurrence changed');
      if (!liveChildValid(grant, now())) throw new Error('routing broker live read revoked');
      return parsed;
    }
    case 'assess_local_model':
      if (!exactKeys(body, ['candidateIds']) || !orderedCandidates(grant, body.candidateIds)
	|| childKind !== 'agent-run' || !grant.routing.preference.localModel
	|| body.candidateIds.length === 0) throw new Error('routing broker request refused');
      return checked(grant, grant.hub.assessLocalModel({ workflow, run, candidateIds: body.candidateIds }, signal), now, true);
    case 'reserve_launch': {
      if (!exactKeys(body, ['request']) || !exactKeys(body.request, [
	'version', 'claimId', 'decisionId', 'binding', 'orderId', 'attemptId', 'rosterRevision',
	'candidateIds', 'assessmentId', 'requested', 'selected',
      ])) throw new Error('routing broker request refused');
      const request = body.request as unknown as LaunchReservationRequestV1;
      if (request.version !== 'launch-reservation-v1' || !exactBinding(grant, request)
	|| request.rosterRevision !== grant.routing.preference.rosterRevision
	|| !orderedCandidates(grant, request.candidateIds)
	|| (request.assessmentId !== null && (typeof request.assessmentId !== 'string' || !request.assessmentId))
	|| (grant.routing.preference.localModel
	  ? (childKind !== 'agent-run' || request.assessmentId === null || request.candidateIds.length === 0)
	  : request.assessmentId !== null)
	|| !selectedTuple(grant, request.requested) || !selectedTuple(grant, request.selected)
	|| (childKind === 'exec' && (request.candidateIds.length !== 0 || request.selected !== null
	  || request.requested !== null || request.assessmentId !== null))
	|| (childKind === 'agent-run' && (request.selected === null || request.candidateIds.length === 0
	  || !request.candidateIds.includes(request.selected.id)
	  || (request.requested !== null && !request.candidateIds.includes(request.requested.id)))))
	throw new Error('routing broker request refused');
      if (grant.reservationRequest && !isDeepStrictEqual(grant.reservationRequest, request))
	throw new Error('routing broker reservation changed');
      await verifyParentLaunch(grant, request, now, signal);
      const response = await checked(grant,
	startEffect(grant, () => grant.hub.reserveLaunch({ workflow, request }, signal)), now, true);
      const current = grant.currentIdentity();
      if (!response || response.orderId !== run || typeof response.reservationId !== 'string'
	|| !response.reservationId || !Number.isSafeInteger(response.expiresAt) || response.expiresAt <= now()
	|| !current || response.expiresAt > Math.min(current.expiresAt,
	  grant.routing.preference.expiresAt, grant.routing.claim.binding.expiresAt))
	throw new Error('routing broker reservation refused');
      grant.reservationRequest = structuredClone(request);
      grant.launchReservationId = response.reservationId;
      grant.launchExpiresAt = response.expiresAt;
      // An idempotent reservation refresh still needs its matching report ACK
      // before a launch read; an older accepted report cannot authorize it.
      grant.acceptedLaunchReport = undefined;
      return response;
    }
    case 'report_launch': {
      if (!exactKeys(body, ['report']) || !exactKeys(body.report, [
	'version', 'reservationId', 'decisionId', 'binding', 'claimId', 'orderId', 'attemptId',
	'requested', 'selected', 'observation',
      ])) throw new Error('routing broker request refused');
      const report = body.report as unknown as LaunchReportV1;
      if (!grant.reservationRequest || !grant.launchReservationId || report.version !== 'launch-v1'
	|| report.reservationId !== grant.launchReservationId || !exactBinding(grant, report)
	|| !sameTuple(report.requested, grant.reservationRequest.requested)
	|| !sameTuple(report.selected, grant.reservationRequest.selected)
	|| !exactObservation(report.observation, grant.reservationRequest.selected))
	throw new Error('routing broker request refused');
      await verifyParentLaunch(grant, grant.reservationRequest, now, signal);
      {
	const response = await checked(grant,
	  startEffect(grant, () => grant.hub.reportLaunch({ workflow, report }, signal)), now, true);
	if (!response || response.orderId !== run || response.digest !== valueDigestHex(report)
	  || response.provenance !== 'authenticated-worker-report'
	  || !Number.isSafeInteger(response.recordedAt) || response.recordedAt < 0)
	  throw new Error('routing launch report acknowledgement refused');
	grant.acceptedLaunchReport = response.digest;
	return response;
      }
    }
    case 'heartbeat':
      if (!exactKeys(body, ['holder']) || !validHolder(grant, scope, body.holder)) throw new Error('routing broker request refused');
      {
	const phase: RoutedInputPhase = grant.acceptedLaunchReport && liveChildValid(grant, now())
	  ? 'recorded-live' : 'prestart';
	await verifyCurrentConsequence(grant, scope, now, signal, phase);
	const response = await checked(grant, grant.hub.routingHeartbeat({ workflow, run, holder: body.holder }, signal), now);
	if (!response || (response as { ok?: unknown }).ok !== true) throw new Error('routing broker response refused');
	return response;
      }
    case 'submit': {
      if (!exactKeys(body, ['path', 'value', 'holder'])
	&& !exactKeys(body, ['path', 'value', 'holder', 'done'])) throw new Error('routing broker request refused');
      if (typeof body.path !== 'string' || !body.path || !grant.allowedPaths?.has(body.path)
	|| !validHolder(grant, scope, body.holder)
	|| (body.done !== undefined && typeof body.done !== 'boolean'))
	throw new Error('routing broker request refused');
      countDiagnostic(grant, scope === 'holder' ? 'holderSubmitsAccepted' : 'roleSubmitsAccepted');
      const response = await submitFromParent(grant, body, now, signal) as
	import('../hub/types.ts').RoutedConditionalMutationResponse;
      if (grant.reservation.childKind === 'agent-run') {
	if (!validConditionalReceiptResponse(response))
	  throw new Error('routing agent submit acknowledgement refused');
	recordAgentAck(grant, 'submit', response.closed === true);
      }
      return response;
    }
    case 'release':
      if (!exactKeys(body, []) && !exactKeys(body, ['reason'])) throw new Error('routing broker request refused');
      if (body.reason !== undefined && (typeof body.reason !== 'string' || [...body.reason].length > 1024))
	throw new Error('routing broker request refused');
      {
	const reason = body.reason as string | undefined;
	const response = await checked(grant, startEffect(grant, () => {
	  countDiagnostic(grant, 'releaseDispatched');
	  return grant.hub.routingRelease({ workflow, run,
	    ...(reason === undefined ? {} : { reason }) }, signal);
	}), now);
	if (!response || typeof response.released !== 'boolean') throw new Error('routing broker response refused');
	return response;
      }
    case 'ask': {
      if (!exactKeys(body, ['path', 'question']) && !exactKeys(body, ['path', 'question', 'context']))
	throw new Error('routing broker request refused');
      if (typeof body.path !== 'string' || !grant.allowedPaths?.has(body.path)
	|| typeof body.question !== 'string' || !body.question.trim()
	|| (body.context !== undefined && typeof body.context !== 'string'))
	throw new Error('routing broker request refused');
      const current = await verifyCurrentConsequence(grant, scope, now, signal);
      if (current?.order && !current.order.owes.some(owe => owe.path === body.path))
	throw new Error('routing current ask target changed');
      const path = body.path as string;
      const question = body.question as string;
      const context = body.context as string | undefined;
      const response = await checked(grant, startEffect(grant, () => grant.hub.routingAsk({ workflow, run, path,
	question, ...(context === undefined ? {} : { context }) }, signal)), now);
      if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'string'
	|| grant.reservation.childKind === 'agent-run' && typeof response.closed !== 'boolean')
	throw new Error('routing broker response refused');
      if (grant.reservation.childKind === 'agent-run' && response.ok)
	recordAgentAck(grant, 'ask', response.closed === true);
      return response;
    }
    case 'reject': {
      if (!exactKeys(body, ['path', 'text']) && !exactKeys(body, ['path', 'text', 'requested']))
	throw new Error('routing broker request refused');
      if (typeof body.path !== 'string' || !grant.consumedPaths?.has(body.path)
	|| typeof body.text !== 'string' || !body.text.trim()
	|| (body.requested !== undefined && (typeof body.requested !== 'string' || !body.requested.trim())))
	throw new Error('routing broker request refused');
      const current = await verifyCurrentConsequence(grant, scope, now, signal);
      if (current?.order && !Object.hasOwn(current.order.consumes ?? {}, body.path))
	throw new Error('routing current reject target changed');
      const path = body.path as string;
      const value = body.text as string;
      const requested = body.requested as string | undefined;
      const response = await checked(grant, startEffect(grant, () => grant.hub.routingReject({ workflow, run, path,
	text: value, ...(requested === undefined ? {} : { requested }) }, signal)), now);
      if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'string'
	|| grant.reservation.childKind === 'agent-run' && typeof response.closed !== 'boolean')
	throw new Error('routing broker response refused');
      if (grant.reservation.childKind === 'agent-run' && response.ok)
	recordAgentAck(grant, 'reject', response.closed === true);
      return response;
    }
    case 'request_approval': {
      if (scope !== 'role' || childKind !== 'agent-run'
	|| !exactKeys(body, ['tool_use_id', 'tool_name', 'tool_input', 'reason'])
	&& !exactKeys(body, ['tool_use_id', 'tool_name', 'tool_input', 'reason', 'title']))
	throw new Error('routing broker request refused');
      if (typeof body.tool_use_id !== 'string' || !body.tool_use_id
	|| typeof body.tool_name !== 'string' || !body.tool_name
	|| typeof body.reason !== 'string' || !body.reason
	|| (body.title !== undefined && typeof body.title !== 'string'))
	throw new Error('routing broker request refused');
      await verifyCurrentConsequence(grant, scope, now, signal);
      const toolUseId = body.tool_use_id as string;
      const toolName = body.tool_name as string;
      const reason = body.reason as string;
      const title = body.title as string | undefined;
      const response = await checked(grant, startEffect(grant, () => grant.hub.routingRequestApproval({ workflow, run,
	tool_use_id: toolUseId, tool_name: toolName, tool_input: body.tool_input,
	reason, ...(title === undefined ? {} : { title }) }, signal)), now);
      if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'string')
	throw new Error('routing broker response refused');
      return response;
    }
    case 'read_invocation_binding': {
      if (scope !== 'role' || !grant.submissionAuthority
	|| !grant.inputAuthority?.observeInvocation
	|| !exactKeys(body, ['parentWorkflow', 'parentDefRef', 'callPath', 'parentArtifactVersion']))
	throw new Error('routing broker request refused');
      if (typeof body.parentWorkflow !== 'string' || !body.parentWorkflow
	|| !exactKeys(body.parentDefRef, ['bundleDigest', 'workflowName'])
	|| typeof body.parentDefRef.bundleDigest !== 'string' || !body.parentDefRef.bundleDigest
	|| typeof body.parentDefRef.workflowName !== 'string' || !body.parentDefRef.workflowName
	|| typeof body.callPath !== 'string' || !body.callPath
	|| !Number.isSafeInteger(body.parentArtifactVersion)
	|| (body.parentArtifactVersion as number) < 1) throw new Error('routing broker request refused');
      if (grant.acceptedLaunchReport && !liveChildValid(grant, now()))
	throw new Error('routing recorded occurrence unavailable');
      const phase: RoutedInputPhase = grant.acceptedLaunchReport ? 'recorded-live' : 'prestart';
      if (signal.aborted || phase === 'prestart' && !validateLaunchGrant(grant, now()))
	throw new Error('routing invocation grant unavailable');
      const key: InvocationRelayKey = { parentWorkflow: body.parentWorkflow as string,
	parentDefRef: { bundleDigest: body.parentDefRef.bundleDigest as string,
	  workflowName: body.parentDefRef.workflowName as string },
	callPath: body.callPath as string,
	parentArtifactVersion: body.parentArtifactVersion as number };
      if (grant.inputAuthority.validateInvocationKey?.(key) !== true)
	throw new Error('routing invocation key refused');
      if (!grant.execHolderId) throw new Error('routing order holder unavailable');
      const holder: ContactHolder = { kind: 'exec', id: grant.execHolderId,
	shiftId: grant.identity.shiftId };
      const response = await checked(grant, grant.hub.getOrder({ workflow, run, holder }, signal),
	now, phase === 'prestart');
      if (!validOrderResponse(grant, response) || !response.lease.claimed || !response.order
	|| phase !== (grant.acceptedLaunchReport ? 'recorded-live' : 'prestart')
	|| phase === 'recorded-live' && !liveChildValid(grant, now()))
	throw new Error('routing invocation order unavailable');
      const observed = await checked(grant,
	grant.inputAuthority.observeInvocation(response, phase, key), now, phase === 'prestart');
      if (signal.aborted || !observed.relay
	|| phase !== (grant.acceptedLaunchReport ? 'recorded-live' : 'prestart'))
	throw new Error('routing invocation witness unavailable');
      acceptVerifiedPair(grant, observed.pair, phase, now);
      if (signal.aborted || phase === 'recorded-live' && !liveChildValid(grant, now()))
	throw new Error('routing invocation witness unavailable');
      return observed.relay;
    }
  }
}

/** Start a separate private socket for both foreground and daemon Shift modes. */
export async function createRoutingBroker(args: { now?: () => number;
  uploadTimeouts?: { idleMs: number; absoluteMs: number } } = {}): Promise<RoutingBroker> {
  // macOS limits Unix socket paths to about 104 bytes. A short private temp
  // directory works even when the operator's Shift state path is deeply nested.
  const directory = mkdtempSync(join(tmpdir(), 'ol-rb-'));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, 'broker.sock');
  const grants = new Map<string, { grant: Grant; scope: CapScope }>();
  const terminators = new Map<Grant, (reason?: 'normal-close' | 'child-exit' | 'revoked') => Promise<void> | void>();
  const revocations = new Set<Promise<void>>();
  const effectDrains = new Set<Promise<RoutedQuiesceResult>>();
  const unresolvedEffects = new Set<Grant>();
  let revocationFailed = false;
  let outcomeUncertain = false;
  const now = args.now ?? Date.now;
  const uploadIdleMs = args.uploadTimeouts?.idleMs ?? UPLOAD_IDLE_MS;
  const uploadAbsoluteMs = args.uploadTimeouts?.absoluteMs ?? UPLOAD_ABSOLUTE_MS;
  if (!Number.isSafeInteger(uploadIdleMs) || uploadIdleMs <= 0
    || !Number.isSafeInteger(uploadAbsoluteMs) || uploadAbsoluteMs <= uploadIdleMs
    || uploadAbsoluteMs > UPLOAD_ABSOLUTE_MS) throw new Error('routing broker upload timeout refused');
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    if (sockets.size >= MAX_SOCKETS) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A client may disconnect after writing a frame or while a Hub call is
    // pending. ECONNRESET/EPIPE belong to that request, never the Shift.
    socket.on('error', () => { socket.destroy(); });
    socket.setTimeout(120_000, () => socket.destroy());
    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    let bytes = 0;
    const chunks: Buffer[] = [];
    let handled = false;
    let upload: { remaining: number; stream: PassThrough } | undefined;
    const feedUpload = (chunk: Buffer) => {
      if (!upload || chunk.length > upload.remaining) { socket.destroy(); return; }
      upload.remaining -= chunk.length;
      if (chunk.length > 0 && !upload.stream.write(chunk)) {
	socket.pause();
	upload.stream.once('drain', () => { if (!socket.destroyed) socket.resume(); });
      }
      if (upload.remaining === 0) upload.stream.end();
    };
    const refuse = (error: unknown) => {
      const status = error instanceof HubError ? error.status : undefined;
      const retryAfterMs = error instanceof HubError ? error.retryAfterMs : undefined;
      if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: 'routing request refused',
	...(status === undefined ? {} : { status }),
	...(retryAfterMs === undefined ? {} : { retryAfterMs }) }) + '\n');
    };
    socket.on('data', data => {
      const chunk = typeof data === 'string' ? Buffer.from(data) : data;
      if (upload) { feedUpload(chunk); return; }
      if (handled) return;
      bytes += chunk.length;
      chunks.push(chunk);
      if (chunk.indexOf(0x0a) < 0) {
	if (bytes > MAX_LINE) { handled = true; socket.destroy(); }
	return;
      }
      handled = true;
      const frame = Buffer.concat(chunks, bytes);
      const newline = frame.indexOf(0x0a);
      if (newline > MAX_LINE) { socket.destroy(); return; }
      const raw = frame.subarray(0, newline).toString('utf8');
      const tail = frame.subarray(newline + 1);
      void (async () => {
	try {
	  const request: unknown = JSON.parse(raw);
	  if (!exactKeys(request, ['cap', 'method', 'body']) || typeof request.cap !== 'string'
	    || !CAP.test(request.cap) || typeof request.method !== 'string') throw new Error();
	  const entry = grants.get(request.cap);
	  if (!entry || closed) throw new Error();
	  if (request.method === 'download_file') {
	    if (tail.length > 0 || entry.grant.quiescing || !entry.grant.ready || !validateSessionGrant(entry.grant, now())
	      || !exactKeys(request.body, ['path', 'pointer'])
	      || typeof request.body.path !== 'string' || !request.body.path
	      || !request.body.pointer || typeof request.body.pointer !== 'object'
	      || typeof (request.body.pointer as { __file?: unknown }).__file !== 'string') throw new Error();
	    const grant = entry.grant;
	    const pointer = request.body.pointer as FileArtifactPointer;
	    const pinned = grant.consumedFiles?.get(`${request.body.path}\0${pointer.__file}`);
	    if (!pinned || !isDeepStrictEqual(pinned, pointer)) throw new Error();
	    let started = false;
	    let source: import('node:stream').Readable | undefined;
	    grant.uploadControllers.add(controller);
	    const timer = setTimeout(() => controller.abort(), UPLOAD_ABSOLUTE_MS);
	    timer.unref();
	    socket.setTimeout(UPLOAD_IDLE_MS, () => controller.abort());
	    controller.signal.addEventListener('abort', () => { source?.destroy(); socket.destroy(); }, { once: true });
	    const drain = () => new Promise<void>((resolve, reject) => {
	      const ready = () => { socket.off('close', gone); resolve(); };
	      const gone = () => { socket.off('drain', ready); reject(new Error('routing broker closed')); };
	      socket.once('drain', ready);
	      socket.once('close', gone);
	    });
	    try {
	      const phase: RoutedInputPhase = grant.acceptedLaunchReport && liveChildValid(grant, now())
		? 'recorded-live' : 'prestart';
	      const current = await verifyCurrentConsequence(grant, entry.scope, now,
		controller.signal, phase);
	      if (current && !isDeepStrictEqual(
		consumedFiles(current).get(`${request.body.path}\0${pointer.__file}`), pointer))
		throw new Error('routing current file input changed');
	      let result: Awaited<ReturnType<typeof grant.hub.routingGetFileArtifact>>;
	      try {
	        result = await grant.hub.routingGetFileArtifact({
	          workflow: grant.reservation.workflow, run: grant.reservation.run,
	          key: pointer.__file, pointer,
	        }, controller.signal);
	      } catch (error) {
	        if (!grant.ready || !validateSessionGrant(grant, now())) throw new Error('routing broker grant expired');
	        throw error;
	      }
	      source = result.body;
	      source?.on('error', () => {});
	      if (!grant.ready || !validateSessionGrant(grant, now()) || controller.signal.aborted)
	        throw new Error('routing broker grant expired');
	      if (!source || typeof source.destroy !== 'function' || result.size !== pointer.size
	        || result.contentType !== pointer.contentType) throw new Error('routing broker response refused');
	      const header = JSON.stringify({ ok: true, size: result.size, contentType: result.contentType }) + '\n';
	      started = true;
	      if (!socket.write(header)) await drain();
	      let sent = 0;
	      const hash = createHash('sha256');
	      for await (const chunk of source) {
	        if (!validateSessionGrant(grant, now()) || controller.signal.aborted) throw new Error('routing broker grant expired');
	        if (!(chunk instanceof Uint8Array) || sent + chunk.byteLength > pointer.size)
	          throw new Error('routing broker file length refused');
	        sent += chunk.byteLength;
	        hash.update(chunk);
	        if (!socket.write(chunk)) await drain();
	      }
	      if (sent !== pointer.size || hash.digest('hex') !== pointer.hash
	        || !validateSessionGrant(grant, now()) || controller.signal.aborted)
	        throw new Error('routing broker file digest refused');
	      if (grant.inputAuthority)
		await verifyCurrentConsequence(grant, entry.scope, now, controller.signal, phase);
	      socket.end();
	    } catch (error) {
	      if (started) socket.destroy();
	      else refuse(error);
	    } finally {
	      clearTimeout(timer);
	      grant.uploadControllers.delete(controller);
	      source?.destroy();
	    }
	    return;
	  }
	  if (request.method === 'upload_file') {
	    if (newline > MAX_UPLOAD_HEADER || entry.scope !== 'holder'
	      || entry.grant.quiescing
	      || entry.grant.reservation.childKind !== 'agent-run'
	      || !entry.grant.ready || !validateSessionGrant(entry.grant, now())
	      || !entry.grant.allowedPaths?.size
	      || (!exactKeys(request.body, ['size', 'contentType'])
		&& !exactKeys(request.body, ['size', 'contentType', 'filename']))) throw new Error();
	    const body = request.body;
	    if (!Number.isSafeInteger(body.size) || (body.size as number) <= 0
	      || (body.size as number) > MAX_FILE || typeof body.contentType !== 'string'
	      || !body.contentType.trim() || body.contentType.length > 256
	      || (body.filename !== undefined && (typeof body.filename !== 'string'
		|| !body.filename || body.filename.length > 1024))
	      || tail.length > (body.size as number)) throw new Error();
	    const grant = entry.grant;
	    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
	    stream.on('error', () => {}); // Disconnect/revocation is a request failure, never a Shift crash.
	    socket.setTimeout(uploadIdleMs, () => controller.abort());
	    const totalTimer = setTimeout(() => controller.abort(), uploadAbsoluteMs);
	    totalTimer.unref();
	    socket.once('close', () => clearTimeout(totalTimer));
	    controller.signal.addEventListener('abort', () => { stream.destroy(); socket.destroy(); }, { once: true });
	    grant.uploadControllers.add(controller);
	    grant.uploadEffectControllers.add(controller);
	    upload = { remaining: body.size as number, stream };
	    const keyPrefix = `orgs/${grant.identity.orgId}/artifacts/${grant.reservation.workflow}`
	      + `/files/routed/${encodeURIComponent(grant.reservation.run)}/`;
	    let uploadDispatched = false;
	    void (async () => {
	      await verifyCurrentConsequence(grant, entry.scope, now, controller.signal);
	      return checked(grant, startEffect(grant, () => {
		uploadDispatched = true;
		return grant.hub.routingPutFileArtifact({
		workflow: grant.reservation.workflow, run: grant.reservation.run,
		body: stream, size: body.size as number, contentType: body.contentType as string,
		...(body.filename === undefined ? {} : { filename: body.filename as string }),
		}, controller.signal);
	      }), now);
	    })().then(async (value: PutFileArtifactResponse) => {
	      await verifyCurrentConsequence(grant, entry.scope, now, controller.signal);
	      if (!value || typeof value.__file !== 'string' || !value.__file.startsWith(keyPrefix)
		|| !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
		  value.__file.slice(keyPrefix.length))
		|| typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
		|| value.size !== body.size || value.contentType !== body.contentType
		|| value.filename !== body.filename
		|| typeof value.text !== 'string') throw new Error('routing broker response refused');
	      if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, value }) + '\n');
	    }).catch(error => {
	      if (uploadDispatched) {
		grant.uncertainEffects.add('upload_file');
		grant.syncUncertainty?.();
	      }
	      refuse(error);
	    }).finally(() => {
	      grant.uploadControllers.delete(controller);
	      grant.uploadEffectControllers.delete(controller);
	      stream.destroy();
	    });
	    feedUpload(tail);
	    return;
	  }
	  if (tail.length > 0) throw new Error();
  const methods: readonly string[] = ['get_order', 'get_launch_order', 'read_routing_claim',
      'read_routed_reference_v2', 'read_routing_claim_v2', 'read_routed_pair_v2', 'assess_local_model',
      'read_live_routed_reference_v2', 'read_live_routing_claim_v2',
	    'reserve_launch', 'report_launch', 'heartbeat', 'submit', 'release', 'ask', 'reject',
	    'request_approval', 'read_invocation_binding', 'collection_target', 'emit_member', 'seal_collection',
	    'quiesce', 'command_postrun', 'command_postrun_status', 'command_finish', 'agent_outcome', 'agent_finish'];
	  if (!methods.includes(request.method)) throw new Error();
	  const effect = ['reserve_launch', 'report_launch', 'submit', 'release', 'ask', 'reject',
	    'request_approval', 'emit_member', 'seal_collection'].includes(request.method);
	  const send = () => invoke(entry.grant, entry.scope, request.method as Method, request.body, now, controller.signal);
	  const value = await (effect ? trackEffect(entry.grant, request.method as Method, send) : send());
	  if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, value }) + '\n');
	} catch (error) {
	  refuse(error);
	}
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    try { server.close(); } catch { /* Startup never exposed a grant. */ }
    try { unlinkSync(socketPath); } catch { /* May not exist. */ }
    try { rmdirSync(directory); } catch { /* Preserve substituted entries. */ }
    throw error;
  }
  const inode: Stats = lstatSync(socketPath);
  return {
    socketPath,
    issue({ reservation, routing, identity, currentIdentity, hub, routedV2Read, routedLiveV2Read,
      submissionAuthority, launchAuthority, inputAuthority, commandFor }) {
      if (closed) throw new Error('routing broker closed');
      const grant: Grant = { diagnostics: newDiagnostics(), active: true, ready: false, quiescing: false,
	agentAcks: [], agentAckOverflow: false,
	effectLedger: new Map(), nextEffectId: 0, effectLedgerOverflow: false,
	inFlightEffects: new Set(), uncertainEffects: new Set(), uploadControllers: new Set(),
	uploadEffectControllers: new Set(),
	reservation: structuredClone(reservation), routing: structuredClone(routing),
	identity: { ...identity }, currentIdentity, hub, routedV2Read, routedLiveV2Read,
	submissionAuthority, launchAuthority, inputAuthority, commandFor };
      grant.syncUncertainty = () => {
	if (grant.uncertainEffects.size) unresolvedEffects.add(grant);
	else unresolvedEffects.delete(grant);
      };
      grant.observeQuiesce = pending => {
	effectDrains.add(pending);
	void pending.then(() => { effectDrains.delete(pending); }, () => {
	  grant.uncertainEffects.add('upload_file');
	  grant.syncUncertainty?.();
	  effectDrains.delete(pending);
	});
      };
      if (!validateLaunchGrant(grant, now())) throw new Error('routing broker grant refused');
      const cap = randomBytes(32).toString('hex');
      const holderCap = reservation.childKind === 'agent-run' ? randomBytes(32).toString('hex') : undefined;
      grants.set(cap, { grant, scope: 'role' });
      if (holderCap) grants.set(holderCap, { grant, scope: 'holder' });
      let terminal: 'normal-close' | 'receipt-pending' | 'revoked' | undefined;
      let tombstoneTimer: NodeJS.Timeout | undefined;
      let settleTombstone: ((error?: Error) => void) | undefined;
      let tombstoneWait: Promise<void> | undefined;
      const terminate = (requested: 'normal-close' | 'child-exit' | 'revoked' = 'revoked'): Promise<void> | void => {
	void quiesceGrant(grant);
	if (grant.liveChild) grant.liveChild.terminal = true;
	const frozen = !!(grant.collectionMember?.emit || grant.collectionSeal?.request || grant.pendingSubmit);
	const reason = requested === 'child-exit'
	  ? frozen ? 'receipt-pending' : 'revoked' : requested;
	if (terminal === 'revoked') return grant.revokeResult;
	if ((terminal === 'normal-close' || terminal === 'receipt-pending')
	  && (reason === 'normal-close' || reason === 'receipt-pending'))
	  return tombstoneWait;
	terminal = reason;
	grant.terminalReason = reason;
	grant.active = false;
	grant.ready = false;
	for (const controller of grant.uploadControllers) controller.abort();
	if ((reason === 'normal-close' || reason === 'receipt-pending') && frozen) {
	  grant.receiptUntil = Math.min(identity.expiresAt, now() + 60_000);
	  const remaining = Math.max(0, grant.receiptUntil - now());
	  tombstoneWait = new Promise<void>((resolve, reject) => {
	    settleTombstone = error => error ? reject(error) : resolve();
	  });
	  void tombstoneWait.catch(() => {});
	  tombstoneTimer = setTimeout(() => {
	    if (grant.terminalReason === 'normal-close' || grant.terminalReason === 'receipt-pending') {
	      const unresolved = !!((grant.collectionMember?.emit && !grant.collectionMember.result)
		|| (grant.collectionSeal?.request && !grant.collectionSeal.result)
		|| grant.pendingSubmit);
	      if (unresolved) outcomeUncertain = true;
	      grant.receiptUntil = undefined;
	      grants.delete(cap);
	      if (holderCap) grants.delete(holderCap);
	      terminators.delete(grant);
	      settleTombstone?.(unresolved ? new Error('routing receipt outcome quarantined') : undefined);
	    }
	  }, remaining);
	  tombstoneTimer.unref();
	  // A Service commit may close the native run before its ACK reaches this
	  // socket. Reconcile only the frozen request, never retry the mutation.
	  void (async () => {
	    let delay = 100;
	    while (!closed && collectionReceiptOnly(grant, now)) {
	      const kind = grant.collectionMember?.emit && !grant.collectionMember.result
		? 'member' : grant.collectionSeal?.request && !grant.collectionSeal.result
		  ? 'seal' : undefined;
	      if (!kind && !grant.pendingSubmit) return;
	      try {
		if (kind) {
		  const result = await collectionReconcile(grant, kind, now, AbortSignal.timeout(10_000));
		  if (kind === 'member' && grant.collectionMember) grant.collectionMember.result = result;
		  if (kind === 'seal' && grant.collectionSeal) grant.collectionSeal.result = result;
		  grant.uncertainEffects.delete(kind === 'member' ? 'emit_member' : 'seal_collection');
		} else {
		  await conditionalReconcile(grant, now, AbortSignal.timeout(10_000));
		  grant.pendingSubmit = undefined;
		  grant.uncertainEffects.delete('submit');
		}
		grant.syncUncertainty?.();
		delay = 100;
	      } catch (error) {
		if (error instanceof HubError && error.status === 429 && error.retryAfterMs)
		  delay = Math.max(delay, error.retryAfterMs);
		else delay = Math.min(delay * 2, 5_000);
	      }
	      await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); timer.unref(); });
	    }
	  })();
	  return tombstoneWait;
	}
	if (tombstoneTimer) clearTimeout(tombstoneTimer);
	grant.receiptUntil = undefined;
	if ((grant.collectionMember?.emit && !grant.collectionMember.result)
	  || (grant.collectionSeal?.request && !grant.collectionSeal.result)
	  || grant.pendingSubmit)
	  outcomeUncertain = true;
	if (grant.collectionMember || grant.collectionSeal || grant.conditionalTouched) {
	  const revoke = Promise.all([
	    ...(grant.collectionMember || grant.collectionSeal ? [hub.routingCollectionRevoke({
	      workflow: reservation.workflow, run: reservation.run }, AbortSignal.timeout(10_000))] : []),
	    ...(grant.conditionalTouched ? [hub.routingConditionalRevoke({
	      workflow: reservation.workflow, run: reservation.run }, AbortSignal.timeout(10_000))] : []),
	  ]).then(results => {
	    if (results.some(result => !result || result.revoked !== true))
	      throw new Error('routing receipt revocation refused');
	  });
	  grant.revokeResult = revoke;
	  revocations.add(revoke);
	  void revoke.then(() => { revocations.delete(revoke); }, () => {
	    revocationFailed = true;
	    revocations.delete(revoke);
	  });
	  void revoke.then(() => settleTombstone?.(), () =>
	    settleTombstone?.(new Error('routing collection revocation unresolved')));
	}
	grants.delete(cap);
	if (holderCap) grants.delete(holderCap);
	terminators.delete(grant);
	return grant.revokeResult;
      };
      terminators.set(grant, terminate);
      return { socketPath, cap, ...(holderCap ? { holder: { socketPath, cap: holderCap } } : {}),
	diagnosticsSnapshot: () => Object.freeze({ ...grant.diagnostics }),
	activate(record) {
	  if (closed || grant.ready || !validateLaunchGrant(grant, now()) || record.workflow !== reservation.workflow
	    || record.run !== reservation.run || record.gateToken !== reservation.token
	    || (record.kind ?? 'exec') !== reservation.childKind
	    || !Number.isSafeInteger(record.pid) || record.pid <= 0
	    || !Number.isSafeInteger(record.spawnedAt)) throw new Error('routing broker grant unavailable');
	  grant.execHolderId = `${hostname()}:${record.pid}`;
	  grant.ready = true;
      }, bindChild(record, custody, handoff) {
	  if (!grant.ready || grant.liveChild || !validateLaunchGrant(grant, now())
	    || record.workflow !== reservation.workflow || record.run !== reservation.run
	    || record.gateToken !== reservation.token || record.pid !== custody.pid
	    || !retainedChildLive(custody, record.pid)
	    || !/^inc_[a-f0-9]{32}$/.test(handoff.incarnation)
	    || !/^[a-f0-9]{32}$/.test(handoff.nonce))
	    throw new Error('routing broker child custody unavailable');
	  grant.liveChild = { custody, pid: record.pid, spawnedAt: record.spawnedAt,
	    incarnation: handoff.incarnation, nonce: handoff.nonce,
	    gateSignalled: false, entered: false, terminal: false };
      }, markGateSignalled(record) {
	  const child = grant.liveChild;
	  if (!child || child.terminal || child.gateSignalled || !grant.ready
	    || record.workflow !== reservation.workflow || record.run !== reservation.run
	    || record.gateToken !== reservation.token || record.pid !== child.pid
	    || record.spawnedAt !== child.spawnedAt || !retainedChildLive(child.custody, child.pid))
	    throw new Error('routing broker child gate unavailable');
	  child.gateSignalled = true;
      }, markChildEntered(record) {
	  const child = grant.liveChild;
	  if (!child || child.terminal || child.entered || !child.gateSignalled || !grant.ready
	    || !validateLaunchGrant(grant, now()) || record.workflow !== reservation.workflow
	    || record.run !== reservation.run || record.gateToken !== reservation.token
	    || record.pid !== child.pid || record.spawnedAt !== child.spawnedAt
	    || !retainedChildLive(child.custody, child.pid))
	    throw new Error('routing broker child entry unavailable');
	  child.entered = true;
      }, canAllowEntry(record) {
	  const child = grant.liveChild;
	  return !!child && child.entered && !child.terminal && grant.ready
	    && validateLaunchGrant(grant, now())
	    && record.workflow === reservation.workflow && record.run === reservation.run
	    && record.gateToken === reservation.token && record.pid === child.pid
	    && record.spawnedAt === child.spawnedAt && retainedChildLive(child.custody, child.pid);
      }, quiesce: () => quiesceGrant(grant), terminal: terminate };
    },
    async revokeSession(sessionId) {
      const affected = [...terminators.entries()].filter(([grant]) => grant.identity.sessionId === sessionId);
      const pending = affected.map(([, terminate]) => terminate('revoked')).filter(
	(value): value is Promise<void> => value !== undefined);
      const results = await Promise.allSettled([...pending, ...revocations, ...effectDrains]);
      if (outcomeUncertain || revocationFailed
	|| [...unresolvedEffects].some(grant => grant.identity.sessionId === sessionId)
	|| results.some(result => result.status === 'rejected'))
	throw new Error('routing effect outcome quarantined');
    },
    close(options = {}) {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
      // All local mutation and receipt caps disappear before the first await.
      const normal = options.revokeNormalReceipts ? [] : [...terminators.keys()]
	.filter(grant => grant.terminalReason === 'normal-close' || grant.terminalReason === 'receipt-pending');
      const pending = [...terminators.entries()]
	.filter(([grant]) => !normal.includes(grant))
	.map(([, terminate]) => terminate('revoked'));
      const receiptChecks = normal.map(async grant => {
	if (grant.collectionMember?.emit && !grant.collectionMember.result)
	  grant.collectionMember.result = await collectionReconcile(grant, 'member', now,
	    AbortSignal.timeout(10_000));
	if (grant.collectionSeal?.request && !grant.collectionSeal.result)
	  grant.collectionSeal.result = await collectionReconcile(grant, 'seal', now,
	    AbortSignal.timeout(10_000));
	if (grant.pendingSubmit) {
	  await conditionalReconcile(grant, now, AbortSignal.timeout(10_000));
	  grant.pendingSubmit = undefined;
	  grant.uncertainEffects.delete('submit');
	  grant.syncUncertainty?.();
	}
      });
      const drained = await Promise.allSettled([
	...pending.filter((value): value is Promise<void> => value !== undefined),
	...revocations,
	...effectDrains,
	...receiptChecks,
      ]);
      for (const entry of grants.values()) {
	entry.grant.active = false;
	for (const controller of entry.grant.uploadControllers) controller.abort();
      }
      grants.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try {
	const current = lstatSync(socketPath);
	if (current.dev === inode.dev && current.ino === inode.ino) unlinkSync(socketPath);
      } catch { /* Replaced or already removed. */ }
      try { rmdirSync(directory); } catch { /* Preserve substituted/nonempty directory. */ }
      if (outcomeUncertain || revocationFailed || unresolvedEffects.size > 0
	|| drained.some(result => result.status === 'rejected'))
	throw new Error('routing effect outcome quarantined');
      })();
      return closePromise;
    },
  };
}
