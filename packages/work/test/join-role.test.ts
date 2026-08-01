import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs, run } from '../src/roles/join.ts';
import { recordHubOrigin } from '../src/settings/provision.ts';

// Fake token/code constants. TOKEN carries the real `olp_` prefix so the
// no-leak assertions actually bite; CODE is a throwaway `ojc_` literal. Never
// real secrets.
const TOKEN = 'olp_test_join_tok';
const CODE = 'ojc_deadbeef_s3cret';

interface RecordedRequest {
  headers: IncomingMessage['headers'];
  body: unknown;
}

interface StubReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A throwaway `POST /enroll/redeem` stub hub that records each request and replies with a scripted response. */
function startStubHub(reply: StubReply): Promise<{ server: Server; origin: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/enroll/redeem') {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          requests.push({ headers: req.headers, body });
          res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
          res.end(JSON.stringify(reply.body));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function fixture(): { home: string; env: Record<string, string | undefined> } {
  const home = mkdtempSync(join(tmpdir(), 'owenwork-join-'));
  return {
    home,
    env: { HOME: home, XDG_CONFIG_HOME: home, OWENLOOP_NO_KEYCHAIN: '1' },
  };
}

function credentialsPath(home: string): string {
  return join(home, 'owenloop', 'credentials.json');
}

function settingsFilePath(home: string): string {
  return join(home, 'owenwork', 'settings.json');
}

interface CredentialFileShape {
  version: number;
  hubs: Record<string, Record<string, { kind: string; accessToken: string }>>;
}

function readCredentials(home: string): CredentialFileShape {
  return JSON.parse(readFileSync(credentialsPath(home), 'utf8')) as CredentialFileShape;
}

interface SettingsFileShape {
  hubOrigin?: string;
  [key: string]: unknown;
}

function readSettingsFile(home: string): SettingsFileShape {
  return JSON.parse(readFileSync(settingsFilePath(home), 'utf8')) as SettingsFileShape;
}

function writeSettings(home: string, value: unknown): void {
  const path = settingsFilePath(home);
  mkdirSync(join(home, 'owenwork'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

async function runRole(args: string[], env: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// ---- parseArgs ---------------------------------------------------------------

test('parseArgs reads <code>, --hub, --as in both value forms', () => {
  assert.deepEqual(parseArgs(['ojc_x', '--hub', 'https://h', '--as', 'ci']), {
    code: 'ojc_x',
    hub: 'https://h',
    as: 'ci',
  });
  assert.deepEqual(parseArgs(['ojc_x', '--hub=https://h', '--as=ci']), {
    code: 'ojc_x',
    hub: 'https://h',
    as: 'ci',
  });
});

test('parseArgs rejects unknown flag, missing value, and an extra positional', () => {
  assert.match(parseArgs(['ojc_x', '--bogus']).error!, /unknown option '--bogus'/);
  assert.match(parseArgs(['ojc_x', '--hub']).error!, /missing value for --hub/);
  assert.match(parseArgs(['ojc_x', 'ojc_y']).error!, /unexpected argument 'ojc_y'/);
});

test('parseArgs with no positional leaves code undefined (run() reports the usage error)', () => {
  assert.deepEqual(parseArgs(['--hub', 'https://h']), { hub: 'https://h' });
});

// ---- run(): usage exits (no network) -----------------------------------------

test('run() exits 2 on a missing <code>', async () => {
  const { home, env } = fixture();
  try {
    const { code, err } = await runRole(['--hub', 'https://h'], env);
    assert.equal(code, 2);
    assert.match(err, /missing required <code>/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('run() exits 2 on an unknown flag', async () => {
  const { home, env } = fixture();
  try {
    const { code, err } = await runRole([CODE, '--bogus'], env);
    assert.equal(code, 2);
    assert.match(err, /unknown option '--bogus'/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- run(): case 4 — missing origin, code never supplies one -----------------

test('missing origin: exit 2, names both remedies, hits the hub zero times, writes nothing', async () => {
  const { home, env } = fixture();
  try {
    const { code, err } = await runRole([CODE], env);
    assert.equal(code, 2);
    assert.match(err, /--hub/);
    assert.match(err, /hubOrigin/);
    assert.equal(existsSync(credentialsPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- run(): happy path ---------------------------------------------------------

test('happy path: stores the credential, writes settings.hubOrigin, prints a token-free confirmation', async () => {
  const { home, env } = fixture();
  const { server, origin, requests } = await startStubHub({
    status: 200,
    body: { token: TOKEN, agentName: 'box1', hubOrigin: 'https://ignored.example' },
  });
  try {
    const { code, out, err } = await runRole([CODE, '--hub', origin], env);
    assert.equal(code, 0);

    const creds = readCredentials(home);
    assert.equal(creds.hubs[origin]?.['agent:box1']?.accessToken, TOKEN);

    const settings = readSettingsFile(home);
    assert.equal(settings.hubOrigin, origin);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.headers['authorization'], undefined);
    assert.deepEqual(requests[0]!.body, { code: CODE, device: { hostname: hostname(), platform: process.platform } });

    const combined = out + err;
    assert.doesNotMatch(combined, /olp_/);
    assert.doesNotMatch(combined, new RegExp(CODE));
    assert.match(out, /box1/);
    assert.match(out, /file/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Note: the 200 body above deliberately carries a `hubOrigin` field that is a
// DIFFERENT, bogus origin ('https://ignored.example') from the real stub
// origin used for --hub. The settings assertion above (`settings.hubOrigin
// === origin`, the real stub origin, never the bogus response value) proves
// join.ts ignores `response.hubOrigin` for every control decision (assumption
// 4) — a network-supplied origin must never steer where future commands
// point.

test('--as override: stores under agent:<as>, next-step shows --as', async () => {
  const { home, env } = fixture();
  const { server, origin } = await startStubHub({
    status: 200,
    body: { token: TOKEN, agentName: 'box1', hubOrigin: 'https://ignored.example' },
  });
  try {
    const { code, out } = await runRole([CODE, '--hub', origin, '--as', 'ci'], env);
    assert.equal(code, 0);
    const creds = readCredentials(home);
    assert.equal(creds.hubs[origin]?.['agent:ci']?.accessToken, TOKEN);
    assert.match(out, /--as ci/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- run(): hub error status mapping ------------------------------------------

test('burned/expired code (410): exit 1 with the exact brief-pinned message', async () => {
  const { home, env } = fixture();
  const { server, origin } = await startStubHub({ status: 410, body: { error: 'gone', message: 'redeemed' } });
  try {
    const { code, err } = await runRole([CODE, '--hub', origin], env);
    assert.equal(code, 1);
    assert.match(err, /code expired or already used — ask for a fresh one \(Agents page → Approve\/Reconnect\)/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('invalid code (404): exit 1 with a message distinct from the 410 case', async () => {
  const { home, env } = fixture();
  const { server, origin } = await startStubHub({ status: 404, body: { error: 'invalid_code' } });
  try {
    const { code, err } = await runRole([CODE, '--hub', origin], env);
    assert.equal(code, 1);
    assert.match(err, /invalid code — check the paste, or ask for a fresh one \(Agents page → Approve\/Reconnect\)/);
    assert.doesNotMatch(err, /expired or already used/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('rate limited (429): exit 1, mentions retry + the Retry-After seconds', async () => {
  const { home, env } = fixture();
  const { server, origin } = await startStubHub({
    status: 429,
    body: { error: 'rate_limited' },
    headers: { 'retry-after': '30' },
  });
  try {
    const { code, err } = await runRole([CODE, '--hub', origin], env);
    assert.equal(code, 1);
    assert.match(err, /retry/);
    assert.match(err, /30/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- run(): first-write-wins settings behavior --------------------------------

test('first-write-wins conflict: credential still stored, settings left untouched, warning printed', async () => {
  const { home, env } = fixture();
  writeSettings(home, { hubOrigin: 'https://other.example' });
  const { server, origin } = await startStubHub({
    status: 200,
    body: { token: TOKEN, agentName: 'box1', hubOrigin: 'https://ignored.example' },
  });
  try {
    const { code, out, err } = await runRole([CODE, '--hub', origin], env);
    assert.equal(code, 0);
    const creds = readCredentials(home);
    assert.equal(creds.hubs[origin]?.['agent:box1']?.accessToken, TOKEN);
    const settings = readSettingsFile(home);
    assert.equal(settings.hubOrigin, 'https://other.example');
    assert.match(err, /left untouched/);
    const combined = out + err;
    assert.doesNotMatch(combined, /olp_/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('unchanged: pre-seeded settings matching the stub origin resolves without --hub, file stays byte-identical', async () => {
  const { home, env } = fixture();
  const { server, origin } = await startStubHub({
    status: 200,
    body: { token: TOKEN, agentName: 'box1', hubOrigin: 'https://ignored.example' },
  });
  writeSettings(home, { hubOrigin: origin });
  const before = readFileSync(settingsFilePath(home), 'utf8');
  try {
    const { code } = await runRole([CODE], env);
    assert.equal(code, 0);
    const after = readFileSync(settingsFilePath(home), 'utf8');
    assert.equal(after, before);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- recordHubOrigin unit trio --------------------------------------------------

test('recordHubOrigin: written / unchanged (normalized-equal) / conflict, preserving unknown keys', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenwork-provision-'));
  const env = { HOME: home, XDG_CONFIG_HOME: home };
  try {
    const w = recordHubOrigin(env, 'https://h.example');
    assert.equal(w.outcome, 'written');
    assert.equal(readSettingsFile(home).hubOrigin, 'https://h.example');

    writeSettings(home, { hubOrigin: 'https://h.example/', someUnknownKey: 42 });
    const u = recordHubOrigin(env, 'https://h.example');
    assert.equal(u.outcome, 'unchanged');
    // byte-identical: no rewrite happened.
    assert.deepEqual(readSettingsFile(home), { hubOrigin: 'https://h.example/', someUnknownKey: 42 });

    writeSettings(home, { hubOrigin: 'https://other.example', someUnknownKey: 7 });
    const c = recordHubOrigin(env, 'https://h.example');
    assert.equal(c.outcome, 'conflict');
    if (c.outcome === 'conflict') assert.equal(c.existing, 'https://other.example');
    assert.deepEqual(readSettingsFile(home), { hubOrigin: 'https://other.example', someUnknownKey: 7 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('recordHubOrigin: a written merge preserves unknown keys already in the file', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenwork-provision-'));
  const env = { HOME: home, XDG_CONFIG_HOME: home };
  try {
    writeSettings(home, { dispatchCap: 5 });
    const r = recordHubOrigin(env, 'https://h.example');
    assert.equal(r.outcome, 'written');
    assert.deepEqual(readSettingsFile(home), { dispatchCap: 5, hubOrigin: 'https://h.example' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
