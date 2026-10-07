import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Engine } from '../src/engine.ts';
import { Store, StoreVersionError, artifactId, taskId } from '../src/store.ts';
import { randId } from '../src/util.ts';
import { candidateSetDigest, evidenceDigest, invocationId } from '../src/invocation.ts';
import { valueDigestHex } from '../src/crypto/canonical.ts';
import type { ArtifactData, InterfaceCallBinding, InvocationBinding, Order } from '../src/types.ts';
import { def, step } from './helpers.ts';

function mem(): Store {
  return new Store(':memory:');
}

function interfaceBinding(): InterfaceCallBinding {
  return {
    interface: { name: 'research-report', version: '1' },
    target: 'implementations/report@1.2.3',
    digest: 'a'.repeat(64),
    signature: {
      inputs: [{ name: 'payload', schema: true }],
      outputs: [{ name: 'result', schema: true }],
    },
  };
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

test('setWorkflowRouting merges metadata and preserves authored params', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery', params: { repo: 'acme/app' }, meta: { seeded: true } });
  s.setWorkflowRouting(id, { modifier: 'deep', meta: { customer: 'acme' } });
  s.setWorkflowRouting(id, { meta: { region: 'us-east-1' } });
  const row = s.getWorkflow(id);
  assert.equal(row?.modifier, 'deep');
  assert.deepEqual(row?.params, { repo: 'acme/app' });
  assert.deepEqual(row?.meta, { seeded: true, customer: 'acme', region: 'us-east-1' });
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

  // Other fields remain replaceable; the reason history remains append-only.
  s.putArtifact(artifact(wf, 'gather.source[0]', { acceptance: 'owed', version: 1, reasons: got!.reasons }));
  const re = s.getArtifact(wf, 'gather.source[0]');
  assert.equal(re?.acceptance, 'owed');
  assert.equal(re?.value, undefined);
  assert.equal(re?.fingerprint, undefined);
  assert.deepEqual(re?.reasons, got?.reasons);
  s.close();
});

test('artifact evidence reads persisted rows independently of logical readers, in the same transaction', (t) => {
  class LogicalStore extends Store {
    override getArtifact(workflow: string, path: string) {
      const row = super.getArtifact(workflow, path);
      return row && { ...row, value: { hydrated: true } };
    }
    override listArtifacts(workflow: string) {
      return super.listArtifacts(workflow).map(row => ({ ...row, value: { hydrated: true } }));
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'artifact-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'store.db');
  const s = new LogicalStore(db), observer = new Store(db);
  t.after(() => { observer.close(); s.close(); });
  const original = artifact('wf', 'seed', { acceptance: 'green', version: 1, value: { opaque: 'one' } });
  s.putArtifact(original);
  const persisted = observer.getArtifact('wf', 'seed');
  assert.deepEqual(s.getArtifactEvidence('wf', 'seed'), persisted);
  assert.deepEqual(s.getArtifact('wf', 'seed')?.value, { hydrated: true });
  assert.deepEqual(s.listArtifacts('wf')[0]?.value, { hydrated: true });
  assert.equal(s.getArtifactEvidence('wf', 'missing'), undefined);
  const changes = () => s.db.prepare('SELECT total_changes() AS n').get()!.n;
  const before = changes();
  s.readTx(() => {
    assert.equal(s.db.isTransaction, true);
    assert.deepEqual(s.getArtifactEvidence('wf', 'seed'), persisted);
  });
  assert.equal(changes(), before, 'evidence reads perform no writes');
  assert.throws(() => s.tx(() => {
    s.putArtifact({ ...original, version: 2, acceptance: 'rejected', value: { opaque: 'two' } });
    const current = s.getArtifactEvidence('wf', 'seed')!;
    assert.equal(current.version, 2);
    assert.equal(current.acceptance, 'rejected');
    assert.deepEqual(current.value, { opaque: 'two' });
    assert.deepEqual(observer.getArtifactEvidence('wf', 'seed'), persisted, 'uncommitted row stays connection-local');
    throw new Error('rollback evidence test');
  }), /rollback evidence test/);
  assert.deepEqual(s.getArtifactEvidence('wf', 'seed'), persisted);
  s.tx(() => s.putArtifact({ ...original, version: 2, value: { opaque: 'two' } }));
  const reopened = new Store(db);
  try {
    assert.deepEqual(reopened.getArtifactEvidence('wf', 'seed'), s.getArtifactEvidence('wf', 'seed'));
    assert.deepEqual(reopened.getArtifactEvidence('wf', 'seed'), reopened.getArtifact('wf', 'seed'));
  } finally { reopened.close(); }
});

test('claim prior versions are private, insert-only v0/vN snapshots with transaction rollback', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-prior-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'store.db');
  const s = new Store(db);
  t.after(() => s.close());
  s.insertRun('legacy', { workflow: 'wf', step: 'maker', key: '' });
  assert.equal(s.getClaimPriorVersion('legacy', 'plan'), undefined, 'old runs stay unknown');
  assert.throws(() => s.recordClaimPriorVersion('legacy', 'plan', 0), /write transaction/);

  s.tx(() => {
    s.insertRun('claim-v0', { workflow: 'wf', step: 'maker', key: '' });
    s.recordClaimPriorVersion('claim-v0', 'plan', 0);
    s.recordClaimPriorVersion('claim-v0', 'result', 7);
  });
  assert.equal(s.getClaimPriorVersion('claim-v0', 'plan'), 0);
  assert.equal(s.getClaimPriorVersion('claim-v0', 'result'), 7);
  assert.equal(s.getClaimPriorVersion('claim-v0', 'missing'), undefined);
  assert.throws(() => s.tx(() => s.recordClaimPriorVersion('claim-v0', 'plan', 8)), /UNIQUE/);
  assert.equal(s.getClaimPriorVersion('claim-v0', 'plan'), 0, 'a later version cannot rewrite the claim');
  assert.throws(() => s.tx(() => s.recordClaimPriorVersion('claim-v0', 'bad', -1)), /nonnegative safe integer/);

  assert.throws(() => s.tx(() => {
    s.insertRun('rolled-back', { workflow: 'wf', step: 'maker', key: '' });
    s.recordClaimPriorVersion('rolled-back', 'plan', 3);
    assert.equal(s.getClaimPriorVersion('rolled-back', 'plan'), 3);
    throw new Error('abort claim');
  }), /abort claim/);
  assert.equal(s.getRun('rolled-back'), undefined);
  assert.equal(s.getClaimPriorVersion('rolled-back', 'plan'), undefined);

  const reopened = new Store(db);
  try {
    assert.equal(reopened.getClaimPriorVersion('claim-v0', 'plan'), 0);
    assert.equal(reopened.getClaimPriorVersion('claim-v0', 'result'), 7);
    assert.equal(reopened.getClaimPriorVersion('legacy', 'plan'), undefined);
  } finally { reopened.close(); }
});

test('schema14 migration adds claim prior storage without fabricating legacy snapshots', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-prior-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'store.db');
  const initial = new Store(db);
  initial.insertRun('pre-v15', { workflow: 'wf', step: 'maker', key: '' });
  initial.close();
  const raw = new DatabaseSync(db);
  raw.exec('DROP TABLE claim_prior_version');
  raw.prepare("UPDATE meta SET v = '14' WHERE k = 'schema_version'").run();
  raw.close();

  const migrated = new Store(db);
  try {
    assert.equal(migrated.getMeta('schema_version'), '15');
    assert.equal(migrated.getClaimPriorVersion('pre-v15', 'plan'), undefined);
    migrated.tx(() => {
      migrated.insertRun('post-v15', { workflow: 'wf', step: 'maker', key: '' });
      migrated.recordClaimPriorVersion('post-v15', 'plan', 0);
    });
    assert.equal(migrated.getClaimPriorVersion('post-v15', 'plan'), 0);
  } finally { migrated.close(); }
});

test('artifact history retains immutable versions and lifecycle events', () => {
  const s = mem();
  const wf = randId('wf');
  s.putArtifact(artifact(wf, 'pr', { acceptance: 'green', version: 1, value: { url: 'v1' }, fingerprint: { plan: 1 } }));
  s.putArtifact(artifact(wf, 'pr', {
    acceptance: 'rejected', version: 1, value: { url: 'v1' }, fingerprint: { plan: 1 },
    reasons: [{ at: 10, action: 'reject', kind: 'judgment', by: 'review', text: 'fix checks', fromVersion: 1 }], judgmentRejects: 1,
  }));
  s.putArtifact(artifact(wf, 'pr', { acceptance: 'green', version: 2, value: { url: 'v2' }, fingerprint: { plan: 2 },
    reasons: s.getArtifact(wf, 'pr')!.reasons }));
  const history = s.getArtifactHistory(wf, 'pr');
  assert.deepEqual(history?.versions.map((v) => v.value), [{ url: 'v1' }, { url: 'v2' }]);
  assert.deepEqual(history?.versions.map((v) => v.fingerprint), [{ plan: 1 }, { plan: 2 }]);
  assert.ok(history?.versions[0]?.events.some((event) => event.action === 'produced'));
  assert.ok(history?.versions[0]?.events.some((event) => event.reason === 'fix checks'));
  assert.equal(history?.current.value?.url, 'v2');
  s.deleteArtifact(wf, 'pr');
  assert.equal(s.getArtifactHistory(wf, 'pr'), undefined);
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

function sampleOrder(over: Partial<Order> = {}): Order {
  // WP-B1 reference shape: defDigest present, no prompt/command, no
  // owes[].acceptance — dynamic consumes/reasons ride, static text does not.
  return {
    run: 'run_sample',
    workflow: 'wf_sample',
    step: 'builder',
    key: '',
    defDigest: 'deadbeef'.repeat(8),
    inputs: ['proposal'],
    outputs: ['pr'],
    consumes: { proposal: { text: 'do it', n: 3 } },
    owes: [{ path: 'pr', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    ...over,
  };
}

test('order packet round-trips through insertRun and getRun/listRuns', () => {
  const s = mem();
  const wf = randId('wf');
  const r1 = randId('run');
  const order = sampleOrder({ run: r1, workflow: wf });

  s.insertRun(r1, { workflow: wf, step: 'builder', order });
  assert.deepStrictEqual(s.getRun(r1)?.order, order, 'order persists byte-for-byte through insertRun/getRun');

  const [row] = s.listRuns(wf);
  assert.deepStrictEqual(row?.order, order, 'order also present via listRuns');

  s.close();
});

test('order packet is immutable: updateRun (close path) never clobbers it', () => {
  const s = mem();
  const wf = randId('wf');
  const r1 = randId('run');
  const order = sampleOrder({ run: r1, workflow: wf });

  s.insertRun(r1, { workflow: wf, step: 'builder', order });
  // The close path writes outcome/summary — the order must survive untouched.
  s.updateRun(r1, { outcome: 'ok', summary: 'done' });
  assert.deepStrictEqual(s.getRun(r1)?.order, order, 'order intact after updateRun');
  assert.equal(s.getRun(r1)?.outcome, 'ok');

  s.close();
});

test('run inserted without an order has order undefined (no phantom field)', () => {
  const s = mem();
  const wf = randId('wf');
  const r1 = randId('run');
  s.insertRun(r1, { workflow: wf, step: 'builder' });
  assert.equal(s.getRun(r1)?.order, undefined, 'absent order stays absent');
  s.close();
});

test('migration: a v6 DB missing order_json upgrades to v7 and legacy runs read order undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-ordermig-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    const legacy = randId('run');
    s1.insertRun(legacy, { workflow: 'wf_legacy', step: 'builder' });
    s1.close();

    // Simulate a pre-v7 on-disk state: drop the column and stamp the old version.
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE run DROP COLUMN order_json');
    raw.prepare('UPDATE meta SET v = ? WHERE k = ?').run('6', 'schema_version');
    raw.close();

    const s2 = new Store(dbPath); // migrate() must re-add order_json, bump to current
    assert.equal(s2.getMeta('schema_version'), '15', 'upgraded to current SCHEMA_VERSION');
    const cols = (s2.db.prepare('PRAGMA table_info(run)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('order_json'), 'order_json column re-added by migrate()');
    assert.equal(s2.getRun(legacy)?.order, undefined, 'legacy run reads order undefined');

    // And a fresh insert on the migrated DB round-trips an order.
    const fresh = randId('run');
    const order = sampleOrder({ run: fresh, workflow: 'wf_legacy' });
    s2.insertRun(fresh, { workflow: 'wf_legacy', step: 'builder', order });
    assert.deepStrictEqual(s2.getRun(fresh)?.order, order);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: a pre-v9 reason thread backfills once and reopening v9 is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-historymig-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    const wf = randId('wf');
    s1.putArtifact(artifact(wf, 'pr', {
      acceptance: 'rejected', version: 4,
      reasons: [{ at: 42, action: 'reject', kind: 'judgment', by: 'reviewer', text: 'needs tests', fromVersion: 4 }],
      judgmentRejects: 1,
    }));
    s1.close();

    // Handcraft the state an upgrader sees: the old projection has reasons,
    // but v8's new history tables have no rows yet.
    const raw = new DatabaseSync(dbPath);
    raw.exec('DELETE FROM artifact_event; DELETE FROM artifact_version;');
    raw.prepare('UPDATE meta SET v = ? WHERE k = ?').run('8', 'schema_version');
    raw.close();

    const s2 = new Store(dbPath);
    const once = s2.getArtifactHistory(wf, 'pr');
    assert.equal(once?.versions.length, 0, 'old overwritten payloads are not invented during backfill');
    assert.deepEqual(once?.events.map((e) => [e.action, e.actor, e.reason, e.version]), [
      ['reject', 'reviewer', 'needs tests', 4],
    ]);
    s2.close();

    const s3 = new Store(dbPath);
    const reopened = s3.getArtifactHistory(wf, 'pr');
    assert.equal(reopened?.events.length, 1, 'opening an already-v8 database does not duplicate legacy events');
    const legacy = s3.getArtifact(wf, 'pr')!;
    s3.putArtifact({ ...legacy, reasons: [...legacy.reasons,
      { at: 43, action: 'retry', kind: 'structural', by: 'human', text: 'try again', fromVersion: 4 }] });
    assert.deepEqual(s3.getArtifactHistory(wf, 'pr')?.events.map((event) => event.reason),
      ['needs tests', 'try again'], 'post-upgrade append preserves the legacy prefix');
    s3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ---- §28: instance-to-definition pinning (snapshot + hash) round-trip -------

test('insertWorkflow round-trips defSnapshot/defHash', () => {
  const s = mem();
  const id = randId('wf');
  const d = def('delivery', [], [step({ name: 'planner', produces: ['plan'] })]);
  s.insertWorkflow(id, { def: 'delivery', defSnapshot: d, defHash: 'abc123' });
  const got = s.getWorkflow(id);
  assert.ok(got !== undefined, 'workflow must be retrievable');
  assert.deepEqual(got.defSnapshot, d);
  assert.equal(got.defHash, 'abc123');
  s.close();
});

test('insertWorkflow without defSnapshot/defHash leaves both undefined (legacy-row compatibility)', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery' });
  const got = s.getWorkflow(id);
  assert.ok(got !== undefined, 'workflow must be retrievable');
  assert.equal(got.defSnapshot, undefined);
  assert.equal(got.defHash, undefined);
  s.close();
});

test('repinWorkflowDef overwrites (not merges) the stored snapshot/hash', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery' }); // legacy row, no snapshot
  assert.equal(s.getWorkflow(id)?.defSnapshot, undefined);

  const d1 = def('delivery', [], [step({ name: 'a', produces: ['x'] })]);
  s.repinWorkflowDef(id, d1, 'hash1');
  let got = s.getWorkflow(id);
  assert.deepEqual(got?.defSnapshot, d1);
  assert.equal(got?.defHash, 'hash1');

  const d2 = def('delivery', [], [step({ name: 'b', produces: ['y'] })]);
  s.repinWorkflowDef(id, d2, 'hash2');
  got = s.getWorkflow(id);
  assert.deepEqual(got?.defSnapshot, d2);
  assert.equal(got?.defHash, 'hash2');
  s.close();
});

test('insertWorkflow round-trips immutable interface bindings and isolates caller mutations', () => {
  const s = mem();
  const id = randId('wf');
  const binding = interfaceBinding();
  s.insertWorkflow(id, { def: 'delivery', interfaceBindings: [binding] });

  binding.target = 'mutated/after-insert@9';
  const first = s.getWorkflow(id)!;
  assert.equal(first.interfaceBindings?.[0]?.target, 'implementations/report@1.2.3');
  first.interfaceBindings![0]!.target = 'mutated/after-read@9';
  assert.equal(s.getWorkflow(id)?.interfaceBindings?.[0]?.target, 'implementations/report@1.2.3');
  s.close();
});

test('repin and routing updates never rewrite immutable interface bindings', () => {
  const s = mem();
  const id = randId('wf');
  const binding = interfaceBinding();
  s.insertWorkflow(id, { def: 'delivery', interfaceBindings: [binding] });
  const replacement = def('delivery', [], [step({ name: 'replacement', produces: ['done'] })]);
  s.repinWorkflowDef(id, replacement, 'new-hash');
  s.setWorkflowRouting(id, { modifier: 'deep', meta: { selected: true } });
  assert.deepEqual(s.getWorkflow(id)?.interfaceBindings, [binding]);
  s.close();
});

test('Engine.adopt re-pins the definition without changing immutable interface bindings', () => {
  const s = mem();
  const id = randId('wf');
  const binding = interfaceBinding();
  const original = def('delivery', [], [step({ name: 'original', produces: ['old'] })]);
  const replacement = def('delivery', [], [step({ name: 'replacement', produces: ['new'] })]);
  s.insertWorkflow(id, {
    def: 'delivery',
    defSnapshot: original,
    defHash: 'old-hash',
    interfaceBindings: [binding],
  });
  const engine = new Engine(s, (name) => {
    if (name === 'delivery') return replacement;
    throw new Error(`no def: ${name}`);
  });

  engine.adopt(id);
  assert.deepEqual(s.getWorkflow(id)?.interfaceBindings, [binding]);
  s.close();
});

test('interface binding SQL NULL maps to true property absence and deletion removes the state', () => {
  const s = mem();
  const legacy = randId('wf');
  s.insertWorkflow(legacy, { def: 'delivery' });
  const row = s.getWorkflow(legacy)!;
  assert.equal(row.interfaceBindings, undefined);
  assert.equal('interfaceBindings' in row, false);

  const bound = randId('wf');
  s.insertWorkflow(bound, { def: 'delivery', interfaceBindings: [interfaceBinding()] });
  s.deleteWorkflow(bound);
  assert.equal(s.getWorkflow(bound), undefined);
  s.close();
});

test('migration: a v11 DB gains nullable interface bindings without inventing a value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-interface-binding-mig-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    const legacy = randId('wf');
    s1.insertWorkflow(legacy, { def: 'delivery' });
    s1.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE workflow DROP COLUMN interface_bindings');
    raw.prepare('UPDATE meta SET v = ? WHERE k = ?').run('11', 'schema_version');
    raw.close();

    const s2 = new Store(dbPath);
    assert.equal(s2.getMeta('schema_version'), '15');
    const cols = (s2.db.prepare('PRAGMA table_info(workflow)').all() as Array<{ name: string }>).map((column) => column.name);
    assert.ok(cols.includes('interface_bindings'));
    assert.equal(s2.getWorkflow(legacy)?.interfaceBindings, undefined);
    const fresh = randId('wf');
    s2.insertWorkflow(fresh, { def: 'delivery', interfaceBindings: [interfaceBinding()] });
    assert.deepEqual(s2.getWorkflow(fresh)?.interfaceBindings, [interfaceBinding()]);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed persisted interface-binding JSON and nested shapes fail closed on read', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery' });
  s.db.prepare('UPDATE workflow SET interface_bindings = ? WHERE id = ?').run('{not json', id);
  assert.throws(() => s.getWorkflow(id), /Corrupt JSON in workflow\.interface_bindings/);
  const malformed = interfaceBinding();
  malformed.signature.inputs = [{ name: 'payload', schema: [] as never }];
  s.db.prepare('UPDATE workflow SET interface_bindings = ? WHERE id = ?').run(JSON.stringify([malformed]), id);
  assert.throws(() => s.getWorkflow(id), /signature\.inputs\[0\]\.schema is malformed/);
  s.close();
});

// ---- routing modifier: the one value an instance carries for its whole life -

test('insertWorkflow round-trips the routing modifier', () => {
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery', modifier: 'deep' });
  assert.equal(s.getWorkflow(id)?.modifier, 'deep');
  s.close();
});

test('insertWorkflow without a modifier reads modifier undefined, never empty string', () => {
  // The distinction matters downstream: an absent modifier means every step is
  // offered on its bare authored capabilities, while a modifier of '' would
  // compose the nonsense capability 'build:'.
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery' });
  const got = s.getWorkflow(id);
  assert.ok(got !== undefined, 'workflow must be retrievable');
  assert.equal(got.modifier, undefined);
  assert.ok(!('modifier' in got), 'the key is absent, not present-and-undefined');
  s.close();
});

test('deleteWorkflow removes the modifier with the run', () => {
  // The modifier is a column on the workflow row, so retention needs no extra
  // step — deleting the run deletes the modifier by construction.
  const s = mem();
  const id = randId('wf');
  s.insertWorkflow(id, { def: 'delivery', modifier: 'express' });
  s.deleteWorkflow(id);
  assert.equal(s.getWorkflow(id), undefined);
  s.close();
});

test('migration: a pre-modifier DB adds the column with no backfill (existing rows stay unmodified)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-modifiermig-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    const legacy = randId('wf');
    s1.insertWorkflow(legacy, { def: 'delivery' });
    s1.close();

    // Simulate a pre-v10 on-disk state: drop the column and stamp the old version.
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE workflow DROP COLUMN modifier');
    raw.prepare('UPDATE meta SET v = ? WHERE k = ?').run('9', 'schema_version');
    raw.close();

    const s2 = new Store(dbPath); // migrate() must re-add modifier, bump to current
    assert.equal(s2.getMeta('schema_version'), '15', 'upgraded to current SCHEMA_VERSION');
    const cols = (s2.db.prepare('PRAGMA table_info(workflow)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('modifier'), 'modifier column re-added by migrate()');
    // No backfill: an instance created before modifiers existed IS an
    // unmodified run, and there is no value to invent for it.
    assert.equal(s2.getWorkflow(legacy)?.modifier, undefined, 'legacy row reads modifier undefined');

    // And a fresh insert on the migrated DB round-trips one.
    const fresh = randId('wf');
    s2.insertWorkflow(fresh, { def: 'delivery', modifier: 'deep' });
    assert.equal(s2.getWorkflow(fresh)?.modifier, 'deep');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: a v10 DB gains nullable metadata without inventing a value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-metamig-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    const legacy = randId('wf');
    s1.insertWorkflow(legacy, { def: 'delivery' });
    s1.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE workflow DROP COLUMN meta');
    raw.prepare('UPDATE meta SET v = ? WHERE k = ?').run('10', 'schema_version');
    raw.close();
    const s2 = new Store(dbPath);
    assert.equal(s2.getMeta('schema_version'), '15');
    assert.equal(s2.getWorkflow(legacy)?.meta, undefined);
    const cols = (s2.db.prepare('PRAGMA table_info(workflow)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('meta'));
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(s.getMeta('schema_version'), '15');
  s.close();
});

test('opening a DB already at current SCHEMA_VERSION is a no-op, no throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-schemaver-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    s1.close();
    const s2 = new Store(dbPath); // reopen at same version — must not throw
    assert.equal(s2.getMeta('schema_version'), '15');
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
    assert.equal(s2.getMeta('schema_version'), '15', 'upgrades to current SCHEMA_VERSION');
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
    s1.setMeta('schema_version', '16');
    s1.close();

    // Reopening at this binary's SCHEMA_VERSION ('15') must refuse.
    assert.throws(() => new Store(dbPath), StoreVersionError);

    // Direct raw read proves schema_version was NOT rewritten downward by
    // the throwing constructor.
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as { v: string };
    assert.equal(row.v, '16', 'schema_version must remain at the newer stamped value, never rewritten down');
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Instance-to-definition pinning (§28): regression pair confirming the
// SCHEMA_VERSION bump to '6' didn't weaken PR #48's downgrade guard — same
// assertion shape as above, one version number up.
test('§28: old-DB-upgrades-fine at the current SCHEMA_VERSION (def_snapshot/def_hash columns present)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-schemaver-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    s1.setMeta('schema_version', '5'); // simulate a pre-pinning on-disk stamp
    s1.close();

    const s2 = new Store(dbPath); // must NOT throw
    assert.equal(s2.getMeta('schema_version'), '15');
    const cols = (s2.db.prepare('PRAGMA table_info(workflow)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('def_snapshot'));
    assert.ok(cols.includes('def_hash'));
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§28: newer-than-binary (99) still refuses to open at current SCHEMA_VERSION', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-schemaver-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    s1.setMeta('schema_version', '99');
    s1.close();

    assert.throws(() => new Store(dbPath), StoreVersionError);

    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as { v: string };
    assert.equal(row.v, '99', 'schema_version must remain at the newer stamped value, never rewritten down');
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- REL-5: downgrade-protection + atomic child creation --------------------

test('REL-5: refusing a newer-version DB performs ZERO on-disk mutation (file byte-identical)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-nomutate-'));
  const dbPath = join(dir, 'test.db');
  try {
    // Materialize a normal DB, stamp it newer-than-binary, and close so WAL is
    // checkpointed into the main file — the file is now fully self-contained.
    const s1 = new Store(dbPath);
    s1.setMeta('schema_version', '99');
    s1.close();

    // Snapshot the main DB file exactly as it sits before the refused open.
    const before = readFileSync(dbPath);

    // The refused open must read/compare the version and throw BEFORE any DDL,
    // migration, or version stamp runs — the old ordering ran the schema first
    // and mutated the file (e.g. added order_json) before refusing.
    assert.throws(() => new Store(dbPath), StoreVersionError);

    const after = readFileSync(dbPath);
    assert.ok(before.equals(after), 'refused open must not mutate the main database file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REL-5: migration is transactional — a failure mid-migrate rolls back, old version intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-txmig-'));
  const dbPath = join(dir, 'test.db');
  try {
    // Build a v6-shaped fixture: open at current, then raw-revert to a pre-v7,
    // pre-v8 shape (drop order_json, stamp '6'). Also sabotage the migration so
    // migrate()'s CREATE UNIQUE INDEX fails: drop the v8 unique index and put a
    // TABLE of the same name in its place — `CREATE UNIQUE INDEX IF NOT EXISTS`
    // only suppresses an existing INDEX, so a same-named TABLE still errors.
    const s1 = new Store(dbPath);
    s1.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX IF EXISTS workflow_produced_by_unique');
    raw.exec('ALTER TABLE run DROP COLUMN order_json');
    raw.exec('CREATE TABLE workflow_produced_by_unique (x INTEGER)');
    raw.prepare('UPDATE meta SET v = ? WHERE k = ?').run('6', 'schema_version');
    raw.close();

    // Reopening runs the migration inside one BEGIN IMMEDIATE. The unique-index
    // step fails on the name collision, so the WHOLE migration rolls back —
    // including the earlier order_json re-add and the version stamp.
    assert.throws(() => new Store(dbPath));

    const check = new DatabaseSync(dbPath);
    const ver = check.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as { v: string };
    assert.equal(ver.v, '6', 'failed migration must leave the old schema_version intact');
    const cols = (check.prepare('PRAGMA table_info(run)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols.includes('order_json'), 'the earlier order_json ALTER must have rolled back with the failed tx');
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REL-5: the migration tx re-checks schema_version under the write lock (TOCTOU guard)', () => {
  // The constructor's pre-tx version check is racy: between it and acquiring
  // BEGIN IMMEDIATE, another (newer) binary can migrate the file and stamp a
  // higher version. The fix re-reads schema_version as the FIRST statement
  // inside the migration tx and refuses if it is now newer, so an older binary
  // can never run its DDL over — and stamp the version back down on — a newer
  // file. That in-tx re-check is `refuseIfNewer()`; assert it refuses a value a
  // second connection committed AFTER this store opened (the exact interleaving
  // the pre-tx check would miss), and leaves the on-disk version untouched.
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-toctou-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s = new Store(dbPath); // opens clean at the current version ('15')
    // A concurrent newer binary migrates + stamps the shared file.
    const other = new DatabaseSync(dbPath);
    other.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(
      'schema_version',
      '99',
    );
    other.close();

    // The live connection's re-read (what the in-tx guard runs) must now refuse.
    const refuse = (s as unknown as { refuseIfNewer(): string | undefined }).refuseIfNewer.bind(s);
    assert.throws(refuse, StoreVersionError, 'in-tx re-check must refuse a version bumped newer after open');

    // Refusing performed no write — the stamped value is untouched.
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version') as { v: string };
    assert.equal(row.v, '99', 'the re-check must not rewrite the newer version down');
    raw.close();
    s.close();

    // Sanity: at the binary's own version the same re-check passes and returns
    // the stored value (no throw) — it only refuses strictly-newer DBs.
    const cleanPath = join(dir, 'clean.db');
    const s2 = new Store(cleanPath);
    const check = (s2 as unknown as { refuseIfNewer(): string | undefined }).refuseIfNewer.bind(s2);
    assert.equal(check(), '15', 're-check returns the current version and does not throw at parity');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REL-5: v8 partial unique index prevents duplicate children, allows NULL-coord top-level rows', () => {
  const s = mem();
  const parentWf = randId('wf');

  // First child for (parentWf, 'deliver') — fine.
  s.insertWorkflow(randId('wf'), { def: 'childDef' }, { parentWf, parentPath: 'deliver' });
  // Second child with the SAME parent coordinate must violate the unique index.
  assert.throws(
    () => s.insertWorkflow(randId('wf'), { def: 'childDef' }, { parentWf, parentPath: 'deliver' }),
    /UNIQUE constraint failed: workflow\.produced_by_wf/,
    'a second child for the same parent coordinate must be rejected',
  );

  // Same parent, DIFFERENT path — allowed (distinct calls: step).
  s.insertWorkflow(randId('wf'), { def: 'childDef' }, { parentWf, parentPath: 'other' });
  // Two top-level instances (NULL coordinates) never conflict — the index is partial.
  s.insertWorkflow(randId('wf'), { def: 'top' });
  s.insertWorkflow(randId('wf'), { def: 'top' });

  s.close();
});

test('REL-5: legacy duplicate children are tolerated on open (index skipped, no data deleted)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-legacydupe-'));
  const dbPath = join(dir, 'test.db');
  try {
    // Create the schema, then drop the unique index so we can raw-insert the
    // kind of duplicate the OLD race could have produced, and stamp a pre-v8
    // version so reopening runs migrate().
    const s1 = new Store(dbPath);
    s1.close();

    const parentWf = randId('wf');
    const older = randId('wf');
    const newer = randId('wf');
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX IF EXISTS workflow_produced_by_unique');
    const ins = raw.prepare(
      `INSERT INTO workflow (id, def, produced_by_wf, produced_by_path, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run(older, 'childDef', parentWf, 'deliver', 1000);
    ins.run(newer, 'childDef', parentWf, 'deliver', 2000);
    raw.prepare('UPDATE meta SET v = ? WHERE k = ?').run('7', 'schema_version');
    raw.close();

    // Reopening must NOT throw and must NOT delete data — it tolerates the
    // duplicates and simply skips creating the unique index.
    const s2 = new Store(dbPath);
    assert.equal(s2.getMeta('schema_version'), '15', 'still upgrades the version stamp');
    const idxRow = s2.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workflow_produced_by_unique'`)
      .get();
    assert.equal(idxRow, undefined, 'unique index is skipped while legacy duplicates exist');
    assert.equal(s2.listChildrenByParent(parentWf).length, 2, 'no data deleted — both duplicates remain');
    // findChildByParent picks the oldest, stably across calls.
    assert.equal(s2.findChildByParent(parentWf, 'deliver')?.id, older);
    assert.equal(s2.findChildByParent(parentWf, 'deliver')?.id, older);
    // ...and stays deterministic even when SQLite reverses its scan order.
    // reverse_unordered_selects is per-connection, so it must be set on the
    // store's own live connection. Under unordered SQL this pragma flips the
    // returned duplicate — the ORDER BY is what keeps oldest-wins stable.
    s2.db.exec('PRAGMA reverse_unordered_selects=ON');
    assert.equal(
      s2.findChildByParent(parentWf, 'deliver')?.id,
      older,
      'oldest child still wins with reverse_unordered_selects=ON',
    );
    s2.close();

    // After the operator removes the offending duplicate, the next open creates
    // the index.
    const raw2 = new DatabaseSync(dbPath);
    raw2.prepare('DELETE FROM workflow WHERE id = ?').run(newer);
    raw2.close();

    const s3 = new Store(dbPath);
    const idxNow = s3.db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workflow_produced_by_unique'`)
      .get();
    assert.ok(idxNow !== undefined, 'unique index is created once the duplicates are gone');
    s3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findChildByParent: id breaks the tie when created_at is identical (deterministic under either scan order)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-childtie-'));
  const dbPath = join(dir, 'test.db');
  try {
    const s1 = new Store(dbPath);
    s1.close();

    const parentWf = randId('wf');
    // Fixed, lexically-ordered ids with IDENTICAL created_at: the ORDER BY
    // `id` secondary key is the only thing that makes the winner deterministic.
    const lo = 'wf_aaa';
    const hi = 'wf_bbb';
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX IF EXISTS workflow_produced_by_unique');
    const ins = raw.prepare(
      `INSERT INTO workflow (id, def, produced_by_wf, produced_by_path, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    // Insert the lexically-larger id FIRST so natural rowid order disagrees
    // with id order — proving the tiebreak is the ORDER BY, not insert order.
    ins.run(hi, 'childDef', parentWf, 'deliver', 5000);
    ins.run(lo, 'childDef', parentWf, 'deliver', 5000);
    raw.close();

    const s = new Store(dbPath);
    try {
      assert.equal(s.findChildByParent(parentWf, 'deliver')?.id, lo, 'lexically-smaller id wins by default');
      s.db.exec('PRAGMA reverse_unordered_selects=ON');
      assert.equal(
        s.findChildByParent(parentWf, 'deliver')?.id,
        lo,
        'lexically-smaller id still wins with reverse_unordered_selects=ON',
      );
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('putArtifact: structural change-detection — key-order-only rewrites are true no-ops, real changes are not', () => {
  const s = mem();
  const wf = randId('wf');

  const countEvents = (): number => {
    const h = s.getArtifactHistory(wf, 'pr');
    if (!h) return 0;
    return h.versions.reduce((n, v) => n + v.events.length, 0) + h.events.length;
  };

  // Green v1 with a nested value in one key order, plus a fingerprint.
  s.putArtifact(
    artifact(wf, 'pr', {
      acceptance: 'green',
      version: 1,
      value: { beta: 2, alpha: 1, nested: { y: 2, x: 1 } },
      fingerprint: { plan: 1 },
    }),
  );
  const afterFirst = countEvents();
  assert.equal(afterFirst, 1, 'first green appends exactly one produced event');

  // Semantically identical payload written with shuffled key order at BOTH the
  // nested-value level AND the top-level ArtifactData literal (built by hand so
  // top-level property order actually differs), and with `terminal` omitted.
  const shuffled: ArtifactData = {
    judgmentRejects: 0,
    reasons: [],
    version: 1,
    acceptance: 'green',
    schemaRejects: 0,
    producer: 'maker',
    path: 'pr',
    workflow: wf,
    fingerprint: { plan: 1 },
    value: { nested: { x: 1, y: 2 }, alpha: 1, beta: 2 },
  };
  s.putArtifact(shuffled);
  assert.equal(countEvents(), afterFirst, 'key-order-only rewrite is a true no-op — no extra event');
  assert.equal(s.getArtifactHistory(wf, 'pr')?.versions.length, 1, 'still exactly one version');

  // Over-suppression guard (a): an acceptance-only change (same version) is a
  // real change and appends an event.
  s.putArtifact(
    artifact(wf, 'pr', {
      acceptance: 'rejected',
      version: 1,
      value: { beta: 2, alpha: 1, nested: { y: 2, x: 1 } },
      fingerprint: { plan: 1 },
      reasons: [{ at: 10, action: 'reject', kind: 'judgment', by: 'review', text: 'nope', fromVersion: 1 }],
      judgmentRejects: 1,
    }),
  );
  const afterAcceptance = countEvents();
  assert.ok(afterAcceptance > afterFirst, 'acceptance/reason change appends an event');

  // Over-suppression guard (b): a value change (new version) appends an event.
  s.putArtifact(
    artifact(wf, 'pr', {
      acceptance: 'green',
      version: 2,
      value: { beta: 2, alpha: 1, nested: { y: 2, x: 99 } },
      fingerprint: { plan: 2 },
      reasons: s.getArtifact(wf, 'pr')!.reasons,
    }),
  );
  assert.ok(countEvents() > afterAcceptance, 'value change appends an event');

  s.close();
});

test('putArtifact preserves an existing reason prefix and records only appended reasons', () => {
  const s = mem();
  const wf = randId('wf');
  const first: ArtifactData['reasons'][number] = {
    at: 10, action: 'reject', kind: 'judgment', by: 'review', text: 'fix checks', fromVersion: 1,
  };
  const second: ArtifactData['reasons'][number] = {
    at: 11, action: 'retry', kind: 'structural', by: 'human', text: 'try again', fromVersion: 1,
  };
  const initial = artifact(wf, 'pr', { acceptance: 'rejected', version: 1, reasons: [first] });
  s.putArtifact(initial);
  const eventCount = () => s.getArtifactHistory(wf, 'pr')!.versions.flatMap((version) => version.events).length;
  const before = eventCount();

  // Canonical equality accepts a harmless JSON key-order change, but writes
  // no extra event. The next real write appends exactly one reason event.
  s.putArtifact({ ...initial, reasons: [{ text: first.text, by: first.by, kind: first.kind,
    action: first.action, at: first.at, fromVersion: first.fromVersion }] });
  assert.equal(eventCount(), before);
  s.putArtifact({ ...initial, reasons: [first, second] });
  assert.deepEqual(s.getArtifact(wf, 'pr')?.reasons, [first, second]);
  assert.equal(eventCount(), before + 1);
  assert.equal(s.getArtifactHistory(wf, 'pr')?.versions[0]?.events.at(-1)?.reason, 'try again');
  s.close();
});

test('putArtifact refuses reason deletion, rewrite and reorder before changing artifact or history', () => {
  const s = mem();
  const wf = randId('wf');
  const reasons: ArtifactData['reasons'] = [
    { at: 10, action: 'reject', kind: 'judgment', by: 'review', text: 'first', fromVersion: 1 },
    { at: 11, action: 'retry', kind: 'structural', by: 'human', text: 'second', fromVersion: 1 },
  ];
  const initial = artifact(wf, 'pr', { acceptance: 'rejected', version: 1, reasons });
  s.putArtifact(initial);
  const before = s.getArtifactHistory(wf, 'pr');
  for (const changed of [
    reasons.slice(0, 1),
    [{ ...reasons[0]!, text: 'forged' }, reasons[1]!],
    [reasons[1]!, reasons[0]!],
  ]) {
    assert.throws(() => s.putArtifact({ ...initial, version: 2, reasons: changed }), /reason thread must be append-only/);
    assert.deepEqual(s.getArtifactHistory(wf, 'pr'), before);
  }
  s.close();
});

test('putArtifact serializes direct stale writers and rolls back artifact, version and event together', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reason-prefix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.db');
  const firstStore = new Store(path);
  const secondStore = new Store(path);
  t.after(() => { secondStore.close(); firstStore.close(); });
  const wf = randId('wf');
  const base = artifact(wf, 'pr', { acceptance: 'green', version: 1 });
  firstStore.putArtifact(base);
  const stale = secondStore.getArtifact(wf, 'pr')!;
  const reason: ArtifactData['reasons'][number] = {
    at: 12, action: 'reject', kind: 'judgment', by: 'review', text: 'new', fromVersion: 1,
  };
  firstStore.putArtifact({ ...base, acceptance: 'rejected', reasons: [reason] });
  const accepted = firstStore.getArtifactHistory(wf, 'pr');
  assert.throws(() => secondStore.putArtifact({ ...stale, version: 2 }), /reason thread must be append-only/);
  assert.deepEqual(secondStore.getArtifactHistory(wf, 'pr'), accepted);

  // Even if a later history write fails, a direct put is one transaction.
  firstStore.db.exec(`CREATE TRIGGER fail_reason_event BEFORE INSERT ON artifact_event
    BEGIN SELECT RAISE(ABORT, 'blocked reason event'); END`);
  const after = { ...firstStore.getArtifact(wf, 'pr')!, version: 2,
    acceptance: 'rejected' as const, reasons: [reason, { ...reason, at: 13, text: 'another' }] };
  assert.throws(() => firstStore.putArtifact(after), /blocked reason event/);
  assert.deepEqual(firstStore.getArtifactHistory(wf, 'pr'), accepted);
  assert.equal(firstStore.db.prepare('SELECT COUNT(*) AS n FROM artifact_version WHERE workflow = ? AND path = ?')
    .get(wf, 'pr')!.n, 1);
});

test('putArtifact refuses to mutate from a caller-owned read transaction', () => {
  const s = mem();
  const wf = randId('wf');
  s.readTx(() => {
    assert.throws(() => s.putArtifact(artifact(wf, 'pr')), /requires a write transaction/);
  });
  assert.equal(s.getArtifact(wf, 'pr'), undefined);
  s.close();
});

test('legacy/foreign id rows are addressed by natural key, not recomputed id', () => {
  const s = mem();
  const wf = randId('wf');
  const now = Date.now();

  // -- artifact: raw-insert a row whose stored id does NOT match what
  // artifactId(wf, 'plan') would compute today (simulating an older engine's
  // id-derivation formula).
  const legacyArtId = 'legacy-art-id-does-not-match-derivation';
  s.db
    .prepare(
      `INSERT INTO artifact
         (id, workflow, path, producer, acceptance, version, value, fingerprint,
          reasons, judgment_rejects, schema_rejects, seal_of, terminal, approvals, updated_at)
       VALUES (@id, @workflow, @path, @producer, @acceptance, @version, @value, @fingerprint,
          @reasons, @judgment_rejects, @schema_rejects, @seal_of, @terminal, @approvals, @updated_at)`,
    )
    .run({
      id: legacyArtId,
      workflow: wf,
      path: 'plan',
      producer: 'maker',
      acceptance: 'owed',
      version: 0,
      value: null,
      fingerprint: null,
      reasons: '[]',
      judgment_rejects: 0,
      schema_rejects: 0,
      seal_of: null,
      terminal: 0,
      approvals: null,
      updated_at: now,
    });

  // Upsert by natural key must not throw UNIQUE constraint failed, and must
  // update the existing legacy-id row rather than colliding.
  assert.doesNotThrow(() => s.putArtifact(artifact(wf, 'plan', { acceptance: 'green', version: 5 })));
  const gotArt = s.getArtifact(wf, 'plan');
  assert.equal(gotArt?.acceptance, 'green');
  assert.equal(gotArt?.version, 5);
  // The surrogate id is preserved across the upsert, never recomputed.
  assert.equal(gotArt?.id, legacyArtId);

  s.deleteArtifact(wf, 'plan');
  assert.equal(s.getArtifact(wf, 'plan'), undefined);

  // -- task: same shape.
  const legacyTaskId = 'legacy-task-id-does-not-match-derivation';
  s.db
    .prepare(
      `INSERT INTO task (id, workflow, step, key, status, run, claimed_at, attempts, alarm_at, heartbeat_at, updated_at)
       VALUES (@id, @workflow, @step, @key, @status, @run, @claimed_at, @attempts, @alarm_at, @heartbeat_at, @updated_at)`,
    )
    .run({
      id: legacyTaskId,
      workflow: wf,
      step: 'build',
      key: '',
      status: 'idle',
      run: null,
      claimed_at: null,
      attempts: 0,
      alarm_at: null,
      heartbeat_at: null,
      updated_at: now,
    });

  assert.doesNotThrow(() =>
    s.putTask({ workflow: wf, step: 'build', key: '', status: 'claimed', attempts: 1 }),
  );
  const gotTask = s.getTask(wf, 'build', '');
  assert.equal(gotTask?.status, 'claimed');
  assert.equal(gotTask?.attempts, 1);
  assert.equal(gotTask?.id, legacyTaskId);

  s.touchHeartbeat(wf, 'build', '', now + 1);
  assert.equal(s.getTask(wf, 'build', '')?.heartbeatAt, now + 1);

  s.setAlarm(wf, 'build', now + 2);
  assert.equal(s.getTask(wf, 'build', '')?.alarmAt, now + 2);

  s.clearAlarm(wf, 'build');
  assert.equal(s.getTask(wf, 'build', '')?.alarmAt, undefined);

  s.close();
});

// ---- a released lease is not a run, for budget or for cadence ---------------
// `released` marks a lease that was handed straight back: the step never ran.
// Public handbacks (capacity, pickup lapse, and the agent-lane release path)
// increment the task's lease-churn `attempts` counter so status makes repeated
// handbacks visible. The private born-reject/CAS release remains separate and
// does not increment attempts. Neither kind of release consumes the run budget
// or cadence clock.
//
// `no_work` is the opposite case and stays counted — the step DID run and found
// nothing to produce. A `merge-gate` polling CI is the canonical one: if its
// runs stopped spending budget and stopped restarting the cadence clock, a
// throttled poller would poll flat out.
//
// Conflating the two was a live stall. A server sitting at its agent ceiling
// released a `maxRunsPerDay: 6` planner six times in a row; the budget hit zero
// and the engine deferred the step `daily-budget` until local midnight — with
// its artifact still at `attemptsUsed: 0`, because the release path already
// declines to bump attempts for exactly this reason. Two budgets measuring the
// same thing disagreed, and the wrong one was the one with no work behind it.
// The artifact's `attemptsUsed` still stays at 0: it tracks judgment rework,
// not public lease churn.

test('countRuns: released leases do not spend the daily budget', () => {
  const s = mem();
  const wf = randId('wf');
  const runs = [randId('run'), randId('run'), randId('run')];
  for (const r of runs) s.insertRun(r, { workflow: wf, step: 'planner' });
  assert.equal(s.countRuns(wf, 'planner', 0), 3, 'open runs count — the step is live');

  s.updateRun(runs[0]!, { outcome: 'released' });
  s.updateRun(runs[1]!, { outcome: 'released' });
  assert.equal(s.countRuns(wf, 'planner', 0), 1, 'two handbacks spend nothing');

  s.updateRun(runs[2]!, { outcome: 'ok' });
  assert.equal(s.countRuns(wf, 'planner', 0), 1, 'the one run that worked still counts');
});

test('countRuns: a step released on every claim never exhausts its budget', () => {
  const s = mem();
  const wf = randId('wf');
  // The exact live shape: six consecutive capacity handbacks against a step
  // whose maxRunsPerDay is 6. Before the fix this left budget === 0.
  for (let i = 0; i < 6; i += 1) {
    const r = randId('run');
    s.insertRun(r, { workflow: wf, step: 'planner' });
    s.updateRun(r, { outcome: 'released' });
  }
  assert.equal(s.countRuns(wf, 'planner', 0), 0, 'six handbacks leave the full allowance');
});

test('countRuns: every other closed outcome still counts, no_work included', () => {
  const s = mem();
  const wf = randId('wf');
  for (const outcome of ['ok', 'no_work', 'failed', 'skipped'] as const) {
    const r = randId('run');
    s.insertRun(r, { workflow: wf, step: 'builder' });
    s.updateRun(r, { outcome });
  }
  assert.equal(s.countRuns(wf, 'builder', 0), 4, 'only a released lease is exempt');
});

test('latestRun: a released lease does not restart the cadence clock', () => {
  const s = mem();
  const wf = randId('wf');
  const released = randId('run');
  s.insertRun(released, { workflow: wf, step: 'merge-gate' });
  assert.equal(s.latestRun(wf, 'merge-gate')?.id, released, 'an open claim is the latest run');

  s.updateRun(released, { outcome: 'released' });
  assert.equal(
    s.latestRun(wf, 'merge-gate'),
    undefined,
    'once released it is not a run at all — cadence sees no prior firing',
  );
});

test('latestRun: a no_work run is still the cadence anchor', () => {
  const s = mem();
  const wf = randId('wf');
  const polled = randId('run');
  s.insertRun(polled, { workflow: wf, step: 'merge-gate' });
  s.updateRun(polled, { outcome: 'no_work' });
  assert.equal(
    s.latestRun(wf, 'merge-gate')?.id,
    polled,
    'a poll that found CI still pending did run — it throttles the next one',
  );
});

// U1 native dispatch state is independent of the frozen signed Order.
const dispatchLane = { id: 'lane', slot: 'slot-1', executorKind: 'agent', capacity: 1,
  revision: 'authority-1', expiresAt: 1000 } as const;
function dispatchRun(s: Store, id: string, workflow = 'wf') {
  s.insertRun(id, { workflow, step: 'work' }, 10);
  s.putTask({ workflow, step: 'work', key: '', status: 'claimed', run: id, claimedAt: 10, attempts: 0 });
  return { run: id };
}

test('dispatch slots require a write transaction and consume one actual run atomically', () => {
  const s = mem();
  assert.throws(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10, () => dispatchRun(s, 'r1')), /write transaction/);
  const result = s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10, () => dispatchRun(s, 'r1')));
  assert.deepEqual(result, { run: 'r1' });
  assert.equal(s.dispatchLaneUsage('lane'), 1);
  assert.equal(s.getDispatchSlot('lane', 'slot-1')?.run, 'r1');
  assert.equal(s.tx(() => s.withDispatchSlot({ ...dispatchLane, slot: 'slot-2' }, 'b'.repeat(64), 10,
    () => dispatchRun(s, 'r2'))), undefined);
  assert.equal(s.getRun('r2'), undefined);
  s.updateRun('r1', { outcome: 'released' });
  assert.equal(s.dispatchLaneUsage('lane'), 0);
  assert.equal(s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10,
    () => dispatchRun(s, 'r3'))), undefined);
  assert.equal(s.getRun('r3'), undefined);
  assert.deepEqual(s.tx(() => s.withDispatchSlot({ ...dispatchLane, slot: 'slot-2' }, 'b'.repeat(64), 10,
    () => dispatchRun(s, 'r2'))), { run: 'r2' });
  s.close();
});

test('dispatch failure after run creation rolls back every claim effect and permits a fresh attempt', () => {
  const s = mem();
  s.db.exec(`CREATE TRIGGER fail_dispatch BEFORE INSERT ON dispatch_slot BEGIN SELECT RAISE(ABORT, 'injected dispatch failure'); END`);
  assert.throws(() => s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10, () => dispatchRun(s, 'r1'))), /injected dispatch failure/);
  assert.equal(s.getRun('r1'), undefined);
  assert.deepEqual(s.listTasks('wf'), []);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM dispatch_lane').get()!.n, 0);
  assert.equal(s.getDispatchSlot('lane', 'slot-1'), undefined);
  s.db.exec('DROP TRIGGER fail_dispatch');
  assert.deepEqual(s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10, () => dispatchRun(s, 'r1'))), { run: 'r1' });
  s.close();
});

// Genuine native schema13 DDL captured from reviewed foundation 820825a9.
// This fixture never opens a current Store first or relabels newer storage.
const NATIVE_SCHEMA_13 = `CREATE TABLE workflow (
  id          TEXT PRIMARY KEY,
  def         TEXT NOT NULL,
  title       TEXT,
  params      TEXT NOT NULL DEFAULT '{}',
  modifier    TEXT,
  meta        TEXT,
  interface_bindings TEXT,
  created_at  INTEGER NOT NULL
, produced_by_wf TEXT, produced_by_path TEXT, produced_by_invocation TEXT REFERENCES call_invocation(id), def_snapshot TEXT, def_hash TEXT);
CREATE TABLE artifact (
  id               TEXT PRIMARY KEY,
  workflow         TEXT NOT NULL,
  path             TEXT NOT NULL,
  producer         TEXT NOT NULL,
  acceptance       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0,
  value            TEXT,
  fingerprint      TEXT,
  reasons          TEXT NOT NULL DEFAULT '[]',
  judgment_rejects INTEGER NOT NULL DEFAULT 0,
  schema_rejects   INTEGER NOT NULL DEFAULT 0,
  seal_of          TEXT,
  terminal         INTEGER NOT NULL DEFAULT 0,
  approvals        TEXT,
  updated_at       INTEGER NOT NULL,
  UNIQUE (workflow, path)
);
CREATE INDEX artifact_wf ON artifact (workflow);
CREATE INDEX artifact_wf_accept ON artifact (workflow, acceptance);
CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  producer TEXT NOT NULL,
  value TEXT,
  fingerprint TEXT,
  initial_acceptance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workflow, path, version)
);
CREATE INDEX artifact_version_wf_path ON artifact_version (workflow, path, version);
CREATE TABLE artifact_event (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  kind TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX artifact_event_wf_path_version_at ON artifact_event (workflow, path, version, created_at, id);
CREATE TABLE task (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  step        TEXT NOT NULL,
  key         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idle',
  run         TEXT,
  claimed_at  INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  alarm_at    INTEGER,
  heartbeat_at INTEGER,
  updated_at  INTEGER NOT NULL,
  UNIQUE (workflow, step, key)
);
CREATE INDEX task_wf ON task (workflow);
CREATE INDEX task_claimed ON task (status, claimed_at);
CREATE TABLE run (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  step        TEXT NOT NULL,
  key         TEXT NOT NULL DEFAULT '',
  outcome     TEXT,
  summary     TEXT,
  session_id  TEXT,
  fingerprint TEXT,
  cause       TEXT,
  -- The flattened order packet issued at claim time (§8 / Gap 1), JSON in TEXT
  -- (precedent: fingerprint, def_snapshot). Named order_json, NOT order — ORDER
  -- is a reserved SQL keyword. Nullable: absent on runs created before v7.
  order_json  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX run_wf_step ON run (workflow, step, created_at);
CREATE INDEX run_wf_step_key ON run (workflow, step, key, created_at);
CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE run_admission (
      root_workflow TEXT PRIMARY KEY REFERENCES workflow(id) ON DELETE CASCADE,
      epoch INTEGER NOT NULL CHECK(epoch >= 0), active INTEGER NOT NULL CHECK(active IN (0,1))
    );
CREATE TABLE call_invocation (
      id TEXT PRIMARY KEY,
      parent_workflow TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
      key_digest TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL
    );
CREATE TRIGGER call_invocation_immutable BEFORE UPDATE ON call_invocation
      BEGIN SELECT RAISE(ABORT, 'call_invocation is immutable'); END;
CREATE TRIGGER call_invocation_append_only BEFORE DELETE ON call_invocation
      WHEN EXISTS (SELECT 1 FROM workflow WHERE id = OLD.parent_workflow)
      BEGIN SELECT RAISE(ABORT, 'call_invocation is append-only'); END;
CREATE TRIGGER workflow_invocation_link BEFORE INSERT ON workflow
      WHEN NEW.produced_by_invocation IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM call_invocation WHERE id = NEW.produced_by_invocation
	  AND parent_workflow = NEW.produced_by_wf AND json_extract(body, '$.key.callPath') = NEW.produced_by_path)
      BEGIN SELECT RAISE(ABORT, 'invalid invocation child linkage'); END;
CREATE TRIGGER workflow_invocation_immutable BEFORE UPDATE OF produced_by_invocation ON workflow
      WHEN NEW.produced_by_invocation IS NOT OLD.produced_by_invocation
      BEGIN SELECT RAISE(ABORT, 'invocation child linkage is immutable'); END;
CREATE UNIQUE INDEX workflow_invocation_unique ON workflow(produced_by_invocation)
      WHERE produced_by_invocation IS NOT NULL;
CREATE INDEX workflow_produced_by ON workflow(produced_by_wf, produced_by_path);
CREATE UNIQUE INDEX workflow_produced_by_unique
	   ON workflow(produced_by_wf, produced_by_path)
	   WHERE produced_by_wf IS NOT NULL AND produced_by_path IS NOT NULL AND produced_by_invocation IS NULL;`;

function schema13Database(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(NATIVE_SCHEMA_13);
  db.prepare('INSERT INTO meta(k,v) VALUES (?,?)').run('schema_version', '13');
  db.prepare('INSERT INTO workflow(id,def,created_at) VALUES (?,?,?)').run('legacy', 'delivery', 1);
  db.prepare('INSERT INTO run(id,workflow,step,created_at,updated_at) VALUES (?,?,?,?,?)').run('legacy-run', 'legacy', 'work', 1, 1);
  db.prepare('INSERT INTO run_admission(root_workflow,epoch,active) VALUES (?,?,?)').run('legacy', 7, 1);
  const contract = { name: 'work', version: '1', selection: 'invocation' as const,
    signature: { inputs: [], outputs: [{ name: 'result', schema: true }] },
    policy: { name: 'local', version: '1', config: {} } };
  const candidate = { target: 'worker/worker@1.0.0', DefRef: { bundleDigest: 'b'.repeat(64), workflowName: 'worker' } };
  const candidates = [{ candidate, assessment: { kind: 'eligible' as const } }];
  const body = { key: { parentWorkflow: 'legacy', parentDefRef: { bundleDigest: 'a'.repeat(64), workflowName: 'delivery' },
    callPath: 'child', evidenceDigest: evidenceDigest([]) }, contract, evidence: [], candidates,
    candidateSetDigest: candidateSetDigest(candidates), policyDigest: valueDigestHex(contract.policy),
    selected: { ...candidate, signature: contract.signature }, admission: { rootWorkflow: 'legacy', epoch: 7 } };
  const binding: InvocationBinding = { ...body, id: invocationId(body) };
  db.prepare('INSERT INTO call_invocation(id,parent_workflow,key_digest,body) VALUES (?,?,?,?)')
    .run(binding.id, 'legacy', valueDigestHex(binding.key), JSON.stringify(binding));
  return db;
}

test('native schema13 migrates without relabeling or rewriting workflow/run/invocation/admission data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-migrate-'));
  const path = join(dir, 'state.db');
  const raw = schema13Database(path);
  const tables = ['workflow', 'run', 'run_admission', 'call_invocation'];
  const before = tables.map(t => raw.prepare(`SELECT * FROM ${t}`).all());
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'dispatch_slot'").get(), undefined);
  raw.close();
  for (let i = 0; i < 2; i++) {
    const s = new Store(path);
    assert.equal(s.getMeta('schema_version'), '15');
    assert.deepEqual(tables.map(t => s.db.prepare(`SELECT * FROM ${t}`).all()), before);
    assert.deepEqual(s.getAdmission('legacy'), { rootWorkflow: 'legacy', epoch: 7, active: true });
    assert.equal(s.getRun('legacy-run')!.order, undefined);
    assert.equal(s.listInvocations('legacy')[0]!.admission.epoch, 7);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM dispatch_slot').get()!.n, 0);
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test('schema13 dispatch migration failure rolls back DDL and version, then retries cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-migrate-fail-'));
  const path = join(dir, 'state.db');
  const raw = schema13Database(path);
  raw.exec("CREATE TRIGGER fail_v14 BEFORE UPDATE ON meta WHEN NEW.k = 'schema_version' BEGIN SELECT RAISE(ABORT, 'migration injected'); END");
  raw.close();
  assert.throws(() => new Store(path), /migration injected/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get()!.v, '13');
  assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'dispatch_%'").get(), undefined);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM run').get()!.n, 1);
  check.exec('DROP TRIGGER fail_v14');
  check.close();
  const s = new Store(path);
  assert.equal(s.getMeta('schema_version'), '15');
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('dispatch restart, close and cleanup preserve slot tombstones and prohibit run identity reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-restart-'));
  const path = join(dir, 'state.db');
  let s = new Store(path);
  s.insertWorkflow('wf', { def: 'flow' });
  s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10, () => dispatchRun(s, 'r1')));
  s.close();
  s = new Store(path);
  assert.equal(s.dispatchLaneUsage('lane'), 1);
  const receipt = s.getDispatchSlot('lane', 'slot-1');
  assert.throws(() => s.db.exec("DELETE FROM dispatch_slot"), /append-only/);
  assert.throws(() => s.db.exec("UPDATE dispatch_slot SET slot = 'other'"), /immutable/);
  s.updateRun('r1', { outcome: 'ok' });
  assert.equal(s.dispatchLaneUsage('lane'), 0);
  s.tx(() => s.deleteWorkflow('wf'));
  assert.equal(s.getRun('r1'), undefined);
  s.close();
  s = new Store(path);
  assert.deepEqual(s.getDispatchSlot('lane', 'slot-1'), receipt);
  assert.equal(s.tx(() => s.withDispatchSlot(dispatchLane, 'b'.repeat(64), 10, () => dispatchRun(s, 'r2'))), undefined);
  assert.throws(() => dispatchRun(s, 'r1'), /consumed dispatch run identity/);
  assert.equal(s.getRun('r2'), undefined);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('invalid and corrupt native dispatch authority refuses without spending a slot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-corrupt-'));
  const path = join(dir, 'state.db');
  const s = new Store(path);
  for (const change of [{ capacity: 0 }, { capacity: 1.5 }, { id: '' }, { revision: '' }]) {
    assert.throws(() => s.tx(() => s.withDispatchSlot({ ...dispatchLane, ...change }, 'a'.repeat(64), 10,
      () => dispatchRun(s, 'r1'))), /invalid native dispatch claim/);
  }
  assert.equal(s.getRun('r1'), undefined);
  assert.throws(() => s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10,
    () => ({ run: 'made-up' }))), /actual active run/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM dispatch_lane').get()!.n, 0);
  s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10, () => dispatchRun(s, 'r1')));
  assert.throws(() => s.db.exec('UPDATE dispatch_lane SET capacity = 0'), /CHECK constraint/);
  s.db.exec('PRAGMA ignore_check_constraints = ON; UPDATE dispatch_lane SET capacity = 0');
  assert.throws(() => s.tx(() => s.withDispatchSlot({ ...dispatchLane, slot: 'slot-2' }, 'a'.repeat(64), 10,
    () => dispatchRun(s, 'r2'))), /corrupt native dispatch state/);
  assert.equal(s.getRun('r2'), undefined);
  s.close();
  assert.throws(() => new Store(path), /corrupt native dispatch state/);
  rmSync(dir, { recursive: true, force: true });
});

test('dispatch storage refuses direct oversubscription and synthetic active-run identities', () => {
  const s = mem();
  s.tx(() => s.withDispatchSlot(dispatchLane, 'a'.repeat(64), 10, () => dispatchRun(s, 'r1')));
  // A low-level writer cannot bypass the same lane bound using a different
  // Store method. Both a synthetic identity and an extra genuine run refuse.
  const insert = s.db.prepare('INSERT INTO dispatch_slot(lane_id,slot,run_id,plan_digest,consumed_at) VALUES (?,?,?,?,?)');
  assert.throws(() => insert.run('lane', 'fake', 'missing', 'b'.repeat(64), 10), /active run/);
  assert.throws(() => s.tx(() => {
    dispatchRun(s, 'r2', 'wf2');
    insert.run('lane', 'slot-2', 'r2', 'b'.repeat(64), 10);
  }), /lane capacity/);
  assert.equal(s.getRun('r2'), undefined);
  assert.equal(s.getDispatchSlot('lane', 'slot-2'), undefined);
  assert.equal(s.dispatchLaneUsage('lane'), 1);
  s.close();
});
