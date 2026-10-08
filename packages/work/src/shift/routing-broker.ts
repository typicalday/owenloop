/**
 * Private, per-Shift routed child transport. The Shift retains both Hub
 * credentials; a child receives only a random, one-dispatch socket capability.
 * No caller may choose a URL, header, verb, workflow, run or session.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RoutingHubClient } from '../hub/client.ts';
import { HubError, type ContactHolder, type FileArtifactPointer, type GetOrderResponse, type LaunchReportV1,
  type LaunchReservationRequestV1, type ReferenceRouting, type PutFileArtifactResponse } from '../hub/types.ts';
import type { ChildRecord, ChildReservation } from './state.ts';
import type { RoutedSubmissionAuthority } from './routing-submit-authority.ts';
import { outputVersionForSubmission } from '../submit-proof.ts';
import { normalizeSubmitValue } from '../submit-value.ts';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';

// Service permits artifact values up to 25 MB. Leave bounded JSON overhead
// while allowing a normal submit receipt through this private transport.
const MAX_LINE = 32 * 1024 * 1024;
const MAX_FILE = 500_000_000;
const MAX_UPLOAD_HEADER = 4096;
// Service reserves a routed upload for 15 minutes. End our request early so
// abort and staged-object cleanup can settle before that reservation expires.
const UPLOAD_IDLE_MS = 4 * 60_000;
const UPLOAD_ABSOLUTE_MS = 14 * 60_000;
const MAX_SOCKETS = 16;
const CAP = /^[a-f0-9]{64}$/;
type Identity = { sessionId: string; shiftId: string; orgId: string; principalId: string; expiresAt: number };
type Method = 'get_order' | 'get_launch_order' | 'read_routing_claim' | 'assess_local_model' | 'reserve_launch' | 'report_launch'
  | 'heartbeat' | 'submit' | 'release' | 'ask' | 'reject' | 'request_approval'
  | 'read_invocation_binding';
type CapScope = 'role' | 'holder';
interface Grant {
  active: boolean;
  ready: boolean;
  execHolderId?: string;
  allowedPaths?: Set<string>;
  consumedPaths?: Set<string>;
  consumedFiles?: Map<string, FileArtifactPointer>;
  uploadControllers: Set<AbortController>;
  reservation: ChildReservation;
  routing: ReferenceRouting;
  identity: Identity;
  currentIdentity: () => Identity | undefined;
  hub: RoutingHubClient;
  reservationRequest?: LaunchReservationRequestV1;
  launchReservationId?: string;
  launchExpiresAt?: number;
  acceptedLaunchReport?: string;
  submissionAuthority?: RoutedSubmissionAuthority;
  submitBusy?: boolean;
  pendingSubmit?: { intent: string; binding: string; request: import('../hub/types.ts').ConditionalSubmitRequest };
  launchAuthority?: RoutedLaunchAuthority;
}
export interface RoutedLaunchAuthority {
  /** Parent-owned current machine roster and adapter availability. */
  verifySelection(order: import('../hub/types.ts').OrderPacket, request: LaunchReservationRequestV1): Promise<void>;
}
export interface RoutingBroker {
  issue(args: { reservation: ChildReservation; routing: ReferenceRouting; identity: Identity;
    currentIdentity: () => Identity | undefined; hub: RoutingHubClient;
    submissionAuthority?: RoutedSubmissionAuthority; launchAuthority?: RoutedLaunchAuthority }): {
      socketPath: string; cap: string; holder?: { socketPath: string; cap: string };
      activate(record: ChildRecord): void; terminal(): void;
    };
  close(): Promise<void>;
  socketPath: string;
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
  if (response.workflow !== grant.reservation.workflow || response.run !== grant.reservation.run
    || !response.lease || typeof response.lease !== 'object'
    || typeof (response.lease as { claimed?: unknown }).claimed !== 'boolean') return false;
  if (response.order === null) return true;
  if (!response.order || typeof response.order !== 'object') return false;
  const order = response.order as Record<string, unknown>;
  return order.workflow === grant.reservation.workflow && order.run === grant.reservation.run
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
  signal: AbortSignal): Promise<unknown> {
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
    const fresh = await checked(grant, grant.hub.getOrder({
      workflow: grant.reservation.workflow, run: grant.reservation.run, holder,
    }, signal), now);
    const binding = submissionBinding(fresh, path, grant);
    await checked(grant, authority.verifyOrder(fresh), now);
    if (submissionBinding(fresh, path, grant) !== binding)
      throw new Error('routing submission order changed');
    if (authority.canSubmit?.(fresh.order!, path) !== true)
      throw new Error('routing submission kind unavailable');
    if (grant.pendingSubmit && grant.pendingSubmit.binding !== binding)
      throw new Error('routing submission outcome unresolved');
    if (grant.pendingSubmit && authority.canReplay?.(fresh.order!, path) !== true)
      throw new Error('routing submission outcome unresolved');
    if (!grant.pendingSubmit) {
      const proof = await checked(grant, authority.sign(fresh.order!, path, value), now);
      if (typeof proof !== 'string' || !proof) throw new Error('routing submission proof refused');
      // Signing and source verification await external work. Refresh again;
      // the Service enforces the exact version at its final transaction too.
      const current = await checked(grant, grant.hub.getOrder({
	workflow: grant.reservation.workflow, run: grant.reservation.run, holder,
      }, signal), now);
      if (submissionBinding(current, path, grant) !== binding)
	throw new Error('routing submission order changed');
      await checked(grant, authority.verifyOrder(current), now);
      if (submissionBinding(current, path, grant) !== binding)
	throw new Error('routing submission order changed');
      grant.pendingSubmit = { intent, binding, request: {
	workflow: grant.reservation.workflow, run: grant.reservation.run, path,
	value, holder, proof, expectedVersion: outputVersionForSubmission(fresh.order!, path)!,
	...(body.done === undefined ? {} : { done: body.done as boolean }),
      } };
    }
    const response = await checked(grant,
      grant.hub.routingSubmitConditional(grant.pendingSubmit.request, signal), now);
    if (!response || response.conditionApplied !== 'expected-version-v1'
      || typeof response.outcome !== 'string' || !response.outcome
      || (response.closed !== undefined && typeof response.closed !== 'boolean'))
      throw new Error('routing broker response refused');
    // A missing/malformed/failed acknowledgement preserves the one exact
    // request, including its signature. It cannot become a new signed write.
    grant.pendingSubmit = undefined;
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
  await checked(grant, grant.submissionAuthority.verifyOrder(fresh), now, true);
  await checked(grant, grant.launchAuthority.verifySelection(fresh.order, structuredClone(request)), now, true);
}

async function invoke(grant: Grant, scope: CapScope, method: Method, body: unknown, now: () => number,
  signal: AbortSignal): Promise<unknown> {
  if (scope === 'holder' && method !== 'get_order' && method !== 'heartbeat' && method !== 'submit'
    && method !== 'ask' && method !== 'reject')
    throw new Error('routing broker request refused');
  const launch = method === 'get_launch_order' || method === 'assess_local_model'
    || method === 'reserve_launch' || method === 'report_launch';
  if (!grant.ready || !(launch ? validateLaunchGrant(grant, now()) : validateSessionGrant(grant, now())))
    throw new Error('routing broker grant expired');
  const { workflow, run, childKind } = grant.reservation;
  switch (method) {
    case 'get_launch_order':
    case 'get_order': {
      if (!exactKeys(body, ['holder']) || !validHolder(grant, scope, body.holder)) throw new Error('routing broker request refused');
      if (!grant.submissionAuthority) throw new Error('routing order authority unavailable');
      const prestart = method === 'get_launch_order';
      if (prestart && (!grant.reservationRequest || !grant.acceptedLaunchReport || !grant.launchAuthority
	|| grant.launchExpiresAt === undefined || now() >= grant.launchExpiresAt))
	throw new Error('routing launch report unavailable');
      const response = await checked(grant, grant.hub.getOrder({ workflow, run, holder: body.holder }, signal), now, prestart);
      if (!validOrderResponse(grant, response)) throw new Error('routing broker response refused');
      if (response.lease.claimed && response.order)
	await checked(grant, grant.submissionAuthority.verifyOrder(response), now, prestart);
      if (prestart) {
	if (!response.lease.claimed || !response.order) throw new Error('routing launch order unavailable');
	await checked(grant, grant.launchAuthority!.verifySelection(response.order,
	  structuredClone(grant.reservationRequest!)), now, true);
	if (now() >= grant.launchExpiresAt!) throw new Error('routing launch reservation expired');
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
      const response = await checked(grant, grant.hub.reserveLaunch({ workflow, request }, signal), now, true);
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
	const response = await checked(grant, grant.hub.reportLaunch({ workflow, report }, signal), now, true);
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
      return submitFromParent(grant, body, now, signal);
    }
    case 'release':
      if (!exactKeys(body, []) && !exactKeys(body, ['reason'])) throw new Error('routing broker request refused');
      if (body.reason !== undefined && (typeof body.reason !== 'string' || [...body.reason].length > 1024))
	throw new Error('routing broker request refused');
      {
	const response = await checked(grant, grant.hub.routingRelease({ workflow, run,
	  ...(body.reason === undefined ? {} : { reason: body.reason }) }, signal), now);
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
      const response = await checked(grant, grant.hub.routingAsk({ workflow, run, path: body.path,
	question: body.question, ...(body.context === undefined ? {} : { context: body.context }) }, signal), now);
      if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'string')
	throw new Error('routing broker response refused');
      return response;
    }
    case 'reject': {
      if (!exactKeys(body, ['path', 'text']) && !exactKeys(body, ['path', 'text', 'requested']))
	throw new Error('routing broker request refused');
      if (typeof body.path !== 'string' || !grant.consumedPaths?.has(body.path)
	|| typeof body.text !== 'string' || !body.text.trim()
	|| (body.requested !== undefined && (typeof body.requested !== 'string' || !body.requested.trim())))
	throw new Error('routing broker request refused');
      const response = await checked(grant, grant.hub.routingReject({ workflow, run, path: body.path,
	text: body.text, ...(body.requested === undefined ? {} : { requested: body.requested }) }, signal), now);
      if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'string')
	throw new Error('routing broker response refused');
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
      const response = await checked(grant, grant.hub.routingRequestApproval({ workflow, run,
	tool_use_id: body.tool_use_id, tool_name: body.tool_name, tool_input: body.tool_input,
	reason: body.reason, ...(body.title === undefined ? {} : { title: body.title }) }, signal), now);
      if (!response || typeof response.ok !== 'boolean' || typeof response.text !== 'string')
	throw new Error('routing broker response refused');
      return response;
    }
    case 'read_invocation_binding': {
      if (scope !== 'role' || !exactKeys(body, ['parentWorkflow', 'parentDefRef', 'callPath'])
	&& !exactKeys(body, ['parentWorkflow', 'parentDefRef', 'callPath', 'parentArtifactVersion']))
	throw new Error('routing broker request refused');
      if (typeof body.parentWorkflow !== 'string' || !body.parentWorkflow
	|| !exactKeys(body.parentDefRef, ['bundleDigest', 'workflowName'])
	|| typeof body.parentDefRef.bundleDigest !== 'string' || !body.parentDefRef.bundleDigest
	|| typeof body.parentDefRef.workflowName !== 'string' || !body.parentDefRef.workflowName
	|| typeof body.callPath !== 'string' || !body.callPath
	|| (body.parentArtifactVersion !== undefined && (!Number.isSafeInteger(body.parentArtifactVersion)
	  || (body.parentArtifactVersion as number) < 1))) throw new Error('routing broker request refused');
      const response = await checked(grant, grant.hub.readInvocationBinding({ workflow, orderId: run,
	parentWorkflow: body.parentWorkflow, parentDefRef: {
	  bundleDigest: body.parentDefRef.bundleDigest,
	  workflowName: body.parentDefRef.workflowName,
	},
	callPath: body.callPath, ...(body.parentArtifactVersion === undefined
	  ? {} : { parentArtifactVersion: body.parentArtifactVersion as number }) }, signal), now, true);
      if (!response || response.protocol !== 'owenloop-binding-v1'
	|| response.orgId !== grant.identity.orgId || response.freshness !== 'fresh-at-read'
	|| response.atomicLaunch !== false || !response.binding || typeof response.binding.id !== 'string'
	|| !response.binding.id || typeof response.bindingJson !== 'string'
	|| typeof response.bindingDigest !== 'string') throw new Error('routing broker response refused');
      return response;
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
  const now = args.now ?? Date.now;
  const uploadIdleMs = args.uploadTimeouts?.idleMs ?? UPLOAD_IDLE_MS;
  const uploadAbsoluteMs = args.uploadTimeouts?.absoluteMs ?? UPLOAD_ABSOLUTE_MS;
  if (!Number.isSafeInteger(uploadIdleMs) || uploadIdleMs <= 0
    || !Number.isSafeInteger(uploadAbsoluteMs) || uploadAbsoluteMs <= uploadIdleMs
    || uploadAbsoluteMs > UPLOAD_ABSOLUTE_MS) throw new Error('routing broker upload timeout refused');
  let closed = false;
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
	    if (tail.length > 0 || !entry.grant.ready || !validateSessionGrant(entry.grant, now())
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
	    upload = { remaining: body.size as number, stream };
	    const keyPrefix = `orgs/${grant.identity.orgId}/artifacts/${grant.reservation.workflow}`
	      + `/files/routed/${encodeURIComponent(grant.reservation.run)}/`;
	    void checked(grant, grant.hub.routingPutFileArtifact({
	      workflow: grant.reservation.workflow, run: grant.reservation.run,
	      body: stream, size: body.size as number, contentType: body.contentType,
	      ...(body.filename === undefined ? {} : { filename: body.filename }),
	    }, controller.signal), now).then((value: PutFileArtifactResponse) => {
	      if (!value || typeof value.__file !== 'string' || !value.__file.startsWith(keyPrefix)
		|| !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
		  value.__file.slice(keyPrefix.length))
		|| typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
		|| value.size !== body.size || value.contentType !== body.contentType
		|| value.filename !== body.filename
		|| typeof value.text !== 'string') throw new Error('routing broker response refused');
	      if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, value }) + '\n');
	    }).catch(refuse).finally(() => {
	      grant.uploadControllers.delete(controller);
	      stream.destroy();
	    });
	    feedUpload(tail);
	    return;
	  }
	  if (tail.length > 0) throw new Error();
  const methods: readonly string[] = ['get_order', 'get_launch_order', 'read_routing_claim', 'assess_local_model',
	    'reserve_launch', 'report_launch', 'heartbeat', 'submit', 'release', 'ask', 'reject',
	    'request_approval', 'read_invocation_binding'];
	  if (!methods.includes(request.method)) throw new Error();
	  const value = await invoke(entry.grant, entry.scope, request.method as Method, request.body, now, controller.signal);
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
    issue({ reservation, routing, identity, currentIdentity, hub, submissionAuthority, launchAuthority }) {
      if (closed) throw new Error('routing broker closed');
      const grant: Grant = { active: true, ready: false, uploadControllers: new Set(),
	reservation: structuredClone(reservation), routing: structuredClone(routing),
	identity: { ...identity }, currentIdentity, hub, submissionAuthority, launchAuthority };
      if (!validateLaunchGrant(grant, now())) throw new Error('routing broker grant refused');
      const cap = randomBytes(32).toString('hex');
      const holderCap = reservation.childKind === 'agent-run' ? randomBytes(32).toString('hex') : undefined;
      grants.set(cap, { grant, scope: 'role' });
      if (holderCap) grants.set(holderCap, { grant, scope: 'holder' });
      let terminal = false;
      return { socketPath, cap, ...(holderCap ? { holder: { socketPath, cap: holderCap } } : {}), activate(record) {
	  if (closed || grant.ready || !validateLaunchGrant(grant, now()) || record.workflow !== reservation.workflow
	    || record.run !== reservation.run || record.gateToken !== reservation.token
	    || (record.kind ?? 'exec') !== reservation.childKind
	    || !Number.isSafeInteger(record.pid) || record.pid <= 0
	    || !Number.isSafeInteger(record.spawnedAt)) throw new Error('routing broker grant unavailable');
	  grant.execHolderId = `${hostname()}:${record.pid}`;
	  grant.ready = true;
	}, terminal() {
	if (terminal) return;
	terminal = true;
	grant.active = false;
	grant.ready = false;
	for (const controller of grant.uploadControllers) controller.abort();
	grants.delete(cap);
	if (holderCap) grants.delete(holderCap);
      } };
    },
    async close() {
      if (closed) return;
      closed = true;
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
    },
  };
}
