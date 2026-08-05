/**
 * DRILL — REJECTION RESUME ACROSS PROCESSES (Phase 4 acceptance).
 *
 * THE CLAIM UNDER TEST, in one sentence: when a rejected order is re-offered, a
 * SECOND `owenloop work agent-run` process resumes the session the FIRST one created
 * and sends it ONLY the new rejection reasons — no brief, no prompt, no
 * re-statement of the order.
 *
 * Two real child processes, one after the other, against one mock hub and one
 * shared session store. That is the whole point: the unit tests in
 * `test/agent-resume.test.ts` prove the DECISION with everything injected, and
 * this drill proves the decision survives a process boundary — the session token,
 * the working directory, and the reason watermark all have to travel through
 * `sessions.jsonl` on disk, because nothing else connects the two processes.
 *
 * WHAT EACH FIRING DOES:
 *   firing 1  no prior session ⇒ COLD START. `start` gets the compiled brief.
 *             The hub then reports an outcome, and the run is rejected.
 *   firing 2  the order is re-offered carrying a reason thread ⇒ RESUME.
 *             `deliver` gets the PRIOR token and the delta, and `start` is never
 *             called again.
 *
 * THE NEGATIVE ASSERTION IS THE POINT OF THE PHASE: the `deliver` message must
 * not contain the brief, the prompt, or the submit hint. Re-sending them would
 * spend exactly the tokens this phase exists to save. It is asserted by naming
 * each forbidden string rather than by a size check alone, and by a size check
 * as well.
 *
 * A THIRD CASE PROVES THE TEARDOWN GATE from the other side: when the reaper
 * removes the work directory between the two firings, the second firing must NOT
 * resume — `ensureWorkDir` recreates the same path, so the directory's existence
 * cannot be the thing that refuses, and the reap marks the session `dead` instead.
 *
 * IT ALSO PROVES THE WORK DIRECTORY. Both firings resolve their cwd through
 * `ensureWorkDir` under a `OWENLOOP_WORK_ROOT` this drill controls, so the drill
 * can assert the per-RUN directory was created once, adopted the second time, and
 * is the cwd that reached the harness on BOTH calls. A resume whose cwd moved is
 * not resumable, so "same directory" is a precondition of the claim above.
 *
 * Credential path: owenloop file store (no OWENLOOP_TOKEN), as every drill.
 */
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
import { readSessions, sessionsPath } from '../src/harness/session-store.ts';
import { sweepWorkDirs } from '../src/agent/workdir.ts';
import type { OrderPacket, ReasonEntry, WorkOrder } from '../src/hub/types.ts';
import { startMockHub } from './helpers/mcp-stdio-client.ts';
import { fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const BIN = join(import.meta.dirname, '..', '..', '..', 'bin', 'owenloop.mjs');
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));

const DEMO_HASH = 'abcdef1234567890';
/** The brief body. Every one of these strings is asserted ABSENT from the delta. */
const BRIEF_BODY = 'BRIEF-BODY-MARKER: implement the thing and submit it';
const TPL_CONTENT = `---\nname: x\n---\n\n${BRIEF_BODY}\n`;
const PROMPT = 'PROMPT-MARKER: build it';
const SUBMIT_HINT = 'SUBMIT-HINT-MARKER: submit pr';

const ORDER: WorkOrder = {
  workflow: 'wf1',
  run: 'run_r1',
  step: 'builder',
  consumes: {},
  expected_outputs: [{ path: 'pr' }],
  feedback: [],
  advisory: {},
  submit_hint: SUBMIT_HINT,
};

/** Legacy wire data may still carry prompt, but the driver type cannot read it. */
Object.defineProperty(ORDER, 'prompt', { value: PROMPT, enumerable: true });

const REJECT_1 = 'REASON-ONE: the null check is still missing on the empty-cart path';
const REJECT_2 = 'REASON-TWO: the new test does not fail without the fix';

const reason = (at: number, text: string): ReasonEntry => ({
  at,
  action: 'reject',
  kind: 'judgment',
  by: 'reviewer',
  text,
});

/** The re-served packet. `reasons` is what distinguishes the two firings. */
function packet(reasons: ReasonEntry[]): OrderPacket {
  return {
    run: 'run_r1',
    workflow: 'wf1',
    step: 'builder',
    key: 'k',
    inputs: [],
    outputs: ['pr'],
    defDigest: localDefDigest,
    consumes: {},
    owes: [
      {
        path: 'pr',
        judgmentRejects: reasons.length,
        schemaRejects: 0,
        reasons,
      },
    ],
  };
}

let root = '';
let localDefDigest = '';
let home = '';
let cacheDir = '';
let workRoot = '';
let tracePath = '';

function makeWritableTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) makeWritableTree(join(path, child));
    chmodSync(path, 0o755);
  } else {
    chmodSync(path, 0o644);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-drill-resume-'));
  home = join(root, 'home');
  cacheDir = join(root, 'cache');
  workRoot = join(root, 'work');
  tracePath = join(root, 'harness-trace.jsonl');
});
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
  const installed = await installBundleFixture({ sourceDir, root: join(root, 'workflows') });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  localDefDigest = defInstructionDigest(definition);
}

interface TraceCall {
  call: string;
  [k: string]: unknown;
}

function traceCalls(): TraceCall[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TraceCall);
}

/**
 * Run ONE `owenloop work agent-run` child to completion and return its exit code plus
 * stderr. Not detached and not through the shift: this drill is about what two
 * successive runner processes do with one session store, and going through the
 * shift would add a dispatcher whose behaviour `drill-runner-dispatch` already
 * covers.
 */
function runAgent(origin: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [BIN, 'work', 'agent-run', 'wf1/run_r1', '--origin', origin, '--confirm-interval', '25', '--submit-grace', '10000'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...fixtureEnv(home, {
          OWENLOOP_CACHE_DIR: cacheDir,
          OWENLOOP_WORK_ROOT: workRoot,
          OWENLOOP_HARNESS_MODULE: FAKE_HARNESS,
          // The composition root registers the real vendor adapters on import, so
          // the first-registered default is one of those. Name the fixture
          // adapter at the `OWENLOOP_HARNESS` rank instead of relying on import
          // order, which is not a property this drill is asserting.
          OWENLOOP_HARNESS: 'fake',
          OWENLOOP_FAKE_TRACE: tracePath,
          OWENLOOP_FAKE_SCRIPT: JSON.stringify({
            id: 'fake',
            token: 'tok-session-1',
            start: { events: [{ kind: 'turn_ended' }] },
            deliver: { events: [{ kind: 'turn_ended' }] },
          }),
        }),
      },
    },
  );
  let errBuf = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    errBuf += c;
  });
  child.stdout.on('data', (c: string) => {
    errBuf += c;
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stderr: errBuf }));
  });
}

test('a re-offered rejection resumes the prior session in a NEW process and sends only the delta', async () => {
  await seedCache();

  /** Which firing the hub is serving. Flipped by the test between children. */
  let firing = 1;
  let getOrders = 0;
  const { origin, server } = await startMockHub((verb) => {
    switch (verb) {
      case 'whats_next':
        return { text: '', workflow: 'wf1', def: 'demo', orders: [ORDER] };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'heartbeat':
        return { text: '', ok: true };
      case 'get_order': {
        // Firing 1 sees a clean packet; firing 2 sees the SAME order re-offered
        // with the reviewer's reasons attached. In both, the first response
        // establishes the hold and later ones carry the outcome, so the runner
        // learns the task ended from the HUB, never from the harness stream.
        const owes = firing === 1 ? [] : [reason(900, REJECT_1), reason(901, REJECT_2)];
        const n = getOrders++;
        return n < 1
          ? { text: '', workflow: 'wf1', run: 'run_r1', order: packet(owes), lease: { claimed: true } }
          : {
              text: '',
              workflow: 'wf1',
              run: 'run_r1',
              order: packet(owes),
              lease: { claimed: false, outcome: firing === 1 ? 'reject' : 'ok' },
            };
      }
      default:
        return { text: '' };
    }
  });
  seedCredentialStore(home, origin);

  try {
    // ---- FIRING 1: cold start ------------------------------------------------
    const first = await runAgent(origin);
    assert.equal(first.code, 0, `firing 1 should exit 0; output:\n${first.stderr}`);

    const afterFirst = traceCalls();
    assert.deepEqual(
      afterFirst.filter((c) => c.call === 'start' || c.call === 'deliver').map((c) => c.call),
      ['start'],
      'with no prior session there is nothing to resume',
    );
    const start = afterFirst.find((c) => c.call === 'start')!;
    assert.match(String(start['brief']), new RegExp(BRIEF_BODY), 'the compiled brief reached the step agent');
    assert.ok(
      !String(start['brief']).includes('was rejected'),
      'a first firing carries no rejection section — there is nothing to report yet',
    );

    // The per-RUN work directory was provisioned, and it is the cwd the harness
    // ran in. A resume whose cwd moved is not resumable, so this is load-bearing.
    const runDir = join(workRoot, 'wf1', 'run_r1');
    assert.ok(existsSync(runDir), 'ensureWorkDir created <workRoot>/<workflow>/<run>');
    assert.equal(start['cwd'], runDir);

    const sessionsFile = sessionsPath(cacheDir);
    const rows1 = readSessions(sessionsFile);
    assert.deepEqual(rows1.map((r) => r.status), ['active', 'turn-ended', 'submitted']);
    assert.equal(rows1[0]!.token, 'tok-session-1');
    assert.equal(rows1[0]!.cwd, runDir);
    assert.equal(rows1[0]!.attempt, 1);
    assert.equal(
      rows1[rows1.length - 1]!.deliveredReasonAt,
      undefined,
      'nothing has been delivered, so the watermark is still unset',
    );

    // ---- FIRING 2: the same order, re-offered with reasons --------------------
    firing = 2;
    getOrders = 0;
    const second = await runAgent(origin);
    assert.equal(second.code, 0, `firing 2 should exit 0; output:\n${second.stderr}`);

    const calls = traceCalls().filter((c) => c.call === 'start' || c.call === 'deliver');
    assert.deepEqual(
      calls.map((c) => c.call),
      ['start', 'deliver'],
      'THE CLAIM: the second process RESUMED — it delivered into the existing session and never started a new one',
    );

    const deliver = calls[1]!;
    // Same session, across a process boundary. The only channel that carried the
    // token from the first process to the second is `sessions.jsonl` on disk.
    assert.equal(deliver['token'], 'tok-session-1', 'the resume used the PRIOR session token');
    assert.equal(deliver['cwd'], runDir, 'and the same working directory');
    assert.notEqual(deliver['permissions'], null, 'the widened DeliverArgs carried the permission bag across');

    // ---- THE NEGATIVE ASSERTION: the delta is a DELTA -------------------------
    const message = String(deliver['message']);
    assert.match(message, new RegExp(REJECT_1), 'the new reasons arrived');
    assert.match(message, new RegExp(REJECT_2));
    assert.match(message, /Your submission for `pr` was rejected/);
    assert.match(message, /Revise and submit again/);

    for (const forbidden of [BRIEF_BODY, PROMPT, SUBMIT_HINT, 'consumes', 'expected_outputs']) {
      assert.ok(
        !message.includes(forbidden),
        `the resume delta must not re-send '${forbidden}' — the session already holds it, and re-sending it spends exactly the tokens this phase exists to save`,
      );
    }
    // A size check as well as the named strings: a future regression that
    // re-attached the brief under a different name still fails here.
    assert.ok(
      message.length < BRIEF_BODY.length + 600,
      `the delta should be short; it was ${String(message.length)} chars:\n${message}`,
    );

    // ---- the watermark advanced, and the rows say "same session" -------------
    const rows2 = readSessions(sessionsFile).slice(rows1.length);
    assert.deepEqual(rows2.map((r) => r.status), ['active', 'turn-ended', 'submitted']);
    for (const r of rows2) {
      assert.equal(r.token, 'tok-session-1', 'the second attempt is recorded under the SAME session token');
      assert.equal(r.attempt, 2, 'a new attempt on the same session');
      assert.equal(r.createdAt, rows1[0]!.createdAt, "createdAt is the SESSION's birth, not this attempt's");
    }
    // The watermark advances only AFTER `deliver` resolved. The pre-deliver
    // `active` row therefore still carries the PRIOR value (unset — firing 1
    // delivered no reasons); a process killed between those two rows re-delivers
    // both reasons next time instead of swallowing them.
    assert.deepEqual(
      rows2.map((r) => r.deliveredReasonAt),
      [undefined, 901, 901],
      'the pre-deliver row keeps the prior watermark; only the post-deliver rows advance to the newest reason delivered',
    );

    // The work directory was ADOPTED, not recreated: whatever firing 1 left
    // behind is still what firing 2 worked in.
    assert.ok(existsSync(runDir));
  } finally {
    server.close();
  }
});

test('a SECOND re-offer with no new reasons does not spend a resume turn saying nothing', async () => {
  await seedCache();

  // The reviewer rejected once. The order is re-offered twice with the SAME
  // reason thread — a re-offer for an unrelated reason (a lapsed claim, a
  // restarted runner) must not replay feedback the session has already heard.
  const REASONS = [reason(900, REJECT_1)];
  let getOrders = 0;
  let firing = 1;
  const { origin, server } = await startMockHub((verb) => {
    switch (verb) {
      case 'whats_next':
        return { text: '', workflow: 'wf1', def: 'demo', orders: [ORDER] };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'heartbeat':
        return { text: '', ok: true };
      case 'get_order': {
        const n = getOrders++;
        return n < 1
          ? { text: '', workflow: 'wf1', run: 'run_r1', order: packet(REASONS), lease: { claimed: true } }
          : {
              text: '',
              workflow: 'wf1',
              run: 'run_r1',
              order: packet(REASONS),
              lease: { claimed: false, outcome: firing === 1 ? 'reject' : 'ok' },
            };
      }
      default:
        return { text: '' };
    }
  });
  seedCredentialStore(home, origin);

  try {
    // Firing 1: no prior session, but there ARE reasons ⇒ COLD REPLAY. The brief
    // comes back because the session does not exist yet, and the reasons ride
    // along or the fresh agent repeats the rejected submission verbatim.
    const first = await runAgent(origin);
    assert.equal(first.code, 0, `firing 1 should exit 0; output:\n${first.stderr}`);
    const start1 = traceCalls().find((c) => c.call === 'start')!;
    assert.match(String(start1['brief']), new RegExp(BRIEF_BODY), 'a cold replay still carries the brief');
    assert.match(String(start1['brief']), new RegExp(REJECT_1), 'and the reasons, as a trailing section');
    assert.equal(
      readSessions(sessionsPath(cacheDir)).at(-1)!.deliveredReasonAt,
      900,
      'a cold replay delivers the reasons too, so the watermark advances',
    );

    // Firing 2: the watermark already covers every reason on the packet ⇒ nothing
    // new to say ⇒ COLD START with a bare brief, not a resume with an empty message.
    firing = 2;
    getOrders = 0;
    const second = await runAgent(origin);
    assert.equal(second.code, 0, `firing 2 should exit 0; output:\n${second.stderr}`);

    const calls = traceCalls().filter((c) => c.call === 'start' || c.call === 'deliver');
    assert.deepEqual(calls.map((c) => c.call), ['start', 'start'], 'no deliver — a resume that says nothing is never sent');
    const start2 = calls[1]!;
    assert.ok(
      !String(start2['brief']).includes('was rejected'),
      'and the brief carries no empty rejection section either',
    );
    assert.equal(
      readSessions(sessionsPath(cacheDir)).at(-1)!.deliveredReasonAt,
      900,
      'the watermark is carried FORWARD, never reset — already-delivered reasons must not look undelivered',
    );
  } finally {
    server.close();
  }
});

test('a REAPED work directory makes the session unresumable — the re-offer cold-replays into the recreated tree', async () => {
  await seedCache();

  // The scenario the teardown gate exists for: the run goes quiet longer than the
  // reaper's TTL (a human escalation, a long alarm — both leave no open order),
  // its work directory is reaped, and only THEN is the step re-offered with the
  // reviewer's reasons. `ensureWorkDir` is idempotent, so firing 2 recreates the
  // SAME path — an empty one. Resuming there would have the agent "revise" work
  // whose files no longer exist, which is why the reaper marks the session dead.
  let firing = 1;
  let getOrders = 0;
  const { origin, server } = await startMockHub((verb) => {
    switch (verb) {
      case 'whats_next':
        return { text: '', workflow: 'wf1', def: 'demo', orders: [ORDER] };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'heartbeat':
        return { text: '', ok: true };
      case 'get_order': {
        const owes = firing === 1 ? [] : [reason(900, REJECT_1)];
        const n = getOrders++;
        return n < 1
          ? { text: '', workflow: 'wf1', run: 'run_r1', order: packet(owes), lease: { claimed: true } }
          : {
              text: '',
              workflow: 'wf1',
              run: 'run_r1',
              order: packet(owes),
              lease: { claimed: false, outcome: firing === 1 ? 'reject' : 'ok' },
            };
      }
      default:
        return { text: '' };
    }
  });
  seedCredentialStore(home, origin);

  try {
    // ---- FIRING 1: cold start, and the agent leaves work behind ---------------
    const first = await runAgent(origin);
    assert.equal(first.code, 0, `firing 1 should exit 0; output:\n${first.stderr}`);

    const runDir = join(workRoot, 'wf1', 'run_r1');
    const sessionsFile = sessionsPath(cacheDir);
    writeFileSync(join(runDir, 'work.txt'), 'what the agent built');
    assert.equal(readSessions(sessionsFile).at(-1)!.status, 'submitted', 'a live, resumable session');

    // ---- THE REAP: the real sweep, with the real session store ---------------
    const removed = sweepWorkDirs({
      workRoot,
      workflows: new Set(['wf1']),
      openRunIds: new Set(), // the quiet gap: the hub has no open order for the run
      liveRunIds: new Set(), // and no runner child holds it
      // A second past the last write, so the gap outlasts the (zero) grace
      // window on every filesystem: APFS records mtime with sub-millisecond
      // precision, and `Date.now()` truncates, so a bare `Date.now()` here can
      // read as EARLIER than a directory touched microseconds ago.
      now: Date.now() + 1_000,
      ttlMs: 0,
      sessionsFile,
    });
    assert.deepEqual(removed, [runDir], 'the directory was reaped');
    assert.ok(!existsSync(runDir));
    assert.equal(
      readSessions(sessionsFile).at(-1)!.status,
      'dead',
      'THE INVARIANT: session lifetime = cwd lifetime, so the reap retired the session',
    );

    // ---- FIRING 2: the re-offer, carrying the reviewer's reasons --------------
    firing = 2;
    getOrders = 0;
    const second = await runAgent(origin);
    assert.equal(second.code, 0, `firing 2 should exit 0; output:\n${second.stderr}`);

    const calls = traceCalls().filter((c) => c.call === 'start' || c.call === 'deliver');
    assert.deepEqual(
      calls.map((c) => c.call),
      ['start', 'start'],
      'THE CLAIM: NEVER a deliver — a session whose working directory was removed is not resumable',
    );

    const replay = calls[1]!;
    assert.equal(replay['cwd'], runDir, 'the same path was recreated — which is exactly why `dirExists` cannot be the gate');
    assert.ok(existsSync(runDir));
    assert.ok(!existsSync(join(runDir, 'work.txt')), 'recreated EMPTY: the work the old session was revising is gone');

    // A cold replay, not a bare cold start: the reasons still have to arrive, or
    // the fresh agent repeats the rejected submission verbatim.
    assert.match(String(replay['brief']), new RegExp(BRIEF_BODY), 'the brief comes back — the session is gone');
    assert.match(String(replay['brief']), new RegExp(REJECT_1), 'and so do the reasons');
    assert.match(second.stderr, /attempt 2, cold replay\)/);

    const rows = readSessions(sessionsFile);
    const fresh = rows.at(-1)!;
    assert.equal(fresh.status, 'submitted');
    assert.notEqual(fresh.token, '', 'firing 2 minted its own session');
    assert.equal(fresh.deliveredReasonAt, 900, 'the replay delivered the reasons, so the watermark advanced');
  } finally {
    server.close();
  }
});
