import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialBackend, readStoredCredential } from '../../../src/hub.ts';
import { owenloopConfigDir } from '../../../src/config-dir.ts';
import { routedWorkerEnv } from '../src/roles/routing-role-env.ts';

test('routed agent inherits vendor runtime but no operator account selector or credential command', () => {
  const input = {
    HOME: '/operator/home', USERPROFILE: '/operator/profile', PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'vendor-key', CLAUDE_CODE_OAUTH_TOKEN: 'vendor-oauth',
    CODEX_HOME: '/vendor/codex', TMPDIR: '/tmp',
    OWENLOOP_TOKEN: 'broad-bearer', OWENLOOP_ACCOUNT: 'operator',
    OWENLOOP_CONFIG_DIR: '/operator/config',
    OWENLOOP_CREDENTIAL_COMMAND: '/operator/get-token',
    OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS: '1000',
    OWENLOOP_ROUTING_HANDOFF: '/private/handoff', OWENLOOP_ROUTING_SESSION: '1',
    OWENLOOP_CACHE_DIR: '/operator/cache', OWENLOOP_HARNESS_MODULE: '/untrusted/module',
  };
  const out: Record<string, string | undefined> = routedWorkerEnv(input, {
    HOME: '/private/stage/home', OWENLOOP_CONFIG_DIR: '/private/stage/public',
  });
  assert.deepEqual(out, {
    HOME: '/private/stage/home', USERPROFILE: '/private/stage/home',
    PATH: '/usr/bin', ANTHROPIC_API_KEY: 'vendor-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'vendor-oauth', CODEX_HOME: '/vendor/codex', TMPDIR: '/tmp',
    OWENLOOP_CONFIG_DIR: '/private/stage/public', OWENLOOP_NO_KEYCHAIN: '1',
  });
  assert.equal(input.OWENLOOP_TOKEN, 'broad-bearer');
  assert.equal(Object.hasOwn(out, 'OWENLOOP_CREDENTIAL_COMMAND'), false);
  assert.equal(owenloopConfigDir(out), '/private/stage/public');
  const withoutSelector: Record<string, string | undefined> = { ...out };
  delete withoutSelector.OWENLOOP_CONFIG_DIR;
  assert.equal(owenloopConfigDir(withoutSelector), '/private/stage/home/.owenloop');
  assert.equal(credentialBackend(out, {
    get: () => { throw new Error('operator keychain must not be read'); },
    set: () => { throw new Error('operator keychain must not be written'); },
    delete: () => { throw new Error('operator keychain must not be deleted'); },
  }).kind, 'file');
});

test('routed agent rejects nonabsolute public trust and HOME roots', () => {
  assert.throws(() => routedWorkerEnv({}, {
    HOME: 'relative/home', OWENLOOP_CONFIG_DIR: '/private/public',
  }), /routing worker environment refused/);
  assert.throws(() => routedWorkerEnv({}, {
    HOME: '/private/home', OWENLOOP_CONFIG_DIR: 'relative/public',
  }), /routing worker environment refused/);
});

test('routed nested credential read cannot reach populated operator file or Keychain', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-role-env-'));
  try {
    const operator = join(root, 'operator');
    const publicDir = join(root, 'stage', 'public');
    const publicHome = join(root, 'stage', 'home');
    mkdirSync(operator, { recursive: true });
    mkdirSync(publicDir, { recursive: true });
    mkdirSync(publicHome, { recursive: true });
    writeFileSync(join(operator, 'credentials.json'), JSON.stringify({
      version: 2, hubs: { 'https://hub.example': {
        'agent:default': { kind: 'agent', accessToken: 'operator-bearer' },
      } },
    }));
    assert.deepEqual(readStoredCredential('https://hub.example', {
      principal: 'agent', env: { HOME: root, OWENLOOP_CONFIG_DIR: operator,
        OWENLOOP_NO_KEYCHAIN: '1' },
    }), { kind: 'agent', accessToken: 'operator-bearer' });
    const safe: Record<string, string | undefined> = routedWorkerEnv({ HOME: root,
      OWENLOOP_CONFIG_DIR: operator, OWENLOOP_CREDENTIAL_COMMAND: '/operator/get-token' },
    { HOME: publicHome, OWENLOOP_CONFIG_DIR: publicDir });
    const keychain = {
      get: () => { throw new Error('operator Keychain reached'); },
      set: () => { throw new Error('operator Keychain reached'); },
      delete: () => { throw new Error('operator Keychain reached'); },
    };
    assert.equal(readStoredCredential('https://hub.example', {
      principal: 'agent', env: safe, keychain,
    }), null);
    delete safe.OWENLOOP_CONFIG_DIR;
    assert.equal(readStoredCredential('https://hub.example', {
      principal: 'agent', env: safe, keychain,
    }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
