import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createConsumedVerifier } from '../src/consumed-verifier.ts';
import type { OrderPacket } from '../src/hub/types.ts';
import { routedProducerVerifier } from '../src/roles/routing-producer-verifier.ts';

for (const worker of ['command', 'agent'] as const) {
  test(`routed ${worker} filtered producer proof is hard required and forged proof refuses`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'ol-routed-producer-'));
    try {
      const config = join(home, '.owenloop');
      mkdirSync(config, { mode: 0o700 });
      writeFileSync(join(config, 'org-root.pub'),
	`ssh-ed25519 ${Buffer.alloc(32, 7).toString('base64')} fixture-root\n`, { mode: 0o600 });
      const verify = routedProducerVerifier(createConsumedVerifier({
	env: { HOME: home }, now: () => 100, artifactPolicy: 'enforce' }));
      // This is the producer-only view produced by v2 after the full signed
      // step and human seed have been bound. The worker type cannot weaken it.
      const packet: OrderPacket = { workflow: 'wf_child', run: 'run', step: 'build', key: '',
	defDigest: 'a'.repeat(64), worker, inputs: ['seed', 'plan'], outputs: ['out'],
	consumes: { plan: { value: 'from producer' } },
	consumedFingerprint: { plan: 1 },
	owes: [{ path: 'out', version: 1, judgmentRejects: 0,
	  schemaRejects: 0, reasons: [] }] };
      const signedCalls = {};
      const forwarded = await routedProducerVerifier(async (order, opts) => {
	assert.equal(opts.hardRule, true);
	assert.equal(opts.callsProducers, signedCalls);
	return { ok: true, order, warnings: [] };
      })(packet, { hardRule: false, callsProducers: signedCalls });
      assert.equal(forwarded.ok, true);
      const missing = await verify(packet, { hardRule: false, callsProducers: {} });
      assert.equal(missing.ok, false);
      const forged = await verify({ ...packet,
	consumesProof: JSON.stringify({ plan: 'forged-producer-record' }) },
      { hardRule: false, callsProducers: {} });
      assert.equal(forged.ok, false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
