import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertRoutedAgentWorkdirDisjoint, planRoutedAgentWorkdir } from '../src/roles/routing-agent-workdir.ts';

test('routed agent without authored workdir gets Shift work root and original machine policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-agent-workdir-'));
  try {
    const privateBase = join(root, 'state', '.routing-definitions');
    const stage = join(privateBase, '.routing-def-abc123');
    const workRoot = join(root, 'work');
    mkdirSync(stage, { recursive: true });
    const prepared = planRoutedAgentWorkdir({ workRoot, workflow: 'wf', run: 'run',
      definitionStagePath: stage,
      originalEnv: { OWENLOOP_ALLOWED_WORKDIR_ROOTS: `${workRoot}:${join(root, 'other')}` },
      publicEnv: { HOME: join(stage, 'home'), OWENLOOP_CONFIG_DIR: join(stage, 'public') } });
    assert.equal(prepared.cwd, join(workRoot, 'wf', 'run'));
    assert.equal(existsSync(prepared.cwd), false);
    assert.equal(prepared.materialize(), prepared.cwd);
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
      assert.throws(() => planRoutedAgentWorkdir({ workRoot, workflow: 'wf', run: 'run',
	definitionStagePath: stage, originalEnv: {},
	publicEnv: { HOME: join(stage, 'home'), OWENLOOP_CONFIG_DIR: join(stage, 'public') } }), /refused/);
      assert.equal(existsSync(join(privateBase, 'wf')), false);
    }
    assert.throws(() => planRoutedAgentWorkdir({ workRoot: undefined,
      workflow: 'wf', run: 'run', definitionStagePath: stage, originalEnv: {},
      publicEnv: { HOME: join(stage, 'home'), OWENLOOP_CONFIG_DIR: join(stage, 'public') } }), /refused/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('routed git post-checkout hook runs only at materialize with public Owenloop credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'routing-agent-hook-'));
  try {
    const repo = join(root, 'repo');
    const stage = join(root, 'state', '.routing-definitions', '.routing-def-abc123');
    const workRoot = join(root, 'work');
    const marker = join(root, 'hook-env.txt');
    mkdirSync(repo);
    mkdirSync(stage, { recursive: true });
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git(['init', '-q']);
    writeFileSync(join(repo, 'README'), 'seed');
    git(['add', 'README']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'seed']);
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, '#!/bin/sh\nprintf "%s|%s|%s|%s|%s|%s\\n" "$OWENLOOP_TOKEN" "$OWENLOOP_ACCOUNT" "$OWENLOOP_CREDENTIAL_COMMAND" "$OWENLOOP_CONFIG_DIR" "$OWENLOOP_NO_KEYCHAIN" "$CLAUDE_CODE_OAUTH_TOKEN" > "$HOOK_MARKER"\n');
    chmodSync(hook, 0o700);
    const publicDir = join(stage, 'public');
    const plan = planRoutedAgentWorkdir({ workRoot, workRepo: repo,
      workflow: 'wf', run: 'run', definitionStagePath: stage,
      originalEnv: { PATH: process.env.PATH, HOME: join(root, 'operator'),
	OWENLOOP_TOKEN: 'operator-bearer', OWENLOOP_ACCOUNT: 'operator',
	OWENLOOP_CONFIG_DIR: join(root, 'operator-config'),
	OWENLOOP_CREDENTIAL_COMMAND: '/operator/get-token',
	CLAUDE_CODE_OAUTH_TOKEN: 'vendor-oauth', HOOK_MARKER: marker },
      publicEnv: { HOME: join(stage, 'home'), OWENLOOP_CONFIG_DIR: publicDir } });
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(plan.cwd), false);
    assert.equal(plan.materialize(), plan.cwd);
    assert.equal(existsSync(plan.cwd), true);
    assert.equal(readFileSync(marker, 'utf8').trim(), `|||${publicDir}|1|vendor-oauth`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
