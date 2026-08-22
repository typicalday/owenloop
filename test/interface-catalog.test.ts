/**
 * Hermetic coverage for `owenloop interface register|get|list`. These tests pin
 * the deployed catalog contract while keeping signature semantics entirely on
 * the fake hub side, as production does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { credentialFilePath, writeCredentialFile } from '../src/hub.ts';
import { kcHuman, makeIo, routedFetch, stallingFetch } from './hubkit.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';
const ROW = { name: 'evidence-report', version: '2.0.0', createdBy: 'user_1', createdAt: 1 };
const SIGNATURE = { inputs: [{ name: 'brief' }], outputs: [{ name: 'report' }] };

function seedHuman(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_human' }));
}

function writeSignature(t: ReturnType<typeof makeIo>, value: unknown = SIGNATURE, filename = 'signature.json'): string {
  const path = join(t.cwd, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  return filename;
}

function exactOk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { text: 'ok', ...ROW, signature: SIGNATURE, ...over };
}

function stdoutJson(t: ReturnType<typeof makeIo>): Record<string, unknown> {
  assert.equal(t.out.length, 1, 'one stdout document');
  return JSON.parse(t.out[0]!) as Record<string, unknown>;
}

test('interface register reads a relative signature file, POSTs the opaque value, and prints only the exact whitelisted document', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/register_interface': () => ({ status: 200, json: exactOk() }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);
  const file = writeSignature(t);

  const code = await mainAsync(['interface', 'register', ROW.name, ROW.version, '--signature', file, '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.method, 'POST');
  assert.equal(request.pathname, '/api/register_interface');
  assert.equal(request.authorization, 'Bearer mcpat_human');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body!), { name: ROW.name, version: ROW.version, signature: SIGNATURE });
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, ...ROW, signature: SIGNATURE });
  assert.equal(stdoutJson(t).text, undefined);
  assert.deepEqual(t.err, []);
});

test('interface register transmits a 56 KiB signature intact rather than relying on a shell argument', async () => {
  const large = { schema: 'x'.repeat(56 * 1024) };
  const { fetch, calls } = routedFetch({
    'POST /api/register_interface': () => ({ status: 200, json: exactOk({ signature: large }) }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);
  const file = writeSignature(t, large, 'interfaces/large.json');

  const code = await mainAsync(['interface', 'register', ROW.name, ROW.version, '--signature', file, '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(JSON.stringify(JSON.parse(calls[0]!.body!).signature).length, JSON.stringify(large).length);
  assert.deepEqual(JSON.parse(calls[0]!.body!).signature, large);
});

test('interface get encodes opaque name and version separately and returns the full signature', async () => {
  const { fetch, calls } = routedFetch({
    'GET /api/interfaces/evidence%2Freport%20v2/2.0%2F0': () => ({ status: 200, json: exactOk({ name: 'evidence/report v2', version: '2.0/0' }) }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);

  const code = await mainAsync(['interface', 'get', 'evidence/report v2', '2.0/0', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.pathname, '/api/interfaces/evidence%2Freport%20v2/2.0%2F0');
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    name: 'evidence/report v2',
    version: '2.0/0',
    signature: SIGNATURE,
    createdBy: ROW.createdBy,
    createdAt: ROW.createdAt,
  });
});

test('interface round-trips evidence-report@2.0.0 through register, get, and list', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/register_interface': () => ({ status: 200, json: exactOk() }),
    'GET /api/interfaces/evidence-report/2.0.0': () => ({ status: 200, json: exactOk() }),
    'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [ROW] } }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);
  const file = writeSignature(t);

  assert.equal(await mainAsync(['interface', 'register', ROW.name, ROW.version, '--signature', file, '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body!), { name: ROW.name, version: ROW.version, signature: SIGNATURE });
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, ...ROW, signature: SIGNATURE });
  t.out.length = 0;

  assert.equal(await mainAsync(['interface', 'get', ROW.name, ROW.version, '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.equal(calls[1]!.pathname, '/api/interfaces/evidence-report/2.0.0');
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, ...ROW, signature: SIGNATURE });
  t.out.length = 0;

  assert.equal(await mainAsync(['interface', 'list', '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.equal(calls[2]!.pathname, '/api/interfaces');
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, interfaces: [ROW] });
});

test('interface list preserves wire order, omits signature bodies, and accepts an empty catalog', async () => {
  const rows = [ROW, { name: 'zeta', version: '1', createdBy: 'user_2', createdAt: 2, signature: { mustNotPrint: true } }];
  const { fetch, calls } = routedFetch({
    'GET /api/interfaces': () => ({ status: 200, json: { text: 'ignored', interfaces: rows } }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);

  assert.equal(await mainAsync(['interface', 'list', '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.authorization, 'Bearer mcpat_human');
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, interfaces: [ROW, { name: 'zeta', version: '1', createdBy: 'user_2', createdAt: 2 }] });

  const empty = routedFetch({ 'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [] } }) });
  const tEmpty = makeIo({ fetch: empty.fetch });
  seedHuman(tEmpty);
  assert.equal(await mainAsync(['interface', 'list', '--hub', HUB], tEmpty.io), 0, tEmpty.err.join('\n'));
  assert.deepEqual(stdoutJson(tEmpty), { ok: true, hub: ORIGIN, interfaces: [] });
});

test('interface register delegates semantic validation to the hub and preserves typed refusal messages', async () => {
  const cases: [number, string][] = [
    [400, 'signature outputs must be declared'],
    [400, 'interface evidence-report@2.0.0 already exists'],
    [403, 'admin role required'],
  ];
  for (const [status, message] of cases) {
    const { fetch } = routedFetch({
      'POST /api/register_interface': () => ({ status, json: { error: status === 403 ? 'forbidden' : 'interface_catalog_input_invalid', message } }),
    });
    const t = makeIo({ fetch });
    seedHuman(t);
    const file = writeSignature(t, { validJsonButHubRejects: true });
    const code = await mainAsync(['interface', 'register', ROW.name, ROW.version, '--signature', file, '--hub', HUB], t.io);
    assert.equal(code, 1);
    assert.match(t.err.join('\n'), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(t.out, []);
  }

  const missing = routedFetch({
    'GET /api/interfaces/missing/1': () => ({ status: 404, json: { error: 'interface_catalog_not_found', message: 'interface missing@1 was not found' } }),
  });
  const tMissing = makeIo({ fetch: missing.fetch });
  seedHuman(tMissing);
  assert.equal(await mainAsync(['interface', 'get', 'missing', '1', '--hub', HUB], tMissing.io), 1);
  assert.match(tMissing.err.join('\n'), /interface missing@1 was not found/);
  assert.deepEqual(tMissing.out, []);
});

test('interface commands use a human credential and give the exact exit-3 remedy for absent or rejected credentials', async () => {
  for (const argv of [
    ['interface', 'register', ROW.name, ROW.version, '--signature', 'signature.json', '--hub', HUB],
    ['interface', 'get', ROW.name, ROW.version, '--hub', HUB],
    ['interface', 'list', '--hub', HUB],
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/register_interface': () => ({ status: 200, json: exactOk() }),
      [`GET /api/interfaces/${ROW.name}/${ROW.version}`]: () => ({ status: 200, json: exactOk() }),
      'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [] } }),
    });
    const t = makeIo({ fetch });
    if (argv[1] === 'register') writeSignature(t);
    assert.equal(await mainAsync(argv, t.io), 3);
    assert.match(t.err.join('\n'), /run: owenloop login --hub http:\/\/127\.0\.0\.1:9/);
    assert.equal(calls.length, 0);
  }

  const rejected = routedFetch({
    'GET /api/interfaces': () => ({ status: 401, json: { error: 'unauthorized' } }),
  });
  const tRejected = makeIo({ fetch: rejected.fetch });
  seedHuman(tRejected);
  assert.equal(await mainAsync(['interface', 'list', '--hub', HUB], tRejected.io), 3);
  assert.match(tRejected.err.join('\n'), /credential rejected/);
  assert.match(tRejected.err.join('\n'), /owenloop login --hub http:\/\/127\.0\.0\.1:9/);
});

test('interface validates every subcommand-specific argument and signature file before credential or network work', async () => {
  const badArgv = [
    ['interface'],
    ['interface', 'wat'],
    ['interface', 'register'],
    ['interface', 'register', 'name'],
    ['interface', 'register', 'name', '1'],
    ['interface', 'register', 'name', '1', '--signature', ''],
    ['interface', 'register', 'name', '1', '--signature', 'a', '--signature', 'b'],
    ['interface', 'get', 'name'],
    ['interface', 'get', 'name', '1', 'extra'],
    ['interface', 'get', 'name', '1', '--signature', 'a'],
    ['interface', 'list', 'extra'],
    ['interface', 'list', '--signature', 'a'],
    ['interface', 'list', '--bogus', 'a'],
  ];
  for (const argv of badArgv) {
    const { fetch, calls } = routedFetch({ 'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [] } }) });
    const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 1, JSON.stringify(argv));
    assert.equal(calls.length, 0, JSON.stringify(argv));
  }

  const { fetch, calls } = routedFetch({ 'POST /api/register_interface': () => ({ status: 200, json: exactOk() }) });
  const t = makeIo({ fetch });
  seedHuman(t);
  assert.equal(await mainAsync(['interface', 'register', 'name', '1', '--signature', 'missing.json', '--hub', HUB], t.io), 1);
  assert.match(t.err.join('\n'), /cannot read interface signature file/);
  assert.equal(calls.length, 0);
  writeFileSync(join(t.cwd, 'invalid.json'), '{ not valid JSON');
  assert.equal(await mainAsync(['interface', 'register', 'name', '1', '--signature', 'invalid.json', '--hub', HUB], t.io), 1);
  assert.match(t.err.join('\n'), /interface signature file is not valid JSON/);
  assert.equal(calls.length, 0);
});

test('interface malformed responses are fixed field-only errors and invalid JSON never leaks parser text', async () => {
  const malformedExact = routedFetch({
    'GET /api/interfaces/evidence-report/2.0.0': () => ({ status: 200, json: { signature: SIGNATURE, version: '2.0.0', createdBy: 'user', createdAt: 1 } }),
  });
  const tExact = makeIo({ fetch: malformedExact.fetch });
  seedHuman(tExact);
  assert.equal(await mainAsync(['interface', 'get', ROW.name, ROW.version, '--hub', HUB], tExact.io), 1);
  assert.match(tExact.err.join('\n'), /interfaces: malformed response — response missing non-empty string name/);
  assert.doesNotMatch(tExact.err.join('\n'), /evidence-report/);
  assert.deepEqual(tExact.out, []);

  const malformedList = routedFetch({
    'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [{ ...ROW, createdAt: 'bad' }] } }),
  });
  const tList = makeIo({ fetch: malformedList.fetch });
  seedHuman(tList);
  assert.equal(await mainAsync(['interface', 'list', '--hub', HUB], tList.io), 1);
  assert.match(tList.err.join('\n'), /interfaces: malformed response — interfaces\[0\] missing number createdAt/);

  const raw = routedFetch({
    'GET /api/interfaces': () => ({ status: 200, raw: 'unexpected raw payload' }),
  });
  const tRaw = makeIo({ fetch: raw.fetch });
  seedHuman(tRaw);
  assert.equal(await mainAsync(['interface', 'list', '--hub', HUB], tRaw.io), 1);
  assert.match(tRaw.err.join('\n'), /interfaces: malformed success response — body is not valid JSON/);
  assert.doesNotMatch(tRaw.err.join('\n'), /Unexpected token/);
});

test('interface resolves no or multiple hub safely before network and has no help side effects', async () => {
  const noHub = routedFetch({ 'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [] } }) });
  const tNoHub = makeIo({ fetch: noHub.fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  assert.equal(await mainAsync(['interface', 'list'], tNoHub.io), 2);
  assert.match(tNoHub.err.join('\n'), /manage interfaces on/);
  assert.equal(noHub.calls.length, 0);

  const multiple = routedFetch({ 'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [] } }) });
  const tMultiple = makeIo({ fetch: multiple.fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(tMultiple.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'b' } },
    },
  });
  assert.equal(await mainAsync(['interface', 'list'], tMultiple.io), 2);
  assert.match(tMultiple.err.join('\n'), /stored hubs: https:\/\/a\.example, https:\/\/b\.example/);
  assert.equal(multiple.calls.length, 0);

  const help = routedFetch({ 'POST /api/register_interface': () => ({ status: 200, json: exactOk() }) });
  const tHelp = makeIo({ fetch: help.fetch });
  assert.equal(await mainAsync(['interface', 'register', '--help'], tHelp.io), 0);
  assert.match(tHelp.out.join('\n'), /interface register <name> <version> --signature <file>/);
  assert.equal(help.calls.length, 0);
});

test('interface permits OWENLOOP_CREDENTIAL_COMMAND for register, get, and list without a local credential write', async () => {
  for (const argv of [
    ['interface', 'register', ROW.name, ROW.version, '--signature', 'signature.json'],
    ['interface', 'get', ROW.name, ROW.version],
    ['interface', 'list'],
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/register_interface': () => ({ status: 200, json: exactOk() }),
      'GET /api/interfaces/evidence-report/2.0.0': () => ({ status: 200, json: exactOk() }),
      'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [] } }),
    });
    const t = makeIo({ fetch });
    const helper = join(t.cwd, 'credential-helper.mjs');
    writeFileSync(helper, `process.stdout.write('${JSON.stringify({ kind: 'oauth-pasted', accessToken: 'from-command' })}');`);
    t.io.env.OWENLOOP_CREDENTIAL_COMMAND = `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`;
    if (argv[1] === 'register') writeSignature(t);
    assert.equal(await mainAsync([...argv, '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.equal(calls[0]!.authorization, 'Bearer from-command');
    assert.equal(t.store.size, 0, 'the command did not write a local credential');
  }
});

test('interface uses shared timeout and redirect-refusing hub transport for all three routes', async () => {
  const signatureRoutes = { 'POST /api/register_interface': () => ({ status: 200, json: exactOk() }) };
  const stalled = stallingFetch(signatureRoutes, ['POST /api/register_interface']);
  const tStalled = makeIo({ fetch: stalled.fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHuman(tStalled);
  const file = writeSignature(tStalled);
  assert.equal(await mainAsync(['interface', 'register', ROW.name, ROW.version, '--signature', file, '--hub', HUB], tStalled.io), 1);
  assert.match(tStalled.err.join('\n'), /did not respond within/);

  for (const [argv, path] of [
    [['interface', 'register', ROW.name, ROW.version, '--signature', 'signature.json'], '/api/register_interface'],
    [['interface', 'get', ROW.name, ROW.version], '/api/interfaces/evidence-report/2.0.0'],
    [['interface', 'list'], '/api/interfaces'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'POST /api/register_interface': () => ({ status: 200, json: exactOk() }),
      'GET /api/interfaces/evidence-report/2.0.0': () => ({ status: 200, json: exactOk() }),
      'GET /api/interfaces': () => ({ status: 200, json: { interfaces: [] } }),
    });
    const t = makeIo({ fetch });
    seedHuman(t);
    if (argv[1] === 'register') writeSignature(t);
    assert.equal(await mainAsync([...argv, '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.equal(calls[0]!.pathname, path);
    assert.equal(calls[0]!.redirect, 'error');
  }
});
