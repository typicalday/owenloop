import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { dsseVerifySubmission, valueDigestHex } from '../../../src/crypto/index.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { resetSshKeygenProbe } from '../../../src/crypto/ssh.ts';
import type { SshProcessAdapter } from '../../../src/crypto/ssh.ts';
import {
  createExecLoop,
  CONSUMES_INLINE_MAX_BYTES,
  type ExecLoop,
  type ExecLoopOptions,
  type ExecOutcome,
} from '../src/exec/loop.ts';
import { resetSubmitProofWarningForTests, type SubmissionKeyManager } from '../src/submit-proof.ts';
import { HubError, type ContactHolder, type GetOrderResponse } from '../src/hub/types.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { CommandResult, CommandRunner, RunningCommand } from '../src/exec/runner.ts';
import type { CommandReceipt } from '../src/exec/receipt.ts';
import type { InstructionResolver } from '../src/exec/instructions.ts';

// ---- fakes ------------------------------------------------------------------

interface Call {
  verb: string;
  arg?: unknown;
}
interface SubmitCall {
  path: string;
  value: unknown;
  holder?: ContactHolder;
  proof?: string;
}

const EXEC: ContactHolder = { kind: 'exec', id: 'host:123' };
const PUB_TEXT = readFileSync(new URL('../../../test/fixtures/crypto/fixture-key.pub', import.meta.url), 'utf8');
const PUBLIC_KEY = publicKeyDescriptor(PUB_TEXT);
const SIGNING_REF = { origin: 'https://hub.example.test', kind: 'machine' as const, id: 'local' };
const ARMOR = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';

function signingKeys(path = '/fake/private-key'): SubmissionKeyManager {
  return {
    resolveRef: () => SIGNING_REF,
    inspect: async () => ({ exists: true, source: 'generated', backend: 'file', publicKey: PUBLIC_KEY }),
    withSigningKey: async (_ref, callback) => callback(path),
  };
}

function fakeSshProcess(calls: Array<{ cmd: string; args: string[]; stdin?: Buffer }>): SshProcessAdapter {
  return {
    probe: () => ({ status: 255, stderr: Buffer.from('No principal matched\\n') }),
    async run(cmd, args, opts) {
      calls.push({ cmd, args, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
      if (args[0] === '-y' && args[1] === '-f') {
        return { status: 0, stdout: Buffer.from(PUB_TEXT), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
      }
      return { status: 0, stdout: Buffer.from(ARMOR), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
    },
  };
}

afterEach(() => {
  resetSubmitProofWarningForTests();
  resetSshKeygenProbe();
});
const macrotaskSleep = (): Promise<void> => new Promise((r) => setImmediate(r));

interface OrderOpts {
  command?: string;
  worker?: string;
  judge?: string;
  workdir?: string;
  owes?: string[];
  claimed?: boolean;
  outcome?: string;
  modifier?: string;
  reasons?: Array<{ at: number; action: string; kind: string; by: string; text: string; requested?: string }>;
}

const testCommands = new Map<string, string>();
let nextTestDigest = 0;

/** A get_order response carrying a reference-mode command order packet. */
function commandOrder(o: OrderOpts = {}): GetOrderResponse {
  const paths = o.owes ?? ['out'];
  const defDigest = `test-digest-${++nextTestDigest}`;
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
      ...(o.workdir !== undefined ? { workdir: o.workdir } : {}),
      worker: o.worker ?? 'command',
      ...(o.modifier !== undefined ? { modifier: o.modifier } : {}),
      ...(o.judge !== undefined ? { judge: o.judge } : {}),
      defDigest,
      consumes: {},
      // `version` is the hub-issued TARGET for the next commit, so a
      // never-produced output's first target is 1, not 0.
      owes: paths.map((path) => ({ path, version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: o.reasons ?? [] })),
    },
    lease: { claimed: o.claimed ?? true, ...(o.outcome !== undefined ? { outcome: o.outcome } : {}) },
  };
}

const testInstructions = (): InstructionResolver => ({
  resolveCommand: async (order) => ({ ok: true, command: testCommands.get(order.defDigest) ?? 'echo hi' }),
  resolveStep: async () => ({ ok: false, kind: 'unknown-step', reason: 'step resolution is not used by exec tests' }),
});

function refusingInstructions(kind: 'unknown-digest' | 'unknown-step' | 'integrity' | 'no-digest' | 'missing-command'): InstructionResolver {
  return {
    resolveCommand: async () => ({
      ok: false,
      kind,
      reason: `instruction refusal (${kind})`,
    }),
    resolveStep: async () => ({
      ok: false,
      kind: 'unknown-step',
      reason: 'step resolution is not used by exec tests',
    }),
  };
}

/** A get_order response with a non-command / null packet (a misroute). */
function nonCommandOrder(order: GetOrderResponse['order'], lease?: Partial<GetOrderResponse['lease']>): GetOrderResponse {
  return { text: '', workflow: 'wf1', run: 'run1', order, lease: { claimed: true, ...lease } };
}

interface MockCfg {
  getOrder: Array<GetOrderResponse | Error> | ((n: number) => GetOrderResponse);
  heartbeat?: (n: number) => void;
  submit?: Array<string | Error>;
  reject?: Array<{ ok?: boolean; closed?: boolean; text?: string } | Error>;
  ask?: Array<{ ok?: boolean; closed?: boolean; text?: string } | Error>;
  release?: () => Promise<{ text: string }>;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[]; submits: SubmitCall[] } {
  const calls: Call[] = [];
  const submits: SubmitCall[] = [];
  let goIdx = 0;
  let hbIdx = 0;
  let subIdx = 0;
  let rejectIdx = 0;
  let askIdx = 0;

  const hub: HubClient = {
    async getOrder(req) {
      calls.push({ verb: 'get_order', arg: req });
      const s = cfg.getOrder;
      const item = Array.isArray(s) ? s[Math.min(goIdx, s.length - 1)]! : s(goIdx);
      goIdx++;
      if (item instanceof Error) throw item;
      return item;
    },
    async heartbeat(req) {
      calls.push({ verb: 'heartbeat', arg: req });
      cfg.heartbeat?.(hbIdx++);
      return { text: '' };
    },
    async release(req) {
      calls.push({ verb: 'release', arg: req });
      return cfg.release !== undefined ? cfg.release() : { text: '' };
    },
    async submit(req) {
      calls.push({ verb: 'submit', arg: req });
      submits.push({ path: req.path, value: req.value, holder: req.holder, ...(req.proof !== undefined ? { proof: req.proof } : {}) });
      const s = cfg.submit ?? ['green'];
      const item = s[Math.min(subIdx, s.length - 1)]!;
      subIdx++;
      if (item instanceof Error) throw item;
      return { text: `submit ${item}`, outcome: item };
    },
    async whatsNext() {
      return { text: '' };
    },
    async reject(req) {
      calls.push({ verb: 'reject', arg: req });
      const s = cfg.reject ?? [{ ok: true }];
      const item = s[Math.min(rejectIdx, s.length - 1)]!;
      rejectIdx++;
      if (item instanceof Error) throw item;
      return { text: item.text ?? 'reject', ok: item.ok ?? true, ...(item.closed !== undefined ? { closed: item.closed } : {}) };
    },
    async ask(req) {
      calls.push({ verb: 'ask', arg: req });
      const s = cfg.ask ?? [{ ok: true, closed: true }];
      const item = s[Math.min(askIdx, s.length - 1)]!;
      askIdx++;
      if (item instanceof Error) throw item;
      return { text: item.text ?? 'ask', ok: item.ok ?? true, ...(item.closed !== undefined ? { closed: item.closed } : {}) };
    },
    // The tool-approval gate is not exercised by these tests; a fake that never
    // opens an approval, and a non-answer is a denial.
    async requestApproval() { return { text: '', ok: false }; },
    async answerApproval() { return { text: '', ok: false }; },
    async listPendingApprovals() { return { text: '', approvals: [] }; },
    async reportResolution(req) {
      calls.push({ verb: 'report_resolution', arg: req });
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
  return { hub, calls, submits };
}

// ---- fake runner ------------------------------------------------------------

function result(exitCode: number | null, extra: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode,
    outputHash: 'sha256:beef',
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTail: '',
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    ...extra,
  };
}

interface FakeRunner {
  runner: CommandRunner;
  starts: Array<{ command: string; cwd: string; env?: Record<string, string | undefined> }>;
  state: { kills: number };
  resolve: (r: CommandResult) => void;
  reject: (e: unknown) => void;
}

/** A runner whose single command settles only when the test says so. */
function fakeRunner(opts: { throwOnStart?: Error; resolveOnKill?: CommandResult } = {}): FakeRunner {
  const starts: Array<{ command: string; cwd: string; env?: Record<string, string | undefined> }> = [];
  const state = { kills: 0 };
  let resolveDone!: (r: CommandResult) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<CommandResult>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const runner: CommandRunner = {
    start(command, o): RunningCommand {
      starts.push({ command, cwd: o.cwd, ...(o.env !== undefined ? { env: o.env } : {}) });
      if (opts.throwOnStart !== undefined) throw opts.throwOnStart;
      return {
        done,
        kill: async (): Promise<void> => {
          state.kills++;
          // Like the real runner: a TERM'd command settles (fast) with a signal.
          if (opts.resolveOnKill !== undefined) resolveDone(opts.resolveOnKill);
        },
      };
    },
  };
  return { runner, starts, state, resolve: resolveDone, reject: rejectDone };
}

function baseOpts(hub: HubClient, runner: CommandRunner, extra: Partial<ExecLoopOptions> = {}): ExecLoopOptions {
  return {
    hub,
    runner,
    workflow: 'wf1',
    run: 'run1',
    holder: EXEC,
    cwd: '/work',
    sleep: macrotaskSleep,
    now: () => 0,
    random: () => 0.5,
    out: () => {},
    err: () => {},
    heartbeatIntervalMs: 1000,
    jumpToleranceMs: 500,
    failureWindowMs: 5000,
    ...extra,
    instructions: extra.instructions ?? testInstructions(),
  };
}

const only = (calls: Call[], verb: string): Call[] => calls.filter((c) => c.verb === verb);

// ---- happy path -------------------------------------------------------------

test('runs the command and submits a receipt to the owed path (exit-success outcome)', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ command: 'make build' })], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep(); // let first contact + start settle
  fr.resolve(result(0, { outputHash: 'sha256:abc' }));

  assert.equal(await p, 'submitted');
  // First contact carried the exec holder.
  assert.deepEqual((only(calls, 'get_order')[0]!.arg as { holder?: unknown }).holder, EXEC);
  // The runner ran the order's command in the order's cwd (falls back to opts.cwd).
  assert.equal(fr.starts[0]!.command, 'make build');
  assert.equal(fr.starts[0]!.cwd, '/work');
  assert.equal('OWENLOOP_BUNDLE_DIR' in (fr.starts[0]!.env ?? {}), false);
  // Exactly one receipt to the owed path.
  assert.equal(submits.length, 1);
  assert.equal(submits[0]!.path, 'out');
  // W7/D4: submit carries the exec holder through too, not just get_order.
  assert.deepEqual(submits[0]!.holder, EXEC);
  const receipt = submits[0]!.value as CommandReceipt;
  assert.equal(receipt.kind, 'command-receipt');
  assert.equal(receipt.command, 'make build');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.outputHash, 'sha256:abc');
  assert.equal('payload' in receipt, false);
  assert.equal('payloadError' in receipt, false);
  assert.equal(receipt.orchestrator, 'host:123');
  assert.equal(receipt.step, 'builder');
  // The run closed via submit → no release (release:false path).
  assert.equal(only(calls, 'release').length, 0);
});

test('judge receipt payload is parsed before proof construction and the proof covers the payload', async () => {
  const fr = fakeRunner();
  const response = commandOrder({ command: 'emit-payload', judge: 'input', owes: ['input'] });
  response.order!.consumedFingerprint = { input: 4 };
  const { hub, submits } = mockHub({ getOrder: [response], submit: ['green'] });
  const sshCalls: Array<{ cmd: string; args: string[]; stdin?: Buffer }> = [];
  const loop = createExecLoop(baseOpts(hub, fr.runner, {
    origin: 'https://hub.example.test',
    principalKeys: signingKeys(),
    sshProcess: fakeSshProcess(sshCalls),
  }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"answer":42}' }));
  assert.equal(await p, 'submitted');

  const receipt = submits[0]!.value as CommandReceipt;
  assert.deepEqual(receipt.payload, { answer: 42 });
  assert.equal('payloadError' in receipt, false);
  const proof = submits[0]!.proof;
  assert.ok(proof !== undefined);
  const verified = await dsseVerifySubmission(JSON.parse(proof), {
    async verify(_bytes, signature) {
      return signature.toString('utf8') === ARMOR
        ? { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const }
        : null;
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as {
    produced: Array<{ valueDigest: string }>;
  };
  assert.equal(record.produced[0]!.valueDigest, valueDigestHex(receipt));
});

test('malformed or oversized payloads submit a receipt with payloadError and no payload', async () => {
  for (const [label, extra] of [
    ['malformed', { payloadLine: '{"broken"' }],
    ['oversized', { payloadOverCap: true }],
  ] as const) {
    const fr = fakeRunner();
    const { hub, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
    const loop = createExecLoop(baseOpts(hub, fr.runner));
    const p = loop.run();
    await macrotaskSleep();
    fr.resolve(result(0, extra));
    assert.equal(await p, 'submitted', label);
    const receipt = submits[0]!.value as CommandReceipt;
    assert.equal(typeof receipt.payloadError, 'string', label);
    assert.equal('payload' in receipt, false, label);
  }
});

test('a malformed reject directive stays in the receipt but never issues a reject', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"" ,"text":"bad"}}' }));
  assert.equal(await p, 'submitted');
  const receipt = submits[0]!.value as CommandReceipt;
  assert.deepEqual(receipt.payload, { reject: { path: '', text: 'bad' } });
  assert.match(receipt.payloadError ?? '', /non-empty string/);
  assert.equal(only(calls, 'reject').length, 0);
});

test('exec passes bundle provenance with the parent environment and removes it without provenance', async () => {
  const configEnv = {
    PATH: '/fixture/bin',
    HOME: '/fixture/home',
    OWENLOOP_BUNDLE_DIR: '/ambient/config-bundle',
  };
  const savedPath = process.env['PATH'];
  const savedBundleDir = process.env['OWENLOOP_BUNDLE_DIR'];
  process.env['PATH'] = '/parent/bin';
  process.env['OWENLOOP_BUNDLE_DIR'] = '/ambient/parent-bundle';
  try {
    const bundled = fakeRunner();
    const bundledHub = mockHub({ getOrder: [commandOrder({ command: 'ignored' })], submit: ['green'] });
    const bundledInstructions: InstructionResolver = {
      resolveCommand: async () => ({ ok: true, command: 'run-bundle-script', bundleDir: '/fixture/bundle' }),
      resolveStep: async () => ({ ok: false, kind: 'unknown-step', reason: 'not used' }),
    };
    const bundledRun = createExecLoop(baseOpts(bundledHub.hub, bundled.runner, {
      instructions: bundledInstructions,
      env: configEnv,
    })).run();
    await macrotaskSleep();
    bundled.resolve(result(0));
    assert.equal(await bundledRun, 'submitted');
    assert.equal(bundled.starts[0]!.env?.PATH, '/parent/bin');
    assert.equal(bundled.starts[0]!.env?.OWENLOOP_BUNDLE_DIR, '/fixture/bundle');

    const loose = fakeRunner();
    const looseHub = mockHub({ getOrder: [commandOrder({ command: 'ignored' })], submit: ['green'] });
    const looseInstructions: InstructionResolver = {
      resolveCommand: async () => ({ ok: true, command: 'run-loose-script' }),
      resolveStep: async () => ({ ok: false, kind: 'unknown-step', reason: 'not used' }),
    };
    const looseRun = createExecLoop(baseOpts(looseHub.hub, loose.runner, {
      instructions: looseInstructions,
      env: configEnv,
    })).run();
    await macrotaskSleep();
    loose.resolve(result(0));
    assert.equal(await looseRun, 'submitted');
    assert.equal(loose.starts[0]!.env?.PATH, '/parent/bin');
    assert.equal('OWENLOOP_BUNDLE_DIR' in (loose.starts[0]!.env ?? {}), false);
  } finally {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    if (savedBundleDir === undefined) delete process.env['OWENLOOP_BUNDLE_DIR'];
    else process.env['OWENLOOP_BUNDLE_DIR'] = savedBundleDir;
  }
});

// ---- consumed inputs on the child environment -------------------------------

/** A command order whose packet carries `consumes` (and optionally `inputs`). */
function consumingOrder(consumes: Record<string, unknown>, inputs?: string[]): GetOrderResponse {
  const response = commandOrder({ command: 'read-consumes' });
  response.order!.consumes = consumes;
  if (inputs !== undefined) response.order!.inputs = inputs;
  return response;
}

/** `consumes` whose serialized form is EXACTLY `target` bytes of ASCII. */
function consumesOfExactBytes(target: number): Record<string, unknown> {
  const overhead = Buffer.byteLength(JSON.stringify({ big: '' }), 'utf8');
  return { big: 'a'.repeat(target - overhead) };
}

/**
 * Drive one command order to completion and hand back what it spawned with.
 *
 * Only for assertions that survive the command's exit — the env OBJECT is the
 * one the loop built, so its variables are still readable, but an overflow file
 * named by `OWENLOOP_CONSUMES_FILE` is gone by the time this resolves. A test
 * that must read that file drives the fake runner itself.
 */
async function envForOrder(
  response: GetOrderResponse,
  opts: { extra?: Partial<ExecLoopOptions> } = {},
): Promise<{ env: Record<string, string | undefined>; cwd: string; outcome: ExecOutcome }> {
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [response], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, opts.extra ?? {}));
  const p = loop.run();
  await macrotaskSleep();
  const start = fr.starts[0]!;
  fr.resolve(result(0));
  const outcome = await p;
  return { env: start.env ?? {}, cwd: start.cwd, outcome };
}

test('a small consumes payload is delivered inline and the file variable is removed', async () => {
  const consumes = { proposal: { text: 'ship it' }, workspace: { payload: { worktreePath: '/wt/x' } } };
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [consumingOrder(consumes)], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  const env = fr.starts[0]!.env ?? {};
  assert.equal(env['OWENLOOP_CONSUMES'], JSON.stringify(consumes));
  assert.equal('OWENLOOP_CONSUMES_FILE' in env, false);
  assert.deepEqual(JSON.parse(env['OWENLOOP_CONSUMES']!), consumes);
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
});

test('an order with no consumed inputs still gets OWENLOOP_CONSUMES holding {}', async () => {
  // Absent must mean exactly one thing to a script: read the FILE variable.
  const response = commandOrder();
  delete (response.order! as unknown as Record<string, unknown>)['consumes'];
  const { env } = await envForOrder(response);
  assert.equal(env['OWENLOOP_CONSUMES'], '{}');
  assert.equal('OWENLOOP_CONSUMES_FILE' in env, false);
});

test('command children receive modifier and structured feedback, while first attempts clear stale values', async () => {
  const reason = {
    at: 1,
    action: 'reject',
    kind: 'judgment',
    by: 'planner',
    text: 'needs deeper review',
    requested: 'deep',
  };
  const delivered = await envForOrder(commandOrder({ modifier: 'deep', reasons: [reason] }));
  assert.equal(delivered.env['OWENLOOP_MODIFIER'], 'deep');
  assert.deepEqual(JSON.parse(delivered.env['OWENLOOP_FEEDBACK']!), [{ path: 'out', reasons: [reason] }]);
  assert.equal('OWENLOOP_FEEDBACK_FILE' in delivered.env, false);

  const savedModifier = process.env['OWENLOOP_MODIFIER'];
  const savedFeedback = process.env['OWENLOOP_FEEDBACK'];
  const savedFeedbackFile = process.env['OWENLOOP_FEEDBACK_FILE'];
  process.env['OWENLOOP_MODIFIER'] = 'stale';
  process.env['OWENLOOP_FEEDBACK'] = 'stale';
  process.env['OWENLOOP_FEEDBACK_FILE'] = '/parent/feedback.json';
  try {
    const first = await envForOrder(commandOrder());
    assert.equal('OWENLOOP_MODIFIER' in first.env, false);
    assert.equal('OWENLOOP_FEEDBACK' in first.env, false);
    assert.equal('OWENLOOP_FEEDBACK_FILE' in first.env, false);
  } finally {
    if (savedModifier === undefined) delete process.env['OWENLOOP_MODIFIER'];
    else process.env['OWENLOOP_MODIFIER'] = savedModifier;
    if (savedFeedback === undefined) delete process.env['OWENLOOP_FEEDBACK'];
    else process.env['OWENLOOP_FEEDBACK'] = savedFeedback;
    if (savedFeedbackFile === undefined) delete process.env['OWENLOOP_FEEDBACK_FILE'];
    else process.env['OWENLOOP_FEEDBACK_FILE'] = savedFeedbackFile;
  }
});

test('large command feedback follows the same file-delivery convention as consumes', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({
    getOrder: [commandOrder({
      reasons: [{ at: 1, action: 'reject', kind: 'judgment', by: 'planner', text: 'x'.repeat(CONSUMES_INLINE_MAX_BYTES), requested: 'deep' }],
    })],
    submit: ['green'],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const running = loop.run();
  await macrotaskSleep();
  const env = fr.starts[0]!.env ?? {};
  assert.equal('OWENLOOP_FEEDBACK' in env, false);
  assert.deepEqual(
    JSON.parse(readFileSync(env['OWENLOOP_FEEDBACK_FILE']!, 'utf8')),
    [{ path: 'out', reasons: [{ at: 1, action: 'reject', kind: 'judgment', by: 'planner', text: 'x'.repeat(CONSUMES_INLINE_MAX_BYTES), requested: 'deep' }] }],
  );
  fr.resolve(result(0));
  assert.equal(await running, 'submitted');
});

test('a declared input that was never produced stays an omitted key, never a null', async () => {
  const consumes = { proposal: { text: 'only this one landed' } };
  const { env } = await envForOrder(consumingOrder(consumes, ['proposal', 'planSeed']));
  const parsed = JSON.parse(env['OWENLOOP_CONSUMES']!) as Record<string, unknown>;
  assert.deepEqual(parsed, consumes);
  assert.equal('planSeed' in parsed, false, 'a missing input must not be normalized into a null placeholder');
});

test('a payload of exactly CONSUMES_INLINE_MAX_BYTES bytes is still delivered inline', async () => {
  const consumes = consumesOfExactBytes(CONSUMES_INLINE_MAX_BYTES);
  assert.equal(Buffer.byteLength(JSON.stringify(consumes), 'utf8'), CONSUMES_INLINE_MAX_BYTES);
  const { env } = await envForOrder(consumingOrder(consumes));
  assert.equal(Buffer.byteLength(env['OWENLOOP_CONSUMES'] ?? '', 'utf8'), CONSUMES_INLINE_MAX_BYTES);
  assert.equal('OWENLOOP_CONSUMES_FILE' in env, false, 'the comparison is <=, so the boundary goes inline');
});

test('one byte over the threshold takes the file path, and the file round-trips', async () => {
  const consumes = consumesOfExactBytes(CONSUMES_INLINE_MAX_BYTES + 1);
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [consumingOrder(consumes)], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  const env = fr.starts[0]!.env ?? {};
  const file = env['OWENLOOP_CONSUMES_FILE'];
  assert.equal(typeof file, 'string');
  assert.equal('OWENLOOP_CONSUMES' in env, false);
  // Readable WHILE the command runs — a script may read it late in its run.
  assert.deepEqual(JSON.parse(readFileSync(file!, 'utf8')), consumes);
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
});

test('multi-byte content is sized by its BYTE length, not its UTF-16 length', async () => {
  // The regression guard for measuring with `json.length`: every '€' is one
  // UTF-16 code unit and three UTF-8 bytes, so a `.length` check passes this
  // payload straight into an environment variable three times its budget.
  const consumes = { euros: '€'.repeat(30_000) };
  const json = JSON.stringify(consumes);
  assert.ok(json.length <= CONSUMES_INLINE_MAX_BYTES, 'the UTF-16 length must be under the threshold');
  assert.ok(Buffer.byteLength(json, 'utf8') > CONSUMES_INLINE_MAX_BYTES, 'the UTF-8 byte length must be over it');
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [consumingOrder(consumes)], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  const env = fr.starts[0]!.env ?? {};
  assert.equal('OWENLOOP_CONSUMES' in env, false);
  assert.deepEqual(JSON.parse(readFileSync(env['OWENLOOP_CONSUMES_FILE']!, 'utf8')), consumes);
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
});

test('stale inherited consumes variables are overwritten or deleted in both modes', async () => {
  const savedInline = process.env['OWENLOOP_CONSUMES'];
  const savedFile = process.env['OWENLOOP_CONSUMES_FILE'];
  process.env['OWENLOOP_CONSUMES'] = '{"parent":"stale inline value"}';
  process.env['OWENLOOP_CONSUMES_FILE'] = '/parent/run/consumes.json';
  try {
    const small = { child: 'mine' };
    const inline = await envForOrder(consumingOrder(small));
    assert.equal(inline.env['OWENLOOP_CONSUMES'], JSON.stringify(small));
    assert.equal('OWENLOOP_CONSUMES_FILE' in inline.env, false, 'a stale parent FILE path must be deleted, not inherited');

    const big = consumesOfExactBytes(CONSUMES_INLINE_MAX_BYTES + 1);
    const overflow = await envForOrder(consumingOrder(big));
    assert.equal('OWENLOOP_CONSUMES' in overflow.env, false, 'a stale parent inline value must be deleted, not inherited');
    assert.notEqual(overflow.env['OWENLOOP_CONSUMES_FILE'], '/parent/run/consumes.json');
  } finally {
    if (savedInline === undefined) delete process.env['OWENLOOP_CONSUMES'];
    else process.env['OWENLOOP_CONSUMES'] = savedInline;
    if (savedFile === undefined) delete process.env['OWENLOOP_CONSUMES_FILE'];
    else process.env['OWENLOOP_CONSUMES_FILE'] = savedFile;
  }
});

test('the overflow directory is removed after the command exits', async () => {
  const consumes = consumesOfExactBytes(CONSUMES_INLINE_MAX_BYTES + 1);
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [consumingOrder(consumes)], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  const file = fr.starts[0]!.env?.['OWENLOOP_CONSUMES_FILE'];
  assert.equal(typeof file, 'string');
  assert.equal(existsSync(file!), true, 'the file must survive for as long as the command runs');
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.equal(existsSync(file!), false);
  assert.equal(existsSync(dirname(file!)), false, 'the whole temp directory goes, not just the file');
});

test('the overflow directory is removed even when the spawn itself fails', async () => {
  const consumes = consumesOfExactBytes(CONSUMES_INLINE_MAX_BYTES + 1);
  const fr = fakeRunner({ throwOnStart: new Error('spawn ENOENT') });
  const { hub, calls, submits } = mockHub({ getOrder: [consumingOrder(consumes)] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'command-failed');
  assert.equal(submits.length, 0);
  const receipt = JSON.parse((only(calls, 'ask')[0]!.arg as Record<string, unknown>)['context'] as string) as CommandReceipt;
  assert.equal(receipt.exitCode, null);
  const file = fr.starts[0]!.env?.['OWENLOOP_CONSUMES_FILE'];
  assert.equal(typeof file, 'string');
  assert.equal(existsSync(dirname(file!)), false);
});

// ---- the cwd fallback record ------------------------------------------------

test('an order with no workdir warns, naming the step, the run, and the resolved cwd', async () => {
  const warnings: string[] = [];
  const { cwd, outcome } = await envForOrder(commandOrder(), { extra: { err: (line) => warnings.push(line) } });
  assert.equal(outcome, 'submitted');
  assert.equal(cwd, '/work');
  const fallback = warnings.filter((line) => /declared neither workdir nor workdirFrom/.test(line));
  assert.equal(fallback.length, 1, warnings.join('\n'));
  assert.match(fallback[0]!, /step 'builder'/);
  assert.match(fallback[0]!, /wf1\/run1/);
  assert.match(fallback[0]!, /'\/work'/);
  assert.match(fallback[0]!, /shift launch directory/);
});

test('an order that carries a workdir spawns there and warns about nothing', async () => {
  const warnings: string[] = [];
  const { cwd, outcome } = await envForOrder(commandOrder({ workdir: '/wt/flow-1' }), {
    extra: { err: (line) => warnings.push(line) },
  });
  assert.equal(outcome, 'submitted');
  assert.equal(cwd, '/wt/flow-1');
  assert.deepEqual(warnings, []);
});

test('provisioner/deprovisioner guard: a step with no workdirFrom still spawns in opts.cwd and completes', async () => {
  // The installed delivery bundle has two steps that deliberately declare no
  // workdirFrom — `provisioner` CREATES the worktree its successors use, and
  // `deprovisioner` DELETES its own. The fallback must stay a warning: turning
  // it into a throw breaks every delivery run. Do not delete this test to make
  // a future enforcement change pass.
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder({ command: 'provision' })], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { cwd: '/launch/dir' }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.equal(fr.starts[0]!.cwd, '/launch/dir');
  assert.equal((submits[0]!.value as CommandReceipt).exitCode, 0);
});

test('exec producer submit signs its receipt at the hub-issued owed target version', async () => {
  const fr = fakeRunner();
  const response = commandOrder({ command: 'make signed-build' });
  response.order!.consumedFingerprint = { input: 4 };
  const { hub, submits } = mockHub({ getOrder: [response], submit: ['green'] });
  const sshCalls: Array<{ cmd: string; args: string[]; stdin?: Buffer }> = [];
  const loop = createExecLoop(baseOpts(hub, fr.runner, {
    origin: 'https://hub.example.test',
    principalKeys: signingKeys(),
    sshProcess: fakeSshProcess(sshCalls),
  }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { outputHash: 'sha256:signed-receipt' }));
  assert.equal(await p, 'submitted');

  const proof = submits[0]!.proof;
  assert.equal(typeof proof, 'string');
  assert.ok(sshCalls.length > 0, 'the hub-issued target reaches the signer');
  const verified = await dsseVerifySubmission(JSON.parse(proof as string), {
    async verify() {
      return { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const };
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as {
    produced: Array<{ artifact: string; version: number }>;
  };
  assert.equal(record.produced[0]!.artifact, 'out');
  assert.equal(record.produced[0]!.version, 1);
});

test('exec judge submit falls back unsigned when the machine key is missing', async () => {
  const fr = fakeRunner();
  const response = commandOrder({ judge: 'input', owes: ['input'] });
  response.order!.consumedFingerprint = { input: 4 };
  const { hub, submits } = mockHub({ getOrder: [response], submit: ['green'] });
  const warnings: string[] = [];
  const loop = createExecLoop(baseOpts(hub, fr.runner, {
    origin: 'https://hub.example.test',
    principalKeys: {
      resolveRef: () => null,
      inspect: async () => {
        throw new Error('inspect must not run');
      },
      withSigningKey: async () => {
        throw new Error('withSigningKey must not run');
      },
    },
    out: () => {},
    err: (line) => warnings.push(line),
  }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.equal(submits[0]!.proof, undefined);
  // This order carries no workdir, so the cwd-fallback record is on the same
  // sink. Pin BOTH lines rather than loosening the count: exactly one proof
  // warning, exactly one fallback warning, nothing else.
  const proofWarnings = warnings.filter((line) => /without a proof/.test(line));
  assert.equal(proofWarnings.length, 1);
  assert.equal(warnings.filter((line) => /declared neither workdir nor workdirFrom/.test(line)).length, 1);
  assert.equal(warnings.length, 2, warnings.join('\n'));
});

test('the runner receives only locally resolved command text, not an extra packet command field', async () => {
  const fr = fakeRunner();
  const response = commandOrder({ command: 'printf "from-local-store\\n"' });
  const packet = response.order! as unknown as Record<string, unknown>;
  packet['command'] = 'touch /tmp/remote-packet-command-must-not-run';
  const { hub } = mockHub({ getOrder: [response], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.equal(fr.starts[0]!.command, 'printf "from-local-store\\n"');
  assert.equal(fr.starts[0]!.cwd, '/work');
  assert.equal('OWENLOOP_BUNDLE_DIR' in (fr.starts[0]!.env ?? {}), false);
});

for (const kind of ['unknown-digest', 'unknown-step', 'integrity', 'no-digest', 'missing-command'] as const) {
  test(`instruction refusal (${kind}) releases without spawning or submitting`, async () => {
    const fr = fakeRunner();
    const response = commandOrder();
    if (kind === 'no-digest') {
      (response.order! as unknown as Record<string, unknown>)['defDigest'] = '';
    }
    const { hub, calls, submits } = mockHub({ getOrder: [response] });
    const loop = createExecLoop(baseOpts(hub, fr.runner, {
      instructions: refusingInstructions(kind),
    }));
    assert.equal(await loop.run(), 'unresolved-instructions');
    assert.equal(fr.starts.length, 0);
    assert.equal(submits.length, 0);
    assert.equal(only(calls, 'release').length, 1);
  });
}

test('uses the order workdir as the command cwd when the packet carries one', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder({ workdir: '/repo/wt' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  await p;
  assert.equal(fr.starts[0]!.cwd, '/repo/wt');
});

test('submits a receipt to EVERY owed path, in order', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ owes: ['a', 'b', 'c'] })], submit: ['green', 'submitted', 'green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.deepEqual(submits.map((s) => s.path), ['a', 'b', 'c']);
  assert.equal(only(calls, 'ask').length, 0);
});

test('a non-zero exit submits nothing and raises a question on the owed path', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder()] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(3));
  assert.equal(await p, 'command-failed');
  assert.equal(submits.length, 0, 'a failed command must never green its artifact');
  assert.equal(only(calls, 'ask').length, 1);
  assert.equal(only(calls, 'release').length, 0, 'ask closed the run');
});

test('a failed command carries its exit code and output tail to the operator', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ owes: ['input'] })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(64, { outputTail: 'terraform: no such provider' }));

  assert.equal(await p, 'command-failed');
  assert.equal(submits.length, 0);
  const ask = only(calls, 'ask')[0]!.arg as Record<string, unknown>;
  assert.equal(ask['path'], 'input');
  assert.match(ask['question'] as string, /exit code: 64/);
  assert.match(ask['question'] as string, /terraform: no such provider/);
  const receipt = JSON.parse(ask['context'] as string) as CommandReceipt;
  assert.equal(receipt.exitCode, 64);
  assert.match(receipt.outputTail, /terraform: no such provider/);
});

test('a killed child escalates with its signal named', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder()] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(null, { signal: 'SIGKILL' }));

  assert.equal(await p, 'command-failed');
  assert.equal(submits.length, 0);
  const ask = only(calls, 'ask')[0]!.arg as Record<string, unknown>;
  assert.match(ask['question'] as string, /was killed by SIGKILL/);
});

test('a failed command with multiple owed paths asks only the first and names the rest', async () => {
  const errs: string[] = [];
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ owes: ['a', 'b'] })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { err: (line) => errs.push(line) }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(1));

  assert.equal(await p, 'command-failed');
  assert.equal(submits.length, 0);
  assert.equal((only(calls, 'ask')[0]!.arg as Record<string, unknown>)['path'], 'a');
  assert.ok(errs.some((line) => line.includes('b') && line.includes('not escalated')));
});

test('a refused ask is distinct from a command failure whose question landed', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    ask: [{ ok: false, text: 'ask: run is not held' }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(1));

  assert.equal(await p, 'ask-failed');
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'ask').length, 1);
  assert.equal(only(calls, 'release').length, 1);
});

test('a throwing ask is distinct and releases the claim', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    ask: [new Error('hub offline')],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(1));

  assert.equal(await p, 'ask-failed');
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'ask').length, 1);
  assert.equal(only(calls, 'release').length, 1);
});

test('a closing payload reject beats the failure gate', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    reject: [{ ok: true, closed: true }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(1, { payloadLine: '{"reject":{"path":"input","text":"upstream is invalid"}}' }));

  assert.equal(await p, 'rejected');
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'reject').length, 1);
  assert.equal(only(calls, 'ask').length, 0);
});

test('a non-closing payload reject is followed by failure escalation', async () => {
  const outs: string[] = [];
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    reject: [{ ok: true, closed: false }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { out: (line) => outs.push(line) }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(1, { payloadLine: '{"reject":{"path":"input","text":"upstream is invalid"}}' }));

  assert.equal(await p, 'command-failed');
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'reject').length, 1);
  assert.equal(only(calls, 'ask').length, 1);
  assert.ok(outs.some((line) => line.includes('claim remains open')));
  assert.ok(
    outs.every((line) => !line.includes('submitting owed receipts')),
    `failed command must not promise a submit: ${JSON.stringify(outs)}`,
  );
});

test('a payload reject that leaves the claim open lands FIRST, then every owed receipt', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder({ owes: ['a', 'b'] })],
    submit: ['green', 'green'],
    // closed:false ⇒ the rejected path was not one of this firing's consumed
    // inputs, so the claim and the consume fingerprint both survive it.
    reject: [{ ok: true, closed: false }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"input","text":"upstream is invalid"}}' }));
  assert.equal(await p, 'submitted');
  assert.deepEqual(submits.map((s) => s.path), ['a', 'b']);
  const verbs = calls.filter((call) => call.verb === 'submit' || call.verb === 'reject').map((call) => call.verb);
  // Reject first. The hub refuses a reject from a run whose claim has closed,
  // and the last owed submit is what closes it.
  assert.deepEqual(verbs, ['reject', 'submit', 'submit']);
  assert.deepEqual(only(calls, 'reject')[0]!.arg, {
    workflow: 'wf1',
    run: 'run1',
    path: 'input',
    text: 'upstream is invalid',
  });
  assert.equal((only(calls, 'reject')[0]!.arg as Record<string, unknown>)['by'], undefined);
});

test('a payload reject carries the child command output tail', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({
    getOrder: [commandOrder({ owes: ['a'] })],
    submit: ['green'],
    reject: [{ ok: true, closed: false }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, {
    payloadLine: '{"reject":{"path":"checks","text":"local checks failed"}}',
    outputTail: 'FAIL test/foo.test.ts\n  expected 1 got 2\n\n',
  }));
  assert.equal(await p, 'submitted');
  assert.deepEqual(only(calls, 'reject')[0]!.arg, {
    workflow: 'wf1',
    run: 'run1',
    path: 'checks',
    text: 'local checks failed\n\n--- command output (last 40 bytes) ---\nFAIL test/foo.test.ts\n  expected 1 got 2',
  });
});

test('an empty child output tail appends nothing to a payload reject', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({
    getOrder: [commandOrder({ owes: ['a'] })],
    submit: ['green'],
    reject: [{ ok: true, closed: false }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, {
    payloadLine: '{"reject":{"path":"input","text":"upstream is invalid"}}',
    outputTail: '\n\n',
  }));
  assert.equal(await p, 'submitted');
  assert.deepEqual(only(calls, 'reject')[0]!.arg, {
    workflow: 'wf1',
    run: 'run1',
    path: 'input',
    text: 'upstream is invalid',
  });
  assert.ok(
    !String((only(calls, 'reject')[0]!.arg as Record<string, unknown>)['text']).includes('--- command output'),
    'silence must not add a separator',
  );
});

test('the appended tail reports BYTES, not characters', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({
    getOrder: [commandOrder({ owes: ['a'] })],
    submit: ['green'],
    reject: [{ ok: true, closed: false }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, {
    payloadLine: '{"reject":{"path":"input","text":"bad value"}}',
    outputTail: 'é\n',
  }));
  assert.equal(await p, 'submitted');
  assert.deepEqual(only(calls, 'reject')[0]!.arg, {
    workflow: 'wf1',
    run: 'run1',
    path: 'input',
    text: 'bad value\n\n--- command output (last 2 bytes) ---\né',
  });
});

test('a payload reject that closes the run submits NOTHING and leaves the owed paths as debts', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder({ owes: ['mergeable'] })],
    submit: ['green'],
    // closed:true ⇒ the rejected path WAS a consumed input, so the hub closed
    // the run `no_work`. This is the delivery gate's shape: merge-gate consumes
    // `pr` and owes `mergeable`.
    reject: [{ ok: true, closed: true }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"pr","text":"CI is failing"}}' }));
  assert.equal(await p, 'rejected');
  // THE REGRESSION THIS PINS. Under submit-then-reject this run greened
  // `mergeable` and only then discovered its `pr` reject was unenforceable
  // against a closed claim, so a gate that refused to confirm the PR handed
  // `merger` a green anyway (observed on run_ecfedb23a84194e446159e67).
  assert.equal(submits.length, 0, 'a gate that rejects must not also green its own output');
  assert.equal(only(calls, 'reject').length, 1);
  assert.equal(only(calls, 'release').length, 0, 'the hub already closed the run');
});

test('a payload reject failure is distinct, submits nothing, and releases the claim', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    submit: ['green'],
    reject: [new Error('reject offline')],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"input","text":"bad value"}}' }));
  assert.equal(await p, 'reject-failed');
  // A reject that did not land must never be followed by a receipt that greens
  // the very path the reject was protesting.
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'reject').length, 1);
  assert.equal(only(calls, 'release').length, 1);
});

test('a REFUSED payload reject submits nothing and releases the claim', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    submit: ['green'],
    reject: [{ ok: false, text: 'reject: wf1/run1 is not currently held by an open claim — nothing was rejected.' }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"input","text":"bad value"}}' }));
  assert.equal(await p, 'reject-failed');
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('a judge with a non-zero exit rejects its judge path and submits no receipt', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder({ judge: 'input' })],
    reject: [{ ok: true, closed: false }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(7, { outputTail: 'assertion failed' }));
  assert.equal(await p, 'judge-rejected');
  assert.equal(submits.length, 0);
  assert.deepEqual(only(calls, 'reject')[0]!.arg, {
    workflow: 'wf1',
    run: 'run1',
    path: 'input',
    text: 'assertion failed',
  });
  assert.equal(only(calls, 'release').length, 1);
  assert.equal(only(calls, 'ask').length, 0);
});

test('a judge machinery failure issues neither submit nor reject and leaves the claim unreleased', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ judge: 'input' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(null, { error: 'terminated by signal' }));
  assert.equal(await p, 'judge-no-verdict');
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'reject').length, 0);
  assert.equal(only(calls, 'release').length, 0);
  assert.equal(only(calls, 'ask').length, 0);
});

test('a zero-exit judge submits its receipt and ignores a payload reject directive', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder({ judge: 'input' })],
    submit: ['green'],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"other","text":"do not send"}}' }));
  assert.equal(await p, 'submitted');
  assert.equal(submits.length, 1);
  assert.equal(only(calls, 'reject').length, 0);
  assert.equal(only(calls, 'ask').length, 0);
});

test('a machinery failure from runner completion escalates instead of submitting', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder()] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.reject(new Error('spawn EACCES'));
  assert.equal(await p, 'command-failed');
  assert.equal(submits.length, 0);
  const ask = only(calls, 'ask')[0]!.arg as Record<string, unknown>;
  assert.match(ask['question'] as string, /could not be run \(spawn EACCES\)/);
  assert.match(ask['question'] as string, /exit code: none/);
  const receipt = JSON.parse(ask['context'] as string) as CommandReceipt;
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.error, 'spawn EACCES');
});

test('a runner that throws at start escalates its machinery failure', async () => {
  const fr = fakeRunner({ throwOnStart: new Error('cannot fork') });
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder()] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'command-failed');
  assert.equal(submits.length, 0);
  const receipt = JSON.parse((only(calls, 'ask')[0]!.arg as Record<string, unknown>)['context'] as string) as CommandReceipt;
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.error, 'cannot fork');
});

// ---- operator-declared work roots -------------------------------------------
//
// The policy the OPERATOR of this machine set, not the hub. Refusing is a
// RELEASE, never a submit: the order is valid, this machine is simply not
// configured to host it, and the pickup window must be able to hand it to a
// machine that is.

test('no declared roots means no restriction — an order workdir anywhere runs', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({
    getOrder: [commandOrder({ workdir: '/somewhere/else' })],
    submit: ['green'],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.equal(fr.starts[0]!.cwd, '/somewhere/else');
  assert.equal(submits.length, 1);
});

test('an order workdir outside every declared root is released, never run', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ workdir: '/elsewhere/proj' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { allowedWorkdirRoots: ['/allowed'] }));
  assert.equal(await loop.run(), 'workdir-denied');
  assert.equal(fr.starts.length, 0);
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('an order workdir inside a declared root runs normally', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({
    getOrder: [commandOrder({ workdir: '/allowed/proj/wt/x' })],
    submit: ['green'],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { allowedWorkdirRoots: ['/allowed'] }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.equal(fr.starts[0]!.cwd, '/allowed/proj/wt/x');
});

test('an order that names NO workdir is never denied, whatever the roots are', async () => {
  // The fallback is this worker's own launch directory, which the operator
  // chose when they started the shift. Bounding an operator's own choice by
  // that same operator's roots would deny every step that legitimately
  // declares neither `workdir:` nor `workdirFrom:` — `deprovisioner` included.
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { allowedWorkdirRoots: ['/allowed'] }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.equal(fr.starts[0]!.cwd, '/work');
});

// ---- misroute (not exec's to fail) ------------------------------------------

test('a null order packet is a misroute — release, no run, no submit', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [nonCommandOrder(null)] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('an agent (non-command) worker is a misroute', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder({ worker: 'agent' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('a packet lacking owes entirely is a misroute, not a crash', async () => {
  const fr = fakeRunner();
  const base = commandOrder().order!;
  const malformed = { ...base, owes: undefined } as unknown as GetOrderResponse['order'];
  const { hub, calls, submits } = mockHub({ getOrder: [nonCommandOrder(malformed)] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('an order that owes nothing is a misroute', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder({ owes: [] })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
});

// ---- submit failures --------------------------------------------------------

test('a schema-rejected submit ⇒ submit-rejected (releases — the claim may still be ours)', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder()], submit: ['schema-rejected'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-rejected');
  assert.equal(only(calls, 'release').length, 1);
});

test('a born-rejected submit ⇒ submit-rejected with NO release (the claim is already gone)', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder()], submit: ['born-rejected'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-rejected');
  assert.equal(only(calls, 'release').length, 0);
});

test('a submit that throws ⇒ submit-failed (best-effort release)', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder()], submit: [new Error('network down')] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-failed');
  assert.equal(only(calls, 'release').length, 1);
});

test('the first rejected submit stops the run — later owed paths are not written', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder({ owes: ['a', 'b'] })], submit: ['schema-rejected', 'green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-rejected');
  assert.deepEqual(submits.map((s) => s.path), ['a']); // stopped after the rejection
});

// ---- lease lost mid-run -----------------------------------------------------

test('a 403 heartbeat while the command runs ⇒ kill, no submit, ownership-error', async () => {
  const fr = fakeRunner(); // command never settles
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    heartbeat: () => {
      throw new HubError(403, 'forbidden', 'forbidden');
    },
    submit: ['green'],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'ownership-error');
  assert.equal(fr.state.kills, 1);
  assert.equal(submits.length, 0);
  // The exec holder rode the heartbeat too (plan decision 1).
  const beats = only(calls, 'heartbeat');
  assert.ok(beats.length >= 1);
  assert.deepEqual((beats[0]!.arg as { holder?: unknown }).holder, EXEC);
});

test('a lost lease (heartbeat fails, classify shows unclaimed) mid-run ⇒ kill, lease-lost', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({
    getOrder: [commandOrder(), commandOrder({ claimed: false })], // fc holding, classify: gone
    heartbeat: () => {
      throw new HubError(500, 'lease gone');
    },
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'lease-lost');
  assert.equal(fr.state.kills, 1);
  assert.equal(submits.length, 0);
});

// ---- first contact terminal (no command) ------------------------------------

test('first contact already completed ⇒ completed, command never runs', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ claimed: false, outcome: 'ok' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'completed');
  assert.equal(fr.starts.length, 0);
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 0);
});

test('first contact unclaimed with no outcome ⇒ lease-lost, command never runs', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder({ claimed: false })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'lease-lost');
  assert.equal(fr.starts.length, 0);
});

// ---- signal (final breath) --------------------------------------------------

test('a signal mid-run kills the command group, releases, and exits killed', async () => {
  const fr = fakeRunner(); // never settles
  const h: { loop?: ExecLoop } = {};
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    release: () => Promise.resolve({ text: '' }),
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  h.loop = loop;
  const p = loop.run();
  await macrotaskSleep(); // reach the run+race
  loop.stop('signal');
  assert.equal(await p, 'killed');
  assert.ok(fr.state.kills >= 1); // kill is idempotent; stop() + the lease race may both call it
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('no receipt when the killed command settles BEFORE the release resolves the lease', async () => {
  // The submit-after-kill race: stop() TERMs the command, which dies in
  // milliseconds, while the lease only resolves after the release HTTP
  // round-trip — so cmd.done wins the race. Killed work must still get NO
  // receipt (plan decisions 1 and 9).
  const fr = fakeRunner({ resolveOnKill: result(null, { signal: 'SIGTERM' }) });
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    // A slow release: several macrotasks, so cmd.done (already resolved by the
    // kill) beats the lease promise to the race.
    release: () =>
      new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(() => r({ text: '' }))))),
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep(); // reach the run+race
  loop.stop('signal'); // kill resolves cmd.done synchronously; release is still in flight
  assert.equal(await p, 'killed');
  assert.equal(submits.length, 0); // the whole point: no receipt for killed work
  assert.equal(only(calls, 'release').length, 1);
  assert.ok(fr.state.kills >= 1);
});

// ---- child output relay -----------------------------------------------------
//
// The regression guard for `wf_40bd0c3f6783f9d31291d74d`, where a `merger`
// command step failed four times and every log said only "holding / running /
// schema-rejected". A failed command now relays `outputTail` to stderr and
// carries it to the operator with `hub.ask`, while a deferring success still
// relays its output on stdout.

test('a non-zero exit relays the child output to stderr before anything else decides', async () => {
  const errs: string[] = [];
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder()] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { err: (line) => errs.push(line) }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(1, { outputTail: 'merge: typicalday/dev#136 is CLOSED\n' }));

  assert.equal(await p, 'command-failed');
  // The header names the step and how it ended; the body carries the child's words.
  assert.ok(
    errs.some((l) => l.includes("the command for step 'builder' exited 1")),
    `expected a failure header, got ${JSON.stringify(errs)}`,
  );
  assert.ok(
    errs.some((l) => l === '  | merge: typicalday/dev#136 is CLOSED'),
    `expected the relayed tail, got ${JSON.stringify(errs)}`,
  );
  // The relay must land BEFORE the escalation line, or a reader scrolling to the
  // first error still sees the symptom without the cause.
  const relayAt = errs.findIndex((l) => l.startsWith('  | '));
  const escalationAt = errs.findIndex((l) => l.includes('escalating on'));
  assert.ok(relayAt >= 0 && escalationAt > relayAt, `relay must precede escalation: ${JSON.stringify(errs)}`);
});

test('a machinery failure relays the machinery error, not a bare exit code', async () => {
  const errs: string[] = [];
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder()] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, { err: (line) => errs.push(line) }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(null, { error: 'spawn ENOENT' }));

  assert.equal(await p, 'command-failed');
  assert.ok(
    errs.some((l) => l.includes('could not be run (spawn ENOENT)')),
    `expected the machinery error, got ${JSON.stringify(errs)}`,
  );
  // No output at all is stated, not silently skipped — "the log is empty"
  // and "the child said nothing" are different diagnoses.
  assert.ok(
    errs.some((l) => l === '  (the command produced no output)'),
    `expected the no-output note, got ${JSON.stringify(errs)}`,
  );
});

test('a successful command relays its output on out, and never on err', async () => {
  const outs: string[] = [];
  const errs: string[] = [];
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, {
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
  }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { outputTail: 'merge-gate: CI still pending (2 of 5 checks running)\n' }));

  assert.equal(await p, 'submitted');
  assert.ok(
    outs.some((l) => l === "owenloop work exec: the command for step 'builder' succeeded; its output follows"),
    `expected the success header, got ${JSON.stringify(outs)}`,
  );
  assert.ok(
    outs.some((l) => l === '  | merge-gate: CI still pending (2 of 5 checks running)'),
    `expected the relayed tail, got ${JSON.stringify(outs)}`,
  );
  // The record must precede the submit on this path too: a submit the hub then
  // schema-rejects must not be able to take the output down with it.
  const relayAt = outs.findIndex((l) => l.startsWith('  | '));
  const submitAt = outs.findIndex((l) => l.includes('submitted receipt'));
  assert.ok(relayAt >= 0 && submitAt > relayAt, `relay must precede the submit: ${JSON.stringify(outs)}`);
  // PRESERVED VERBATIM from 'a successful command relays nothing'. This is the
  // guard that the two channels stay separate: routine success output must
  // never enter the channel the worker log and the shift read as trouble.
  assert.deepEqual(
    errs.filter((l) => l.startsWith('  ') || l.includes('its last output follows')),
    [],
    'a green run must not spray its output into the trouble channel',
  );
});

test('a successful command that printed nothing records the silence', async () => {
  const outs: string[] = [];
  const errs: string[] = [];
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner, {
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
  }));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0)); // the `result` helper defaults outputTail to ''

  assert.equal(await p, 'submitted');
  assert.ok(
    outs.some((l) => l === "owenloop work exec: the command for step 'builder' succeeded; its output follows"),
    `expected the success header, got ${JSON.stringify(outs)}`,
  );
  // "this gate printed nothing" IS the diagnosis in the deferring merge-gate
  // case, so an absent line would be indistinguishable from the old bug.
  assert.ok(
    outs.some((l) => l === '  (the command produced no output)'),
    `expected the no-output note, got ${JSON.stringify(outs)}`,
  );
  assert.deepEqual(errs.filter((l) => l.startsWith('  ')), [], 'silence is a record, not a diagnosis');
});
