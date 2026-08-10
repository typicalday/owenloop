import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  appendSession,
  compact,
  latestFor,
  markRunSessionsDead,
  orderId,
  readSessions,
  sessionsPath,
  type SessionRecord,
} from '../src/harness/session-store.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owenloop-sessions-'));
  file = sessionsPath(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => {
  const workflow = over.workflow ?? 'wf_1';
  const run = over.run ?? 'run_1';
  return {
    workflow,
    run,
    step: 'builder',
    order: orderId(workflow, run),
    attempt: 1,
    harness: 'fake',
    token: 'tok-1',
    cwd: '/tmp/wt',
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
};

const lines = (f: string): string[] => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');

test('sessionsPath and orderId build the two derived strings', () => {
  assert.equal(sessionsPath('/c'), join('/c', 'sessions.jsonl'));
  assert.equal(orderId('wf_1', 'run_2'), 'wf_1/run_2');
});

test('append then latestFor round-trips a record', () => {
  const r = rec({ token: 'tok-abc' });
  appendSession(file, r);
  assert.deepEqual(latestFor(file, 'wf_1', 'run_1', 'builder'), r);
});

test('latestFor is last-wins per (workflow, run, step), and a different step does not interfere', () => {
  appendSession(file, rec({ attempt: 1, token: 'tok-1', updatedAt: 1000 }));
  // A different step for the same run, appended in between.
  appendSession(file, rec({ step: 'reviewer', attempt: 1, token: 'tok-rev', updatedAt: 1100 }));
  appendSession(file, rec({ attempt: 2, token: 'tok-2', updatedAt: 2000 }));
  appendSession(file, rec({ attempt: 3, token: 'tok-3', updatedAt: 3000, status: 'submitted' }));

  const got = latestFor(file, 'wf_1', 'run_1', 'builder');
  assert.equal(got?.token, 'tok-3');
  assert.equal(got?.attempt, 3);
  assert.equal(got?.status, 'submitted');
  // The interleaved step keeps its own answer.
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'reviewer')?.token, 'tok-rev');
});

test('latestFor returns null for a missing file and for an unknown key', () => {
  assert.equal(latestFor(join(dir, 'nope.jsonl'), 'wf_1', 'run_1', 'builder'), null);
  appendSession(file, rec());
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'documenter'), null);
  assert.equal(latestFor(file, 'wf_9', 'run_1', 'builder'), null);
});

test('readSessions on a missing file is [] (fail-open)', () => {
  assert.deepEqual(readSessions(join(dir, 'nope.jsonl')), []);
});

test('appendSession compacts past maxBytes: one line per key, first-seen key order, answers unchanged', () => {
  // maxBytes: 1 trips compaction after every append.
  const opts = { maxBytes: 1 };
  appendSession(file, rec({ step: 'builder', attempt: 1, token: 'b1' }), opts);
  appendSession(file, rec({ step: 'reviewer', attempt: 1, token: 'r1' }), opts);
  appendSession(file, rec({ step: 'builder', attempt: 2, token: 'b2' }), opts);
  appendSession(file, rec({ step: 'builder', attempt: 3, token: 'b3' }), opts);

  const onDisk = lines(file);
  assert.equal(onDisk.length, 2, 'exactly one line per distinct key survives');
  const parsed = onDisk.map((l) => JSON.parse(l) as SessionRecord);
  assert.deepEqual(parsed.map((p) => p.step), ['builder', 'reviewer'], 'first-seen key order preserved');
  assert.deepEqual(parsed.map((p) => p.token), ['b3', 'r1']);

  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'b3');
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'reviewer')?.token, 'r1');
});

test('compact on a file that has never been written is a no-op, not a throw', () => {
  compact(join(dir, 'nope.jsonl'));
  assert.deepEqual(readSessions(join(dir, 'nope.jsonl')), []);
});

test('corrupt lines are skipped and warned about, never thrown', () => {
  const good1 = rec({ step: 'builder', token: 'ok-1' });
  const good2 = rec({ step: 'reviewer', token: 'ok-2' });
  writeFileSync(
    file,
    [
      JSON.stringify(good1), // 1 valid
      'not json', // 2 unparseable
      '[]', // 3 parses, but not an object
      '{"workflow":"w"}', // 4 missing run/step/harness/token
      JSON.stringify({ ...rec(), status: 'bogus' }), // 5 status outside the four literals
      '', // 6 blank — skipped SILENTLY, not a warning
      JSON.stringify(good2), // 7 valid
    ].join('\n') + '\n',
  );

  const warnings: string[] = [];
  const got = readSessions(file, { warn: (l) => warnings.push(l) });

  assert.deepEqual(got.map((r) => r.token), ['ok-1', 'ok-2']);
  assert.equal(warnings.length, 4, 'one warning per corrupt line, none for the blank line');
  assert.ok(
    warnings.some((w) => w.includes(`${file}:2`)),
    `a warning names the offending line number: ${JSON.stringify(warnings)}`,
  );
  assert.ok(warnings.some((w) => w.includes(`${file}:5`)));
});

test('a concurrent partial final append is ignored until its newline commits it', () => {
  const first = rec({ step: 'builder', token: 'ok-1' });
  const second = rec({ step: 'reviewer', token: 'ok-2' });
  const encoded = JSON.stringify(second);
  const cut = Math.floor(encoded.length / 2);
  writeFileSync(file, `${JSON.stringify(first)}\n${encoded.slice(0, cut)}`);

  const warnings: string[] = [];
  assert.deepEqual(
    readSessions(file, { warn: (line) => warnings.push(line) }).map((record) => record.token),
    ['ok-1'],
  );
  assert.equal(warnings.length, 0, 'an unterminated final tail is not committed corruption');

  appendFileSync(file, `${encoded.slice(cut)}\n`);
  assert.deepEqual(
    readSessions(file, { warn: (line) => warnings.push(line) }).map((record) => record.token),
    ['ok-1', 'ok-2'],
  );
  assert.equal(warnings.length, 0);
});

test('an unchanged unterminated tail warns once after grace and a changed tail starts a new grace', () => {
  const first = rec({ step: 'builder', token: 'ok-1' });
  writeFileSync(file, `${JSON.stringify(first)}\nnot json`);
  let now = 0;
  const warnings: string[] = [];
  const opts = {
    warn: (line: string) => warnings.push(line),
    now: () => now,
    unterminatedTailGraceMs: 100,
  };

  assert.deepEqual(readSessions(file, opts).map((record) => record.token), ['ok-1']);
  assert.deepEqual(warnings, [], 'the first observation remains silent for a concurrent writer');

  now = 100;
  readSessions(file, opts);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, new RegExp(`persistent unterminated record at ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2`));

  now = 200;
  readSessions(file, opts);
  assert.equal(warnings.length, 1, 'repeated reads do not spam the same abandoned tail');

  writeFileSync(file, `${JSON.stringify(first)}\nstill partial`);
  readSessions(file, opts);
  assert.equal(warnings.length, 1, 'changing the tail restarts the grace period');

  now = 300;
  readSessions(file, opts);
  assert.equal(warnings.length, 2);

  writeFileSync(file, `${JSON.stringify(first)}\n`);
  readSessions(file, opts);
  assert.equal(warnings.length, 2, 'committing or removing the tail clears the observation');
});

test('latestFor over a corrupt file still answers, warning through the default stderr sink', () => {
  writeFileSync(
    file,
    ['not json', JSON.stringify(rec({ token: 'ok-1' }))].join('\n') + '\n',
  );

  // latestFor takes no options by design (it must stay side-effect-free and
  // total), so the DEFAULT warn runs here — capture stderr to assert it.
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'ok-1');
  } finally {
    process.stderr.write = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0], `owenloop work sessions: skipping corrupt record at ${file}:1\n`);
});

test('compact drops corrupt lines along with superseded ones', () => {
  writeFileSync(
    file,
    [JSON.stringify(rec({ token: 'v1' })), 'not json', JSON.stringify(rec({ token: 'v2' }))].join('\n') + '\n',
  );
  compact(file, { warn: () => {} });
  const onDisk = lines(file);
  assert.equal(onDisk.length, 1);
  assert.equal((JSON.parse(onDisk[0]!) as SessionRecord).token, 'v2');
});

test('appendSession creates the parent directory and propagates a real write failure', () => {
  const nested = join(dir, 'deep', 'sessions.jsonl');
  appendSession(nested, rec({ token: 'nested' }));
  assert.equal(latestFor(nested, 'wf_1', 'run_1', 'builder')?.token, 'nested');

  // A path whose parent cannot be created (a FILE stands where a dir must go)
  // must surface to the caller, not be swallowed: a lost token silently
  // degrades a resume into a cold replay.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'i am a file');
  assert.throws(() => appendSession(join(blocker, 'sessions.jsonl'), rec()));
});

// ---- markRunSessionsDead — the teardown gate's session half -------------------
//
// The work directory is per RUN, so removing it kills EVERY step's session that
// lived in it. These cases pin the scope (this run, every step), the shadowing
// (a new `dead` row, not a rewrite), the idempotence, and the failure stance.

test('markRunSessionsDead retires every STEP of the run, and latestFor then reads dead', () => {
  appendSession(file, rec({ step: 'builder', token: 'tok-b', status: 'submitted' }));
  appendSession(file, rec({ step: 'reviewer', token: 'tok-r', status: 'turn-ended' }));

  const marked = markRunSessionsDead(file, 'wf_1', 'run_1', 5000);

  assert.deepEqual(marked.sort(), ['builder', 'reviewer']);
  for (const step of ['builder', 'reviewer']) {
    const latest = latestFor(file, 'wf_1', 'run_1', step);
    assert.equal(latest?.status, 'dead', `${step} must not be resumable after its work dir is removed`);
    assert.equal(latest?.updatedAt, 5000, 'the retirement is stamped with the reap clock');
  }
  // Appended, never rewritten: the live rows are still on disk, just shadowed.
  assert.equal(lines(file).length, 4);
  assert.equal(readSessions(file)[0]?.status, 'submitted');
});

test('markRunSessionsDead carries the rest of the record verbatim — only status and updatedAt move', () => {
  const live = rec({ status: 'submitted', token: 'tok-keep', deliveredReasonAt: 900, attempt: 3, createdAt: 111 });
  appendSession(file, live);

  markRunSessionsDead(file, 'wf_1', 'run_1', 5000);

  assert.deepEqual(latestFor(file, 'wf_1', 'run_1', 'builder'), {
    ...live,
    status: 'dead',
    updatedAt: 5000,
  });
});

test('markRunSessionsDead touches only the named run, and only its newest row per step', () => {
  appendSession(file, rec({ run: 'run_1', order: orderId('wf_1', 'run_1'), status: 'submitted' }));
  appendSession(file, rec({ run: 'run_2', order: orderId('wf_1', 'run_2'), status: 'submitted' }));
  appendSession(file, rec({ workflow: 'wf_2', order: orderId('wf_2', 'run_1'), status: 'submitted' }));

  assert.deepEqual(markRunSessionsDead(file, 'wf_1', 'run_1', 5000), ['builder']);

  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.status, 'dead');
  assert.equal(latestFor(file, 'wf_1', 'run_2', 'builder')?.status, 'submitted', "another run's dir was not reaped");
  assert.equal(latestFor(file, 'wf_2', 'run_1', 'builder')?.status, 'submitted', 'and neither was another workflow');
});

test('markRunSessionsDead is idempotent — a second sweep over the same run appends nothing', () => {
  appendSession(file, rec({ status: 'submitted' }));
  assert.deepEqual(markRunSessionsDead(file, 'wf_1', 'run_1', 5000), ['builder']);
  const after = lines(file).length;

  assert.deepEqual(markRunSessionsDead(file, 'wf_1', 'run_1', 6000), [], 'already dead — nothing to retire');
  assert.equal(lines(file).length, after);
});

test('markRunSessionsDead on a store that does not exist is [] — a run that never had a session', () => {
  assert.deepEqual(markRunSessionsDead(join(dir, 'nope.jsonl'), 'wf_1', 'run_1', 5000), []);
});
