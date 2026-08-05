import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  REPLAY_TOKEN_BUDGET,
  estimateTokens,
  renderRejection,
  renderReplayBrief,
} from '../src/agent/brief.ts';
import type { OrderPacket, ReasonEntry } from '../src/hub/types.ts';

/**
 * PHASE 4 — the rejection delta.
 *
 * This file is the unit home of `renderRejection` / `renderReplayBrief`. Four
 * other places in the tree point here by name (`src/agent/brief.ts`,
 * `src/roles/agent-run.ts`, `docs/agent-runner.md`, and
 * `test/drill-runner-dispatch.test.ts`), because the two properties asserted at
 * the bottom — DELTA-ONLY and NO CREDENTIAL MATERIAL — are the ones the rest of
 * the design leans on.
 */

// ---- fixtures ----------------------------------------------------------------

const reason = (over: Partial<ReasonEntry> = {}): ReasonEntry => ({
  at: 1_000,
  action: 'reject',
  kind: 'judgment',
  by: 'reviewer',
  text: 'the null check is still missing',
  ...over,
});

type Owed = OrderPacket['owes'][number];

const owed = (path: string, reasons: ReasonEntry[]): Owed => ({
  path,
  judgmentRejects: reasons.length,
  schemaRejects: 0,
  reasons,
});

const packetOf = (...owes: Owed[]): Pick<OrderPacket, 'owes'> => ({ owes });

// ---- the delta shape ---------------------------------------------------------

test('the delta names the owed path, numbers the reasons, and attributes each one', () => {
  const d = renderRejection({
    packet: packetOf(
      owed('out/report.md', [
        reason({ at: 10, text: 'first problem' }),
        reason({ at: 20, kind: 'schema', by: 'engine', text: 'second problem' }),
      ]),
    ),
  });

  assert.equal(d.count, 2);
  assert.equal(d.deliveredReasonAt, 20, 'the watermark is the NEWEST at, not the last in array order');
  assert.match(d.message, /Your submission for `out\/report\.md` was rejected\. Reasons:/);
  assert.match(d.message, /^1\. \[judgment, by reviewer\] first problem$/m);
  assert.match(d.message, /^2\. \[schema, by engine\] second problem$/m);
  assert.match(d.message, /Revise and submit again to the same path with the same tool\./);
  assert.match(d.message, /Do not start over/);
});

/**
 * THE CENTRAL DESIGN POINT of Phase 4, asserted directly. If this test ever goes
 * green against a message that also carries the brief, the phase has been undone:
 * re-sending the brief spends exactly the tokens resume exists to save.
 */
test('the delta carries ONLY the delta — no brief, no prompt, no consumes, no submit hint', () => {
  const d = renderRejection({
    packet: packetOf(owed('out/a.md', [reason({ at: 5, text: 'fix it' })])),
  });

  for (const forbidden of [
    'THE ORDER IS',
    'templateContent',
    'consumes',
    'You are executing',
    '# brief',
  ]) {
    assert.ok(!d.message.includes(forbidden), `the delta must not contain ${forbidden}`);
  }
  // A delta is SHORT. One reason should not produce a wall of text.
  assert.ok(estimateTokens(d.message) < 200, `a one-reason delta was ${estimateTokens(d.message)} tokens`);
});

test('one section per owed path, and the watermark spans them all', () => {
  const d = renderRejection({
    packet: packetOf(
      owed('out/a.md', [reason({ at: 10, text: 'a is wrong' })]),
      owed('out/b.md', [reason({ at: 40, text: 'b is wrong' })]),
    ),
  });

  assert.equal(d.count, 2);
  assert.equal(d.deliveredReasonAt, 40);
  assert.match(d.message, /`out\/a\.md`/);
  assert.match(d.message, /`out\/b\.md`/);
  assert.equal(
    d.message.match(/Revise and submit again/g)?.length,
    1,
    'one closing instruction for the whole message, not one per section',
  );
});

test('`paths` restricts which owed entries are rendered at all', () => {
  const d = renderRejection({
    packet: packetOf(
      owed('out/a.md', [reason({ at: 10, text: 'a is wrong' })]),
      owed('out/b.md', [reason({ at: 40, text: 'b is wrong' })]),
    ),
    paths: ['out/b.md'],
  });

  assert.equal(d.count, 1);
  assert.equal(d.deliveredReasonAt, 40);
  assert.ok(!d.message.includes('out/a.md'));
  assert.ok(d.message.includes('out/b.md'));
});

// ---- the watermark -----------------------------------------------------------

test('reasons at or below the watermark are already delivered and are dropped', () => {
  const packet = packetOf(
    owed('out/a.md', [
      reason({ at: 10, text: 'old, already said' }),
      reason({ at: 20, text: 'also already said' }),
      reason({ at: 30, text: 'genuinely new' }),
    ]),
  );

  const d = renderRejection({ packet, deliveredReasonAt: 20 });

  assert.equal(d.count, 1, 'strictly greater than the watermark');
  assert.equal(d.deliveredReasonAt, 30);
  assert.match(d.message, /^1\. \[judgment, by reviewer\] genuinely new$/m);
  assert.ok(!d.message.includes('already said'));
});

test('a watermark equal to the newest reason leaves nothing to say ⇒ empty message', () => {
  const d = renderRejection({
    packet: packetOf(owed('out/a.md', [reason({ at: 30 })])),
    deliveredReasonAt: 30,
  });

  assert.equal(d.message, '', 'empty EXACTLY WHEN nothing new needed saying');
  assert.equal(d.count, 0);
  assert.equal(d.deliveredReasonAt, undefined, 'no watermark advance when nothing was delivered');
});

test('an owed entry with an empty reason thread (a bare schema reject) renders nothing', () => {
  const d = renderRejection({ packet: packetOf(owed('out/a.md', [])) });
  assert.equal(d.message, '');
  assert.equal(d.count, 0);
});

test('no watermark means nothing has been delivered yet, so every reason is new', () => {
  // This is the pre-Phase-4 record shape: `deliveredReasonAt` simply absent.
  const d = renderRejection({
    packet: packetOf(owed('out/a.md', [reason({ at: 1 }), reason({ at: 2 })])),
  });
  assert.equal(d.count, 2);
});

test('a path with only stale reasons is skipped while a sibling with fresh ones renders', () => {
  const d = renderRejection({
    packet: packetOf(
      owed('out/stale.md', [reason({ at: 10, text: 'said before' })]),
      owed('out/fresh.md', [reason({ at: 50, text: 'said now' })]),
    ),
    deliveredReasonAt: 20,
  });

  assert.equal(d.count, 1);
  assert.ok(!d.message.includes('out/stale.md'));
  assert.ok(d.message.includes('out/fresh.md'));
});

// ---- the cold-replay brief ---------------------------------------------------

const BRIEF = '# brief\norder: wf1/run1\ndo the work';

test('the replay brief is the ordinary brief PLUS the same rejection body', () => {
  const spec = { packet: packetOf(owed('out/a.md', [reason({ at: 7, text: 'fix the null check' })])) };
  const replay = renderReplayBrief(BRIEF, spec);

  assert.ok(replay.startsWith(BRIEF), 'the brief comes first and is never trimmed');
  assert.ok(replay.includes(renderRejection(spec).message), 'the SAME body as the resume delta');
  assert.match(replay, /\n---\n/, 'the rejection is a clearly separated trailing section');
});

test('with no new reasons the replay brief is exactly the brief — no empty rejection section', () => {
  const replay = renderReplayBrief(BRIEF, {
    packet: packetOf(owed('out/a.md', [reason({ at: 7 })])),
    deliveredReasonAt: 7,
  });
  assert.equal(replay, BRIEF);
});

test('over budget: WHOLE reasons are dropped oldest-first and the count is stated', () => {
  // 120k chars each ⇒ ~30k tokens each; four of them is ~120k, over the 100k cap.
  // Dropping the oldest leaves ~90k, so exactly one entry has to go.
  const fat = (at: number, tag: string): ReasonEntry =>
    reason({ at, text: `${tag} ${'x'.repeat(120_000)}` });
  const packet = packetOf(
    owed('out/a.md', [fat(1, 'OLDEST'), fat(2, 'MIDDLE'), fat(3, 'NEWER'), fat(4, 'NEWEST')]),
  );

  const replay = renderReplayBrief(BRIEF, { packet });

  assert.ok(estimateTokens(replay) <= REPLAY_TOKEN_BUDGET, 'the assembled text respects the cap');
  assert.match(replay, /older rejection reasons? omitted to fit the context budget\./);
  assert.ok(replay.includes('NEWEST'), 'the newest reason survives');
  assert.ok(!replay.includes('OLDEST'), 'the oldest reason is the first one dropped');
  // Never a mid-entry truncation: any tag that appears at all appears with its
  // whole 60k-char body intact.
  for (const tag of ['MIDDLE', 'NEWER', 'NEWEST']) {
    if (!replay.includes(tag)) continue;
    assert.ok(
      replay.includes(`${tag} ${'x'.repeat(120_000)}`),
      `${tag} was truncated mid-entry — half a reason reads as a complete but different instruction`,
    );
  }
});

test('a brief that alone exceeds the budget wins; the rejection section is dropped entirely', () => {
  const huge = 'B'.repeat(REPLAY_TOKEN_BUDGET * 4 + 10_000);
  const replay = renderReplayBrief(huge, {
    packet: packetOf(owed('out/a.md', [reason({ at: 1, text: 'a reason' })])),
  });
  assert.equal(replay, huge, 'losing the brief would leave the agent with no task at all');
});

// ---- D10: no credential material ---------------------------------------------

/**
 * The narrow Phase 4 half of D10, and it is still worth having after Phase 6
 * closed the wide half. Phase 6's `filterOwenloopEnv` keeps `OWENLOOP_TOKEN` out
 * of the child ENVIRONMENT; this file covers a channel no env filter can reach —
 * the TEXT owenloop itself puts in front of a harness, the rejection delta and
 * the replay brief. `test/drill-runner-dispatch.test.ts` holds the third
 * channel, the mount's argv.
 *
 * This holds BY CONSTRUCTION, not by filtering: `renderRejection` reads only
 * `OrderPacket.owes[].reasons`, which carries no credentials. The test exists so
 * that a future change which starts reading a wider slice of the packet — or the
 * environment — fails here instead of leaking silently.
 */
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ['OWENLOOP_TOKEN', /OWENLOOP_TOKEN/],
  ['a bearer header', /Bearer\s+\S/i],
  ['a --token flag', /--token[= ]/],
  ['an Authorization header', /Authorization\s*:/i],
];

test('the rejection delta carries no credential material', () => {
  // A hostile-shaped packet: the fields a careless widening might start reading.
  const d = renderRejection({
    packet: packetOf(owed('out/a.md', [reason({ at: 1, text: 'plain feedback with no secrets' })])),
  });

  assert.notEqual(d.message, '', 'guard the guard — an empty message would pass vacuously');
  for (const [name, re] of CREDENTIAL_PATTERNS) {
    assert.ok(!re.test(d.message), `the rejection delta must not contain ${name}`);
  }
});

test('the cold-replay brief adds no credential material beyond what the brief already had', () => {
  const replay = renderReplayBrief(BRIEF, {
    packet: packetOf(owed('out/a.md', [reason({ at: 1, text: 'plain feedback with no secrets' })])),
  });

  assert.ok(replay.length > BRIEF.length, 'guard the guard — the rejection section is present');
  const added = replay.slice(BRIEF.length);
  for (const [name, re] of CREDENTIAL_PATTERNS) {
    assert.ok(!re.test(added), `the replay brief's rejection section must not contain ${name}`);
  }
});

test('a reason whose TEXT happens to mention a token is still not a leak the renderer created', () => {
  // Hub-authored reason text is passed through verbatim by design — a reviewer
  // quoting an error message is legitimate feedback. What this pins is that the
  // renderer adds nothing: everything credential-shaped in the output traces back
  // to the reason text the hub supplied.
  const text = 'the request failed with Authorization: Bearer abc123';
  const d = renderRejection({ packet: packetOf(owed('out/a.md', [reason({ at: 1, text })])) });
  const withoutReason = d.message.replace(text, '');
  for (const [name, re] of CREDENTIAL_PATTERNS) {
    assert.ok(!re.test(withoutReason), `the renderer itself must not introduce ${name}`);
  }
});

// ---- the token estimate ------------------------------------------------------

test('estimateTokens is chars/4, rounded up — deliberately approximate', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});
