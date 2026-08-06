/**
 * PHASE 4 — THE RESUME DECISION, driven through `createAgentRunLoop`.
 *
 * `test/agent-rejection.test.ts` covers what the delta SAYS. This file covers
 * WHICH PATH the loop takes and what it hands the adapter:
 *
 *   resume       `deliver(prevRef, delta, args, onEvent)` — the prior session's
 *                token, only the new reasons, and NO brief.
 *   cold replay  `start(args)` with the ordinary brief PLUS a trailing rejection
 *                section, because the session is gone but the reasons still have
 *                to arrive.
 *   cold start   `start(args)` with just the brief — nothing new to say.
 *
 * Every precondition is exercised one at a time against an otherwise-resumable
 * baseline, so a failure names the exact condition that broke rather than "resume
 * stopped working".
 *
 * Hermetic: injected `HubClient`, injected `latestSession` and `dirExists` (no
 * filesystem), and a fake adapter (no harness process).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAgentRunLoop, type AdapterResolution, type AgentRunLoopOptions } from '../src/agent/loop.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import { createFakeAdapter, type FakeAdapter } from '../src/harness/fake.ts';
import { ResumeUnavailableError, type AgentEvent, type HarnessAdapter, type HarnessSessionRef, type ResumeTier } from '../src/harness/contract.ts';
import type { SessionRecord } from '../src/harness/session-store.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { ContactHolder, GetOrderResponse, OrderPacket, ReasonEntry } from '../src/hub/types.ts';

const HOLDER: ContactHolder = { kind: 'exec', id: 'host:99' };
const CWD = '/work/wf1/run1';
const TEMPLATE = ['# brief', 'order: __OWENLOOP_ORDER__', 'do the work'].join('\n');

const macrotaskSleep = (): Promise<void> => new Promise((r) => setImmediate(r));

const reason = (at: number, text: string): ReasonEntry => ({
  at,
  action: 'reject',
  kind: 'judgment',
  by: 'reviewer',
  text,
});

interface OrderOpts {
  reasons?: ReasonEntry[];
  workdir?: string;
  claimed?: boolean;
  outcome?: string;
}

/** A re-offered AGENT order: owed path `out`, with a reason thread. */
function rejectedOrder(o: OrderOpts = {}): GetOrderResponse {
  const packet: OrderPacket = {
    run: 'run1',
    workflow: 'wf1',
    step: 'builder',
    key: 'k',
    inputs: [],
    outputs: ['out'],
    ...(o.workdir !== undefined ? { workdir: o.workdir } : {}),
    defDigest: 'test-agent-digest',
    consumes: {},
    owes: [
      {
        path: 'out',
        judgmentRejects: 1,
        schemaRejects: 0,
        reasons: o.reasons ?? [reason(500, 'the null check is still missing')],
      },
    ],
  };
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: packet,
    lease: { claimed: o.claimed ?? true, ...(o.outcome !== undefined ? { outcome: o.outcome } : {}) },
  };
}

function mockHub(responses: GetOrderResponse[]): HubClient {
  let i = 0;
  return {
    async getOrder() {
      return responses[Math.min(i++, responses.length - 1)]!;
    },
    async heartbeat() {
      return { text: '' };
    },
    async release() {
      return { text: '' };
    },
    async submit() {
      return { text: '', outcome: 'green' };
    },
    async whatsNext() {
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
    async whoami() {
      return {
        text: '',
        orgId: '',
        orgName: '',
        actor: { id: '', kind: 'agent', role: 'agent', scopes: [] },
        tokenStatus: 'active',
        authMethod: 'token',
      };
    },
    async wake() {
      return { text: '', cursor: 0, changed: false };
    },
    async presencePing(req) {
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
  };
}

/** The prior session row a resume would resume INTO. Resumable by default. */
const priorSession = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  workflow: 'wf1',
  run: 'run1',
  step: 'builder',
  order: 'wf1/run1',
  attempt: 1,
  harness: 'fake',
  token: 'tok-prior',
  cwd: CWD,
  status: 'turn-ended',
  createdAt: 100,
  updatedAt: 200,
  ...over,
});

interface RunOpts {
  adapter?: HarnessAdapter;
  responses?: GetOrderResponse[];
  prev?: SessionRecord | null;
  dirExists?: (p: string) => boolean;
  resumeTier?: ResumeTier;
}

interface Ran {
  records: SessionRecord[];
  errs: string[];
  outs: string[];
}

async function runLoop(o: RunOpts = {}): Promise<Ran> {
  const adapter = o.adapter ?? createFakeAdapter({ id: 'fake' });
  const records: SessionRecord[] = [];
  const errs: string[] = [];
  const outs: string[] = [];
  const resolution: AdapterResolution = {
    id: 'fake',
    adapter: o.resumeTier === undefined ? adapter : { ...adapter, resumeTier: o.resumeTier },
    registered: ['fake'],
  };
  const opts: AgentRunLoopOptions = {
    hub: mockHub(o.responses ?? [rejectedOrder(), rejectedOrder({ claimed: false, outcome: 'green' })]),
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    origin: 'https://hub.example',
    account: 'acct-1',
    cwd: CWD,
    loadStep: async (): Promise<NormalizedStepSpec | null> => ({ step: 'builder', brief: TEMPLATE, permissions: { extensions: {} } }),
    resolveAdapter: () => resolution,
    // This fixture exercises resume rendering, not the consume-side trust
    // boundary. Admit the synthetic rejection thread so the loop can reach
    // the resume paths under test.
    consumedVerifier: async (order) => ({ ok: true as const, order, warnings: [] }),
    appendSession: (rec) => records.push(rec),
    nextAttempt: () => 2,
    latestSession: () => (o.prev === undefined ? priorSession() : o.prev),
    dirExists: o.dirExists ?? ((): boolean => true),
    sleep: macrotaskSleep,
    now: () => 1_000,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    heartbeatIntervalMs: 60_000,
    confirmIntervalMs: 1,
    submitGraceMs: 0,
  };
  await createAgentRunLoop(opts).run();
  return { records, errs, outs };
}

/** Every adapter call kind, in order. */
const kinds = (a: FakeAdapter): string[] => a.calls.map((c) => c.kind);

// ---- the resumable baseline --------------------------------------------------

test('all preconditions hold ⇒ RESUME: deliver on the prior token, delta only, no brief', async () => {
  const adapter = createFakeAdapter({ id: 'fake', token: 'tok-new' });
  const ran = await runLoop({ adapter });

  assert.deepEqual(kinds(adapter), ['deliver', 'stop'], 'no start — the session is reused');
  const d = adapter.calls.find((c) => c.kind === 'deliver');
  assert.ok(d !== undefined && d.kind === 'deliver');

  // The PRIOR token, not a freshly minted one.
  assert.deepEqual(d.ref, { harness: 'fake', token: 'tok-prior' });

  // The delta, and ONLY the delta.
  assert.match(d.message, /Your submission for `out` was rejected/);
  assert.match(d.message, /the null check is still missing/);
  assert.ok(!d.message.includes('# brief'), 'THE point of the phase: the brief is not re-sent');
  assert.ok(!d.message.includes('do the work'));

  // The widened third argument really carried the cwd and the permission bag.
  assert.equal(d.args.cwd, CWD);
  assert.notEqual(d.args.permissions, undefined);

  // The log says resume, and says how much was new.
  assert.match(ran.errs.join('\n'), /resuming session tok-prior .* with 1 new rejection reason \(no brief re-sent\)/);
  assert.match(ran.outs.join('\n'), /attempt 2, resume\)/);
});

test('a resumed attempt writes rows under the PRIOR token and carries the session birth time', async () => {
  const ran = await runLoop();

  // `deliver` emits no `started`, so the 'active' row has to be written by the
  // loop itself — that is the only thing that makes "same session" observable.
  assert.deepEqual(ran.records.map((r) => r.status), ['active', 'turn-ended', 'submitted']);
  for (const r of ran.records) {
    assert.equal(r.token, 'tok-prior', 'the resumed rows share the prior session token');
    assert.equal(r.createdAt, 100, "createdAt is the SESSION's birth, not this attempt's");
    assert.equal(r.attempt, 2);
  }
});

test('the watermark advances to the newest delivered reason — but only AFTER `deliver` resolved', async () => {
  const ran = await runLoop({
    prev: priorSession({ deliveredReasonAt: 100 }),
    responses: [
      rejectedOrder({ reasons: [reason(500, 'first'), reason(900, 'second')] }),
      rejectedOrder({ claimed: false, outcome: 'green' }),
    ],
  });

  // The pre-deliver 'active' row is the one the next firing reads if this turn
  // never completes, so it must still say what the session has actually heard.
  assert.deepEqual(ran.records.map((r) => r.status), ['active', 'turn-ended', 'submitted']);
  assert.equal(ran.records[0]!.deliveredReasonAt, 100, 'written before `deliver` — the PRIOR watermark');
  assert.equal(ran.records[1]!.deliveredReasonAt, 900, 'the delta landed, so the watermark is now honest');
  assert.equal(ran.records[2]!.deliveredReasonAt, 900);
});

test('reasons at or below the prior watermark are not re-delivered', async () => {
  const adapter = createFakeAdapter({ id: 'fake' });
  await runLoop({
    adapter,
    prev: priorSession({ deliveredReasonAt: 500 }),
    responses: [
      rejectedOrder({ reasons: [reason(500, 'ALREADY SAID'), reason(900, 'genuinely new')] }),
      rejectedOrder({ claimed: false, outcome: 'green' }),
    ],
  });
  const d = adapter.calls.find((c) => c.kind === 'deliver');
  assert.ok(d !== undefined && d.kind === 'deliver');
  assert.ok(!d.message.includes('ALREADY SAID'));
  assert.match(d.message, /genuinely new/);
});

// ---- one failing precondition at a time --------------------------------------
//
// Each case below is the baseline with EXACTLY ONE condition broken, and each
// asserts a COLD path rather than an error: a session that cannot be resumed is
// an ordinary, documented outcome.

interface ColdCase {
  name: string;
  opts: RunOpts;
  /** 'cold replay' when the reasons still have to travel; 'cold start' when
   *  there is nothing new to say. */
  path: 'cold replay' | 'cold start';
}

const COLD_CASES: ColdCase[] = [
  {
    name: 'prev === null — the first firing has no session to resume',
    opts: { prev: null },
    path: 'cold replay',
  },
  {
    name: "prev.token === '' — the row predates its `started` event, so no provider token was minted",
    opts: { prev: priorSession({ token: '' }) },
    path: 'cold replay',
  },
  {
    name: 'prev.harness !== the resolved id — a token means nothing in a different vendor',
    opts: { prev: priorSession({ harness: 'some-other-adapter' }) },
    path: 'cold replay',
  },
  {
    name: "prev.status === 'dead' — a session recorded dead is not resumable",
    opts: { prev: priorSession({ status: 'dead' }) },
    path: 'cold replay',
  },
  {
    name: "resumeTier === 'replay' — the adapter says it has no resume at all",
    opts: { resumeTier: 'replay' },
    path: 'cold replay',
  },
  {
    name: 'prev.cwd !== the resolved cwd — the session is scoped to the wrong place',
    opts: { prev: priorSession({ cwd: '/somewhere/else' }) },
    path: 'cold replay',
  },
  {
    name: 'the recorded cwd no longer exists — a reaped work dir invalidates the session',
    opts: { dirExists: (): boolean => false },
    path: 'cold replay',
  },
];

for (const c of COLD_CASES) {
  test(`cold path because ${c.name}`, async () => {
    const adapter = createFakeAdapter({ id: 'fake' });
    const ran = await runLoop({ ...c.opts, adapter });

    assert.deepEqual(kinds(adapter), ['start', 'stop'], 'start, never deliver');
    const s = adapter.calls.find((x) => x.kind === 'start');
    assert.ok(s !== undefined && s.kind === 'start');
    assert.match(s.args.brief, /# brief/, 'the session is gone, so the brief comes back');
    assert.match(
      s.args.brief,
      /Your submission for `out` was rejected/,
      'and the reasons still have to arrive, or the fresh agent repeats the rejected submission',
    );
    assert.match(ran.outs.join('\n'), new RegExp(`attempt 2, ${c.path}\\)`));
  });
}

test('nothing new to say ⇒ COLD START with a bare brief, not a resume that says nothing', async () => {
  const adapter = createFakeAdapter({ id: 'fake' });
  const ran = await runLoop({
    adapter,
    // The watermark already covers the only reason on the packet.
    prev: priorSession({ deliveredReasonAt: 500 }),
    responses: [rejectedOrder({ reasons: [reason(500, 'said before')] }), rejectedOrder({ claimed: false, outcome: 'green' })],
  });

  assert.deepEqual(kinds(adapter), ['start', 'stop']);
  const s = adapter.calls.find((x) => x.kind === 'start');
  assert.ok(s !== undefined && s.kind === 'start');
  assert.ok(!s.args.brief.includes('was rejected'), 'no empty rejection section');
  assert.match(ran.outs.join('\n'), /attempt 2, cold start\)/);
  // The watermark is carried FORWARD, never reset — a cold start with no new
  // feedback must not make already-delivered reasons look undelivered.
  for (const r of ran.records) assert.equal(r.deliveredReasonAt, 500);
});

test('an owed path whose reason thread is empty is a cold start, not a bare "you were rejected"', async () => {
  const adapter = createFakeAdapter({ id: 'fake' });
  const ran = await runLoop({
    adapter,
    responses: [rejectedOrder({ reasons: [] }), rejectedOrder({ claimed: false, outcome: 'green' })],
  });
  assert.deepEqual(kinds(adapter), ['start', 'stop']);
  assert.match(ran.outs.join('\n'), /attempt 2, cold start\)/);
});

// ---- ResumeUnavailableError: fall back IN THE SAME FIRING ---------------------

/** An adapter whose `deliver` always rejects with `RESUME_UNAVAILABLE`, and
 *  whose `start` succeeds. Records both call shapes for inspection. */
function refusingAdapter(): {
  adapter: HarnessAdapter;
  delivers: string[];
  starts: string[];
  stops: HarnessSessionRef[];
} {
  const delivers: string[] = [];
  const starts: string[] = [];
  const stops: HarnessSessionRef[] = [];
  const ref: HarnessSessionRef = { harness: 'fake', token: 'tok-fresh' };
  const adapter: HarnessAdapter = {
    id: 'fake',
    resumeTier: 'native-token',
    async start(args, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef> {
      starts.push(args.brief);
      onEvent({ kind: 'started', ref });
      onEvent({ kind: 'turn_ended' });
      return ref;
    },
    async deliver(_ref, message): Promise<void> {
      delivers.push(message);
      throw new ResumeUnavailableError('the provider forgot session tok-prior');
    },
    async stop(target): Promise<void> {
      stops.push(target);
    },
  };
  return { adapter, delivers, starts, stops };
}

test('a refused resume falls back to a COLD REPLAY in the same firing — no re-offer cycle', async () => {
  const r = refusingAdapter();
  const ran = await runLoop({ adapter: r.adapter });

  assert.equal(r.delivers.length, 1, 'the resume was attempted');
  assert.equal(r.starts.length, 1, 'and the SAME firing cold-started');

  // The fallback brief is the full replay brief: brief + the same reasons.
  const brief = r.starts[0]!;
  assert.match(brief, /# brief/);
  assert.match(brief, /Your submission for `out` was rejected/);
  assert.match(brief, /the null check is still missing/);

  assert.match(ran.errs.join('\n'), /resume of session tok-prior was refused .* falling back to a cold replay in this same firing/);
});

test('after a refused resume the run still completes, and the rows carry the NEW token', async () => {
  const r = refusingAdapter();
  const ran = await runLoop({ adapter: r.adapter });

  // The dead session is forgotten: the `started` event mints a new record with a
  // new token and its own createdAt, and teardown stops the NEW session — never
  // the one the provider already lost.
  const final = ran.records[ran.records.length - 1]!;
  assert.equal(final.status, 'submitted');
  assert.equal(final.token, 'tok-fresh');
  assert.equal(final.createdAt, 1_000, 'a fresh session, so a fresh birth time');
  assert.deepEqual(r.stops, [{ harness: 'fake', token: 'tok-fresh' }]);
});

test('a NON-resume deliver failure is a failed turn, not a fallback — the hub still decides', async () => {
  const starts: string[] = [];
  const adapter: HarnessAdapter = {
    id: 'fake',
    resumeTier: 'native-token',
    async start(args): Promise<HarnessSessionRef> {
      starts.push(args.brief);
      return { harness: 'fake', token: 'never' };
    },
    async deliver(): Promise<void> {
      throw new Error('the harness died mid-turn');
    },
    async stop(): Promise<void> {
      /* no-op */
    },
  };

  const ran = await runLoop({ adapter });

  assert.deepEqual(starts, [], 'a plain failure does not silently restart the agent');
  assert.match(ran.errs.join('\n'), /the turn failed \(the harness died mid-turn\) — confirming with the hub/);
  // The hub is still truth: the confirm poll saw the outcome, so this submitted.
  assert.equal(ran.records[ran.records.length - 1]!.status, 'submitted');
});

// ---- the watermark may never run ahead of the delivery -----------------------
//
// Advancing `deliveredReasonAt` before `deliver` has resolved SWALLOWS the
// feedback permanently: the store would claim the reasons reached a session that
// never conveyed them, the next firing would filter every one of them out
// (`at > watermark`) and cold-start with a BARE brief, and the agent would
// repeat the rejected submission having never learned why it was rejected.

/** An adapter whose `deliver` fails for a NON-resume reason (transport/spawn),
 *  which the loop treats as a failed turn rather than a replay fallback. */
function brokenDeliverAdapter(): HarnessAdapter {
  return {
    id: 'fake',
    resumeTier: 'native-token',
    async start(): Promise<HarnessSessionRef> {
      throw new Error('start must not be reached on a plain deliver failure');
    },
    async deliver(): Promise<void> {
      throw new Error('the transport died before the message went out');
    },
    async stop(): Promise<void> {
      /* no-op */
    },
  };
}

test('a failed `deliver` leaves the watermark UN-ADVANCED on every row it wrote', async () => {
  const ran = await runLoop({
    adapter: brokenDeliverAdapter(),
    prev: priorSession({ deliveredReasonAt: 100 }),
    responses: [
      rejectedOrder({ reasons: [reason(500, 'first'), reason(900, 'second')] }),
      rejectedOrder({ claimed: false, outcome: 'green' }),
    ],
  });

  assert.ok(ran.records.length > 0);
  for (const r of ran.records) {
    assert.equal(
      r.deliveredReasonAt,
      100,
      'the session never conveyed the reasons, so no row may claim it did',
    );
  }
});

test('and the NEXT firing therefore re-delivers those same reasons instead of cold-starting bare', async () => {
  const REASONS = [reason(500, 'first'), reason(900, 'second')];

  // Firing 1: the resume turn fails on the way out.
  const failed = await runLoop({
    adapter: brokenDeliverAdapter(),
    prev: priorSession({ deliveredReasonAt: 100 }),
    responses: [rejectedOrder({ reasons: REASONS }), rejectedOrder({ claimed: false, outcome: 'green' })],
  });
  const carried = failed.records[failed.records.length - 1]!;

  // Firing 2 reads exactly what firing 1 left on disk — nothing else connects
  // the two processes.
  const adapter = createFakeAdapter({ id: 'fake', token: 'tok-prior' });
  const again = await runLoop({
    adapter,
    prev: carried,
    responses: [rejectedOrder({ reasons: REASONS }), rejectedOrder({ claimed: false, outcome: 'green' })],
  });

  const d = adapter.calls.find((c) => c.kind === 'deliver');
  assert.ok(d !== undefined && d.kind === 'deliver', 'the session is still resumable, so this is a resume');
  assert.match(d.message, /first/, 'the swallowed reasons came back');
  assert.match(d.message, /second/);
  assert.equal(again.records[again.records.length - 1]!.deliveredReasonAt, 900, 'and NOW the watermark advances');
});

// ---- the packet's workdir still wins ------------------------------------------

test('a hub-supplied workdir is the resolved cwd, and it is what the resume is matched against', async () => {
  const adapter = createFakeAdapter({ id: 'fake' });
  await runLoop({
    adapter,
    prev: priorSession({ cwd: '/hub/given' }),
    responses: [
      rejectedOrder({ workdir: '/hub/given' }),
      rejectedOrder({ workdir: '/hub/given', claimed: false, outcome: 'green' }),
    ],
  });

  assert.deepEqual(kinds(adapter), ['deliver', 'stop'], 'matching cwds still resume');
  const d = adapter.calls.find((c) => c.kind === 'deliver');
  assert.ok(d !== undefined && d.kind === 'deliver');
  assert.equal(d.args.cwd, '/hub/given');
});
