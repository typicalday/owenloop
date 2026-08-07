/**
 * PHASE 6, ITEMS 3 + 5 — the `OWENLOOP_*` namespace allowlist itself.
 *
 * The adapter tests assert that each adapter APPLIES this filter. This file
 * asserts what the filter IS, independent of any harness, because the design
 * argument for it is a property of its shape rather than of any one call site:
 *
 *   the filter governs the `OWENLOOP_*` namespace and NOTHING else, and inside
 *   that namespace it denies by default.
 *
 * The second half is what stops a future `OWENLOOP_*` variable from silently
 * flowing to harness children. The first half is what makes the whole design
 * safe: the nine explicitly consumed child inputs are admitted, while the bearer
 * and helper-only credential names remain denied.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADMITTED_OWENLOOP_KEYS,
  filterOwenloopEnv,
  isAdmittedChildEnvKey,
} from '../src/harness/child-env.ts';

test('the admitted set is exactly the nine names with a reachable child consumer', () => {
  // Pinned as a LIST, not a count: growing this set is a deliberate act that
  // must show up in a diff next to the consumer that justifies it.
  assert.deepEqual(
    [...ADMITTED_OWENLOOP_KEYS].sort(),
    [
      'OWENLOOP_BUNDLE_DIR',
      'OWENLOOP_CACHE_DIR',
      'OWENLOOP_CREDENTIAL_COMMAND',
      'OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS',
      'OWENLOOP_NO_KEYCHAIN',
      'OWENLOOP_RUN',
      'OWENLOOP_SESSION',
      'OWENLOOP_SHIFT_ID',
      'OWENLOOP_WORKFLOW',
    ],
    'each admitted name needs a consumer a harness child can actually reach — ' +
      'see the derivation in src/harness/child-env.ts',
  );
  assert.equal(
    ADMITTED_OWENLOOP_KEYS.has('OWENLOOP_TOKEN'),
    false,
    'the dev-only hub bearer override is the whole point of the denial (item 5)',
  );
  assert.equal(ADMITTED_OWENLOOP_KEYS.has('OWENLOOP_CREDENTIAL_ORIGIN'), false);
  assert.equal(ADMITTED_OWENLOOP_KEYS.has('OWENLOOP_CREDENTIAL_SLOT'), false);
});

test('everything outside the OWENLOOP_ namespace passes through untouched', () => {
  // The credential variable item 3 must not strand, plus the variables without
  // which no harness binary starts at all, plus one arbitrary third-party name.
  const source = {
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-oai',
    PATH: '/usr/bin',
    HOME: '/home/x',
    TMPDIR: '/tmp',
    NODE_OPTIONS: '--max-old-space-size=4096',
    HTTPS_PROXY: 'http://proxy:3128',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    SOMEONE_ELSES_TOKEN: 'not-ours',
  };
  assert.deepEqual(filterOwenloopEnv(source), source);
});

test('inside the namespace the nine admitted inputs survive and everything else is denied', () => {
  const out = filterOwenloopEnv({
    OWENLOOP_BUNDLE_DIR: '/bundle',
    OWENLOOP_CACHE_DIR: '/cache',
    OWENLOOP_SHIFT_ID: 'cond-1',
    OWENLOOP_CREDENTIAL_COMMAND: '/bin/credential-helper',
    OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS: '2500',
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENLOOP_RUN: 'run-1',
    OWENLOOP_SESSION: 'sess-1',
    OWENLOOP_WORKFLOW: 'wf-1',
    OWENLOOP_TOKEN: 'tok',
    OWENLOOP_ACCOUNT: 'acct',
    OWENLOOP_STATE_DIR: '/state',
    OWENLOOP_HARNESS: 'x',
    OWENLOOP_CREDENTIAL_ORIGIN: 'https://helper.example',
    OWENLOOP_CREDENTIAL_SLOT: 'agent:holder',
    // The case that matters most: a name nobody has thought of yet.
    OWENLOOP_INVENTED_NEXT_PHASE: 'surprise',
  });
  assert.deepEqual(out, {
    OWENLOOP_BUNDLE_DIR: '/bundle',
    OWENLOOP_CACHE_DIR: '/cache',
    OWENLOOP_SHIFT_ID: 'cond-1',
    OWENLOOP_CREDENTIAL_COMMAND: '/bin/credential-helper',
    OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS: '2500',
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENLOOP_RUN: 'run-1',
    OWENLOOP_SESSION: 'sess-1',
    OWENLOOP_WORKFLOW: 'wf-1',
  });
});

test('the filter copies rather than mutating, and uses delete rather than undefined', () => {
  const source: Record<string, string | undefined> = { OWENLOOP_TOKEN: 'tok', PATH: '/usr/bin' };
  const out = filterOwenloopEnv(source);
  assert.notEqual(out, source);
  assert.deepEqual(source, { OWENLOOP_TOKEN: 'tok', PATH: '/usr/bin' }, 'input must not be mutated');
  // An own key holding `undefined` is not obviously an absent key once it
  // crosses a spawn boundary, so the key must be GONE, not merely falsy.
  assert.equal('OWENLOOP_TOKEN' in out, false);
});

test('isAdmittedChildEnvKey agrees with the filter, name by name', () => {
  for (const key of [
    'PATH',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OWENLOOP_BUNDLE_DIR',
    'OWENLOOP_CACHE_DIR',
    'OWENLOOP_RUN',
    'OWENLOOP_SHIFT_ID',
    'OWENLOOP_CREDENTIAL_COMMAND',
    'OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS',
    'OWENLOOP_NO_KEYCHAIN',
    'OWENLOOP_SESSION',
    'OWENLOOP_TOKEN',
    'OWENLOOP_WORKFLOW',
    'OWENLOOP_INVENTED_NEXT_PHASE',
    'OWENLOOP_CREDENTIAL_ORIGIN',
    'OWENLOOP_CREDENTIAL_SLOT',
    'OWENLOOPISH',
  ]) {
    const survived = key in filterOwenloopEnv({ [key]: 'v' });
    assert.equal(isAdmittedChildEnvKey(key), survived, `disagreement about '${key}'`);
  }
  // A name that merely STARTS with the letters is still outside the namespace,
  // because the namespace includes the underscore.
  assert.equal(isAdmittedChildEnvKey('OWENLOOPISH'), true);
});
