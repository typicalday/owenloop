import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReceipt } from '../src/exec/receipt.ts';
import { snapshotCommandPostrun } from '../src/shift/routing-command-postrun.ts';

const parent = { command: 'printf ok', orchestrator: 'host:42',
  workflow: 'root', run: 'run', step: 'build' };
const result = { exitCode: 0, outputHash: `sha256:${'a'.repeat(64)}`,
  stdoutBytes: 2, stderrBytes: 0, outputTail: 'ok',
  startedAt: 100, finishedAt: 101, durationMs: 1 };
const group = { scope: 'original-posix-group' as const, state: 'empty' as const };
const packet = (payload: unknown = { ok: true }) => {
  const parsed = { payload };
  return { result, receipt: buildReceipt(result, parent, parsed), parsed: {}, group };
};

test('parent snapshots the whole canonical receipt once without retaining child object references', () => {
  const request = packet({ nested: { value: 1 } });
  const snapshot = snapshotCommandPostrun(request, parent);
  (request.receipt.payload as { nested: { value: number } }).nested.value = 2;
  assert.equal((snapshot.receipt().payload as { nested: { value: number } }).nested.value, 1);
  const copy = snapshot.receipt();
  (copy.payload as { nested: { value: number } }).nested.value = 3;
  assert.equal((snapshot.receipt().payload as { nested: { value: number } }).nested.value, 1);
  assert.match(snapshot.canonical, /"value":1/);
});

test('parent refuses forged result metadata, group assertions and independent reject target', () => {
  assert.throws(() => snapshotCommandPostrun({ ...packet(), receipt: {
    ...packet().receipt, command: 'evil' } }, parent), /receipt changed/);
  assert.throws(() => snapshotCommandPostrun({ ...packet(), group: {
    scope: 'original-posix-group', state: 'unknown' } }, parent), /group unsettled/);
  assert.throws(() => snapshotCommandPostrun({ ...packet(), parsed: {
    reject: { path: 'other', text: 'bad' } } }, parent), /reject changed/);
  const legitimate = { reject: { path: 'declared', text: 'bad' } };
  assert.doesNotThrow(() => snapshotCommandPostrun({ ...packet(legitimate), parsed: {
    reject: legitimate.reject } }, parent));
  assert.throws(() => snapshotCommandPostrun({ ...packet(legitimate), parsed: {} }, parent), /reject changed/);
  assert.throws(() => snapshotCommandPostrun({ ...packet(legitimate), parsed: {
    reject: { ...legitimate.reject, path: 'other' } } }, parent), /reject changed/);
});

test('parent enforces complete canonical receipt ceiling and complete output fields', () => {
  assert.throws(() => snapshotCommandPostrun(packet({ data: 'x'.repeat(25_000_000) }), parent),
    /receipt too large/);
  assert.throws(() => snapshotCommandPostrun({ ...packet(), result: {
    ...result, exitCode: null } }, parent), /result refused/);
  assert.throws(() => snapshotCommandPostrun({ ...packet(), result: {
    ...result, payloadLine: 'unbounded' } }, parent), /result refused/);
});
