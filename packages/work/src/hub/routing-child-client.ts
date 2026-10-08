/** Narrow routed-child RPC client. It has no bearer, session key, URL or
 * generic Hub verb API; Shift binds every request at the private broker. */
import { createConnection } from 'node:net';
import type { RoutingHandoffV1 } from '../shift/runtime.ts';
import { HubError, type GetOrderRequest, type GetOrderResponse, type HeartbeatRequest,
  type HeartbeatResponse, type LocalModelRequest, type LocalModelResponse,
  type LaunchReportV1, type LaunchReportResponse, type LaunchReservationRequestV1,
  type LaunchReservationResponse, type ReleaseRequest, type ReleaseResponse,
  type RoutingClaimReadResponse, type SubmitRequest, type SubmitResponse } from './types.ts';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
type Verb = 'get_order' | 'read_routing_claim' | 'assess_local_model' | 'reserve_launch'
  | 'report_launch' | 'heartbeat' | 'submit' | 'release';

export interface RoutingChildClient {
  getOrder(req: GetOrderRequest): Promise<GetOrderResponse>;
  readRoutingClaim(req: { workflow: string; run: string }): Promise<RoutingClaimReadResponse>;
  assessLocalModel(req: LocalModelRequest): Promise<LocalModelResponse>;
  reserveLaunch(req: { workflow: string; request: LaunchReservationRequestV1 }): Promise<LaunchReservationResponse>;
  reportLaunch(req: { workflow: string; report: LaunchReportV1 }): Promise<LaunchReportResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  submit(req: SubmitRequest): Promise<SubmitResponse>;
  release(req: ReleaseRequest): Promise<ReleaseResponse>;
}

function refused(): Error { return new Error('routing broker unavailable'); }

export function createRoutingChildClient(handoff: RoutingHandoffV1): RoutingChildClient {
  const broker = handoff.broker;
  if (!broker || typeof broker.socketPath !== 'string' || !broker.socketPath
    || typeof broker.cap !== 'string' || !/^[a-f0-9]{64}$/.test(broker.cap))
    throw refused();
  const { workflow, run } = handoff.reservation;
  const bound = (value: { workflow: string; run: string }) => {
    if (value.workflow !== workflow || value.run !== run) throw new Error('routing order binding refused');
  };
  const exchange = <T>(method: Verb, body: unknown): Promise<T> => {
    const frame = JSON.stringify({ cap: broker.cap, method, body }) + '\n';
    if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES) return Promise.reject(new Error('routing broker request too large'));
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(broker.socketPath);
      let settled = false;
      let length = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error, value?: T) => {
	if (settled) return;
	settled = true;
	socket.destroy();
	if (error) reject(error);
	else resolve(value as T);
      };
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(refused()));
      socket.once('connect', () => socket.write(frame));
      socket.on('data', (chunk: Buffer) => {
	length += chunk.length;
	if (length > MAX_RESPONSE_BYTES) { finish(refused()); return; }
	chunks.push(chunk);
	if (chunk.indexOf(0x0a) < 0) return;
	const bytes = Buffer.concat(chunks, length);
	const newline = bytes.indexOf(0x0a);
	let response: unknown;
	try { response = JSON.parse(bytes.subarray(0, newline).toString('utf8')); }
	catch { finish(refused()); return; }
	if (!response || typeof response !== 'object' || !('ok' in response)) { finish(refused()); return; }
	const packet = response as Record<string, unknown>;
	if (packet.ok === true && packet.value !== undefined && packet.value !== null
	  && typeof packet.value === 'object') { finish(undefined, packet.value as T); return; }
	if (packet.ok === false) {
	  const status = packet.status;
	  const delay = packet.retryAfterMs;
	  if (typeof status === 'number' && Number.isSafeInteger(status) && status >= 400 && status <= 599
	    && (delay === undefined || (typeof delay === 'number' && Number.isFinite(delay) && delay >= 0))) {
	    finish(new HubError(status, 'routing request refused', undefined, delay as number | undefined));
	    return;
	  }
	}
	finish(refused());
      });
      socket.once('error', () => finish(refused()));
      socket.once('end', () => finish(refused()));
    });
  };
  return {
    getOrder(req) { bound(req); return exchange('get_order', { holder: req.holder }); },
    readRoutingClaim(req) { bound(req); return exchange('read_routing_claim', {}); },
    assessLocalModel(req) { bound(req); return exchange('assess_local_model', { candidateIds: req.candidateIds }); },
    reserveLaunch(req) {
      if (req.workflow !== workflow || req.request.orderId !== run || req.request.attemptId !== run)
	throw new Error('routing order binding refused');
      return exchange('reserve_launch', { request: req.request });
    },
    reportLaunch(req) {
      if (req.workflow !== workflow || req.report.orderId !== run || req.report.attemptId !== run)
	throw new Error('routing order binding refused');
      return exchange('report_launch', { report: req.report });
    },
    heartbeat(req) { bound(req); return exchange('heartbeat', { holder: req.holder }); },
    submit(req) {
      bound(req);
      return exchange('submit', { path: req.path, value: req.value, holder: req.holder,
	...(req.done === undefined ? {} : { done: req.done }),
	...(req.proof === undefined ? {} : { proof: req.proof }) });
    },
    release(req) {
      if (!('workflow' in req) || !('run' in req)) throw new Error('routing order binding refused');
      bound(req);
      return exchange('release', req.reason === undefined ? {} : { reason: req.reason });
    },
  };
}
