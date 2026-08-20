/**
 * Opt-in live evaluation for the chief-of-staff MCP charter.
 *
 * This is intentionally not named *.test.ts: it spends real model quota and
 * requires logged-in local harnesses, so the deterministic suite must not run it.
 */
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { claudeAdapter } from '../packages/work/src/harness/claude.ts';
import { codexAdapter } from '../packages/work/src/harness/codex.ts';
import type { AgentEvent, HarnessAdapter, HarnessSessionRef, StartArgs } from '../packages/work/src/harness/contract.ts';
import {
  DEFAULT_CHARTER_FIXTURE_PATH,
  makeReport,
  makeScoreRecord,
  loadCharterFixture,
  parseTraceJsonl,
  scoreTask,
  servedCharterSha256,
  validateReport,
} from './helpers/mcp-charter-eval.ts';
import type { ParsedTrace, ScoreRecord, TaskRecord } from './helpers/mcp-charter-eval.ts';

interface CliOptions {
  output?: string;
  claudeModel?: string;
  codexModel?: string;
  taskTimeoutMs: number;
}

interface HarnessRun {
  id: string;
  adapter: HarnessAdapter;
  model?: string;
  permissions: StartArgs['permissions'];
}

interface TaskRun {
  trace: ParsedTrace;
  responseEvidence: string[];
  reportedModel?: string;
  version?: string;
}

export interface RunTaskOptions {
  taskTimeoutMs?: number;
}

/** A live task must eventually yield a report, even if an adapter wedges. */
export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;
/** Teardown is best effort, but a stuck stop must not defeat the task deadline. */
const STOP_TIMEOUT_MS = 10_000;

function usage(): never {
  throw new Error(
    'usage: npm run eval:mcp-charter -- [--output <path>] [--claude-model <model>] [--codex-model <model>] [--task-timeout-ms <positive integer>]',
  );
}

function positiveInteger(value: string, flag: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a safe positive integer`);
  return parsed;
}

function readOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    claudeModel: process.env['OWENLOOP_MCP_CHARTER_CLAUDE_MODEL'],
    codexModel: process.env['OWENLOOP_MCP_CHARTER_CODEX_MODEL'],
    taskTimeoutMs:
      process.env['OWENLOOP_MCP_CHARTER_TASK_TIMEOUT_MS'] === undefined
        ? DEFAULT_TASK_TIMEOUT_MS
        : positiveInteger(process.env['OWENLOOP_MCP_CHARTER_TASK_TIMEOUT_MS'], 'OWENLOOP_MCP_CHARTER_TASK_TIMEOUT_MS'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '--claude-model' || arg === '--codex-model' || arg === '--task-timeout-ms') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage();
      if (arg === '--output') options.output = value;
      if (arg === '--claude-model') options.claudeModel = value;
      if (arg === '--codex-model') options.codexModel = value;
      if (arg === '--task-timeout-ms') options.taskTimeoutMs = positiveInteger(value, '--task-timeout-ms');
      index += 1;
      continue;
    }
    usage();
  }
  return options;
}

export function finalResponseEvidence(events: readonly AgentEvent[]): string[] {
  // Scores see only fixture-server calls. Retain only the typed final response;
  // generic progress includes reasoning, stderr, tool activity, and transport.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'assistant_response') return [event.text];
  }
  return [];
}

export function reportedMetadata(events: readonly AgentEvent[]): { reportedModel?: string; version?: string } {
  const progress = events
    .filter((event): event is Extract<AgentEvent, { kind: 'progress' }> => event.kind === 'progress')
    .map((event) => event.text);
  const claudeInit = progress.find((text) => /^session\s+\S+:\s/u.test(text));
  const codexInit = progress.find((text) => /^app-server ready: userAgent=/u.test(text));
  const reportedModel = claudeInit === undefined ? undefined : /(?:^|\s)model=([^\s]+)/u.exec(claudeInit)?.[1];
  const claudeVersion = claudeInit === undefined ? undefined : /(?:^|\s)cliVersion=([^\s]+)/u.exec(claudeInit)?.[1];
  const codexVersion =
    codexInit === undefined ? undefined : /^app-server ready: userAgent=[^/\s]+\/([^\s]+)/u.exec(codexInit)?.[1];
  const version = claudeVersion ?? codexVersion;
  return {
    ...(reportedModel === undefined ? {} : { reportedModel }),
    ...(version === undefined ? {} : { version }),
  };
}

function unscorable(reason: string, calls: ParsedTrace['calls'] = []): ParsedTrace {
  return { status: 'unscorable', reason, calls };
}

/**
 * Codex stores file-backed login state and user configuration under the same
 * root. Give the app-server a private configuration root, but stage auth.json
 * when the operator uses file authentication so isolation does not silently
 * sign a healthy harness out. The evaluated turn has no file/shell tools and
 * receives no subprocess environment, so the staged credential is app-server
 * input rather than model-readable evidence. Keyring-only installs need no file.
 */
async function createIsolatedCodexHome(sourceHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'owenloop-mcp-charter-eval-codex-home-'));
  await chmod(home, 0o700);
  let copiedFileAuth = false;
  try {
    await copyFile(join(sourceHome, 'auth.json'), join(home, 'auth.json'));
    await chmod(join(home, 'auth.json'), 0o600);
    copiedFileAuth = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await rm(home, { recursive: true, force: true });
      throw error;
    }
  }
  await writeFile(join(home, 'config.toml'), `cli_auth_credentials_store = "${copiedFileAuth ? 'file' : 'auto'}"\n`, {
    mode: 0o600,
  });
  return home;
}

/** Codex treatment: fixture MCP only, with no model-visible path to staged auth. */
export const CODEX_EVAL_PERMISSIONS: StartArgs['permissions'] = {
  permissionMode: 'never',
  extensions: {
    sandbox: 'read-only',
    codexConfig: {
      agents: { enabled: false },
      apps: { _default: { enabled: false } },
      features: {
        apps: false,
        browser_use: false,
        browser_use_external: false,
        browser_use_full_cdp_access: false,
        computer_use: false,
        goals: false,
        image_generation: false,
        in_app_browser: false,
        multi_agent: false,
        plugins: false,
        remote_plugin: false,
        shell_tool: false,
        unified_exec: false,
      },
      history: { persistence: 'none' },
      shell_environment_policy: { inherit: 'none', ignore_default_excludes: false },
      tools: { view_image: false, web_search: false },
      web_search: 'disabled',
    },
  },
};

export async function runTask(
  harness: HarnessRun,
  task: { request: string },
  fixturePath: string,
  expectedCharterSha256: string,
  { taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS }: RunTaskOptions = {},
): Promise<TaskRun> {
  if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 1) {
    throw new Error('taskTimeoutMs must be a safe positive integer');
  }
  const sessionRoot = await mkdtemp(join(tmpdir(), 'owenloop-mcp-charter-eval-session-'));
  const cwd = join(sessionRoot, 'workspace');
  await mkdir(cwd, { mode: 0o700 });
  // The evaluated session receives only `cwd`; the fixture server alone receives
  // this random, harness-owned evidence path. It is never a file in the model's
  // workspace, so ordinary workspace access cannot inspect or rewrite a score.
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'owenloop-mcp-charter-eval-evidence-'));
  await chmod(evidenceRoot, 0o700);
  const tracePath = join(evidenceRoot, 'trace.jsonl');
  const codexHome = harness.id === codexAdapter.id ? await createIsolatedCodexHome() : undefined;
  const previousCodexHome = process.env['CODEX_HOME'];
  // Tasks run sequentially. Scope the app-server config root to this one task
  // and restore the process environment before the next harness starts.
  if (codexHome !== undefined) process.env['CODEX_HOME'] = codexHome;
  const events: AgentEvent[] = [];
  let ref: HarnessSessionRef | undefined;
  let deadlineExceeded = false;
  let stopping: Promise<string | undefined> | undefined;

  const stopSession = (): Promise<string | undefined> => {
    if (ref === undefined) return Promise.resolve(undefined);
    if (stopping !== undefined) return stopping;
    const sessionRef = ref;
    stopping = new Promise<string>((resolveStop) => {
      const timer = setTimeout(() => resolveStop(`session stop exceeded ${STOP_TIMEOUT_MS}ms`), STOP_TIMEOUT_MS);
      void Promise.resolve()
        .then(async () => harness.adapter.stop(sessionRef))
        .then(
          () => {
            clearTimeout(timer);
            resolveStop('');
          },
          (error: unknown) => {
            clearTimeout(timer);
            resolveStop(`session stop failed: ${error instanceof Error ? error.message : String(error)}`);
          },
        );
    }).then((reason) => (reason === '' ? undefined : reason));
    return stopping;
  };

  try {
    const onEvent = (event: AgentEvent): void => {
      events.push(event);
      if (event.kind === 'started') {
        ref = event.ref;
        if (deadlineExceeded) void stopSession();
      }
    };
    type StartOutcome = { kind: 'resolved' } | { kind: 'rejected'; reason: string };
    let start: Promise<StartOutcome>;
    try {
      start = harness.adapter
        .start(
          {
            brief: `Handle this request for the user:\n\n${task.request}`,
            cwd,
            ...(harness.model === undefined ? {} : { model: harness.model }),
            owenloopMcp: {
              command: process.execPath,
              args: [
                resolve('test/fixtures/mcp-charter-eval-server.ts'),
                '--fixture',
                fixturePath,
                '--trace',
                tracePath,
              ],
            },
            permissions: harness.permissions,
          },
          onEvent,
        )
        .then(
          (startedRef) => {
            ref ??= startedRef;
            return { kind: 'resolved' };
          },
          (error: unknown) => ({
            kind: 'rejected',
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
    } catch (error) {
      start = Promise.resolve({ kind: 'rejected', reason: error instanceof Error ? error.message : String(error) });
    }

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<{ kind: 'deadline' }>((resolveDeadline) => {
      deadlineTimer = setTimeout(() => resolveDeadline({ kind: 'deadline' }), taskTimeoutMs);
    });
    const outcome = await Promise.race([start, deadline]);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);

    // Snapshot before ordinary teardown: a post-completion stop can legitimately
    // emit `exited`, while an exit emitted during the evaluated turn is fatal.
    const terminalEvents = events.slice();
    let adapterFailure: string | undefined;
    if (outcome.kind === 'deadline') {
      deadlineExceeded = true;
      adapterFailure = `task deadline exceeded after ${taskTimeoutMs}ms`;
      const stopFailure = await stopSession();
      if (stopFailure !== undefined) adapterFailure = `${adapterFailure}; ${stopFailure}`;
    } else {
      if (outcome.kind === 'rejected') adapterFailure = `adapter failure: ${outcome.reason}`;
      const stopFailure = await stopSession();
      if (stopFailure !== undefined) adapterFailure ??= stopFailure;
    }

    let trace: ParsedTrace;
    try {
      trace = parseTraceJsonl(await readFile(tracePath, 'utf8'), expectedCharterSha256);
    } catch {
      trace = unscorable('trace file was not created');
    }
    const exit = terminalEvents.find((event): event is Extract<AgentEvent, { kind: 'exited' }> => event.kind === 'exited');
    if (adapterFailure !== undefined) trace = unscorable(adapterFailure, trace.calls);
    else if (exit !== undefined) {
      trace = unscorable(`adapter reported exit: ${exit.error ?? `exit code ${String(exit.exitCode)}`}`, trace.calls);
    }
    if (adapterFailure === undefined && exit === undefined && !terminalEvents.some((event) => event.kind === 'turn_ended')) {
      trace = unscorable('incomplete turn: no turn_ended adapter event', trace.calls);
    }
    return { trace, responseEvidence: finalResponseEvidence(terminalEvents), ...reportedMetadata(terminalEvents) };
  } finally {
    if (codexHome !== undefined) {
      if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = previousCodexHome;
      await rm(codexHome, { recursive: true, force: true });
    }
    await rm(sessionRoot, { recursive: true, force: true });
    await rm(evidenceRoot, { recursive: true, force: true });
  }
}

async function replaceAtomically(path: string, contents: string): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, contents);
  await rename(temporary, target);
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  const fixture = await loadCharterFixture();
  const charterSha256 = await servedCharterSha256();
  const harnesses: HarnessRun[] = [
    {
      id: claudeAdapter.id,
      adapter: claudeAdapter,
      model: options.claudeModel,
      permissions: {
        permissionMode: 'bypassPermissions',
        filesystem: 'read-only',
        network: 'owenloop-only',
        maxTurns: 12,
        extensions: {},
      },
    },
    {
      id: codexAdapter.id,
      adapter: codexAdapter,
      model: options.codexModel,
      permissions: CODEX_EVAL_PERMISSIONS,
    },
  ];

  const scores: ScoreRecord[] = [];
  for (const harness of harnesses) {
    const records: TaskRecord[] = [];
    let reportedModel: string | undefined;
    let version: string | undefined;
    for (const task of fixture.tasks) {
      const run = await runTask(harness, task, DEFAULT_CHARTER_FIXTURE_PATH, charterSha256, {
        taskTimeoutMs: options.taskTimeoutMs,
      });
      reportedModel ??= run.reportedModel;
      version ??= run.version;
      records.push({ ...scoreTask(task, run.trace), responseEvidence: run.responseEvidence });
    }
    scores.push(
      makeScoreRecord(
        {
          id: harness.id,
          ...(harness.model === undefined ? {} : { configuredModel: harness.model }),
          ...(reportedModel === undefined ? {} : { reportedModel }),
          ...(version === undefined ? {} : { version }),
        },
        charterSha256,
        records,
      ),
    );
  }

  const report = makeReport(fixture, scores);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(reportText);

  const errors = validateReport(report);
  if (errors.length > 0) {
    process.stderr.write(`mcp charter eval is unscorable: ${errors.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.output !== undefined) await replaceAtomically(options.output, reportText);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`mcp charter eval failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
