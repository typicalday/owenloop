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
