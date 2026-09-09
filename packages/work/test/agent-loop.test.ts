/**
 * `createAgentRunLoop` — the `agent-run` orchestration core (Phase 3).
 *
 * Everything here is driven by injected fakes: a mock hub, `createFakeAdapter`
 * (or a hand-rolled adapter when a test needs to hold a turn open), a
 * macrotask sleep, and an in-memory session sink. No process, no timers, no fs.
 *
 * The assertions that matter most are the ones about WHO decides the outcome:
 * a turn that failed but whose submit landed is a SUCCESS, and a turn that
 * ended cleanly with no hub outcome is a FAILURE. The harness never votes.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  confirmOutcome,
  createAgentRunLoop,
  type AdapterResolution,
  type AgentRunLoopOptions,
} from '../src/agent/loop.ts';
import {
  ACCOUNT_TOKEN,
  SHIFT_TOKEN,
  ORDER_TOKEN,
  ORIGIN_TOKEN,
  renderColdRecoveryAppendix,
  renderRecoveryWake,
} from '../src/agent/brief.ts';
import { resolveOwenloopBin } from '../src/owenloop-bin.ts';
import { createFakeAdapter, type FakeAdapter } from '../src/harness/fake.ts';
import { claudeAdapter, deliverClaude, startClaude, type ClaudeQueryFactory } from '../src/harness/claude.ts';
import type { MergedRoster } from '../src/settings/roster.ts';
import type {
  AgentEvent,
  HarnessAdapter,
  HarnessSessionRef,
  StartArgs,
  StepPermissions,
} from '../src/harness/contract.ts';
import { HarnessTurnError, ResumeUnavailableError } from '../src/harness/contract.ts';
import type { SessionRecord } from '../src/harness/session-store.ts';
import { HubError, type ContactHolder, type GetOrderResponse, type ReasonEntry } from '../src/hub/types.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { LeaseLoop, LeaseOutcome } from '../src/lease/loop.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import { projectSession } from '../src/roles/sessions.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ---- fakes ------------------------------------------------------------------

const HOLDER: ContactHolder = { kind: 'exec', id: 'host:99' };
const macrotaskSleep = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Call {
  verb: string;
  arg?: unknown;
}

interface OrderOpts {
  run?: string;
  step?: string;
  workdir?: string;
  model?: string;
  worker?: string;
  claimed?: boolean;
  outcome?: string;
  /** Consumed input artifact values, keyed by path. */
  consumes?: Record<string, unknown>;
  /** Owed outputs, with their standing reject counts. */
  owes?: Array<{
    path: string;
    judgmentRejects?: number;
    schema?: unknown;
    schemaAppliesTo?: 'value' | 'member';
    reasons?: ReasonEntry[];
  }>;
  /** Extension bag. */
  x?: Record<string, unknown>;
  /** The composed capabilities the engine offered this step under. */
  capabilities?: string[];
  /** The hub's ordered crew stamp for a capability-bearing order. */
  crews?: string[];
  /** Exercise the explicit missing-stamp protocol failure. */
  omitCrewStamp?: boolean;
  /** The run's routing modifier, as `start_run` recorded it. */
  modifier?: string;
  /** Set by the engine when it re-offered this step at its escalation target. */
  escalated?: boolean;
}

/** A get_order response carrying an agent order packet. */
function agentOrder(o: OrderOpts = {}): GetOrderResponse {
  const run = o.run ?? 'run1';
  return {
    text: '',
    workflow: 'wf1',
    run,
    order: {
      run,
      workflow: 'wf1',
      step: o.step ?? 'builder',
      key: 'k',
      inputs: [],
      outputs: [],
      ...(o.workdir !== undefined ? { workdir: o.workdir } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
      ...(o.capabilities !== undefined
		? {
			capabilities: o.capabilities,
			...(o.omitCrewStamp ? {} : { crews: o.crews ?? ['test-crew'] }),
		}
		: {}),
      ...(o.modifier !== undefined ? { modifier: o.modifier } : {}),
      ...(o.escalated !== undefined ? { escalated: o.escalated } : {}),
      ...(o.worker !== undefined ? { worker: o.worker } : {}),
      defDigest: 'test-agent-digest',
      ...(o.x !== undefined ? { x: o.x } : {}),
      consumes: o.consumes ?? {},
      owes: (o.owes ?? []).map((w) => ({
        path: w.path,
        judgmentRejects: w.judgmentRejects ?? 0,
        schemaRejects: 0,
		reasons: w.reasons ?? [],
        ...(w.schema !== undefined ? { schema: w.schema, schemaAppliesTo: w.schemaAppliesTo } : {}),
      })),
    },
    lease: { claimed: o.claimed ?? true, ...(o.outcome !== undefined ? { outcome: o.outcome } : {}) },
  };
}

/** A first-contact response with no hold at all. */
function noHold(lease: GetOrderResponse['lease']): GetOrderResponse {
  return { text: '', workflow: 'wf1', run: 'run1', order: null, lease };
}

interface MockCfg {
  getOrder: Array<GetOrderResponse | Error> | ((n: number) => GetOrderResponse | Error);
  heartbeat?: (n: number) => void;
	ask?: { ok: boolean; closed?: boolean; text?: string } | Error;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[] } {
  const calls: Call[] = [];
  let goIdx = 0;
  let hbIdx = 0;
  const hub: HubClient = {
    // Not exercised here: the byte-bodied upload has its own tests.
    async putFileArtifact() {
      throw new Error('putFileArtifact is not exercised by this test');
    },
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
      return { text: '' };
    },
    async submit(req) {
      calls.push({ verb: 'submit', arg: req });
      return { text: '', outcome: 'green' };
    },
    async whatsNext() {
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
    async ask(req) {
      calls.push({ verb: 'ask', arg: req });
		const response = cfg.ask ?? { text: '', ok: true, closed: true };
		if (response instanceof Error) throw response;
		return { text: response.text ?? '', ok: response.ok, ...(response.closed !== undefined ? { closed: response.closed } : {}) };
    },
    // The tool-approval gate is not exercised by these tests; a fake that never
    // opens an approval, and a non-answer is a denial.
    async requestApproval() { return { text: '', ok: false }; },
    async answerApproval() { return { text: '', ok: false }; },
    async listPendingApprovals() { return { text: '', approvals: [] }; },
    async reportResolution(req) {
      calls.push({ verb: 'report_resolution', arg: req });
      return {
        text: '',
        workflow: req.workflow,
        run: req.run,
        step: 'builder',
        recorded: true,
        claimed: true,
      };
    },
    async whoami() {
      return {
        text: '',
        orgId: '',
        orgName: '',
        actor: { id: '', kind: 'agent', role: 'agent', scopes: [] },
        tokenStatus: 'active',
        authMethod: 'token',
      };
    },
    async wake() {
      return { text: '', cursor: 0, changed: false };
    },
    async presencePing(req) {
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
  };
  return { hub, calls };
}

/** An adapter whose `start` emits `started` and then parks until `settle()`. */
function pendingAdapter(id = 'fake'): {
  adapter: HarnessAdapter;
  stops: HarnessSessionRef[];
  started: Promise<void>;
  settle: (err?: Error) => void;
} {
  const ref: HarnessSessionRef = { harness: id, token: 'tok-pending' };
  const stops: HarnessSessionRef[] = [];
  let release: ((err?: Error) => void) | undefined;
  const gate = new Promise<Error | undefined>((r) => {
    release = (err?: Error) => r(err);
  });
  let announce: (() => void) | undefined;
  const started = new Promise<void>((r) => {
    announce = r;
  });
  const adapter: HarnessAdapter = {
    id,
    resumeTier: 'native-token',
    preflight: () => [],
    async start(_args: StartArgs, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef> {
      onEvent({ kind: 'started', ref });
      announce?.();
      const err = await gate;
      if (err !== undefined) throw err;
      return ref;
    },
    async deliver(): Promise<void> {
      // unused by the agent-run loop this phase
    },
    async stop(target: HarnessSessionRef): Promise<void> {
      stops.push(target);
    },
  };
  return { adapter, stops, started, settle: (err?: Error) => release?.(err) };
}

const TEMPLATE = [
  '# brief',
  `order: ${ORDER_TOKEN}`,
  `origin: ${ORIGIN_TOKEN}`,
  `account: ${ACCOUNT_TOKEN}`,
  `shift: ${SHIFT_TOKEN}`,
].join('\n');

/** The default step spec the loop loads: the token brief, no options. */
const baseSpec = (): NormalizedStepSpec => ({ step: 'builder', brief: TEMPLATE, permissions: { extensions: {} } });

interface Harnessed {
  opts: AgentRunLoopOptions;
  records: SessionRecord[];
  errs: string[];
  outs: string[];
}

interface BuildOpts {
  run?: string;
  allowedWorkdirRoots?: string[];
  hub: HubClient;
  adapter?: HarnessAdapter;
  resolution?: AdapterResolution;
  spec?: NormalizedStepSpec | null;
  loadStep?: AgentRunLoopOptions['loadStep'];
  submitGraceMs?: number;
	sleep?: AgentRunLoopOptions['sleep'];
	now?: AgentRunLoopOptions['now'];
  shiftId?: string;
  shiftName?: string;
  shiftOwner?: string;
  consumedVerifier?: AgentRunLoopOptions['consumedVerifier'];
  resolveCrewRosters?: AgentRunLoopOptions['resolveCrewRosters'];
  appendSession?: AgentRunLoopOptions['appendSession'];
  latestSession?: AgentRunLoopOptions['latestSession'];
	latestRunSession?: AgentRunLoopOptions['latestRunSession'];
  dirExists?: AgentRunLoopOptions['dirExists'];
  leaseFactory?: AgentRunLoopOptions['leaseFactory'];
}

function buildOpts(b: BuildOpts): Harnessed {
  const records: SessionRecord[] = [];
  const errs: string[] = [];
  const outs: string[] = [];
  const resolution: AdapterResolution =
    b.resolution ?? { id: b.adapter?.id ?? 'fake', ...(b.adapter !== undefined ? { adapter: b.adapter } : {}), registered: ['fake'] };
  const opts: AgentRunLoopOptions = {
    hub: b.hub,
    workflow: 'wf1',
    run: b.run ?? 'run1',
    holder: HOLDER,
    origin: 'https://hub.example',
    account: 'acct-1',
    ...(b.shiftId !== undefined ? { shiftId: b.shiftId } : {}),
    ...(b.shiftName !== undefined ? { shiftName: b.shiftName } : {}),
    ...(b.shiftOwner !== undefined ? { shiftOwner: b.shiftOwner } : {}),
    cwd: '/fallback/cwd',
    loadStep: b.loadStep ?? (async () => (b.spec === undefined ? baseSpec() : b.spec)),
    resolveAdapter: () => resolution,
    harnessAvailable: (id) => id === 'fake',
    ...(b.consumedVerifier === undefined ? {} : { consumedVerifier: b.consumedVerifier }),
    resolveCrewRosters: b.resolveCrewRosters ?? (() => ({ ok: true, rosters: [] })),
    ...(b.allowedWorkdirRoots === undefined ? {} : { allowedWorkdirRoots: b.allowedWorkdirRoots }),
    appendSession: b.appendSession ?? ((rec) => records.push(rec)),
    ...(b.latestSession === undefined ? {} : { latestSession: b.latestSession }),
		...(b.latestRunSession === undefined ? {} : { latestRunSession: b.latestRunSession }),
    ...(b.dirExists === undefined ? {} : { dirExists: b.dirExists }),
		...(b.leaseFactory === undefined ? {} : { leaseFactory: b.leaseFactory }),
    nextAttempt: () => 3,
    sleep: b.sleep ?? macrotaskSleep,
	now: b.now ?? (() => 1_000),
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    heartbeatIntervalMs: 60_000,
    confirmIntervalMs: 1,
    submitGraceMs: b.submitGraceMs ?? 0,
	recoveryStopGraceMs: 0,
  };
  return { opts, records, errs, outs };
}

const statuses = (records: SessionRecord[]): string[] => records.map((r) => r.status);
const verbs = (calls: Call[]): string[] => calls.map((c) => c.verb);
const resolvedRosters = (rosters: readonly MergedRoster[]): AgentRunLoopOptions['resolveCrewRosters'] =>
  () => ({ ok: true, rosters });

// ---- happy path -------------------------------------------------------------

test('happy path: the turn ends, the confirm poll sees the hub outcome, and the runner submits without releasing', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { hub, calls } = mockHub({
    getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })],
  });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'submitted');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'submitted']);
  // A submitted run is CLOSED — releasing it would be a confusing no-op.
  assert.ok(!verbs(calls).includes('release'));
  // The session was torn down on the way out.
  assert.deepEqual(
    adapter.calls.filter((c) => c.kind === 'stop').length,
    1,
  );
});

test('idle recovery is bounded to primary, one wake, one cold start, then one producer ask', async () => {
  const adapter = createFakeAdapter({
    start: { events: [{ kind: 'turn_ended' }] },
    deliver: { events: [{ kind: 'turn_ended' }] },
  });
  adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
  const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'held');
	assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, 2);
	assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, 1);
	assert.equal(verbs(calls).filter((verb) => verb === 'ask').length, 1);
	const recoveryAsk = JSON.stringify(calls.find((call) => call.verb === 'ask')?.arg);
	assert.match(recoveryAsk, /Harness recovery held pr/u);
	assert.match(recoveryAsk, /after cold-restart/u);
	assert.doesNotMatch(recoveryAsk, /claude|codex|anthropic|openai/iu);
	assert.ok(h.records.some((record) => record.recovery?.phase === 'held'));
  assert.equal(verbs(calls).includes('release'), false);
});

test('recovery wake is delta-only and cold replay preserves only the assignment and verified rejection', async () => {
	const assignment = 'ORIGINAL_ASSIGNMENT_MUST_SURVIVE_COLD_RECOVERY';
	const rejection = 'VERIFIED_REJECTION_MUST_SURVIVE_COLD_RECOVERY';
	const consumedPayload = 'CONSUMED_PAYLOAD_MUST_NOT_ENTER_RECOVERY_PROMPTS';
	const credentialPayload = 'CREDENTIAL_MUST_NOT_ENTER_RECOVERY_PROMPTS';
	const providerToken = 'PROVIDER_TOKEN_MUST_NOT_ENTER_RECOVERY_PROMPTS';
	const configPath = '/CONFIG_PATH_MUST_NOT_ENTER_RECOVERY_PROMPTS';
	const safeWakeFacts = {
		phase: 'wake' as const,
		wakeUsed: true,
		coldRestartUsed: false,
	};
	const unsafeWakeFacts = {
		...safeWakeFacts,
		prompt: assignment,
		consumes: consumedPayload,
		credential: credentialPayload,
		providerToken,
		configPath,
	};
	assert.equal(
		renderRecoveryWake('pr', unsafeWakeFacts),
		renderRecoveryWake('pr', safeWakeFacts),
		'unknown prompt/provider/config fields are not part of the wake allowlist',
	);
	assert.equal(
		renderColdRecoveryAppendix({ ...unsafeWakeFacts, phase: 'cold-restart', coldRestartUsed: true }),
		renderColdRecoveryAppendix({ phase: 'cold-restart', wakeUsed: true, coldRestartUsed: true }),
		'unknown prompt/provider/config fields are not part of the cold appendix allowlist',
	);

	const rejectionReason: ReasonEntry = {
		at: 2_000,
		action: 'reject',
		kind: 'judgment',
		by: 'reviewer',
		text: rejection,
	};
	const adapter = createFakeAdapter({
		token: providerToken,
		start: { events: [{ kind: 'turn_ended' }] },
		deliver: { events: [{ kind: 'turn_ended' }] },
	});
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	const { hub, calls } = mockHub({
		getOrder: [agentOrder({
			workdir: configPath,
			consumes: { plan: consumedPayload, credential: credentialPayload },
			owes: [{ path: 'pr', judgmentRejects: 1, reasons: [rejectionReason] }],
		})],
	});
	const h = buildOpts({
		hub,
		adapter,
		spec: { step: 'builder', brief: `# recovery assignment\n${assignment}`, permissions: { extensions: {} } },
		consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
		submitGraceMs: 0,
		dirExists: () => true, // the sentinel workdir is a secret-leak probe, not a real directory
	});

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	const starts = adapter.calls.filter((call) => call.kind === 'start');
	const deliveries = adapter.calls.filter((call) => call.kind === 'deliver');
	assert.equal(starts.length, 2);
	assert.equal(deliveries.length, 1);
	const wake = deliveries[0]!.message;
	const cold = starts[1]!.args.brief;
	assert.equal(wake, renderRecoveryWake('pr', safeWakeFacts));
	assert.equal(wake.includes(assignment), false);
	assert.equal(wake.includes(rejection), false);
	assert.match(cold, new RegExp(assignment, 'u'));
	assert.match(cold, new RegExp(rejection, 'u'));
	assert.ok(cold.endsWith(
		`---\n\n${renderColdRecoveryAppendix({ phase: 'cold-restart', wakeUsed: true, coldRestartUsed: true })}`,
	));
	for (const secret of [consumedPayload, credentialPayload, providerToken, configPath]) {
		assert.equal(wake.includes(secret), false, `wake omitted ${secret}`);
		assert.equal(cold.includes(secret), false, `cold replay omitted ${secret}`);
	}

	const externallyVisible = JSON.stringify({
		askHold: calls.find((call) => call.verb === 'ask')?.arg,
		logs: [...h.outs, ...h.errs],
		status: projectSession(h.records.at(-1)!),
	});
	for (const payload of [assignment, rejection, consumedPayload, credentialPayload, providerToken, configPath]) {
		assert.equal(externallyVisible.includes(payload), false, `ask/log/status omitted ${payload}`);
	}
});

test('a cold recovery token receives a fresh session birth timestamp', async () => {
	let starts = 0;
	const refs: HarnessSessionRef[] = [
		{ harness: 'fake', token: 'primary-token' },
		{ harness: 'fake', token: 'cold-token' },
	];
	const adapter: HarnessAdapter = {
		id: 'fake',
		resumeTier: 'native-token',
		recoveryPolicy: () => ({ idleTimeoutMs: 1_000 }),
		preflight: () => [],
		async start(_args, onEvent) {
			const ref = refs[starts++]!;
			onEvent({ kind: 'started', ref });
			onEvent({ kind: 'turn_ended' });
			return ref;
		},
		async deliver(_ref, _message, _args, onEvent) {
			onEvent({ kind: 'turn_ended' });
		},
		async stop() {},
	};
	const { hub } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	let clock = 0;
	const h = buildOpts({ hub, adapter, submitGraceMs: 0, now: () => ++clock });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	const primary = h.records.find((record) => record.token === 'primary-token');
	const cold = h.records.find((record) => record.token === 'cold-token');
	assert.ok(primary, 'the primary provider token is persisted');
	assert.ok(cold, 'the cold provider token is persisted');
	assert.ok(cold.createdAt > primary.createdAt, 'the cold provider token has its own birth time');
});

test('recovery-enabled Claude provider tokens and failure payloads never reach worker logs', async () => {
	const sessionTokens = [
		'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
	] as const;
	const providerCwd = '/PROVIDER_CWD_SENTINEL_MUST_NOT_REACH_WORKER_LOGS';
	const stderrPayload = 'PROVIDER_STDERR_SENTINEL_MUST_NOT_REACH_WORKER_LOGS';
	const resultPayload = 'PROVIDER_RESULT_ERROR_SENTINEL_MUST_NOT_REACH_WORKER_LOGS';
	const assistantPayload = 'PROVIDER_ASSISTANT_SENTINEL_MUST_NOT_REACH_WORKER_LOGS';
	const wakeInitializationPayload = 'WAKE_INITIALIZATION_SENTINEL_MUST_NOT_REACH_WORKER_LOGS';
	const coldInitializationPayload = 'COLD_INITIALIZATION_SENTINEL_MUST_NOT_REACH_WORKER_LOGS';
	let queryCalls = 0;
	let starts = 0;
	const queryFactory: ClaudeQueryFactory = ({ options }) => {
		queryCalls += 1;
		if (queryCalls === 2) throw new Error(wakeInitializationPayload);
		if (queryCalls === 3) throw new Error(coldInitializationPayload);
		options.stderr?.(`${stderrPayload}\n`);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				yield {
					type: 'system', subtype: 'init', session_id: options.sessionId, mcp_servers: [],
					claude_code_version: 'provider-version', model: 'provider-model', apiKeySource: 'provider-key-source',
					permissionMode: 'provider-permission', cwd: providerCwd,
				} as unknown as SDKMessage;
				yield {
					type: 'assistant', parent_tool_use_id: null,
					message: { content: [{ type: 'text', text: assistantPayload }] },
				} as unknown as SDKMessage;
				yield {
					type: 'result', subtype: 'error_during_execution', errors: [resultPayload],
				} as unknown as SDKMessage;
			},
			close() {},
		};
	};
	const adapter: HarnessAdapter = {
		id: claudeAdapter.id,
		resumeTier: 'native-token',
		preflight: () => [],
		recoveryPolicy: () => ({ idleTimeoutMs: 1_000 }),
		start: (args, onEvent) => startClaude(args, onEvent, {
			createSessionId: () => sessionTokens[starts++]!,
			loadQuery: async () => queryFactory,
		}),
		deliver: (ref, message, args, onEvent) => deliverClaude(ref, message, args, onEvent, {
			getSessionInfo: async () => ({}),
			loadQuery: async () => queryFactory,
		}),
		stop: (ref) => claudeAdapter.stop(ref),
	};
	const { hub } = mockHub({
		getOrder: [agentOrder({ workdir: process.cwd(), owes: [{ path: 'pr' }] })],
	});
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	assert.equal(queryCalls, 3, 'primary, wake, and cold each reach one query-construction boundary');
	const log = h.errs.join('\n');
	for (const sentinel of [
		...sessionTokens,
		providerCwd,
		stderrPayload,
		resultPayload,
		assistantPayload,
		wakeInitializationPayload,
		coldInitializationPayload,
	]) {
		assert.equal(log.includes(sentinel), false, sentinel);
	}
	assert.match(log, /recovery harness failure category=provider/u);
});

test('a valid policy is not forwarded when zero, multiple, or only empty output paths make recovery ineligible', async () => {
	const scenarios: Array<{ label: string; owes: NonNullable<OrderOpts['owes']> }> = [
		{ label: 'zero outputs', owes: [] },
		{ label: 'multiple outputs', owes: [{ path: 'first' }, { path: 'second' }] },
		{ label: 'only an empty path', owes: [{ path: '' }] },
	];

	for (const scenario of scenarios) {
		const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
		adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
		const { hub, calls } = mockHub({ getOrder: [agentOrder({ owes: scenario.owes })] });
		const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

		assert.equal(await createAgentRunLoop(h.opts).run(), 'no-submit', scenario.label);
		const starts = adapter.calls.filter((call) => call.kind === 'start');
		assert.equal(starts.length, 1, scenario.label);
		assert.equal(starts[0]?.args.recoveryPolicy, undefined, scenario.label);
		assert.equal(adapter.calls.some((call) => call.kind === 'deliver'), false, scenario.label);
		assert.equal(verbs(calls).includes('ask'), false, scenario.label);
		assert.equal(verbs(calls).includes('release'), true, scenario.label);
	}
});

test('one non-empty path among empty entries enables recovery only for the real target', async () => {
	const adapter = createFakeAdapter({
		start: { events: [{ kind: 'turn_ended' }] },
		deliver: { events: [{ kind: 'turn_ended' }] },
	});
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	const { hub, calls } = mockHub({
		getOrder: [agentOrder({ owes: [{ path: '' }, { path: 'pr' }] })],
	});
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	for (const call of adapter.calls) {
		if (call.kind === 'start' || call.kind === 'deliver') {
			assert.deepEqual(call.args.recoveryPolicy, { idleTimeoutMs: 1_000 });
		}
	}
	const recoveryAsk = JSON.stringify(calls.find((call) => call.verb === 'ask')?.arg);
	assert.match(recoveryAsk, /"path":"pr"/u);
	assert.doesNotMatch(recoveryAsk, /"path":""/u);
});

test('a clean wake and cold restart supersede an earlier primary timeout in the hold question', async () => {
	const ref: HarnessSessionRef = { harness: 'fake', token: 'recovery-token' };
	let starts = 0;
	const adapter: HarnessAdapter = {
		id: 'fake',
		resumeTier: 'native-token',
		recoveryPolicy: () => ({ idleTimeoutMs: 1_000 }),
		preflight: () => [],
		async start(_args, onEvent) {
			starts += 1;
			onEvent({ kind: 'started', ref });
			if (starts === 1) throw new HarnessTurnError('idle-timeout', false, 'primary timed out');
			onEvent({ kind: 'turn_ended' });
			return ref;
		},
		async deliver(_ref, _message, _args, onEvent) {
			onEvent({ kind: 'turn_ended' });
		},
		async stop() {},
	};
	const { hub, calls } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	const recoveryAsk = JSON.stringify(calls.find((call) => call.verb === 'ask')?.arg);
	assert.match(recoveryAsk, /after cold-restart/u);
	assert.doesNotMatch(recoveryAsk, /after idle-timeout/u);
});

test('an opted-in permission preflight holds immediately without starting a provider turn', async () => {
	const sentinel = '/RECOVERY_PREFLIGHT_PATH_MUST_NOT_REACH_WORKER_LOGS';
	const adapter = createFakeAdapter();
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	adapter.preflight = () => [{ field: sentinel, message: `policy refused for ${sentinel}` }];
	const { hub, calls } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, 0);
	assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, 0);
	assert.equal(verbs(calls).filter((verb) => verb === 'ask').length, 1);
	assert.equal(h.records.at(-1)?.recovery?.phase, 'held');
	assert.equal(h.records.at(-1)?.recovery?.lastFailure?.category, 'permission-policy');
	const log = [...h.outs, ...h.errs].join('\n');
	assert.equal(log.includes(sentinel), false);
	assert.match(log, /recovery harness failure category=permission-policy \(details redacted\)/u);
});

test('an invalid recovery setting stops a multi-output run before model delivery', async () => {
	const adapter = createFakeAdapter();
	adapter.recoveryPolicy = () => {
		throw new HarnessTurnError('configuration', true, 'invalid host setting');
	};
	const { hub, calls } = mockHub({
		getOrder: [agentOrder({ owes: [{ path: 'first' }, { path: 'second' }] })],
	});
	const h = buildOpts({ hub, adapter });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'incompatible-harness-policy');
	assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, 0);
	assert.equal(verbs(calls).includes('ask'), false);
  assert.equal(verbs(calls).includes('release'), true);
});

test('an invalid recovery setting on one output takes the same immediate durable hold as a terminal provider failure', async () => {
	const adapter = createFakeAdapter();
	adapter.recoveryPolicy = () => {
		throw new HarnessTurnError('configuration', true, 'invalid host setting');
	};
	const { hub, calls } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, 0);
	assert.equal(verbs(calls).filter((verb) => verb === 'ask').length, 1);
	assert.equal(h.records.at(-1)?.recovery?.lastFailure?.category, 'configuration');
});

test('a primary resume-unavailable checkpoint consumes the skipped wake before cold restart', async () => {
	const ref: HarnessSessionRef = { harness: 'fake', token: 'cold-token' };
	let starts = 0;
	const adapter: HarnessAdapter = {
		id: 'fake',
		resumeTier: 'native-token',
		recoveryPolicy: () => ({ idleTimeoutMs: 1_000 }),
		preflight: () => [],
		async start(_args, onEvent) {
			starts += 1;
			if (starts === 1) throw new ResumeUnavailableError('primary session disappeared');
			onEvent({ kind: 'started', ref });
			onEvent({ kind: 'turn_ended' });
			return ref;
		},
		async deliver() {
			throw new Error('the skipped wake must never be delivered');
		},
		async stop() {},
	};
	const { hub } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	assert.equal(starts, 2);
	const cold = h.records.find((record) => record.recovery?.phase === 'cold-restart');
	assert.equal(cold?.recovery?.wakeUsed, true);
	assert.equal(cold?.recovery?.coldRestartUsed, true);
});

test('a terminal primary failure and a restarted terminal checkpoint both hold without extra dispatch', async () => {
	const terminal = new HarnessTurnError('authentication', true, 'structured authentication failure');
	const adapter = createFakeAdapter({ start: { dieWith: terminal.message } });
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	let terminalStarts = 0;
	adapter.start = async () => {
		terminalStarts += 1;
		throw terminal;
	};
	const { hub, calls } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	assert.equal(terminalStarts, 1);
	assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, 0);
	assert.equal(verbs(calls).filter((verb) => verb === 'ask').length, 1);

	const saved: SessionRecord = {
		workflow: 'wf1', run: 'run1', step: 'builder', key: 'k', order: 'wf1/run1', attempt: 1,
		harness: 'fake', token: 'prior-token', cwd: '/fallback/cwd', status: 'turn-ended', createdAt: 1, updatedAt: 1,
		recovery: {
			generation: 'run1', phase: 'primary', wakeUsed: false, coldRestartUsed: false,
			lastFailure: { category: 'authentication', at: 1 },
		},
	};
	const restarted = createFakeAdapter();
	restarted.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	const second = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const secondHarness = buildOpts({ hub: second.hub, adapter: restarted, latestRunSession: () => saved, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(secondHarness.opts).run(), 'held');
	assert.equal(restarted.calls.filter((call) => call.kind === 'start' || call.kind === 'deliver').length, 0);
});

test('restart consumption advances from every durable recovery phase without repeating a provider dispatch', async () => {
	const scenarios: Array<{
		phase: NonNullable<SessionRecord['recovery']>['phase'];
		wakeUsed: boolean;
		coldRestartUsed: boolean;
		starts: number;
		delivers: number;
	}> = [
		{ phase: 'primary', wakeUsed: false, coldRestartUsed: false, starts: 1, delivers: 1 },
		{ phase: 'wake', wakeUsed: true, coldRestartUsed: false, starts: 1, delivers: 0 },
		{ phase: 'cold-restart', wakeUsed: true, coldRestartUsed: true, starts: 0, delivers: 0 },
		{ phase: 'held', wakeUsed: true, coldRestartUsed: true, starts: 0, delivers: 0 },
	];
	for (const scenario of scenarios) {
		const adapter = createFakeAdapter({
			start: { events: [{ kind: 'turn_ended' }] },
			deliver: { events: [{ kind: 'turn_ended' }] },
		});
		adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
		const saved: SessionRecord = {
			workflow: 'wf1', run: 'run1', step: 'builder', key: 'k', order: 'wf1/run1', attempt: 1,
			harness: 'fake', token: 'persisted-token', cwd: '/fallback/cwd', status: 'turn-ended', createdAt: 1, updatedAt: 1,
			recovery: {
				generation: 'run1', phase: scenario.phase, wakeUsed: scenario.wakeUsed,
				coldRestartUsed: scenario.coldRestartUsed,
			},
		};
		const { hub } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
		const h = buildOpts({ hub, adapter, latestRunSession: () => saved, submitGraceMs: 0 });
		assert.equal(await createAgentRunLoop(h.opts).run(), 'held', scenario.phase);
		assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, scenario.starts, scenario.phase);
		assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, scenario.delivers, scenario.phase);
	}
});

test('a fresh run id ignores the prior run checkpoint and receives a new full recovery budget', async () => {
	const stale: SessionRecord = {
		workflow: 'wf1', run: 'run1', step: 'builder', key: 'k', order: 'wf1/run1', attempt: 4,
		harness: 'fake', token: 'prior-run-token', cwd: '/fallback/cwd', status: 'turn-ended', createdAt: 1, updatedAt: 1,
		recovery: {
			generation: 'run1', phase: 'held', wakeUsed: true, coldRestartUsed: true,
			lastFailure: { category: 'idle-timeout', at: 1 },
		},
	};
	const adapter = createFakeAdapter({
		token: 'fresh-run-token',
		start: { events: [{ kind: 'turn_ended' }] },
		deliver: { events: [{ kind: 'turn_ended' }] },
	});
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	const { hub, calls } = mockHub({
		getOrder: [agentOrder({ run: 'run2', owes: [{ path: 'pr' }] })],
	});
	const h = buildOpts({
		hub,
		run: 'run2',
		adapter,
		latestRunSession: (workflow, run, step) => {
			assert.deepEqual([workflow, run, step], ['wf1', 'run2', 'builder']);
			// Defensive regression: even if a reader hands back an old generation,
			// the runner must not inherit its spent wake/cold budget.
			return stale;
		},
		submitGraceMs: 0,
	});

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, 2, 'fresh primary and cold start');
	assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, 1, 'fresh same-session wake');
	assert.equal(verbs(calls).filter((verb) => verb === 'ask').length, 1);
	const recoveryRows = h.records.filter((record) => record.recovery !== undefined);
	assert.ok(recoveryRows.length > 0);
	assert.ok(recoveryRows.every((record) => record.run === 'run2' && record.recovery?.generation === 'run2'));
	const primary = recoveryRows.find((record) => record.recovery?.phase === 'primary');
	assert.equal(primary?.recovery?.wakeUsed, false);
	assert.equal(primary?.recovery?.coldRestartUsed, false);
	assert.equal(
		adapter.calls.some((call) => call.kind === 'deliver' && call.ref.token === stale.token),
		false,
		'the prior generation provider session is not reused by recovery',
	);
});

test('a failed recovery checkpoint releases before provider work, and an activity checkpoint cannot spend another phase', async () => {
	const beforeDispatch = createFakeAdapter();
	beforeDispatch.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	const firstHub = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const first = buildOpts({
		hub: firstHub.hub,
		adapter: beforeDispatch,
		appendSession: () => { throw new Error('fsync unavailable'); },
	});
	assert.equal(await createAgentRunLoop(first.opts).run(), 'session-store-failed');
	assert.equal(beforeDispatch.calls.filter((call) => call.kind === 'start').length, 0);

	const duringActivity = createFakeAdapter({ start: { events: [{ kind: 'activity', at: 6_000, deadlineAt: 7_000 }] } });
	duringActivity.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	let writes = 0;
	const secondHub = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const second = buildOpts({
		hub: secondHub.hub,
		adapter: duringActivity,
		appendSession: () => {
			writes += 1;
			if (writes === 3) throw new Error('activity fsync unavailable');
		},
	});
	assert.equal(await createAgentRunLoop(second.opts).run(), 'session-store-failed');
	assert.equal(duringActivity.calls.filter((call) => call.kind === 'deliver').length, 0);

	const afterTurn = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
	afterTurn.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	let terminalWrites = 0;
	const thirdHub = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	const third = buildOpts({
		hub: thirdHub.hub,
		adapter: afterTurn,
		appendSession: () => {
			terminalWrites += 1;
			if (terminalWrites === 3) throw new Error('turn-ended fsync unavailable');
		},
	});
	assert.equal(await createAgentRunLoop(third.opts).run(), 'session-store-failed');
	assert.equal(afterTurn.calls.filter((call) => call.kind === 'deliver').length, 0);
	assert.equal(verbs(thirdHub.calls).includes('release'), true);
});

test('hub submit and claim loss stay authoritative across persistence failures in primary, wake, and cold phases', async () => {
	const phases = [
		{ phase: 'primary', confirmCall: 1, starts: 1, delivers: 0 },
		{ phase: 'wake', confirmCall: 2, starts: 1, delivers: 1 },
		{ phase: 'cold-restart', confirmCall: 3, starts: 2, delivers: 1 },
	] as const;
	const authorities = [
		{ label: 'accepted submit', outcome: 'submitted' as const, status: 'submitted' as const },
		{ label: 'lost claim', outcome: 'lease-lost' as const, status: 'dead' as const },
	];

	for (const phase of phases) {
		for (const authority of authorities) {
			const adapter = createFakeAdapter({
				start: { events: [{ kind: 'turn_ended' }] },
				deliver: { events: [{ kind: 'turn_ended' }] },
			});
			adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
			const { hub, calls } = mockHub({
				getOrder: (n) => {
					const common = { owes: [{ path: 'pr' }] };
					if (n !== phase.confirmCall) return agentOrder(common);
					return authority.outcome === 'submitted'
						? agentOrder({ ...common, claimed: false, outcome: 'green' })
						: agentOrder({ ...common, claimed: false });
				},
			});
			const h = buildOpts({
				hub,
				adapter,
				submitGraceMs: 0,
				appendSession: (record) => {
					const isTargetPhase = record.recovery?.phase === phase.phase;
					if (isTargetPhase && (record.status === 'turn-ended' || record.status === authority.status)) {
						throw new Error(`${authority.label} ${phase.phase} diagnostic fsync failed`);
					}
				},
			});

			assert.equal(
				await createAgentRunLoop(h.opts).run(),
				authority.outcome,
				`${authority.label} during ${phase.phase}`,
			);
			assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, phase.starts);
			assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, phase.delivers);
			assert.equal(verbs(calls).includes('release'), false, 'authoritative closure must never be released');
		}
	}
});

test('direct submit and claim-loss confirmations stop every started recovery session exactly once', async () => {
	const phases = [
		{ phase: 'primary', confirmCall: 1, starts: 1, delivers: 0 },
		{ phase: 'wake', confirmCall: 2, starts: 1, delivers: 1 },
		{ phase: 'cold-restart', confirmCall: 3, starts: 2, delivers: 1 },
	] as const;
	const authorities = [
		{ label: 'accepted submit', outcome: 'submitted' as const },
		{ label: 'lost claim', outcome: 'lease-lost' as const },
	];

	for (const phase of phases) {
		for (const authority of authorities) {
			const adapter = createFakeAdapter({
				start: { events: [{ kind: 'turn_ended' }] },
				deliver: { events: [{ kind: 'turn_ended' }] },
			});
			adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
			const { hub, calls } = mockHub({
				getOrder: (n) => {
					const common = { owes: [{ path: 'pr' }] };
					if (n !== phase.confirmCall) return agentOrder(common);
					return authority.outcome === 'submitted'
						? agentOrder({ ...common, claimed: false, outcome: 'green' })
						: agentOrder({ ...common, claimed: false });
				},
			});
			const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

			assert.equal(
				await createAgentRunLoop(h.opts).run(),
				authority.outcome,
				`${authority.label} during ${phase.phase}`,
			);
			assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, phase.starts);
			assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, phase.delivers);
			assert.equal(
				adapter.calls.filter((call) => call.kind === 'stop').length,
				phase.starts,
				`each session started through ${phase.phase} is stopped once`,
			);
			assert.equal(verbs(calls).includes('release'), false);
		}
	}
});

test('hung recovery cleanup cannot keep authoritative wake or cold outcomes alive', async () => {
	const phases = [
		{ phase: 'wake', confirmCall: 2, starts: 1, delivers: 1, hungStop: 1 },
		{ phase: 'cold-restart', confirmCall: 3, starts: 2, delivers: 1, hungStop: 2 },
	] as const;
	const authorities = [
		{ label: 'accepted submit', outcome: 'submitted' as const, status: 'submitted' as const },
		{ label: 'lost claim', outcome: 'lease-lost' as const, status: 'dead' as const },
	];

	for (const phase of phases) {
		for (const authority of authorities) {
			const causalOrder: string[] = [];
			let settleLease: ((outcome: LeaseOutcome) => void) | undefined;
			const leaseFactory: NonNullable<AgentRunLoopOptions['leaseFactory']> = (leaseOpts): LeaseLoop => {
				const done = new Promise<LeaseOutcome>((resolve) => {
					settleLease = resolve;
				});
				return {
					async run() {
						const first = await leaseOpts.hub.getOrder({
							workflow: leaseOpts.workflow,
							run: leaseOpts.run,
							...(leaseOpts.holder === undefined ? {} : { holder: leaseOpts.holder }),
						});
						leaseOpts.onOrder?.(first);
						return done;
					},
					stop(reason, options) {
						causalOrder.push(`lease.stop:${reason ?? ''}:${options?.release === false ? 'no-release' : 'release'}`);
						settleLease?.('stopped');
					},
				};
			};
			const adapter = createFakeAdapter({
				start: { events: [{ kind: 'turn_ended' }] },
				deliver: { events: [{ kind: 'turn_ended' }] },
			});
			adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
			const originalStop = adapter.stop.bind(adapter);
			let stopCalls = 0;
			let rejectLateStop: ((reason?: unknown) => void) | undefined;
			adapter.stop = async (ref) => {
				stopCalls += 1;
				await originalStop(ref);
				if (stopCalls === phase.hungStop) {
					const expectedLeaseStop = `lease.stop:${authority.outcome === 'submitted' ? 'submitted' : 'lease-lost'}:no-release`;
					assert.equal(
						causalOrder.at(-1),
						expectedLeaseStop,
						`${phase.phase} cleanup starts only after the authoritative lease stop`,
					);
					causalOrder.push(`adapter.stop:${phase.phase}`);
					await new Promise<void>((_resolve, reject) => {
						rejectLateStop = reject;
					});
				}
			};
			const { hub, calls } = mockHub({
				getOrder: (n) => {
					const common = { owes: [{ path: 'pr' }] };
					if (n !== phase.confirmCall) return agentOrder(common);
					return authority.outcome === 'submitted'
						? agentOrder({ ...common, claimed: false, outcome: 'green' })
						: agentOrder({ ...common, claimed: false });
				},
			});
			const h = buildOpts({ hub, adapter, leaseFactory, submitGraceMs: 0 });

			assert.equal(await createAgentRunLoop(h.opts).run(), authority.outcome);
			assert.deepEqual(causalOrder, [
				`lease.stop:${authority.outcome === 'submitted' ? 'submitted' : 'lease-lost'}:no-release`,
				`adapter.stop:${phase.phase}`,
			]);
			assert.equal(h.records.at(-1)?.status, authority.status);
			assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, phase.starts);
			assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, phase.delivers);
			assert.equal(adapter.calls.filter((call) => call.kind === 'stop').length, phase.starts);
			assert.equal(verbs(calls).includes('release'), false);
			const heartbeatCount = verbs(calls).filter((verb) => verb === 'heartbeat').length;
			await macrotaskSleep();
			assert.equal(verbs(calls).filter((verb) => verb === 'heartbeat').length, heartbeatCount);
			assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, phase.starts);
			assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, phase.delivers);
			assert.equal(verbs(calls).includes('release'), false);
			assert.match(h.errs.join('\n'), /recovery session stop timed out \(details redacted; ignored\)/u);
			assert.ok(rejectLateStop, 'the bounded cleanup began before its timeout');
			const sentinel = 'LATE_PROVIDER_STOP_REJECTION_MUST_NOT_REACH_WORKER_LOGS';
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
			process.on('unhandledRejection', onUnhandled);
			try {
				rejectLateStop?.(new Error(sentinel));
				await macrotaskSleep();
				await macrotaskSleep();
				assert.deepEqual(unhandled, []);
				assert.equal(h.errs.join('\n').includes(sentinel), false);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		}
	}
});

test('lease outcomes that land between recovery phases prevent the next provider dispatch', async () => {
	const transitions = [
		{ nextPhase: 'wake', triggerConfirmCall: 1, starts: 1, delivers: 0 },
		{ nextPhase: 'cold-restart', triggerConfirmCall: 2, starts: 1, delivers: 1 },
	] as const;
	const authorities = [
		{ label: 'accepted submit', outcome: 'submitted' as const, status: 'submitted' as const },
		{ label: 'lost claim', outcome: 'lease-lost' as const, status: 'dead' as const },
	];

	for (const transition of transitions) {
		for (const authority of authorities) {
			let wakeHeartbeat: (() => void) | undefined;
			const sleep: AgentRunLoopOptions['sleep'] = async (ms) => {
				if (ms === 60_000) {
					await new Promise<void>((resolve) => { wakeHeartbeat = resolve; });
					return;
				}
				await macrotaskSleep();
			};
			const adapter = createFakeAdapter({
				start: { events: [{ kind: 'turn_ended' }] },
				deliver: { events: [{ kind: 'turn_ended' }] },
			});
			adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
			const { hub, calls } = mockHub({
				getOrder: (n) => {
					const common = { owes: [{ path: 'pr' }] };
					if (n === transition.triggerConfirmCall) {
						assert.ok(wakeHeartbeat, `heartbeat is parked before ${transition.nextPhase}`);
						wakeHeartbeat();
						return agentOrder(common);
					}
					if (n === transition.triggerConfirmCall + 1) {
						return authority.outcome === 'submitted'
							? agentOrder({ ...common, claimed: false, outcome: 'green' })
							: agentOrder({ ...common, claimed: false });
					}
					return agentOrder(common);
				},
				heartbeat: () => { throw new Error('lease changed between phases'); },
			});
			const h = buildOpts({ hub, adapter, sleep, submitGraceMs: 0 });

			assert.equal(
				await createAgentRunLoop(h.opts).run(),
				authority.outcome,
				`${authority.label} before ${transition.nextPhase}`,
			);
			assert.equal(h.records.at(-1)?.status, authority.status);
			assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, transition.starts);
			assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, transition.delivers);
			assert.equal(verbs(calls).includes('release'), false);
		}
	}
});

test('a signal between primary confirmation and wake prevents another recovery dispatch', async () => {
	const adapter = createFakeAdapter({
		start: { events: [{ kind: 'turn_ended' }] },
		deliver: { events: [{ kind: 'turn_ended' }] },
	});
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	let loop: ReturnType<typeof createAgentRunLoop>;
	const { hub, calls } = mockHub({
		getOrder: (n) => {
			if (n === 1) queueMicrotask(() => loop.stop('inter-phase signal'));
			return agentOrder({ owes: [{ path: 'pr' }] });
		},
	});
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });
	loop = createAgentRunLoop(h.opts);

	assert.equal(await loop.run(), 'killed');
	assert.equal(adapter.calls.filter((call) => call.kind === 'start').length, 1);
	assert.equal(adapter.calls.filter((call) => call.kind === 'deliver').length, 0);
	assert.equal(adapter.calls.filter((call) => call.kind === 'stop').length, 1);
	assert.equal(verbs(calls).filter((verb) => verb === 'release').length, 1);
});

test('recovery teardown failures redact provider-controlled stop prose', async () => {
	const sentinel = 'PROVIDER_STOP_FAILURE_MUST_NOT_REACH_WORKER_LOGS';
	const authorities = [
		{ outcome: 'submitted' as const, status: 'submitted' as const },
		{ outcome: 'lease-lost' as const, status: 'dead' as const },
	];
	for (const authority of authorities) {
		const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
		adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
		const stop = adapter.stop.bind(adapter);
		adapter.stop = async (ref) => {
			await stop(ref);
			throw new Error(sentinel);
		};
		const { hub, calls } = mockHub({
			getOrder: [
				agentOrder({ owes: [{ path: 'pr' }] }),
				authority.outcome === 'submitted'
					? agentOrder({ owes: [{ path: 'pr' }], claimed: false, outcome: 'green' })
					: agentOrder({ owes: [{ path: 'pr' }], claimed: false }),
			],
		});
		const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

		assert.equal(await createAgentRunLoop(h.opts).run(), authority.outcome);
		assert.equal(h.records.at(-1)?.status, authority.status);
		assert.equal(adapter.calls.filter((call) => call.kind === 'stop').length, 1);
		assert.equal(verbs(calls).includes('release'), false);
		const log = h.errs.join('\n');
		assert.equal(log.includes(sentinel), false);
		assert.match(log, /recovery session stop failed \(details redacted; ignored\)/u);
	}
});

test('recovery approval telemetry redacts blocked paths and gatekeeper reasons', async () => {
	const sentinel = '/RECOVERY_BLOCKED_PATH_MUST_NOT_REACH_WORKER_LOGS';
	const ref: HarnessSessionRef = { harness: 'fake', token: 'approval-token' };
	const adapter: HarnessAdapter = {
		id: 'fake',
		resumeTier: 'native-token',
		recoveryPolicy: () => ({ idleTimeoutMs: 1_000 }),
		preflight: () => [],
		async start(args, onEvent) {
			onEvent({ kind: 'started', ref });
			assert.ok(args.approvals);
			const controller = new AbortController();
			const approval = args.approvals({
				toolUseId: 'tool-recovery-approval',
				toolName: 'Read',
				toolInput: { path: sentinel },
				reason: `the harness blocked ${sentinel}`,
				signal: controller.signal,
			});
			await macrotaskSleep();
			controller.abort();
			void approval;
			onEvent({ kind: 'turn_ended' });
			return ref;
		},
		async deliver() {
			throw new HarnessTurnError('permission-policy', true, 'approval gate stopped the recovery turn');
		},
		async stop() {},
	};
	const { hub } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
	hub.requestApproval = async (req) => ({
		text: '',
		ok: true,
		approval: {
			workflow: 'wf1', run: 'run1', toolUseId: req.tool_use_id, step: 'builder',
			toolName: req.tool_name, reason: req.reason, title: req.title ?? '', state: 'pending',
			requestedAt: 1, decidedAt: null, decidedBy: null, note: null,
		},
	});
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'held');
	const log = [...h.outs, ...h.errs].join('\n');
	assert.equal(log.includes(sentinel), false);
	assert.match(log, /recovery approval raised \(details redacted\)/u);
});

test('a 2xx refusal from recovery ask is never recorded as held', async () => {
	const sentinel = 'RECOVERY_ASK_REFUSAL_PROSE_MUST_NOT_REACH_WORKER_LOGS';
	const adapter = createFakeAdapter({
		start: { events: [{ kind: 'turn_ended' }] },
		deliver: { events: [{ kind: 'turn_ended' }] },
	});
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	const { hub, calls } = mockHub({
		getOrder: [agentOrder({ owes: [{ path: 'pr' }] })],
		ask: { ok: false, closed: false, text: sentinel },
	});
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'no-submit');
	assert.equal(h.records.at(-1)?.status, 'dead');
	assert.equal(verbs(calls).includes('release'), true);
	const log = [...h.outs, ...h.errs].join('\n');
	assert.equal(log.includes(sentinel), false);
	assert.match(log, /recovery ask was refused \(details redacted\)/u);
});

test('a thrown recovery ask error is redacted before the order is released', async () => {
	const sentinel = 'RECOVERY_ASK_TRANSPORT_PROSE_MUST_NOT_REACH_WORKER_LOGS';
	const adapter = createFakeAdapter({
		start: { events: [{ kind: 'turn_ended' }] },
		deliver: { events: [{ kind: 'turn_ended' }] },
	});
	adapter.recoveryPolicy = () => ({ idleTimeoutMs: 1_000 });
	const { hub, calls } = mockHub({
		getOrder: [agentOrder({ owes: [{ path: 'pr' }] })],
		ask: new Error(sentinel),
	});
	const h = buildOpts({ hub, adapter, submitGraceMs: 0 });

	assert.equal(await createAgentRunLoop(h.opts).run(), 'hub-unreachable');
	assert.equal(verbs(calls).filter((verb) => verb === 'ask').length, 2);
	assert.equal(verbs(calls).includes('release'), true);
	const log = [...h.outs, ...h.errs].join('\n');
	assert.equal(log.includes(sentinel), false);
	assert.match(log, /recovery ask failed \(details redacted\)/u);
});

test('the additional unbounded final-response evidence event is redacted while progress remains logged', async () => {
  const evidence = 'UNBOUNDED_TYPED_EVIDENCE_MUST_NOT_REACH_THE_WORKER_LOG';
  const progress = 'assistant: bounded adapter progress remains visible';
  const adapter = createFakeAdapter({
    start: {
      events: [
        { kind: 'progress', text: progress },
        { kind: 'assistant_response', text: evidence },
        { kind: 'turn_ended' },
      ],
    },
  });
  const { hub } = mockHub({ getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  await createAgentRunLoop(h.opts).run();

  assert.ok(h.errs.includes(`owenloop work agent-run: ${progress}`));
  assert.ok(h.errs.includes('owenloop work agent-run: final response evidence received (redacted)'));
  assert.equal(h.errs.join('\n').includes(evidence), false);
});

test('the session record carries the resolved harness, its token, the packet cwd, and the injected attempt', async () => {
  const adapter = createFakeAdapter({ id: 'fake', token: 'tok-77' });
  const { hub } = mockHub({ getOrder: [agentOrder({ workdir: '/repo/wt' }), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter, shiftId: 'shf_test', shiftName: 'shift-A', shiftOwner: '/state/shift-a', dirExists: () => true });

  await createAgentRunLoop(h.opts).run();

  const first = h.records[0]!;
  assert.equal(first.harness, 'fake');
  assert.equal(first.token, 'tok-77');
  assert.equal(first.cwd, '/repo/wt');
  assert.equal(first.attempt, 3);
  assert.equal(first.order, 'wf1/run1');
  assert.equal(first.step, 'builder');
  assert.equal(first.createdAt, 1_000);
  assert.equal(first.pid, process.pid);
  assert.equal(first.shiftName, 'shift-A');
  assert.equal(first.shiftOwner, '/state/shift-a');
  assert.equal(first.shiftId, 'shf_test');
});

test('the brief is rendered and the work-holder mount is born bound to this order', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder({ workdir: '/repo/wt', model: 'm-override' }), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({
    hub,
    adapter,
    shiftId: 'shf_1',
    dirExists: () => true,
    spec: {
      step: 'builder',
      brief: TEMPLATE,
      permissions: { tools: ['Read', 'Write'], maxTurns: 4, model: 'm-step', extensions: { custom: 1 } },
    },
  });

  await createAgentRunLoop(h.opts).run();

  const start = adapter.calls.find((c) => c.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  assert.equal(
    start.args.brief,
    ['# brief', 'order: wf1/run1', 'origin: https://hub.example', 'account: acct-1', 'shift: shf_1'].join('\n'),
  );
  assert.equal(start.args.cwd, '/repo/wt');
  assert.deepEqual(start.args.owenloopMcp, {
    command: process.execPath,
    // `--never-release`: this loop's own exec lease is the holder of record.
    args: [resolveOwenloopBin(), 'work', 'hold', '--order', 'wf1/run1', '--origin', 'https://hub.example', '--as', 'acct-1', '--shift=shf_1', '--mcp', '--never-release'],
  });
  // Permissions arrive PRE-NORMALIZED on the step spec — `prepare` already ran
  // `normalizeStepPermissions` over `x.harness`, so this loop passes them
  // through untouched and never performs a vendor-keyed lookup.
  assert.deepEqual(start.args.permissions.tools, ['Read', 'Write']);
  assert.equal(start.args.permissions.maxTurns, 4);
  assert.deepEqual(start.args.permissions.extensions, { custom: 1 });
  // The step spec's model rides inside the permissions...
  assert.equal(start.args.permissions.model, 'm-step');
  // ...and the packet's own `model` field is DELIBERATELY not the override any
  // more. It carries the def's authored tier NAME from the retired scheme
  // (`strong`, `m-override`), which is not a vendor model id; putting it on the
  // wire would send a nonexistent model to the harness. The per-start override
  // now comes only from a `roster` row, and this order carries no
  // capabilities to match one with.
  assert.equal(start.args.model, undefined);
});

// ---- capability routing from real packet data -------------------------------
//
// `capability-model.test.ts` covers the RESOLVER by calling
// `resolveCapabilityCandidates` with literal arguments. These tests cover the
// WIRING instead: that the loop reads `packet.capabilities`, hands them to the
// settings map, puts the winning row on the harness `start` args, tells the hub
// what it picked, and refuses the order outright when no row matches. Without
// them the packet reader is the only unexercised part of the path, and a shift
// that silently ran every order on the harness default would ship green.

/** A merged crew roster produced by the composition root. */
const MAP: MergedRoster = {
  'build:deep': { candidates: [{ harness: 'fake', model: 'claude-opus-5', effort: 'xhigh' }], source: 'test' },
  build: { candidates: [{ harness: 'fake', model: 'claude-sonnet-5', effort: 'high' }], source: 'test' },
  wise: { candidates: [{ harness: 'fake', model: 'claude-fable-5', effort: 'xhigh' }], source: 'test' },
};

/**
 * Resolve one order packet all the way to the harness `start` args.
 *
 * These packets carry `consumes`/`owes` data, so the loop's consume-side gate
 * demands a verifier before any of it can reach a prompt. That gate is not what
 * these tests are about, so it is satisfied with a pass-through that admits the
 * packet unchanged; the refusal behavior has its own tests further down.
 */
async function startArgsFor(o: OrderOpts, map: MergedRoster = MAP): Promise<StartArgs> {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder(o), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({
    hub,
    adapter,
    resolveCrewRosters: resolvedRosters([map]),
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
  });
  await createAgentRunLoop(h.opts).run();
  const start = adapter.calls.find((c) => c.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  return start.args;
}

test('an exact compound row serves the order, and its model and effort ride to the harness', async () => {
  const args = await startArgsFor({ capabilities: ['build:deep'], modifier: 'deep' });
  assert.equal(args.model, 'claude-opus-5');
  assert.equal(args.effort, 'xhigh');
});

test('a compound with no exact row falls back to the bare capability name', async () => {
  // `build:express` has no row of its own; the bare `build` row covers every
  // modifier the operator did not call out.
  const args = await startArgsFor({ capabilities: ['build:express'], modifier: 'express' });
  assert.equal(args.model, 'claude-sonnet-5');
  assert.equal(args.effort, 'high');
});

test('an exact row on a LATER capability beats a bare row on an earlier one', async () => {
  // Both passes run across the whole list before the other is tried. Resolving
  // capability-by-capability instead would hand this order to `build`'s bare
  // row and never see that `wise` was named exactly.
  const args = await startArgsFor({ capabilities: ['build:express', 'wise'] });
  assert.equal(args.model, 'claude-fable-5');
  assert.equal(args.effort, 'xhigh');
});

test('an order carrying no capabilities runs on the harness default, not a guessed model', async () => {
  // Not a failure. A def with no `modifiers:` may author capability-silent
  // steps, and those have always run at whatever model the harness itself
  // defaults to. The loop says so on stderr rather than inventing a row.
  const args = await startArgsFor({ modifier: undefined });
  assert.equal(args.model, undefined);
  assert.equal(args.effort, undefined);
});

test('an order whose capabilities match no row is REFUSED, never run on a default model', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ capabilities: ['paint:deep'] })] });
  const h = buildOpts({ hub, adapter, resolveCrewRosters: resolvedRosters([MAP]) });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'unresolvable-capability');
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0, 'no harness turn was started');
  assert.equal(calls.filter((c) => c.verb === 'release').length, 1, 'the lease went back for another shift to try');
  assert.ok(h.errs.some((l) => l.includes('no crew roster row') && l.includes('paint:deep')));
});

test('a shift with NO roster at all refuses a capability-bearing order', async () => {
  // The map has no built-in default on purpose: a shift that never declared
  // what serves what must say so on its first order, not run everything on a
  // hardcoded model and look like it worked.
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder({ capabilities: ['build:deep'] })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unresolvable-capability');
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
});

test('a capability-bearing order without a crew stamp is released loudly, never routed', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({
    getOrder: [agentOrder({ capabilities: ['build:deep'], omitCrewStamp: true })],
  });
  let resolverCalls = 0;
  const h = buildOpts({
    hub,
    adapter,
    resolveCrewRosters: () => {
      resolverCalls += 1;
      return { ok: true, rosters: [MAP] };
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unstamped-order');
  assert.equal(resolverCalls, 0);
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
  assert.equal(calls.filter((c) => c.verb === 'release').length, 1);
  assert.ok(h.errs.some((line) => line.includes('NO crews stamp') && line.includes('no fallback')));
});

test('empty and malformed crew stamps are released without silently repairing them', async () => {
  for (const crews of [[], ['ok', '  ']]) {
    const adapter = createFakeAdapter();
    const { hub } = mockHub({ getOrder: [agentOrder({ capabilities: ['build:deep'], crews })] });
    let resolverCalls = 0;
    const h = buildOpts({
      hub,
      adapter,
      resolveCrewRosters: () => {
			resolverCalls += 1;
			return { ok: true, rosters: [MAP] };
      },
    });

    assert.equal(await createAgentRunLoop(h.opts).run(), 'unstamped-order');
    assert.equal(resolverCalls, 0, JSON.stringify(crews));
    assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
    assert.ok(h.errs.some((line) => line.includes(JSON.stringify(crews))));
  }
});

test('an unresolvable stamped crew is released with its name and resolution error', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ capabilities: ['build:deep'], crews: ['openai'] })] });
  const h = buildOpts({
    hub,
    adapter,
    resolveCrewRosters: () => ({ ok: false, crew: 'openai', detail: 'invalid crew roster at /tmp/openai.json' }),
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unresolvable-crew');
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
  assert.equal(calls.filter((c) => c.verb === 'release').length, 1);
  assert.ok(h.errs.some((line) => line.includes('openai') && line.includes('invalid crew roster')));
});

test('the stamped crew order is the roster-resolution sequence', async () => {
  const a: MergedRoster = {
    build: { candidates: [{ harness: 'fake', model: 'from-a', effort: 'high' }], source: 'a' },
  };
  const b: MergedRoster = {
    build: { candidates: [{ harness: 'fake', model: 'from-b', effort: 'high' }], source: 'b' },
  };
  const byCrew: Record<string, MergedRoster> = { a, b };

  for (const [crews, model] of [[['a', 'b'], 'from-a'], [['b', 'a'], 'from-b']] as const) {
    const adapter = createFakeAdapter();
    const { hub } = mockHub({
      getOrder: [agentOrder({ capabilities: ['build'], crews: [...crews] }), agentOrder({ claimed: false, outcome: 'green' })],
    });
    let received: readonly string[] | undefined;
    const h = buildOpts({
      hub,
      adapter,
      resolveCrewRosters: (stamp) => {
			received = stamp;
			return { ok: true, rosters: stamp.map((crew) => byCrew[crew]!) };
      },
    });

    assert.equal(await createAgentRunLoop(h.opts).run(), 'submitted');
    const start = adapter.calls.find((call) => call.kind === 'start');
    assert.ok(start !== undefined && start.kind === 'start');
    assert.equal(start.args.model, model);
    assert.deepEqual(received, crews);
  }
});

test('the resolution is reported to the hub BEFORE the harness turn starts', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({
    getOrder: [agentOrder({ capabilities: ['build:deep'] }), agentOrder({ claimed: false, outcome: 'green' })],
  });
  const h = buildOpts({ hub, adapter, resolveCrewRosters: resolvedRosters([MAP]) });

  await createAgentRunLoop(h.opts).run();

  const report = calls.find((c) => c.verb === 'report_resolution');
  assert.ok(report !== undefined, 'the hub was told what this shift picked');
  assert.deepEqual(report.arg, {
    workflow: 'wf1',
    run: 'run1',
    resolution: {
      capability: 'build:deep',
      match: 'exact',
      model: 'claude-opus-5',
      effort: 'xhigh',
      harness: 'fake',
    },
  });
});

test('a bare-row hit reports match `bare`, and a refusal reports match `refused`', async () => {
  const bare = await reportFor({ capabilities: ['build:express'] }, MAP);
  assert.equal(bare?.match, 'bare');
  // The BARE NAME, not the compound — the hub records what actually served.
  assert.equal(bare?.capability, 'build');

  const refused = await reportFor({ capabilities: ['paint:deep'] }, MAP);
  assert.equal(refused?.match, 'refused');
  assert.equal(refused?.capability, 'paint:deep');
  assert.equal(refused?.model, undefined, 'a refusal names no model — none was chosen');
});

test('an order with no capabilities reports nothing — there was no routing decision', async () => {
  assert.equal(await reportFor({}, MAP), undefined);
});

test('a failing report_resolution is logged and the order runs anyway', async () => {
  // Observability must never be able to stop work. The hub verb's own contract
  // says the same on its side; this is the client half of that promise.
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ capabilities: ['build:deep'] }), agentOrder({ claimed: false, outcome: 'green' })],
  });
  hub.reportResolution = async (): Promise<never> => {
    throw new HubError(500, 'report_resolution blew up');
  };
  const h = buildOpts({ hub, adapter, resolveCrewRosters: resolvedRosters([MAP]) });

  await createAgentRunLoop(h.opts).run();

  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 1, 'the turn still ran');
  assert.ok(h.errs.some((l) => l.includes('reporting the resolution') && l.includes('continuing')));
});

/** Run one order and return the `resolution` payload the loop reported, if any. */
async function reportFor(
  o: OrderOpts,
  map: MergedRoster,
): Promise<Record<string, unknown> | undefined> {
  const { hub, calls } = mockHub({ getOrder: [agentOrder(o), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter: createFakeAdapter(), resolveCrewRosters: resolvedRosters([map]) });
  await createAgentRunLoop(h.opts).run();
  const report = calls.find((c) => c.verb === 'report_resolution');
  if (report === undefined) return undefined;
  return (report.arg as { resolution: Record<string, unknown> }).resolution;
}

test('the run modifier reaches the brief, and an engine escalation says so', async () => {
  const plain = await startArgsFor({ capabilities: ['build:deep'], modifier: 'deep' });
  assert.match(plain.brief, /^Routing: this run was started at the 'deep' depth modifier\.$/mu);
  assert.ok(!plain.brief.includes('RE-OFFERED'), 'a first pass is not announced as a recovery attempt');

  const escalated = await startArgsFor({ capabilities: ['build:deep'], modifier: 'deep', escalated: true });
  assert.match(escalated.brief, /RE-OFFERED at a deeper modifier/u);

  // No modifier on the packet means no routing line at all — a run started
  // without one is not "at the default depth", it is depth-less.
  const none = await startArgsFor({ capabilities: ['build:deep'] });
  assert.ok(!none.brief.includes('Routing:'));
});

/**
 * Run one order under a caller-supplied adapter and return the brief the harness
 * was started with.
 *
 * `startArgsFor` builds its own bare fake, and a bare fake cannot answer the
 * containment question at all -- which is the whole subject of the tests below.
 */
async function briefUnder(adapter: FakeAdapter, spec?: NormalizedStepSpec): Promise<string> {
  const { hub } = mockHub({ getOrder: [agentOrder({}), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter, ...(spec !== undefined ? { spec } : {}) });
  await createAgentRunLoop(h.opts).run();
  const start = adapter.calls.find((c) => c.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  return start.args.brief;
}

test("a step that cannot write is told so, and the ADAPTER decides on the step's own permissions", async () => {
  // Two claims in one test because they are one mechanism: the loop must not
  // decide containment itself -- only the adapter knows what its own sandbox
  // grants -- and the answer it gives must be the one that reaches the brief.
  const asked: StepPermissions[] = [];
  const base = createFakeAdapter();
  const adapter: FakeAdapter = {
    ...base,
    deniesAllWrites: (permissions) => {
      asked.push(permissions);
      return true;
    },
  };
  const spec: NormalizedStepSpec = {
    step: 'builder',
    brief: TEMPLATE,
    permissions: { extensions: { marker: 'this-step' } },
  };

  const brief = await briefUnder(adapter, spec);

  assert.match(brief, /^Workspace: this step's sandbox grants it no writable location/mu);
  assert.equal(asked.length, 1, 'asked exactly once, for this turn');
  assert.equal(
    asked[0]?.extensions?.['marker'],
    'this-step',
    "the adapter is asked about THIS step's permissions, not some ambient default",
  );
});

test('a step not known to be shut out is told nothing about its workspace', async () => {
  // Both silences, because they must stay the same silence. `false` is not a
  // claim that writing is permitted, and an adapter that does not model a
  // sandbox at all must not be read as either answer.
  const answered: FakeAdapter = { ...createFakeAdapter(), deniesAllWrites: () => false };
  assert.ok(!(await briefUnder(answered)).includes('Workspace:'), 'a false answer renders nothing');

  const silent = createFakeAdapter();
  assert.equal(silent.deniesAllWrites, undefined, 'the bare fake models no sandbox');
  assert.ok(!(await briefUnder(silent)).includes('Workspace:'), 'an absent member renders nothing');
});

// ---- the invariant: the hub decides, never the harness -----------------------

test('a turn that FAILED still confirms, and a landed submit makes it a success', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'progress', text: 'working' }], dieWith: 'harness died' } });
  const { hub } = mockHub({ getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'submitted');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'submitted']);
  assert.ok(h.errs.some((l) => l.includes('harness died') && l.includes('confirming with the hub')));
});

test('a clean turn with no hub outcome is a FAILURE: no-submit, released for re-offer', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'no-submit');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'dead']);
  assert.ok(verbs(calls).includes('release'));
});

test('a capability-silent no-submit names the provider model and bounded harness failures locally', async () => {
  const longFailure = (label: string) => `${label}: ${'x'.repeat(1_000)}`;
  const adapter = createFakeAdapter({
    start: {
      events: [
	{
	  kind: 'started',
	  ref: { harness: 'fake', token: 'capability-silent-session' },
	  model: 'claude-ox-alpha',
	},
	{
	  kind: 'progress',
	  text: 'stderr: [claude-code:unrecognized_model]',
	  failure: '[claude-code:unrecognized_model]',
	},
	{ kind: 'progress', text: 'assistant error: model_not_found', failure: 'model_not_found' },
	{ kind: 'progress', text: 'assistant error: model_not_found', failure: 'model_not_found' },
	{ kind: 'progress', text: 'stderr: first long failure', failure: longFailure('first') },
	{ kind: 'progress', text: 'stderr: second long failure', failure: longFailure('second') },
	{ kind: 'progress', text: 'stderr: third long failure', failure: longFailure('third') },
	{ kind: 'exited', exitCode: 0 },
	{ kind: 'turn_ended' },
      ],
    },
  });
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'no-submit');
  const starts = adapter.calls.filter((call) => call.kind === 'start');
  assert.equal(starts.length, 1, 'the capability-silent order starts exactly one harness turn');
  const start = starts[0];
  assert.ok(start !== undefined && start.kind === 'start');
  assert.equal(start.args.model, undefined);
  assert.equal(start.args.effort, undefined);
  const claimWarning = h.errs.find((line) => line.startsWith('CAPABILITY-SILENT'));
  assert.ok(claimWarning?.includes('wf1/run1'));
  assert.ok(claimWarning?.includes("step 'builder'"));
  assert.ok(claimWarning?.includes('declares no capabilities'));
  assert.ok(claimWarning?.includes("selected harness 'fake'"));
  assert.ok(claimWarning?.includes('no roster model or effort override'));
  assert.ok(claimWarning?.includes('will choose its own default model'));
  const terminal = h.errs.at(-1) ?? '';
  assert.match(terminal, /^CAPABILITY-SILENT/);
  assert.match(terminal, /claude-ox-alpha/);
  assert.match(terminal, /unrecognized_model|model_not_found/);
  assert.match(terminal, /releasing for re-offer/);
  const failureMarker = 'harness failure context: ';
  const failureStart = terminal.indexOf(failureMarker);
  const failureEnd = terminal.indexOf('; no submit reached the hub', failureStart);
  assert.ok(failureStart >= 0 && failureEnd > failureStart, 'the terminal message includes the failure tail');
  const failureTail = terminal.slice(failureStart + failureMarker.length, failureEnd);
  assert.ok(failureTail.length <= 2_000, 'the aggregate failure tail is bounded to 2,000 characters');
  assert.equal((failureTail.match(/model_not_found/gu) ?? []).length, 1, 'duplicate failures are removed from the tail');
  assert.ok(failureTail.endsWith('…'), 'an oversized aggregate failure tail is visibly truncated');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'dead']);
  assert.equal(calls.filter((call) => call.verb === 'report_resolution').length, 0);
  const releases = calls.filter((call) => call.verb === 'release');
  assert.deepEqual(releases.map((call) => call.arg), [
    { workflow: 'wf1', run: 'run1', reason: 'capability-silent-no-submit' },
  ]);
});

test('a capability-silent warning preserves authored model and effort settings', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { hub } = mockHub({ getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({
    hub,
    adapter,
    spec: {
      ...baseSpec(),
      permissions: { extensions: {}, model: 'claude-authored', effort: 'high' },
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'submitted');
  const starts = adapter.calls.filter((call) => call.kind === 'start');
  assert.equal(starts.length, 1);
  const start = starts[0];
  assert.ok(start !== undefined && start.kind === 'start');
  assert.equal(start.args.model, undefined, 'no roster model is injected');
  assert.equal(start.args.effort, undefined, 'no roster effort is injected');
  assert.equal(start.args.permissions.model, 'claude-authored');
  assert.equal(start.args.permissions.effort, 'high');
  const warning = h.errs.find((line) => line.startsWith('CAPABILITY-SILENT'));
  assert.ok(warning?.includes("authored step model 'claude-authored' and effort 'high' remains in effect"));
  assert.ok(!warning?.includes('will choose its own default model'));
});

test('a capability-silent no-submit names missing model and failure context instead of guessing', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { hub } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-submit');
  const terminal = h.errs.at(-1) ?? '';
  assert.match(terminal, /model id not reported by the harness/);
  assert.match(terminal, /no specific harness failure was reported/);
});

test('a capability-bearing no-submit keeps the generic terminal message', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { hub, calls } = mockHub({
    getOrder: [agentOrder({ capabilities: ['build'], crews: ['test-crew'] }), agentOrder()],
  });
  const h = buildOpts({ hub, adapter, resolveCrewRosters: resolvedRosters([MAP]) });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-submit');
  const terminal = h.errs.at(-1) ?? '';
  assert.match(terminal, /the turn ended and no submit reached the hub within the confirm grace/);
  assert.ok(!terminal.includes('CAPABILITY-SILENT'));
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    { workflow: 'wf1', run: 'run1', reason: 'no-submit' },
  ]);
});

test('start() rejecting as unresumable is a cold-start failure: dead, released, and never crashes', async () => {
  const adapter = createFakeAdapter({ start: { resumeUnavailable: true } });
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'no-submit');
  // No `started` event ever fired, so there is no `active` record — but the
  // attempt is still on the record so the store shows it happened and died.
  assert.deepEqual(statuses(h.records), ['turn-ended', 'dead']);
  assert.equal(h.records[0]!.harness, 'fake');
  assert.equal(h.records[0]!.token, '');
  assert.ok(h.errs.some((l) => l.includes('could not resume the session')));
  assert.ok(verbs(calls).includes('release'));
});

test('cold start requires a durable active row before provider work', async () => {
  const ref: HarnessSessionRef = { harness: 'fake', token: 'cold-session' };
  let providerWorkStarted = false;
  const stops: HarnessSessionRef[] = [];
  const adapter: HarnessAdapter = {
    id: 'fake',
    resumeTier: 'native-token',
    preflight: () => [],
    async start(_args, onEvent) {
      onEvent({ kind: 'started', ref });
      providerWorkStarted = true;
      return ref;
    },
    async deliver() {
      assert.fail('cold-start persistence failure must not deliver');
    },
    async stop(target) {
      stops.push(target);
    },
  };
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const attemptedStatuses: string[] = [];
  const h = buildOpts({
    hub,
    adapter,
    appendSession: (record) => {
      attemptedStatuses.push(record.status);
      if (record.status === 'active') throw new Error('active fsync failed');
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'session-store-failed');
  assert.equal(providerWorkStarted, false);
  assert.deepEqual(attemptedStatuses, ['active']);
  assert.deepEqual(stops, [ref]);
  assert.equal(verbs(calls).filter((verb) => verb === 'release').length, 1);
  assert.equal(verbs(calls).filter((verb) => verb === 'get_order').length, 1, 'the confirm phase never starts');
  assert.ok(h.errs.some((line) => line.includes('durable active-session persistence failed before provider delivery')));
});

test('resume requires a durable active row before provider delivery', async () => {
  const previous: SessionRecord = {
    workflow: 'wf1',
    run: 'run1',
    step: 'builder',
    order: 'wf1/run1',
    attempt: 2,
    harness: 'fake',
    token: 'resume-session',
    cwd: '/fallback/cwd',
    status: 'turn-ended',
    createdAt: 500,
    deliveredReasonAt: 10,
    updatedAt: 800,
  };
  const first = agentOrder({ owes: [{ path: 'out' }] });
  assert.ok(first.order !== null);
  first.order.owes[0]!.reasons = [{
    at: 20,
    action: 'reject',
    kind: 'judgment',
    by: 'reviewer',
    text: 'revise the output',
  }];
  let deliveries = 0;
  const stops: HarnessSessionRef[] = [];
  const adapter: HarnessAdapter = {
    id: 'fake',
    resumeTier: 'native-token',
    preflight: () => [],
    async start() {
      assert.fail('a resumable session must not cold-start');
    },
    async deliver() {
      deliveries += 1;
    },
    async stop(target) {
      stops.push(target);
    },
  };
  const { hub, calls } = mockHub({ getOrder: [first] });
  const attemptedStatuses: string[] = [];
  const h = buildOpts({
    hub,
    adapter,
    latestSession: () => previous,
    dirExists: () => true,
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
    appendSession: (record) => {
      attemptedStatuses.push(record.status);
      if (record.status === 'active') throw new Error('resume active fsync failed');
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'session-store-failed');
  assert.equal(deliveries, 0);
  assert.deepEqual(attemptedStatuses, ['active']);
  assert.deepEqual(stops, [{ harness: 'fake', token: 'resume-session' }]);
  assert.equal(verbs(calls).filter((verb) => verb === 'release').length, 1);
  assert.equal(verbs(calls).filter((verb) => verb === 'get_order').length, 1, 'the confirm phase never starts');
});

test('the confirm poll treats a lost claim as lease-lost and does NOT release', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), noHold({ claimed: false })] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'lease-lost');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'dead']);
  assert.ok(!verbs(calls).includes('release'));
});

// ---- lease terminal mid-turn ------------------------------------------------

test('the lease going terminal mid-turn tears the session down and maps the outcome', async () => {
  const p = pendingAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder()],
    heartbeat: () => {
      throw new HubError(403, 'forbidden');
    },
  });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  const outcome = await running;

  assert.equal(outcome, 'ownership-error');
  assert.deepEqual(statuses(h.records), ['active', 'dead']);
  assert.equal(p.stops.length, 1);
  // The turn never settled — the loop did not wait for it.
  p.settle();
});

test('a mid-turn hub outcome is a SUCCESS, not a lost lease', async () => {
  const p = pendingAdapter();
  let beats = 0;
  const { hub, calls } = mockHub({
    // First contact holds; the post-failure classify sees the finished order.
    getOrder: [agentOrder(), noHold({ claimed: false, outcome: 'green' })],
    heartbeat: () => {
      beats += 1;
      throw new Error('lease gone');
    },
  });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  const outcome = await running;

  assert.equal(outcome, 'submitted');
  assert.equal(beats, 1);
  assert.deepEqual(statuses(h.records), ['active', 'submitted']);
  assert.equal(p.stops.length, 1);
  assert.ok(!verbs(calls).includes('release'));
  p.settle();
});

// ---- first contact ----------------------------------------------------------

test('first contact: an already-finished order maps to completed with no adapter start', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [noHold({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'completed');
  assert.deepEqual(adapter.calls, []);
  assert.deepEqual(h.records, []);
});

test('first contact: an unclaimed lease with no outcome maps to lease-lost', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [noHold({ claimed: false })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'lease-lost');
  assert.deepEqual(adapter.calls, []);
});

test('first contact: a 403 maps to ownership-error', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [new HubError(403, 'forbidden')] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'ownership-error');
});

// ---- operator-declared work roots -------------------------------------------
//
// The policy the OPERATOR of this machine set, not the hub. A denial is a
// RELEASE and it lands BEFORE the step spec is loaded and before any provider
// session opens, so a machine that was never configured to host this tree
// spends nothing on it.

test('a packet workdir outside every declared root is released before any session opens', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ workdir: '/elsewhere/proj' })] });
  const h = buildOpts({ hub, adapter, allowedWorkdirRoots: ['/allowed'] });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'workdir-denied');
  assert.deepEqual(adapter.calls, []);
  assert.equal(h.records.length, 0);
  assert.ok(verbs(calls).includes('release'));
});

test('a packet workdir inside a declared root proceeds normally', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ workdir: '/allowed/proj/wt' }), agentOrder({ claimed: false, outcome: 'green' })],
  });
  const h = buildOpts({ hub, adapter, allowedWorkdirRoots: ['/allowed'], dirExists: () => true });

  await createAgentRunLoop(h.opts).run();
  assert.equal(h.records[0]!.cwd, '/allowed/proj/wt');
});

test('a packet that names NO workdir is never denied, whatever the roots are', async () => {
  // The fallback is `<workRoot>/<workflow>/<run>/` — a directory owenloop
  // ITSELF created under the operator's own cache root. Denying that would deny
  // every agent order on any machine that declared a root at all.
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter, allowedWorkdirRoots: ['/allowed'] });

  await createAgentRunLoop(h.opts).run();
  assert.equal(h.records[0]!.cwd, '/fallback/cwd');
});

// ---- a hub-named workdir that no longer exists (#301) -----------------------
//
// The hub resolves `workdirFrom:` from an artifact VALUE, which can outlive the
// directory it names: a cleanup step reclaims a worktree, then a rejection
// re-arms an earlier step whose workdir was that worktree. Opening a harness
// session there fails inside the harness with a message that says nothing
// about the cwd. The loop must refuse BEFORE the step spec is loaded and
// before any session opens, and release with a reason that names the path —
// that reason is what the hub surfaces in `routing alerts`. These tests use
// real directories under the OS temp root so the DEFAULT existence check is
// the thing under test.

let workdirRoot: string | undefined;
afterEach(() => {
  if (workdirRoot !== undefined) rmSync(workdirRoot, { recursive: true, force: true });
  workdirRoot = undefined;
});

test('a packet workdir that does not exist is released with a reason naming the path — no spec load, no session', async () => {
  workdirRoot = mkdtempSync(join(tmpdir(), 'owenloop-agent-workdir-'));
  const reclaimed = join(workdirRoot, 'wt', 'flow-reclaimed');
  assert.equal(existsSync(reclaimed), false);
  const adapter = createFakeAdapter();
  let specLoads = 0;
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ workdir: reclaimed })] });
  const h = buildOpts({
    hub,
    adapter,
    loadStep: async () => {
      specLoads += 1;
      return baseSpec();
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'workdir-missing');
  assert.deepEqual(adapter.calls, [], 'no harness session opened');
  assert.equal(h.records.length, 0, 'no session record written');
  assert.equal(specLoads, 0, 'the step spec was never loaded');
  const releases = calls.filter((c) => c.verb === 'release');
  assert.equal(releases.length, 1, 'exactly one targeted release');
  assert.deepEqual(releases[0]!.arg, {
    workflow: 'wf1',
    run: 'run1',
    reason: `step workdir no longer exists: ${reclaimed}`,
  });
  const line = h.errs.find((l) => /no longer exists/.test(l));
  assert.ok(line !== undefined, h.errs.join('\n'));
  assert.match(line, /step 'builder'/);
  assert.match(line, /wf1\/run1/);
  assert.ok(line.includes(reclaimed), line);
});

test('a packet workdir that is a plain FILE is released the same way — a file is not a directory', async () => {
  workdirRoot = mkdtempSync(join(tmpdir(), 'owenloop-agent-workdir-'));
  const file = join(workdirRoot, 'not-a-dir');
  writeFileSync(file, '');
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ workdir: file })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'workdir-missing');
  assert.deepEqual(adapter.calls, []);
  assert.equal(h.records.length, 0);
  const releases = calls.filter((c) => c.verb === 'release');
  assert.equal(releases.length, 1);
  assert.equal((releases[0]!.arg as { reason?: string }).reason, `step workdir no longer exists: ${file}`);
});

test('a packet workdir that exists opens the session there with no release and no warning — behaviour unchanged', async () => {
  workdirRoot = mkdtempSync(join(tmpdir(), 'owenloop-agent-workdir-'));
  const present = join(workdirRoot, 'wt', 'flow-present');
  mkdirSync(present, { recursive: true });
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ workdir: present }), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'submitted');
  assert.equal(h.records[0]!.cwd, present);
  assert.equal(calls.filter((c) => c.verb === 'release').length, 0);
  assert.deepEqual(h.errs.filter((l) => /no longer exists/.test(l)), []);
});

test('the roots check runs first: a workdir that is both outside the roots and missing is workdir-denied', async () => {
  // Policy before existence: a machine never configured to host the tree says
  // so, and "missing" would send the operator looking at the wrong thing.
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ workdir: '/elsewhere/definitely/missing' })] });
  const h = buildOpts({ hub, adapter, allowedWorkdirRoots: ['/allowed'] });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'workdir-denied');
  assert.deepEqual(adapter.calls, []);
  const releases = calls.filter((c) => c.verb === 'release');
  assert.equal((releases[0]!.arg as { reason?: string }).reason, 'workdir-denied');
});

test('a packet that names NO workdir is never existence-checked: opts.cwd is the fallback, not a claim', async () => {
  // `opts.cwd` is the worker's own fallback directory, not hub-supplied, so it
  // is out of scope for the #301 check — the existing '/fallback/cwd' tests
  // above already run against a path that does not exist on disk.
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'submitted');
  assert.equal(h.records[0]!.cwd, '/fallback/cwd');
  assert.equal(calls.filter((c) => c.verb === 'release').length, 0);
});

// ---- release-and-hand-back paths --------------------------------------------

test('a command order is a misroute: released, nothing started', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ worker: 'command' })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'misroute');
  assert.deepEqual(adapter.calls, []);
  assert.ok(verbs(calls).includes('release'));
});

test('a null order packet is a misroute too', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [noHold({ claimed: true })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'misroute');
});

test('no template for the step releases the order for the pickup window', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, adapter, spec: null });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-template');
  assert.deepEqual(adapter.calls, []);
  assert.ok(verbs(calls).includes('release'));
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    { workflow: 'wf1', run: 'run1', reason: 'no-template' },
  ]);
});

test('a throwing step loader is treated as no-template, not as a crash', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({
    hub,
    adapter,
    loadStep: async () => {
      throw new Error('cache exploded');
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-template');
  assert.ok(h.errs.some((l) => l.includes('cache exploded')));
});

test('an unregistered harness id fails honestly, naming the id and what IS registered', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, resolution: { id: 'ghost', registered: ['fake', 'other'] } });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-harness');
  const line = h.errs.find((l) => l.includes('no adapter registered'));
  assert.ok(line !== undefined);
  assert.ok(line.includes("'ghost'"));
  assert.ok(line.includes('fake, other'));
  assert.ok(verbs(calls).includes('release'));
});

test('an unsupported harness policy starts nothing, reports every reason, and releases the claim', async () => {
  const adapter = createFakeAdapter();
  adapter.preflight = () => [
    { field: 'tools', message: 'tool allow-lists are unsupported' },
    { field: 'network', message: "network 'owenloop-only' is unsupported" },
  ];
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({
    hub,
    adapter,
    spec: {
      ...baseSpec(),
      permissions: { tools: [], network: 'owenloop-only', extensions: {} },
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'incompatible-harness-policy');
  assert.deepEqual(adapter.calls, [], 'preflight runs before cold start or resume');
  assert.ok(verbs(calls).includes('release'));
  assert.ok(h.errs.some((line) => line.includes('(tools): tool allow-lists are unsupported')));
  assert.ok(h.errs.some((line) => line.includes("(network): network 'owenloop-only' is unsupported")));
});

test('unverified consumed values and complete rejection threads are refused before prompt rendering or adapter start', async () => {
  const adapter = createFakeAdapter();
  const packetResponse = agentOrder();
  const packet = packetResponse.order!;
  packet.consumes = { input: 'dynamic-value' };
  packet.owes = [{
    path: 'out',
    judgmentRejects: 0,
    schemaRejects: 1,
    reasons: [
      { at: 1, action: 'schema-reject', kind: 'validation', by: 'untrusted-transport', text: 'untrusted-rejection-marker' },
      { at: 2, action: 'schema-reject', kind: 'validation', by: 'engine', text: 'second-reason' },
    ],
    proof: '{invalid-proof}',
  }];
  const { hub, calls } = mockHub({ getOrder: [packetResponse] });
  let seenReasons = 0;
  const h = buildOpts({
    hub,
    adapter,
    consumedVerifier: async (order) => {
      seenReasons = order.owes[0]!.reasons.length;
      return { ok: false, reason: "consumed artifact refusal (signature) for wf1/run1 step 'builder' artifact 'out': rejection proof did not verify" };
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unverified-consumed');
  assert.equal(seenReasons, 2, 'the gate receives the complete reason thread before replay truncation');
  assert.deepEqual(adapter.calls, [], 'the refused packet never starts an adapter session');
  assert.ok(verbs(calls).includes('release'));
  assert.ok(h.errs.some((line) => line.includes('rejection proof did not verify')));
});

// ---- stop() -----------------------------------------------------------------

test('stop() tears the session down and releases the order', async () => {
  const p = pendingAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  loop.stop('signal');
  const outcome = await running;

  assert.equal(outcome, 'killed');
  assert.equal(p.stops.length, 1);
  assert.ok(verbs(calls).includes('release'));
  p.settle();
});

test('stop() is idempotent — a second call tears nothing down twice', async () => {
  const p = pendingAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  loop.stop('signal');
  loop.stop('signal');
  await running;

  assert.equal(p.stops.length, 1);
  p.settle();
});

// ---- confirmOutcome, directly -----------------------------------------------

test('confirmOutcome: an outcome on the lease answers submitted on the first poll', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ claimed: false, outcome: 'green' })] });
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => 0,
    err: () => undefined,
    intervalMs: 1,
    graceMs: 10_000,
  });
  assert.equal(got, 'submitted');
  assert.equal(calls.length, 1);
});

test('confirmOutcome: it polls until the grace expires, then answers no-submit', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  let t = 0;
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => {
      t += 1;
      return t;
    },
    err: () => undefined,
    intervalMs: 1,
    graceMs: 3,
  });
  assert.equal(got, 'no-submit');
  // now() #1 sets the deadline at 4; the poll's checks land on 2, 3, 4.
  assert.equal(calls.length, 3);
});

test('confirmOutcome: a throwing get_order is transient — it keeps polling, it never releases', async () => {
  const { hub, calls } = mockHub({
    getOrder: (n) => (n === 0 ? new Error('boom') : agentOrder({ claimed: false, outcome: 'green' })),
  });
  const errs: string[] = [];
  let t = 0;
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => t++,
    err: (l) => errs.push(l),
    intervalMs: 1,
    graceMs: 100,
  });
  assert.equal(got, 'submitted');
  assert.equal(calls.length, 2);
  assert.ok(errs.some((l) => l.includes('confirm get_order failed') && l.includes('boom')));
});

test('confirmOutcome: cancelled() short-circuits before any hub call', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => 0,
    err: () => undefined,
    intervalMs: 1,
    graceMs: 10_000,
    cancelled: () => true,
  });
  assert.equal(got, 'no-submit');
  assert.deepEqual(calls, []);
});

test('a plain Error and a ResumeUnavailableError take the SAME settle path — nothing branches on the shape', async () => {
  const shapes: Array<{ label: string; err: Error }> = [
    { label: 'plain', err: new Error('plain failure') },
    { label: 'unresumable', err: new ResumeUnavailableError('no session') },
  ];
  for (const shape of shapes) {
    const p = pendingAdapter();
    const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
    const h = buildOpts({ hub, adapter: p.adapter });
    const running = createAgentRunLoop(h.opts).run();
    await p.started;
    p.settle(shape.err);
    assert.equal(await running, 'no-submit', shape.label);
    assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'dead'], shape.label);
    assert.ok(verbs(calls).includes('release'), shape.label);
  }
});

// ---- the shape contract reaches the harness ---------------------------------

test('a declared owed schema travels from the order packet into the rendered brief', () => {
  // The renderer and the projection are each covered on their own; this pins
  // the seam BETWEEN them. `briefOwes` is module-private and reshapes the
  // packet's owes into the brief spec, so a field the engine projects and the
  // renderer knows how to print still reaches nobody unless it is copied here.
  // That omission is silent — nothing fails, the agent is just never told the
  // shape, which is the exact defect this whole change exists to close.
  const schema = { type: 'object', required: ['url'], properties: { url: { type: 'string' } } };
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ owes: [{ path: 'pr', schema, schemaAppliesTo: 'value' }] })],
  });
  const h = buildOpts({ hub, adapter });

  return createAgentRunLoop(h.opts)
    .run()
    .then(() => {
      const start = adapter.calls.find((c) => c.kind === 'start');
      assert.ok(start && start.kind === 'start', 'the adapter was started');
      assert.match(start.args.brief, /The value you submit to `pr` must satisfy this JSON Schema\./);
      assert.ok(start.args.brief.includes(JSON.stringify(schema, null, 2)), 'the schema arrives whole');
    });
});

test('a collection member schema keeps its `member` wording end to end', () => {
  const schema = { type: 'object', required: ['url'] };
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ owes: [{ path: 'source[]', schema, schemaAppliesTo: 'member' }] })],
  });
  const h = buildOpts({ hub, adapter });

  return createAgentRunLoop(h.opts)
    .run()
    .then(() => {
      const start = adapter.calls.find((c) => c.kind === 'start');
      assert.ok(start && start.kind === 'start');
      assert.match(start.args.brief, /Each member you emit into `source\[\]` must satisfy this JSON Schema/);
    });
});

test('an order whose owes declare no schema renders no shape claim', () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
  const h = buildOpts({ hub, adapter });

  return createAgentRunLoop(h.opts)
    .run()
    .then(() => {
      const start = adapter.calls.find((c) => c.kind === 'start');
      assert.ok(start && start.kind === 'start');
      assert.ok(!/JSON Schema/.test(start.args.brief), 'silence, not a claim of being unconstrained');
    });
});
