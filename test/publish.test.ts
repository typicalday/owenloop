/**
 * `owenloop publish` tests. Unsigned cases use the in-memory key seam and
 * exercise the no-side-effect gates. The signed acceptance case opts into a
 * fixture HOME and stock OpenSSH, then verifies the emitted publication DSSE.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { PrincipalKeyManager } from '../src/crypto/keys.ts';
import { DSSE_SSH_NAMESPACE, dsseVerifyPublication } from '../src/crypto/dsse.ts';
import { createSshSigner } from '../src/crypto/ssh.ts';
import { digestBundle } from '../src/bundle/index.ts';
import { defDigest } from '../src/store/types.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import { makeIo } from './hubkit.ts';

const SOURCE_FIXTURE = join(import.meta.dirname, 'fixtures', 'bundle', 'golden-source');
const ORIGIN = 'http://127.0.0.1:9';
const HUMAN_REF = { origin: ORIGIN, kind: 'human' as const, id: 'user_abc' };

function sourceFor(t: { cwd: string }): string {
  const source = join(t.cwd, 'source');
  cpSync(SOURCE_FIXTURE, source, { recursive: true });
  return source;
}

function bind(t: { cwd: string }): void {
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => filesUnder(join(path, entry.name)));
}

function sshKeygenWorks(): boolean {
  try {
    execFileSync('ssh-keygen', ['-Y', 'find-principals'], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch (error) {
    return typeof (error as { status?: unknown }).status === 'number';
  }
}

const SSH_SKIP = !sshKeygenWorks() && 'host ssh-keygen lacks -Y support';

test('publish: unknown option names the typo, suggests --unsigned, and writes nothing', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');

  const code = await mainAsync(['publish', source, '--unsignd', '--output', output], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown option --unsignd/);
  assert.match(t.err.join('\n'), /did you mean --unsigned/);
  assert.deepEqual(filesUnder(t.cwd).filter((path) => !path.includes(`${'/source/'}`)), []);
  assert.equal(existsSync(output), false);
});

test('publish: no hub binding fails before packing or writing', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /not bound to a hub/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.unsigned`), false);
});

test('publish: signed default refuses missing author key and names setup and --unsigned', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');

  const code = await mainAsync(['publish', source, '--output', output], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /no author signing key/);
  assert.match(t.err.join('\n'), /owenloop setup/);
  assert.match(t.err.join('\n'), /--unsigned/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.dsse`), false);
  assert.equal(existsSync(`${output}.unsigned`), false);
});

test('publish --unsigned writes a bundle and unauthenticated marker, not a DSSE envelope', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n')) as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(result.signed, false);
  assert.equal(result.bundle, output);
  assert.equal(result.marker, `${output}.unsigned`);
  assert.equal(existsSync(output), true);
  assert.equal(existsSync(`${output}.unsigned`), true);
  assert.equal(existsSync(`${output}.dsse`), false);

  const marker = JSON.parse(readFileSync(`${output}.unsigned`, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(marker, { formatVersion: 1, digest: digestBundle(readFileSync(output)).digest, signed: false });
});

test('publish --unsigned removes a stale DSSE sidecar', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  writeFileSync(`${output}.dsse`, '{"stale":true}\n');

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(existsSync(`${output}.dsse`), false);
  assert.equal(existsSync(`${output}.unsigned`), true);
});

test('publish signed output is a verifiable publication DSSE over the canonical bundle digest', { skip: SSH_SKIP }, async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keys = new PrincipalKeyManager({ env: t.io.env });
  const ensured = await keys.ensure(HUMAN_REF);

  const code = await mainAsync(['publish', source, '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(existsSync(`${output}.dsse`), true);
  assert.equal(existsSync(`${output}.unsigned`), false);
  const envelope = JSON.parse(readFileSync(`${output}.dsse`, 'utf8')) as Record<string, unknown>;

  const signer = createSshSigner({
    namespace: DSSE_SSH_NAMESPACE,
    verify: { principal: 'owenloop-test-author', allowedSignersText: `owenloop-test-author ${ensured.publicKey.openSshPublicKey}\n` },
  });
  const verified = await dsseVerifyPublication(envelope, signer);
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as Record<string, unknown>;
  const packedDigest = digestBundle(readFileSync(output)).digest;
  assert.equal(record.digest, packedDigest);
  assert.equal(defDigest(record.digest as string), record.digest);
  assert.equal(record.name, 'golden-bundle');
  assert.equal(record.version, '1.0.0');
  assert.equal(record.publisherKeyId, ensured.publicKey.keyid);
  assert.equal(typeof record.timestamp, 'number');

  const outputText = `${t.out.join('\n')}\n${t.err.join('\n')}`;
  assert.equal(outputText.includes(t.home), false, 'private-key storage path must not appear in CLI output');
  for (const file of filesUnder(t.cwd)) {
    const contents = readFileSync(file);
    assert.equal(contents.includes(Buffer.from('PRIVATE')), false, `private marker leaked into ${file}`);
  }
});

test('publish signed envelope rejects a wrong digest payload, tampered Base64, and tampered payload type', { skip: SSH_SKIP }, async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keys = new PrincipalKeyManager({ env: t.io.env });
  const ensured = await keys.ensure(HUMAN_REF);
  const code = await mainAsync(['publish', source, '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const envelope = JSON.parse(readFileSync(`${output}.dsse`, 'utf8')) as {
    payload: string;
    payloadType: string;
    signatures: unknown[];
  };
  const signer = createSshSigner({
    namespace: DSSE_SSH_NAMESPACE,
    verify: { principal: 'owenloop-test-author', allowedSignersText: `owenloop-test-author ${ensured.publicKey.openSshPublicKey}\n` },
  });

  const wrongDigest = { ...envelope, payload: Buffer.from(JSON.stringify({ digest: 'f'.repeat(64) })).toString('base64') };
  await assert.rejects(dsseVerifyPublication(wrongDigest, signer));
  await assert.rejects(dsseVerifyPublication({ ...envelope, payload: '!' }, signer), /base64/);
  await assert.rejects(dsseVerifyPublication({ ...envelope, payloadType: 'application/vnd.owenloop.origin.v1+json' }, signer));
});
