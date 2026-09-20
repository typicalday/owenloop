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
 * The generic filesystem transaction (`src/install.ts`) and every module in
 * the content-addressed workflow store (all files below `src/store/`) are
 * engine core too: they may import Node builtins and defs/model/util helpers,
 * but never `cli.ts`, `add.ts`, `untar.ts`, or a hub module — the CLI depends
 * inward on the store's ports, never the reverse.
 *
 * Hermetic: reads only the repo's own `src/` tree, resolved relative to this
 * file (`import.meta.url`) so it is cwd-independent and touches no ambient
 * machine state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('Engine runtime import graph excludes local invocation authority defaults', () => {
  const seen = new Set<string>();
  const forbidden = new Set(['store/def-source.ts', 'store/snapshot-guard.ts']);
  function visit(url: URL, via: string[]) {
    const file = fileURLToPath(url);
    if (seen.has(file)) return;
    seen.add(file);
    const relative = fileURLToPath(url).slice(fileURLToPath(SRC_DIR).length);
    assert.ok(!forbidden.has(relative), `local authority reachable: ${[...via, relative].join(' -> ')}`);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function walk(node: ts.Node) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node)) {
	const clause = node.importClause;
	if (clause?.isTypeOnly) return;
	if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
	  && clause.namedBindings.elements.every(e => e.isTypeOnly)) return;
	specifier = node.moduleSpecifier;
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
	if (node.exportClause && ts.isNamedExports(node.exportClause)
	  && node.exportClause.elements.every(e => e.isTypeOnly)) return;
	specifier = node.moduleSpecifier;
      } else if (ts.isCallExpression(node)
	&& (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
	specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
	visit(new URL(specifier.text, url), [...via, relative]);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  visit(new URL('engine.ts', SRC_DIR), []);
});

const SRC_DIR = new URL('../src/', import.meta.url);

/** Engine core — the host/hub-agnostic heart of the package. */
const CORE = [
  'engine.ts',
  'capabilities.ts',
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

/** Recursively list every `.ts` file under `src/store/` (engine core). */
function listStoreFiles(relDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(fileURLToPath(new URL(relDir, SRC_DIR)), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listStoreFiles(`${relDir}${entry.name}/`));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(`${relDir}${entry.name}`);
    }
  }
  return out;
}

/** Core + the generic transaction + every workflow-store module. */
const CORE_ALL = [...CORE, 'install.ts', ...listStoreFiles('store/')];

// ---- Check A: import boundary ------------------------------------------------

test('boundary A: no engine-core module imports a hub/CLI module', () => {
  // Catches every coupling form: `import {..} from './hub.ts'`, `import type ..
  // from`, `export .. from`, and a bare side-effect `import './hub.ts'`. The
  // `(../)*` prefix covers store modules one level down (`../add.ts`) so a
  // relative-depth change cannot smuggle a hub/CLI import past the check.
  const HUB_IMPORT = /(?:from|import)\s+['"](?:(?:\.\.\/)+|\.\/)(hub|cli|add|untar)\.ts['"]/;
  const violations: string[] = [];
  for (const file of CORE_ALL) {
    const lines = readCore(file);
    lines.forEach((line, i) => {
      const m = line.match(HUB_IMPORT);
      if (m) violations.push(`src/${file}:${i + 1} imports './${m[1]}.ts' — core must not depend on hub/CLI modules`);
    });
  }
  assert.equal(violations.length, 0, `core→hub/CLI import boundary violated:\n${violations.join('\n')}`);
});

test('boundary A regression: nested relative imports are recognized', () => {
  const HUB_IMPORT = /(?:from|import)\s+['"](?:(?:\.\.\/)+|\.\/)(hub|cli|add|untar)\.ts['"]/;
  assert.match("from './add.ts'", HUB_IMPORT);
  assert.match("from '../add.ts'", HUB_IMPORT);
  assert.match("from '../../untar.ts'", HUB_IMPORT);
  assert.match("import './cli.ts'", HUB_IMPORT);
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
 * grammar (`executor: 'agent'`) and `session` reads as plain English in
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
  for (const file of [...CORE_ALL, 'index.ts']) {
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


import { ROUTING_PROOF_CASE_IDS, ROUTING_PROOF_SCHEMA } from '../src/types.ts';
import type { ClaimReadyResult, ReadyFiring, RoutingProof, SnapshotReadyResult } from '../src/index.ts';
import { validateValue } from '../src/schema.ts';
import { createHash } from 'node:crypto';

// Explicitly synthetic schema fixtures. These do not claim a real execution,
// reviewed ref, launch or passing acceptance case.
function proofFixture(): RoutingProof {
  return { schema: 'routing-proof-v1', refs: { engine: 'a'.repeat(40), service: null, worker: null },
    artifacts: [{ path: 'fixture.json', sha256: createHash('sha256').update('{}').digest('hex') }],
    cases: ROUTING_PROOF_CASE_IDS.map(id => ({ id, executed: false, assertions: [], join: null })) };
}

test('routing proof schema freezes case IDs, refs, byte hashes, assertion results and joins', () => {
  const fixture = proofFixture();
  assert.equal(validateValue(ROUTING_PROOF_SCHEMA, fixture).valid, true);
  assert.equal(fixture.artifacts[0]!.sha256, '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  const executed = { ...fixture, cases: fixture.cases.map((c, i) => i === 0
    ? { ...c, executed: true, assertions: [{ name: 'fixture assertion', passed: false }],
      join: { decision: 'fixture-decision', claim: 'fixture-claim', order: 'fixture-order', attempt: 'fixture-attempt' } } : c) };
  assert.equal(validateValue(ROUTING_PROOF_SCHEMA, executed).valid, true, 'a recorded failure is valid evidence, not a pass');
  const bad = [
    { ...fixture, refs: { ...fixture.refs, engine: 'main' } },
    { ...fixture, artifacts: [{ path: 'fixture.json', sha256: 'unknown' }] },
    { ...fixture, cases: fixture.cases.slice(1) },
    { ...fixture, cases: fixture.cases.map(() => fixture.cases[0]) },
    { ...fixture, cases: fixture.cases.map((c, i) => i === 0 ? { ...c, id: 'invented' } : c) },
    { ...fixture, cases: fixture.cases.map((c, i) => i === 0 ? { ...c, assertions: [{ name: 'unrun', passed: true }] } : c) },
    { ...executed, cases: executed.cases.map((c, i) => i === 0 ? { ...c, assertions: [] } : c) },
    { ...executed, cases: executed.cases.map((c, i) => i === 0 ? { ...c, join: { decision: 'd', claim: 'c', order: 'o' } } : c) },
  ];
  for (const value of bad) assert.equal(validateValue(ROUTING_PROOF_SCHEMA, value).valid, false, JSON.stringify(value));
});

test('native ready identity and outcomes stay exhaustive through the pure public barrel', () => {
  const exactIdentity = {
    workflow: 'root', frameId: 'child', DefRef: { bundleDigest: 'a'.repeat(64), workflowName: 'work' },
    step: 'B', key: '', inputFingerprint: { seed: 2 }, admissionEpoch: 0, executorKind: 'agent',
    meaningDigest: 'b'.repeat(64), evidenceGeneration: 'c'.repeat(64), stateDigest: 'd'.repeat(64),
    resolved: { capabilities: ['scoped'], crews: ['crew'], matchModes: { scoped: 'exact' }, revision: 'r1' },
  } as const satisfies ReadyFiring;
  function outcome(result: ClaimReadyResult | SnapshotReadyResult): string {
    switch (result.kind) {
      case 'claimed': return result.order.run;
      case 'ready': return result.firings[0]?.frameId ?? 'empty';
      case 'unverified': return result.frameId;
      case 'inactive': case 'stale': case 'lane-unavailable': case 'invalid-plan': return result.kind;
      case 'deferred': return result.reason;
      default: { const exhaustive: never = result; return exhaustive; }
    }
  }
  assert.equal(outcome({ kind: 'ready', firings: [exactIdentity] }), 'child');
  for (const kind of ['inactive', 'stale', 'lane-unavailable', 'invalid-plan'] as const) assert.equal(outcome({ kind }), kind);
  assert.equal(outcome({ kind: 'unverified', frameId: 'child' }), 'child');
  assert.equal(outcome({ kind: 'deferred', reason: 'workdir-unresolved' }), 'workdir-unresolved');
  const index = readCore('index.ts').join('\n');
  for (const name of ['ReadyFiring', 'ClaimReadyResult', 'SnapshotReadyResult', 'ROUTING_PROOF_CASE_IDS', 'ROUTING_PROOF_SCHEMA']) {
    assert.ok(index.includes(name), `${name} must be exported`);
  }
  const order = readCore('types.ts').join('\n').split('export interface Order {')[1]!.split('\n}')[0]!;
  assert.equal(order.includes('readyClaim'), false, 'internal authority never extends the frozen Order');
});
