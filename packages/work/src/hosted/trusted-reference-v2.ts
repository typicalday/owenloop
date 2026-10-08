/**
 * Worker-owned, claim-bound Service v2 read. This module never uses HubClient,
 * its replaceable fetchImpl, or MCP content to select an origin or credential.
 */
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingHttpHeaders } from 'node:http';

import type { OrderPacket } from '../hub/types.ts';

const PROTOCOL = 'trusted-reference-read-v2';
const MAX_WIRE_BYTES = 2_000_000;
const MAX_PATHS = 64;
const MAX_DEPTH = 64;
const MAX_NODES = 50_000;
const MAX_MS = 5_000;
const ORDER_FIELDS = new Set(['workflow', 'run', 'step', 'key', 'index', 'defDigest', 'inputs', 'outputs',
  'consumes', 'consumedFingerprint', 'consumesProof', 'consumesProofRelay', 'owes', 'workdir', 'cause']);
const ENVELOPE_FIELDS = new Set(['protocol', 'state', 'workflow', 'run', 'order', 'inputs', 'workdirInput', 'lease']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DIGEST = /^[a-f0-9]{64}$/i;

export interface TrustedInputWitness {
  path: string;
  version: number;
  present: boolean;
  value?: unknown;
}

export interface TrustedReferenceV2 {
  protocol: typeof PROTOCOL;
  state: 'available';
  workflow: string;
  run: string;
  order: OrderPacket;
  inputs: TrustedInputWitness[];
  workdirInput?: { stem: string; version: number; value: unknown };
  lease: { claimed: true };
}

export type TrustedReferenceV2Result = TrustedReferenceV2 | {
  protocol: typeof PROTOCOL;
  state: 'unavailable' | 'unsupported-feedback' | 'routing-unsupported';
  workflow: string;
  run: string;
};

export interface TrustedReferenceV2Reader {
  read(): Promise<TrustedReferenceV2Result>;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const ident = (value: unknown): value is string => typeof value === 'string' && value.length <= 160 && IDENTIFIER.test(value);
const pathName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const exact = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every(key => allowed.has(key));

function bounded(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > MAX_NODES || next.depth > MAX_DEPTH) return false;
    if (next.value !== null && typeof next.value === 'object') {
      for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
    }
  }
  try { return Buffer.byteLength(JSON.stringify(value)) <= MAX_WIRE_BYTES; }
  catch { return false; }
}

/** Parse the entire bounded v2 wire envelope; never coerce a v1 response. */
export function parseTrustedReferenceV2(raw: unknown, expected: { workflow: string; run: string }): TrustedReferenceV2Result {
  if (!bounded(raw)) throw new Error('trusted reference v2 response exceeds bounds');
  const wire = rec(raw);
  if (!wire || wire.protocol !== PROTOCOL || wire.workflow !== expected.workflow || wire.run !== expected.run
    || !exact(wire, ENVELOPE_FIELDS)) throw new Error('trusted reference v2 envelope mismatch');
  if (wire.state !== 'available') {
    if (wire.state !== 'unavailable' && wire.state !== 'unsupported-feedback' && wire.state !== 'routing-unsupported'
      || Object.keys(wire).length !== 4) throw new Error('trusted reference v2 refusal malformed');
    return wire as TrustedReferenceV2Result;
  }
  const order = rec(wire.order);
  const lease = rec(wire.lease);
  const fingerprint = rec(order?.consumedFingerprint);
  const consumes = rec(order?.consumes);
  if (!order || !exact(order, ORDER_FIELDS) || !lease || Object.keys(lease).length !== 1 || lease.claimed !== true
    || order.workflow !== expected.workflow || order.run !== expected.run || !ident(order.step)
    || typeof order.key !== 'string' || order.key.length > 200 || typeof order.defDigest !== 'string'
    || !DIGEST.test(order.defDigest) || !Array.isArray(order.inputs) || order.inputs.length > MAX_PATHS
    || !Array.isArray(order.outputs) || order.outputs.length > MAX_PATHS || !Array.isArray(order.owes)
    || !consumes || !fingerprint
    || order.inputs.some(path => !pathName(path)) || new Set(order.inputs).size !== order.inputs.length
    || Object.keys(fingerprint).length !== order.inputs.length
    || (order.consumesProof !== undefined && typeof order.consumesProof !== 'string')
    || (order.consumesProofRelay !== undefined && !rec(order.consumesProofRelay))
    || order.owes.some(owed => !rec(owed) || !exact(owed, new Set(['path', 'version']))
      || !pathName(owed.path) || !positive(owed.version))) throw new Error('trusted reference v2 order malformed');
  if (!Array.isArray(wire.inputs) || wire.inputs.length !== order.inputs.length) {
    throw new Error('trusted reference v2 witness set mismatch');
  }
  const seen = new Set<string>();
  for (const entry of wire.inputs) {
    const witness = rec(entry);
    if (!witness || !exact(witness, new Set(['path', 'version', 'present', 'value'])) || !pathName(witness.path)
      || !order.inputs.includes(witness.path) || seen.has(witness.path) || !positive(witness.version)
      || fingerprint[witness.path] !== witness.version || typeof witness.present !== 'boolean'
      || Object.hasOwn(witness, 'value') !== witness.present) throw new Error('trusted reference v2 witness malformed');
    seen.add(witness.path);
  }
  if (wire.workdirInput !== undefined) {
    const source = rec(wire.workdirInput);
    if (!source || !exact(source, new Set(['stem', 'version', 'value'])) || !pathName(source.stem)
      || !positive(source.version) || !Object.hasOwn(source, 'value')) {
      throw new Error('trusted reference v2 workdir witness malformed');
    }
  }
  return wire as unknown as TrustedReferenceV2;
}

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: string }

function postHttps(url: URL, token: string, body: string, remainingMs: number, ca?: string | Buffer): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: RawResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const req: ClientRequest = httpsRequest(url, { method: 'POST', ...(ca === undefined ? {} : { ca }), headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json',
      'content-length': Buffer.byteLength(body), 'cache-control': 'no-store',
    } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
	size += chunk.length;
	if (size > MAX_WIRE_BYTES) { req.destroy(new Error('trusted reference v2 response too large')); return; }
	chunks.push(chunk);
      });
      response.once('error', error => finish(error));
      response.once('end', () => finish(undefined, { status: response.statusCode ?? 0,
	headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', error => finish(error));
    const timer = setTimeout(() => req.destroy(new Error('trusted reference v2 deadline exceeded')), remainingMs);
    req.end(body);
  });
}

/** Production construction accepts no fetch override; the bearer stays here. */
export function createTrustedReferenceV2Reader(options: {
  origin: string;
  getToken: () => Promise<string>;
  expected: { workflow: string; run: string };
  now?: () => number;
  /** Optional locally provisioned TLS trust root; never sourced from a Hub response. */
  trustedCa?: string | Buffer;
}): TrustedReferenceV2Reader {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
    || origin.search || origin.hash || !ident(options.expected.workflow) || !ident(options.expected.run)) {
    throw new Error('trusted reference v2 requires a bound HTTPS origin and workflow/run');
  }
  const url = new URL('/api/reference_order/v2', origin);
  const now = options.now ?? Date.now;
  return { async read() {
    const began = now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const token = await Promise.race([
      options.getToken(),
      new Promise<never>((_resolve, reject) => {
	timeout = setTimeout(() => reject(new Error('trusted reference v2 credential deadline exceeded')), MAX_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
    const remaining = MAX_MS - (now() - began);
    if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token) || remaining <= 0) {
      throw new Error('trusted reference v2 credential or deadline unavailable');
    }
    const response = await postHttps(url, token, JSON.stringify(options.expected), remaining, options.trustedCa);
    if (now() - began >= MAX_MS || response.status !== 200
      || !String(response.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')
      || !String(response.headers['cache-control'] ?? '').toLowerCase().split(',').map(part => part.trim()).includes('no-store')) {
      throw new Error('trusted reference v2 transport refused');
    }
    return parseTrustedReferenceV2(JSON.parse(response.body) as unknown, options.expected);
  } };
}
