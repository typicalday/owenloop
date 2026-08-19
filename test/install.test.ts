/**
 * `owenloop install <owner>/<repo>` driven in-process through `mainAsync`.
 *
 * Hermetic: the GitHub half is a canned sha + in-memory tarball (`makeGithubTarball`),
 * the hub half is `makeFakeHub` behind `routedFetch`, and the two are composed by
 * host so the RECORDED CALL LOG CONTAINS HUB REQUESTS ONLY — which is what lets the
 * fail-closed cases assert "not one hub request was made" rather than "no publish".
 *
 * The load-bearing property under test is ORDER: the capability mapping is recorded
 * BEFORE `create_workflow`, so an outside def never sits in the org's shared
 * vocabulary — not even for the window between two calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, makeFakeHub, makeIo, routedFetch } from './hubkit.ts';
import type { FakeHubOpts, HubIo, RecordedCall } from './hubkit.ts';
import { makeGithubTarball } from './helpers.ts';

const ORIGIN = 'http://127.0.0.1:9';
const OWNER = 'outside';
const REPO = 'defs';
const SHA = 'c'.repeat(40);
const SOURCE = `${OWNER}/${REPO}`;

const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_a',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'c',
};

/**
 * A minimal-but-valid def that authors `capabilities`. `maxSchemaFailures: 0`
 * disables the schema-stall path, which an exhaustively-explorable fixture this
 * small would otherwise trip in the model checker (same reason `test/add.test.ts`
 * sets it).
 */
function capDef(name: string, capabilities: string[]): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    ...(capabilities.length === 0 ? [] : [`    capabilities: [${capabilities.join(', ')}]`]),
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '',
  ].join('\n');
}

/** A file the def loader cannot build at all — it lands in `loadDefsRaw`'s failure list. */
const UNPARSEABLE_DEF = 'name: [\n';

interface Harness {
  t: HubIo;
  hub: ReturnType<typeof makeFakeHub>;
  /** HUB calls only — the GitHub fetches never reach `routedFetch`. */
  calls: RecordedCall[];
  questions: string[];
}

/**
 * A bound project + stored credential + an injected fetch that answers GitHub
 * from memory and everything else from the fake hub.
 */
function harness(
  files: Record<string, string>,
  opts: { hub?: FakeHubOpts; seed?: { name: string; yaml: string }[]; answers?: string[]; prompt?: (q: string) => Promise<string> } = {},
): Harness {
  const hub = makeFakeHub(opts.seed ?? [], opts.hub ?? {});
  const questions: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const prompt =
    opts.prompt ??
    (opts.answers === undefined
      ? undefined
      : async (question: string): Promise<string> => {
          questions.push(question);
          return answers.shift() ?? '';
        });
  const t = makeIo({ prompt });
  const routed = routedFetch(hub.routes);
  const tarball = makeGithubTarball(`${OWNER}-${REPO}-${SHA}`, files);
  const github: Record<string, { status: number; body: string | Buffer }> = {
    [`https://api.github.com/repos/${OWNER}/${REPO}/commits/HEAD`]: { status: 200, body: SHA },
    [`https://api.github.com/repos/${OWNER}/${REPO}/tarball/${SHA}`]: { status: 200, body: tarball },
  };
  t.io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.github.com/')) {
      const canned = github[url];
      if (!canned) throw new Error(`install test: no canned GitHub response for ${url}`);
      const body = typeof canned.body === 'string' ? canned.body : new Uint8Array(canned.body);
      return new Response(body, { status: canned.status });
    }
    return routed.fetch(input, init);
  }) as typeof globalThis.fetch;
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
  return { t, hub, calls: routed.calls, questions };
}

/** The index of the first `METHOD /path` call, or -1. */
function callIndex(calls: RecordedCall[], method: string, pathname: string): number {
  return calls.findIndex((call) => call.method === method && call.pathname === pathname);
}

/**
 * Run `fn` with `process.stdin.isTTY` forced false, so the non-interactive guard
 * is exercised deterministically whether or not the suite itself runs on a TTY.
 */
async function nonInteractive<T>(fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  try {
    return await fn();
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
}

// ---- the happy path, and its ordering ---------------------------------------

test('install: --accept-defaults scopes every capability and records the mapping BEFORE it publishes', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });

  const code = await mainAsync(['install', SOURCE, '--accept-defaults'], h.t.io);
  assert.equal(code, 0, h.t.err.join('\n'));

  const result = JSON.parse(h.t.out.join('\n')) as Record<string, unknown>;
  assert.deepEqual(result.mapped, { analyzer: { review: 'analyzer.review' } }, 'scoped by default — never the bare authored name');
  assert.deepEqual(result.recorded, ['analyzer']);
  assert.deepEqual(result.pushed, ['analyzer']);
  assert.equal(result.source, `${SOURCE}@${SHA}`);
  assert.deepEqual(h.hub.mappings.get('analyzer'), { review: 'analyzer.review' });

  const record = callIndex(h.calls, 'POST', '/api/set_capability_mappings');
  const publish = callIndex(h.calls, 'POST', '/api/create_workflow');
  assert.ok(record >= 0 && publish >= 0, 'both calls happened');
  assert.ok(record < publish, `mapping must be recorded before publish (record=${record}, publish=${publish})`);
});

test('install: the hub capability report is echoed on stderr, stdout stays machine JSON', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });

  const code = await mainAsync(['install', SOURCE, '--accept-defaults'], h.t.io);
  assert.equal(code, 0, h.t.err.join('\n'));
  assert.match(h.t.err.join('\n'), /analyzer: Capabilities — review → analyzer\.review: new — nothing serves it yet\./);
  assert.doesNotThrow(() => JSON.parse(h.t.out.join('\n')), 'stdout is a single JSON document');
});

// ---- deciding the vocabulary ------------------------------------------------

test('install: an operator can link an outside capability into the org vocabulary at the prompt', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) }, {
    hub: { capabilityRoutes: [{ capability: 'code-review', crewId: 'crew_1', crewName: 'reviewers' }] },
    answers: ['code-review'],
  });

  const code = await mainAsync(['install', SOURCE], h.t.io);
  assert.equal(code, 0, h.t.err.join('\n'));
  assert.deepEqual(h.hub.mappings.get('analyzer'), { review: 'code-review' });
  assert.deepEqual(h.questions, ['  review  [analyzer.review]: '], 'the scoped name is offered as the prefilled default');

  const err = h.t.err.join('\n');
  assert.match(err, /Your org already routes: code-review \(reviewers\)/, 'the existing vocabulary is shown before the question');
  assert.match(err, /analyzer: Capabilities — review → code-review: bound \(reviewers\)/);
});

test('install: --map covering every authored capability never reaches the prompt', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) }, {
    prompt: async () => {
      throw new Error('the prompt must not be consulted when --map covers everything');
    },
  });

  const code = await mainAsync(['install', SOURCE, '--map', 'review=code-review'], h.t.io);
  assert.equal(code, 0, h.t.err.join('\n'));
  assert.deepEqual(h.hub.mappings.get('analyzer'), { review: 'code-review' });
});

test('install: an identity --map records nothing but still publishes', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });

  const code = await mainAsync(['install', SOURCE, '--map', 'review=review'], h.t.io);
  assert.equal(code, 0, h.t.err.join('\n'));
  const result = JSON.parse(h.t.out.join('\n')) as Record<string, unknown>;
  assert.deepEqual(result.mapped, { analyzer: { review: 'review' } });
  assert.deepEqual(result.recorded, [], 'the hub drops identity rows — writing one would change nothing');
  assert.deepEqual(result.pushed, ['analyzer']);
  assert.equal(callIndex(h.calls, 'POST', '/api/set_capability_mappings'), -1, 'no mapping write at all');
  assert.ok(callIndex(h.calls, 'POST', '/api/create_workflow') >= 0);
});

// ---- carry-forward ----------------------------------------------------------

test('install: a re-install carries a recorded mapping forward and asks only about the new capability', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review', 'triage']) }, {
    hub: { mappings: { analyzer: { review: 'code-review' } } },
    answers: [''],
  });

  const code = await mainAsync(['install', SOURCE], h.t.io);
  assert.equal(code, 0, h.t.err.join('\n'));
  assert.deepEqual(h.questions, ['  triage  [analyzer.triage]: '], 'the carried-forward capability is not asked about again');
  assert.deepEqual(h.hub.mappings.get('analyzer'), { review: 'code-review', triage: 'analyzer.triage' });

  const write = h.calls.find((call) => call.pathname === '/api/set_capability_mappings');
  assert.deepEqual(
    JSON.parse(write?.body ?? '{}'),
    { def: 'analyzer', mappings: { triage: 'analyzer.triage' } },
    'only the new entry is written — a carried-forward row is never rewritten',
  );
  const result = JSON.parse(h.t.out.join('\n')) as Record<string, unknown>;
  assert.deepEqual(result.mapped, { analyzer: { review: 'code-review', triage: 'analyzer.triage' } });
});

// ---- hubs that cannot record ------------------------------------------------

test('install: a hub with no mapping writer fails closed — exit 2, nothing published', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) }, { hub: { mappingsUnsupported: true } });

  const code = await mainAsync(['install', SOURCE, '--accept-defaults'], h.t.io);
  assert.equal(code, 2, h.t.err.join('\n'));
  assert.match(h.t.err.join('\n'), /set_capability_mappings/, 'names the verb the hub is missing');
  assert.equal(callIndex(h.calls, 'POST', '/api/create_workflow'), -1, 'not one def was published');
});

test('install: a hub that cannot REPORT mappings warns before asking, then asks about everything', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review', 'triage']) }, {
    hub: { mappingsUnsupported: true },
    answers: ['', ''],
  });

  const code = await mainAsync(['install', SOURCE], h.t.io);
  assert.equal(code, 2, 'the write is missing too, so it still fails closed');
  assert.deepEqual(h.questions, ['  review  [analyzer.review]: ', '  triage  [analyzer.triage]: ']);
  const err = h.t.err.join('\n');
  const warning = err.indexOf('cannot report capability mappings already recorded for analyzer');
  assert.ok(warning >= 0, `the overwrite risk is stated: ${err}`);
  assert.ok(warning < err.indexOf('analyzer authors 2 capability(ies)'), 'and it is stated BEFORE the first question');
});

// ---- refusals, all before any hub request -----------------------------------

test('install: a non-interactive run with neither --map nor --accept-defaults refuses with an empty request log', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });

  const code = await nonInteractive(() => mainAsync(['install', SOURCE], h.t.io));
  assert.equal(code, 1);
  const err = h.t.err.join('\n');
  assert.match(err, /--map <authored>=<org>/, 'names the flag that answers per capability');
  assert.match(err, /--accept-defaults/, 'and the flag that takes the scoped name for all of them');
  assert.equal(h.calls.length, 0, 'not one hub request — the guard fires before the vocabulary read');
});

test('install: --map naming a capability no selected def authors is an error, not a silent no-op', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });

  const code = await mainAsync(['install', SOURCE, '--map', 'ghost=x', '--accept-defaults'], h.t.io);
  assert.equal(code, 1);
  const err = h.t.err.join('\n');
  assert.match(err, /ghost/, 'names the unmatched authored capability');
  assert.match(err, /authored: review/, 'and lists what the selection actually authors');
  assert.equal(h.calls.length, 0);
});

test('install: a mapping target carrying the modifier separator is refused before anything is fetched', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });

  const code = await mainAsync(['install', SOURCE, '--map', 'review=code:deep'], h.t.io);
  assert.equal(code, 1);
  assert.match(h.t.err.join('\n'), /must not contain ':'/, 'the suffix position belongs to the run modifier');
  assert.equal(h.calls.length, 0);
});

test('install: a .wnlp path and an http(s) URL are refused, pointing at add + push --bundle', async () => {
  for (const spec of ['./pkg.wnlp', 'https://example.com/pkg.wnlp']) {
    const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });
    const code = await mainAsync(['install', spec, '--accept-defaults'], h.t.io);
    assert.equal(code, 1, spec);
    const err = h.t.err.join('\n');
    assert.match(err, /only owner\/repo\[@ref\] \(GitHub\) is/, spec);
    assert.match(err, new RegExp(`owenloop add ${spec.replace(/[./]/g, '\\$&')}`), spec);
    assert.match(err, /owenloop push --bundle/, spec);
    assert.equal(h.calls.length, 0, spec);
  }
});

test('install: a file the validation gate rejects maps nothing and publishes nothing', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']), 'workflows/broken.yaml': UNPARSEABLE_DEF });

  const code = await mainAsync(['install', SOURCE, '--accept-defaults'], h.t.io);
  assert.equal(code, 1);
  const err = h.t.err.join('\n');
  assert.match(err, /nothing mapped, nothing published/, 'the refusal states both halves are untouched');
  assert.match(err, /broken\.yaml/, 'and names the offending file');
  assert.equal(h.calls.length, 0, 'the gate is client-side and runs before the first hub request');
});

// ---- dry run ----------------------------------------------------------------

test('install --dry-run reports the mapping it would record and sends no write', async () => {
  const h = harness({ 'workflows/analyzer.yaml': capDef('analyzer', ['review']) });

  const code = await mainAsync(['install', SOURCE, '--accept-defaults', '--dry-run'], h.t.io);
  assert.equal(code, 0, h.t.err.join('\n'));
  const result = JSON.parse(h.t.out.join('\n')) as Record<string, unknown>;
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.wouldRecord, { analyzer: { review: 'analyzer.review' } });
  assert.deepEqual(result.wouldPush, ['analyzer']);
  assert.deepEqual(result.new, ['analyzer']);
  assert.equal(
    h.calls.filter((call) => call.method === 'POST').length,
    0,
    'a dry run reads the vocabulary and the diff, and writes nothing',
  );
  assert.equal(h.hub.mappings.size, 0);
});
