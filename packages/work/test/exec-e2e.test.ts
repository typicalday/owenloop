import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExecLoop } from '../src/exec/loop.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';
import type { CommandReceipt } from '../src/exec/receipt.ts';
import type { InstructionResolver } from '../src/exec/instructions.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { createBundleIngestor, createStoreInstructionSource } from '../../../src/store/index.ts';
import { installBundleFixture, installSignedBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';

// Plan test 12 — integration-style, end to end through the REAL pieces: the
// default runner (a real child), the real receipt builder, and the REAL hub
// client speaking HTTP to a throwaway `node:http` mock hub. Two drills:
//   1. get_order → ≥1 heartbeat (exec holder asserted on the wire) → the
//      command runs → submit lands the receipt → the run closes (no release).
//   2. the KILL drill: signal mid-run → the real child is taken down → NO
//      submit, a release observed on the wire.
// Commands are harmless fixtures in a temp cwd.

const CWD = mkdtempSync(join(tmpdir(), 'owenloop-exec-e2e-'));
const EXEC = { kind: 'exec' as const, id: 'host:9' };
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function commandOrder(command: string): GetOrderResponse {
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: {
      run: 'run1',
      workflow: 'wf1',
      step: 'builder',
      key: 'k',
      inputs: [],
      outputs: [],
      worker: 'command',
      defDigest: 'test-e2e-digest',
      consumes: {},
      owes: [{ path: 'artifacts/build', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    },
    lease: { claimed: true },
  };
}

function storeCommandOrder(defDigest: string, remoteCommand: string): GetOrderResponse {
  const response = commandOrder('ignored remote placeholder');
  response.order!.defDigest = defDigest;
  (response.order! as unknown as Record<string, unknown>)['command'] = remoteCommand;
  return response;
}

interface HubReq {
  verb: string;
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
}

/** A throwaway HTTP hub: records every request, serves canned verb responses. */
async function startMockHub(order: GetOrderResponse): Promise<{ origin: string; reqs: HubReq[]; server: Server }> {
  const reqs: HubReq[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      const verb = (req.url ?? '').replace(/^\/api\//, '');
      reqs.push({
        verb,
        auth: req.headers.authorization,
        body: raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>),
      });
      res.setHeader('content-type', 'application/json');
      if (verb === 'get_order') res.end(JSON.stringify(order));
      else if (verb === 'submit') res.end(JSON.stringify({ text: '', outcome: 'green' }));
      else res.end(JSON.stringify({ text: '' })); // heartbeat / release
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, reqs, server };
}

function loopWithInstructions(origin: string, instructions: InstructionResolver): ReturnType<typeof createExecLoop> {
  return createExecLoop({
    hub: createHubClient({ origin, getToken: async () => 'tok-e2e' }),
    runner: createDefaultRunner(),
    workflow: 'wf1',
    run: 'run1',
    holder: EXEC,
    instructions,
    cwd: CWD,
    sleep: realSleep,
    now: () => Date.now(),
    out: () => {},
    err: () => {},
    heartbeatIntervalMs: 25, // fast beats so a sub-second command sees ≥1
  });
}

function loopAgainst(origin: string, command: string): ReturnType<typeof createExecLoop> {
  const instructions: InstructionResolver = {
    resolveCommand: async () => ({ ok: true, command }),
    resolveStep: async () => ({ ok: false, kind: 'unknown-step', reason: 'step resolution is not used by exec e2e tests' }),
  };
  return loopWithInstructions(origin, instructions);
}

async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await realSleep(10);
  }
}

const of = (reqs: HubReq[], verb: string): HubReq[] => reqs.filter((r) => r.verb === verb);

test('e2e: get_order → ≥1 heartbeat (holder on the wire) → run → submit → close', async () => {
  const { origin, reqs, server } = await startMockHub(commandOrder('sleep 0.3; echo hi'));
  try {
    const loop = loopAgainst(origin, 'sleep 0.3; echo hi');
    assert.equal(await loop.run(), 'submitted');

    // First contact carried the exec holder and the bearer token.
    const go = of(reqs, 'get_order')[0]!;
    assert.equal(go.auth, 'Bearer tok-e2e');
    assert.deepEqual(go.body!['holder'], EXEC);

    // ≥1 heartbeat landed while the command ran, each with the SAME exec holder.
    const beats = of(reqs, 'heartbeat');
    assert.ok(beats.length >= 1, `expected >=1 heartbeat, saw ${beats.length}`);
    for (const b of beats) assert.deepEqual(b.body!['holder'], EXEC);

    // Exactly one receipt to the owed path; the run closed via submit — no release.
    const subs = of(reqs, 'submit');
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.body!['path'], 'artifacts/build');
    const r = subs[0]!.body!['value'] as CommandReceipt;
    assert.equal(r.kind, 'command-receipt');
    assert.equal(r.exitCode, 0);
    assert.equal(r.outputHash, `sha256:${createHash('sha256').update('hi\n').digest('hex')}`);
    assert.equal(r.orchestrator, 'host:9');
    assert.equal(of(reqs, 'release').length, 0);
  } finally {
    server.close();
  }
});

test('e2e kill drill: signal mid-run → real child killed → release observed, NO submit', async () => {
  const { origin, reqs, server } = await startMockHub(commandOrder('sleep 30'));
  try {
    const loop = loopAgainst(origin, 'sleep 30');
    const p = loop.run();
    // The command is running once a heartbeat lands (first contact done, race on).
    await until(() => of(reqs, 'heartbeat').length >= 1, 'the first heartbeat');
    loop.stop('signal'); // the operator's SIGINT/SIGTERM path

    assert.equal(await p, 'killed');
    assert.equal(of(reqs, 'submit').length, 0); // killed work gets NO receipt
    const rels = of(reqs, 'release');
    assert.equal(rels.length, 1); // …and the order was handed back
    assert.equal(rels[0]!.body!['run'], 'run1');
  } finally {
    server.close();
  }
});

test('actual exec CLI stop while signed bundle recovery is pending exits without a command launch', async () => {
  const home = tempDir('owenloop-exec-recovery-stop-');
  const marker = join(home, 'command-ran');
  const sourceDir = writeBundleSource({ name: 'stopped-exec', workflow: `name: stopped-exec
steps:
  - name: builder
    produces: [out]
    terminal: true
    executor: command
    command: 'echo unsafe-late-launch > "${marker}"'
` });
  const signed = await installSignedBundleFixture({ sourceDir, root: join(home, 'remote-publication'), home });
  assert.equal(signed.source.kind, 'file');
  const publication = readFileSync(`${signed.source.path}.dsse`);
  const key = join(home, 'tls.key');const cert = join(home, 'tls.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  let entered!: () => void;const pending = new Promise<void>(r => { entered = r; });
  let resume!: () => void;const blocked = new Promise<void>(r => { resume = r; });
  const seen: string[] = [];
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    seen.push(req.url!);assert.equal(req.headers.authorization, 'Bearer exec-stop-local-test');
    for await (const _chunk of req) { /* drain the ordinary request body */ }
    if (req.url === `/api/bundles/${signed.packed.digest}`) {
      entered();await blocked;res.writeHead(200, { 'content-type': 'application/octet-stream' });res.end(signed.packed.bytes);
    } else if (req.url === `/api/publications/${signed.packed.digest}`) {
      res.writeHead(200, { 'x-owenloop-publication-state': 'signed' });res.end(publication);
    } else if (req.url?.startsWith('/api/origins/')) { res.writeHead(404);res.end(); }
    else if (req.url === '/api/get_order') res.end(JSON.stringify(storeCommandOrder(signed.packed.digest, 'ignored remote command')));
    else res.end(JSON.stringify({ text: '' }));
  });
  await new Promise<void>(r => server.listen(0, 'localhost', r));
  const address = server.address();assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, [join(import.meta.dirname, '../../../bin/owenloop.mjs'), 'work', 'exec',
    'wf1/run1', '--origin', `https://localhost:${address.port}`, '--heartbeat-interval', '25'], {
    cwd: home,env: { ...process.env, ...signed.env, OWENLOOP_TOKEN: 'exec-stop-local-test',
      OWENLOOP_CONFIG_DIR: '', OWENLOOP_SESSION: '', OWENLOOP_DEF_POLICY: 'enforce', NODE_EXTRA_CA_CERTS: cert },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';child.stderr!.on('data', data => { stderr += String(data); });child.stdout!.resume();
  const exited = new Promise<number | null>(r => child.once('exit', r));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending, exited.then(code => { throw new Error(`CLI exited before recovery: ${code}: ${stderr}`); })]);
    child.kill('SIGTERM');
    const outcome = await Promise.race([exited, new Promise<'pending'>(r => { timer = setTimeout(() => r('pending'), 2_000); })]);
    assert.equal(outcome, 1, `CLI must exit while resolver remains blocked: ${stderr}`);
    assert.equal(existsSync(marker), false);
    assert.equal(seen.filter(path => path === '/api/release').length, 1);
    assert.equal(seen.some(path => ['/api/submit', '/api/ask', '/api/reject'].includes(path)), false);
  } finally {
    clearTimeout(timer);resume();await exited;
    await new Promise<void>(r => server.close(() => r()));
  }
});
