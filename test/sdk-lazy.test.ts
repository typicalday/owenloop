/**
 * The published CLI must keep the optional model SDK out of ordinary cold starts.
 * A Node ESM loader records package resolution in a child process, so this tests
 * the real compiled binary rather than the in-process TypeScript entry point.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'owenloop.mjs');
const LOADER = join(import.meta.dirname, 'sdk-resolution-loader.mjs');

function childEnv(dir: string, trace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    OWENLOOP_DB: join(dir, 'state.db'),
    OWENLOOP_DEFS: join(dir, 'defs'),
    OWENLOOP_SDK_TRACE: trace,
  };
}

function runWithLoader(dir: string, trace: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--loader', LOADER, BIN, ...args], {
    cwd: dir,
    env: childEnv(dir, trace),
    encoding: 'utf8',
  });
}

function traceFor(trace: string): string {
  return readFileSync(trace, 'utf8');
}

test('ordinary status and cheap work commands do not resolve the model SDK', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-sdk-lazy-'));
  const defs = join(dir, 'defs');
  const trace = join(dir, 'sdk-resolutions.log');
  mkdirSync(defs);
  writeFileSync(trace, '', 'utf8');

  const status = runWithLoader(dir, trace, ['status', '--all']);
  assert.equal(status.status, 0, `status --all failed: ${status.stderr}`);
  assert.deepEqual(JSON.parse(String(status.stdout)), [], 'a fresh temp state has an empty fleet');
  assert.equal(traceFor(trace), '', 'status --all must not resolve the model SDK');

  const settings = runWithLoader(dir, trace, ['work', 'settings']);
  assert.equal(settings.status, 0, `work settings failed: ${settings.stderr}`);
  assert.equal(traceFor(trace), '', 'work settings must not resolve the model SDK');
});

test('the loader trace detects an explicit model SDK import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-sdk-positive-'));
  const trace = join(dir, 'sdk-resolutions.log');
  writeFileSync(trace, '', 'utf8');

  const child = spawnSync(
    process.execPath,
    ['--loader', LOADER, '--input-type=module', '--eval', "await import('@anthropic-ai/claude-agent-sdk')"],
    { cwd: ROOT, env: { ...process.env, OWENLOOP_SDK_TRACE: trace }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, `explicit SDK import failed: ${child.stderr}`);
  assert.match(traceFor(trace), /@anthropic-ai\/claude-agent-sdk/);
});
