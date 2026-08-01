/**
 * PHASE 4 — the SHARED fixture for the two-adapter live rejection drill.
 *
 * The acceptance criterion for Phase 4 is portability: the SAME rejection delta,
 * rendered by the SAME `renderRejection`, drives a revision on the Claude Code
 * adapter and on the Codex adapter. "The same" is only true if both live tests
 * feed from one fixture, so the fixture lives here rather than being retyped in
 * each file — a divergence between two hand-written copies would quietly turn the
 * portability proof into two unrelated smokes.
 *
 * WHAT THE DRILL PROVES, end to end, against a real provider:
 *   1. the step agent submits `FIRST_URL` through the real `owenloop work hold --mcp`
 *      mount, and the hub REJECTS it;
 *   2. the runner renders a delta from the reviewer's reason — a short message
 *      that does NOT contain the brief;
 *   3. `deliver` puts that delta into the EXISTING session; and
 *   4. the agent revises and submits `SECOND_URL` without ever being re-briefed.
 *
 * Step 4 is the load-bearing one. The delta never restates the task, so an agent
 * that could still perform it had to be carrying the brief in the resumed
 * session. That is the whole claim of resume-on-rejection, and nothing short of a
 * live provider can check it.
 *
 * Lives under `test/helpers/` so the `test/*.test.ts` glob never runs it as a
 * suite of its own.
 */
import assert from 'node:assert/strict';

import { renderRejection } from '../../src/agent/brief.ts';
import type { OrderPacket, ReasonEntry } from '../../src/hub/types.ts';
import type { HubReq } from './mcp-stdio-client.ts';

/** What the first turn is told to submit — and what the reviewer rejects. */
export const FIRST_URL = 'https://example.invalid/pr/1';
/** What the rejection reason asks for instead. The drill's success signal. */
export const SECOND_URL = 'https://example.invalid/pr/2';

/**
 * The brief for the first turn. Deliberately small and mechanical: this drill is
 * testing the RESUME channel, not the model's reasoning, so the cheapest task
 * that still exercises the real mount is the right one.
 */
export const LIVE_BRIEF =
  'Call the `get_order` tool. Then call the `submit` tool with path "pr", ' +
  `value {"url":"${FIRST_URL}"}, and done true. ` +
  'Then reply with the single word done. Do not do anything else.';

/** The reviewer's rejection, as the hub would attach it to the re-offered order. */
const REVIEWER_REASON: ReasonEntry = {
  at: 1_700_000_000_000,
  action: 'reject',
  kind: 'judgment',
  by: 'reviewer',
  text:
    `The submitted url is wrong: it points at ${FIRST_URL}, but the pull request is ${SECOND_URL}. ` +
    'Call the `submit` tool again with path "pr", value {"url":"' +
    SECOND_URL +
    '"}, and done true. Then reply with the single word done.',
};

/** The re-offered packet: one owed path, one new reason. */
export const REJECTED_PACKET: Pick<OrderPacket, 'owes'> = {
  owes: [
    {
      path: 'pr',
      acceptance: 'judgment',
      judgmentRejects: 1,
      schemaRejects: 0,
      reasons: [REVIEWER_REASON],
    },
  ],
};

/**
 * Render the delta the way the runner does, and assert on the way past that it
 * really is a DELTA — the central design point of Phase 4, checked here so BOTH
 * adapters' live drills check it identically and neither can drift.
 *
 * The brief is passed in so the check is against the exact text the session was
 * started with, not against a guess at what a brief looks like.
 */
export function liveRejectionDelta(brief: string): string {
  const delta = renderRejection({ packet: REJECTED_PACKET });

  assert.equal(delta.count, 1, 'exactly one new reason');
  assert.equal(delta.deliveredReasonAt, REVIEWER_REASON.at, 'the watermark is the reason it carried');
  assert.ok(delta.message.includes(SECOND_URL), 'the revision instruction survived rendering');

  // THE POINT OF THE PHASE: the resumed session already holds the brief, so the
  // delta must not carry it. Checked against the brief itself and against the
  // distinctive fragments a partial re-send would leak.
  assert.ok(!delta.message.includes(brief), 'the delta must not re-send the brief');
  for (const fragment of ['Call the `get_order` tool', 'Do not do anything else', 'templateContent']) {
    assert.ok(!delta.message.includes(fragment), `the delta must not contain '${fragment}'`);
  }

  return delta.message;
}

/** Every `submit` the mock hub received, in arrival order, as its body. */
export function submits(reqs: readonly HubReq[]): Array<Record<string, unknown>> {
  return reqs.filter((q) => q.verb === 'submit').map((q) => q.body ?? {});
}

/** The `url` inside a recorded submit body's `value`, or `undefined`. */
export function submittedUrl(body: Record<string, unknown> | undefined): string | undefined {
  if (body === undefined) return undefined;
  const value = body['value'];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return typeof parsed['url'] === 'string' ? parsed['url'] : undefined;
    } catch {
      return value.includes(SECOND_URL) ? SECOND_URL : value.includes(FIRST_URL) ? FIRST_URL : undefined;
    }
  }
  if (value !== null && typeof value === 'object') {
    const url = (value as Record<string, unknown>)['url'];
    return typeof url === 'string' ? url : undefined;
  }
  return undefined;
}

/**
 * The shared assertion body for both adapters' live rejection drills: two
 * submits reached the hub, the first carried `FIRST_URL`, and a later one
 * carried `SECOND_URL` — the revision the delta alone asked for.
 */
export function assertRevisionLanded(reqs: readonly HubReq[], adapterId: string): void {
  const bodies = submits(reqs);
  assert.ok(
    bodies.length >= 2,
    `${adapterId}: expected a second submit after the rejection, saw ${String(bodies.length)}`,
  );
  assert.equal(submittedUrl(bodies[0]), FIRST_URL, `${adapterId}: the first submit carried the original url`);
  const urls = bodies.map(submittedUrl);
  assert.ok(
    urls.slice(1).includes(SECOND_URL),
    `${adapterId}: no revised submit carried ${SECOND_URL}; saw ${JSON.stringify(urls)}`,
  );
}
