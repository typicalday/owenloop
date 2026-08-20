/** Regression coverage for collection-cap reporting in modelCheck and `check`. */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { modelCheck } from '../src/model.ts';
import { def, input, step } from './helpers.ts';

const collectionFixture = def(
  'collection-cap-reachable',
  [input('start', { seedOwed: false })],
  [
    step({
      name: 'produce',
      consumes: ['start'],
      produces: ['items[]'],
      terminal: true,
      maxAttempts: 1,
      maxSchemaFailures: 0,
    }),
  ],
);

const scalarFixture = def(
  'collection-cap-scalar-control',
  [input('start', { seedOwed: false })],
  [
    step({
      name: 'produce',
      consumes: ['start'],
      produces: ['result'],
      terminal: true,
      maxAttempts: 1,
      maxSchemaFailures: 0,
    }),
  ],
);

const unreachableCollectionFixture = def(
  'collection-cap-unreachable',
  [input('start', { seedOwed: false })],
  [
    step({
      name: 'finish',
      consumes: ['start'],
      produces: ['result'],
      terminal: true,
      maxAttempts: 1,
      maxSchemaFailures: 0,
    }),
    step({ name: 'unreachable-producer', consumes: ['never'], produces: ['items[]'] }),
  ],
);

test('modelCheck: collection-cap reporting records only expanded emit/seal forks', () => {
  for (const maxCollectionSize of [0, 1, 2, 3, 4]) {
    const options = { maxCollectionSize, maxStates: 5_000, assumeProvided: true };
    const collection = modelCheck(collectionFixture, options);
    const scalar = modelCheck(scalarFixture, options);

    assert.equal(collection.collectionCapApplied, true, `collection cap ${maxCollectionSize} is reported after emit/seal expansion`);
    assert.equal(collection.maxCollectionSize, maxCollectionSize);
    assert.equal(scalar.collectionCapApplied, false, `scalar control stays unflagged at cap ${maxCollectionSize}`);
    assert.equal(scalar.maxCollectionSize, maxCollectionSize);
    assert.equal(collection.bounded, scalar.bounded, 'the reporting field does not affect bounded');
    assert.deepEqual(collection.boundsHit, scalar.boundsHit, 'the reporting field does not affect boundsHit');
    assert.equal(collection.bounded, false);
    assert.deepEqual(collection.boundsHit, []);
  }

  const unreachable = modelCheck(unreachableCollectionFixture, {
    maxCollectionSize: 4,
    maxStates: 5_000,
    assumeProvided: true,
  });
  assert.equal(unreachable.collectionCapApplied, false, 'an unexpanded collection declaration is not a cap application');
  assert.equal(unreachable.maxCollectionSize, 4);
  assert.equal(unreachable.bounded, false);
  assert.deepEqual(unreachable.boundsHit, []);
});

function writeCheckDefinition(dir: string, name: string, produces: string): void {
  writeFileSync(
    join(dir, `${name}.yaml`),
    [
      `name: ${name}`,
      'inputs:',
      '  - name: start',
      '    seedOwed: false',
      'steps:',
      '  - name: produce',
      '    consumes: [start]',
      `    produces: [${produces}]`,
      '    terminal: true',
      '    maxAttempts: 1',
      '    maxSchemaFailures: 0',
      '    body: produce',
    ].join('\n'),
  );
}

function runCheck(defs: string, ...argv: string[]): { code: number; out: string; err: string } {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-collection-cap-home-'));
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    cwd: home,
    env: { OWENLOOP_DEFS: defs, OWENLOOP_DB: join(home, 'state.db') },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('CLI check: text and JSON disclose the collection cap without changing its verdict', () => {
  const defs = mkdtempSync(join(tmpdir(), 'owenloop-collection-cap-defs-'));
  writeCheckDefinition(defs, 'collection-cap-cli', '"items[]"');
  writeCheckDefinition(defs, 'collection-cap-scalar-cli', 'result');

  const collectionText = runCheck(defs, 'check', 'collection-cap-cli', '--max-collection', '3');
  const scalarText = runCheck(defs, 'check', 'collection-cap-scalar-cli', '--max-collection', '3');
  assert.equal(collectionText.code, 0, 'the cap caveat does not change the check exit code');
  assert.equal(scalarText.code, 0, 'the scalar control retains the same exit code');
  assert.match(collectionText.out, /COLLECTION CAP APPLIED/);
  assert.match(collectionText.out, /--max-collection 3/);
  assert.doesNotMatch(collectionText.out, /SEARCH INCOMPLETE/);
  assert.doesNotMatch(scalarText.out, /COLLECTION CAP APPLIED/);

  const collectionJson = runCheck(defs, 'check', 'collection-cap-cli', '--max-collection', '3', '--format', 'json');
  const scalarJson = runCheck(defs, 'check', 'collection-cap-scalar-cli', '--max-collection', '3', '--format', 'json');
  assert.equal(collectionJson.code, 0);
  assert.equal(scalarJson.code, 0);
  assert.deepEqual(
    JSON.parse(collectionJson.out).collectionCapApplied,
    true,
    'JSON exposes the collection-cap marker',
  );
  assert.equal(JSON.parse(collectionJson.out).maxCollectionSize, 3);
  assert.equal(JSON.parse(scalarJson.out).collectionCapApplied, false, 'JSON preserves the scalar false control');
  assert.equal(JSON.parse(scalarJson.out).maxCollectionSize, 3);
});
