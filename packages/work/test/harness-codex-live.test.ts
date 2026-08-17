/**
 * Phase 2B LIVE smoke test — drives a real `codex app-server` end to end.
 *
 * SKIPPED BY DEFAULT. It needs a logged-in machine and it spends real tokens, so
 * CI stays green without credentials and nobody's laptop runs it by accident:
 *
 *     OWENLOOP_LIVE_TESTS=1 node --test test/harness-codex-live.test.ts
 *
 * What it is for: the unit tests in `harness-codex.test.ts` prove the adapter
 * agrees with a RECORDING. Only this file proves it still agrees with the
 * BINARY. When a version bump changes the protocol, this is what notices.
 *
 * THE MOUNT IS THE REAL ONE. An earlier revision of this file mounted a
 * hand-written stub MCP server instead of `bin/owenloop.mjs work hold --mcp`, and
 * that substitution hid two real defects, both since fixed and both regression-
 * guarded in `harness-codex.test.ts`:
 *
 *   1. codex does NOT give an MCP server child this process's environment, so
 *      `OWENLOOP_TOKEN` never arrived, `owenloop work hold --mcp` exited 2 before its
 *      MCP `initialize` reply, and codex reported the mount `failed` (C15).
 *   2. `approvalPolicy:'never'` does NOT cover MCP tool calls, so every
 *      `get_order`/`submit` was recorded as `user rejected MCP tool call` (D9).
 *
 * A stub answered `initialize` and listed a fake `submit`, so neither showed up.
 * Hence the assertions below end at the mock hub: the run is only proven if the
 * agent's `submit` reached it.
 *
 * It deliberately does NOT log in and does not write any codex config, and it
 * asserts that it did not — see the `~/.codex/config.toml` check at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexAdapter } from '../src/harness/codex.ts';
import { normalizeStepPermissions } from '../src/harness/permissions.ts';
import type { AgentEvent, DeliverArgs, HarnessSessionRef, StartArgs } from '../src/harness/contract.ts';
import { startMockHub, until, type HubReq } from './helpers/mcp-stdio-client.ts';
import {
  assertRevisionLanded,
  FIRST_URL,
  liveRejectionDelta,
  LIVE_BRIEF,
  submits as submitBodies,
  submittedUrl,
} from './helpers/live-rejection.ts';

const LIVE = process.env['OWENLOOP_LIVE_TESTS'] === '1';
const skip = LIVE ? false : 'set OWENLOOP_LIVE_TESTS=1 to run';

const BIN = join(import.meta.dirname, '..', '..', '..', 'bin', 'owenloop.mjs');
const TOKEN = 'tok-codex-live';

const ORDER_PACKET = {
  run: 'run1',
  workflow: 'wf1',
  step: 'builder',
  key: 'k',
  inputs: [],
  outputs: ['pr'],
  prompt: 'Reply to the operator with the word ok.',
  consumes: {},
  owes: [],
};

/** Canned hub: healthy lease, green closing submit. Same script as the
 *  `hold --mcp` e2e, so the two drills agree on the wire. */
function hubScript(verb: string): unknown {
  switch (verb) {
    case 'get_order':
      return { text: 'here', workflow: 'wf1', run: 'run1', order: ORDER_PACKET, lease: { claimed: true } };
    case 'heartbeat':
      return { text: 'hb' };
    case 'release':
      return { text: 'released', released: true };
    case 'submit':
      return { text: 'ok', outcome: 'green', closed: true };
    default:
      return { text: '' };
  }
}

/**
 * PHASE 4 — the live rejection drill's hub. The FIRST submit is rejected in the
 * hub's own reply; every later one is accepted. `closed` stays false throughout,
 * because a closed order would make the second submit meaningless.
 */
function rejectingHubScript(): (verb: string) => unknown {
  let seen = 0;
  return (verb: string): unknown => {
    if (verb !== 'submit') return hubScript(verb);
    seen += 1;
    return seen === 1
      ? { text: 'rejected: see the reviewer reasons', outcome: 'reject', closed: false }
      : { text: 'ok', outcome: 'green', closed: false };
  };
}

/** The production mount, verbatim: the real binary, in `hold --mcp` mode,
 *  bound to one order and pointed at the mock hub. */
function realMount(origin: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [BIN, 'work', 'hold', '--order', 'wf1/run1', '--origin', origin, '--mcp'],
  };
}

function liveArgs(cwd: string, origin: string, brief: string): StartArgs {
  return {
    brief,
    cwd,
    owenloopMcp: realMount(origin),
    // `workspace-write`, not `read-only`: the hold child's own working set lives
    // under the temp cwd, and a read-only sandbox is not what production runs.
    permissions: normalizeStepPermissions({ permissionMode: 'never', sandbox: 'workspace-write' }),
  };
}

/**
 * PHASE 4 — the `DeliverArgs` half of the same fixture: `liveArgs` minus
 * `brief`. `deliver` now takes the full args, and `permissions` is what the
 * adapter rebuilds the resumed thread's configuration from.
 */
function liveDeliverArgs(cwd: string, origin: string): DeliverArgs {
  const { brief: _brief, ...rest } = liveArgs(cwd, origin, '');
  return rest;
}

/**
 * The mount child's environment. `HarnessMcpMount` is `{command, args}` — it has
 * no `env` field, and Phase 2B may not widen the contract — so the adapter
 * forwards `OWENLOOP_*` and selected base environment vars from ITS OWN environment onto the
 * mount (see `mountEnv` in `src/harness/codex.ts`). This test therefore sets
 * them on `process.env` and restores them, exactly as the runner's process
 * would already carry them.
 */
function withChildEnv(t: { after(fn: () => void): void }, configDir: string): void {
  const saved = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  process.env['OWENLOOP_TOKEN'] = TOKEN;
  process.env['HOME'] = configDir;
  delete process.env['OWENLOOP_CONFIG_DIR'];
  process.env['OWENLOOP_SESSION'] = '';
}

function of(reqs: HubReq[], verb: string): HubReq[] {
  return reqs.filter((r) => r.verb === verb);
}

test('live: a real turn drives the real owenloop mount, and deliver resumes the same thread', { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-codex-live-'));
  // A temp HOME means the hold child sees NO settings file: origin
  // comes only from `--origin`, token only from `OWENLOOP_TOKEN`.
  const configDir = mkdtempSync(join(tmpdir(), 'owenloop-codex-live-cfg-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
  withChildEnv(t, configDir);

  const { origin, reqs, server } = await startMockHub(hubScript);
  t.after(() => server.close());

  // (7) The adapter must never configure codex globally — no `codex mcp add`,
  //     no mount written to disk; every mount is a per-thread param.
  //
  //     MEASURED, and the reason this is not an mtime check: codex ITSELF
  //     appends `[projects."<cwd>"] trust_level = "trusted"` to the user's
  //     config the first time a thread starts in an unseen cwd under
  //     `approvalPolicy:'never'`. That is codex's bookkeeping, not the
  //     adapter's, and it happens no matter what this adapter does — but it does
  //     mean a long-lived runner that starts threads in ephemeral cwds grows
  //     that file forever. So: compare the config with the project-trust blocks
  //     removed, which pins the part the adapter could actually have touched.
  const configPath = join(homedir(), '.codex', 'config.toml');
  const configSansProjects = (): string | undefined => {
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch {
      return undefined;
    }
    const out: string[] = [];
    let inProject = false;
    for (const line of raw.split('\n')) {
      if (line.startsWith('[')) inProject = line.startsWith('[projects.');
      if (!inProject) out.push(line);
    }
    return out.join('\n');
  };
  const configBefore = configSansProjects();

  const events: AgentEvent[] = [];
  const record = (e: AgentEvent): void => {
    events.push(e);
  };

  let ref: HarnessSessionRef | undefined;
  try {
    ref = await codexAdapter.start(
      liveArgs(
        dir,
        origin,
        "Call the `get_order` tool, then call the `submit` tool with path 'pr' and value 'ok'. Do not do anything else.",
      ),
      record,
    );

    // (1) The session ref identifies this harness and carries a resume token.
    assert.equal(ref.harness, 'codex');
    assert.ok(ref.token.length > 0, 'a live thread must yield a resume token');

    // (2) `started` is emitted BEFORE the turn ends, so a mid-turn crash still
    //     leaves the caller a resumable record.
    const startedIdx = events.findIndex((e) => e.kind === 'started');
    const endedIdx = events.findIndex((e) => e.kind === 'turn_ended');
    assert.ok(startedIdx >= 0, 'a started event must be emitted');
    assert.ok(endedIdx > startedIdx, 'turn_ended must come after started');

    // (3) start resolves at TURN end, not process end — the child is still alive
    //     and the turn already finished.
    assert.equal(
      events.filter((e) => e.kind === 'exited').length,
      0,
      'a healthy turn must not report an exit',
    );

    const text = events
      .filter((e): e is Extract<AgentEvent, { kind: 'progress' }> => e.kind === 'progress')
      .map((e) => e.text)
      .join('\n');

    // (4) The REAL owenloop mount started under a live server. This is the
    //     assertion the stub used to satisfy vacuously.
    assert.match(text, /MCP server 'owenloop' status ready/, 'the owenloop mount reached ready');

    // (5) THE POINT OF THE WHOLE DRILL: the live agent reached owenloop's own
    //     tools and the artifact actually landed on the hub. Nothing short of
    //     this proves a codex-driven order can complete.
    assert.ok(of(reqs, 'get_order').length >= 1, 'the hold made first contact with the hub');
    const submits = of(reqs, 'submit');
    assert.equal(submits.length, 1, `the agent's submit must reach the hub; hub saw ${JSON.stringify(reqs.map((r) => r.verb))}`);
    assert.equal(submits[0]?.auth, `Bearer ${TOKEN}`, 'the mount carried the token this process set');
    assert.equal((submits[0]?.body as { path?: string } | undefined)?.path, 'pr');

    // (6) A resume against the SAME token runs a second turn on that thread and
    //     does NOT re-emit `started`.
    const before = events.length;
    await codexAdapter.deliver(
      ref,
      'Reply with exactly the word RESUMED and nothing else. Do not use any tools.',
      liveDeliverArgs(dir, origin),
      record,
    );
    const resumeEvents = events.slice(before);
    assert.equal(
      resumeEvents.filter((e) => e.kind === 'started').length,
      0,
      'a resume must never re-emit started',
    );
    assert.equal(resumeEvents.filter((e) => e.kind === 'turn_ended').length, 1);
    const resumeText = resumeEvents
      .filter((e): e is Extract<AgentEvent, { kind: 'progress' }> => e.kind === 'progress')
      .map((e) => e.text)
      .join('');
    assert.match(resumeText, /RESUMED/i, 'the resumed turn answered the second brief');
  } finally {
    if (ref !== undefined) await codexAdapter.stop(ref);
  }

  // (7) Nothing the ADAPTER could have written appears in the user's config —
  //     no `[mcp_servers.owenloop]`, no anything else. Only codex's own
  //     project-trust bookkeeping (stripped above) may differ.
  assert.equal(configSansProjects(), configBefore, '~/.codex/config.toml must not be configured by the adapter');
  assert.equal(
    /\[mcp_servers\.owenloop\]/.test(configSansProjects() ?? ''),
    false,
    'the owenloop mount is a per-thread param and must never be persisted',
  );
});

test(
  'live: LIVE REJECTION DRILL — the hub rejects the first submit and the delta alone drives a revision on the same thread',
  { skip, timeout: 600_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'owenloop-codex-live-reject-'));
    const configDir = mkdtempSync(join(tmpdir(), 'owenloop-codex-live-reject-cfg-'));
    t.after(() => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    });
    withChildEnv(t, configDir);

    const { origin, reqs, server } = await startMockHub(rejectingHubScript());
    t.after(() => server.close());

    const events: AgentEvent[] = [];
    const record = (e: AgentEvent): void => {
      events.push(e);
    };

    let ref: HarnessSessionRef | undefined;
    try {
      // Turn 1 — the ordinary brief, the real mount, a submit the hub rejects.
      ref = await codexAdapter.start(liveArgs(dir, origin, LIVE_BRIEF), record);
      await until(() => submitBodies(reqs).length >= 1, 'the first submit on the wire', 60_000);
      assert.equal(submittedUrl(submitBodies(reqs)[0]), FIRST_URL);
      const before = events.length;

      // Turn 2 — ONLY the delta. `liveRejectionDelta` asserts on the way past
      // that this message does not contain the brief. It is the SAME fixture the
      // Claude adapter's live drill uses; that sameness is the portability proof.
      const delta = liveRejectionDelta(LIVE_BRIEF);
      await codexAdapter.deliver(ref, delta, liveDeliverArgs(dir, origin), record);

      const resumeEvents = events.slice(before);
      assert.equal(
        resumeEvents.filter((e) => e.kind === 'started').length,
        0,
        'the rejection went into the EXISTING thread — a resume never re-emits started',
      );
      assert.equal(resumeEvents.filter((e) => e.kind === 'turn_ended').length, 1);

      // THE ACCEPTANCE ASSERTION: the agent revised and re-submitted, having been
      // told only what was wrong. It could only do that from the brief it was
      // still carrying in the resumed thread.
      await until(() => submitBodies(reqs).length >= 2, 'the revised submit on the wire', 60_000);
      assertRevisionLanded(reqs, 'codex');
    } finally {
      if (ref !== undefined) await codexAdapter.stop(ref);
    }
  },
);

test('live: resuming a thread the provider never knew is ResumeUnavailable', { skip }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-codex-live-miss-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // No hub is started: the resume must fail on the thread id alone, before the
  // mount is ever spawned. A reachable hub would not change the outcome.
  const err = await codexAdapter
    .deliver(
      { harness: 'codex', token: '00000000-0000-4000-8000-000000000000' },
      'carry on',
      liveDeliverArgs(dir, 'http://127.0.0.1:1'),
      () => {},
    )
    .then(
      () => undefined,
      (e: unknown) => e,
    );

  assert.ok(err instanceof Error, 'an unknown thread must reject');
  // By CODE, never instanceof — tests import src/ while the package resolves dist/.
  assert.equal(
    (err as { code?: string }).code,
    'RESUME_UNAVAILABLE',
    `expected a resume-unavailable rejection, got: ${err.message}`,
  );
  assert.match(err.message, /no longer knows thread/);
});
