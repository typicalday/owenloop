import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, StoreVersionError, artifactId, taskId } from '../src/store.ts';
import { randId } from '../src/util.ts';
import type { ArtifactData } from '../src/types.ts';

function mem(): Store {
  return new Store(':memory:');
}

function artifact(workflow: string, path: string, over: Partial<ArtifactData> = {}): ArtifactData {
  return {
    workflow,
    path,
    producer: 'maker',
    acceptance: 'owed',
    version: 0,
    reasons: [],
    judgmentRejects: 0,
    schemaRejects: 0,
    ...over,
  };
}

test('deterministic ids are stable and distinct', () => {
  assert.equal(artifactId('wf1', 'plan'), artifactId('wf1', 'plan'));
  assert.notEqual(artifactId('wf1', 'plan'), artifactId('wf2', 'plan'));
  assert.notEqual(taskId('wf1', 'build', ''), taskId('wf1', 'build', 'x'));
});

test('workflow CRUD + params round-trip', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery', title: 'Ship it', params: { repo: 'acme/app' } });
  const got = s.getWorkflow(id);
  assert.equal(got?.def, 'delivery');
  assert.equal(got?.title, 'Ship it');
  assert.deepEqual(got?.params, { repo: 'acme/app' });
  assert.equal(s.listWorkflows().length, 1);
  s.close();
});

test('artifact upsert replaces and preserves JSON fields', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(
    artifact(wf, 'gather.source[0]', {
      acceptance: 'green',
      version: 1,
      value: { url: 'http://x', n: 3 },
      fingerprint: { plan: 2 },
      reasons: [{ at: 1, action: 'reject', kind: 'judgment', by: 'judge', text: 'nope' }],
      judgmentRejects: 1,
    }),
  );
  const got = s.getArtifact(wf, 'gather.source[0]');
  assert.equal(got?.acceptance, 'green');
  assert.equal(got?.version, 1);
  assert.deepEqual(got?.value, { url: 'http://x', n: 3 });
  assert.deepEqual(got?.fingerprint, { plan: 2 });
  assert.equal(got?.reasons.length, 1);
  assert.equal(got?.reasons[0]?.text, 'nope');
  assert.equal(got?.judgmentRejects, 1);

  // upsert fully replaces
  s.putArtifact(artifact(wf, 'gather.source[0]', { acceptance: 'owed', version: 1 }));
  const re = s.getArtifact(wf, 'gather.source[0]');
  assert.equal(re?.acceptance, 'owed');
  assert.equal(re?.value, undefined);
  assert.equal(re?.fingerprint, undefined);
  assert.equal(re?.reasons.length, 0);
  s.close();
});

test('deleteArtifact removes a single artifact, scoped by workflow + path', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'plan', { acceptance: 'green', version: 1 }));
  s.putArtifact(artifact(wf, 'pr'));
  assert.ok(s.getArtifact(wf, 'plan'));

  s.deleteArtifact(wf, 'plan');
  assert.equal(s.getArtifact(wf, 'plan'), undefined, 'plan is gone');
  assert.ok(s.getArtifact(wf, 'pr'), 'sibling artifact untouched');

  // deleting a non-existent artifact is a harmless no-op
  s.deleteArtifact(wf, 'ghost');
  assert.equal(s.listArtifacts(wf).length, 1);
  s.close();
});

test('terminal + sealOf flags survive a round-trip', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'merge', { acceptance: 'green', terminal: true }));
  s.putArtifact(artifact(wf, 'gather.source.sealed', { sealOf: 'gather.source' }));
  assert.equal(s.getArtifact(wf, 'merge')?.terminal, true);
  assert.equal(s.getArtifact(wf, 'gather.source.sealed')?.sealOf, 'gather.source');
  s.close();
});

test('listArtifacts is scoped to a workflow', () => {
  const s = mem();
  const a = randId('wf');
  const b = randId('wf');
  s.putArtifact(artifact(a, 'plan'));
  s.putArtifact(artifact(a, 'pr'));
  s.putArtifact(artifact(b, 'plan'));
  assert.equal(s.listArtifacts(a).length, 2);
  assert.equal(s.listArtifacts(b).length, 1);
  s.close();
});

test('task upsert toggles lease fields', () => {
  const s = mem();
  const wf = randId('wf');
  s.putTask({ workflow: wf, step: 'build', key: '', status: 'idle', attempts: 0 });
  let t = s.getTask(wf, 'build', '');
  assert.equal(t?.status, 'idle');
  assert.equal(t?.run, undefined);

  s.putTask({ workflow: wf, step: 'build', key: '', status: 'claimed', run: 'run_1', claimedAt: 123, attempts: 1 });
  t = s.getTask(wf, 'build', '');
  assert.equal(t?.status, 'claimed');
  assert.equal(t?.run, 'run_1');
  assert.equal(t?.claimedAt, 123);
  assert.equal(t?.attempts, 1);
  assert.equal(s.listClaimedTasks().length, 1);
  s.close();
});

test('run insert/update + budget counters', () => {
  const s = mem();
  const wf = randId('wf');
  const r1 = randId('run');
  s.insertRun(r1, { workflow: wf, step: 'build' });
  s.updateRun(r1, { outcome: 'ok', summary: 'done', sessionId: 'sess-9' });
  const got = s.getRun(r1);
  assert.equal(got?.outcome, 'ok');
  assert.equal(got?.summary, 'done');
  assert.equal(got?.sessionId, 'sess-9');

  s.insertRun(randId('run'), { workflow: wf, step: 'build' });
  assert.equal(s.countRuns(wf, 'build', 0), 2);
  assert.equal(s.countRuns(wf, 'other', 0), 0);
  assert.equal(s.latestRun(wf, 'build')?.workflow, wf);
  s.close();
});

test('tx rolls back atomically on throw', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'plan'));
  assert.throws(() =>
    s.tx(() => {
      s.putArtifact(artifact(wf, 'plan', { acceptance: 'green', version: 1 }));
      s.putArtifact(artifact(wf, 'pr', { acceptance: 'green', version: 1 }));
      throw new Error('boom');
    }),
  );
  // both writes rolled back
  assert.equal(s.getArtifact(wf, 'plan')?.acceptance, 'owed');
  assert.equal(s.getArtifact(wf, 'pr'), undefined);
  s.close();
});

test('tx commits all-or-nothing on success', () => {
  const s = mem();
  const wf = randId('wf');
  const n = s.tx(() => {
    s.putArtifact(artifact(wf, 'a', { acceptance: 'green', version: 1 }));
    s.putArtifact(artifact(wf, 'b', { acceptance: 'green', version: 1 }));
    return 2;
  });
  assert.equal(n, 2);
  assert.equal(s.listArtifacts(wf).length, 2);
  s.close();
});

test('deleteWorkflow cascades to artifacts/tasks/runs', () => {
  const s = mem();
  const wf = randId('wf');
  s.insertWorkflow(wf, { def: 'd' });
  s.putArtifact(artifact(wf, 'plan'));
  s.putTask({ workflow: wf, step: 'build', key: '', status: 'idle', attempts: 0 });
  s.insertRun(randId('run'), { workflow: wf, step: 'build' });
  s.deleteWorkflow(wf);
  assert.equal(s.getWorkflow(wf), undefined);
  assert.equal(s.listArtifacts(wf).length, 0);
  assert.equal(s.listTasks(wf).length, 0);
  assert.equal(s.countRuns(wf, 'build', 0), 0);
  s.close();
});

test('deleteWorkflowCascade removes parent + all descendants (grandchild included)', () => {
  const s = mem();
  const parent = randId('wf');
  const child = randId('wf');
  const grandchild = randId('wf');
  s.insertWorkflow(parent, { def: 'd' });
  s.insertWorkflow(child, { def: 'd' }, { parentWf: parent, parentPath: 'calls' });
  s.insertWorkflow(grandchild, { def: 'd' }, { parentWf: child, parentPath: 'calls' });
  for (const wf of [parent, child, grandchild]) {
    s.putArtifact(artifact(wf, 'plan'));
    s.putTask({ workflow: wf, step: 'build', key: '', status: 'idle', attempts: 0 });
    s.insertRun(randId('run'), { workflow: wf, step: 'build' });
  }
  s.deleteWorkflowCascade(parent);
  for (const wf of [parent, child, grandchild]) {
    assert.equal(s.getWorkflow(wf), undefined, `${wf} workflow row gone`);
    assert.equal(s.listArtifacts(wf).length, 0, `${wf} artifacts gone`);
    assert.equal(s.listTasks(wf).length, 0, `${wf} tasks gone`);
    assert.equal(s.countRuns(wf, 'build', 0), 0, `${wf} runs gone`);
  }
  s.close();
});

test('a corrupted JSON column raises an error naming the table and row id', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'plan', { acceptance: 'green', version: 1, value: { ok: true } }));
  const id = artifactId(wf, 'plan');
  // corrupt the `value` column directly, bypassing the store's own JSON.stringify
  s.db.prepare('UPDATE artifact SET value = ? WHERE id = ?').run('{not valid json', id);
  assert.throws(
    () => s.getArtifact(wf, 'plan'),
    (err: Error) => {
      assert.match(err.message, /artifact/);
      assert.match(err.message, new RegExp(id));
      return true;
    },
  );
  s.close();
});

test('run cause round-trips through insert and update', () => {
  const s = mem();
  const wf = randId('wf');
  const r1 = randId('run');
  const r2 = randId('run');

  // insert with cause set — must survive to getRun
  s.insertRun(r1, { workflow: wf, step: 'builder', cause: 'allGreen' });
  const got = s.getRun(r1);
  assert.equal(got?.cause, 'allGreen', 'cause persists through insertRun');

  // insert without cause — must be absent (not undefined-as-string)
  s.insertRun(r2, { workflow: wf, step: 'builder' });
  assert.equal(s.getRun(r2)?.cause, undefined, 'absent cause stays absent');

  // updateRun can set cause after the fact
  s.updateRun(r2, { cause: 'inputsGreen' });
  assert.equal(s.getRun(r2)?.cause, 'inputsGreen', 'cause survives updateRun');

  s.close();
});

test('listRuns returns all runs for a workflow ordered by created_at, rowid', () => {
  const s = mem();
  const wf = randId('wf');
  const wf2 = randId('wf');

  // Insert runs with explicit timestamps to verify ordering
  const r1 = randId('run');
  const r2 = randId('run');
  const r3 = randId('run');
  s.insertRun(r1, { workflow: wf, step: 'planner', key: '' }, 1000);
  s.insertRun(r2, { workflow: wf, step: 'builder', key: '' }, 2000);
  s.insertRun(r3, { workflow: wf2, step: 'other', key: '' }, 500); // different wf — must not appear

  // Close r1 with ok outcome so round-trip is verified
  s.updateRun(r1, { outcome: 'ok', fingerprint: { proposal: 1 } });

  const runs = s.listRuns(wf);
  assert.equal(runs.length, 2, 'only runs for wf, not wf2');
  assert.equal(runs[0]!.id, r1, 'ordered by created_at: r1 first');
  assert.equal(runs[1]!.id, r2, 'r2 second');
  assert.equal(runs[0]!.step, 'planner');
  assert.equal(runs[0]!.outcome, 'ok');
  assert.deepEqual(runs[0]!.fingerprint, { proposal: 1 });
  assert.equal(runs[1]!.outcome, undefined, 'open run has undefined outcome');

  s.close();
});

// ---- alarm_at round-trip (PR3b: idle trigger) --------------------------------

test('setAlarm / getAlarm / clearAlarm round-trip', () => {
  const s = mem();
  const wf = randId('wf');
  const step = 'completion';
  const alarmTime = 9999;

  // No alarm yet — getAlarm returns undefined
  assert.equal(s.getAlarm(wf, step), undefined);

  // setAlarm creates the task row and sets alarm_at
  s.setAlarm(wf, step, alarmTime);
  assert.equal(s.getAlarm(wf, step), alarmTime, 'getAlarm returns the stored alarm_at');

  // clearAlarm sets alarm_at to null → getAlarm returns undefined
  s.clearAlarm(wf, step);
  assert.equal(s.getAlarm(wf, step), undefined, 'getAlarm returns undefined after clearAlarm');

  s.close();
});

test('setAlarm updates an existing task row (upsert path)', () => {
  const s = mem();
  const wf = randId('wf');
  const step = 'completion';

  // Create the task row via putTask first
  s.putTask({ workflow: wf, step, key: '', status: 'idle', attempts: 0 });

  // setAlarm on existing row
  s.setAlarm(wf, step, 12345);
  assert.equal(s.getAlarm(wf, step), 12345);

  // Update alarm
  s.setAlarm(wf, step, 99999);
  assert.equal(s.getAlarm(wf, step), 99999, 'setAlarm updates alarm_at on existing row');

  s.close();
});

test('lastProgressMs returns 0 when no artifacts exist', () => {
  const s = mem();
  const wf = randId('wf');
  assert.equal(s.lastProgressMs(wf), 0);
  s.close();
});

test('lastProgressMs returns MAX(updated_at) of artifacts for the workflow', () => {
  const s = mem();
  const wf = randId('wf');
  const wf2 = randId('wf');

  const base: ArtifactData = {
    workflow: wf,
    path: 'plan',
    producer: 'planner',
    acceptance: 'owed',
    version: 0,
    reasons: [],
    judgmentRejects: 0,
    schemaRejects: 0,
  };

  // Insert an artifact; lastProgressMs should return its updated_at
  s.putArtifact(base);
  const t1 = s.lastProgressMs(wf);
  assert.ok(t1 > 0, 'lastProgressMs > 0 after first artifact');

  // Insert another artifact for a different workflow — must not affect wf
  s.putArtifact({ ...base, workflow: wf2, path: 'plan' });
  const t2 = s.lastProgressMs(wf);
  assert.equal(t2, t1, 'lastProgressMs is scoped to the workflow');

  s.close();
});

// ---- alarm_at restart persistence (PR3b: E-ALARM contract) -------------------

test('alarm_at survives a process restart (file-backed round-trip)', () => {
  // Open a Store on a real file, setAlarm, CLOSE it, REOPEN a new Store on the
  // same file (so migrate() runs again), and assert getAlarm returns the stored
  // value. This verifies that alarm_at persists across process restarts.
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-store-test-'));
  const dbPath = join(dir, 'test.db');
  const wf = randId('wf');
  const step = 'completion';
  const alarmTime = 1_700_000_000_000; // a plausible ms-epoch value

  try {
    // First process lifetime: open, set alarm, close.
    const s1 = new Store(dbPath);
    s1.setAlarm(wf, step, alarmTime);
    assert.equal(s1.getAlarm(wf, step), alarmTime, 'alarm readable before close');
    s1.close();

    // Second process lifetime: open the same file (migrate() runs), read alarm.
    const s2 = new Store(dbPath);
    assert.equal(
      s2.getAlarm(wf, step),
      alarmTime,
      'alarm_at survives Store close+reopen (restart persistence)',
    );
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- M2-LINK: producedBy round-trip and reverse-lookup tests -----------------

test('insertWorkflow round-trips producedBy coordinates', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery' }, { parentWf: 'wf_parent', parentPath: 'deliver' });
  const got = s.getWorkflow(id);
  assert.ok(got !== undefined, 'workflow must be retrievable');
  assert.deepEqual(got.producedBy, { parentWf: 'wf_parent', parentPath: 'deliver' });
  s.close();
});

test('insertWorkflow without producedBy has producedBy undefined', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery' });
  const got = s.getWorkflow(id);
  assert.ok(got !== undefined, 'workflow must be retrievable');
  assert.equal(got.producedBy, undefined);
  s.close();
});

test('findChildByParent returns the child workflow row', () => {
  const s = mem();
  const parentWf = randId('wf');
  const childId = randId('wf');
  const otherId = randId('wf');

  // Insert child with producedBy
  s.insertWorkflow(childId, { def: 'delivery' }, { parentWf, parentPath: 'deliver' });
  // Insert another workflow without producedBy
  s.insertWorkflow(otherId, { def: 'delivery' });

  const found = s.findChildByParent(parentWf, 'deliver');
  assert.ok(found !== undefined, 'findChildByParent must return the child');
  assert.equal(found.id, childId);
  assert.deepEqual(found.producedBy, { parentWf, parentPath: 'deliver' });

  // Other workflow must not be returned
  const other = s.findChildByParent(parentWf, 'other-path');
  assert.equal(other, undefined, 'findChildByParent must not return unrelated rows');

  s.close();
});

test('findChildByParent returns undefined when no match', () => {
  const s = mem();
  const found = s.findChildByParent('wf_does_not_exist', 'deliver');
  assert.equal(found, undefined);
  s.close();
});

// ---- concurrent-writer CAS tests (node:sqlite BEGIN IMMEDIATE) ---------------

test('tx() CAS: second writer detects fingerprint change and does not commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-cas-'));
  const dbPath = join(dir, 'cas.db');
  try {
    const s1 = new Store(dbPath);
    const wf = 'wf_cas';
    const base: ArtifactData = {
      workflow: wf, path: 'plan', producer: 'planner',
      acceptance: 'green', version: 1,
      fingerprint: { plan: 1 },
      reasons: [], judgmentRejects: 0, schemaRejects: 0,
    };
    s1.putArtifact(base);
    const s2 = new Store(dbPath);

    // Both read fingerprint before any tx() — both see { plan: 1 }
    const fp1 = s1.getArtifact(wf, 'plan')!.fingerprint;
    const fp2 = s2.getArtifact(wf, 'plan')!.fingerprint;
    assert.deepEqual(fp1, { plan: 1 });
    assert.deepEqual(fp2, { plan: 1 });

    // s1 wins: commits with new fingerprint
    let s1Won = false;
    s1.tx(() => {
      const cur = s1.getArtifact(wf, 'plan')!.fingerprint;
      assert.deepEqual(cur, { plan: 1 });
      s1.putArtifact({ ...base, fingerprint: { plan: 2 }, version: 2 });
      s1Won = true;
    });

    // s2 loses: fingerprint no longer matches its stale read
    let s2Won = false;
    let s2Err: unknown;
    try {
      s2.tx(() => {
        const cur = s2.getArtifact(wf, 'plan')!.fingerprint;
        if (JSON.stringify(cur) !== JSON.stringify(fp2)) {
          throw new Error('CAS conflict');
        }
        s2.putArtifact({ ...base, fingerprint: { plan: 3 }, version: 3 });
        s2Won = true;
      });
    } catch (e) { s2Err = e; }

    assert.ok(s1Won, 's1 must have committed');
    assert.ok(!s2Won, 's2 must not have committed');
    assert.ok(s2Err instanceof Error, 's2 must have thrown');
    // Only s1 commit visible
    assert.deepEqual(s1.getArtifact(wf, 'plan')!.fingerprint, { plan: 2 });

    s1.close();
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tx() BEGIN IMMEDIATE: second connection is blocked at BEGIN, not mid-write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-imm-'));
  const dbPath = join(dir, 'imm.db');
  try {
    const db1 = new DatabaseSync(dbPath);
    const db2 = new DatabaseSync(dbPath);
    db1.exec('PRAGMA journal_mode = WAL');
    db2.exec('PRAGMA journal_mode = WAL');
    db1.exec('PRAGMA busy_timeout = 100');
    db2.exec('PRAGMA busy_timeout = 100');
    db1.exec('CREATE TABLE t (x INTEGER)');

    // db1 acquires write lock via BEGIN IMMEDIATE
    db1.exec('BEGIN IMMEDIATE');

    // db2 must fail at BEGIN IMMEDIATE (not silently proceed to write time)
    assert.throws(
      () => db2.exec('BEGIN IMMEDIATE'),
      /database is locked|SQLITE_BUSY/i,
      'second BEGIN IMMEDIATE must fail while first holds the write lock'
    );

    db1.exec('ROLLBACK');
    db1.close();
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- schema-version downgrade guard -----------------------------------------

test('fresh database stamps schema_version to current SCHEMA_VERSION, no throw', () => {
  const s = mem();
  assert.equal(s.getMeta('schema_version'), '5');
  s.close();
});

test('opening a DB already at current SCHEMA_VERSION is a no-op, no throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-schemaver-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    s1.close();
    const s2 = new Store(dbPath); // reopen at same version — must not throw
    assert.equal(s2.getMeta('schema_version'), '5');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a DB with an older schema_version upgrades normally (regression guard)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-schemaver-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    s1.setMeta('schema_version', '3'); // simulate an old on-disk stamp
    s1.close();

    const s2 = new Store(dbPath); // must NOT throw
    assert.equal(s2.getMeta('schema_version'), '5', 'upgrades to current SCHEMA_VERSION');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a DB with a newer-than-binary schema_version throws StoreVersionError and does not rewrite it downward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-schemaver-'));
  const dbPath = join(dir, 'test.db');
  try {
    // Create a normal DB, then simulate a newer binary having stamped it.
    const s1 = new Store(dbPath);
    s1.setMeta('schema_version', '6');
    s1.close();

    // Reopening at this binary's SCHEMA_VERSION ('5') must refuse.
    assert.throws(() => new Store(dbPath), StoreVersionError);

    // Direct raw read proves schema_version was NOT rewritten downward by
    // the throwing constructor.
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as { v: string };
    assert.equal(row.v, '6', 'schema_version must remain at the newer stamped value, never rewritten down');
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
