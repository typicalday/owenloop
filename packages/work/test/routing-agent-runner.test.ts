import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareRoutedAgentRunner } from '../src/roles/routing-agent-runner.ts';
import type { RoutingHandoffV1 } from '../src/shift/runtime.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ol-agent-runner-'));
  const stageBase = join(root, '.routing-definitions');
  mkdirSync(stageBase, { mode: 0o700 });
  const stagePath = mkdtempSync(join(stageBase, '.routing-def-'));
  for (const name of ['public', 'home']) mkdirSync(join(stagePath, name), { mode: 0o700 });
  chmodSync(stagePath, 0o700);
  const digest = 'a'.repeat(64);
  writeFileSync(join(stagePath, 'stage.json'), JSON.stringify({
    version: 'routing-definition-stage-v2', rootWorkflow: 'wf', frameWorkflow: 'wf',
    definitionName: 'wf', run: 'run', step: 'build',
    digest, bundleDigest: 'b'.repeat(64), nonce: 'c'.repeat(32), originRules: {},
  }), { mode: 0o600 });
  const now = Date.now();
  const socketPath = join(tmpdir(), 'ol-rb-ABCDEF', 'broker.sock');
  const handoff = {
    version: 'routing-handoff-v1', incarnation: `inc_${'a'.repeat(32)}`,
    nonce: 'b'.repeat(32), origin: 'https://hub.example.test', orgId: 'org',
    sessionId: 'rs_12345678-1234-1234-1234-123456789abc', shiftId: 'shf_service',
    broker: { socketPath, cap: 'd'.repeat(64) },
    holderBroker: { socketPath, cap: 'e'.repeat(64) },
    definitionStage: { path: stagePath, digest }, workRoot: join(root, 'work'),
    reservation: { recordType: 'reservation', workflow: 'wf', run: 'run',
      childKind: 'agent-run', token: 'f'.repeat(32), reservedAt: now },
    createdAt: now, expiresAt: now + 120_000, sessionExpiresAt: now + 900_000,
  } as RoutingHandoffV1;
  return { root, stagePath, handoff };
}

test('routed runner preparation uses public stage without changing ambient credentials', async () => {
  const f = fixture();
  try {
    const ambient = { HOME: '/operator/home', OWENLOOP_TOKEN: 'operator-bearer',
      OWENLOOP_CREDENTIAL_COMMAND: 'operator-command' };
    await prepareRoutedAgentRunner({ handoff: f.handoff, originalEnv: ambient,
      out: () => {}, err: () => {} });
    assert.equal(ambient.OWENLOOP_TOKEN, 'operator-bearer');
    assert.equal(readdirSync(f.stagePath).filter(name => name.startsWith('ol-rfc-')).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('runner preparation failure after cache allocation removes cache bytes', async () => {
  const f = fixture();
  try {
    const args = { handoff: f.handoff, originalEnv: { HOME: '/operator/home' },
      out: () => {}, err: () => {} } as Parameters<typeof prepareRoutedAgentRunner>[0];
    Object.defineProperty(args, 'heartbeatIntervalMs', { get: () => { throw new Error('late setup'); } });
    await assert.rejects(prepareRoutedAgentRunner(args), /routed agent role refused/);
    assert.equal(readdirSync(f.stagePath).filter(name => name.startsWith('ol-rfc-')).length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
