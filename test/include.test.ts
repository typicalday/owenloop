/**
 * Tests for Mode 1 compile-time `include:` composition (§22).
 * Covers: expandIncludes, buildDef include-directive parsing, and loadDefs end-to-end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDef, DefError, expandIncludes, loadDefs, validateDef } from '../src/defs.ts';
import type { WorkflowDef } from '../src/types.ts';
import { sealPath } from '../src/paths.ts';

// ---- helpers -----------------------------------------------------------------

function makeResolver(defs: WorkflowDef[]): (name: string) => WorkflowDef | undefined {
  const m = new Map(defs.map((d) => [d.name, d]));
  return (name) => m.get(name);
}

/** Raw YAML object for the canonical delivery workflow. */
const deliveryRaw = {
  name: 'delivery',
  title: 'Software delivery',
  inputs: [{ name: 'proposal', seedOwed: true }],
  steps: [
    { name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'plan it' },
    { name: 'builder', consumes: ['plan'], produces: ['pr'], body: 'build it' },
    { name: 'reviewer', consumes: ['pr'], produces: ['verdict'], body: 'review it' },
    { name: 'merger', consumes: ['verdict'], produces: ['merge'], terminal: true, body: 'merge it' },
  ],
};

/** Raw YAML object for a parent def that includes delivery `as: deliver` with proposal mapped. */
const parentWithMappedRaw = {
  name: 'full-cycle',
  inputs: [{ name: 'proposal', seedOwed: true }],
  steps: [
    { name: 'provision', consumes: ['proposal'], produces: ['environment'], body: 'provision' },
    { include: 'delivery', as: 'deliver', inputs: { proposal: 'proposal' } },
    {
      name: 'teardown',
      consumes: ['environment', 'deliver.merge'],
      produces: ['torn_down'],
      generates: ['teardown_log'],
      body: 'teardown',
    },
  ],
  outputs: ['torn_down'],
};

// ---- (a) Basic expansion: prefixed steps, prefixed produces, parent can consume child artifact ---

test('(a) expandIncludes: basic expansion — step names prefixed, stems prefixed, terminal preserved', () => {
  const deliveryDef = buildDef(deliveryRaw);
  const parentDef = buildDef(parentWithMappedRaw);
  const expanded = expandIncludes(parentDef, makeResolver([deliveryDef]));

  const stepNames = expanded.steps.map((l) => l.name);
  assert.deepEqual(stepNames, [
    'provision',
    'deliver.planner',
    'deliver.builder',
    'deliver.reviewer',
    'deliver.merger',
    'teardown',
  ]);

  const deliverPlanner = expanded.steps.find((l) => l.name === 'deliver.planner')!;
  assert.ok(deliverPlanner, 'deliver.planner must exist');

  // Mapped input: deliver.planner's first consume stem is outer 'proposal' (not prefixed)
  assert.equal(deliverPlanner.consumes[0]!.stem, 'proposal');
  assert.equal(deliverPlanner.consumes[0]!.mode, 'plain');

  // produce stem is prefixed
  assert.equal(deliverPlanner.produces[0]!.stem, 'deliver.plan');

  const deliverBuilder = expanded.steps.find((l) => l.name === 'deliver.builder')!;
  // Internal consume: deliver.builder consumes deliver.plan (prefixed)
  assert.equal(deliverBuilder.consumes[0]!.stem, 'deliver.plan');

  const deliverMerger = expanded.steps.find((l) => l.name === 'deliver.merger')!;
  assert.equal(deliverMerger.produces[0]!.stem, 'deliver.merge');
  assert.equal(deliverMerger.terminal, true, 'terminal must be preserved after prefixing');

  // The expanded def must pass validateDef (teardown consumes deliver.merge — valid cross-boundary)
  const errors = validateDef(expanded);
  assert.deepEqual(errors, []);
});

// ---- (b) Mapped input becomes internal consume edge, NOT a new input --------

test('(b) expandIncludes: mapped input is not hoisted — parent inputs unchanged', () => {
  const deliveryDef = buildDef(deliveryRaw);
  const parentDef = buildDef(parentWithMappedRaw);
  const expanded = expandIncludes(parentDef, makeResolver([deliveryDef]));

  // There must be exactly one 'proposal' input (the parent's own — the child's was mapped)
  const proposalInputs = expanded.inputs.filter((i) => i.name === 'proposal');
  assert.equal(proposalInputs.length, 1, 'exactly one proposal input after mapped expansion');

  // No 'deliver.proposal' input (it was mapped, not hoisted)
  const hoisted = expanded.inputs.find((i) => i.name === 'deliver.proposal');
  assert.equal(hoisted, undefined, 'deliver.proposal must NOT be hoisted when mapped');

  // deliver.planner consumes the outer 'proposal', not 'deliver.proposal'
  const deliverPlanner = expanded.steps.find((l) => l.name === 'deliver.planner')!;
  assert.equal(deliverPlanner.consumes[0]!.stem, 'proposal');
});

// ---- (c) Unmapped input is hoisted as ${as}.${childInputName} preserving seedOwed -----

test('(c) expandIncludes: unmapped input is hoisted with prefix and seedOwed preserved', () => {
  const deliveryDef = buildDef(deliveryRaw);
  // Parent with NO inputs mapping for delivery's proposal
  const parentNoMapRaw = {
    name: 'no-map-parent',
    inputs: [] as unknown[],
    steps: [
      { include: 'delivery', as: 'deliver' },
    ],
  };
  const parentDef = buildDef(parentNoMapRaw);
  const expanded = expandIncludes(parentDef, makeResolver([deliveryDef]));

  // 'deliver.proposal' must be hoisted
  const hoisted = expanded.inputs.find((i) => i.name === 'deliver.proposal');
  assert.ok(hoisted, 'deliver.proposal must be hoisted when unmapped');
  assert.equal(hoisted.seedOwed, true, 'seedOwed must be preserved when hoisting');

  // deliver.planner must consume 'deliver.proposal' (prefixed)
  const deliverPlanner = expanded.steps.find((l) => l.name === 'deliver.planner')!;
  assert.equal(deliverPlanner.consumes[0]!.stem, 'deliver.proposal');
});

// ---- (d) Collection child — map/reduce step under prefix keeps correct seal paths ------

test('(d) expandIncludes: collection child steps keep correct prefixed stems and seal paths', () => {
  const collectionChildRaw = {
    name: 'collector',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'gatherer', consumes: ['seed'], produces: ['source[]'], body: 'gather' },
      { name: 'fmt', consumes: ['source[$i]'], produces: ['source[$i].check'], body: 'format' },
      { name: 'synth', consumes: ['source[*]'], produces: ['report'], body: 'synth' },
    ],
  };
  const parentRaw = {
    name: 'parent-collector',
    inputs: [{ name: 'outer_seed' }],
    steps: [
      { include: 'collector', as: 'child', inputs: { seed: 'outer_seed' } },
    ],
    outputs: ['child.report'],
  };

  const childDef = buildDef(collectionChildRaw);
  const parentDef = buildDef(parentRaw);
  const expanded = expandIncludes(parentDef, makeResolver([childDef]));

  const gatherer = expanded.steps.find((l) => l.name === 'child.gatherer')!;
  assert.ok(gatherer, 'child.gatherer must exist');
  assert.equal(gatherer.produces[0]!.stem, 'child.source');
  assert.equal(gatherer.produces[0]!.kind, 'collection');

  const fmt = expanded.steps.find((l) => l.name === 'child.fmt')!;
  assert.ok(fmt, 'child.fmt must exist');
  assert.equal(fmt.consumes[0]!.stem, 'child.source');
  assert.equal(fmt.consumes[0]!.mode, 'map');
  assert.equal(fmt.produces[0]!.stem, 'child.source');
  assert.equal(fmt.produces[0]!.kind, 'map');
  assert.equal(fmt.produces[0]!.suffix, '.check');

  const synth = expanded.steps.find((l) => l.name === 'child.synth')!;
  assert.ok(synth, 'child.synth must exist');
  assert.equal(synth.consumes[0]!.stem, 'child.source');
  assert.equal(synth.consumes[0]!.mode, 'reduce');
  assert.equal(synth.produces[0]!.stem, 'child.report');

  // Seal path derived from prefixed stem
  assert.equal(sealPath('child.source'), 'child.source.sealed');

  const errors = validateDef(expanded);
  assert.deepEqual(errors, []);
});

// ---- (e) Nested include (A includes B includes C) fully expands ---------------

test('(e) expandIncludes: nested includes (A->B->C) fully expand with correct name nesting', () => {
  const cRaw = {
    name: 'c',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'c1', consumes: ['seed'], produces: ['mid'], body: 'c1' },
      { name: 'c2', consumes: ['mid'], produces: ['cresult'], body: 'c2' },
    ],
    outputs: ['cresult'],
  };
  const bRaw = {
    name: 'b',
    inputs: [{ name: 'bseed' }],
    steps: [
      { include: 'c', as: 'c', inputs: { seed: 'bseed' } },
      { name: 'ownstep', consumes: ['c.cresult'], produces: ['bresult'], body: 'b' },
    ],
    outputs: ['bresult'],
  };
  const aRaw = {
    name: 'a',
    inputs: [{ name: 'aseed' }],
    steps: [
      { include: 'b', as: 'b', inputs: { bseed: 'aseed' } },
      { name: 'ownA', consumes: ['b.bresult'], produces: ['aresult'], body: 'a' },
    ],
    outputs: ['aresult'],
  };

  const cDef = buildDef(cRaw);
  const bDef = buildDef(bRaw);
  const aDef = buildDef(aRaw);
  const resolver = makeResolver([cDef, bDef, aDef]);
  const expanded = expandIncludes(aDef, resolver);

  const stepNames = expanded.steps.map((l) => l.name);
  // Order: b.c.c1, b.c.c2, b.ownstep, ownA
  assert.ok(stepNames.includes('b.c.c1'), `expected b.c.c1, got: ${stepNames.join(', ')}`);
  assert.ok(stepNames.includes('b.c.c2'), `expected b.c.c2, got: ${stepNames.join(', ')}`);
  assert.ok(stepNames.includes('b.ownstep'), `expected b.ownstep, got: ${stepNames.join(', ')}`);
  assert.ok(stepNames.includes('ownA'), `expected ownA, got: ${stepNames.join(', ')}`);

  // Order: b.c.c1 before b.c.c2 before b.ownstep before ownA
  assert.ok(stepNames.indexOf('b.c.c1') < stepNames.indexOf('b.c.c2'));
  assert.ok(stepNames.indexOf('b.c.c2') < stepNames.indexOf('b.ownstep'));
  assert.ok(stepNames.indexOf('b.ownstep') < stepNames.indexOf('ownA'));

  const errors = validateDef(expanded);
  assert.deepEqual(errors, []);
});

// ---- (f) Hard errors — M1-GRAMMAR and M1-VALIDATE pre-expansion checks ------

test('(f1) buildDef: missing as: throws DefError', () => {
  assert.throws(
    () => buildDef({
      name: 'parent',
      inputs: [],
      steps: [{ include: 'delivery' }],
    }),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /missing 'as:'/);
      return true;
    },
  );
});

test('(f2) buildDef: bad as: pattern (starts with digit) throws DefError', () => {
  assert.throws(
    () => buildDef({
      name: 'parent',
      inputs: [],
      steps: [{ include: 'delivery', as: '123bad' }],
    }),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /must be a non-empty identifier/);
      return true;
    },
  );
});

test('(f3) buildDef: as: with leading uppercase throws DefError', () => {
  assert.throws(
    () => buildDef({
      name: 'parent',
      inputs: [],
      steps: [{ include: 'delivery', as: 'Deliver' }],
    }),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /must be a non-empty identifier/);
      return true;
    },
  );
});

test('(f4) buildDef: duplicate as: throws DefError', () => {
  assert.throws(
    () => buildDef({
      name: 'parent',
      inputs: [{ name: 'x' }],
      steps: [
        { include: 'delivery', as: 'deliver' },
        { include: 'other', as: 'deliver' },
      ],
    }),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /used more than once/);
      return true;
    },
  );
});

test('(f5) buildDef: as: collides with sibling step name throws DefError', () => {
  assert.throws(
    () => buildDef({
      name: 'parent',
      inputs: [{ name: 'x' }],
      steps: [
        { name: 'deliver', consumes: ['x'], produces: ['y'], body: 'x' },
        { include: 'delivery', as: 'deliver' },
      ],
    }),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /collides with sibling step name/);
      return true;
    },
  );
});

test('(f6) expandIncludes: include of non-existent def throws DefError', () => {
  const parentRaw = {
    name: 'parent',
    inputs: [],
    steps: [{ include: 'nonexistent', as: 'x' }],
  };
  const parentDef = buildDef(parentRaw);
  assert.throws(
    () => expandIncludes(parentDef, (_name) => undefined),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /does not exist/);
      return true;
    },
  );
});

test('(f7) expandIncludes: inputs map references non-input key throws DefError', () => {
  const deliveryDef = buildDef(deliveryRaw);
  const parentRaw = {
    name: 'parent',
    inputs: [{ name: 'outer' }],
    steps: [
      { include: 'delivery', as: 'deliver', inputs: { nonexistent_key: 'outer' } },
    ],
  };
  const parentDef = buildDef(parentRaw);
  assert.throws(
    () => expandIncludes(parentDef, makeResolver([deliveryDef])),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /does not declare/);
      return true;
    },
  );
});

test('(f8) expandIncludes: include cycle throws DefError', () => {
  // A includes B, B includes A
  const aRaw = {
    name: 'cycleA',
    inputs: [{ name: 'x' }],
    steps: [{ include: 'cycleB', as: 'b' }],
    outputs: [] as string[],
  };
  const bRaw = {
    name: 'cycleB',
    inputs: [{ name: 'x' }],
    steps: [{ include: 'cycleA', as: 'a' }],
    outputs: [] as string[],
  };
  const aDef = buildDef(aRaw);
  const bDef = buildDef(bRaw);
  const resolver = makeResolver([aDef, bDef]);
  assert.throws(
    () => expandIncludes(aDef, resolver),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.match(e.message, /include cycle:/);
      return true;
    },
  );
});

// ---- (g) Expanded def passes validateDef; cross-boundary dangling consume fails -------

test('(g) validateDef on expanded def: valid parent+child passes; bad input mapping causes dangling error', () => {
  const deliveryDef = buildDef(deliveryRaw);
  const parentDef = buildDef(parentWithMappedRaw);
  const expanded = expandIncludes(parentDef, makeResolver([deliveryDef]));

  // Good case: no errors
  const errors = validateDef(expanded);
  assert.deepEqual(errors, []);

  // Bad case: map child input to a non-existent outer artifact
  const badParentRaw = {
    name: 'bad-parent',
    inputs: [{ name: 'outer' }],
    steps: [
      { name: 'provision', consumes: ['outer'], produces: ['environment'], body: 'x' },
      // map delivery's 'proposal' to 'nonexistent_outer' — will cause dangling consume
      { include: 'delivery', as: 'deliver', inputs: { proposal: 'nonexistent_outer' } },
      { name: 'teardown', consumes: ['environment', 'deliver.merge'], produces: ['done'], terminal: true, body: 'x' },
    ],
  };
  const badParentDef = buildDef(badParentRaw);
  const badExpanded = expandIncludes(badParentDef, makeResolver([deliveryDef]));
  const badErrors = validateDef(badExpanded);
  assert.ok(badErrors.length > 0, 'expected validation errors for non-existent outer artifact');
  assert.ok(
    badErrors.some((e) => e.includes("nothing produces 'nonexistent_outer'")),
    `expected "nothing produces 'nonexistent_outer'" in errors, got: ${badErrors.join('; ')}`,
  );
});

// ---- (h) loadDefs end-to-end on examples dir yields both expanded full-cycle and delivery ----

test('(h) loadDefs: examples/workflows dir loads both delivery and full-cycle correctly', () => {
  // Use a temp dir with our two YAML files to avoid depending on the full examples dir layout.
  const tmp = mkdtempSync(join(tmpdir(), 'owenloop-include-test-'));

  const deliveryYaml = `
name: delivery
title: Software delivery
inputs:
  - name: proposal
    seedOwed: true
steps:
  - name: planner
    consumes: [proposal]
    produces: [plan]
    body: plan it
  - name: builder
    consumes: [plan]
    produces: [pr]
    body: build it
  - name: reviewer
    consumes: [pr]
    produces: [verdict]
    body: review it
  - name: merger
    consumes: [verdict]
    produces: [merge]
    terminal: true
    body: merge it
`;

  const fullCycleYaml = `
name: full-cycle
inputs:
  - name: proposal
    seedOwed: true
outputs:
  - torn_down
steps:
  - name: provision
    consumes: [proposal]
    produces: [environment]
    body: provision
  - include: delivery
    as: deliver
    inputs:
      proposal: proposal
  - name: teardown
    consumes: [environment, deliver.merge]
    produces: [torn_down]
    generates: [teardown_log]
    body: teardown
`;

  writeFileSync(join(tmp, 'delivery.yaml'), deliveryYaml);
  writeFileSync(join(tmp, 'full-cycle.yaml'), fullCycleYaml);

  const all = loadDefs(tmp);

  // Both defs present
  assert.ok(all.has('delivery'), 'delivery must be present');
  assert.ok(all.has('full-cycle'), 'full-cycle must be present');

  // delivery has no _includes (it is a plain def)
  const delivery = all.get('delivery')!;
  assert.equal(delivery._includes, undefined, 'delivery must have no _includes after loading');

  // full-cycle has expanded steps
  const fullCycle = all.get('full-cycle')!;
  assert.equal(fullCycle._includes, undefined, 'full-cycle must have no _includes after expansion');
  const stepNames = fullCycle.steps.map((l) => l.name);
  assert.ok(stepNames.includes('deliver.planner'), `expected deliver.planner in ${stepNames.join(', ')}`);
  assert.ok(stepNames.includes('deliver.merger'), `expected deliver.merger in ${stepNames.join(', ')}`);
  assert.ok(stepNames.includes('teardown'), `expected teardown in ${stepNames.join(', ')}`);

  // Both pass validateDef
  assert.deepEqual(validateDef(delivery), []);
  assert.deepEqual(validateDef(fullCycle), []);
});
