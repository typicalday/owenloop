/**
 * PHASE 6, ITEM 2 — the repo-wide vendor gate.
 *
 * THE RULE: no file that ships as owenloop work's runtime may name a harness vendor,
 * except the small, enumerated set of files that legitimately must.
 *
 * ── SCOPE IS A DECISION, NOT AN OVERSIGHT ────────────────────────────────────
 *
 * The gate walks the files under `packages/work/src/` and the root `bin/` that git
 * would ship — tracked plus untracked-but-not-ignored (see `shippedFiles`) — and
 * nothing else. Those directories are the transplanted published runtime surface. Everything else in the
 * repo names vendors legitimately and is deliberately out of scope:
 *
 *   - `README.md` and `docs/` document which harnesses exist and how to log into
 *     them. A gate over prose would be a gate against documentation.
 *   - `package.json` / `package-lock.json` depend on the vendor SDK by its real
 *     package name; there is no version of this rule under which that is wrong.
 *   - `harness-versions.json` IS the vendor version pin file.
 *   - `test/` exercises the adapters by name, including this file.
 *
 * The redesign plan's original wording for this item was "fail if any file
 * outside `src/harness/` matches". Taken literally that is unimplementable —
 * roughly twenty tracked files outside `src/harness/` match — so the enforced
 * scope is stated here instead of silently narrowed somewhere else.
 *
 * ── RELATIONSHIP TO `test/harness-isolation.test.ts` ─────────────────────────
 *
 * The two gates are complements and both stay:
 *   - `harness-isolation.test.ts` polices INSIDE `src/harness/` — no neutral
 *     file in the harness layer may name a vendor.
 *   - this file polices the REST of the shipped source.
 *
 * `VENDOR_RE` below is a deliberate DUPLICATE of the literal in that file rather
 * than a shared import: two independent copies mean neither gate can be
 * weakened by an edit aimed at the other.
 *
 * ── WHY THERE ARE TWO ASSERTIONS ─────────────────────────────────────────────
 *
 * Assertion 1 is the gate itself. Assertion 2 says every allowlisted path still
 * EXISTS and still MATCHES the regex. Together they make adding a vendor-naming
 * file a deliberate act: the only way to add one is to edit the allowlist, and
 * the only way to edit the allowlist without breaking assertion 2 is to point it
 * at a file that genuinely names a vendor. A stale entry — the vendor name was
 * removed, or the file was deleted — fails rather than rotting silently.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultHarnessId } from '../src/harness/registry.ts';
import '../src/harnesses.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** The SAME literal `test/harness-isolation.test.ts` uses. Duplicated on
 *  purpose — see this file's header. */
const VENDOR_RE = /claude|codex|anthropic|openai/i;

/** The directories that become the published runtime. */
const SCOPE = ['packages/work/src', 'bin'];

/**
 * Every file under `src/`/`bin/` that may name a harness vendor, by full
 * repo-relative, `/`-separated path — with the reason, because an entry with no
 * reason is an entry nobody can review.
 */
const ALLOWLIST = new Map<string, string>([
  ['packages/work/src/harness/claude.ts', 'the Claude Code adapter module itself'],
  ['packages/work/src/harness/codex.ts', 'the Codex adapter module itself'],
  [
    'packages/work/src/bundle/fetch.ts',
    "LEGACY_BAG_KEY — the dead on-the-wire step-extension key, kept so the parser can " +
      'reject a def written to the old grammar by name. Data, not behavior; its own ' +
      'doc-comment asks to be allowlisted here rather than deleted.',
  ],
  [
    'packages/work/src/harnesses.ts',
    'the single composition root — the one file that imports the adapter modules, ' +
      'and therefore the one file that fixes the default harness',
  ],
]);

/**
 * Regular files under `src/` and `bin/` that git would ship: tracked
 * (`--cached`) PLUS untracked-but-not-ignored (`--others --exclude-standard`).
 *
 * The second half matters. `git ls-files` alone lists only tracked paths, so a
 * brand-new vendor-naming file would pass this gate on the author's machine
 * right up until they staged it — the gate would fire in CI, one round trip
 * later, on a change the author thought was clean. Including not-yet-added files
 * makes the local run and the CI run answer the same question.
 * `--deduplicate` because a path can appear in both lists.
 */
function shippedFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate', '--', ...SCOPE],
    { cwd: REPO, encoding: 'utf8' },
  );
  return out
    .split('\0')
    .filter((p) => p !== '')
    .map((p) => p.split('\\').join('/'))
    // A path `git ls-files` reports but the working tree no longer has (a
    // staged deletion mid-edit) is not this gate's business.
    .filter((rel) => existsSync(join(REPO, rel)) && statSync(join(REPO, rel)).isFile());
}

const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

test('the walk actually finds the shipped source (a path typo cannot make this vacuous)', () => {
  const files = shippedFiles();
  assert.ok(files.length > 10, `expected many files under ${SCOPE.join('/')}, got ${files.length}`);
  assert.ok(
    files.includes('packages/work/src/main.ts') && files.includes('bin/owenloop.mjs'),
    'expected the CLI entry points in the walked set',
  );
});

test('no shipped source file outside the allowlist names a harness vendor', () => {
  const offenders: string[] = [];
  for (const rel of shippedFiles()) {
    if (ALLOWLIST.has(rel)) continue;
    const match = VENDOR_RE.exec(read(rel));
    if (match !== null) offenders.push(`${rel}: '${match[0]}'`);
  }
  assert.deepEqual(
    offenders,
    [],
    'a vendor name in shipped source leaks a harness into neutral code — remove the ' +
      'mention, move the behavior behind the adapter contract, or (deliberately) add ' +
      'the file to ALLOWLIST in this test with a reason',
  );
});

test('every allowlist entry still exists and still names a vendor (the list cannot rot)', () => {
  const shipped = new Set(shippedFiles());
  const stale: string[] = [];
  for (const [rel, why] of ALLOWLIST) {
    if (!shipped.has(rel)) {
      stale.push(`${rel}: allowlisted but is no longer a file git would ship (${why})`);
      continue;
    }
    if (!VENDOR_RE.test(read(rel))) {
      stale.push(`${rel}: allowlisted but no longer names a vendor — drop the entry (${why})`);
    }
  }
  assert.deepEqual(stale, [], 'a stale allowlist entry silently widens the gate');
});

/**
 * PHASE 6 — the consolidation guard.
 *
 * `defaultHarnessId()` returns whichever adapter registered FIRST, and adapter
 * import order now lives in exactly one file (`src/harnesses.ts`). This pins the
 * resulting default so an accidental reorder of that block — which would change
 * which harness runs a step that names none, and which harness `owenloop work lint`
 * judges such a step by — fails a test instead of shipping.
 */
test('the single composition root keeps claude-code as the default harness', () => {
  assert.equal(defaultHarnessId(), 'claude-code');
});
