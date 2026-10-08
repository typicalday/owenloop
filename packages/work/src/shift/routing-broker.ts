/**
 * Private, per-Shift routed child transport. The Shift retains both Hub
 * credentials; a child receives only a random, one-dispatch socket capability.
 * No caller may choose a URL, header, verb, workflow, run or session.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RoutingHubClient } from '../hub/client.ts';
import { HubError, type ContactHolder, type GetOrderResponse, type LaunchReportV1,
  type LaunchReservationRequestV1, type ReferenceRouting } from '../hub/types.ts';
import type { ChildRecord, ChildReservation } from './state.ts';

// Service permits artifact values up to 25 MB. Leave bounded JSON overhead
// while allowing a normal submit receipt through this private transport.
const MAX_LINE = 32 * 1024 * 1024;
const MAX_SOCKETS = 16;
const CAP = /^[a-f0-9]{64}$/;
type Identity = { sessionId: string; shiftId: string; orgId: string; principalId: string; expiresAt: number };
type Method = 'get_order' | 'read_routing_claim' | 'assess_local_model' | 'reserve_launch' | 'report_launch'
  | 'heartbeat' | 'submit' | 'release';
type CapScope = 'role' | 'holder';
interface Grant {
  active: boolean;
  ready: boolean;
  execHolderId?: string;
  allowedPaths?: Set<string>;
  reservation: ChildReservation;
  routing: ReferenceRouting;
  identity: Identity;
  currentIdentity: () => Identity | undefined;
  hub: RoutingHubClient;
  reservationRequest?: LaunchReservationRequestV1;
  launchReservationId?: string;
}
export interface RoutingBroker {
  issue(args: { reservation: ChildReservation; routing: ReferenceRouting; identity: Identity;
    currentIdentity: () => Identity | undefined; hub: RoutingHubClient }): {
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
    && claim.claimId === reservation.run && claim.orderId === reservation.run && claim.attemptId === reservation.run
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

async function invoke(grant: Grant, scope: CapScope, method: Method, body: unknown, now: () => number,
  signal: AbortSignal): Promise<unknown> {
  if (scope === 'holder' && method !== 'get_order' && method !== 'heartbeat' && method !== 'submit')
    throw new Error('routing broker request refused');
  const launch = method === 'assess_local_model' || method === 'reserve_launch' || method === 'report_launch';
  if (!grant.ready || !(launch ? validateLaunchGrant(grant, now()) : validateSessionGrant(grant, now())))
    throw new Error('routing broker grant expired');
  const { workflow, run, childKind } = grant.reservation;
  switch (method) {
    case 'get_order': {
      if (!exactKeys(body, ['holder']) || !validHolder(grant, scope, body.holder)) throw new Error('routing broker request refused');
      const response = await checked(grant, grant.hub.getOrder({ workflow, run, holder: body.holder }, signal), now);
      if (!validOrderResponse(grant, response)) throw new Error('routing broker response refused');
      const order = response.order;
      grant.allowedPaths = order && response.lease.claimed
	? new Set((order.owes.length ? order.owes.map(owe => owe.path) : order.outputs))
	: undefined;
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
      const response = await checked(grant, grant.hub.reserveLaunch({ workflow, request }, signal), now, true);
      const current = grant.currentIdentity();
      if (!response || response.orderId !== run || typeof response.reservationId !== 'string'
	|| !response.reservationId || !Number.isSafeInteger(response.expiresAt) || response.expiresAt <= now()
	|| !current || response.expiresAt > Math.min(current.expiresAt,
	  grant.routing.preference.expiresAt, grant.routing.claim.binding.expiresAt))
	throw new Error('routing broker reservation refused');
      grant.reservationRequest = structuredClone(request);
      grant.launchReservationId = response.reservationId;
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
      return checked(grant, grant.hub.reportLaunch({ workflow, report }, signal), now, true);
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
	&& !exactKeys(body, ['path', 'value', 'holder', 'done'])
	&& !exactKeys(body, ['path', 'value', 'holder', 'proof'])
	&& !exactKeys(body, ['path', 'value', 'holder', 'done', 'proof'])) throw new Error('routing broker request refused');
      if (typeof body.path !== 'string' || !body.path || !grant.allowedPaths?.has(body.path)
	|| !validHolder(grant, scope, body.holder)
	|| (body.done !== undefined && typeof body.done !== 'boolean')
	|| (body.proof !== undefined && (typeof body.proof !== 'string' || !body.proof)))
	throw new Error('routing broker request refused');
      const response = await checked(grant, grant.hub.routingSubmit({ workflow, run, path: body.path,
	value: body.value, holder: body.holder,
	...(body.done === undefined ? {} : { done: body.done }),
	...(body.proof === undefined ? {} : { proof: body.proof }) }, signal), now);
      if (!response || typeof response.outcome !== 'string' || !response.outcome
	|| (response.closed !== undefined && typeof response.closed !== 'boolean'))
	throw new Error('routing broker response refused');
      return response;
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
  }
}

/** Start a separate private socket for both foreground and daemon Shift modes. */
export async function createRoutingBroker(args: { now?: () => number } = {}): Promise<RoutingBroker> {
  // macOS limits Unix socket paths to about 104 bytes. A short private temp
  // directory works even when the operator's Shift state path is deeply nested.
  const directory = mkdtempSync(join(tmpdir(), 'ol-rb-'));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, 'broker.sock');
  const grants = new Map<string, { grant: Grant; scope: CapScope }>();
  const now = args.now ?? Date.now;
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
    socket.on('data', data => {
      if (handled) return;
      const chunk = typeof data === 'string' ? Buffer.from(data) : data;
      bytes += chunk.length;
      if (bytes > MAX_LINE) { handled = true; socket.destroy(); return; }
      chunks.push(chunk);
      if (chunk.indexOf(0x0a) < 0) return;
      handled = true;
      const frame = Buffer.concat(chunks, bytes);
      const raw = frame.subarray(0, frame.indexOf(0x0a)).toString('utf8');
      void (async () => {
	try {
	  const request: unknown = JSON.parse(raw);
	  if (!exactKeys(request, ['cap', 'method', 'body']) || typeof request.cap !== 'string'
	    || !CAP.test(request.cap) || typeof request.method !== 'string') throw new Error();
	  const entry = grants.get(request.cap);
	  if (!entry || closed) throw new Error();
	  const methods: readonly string[] = ['get_order', 'read_routing_claim', 'assess_local_model',
	    'reserve_launch', 'report_launch', 'heartbeat', 'submit', 'release'];
	  if (!methods.includes(request.method)) throw new Error();
	  const value = await invoke(entry.grant, entry.scope, request.method as Method, request.body, now, controller.signal);
	  if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, value }) + '\n');
	} catch (error) {
	  // No raw Hub body, credential, grant or request data on the wire.
	  const status = error instanceof HubError ? error.status : undefined;
	  const retryAfterMs = error instanceof HubError ? error.retryAfterMs : undefined;
	  if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: 'routing request refused',
	    ...(status === undefined ? {} : { status }),
	    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }) + '\n');
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
    issue({ reservation, routing, identity, currentIdentity, hub }) {
      if (closed) throw new Error('routing broker closed');
      const grant: Grant = { active: true, ready: false, reservation: structuredClone(reservation), routing: structuredClone(routing),
	identity: { ...identity }, currentIdentity, hub };
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
	grants.delete(cap);
	if (holderCap) grants.delete(holderCap);
      } };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const entry of grants.values()) entry.grant.active = false;
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
