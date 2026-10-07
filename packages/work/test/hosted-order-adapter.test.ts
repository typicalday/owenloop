import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { dsseSignSubmission, DSSE_SSH_NAMESPACE } from '../../../src/crypto/dsse.ts';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { createSshSigner } from '../../../src/crypto/ssh.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { createBundleIngestor, createStoreInstructionSource } from '../../../src/store/index.ts';
import { installBundleFixture, installSignedBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';
import { createDefaultHostedOrderAdapter, createHostedOrderAdapter, hostedReferencePacketDigest } from '../src/hosted/order-adapter.ts';

const CALLS_CHILD = `name: hosted-child
inputs:
  - name: data
    seedOwed: true
steps:
  - name: change
    consumes: [data]
    produces: [result]
    terminal: true
    body: "Change the data."
outputs: [result]
`;
const CALLS_PARENT = `name: hosted-calls
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: unit
    calls: hosted-child
    inputs:
      data: seed
    produces: [unit-result]
  - name: inspect
    consumes: [unit-result]
    produces: [out]
    terminal: true
    body: "Inspect the result."
outputs: [out]
`;

const VALUE = { request: 'signed value' };
const WORKFLOW = `name: hosted-adapter
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: make
    consumes: [seed]
    produces: [out]
    terminal: true
    body: "Use the verified seed for \${WORKFLOW}."
    spec:
      harness: local-approved
    x:
      policy: local-only
`;
const REDUCE_WORKFLOW = `name: hosted-reduce
inputs:
  - name: policy
    seedOwed: true
steps:
  - name: collect
    produces: ['items[]']
    body: "Collect items."
  - name: summarize
    consumes: ['items[*]', policy]
    produces: [summary]
    terminal: true
    body: "Summarize the signed items."
`;
const MAP_WORKFLOW = `name: hosted-map
steps:
  - name: collect
    produces: ['items[]']
    body: "Collect items."
  - name: annotate
    consumes: ['items[$i]']
    produces: ['items[$i].note']
    body: "Annotate the bound item."
`;

async function proof(value: unknown, keyPath: string, keyId: string, artifact = 'seed', version = 2): Promise<string> {
  const payload = {
    run: 'producer-run', workflow: 'wf-hosted', defDigest: 'producer-definition',
    step: 'produce-seed', key: '',
    produced: [{ artifact, version, valueDigest: valueDigestHex(value) }],
    consumedFingerprint: {}, producerKeyId: keyId, timestamp: 10,
  };
  const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: keyPath });
  try {
    const signed = await dsseSignSubmission(Buffer.from(JSON.stringify(payload), 'utf8'), signer);
    return JSON.stringify(signed.envelope);
  } finally {
    signer.dispose();
  }
}

async function fixture(workflow = WORKFLOW) {
  const installed = await installBundleFixture({
    root: tempDir('owenloop-hosted-adapter-project-'),
    sourceDir: writeBundleSource({ name: 'hosted-adapter', workflow }),
  });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition);
  const home = mkdtempSync(join(tmpdir(), 'owenloop-hosted-adapter-home-'));
  const keyPath = join(home, 'producer');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'hosted-adapter-test', '-f', keyPath], { stdio: 'ignore' });
  const rootKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  mkdirSync(join(home, '.owenloop'));
  writeFileSync(join(home, '.owenloop', 'org-root.pub'), rootKey.openSshPublicKey);
  return { defDigest: defInstructionDigest(definition), projectRoot: installed.root, env: { HOME: home }, keyPath, rootKeyId: rootKey.keyid };
}

async function packet(defDigest: string, keyPath: string, keyId: string): Promise<OrderPacket> {
  return {
    workflow: 'wf-hosted', run: 'run-hosted', step: 'make', key: '', defDigest,
    inputs: ['seed'], outputs: ['out'], consumes: { seed: VALUE },
    consumedFingerprint: { seed: 2 }, consumesProof: JSON.stringify({ seed: await proof(VALUE, keyPath, keyId) }),
    owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
}

function preflight(defDigest: string, extras: Record<string, unknown> = {}): unknown {
  return {
    protocol: 'client-preflight-v1', verification: 'not-performed',
    order: { state: 'available', workflow: 'wf-hosted', run: 'run-hosted', defDigest, ...extras },
    text: 'HOSTILE PREVIEW INSTRUCTION', structuredContent: { exploit: 'HOSTILE STRUCTURED INSTRUCTION' },
  };
}

async function harness(overrides: {
  response?: (p: OrderPacket, fetchCount: number) => GetOrderResponse | null | Promise<GetOrderResponse | null>;
  wireResponse?: (p: OrderPacket, fetchCount: number) => unknown;
  status?: number;
  workflowYaml?: string;
  received?: (body: unknown, init: RequestInit) => void;
  missingPublicationVerifier?: boolean;
  throwPublicationVerifier?: boolean;
  throwFetch?: boolean;
  redirectResponse?: boolean;
  expected?: { workflowId: string; runId: string };
  now?: () => number;
  monotonicNow?: () => number;
} = {}) {
  const f = await fixture(overrides.workflowYaml);
  const p = await packet(f.defDigest, f.keyPath, f.rootKeyId);
  let fetches = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    fetches++;
    if (overrides.throwFetch) throw new Error('HOSTILE RAW FETCH ERROR');
    overrides.received?.(JSON.parse(String(init?.body)), init ?? {});
    assert.equal(String(input), 'https://trusted.example/api/reference_order/v1');
    if (overrides.redirectResponse) {
      if (init?.redirect === 'error') throw new TypeError('redirect blocked');
      return new Response(JSON.stringify({ text: 'HOSTILE REDIRECT TARGET' }), { status: 200 });
    }
    const raw = overrides.response === undefined ? {
      text: 'HOSTILE RAW REST TEXT', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true },
    } : await overrides.response(p, fetches);
    const response = overrides.wireResponse === undefined ? serviceWire(raw) : overrides.wireResponse(p, fetches);
    return new Response(JSON.stringify(response), { status: overrides.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  const adapter = createHostedOrderAdapter({
    hub: { origin: 'https://trusted.example', getToken: async () => 'local-secret', fetchImpl },
    expected: overrides.expected ?? { workflowId: 'wf-hosted', runId: 'run-hosted' },
    instructionSource: {
      projectRoot: f.projectRoot, globalRoot: tempDir('owenloop-hosted-adapter-global-'),
      verifier: createBundleIngestor(), env: f.env,
      ...(overrides.missingPublicationVerifier ? {} : {
	definitionVerifier: () => {
	  if (overrides.throwPublicationVerifier) throw new Error('HOSTILE RAW VERIFIER ERROR');
	  return { kind: 'verified' as const, publisherKeyId: f.rootKeyId, principal: 'publisher' };
	},
      }),
    },
    consumeTrust: { env: f.env },
    now: overrides.now ?? (() => 1_000),
    monotonicNow: overrides.monotonicNow ?? (() => 0),
  });
  return { adapter, p, f, fetches: () => fetches };
}

/** Test double for the Service v1 allowlist. Negative tests can bypass this
 * helper with wireResponse to inject malformed protocol payloads. */
function serviceWire(raw: GetOrderResponse | null): unknown {
  if (raw === null) return null;
  const { workflow, run, order, lease } = raw;
  const base = { protocol: 'trusted-reference-read-v1', workflow, run };
  if (order === null || !lease.claimed || lease.outcome !== undefined) return { ...base, state: 'unavailable' };
  if (order.owes.some((owed) => owed.reasons.length > 0 || owed.judgmentRejects > 0
    || owed.schemaRejects > 0 || Object.hasOwn(owed, 'previousValue'))) return { ...base, state: 'unsupported-feedback' };
  return { ...base, state: 'available', order: {
    workflow: order.workflow, run: order.run, step: order.step, key: order.key,
    ...(order.index === undefined ? {} : { index: order.index }),
    defDigest: order.defDigest, inputs: order.inputs, outputs: order.outputs,
    consumes: order.consumes, consumedFingerprint: order.consumedFingerprint,
    ...(order.consumesProof === undefined ? {} : { consumesProof: order.consumesProof }),
    ...(order.consumesProofRelay === undefined ? {} : { consumesProofRelay: order.consumesProofRelay }),
    owes: order.owes.map((owed) => ({ path: owed.path, version: owed.version,
      ...(owed.proof === undefined ? {} : { proof: owed.proof }) })),
  }, lease: { claimed: true } };
}

function availableWire(order: OrderPacket): Record<string, unknown> {
  return serviceWire({ text: '', workflow: order.workflow, run: order.run, order, lease: { claimed: true } }) as Record<string, unknown>;
}

test('valid signed consume crosses direct authenticated fetch into a minimized labeled projection', async () => {
  const h = await harness({ received: (body, init) => {
    assert.deepEqual(body, { workflow: 'wf-hosted', run: 'run-hosted' });
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer local-secret');
    assert.equal(init.redirect, 'error');
  } });
  let privatePacket: { order: OrderPacket; collectionOutputs: string[] } | undefined;
  const result = await h.adapter.open(preflight(h.f.defDigest, { prompt: 'HOSTILE RELAY PROMPT' }), 0,
    (packet) => { privatePacket = packet; });
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.deepEqual(privatePacket, { order: (serviceWire({ workflow: h.p.workflow, run: h.p.run,
    order: h.p, lease: { claimed: true }, text: '' }) as { order: OrderPacket }).order, collectionOutputs: [] });
  assert.equal(h.fetches(), 1);
  if (result.state !== 'ready') return;
  assert.equal(result.definition.bodyTrust, 'verified-local-publication');
  assert.equal(result.definition.substitutions, 'trusted-service-observation');
  assert.equal(result.definition.prompt, 'Use the verified seed for wf-hosted.');
  assert.deepEqual(result.staticExtensions, {
    trust: 'verified-local-definition', spec: { harness: 'local-approved' }, x: { policy: 'local-only' },
  });
  assert.deepEqual(result.consumes, [{ path: 'seed', value: VALUE, trust: 'signed-value-and-local-chain-at-service-observed-version' }]);
  assert.deepEqual(result.outputs, [{ path: 'out', version: 1, versionTrust: 'trusted-service-observation' }]);
  assert.deepEqual(result.serviceObservation, {
    workflow: 'wf-hosted', run: 'run-hosted', step: 'make', packetDigest: hostedReferencePacketDigest(h.p),
    observedAt: 1_000, expiresAt: 6_000,
  });
  const rendered = JSON.stringify(result);
  assert.doesNotMatch(rendered, /HOSTILE|proof|signature|lease|text|structuredContent/i);
});

test('malformed preflight never triggers a direct fetch', async () => {
  const h = await harness();
  assert.deepEqual(await h.adapter.open({ protocol: 'client-preflight-v1', verification: 'verified', order: { state: 'available' } }), {
    protocol: 'local-hosted-order-v1', state: 'unavailable',
  });
  assert.equal(h.fetches(), 0);
});

test('old Service 404 and malformed v1 acknowledgements never retry legacy get_order', async () => {
  const old = await harness({ status: 404, wireResponse: () => ({ error: 'not_found', message: 'OLD RAW SERVICE' }) });
  assert.deepEqual(await old.adapter.open(preflight(old.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-read-unavailable',
  });
  assert.equal(old.fetches(), 1);
  for (const wireResponse of [
    (p: OrderPacket) => ({ ...availableWire(p), protocol: undefined }),
    (p: OrderPacket) => ({ ...availableWire(p), protocol: 'client-preflight-v1' }),
    (p: OrderPacket) => ({ ...availableWire(p), state: 'new-unknown-state' }),
    (p: OrderPacket) => ({ ...availableWire(p), text: 'HOSTILE LEGACY TEXT' }),
  ]) {
    const h = await harness({ wireResponse });
    const result = await h.adapter.open(preflight(h.f.defDigest));
    assert.equal(result.state, 'refused');
    assert.equal(h.fetches(), 1);
    assert.doesNotMatch(JSON.stringify(result), /HOSTILE|signed value/u);
  }
});

test('v1 rejects missing dynamic identity, extra authored fields and malformed proof envelopes', async () => {
  const mutations: Array<(wire: Record<string, unknown>) => unknown> = [
    (wire) => ({ ...wire, order: { ...(wire.order as object), consumedFingerprint: undefined } }),
    (wire) => ({ ...wire, order: { ...(wire.order as object), spec: { prompt: 'HOSTILE' } } }),
    (wire) => ({ ...wire, order: { ...(wire.order as object), modifier: 'deep' } }),
    (wire) => ({ ...wire, order: { ...(wire.order as object), cause: 'idle' } }),
    (wire) => ({ ...wire, order: { ...(wire.order as object), consumesProof: '{bad-json' } }),
    (wire) => ({ ...wire, order: { ...(wire.order as object), consumesProof: undefined } }),
    (wire) => ({ ...wire, order: { ...(wire.order as object), owes: [{ path: 'out', version: 0 }] } }),
    (wire) => ({ ...wire, order: { ...(wire.order as object), owes: [{ path: 'out', version: 1, proof: { hostile: true } }] } }),
    (wire) => ({ ...wire, lease: { claimed: false } }),
    (wire) => ({ ...wire, lease: { claimed: true, claimedAt: 'unknown' } }),
  ];
  for (const mutate of mutations) {
    const h = await harness({ wireResponse: (p) => mutate(availableWire(p)) });
    const result = await h.adapter.open(preflight(h.f.defDigest));
    assert.equal(result.state, 'refused', JSON.stringify(result));
    assert.equal(h.fetches(), 1);
    assert.doesNotMatch(JSON.stringify(result), /HOSTILE|signed value/u);
  }
});

test('v1 refuses modifier-dependent local definitions and explicit unsupported Service states', async () => {
  const modified = await harness({ workflowYaml: WORKFLOW.replace('Use the verified seed for ${WORKFLOW}.',
    'Use ${MODIFIER} with the verified seed.') });
  assert.deepEqual(await modified.adapter.open(preflight(modified.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'unsupported-service-v1-shape',
  });
  for (const state of ['unavailable', 'unsupported-feedback', 'routing-unsupported'] as const) {
    const h = await harness({ wireResponse: (p) => ({ protocol: 'trusted-reference-read-v1', state,
      workflow: p.workflow, run: p.run }) });
    assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
      protocol: 'local-hosted-order-v1', state: 'refused', code: `service-${state}`,
    });
    assert.equal(h.fetches(), 1);
  }
});

test('hostile preflight cannot use the local bearer token to select another order', async () => {
  const h = await harness();
  for (const ref of [
    { workflow: 'wf-other' },
    { run: 'run-other' },
  ]) {
    assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest, ref)), {
      protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-out-of-scope',
    });
  }
  assert.equal(h.fetches(), 0, 'no authenticated request is sent for a foreign reference');
  const expected = { workflowId: 'wf-hosted', runId: 'run-hosted' };
  const pinned = await harness({ expected });
  expected.runId = 'run-other';
  assert.equal((await pinned.adapter.open(preflight(pinned.f.defDigest))).state, 'ready');
});

test('a rebound direct response and a stale claim are refused', async () => {
  const rebound = await harness({ response: (p) => ({ text: 'malicious', workflow: p.workflow, run: p.run, order: { ...p, run: 'other-run' }, lease: { claimed: true } }) });
  assert.deepEqual(await rebound.adapter.open(preflight(rebound.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-rebound',
  });
  const stale = await harness({ response: (p) => ({ text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: false } }) });
  assert.deepEqual(await stale.adapter.open(preflight(stale.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'service-unavailable',
  });
  const digest = await harness();
  assert.deepEqual(await digest.adapter.open(preflight('a'.repeat(64))), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-rebound',
  });
});

test('every retrieval fetches a fresh service claim and refuses after re-offer', async () => {
  const h = await harness({ response: (p, fetchCount) => ({
    text: '', workflow: p.workflow, run: p.run, order: p,
    lease: { claimed: fetchCount === 1, ...(fetchCount === 1 ? {} : { outcome: 'released' }) },
  }) });
  assert.equal((await h.adapter.open(preflight(h.f.defDigest))).state, 'ready');
  assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'service-unavailable',
  });
  assert.equal(h.fetches(), 2);
});

test('unsupported feedback and previous value never cross the boundary', async () => {
  for (const [code, change] of [
    ['service-unsupported-feedback', (p: OrderPacket) => { p.owes[0]!.reasons = [{ at: 1, action: 'reject', kind: 'human', by: 'x', text: 'HOSTILE REASON' }]; }],
    ['unsupported-feedback', (p: OrderPacket) => { p.owes[0]!.proof = 'unsupported-reason-proof'; }],
    ['service-unsupported-feedback', (p: OrderPacket) => { p.owes[0]!.previousValue = 'HOSTILE OLD VALUE'; }],
  ] as const) {
    const h = await harness({ response: (p) => {
      change(p);
      return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
    } });
    assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
      protocol: 'local-hosted-order-v1', state: 'refused', code,
    });
  }
});

test('tampered signed value and unsigned consume refuse under the hard gate', async () => {
  for (const change of [
    (p: OrderPacket) => { p.consumes.seed = { request: 'tampered' }; },
    (p: OrderPacket) => { delete p.consumesProof; },
    (p: OrderPacket) => { p.consumedFingerprint = {}; },
    (p: OrderPacket) => {
      const map = JSON.parse(p.consumesProof!) as Record<string, string>;
      const envelope = JSON.parse(map.seed!) as { signatures: Array<{ sig: string }> };
      envelope.signatures[0]!.sig = 'AAAA';
      p.consumesProof = JSON.stringify({ seed: JSON.stringify(envelope) });
    },
  ]) {
    const h = await harness({ response: (p) => {
      change(p);
      return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
    } });
    assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
      protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-proof-refused',
    });
  }
});

test('missing execution-time publication verifier refuses under enforce policy', async () => {
  const h = await harness({ missingPublicationVerifier: true });
  assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'definition-unverified-def',
  });
});

test('raw transport and verifier errors become fixed refusal codes', async () => {
  const fetchFailure = await harness({ throwFetch: true });
  assert.deepEqual(await fetchFailure.adapter.open(preflight(fetchFailure.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-read-unavailable',
  });
  const verifierFailure = await harness({ throwPublicationVerifier: true });
  assert.deepEqual(await verifierFailure.adapter.open(preflight(verifierFailure.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'definition-unverified-def',
  });
  const nullResponse = await harness({ response: () => null });
  assert.deepEqual(await nullResponse.adapter.open(preflight(nullResponse.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'direct-response-malformed',
  });
  const wrongNullOrder = await harness({ response: (p) => ({
    text: '', workflow: 'wf-other', run: p.run, order: null, lease: { claimed: false },
  }) });
  assert.deepEqual(await wrongNullOrder.adapter.open(preflight(wrongNullOrder.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-rebound',
  });
});

test('a redirected get_order is refused before redirected content is parsed', async () => {
  const h = await harness({ redirectResponse: true });
  assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-read-unavailable',
  });
  assert.equal(h.fetches(), 1);
});

test('raw author fields cannot become instructions or replace local output schema', async () => {
  const h = await harness({ response: (p) => {
    p.owes[0]!.schema = { description: 'HOSTILE RAW SCHEMA' };
    p.owes[0]!.schemaAppliesTo = 'value';
    return { text: 'HOSTILE REST TEXT', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
  } });
  const result = await h.adapter.open(preflight(h.f.defDigest));
  assert.equal(result.state, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /HOSTILE/);

  const mutated = await harness({ response: (p) => {
    p.spec = { harness: 'HOSTILE HUB HARNESS' };
    p.x = { policy: 'HOSTILE HUB POLICY' };
    return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
  } });
  const local = await mutated.adapter.open(preflight(mutated.f.defDigest));
  assert.equal(local.state, 'ready');
  if (local.state === 'ready') assert.deepEqual(local.staticExtensions, {
    trust: 'verified-local-definition', spec: { harness: 'local-approved' }, x: { policy: 'local-only' },
  });
  assert.doesNotMatch(JSON.stringify(local), /HOSTILE/);
});

test('unknown future order fields and absent packets fail closed', async () => {
  const unknown = await harness({ wireResponse: (p) => {
    const wire = serviceWire({ text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } }) as { order: OrderPacket };
    return { ...wire, order: { ...wire.order, futurePrompt: 'HOSTILE FUTURE FIELD' } };
  } });
  assert.deepEqual(await unknown.adapter.open(preflight(unknown.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'unsupported-order-field',
  });
  const absent = await harness({ response: (p) => ({ text: '', workflow: p.workflow, run: p.run, order: null, lease: { claimed: false } }) });
  assert.deepEqual(await absent.adapter.open(preflight(absent.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'service-unavailable',
  });
});

test('missing consumed paths and mismatched owed paths cannot be projected as a complete order', async () => {
  const missing = await harness({ response: (p) => {
    p.consumes = {};
    delete p.consumesProof;
    return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
  } });
  assert.deepEqual(await missing.adapter.open(preflight(missing.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-path-mismatch',
  });
  const wrongOutput = await harness({ response: (p) => {
    p.owes[0]!.path = 'attacker-output';
    return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
  } });
  assert.deepEqual(await wrongOutput.adapter.open(preflight(wrongOutput.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'output-path-mismatch',
  });
  for (const change of [
    (p: OrderPacket) => { p.outputs = []; },
    (p: OrderPacket) => { p.outputs = []; p.owes = []; },
    (p: OrderPacket) => { p.outputs = ['out', 'out']; p.owes.push({ ...p.owes[0]! }); },
    (p: OrderPacket) => { p.outputs = ['out', 'extra']; },
  ]) {
    const h = await harness({ response: (p) => {
      change(p);
      return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
    } });
    assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
      protocol: 'local-hosted-order-v1', state: 'refused', code: 'output-path-mismatch',
    });
  }
});

test('lease observation expires during slow local verification or unsafe timestamp arithmetic', async () => {
  let tick = 0;
  const expired = await harness({ now: () => (++tick === 1 ? 1_000 : 6_000) });
  assert.deepEqual(await expired.adapter.open(preflight(expired.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'claim-observation-expired',
  });
  const overflow = await harness({ now: () => Number.MAX_SAFE_INTEGER - 1 });
  assert.deepEqual(await overflow.adapter.open(preflight(overflow.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'clock-unavailable',
  });
});

test('configured service origin must be HTTPS', async () => {
  const h = await harness();
  assert.throws(() => createHostedOrderAdapter({
    hub: { origin: 'http://trusted.example', getToken: async () => 'x' },
    expected: { workflowId: 'wf-hosted', runId: 'run-hosted' },
    instructionSource: { globalRoot: '/unused', verifier: createBundleIngestor() },
    consumeTrust: { env: {} }, now: () => 1,
  }), /HTTPS/);
  assert.equal(h.fetches(), 0);
});

test('production wiring verifies a real signed local publication and real signed consume', async () => {
  const cwd = tempDir('owenloop-hosted-default-cwd-');
  const home = tempDir('owenloop-hosted-default-home-');
  const sourceDir = writeBundleSource({ name: 'hosted-adapter', workflow: WORKFLOW });
  const installed = await installSignedBundleFixture({ sourceDir, root: join(cwd, 'workflows'), home });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition);
  const keyPath = join(home, 'producer');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'hosted-adapter-test', '-f', keyPath], { stdio: 'ignore' });
  const rootKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  writeFileSync(join(home, '.owenloop', 'org-root.pub'), rootKey.openSshPublicKey);
  const defDigest = defInstructionDigest(definition);
  const p = await packet(defDigest, keyPath, rootKey.keyid);
  const adapter = createDefaultHostedOrderAdapter({
    cwd, env: { HOME: home }, now: () => 1_000,
    expected: { workflowId: 'wf-hosted', runId: 'run-hosted' },
    hub: {
      origin: 'https://trusted.example', getToken: async () => 'local-secret',
      fetchImpl: async () => new Response(JSON.stringify(serviceWire({
	text: 'raw service text', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true },
      })), { status: 200 }),
    },
  });
  const result = await adapter.open(preflight(defDigest));
  assert.equal(result.state, 'ready', JSON.stringify(result));
  if (result.state === 'ready') assert.equal(result.definition.bodyTrust, 'verified-local-publication');
});

test('signed reduce order admits only the verified collection seal and member paths', async () => {
  const cwd = tempDir('owenloop-hosted-reduce-cwd-');
  const home = tempDir('owenloop-hosted-reduce-home-');
  const installed = await installSignedBundleFixture({
    sourceDir: writeBundleSource({ name: 'hosted-reduce', workflow: REDUCE_WORKFLOW }),
    root: join(cwd, 'workflows'), home,
  });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition);
  const keyPath = join(home, 'producer');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'hosted-reduce-test', '-f', keyPath], { stdio: 'ignore' });
  const rootKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  writeFileSync(join(home, '.owenloop', 'org-root.pub'), rootKey.openSshPublicKey);
  const defDigest = defInstructionDigest(definition);
  const member = { item: 'signed' };
  const seal = { count: 1 };
  const policy = { mode: 'approved' };
  const p: OrderPacket = {
    workflow: 'wf-hosted', run: 'run-hosted', step: 'summarize', key: '', defDigest,
    inputs: ['items[0]', 'items.sealed', 'policy'], outputs: ['summary'],
    consumes: { 'items[0]': member, 'items.sealed': seal, policy },
    consumedFingerprint: { 'items[0]': 2, 'items.sealed': 1, policy: 1 },
    consumesProof: JSON.stringify({
      'items[0]': await proof(member, keyPath, rootKey.keyid, 'items[0]', 2),
      'items.sealed': await proof(seal, keyPath, rootKey.keyid, 'items.sealed', 1),
      policy: await proof(policy, keyPath, rootKey.keyid, 'policy', 1),
    }),
    owes: [{ path: 'summary', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  const adapter = createDefaultHostedOrderAdapter({
    cwd, env: { HOME: home }, now: () => 1_000,
    expected: { workflowId: 'wf-hosted', runId: 'run-hosted' },
    hub: {
      origin: 'https://trusted.example', getToken: async () => 'local-secret',
      fetchImpl: async () => new Response(JSON.stringify(serviceWire({
	text: 'raw service text', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true },
      })), { status: 200 }),
    },
  });
  const result = await adapter.open(preflight(defDigest));
  assert.equal(result.state, 'ready', JSON.stringify(result));
  if (result.state === 'ready') {
    assert.deepEqual(result.consumes.map(({ path }) => path), ['items[0]', 'items.sealed', 'policy']);
  }
  p.inputs = ['items[0]', 'policy'];
  delete p.consumes['items.sealed'];
  assert.deepEqual(await adapter.open(preflight(defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-path-mismatch',
  });
  p.inputs = ['items[0]', 'items.sealed'];
  p.consumes['items.sealed'] = seal;
  delete p.consumes.policy;
  assert.deepEqual(await adapter.open(preflight(defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-path-mismatch',
  });
});

test('signed map order binds the bare key, index, input and output to one member', async () => {
  const cwd = tempDir('owenloop-hosted-map-cwd-');
  const home = tempDir('owenloop-hosted-map-home-');
  const installed = await installSignedBundleFixture({
    sourceDir: writeBundleSource({ name: 'hosted-map', workflow: MAP_WORKFLOW }),
    root: join(cwd, 'workflows'), home,
  });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition);
  const keyPath = join(home, 'producer');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'hosted-map-test', '-f', keyPath], { stdio: 'ignore' });
  const rootKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  writeFileSync(join(home, '.owenloop', 'org-root.pub'), rootKey.openSshPublicKey);
  const defDigest = defInstructionDigest(definition);
  const member = { item: 'signed map member' };
  const p: OrderPacket = {
    workflow: 'wf-hosted', run: 'run-hosted', step: 'annotate', key: 'items[0]', index: 0, defDigest,
    inputs: ['items[0]'], outputs: ['items[0].note'], consumes: { 'items[0]': member },
    consumedFingerprint: { 'items[0]': 2 },
    consumesProof: JSON.stringify({ 'items[0]': await proof(member, keyPath, rootKey.keyid, 'items[0]', 2) }),
    owes: [{ path: 'items[0].note', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  const adapter = createDefaultHostedOrderAdapter({
    cwd, env: { HOME: home }, now: () => 1_000,
    expected: { workflowId: 'wf-hosted', runId: 'run-hosted' },
    hub: {
      origin: 'https://trusted.example', getToken: async () => 'local-secret',
      fetchImpl: async () => new Response(JSON.stringify(serviceWire({
	text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true },
      })), { status: 200 }),
    },
  });
  assert.equal((await adapter.open(preflight(defDigest))).state, 'ready');
  p.key = 'items[1]';
  assert.deepEqual(await adapter.open(preflight(defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-path-mismatch',
  });
  p.key = 'items[0]';
  p.index = 1;
  assert.deepEqual(await adapter.open(preflight(defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-path-mismatch',
  });
  p.index = 0;
  p.inputs = ['items[0]', 'items[0]'];
  assert.deepEqual(await adapter.open(preflight(defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-path-mismatch',
  });
  p.inputs = ['items[0]'];
  p.outputs = ['audit'];
  p.owes = [{ path: 'audit', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }];
  assert.deepEqual(await adapter.open(preflight(defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'output-path-mismatch',
  });
});

test('a delayed v1 fetch cannot reset the claim observation window', async () => {
  let clock = 1_000;
  let releaseFetch!: () => void;
  const delayed = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let fetchEntered!: () => void;
  const entered = new Promise<void>((resolve) => { fetchEntered = resolve; });
  const h = await harness({
    now: () => clock,
    response: async (p) => {
      fetchEntered();
      await delayed;
      return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
    },
  });
  const pending = h.adapter.open(preflight(h.f.defDigest));
  await entered;
  clock = 6_000;
  releaseFetch();
  assert.deepEqual(await pending, {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'claim-observation-expired',
  });
  assert.equal(h.fetches(), 1);
});

test('a wall-clock rollback during v1 fetch cannot extend the monotonic observation window', async () => {
  let wall = 10_000;
  let elapsed = 0;
  let releaseFetch!: () => void;
  const delayed = new Promise<void>((resolve) => { releaseFetch = resolve; });
  let fetchEntered!: () => void;
  const entered = new Promise<void>((resolve) => { fetchEntered = resolve; });
  const h = await harness({
    now: () => wall,
    monotonicNow: () => elapsed,
    response: async (p) => {
      fetchEntered();
      await delayed;
      return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
    },
  });
  const pending = h.adapter.open(preflight(h.f.defDigest));
  await entered;
  // Simulate seven seconds of monotonic elapsed time while the wall clock only advances 100 ms.
  elapsed = 7_000;
  wall = 10_100;
  releaseFetch();
  assert.deepEqual(await pending, {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'claim-observation-expired',
  });
});

test('a shorter rollback leaves only the remaining monotonic TTL in the projected epoch expiry', async () => {
  let wall = 10_000;
  let elapsed = 0;
  const h = await harness({
    now: () => wall,
    monotonicNow: () => elapsed,
    response: (p) => {
      elapsed = 4_000;
      wall = 10_100;
      return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
    },
  });
  const result = await h.adapter.open(preflight(h.f.defDigest));
  assert.equal(result.state, 'ready');
  if (result.state === 'ready') assert.equal(result.serviceObservation.expiresAt, 11_100);
});


test('v1 hosted source refuses a calls-produced path without a verified child closure', async () => {
  const installed = await installBundleFixture({
    root: tempDir('owenloop-hosted-calls-project-'),
    sourceDir: writeBundleSource({
      name: 'hosted-calls', workflow: CALLS_PARENT,
      workflows: { 'hosted-child': CALLS_CHILD }, defaultWorkflow: 'hosted-calls',
    }),
  });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const child = loadDefFile(join(installed.result.objectPath, 'hosted-child.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded], [child.name, child]])).get(loaded.name);
  assert.ok(definition);
  const home = mkdtempSync(join(tmpdir(), 'owenloop-hosted-calls-home-'));
  const keyPath = join(home, 'producer');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'hosted-calls-test', '-f', keyPath], { stdio: 'ignore' });
  const rootKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  mkdirSync(join(home, '.owenloop'));
  writeFileSync(join(home, '.owenloop', 'org-root.pub'), rootKey.openSshPublicKey);
  const defDigest = defInstructionDigest(definition);
  const value = { accepted: 'ordinary-parent-path-proof' };
  const p: OrderPacket = {
    workflow: 'wf-hosted', run: 'run-hosted', step: 'inspect', key: '', defDigest,
    inputs: ['unit-result'], outputs: ['out'], consumes: { 'unit-result': value },
    consumedFingerprint: { 'unit-result': 1 },
    consumesProof: JSON.stringify({ 'unit-result': await proof(value, keyPath, rootKey.keyid, 'unit-result', 1) }),
    owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
  const verifier = createBundleIngestor();
  const globalRoot = tempDir('owenloop-hosted-calls-global-');
  const complete = createStoreInstructionSource({ projectRoot: installed.root, globalRoot, verifier });
  const { getVerifiedCallsChild: _omitted, ...withoutClosure } = complete;
  const sources = [withoutClosure, { ...complete, getVerifiedCallsChild: () => undefined }];
  for (const source of sources) {
    const adapter = createHostedOrderAdapter({
      hub: {
	origin: 'https://trusted.example', getToken: async () => 'local-secret',
	fetchImpl: async () => new Response(JSON.stringify(serviceWire({
	  text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true },
	})), { status: 200 }),
      },
      expected: { workflowId: 'wf-hosted', runId: 'run-hosted' },
      instructionSource: {
	projectRoot: installed.root, globalRoot, verifier, source, env: { HOME: home },
	definitionVerifier: () => ({ kind: 'verified', publisherKeyId: rootKey.keyid, principal: 'publisher' }),
      },
      consumeTrust: { env: { HOME: home } }, now: () => 1_000,
    });
    assert.deepEqual(await adapter.open(preflight(defDigest)), {
      protocol: 'local-hosted-order-v1', state: 'refused', code: 'definition-integrity',
    });
  }
});
