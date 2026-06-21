/**
 * Guards the published surface. `npm publish` ships whatever `npm pack` would
 * produce; this asserts that tarball carries exactly what a consumer needs
 * (the source, the bin, the examples) and never leaks local foreman state
 * (the graph/state DBs, `.dev/` scaffolding) or repo-only files (the test
 * suite, CI config). Driven by the `files` whitelist in package.json.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** The file list `npm pack` would publish, via a no-op dry run. */
function packedFiles(): string[] {
  // --dry-run writes no tarball; --json puts the manifest on stdout.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const manifest = JSON.parse(out) as Array<{ files?: Array<{ path: string }> }>;
  const files = manifest[0]?.files ?? [];
  return files.map((f) => f.path.replace(/\\/g, '/'));
}

test('npm pack includes everything a consumer needs', () => {
  const files = packedFiles();
  for (const needed of [
    'package.json',
    'README.md',
    'LICENSE',
    'src/index.ts',
    'src/engine.ts',
    'src/factory.ts',
    'src/store.ts',
    'bin/liveloop.mjs',
    'examples/embed.ts',
  ]) {
    assert.ok(files.includes(needed), `tarball should include ${needed}`);
  }
});

test('npm pack excludes local state, scaffolding, and repo-only files', () => {
  const files = packedFiles();
  // Exact local-state paths that must never be published.
  for (const forbidden of ['graph.sqlite', '.dev', '.liveloop']) {
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
