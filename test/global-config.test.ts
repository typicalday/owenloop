/**
 * `src/global-config.ts` — the CONTROL plane's `~/.owenloop/config.json`
 * (written by `owenloop login`, read by `owenloop mcp`'s origin ladder;
 * see `resolveMcpOrigin` in `src/mcp/serve.ts` and its own acceptance suite,
 * `test/mcp.test.ts`, for the ladder itself). Proves, at the module level:
 * `globalConfigPath` joins `home` correctly; `writeGlobalConfig` round-trips
 * through `readGlobalConfig`, creates its parent directory on demand, writes
 * atomically (no stray temp file), and refuses a symlinked parent directory
 * (SEC-3, mirroring `writeHubBinding`'s own symlink-refusal test in
 * `test/hub.test.ts`); and `readGlobalConfig` returns `null` — never
 * throws — for every shape of corruption (missing file, invalid JSON,
 * non-object JSON, missing/non-string/blank `hub`, or a `hub` that does not
 * normalize to a valid http(s) origin), while a `hub` that DOES normalize
 * (e.g. a URL with a trailing path) comes back as the normalized origin, not
 * the raw string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath, readGlobalConfig, writeGlobalConfig } from '../src/global-config.ts';
import type { GlobalConfig } from '../src/global-config.ts';

/** A throwaway HOME dir for one test. */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'owenloop-globalconfig-home-'));
}

test('globalConfigPath: joins home + .owenloop/config.json', () => {
  const home = freshHome();
  assert.equal(globalConfigPath(home), join(home, '.owenloop', 'config.json'));
});

test('writeGlobalConfig + readGlobalConfig: round-trips', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  const config: GlobalConfig = { version: 1, hub: 'https://hub.example' };

  writeGlobalConfig(path, config);
  assert.deepEqual(readGlobalConfig(path), config);
});

test('writeGlobalConfig: creates the parent .owenloop directory when missing', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  assert.equal(existsSync(dirname(path)), false, 'dir absent before write');

  writeGlobalConfig(path, { version: 1, hub: 'https://hub.example' });
  assert.equal(existsSync(path), true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).hub, 'https://hub.example');
});

test('writeGlobalConfig: writes atomically — no stray temp file left behind', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  writeGlobalConfig(path, { version: 1, hub: 'https://hub.example' });

  const leftovers = readdirSync(dirname(path)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no stray temp file after a successful write');
});

test('SEC-3: writeGlobalConfig refuses a symlinked .owenloop parent, leaving the link target directory intact', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-globalconfig-parentsym-'));
  // The attacker's redirect target: a real directory elsewhere.
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-globalconfig-elsewhere-'));
  // A hostile HOME ships `.owenloop -> /elsewhere`.
  symlinkSync(elsewhere, join(home, '.owenloop'));

  const path = globalConfigPath(home);
  assert.throws(
    () => writeGlobalConfig(path, { version: 1, hub: 'https://hub.example' }),
    (e: Error) =>
      e.message.includes('refusing to write under') &&
      e.message.includes('symbolic link') &&
      e.message.includes(join(home, '.owenloop')),
  );
  // The link target directory gained no config.json — the write never escaped.
  assert.deepEqual(readdirSync(elsewhere), [], 'the symlink target directory was never written into');
});

test('readGlobalConfig: a missing file is null (not an error)', () => {
  const home = freshHome();
  assert.equal(readGlobalConfig(globalConfigPath(home)), null);
});

test('readGlobalConfig: invalid JSON is null', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ not valid json');
  assert.equal(readGlobalConfig(path), null);
});

test('readGlobalConfig: valid JSON that is not an object is null', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });

  for (const content of ['[1,2,3]', '"just a string"', '42', 'null']) {
    writeFileSync(path, content);
    assert.equal(readGlobalConfig(path), null, `content: ${content}`);
  }
});

test('readGlobalConfig: a missing, non-string, or blank hub field is null', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });

  for (const body of [{ version: 1 }, { version: 1, hub: 12345 }, { version: 1, hub: '' }, { version: 1, hub: '   ' }]) {
    writeFileSync(path, JSON.stringify(body));
    assert.equal(readGlobalConfig(path), null, `body: ${JSON.stringify(body)}`);
  }
});

test('readGlobalConfig: a hub that does not normalize to a valid http(s) origin is null', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });

  for (const hub of ['not a url', 'ftp://hub.example', 'http://hub.example']) {
    // 'http://hub.example' is invalid because plain http is only allowed for
    // loopback hosts (127.0.0.1, ::1, localhost) — see normalizeOrigin.
    writeFileSync(path, JSON.stringify({ version: 1, hub }));
    assert.equal(readGlobalConfig(path), null, `hub: ${hub}`);
  }
});

test('readGlobalConfig: a hub value that normalizes comes back normalized, not verbatim', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });

  writeFileSync(path, JSON.stringify({ version: 1, hub: 'https://hub.example/some/path?x=1' }));
  assert.deepEqual(readGlobalConfig(path), { version: 1, hub: 'https://hub.example' });

  // A loopback http URL is valid and normalizes too (trailing slash stripped).
  writeFileSync(path, JSON.stringify({ version: 1, hub: 'http://127.0.0.1:9/' }));
  assert.deepEqual(readGlobalConfig(path), { version: 1, hub: 'http://127.0.0.1:9' });
});

test('writeGlobalConfig: the written file never contains an olp_ token', () => {
  const home = freshHome();
  const path = globalConfigPath(home);
  writeGlobalConfig(path, { version: 1, hub: 'https://hub.example' });
  assert.doesNotMatch(readFileSync(path, 'utf8'), /olp_/, 'no secret ever reaches the global config file');
});
