import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExecLoop } from '../src/exec/loop.ts';
import { createDefaultRunner } from '../src/exec/runner.ts';
import { createHubClient } from '../src/hub/client.ts';
import type { GetOrderResponse } from '../src/hub/types.ts';
import type { CommandReceipt } from '../src/exec/receipt.ts';

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
      executor: 'command',
      command,
      prompt: '',
      consumes: {},
      owes: [{ path: 'artifacts/build', acceptance: '', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    },
    lease: { claimed: true },
  };
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

function loopAgainst(origin: string): ReturnType<typeof createExecLoop> {
  return createExecLoop({
    hub: createHubClient({ origin, getToken: async () => 'tok-e2e' }),
    runner: createDefaultRunner(),
    workflow: 'wf1',
    run: 'run1',
    holder: EXEC,
    cwd: CWD,
    sleep: realSleep,
    now: () => Date.now(),
    out: () => {},
    err: () => {},
    heartbeatIntervalMs: 25, // fast beats so a sub-second command sees ≥1
  });
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
    const loop = loopAgainst(origin);
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
    const loop = loopAgainst(origin);
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
