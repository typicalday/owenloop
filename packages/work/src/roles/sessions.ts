/**
 * `owenloop work sessions` — list the harness sessions this machine has recorded, and
 * print the command a human would run to re-open one.
 *
 * WHY IT EXISTS. `sessions.jsonl` is the only record that a provider-side
 * session ever existed; the tokens in it are machine-local and are never sent to
 * the hub. Before this subcommand the only way to answer "is anything still
 * open on this box, and how do I get into it?" was to read the JSONL by hand.
 * That matters most in exactly the situation where reading files by hand is
 * hardest: a run that failed, whose worker is gone, and whose session may or may
 * not still be resumable.
 *
 * WHY NO VENDOR NAME APPEARS IN THIS FILE. The harness id on a `SessionRecord`
 * is DATA. Turning that data into a runnable command is BEHAVIOR, and vendor
 * behavior lives behind the adapter contract — see `resumeCommand?` in
 * `src/harness/contract.ts`. A `switch (rec.harness)` here would read fine and
 * would still be the exact layering violation the harness boundary exists to
 * prevent; `test/vendor-gate.test.ts` fails any shipped file outside
 * `src/harness/` that names a vendor.
 *
 * WHY `dead` IS HIDDEN BY DEFAULT. `src/agent/loop.ts` refuses to resume a
 * session whose newest record is `dead`, so a dead row is not actionable — and
 * the store is append-only, so dead rows accumulate. `--all` shows them for
 * forensics.
 *
 * Exit codes: 0 always on a successful read, INCLUDING an empty or missing store
 * (a box that has run no agent orders is not in an error state) · 1 the cache
 * dir could not be resolved or the store could not be read · 2 usage.
 */
import '../harnesses.ts';

import { adapterFor } from '../harness/registry.ts';
import { readSessions, sessionsPath, type SessionRecord } from '../harness/session-store.ts';
import { resolveCacheDir } from '../bundle/cache.ts';
import { loadSettings } from '../settings/settings.ts';

interface ParsedArgs {
  cacheDir?: string;
  json: boolean;
  all: boolean;
  error?: string;
}

export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, all: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--json':
        parsed.json = true;
        break;
      case '--all':
        parsed.all = true;
        break;
      case '--cache-dir': {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('-')) {
          parsed.error = `--cache-dir requires a value`;
          return parsed;
        }
        parsed.cacheDir = v;
        i++;
        break;
      }
      default:
        parsed.error = `unknown option '${a}'`;
        return parsed;
    }
  }
  return parsed;
}

function usage(): void {
  process.stderr.write('usage: owenloop work sessions [--all] [--json] [--cache-dir <p>]\n');
}

/** The newest record per `(workflow, run, step)` — the store is last-wins. */
export function newestPerKey(records: readonly SessionRecord[]): SessionRecord[] {
  const newest = new Map<string, SessionRecord>();
  for (const rec of records) newest.set(JSON.stringify([rec.workflow, rec.run, rec.step]), rec);
  return [...newest.values()];
}

/**
 * A coarse human age: whole seconds under a minute, then minutes, hours, days.
 * Deliberately lossy — this column exists to answer "is this from today or from
 * last week?", and a precise timestamp is one `--json` away.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h`;
  return `${String(Math.floor(h / 24))}d`;
}

/** Single-quote for a POSIX shell only when a token needs it. */
function shellQuote(s: string): string {
  if (s !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The resume command for one record, or `undefined` when there is none.
 *
 * Three separate reasons there may be none, all rendered the same way in the
 * table because the operator's next move is identical in each: the record names
 * a harness this build does not register (an old row after an adapter was
 * removed); the adapter registers but implements no interactive resume; or the
 * adapter threw. The throw is caught rather than propagated because this is a
 * LISTING — one bad row must not take down the other rows with it.
 */
export function resumeCommandFor(rec: SessionRecord): string | undefined {
  const adapter = adapterFor(rec.harness);
  if (adapter?.resumeCommand === undefined) return undefined;
  try {
    const cmd = adapter.resumeCommand({ harness: rec.harness, token: rec.token });
    return [cmd.command, ...cmd.args].map(shellQuote).join(' ');
  } catch {
    return undefined;
  }
}

/** Render the table. Exported for the unit test; `run` does the I/O. */
export function renderTable(records: readonly SessionRecord[], now: number): string {
  const rows = records.map((rec) => [
    rec.order,
    rec.step,
    rec.harness,
    rec.status,
    String(rec.attempt),
    formatAge(now - rec.updatedAt),
    resumeCommandFor(rec) ?? '—',
  ]);
  const header = ['ORDER', 'STEP', 'HARNESS', 'STATUS', 'ATTEMPT', 'AGE', 'RESUME'];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  // The last column is not padded: trailing spaces on a command an operator is
  // about to copy are noise, and a resume command can be long.
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop work sessions: ${parsed.error}\n`);
    usage();
    return 2;
  }

  let cacheDir: string;
  try {
    cacheDir = parsed.cacheDir ?? resolveCacheDir(process.env, loadSettings(process.env).cacheDir);
  } catch (err) {
    process.stderr.write(
      `owenloop work sessions: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  let all: SessionRecord[];
  try {
    all = readSessions(sessionsPath(cacheDir));
  } catch (err) {
    process.stderr.write(
      `owenloop work sessions: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const visible = newestPerKey(all).filter((r) => parsed.all || r.status !== 'dead');
  // Newest first: the session an operator is looking for is almost always the
  // one that just failed.
  visible.sort((a, b) => b.updatedAt - a.updatedAt);

  if (parsed.json) {
    // The RAW records, tokens included. This is machine-local data an operator
    // already owns, and withholding the token would make the output useless for
    // exactly the scripting this flag exists for.
    process.stdout.write(`${JSON.stringify(visible, null, 2)}\n`);
    return 0;
  }

  if (visible.length === 0) {
    process.stdout.write(
      all.length === 0
        ? 'no sessions recorded\n'
        : 'no live sessions — every recorded session is dead (pass --all to see them)\n',
    );
    return 0;
  }

  process.stdout.write(renderTable(visible, Date.now()));
  return 0;
}
