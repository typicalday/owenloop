import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Engine } from '../../../src/engine.ts';
import { openStore } from '../../../src/store.ts';
import { parseConsume, parseProduce } from '../../../src/paths.ts';
import type { StepDef } from '../../../src/types.ts';
import { def, input, step as testStep } from '../../../test/helpers.ts';
import { bindTrustedReferenceV2 } from '../src/hosted/trusted-input-binding.ts';
import { createTrustedInputV2Admission } from '../src/hosted/trusted-input-admission.ts';
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
  bad(wire => { (wire.order as unknown as Record<string, unknown>).crews = 'builders'; });
  bad(wire => { (wire.order as unknown as Record<string, unknown>).escalated = false; });
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
  const extraAbsent = structuredClone(raw);
  extraAbsent.order.inputs.push('unconsumed-optional');
  extraAbsent.order.consumedFingerprint!['unconsumed-optional'] = 1;
  extraAbsent.inputs.push({ path: 'unconsumed-optional', version: 1, present: false });
  const extraGate = await bindTrustedReferenceV2({ response: parseTrustedReferenceV2(extraAbsent, expected) as TrustedReferenceV2,
    expected: { ...expected, defDigest: 'a'.repeat(64), step: 'planner', key: '' }, step,
    declaredInputs: [{ name: 'optional', producer: 'human', seedOwed: false },
      { name: 'unconsumed-optional', producer: 'human', seedOwed: false }], callsProducers: {},
    consumedVerifier: async order => ({ ok: true, order, warnings: [] }) });
  assert.deepEqual(extraGate, { ok: false, reason: 'order-structure-mismatch' });
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

test('v2 admission refuses forged private modifier and roster fields absent from direct Service witness', async () => {
  const direct = available();
  const step = { name: 'planner', consumes: [parseConsume('optional')], produces: [parseProduce('plan')] } as StepDef;
  const admission = createTrustedInputV2Admission({ reader: { read: async () => direct }, expected,
    instructions: { resolveCommand: async () => ({ ok: false, kind: 'unknown-step', reason: 'unused' }),
      resolveStep: async () => ({ ok: true, step }),
      resolveHostedStep: async () => ({ ok: true, step, inputNames: ['optional'],
	declaredInputs: [{ name: 'optional', producer: 'human', seedOwed: false }], callsProducers: {} }) },
    consumedVerifier: async order => ({ ok: true, order, warnings: [] }) });
  const privateOrder: typeof direct.order = { ...direct.order,
    owes: [{ path: 'plan', version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0 }] };
  assert.equal((await admission.observe(privateOrder)).ok, true);
  assert.deepEqual(await admission.observe({ ...privateOrder, modifier: 'deep' }),
    { ok: false, reason: 'private-order-v2-mismatch' });
  assert.deepEqual(await admission.observe({ ...privateOrder, capabilities: ['build'], crews: ['other'] }),
    { ok: false, reason: 'private-order-v2-mismatch' });
  assert.equal((await admission.observe({ ...privateOrder, consumesProof: '{"optional":"human-advisory"}' })).ok, true);
  assert.deepEqual(await admission.observe({ ...privateOrder, consumesProof: '{"producer":"forged"}' }),
    { ok: false, reason: 'private-order-producer-proof-mismatch' });
  assert.deepEqual(await admission.observe({ ...privateOrder, workdir: '/forged' }),
    { ok: false, reason: 'private-order-v2-mismatch' });
});

test('authoritative v2 offer admits a locally allowed modifier and exact Service roster', async () => {
  const direct = available();
  direct.order.capabilities = ['build:deep'];
  direct.order.crews = ['builders'];
  direct.order.modifier = 'deep';
  const local = { name: 'planner', consumes: [parseConsume('optional')], produces: [parseProduce('plan')],
    capabilities: ['build'], escalation: { after: 2, modifier: 'deep' } } as StepDef;
  const admission = createTrustedInputV2Admission({ reader: { read: async () => direct }, expected,
    instructions: { resolveCommand: async () => ({ ok: false, kind: 'unknown-step', reason: 'unused' }),
      resolveStep: async () => ({ ok: true, step: local }),
      resolveHostedStep: async () => ({ ok: true, step: local, inputNames: ['optional'],
	declaredInputs: [{ name: 'optional', producer: 'human', seedOwed: false }], callsProducers: {},
	allowedModifiers: ['deep'] }) },
    consumedVerifier: async order => ({ ok: true, order, warnings: [] }) });
  const privateOrder: typeof direct.order = { ...direct.order,
    owes: [{ path: 'plan', version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0 }] };
  assert.equal((await admission.observe(privateOrder)).ok, true);
  assert.deepEqual(await admission.observe({ ...privateOrder, crews: ['other'] }),
    { ok: false, reason: 'private-order-v2-mismatch' });
  direct.order.escalated = true;
  privateOrder.escalated = true;
  assert.equal((await admission.observe(privateOrder)).ok, true);
  direct.order.modifier = 'unknown';
  privateOrder.modifier = 'unknown';
  assert.deepEqual(await admission.observe(privateOrder),
    { ok: false, reason: 'local-offer-structure-mismatch' });
});

test('a real capability claim remains unsupported until Service v2 witnesses the offer', async () => {
  const definition = def('capability-v2', [input('proposal')],
    [testStep({ name: 'planner', consumes: ['proposal'], produces: ['plan'], capabilities: ['build'] })]);
  const store = openStore(':memory:');
  try {
    const engine = new Engine(store, () => definition);
    const workflow = engine.createInstance(definition.name);
    const privateOrder = engine.tick(workflow, { now: 0, capabilities: ['build'] }).orders[0]!;
    assert.deepEqual(privateOrder.capabilities, ['build']);
    const { capabilities: _unwitnessed, ...projected } = privateOrder;
    const admission = createTrustedInputV2Admission({
      reader: { read: async () => ({ protocol: 'trusted-reference-read-v2', state: 'available',
	workflow, run: privateOrder.run, order: projected, inputs: [], lease: { claimed: true } }) as TrustedReferenceV2 },
      expected: { workflow, run: privateOrder.run },
      instructions: { resolveCommand: async () => ({ ok: false, kind: 'unknown-step', reason: 'unused' }),
	resolveStep: async () => ({ ok: true, step: definition.steps[0]! }),
	resolveHostedStep: async () => ({ ok: true, step: definition.steps[0]!, inputNames: ['proposal'],
	  declaredInputs: definition.inputs, callsProducers: {} }) },
      consumedVerifier: async order => ({ ok: true, order, warnings: [] }),
    });
    assert.deepEqual(await admission.observe(privateOrder),
      { ok: false, reason: 'private-order-v2-mismatch' });
  } finally { store.close(); }
});
