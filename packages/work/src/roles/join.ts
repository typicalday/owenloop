/**
 * `owenloop work join <code> [--hub <origin>] [--as <account>]` — a ONE-TIME
 * PROVISIONING role (NOT runtime): redeem an `ojc_` join code against the
 * hub's unauthenticated `POST /enroll/redeem`, then write the returned
 * `olp_` Scoped Identity token into owenloop's credential store via owenloop's public
 * `storeCredential`. `join` is the SOLE credential-store writer in owenwork —
 * every other role reads the store through `CredentialReader` and never
 * writes it (see src/credentials/resolve.ts).
 *
 * ORIGIN RULE (security-critical): the origin comes ONLY from `--hub` or the
 * existing `settings.hubOrigin` — never from the join code, and never from
 * the hub's own response body. The human states the hub; the code merely
 * redeems there. A pasted code must never be able to redirect a box to an
 * attacker's hub, so no line of this module parses, slices, or inspects
 * `<code>` for anything beyond passing it verbatim in the POST body, and the
 * response's `hubOrigin` field is ignored for every control decision.
 *
 * Settings write: first-write-wins via `recordHubOrigin` (settings/provision.ts)
 * — a differing existing `hubOrigin` is left untouched, with a warning, not
 * overwritten.
 *
 * The redeemed token and the join code appear in NO output line (stdout or
 * stderr) under any code path — they are process→store only.
 *
 * Exit codes: 0 ok · 1 runtime failure (settings load, redeem, store write,
 * unexpected hub response, hub error status) · 2 usage (bad args, missing
 * origin, invalid origin).
 */
import { hostname } from 'node:os';
import { normalizeOrigin } from '../../../../src/hub.ts';
import { storeCredential } from '../../../../src/credentials.ts';
import type { Keychain } from '../../../../src/hub.ts';

import { loadSettings } from '../settings/settings.ts';
import { recordHubOrigin } from '../settings/provision.ts';

interface ParsedArgs {
  code?: string;
  hub?: string;
  as?: string;
  error?: string;
}

/** Parse `<code> [--hub <origin>] [--as <account>]`, both `--flag value` and `--flag=value` forms. */
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
      case '--hub':
      case '--as': {
        const r = takeValue(a, i);
        if ('error' in r) return { error: r.error };
        i = r.next;
        if (name === '--hub') parsed.hub = r.value;
        else parsed.as = r.value;
        break;
      }
      default:
        if (a.startsWith('-')) return { error: `unknown option '${a}'` };
        if (parsed.code === undefined) parsed.code = a;
        else return { error: `unexpected argument '${a}'` };
    }
  }
  return parsed;
}

function usage(err: (line: string) => void): void {
  err('usage: owenloop work join <code> [--hub <origin>] [--as <account>]');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Map a non-2xx redeem response onto the exact-wording exit-1 message (brief-pinned strings for 410/404). */
async function redeemErrorMessage(status: number, res: Response): Promise<string> {
  if (status === 410) {
    return 'code expired or already used — ask for a fresh one (Agents page → Approve/Reconnect)';
  }
  if (status === 404) {
    return 'invalid code — check the paste, or ask for a fresh one (Agents page → Approve/Reconnect)';
  }
  if (status === 409) {
    const body = await safeJson(res);
    const message = typeof body?.['message'] === 'string' ? body['message'] : 'redemption blocked';
    return `${message} — fix it on the console and retry (the code is still valid)`;
  }
  if (status === 429) {
    const retryAfter = res.headers.get('retry-after');
    return retryAfter !== null ? `rate limited — retry in ${retryAfter}s` : 'rate limited';
  }
  if (status === 400) {
    return 'hub rejected the request (bad request)';
  }
  return `hub error ${status}`;
}

async function safeJson(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface RunDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  keychain?: Keychain;
}

export async function run(args: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    err(`owenloop work join: ${parsed.error}`);
    usage(err);
    return 2;
  }
  if (parsed.code === undefined) {
    err('owenloop work join: missing required <code>');
    usage(err);
    return 2;
  }
  const code = parsed.code;

  let settings;
  try {
    settings = loadSettings(env);
  } catch (e) {
    err(`owenloop work join: ${errMsg(e)}`);
    return 1;
  }

  // Origin resolution (security-critical) — see module doc. The code plays no
  // part in this decision at all.
  const raw = parsed.hub ?? settings.hubOrigin;
  if (raw === undefined || raw.trim() === '') {
    err('owenloop work join: no hub origin — pass --hub <origin>, or set hubOrigin in settings');
    return 2;
  }
  let origin: string;
  try {
    origin = normalizeOrigin(raw);
  } catch (e) {
    err(`owenloop work join: ${errMsg(e)}`);
    return 2;
  }

  // Redeem — unauthenticated by design (H4): no Authorization header.
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/enroll/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: { hostname: hostname(), platform: process.platform } }),
    });
  } catch (e) {
    err(`owenloop work join: redeem failed: ${errMsg(e)}`);
    return 1;
  }

  if (!res.ok) {
    err(`owenloop work join: ${await redeemErrorMessage(res.status, res)}`);
    return 1;
  }

  const body = await safeJson(res);
  const token = body?.['token'];
  const agentName = body?.['agentName'];
  if (typeof token !== 'string' || typeof agentName !== 'string') {
    err('owenloop work join: unexpected hub response');
    return 1;
  }
  const poolsRaw = body?.['pools'];
  const pools = Array.isArray(poolsRaw) && poolsRaw.every((p) => typeof p === 'string') ? (poolsRaw as string[]) : undefined;
  // body.hubOrigin (if present) is deliberately never read — see module doc.

  const account = parsed.as ?? agentName;

  let backend: 'keychain' | 'file';
  try {
    backend = await storeCredential(
      { env, ...(deps.keychain !== undefined ? { keychain: deps.keychain } : {}) },
      origin,
      { principal: 'agent', account },
      { kind: 'agent', accessToken: token },
    );
  } catch (e) {
    err(`owenloop work join: ${errMsg(e)}`);
    return 1;
  }

  const recorded = recordHubOrigin(env, origin);
  if (recorded.outcome === 'conflict') {
    err(
      `owenloop work join: warning: settings hubOrigin is ${recorded.existing} (differs from ${origin}) — ` +
        `left untouched; pass --hub <origin> to future commands or edit ${recorded.path}`,
    );
  }

  out(`joined ${origin} as Scoped Identity '${agentName}'`);
  if (pools !== undefined && pools.length > 0) out(`  pools: ${pools.join(', ')}`);
  out(`  credential: agent:${account} (${backend} backend)`);
  // 'unchanged' and 'conflict' both leave the file byte-identical, so both
  // read the same on stdout; the 'conflict' case additionally warned on
  // stderr above with the differing-origin detail.
  const settingsLine = recorded.outcome === 'written' ? `written -> ${recorded.path}` : `hubOrigin already set (unchanged) -> ${recorded.path}`;
  out(`  settings: ${settingsLine}`);
  const asSuffix = account === 'default' ? '' : ` --as ${account}`;
  const shiftScope = pools !== undefined && pools.length > 0 ? pools.join(' ') : '--all';
  out(`  next: owenloop shift start ${shiftScope}${asSuffix}`);

  return 0;
}
