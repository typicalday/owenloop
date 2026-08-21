/** Regression coverage for collection-cap soundness of reported true deadlocks. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDefFile } from '../src/defs.ts';
import { modelCheck } from '../src/model.ts';

function fixture(name: string) {
  return loadDefFile(fileURLToPath(new URL(`./fixtures/${name}.yaml`, import.meta.url)));
}

const wedge = fixture('wedge');
const wedgeColl2 = fixture('wedge-coll2');
const maxStates = 2_000_000;

test('modelCheck: natural collection cap reports the promoted deadlock witnesses', () => {
  const control = modelCheck(wedge, { maxStates, assumeProvided: true });
  const collection = modelCheck(wedgeColl2, { maxStates, assumeProvided: true });

  assert.equal(control.deadlocks.length, 1);
  assert.equal(collection.deadlocks.length, 3);
  for (const report of [control, collection]) {
    assert.deepEqual(report.boundsHit, []);
    assert.equal(report.bounded, false);
    assert.equal(report.completable, false);
  }
});

test('modelCheck: non-collection deadlock control is cap-invariant', () => {
  const reports = [0, 1, 2, 3, 4].map((maxCollectionSize) =>
    modelCheck(wedge, { maxCollectionSize, maxStates, assumeProvided: true }),
  );
  const baseline = reports[0]!.deadlocks;

  for (const [index, report] of reports.entries()) {
    assert.deepEqual(report.boundsHit, [], `cap ${index} is admissible`);
    assert.equal(report.bounded, false, `cap ${index} is not bounded`);
    assert.equal(report.collectionCapApplied, false, `cap ${index} never expands a collection`);
    assert.equal(report.deadlocks.length, 1, `cap ${index} keeps the one deadlock`);
    assert.deepEqual(report.deadlocks, baseline, `cap ${index} preserves the complete deadlock output`);
  }
});

test('modelCheck: collection deadlock witness grows monotonically across admissible caps', () => {
  const reports = [0, 1, 2, 3, 4].map((maxCollectionSize) =>
    modelCheck(wedgeColl2, { maxCollectionSize, maxStates, assumeProvided: true }),
  );

  for (const [index, report] of reports.entries()) {
    assert.deepEqual(report.boundsHit, [], `cap ${index} is admissible`);
    assert.equal(report.bounded, false, `cap ${index} is not bounded`);
    assert.equal(report.collectionCapApplied, true, `cap ${index} expands a collection`);
    assert.equal(report.maxCollectionSize, index, `cap ${index} is preserved in the report`);
  }
  const counts = reports.map((report) => report.deadlocks.length);
  assert.deepEqual(counts, [1, 2, 3, 4, 5]);
  for (let index = 1; index < counts.length; index++) {
    assert.ok(counts[index]! >= counts[index - 1]!, `deadlocks do not shrink from cap ${index - 1} to ${index}`);
  }
});
