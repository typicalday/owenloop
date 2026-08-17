import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs, resolveSession, run } from '../src/roles/release.ts';
import type { HubClient } from '../src/hub/client.ts';
import { HubError, type ReleaseRequest, type ReleaseResponse } from '../src/hub/types.ts';

/**
 * Seed a hermetic owenloop v2 credential file at `<home>/.owenloop/
 * credentials.json`, storing `token` in the `agent:<account>` slot for `origin`
 * — the real file backend `readStoredCredential` reads under OWENLOOP_NO_KEYCHAIN.
 */
function seedAgentKeys(home: string, origin: string, slots: Record<string, string>): void {
  const dir = join(home, '.owenloop');
  mkdirSync(dir, { recursive: true });
  const hubs: Record<string, Record<string, unknown>> = { [origin]: {} };
  for (const [account, token] of Object.entries(slots)) {
    hubs[origin]![`agent:${account}`] = { kind: 'agent', accessToken: token };
  }
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 2, hubs }));
}

/** A throwaway hub that records the Authorization header of each /api/release POST. */
function startRecordingHub(): Promise<{ server: Server; origin: string; auths: string[] }> {
  const auths: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/release') {
        auths.push(req.headers['authorization'] ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'drained', released: [] }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}`, auths });
    });
  });
}

// ---- arg parsing ------------------------------------------------------------

test('parseArgs reads --session/--origin in both value forms', () => {
  assert.deepEqual(parseArgs(['--session', 's1', '--origin', 'https://h']), {
    session: 's1',
    origin: 'https://h',
  });
  assert.deepEqual(parseArgs(['--session=s2']), { session: 's2' });
});

test('parseArgs rejects an unknown flag and a missing value', () => {
  assert.match(parseArgs(['--bogus']).error!, /unknown option '--bogus'/);
  assert.match(parseArgs(['--session']).error!, /missing value for --session/);
});

// ---- session resolution -----------------------------------------------------

test('resolveSession prefers --session, falls back to env, empty = missing', () => {
  assert.equal(resolveSession('s-a', {}), 's-a');
  assert.equal(resolveSession(undefined, { OWENLOOP_SESSION: 'env-s' }), 'env-s');
  assert.equal(resolveSession(undefined, {}), undefined);
  // An explicit empty --session is treated as missing WITHOUT falling back to
  // env (matches hold's resolveHolder: `'' ?? env` is '', then empty ⇒ missing).
  assert.equal(resolveSession('', { OWENLOOP_SESSION: 'env-s' }), undefined);
  assert.equal(resolveSession(undefined, { OWENLOOP_SESSION: '' }), undefined);
});

// ---- fake hub ---------------------------------------------------------------

/** A hub that records release requests and returns a scripted response (or throws). */
function fakeHub(reply: ReleaseResponse | Error): { hub: HubClient; releases: ReleaseRequest[] } {
  const releases: ReleaseRequest[] = [];
  const hub: HubClient = {
    async release(req) {
      releases.push(req);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async whatsNext() {
      return { text: '' };
    },
    async getOrder() {
      return { text: '', workflow: '', run: '', order: null, lease: { claimed: false } };
    },
    async heartbeat() {
      return { text: '' };
    },
    async submit() {
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
    async ask() { return { text: '', ok: true }; },
    // The tool-approval gate is not exercised by these tests; a fake that never
    // opens an approval, and a non-answer is a denial.
    async requestApproval() { return { text: '', ok: false }; },
    async answerApproval() { return { text: '', ok: false }; },
    async listPendingApprovals() { return { text: '', approvals: [] }; },
    async reportResolution(req) {
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
  return { hub, releases };
}

async function runRole(
  args: string[],
  env: Record<string, string | undefined>,
  hub?: HubClient,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, {
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(hub !== undefined ? { hub } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// A hermetic env: an empty temp HOME so loadSettings returns {} (no hubOrigin),
// plus an explicit origin/token unless a case is testing their absence.
function baseEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: mkdtempSync(join(tmpdir(), 'owenloop-release-')), OWENLOOP_TOKEN: 'tok', ...extra };
}

// ---- run(): usage exits (no network) ----------------------------------------

test('run() exits 2 when no session id is resolvable', async () => {
  const env = baseEnv({ OWENLOOP_SESSION: undefined });
  try {
    const { code, err } = await runRole(['--origin', 'https://h'], env);
    assert.equal(code, 2);
    assert.match(err, /no session id/);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

test('run() exits 2 when no hub origin is resolvable', async () => {
  const env = baseEnv();
  try {
    const { code, err } = await runRole(['--session', 's1'], env);
    assert.equal(code, 2);
    assert.match(err, /no hub origin/);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

test('run() exits 2 with the refuse message when no Scoped Identity key is stored', async () => {
  // No OWENLOOP_TOKEN override + a hermetic empty file store (temp HOME,
  // OWENLOOP_NO_KEYCHAIN forces the file backend) ⇒ the agent slot is absent.
  const env = baseEnv({ OWENLOOP_TOKEN: undefined, OWENLOOP_NO_KEYCHAIN: '1' });
  try {
    const { code, err } = await runRole(['--session', 's1', '--origin', 'https://h'], env);
    assert.equal(code, 2);
    assert.match(err, /no Scoped Identity key for https:\/\/h \(account "default"\) — run: owenloop login --hub https:\/\/h --as agent/);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

test('run() exits 2 on an unknown flag', async () => {
  const env = baseEnv();
  try {
    const { code, err } = await runRole(['--session', 's1', '--bogus'], env);
    assert.equal(code, 2);
    assert.match(err, /unknown option '--bogus'/);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

// ---- run(): drain against the mock hub --------------------------------------

test('happy path posts {session} and prints each released order + the exemption note', async () => {
  const env = baseEnv();
  const { hub, releases } = fakeHub({
    text: 'released 2 claim(s) for session s1',
    released: [
      { workflow: 'wfA', run: 'r1' },
      { workflow: 'wfB', run: 'r2' },
    ],
  });
  try {
    const { code, out } = await runRole(['--session', 's1', '--origin', 'https://h'], env, hub);
    assert.equal(code, 0);
    // Posted exactly the by-session form.
    assert.deepEqual(releases, [{ session: 's1' }]);
    assert.match(out, /released 2 claim\(s\) for session s1/);
    assert.match(out, /released wfA\/r1/);
    assert.match(out, /released wfB\/r2/);
    assert.match(out, /exec-held claims are drain-exempt and are not listed/);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

test('session id falls back to OWENLOOP_SESSION', async () => {
  const env = baseEnv({ OWENLOOP_SESSION: 'env-sess', OWENLOOP_TOKEN: 'tok' });
  const { hub, releases } = fakeHub({ text: '', released: [] });
  try {
    const { code } = await runRole(['--origin', 'https://h'], env, hub);
    assert.equal(code, 0);
    assert.deepEqual(releases, [{ session: 'env-sess' }]);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

test('an empty released list is a success (exit 0) and still prints the note', async () => {
  const env = baseEnv();
  const { hub } = fakeHub({ text: 'no session-held claims', released: [] });
  try {
    const { code, out } = await runRole(['--session', 's1', '--origin', 'https://h'], env, hub);
    assert.equal(code, 0);
    assert.match(out, /no session-held claims/);
    assert.match(out, /exec-held claims are drain-exempt/);
    assert.doesNotMatch(out, /^released /m);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

test('a hub error exits 1 and surfaces the hub message', async () => {
  const env = baseEnv();
  const { hub } = fakeHub(new HubError(500, 'hub exploded'));
  try {
    const { code, err } = await runRole(['--session', 's1', '--origin', 'https://h'], env, hub);
    assert.equal(code, 1);
    assert.match(err, /hub exploded/);
  } finally {
    rmSync(env['HOME']!, { recursive: true, force: true });
  }
});

// ---- store-backed success (no OWENLOOP_TOKEN — the primary path) -------------

test('with no OWENLOOP_TOKEN, release authenticates with the agent slot token from the store', async () => {
  const { server, origin, auths } = await startRecordingHub();
  const home = mkdtempSync(join(tmpdir(), 'owenloop-release-store-'));
  seedAgentKeys(home, origin, { default: 'olp_from_store' });
  // No override; hermetic file backend points the store at our seeded file.
  const env: Record<string, string | undefined> = {
    HOME: home,
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENLOOP_TOKEN: undefined,
  };
  try {
    // No injected hub — the role builds a REAL client that hits the mock server.
    const { code } = await runRole(['--session', 's1', '--origin', origin], env);
    assert.equal(code, 0);
    assert.deepEqual(auths, ['Bearer olp_from_store']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});

test('OWENLOOP_ACCOUNT selects a different agent slot (ci token, not default)', async () => {
  const { server, origin, auths } = await startRecordingHub();
  const home = mkdtempSync(join(tmpdir(), 'owenloop-release-acct-'));
  seedAgentKeys(home, origin, { default: 'tok_default', ci: 'tok_ci' });
  const env: Record<string, string | undefined> = {
    HOME: home,
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENLOOP_TOKEN: undefined,
    OWENLOOP_ACCOUNT: 'ci',
  };
  try {
    const { code } = await runRole(['--session', 's1', '--origin', origin], env);
    assert.equal(code, 0);
    assert.deepEqual(auths, ['Bearer tok_ci']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});
