import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { parseArgs, resolveTarget, resolveHolder, resolveShiftId, exitCodeFor, run } from '../src/roles/hold.ts';
import type { HoldOutcome } from '../src/hold/loop.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';
import type { SignalHost, StdinHost } from '../src/roles/signals.ts';

/**
 * Seed a hermetic owenloop v2 credential file at `<configHome>/owenloop/
 * credentials.json`, storing `token` in the `agent:<account>` slot for `origin`
 * — the real file backend `readStoredCredential` reads under OWENLOOP_NO_KEYCHAIN.
 */
function seedAgentKeys(configHome: string, origin: string, slots: Record<string, string>): void {
  const dir = join(configHome, 'owenloop');
  mkdirSync(dir, { recursive: true });
  const hubs: Record<string, Record<string, unknown>> = { [origin]: {} };
  for (const [account, token] of Object.entries(slots)) {
    hubs[origin]![`agent:${account}`] = { kind: 'agent', accessToken: token };
  }
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 2, hubs }));
}

/**
 * A throwaway hub that records the Authorization header of each POST /api/get_order
 * and answers with a first-contact-completed order (no work, exit 0).
 */
function startRecordingHub(): Promise<{ server: Server; origin: string; auths: string[] }> {
  const auths: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/get_order') {
        auths.push(req.headers['authorization'] ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: '', workflow: 'wf1', run: 'run1', order: null, lease: { claimed: false, outcome: 'ok' } }));
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

test('parseArgs reads the flags, both value forms, and defaults', () => {
  const p = parseArgs(['--order', 'wf1/run1', '--session=sess-9', '--heartbeat-interval', '1500']);
  assert.equal(p.error, undefined);
  assert.equal(p.order, 'wf1/run1');
  assert.equal(p.session, 'sess-9');
  assert.equal(p.heartbeatIntervalMs, 1500);
  assert.equal(p.ignoreStdin, false);
});

test('parseArgs flags --ignore-stdin and an unknown option', () => {
  assert.equal(parseArgs(['--order', 'x', '--ignore-stdin']).ignoreStdin, true);
  assert.match(parseArgs(['--bogus']).error!, /unknown option '--bogus'/);
});

test('parseArgs rejects a non-positive / non-integer interval', () => {
  assert.match(parseArgs(['--heartbeat-interval', '0']).error!, /positive integer/);
  assert.match(parseArgs(['--heartbeat-interval', 'abc']).error!, /positive integer/);
  assert.match(parseArgs(['--heartbeat-interval']).error!, /missing value/);
});

// --jump-tolerance is the WO-6.1 test affordance: it exposes the lease loop's
// existing jumpToleranceMs knob (default unchanged) so drill 5 can trip the
// clock-jump lease check with a short freeze instead of a real >30s sleep.
test('parseArgs reads --jump-tolerance and validates it like the interval', () => {
  assert.equal(parseArgs(['--order', 'wf1/run1', '--jump-tolerance', '300']).jumpToleranceMs, 300);
  assert.equal(parseArgs(['--order', 'wf1/run1', '--jump-tolerance=300']).jumpToleranceMs, 300);
  assert.equal(parseArgs(['--order', 'wf1/run1']).jumpToleranceMs, undefined); // default: loop's 30_000
  assert.match(parseArgs(['--jump-tolerance', '0']).error!, /positive integer/);
  assert.match(parseArgs(['--jump-tolerance', 'abc']).error!, /positive integer/);
  assert.match(parseArgs(['--jump-tolerance']).error!, /missing value/);
});

// W7: --shift both value forms, and its absence defaults to undefined.
test('parseArgs reads --shift, both value forms', () => {
  assert.equal(parseArgs(['--order', 'wf1/run1', '--shift', 'shf_a']).shift, 'shf_a');
  assert.equal(parseArgs(['--order', 'wf1/run1', '--shift=shf_b']).shift, 'shf_b');
  assert.equal(parseArgs(['--order', 'wf1/run1']).shift, undefined);
});

// ---- target resolution ------------------------------------------------------

test('resolveTarget splits a composite on the FIRST slash only', () => {
  assert.deepEqual(resolveTarget('wf1/run_a/b'), { workflow: 'wf1', run: 'run_a/b' });
});

test('resolveTarget pairs a bare run with --workflow', () => {
  assert.deepEqual(resolveTarget('run1', 'wf1'), { workflow: 'wf1', run: 'run1' });
});

test('resolveTarget errors on a bare run without --workflow', () => {
  assert.match((resolveTarget('run1') as { error: string }).error, /no workflow/);
});

test('resolveTarget errors on a composite that conflicts with --workflow', () => {
  assert.match((resolveTarget('wf1/run1', 'other') as { error: string }).error, /drop one/);
});

test('resolveTarget accepts a composite whose --workflow agrees', () => {
  assert.deepEqual(resolveTarget('wf1/run1', 'wf1'), { workflow: 'wf1', run: 'run1' });
});

test('resolveTarget errors on an empty side of the split', () => {
  assert.match((resolveTarget('/run1') as { error: string }).error, /malformed/);
  assert.match((resolveTarget('wf1/') as { error: string }).error, /malformed/);
});

// ---- holder resolution ------------------------------------------------------

// D5: resolveHolder NEVER returns undefined — a holder is now ALWAYS sent. No
// configured session id falls back to `anon:<hostname>:<pid>` (unique per
// process, not a shared constant, so `release --session <id>` drains still
// match only the process that reported that exact id).
test('resolveHolder prefers --session, falls back to OWENLOOP_SESSION, else an anon:<hostname>:<pid> fallback', () => {
  assert.deepEqual(resolveHolder('sess-a', {}), { kind: 'session', id: 'sess-a' });
  assert.deepEqual(resolveHolder(undefined, { OWENLOOP_SESSION: 'env-sess' }), { kind: 'session', id: 'env-sess' });
  assert.deepEqual(resolveHolder(undefined, {}, { hostname: 'host1', pid: 42 }), { kind: 'session', id: 'anon:host1:42' });
  assert.deepEqual(resolveHolder(undefined, { OWENLOOP_SESSION: '' }, { hostname: 'host1', pid: 42 }), {
    kind: 'session',
    id: 'anon:host1:42',
  });
});

// W7: the resolved shiftId (when known) rides along on the holder,
// whichever branch of session-id resolution won — advisory only (D8/INV-82).
test('resolveHolder threads shiftId onto the holder when known, omits it when absent', () => {
  assert.deepEqual(resolveHolder('sess-a', {}, { shiftId: 'shf_1' }), { kind: 'session', id: 'sess-a', shiftId: 'shf_1' });
  assert.deepEqual(resolveHolder(undefined, {}, { shiftId: 'shf_1', hostname: 'h', pid: 7 }), {
    kind: 'session',
    id: 'anon:h:7',
    shiftId: 'shf_1',
  });
  assert.deepEqual(resolveHolder('sess-a', {}), { kind: 'session', id: 'sess-a' }); // no shiftId key at all
});

// W7: flag > OWENLOOP_SHIFT_ID env > undefined; an empty flag value does
// NOT fall through to the env var (a deliberate `--shift=` override of
// "no cid" is honored, matching the frontmatter degrade-safely contract).
test('resolveShiftId prefers --shift flag, falls back to OWENLOOP_SHIFT_ID, else undefined', () => {
  assert.equal(resolveShiftId('shf_a', {}), 'shf_a');
  assert.equal(resolveShiftId(undefined, { OWENLOOP_SHIFT_ID: 'shf_env' }), 'shf_env');
  assert.equal(resolveShiftId(undefined, {}), undefined);
  assert.equal(resolveShiftId(undefined, { OWENLOOP_SHIFT_ID: '' }), undefined);
  assert.equal(resolveShiftId('', { OWENLOOP_SHIFT_ID: 'shf_env' }), undefined);
});

// ---- exit-code mapping ------------------------------------------------------

test('exitCodeFor maps every outcome to the documented code', () => {
  const zero: HoldOutcome[] = ['completed', 'released', 'stopped'];
  const one: HoldOutcome[] = ['ownership-error', 'lease-lost', 'hub-unreachable', 'release-failed'];
  for (const o of zero) assert.equal(exitCodeFor(o), 0);
  for (const o of one) assert.equal(exitCodeFor(o), 1);
});

// ---- run() usage + resolution exits (no network) ----------------------------

let home: string;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  home = mkdtempSync(join(tmpdir(), 'owenloop-hold-home-'));
  // Hermetic: an empty HOME so loadSettings returns {} (no hubOrigin), and no
  // ambient token/session leaking in from the developer's or CI runner's env.
  process.env['HOME'] = home;
  process.env['XDG_CONFIG_HOME'] = home;
  delete process.env['OWENLOOP_TOKEN'];
  delete process.env['OWENLOOP_SESSION'];
  delete process.env['OWENLOOP_ACCOUNT'];
  // Hermetic credential store: force owenloop's file backend (no real keychain
  // shell-out) so an unseeded store reads as absent → the refuse path.
  process.env['OWENLOOP_NO_KEYCHAIN'] = '1';
});
afterEach(() => {
  process.env = savedEnv;
  rmSync(home, { recursive: true, force: true });
});

test('run() exits 2 on a missing --order', async () => {
  assert.equal(await run([]), 2);
});

test('run() exits 2 on a conflicting composite + --workflow', async () => {
  assert.equal(await run(['--order', 'wf1/run1', '--workflow', 'other']), 2);
});

test('run() exits 2 on a bad --heartbeat-interval', async () => {
  assert.equal(await run(['--order', 'wf1/run1', '--heartbeat-interval', 'nope']), 2);
});

test('run() exits 2 when no hub origin is resolvable', async () => {
  // Valid target, but empty settings + no --origin ⇒ no origin.
  assert.equal(await run(['--order', 'wf1/run1']), 2);
});

test('run() exits 2 with the refuse message when no Scoped Identity key is stored', async () => {
  // No OWENLOOP_TOKEN override + a hermetic empty file store (temp HOME/XDG,
  // OWENLOOP_NO_KEYCHAIN forces the file backend) ⇒ the agent slot is absent.
  const err: string[] = [];
  const code = await run(['--order', 'wf1/run1', '--origin', 'https://hub.example'], { err: (l) => err.push(l) });
  assert.equal(code, 2);
  assert.match(
    err.join('\n'),
    /no Scoped Identity key for https:\/\/hub\.example \(account "default"\) — run: owenloop login --hub https:\/\/hub\.example --as agent/,
  );
});

test('run() --as selects the agent slot named in the refuse hint (account "ci")', async () => {
  const err: string[] = [];
  const code = await run(['--order', 'wf1/run1', '--origin', 'https://hub.example', '--as', 'ci'], { err: (l) => err.push(l) });
  assert.equal(code, 2);
  assert.match(
    err.join('\n'),
    /no Scoped Identity key for https:\/\/hub\.example \(account "ci"\) — run: owenloop login --hub https:\/\/hub\.example --as agent:ci/,
  );
});

// ---- run() wiring: signals + stdin EOF (fake hub, no network) ---------------

/** A get_order response with the given lease state (role-level twin). */
function order(claimed: boolean, outcome?: string): GetOrderResponse {
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: null,
    lease: { claimed, ...(outcome !== undefined ? { outcome } : {}) },
  };
}

/** A hub whose lease state is scripted and whose heartbeat can run a hook. */
function roleHub(cfg: { getOrder: GetOrderResponse; onHeartbeat?: (n: number) => void }): {
  hub: HubClient;
  releases: unknown[];
} {
  const releases: unknown[] = [];
  let hbIdx = 0;
  const hub: HubClient = {
    async getOrder() {
      return cfg.getOrder;
    },
    async heartbeat() {
      cfg.onHeartbeat?.(hbIdx++);
      return { text: '' };
    },
    async release(req) {
      releases.push(req);
      return { text: '' };
    },
    async whatsNext() {
      return { text: '' };
    },
    async submit() {
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
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

/** A fake process slice: records signal handlers and exit codes, can emit. */
function fakeSignalHost(): {
  host: SignalHost;
  exits: number[];
  registered: string[];
  emit: (sig: 'SIGINT' | 'SIGTERM') => void;
} {
  const handlers: Record<string, Array<() => void>> = { SIGINT: [], SIGTERM: [] };
  const exits: number[] = [];
  const registered: string[] = [];
  const host: SignalHost = {
    on(sig, h) {
      registered.push(sig);
      handlers[sig]!.push(h);
      return host;
    },
    exit(code) {
      exits.push(code);
    },
  };
  return {
    host,
    exits,
    registered,
    emit: (sig) => {
      for (const h of [...handlers[sig]!]) h();
    },
  };
}

/** A fake stdin slice: records watcher installs, can emit EOF. */
function fakeStdinHost(): { host: StdinHost; onCalls: string[]; emitEof: () => void } {
  const handlers: Array<() => void> = [];
  const onCalls: string[] = [];
  const host: StdinHost = {
    on(ev, h) {
      onCalls.push(ev);
      handlers.push(h);
      return host;
    },
    resume(): void {},
  };
  return {
    host,
    onCalls,
    emitEof: () => {
      for (const h of [...handlers]) h();
    },
  };
}

const WIRE_ARGS = ['--order', 'wf1/run1', '--origin', 'https://hub.example', '--heartbeat-interval', '5'];

test('run() with --ignore-stdin installs NO stdin watcher (signals still wired)', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  const { hub } = roleHub({ getOrder: order(false, 'ok') }); // completed ⇒ run resolves at first contact
  const sig = fakeSignalHost();
  const stdin = fakeStdinHost();

  const code = await run([...WIRE_ARGS, '--ignore-stdin'], {
    hub,
    signalHost: sig.host,
    stdin: stdin.host,
    out: () => {},
    err: () => {},
  });

  assert.equal(code, 0);
  assert.deepEqual(stdin.onCalls, []); // the watcher was never installed
  assert.deepEqual(sig.registered.sort(), ['SIGINT', 'SIGTERM']);
});

test('run() without --ignore-stdin: stdin EOF triggers stop(stdin-eof) → final-breath release', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  const stdin = fakeStdinHost();
  // First heartbeat simulates the parent session dying: stdin reaches EOF.
  const { hub, releases } = roleHub({
    getOrder: order(true),
    onHeartbeat: (n) => {
      if (n === 0) stdin.emitEof();
    },
  });
  const sig = fakeSignalHost();
  const out: string[] = [];

  const code = await run(WIRE_ARGS, {
    hub,
    signalHost: sig.host,
    stdin: stdin.host,
    out: (line) => out.push(line),
    err: () => {},
  });

  assert.equal(code, 0);
  // The watcher WAS installed (end + close), and EOF flowed through as the
  // stop reason on the final-breath line — pinning stop('stdin-eof').
  assert.deepEqual(stdin.onCalls.sort(), ['close', 'end']);
  assert.ok(out.some((l) => /final breath \(stdin-eof\) — releasing wf1\/run1/.test(l)), out.join('\n'));
  assert.ok(out.some((l) => /released wf1\/run1/.test(l)), out.join('\n'));
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1' }]);
});

test('run() signal wiring: hold-role message lines, stop(signal), second SIGINT exits 130', async () => {
  process.env['OWENLOOP_TOKEN'] = 'tok';
  const sig = fakeSignalHost();
  const { hub, releases } = roleHub({
    getOrder: order(true),
    onHeartbeat: (n) => {
      if (n === 0) {
        sig.emit('SIGINT'); // first: final breath
        sig.emit('SIGINT'); // second: an operator insisting
      }
    },
  });
  const stdin = fakeStdinHost();
  const out: string[] = [];
  const err: string[] = [];

  const code = await run(WIRE_ARGS, {
    hub,
    signalHost: sig.host,
    stdin: stdin.host,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  assert.equal(code, 0); // the fake host records exit(130); run still resolves via release
  assert.ok(err.includes('owenloop work hold: SIGINT received — final breath'), err.join('\n'));
  assert.ok(err.includes('owenloop work hold: second SIGINT — exiting now'), err.join('\n'));
  assert.deepEqual(sig.exits, [130]);
  assert.ok(out.some((l) => /final breath \(signal\) — releasing wf1\/run1/.test(l)), out.join('\n'));
  assert.deepEqual(releases, [{ workflow: 'wf1', run: 'run1' }]);
});

// ---- store-backed success (no OWENLOOP_TOKEN — the primary path) -------------
// These run WITHOUT an injected hub: the role builds a REAL client whose getToken
// resolves the agent slot from the seeded store; the mock hub answers first
// contact with a completed order (exit 0) while recording the auth header.

test('with no OWENLOOP_TOKEN, hold authenticates with the agent slot token from the store', async () => {
  const { server, origin, auths } = await startRecordingHub();
  seedAgentKeys(home, origin, { default: 'olp_from_store' });
  try {
    const code = await run(['--order', 'wf1/run1', '--origin', origin, '--heartbeat-interval', '5'], {
      signalHost: fakeSignalHost().host,
      stdin: fakeStdinHost().host,
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(auths, ['Bearer olp_from_store']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('--as ci selects the ci agent slot (not default) for the hold client', async () => {
  const { server, origin, auths } = await startRecordingHub();
  seedAgentKeys(home, origin, { default: 'tok_default', ci: 'tok_ci' });
  try {
    const code = await run(['--order', 'wf1/run1', '--origin', origin, '--as', 'ci', '--heartbeat-interval', '5'], {
      signalHost: fakeSignalHost().host,
      stdin: fakeStdinHost().host,
      out: () => {},
      err: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(auths, ['Bearer tok_ci']);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
