import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHoldLoop, type HoldLoop, type HoldLoopOptions } from '../src/hold/loop.ts';
import { HubError, type ContactHolder, type GetOrderResponse } from '../src/hub/types.ts';
import type { HubClient } from '../src/hub/client.ts';

// ---- fakes ------------------------------------------------------------------

interface Call {
  verb: string;
  arg?: unknown;
}

/** A get_order response with the given lease state. */
function order(claimed: boolean, outcome?: string): GetOrderResponse {
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: null,
    lease: { claimed, ...(outcome !== undefined ? { outcome } : {}) },
  };
}

type GetOrderScript = Array<GetOrderResponse | Error> | ((n: number) => GetOrderResponse);
type HeartbeatScript = Array<Error | undefined> | ((n: number) => void);

interface MockCfg {
  getOrder?: GetOrderScript;
  heartbeat?: HeartbeatScript;
  release?: () => Promise<{ text: string }>;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[] } {
  const calls: Call[] = [];
  let goIdx = 0;
  let hbIdx = 0;

  const nextGetOrder = (): GetOrderResponse => {
    const s = cfg.getOrder ?? [order(true)];
    const item = Array.isArray(s) ? s[Math.min(goIdx, s.length - 1)]! : s(goIdx);
    goIdx++;
    if (item instanceof Error) throw item;
    return item;
  };
  const nextHeartbeat = (): void => {
    const s = cfg.heartbeat ?? [];
    if (typeof s === 'function') {
      s(hbIdx++);
      return;
    }
    const item = s.length > 0 ? s[Math.min(hbIdx, s.length - 1)] : undefined;
    hbIdx++;
    if (item instanceof Error) throw item;
  };

  const hub: HubClient = {
    async getOrder(req) {
      calls.push({ verb: 'get_order', arg: req });
      return nextGetOrder();
    },
    async heartbeat(req) {
      calls.push({ verb: 'heartbeat', arg: req });
      nextHeartbeat();
      return { text: '' };
    },
    async release(req) {
      calls.push({ verb: 'release', arg: req });
      return cfg.release !== undefined ? cfg.release() : { text: '' };
    },
    async whatsNext() {
      return { text: '' };
    },
    async submit() {
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
    async whoami() {
      return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' };
    },
    async wake() {
      return { text: '', cursor: 0, changed: false };
    },
    async presencePing(req) {
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
  };
  return { hub, calls };
}

const SESSION: ContactHolder = { kind: 'session', id: 'sess-1' };

/** A macrotask sleep: resolved-microtask releases beat the release-cap sleep. */
const macrotaskSleep = (): Promise<void> => new Promise((r) => setImmediate(r));

function baseOpts(hub: HubClient, extra: Partial<HoldLoopOptions> = {}): HoldLoopOptions {
  return {
    hub,
    workflow: 'wf1',
    run: 'run1',
    sleep: async () => {},
    now: () => 0,
    random: () => 0.5, // no jitter (0.5*2-1 == 0)
    out: () => {},
    err: () => {},
    heartbeatIntervalMs: 1000,
    jumpToleranceMs: 500,
    failureWindowMs: 5000,
    ...extra,
  };
}

const only = (calls: Call[], verb: string): Call[] => calls.filter((c) => c.verb === verb);

// ---- cadence + holder passthrough -------------------------------------------

test('beats at the interval carrying the session holder, then final-breath releases', async () => {
  const h: { loop?: HoldLoop } = {};
  let beats = 0;
  const { hub, calls } = mockHub({
    getOrder: [order(true)],
    heartbeat: () => {
      beats++;
      if (beats >= 3) h.loop!.stop('signal');
    },
    release: () => Promise.resolve({ text: '' }),
  });
  const loop = createHoldLoop(baseOpts(hub, { holder: SESSION, sleep: macrotaskSleep }));
  h.loop = loop;

  const outcome = await loop.run();
  assert.equal(outcome, 'released');
  assert.equal(beats, 3);
  // Holder rides first contact and every beat.
  assert.deepEqual((only(calls, 'get_order')[0]!.arg as { holder?: unknown }).holder, SESSION);
  for (const c of only(calls, 'heartbeat')) assert.deepEqual((c.arg as { holder?: unknown }).holder, SESSION);
  // Final breath = exactly one targeted release.
  const rel = only(calls, 'release');
  assert.equal(rel.length, 1);
  assert.deepEqual(rel[0]!.arg, { workflow: 'wf1', run: 'run1' });
});

test('omits the holder field entirely when no session identity is given', async () => {
  const h: { loop?: HoldLoop } = {};
  const { hub, calls } = mockHub({
    getOrder: [order(true)],
    heartbeat: () => h.loop!.stop('signal'),
    release: () => Promise.resolve({ text: '' }),
  });
  const loop = createHoldLoop(baseOpts(hub, { sleep: macrotaskSleep })); // no holder
  h.loop = loop;

  await loop.run();
  assert.equal('holder' in (only(calls, 'get_order')[0]!.arg as object), false);
  for (const c of only(calls, 'heartbeat')) assert.equal('holder' in (c.arg as object), false);
});

// ---- first contact ----------------------------------------------------------

test('first contact: unclaimed with an outcome ⇒ completed, no beat, no release', async () => {
  const { hub, calls } = mockHub({ getOrder: [order(false, 'ok')] });
  const outcome = await createHoldLoop(baseOpts(hub, { holder: SESSION })).run();
  assert.equal(outcome, 'completed');
  assert.equal(only(calls, 'heartbeat').length, 0);
  assert.equal(only(calls, 'release').length, 0);
});

test('first contact: unclaimed with no outcome ⇒ lease-lost', async () => {
  const { hub } = mockHub({ getOrder: [order(false)] });
  const outcome = await createHoldLoop(baseOpts(hub)).run();
  assert.equal(outcome, 'lease-lost');
});

test('first contact: a persistent throw (incl. workflow mismatch) ⇒ hub-unreachable past the window', async () => {
  let t = 0;
  const { hub } = mockHub({
    getOrder: () => {
      throw new HubError(500, "run 'run1' belongs to workflow 'other', not 'wf1'");
    },
  });
  const loop = createHoldLoop(
    baseOpts(hub, {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      failureWindowMs: 5000,
    }),
  );
  const outcome = await loop.run();
  assert.equal(outcome, 'hub-unreachable');
});

// ---- transient failure / backoff --------------------------------------------

test('a transient heartbeat failure backs off with jitter, then recovers and resets the counter', async () => {
  const h: { loop?: HoldLoop } = {};
  const sleeps: number[] = [];
  const { hub, calls } = mockHub({
    // fc holding; classify after the failed beat says still holding (transient).
    getOrder: [order(true), order(true)],
    heartbeat: (n) => {
      if (n === 0) throw new HubError(500, 'blip');
      if (n === 1) h.loop!.stop('signal'); // recovered beat → stop
    },
    release: () => Promise.resolve({ text: '' }),
  });
  const loop = createHoldLoop(
    baseOpts(hub, {
      holder: SESSION,
      now: () => 0,
      random: () => 0.9, // jitter factor 1 + (0.9*2-1)*0.2 = 1.16
      sleep: (ms) => {
        sleeps.push(ms);
        return macrotaskSleep(); // macrotask so a resolved release beats the 5s cap
      },
    }),
  );
  h.loop = loop;

  const outcome = await loop.run();
  assert.equal(outcome, 'released');
  // Backoff for attempt 1 = 1000 * 1.16 = 1160 (jittered via the random seam).
  assert.ok(sleeps.includes(1160), `expected a jittered 1160ms backoff, saw ${JSON.stringify(sleeps)}`);
  // Recovery reset the counter: exactly ONE backoff sleep — no attempt-2 (2320ms)
  // — the rest are 1000ms intervals and the 5000ms release cap.
  assert.equal(sleeps.filter((s) => s !== 1000 && s !== 5000).length, 1);
  // The classify after the failed beat used get_order (fc + one classify).
  assert.equal(only(calls, 'get_order').length, 2);
});

test('consecutive failures spanning the window ⇒ hub-unreachable after one last classify', async () => {
  let t = 0;
  const { hub, calls } = mockHub({
    getOrder: [order(true)], // fc + every classify: still holding (transient)
    heartbeat: () => {
      throw new HubError(500, 'lease hiccup');
    },
  });
  const loop = createHoldLoop(
    baseOpts(hub, {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      failureWindowMs: 5000,
    }),
  );
  const outcome = await loop.run();
  assert.equal(outcome, 'hub-unreachable');
  // No release on hub-unreachable (we never got to stop()).
  assert.equal(only(calls, 'release').length, 0);
});

// ---- hard errors ------------------------------------------------------------

test('403 on the beat ⇒ ownership-error immediately, with no classify and no retries', async () => {
  const { hub, calls } = mockHub({
    getOrder: [order(true)],
    heartbeat: () => {
      throw new HubError(403, 'forbidden', 'forbidden');
    },
  });
  const outcome = await createHoldLoop(baseOpts(hub)).run();
  assert.equal(outcome, 'ownership-error');
  assert.equal(only(calls, 'get_order').length, 1); // first contact only, no classify
  assert.equal(only(calls, 'release').length, 0);
});

test('a lease-gone 500 whose classify shows an outcome ⇒ completed (no release)', async () => {
  const { hub, calls } = mockHub({
    getOrder: [order(true), order(false, 'closed')],
    heartbeat: () => {
      throw new HubError(500, 'run no longer holds its lease');
    },
  });
  const outcome = await createHoldLoop(baseOpts(hub)).run();
  assert.equal(outcome, 'completed');
  assert.equal(only(calls, 'release').length, 0);
});

test('a beat failure whose classify shows unclaimed ⇒ lease-lost', async () => {
  const { hub } = mockHub({
    getOrder: [order(true), order(false)],
    heartbeat: () => {
      throw new HubError(500, 'gone');
    },
  });
  const outcome = await createHoldLoop(baseOpts(hub)).run();
  assert.equal(outcome, 'lease-lost');
});

// ---- clock jump -------------------------------------------------------------

test('a clock jump checks the lease via get_order BEFORE the next beat', async () => {
  const h: { loop?: HoldLoop } = {};
  const { hub, calls } = mockHub({
    getOrder: [order(true), order(true)], // fc, then jump-check: still holding
    heartbeat: () => h.loop!.stop('signal'),
    release: () => Promise.resolve({ text: '' }),
  });
  let t = 0;
  const loop = createHoldLoop(
    baseOpts(hub, {
      now: () => t,
      sleep: (ms) => {
        // The interval sleep jumps the wall clock well past interval+tolerance.
        t += ms === 1000 ? 2000 : ms;
        return macrotaskSleep();
      },
    }),
  );
  h.loop = loop;

  const outcome = await loop.run();
  assert.equal(outcome, 'released');
  // Order of hub calls: fc get_order, jump-check get_order, THEN the beat.
  const verbs = calls.map((c) => c.verb);
  assert.deepEqual(verbs.slice(0, 3), ['get_order', 'get_order', 'heartbeat']);
});

test('a clock jump onto a lapsed lease exits lease-lost without beating', async () => {
  const { hub, calls } = mockHub({
    getOrder: [order(true), order(false)], // fc holding, jump-check: gone
    heartbeat: () => {
      throw new Error('beat must not be called after a lapsed-lease jump check');
    },
  });
  let t = 0;
  const loop = createHoldLoop(
    baseOpts(hub, {
      now: () => t,
      sleep: async (ms) => {
        t += ms === 1000 ? 2000 : ms;
      },
    }),
  );
  const outcome = await loop.run();
  assert.equal(outcome, 'lease-lost');
  assert.equal(only(calls, 'heartbeat').length, 0);
});

// ---- final breath -----------------------------------------------------------

test('final breath: a resolved release (released OR not-held) counts as released', async () => {
  const h: { loop?: HoldLoop } = {};
  const { hub, calls } = mockHub({
    getOrder: [order(true)],
    heartbeat: () => h.loop!.stop('stdin-eof'),
    release: () => Promise.resolve({ text: 'not-held no-op' }),
  });
  const loop = createHoldLoop(baseOpts(hub, { sleep: macrotaskSleep }));
  h.loop = loop;
  assert.equal(await loop.run(), 'released');
  assert.equal(only(calls, 'release').length, 1);
});

test('final breath: a release throw ⇒ release-failed', async () => {
  const h: { loop?: HoldLoop } = {};
  const { hub } = mockHub({
    getOrder: [order(true)],
    heartbeat: () => h.loop!.stop('signal'),
    release: () => Promise.reject(new Error('boom')),
  });
  const loop = createHoldLoop(baseOpts(hub, { sleep: macrotaskSleep }));
  h.loop = loop;
  assert.equal(await loop.run(), 'release-failed');
});

test('final breath: a release that outlasts the 5s cap ⇒ release-failed', async () => {
  const h: { loop?: HoldLoop } = {};
  const { hub } = mockHub({
    getOrder: [order(true)],
    heartbeat: () => h.loop!.stop('signal'),
    release: () => new Promise<{ text: string }>(() => {}), // never settles
  });
  // Interval sleeps use macrotask; the 5000ms release cap also resolves (macrotask)
  // and wins the race against the never-settling release.
  const loop = createHoldLoop(baseOpts(hub, { sleep: macrotaskSleep }));
  h.loop = loop;
  assert.equal(await loop.run(), 'release-failed');
});

test('stop() aborts an in-flight interval sleep so final breath is prompt', async () => {
  const { hub, calls } = mockHub({
    getOrder: [order(true)],
    release: () => Promise.resolve({ text: '' }),
  });
  // The interval sleep never resolves on its own; only stop() can end the wait.
  const sleep = (ms: number): Promise<void> => (ms === 1000 ? new Promise<void>(() => {}) : macrotaskSleep());
  const loop = createHoldLoop(baseOpts(hub, { sleep }));
  const p = loop.run();
  setImmediate(() => loop.stop('signal'));
  assert.equal(await p, 'released');
  assert.equal(only(calls, 'release').length, 1);
});

test('a second stop() is a no-op (one release, matching the 130 hard-exit seam)', async () => {
  const h: { loop?: HoldLoop } = {};
  const { hub, calls } = mockHub({
    getOrder: [order(true)],
    heartbeat: () => {
      h.loop!.stop('signal');
      h.loop!.stop('signal'); // second signal — ignored by the loop
    },
    release: () => Promise.resolve({ text: '' }),
  });
  const loop = createHoldLoop(baseOpts(hub, { sleep: macrotaskSleep }));
  h.loop = loop;
  assert.equal(await loop.run(), 'released');
  assert.equal(only(calls, 'release').length, 1);
});

test('stop() before first contact establishes the hold ⇒ stopped, no release', async () => {
  const h: { loop?: HoldLoop } = {};
  const { hub, calls } = mockHub({
    getOrder: () => {
      throw new HubError(500, 'unreachable at birth');
    },
  });
  const loop = createHoldLoop(
    baseOpts(hub, {
      now: () => 0,
      sleep: async () => {
        h.loop!.stop('signal'); // stop during the first-contact backoff
      },
    }),
  );
  h.loop = loop;
  assert.equal(await loop.run(), 'stopped');
  assert.equal(only(calls, 'release').length, 0);
});
