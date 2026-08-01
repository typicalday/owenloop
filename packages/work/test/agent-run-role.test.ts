/**
 * `src/roles/agent-run.ts` — the role's OWN responsibilities, not the loop's.
 *
 * `test/agent-loop.test.ts` already covers the orchestration (lease race, turn
 * end vs task end, the confirm phase). These tests cover the seven things only
 * the role does: parse the arg contract, refuse unresolvable input with exit 2,
 * map `AgentRunOutcome` onto an exit code, tag the holder, resolve WHICH adapter
 * hosts the agent (and fail honestly when none does), find the brief template in
 * the bundle cache, and wire the signal seam.
 *
 * Everything is hermetic: a temp HOME/XDG (so the credential store and cache are
 * throwaway), an injected `HubClient` (no network), a `FakeAdapter` registered
 * and unregistered per test (no harness process), and a fake `SignalHost` (the
 * real `process` is never signalled).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { exitCodeFor, parseArgs, run } from '../src/roles/agent-run.ts';
import type { AgentRunOutcome } from '../src/agent/loop.ts';
import { writeBundle } from '../src/bundle/cache.ts';
import type { StepPermissions } from '../src/harness/contract.ts';
import { createFakeAdapter, type FakeAdapter } from '../src/harness/fake.ts';
import { defaultHarnessId, register, registeredHarnessIds, unregister } from '../src/harness/registry.ts';
import type { AgentEvent, HarnessAdapter, HarnessSessionRef, StartArgs } from '../src/harness/contract.ts';
import type { SessionRecord } from '../src/harness/session-store.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';
import type { SignalHost } from '../src/roles/signals.ts';

// ---- arg parsing ------------------------------------------------------------

test('parseArgs reads the positional order-id and both flag value forms', () => {
  const p = parseArgs(['wf1/run1', '--origin=https://h', '--harness', 'fake', '--heartbeat-interval', '1500']);
  assert.equal(p.error, undefined);
  assert.equal(p.orderId, 'wf1/run1');
  assert.equal(p.origin, 'https://h');
  assert.equal(p.harness, 'fake');
  assert.equal(p.heartbeatIntervalMs, 1500);
});

test('parseArgs pairs a bare run id with --workflow, and reads --conductor', () => {
  const p = parseArgs(['run1', '--workflow', 'wf1', '--conductor=cnd_a']);
  assert.equal(p.orderId, 'run1');
  assert.equal(p.workflow, 'wf1');
  assert.equal(p.conductor, 'cnd_a');
});

test('parseArgs rejects a second positional and an unknown option', () => {
  assert.match(parseArgs(['a', 'b']).error!, /unexpected extra argument 'b'/);
  assert.match(parseArgs(['a', '--bogus']).error!, /unknown option '--bogus'/);
});

// All four ms knobs share one validator; assert each rejects the same three ways.
test('parseArgs validates every ms knob as a positive integer', () => {
  for (const flag of ['--heartbeat-interval', '--jump-tolerance', '--submit-grace', '--confirm-interval']) {
    assert.match(parseArgs(['a', flag, '0']).error!, /positive integer/, flag);
    assert.match(parseArgs(['a', flag, 'abc']).error!, /positive integer/, flag);
    assert.match(parseArgs(['a', flag]).error!, /missing value/, flag);
  }
  const p = parseArgs(['a', '--submit-grace', '50', '--confirm-interval=2', '--jump-tolerance', '300']);
  assert.equal(p.submitGraceMs, 50);
  assert.equal(p.confirmIntervalMs, 2);
  assert.equal(p.jumpToleranceMs, 300);
  // Absent means "leave the loop's own default alone" — not zero.
  assert.equal(parseArgs(['a']).submitGraceMs, undefined);
  assert.equal(parseArgs(['a']).confirmIntervalMs, undefined);
});

// ---- exit-code mapping ------------------------------------------------------

test('exitCodeFor maps every outcome to the documented code', () => {
  const zero: AgentRunOutcome[] = ['submitted', 'completed'];
  const one: AgentRunOutcome[] = [
    'misroute', 'no-template', 'no-harness', 'no-submit',
    'killed', 'lease-lost', 'ownership-error', 'hub-unreachable', 'stopped',
  ];
  for (const o of zero) assert.equal(exitCodeFor(o), 0);
  for (const o of one) assert.equal(exitCodeFor(o), 1);
});

// ---- fixtures ---------------------------------------------------------------

const DEF = 'mydef';
const HASH = 'sha256:deadbeef';
const TEMPLATE = [
  'order: __OWENWORK_ORDER__',
  'origin: __OWENWORK_ORIGIN__',
  'account: __OWENWORK_ACCOUNT__',
  'conductor: __OWENWORK_CONDUCTOR__',
].join('\n');

function agentOrder(o: { claimed?: boolean; outcome?: string; worker?: string; command?: string } = {}): GetOrderResponse {
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: {
      run: 'run1',
      workflow: 'wf1',
      step: 'builder',
      key: 'k',
      inputs: [],
      outputs: [],
      worker: o.worker ?? 'agent',
      command: o.command ?? '',
      prompt: '',
      consumes: {},
      owes: [{ path: 'out', acceptance: '', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    },
    lease: { claimed: o.claimed ?? true, ...(o.outcome !== undefined ? { outcome: o.outcome } : {}) },
  };
}

/** An order response with no packet and no hold — first contact says "done". */
function noHold(outcome: string): GetOrderResponse {
  return { text: '', workflow: 'wf1', run: 'run1', order: null, lease: { claimed: false, outcome } };
}

interface HubProbe {
  hub: HubClient;
  getOrderArgs: Array<Record<string, unknown>>;
  releases: unknown[];
  whatsNextArgs: unknown[];
}

/**
 * A hub whose `get_order` walks `responses` (last entry repeats). `onHeartbeat`
 * is the hook the signal test uses to fire SIGINT while the turn is in flight.
 */
function probeHub(cfg: {
  responses: GetOrderResponse[];
  def?: string | undefined;
  onHeartbeat?: (n: number) => void;
}): HubProbe {
  const getOrderArgs: Array<Record<string, unknown>> = [];
  const releases: unknown[] = [];
  const whatsNextArgs: unknown[] = [];
  let idx = 0;
  let hb = 0;
  const hub: HubClient = {
    async getOrder(req) {
      getOrderArgs.push(req as unknown as Record<string, unknown>);
      const at = idx < cfg.responses.length ? idx : cfg.responses.length - 1;
      idx += 1;
      return cfg.responses[at]!;
    },
    async heartbeat() {
      cfg.onHeartbeat?.(hb++);
      return { text: '' };
    },
    async release(req) {
      releases.push(req);
      return { text: '' };
    },
    async submit() {
      return { text: '', outcome: 'green' };
    },
    async whatsNext(req) {
      whatsNextArgs.push(req);
      return { text: '', ...(cfg.def !== undefined ? { def: cfg.def } : {}) };
    },
    async whoami() {
      return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' };
    },
    async wake() {
      return { text: '', cursor: 0, changed: false };
    },
    async presencePing(req) {
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
  };
  return { hub, getOrderArgs, releases, whatsNextArgs };
}

function fakeSignalHost(): { host: SignalHost; registered: string[]; emit: (sig: 'SIGINT' | 'SIGTERM') => void } {
  const handlers: Record<string, Array<() => void>> = { SIGINT: [], SIGTERM: [] };
  const registered: string[] = [];
  const host: SignalHost = {
    on(sig, h) {
      registered.push(sig);
      handlers[sig]!.push(h);
      return host;
    },
    exit() {
      /* the role never exits the process in tests */
    },
  };
  return { host, registered, emit: (sig) => { for (const h of [...handlers[sig]!]) h(); } };
}

/** An adapter whose turn never ends, so a signal can arrive mid-turn. */
function parkedAdapter(id: string): { adapter: HarnessAdapter; stops: number; startArgs: StartArgs[] } {
  const state = { stops: 0, startArgs: [] as StartArgs[] };
  const ref: HarnessSessionRef = { harness: id, token: 'parked-1' };
  const adapter: HarnessAdapter = {
    id,
    resumeTier: 'native-token',
    async start(args: StartArgs, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef> {
      state.startArgs.push(args);
      onEvent({ kind: 'started', ref });
      await new Promise<void>(() => {});
      return ref;
    },
    async deliver() {
      await new Promise<void>(() => {});
    },
    async stop() {
      state.stops += 1;
    },
  };
  return { adapter, get stops() { return state.stops; }, startArgs: state.startArgs };
}

let home: string;
let cacheDir: string;
let savedEnv: NodeJS.ProcessEnv;
const registeredIds: string[] = [];

/** Register an adapter and remember it, so `afterEach` leaves the global
 *  registry exactly as it found it. */
function useAdapter(a: HarnessAdapter): void {
  register(a);
  registeredIds.push(a.id);
}

/** Write a cached bundle whose `builder` step compiles to `TEMPLATE`. */
/**
 * Seed a cached bundle for DEF/HASH whose single `builder` step is an agent step.
 *
 * `harness` and `permissions` are written into BOTH halves of the cache — the
 * def envelope and the normalized step spec — because that is what `prepare`
 * produces: the def parser lifts `x.harness.id` onto the step, and
 * `normalizeStepPermissions` folds the rest of the bag into `permissions`. The
 * runner reads ONLY the spec (`steps/<step>.json`); the def half is here so the
 * fixture is a faithful `prepare` output rather than a half-written one.
 */
function seedBundle(seed: { harness?: string; model?: string; permissions?: StepPermissions } = {}): void {
  const harnessKey = seed.harness !== undefined ? { harness: seed.harness } : {};
  writeBundle(
    cacheDir,
    {
      def: {
        name: DEF,
        hash: HASH,
        steps: [{ name: 'builder', ...harnessKey, ...(seed.model !== undefined ? { model: seed.model } : {}) }],
      },
      fetchedAt: 1,
      origin: 'https://hub.example',
    },
    [{ step: 'builder', brief: TEMPLATE, ...harnessKey, permissions: seed.permissions ?? { extensions: {} } }],
  );
}

beforeEach(() => {
  savedEnv = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'owenwork-agentrun-home-'));
  cacheDir = join(home, 'cache');
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = home;
  process.env['OWENWORK_CACHE_DIR'] = cacheDir;
  delete process.env['OWENWORK_TOKEN'];
  delete process.env['OWENWORK_ACCOUNT'];
  delete process.env['OWENWORK_CONDUCTOR_ID'];
  // PHASE 4 wired the real adapters into the composition root, so importing this
  // role now fills the registry and the FIRST-REGISTERED default is a real
  // vendor adapter that would try to spawn a real process. Every test below that
  // does not itself exercise harness precedence pins the fixture adapter at the
  // `OWENWORK_HARNESS` rank; the precedence tests clear or override it.
  process.env['OWENWORK_HARNESS'] = 'fake';
  delete process.env['OWENWORK_HARNESS_MODULE'];
  process.env['OWENLOOP_NO_KEYCHAIN'] = '1';
});
afterEach(() => {
  process.env = savedEnv;
  for (const id of registeredIds.splice(0)) unregister(id);
  rmSync(home, { recursive: true, force: true });
});

// ---- resolution exits (no network, no adapter) ------------------------------

test('run() exits 2 on a missing order-id, a bare run id, a bad knob, and no origin', async () => {
  const quiet = { out: () => {}, err: () => {} };
  assert.equal(await run([], quiet), 2);
  assert.equal(await run(['run1', '--origin', 'https://hub.example'], quiet), 2);
  assert.equal(await run(['wf1/run1', '--origin', 'https://hub.example', '--submit-grace', 'nope'], quiet), 2);
  assert.equal(await run(['wf1/run1'], quiet), 2);
});

test('run() exits 2 with the refuse message when no Scoped Identity key is stored', async () => {
  const err: string[] = [];
  const code = await run(['wf1/run1', '--origin', 'https://hub.example'], { err: (l) => err.push(l), out: () => {} });
  assert.equal(code, 2);
  assert.match(err.join('\n'), /no Scoped Identity key for https:\/\/hub\.example/);
});

// ---- wiring: injected hub + registered fake adapter -------------------------

const WIRE = ['wf1/run1', '--origin', 'https://hub.example', '--heartbeat-interval', '50000', '--confirm-interval', '1', '--submit-grace', '2000'];

test('run() happy path: agent order → brief → fake harness turn → hub outcome → exit 0', async () => {
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle();
  const { hub, getOrderArgs, whatsNextArgs, releases } = probeHub({
    responses: [agentOrder(), agentOrder({ outcome: 'ok' })],
    def: DEF,
  });
  const sig = fakeSignalHost();

  const code = await run(WIRE, { hub, signalHost: sig.host, holderId: 'host:123', cwd: '/work', out: () => {}, err: () => {} });

  assert.equal(code, 0);
  assert.deepEqual(sig.registered.sort(), ['SIGINT', 'SIGTERM']);
  // The exec-kind holder tag rode first contact (the runner IS an exec holder).
  assert.deepEqual(getOrderArgs[0]!['holder'], { kind: 'exec', id: 'host:123' });
  // The def name came off a non-claiming whats_next scoped to this workflow.
  assert.deepEqual(whatsNextArgs, [{ workflow: 'wf1' }]);
  // Submitted closes via the hub outcome — the runner must NOT release.
  assert.equal(releases.length, 0);
  // One start, no deliver: a fresh attempt is a cold start.
  assert.deepEqual(fake.calls.map((c) => c.kind), ['start', 'stop']);
});

// D10, and the exact boundary of what Phase 4 fixed: the mount is a bare
// `owenloop work hold --mcp` argv. The mounted work-holder resolves its own
// credential from the store, so no token may appear in the argv the harness
// child will see.
//
// STRIPPING `OWENWORK_TOKEN` FROM THE CHILD ENV IS NOT DONE HERE EITHER — it is
// done in the adapters, by `filterOwenworkEnv` (`src/harness/child-env.ts`), and
// is asserted in `test/child-env.test.ts`, `test/harness-claude.test.ts` and
// `test/harness-codex.test.ts`. What this file owns is the RUNNER-SIDE half of
// that Phase 6 change: because the harness child can no longer see the
// override, `agent-run` ignores it too, so both sides authenticate as the same
// principal instead of splitting apart mid-order. The third sibling assertion —
// that the rejection delta and the replay brief carry no credential material —
// lives in `test/agent-rejection.test.ts`.
test('run() builds an MCP mount whose args carry no credential', async () => {
  process.env['OWENWORK_TOKEN'] = 'olp_secret_value';
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle();
  const { hub } = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });

  const err: string[] = [];
  const code = await run([...WIRE, '--conductor', 'cnd_1'], {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work',
    out: () => {}, err: (l) => err.push(l),
  });
  assert.equal(code, 0);

  const started = fake.calls.find((c) => c.kind === 'start');
  assert.ok(started !== undefined && started.kind === 'start');
  const mcp = started.args.owenworkMcp;
  assert.deepEqual(mcp, {
    command: 'owenloop',
    args: ['work', 'hold', '--order', 'wf1/run1', '--origin', 'https://hub.example', '--as', 'default', '--conductor=cnd_1', '--mcp'],
  });
  const flat = JSON.stringify(mcp);
  assert.ok(!flat.includes('olp_secret_value'), flat);
  assert.ok(!flat.includes('Bearer'), flat);
  assert.ok(!/--token|OWENWORK_TOKEN/.test(flat), flat);

  // D10(b), CLOSED in Phase 6: the override is not warned about, it is IGNORED,
  // and the message says what to do instead. Both halves are asserted, because a
  // message that announced the change without making it would be worse than the
  // old warning.
  const stderr = err.join('\n');
  assert.match(stderr, /OWENWORK_TOKEN is set and is being IGNORED here/);
  assert.match(stderr, /owenloop login --hub/, 'the message must name the actionable alternative');
});

/**
 * PHASE 6 ITEM 5, the runner-side half, asserted on the SEAM rather than on a
 * log line: what `agent-run` hands to `resolveBearer`.
 *
 * The consequence being prevented is a split brain. The harness child cannot see
 * `OWENWORK_TOKEN` any more, so if the runner still honoured it the runner would
 * authenticate to the hub as the override's principal while the child fell back
 * to the `agent:<account>` credential slot — and an empty slot would surface as
 * an opaque MCP handshake failure mid-order rather than as a refusal at startup.
 *
 * This test drives the real `run()` with no injected hub, so the real
 * `resolveBearer` runs against an empty credential store. The proof is the exit
 * code: 2 (`resolveBearer`'s startup refusal) and NOT 0, which is what a runner
 * that still honoured the override would return.
 */
test('run() ignores OWENWORK_TOKEN when resolving its own bearer, and refuses at startup', async () => {
  process.env['OWENWORK_TOKEN'] = 'olp_secret_value';
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle();

  const err: string[] = [];
  const code = await run([...WIRE], {
    signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work',
    out: () => {}, err: (l) => err.push(l),
  });

  assert.equal(code, 2, 'an empty credential slot must fail at STARTUP, not mid-order');
  assert.deepEqual(fake.calls, [], 'no harness may be started once the bearer is refused');
  assert.match(err.join('\n'), /OWENWORK_TOKEN is set and is being IGNORED here/);
});

test('run() renders the brief from the cached template and passes the step permission bag', async () => {
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  // `prepare` already normalized `x.harness` into these permissions at cache
  // time — the runner does not re-read an option bag and has no bag key.
  seedBundle({ model: 'm-step', permissions: { tools: ['Read'], model: 'm-step', extensions: {} } });
  const { hub } = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });

  const code = await run([...WIRE, '--conductor', 'cnd_1'], {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: () => {},
  });
  assert.equal(code, 0);

  const started = fake.calls.find((c) => c.kind === 'start');
  assert.ok(started !== undefined && started.kind === 'start');
  assert.equal(
    started.args.brief,
    'order: wf1/run1\norigin: https://hub.example\naccount: default\nconductor: cnd_1',
  );
  // The permissions ride PRE-NORMALIZED on the step spec — no lookup, no key.
  assert.deepEqual(started.args.permissions.tools, ['Read']);
  assert.equal(started.args.permissions.model, 'm-step');
});

test('run() records the session in <cacheDir>/sessions.jsonl', async () => {
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake', token: 'tok-7' });
  useAdapter(fake);
  seedBundle();
  const { hub } = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });

  assert.equal(
    await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: () => {} }),
    0,
  );

  const lines = readFileSync(join(cacheDir, 'sessions.jsonl'), 'utf8').trim().split('\n');
  const recs = lines.map((l) => JSON.parse(l) as SessionRecord);
  assert.deepEqual(recs.map((r) => r.status), ['active', 'turn-ended', 'submitted']);
  assert.equal(recs[0]!.order, 'wf1/run1');
  assert.equal(recs[0]!.step, 'builder');
  assert.equal(recs[0]!.harness, 'fake');
  assert.equal(recs[0]!.token, 'tok-7');
  assert.equal(recs[0]!.attempt, 1);
  assert.equal(recs[0]!.cwd, '/work');
});

// ---- adapter resolution -----------------------------------------------------

test('run() fails honestly (exit 1) when --harness names no registered adapter', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  seedBundle();
  const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
  const err: string[] = [];

  const code = await run([...WIRE, '--harness', 'nope'], {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: (l) => err.push(l),
  });

  assert.equal(code, 1);
  const text = err.join('\n');
  assert.match(text, /nope/); // names the id it could not resolve
  assert.match(text, /fake/); // and what IS registered
  // no-harness releases, so the hub can re-offer the order.
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1' }]);
});

test('OWENWORK_HARNESS outranks the step def, and the step def outranks the default', async () => {
  const chosen = createFakeAdapter({ id: 'chosen' });
  const other = createFakeAdapter({ id: 'other' });
  useAdapter(chosen);
  useAdapter(other);
  seedBundle({ harness: 'other' });

  // env wins over the step def
  process.env['OWENWORK_HARNESS'] = 'chosen';
  const a = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });
  assert.equal(await run(WIRE, { hub: a.hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: () => {} }), 0);
  assert.equal(chosen.calls.length > 0, true);
  assert.equal(other.calls.length, 0);

  // with no env, the step def's `harness` decides
  delete process.env['OWENWORK_HARNESS'];
  const b = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });
  assert.equal(await run(WIRE, { hub: b.hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: () => {} }), 0);
  assert.equal(other.calls.length > 0, true);
});

/**
 * The built-in default is the FIRST id in the registry — i.e. the first adapter
 * the composition root imports — not a hardcoded vendor string.
 *
 * PHASE 4 gave this test teeth it did not have before. Through Phase 3 the
 * import block was empty, so `registeredHarnessIds()` was `[]` in production and
 * this asserted `undefined`. Phase 4 filled the block, so what matters now is the
 * INVARIANT rather than the literal: the registry is non-empty at import time,
 * `defaultHarnessId()` is its head, and a later `register` never displaces it.
 *
 * The ids themselves are deliberately not written down here. Naming them would
 * put a harness VENDOR NAME outside `src/harness/`, which is exactly the rule
 * `test/harness-isolation.test.ts` exists to hold.
 */
test('defaultHarnessId is the first registered id, and registration order is stable', () => {
  const atImport = registeredHarnessIds();
  assert.ok(atImport.length > 0, 'the composition root registers its adapters on import');
  assert.equal(defaultHarnessId(), atImport[0]);

  useAdapter(createFakeAdapter({ id: 'first' }));
  useAdapter(createFakeAdapter({ id: 'second' }));
  assert.deepEqual(registeredHarnessIds(), [...atImport, 'first', 'second'], 'appended, never prepended');
  assert.equal(defaultHarnessId(), atImport[0], 'a late registration cannot steal the default');
});

test('a bad OWENWORK_HARNESS_MODULE is reported and does not crash the runner', async () => {
  process.env['OWENWORK_HARNESS_MODULE'] = join(home, 'does-not-exist.mjs');
  const { hub } = probeHub({ responses: [noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 0); // first contact says the run is already done
  assert.match(err.join('\n'), /could not load OWENWORK_HARNESS_MODULE/);
});

// ---- template resolution ----------------------------------------------------

test('run() exits 1 and releases when the def has no cached bundle', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /no cached bundle for def 'mydef'/);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1' }]);
});

test('run() exits 1 when whats_next reports no def for the workflow', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  const { hub } = probeHub({ responses: [agentOrder(), noHold('ok')] }); // def undefined
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /whats_next reported no def for workflow 'wf1'/);
});

// ---- misroute + signal wiring ----------------------------------------------

test('run() releases a COMMAND order as a misroute and exits 1', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  seedBundle();
  const { hub, releases } = probeHub({ responses: [agentOrder({ worker: 'command', command: 'echo hi' }), noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /is not an agent order \(misroute\)/);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1' }]);
});

test('run() signal wiring: agent-run message line, SIGINT mid-turn stops the session and releases', async () => {
  const parked = parkedAdapter('fake');
  useAdapter(parked.adapter);
  seedBundle();
  const sig = fakeSignalHost();
  const { hub, releases } = probeHub({
    responses: [agentOrder()],
    def: DEF,
    onHeartbeat: (n) => {
      if (n === 0) sig.emit('SIGINT');
    },
  });
  const err: string[] = [];

  const code = await run(
    ['wf1/run1', '--origin', 'https://hub.example', '--heartbeat-interval', '5'],
    { hub, signalHost: sig.host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) },
  );

  assert.equal(code, 1); // killed
  assert.ok(
    err.includes('owenloop work agent-run: SIGINT received — stopping the step agent and releasing the order'),
    err.join('\n'),
  );
  assert.equal(parked.stops, 1);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1' }]);
});
