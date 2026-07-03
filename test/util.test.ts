import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detId, randId, parseDurationMs, parseDurationSecs, localMidnightMs } from '../src/util.ts';

test('detId is deterministic in its parts and namespaced by prefix', () => {
  assert.equal(detId('art', 'wf1', 'plan'), detId('art', 'wf1', 'plan'), 'same parts → same id');
  assert.notEqual(detId('art', 'wf1', 'plan'), detId('art', 'wf1', 'pr'), 'different parts → different id');
  assert.notEqual(detId('art', 'wf1', 'plan'), detId('task', 'wf1', 'plan'), 'prefix is part of identity');
  assert.match(detId('art', 'wf1', 'plan'), /^art_[0-9a-f]{24}$/);
  // joins parts with a space, so adjacent parts can't be confused by concatenation
  assert.notEqual(detId('art', 'a', 'bc'), detId('art', 'ab', 'c'), 'part boundaries are significant');
});

test('randId is unique per call and well-formed', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => randId('run')));
  assert.equal(ids.size, 1000, 'no collisions across 1000 ids');
  for (const id of ids) assert.match(id, /^run_[0-9a-f]{24}$/);
});

test('parseDurationMs handles every unit and the bare-seconds default', () => {
  assert.equal(parseDurationMs('2h'), 2 * 3600_000);
  assert.equal(parseDurationMs('30m'), 30 * 60_000);
  assert.equal(parseDurationMs('45s'), 45_000);
  assert.equal(parseDurationMs('45'), 45_000, 'a bare number is seconds');
  assert.equal(parseDurationMs('0s'), 0);
  assert.equal(parseDurationMs(' 90m '), 90 * 60_000, 'surrounding whitespace is trimmed');
});

test('parseDurationMs rejects garbage with a helpful message', () => {
  for (const bad of ['', 'abc', '2x', '1.5h', '-3m', '2 h']) {
    assert.throws(() => parseDurationMs(bad), /bad duration/, `'${bad}' should throw`);
  }
});

test('parseDurationSecs rounds milliseconds down to whole seconds', () => {
  assert.equal(parseDurationSecs('30m'), 1800);
  assert.equal(parseDurationSecs('2h'), 7200);
  assert.equal(parseDurationSecs('500'), 500);
});

test('localMidnightMs returns the start of the local day at or before now', () => {
  const now = new Date(2026, 5, 16, 14, 37, 12, 500).getTime(); // 16 Jun 2026 14:37 local
  const mid = localMidnightMs(now);
  const d = new Date(mid);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
  assert.ok(mid <= now && now - mid < 24 * 3600_000, 'within the same local day');
  assert.equal(d.getDate(), 16, 'same calendar day');
});

test('localMidnightMs: local semantics are a documented tradeoff, not an oversight', () => {
  // Pins the decision: this engine intentionally uses host-local midnight.
  // See the doc comment on localMidnightMs in src/util.ts and design.md
  // §12.3 for the DST / multi-host caveats this implies.
  const now = new Date(2026, 0, 1, 0, 0, 0, 0).getTime(); // exact local midnight
  assert.equal(localMidnightMs(now), now, 'exact midnight maps to itself');
});
