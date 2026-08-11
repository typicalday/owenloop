/**
 * Phase 2B unit tests: the JSON-RPC framing layer, the recorded-fixture replay,
 * and the pure params builders.
 *
 * NOTHING HERE SPAWNS A PROCESS. The framing tests drive `createRpcCore` over an
 * injected `write` sink, and the protocol tests replay frames that were RECORDED
 * from a real `codex app-server` (see the fixture header comments below). The
 * live end-to-end smoke lives in `harness-codex-live.test.ts`, gated on
 * `OWENLOOP_LIVE_TESTS=1`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyFrame,
  createLineReader,
  createRpcCore,
  JsonRpcError,
} from '../src/harness/jsonrpc-stdio.ts';
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  codexAdapter,
  isResumeMiss,
  mapNotification,
  readOwenloopMountFailure,
  readTurnCompleted,
  RESUME_UNAVAILABLE_CODE,
} from '../src/harness/codex.ts';
import { normalizeStepPermissions } from '../src/harness/permissions.ts';
import type { AgentEvent, DeliverArgs, StartArgs } from '../src/harness/contract.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Harness {
  written: string[];
  notifications: Array<{ method: string; params: unknown }>;
  serverRequests: Array<{ method: string; params: unknown }>;
  stderr: string[];
  core: ReturnType<typeof createRpcCore>;
}

function makeCore(
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>,
): Harness {
  const written: string[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const serverRequests: Array<{ method: string; params: unknown }> = [];
  const stderr: string[] = [];
  const core = createRpcCore({
    write: (line) => written.push(line),
    onNotification: (method, params) => notifications.push({ method, params }),
    onServerRequest: async (method, params) => {
      serverRequests.push({ method, params });
      if (onServerRequest !== undefined) return onServerRequest(method, params);
      return { ok: true };
    },
    onStderr: (line) => stderr.push(line),
  });
  return { written, notifications, serverRequests, stderr, core };
}

/** The frames the server would send, WITHOUT `jsonrpc` — as observed. */
function inbound(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

interface FixtureEntry {
  dir: 'in' | 'out';
  t: number;
  frame: Record<string, unknown>;
}

function loadFixture(name: string): FixtureEntry[] {
  const raw = readFileSync(join(FIXTURE_DIR, name), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FixtureEntry);
}

/** A minimal but REAL `StartArgs`; permissions always come from the real
 *  normalizer so these tests cannot drift from Phase 1's semantics. */
function startArgs(
  bag: Record<string, unknown> | undefined,
  over: Partial<StartArgs> = {},
  step?: { model?: string },
): StartArgs {
  return {
    brief: 'do the thing',
    cwd: '/tmp/fixture-cwd',
    owenloopMcp: { command: '/tmp/fixture-node', args: ['/tmp/fixture-mcp/owenloop-server.mjs'] },
    permissions: normalizeStepPermissions(bag, step),
    ...over,
  };
}

/**
 * PHASE 4 — the `DeliverArgs` half of the same fixture. `deliver` and
 * `buildThreadResumeParams` now take the full args, `permissions` included:
 * the resume params are built FROM these args, so a resumed thread that was
 * handed no permissions would silently revert to the server's defaults.
 */
function deliverArgs(
  bag: Record<string, unknown> | undefined = undefined,
  over: Partial<DeliverArgs> = {},
): DeliverArgs {
  const { brief: _brief, ...rest } = startArgs(bag);
  return { ...rest, ...over };
}

// ---------------------------------------------------------------------------
// A. framing and correlation — no process at all
// ---------------------------------------------------------------------------

test('A1 a request writes a well-formed frame and resolves on its response', async () => {
  const h = makeCore();
  const p = h.core.request<{ ok: boolean }>('thing/do', { a: 1 });

  assert.equal(h.written.length, 1);
  const sent = JSON.parse(h.written[0] as string) as Record<string, unknown>;
  assert.equal(sent['jsonrpc'], '2.0');
  assert.equal(sent['method'], 'thing/do');
  assert.deepEqual(sent['params'], { a: 1 });
  assert.equal(typeof sent['id'], 'number');
  // Every outbound frame is newline-TERMINATED, and carries exactly one newline.
  assert.ok((h.written[0] as string).endsWith('\n'));
  assert.equal((h.written[0] as string).split('\n').length, 2);

  h.core.onData(inbound({ id: sent['id'] as number, result: { ok: true } }));
  assert.deepEqual(await p, { ok: true });
  assert.equal(h.core.pendingCount(), 0);
});

test('A2 responses are matched by id, not by arrival order', async () => {
  const h = makeCore();
  const first = h.core.request<string>('one');
  const second = h.core.request<string>('two');
  const idOne = (JSON.parse(h.written[0] as string) as { id: number }).id;
  const idTwo = (JSON.parse(h.written[1] as string) as { id: number }).id;
  assert.notEqual(idOne, idTwo);

  // Answer the SECOND request first.
  h.core.onData(inbound({ id: idTwo, result: 'B' }));
  h.core.onData(inbound({ id: idOne, result: 'A' }));

  assert.equal(await first, 'A');
  assert.equal(await second, 'B');
});

test('A3 an error response rejects with a JsonRpcError carrying code and message', async () => {
  const h = makeCore();
  const p = h.core.request('thread/resume');
  const id = (JSON.parse(h.written[0] as string) as { id: number }).id;
  h.core.onData(
    inbound({ id, error: { code: -32600, message: 'no rollout found for thread id abc' } }),
  );

  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof JsonRpcError);
  assert.equal(err.code, -32600);
  assert.match(err.message, /no rollout found/);
  assert.equal(h.core.pendingCount(), 0);
});

test('A4 a frame WITHOUT the jsonrpc member is still understood', async () => {
  // The observed server omits `jsonrpc` on every inbound frame. A client that
  // validated it would reject every real response.
  const h = makeCore();
  const p = h.core.request('thing/do');
  const id = (JSON.parse(h.written[0] as string) as { id: number }).id;
  h.core.onData(inbound({ id, result: 42 }));
  assert.equal(await p, 42);

  h.core.onData(inbound({ method: 'some/notification', params: { x: 1 } }));
  assert.deepEqual(h.notifications, [{ method: 'some/notification', params: { x: 1 } }]);
});

test('A5 classifyFrame keys on structure, never on jsonrpc', () => {
  assert.equal(classifyFrame({ id: 1, result: {} }), 'response');
  assert.equal(classifyFrame({ id: 1, error: { code: -1, message: 'x' } }), 'response');
  assert.equal(classifyFrame({ id: 1, method: 'server/asks' }), 'server-request');
  assert.equal(classifyFrame({ method: 'server/tells' }), 'notification');
  assert.equal(classifyFrame({}), 'unknown');
  // A null id is NOT a correlation id; it must not be mistaken for a response.
  assert.equal(classifyFrame({ id: null, method: 'server/tells' }), 'notification');
});

test('A6 a frame split across chunk boundaries is reassembled', async () => {
  const h = makeCore();
  const p = h.core.request('thing/do');
  const id = (JSON.parse(h.written[0] as string) as { id: number }).id;
  const line = inbound({ id, result: { deep: { value: 'ok' } } });

  for (let i = 0; i < line.length; i += 3) h.core.onData(line.slice(i, i + 3));
  assert.deepEqual(await p, { deep: { value: 'ok' } });
});

test('A7 multiple frames in one chunk are all delivered, and UTF-8 is not corrupted', () => {
  const h = makeCore();
  // A 4-byte emoji deliberately straddles the chunk split.
  const text = '完了 ✅';
  const buf = Buffer.from(
    inbound({ method: 'a/one', params: { text } }) + inbound({ method: 'a/two', params: {} }),
    'utf8',
  );
  const cut = buf.indexOf(Buffer.from('✅', 'utf8')) + 1; // mid-codepoint
  h.core.onData(buf.subarray(0, cut));
  h.core.onData(buf.subarray(cut));

  assert.equal(h.notifications.length, 2);
  assert.deepEqual(h.notifications[0], { method: 'a/one', params: { text } });
  assert.equal(h.notifications[1]?.method, 'a/two');
});

test('A8 a non-JSON stdout line is reported and does not throw or stall the stream', async () => {
  const h = makeCore();
  const p = h.core.request('thing/do');
  const id = (JSON.parse(h.written[0] as string) as { id: number }).id;

  h.core.onData('this is not json\n');
  h.core.onData('\n'); // a blank line is skipped silently
  h.core.onData(inbound({ id, result: 'still works' }));

  assert.equal(await p, 'still works');
  assert.equal(h.stderr.length, 1);
  assert.match(h.stderr[0] as string, /non-JSON/);
});

test('A9 a server request is always answered — a reply frame is written for its id', async () => {
  // Success path: assert on the BYTES, not just that the handler fired.
  const ok = makeCore(async () => ({ answered: true }));
  ok.core.onData(inbound({ id: 'srv-1', method: 'item/tool/requestUserInput', params: { q: 1 } }));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(ok.serverRequests, [
    { method: 'item/tool/requestUserInput', params: { q: 1 } },
  ]);
  assert.equal(ok.written.length, 1);
  const reply = JSON.parse(ok.written[0] as string) as Record<string, unknown>;
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 'srv-1', result: { answered: true } });

  // Throwing path: an ERROR reply for the same id, so the server is never left
  // waiting. A hung server request is the worst outcome available here.
  const bad = makeCore(async () => {
    throw new Error('headless host cannot answer');
  });
  bad.core.onData(inbound({ id: 7, method: 'execCommandApproval', params: {} }));
  await new Promise((r) => setImmediate(r));

  assert.equal(bad.written.length, 1);
  const errReply = JSON.parse(bad.written[0] as string) as {
    id: number;
    error: { code: number; message: string };
  };
  assert.equal(errReply.id, 7);
  assert.equal(errReply.error.code, -32603);
  assert.match(errReply.error.message, /headless host cannot answer/);
});

test('A10 a request times out rather than hanging forever', async () => {
  const h = makeCore();

  // KEEP THIS `keepAlive` — it is load-bearing, not scaffolding.
  //
  // `createRpcCore` deliberately calls `timer.unref()` on the per-request
  // timeout so a still-pending request can never hold the runner's process
  // open (see the MANDATORY comment in `src/harness/jsonrpc-stdio.ts`). That
  // production property is exactly what makes this test unable to wait on the
  // timer alone: `makeCore` spawns nothing, so between the `request` call and
  // the timeout firing there is NO ref'd handle anywhere, node drains the loop,
  // and node:test fails the pending `await` with "Promise resolution is still
  // pending but the event loop has already resolved". It is environment- and
  // ordering-dependent: it passed on macOS locally and failed on the Linux CI
  // runner. A ref'd handle held across the await — cleared in `finally` so it
  // cannot leak into the next test — is what makes the wait deterministic.
  const keepAlive = setTimeout(() => {}, 5_000);
  let err: unknown;
  try {
    err = await h.core.request('never/answered', {}, 25).then(
      () => undefined,
      (e: unknown) => e,
    );
  } finally {
    clearTimeout(keepAlive);
  }

  assert.ok(err instanceof Error);
  assert.match(err.message, /never\/answered/);
  assert.match(err.message, /timed out/);
  assert.equal(h.core.pendingCount(), 0);

  // rejectAll drains anything still outstanding — the teardown path.
  const h2 = makeCore();
  const p = h2.core.request('also/never');
  h2.core.rejectAll(new Error('client disposed'));
  await assert.rejects(p, /client disposed/);
  assert.equal(h2.core.pendingCount(), 0);
});

test('A10b an unmatched response is reported, never thrown', () => {
  const h = makeCore();
  h.core.onData(inbound({ id: 9999, result: 'nobody asked' }));
  assert.equal(h.stderr.length, 1);
  assert.match(h.stderr[0] as string, /unmatched response/);
});

test('A10c createLineReader strips CR and skips blank lines', () => {
  const lines: string[] = [];
  const read = createLineReader((l) => lines.push(l));
  read('one\r\n\ntwo\n');
  assert.deepEqual(lines, ['one', 'two']);
});

// ---------------------------------------------------------------------------
// B. recorded-fixture replay
// ---------------------------------------------------------------------------

test('B1 the recorded session replays through mapNotification without throwing', () => {
  const entries = loadFixture('codex-app-server-session.jsonl');
  const events: AgentEvent[] = [];
  for (const e of entries) {
    if (e.dir !== 'in') continue;
    const method = e.frame['method'];
    if (typeof method !== 'string') continue;
    const ev = mapNotification(method, e.frame['params']);
    if (ev !== undefined) events.push(ev);
  }

  // A real session, both legs, ends with no failure at all.
  assert.equal(events.filter((e) => e.kind === 'exited').length, 0);
  assert.ok(events.length > 0);
  const text = events.map((e) => (e.kind === 'progress' ? e.text : '')).join('\n');
  assert.match(text, /turn .* started/);
  assert.match(text, /turn .* completed/);
  // Two turns were recorded — the original and the one after `thread/resume` —
  // so the fixture covers the resume leg, not just the cold start.
  assert.equal(text.split('\n').filter((l) => /^turn .* completed$/.test(l)).length, 2);
  // The agent's streamed answer survives the mapping.
  assert.match(text, /^RES$/m);
  assert.match(text, /^UM$/m);
  assert.match(text, /^ED$/m);
});

test('B9 the recording drove the REAL owenloop mount, tools and all', () => {
  // This is what makes the fixture worth having: it was recorded against
  // `bin/owenloop.mjs work hold --order ... --mcp` pointed at a mock hub, so the
  // frames below are the live protocol, not a hand-written approximation.
  const entries = loadFixture('codex-app-server-session.jsonl');
  const inbound = entries.filter((e) => e.dir === 'in');

  const mount = (
    entries.find((e) => e.dir === 'out' && e.frame['method'] === 'thread/start')!
      .frame['params'] as { config: { mcp_servers: { owenloop: { args: string[] } } } }
  ).config.mcp_servers.owenloop;
  assert.deepEqual(mount.args.slice(1), ['work', 'hold', '--order', 'wf1/run1', '--origin', 'http://127.0.0.1:9999', '--mcp']);

  const calls = inbound
    .filter((e) => e.frame['method'] === 'item/completed')
    .map((e) => (e.frame['params'] as { item: Record<string, unknown> }).item)
    .filter((item) => item['type'] === 'mcpToolCall');
  assert.deepEqual(
    calls.map((c) => [c['server'], c['tool'], c['status']]),
    [
      ['owenloop', 'get_order', 'completed'],
      ['owenloop', 'submit', 'completed'],
    ],
    'both owenloop tools really ran, and both really succeeded',
  );

  // MEASURED: `approvalPolicy:'never'` does not cover MCP tool calls. Each call
  // above was gated on an elicitation carrying the approval kind, and each was
  // answered `accept` — which is why they completed instead of being recorded as
  // `user rejected MCP tool call`. See D9 for the adapter-side guard.
  const asks = inbound.filter((e) => e.frame['method'] === 'mcpServer/elicitation/request');
  assert.equal(asks.length, 2);
  for (const ask of asks) {
    const p = ask.frame['params'] as { serverName: string; _meta: { codex_approval_kind: string } };
    assert.equal(p.serverName, 'owenloop');
    assert.equal(p._meta.codex_approval_kind, 'mcp_tool_call');
    const reply = entries.find(
      (e) => e.dir === 'out' && e.frame['id'] === ask.frame['id'] && e.frame['result'] !== undefined,
    );
    assert.ok(reply, 'every elicitation was answered');
    assert.deepEqual(reply.frame['result'], { action: 'accept', content: {} });
  }

  // The resume leg: a second turn on the SAME thread id after `thread/resume`.
  const resume = entries.find((e) => e.dir === 'out' && e.frame['method'] === 'thread/resume');
  assert.ok(resume, 'the fixture must carry the resume leg');
  const turnIds = inbound
    .filter((e) => e.frame['method'] === 'turn/completed')
    .map((e) => (e.frame['params'] as { turn: { id: string } }).turn.id);
  assert.equal(turnIds.length, 2);
  assert.notEqual(turnIds[0], turnIds[1], 'the resumed turn is a NEW turn on the same thread');
});

test('B10 a cancelled mount startup is not a failure', () => {
  // Observed in the recording: codex reports `starting` twice and `cancelled`
  // once for a mount that then reaches `ready`. Treating any non-ready status as
  // a failure would abort a perfectly healthy session.
  const entries = loadFixture('codex-app-server-session.jsonl');
  const statuses = entries
    .filter((e) => e.dir === 'in' && e.frame['method'] === 'mcpServer/startupStatus/updated')
    .map((e) => e.frame['params'] as { status: string });
  assert.ok(
    statuses.some((s) => s.status === 'cancelled'),
    'the fixture carries the cancelled counter-example',
  );
  for (const e of entries) {
    if (e.dir !== 'in' || e.frame['method'] !== 'mcpServer/startupStatus/updated') continue;
    assert.equal(readOwenloopMountFailure('mcpServer/startupStatus/updated', e.frame['params']), undefined);
  }
});

test('B2 the fixture proves turn/start is an ACK, not turn end', () => {
  const entries = loadFixture('codex-app-server-session.jsonl');
  const sent = entries.find((e) => e.dir === 'out' && e.frame['method'] === 'turn/start');
  assert.ok(sent, 'fixture must contain an outbound turn/start');
  const ack = entries.find(
    (e) => e.dir === 'in' && e.frame['id'] === sent.frame['id'] && e.frame['result'] !== undefined,
  );
  assert.ok(ack, 'fixture must contain the turn/start response');
  const completed = entries.find((e) => e.dir === 'in' && e.frame['method'] === 'turn/completed');
  assert.ok(completed, 'fixture must contain turn/completed');

  // This is the whole reason start/deliver resolve on the notification: the
  // response came back in milliseconds while the turn ran for seconds.
  const ackResult = ack.frame['result'] as { turn: { status: string } };
  assert.equal(ackResult.turn.status, 'inProgress');
  assert.ok(
    completed.t - ack.t > 1000,
    `turn end must be far later than the ack (ack t=${ack.t}, completed t=${completed.t})`,
  );
});

test('B3 the fixture proves the declared mount is the only one asked for, and it starts', () => {
  // NOT provable from the committed file, deliberately: the live recording also
  // carried startup frames for the operator's own on-disk MCP servers — which is
  // what proves `config.mcp_servers` MERGES with `~/.codex/config.toml` rather
  // than replacing it — and those frames were DELETED during scrubbing, because
  // they enumerate a private plugin inventory. What survives is this side of it:
  // the params declare exactly one server, and that one reached `ready`.
  const entries = loadFixture('codex-app-server-session.jsonl');
  const declared = entries.find((e) => e.dir === 'out' && e.frame['method'] === 'thread/start');
  assert.ok(declared);
  const params = declared.frame['params'] as { config: { mcp_servers: Record<string, unknown> } };
  assert.deepEqual(Object.keys(params.config.mcp_servers), ['owenloop']);

  const ready = entries.filter(
    (e) =>
      e.dir === 'in' &&
      e.frame['method'] === 'mcpServer/startupStatus/updated' &&
      (e.frame['params'] as { name: string }).name === 'owenloop',
  );
  assert.ok(ready.length > 0, 'the owenloop mount must report a startup status');
  assert.ok(
    ready.some((e) => (e.frame['params'] as { status: string }).status === 'ready'),
    'the owenloop mount reached ready in the recording',
  );
});

test('B4 the recorded resume of an unknown thread is the resume-unavailable signature', () => {
  const entries = loadFixture('codex-app-server-resume-unknown.jsonl');
  const sent = entries.find((e) => e.dir === 'out' && e.frame['method'] === 'thread/resume');
  assert.ok(sent);
  const failed = entries.find(
    (e) => e.dir === 'in' && e.frame['id'] === sent.frame['id'] && e.frame['error'] !== undefined,
  );
  assert.ok(failed, 'fixture must contain the resume rejection');

  const recorded = failed.frame['error'] as { code: number; message: string };
  assert.equal(recorded.code, RESUME_UNAVAILABLE_CODE);
  assert.ok(isResumeMiss(new JsonRpcError(recorded.code, recorded.message)));
});

test('B5 -32600 alone is NOT a resume miss — the fixture carries the counter-example', () => {
  // The same recording asks for a method that does not exist. The server answers
  // with the SAME code and a different message. Matching the code alone would
  // throw away a live thread over a typo.
  const entries = loadFixture('codex-app-server-resume-unknown.jsonl');
  const unknownMethod = entries.find(
    (e) => e.dir === 'out' && String(e.frame['method']).includes('DoesNotExist'),
  );
  assert.ok(unknownMethod, 'fixture must contain the unknown-method probe');
  const answer = entries.find(
    (e) =>
      e.dir === 'in' && e.frame['id'] === unknownMethod.frame['id'] && e.frame['error'] !== undefined,
  );
  assert.ok(answer, 'an unknown METHOD is answered, not dropped');

  const recorded = answer.frame['error'] as { code: number; message: string };
  // Recorded reality: -32600 "unknown variant", NOT the -32601 the spec reserves.
  assert.equal(recorded.code, RESUME_UNAVAILABLE_CODE);
  assert.match(recorded.message, /unknown variant/);
  assert.equal(isResumeMiss(new JsonRpcError(recorded.code, recorded.message)), false);
});

test('B6 mapNotification is total — unknown shapes never throw', () => {
  const junk: unknown[] = [undefined, null, 42, 'text', [], { turn: null }, { item: 3 }];
  for (const params of junk) {
    for (const method of [
      'turn/started',
      'turn/completed',
      'item/started',
      'item/completed',
      'item/agentMessage/delta',
      'mcpServer/startupStatus/updated',
      'error',
      'never/heard/of/this',
    ]) {
      assert.doesNotThrow(() => mapNotification(method, params));
      assert.doesNotThrow(() => readTurnCompleted(method, params));
      assert.doesNotThrow(() => readOwenloopMountFailure(method, params));
    }
  }
});

test('B7 the owenloop mount failure gates on an explicit failed, and only for owenloop', () => {
  const failed = readOwenloopMountFailure('mcpServer/startupStatus/updated', {
    name: 'owenloop',
    status: 'failed',
    error: 'spawn ENOENT',
  });
  assert.match(failed as string, /owenloop MCP server failed to start: spawn ENOENT/);

  // Another server failing is not our problem — the step can still submit.
  assert.equal(
    readOwenloopMountFailure('mcpServer/startupStatus/updated', {
      name: 'some-other-server',
      status: 'failed',
    }),
    undefined,
  );
  // Not-yet-ready is NOT failure. Gating on the absence of `ready` would deadlock.
  for (const status of ['starting', 'ready', 'cancelled']) {
    assert.equal(
      readOwenloopMountFailure('mcpServer/startupStatus/updated', { name: 'owenloop', status }),
      undefined,
    );
  }
});

test('B8 turn status drives the turn-end decision', () => {
  const outcome = (status: string, error?: unknown): ReturnType<typeof readTurnCompleted> =>
    readTurnCompleted('turn/completed', { turn: { id: 't1', status, error } });

  assert.deepEqual(outcome('completed'), { status: 'completed', turnId: 't1', error: undefined });
  assert.deepEqual(outcome('interrupted'), {
    status: 'interrupted',
    turnId: 't1',
    error: undefined,
  });
  assert.deepEqual(outcome('inProgress'), { status: 'inProgress', turnId: 't1', error: undefined });
  assert.deepEqual(outcome('failed', { message: 'boom', additionalDetails: 'ctx' }), {
    status: 'failed',
    turnId: 't1',
    error: 'boom (ctx)',
  });
  assert.equal(readTurnCompleted('turn/started', { turn: { id: 't1' } }), undefined);
});

// ---------------------------------------------------------------------------
// C. params builders, through the REAL normalizer
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  bag: Record<string, unknown> | undefined;
  step?: { model?: string };
  over?: Partial<StartArgs>;
  expect(params: Record<string, unknown>, events: AgentEvent[]): void;
}

const MOUNT = { command: '/tmp/fixture-node', args: ['/tmp/fixture-mcp/owenloop-server.mjs'] };

/**
 * The built mount is `MOUNT` plus a forwarded `env` — codex hands an MCP child
 * only a tiny core environment, so the holder's admitted identity and credential
 * backend controls have to ride on the mount. `OWENLOOP_TOKEN` is deliberately
 * denied; the holder resolves its stored credential instead. C15 pins the
 * forwarding rule itself; every other case only needs "the real mount, intact".
 */
function assertMount(actual: unknown): void {
  const m = actual as { command: string; args: string[]; env: Record<string, string> };
  assert.equal(m.command, MOUNT.command);
  assert.deepEqual(m.args, MOUNT.args);
  assert.equal(typeof m.env, 'object');
  assert.ok(m.env !== null && !Array.isArray(m.env), 'the mount must carry an env map');
}

const CASES: Case[] = [
  {
    name: 'C1 an empty bag yields the safe defaults and the owenloop mount',
    bag: undefined,
    expect(p) {
      assert.equal(p['cwd'], '/tmp/fixture-cwd');
      assert.equal(p['approvalPolicy'], 'never');
      assert.equal(p['sandbox'], 'workspace-write');
      // The KEY is absent, not null — a null would pin the thread to no model.
      assert.equal('model' in p, false);
      const config = p['config'] as { mcp_servers: Record<string, unknown> };
      assert.deepEqual(Object.keys(config.mcp_servers), ['owenloop']);
      assertMount(config.mcp_servers['owenloop']);
    },
  },
  {
    name: 'C2 a bag-level model is carried, a step model shadows it',
    bag: { model: 'from-bag' },
    step: { model: 'from-step' },
    expect(p) {
      assert.equal(p['model'], 'from-step');
    },
  },
  {
    name: 'C3 the per-start model override beats both',
    bag: { model: 'from-bag' },
    over: { model: 'from-start-args' },
    expect(p) {
      assert.equal(p['model'], 'from-start-args');
    },
  },
  {
    name: 'C5 a native approval policy passes through untouched and silently',
    bag: { permissionMode: 'on-request' },
    expect(p, events) {
      assert.equal(p['approvalPolicy'], 'on-request');
      assert.equal(events.length, 0);
    },
  },
  {
    name: 'C6 extra MCP servers merge in, and owenloop wins a name clash',
    bag: {
      mcpServers: {
        extra: { command: 'extra-server', args: [] },
        owenloop: { command: 'an-imposter', args: ['--pretend'] },
      },
    },
    expect(p) {
      const config = p['config'] as { mcp_servers: Record<string, unknown> };
      assert.deepEqual(config.mcp_servers['extra'], { command: 'extra-server', args: [] });
      // Losing the real mount means no `submit` tool and a dead order.
      assertMount(config.mcp_servers['owenloop']);
    },
  },
  {
    name: 'C7 codexConfig merges UNDER mcp_servers and cannot displace the mount',
    bag: {
      codexConfig: {
        model_reasoning_summary: 'detailed',
        mcp_servers: { owenloop: { command: 'nope', args: [] }, other: { command: 'ok', args: [] } },
      },
    },
    expect(p) {
      const config = p['config'] as {
        model_reasoning_summary: string;
        mcp_servers: Record<string, unknown>;
      };
      assert.equal(config.model_reasoning_summary, 'detailed');
      assert.deepEqual(config.mcp_servers['other'], { command: 'ok', args: [] });
      assertMount(config.mcp_servers['owenloop']);
    },
  },
  {
    name: 'C8 a legal sandbox override is honored, an illegal one is rejected loudly',
    bag: { sandbox: 'read-only' },
    expect(p, events) {
      assert.equal(p['sandbox'], 'read-only');
      assert.equal(events.length, 0);
    },
  },
  {
    name: 'C10 neutral keys with no thread-start equivalent are dropped, not smuggled',
    bag: { tools: ['Read', 'Edit'], disallowedTools: 'Bash', maxTurns: 40, effort: 'high' },
    expect(p) {
      for (const key of ['tools', 'disallowedTools', 'maxTurns', 'effort', 'permissions']) {
        assert.equal(key in p, false, `${key} must not reach thread/start`);
      }
    },
  },
];

for (const c of CASES) {
  test(c.name, () => {
    const events: AgentEvent[] = [];
    const params = buildThreadStartParams(startArgs(c.bag, c.over, c.step), (e) => events.push(e));
    c.expect(params, events);
  });
}

test('C4 an unmappable permissionMode is rejected instead of falling back', () => {
  assert.throws(
    () => buildThreadStartParams(startArgs({ permissionMode: 'acceptEdits' })),
    /permissionMode must be one of/,
  );
});

test('C9 an illegal sandbox is rejected instead of falling back', () => {
  assert.throws(
    () => buildThreadStartParams(startArgs({ sandbox: 'yolo-full-access' })),
    /sandbox must be one of/,
  );
});

test('C11 buildTurnStartParams wraps the text as a UserInput array', () => {
  assert.deepEqual(buildTurnStartParams('th-1', 'hello'), {
    threadId: 'th-1',
    input: [{ type: 'text', text: 'hello' }],
  });
  // effort rides the TURN, not the thread.
  assert.deepEqual(buildTurnStartParams('th-1', 'hello', 'high'), {
    threadId: 'th-1',
    input: [{ type: 'text', text: 'hello' }],
    effort: 'high',
  });
  // An empty effort is omitted rather than sent as ''.
  assert.equal('effort' in buildTurnStartParams('th-1', 'hi', ''), false);
});

test('C10b neutral filesystem modes map exactly to Codex sandbox modes', () => {
  assert.equal(buildThreadStartParams(startArgs({ filesystem: 'read-only' }))['sandbox'], 'read-only');
  assert.equal(
    buildThreadStartParams(startArgs({ filesystem: 'workspace-write' }))['sandbox'],
    'workspace-write',
  );
  assert.equal(
    buildThreadStartParams(startArgs({ filesystem: 'unrestricted' }))['sandbox'],
    'danger-full-access',
  );
});

test('C10c preflight refuses restrictions Codex cannot enforce', () => {
  const unsupported = codexAdapter.preflight(
    normalizeStepPermissions({ tools: [], disallowedTools: [], network: 'owenloop-only' }),
  );
  assert.deepEqual(unsupported.map((issue) => issue.field), [
    'tools',
    'disallowedTools',
    'network',
  ]);
});

test('C10d conflicting neutral and legacy sandbox values are refused', () => {
  const permissions = normalizeStepPermissions({ filesystem: 'unrestricted', sandbox: 'read-only' });
  assert.match(codexAdapter.preflight(permissions)[0]?.message ?? '', /conflicts with filesystem/);
  assert.throws(() => buildThreadStartParams({ ...deliverArgs(), permissions }), /conflicts with filesystem/);
});

test('C12 effort reaches the turn from either the step bag or the per-start override', () => {
  const fromBag = startArgs({ effort: 'high' });
  assert.equal(fromBag.permissions.effort, 'high');
  const fromArgs = startArgs({ effort: 'high' }, { effort: 'low' });
  assert.equal(fromArgs.effort ?? fromArgs.permissions.effort, 'low');
});

test('C13 a resume ALWAYS re-supplies the owenloop mount', () => {
  // Cold resume: this process never started the thread, so there is no base.
  const cold = buildThreadResumeParams('th-9', deliverArgs(undefined, { cwd: '/tmp/other' }));
  assert.equal(cold['threadId'], 'th-9');
  assert.equal(cold['cwd'], '/tmp/other');
  assertMount((cold['config'] as { mcp_servers: Record<string, unknown> }).mcp_servers['owenloop']);

  // PHASE 4: the resume params are derived from `args.permissions`, which is the
  // SAME source `buildThreadStartParams` reads. A cross-process resume therefore
  // rebuilds approvalPolicy/sandbox/model itself instead of reverting to the
  // server's defaults, which is what it did when `deliver` carried only two fields.
  const argsBag = deliverArgs({ permissionMode: 'on-request', sandbox: 'read-only' });
  const rebuilt = buildThreadResumeParams('th-9', argsBag);
  assert.equal(rebuilt['approvalPolicy'], 'on-request');
  assert.equal(rebuilt['sandbox'], 'read-only');
  assertMount((rebuilt['config'] as { mcp_servers: Record<string, unknown> }).mcp_servers['owenloop']);

  // Warm resume, same process: `args` WINS over `base` on every key it expresses.
  // `base` is a filler for what a `DeliverArgs` cannot say, never an override —
  // the args describe the CURRENT step def, `base` describes the thread's birth.
  const base = buildThreadStartParams(startArgs({ permissionMode: 'on-request', sandbox: 'read-only' }));
  const warm = buildThreadResumeParams('th-9', deliverArgs(), base);
  assert.equal(warm['approvalPolicy'], 'never', "the args' normalized default beats base");
  assert.equal(warm['sandbox'], 'workspace-write', "the args' normalized default beats base");
  assertMount((warm['config'] as { mcp_servers: Record<string, unknown> }).mcp_servers['owenloop']);

  // A key only `base` holds still survives the merge.
  const withExtra = buildThreadResumeParams('th-9', deliverArgs(), { ...base, someBaseOnlyKey: 'kept' });
  assert.equal(withExtra['someBaseOnlyKey'], 'kept');
});

test('C15 the mount carries the ADMITTED owenloop environment, and nothing else', async (t) => {
  // MEASURED against codex 0.146.0: an MCP server child is handed only
  // `HOME, LOGNAME, PATH, SHELL, TMPDIR, USER, __CF_USER_TEXT_ENCODING` plus
  // `mcp_servers.<name>.env`. Without the forward, `owenloop work hold --mcp` gets
  // none of the identity it needs, and codex reports the mount `failed` with
  // `connection closed: initialize response` — no `submit` tool, dead order.
  //
  // PHASE 6 CHANGED THE `OWENLOOP_*` HALF FROM A PREFIX TO AN ALLOWLIST. The
  // forward used to be `key.startsWith('OWENLOOP_')`, so a new variable could
  // not silently stop reaching the mount. That default is now inverted, because
  // `thread/start` params are persisted in codex's rollout file: only the names
  // in `ADMITTED_OWENLOOP_KEYS` travel, and a new `OWENLOOP_*` variable does not
  // reach the mount until somebody adds it there with a named consumer.
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  process.env['OWENLOOP_SESSION'] = 'sess-c15';
  process.env['OWENLOOP_SHIFT_ID'] = 'cond-c15';
  process.env['OWENLOOP_CACHE_DIR'] = '/tmp/fixture-cache';
  process.env['OWENLOOP_CREDENTIAL_COMMAND'] = '/bin/credential-helper';
  process.env['OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS'] = '2500';
  process.env['OWENLOOP_NO_KEYCHAIN'] = '1';
  process.env['OWENLOOP_TOKEN'] = 'tok-c15';
  process.env['OWENLOOP_SOMETHING_NEW'] = 'future-var';
  process.env['OWENLOOP_CREDENTIAL_ORIGIN'] = 'helper-origin';
  process.env['OWENLOOP_CREDENTIAL_SLOT'] = 'agent:holder';
  process.env['XDG_CONFIG_HOME'] = '/tmp/fixture-config';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'must-not-travel';

  for (const params of [
    buildThreadStartParams(startArgs(undefined)),
    buildThreadResumeParams('th-15', deliverArgs()),
  ]) {
    const mount = (params['config'] as { mcp_servers: { owenloop: { env: Record<string, string> } } })
      .mcp_servers.owenloop;
    // The admitted set travels — this is the identity `hold --mcp` reads.
    assert.equal(mount.env['OWENLOOP_SESSION'], 'sess-c15');
    assert.equal(mount.env['OWENLOOP_SHIFT_ID'], 'cond-c15');
    assert.equal(mount.env['OWENLOOP_CACHE_DIR'], '/tmp/fixture-cache');
    assert.equal(mount.env['OWENLOOP_CREDENTIAL_COMMAND'], '/bin/credential-helper');
    assert.equal(mount.env['OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS'], '2500');
    assert.equal(mount.env['OWENLOOP_NO_KEYCHAIN'], '1');
    assert.equal(mount.env['XDG_CONFIG_HOME'], '/tmp/fixture-config');
    // The dev-only hub bearer override does NOT travel (Phase 6 item 5): these
    // params reach codex's rollout file on disk.
    assert.equal('OWENLOOP_TOKEN' in mount.env, false);
    // Deny-by-default inside the namespace: a variable nobody admitted stays home.
    for (const key of [
      'OWENLOOP_SOMETHING_NEW',
      'OWENLOOP_CREDENTIAL_ORIGIN',
      'OWENLOOP_CREDENTIAL_SLOT',
    ]) {
      assert.equal(key in mount.env, false, `${key} must stay out of the persisted mount env`);
    }
    // And a blind `{...process.env}` would spray unrelated secrets onto disk.
    assert.equal('AWS_SECRET_ACCESS_KEY' in mount.env, false);
  }
});

test('C14 the builders never mutate their inputs', () => {
  const bag = { mcpServers: { extra: { command: 'x', args: [] } }, codexConfig: { a: 1 } };
  const snapshot = JSON.stringify(bag);
  const args = startArgs(bag);
  buildThreadStartParams(args);
  buildThreadResumeParams('th-1', args);
  assert.equal(JSON.stringify(bag), snapshot);
  // The caller's mount array is copied, not aliased.
  const params = buildThreadStartParams(args);
  const mount = (params['config'] as { mcp_servers: { owenloop: { args: string[] } } }).mcp_servers
    .owenloop;
  assert.notEqual(mount.args, args.owenloopMcp.args);
  assert.deepEqual(mount.args, args.owenloopMcp.args);
});

// ---------------------------------------------------------------------------
// D. adapter surface
// ---------------------------------------------------------------------------

test('D1 the adapter declares the identity and resume tier the runner keys on', () => {
  assert.equal(codexAdapter.id, 'codex');
  assert.equal(codexAdapter.resumeTier, 'native-token');
});

test('D2 deliver rejects with ResumeUnavailableError when the cwd is gone', async () => {
  // Checked BEFORE any spawn: a vanished worktree cannot host the resumed turn,
  // and finding that out from the server costs a process plus a handshake.
  const err = await codexAdapter
    .deliver(
      { harness: 'codex', token: 'th-1' },
      'carry on',
      deliverArgs(undefined, { cwd: '/tmp/definitely-not-a-real-directory-4f1c9' }),
      () => {},
    )
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  assert.ok(err instanceof Error);
  // Identified by CODE, never by instanceof: tests import src/ while the package
  // resolves dist/, so the two classes are different objects at runtime.
  assert.equal((err as { code?: string }).code, 'RESUME_UNAVAILABLE');
  assert.match(err.message, /resume cwd no longer exists/);
});

test('D3 stop on an unknown token is a silent no-op, and is idempotent', async () => {
  await codexAdapter.stop({ harness: 'codex', token: 'never-started' });
  await codexAdapter.stop({ harness: 'codex', token: 'never-started' });
});

test('D5 a resume miss against a real child rejects cleanly, with no unhandled rejection', async (t) => {
  // REGRESSION GUARD. The setup-failure path rejects the turn gate that nothing
  // is awaiting yet: `thread/resume` fails, the handler disposes the client,
  // disposal kills the child, `onExit` fires, and the gate rejects. Before the
  // fix that raised an unhandledRejection and killed the process, converting a
  // correctly reported ResumeUnavailableError into a crash. Only a REAL child
  // produces that ordering, so this test uses a stub binary rather than a mock.
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-codex-stub-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stub = join(dir, 'stub-app-server.mjs');
  writeFileSync(
    stub,
    `#!/usr/bin/env node
import { StringDecoder } from 'node:string_decoder';
const dec = new StringDecoder('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += dec.write(chunk);
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') {
      // Note the reply omits 'jsonrpc', exactly as the real server does.
      process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: 'stub/0' } }) + '\\n');
    } else if (m.method === 'thread/resume') {
      process.stdout.write(JSON.stringify({
        id: m.id,
        error: { code: -32600, message: 'no rollout found for thread id ' + m.params.threadId },
      }) + '\\n');
    }
  }
});
`,
    { mode: 0o755 },
  );

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => {
    unhandled.push(e);
  };
  process.on('unhandledRejection', onUnhandled);
  const previousBin = process.env['OWENLOOP_CODEX_BIN'];
  process.env['OWENLOOP_CODEX_BIN'] = stub;
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
    if (previousBin === undefined) delete process.env['OWENLOOP_CODEX_BIN'];
    else process.env['OWENLOOP_CODEX_BIN'] = previousBin;
  });

  const err = await codexAdapter
    .deliver({ harness: 'codex', token: 'th-gone' }, 'carry on', deliverArgs(undefined, { cwd: dir }), () => {})
    .then(
      () => undefined,
      (e: unknown) => e,
    );

  assert.ok(err instanceof Error);
  assert.equal((err as { code?: string }).code, 'RESUME_UNAVAILABLE');
  assert.match(err.message, /no longer knows thread th-gone/);

  // Let the child's exit and any trailing microtasks land before judging.
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(unhandled, [], 'the teardown path must not leave a rejection unhandled');
});

// ---------------------------------------------------------------------------
// D6–D8 — the teardown paths, against a REAL child.
//
// These three need a live process, not a mock: every defect they guard is an
// ORDERING between an in-flight promise, a notification, and a child's death,
// and a mock cannot get that ordering wrong in the same way. The stub below is a
// scripted app-server — it speaks the recorded protocol shapes (no `jsonrpc`
// member on inbound frames, `turn/start` answered as an ACK) and logs every
// request it receives so a test can assert what the adapter actually SENT.
// ---------------------------------------------------------------------------

const STUB_THREAD = '11111111-1111-4111-8111-111111111111';
const STUB_TURN = '22222222-2222-4222-8222-222222222222';

/**
 * @param mode
 *  - `refuse-initialize` — answers the handshake with a JSON-RPC error and then
 *    stays alive forever, so "was it disposed?" is answerable by signalling it.
 *  - `hang-turn` — acknowledges `turn/start`, emits `turn/started`, and then
 *    never completes the turn on its own. Only a `turn/interrupt` ends it.
 *  - `mount-failure` — as `hang-turn`, plus an owenloop mount that reports
 *    `failed` right after the turn begins.
 *  - `elicit` — asks TWO `mcpServer/elicitation/request`s (one for the owenloop
 *    mount's own tool call, one from an unrelated server), records both replies,
 *    then completes the turn.
 *
 * THE SPEC IS BAKED INTO THE SOURCE, NOT PASSED IN THE ENVIRONMENT. It used to
 * arrive as `process.env.OWENLOOP_STUB_SPEC`, which worked only while the
 * adapter forwarded the whole `OWENLOOP_*` prefix to its child. Phase 6 narrowed
 * that to an allowlist (`src/harness/child-env.ts`), and the right fix is NOT to
 * admit a test-only variable into a production allowlist — that would widen the
 * shipped filter to make a test pass. The stub's source is already generated per
 * test, so its configuration belongs in the source. The stub now needs no
 * environment at all, which also makes it a small live proof that a harness
 * child starts fine without owenloop's namespace.
 */
const stubSource = (spec: { pidFile: string; logFile: string; envFile: string; mode: string }): string => `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const spec = ${JSON.stringify(spec)};
writeFileSync(spec.pidFile, String(process.pid));
const envKeys = [
  'OWENLOOP_CACHE_DIR',
  'OWENLOOP_SHIFT_ID',
  'OWENLOOP_CREDENTIAL_COMMAND',
  'OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS',
  'OWENLOOP_NO_KEYCHAIN',
  'OWENLOOP_SESSION',
  'OWENLOOP_TOKEN',
  'OWENLOOP_INVENTED_NEXT_PHASE',
  'OWENLOOP_CREDENTIAL_ORIGIN',
  'OWENLOOP_CREDENTIAL_SLOT',
];
writeFileSync(
  spec.envFile,
  JSON.stringify(Object.fromEntries(envKeys.map((key) => [key, process.env[key] ?? null]))),
);
// Outlive the turn: a stub that exits on its own would make "the adapter tore it
// down" indistinguishable from "it was finished anyway".
setInterval(() => {}, 60_000);

const THREAD = ${JSON.stringify(STUB_THREAD)};
const TURN = ${JSON.stringify(STUB_TURN)};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = (o) => appendFileSync(spec.logFile, JSON.stringify(o) + '\\n');

let elicitsOutstanding = 2;

function handle(m) {
  if (m.method === undefined && m.id !== undefined) {
    // The client's REPLY to one of our server requests.
    log({ method: '#reply', params: { id: m.id, result: m.result ?? null, error: m.error ?? null } });
    if (spec.mode === 'elicit' && (m.id === 900 || m.id === 901)) {
      elicitsOutstanding -= 1;
      if (elicitsOutstanding === 0) {
        send({
          method: 'turn/completed',
          params: { threadId: THREAD, turn: { id: TURN, status: 'completed', error: null } },
        });
      }
    }
    return;
  }
  log({ method: m.method, params: m.params ?? null });
  switch (m.method) {
    case 'initialize':
      if (spec.mode === 'refuse-initialize') {
        send({ id: m.id, error: { code: -32000, message: 'handshake refused by stub' } });
      } else {
        send({ id: m.id, result: { userAgent: 'stub-app-server/0.146.0' } });
      }
      return;
    case 'thread/start':
      send({ id: m.id, result: { thread: { id: THREAD, sessionId: THREAD } } });
      return;
    case 'turn/start':
      // The ACK, exactly as recorded: the turn is created, not finished.
      send({ id: m.id, result: { turn: { id: TURN, status: 'inProgress', error: null } } });
      send({ method: 'turn/started', params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } } });
      if (spec.mode === 'mount-failure') {
        send({
          method: 'mcpServer/startupStatus/updated',
          params: { threadId: THREAD, name: 'owenloop', status: 'failed', error: 'stub refused the mount' },
        });
      }
      if (spec.mode === 'elicit') {
        // Shaped exactly as recorded from codex 0.146.0: an approval dressed as
        // an MCP elicitation, carrying the approval kind in \`_meta\`.
        send({
          method: 'mcpServer/elicitation/request',
          id: 900,
          params: {
            threadId: THREAD, turnId: TURN, serverName: 'owenloop', mode: 'form',
            _meta: { codex_approval_kind: 'mcp_tool_call', tool_description: 'submit' },
            message: 'Allow the owenloop MCP server to run tool "submit"?',
            requestedSchema: { type: 'object', properties: {} },
          },
        });
        send({
          method: 'mcpServer/elicitation/request',
          id: 901,
          params: {
            threadId: THREAD, turnId: TURN, serverName: 'somebody-else', mode: 'form',
            _meta: { codex_approval_kind: 'mcp_tool_call' },
            message: 'Allow somebody-else to run tool "rm"?',
            requestedSchema: { type: 'object', properties: {} },
          },
        });
      }
      return;
    case 'turn/interrupt':
      send({ id: m.id, result: {} });
      send({
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: m.params.turnId, status: 'interrupted', error: null } },
      });
      return;
    default:
      return;
  }
}

const dec = new StringDecoder('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += dec.write(chunk);
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
`;

interface Stub {
  dir: string;
  /** Every request the stub received, in arrival order. */
  received(): Array<{ method: string; params: Record<string, unknown> | null }>;
  /** The app-server's selected environment snapshot, once it has started. */
  envSnapshot(): Record<string, string | null>;
  /** The stub's own pid, once it has written it. */
  pid(): number | undefined;
  /** True while the stub process still exists. */
  alive(): boolean;
}

/** Install the stub as `OWENLOOP_CODEX_BIN` for the duration of one test. */
function useStub(t: { after(fn: () => void): void }, mode: string): Stub {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-codex-stub-'));
  const script = join(dir, 'stub-app-server.mjs');
  const pidFile = join(dir, 'pid');
  const logFile = join(dir, 'received.jsonl');
  const envFile = join(dir, 'env.json');
  writeFileSync(script, stubSource({ pidFile, logFile, envFile, mode }), { mode: 0o755 });
  writeFileSync(logFile, '');

  // `OWENLOOP_CODEX_BIN` is read by the adapter in THIS process before it
  // spawns anything, so the namespace filter never sees it. The stub's own
  // configuration is compiled into its source above and needs no variable.
  const previousBin = process.env['OWENLOOP_CODEX_BIN'];
  process.env['OWENLOOP_CODEX_BIN'] = script;

  const pid = (): number | undefined => {
    try {
      const raw = readFileSync(pidFile, 'utf8').trim();
      return raw === '' ? undefined : Number(raw);
    } catch {
      return undefined;
    }
  };

  t.after(() => {
    const p = pid();
    if (p !== undefined) {
      try {
        process.kill(-p, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (previousBin === undefined) delete process.env['OWENLOOP_CODEX_BIN'];
    else process.env['OWENLOOP_CODEX_BIN'] = previousBin;
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    pid,
    received: () =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> | null }),
    envSnapshot: () => JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string | null>,
    alive: () => {
      const p = pid();
      if (p === undefined) return false;
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

test('D4 the app-server spawn applies the same six-name filter as the mount', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  process.env['OWENLOOP_CACHE_DIR'] = '/tmp/app-server-cache';
  process.env['OWENLOOP_SHIFT_ID'] = 'cond-app-server';
  process.env['OWENLOOP_CREDENTIAL_COMMAND'] = '/bin/credential-helper';
  process.env['OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS'] = '2500';
  process.env['OWENLOOP_NO_KEYCHAIN'] = '1';
  process.env['OWENLOOP_SESSION'] = 'sess-app-server';
  process.env['OWENLOOP_TOKEN'] = 'tok-app-server';
  process.env['OWENLOOP_INVENTED_NEXT_PHASE'] = 'future-app-server';
  process.env['OWENLOOP_CREDENTIAL_ORIGIN'] = 'origin-app-server';
  process.env['OWENLOOP_CREDENTIAL_SLOT'] = 'slot-app-server';

  const stub = useStub(t, 'refuse-initialize');
  const err = await codexAdapter
    .start(startArgs(undefined, { cwd: stub.dir }), () => {})
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  assert.ok(err instanceof Error, 'the refusal makes the test wait until the stub recorded its env');

  assert.deepEqual(stub.envSnapshot(), {
    OWENLOOP_CACHE_DIR: '/tmp/app-server-cache',
    OWENLOOP_SHIFT_ID: 'cond-app-server',
    OWENLOOP_CREDENTIAL_COMMAND: '/bin/credential-helper',
    OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS: '2500',
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENLOOP_SESSION: 'sess-app-server',
    OWENLOOP_TOKEN: null,
    OWENLOOP_INVENTED_NEXT_PHASE: null,
    OWENLOOP_CREDENTIAL_ORIGIN: null,
    OWENLOOP_CREDENTIAL_SLOT: null,
  });
});

/** Poll until `cond` holds, or throw naming `what`. */
async function waitFor(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('D6 a MID-TURN stop interrupts the live turn, and start resolves through it', async (t) => {
  // REGRESSION GUARD (reviewer error 1). The turn id used to be recorded only
  // AFTER `runTurn` settled, so the one moment `stop` can be called — while the
  // turn is still running — was the one moment the id was `undefined`. `stop`
  // then skipped `turn/interrupt` entirely and killed the child, and the
  // in-flight `start` promise REJECTED on the process death instead of resolving
  // through interrupted -> turn_ended. This test fails on both counts without
  // the fix: no `turn/interrupt` on the wire, and a rejected `start`.
  const stub = useStub(t, 'hang-turn');

  const events: AgentEvent[] = [];
  const started = codexAdapter.start(
    startArgs(undefined, { cwd: stub.dir }),
    (e) => events.push(e),
  );

  // The turn is live once `turn/started` has been mapped to a progress line —
  // that notification is what carries the turn id.
  await waitFor(
    () => events.some((e) => e.kind === 'progress' && e.text.includes(`turn ${STUB_TURN} started`)),
    'the stub to report its turn started',
  );
  const startedEvent = events.find((e) => e.kind === 'started');
  assert.ok(startedEvent !== undefined && startedEvent.kind === 'started');
  const ref = startedEvent.ref;
  assert.equal(ref.token, STUB_THREAD);

  await codexAdapter.stop(ref);

  const interrupt = stub.received().find((r) => r.method === 'turn/interrupt');
  assert.ok(interrupt !== undefined, 'stop must send turn/interrupt while the turn is live');
  assert.deepEqual(
    interrupt.params,
    { threadId: STUB_THREAD, turnId: STUB_TURN },
    'turn/interrupt needs BOTH ids, and the turn id must be the LIVE one',
  );

  // The interrupted turn ended; `start` resolves rather than rejecting on the
  // child's death.
  const resolved = await started;
  assert.deepEqual(resolved, ref);
  assert.ok(
    events.some((e) => e.kind === 'turn_ended'),
    'an interrupted turn still ends the turn',
  );

  await waitFor(() => !stub.alive(), 'the stub to be reaped by stop');
  // Idempotent: a second stop on a token already torn down is a no-op.
  await codexAdapter.stop(ref);
});

test('D7 a handshake failure disposes the spawned child and reports the exit', async (t) => {
  // REGRESSION GUARD (reviewer error 2). `initialize` used to be awaited outside
  // any try/finally, so a refused or wedged handshake left a DETACHED child —
  // the leader of its own process group — running with nobody holding a handle
  // to it, and rejected with no `exited` event to explain the failure.
  const stub = useStub(t, 'refuse-initialize');

  const events: AgentEvent[] = [];
  const err = await codexAdapter
    .start(startArgs(undefined, { cwd: stub.dir }), (e) => events.push(e))
    .then(
      () => undefined,
      (e: unknown) => e,
    );

  assert.ok(err instanceof Error, 'a refused handshake must reject');
  assert.match(err.message, /handshake refused by stub/);

  const exits = events.filter((e) => e.kind === 'exited');
  assert.equal(exits.length, 1, 'exactly one exited event — reported once, not twice');
  assert.match(String(exits[0]?.error), /handshake refused by stub/);

  assert.ok(stub.pid() !== undefined, 'the stub really did spawn');
  await waitFor(() => !stub.alive(), 'the handshake failure to reap its child');
});

test('D8 an owenloop mount failure interrupts the turn and tears the child down', async (t) => {
  // REGRESSION GUARD (reviewer warning 5). The gate rejected on `status:failed`,
  // but nothing stopped the SERVER-side turn: with no `submit` tool the agent
  // cannot complete the order, so every token it spends afterwards is wasted.
  const stub = useStub(t, 'mount-failure');

  const events: AgentEvent[] = [];
  const err = await codexAdapter
    .start(startArgs(undefined, { cwd: stub.dir }), (e) => events.push(e))
    .then(
      () => undefined,
      (e: unknown) => e,
    );

  assert.ok(err instanceof Error, 'a failed owenloop mount must reject the turn');
  assert.match(err.message, /owenloop MCP server failed to start: stub refused the mount/);
  assert.ok(
    events.some((e) => e.kind === 'exited' && /failed to start/.test(String(e.error))),
    'the mount failure is reported as an exit',
  );

  const interrupt = stub.received().find((r) => r.method === 'turn/interrupt');
  assert.ok(interrupt !== undefined, 'a doomed turn must be interrupted, not left burning tokens');
  assert.equal(interrupt.params?.['turnId'], STUB_TURN);
  await waitFor(() => !stub.alive(), 'the doomed turn to reap its child');

  // The session is gone, so a later stop is the documented no-op.
  await codexAdapter.stop({ harness: 'codex', token: STUB_THREAD });
});

test('D9 owenloop tool-call approvals are granted; every other elicitation is refused', async (t) => {
  // MEASURED, and the reason a live order could never finish: `approvalPolicy:
  // 'never'` does NOT cover MCP tool calls in codex 0.146.0. Every call to
  // `get_order`/`submit` arrives first as `mcpServer/elicitation/request` with
  // `_meta.codex_approval_kind:'mcp_tool_call'`, and an error reply is recorded
  // by codex as `user rejected MCP tool call`. Refusing therefore does not fail
  // safe — it removes `submit` and the order dies owing. The grant is scoped to
  // the owenloop mount, which this adapter wrote into `thread/start` itself.
  const stub = useStub(t, 'elicit');

  const events: AgentEvent[] = [];
  const ref = await codexAdapter.start(startArgs(undefined, { cwd: stub.dir }), (e) =>
    events.push(e),
  );
  await codexAdapter.stop(ref);

  const replies = stub.received().filter((r) => r.method === '#reply');
  const owen = replies.find((r) => r.params?.['id'] === 900);
  const other = replies.find((r) => r.params?.['id'] === 901);

  assert.ok(owen !== undefined, 'the owenloop elicitation must be answered, never left hanging');
  assert.deepEqual(owen.params?.['result'], { action: 'accept', content: {} });
  assert.equal(owen.params?.['error'], null);

  assert.ok(other !== undefined, 'a foreign elicitation must still be answered, not left hanging');
  assert.equal(other.params?.['result'], null);
  assert.ok(other.params?.['error'] !== null, 'a foreign elicitation must be refused');
  assert.ok(
    events.some((e) => e.kind === 'needs_input' && /somebody-else/.test(e.question)),
    'a foreign elicitation is surfaced to the operator as needs_input',
  );
  assert.equal(
    events.some((e) => e.kind === 'needs_input' && /owenloop MCP server/.test(e.question)),
    false,
    'granting our own tool call must not raise a needs_input the operator has to answer',
  );
});

test('D4 isResumeMiss ignores non-JsonRpc errors and wrong codes', () => {
  assert.equal(isResumeMiss(new Error('no rollout found')), false);
  assert.equal(isResumeMiss(new JsonRpcError(-32000, 'no rollout found')), false);
  assert.equal(isResumeMiss(new JsonRpcError(-32600, 'something else entirely')), false);
  assert.equal(isResumeMiss(new JsonRpcError(-32600, 'no rollout found for thread id x')), true);
  assert.equal(isResumeMiss(undefined), false);
});
