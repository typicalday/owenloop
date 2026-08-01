import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildProxyTools } from '../src/proxy/mcp.ts';
import type { ProxyLoop } from '../src/proxy/loop.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { ToolCallContext, ToolRegistration } from '../src/mcp/server.ts';

// ---- fakes ------------------------------------------------------------------

/** A fake ProxyLoop whose iterate() yields a scripted dispatch count per pass. */
function fakeLoop(dispatches: number[], cap = 3): { loop: ProxyLoop; ended: string[] } {
  let i = 0;
  let liveCap = cap;
  const ended: string[] = [];
  let shift = { name: 'box', servePools: [] as string[] };
  const loop: ProxyLoop = {
    run: async () => 0,
    stop: () => {},
    iterate: async () => {
      const n = dispatches[Math.min(i, dispatches.length - 1)] ?? 0;
      i++;
      return n;
    },
    freeCapacity: () => liveCap,
    getCap: () => liveCap,
    setCap: (c) => {
      liveCap = c;
    },
    getShift: () => ({ name: shift.name, servePools: [...shift.servePools] }),
    setShift: (next) => {
      shift = {
        name: next.name !== undefined ? next.name : shift.name,
        servePools: next.servePools !== undefined ? [...next.servePools] : shift.servePools,
      };
      return { name: shift.name, servePools: [...shift.servePools] };
    },
    noteRunEnded: (run) => {
      ended.push(run);
    },
  };
  return { loop, ended };
}

function fakeCtx(cancelled = false): ToolCallContext {
  const cbs: Array<() => void> = [];
  return {
    get cancelled() {
      return cancelled;
    },
    onCancel: (cb) => {
      if (cancelled) cb();
      else cbs.push(cb);
    },
    sendProgress: () => {},
  };
}

function tool(tools: ToolRegistration[], name: string): ToolRegistration {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t!;
}

function parse(res: { content: Array<{ text: string }> }): ReturnType<typeof JSON.parse> {
  return JSON.parse(res.content[0]!.text);
}

const noHub = {} as HubClient;

// ---- whats_next -------------------------------------------------------------

test('the four proxy tools are registered', () => {
  const tools = buildProxyTools({ loop: fakeLoop([0]).loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1000 });
  assert.deepEqual(tools.map((t) => t.name).sort(), ['clock_in', 'set_dispatch_cap', 'submit', 'whats_next']);
});

// D7: the reply is a CAPACITY VIEW, never order handles — every order the proxy
// takes is already running in a detached child, so there is nothing to hand back.
test('whats_next parks until a pass dispatches, then returns the capacity view', async () => {
  const { loop } = fakeLoop([0, 0, 1], 3);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, defaultWaitMs: 1000 });
  const res = await tool(tools, 'whats_next').handler({}, fakeCtx());
  const body = parse(res);
  assert.equal(body.orders, undefined, 'no order handles are ever returned');
  assert.equal(body.cap, 3);
  assert.equal(body.free, 3);
  assert.equal(body.running, 0);
});

test('the capacity view derives running from cap − free', async () => {
  const { loop } = fakeLoop([1], 5);
  loop.setCap(5);
  const withTwoLive: ProxyLoop = { ...loop, freeCapacity: () => 3 };
  const tools = buildProxyTools({ loop: withTwoLive, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, defaultWaitMs: 10 });
  const body = parse(await tool(tools, 'whats_next').handler({}, fakeCtx()));
  assert.deepEqual(body, { cap: 5, free: 3, running: 2 });
});

test('whats_next returns the capacity view once the wait ceiling elapses', async () => {
  const { loop } = fakeLoop([0]); // never any work
  let t = 0;
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async (ms) => { t += ms; }, now: () => t, pollIntervalMs: 10, defaultWaitMs: 25 });
  const res = await tool(tools, 'whats_next').handler({ wait_ms: 25 }, fakeCtx());
  assert.equal(parse(res).free, 3);
});

test('whats_next honours a caller wait_ms of 0 — one iterate then return', async () => {
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 10, defaultWaitMs: 999 });
  const res = await tool(tools, 'whats_next').handler({ wait_ms: 0 }, fakeCtx());
  assert.equal(parse(res).free, 3);
});

test('a cancelled whats_next returns promptly', async () => {
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 10, defaultWaitMs: 999_999 });
  const res = await tool(tools, 'whats_next').handler({}, fakeCtx(true));
  assert.equal(parse(res).free, 3);
});

test('whats_next surfaces an iterate() failure as an isError result', async () => {
  const loop: ProxyLoop = {
    run: async () => 0,
    stop: () => {},
    iterate: async () => { throw new Error('sweep exploded'); },
    freeCapacity: () => 0,
    getCap: () => 3,
    setCap: () => {},
    getShift: () => ({ name: 'box', servePools: [] }),
    setShift: (next) => ({ name: next.name ?? 'box', servePools: next.servePools ?? [] }),
    noteRunEnded: () => {},
  };
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'whats_next').handler({}, fakeCtx());
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(parse(res).error, /sweep exploded/);
});

test('an overlapping whats_next gets a fast isError while the first is parked (reviewer regression)', async () => {
  // First park blocks on a pending iterate(); a second call must NOT queue
  // silently behind it — it answers isError immediately.
  let releaseIterate!: (dispatched: number) => void;
  const gate = new Promise<number>((r) => { releaseIterate = r; });
  let first = true;
  const loop: ProxyLoop = {
    run: async () => 0,
    stop: () => {},
    iterate: () => {
      if (first) {
        first = false;
        return gate;
      }
      return Promise.resolve(0);
    },
    freeCapacity: () => 3,
    getCap: () => 3,
    setCap: () => {},
    getShift: () => ({ name: 'box', servePools: [] }),
    setShift: (next) => ({ name: next.name ?? 'box', servePools: next.servePools ?? [] }),
    noteRunEnded: () => {},
  };
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, defaultWaitMs: 999_999 });
  const parked = tool(tools, 'whats_next').handler({}, fakeCtx());
  const overlap = await tool(tools, 'whats_next').handler({}, fakeCtx());
  assert.equal((overlap as { isError?: boolean }).isError, true);
  assert.match(parse(overlap).error, /already parked/);

  releaseIterate(1);
  assert.equal(parse(await parked).cap, 3);

  // With the first park settled, whats_next parks again normally.
  const again = await tool(tools, 'whats_next').handler({ wait_ms: 0 }, fakeCtx());
  assert.equal((again as { isError?: boolean }).isError, undefined);
});

test('a parked whats_next emits keepalive progress roughly every 25s (reviewer regression)', async () => {
  const { loop } = fakeLoop([0]); // never any work
  let t = 0;
  const progress: string[] = [];
  const ctx: ToolCallContext = {
    cancelled: false,
    onCancel: () => {},
    sendProgress: (p) => progress.push(p.message ?? ''),
  };
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async (ms) => { t += ms; }, now: () => t, pollIntervalMs: 10_000, defaultWaitMs: 60_000 });
  const res = await tool(tools, 'whats_next').handler({}, ctx);
  assert.equal(parse(res).free, 3);
  // 60s park at 10s polls → keepalives at ~30s and ~60s-boundary (t=30k, t=60k
  // is the deadline so only the 30k one is guaranteed): at least one fired.
  assert.ok(progress.length >= 1, `expected >=1 keepalive progress, saw ${progress.length}`);
  assert.match(progress[0]!, /parked/);
});

// ---- set_dispatch_cap -------------------------------------------------------

test('set_dispatch_cap adjusts the live cap', async () => {
  const { loop } = fakeLoop([0], 3);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'set_dispatch_cap').handler({ cap: 7 }, fakeCtx());
  assert.equal(parse(res).cap, 7);
  assert.equal(loop.getCap(), 7);
});

test('set_dispatch_cap rejects a non-integer cap', async () => {
  const { loop } = fakeLoop([0], 3);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  for (const bad of [-1, 2.5, 'x']) {
    const res = await tool(tools, 'set_dispatch_cap').handler({ cap: bad as unknown as number }, fakeCtx());
    assert.equal((res as { isError?: boolean }).isError, true, `cap=${String(bad)} rejected`);
  }
  assert.equal(loop.getCap(), 3); // unchanged
});

// ---- clock_in ----------------------------------------------------------------
//
// shifts.md §8 item 4: `clock_in` sets the live shift's name and/or serve_pools
// on the loop. Partial update (an omitted field is unchanged); serve_pools: []
// means ALL of this identity's crews, never none (D3); validation is stricter
// than the --serve-pools flag and both fields are checked before either mutates
// (D4).

test('clock_in sets both name and serve_pools, and getShift() agrees', async () => {
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'clock_in').handler({ serve_pools: ['project-foo'], name: 'shiftA' }, fakeCtx());
  assert.deepEqual(parse(res), { name: 'shiftA', serve_pools: ['project-foo'], scope_all: false });
  assert.deepEqual(loop.getShift(), { name: 'shiftA', servePools: ['project-foo'] });
});

// D3: empty is accepted and means ALL crews — never inverted to "none".
test('clock_in {serve_pools: []} is accepted and reports scope_all: true', async () => {
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'clock_in').handler({ serve_pools: [] }, fakeCtx());
  assert.equal((res as { isError?: boolean }).isError, undefined);
  assert.deepEqual(parse(res), { name: 'box', serve_pools: [], scope_all: true });
});

test('clock_in {} is a valid no-op that returns the current shift', async () => {
  const { loop } = fakeLoop([0]);
  await tool(buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 }), 'clock_in').handler(
    { serve_pools: ['project-foo'], name: 'shiftA' },
    fakeCtx(),
  );
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'clock_in').handler({}, fakeCtx());
  assert.deepEqual(parse(res), { name: 'shiftA', serve_pools: ['project-foo'], scope_all: false });
});

test('clock_in is a PARTIAL update: an omitted field leaves that part of the shift unchanged', async () => {
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  await tool(tools, 'clock_in').handler({ serve_pools: ['a'] }, fakeCtx());
  assert.equal(loop.getShift().name, 'box'); // name untouched
  await tool(tools, 'clock_in').handler({ name: 'n' }, fakeCtx());
  assert.deepEqual(loop.getShift().servePools, ['a']); // scope untouched by the name-only call
});

test('clock_in rejects a non-array, non-string, or blank serve_pools entry and mutates nothing', async () => {
  for (const bad of [['ok', ''], ['ok', '  '], 'a', [1]]) {
    const { loop } = fakeLoop([0]);
    const before = loop.getShift();
    const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
    const res = await tool(tools, 'clock_in').handler({ serve_pools: bad as unknown }, fakeCtx());
    assert.equal((res as { isError?: boolean }).isError, true, `serve_pools=${JSON.stringify(bad)} rejected`);
    assert.deepEqual(loop.getShift(), before, `serve_pools=${JSON.stringify(bad)} mutated nothing`);
  }
});

test('clock_in rejects an empty or over-long name, and mutates nothing', async () => {
  for (const bad of ['', 'x'.repeat(201)]) {
    const { loop } = fakeLoop([0]);
    const before = loop.getShift();
    const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
    const res = await tool(tools, 'clock_in').handler({ name: bad }, fakeCtx());
    assert.equal((res as { isError?: boolean }).isError, true, `name=${JSON.stringify(bad)} rejected`);
    assert.deepEqual(loop.getShift(), before);
  }
});

// D4 step 3: a valid name alongside an invalid serve_pools changes NOTHING —
// both fields are validated before either is applied.
test('clock_in with a VALID name and an INVALID serve_pools mutates nothing', async () => {
  const { loop } = fakeLoop([0]);
  const before = loop.getShift();
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'clock_in').handler({ name: 'shiftA', serve_pools: ['ok', ''] }, fakeCtx());
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.deepEqual(loop.getShift(), before);
});

test('clock_in trims serve_pools entries', async () => {
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  await tool(tools, 'clock_in').handler({ serve_pools: [' project-foo '] }, fakeCtx());
  assert.deepEqual(loop.getShift().servePools, ['project-foo']);
});

test('clock_in echoes conductor_id when the deps carry one, omits it otherwise', async () => {
  const { loop } = fakeLoop([0]);
  const withId = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, conductorId: 'cnd_abc' });
  const res = await tool(withId, 'clock_in').handler({}, fakeCtx());
  assert.equal(parse(res).conductor_id, 'cnd_abc');

  const { loop: loop2 } = fakeLoop([0]);
  const withoutId = buildProxyTools({ loop: loop2, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res2 = await tool(withoutId, 'clock_in').handler({}, fakeCtx());
  assert.equal('conductor_id' in parse(res2), false);
});

// D5: clock_in is accepted mid-park — never rejected, never blocked. The
// iterate() already in flight completes under the OLD shift; every later one
// sees the NEW shift. The fake records getShift() at the start of each
// iterate() call to prove which shift each pass actually saw.
test('clock_in mid-park (D5): the in-flight iterate() finishes under the old shift, the next one sees the new one', async () => {
  let releaseIterate!: (dispatched: number) => void;
  const gate = new Promise<number>((r) => { releaseIterate = r; });
  let first = true;
  let shift = { name: 'box', servePools: [] as string[] };
  const seenAtIterate: Array<{ name: string; servePools: string[] }> = [];
  const loop: ProxyLoop = {
    run: async () => 0,
    stop: () => {},
    iterate: () => {
      seenAtIterate.push({ name: shift.name, servePools: [...shift.servePools] });
      if (first) {
        first = false;
        return gate;
      }
      return Promise.resolve(0);
    },
    freeCapacity: () => 3,
    getCap: () => 3,
    setCap: () => {},
    getShift: () => ({ name: shift.name, servePools: [...shift.servePools] }),
    setShift: (next) => {
      shift = {
        name: next.name !== undefined ? next.name : shift.name,
        servePools: next.servePools !== undefined ? [...next.servePools] : shift.servePools,
      };
      return { name: shift.name, servePools: [...shift.servePools] };
    },
    noteRunEnded: () => {},
  };
  const tools = buildProxyTools({ loop, hub: noHub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, defaultWaitMs: 999_999 });

  const parked = tool(tools, 'whats_next').handler({}, fakeCtx());
  const clockInRes = await tool(tools, 'clock_in').handler({ serve_pools: ['project-foo'] }, fakeCtx());
  assert.equal((clockInRes as { isError?: boolean }).isError, undefined, 'clock_in is accepted mid-park, never rejected');

  releaseIterate(1);
  await parked;

  await tool(tools, 'whats_next').handler({ wait_ms: 0 }, fakeCtx());

  assert.deepEqual(seenAtIterate[0], { name: 'box', servePools: [] }, 'the in-flight iterate() saw the OLD shift');
  assert.deepEqual(seenAtIterate[1], { name: 'box', servePools: ['project-foo'] }, 'the next iterate() saw the NEW shift');
});

// ---- submit -----------------------------------------------------------------

function submitHub(script: { outcome?: string; closed?: boolean } | Error): { hub: HubClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const hub = {
    async submit(req: unknown) {
      calls.push(req);
      if (script instanceof Error) throw script;
      return { text: 'ok', outcome: script.outcome, closed: script.closed };
    },
  } as unknown as HubClient;
  return { hub, calls };
}

test('submit posts the receipt through the hub and echoes the outcome', async () => {
  const { hub, calls } = submitHub({ outcome: 'green', closed: true });
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'submit').handler({ workflow: 'wf1', run: 'run_a', path: 'pr', value: { ok: 1 }, done: true }, fakeCtx());
  assert.deepEqual(calls, [{ workflow: 'wf1', run: 'run_a', path: 'pr', value: { ok: 1 }, done: true }]);
  const body = parse(res);
  assert.equal(body.outcome, 'green');
  assert.equal(body.closed, true);
});

// W7/D4: when deps.holder is set (the proxy builds one at role-wiring time),
// submit carries it through to the hub unchanged.
test('submit carries the deps holder through to the hub when set', async () => {
  const { hub, calls } = submitHub({ outcome: 'green', closed: true });
  const { loop } = fakeLoop([0]);
  const holder = { kind: 'session' as const, id: 'anon:host1:42', conductorId: 'cnd_1' };
  const tools = buildProxyTools({ loop, hub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1, holder });
  await tool(tools, 'submit').handler({ workflow: 'wf1', run: 'run_a', path: 'pr', value: { ok: 1 }, done: true }, fakeCtx());
  assert.deepEqual(calls, [{ workflow: 'wf1', run: 'run_a', path: 'pr', value: { ok: 1 }, done: true, holder }]);
});

test('a CLOSED submit reports the run ended to the loop — its dispatch slot frees now, not TTL-later', async () => {
  const { hub } = submitHub({ outcome: 'green', closed: true });
  const { loop, ended } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  await tool(tools, 'submit').handler({ workflow: 'wf1', run: 'run_a', path: 'pr', value: 1, done: true }, fakeCtx());
  assert.deepEqual(ended, ['run_a']);
});

test('a non-closed submit does NOT touch the in-flight records', async () => {
  const { hub } = submitHub({ outcome: 'accepted', closed: false });
  const { loop, ended } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  await tool(tools, 'submit').handler({ workflow: 'wf1', run: 'run_a', path: 'pr', value: 1 }, fakeCtx());
  assert.deepEqual(ended, []);
});

test('submit validates required string args', async () => {
  const { hub, calls } = submitHub({ outcome: 'green' });
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const missingValue = await tool(tools, 'submit').handler({ workflow: 'wf1', run: 'r', path: 'pr' }, fakeCtx());
  assert.equal((missingValue as { isError?: boolean }).isError, true);
  const emptyRun = await tool(tools, 'submit').handler({ workflow: 'wf1', run: '', path: 'pr', value: 1 }, fakeCtx());
  assert.equal((emptyRun as { isError?: boolean }).isError, true);
  assert.equal(calls.length, 0); // never reached the hub
});

test('submit surfaces a hub failure as an isError result', async () => {
  const { hub } = submitHub(new Error('hub down'));
  const { loop } = fakeLoop([0]);
  const tools = buildProxyTools({ loop, hub, sleep: async () => {}, now: () => 0, pollIntervalMs: 1 });
  const res = await tool(tools, 'submit').handler({ workflow: 'wf1', run: 'r', path: 'pr', value: 1 }, fakeCtx());
  assert.equal((res as { isError?: boolean }).isError, true);
  assert.match(parse(res).error, /hub down/);
});
