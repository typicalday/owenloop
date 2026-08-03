import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHoldMcp } from '../src/hold/mcp.ts';
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
  submit?: { outcome?: string; closed?: boolean } | Error;
}

function mockHub(cfg: HubCfg): { hub: HubClient; calls: Call[] } {
  const calls: Call[] = [];
  const hub = {
    async getOrder(req: unknown) {
      calls.push({ verb: 'get_order', arg: req });
      const r = cfg.getOrder ?? { text: '', workflow: 'wf1', run: 'run1', order: null, lease: { claimed: true } };
      if (r instanceof Error) throw r;
      return r;
    },
    async submit(req: unknown) {
      calls.push({ verb: 'submit', arg: req });
      const s = cfg.submit ?? { outcome: 'accepted' };
      if (s instanceof Error) throw s;
      return { text: 'ok', outcome: s.outcome, closed: s.closed };
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

// ---- shape ------------------------------------------------------------------

test('the mount exposes exactly get_order and submit, plus the lease loop', () => {
  const { hub } = mockHub({});
  const mount = createHoldMcp(deps(hub));
  assert.deepEqual(mount.tools.map((t) => t.name).sort(), ['get_order', 'submit']);
  assert.equal(typeof mount.loop.run, 'function');
  assert.equal(typeof mount.loop.stop, 'function');
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
  assert.deepEqual(calls, [{ verb: 'submit', arg: { workflow: 'wf1', run: 'run1', path: 'pr', value: { url: 'x' }, done: false } }]);
});

// W7/D4: when the bound holder is known, submit carries it through unchanged
// so the hub's attribution columns get filled.
test('submit carries the bound holder through to the hub', async () => {
  const { hub, calls } = mockHub({ submit: { outcome: 'accepted', closed: false } });
  const mount = createHoldMcp(deps(hub, { holder: { kind: 'session', id: 's-1', shiftId: 'shf_1' } }));
  await tool(mount.tools, 'submit').handler({ path: 'pr', value: { url: 'x' }, done: false }, ctx);
  assert.deepEqual(calls, [
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

// ---- terminal fast-fail (reviewer regression: lease-lost must stop the tools) --

test('once the lease is lost, BOTH tools fast-fail with isError and NO hub call', async () => {
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
  // …and from then on both tools refuse without touching the hub.
  const before = calls.length;
  const again = await tool(mount.tools, 'submit').handler({ path: 'pr', value: 2 }, ctx);
  assert.equal((again as { isError?: boolean }).isError, true);
  assert.match(parse(again).error, /no longer held/);
  const g = await tool(mount.tools, 'get_order').handler({}, ctx);
  assert.equal((g as { isError?: boolean }).isError, true);
  assert.equal(calls.length, before);
});
