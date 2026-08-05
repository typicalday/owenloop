/**
 * `owenloop setup` — the idempotent converger (identity model §7 Flow A/B),
 * driven in-process through `mainAsync` against the stateful `makeIdentityHub`
 * fake. Proves: the seven steps run in order, a fresh machine mints/logs in, a
 * SECOND run performs zero writes (idempotency), the signing-keys step creates
 * the three principal keys exactly once and honors `--reuse-ssh-key` for the
 * human key only, the succession prompt (Flow B) renders verbatim framing and
 * rekeys the chosen agent, the `--replace-agent` / `--new-agent` bypasses skip
 * the prompt, and the non-interactive guard fires.
 *
 * Secrets discipline: `assertNoOlp(t)` ends EVERY acceptance test — the fake's
 * mint/rekey tokens all start `olp_` and ride in the response `text` field, so a
 * leak to stdout/stderr would trip it. Signing keys never reach the developer's
 * real ssh-keygen/Keychain/agent/$HOME: `makeIo` injects a fake
 * `PrincipalKeyManager` by default.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainAsync, sanitizeAgentName, lastActiveMs, formatLastActive, resolveBundledMarketplaceRoot } from '../src/cli.ts';
import type { AgentIdentitySummary } from '../src/hub.ts';
import { asAgentIdentities, asRekeyAgentTokenOk } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import {
  assertNoOlp,
  fakeKeychain,
  kcHuman,
  kcKey,
  makeFakePrincipalKeys,
  makeIdentityHub,
  makeIo,
  routedFetch,
} from './hubkit.ts';
import { owenloopSettingsPath } from '../src/work-settings.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';

/** An `openUrl` that plays the browser+consent, driving the real loopback callback. */
function driveCallback() {
  return (authUrl: string) => {
    const u = new URL(authUrl);
    const cb = new URL(u.searchParams.get('redirect_uri')!);
    cb.searchParams.set('code', 'auth-code-1');
    cb.searchParams.set('state', u.searchParams.get('state')!);
    void fetch(cb.toString()).catch(() => {});
  };
}

/** Seed a fresh, non-expiring human oauth credential directly into a keychain store. */
function seedHuman(store: Map<string, string>): void {
  store.set(
    kcHuman(ORIGIN),
    JSON.stringify({
      kind: 'oauth',
      accessToken: 'mcpat_seeded',
      refreshToken: 'rt_seeded',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'client-abc',
    }),
  );
}

type HarnessName = 'claude' | 'codex';
type PluginCall = { cmd: string; args: string[] };
type CommandResult = { status: number | null; stdout: string; stderr: string };

/** PATH fixture for plugin acceptance tests; the stubs are never executed. */
function pluginPathDir(harnesses: readonly HarnessName[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-setup-plugin-path-'));
  for (const harness of harnesses) writeFileSync(join(dir, harness), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

function pluginMutationCalls(calls: PluginCall[]): PluginCall[] {
  return calls.filter(
    ({ args }) =>
      args[0] === 'plugin' &&
      args[1] !== 'list' &&
      !(args[1] === 'marketplace' && args[2] === 'list'),
  );
}

async function runPluginSetup(
  harnesses: readonly HarnessName[],
  runCommand: (cmd: string, args: string[], calls: PluginCall[]) => CommandResult,
  resolver?: (harness: 'claude-code' | 'codex') => string | null,
): Promise<{ code: number; t: ReturnType<typeof makeIo>; calls: PluginCall[] }> {
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const calls: PluginCall[] = [];
  const t = makeIo({
    fetch,
    env: { PATH: pluginPathDir(harnesses) },
    runCommand: (cmd, args) => {
      const call = { cmd, args: [...args] };
      calls.push(call);
      return runCommand(cmd, args, calls);
    },
    resolveBundledMarketplaceRoot: resolver,
  });
  seedHuman(t.store);
  const code = await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io);
  return { code, t, calls };
}

// ---- Flow A: fresh machine ---------------------------------------------------

test('setup: fresh machine, scripted --new-agent runs steps 2-7 in order and converges', async () => {
  const { routes } = makeIdentityHub();
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // Step banners appear in order on stderr.
  const errText = t.err.join('\n');
  const order = ['[1/7]', '[2/7]', '[3/7]', '[4/7]', '[5/7]', '[6/7]', '[7/7]'];
  let last = -1;
  for (const marker of order) {
    const at = errText.indexOf(marker);
    assert.ok(at > last, `banner ${marker} out of order (at ${at}, prev ${last})`);
    last = at;
  }

  // Network order: DCR + token grant precede the mint.
  const regIdx = calls.findIndex((c) => c.pathname === '/mcp/register');
  const tokIdx = calls.findIndex((c) => c.pathname === '/mcp/token');
  const mintIdx = calls.findIndex((c) => c.pathname === '/api/mint_agent_token');
  assert.ok(regIdx >= 0 && tokIdx >= 0 && mintIdx >= 0, 'register, token, mint all called');
  assert.ok(regIdx < mintIdx && tokIdx < mintIdx, 'auth precedes mint');

  // Human slot + agent:buildbox slot landed in the keychain.
  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_access');
  assert.ok(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'buildbox' })), 'agent:buildbox stored');

  // owenloop settings written with hubOrigin = the hub.
  const settings = JSON.parse(readFileSync(owenloopSettingsPath(t.io.env), 'utf8'));
  assert.equal(settings.hubOrigin, ORIGIN);

  // Machine-readable summary on stdout; doctor ran.
  const summary = JSON.parse(t.out.join('\n'));
  assert.equal(summary.ok, true);
  assert.equal(summary.hub, ORIGIN);
  assert.ok(Array.isArray(summary.doctor.checks) && summary.doctor.checks.length >= 5, 'doctor checks present');

  assertNoOlp(t);
});

test('setup: fresh machine interactive — injected prompt names the agent; empty answer accepts the hostname prefill', async () => {
  // (a) a typed name.
  {
    const { routes } = makeIdentityHub();
    const { fetch } = routedFetch(routes);
    const questions: string[] = [];
    const t = makeIo({
      fetch,
      onOpenUrl: driveCallback(),
      prompt: async (q) => {
        questions.push(q);
        return 'mybox';
      },
    });
    assert.equal(await mainAsync(['setup', '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.ok(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'mybox' })), 'agent:mybox stored');
    assert.match(questions.join('\n'), /Name this Scoped Identity \[/, 'prefill prompt shown');
    assertNoOlp(t);
  }

  // (b) an empty answer accepts the sanitized-hostname prefill.
  {
    const expected = sanitizeAgentName(hostname());
    assert.ok(expected !== '', 'test host has a sanitizable hostname');
    const { routes } = makeIdentityHub();
    const { fetch } = routedFetch(routes);
    const t = makeIo({ fetch, onOpenUrl: driveCallback(), prompt: async () => '' });
    assert.equal(await mainAsync(['setup', '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.ok(
      t.store.get(kcKey(ORIGIN, { principal: 'agent', account: expected })),
      `agent:${expected} stored from the hostname prefill`,
    );
    assertNoOlp(t);
  }
});

// ---- idempotency: the second run is a no-op ---------------------------------

test('setup: a second run performs ZERO writes (no store mutation, no settings write, no browser, no mint)', async () => {
  const sharedHome = mkdtempSync(join(tmpdir(), 'owenloop-setup-home-'));
  const { keychain, store } = fakeKeychain();
  const { routes } = makeIdentityHub();

  // Run 1 — converge a fresh machine.
  const r1 = routedFetch(routes);
  const t1 = makeIo({ fetch: r1.fetch, keychain, store, env: { HOME: sharedHome }, onOpenUrl: driveCallback() });
  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t1.io), 0, t1.err.join('\n'));

  const storeSnapshot = [...store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const settingsPath = owenloopSettingsPath(t1.io.env);
  const settingsBytes = readFileSync(settingsPath, 'utf8');

  // Run 2 — same state, fresh call recorder.
  const r2 = routedFetch(routes);
  const t2 = makeIo({ fetch: r2.fetch, keychain, store, env: { HOME: sharedHome } });
  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t2.io), 0, t2.err.join('\n'));

  assert.deepEqual([...store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), storeSnapshot, 'keychain unchanged on the second run');
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBytes, 'settings file byte-identical');
  assert.equal(t2.openedUrls.length, 0, 'no browser opened on the second run');

  const run2Posts = r2.calls.filter((c) => c.method === 'POST').map((c) => c.pathname);
  for (const forbidden of ['/api/mint_agent_token', '/api/rekey_agent_token', '/mcp/register', '/mcp/token']) {
    assert.ok(!run2Posts.includes(forbidden), `no ${forbidden} on the idempotent second run`);
  }

  assertNoOlp(t2);
});

test('setup plugin: Claude fresh install runs marketplace add then plugin install', async () => {
  const root = resolveBundledMarketplaceRoot('claude-code');
  assert.ok(root, 'Claude marketplace root resolves in the source layout');
  const { code, t, calls } = await runPluginSetup(['claude'], (cmd, args) => {
    if (cmd === 'claude' && args.join(' ') === 'plugin list --json') return { status: 0, stdout: '[]', stderr: '' };
    if (cmd === 'claude' && args[0] === '--version') return { status: 0, stdout: '2.1.222 (Claude Code)\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', root] },
    { cmd: 'claude', args: ['plugin', 'install', 'owenloop@owenloop'] },
  ]);
  const summary = JSON.parse(t.out.join('\n')) as { steps: { step: string; action: string }[] };
  assert.deepEqual(summary.steps.filter((step) => step.step === 'plugin (claude-code)').map((step) => step.action), ['done']);
  assertNoOlp(t);
});

test('setup plugin: Claude matching version performs zero plugin writes', async () => {
  const { code, t, calls } = await runPluginSetup(['claude'], (cmd, args) => {
    if (cmd === 'claude' && args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: '[{"id":"owenloop@owenloop","version":" 0.5.0 "}]', stderr: '' };
    }
    if (cmd === 'claude' && args[0] === '--version') return { status: 0, stdout: '2.1.222 (Claude Code)\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [], 'matching version is idempotent');
  const summary = JSON.parse(t.out.join('\n')) as { steps: { step: string; action: string; detail: string }[] };
  assert.deepEqual(summary.steps.filter((step) => step.step === 'plugin (claude-code)').map((step) => step.action), ['skipped']);
  assert.match(summary.steps.find((step) => step.step === 'plugin (claude-code)')!.detail, /already current/);
  assertNoOlp(t);
});

test('setup plugin: Claude version skew runs marketplace add then plugin update', async () => {
  const root = resolveBundledMarketplaceRoot('claude-code');
  assert.ok(root);
  const { code, t, calls } = await runPluginSetup(['claude'], (cmd, args) => {
    if (cmd === 'claude' && args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: '[{"id":"owenloop@owenloop","version":"0.4.0"}]', stderr: '' };
    }
    if (cmd === 'claude' && args[0] === '--version') return { status: 0, stdout: '2.1.222 (Claude Code)\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', root] },
    { cmd: 'claude', args: ['plugin', 'update', 'owenloop@owenloop'] },
  ]);
  assertNoOlp(t);
});

test('setup plugin: Codex available-only entry is not installed and fresh install runs both commands', async () => {
  const root = resolveBundledMarketplaceRoot('codex');
  assert.ok(root);
  const { code, t, calls } = await runPluginSetup(['codex'], (cmd, args) => {
    if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({ installed: [], available: [{ pluginId: 'owenloop@owenloop', version: '0.5.0' }] }),
        stderr: '',
      };
    }
    if (cmd === 'codex' && args.join(' ') === 'plugin marketplace list --json') {
      return { status: 0, stdout: JSON.stringify({ marketplaces: [] }), stderr: '' };
    }
    if (cmd === 'codex' && args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [
    { cmd: 'codex', args: ['plugin', 'marketplace', 'add', root] },
    { cmd: 'codex', args: ['plugin', 'add', 'owenloop@owenloop'] },
  ]);
  assert.doesNotMatch(calls.map((call) => call.args.join(' ')).join('\n'), /marketplace upgrade/);
  assertNoOlp(t);
});

test('setup plugin: both installed harnesses converge independently in one setup run', async () => {
  const claudeRoot = resolveBundledMarketplaceRoot('claude-code');
  const codexRoot = resolveBundledMarketplaceRoot('codex');
  assert.ok(claudeRoot && codexRoot);
  const { code, t, calls } = await runPluginSetup(['claude', 'codex'], (cmd, args) => {
    if (args.join(' ') === 'plugin list --json') {
      return cmd === 'claude'
        ? { status: 0, stdout: '[]', stderr: '' }
        : { status: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' };
    }
    if (args.join(' ') === 'plugin marketplace list --json') return { status: 0, stdout: JSON.stringify({ marketplaces: [] }), stderr: '' };
    if (args[0] === '--version') return { status: 0, stdout: `${cmd} test-version\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', claudeRoot] },
    { cmd: 'claude', args: ['plugin', 'install', 'owenloop@owenloop'] },
    { cmd: 'codex', args: ['plugin', 'marketplace', 'add', codexRoot] },
    { cmd: 'codex', args: ['plugin', 'add', 'owenloop@owenloop'] },
  ]);
  assertNoOlp(t);
});

test('setup plugin: structured list parsing ignores matching JSON emitted on stderr', async () => {
  const root = resolveBundledMarketplaceRoot('claude-code');
  assert.ok(root);
  const { code, t, calls } = await runPluginSetup(['claude'], (cmd, args) => {
    if (cmd === 'claude' && args.join(' ') === 'plugin list --json') {
      return {
        status: 0,
        stdout: '[]',
        stderr: '[{"id":"owenloop@owenloop","version":"0.4.0"}]',
      };
    }
    if (cmd === 'claude' && args[0] === '--version') return { status: 0, stdout: '2.1.222 (Claude Code)\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [
    { cmd: 'claude', args: ['plugin', 'marketplace', 'add', root] },
    { cmd: 'claude', args: ['plugin', 'install', 'owenloop@owenloop'] },
  ]);
  assertNoOlp(t);
});

test('setup plugin: Codex different-source marketplace is noted without remove or add', async () => {
  const { code, t, calls } = await runPluginSetup(['codex'], (cmd, args) => {
    if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' };
    }
    if (cmd === 'codex' && args.join(' ') === 'plugin marketplace list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({ marketplaces: [{ name: 'owenloop', marketplaceSource: { sourceType: 'local', source: '/different/owenloop' } }] }),
        stderr: '',
      };
    }
    if (cmd === 'codex' && args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), []);
  assert.match(t.err.join('\n'), /different source/);
  assertNoOlp(t);
});

test('setup plugin: Codex same-source marketplace skips marketplace add during upgrade', async () => {
  const root = resolveBundledMarketplaceRoot('codex');
  assert.ok(root);
  const { code, t, calls } = await runPluginSetup(['codex'], (cmd, args) => {
    if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({ installed: [{ pluginId: 'owenloop@owenloop', version: '0.4.0', installed: true }], available: [] }),
        stderr: '',
      };
    }
    if (cmd === 'codex' && args.join(' ') === 'plugin marketplace list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({ marketplaces: [{ name: 'owenloop', marketplaceSource: { sourceType: 'local', source: root } }] }),
        stderr: '',
      };
    }
    if (cmd === 'codex' && args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [{ cmd: 'codex', args: ['plugin', 'add', 'owenloop@owenloop'] }]);
  assertNoOlp(t);
});

test('setup plugin: installed plugin with unknown version does not reinstall', async () => {
  const { code, t, calls } = await runPluginSetup(['claude'], (cmd, args) => {
    if (cmd === 'claude' && args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: '[{"id":"owenloop@owenloop"}]', stderr: '' };
    }
    if (cmd === 'claude' && args[0] === '--version') return { status: 0, stdout: '2.1.222 (Claude Code)\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), []);
  const summary = JSON.parse(t.out.join('\n')) as { steps: { step: string; detail: string }[] };
  assert.match(summary.steps.find((step) => step.step === 'plugin (claude-code)')!.detail, /version unknown/);
  assertNoOlp(t);
});

test('setup plugin: failed install is noted and does not fail core setup', async () => {
  const root = resolveBundledMarketplaceRoot('claude-code');
  assert.ok(root);
  const { code, t, calls } = await runPluginSetup(['claude'], (cmd, args) => {
    if (cmd === 'claude' && args.join(' ') === 'plugin list --json') return { status: 0, stdout: '[]', stderr: '' };
    if (cmd === 'claude' && args[0] === '--version') return { status: 0, stdout: '2.1.222 (Claude Code)\n', stderr: '' };
    if (cmd === 'claude' && args[1] === 'marketplace') return { status: 1, stdout: '', stderr: 'permission denied' };
    return { status: 0, stdout: '', stderr: '' };
  });

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), [{ cmd: 'claude', args: ['plugin', 'marketplace', 'add', root] }]);
  const summary = JSON.parse(t.out.join('\n')) as { steps: { step: string; action: string }[] };
  assert.deepEqual(summary.steps.filter((step) => step.step === 'plugin (claude-code)').map((step) => step.action), ['noted']);
  assertNoOlp(t);
});

test('setup plugin: missing bundled root prints instructions and performs no install writes', async () => {
  const { code, t, calls } = await runPluginSetup(
    ['claude', 'codex'],
    (cmd, args) => {
      if (args[0] === 'plugin' && args[1] === 'list') {
        return cmd === 'claude'
          ? { status: 0, stdout: '[]', stderr: '' }
          : { status: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' };
      }
      if (args[0] === '--version') return { status: 0, stdout: `${cmd} test-version\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    () => null,
  );

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(pluginMutationCalls(calls), []);
  assert.match(t.err.join('\n'), /bundled marketplace root unavailable/);
  assertNoOlp(t);
});

// ---- signing keys: the [4/7] step -------------------------------------------

/** The three canonical refs setup must ensure, for the fake hub's identity model
 *  (human actor `user_abc`, machine `local`, and the minted agent's hub id). */
function expectedRefs(origin: string, agentId: string) {
  return [
    { origin, kind: 'human', id: 'user_abc' },
    { origin, kind: 'machine', id: 'local' },
    { origin, kind: 'agent', id: agentId },
  ];
}

test('setup: [4/7] ensures exactly the three canonical refs in human→machine→agent order', async () => {
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io), 0, t.err.join('\n'));

  // The mint route assigns agent_1 as the first minted identity id.
  assert.ok(t.principalKeys, 'fake signing-key manager injected');
  assert.deepEqual(
    t.principalKeys!.calls.map((c) => ({ origin: c.ref.origin, kind: c.ref.kind, id: c.ref.id })),
    expectedRefs(ORIGIN, 'agent_1'),
    'exactly three canonical refs, human→machine→agent order',
  );
  for (const c of t.principalKeys!.calls) assert.equal(c.reuse, undefined, 'no reuse passed without --reuse-ssh-key');

  // The summary line prints kind + state + backend only.
  assert.match(t.err.join('\n'), /✓ signing keys: human created \(file\), machine created \(file\), agent created \(file\)/);
  assertNoOlp(t);
});

test('setup: second run performs zero key writes — all three refs come back existing', async () => {
  const sharedHome = mkdtempSync(join(tmpdir(), 'owenloop-setup-keys-'));
  const { keychain, store } = fakeKeychain();
  const { routes } = makeIdentityHub();

  const r1 = routedFetch(routes);
  const t1 = makeIo({ fetch: r1.fetch, keychain, store, env: { HOME: sharedHome }, onOpenUrl: driveCallback() });
  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t1.io), 0, t1.err.join('\n'));
  const run1Created = t1.principalKeys!.calls.filter((c) => c.result?.state === 'created');
  assert.equal(run1Created.length, 3, 'run 1 created all three keys');

  // Run 2 over the SAME fake store: every ensure must RETURN `existing`, so
  // no new state entry appears and no call carries a reuse request.
  const before = t1.principalKeys!.state.size;
  const r2 = routedFetch(routes);
  const t2 = makeIo({ fetch: r2.fetch, keychain, store, env: { HOME: sharedHome }, principalKeys: t1.principalKeys!.manager });
  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t2.io), 0, t2.err.join('\n'));

  assert.equal(t1.principalKeys!.calls.length, 6, 'run 2 ensured the same three refs');
  const run2 = t1.principalKeys!.calls.slice(3);
  for (const c of run2) {
    assert.equal(c.result?.state, 'existing', `run-2 ensure of ${c.ref.kind} sees an existing key`);
    assert.equal(c.reuse, undefined);
  }
  assert.equal(t1.principalKeys!.state.size, before, 'no new key state on the second run');
  assert.match(t2.err.join('\n'), /✓ signing keys: human existing \(file\), machine existing \(file\), agent existing \(file\)/);
  assertNoOlp(t2);
});

test('setup: --replace-agent reuses the existing agent key (rekey preserves the agent id)', async () => {
  // Seed the agent key for agent_w's hub id (agent_w) as ALREADY existing.
  const { routes } = makeIdentityHub({
    identities: [{ id: 'agent_w', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_worker_live' } }],
  });
  const { fetch } = routedFetch(routes);
  const keys = makeFakePrincipalKeys({ existing: [{ origin: ORIGIN, kind: 'agent', id: 'agent_w' }] });
  const t = makeIo({ fetch, principalKeys: keys.manager });
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'worker'], t.io), 0, t.err.join('\n'));

  const agentCall = keys.calls.find((c) => c.ref.kind === 'agent');
  assert.ok(agentCall, 'agent key ensured');
  assert.equal(agentCall!.ref.id, 'agent_w', 'the agent key ref is the rekeyed identity id');
  assert.equal(agentCall!.result?.state, 'existing', 'the agent key is reused, not regenerated');
  assertNoOlp(t);
});

test('setup: --new-agent mints a NEW identity id, so the agent key is new', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_x', name: 'other', crews: ['team'] }] });
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'fresh'], t.io), 0, t.err.join('\n'));

  const agentCall = t.principalKeys!.calls.find((c) => c.ref.kind === 'agent');
  assert.ok(agentCall, 'agent key ensured');
  assert.equal(agentCall!.ref.id, 'agent_1', 'the new agent gets the hub-minted identity id');
  assert.equal(agentCall!.result?.state, 'created', 'a new agent means a new key');
  assertNoOlp(t);
});

test('setup: agent key ref uses the live whoami actor id when listed metadata has a different id', async () => {
  const { routes, state } = makeIdentityHub({
    identities: [{ id: 'agent_listed', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_worker_live' } }],
  });
  const token = [...state.tokens.values()][0];
  assert.ok(token, 'seeded agent token exists');
  token.agentId = 'agent_live';

  const { fetch } = routedFetch(routes);
  const { keychain, store } = fakeKeychain();
  seedHuman(store);
  store.set(kcKey(ORIGIN, { principal: 'agent', account: 'worker' }), JSON.stringify({ kind: 'agent', accessToken: 'olp_worker_live' }));
  const keys = makeFakePrincipalKeys();
  const t = makeIo({ fetch, keychain, store, principalKeys: keys.manager });

  assert.equal(await mainAsync(['setup', '--hub', HUB], t.io), 0, t.err.join('\\n'));
  assert.deepEqual(
    keys.calls.map((c) => ({ kind: c.ref.kind, id: c.ref.id })),
    [
      { kind: 'human', id: 'user_abc' },
      { kind: 'machine', id: 'local' },
      { kind: 'agent', id: 'agent_live' },
    ],
    'the live whoami actor id, not the listed identity id, names the agent key',
  );
  assertNoOlp(t);
});

test('setup --reuse-ssh-key: passes the path to the human ensure ONLY', async () => {
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });
  const keyFile = join(t.home, 'my-existing-ed25519');
  writeFileSync(keyFile, 'ssh-ed25519 AAAAB3NzaC1lZDI1NTE5 not-a-real-private\n', { mode: 0o600 });

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox', '--reuse-ssh-key', keyFile], t.io), 0, t.err.join('\n'));

  assert.ok(t.principalKeys, 'fake key manager injected');
  const byKind = (k: string) => t.principalKeys!.calls.find((c) => c.ref.kind === k)!;
  assert.deepEqual(byKind('human').reuse, { path: keyFile }, 'human ensure receives the reuse path');
  assert.equal(byKind('machine').reuse, undefined, 'machine ensure gets no reuse');
  assert.equal(byKind('agent').reuse, undefined, 'agent ensure gets no reuse');
  assert.equal(byKind('human').result?.state, 'reused', 'human key recorded as reused');
  assert.match(t.err.join('\n'), /✓ signing keys: human reused \(reused\)/);
  assertNoOlp(t);
});

test('setup --reuse-ssh-key: a missing path errors BEFORE any browser opens', async () => {
  const { routes } = makeIdentityHub();
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox', '--reuse-ssh-key', join(t.home, 'nope')], t.io), 1);
  assert.match(t.err.join('\n'), /--reuse-ssh-key: no such file/);
  assert.equal(t.openedUrls.length, 0, 'no browser opened before the path check');
  assert.equal(calls.length, 0, 'no network before the path check');
  assert.equal(t.principalKeys!.calls.length, 0, 'no key ensured');
  assertNoOlp(t);
});

test('setup: a signing-key store failure surfaces as a hard error (no fallback, setup aborts)', async () => {
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const keys = makeFakePrincipalKeys({ failFor: [{ origin: ORIGIN, kind: 'machine', id: 'local' }] });
  const t = makeIo({ fetch, onOpenUrl: driveCallback(), principalKeys: keys.manager });

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io), 1);
  assert.match(t.err.join('\n'), /fake signing-key store failure for machine/);
  assert.equal(keys.calls.length, 2, 'human ensured, machine failed, agent never attempted');
  assertNoOlp(t);
});

test('setup: reuse against an EXISTING human key is a hard conflict error', async () => {
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const keys = makeFakePrincipalKeys({ existing: [{ origin: ORIGIN, kind: 'human', id: 'user_abc' }] });
  const t = makeIo({ fetch, onOpenUrl: driveCallback(), principalKeys: keys.manager });
  const keyFile = join(t.home, 'another-ed25519');
  writeFileSync(keyFile, 'ssh-ed25519 AAAAB3NzaC1lZDI1NTE5 not-a-real-private\n', { mode: 0o600 });

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox', '--reuse-ssh-key', keyFile], t.io), 1);
  assert.match(t.err.join('\n'), /rotation is not part of WP-A2/);
  assertNoOlp(t);
});

test('setup: no private key marker ever reaches stdout/stderr', async () => {
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });
  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io), 0, t.err.join('\n'));
  const combined = [...t.out, ...t.err].join('\n');
  assert.ok(!combined.includes('BEGIN OPENSSH PRIVATE KEY'), 'no private-key banner in setup output');
  assert.ok(!combined.includes('owenloopfakekey'), 'no key material in setup output');
  assertNoOlp(t);
});

// ---- external credential command: refuse before opening the browser ---------

test('setup: an external credential command refuses BEFORE any browser opens (symmetric with login)', async () => {
  // Same incident class as the login guard (PR #69): when OWENLOOP_CREDENTIAL_COMMAND
  // is set the external command — not the local store — supplies this hub's
  // credentials, so setup's human-login step (which opens the loopback OAuth
  // browser) and its agent mint would strand keys nobody reads. Setup must fail
  // FAST with login's EXACT refusal, at the top, before any step runs.
  //
  // What the guard replaces: without it, setup gives a confusing, non-symmetric
  // late failure. In external mode `readCredential` never returns null — the
  // command either yields a well-formed credential or THROWS (hub.ts
  // runCredentialCommand). So a missing/failing command (here `my-helper`, not
  // on PATH) throws at step 1 inspect with a raw "external credential command
  // failed … status 127" message; a succeeding command instead fails later at
  // step 3's mint refusal after network calls. Either way the loopback-OAuth
  // browser is never reached, so `openedUrls` is a standing witness that no
  // browser opens — and the DISTINGUISHING signal this test asserts is that the
  // error is login's clean refusal, which only the guard produces. Pre-fix the
  // error is the raw status-127 text (no OWENLOOP_CREDENTIAL_COMMAND / "unset
  // it" guidance), so this test fails without the guard and passes with it.
  //
  // driveCallback is wired only defensively: if a future refactor ever let the
  // browser branch be reached, the callback keeps the run from hanging.
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const t = makeIo({
    fetch,
    onOpenUrl: driveCallback(),
    env: { OWENLOOP_CREDENTIAL_COMMAND: 'my-helper --hub prod' },
  });

  const code = await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io);
  assert.equal(code, 1);
  assert.equal(t.openedUrls.length, 0, 'no browser/loopback flow ever started');
  const errText = t.err.join('\n');
  assert.match(errText, /OWENLOOP_CREDENTIAL_COMMAND/);
  assert.match(errText, /unset it to use `owenloop login`/);
  assert.equal(t.store.size, 0, 'nothing written to the local store');
  assertNoOlp(t);
});

// ---- Flow B: succession -----------------------------------------------------

test('setup: succession prompt (Flow B) renders verbatim framing and rekeys the chosen agent', async () => {
  const day = 86_400_000;
  const { routes, state } = makeIdentityHub({
    identities: [
      { id: 'agent_mbp', name: 'alexs-mbp', crews: ['alex-personal'], lastContactAt: Date.now() - 4 * day },
      { id: 'agent_hermes', name: 'hermes-worker', crews: ['logistics'], lastContactAt: Date.now() - 2 * 60_000 },
      { id: 'agent_never', name: 'idle-box', crews: ['spare'], lastContactAt: null },
    ],
  });
  const { fetch, calls } = routedFetch(routes);
  const questions: string[] = [];
  const t = makeIo({ fetch, prompt: async (q) => (questions.push(q), '2') }); // choose [2] = replace alexs-mbp
  seedHuman(t.store);

  const code = await mainAsync(['setup', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const q = questions.join('\n');
  assert.match(q, /Is this a new installation, or does it replace an existing one\?/, 'verbatim framing');
  assert.match(q, /alexs-mbp/);
  assert.match(q, /hermes-worker/);
  assert.match(q, /last active 4d ago/);
  assert.match(q, /last active 2m ago/);
  assert.match(q, /last active never/, 'null-both identity renders never');
  assert.match(q, /crews: alex-personal/);
  assert.match(q, /crews: logistics/);
  assert.match(q, /⚠ "Replace" revokes/);
  assert.match(q, /disconnected there/);

  // The rekey was issued for alexs-mbp, and its slot now holds a rekeyed token.
  const rekey = calls.find((c) => c.pathname === '/api/rekey_agent_token');
  assert.ok(rekey, 'rekey called');
  assert.equal(JSON.parse(rekey!.body!).agentId, 'agent_mbp');
  const slot = t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'alexs-mbp' }));
  assert.ok(slot, 'agent:alexs-mbp slot written');
  assert.match((JSON.parse(slot!) as Credential).accessToken, /^olp_rekeyed_/, 'slot holds the rekeyed token');
  // The original identity's token in state was revoked by the rekey (or there was none).
  assert.ok([...state.tokens.values()].some((tk) => tk.agentId === 'agent_mbp' && !tk.revoked), 'a live token exists post-rekey');

  assertNoOlp(t);
});

// ---- explicit bypass flags --------------------------------------------------

test('setup --replace-agent: prompt-free rekey; unknown name errors; --crews is a usage error', async () => {
  // (a) a valid replace, no prompt injected — proves the flag path never prompts.
  {
    const { routes, state } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_worker_live' } }] });
    const { fetch, calls } = routedFetch(routes);
    const t = makeIo({ fetch }); // NO prompt seam
    seedHuman(t.store);

    assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'worker'], t.io), 0, t.err.join('\n'));
    const rekey = calls.find((c) => c.pathname === '/api/rekey_agent_token');
    assert.ok(rekey, 'rekey called');
    assert.equal(JSON.parse(rekey!.body!).agentId, 'agent_w');
    assert.match((JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'worker' }))!) as Credential).accessToken, /^olp_rekeyed_/);
    assert.ok([...state.tokens.values()].some((tk) => tk.plaintext === 'olp_worker_live' && tk.revoked), 'the old worker token was revoked');
    assertNoOlp(t);
  }

  // (b) an unknown --replace-agent name errors listing the available names, no rekey.
  {
    const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: [] }] });
    const { fetch, calls } = routedFetch(routes);
    const t = makeIo({ fetch });
    seedHuman(t.store);

    assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'ghost'], t.io), 1);
    assert.match(t.err.join('\n'), /no Scoped Identity named 'ghost'/);
    assert.match(t.err.join('\n'), /worker/, 'lists the available names');
    assert.ok(!calls.some((c) => c.pathname === '/api/rekey_agent_token'), 'no rekey on an unknown name');
    assertNoOlp(t);
  }

  // (c) --replace-agent + --crews is a usage error before any network.
  {
    const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: [] }] });
    const { fetch, calls } = routedFetch(routes);
    const t = makeIo({ fetch });
    seedHuman(t.store);

    assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'worker', '--crews', 'a'], t.io), 1);
    assert.match(t.err.join('\n'), /--crews cannot be combined with --replace-agent/);
    assert.equal(calls.length, 0, 'no network touched before the usage error');
    assertNoOlp(t);
  }
});

test('setup --new-agent with a non-empty org: mint path forwards --crews, no prompt', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_x', name: 'other', crews: ['team'] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch }); // NO prompt seam — --new-agent must not prompt
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'fresh', '--crews', 'a,b'], t.io), 0, t.err.join('\n'));
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.ok(mint, 'mint called');
  const body = JSON.parse(mint!.body!);
  assert.equal(body.name, 'fresh');
  assert.deepEqual(body.crews, ['a', 'b'], '--crews forwarded to the mint body');
  assert.ok(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'fresh' })), 'agent:fresh stored');
  assertNoOlp(t);
});

test('setup --new-agent: --scopes forwards into the mint body', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_x', name: 'other', crews: ['team'] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch }); // NO prompt seam — --new-agent must not prompt
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'fresh', '--scopes', 'work,run'], t.io), 0, t.err.join('\n'));
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.ok(mint, 'mint called');
  const body = JSON.parse(mint!.body!);
  assert.equal(body.name, 'fresh');
  assert.deepEqual(body.scopes, ['work', 'run'], '--scopes forwarded to the mint body');
  assertNoOlp(t);
});

test('setup --replace-agent + --scopes is a usage error before any network', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: [] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'worker', '--scopes', 'work,run'], t.io), 1);
  assert.match(t.err.join('\n'), /--scopes cannot be combined with --replace-agent/);
  assert.equal(calls.length, 0, 'no network touched before the usage error');
  assertNoOlp(t);
});

// ---- non-interactive guard --------------------------------------------------

test('setup: identities exist, no flags, no prompt seam → CliError naming both bypass flags, no mint/rekey', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_x', name: 'other', crews: [] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch }); // no prompt; test stdin is not a TTY
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB], t.io), 1);
  const err = t.err.join('\n');
  assert.match(err, /--new-agent <name>/, 'names --new-agent');
  assert.match(err, /--replace-agent <name>/, 'names --replace-agent');
  assert.ok(!calls.some((c) => c.pathname === '/api/mint_agent_token' || c.pathname === '/api/rekey_agent_token'), 'no mint/rekey');
  assertNoOlp(t);
});

// ---- pure-unit helpers ------------------------------------------------------

test('sanitizeAgentName: lowercases, strips out-of-class chars, strips leading non-alnum, clamps to 64', () => {
  assert.equal(sanitizeAgentName('Alexs-MBP.local'), 'alexs-mbp.local');
  assert.equal(sanitizeAgentName('__weird!!name'), 'weirdname');
  assert.equal(sanitizeAgentName('...---'), '', 'nothing alphanumeric survives → empty');
  assert.equal(sanitizeAgentName('a'.repeat(80)).length, 64, 'clamped to 64');
  assert.equal(sanitizeAgentName('Böx-Ñame'), 'bx-ame', 'non-ascii dropped');
});

test('lastActiveMs: max of the two non-null timestamps, or null when both absent', () => {
  const base = (over: Partial<AgentIdentitySummary>): AgentIdentitySummary => ({
    id: 'i', name: 'n', disabled: false, crews: [], lastContactAt: null, lastUsedAt: null, ...over,
  });
  assert.equal(lastActiveMs(base({})), null);
  assert.equal(lastActiveMs(base({ lastContactAt: 100 })), 100);
  assert.equal(lastActiveMs(base({ lastUsedAt: 200 })), 200);
  assert.equal(lastActiveMs(base({ lastContactAt: 100, lastUsedAt: 200 })), 200, 'max wins');
  assert.equal(lastActiveMs(base({ lastContactAt: 300, lastUsedAt: 200 })), 300, 'max wins the other way');
});

test('formatLastActive: minutes/hours/days/just now/never', () => {
  assert.equal(formatLastActive(null), 'never');
  assert.equal(formatLastActive(-5), 'just now', 'clock skew clamps');
  assert.equal(formatLastActive(30_000), 'just now', 'under a minute');
  assert.equal(formatLastActive(5 * 60_000), '5m ago');
  assert.equal(formatLastActive(3 * 3_600_000), '3h ago');
  assert.equal(formatLastActive(4 * 86_400_000), '4d ago');
});

test('asAgentIdentities: rejects malformed shapes, tolerates absent timestamps/crews', () => {
  assert.throws(() => asAgentIdentities({}), /expected an `identities` array/);
  assert.throws(() => asAgentIdentities({ identities: [{ name: 'x' }] }), /missing non-empty string id/);
  assert.throws(() => asAgentIdentities({ identities: [{ id: 'a', name: 'x', lastUsedAt: 'soon' }] }), /lastUsedAt must be a number or null/);
  const ok = asAgentIdentities({ identities: [{ id: 'a', name: 'x' }] });
  assert.deepEqual(ok, [{ id: 'a', name: 'x', disabled: false, crews: [], lastContactAt: null, lastUsedAt: null }]);
});

test('asRekeyAgentTokenOk: field-name-only errors never echo an olp_ value from the body', () => {
  // A malformed body whose `text` carries the plaintext, with a missing id.
  assert.throws(
    () => asRekeyAgentTokenOk({ text: 'store this: olp_leaky_secret', id: '', agentId: 'a', token: 'olp_ok' }),
    (e: Error) => {
      assert.match(e.message, /missing non-empty string id/);
      assert.doesNotMatch(e.message, /olp_/, 'the error never echoes a token value');
      return true;
    },
  );
  // A well-formed body narrows cleanly.
  const ok = asRekeyAgentTokenOk({ id: 't1', token: 'olp_new', agentId: 'a1', revokedTokenIds: ['old'], scopes: ['work'] });
  assert.equal(ok.agentId, 'a1');
  assert.deepEqual(ok.revokedTokenIds, ['old']);
});
