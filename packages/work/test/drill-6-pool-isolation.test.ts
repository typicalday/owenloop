/**
 * DRILL 6 — pool isolation across two concurrent conductors (WO-6.2, M4).
 *
 * The M4 multi-principal property: two real `owenloop shift start` conductors,
 * each serving a DIFFERENT pool (`A` vs `B`) and authenticating
 * with a DIFFERENT stored-credential account (`--as a` vs `b`, no
 * `OWENWORK_TOKEN`), park against ONE mock hub over ONE split run (`wf1/run1`,
 * step `alpha` on pool A + step `beta` on pool B). We assert each conductor
 * claims/dispatches ONLY its own pool's step, never the other's; that the
 * recorded hub-request log shows ZERO cross-pool claims (a post-hoc audit that
 * binds each bearer to its pool); and that each authenticated with its own
 * stored credential.
 *
 * The mock hub scripts the hub's `serve_pools` narrowing directly: a
 * `whats_next` sweep is served `alpha` iff it carries pool A, `beta` iff it
 * carries pool B, `[]` otherwise. That deterministic routing plus the recorded
 * per-request `auth` + `serve_pools` is what makes the cross-pool audit airtight
 * — the shared `startMockHub` helper is untouched; the audit is done post-hoc
 * over its `reqs` log.
 *
 * HONEST BOUNDARY (mock vs. live, owenwork-side vs. hub enforcement):
 * This proves OWENWORK'S side — given a correctly-narrowing hub, owenwork sends
 * its configured pools on the wire, claims only its pool, and never reaches
 * across, even with two conductors on one hub. It does NOT prove server-enforced
 * isolation: the mock hub only SIMULATES the hub's membership check + narrowing
 * that makes a cross-pool claim fail server-side. That true enforcement (and the
 * real hub audit log) is owned by the hub's own WO-4.1 tests and by the manual
 * live two-conductor demo in `drills/README.md`. Metering-cap enforcement is
 * likewise hub-side and not owenwork-observable, so it is not asserted here (see
 * the runbook) — owenwork's `--cap` is a separate LOCAL concurrency knob.
 *
 * `pretest` builds `dist/`, so the bin shim resolves for the children.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { writeBundle } from '../src/bundle/cache.ts';
import { readChildRecords } from '../src/proxy/state.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import type { WorkOrder } from '../src/hub/types.ts';
import { startMockHub } from './helpers/mcp-stdio-client.ts';
import { isShiftError } from '../src/shift/protocol.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import {
  fixtureEnv,
  seedCredentialStore,
  POOL_A_ACCOUNT,
  POOL_A_AUTH,
  POOL_A_TOKEN,
  POOL_B_ACCOUNT,
  POOL_B_AUTH,
  POOL_B_TOKEN,
} from './helpers/credential-fixture.ts';

// One def, two agent steps — `alpha` served to pool A, `beta` to pool B.
const DEF_NAME = 'pooldemo';
const DEF_HASH = 'poolhash00000000';

/** The harness-module test seam target, as an absolute path. */
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));

/** A minimal agent step (no `worker: 'command'`) → dispatched to an agent-run child. */
function step(name: string): { name: string; body: string } {
  return { name, body: `run the ${name} step` };
}

/** One split run: same run, `alpha` on pool A and `beta` on pool B. */
function order(stepName: string): WorkOrder {
  return {
    workflow: 'wf1',
    run: 'run1',
    step: stepName,
    prompt: `do ${stepName}`,
    consumes: {},
    expected_outputs: [{ path: 'pr' }],
    feedback: [],
    advisory: {},
    submit_hint: 'submit pr',
  };
}

const ALPHA = order('alpha');
const BETA = order('beta');

/** Per-conductor isolated fs roots. */
interface Conductor {
  root: string;
  home: string;
  cacheDir: string;
  stateDir: string;
}

function makeConductor(tag: string): Conductor {
  const root = mkdtempSync(join(tmpdir(), `owenwork-drill6-${tag}-`));
  return {
    root,
    home: join(root, 'home'),
    cacheDir: join(root, 'cache'),
    stateDir: join(root, 'state'),
  };
}

/** Seed each conductor's cache with the `pooldemo` bundle + both step specs. */
function seedCache(cacheDir: string): void {
  const specs: NormalizedStepSpec[] = [
    { step: 'alpha', brief: '---\nname: alpha\n---\n\nalpha body\n', permissions: { extensions: {} } },
    { step: 'beta', brief: '---\nname: beta\n---\n\nbeta body\n', permissions: { extensions: {} } },
  ];
  const bundle: CachedBundle = {
    def: { name: DEF_NAME, hash: DEF_HASH, steps: [step('alpha'), step('beta')] },
    fetchedAt: 0,
    origin: 'seed',
  };
  writeBundle(cacheDir, bundle, specs);
}

function spawnConductor(c: Conductor, origin: string, account: string, pool: string): ShiftChild {
  return spawnShift(
    [
      pool, '--origin', origin,
      '--as', account,
      '--cap', '3', '--poll-interval', '25',
      '--cache-dir', c.cacheDir, '--state-dir', c.stateDir,
    ],
    // The agent-run children this proxy spawns must reach a HARNESS. Point the
    // registry seam at the scripted fake and NAME it, exactly as the runner
    // drills do — a drill that inherited whichever adapter happened to register
    // first would be passing for a reason it never asserted. `hang: true` keeps
    // each child alive and holding its slot for the duration of the assertions.
    fixtureEnv(c.home, {
      OWENWORK_HARNESS_MODULE: FAKE_HARNESS,
      OWENWORK_HARNESS: 'fake',
      OWENWORK_FAKE_SCRIPT: JSON.stringify({ id: 'fake', hang: true }),
    }),
  );
}

let a: Conductor;
let b: Conductor;
beforeEach(() => {
  a = makeConductor('a');
  b = makeConductor('b');
});
afterEach(() => {
  rmSync(a.root, { recursive: true, force: true });
  rmSync(b.root, { recursive: true, force: true });
});

test('two conductors on different pools + accounts split one run cleanly — each claims only its pool, zero cross-pool claims, each authed with its own stored credential', async () => {
  // The hub narrows strictly by `serve_pools`: a sweep is served `alpha` iff it
  // serves pool A, `beta` iff pool B — the correct-narrowing simulation AND the
  // refusal (a request that does not serve a pool never receives its order).
  const { origin, reqs, server } = await startMockHub((verb, body) => {
    switch (verb) {
      case 'wake':
        return { text: '', cursor: 1, changed: true };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'whats_next': {
        // Public shift startup has no --workflow flag. The first inbox sweep
        // discovers wf1; the second request carries the configured pool scope.
        if (body?.workflow === undefined) return { text: '', instances: [{ workflow: 'wf1' }] };
        const pools = (body?.serve_pools as string[] | undefined) ?? [];
        const orders: WorkOrder[] = [];
        if (pools.includes('A')) orders.push(ALPHA);
        if (pools.includes('B')) orders.push(BETA);
        return { text: '', workflow: 'wf1', def: DEF_NAME, orders };
      }
      default:
        return { text: '' };
    }
  });

  // Each conductor gets its OWN cache + its OWN credential store (own account +
  // own token), seeded AFTER startMockHub so the store keys the exact origin.
  seedCache(a.cacheDir);
  seedCache(b.cacheDir);
  seedCredentialStore(a.home, origin, POOL_A_TOKEN, POOL_A_ACCOUNT);
  seedCredentialStore(b.home, origin, POOL_B_TOKEN, POOL_B_ACCOUNT);

  const ca = spawnConductor(a, origin, POOL_A_ACCOUNT, 'A');
  const cb = spawnConductor(b, origin, POOL_B_ACCOUNT, 'B');
  try {
    await Promise.all([ca.ready, cb.ready]);

    // Drive both concurrently. Each socket park sweeps once and returns on its
    // first non-empty batch — the hub always has each pool's order ready.
    const [ra, rb] = await Promise.all([
      ca.request({ op: 'next', wait_ms: 5_000 }),
      cb.request({ op: 'next', wait_ms: 5_000 }),
    ]);

    // (1) Both sweeps succeeded and each reports its LOCAL capacity view. Since
    // Phase 5 every order — command or agent — is run in a detached child, so
    // `next` returns no order handles at all; dispatch evidence lives on disk.
    assert.equal(isShiftError(ra), false, `A next failed: ${JSON.stringify(ra)}; stderr:\n${ca.stderr()}`);
    assert.equal(isShiftError(rb), false, `B next failed: ${JSON.stringify(rb)}; stderr:\n${cb.stderr()}`);
    if (isShiftError(ra) || isShiftError(rb)) throw new Error('unexpected shift error');

    // (2) On-disk dispatch evidence: each conductor's OWN state dir records
    // exactly one detached `agent-run` child, for its OWN pool's step of the
    // SAME run — the split run, cleanly divided. A hub ignoring serve_pools
    // would have served both conductors both orders; the disjointness proves
    // the routing genuinely discriminates on serve_pools.
    const aRecs = readChildRecords(a.stateDir);
    const bRecs = readChildRecords(b.stateDir);
    assert.equal(aRecs.length, 1, `A dispatched exactly one child: ${JSON.stringify(aRecs)}`);
    assert.equal(bRecs.length, 1, `B dispatched exactly one child: ${JSON.stringify(bRecs)}`);
    assert.equal(aRecs[0]!.kind, 'agent-run');
    assert.equal(bRecs[0]!.kind, 'agent-run');
    assert.equal(aRecs[0]!.run, 'run1');
    assert.equal(bRecs[0]!.run, 'run1');
    assert.equal(aRecs[0]!.step, 'alpha', 'A dispatched its own (alpha) step, never beta');
    assert.equal(bRecs[0]!.step, 'beta', 'B dispatched its own (beta) step, never alpha');

    // (3) Each authenticated with its OWN stored credential — no OWENWORK_TOKEN
    // override leaked in. Both distinct bearers appear, and EVERY recorded
    // request carries one of exactly those two (no stray/override bearer).
    assert.ok(reqs.some((r) => r.auth === POOL_A_AUTH), 'conductor A used its own stored bearer');
    assert.ok(reqs.some((r) => r.auth === POOL_B_AUTH), 'conductor B used its own stored bearer');
    assert.ok(
      reqs.every((r) => r.auth === POOL_A_AUTH || r.auth === POOL_B_AUTH),
      `every request carried one of the two stored bearers: ${JSON.stringify(reqs.map((r) => r.auth))}`,
    );

    // (4) Zero cross-pool claims (the audit-log assertion). Binding each bearer
    // to its pool: every A-bearer request that carries serve_pools carries
    // EXACTLY ['A'] and never 'B'; every B-bearer request carries ['B'] and
    // never 'A'. With the deterministic routing above, this proves no conductor
    // ever reached for — or was served — the other pool's step. This is the
    // accept criterion's "hub audit log shows no cross-pool claim attempts
    // succeeding", proven here at owenwork's mock level (see header boundary).
    for (const r of reqs) {
      const pools = r.body?.serve_pools as string[] | undefined;
      if (pools === undefined) continue; // e.g. a wake with no serve_pools field
      if (r.auth === POOL_A_AUTH) {
        assert.deepEqual(pools, ['A'], `A-bearer request served only pool A: ${JSON.stringify(r)}`);
        assert.ok(!pools.includes('B'), 'A never reached for pool B');
      } else {
        assert.deepEqual(pools, ['B'], `B-bearer request served only pool B: ${JSON.stringify(r)}`);
        assert.ok(!pools.includes('A'), 'B never reached for pool A');
      }
    }

    // Every serve-pools-bearing request the conductors made was audited above:
    // at least each conductor's presence_ping + whats_next carried its pool.
    assert.ok(
      reqs.some((r) => r.verb === 'whats_next' && r.auth === POOL_A_AUTH),
      'A rode a serve_pools whats_next on the wire',
    );
    assert.ok(
      reqs.some((r) => r.verb === 'whats_next' && r.auth === POOL_B_AUTH),
      'B rode a serve_pools whats_next on the wire',
    );

    assert.ok('events' in ra && Array.isArray(ra.events), 'A next returns the event queue shape');
    assert.ok('events' in rb && Array.isArray(rb.events), 'B next returns the event queue shape');

    await Promise.all([ca.request({ op: 'end' }), cb.request({ op: 'end' })]);
    assert.equal(await ca.exited, 0, `A exits 0 after end, stderr:\n${ca.stderr()}`);
    assert.equal(await cb.exited, 0, `B exits 0 after end, stderr:\n${cb.stderr()}`);
  } finally {
    server.close();
    ca.child.kill('SIGKILL');
    cb.child.kill('SIGKILL');
    // The agent-run children are DETACHED — killing the proxies does not reach
    // them. Reap them by the pids the proxies recorded.
    for (const c of [a, b]) {
      for (const r of readChildRecords(c.stateDir)) {
        try {
          process.kill(r.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }
});
