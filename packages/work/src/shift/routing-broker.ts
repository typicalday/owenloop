/**
 * Private, per-Shift routed child transport. The Shift retains both Hub
 * credentials; a child receives only a random, one-dispatch socket capability.
 * No caller may choose a URL, header, verb, workflow, run or session.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RoutingHubClient } from '../hub/client.ts';
import { HubError, type LaunchReportV1, type LaunchReservationRequestV1, type ReferenceRouting } from '../hub/types.ts';
import type { ChildReservation } from './state.ts';

const MAX_LINE = 64 * 1024;
const CAP = /^[a-f0-9]{64}$/;
type Identity = { sessionId: string; shiftId: string; orgId: string; principalId: string; expiresAt: number };
type Method = 'get_order' | 'read_routing_claim' | 'assess_local_model' | 'reserve_launch' | 'report_launch'
  | 'heartbeat' | 'submit';
interface Grant {
  active: boolean;
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
    currentIdentity: () => Identity | undefined; hub: RoutingHubClient }): { socketPath: string; cap: string; terminal(): void };
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
function validateGrant(grant: Grant, now: number): boolean {
  const { reservation, routing, identity } = grant;
  const claim = routing.claim;
  const current = grant.currentIdentity();
  return grant.active && current !== undefined && current.sessionId === identity.sessionId
    && current.shiftId === identity.shiftId && current.orgId === identity.orgId
    && current.principalId === identity.principalId && now < current.expiresAt
    && now < routing.preference.expiresAt
    && now < claim.binding.expiresAt && claim.state === 'claimed'
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

async function checked<T>(grant: Grant, call: Promise<T>, now: () => number): Promise<T> {
  try {
    const value = await call;
    if (!validateGrant(grant, now())) throw new Error('routing broker grant expired');
    return value;
  } catch (error) {
    if (!validateGrant(grant, now())) throw new Error('routing broker grant expired');
    throw error;
  }
}

async function invoke(grant: Grant, method: Method, body: unknown, now: () => number): Promise<unknown> {
  if (!validateGrant(grant, now()))
    throw new Error('routing broker grant expired');
  const { workflow, run, childKind } = grant.reservation;
  switch (method) {
    case 'get_order':
      if (!exactKeys(body, [])) throw new Error('routing broker request refused');
      return checked(grant, grant.hub.getOrder({ workflow, run }), now);
    case 'read_routing_claim':
      if (!exactKeys(body, [])) throw new Error('routing broker request refused');
      return checked(grant, grant.hub.readRoutingClaim({ workflow, run }), now);
    case 'assess_local_model':
      if (!exactKeys(body, ['candidateIds']) || !orderedCandidates(grant, body.candidateIds)
	|| childKind !== 'agent-run' || !grant.routing.preference.localModel
	|| body.candidateIds.length === 0) throw new Error('routing broker request refused');
      return checked(grant, grant.hub.assessLocalModel({ workflow, run, candidateIds: body.candidateIds }), now);
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
      const response = await checked(grant, grant.hub.reserveLaunch({ workflow, request }), now);
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
      return checked(grant, grant.hub.reportLaunch({ workflow, report }), now);
    }
    // Scoped lifecycle routes are not wired yet. Refuse rather than falling
    // through to bearer-only HubClient. The child role remains fail closed.
    case 'heartbeat':
    case 'submit':
      throw new Error('routing broker lifecycle unavailable');
  }
}

/** Start a separate private socket for both foreground and daemon Shift modes. */
export async function createRoutingBroker(args: { now?: () => number } = {}): Promise<RoutingBroker> {
  // macOS limits Unix socket paths to about 104 bytes. A short private temp
  // directory works even when the operator's Shift state path is deeply nested.
  const directory = mkdtempSync(join(tmpdir(), 'ol-rb-'));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, 'broker.sock');
  const grants = new Map<string, Grant>();
  const now = args.now ?? Date.now;
  let closed = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
    let bytes = 0;
    let line = '';
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_LINE) { handled = true; socket.destroy(); return; }
      line += chunk.toString('utf8');
      const newline = line.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      const raw = line.slice(0, newline);
      void (async () => {
	try {
	  const request: unknown = JSON.parse(raw);
	  if (!exactKeys(request, ['cap', 'method', 'body']) || typeof request.cap !== 'string'
	    || !CAP.test(request.cap) || typeof request.method !== 'string') throw new Error();
	  const grant = grants.get(request.cap);
	  if (!grant || closed) throw new Error();
	  const methods: readonly string[] = ['get_order', 'read_routing_claim', 'assess_local_model',
	    'reserve_launch', 'report_launch', 'heartbeat', 'submit'];
	  if (!methods.includes(request.method)) throw new Error();
	  const value = await invoke(grant, request.method as Method, request.body, now);
	  socket.end(JSON.stringify({ ok: true, value }) + '\n');
	} catch (error) {
	  // No raw Hub body, credential, grant or request data on the wire.
	  const status = error instanceof HubError ? error.status : undefined;
	  const retryAfterMs = error instanceof HubError ? error.retryAfterMs : undefined;
	  socket.end(JSON.stringify({ ok: false, error: 'routing request refused',
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
      const grant: Grant = { active: true, reservation: structuredClone(reservation), routing: structuredClone(routing),
	identity: { ...identity }, currentIdentity, hub };
      if (!validateGrant(grant, now())) throw new Error('routing broker grant refused');
      const cap = randomBytes(32).toString('hex');
      grants.set(cap, grant);
      let terminal = false;
      return { socketPath, cap, terminal() {
	if (terminal) return;
	terminal = true;
	grant.active = false;
	grants.delete(cap);
      } };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const grant of grants.values()) grant.active = false;
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
