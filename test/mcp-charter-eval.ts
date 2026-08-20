/**
 * Opt-in live evaluation for the chief-of-staff MCP charter.
 *
 * This is intentionally not named *.test.ts: it spends real model quota and
 * requires logged-in local harnesses, so the deterministic suite must not run it.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

function usage(): never {
  throw new Error(
    'usage: npm run eval:mcp-charter -- [--output <path>] [--claude-model <model>] [--codex-model <model>]',
  );
}

function readOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    claudeModel: process.env['OWENLOOP_MCP_CHARTER_CLAUDE_MODEL'],
    codexModel: process.env['OWENLOOP_MCP_CHARTER_CODEX_MODEL'],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output' || arg === '--claude-model' || arg === '--codex-model') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) usage();
      if (arg === '--output') options.output = value;
      if (arg === '--claude-model') options.claudeModel = value;
      if (arg === '--codex-model') options.codexModel = value;
      index += 1;
      continue;
    }
    usage();
  }
  return options;
}

function responseEvidence(events: AgentEvent[]): string[] {
  // Adapter telemetry supplies the final-response evidence for human review.
  // This collection is deliberately kept out of scoreTask(), which sees only
  // parsed fixture-server calls.
  return events
    .filter((event): event is Extract<AgentEvent, { kind: 'progress' }> => event.kind === 'progress')
    .map((event) => event.text);
}

function reportedMetadata(events: AgentEvent[]): { reportedModel?: string; version?: string } {
  const text = responseEvidence(events).join('\n');
  const reportedModel = /(?:^|\\s)model=([^\\s]+)/u.exec(text)?.[1];
  const version = /(?:^|\\s)cliVersion=([^\\s]+)/u.exec(text)?.[1];
  return {
    ...(reportedModel === undefined ? {} : { reportedModel }),
    ...(version === undefined ? {} : { version }),
  };
}

function unscorable(reason: string, calls: ParsedTrace['calls'] = []): ParsedTrace {
  return { status: 'unscorable', reason, calls };
}

async function runTask(
  harness: HarnessRun,
  task: { request: string },
  fixturePath: string,
  expectedCharterSha256: string,
): Promise<TaskRun> {
  const cwd = await mkdtemp(join(tmpdir(), 'owenloop-mcp-charter-eval-'));
  const tracePath = join(cwd, 'trace.jsonl');
  const events: AgentEvent[] = [];
  let ref: HarnessSessionRef | undefined;
  let adapterFailure: string | undefined;

  try {
    try {
      ref = await harness.adapter.start(
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
        (event) => events.push(event),
      );
    } catch (error) {
      adapterFailure = error instanceof Error ? error.message : String(error);
    } finally {
      if (ref !== undefined) {
        try {
          await harness.adapter.stop(ref);
        } catch (error) {
          adapterFailure ??= `session stop failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }

    let trace: ParsedTrace;
    try {
      trace = parseTraceJsonl(await readFile(tracePath, 'utf8'), expectedCharterSha256);
    } catch {
      trace = unscorable('trace file was not created');
    }
    if (adapterFailure !== undefined) trace = unscorable(`adapter failure: ${adapterFailure}`, trace.calls);
    if (!events.some((event) => event.kind === 'turn_ended')) {
      trace = unscorable('incomplete turn: no turn_ended adapter event', trace.calls);
    }
    return { trace, responseEvidence: responseEvidence(events), ...reportedMetadata(events) };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function replaceAtomically(path: string, contents: string): Promise<void> {
  const target = resolve(path);
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
      permissions: { permissionMode: 'bypassPermissions', maxTurns: 12, extensions: {} },
    },
    {
      id: codexAdapter.id,
      adapter: codexAdapter,
      model: options.codexModel,
      permissions: { permissionMode: 'never', extensions: { sandbox: 'workspace-write' } },
    },
  ];

  const scores: ScoreRecord[] = [];
  for (const harness of harnesses) {
    const records: TaskRecord[] = [];
    let reportedModel: string | undefined;
    let version: string | undefined;
    for (const task of fixture.tasks) {
      const run = await runTask(harness, task, DEFAULT_CHARTER_FIXTURE_PATH, charterSha256);
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

void main().catch((error: unknown) => {
  process.stderr.write(`mcp charter eval failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
