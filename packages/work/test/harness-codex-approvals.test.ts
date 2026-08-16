/**
 * The codex adapter's half of the tool-approval gate: turn one app-server
 * approval request into a question a person answers, and turn their answer back
 * into the exact reply frame the app-server expects.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `harness-codex.test.ts` covers the request
 * handler's REFUSALS — the behavior with no approval channel wired in, which is
 * still the default and must not drift. This file covers the behavior WITH one,
 * which is a different contract: the reply is no longer an error frame, and the
 * shape of the non-error reply differs per method.
 *
 * THE THING MOST LIKELY TO BREAK SILENTLY, and the reason the reply bytes are
 * asserted rather than "it did not throw": the two protocol generations answer
 * with DIFFERENT enums. `item/*` takes `CommandExecutionApprovalDecision` /
 * `FileChangeApprovalDecision` — `'accept' | 'decline'`. The legacy pair takes
 * `ReviewDecision` — `'approved'`, and a refusal is the tagged
 * `{denied:{rejection}}`. Sending an `item/*` word to a legacy method (or the
 * reverse) is a deserialization error at the far end, which surfaces as a dead
 * turn rather than as a wrong decision. Both are pinned here against
 * `codex app-server generate-ts` output for 0.146.0.
 *
 * NO CHILD PROCESS AND NO CLOCK. `handleServerRequest` is a pure function of
 * (event sink, requester) — every case calls it directly with a scripted
 * requester, so nothing here spawns a binary or waits on real time.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleServerRequest } from '../src/harness/codex.ts';
import type { AgentEvent } from '../src/harness/contract.ts';
import type { ApprovalOutcome, ApprovalRequest, ApprovalRequester } from '../src/harness/contract.ts';

/** A handler over a requester that always gives the same answer, plus its log. */
function handlerFor(outcome: ApprovalOutcome | Error): {
  handle: (method: string, params: unknown) => Promise<unknown>;
  asked: ApprovalRequest[];
  events: AgentEvent[];
} {
  const asked: ApprovalRequest[] = [];
  const events: AgentEvent[] = [];
  const requester: ApprovalRequester = async (req) => {
    asked.push(req);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { handle: handleServerRequest((e) => events.push(e), requester), asked, events };
}

const APPROVED: ApprovalOutcome = { decision: 'approved' };
const DENIED: ApprovalOutcome = { decision: 'denied', reason: 'a person denied this call' };

/** A v2 `CommandExecutionRequestApprovalParams`, trimmed to the fields read. */
const V2_EXEC = {
  threadId: 'th_1',
  turnId: 'tu_1',
  itemId: 'item_1',
  startedAtMs: 1,
  command: 'chown -R me /opt/thing',
  cwd: '/work/repo',
  reason: 'the command changes file ownership',
};

/** A legacy `ExecCommandApprovalParams` — note `command` is an ARRAY here. */
const LEGACY_EXEC = {
  conversationId: 'th_1',
  callId: 'call_1',
  approvalId: null,
  command: ['chown', '-R', 'me', '/opt/thing'],
  cwd: '/work/repo',
  reason: 'the command changes file ownership',
};

// ---------------------------------------------------------------------------
// The reply bytes, per protocol generation.
// ---------------------------------------------------------------------------

test('an approved v2 command answers `accept`, the word that enum actually has', async () => {
  const { handle, events } = handlerFor(APPROVED);
  const reply = await handle('item/commandExecution/requestApproval', V2_EXEC);

  assert.deepEqual(reply, { decision: 'accept' });
  // NOT `acceptForSession`: the person answered one question about one command.
  assert.notDeepEqual(reply, { decision: 'acceptForSession' });
  assert.equal(events.some((e) => e.kind === 'progress' && /^approved /u.test(e.text)), true);
});

test('a denied v2 command answers `decline`, which lets the turn continue', async () => {
  const { handle } = handlerFor(DENIED);
  // `cancel` would abort the whole turn; `decline` refuses this call and leaves
  // the agent able to route the problem to `ask` instead.
  assert.deepEqual(await handle('item/commandExecution/requestApproval', V2_EXEC), {
    decision: 'decline',
  });
});

test('an approved legacy command answers `approved`, not the v2 word', async () => {
  const { handle } = handlerFor(APPROVED);
  assert.deepEqual(await handle('execCommandApproval', LEGACY_EXEC), { decision: 'approved' });
});

test("a denied legacy command carries the person's words back to the model", async () => {
  // The one place a denial reaches the model as TEXT. `ReviewDecision::denied`
  // has a `rejection` field; the v2 enum has no message field at all, which is
  // why the v2 denial above is silent to the model and loud only in the log.
  const { handle } = handlerFor({
    decision: 'denied',
    reason: 'a person denied this call',
    note: 'do it inside the worktree',
  });
  const reply = (await handle('applyPatchApproval', {
    conversationId: 'th_1',
    callId: 'call_2',
    fileChanges: { '/etc/hosts': { add: {} } },
    reason: null,
    grantRoot: null,
  })) as { decision: { denied: { rejection: string } } };

  assert.match(reply.decision.denied.rejection, /a person denied this call/u);
  assert.match(reply.decision.denied.rejection, /do it inside the worktree/u);
});

test('every bridgeable method is answered, and never with an error frame', async () => {
  const { handle } = handlerFor(APPROVED);
  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]) {
    const reply = await handle(method, { itemId: 'i', callId: 'c', startedAtMs: 1 });
    assert.equal(typeof reply, 'object', method);
  }
});

// ---------------------------------------------------------------------------
// The question a person is shown.
// ---------------------------------------------------------------------------

test('the question names the command, its directory, and why it was escalated', async () => {
  const { handle, asked } = handlerFor(APPROVED);
  await handle('item/commandExecution/requestApproval', V2_EXEC);

  assert.equal(asked.length, 1);
  const q = asked[0]!;
  assert.equal(q.toolName, 'command');
  assert.equal(q.reason, 'the command changes file ownership');
  assert.match(q.title ?? '', /chown -R me \/opt\/thing/u);
  assert.deepEqual(q.toolInput, { command: 'chown -R me /opt/thing', cwd: '/work/repo' });
});

test('a legacy argv array is shown as a command line, not as JSON', async () => {
  const { handle, asked } = handlerFor(APPROVED);
  await handle('execCommandApproval', LEGACY_EXEC);
  assert.match(asked[0]!.title ?? '', /chown -R me \/opt\/thing/u);
});

test('a patch approval names the files it would write', async () => {
  const { handle, asked } = handlerFor(APPROVED);
  await handle('applyPatchApproval', {
    conversationId: 'th_1',
    callId: 'call_3',
    fileChanges: { 'src/a.ts': {}, 'src/b.ts': {} },
    reason: null,
    grantRoot: null,
  });
  assert.equal(asked[0]!.toolName, 'file-change');
  assert.match(asked[0]!.title ?? '', /src\/a\.ts, src\/b\.ts/u);
});

test('a request with no reason says why it arrived instead of inventing a hazard', async () => {
  const { handle, asked } = handlerFor(APPROVED);
  await handle('item/fileChange/requestApproval', {
    threadId: 't',
    turnId: 'u',
    itemId: 'item_9',
    startedAtMs: 1,
    grantRoot: '/opt/elsewhere',
  });
  assert.match(asked[0]!.reason, /approval policy escalated this call/u);
  assert.match(asked[0]!.title ?? '', /writes under \/opt\/elsewhere/u);
});

// ---------------------------------------------------------------------------
// Identity. The hub keys the approval on this, so a collision answers the
// wrong call and a drift orphans the right one.
// ---------------------------------------------------------------------------

test('two requests sharing an item id are two approvals when their callbacks differ', async () => {
  const { handle, asked } = handlerFor(APPROVED);
  const shared = { threadId: 't', turnId: 'u', itemId: 'item_1', startedAtMs: 1, command: 'ls' };
  await handle('item/commandExecution/requestApproval', { ...shared, approvalId: 'cb_a' });
  await handle('item/commandExecution/requestApproval', { ...shared, approvalId: 'cb_b' });

  assert.notEqual(asked[0]!.toolUseId, asked[1]!.toolUseId);
  assert.equal(asked[0]!.toolUseId, 'exec:item_1:cb_a');
});

test('a command approval and a file approval on one item are never one approval', async () => {
  const { handle, asked } = handlerFor(APPROVED);
  const shared = { threadId: 't', turnId: 'u', itemId: 'item_1', startedAtMs: 1 };
  await handle('item/commandExecution/requestApproval', shared);
  await handle('item/fileChange/requestApproval', shared);
  assert.notEqual(asked[0]!.toolUseId, asked[1]!.toolUseId);
});

// ---------------------------------------------------------------------------
// Nothing here may hang. A parked approval already outlives every other wait in
// this adapter; a parked FAILURE would outlive the lease.
// ---------------------------------------------------------------------------

test('a requester that throws denies rather than leaving the app-server waiting', async () => {
  const { handle, events } = handlerFor(new Error('hub unreachable'));
  const reply = (await handle('execCommandApproval', LEGACY_EXEC)) as {
    decision: { denied: { rejection: string } };
  };
  assert.match(reply.decision.denied.rejection, /the approval channel failed: hub unreachable/u);
  assert.equal(events.some((e) => e.kind === 'progress' && /^denied /u.test(e.text)), true);
});

test('a permission-profile request is refused even WITH a channel, because it is not a yes/no', async () => {
  // Its reply is a `GrantedPermissionProfile` plus a scope. Approving it would
  // mean synthesizing a filesystem/network permission set nobody was shown.
  const { handle, asked } = handlerFor(APPROVED);
  await assert.rejects(
    handle('item/permissions/requestApproval', { threadId: 't', turnId: 'u', itemId: 'i' }),
    /not answerable by a headless host/u,
  );
  assert.deepEqual(asked, [], 'no person is asked a question that has no yes/no answer');
});

test('with NO requester every approval is refused exactly as it was before the channel existed', async () => {
  const events: AgentEvent[] = [];
  const handle = handleServerRequest((e) => events.push(e));
  for (const method of [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'applyPatchApproval',
    'execCommandApproval',
  ]) {
    await assert.rejects(handle(method, {}), /not answerable by a headless host/u, method);
  }
  assert.equal(events.length, 5, 'each refusal is reported, none silently');
});

test('the owenloop MCP auto-grant is untouched by any of this', async () => {
  // The one thing this adapter grants without a person. A regression here makes
  // `submit` impossible and every codex order dies owing its artifact.
  const { handle, asked } = handlerFor(DENIED);
  const reply = await handle('mcpServer/elicitation/request', {
    serverName: 'owenloop',
    _meta: { codex_approval_kind: 'mcp_tool_call' },
  });
  assert.deepEqual(reply, { action: 'accept', content: {} });
  assert.deepEqual(asked, [], 'owenloop\'s own mount does not consume a human decision');
});
