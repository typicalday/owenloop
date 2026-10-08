import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateRoutedFileCache } from '../src/hub/routed-file-cache.ts';
import { buildClaudeOptions } from '../src/harness/claude.ts';
import { buildThreadResumeParams, buildThreadStartParams } from '../src/harness/codex.ts';
import { normalizeStepPermissions } from '../src/harness/permissions.ts';

async function fixture(run: (x: { cwd: string; root: string; custody: string; file: string;
  stage: string; sibling: string }) => Promise<void> | void): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'ol-rfc-test-'));
  chmodSync(base, 0o700);
  const cwd = join(base, 'work');
  mkdirSync(cwd, { mode: 0o700 });
  const cache = allocateRoutedFileCache(base);
  const file = join(cache.publishedRoot, 'a'.repeat(32));
  writeFileSync(file, 'verified bytes', { mode: 0o400 });
  const stage = join(cache.custodyRoot, 'staging', 'b'.repeat(32));
  writeFileSync(stage, 'unverified bytes', { mode: 0o600 });
  const sibling = join(base, 'unrelated');
  writeFileSync(sibling, 'other', { mode: 0o400 });
  try { await run({ cwd, root: cache.publishedRoot, custody: cache.custodyRoot, file, stage, sibling }); }
  finally { await cache.cleanup(); rmSync(base, { recursive: true, force: true }); }
}

test('Codex routed mount exposes the file tool only with an isolated verified root', async () => {
  await fixture(({ cwd, root }) => {
    const base = {
      brief: 'read input', cwd,
      owenloopMcp: { command: 'owenloop', args: ['work', 'hold', '--routing-holder', '/private/handoff'] },
      permissions: normalizeStepPermissions({}),
    };
    const ordinary = buildThreadStartParams(base);
    const routed = buildThreadStartParams({ ...base, verifiedFileCacheRoot: root });
    for (const params of [routed, buildThreadResumeParams('cold', { ...base, verifiedFileCacheRoot: root })]) {
      const config = params['config'] as { mcp_servers: { owenloop: { enabled_tools: string[] } };
		sandbox_workspace_write?: { writable_roots?: string[] } };
      assert.ok(config.mcp_servers.owenloop.enabled_tools.includes('get_file_artifact'));
      assert.ok(!config.sandbox_workspace_write?.writable_roots?.includes(root));
      assert.notEqual(params['sandbox'], 'danger-full-access');
    }
    const normal = (ordinary['config'] as { mcp_servers: { owenloop: { enabled_tools: string[] } } })
      .mcp_servers.owenloop.enabled_tools;
    assert.ok(!normal.includes('get_file_artifact'));
    assert.throws(() => buildThreadStartParams({ ...base, verifiedFileCacheRoot: root,
      owenloopMcp: { command: 'owenloop', args: ['work', 'hold'] } }), /routed holder/);
    assert.throws(() => buildThreadStartParams({ ...base, verifiedFileCacheRoot: root,
      permissions: normalizeStepPermissions({ sandbox: 'danger-full-access' }) }), /read-only sandbox root/);
    assert.throws(() => buildThreadStartParams({ ...base, verifiedFileCacheRoot: root,
      permissions: normalizeStepPermissions({ codexConfig: { sandbox_workspace_write: {
		writable_roots: [root],
      } } }) }), /writable roots/);
  });
});

test('Claude routed Read can open only a complete immutable file; other paths and writes refuse', async () => {
  await fixture(async ({ cwd, root, file, stage, sibling }) => {
    const options = buildClaudeOptions({
      cwd, owenloopMcp: { command: 'owenloop', args: ['work', 'hold', '--routing-holder', '/private/handoff'] },
      permissions: normalizeStepPermissions({ tools: ['Read', 'Glob', 'Grep'] }),
      exactWorkdir: true, verifiedFileCacheRoot: root,
    }, { env: {}, abortController: new AbortController(), onEvent: () => {} });
    const mount = (options.mcpServers as Record<string, { args: string[] }>)['owenloop']!;
    assert.ok(mount.args.join(' ').includes('get_file_artifact'));
    assert.ok(options.allowedTools?.includes('mcp__owenloop__get_file_artifact'));
    const call = (name: string, path: string) => options.canUseTool!(name, { file_path: path }, {
      signal: new AbortController().signal, toolUseID: 'tool_fixture', requestId: 'req_fixture',
    });
    assert.equal((await call('Read', file))?.behavior, 'allow');
    for (const path of [stage, sibling, join(root, 'missing'), join(root, 'verified.tmp')]) {
      assert.equal((await call('Read', path))?.behavior, 'deny');
    }
    assert.equal((await call('Write', file))?.behavior, 'deny');
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const decision = async (name: string, path: string) => (await hook({
      hook_event_name: 'PreToolUse', tool_name: name, tool_input: { file_path: path }, tool_use_id: 'tool_fixture',
    } as never, undefined, { signal: new AbortController().signal }) as {
      hookSpecificOutput?: { permissionDecision?: string };
    }).hookSpecificOutput?.permissionDecision;
    assert.equal(await decision('Read', file), 'allow');
    for (const path of [stage, sibling]) assert.equal(await decision('Read', path), 'deny');
    const link = join(root, 'c'.repeat(32));
    symlinkSync(file, link);
    assert.equal(await decision('Read', link), 'deny');
    assert.equal(await decision('Write', file), 'deny');
  });
});

test('cache custody refuses a shared or substituted base before exposing an adapter path', async () => {
  const shared = mkdtempSync(join(tmpdir(), 'ol-rfc-shared-'));
  chmodSync(shared, 0o777);
  try { assert.throws(() => allocateRoutedFileCache(shared), /base is not private/); }
  finally { rmSync(shared, { recursive: true, force: true }); }
});
