/**
 * Unit coverage for the Claude Code adapter's two pure decisions: the child
 * environment strip (`buildChildEnv`) and the step-def → SDK option mapping
 * (`buildClaudeOptions`). No SDK process, no network, no login — that is the
 * whole point of keeping those two functions pure.
 *
 * Bags are fed through the REAL `normalizeStepPermissions` rather than
 * hand-written `StepPermissions` literals, so the fixtures prove the pair works
 * together instead of proving the test author's idea of the normalizer.
 *
 * Every ambient input this file depends on is materialized by the file itself:
 * the binary-resolution cases build their own `PATH` inside a `mkdtempSync`
 * directory they `chmod`, and the environment cases pass fixture maps rather
 * than reading `process.env`. Nothing here relies on a CLI being installed or on
 * the runner's environment matching the author's.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  allowApiBillingFrom,
  buildChildEnv,
  buildClaudeOptions,
  claudeAdapter,
  resolveExecutable,
  startClaude,
  type ClaudeOptionInputs,
  type ClaudeQueryFactory,
} from '../src/harness/claude.ts';
import { normalizeStepPermissions } from '../src/harness/permissions.ts';
import { adapterFor } from '../src/harness/registry.ts';
import type { AgentEvent } from '../src/harness/contract.ts';
import type { LintFinding } from '../src/harness/types.ts';
import type { FetchedStep } from '../src/bundle/types.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildDef } from '../../../src/defs.ts';

const fixture = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), 'utf8');

const DEMO = JSON.parse(fixture('demo-def.json')) as { steps: FetchedStep[] };

const stepByName = (name: string): FetchedStep => {
  const s = DEMO.steps.find((x) => x.name === name);
  assert.ok(s, `fixture step ${name}`);
  return s!;
};

/** The caller owns the bag key — never the normalizer. */
const bagOf = (step: FetchedStep): Record<string, unknown> | undefined => {
  const x = step.x as Record<string, unknown> | undefined;
  const bag = x?.['harness'];
  return bag !== undefined && typeof bag === 'object' && bag !== null && !Array.isArray(bag)
    ? (bag as Record<string, unknown>)
    : undefined;
};

const MOUNT = { command: 'owenloop', args: ['work', 'hold', '--order', 'wf1/run1', '--mcp'] };

/** A deliberately BARE environment: no `PATH`, so binary resolution falls
 *  through to "omit the key" unless a case supplies one on purpose. */
const bareEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ...extra,
});

/** Build options for a bag, collecting whatever progress events came out. */
function optionsFor(
  bag: Record<string, unknown> | undefined,
  opts: {
    step?: { model?: string };
    startModel?: string;
    startEffort?: string;
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): { options: ReturnType<typeof buildClaudeOptions>; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const inputs: ClaudeOptionInputs = {
    cwd: opts.cwd ?? '/tmp/work',
    owenloopMcp: MOUNT,
    permissions: normalizeStepPermissions(bag, opts.step),
    ...(opts.startModel !== undefined ? { model: opts.startModel } : {}),
    ...(opts.startEffort !== undefined ? { effort: opts.startEffort } : {}),
  };
  const options = buildClaudeOptions(inputs, {
    env: opts.env ?? bareEnv(),
    abortController: new AbortController(),
    onEvent: (e) => events.push(e),
  });
  return { options, events };
}

/** Resolve the complete tool list that the selected hold MCP argv registers.
 * The hold-role e2e test separately proves the selector controls real tools/list. */
function mountedOwenloopTools(options: ReturnType<typeof buildClaudeOptions>): string[] {
  const servers = options.mcpServers as Record<string, { args: string[] }>;
  const selector = servers['owenloop']!.args.find((arg) => arg.startsWith('--mcp-tools='));
  return selector === undefined
    ? ['get_order', 'submit', 'reject', 'ask']
    : selector.slice('--mcp-tools='.length).split(',');
}

// ---------------------------------------------------------------------------
// Option mapping
// ---------------------------------------------------------------------------

test('a full bag maps onto the SDK options, setting BOTH tools and allowedTools', () => {
  const step = stepByName('builder');
  const { options } = optionsFor(bagOf(step), { step });

  // The two options mean different things and the single step-def `tools:` field
  // needs both: availability AND auto-allow. Only one of them is a live bug.
  assert.deepEqual(options.tools, ['Read', 'Edit', 'Bash'], 'tools = the available built-in set');
  assert.deepEqual(
    options.allowedTools,
    ['Read', 'Edit', 'Bash', 'mcp__owenloop__get_order', 'mcp__owenloop__submit', 'mcp__owenloop__ask'],
    'allowedTools = the authored built-ins plus the born-bound control-plane exception',
  );

  assert.equal(options.permissionMode, 'plan');
  assert.equal(options.maxTurns, 40);
  assert.equal(options.model, 'opus', "the step's first-class model reached the SDK");
  assert.equal(options.cwd, '/tmp/work');

  // An explicit tool allow-list is isolated so unlisted settings or MCP tools
  // cannot widen the surface. The born-bound control plane remains mounted.
  const servers = options.mcpServers as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(servers), ['owenloop']);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(servers['owenloop'], {
    type: 'stdio',
    command: MOUNT.command,
    args: [...MOUNT.args, '--mcp-tools=get_order,submit,ask'],
    alwaysLoad: true,
  });
  assert.deepEqual(mountedOwenloopTools(options), ['get_order', 'submit', 'ask']);
  assert.deepEqual(options.disallowedTools, ['mcp__owenloop__reject']);
});

test('an empty bag leaves every optional key ABSENT, not empty', () => {
  const step = stepByName('reviewer');
  const { options } = optionsFor(bagOf(step), { step });

  // `in`-checks, not value comparisons: `tools: []` means "disable all built-in
  // tools" to the SDK, so an absent key and an empty array are different agents.
  for (const key of ['tools', 'allowedTools', 'disallowedTools', 'permissionMode', 'maxTurns', 'model', 'effort', 'skills', 'resume']) {
    assert.equal(key in options, false, `${key} must be absent for an empty bag`);
  }
  assert.equal('allowDangerouslySkipPermissions' in options, false);

  // The owenloop mount is unconditional — it is how the agent reaches its order.
  assert.deepEqual(Object.keys(options.mcpServers as object), ['owenloop']);
  assert.deepEqual(mountedOwenloopTools(options), ['get_order', 'submit', 'reject', 'ask']);
});

test('the owenloop mount overwrites a bag that declares its own owenloop server', () => {
  const { options } = optionsFor({
    mcpServers: { owenloop: { command: 'not-the-real-one', args: ['--hijack'] }, extra: { command: 'x' } },
  });
  const servers = options.mcpServers as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers['owenloop'], {
    type: 'stdio',
    command: MOUNT.command,
    args: MOUNT.args,
    alwaysLoad: true,
  });
  assert.deepEqual(servers['extra'], { command: 'x' }, 'the author keeps every other server');
  assert.deepEqual(mountedOwenloopTools(options), ['get_order', 'submit', 'reject', 'ask']);
});

test("permissionMode 'bypassPermissions' also sets allowDangerouslySkipPermissions; no other mode does", () => {
  const bypass = optionsFor({ permissionMode: 'bypassPermissions' }).options;
  assert.equal(bypass.permissionMode, 'bypassPermissions');
  assert.equal(
    bypass.allowDangerouslySkipPermissions,
    true,
    'without the companion flag the SDK ignores the mode and the headless step stalls on a prompt',
  );

  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']) {
    const { options } = optionsFor({ permissionMode: mode });
    assert.equal(options.permissionMode, mode, `${mode} passed through`);
    assert.equal('allowDangerouslySkipPermissions' in options, false, `${mode} must not set the danger flag`);
  }
});

/**
 * The claude half of the neutral translation. Its companion lives in
 * `harness-codex.test.ts` (C5a–C5d / C10b2): the SAME authored value must yield
 * codex's approval policy there and an SDK permission mode here, which is what
 * lets one delivery step run on either harness.
 *
 * Two assertions are load-bearing.
 *
 * `full-access` must carry the companion danger flag, because it translates to
 * `bypassPermissions` BEFORE the pairing rule and therefore inherits it;
 * translating after the rule would produce a mode the SDK ignores, and a
 * headless step that stalls on a prompt nobody answers.
 *
 * `auto-safe` must NOT carry that flag. It is a genuinely different position —
 * a classifier decides, and a dangerous call still stops and asks — so a def
 * that asked for `auto-safe` and silently got the never-ask mode would have had
 * its gate removed without saying so.
 */
test('each neutral permissionMode translates to its SDK mode, and only full-access carries the danger flag', () => {
  const cases: Array<{ neutral: string; sdk: string; danger: boolean }> = [
    { neutral: 'ask', sdk: 'default', danger: false },
    { neutral: 'auto-safe', sdk: 'auto', danger: false },
    { neutral: 'full-access', sdk: 'bypassPermissions', danger: true },
  ];

  for (const { neutral, sdk, danger } of cases) {
    const { options, events } = optionsFor({ permissionMode: neutral });
    assert.equal(options.permissionMode, sdk, `${neutral} translates to ${sdk}`);
    assert.equal(
      'allowDangerouslySkipPermissions' in options,
      danger,
      `${neutral} danger-flag expectation`,
    );
    assert.deepEqual(events, [], `translating ${neutral} is not a diagnostic`);

    assert.deepEqual(
      claudeAdapter.preflight(normalizeStepPermissions({ permissionMode: neutral })),
      [],
      `${neutral} must pass preflight`,
    );
  }

  // The other adapter's vendor word stays refused: accepting it would mean this
  // adapter guessing at another vendor's vocabulary rather than the def naming
  // an intent.
  const foreign = claudeAdapter.preflight(normalizeStepPermissions({ permissionMode: 'never' }));
  assert.deepEqual(foreign.map((issue) => issue.field), ['permissionMode']);
  assert.match(foreign[0]?.message ?? '', /permissionMode must be one of .*full-access/);
});

test('an out-of-union permissionMode is dropped with a progress event, not passed through', () => {
  const { options, events } = optionsFor({ permissionMode: 'yolo' });
  assert.equal('permissionMode' in options, false);
  assert.ok(
    events.some((e) => e.kind === 'progress' && e.text.includes("'yolo'")),
    `expected a progress event naming the dropped mode, got ${JSON.stringify(events)}`,
  );
});

test('effort is passed when it is in the SDK union and dropped (with a progress event) when it is not', () => {
  assert.equal(optionsFor({ effort: 'high' }).options.effort, 'high');

  const { options, events } = optionsFor({ effort: 'ludicrous' });
  assert.equal('effort' in options, false, 'an out-of-union effort is dropped, not coerced');
  assert.ok(
    events.some((e) => e.kind === 'progress' && e.text.includes("'ludicrous'")),
    `expected a progress event naming the dropped effort, got ${JSON.stringify(events)}`,
  );
});

test('the per-start override wins over the step/bag value, for model and effort alike', () => {
  const withStart = optionsFor({ model: 'bag-model', effort: 'low' }, {
    startModel: 'start-model',
    startEffort: 'max',
  }).options;
  assert.equal(withStart.model, 'start-model');
  assert.equal(withStart.effort, 'max');

  // And with no override the normalized step value still reaches the SDK.
  const withoutStart = optionsFor({ model: 'bag-model', effort: 'low' }).options;
  assert.equal(withoutStart.model, 'bag-model');
  assert.equal(withoutStart.effort, 'low');
});

test('disallowedTools and maxTurns ride through verbatim', () => {
  const { options } = optionsFor({ disallowedTools: ['Bash', 'WebFetch'], maxTurns: 7 });
  assert.deepEqual(options.disallowedTools, ['Bash', 'WebFetch']);
  assert.equal(options.maxTurns, 7);
});

test("skills passes through as a string array or the literal 'all', and is dropped otherwise", () => {
  assert.deepEqual(optionsFor({ skills: ['a', 'b'] }).options.skills, ['a', 'b']);
  assert.equal(optionsFor({ skills: 'all' }).options.skills, 'all');
  assert.equal('skills' in optionsFor({ skills: 'some' }).options, false);
  assert.equal('skills' in optionsFor({ skills: [1, 2] }).options, false);
  assert.equal('skills' in optionsFor({ skills: { a: 1 } }).options, false);
});

test('an unrestricted bag leaves the three default-sensitive options unset', () => {
  // Setting any of these silently changes unrestricted behavior:
  // `settingSources: []` stops project instruction files loading,
  // `persistSession: false` makes the session unresumable, and
  // `strictMcpConfig` discards the operator's own MCP config.
  const { options } = optionsFor(bagOf(stepByName('reviewer')));
  for (const key of ['settingSources', 'persistSession', 'strictMcpConfig', 'forkSession']) {
    assert.equal(key in options, false, `${key} must be left to its default`);
  }
});

test('an explicit empty tools list disables built-ins while an absent list preserves SDK defaults', () => {
  const absent = optionsFor({}).options;
  assert.equal('tools' in absent, false);
  assert.equal('allowedTools' in absent, false);

  const empty = optionsFor({ tools: [] }).options;
  assert.deepEqual(empty.tools, []);
  assert.deepEqual(empty.allowedTools, [
    'mcp__owenloop__get_order',
    'mcp__owenloop__submit',
    'mcp__owenloop__ask',
  ]);
  assert.deepEqual(empty.settingSources, []);
  assert.equal(empty.strictMcpConfig, true);
  assert.deepEqual(mountedOwenloopTools(empty), ['get_order', 'submit', 'ask']);
  assert.deepEqual(empty.disallowedTools, ['mcp__owenloop__reject']);
});

test('a restricted producer gives its synthesized Claude judge no built-in tools', () => {
  const def = buildDef({
    name: 'restrictedJudge',
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [{
      name: 'researcher',
      consumes: ['question'],
      produces: [{
	name: 'report',
	judges: [{ name: 'completeness', body: 'evaluate', model: 'judge-model' }],
      }],
      x: { harness: { id: 'claude-code', tools: [], model: 'bag-model' } },
    }],
  });
  const judge = def.steps.find((step) => step.name.endsWith('.completeness'))!;
  const bag = judge.x!['harness'] as Record<string, unknown>;
  const { options } = optionsFor(bag, { step: judge });

  assert.deepEqual(options.tools, [], 'the inherited empty allow-list disables every built-in tool');
  assert.deepEqual(options.allowedTools, [
    'mcp__owenloop__get_order',
    'mcp__owenloop__submit',
    'mcp__owenloop__ask',
  ]);
  assert.deepEqual(mountedOwenloopTools(options), ['get_order', 'submit', 'ask']);
  assert.deepEqual(options.disallowedTools, ['mcp__owenloop__reject']);
  assert.equal(options.model, 'judge-model', 'the judge first-class model wins over inherited x.harness.model');
});

test('read-only filesystem with unrestricted network keeps audited network readers and isolates other extension surfaces', () => {
  const { options } = optionsFor({
    filesystem: 'read-only',
    network: 'unrestricted',
    skills: ['external-skill'],
    mcpServers: { external: { command: 'external-server' } },
  });
  assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
  assert.deepEqual(options.allowedTools, [
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'mcp__owenloop__get_order',
    'mcp__owenloop__submit',
    'mcp__owenloop__ask',
  ]);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(Object.keys(options.mcpServers as Record<string, unknown>), ['owenloop']);
});

test('read-only filesystem and owenloop-only network use the intersection of both audited tool sets', () => {
  const { options } = optionsFor({ filesystem: 'read-only', network: 'owenloop-only' });
  assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(options.allowedTools, [
    'Read',
    'Glob',
    'Grep',
    'mcp__owenloop__get_order',
    'mcp__owenloop__submit',
    'mcp__owenloop__ask',
  ]);
});

test('owenloop-only network policy excludes Bash, web, delegation, skills, hooks, and external MCP', () => {
  const { options } = optionsFor({
    network: 'owenloop-only',
    disallowedTools: ['Bash'],
    skills: 'all',
    hooks: { PreToolUse: [] },
    mcpServers: { external: { command: 'external-server' } },
  });
  const tools = options.tools as string[];
  for (const forbidden of ['Bash', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill']) {
    assert.equal(tools.includes(forbidden), false, `${forbidden} must not remain available`);
  }
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(Object.keys(options.mcpServers as Record<string, unknown>), ['owenloop']);
  assert.ok(
    (options.allowedTools as string[]).includes('mcp__owenloop__submit'),
    'the isolated agent must retain auto-allowed access to the born-bound submit tool',
  );
  assert.deepEqual(mountedOwenloopTools(options), ['get_order', 'submit', 'ask']);
  assert.deepEqual(options.disallowedTools, ['Bash', 'mcp__owenloop__reject']);
});

test('Claude preflight refuses direct and wildcard denies of the born-bound control plane', () => {
  for (const denied of [
    'mcp__owenloop__submit',
    'mcp__owenloop',
    'mcp__owenloop__*',
    'mcp__*',
  ]) {
    const issues = claudeAdapter.preflight(normalizeStepPermissions({
      disallowedTools: [denied],
    }));
    assert.ok(
      issues.some(
	(issue) =>
	  issue.field === 'disallowedTools' &&
	  issue.message.includes(denied),
      ),
      `${denied} must be refused because it blocks get_order/submit`,
    );
  }
});

test('Claude preflight accepts audited network readers with a read-only filesystem and unrestricted network', () => {
  const issues = claudeAdapter.preflight(normalizeStepPermissions({
    filesystem: 'read-only',
    network: 'unrestricted',
    tools: ['Read', 'WebFetch', 'WebSearch'],
  }));
  assert.deepEqual(issues, []);
});

test('Claude preflight refuses unsupported filesystem and unsafe restricted allow-lists', () => {
  const issues = claudeAdapter.preflight(normalizeStepPermissions({
    filesystem: 'workspace-write',
    network: 'owenloop-only',
    tools: ['Read', 'Bash', 'WebFetch'],
  }));
  assert.ok(issues.some((issue) => issue.field === 'filesystem'));
  assert.ok(issues.some((issue) => issue.field === 'tools' && issue.message.includes('Bash')));

  const externalMcp = claudeAdapter.preflight(normalizeStepPermissions({
    tools: ['mcp__external__lookup'],
  }));
  assert.ok(
    externalMcp.some(
      (issue) =>
	issue.field === 'tools' &&
	issue.message.includes('mcp__external__lookup'),
    ),
  );
});

test('resume option construction applies the same isolation policy as cold start', () => {
  const permissions = normalizeStepPermissions({ network: 'owenloop-only' });
  const events: AgentEvent[] = [];
  const options = buildClaudeOptions(
    { cwd: '/tmp/work', owenloopMcp: MOUNT, permissions },
    {
      env: bareEnv(),
      abortController: new AbortController(),
      onEvent: (event) => events.push(event),
      resume: 'session-1',
    },
  );
  assert.equal(options.resume, 'session-1');
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(Object.keys(options.mcpServers as Record<string, unknown>), ['owenloop']);
  assert.ok((options.allowedTools as string[]).includes('mcp__owenloop__submit'));
  assert.deepEqual(mountedOwenloopTools(options), ['get_order', 'submit', 'ask']);
  assert.deepEqual(options.disallowedTools, ['mcp__owenloop__reject']);
});

test('resume preserves unrestricted network readers under a read-only filesystem policy', () => {
  const permissions = normalizeStepPermissions({
    filesystem: 'read-only',
    network: 'unrestricted',
  });
  const options = buildClaudeOptions(
    { cwd: '/tmp/work', owenloopMcp: MOUNT, permissions },
    {
      env: bareEnv(),
      abortController: new AbortController(),
      onEvent: () => {},
      resume: 'session-read-only',
    },
  );

  assert.equal(options.resume, 'session-read-only');
  assert.deepEqual(options.tools, ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
  assert.deepEqual(options.allowedTools, [
    'Read',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'mcp__owenloop__get_order',
    'mcp__owenloop__submit',
    'mcp__owenloop__ask',
  ]);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
});

test('env and abortController are always set, and stderr forwards to onEvent as progress', () => {
  const events: AgentEvent[] = [];
  const env = bareEnv({ HOME: '/home/x' });
  const abortController = new AbortController();
  const options = buildClaudeOptions(
    { cwd: '/tmp/work', owenloopMcp: MOUNT, permissions: { extensions: {} } },
    { env, abortController, onEvent: (e) => events.push(e) },
  );
  // `env` must ALWAYS be set: omitting it makes the child inherit process.env,
  // which is exactly the API-key shadowing this adapter exists to prevent.
  assert.deepEqual(options.env, env);
  assert.equal(options.abortController, abortController);

  options.stderr?.('boom\n');
  assert.deepEqual(events, [{ kind: 'progress', text: 'stderr: boom' }]);
});

// ---------------------------------------------------------------------------
// Cold-start durable gate
// ---------------------------------------------------------------------------

interface LocalQueryProbe {
  queryCalls: number;
  closes: number;
  optionSessionIds: Array<string | undefined>;
}

function localQueryFactory(
  promptPath: string,
  reportedSessionId: string,
  probe: LocalQueryProbe,
): ClaudeQueryFactory {
  const childFixture = fileURLToPath(new URL('./fixtures/claude-query-child.mjs', import.meta.url));
  return ({ prompt, options }) => {
    probe.queryCalls++;
    probe.optionSessionIds.push(options.sessionId);
    const child = spawn(process.execPath, [childFixture, promptPath, reportedSessionId], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    assert.ok(child.stdin !== null && child.stdout !== null);
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    const lines = createInterface({ input: child.stdout });
    child.stdin.end(prompt);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
	for await (const line of lines) yield JSON.parse(line) as SDKMessage;
	const [code, signal] = await exited;
	if (code !== 0) throw new Error(`local query child exited with ${String(code)} / ${String(signal)}`);
      },
      close(): void {
	probe.closes++;
	child.kill('SIGTERM');
      },
    };
  };
}

const coldStartDirs: string[] = [];
after(() => {
  for (const dir of coldStartDirs) rmSync(dir, { recursive: true, force: true });
});

function coldStartArgs(cwd: string): Parameters<typeof startClaude>[0] {
  return {
    brief: 'harmless local prompt bytes',
    cwd,
    owenloopMcp: MOUNT,
    permissions: { extensions: {} },
  };
}

test('cold start persists started before the SDK process seam receives prompt bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-claude-gate-'));
  coldStartDirs.push(root);
  const promptPath = join(root, 'prompt.txt');
  const probePath = join(root, 'blocked-probe.txt');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const probe: LocalQueryProbe = { queryCalls: 0, closes: 0, optionSessionIds: [] };
  const observer = spawn(process.execPath, [
    '-e',
    "const {existsSync,writeFileSync}=require('node:fs');setTimeout(()=>writeFileSync(process.argv[2],existsSync(process.argv[1])?'present':'absent'),100)",
    promptPath,
    probePath,
  ], { stdio: 'ignore' });
  const observerExit = once(observer, 'exit');
  const events: AgentEvent[] = [];

  const ref = await startClaude(
    coldStartArgs(root),
    (event) => {
      events.push(event);
      if (event.kind !== 'started') return;
      assert.equal(probe.queryCalls, 0, 'query must not be constructed inside the persistence gate');
      const deadline = Date.now() + 5_000;
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(probePath) && Date.now() < deadline) {
	Atomics.wait(waitBuffer, 0, 0, 25);
      }
      assert.equal(existsSync(probePath), true, 'the independent observer ran while persistence was blocked');
      assert.equal(readFileSync(probePath, 'utf8'), 'absent', 'no prompt reached a process while persistence was blocked');
      assert.equal(existsSync(promptPath), false);
    },
    {
      createSessionId: () => sessionId,
      loadQuery: async () => localQueryFactory(promptPath, sessionId, probe),
    },
  );
  await observerExit;

  assert.deepEqual(ref, { harness: 'claude-code', token: sessionId });
  assert.equal(readFileSync(promptPath, 'utf8'), 'harmless local prompt bytes');
  assert.equal(probe.queryCalls, 1);
  assert.deepEqual(probe.optionSessionIds, [sessionId]);
  assert.deepEqual(events.map((event) => event.kind), ['started', 'progress', 'turn_ended']);
  await claudeAdapter.stop(ref);
});

test('a throwing started persistence gate starts no query, process, or prompt delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-claude-gate-'));
  coldStartDirs.push(root);
  const promptPath = join(root, 'prompt.txt');
  let loads = 0;
  const events: AgentEvent[] = [];

  await assert.rejects(
    startClaude(
      coldStartArgs(root),
      (event) => {
	events.push(event);
	if (event.kind === 'started') throw new Error('active fsync failed');
      },
      {
	createSessionId: () => '22222222-2222-4222-8222-222222222222',
	loadQuery: async () => {
	  loads++;
	  return localQueryFactory(promptPath, '22222222-2222-4222-8222-222222222222', {
	    queryCalls: 0,
	    closes: 0,
	    optionSessionIds: [],
	  });
	},
      },
    ),
    /active fsync failed/u,
  );

  assert.equal(loads, 0);
  assert.equal(existsSync(promptPath), false);
  assert.deepEqual(events.map((event) => event.kind), ['started', 'exited']);
});

test('cold start fails closed when provider init does not confirm the supplied session UUID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-claude-gate-'));
  coldStartDirs.push(root);
  const promptPath = join(root, 'prompt.txt');
  const supplied = '33333333-3333-4333-8333-333333333333';
  const reported = '44444444-4444-4444-8444-444444444444';
  const probe: LocalQueryProbe = { queryCalls: 0, closes: 0, optionSessionIds: [] };
  const events: AgentEvent[] = [];

  await assert.rejects(
    startClaude(
      coldStartArgs(root),
      (event) => events.push(event),
      {
	createSessionId: () => supplied,
	loadQuery: async () => localQueryFactory(promptPath, reported, probe),
      },
    ),
    new RegExp(`provider session id mismatch: expected ${supplied}, received ${reported}`),
  );

  assert.equal(readFileSync(promptPath, 'utf8'), 'harmless local prompt bytes');
  assert.deepEqual(probe.optionSessionIds, [supplied]);
  assert.equal(probe.closes, 1);
  assert.deepEqual(events.map((event) => event.kind), ['started', 'exited']);
  await claudeAdapter.stop({ harness: 'claude-code', token: supplied });
  assert.equal(probe.closes, 1, 'a mismatched init was removed from the session registry');
});

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const binDirs: string[] = [];
after(() => {
  for (const d of binDirs) rmSync(d, { recursive: true, force: true });
});

/** A temp directory holding an EXECUTABLE `claude` stub, plus a non-executable
 *  decoy dir ahead of it. The test builds every byte of this itself so it never
 *  depends on a CLI being installed on the runner. */
function fixturePathDirs(): { pathValue: string; realDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-claude-bin-'));
  binDirs.push(root);
  const decoy = join(root, 'decoy');
  const real = join(root, 'real');
  mkdirSync(decoy);
  mkdirSync(real);
  // A same-named but NON-executable file: the walk must skip it, not return it.
  writeFileSync(join(decoy, 'claude'), '#!/bin/sh\n');
  chmodSync(join(decoy, 'claude'), 0o644);
  writeFileSync(join(real, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(real, 'claude'), 0o755);
  return { pathValue: [decoy, real].join(delimiter), realDir: real };
}

test('binary resolution: the explicit override wins over everything', () => {
  const { pathValue } = fixturePathDirs();
  const env = bareEnv({ OWENLOOP_CLAUDE_BIN: '/opt/custom/claude', PATH: pathValue });
  assert.equal(resolveExecutable(env), '/opt/custom/claude');
  assert.equal(optionsFor({}, { env }).options.pathToClaudeCodeExecutable, '/opt/custom/claude');
});

test('binary resolution: with no override, an executable on PATH is found and a non-executable decoy is skipped', () => {
  const { pathValue, realDir } = fixturePathDirs();
  const env = bareEnv({ PATH: pathValue });
  assert.equal(resolveExecutable(env), join(realDir, 'claude'));
  assert.equal(optionsFor({}, { env }).options.pathToClaudeCodeExecutable, join(realDir, 'claude'));
});

test('binary resolution: nothing resolves means the KEY IS OMITTED, so the SDK uses its bundled executable', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'owenloop-claude-nobin-'));
  binDirs.push(emptyDir);
  const env = bareEnv({ PATH: emptyDir });
  assert.equal(resolveExecutable(env), undefined);
  const { options } = optionsFor({}, { env });
  assert.equal(
    'pathToClaudeCodeExecutable' in options,
    false,
    'an explicit undefined would not be the same as omitting the key',
  );

  // No PATH at all is the same story.
  assert.equal(resolveExecutable(bareEnv()), undefined);
  assert.equal(resolveExecutable(bareEnv({ PATH: '' })), undefined);
});

// ---------------------------------------------------------------------------
// Environment hygiene — the reason this adapter exists in the shape it does
// ---------------------------------------------------------------------------

const FULL_ENV = (): Record<string, string | undefined> => ({
  ANTHROPIC_API_KEY: 'sk-ant-should-not-survive',
  ANTHROPIC_AUTH_TOKEN: 'auth-should-not-survive',
  CLAUDECODE: '1',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-must-survive',
  OWENLOOP_CACHE_DIR: '/cache-must-survive',
  OWENLOOP_SHIFT_ID: 'shift-must-survive',
  OWENLOOP_CREDENTIAL_COMMAND: '/bin/credential-helper',
  OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS: '2500',
  OWENLOOP_NO_KEYCHAIN: '1',
  OWENLOOP_SESSION: 'session-must-survive',
  OWENLOOP_TOKEN: 'tok-must-not-survive',
  OWENLOOP_INVENTED_NEXT_PHASE: 'future-must-not-survive',
  OWENLOOP_CREDENTIAL_ORIGIN: 'helper-origin-must-not-survive',
  OWENLOOP_CREDENTIAL_SLOT: 'helper-slot-must-not-survive',
  PATH: '/usr/bin',
  HOME: '/home/x',
});

test('buildChildEnv strips the billing/nesting variables and keeps everything else', () => {
  const source = FULL_ENV();
  const out = buildChildEnv(source, { allowApiBilling: false });

  // `in`-checks, not `=== undefined`: an own key holding undefined is not the
  // same as an absent key across the SDK's serialization boundary.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE']) {
    assert.equal(key in out, false, `${key} must not reach the child — it shadows subscription auth`);
  }

  // THE regression guard: the subscription credential must survive the strip.
  // A future "tidy up the strip list" edit that adds it here breaks headless
  // auth silently, so this assertion is the alarm.
  assert.equal(out['CLAUDE_CODE_OAUTH_TOKEN'], 'oauth-must-survive');
  // Spread-then-delete, not delta-only: dropping these would break every child.
  assert.equal(out['PATH'], '/usr/bin');
  assert.equal(out['HOME'], '/home/x');

  assert.deepEqual(source, FULL_ENV(), 'the input environment must not be mutated');
});

/**
 * PHASE 6, ITEMS 3 AND 5 IN ONE ASSERTION — because they are one design, and
 * the thing worth pinning is that the two filters are INDEPENDENT.
 *
 * Item 5 needs the dev-only hub bearer override to stop reaching the child.
 * Item 3 needs the subscription OAuth token to keep reaching it, because under
 * launchd the Keychain read can fail and that variable is the fallback
 * credential path. A whole-environment allowlist could not do both without an
 * exhaustive list of everything the vendor binary needs to start.
 *
 * The namespace-scoped allowlist does both by construction:
 *   - `OWENLOOP_TOKEN` is inside the `OWENLOOP_*` namespace and not admitted, so
 *     it is removed;
 *   - `OWENLOOP_CACHE_DIR` is inside the namespace AND admitted, so it survives;
 *   - `CLAUDE_CODE_OAUTH_TOKEN`, `PATH` and `HOME` are OUTSIDE the namespace, so
 *     the filter cannot reach them at all — not by oversight, structurally.
 *
 * And the vendor API-key strip is a separate mechanism on a separate toggle:
 * `ANTHROPIC_API_KEY` still goes, and it goes for a different reason.
 */
test('buildChildEnv: the OWENLOOP_* allowlist and the API-key strip are independent', () => {
  const out = buildChildEnv(FULL_ENV(), { allowApiBilling: false });

  assert.equal(out['CLAUDE_CODE_OAUTH_TOKEN'], 'oauth-must-survive', 'item 3: outside the namespace, untouchable');
  assert.equal(out['OWENLOOP_CACHE_DIR'], '/cache-must-survive', 'admitted inside the namespace');
  assert.equal(out['OWENLOOP_SHIFT_ID'], 'shift-must-survive');
  assert.equal(out['OWENLOOP_CREDENTIAL_COMMAND'], '/bin/credential-helper');
  assert.equal(out['OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS'], '2500');
  assert.equal(out['OWENLOOP_NO_KEYCHAIN'], '1');
  assert.equal(out['OWENLOOP_SESSION'], 'session-must-survive');
  assert.equal(out['PATH'], '/usr/bin');
  assert.equal(out['HOME'], '/home/x');

  for (const key of [
    'OWENLOOP_TOKEN',
    'OWENLOOP_INVENTED_NEXT_PHASE',
    'OWENLOOP_CREDENTIAL_ORIGIN',
    'OWENLOOP_CREDENTIAL_SLOT',
  ]) {
    assert.equal(key in out, false, `${key} must stay denied inside the namespace`);
  }
  assert.equal('ANTHROPIC_API_KEY' in out, false, 'the API-key strip, a separate mechanism');
});

test('buildChildEnv with allowApiBilling on still applies the OWENLOOP_* allowlist', () => {
  const source = FULL_ENV();
  const out = buildChildEnv(source, { allowApiBilling: true });

  // The opt-out governs the vendor API-key strip ONLY. The namespace allowlist
  // is not a billing question and has no toggle: opting into API billing must
  // not re-open a path for owenloop's own hub bearer to reach a harness child.
  assert.equal(out['ANTHROPIC_API_KEY'], 'sk-ant-should-not-survive');
  assert.equal(out['ANTHROPIC_AUTH_TOKEN'], 'auth-should-not-survive');
  assert.equal(out['CLAUDECODE'], '1');
  assert.equal('OWENLOOP_TOKEN' in out, false, 'the allowlist is not under the billing toggle');
  assert.equal(out['OWENLOOP_CACHE_DIR'], '/cache-must-survive');
  assert.equal(out['OWENLOOP_SHIFT_ID'], 'shift-must-survive');
  assert.equal(out['OWENLOOP_CREDENTIAL_COMMAND'], '/bin/credential-helper');
  assert.equal(out['OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS'], '2500');
  assert.equal(out['OWENLOOP_NO_KEYCHAIN'], '1');
  assert.equal(out['OWENLOOP_SESSION'], 'session-must-survive');
  for (const key of [
    'OWENLOOP_INVENTED_NEXT_PHASE',
    'OWENLOOP_CREDENTIAL_ORIGIN',
    'OWENLOOP_CREDENTIAL_SLOT',
  ]) {
    assert.equal(key in out, false, `${key} stays denied when API billing is enabled`);
  }

  assert.deepEqual(source, FULL_ENV(), 'the input environment must not be mutated');
  assert.notEqual(out, source, 'still a copy, never the caller’s object');
});

test('the API-billing opt-out is off unless the toggle is exactly "1"', () => {
  assert.equal(allowApiBillingFrom({}), false);
  assert.equal(allowApiBillingFrom({ OWENLOOP_ALLOW_API_BILLING: '1' }), true);
  for (const v of ['', '0', 'true', 'yes', 'TRUE']) {
    assert.equal(allowApiBillingFrom({ OWENLOOP_ALLOW_API_BILLING: v }), false, `'${v}' must not enable billing`);
  }
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('importing the module self-registers the adapter under its own id', () => {
  assert.equal(claudeAdapter.id, 'claude-code', 'the registry id — NOT a bag key; the bag key is the fixed neutral `x.harness`');
  assert.equal(claudeAdapter.resumeTier, 'native-token');
  assert.equal(adapterFor('claude-code'), claudeAdapter, 'the module-scope register() fired on import');
});

// ---------------------------------------------------------------------------
// lintStep — the adapter's field vocabulary
//
// These assertions come from the deleted `test/adapter-claude-code.test.ts`,
// migrated per plan Stage D item 6. The knowledge they cover did NOT die with
// `src/adapters/`: it moved into this module and still ships behind the retained
// `owenloop work lint` verb, so it still needs coverage.
//
// The signature changed with the move — `lintStep(step: FetchedStep)` became
// `lintStep(bag, stepName)`, with the bag already extracted and its `id` already
// stripped by `parseHarnessCarrier`. Two of the old file's lint cases therefore
// no longer belong to the adapter and live in `test/lint-role.test.ts` instead:
// the no-bag case (short-circuited by `lintOneStep` before any adapter is asked)
// and the bag-`model`-vs-step-`model` conflict (needs the whole `FetchedStep`).
// A non-map bag is no longer a finding at all — `parseHarnessCarrier` throws on
// it before lint ever runs, which that file also pins.
// ---------------------------------------------------------------------------

/** The adapter's optional lint hook, asserted present once and then used. */
const lintOf = (bag: Record<string, unknown>): LintFinding[] => {
  assert.ok(claudeAdapter.lintStep, 'the adapter must expose lintStep — `owenloop work lint` is built on it');
  return claudeAdapter.lintStep!(bag, 's');
};

/** The bag as the def parser hands it over: `x.harness` minus `id`. */
const bagOfStep = (name: string): Record<string, unknown> => {
  const bag = bagOf(stepByName(name));
  assert.ok(bag, `fixture step ${name} must carry an x.harness bag`);
  return bag!;
};

test('lintStep: a clean bag lints with no findings', () => {
  assert.deepEqual(lintOf(bagOfStep('builder')), []);
});

test('lintStep: an empty bag lints with no findings', () => {
  assert.deepEqual(lintOf(bagOfStep('reviewer')), []);
  assert.deepEqual(lintOf({}), []);
});

test('lintStep: reserved keys in the bag are errors', () => {
  const f = lintOf({ name: 'x', description: 'y' });
  const fields = f.filter((x) => x.severity === 'error').map((x) => x.field);
  assert.ok(fields.includes('name'), "'name' is generated and must be rejected");
  assert.ok(fields.includes('description'), "'description' is generated and must be rejected");
});

test('lintStep: an unknown field is a warning that names the known list', () => {
  const f = lintOf({ bogusField: 1 });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.severity, 'warning', 'a def may target a newer CLI than this build — warn, never error');
  assert.equal(f[0]!.field, 'bogusField');
  assert.match(f[0]!.message, /known fields:/);
  // The list must be the real vocabulary, not a stale copy in the message.
  assert.match(f[0]!.message, /tools/);
  assert.match(f[0]!.message, /permissionMode/);
});

test('lintStep: `id` is never reported unknown — the parser strips it before lint', () => {
  // `parseHarnessCarrier` lifts `x.harness.id` into `step.harness`, so a bag
  // arriving here never contains it. Guard against a future refactor that stops
  // stripping and turns every harness-naming step into a spurious warning.
  assert.deepEqual(lintOf(bagOfStep('builder')), []);
});

test('lintStep: type violations on known fields are errors', () => {
  for (const bag of [
    { tools: 5 },
    { disallowedTools: 5 },
    { model: 5 },
    { effort: 5 },
    { maxTurns: 0 },
    { maxTurns: 1.5 },
    { background: 'yes' },
    { skills: 'one' },
    { permissionMode: 'wild' },
    { memory: 'cloud' },
    { hooks: [] },
    { mcpServers: [] },
  ]) {
    const f = lintOf(bag);
    assert.equal(f[0]?.severity, 'error', `${JSON.stringify(bag)} must be an error`);
    assert.equal(f[0]?.field, Object.keys(bag)[0], 'the finding must name the offending field');
  }
});

test('lintStep: valid enum/typed fields lint clean', () => {
  assert.deepEqual(
    lintOf({ permissionMode: 'plan', memory: 'project', maxTurns: 3, background: true, skills: ['a'] }),
    [],
  );
});

test('lintStep: a string tools value is accepted as well as a string[]', () => {
  assert.deepEqual(lintOf({ tools: 'Read' }), []);
  assert.deepEqual(lintOf({ tools: ['Read', 'Edit'] }), []);
  assert.deepEqual(lintOf({ disallowedTools: 'Bash' }), []);
});

test('lintStep: an author mcpServers.owenloop entry is a warning', () => {
  const f = lintOf({ mcpServers: { owenloop: { command: 'x' } } });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.severity, 'warning');
  assert.equal(f[0]!.field, 'mcpServers');
  assert.match(f[0]!.message, /reserved/);
});

test("lintStep: an author's own mcpServers entry draws no finding", () => {
  assert.deepEqual(lintOf({ mcpServers: { mine: { command: 'm' } } }), []);
});

test('lintStep never throws — a malformed bag produces findings, not an exception', () => {
  // The contract is TOTAL: lint runs over author-supplied data and a throw here
  // would abort the whole run instead of reporting the one bad step.
  for (const bag of [{ tools: null }, { hooks: null }, { mcpServers: null }, { permissionMode: 7 }]) {
    assert.doesNotThrow(() => lintOf(bag as Record<string, unknown>));
  }
});
