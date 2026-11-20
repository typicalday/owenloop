/** Narrow routed-child RPC client. It has no bearer, session key, URL or
 * generic Hub verb API; Shift binds every request at the private broker. */
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { parseRoutedClaimV2, parseRoutedReferenceV2,
  type RoutedClaimV2, type RoutedPrestartPairV2, type RoutedReferenceV2 } from '../hosted/trusted-routed-reference-v2.ts';
import { isDeepStrictEqual } from 'node:util';
import type { RecordedClaimV2, RecordedReferenceV2 } from '../hosted/trusted-routed-recorded-v2.ts';
import type { RoutedQuiesceResult } from '../shift/routing-broker.ts';
import type { VerifiedInvocationReceipt } from '../../../../src/types.ts';
import type { CommandPostrunRequest, CommandPostrunResponse,
  CommandPostrunStatus } from '../shift/routing-command-postrun.ts';
import { HubError, type GetOrderRequest, type GetOrderResponse, type HeartbeatRequest,
  type HeartbeatResponse, type LocalModelRequest, type LocalModelResponse,
  type LaunchReportV1, type LaunchReportResponse, type LaunchReservationRequestV1,
  type LaunchReservationResponse, type ReleaseRequest, type ReleaseResponse,
  type RoutingClaimReadResponse, type SubmitRequest, type SubmitResponse,
  type AskRequest, type AskResponse, type RejectRequest, type RejectResponse,
  type RequestApprovalRequest, type RequestApprovalResponse,
  type InvocationBindingReadRequest,
  type PutFileArtifactRequest, type PutFileArtifactResponse, type FileArtifactPointer,
  type RoutedCollectionWriteResponse, type RoutedMemberIssueResponse } from './types.ts';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_FILE = 500_000_000;
const UPLOAD_IDLE_MS = 4 * 60_000;
const UPLOAD_ABSOLUTE_MS = 14 * 60_000;
const MAX_DOWNLOAD_HEADER = 4096;
type Verb = 'get_order' | 'get_launch_order' | 'read_routing_claim' | 'assess_local_model' | 'reserve_launch'
  | 'read_routed_reference_v2' | 'read_routing_claim_v2' | 'read_routed_pair_v2'
  | 'read_live_routed_reference_v2' | 'read_live_routing_claim_v2'
  | 'report_launch' | 'heartbeat' | 'submit' | 'release' | 'ask' | 'reject' | 'quiesce'
  | 'command_postrun' | 'command_postrun_status' | 'command_finish' | 'agent_outcome' | 'agent_finish'
  | 'request_approval' | 'read_invocation_binding';
type CollectionVerb = Verb | 'collection_target' | 'emit_member' | 'seal_collection';

export interface RoutingChildClient {
  getOrder(req: GetOrderRequest): Promise<GetOrderResponse>;
  /** Role-only final launch read; requires an accepted report and fresh parent
   * selection. Ordinary holder reads retain their independent claim lifetime. */
  getLaunchOrder(req: GetOrderRequest): Promise<GetOrderResponse>;
  readRoutingClaim(req: { workflow: string; run: string }): Promise<RoutingClaimReadResponse>;
  readRoutedReferenceV2(req: { workflow: string; run: string }): Promise<RoutedReferenceV2>;
  readRoutingClaimV2(req: { workflow: string; run: string }): Promise<RoutedClaimV2>;
  readRoutedPairV2(req: { workflow: string; run: string }): Promise<RoutedPrestartPairV2>;
  readLiveRoutedReferenceV2(req: { workflow: string; run: string }): Promise<RecordedReferenceV2>;
  readLiveRoutingClaimV2(req: { workflow: string; run: string }): Promise<RecordedClaimV2>;
  assessLocalModel(req: LocalModelRequest): Promise<LocalModelResponse>;
  reserveLaunch(req: { workflow: string; request: LaunchReservationRequestV1 }): Promise<LaunchReservationResponse>;
  reportLaunch(req: { workflow: string; report: LaunchReportV1 }): Promise<LaunchReportResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  /** Freeze role and holder effects. ACK is local broker state, not a fleet seal. */
  quiesce(): Promise<RoutedQuiesceResult>;
  /** Data-only handoff; no child-selected target, signer, holder or URL. */
  commandPostrun(req: CommandPostrunRequest, signal?: AbortSignal, timeoutMs?: number): Promise<CommandPostrunResponse>;
  commandPostrunStatus(bodyDigest: string, signal?: AbortSignal, timeoutMs?: number): Promise<CommandPostrunStatus>;
  /** Parent checks current native claim and uses only a targeted release. */
  commandFinish(req: { group: { scope: 'original-posix-group'; state: 'empty' } }
    | { observation: 'not-started' }):
    Promise<{ state: 'released' | 'already-closed' | 'uncertain' }>;
  /** Parent-owned terminal state; the role supplies only its local group observation. */
  agentOutcome(req: { group: { scope: 'original-posix-group'; state: 'empty' } }, signal?: AbortSignal):
    Promise<{ claim: 'closed' | 'held' | 'uncertain' }>;
  agentFinish(req: { group: { scope: 'original-posix-group'; state: 'empty' } }
    | { observation: 'not-started' }, signal?: AbortSignal):
    Promise<{ state: 'released' | 'already-closed' | 'uncertain' }>;
  submit(req: SubmitRequest): Promise<SubmitResponse>;
  collectionTarget(req: { workflow: string; run: string; path: string;
    holder: NonNullable<SubmitRequest['holder']> }): Promise<{ collection: boolean }>;
  emitCollectionMember(req: { workflow: string; run: string; sealPath: string;
    emissionId: string; value: unknown; done: boolean; holder: NonNullable<SubmitRequest['holder']> }):
    Promise<{ member: RoutedCollectionWriteResponse; seal?: RoutedCollectionWriteResponse;
      issued: RoutedMemberIssueResponse }>;
  sealCollection(req: { workflow: string; run: string; sealPath: string; sealId: string;
    holder: NonNullable<SubmitRequest['holder']> }): Promise<RoutedCollectionWriteResponse>;
  release(req: ReleaseRequest): Promise<ReleaseResponse>;
  ask(req: AskRequest): Promise<AskResponse>;
  reject(req: RejectRequest): Promise<RejectResponse>;
  requestApproval(req: RequestApprovalRequest): Promise<RequestApprovalResponse>;
  readInvocationBinding(req: InvocationBindingReadRequest & { parentArtifactVersion: number }):
    Promise<VerifiedInvocationReceipt>;
  putFileArtifact(req: PutFileArtifactRequest): Promise<PutFileArtifactResponse>;
  /** Byte stream stays in the child process; no file path crosses the broker. */
  putFileArtifactStream(req: { workflow: string; size: number; chunks: AsyncIterable<Uint8Array>;
    contentType: string; filename?: string }): Promise<PutFileArtifactResponse>;
  /** Chunks are provisional until `verified` resolves after exact EOF/hash. */
  getFileArtifactStream(req: { workflow: string; run: string; path: string;
    pointer: FileArtifactPointer }, signal?: AbortSignal): Promise<{ size: number; contentType: string;
      chunks: AsyncIterable<Uint8Array>; verified: Promise<void> }>;
}

function refused(): Error { return new Error('routing broker unavailable'); }
/** Only socket loss or timeout leaves the child unsure whether its exact
 * request reached the parent. An authenticated refusal is never recoverable
 * through the status read. */
export class RoutingBrokerTransportLoss extends Error {
  constructor() { super('routing broker transport lost'); }
}

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
  const exchange = <T>(method: CollectionVerb, body: unknown, absoluteMs?: number,
    signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(refused());
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
	if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
	signal?.removeEventListener('abort', abort);
	socket.destroy();
	if (error) reject(error);
	else resolve(value as T);
      };
      const deadlineTimer = absoluteMs === undefined ? undefined : setTimeout(() => finish(new RoutingBrokerTransportLoss()), absoluteMs);
      const abort = () => finish(refused());
      signal?.addEventListener('abort', abort, { once: true });
      socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new RoutingBrokerTransportLoss()));
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
      socket.once('error', () => finish(new RoutingBrokerTransportLoss()));
      socket.once('end', () => finish(new RoutingBrokerTransportLoss()));
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
      let pumpComplete = false;
      let accepted: PutFileArtifactResponse | undefined;
      let length = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error, value?: PutFileArtifactResponse) => {
	if (settled) return;
	settled = true;
	clearTimeout(totalTimer);
	if (error && req.chunks instanceof Readable) req.chunks.destroy();
	socket.destroy();
	if (error) reject(error);
	else resolve(value!);
      };
      const finishAccepted = () => {
	if (pumpComplete && accepted) finish(undefined, accepted);
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
	  pumpComplete = true;
	  finishAccepted();
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
	  accepted = packet.value as PutFileArtifactResponse;
	  finishAccepted(); return;
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
      socket.once('error', () => { if (!accepted) finish(refused()); });
      socket.once('end', () => { if (!accepted) finish(refused()); });
      socket.once('close', () => { if (!accepted) finish(refused()); });
    });
  };
  const download = (req: { workflow: string; run: string; path: string; pointer: FileArtifactPointer }, signal?: AbortSignal) => {
    bound(req);
    const pointer = req.pointer;
    if (!req.path || !pointer || typeof pointer.__file !== 'string' || !pointer.__file
      || !/^[a-f0-9]{64}$/.test(pointer.hash) || !Number.isSafeInteger(pointer.size)
      || pointer.size <= 0 || pointer.size > MAX_FILE || !pointer.contentType)
      return Promise.reject(refused());
    const frame = JSON.stringify({ cap: broker.cap, method: 'download_file', body: {
      path: req.path, pointer,
    } }) + '\n';
    if (Buffer.byteLength(frame) > MAX_DOWNLOAD_HEADER) return Promise.reject(refused());
    return new Promise<{ size: number; contentType: string; chunks: AsyncIterable<Uint8Array>;
      verified: Promise<void> }>((resolve, reject) => {
      const socket = createConnection(broker.socketPath);
      const output = new PassThrough({ highWaterMark: 64 * 1024 });
      output.on('error', () => {});
      let verifyResolve!: () => void;
      let verifyReject!: (error: Error) => void;
      const verified = new Promise<void>((done, fail) => { verifyResolve = done; verifyReject = fail; });
      void verified.catch(() => {});
      const hash = createHash('sha256');
      let header = Buffer.alloc(0);
      let started = false;
      let completed = false;
      let received = 0;
      const timer = setTimeout(() => fail(refused()), UPLOAD_ABSOLUTE_MS);
      timer.unref();
      const onAbort = () => fail(refused());
      const fail = (error: Error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
	signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        output.destroy(error);
        verifyReject(error);
        if (!started) reject(error);
      };
      if (signal?.aborted) { fail(refused()); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      output.once('close', () => { if (!completed) fail(refused()); });
      const take = (bytes: Buffer) => {
        if (completed || received + bytes.length > pointer.size) { fail(refused()); return; }
        received += bytes.length;
        hash.update(bytes);
        if (!output.write(bytes)) {
          socket.pause();
          output.once('drain', () => { if (!socket.destroyed) socket.resume(); });
        }
      };
      socket.setTimeout(UPLOAD_IDLE_MS, () => fail(refused()));
      socket.once('connect', () => socket.write(frame));
      socket.on('data', (bytes: Buffer) => {
        if (started) { take(bytes); return; }
        header = Buffer.concat([header, bytes]);
        if (header.length > MAX_DOWNLOAD_HEADER + 64 * 1024) { fail(refused()); return; }
        const newline = header.indexOf(0x0a);
        if (newline < 0) return;
        if (newline > MAX_DOWNLOAD_HEADER) { fail(refused()); return; }
        let packet: unknown;
        try { packet = JSON.parse(header.subarray(0, newline).toString('utf8')); }
        catch { fail(refused()); return; }
        if (!packet || typeof packet !== 'object') { fail(refused()); return; }
        const row = packet as Record<string, unknown>;
        if (row.ok === false && typeof row.status === 'number' && row.status >= 400 && row.status <= 599) {
          fail(new HubError(row.status, 'routing request refused')); return;
        }
        if (row.ok !== true || row.size !== pointer.size || row.contentType !== pointer.contentType) {
          fail(refused()); return;
        }
        started = true;
        resolve({ size: pointer.size, contentType: pointer.contentType, chunks: output, verified });
        const tail = header.subarray(newline + 1);
        header = Buffer.alloc(0);
        if (tail.length) take(tail);
      });
      socket.once('end', () => {
        if (!started || received !== pointer.size || hash.digest('hex') !== pointer.hash) {
          fail(refused()); return;
        }
        completed = true;
        clearTimeout(timer);
	signal?.removeEventListener('abort', onAbort);
        output.end();
        verifyResolve();
      });
      socket.once('error', () => fail(refused()));
      socket.once('close', () => { if (!completed) fail(refused()); });
    });
  };
  return {
    getOrder(req) { bound(req); return exchange('get_order', { holder: req.holder }); },
    getLaunchOrder(req) { bound(req); return exchange('get_launch_order', { holder: req.holder }); },
    readRoutingClaim(req) { bound(req); return exchange('read_routing_claim', {}); },
    readRoutedReferenceV2(req) { bound(req); return exchange('read_routed_reference_v2', {}, 5_000); },
    readRoutingClaimV2(req) { bound(req); return exchange('read_routing_claim_v2', {}, 5_000); },
    async readRoutedPairV2(req) {
      bound(req);
      const raw = await exchange<unknown>('read_routed_pair_v2', {}, 5_000);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refused();
      const row = raw as Record<string, unknown>;
      if (Object.keys(row).sort().join(',') !== 'claim,phase,protocol,reference'
	|| row.protocol !== 'routed-prestart-pair-v2' || row.phase !== 'prestart') throw refused();
      try {
	const reference = parseRoutedReferenceV2(row.reference, req);
	const claim = parseRoutedClaimV2(row.claim, req);
	if (reference.state !== 'available' || claim.state !== 'available'
	  || !isDeepStrictEqual(reference.binding, claim.binding)
	  || !isDeepStrictEqual(reference.order.routing, claim.routing)) throw refused();
	return { protocol: 'routed-prestart-pair-v2', phase: 'prestart', reference, claim };
      } catch { throw refused(); }
    },
    readLiveRoutedReferenceV2(req) { bound(req); return exchange('read_live_routed_reference_v2', {}, 5_000); },
    readLiveRoutingClaimV2(req) { bound(req); return exchange('read_live_routing_claim_v2', {}, 5_000); },
    assessLocalModel(req) { bound(req); return exchange('assess_local_model', { candidateIds: req.candidateIds }); },
    reserveLaunch(req) {
      if (req.workflow !== workflow || req.request.orderId !== run
	|| typeof req.request.attemptId !== 'string' || !req.request.attemptId)
	throw new Error('routing order binding refused');
      return exchange('reserve_launch', { request: req.request });
    },
    reportLaunch(req) {
      if (req.workflow !== workflow || req.report.orderId !== run
	|| typeof req.report.attemptId !== 'string' || !req.report.attemptId)
	throw new Error('routing order binding refused');
      return exchange('report_launch', { report: req.report });
    },
    heartbeat(req) { bound(req); return exchange('heartbeat', { holder: req.holder }); },
    async quiesce() {
      const value = await exchange<unknown>('quiesce', {});
      if (!value || typeof value !== 'object' || Array.isArray(value)
				|| Object.keys(value).sort().join(',') !== 'effects,quiescing'
				|| (value as Record<string, unknown>).quiescing !== true
				|| !['settled', 'uncertain'].includes(String((value as Record<string, unknown>).effects)))
				throw refused();
      return value as RoutedQuiesceResult;
    },
    async commandPostrun(req, signal, timeoutMs) {
      const value = await exchange<unknown>('command_postrun', req, timeoutMs, signal);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'claim,outcome'
	|| !['submitted', 'submit-rejected', 'rejected', 'judge-rejected', 'command-failed'].includes(
          String((value as Record<string, unknown>).outcome))
        || !['closed', 'held', 'uncertain'].includes(String((value as Record<string, unknown>).claim)))
        throw refused();
      return value as CommandPostrunResponse;
    },
    async commandPostrunStatus(bodyDigest, signal, timeoutMs) {
      if (!/^[a-f0-9]{64}$/.test(bodyDigest)) throw refused();
      const value = await exchange<unknown>('command_postrun_status', { bodyDigest }, timeoutMs, signal);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw refused();
      const status = value as Record<string, unknown>;
      if ((status.state === 'pending' || status.state === 'unavailable')
	&& Object.keys(status).join(',') === 'state') return value as CommandPostrunStatus;
      if (status.state === 'committed' && Object.keys(status).sort().join(',') === 'result,state') {
	const result = status.result;
	if (result && typeof result === 'object' && !Array.isArray(result)
	  && Object.keys(result).sort().join(',') === 'claim,outcome'
	  && ['submitted', 'submit-rejected', 'rejected', 'judge-rejected', 'command-failed'].includes(
	    String((result as Record<string, unknown>).outcome))
	  && ['closed', 'held', 'uncertain'].includes(String((result as Record<string, unknown>).claim)))
	  return value as CommandPostrunStatus;
      }
      throw refused();
    },
    async commandFinish(req) {
      const value = await exchange<unknown>('command_finish', req);
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).join(',') !== 'state'
        || !['released', 'already-closed', 'uncertain'].includes(
          String((value as Record<string, unknown>).state))) throw refused();
      return value as { state: 'released' | 'already-closed' | 'uncertain' };
    },
    async agentOutcome(req, signal) {
      const value = await exchange<unknown>('agent_outcome', req, undefined, signal);
      if (!value || typeof value !== 'object' || Array.isArray(value)
	|| Object.keys(value).join(',') !== 'claim'
	|| !['closed', 'held', 'uncertain'].includes(String((value as Record<string, unknown>).claim)))
	throw refused();
      return value as { claim: 'closed' | 'held' | 'uncertain' };
    },
    async agentFinish(req, signal) {
      const value = await exchange<unknown>('agent_finish', req, undefined, signal);
      if (!value || typeof value !== 'object' || Array.isArray(value)
	|| Object.keys(value).join(',') !== 'state'
	|| !['released', 'already-closed', 'uncertain'].includes(
	  String((value as Record<string, unknown>).state))) throw refused();
      return value as { state: 'released' | 'already-closed' | 'uncertain' };
    },
    submit(req) {
      bound(req);
      return exchange('submit', { path: req.path, value: req.value, holder: req.holder,
	...(req.done === undefined ? {} : { done: req.done }),
	...(req.proof === undefined ? {} : { proof: req.proof }) });
    },
    collectionTarget(req) {
      bound(req);
      return exchange('collection_target', { path: req.path, holder: req.holder });
    },
    emitCollectionMember(req) {
      bound(req);
      return exchange('emit_member', { sealPath: req.sealPath, emissionId: req.emissionId,
	value: req.value, done: req.done, holder: req.holder });
    },
    sealCollection(req) {
      bound(req);
      return exchange('seal_collection', { sealPath: req.sealPath, sealId: req.sealId,
	holder: req.holder });
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
      if (!Number.isSafeInteger(req.parentArtifactVersion) || req.parentArtifactVersion < 1)
	throw new Error('routing invocation version refused');
      return exchange('read_invocation_binding', { parentWorkflow: req.parentWorkflow,
	parentDefRef: req.parentDefRef, callPath: req.callPath,
	parentArtifactVersion: req.parentArtifactVersion });
    },
    putFileArtifact(req) {
      if (!(req.bytes instanceof Uint8Array)) return Promise.reject(refused());
      return upload({ workflow: req.workflow, size: req.bytes.byteLength,
	chunks: Readable.from([req.bytes]), contentType: req.contentType,
	...(req.filename === undefined ? {} : { filename: req.filename }) });
    },
    putFileArtifactStream: upload,
    getFileArtifactStream: download,
  };
}
