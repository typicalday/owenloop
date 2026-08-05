/**
 * Enforces the committed materialized plugin contract.
 *
 * `plugins/_skills/` and `plugins/_hooks/` are the single source of truth;
 * `plugins/claude-code/plugin/` and `plugins/codex/plugins/owenloop/` contain
 * committed copies so both marketplaces work directly from a git checkout. The test walks
 * both directions, compares bytes and executable bits, and catches stale
 * materialized or missing source files. The copies are intentionally not made
 * by `prepack`: generating them there would make a checkout un-installable and
 * would let `check` repair the drift that this test is meant to detect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Recursively list every file (not directory) under `dir`, absolute paths. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const MIRRORS = [
  {
    name: 'skills',
    source: join(ROOT, 'plugins/_skills'),
    materialized: join(ROOT, 'plugins/claude-code/plugin/skills'),
  },
  {
    name: 'hooks',
    source: join(ROOT, 'plugins/_hooks'),
    materialized: join(ROOT, 'plugins/claude-code/plugin/hooks'),
  },
  {
    name: 'codex skills',
    source: join(ROOT, 'plugins/_skills'),
    materialized: join(ROOT, 'plugins/codex/plugins/owenloop/skills'),
  },
  {
    name: 'codex hooks',
    source: join(ROOT, 'plugins/_hooks'),
    materialized: join(ROOT, 'plugins/codex/plugins/owenloop/hooks'),
  },
] as const;

for (const { name, source, materialized } of MIRRORS) {
  test(`${name} materialized files match their source tree`, () => {
    const sourceFiles = walkFiles(source);
    assert.ok(sourceFiles.length > 0, `${name} source tree must contain at least one file`);

    const sourceRelativeFiles = new Set(sourceFiles.map((file) => relative(source, file)));
    for (const sourceFile of sourceFiles) {
      const rel = relative(source, sourceFile);
      const materializedFile = join(materialized, rel);
      assert.ok(existsSync(materializedFile), `${name}/${rel} must be materialized`);
      assert.ok(
        readFileSync(sourceFile).equals(readFileSync(materializedFile)),
        `${name}/${rel} must be byte-identical to its materialized copy`,
      );
      assert.equal(
        statSync(sourceFile).mode & 0o111,
        statSync(materializedFile).mode & 0o111,
        `${name}/${rel} must preserve executable bits`,
      );
    }

    for (const materializedFile of walkFiles(materialized)) {
      const rel = relative(materialized, materializedFile);
      assert.ok(
        sourceRelativeFiles.has(rel),
        `${name}/${rel} is an orphan in the materialized tree`,
      );
    }
  });
}
