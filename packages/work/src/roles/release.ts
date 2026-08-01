/**
 * `owenloop work release --session <id>` (C6) — session drain. Releases every claim
 * held by a session id via the hub's by-session release verb so those orders
 * re-offer immediately instead of stranding until their leases expire.
 *
 * B3 DRAIN SEMANTICS: the hub releases AGENT-held claims for the session and
 * leaves EXEC-held claims untouched (a running command is doing real work — a
 * session going away must not kill it). The hub enforces the exemption in SQL
 * and does NOT enumerate the exempt claims, so this client can only NOTE that
 * exec-held claims are drain-exempt; it cannot list them.
 *
 * Session identity resolves like `hold`: `--session <id>`, else env
 * `OWENWORK_SESSION`; an empty string counts as missing (matches `resolveHolder`).
 * Missing both is a usage error (exit 2). Origin resolves like the other roles
 * (`--origin` → `settings.hubOrigin`); the bearer comes from owenloop's store
 * via `resolveBearer`, reading the `agent:<account>` slot for `OWENWORK_ACCOUNT`
 * (default `default`), with `OWENWORK_TOKEN` as a documented dev-only override.
 * release has no `--as` flag — a Conductor sets `OWENWORK_ACCOUNT` for a
 * non-default account.
 *
 * Docs call ONLY for the session form; there is deliberately no targeted CLI
 * form (hold/exec release their own targeted claims internally).
 *
 * Exit codes: 0 on a successful drain (including an empty release list) · 1 on
 * a hub/network error · 2 on a usage error (missing session or origin, no Scoped
 * Identity key, or an unknown flag).
 */
import { createHubClient, type HubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import type { ReleaseResponse, ReleaseSessionResponse } from '../hub/types.ts';

interface ParsedArgs {
  session?: string;
  origin?: string;
  error?: string;
}

/** Parse `--session`/`--origin` in both `--flag value` and `--flag=value` forms. */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  const takeValue = (a: string, i: number): { value: string; next: number } | { error: string } => {
    const eq = a.indexOf('=');
    if (eq !== -1) return { value: a.slice(eq + 1), next: i };
    const v = args[i + 1];
    if (v === undefined) return { error: `missing value for ${a}` };
    return { value: v, next: i + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (name) {
      case '--session':
      case '--origin': {
        const r = takeValue(a, i);
        if ('error' in r) return { error: r.error };
        i = r.next;
        if (name === '--session') parsed.session = r.value;
        else parsed.origin = r.value;
        break;
      }
      default:
        return { error: `unknown option '${a}'` };
    }
  }
  return parsed;
}

/**
 * Resolve the session id to drain: explicit `--session`, else env
 * `OWENWORK_SESSION`; an empty string is treated as missing.
 */
export function resolveSession(session: string | undefined, env: Record<string, string | undefined>): string | undefined {
  const id = session ?? env['OWENWORK_SESSION'];
  return id !== undefined && id !== '' ? id : undefined;
}

function usage(err: (line: string) => void): void {
  err('usage: owenloop work release --session <id> [--origin <url>]');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow a release response to the by-session form (the only form this role posts). */
function releasedList(res: ReleaseResponse): Array<{ workflow: string; run: string }> {
  const released = (res as ReleaseSessionResponse).released;
  return Array.isArray(released) ? released : [];
}

export interface RunDeps {
  hub?: HubClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export async function run(args: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;

  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    err(`owenloop work release: ${parsed.error}`);
    usage(err);
    return 2;
  }

  const session = resolveSession(parsed.session, env);
  if (session === undefined) {
    err('owenloop work release: no session id — pass --session <id> or set OWENWORK_SESSION');
    usage(err);
    return 2;
  }

  let settings;
  try {
    settings = loadSettings(env);
  } catch (e) {
    err(`owenloop work release: ${errMsg(e)}`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    err('owenloop work release: no hub origin — pass --origin <url> or set hubOrigin in settings');
    return 2;
  }

  const account = env['OWENWORK_ACCOUNT'] ?? 'default';
  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    err(`owenloop work release: ${bearer.message}`);
    return bearer.code;
  }
  const token = bearer.token;

  const hub = deps.hub ?? createHubClient({ origin, getToken: async () => token });

  let res: ReleaseResponse;
  try {
    res = await hub.release({ session });
  } catch (e) {
    err(`owenloop work release: ${errMsg(e)}`);
    return 1;
  }

  if (res.text !== '') out(res.text);
  const released = releasedList(res);
  for (const claim of released) {
    out(`released ${claim.workflow}/${claim.run}`);
  }
  out('note: exec-held claims are drain-exempt and are not listed');
  return 0;
}
