import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHubBundleRecoveryHandler } from '../src/bundle/pull.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { packBundle } from '../../../src/bundle/index.ts';
import { canonicalJsonBytes } from '../../../src/install.ts';
import { DSSE_SSH_NAMESPACE, dsseSignPublication } from '../../../src/crypto/dsse.ts';
import { createSshSigner } from '../../../src/crypto/ssh.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import {
  createBundleIngestor,
  createStoreInstructionSource,
  globalStoreRoot,
} from '../../../src/store/index.ts';
import { writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import type { OrderPacket } from '../src/hub/types.ts';

const WORKFLOW = [
  'name: recovered',
  'inputs:',
  '  - name: seed',
  '    seedOwed: true',
  'steps:',
  '  - name: command',
  '    consumes: [seed]',
  '    produces: [out]',
  '    terminal: true',
  '    command: echo recovered',
  '',
].join('\n');

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function signedFixture(): Promise<{
  bytes: Uint8Array;
  digest: string;
  publication: Uint8Array;
  home: string;
}> {
  const home = temp('owenloop-pull-home-');
  const sourceDir = writeBundleSource({ name: 'recovered', workflow: WORKFLOW });
  const packed = packBundle(sourceDir);
  const keyPath = join(home, 'publisher');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
  const publicKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  const allowedDir = join(home, '.owenloop');
  mkdirSync(allowedDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(allowedDir, 'allowed_signers'), `publisher ${publicKey.openSshPublicKey}\n`, { mode: 0o600 });
  const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: keyPath });
  const signed = await dsseSignPublication(Buffer.from(canonicalJsonBytes({
    digest: packed.digest,
    name: packed.manifest.package.name,
    version: packed.manifest.package.version,
    publisherKeyId: publicKey.keyid,
    timestamp: Date.now(),
  })), signer);
  return { bytes: packed.bytes, digest: packed.digest, publication: canonicalJsonBytes(signed.envelope), home };
}

test('hub bundle recovery installs exact signed bytes and re-primes a store miss', async () => {
  const fixture = await signedFixture();
  const seen: Array<{ path?: string; auth?: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization });
    if (req.url === `/api/bundles/${fixture.digest}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', etag: fixture.digest });
      res.end(fixture.bytes);
      return;
    }
    if (req.url === `/api/publications/${fixture.digest}`) {
      res.writeHead(200, { 'x-owenloop-publication-state': 'signed' });
      res.end(fixture.publication);
      return;
    }
    if (req.url === `/api/origins/${fixture.digest}`) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const projectRoot = join(temp('owenloop-pull-project-'), 'workflows');
  const handler = createHubBundleRecoveryHandler({
    origin,
    token: 'scoped-test-bearer',
    home: fixture.home,
    projectRoot,
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
  });

  try {
    const source = createStoreInstructionSource({
      projectRoot,
      globalRoot: globalStoreRoot(fixture.home),
      verifier: createBundleIngestor(),
      onMissing: handler,
    });
    const resolver = createStoreInstructionResolver({
      projectRoot,
      globalRoot: globalStoreRoot(fixture.home),
      verifier: createBundleIngestor(),
      source,
      definitionVerifier: async () => ({ kind: 'verified', publisherKeyId: 'test', principal: 'test' }),
      originVerifier: async () => ({ kind: 'absent' }),
      env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    });
    const packet: OrderPacket = {
      workflow: 'wf-recovery',
      run: 'run-recovery',
      step: 'command',
      key: '',
      defDigest: fixture.digest,
      inputs: [],
      outputs: ['out'],
      consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    };
    const agent = await resolver.resolveStep(packet);
    assert.equal(agent.ok, true, 'an agent resolver recovers and resolves through the one-shot seam');
    const command = await resolver.resolveCommand({ ...packet, worker: 'command' });
    assert.deepEqual(command, { ok: true, command: 'echo recovered', bundleDir: source.getVerifiedObject(fixture.digest)?.objectPath });
    assert.deepEqual(seen.map((entry) => entry.path), [
      `/api/bundles/${fixture.digest}`,
      `/api/publications/${fixture.digest}`,
      `/api/origins/${fixture.digest}`,
    ]);
    assert.ok(seen.every((entry) => entry.auth === 'Bearer scoped-test-bearer'));

    assert.equal(source.getVerifiedStep(fixture.digest, 'command')?.command, 'echo recovered');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('hub bundle recovery rejects mismatched content before an object is committed', async () => {
  const fixture = await signedFixture();
  const expected = 'b'.repeat(64);
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === `/api/bundles/${expected}`) return new Response(fixture.bytes, { status: 200 });
    if (path === `/api/publications/${expected}`) {
      return new Response(fixture.publication, { status: 200, headers: { 'x-owenloop-publication-state': 'signed' } });
    }
    return new Response(null, { status: 404 });
  };
  const handler = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: 'scoped-test-bearer',
    home: fixture.home,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    fetchImpl,
  });

  await assert.rejects(handler.onMissing(expected), /canonical bundle digest mismatch/u);
  const source = createStoreInstructionSource({
    globalRoot: globalStoreRoot(fixture.home),
    verifier: createBundleIngestor(),
  });
  assert.equal(await source.prime(expected), 'unknown-digest');
});

test('hub bundle recovery rejects missing or malformed publication state before install', async () => {
  const fixture = await signedFixture();
  for (const [label, headers] of [
    ['missing', {}],
    ['malformed', { 'x-owenloop-publication-state': 'pending' }],
  ] as const) {
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/api/bundles/${fixture.digest}`) return new Response(fixture.bytes, { status: 200 });
      if (path === `/api/publications/${fixture.digest}`) return new Response(fixture.publication, { status: 200, headers });
      return new Response(null, { status: 404 });
    };
    const handler = createHubBundleRecoveryHandler({
      origin: 'https://hub.example',
      token: 'scoped-test-bearer',
      home: fixture.home,
      projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
      env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
      fetchImpl,
    });
    await assert.rejects(handler.onMissing(fixture.digest), /missing or invalid X-Owenloop-Publication-State/u, label);
  }
});

test('hub bundle recovery rejects a missing publication and invalid signed evidence', async () => {
  const fixture = await signedFixture();
  const cases: Array<{ name: string; publication: Response }> = [
    { name: 'missing publication', publication: new Response(null, { status: 404 }) },
    {
      name: 'invalid signed evidence',
      publication: new Response('{not-dsse', { status: 200, headers: { 'x-owenloop-publication-state': 'signed' } }),
    },
  ];
  for (const entry of cases) {
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/api/bundles/${fixture.digest}`) return new Response(fixture.bytes, { status: 200 });
      if (path === `/api/publications/${fixture.digest}`) return entry.publication.clone();
      return new Response(null, { status: 404 });
    };
    const handler = createHubBundleRecoveryHandler({
      origin: 'https://hub.example',
      token: 'scoped-test-bearer',
      home: fixture.home,
      projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
      env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
      fetchImpl,
    });
    await assert.rejects(
      handler.onMissing(fixture.digest),
      entry.name === 'missing publication' ? /publications.*HTTP 404/u : /publication.*(invalid|valid JSON|DSSE)/u,
      entry.name,
    );
  }
});

test('hub bundle recovery fails closed when signed evidence has no local verifier trust root', async () => {
  const fixture = await signedFixture();
  const untrustedHome = temp('owenloop-pull-untrusted-home-');
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === `/api/bundles/${fixture.digest}`) return new Response(fixture.bytes, { status: 200 });
    if (path === `/api/publications/${fixture.digest}`) {
      return new Response(fixture.publication, { status: 200, headers: { 'x-owenloop-publication-state': 'signed' } });
    }
    return new Response(null, { status: 404 });
  };
  const handler = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: 'scoped-test-bearer',
    home: untrustedHome,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: untrustedHome, OWENLOOP_DEF_POLICY: 'enforce' },
    fetchImpl,
  });

  await assert.rejects(handler.onMissing(fixture.digest), /unverifiable|allowed_signers|verification/u);
});

test('hub bundle recovery accepts an absent optional origin but rejects any other origin failure', async () => {
  const fixture = await signedFixture();
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === `/api/bundles/${fixture.digest}`) return new Response(fixture.bytes, { status: 200 });
    if (path === `/api/publications/${fixture.digest}`) {
      return new Response(fixture.publication, { status: 200, headers: { 'x-owenloop-publication-state': 'signed' } });
    }
    if (path === `/api/origins/${fixture.digest}`) return new Response('unavailable', { status: 503 });
    return new Response(null, { status: 404 });
  };
  const handler = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: 'scoped-test-bearer',
    home: fixture.home,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    fetchImpl,
  });

  await assert.rejects(handler.onMissing(fixture.digest), /origins.*HTTP 503/u);
});

test('hub bundle recovery rejects redirects and responses over either body cap', async () => {
  const fixture = await signedFixture();
  const redirectOptions: RequestInit[] = [];
  const redirectHandler = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: 'scoped-test-bearer',
    home: fixture.home,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    fetchImpl: async (_input, init) => {
      redirectOptions.push(init ?? {});
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/bundle' } });
    },
  });
  await assert.rejects(redirectHandler.onMissing(fixture.digest), /bundles.*HTTP 302/u);
  assert.equal(redirectOptions[0]?.redirect, 'error', 'recovery never follows a hub redirect');

  const oversizedBundle = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: 'scoped-test-bearer',
    home: fixture.home,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    fetchImpl: async () => new Response(null, { status: 200, headers: { 'content-length': '25000001' } }),
  });
  await assert.rejects(oversizedBundle.onMissing(fixture.digest), /25000000-byte cap/u);

  const oversizedEvidence = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: 'scoped-test-bearer',
    home: fixture.home,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === `/api/bundles/${fixture.digest}`) return new Response(fixture.bytes, { status: 200 });
		return new Response(null, {
			status: 200,
			headers: { 'x-owenloop-publication-state': 'signed', 'content-length': '65537' },
		});
    },
  });
  await assert.rejects(oversizedEvidence.onMissing(fixture.digest), /65536-byte cap/u);
});

test('hub bundle recovery times out and never discloses a bearer through transport errors', async () => {
  const fixture = await signedFixture();
  const secret = 'scoped-bearer-must-not-escape';
  let timeoutMessage = '';
  const timeoutHandler = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: secret,
    home: fixture.home,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    timeoutMs: 1,
    fetchImpl: async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal instanceof AbortSignal);
		return new Promise<Response>((_resolve, reject) => {
			const guard = setTimeout(() => reject(new Error('test timeout signal did not fire')), 50);
			const abort = () => {
				clearTimeout(guard);
				reject(signal.reason);
			};
			if (signal.aborted) abort();
			else signal.addEventListener('abort', abort, { once: true });
		});
    },
  });
  await assert.rejects(timeoutHandler.onMissing(fixture.digest), (error: unknown) => {
    timeoutMessage = error instanceof Error ? error.message : String(error);
    return /timed out after 0\.001s/u.test(timeoutMessage);
  });
  assert.doesNotMatch(timeoutMessage, new RegExp(secret, 'u'));

  let transportMessage = '';
  const failedTransport = createHubBundleRecoveryHandler({
    origin: 'https://hub.example',
    token: secret,
    home: fixture.home,
    projectRoot: join(temp('owenloop-pull-project-'), 'workflows'),
    env: { HOME: fixture.home, OWENLOOP_DEF_POLICY: 'enforce' },
    fetchImpl: async () => { throw new Error(`upstream included ${secret}`); },
  });
  await assert.rejects(failedTransport.onMissing(fixture.digest), (error: unknown) => {
    transportMessage = error instanceof Error ? error.message : String(error);
    return /request failed/u.test(transportMessage);
  });
  assert.doesNotMatch(transportMessage, new RegExp(secret, 'u'));
});
