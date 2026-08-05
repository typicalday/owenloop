/**
 * DRILL 2 — session-close mid-exec: exec DRAINS, the receipt still lands (WO-6.1, M4).
 *
 * The M4 truth this proves: a COMMAND order is owned by a detached `owenloop
 * exec` child, tagged `{kind:'exec'}` — the B3/C6 drain exemption. When the
 * orchestrating session goes away mid-run (its stdin closes), an exec child must
 * NOT hand the order back: it is not session-scoped, it owns the command end to
 * end. `exec` never watches stdin at all (roles/exec.ts), so a stdin close is a
 * no-op BY DESIGN — that immunity is exactly what this drill exercises, end to
 * end through the real `bin/owenloop.mjs` over real stdio.
 *
 * (exec-e2e.test.ts proves the same drain in-process via `loop.stop`; this drill
 * proves the real binary ignores a real stdin EOF and drains to a receipt.)
 *
 * Credential path: owenloop file store (no OWENLOOP_TOKEN) — the first hub
 * request carries `Bearer drill_agent_tok`, proving the store path.
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { installBundleFixture, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { spawnMcp, startMockHub, until, type HubReq } from './helpers/mcp-stdio-client.ts';
import { DRILL_AUTH, fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

/** A COMMAND order: exec resolves local command bytes and owes a receipt to each path. */
let localDefDigest = '';
function commandOrder(): unknown {
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
      defDigest: localDefDigest,
      consumes: {},
      owes: [{ path: 'artifacts/build', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    },
    lease: { claimed: true },
  };
}

function hubScript(verb: string): unknown {
  switch (verb) {
    case 'get_order':
      return commandOrder();
    case 'submit':
      return { text: '', outcome: 'green' };
    default:
      return { text: '' }; // heartbeat / release
  }
}

const of = (reqs: HubReq[], verb: string): HubReq[] => reqs.filter((r) => r.verb === verb);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owenloop-drill2-'));
});
function makeWritableTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) makeWritableTree(join(path, child));
    chmodSync(path, 0o755);
  } else {
    chmodSync(path, 0o644);
  }
}

afterEach(() => {
  makeWritableTree(home);
  rmSync(home, { recursive: true, force: true });
});

test('exec ignores a mid-run stdin close (session death) — the command drains and the receipt lands, no release', async () => {
  const command = 'sleep 0.5; echo hi';
  const workflow = `name: exec-drill
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: builder
    consumes: [seed]
    produces: [artifacts/build]
    terminal: true
    executor: command
    command: '${command}'
    body: ""
`;
  const sourceDir = writeBundleSource({ name: 'exec-drill', workflow });
  const installed = await installBundleFixture({ sourceDir, root: join(home, '.owenloop', 'workflows') });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  localDefDigest = defInstructionDigest(definition);

  const { origin, reqs, server } = await startMockHub(hubScript);
  seedCredentialStore(home, origin); // exact dynamic origin
  // credential path: owenloop file store (no OWENLOOP_TOKEN)
  const exec = spawnMcp(
    ['exec', 'wf1/run1', '--origin', origin, '--heartbeat-interval', '25'],
    fixtureEnv(home),
  );
  try {
    // First contact + ≥1 heartbeat means the command is running under the lease.
    await until(() => of(reqs, 'heartbeat').length >= 1, 'first heartbeat (command running)');
    assert.equal(reqs[0]!.auth, DRILL_AUTH, 'first hub request carried the store token');

    // SESSION DEATH mid-run: close exec's stdin. exec does not watch stdin, so
    // this must be inert — the command keeps running to completion.
    exec.endStdin();

    // The real binary drains: exit 0 (submitted), the command's receipt landed.
    assert.equal(await exec.exited, 0, `exec drained to exit 0, stderr:\n${exec.stderr()}`);

    const subs = of(reqs, 'submit');
    assert.equal(subs.length, 1, 'exactly one receipt — the drain completed the command');
    assert.equal(subs[0]!.body!['path'], 'artifacts/build', 'receipt went to the owed path');
    const receipt = subs[0]!.body!['value'] as { kind: string; exitCode: number; outputHash: string };
    assert.equal(receipt.kind, 'command-receipt');
    assert.equal(receipt.exitCode, 0, 'the command ran to a clean exit despite the stdin close');
    assert.equal(receipt.outputHash, `sha256:${createHash('sha256').update('hi\n').digest('hex')}`);

    // A drained-and-submitted exec order is NEVER handed back.
    assert.equal(of(reqs, 'release').length, 0, 'exec submitted its receipt — no release');
  } finally {
    server.close();
    exec.child.kill('SIGKILL');
  }
});
