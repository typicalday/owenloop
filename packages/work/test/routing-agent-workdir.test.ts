import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertRoutedAgentWorkdirDisjoint, prepareRoutedAgentWorkdir } from '../src/roles/routing-agent-workdir.ts';

test('routed agent without authored workdir gets Shift work root and original machine policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-agent-workdir-'));
  try {
    const privateBase = join(root, 'state', '.routing-definitions');
    const stage = join(privateBase, '.routing-def-abc123');
    const workRoot = join(root, 'work');
    mkdirSync(stage, { recursive: true });
    const prepared = prepareRoutedAgentWorkdir({ workRoot, workflow: 'wf', run: 'run',
      definitionStagePath: stage,
      originalEnv: { OWENLOOP_ALLOWED_WORKDIR_ROOTS: `${workRoot}:${join(root, 'other')}` } });
    assert.equal(prepared.cwd, join(workRoot, 'wf', 'run'));
    assert.equal(existsSync(prepared.cwd), true);
    assert.deepEqual(prepared.allowedWorkdirRoots, [workRoot, join(root, 'other')]);
    assertRoutedAgentWorkdirDisjoint(join(root, 'project'), privateBase);
    assert.throws(() => assertRoutedAgentWorkdirDisjoint(stage, privateBase), /refused/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('routed fallback refuses stage-adjacent root and symlinked ancestor before creating work', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-agent-workdir-'));
  try {
    const privateBase = join(root, 'state', '.routing-definitions');
    const stage = join(privateBase, '.routing-def-abc123');
    mkdirSync(stage, { recursive: true });
    for (const workRoot of [privateBase, join(root, 'alias')]) {
      if (workRoot.endsWith('alias')) symlinkSync(privateBase, workRoot);
      assert.throws(() => prepareRoutedAgentWorkdir({ workRoot, workflow: 'wf', run: 'run',
	definitionStagePath: stage, originalEnv: {} }), /refused/);
      assert.equal(existsSync(join(privateBase, 'wf')), false);
    }
    assert.throws(() => prepareRoutedAgentWorkdir({ workRoot: undefined,
      workflow: 'wf', run: 'run', definitionStagePath: stage, originalEnv: {} }), /refused/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
