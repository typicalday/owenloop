/**
 * DRILL 5 — SIGSTOP past the lease horizon → fast lease-fail, order re-offers (WO-6.1, M4).
 *
 * The M4 failure mode: a holder freezes (laptop sleep, `SIGSTOP`, a paused VM)
 * for longer than its lease can survive, so the hub reaps and re-offers the
 * order elsewhere. When the frozen holder thaws it must NOT keep beating a dead
 * lease — it must notice the wall-clock jump, verify the lease, and fail FAST
 * (seconds), not wait out a full interval or a phantom TTL. The lease loop's
 * clock-jump guard (lease/loop.ts): a tick whose wall gap exceeds
 * `interval + jumpTolerance` probes `get_order` before beating; an unclaimed
 * probe ⇒ `lease-lost` ⇒ exit 1.
 *
 * We drive the real `owenloop work hold` (loop mode) with a SHORT interval + short
 * `--jump-tolerance` (the WO-6.1 test affordance — a CLI knob over the loop's
 * existing `jumpToleranceMs`, DEFAULT UNCHANGED) so a sub-second `SIGSTOP` trips
 * the guard, instead of a real >30s freeze. `SIGCONT`, then assert the fast
 * lease-fail on the wire + exit code, and that the re-offered order completes on
 * a fresh holder.
 *
 * Credential path: owenloop file store (no OWENWORK_TOKEN) — the first hub
 * request carries `Bearer drill_agent_tok`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { callTool, handshake, spawnMcp, startMockHub, until, type HubReq } from './helpers/mcp-stdio-client.ts';
import { DRILL_AUTH, fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const ORDER_PACKET = {
  run: 'run1',
  workflow: 'wf1',
  step: 'builder',
  key: 'k',
  inputs: [],
  outputs: ['pr'],
  prompt: 'do the thing',
  consumes: {},
  owes: [],
};

const HEARTBEAT_MS = 200;
const JUMP_TOLERANCE_MS = 300; // gap must exceed 200 + 300 = 500ms to trip the guard
const FREEZE_MS = 800; // comfortably past the 500ms threshold

/** Hub phases: the holder holds, then loses the lease, then it re-offers. */
type Phase = 'holding' | 'lost' | 'reoffered';

const of = (reqs: HubReq[], verb: string): HubReq[] => reqs.filter((r) => r.verb === verb);
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owenwork-drill5-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test('a SIGSTOP past interval+tolerance trips the clock-jump guard → fast lease-lost (exit 1); the order re-offers and completes elsewhere', async () => {
  let phase: Phase = 'holding';
  const { origin, reqs, server } = await startMockHub((verb) => {
    switch (verb) {
      case 'get_order':
        // 'lost' ⇒ unclaimed with NO outcome ⇒ the clock-jump probe reads lease-lost.
        if (phase === 'lost') return { text: '', workflow: 'wf1', run: 'run1', lease: { claimed: false } };
        return { text: '', workflow: 'wf1', run: 'run1', order: ORDER_PACKET, lease: { claimed: true } };
      case 'heartbeat':
        return { text: 'hb' };
      case 'submit':
        return { text: 'ok', outcome: 'green', closed: true };
      default:
        return { text: '' }; // release
    }
  });
  seedCredentialStore(home, origin); // exact dynamic origin

  // Loop-mode hold (NOT --mcp): stdin stays open, so no stdin-EOF final breath
  // races the freeze. credential path: owenloop file store (no OWENWORK_TOKEN).
  const victim = spawnMcp(
    ['hold', '--order', 'wf1/run1', '--origin', origin,
      '--heartbeat-interval', String(HEARTBEAT_MS), '--jump-tolerance', String(JUMP_TOLERANCE_MS)],
    fixtureEnv(home),
  );
  try {
    await until(() => of(reqs, 'heartbeat').length >= 1, 'first heartbeat (holding)');
    assert.equal(reqs[0]!.auth, DRILL_AUTH, 'first hub request carried the store token');

    // Settle a beat so the loop is firmly inside its next interval sleep, then
    // FREEZE — event loop and timers halt.
    await realSleep(40);
    victim.child.kill('SIGSTOP');

    // While it is frozen the hub reaps the lease: the next get_order is unclaimed.
    phase = 'lost';
    const getOrdersBeforeThaw = of(reqs, 'get_order').length;

    // Advance wall-clock past the jump threshold, then THAW.
    await realSleep(FREEZE_MS);
    victim.child.kill('SIGCONT');

    // Fast lease-fail: lease-lost maps to exit code 1 (hold/exec exitCodeFor).
    assert.equal(await victim.exited, 1, `frozen-past-lease holder fails fast (1), stderr:\n${victim.stderr()}`);

    // It got there via the clock-jump guard: a get_order probe AFTER the thaw,
    // and the tell-tale diagnostic line.
    assert.ok(
      of(reqs, 'get_order').length > getOrdersBeforeThaw,
      'the clock-jump guard probed get_order after the thaw',
    );
    assert.match(victim.stderr(), /clock jump detected/, 'the clock-jump guard fired');

    // The re-offered order completes on a FRESH holder (the hub re-offers it).
    phase = 'reoffered';
    const heir = spawnMcp(
      ['hold', '--order', 'wf1/run1', '--origin', origin, '--heartbeat-interval', '25', '--mcp'],
      fixtureEnv(home),
    );
    try {
      await handshake(heir);
      const got = await callTool(heir, 'get_order');
      assert.equal(got.isError, false, 'the re-offered order is claimable again');
      const sub = await callTool(heir, 'submit', { path: 'pr', value: { url: 'x' }, done: true });
      assert.equal(sub.isError, false);
      assert.equal(sub.body.closed, true, 'the re-offered order completes elsewhere');
      heir.endStdin();
      assert.equal(await heir.exited, 0);
    } finally {
      heir.child.kill('SIGKILL');
    }
  } finally {
    server.close();
    victim.child.kill('SIGCONT'); // never leave a stopped process behind
    victim.child.kill('SIGKILL');
  }
});
