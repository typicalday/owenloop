/**
 * A shift that cannot work because the MACHINE is broken must say so and stop.
 *
 * The defect these tests lock down was measured, not imagined: after a host
 * reboot a surviving shift daemon kept the old `TMPDIR` in its environment, that
 * directory no longer existed, every hub call failed with undici's generic
 * `fetch failed`, and the daemon sat wedged for 42 minutes — visible to `pgrep`,
 * answering `shift end`, dispatching nothing, and writing not one record that
 * named the cause.
 *
 * The fix has two halves and they pull in opposite directions, which is why the
 * fleet-safety test below matters more than the detection ones. Detecting a
 * LOCAL fault must stop the shift, because nothing about waiting fixes a
 * vanished directory. Detecting a REMOTE fault must NOT stop it, because a hub
 * outage and a Cloudflare rate-limit ban both end on their own — and a fleet
 * that killed itself over a 1015 ban would be destroying itself for a condition
 * it caused.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createShiftLoop } from '../src/shift/loop.ts';
import type { ShiftLoopOptions } from '../src/shift/loop.ts';
import type { HubClient } from '../src/hub/client.ts';
import { HubError } from '../src/hub/types.ts';
import type { ShiftEvent } from '../src/shift/protocol.ts';
import { checkHost, type FsProbe, type HostFault } from '../src/shift/host-preflight.ts';

let root: string;
let stateDir: string;
let cacheDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-host-preflight-'));
  stateDir = join(root, 'state');
  cacheDir = join(root, 'cache');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A hub whose `wake` is the only interesting call; everything else is inert. */
function mockHub(wake: () => Promise<{ text: string; cursor: number; changed: boolean }>): HubClient {
  return {
    // Not exercised here: the byte-bodied upload has its own tests.
    async putFileArtifact() {
      throw new Error('putFileArtifact is not exercised by this test');
    },
    wake,
    async presencePing(req) { return { text: '', ok: true, name: req.name, lastSeen: 1 }; },
    async whatsNext() { return { text: '', instances: [] }; },
    async getOrder(req) { return { text: '', workflow: req.workflow, run: req.run, order: null, lease: { claimed: true } }; },
    async heartbeat() { return { text: '', ok: true }; },
    async release() { return { text: '' }; },
    async submit() { return { text: '' }; },
    async reject() { return { text: '', ok: true }; },
    async ask() { return { text: '', ok: true }; },
    async requestApproval() { return { text: '', ok: false }; },
    async answerApproval() { return { text: '', ok: false }; },
    async listPendingApprovals() { return { text: '', approvals: [] }; },
    async reportResolution(req) {
      return { text: '', workflow: req.workflow, run: req.run, step: '', recorded: true, claimed: true };
    },
    async whoami() {
      return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' };
    },
  } as HubClient;
}

function baseOpts(hub: HubClient, extra: Partial<ShiftLoopOptions> = {}): ShiftLoopOptions {
  return {
    hub,
    spawner: () => ({ pid: 1000 }),
    sleep: async () => {},
    now: () => 100,
    out: () => {},
    err: () => {},
    cacheDir,
    stateDir,
    cap: 3,
    serveCrews: [],
    name: 'box',
    shiftId: 'shf_unit',
    workflow: 'wf1',
    pollIntervalMs: 10,
    presenceIntervalMs: 60_000,
    ...extra,
  };
}

const FAULT: HostFault = {
  kind: 'missing',
  role: 'temp-dir',
  path: '/var/folders/gone/T',
  message: "TMPDIR '/var/folders/gone/T' no longer exists — restart the shift",
};

function alwaysFailingWake(): () => Promise<never> {
  return async () => {
    throw new Error('fetch failed');
  };
}

test('a shift started into a broken host stops before its first hub call', async () => {
  // The supervisor-restart-across-a-reboot shape. Making this shift wait for
  // three failed polls would buy nothing and would spend the operator's
  // attention on network theories for a fault that is already knowable.
  const events: ShiftEvent[] = [];
  const errors: string[] = [];
  let wakes = 0;
  const hub = mockHub(async () => {
    wakes += 1;
    return { text: '', cursor: 1, changed: false };
  });
  const loop = createShiftLoop(baseOpts(hub, {
    onEvent: (event) => events.push(event),
    err: (line) => errors.push(line),
    hostPreflight: () => [FAULT],
  }));

  assert.equal(await loop.run(), 1, 'a wedged shift must exit non-zero');
  assert.equal(wakes, 0, 'the boot check runs BEFORE the first hub call');
  const wedged = events.filter((event) => event.type === 'wedged');
  assert.equal(wedged.length, 1, JSON.stringify(events));
  assert.deepEqual(wedged[0], {
    type: 'wedged', faults: [FAULT], streak: 0,
    ts: new Date(100).toISOString(), shift: 'box', shiftId: 'shf_unit',
  }, 'streak 0 marks this as the boot check rather than a poll one');
  assert.ok(
    errors.some((line) => line.includes(FAULT.message)),
    `the operator-facing fix must reach stderr: ${JSON.stringify(errors)}`,
  );
});

test('a healthy host at boot does not stop the shift', async () => {
  const events: ShiftEvent[] = [];
  const hub = mockHub(async () => ({ text: '', cursor: 1, changed: false }));
  const loop = createShiftLoop(baseOpts(hub, {
    once: true,
    onEvent: (event) => events.push(event),
    hostPreflight: () => [],
  }));

  assert.equal(await loop.run(), 0);
  assert.deepEqual(events.filter((event) => event.type === 'wedged'), []);
});

test('three consecutive hub failures ask whether the fault is local, and a fault stops the shift', async () => {
  const events: ShiftEvent[] = [];
  let checks = 0;
  const loop = createShiftLoop(baseOpts(mockHub(alwaysFailingWake()), {
    onEvent: (event) => events.push(event),
    hostPreflight: () => {
      checks += 1;
      return [FAULT];
    },
  }));

  await loop.iterate();
  await loop.iterate();
  assert.equal(checks, 0, 'one or two transient failures do not pay for a check');
  assert.deepEqual(events.filter((event) => event.type === 'wedged'), []);

  await loop.iterate();
  assert.equal(checks, 1);
  const wedged = events.filter((event) => event.type === 'wedged');
  assert.equal(wedged.length, 1, JSON.stringify(events));
  assert.equal(wedged[0]!.streak, 3, 'the streak is the evidence that PROMPTED the check');
});

test('a shift wedged mid-run exits non-zero', async () => {
  const loop = createShiftLoop(baseOpts(mockHub(alwaysFailingWake()), {
    hostPreflight: () => [FAULT],
  }));
  // `run` loops until something stops it; wedging is what stops it here, and the
  // exit code is the only thing a supervisor sees.
  assert.equal(await loop.run(), 1);
});

test('a rate-limited hub NEVER advances the streak', async () => {
  // THE FLEET-SAFETY PROPERTY, and the most important assertion in this file. A
  // 429 — and the Cloudflare 1015 ban that a busy fleet earns itself — is the
  // server saying "come back later", which is recoverable degradation that
  // clears without an operator. A shift that counted these toward a wedge would
  // take the whole fleet down for a condition the fleet caused.
  const events: ShiftEvent[] = [];
  let checks = 0;
  const loop = createShiftLoop(baseOpts(mockHub(async () => {
    // Retry-After 0 so the shift's own backoff does not suppress the next
    // poll — this test is about the STREAK, and a suppressed poll would prove
    // nothing about what a repeated 429 does to it.
    throw new HubError(429, 'rate limited', 'rate_limited', 0);
  }), {
    onEvent: (event) => events.push(event),
    hostPreflight: () => {
      checks += 1;
      return [FAULT];
    },
  }));

  for (let i = 0; i < 6; i += 1) await loop.iterate();

  assert.equal(checks, 0, 'a sanctioned refusal is not evidence of a broken host');
  assert.deepEqual(events.filter((event) => event.type === 'wedged'), []);
  assert.equal(
    events.filter((event) => event.type === 'hub-error').length, 6,
    'every failure is still RECORDED — excluded from the streak is not excluded from the log',
  );
});

test('a successful wake resets the streak', async () => {
  // The loop's one unconditional hub call per unbackoffed tick, so its success
  // is the cheapest honest proof that this host can reach the hub.
  let checks = 0;
  let calls = 0;
  const loop = createShiftLoop(baseOpts(mockHub(async () => {
    calls += 1;
    if (calls === 3) return { text: '', cursor: 1, changed: false };
    throw new Error('fetch failed');
  }), {
    hostPreflight: () => {
      checks += 1;
      return [FAULT];
    },
  }));

  // Fail, fail, SUCCEED, fail, fail — five ticks, never three consecutive.
  for (let i = 0; i < 5; i += 1) await loop.iterate();
  assert.equal(checks, 0);
});

test('the check is repeated on a later streak, not only at the first crossing', async () => {
  // A host can break at failure seven — a laptop that sleeps, reboots and
  // resumes with the shift's process still alive is the shape that was measured.
  // A shift that checked once at failure three and never again would sit through
  // exactly the fault this unit exists to name.
  let checks = 0;
  const loop = createShiftLoop(baseOpts(mockHub(alwaysFailingWake()), {
    hostPreflight: () => {
      checks += 1;
      return [];
    },
  }));

  for (let i = 0; i < 6; i += 1) await loop.iterate();
  assert.equal(checks, 2, 'checked at failure 3 and again at failure 6');
});

test('a pre-flight that itself throws is reported and the shift keeps working', async () => {
  // "I could not determine whether the host is broken" is not evidence that it
  // is. Killing a working shift over an unreadable stat would be a worse failure
  // than the one being detected.
  const events: ShiftEvent[] = [];
  const errors: string[] = [];
  const loop = createShiftLoop(baseOpts(mockHub(alwaysFailingWake()), {
    onEvent: (event) => events.push(event),
    err: (line) => errors.push(line),
    hostPreflight: () => {
      throw new Error('stat exploded');
    },
  }));

  for (let i = 0; i < 3; i += 1) await loop.iterate();

  assert.deepEqual(events.filter((event) => event.type === 'wedged'), []);
  assert.ok(
    errors.some((line) => line.includes('host pre-flight failed to run') && line.includes('stat exploded')),
    JSON.stringify(errors),
  );
});

test('a hub error carries its cause chain, so a local fault stops reading as a network one', async () => {
  // Node's fetch reports EVERY transport failure as the bare string `fetch
  // failed` and puts the real reason on `cause`. Dropping it makes a dead local
  // host, an unreachable hub and a DNS failure produce byte-identical records —
  // which is precisely how the wedge stayed unattributed.
  const events: ShiftEvent[] = [];
  const loop = createShiftLoop(baseOpts(mockHub(async () => {
    throw new Error('fetch failed', {
      cause: new Error('spawn /var/folders/gone/T ENOENT', { cause: new Error('ENOENT') }),
    });
  }), {
    onEvent: (event) => events.push(event),
    hostPreflight: () => [],
  }));

  await loop.iterate();
  const [hubError] = events.filter((event) => event.type === 'hub-error');
  assert.equal(
    hubError!.message,
    'fetch failed: spawn /var/folders/gone/T ENOENT: ENOENT',
  );
});

test('a self-referential cause chain terminates instead of hanging the emitter', async () => {
  const events: ShiftEvent[] = [];
  const loop = createShiftLoop(baseOpts(mockHub(async () => {
    const e = new Error('fetch failed');
    (e as { cause?: unknown }).cause = e;
    throw e;
  }), {
    onEvent: (event) => events.push(event),
    hostPreflight: () => [],
  }));

  await loop.iterate();
  const [hubError] = events.filter((event) => event.type === 'hub-error');
  assert.equal(hubError!.message, 'fetch failed');
});

// --- checkHost itself -------------------------------------------------------

function probe(over: Partial<FsProbe> = {}): FsProbe {
  return { exists: () => true, isDirectory: () => true, isWritable: () => true, ...over };
}

test('checkHost reports a vanished temp directory with the operator fix in the message', async () => {
  const faults = checkHost({ tempDir: '/gone' }, probe({ exists: () => false }));
  assert.equal(faults.length, 1);
  assert.equal(faults[0]!.kind, 'missing');
  assert.equal(faults[0]!.role, 'temp-dir');
  assert.equal(faults[0]!.path, '/gone');
  assert.ok(faults[0]!.message.includes('reboot'), faults[0]!.message);
});

test('checkHost separates missing from unwritable, because the fixes differ', async () => {
  const missing = checkHost({ tempDir: '/gone' }, probe({ exists: () => false }));
  assert.deepEqual(missing.map((f) => f.kind), ['missing']);

  const unwritable = checkHost({ tempDir: '/gone' }, probe({ isWritable: () => false }));
  assert.deepEqual(unwritable.map((f) => f.kind), ['unwritable']);

  const notADir = checkHost({ tempDir: '/gone' }, probe({ isDirectory: () => false }));
  assert.deepEqual(notADir.map((f) => f.kind), ['not-a-directory']);
});

test('checkHost falls back to the live TMPDIR when given no path', async () => {
  // The shift resolves its temp directory the same way, so a check told nothing
  // must ask the same question the shift itself is answering.
  const seen: string[] = [];
  checkHost({}, probe({ exists: (p) => { seen.push(p); return true; } }));
  assert.deepEqual(seen, [tmpdir()]);
});

test('checkHost checks the temp directory and NOTHING the shift creates itself', async () => {
  // The state directory, the bundle cache and the work root are all mkdir -p'd
  // on demand, so their absence is a fresh install rather than a fault. An
  // earlier draft checked the work root and refused to start every clean shift;
  // the suite caught it. One probe call is the cheapest proof that has not
  // silently come back.
  let probes = 0;
  checkHost({ tempDir: '/a' }, probe({ exists: () => { probes += 1; return true; } }));
  assert.equal(probes, 1);
});

test('a healthy host yields an empty array, which means "no LOCAL fault" and not "healthy"', async () => {
  assert.deepEqual(checkHost({ tempDir: '/a' }, probe()), []);
});
