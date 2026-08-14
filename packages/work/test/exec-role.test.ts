import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { parseArgs, exitCodeFor, run as roleRun, type RunDeps } from '../src/roles/exec.ts';
import type { InstructionResolver } from '../src/exec/instructions.ts';
import type { ExecOutcome } from '../src/exec/loop.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';
import type { CommandResult, CommandRunner } from '../src/exec/runner.ts';
import type { CommandReceipt } from '../src/exec/receipt.ts';
import type { SignalHost } from '../src/roles/signals.ts';

/**
 * Seed a hermetic owenloop v2 credential file at `<configHome>/owenloop/
 * credentials.json`, storing `token` in the `agent:<account>` slot for `origin`
 * — the real file backend `readStoredCredential` reads under OWENLOOP_NO_KEYCHAIN.
 */
function seedAgentKeys(configHome: string, origin: string, slots: Record<string, string>): void {
  const dir = join(configHome, 'owenloop');
  mkdirSync(dir, { recursive: true });
  const hubs: Record<string, Record<string, unknown>> = { [origin]: {} };
  for (const [account, token] of Object.entries(slots)) {
    hubs[origin]![`agent:${account}`] = { kind: 'agent', accessToken: token };
  }
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 2, hubs }));
}

/**
 * A throwaway hub that records the Authorization header of each POST /api/get_order
 * and answers with a first-contact-completed order (no runner spawned, exit 0).
 */
function startRecordingHub(): Promise<{ server: Server; origin: string; auths: string[] }> {
  const auths: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/get_order') {
        auths.push(req.headers['authorization'] ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: '', workflow: 'wf1', run: 'run1', order: null, lease: { claimed: false, outcome: 'ok' } }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}`, auths });
    });
  });
}

// ---- arg parsing ------------------------------------------------------------

test('parseArgs reads the positional order-id, both flag value forms, and defaults', () => {
  const p = parseArgs(['wf1/run1', '--origin=https://h', '--heartbeat-interval', '1500']);
  assert.equal(p.error, undefined);
  assert.equal(p.orderId, 'wf1/run1');
  assert.equal(p.origin, 'https://h');
  assert.equal(p.heartbeatIntervalMs, 1500);
});

test('parseArgs pairs a bare run id with --workflow', () => {
  const p = parseArgs(['run1', '--workflow', 'wf1']);
  assert.equal(p.orderId, 'run1');
  assert.equal(p.workflow, 'wf1');
});

test('parseArgs rejects a second positional and an unknown option', () => {
  assert.match(parseArgs(['a', 'b']).error!, /unexpected extra argument 'b'/);
  assert.match(parseArgs(['a', '--bogus']).error!, /unknown option '--bogus'/);
});

test('parseArgs rejects a non-positive / non-integer interval', () => {
  assert.match(parseArgs(['a', '--heartbeat-interval', '0']).error!, /positive integer/);
  assert.match(parseArgs(['a', '--heartbeat-interval', 'abc']).error!, /positive integer/);
  assert.match(parseArgs(['a', '--heartbeat-interval']).error!, /missing value/);
});

// --jump-tolerance is the WO-6.1 test affordance: it exposes the lease loop's
// existing jumpToleranceMs knob (default unchanged) so drill 5 can trip the
// clock-jump lease check with a short freeze instead of a real >30s sleep.
test('parseArgs reads --jump-tolerance and validates it like the interval', () => {
  assert.equal(parseArgs(['wf1/run1', '--jump-tolerance', '300']).jumpToleranceMs, 300);
  assert.equal(parseArgs(['wf1/run1', '--jump-tolerance=300']).jumpToleranceMs, 300);
  assert.equal(parseArgs(['wf1/run1']).jumpToleranceMs, undefined); // default: loop's 30_000
  assert.match(parseArgs(['a', '--jump-tolerance', '0']).error!, /positive integer/);
  assert.match(parseArgs(['a', '--jump-tolerance', 'abc']).error!, /positive integer/);
  assert.match(parseArgs(['a', '--jump-tolerance']).error!, /missing value/);
});

// W7: --shift both value forms, and its absence defaults to undefined.
test('parseArgs reads --shift, both value forms', () => {
  assert.equal(parseArgs(['wf1/run1', '--shift', 'shf_a']).shift, 'shf_a');
  assert.equal(parseArgs(['wf1/run1', '--shift=shf_b']).shift, 'shf_b');
  assert.equal(parseArgs(['wf1/run1']).shift, undefined);
});

// ---- exit-code mapping ------------------------------------------------------

test('exitCodeFor maps every outcome to the documented code', () => {
  const zero: ExecOutcome[] = ['submitted', 'completed', 'rejected', 'judge-rejected'];
  const one: ExecOutcome[] = ['misroute', 'unresolved-instructions', 'killed', 'lease-lost', 'ownership-error', 'hub-unreachable', 'submit-rejected', 'submit-failed', 'judge-no-verdict', 'reject-failed', 'stopped'];
  for (const o of zero) assert.equal(exitCodeFor(o), 0);
  for (const o of one) assert.equal(exitCodeFor(o), 1);
});

// ---- run() usage + resolution exits (no network) ----------------------------

let home: string;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'owenloop-exec-home-'));
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = home;
  delete process.env['OWENLOOP_TOKEN'];
  delete process.env['OWENLOOP_ACCOUNT'];
  delete process.env['OWENLOOP_SHIFT_ID'];
  // Hermetic credential store: force owenloop's file backend (no real keychain
  // shell-out) so an unseeded store reads as absent → the refuse path.
  process.env['OWENLOOP_NO_KEYCHAIN'] = '1';
});
afterEach(() => {
  process.env = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

test('run() exits 2 on a missing order-id', async () => {
  assert.equal(await run([]), 2);
});

test('run() exits 2 on a bare run id with no --workflow', async () => {
  assert.equal(await run(['run1', '--origin', 'https://hub.example']), 2);
});

test('run() exits 2 on a bad --heartbeat-interval', async () => {
  assert.equal(await run(['wf1/run1', '--heartbeat-interval', 'nope']), 2);
});

test('run() exits 2 when no hub origin is resolvable', async () => {
  assert.equal(await run(['wf1/run1']), 2);
});

test('run() refuses the default instruction resolver when HOME and USERPROFILE are both missing', async () => {
  const err: string[] = [];
  const env = { ...process.env, HOME: '', USERPROFILE: '' };
  const code = await roleRun(['wf1/run1', '--origin', 'https://hub.example'], {
    env,
    err: (line) => err.push(line),
  });
  assert.equal(code, 1);
  assert.match(err.join('\\n'), /instruction store unavailable: cannot locate the global workflow store: set HOME or USERPROFILE/);
});

test('run() exits 2 with the refuse message when no Scoped Identity key is stored', async () => {
  // No OWENLOOP_TOKEN override + a hermetic empty file store (temp HOME/XDG,
  // OWENLOOP_NO_KEYCHAIN forces the file backend) ⇒ the agent slot is absent.
  const err: string[] = [];
  const code = await run(['wf1/run1', '--origin', 'https://hub.example'], { err: (l) => err.push(l) });
  assert.equal(code, 2);
  assert.match(
    err.join('\n'),
    /no Scoped Identity key for https:\/\/hub\.example \(account "default"\) — run: owenloop login --hub https:\/\/hub\.example --as agent/,
  );
});

// ---- run() wiring: fake hub + fake runner (no network, no child) ------------

interface OrderOpts {
  command?: string;
  claimed?: boolean;
  outcome?: string;
}

const testCommands = new Map<string, string>();
let nextTestDigest = 0;

function commandOrder(o: OrderOpts = {}): GetOrderResponse {
  const defDigest = `test-role-digest-${++nextTestDigest}`;
  testCommands.set(defDigest, o.command ?? 'echo hi');
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
      worker: 'command',
      defDigest,
      consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    },
    lease: { claimed: o.claimed ?? true, ...(o.outcome !== undefined ? { outcome: o.outcome } : {}) },
  };
}

const testInstructions = (): InstructionResolver => ({
  resolveCommand: async (order) => ({ ok: true, command: testCommands.get(order.defDigest) ?? 'echo hi' }),
  resolveStep: async () => ({ ok: false, kind: 'unknown-step', reason: 'step resolution is not used by exec role tests' }),
});

const run = (args: string[], deps: RunDeps = {}): Promise<number> =>
  roleRun(args, { instructions: testInstructions(), ...deps });

function roleHub(cfg: { getOrder: GetOrderResponse; onHeartbeat?: (n: number) => void; submitOutcome?: string }): {
  hub: HubClient;
  getOrderArgs: unknown[];
  submits: unknown[];
  submitReqs: unknown[];
  releases: unknown[];
} {
  const getOrderArgs: unknown[] = [];
  const submits: unknown[] = [];
  const submitReqs: unknown[] = [];
  const releases: unknown[] = [];
  let hbIdx = 0;
  const hub: HubClient = {
    async getOrder(req) {
      getOrderArgs.push(req);
      return cfg.getOrder;
    },
    async heartbeat() {
      cfg.onHeartbeat?.(hbIdx++);
      return { text: '' };
    },
    async release(req) {
      releases.push(req);
      return { text: '' };
    },
    async submit(req) {
      submits.push(req.value);
      submitReqs.push(req);
      return { text: '', outcome: cfg.submitOutcome ?? 'green' };
    },
    async whatsNext() {
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
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
  return { hub, getOrderArgs, submits, submitReqs, releases };
}

function fixedResult(exitCode: number | null): CommandResult {
  return { exitCode, outputHash: 'sha256:x', stdoutBytes: 0, stderrBytes: 0, outputTail: '', startedAt: 0, finishedAt: 1, durationMs: 1 };
}
/** A runner whose command settles immediately with the given exit code. */
function immediateRunner(exitCode: number): CommandRunner {
  return { start: () => ({ done: Promise.resolve(fixedResult(exitCode)), kill: async () => {} }) };
}
/** A runner whose command never settles (for the signal path). */
function neverRunner(state: { kills: number }): CommandRunner {
  return { start: () => ({ done: new Promise<CommandResult>(() => {}), kill: async () => void state.kills++ }) };
}

function fakeSignalHost(): { host: SignalHost; exits: number[]; registered: string[]; emit: (sig: 'SIGINT' | 'SIGTERM') => void } {
  const handlers: Record<string, Array<() => void>> = { SIGINT: [], SIGTERM: [] };
  const exits: number[] = [];
  const registered: string[] = [];
  const host: SignalHost = {
    on(sig, h) {
      registered.push(sig);
      handlers[sig]!.push(h);
      return host;
    },
    exit(code) {
      exits.push(code);
    },
  };
  return { host, exits, registered, emit: (sig) => { for (const h of [...handlers[sig]!]) h(); } };
}

const WIRE_ARGS = ['wf1/run1', '--origin', 'https://hub.example', '--heartbeat-interval', '5'];

test('run() happy path: tags the exec holder, runs, submits a receipt, exits 0', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  const { hub, getOrderArgs, submits, releases } = roleHub({ getOrder: commandOrder({ command: 'make build' }) });
  const sig = fakeSignalHost();

  const code = await run(WIRE_ARGS, {
    hub,
    runner: immediateRunner(0),
    signalHost: sig.host,
    holderId: 'host:123',
    cwd: '/work',
    out: () => {},
    err: () => {},
  });

  assert.equal(code, 0);
  // Both SIGINT and SIGTERM are wired.
  assert.deepEqual(sig.registered.sort(), ['SIGINT', 'SIGTERM']);
  // The exec holder tag rode first contact.
  assert.deepEqual((getOrderArgs[0] as { holder?: unknown }).holder, { kind: 'exec', id: 'host:123' });
  // One receipt landed; the run closed via submit (no release).
  assert.equal(submits.length, 1);
  assert.equal((submits[0] as CommandReceipt).command, 'make build');
  assert.equal((submits[0] as CommandReceipt).orchestrator, 'host:123');
  assert.equal(releases.length, 0);
});

// W7: --shift rides the exec holder on BOTH first contact (get_order) and
// the receipt submit — the hub's attribution columns need it on every path,
// not just get_order (advisory only, D8/INV-82).
test('run() threads --shift onto the exec holder for both get_order and submit', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  const { hub, getOrderArgs, submitReqs } = roleHub({ getOrder: commandOrder({ command: 'make build' }) });
  const sig = fakeSignalHost();

  const code = await run([...WIRE_ARGS, '--shift', 'shf_abc'], {
    hub,
    runner: immediateRunner(0),
    signalHost: sig.host,
    holderId: 'host:123',
    cwd: '/work',
    out: () => {},
    err: () => {},
  });

  assert.equal(code, 0);
  assert.deepEqual((getOrderArgs[0] as { holder?: unknown }).holder, { kind: 'exec', id: 'host:123', shiftId: 'shf_abc' });
  assert.deepEqual((submitReqs[0] as { holder?: unknown }).holder, { kind: 'exec', id: 'host:123', shiftId: 'shf_abc' });
});

// W7: OWENLOOP_SHIFT_ID env is the fallback when --shift is absent.
test('run() falls back to OWENLOOP_SHIFT_ID when --shift is absent', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  process.env['OWENLOOP_SHIFT_ID'] = 'shf_env';
  const { hub, getOrderArgs } = roleHub({ getOrder: commandOrder({ command: 'make build' }) });
  const sig = fakeSignalHost();

  const code = await run(WIRE_ARGS, {
    hub,
    runner: immediateRunner(0),
    signalHost: sig.host,
    holderId: 'host:123',
    cwd: '/work',
    out: () => {},
    err: () => {},
  });

  assert.equal(code, 0);
  assert.deepEqual((getOrderArgs[0] as { holder?: unknown }).holder, { kind: 'exec', id: 'host:123', shiftId: 'shf_env' });
});

test('run() maps a first-contact completed order to exit 0 without running anything', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  let started = 0;
  const { hub } = roleHub({ getOrder: commandOrder({ claimed: false, outcome: 'ok' }) });
  const runner: CommandRunner = { start: () => { started++; return { done: Promise.resolve(fixedResult(0)), kill: async () => {} }; } };
  const code = await run(WIRE_ARGS, { hub, runner, signalHost: fakeSignalHost().host, out: () => {}, err: () => {} });
  assert.equal(code, 0);
  assert.equal(started, 0);
});

test('run() signal wiring: exec message line, SIGINT mid-run kills + releases, exits 1', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  const sig = fakeSignalHost();
  const killState = { kills: 0 };
  const { hub, releases, submits } = roleHub({
    getOrder: commandOrder(),
    onHeartbeat: (n) => {
      if (n === 0) sig.emit('SIGINT');
    },
  });
  const err: string[] = [];

  const code = await run(WIRE_ARGS, {
    hub,
    runner: neverRunner(killState),
    signalHost: sig.host,
    out: () => {},
    err: (line) => err.push(line),
  });

  assert.equal(code, 1); // killed
  assert.ok(err.includes('owenloop work exec: SIGINT received — killing the command and releasing the order'), err.join('\n'));
  assert.ok(killState.kills >= 1);
  assert.equal(submits.length, 0);
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1' }]);
});

// ---- store-backed success (no OWENLOOP_TOKEN — the primary path) -------------
// These run WITHOUT an injected hub: the role builds a REAL client whose getToken
// resolves the agent slot from the seeded store, and the mock hub answers first
// contact with a completed order (exit 0, no child spawned) while recording auth.

test('with no OWENLOOP_TOKEN, exec authenticates with the agent slot token from the store', async () => {
  const { server, origin, auths } = await startRecordingHub();
  seedAgentKeys(home, origin, { default: 'olp_from_store' });
  try {
    const code = await run(['wf1/run1', '--origin', origin, '--heartbeat-interval', '5'], { out: () => {}, err: () => {} });
    assert.equal(code, 0);
    assert.deepEqual(auths, ['Bearer olp_from_store']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('OWENLOOP_ACCOUNT selects a different agent slot (ci token, not default)', async () => {
  const { server, origin, auths } = await startRecordingHub();
  seedAgentKeys(home, origin, { default: 'tok_default', ci: 'tok_ci' });
  process.env['OWENLOOP_ACCOUNT'] = 'ci';
  try {
    const code = await run(['wf1/run1', '--origin', origin, '--heartbeat-interval', '5'], { out: () => {}, err: () => {} });
    assert.equal(code, 0);
    assert.deepEqual(auths, ['Bearer tok_ci']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
