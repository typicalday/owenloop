/**
 * The Phase 1 repo invariant: the harness layer stays vendor-neutral, does not
 * depend on the legacy compile-time adapter layer, and never lets the test-only
 * fake adapter into a production import graph.
 *
 * SCOPE, deliberately narrow: this file polices INSIDE `src/harness/` only. When
 * it was written the wider gate was impossible — nine legacy files under `src/`
 * legitimately named a harness (the `src/adapters/` trio, `src/bundle/types.ts`,
 * `src/shift/loop.ts`, `src/roles/{lint,prepare,shift}.ts`, `src/usage.ts`) — so
 * the redesign plan deferred it to Phase 6, once Phase 5 had deleted the legacy
 * path.
 *
 * PHASE 6 LANDED THAT WIDER GATE, in `test/vendor-gate.test.ts`. The two are
 * complements and both stay: that file polices the REST of the shipped source
 * (`src/` and `bin/` outside the harness layer, against a four-entry allowlist);
 * this file polices the harness layer itself. `VENDOR_RE` below and the copy
 * over there are deliberate DUPLICATES rather than a shared import, so neither
 * gate can be weakened by an edit aimed at the other. Nothing in this file's
 * assertions changed in Phase 6 — only this comment.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const HARNESS = join(SRC, 'harness');

/** Vendor names no neutral harness file may mention, in code OR in a comment. */
const VENDOR_RE = /claude|codex|anthropic|openai/i;

/**
 * The per-harness adapter modules, allowlisted BY EXACT PATH up front so that
 * Phase 2A and Phase 2B can land their adapters without editing this test.
 * Paths are relative to `src/harness/`, `/`-separated.
 */
const VENDOR_ALLOWLIST = new Set(['claude.ts', 'codex.ts']);

/** Every `.ts` file under `dir`, as `/`-separated paths relative to `dir`. */
function tsFilesUnder(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true }) as string[];
  return entries
    .map((e) => e.split(sep).join('/'))
    .filter((e) => e.endsWith('.ts'))
    .filter((e) => statSync(join(dir, e)).isFile());
}

const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8');

test('the walk actually finds the harness layer (a path typo cannot make these vacuous)', () => {
  const files = tsFilesUnder(HARNESS);
  assert.ok(files.length > 0, `expected .ts files under ${HARNESS}, found none`);
  assert.ok(tsFilesUnder(SRC).length > files.length, 'expected src/ to hold more than just src/harness/');
});

test('no neutral file under src/harness/ names a harness vendor', () => {
  const offenders: string[] = [];
  for (const rel of tsFilesUnder(HARNESS)) {
    if (VENDOR_ALLOWLIST.has(rel)) continue; // the per-harness adapter modules
    const match = VENDOR_RE.exec(read(HARNESS, rel));
    if (match !== null) offenders.push(`src/harness/${rel}: '${match[0]}'`);
  }
  assert.deepEqual(
    offenders,
    [],
    'a vendor name outside an adapter module breaks the harness-neutrality rule',
  );
});

test('nothing under src/harness/ imports from src/adapters/ (the legacy compile layer)', () => {
  // Both quote styles; `verbatimModuleSyntax` means these are always literal.
  const ADAPTER_IMPORT_RE = /from\s+['"][^'"]*\.\.\/adapters\//;
  const offenders: string[] = [];
  for (const rel of tsFilesUnder(HARNESS)) {
    if (ADAPTER_IMPORT_RE.test(read(HARNESS, rel))) offenders.push(`src/harness/${rel}`);
  }
  assert.deepEqual(offenders, [], 'the harness layer must not depend on the legacy adapter layer');
});

test('no file under src/ imports the test-only fake adapter', () => {
  // Matches a relative sibling import and any path ending in harness/fake.ts.
  const FAKE_IMPORT_RE = /from\s+['"][^'"]*(?:\.\/fake\.ts|harness\/fake\.ts)['"]/;
  const self = relative(SRC, join(HARNESS, 'fake.ts')).split(sep).join('/');
  const offenders: string[] = [];
  for (const rel of tsFilesUnder(SRC)) {
    if (rel === self) continue; // the module itself is not a caller
    if (FAKE_IMPORT_RE.test(read(SRC, rel))) offenders.push(`src/${rel}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'fake.ts is a test-only export: it must have no production caller',
  );
});

test('there is no barrel under src/harness/ through which the fake could leak', () => {
  const files = tsFilesUnder(HARNESS);
  assert.equal(files.includes('index.ts'), false, 'importers name the module; do not add a barrel');
});
