/**
 * `src/roles/agent-run.ts` — the role's OWN responsibilities, not the loop's.
 *
 * `test/agent-loop.test.ts` already covers the orchestration (lease race, turn
 * end vs task end, the confirm phase). These tests cover the role's responsibilities:
 * parse the arg contract, refuse unresolvable input with exit 2, map
 * `AgentRunOutcome` onto an exit code, tag the holder, resolve WHICH adapter hosts
 * the agent (and fail honestly when none does), find the brief template in the
 * bundle cache, set the per-order child environment, and wire the signal seam.
 *
 * Everything is hermetic: a temp HOME/XDG (so the credential store and cache are
 * throwaway), an injected `HubClient` (no network), a `FakeAdapter` or test probe
 * registered and unregistered per test, and a fake `SignalHost` (the real process
 * is never signalled).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { exitCodeFor, parseArgs, run as roleRun, type RunDeps } from '../src/roles/agent-run.ts';
import type { AgentRunOutcome } from '../src/agent/loop.ts';
import { writeBundle } from '../src/bundle/cache.ts';
import type { StepPermissions } from '../src/harness/contract.ts';
import { filterOwenloopEnv } from '../src/harness/child-env.ts';
import { createFakeAdapter, type FakeAdapter } from '../src/harness/fake.ts';
import { defaultHarnessId, register, registeredHarnessIds, unregister } from '../src/harness/registry.ts';
import type { AgentEvent, HarnessAdapter, HarnessSessionRef, StartArgs } from '../src/harness/contract.ts';
import type { SessionRecord } from '../src/harness/session-store.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';
import type { SignalHost } from '../src/roles/signals.ts';
import type { InstructionResolver } from '../src/exec/instructions.ts';
import type { StepDef } from '../../../src/types.ts';
import { resolveOwenloopBin } from '../src/owenloop-bin.ts';
import { buildDef } from '../../../src/defs.ts';
import { installSignedBundleFixture, writeBundleSource } from '../../../test/helpers/store-fixture.ts';

// ---- arg parsing ------------------------------------------------------------

test('parseArgs reads the positional order-id and both flag value forms', () => {
  const p = parseArgs(['wf1/run1', '--origin=https://h', '--harness', 'fake', '--heartbeat-interval', '1500']);
  assert.equal(p.error, undefined);
  assert.equal(p.orderId, 'wf1/run1');
  assert.equal(p.origin, 'https://h');
  assert.equal(p.harness, 'fake');
  assert.equal(p.heartbeatIntervalMs, 1500);
});

test('parseArgs pairs a bare run id with --workflow, and reads --shift', () => {
  const p = parseArgs(['run1', '--workflow', 'wf1', '--shift=shf_a']);
  assert.equal(p.orderId, 'run1');
  assert.equal(p.workflow, 'wf1');
  assert.equal(p.shift, 'shf_a');
});

test('parseArgs rejects a second positional and an unknown option', () => {
  assert.match(parseArgs(['a', 'b']).error!, /unexpected extra argument 'b'/);
  assert.match(parseArgs(['a', '--bogus']).error!, /unknown option '--bogus'/);
});

test('parseArgs preserves empty and whitespace-only harness overrides for roster fallback', () => {
  for (const args of [
    ['a', '--harness='],
    ['a', '--harness', ''],
    ['a', '--harness=   '],
    ['a', '--harness', ' \t '],
  ]) {
    const parsed = parseArgs(args);
    assert.equal(parsed.error, undefined, JSON.stringify(args));
    assert.equal(parsed.harness?.trim(), '');
  }
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
    'misroute', 'no-template', 'no-harness', 'incompatible-harness-policy', 'unverified-consumed',
    'unstamped-order', 'unresolvable-crew', 'session-store-failed', 'no-submit', 'killed', 'lease-lost',
    'ownership-error', 'hub-unreachable', 'stopped',
  ];
  for (const o of zero) assert.equal(exitCodeFor(o), 0);
  for (const o of one) assert.equal(exitCodeFor(o), 1);
});

// ---- fixtures ---------------------------------------------------------------

const DEF = 'mydef';
const HASH = 'sha256:deadbeef';
const TEMPLATE = [
  'order: __OWENLOOP_ORDER__',
  'origin: __OWENLOOP_ORIGIN__',
  'account: __OWENLOOP_ACCOUNT__',
  'shift: __OWENLOOP_SHIFT__',
].join('\n');

function seedAgentCredential(home: string, origin: string, token: string): void {
  const directory = join(home, '.owenloop');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'credentials.json'),
    JSON.stringify({ version: 2, hubs: { [origin]: { 'agent:default': { kind: 'agent', accessToken: token } } } }),
  );
}

function makeTreeWritable(path: string): void {
  if (!existsSync(path)) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) makeTreeWritable(child);
    else chmodSync(child, 0o600);
  }
}

function agentOrder(o: {
  claimed?: boolean;
  outcome?: string;
  worker?: string;
  defDigest?: string;
  workflow?: string;
  run?: string;
  step?: string;
  model?: string;
  capabilities?: string[];
  crews?: string[];
  x?: Record<string, unknown>;
} = {}): GetOrderResponse {
  const workflow = o.workflow ?? 'wf1';
  const run = o.run ?? 'run1';
  return {
    text: '',
    workflow,
    run,
    order: {
      run,
      workflow,
      step: o.step ?? 'builder',
      key: 'k',
      inputs: [],
      outputs: [],
      ...(o.worker !== undefined ? { worker: o.worker } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
      capabilities: o.capabilities ?? ['build'],
      crews: o.crews ?? ['test-crew'],
      ...(o.x !== undefined ? { x: o.x } : {}),
      defDigest: o.defDigest ?? HASH,
      consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
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
    async reject() { return { text: '', ok: true }; },
    async ask() { return { text: '', ok: true }; },
    // The tool-approval gate is not exercised by these tests; a fake that never
    // opens an approval, and a non-answer is a denial.
    async requestApproval() { return { text: '', ok: false }; },
    async answerApproval() { return { text: '', ok: false }; },
    async listPendingApprovals() { return { text: '', approvals: [] }; },
    async reportResolution(req) {
      return { text: '', workflow: req.workflow, run: req.run, step: '', recorded: true, claimed: true };
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
    preflight: () => [],
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

/**
 * A harness-shaped adapter whose start method really spawns a child. The child
 * receives the same filtered process environment as the production adapters, so
 * this catches a missing agent-run setter rather than only testing an in-process
 * env object.
 */
function spawningEnvProbe(): { adapter: HarnessAdapter; observed: string[] } {
  const observed: string[] = [];
  const ref: HarnessSessionRef = { harness: 'env-probe', token: 'env-probe-1' };

  const spawnProbe = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(
		process.execPath,
		[
		  '-e',
		  'process.stdout.write(JSON.stringify({workflow: process.env.OWENLOOP_WORKFLOW ?? null, run: process.env.OWENLOOP_RUN ?? null}))',
		],
		{ env: filterOwenloopEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] },
      );
	if (child.stdout === null || child.stderr === null) {
	  child.kill();
	  reject(new Error('env probe did not receive piped stdio'));
	  return;
	}
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => { stdout += String(chunk); });
	child.stderr.on('data', (chunk) => { stderr += String(chunk); });
	child.once('error', reject);
	child.once('close', (code, signal) => {
	  if (code !== 0) {
	    reject(new Error(`env probe exited with code=${String(code)} signal=${String(signal)}: ${stderr}`));
	    return;
	  }
	  resolve(stdout);
	});
    });

  const adapter: HarnessAdapter = {
    id: ref.harness,
    resumeTier: 'replay',
    preflight: () => [],
    async start(_args: StartArgs, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef> {
      onEvent({ kind: 'started', ref });
      observed.push(await spawnProbe());
      onEvent({ kind: 'turn_ended' });
      return ref;
    },
    async deliver() {
      throw new Error('the env probe only supports a cold start');
    },
    async stop() {
      // The probe child has exited before start resolves.
    },
  };
  return { adapter, observed };
}

let home: string;
let cacheDir: string;
let savedEnv: NodeJS.ProcessEnv;
const registeredIds: string[] = [];
let verifiedStep: StepDef | undefined;
let verifiedBundleDir: string | undefined;

const testInstructions = (): InstructionResolver => ({
  resolveCommand: async () => ({ ok: false, kind: 'missing-command', reason: 'command resolution is not used by agent-run tests' }),
  resolveStep: async (order) => {
    if (order.defDigest.trim() === '') return { ok: false, kind: 'no-digest', reason: 'the order has no definition digest' };
    if (verifiedStep === undefined) return { ok: false, kind: 'unknown-digest', reason: `unknown local workflow digest '${order.defDigest}'` };
    return { ok: true, step: verifiedStep, ...(verifiedBundleDir !== undefined ? { bundleDir: verifiedBundleDir } : {}) };
  },
});

const run = (args: string[], deps: RunDeps = {}): Promise<number> =>
  roleRun(args, { instructions: testInstructions(), ...deps });

/** Register an adapter and remember it, so `afterEach` leaves the global
 *  registry exactly as it found it. */
function useAdapter(a: HarnessAdapter): void {
  register(a);
  registeredIds.push(a.id);
}

/** Write a cached bundle whose `builder` step compiles to `TEMPLATE`. */
/**
 * Seed the verified local step plus the matching prepare cache fixture.
 * Runtime instruction resolution reads `verifiedStep`; the cache remains present
 * because the role also owns cache/session paths exercised by neighboring tests.
 */
function seedBundle(seed: { harness?: string; model?: string; permissions?: StepPermissions } = {}): void {
  const harnessKey = seed.harness !== undefined ? { harness: seed.harness } : {};
  const permissions = seed.permissions ?? { extensions: {} };
  const carrier = {
    ...(seed.harness !== undefined ? { id: seed.harness } : {}),
    ...permissions,
  };
  verifiedStep = {
    name: 'builder',
    body: TEMPLATE,
    ...(seed.model !== undefined ? { model: seed.model } : {}),
    x: { harness: carrier },
  } as unknown as StepDef;
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

/** Replace the machine-global roster for a test that needs a specific rank. */
function writeRoster(roster: Record<string, Array<{ harness: string; model: string; effort: string }>>): void {
  writeFileSync(join(home, '.owenloop', 'settings.json'), JSON.stringify({ roster }));
}

/** Seed the verified-step seam with raw x contents, including malformed carriers. */
function seedRawStep(x: Record<string, unknown>): void {
  verifiedStep = {
    name: 'builder',
    body: TEMPLATE,
    x,
  } as unknown as StepDef;
}

/** Build and select a real synthesized judge whose policy originates on its producer. */
function seedSynthesizedJudge(x: Record<string, unknown>): StepDef {
  const def = buildDef({
    name: DEF,
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [{
      name: 'researcher',
      consumes: ['question'],
      produces: [{
	name: 'report',
	judges: [{ name: 'completeness', body: TEMPLATE, model: 'judge-model' }],
      }],
      x,
    }],
  });
  verifiedStep = def.steps.find((step) => step.name.endsWith('.completeness'))!;
  return verifiedStep;
}

beforeEach(() => {
  verifiedStep = undefined;
  verifiedBundleDir = undefined;
  savedEnv = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'owenloop-agentrun-home-'));
  cacheDir = join(home, 'cache');
  process.env['HOME'] = home;
  delete process.env['OWENLOOP_CONFIG_DIR'];
  delete process.env['XDG_CONFIG_HOME'];
  mkdirSync(join(home, '.owenloop'), { recursive: true });
  writeFileSync(
    join(home, '.owenloop', 'settings.json'),
    JSON.stringify({ roster: { build: [{ harness: 'fake', model: 'test-model', effort: 'high' }] } }),
  );
  process.env['OWENLOOP_CACHE_DIR'] = cacheDir;
  delete process.env['OWENLOOP_BUNDLE_DIR'];
  delete process.env['OWENLOOP_TOKEN'];
  delete process.env['OWENLOOP_ACCOUNT'];
  delete process.env['OWENLOOP_SHIFT_ID'];
  delete process.env['OWENLOOP_HARNESS_MODULE'];
  process.env['OWENLOOP_NO_KEYCHAIN'] = '1';
});
afterEach(() => {
  process.env = savedEnv;
  for (const id of registeredIds.splice(0)) unregister(id);
  makeTreeWritable(home);
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
  // Authored step instructions came from the injected verified-store resolver;
  // agent-run no longer asks the transport for a definition name.
  assert.deepEqual(whatsNextArgs, []);
  // Submitted closes via the hub outcome — the runner must NOT release.
  assert.equal(releases.length, 0);
  // One start, no deliver: a fresh attempt is a cold start.
  assert.deepEqual(fake.calls.map((c) => c.kind), ['start', 'stop']);
});

test('run() exposes the verified bundle directory and clears stale provenance', async () => {
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle();
  verifiedBundleDir = join(home, 'installed-bundle');
  process.env['OWENLOOP_BUNDLE_DIR'] = '/stale/bundle';

  const firstHub = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });
  assert.equal(
    await run(WIRE, {
      hub: firstHub.hub,
      signalHost: fakeSignalHost().host,
      holderId: 'host:123',
      cwd: '/work',
      out: () => {},
      err: () => {},
    }),
    0,
  );
  assert.equal(process.env['OWENLOOP_BUNDLE_DIR'], verifiedBundleDir);

  verifiedBundleDir = undefined;
  const secondHub = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });
  assert.equal(
    await run(WIRE, {
      hub: secondHub.hub,
      signalHost: fakeSignalHost().host,
      holderId: 'host:123',
      cwd: '/work',
      out: () => {},
      err: () => {},
    }),
    0,
  );
  assert.equal('OWENLOOP_BUNDLE_DIR' in process.env, false);
});

test('run() sets agent child identity and overrides ambient values in a real spawn', async () => {
  const workflow = 'wf-agent-identity';
  const runId = 'run-agent-identity';
  const savedWorkflow = process.env['OWENLOOP_WORKFLOW'];
  const savedRun = process.env['OWENLOOP_RUN'];
  process.env['OWENLOOP_WORKFLOW'] = 'wf-ambient-leak';
  process.env['OWENLOOP_RUN'] = 'run-ambient-leak';

  try {
    const probe = spawningEnvProbe();
    useAdapter(probe.adapter);
    writeRoster({ build: [{ harness: 'env-probe', model: 'test-model', effort: 'high' }] });
    seedBundle();
    const { hub } = probeHub({
      responses: [agentOrder({ workflow, run: runId }), agentOrder({ workflow, run: runId, outcome: 'ok' })],
      def: DEF,
    });

    const code = await run(
      [`${workflow}/${runId}`, '--origin', 'https://hub.example', '--confirm-interval', '1', '--submit-grace', '2000'],
      { hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: () => {} },
    );

    assert.equal(code, 0);
    assert.deepEqual(probe.observed, [JSON.stringify({ workflow, run: runId })]);
  } finally {
    if (savedWorkflow === undefined) delete process.env['OWENLOOP_WORKFLOW'];
    else process.env['OWENLOOP_WORKFLOW'] = savedWorkflow;
    if (savedRun === undefined) delete process.env['OWENLOOP_RUN'];
    else process.env['OWENLOOP_RUN'] = savedRun;
  }
});

// D10, and the exact boundary of what Phase 4 fixed: the mount is a bare
// `owenloop work hold --mcp` argv. The mounted work-holder resolves its own
// credential from the store, so no token may appear in the argv the harness
// child will see.
//
// STRIPPING `OWENLOOP_TOKEN` FROM THE CHILD ENV IS NOT DONE HERE EITHER — it is
// done in the adapters, by `filterOwenloopEnv` (`src/harness/child-env.ts`), and
// is asserted in `test/child-env.test.ts`, `test/harness-claude.test.ts` and
// `test/harness-codex.test.ts`. What this file owns is the RUNNER-SIDE half of
// that Phase 6 change: because the harness child can no longer see the
// override, `agent-run` ignores it too, so both sides authenticate as the same
// principal instead of splitting apart mid-order. The third sibling assertion —
// that the rejection delta and the replay brief carry no credential material —
// lives in `test/agent-rejection.test.ts`.
test('run() builds an MCP mount whose args carry no credential', async () => {
  process.env['OWENLOOP_TOKEN'] = 'olp_secret_value';
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle();
  const { hub } = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });

  const err: string[] = [];
  const code = await run([...WIRE, '--shift', 'shf_1'], {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work',
    out: () => {}, err: (l) => err.push(l),
  });
  assert.equal(code, 0);

  const started = fake.calls.find((c) => c.kind === 'start');
  assert.ok(started !== undefined && started.kind === 'start');
  const mcp = started.args.owenloopMcp;
  assert.deepEqual(mcp, {
    command: process.execPath,
    // `--never-release`: agent-run's own exec loop is the holder of record, so
    // this child must never hand the claim back (see buildOwenloopMcp).
    args: [resolveOwenloopBin(), 'work', 'hold', '--order', 'wf1/run1', '--origin', 'https://hub.example', '--as', 'default', '--shift=shf_1', '--mcp', '--never-release'],
  });
  const flat = JSON.stringify(mcp);
  assert.ok(!flat.includes('olp_secret_value'), flat);
  assert.ok(!flat.includes('Bearer'), flat);
  assert.ok(!/--token|OWENLOOP_TOKEN/.test(flat), flat);

  // D10(b), CLOSED in Phase 6: the override is not warned about, it is IGNORED,
  // and the message says what to do instead. Both halves are asserted, because a
  // message that announced the change without making it would be worse than the
  // old warning.
  const stderr = err.join('\n');
  assert.match(stderr, /OWENLOOP_TOKEN is set and is being IGNORED here/);
  assert.match(stderr, /owenloop login --hub/, 'the message must name the actionable alternative');
});

/**
 * PHASE 6 ITEM 5, the runner-side half, asserted on the SEAM rather than on a
 * log line: what `agent-run` hands to `resolveBearer`.
 *
 * The consequence being prevented is a split brain. The harness child cannot see
 * `OWENLOOP_TOKEN` any more, so if the runner still honoured it the runner would
 * authenticate to the hub as the override's principal while the child fell back
 * to the `agent:<account>` credential slot — and an empty slot would surface as
 * an opaque MCP handshake failure mid-order rather than as a refusal at startup.
 *
 * This test drives the real `run()` with no injected hub, so the real
 * `resolveBearer` runs against an empty credential store. The proof is the exit
 * code: 2 (`resolveBearer`'s startup refusal) and NOT 0, which is what a runner
 * that still honoured the override would return.
 */
test('run() ignores OWENLOOP_TOKEN when resolving its own bearer, and refuses at startup', async () => {
  process.env['OWENLOOP_TOKEN'] = 'olp_secret_value';
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
  assert.match(err.join('\n'), /OWENLOOP_TOKEN is set and is being IGNORED here/);
});

async function runMalformedHarnessCarrier(x: Record<string, unknown>): Promise<{
  code: number;
  stderr: string;
  calls: string[];
  releases: unknown[];
}> {
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedRawStep(x);
  const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, {
    hub,
    signalHost: fakeSignalHost().host,
    holderId: 'host:123',
    cwd: '/work',
    out: () => {},
    err: (line) => err.push(line),
  });
  return { code, stderr: err.join('\\n'), calls: fake.calls.map((call) => call.kind), releases };
}

test('run() refuses a legacy harness carrier instead of dropping permissions', async () => {
  const result = await runMalformedHarnessCarrier({ 'claude-code': { tools: ['Read'], disallowedTools: ['Bash'], permissionMode: 'strict' } });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, [], 'the malformed carrier must never start a harness');
  assert.deepEqual(result.releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-template' }]);
  assert.match(result.stderr, /legacy 'x\.claude-code'.*rename/);
});

test('run() refuses a non-map x.harness carrier instead of dropping it', async () => {
  const result = await runMalformedHarnessCarrier({ harness: 'not-a-map' });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, [], 'the malformed carrier must never start a harness');
  assert.deepEqual(result.releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-template' }]);
  assert.match(result.stderr, /non-map x\.harness/);
});

test('run() refuses a non-string x.harness.id instead of selecting the default harness', async () => {
  const result = await runMalformedHarnessCarrier({ harness: { id: 42, tools: ['Read'] } });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, [], 'the malformed carrier must never start a harness');
  assert.deepEqual(result.releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-template' }]);
  assert.match(result.stderr, /non-string x\.harness\.id/);
});

test('run() refuses explicit empty and whitespace-only local harness ids instead of selecting the default', async () => {
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);

  for (const id of ['', ' \t ']) {
    seedRawStep({ harness: { id, tools: ['Read'] } });
    const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
    const err: string[] = [];
    const code = await run(WIRE, {
      hub,
      signalHost: fakeSignalHost().host,
      holderId: 'host:123',
      cwd: '/work',
      out: () => {},
      err: (line) => err.push(line),
    });

    assert.equal(code, 1, `explicit id ${JSON.stringify(id)} must fail closed`);
    assert.deepEqual(fake.calls, [], 'the default harness must never start for an invalid explicit id');
    assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-template' }]);
    assert.match(err.join('\n'), /empty or whitespace-only x\.harness\.id/);
  }
});

test('run() refuses invalid reserved fields in the verified local definition', async () => {
  const result = await runMalformedHarnessCarrier({
    harness: {
      id: 'fake',
      tools: ['Read'],
      disallowedTools: ['Read'],
      filesystem: 'root-everywhere',
      name: 'forbidden',
    },
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-template' }]);
  assert.match(result.stderr, /instruction refusal \(harness-policy\)/);
  assert.match(result.stderr, /filesystem must be one of/);
  assert.match(result.stderr, /'name' is generated and cannot be set/);
  assert.match(result.stderr, /tools and disallowedTools overlap: Read/);
});

test('run() renders the brief from the verified step and passes normalized permissions', async () => {
  const fake: FakeAdapter = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  // The local resolver supplies the verified step; the runner validates the raw
  // carrier and normalizes the permission bag before dispatch.
  seedBundle({ model: 'm-step', permissions: { tools: ['Read'], model: 'm-step', extensions: {} } });
  const { hub } = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });

  const code = await run([...WIRE, '--shift', 'shf_1'], {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: () => {},
  });
  assert.equal(code, 0);

  const started = fake.calls.find((c) => c.kind === 'start');
  assert.ok(started !== undefined && started.kind === 'start');
  // `endsWith`, not `equal`: `renderBrief` prepends engine-authored blocks (the
  // routing line, the submit contract) ahead of the authored body. What this
  // test guards is that the VERIFIED step body is what gets rendered and that
  // its four tokens are substituted — so the assertion is that the substituted
  // body is present, intact, and last.
  assert.ok(
    started.args.brief.endsWith('order: wf1/run1\norigin: https://hub.example\naccount: default\nshift: shf_1'),
    started.args.brief,
  );
  // The permissions are normalized from the verified local definition.
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

test('run() refuses unresolvable capability when every roster candidate is unavailable', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  writeRoster({ build: [{ harness: 'nope', model: 'test-model', effort: 'high' }] });
  seedBundle();
  const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
  const err: string[] = [];

  const code = await run(WIRE, {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: (l) => err.push(l),
  });

  assert.equal(code, 1);
  const text = err.join('\n');
  assert.match(text, /no crew roster row/);
  assert.match(text, /build/);
  // An unavailable candidate releases, so the hub can re-offer the order.
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'unresolvable-capability' }]);
});

test('run() resolves the roster layer selected by the order crew stamp', async () => {
  const fake = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle();
  mkdirSync(join(home, '.owenloop', 'crews'), { recursive: true });
  writeFileSync(
    join(home, '.owenloop', 'crews', 'delivery.json'),
    JSON.stringify({ roster: { build: [{ harness: 'fake', model: 'crew-model', effort: 'xhigh' }] } }),
  );
  const { hub } = probeHub({ responses: [agentOrder({ crews: ['delivery'] }), noHold('ok')], def: DEF });

  assert.equal(await run(WIRE, {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: () => {},
  }), 0);
  const start = fake.calls.find((call) => call.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  assert.equal(start.args.model, 'crew-model');
});

test('run() releases a stamped crew whose roster file is corrupt', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  seedBundle();
  mkdirSync(join(home, '.owenloop', 'crews'), { recursive: true });
  const crewPath = join(home, '.owenloop', 'crews', 'broken.json');
  writeFileSync(crewPath, '{ this is not json');
  const { hub, releases } = probeHub({ responses: [agentOrder({ crews: ['broken'] })], def: DEF });
  const err: string[] = [];

  assert.equal(await run(WIRE, {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: (line) => err.push(line),
  }), 1);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'unresolvable-crew' }]);
  assert.match(err.join('\n'), /broken/);
  assert.ok(err.join('\n').includes(crewPath));
});

test('run() ignores the deleted shift crew environment handoff', async () => {
  const fake = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle();
  mkdirSync(join(home, '.owenloop', 'crews'), { recursive: true });
  writeFileSync(
    join(home, '.owenloop', 'crews', 'stamped.json'),
    JSON.stringify({ roster: { build: [{ harness: 'fake', model: 'stamped-model', effort: 'high' }] } }),
  );
  process.env['OWENLOOP_SERVE_CREWS'] = 'ghost';
  const { hub } = probeHub({ responses: [agentOrder({ crews: ['stamped'] }), noHold('ok')], def: DEF });

  assert.equal(await run(WIRE, {
    hub, signalHost: fakeSignalHost().host, holderId: 'host:123', cwd: '/work', out: () => {}, err: () => {},
  }), 0);
  const start = fake.calls.find((call) => call.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  assert.equal(start.args.model, 'stamped-model');
});

test('blank --harness falls through to the selected roster candidate', async () => {
  const fake = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);
  seedBundle({ harness: 'fake' });

  for (const value of ['', ' \t ']) {
    const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });

    const code = await run([...WIRE, `--harness=${value}`], {
      hub,
      signalHost: fakeSignalHost().host,
      holderId: 'host:123',
      cwd: '/work',
      out: () => {},
      err: () => {},
    });

    assert.equal(code, 0, JSON.stringify(value));
    assert.equal(fake.calls.some((call) => call.kind === 'start'), true);
    assert.deepEqual(releases, []);
    fake.calls.length = 0;
  }
});

test('blank --harness with no selected roster candidate refuses without choosing the default', async () => {
  writeRoster({});
  seedBundle();
  const { hub, releases } = probeHub({ responses: [agentOrder({ capabilities: [] }), noHold('ok')], def: DEF });
  const err: string[] = [];

  const code = await run([...WIRE, '--harness='], {
    hub,
    signalHost: fakeSignalHost().host,
    holderId: 'host:123',
    cwd: '/work',
    out: () => {},
    err: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-harness' }]);
  assert.match(err.join('\n'), /no adapter registered for harness ''/);
});

test('roster-selected harness policy preflight refuses before start', async () => {
  const overridden = createFakeAdapter({ id: 'overridden' });
  overridden.preflight = (permissions) =>
    permissions.network === 'owenloop-only'
      ? [{ field: 'network', message: "network 'owenloop-only' is unsupported" }]
      : [];
  useAdapter(overridden);
  writeRoster({ build: [{ harness: 'overridden', model: 'test-model', effort: 'high' }] });
  seedRawStep({ harness: { id: 'overridden', network: 'owenloop-only' } });
  const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
  const err: string[] = [];

  const code = await run(WIRE, {
    hub,
    signalHost: fakeSignalHost().host,
    holderId: 'host:123',
    cwd: '/work',
    out: () => {},
    err: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(overridden.calls, []);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'incompatible-harness-policy' }]);
  assert.match(err.join('\n'), /harness policy refusal.*overridden.*network 'owenloop-only' is unsupported/);
});

test('selected Codex candidate refusal names the restriction and releases the held claim', async () => {
  process.env['OWENLOOP_CODEX_BIN'] = join(home, 'must-not-start');
  writeRoster({ build: [{ harness: 'codex', model: 'test-model', effort: 'high' }] });

  for (const filesystem of ['read-only', 'workspace-write'] as const) {
    seedRawStep({ harness: { id: 'codex', filesystem } });
    const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
    const err: string[] = [];

    const code = await run(WIRE, {
      hub,
      signalHost: fakeSignalHost().host,
      holderId: 'host:123',
      cwd: '/work',
      out: () => {},
      err: (line) => err.push(line),
    });

    assert.equal(code, 1, filesystem);
    assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'incompatible-harness-policy' }]);
    assert.match(
      err.join('\n'),
      new RegExp(
	`harness policy refusal.*codex.*filesystem '${filesystem}'.*unsupported.*configuration layers.*outside the thread sandbox`,
      ),
    );
  }
});

test('a roster-selected Codex candidate refuses inherited judge policy before startup', async () => {
  const judge = seedSynthesizedJudge({ harness: { id: 'codex', tools: [] } });
  process.env['OWENLOOP_CODEX_BIN'] = join(home, 'must-not-start');
  const packet = agentOrder({ step: judge.name, model: judge.model, x: judge.x });

  writeRoster({ build: [{ harness: 'codex', model: 'test-model', effort: 'high' }] });
  const { hub, releases } = probeHub({ responses: [packet, noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, {
    hub,
    signalHost: fakeSignalHost().host,
    holderId: 'host:123',
    cwd: '/work',
    out: () => {},
    err: (line) => err.push(line),
  });

  assert.equal(code, 1);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'incompatible-harness-policy' }]);
  assert.match(err.join('\n'), /harness policy refusal.*codex.*\(tools\): tool allow-lists are unsupported/);
});

test('selected roster candidates outrank CLI and step harnesses; CLI outranks the step harness', async () => {
  const chosen = createFakeAdapter({ id: 'chosen' });
  const other = createFakeAdapter({ id: 'other' });
  useAdapter(chosen);
  useAdapter(other);

  // The candidate wins even when the caller supplies a CLI fallback.
  writeRoster({ build: [{ harness: 'chosen', model: 'test-model', effort: 'high' }] });
  seedRawStep({});
  const a = probeHub({ responses: [agentOrder(), agentOrder({ outcome: 'ok' })], def: DEF });
  assert.equal(await run([...WIRE, '--harness', 'other'], { hub: a.hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: () => {} }), 0);
  assert.equal(chosen.calls.length > 0, true);
  assert.equal(other.calls.length, 0);

  // Without a candidate, the CLI fallback wins over the verified step harness.
  writeRoster({});
  seedBundle({ harness: 'other' });
  chosen.calls.length = 0;
  const b = probeHub({ responses: [agentOrder({ capabilities: [] }), agentOrder({ capabilities: [], outcome: 'ok' })], def: DEF });
  assert.equal(await run([...WIRE, '--harness', 'chosen'], { hub: b.hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: () => {} }), 0);
  assert.equal(chosen.calls.length > 0, true);
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

test('a bad OWENLOOP_HARNESS_MODULE is reported and does not crash the runner', async () => {
  process.env['OWENLOOP_HARNESS_MODULE'] = join(home, 'does-not-exist.mjs');
  const { hub } = probeHub({ responses: [noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 0); // first contact says the run is already done
  assert.match(err.join('\n'), /could not load OWENLOOP_HARNESS_MODULE/);
});

// ---- local instruction resolution --------------------------------------------

test('injected resolver preserves the no-template release when the order digest is not installed locally', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /unknown local workflow digest 'sha256:deadbeef'/);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-template' }]);
});

test('default agent wiring recovers a signed missing bundle before hosting the step', async () => {
  const sourceDir = writeBundleSource({
    name: 'recovered-agent',
    workflow: [
      'name: recovered-agent',
      'inputs:',
      '  - name: seed',
      '    seedOwed: true',
      'steps:',
      '  - name: builder',
      '    consumes: [seed]',
      '    produces: [out]',
      '    terminal: true',
      '    body: recovered agent brief',
      '    x:',
      '      harness:',
      '        id: fake',
      '        tools: [Read]',
      '',
    ].join('\n'),
  });
  const signed = await installSignedBundleFixture({ sourceDir, root: join(home, 'remote-publication'), home });
  assert.equal(signed.source.kind, 'file');
  const publication = readFileSync(`${signed.source.path}.dsse`);
  const auths: string[] = [];
  const responses = [agentOrder({ defDigest: signed.packed.digest }), noHold('ok')];
  let getOrderCalls = 0;
  const server = createServer((req, res) => {
    auths.push(req.headers.authorization ?? '');
    if (req.method === 'POST' && req.url === '/api/get_order') {
      const response = responses[Math.min(getOrderCalls++, responses.length - 1)]!;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '' }));
      return;
    }
    if (req.url === `/api/bundles/${signed.packed.digest}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(signed.packed.bytes);
      return;
    }
    if (req.url === `/api/publications/${signed.packed.digest}`) {
      res.writeHead(200, { 'x-owenloop-publication-state': 'signed' });
      res.end(publication);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  seedAgentCredential(home, origin, 'agent-recovery-token');
  const fake = createFakeAdapter({ id: 'fake' });
  useAdapter(fake);

  try {
    const code = await roleRun(['wf1/run1', '--origin', origin, '--confirm-interval', '1', '--submit-grace', '2000'], {
      signalHost: fakeSignalHost().host,
      holderId: 'agent-recovery-host',
      cwd: '/work',
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(fake.calls.map((call) => call.kind), ['start', 'stop']);
    assert.equal(getOrderCalls, 2, 'the role-owned production client contacted the worker before and after the turn');
    assert.equal(auths.every((auth) => auth === 'Bearer agent-recovery-token'), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('default agent wiring preserves no-template when recovery fails verification', async () => {
  const responses = [agentOrder({ defDigest: 'a'.repeat(64) }), noHold('ok')];
  let getOrderCalls = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/get_order') {
      const response = responses[Math.min(getOrderCalls++, responses.length - 1)]!;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  seedAgentCredential(home, origin, 'agent-recovery-token');
  const err: string[] = [];

  try {
    const code = await roleRun(['wf1/run1', '--origin', origin], {
      signalHost: fakeSignalHost().host,
      holderId: 'agent-recovery-host',
      cwd: '/work',
      out: () => {},
      err: (line) => err.push(line),
    });
    assert.equal(code, 1, 'the loop keeps its no-template failure outcome');
    assert.match(err.join('\n'), /instruction refusal \(integrity\).*HTTP 404/u);
    assert.equal(getOrderCalls, 1, 'failed resolution releases without waiting for a confirmation poll');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an injected hub builds the default resolver without requiring an agent credential', async () => {
  const { hub, releases } = probeHub({ responses: [agentOrder(), noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await roleRun(WIRE, {
    hub,
    signalHost: fakeSignalHost().host,
    holderId: 'embedded-host',
    cwd: '/work',
    out: () => {},
    err: (line) => err.push(line),
  });
  assert.equal(code, 1, 'the injected transport does not force a credential lookup before local resolution');
  assert.match(err.join('\n'), /instruction refusal \(unknown-digest\).*no verified local workflow bundle matches/u);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'no-template' }]);
});

test('run() exits 1 when the order has no definition digest', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  const { hub } = probeHub({ responses: [agentOrder({ defDigest: '' }), noHold('ok')] });
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /the order has no definition digest/);
});

// ---- misroute + signal wiring ----------------------------------------------

test('run() releases a COMMAND order as a misroute and exits 1', async () => {
  useAdapter(createFakeAdapter({ id: 'fake' }));
  seedBundle();
  const { hub, releases } = probeHub({ responses: [agentOrder({ worker: 'command' }), noHold('ok')], def: DEF });
  const err: string[] = [];
  const code = await run(WIRE, { hub, signalHost: fakeSignalHost().host, holderId: 'h:1', cwd: '/w', out: () => {}, err: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /is not an agent order \(misroute\)/);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'misroute' }]);
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
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1', reason: 'signal' }]);
});
