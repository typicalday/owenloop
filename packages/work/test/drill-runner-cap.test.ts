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
import type { OrderPacket, WorkOrder } from '../src/hub/types.ts';
import { callTool, handshake, spawnMcp, startMockHub, until, type McpChild } from './helpers/mcp-stdio-client.ts';
import { fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const DEMO_HASH = 'abcdef1234567890';
const TPL_CONTENT = '---\nname: x\n---\n\nstep brief\n';
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));

const RUNS = ['run_aaaa1111', 'run_bbbb2222', 'run_cccc3333'];

function wo(run: string): WorkOrder {
  return {
    workflow: 'wf1', run, step: 'builder', prompt: 'build it',
    consumes: {}, expected_outputs: [{ path: 'pr' }], feedback: [], advisory: {}, submit_hint: 'submit pr',
  };
}

function packet(run: string): OrderPacket {
  return {
    run, workflow: 'wf1', step: 'builder', key: 'k', inputs: [], outputs: ['pr'],
    prompt: 'build it', consumes: {},
    owes: [{ path: 'pr', acceptance: 'a', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
}

let root: string;
let home: string;
let cacheDir: string;
let stateDir: string;
let tracePath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenwork-drill-rc-'));
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

function spawnProxy(origin: string): McpChild {
  return spawnMcp(
    [
      'proxy', '--mcp', '--origin', origin, '--workflow', 'wf1',
      // The global cap is deliberately generous: only --max-agents can bite.
      '--cap', '10', '--max-agents', '1',
      '--poll-interval', '25',
      '--state-dir', stateDir,
    ],
    fixtureEnv(home, {
      OWENWORK_CACHE_DIR: cacheDir,
      OWENWORK_HARNESS_MODULE: FAKE_HARNESS,
      // PHASE 4 made the composition root import the real adapters, so the
      // registry is no longer empty and the FIRST-REGISTERED default is no
      // longer the module this seam loads. The drill therefore NAMES the
      // harness it means, at the `OWENWORK_HARNESS` rank — which is also the
      // honest shape: a drill that silently inherited whatever happened to be
      // imported first was passing for a reason it never asserted.
      OWENWORK_HARNESS: 'fake',
      OWENWORK_FAKE_TRACE: tracePath,
      OWENWORK_FAKE_SCRIPT: JSON.stringify({ id: 'fake', hang: true }),
    }),
  );
}

test('--max-agents caps in-flight runners; over-cap AGENT orders wait for a later sweep', async () => {
  seedCache();
  let wakes = 0;
  const { origin, reqs, server } = await startMockHub((verb, body) => {
    switch (verb) {
      case 'wake':
        // Two "changed" wakes, so the cap is re-applied on a SECOND sweep and
        // the skipped orders are proven still-offerable, not consumed.
        return { text: '', cursor: 1, changed: wakes++ < 2 };
      case 'whats_next':
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
  const mcp = spawnProxy(origin);
  try {
    await handshake(mcp);
    const parked = callTool(mcp, 'whats_next', { wait_ms: 3_000 });

    await until(
      () => readChildRecords(stateDir).length === 1,
      `the first agent-run child record; stderr:\n${mcp.stderr()}`,
    );
    await until(
      () => /at the agent-run cap \(1\)/.test(mcp.stderr()),
      `the cap message; stderr:\n${mcp.stderr()}`,
    );

    const res = await parked;
    assert.equal(res.isError, false, `whats_next failed: ${JSON.stringify(res.body)}`);
    // Nor are the over-cap orders handed back as order handles: since Phase 5
    // `whats_next` returns only the capacity view, never an order to pick up.
    assert.equal(res.body.orders, undefined, 'whats_next returns no order handles at all');

    // Exactly ONE runner, across every sweep in the park window.
    const recs = readChildRecords(stateDir);
    assert.equal(recs.length, 1, `expected exactly one runner, got ${JSON.stringify(recs)}`);
    assert.equal(recs[0]!.kind, 'agent-run');
    // The single recorded child really did reach a harness — and only it did.
    // The child is a DETACHED process, so its first trace line lands strictly
    // after the record does; wait for the one start rather than racing it.
    const starts = (): Array<Record<string, unknown>> => traceCalls().filter((c) => c['call'] === 'start');
    await until(() => starts().length >= 1, `the capped runner to start its harness; stderr:\n${mcp.stderr()}`);
    assert.equal(starts().length, 1, `only one harness session was started; trace:\n${JSON.stringify(traceCalls(), null, 1)}`);

    // The over-cap orders were LEFT, not consumed: nothing was released and the
    // cap message was logged for each of the two skipped candidates.
    assert.equal(reqs.some((r) => r.verb === 'release'), false, 'a capped order is left offered, never handed back');
    const capLines = mcp.stderr().split('\n').filter((l) => /at the agent-run cap \(1\)/.test(l));
    assert.ok(capLines.length >= 2, `expected a cap line per skipped candidate, got:\n${capLines.join('\n')}`);
    assert.ok(
      capLines.every((l) => /leaving for a later sweep/.test(l)),
      'the message must say the order is deferred, not dropped',
    );

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `exit 0 on transport EOF, stderr:\n${mcp.stderr()}`);
  } finally {
    server.close();
    mcp.child.kill('SIGKILL');
    for (const r of readChildRecords(stateDir)) {
      try {
        process.kill(r.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
});
