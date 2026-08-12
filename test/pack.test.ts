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

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { PLUGIN_FILES } from '../scripts/check-npm-package.mjs';
import { hostileFileEntry, hostileTarball } from './helpers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_CHECK = fileURLToPath(new URL('../scripts/check-npm-package.mjs', import.meta.url));

const PLUGIN_EXECUTABLES = new Set([
  'plugins/claude-code/plugin/hooks/session-end.sh',
  'plugins/claude-code/plugin/hooks/session-start.sh',
  'plugins/codex/plugins/owenloop/hooks/session-end.sh',
  'plugins/codex/plugins/owenloop/hooks/session-start.sh',
]);

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

function packTarball(): Buffer {
  const destination = mkdtempSync(join(tmpdir(), 'owenloop-package-gate-'));
  try {
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', destination], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    const files = readdirSync(destination);
    assert.deepEqual(files.length, 1, `npm pack should write one tarball (got ${files.join(', ')})`);
    return readFileSync(join(destination, files[0]!));
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function runPackageCheck(
  tarball: Buffer,
  packageCheck = PACKAGE_CHECK,
): { status: number | null; stdout: string; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), 'owenloop-package-policy-'));
  const path = join(directory, 'package.tgz');
  writeFileSync(path, tarball);
  try {
    const result = spawnSync(process.execPath, [packageCheck, path], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validPluginTarball(
  extraBlocks: Buffer[] = [],
  modeOverrides: ReadonlyMap<string, number> = new Map(),
): Buffer {
  const blocks = PLUGIN_FILES.flatMap((path) =>
    hostileFileEntry(`package/${path}`, '', {
      mode: modeOverrides.get(path) ?? (PLUGIN_EXECUTABLES.has(path) ? 0o755 : 0o644),
    }),
  );
  return hostileTarball([...blocks, ...extraBlocks]);
}

test('npm pack includes everything a consumer needs', () => {
  const files = packedFiles();
  for (const needed of [
    'package.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'dist/src/index.js',
    'dist/src/index.d.ts',
    'dist/src/engine.js',
    'dist/src/cli.js',
    'dist/src/bundle/index.js',
    'dist/src/bundle/index.d.ts',
    'dist/src/bundle/types.d.ts',
    'dist/src/bundle/manifest.js',
    'dist/src/bundle/runtime.js',
    'dist/src/bundle/runtime.d.ts',
    'dist/src/bundle/tar.js',
    'dist/packages/work/src/main.js',
    'dist/packages/work/src/main.d.ts',
    'bin/owenloop.mjs',
    'examples/workflows/delivery.yaml',
    'docs/design.md',
  ]) {
    assert.ok(files.includes(needed), `tarball should include ${needed}`);
  }
  assert.deepEqual(
    files.filter((f) => f.startsWith('bin/')),
    ['bin/owenloop.mjs'],
    'tarball should publish exactly one owenloop binary',
  );
});

test('npm pack ships compiled output, not TypeScript source', () => {
  const files = packedFiles();
  const tsSource = files.filter((f) =>
    f.startsWith('src/') ||
    f.startsWith('packages/') ||
    (f.endsWith('.ts') && !f.endsWith('.d.ts')),
  );
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

test('npm pack ships exactly the Claude Code and Codex consumer plugin files', () => {
  const packed = packedFiles().filter((file) => file.startsWith('plugins/')).sort();
  assert.deepEqual(packed, [...PLUGIN_FILES].sort());
});

test('the shared npm package validator accepts the actual npm pack tarball', () => {
  const result = runPackageCheck(packTarball());
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /npm package content OK/);
});

test('the npm package validator executes safely from paths containing spaces, #, and %', () => {
  const directory = mkdtempSync(join(tmpdir(), 'owenloop package #100% - '));
  const packageCheck = join(directory, 'check npm package #100%.mjs');
  try {
    writeFileSync(packageCheck, readFileSync(PACKAGE_CHECK));
    const result = runPackageCheck(
      hostileTarball([
		...PLUGIN_FILES.flatMap((path) =>
		  hostileFileEntry(`package/${path}`, '', {
		    mode: PLUGIN_EXECUTABLES.has(path) ? 0o755 : 0o644,
		  }),
		),
		...hostileFileEntry('package/plugins/codex/plugins/owenloop/evil.js', ''),
      ]),
      packageCheck,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected package path: plugins\/codex\/plugins\/owenloop\/evil\.js/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the npm package validator rejects plugin source, credentials, traversal, links, and extras', () => {
  const cases = [
    {
      name: 'source-only files',
      blocks: hostileFileEntry('package/plugins/_skills/author/SKILL.md', ''),
      reason: 'unexpected package path: plugins/_skills/author/SKILL.md',
    },
    {
      name: 'hidden credentials',
      blocks: hostileFileEntry('package/plugins/claude-code/plugin/.env', ''),
      reason: 'unexpected package path: plugins/claude-code/plugin/.env',
    },
    {
      name: 'local config',
      blocks: hostileFileEntry('package/plugins/codex/plugins/owenloop/.npmrc', ''),
      reason: 'unexpected package path: plugins/codex/plugins/owenloop/.npmrc',
    },
    {
      name: 'path traversal',
      blocks: hostileFileEntry('package/plugins/claude-code/plugin/../credentials.json', ''),
      reason: 'unsafe package path: package/plugins/claude-code/plugin/../credentials.json',
    },
    {
      name: 'symlinks',
      blocks: hostileFileEntry('package/plugins/claude-code/plugin/evil.js', '', {
        linkname: '../../.env',
        typeflag: '2',
      }),
      reason: 'tar entry is not a regular file: plugins/claude-code/plugin/evil.js (type 2)',
    },
    {
      name: 'arbitrary plugin files',
      blocks: hostileFileEntry('package/plugins/codex/plugins/owenloop/evil.js', ''),
      reason: 'unexpected package path: plugins/codex/plugins/owenloop/evil.js',
    },
  ] as const;

  for (const testCase of cases) {
    const result = runPackageCheck(validPluginTarball(testCase.blocks));
    assert.notEqual(result.status, 0, `${testCase.name} should fail closed`);
    assert.match(result.stderr, new RegExp(testCase.reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('the npm package validator rejects an unexpected executable mode independently', () => {
  const result = runPackageCheck(
    validPluginTarball([], new Map([
      ['plugins/claude-code/plugin/skills/author/SKILL.md', 0o755],
    ])),
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unexpected mode for plugins\/claude-code\/plugin\/skills\/author\/SKILL\.md: expected 644, got 755/,
  );
  assert.doesNotMatch(result.stderr, /duplicate tar path/);
});
