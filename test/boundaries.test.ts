/**
 * Core/hub boundary lint (test-based — there is no ESLint in this repo; the
 * quality gate is `npm run check` = typecheck + build + `node --test`, so a
 * failing test IS the lint). It pins the engine core as host- and hub-agnostic:
 *
 *   A. no core module imports a hub/CLI module (`hub`, `cli`, `add`, `untar`),
 *      and the public barrel `index.ts` never couples to `cli.ts`;
 *   B. no core module (nor `index.ts`) hard-codes vendor/host-specific
 *      vocabulary (concrete model or provider names);
 *   C. `hashDefForHub` has been re-homed out of `src/defs.ts` for good.
 *
 * Hermetic: reads only the repo's own `src/` tree, resolved relative to this
 * file (`import.meta.url`) so it is cwd-independent and touches no ambient
 * machine state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC_DIR = new URL('../src/', import.meta.url);

/** Engine core — the host/hub-agnostic heart of the package. */
const CORE = [
  'engine.ts',
  'model.ts',
  'store.ts',
  'defs.ts',
  'schema.ts',
  'types.ts',
  'paths.ts',
  'util.ts',
  'factory.ts',
];

function readCore(file: string): string[] {
  return readFileSync(fileURLToPath(new URL(file, SRC_DIR)), 'utf8').split('\n');
}

// ---- Check A: import boundary ------------------------------------------------

test('boundary A: no engine-core module imports a hub/CLI module', () => {
  // Catches every coupling form: `import {..} from './hub.ts'`, `import type ..
  // from`, `export .. from`, and a bare side-effect `import './hub.ts'`.
  const HUB_IMPORT = /(?:from|import)\s+['"]\.\/(hub|cli|add|untar)\.ts['"]/;
  const violations: string[] = [];
  for (const file of CORE) {
    const lines = readCore(file);
    lines.forEach((line, i) => {
      const m = line.match(HUB_IMPORT);
      if (m) violations.push(`src/${file}:${i + 1} imports './${m[1]}.ts' — core must not depend on hub/CLI modules`);
    });
  }
  assert.equal(violations.length, 0, `core→hub/CLI import boundary violated:\n${violations.join('\n')}`);
});

test('boundary A: index.ts (public barrel) never couples to cli.ts', () => {
  const CLI_IMPORT = /(?:from|import)\s+['"]\.\/cli\.ts['"]/;
  const violations: string[] = [];
  readCore('index.ts').forEach((line, i) => {
    if (CLI_IMPORT.test(line)) violations.push(`src/index.ts:${i + 1} imports/re-exports from './cli.ts' — the barrel must not pull the CLI into the library surface`);
  });
  assert.equal(violations.length, 0, violations.join('\n'));
});

// ---- Check B: vocabulary -----------------------------------------------------

/**
 * Concrete vendor/model names that must never appear in the engine core: the
 * engine speaks in opaque tiers (`fast`/`standard`/`strong`/`strongest`), not
 * provider brands (design.md, judges `model:` discipline). `agent` and
 * `session` are intentionally NOT banned — `agent` is first-class engine
 * grammar (`worker: 'agent'`) and `session` reads as plain English in
 * comments; banning them would fire on legitimate host-agnostic usage.
 */
const BANNED_TERMS: RegExp[] = [
  /\bclaude\b/i,
  /\banthropic\b/i,
  /\bsonnet\b/i,
  /\bopus\b/i,
  /\bhaiku\b/i,
  /\bopenai\b/i,
  /\bgpt-/i,
  /\bclaude[ -]code\b/i,
];

test('boundary B: engine-core carries no vendor/host-specific vocabulary', () => {
  const violations: string[] = [];
  for (const file of [...CORE, 'index.ts']) {
    const lines = readCore(file);
    lines.forEach((line, i) => {
      for (const term of BANNED_TERMS) {
        const m = line.match(term);
        if (m) violations.push(`src/${file}:${i + 1} contains banned vendor term "${m[0]}" — the engine core stays vendor/model-agnostic`);
      }
    });
  }
  assert.equal(violations.length, 0, `vendor-vocabulary boundary violated:\n${violations.join('\n')}`);
});

// ---- Check C: hashDefForHub re-homing regression guard -----------------------

test('boundary C: hashDefForHub is gone from src/defs.ts (re-homed into src/hub.ts)', () => {
  const lines = readCore('defs.ts');
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (/\bhashDefForHub\b/.test(line)) hits.push(`src/defs.ts:${i + 1}: ${line.trim()}`);
  });
  assert.equal(hits.length, 0, `hashDefForHub must live in src/hub.ts, not core src/defs.ts:\n${hits.join('\n')}`);
});
