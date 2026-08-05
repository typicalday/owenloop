/**
 * DRILL 6 — crew isolation across two concurrent shifts (WO-6.2, M4).
 *
 * The M4 multi-principal property: two real `owenloop shift start` shifts,
 * each serving a DIFFERENT crew (`A` vs `B`) and authenticating
 * with a DIFFERENT stored-credential account (`--as a` vs `b`, no
 * `OWENLOOP_TOKEN`), park against ONE mock hub over ONE split run (`wf1/run1`,
 * step `alpha` on crew A + step `beta` on crew B). We assert each shift
 * claims/dispatches ONLY its own crew's step, never the other's; that the
 * recorded hub-request log shows ZERO cross-crew claims (a post-hoc audit that
 * binds each bearer to its crew); and that each authenticated with its own
 * stored credential.
 *
 * The mock hub scripts the hub's `serve_crews` narrowing directly: a
 * `whats_next` sweep is served `alpha` iff it carries crew A, `beta` iff it
 * carries crew B, `[]` otherwise. That deterministic routing plus the recorded
 * per-request `auth` + `serve_crews` is what makes the cross-crew audit airtight
 * — the shared `startMockHub` helper is untouched; the audit is done post-hoc
 * over its `reqs` log.
 *
 * HONEST BOUNDARY (mock vs. live, owenloop-side vs. hub enforcement):
 * This proves OWENLOOP'S side — given a correctly-narrowing hub, owenloop sends
 * its configured crews on the wire, claims only its crew, and never reaches
 * across, even with two shifts on one hub. It does NOT prove server-enforced
 * isolation: the mock hub only SIMULATES the hub's membership check + narrowing
 * that makes a cross-crew claim fail server-side. That true enforcement (and the
 * real hub audit log) is owned by the hub's own WO-4.1 tests and by the manual
 * live two-shift demo in `drills/README.md`. Metering-cap enforcement is
 * likewise hub-side and not owenloop-observable, so it is not asserted here (see
 * the runbook) — owenloop's `--cap` is a separate LOCAL concurrency knob.
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
import { readChildRecords } from '../src/shift/state.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import type { WorkOrder } from '../src/hub/types.ts';
import { startMockHub } from './helpers/mcp-stdio-client.ts';
import { isShiftError } from '../src/shift/protocol.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import {
  fixtureEnv,
  seedCredentialStore,
  CREW_A_ACCOUNT,
  CREW_A_AUTH,
  CREW_A_TOKEN,
  CREW_B_ACCOUNT,
  CREW_B_AUTH,
  CREW_B_TOKEN,
} from './helpers/credential-fixture.ts';

// One def, two agent steps — `alpha` served to crew A, `beta` to crew B.
const DEF_NAME = 'crewdemo';
const DEF_HASH = 'crewhash00000000';

/** The harness-module test seam target, as an absolute path. */
const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));

/** A minimal agent step (no `executor: 'command'`) → dispatched to an agent-run child. */
function step(name: string): { name: string; body: string } {
  return { name, body: `run the ${name} step` };
}

/** One split run: same run, `alpha` on crew A and `beta` on crew B. */
function order(stepName: string): WorkOrder {
  return {
    workflow: 'wf1',
    run: 'run1',
    step: stepName,
    consumes: {},
    expected_outputs: [{ path: 'pr' }],
    feedback: [],
    advisory: {},
    submit_hint: 'submit pr',
  };
}

const ALPHA = order('alpha');
const BETA = order('beta');

/** Per-shift isolated fs roots. */
interface Shift {
  root: string;
  home: string;
  cacheDir: string;
  stateDir: string;
}

function makeShift(tag: string): Shift {
  const root = mkdtempSync(join(tmpdir(), `owenloop-drill6-${tag}-`));
  return {
    root,
    home: join(root, 'home'),
    cacheDir: join(root, 'cache'),
    stateDir: join(root, 'state'),
  };
}

/** Seed each shift's cache with the `crewdemo` bundle + both step specs. */
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

function startShiftProcess(c: Shift, origin: string, account: string, crew: string): ShiftChild {
  return spawnShift(
    [
      crew, '--origin', origin,
      '--as', account,
      '--cap', '3', '--poll-interval', '25',
      '--cache-dir', c.cacheDir, '--state-dir', c.stateDir,
    ],
    // The agent-run children this shift spawns must reach a HARNESS. Point the
    // registry seam at the scripted fake and NAME it, exactly as the runner
    // drills do — a drill that inherited whichever adapter happened to register
    // first would be passing for a reason it never asserted. `hang: true` keeps
    // each child alive and holding its slot for the duration of the assertions.
    fixtureEnv(c.home, {
      OWENLOOP_HARNESS_MODULE: FAKE_HARNESS,
      OWENLOOP_HARNESS: 'fake',
      OWENLOOP_FAKE_SCRIPT: JSON.stringify({ id: 'fake', hang: true }),
    }),
  );
}

let a: Shift;
let b: Shift;
beforeEach(() => {
  a = makeShift('a');
  b = makeShift('b');
});
afterEach(() => {
  rmSync(a.root, { recursive: true, force: true });
  rmSync(b.root, { recursive: true, force: true });
});

test('two shifts on different crews + accounts split one run cleanly — each claims only its crew, zero cross-crew claims, each authed with its own stored credential', async () => {
  // The hub narrows strictly by `serve_crews`: a sweep is served `alpha` iff it
  // serves crew A, `beta` iff crew B — the correct-narrowing simulation AND the
  // refusal (a request that does not serve a crew never receives its order).
  const { origin, reqs, server } = await startMockHub((verb, body) => {
    switch (verb) {
      case 'wake':
        return { text: '', cursor: 1, changed: true };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      case 'whats_next': {
        // Public shift startup has no --workflow flag. The first inbox sweep
        // discovers wf1; the second request carries the configured crew scope.
        if (body?.workflow === undefined) return { text: '', instances: [{ workflow: 'wf1' }] };
        const crews = (body?.serve_crews as string[] | undefined) ?? [];
        const orders: WorkOrder[] = [];
        if (crews.includes('A')) orders.push(ALPHA);
        if (crews.includes('B')) orders.push(BETA);
        return { text: '', workflow: 'wf1', def: DEF_NAME, orders };
      }
      default:
        return { text: '' };
    }
  });

  // Each shift gets its OWN cache + its OWN credential store (own account +
  // own token), seeded AFTER startMockHub so the store keys the exact origin.
  seedCache(a.cacheDir);
  seedCache(b.cacheDir);
  seedCredentialStore(a.home, origin, CREW_A_TOKEN, CREW_A_ACCOUNT);
  seedCredentialStore(b.home, origin, CREW_B_TOKEN, CREW_B_ACCOUNT);

  const ca = startShiftProcess(a, origin, CREW_A_ACCOUNT, 'A');
  const cb = startShiftProcess(b, origin, CREW_B_ACCOUNT, 'B');
  try {
    await Promise.all([ca.ready, cb.ready]);

    // Drive both concurrently. Each socket park sweeps once and returns on its
    // first non-empty batch — the hub always has each crew's order ready.
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

    // (2) On-disk dispatch evidence: each shift's OWN state dir records
    // exactly one detached `agent-run` child, for its OWN crew's step of the
    // SAME run — the split run, cleanly divided. A hub ignoring serve_crews
    // would have served both shifts both orders; the disjointness proves
    // the routing genuinely discriminates on serve_crews.
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

    // (3) Each authenticated with its OWN stored credential — no OWENLOOP_TOKEN
    // override leaked in. Both distinct bearers appear, and EVERY recorded
    // request carries one of exactly those two (no stray/override bearer).
    assert.ok(reqs.some((r) => r.auth === CREW_A_AUTH), 'shift A used its own stored bearer');
    assert.ok(reqs.some((r) => r.auth === CREW_B_AUTH), 'shift B used its own stored bearer');
    assert.ok(
      reqs.every((r) => r.auth === CREW_A_AUTH || r.auth === CREW_B_AUTH),
      `every request carried one of the two stored bearers: ${JSON.stringify(reqs.map((r) => r.auth))}`,
    );

    // (4) Zero cross-crew claims (the audit-log assertion). Binding each bearer
    // to its crew: every A-bearer request that carries serve_crews carries
    // EXACTLY ['A'] and never 'B'; every B-bearer request carries ['B'] and
    // never 'A'. With the deterministic routing above, this proves no shift
    // ever reached for — or was served — the other crew's step. This is the
    // accept criterion's "hub audit log shows no cross-crew claim attempts
    // succeeding", proven here at owenloop's mock level (see header boundary).
    for (const r of reqs) {
      const crews = r.body?.serve_crews as string[] | undefined;
      if (crews === undefined) continue; // e.g. a wake with no serve_crews field
      if (r.auth === CREW_A_AUTH) {
        assert.deepEqual(crews, ['A'], `A-bearer request served only crew A: ${JSON.stringify(r)}`);
        assert.ok(!crews.includes('B'), 'A never reached for crew B');
      } else {
        assert.deepEqual(crews, ['B'], `B-bearer request served only crew B: ${JSON.stringify(r)}`);
        assert.ok(!crews.includes('A'), 'B never reached for crew A');
      }
    }

    // Every serve-crews-bearing request the shifts made was audited above:
    // at least each shift's presence_ping + whats_next carried its crew.
    assert.ok(
      reqs.some((r) => r.verb === 'whats_next' && r.auth === CREW_A_AUTH),
      'A rode a serve_crews whats_next on the wire',
    );
    assert.ok(
      reqs.some((r) => r.verb === 'whats_next' && r.auth === CREW_B_AUTH),
      'B rode a serve_crews whats_next on the wire',
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
