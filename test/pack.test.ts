/**
 * Guards the published surface. `npm publish` ships whatever `npm pack` would
 * produce; this asserts that tarball carries exactly what a consumer needs
 * (the compiled `dist/` output + declarations, the bin, the example workflows,
 * the docs) and never leaks TypeScript source, local foreman state (the
 * graph/state DBs, `.dev/` scaffolding), or repo-only files (the test suite,
 * CI config). Driven by the `files` whitelist in package.json.
 *
 * The manifest is read with `--ignore-scripts` so the dry run does not fire
 * `prepack` (which rebuilds `dist/`) while the rest of the suite is running.
 * `npm run build`/`pretest` has already produced `dist/` before this test runs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** The file list `npm pack` would publish, via a no-op dry run. */
function packedFiles(): string[] {
  // --dry-run writes no tarball; --json puts the manifest on stdout.
  // --ignore-scripts avoids triggering prepack mid-suite (would rebuild dist/).
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // The `pack --json` top level differs by npm major: npm <=11 emits an ARRAY
  // of package manifests; npm 12 emits an OBJECT keyed by package name. The
  // per-file entries ({ path, size, mode }) are identical either way — only the
  // wrapper changed. Normalize to the single manifest entry without hardcoding
  // the package name (it is keyed by name; a rename would break a literal key).
  const parsed = JSON.parse(out) as unknown;
  const entry = (
    Array.isArray(parsed)
      ? parsed[0]
      : parsed && typeof parsed === 'object'
        ? Object.values(parsed)[0]
        : undefined
  ) as { files?: Array<{ path: string }> } | undefined;
  const files = (entry?.files ?? []).map((f) => f.path.replace(/\\/g, '/'));
  // Fail loudly if the schema shifts again: an empty list would silently pass
  // every "must NOT include X" assertion while only tripping the "must include"
  // one. The raw-output snippet makes the next npm bump self-diagnosing.
  assert.ok(
    files.length > 0,
    `npm pack --json returned no files — output schema likely changed again; raw output starts: ${out.slice(0, 200)}`,
  );
  return files;
}

test('npm pack includes everything a consumer needs', () => {
  const files = packedFiles();
  for (const needed of [
    'package.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/engine.js',
    'dist/cli.js',
    'bin/owenloop.mjs',
    'examples/workflows/delivery.yaml',
    'docs/design.md',
  ]) {
    assert.ok(files.includes(needed), `tarball should include ${needed}`);
  }
});

test('npm pack ships compiled output, not TypeScript source', () => {
  const files = packedFiles();
  const tsSource = files.filter((f) => f.startsWith('src/') || (f.endsWith('.ts') && !f.endsWith('.d.ts')));
  assert.equal(tsSource.length, 0, `tarball must not ship TS source (got ${tsSource.join(', ')})`);
});

test('npm pack excludes local state, scaffolding, and repo-only files', () => {
  const files = packedFiles();
  // Exact local-state paths that must never be published.
  for (const forbidden of ['graph.sqlite', '.dev', '.owenloop']) {
    assert.ok(
      !files.some((f) => f === forbidden || f.startsWith(`${forbidden}/`)),
      `tarball must not include ${forbidden}`,
    );
  }
  // Whole trees that are repo-only, not part of the distributed library.
  for (const prefix of ['test/', '.github/']) {
    const leaked = files.filter((f) => f.startsWith(prefix));
    assert.equal(leaked.length, 0, `tarball must not include ${prefix}* (got ${leaked.join(', ')})`);
  }
});
