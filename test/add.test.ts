/**
 * `owenloop add <owner>/<repo>[@ref]` — driven in-process through `mainAsync`
 * with an injected `fetch` (see CliIO.fetch in src/cli.ts). No real network:
 * the fake fetch resolves the sha-lookup and tarball URLs from a canned map,
 * built with test/helpers.ts's independent tar-gz writer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
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
  assert.equal(result.path, `${owner}-${repo}`);
  assert.equal(result.installed, 1);
  assert.deepEqual(result.defs, ['foo']);

  const installedFile = join(cwd, 'workflows', `${owner}-${repo}`, 'foo.yaml');
  assert.ok(existsSync(installedFile), 'def file landed under <defsDir>/<owner>-<repo>/');
  assert.equal(readFileSync(installedFile, 'utf8'), validDefYaml('foo'));

  const lf = JSON.parse(readFileSync(lockfilePath(cwd), 'utf8'));
  const entry = lf.installed[`${owner}/${repo}`];
  assert.equal(entry.source, `${owner}/${repo}`);
  assert.equal(entry.ref, 'HEAD');
  assert.equal(entry.sha, SHA_A);
  assert.equal(entry.path, `${owner}-${repo}`);
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

  const folder = join(cwd, 'workflows', `${owner}-${repo}`);
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

  assert.ok(!existsSync(join(cwd, 'workflows', `${owner}-${repo}`)), 'defsDir untouched on refusal');
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

// ---- everything else still routes through the sync main() --------------------

test('mainAsync delegates every non-add command to the sync main() unchanged', async () => {
  const { io, out } = makeIo((async () => {
    throw new Error('fetch must not be called for non-add commands');
  }) as unknown as typeof globalThis.fetch);
  const code = await mainAsync(['defs'], io);
  assert.equal(code, 0, out.join('\n'));
  assert.ok(Array.isArray(JSON.parse(out.join('\n'))));
});
