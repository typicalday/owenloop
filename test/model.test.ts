import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  buildTrace,
  computeFingerprint,
  eligibleFirings,
  fingerprintMatches,
  loopMode,
  maintainDecisions,
  members,
  pendingOwed,
  requiredInputs,
  settleInMemory,
  workflowStatus,
} from '../src/model.ts';
import { buildDef } from '../src/defs.ts';
import { arts, def, input, loop } from './helpers.ts';

// The software-delivery wiring (§9), used across several tests.
const delivery = def(
  'delivery',
  [input('proposal')],
  [
    loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    loop({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    loop({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
    loop({ name: 'merger', consumes: ['verdict'], produces: ['merge'] }),
  ],
);

// The research wiring (§10/§11) with a collection.
const research = def(
  'research',
  [input('question')],
  [
    loop({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] }),
    loop({
      name: 'formatcheck',
      consumes: ['gather.source[$i]'],
      produces: ['gather.source[$i].formatcheck'],
    }),
    loop({ name: 'synthesize', consumes: ['gather.source[*]'], produces: ['draft'] }),
  ],
);

// A chained map (§11): `research` maps the bare members into a per-element
// `.dossier`; `acquire` maps over those *dossiers* (a suffixed map consume) into
// a per-element `.assets`. Exercises that a map gating on another map's output
// gates on the suffixed child, not the bare member.
const chained = def(
  'chained',
  [input('brief')],
  [
    loop({ name: 'scope', consumes: ['brief'], produces: ['scope.target[]'] }),
    loop({ name: 'research', consumes: ['scope.target[$i]'], produces: ['scope.target[$i].dossier'] }),
    loop({ name: 'acquire', consumes: ['scope.target[$i].dossier'], produces: ['scope.target[$i].assets'] }),
  ],
);

test('loopMode classifies plain / map / reduce', () => {
  assert.equal(loopMode(delivery.loops[0]!), 'plain');
  assert.equal(loopMode(research.loops[1]!), 'map');
  assert.equal(loopMode(research.loops[2]!), 'reduce');
});

test('pendingOwed seeds singletons and seals, then map children when elements green', () => {
  // delivery: every singleton output is owed from the start
  const empty = arts([{ path: 'proposal', producer: 'human', acceptance: 'green', version: 1 }]);
  const owed = pendingOwed(delivery, empty).map((a) => a.path).sort();
  assert.deepEqual(owed, ['merge', 'plan', 'pr', 'verdict']);

  // research: the collection producer owes its seal; map children appear only per green element
  const r0 = arts([{ path: 'question', producer: 'human', acceptance: 'green', version: 1 }]);
  const o0 = pendingOwed(research, r0);
  assert.deepEqual(o0.map((a) => a.path).sort(), ['draft', 'gather.source.sealed']);
  assert.equal(o0.find((a) => a.path === 'gather.source.sealed')?.sealOf, 'gather.source');

  // once two sources are green, formatcheck owes one child per element
  const r1 = arts([
    { path: 'question', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'green', version: 1, sealOf: 'gather.source' },
    { path: 'gather.source[0]', producer: 'gather', acceptance: 'green', version: 1 },
    { path: 'gather.source[1]', producer: 'gather', acceptance: 'green', version: 1 },
    { path: 'draft', producer: 'synthesize', acceptance: 'owed' },
  ]);
  const o1 = pendingOwed(research, r1).map((a) => a.path).sort();
  assert.deepEqual(o1, ['gather.source[0].formatcheck', 'gather.source[1].formatcheck']);
});

test('firing rule — only the loop whose input is green and output owed fires', () => {
  // proposal green, plan owed → only planner is eligible
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed' },
    { path: 'pr', producer: 'builder', acceptance: 'owed' },
    { path: 'verdict', producer: 'reviewer', acceptance: 'owed' },
    { path: 'merge', producer: 'merger', acceptance: 'owed' },
  ]);
  const f = eligibleFirings(delivery, a);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.loop, 'planner');
  assert.deepEqual(f[0]!.inputs, ['proposal']);
  assert.deepEqual(f[0]!.outputs, ['plan']);
});

test('firing rule — a green output is not re-fired', () => {
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'owed' },
    { path: 'verdict', producer: 'reviewer', acceptance: 'owed' },
    { path: 'merge', producer: 'merger', acceptance: 'owed' },
  ]);
  const f = eligibleFirings(delivery, a);
  assert.deepEqual(f.map((x) => x.loop), ['builder']); // planner done, builder now eligible
});

test('firing rule — re-firing: a rejected output re-arms its producer', () => {
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'rejected', version: 1 }, // reviewer knocked it back
    { path: 'verdict', producer: 'reviewer', acceptance: 'owed' },
    { path: 'merge', producer: 'merger', acceptance: 'owed' },
  ]);
  const f = eligibleFirings(delivery, a);
  assert.deepEqual(f.map((x) => x.loop), ['builder']);
});

test('map eligibility — one firing per green element with an owed child', () => {
  const a = arts([
    { path: 'question', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'green', version: 1, sealOf: 'gather.source' },
    { path: 'gather.source[0]', producer: 'gather', acceptance: 'green', version: 1 },
    { path: 'gather.source[1]', producer: 'gather', acceptance: 'green', version: 1 },
    { path: 'gather.source[2]', producer: 'gather', acceptance: 'green', version: 1 },
    { path: 'gather.source[0].formatcheck', producer: 'formatcheck', acceptance: 'green', version: 1 },
    { path: 'gather.source[1].formatcheck', producer: 'formatcheck', acceptance: 'owed' },
    { path: 'gather.source[2].formatcheck', producer: 'formatcheck', acceptance: 'owed' },
    { path: 'draft', producer: 'synthesize', acceptance: 'owed' },
  ]);
  const f = eligibleFirings(research, a).filter((x) => x.loop === 'formatcheck');
  assert.deepEqual(f.map((x) => x.key).sort(), ['gather.source[1]', 'gather.source[2]']);
  assert.deepEqual(f.find((x) => x.index === 1)!.outputs, ['gather.source[1].formatcheck']);
});

test('chained map — gates on the suffixed per-element child, not the bare member', () => {
  // scope sealed, both targets green; research has produced dossier[0] only.
  const a = arts([
    { path: 'brief', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'scope.target.sealed', producer: 'scope', acceptance: 'green', version: 1, sealOf: 'scope.target' },
    { path: 'scope.target[0]', producer: 'scope', acceptance: 'green', version: 1 },
    { path: 'scope.target[1]', producer: 'scope', acceptance: 'green', version: 1 },
    { path: 'scope.target[0].dossier', producer: 'research', acceptance: 'green', version: 1 },
    { path: 'scope.target[1].dossier', producer: 'research', acceptance: 'owed' },
  ]);

  // pendingOwed materializes element 0's assets (dossier[0] green) but NOT
  // element 1's (dossier[1] still owed). dossier[1] already exists, so it isn't
  // re-listed; the point is scope.target[1].assets must be absent.
  const owed = pendingOwed(chained, a).map((x) => x.path).sort();
  assert.deepEqual(owed, ['scope.target[0].assets']);

  // acquire is eligible for element 0 ONLY (the bug: it used to fire for both,
  // because the bare member scope.target[1] is green even though its dossier isn't).
  const acq = eligibleFirings(chained, arts([
    ...[...a.values()],
    { path: 'scope.target[0].assets', producer: 'acquire', acceptance: 'owed' },
  ])).filter((x) => x.loop === 'acquire');
  assert.deepEqual(acq.map((x) => x.key), ['scope.target[0]']);
  // and it fingerprints on the dossier it actually consumed, not the bare member
  assert.deepEqual(acq[0]!.inputs, ['scope.target[0].dossier']);
  assert.deepEqual(acq[0]!.outputs, ['scope.target[0].assets']);

  // requiredInputs: the assets child rests on its dossier (so a stale dossier cascades)
  const full = arts([
    ...[...a.values()],
    { path: 'scope.target[0].assets', producer: 'acquire', acceptance: 'green', version: 1 },
  ]);
  assert.deepEqual(
    requiredInputs(chained, full, full.get('scope.target[0].assets')!),
    ['scope.target[0].dossier'],
  );
});

test('reduce eligibility — needs seal green AND every live member green', () => {
  const base = [
    { path: 'question', producer: 'human', acceptance: 'green' as const, version: 1 },
    { path: 'gather.source[0]', producer: 'gather', acceptance: 'green' as const, version: 1 },
    { path: 'gather.source[1]', producer: 'gather', acceptance: 'green' as const, version: 1 },
    { path: 'draft', producer: 'synthesize', acceptance: 'owed' as const },
  ];
  // seal not green → synthesize blocked
  let a = arts([
    ...base,
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'owed', sealOf: 'gather.source' },
  ]);
  assert.equal(eligibleFirings(research, a).some((x) => x.loop === 'synthesize'), false);

  // seal green, all members green → synthesize fires once over the set
  a = arts([
    ...base,
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'green', version: 1, sealOf: 'gather.source' },
  ]);
  const f = eligibleFirings(research, a).filter((x) => x.loop === 'synthesize');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0]!.inputs.sort(), ['gather.source.sealed', 'gather.source[0]', 'gather.source[1]']);

  // a rejected member blocks the reduce; a retracted member does not
  a = arts([
    ...base,
    { path: 'gather.source[1]', producer: 'gather', acceptance: 'rejected', version: 1 },
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'green', version: 1, sealOf: 'gather.source' },
  ]);
  assert.equal(eligibleFirings(research, a).some((x) => x.loop === 'synthesize'), false);

  a = arts([
    ...base,
    { path: 'gather.source[1]', producer: 'gather', acceptance: 'retracted', version: 1 },
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'green', version: 1, sealOf: 'gather.source' },
  ]);
  const f2 = eligibleFirings(research, a).filter((x) => x.loop === 'synthesize');
  assert.equal(f2.length, 1);
  assert.deepEqual(f2[0]!.inputs.sort(), ['gather.source.sealed', 'gather.source[0]']); // [1] dropped
});

test('members are returned in index order', () => {
  const a = arts([
    { path: 'g.s[2]', producer: 'g', acceptance: 'green', version: 1 },
    { path: 'g.s[0]', producer: 'g', acceptance: 'green', version: 1 },
    { path: 'g.s[10]', producer: 'g', acceptance: 'green', version: 1 },
    { path: 'g.s[0].child', producer: 'c', acceptance: 'green', version: 1 }, // not a bare member
  ]);
  assert.deepEqual(members(a, 'g.s').map((m) => m.path), ['g.s[0]', 'g.s[2]', 'g.s[10]']);
});

test('requiredInputs — singleton, map child, and reduce shapes', () => {
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 3 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
  ]);
  assert.deepEqual(requiredInputs(delivery, a, a.get('plan')!), ['proposal']);

  const r = arts([
    { path: 'question', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'gather.source[3]', producer: 'gather', acceptance: 'green', version: 2 },
    { path: 'gather.source[3].formatcheck', producer: 'formatcheck', acceptance: 'green', version: 1 },
    { path: 'gather.source[0]', producer: 'gather', acceptance: 'green', version: 1 },
    { path: 'gather.source.sealed', producer: 'gather', acceptance: 'green', version: 1, sealOf: 'gather.source' },
    { path: 'draft', producer: 'synthesize', acceptance: 'green', version: 1 },
  ]);
  assert.deepEqual(requiredInputs(research, r, r.get('gather.source[3].formatcheck')!), ['gather.source[3]']);
  assert.deepEqual(
    requiredInputs(research, r, r.get('draft')!).sort(),
    ['gather.source.sealed', 'gather.source[0]', 'gather.source[3]'],
  );
  // a seeded input (producer is human, not a loop) rests on nothing
  assert.deepEqual(requiredInputs(research, r, r.get('question')!), []);
});

test('fingerprint compute + match', () => {
  const a = arts([
    { path: 'x', producer: 'p', acceptance: 'green', version: 2 },
    { path: 'y', producer: 'p', acceptance: 'green', version: 5 },
  ]);
  const fp = computeFingerprint(a, ['x', 'y']);
  assert.deepEqual(fp, { x: 2, y: 5 });
  assert.equal(fingerprintMatches(a, ['x', 'y'], fp), true);
  assert.equal(fingerprintMatches(a, ['x', 'y'], { x: 2, y: 4 }), false); // version moved
  assert.equal(fingerprintMatches(a, ['x'], fp), false); // key-set differs
});

test('forward cascade — moved input re-rejects a green output', () => {
  // pr is green built on plan v1, but plan is now v2
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]);
  const ops = maintainDecisions(delivery, a);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.kind, 'reject');
  assert.equal(ops[0]!.path, 'pr');
});

test('forward cascade — non-green input re-rejects the output (build dirty-bit)', () => {
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'rejected', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]);
  const ops = maintainDecisions(delivery, a);
  assert.deepEqual(ops.map((o) => [o.kind, o.path]), [['reject', 'pr']]);
});

test('cascade — retracted element tombstones its map child', () => {
  const a = arts([
    { path: 'question', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'gather.source[3]', producer: 'gather', acceptance: 'retracted', version: 1 },
    {
      path: 'gather.source[3].formatcheck',
      producer: 'formatcheck',
      acceptance: 'green',
      version: 1,
      fingerprint: { 'gather.source[3]': 1 },
    },
  ]);
  const ops = maintainDecisions(research, a);
  assert.deepEqual(ops.map((o) => [o.kind, o.path]), [['retract', 'gather.source[3].formatcheck']]);
});

test('cascade — skipped input propagates skip to a plain dependent', () => {
  const routed = def(
    'routed',
    [input('case')],
    [
      loop({ name: 'decide', consumes: ['case'], produces: ['router'] }),
      loop({ name: 'escalate', consumes: ['router'], produces: ['escalation'] }),
      loop({ name: 'followup', consumes: ['escalation'], produces: ['letter'] }),
    ],
  );
  const a = arts([
    { path: 'case', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'router', producer: 'decide', acceptance: 'green', version: 1, fingerprint: { case: 1 } },
    // escalation was skipped while router was at v1; it stays skipped (no re-arm)
    { path: 'escalation', producer: 'escalate', acceptance: 'skipped', version: 0, fingerprint: { router: 1 } },
    {
      path: 'letter',
      producer: 'followup',
      acceptance: 'green',
      version: 1,
      fingerprint: { escalation: 0 },
    },
  ]);
  const ops = maintainDecisions(routed, a);
  assert.deepEqual(ops.map((o) => [o.kind, o.path]), [['skip', 'letter']]);
});

test('cascade — a skipped branch re-arms when its inputs revive', () => {
  const routed = def(
    'routed',
    [input('case')],
    [
      loop({ name: 'decide', consumes: ['case'], produces: ['router'] }),
      loop({ name: 'escalate', consumes: ['router'], produces: ['escalation'] }),
    ],
  );
  const a = arts([
    { path: 'case', producer: 'human', acceptance: 'green', version: 1 },
    // router has moved to v2 since escalation was skipped (fingerprinted at router v1)
    { path: 'router', producer: 'decide', acceptance: 'green', version: 2, fingerprint: { case: 1 } },
    { path: 'escalation', producer: 'escalate', acceptance: 'skipped', version: 0, fingerprint: { router: 1 } },
  ]);
  const ops = maintainDecisions(routed, a);
  assert.deepEqual(ops.map((o) => [o.kind, o.path]), [['rearm', 'escalation']]);
});

test('cascade — a healthy graph yields no ops', () => {
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1, fingerprint: { proposal: 1 } },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1, fingerprint: { plan: 1 } },
  ]);
  assert.deepEqual(maintainDecisions(delivery, a), []);
});

test('workflowStatus — debts, eligible, blocked, done', () => {
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'owed' },
    { path: 'verdict', producer: 'reviewer', acceptance: 'owed' },
    { path: 'merge', producer: 'merger', acceptance: 'owed' },
  ]);
  const s = workflowStatus(delivery, a);
  assert.equal(s.done, false);
  assert.deepEqual(s.debts.map((d) => d.path), ['merge', 'pr', 'verdict']);
  assert.deepEqual(s.eligible.map((e) => e.loop), ['builder']);
  // reviewer blocked on pr, merger blocked on verdict
  const blocked = Object.fromEntries(s.blocked.map((b) => [b.loop, b.blockedOn]));
  assert.deepEqual(blocked['reviewer'], ['pr']);
  assert.deepEqual(blocked['merger'], ['verdict']);
});

test('workflowStatus — done when nothing owed-and-not-green', () => {
  const a = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1 },
    { path: 'verdict', producer: 'reviewer', acceptance: 'green', version: 1 },
    { path: 'merge', producer: 'merger', acceptance: 'green', version: 1, terminal: true },
  ]);
  const s = workflowStatus(delivery, a);
  assert.equal(s.done, true);
  assert.equal(s.debts.length, 0);
});

// ---- generates: engine/observability tests ------------------------------------

// Build a def with generates: using buildDef so the union is applied.
// planner: consumes proposal, produces [plan], generates [audit_log]
// builder: consumes plan, produces [final], terminal
const auditedDef = buildDef({
  name: 'audited',
  inputs: [{ name: 'proposal' }],
  loops: [
    {
      name: 'planner',
      consumes: ['proposal'],
      produces: ['plan'],
      generates: ['audit_log'],
      body: 'plan it',
    },
    {
      name: 'builder',
      consumes: ['plan'],
      produces: ['final'],
      terminal: true,
      body: 'build it',
    },
  ],
});

// Test 13: a generated artifact is materialized owed and can be greened (identical to produced)
test('generates: generated artifact materializes owed and can be greened with fingerprint', () => {
  // Seed the workflow with proposal green
  const seed: Map<string, import('../src/types.ts').ArtifactData> = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
  ]) as Map<string, import('../src/types.ts').ArtifactData>;

  // pendingOwed should include audit_log (generated) just like plan (produced)
  const owed = pendingOwed(auditedDef, seed).map((a) => a.path).sort();
  assert.ok(owed.includes('audit_log'), `audit_log should be owed; got: ${owed.join(', ')}`);
  assert.ok(owed.includes('plan'), `plan should be owed; got: ${owed.join(', ')}`);

  // Settle starting state to materialize all owed artifacts
  const state1 = settleInMemory(auditedDef, seed);

  // planner should be eligible (plan and audit_log are owed, proposal is green)
  const firings = eligibleFirings(auditedDef, state1);
  const plannerFiring = firings.find((f) => f.loop === 'planner');
  assert.ok(plannerFiring !== undefined, 'planner should be eligible');

  // Green both plan and audit_log to simulate planner completing
  const fp = computeFingerprint(state1, plannerFiring!.inputs);
  state1.set('plan', { ...state1.get('plan')!, acceptance: 'green', version: 1, fingerprint: fp });
  state1.set('audit_log', { ...state1.get('audit_log')!, acceptance: 'green', version: 1, fingerprint: fp });
  const afterPlanner = settleInMemory(auditedDef, state1);

  const auditArt = afterPlanner.get('audit_log');
  assert.ok(auditArt !== undefined, 'audit_log artifact should exist');
  assert.equal(auditArt!.acceptance, 'green', 'audit_log should be green');
  assert.equal(auditArt!.version, 1, 'audit_log should be at version 1');
  assert.ok(auditArt!.fingerprint !== undefined, 'audit_log should have a fingerprint');
  assert.deepEqual(auditArt!.fingerprint, fp, 'fingerprint should match claim-time inputs');
});

// Test 14: buildTrace — generated stem appears in producedStems
test('generates: buildTrace includes generated stem in producedStems for the planner loop', () => {
  const artifacts: Array<import('../src/types.ts').ArtifactData & { updatedAt?: number }> = [
    {
      workflow: 'wf1', path: 'proposal', producer: 'human', acceptance: 'green',
      version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0,
    },
    {
      workflow: 'wf1', path: 'plan', producer: 'planner', acceptance: 'green',
      version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0,
    },
    {
      workflow: 'wf1', path: 'audit_log', producer: 'planner', acceptance: 'green',
      version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0,
    },
  ];
  const runs = [
    {
      id: 'r1', workflow: 'wf1', loop: 'planner', key: '',
      outcome: 'ok' as const, createdAt: 1000, updatedAt: 2000,
      fingerprint: { proposal: 1 },
    },
  ];
  const trace = buildTrace(auditedDef, artifacts, runs);
  const plannerEvent = trace.timeline.find((e) => e.loop === 'planner');
  assert.ok(plannerEvent !== undefined, 'planner should appear in timeline');
  assert.ok(
    plannerEvent!.producedStems.includes('audit_log'),
    `audit_log should be in producedStems; got: ${plannerEvent!.producedStems.join(', ')}`,
  );
  assert.ok(
    plannerEvent!.producedStems.includes('plan'),
    `plan should be in producedStems; got: ${plannerEvent!.producedStems.join(', ')}`,
  );
});

// Test 15: buildGraph — generated stem's loop appears as a node and does not throw
test('generates: buildGraph includes planner loop node and does not throw', () => {
  // Should not throw
  const graph = buildGraph(auditedDef);
  const plannerNode = graph.nodes.find((n) => n.id === 'planner');
  assert.ok(plannerNode !== undefined, 'planner node should be in graph');
  assert.equal(plannerNode!.kind, 'loop');
  // audit_log is in planner's produces (via union), so it is "owned" by planner in producerOf;
  // since nothing consumes it, there is no edge from planner for audit_log — just no crash.
  assert.ok(!graph.edges.some((e) => e.stem === 'audit_log'), 'no edge for unconsumed audit_log');
});

// ---- M2-FIRINGS: eligibleFirings, pendingOwed, and debt/done for calls: loops --

import { parseProduce } from '../src/paths.ts';

/** Build a minimal calls: LoopDef directly (helpers.ts loop() does not support calls:). */
function callsLoop(name: string, callsTarget: string, produceStem: string): import('../src/types.ts').LoopDef {
  return {
    name,
    calls: callsTarget,
    callsInputs: {},
    consumes: [],
    produces: [parseProduce(produceStem)],
    invalidates: [],
    cadence: '0s',
    cadenceSecs: 0,
    maxRunsPerDay: 1000,
    parallel: 1,
    maxAttempts: 1,
    maxSchemaFailures: 5,
    workdir: 'main',
    body: '',
  };
}

test('eligibleFirings skips calls: loops — no firing is emitted for the calls: loop', () => {
  // Def with one calls: loop (deliver) and one normal loop (teardown)
  const d = def(
    'parent',
    [input('proposal')],
    [
      callsLoop('deliver', 'delivery', 'delivered'),
      loop({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
    ],
  );
  // Seed: proposal green, delivered owed (so teardown cannot fire either — missing 'delivered')
  const artMap = arts([
    { path: 'proposal', acceptance: 'green', version: 1 },
    { path: 'delivered', acceptance: 'owed', version: 0 },
  ]);
  const firings = eligibleFirings(d, artMap);
  // The calls: loop must NOT appear in firings
  assert.ok(
    !firings.some((f) => f.loop === 'deliver'),
    `calls: loop 'deliver' must not appear in eligibleFirings; got: ${firings.map((f) => f.loop).join(', ')}`,
  );
});

test('pendingOwed seeds calls: loop output as owed', () => {
  const d = def(
    'parent',
    [input('proposal')],
    [
      callsLoop('deliver', 'delivery', 'delivered'),
      loop({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
    ],
  );
  // Only proposal is seeded; 'delivered' and 'done' are not yet in arts
  const artMap = arts([
    { path: 'proposal', acceptance: 'green', version: 1 },
  ]);
  const owed = pendingOwed(d, artMap);
  const owedPaths = owed.map((a) => a.path);
  assert.ok(
    owedPaths.includes('delivered'),
    `calls: output 'delivered' must be seeded owed by pendingOwed; got: ${owedPaths.join(', ')}`,
  );
});

test('workflow is not done while calls: output is owed', () => {
  const d = def(
    'parent',
    [input('proposal')],
    [
      callsLoop('deliver', 'delivery', 'delivered'),
      loop({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
    ],
  );
  // All inputs green; calls: output owed; teardown output owed
  const artMap = arts([
    { path: 'proposal', acceptance: 'green', version: 1 },
    { path: 'delivered', acceptance: 'owed', version: 0 },
    { path: 'done', acceptance: 'owed', version: 0 },
  ]);
  const status = workflowStatus(d, artMap);
  assert.equal(status.done, false, 'workflow must not be done while calls: output is owed');
  assert.ok(status.debts.length > 0, 'workflow must have debts while calls: output is owed');
});
