import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDef, DefError, lintDef, loadDefFile, loadDefs, parseDef, validateDef } from '../src/defs.ts';

const delivery = {
  name: 'delivery',
  title: 'Software delivery',
  inputs: [{ name: 'proposal' }],
  loops: [
    { name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'plan it' },
    { name: 'builder', consumes: ['plan'], produces: ['pr'] },
    { name: 'reviewer', consumes: ['pr'], produces: ['verdict'] },
    { name: 'merger', consumes: ['verdict'], produces: ['merge'], terminal: true },
  ],
};

test('parseDef builds a valid def and fills defaults', () => {
  const def = parseDef(delivery);
  assert.equal(def.name, 'delivery');
  assert.equal(def.title, 'Software delivery');
  assert.equal(def.inputs[0]!.producer, 'human');
  assert.equal(def.inputs[0]!.seedOwed, false);
  const planner = def.loops[0]!;
  assert.equal(planner.cadence, '0s');
  assert.equal(planner.cadenceSecs, 0);
  assert.equal(planner.parallel, 1);
  assert.equal(planner.maxAttempts, 3);
  assert.equal(planner.workdir, 'main');
  assert.deepEqual(planner.invalidates, ['proposal']); // defaults to consumed stems
  assert.equal(def.loops[3]!.terminal, true);
});

test('parseDef parses cadence durations to seconds', () => {
  const def = parseDef({
    name: 'poll',
    inputs: [{ name: 'seed' }],
    loops: [{ name: 'watch', consumes: ['seed'], produces: ['report'], cadence: '30m' }],
  });
  assert.equal(def.loops[0]!.cadenceSecs, 1800);
});

test('parseDef classifies map and reduce wiring', () => {
  const def = parseDef({
    name: 'research',
    inputs: [{ name: 'question' }],
    loops: [
      { name: 'gather', consumes: ['question'], produces: ['gather.source[]'] },
      { name: 'fmt', consumes: ['gather.source[$i]'], produces: ['gather.source[$i].formatcheck'] },
      { name: 'synth', consumes: ['gather.source[*]'], produces: ['draft'] },
    ],
  });
  assert.equal(def.loops[1]!.consumes[0]!.mode, 'map');
  assert.equal(def.loops[2]!.consumes[0]!.mode, 'reduce');
});

test('rejects a non-object definition', () => {
  assert.throws(() => parseDef('nope'), DefError);
  assert.throws(() => parseDef(null), DefError);
});

test('rejects a missing/blank name', () => {
  assert.throws(() => parseDef({ loops: [{ name: 'a' }] }), DefError);
  assert.throws(() => parseDef({ name: 'has space', loops: [{ name: 'a' }] }), /alphanumeric/);
});

test('rejects a workflow with no loops', () => {
  assert.throws(() => parseDef({ name: 'empty', inputs: [{ name: 'x' }] }), /at least one loop/);
});

test('validateDef flags a dangling consume', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    loops: [{ name: 'one', consumes: ['a'], produces: ['b'] }, { name: 'two', consumes: ['nope'], produces: ['c'] }],
  }));
  assert.ok(errors.some((e) => e.includes("nothing produces 'nope'")), errors.join('; '));
});

test('validateDef flags two producers for one artifact', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    loops: [
      { name: 'one', consumes: ['a'], produces: ['x'] },
      { name: 'two', consumes: ['a'], produces: ['x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('two producers')), errors.join('; '));
});

test('validateDef flags an input that collides with a loop name', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'planner' }],
    loops: [{ name: 'planner', consumes: ['planner'], produces: ['plan'] }],
  }));
  assert.ok(errors.some((e) => e.includes('both an input and a loop')), errors.join('; '));
});

test('validateDef flags a map consume without a per-element produce', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'gather', consumes: ['q'], produces: ['set[]'] },
      { name: 'broken', consumes: ['set[$i]'], produces: ['summary'] }, // singleton, not map
    ],
  }));
  assert.ok(errors.some((e) => e.includes('produces no per-element')), errors.join('; '));
});

test('validateDef flags a reduce over a non-collection', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [{ name: 'synth', consumes: ['q', 'ghost[*]'], produces: ['draft'] }],
  }));
  assert.ok(errors.some((e) => e.includes("no loop produces 'ghost[]'")), errors.join('; '));
});

test('validateDef detects a dependency cycle', () => {
  const errors = validateDef(buildDef({
    name: 'loopy',
    inputs: [],
    loops: [
      { name: 'a', consumes: ['y'], produces: ['x'] },
      { name: 'b', consumes: ['x'], produces: ['y'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('dependency cycle')), errors.join('; '));
});

test('the knock-back graph is NOT a cycle (reject is runtime, not a dep edge)', () => {
  // reviewer consumes pr and produces verdict; builder consumes plan produces pr.
  // The reject feedback is a runtime action, not a consume edge, so this is a DAG.
  const errors = validateDef(parseDef(delivery));
  assert.deepEqual(errors, []);
});

test('buildDef rejects consumes that are not a list of strings', () => {
  assert.throws(
    () => buildDef({ name: 'bad', inputs: [{ name: 'a' }], loops: [{ name: 'x', consumes: 'a', produces: ['y'] }] }),
    /must be a list of strings/,
  );
});

test('buildDef rejects a produce entry that is neither a string nor a { name, schema }', () => {
  assert.throws(
    () => buildDef({ name: 'bad', inputs: [{ name: 'a' }], loops: [{ name: 'x', consumes: ['a'], produces: [42] }] }),
    /must be a string or a \{ name, schema \} mapping/,
  );
});

test('parseDef aggregates validation errors into a single thrown DefError', () => {
  assert.throws(
    () =>
      parseDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        loops: [
          { name: 'one', consumes: ['a'], produces: ['b'] },
          { name: 'two', consumes: ['nope'], produces: ['c'] },
        ],
      }),
    /invalid workflow 'bad'[\s\S]*nothing produces 'nope'/,
  );
});

test('validateDef flags more than one map consume in a loop', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g1', consumes: ['q'], produces: ['a[]'] },
      { name: 'g2', consumes: ['q'], produces: ['b[]'] },
      { name: 'multi', consumes: ['a[$i]', 'b[$i]'], produces: ['a[$i].x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('more than one map consume')), errors.join('; '));
});

test('validateDef flags more than one reduce consume in a loop', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g1', consumes: ['q'], produces: ['a[]'] },
      { name: 'g2', consumes: ['q'], produces: ['b[]'] },
      { name: 'multi', consumes: ['a[*]', 'b[*]'], produces: ['draft'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('more than one reduce consume')), errors.join('; '));
});

test('validateDef flags a loop that mixes a map and a reduce consume', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g', consumes: ['q'], produces: ['a[]'] },
      { name: 'mix', consumes: ['a[$i]', 'a[*]'], produces: ['a[$i].x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('mixes a map and a reduce')), errors.join('; '));
});

test('validateDef flags a per-element produce with no map consume to bind it', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'g', consumes: ['q'], produces: ['a[]'] },
      { name: 'weird', consumes: ['q'], produces: ['a[$i].x'] }, // map produce, no $i consume
    ],
  }));
  assert.ok(errors.some((e) => e.includes('no map ($i) consume to bind it')), errors.join('; '));
});

test('parseDef attaches a JSON Schema to a produce given as { name, schema }', () => {
  const def = parseDef({
    name: 'schemad',
    inputs: [{ name: 'q' }],
    loops: [
      {
        name: 'planner',
        consumes: ['q'],
        produces: [{ name: 'plan', schema: { type: 'object', required: ['plan'] } }],
      },
    ],
  });
  const plan = def.loops[0]!.produces[0]!;
  assert.equal(plan.stem, 'plan');
  assert.deepEqual(plan.schema, { type: 'object', required: ['plan'] });
});

test('parseDef leaves produces without a schema undefined and accepts mixed entries', () => {
  const def = parseDef({
    name: 'mixed',
    inputs: [{ name: 'q' }],
    loops: [
      {
        name: 'planner',
        consumes: ['q'],
        produces: ['plan', { name: 'notes', schema: { type: 'object' } }],
      },
    ],
  });
  assert.equal(def.loops[0]!.produces[0]!.schema, undefined);
  assert.deepEqual(def.loops[0]!.produces[1]!.schema, { type: 'object' });
});

test('parseDef attaches a JSON Schema to an input', () => {
  const def = parseDef({
    name: 'schemad-in',
    inputs: [{ name: 'proposal', schema: { type: 'object', required: ['text'] } }],
    loops: [{ name: 'a', consumes: ['proposal'], produces: ['plan'] }],
  });
  assert.deepEqual(def.inputs[0]!.schema, { type: 'object', required: ['text'] });
});

test('parseDef fills maxSchemaFailures default and parses an override', () => {
  const def = parseDef({
    name: 'caps',
    inputs: [{ name: 'q' }],
    loops: [
      { name: 'a', consumes: ['q'], produces: ['plan'] },
      { name: 'b', consumes: ['plan'], produces: ['pr'], maxSchemaFailures: 2 },
    ],
  });
  assert.equal(def.loops[0]!.maxSchemaFailures, 5);
  assert.equal(def.loops[1]!.maxSchemaFailures, 2);
});

test('buildDef rejects a malformed produce schema with a DefError', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'q' }],
        loops: [{ name: 'a', consumes: ['q'], produces: [{ name: 'plan', schema: 42 }] }],
      }),
    (e: unknown) => e instanceof DefError && /must be a JSON Schema object or boolean/.test((e as Error).message),
  );
});

test('buildDef rejects a malformed input schema with a DefError', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'q', schema: 'not-a-schema' }],
        loops: [{ name: 'a', consumes: ['q'], produces: ['plan'] }],
      }),
    DefError,
  );
});

test('buildDef rejects a produce schema with an unresolved $ref (gross error at load)', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'q' }],
        loops: [{ name: 'a', consumes: ['q'], produces: [{ name: 'plan', schema: { $ref: '#/nope' } }] }],
      }),
    (e: unknown) => e instanceof DefError && /is not a valid JSON Schema/.test((e as Error).message),
  );
});

test('loadDefs discovers a workflow.yaml inside a subdirectory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oweflow-defs-sub-'));
  // a flat file...
  writeFileSync(
    join(dir, 'flat.yaml'),
    'name: flat\ninputs:\n  - name: x\nloops:\n  - name: a\n    consumes: [x]\n    produces: [y]\n',
  );
  // ...and a packaged subdirectory with its own workflow.yaml
  const sub = join(dir, 'packaged');
  mkdirSync(sub);
  writeFileSync(
    join(sub, 'workflow.yaml'),
    'name: packaged\ninputs:\n  - name: seed\nloops:\n  - name: run\n    consumes: [seed]\n    produces: [out]\n',
  );
  // a subdirectory WITHOUT a workflow.yaml is silently skipped, not an error
  mkdirSync(join(dir, 'empty-dir'));

  const all = loadDefs(dir);
  assert.deepEqual([...all.keys()].sort(), ['flat', 'packaged']);
});

test('loadDefFile and loadDefs read YAML from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oweflow-defs-'));
  writeFileSync(
    join(dir, 'delivery.yaml'),
    [
      'name: delivery',
      'inputs:',
      '  - name: proposal',
      'loops:',
      '  - name: planner',
      '    consumes: [proposal]',
      '    produces: [plan]',
      '    body: |',
      '      Plan ${WORKFLOW}.',
      '  - name: builder',
      '    consumes: [plan]',
      '    produces: [pr]',
    ].join('\n'),
  );
  const single = loadDefFile(join(dir, 'delivery.yaml'));
  assert.equal(single.name, 'delivery');
  assert.equal(single.loops[0]!.body.trim(), 'Plan ${WORKFLOW}.');

  const all = loadDefs(dir);
  assert.deepEqual([...all.keys()], ['delivery']);
});

// ---- lintDef -----------------------------------------------------------------

test('lintDef has no errors for a fully reachable linear chain', () => {
  const { errors, warnings } = lintDef(buildDef({
    name: 'linear',
    inputs: [{ name: 'seed' }],
    loops: [
      { name: 'a', consumes: ['seed'], produces: ['mid'] },
      { name: 'b', consumes: ['mid'], produces: ['out'], terminal: true },
    ],
  }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('lintDef flags an unreachable loop (its consumed stem has a producer that is unreachable)', () => {
  // 'a' is reachable from input 'start'. 'c' consumes 'ghost' (no producer) — dangling.
  // 'b' consumes 'other' which 'c' produces, but 'c' is dangling/unreachable.
  // 'b' should be reported as unreachable; 'c' should NOT be double-reported.
  const def = buildDef({
    name: 'island',
    inputs: [{ name: 'start' }],
    loops: [
      { name: 'a', consumes: ['start'], produces: ['mid', 'out'], terminal: true },
      { name: 'c', consumes: ['ghost'], produces: ['other'] },  // dangling: 'ghost' has no producer
      { name: 'b', consumes: ['other'], produces: ['result'] }, // unreachable: 'other' produced by unreachable 'c'
    ],
  });
  const { errors } = lintDef(def);
  // 'c' triggers dangling-consume (ghost has no producer)
  assert.ok(errors.some((e) => e.includes("nothing produces 'ghost'")), errors.join('; '));
  // 'b' triggers reachability (other is produced by unreachable 'c')
  assert.ok(errors.some((e) => /loop 'b' is unreachable/.test(e)), errors.join('; '));
  // 'c' must NOT also produce a reachability error (it is suppressed because it already has dangling)
  assert.ok(!errors.some((e) => /loop 'c' is unreachable/.test(e)), 'c should not be double-reported');
});

test('lintDef warns about a non-terminal loop whose output nothing consumes', () => {
  const def = buildDef({
    name: 'deadend',
    inputs: [{ name: 'seed' }],
    loops: [
      { name: 'a', consumes: ['seed'], produces: ['useful', 'orphan'] },
      { name: 'b', consumes: ['useful'], produces: ['final'], terminal: true },
    ],
  });
  const { errors, warnings } = lintDef(def);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("loop 'a' produces 'orphan' but nothing consumes it")), warnings.join('; '));
  assert.equal(warnings.filter((w) => w.includes('orphan')).length, 1, 'exactly one warning for orphan');
});

test('lintDef does not warn about unconsumed outputs on a terminal loop', () => {
  const def = buildDef({
    name: 'terminal-sink',
    inputs: [{ name: 'seed' }],
    loops: [
      { name: 'a', consumes: ['seed'], produces: ['plan'] },
      { name: 'b', consumes: ['plan'], produces: ['done'], terminal: true },
    ],
  });
  const { warnings } = lintDef(def);
  assert.deepEqual(warnings, []);
});

test('lintDef does not double-report: a dangling-consume loop is not also reported as unreachable', () => {
  const def = buildDef({
    name: 'dangle-not-double',
    inputs: [{ name: 'seed' }],
    loops: [
      { name: 'a', consumes: ['seed'], produces: ['mid'] },
      { name: 'b', consumes: ['nope'], produces: ['out'], terminal: true }, // dangling: 'nope' has no producer
    ],
  });
  const { errors } = lintDef(def);
  const danglingErrors = errors.filter((e) => e.includes("nothing produces 'nope'"));
  const reachErrors = errors.filter((e) => /loop 'b' is unreachable/.test(e));
  assert.equal(danglingErrors.length, 1, 'exactly one dangling-consume error');
  assert.equal(reachErrors.length, 0, 'no reachability error for the same loop');
});

test('lintDef on the delivery example: no errors, no warnings', () => {
  const { errors, warnings } = lintDef(parseDef(delivery));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
