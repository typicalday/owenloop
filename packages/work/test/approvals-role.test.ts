/**
 * Unit coverage for `owenloop work approvals` — the operator surface of the
 * tool-approval gate.
 *
 * WHAT IS ACTUALLY UNDER TEST. Two things, and neither is the hub.
 *
 *   1. The argument grammar. This command grants dangerous tool calls, so the
 *      way it reads argv is a safety surface: a mistyped key must be a usage
 *      error rather than a request that answers the wrong question, and a
 *      decision must never be inferred from an absent flag.
 *   2. The rendering. A blocked worker is a person waiting on another person,
 *      and a list that does not say what is being asked, or that makes the
 *      reader assemble the answer command by hand, is how the wrong call gets
 *      approved under time pressure.
 *
 * The hub is injected. Nothing here opens a socket, reads a credential, or
 * touches settings — every case supplies its own `hub`, `env`, and clock.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseArgs, run, splitOrder } from '../src/roles/approvals.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { AnswerApprovalRequest, ApprovalState, ApprovalView } from '../src/hub/types.ts';

/**
 * A hermetic environment: an empty temp `HOME` so settings resolve to `{}` and
 * the credential store is empty, plus the documented dev-only token override.
 * Every case then passes `--origin` explicitly, so nothing here depends on the
 * developer's own settings file or Keychain.
 */
const ENV = { HOME: mkdtempSync(join(tmpdir(), 'owenloop-approvals-')), OWENLOOP_TOKEN: 'tok' };
const ORIGIN = ['--origin', 'https://hub.invalid'];

function view(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    workflow: 'wf_1',
    run: 'run_1',
    toolUseId: 'toolu_01',
    step: 'builder',
    toolName: 'Bash',
    reason: 'the command changes file ownership',
    title: 'Claude wants to run chown -R me /opt/thing',
    state: 'pending' as ApprovalState,
    requestedAt: 1_000,
    decidedAt: null,
    decidedBy: null,
    note: null,
    ...over,
  };
}

function fakeHub(over: Partial<HubClient> = {}): HubClient {
  return {
    async listPendingApprovals() {
      return { text: '', approvals: [] };
    },
    async answerApproval() {
      return { text: '', ok: true, approval: view({ state: 'approved' }) };
    },
    ...over,
  } as unknown as HubClient;
}

async function invoke(
  args: string[],
  hub: HubClient = fakeHub(),
  now = 61_000,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run([...args, ...ORIGIN], {
    hub,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { ...ENV },
    now: () => now,
  });
  return { code, out, err };
}

// ---------------------------------------------------------------------------
// The grammar.
// ---------------------------------------------------------------------------

test('no subcommand is the list, and `list` names the same thing explicitly', () => {
  assert.equal(parseArgs([]).action, 'list');
  assert.equal(parseArgs(['list']).action, 'list');
  assert.equal(parseArgs(['--json']).action, 'list');
  assert.equal(parseArgs(['--json']).json, true);
});

test('the decision is a verb, so it cannot be omitted the way a flag can', () => {
  const approve = parseArgs(['approve', 'wf_1/run_1', 'toolu_01']);
  assert.deepEqual(
    { a: approve.action, o: approve.order, t: approve.toolUseId, e: approve.error },
    { a: 'approve', o: 'wf_1/run_1', t: 'toolu_01', e: undefined },
  );
  assert.equal(parseArgs(['deny', 'wf_1/run_1', 'toolu_01']).action, 'deny');
});

test('an incomplete key is a usage error, never a request against a guessed one', () => {
  assert.match(parseArgs(['approve']).error ?? '', /missing <workflow>\/<run>/u);
  assert.match(parseArgs(['approve', 'wf_1/run_1']).error ?? '', /missing <tool-use-id>/u);
  assert.match(parseArgs(['approve', 'a/b', 'c', 'd']).error ?? '', /unexpected argument 'd'/u);
  assert.match(parseArgs(['--nope']).error ?? '', /unknown option '--nope'/u);
  assert.match(parseArgs(['approve', 'a/b', 'c', '--note']).error ?? '', /missing value for --note/u);
  // A stray positional on the list form would otherwise be silently ignored,
  // which reads as "I answered that" when nothing was answered.
  assert.match(parseArgs(['toolu_01']).error ?? '', /unexpected argument 'toolu_01'/u);
});

test('both flag spellings parse, since half the docs in this repo use each', () => {
  assert.equal(parseArgs(['approve', 'a/b', 'c', '--note=fine']).note, 'fine');
  assert.equal(parseArgs(['approve', 'a/b', 'c', '--note', 'fine']).note, 'fine');
  assert.equal(parseArgs(['--origin', 'https://x.invalid']).origin, 'https://x.invalid');
});

test('only the FIRST slash splits the order id, because a run id is opaque', () => {
  assert.deepEqual(splitOrder('wf_1/run_1'), { workflow: 'wf_1', run: 'run_1' });
  assert.deepEqual(splitOrder('wf_1/run/with/slashes'), { workflow: 'wf_1', run: 'run/with/slashes' });
  for (const bad of ['wf_1', '/run_1', 'wf_1/']) {
    assert.equal(splitOrder(bad), undefined, bad);
  }
});

// ---------------------------------------------------------------------------
// The list.
// ---------------------------------------------------------------------------

test('an empty list says so in words rather than printing nothing', async () => {
  const { code, out } = await invoke([]);
  assert.equal(code, 0, 'nobody waiting is a success, not an error');
  assert.deepEqual(out, ['no workers are blocked on an approval']);
});

test('each waiting approval prints what is being asked and the command that answers it', async () => {
  const hub = fakeHub({
    async listPendingApprovals() {
      return { text: '', approvals: [view()] };
    },
  });
  const { code, out } = await invoke([], hub);
  assert.equal(code, 0);
  const text = out.join('\n');

  assert.match(text, /wf_1\/run_1/u);
  assert.match(text, /step=builder/u);
  assert.match(text, /waiting 60s/u, 'how long somebody has been parked is the reason to answer now');
  assert.match(text, /why: the command changes file ownership/u);
  assert.match(text, /call: Claude wants to run chown -R me \/opt\/thing/u);
  // Both commands, fully assembled. The three-part key is exactly the thing a
  // reader gets wrong by hand.
  assert.match(text, /approve: owenloop work approvals approve wf_1\/run_1 toolu_01/u);
  assert.match(text, /deny: {4}owenloop work approvals deny wf_1\/run_1 toolu_01/u);
});

test('--json prints the hub rows unedited, for anything that is not a person', async () => {
  const hub = fakeHub({
    async listPendingApprovals() {
      return { text: '', approvals: [view()] };
    },
  });
  const { code, out } = await invoke(['--json'], hub);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out.join('\n')), [view()]);
});

// ---------------------------------------------------------------------------
// The answer.
// ---------------------------------------------------------------------------

test('answering sends the exact key the operator typed, and the note when given', async () => {
  const sent: AnswerApprovalRequest[] = [];
  const hub = fakeHub({
    async answerApproval(req: AnswerApprovalRequest) {
      sent.push(req);
      return { text: '', ok: true, approval: view({ state: 'approved' }) };
    },
  });

  const { code, out } = await invoke(
    ['approve', 'wf_1/run_1', 'toolu_01', '--note', 'that path is mine'],
    hub,
  );
  assert.equal(code, 0);
  assert.deepEqual(sent, [
    {
      workflow: 'wf_1',
      run: 'run_1',
      tool_use_id: 'toolu_01',
      decision: 'approve',
      note: 'that path is mine',
    },
  ]);
  assert.equal(out.some((l) => l === 'approved wf_1/run_1 toolu_01'), true);
});

test('deny sends `deny`, and omits the note key entirely when none was given', async () => {
  const sent: AnswerApprovalRequest[] = [];
  const hub = fakeHub({
    async answerApproval(req: AnswerApprovalRequest) {
      sent.push(req);
      return { text: '', ok: true, approval: view({ state: 'denied' }) };
    },
  });

  const { code } = await invoke(['deny', 'wf_1/run_1', 'toolu_01'], hub);
  assert.equal(code, 0);
  assert.equal(sent[0]!.decision, 'deny');
  assert.equal('note' in sent[0]!, false);
});

test('answering an approval nobody is waiting on any more fails plainly, not as a crash', async () => {
  // The common case, not an exotic one: the worker's own deadline ran out and it
  // already treated the silence as a denial. The operator has to be able to tell
  // "too late" from "broken".
  const hub = fakeHub({
    async answerApproval() {
      return { text: '', ok: false, reason: 'the approval is no longer pending' };
    },
  });
  const { code, err } = await invoke(['approve', 'wf_1/run_1', 'toolu_01'], hub);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /not answered — the approval is no longer pending/u);
});

test('a bad order id is refused before any hub call', async () => {
  let called = false;
  const hub = fakeHub({
    async answerApproval() {
      called = true;
      return { text: '', ok: true, approval: view() };
    },
  });
  const { code, err } = await invoke(['approve', 'wf_1', 'toolu_01'], hub);
  assert.equal(code, 2);
  assert.equal(called, false);
  assert.match(err.join('\n'), /is not <workflow>\/<run>/u);
});

test('a hub error is exit 1 with its message, not a stack trace', async () => {
  const hub = fakeHub({
    async listPendingApprovals(): Promise<never> {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const { code, err } = await invoke([], hub);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /connect ECONNREFUSED/u);
});
