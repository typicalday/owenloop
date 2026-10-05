/**
 * Local boundary for opt-in hosted MCP discovery. The MCP preflight is only a
 * bounded navigation hint. This module fetches the full packet independently
 * through a configured bearer-authenticated HTTPS HubClient, then checks the
 * locally installed publication and signed consumed values before returning
 * any model-facing content. It trusts that service and HTTPS connection; it
 * does not claim a cryptographic order or lease attestation. An epoch clock
 * validates signed chain dates; a monotonic clock bounds fetch and local
 * verification elapsed time. The projected epoch expiry is capped by the
 * monotonic time remaining at return. Later use must recheck the claim and
 * expiry; this projection does not continuously monitor clock or lease state.
 */
import { bindProduce, elementPath, matchConsume, sealPath } from '../../../../src/paths.ts';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import { substituteOrderVars } from '../../../../src/order-resolver.ts';
import { join } from 'node:path';
import { createBundleIngestor } from '../../../../src/store/index.ts';
import { globalStoreRoot } from '../../../../src/store/resolve.ts';
import { createExecutionDefinitionVerifier, createExecutionOriginVerifier } from '../../../../src/store/pre-commit-verifier.ts';
import type { ProducePattern, StepDef } from '../../../../src/types.ts';
import { createHubClient, type HubClientOptions } from '../hub/client.ts';
import type { OrderPacket } from '../hub/types.ts';
import { createConsumedVerifier, type CreateConsumedVerifierArgs } from '../consumed-verifier.ts';
import { createStoreInstructionResolver, type StoreInstructionResolverOptions } from '../exec/instructions.ts';

const PROTOCOL = 'client-preflight-v1';
const MAX_REFS = 64;
const MAX_OBSERVATION_MS = 5_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const ORDER_FIELDS = new Set([
  'run', 'workflow', 'step', 'key', 'index', 'defDigest', 'inputs', 'outputs',
  'workdir', 'capabilities', 'crews', 'modifier', 'reroutedFrom', 'escalated',
  'model', 'worker', 'judge', 'spec', 'x', 'consumes', 'consumedFingerprint',
  'consumesProof', 'consumesProofRelay', 'owes', 'cause',
]);
const OWED_FIELDS = new Set([
  'path', 'version', 'judgmentRejects', 'schemaRejects', 'reasons',
  'previousValue', 'schema', 'schemaAppliesTo', 'proof',
]);

type Ref = { workflow: string; run: string; defDigest: string };
type RefResult = { kind: 'ref'; ref: Ref } | { kind: 'unavailable' };

export interface HostedOrderProjection {
  protocol: 'local-hosted-order-v1';
  state: 'ready';
  /** Service reports an active claim, not holder identity. The expiry is capped
   * by the monotonic time remaining when this result is returned. */
  serviceObservation: { workflow: string; run: string; step: string; packetDigest: string; observedAt: number; expiresAt: number };
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
  consumes: Array<{ path: string; value: unknown; trust: 'signed-value-and-local-chain-at-service-observed-version' }>;
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
}

export interface DefaultHostedOrderAdapterOptions {
  hub: HubClientOptions;
  expected: { workflowId: string; runId: string };
  cwd: string;
  env: Record<string, string | undefined>;
  now: () => number;
  observationMs?: number;
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

function concreteOutput(produce: ProducePattern, order: OrderPacket): string | undefined {
  if (produce.kind === 'singleton') return produce.stem;
  if (produce.kind === 'collection') return sealPath(produce.stem);
  if (!Number.isSafeInteger(order.index) || order.index! < 0) return undefined;
  return bindProduce(produce, order.index!);
}

function outputFor(step: StepDef, order: OrderPacket, path: string): ProducePattern | undefined {
  const mode = step.consumes.some((pattern) => pattern.mode === 'map') ? 'map'
    : step.consumes.some((pattern) => pattern.mode === 'reduce') ? 'reduce' : 'plain';
  return step.produces.find((produce) =>
    (mode === 'plain' ? produce.kind !== 'map' : produce.kind === (mode === 'map' ? 'map' : 'singleton'))
    && concreteOutput(produce, order) === path);
}

function validConsumedPaths(step: StepDef, order: OrderPacket): boolean {
  if (!Array.isArray(order.inputs) || order.inputs.some((path) => typeof path !== 'string')) return false;
  const expected = new Set(order.inputs);
  const delivered = Object.keys(order.consumes);
  if (expected.size !== order.inputs.length || expected.size !== delivered.length
    || delivered.some((path) => !expected.has(path))) return false;
  const map = step.consumes.find((pattern) => pattern.mode === 'map');
  if (map) {
    if (!Number.isSafeInteger(order.index) || order.index! < 0
      || order.key !== elementPath(map.stem, order.index!)
      || !expected.has(elementPath(map.stem, order.index!, map.suffix))) return false;
  } else if (order.key !== '' || order.index !== undefined) return false;
  if (step.consumes.some((pattern) =>
    (pattern.mode === 'plain' && !expected.has(pattern.stem))
    || (pattern.mode === 'reduce' && !expected.has(sealPath(pattern.stem))))) return false;
  if (order.cause === undefined) {
    if (!(step.on ?? ['inputsGreen']).includes('inputsGreen')) return false;
  } else if ((order.cause !== 'allGreen' && order.cause !== 'idle')
    || !step.on?.includes(order.cause) || expected.size !== 0) return false;
  return delivered.every((path) => step.consumes.some((pattern) => {
    if (pattern.mode === 'reduce' && path === sealPath(pattern.stem)) return true;
    const matched = matchConsume(pattern, path);
    return matched !== null && (pattern.mode !== 'map' || matched.index === order.index);
  }));
}

function refused(code: string): HostedOrderResult {
  return { protocol: 'local-hosted-order-v1', state: 'refused', code };
}

/** Equality check between the holder's private packet and the direct verified fetch. */
export function hostedPacketDigest(packet: unknown): string | undefined {
  try {
    return valueDigestHex(packet);
  } catch {
    return undefined;
  }
}

/**
 * Create one adapter for one locally configured service. The supplied origin
 * must be HTTPS and origin-only. Tests may inject `fetchImpl`; there is no
 * runtime HTTP downgrade or MCP-selected origin.
 */
export function createHostedOrderAdapter(options: HostedOrderAdapterOptions): {
  open(preflight: unknown, index?: number): Promise<HostedOrderResult>;
} {
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
    async open(preflight: unknown, index = 0): Promise<HostedOrderResult> {
      const navigation = preflightRef(preflight, index);
      if (navigation.kind !== 'ref') return { protocol: 'local-hosted-order-v1', state: 'unavailable' };
      const { ref } = navigation;
      if (ref.workflow !== expectedWorkflowId || ref.run !== expectedRunId) {
	return refused('reference-out-of-scope');
      }
      // The fetched packet can describe an earlier claim. Start the freshness
      // window before authentication, transport, and response parsing, not after
      // they return, so a delayed response cannot receive a new full window.
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
      let response: Awaited<ReturnType<typeof hub.getOrder>>;
      try {
	response = await hub.getOrder({ workflow: expectedWorkflowId, run: expectedRunId });
      } catch {
	return refused('direct-fetch-failed');
      }
      // A stale direct fetch should not enter the local verification path.
      let fetchedAt: number;
      let fetchedElapsed: number;
      try {
	fetchedAt = options.now();
	fetchedElapsed = monotonicNow() - startedAt;
      } catch {
	return refused('clock-unavailable');
      }
      if (!Number.isFinite(fetchedElapsed) || fetchedElapsed < 0) return refused('clock-unavailable');
      if (!Number.isSafeInteger(fetchedAt) || fetchedAt < observedAt || fetchedAt >= expiresAt) {
	return refused('claim-observation-expired');
      }
      if (fetchedElapsed >= duration) return refused('claim-observation-expired');
      if (!record(response)) return refused('direct-response-malformed');
      if (response.workflow !== expectedWorkflowId || response.run !== expectedRunId) return refused('reference-rebound');
      const order = response.order;
      if (order === null) return { protocol: 'local-hosted-order-v1', state: 'unavailable' };
      if (!record(order) || !record(response.lease)
	|| order.workflow !== expectedWorkflowId || order.run !== expectedRunId
	|| typeof order.defDigest !== 'string' || order.defDigest.toLowerCase() !== ref.defDigest) return refused('reference-rebound');
      if (response.lease.claimed !== true || response.lease.outcome !== undefined) return refused('claim-not-current');
      if (!identifier(order.step) || typeof order.key !== 'string' || order.key.length > 200 || !record(order.consumes)
	|| !Array.isArray(order.owes)) return refused('order-malformed');
      if (Object.keys(order).some((field) => !ORDER_FIELDS.has(field))
	|| order.owes.some((owed) => !record(owed) || Object.keys(owed).some((field) => !OWED_FIELDS.has(field)))) {
	return refused('unsupported-order-field');
      }
      // These fields have no supported local reason/prior-value verifier. A
      // partial projection would hide actionable feedback from the worker.
      if (order.owes.some((owed) => !record(owed) || !Array.isArray(owed.reasons)
	|| owed.reasons.length !== 0 || owed.proof !== undefined
	|| owed.judgmentRejects !== 0 || owed.schemaRejects !== 0
	|| Object.hasOwn(owed, 'previousValue'))) return refused('unsupported-feedback');
      if (order.workdir !== undefined) {
	return refused('unsupported-order-field');
      }
      if (Object.keys(order.consumes).length === 0
	&& (order.consumesProof !== undefined || order.consumesProofRelay !== undefined)) {
	return refused('unsupported-order-field');
      }
      if (order.worker !== undefined && order.worker !== 'agent') {
	return refused('unsupported-worker');
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
      if (!staticResult.ok) return refused(`definition-${staticResult.kind}`);
      const step = staticResult.step;
      if ((step.executor !== undefined && step.executor !== 'agent') || step.workdir !== undefined
	|| step.workdirFrom !== undefined || step.calls !== undefined || step.callsInterface !== undefined
	|| step.judges !== undefined) return refused('unsupported-step');
      if (!validConsumedPaths(step, order)) return refused('consume-path-mismatch');
      if (!Array.isArray(order.outputs) || order.outputs.length === 0 || order.outputs.length !== order.owes.length
	|| order.outputs.some((path) => typeof path !== 'string')
	|| new Set(order.outputs).size !== order.outputs.length
	|| new Set(order.owes.map((owed) => owed.path)).size !== order.owes.length
	|| order.owes.some((owed) => !order.outputs.includes(owed.path))) {
	return refused('output-path-mismatch');
      }
      const outputs: HostedOrderProjection['outputs'] = [];
      for (const owed of order.owes) {
	if (typeof owed.path !== 'string' || owed.path.length > 200 || !Number.isSafeInteger(owed.version) || owed.version! < 1) {
	  return refused('output-malformed');
	}
	const produce = outputFor(step, order, owed.path);
	if (produce === undefined) return refused('output-path-mismatch');
	const schemaAppliesTo = produce.kind === 'collection' ? 'member' : 'value';
	outputs.push({
	  path: owed.path,
	  version: owed.version!,
	  versionTrust: 'trusted-service-observation',
	  ...(produce.schema === undefined ? {} : { schema: produce.schema, schemaAppliesTo }),
	});
      }
      let checked: Awaited<ReturnType<typeof consumedVerifier>>;
      try {
	checked = await consumedVerifier(order, {
	  hardRule: true,
	  callsProducers: staticResult.callsProducers,
	});
      } catch {
	return refused('consume-verifier-failed');
      }
      if (!checked.ok) return refused('consume-proof-refused');
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
      // Verification and materialization share the original fetch-start window.
      // A projection is never returned ready after that window has elapsed.
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
      // A wall-clock rollback can leave the original epoch expiry much later
      // than the monotonic window. Cap metadata to its remaining elapsed TTL.
      const remainingExpiry = Math.floor(finishedAt + duration - finishedElapsed);
      if (!Number.isSafeInteger(remainingExpiry) || remainingExpiry <= finishedAt) return refused('claim-observation-expired');
      const packetDigest = hostedPacketDigest(order);
      if (packetDigest === undefined) return refused('order-malformed');
      return {
	protocol: 'local-hosted-order-v1',
	state: 'ready',
	serviceObservation: { workflow: order.workflow, run: order.run, step: order.step, packetDigest, observedAt, expiresAt: Math.min(expiresAt, remainingExpiry) },
	definition: { bodyTrust: 'verified-local-publication', substitutions: 'trusted-service-observation', digest: order.defDigest, prompt },
	...(step.spec === undefined && step.x === undefined ? {} : {
	  staticExtensions: {
	    trust: 'verified-local-definition' as const,
	    ...(step.spec === undefined ? {} : { spec: step.spec }),
	    ...(step.x === undefined ? {} : { x: step.x }),
	  },
	}),
	consumes: Object.entries(order.consumes).map(([path, value]) => ({ path, value, trust: 'signed-value-and-local-chain-at-service-observed-version' })),
	outputs,
      };
    },
  };
}

/** Production wiring: local store, publication/origin evidence, and org root. */
export function createDefaultHostedOrderAdapter(options: DefaultHostedOrderAdapterOptions): ReturnType<typeof createHostedOrderAdapter> {
  const home = [options.env.HOME, options.env.USERPROFILE].find((value) => value !== undefined && value.trim() !== '');
  if (home === undefined) throw new Error('cannot locate the global workflow store: set HOME or USERPROFILE');
  return createHostedOrderAdapter({
    hub: options.hub,
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
