import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertShiftDaemonPlatform,
  resolveCap,
  resolveStateDirOverride,
  resolveMaxConcurrentAgents,
  resolveShiftName,
  parseArgs,
} from '../src/shift/runtime.ts';

test('public Shift daemon fails explicitly on Windows while direct Shift remains the fallback', () => {
  assert.throws(
    () => assertShiftDaemonPlatform('win32'),
    /public Shift daemon is not supported on Windows.*named-pipe transport is not implemented.*use `owenloop work shift` directly/iu,
  );
  assert.doesNotThrow(() => assertShiftDaemonPlatform('darwin'));
  assert.doesNotThrow(() => assertShiftDaemonPlatform('linux'));
});

// C6 wired settings-file fallbacks into shift's cap + dir resolution. These pin
// the precedence: CLI flag > env var > settings file > built-in default.

test('resolveCap: --cap beats settings.dispatchCap beats the default 3', () => {
  assert.equal(resolveCap(7, 5), 7); // flag wins
  assert.equal(resolveCap(undefined, 5), 5); // settings when no flag
  assert.equal(resolveCap(undefined, undefined), 3); // built-in default
});

test('resolveStateDirOverride: flag > OWENLOOP_STATE_DIR > settings; else undefined', () => {
  assert.equal(resolveStateDirOverride('/flag', { OWENLOOP_STATE_DIR: '/env' }, '/settings'), '/flag');
  assert.equal(resolveStateDirOverride(undefined, { OWENLOOP_STATE_DIR: '/env' }, '/settings'), '/env');
  assert.equal(resolveStateDirOverride(undefined, {}, '/settings'), '/settings');
  assert.equal(resolveStateDirOverride(undefined, {}, undefined), undefined);
});

// WO-4.3 serve-crew SELECTION contract, pinned at the parse layer. The wire
// meaning: no flag → serveCrews undefined, which run() resolves to `[]` at the
// call site (`parsed.serveCrews ?? []`), and the hub reads empty as "serve ALL
// the actor's crews" — i.e. the default is serve-all, NOT serve-none.
test('parseArgs --work-root: REPEATABLE and accumulating, unlike every other value flag', () => {
  // Repeatable rather than comma-split, because a directory path may legally
  // contain a comma and an operator should never have to know that.
  assert.equal(parseArgs([]).workRoots, undefined);
  assert.deepEqual(parseArgs(['--work-root', '/a']).workRoots, ['/a']);
  assert.deepEqual(parseArgs(['--work-root', '/a', '--work-root', '/b']).workRoots, ['/a', '/b']);
  assert.deepEqual(parseArgs(['--work-root=/a', '--work-root=/b']).workRoots, ['/a', '/b']);
});

test('parseArgs --serve-crews: comma-split, trim, drop-empties; no flag ⇒ undefined (→ [] at call site)', () => {
  // no flag: undefined here; run() turns this into [] via `parsed.serveCrews ?? []`.
  assert.equal(parseArgs([]).serveCrews, undefined);
  // space-form and =-form both parse to the same list.
  assert.deepEqual(parseArgs(['--serve-crews', 'a,b']).serveCrews, ['a', 'b']);
  assert.deepEqual(parseArgs(['--serve-crews=a,b']).serveCrews, ['a', 'b']);
  // trim each entry and drop empty segments.
  assert.deepEqual(parseArgs(['--serve-crews', ' a , ,b ']).serveCrews, ['a', 'b']);
  // an empty / whitespace-only value narrows to nothing ⇒ [] (still "serve all" downstream).
  assert.deepEqual(parseArgs(['--serve-crews', '']).serveCrews, []);
  assert.deepEqual(parseArgs(['--serve-crews', '   ']).serveCrews, []);
});

// ---- the agent-run budget ---------------------------------------------------

test('resolveMaxConcurrentAgents: --max-agents beats settings.maxConcurrentAgents beats the default 4', () => {
  assert.equal(resolveMaxConcurrentAgents(undefined, undefined), 4);
  assert.equal(resolveMaxConcurrentAgents(undefined, 2), 2);
  assert.equal(resolveMaxConcurrentAgents(9, 2), 9);
});

test('parseArgs reads --max-agents; absent leaves it undefined', () => {
  const on = parseArgs(['--max-agents', '6']);
  assert.equal(on.error, undefined);
  assert.equal(on.maxAgents, 6);
  assert.equal(parseArgs(['--max-agents=2']).maxAgents, 2);
  assert.equal(parseArgs([]).maxAgents, undefined);

  assert.match(parseArgs(['--max-agents', 'abc']).error!, /--max-agents must be a non-negative integer/);
  assert.match(parseArgs(['--max-agents']).error!, /missing value/);
});

// ---- session-unique shift name (shifts.md §6/§8 item 4) --------------------
//
// The hub keys presence rows by (principal, name), so two sessions on one
// machine in one directory under one identity must NOT resolve to the same
// default name — that flip-flopping-row defect is what resolveShiftName fixes.

test('resolveShiftName: default is host/dir#<first 6 hex of the cid, shf_ stripped>', () => {
  assert.equal(
    resolveShiftName(undefined, { shiftId: 'shf_7f3a2b91-aaaa-bbbb-cccc-dddddddddddd', hostname: 'box', cwd: '/a/proj' }),
    'box/proj#7f3a2b',
  );
});

test('resolveShiftName: two different cids on the same host+cwd produce two different names (the §6 defect, at the unit level)', () => {
  const a = resolveShiftName(undefined, { shiftId: 'shf_11111111-0000-0000-0000-000000000000', hostname: 'box', cwd: '/a/proj' });
  const b = resolveShiftName(undefined, { shiftId: 'shf_22222222-0000-0000-0000-000000000000', hostname: 'box', cwd: '/a/proj' });
  assert.notEqual(a, b);
});

test('resolveShiftName: an explicit --name wins verbatim — no suffix appended', () => {
  assert.equal(resolveShiftName('explicit', { shiftId: 'shf_7f3a2b91-aaaa' }), 'explicit');
});

test('resolveShiftName: with no shiftId, falls back to a p<pid> suffix', () => {
  assert.equal(resolveShiftName(undefined, { hostname: 'box', cwd: '/a/proj', pid: 4242 }), 'box/proj#p4242');
});

test('parseArgs rejects a blank --name (both forms) at parse time', () => {
  assert.match(parseArgs(['--name', '']).error ?? '', /--name requires a non-empty value/);
  assert.match(parseArgs(['--name=']).error ?? '', /--name requires a non-empty value/);
  assert.equal(parseArgs(['--name', 'shiftA']).name, 'shiftA'); // a real value still passes
});

// PHASE 5 deleted the legacy stamp path along with every flag that selected it.
// These are now UNKNOWN options, and an unknown option is a usage error — the
// point being that an operator running an old command line is told, not silently
// given a different behaviour.
test('the deleted stamp-path flags are unknown options, not silently ignored', () => {
  for (const flag of ['--no-stamp', '--runner-dispatch', '--settle-margin', '--agents-dir']) {
    assert.match(parseArgs([flag]).error ?? '', /unknown option/, `${flag} must be rejected`);
  }
});
