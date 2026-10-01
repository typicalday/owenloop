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
import { createBundleIngestor } from '../../../src/store/index.ts';
import { installBundleFixture, installSignedBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';
import { createDefaultHostedOrderAdapter, createHostedOrderAdapter } from '../src/hosted/order-adapter.ts';

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

async function proof(value: unknown, keyPath: string, keyId: string): Promise<string> {
  const payload = {
    run: 'producer-run', workflow: 'wf-hosted', defDigest: 'producer-definition',
    step: 'produce-seed', key: '',
    produced: [{ artifact: 'seed', version: 2, valueDigest: valueDigestHex(value) }],
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

async function fixture() {
  const installed = await installBundleFixture({
    root: tempDir('owenloop-hosted-adapter-project-'),
    sourceDir: writeBundleSource({ name: 'hosted-adapter', workflow: WORKFLOW }),
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
  response?: (p: OrderPacket, fetchCount: number) => GetOrderResponse;
  received?: (body: unknown, init: RequestInit) => void;
  missingPublicationVerifier?: boolean;
  throwPublicationVerifier?: boolean;
  throwFetch?: boolean;
} = {}) {
  const f = await fixture();
  const p = await packet(f.defDigest, f.keyPath, f.rootKeyId);
  let fetches = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    fetches++;
    if (overrides.throwFetch) throw new Error('HOSTILE RAW FETCH ERROR');
    overrides.received?.(JSON.parse(String(init?.body)), init ?? {});
    const response = overrides.response?.(p, fetches) ?? {
      text: 'HOSTILE RAW REST TEXT', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true },
    };
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const adapter = createHostedOrderAdapter({
    hub: { origin: 'https://trusted.example', getToken: async () => 'local-secret', fetchImpl },
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
    now: () => 1_000,
  });
  return { adapter, p, f, fetches: () => fetches };
}

test('valid signed consume crosses direct authenticated fetch into a minimized labeled projection', async () => {
  const h = await harness({ received: (body, init) => {
    assert.deepEqual(body, { workflow: 'wf-hosted', run: 'run-hosted' });
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer local-secret');
  } });
  const result = await h.adapter.open(preflight(h.f.defDigest, { prompt: 'HOSTILE RELAY PROMPT' }));
  assert.equal(result.state, 'ready');
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
    workflow: 'wf-hosted', run: 'run-hosted', step: 'make', observedAt: 1_000, expiresAt: 6_000,
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

test('a rebound direct response and a stale claim are refused', async () => {
  const rebound = await harness({ response: (p) => ({ text: 'malicious', workflow: p.workflow, run: p.run, order: { ...p, run: 'other-run' }, lease: { claimed: true } }) });
  assert.deepEqual(await rebound.adapter.open(preflight(rebound.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'reference-rebound',
  });
  const stale = await harness({ response: (p) => ({ text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: false } }) });
  assert.deepEqual(await stale.adapter.open(preflight(stale.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'claim-not-current',
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
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'claim-not-current',
  });
  assert.equal(h.fetches(), 2);
});

test('unsupported feedback and previous value never cross the boundary', async () => {
  for (const change of [
    (p: OrderPacket) => { p.owes[0]!.reasons = [{ at: 1, action: 'reject', kind: 'human', by: 'x', text: 'HOSTILE REASON' }]; },
    (p: OrderPacket) => { p.owes[0]!.proof = 'unsupported-reason-proof'; },
    (p: OrderPacket) => { p.owes[0]!.previousValue = 'HOSTILE OLD VALUE'; },
  ]) {
    const h = await harness({ response: (p) => {
      change(p);
      return { text: '', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true } };
    } });
    assert.deepEqual(await h.adapter.open(preflight(h.f.defDigest)), {
      protocol: 'local-hosted-order-v1', state: 'refused', code: 'unsupported-feedback',
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
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'direct-fetch-failed',
  });
  const verifierFailure = await harness({ throwPublicationVerifier: true });
  assert.deepEqual(await verifierFailure.adapter.open(preflight(verifierFailure.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'definition-unverified-def',
  });
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
  const unknown = await harness({ response: (p) => ({
    text: '', workflow: p.workflow, run: p.run,
    order: { ...p, futurePrompt: 'HOSTILE FUTURE FIELD' } as OrderPacket,
    lease: { claimed: true },
  }) });
  assert.deepEqual(await unknown.adapter.open(preflight(unknown.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'refused', code: 'unsupported-order-field',
  });
  const absent = await harness({ response: (p) => ({ text: '', workflow: p.workflow, run: p.run, order: null, lease: { claimed: false } }) });
  assert.deepEqual(await absent.adapter.open(preflight(absent.f.defDigest)), {
    protocol: 'local-hosted-order-v1', state: 'unavailable',
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
});

test('configured service origin must be HTTPS', async () => {
  const h = await harness();
  assert.throws(() => createHostedOrderAdapter({
    hub: { origin: 'http://trusted.example', getToken: async () => 'x' },
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
    hub: {
      origin: 'https://trusted.example', getToken: async () => 'local-secret',
      fetchImpl: async () => new Response(JSON.stringify({
	text: 'raw service text', workflow: p.workflow, run: p.run, order: p, lease: { claimed: true },
      }), { status: 200 }),
    },
  });
  const result = await adapter.open(preflight(defDigest));
  assert.equal(result.state, 'ready', JSON.stringify(result));
  if (result.state === 'ready') assert.equal(result.definition.bodyTrust, 'verified-local-publication');
});
