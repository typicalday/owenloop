/**
 * Pure hub helpers (src/hub.ts): origin normalization, PKCE, credential + hub
 * binding round-trips with strict file-mode assertions, and push-diff logic.
 * Fully hermetic — every path is under an `mkdtempSync` fixture; nothing reads
 * the developer's real `~/.config` or keychain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYamlText } from 'yaml';
import {
  asCreateWorkflowOk,
  asMintAgentTokenOk,
  asWhoami,
  base64url,
  computeServerDiff,
  configDir,
  createWorkflowError,
  credentialFilePath,
  hashDefForHub,
  hubBindingPath,
  listStoredHubOrigins,
  normalizeOrigin,
  parseWorkflowList,
  pkcePair,
  randomState,
  readCredentialFile,
  readHubBinding,
  resolveEndpoint,
  writeCredentialFile,
  writeFileAtomic,
  writeHubBinding,
} from '../src/hub.ts';
import type { Credential, HubBinding, WorkflowSummary } from '../src/hub.ts';
import { DefError, hashDef, loadDefsRaw, parseDef } from '../src/defs.ts';
import { fakeKeychain } from './hubkit.ts';

// ---- origin normalization ----------------------------------------------------

test('normalizeOrigin strips path/query/trailing slash and keeps scheme+host+port', () => {
  assert.equal(normalizeOrigin('https://api.owenloop.com/'), 'https://api.owenloop.com');
  assert.equal(normalizeOrigin('https://api.owenloop.com/foo/bar?x=1'), 'https://api.owenloop.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeOrigin('  https://api.stg.owenloop.com  '), 'https://api.stg.owenloop.com');
});

test('normalizeOrigin rejects non-http(s) and empty input', () => {
  assert.throws(() => normalizeOrigin(''), /empty/);
  assert.throws(() => normalizeOrigin('ftp://example.com'), /http or https/);
  assert.throws(() => normalizeOrigin('not a url'), /invalid hub url/);
});

test('normalizeOrigin: http allowed only for loopback hosts (SEC-2 transport policy)', () => {
  // Loopback http is accepted for local dev, across the canonicalizing forms.
  assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeOrigin('http://[::1]:8080'), 'http://[::1]:8080');
  // URL canonicalization: LOCALHOST lowercases, 127.1 shorthand → 127.0.0.1.
  assert.equal(normalizeOrigin('http://LOCALHOST:3000'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('http://127.1:9'), 'http://127.0.0.1:9');
  // userinfo is dropped by .origin — the canonical loopback origin remains.
  assert.equal(normalizeOrigin('http://user:pass@127.0.0.1'), 'http://127.0.0.1');
  // https is always accepted.
  assert.equal(normalizeOrigin('https://api.owenloop.com'), 'https://api.owenloop.com');
});

test('normalizeOrigin: rejects remote http so credentials can never go plaintext to a non-loopback host', () => {
  assert.throws(() => normalizeOrigin('http://api.owenloop.com'), /only allowed for loopback/);
  assert.throws(() => normalizeOrigin('http://127.0.0.2'), /only allowed for loopback/);
  assert.throws(() => normalizeOrigin('http://192.168.1.5'), /only allowed for loopback/);
  assert.throws(() => normalizeOrigin('http://[::2]:8080'), /only allowed for loopback/);
});

// ---- endpoint resolution (OAuth-metadata trust boundary, SEC-4) --------------

test('resolveEndpoint: resolves root-relative and same-origin absolute endpoints, keeping path/query', () => {
  assert.equal(resolveEndpoint('https://api.owenloop.com', '/api/whoami'), 'https://api.owenloop.com/api/whoami');
  assert.equal(resolveEndpoint('https://api.owenloop.com', '/mcp/token?x=1'), 'https://api.owenloop.com/mcp/token?x=1');
  // An absolute endpoint is allowed when it is same-origin with the hub.
  assert.equal(resolveEndpoint('http://127.0.0.1:9', 'http://127.0.0.1:9/mcp/token'), 'http://127.0.0.1:9/mcp/token');
});

test('resolveEndpoint: rejects a cross-origin or protocol-relative endpoint (no foreign token_endpoint)', () => {
  assert.throws(() => resolveEndpoint('https://api.owenloop.com', 'https://evil.example/token'), /not the hub origin/);
  assert.throws(() => resolveEndpoint('http://127.0.0.1:9', '//evil.example/token'), /not the hub origin/);
});

// ---- PKCE --------------------------------------------------------------------

test('pkcePair: verifier is unreserved-charset and challenge is S256 of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/, 'verifier is base64url (unreserved)');
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier length ${verifier.length} in RFC range`);
  const expected = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
  assert.doesNotMatch(challenge, /[+/=]/, 'challenge has no non-url-safe base64 chars');
});

test('base64url matches the RFC 7636 Appendix B S256 vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('randomState yields distinct url-safe tokens', () => {
  const a = randomState();
  const b = randomState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9\-_]+$/);
});

// ---- config dir derives from env, never process.env --------------------------

test('configDir prefers XDG_CONFIG_HOME, falls back to HOME/.config, else throws', () => {
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }), join('/x', 'owenloop'));
  assert.equal(configDir({ HOME: '/home/me' }), join('/home/me', '.config', 'owenloop'));
  assert.throws(() => configDir({}), /set HOME or XDG_CONFIG_HOME/);
});

// ---- credential file round-trip + strict modes -------------------------------

test('writeCredentialFile round-trips and enforces 0600 file / 0700 dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-'));
  const env = { HOME: home };
  const path = credentialFilePath(env);

  const cred: Credential = {
    kind: 'oauth',
    accessToken: 'mcpat_secret',
    refreshToken: 'refresh_secret',
    expiresAt: 123,
    clientId: 'client-1',
  };
  writeCredentialFile(path, { version: 2, hubs: { 'https://api.owenloop.com': { human: cred } } });

  const readBack = readCredentialFile(path);
  assert.deepEqual(readBack.hubs['https://api.owenloop.com']?.human, cred);

  assert.equal(statSync(path).mode & 0o777, 0o600, 'credential file is 0600');
  assert.equal(statSync(join(home, '.config', 'owenloop')).mode & 0o777, 0o700, 'config dir is 0700');
});

test('readCredentialFile: a missing file is an empty store', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-'));
  const store = readCredentialFile(credentialFilePath({ HOME: home }));
  assert.deepEqual(store, { version: 2, hubs: {} });
});

test('readCredentialFile: a non-v2 file reads as an EMPTY store (old keying is invisible, no migration)', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-v1-'));
  const path = credentialFilePath({ HOME: home });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const cred: Credential = { kind: 'agent', accessToken: 'olp_old' };
  writeFileSync(path, `${JSON.stringify({ version: 1, hubs: { 'https://api.owenloop.com': cred } })}\n`);
  assert.deepEqual(readCredentialFile(path), { version: 2, hubs: {} });
});

test('readCredentialFile: a genuinely malformed file still THROWS (a corrupt entry is not a destroyed file)', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-bad-'));
  const path = credentialFilePath({ HOME: home });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, '{ not json');
  assert.throws(() => readCredentialFile(path));
  writeFileSync(path, JSON.stringify({ version: 2, hubs: 'nope' }));
  assert.throws(() => readCredentialFile(path), /malformed credential file/);
});

// ---- atomic, symlink-refusing writes (SEC-3) ---------------------------------

test('SEC-3: writeCredentialFile / writeHubBinding refuse a symlinked destination, leaving the link target intact', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-sym-'));
  const path = credentialFilePath({ HOME: home });
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // A real file elsewhere that an attacker's symlink at the dest points at.
  const target = join(home, 'victim.txt');
  writeFileSync(target, 'original-secret');
  symlinkSync(target, path);

  assert.throws(
    () => writeCredentialFile(path, { version: 2, hubs: {} }),
    (e: Error) =>
      e.message.includes('refusing to write') && e.message.includes('symbolic link') && e.message.includes(path),
  );
  assert.equal(readFileSync(target, 'utf8'), 'original-secret', 'the link target was never followed or clobbered');

  // writeHubBinding shares the same guard.
  const bindPath = join(home, 'bind.json');
  symlinkSync(target, bindPath);
  assert.throws(
    () => writeHubBinding(bindPath, { version: 1, hub: 'https://api.owenloop.com' }),
    /refusing to write .*symbolic link/,
  );
  assert.equal(readFileSync(target, 'utf8'), 'original-secret');
});

test('SEC-3: writeCredentialFile atomically overwrites, re-tightens to 0600 / dir 0700, and leaves no temp file', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-atomic-'));
  const path = credentialFilePath({ HOME: home });
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Pre-existing file with a lax mode and junk content.
  writeFileSync(path, 'junk', { mode: 0o644 });
  chmodSync(path, 0o644);

  const cred: Credential = { kind: 'agent', accessToken: 'olp_x' };
  writeCredentialFile(path, { version: 2, hubs: { 'https://api.owenloop.com': { human: cred } } });

  assert.deepEqual(readCredentialFile(path).hubs['https://api.owenloop.com']?.human, cred, 'content replaced');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'file re-tightened to 0600 despite the prior 0644');
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'dir 0700');
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no leftover temp file after the atomic rename');
});

test('SEC-3: writeFileAtomic refuses a directory destination and leaves no stray temp file behind', () => {
  const base = mkdtempSync(join(tmpdir(), 'owenloop-dir-'));
  const dest = join(base, 'iamdir');
  mkdirSync(dest);

  assert.throws(() => writeFileAtomic(dest, 'data', { mode: 0o600 }), /refusing to write .*directory/);
  const leftovers = readdirSync(base).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no stray temp file after a refused write');
});

test('SEC-3: writeHubBinding refuses a symlinked `.owenloop` parent, leaving the link target directory intact', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-parentsym-'));
  // The attacker's redirect target: a real directory elsewhere.
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-elsewhere-'));
  // A hostile checkout ships `.owenloop -> /elsewhere`.
  symlinkSync(elsewhere, join(cwd, '.owenloop'));

  const bindPath = hubBindingPath(cwd);
  assert.throws(
    () => writeHubBinding(bindPath, { version: 1, hub: 'https://api.owenloop.com' }),
    (e: Error) =>
      e.message.includes('refusing to write under') &&
      e.message.includes('symbolic link') &&
      e.message.includes(join(cwd, '.owenloop')),
  );
  // The link target directory gained no hub.json — the write never escaped.
  assert.deepEqual(readdirSync(elsewhere), [], 'the symlink target directory was never written into');
});

test('SEC-3: writeFileAtomic fresh-create round-trips (trailing newline preserved) via the readers', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-fresh-'));
  const path = credentialFilePath({ HOME: home });
  const cred: Credential = { kind: 'oauth-pasted', accessToken: 'mcpat_z' };
  writeCredentialFile(path, { version: 2, hubs: { 'https://api.owenloop.com': { human: cred } } });
  assert.deepEqual(readCredentialFile(path).hubs['https://api.owenloop.com']?.human, cred);
  assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true, 'trailing newline preserved');

  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-fresh-bind-'));
  const bindPath = hubBindingPath(cwd);
  const binding: HubBinding = { version: 1, hub: 'https://api.owenloop.com' };
  writeHubBinding(bindPath, binding);
  assert.deepEqual(readHubBinding(bindPath), binding);
});

// ---- hub binding round-trip ----------------------------------------------

test('hub binding round-trips; missing file is null', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-bind-'));
  const path = hubBindingPath(cwd);
  assert.equal(readHubBinding(path), null);

  const binding: HubBinding = { version: 1, hub: 'https://api.owenloop.com' };
  writeHubBinding(path, binding);
  assert.deepEqual(readHubBinding(path), binding);
});

test('readHubBinding: a file with a leftover legacy `pushed` key still parses, key ignored', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-bind-'));
  const path = hubBindingPath(cwd);
  writeHubBinding(path, {
    version: 1,
    hub: 'https://api.owenloop.com',
    // @ts-expect-error -- simulating a pre-server-diff CLI's binding file
    pushed: { alpha: { localHash: 'h1', remoteVersion: 3, remoteHash: 'rh1', pushedAt: 10 } },
  });
  assert.deepEqual(readHubBinding(path), { version: 1, hub: 'https://api.owenloop.com' });
});

// ---- server diff ---------------------------------------------------------------

test('computeServerDiff: new when absent from server, changed when hash differs, unchanged when equal', () => {
  const server = new Map<string, WorkflowSummary>([
    ['same', { name: 'same', hash: 'H' }],
    ['drifted', { name: 'drifted', hash: 'OLD' }],
  ]);
  const defs = [
    { name: 'same', hash: 'H' },
    { name: 'drifted', hash: 'NEW' },
    { name: 'brandnew', hash: 'X' },
  ];
  const { toPush, unchanged } = computeServerDiff(defs, server, false);
  assert.deepEqual(unchanged.map((d) => d.name), ['same']);
  assert.deepEqual(
    toPush.map((d) => ({ name: d.name, status: d.status })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'brandnew', status: 'new' },
      { name: 'drifted', status: 'changed' },
    ],
  );
});

test('computeServerDiff: --force pushes everything, even unchanged, still labeled by presence', () => {
  const server = new Map<string, WorkflowSummary>([
    ['same', { name: 'same', hash: 'H' }],
  ]);
  const { toPush, unchanged } = computeServerDiff(
    [{ name: 'same', hash: 'H' }, { name: 'brandnew', hash: 'X' }],
    server,
    true,
  );
  assert.equal(unchanged.length, 0);
  assert.deepEqual(
    toPush.map((d) => ({ name: d.name, status: d.status })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'brandnew', status: 'new' },
      { name: 'same', status: 'changed' },
    ],
  );
});

test('computeServerDiff: a name absent from the server-vs-local diff on the server side is ignored', () => {
  const server = new Map<string, WorkflowSummary>([
    ['hubonly', { name: 'hubonly', hash: 'H' }],
  ]);
  const { toPush, unchanged } = computeServerDiff([{ name: 'local', hash: 'X' }], server, false);
  assert.deepEqual(toPush.map((d) => d.name), ['local']);
  assert.equal(unchanged.length, 0);
});

test('computeServerDiff: a server entry with no/undefined hash is treated as present-but-changed, not new', () => {
  // The type says `hash: string`, but a server response can omit it in
  // practice (e.g. a workflow row created before hashing existed). It's
  // present in the map (server.get returns a summary, not undefined), so it
  // must not be classified 'new' — it's 'changed', same as any other hash
  // mismatch, and will be re-pushed to backfill the hash.
  const server = new Map<string, WorkflowSummary>([
    ['nohash', { name: 'nohash' } as WorkflowSummary],
  ]);
  const { toPush, unchanged } = computeServerDiff([{ name: 'nohash', hash: 'X' }], server, false);
  assert.equal(unchanged.length, 0);
  assert.deepEqual(
    toPush.map((d) => ({ name: d.name, status: d.status })),
    [{ name: 'nohash', status: 'changed' }],
  );
});

// ---- create_workflow response guard ------------------------------------------

test('createWorkflowError: ok:true is null, ok:false surfaces the error verbatim', () => {
  assert.equal(createWorkflowError({ ok: true, name: 'x', version: 2, hash: 'h' }), null);
  assert.equal(createWorkflowError({ ok: false, error: 'engine version 2 unsupported' }), 'engine version 2 unsupported');
  assert.match(createWorkflowError('nope') ?? '', /unexpected response shape/);
});

test('asCreateWorkflowOk: carries unchanged:true through when the server reports a no-op', () => {
  const ok = asCreateWorkflowOk({ ok: true, name: 'x', version: 2, hash: 'h', unchanged: true }, 'x');
  assert.equal(ok.unchanged, true);
  const fresh = asCreateWorkflowOk({ ok: true, name: 'x', version: 3, hash: 'h2' }, 'x');
  assert.equal(fresh.unchanged, undefined);
});

test('asCreateWorkflowOk: a malformed 2xx is an error, not a defaulted success (REL-9)', () => {
  assert.throws(() => asCreateWorkflowOk('nope', 'x'), /not an object/);
  assert.throws(() => asCreateWorkflowOk({ ok: true, version: 2, hash: 'h' }, 'x'), /missing string name/);
  assert.throws(() => asCreateWorkflowOk({ ok: true, name: 'y', version: 2, hash: 'h' }, 'x'), /does not match pushed def/);
  assert.throws(() => asCreateWorkflowOk({ ok: true, name: 'x', hash: 'h' }, 'x'), /version must be a positive integer/);
  assert.throws(() => asCreateWorkflowOk({ ok: true, name: 'x', version: 0, hash: 'h' }, 'x'), /version must be a positive integer/);
  assert.throws(() => asCreateWorkflowOk({ ok: true, name: 'x', version: 1.5, hash: 'h' }, 'x'), /version must be a positive integer/);
  assert.throws(() => asCreateWorkflowOk({ ok: true, name: 'x', version: 2, hash: '' }, 'x'), /non-empty hash/);
  // A well-formed, consistent success still narrows cleanly.
  assert.deepEqual(asCreateWorkflowOk({ ok: true, name: 'x', version: 2, hash: 'h' }, 'x'), {
    ok: true,
    name: 'x',
    version: 2,
    hash: 'h',
  });
});

// ---- whoami response guard -----------------------------------------------

test('asWhoami: narrows a well-formed body, defaults missing optional fields', () => {
  const identity = asWhoami({
    orgId: 'org_1',
    orgName: 'Acme',
    actor: { id: 'user_1', kind: 'user', role: 'admin' },
    authMethod: 'oauth',
    email: 'a@example.com',
  });
  assert.deepEqual(identity, {
    orgId: 'org_1',
    orgName: 'Acme',
    actor: { id: 'user_1', kind: 'user', role: 'admin' },
    authMethod: 'oauth',
    email: 'a@example.com',
  });
});

test('asWhoami: throws on a missing orgId or non-object body', () => {
  assert.throws(() => asWhoami({}), /missing string orgId/);
  assert.throws(() => asWhoami('nope'), /unexpected response shape/);
});

// ---- mint_agent_token response guard (whitelist; token hygiene) ------------

test('asMintAgentTokenOk: narrows a well-formed body to the whitelisted fields only', () => {
  const ok = asMintAgentTokenOk({
    // The real server also carries the plaintext in `text` and extra fields like
    // poolIds — none of which must survive the narrow.
    text: 'Store this secret now — it will not be shown again:\nolp_secret',
    id: 'tok_1',
    token: 'olp_secret',
    agentId: 'agent_1',
    pools: ['personal-alex'],
    poolIds: ['pool_1'],
  });
  assert.deepEqual(ok, { id: 'tok_1', token: 'olp_secret', agentId: 'agent_1', pools: ['personal-alex'] });
  // No `text`/`poolIds` leaked through the whitelist.
  assert.equal((ok as unknown as Record<string, unknown>).text, undefined);
  assert.equal((ok as unknown as Record<string, unknown>).poolIds, undefined);
});

test('asMintAgentTokenOk: empty pools array is allowed defensively', () => {
  const ok = asMintAgentTokenOk({ id: 'tok_1', token: 'olp_x', agentId: 'a', pools: [] });
  assert.deepEqual(ok.pools, []);
});

test('asMintAgentTokenOk: a malformed body throws NAMING THE FIELD ONLY, never echoing a value', () => {
  // Each malformed field is rejected; the token value is never echoed in the message.
  const cases: [unknown, RegExp][] = [
    ['nope', /not an object/],
    [{ token: 'olp_x', agentId: 'a', pools: [] }, /missing non-empty string id/],
    [{ id: '', token: 'olp_x', agentId: 'a', pools: [] }, /missing non-empty string id/],
    [{ id: 'tok_1', token: 'olp_x', pools: [] }, /missing non-empty string agentId/],
    [{ id: 'tok_1', token: '', agentId: 'a', pools: [] }, /missing non-empty string token/],
    [{ id: 'tok_1', agentId: 'a', pools: [] }, /missing non-empty string token/],
    [{ id: 'tok_1', token: 'sk-live-notolp', agentId: 'a', pools: [] }, /not an olp_ token/],
    [{ id: 'tok_1', token: 'olp_x', agentId: 'a' }, /pools must be an array of strings/],
    [{ id: 'tok_1', token: 'olp_x', agentId: 'a', pools: [1, 2] }, /pools must be an array of strings/],
  ];
  for (const [body, re] of cases) {
    assert.throws(() => asMintAgentTokenOk(body), re);
    // The non-olp_ value must never appear verbatim in the thrown message.
    try {
      asMintAgentTokenOk(body);
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /sk-live-notolp/);
    }
  }
});

// ---- listStoredHubOrigins — file-store origin enumeration ------------------

test('listStoredHubOrigins: file backend lists human-slot origins; keychain → null', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-origins-'));
  // OWENLOOP_NO_KEYCHAIN=1 forces the FILE backend so the enumeration path runs
  // regardless of the host OS (on macOS the default backend is the keychain).
  const env = { HOME: home, OWENLOOP_NO_KEYCHAIN: '1' };
  // Missing credentials.json → empty store.
  assert.deepEqual(listStoredHubOrigins(env), []);
  // v2 with two origins that each carry a valid `human` slot, plus one that has
  // ONLY an `agent:<name>` slot — the agent-only origin is NOT returned, because
  // enumeration is for the human principal (auto-resolving `mcp` / `agent new`).
  const path = credentialFilePath(env);
  writeCredentialFile(path, {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'agent', accessToken: 'x' } },
      'https://b.example': { human: { kind: 'agent', accessToken: 'y' } },
      'https://agent-only.example': { 'agent:ci': { kind: 'agent', accessToken: 'z' } },
    },
  });
  // Non-null assertion: OWENLOOP_NO_KEYCHAIN=1 pins the file backend, which never
  // returns null (only the keychain/external backends do).
  assert.deepEqual(listStoredHubOrigins(env)!.sort(), ['https://a.example', 'https://b.example']);
  // A non-v2 file reads as an empty store (old keying is invisible).
  writeFileSync(path, JSON.stringify({ version: 1, hubs: { 'https://c.example': {} } }));
  assert.deepEqual(listStoredHubOrigins(env), []);
  // A keychain (or external-command) backend cannot enumerate → null, a signal
  // distinct from [] (file backend, nothing stored) that callers turn into a
  // "pass --hub" message.
  const { keychain } = fakeKeychain();
  assert.equal(listStoredHubOrigins({ HOME: home }, keychain), null);
});

// ---- workflow list response guard -----------------------------------------

test('parseWorkflowList: builds a name -> summary map, keeps optional version', () => {
  const map = parseWorkflowList({
    text: '',
    workflows: [
      { name: 'a', hash: 'ha', version: 3, steps: [] },
      { name: 'b', hash: 'hb', steps: [] },
    ],
  });
  assert.deepEqual(map.get('a'), { name: 'a', hash: 'ha', version: 3 });
  assert.deepEqual(map.get('b'), { name: 'b', hash: 'hb' });
  assert.equal(map.size, 2);
});

test('parseWorkflowList: throws on a missing/malformed workflows array or entry', () => {
  assert.throws(() => parseWorkflowList({}), /expected a `workflows` array/);
  assert.throws(() => parseWorkflowList({ workflows: ['nope'] }), /workflows\[0\] is not an object/);
  assert.throws(() => parseWorkflowList({ workflows: [{}] }), /workflows\[0\] missing string name/);
});

// ---- hashDefForHub — server-canonical content hash for the CLI push diff ----

function mktempDefsDir(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-defs-hub-'));
}

const CONTENT_YAML = 'name: portable\ninputs:\n  - name: x\nsteps:\n  - name: a\n    consumes: [x]\n    produces: [y]\n';

test('hashDefForHub: identical yaml hashes the same regardless of checkout directory, unlike hashDef', () => {
  const dirA = mktempDefsDir();
  const dirB = mktempDefsDir();
  try {
    const fileA = join(dirA, 'portable.yaml');
    const fileB = join(dirB, 'portable.yaml');
    writeFileSync(fileA, CONTENT_YAML);
    writeFileSync(fileB, CONTENT_YAML);
    const a = loadDefsRaw(dirA).get('portable')!;
    const b = loadDefsRaw(dirB).get('portable')!;
    assert.notEqual(a.dir, b.dir, 'sanity: the two defs really do live at different absolute paths');
    assert.notEqual(hashDef(a), hashDef(b), 'hashDef stays checkout-specific (includes def.dir)');

    // hashDefForHub must match the hub's own canonicalization exactly:
    // parseDef(YAML.parse(yaml)) with no baseDir — hub-canonical, not a stand-in.
    assert.equal(
      hashDefForHub(CONTENT_YAML),
      hashDef(parseDef(parseYamlText(CONTENT_YAML))),
      'hashDefForHub must reproduce parseDef(YAML.parse(yaml)) with no baseDir, exactly as the hub computes it',
    );

    // And it must be baseDir-independent in practice: loading the same YAML
    // text from two different checkout directories yields the same hub hash,
    // even though hashDef of the loaded defs differs (per the assertion above).
    assert.equal(
      hashDefForHub(readFileSync(fileA, 'utf8')),
      hashDefForHub(readFileSync(fileB, 'utf8')),
      'hashDefForHub is a pure function of the yaml text — portable across checkouts',
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('hashDefForHub: changes when the def body changes', () => {
  const a = hashDefForHub(CONTENT_YAML);
  const b = hashDefForHub(
    'name: portable\ninputs:\n  - name: x\nsteps:\n  - name: a\n    consumes: [x]\n    produces: [z]\n',
  );
  assert.notEqual(a, b);
});

test('hashDefForHub: throws a DefError naming bodyFile for a def that uses it (no baseDir to resolve against)', () => {
  const yaml = 'name: needs-file\nsteps:\n  - name: a\n    bodyFile: prompt.md\n    produces: [y]\n';
  assert.throws(() => hashDefForHub(yaml), (e: unknown) => e instanceof DefError && /bodyFile/.test((e as Error).message));
});
