import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';

import { dsseVerifySubmission } from '../../../src/crypto/index.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { resetSshKeygenProbe } from '../../../src/crypto/ssh.ts';
import type { SshProcessAdapter } from '../../../src/crypto/ssh.ts';
import { createHoldMcp } from '../src/hold/mcp.ts';
import type { SubmissionKeyManager } from '../src/submit-proof.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';
import type { ToolCallContext, ToolRegistration } from '../src/mcp/server.ts';

// ---- fakes ------------------------------------------------------------------

interface Call {
  verb: string;
  arg?: unknown;
}

interface HubCfg {
  getOrder?: GetOrderResponse | Error;
  submit?: { outcome?: string; closed?: boolean } | Error | Array<{ outcome?: string; closed?: boolean } | Error>;
  reject?: { ok?: boolean; closed?: boolean } | Error;
}

const PUB_TEXT = readFileSync(new URL('../../../test/fixtures/crypto/fixture-key.pub', import.meta.url), 'utf8');
const PUBLIC_KEY = publicKeyDescriptor(PUB_TEXT);
const SIGNING_REF = { origin: 'https://hub.example.test', kind: 'machine' as const, id: 'local' };
const ARMOR = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';

function signingKeys(path = '/fake/private-key'): SubmissionKeyManager {
  return {
    resolveRef: () => SIGNING_REF,
    inspect: async () => ({ exists: true, source: 'generated', backend: 'file', publicKey: PUBLIC_KEY }),
    withSigningKey: async (_ref, callback) => callback(path),
  };
}

function fakeSshProcess(): SshProcessAdapter {
  return {
    probe: () => ({ status: 255, stderr: Buffer.from('No principal matched\\n') }),
    async run(_cmd, args) {
      const stdout = args[0] === '-y' && args[1] === '-f' ? PUB_TEXT : ARMOR;
      return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
    },
  };
}

afterEach(() => {
  resetSshKeygenProbe();
});

function mockHub(cfg: HubCfg): { hub: HubClient; calls: Call[] } {
  const calls: Call[] = [];
  let submitIdx = 0;
  const hub = {
    async getOrder(req: unknown) {
      calls.push({ verb: 'get_order', arg: req });
      const r = cfg.getOrder ?? { text: '', workflow: 'wf1', run: 'run1', order: null, lease: { claimed: true } };
      if (r instanceof Error) throw r;
      return r;
    },
    async submit(req: unknown) {
      calls.push({ verb: 'submit', arg: req });
      const configured = cfg.submit ?? { outcome: 'accepted' };
      const s = Array.isArray(configured)
	? configured[Math.min(submitIdx++, configured.length - 1)]!
	: configured;
      if (s instanceof Error) throw s;
      return { text: 'ok', outcome: s.outcome, closed: s.closed };
    },
    async reject(req: unknown) {
      calls.push({ verb: 'reject', arg: req });
      const s = cfg.reject ?? { ok: true };
      if (s instanceof Error) throw s;
      return { text: 'ok', ok: s.ok ?? true, closed: s.closed };
    },
    async heartbeat() {
      return { text: '' };
    },
    async release() {
      return { text: '' };
    },
  } as unknown as HubClient;
  return { hub, calls };
}

const ctx: ToolCallContext = { cancelled: false, onCancel: () => {}, sendProgress: () => {} };

function deps(hub: HubClient, extra: Partial<Parameters<typeof createHoldMcp>[0]> = {}) {
  return { hub, workflow: 'wf1', run: 'run1', sleep: async () => {}, now: () => 0, err: () => {}, ...extra };
}

function tool(tools: ToolRegistration[], name: string): ToolRegistration {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t!;
}

function parse(res: { content: Array<{ text: string }> }): ReturnType<typeof JSON.parse> {
  return JSON.parse(res.content[0]!.text);
}

function producerOrderResponse(): GetOrderResponse {
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: {
      run: 'run1',
      workflow: 'wf1',
      step: 'producer',
      key: '',
      defDigest: 'def-digest',
      inputs: [],
      outputs: ['result'],
      consumes: {},
      consumedFingerprint: {},
      owes: [{ path: 'result', version: 4, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    },
    lease: { claimed: true },
  };
}

// ---- shape ------------------------------------------------------------------

test('the mount exposes exactly get_order, reject, and submit, plus the lease loop', () => {
  const { hub } = mockHub({});
  const mount = createHoldMcp(deps(hub));
  assert.deepEqual(mount.tools.map((t) => t.name).sort(), ['get_order', 'reject', 'submit']);
  const reject = tool(mount.tools, 'reject');
  assert.deepEqual(reject.inputSchema, {
    type: 'object',
    required: ['path', 'text'],
    properties: {
      path: { type: 'string', description: 'The consumed artifact path to reject.' },
      text: { type: 'string', description: 'The reason for rejecting the artifact.' },
    },
    additionalProperties: false,
  });
  assert.equal(typeof mount.loop.run, 'function');
  assert.equal(typeof mount.loop.stop, 'function');
});

test('a positive restricted selection exposes exactly get_order and submit', () => {
  const { hub } = mockHub({});
  const mount = createHoldMcp(deps(hub, { tools: ['get_order', 'submit'] }));
  assert.deepEqual(mount.tools.map((t) => t.name), ['get_order', 'submit']);
});

// ---- get_order --------------------------------------------------------------

test('get_order (no first contact yet) live-fetches for the bound run and returns a lean view', async () => {
  const { hub, calls } = mockHub({
    getOrder: { text: 'here', workflow: 'wf1', run: 'run1', order: null, lease: { claimed: true } },
  });
  const mount = createHoldMcp(deps(hub, { holder: { kind: 'session', id: 's-1' } }));
  const res = await tool(mount.tools, 'get_order').handler({}, ctx);
  const body = parse(res);
  assert.deepEqual(body, { workflow: 'wf1', run: 'run1', order: null, text: 'here' });
  // The bound run + holder rode the fetch; ids never came from the model.
  assert.deepEqual(calls, [{ verb: 'get_order', arg: { workflow: 'wf1', run: 'run1', holder: { kind: 'session', id: 's-1' } } }]);
});

test('get_order surfaces a hub failure as an isError result', async () => {
  const { hub } = mockHub({ getOrder: new Error('offline') });
  const mount = createHoldMcp(deps(hub));
  const res = await tool(mount.tools, 'get_order').handler({}, ctx);
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(parse(res).error, /offline/);
});

// ---- submit -----------------------------------------------------------------

test('submit posts a receipt for the bound run and echoes the outcome', async () => {
  const { hub, calls } = mockHub({ submit: { outcome: 'accepted', closed: false } });
  const mount = createHoldMcp(deps(hub));
  const res = await tool(mount.tools, 'submit').handler({ path: 'pr', value: { url: 'x' }, done: false }, ctx);
  const body = parse(res);
  assert.equal(body.outcome, 'accepted');
  assert.equal(body.closed, false);
  assert.deepEqual(calls, [
    { verb: 'get_order', arg: { workflow: 'wf1', run: 'run1' } },
    { verb: 'submit', arg: { workflow: 'wf1', run: 'run1', path: 'pr', value: { url: 'x' }, done: false } },
  ]);
});

test('hold-MCP judge submit attaches a DSSE proof for the fingerprinted artifact version', async () => {
  const orderResponse: GetOrderResponse = {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: {
      run: 'run1',
      workflow: 'wf1',
      step: 'judge-result',
      key: 'k',
      defDigest: 'def-digest',
      inputs: ['result'],
      outputs: [],
      judge: 'result',
      consumes: { result: { value: 'seen' } },
      consumedFingerprint: { result: 2 },
      owes: [],
    },
    lease: { claimed: true },
  };
  const { hub, calls } = mockHub({ getOrder: orderResponse, submit: { outcome: 'accepted', closed: false } });
  const mount = createHoldMcp(deps(hub, {
    origin: 'https://hub.example.test',
    principalKeys: signingKeys(),
    sshProcess: fakeSshProcess(),
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
  }));
  await tool(mount.tools, 'submit').handler({ path: 'result', value: { answer: 42 } }, ctx);
  const req = calls.find((call) => call.verb === 'submit')!.arg as { proof?: string };
  assert.ok(req.proof !== undefined);
  const verified = await dsseVerifySubmission(JSON.parse(req.proof), {
    async verify(_bytes, signature) {
      return signature.toString('utf8') === ARMOR
        ? { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const }
        : null;
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as {
    produced: Array<{ artifact: string }>;
    consumedFingerprint: Record<string, number>;
  };
  assert.equal(record.produced[0]!.artifact, 'result');
  assert.deepEqual(record.consumedFingerprint, { result: 2 });
});

test('hold-MCP repeated judge approval signs the same fingerprinted version', async () => {
  const orderResponse: GetOrderResponse = {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: {
      run: 'run1',
      workflow: 'wf1',
      step: 'judge-result',
      key: '',
      defDigest: 'def-digest',
      inputs: ['result'],
      outputs: [],
      judge: 'result',
      consumes: { result: { draft: 1 } },
      consumedFingerprint: { result: 7 },
      owes: [],
    },
    lease: { claimed: true },
  };
  const { hub, calls } = mockHub({ getOrder: orderResponse, submit: { outcome: 'green', closed: false } });
  const mount = createHoldMcp(deps(hub, {
    origin: 'https://hub.example.test',
    principalKeys: signingKeys(),
    sshProcess: fakeSshProcess(),
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
  }));
  const submit = tool(mount.tools, 'submit');
  await submit.handler({ path: 'result', value: { approved: true } }, ctx);
  await submit.handler({ path: 'result', value: { approved: true } }, ctx);

  const proofs = calls
    .filter((call) => call.verb === 'submit')
    .map((call) => (call.arg as { proof?: string }).proof);
  const versions: number[] = [];
  for (const proof of proofs) {
    assert.ok(proof !== undefined);
    const verified = await dsseVerifySubmission(JSON.parse(proof), {
      async verify() {
	return { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const };
      },
    });
    const record = JSON.parse(verified.payloadBytes.toString('utf8')) as { produced: Array<{ version: number }> };
    versions.push(record.produced[0]!.version);
  }
  assert.deepEqual(versions, [7, 7]);
});

test('hold-MCP producer retry after a lost response remains unsigned instead of guessing the next version', async () => {
  const { hub, calls } = mockHub({
    getOrder: producerOrderResponse(),
    submit: [new Error('response lost'), { outcome: 'green', closed: false }],
  });
  const mount = createHoldMcp(deps(hub, {
    origin: 'https://hub.example.test',
    principalKeys: signingKeys(),
    sshProcess: fakeSshProcess(),
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
  }));
  const submit = tool(mount.tools, 'submit');

  const first = await submit.handler({ path: 'result', value: { draft: 1 } }, ctx);
  assert.equal((first as { isError?: boolean }).isError, true);
  const second = await submit.handler({ path: 'result', value: { draft: 1 } }, ctx);
  assert.equal(parse(second).outcome, 'green');

  const requests = calls.filter((call) => call.verb === 'submit').map((call) => call.arg as { proof?: string });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.proof === undefined));
});

test('hold-MCP unsigned producer commit is not signed later from the same stale claim packet', async () => {
  let keyAvailable = false;
  const keys: SubmissionKeyManager = {
    ...signingKeys(),
    resolveRef: () => keyAvailable ? SIGNING_REF : null,
  };
  const { hub, calls } = mockHub({ getOrder: producerOrderResponse(), submit: { outcome: 'green', closed: false } });
  const mount = createHoldMcp(deps(hub, {
    origin: 'https://hub.example.test',
    principalKeys: keys,
    sshProcess: fakeSshProcess(),
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
  }));
  const submit = tool(mount.tools, 'submit');

  await submit.handler({ path: 'result', value: { draft: 1 } }, ctx);
  keyAvailable = true;
  await submit.handler({ path: 'result', value: { draft: 2 } }, ctx);

  const requests = calls.filter((call) => call.verb === 'submit').map((call) => call.arg as { proof?: string });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.proof === undefined));
});

test('hold-MCP restart does not turn immutable producer claim metadata into version authority', async () => {
  const { hub, calls } = mockHub({ getOrder: producerOrderResponse(), submit: { outcome: 'green', closed: false } });
  const signingDeps = {
    origin: 'https://hub.example.test',
    principalKeys: signingKeys(),
    sshProcess: fakeSshProcess(),
    consumedVerifier: async (order: NonNullable<GetOrderResponse['order']>) => ({ ok: true as const, order, warnings: [] }),
  };

  const firstProcess = createHoldMcp(deps(hub, signingDeps));
  await tool(firstProcess.tools, 'submit').handler({ path: 'result', value: { draft: 1 } }, ctx);
  const restartedProcess = createHoldMcp(deps(hub, signingDeps));
  await tool(restartedProcess.tools, 'submit').handler({ path: 'result', value: { draft: 2 } }, ctx);

  const requests = calls.filter((call) => call.verb === 'submit').map((call) => call.arg as { proof?: string });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.proof === undefined));
});

// W7/D4: when the bound holder is known, submit carries it through unchanged
// so the hub's attribution columns get filled.
test('submit carries the bound holder through to the hub', async () => {
  const { hub, calls } = mockHub({ submit: { outcome: 'accepted', closed: false } });
  const mount = createHoldMcp(deps(hub, { holder: { kind: 'session', id: 's-1', shiftId: 'shf_1' } }));
  await tool(mount.tools, 'submit').handler({ path: 'pr', value: { url: 'x' }, done: false }, ctx);
  assert.deepEqual(calls, [
    {
      verb: 'get_order',
      arg: { workflow: 'wf1', run: 'run1', holder: { kind: 'session', id: 's-1', shiftId: 'shf_1' } },
    },
    {
      verb: 'submit',
      arg: { workflow: 'wf1', run: 'run1', path: 'pr', value: { url: 'x' }, done: false, holder: { kind: 'session', id: 's-1', shiftId: 'shf_1' } },
    },
  ]);
});

test('a CLOSED submit stops the lease loop without releasing (the claim is already gone)', async () => {
  const { hub } = mockHub({ submit: { outcome: 'green', closed: true } });
  const mount = createHoldMcp(deps(hub));
  const stops: Array<{ reason?: string; opts?: unknown }> = [];
  const realStop = mount.loop.stop;
  mount.loop.stop = ((reason?: string, opts?: unknown) => {
    stops.push({ reason, opts });
    return realStop.call(mount.loop, reason as never, opts as never);
  }) as typeof mount.loop.stop;

  await tool(mount.tools, 'submit').handler({ path: 'pr', value: 1, done: true }, ctx);
  assert.equal(stops.length, 1);
  assert.equal(stops[0]!.reason, 'submitted');
  assert.deepEqual(stops[0]!.opts, { release: false });
});

test('a non-closed submit does NOT stop the loop', async () => {
  const { hub } = mockHub({ submit: { outcome: 'accepted', closed: false } });
  const mount = createHoldMcp(deps(hub));
  let stopped = false;
  mount.loop.stop = (() => { stopped = true; }) as typeof mount.loop.stop;
  await tool(mount.tools, 'submit').handler({ path: 'pr', value: 1 }, ctx);
  assert.equal(stopped, false);
});

test('submit validates path and value before touching the hub', async () => {
  const { hub, calls } = mockHub({});
  const mount = createHoldMcp(deps(hub));
  const noPath = await tool(mount.tools, 'submit').handler({ value: 1 }, ctx);
  assert.equal((noPath as { isError?: boolean }).isError, true);
  const noValue = await tool(mount.tools, 'submit').handler({ path: 'pr' }, ctx);
  assert.equal((noValue as { isError?: boolean }).isError, true);
  assert.equal(calls.length, 0);
});

test('submit surfaces a hub failure as an isError result', async () => {
  const { hub } = mockHub({ submit: new Error('rejected') });
  const mount = createHoldMcp(deps(hub));
  const res = await tool(mount.tools, 'submit').handler({ path: 'pr', value: 1 }, ctx);
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(parse(res).error, /rejected/);
});

// ---- reject ------------------------------------------------------------------

test('reject posts only the bound workflow/run/path/text and never accepts client by', async () => {
  const { hub, calls } = mockHub({ reject: { ok: true, closed: false } });
  const mount = createHoldMcp(deps(hub));
  const res = await tool(mount.tools, 'reject').handler({ path: 'input', text: 'bad value', by: 'forged' }, ctx);
  assert.deepEqual(parse(res), { ok: true, closed: false, text: 'ok' });
  assert.deepEqual(calls, [{
    verb: 'reject',
    arg: { workflow: 'wf1', run: 'run1', path: 'input', text: 'bad value' },
  }]);
  assert.equal((calls[0]!.arg as Record<string, unknown>)['by'], undefined);
});

test('reject validates path and text before touching the hub', async () => {
  const { hub, calls } = mockHub({});
  const mount = createHoldMcp(deps(hub));
  const noPath = await tool(mount.tools, 'reject').handler({ text: 'bad' }, ctx);
  const noText = await tool(mount.tools, 'reject').handler({ path: 'input' }, ctx);
  assert.equal((noPath as { isError?: boolean }).isError, true);
  assert.equal((noText as { isError?: boolean }).isError, true);
  assert.equal(calls.length, 0);
});

test('a CLOSED reject stops the lease loop without releasing', async () => {
  const { hub } = mockHub({ reject: { ok: true, closed: true } });
  const mount = createHoldMcp(deps(hub));
  const stops: Array<{ reason?: string; opts?: unknown }> = [];
  const realStop = mount.loop.stop;
  mount.loop.stop = ((reason?: string, opts?: unknown) => {
    stops.push({ reason, opts });
    return realStop.call(mount.loop, reason as never, opts as never);
  }) as typeof mount.loop.stop;

  await tool(mount.tools, 'reject').handler({ path: 'input', text: 'bad' }, ctx);
  assert.deepEqual(stops, [{ reason: 'submitted', opts: { release: false } }]);
});

test('reject surfaces a hub failure as an isError result', async () => {
  const { hub } = mockHub({ reject: new Error('reject offline') });
  const mount = createHoldMcp(deps(hub));
  const res = await tool(mount.tools, 'reject').handler({ path: 'input', text: 'bad' }, ctx);
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(parse(res).error, /reject offline/);
});

// ---- terminal fast-fail (reviewer regression: lease-lost must stop the tools) --

test('once the lease is lost, ALL THREE tools fast-fail with isError and NO hub call', async () => {
  // First contact sees an unclaimed lease with no outcome → run() = lease-lost.
  const { hub, calls } = mockHub({
    getOrder: { text: '', workflow: 'wf1', run: 'run1', order: null, lease: { claimed: false } },
  });
  const mount = createHoldMcp(deps(hub));
  assert.equal(await mount.loop.run(), 'lease-lost');

  const before = calls.length;
  const g = await tool(mount.tools, 'get_order').handler({}, ctx);
  assert.equal((g as { isError?: boolean }).isError, true);
  assert.match(parse(g).error, /no longer held/);
  const s = await tool(mount.tools, 'submit').handler({ path: 'pr', value: 1 }, ctx);
  assert.equal((s as { isError?: boolean }).isError, true);
  assert.match(parse(s).error, /no longer held/);
  const r = await tool(mount.tools, 'reject').handler({ path: 'input', text: 'bad' }, ctx);
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.match(parse(r).error, /no longer held/);
  assert.equal(calls.length, before, 'a terminated hold makes NO further hub calls');
});

test('after a closing submit ends the hold, further tool calls fast-fail (double-submit guard)', async () => {
  const { hub, calls } = mockHub({ submit: { outcome: 'green', closed: true } });
  const mount = createHoldMcp(deps(hub));
  // The closing submit itself answers normally…
  const first = await tool(mount.tools, 'submit').handler({ path: 'pr', value: 1, done: true }, ctx);
  assert.equal(parse(first).closed, true);
  // …the stopped loop then settles…
  assert.equal(await mount.loop.run(), 'stopped');
  // …and from then on all tools refuse without touching the hub.
  const before = calls.length;
  const again = await tool(mount.tools, 'submit').handler({ path: 'pr', value: 2 }, ctx);
  assert.equal((again as { isError?: boolean }).isError, true);
  assert.match(parse(again).error, /no longer held/);
  const g = await tool(mount.tools, 'get_order').handler({}, ctx);
  assert.equal((g as { isError?: boolean }).isError, true);
  const r = await tool(mount.tools, 'reject').handler({ path: 'input', text: 'bad' }, ctx);
  assert.equal((r as { isError?: boolean }).isError, true);
  assert.equal(calls.length, before);
});
