/**
 * `owenloop add <owner>/<repo>[@ref]` — driven in-process through `mainAsync`
 * with an injected `fetch` (see CliIO.fetch in src/cli.ts). No real network:
 * the fake fetch resolves the sha-lookup and tarball URLs from a canned map,
 * built with test/helpers.ts's independent tar-gz writer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
import {
  acquireInstallLock,
  ADD_JOURNAL_FILENAME,
  archivePathViolation,
  commitInstall,
  finalizeInstallCommit,
  installFolder,
  lockfilePathViolation,
  parkOldNameDir,
  readAddJournal,
  readLockfile,
  recoverInterruptedInstall,
  releaseInstallLock,
  rollbackInstallCommit,
  STAGING_DIRNAME,
  validateAddJournal,
  validateLockfile,
  writeAddJournal,
  writeLockfile,
  type AddJournal,
  type Lockfile,
} from '../src/add.ts';
import { makeGithubTarball } from './helpers.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/**
 * A minimal-but-valid single-step workflow def, so lint/validate/check all
 * pass clean. `maxSchemaFailures: 0` disables the schema-stall path in the
 * model checker — without it, even this trivial single-producer step has a
 * genuine (not a false positive) reachable dead end once 'out' racks up
 * enough consecutive schema-rejects, since nothing can invalidate/retry it.
 * Real multi-step defs (e.g. examples/workflows/delivery.yaml) have the same
 * property but are large enough that modelCheck's default maxStates bound
 * is hit before that branch is ever fully explored, so it's masked there;
 * this fixture is small enough to explore exhaustively, so it needs the same
 * `maxSchemaFailures: 0` escape hatch test/check.test.ts's own fixtures use
 * (see `deliveryProvidedNoSchemaStall`).
 */
function validDefYaml(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '',
  ].join('\n');
}

/** A def that fails validateDef: 'worker' consumes 'ghost', which nothing produces. */
const INVALID_DEF_YAML = [
  'name: broken',
  'inputs:',
  '  - name: seed',
  'steps:',
  '  - name: worker',
  '    consumes: [ghost]',
  '    produces: [out]',
  '    terminal: true',
  '',
].join('\n');

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** Builds an injected `fetch` keyed by exact URL, and records every call (url + headers). */
function fakeFetch(responses: Record<string, { status: number; body: string | Buffer }>): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const resp = responses[url];
    if (!resp) throw new Error(`fakeFetch: no canned response for ${url}`);
    const body = typeof resp.body === 'string' ? resp.body : new Uint8Array(resp.body);
    return new Response(body, { status: resp.status });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

/** A CliIO bound to a fresh temp cwd, with the given injected fetch. */
function makeIo(
  fetchFn: typeof globalThis.fetch,
  env: Record<string, string> = {},
): { io: CliIO; cwd: string; out: string[]; err: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    cwd,
    env,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetch: fetchFn,
  };
  return { io, cwd, out, err };
}

function shaUrl(owner: string, repo: string, ref: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`;
}
function tarballUrl(owner: string, repo: string, sha: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
}

function lockfilePath(cwd: string): string {
  return join(cwd, '.owenloop', 'installed.json');
}

// ---- happy path --------------------------------------------------------------

test('add: happy path installs a valid def, writes the lockfile, and reports it', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/foo.yaml': validDefYaml('foo'),
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, cwd, out } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 0, out.join('\n'));

  const result = JSON.parse(out.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.source, `${owner}/${repo}`);
  assert.equal(result.ref, 'HEAD');
  assert.equal(result.sha, SHA_A);
  assert.equal(result.path, installFolder(owner, repo));
  assert.equal(result.installed, 1);
  assert.deepEqual(result.defs, ['foo']);

  const installedFile = join(cwd, 'workflows', installFolder(owner, repo), 'foo.yaml');
  assert.ok(existsSync(installedFile), 'def file landed under <defsDir>/<installFolder>/');
  assert.equal(readFileSync(installedFile, 'utf8'), validDefYaml('foo'));

  const lf = JSON.parse(readFileSync(lockfilePath(cwd), 'utf8'));
  const entry = lf.installed[`${owner}/${repo}`];
  assert.equal(entry.source, `${owner}/${repo}`);
  assert.equal(entry.ref, 'HEAD');
  assert.equal(entry.sha, SHA_A);
  assert.equal(entry.path, installFolder(owner, repo));
  assert.deepEqual(entry.files, ['foo.yaml']);
  assert.equal(typeof entry.installedAt, 'number');
});

test('add: a misspelled option is rejected before any network I/O — nothing fetched or installed', async () => {
  // No canned responses: any fetch would throw. The guard must fire first.
  const { fetch, calls } = fakeFetch({});
  const { io, cwd, err } = makeIo(fetch);

  const code = await mainAsync(['add', 'acme/widgets', '--dfes'], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /--dfes/, 'names the offending option');
  assert.match(err.join('\n'), /did you mean --defs\?/, 'suggests the nearest valid option');
  assert.equal(calls.length, 0, 'zero fetches — the sha lookup never runs');
  assert.equal(existsSync(lockfilePath(cwd)), false, 'no lockfile written');
  assert.equal(existsSync(join(cwd, 'workflows')), false, 'nothing installed');
});

test('add: an explicit @ref is preserved in the report and lockfile (pinned to the resolved sha)', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/foo.yaml': validDefYaml('foo'),
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'v2')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, out } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}@v2`], io);
  assert.equal(code, 0, out.join('\n'));
  const result = JSON.parse(out.join('\n'));
  assert.equal(result.ref, 'v2');
  assert.equal(result.sha, SHA_A);
});

// ---- idempotent re-add --------------------------------------------------------

test('add: re-adding with different content replaces the lockfile entry and drops removed files', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarballV1 = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/foo.yaml': validDefYaml('foo'),
    'workflows/bar.yaml': validDefYaml('bar'),
  });
  const tarballV2 = makeGithubTarball(`${owner}-${repo}-${SHA_B}`, {
    'workflows/foo.yaml': validDefYaml('foo'), // bar.yaml dropped in this version
  });

  // Same temp cwd for both calls (a real re-add reuses the same defsDir/lockfile);
  // each call gets its own fetch since HEAD resolves to a different sha each time.
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const ioFor = (fetchFn: typeof globalThis.fetch): { io: CliIO; out: string[] } => {
    const out: string[] = [];
    return { io: { cwd, env: {}, out: (s) => out.push(s), err: () => {}, fetch: fetchFn }, out };
  };

  const { fetch: firstFetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarballV1 },
  });
  const first = ioFor(firstFetch);
  assert.equal(await mainAsync(['add', `${owner}/${repo}`], first.io), 0, first.out.join('\n'));

  const folder = join(cwd, 'workflows', installFolder(owner, repo));
  assert.ok(existsSync(join(folder, 'bar.yaml')), 'bar.yaml present after first add');

  const { fetch: secondFetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_B },
    [tarballUrl(owner, repo, SHA_B)]: { status: 200, body: tarballV2 },
  });
  const second = ioFor(secondFetch);
  assert.equal(await mainAsync(['add', `${owner}/${repo}`], second.io), 0, second.out.join('\n'));
  const result = JSON.parse(second.out.join('\n'));
  assert.equal(result.sha, SHA_B);
  assert.deepEqual(result.defs, ['foo']);

  assert.ok(existsSync(join(folder, 'foo.yaml')), 'foo.yaml still present');
  assert.ok(!existsSync(join(folder, 'bar.yaml')), 'stale bar.yaml removed on re-add');

  const lf = JSON.parse(readFileSync(lockfilePath(cwd), 'utf8'));
  const entry = lf.installed[`${owner}/${repo}`];
  assert.equal(entry.sha, SHA_B);
  assert.deepEqual(entry.files, ['foo.yaml']);
});

// ---- invalid def refuses the WHOLE add ---------------------------------------

test('add: a def that fails validation refuses the whole add — nothing written, no lockfile entry', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/good.yaml': validDefYaml('good'),
    'workflows/broken.yaml': INVALID_DEF_YAML,
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, cwd, err } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /refusing to install/);
  assert.match(err.join('\n'), /broken/);

  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'defsDir untouched on refusal');
  assert.ok(!existsSync(lockfilePath(cwd)), 'no lockfile written on refusal');
});

// ---- no workflows/ dir in the tarball -----------------------------------------

test('add: a tarball with no workflows/ directory refuses with a specific message', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'README.md': '# nothing to see here\n',
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, err } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /no workflows\/ directory found/);
  assert.match(err.join('\n'), new RegExp(`${owner}/${repo}@HEAD`));
});

// ---- 404 on sha resolve --------------------------------------------------------

test('add: a 404 resolving the ref exits 1 with a status-bearing message', async () => {
  const owner = 'acme';
  const repo = 'ghost-repo';
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 404, body: 'Not Found' },
  });
  const { io, err } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /404/);
  assert.match(err.join('\n'), /not found/i);
});

// ---- malformed spec ------------------------------------------------------------

test('add: a malformed repo spec exits 1 with a clear error, before any fetch happens', async () => {
  const { fetch, calls } = fakeFetch({});
  for (const bad of ['foo', '/repo', 'owner/', '']) {
    const { io, err } = makeIo(fetch);
    const code = await mainAsync(bad === '' ? ['add'] : ['add', bad], io);
    assert.equal(code, 1, bad);
    assert.match(err.join('\n'), bad === '' ? /missing required argument/ : /malformed repo spec/, bad);
  }
  assert.equal(calls.length, 0, 'no network call for any malformed spec');
});

// ---- header assertions ----------------------------------------------------------

test('add: sends the sha-resolve Accept header and a User-Agent on both requests', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/foo.yaml': validDefYaml('foo'),
  });
  const { fetch, calls } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 0);

  assert.equal(calls.length, 2);
  const shaCall = calls.find((c) => c.url === shaUrl(owner, repo, 'HEAD'));
  const tarCall = calls.find((c) => c.url === tarballUrl(owner, repo, SHA_A));
  assert.ok(shaCall && tarCall);

  const shaHeaders = new Headers(shaCall!.init?.headers);
  assert.equal(shaHeaders.get('Accept'), 'application/vnd.github.sha');
  assert.equal(shaHeaders.get('User-Agent'), 'owenloop');

  const tarHeaders = new Headers(tarCall!.init?.headers);
  assert.equal(tarHeaders.get('User-Agent'), 'owenloop');
});

// ---- empty workflows/ dir (tracked, but zero yaml defs) is a success ----------

test('add: a workflows/ dir with no yaml defs is a success, installing nothing', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/.gitkeep': '',
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, cwd, out } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 0, out.join('\n'));
  const result = JSON.parse(out.join('\n'));
  assert.equal(result.installed, 1); // .gitkeep itself is copied; zero defs
  assert.deepEqual(result.defs, []);

  const lf = JSON.parse(readFileSync(lockfilePath(cwd), 'utf8'));
  assert.ok(lf.installed[`${owner}/${repo}`]);
});

// ---- corrupt gzip bytes ---------------------------------------------------------

test('add: corrupt/non-gzip tarball bytes surface as a clear CliError', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: Buffer.from([1, 2, 3, 4]) },
  });
  const { io, err } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /could not extract tarball/);
});

// ---- SEC-1: archive path escape refused --------------------------------------

test('add: an archive entry that escapes with ../ refuses the whole add — nothing written', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/good.yaml': validDefYaml('good'),
    'workflows/../../victim.yaml': 'name: pwned\n',
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, cwd, err } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /unsafe archive path/);
  assert.match(err.join('\n'), /victim\.yaml/);

  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'defsDir untouched on refusal');
  assert.ok(!existsSync(lockfilePath(cwd)), 'no lockfile written on refusal');
  assert.ok(!existsSync(join(cwd, 'victim.yaml')), 'victim not written into cwd');
});

test('add: a def whose bodyFile escapes with ../ is refused during staging validation (SEC-1 repro)', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const auditDef = [
    'name: audit',
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '    bodyFile: ../../../../etc/hosts',
    '',
  ].join('\n');
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/audit.yaml': auditDef,
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, cwd, err } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /refusing to install/);
  assert.match(err.join('\n'), /bodyFile/);

  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'nothing installed');
  assert.ok(!existsSync(lockfilePath(cwd)), 'no lockfile written on refusal');
});

test('add: a package whose def uses a contained bodyFile installs cleanly', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const fooDef = [
    'name: foo',
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '    bodyFile: prompts/x.md',
    '',
  ].join('\n');
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/foo.yaml': fooDef,
    'workflows/prompts/x.md': 'do the thing\n',
  });
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io, cwd, out } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 0, out.join('\n'));
  const result = JSON.parse(out.join('\n'));
  assert.deepEqual(result.defs, ['foo']);
  assert.equal(result.installed, 2); // foo.yaml + prompts/x.md
  assert.ok(existsSync(join(cwd, 'workflows', installFolder(owner, repo), 'prompts', 'x.md')));
});

// ---- SEC-1: fetch timeout wiring ---------------------------------------------

test('add: both fetches carry an AbortSignal deadline', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/foo.yaml': validDefYaml('foo'),
  });
  const { fetch, calls } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  });
  const { io } = makeIo(fetch);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.init?.signal instanceof AbortSignal, `expected an AbortSignal on ${call.url}`);
  }
});

test('add: a fetch timeout surfaces as a friendly CliError', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  // A fetch that behaves like an aborted request: rejects with a TimeoutError,
  // exactly as AbortSignal.timeout drives undici.
  const fetchFn = (async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as unknown as typeof globalThis.fetch;
  const { io, err } = makeIo(fetchFn);

  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /timed out after 30s resolving acme\/widgets@HEAD/);
});

// ---- archivePathViolation (unit) ---------------------------------------------

test('archivePathViolation: accepts safe relative paths and rejects unsafe ones', () => {
  // safe
  assert.equal(archivePathViolation('foo.yaml'), undefined);
  assert.equal(archivePathViolation('a/b/c.yaml'), undefined);
  assert.equal(archivePathViolation('prompts/x.md'), undefined);
  // unsafe
  assert.ok(archivePathViolation(''), 'empty');
  assert.ok(archivePathViolation('/etc/passwd'), 'absolute posix');
  assert.ok(archivePathViolation('C:\\Windows\\system32'), 'windows drive');
  assert.ok(archivePathViolation('../x'), 'leading dotdot');
  assert.ok(archivePathViolation('a/../b'), 'embedded dotdot');
  assert.ok(archivePathViolation('a\\..\\b'), 'backslash dotdot');
  assert.ok(archivePathViolation('./x'), 'dot segment');
  assert.ok(archivePathViolation('a\0b'), 'NUL byte');
  assert.ok(archivePathViolation('x'.repeat(2000)), 'overlong');
});

// ---- REL-1: collision-free naming --------------------------------------------

const SHA_C = 'c'.repeat(40);

/** Run one `add` against a fixed cwd, returning the exit code + parsed report. */
async function addInto(
  cwd: string,
  owner: string,
  repo: string,
  sha: string,
  files: Record<string, string>,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const tarball = makeGithubTarball(`${owner}-${repo}-${sha}`, files);
  const { fetch } = fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: sha },
    [tarballUrl(owner, repo, sha)]: { status: 200, body: tarball },
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { cwd, env: {}, out: (s) => out.push(s), err: (s) => err.push(s), fetch };
  const code = await mainAsync(['add', `${owner}/${repo}`], io);
  return { code, out, err };
}

test('add: two sources that collided under the old <owner>-<repo> scheme now coexist', async () => {
  // The old naming mapped both `a-b/c` and `a/b-c` to `a-b-c`; the second add
  // clobbered the first. The hash suffix distinguishes them.
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const r1 = await addInto(cwd, 'a-b', 'c', SHA_A, { 'workflows/one.yaml': validDefYaml('one') });
  assert.equal(r1.code, 0, r1.out.join('\n'));
  const r2 = await addInto(cwd, 'a', 'b-c', SHA_B, { 'workflows/two.yaml': validDefYaml('two') });
  assert.equal(r2.code, 0, r2.out.join('\n'));

  const p1 = JSON.parse(r1.out.join('\n')).path;
  const p2 = JSON.parse(r2.out.join('\n')).path;
  assert.notEqual(p1, p2, 'the two sources resolve to distinct folders');
  assert.ok(existsSync(join(cwd, 'workflows', installFolder('a-b', 'c'), 'one.yaml')), 'first install intact');
  assert.ok(existsSync(join(cwd, 'workflows', installFolder('a', 'b-c'), 'two.yaml')), 'second install intact');

  const lf = readLockfile(lockfilePath(cwd));
  assert.ok(lf.installed['a-b/c'], 'first source recorded');
  assert.ok(lf.installed['a/b-c'], 'second source recorded');
  assert.notEqual(lf.installed['a-b/c']!.path, lf.installed['a/b-c']!.path);
});

test('add: refuses when the destination exists but the lockfile does not record this source owning it', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  // A foreign dir already sits at the computed destination, with no lockfile entry.
  const dest = join(cwd, 'workflows', installFolder(owner, repo));
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'sentinel.txt'), 'do not clobber me');

  const { code, err } = await addInto(cwd, owner, repo, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /already exists and is not owned/);

  assert.equal(readFileSync(join(dest, 'sentinel.txt'), 'utf8'), 'do not clobber me', 'sentinel untouched');
  assert.ok(!existsSync(lockfilePath(cwd)), 'no lockfile entry written on refusal');
});

// ---- REL-2: project-level install lock ---------------------------------------

test('add: concurrent adds of two sources into one project both land, lockfile stays consistent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const [a, b] = await Promise.all([
    addInto(cwd, 'acme', 'one', SHA_A, { 'workflows/one.yaml': validDefYaml('one') }),
    addInto(cwd, 'acme', 'two', SHA_B, { 'workflows/two.yaml': validDefYaml('two') }),
  ]);
  assert.equal(a.code, 0, a.out.join('\n'));
  assert.equal(b.code, 0, b.out.join('\n'));

  const lf = readLockfile(lockfilePath(cwd));
  assert.ok(lf.installed['acme/one'], 'first entry survives the interleave');
  assert.ok(lf.installed['acme/two'], 'second entry survives the interleave');
  assert.ok(existsSync(join(cwd, 'workflows', installFolder('acme', 'one'), 'one.yaml')));
  assert.ok(existsSync(join(cwd, 'workflows', installFolder('acme', 'two'), 'two.yaml')));
});

test('acquireInstallLock: a live holder makes a second acquire wait, then time out cleanly; release re-enables it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');

  const first = await acquireInstallLock(lockPath);
  await assert.rejects(
    acquireInstallLock(lockPath, { waitMs: 40, pollMs: 5 }),
    /timed out waiting after/,
  );
  releaseInstallLock(first);

  const second = await acquireInstallLock(lockPath, { waitMs: 40, pollMs: 5 });
  assert.ok(second.acquired, 'lock re-acquirable after release');
  releaseInstallLock(second);
});

test('acquireInstallLock: reclaims a lock whose holder pid is dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() }));

  const handle = await acquireInstallLock(lockPath, { isPidAlive: () => false, waitMs: 40, pollMs: 5 });
  assert.ok(handle.acquired, 'dead-pid lock reclaimed');
  releaseInstallLock(handle);
});

test('acquireInstallLock: a live same-host holder is NOT stolen by age — second acquire refuses, lock untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');
  // A live holder: this process's own pid, current host, a fresh token, an old start.
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now() - 60 * 60_000,
    token: 'a'.repeat(32),
    host: hostname(),
  });
  writeFileSync(lockPath, payload);

  // Backdate the lock's mtime an hour into the past — genuinely past the
  // 10-minute stale window (real clock, so the wait deadline is still
  // reachable). Under the OLD age-based policy this reclaimed the lock; under
  // the liveness-aware policy a live pid is never stolen regardless of age.
  const anHourAgo = new Date(Date.now() - 60 * 60_000);
  utimesSync(lockPath, anHourAgo, anHourAgo);

  await assert.rejects(
    acquireInstallLock(lockPath, { waitMs: 40, pollMs: 5 }),
    /another owenloop add is in progress.*timed out waiting after/,
  );
  assert.equal(readFileSync(lockPath, 'utf8'), payload, 'live holder lock byte-identical after refusal');
});

test('acquireInstallLock: reclaims a dead-pid lock in the new token+host payload format', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, startedAt: Date.now(), token: 'b'.repeat(32), host: hostname() }),
  );

  const handle = await acquireInstallLock(lockPath, { isPidAlive: () => false, waitMs: 40, pollMs: 5 });
  assert.ok(handle.acquired, 'dead-pid lock reclaimed (new-format payload)');
  releaseInstallLock(handle);
});

test('acquireInstallLock: a foreign-host lock is treated as held even if its pid is free locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');
  const payload = JSON.stringify({
    pid: 4242,
    startedAt: Date.now(),
    token: 'c'.repeat(32),
    host: 'some-other-host',
  });
  writeFileSync(lockPath, payload);

  // isPidAlive: () => false proves liveness is not even consulted for a foreign
  // host — a different host's PID space says nothing about a local pid.
  await assert.rejects(
    acquireInstallLock(lockPath, { isPidAlive: () => false, waitMs: 40, pollMs: 5 }),
    /another owenloop add is in progress.*timed out waiting after/,
  );
  assert.equal(readFileSync(lockPath, 'utf8'), payload, 'foreign-host lock untouched');
});

test('releaseInstallLock: does not delete a lock whose token no longer matches, and never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');

  const handle = await acquireInstallLock(lockPath);
  // Simulate another process reclaiming and re-acquiring: overwrite with a different token.
  const foreign = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'd'.repeat(32), host: hostname() });
  writeFileSync(lockPath, foreign);

  releaseInstallLock(handle); // must NOT delete someone else's lock, must not throw
  assert.ok(existsSync(lockPath), 'foreign-owned lock still present');
  assert.equal(readFileSync(lockPath, 'utf8'), foreign, 'foreign-owned lock byte-identical');
});

test('acquireInstallLock: an unparseable lock fails closed, then is reclaimed once past the abandonment window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');
  writeFileSync(lockPath, 'not json at all');

  // Fails closed while recent: no live owner attributable, mtime within window → held.
  await assert.rejects(
    acquireInstallLock(lockPath, { waitMs: 40, pollMs: 5 }),
    /another owenloop add is in progress.*timed out waiting after/,
  );
  assert.equal(readFileSync(lockPath, 'utf8'), 'not json at all', 'unparseable lock untouched while recent');

  // Once the clock is far past the stale window, the abandoned lock is reclaimable.
  const future = Date.now() + 60 * 60_000;
  const handle = await acquireInstallLock(lockPath, { now: () => future, waitMs: 40, pollMs: 5 });
  assert.ok(handle.acquired, 'abandoned unparseable lock reclaimed past the stale window');
  releaseInstallLock(handle);
});

test(
  'acquireInstallLock: an unreadable, backdated lock still respects waitMs and rejects — no sleepless spin',
  {
    // chmod 0o000 does not block root reads, so the EACCES path this exercises
    // cannot arise as root — skip rather than false-pass.
    skip:
      typeof process.getuid === 'function' && process.getuid() === 0
        ? 'requires non-root: chmod 0o000 must actually block reads'
        : false,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
    const lockPath = join(dir, 'add.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    // Backdate mtime past the stale window, then make the file unreadable:
    // statSync still succeeds (dir perms), but readFileSync EACCES → raw null →
    // lockIsStale's case-4 age path judges it stale. Regression: the re-verify
    // branch used to `continue` on the null re-read, bypassing BOTH the deadline
    // check and the poll sleep — a synchronous, sleepless busy-loop that starved
    // the event loop and never enforced waitMs. It must now poll and time out.
    const anHourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(lockPath, anHourAgo, anHourAgo);
    chmodSync(lockPath, 0o000);
    try {
      await assert.rejects(
        acquireInstallLock(lockPath, { waitMs: 40, pollMs: 5 }),
        /timed out waiting after/,
      );
    } finally {
      chmodSync(lockPath, 0o600); // restore so mkdtemp teardown can remove it
    }
  },
);

test('acquireInstallLock: an out-of-range startedAt yields the clean timeout message, not a RangeError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');
  // Lock content is untrusted: a finite startedAt outside the ECMAScript Date
  // range would make `new Date(startedAt).toISOString()` throw RangeError while
  // building the timeout message. A live same-host holder so the message path
  // is reached; the offending value must be omitted, not blow up.
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: 1e30,
    token: 'e'.repeat(32),
    host: hostname(),
  });
  writeFileSync(lockPath, payload);

  await assert.rejects(
    acquireInstallLock(lockPath, { waitMs: 40, pollMs: 5 }),
    (err) =>
      err instanceof Error &&
      !(err instanceof RangeError) &&
      !/Invalid time value/.test(err.message) &&
      /another owenloop add is in progress.*timed out waiting after/.test(err.message),
  );
  assert.equal(readFileSync(lockPath, 'utf8'), payload, 'live holder lock untouched after refusal');
});

// ---- REL-3: staged install, atomic commit, rollback --------------------------

test('add: a failed re-add leaves the prior install and lockfile byte-identical, with no staging debris', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  // Install a valid version A.
  const a = await addInto(cwd, owner, repo, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(a.code, 0, a.out.join('\n'));
  const dest = join(cwd, 'workflows', installFolder(owner, repo));
  const fooBefore = readFileSync(join(dest, 'foo.yaml'), 'utf8');
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  // Re-add the same source with a package that fails validation AFTER staging
  // but BEFORE commit — the injected mid-install failure.
  const b = await addInto(cwd, owner, repo, SHA_B, {
    'workflows/foo.yaml': validDefYaml('foo'),
    'workflows/broken.yaml': INVALID_DEF_YAML,
  });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /refusing to install/);

  assert.equal(readFileSync(join(dest, 'foo.yaml'), 'utf8'), fooBefore, 'prior install untouched');
  assert.ok(!existsSync(join(dest, 'broken.yaml')), 'broken def never committed');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged');
  assert.ok(!existsSync(join(cwd, 'workflows', '.owenloop-staging')), 'no staging debris left behind');
});

test('add: pre-existing staging debris is cleared by a successful add', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const debris = join(cwd, 'workflows', '.owenloop-staging', 'stg_leftover');
  mkdirSync(debris, { recursive: true });
  writeFileSync(join(debris, 'junk.yaml'), 'stale\n');

  const { code, out } = await addInto(cwd, owner, repo, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(code, 0, out.join('\n'));
  assert.ok(!existsSync(join(cwd, 'workflows', '.owenloop-staging')), 'staging root removed after success');
});

// ---- lockfile write + directory commit are one recoverable operation ---------

/**
 * Inject a deterministic lockfile-write failure that fires AFTER the directory
 * swap. `writeLockfile` writes to `${installed.json}.tmp.${process.pid}` before
 * the atomic rename; the tests run in-process, so `process.pid` is ours. A
 * DIRECTORY at that exact path makes `writeFileSync(tmp, …)` throw EISDIR at the
 * lockfile-write stage — after the commit swap, before finalize — with no
 * production test seam. Returns the injected path so the test can clean it up.
 */
function injectLockfileWriteFailure(cwd: string): string {
  const owenloopDir = join(cwd, '.owenloop');
  mkdirSync(owenloopDir, { recursive: true });
  const injected = join(owenloopDir, `installed.json.tmp.${process.pid}`);
  mkdirSync(injected, { recursive: true });
  return injected;
}

test('add: a lockfile-write failure on a fresh install rolls back to nothing installed', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const injected = injectLockfileWriteFailure(cwd);

  const { code, err } = await addInto(cwd, owner, repo, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /could not record install/);
  assert.match(err.join('\n'), /rolled back, previous state restored/);
  assert.match(err.join('\n'), /EISDIR/, 'underlying fs error surfaced');

  const dest = join(cwd, 'workflows', installFolder(owner, repo));
  assert.ok(!existsSync(dest), 'rolled back — no unmanaged install directory left behind');
  assert.ok(!existsSync(lockfilePath(cwd)), 'no lockfile written');
  assert.ok(!existsSync(join(cwd, 'workflows', STAGING_DIRNAME)), 'no staging debris');
  rmSync(injected, { recursive: true, force: true });
});

test('add: a lockfile-write failure on a re-add restores the prior install and lockfile byte-for-byte', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const a = await addInto(cwd, owner, repo, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(a.code, 0, a.out.join('\n'));
  const dest = join(cwd, 'workflows', installFolder(owner, repo));
  const fooBefore = readFileSync(join(dest, 'foo.yaml'), 'utf8');
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  const injected = injectLockfileWriteFailure(cwd);
  const b = await addInto(cwd, owner, repo, SHA_B, {
    'workflows/foo.yaml': validDefYaml('foo'),
    'workflows/extra.yaml': validDefYaml('extra'),
  });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /could not record install/);

  assert.equal(readFileSync(join(dest, 'foo.yaml'), 'utf8'), fooBefore, 'prior install restored byte-identical');
  assert.ok(!existsSync(join(dest, 'extra.yaml')), 'the v2-only file was never committed');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged');
  assert.ok(!existsSync(join(cwd, 'workflows', STAGING_DIRNAME)), 'no staging debris');
  rmSync(injected, { recursive: true, force: true });
});

test('add: a lockfile-write failure during old-name migration keeps the old dir and lockfile intact', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  // Manufacture pre-hash state: an old `<owner>-<repo>` dir this source owns.
  const oldRel = `${owner}-${repo}`;
  const oldDir = join(cwd, 'workflows', oldRel);
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'foo.yaml'), validDefYaml('foo'));
  const seedLf: Lockfile = {
    version: 1,
    installed: {
      [`${owner}/${repo}`]: {
        source: `${owner}/${repo}`,
        ref: 'HEAD',
        sha: SHA_A,
        installedAt: 1,
        path: oldRel,
        files: ['foo.yaml'],
      },
    },
  };
  writeLockfile(lockfilePath(cwd), seedLf);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  const injected = injectLockfileWriteFailure(cwd);
  const b = await addInto(cwd, owner, repo, SHA_B, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /could not record install/);

  assert.equal(readFileSync(join(oldDir, 'foo.yaml'), 'utf8'), validDefYaml('foo'), 'old-name dir still present');
  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'hashed dir absent after rollback');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged (still records the old path)');
  assert.ok(!existsSync(join(cwd, 'workflows', STAGING_DIRNAME)), 'no staging debris');
  rmSync(injected, { recursive: true, force: true });
});

// ---- SEC-3 (re-audit HIGH): lockfile path validation + containment ----------
//
// A crafted committed `.owenloop/installed.json` must never make `add` move —
// and then recursively DELETE — a directory outside the defs dir. Each refusal
// below asserts: exit 1, a clear error, and NO filesystem mutation of the
// out-of-tree target (the victim still exists with its contents) plus an
// unchanged lockfile.

test('add: a lockfile entry whose path traverses out with ../ is refused on read; victim untouched', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  // A victim dir OUTSIDE the defs dir, with a sentinel to prove it is untouched.
  const victim = join(cwd, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep.txt'), 'do not delete me');

  const seedLf: Lockfile = {
    version: 1,
    installed: {
      [`${owner}/${repo}`]: {
        source: `${owner}/${repo}`,
        ref: 'HEAD',
        sha: SHA_A,
        installedAt: 1,
        path: '../victim',
        files: ['foo.yaml'],
      },
    },
  };
  // Seed the poisoned lockfile by hand (writeLockfile does not validate paths).
  mkdirSync(join(cwd, '.owenloop'), { recursive: true });
  writeFileSync(lockfilePath(cwd), `${JSON.stringify(seedLf, null, 2)}\n`);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  const b = await addInto(cwd, owner, repo, SHA_B, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /invalid lockfile/);
  assert.match(b.err.join('\n'), /path/);
  assert.match(b.err.join('\n'), /acme\/widgets/);

  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'do not delete me', 'victim intact');
  assert.ok(existsSync(victim), 'victim dir still present');
  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'nothing installed');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged');
  assert.ok(!existsSync(join(cwd, 'workflows', STAGING_DIRNAME)), 'no staging debris');
});

test('add: a lockfile entry whose path is absolute is refused on read; victim untouched', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const victim = join(cwd, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep.txt'), 'do not delete me');

  const seedLf: Lockfile = {
    version: 1,
    installed: {
      [`${owner}/${repo}`]: {
        source: `${owner}/${repo}`,
        ref: 'HEAD',
        sha: SHA_A,
        installedAt: 1,
        path: victim, // absolute path to the out-of-tree dir
        files: ['foo.yaml'],
      },
    },
  };
  mkdirSync(join(cwd, '.owenloop'), { recursive: true });
  writeFileSync(lockfilePath(cwd), `${JSON.stringify(seedLf, null, 2)}\n`);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  const b = await addInto(cwd, owner, repo, SHA_B, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /invalid lockfile/);
  assert.match(b.err.join('\n'), /path/);

  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'do not delete me', 'victim intact');
  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'nothing installed');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged');
});

test('add: a lockfile entry with a NESTED path is refused on read; nested dir untouched', async () => {
  // The direct successor of the old chmod-based park-failure fixture: a nested
  // `legacy/olddir` path was that test's injection vehicle (`existing.path` read
  // verbatim). Nested paths are now refused before ANY mutation, so the hole is
  // closed at read time.
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const oldRel = 'legacy/olddir';
  const oldDir = join(cwd, 'workflows', oldRel);
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'foo.yaml'), validDefYaml('foo'));

  const seedLf: Lockfile = {
    version: 1,
    installed: {
      [`${owner}/${repo}`]: {
        source: `${owner}/${repo}`,
        ref: 'HEAD',
        sha: SHA_A,
        installedAt: 1,
        path: oldRel,
        files: ['foo.yaml'],
      },
    },
  };
  mkdirSync(join(cwd, '.owenloop'), { recursive: true });
  writeFileSync(lockfilePath(cwd), `${JSON.stringify(seedLf, null, 2)}\n`);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  const b = await addInto(cwd, owner, repo, SHA_B, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /invalid lockfile/);
  assert.match(b.err.join('\n'), /separator/);

  assert.equal(readFileSync(join(oldDir, 'foo.yaml'), 'utf8'), validDefYaml('foo'), 'nested dir untouched');
  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'nothing installed');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged');
  assert.ok(!existsSync(join(cwd, 'workflows', STAGING_DIRNAME)), 'no staging debris');
});

test('add: a lockfile entry with a safe-but-mismatched path segment is refused at the use-site; no mutation', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  // 'not-the-right-folder' passes structural validation (single safe segment)
  // but is neither the computed folder nor the legacy `<owner>-<repo>` name, so
  // the use-site exact-match refuses it before any staging/commit.
  const seedLf: Lockfile = {
    version: 1,
    installed: {
      [`${owner}/${repo}`]: {
        source: `${owner}/${repo}`,
        ref: 'HEAD',
        sha: SHA_A,
        installedAt: 1,
        path: 'not-the-right-folder',
        files: ['foo.yaml'],
      },
    },
  };
  writeLockfile(lockfilePath(cwd), seedLf);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  const b = await addInto(cwd, owner, repo, SHA_B, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /neither the expected/);

  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'nothing installed');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged');
  assert.ok(!existsSync(join(cwd, 'workflows', STAGING_DIRNAME)), 'no staging debris');
});

test('add: a symlinked legacy dir is refused at the rename site, rolling the committed swap back', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  // A real victim dir outside `workflows`, and a legacy-named SYMLINK pointing at
  // it. `path: 'acme-widgets'` passes structural validation AND the use-site
  // exact-match (it equals the legacy `<owner>-<repo>` name), so the refusal
  // happens at Layer 3 inside parkOldNameDir — AFTER commitInstall — exercising
  // the post-commit rollback the old chmod fixture covered.
  const victim = join(cwd, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep.txt'), 'do not delete me');
  mkdirSync(join(cwd, 'workflows'), { recursive: true });
  const legacyLink = join(cwd, 'workflows', `${owner}-${repo}`);
  symlinkSync(victim, legacyLink);

  const seedLf: Lockfile = {
    version: 1,
    installed: {
      [`${owner}/${repo}`]: {
        source: `${owner}/${repo}`,
        ref: 'HEAD',
        sha: SHA_A,
        installedAt: 1,
        path: `${owner}-${repo}`,
        files: ['foo.yaml'],
      },
    },
  };
  writeLockfile(lockfilePath(cwd), seedLf);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');

  const b = await addInto(cwd, owner, repo, SHA_B, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(b.code, 1);
  assert.match(b.err.join('\n'), /could not migrate/);
  assert.match(b.err.join('\n'), /rolled back, previous state restored/);
  assert.match(b.err.join('\n'), /symlink/);

  assert.ok(
    !existsSync(join(cwd, 'workflows', installFolder(owner, repo))),
    'hashed dir absent — the committed swap was rolled back',
  );
  assert.ok(existsSync(legacyLink), 'the symlink is left untouched');
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'do not delete me', 'victim intact');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'lockfile unchanged');
  assert.ok(!existsSync(join(cwd, 'workflows', STAGING_DIRNAME)), 'no staging debris');
});

test('add: an old-name migration success path installs the hashed dir, removes the old one, updates the lockfile', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const oldRel = `${owner}-${repo}`;
  const oldDir = join(cwd, 'workflows', oldRel);
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'foo.yaml'), validDefYaml('foo'));
  writeLockfile(lockfilePath(cwd), {
    version: 1,
    installed: {
      [`${owner}/${repo}`]: {
        source: `${owner}/${repo}`,
        ref: 'HEAD',
        sha: SHA_A,
        installedAt: 1,
        path: oldRel,
        files: ['foo.yaml'],
      },
    },
  });

  const b = await addInto(cwd, owner, repo, SHA_B, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(b.code, 0, b.out.join('\n'));

  assert.ok(
    existsSync(join(cwd, 'workflows', installFolder(owner, repo), 'foo.yaml')),
    'migrated to the hashed folder',
  );
  assert.ok(!existsSync(oldDir), 'old-name dir removed on success');
  const lf = readLockfile(lockfilePath(cwd));
  assert.equal(lf.installed[`${owner}/${repo}`]!.path, installFolder(owner, repo), 'lockfile now records the hashed path');
  assert.equal(lf.installed[`${owner}/${repo}`]!.sha, SHA_B);
  assert.ok(
    !existsSync(join(cwd, 'workflows', STAGING_DIRNAME)),
    'no staging debris — the parked old-name dir was finalized away',
  );
});

// ---- two-phase commit helpers (unit) -----------------------------------------

test('commitInstall/rollback: round-trips a prior install and a parked old-name dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-commit-'));
  const defsDir = join(dir, 'defs');
  const folder = 'pkg-hashed';
  const dest = join(defsDir, folder);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'x.yaml'), 'PREV');
  const oldRel = 'pkg-old';
  const oldDir = join(defsDir, oldRel);
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'y.yaml'), 'OLD');
  const stagingDir = join(defsDir, STAGING_DIRNAME, 'stg1');
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'x.yaml'), 'NEW');

  const handle = commitInstall(defsDir, folder, stagingDir);
  assert.equal(readFileSync(join(dest, 'x.yaml'), 'utf8'), 'NEW', 'new content swapped in');
  parkOldNameDir(handle, defsDir, oldRel);
  assert.ok(!existsSync(oldDir), 'old-name dir parked away');

  rollbackInstallCommit(handle);
  assert.equal(readFileSync(join(dest, 'x.yaml'), 'utf8'), 'PREV', 'prior content restored byte-identical');
  assert.equal(readFileSync(join(oldDir, 'y.yaml'), 'utf8'), 'OLD', 'old-name dir re-placed');
});

test('commitInstall/rollback: a fresh commit rolls back to no destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-commit-'));
  const defsDir = join(dir, 'defs');
  const folder = 'pkg-hashed';
  const dest = join(defsDir, folder);
  const stagingDir = join(defsDir, STAGING_DIRNAME, 'stg1');
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'x.yaml'), 'NEW');

  const handle = commitInstall(defsDir, folder, stagingDir);
  assert.ok(existsSync(dest), 'fresh commit lands');
  rollbackInstallCommit(handle);
  assert.ok(!existsSync(dest), 'fresh install rolled back to nothing');
});

test('finalizeInstallCommit: discards the retained backup and parked old-name dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-commit-'));
  const defsDir = join(dir, 'defs');
  const folder = 'pkg-hashed';
  const dest = join(defsDir, folder);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'x.yaml'), 'PREV');
  const oldRel = 'pkg-old';
  const oldDir = join(defsDir, oldRel);
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, 'y.yaml'), 'OLD');
  const stagingDir = join(defsDir, STAGING_DIRNAME, 'stg1');
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'x.yaml'), 'NEW');

  const handle = commitInstall(defsDir, folder, stagingDir);
  parkOldNameDir(handle, defsDir, oldRel);
  finalizeInstallCommit(handle);

  assert.equal(readFileSync(join(dest, 'x.yaml'), 'utf8'), 'NEW', 'new content stays in place');
  assert.ok(!existsSync(handle.backupDir!), 'retained backup discarded');
  assert.ok(handle.oldName && !existsSync(handle.oldName.parkedAt), 'parked old-name dir discarded');
});

test('writeLockfile: a rename failure removes the temp sibling and rethrows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lf-'));
  const p = join(dir, 'installed.json');
  // A directory at the destination makes `renameSync(tmpFile, p)` throw.
  mkdirSync(p);
  assert.throws(() => writeLockfile(p, { version: 1, installed: {} }));
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith('installed.json.tmp')),
    [],
    'temp sibling cleaned up on rename failure',
  );
});

test('writeLockfile: a failing cleanup never masks the original rename error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lf-'));
  const p = join(dir, 'installed.json');
  // A directory at the destination makes `renameSync(tmpFile, p)` throw.
  mkdirSync(p);
  // Inject a cleanup op that itself throws — the double fault the fix guards.
  assert.throws(
    () => writeLockfile(p, { version: 1, installed: {} }, { rm: () => { throw new Error('cleanup-boom'); } }),
    // The ORIGINAL rename error must surface, not the cleanup error. Don't pin a
    // single errno — macOS/Linux differ on renaming a file onto a directory
    // (EISDIR vs ENOTDIR/EPERM variants); just assert it is NOT the cleanup one.
    (e: unknown) => e instanceof Error && !/cleanup-boom/.test(e.message),
  );
  // The injected cleanup was forced to fail, so the tmp sibling remains here —
  // remove it manually rather than asserting on its absence.
  for (const f of readdirSync(dir).filter((f) => f.startsWith('installed.json.tmp'))) {
    rmSync(join(dir, f), { force: true });
  }
});

// ---- REL-2: full cross-definition validation before commit -------------------

test('add: a package whose def include:s a non-existent workflow is refused before anything is committed', async () => {
  // `loadDefsRaw` expands includes best-effort — it SILENTLY keeps the
  // un-expanded def when an include target is missing, so the aggregate pass
  // (lint/validate/modelCheck) only ever sees the explicit `kickoff` step and
  // finds nothing wrong. Only the strict `loadDefs` backstop — which runs the
  // cross-def `finalizeDefs`/`expandIncludes` pass — rejects the dangling
  // include. This is precisely the loadDefsRaw-vs-loadDefs gap made visible;
  // nothing may be committed.
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const danglingInclude = [
    'name: parent',
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: kickoff',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '  - include: ghostworkflow',
    '    as: ghost',
    '',
  ].join('\n');

  const { code, err } = await addInto(cwd, owner, repo, SHA_C, { 'workflows/parent.yaml': danglingInclude });
  assert.equal(code, 1);
  assert.match(err.join('\n'), /refusing to install/);
  assert.match(err.join('\n'), /ghostworkflow/);
  assert.match(err.join('\n'), /does not exist/);

  assert.ok(!existsSync(join(cwd, 'workflows', installFolder(owner, repo))), 'nothing installed');
  assert.ok(!existsSync(lockfilePath(cwd)), 'no lockfile entry written');
});

// ---- REL-2: atomic lockfile write --------------------------------------------

test('add: a successful add leaves no installed.json.tmp sibling', async () => {
  const owner = 'acme';
  const repo = 'widgets';
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));

  const { code, out } = await addInto(cwd, owner, repo, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(code, 0, out.join('\n'));

  const siblings = readdirSync(join(cwd, '.owenloop')).filter((f) => f.startsWith('installed.json.tmp'));
  assert.deepEqual(siblings, [], 'temp lockfile renamed away, none left behind');
});

test('writeLockfile: writes atomically (round-trips, leaves no temp sibling)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lf-'));
  const p = join(dir, 'installed.json');
  const lf: Lockfile = {
    // `sha` must be a real 40-hex sha: readLockfile now validates it on the read
    // side of this round-trip (the old placeholder 'x' would be refused). The
    // test's intent — atomic write, no temp sibling, round-trip equality — is
    // unchanged.
    version: 1,
    installed: {
      'a/b': { source: 'a/b', ref: 'HEAD', sha: SHA_A, installedAt: 1, path: 'a-b-deadbeef', files: ['foo.yaml'] },
    },
  };
  writeLockfile(p, lf);
  assert.deepEqual(readLockfile(p), lf);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith('installed.json.tmp')),
    [],
    'no temp file remains',
  );
});

test('readLockfile: a corrupt lockfile is a hard error, never a silent reset to empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lf-'));
  const p = join(dir, 'installed.json');
  writeFileSync(p, '{ this is not valid json');
  assert.throws(() => readLockfile(p), /corrupt lockfile/);
});

// ---- SEC-3: structural lockfile validation (unit) ----------------------------

test('lockfilePathViolation: accepts a single safe segment, rejects separators and traversal', () => {
  // safe single segment (both current and legacy schemes)
  assert.equal(lockfilePathViolation('acme-widgets'), undefined);
  assert.equal(lockfilePathViolation('acme-widgets-deadbeef'), undefined);
  // stricter than archivePathViolation: ANY separator is refused
  assert.match(lockfilePathViolation('legacy/olddir')!, /separator/);
  assert.match(lockfilePathViolation('a\\b')!, /separator/);
  // and everything archivePathViolation already rejects
  assert.ok(lockfilePathViolation(''), 'empty');
  assert.ok(lockfilePathViolation('/etc/passwd'), 'absolute posix');
  assert.ok(lockfilePathViolation('../victim'), 'leading dotdot');
  assert.ok(lockfilePathViolation('..'), 'dotdot');
  assert.ok(lockfilePathViolation('.'), 'dot');
  assert.ok(lockfilePathViolation('a\0b'), 'NUL byte');
});

test('validateLockfile: a well-formed lockfile passes through unchanged', () => {
  const lf: Lockfile = {
    version: 1,
    installed: {
      'a/b': { source: 'a/b', ref: 'HEAD', sha: SHA_A, installedAt: 1, path: 'a-b-deadbeef', files: ['foo.yaml'] },
    },
  };
  assert.deepEqual(validateLockfile(structuredClone(lf), 'installed.json'), lf);
  // Unknown extra keys are tolerated (forward compatibility).
  const withExtra = structuredClone(lf) as unknown as Record<string, unknown>;
  withExtra.futureField = true;
  (withExtra.installed as Record<string, Record<string, unknown>>)['a/b']!.futureEntryField = 42;
  assert.doesNotThrow(() => validateLockfile(withExtra, 'installed.json'));
});

test('validateLockfile: every malformed shape is a hard error naming the entry/field', () => {
  const base = (): Record<string, unknown> => ({
    version: 1,
    installed: {
      'a/b': { source: 'a/b', ref: 'HEAD', sha: SHA_A, installedAt: 1, path: 'a-b-deadbeef', files: ['foo.yaml'] },
    },
  });
  const mutate = (fn: (lf: Record<string, unknown>) => void): Record<string, unknown> => {
    const lf = base();
    fn(lf);
    return lf;
  };
  const entry = (lf: Record<string, unknown>): Record<string, unknown> =>
    (lf.installed as Record<string, Record<string, unknown>>)['a/b']!;

  const cases: Array<[Record<string, unknown> | unknown, RegExp]> = [
    ['not an object', /invalid lockfile/],
    [[], /invalid lockfile/],
    [mutate((lf) => { lf.version = 2; }), /unsupported lockfile version/],
    [mutate((lf) => { lf.version = '1'; }), /unsupported lockfile version/],
    [mutate((lf) => { delete lf.version; }), /unsupported lockfile version/],
    [mutate((lf) => { lf.installed = []; }), /'installed' is not an object/],
    [mutate((lf) => { (lf.installed as Record<string, unknown>)['a/b'] = 'x'; }), /is not an object/],
    [mutate((lf) => { delete entry(lf).source; }), /\.source/],
    [mutate((lf) => { entry(lf).source = 'other/repo'; }), /does not match its key/],
    [mutate((lf) => { delete entry(lf).ref; }), /\.ref/],
    [mutate((lf) => { entry(lf).sha = 'x'; }), /\.sha/],
    [mutate((lf) => { entry(lf).sha = SHA_A.slice(0, 39); }), /\.sha/],
    [mutate((lf) => { entry(lf).installedAt = 'soon'; }), /\.installedAt/],
    [mutate((lf) => { entry(lf).path = 'legacy/olddir'; }), /\.path contains a path separator/],
    [mutate((lf) => { entry(lf).path = '../victim'; }), /\.path/],
    [mutate((lf) => { entry(lf).files = 'foo.yaml'; }), /\.files is not an array/],
    [mutate((lf) => { entry(lf).files = [1]; }), /\.files\[0\] is not a string/],
    [mutate((lf) => { entry(lf).files = ['../x']; }), /\.files\[0\]/],
  ];
  for (const [input, re] of cases) {
    assert.throws(() => validateLockfile(input, 'installed.json'), re, JSON.stringify(input));
  }
});

test('parkOldNameDir: a traversing oldRelPath throws and never touches the out-of-tree target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-park-'));
  const defsDir = join(dir, 'defs');
  mkdirSync(defsDir, { recursive: true });
  const victim = join(dir, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep.txt'), 'do not delete me');

  const handle = { dest: join(defsDir, 'pkg-hashed'), undoDir: join(defsDir, STAGING_DIRNAME, 'stg1-undo') };
  assert.throws(() => parkOldNameDir(handle, defsDir, '../victim'), /refusing old-name migration/);

  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'do not delete me', 'victim untouched');
  assert.ok(existsSync(victim), 'victim dir still present');
});

// ---- SEC-3: add refuses symlinked default state dirs -------------------------

/**
 * Canned fetch + spec for an otherwise-valid single-def install. The hostile
 * layout is applied by the caller on the returned cwd BEFORE running the add;
 * the guard fires after the fetch, so the tarball responses are still needed.
 */
function validAddFetch(owner: string, repo: string): typeof globalThis.fetch {
  const tarball = makeGithubTarball(`${owner}-${repo}-${SHA_A}`, {
    'workflows/foo.yaml': validDefYaml('foo'),
  });
  return fakeFetch({
    [shaUrl(owner, repo, 'HEAD')]: { status: 200, body: SHA_A },
    [tarballUrl(owner, repo, SHA_A)]: { status: 200, body: tarball },
  }).fetch;
}

test('SEC-3: add refuses a symlinked `.owenloop`; the link target gains no lock/ledger and nothing is committed', async () => {
  const { io, cwd, err } = makeIo(validAddFetch('acme', 'widgets'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-add-elsewhere-'));
  symlinkSync(elsewhere, join(cwd, '.owenloop'));

  const code = await mainAsync(['add', 'acme/widgets'], io);
  assert.equal(code, 1, err.join('\n'));
  assert.match(err.join('\n'), /refusing to write under/);
  assert.match(err.join('\n'), /symbolic link/);
  assert.deepEqual(readdirSync(elsewhere), [], 'no add.lock or installed.json written through the link');
  assert.equal(
    existsSync(join(cwd, 'workflows', installFolder('acme', 'widgets'))),
    false,
    'no install dir was committed',
  );
});

test('SEC-3: add refuses a symlinked default `workflows`; the link target is untouched and no ledger is written', async () => {
  const { io, cwd, err } = makeIo(validAddFetch('acme', 'widgets'));
  // A REAL (absent) `.owenloop` — the parent guard passes — but the default
  // defs dir is a symlink out of tree.
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-add-defs-'));
  symlinkSync(elsewhere, join(cwd, 'workflows'));

  const code = await mainAsync(['add', 'acme/widgets'], io);
  assert.equal(code, 1, err.join('\n'));
  assert.match(err.join('\n'), /refusing to write under/);
  assert.match(err.join('\n'), /symbolic link/);
  assert.deepEqual(readdirSync(elsewhere), [], 'no staging or install dir written through the link');
  assert.equal(existsSync(lockfilePath(cwd)), false, 'guard fired before the lockfile write; no ledger');
});

test('SEC-3: add refuses a DANGLING symlinked default `workflows` and does not create the link target', async () => {
  const { io, cwd, err } = makeIo(validAddFetch('acme', 'widgets'));
  const target = join(cwd, 'nonexistent');
  symlinkSync(target, join(cwd, 'workflows'));

  const code = await mainAsync(['add', 'acme/widgets'], io);
  assert.equal(code, 1, err.join('\n'));
  assert.match(err.join('\n'), /symbolic link/);
  assert.equal(existsSync(target), false, 'the dangling link target was not created');
});

test('SEC-3: an explicit --defs through a symlink still installs (operator intent preserved)', async () => {
  const { io, cwd, out } = makeIo(validAddFetch('acme', 'widgets'));
  // `.owenloop` is NOT a symlink here (its guard is unconditional and would
  // refuse first); only the explicit defs target is a symlink.
  const real = mkdtempSync(join(tmpdir(), 'owenloop-add-realdefs-'));
  const link = join(cwd, 'defs-link');
  symlinkSync(real, link);

  const code = await mainAsync(['add', 'acme/widgets', '--defs', link], io);
  assert.equal(code, 0, out.join('\n'));
  assert.ok(
    existsSync(join(real, installFolder('acme', 'widgets'), 'foo.yaml')),
    'def installed through the explicit defs symlink',
  );
  const lf = JSON.parse(readFileSync(lockfilePath(cwd), 'utf8'));
  assert.equal(lf.installed['acme/widgets'].sha, SHA_A, 'ledger entry written');
});

test('SEC-3: an explicit OWENLOOP_DEFS through a symlink still installs (env-form operator intent)', async () => {
  const real = mkdtempSync(join(tmpdir(), 'owenloop-add-realdefsenv-'));
  // Build cwd first so the link can live inside it, then point the env at it.
  const { io, cwd, out } = makeIo(validAddFetch('acme', 'widgets'));
  const link = join(cwd, 'defs-env-link');
  symlinkSync(real, link);
  io.env = { OWENLOOP_DEFS: link };

  const code = await mainAsync(['add', 'acme/widgets'], io);
  assert.equal(code, 0, out.join('\n'));
  assert.ok(
    existsSync(join(real, installFolder('acme', 'widgets'), 'foo.yaml')),
    'def installed through the explicit OWENLOOP_DEFS symlink',
  );
});

// ---- parseRepoSpec: charset tightening ---------------------------------------

test('add: a repo spec with illegal characters in owner/repo is refused before any fetch', async () => {
  const { fetch, calls } = fakeFetch({});
  for (const bad of ['ow ner/repo', 'owner/re:po', 'owner/re/po', 'owner/re*po']) {
    const { io, err } = makeIo(fetch);
    const code = await mainAsync(['add', bad], io);
    assert.equal(code, 1, bad);
    assert.match(err.join('\n'), /malformed repo spec/, bad);
  }
  assert.equal(calls.length, 0, 'no network call for any illegal spec');
});

// ---- everything else still routes through the sync main() --------------------

test('mainAsync delegates every non-add command to the sync main() unchanged', async () => {
  const { io, out } = makeIo((async () => {
    throw new Error('fetch must not be called for non-add commands');
  }) as unknown as typeof globalThis.fetch);
  const code = await mainAsync(['defs'], io);
  assert.equal(code, 0, out.join('\n'));
  assert.ok(Array.isArray(JSON.parse(out.join('\n'))));
});

// ---- crash-recovery journal --------------------------------------------------
//
// A hard kill (a process crash / SIGKILL / termination) partway through the
// destructive part of an install skips every in-process rollback arm. The journal + the next add's
// `recoverInterruptedInstall` close that gap: it rolls a leftover install
// FORWARD (at/past the ledger commit point) or BACK (before it) to a consistent
// (defs ⇔ ledger) state. These tests build the crash-time on-disk state by hand
// — exactly what a killed process would leave — and drive recovery directly, plus
// one end-to-end path proving `add` runs recovery first.

const OWNER = 'acme';
const REPO = 'widgets';

function journalPathOf(cwd: string): string {
  return join(cwd, '.owenloop', ADD_JOURNAL_FILENAME);
}
function defsDirOf(cwd: string): string {
  return join(cwd, 'workflows');
}
/** Write a full, valid journal, overriding any fields the test cares about. */
function seedJournal(cwd: string, over: Partial<AddJournal> = {}): AddJournal {
  const journal: AddJournal = {
    version: 1,
    phase: 'applying',
    source: `${OWNER}/${REPO}`,
    sha: SHA_B,
    folder: installFolder(OWNER, REPO),
    stagingId: 'stg_test',
    hadDest: false,
    defsDir: defsDirOf(cwd),
    ref: 'HEAD',
    startedAt: 1,
    ...over,
  };
  writeAddJournal(journalPathOf(cwd), journal);
  return journal;
}
/** Run recovery against the standard cwd layout. */
function recoverIn(cwd: string): void {
  recoverInterruptedInstall({
    defsDir: defsDirOf(cwd),
    journalPath: journalPathOf(cwd),
    lockfilePath: lockfilePath(cwd),
  });
}
/** Create `dir` and drop a file in it — a stand-in for an install/backup dir. */
function seedDir(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}
/** The crash-time paths recovery derives, for a given cwd + stagingId. */
function crashPaths(cwd: string, stagingId = 'stg_test'): {
  defsDir: string;
  dest: string;
  stagingRoot: string;
  stagingDir: string;
  backupDir: string;
  undoDir: string;
  parkedOldName: string;
} {
  const defsDir = defsDirOf(cwd);
  const stagingRoot = join(defsDir, STAGING_DIRNAME);
  const stagingDir = join(stagingRoot, stagingId);
  return {
    defsDir,
    dest: join(defsDir, installFolder(OWNER, REPO)),
    stagingRoot,
    stagingDir,
    backupDir: `${stagingDir}-old`,
    undoDir: `${stagingDir}-undo`,
    parkedOldName: `${stagingDir}-undo-oldname`,
  };
}
function seedLockfileEntry(cwd: string, sha: string, path: string): void {
  writeLockfile(lockfilePath(cwd), {
    version: 1,
    installed: {
      [`${OWNER}/${REPO}`]: {
        source: `${OWNER}/${REPO}`,
        ref: 'HEAD',
        sha,
        installedAt: 1,
        path,
        files: ['foo.yaml'],
      },
    },
  });
}

test('recovery: a successful add leaves no crash-recovery journal behind', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const r = await addInto(cwd, OWNER, REPO, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed on the happy path');
});

test('recovery: phase `finalizing` rolls forward — discards the retained backup and clears staging', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  // Committed state: new content at dest, previous version retained as a backup,
  // plus leftover staging debris — the ledger already durably records the new
  // install, so only finalize's discards are missing.
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedDir(p.backupDir, 'foo.yaml', 'PREV');
  seedDir(p.stagingDir, 'foo.yaml', 'NEW');
  seedJournal(cwd, { phase: 'finalizing', hadDest: true });

  recoverIn(cwd);

  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'NEW', 'installed content kept');
  assert.ok(!existsSync(p.backupDir), 'retained backup discarded');
  assert.ok(!existsSync(p.stagingRoot), 'staging root cleared');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');
});

test('recovery: phase `applying` with a matching ledger rolls forward (commit point already passed)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  // The ledger write landed but the journal was never advanced to `finalizing`
  // (a crash in that tiny window): dest holds the new sha, the ledger records it.
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedDir(p.backupDir, 'foo.yaml', 'PREV');
  seedLockfileEntry(cwd, SHA_B, folder);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');
  seedJournal(cwd, { phase: 'applying', hadDest: true, sha: SHA_B, folder });

  recoverIn(cwd);

  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'NEW', 'install kept — ledger already agrees');
  assert.ok(!existsSync(p.backupDir), 'retained backup discarded');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'ledger untouched');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');
});

test('recovery: an upgrade killed after the swap rolls back to the previous install, idempotently', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  // Swap done (dest = NEW), backup retained (= PREV), ledger NOT yet updated
  // (still records the old sha at the same folder) — before the commit point.
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedDir(p.backupDir, 'foo.yaml', 'PREV');
  seedLockfileEntry(cwd, SHA_A, folder);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');
  seedJournal(cwd, { phase: 'applying', hadDest: true, sha: SHA_B, folder });

  recoverIn(cwd);

  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'PREV', 'previous install restored');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'ledger unchanged (still the old sha)');
  assert.ok(!existsSync(p.stagingRoot), 'staging root cleared');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');

  // Idempotent: a second recovery pass (journal now gone) is a clean no-op.
  recoverIn(cwd);
  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'PREV', 'still the previous install');
});

test('recovery: a fresh install killed after the swap now REFUSES fail-closed (dest present, uncorroborated)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  // Fresh install: no prior dest (hadDest=false), so no backup, no staging, no
  // ledger entry. The swap put NEW at dest but the ledger write never happened.
  // On disk this is INDISTINGUISHABLE from a forged journal naming an existing
  // dir (every distinguishing artifact is repo-committable, hence forgeable), so
  // the case-(c) discard now fails closed rather than deleting on the journal's
  // word alone. Deliberate tradeoff: this narrow swap→ledger window regresses to
  // a refusal that names the manual remedy, in exchange for never letting a
  // forged journal delete an existing workflow dir.
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedJournal(cwd, { phase: 'applying', hadDest: false, sha: SHA_B, folder: installFolder(OWNER, REPO) });

  assert.throws(() => recoverIn(cwd), /nothing corroborates/);
  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'NEW', 'dest survives untouched on refusal');
  assert.ok(existsSync(journalPathOf(cwd)), 'journal left in place as evidence');

  // The operator applies the remedy the error names: remove the journal and the
  // stranded dest. Afterwards the source installs cleanly — no lingering refusal.
  rmSync(journalPathOf(cwd));
  rmSync(p.dest, { recursive: true, force: true });
  const r = await addInto(cwd, OWNER, REPO, SHA_A, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.ok(existsSync(join(p.dest, 'foo.yaml')), 'clean install lands after the manual remedy');
});

test('recovery: a forged journal naming an existing UNRELATED dir is refused — the victim survives (the re-audit repro)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const defsDir = defsDirOf(cwd);
  const victim = join(defsDir, 'victim');
  // The exact confirmed reproduction: a schema-VALID `applying` journal with
  // `hadDest:false` naming an existing installed workflow dir (`victim`), with NO
  // matching ledger entry, NO staging dir, and NO backup. `folder` is a plain
  // safe single segment (`'victim'`, not the hashed installFolder). Case (c)
  // must fail closed — deleting on the journal's word alone is the data-integrity
  // hole, since `.owenloop/add.journal` is repository-committable content.
  seedDir(victim, 'keep.yaml', 'do not touch');
  seedJournal(cwd, { phase: 'applying', hadDest: false, sha: SHA_B, folder: 'victim' });

  assert.throws(() => recoverIn(cwd), /nothing corroborates/);
  assert.ok(existsSync(victim), 'victim dir survives');
  assert.equal(readFileSync(join(victim, 'keep.yaml'), 'utf8'), 'do not touch', 'victim content byte-identical');
  assert.ok(existsSync(journalPathOf(cwd)), 'journal left in place as evidence');
});

test('recovery: a forged journal + a contradictory ledger entry at `folder` is still refused', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const defsDir = defsDirOf(cwd);
  const victim = join(defsDir, 'victim');
  // Adjacent forgery: same hostile state, but with a ledger entry for the source
  // recorded at `path === journal.folder` ('victim') with a DIFFERENT sha. This
  // is contradictory — if the ledger recorded the source installed at `folder`,
  // `hadDest` could not have been false — and the sha mismatch keeps it out of
  // the roll-forward ledger-match branch. The corroboration predicate requires
  // `installed.path === journal.oldNamePath` (undefined here), so it still
  // refuses; a forged ledger at `folder` must NOT re-open the delete.
  seedDir(victim, 'keep.yaml', 'do not touch');
  seedLockfileEntry(cwd, SHA_A, 'victim');
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');
  seedJournal(cwd, { phase: 'applying', hadDest: false, sha: SHA_B, folder: 'victim' });

  assert.throws(() => recoverIn(cwd), /nothing corroborates/);
  assert.equal(readFileSync(join(victim, 'keep.yaml'), 'utf8'), 'do not touch', 'victim untouched');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'ledger untouched');
  assert.ok(existsSync(journalPathOf(cwd)), 'journal left as evidence');
});

test('recovery: a corroborated old-name migration crashed BEFORE the park still discards the hashed dir (no parked dir required)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  const oldRel = `${OWNER}-${REPO}`;
  const oldOriginal = join(p.defsDir, oldRel);
  // Migration crash in the swap→park window: fresh hashed dir swapped in (NEW,
  // hadDest=false), the ledger still records the source at the OLD-name path, the
  // journal carries `oldNamePath` — but the old-name dir was NEVER parked yet
  // (it's still at its original location). The ledger corroborates the migration
  // (`installed.path === journal.oldNamePath`), so the destructive discard must
  // still proceed even though there is no parked dir to use as evidence. This
  // guards the corroboration predicate against over-tightening to require a park.
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedDir(oldOriginal, 'foo.yaml', 'OLD'); // old-name dir still in place — never parked
  seedLockfileEntry(cwd, SHA_A, oldRel);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');
  seedJournal(cwd, { phase: 'applying', hadDest: false, sha: SHA_B, folder, oldNamePath: oldRel });

  recoverIn(cwd);

  assert.ok(!existsSync(p.dest), 'hashed dir discarded (corroborated migration)');
  assert.equal(readFileSync(join(oldOriginal, 'foo.yaml'), 'utf8'), 'OLD', 'old-name dir left in place');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'ledger unchanged (still the old path)');
  assert.ok(!existsSync(p.stagingRoot), 'staging root cleared');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');
});

test('recovery: an old-name migration killed before the ledger restores the old dir and drops the hashed one', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  const oldRel = `${OWNER}-${REPO}`;
  const oldOriginal = join(p.defsDir, oldRel);
  // Migration crash: fresh hashed dir swapped in (NEW, hadDest=false), old-name
  // dir parked aside, ledger still records the OLD path/sha. Roll back: discard
  // the hashed dir, restore the parked old-name dir where the ledger expects it.
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedDir(p.parkedOldName, 'foo.yaml', 'OLD');
  seedLockfileEntry(cwd, SHA_A, oldRel);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');
  seedJournal(cwd, { phase: 'applying', hadDest: false, sha: SHA_B, folder, oldNamePath: oldRel });

  recoverIn(cwd);

  assert.ok(!existsSync(p.dest), 'hashed dir discarded');
  assert.equal(readFileSync(join(oldOriginal, 'foo.yaml'), 'utf8'), 'OLD', 'old-name dir restored in place');
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'ledger unchanged (still the old path)');
  assert.ok(!existsSync(p.stagingRoot), 'staging root cleared');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');
});

test('recovery: resumes a rollback that itself died between its two renames', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  // A prior rollback parked the new content under undoDir, then died BEFORE
  // restoring the backup: dest is absent, backup still present. Recovery just
  // finishes the restore.
  seedDir(p.undoDir, 'foo.yaml', 'NEW');
  seedDir(p.backupDir, 'foo.yaml', 'PREV');
  seedLockfileEntry(cwd, SHA_A, folder);
  seedJournal(cwd, { phase: 'applying', hadDest: true, sha: SHA_B, folder });

  recoverIn(cwd);

  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'PREV', 'backup restored over the absent dest');
  assert.ok(!existsSync(p.stagingRoot), 'staging root cleared');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');
});

test('recovery: an already-restored rollback just clears the leftover journal (touches nothing)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  // In-process rollback finished (dest = PREV again, no backup/staging) but the
  // journal-remove never ran. No ledger match ⇒ roll-back path, which finds the
  // dirs already consistent and only needs to drop the journal.
  seedDir(p.dest, 'foo.yaml', 'PREV');
  seedLockfileEntry(cwd, SHA_A, folder);
  seedJournal(cwd, { phase: 'applying', hadDest: true, sha: SHA_B, folder });

  recoverIn(cwd);

  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'PREV', 'restored dest left as-is');
  assert.ok(!existsSync(journalPathOf(cwd)), 'leftover journal removed');
});

test('recovery: refuses a journal that resolved a DIFFERENT defs dir, mutating nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedJournal(cwd, { phase: 'finalizing', defsDir: join(cwd, 'some-other-defs') });

  assert.throws(() => recoverIn(cwd), /journal records defs dir/);
  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'NEW', 'no mutation on refusal');
  assert.ok(existsSync(journalPathOf(cwd)), 'journal left in place as evidence');
});

test('recovery: refuses a crafted journal whose folder tries to traverse out of the tree', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const victim = join(cwd, 'victim');
  seedDir(victim, 'keep.txt', 'do not touch');
  // Hand-write a poisoned journal (writeAddJournal would not accept the bad type).
  mkdirSync(join(cwd, '.owenloop'), { recursive: true });
  writeFileSync(
    journalPathOf(cwd),
    JSON.stringify({
      version: 1,
      phase: 'applying',
      source: `${OWNER}/${REPO}`,
      sha: SHA_B,
      folder: '../victim',
      stagingId: 'stg_test',
      hadDest: true,
      defsDir: defsDirOf(cwd),
      ref: 'HEAD',
      startedAt: 1,
    }),
  );

  assert.throws(() => recoverIn(cwd), /invalid crash-recovery journal/);
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'do not touch', 'out-of-tree victim untouched');
});

test('recovery: refuses when a directory it would rename is actually a symlink (A2)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const victim = join(cwd, 'victim');
  seedDir(victim, 'keep.txt', 'do not touch');
  // Roll-back path, case (a): staging + backup both present, but dest is a
  // symlink — recovery must refuse (never rename/rm through a link) before acting.
  seedDir(p.stagingDir, 'foo.yaml', 'NEW');
  seedDir(p.backupDir, 'foo.yaml', 'PREV');
  mkdirSync(p.defsDir, { recursive: true });
  symlinkSync(victim, p.dest);
  seedJournal(cwd, { phase: 'applying', hadDest: true, sha: SHA_B });

  assert.throws(() => recoverIn(cwd), /is a symlink/);
  assert.ok(existsSync(p.backupDir), 'backup untouched on refusal');
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'do not touch', 'symlink target untouched');
  assert.ok(existsSync(journalPathOf(cwd)), 'journal left as evidence');
});

test('recovery: a SAME-sha re-add killed between the dest→backup and staging→dest renames restores from backup (no silent data loss)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  // Re-adding an already-installed source at the SAME sha. commitInstall renamed
  // dest → backupDir (step 4a) and the process was killed BEFORE the staging →
  // dest swap (4b): dest is ABSENT, staging is still present, and backupDir holds
  // the ONLY surviving copy of the installed content. The ledger already records
  // this exact sha+folder from the prior successful install, so the `applying` +
  // ledger-match test passes — but rolling FORWARD here would rmSync backupDir and
  // leave the ledger claiming an install that is gone from disk (silent data
  // loss). Recovery must branch on disk state and restore backupDir → dest.
  seedDir(p.stagingDir, 'foo.yaml', 'NEW');
  seedDir(p.backupDir, 'foo.yaml', 'INSTALLED'); // the only surviving copy
  seedLockfileEntry(cwd, SHA_B, folder);
  const lockBefore = readFileSync(lockfilePath(cwd), 'utf8');
  seedJournal(cwd, { phase: 'applying', hadDest: true, sha: SHA_B, folder });

  recoverIn(cwd);

  assert.ok(existsSync(p.dest), 'dest restored — content not lost');
  assert.equal(
    readFileSync(join(p.dest, 'foo.yaml'), 'utf8'),
    'INSTALLED',
    'installed content restored from backup, not discarded',
  );
  assert.equal(readFileSync(lockfilePath(cwd), 'utf8'), lockBefore, 'ledger untouched (still records the install)');
  assert.ok(!existsSync(p.backupDir), 'backup consumed by the restore');
  assert.ok(!existsSync(p.stagingRoot), 'staging root cleared');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');
});

test('recovery: refuses a VALID journal when the staging root is a planted symlink — no mutation outside defsDir', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  // The attacker's out-of-tree directory the symlinked staging root points at.
  const outside = mkdtempSync(join(tmpdir(), 'owenloop-outside-'));
  const outsideBefore = readdirSync(outside);
  // Hostile checkout: `workflows/` and `.owenloop/` ship as REAL dirs (pass
  // SEC-3), the in-tree dest holds a real victim dir, and `.owenloop-staging` is
  // planted as a SYMLINK to the attacker's outside dir. The journal is fully VALID
  // (single-segment folder inside defsDir, matching defsDir, applying,
  // hadDest=false, empty ledger) so validateAddJournal accepts it. Recovery would
  // otherwise take roll-back case (c) `!hadDest` with dest present:
  // renameSync(dest, undoDir) where undoDir sits UNDER the symlinked staging root,
  // moving the victim OUTSIDE defsDir. Recovery must refuse before any fs mutation.
  mkdirSync(p.defsDir, { recursive: true });
  seedDir(p.dest, 'foo.yaml', 'VICTIM');
  symlinkSync(outside, p.stagingRoot);
  seedJournal(cwd, { phase: 'applying', hadDest: false, sha: SHA_B, folder });

  assert.throws(() => recoverIn(cwd), /staging root .* is a symlink/);

  // NO fs mutation anywhere: the victim dir is intact in place, nothing landed in
  // the attacker's outside dir, and the journal is left as evidence.
  assert.equal(readFileSync(join(p.dest, 'foo.yaml'), 'utf8'), 'VICTIM', 'in-tree victim dir untouched');
  assert.deepEqual(readdirSync(outside), outsideBefore, 'nothing moved into the attacker dir');
  assert.ok(existsSync(journalPathOf(cwd)), 'journal left in place as evidence');
});

test('validateAddJournal / readAddJournal: reject unknown phase, bad version, and corrupt JSON', () => {
  const base = {
    version: 1,
    phase: 'applying',
    source: `${OWNER}/${REPO}`,
    sha: SHA_B,
    folder: installFolder(OWNER, REPO),
    stagingId: 'stg_test',
    hadDest: true,
    defsDir: '/x',
    ref: 'HEAD',
    startedAt: 1,
  };
  assert.throws(() => validateAddJournal({ ...base, phase: 'bogus' }, '/j'), /unknown phase/);
  assert.throws(() => validateAddJournal({ ...base, version: 2 }, '/j'), /unsupported journal version/);
  assert.throws(() => validateAddJournal({ ...base, sha: 'nothex' }, '/j'), /40-char hex/);

  const dir = mkdtempSync(join(tmpdir(), 'owenloop-journal-'));
  const jp = join(dir, 'add.journal');
  writeFileSync(jp, '{ truncated');
  assert.throws(() => readAddJournal(jp), /corrupt crash-recovery journal/);
  // Absent ⇒ null (the happy path — nothing to recover).
  assert.equal(readAddJournal(join(dir, 'nope.journal')), null);
});

test('recovery: end-to-end — a real add rolls a leftover install forward before installing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const p = crashPaths(cwd);
  const folder = installFolder(OWNER, REPO);
  // Leftover from a crash past the commit point: dest committed, backup retained,
  // ledger recorded, journal stuck at `finalizing`. The very next `add` (same
  // source, new sha) must run recovery first, then upgrade cleanly.
  seedDir(p.dest, 'foo.yaml', 'NEW');
  seedDir(p.backupDir, 'foo.yaml', 'PREV');
  seedLockfileEntry(cwd, SHA_B, folder);
  seedJournal(cwd, { phase: 'finalizing', hadDest: true, sha: SHA_B, folder });

  const r = await addInto(cwd, OWNER, REPO, SHA_C, { 'workflows/foo.yaml': validDefYaml('foo') });
  assert.equal(r.code, 0, r.err.join('\n'));

  const lf = readLockfile(lockfilePath(cwd));
  assert.equal(lf.installed[`${OWNER}/${REPO}`]!.sha, SHA_C, 'upgraded to the new sha after recovery');
  assert.ok(!existsSync(journalPathOf(cwd)), 'journal removed');
  assert.ok(!existsSync(p.stagingRoot), 'no staging debris left behind');
});
