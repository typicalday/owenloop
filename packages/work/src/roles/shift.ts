/**
 * Public `owenloop shift start|next|status|end` command surface.
 *
 * `start` delegates all origin, credential, settings, cache, spawner, and loop
 * construction to the shift runtime. `next`, `status`, and `end` are thin local
 * socket clients and never contact the hub directly.
 */
import { loadSettings } from '../settings/settings.ts';
import { resolveStateDir } from '../shift/state.ts';
import {
  assertShiftDaemonPlatform,
  resolveStateDirOverride,
  runShiftRuntime,
  type ParsedArgs,
} from '../shift/runtime.ts';
import {
  noDaemonMessage,
  parseNextArgs,
  parseStateDirArgs,
  requestShift,
  ShiftClientError,
  shiftSocketPath,
} from '../shift/client.ts';
import { isShiftError } from '../shift/protocol.ts';

interface StartArgs extends ParsedArgs {
  all?: boolean;
  crews: string[];
}

function usage(): void {
  process.stderr.write(
    'usage: owenloop shift start <crew...> [--all] [--origin <url>] [--as <account>] [--name <n>]\n' +
      '                              [--cap <n>] [--max-agents <n>] [--exec-reserve <n>] [--local-queue-hold <ms>] [--poll-interval <ms>] [--once]\n' +
      '                              [--cache-dir <p>] [--state-dir <p>]\n' +
      '                              [--log-dir <p>] [--log-max-age <ms>]\n' +
      '                              [--work-root <dir>]...   restrict this shift to these directories\n' +
      '       owenloop shift next [--wait <seconds>] [--state-dir <p>]\n' +
      '       owenloop shift status [--state-dir <p>]\n' +
      '       owenloop shift end [--state-dir <p>]\n',
  );
}

function intValue(raw: string, flag: string): number | string {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return `${flag} must be a non-negative integer, got '${raw}'`;
  }
  return value;
}

function parseStartArgs(args: string[]): StartArgs {
  const parsed: StartArgs = { crews: [] };
  const valueFlags = new Set([
    '--origin', '--as', '--name', '--cap', '--max-agents', '--exec-reserve', '--local-queue-hold', '--poll-interval',
    '--cache-dir', '--state-dir', '--log-dir', '--log-max-age', '--work-root',
  ]);
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    const name = raw.startsWith('--') && raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw;
    if (name === '--all') {
      parsed.all = true;
      continue;
    }
    if (name === '--once') {
      parsed.once = true;
      continue;
    }
    if (valueFlags.has(name)) {
      const eq = raw.indexOf('=');
      const value = eq !== -1 ? raw.slice(eq + 1) : args[++i];
      if (value === undefined || value.trim() === '') return { crews: parsed.crews, error: `missing value for ${name}` };
      if (name === '--origin') parsed.origin = value;
      else if (name === '--as') parsed.as = value;
      else if (name === '--name') {
        if (value.trim() === '') return { crews: parsed.crews, error: '--name requires a non-empty value' };
        parsed.name = value;
      } else if (name === '--cache-dir') parsed.cacheDir = value;
      else if (name === '--state-dir') parsed.stateDir = value;
      else if (name === '--log-dir') parsed.logDir = value;
      else if (name === '--log-max-age') {
        const n = intValue(value, '--log-max-age');
        if (typeof n !== 'number') return { crews: parsed.crews, error: n };
        parsed.logMaxAgeMs = n;
      } else if (name === '--cap') {
        const n = intValue(value, '--cap');
        if (typeof n !== 'number') return { crews: parsed.crews, error: n };
        parsed.cap = n;
      } else if (name === '--max-agents') {
        const n = intValue(value, '--max-agents');
        if (typeof n !== 'number') return { crews: parsed.crews, error: n };
        parsed.maxAgents = n;
      } else if (name === '--exec-reserve') {
	const n = intValue(value, '--exec-reserve');
	if (typeof n !== 'number') return { crews: parsed.crews, error: n };
	parsed.execReserve = n;
      } else if (name === '--local-queue-hold') {
	const n = intValue(value, '--local-queue-hold');
	if (typeof n !== 'number') return { crews: parsed.crews, error: n };
	parsed.localQueueHoldMs = n;
      } else if (name === '--poll-interval') {
        const n = intValue(value, '--poll-interval');
        if (typeof n !== 'number') return { crews: parsed.crews, error: n };
        parsed.pollIntervalMs = n;
      } else if (name === '--work-root') {
        // REPEATABLE — one directory per occurrence. See `ParsedArgs.workRoots`
        // in `src/shift/runtime.ts` for why this accumulates instead of taking
        // a separated list, and `src/agent/workdir.ts` for how this differs
        // from the singular `workRoot` setting.
        (parsed.workRoots ??= []).push(value);
      }
      continue;
    }
    if (raw.startsWith('-')) return { crews: parsed.crews, error: `unknown option '${raw}'` };
    const crew = raw.trim();
    if (crew !== '' && !parsed.crews.includes(crew)) parsed.crews.push(crew);
  }
  if (parsed.all === true && parsed.crews.length > 0) {
    return { crews: parsed.crews, error: '--all cannot be combined with named crews' };
  }
  if (parsed.all !== true && parsed.crews.length === 0) {
    return { crews: parsed.crews, error: 'name at least one crew or pass --all to serve every crew' };
  }
  parsed.serveCrews = parsed.all === true ? [] : parsed.crews;
  return parsed;
}

function resolveSocketPath(flag: string | undefined): { path?: string; error?: string } {
  const env = process.env;
  let settingsStateDir: string | undefined;
  if (flag === undefined && (env['OWENLOOP_STATE_DIR'] === undefined || env['OWENLOOP_STATE_DIR']?.trim() === '')) {
    try {
      settingsStateDir = loadSettings(env).stateDir;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const stateDir = resolveStateDir(env, resolveStateDirOverride(flag, env, settingsStateDir));
    return { path: shiftSocketPath(stateDir) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function shiftDaemonClientPlatformError(
  command: 'next' | 'status' | 'end',
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  try {
    assertShiftDaemonPlatform(platform);
    return undefined;
  } catch (error) {
    return `owenloop shift ${command}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function rejectUnsupportedDaemonClient(command: 'next' | 'status' | 'end'): boolean {
  const error = shiftDaemonClientPlatformError(command);
  if (error === undefined) return false;
  process.stderr.write(`${error}\n`);
  return true;
}

async function runNext(args: string[]): Promise<number> {
  const parsed = parseNextArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop shift next: ${parsed.error}\n`);
    usage();
    return 2;
  }
  if (rejectUnsupportedDaemonClient('next')) return 1;
  const socket = resolveSocketPath(parsed.stateDir);
  if (socket.error !== undefined || socket.path === undefined) {
    process.stderr.write(`owenloop shift next: ${socket.error ?? 'cannot resolve state directory'}\n`);
    return 1;
  }
  try {
    const response = await requestShift(socket.path, { op: 'next', wait_ms: parsed.waitMs });
    if (isShiftError(response)) {
      process.stderr.write(`${response.error}\n`);
      return 1;
    }
    printJson(response);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runStatus(args: string[]): Promise<number> {
  const parsed = parseStateDirArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop shift status: ${parsed.error}\n`);
    usage();
    return 2;
  }
  if (rejectUnsupportedDaemonClient('status')) return 1;
  const socket = resolveSocketPath(parsed.stateDir);
  if (socket.error !== undefined || socket.path === undefined) {
    process.stderr.write(`owenloop shift status: ${socket.error ?? 'cannot resolve state directory'}\n`);
    return 1;
  }
  try {
    const response = await requestShift(socket.path, { op: 'status' });
    if (isShiftError(response)) {
      process.stderr.write(`${response.error}\n`);
      return 1;
    }
    printJson(response);
    return 0;
  } catch (error) {
    if (error instanceof ShiftClientError && error.absent) {
      printJson({ status: 'no daemon', socket: socket.path });
      return 0;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runEnd(args: string[]): Promise<number> {
  const parsed = parseStateDirArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop shift end: ${parsed.error}\n`);
    usage();
    return 2;
  }
  if (rejectUnsupportedDaemonClient('end')) return 1;
  const socket = resolveSocketPath(parsed.stateDir);
  if (socket.error !== undefined || socket.path === undefined) {
    process.stderr.write(`owenloop shift end: ${socket.error ?? 'cannot resolve state directory'}\n`);
    return 1;
  }
  try {
    const response = await requestShift(socket.path, { op: 'end' });
    if (isShiftError(response)) {
      process.stderr.write(`${response.error}\n`);
      return 1;
    }
    printJson(response);
    return 0;
  } catch (error) {
    if (error instanceof ShiftClientError && error.absent) {
      process.stderr.write(`${noDaemonMessage(socket.path)}\n`);
      return 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function run(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    usage();
    return command === undefined ? 2 : 0;
  }
  if (command === 'start') {
    const parsed = parseStartArgs(rest);
    if (parsed.error !== undefined) {
      process.stderr.write(`owenloop shift start: ${parsed.error}\n`);
      usage();
      return 2;
    }
    return runShiftRuntime(parsed, { daemon: true, role: 'shift' });
  }
  if (command === 'next') return runNext(rest);
  if (command === 'status') return runStatus(rest);
  if (command === 'end') return runEnd(rest);
  process.stderr.write(`owenloop shift: unknown command '${command}'\n`);
  usage();
  return 2;
}

export { parseStartArgs, resolveSocketPath };
