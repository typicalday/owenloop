import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveModifierInit } from '../src/util/modifier-init.ts';

test('modifier-init resolves requested feedback before the modifier hint and default', () => {
  const result = resolveModifierInit(
    ['--default', 'standard'],
    {
      OWENLOOP_MODIFIER: 'express',
      OWENLOOP_FEEDBACK: JSON.stringify([{
        path: 'modifier',
        reasons: [{ requested: 'deep' }],
      }]),
    },
  );
  assert.deepEqual(result, { value: 'deep' });
});

test('modifier-init falls back from hint to default and supports feedback files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-modifier-init-'));
  try {
    const file = join(dir, 'feedback.json');
    writeFileSync(file, JSON.stringify([{ reasons: [{ requested: 'deep' }] }]));
    assert.deepEqual(
      resolveModifierInit(['--default', 'standard'], { OWENLOOP_FEEDBACK_FILE: file, OWENLOOP_MODIFIER: 'express' }),
      { value: 'deep' },
    );
    assert.deepEqual(
      resolveModifierInit(['--default', 'standard'], { OWENLOOP_MODIFIER: 'express' }),
      { value: 'express' },
    );
    assert.deepEqual(resolveModifierInit(['--default', 'standard'], {}), { value: 'standard' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modifier-init requires a default and refuses non-word output', () => {
  assert.deepEqual(resolveModifierInit([], {}), { error: 'missing required option: --default', usage: true });
  assert.deepEqual(resolveModifierInit(['--default', 'two words'], {}), { error: 'resolved modifier must be a single word' });
});
