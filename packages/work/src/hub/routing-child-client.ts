/** Narrow routed-child RPC client. It has no bearer, session key, URL or
 * generic Hub verb API; Shift binds every request at the private broker. */
import { createConnection } from 'node:net';
import { Readable } from 'node:stream';
import { HubError, type GetOrderRequest, type GetOrderResponse, type HeartbeatRequest,
  type HeartbeatResponse, type LocalModelRequest, type LocalModelResponse,
  type LaunchReportV1, type LaunchReportResponse, type LaunchReservationRequestV1,
  type LaunchReservationResponse, type ReleaseRequest, type ReleaseResponse,
  type RoutingClaimReadResponse, type SubmitRequest, type SubmitResponse,
  type AskRequest, type AskResponse, type RejectRequest, type RejectResponse,
  type RequestApprovalRequest, type RequestApprovalResponse,
  type InvocationBindingReadRequest, type InvocationBindingReadResponse,
  type PutFileArtifactRequest, type PutFileArtifactResponse } from './types.ts';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_FILE = 500_000_000;
const UPLOAD_IDLE_MS = 4 * 60_000;
const UPLOAD_ABSOLUTE_MS = 14 * 60_000;
type Verb = 'get_order' | 'read_routing_claim' | 'assess_local_model' | 'reserve_launch'
  | 'report_launch' | 'heartbeat' | 'submit' | 'release' | 'ask' | 'reject'
  | 'request_approval' | 'read_invocation_binding';

export interface RoutingChildClient {
  getOrder(req: GetOrderRequest): Promise<GetOrderResponse>;
  readRoutingClaim(req: { workflow: string; run: string }): Promise<RoutingClaimReadResponse>;
  assessLocalModel(req: LocalModelRequest): Promise<LocalModelResponse>;
  reserveLaunch(req: { workflow: string; request: LaunchReservationRequestV1 }): Promise<LaunchReservationResponse>;
  reportLaunch(req: { workflow: string; report: LaunchReportV1 }): Promise<LaunchReportResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  submit(req: SubmitRequest): Promise<SubmitResponse>;
  release(req: ReleaseRequest): Promise<ReleaseResponse>;
  ask(req: AskRequest): Promise<AskResponse>;
  reject(req: RejectRequest): Promise<RejectResponse>;
  requestApproval(req: RequestApprovalRequest): Promise<RequestApprovalResponse>;
  readInvocationBinding(req: InvocationBindingReadRequest): Promise<InvocationBindingReadResponse>;
  putFileArtifact(req: PutFileArtifactRequest): Promise<PutFileArtifactResponse>;
  /** Byte stream stays in the child process; no file path crosses the broker. */
  putFileArtifactStream(req: { workflow: string; size: number; chunks: AsyncIterable<Uint8Array>;
    contentType: string; filename?: string }): Promise<PutFileArtifactResponse>;
}

function refused(): Error { return new Error('routing broker unavailable'); }

export function createRoutingChildClient(handoff: {
  broker?: { socketPath: string; cap: string };
  reservation: { workflow: string; run: string };
}): RoutingChildClient {
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
  const upload = (req: { workflow: string; size: number; chunks: AsyncIterable<Uint8Array>;
    contentType: string; filename?: string }): Promise<PutFileArtifactResponse> => {
    bound({ workflow: req.workflow, run });
    if (!Number.isSafeInteger(req.size) || req.size <= 0
      || req.size > MAX_FILE || typeof req.contentType !== 'string'
      || !req.contentType.trim() || req.contentType.length > 256
      || (req.filename !== undefined && (typeof req.filename !== 'string'
	|| !req.filename || req.filename.length > 1024))) return Promise.reject(refused());
    const frame = JSON.stringify({ cap: broker.cap, method: 'upload_file', body: {
      size: req.size, contentType: req.contentType,
      ...(req.filename === undefined ? {} : { filename: req.filename }),
    } }) + '\n';
    return new Promise<PutFileArtifactResponse>((resolve, reject) => {
      const socket = createConnection(broker.socketPath);
      let settled = false;
      let sent = 0;
      let length = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error, value?: PutFileArtifactResponse) => {
	if (settled) return;
	settled = true;
	clearTimeout(totalTimer);
	if (req.chunks instanceof Readable) req.chunks.destroy();
	socket.destroy();
	if (error) reject(error);
	else resolve(value!);
      };
      const drain = () => new Promise<void>((resume, fail) => {
	const done = () => { socket.off('close', closed); resume(); };
	const closed = () => { socket.off('drain', done); fail(refused()); };
	socket.once('drain', done);
	socket.once('close', closed);
      });
      const pump = async () => {
	try {
	  for await (const part of req.chunks) {
	    if (settled || !(part instanceof Uint8Array) || sent + part.byteLength > req.size)
	      throw refused();
	    for (let offset = 0; offset < part.byteLength; offset += 64 * 1024) {
	      const end = Math.min(offset + 64 * 1024, part.byteLength);
	      if (!socket.write(part.subarray(offset, end))) await drain();
	    }
	    sent += part.byteLength;
	  }
	  if (sent !== req.size) throw refused();
	} catch { finish(refused()); }
      };
      const totalTimer = setTimeout(() => finish(refused()), UPLOAD_ABSOLUTE_MS);
      totalTimer.unref();
      socket.setTimeout(UPLOAD_IDLE_MS, () => finish(refused()));
      socket.once('connect', () => { void (async () => {
	try { if (!socket.write(frame)) await drain(); await pump(); }
	catch { finish(refused()); }
      })(); });
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
	if (packet.ok === true && packet.value && typeof packet.value === 'object') {
	  finish(undefined, packet.value as PutFileArtifactResponse); return;
	}
	if (packet.ok === false && typeof packet.status === 'number'
	  && Number.isSafeInteger(packet.status) && packet.status >= 400 && packet.status <= 599
	  && (packet.retryAfterMs === undefined || (typeof packet.retryAfterMs === 'number'
	    && Number.isFinite(packet.retryAfterMs) && packet.retryAfterMs >= 0))) {
	  finish(new HubError(packet.status, 'routing request refused', undefined,
	    packet.retryAfterMs as number | undefined)); return;
	}
	finish(refused());
      });
      socket.once('error', () => finish(refused()));
      socket.once('end', () => finish(refused()));
      socket.once('close', () => finish(refused()));
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
    ask(req) { bound(req); return exchange('ask', { path: req.path, question: req.question,
      ...(req.context === undefined ? {} : { context: req.context }) }); },
    reject(req) { bound(req); return exchange('reject', { path: req.path, text: req.text,
      ...(req.requested === undefined ? {} : { requested: req.requested }) }); },
    requestApproval(req) { bound(req); return exchange('request_approval', {
      tool_use_id: req.tool_use_id, tool_name: req.tool_name, tool_input: req.tool_input,
      reason: req.reason, ...(req.title === undefined ? {} : { title: req.title }),
    }); },
    readInvocationBinding(req) {
      if (req.workflow !== workflow || req.orderId !== run) throw new Error('routing order binding refused');
      return exchange('read_invocation_binding', { parentWorkflow: req.parentWorkflow,
	parentDefRef: req.parentDefRef, callPath: req.callPath,
	...(req.parentArtifactVersion === undefined ? {} : { parentArtifactVersion: req.parentArtifactVersion }) });
    },
    putFileArtifact(req) {
      if (!(req.bytes instanceof Uint8Array)) return Promise.reject(refused());
      return upload({ workflow: req.workflow, size: req.bytes.byteLength,
	chunks: Readable.from([req.bytes]), contentType: req.contentType,
	...(req.filename === undefined ? {} : { filename: req.filename }) });
    },
    putFileArtifactStream: upload,
  };
}
