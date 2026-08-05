/**
 * DRILL — AGENT DISPATCH (Phase 3 acceptance, Phase 5 invariant).
 *
 * THE CLAIM UNDER TEST: an AGENT order is handled end to end by a detached
 * `owenloop work agent-run` child, and NOTHING is written to any agent-definition
 * directory and NO lean order is emitted. Phase 3 made that the behaviour under
 * a flag; Phase 5 deleted the legacy stamp path entirely, so it is now simply
 * how an agent order is run — there is no other lane to fall back to.
 *
 * The negative assertion is made the strongest way available: the fixture pins
 * `HOME` (and `os.homedir()` reads `HOME` on POSIX), so every default
 * home-relative location a stamped file could ever land in sits inside the
 * throwaway fixture home. The drill walks that whole home tree and asserts not
 * one per-order agent-definition `.md` file exists anywhere in it. A regression
 * that resurrects stamping — to a default location, a hard-coded path, or
 * anywhere else under the home — fails here.
 *
 * THE CRITICAL INVARIANT it also proves: the runner learns that the task is done
 * from the HUB LEASE OUTCOME, never from the harness stream. The scripted fake
 * harness ends its turn (`turn_ended`, then `start` settles) while the hub still
 * reports the order CLAIMED and unfinished. Only when a later `get_order` carries
 * `lease.outcome` does the runner record `submitted`. Turn end alone would leave
 * the session store at `turn-ended`.
 *
 * Credential path: owenloop file store (no OWENLOOP_TOKEN), as every drill.
 */
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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
import { readSessions, sessionsPath } from '../src/harness/session-store.ts';
import type { OrderPacket, WorkOrder } from '../src/hub/types.ts';
import { startMockHub, until } from './helpers/mcp-stdio-client.ts';
import { isShiftError } from '../src/shift/protocol.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { DRILL_AUTH, fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const DEMO_HASH = 'abcdef1234567890';
const TPL_CONTENT = '---\nname: x\n---\n\nstep brief\n';

/**
 * The DELETED stamp path's per-order file naming convention
 * (`<order8>-<step>-<hash8>.md`). Kept only as the shape the negative assertion
 * below hunts for: nothing may ever write a file matching it again.
 */
const STAMPED_RE = /^[0-9a-f]{8}-.+\.md$/;

/** The harness-module test seam target, as an absolute path. */
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));

const ORDER: WorkOrder = {
  workflow: 'wf1',
  run: 'run_x1234',
  step: 'builder',
  consumes: {},
  expected_outputs: [{ path: 'pr' }],
  feedback: [],
  advisory: {},
  submit_hint: 'submit pr',
};

/** What `get_order` re-serves to the agent-run child. No `executor`/`command` ⇒ AGENT. */
let localDefDigest = '';

function packet(): OrderPacket {
  return {
    run: 'run_x1234',
    workflow: 'wf1',
    step: 'builder',
    key: 'k',
    inputs: [],
    outputs: ['pr'],
    defDigest: localDefDigest,
    consumes: {},
    owes: [{ path: 'pr', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
}

let root: string;
let home: string;
let cacheDir: string;
let stateDir: string;
let tracePath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-drill-rd-'));
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

/** Every file under `dir`, absolute, recursively. A missing dir reads as empty. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((e) => join(dir, e))
    .filter((p) => statSync(p).isFile());
}

/** Read the fake harness's call trace (one JSON object per line). */
function traceCalls(): Array<Record<string, unknown>> {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function spawnDaemon(origin: string): ShiftChild {
  // NOTE: the fixture HOME is what makes every default home-relative location
  // observable to the negative assertion below.
  return spawnShift(
    [
      'crew-a', '--origin', origin, '--cap', '3',
      '--poll-interval', '25', '--state-dir', stateDir,
    ],
    fixtureEnv(home, {
      OWENLOOP_CACHE_DIR: cacheDir, // the child gets no --cache-dir flag; env is the channel
      OWENLOOP_HARNESS_MODULE: FAKE_HARNESS,
      // PHASE 4 made the composition root import the real adapters, so the
      // registry is no longer empty and the FIRST-REGISTERED default is no
      // longer the module this seam loads. The drill therefore NAMES the
      // harness it means, at the `OWENLOOP_HARNESS` rank — which is also the
      // honest shape: a drill that silently inherited whatever happened to be
      // imported first was passing for a reason it never asserted.
      OWENLOOP_HARNESS: 'fake',
      OWENLOOP_FAKE_TRACE: tracePath,
      OWENLOOP_FAKE_SCRIPT: JSON.stringify({ id: 'fake', start: { events: [{ kind: 'turn_ended' }] } }),
    }),
  );
}

test('an AGENT order is run by a detached agent-run child, with nothing stamped and no lean order', async () => {
  await seedCache();
  let wakes = 0;
  let getOrders = 0;
  const { origin, reqs, server } = await startMockHub((verb, body) => {
    switch (verb) {
      case 'wake':
        return { text: '', cursor: 1, changed: wakes++ === 0 };
      case 'whats_next':
        // Public shift startup has no --workflow flag, so the first request is
        // inbox discovery; later requests carry workflow wf1.
        if (body?.workflow === undefined) return { text: '', instances: [{ workflow: 'wf1' }] };
        // Served to BOTH readers: the shift (which dispatches the order) and the
        // agent-run child (which reads only `def`, to locate its template).
        return { text: '', workflow: 'wf1', def: 'demo', orders: [ORDER] };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'get_order':
        // #1 establishes the hold. #2 is the first CONFIRM poll after the turn
        // ended — still CLAIMED, still no outcome, i.e. the hub has not seen a
        // submit yet. Only #3 (one confirm interval later) carries the outcome.
        // Withholding it for one full poll is deliberate: it proves the runner
        // keeps confirming past turn end instead of reading the harness stream.
        return getOrders++ < 2
          ? { text: '', workflow: 'wf1', run: 'run_x1234', order: packet(), lease: { claimed: true } }
          : { text: '', workflow: 'wf1', run: 'run_x1234', order: packet(), lease: { claimed: false, outcome: 'ok' } };
      case 'heartbeat':
        return { text: '', ok: true };
      default:
        return { text: '' };
    }
  });
  seedCredentialStore(home, origin);
  const daemon = spawnDaemon(origin);
  try {
    await daemon.ready;

    // The shift park. Started, NOT awaited: the sweep that dispatches happens
    // inside it, and the child's in-flight record only exists while the child is
    // alive — so it must be read during the park, not after.
    const parked = daemon.request({ op: 'next', wait_ms: 5_000 });

    // A real detached child was spawned and recorded as one.
    await until(
      () => readChildRecords(stateDir).length === 1,
      `the agent-run child record; stderr:\n${daemon.stderr()}`,
    );
    const rec = readChildRecords(stateDir)[0]!;
    assert.equal(rec.kind, 'agent-run');
    assert.equal(rec.run, 'run_x1234');
    assert.equal(rec.step, 'builder');
    assert.ok(rec.pid > 0, 'the record carries the real child pid');

    // A session asking for work gets NO order handle back, because the order
    // was handed to a detached runner. Since Phase 5 that is unconditional —
    // `whats_next` returns only the capacity view, with no `orders` field at all.
    const res = await parked;
    assert.equal(isShiftError(res), false, `next failed: ${JSON.stringify(res)}; stderr:\n${daemon.stderr()}`);
    if (isShiftError(res) || !('events' in res)) throw new Error('unexpected shift response');
    assert.equal(res.events.some((event) => event.type === 'dispatched'), true, 'next reports the dispatch event');
    assert.equal(reqs[0]!.auth, DRILL_AUTH, 'first hub request carried the store token');

    // The child reached the harness through the registry seam.
    await until(() => traceCalls().some((c) => c['call'] === 'start'), 'the agent-run child to start the harness');
    const start = traceCalls().find((c) => c['call'] === 'start')!;
    assert.equal(start['harnessId'], 'fake');
    assert.match(String(start['brief']), /step brief/, 'the normalized step brief reached the step agent');

    // The step agent's own submit channel: an `owenloop work hold --mcp` mount bound
    // to THIS order. That mount is how `submit` reaches the hub — which is why
    // the hub, not the stream, is the runner's completion signal.
    const mcpMount = start['mcp'] as { command: string; args: string[] };
    assert.equal(mcpMount.command, 'owenloop');
    assert.equal(mcpMount.args[0], 'work');
    assert.ok(mcpMount.args.includes('--mcp'));
    assert.ok(mcpMount.args.includes('wf1/run_x1234'));
    // Stripping OWENLOOP_TOKEN from the child env LANDED in Phase 6
    // (`filterOwenloopEnv`, asserted in `test/child-env.test.ts` and on the
    // runner seam in `test/agent-run-role.test.ts`). This assertion covers the
    // OTHER channel and still has to: an env filter cannot reach argv, so a
    // credential passed as a mount ARGUMENT would sail straight past it.
    const flatArgs = mcpMount.args.join(' ');
    assert.equal(/--token|OWENLOOP_TOKEN|Bearer/.test(flatArgs), false, `credential in MCP argv: ${flatArgs}`);
    assert.equal(flatArgs.includes('drill_agent_tok'), false, 'the store token never reaches the step agent\'s argv');

    // THE INVARIANT: the turn ended, but the runner did not call it done until
    // the HUB said so. The session store's terminal status is the proof.
    const sessions = sessionsPath(cacheDir);
    await until(
      () => readSessions(sessions).some((s) => s.status === 'submitted'),
      `the runner to confirm the submit with the hub (sessions: ${JSON.stringify(readSessions(sessions).map((s) => s.status))})`,
      15_000,
    );
    const statuses = readSessions(sessions).map((s) => s.status);
    assert.deepEqual(statuses, ['active', 'turn-ended', 'submitted'], 'turn end precedes, and does not imply, task end');
    assert.ok(getOrders >= 3, 'the outcome came from a CONFIRM get_order, not from the harness stream');

    // THE ACCEPTANCE ASSERTION: not one per-order agent-definition file anywhere
    // under the fixture home, which contains every default home-relative
    // location the deleted stamp path could have written to.
    const stamped = walk(home).filter((p) => STAMPED_RE.test(p.split(sep).pop()!));
    assert.deepEqual(stamped, [], 'an agent order must write NO per-order agent-definition file');

    // And the hub was never asked to hand the order back.
    assert.equal(reqs.filter((r) => r.verb === 'release').length, 0, 'a submitted order is not released');

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
