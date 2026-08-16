/**
 * Unit coverage for the worker half of the tool-approval gate
 * (`src/agent/approvals.ts`): raise one escalated tool call to the hub, wait for
 * a person, and hand the answer back to the call that is still blocked.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE GATEKEEPER TESTS. Two different
 * questions, and conflating them is how a waiting loop gets shipped untested.
 * `harness-gatekeeper.test.ts` asks which BRANCH the adapter takes given an
 * answer. This file asks whether the requester produces the right answer given a
 * hub — including all the ways a hub declines to produce one.
 *
 * NO REAL CLOCK AND NO REAL SLEEP. Both are injected, and the injected `sleep`
 * is what advances the injected clock. A deadline test that actually waited
 * twenty minutes would never run, and one that shortened the deadline to
 * milliseconds would be testing a different configuration than the one that
 * ships. Advancing a fake clock tests the real default.
 *
 * THE PROPERTY EVERY CASE SHARES: the requester ALWAYS answers. There is no
 * input in this file for which it returns nothing, throws, or hangs, because an
 * unanswered permission prompt blocks its tool call forever — permission prompts
 * have no park deadline. Every failure is a denial with a reason.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApprovalRequester, type ApprovalEvent } from '../src/agent/approvals.ts';
import type { HubClient } from '../src/hub/client.ts';
import {
  HubError,
  type ApprovalState,
  type ApprovalView,
  type RequestApprovalRequest,
  type RequestApprovalResponse,
} from '../src/hub/types.ts';
import type { ApprovalRequest } from '../src/harness/contract.ts';

const WORKFLOW = 'wf_fixture';
const RUN = 'run_fixture';

const CALL: ApprovalRequest = {
  toolUseId: 'toolu_01',
  toolName: 'Bash',
  toolInput: { command: 'chown -R me /opt/thing' },
  reason: 'the command changes file ownership',
  title: 'Claude wants to run chown -R me /opt/thing',
};

/** An `ApprovalView` in whatever state a case needs. Only `state`, `note` and
 *  `decidedBy` are ever read by the requester; the rest is shape. */
function view(state: ApprovalState, over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    workflow: WORKFLOW,
    run: RUN,
    toolUseId: CALL.toolUseId,
    step: 'builder',
    toolName: CALL.toolName,
    reason: CALL.reason,
    title: CALL.title ?? '',
    state,
    requestedAt: 1,
    decidedAt: state === 'pending' ? null : 2,
    decidedBy: state === 'pending' ? null : 'alex',
    note: null,
    ...over,
  };
}

/**
 * A hub that answers each `request_approval` from a scripted list, recording
 * every request it was sent. A step may be a response OR an error to throw; the
 * last entry repeats forever, so a "pending until the deadline" case is one
 * entry rather than a guess at how many polls fit in twenty minutes.
 */
function fakeHub(script: Array<RequestApprovalResponse | Error>): {
  client: HubClient;
  sent: RequestApprovalRequest[];
} {
  const sent: RequestApprovalRequest[] = [];
  const client = {
    async requestApproval(req: RequestApprovalRequest): Promise<RequestApprovalResponse> {
      sent.push(req);
      const step = script[Math.min(sent.length - 1, script.length - 1)]!;
      if (step instanceof Error) throw step;
      return step;
    },
  } as unknown as HubClient;
  return { client, sent };
}

const pending = (): RequestApprovalResponse => ({ text: '', ok: true, approval: view('pending') });
const decided = (state: ApprovalState, note?: string): RequestApprovalResponse => ({
  text: '',
  ok: true,
  approval: view(state, ...(note !== undefined ? [{ note }] : [])),
});

/** Build a requester over a fake hub and a fake clock that only the fake sleep
 *  advances, so elapsed time is exactly the sleeping this loop chose to do. */
function requesterOver(
  script: Array<RequestApprovalResponse | Error>,
  over: { deadlineMs?: number; pollIntervalMs?: number } = {},
) {
  const { client, sent } = fakeHub(script);
  const events: ApprovalEvent[] = [];
  let clock = 0;
  const slept: number[] = [];
  const request = createApprovalRequester({
    client,
    workflow: WORKFLOW,
    run: RUN,
    ...over,
    onEvent: (e) => events.push(e),
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  return { request, sent, events, slept, elapsed: () => clock };
}

// ---------------------------------------------------------------------------
// The two answers a person can give.
// ---------------------------------------------------------------------------

test('an approval comes back as an approval, with the note the person left', async () => {
  const { request, sent, events } = requesterOver([decided('approved', 'yes, that path is mine')]);

  const outcome = await request(CALL);
  assert.deepEqual(outcome, { decision: 'approved', note: 'yes, that path is mine' });

  assert.equal(sent.length, 1, 'an already-answered question is not polled again');
  const req = sent[0]!;
  assert.equal(req.workflow, WORKFLOW);
  assert.equal(req.run, RUN);
  // The identity of the question. Everything else on the request is description.
  assert.equal(req.tool_use_id, CALL.toolUseId);
  assert.equal(req.tool_name, 'Bash');
  assert.deepEqual(req.tool_input, CALL.toolInput);
  assert.equal(req.reason, CALL.reason);
  assert.equal(req.title, CALL.title);
  // `step` is deliberately absent: the hub derives it from the claiming run, so
  // a worker cannot mislabel whose approval this is.
  assert.equal('step' in req, false);

  assert.equal(events.some((e) => e.kind === 'decided'), true);
});

test('a denial comes back as a denial that says a person decided it', async () => {
  const { request } = requesterOver([decided('denied', 'do it inside the worktree')]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'denied');
  assert.match(outcome.reason ?? '', /a person denied this call/u);
  assert.equal(outcome.note, 'do it inside the worktree');
});

// ---------------------------------------------------------------------------
// Waiting — the part that is only safe because it always ends.
// ---------------------------------------------------------------------------

test('a pending approval is polled with the SAME request until it is answered', async () => {
  const { request, sent, events, slept } = requesterOver([
    pending(),
    pending(),
    decided('approved'),
  ]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'approved');
  assert.equal(sent.length, 3);

  // Idempotence is the whole reason raise and poll are one verb: three requests
  // must be three reads of ONE question, not three questions. If any field of
  // the identity varied, a person would see a growing pile of duplicates.
  assert.equal(new Set(sent.map((r) => r.tool_use_id)).size, 1);
  assert.deepEqual(sent[0], sent[2]);

  assert.deepEqual(slept, [5_000, 5_000], 'the default poll interval, twice');
  assert.equal(
    events.filter((e) => e.kind === 'raised').length,
    1,
    'the operator is told once that a person is needed, not once per poll',
  );
});

test('nobody answering is a denial at the deadline, never a hang', async () => {
  // The scripted response never changes, so this ends only because the loop
  // enforces its own deadline.
  const { request, events, elapsed } = requesterOver([pending()]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'denied');
  assert.match(outcome.reason ?? '', /nobody answered within 20 minutes/u);
  assert.equal(elapsed(), 20 * 60 * 1_000, 'it waits the full window before giving up, and no longer');
  assert.equal(events.some((e) => e.kind === 'waiting'), true);
});

test('an already-aborted session denies without asking anyone', async () => {
  const controller = new AbortController();
  controller.abort();
  const { request, sent } = requesterOver([decided('approved')]);

  const outcome = await request({ ...CALL, signal: controller.signal });
  assert.equal(outcome.decision, 'denied');
  assert.match(outcome.reason ?? '', /the session ended before anyone answered/u);
  assert.deepEqual(sent, [], 'a question nobody is left to receive an answer to is not worth asking');
});

// ---------------------------------------------------------------------------
// The hub declining to answer. Every one of these is a denial with a reason,
// and the adapter turns each into the pre-existing refuse-and-route-to-`ask`.
// ---------------------------------------------------------------------------

test('the claim ending underneath the question denies immediately rather than waiting it out', async () => {
  const { request, sent } = requesterOver([{ text: '', ok: false, reason: 'run no longer holds a claim' }]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'denied');
  assert.match(outcome.reason ?? '', /this run no longer holds its claim/u);
  assert.match(outcome.reason ?? '', /run no longer holds a claim/u, 'the hub reason is carried, not swallowed');
  assert.equal(sent.length, 1, 'nothing was recorded, so polling for an answer to it is pointless');
});

test('an expired approval denies, and does not read as a person having said no', async () => {
  const { request } = requesterOver([decided('expired')]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'denied');
  assert.match(outcome.reason ?? '', /no longer live/u);
  assert.doesNotMatch(outcome.reason ?? '', /a person denied/u);
});

test('a 5xx is ridden through: the gate is not useless on an imperfect link', async () => {
  const { request, sent, slept } = requesterOver([
    new HubError(503, 'service unavailable'),
    new HubError(503, 'service unavailable'),
    decided('approved'),
  ]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'approved', 'a hub restart mid-wait must not decide the question');
  assert.equal(sent.length, 3);
  assert.deepEqual(slept, [5_000, 5_000]);
});

test('a 4xx denies at once, because repeating a refused request cannot change it', async () => {
  const { request, sent, events } = requesterOver([new HubError(403, 'not your run')]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'denied');
  assert.match(outcome.reason ?? '', /the hub refused the approval request/u);
  assert.match(outcome.reason ?? '', /403 not your run/u);
  assert.equal(sent.length, 1, 'retrying a 403 is a retry storm, not resilience');
  assert.equal(events.some((e) => e.kind === 'failed'), true);
});

test('a hub that is down for the whole window still ends in a denial, naming the attempts', async () => {
  const { request, elapsed } = requesterOver([new HubError(500, 'boom')]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'denied');
  assert.match(outcome.reason ?? '', /the hub was unreachable for the whole wait/u);
  assert.match(outcome.reason ?? '', /500 boom/u);
  assert.equal(elapsed(), 20 * 60 * 1_000);
});

test('a non-HubError transport failure is treated as retryable, not as a refusal', async () => {
  // A DNS blip or a socket reset arrives as a plain `Error` with no status.
  // Reading "no status" as "refused" would let a network hiccup silently answer
  // a question a person was about to answer.
  const { request, sent } = requesterOver([
    new Error('fetch failed'),
    decided('approved'),
  ]);

  const outcome = await request(CALL);
  assert.equal(outcome.decision, 'approved');
  assert.equal(sent.length, 2);
});
