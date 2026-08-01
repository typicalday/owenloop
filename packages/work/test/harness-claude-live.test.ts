/**
 * LIVE smoke for the Claude Code adapter — start, resume, stop, and the two
 * resume-failure paths, against the operator's REAL subscription login.
 *
 * SKIPPED BY DEFAULT. It spends real subscription quota and needs a logged-in
 * CLI, so it is gated on `OWENWORK_LIVE_TESTS=1` via node:test's own `skip`
 * option — a default run REPORTS these as skipped rather than passing
 * vacuously, and `.dev/checks.sh` never turns the gate on. Run it by hand:
 *
 *     OWENWORK_LIVE_TESTS=1 node --test --test-reporter=spec test/harness-claude-live.test.ts
 *
 * WHAT MAKES IT A REAL SMOKE. The MCP mount handed to the adapter is the actual
 * production argv — `bin/owenloop.mjs work hold --order <wf>/<run> --origin <hub>
 * --mcp` — pointed at a throwaway `node:http` hub, not a bespoke stub. So a pass
 * means the whole chain worked: the SDK launched the CLI on subscription auth,
 * the CLI connected the work-holder over stdio, the agent called `get_order` and
 * `submit`, and the hub recorded the receipt.
 *
 * AMBIENT STATE IS MATERIALIZED HERE, NOT ASSUMED. The mounted holder child
 * inherits the environment this adapter builds from `process.env`, so the test
 * sets `OWENWORK_TOKEN` / `XDG_CONFIG_HOME` (a temp dir of its own) on
 * `process.env` for the duration and restores them afterwards. Nothing depends
 * on the runner's own settings file or token.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeAdapter } from '../src/harness/claude.ts';
import { isResumeUnavailable } from '../src/harness/contract.ts';
import type { AgentEvent, DeliverArgs, HarnessSessionRef, StartArgs } from '../src/harness/contract.ts';
import { startMockHub, until, type HubReq } from './helpers/mcp-stdio-client.ts';
import {
  assertRevisionLanded,
  FIRST_URL,
  liveRejectionDelta,
  LIVE_BRIEF,
  submits,
  submittedUrl,
} from './helpers/live-rejection.ts';

const LIVE = process.env['OWENWORK_LIVE_TESTS'] === '1';
const SKIP = LIVE ? false : 'set OWENWORK_LIVE_TESTS=1 to run (spends real subscription quota)';

const BIN = join(import.meta.dirname, '..', '..', '..', 'bin', 'owenloop.mjs');
const TOKEN = 'tok-live-smoke';

const ORDER_PACKET = {
  run: 'run1',
  workflow: 'wf1',
  step: 'builder',
  key: 'k',
  inputs: [],
  outputs: ['pr'],
  prompt: 'smoke',
  consumes: {},
  owes: [],
};

function hubScript(verb: string): unknown {
  switch (verb) {
    case 'get_order':
      return { text: 'here', workflow: 'wf1', run: 'run1', order: ORDER_PACKET, lease: { claimed: true } };
    case 'heartbeat':
      return { text: 'hb' };
    case 'release':
      return { text: 'released', released: true };
    case 'submit':
      return { text: 'ok', outcome: 'green', closed: false };
    default:
      return { text: '' };
  }
}

/**
 * PHASE 4 — the live rejection drill's hub. The FIRST submit is rejected and the
 * hub says so in its reply; every later submit is accepted. That is what makes
 * the drill a real rejection round trip rather than a scripted re-prompt.
 */
function rejectingHubScript(): (verb: string) => unknown {
  let submits = 0;
  return (verb: string): unknown => {
    if (verb !== 'submit') return hubScript(verb);
    submits += 1;
    return submits === 1
      ? { text: 'rejected: see the reviewer reasons', outcome: 'reject', closed: false }
      : { text: 'ok', outcome: 'green', closed: false };
  };
}

const BRIEF =
  'Call the `get_order` tool. Then call the `submit` tool with path "pr", ' +
  'value {"url":"https://example.invalid/pr/1"}, and done true. ' +
  'Then reply with the single word done. Do not do anything else.';

/** Everything one live scenario needs, torn down by its own `finally`. */
interface Rig {
  cwd: string;
  configDir: string;
  origin: string;
  reqs: HubReq[];
  close: () => Promise<void>;
  events: AgentEvent[];
  onEvent: (e: AgentEvent) => void;
  startArgs: (brief: string) => StartArgs;
  /** PHASE 4 — the `DeliverArgs` half of the same fixture (`StartArgs` minus
   *  `brief`). `deliver` now takes the full args, `permissions` included. */
  deliverArgs: (over?: Partial<DeliverArgs>) => DeliverArgs;
}

async function rig(script: (verb: string) => unknown = hubScript): Promise<Rig> {
  const cwd = mkdtempSync(join(tmpdir(), 'owenwork-claude-live-cwd-'));
  const configDir = mkdtempSync(join(tmpdir(), 'owenwork-claude-live-cfg-'));
  const { origin, reqs, server } = await startMockHub(script);

  // The holder child inherits the environment the adapter builds from
  // process.env, so these must be on process.env — set here, restored on close.
  const saved = {
    OWENWORK_TOKEN: process.env['OWENWORK_TOKEN'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
    OWENWORK_SESSION: process.env['OWENWORK_SESSION'],
  };
  process.env['OWENWORK_TOKEN'] = TOKEN;
  process.env['XDG_CONFIG_HOME'] = configDir;
  process.env['OWENWORK_SESSION'] = '';

  const events: AgentEvent[] = [];
  const startArgs = (brief: string): StartArgs => ({
    brief,
    cwd,
    owenworkMcp: {
      command: process.execPath,
      args: [BIN, 'work', 'hold', '--order', 'wf1/run1', '--origin', origin, '--mcp'],
    },
    permissions: {
      // Headless: nothing can answer a permission prompt, so the smoke runs
      // the same mode a real headless step will.
      permissionMode: 'bypassPermissions',
      maxTurns: 12,
      extensions: {},
    },
  });
  return {
    cwd,
    configDir,
    origin,
    reqs,
    events,
    onEvent: (e) => events.push(e),
    startArgs,
    deliverArgs: (over: Partial<DeliverArgs> = {}): DeliverArgs => {
      const { brief: _brief, ...rest } = startArgs('');
      return { ...rest, ...over };
    },
    close: async () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(cwd, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

const progress = (events: AgentEvent[]): string =>
  events.filter((e) => e.kind === 'progress').map((e) => e.text).join('\n');

test(
  'start → the agent reaches its order over the real mount, submits, and the turn ends on subscription auth',
  { skip: SKIP, timeout: 300_000 },
  async () => {
    const r = await rig();
    let ref: HarnessSessionRef | undefined;
    try {
      ref = await claudeAdapter.start(r.startArgs(BRIEF), r.onEvent);

      // The token the caller will persist.
      assert.equal(ref.harness, 'claude-code');
      assert.ok(ref.token.length > 0, 'a non-empty provider session token');

      // `started` must have been emitted BEFORE the resolve — that ordering is
      // what leaves a resumable record behind after a mid-turn crash.
      const started = r.events.filter((e) => e.kind === 'started');
      assert.equal(started.length, 1, 'exactly one started event');
      assert.deepEqual(started[0], { kind: 'started', ref });
      assert.ok(
        r.events.indexOf(started[0]!) < r.events.findIndex((e) => e.kind === 'turn_ended'),
        'started precedes turn_ended',
      );
      assert.ok(r.events.some((e) => e.kind === 'turn_ended'), 'the turn ended');

      const text = progress(r.events);

      // AUTH: the run must be on subscription OAuth, not an API key. An
      // inherited ANTHROPIC_API_KEY would show up here as user/project/org and
      // would mean the strip failed and API credits were billed.
      const src = /apiKeySource=(\S+)/.exec(text)?.[1];
      assert.ok(src !== undefined, `no apiKeySource in progress output:\n${text}`);
      assert.ok(
        !['user', 'project', 'org'].includes(src),
        `expected subscription auth, but apiKeySource=${src} means an API key was in play`,
      );

      // The work-holder actually connected.
      assert.match(text, /mcp=\[[^\]]*owenwork=connected/, `owenwork mount not connected:\n${text}`);

      // And the whole chain closed the loop: the agent's submit hit the hub.
      await until(() => r.reqs.some((q) => q.verb === 'submit'), 'a submit on the wire', 20_000);
      const submit = r.reqs.find((q) => q.verb === 'submit')!;
      assert.equal(submit.auth, `Bearer ${TOKEN}`, 'the holder authenticated with the injected token');
      assert.equal((submit.body as Record<string, unknown>)['path'], 'pr');
    } finally {
      if (ref !== undefined) await claudeAdapter.stop(ref);
      await r.close();
    }
  },
);

test(
  'deliver resumes the SAME session without re-emitting started, and stop is idempotent',
  { skip: SKIP, timeout: 300_000 },
  async () => {
    const r = await rig();
    let ref: HarnessSessionRef | undefined;
    try {
      ref = await claudeAdapter.start(r.startArgs('Reply with exactly the word: ready'), r.onEvent);
      const afterStart = r.events.length;

      await claudeAdapter.deliver(
        ref,
        'Reply with exactly the word: resumed',
        r.deliverArgs(),
        r.onEvent,
      );

      const resumeEvents = r.events.slice(afterStart);
      assert.equal(
        resumeEvents.filter((e) => e.kind === 'started').length,
        0,
        'a resume must NEVER re-emit started',
      );
      assert.ok(resumeEvents.some((e) => e.kind === 'turn_ended'), 'the resumed turn ended');

      // Same session, not a fork: the resumed turn reported the original id.
      assert.match(
        progress(resumeEvents),
        new RegExp(`session ${ref.token}\\b`),
        `the resumed turn ran under a different session id:\n${progress(resumeEvents)}`,
      );

      // Idempotence: the second stop must resolve, not throw.
      await claudeAdapter.stop(ref);
      await claudeAdapter.stop(ref);
    } finally {
      if (ref !== undefined) await claudeAdapter.stop(ref);
      await r.close();
    }
  },
);

test(
  'deliver surfaces ResumeUnavailable for an unknown token and for a vanished cwd',
  { skip: SKIP, timeout: 120_000 },
  async () => {
    const r = await rig();
    try {

      // (1) A syntactically valid token the provider has never seen.
      const unknown: HarnessSessionRef = { harness: 'claude-code', token: randomUUID() };
      await assert.rejects(
        () => claudeAdapter.deliver(unknown, 'hello', r.deliverArgs(), r.onEvent),
        (err: unknown) => {
          // The supported check is the `code` FIELD — never `instanceof`, which
          // silently returns false across the src/dist dual resolution.
          assert.ok(isResumeUnavailable(err), `expected a resume failure, got ${String(err)}`);
          assert.match((err as Error).message, /no longer knows session/);
          return true;
        },
      );

      // (2) A cwd that no longer exists — session lookup is scoped to the
      // project directory, so a deleted worktree can never resume.
      const gone = mkdtempSync(join(tmpdir(), 'owenwork-claude-live-gone-'));
      rmSync(gone, { recursive: true, force: true });
      await assert.rejects(
        () => claudeAdapter.deliver(unknown, 'hello', r.deliverArgs({ cwd: gone }), r.onEvent),
        (err: unknown) => {
          assert.ok(isResumeUnavailable(err), `expected a resume failure, got ${String(err)}`);
          assert.match((err as Error).message, /cwd no longer exists/);
          return true;
        },
      );
    } finally {
      await r.close();
    }
  },
);

test(
  'LIVE REJECTION DRILL: the hub rejects the first submit, and the delta alone drives a revision in the SAME session',
  { skip: SKIP, timeout: 600_000 },
  async () => {
    const r = await rig(rejectingHubScript());
    let ref: HarnessSessionRef | undefined;
    try {
      // Turn 1 — the ordinary brief, the real mount, a real submit that the hub
      // rejects in its reply.
      ref = await claudeAdapter.start(r.startArgs(LIVE_BRIEF), r.onEvent);
      await until(() => submits(r.reqs).length >= 1, 'the first submit on the wire', 60_000);
      assert.equal(submittedUrl(submits(r.reqs)[0]), FIRST_URL);
      const afterFirst = r.events.length;

      // Turn 2 — ONLY the delta. `liveRejectionDelta` asserts on the way past
      // that this message does not contain the brief.
      const delta = liveRejectionDelta(LIVE_BRIEF);
      await claudeAdapter.deliver(ref, delta, r.deliverArgs(), r.onEvent);

      const resumeEvents = r.events.slice(afterFirst);
      assert.equal(
        resumeEvents.filter((e) => e.kind === 'started').length,
        0,
        'the rejection went into the EXISTING session — a resume never re-emits started',
      );
      // Same session, not a fork: the resumed turn reported the original id.
      assert.match(
        progress(resumeEvents),
        new RegExp(`session ${ref.token}\\b`),
        `the resumed turn ran under a different session id:\n${progress(resumeEvents)}`,
      );

      // THE ACCEPTANCE ASSERTION: the agent revised and re-submitted, having been
      // told only what was wrong. It could only do that from the brief it was
      // still carrying in the resumed session.
      await until(() => submits(r.reqs).length >= 2, 'the revised submit on the wire', 60_000);
      assertRevisionLanded(r.reqs, 'claude-code');
    } finally {
      if (ref !== undefined) await claudeAdapter.stop(ref);
      await r.close();
    }
  },
);

test(
  'stop on a token this process never started resolves quietly (documented no-op)',
  { skip: SKIP, timeout: 30_000 },
  async () => {
    await claudeAdapter.stop({ harness: 'claude-code', token: randomUUID() });
  },
);
