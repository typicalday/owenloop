import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';

import { dsseVerifySubmission, valueDigestHex } from '../../../src/crypto/index.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { resetSshKeygenProbe } from '../../../src/crypto/ssh.ts';
import type { SshProcessAdapter } from '../../../src/crypto/ssh.ts';
import { createExecLoop, type ExecLoop, type ExecLoopOptions } from '../src/exec/loop.ts';
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
      ...(o.judge !== undefined ? { judge: o.judge } : {}),
      defDigest,
      consumes: {},
      owes: paths.map((path) => ({ path, version: 0, judgmentRejects: 0, schemaRejects: 0, reasons: [] })),
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
  release?: () => Promise<{ text: string }>;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[]; submits: SubmitCall[] } {
  const calls: Call[] = [];
  const submits: SubmitCall[] = [];
  let goIdx = 0;
  let hbIdx = 0;
  let subIdx = 0;
  let rejectIdx = 0;

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

test('exec producer submit remains unsigned without a retry-safe hub-issued version', async () => {
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

  assert.equal(submits[0]!.proof, undefined);
  assert.equal(sshCalls.length, 0, 'claim-time owes[].version must not reach the signer');
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
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /without a proof/);
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
  const { hub, submits } = mockHub({ getOrder: [commandOrder({ owes: ['a', 'b', 'c'] })], submit: ['green', 'submitted', 'green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.deepEqual(submits.map((s) => s.path), ['a', 'b', 'c']);
});

test('a non-zero exit still submits a receipt carrying the exit code (outcome submitted)', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(3));
  assert.equal(await p, 'submitted');
  assert.equal((submits[0]!.value as CommandReceipt).exitCode, 3);
});

test('a plain command submits every receipt before delivering a payload reject', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder({ owes: ['a', 'b'] })],
    submit: ['green', 'green'],
    reject: [{ ok: true, closed: false }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"input","text":"upstream is invalid"}}' }));
  assert.equal(await p, 'rejected');
  assert.deepEqual(submits.map((s) => s.path), ['a', 'b']);
  const verbs = calls.filter((call) => call.verb === 'submit' || call.verb === 'reject').map((call) => call.verb);
  assert.deepEqual(verbs, ['submit', 'submit', 'reject']);
  assert.deepEqual(only(calls, 'reject')[0]!.arg, {
    workflow: 'wf1',
    run: 'run1',
    path: 'input',
    text: 'upstream is invalid',
  });
  assert.equal((only(calls, 'reject')[0]!.arg as Record<string, unknown>)['by'], undefined);
});

test('a closed payload reject stops without releasing the already-closed claim', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({
    getOrder: [commandOrder()],
    submit: ['green'],
    reject: [{ ok: true, closed: true }],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0, { payloadLine: '{"reject":{"path":"input","text":"bad value"}}' }));
  assert.equal(await p, 'rejected');
  assert.equal(only(calls, 'release').length, 0);
});

test('a payload reject failure is distinct and releases the claim after receipts land', async () => {
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
  assert.equal(submits.length, 1);
  assert.equal(only(calls, 'reject').length, 1);
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
});

test('a machinery failure (runner done rejects) submits a null-exit receipt', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.reject(new Error('spawn EACCES'));
  assert.equal(await p, 'submitted');
  const receipt = submits[0]!.value as CommandReceipt;
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.error, 'spawn EACCES');
});

test('a runner that throws at start submits a machinery-failure receipt', async () => {
  const fr = fakeRunner({ throwOnStart: new Error('cannot fork') });
  const { hub, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'submitted');
  assert.equal((submits[0]!.value as CommandReceipt).exitCode, null);
  assert.equal((submits[0]!.value as CommandReceipt).error, 'cannot fork');
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
