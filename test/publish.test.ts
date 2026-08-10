/**
 * `owenloop publish` tests. Unsigned cases use the in-memory key seam and
 * exercise the no-side-effect gates. The signed acceptance case opts into a
 * fixture HOME and stock OpenSSH, then verifies the emitted publication DSSE.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { canonicalKeyRef, keyRefHash, keysDirFor, PrincipalKeyManager } from '../src/crypto/keys.ts';
import {
  DSSE_SSH_NAMESPACE,
  decodeBase64Strict,
  dsseVerifyOrigin,
  dsseVerifyPublication,
  encodeBase64,
} from '../src/crypto/dsse.ts';
import { createSshSigner } from '../src/crypto/ssh.ts';
import { digestBundle } from '../src/bundle/index.ts';
import { defDigest } from '../src/store/types.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { settingsPath } from '../packages/work/src/settings/settings.ts';
import { kcHuman, makeIo } from './hubkit.ts';

const SOURCE_FIXTURE = join(import.meta.dirname, 'fixtures', 'bundle', 'golden-source');
const ORIGIN = 'http://127.0.0.1:9';
const OTHER_ORIGIN = 'http://127.0.0.1:10';
const HUMAN_REF = { origin: ORIGIN, kind: 'human' as const, id: 'user_abc' };
const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_a',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'c',
};
const GIT_SOURCE = {
  kind: 'git' as const,
  repo: 'https://github.com/example/workflow',
  commit: '0123456789abcdef0123456789abcdef01234567',
};
const AGENT_SOURCE = {
  kind: 'agent' as const,
  agent: 'agent_123',
  session: 'session_456',
};

function sourceFor(t: { cwd: string }): string {
  const source = join(t.cwd, 'source');
  cpSync(SOURCE_FIXTURE, source, { recursive: true });
  return source;
}

function bind(t: { cwd: string }): void {
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

function writeSettings(t: { io: { env: Record<string, string | undefined> } }, settings: Record<string, unknown>): string {
  const path = settingsPath(t.io.env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings)}\n`);
  return path;
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

test('publish: no binding or global candidate exits 2 before packing and never guesses a default', async () => {
  const t = makeIo({ env: { OWENLOOP_NO_KEYCHAIN: '1', OWENLOOP_HUB: ORIGIN } });
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 2);
  assert.match(t.err.join('\n'), /cannot determine which hub/);
  assert.match(t.err.join('\n'), /--hub <origin>/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.unsigned`), false);
});

test('publish: --hub is accepted and overrides a different binding for author-key selection', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');
  bind(t);

  const code = await mainAsync(['publish', source, '--hub', OTHER_ORIGIN, '--output', output], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), new RegExp(`no author signing key for ${OTHER_ORIGIN.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(t.err.join('\n'), new RegExp(`no author signing key for ${ORIGIN.replaceAll('.', '\\.')}`));
  assert.equal(existsSync(output), false);
});

test('publish: keychain backend uses settings hubOrigin when the human credential exists', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');
  writeSettings(t, { hubOrigin: ORIGIN });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(existsSync(output), true);
  assert.equal(existsSync(`${output}.unsigned`), true);
});

test('publish: keychain backend without settings hubOrigin names the exact path and writes nothing', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');
  const path = settingsPath(t.io.env);

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 2);
  assert.match(t.err.join('\n'), /keychain credential store cannot be enumerated/);
  assert.match(t.err.join('\n'), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(t.err.join('\n'), /--hub <origin>/);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.unsigned`), false);
});

test('publish: settings-derived origin requires a credential before key or packing work', async () => {
  const t = makeIo();
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');
  writeSettings(t, { hubOrigin: ORIGIN });

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /no stored credential/);
  assert.deepEqual(filesUnder(t.cwd).filter((path) => !path.includes(`${'/source/'}`)), []);
  assert.equal(t.principalKeys?.calls.length, 0);
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

test('publish: a planted ref without a key record fails without minting or writing', async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keysDir = keysDirFor(t.home);
  const pointer = join(keysDir, `${keyRefHash(HUMAN_REF)}.ref`);
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  writeFileSync(pointer, canonicalKeyRef(HUMAN_REF), { mode: 0o600 });
  const before = filesUnder(t.cwd);

  const code = await mainAsync(['publish', source, '--output', output], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\\n'), /no author signing key/);
  assert.match(t.err.join('\\n'), /owenloop setup/);
  assert.equal(existsSync(join(keysDir, `${keyRefHash(HUMAN_REF)}.json`)), false);
  assert.deepEqual(filesUnder(t.cwd), before, 'missing key failed before packing or writing');
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(`${output}.dsse`), false);
  assert.equal(existsSync(`${output}.unsigned`), false);
  assert.equal(readFileSync(pointer, 'utf8'), canonicalKeyRef(HUMAN_REF));
});

test('publish: a deleted key record with a surviving ref fails without minting or writing', { skip: SSH_SKIP }, async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keys = new PrincipalKeyManager({ env: t.io.env });
  await keys.ensure(HUMAN_REF);
  const keysDir = keysDirFor(t.home);
  const record = join(keysDir, `${keyRefHash(HUMAN_REF)}.json`);
  const pointer = join(keysDir, `${keyRefHash(HUMAN_REF)}.ref`);
  const pointerText = readFileSync(pointer, 'utf8');
  rmSync(record);
  const before = filesUnder(t.cwd);

  const code = await mainAsync(['publish', source, '--output', output], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\\n'), /no author signing key/);
  assert.match(t.err.join('\\n'), /owenloop setup/);
  assert.equal(existsSync(record), false, 'publish did not recreate the deleted key record');
  assert.equal(readFileSync(pointer, 'utf8'), pointerText, 'publish did not alter the surviving pointer');
  assert.deepEqual(filesUnder(t.cwd), before, 'missing key failed before packing or writing');
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
  writeFileSync(`${output}.origin.dsse`, '{"stale":true}\n');

  const code = await mainAsync(['publish', source, '--unsigned', '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(existsSync(`${output}.dsse`), false);
  assert.equal(existsSync(`${output}.origin.dsse`), false);
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
  assert.equal(existsSync(`${output}.origin.dsse`), false);
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

test('publish --source writes a signed origin sidecar bound to the canonical bundle digest', { skip: SSH_SKIP }, async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keys = new PrincipalKeyManager({ env: t.io.env });
  const ensured = await keys.ensure(HUMAN_REF);

  const code = await mainAsync(['publish', source, '--source', JSON.stringify(GIT_SOURCE), '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(existsSync(`${output}.origin.dsse`), true);
  const result = JSON.parse(t.out.join('\n')) as Record<string, unknown>;
  assert.equal(result.origin, `${output}.origin.dsse`);

  const envelope = JSON.parse(readFileSync(`${output}.origin.dsse`, 'utf8')) as Record<string, unknown>;
  const signer = createSshSigner({
    namespace: DSSE_SSH_NAMESPACE,
    verify: { principal: 'owenloop-test-author', allowedSignersText: `owenloop-test-author ${ensured.publicKey.openSshPublicKey}\\n` },
  });
  try {
    const verified = await dsseVerifyOrigin(envelope, signer);
    const record = JSON.parse(verified.payloadBytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(record.digest, digestBundle(readFileSync(output)).digest);
    assert.equal(record.name, 'golden-bundle');
    assert.equal(record.version, '1.0.0');
    assert.deepEqual(record.source, GIT_SOURCE);
    assert.equal(record.attesterKeyId, ensured.publicKey.keyid);
    assert.equal(typeof record.timestamp, 'number');
  } finally {
    signer.dispose();
  }

  const originText = readFileSync(`${output}.origin.dsse`, 'utf8');
  assert.equal(originText.includes(t.home), false, 'private-key storage path must not appear in origin sidecar');
  assert.equal(originText.includes('PRIVATE'), false, 'private-key marker must not appear in origin sidecar');
});

test('publish --source uses the last repeated value and round-trips an agent source', { skip: SSH_SKIP }, async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keys = new PrincipalKeyManager({ env: t.io.env });
  const ensured = await keys.ensure(HUMAN_REF);

  const code = await mainAsync(
    [
      'publish',
      source,
      '--source',
      JSON.stringify(GIT_SOURCE),
      '--source',
      JSON.stringify(AGENT_SOURCE),
      '--output',
      output,
    ],
    t.io,
  );
  assert.equal(code, 0, t.err.join('\n'));

  const envelope = JSON.parse(readFileSync(`${output}.origin.dsse`, 'utf8')) as Record<string, unknown>;
  const signer = createSshSigner({
    namespace: DSSE_SSH_NAMESPACE,
    verify: { principal: 'owenloop-test-author', allowedSignersText: `owenloop-test-author ${ensured.publicKey.openSshPublicKey}\\n` },
  });
  try {
    const verified = await dsseVerifyOrigin(envelope, signer);
    const record = JSON.parse(verified.payloadBytes.toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(record.source, AGENT_SOURCE);
  } finally {
    signer.dispose();
  }
});

test('publish without --source removes a stale signed origin sidecar', { skip: SSH_SKIP }, async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keys = new PrincipalKeyManager({ env: t.io.env });
  await keys.ensure(HUMAN_REF);

  const first = await mainAsync(['publish', source, '--source', JSON.stringify(GIT_SOURCE), '--output', output], t.io);
  assert.equal(first, 0, t.err.join('\n'));
  assert.equal(existsSync(`${output}.origin.dsse`), true);

  const second = await mainAsync(['publish', source, '--output', output], t.io);
  assert.equal(second, 0, t.err.join('\n'));
  assert.equal(existsSync(`${output}.origin.dsse`), false);
  const result = JSON.parse(t.out.at(-1) ?? '{}') as Record<string, unknown>;
  assert.equal('origin' in result, false);
});

test('publish --source rejects --unsigned before writing or touching keys', async () => {
  const t = makeIo({ env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  const output = join(t.cwd, 'published.wnlp');

  const code = await mainAsync(
    ['publish', source, '--source', JSON.stringify(GIT_SOURCE), '--unsigned', '--output', output],
    t.io,
  );
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--source cannot be combined with --unsigned/);
  assert.deepEqual(filesUnder(t.cwd).filter((path) => !path.includes(`${'/source/'}`)), []);
  assert.deepEqual(filesUnder(t.home), []);
  assert.equal(t.principalKeys?.calls.length, 0);
});

test('publish rejects malformed --source values before key work or filesystem writes', async () => {
  const cases = [
    { value: '{', pattern: /invalid JSON/ },
    {
      value: JSON.stringify({ kind: 'future', value: 'not-supported' }),
      pattern: /--source does not match origin source schema/,
    },
    { value: JSON.stringify({ kind: 'git', repo: 'https://github.com/example/workflow' }), pattern: /--source does not match/ },
    {
      value: JSON.stringify({ kind: 'console', user: 'user_123' }),
      pattern: /--source kind "console" requires a client-side signing ceremony/,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
    const source = sourceFor(t);
    const output = join(t.cwd, `published-${index}.wnlp`);
    const code = await mainAsync(['publish', source, '--source', testCase.value, '--output', output], t.io);
    assert.equal(code, 1);
    assert.match(t.err.join('\n'), testCase.pattern);
    assert.deepEqual(filesUnder(t.cwd).filter((path) => !path.includes(`${'/source/'}`)), []);
    assert.deepEqual(filesUnder(t.home), []);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(`${output}.dsse`), false);
    assert.equal(existsSync(`${output}.origin.dsse`), false);
  }
});

test('tampering with source.commit invalidates the signed origin sidecar', { skip: SSH_SKIP }, async () => {
  const t = makeIo({ principalKeys: 'real', env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const source = sourceFor(t);
  bind(t);
  const output = join(t.cwd, 'published.wnlp');
  const keys = new PrincipalKeyManager({ env: t.io.env });
  const ensured = await keys.ensure(HUMAN_REF);
  const code = await mainAsync(['publish', source, '--source', JSON.stringify(GIT_SOURCE), '--output', output], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const envelope = JSON.parse(readFileSync(`${output}.origin.dsse`, 'utf8')) as {
    payload: string;
    payloadType: string;
    signatures: unknown[];
  };
  const payloadBytes = decodeBase64Strict(envelope.payload);
  const commitBytes = Buffer.from(GIT_SOURCE.commit, 'utf8');
  const commitOffset = payloadBytes.indexOf(commitBytes);
  assert.notEqual(commitOffset, -1, 'origin payload must contain the signed commit text');
  const tamperedPayload = Buffer.from(payloadBytes);
  tamperedPayload[commitOffset] = '1'.charCodeAt(0);
  const tampered = { ...envelope, payload: encodeBase64(tamperedPayload) };

  const signer = createSshSigner({
    namespace: DSSE_SSH_NAMESPACE,
    verify: { principal: 'owenloop-test-author', allowedSignersText: `owenloop-test-author ${ensured.publicKey.openSshPublicKey}\\n` },
  });
  try {
    await assert.rejects(dsseVerifyOrigin(tampered, signer), /DSSE verification failed/);
  } finally {
    signer.dispose();
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
  // Origin is a real sibling record type; keep this as the type-confusion probe.
  await assert.rejects(dsseVerifyPublication({ ...envelope, payloadType: 'application/vnd.owenloop.origin.v1+json' }, signer));
});
