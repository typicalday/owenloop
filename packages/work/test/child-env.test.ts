/**
 * PHASE 6, ITEMS 3 + 5 — the `OWENWORK_*` namespace allowlist itself.
 *
 * The adapter tests assert that each adapter APPLIES this filter. This file
 * asserts what the filter IS, independent of any harness, because the design
 * argument for it is a property of its shape rather than of any one call site:
 *
 *   the filter governs the `OWENWORK_*` namespace and NOTHING else, and inside
 *   that namespace it denies by default.
 *
 * The second half is what stops a future `OWENWORK_*` variable from silently
 * flowing to harness children. The first half is what makes the whole design
 * safe: the credential variables a harness needs in order to start are not in
 * owenwork's namespace, so no edit to the admitted set can strand one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ADMITTED_OWENWORK_KEYS,
  filterOwenworkEnv,
  isAdmittedChildEnvKey,
} from '../src/harness/child-env.ts';

test('the admitted set is exactly the three names with a reachable child consumer', () => {
  // Pinned as a LIST, not a count: growing this set is a deliberate act that
  // must show up in a diff next to the consumer that justifies it.
  assert.deepEqual(
    [...ADMITTED_OWENWORK_KEYS].sort(),
    ['OWENWORK_CACHE_DIR', 'OWENWORK_CONDUCTOR_ID', 'OWENWORK_SESSION'],
    'each admitted name needs a consumer a harness child can actually reach — ' +
      'see the derivation in src/harness/child-env.ts',
  );
  assert.equal(
    ADMITTED_OWENWORK_KEYS.has('OWENWORK_TOKEN'),
    false,
    'the dev-only hub bearer override is the whole point of the denial (item 5)',
  );
});

test('everything outside the OWENWORK_ namespace passes through untouched', () => {
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
  assert.deepEqual(filterOwenworkEnv(source), source);
});

test('inside the namespace the filter denies by default', () => {
  const out = filterOwenworkEnv({
    OWENWORK_CACHE_DIR: '/cache',
    OWENWORK_CONDUCTOR_ID: 'cond-1',
    OWENWORK_SESSION: 'sess-1',
    OWENWORK_TOKEN: 'tok',
    OWENWORK_ACCOUNT: 'acct',
    OWENWORK_STATE_DIR: '/state',
    OWENWORK_HARNESS: 'x',
    OWENWORK_LIVE_TESTS: '1',
    // The case that matters most: a name nobody has thought of yet.
    OWENWORK_INVENTED_NEXT_PHASE: 'surprise',
  });
  assert.deepEqual(out, {
    OWENWORK_CACHE_DIR: '/cache',
    OWENWORK_CONDUCTOR_ID: 'cond-1',
    OWENWORK_SESSION: 'sess-1',
  });
});

test('the filter copies rather than mutating, and uses delete rather than undefined', () => {
  const source: Record<string, string | undefined> = { OWENWORK_TOKEN: 'tok', PATH: '/usr/bin' };
  const out = filterOwenworkEnv(source);
  assert.notEqual(out, source);
  assert.deepEqual(source, { OWENWORK_TOKEN: 'tok', PATH: '/usr/bin' }, 'input must not be mutated');
  // An own key holding `undefined` is not obviously an absent key once it
  // crosses a spawn boundary, so the key must be GONE, not merely falsy.
  assert.equal('OWENWORK_TOKEN' in out, false);
});

test('isAdmittedChildEnvKey agrees with the filter, name by name', () => {
  for (const key of ['PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'OWENWORK_SESSION', 'OWENWORK_TOKEN', 'OWENWORKISH']) {
    const survived = key in filterOwenworkEnv({ [key]: 'v' });
    assert.equal(isAdmittedChildEnvKey(key), survived, `disagreement about '${key}'`);
  }
  // A name that merely STARTS with the letters is still outside the namespace,
  // because the namespace includes the underscore.
  assert.equal(isAdmittedChildEnvKey('OWENWORKISH'), true);
});
