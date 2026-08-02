/**
 * `owenloop work lint` — the SECOND composition root, its per-step resolution, and
 * the def-parser check that keeps a stale def from degrading silently.
 *
 * Why this file exists. Phase 5 deleted `src/adapters/` and with it
 * `test/adapter-claude-code.test.ts`. Most of that file was genuinely dead, but
 * the lint knowledge was MOVED, not deleted — it lives in `src/harness/claude.ts`
 * and `src/roles/lint.ts` behind the deliberately retained `lint` verb (plan
 * Stage D item 6). The adapter's own field vocabulary is re-covered in
 * `test/harness-claude.test.ts`; everything that is NOT the adapter's — which
 * harness gets asked, what the def parser refuses, and how findings are printed —
 * is covered here.
 *
 * Three things here are load-bearing beyond ordinary coverage:
 *
 *  1. THE LEGACY BAG MUST THROW. A def still written to the pre-`x.harness`
 *     grammar used to parse "cleanly" into `harnessOptions === undefined`, which
 *     is byte-identical to "this step declares no options" — so `prepare` wrote
 *     empty permissions, `lint` printed `0 error(s), 0 warning(s)`, and the step
 *     ran with its `tools` allow-list and `disallowedTools` deny-list dropped.
 *     Fail-OPEN on permissions. These cases fail if that detection is ever
 *     removed or softened into a shim.
 *
 *  2. PLAN §8 RISK 6 — adapter import ORDER, which decides `defaultHarnessId()`.
 *     Through Phase 5 the order was duplicated across two composition roots,
 *     `src/roles/agent-run.ts` and `src/roles/lint.ts`, and an organize-imports
 *     pass over one and not the other silently gave `lint` a different default
 *     harness than the runner. Phase 6 collapsed both into `src/harnesses.ts`.
 *     Two tests pin the new arrangement — one on the source text (the order is
 *     in the root, and nowhere else), one on real registration order observed in
 *     child processes that import each role module.
 *
 *  3. THE RESTORED MODEL-CONFLICT WARNING. It cannot live in an adapter (the
 *     `lintStep(bag, stepName)` contract never sees `step.model`), so it lives in
 *     `lintOneStep` and is asserted here.
 *
 * Hermetic: the CLI cases write their own YAML into a `mkdtempSync` directory
 * and run against a replaced environment, so no developer's cached bundle,
 * settings file, or `$HOME` can reach them. The `.yaml` target path in
 * `loadSteps` reads nothing but the file it is handed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { lintOneStep } from '../src/roles/lint.ts';
import { HARNESS_BAG_KEY, LEGACY_BAG_KEY, parseHarnessCarrier } from '../src/bundle/fetch.ts';
import { adapterFor, defaultHarnessId, register, registeredHarnessIds, unregister } from '../src/harness/registry.ts';
import type { FetchedStep } from '../src/bundle/types.ts';

const BIN = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));
const SRC = new URL('../src/', import.meta.url);

const tmpDirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'owenloop-lint-'));
  tmpDirs.push(d);
  return d;
};
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Run the shipped binary with a REPLACED environment (only `PATH` carries
 * through, so node itself resolves). Same stance as `test/dispatch.test.ts`: a
 * developer's real settings or cache must never reach a lint case.
 */
function runLint(args: string[]): { status: number; stdout: string; stderr: string } {
  const home = scratch();
  const res = spawnSync(process.execPath, [BIN, 'work', 'lint', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: home, OWENLOOP_CACHE_DIR: join(home, 'cache') },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** Write `body` as a def file in a fresh scratch dir and return its path. */
function defFile(name: string, body: string): string {
  const p = join(scratch(), name);
  writeFileSync(p, body, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// 1. The legacy bag key must fail LOUDLY (the fail-open regression)
// ---------------------------------------------------------------------------

test('a step carrying the legacy bag key throws, instead of parsing to "no options"', () => {
  const raw = {
    name: 'builder',
    x: { [LEGACY_BAG_KEY]: { tools: ['Read'], disallowedTools: ['Bash'] } },
  };
  // WITHOUT the detection this call returns `{}` — `harnessOptions === undefined`,
  // indistinguishable from a bagless step — and the deny-list above is dropped
  // onto a live step agent with no error, no warning, and no distinguishing log.
  assert.throws(
    () => parseHarnessCarrier(raw, 'wf', 'builder'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(`x\\.${LEGACY_BAG_KEY}`), 'must name the key the author actually wrote');
      assert.match(err.message, new RegExp(`x\\.${HARNESS_BAG_KEY}`), 'must name the key to rename it to');
      assert.match(err.message, /builder/, 'must name the offending step');
      return true;
    },
  );
});

test('the legacy bag throws even when a valid x.harness bag sits beside it', () => {
  // A half-migrated def is the most dangerous shape: the new bag makes it look
  // migrated while the old one silently carries the fields the author edited.
  const raw = {
    name: 's',
    x: { [HARNESS_BAG_KEY]: { tools: ['Read'] }, [LEGACY_BAG_KEY]: { disallowedTools: ['Bash'] } },
  };
  assert.throws(() => parseHarnessCarrier(raw, 'wf', 's'), new RegExp(LEGACY_BAG_KEY));
});

test('the legacy check is NARROW — it does not disturb any well-formed step', () => {
  assert.deepEqual(parseHarnessCarrier({ name: 's' }, 'wf', 's'), {});
  assert.deepEqual(parseHarnessCarrier({ name: 's', x: {} }, 'wf', 's'), {});
  assert.deepEqual(parseHarnessCarrier({ name: 's', x: { other: { a: 1 } } }, 'wf', 's'), {});
  assert.deepEqual(
    parseHarnessCarrier({ name: 's', x: { [HARNESS_BAG_KEY]: { id: 'codex', tools: 'Read' } } }, 'wf', 's'),
    { harness: 'codex', harnessOptions: { tools: 'Read' } },
  );
});

test('a legacy-bag def makes `owenloop work lint` exit 1 with a self-service message', () => {
  const p = defFile('legacy.yaml', [
    'name: demo',
    'steps:',
    '  - name: builder',
    '    x:',
    `      ${LEGACY_BAG_KEY}:`,
    '        disallowedTools: [Bash]',
    '',
  ].join('\n'));
  const { status, stderr, stdout } = runLint([p]);
  assert.equal(status, 1, `a legacy def must NOT report clean\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.doesNotMatch(stdout, /0 error\(s\), 0 warning\(s\)/, 'the old failure mode printed exactly this');
  assert.match(stderr, new RegExp(`x\\.${LEGACY_BAG_KEY}`));
  assert.match(stderr, new RegExp(`x\\.${HARNESS_BAG_KEY}`));
});

test('the same def with only the key renamed lints clean — the fix is a rename, nothing more', () => {
  const p = defFile('migrated.yaml', [
    'name: demo',
    'steps:',
    '  - name: builder',
    '    x:',
    `      ${HARNESS_BAG_KEY}:`,
    '        disallowedTools: [Bash]',
    '',
  ].join('\n'));
  const { status, stdout } = runLint([p]);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /0 error\(s\), 0 warning\(s\)/);
});

// ---------------------------------------------------------------------------
// 2. lintOneStep — which adapter is asked, and the checks lint owns itself
// ---------------------------------------------------------------------------

const step = (over: Partial<FetchedStep>): FetchedStep => ({ name: 's', ...over });

test('a step with no option bag is silent, even before any harness is resolved', () => {
  assert.deepEqual(lintOneStep(step({})), []);
  assert.deepEqual(lintOneStep(step({ harness: 'not-registered-at-all' })), []);
});

test('a harness-less step is judged by the DEFAULT harness — the one that will run it', () => {
  const id = defaultHarnessId();
  assert.ok(id, 'the composition root must have registered at least one adapter');
  assert.deepEqual(
    lintOneStep(step({ harnessOptions: { bogusField: 1 } })),
    lintOneStep(step({ harness: id!, harnessOptions: { bogusField: 1 } })),
    'the fallback must resolve to exactly the registry head, not a hardcoded id',
  );
});

test('a step naming an unregistered harness is an error finding, not silence', () => {
  const f = lintOneStep(step({ harness: 'no-such-harness', harnessOptions: { tools: 'Read' } }));
  assert.equal(f.length, 1);
  assert.equal(f[0]!.severity, 'error');
  assert.equal(f[0]!.field, 'id');
  assert.match(f[0]!.message, /no-such-harness/);
});

test('an EMPTY registry is an error finding — lint never pretends it checked', () => {
  const saved = registeredHarnessIds().map((id) => {
    const a = adapterFor(id);
    assert.ok(a, id);
    return a!;
  });
  try {
    for (const a of saved) unregister(a.id);
    assert.deepEqual(registeredHarnessIds(), []);
    const f = lintOneStep(step({ harnessOptions: { tools: 'Read' } }));
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, 'error');
    assert.match(f[0]!.message, /no harness is registered/);
    // A bagless step stays clean even here: there is nothing to check.
    assert.deepEqual(lintOneStep(step({})), []);
  } finally {
    // Restore in the ORIGINAL order — the head is the default harness.
    for (const a of saved) register(a);
    assert.deepEqual(registeredHarnessIds(), saved.map((a) => a.id));
  }
});

test('a bag model alongside a first-class step model is a warning', () => {
  // Restored check: the runtime precedence (`step.model` wins) is implemented by
  // the neutral normalizer, so an author who sets both silently loses the bag
  // value. `lintStep(bag, stepName)` cannot see `step.model`; lint can.
  const f = lintOneStep(step({ model: 'sonnet', harnessOptions: { model: 'haiku' } }));
  assert.equal(f.length, 1);
  assert.equal(f[0]!.severity, 'warning');
  assert.equal(f[0]!.field, 'model');
  assert.match(f[0]!.message, /first-class model wins/);
  assert.match(f[0]!.message, /sonnet/, 'the message must name the model that actually wins');
});

test('a bag model with NO first-class step model draws no finding', () => {
  assert.deepEqual(lintOneStep(step({ harnessOptions: { model: 'haiku' } })), []);
});

test('the model warning is additive — adapter findings still come through', () => {
  const f = lintOneStep(step({ model: 'sonnet', harnessOptions: { model: 'haiku', maxTurns: 0 } }));
  assert.equal(f.filter((x) => x.severity === 'error').length, 1, 'the adapter error survives');
  assert.equal(f.filter((x) => x.severity === 'warning' && x.field === 'model').length, 1);
});

// ---------------------------------------------------------------------------
// 3. Plan §8 risk 6 — adapter import order lives in ONE file
// ---------------------------------------------------------------------------

/**
 * The side-effect adapter imports of one file under `src/`, in source order,
 * normalized to a bare module name (`claude.ts`, `codex.ts`).
 *
 * The pattern is deliberately loose about the path prefix so it catches an
 * adapter import re-added at ANY depth — `./harness/claude.ts` from
 * `src/harnesses.ts`, `../harness/claude.ts` from `src/roles/lint.ts`.
 */
function adapterImports(rel: string): string[] {
  const text = readFileSync(fileURLToPath(new URL(rel, SRC)), 'utf8');
  return [...text.matchAll(/^import\s+['"]\.{1,2}\/(?:\.\.\/)*harness\/([A-Za-z0-9_-]+\.ts)['"];/gm)].map((m) => m[1]!);
}

/** Does this file import the single composition root for its side effect? */
function importsRoot(rel: string): boolean {
  const text = readFileSync(fileURLToPath(new URL(rel, SRC)), 'utf8');
  return /^import\s+['"]\.{1,2}\/(?:\.\.\/)*harnesses\.ts['"];/m.test(text);
}

/**
 * PHASE 6 replaced the "two roots must agree" invariant with a stronger one:
 * there is only ONE root. Through Phase 5, `src/roles/agent-run.ts` and
 * `src/roles/lint.ts` each carried their own copy of the adapter imports, kept
 * in the same order by hand and by comment. `src/harnesses.ts` now owns that
 * order outright, and this test pins both halves of the new arrangement — the
 * root has the imports in the load-bearing order, and no role file has re-grown
 * a private copy that could reorder registration behind the root's back.
 */
test('adapter imports live only in src/harnesses.ts, in the load-bearing order', () => {
  assert.deepEqual(
    adapterImports('harnesses.ts'),
    ['claude.ts', 'codex.ts'],
    'ORDER IS LOAD-BEARING: the first module imported registers the DEFAULT harness ' +
      '(`defaultHarnessId()` is `registeredHarnessIds()[0]`). Do not sort this block, ' +
      'and do not add adapter imports anywhere else.',
  );
  for (const rel of ['roles/agent-run.ts', 'roles/lint.ts']) {
    assert.deepEqual(
      adapterImports(rel),
      [],
      `${rel} must NOT import adapter modules directly — that recreates the second ` +
        'composition root Phase 6 removed. Import `../harnesses.ts` instead.',
    );
    assert.ok(importsRoot(rel), `${rel} must import the composition root, or nothing registers at all`);
  }
});

/**
 * Registration order as OBSERVED, not as read off the source: a fresh child
 * process imports exactly one role module and reports the registry.
 *
 * This is the assertion the source-text test above cannot make. A reordering
 * that a regex misses — a re-export, a transitive import that registers first —
 * still shows up here.
 */
function idsAfterImporting(rel: string): string[] {
  const root = pathToFileURL(fileURLToPath(new URL(rel, SRC))).href;
  const registry = pathToFileURL(fileURLToPath(new URL('harness/registry.ts', SRC))).href;
  const script = [
    `await import(${JSON.stringify(root)});`,
    `const { registeredHarnessIds } = await import(${JSON.stringify(registry)});`,
    'process.stdout.write(JSON.stringify(registeredHarnessIds()));',
  ].join('\n');
  const res = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, `importing ${rel} failed:\n${res.stderr}`);
  return JSON.parse(res.stdout) as string[];
}

test('the runner and lint actually register the same harnesses, in the same order', () => {
  const viaRunner = idsAfterImporting('roles/agent-run.ts');
  const viaLint = idsAfterImporting('roles/lint.ts');
  assert.ok(viaRunner.length >= 2, `expected >=2 adapters via the runner root, got ${JSON.stringify(viaRunner)}`);
  assert.deepEqual(viaLint, viaRunner, 'the two roots disagree about what is registered, or in what order');
  assert.equal(
    viaLint[0],
    viaRunner[0],
    'the registry HEAD is `defaultHarnessId()`: lint must judge a harness-less step by the harness that runs it',
  );
});

// ---------------------------------------------------------------------------
// 4. The printer — findings are located at `x.harness.<field>`
// ---------------------------------------------------------------------------

test('an error finding prints an x.harness.<field> location and exits 1', () => {
  const p = defFile('bad.yaml', [
    'name: demo',
    'steps:',
    '  - name: builder',
    '    x:',
    `      ${HARNESS_BAG_KEY}:`,
    '        maxTurns: 0',
    '',
  ].join('\n'));
  const { status, stdout } = runLint([p]);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /error\s+step builder: x\.harness\.maxTurns:/);
  assert.doesNotMatch(stdout, /claude-code/, 'the location must be the neutral bag key, never a vendor name');
  assert.match(stdout, /1 step\(s\), 1 error\(s\), 0 warning\(s\)/);
});

test('warnings alone still exit 0 — lint blocks on errors only', () => {
  const p = defFile('warn.yaml', [
    'name: demo',
    'steps:',
    '  - name: builder',
    '    model: sonnet',
    '    x:',
    `      ${HARNESS_BAG_KEY}:`,
    '        model: haiku',
    '        bogusField: 1',
    '',
  ].join('\n'));
  const { status, stdout } = runLint([p]);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /warning\s+step builder: x\.harness\.model:/);
  assert.match(stdout, /warning\s+step builder: x\.harness\.bogusField:/);
  assert.match(stdout, /0 error\(s\), 2 warning\(s\)/);
});
