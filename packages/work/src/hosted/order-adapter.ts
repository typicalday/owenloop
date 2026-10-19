/**
 * Local boundary for opt-in hosted MCP discovery. The MCP preflight is only a
 * bounded navigation hint. This module fetches the full packet independently
 * through a locally selected bearer-authenticated HTTPS reader, then checks the
 * locally installed publication and signed consumed values before returning
 * any model-facing content. It trusts that service and HTTPS connection; it
 * does not claim a cryptographic order or lease attestation.
 */
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import { substituteOrderVars } from '../../../../src/order-resolver.ts';
import { join } from 'node:path';
import { createBundleIngestor } from '../../../../src/store/index.ts';
import { globalStoreRoot } from '../../../../src/store/resolve.ts';
import { createExecutionDefinitionVerifier, createExecutionOriginVerifier } from '../../../../src/store/pre-commit-verifier.ts';
import { createHubClient, type HubClientOptions } from '../hub/client.ts';
import type { ConditionalSubmitRequest, ConditionalSubmitResponse, OrderPacket } from '../hub/types.ts';
import { createConsumedVerifier, type CreateConsumedVerifierArgs } from '../consumed-verifier.ts';
import { createStoreInstructionResolver, type StoreInstructionResolverOptions } from '../exec/instructions.ts';
import { outputFor, validConsumedPaths } from '../order-definition-binding.ts';
import { bindTrustedReferenceV2 } from './trusted-input-binding.ts';
import { createTrustedReferenceV2Reader, parseTrustedReferenceV2, type TrustedReferenceV2, type TrustedReferenceV2Reader } from './trusted-reference-v2.ts';

const PROTOCOL = 'client-preflight-v1';
const REFERENCE_PROTOCOL = 'trusted-reference-read-v1';
const MAX_REFS = 64;
const MAX_OBSERVATION_MS = 5_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const ORDER_FIELDS = new Set([
  'run', 'workflow', 'step', 'key', 'index', 'defDigest', 'inputs', 'outputs',
  'consumes', 'consumedFingerprint', 'consumesProof', 'consumesProofRelay', 'owes',
]);
const OWED_FIELDS = new Set(['path', 'version', 'proof']);
const RESPONSE_FIELDS = new Set(['protocol', 'state', 'workflow', 'run', 'order', 'lease']);
const LEASE_FIELDS = new Set(['claimed', 'claimedAt', 'heartbeatAt']);

type Ref = { workflow: string; run: string; defDigest: string };
type RefResult = { kind: 'ref'; ref: Ref } | { kind: 'unavailable' };

export interface HostedOrderProjection {
  protocol: 'local-hosted-order-v1';
  state: 'ready';
  /** Service reports an active claim for this run; this does not attest the holder identity. */
  serviceObservation: { workflow: string; run: string; step: string; packetDigest: string; observedAt: number; expiresAt: number;
    referenceProtocol?: 'trusted-reference-read-v2'; inputWitnessDigest?: string };
  definition: {
    bodyTrust: 'verified-local-publication';
    substitutions: 'trusted-service-observation';
    digest: string;
    prompt: string;
  };
  staticExtensions?: {
    trust: 'verified-local-definition';
    spec?: Record<string, unknown>;
    x?: Record<string, unknown>;
  };
  consumes: Array<{ path: string; value: unknown; trust: 'signed-value-and-local-chain-at-service-observed-version' | 'trusted-service-claim-version' }>;
  inputWitnesses?: Array<{ path: string; version: number; present: boolean; trust: 'trusted-service-claim-version' }>;
  outputs: Array<{
    path: string;
    version: number;
    versionTrust: 'trusted-service-observation';
    schema?: unknown;
    schemaAppliesTo?: 'value' | 'member';
  }>;
}

export type HostedOrderResult =
  | HostedOrderProjection
  | { protocol: 'local-hosted-order-v1'; state: 'unavailable' }
  | { protocol: 'local-hosted-order-v1'; state: 'refused'; code: string };

/** Private only: never serialize this beside the model-facing projection. */
export interface HostedVerifiedPacket {
  order: OrderPacket;
  collectionOutputs: string[];
  /** Local declaration, never copied from the remote input witness list. */
  declaredInputPaths?: string[];
}

export interface HostedOrderAdapterOptions {
  /** Configured by the local client, never copied from MCP content. */
  hub: HubClientOptions;
  /** Born-bound locally; the MCP preflight may only name this exact order. */
  expected: { workflowId: string; runId: string };
  /** The adapter forces publication and origin policy to enforce. */
  instructionSource: Omit<StoreInstructionResolverOptions, 'defPolicy' | 'originPolicy' | 'consumedVerifier'>;
  /** The adapter forces artifact policy to enforce and uses its own clock. */
  consumeTrust: Omit<CreateConsumedVerifierArgs, 'artifactPolicy' | 'now'>;
  /** Epoch milliseconds for signed chain checks and projected service metadata. */
  now: () => number;
  /** Elapsed-time clock; defaults to the process monotonic clock. */
  monotonicNow?: () => number;
  /** At most five seconds; consumers must re-fetch after expiry. */
  observationMs?: number;
  /** Locally selected v2 transport. Production uses the independent HTTPS reader. */
  referenceV2?: TrustedReferenceV2Reader;
}

export interface DefaultHostedOrderAdapterOptions {
  hub: HubClientOptions;
  expected: { workflowId: string; runId: string };
  cwd: string;
  env: Record<string, string | undefined>;
  now: () => number;
  observationMs?: number;
  /** Explicit local migration; the held CLI selects v2, with no read fallback. */
  referenceV2?: true;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && IDENTIFIER.test(value);
}

function readRef(value: unknown): RefResult {
  const raw = record(value);
  if (raw?.state !== 'available' || !identifier(raw.workflow) || !identifier(raw.run)
    || typeof raw.defDigest !== 'string' || !DIGEST.test(raw.defDigest)) return { kind: 'unavailable' };
  return { kind: 'ref', ref: { workflow: raw.workflow, run: raw.run, defDigest: raw.defDigest.toLowerCase() } };
}

function preflightRef(value: unknown, index: number): RefResult {
  const raw = record(value);
  // The protocol marker is checked before looking at a reference. The rest of
  // this object remains untrusted and none of its text is ever copied out.
  if (raw?.protocol !== PROTOCOL || raw.verification !== 'not-performed') return { kind: 'unavailable' };
  if (raw.order !== undefined) return readRef(raw.order);
  if (raw.state !== 'orders-available' || !Array.isArray(raw.orders)
    || raw.orders.length > MAX_REFS || !Number.isInteger(index) || index < 0) return { kind: 'unavailable' };
  return readRef(raw.orders[index]);
}

function refused(code: string): HostedOrderResult {
  return { protocol: 'local-hosted-order-v1', state: 'refused', code };
}

/** Bound the caller even when a credential reader, transport or verifier
 * ignores cancellation. Late completions must check the signal before any
 * further work or exposure. Each read owns its timer and cancellation. */
async function withReadDeadline(
  duration: number,
  read: (signal: AbortSignal) => Promise<HostedOrderResult>,
): Promise<HostedOrderResult> {
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<HostedOrderResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(refused('claim-observation-expired'));
      deadline.abort();
    }, duration);
  });
  try {
    return await Promise.race([read(deadline.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Equality check between the holder's private packet and the direct verified fetch. */
export function hostedPacketDigest(packet: unknown): string | undefined {
  try {
    return valueDigestHex(packet);
  } catch {
    return undefined;
  }
}

/** Canonical input for the Service v1 comparison, whether sourced from the
 * private raw hold or the versioned REST order. It includes only dynamic
 * identity/consume/proof/owed-version fields that Service v1 actually sends.
 * The wrapper separately hashes the ENTIRE raw hold before and after every
 * awaited verification, so hidden local fields remain a change fence. */
function referencePacketDigest(packet: unknown, includeTargetVersions: boolean): string | undefined {
  const order = record(packet);
  if (!order || typeof order.workflow !== 'string' || typeof order.run !== 'string'
    || typeof order.step !== 'string' || typeof order.key !== 'string'
    || typeof order.defDigest !== 'string' || !Array.isArray(order.inputs)
    || !Array.isArray(order.outputs) || !record(order.consumes)
    || !record(order.consumedFingerprint) || !Array.isArray(order.owes)) return undefined;
  const owes = order.owes.map((entry: unknown) => {
    const owed = record(entry);
    if (!owed || typeof owed.path !== 'string' || !Number.isSafeInteger(owed.version) || (owed.version as number) < 1) return undefined;
    return { path: owed.path, ...(includeTargetVersions ? { version: owed.version } : {}),
      ...(owed.proof === undefined ? {} : { proof: owed.proof }) };
  });
  if (owes.includes(undefined)) return undefined;
  return hostedPacketDigest({
    workflow: order.workflow, run: order.run, step: order.step, key: order.key,
    ...(order.index === undefined ? {} : { index: order.index }),
    defDigest: order.defDigest.toLowerCase(), inputs: order.inputs, outputs: order.outputs,
    consumes: order.consumes, consumedFingerprint: order.consumedFingerprint,
    ...(order.consumesProof === undefined ? {} : { consumesProof: order.consumesProof }),
    ...(order.consumesProofRelay === undefined ? {} : { consumesProofRelay: order.consumesProofRelay }),
    owes,
  });
}

/** Exact Service v1 dynamic packet digest, including owed target versions. */
export function hostedReferencePacketDigest(packet: unknown): string | undefined {
  return referencePacketDigest(packet, true);
}

/** Service v1 claim identity and dynamic data that cannot change under a
 * held claim. Only owed target versions are excluded: conditional submissions
 * can advance those versions without changing the local claim-time packet. */
export function hostedReferenceStableDigest(packet: unknown): string | undefined {
  return referencePacketDigest(packet, false);
}

/** v2 adds claim-facing fields and independently witnessed declared inputs.
 * Human provideProof for a declared input is advisory, never producer proof. */
export function hostedReferenceV2Digest(packet: OrderPacket, declaredInputPaths: readonly string[], stable = false): string | undefined {
  try {
    const declared = new Set(declaredInputPaths);
    const rawProofs: unknown = packet.consumesProof === undefined ? {} : JSON.parse(packet.consumesProof);
    const proofMap = record(rawProofs);
    if (!proofMap) return undefined;
    const proofs = Object.fromEntries(Object.entries(proofMap).filter(([path]) => !declared.has(path)));
    const relay = packet.consumesProofRelay;
    if (relay !== undefined && !record(relay)) return undefined;
    const normalized = { ...packet,
      consumesProof: JSON.stringify(Object.fromEntries(Object.keys(proofs).sort().map(path => [path, proofs[path]]))),
      consumesProofRelay: Object.fromEntries(Object.entries(relay ?? {}).filter(([path]) => !declared.has(path))),
    };
    const dynamic = referencePacketDigest(normalized, !stable);
    if (dynamic === undefined) return undefined;
    const fields = ['workdir', 'cause', 'capabilities', 'crews', 'reroutedFrom', 'modifier', 'escalated',
      'model', 'worker', 'judge', 'spec', 'x'] as const;
    return hostedPacketDigest({ dynamic, offer: Object.fromEntries(fields.filter(field => Object.hasOwn(packet, field))
      .map(field => [field, (packet as unknown as Record<string, unknown>)[field]])) });
  } catch { return undefined; }
}

/**
 * Create one adapter for one locally configured service. The supplied origin
 * must be HTTPS and origin-only. Tests may inject `fetchImpl`; there is no
 * runtime HTTP downgrade or MCP-selected origin.
 */
export function createHostedOrderAdapter(options: HostedOrderAdapterOptions): {
  readonly referenceProtocol?: 'trusted-reference-read-v2';
  open(preflight: unknown, index?: number, onVerified?: (packet: HostedVerifiedPacket) => void): Promise<HostedOrderResult>;
  submitConditional(req: ConditionalSubmitRequest): Promise<ConditionalSubmitResponse>;
} {
  const referenceV2 = options.referenceV2;
  const url = new URL(options.hub.origin);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('hosted order adapter requires a configured HTTPS service origin');
  }
  if (!identifier(options.expected.workflowId) || !identifier(options.expected.runId)) {
    throw new Error('hosted order adapter requires a bounded local workflow/run binding');
  }
  const expectedWorkflowId = options.expected.workflowId;
  const expectedRunId = options.expected.runId;
  const duration = options.observationMs ?? MAX_OBSERVATION_MS;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_OBSERVATION_MS) {
    throw new Error('hosted order observation window must be 1..5000 ms');
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  // Fetch must not follow a redirect to another origin or a downgraded HTTP
  // endpoint while carrying the local bearer token. This overrides any
  // caller-provided fetch's default redirect behavior at the adapter boundary.
  const fetchImpl = options.hub.fetchImpl ?? globalThis.fetch;
  const hub = createHubClient({
    ...options.hub,
    fetchImpl: (input, init) => fetchImpl(input, { ...init, redirect: 'error' }),
  });
  const instructions = createStoreInstructionResolver({
    ...options.instructionSource,
    defPolicy: 'enforce', originPolicy: 'enforce',
  });
  const consumedVerifier = createConsumedVerifier({
    ...options.consumeTrust,
    now: options.now,
    artifactPolicy: 'enforce',
  });

  return {
    ...(referenceV2 === undefined ? {} : { referenceProtocol: 'trusted-reference-read-v2' as const }),
    submitConditional(req) {
      if (hub.submitConditional === undefined) throw new Error('conditional submit transport is unavailable');
      return hub.submitConditional(req);
    },
    async open(preflight: unknown, index = 0, onVerified?: (packet: HostedVerifiedPacket) => void): Promise<HostedOrderResult> {
      const navigation = preflightRef(preflight, index);
      if (navigation.kind !== 'ref') return { protocol: 'local-hosted-order-v1', state: 'unavailable' };
      const { ref } = navigation;
      if (ref.workflow !== expectedWorkflowId || ref.run !== expectedRunId) {
	return refused('reference-out-of-scope');
      }
      // Start the freshness window before authentication and transport.
      let observedAt: number;
      let startedAt: number;
      try {
	startedAt = monotonicNow();
	observedAt = options.now();
      } catch {
	return refused('clock-unavailable');
      }
      if (!Number.isFinite(startedAt) || !Number.isSafeInteger(observedAt) || observedAt < 0) return refused('clock-unavailable');
      const expiresAt = observedAt + duration;
      if (!Number.isSafeInteger(expiresAt)) return refused('clock-unavailable');
      return withReadDeadline(duration, async (signal) => {
	let response: unknown;
	try {
	  if (referenceV2) response = await referenceV2.read();
	  else {
	    if (hub.getReferenceOrder === undefined) return refused('reference-read-unavailable');
	    response = await hub.getReferenceOrder({ workflow: expectedWorkflowId, run: expectedRunId }, signal);
	  }
	} catch {
	  return refused('reference-read-unavailable');
	}
	if (signal.aborted) return refused('claim-observation-expired');
	let fetchedAt: number;
	let fetchedElapsed: number;
	try {
	  fetchedAt = options.now();
	  fetchedElapsed = monotonicNow() - startedAt;
	} catch {
	  return refused('clock-unavailable');
	}
	if (!Number.isFinite(fetchedElapsed) || fetchedElapsed < 0) return refused('clock-unavailable');
	if (!Number.isSafeInteger(fetchedAt) || fetchedAt < observedAt || fetchedAt >= expiresAt
	  || fetchedElapsed >= duration) return refused('claim-observation-expired');
	let v2: TrustedReferenceV2 | undefined;
	if (referenceV2) {
	  try {
	    const parsed = parseTrustedReferenceV2(response, { workflow: expectedWorkflowId, run: expectedRunId });
	    if (parsed.state !== 'available') return refused(`service-${parsed.state}`);
	    v2 = parsed;
	  } catch { return refused('reference-v2-malformed'); }
	}
	const envelope = record(response);
	if (!envelope) return refused('direct-response-malformed');
	if (envelope.protocol !== (referenceV2 ? 'trusted-reference-read-v2' : REFERENCE_PROTOCOL)) return refused('reference-protocol-unavailable');
	if (envelope.workflow !== expectedWorkflowId || envelope.run !== expectedRunId) return refused('reference-rebound');
	if (envelope.state !== 'available') {
	  if (envelope.state === 'unavailable' || envelope.state === 'unsupported-feedback' || envelope.state === 'routing-unsupported') {
	    return refused(`service-${envelope.state}`);
	  }
	  return refused('reference-state-malformed');
	}
	if (!v2 && Object.keys(envelope).some((field) => !RESPONSE_FIELDS.has(field))) return refused('direct-response-malformed');
	const order = envelope.order as OrderPacket;
	const lease = record(envelope.lease);
	if (!record(order) || !lease
	  || order.workflow !== expectedWorkflowId || order.run !== expectedRunId
	  || typeof order.defDigest !== 'string' || order.defDigest.toLowerCase() !== ref.defDigest) return refused('reference-rebound');
	if (lease.claimed !== true || lease.outcome !== undefined) return refused('claim-not-current');
	if (Object.keys(lease).some((field) => !LEASE_FIELDS.has(field))) return refused('direct-response-malformed');
	if ((lease.claimedAt !== undefined && (!Number.isSafeInteger(lease.claimedAt) || (lease.claimedAt as number) < 0))
	  || (lease.heartbeatAt !== undefined && (!Number.isSafeInteger(lease.heartbeatAt) || (lease.heartbeatAt as number) < 0))) {
	  return refused('direct-response-malformed');
	}
	if (!identifier(order.step) || typeof order.key !== 'string' || order.key.length > 200 || !record(order.consumes)
	  || !Array.isArray(order.owes)) return refused('order-malformed');
	if (!v2 && (Object.keys(order).some((field) => !ORDER_FIELDS.has(field))
	  || order.owes.some((owed) => !record(owed) || Object.keys(owed).some((field) => !OWED_FIELDS.has(field))))) {
	  return refused('unsupported-order-field');
	}
	if (order.owes.some((owed) => owed.proof !== undefined)) return refused('unsupported-feedback');
	// Service v1 withholds authored feedback/previous values, modifier and
	// cause. Reject all unrecognized fields and unsupported local shapes.
	if (!v2 && Object.keys(order.consumes).length === 0
	  && (order.consumesProof !== undefined || order.consumesProofRelay !== undefined)) {
	  return refused('unsupported-order-field');
	}
	if (instructions.resolveHostedStep === undefined) {
	  return refused('unsupported-worker');
	}
	let staticResult: Awaited<ReturnType<NonNullable<typeof instructions.resolveHostedStep>>>;
	try {
	  staticResult = await instructions.resolveHostedStep(order);
	} catch {
	  return refused('definition-verifier-failed');
	}
	if (signal.aborted) return refused('claim-observation-expired');
	if (!staticResult.ok) return refused(`definition-${staticResult.kind}`);
	const step = staticResult.step;
	if ((step.executor !== undefined && step.executor !== 'agent') || (!v2 && (step.workdir !== undefined
	  || step.workdirFrom !== undefined)) || step.calls !== undefined || step.callsInterface !== undefined
	  || step.judges !== undefined) return refused('unsupported-step');
	// Service v1 has no dynamic modifier/cause fields. A local definition
	// that needs either value cannot be materialized from this protocol.
	if (!v2 && ((step.on !== undefined && (step.on.length !== 1 || step.on[0] !== 'inputsGreen'))
	  || step.body.includes('${MODIFIER}'))) return refused('unsupported-service-v1-shape');
	if (v2 && order.modifier !== undefined && !staticResult.allowedModifiers?.includes(order.modifier)) return refused('modifier-not-declared');
	if (!v2 && !validConsumedPaths(step, order)) return refused('consume-path-mismatch');
	if (!Array.isArray(order.outputs) || order.outputs.length === 0 || order.outputs.length !== order.owes.length
	  || order.outputs.some((path) => typeof path !== 'string')
	  || new Set(order.outputs).size !== order.outputs.length
	  || new Set(order.owes.map((owed) => owed.path)).size !== order.owes.length
	  || order.owes.some((owed) => !order.outputs.includes(owed.path))) {
	  return refused('output-path-mismatch');
	}
	const outputs: HostedOrderProjection['outputs'] = [];
	const collectionOutputs: string[] = [];
	for (const owed of order.owes) {
	  if (typeof owed.path !== 'string' || owed.path.length > 200 || !Number.isSafeInteger(owed.version) || owed.version! < 1) {
	    return refused('output-malformed');
	  }
	  const produce = outputFor(step, order, owed.path);
	  if (produce === undefined) return refused('output-path-mismatch');
	  if (produce.kind === 'collection') collectionOutputs.push(owed.path);
	  const schemaAppliesTo = produce.kind === 'collection' ? 'member' : 'value';
	  outputs.push({
	    path: owed.path,
	    version: owed.version!,
	    versionTrust: 'trusted-service-observation',
	    ...(produce.schema === undefined ? {} : { schema: produce.schema, schemaAppliesTo }),
	  });
	}
	const declared = new Set(staticResult.declaredInputs.map(input => input.name));
	let verifiedOrder = order;
	let inputWitnessDigest: string | undefined;
	if (v2) {
	  const bound = await bindTrustedReferenceV2({ response: v2,
	    expected: { workflow: expectedWorkflowId, run: expectedRunId, defDigest: ref.defDigest, step: order.step, key: order.key },
	    step, declaredInputs: staticResult.declaredInputs, consumedVerifier, callsProducers: staticResult.callsProducers });
	  if (signal.aborted) return refused('claim-observation-expired');
	  if (!bound.ok) return refused(`reference-v2-${bound.reason}`);
	  verifiedOrder = bound.order;
	  inputWitnessDigest = bound.witnessDigest;
	} else {
	  let checked: Awaited<ReturnType<typeof consumedVerifier>>;
	  try {
	    // The v1 marker asserts no rework thread. Legacy verifier code expects
	    // empty counters/reasons, so supply that private neutral shape only here.
	    checked = await consumedVerifier({ ...order, owes: order.owes.map((owed) => ({ ...owed,
	      reasons: [], judgmentRejects: 0, schemaRejects: 0 })) }, {
	      hardRule: true,
	      callsProducers: staticResult.callsProducers,
	    });
	  } catch {
	    return refused('consume-verifier-failed');
	  }
	  if (signal.aborted) return refused('claim-observation-expired');
	  if (!checked.ok) return refused('consume-proof-refused');
	}
	let prompt: string;
	try {
	  prompt = substituteOrderVars(step.body, {
	    workflow: order.workflow,
	    run: order.run,
	    key: order.key,
	    ...(order.index === undefined ? {} : { index: order.index }),
	    ...(order.modifier === undefined ? {} : { modifier: order.modifier }),
	  }, { step: step.name, maxAttempts: step.maxAttempts });
	} catch {
	  return refused('definition-materialization-failed');
	}
	// Verification and materialization share the fetch-start window.
	let finishedAt: number;
	let finishedElapsed: number;
	try {
	  finishedAt = options.now();
	  finishedElapsed = monotonicNow() - startedAt;
	} catch {
	  return refused('clock-unavailable');
	}
	if (!Number.isFinite(finishedElapsed) || finishedElapsed < fetchedElapsed) return refused('clock-unavailable');
	if (!Number.isSafeInteger(finishedAt) || finishedAt < observedAt || finishedAt >= expiresAt) {
	  return refused('claim-observation-expired');
	}
	if (finishedElapsed >= duration) return refused('claim-observation-expired');
	const remainingExpiry = Math.floor(finishedAt + duration - finishedElapsed);
	if (!Number.isSafeInteger(remainingExpiry) || remainingExpiry <= finishedAt) return refused('claim-observation-expired');
	const packetDigest = v2 ? hostedReferenceV2Digest(verifiedOrder, [...declared]) : hostedReferencePacketDigest(order);
	if (packetDigest === undefined) return refused('order-malformed');
	onVerified?.({ order: verifiedOrder, collectionOutputs, ...(v2 ? { declaredInputPaths: [...declared] } : {}) });
	return {
	  protocol: 'local-hosted-order-v1',
	  state: 'ready',
	  serviceObservation: { workflow: order.workflow, run: order.run, step: order.step, packetDigest, observedAt, expiresAt: Math.min(expiresAt, remainingExpiry),
	    ...(v2 ? { referenceProtocol: 'trusted-reference-read-v2' as const, inputWitnessDigest } : {}) },
	  definition: { bodyTrust: 'verified-local-publication', substitutions: 'trusted-service-observation', digest: order.defDigest, prompt },
	  ...(step.spec === undefined && step.x === undefined ? {} : {
	    staticExtensions: {
	      trust: 'verified-local-definition' as const,
	      ...(step.spec === undefined ? {} : { spec: step.spec }),
	      ...(step.x === undefined ? {} : { x: step.x }),
	    },
	  }),
	  consumes: Object.entries(order.consumes).map(([path, value]) => ({ path, value,
	    trust: v2 && declared.has(path) ? 'trusted-service-claim-version' : 'signed-value-and-local-chain-at-service-observed-version' })),
	  ...(v2 ? { inputWitnesses: v2.inputs.filter(input => declared.has(input.path)).map(({ path, version, present }) => ({ path, version, present,
	    trust: 'trusted-service-claim-version' as const })) } : {}),
	  outputs,
	};
      });
    },
  };
}

/** Local store, publication/origin evidence, and org root. The held CLI opts
 * into the independent v2 reader explicitly; existing v1 API users retain
 * their prior contract. A selected v2 adapter never falls back on failure. */
export function createDefaultHostedOrderAdapter(options: DefaultHostedOrderAdapterOptions): ReturnType<typeof createHostedOrderAdapter> {
  const home = [options.env.HOME, options.env.USERPROFILE].find((value) => value !== undefined && value.trim() !== '');
  if (home === undefined) throw new Error('cannot locate the global workflow store: set HOME or USERPROFILE');
  return createHostedOrderAdapter({
    hub: options.hub,
    ...(options.referenceV2 ? { referenceV2: createTrustedReferenceV2Reader({ origin: options.hub.origin, getToken: options.hub.getToken,
      expected: { workflow: options.expected.workflowId, run: options.expected.runId } }) } : {}),
    expected: options.expected,
    instructionSource: {
      projectRoot: join(options.cwd, 'workflows'),
      globalRoot: globalStoreRoot(home),
      verifier: createBundleIngestor(),
      definitionVerifier: createExecutionDefinitionVerifier({ env: options.env }),
      originVerifier: createExecutionOriginVerifier({ env: options.env }),
      env: options.env,
    },
    consumeTrust: { env: options.env },
    now: options.now,
    ...(options.observationMs === undefined ? {} : { observationMs: options.observationMs }),
  });
}
