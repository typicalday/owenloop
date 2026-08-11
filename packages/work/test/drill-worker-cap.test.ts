/**
 * DRILL — THE agent-run CONCURRENCY CAP.
 *
 * `dispatchCap` (`--cap`) meters `exec` children. An agent turn is long-lived
 * and memory-heavy where a command order is short, so runner dispatch gets its
 * OWN budget: `maxConcurrentAgents` (`--max-agents`). This drill proves the two
 * are genuinely separate — the global cap is set high enough that it cannot be
 * what bites — and that over-cap candidates are LEFT FOR A LATER SWEEP rather
 * than dropped, released, or stamped.
 *
 * All three orders' harness sessions hang, so the one dispatched runner stays
 * in flight for the whole drill and the cap keeps applying on every later sweep.
 */
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { installBundleFixture, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { readChildRecords } from '../src/shift/state.ts';
import type { OrderPacket, WorkOrder } from '../src/hub/types.ts';
import { startMockHub, until } from './helpers/mcp-stdio-client.ts';
import { isShiftError } from '../src/shift/protocol.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const DEMO_HASH = 'abcdef1234567890';
const TPL_CONTENT = '---\nname: x\n---\n\nstep brief\n';
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));

const RUNS = ['run_aaaa1111', 'run_bbbb2222', 'run_cccc3333'];

function wo(run: string): WorkOrder {
  return {
    workflow: 'wf1', run, step: 'builder',
    consumes: {}, expected_outputs: [{ path: 'pr' }], feedback: [], advisory: {}, submit_hint: 'submit pr',
  };
}

function packet(run: string): OrderPacket {
  return {
    run, workflow: 'wf1', step: 'builder', key: 'k', inputs: [], outputs: ['pr'],
    defDigest: localDefDigest, consumes: {},
    owes: [{ path: 'pr', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
}

let root: string;
let localDefDigest = '';
let home: string;
let cacheDir: string;
let stateDir: string;
let tracePath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-drill-rc-'));
  home = join(root, 'home');
  cacheDir = join(root, 'cache');
  stateDir = join(root, 'state');
  tracePath = join(root, 'harness-trace.jsonl');
});
function makeWritableTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) makeWritableTree(join(path, child));
    chmodSync(path, 0o755);
  } else {
    chmodSync(path, 0o644);
  }
}

afterEach(() => {
  if (existsSync(root)) makeWritableTree(root);
  rmSync(root, { recursive: true, force: true });
});

async function seedCache(): Promise<void> {
  const tpl: NormalizedStepSpec = { step: 'builder', brief: TPL_CONTENT, permissions: { extensions: {} } };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: DEMO_HASH, steps: [{ name: 'builder', body: '' }] },
    fetchedAt: 0,
    origin: 'seed',
  };
  writeBundle(cacheDir, bundle, [tpl]);
  const workflow = `name: demo
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: builder
    consumes: [seed]
    produces: [pr]
    terminal: true
    executor: agent
    body: |
${TPL_CONTENT.split('\n').map((line) => `      ${line}`).join('\n')}
    x:
      harness:
        id: fake
`;
  const sourceDir = writeBundleSource({ name: 'demo', workflow });
  const installed = await installBundleFixture({ sourceDir, root: join(home, '.owenloop', 'workflows') });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  localDefDigest = defInstructionDigest(definition);
}

function traceCalls(): Array<Record<string, unknown>> {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function spawnDaemon(origin: string): ShiftChild {
  return spawnShift(
    [
      'crew-a', '--origin', origin,
      // The global cap is deliberately generous: only --max-agents can bite.
      '--cap', '10', '--max-agents', '1',
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
      OWENLOOP_FAKE_SCRIPT: JSON.stringify({ id: 'fake', hang: true }),
    }),
  );
}

test('--max-agents caps in-flight runners; over-cap claimed orders queue for local dispatch', async () => {
  await seedCache();
  let wakes = 0;
  const { origin, reqs, server } = await startMockHub((verb, body) => {
    switch (verb) {
      case 'wake':
	// Two "changed" wakes prove the local queue remains deduplicated even
	// when the hub is polled again while the first child is still running.
        return { text: '', cursor: 1, changed: wakes++ < 2 };
      case 'whats_next':
        if (body?.workflow === undefined) return { text: '', instances: [{ workflow: 'wf1' }] };
        return { text: '', workflow: 'wf1', def: 'demo', orders: RUNS.map(wo) };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'get_order': {
        const run = String((body as Record<string, unknown> | undefined)?.['run'] ?? RUNS[0]);
        return { text: '', workflow: 'wf1', run, order: packet(run), lease: { claimed: true } };
      }
      case 'heartbeat':
        return { text: '', ok: true };
      case 'release':
        return { text: '', released: true };
      default:
        return { text: '' };
    }
  });
  seedCredentialStore(home, origin);
  const daemon = spawnDaemon(origin);
  try {
    await daemon.ready;
    const parked = daemon.request({ op: 'next', wait_ms: 3_000 });

    await until(
      () => readChildRecords(stateDir).length === 1,
      `the first agent-run child record; stderr:\n${daemon.stdout()}`,
    );
    await until(
      () => /at the agent-run cap \(1\)/.test(daemon.stdout()),
      `the cap message; stderr:\n${daemon.stdout()}`,
    );

    const res = await parked;
    assert.equal(isShiftError(res), false, `next failed: ${JSON.stringify(res)}`);
    if (isShiftError(res) || !('events' in res)) throw new Error('unexpected shift response');
    assert.equal(res.events.some((event) => event.type === 'dispatched'), true, 'next reports the dispatch event');

    // Exactly ONE runner, across every sweep in the park window.
    const recs = readChildRecords(stateDir);
    assert.equal(recs.length, 1, `expected exactly one runner, got ${JSON.stringify(recs)}`);
    assert.equal(recs[0]!.kind, 'agent-run');
    // The single recorded child really did reach a harness — and only it did.
    // The child is a DETACHED process, so its first trace line lands strictly
    // after the record does; wait for the one start rather than racing it.
    const starts = (): Array<Record<string, unknown>> => traceCalls().filter((c) => c['call'] === 'start');
    await until(() => starts().length >= 1, `the capped runner to start its harness; stderr:\n${daemon.stdout()}`);
    assert.equal(starts().length, 1, `only one harness session was started; trace:\n${JSON.stringify(traceCalls(), null, 1)}`);

    // The over-cap claims remain owned by this Shift's local queue: nothing was
    // released and the cap message was logged for each queued candidate.
    assert.equal(reqs.some((r) => r.verb === 'release'), false, 'a capped order is left offered, never handed back');
    const capLines = daemon.stdout().split('\n').filter((l) => /at the agent-run cap \(1\)/.test(l));
    assert.ok(capLines.length >= 2, `expected a cap line per skipped candidate, got:\n${capLines.join('\n')}`);
    assert.ok(
      capLines.every((l) => /queued for local dispatch/.test(l)),
      'the message must say the claimed order is locally queued, not dropped',
    );

    await daemon.request({ op: 'end' });
    assert.equal(await daemon.exited, 0, `exit 0 after end, stderr:\n${daemon.stdout()}`);
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
