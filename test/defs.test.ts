import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { parseProduce } from '../src/paths.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDef, DefError, lintDef, loadDefFile, loadDefs, parseDef, validateDef } from '../src/defs.ts';
import { def, input, step } from './helpers.ts';

const delivery = {
  name: 'delivery',
  title: 'Software delivery',
  inputs: [{ name: 'proposal' }],
  steps: [
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
  const planner = def.steps[0]!;
  assert.equal(planner.cadence, '0s');
  assert.equal(planner.cadenceSecs, 0);
  assert.equal(planner.parallel, 1);
  assert.equal(planner.maxAttempts, 3);
  assert.equal(planner.workdir, 'main');
  assert.deepEqual(planner.invalidates, ['proposal']); // defaults to consumed stems
  assert.equal(def.steps[3]!.terminal, true);
});

test('parseDef parses cadence durations to seconds', () => {
  const def = parseDef({
    name: 'poll',
    inputs: [{ name: 'seed' }],
    steps: [{ name: 'watch', consumes: ['seed'], produces: ['report'], cadence: '30m' }],
  });
  assert.equal(def.steps[0]!.cadenceSecs, 1800);
});

test('parseDef classifies map and reduce wiring', () => {
  const def = parseDef({
    name: 'research',
    inputs: [{ name: 'question' }],
    steps: [
      { name: 'gather', consumes: ['question'], produces: ['gather.source[]'] },
      { name: 'fmt', consumes: ['gather.source[$i]'], produces: ['gather.source[$i].formatcheck'] },
      { name: 'synth', consumes: ['gather.source[*]'], produces: ['draft'] },
    ],
  });
  assert.equal(def.steps[1]!.consumes[0]!.mode, 'map');
  assert.equal(def.steps[2]!.consumes[0]!.mode, 'reduce');
});

test('rejects a non-object definition', () => {
  assert.throws(() => parseDef('nope'), DefError);
  assert.throws(() => parseDef(null), DefError);
});

test('rejects a missing/blank name', () => {
  assert.throws(() => parseDef({ steps: [{ name: 'a' }] }), DefError);
  assert.throws(() => parseDef({ name: 'has space', steps: [{ name: 'a' }] }), /alphanumeric/);
});

test('rejects a workflow with no steps', () => {
  assert.throws(() => parseDef({ name: 'empty', inputs: [{ name: 'x' }] }), /at least one step/);
});

test('validateDef flags a dangling consume', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [{ name: 'one', consumes: ['a'], produces: ['b'] }, { name: 'two', consumes: ['nope'], produces: ['c'] }],
  }));
  assert.ok(errors.some((e) => e.includes("nothing produces 'nope'")), errors.join('; '));
});

test('validateDef flags two producers for one artifact', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [
      { name: 'one', consumes: ['a'], produces: ['x'] },
      { name: 'two', consumes: ['a'], produces: ['x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('two producers')), errors.join('; '));
});

test('validateDef flags an input that collides with a step name', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'planner' }],
    steps: [{ name: 'planner', consumes: ['planner'], produces: ['plan'] }],
  }));
  assert.ok(errors.some((e) => e.includes('both an input and a step')), errors.join('; '));
});

test('validateDef flags a map consume without a per-element produce', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    steps: [
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
    steps: [{ name: 'synth', consumes: ['q', 'ghost[*]'], produces: ['draft'] }],
  }));
  assert.ok(errors.some((e) => e.includes("no step produces 'ghost[]'")), errors.join('; '));
});

test('validateDef detects a dependency cycle', () => {
  const errors = validateDef(buildDef({
    name: 'stepy',
    inputs: [],
    steps: [
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
    () => buildDef({ name: 'bad', inputs: [{ name: 'a' }], steps: [{ name: 'x', consumes: 'a', produces: ['y'] }] }),
    /must be a list of strings/,
  );
});

test('buildDef rejects a produce entry that is neither a string nor a { name, schema }', () => {
  assert.throws(
    () => buildDef({ name: 'bad', inputs: [{ name: 'a' }], steps: [{ name: 'x', consumes: ['a'], produces: [42] }] }),
    /must be a string or a \{ name, schema, judges \} mapping/,
  );
});

// ---- §24 judges: validation (parseJudges / parseProduces) --------------------

test('buildDef rejects a judges: entry missing a name', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'researcher',
            consumes: ['a'],
            produces: [{ name: 'report', judges: [{ body: 'evaluate completeness' }] }],
          },
        ],
      }),
    (e: unknown) => e instanceof DefError && /produce 'report'\.judges\[0\]\.name must be a string/.test((e as Error).message),
  );
});

test('buildDef rejects a judges: entry with both body and bodyFile set', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'researcher',
            consumes: ['a'],
            produces: [
              {
                name: 'report',
                judges: [{ name: 'completeness', body: 'inline', bodyFile: 'x.md' }],
              },
            ],
          },
        ],
      }),
    (e: unknown) => e instanceof DefError && /judge 'completeness': set either body or bodyFile, not both/.test((e as Error).message),
  );
});

test('buildDef rejects a judges: entry with neither body nor bodyFile set', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'researcher',
            consumes: ['a'],
            produces: [{ name: 'report', judges: [{ name: 'completeness' }] }],
          },
        ],
      }),
    (e: unknown) => e instanceof DefError && /judge 'completeness': must set either body or bodyFile/.test((e as Error).message),
  );
});

test('buildDef rejects duplicate judge names on the same produce', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'researcher',
            consumes: ['a'],
            produces: [
              {
                name: 'report',
                judges: [
                  { name: 'completeness', body: 'evaluate completeness' },
                  { name: 'completeness', body: 'evaluate again' },
                ],
              },
            ],
          },
        ],
      }),
    (e: unknown) => e instanceof DefError && /produce 'report'\.judges: duplicate judge name 'completeness'/.test((e as Error).message),
  );
});

test('buildDef rejects judges: declared on a non-singleton (collection) produce', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'gatherer',
            consumes: ['a'],
            produces: [
              {
                name: 'items[]',
                judges: [{ name: 'completeness', body: 'evaluate completeness' }],
              },
            ],
          },
        ],
      }),
    (e: unknown) =>
      e instanceof DefError &&
      /produce 'items\[\]': judges: is only supported on singleton produces \(v1\), got a collection produce/.test((e as Error).message),
  );
});

test('parseDef aggregates validation errors into a single thrown DefError', () => {
  assert.throws(
    () =>
      parseDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          { name: 'one', consumes: ['a'], produces: ['b'] },
          { name: 'two', consumes: ['nope'], produces: ['c'] },
        ],
      }),
    /invalid workflow 'bad'[\s\S]*nothing produces 'nope'/,
  );
});

test('validateDef flags more than one map consume in a step', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    steps: [
      { name: 'g1', consumes: ['q'], produces: ['a[]'] },
      { name: 'g2', consumes: ['q'], produces: ['b[]'] },
      { name: 'multi', consumes: ['a[$i]', 'b[$i]'], produces: ['a[$i].x'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('more than one map consume')), errors.join('; '));
});

test('validateDef flags more than one reduce consume in a step', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    steps: [
      { name: 'g1', consumes: ['q'], produces: ['a[]'] },
      { name: 'g2', consumes: ['q'], produces: ['b[]'] },
      { name: 'multi', consumes: ['a[*]', 'b[*]'], produces: ['draft'] },
    ],
  }));
  assert.ok(errors.some((e) => e.includes('more than one reduce consume')), errors.join('; '));
});

test('validateDef flags a step that mixes a map and a reduce consume', () => {
  const errors = validateDef(buildDef({
    name: 'bad',
    inputs: [{ name: 'q' }],
    steps: [
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
    steps: [
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
    steps: [
      {
        name: 'planner',
        consumes: ['q'],
        produces: [{ name: 'plan', schema: { type: 'object', required: ['plan'] } }],
      },
    ],
  });
  const plan = def.steps[0]!.produces[0]!;
  assert.equal(plan.stem, 'plan');
  assert.deepEqual(plan.schema, { type: 'object', required: ['plan'] });
});

test('parseDef leaves produces without a schema undefined and accepts mixed entries', () => {
  const def = parseDef({
    name: 'mixed',
    inputs: [{ name: 'q' }],
    steps: [
      {
        name: 'planner',
        consumes: ['q'],
        produces: ['plan', { name: 'notes', schema: { type: 'object' } }],
      },
    ],
  });
  assert.equal(def.steps[0]!.produces[0]!.schema, undefined);
  assert.deepEqual(def.steps[0]!.produces[1]!.schema, { type: 'object' });
});

test('parseDef attaches a JSON Schema to an input', () => {
  const def = parseDef({
    name: 'schemad-in',
    inputs: [{ name: 'proposal', schema: { type: 'object', required: ['text'] } }],
    steps: [{ name: 'a', consumes: ['proposal'], produces: ['plan'] }],
  });
  assert.deepEqual(def.inputs[0]!.schema, { type: 'object', required: ['text'] });
});

test('parseDef fills maxSchemaFailures default and parses an override', () => {
  const def = parseDef({
    name: 'caps',
    inputs: [{ name: 'q' }],
    steps: [
      { name: 'a', consumes: ['q'], produces: ['plan'] },
      { name: 'b', consumes: ['plan'], produces: ['pr'], maxSchemaFailures: 2 },
    ],
  });
  assert.equal(def.steps[0]!.maxSchemaFailures, 5);
  assert.equal(def.steps[1]!.maxSchemaFailures, 2);
});

test('buildDef rejects a malformed produce schema with a DefError', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'q' }],
        steps: [{ name: 'a', consumes: ['q'], produces: [{ name: 'plan', schema: 42 }] }],
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
        steps: [{ name: 'a', consumes: ['q'], produces: ['plan'] }],
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
        steps: [{ name: 'a', consumes: ['q'], produces: [{ name: 'plan', schema: { $ref: '#/nope' } }] }],
      }),
    (e: unknown) => e instanceof DefError && /is not a valid JSON Schema/.test((e as Error).message),
  );
});

test('loadDefs discovers a workflow.yaml inside a subdirectory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-defs-sub-'));
  // a flat file...
  writeFileSync(
    join(dir, 'flat.yaml'),
    'name: flat\ninputs:\n  - name: x\nsteps:\n  - name: a\n    consumes: [x]\n    produces: [y]\n',
  );
  // ...and a packaged subdirectory with its own workflow.yaml
  const sub = join(dir, 'packaged');
  mkdirSync(sub);
  writeFileSync(
    join(sub, 'workflow.yaml'),
    'name: packaged\ninputs:\n  - name: seed\nsteps:\n  - name: run\n    consumes: [seed]\n    produces: [out]\n',
  );
  // a subdirectory WITHOUT a workflow.yaml is silently skipped, not an error
  mkdirSync(join(dir, 'empty-dir'));

  const all = loadDefs(dir);
  assert.deepEqual([...all.keys()].sort(), ['flat', 'packaged']);
});

test('loadDefFile and loadDefs read YAML from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-defs-'));
  writeFileSync(
    join(dir, 'delivery.yaml'),
    [
      'name: delivery',
      'inputs:',
      '  - name: proposal',
      'steps:',
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
  assert.equal(single.steps[0]!.body.trim(), 'Plan ${WORKFLOW}.');

  const all = loadDefs(dir);
  assert.deepEqual([...all.keys()], ['delivery']);
});

// ---- bodyFile ------------------------------------------------------------

test("bodyFile: resolves relative to the workflow YAML's own directory", () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-bodyfile-'));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'research.md'), 'Research ${WORKFLOW}.\n');
  writeFileSync(
    join(dir, 'workflow.yaml'),
    [
      'name: research',
      'inputs:',
      '  - name: topic',
      'steps:',
      '  - name: researcher',
      '    consumes: [topic]',
      '    produces: [findings]',
      '    bodyFile: prompts/research.md',
    ].join('\n'),
  );

  const viaFile = loadDefFile(join(dir, 'workflow.yaml'));
  assert.equal(viaFile.steps[0]!.body.trim(), 'Research ${WORKFLOW}.');

  const viaDirSubdir = mkdtempSync(join(tmpdir(), 'owenloop-bodyfile-dirs-'));
  mkdirSync(join(viaDirSubdir, 'research'));
  mkdirSync(join(viaDirSubdir, 'research', 'prompts'));
  writeFileSync(join(viaDirSubdir, 'research', 'prompts', 'research.md'), 'Research ${WORKFLOW}.\n');
  writeFileSync(
    join(viaDirSubdir, 'research', 'workflow.yaml'),
    [
      'name: research',
      'inputs:',
      '  - name: topic',
      'steps:',
      '  - name: researcher',
      '    consumes: [topic]',
      '    produces: [findings]',
      '    bodyFile: prompts/research.md',
    ].join('\n'),
  );
  const all = loadDefs(viaDirSubdir);
  const viaDir = all.get('research');
  assert.ok(viaDir !== undefined, 'research workflow must load via loadDefs');
  assert.equal(viaDir.steps[0]!.body.trim(), 'Research ${WORKFLOW}.');
});

test('body: and bodyFile: together throws DefError matching /either body or bodyFile/', () => {
  const raw = {
    name: 'delivery',
    inputs: [{ name: 'proposal' }],
    steps: [
      { name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'inline', bodyFile: 'x.md' },
    ],
  };
  assert.throws(
    () => buildDef(raw),
    (e: unknown) => e instanceof DefError && /either body or bodyFile/.test((e as Error).message),
  );

  const dir = mkdtempSync(join(tmpdir(), 'owenloop-bodyfile-both-'));
  writeFileSync(
    join(dir, 'workflow.yaml'),
    [
      'name: delivery',
      'inputs:',
      '  - name: proposal',
      'steps:',
      '  - name: planner',
      '    consumes: [proposal]',
      '    produces: [plan]',
      '    body: inline',
      '    bodyFile: x.md',
    ].join('\n'),
  );
  assert.throws(
    () => loadDefFile(join(dir, 'workflow.yaml')),
    (e: unknown) => e instanceof DefError && /either body or bodyFile/.test((e as Error).message),
  );
});

test('bodyFile with no resolvable base throws a clear DefError', () => {
  const raw = {
    name: 'delivery',
    inputs: [{ name: 'proposal' }],
    steps: [
      { name: 'planner', consumes: ['proposal'], produces: ['plan'], bodyFile: 'x.md' },
    ],
  };
  assert.throws(() => buildDef(raw), DefError);
});

// ---- lintDef -----------------------------------------------------------------

test('lintDef has no errors for a fully reachable linear chain', () => {
  const { errors, warnings } = lintDef(buildDef({
    name: 'linear',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'a', consumes: ['seed'], produces: ['mid'] },
      { name: 'b', consumes: ['mid'], produces: ['out'], terminal: true },
    ],
  }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('lintDef flags an unreachable step (its consumed stem has a producer that is unreachable)', () => {
  // 'a' is reachable from input 'start'. 'c' consumes 'ghost' (no producer) — dangling.
  // 'b' consumes 'other' which 'c' produces, but 'c' is dangling/unreachable.
  // 'b' should be reported as unreachable; 'c' should NOT be double-reported.
  const def = buildDef({
    name: 'island',
    inputs: [{ name: 'start' }],
    steps: [
      { name: 'a', consumes: ['start'], produces: ['mid', 'out'], terminal: true },
      { name: 'c', consumes: ['ghost'], produces: ['other'] },  // dangling: 'ghost' has no producer
      { name: 'b', consumes: ['other'], produces: ['result'] }, // unreachable: 'other' produced by unreachable 'c'
    ],
  });
  const { errors } = lintDef(def);
  // 'c' triggers dangling-consume (ghost has no producer)
  assert.ok(errors.some((e) => e.includes("nothing produces 'ghost'")), errors.join('; '));
  // 'b' triggers reachability (other is produced by unreachable 'c')
  assert.ok(errors.some((e) => /step 'b' is unreachable/.test(e)), errors.join('; '));
  // 'c' must NOT also produce a reachability error (it is suppressed because it already has dangling)
  assert.ok(!errors.some((e) => /step 'c' is unreachable/.test(e)), 'c should not be double-reported');
});

test('lintDef warns about a non-terminal step whose output nothing consumes', () => {
  const def = buildDef({
    name: 'deadend',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'a', consumes: ['seed'], produces: ['useful', 'orphan'] },
      { name: 'b', consumes: ['useful'], produces: ['final'], terminal: true },
    ],
  });
  const { errors, warnings } = lintDef(def);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("step 'a' produces 'orphan' but nothing consumes it")), warnings.join('; '));
  assert.equal(warnings.filter((w) => w.includes('orphan')).length, 1, 'exactly one warning for orphan');
});

test('lintDef does not warn about unconsumed outputs on a terminal step', () => {
  const def = buildDef({
    name: 'terminal-sink',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'a', consumes: ['seed'], produces: ['plan'] },
      { name: 'b', consumes: ['plan'], produces: ['done'], terminal: true },
    ],
  });
  const { warnings } = lintDef(def);
  assert.deepEqual(warnings, []);
});

test('lintDef does not double-report: a dangling-consume step is not also reported as unreachable', () => {
  const def = buildDef({
    name: 'dangle-not-double',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'a', consumes: ['seed'], produces: ['mid'] },
      { name: 'b', consumes: ['nope'], produces: ['out'], terminal: true }, // dangling: 'nope' has no producer
    ],
  });
  const { errors } = lintDef(def);
  const danglingErrors = errors.filter((e) => e.includes("nothing produces 'nope'"));
  const reachErrors = errors.filter((e) => /step 'b' is unreachable/.test(e));
  assert.equal(danglingErrors.length, 1, 'exactly one dangling-consume error');
  assert.equal(reachErrors.length, 0, 'no reachability error for the same step');
});

test('lintDef on the delivery example: no errors, no warnings', () => {
  const { errors, warnings } = lintDef(parseDef(delivery));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// ---- invariant parsing tests (§3.1 of the declared-invariants build plan) ---

// A minimal base def for invariant tests
const baseInvariantRaw = {
  name: 'inv-base',
  inputs: [{ name: 'proposal' }],
  steps: [
    { name: 'planner', consumes: ['proposal'], produces: ['plan'] },
    { name: 'merger', consumes: ['plan'], produces: ['merge'], terminal: true },
  ],
};

// §3.1 test 1: valid invariant round-trips
test('buildDef: valid invariant round-trips — carries name/requires/when; description absent', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [
      {
        name: 'plan-must-be-green-when-done',
        when: { state: 'done' },
        requires: { path: 'plan', is: 'green' },
      },
    ],
  };
  const def = buildDef(raw);
  assert.ok(def.invariants !== undefined, 'invariants should be present');
  assert.equal(def.invariants!.length, 1);
  const inv = def.invariants![0]!;
  assert.equal(inv.name, 'plan-must-be-green-when-done');
  assert.deepEqual(inv.when, { state: 'done' });
  assert.deepEqual(inv.requires, { path: 'plan', is: 'green' });
  assert.equal(inv.description, undefined);
});

// §3.1 test 2: missing `requires` → DefError /requires/
test('buildDef: missing requires → DefError matching /requires/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [{ name: 'broken' }],
  };
  assert.throws(() => buildDef(raw), (e: unknown) => e instanceof DefError && /requires/.test((e as Error).message));
});

// §3.1 test 3: invalid `is` literal → DefError /must be one of/
test('buildDef: invalid is literal → DefError /must be one of/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [{ name: 'bad-is', requires: { path: 'plan', is: 'done' } }],
  };
  assert.throws(() => buildDef(raw), (e: unknown) => e instanceof DefError && /must be one of/.test((e as Error).message));
});

// §3.1 test 4: predicate with two discriminants (path + all) → DefError /exactly one of/
test('buildDef: predicate with two discriminants → DefError /exactly one of/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [{ name: 'multi-disc', requires: { path: 'plan', all: [], is: 'green' } }],
  };
  assert.throws(() => buildDef(raw), (e: unknown) => e instanceof DefError && /exactly one of/.test((e as Error).message));
});

// §3.1 test 5: predicate with no discriminants ({}) → DefError /exactly one of.*got none/
test('buildDef: predicate with no discriminants → DefError /exactly one of.*got none/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [{ name: 'no-disc', requires: {} }],
  };
  assert.throws(() => buildDef(raw), (e: unknown) => e instanceof DefError && /exactly one of/.test((e as Error).message) && /got none/.test((e as Error).message));
});

// §3.1 test 6: `all` not an array → DefError /must be an array/
test('buildDef: all not an array → DefError /must be an array/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [{ name: 'bad-all', requires: { all: 'not-an-array' } }],
  };
  assert.throws(() => buildDef(raw), (e: unknown) => e instanceof DefError && /must be an array/.test((e as Error).message));
});

// §3.1 test 7: `any` not an array → DefError /must be an array/
test('buildDef: any not an array → DefError /must be an array/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [{ name: 'bad-any', requires: { any: 42 } }],
  };
  assert.throws(() => buildDef(raw), (e: unknown) => e instanceof DefError && /must be an array/.test((e as Error).message));
});

// §3.1 test 8: unknown stem → parseDef throws DefError /unknown stem 'nonexistent'/
test('parseDef: invariant referencing unknown stem → DefError /unknown stem/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [{ name: 'bad-stem', requires: { path: 'nonexistent', is: 'green' } }],
  };
  assert.throws(
    () => parseDef(raw),
    (e: unknown) => e instanceof DefError && /unknown stem 'nonexistent'/.test((e as Error).message),
  );
});

// §3.1 test 9: duplicate invariant names → parseDef throws DefError /declared more than once/
test('parseDef: duplicate invariant names → DefError /declared more than once/', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [
      { name: 'dup', requires: { path: 'plan', is: 'green' } },
      { name: 'dup', requires: { path: 'merge', is: 'green' } },
    ],
  };
  assert.throws(
    () => parseDef(raw),
    (e: unknown) => e instanceof DefError && /declared more than once/.test((e as Error).message),
  );
});

// §3.1 test 10: invariants: [] is valid; def.invariants absent/empty
test('buildDef: invariants empty array → def.invariants absent (not set)', () => {
  const raw = { ...baseInvariantRaw, invariants: [] };
  const def = buildDef(raw);
  // parseInvariants returns [] which has length 0, so invariants not set
  assert.ok(def.invariants === undefined || def.invariants.length === 0, 'invariants should be absent or empty');
});

// §3.1 test 11: nested not/all round-trips (deep-equal)
test('buildDef: nested not/all predicate round-trips (deep-equal)', () => {
  const raw = {
    ...baseInvariantRaw,
    invariants: [
      {
        name: 'complex',
        requires: {
          not: {
            all: [
              { path: 'plan', is: 'owed' },
              { any: [{ path: 'merge', is: 'skipped' }, { state: 'done' }] },
            ],
          },
        },
      },
    ],
  };
  const def = buildDef(raw);
  assert.deepEqual(def.invariants![0]!.requires, {
    not: {
      all: [
        { path: 'plan', is: 'owed' },
        { any: [{ path: 'merge', is: 'skipped' }, { state: 'done' }] },
      ],
    },
  });
});

// ---- generates: key tests -------------------------------------------------------

// A minimal workflow fixture for generates: tests
const baseWithGenerates = {
  name: 'audited',
  inputs: [{ name: 'proposal' }],
  steps: [
    {
      name: 'planner',
      consumes: ['proposal'],
      produces: ['plan'],
      generates: ['audit_log'],
      body: 'plan it',
    },
    { name: 'builder', consumes: ['plan'], produces: ['final'], terminal: true },
  ],
};

// Test 1: generates: bare strings parse like produces; stem unioned into step.produces
test('generates: bare string parses like produces; stem is in step.generates and step.produces', () => {
  const d = buildDef(baseWithGenerates);
  const planner = d.steps[0]!;
  assert.ok(planner.generates !== undefined, 'generates should be set');
  assert.equal(planner.generates![0]!.stem, 'audit_log');
  // unioned into produces
  assert.ok(planner.produces.some((p) => p.stem === 'audit_log'), 'audit_log should be in produces');
  // produces-only also present
  assert.ok(planner.produces.some((p) => p.stem === 'plan'), 'plan should be in produces');
  assert.equal(planner.produces.length, 2); // plan + audit_log
});

// Test 2: generates: [{name, schema}] attaches a schema
test('generates: { name, schema } attaches a schema to the ProducePattern', () => {
  const d = buildDef({
    name: 'schemagen',
    inputs: [{ name: 'q' }],
    steps: [
      {
        name: 'gen',
        consumes: ['q'],
        generates: [{ name: 'report', schema: { type: 'object' } }],
        terminal: true,
        body: '',
      },
    ],
  });
  const g = d.steps[0]!.generates![0]!;
  assert.equal(g.stem, 'report');
  assert.deepEqual(g.schema, { type: 'object' });
});

// Test 3: generates: ['audit.log[]'] parses as collection kind
test('generates: collection pattern parses as collection kind', () => {
  const d = buildDef({
    name: 'collgen',
    inputs: [{ name: 'q' }],
    steps: [
      {
        name: 'gen',
        consumes: ['q'],
        generates: ['audit.log[]'],
        terminal: true,
        body: '',
      },
    ],
  });
  const g = d.steps[0]!.generates![0]!;
  assert.equal(g.kind, 'collection');
  assert.equal(g.stem, 'audit.log');
});

// Test 4: generates: [] leaves step.generates absent
test('generates: empty array leaves step.generates unset', () => {
  const d = buildDef({
    name: 'emptygens',
    inputs: [{ name: 'q' }],
    steps: [
      { name: 'a', consumes: ['q'], generates: [], produces: ['out'], terminal: true },
    ],
  });
  assert.ok(d.steps[0]!.generates === undefined, 'generates should be absent for empty array');
});

// Test 5: generates: invalid entry throws DefError
test('generates: invalid entry (non-string/non-object) throws DefError', () => {
  assert.throws(
    () => buildDef({
      name: 'bad',
      inputs: [{ name: 'q' }],
      steps: [{ name: 'a', consumes: ['q'], generates: [42], terminal: true }],
    }),
    (e: unknown) => e instanceof DefError && /must be a string or a \{ name, schema, judges \} mapping/.test((e as Error).message),
  );
});

// Test 6: same stem in both produces: and generates: → hard error mentioning "produces: and generates:"
test('validateDef: same stem in both produces: and generates: → hard error', () => {
  const errors = validateDef(buildDef({
    name: 'conflict',
    inputs: [{ name: 'q' }],
    steps: [
      {
        name: 'gen',
        consumes: ['q'],
        produces: ['audit_log'],
        generates: ['audit_log'],
        terminal: true,
      },
    ],
  }));
  assert.ok(
    errors.some((e) => e.includes("produces: and generates:")),
    `expected same-stem-in-both error; got: ${errors.join('; ')}`,
  );
});

// Test 7: two steps generating the same stem → one-writer error
test('validateDef: two steps generating the same stem → one-writer error', () => {
  const errors = validateDef(buildDef({
    name: 'twogens',
    inputs: [{ name: 'q' }],
    steps: [
      { name: 'a', consumes: ['q'], generates: ['audit_log'], produces: ['out_a'], terminal: true },
      { name: 'b', consumes: ['q'], generates: ['audit_log'], produces: ['out_b'], terminal: true },
    ],
  }));
  assert.ok(
    errors.some((e) => e.includes('two producers') && e.includes('audit_log')),
    `expected one-writer error for audit_log; got: ${errors.join('; ')}`,
  );
});

// Test 8: generates: map output without a map consume → map-shape error
test('validateDef: generates map output without a map consume → map-shape error', () => {
  const errors = validateDef(buildDef({
    name: 'badmapgen',
    inputs: [{ name: 'q' }],
    steps: [
      // A non-map step that generates a per-element output — not allowed
      { name: 'a', consumes: ['q'], generates: ['col[$i].check'], produces: ['out'], terminal: true },
    ],
  }));
  assert.ok(
    errors.some((e) => /no map \(\$i\) consume to bind it/.test(e)),
    `expected map-shape error; got: ${errors.join('; ')}`,
  );
});

// Test 9: a generated unconsumed stem yields NO dead-end warning
test('lintDef: a generated unconsumed stem yields no dead-end warning', () => {
  const { errors, warnings } = lintDef(buildDef(baseWithGenerates));
  assert.deepEqual(errors, []);
  // audit_log is generated and unconsumed — no warning for it
  assert.ok(
    !warnings.some((w) => w.includes('audit_log')),
    `unexpected warning for audit_log; got: ${warnings.join('; ')}`,
  );
});

// Test 10: a produced unconsumed stem on the same step still warns while the generated one does not
test('lintDef: produced unconsumed stem still warns on same step as generates:', () => {
  const { errors, warnings } = lintDef(buildDef({
    name: 'mixed-orphan',
    inputs: [{ name: 'q' }],
    steps: [
      {
        name: 'gen',
        consumes: ['q'],
        produces: ['plan', 'orphan'],   // orphan: produced but not consumed
        generates: ['audit_log'],       // audit_log: generated, no consumer expected
        body: '',
      },
      { name: 'use', consumes: ['plan'], produces: ['final'], terminal: true },
    ],
  }));
  assert.deepEqual(errors, []);
  // 'orphan' is produced (not generated) and unconsumed → should warn
  assert.ok(
    warnings.some((w) => w.includes("'orphan'")),
    `expected warning for orphan; got: ${warnings.join('; ')}`,
  );
  // 'audit_log' is generated (unconsumed but exempt) → should NOT warn
  assert.ok(
    !warnings.some((w) => w.includes('audit_log')),
    `unexpected warning for audit_log; got: ${warnings.join('; ')}`,
  );
});

// Test 11: the dead-end warning message references `generates:`
test('lintDef: dead-end warning message mentions generates:', () => {
  const { warnings } = lintDef(buildDef({
    name: 'warnmsg',
    inputs: [{ name: 'q' }],
    steps: [
      { name: 'a', consumes: ['q'], produces: ['orphan'], body: '' },
      { name: 'b', consumes: ['q'], produces: ['final'], terminal: true },
    ],
  }));
  assert.ok(
    warnings.some((w) => /generates:/.test(w)),
    `expected warning mentioning generates:; got: ${warnings.join('; ')}`,
  );
});

// Test 12: terminal: true still suppresses everything (generates is additive)
test('lintDef: terminal: true suppresses all dead-end warnings even when generates: is also set', () => {
  const { warnings } = lintDef(buildDef({
    name: 'terminal-gen',
    inputs: [{ name: 'q' }],
    steps: [
      {
        name: 'a',
        consumes: ['q'],
        produces: ['final', 'extra'],
        generates: ['audit_log'],
        terminal: true,
        body: '',
      },
    ],
  }));
  assert.deepEqual(warnings, []);
});

// ---- outputs: key tests ------------------------------------------------------

// A minimal workflow fixture for outputs: tests
// reporter produces 'summary' (via produces:) and 'audit_log' (via generates:)
// 'summary' is declared in workflow-level outputs:
const baseWithOutputs = {
  name: 'report',
  inputs: [{ name: 'proposal' }],
  outputs: ['summary'],
  steps: [
    { name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'plan it' },
    { name: 'reporter', consumes: ['plan'], produces: ['summary'], generates: ['audit_log'], body: 'report it' },
  ],
};

// Test (pre-a): def.outputs is present and equals ['summary']
test('outputs: buildDef sets def.outputs to the declared list', () => {
  const d = buildDef(baseWithOutputs);
  assert.deepEqual(d.outputs, ['summary']);
});

// Test (pre-b): outputs: [] leaves def.outputs absent
test('outputs: empty array leaves def.outputs absent', () => {
  const d = buildDef({
    name: 'no-outs',
    inputs: [{ name: 'q' }],
    outputs: [],
    steps: [{ name: 'a', consumes: ['q'], produces: ['out'], terminal: true, body: '' }],
  });
  assert.ok(d.outputs === undefined, 'def.outputs should be absent for empty array');
});

// Test (a): outputs:-listed unconsumed leaf produces NO dead-end warning
test('lintDef: outputs:-listed unconsumed stem is exempt from dead-end warnings', () => {
  const { warnings } = lintDef(buildDef(baseWithOutputs));
  assert.ok(
    !warnings.some((w) => w.includes('summary')),
    `expected no warning for 'summary'; got: ${warnings.join('; ')}`,
  );
});

// Test (b): unlisted unconsumed leaf STILL warns; listed one does not
test('lintDef: unlisted unconsumed stem still warns; outputs:-listed one does not', () => {
  const { warnings } = lintDef(buildDef({
    name: 'partial',
    inputs: [{ name: 'proposal' }],
    outputs: ['summary'],
    steps: [
      { name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'plan it' },
      { name: 'reporter', consumes: ['plan'], produces: ['summary', 'orphan'], body: 'report it' },
    ],
  }));
  assert.ok(
    warnings.some((w) => w.includes('orphan')),
    `expected warning for 'orphan'; got: ${warnings.join('; ')}`,
  );
  assert.ok(
    !warnings.some((w) => w.includes('summary')),
    `expected no warning for 'summary'; got: ${warnings.join('; ')}`,
  );
});

// Test (c): all three exemptions coexist (terminal:, generates:, outputs:)
test('lintDef: terminal:, generates:, and outputs: exemptions all active simultaneously', () => {
  const { warnings } = lintDef(buildDef({
    name: 'all-exempt',
    inputs: [{ name: 'q' }],
    outputs: ['summary'],
    steps: [
      { name: 'sink', consumes: ['q'], produces: ['final'], terminal: true, body: '' },
      { name: 'gen', consumes: ['q'], produces: ['plan'], generates: ['audit_log'], terminal: true, body: '' },
      { name: 'pub', consumes: ['q'], produces: ['summary'], body: '' },
    ],
  }));
  assert.deepEqual(warnings, []);
});

// Test (d): outputs: entry naming a stem no step produces → hard validateDef error
test('validateDef: outputs: entry naming an unproduced stem is a hard error', () => {
  const errors = validateDef(buildDef({
    name: 'bad-out',
    inputs: [{ name: 'q' }],
    outputs: ['nonexistent'],
    steps: [{ name: 'a', consumes: ['q'], produces: ['out'], terminal: true, body: '' }],
  }));
  assert.ok(
    errors.some((e) => e.includes('outputs:') && e.includes('nonexistent')),
    `expected hard error for 'nonexistent'; got: ${errors.join('; ')}`,
  );
});

// Test (e): outputs: entry naming a generates: stem → VALID (no error, no warning)
test('validateDef + lintDef: outputs: naming a generates: stem is valid', () => {
  const d = buildDef({
    name: 'gen-out',
    inputs: [{ name: 'q' }],
    outputs: ['audit_log'],
    steps: [
      { name: 'a', consumes: ['q'], generates: ['audit_log'], produces: ['out'], terminal: true, body: '' },
    ],
  });
  assert.deepEqual(validateDef(d), []);
  const { warnings } = lintDef(d);
  assert.ok(
    !warnings.some((w) => w.includes('audit_log')),
    `expected no warning for 'audit_log'; got: ${warnings.join('; ')}`,
  );
});

// Test (f): outputs: naming an input stem (not produced by any step) → hard error
test('validateDef: outputs: entry naming an input stem is a hard error', () => {
  const errors = validateDef(buildDef({
    name: 'input-out',
    inputs: [{ name: 'proposal' }],
    outputs: ['proposal'],
    steps: [{ name: 'a', consumes: ['proposal'], produces: ['result'], terminal: true, body: '' }],
  }));
  assert.ok(
    errors.some((e) => e.includes('outputs:') && e.includes('proposal')),
    `expected hard error for input stem 'proposal'; got: ${errors.join('; ')}`,
  );
});

// Test (g): dead-end warning message mentions outputs: as a remedy
test('lintDef: dead-end warning message mentions outputs:', () => {
  const { warnings } = lintDef(buildDef({
    name: 'warn-msg',
    inputs: [{ name: 'q' }],
    steps: [
      { name: 'a', consumes: ['q'], produces: ['orphan'], body: '' },
      { name: 'b', consumes: ['q'], produces: ['final'], terminal: true },
    ],
  }));
  assert.ok(
    warnings.some((w) => /outputs:/.test(w)),
    `expected warning mentioning outputs:; got: ${warnings.join('; ')}`,
  );
});

// ---- (f) on: firing-trigger validation ----------------------------------------

// (f1) on: ['idle'] without idleAfter → hard error (idleAfter is required for idle trigger)
test('parseDef: on: [idle] without idleAfter is a hard validateDef error', () => {
  // buildDef succeeds (no throw from buildStep) but validateDef reports the cross-check error
  const d = buildDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [{ name: 'a', consumes: ['seed'], produces: ['out'], on: ['idle'] }],
  });
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('idle') && e.includes('idleAfter')),
    `expected error about idle missing idleAfter; errors: ${errors.join('; ')}`,
  );
});

// (f2) on: ['unknown_token'] → hard error
test('parseDef: on: [unknown_token] is a hard error', () => {
  assert.throws(
    () => parseDef({
      name: 'wf',
      inputs: [{ name: 'seed' }],
      steps: [{ name: 'a', consumes: ['seed'], produces: ['out'], on: ['unknown_token'] }],
    }),
    DefError,
  );
});

// (f3) on: [] → hard error 'must not be empty'
test('parseDef: on: [] is a hard error (must not be empty)', () => {
  assert.throws(
    () => parseDef({
      name: 'wf',
      inputs: [{ name: 'seed' }],
      steps: [{ name: 'a', consumes: ['seed'], produces: ['out'], on: [] }],
    }),
    (e: unknown) => {
      assert.ok(e instanceof DefError);
      assert.ok((e as Error).message.includes('empty') || (e as Error).message.includes('must not be empty'));
      return true;
    },
  );
});

// (f4) on: ['inputsGreen'] → valid
test('parseDef: on: [inputsGreen] is valid', () => {
  const d = parseDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [{ name: 'a', consumes: ['seed'], produces: ['out'], on: ['inputsGreen'] }],
  });
  assert.deepEqual(d.steps[0]!.on, ['inputsGreen']);
});

// (f5) on: ['allGreen'] → valid (evaluator with generates: so no dead-end warning)
test('parseDef: on: [allGreen] is valid', () => {
  const d = parseDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'planner', consumes: ['seed'], produces: ['plan'] },
      { name: 'eval', on: ['allGreen'], generates: ['outcome'], consumes: [], body: '' },
    ],
  });
  assert.deepEqual(d.steps[1]!.on, ['allGreen']);
});

// (f6) on: omitted → valid (default behaviour — on is undefined)
test('parseDef: on: omitted → valid, on is undefined', () => {
  const d = parseDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [{ name: 'a', consumes: ['seed'], produces: ['out'] }],
  });
  assert.equal(d.steps[0]!.on, undefined);
});

// (f7) on: ['idle'] without idleAfter → validateDef error
test('parseDef: on: [idle] without idleAfter → validateDef error', () => {
  const d = buildDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [{ name: 'a', consumes: ['seed'], produces: ['out'], on: ['idle'] }],
  });
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('idle') && e.includes('idleAfter')),
    `expected cross-check error about idle missing idleAfter; errors: ${errors.join('; ')}`,
  );
});

// (f8) idleAfter set without idle in on: → validateDef error
test('parseDef: idleAfter set but idle not in on: → validateDef error', () => {
  const d = buildDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [{ name: 'a', consumes: ['seed'], produces: ['out'], idleAfter: '30m' }],
  });
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes('idleAfter') && e.includes('idle')),
    `expected cross-check error about idleAfter without idle; errors: ${errors.join('; ')}`,
  );
});

// (f9) on: ['idle'], idleAfter: '30m' → valid (no error)
test('parseDef: on: [idle] with idleAfter is valid', () => {
  const d = parseDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'planner', consumes: ['seed'], produces: ['plan'] },
      { name: 'eval', on: ['idle'], idleAfter: '30m', generates: ['outcome'], consumes: [], body: '' },
    ],
  });
  assert.deepEqual(d.steps[1]!.on, ['idle']);
  assert.equal(d.steps[1]!.idleAfter, '30m');
  assert.equal(d.steps[1]!.idleAfterMs, 30 * 60 * 1000);
});

// (f10) on: ['allGreen', 'idle'], idleAfter: '2h' → valid (combined evaluator)
test('parseDef: on: [allGreen, idle] with idleAfter is valid', () => {
  const d = parseDef({
    name: 'wf',
    inputs: [{ name: 'seed' }],
    steps: [
      { name: 'planner', consumes: ['seed'], produces: ['plan'] },
      { name: 'eval', on: ['allGreen', 'idle'], idleAfter: '2h', generates: ['outcome'], consumes: [], body: '' },
    ],
  });
  assert.deepEqual(d.steps[1]!.on, ['allGreen', 'idle']);
  assert.equal(d.steps[1]!.idleAfterMs, 2 * 60 * 60 * 1000);
});

// (f11) on: ['unknown_token'] → hard DefError from buildStep (unchanged)
test('parseDef: on: [unknown_token] is a hard error (unchanged)', () => {
  assert.throws(
    () => parseDef({
      name: 'wf',
      inputs: [{ name: 'seed' }],
      steps: [{ name: 'a', consumes: ['seed'], produces: ['out'], on: ['totally_unknown'] }],
    }),
    DefError,
  );
});

// ---- D-D named-handler validateDef tests -------------------------------------

test('D-D: non-existent handler → validateDef error', () => {
  const d = def('test', [input('x')], [
    step({ name: 'worker', consumes: ['x'], produces: ['out'], effect: { idempotent: false, onInvalidate: 'nonexistent' } }),
  ]);
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes('does not exist') || e.includes('nonexistent')),
    `expected error about non-existent handler; errors: ${errors.join('; ')}`);
});

test('D-D: self-handler → validateDef error', () => {
  const d = def('test', [input('x')], [
    step({ name: 'worker', consumes: ['x'], produces: ['out'], effect: { idempotent: false, onInvalidate: 'worker' } }),
  ]);
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes('cannot be its own handler') || e.includes('names itself')),
    `expected error about self-handler; errors: ${errors.join('; ')}`);
});

test('D-D: handler produces nothing → validateDef error', () => {
  // Construct a handler step with no produces by using the helper and overriding produces
  const handlerStep = { ...step({ name: 'noop', consumes: [], produces: [] }), produces: [] };
  const d = def('test', [input('x')], [
    step({ name: 'worker', consumes: ['x'], produces: ['out'], effect: { idempotent: false, onInvalidate: 'noop' } }),
    handlerStep,
  ]);
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes('produces no outputs') || e.includes('at least one output')),
    `expected error about handler producing no outputs; errors: ${errors.join('; ')}`);
});

test('D-D: pin still valid (no error from named-handler check)', () => {
  const d = def('test', [input('x')], [
    step({ name: 'w', consumes: ['x'], produces: ['y'], effect: { idempotent: false, onInvalidate: 'pin' } }),
  ]);
  // pin is a built-in, must produce no error from D-D check
  const errors = validateDef(d).filter((e) => e.includes('onInvalidate') && !e.includes('terminal'));
  assert.deepEqual(errors, [], `pin must produce no onInvalidate error; errors: ${errors.join('; ')}`);
});

test('D-D: escalate still valid (no error from named-handler check)', () => {
  const d = def('test', [input('x')], [
    step({ name: 'w', consumes: ['x'], produces: ['y'], effect: { idempotent: false, onInvalidate: 'escalate' } }),
  ]);
  const errors = validateDef(d).filter((e) => e.includes('onInvalidate') && !e.includes('terminal'));
  assert.deepEqual(errors, [], `escalate must produce no onInvalidate error; errors: ${errors.join('; ')}`);
});

test('D-D: valid named-handler → no validateDef error for onInvalidate', () => {
  const d = def('test', [input('x')], [
    step({ name: 'worker', consumes: ['x'], produces: ['out'], effect: { idempotent: false, onInvalidate: 'handler' } }),
    step({ name: 'handler', consumes: ['out'], produces: ['done'] }),
  ]);
  const errors = validateDef(d).filter((e) => e.includes('onInvalidate'));
  assert.deepEqual(errors, [], `valid named handler must produce no onInvalidate error; errors: ${errors.join('; ')}`);
});

test('D-D: buildDef with valid named-handler passes (no throw)', () => {
  // buildDef no longer throws for named-handler strings; defers to validateDef.
  assert.doesNotThrow(() => {
    buildDef({
      name: 'test',
      inputs: [{ name: 'x' }],
      steps: [
        { name: 'worker', consumes: ['x'], produces: ['out'], effect: { onInvalidate: 'handler' } },
        { name: 'handler', consumes: ['out'], produces: ['done'] },
      ],
    });
  }, 'buildDef must not throw for a valid named-handler string');
});

// ---- M2-GRAMMAR: calls: parsing + validation + cycle tests -------------------

test('parseDef: calls: step sets calls and callsInputs fields', () => {
  const d = parseDef({
    name: 'parent',
    inputs: [{ name: 'proposal' }],
    steps: [
      { name: 'deliver', calls: 'delivery', inputs: { proposal: 'proposal' }, produces: ['delivered'] },
      { name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true },
    ],
  });
  const deliverStep = d.steps.find((l) => l.name === 'deliver');
  assert.ok(deliverStep !== undefined, 'deliver step must exist');
  assert.equal(deliverStep.calls, 'delivery');
  assert.deepEqual(deliverStep.callsInputs, { proposal: 'proposal' });
  assert.equal(deliverStep.body, '', 'calls: step must have empty body');
  assert.equal(deliverStep.produces.length, 1, 'calls: step must produce exactly one artifact');
  assert.equal(deliverStep.produces[0]!.stem, 'delivered');
  assert.deepEqual(deliverStep.consumes, [], 'calls: step must have no consumes');
});

test('validateDef: calls: step must produce exactly one output — zero outputs errors', () => {
  const d = buildDef({
    name: 'parent',
    inputs: [{ name: 'proposal' }],
    steps: [
      // calls: step with zero produces — should be caught by validateDef
      // We bypass buildStep by using a hack: we build a def with a calls: step then remove produces
      { name: 'deliver', calls: 'delivery', inputs: {}, produces: ['delivered'] },
      { name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true },
    ],
  });
  // Manually zero out the produces to trigger the error
  const deliverStep = d.steps.find((l) => l.name === 'deliver')!;
  deliverStep.produces = [];
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes('exactly one output')), `Expected 'exactly one output' error; got: ${errors.join('; ')}`);
});

test('validateDef: calls: step must produce exactly one output — two outputs errors', () => {
  const d = buildDef({
    name: 'parent',
    inputs: [{ name: 'proposal' }],
    steps: [
      { name: 'deliver', calls: 'delivery', inputs: {}, produces: ['delivered'] },
      { name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true },
    ],
  });
  const deliverStep = d.steps.find((l) => l.name === 'deliver')!;
  // Inject a second produce manually
  deliverStep.produces = [deliverStep.produces[0]!, parseProduce('extra')];
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes('exactly one output')), `Expected 'exactly one output' error; got: ${errors.join('; ')}`);
});

test('validateDef: calls: step callsInputs value must be a real parent artifact', () => {
  const d = buildDef({
    name: 'parent',
    inputs: [{ name: 'proposal' }],
    steps: [
      { name: 'deliver', calls: 'delivery', inputs: { proposal: 'nonexistent_artifact' }, produces: ['delivered'] },
      { name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true },
    ],
  });
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes("parent artifact 'nonexistent_artifact'")),
    `Expected parent artifact error; got: ${errors.join('; ')}`,
  );
});

test('loadDefs: calls target must exist in resolver namespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-defs-test-'));
  try {
    writeFileSync(
      join(dir, 'parent.yaml'),
      [
        'name: parent',
        'inputs:',
        '  - name: proposal',
        '    seedOwed: true',
        'steps:',
        '  - name: deliver',
        '    calls: does-not-exist',
        '    produces: [delivered]',
        '  - name: teardown',
        '    consumes: [delivered]',
        '    produces: [done]',
        '    terminal: true',
      ].join('\n'),
    );
    assert.throws(
      () => loadDefs(dir),
      (err: unknown) => {
        assert.ok(err instanceof DefError, `expected DefError, got ${err}`);
        assert.ok(
          /does-not-exist.*does not exist/.test(err.message),
          `expected missing-target error; got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDefs: calls: inputs key must be a declared child input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-defs-test-'));
  try {
    // Write child def with no inputs
    writeFileSync(
      join(dir, 'child.yaml'),
      [
        'name: child',
        'steps:',
        '  - name: worker',
        '    produces: [result]',
        '    body: do work',
      ].join('\n'),
    );
    // Write parent that maps 'proposal' -> child input that does not exist
    writeFileSync(
      join(dir, 'parent.yaml'),
      [
        'name: parent',
        'inputs:',
        '  - name: proposal',
        '    seedOwed: true',
        'steps:',
        '  - name: deliver',
        '    calls: child',
        '    inputs:',
        '      proposal: proposal',
        '    produces: [delivered]',
        '  - name: teardown',
        '    consumes: [delivered]',
        '    produces: [done]',
        '    terminal: true',
      ].join('\n'),
    );
    assert.throws(
      () => loadDefs(dir),
      (err: unknown) => {
        assert.ok(err instanceof DefError, `expected DefError, got ${err}`);
        assert.ok(
          /maps input 'proposal'.*does not declare/.test(err.message),
          `expected child-input error; got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectCallsCycles: A calls B calls A errors with cycle message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-defs-test-'));
  try {
    writeFileSync(
      join(dir, 'a.yaml'),
      [
        'name: a',
        'outputs: [result]',
        'steps:',
        '  - name: delegate',
        '    calls: b',
        '    produces: [result]',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'b.yaml'),
      [
        'name: b',
        'outputs: [result]',
        'steps:',
        '  - name: delegate',
        '    calls: a',
        '    produces: [result]',
      ].join('\n'),
    );
    assert.throws(
      () => loadDefs(dir),
      (err: unknown) => {
        assert.ok(err instanceof DefError, `expected DefError, got ${err}`);
        assert.ok(
          /calls cycle:/.test(err.message),
          `expected calls-cycle error; got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectCallsCycles: A calls B (acyclic) passes without error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-defs-test-'));
  try {
    writeFileSync(
      join(dir, 'b.yaml'),
      [
        'name: b',
        'outputs: [result]',
        'steps:',
        '  - name: worker',
        '    produces: [result]',
        '    body: do work',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'a.yaml'),
      [
        'name: a',
        'steps:',
        '  - name: delegate',
        '    calls: b',
        '    produces: [delegated]',
        '  - name: sink',
        '    consumes: [delegated]',
        '    produces: [done]',
        '    terminal: true',
        '    body: done',
      ].join('\n'),
    );
    assert.doesNotThrow(() => loadDefs(dir), 'acyclic A -> B calls chain must not throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('include cycle and calls cycle are detected independently', () => {
  // Calls cycle: a calls b calls a
  const callsDir = mkdtempSync(join(tmpdir(), 'owenloop-defs-test-'));
  try {
    writeFileSync(
      join(callsDir, 'a.yaml'),
      ['name: a', 'outputs: [r]', 'steps:', '  - name: d', '    calls: b', '    produces: [r]'].join('\n'),
    );
    writeFileSync(
      join(callsDir, 'b.yaml'),
      ['name: b', 'outputs: [r]', 'steps:', '  - name: d', '    calls: a', '    produces: [r]'].join('\n'),
    );
    let callsCycleErr: Error | undefined;
    try { loadDefs(callsDir); } catch (e) { callsCycleErr = e as Error; }
    assert.ok(callsCycleErr instanceof DefError, 'calls cycle must throw DefError');
    assert.ok(/calls cycle:/.test(callsCycleErr.message), `calls cycle error must mention 'calls cycle:'; got: ${callsCycleErr.message}`);
    assert.ok(!/include cycle:/.test(callsCycleErr.message), 'calls cycle error must NOT say include cycle');
  } finally {
    rmSync(callsDir, { recursive: true, force: true });
  }

  // Include cycle: a includes b includes a — must produce a different error
  const includeDir = mkdtempSync(join(tmpdir(), 'owenloop-defs-test-'));
  try {
    writeFileSync(
      join(includeDir, 'a.yaml'),
      ['name: a', 'steps:', '  - include: b', '    as: bpart'].join('\n'),
    );
    writeFileSync(
      join(includeDir, 'b.yaml'),
      ['name: b', 'steps:', '  - include: a', '    as: apart'].join('\n'),
    );
    let includeCycleErr: Error | undefined;
    try { loadDefs(includeDir); } catch (e) { includeCycleErr = e as Error; }
    assert.ok(includeCycleErr instanceof DefError, 'include cycle must throw DefError');
    assert.ok(/include cycle:/.test(includeCycleErr.message), `include cycle error must mention 'include cycle:'; got: ${includeCycleErr.message}`);
    assert.ok(!/calls cycle:/.test(includeCycleErr.message), 'include cycle error must NOT say calls cycle');
  } finally {
    rmSync(includeDir, { recursive: true, force: true });
  }
});

test('loadDefs end-to-end on examples/workflows yields provisioned-delivery and delivery side by side', () => {
  const examplesDir = join(new URL('..', import.meta.url).pathname, 'examples', 'workflows');
  const defs = loadDefs(examplesDir);
  assert.ok(defs.has('delivery'), 'delivery must be in the loaded defs');
  assert.ok(defs.has('provisioned-delivery'), 'provisioned-delivery must be in the loaded defs');
  const pd = defs.get('provisioned-delivery')!;
  const deliverStep = pd.steps.find((l) => l.name === 'deliver');
  assert.ok(deliverStep !== undefined, 'provisioned-delivery must have a deliver step');
  assert.equal(deliverStep.calls, 'delivery', 'deliver step must call delivery');
  assert.deepEqual(deliverStep.callsInputs, { proposal: 'proposal' });
});

// ---- §27: engine: version + unknown-key rejection -------------------------

test('§27 (1) engine: omitted defaults to SUPPORTED_ENGINE_VERSION', () => {
  const parsed = parseDef(delivery);
  assert.equal(parsed.engine, 1);
});

test('§27 (2) engine: 1 (the supported version) is accepted', () => {
  const parsed = parseDef({ ...delivery, engine: 1 });
  assert.equal(parsed.engine, 1);
});

test('§27 (3) engine: 2 (an unsupported version) throws DefError', () => {
  assert.throws(
    () => buildDef({ ...delivery, engine: 2 }),
    (e: unknown) =>
      e instanceof DefError &&
      /requires engine version 2/.test((e as Error).message) &&
      /only supports up to 1/.test((e as Error).message) &&
      /upgrade owenloop/.test((e as Error).message),
  );
});

test('§27 (4) engine: 0 (non-positive) throws DefError', () => {
  assert.throws(
    () => buildDef({ ...delivery, engine: 0 }),
    (e: unknown) => e instanceof DefError && /positive integer/.test((e as Error).message),
  );
});

test('§27 (5) engine: -1 (negative) throws DefError', () => {
  assert.throws(
    () => buildDef({ ...delivery, engine: -1 }),
    (e: unknown) => e instanceof DefError && /positive integer/.test((e as Error).message),
  );
});

test('§27 (6) engine: 1.5 (non-integer) throws DefError', () => {
  assert.throws(
    () => buildDef({ ...delivery, engine: 1.5 }),
    (e: unknown) => e instanceof DefError && /positive integer/.test((e as Error).message),
  );
});

test('§27 (7) engine: "1" (a string, wrong type) throws DefError', () => {
  assert.throws(
    () => buildDef({ ...delivery, engine: '1' }),
    (e: unknown) => e instanceof DefError && /positive integer/.test((e as Error).message),
  );
});

test('§27 (8) unknown top-level key throws DefError naming the key', () => {
  assert.throws(
    () => buildDef({ ...delivery, bogus: true }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
});

test('§27 (9) unknown key on a normal step throws DefError naming the key', () => {
  assert.throws(
    () => buildDef({
      name: 'wf',
      inputs: [{ name: 'x' }],
      steps: [{ name: 'a', consumes: ['x'], produces: ['y'], bogus: true }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
});

test('§27 (10) unknown key on an input, a produce mapping, and a judge entry each throw DefError', () => {
  assert.throws(
    () => buildDef({
      name: 'wf',
      inputs: [{ name: 'x', bogus: true }],
      steps: [{ name: 'a', consumes: ['x'], produces: ['y'] }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
  assert.throws(
    () => buildDef({
      name: 'wf',
      inputs: [{ name: 'x' }],
      steps: [{ name: 'a', consumes: ['x'], produces: [{ name: 'y', bogus: true }] }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
  assert.throws(
    () => buildDef({
      name: 'wf',
      inputs: [{ name: 'x' }],
      steps: [{
        name: 'a',
        consumes: ['x'],
        produces: [{ name: 'y', judges: [{ name: 'j', body: 'check it', bogus: true }] }],
      }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
});

test('§27 (11) unknown key on a calls: step and on an include: directive each throw DefError, without crossing into the other shape', () => {
  // calls: step — bogus key rejected against RAW_CALLS_KEYS (a smaller shape than a normal step)
  assert.throws(
    () => buildDef({
      name: 'wf',
      outputs: ['r'],
      steps: [{ name: 'a', calls: 'other', produces: ['r'], bogus: true }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
  // calls: step must NOT accept a plain-step-only key either (e.g. body:) — the
  // discriminator-key trap: presence of `calls:` routes to RAW_CALLS_KEYS, not RAW_STEP_KEYS.
  assert.throws(
    () => buildDef({
      name: 'wf',
      outputs: ['r'],
      steps: [{ name: 'a', calls: 'other', produces: ['r'], body: 'not allowed here' }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'body'/.test((e as Error).message),
  );
  // include: directive — bogus key rejected against RAW_INCLUDE_KEYS
  assert.throws(
    () => buildDef({
      name: 'wf',
      steps: [{ include: 'other', as: 'child', bogus: true }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
});

test('§27 (12) unknown-key rejection coexists with §26 group: entries — valid group: is accepted, bogus key on a group: entry is rejected against RAW_GROUP_KEYS (not RAW_PRODUCE_KEYS)', () => {
  // A valid group: entry alongside plain produces must not be mistaken for
  // an unknown-key produce mapping.
  const parsed = parseDef({
    name: 'wf',
    inputs: [{ name: 'x' }],
    steps: [{
      name: 'a',
      consumes: ['x'],
      produces: ['simple', 'urgent', { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] }],
    }],
  });
  const step = parsed.steps.find((s) => s.name === 'a')!;
  assert.deepEqual(step.groups, [{ group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] }]);

  // A bogus key on a group: entry is rejected against RAW_GROUP_KEYS, naming
  // the offending key — not silently accepted, and not checked against
  // RAW_PRODUCE_KEYS (which has no `group`/`mode`/`of` keys at all).
  assert.throws(
    () => buildDef({
      name: 'wf',
      inputs: [{ name: 'x' }],
      steps: [{
        name: 'a',
        consumes: ['x'],
        produces: ['simple', 'urgent', { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'], bogus: true }],
      }],
    }),
    (e: unknown) => e instanceof DefError && /unknown key 'bogus'/.test((e as Error).message),
  );
});

test('§27 (13) engine: is scoped per-file — an included/called child with a different (but still supported) engine: does not inherit or conflict with the parent', () => {
  const dir = mktempDefsDir();
  try {
    writeFileSync(
      join(dir, 'child.yaml'),
      ['name: child', 'engine: 1', 'inputs:', '  - name: x', 'steps:', '  - name: a', '    consumes: [x]', '    produces: [y]'].join('\n'),
    );
    writeFileSync(
      join(dir, 'parent.yaml'),
      [
        'name: parent',
        'engine: 1',
        'steps:',
        '  - include: child',
        '    as: kid',
      ].join('\n'),
    );
    const all = loadDefs(dir);
    // Each file's own `engine:` was validated independently against SUPPORTED_ENGINE_VERSION
    // at buildDef time (per-file), before expandIncludes ever runs — expansion does not
    // re-check or propagate `engine:` at all (WorkflowDef.engine is not touched by prefixStep).
    assert.equal(all.get('parent')!.engine, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mktempDefsDir(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-defs-engine-'));
}
