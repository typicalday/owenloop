/**
 * Public remote `owenloop start` command. Hermetic: all credentials live in a
 * fake keychain and every hub request uses the injected route table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import type { Credential, Keychain } from '../src/hub.ts';
import { kcHuman, makeIo, routedFetch } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const OTHER_ORIGIN = 'http://127.0.0.1:10';
const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_start_fixture',
  refreshToken: 'rt_start_fixture',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'client_start_fixture',
};

const STARTED = {
  text: 'Started newhire-onboarding as wf_public. done=false',
  workflow: 'wf_public',
  def: 'newhire-onboarding',
  status: { done: false, debts: ['signed_docs', 'hardware_choice'] },
  stampedCrews: [
    { step: 'welcome', crews: ['openai'] },
    { step: 'provisioning', crews: ['openai'] },
    { step: 'day_one', crews: ['openai'] },
  ],
  validatedCrews: [],
};

function bind(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('start: bound-project happy path posts inputs and crew with the human credential', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: STARTED }),
  });
  const t = makeIo({ fetch, env: { OWENLOOP_HUB: 'https://api.owenloop.com' } });
  bind(t);

  const code = await mainAsync([
    'start',
    'newhire-onboarding',
    '--crew',
    'openai',
    '--title',
    'Public CLI proof',
    '--provide',
    'signed_docs={"acknowledged":true}',
    '--provide',
    'hardware_choice={"laptop":"MacBook Pro"}',
  ], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/start_run`, 'the project binding wins over ambient OWENLOOP_HUB');
  assert.equal(calls[0]!.authorization, `Bearer ${OAUTH_CRED.accessToken}`);
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    workflow_name: 'newhire-onboarding',
    provide: {
      signed_docs: { acknowledged: true },
      hardware_choice: { laptop: 'MacBook Pro' },
    },
    default_crew: 'openai',
    title: 'Public CLI proof',
  });
  assert.deepEqual(JSON.parse(t.out.join('\n')), {
    ok: true,
    hub: ORIGIN,
    workflow: 'wf_public',
    def: 'newhire-onboarding',
    status: STARTED.status,
    stampedCrews: STARTED.stampedCrews,
    validatedCrews: [],
  });
});

test('start: missing or empty crew/title/modifier/scope/priority values fail before credential and network access', async () => {
  const cases = [
    { argv: ['start', 'newhire-onboarding', '--crew'], error: /missing value for --crew/u },
    { argv: ['start', 'newhire-onboarding', '--title'], error: /missing value for --title/u },
    { argv: ['start', 'newhire-onboarding', '--modifier'], error: /missing value for --modifier/u },
    { argv: ['start', 'newhire-onboarding', '--scope'], error: /missing value for --scope/u },
    { argv: ['start', 'newhire-onboarding', '--priority'], error: /missing value for --priority/u },
    { argv: ['start', 'newhire-onboarding', '--crew='], error: /invalid empty value for --crew/u },
    { argv: ['start', 'newhire-onboarding', '--title='], error: /invalid empty value for --title/u },
    // `--modifier=` is a usage error, NOT a silent unmodified run. The REST
    // route reads `''` as omitted, so forwarding a blank value would start a
    // run at bare capabilities while the operator believes they picked a depth.
    { argv: ['start', 'newhire-onboarding', '--modifier='], error: /invalid empty value for --modifier/u },
    { argv: ['start', 'newhire-onboarding', '--scope='], error: /invalid empty value for --scope/u },
    { argv: ['start', 'newhire-onboarding', '--priority='], error: /invalid empty value for --priority/u },
  ] as const;

  for (const fixture of cases) {
    const store = new Map<string, string>();
    let credentialAccesses = 0;
    const composite = (service: string, account: string): string => `${service}\u0000${account}`;
    const keychain: Keychain = {
      get(service, account) {
	credentialAccesses++;
	return store.get(composite(service, account)) ?? null;
      },
      set(service, account, value) {
	credentialAccesses++;
	store.set(composite(service, account), value);
      },
      delete(service, account) {
	credentialAccesses++;
	store.delete(composite(service, account));
      },
    };
    const { fetch, calls } = routedFetch({});
    const t = makeIo({ fetch, keychain, store });
    bind(t);

    const code = await mainAsync([...fixture.argv], t.io);

    assert.equal(code, 1, fixture.argv.join(' '));
    assert.match(t.err.join('\n'), fixture.error);
    assert.equal(credentialAccesses, 0, `${fixture.argv.join(' ')} must not access credentials`);
    assert.equal(calls.length, 0, `${fixture.argv.join(' ')} must not access the network`);
  }
});

/**
 * `--modifier` is the only way a human picks a run's depth from the CLI. It
 * reaches the hub as the request body's `modifier`, which `start_run` validates
 * against the def's declared `modifiers:` set and stores on the instance; the
 * engine then composes every step's capability into `<capability>:<modifier>`.
 *
 * The companion assertion lives in the happy-path test above, which `deepEqual`s
 * both the body and the printed object for a run started WITHOUT the flag: no
 * `modifier` key in either. That pins the omitted case as "unmodified run, bare
 * capabilities" rather than "modifier: undefined", which is a different request.
 */
test('start: --modifier forwards the run modifier and echoes it back', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: STARTED }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['start', 'newhire-onboarding', '--modifier', 'deep'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    workflow_name: 'newhire-onboarding',
    modifier: 'deep',
  });
  // Echoed from the request: `start_run`'s response carries no `modifier`
  // field, and a value outside the def's declared set is a 400 before any
  // instance exists — so a printed modifier can only be one the hub accepted.
  assert.equal(JSON.parse(t.out.join('\n')).modifier, 'deep');
});

test('start: --scope and --priority forward and echo', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: STARTED }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['start', 'newhire-onboarding', '--scope', 'proj-a', '--priority', 'high'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    workflow_name: 'newhire-onboarding',
    scope: 'proj-a',
    priority: 'high',
  });
  const printed = JSON.parse(t.out.join('\n')) as Record<string, unknown>;
  assert.equal(printed.scope, 'proj-a');
  assert.equal(printed.priority, 'high');
});

test('start: an out-of-set --priority is refused before network access', async () => {
  const { fetch, calls } = routedFetch({});
  let credentialAccesses = 0;
  const keychain: Keychain = {
    get() {
      credentialAccesses += 1;
      return null;
    },
    set() {
      credentialAccesses += 1;
    },
    delete() {
      credentialAccesses += 1;
    },
  };
  const t = makeIo({ fetch, keychain });
  bind(t);

  const code = await mainAsync(['start', 'newhire-onboarding', '--priority', 'urgent'], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /must be one of low, normal, high/u);
  assert.equal(credentialAccesses, 0);
  assert.equal(calls.length, 0);
});

test('start: an explicit literal title "true" remains a valid value', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: STARTED }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['start', 'newhire-onboarding', '--title=true'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(JSON.parse(calls[0]!.body ?? '{}').title, 'true');
});

test('start: explicit --hub works from an unbound directory and still requires the human credential', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: STARTED }),
  });
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));

  const code = await mainAsync(['start', 'newhire-onboarding', '--hub', ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/start_run`);
});

test('start: no binding and no --hub fails without consulting ambient production configuration', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch, env: { OWENLOOP_HUB: 'https://api.owenloop.com' } });

  const code = await mainAsync(['start', 'newhire-onboarding'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /not bound to a hub/);
  assert.equal(calls.length, 0);
});

test('start: an explicit hub that disagrees with the project binding is refused before network I/O', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['start', 'newhire-onboarding', '--hub', OTHER_ORIGIN], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /project is bound to/);
  assert.equal(calls.length, 0);
});

test('start: a missing human credential is exit 3 and never calls the hub', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });

  const code = await mainAsync(['start', 'newhire-onboarding'], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /no human credential/);
  assert.equal(calls.length, 0);
});

test('start: a typed hub refusal surfaces its safe message', async () => {
  const { fetch } = routedFetch({
    'POST /api/start_run': () => ({
      status: 403,
      json: { error: 'forbidden', message: "crew 'openai' is not one of your crews" },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['start', 'newhire-onboarding', '--crew', 'openai'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /crew 'openai' is not one of your crews/);
});

test('start: malformed 2xx is never reported as a successful run', async () => {
  const { fetch } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: { workflow: 'wf_public', def: 'wrong', status: {} } }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['start', 'newhire-onboarding'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /definition does not match/);
  assert.deepEqual(t.out, []);
});
