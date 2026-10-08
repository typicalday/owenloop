import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseConsume, parseProduce } from '../../../src/paths.ts';
import type { StepDef } from '../../../src/types.ts';
import { bindTrustedReferenceV2 } from '../src/hosted/trusted-input-binding.ts';
import { createTrustedReferenceV2Reader, parseTrustedReferenceV2 } from '../src/hosted/trusted-reference-v2.ts';
import type { TrustedReferenceV2 } from '../src/hosted/trusted-reference-v2.ts';

const expected = { workflow: 'wf_example', run: 'run_example' };
const available = (): TrustedReferenceV2 => ({ protocol: 'trusted-reference-read-v2', state: 'available', ...expected,
  order: { ...expected, step: 'planner', key: '', defDigest: 'a'.repeat(64), inputs: ['optional'], outputs: ['plan'],
    consumes: {}, consumedFingerprint: { optional: 1 }, owes: [{ path: 'plan', version: 1 }] },
  inputs: [{ path: 'optional', version: 1, present: false }], lease: { claimed: true } }) as unknown as TrustedReferenceV2;

test('strict v2 parser preserves absent witness and refuses malformed authority', () => {
  assert.deepEqual(parseTrustedReferenceV2(available(), expected), available());
  const bad = (change: (wire: ReturnType<typeof available>) => void) => {
    const wire = structuredClone(available());
    change(wire);
    assert.throws(() => parseTrustedReferenceV2(wire, expected));
  };
  bad(wire => { wire.inputs[0]!.present = true; });
  bad(wire => { wire.order.consumedFingerprint!.optional = 2; });
  bad(wire => { (wire.lease as { claimed: boolean }).claimed = false; });
  bad(wire => { wire.order.defDigest = 'wrong'; });
  bad(wire => { wire.order.inputs.push('unknown'); });
  assert.throws(() => parseTrustedReferenceV2({ ...available(), protocol: 'trusted-reference-read-v1' }, expected));
  assert.throws(() => parseTrustedReferenceV2({ ...available(), extra: true }, expected));
  assert.deepEqual(parseTrustedReferenceV2({ protocol: 'trusted-reference-read-v2', state: 'unavailable', ...expected }, expected),
    { protocol: 'trusted-reference-read-v2', state: 'unavailable', ...expected });
});

test('worker-owned HTTPS POST binds bearer/body, refuses redirect, old Service, and non-no-store response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trusted-v2-https-'));
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert],
    { stdio: 'ignore' });
    let status = 200;
    let cache = 'no-store';
    let wire: unknown = available();
    let calls = 0;
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      calls++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      assert.equal(req.url, '/api/reference_order/v2');
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer worker-secret');
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), expected);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': cache,
	...(status === 302 ? { location: 'https://elsewhere.example/steal' } : {}) });
      res.end(JSON.stringify(wire));
    });
    await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const reader = createTrustedReferenceV2Reader({ origin: `https://localhost:${address.port}`,
	expected, getToken: async () => 'worker-secret', trustedCa: readFileSync(cert) });
      assert.deepEqual(await reader.read(), available());
      status = 302;
      await assert.rejects(reader.read());
      assert.equal(calls, 2, 'redirect target must never receive the bearer');
      status = 404;
      await assert.rejects(reader.read());
      status = 200;
      wire = { ...available(), protocol: 'trusted-reference-read-v1' };
      await assert.rejects(reader.read());
      wire = available();
      cache = 'max-age=60';
      await assert.rejects(reader.read());
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v2 reader construction refuses plaintext, credential-bearing origins, and unbound ids', () => {
  for (const origin of ['http://hub.example', 'https://token@hub.example', 'https://hub.example/path']) {
    assert.throws(() => createTrustedReferenceV2Reader({ origin, expected, getToken: async () => 'secret' }));
  }
  assert.throws(() => createTrustedReferenceV2Reader({ origin: 'https://hub.example',
    expected: { workflow: 'wf', run: '' }, getToken: async () => 'secret' }));
});

test('local v2 gate admits optional absence/present human input while keeping producer proof scope exact', async () => {
  const step = { name: 'planner', consumes: [parseConsume('optional'), parseConsume('produced')],
    produces: [parseProduce('plan')], on: ['inputsGreen'] } as StepDef;
  const raw = available();
  raw.order.inputs.push('produced');
  raw.order.consumedFingerprint!.produced = 2;
  raw.order.consumes = { produced: { answer: 42 } };
  raw.order.consumesProof = JSON.stringify({ produced: 'signed-envelope' });
  raw.inputs.push({ path: 'produced', version: 2, present: true, value: { answer: 42 } });
  let verified = 0;
  const gate = (response: TrustedReferenceV2) => bindTrustedReferenceV2({ response,
    expected: { ...expected, defDigest: 'a'.repeat(64), step: 'planner', key: '' }, step,
    declaredInputs: [{ name: 'optional', producer: 'human', seedOwed: false }], callsProducers: {},
    consumedVerifier: async order => {
      verified++;
      assert.deepEqual(order.consumes, { produced: { answer: 42 } });
      assert.deepEqual(order.consumedFingerprint, { produced: 2 });
      assert.deepEqual(JSON.parse(order.consumesProof!), { produced: 'signed-envelope' });
      return { ok: true, order, warnings: [] };
    },
  });
  assert.equal((await gate(parseTrustedReferenceV2(raw, expected) as TrustedReferenceV2)).ok, true);
  const present = structuredClone(raw);
  present.inputs[0] = { path: 'optional', version: 1, present: true, value: { choice: 'human' } };
  present.order.consumes.optional = { choice: 'human' };
  assert.equal((await gate(parseTrustedReferenceV2(present, expected) as TrustedReferenceV2)).ok, true);
  assert.equal(verified, 2);
  const advisory = structuredClone(present);
  advisory.order.consumesProof = JSON.stringify({ produced: 'signed-envelope', optional: 'human-advisory' });
  assert.deepEqual(await gate(parseTrustedReferenceV2(advisory, expected) as TrustedReferenceV2),
    { ok: false, reason: 'producer-proof-map-mismatch' });
  assert.equal(verified, 2);
  const changed = structuredClone(present);
  changed.inputs[0]!.value = { choice: 'forged' };
  assert.deepEqual(await gate(parseTrustedReferenceV2(changed, expected) as TrustedReferenceV2),
    { ok: false, reason: 'witness-value-mismatch' });
});

test('local v2 gate retains map/cause structure and unconsumed dotted cwd source', async () => {
  const base = available();
  const step = { name: 'planner', consumes: [parseConsume('optional')], produces: [parseProduce('plan')],
    workdirFrom: 'settings.env.cwd', on: ['inputsGreen'] } as StepDef;
  const declaredInputs = [{ name: 'optional', producer: 'human', seedOwed: false },
    { name: 'settings', producer: 'human', seedOwed: false }];
  base.order.workdir = '/tmp/allowed';
  base.workdirInput = { stem: 'settings', version: 3, value: { env: { cwd: '/tmp/allowed' } } };
  const gate = (raw: unknown) => bindTrustedReferenceV2({ response: parseTrustedReferenceV2(raw, expected) as TrustedReferenceV2,
    expected: { ...expected, defDigest: 'a'.repeat(64), step: 'planner', key: '' }, step, declaredInputs,
    consumedVerifier: async order => ({ ok: true, order, warnings: [] }), callsProducers: {} });
  assert.equal((await gate(base)).ok, true);
  const moved = structuredClone(base);
  moved.workdirInput = { stem: 'settings', version: 4, value: { env: { cwd: '/tmp/elsewhere' } } };
  assert.deepEqual(await gate(moved), { ok: false, reason: 'workdir-value-mismatch' });
  const absent = structuredClone(base);
  absent.workdirInput = undefined;
  assert.deepEqual(await gate(absent), { ok: false, reason: 'workdir-witness-mismatch' });
  const wrongCause = structuredClone(base);
  wrongCause.order.cause = 'idle';
  assert.deepEqual(await gate(wrongCause), { ok: false, reason: 'order-structure-mismatch' });
  const mapStep = { ...step, consumes: [parseConsume('rows[$i]')], workdirFrom: undefined } as StepDef;
  const mapOrder = structuredClone(base);
  mapOrder.order.inputs = ['rows[2]'];
  mapOrder.order.consumedFingerprint = { 'rows[2]': 2 };
  mapOrder.order.consumes = { 'rows[2]': { value: 1 } };
  mapOrder.inputs = [{ path: 'rows[2]', version: 2, present: true, value: { value: 1 } }];
  mapOrder.order.workdir = undefined;
  mapOrder.workdirInput = undefined;
  assert.equal((await bindTrustedReferenceV2({ response: parseTrustedReferenceV2(mapOrder, expected) as TrustedReferenceV2,
    expected: { ...expected, defDigest: 'a'.repeat(64), step: 'planner', key: '' }, step: mapStep,
    declaredInputs: [], consumedVerifier: async order => ({ ok: true, order, warnings: [] }), callsProducers: {} })).ok, false);
});
