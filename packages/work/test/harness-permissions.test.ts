import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeStepPermissions } from '../src/harness/permissions.ts';
import type { FetchedStep } from '../src/bundle/types.ts';

const fixture = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), 'utf8');

const DEMO = JSON.parse(fixture('demo-def.json')) as { hash: string; steps: FetchedStep[] };

const stepByName = (name: string): FetchedStep => {
  const s = DEMO.steps.find((x) => x.name === name);
  assert.ok(s, `fixture step ${name}`);
  return s!;
};

/** Extract the harness bag the way a caller must — the CALLER owns the bag key,
 *  never `normalizeStepPermissions` (that is what keeps a vendor name out of
 *  `src/harness/`). The fixture's steps carry their bag under `x.harness`. */
const bagOf = (step: FetchedStep): Record<string, unknown> | undefined => {
  const x = step.x as Record<string, unknown> | undefined;
  const bag = x?.['harness'];
  return bag !== undefined && typeof bag === 'object' && bag !== null && !Array.isArray(bag)
    ? (bag as Record<string, unknown>)
    : undefined;
};

test('a full bag: neutral fields are lifted, the rest lands verbatim in extensions', () => {
  const step = stepByName('builder');
  const got = normalizeStepPermissions(bagOf(step), step);

  assert.deepEqual(got.tools, ['Read', 'Edit', 'Bash']);
  assert.equal(got.permissionMode, 'plan');
  assert.equal(got.maxTurns, 40);
  assert.equal(got.model, 'opus', "the step's first-class model");
  assert.equal(got.effort, undefined);
  assert.equal(got.disallowedTools, undefined);
  // The one non-neutral key in this bag rides extensions untouched.
  assert.deepEqual(got.extensions, { mcpServers: { extra: { command: 'extra-server' } } });
  // Lifted keys never double up in extensions.
  for (const k of ['tools', 'permissionMode', 'maxTurns', 'model', 'effort', 'disallowedTools']) {
    assert.equal(k in got.extensions, false, `${k} must not appear in extensions`);
  }
});

test('an empty bag normalizes to just an empty extensions map', () => {
  const step = stepByName('reviewer');
  assert.deepEqual(normalizeStepPermissions(bagOf(step), step), { extensions: {} });
});

test('a step with no bag at all normalizes to an empty struct, and carries a step model when present', () => {
  const step = stepByName('planner');
  assert.equal(bagOf(step), undefined, 'the planner fixture step deliberately has no bag');
  assert.deepEqual(normalizeStepPermissions(bagOf(step), step), { extensions: {} });
  assert.deepEqual(normalizeStepPermissions(undefined, { model: 'sonnet' }), {
    extensions: {},
    model: 'sonnet',
  });
  // No step argument at all is also legal.
  assert.deepEqual(normalizeStepPermissions(undefined), { extensions: {} });
});

test('tools accept a comma string as well as an array, trimmed, empties dropped', () => {
  const got = normalizeStepPermissions({ tools: ' Read , Edit ,, Bash ', disallowedTools: 'Write' });
  assert.deepEqual(got.tools, ['Read', 'Edit', 'Bash']);
  assert.deepEqual(got.disallowedTools, ['Write']);
});

test('an empty tool list omits the key entirely rather than emitting []', () => {
  const got = normalizeStepPermissions({ tools: '  ,  ', disallowedTools: [] });
  assert.equal('tools' in got, false);
  assert.equal('disallowedTools' in got, false);
});

test('non-string entries are dropped from a tools array', () => {
  const got = normalizeStepPermissions({ tools: ['Read', 42, null, 'Edit'] });
  assert.deepEqual(got.tools, ['Read', 'Edit']);
});

test("the step's first-class model beats a bag model", () => {
  const got = normalizeStepPermissions({ model: 'haiku' }, { model: 'opus' });
  assert.equal(got.model, 'opus');
  // and with no step model, the bag model stands.
  assert.equal(normalizeStepPermissions({ model: 'haiku' }).model, 'haiku');
  assert.equal(normalizeStepPermissions({ model: 'haiku' }, {}).model, 'haiku');
});

test('maxTurns survives only as a positive integer', () => {
  assert.equal(normalizeStepPermissions({ maxTurns: 40 }).maxTurns, 40);
  for (const bad of [0, -1, 1.5, 'x', null, true]) {
    const got = normalizeStepPermissions({ maxTurns: bad });
    assert.equal('maxTurns' in got, false, `maxTurns: ${JSON.stringify(bad)} must be dropped`);
    assert.equal('maxTurns' in got.extensions, false, 'a dropped neutral field never falls into extensions');
  }
});

test('permissionMode, model and effort are kept verbatim and unvalidated, but only when non-empty strings', () => {
  const got = normalizeStepPermissions({ permissionMode: 'notAMode', effort: 'high', model: 'whatever' });
  assert.equal(got.permissionMode, 'notAMode');
  assert.equal(got.effort, 'high');
  assert.equal(got.model, 'whatever');

  const empty = normalizeStepPermissions({ permissionMode: '', effort: '', model: '' });
  assert.deepEqual(empty, { extensions: {} });
});

test('name and description are stripped and never reach extensions', () => {
  const got = normalizeStepPermissions({ name: 'mine', description: 'mine too', color: 'blue' });
  assert.deepEqual(got.extensions, { color: 'blue' });
});

test('an unknown key rides extensions verbatim (lossless by construction)', () => {
  const got = normalizeStepPermissions({
    hooks: { pre: 'x' },
    memory: 'project',
    skills: ['a'],
    isolation: 'worktree',
    background: true,
    initialPrompt: 'go',
    somethingNobodyKnows: { deep: [1, 2] },
  });
  assert.deepEqual(got.extensions, {
    hooks: { pre: 'x' },
    memory: 'project',
    skills: ['a'],
    isolation: 'worktree',
    background: true,
    initialPrompt: 'go',
    somethingNobodyKnows: { deep: [1, 2] },
  });
});

test('a malformed bag normalizes to an empty struct and never throws', () => {
  for (const bad of [undefined, null, [], 'nope', 42, true]) {
    const got = normalizeStepPermissions(bad as Record<string, unknown> | undefined);
    assert.deepEqual(got, { extensions: {} }, `bag ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(normalizeStepPermissions([] as unknown as Record<string, unknown>, { model: 'opus' }), {
    extensions: {},
    model: 'opus',
  });
});

test('the input bag is not mutated', () => {
  const bag: Record<string, unknown> = {
    tools: ['Read'],
    name: 'mine',
    maxTurns: 40,
    mcpServers: { extra: { command: 'x' } },
  };
  const before = JSON.parse(JSON.stringify(bag)) as Record<string, unknown>;
  normalizeStepPermissions(bag, { model: 'opus' });
  assert.deepEqual(bag, before);
});
