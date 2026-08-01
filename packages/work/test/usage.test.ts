import assert from 'node:assert/strict';
import { test } from 'node:test';

import { USAGE } from '../src/usage.ts';
import { slotArg } from '../src/credentials/resolve.ts';

// Drift guard: the USAGE string is the single source for `--help` (stdout) and
// dispatch-error output (stderr). It must keep describing the agent-account
// model and the connect flow, and it must stay CONSISTENT with the runnable
// hint that `resolveBearer`'s refuse prints (`resolve.ts`). If either side is
// reworded without the other, one of these assertions fails.

test('USAGE surfaces the agent-account model (agent slot, default account)', () => {
  assert.match(USAGE, /agent:<account>/, 'help should name the agent:<account> slot');
  assert.match(USAGE, /never the human slot/, 'help should say owenwork never reads the human slot');
  assert.match(USAGE, /defaults to 'default'/, "help should state the account defaults to 'default'");
});

test('USAGE names the concrete owenloop connect command in both slot forms', () => {
  // The store-write lives in owenloop; owenwork only points at it. Assert the
  // exact command shape and both `--as` forms the refuse hint can print.
  assert.match(
    USAGE,
    /owenloop login --hub <origin> --as agent:<account>/,
    'help should show the concrete connect command',
  );
  assert.match(USAGE, /--as agent for the default account/, 'help should show the default-account form');
});

test('USAGE connect shape stays consistent with the resolve.ts refuse hint', () => {
  // The refuse hint substitutes slotArg(account): `agent` for default,
  // `agent:<account>` otherwise. Both forms the help documents must be exactly
  // what slotArg produces, so help and refuse can never silently drift.
  assert.equal(slotArg('default'), 'agent');
  assert.equal(slotArg('ci'), 'agent:ci');
  assert.match(USAGE, /--as agent:<account>/, 'help must show the non-default slotArg form');
  assert.match(USAGE, /--as agent\b/, 'help must show the default slotArg form');
});

test('USAGE carries the honest "does not list accounts" note', () => {
  assert.match(USAGE, /does NOT list stored accounts/, 'help should state owenwork cannot list accounts');
  assert.match(USAGE, /owenloop-side capability/, 'help should attribute listing to owenloop');
});

// W1 drift guard: `join` must be documented as the one-time provisioning
// writer exception, without breaking any of the read-only phrases pinned
// above (those assertions still run unchanged).
test('USAGE documents join as the one-time provisioning writer exception', () => {
  assert.match(USAGE, /owenloop work join <code>/, 'help should show the join command shape');
  assert.match(USAGE, /one-time provisioning|provisioning-time writer/, 'help should call out join as provisioning, not runtime');
});

// ---- Phase 3: agent-run + runner dispatch are documented --------------------

test('USAGE documents the agent-run role, its harness flag, and the hub-is-truth grace', () => {
  assert.match(USAGE, /owenloop work agent-run <order-id>/);
  assert.match(USAGE, /agent-run options/);
  assert.match(USAGE, /--harness <id>/);
  assert.match(USAGE, /--submit-grace <ms>/);
  assert.match(USAGE, /--confirm-interval <ms>/);
  // The invariant, stated where an operator will actually read it.
  assert.match(USAGE, /Task completion comes from the HUB, never/);
  assert.match(USAGE, /OWENWORK_HARNESS\b/);
});

test('USAGE documents --max-agents and maxConcurrentAgents, and no deleted stamp-path knob', () => {
  assert.match(USAGE, /--max-agents <n>/);
  assert.match(USAGE, /default 4; else settings\.maxConcurrentAgents/);
  assert.match(USAGE, /maxConcurrentAgents, workRoot/);
  // Phase 5 deleted the stamp path; its flags, env var, and settings keys must
  // not survive in the one place operators read to learn what exists.
  for (const gone of ['--runner-dispatch', '--no-stamp', '--settle-margin', '--agents-dir', 'OWENWORK_AGENTS_DIR', 'runnerDispatch', 'agentsDir']) {
    assert.equal(USAGE.includes(gone), false, `USAGE must not mention ${gone}`);
  }
});
