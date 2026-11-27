import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { writeCheckReportJson } from '../src/check-output.ts';
import type { CheckReport } from '../src/types.ts';

const report = {
  def: 'check-report',
  bounded: true,
  boundsHit: ['maxStates'],
  coverageIncomplete: [],
  collectionCapApplied: false,
  maxCollectionSize: 2,
  deadlocks: [],
  stallStates: Array.from({ length: 1200 }, (_, index) => ({
    path: [{ step: 'approve', key: '', outcome: 'judge-approve', path: `evidence[“${index}”]\n` }],
  })),
  stuck: [],
  completable: false,
  completePath: undefined,
  structurallyDeadSteps: [],
  unreachedSteps: ['publish'],
  invariantViolations: [],
  stats: { statesExplored: 2000, depthReached: 5 },
} satisfies CheckReport;

test('checker JSON preserves the existing bytes and awaits each chunk', async () => {
  const output: string[] = [];
  let inFlight = false;
  await writeCheckReportJson(report, async (chunk) => {
    assert.equal(inFlight, false);
    inFlight = true;
    await setImmediate();
    output.push(chunk);
    inFlight = false;
    return true;
  });
  assert.ok(output.length > 1);
  assert.ok(output.every((chunk) => chunk.length < 70 * 1024));
  assert.equal(output.join(''), JSON.stringify(report, null, 2) + '\n');
});

test('checker JSON stops sending chunks when the reader closes', async () => {
  let writes = 0;
  await writeCheckReportJson(report, async () => {
    writes++;
    return false;
  });
  assert.equal(writes, 1);
});
