/**
 * `owenloop add <owner>/<repo>[@ref]` — driven in-process through `mainAsync`
 * with an injected `fetch` (see CliIO.fetch in src/cli.ts). No real network:
 * the fake fetch resolves the sha-lookup and tarball URLs from a canned map,
 * built with test/helpers.ts's independent tar-gz writer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
import {
  acquireInstallLock,
  archivePathViolation,
  installFolder,
  readLockfile,
  releaseInstallLock,
  writeLockfile,
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
function makeIo(fetchFn: typeof globalThis.fetch): { io: CliIO; cwd: string; out: string[]; err: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-add-test-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    cwd,
    env: {},
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

test('acquireInstallLock: reclaims a lock whose mtime is past the stale window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lock-'));
  const lockPath = join(dir, 'add.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

  // Holder pid is alive (this process), but a clock jumped an hour ahead makes
  // the lock's mtime older than the 10-minute stale window → reclaimable.
  const future = Date.now() + 60 * 60_000;
  const handle = await acquireInstallLock(lockPath, { now: () => future, waitMs: 40, pollMs: 5 });
  assert.ok(handle.acquired, 'mtime-stale lock reclaimed');
  releaseInstallLock(handle);
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
    version: 1,
    installed: {
      'a/b': { source: 'a/b', ref: 'HEAD', sha: 'x', installedAt: 1, path: 'a-b-deadbeef', files: ['foo.yaml'] },
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
