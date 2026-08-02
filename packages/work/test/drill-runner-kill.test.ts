/**
 * DRILL — RUNNER KILLED MID-TURN.
 *
 * The failure mode: an `owenloop work agent-run` child is holding a claimed order
 * with a LIVE harness session when the machine (or an operator, or a restart)
 * takes it down. Two things must happen, in this order, or the order strands
 * until its lease TTL expires and a live model session is left orphaned:
 *   1. the runner tears the harness session down (`adapter.stop`), and
 *   2. it hands the order back to the hub (a targeted `release`).
 *
 * The fake harness is scripted with `hang: true`: `start` emits `started` and
 * then NEVER settles, which is exactly a turn still in flight. The hub keeps
 * reporting the order CLAIMED with no outcome throughout, so nothing but the
 * signal can end this run — no path here can be mistaken for a submit.
 *
 * Contrast with the dispatch drill: THAT one ends via the hub's lease outcome
 * and deliberately does NOT release. This one has no outcome, so it MUST.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import { readChildRecords } from '../src/proxy/state.ts';
import { readSessions, sessionsPath } from '../src/harness/session-store.ts';
import type { OrderPacket, WorkOrder } from '../src/hub/types.ts';
import { startMockHub, until } from './helpers/mcp-stdio-client.ts';
import { isShiftError } from '../src/shift/protocol.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const DEMO_HASH = 'abcdef1234567890';
const TPL_CONTENT = '---\nname: x\n---\n\nstep brief\n';
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));

const ORDER: WorkOrder = {
  workflow: 'wf1', run: 'run_x1234', step: 'builder', prompt: 'build it',
  consumes: {}, expected_outputs: [{ path: 'pr' }], feedback: [], advisory: {}, submit_hint: 'submit pr',
};

const PACKET: OrderPacket = {
  run: 'run_x1234', workflow: 'wf1', step: 'builder', key: 'k', inputs: [], outputs: ['pr'],
  prompt: 'build it', consumes: {},
  owes: [{ path: 'pr', acceptance: 'a', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
};

let root: string;
let home: string;
let cacheDir: string;
let stateDir: string;
let tracePath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-drill-rk-'));
  home = join(root, 'home');
  cacheDir = join(root, 'cache');
  stateDir = join(root, 'state');
  tracePath = join(root, 'harness-trace.jsonl');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedCache(): void {
  const tpl: NormalizedStepSpec = { step: 'builder', brief: TPL_CONTENT, permissions: { extensions: {} } };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: DEMO_HASH, steps: [{ name: 'builder', body: '' }] },
    fetchedAt: 0,
    origin: 'seed',
  };
  writeBundle(cacheDir, bundle, [tpl]);
}

function traceCalls(): Array<Record<string, unknown>> {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function spawnDaemon(origin: string): ShiftChild {
  return spawnShift(
    [
      'crew-a', '--origin', origin, '--cap', '3',
      '--poll-interval', '25',
      '--state-dir', stateDir,
    ],
    fixtureEnv(home, {
      OWENLOOP_CACHE_DIR: cacheDir,
      OWENLOOP_HARNESS_MODULE: FAKE_HARNESS,
      // PHASE 4 made the composition root import the real adapters, so the
      // registry is no longer empty and the FIRST-REGISTERED default is no
      // longer the module this seam loads. The drill therefore NAMES the
      // harness it means, at the `OWENLOOP_HARNESS` rank — which is also the
      // honest shape: a drill that silently inherited whatever happened to be
      // imported first was passing for a reason it never asserted.
      OWENLOOP_HARNESS: 'fake',
      OWENLOOP_FAKE_TRACE: tracePath,
      // hang: the turn never ends on its own — only the signal can end this run.
      OWENLOOP_FAKE_SCRIPT: JSON.stringify({ id: 'fake', hang: true }),
    }),
  );
}

test('SIGTERM to a runner mid-turn tears the harness session down and releases the order', async () => {
  seedCache();
  let wakes = 0;
  const { origin, reqs, server } = await startMockHub((verb, body) => {
    switch (verb) {
      case 'wake':
        return { text: '', cursor: 1, changed: wakes++ === 0 };
      case 'whats_next':
        if (body?.workflow === undefined) return { text: '', instances: [{ workflow: 'wf1' }] };
        return { text: '', workflow: 'wf1', def: 'demo', orders: [ORDER] };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'get_order':
        // ALWAYS claimed, NEVER an outcome — no submit ever lands here.
        return { text: '', workflow: 'wf1', run: 'run_x1234', order: PACKET, lease: { claimed: true } };
      case 'heartbeat':
        return { text: '', ok: true };
      case 'release':
        return { text: '', released: true, workflow: 'wf1', run: 'run_x1234' };
      default:
        return { text: '' };
    }
  });
  seedCredentialStore(home, origin);
  const daemon = spawnDaemon(origin);
  let pid = 0;
  try {
    await daemon.ready;
    const parked = daemon.request({ op: 'next', wait_ms: 3_000 });

    await until(
      () => readChildRecords(stateDir).length === 1,
      `the agent-run child record; stderr:\n${daemon.stderr()}`,
    );
    pid = readChildRecords(stateDir)[0]!.pid;

    // The turn is genuinely in flight before the signal: the harness reports
    // `hanging` only after `start` emitted and withheld its promise.
    await until(() => traceCalls().some((c) => c['call'] === 'hanging'), 'the harness turn to be in flight');
    assert.equal(traceCalls().some((c) => c['call'] === 'stop'), false, 'not torn down before the signal');
    assert.equal(reqs.some((r) => r.verb === 'release'), false, 'not released before the signal');

    // FAILURE INJECTED.
    process.kill(pid, 'SIGTERM');

    await until(() => traceCalls().some((c) => c['call'] === 'stop'), 'the harness session teardown', 10_000);
    await until(() => reqs.some((r) => r.verb === 'release'), 'the targeted release', 10_000);

    const rel = reqs.find((r) => r.verb === 'release')!;
    assert.deepEqual(rel.body, { workflow: 'wf1', run: 'run_x1234' }, 'a targeted release, not a session drain');

    // The session store records the attempt as dead, not submitted — a killed
    // runner never claims the task finished.
    const sessions = readSessions(sessionsPath(cacheDir));
    assert.ok(sessions.length > 0, 'the attempt was recorded');
    assert.equal(sessions.at(-1)!.status, 'dead');
    assert.equal(sessions.some((s) => s.status === 'submitted'), false, 'a kill is never a submit');
    assert.equal(sessions[0]!.harness, 'fake');

    const next = await parked;
    assert.equal(isShiftError(next), false, `next failed: ${JSON.stringify(next)}`);
    await daemon.request({ op: 'end' });
    assert.equal(await daemon.exited, 0, `exit 0 after end, stderr:\n${daemon.stderr()}`);
  } finally {
    server.close();
    daemon.child.kill('SIGKILL');
    for (const r of readChildRecords(stateDir)) {
      try {
        process.kill(r.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});
