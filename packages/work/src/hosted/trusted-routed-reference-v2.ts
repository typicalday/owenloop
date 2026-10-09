/** Prestart-only routed input witness. Shift owns the HTTPS bearer and original
 * routing session; a role receives only exact bound results through its broker. */
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isDeepStrictEqual } from 'node:util';

import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import { HubError } from '../hub/types.ts';
import type { RoutingChildClient } from '../hub/routing-child-client.ts';
import type { OrderPacket, ReferenceRouting } from '../hub/types.ts';
import { parseTrustedReferenceV2, type TrustedInputWitness } from './trusted-reference-v2.ts';

const MAX_WIRE_BYTES = 2_000_000;
const MAX_PAIR_WIRE_BYTES = 4_100_000;
const MAX_CONCRETE_BINDING_WIRE_BYTES = 30_000_000;
const MAX_MS = 5_000;
const ROUTES = new Set(['/api/routing_reference_order/v2', '/api/read_routing_claim/v2',
  '/api/routing_reference_order/live/v2', '/api/read_routing_claim/live/v2',
  '/api/read_routing_input_pair/v2', '/api/read_routing_input_pair/live/v2',
  '/api/read_invocation_binding', '/api/read_invocation_binding/live/v2',
  '/api/read_concrete_call_structure', '/api/read_concrete_call_structure/live/v2',
  '/api/read_concrete_call_binding', '/api/read_concrete_call_binding/live/v2']);
const DIGEST = /^[a-f0-9]{64}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const BINDING_KEYS = ['rootWorkflow', 'frameWorkflow', 'run', 'claimId', 'decisionId', 'sessionId',
  'shiftId', 'orderDigest', 'authorityRevision', 'rosterRevision', 'routingDigest', 'preferenceExpiresAt'];
const REFERENCE_KEYS = ['protocol', 'state', 'workflow', 'run', 'order', 'inputs', 'workdirInput', 'lease', 'binding'];
const CLAIM_KEYS = ['protocol', 'state', 'workflow', 'run', 'binding', 'routing'];
const ORDER_KEYS = ['workflow', 'run', 'step', 'key', 'index', 'defDigest', 'inputs', 'outputs',
  'consumes', 'consumedFingerprint', 'consumesProof', 'consumesProofRelay', 'owes', 'workdir', 'cause',
  'capabilities', 'crews', 'reroutedFrom', 'modifier', 'escalated', 'model', 'worker', 'judge', 'spec', 'x', 'routing'];
const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && ID.test(value);
const pathName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const digest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value);

export interface RoutedReferenceBindingV2 {
  rootWorkflow: string; frameWorkflow: string; run: string; claimId: string; decisionId: string;
  sessionId: string; shiftId: string; orderDigest: string; authorityRevision: string;
  rosterRevision: string; routingDigest: string; preferenceExpiresAt: number;
}
export type RoutedReferenceV2 = {
  protocol: 'trusted-routed-reference-read-v2'; state: 'available'; workflow: string; run: string;
  order: OrderPacket; inputs: TrustedInputWitness[];
  workdirInput?: { stem: string; version: number; value: unknown };
  lease: { claimed: true }; binding: RoutedReferenceBindingV2;
} | {
  protocol: 'trusted-routed-reference-read-v2'; state: 'unavailable' | 'unsupported-feedback';
  workflow: string; run: string;
};
export type RoutedClaimV2 = {
  protocol: 'routing-claim-read-v2'; state: 'available'; workflow: string; run: string;
  routing: ReferenceRouting; binding: RoutedReferenceBindingV2;
} | {
  protocol: 'routing-claim-read-v2'; state: 'unavailable'; workflow: string; run: string;
};
export type RoutedPrestartPairV2 = { protocol: 'routed-prestart-pair-v2'; phase: 'prestart';
  reference: RoutedReferenceV2; claim: RoutedClaimV2 };
export type RoutedServicePrestartPairV2 = { reference: Extract<RoutedReferenceV2, { state: 'available' }>;
  claim: Extract<RoutedClaimV2, { state: 'available' }> };
export interface RoutedReferenceV2Reader {
  readReference(): Promise<RoutedReferenceV2>;
  readClaim(): Promise<RoutedClaimV2>;
  read(): Promise<{ reference: RoutedReferenceV2; claim: RoutedClaimV2 }>;
}

function bounded(value: unknown, maxBytes = MAX_WIRE_BYTES): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 50_000 || next.depth > 64) return false;
    if (next.value && typeof next.value === 'object') {
      for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
    }
  }
  try { return Buffer.byteLength(JSON.stringify(value)) <= maxBytes; }
  catch { return false; }
}

/** A skipped claim asserts only that no second native read was attempted. */
export function parseRoutedServicePrestartPairV2(raw: unknown,
  expected: { workflow: string; run: string }): RoutedServicePrestartPairV2 {
  if (!bounded(raw, MAX_PAIR_WIRE_BYTES)) throw new Error('routed input pair exceeds bounds');
  const wire = rec(raw);
  if (!wire || wire.protocol !== 'routed-prestart-input-pair-v2' || wire.phase !== 'prestart'
    || Object.keys(wire).length !== 4 || !exact(wire, ['protocol', 'phase', 'reference', 'claim']))
    throw new Error('routed input pair envelope refused');
  const reference = parseRoutedReferenceV2(wire.reference, expected);
  if (reference.state !== 'available') {
    const skipped = rec(wire.claim);
    if (!skipped || Object.keys(skipped).length !== 1 || skipped.state !== 'skipped')
      throw new Error('routed input pair skip refused');
    throw new Error('routed input reference unavailable');
  }
  const claim = parseRoutedClaimV2(wire.claim, expected);
  if (claim.state !== 'available' || !isDeepStrictEqual(reference.binding, claim.binding)
    || !isDeepStrictEqual(reference.order.routing, claim.routing))
    throw new Error('routed input pair changed');
  return { reference, claim };
}

function parseBinding(raw: unknown, expected: { workflow: string; run: string }, routing: unknown): RoutedReferenceBindingV2 {
  const binding = rec(raw);
  const sidecar = rec(routing);
  const claim = rec(sidecar?.claim);
  const decision = rec(sidecar?.decision);
  const preference = rec(sidecar?.preference);
  if (!binding || !sidecar || !claim || !decision || !preference
    || !exact(binding, BINDING_KEYS) || Object.keys(binding).length !== BINDING_KEYS.length
    || binding.rootWorkflow !== expected.workflow || binding.run !== expected.run
    || !id(binding.frameWorkflow) || !id(binding.claimId) || !id(binding.decisionId)
    || !id(binding.sessionId) || !id(binding.shiftId)
    || !digest(binding.orderDigest) || !digest(binding.authorityRevision)
    || !digest(binding.rosterRevision) || !digest(binding.routingDigest)
    || !positive(binding.preferenceExpiresAt)
    || binding.claimId !== claim.claimId || binding.decisionId !== decision.decisionId
    || binding.sessionId !== claim.sessionId || binding.shiftId !== claim.shiftId
    || binding.rosterRevision !== preference.rosterRevision
    || binding.preferenceExpiresAt !== preference.expiresAt
    || binding.routingDigest !== valueDigestHex(sidecar)) throw new Error('routed v2 binding mismatch');
  return binding as unknown as RoutedReferenceBindingV2;
}

export function parseRoutedReferenceV2(raw: unknown, expected: { workflow: string; run: string }): RoutedReferenceV2 {
  if (!bounded(raw)) throw new Error('routed v2 response exceeds bounds');
  const wire = rec(raw);
  if (!wire || wire.protocol !== 'trusted-routed-reference-read-v2'
    || wire.workflow !== expected.workflow || wire.run !== expected.run || !exact(wire, REFERENCE_KEYS))
    throw new Error('routed v2 envelope mismatch');
  if (wire.state !== 'available') {
    if ((wire.state !== 'unavailable' && wire.state !== 'unsupported-feedback')
      || Object.keys(wire).length !== 4) throw new Error('routed v2 refusal malformed');
    return wire as RoutedReferenceV2;
  }
  const order = rec(wire.order), lease = rec(wire.lease), consumes = rec(order?.consumes);
  const fingerprint = rec(order?.consumedFingerprint);
  if (!order || !exact(order, ORDER_KEYS) || !id(order.workflow) || order.run !== expected.run
    || !id(order.step) || typeof order.key !== 'string' || order.key.length > 200
    || !digest(order.defDigest) || !Array.isArray(order.inputs) || order.inputs.length > 64
    || !Array.isArray(order.outputs) || order.outputs.length > 64 || !Array.isArray(order.owes)
    || !consumes || !fingerprint || !rec(order.routing)
    || order.inputs.some(path => !pathName(path)) || new Set(order.inputs).size !== order.inputs.length
    || Object.keys(fingerprint).length !== order.inputs.length
    || !lease || Object.keys(lease).length !== 1 || lease.claimed !== true
    || !Array.isArray(wire.inputs) || wire.inputs.length !== order.inputs.length) {
    throw new Error('routed v2 order malformed');
  }
  const binding = parseBinding(wire.binding, expected, order.routing);
  if (binding.frameWorkflow !== order.workflow) throw new Error('routed v2 frame mismatch');
  const { routing: _routing, ...ordinaryOrder } = order;
  const { binding: _binding, ...ordinaryWire } = wire;
  parseTrustedReferenceV2({ ...ordinaryWire, protocol: 'trusted-reference-read-v2',
    workflow: order.workflow, order: ordinaryOrder }, { workflow: order.workflow, run: expected.run });
  const seen = new Set<string>();
  for (const item of wire.inputs) {
    const input = rec(item);
    if (!input || !exact(input, ['path', 'version', 'present', 'value']) || !pathName(input.path)
      || !order.inputs.includes(input.path) || seen.has(input.path) || !positive(input.version)
      || fingerprint[input.path] !== input.version || typeof input.present !== 'boolean'
      || Object.hasOwn(input, 'value') !== input.present) throw new Error('routed v2 witness malformed');
    seen.add(input.path);
  }
  if (wire.workdirInput !== undefined) {
    const input = rec(wire.workdirInput);
    if (!input || !exact(input, ['stem', 'version', 'value']) || !pathName(input.stem)
      || !positive(input.version) || !Object.hasOwn(input, 'value')) throw new Error('routed v2 workdir malformed');
  }
  return wire as unknown as RoutedReferenceV2;
}

export function parseRoutedClaimV2(raw: unknown, expected: { workflow: string; run: string }): RoutedClaimV2 {
  if (!bounded(raw)) throw new Error('routed claim v2 exceeds bounds');
  const wire = rec(raw);
  if (!wire || wire.protocol !== 'routing-claim-read-v2' || wire.workflow !== expected.workflow
    || wire.run !== expected.run || !exact(wire, CLAIM_KEYS)) throw new Error('routed claim v2 envelope mismatch');
  if (wire.state !== 'available') {
    if (wire.state !== 'unavailable' || Object.keys(wire).length !== 4)
      throw new Error('routed claim v2 refusal malformed');
    return wire as RoutedClaimV2;
  }
  if (Object.keys(wire).length !== CLAIM_KEYS.length) throw new Error('routed claim v2 incomplete');
  parseBinding(wire.binding, expected, wire.routing);
  return wire as unknown as RoutedClaimV2;
}

function postHttps(url: URL, token: string, session: string, body: string, remainingMs: number,
  ca?: string | Buffer, onHeaders?: (status: number, headers: IncomingHttpHeaders) => void,
  maxBytes = MAX_WIRE_BYTES,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: { status: number; headers: IncomingHttpHeaders; body: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const req = httpsRequest(url, { method: 'POST', ...(ca === undefined ? {} : { ca }), headers: {
      authorization: `Bearer ${token}`, 'x-owenloop-routing-session': session,
      'content-type': 'application/json', accept: 'application/json',
      'content-length': Buffer.byteLength(body), 'cache-control': 'no-store',
    } }, response => {
      try { onHeaders?.(response.statusCode ?? 0, response.headers); }
      catch (error) { req.destroy(error instanceof Error ? error : new Error('routed v2 response refused')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
	size += chunk.length;
	if (size > maxBytes) { req.destroy(new Error('routed v2 response too large')); return; }
	chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('end', () => finish(undefined, { status: response.statusCode ?? 0,
	headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', error => finish(error));
    const timer = setTimeout(() => req.destroy(new Error('routed v2 deadline exceeded')), remainingMs);
    req.end(body);
  });
}

/** Production callers have no fetch override. The original session credential
 * remains in Shift and never enters a child request body or broker result. */
export interface RoutedV2TransportOptions {
  origin: string; getToken: () => Promise<string>; getSession: () => Promise<string>;
  expected: { workflow: string; run: string }; trustedCa?: string | Buffer;
  now?: () => number;
  beforeRequest?: () => void;
  onRateLimit?: (error: HubError) => void;
}

/** Shared original-session transport for separate prestart and recorded reads. */
export function createRoutedV2Requester(options: RoutedV2TransportOptions): {
  now: () => number; request: (path: string, started: number, body?: unknown) => Promise<unknown>;
} {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin || !id(options.expected.workflow)
    || !id(options.expected.run)) throw new Error('routed v2 requires exact HTTPS origin and bound order');
  const now = options.now ?? (() => performance.now());
  const request = async (path: string, started: number, body: unknown = options.expected): Promise<unknown> => {
    if (!ROUTES.has(path)) throw new Error('routed v2 route refused');
    const remaining = () => MAX_MS - (now() - started);
    let credentialTimer: ReturnType<typeof setTimeout> | undefined;
    const credential = await Promise.race([Promise.all([options.getToken(), options.getSession()]),
      new Promise<never>((_resolve, reject) => {
	credentialTimer = setTimeout(() => reject(new Error('routed v2 credential deadline')), MAX_MS);
      })]).finally(() => clearTimeout(credentialTimer));
    const [token, session] = credential;
    if (!token || /[\r\n]/.test(token) || !/^rs1\.rs_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(session))
      throw new Error('routed v2 credential unavailable');
    if (remaining() <= 0) throw new Error('routed v2 deadline exceeded');
    options.beforeRequest?.();
    const retryAfter = (headers: IncomingHttpHeaders) => {
      const raw = headers['retry-after'];
      const seconds = typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
      return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined;
    };
    const response = await postHttps(new URL(path, origin), token, session,
      JSON.stringify(body), remaining(), options.trustedCa,
      (status, headers) => {
	if (status === 429) options.onRateLimit?.(new HubError(429,
	  'routed v2 request refused', undefined, retryAfter(headers)));
      }, path.startsWith('/api/read_routing_input_pair/') ? MAX_PAIR_WIRE_BYTES
	: path === '/api/read_concrete_call_binding'
	  || path === '/api/read_concrete_call_binding/live/v2'
	  ? MAX_CONCRETE_BINDING_WIRE_BYTES : MAX_WIRE_BYTES);
    if (response.status === 429) {
      throw new HubError(429, 'routed v2 request refused', undefined, retryAfter(response.headers));
    }
    if (remaining() <= 0 || response.status !== 200
      || !String(response.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')
      || !String(response.headers['cache-control'] ?? '').toLowerCase().split(',').map(part => part.trim()).includes('no-store'))
      throw new Error('routed v2 transport refused');
    return JSON.parse(response.body) as unknown;
  };
  return { now, request };
}

/** Parent-only one-HTTP observation. It never falls back to the old two routes. */
export function createTrustedRoutedInputPairV2Reader(options: RoutedV2TransportOptions): {
  read(): Promise<RoutedServicePrestartPairV2>;
} {
  const { now, request } = createRoutedV2Requester(options);
  return { read: async () => parseRoutedServicePrestartPairV2(
    await request('/api/read_routing_input_pair/v2', now()), options.expected) };
}

export function createTrustedRoutedReferenceV2Reader(options: RoutedV2TransportOptions): RoutedReferenceV2Reader {
  const { now, request } = createRoutedV2Requester(options);
  const readReference = async (started = now()) => parseRoutedReferenceV2(
    await request('/api/routing_reference_order/v2', started), options.expected);
  const readClaim = async (started = now()) => parseRoutedClaimV2(
    await request('/api/read_routing_claim/v2', started), options.expected);
  return { readReference, readClaim, async read() {
    const started = now();
    const reference = await readReference(started);
    if (reference.state !== 'available') return { reference,
      claim: { protocol: 'routing-claim-read-v2', state: 'unavailable', ...options.expected } as RoutedClaimV2 };
    return { reference, claim: await readClaim(started) };
  } };
}

/** Child-side adapter to one parent observation of the two fixed Service reads.
 * It has no origin, bearer, session credential, or generic Hub method. */
export function createBrokerRoutedReferenceV2Reader(client: Pick<RoutingChildClient,
  'readRoutedPairV2'>, expected: { workflow: string; run: string },
now = () => performance.now()): Pick<RoutedReferenceV2Reader, 'read'> {
  return { async read() {
    const started = now();
    const pair = await client.readRoutedPairV2(expected);
    if (now() - started >= MAX_MS) throw new Error('routed v2 broker observation expired');
    if (!pair || pair.protocol !== 'routed-prestart-pair-v2' || pair.phase !== 'prestart'
      || Object.keys(pair).sort().join(',') !== 'claim,phase,protocol,reference')
      throw new Error('routed v2 broker pair refused');
    const reference = parseRoutedReferenceV2(pair.reference, expected);
    const claim = parseRoutedClaimV2(pair.claim, expected);
    if (reference.state !== 'available' || claim.state !== 'available'
      || !isDeepStrictEqual(reference.binding, claim.binding)
      || !isDeepStrictEqual(reference.order.routing, claim.routing))
      throw new Error('routed v2 broker pair refused');
    return { reference, claim };
  } };
}
