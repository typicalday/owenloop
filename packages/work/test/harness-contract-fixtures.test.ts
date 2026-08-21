/**
 * PHASE 6, ITEM 1 — the contract-fixture replay.
 *
 * WHAT THIS IS FOR. Both adapters map a VENDOR-DEFINED wire format onto this
 * project's `AgentEvent` contract. When a vendor ships a new CLI the mapping can
 * silently stop matching reality, and today the first thing that notices is a
 * production order. A fixture recorded from the real vendor, replayed through
 * the real adapter, moves that discovery to `npm test`.
 *
 * HOW IT DIFFERS FROM WHAT ALREADY EXISTED. `test/harness-codex.test.ts`
 * sections B replay the same recordings, but through the PURE helpers
 * (`mapNotification`, `isResumeMiss`, `readOwenloopMountFailure`) — a frame at a
 * time, with no adapter and no process. The gap that leaves is the whole
 * transport: correlation, the handshake, the turn gate, the `started` event, and
 * the `HarnessSessionRef` the caller persists. This file closes it by standing a
 * REPLAY SERVER on the recording and driving `codexAdapter.start()` and
 * `codexAdapter.deliver()` through it end to end.
 *
 * THE REPLAY SERVER, AND WHY IT MATCHES BY METHOD. The stub indexes the
 * recording into one BLOCK per outbound request — the inbound frames that
 * followed it before the next outbound request — and answers a live request with
 * the next unused block for that method. It does NOT replay the file as a fixed
 * timeline, because it cannot: the recording is a single app-server connection,
 * while the adapter uses TWO (`deliver` always spawns a fresh app-server, on
 * purpose — see its comment about the turn gate). A block index survives being
 * consumed by two processes; a cursor does not. When a method's blocks run out,
 * the last one repeats — that is what lets the second connection's `initialize`
 * be answered by the only `initialize` ever recorded.
 *
 * Recorded client REPLIES to server requests are skipped when the block is
 * emitted: the live adapter sends its own, and those are what the assertions are
 * about.
 *
 * TWO HALVES, TWO SEAMS. Sections 1–3 cover codex, where the risk is the
 * JSON-RPC transport and the replay point is therefore a stub SERVER. Section 4
 * covers Claude, where the vendor SDK owns the process and hands over
 * already-parsed messages, so the only thing this project can get wrong is the
 * mapping — and the replay point is `consumeTurn` driven from a recorded
 * message stream. Section 4's own header explains that in full.
 *
 * WHAT AN UPGRADE LOOKS LIKE FROM HERE. Re-record, `git diff` the fixture, and
 * this test tells you whether the mapping still holds. The full six-step
 * workflow is written down in `docs/agent-runner.md`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { codexAdapter } from '../src/harness/codex.ts';
import { consumeTurn } from '../src/harness/claude.ts';
import { normalizeStepPermissions } from '../src/harness/permissions.ts';
import type { AgentEvent, DeliverArgs, StartArgs } from '../src/harness/contract.ts';

const FIXTURE_DIR = fileURLToPath(new URL('fixtures/', import.meta.url));

/** The thread id every frame in `codex-app-server-session.jsonl` carries. */
const FIXTURE_THREAD = '11111111-1111-4111-8111-111111111111';

// ---------------------------------------------------------------------------
// The replay server
// ---------------------------------------------------------------------------

/**
 * The stub source. `fixture` is BAKED IN rather than passed through the
 * environment: `openClient` now filters `OWENLOOP_*` down to the admitted set
 * (Phase 6 items 3+5), so a stub that read its own configuration from an
 * `OWENLOOP_`-prefixed variable would either not work or would force a test-only
 * key into a production allowlist. Neither is acceptable.
 */
const replaySource = (fixture: string, pidFile: string, usedFile: string): string => `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Every replay process records its pid so the test can guarantee teardown even
// when the adapter had no reason to dispose the client (a rejected resume, a
// test that failed early). A stub left running holds the runner's event loop
// open and turns one failure into a hung suite.
appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');

const entries = readFileSync(${JSON.stringify(fixture)}, 'utf8')
  .split('\\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

// One block per recorded outbound REQUEST: the inbound frames that followed it.
const blocks = new Map();
let current = null;
for (const e of entries) {
  if (e.dir === 'out' && typeof e.frame.method === 'string') {
    current = { recordedId: e.frame.id, frames: [] };
    const list = blocks.get(e.frame.method) ?? [];
    list.push(current);
    blocks.set(e.frame.method, list);
  } else if (e.dir === 'in' && current !== null) {
    current.frames.push(e.frame);
  }
}

// Which block each method is up to. ON DISK, not in memory, because the two
// legs of the recording are consumed by two different replay PROCESSES: the
// adapter's \`deliver\` always spawns a fresh app-server. An in-memory counter
// would restart at zero on that second process and hand the resumed turn the
// COLD turn's frames back.
function nextBlock(method) {
  const list = blocks.get(method);
  if (list === undefined || list.length === 0) return undefined;
  let used = {};
  try {
    used = JSON.parse(readFileSync(${JSON.stringify(usedFile)}, 'utf8'));
  } catch {
    used = {};
  }
  const i = used[method] ?? 0;
  used[method] = i + 1;
  writeFileSync(${JSON.stringify(usedFile)}, JSON.stringify(used));
  // Past the end, the LAST block repeats — that is what answers the second
  // connection's \`initialize\`, of which only one was ever recorded.
  return list[Math.min(i, list.length - 1)];
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

function handle(m) {
  // A reply to one of OUR server requests carries no method. The recording
  // already holds what followed; nothing to do here.
  if (typeof m.method !== 'string') return;
  const block = nextBlock(m.method);
  if (block === undefined) {
    if (m.id !== undefined) {
      send({ id: m.id, error: { code: -32601, message: 'nothing recorded for ' + m.method } });
    }
    return;
  }
  for (const frame of block.frames) {
    const out = { ...frame };
    // Re-address the recorded RESPONSE to the id this live client actually used.
    if (typeof out.method !== 'string' && out.id !== undefined && out.id === block.recordedId) {
      out.id = m.id;
    }
    send(out);
  }
}

// Outlive the turn: an app-server that exits on its own would make an adapter
// bug indistinguishable from a finished conversation.
setInterval(() => {}, 60_000);

const decoder = new StringDecoder('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += decoder.write(chunk);
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line !== '') handle(JSON.parse(line));
  }
});
`;

interface Replay {
  /** A real directory, because `deliver` refuses a cwd that does not exist. */
  cwd: string;
}

function useReplay(t: { after(fn: () => void): void }, fixture: string): Replay {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-replay-'));
  const script = join(dir, 'replay-app-server.mjs');
  const pidFile = join(dir, 'pids');
  const usedFile = join(dir, 'used.json');
  writeFileSync(pidFile, '');
  writeFileSync(usedFile, '{}');
  writeFileSync(script, replaySource(join(FIXTURE_DIR, fixture), pidFile, usedFile), { mode: 0o755 });

  const previous = process.env['OWENLOOP_CODEX_BIN'];
  process.env['OWENLOOP_CODEX_BIN'] = script;
  t.after(() => {
    for (const line of readFileSync(pidFile, 'utf8').split('\n')) {
      const pid = Number(line.trim());
      if (!Number.isFinite(pid) || pid === 0) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone — the adapter disposed it, which is the good case */
      }
    }
    if (previous === undefined) delete process.env['OWENLOOP_CODEX_BIN'];
    else process.env['OWENLOOP_CODEX_BIN'] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { cwd: dir };
}

function startArgs(cwd: string): StartArgs {
  return {
    brief: 'do the thing',
    cwd,
    owenloopMcp: { command: process.execPath, args: ['/tmp/fixture-mcp/owenloop-server.mjs'] },
    permissions: normalizeStepPermissions(undefined, undefined),
  };
}

function deliverArgs(cwd: string): DeliverArgs {
  const { brief: _brief, ...rest } = startArgs(cwd);
  return rest;
}

/** Every `progress` line, joined — the adapter's rendering of the recording. */
const progress = (events: readonly AgentEvent[]): string =>
  events.filter((e) => e.kind === 'progress').map((e) => (e.kind === 'progress' ? e.text : '')).join('\n');

// ---------------------------------------------------------------------------
// 1. The cold-start leg
// ---------------------------------------------------------------------------

test('the recorded session replays through the REAL adapter and yields the recorded thread id', async (t) => {
  const replay = useReplay(t, 'codex-app-server-session.jsonl');
  const events: AgentEvent[] = [];

  const ref = await codexAdapter.start(startArgs(replay.cwd), (e) => events.push(e));

  // The whole point of the transport half: the token the CALLER persists is the
  // thread id the server actually issued, not something the adapter synthesized.
  assert.deepEqual(ref, { harness: 'codex', token: FIXTURE_THREAD });

  // Contract order: exactly one `started`, and it lands BEFORE the turn closes —
  // that ordering is what leaves a resumable record behind after a mid-turn
  // crash. It is deliberately not asserted to be the very first event: the
  // handshake emits a `progress` line naming the server's userAgent before any
  // thread exists, and that line is the only place the vendor version is
  // observable.
  const startedAt = events.findIndex((e) => e.kind === 'started');
  const endedAt = events.findIndex((e) => e.kind === 'turn_ended');
  assert.ok(startedAt >= 0 && startedAt < endedAt, 'the caller persists the token before turn end');
  assert.equal(events.filter((e) => e.kind === 'started').length, 1);
  assert.equal(events.filter((e) => e.kind === 'turn_ended').length, 1);
  assert.equal(events.at(-1)?.kind, 'turn_ended');
  assert.equal(events.filter((e) => e.kind === 'exited').length, 0, 'the recording is a CLEAN session');

  const text = progress(events);
  assert.match(text, /turn .* started/);
  assert.match(text, /turn .* completed/);
  // The handshake line is the ONLY place the server's own version is observable,
  // and a future warn-on-mismatch check is meant to read it. If a re-recording
  // drops it, that check loses its input silently — so pin it here.
  assert.match(text, /^app-server ready: userAgent=/m);
  // The mount really came up in the recording, cancelled counter-example and all.
  assert.match(text, /MCP server 'owenloop' status ready/);
  // Both owenloop tool calls survive the transport as progress, so an operator
  // reading the runner log can see the agent actually reached the hub.
  assert.equal(text.split('\n').filter((l) => /^item\/completed mcpToolCall /.test(l)).length, 2);

  await codexAdapter.stop(ref);
});

// ---------------------------------------------------------------------------
// 2. The resume leg
// ---------------------------------------------------------------------------

test('the recorded RESUME leg replays through deliver, and never re-emits started', async (t) => {
  const replay = useReplay(t, 'codex-app-server-session.jsonl');
  const first: AgentEvent[] = [];
  const ref = await codexAdapter.start(startArgs(replay.cwd), (e) => first.push(e));

  const second: AgentEvent[] = [];
  await codexAdapter.deliver(ref, 'now do the next thing', deliverArgs(replay.cwd), (e) =>
    second.push(e),
  );

  // The contract forbids a second `started` on a resume: the caller has already
  // persisted the token, and a second one would look like a new session.
  assert.equal(second.filter((e) => e.kind === 'started').length, 0);
  assert.equal(second.filter((e) => e.kind === 'turn_ended').length, 1);
  assert.equal(second.at(-1)?.kind, 'turn_ended');
  const text = progress(second);
  assert.match(text, /turn .* completed/);
  // The agent's STREAMED answer — `item/agentMessage/delta` frames, recorded on
  // the resume leg only — survives the whole transport, not just
  // `mapNotification`. This is the assertion the B-series cannot make.
  assert.match(text, /^RES$/m);
  assert.match(text, /^UM$/m);
  assert.match(text, /^ED$/m);
  assert.deepEqual(
    second.filter((event) => event.kind === 'assistant_response').map((event) => event.text),
    ['RESUMED'],
    'the real adapter emits the completed final response, not the streamed deltas',
  );

  await codexAdapter.stop(ref);
});

// ---------------------------------------------------------------------------
// 3. The recorded resume MISS
// ---------------------------------------------------------------------------

test('the recorded resume of a forgotten thread surfaces as ResumeUnavailableError', async (t) => {
  // The other recording: a `thread/resume` the server answered with -32600 "no
  // rollout found". Through the pure helper this is one boolean; through the
  // adapter it must come out as the ONE error type the caller's cold-replay
  // fallback keys on, and it must not be confused with an ordinary failure.
  const replay = useReplay(t, 'codex-app-server-resume-unknown.jsonl');
  const events: AgentEvent[] = [];

  await assert.rejects(
    codexAdapter.deliver(
      { harness: 'codex', token: FIXTURE_THREAD },
      'anything',
      deliverArgs(replay.cwd),
      (e) => events.push(e),
    ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, 'RESUME_UNAVAILABLE');
      assert.match((err as Error).message, new RegExp(FIXTURE_THREAD));
      return true;
    },
  );
  assert.equal(events.filter((e) => e.kind === 'started').length, 0);
});

// ---------------------------------------------------------------------------
// 4. The Claude half — the SDK message stream
// ---------------------------------------------------------------------------
//
// A DIFFERENT SEAM, FOR A DIFFERENT REASON. The codex sections above stand a
// replay SERVER on a recorded JSON-RPC transcript, because that adapter's risk
// lives in the transport. The Claude adapter has no transport of its own: the
// vendor SDK owns the child process and hands `query()` an async iterable of
// already-parsed messages. Everything this project can get wrong is in
// `consumeTurn`, the function that maps those messages onto `AgentEvent`s — so
// that is the replay point. It is typed on `AsyncIterable<SDKMessage>` rather
// than on the SDK's `Query` for exactly this reason; a live `Query` still
// satisfies the narrower type, so no call site changed.
//
// THE RECORDING IS REAL. `test/fixtures/claude-sdk-stream.jsonl` is one actual
// turn, captured by `test/tools/record-claude-stream.mjs` and scrubbed by it:
// UUIDs mapped to stable placeholders, paths replaced, and the operator's
// installed inventory (MCP servers, slash commands, subagents, skills, plugins)
// replaced with shape-preserving synthetic values. The four fields the mapping
// actually READS and that are not private — `claude_code_version`, `model`,
// `apiKeySource`, `permissionMode` — are kept verbatim, because they are the
// entire reason to record a real stream instead of hand-writing one.

const CLAUDE_FIXTURE = join(FIXTURE_DIR, 'claude-sdk-stream.jsonl');

/** The recorded messages, in order. */
const claudeMessages = (): SDKMessage[] =>
  readFileSync(CLAUDE_FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { message: SDKMessage }).message);

async function* asStream(messages: readonly SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const m of messages) yield m;
}

/** The session id every message in the recording carries. */
const CLAUDE_SESSION = '03030303-0303-4030-8030-030303030303';

test('the recorded SDK stream maps the init line, the assistant turn, and turn_ended', async () => {
  const events: AgentEvent[] = [];
  const inits: string[] = [];
  const outcome = await consumeTurn(
    asStream(claudeMessages()),
    (e) => events.push(e),
    (id) => inits.push(id),
  );

  // `start` builds the `HarnessSessionRef` the caller PERSISTS out of this
  // callback, and calls it exactly once. Twice would overwrite a live ref;
  // never would make `start` throw "no session id".
  assert.deepEqual(inits, [CLAUDE_SESSION]);
  assert.deepEqual(outcome, { sessionId: CLAUDE_SESSION, sawResult: true });
  assert.deepEqual(
    events.map((e) => e.kind),
    ['progress', 'progress', 'assistant_response', 'turn_ended'],
  );
  assert.ok(
    claudeMessages().some((m) => m.type === 'assistant'),
    'a successful turn always carries the model turn itself',
  );

  // The init line is the ONLY place the vendor's version and credential source
  // are observable, and both are load-bearing: the version drives the upgrade
  // workflow in `docs/agent-runner.md`, and `apiKeySource` is how an operator
  // tells a subscription-OAuth run from one that is billing an API key.
  const initText = events[0]?.kind === 'progress' ? events[0].text : '';
  assert.match(initText, /cliVersion=2\.1\.220/);
  assert.match(initText, /apiKeySource=none/);
  assert.match(initText, /model=claude-opus-5/);
  assert.match(initText, /permissionMode=bypassPermissions/);
  const initEvent = events[0];
  assert.equal(
    initEvent?.kind === 'progress' ? initEvent.model : undefined,
    'claude-opus-5',
    'the init progress event carries the provider-selected model structurally',
  );
  // `mcp_servers` is read field-by-field, so a rename would surface as
  // `undefined=undefined` here rather than as a silent blank in production.
  assert.match(initText, /mcp=\[owenloop=pending\]/);
  assert.match(events[1]?.kind === 'progress' ? events[1].text : '', /^assistant: /);
  const response = events.find((event) => event.kind === 'assistant_response');
  assert.ok(response !== undefined && response.kind === 'assistant_response');
  assert.ok(response.text.length > 0, 'the final top-level SDK response is retained separately from progress');
});

test('message types outside the mapped set are ignored, not thrown on', async () => {
  const messages = claudeMessages();
  const unmapped = messages.filter(
    (m) =>
      m.type !== 'result' &&
      m.type !== 'assistant' &&
      m.type !== 'user' &&
      !(m.type === 'system' && m.subtype === 'init'),
  );
  // Guard the guard: if a re-recording ever contained ONLY init and result this
  // test would pass while testing nothing.
  assert.ok(unmapped.length >= 3, `recording carries ${unmapped.length} unmapped messages`);

  const events: AgentEvent[] = [];
  await consumeTurn(asStream(unmapped), (e) => events.push(e));
  // The vendor adds message types between releases (`rate_limit_event` and the
  // `system/hook_*` pair in this very recording are recent). A mapping that
  // threw on an unrecognized type would turn a routine CLI upgrade into a
  // failed order, so silence is the required behavior, not an oversight.
  assert.deepEqual(events, []);
});

test('tool calls log their name and id, never their secret-bearing inputs', async () => {
  // DERIVED, NOT RECORDED. The recording proves the adapter handles a real SDK
  // stream, but carries no tool call or tool result. These messages retain the
  // recording's actual assistant envelope while adding the security-critical
  // content blocks the recording cannot provide.
  const messages = claudeMessages();
  const assistant = messages.find((m): m is SDKAssistantMessage => m.type === 'assistant');
  assert.ok(assistant, 'recording carries an assistant message to derive from');
  const resultAt = messages.findIndex((m) => m.type === 'result');
  assert.ok(resultAt >= 0, 'recording carries a result message after the assistant turn');

  const toolAssistant: SDKAssistantMessage = {
    ...assistant,
    message: {
      ...assistant.message,
      content: [
        { type: 'text', text: 'running the check', citations: null },
        {
          type: 'tool_use',
          id: 'toolu_fixture_1',
          name: 'Bash',
          input: { command: 'echo SENTINEL_MUST_NOT_APPEAR' },
        },
      ],
    },
  };
  const toolResult: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture_1', content: 'ok' }],
    },
    parent_tool_use_id: null,
  };
  messages.splice(resultAt, 0, toolAssistant, toolResult);

  const events: AgentEvent[] = [];
  await consumeTurn(asStream(messages), (e) => events.push(e));

  const text = progress(events);
  assert.match(text, /tool_use Bash toolu_fixture_1/);
  assert.match(text, /tool_result toolu_fixture_1/);
  assert.equal(
    text.includes('SENTINEL_MUST_NOT_APPEAR'),
    false,
    'a secret-bearing tool argument reached the worker log',
  );
  assert.equal(text.includes('command'), false, 'a tool input field reached the worker log');
});

test('assistant progress text is capped and labels subagent output', async () => {
  const assistant = claudeMessages().find((m): m is SDKAssistantMessage => m.type === 'assistant');
  assert.ok(assistant, 'recording carries an assistant message to derive from');
  const longAssistant: SDKAssistantMessage = {
    ...assistant,
    parent_tool_use_id: 'toolu_parent_1',
    message: {
      ...assistant.message,
      content: [{ type: 'text', text: 'x'.repeat(5_000), citations: null }],
    },
  };
  const events: AgentEvent[] = [];
  await consumeTurn(asStream([longAssistant]), (e) => events.push(e));

  const text = events[0]?.kind === 'progress' ? events[0].text : '';
  assert.match(text, /^\[subagent toolu_parent_1\] assistant: /);
  assert.ok(text.length < 2_100, `expected capped progress text, got ${text.length} characters`);
  assert.ok(text.endsWith('…'));
});

test('assistant error preserves its display text and carries bounded failure metadata', async () => {
  const assistant = claudeMessages().find((m): m is SDKAssistantMessage => m.type === 'assistant');
  assert.ok(assistant, 'recording carries an assistant message to derive from');
  const failedAssistant: SDKAssistantMessage = { ...assistant, error: 'model_not_found' };
  const events: AgentEvent[] = [];
  await consumeTurn(asStream([failedAssistant]), (e) => events.push(e));

  assert.deepEqual(events[0], {
    kind: 'progress',
    text: 'assistant error: model_not_found',
    failure: 'model_not_found',
  });
});

test('a stream that ends before the result reports sawResult false and emits no turn_ended', async () => {
  // What an aborted turn looks like from here — `stop()` aborts the controller
  // and the iterable ends. `start` reads `sawResult` to tell the caller whether
  // the turn ended or the stream did, and the two produce different messages.
  const truncated = claudeMessages().filter((m) => m.type !== 'result');
  const events: AgentEvent[] = [];
  const outcome = await consumeTurn(asStream(truncated), (e) => events.push(e));

  assert.deepEqual(outcome, { sessionId: CLAUDE_SESSION, sawResult: false });
  assert.equal(events.filter((e) => e.kind === 'turn_ended').length, 0);
});

test('a stream with no init yields no session id, which is what makes start refuse', async () => {
  const noInit = claudeMessages().filter((m) => !(m.type === 'system' && m.subtype === 'init'));
  const inits: string[] = [];
  const outcome = await consumeTurn(asStream(noInit), () => {}, (id) => inits.push(id));

  // `start` turns this into `harness start failed`, deliberately, rather than
  // inventing a token: a fabricated token would be persisted as resumable and
  // fail much later, somewhere far away from the cause.
  assert.deepEqual(inits, []);
  assert.equal(outcome.sessionId, undefined);
  assert.equal(outcome.sawResult, true);
});

test('a failed result emits exited BEFORE turn_ended, carrying the errors', async () => {
  // DERIVED, NOT RECORDED, and the only fixture in this file that is. A failing
  // turn cannot be provoked on demand from a healthy account, and recording one
  // would mean waiting for a real outage. The `result` message is taken from the
  // real recording and its outcome fields are replaced, so every OTHER field is
  // still whatever the vendor actually sends.
  const messages = claudeMessages().map((m) =>
    m.type === 'result'
      ? ({
          ...m,
          subtype: 'error_during_execution',
          is_error: true,
          errors: ['upstream connection reset', 'giving up'],
        } as unknown as SDKMessage)
      : m,
  );

  const events: AgentEvent[] = [];
  await consumeTurn(asStream(messages), (e) => events.push(e));

  // Order matters to the caller: `src/agent/loop.ts` reads the event stream in
  // sequence, so the cause must arrive before the turn closes.
  assert.deepEqual(
    events.map((e) => e.kind),
    ['progress', 'progress', 'assistant_response', 'exited', 'turn_ended'],
  );
  const exited = events.find((e) => e.kind === 'exited');
  assert.equal(exited?.kind === 'exited' ? exited.exitCode : 'wrong kind', null);
  assert.equal(
    exited?.kind === 'exited' ? exited.error : undefined,
    'upstream connection reset; giving up',
  );
});
