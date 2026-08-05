import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run } from '../src/roles/settings.ts';

// Every fixture materializes its OWN temp HOME/XDG — never the real one.

/** Run the settings role capturing stdout/stderr lines and the exit code. */
async function runRole(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Create a temp XDG root holding the given settings.json contents. */
function xdgWith(contents: string): string {
  const xdg = mkdtempSync(join(tmpdir(), 'owenloop-settings-role-'));
  mkdirSync(join(xdg, 'owenloop'), { recursive: true });
  writeFileSync(join(xdg, 'owenloop', 'settings.json'), contents);
  return xdg;
}

test('prints path, exists:no, and defaults when no file exists (exit 0)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-settings-role-'));
  try {
    const { code, out } = await runRole([], { HOME: home });
    assert.equal(code, 0);
    assert.match(out, /settings file: .*owenloop[/\\]settings\.json/);
    assert.match(out, /exists: no/);
    // Knobs with a built-in default print it; the rest print (unset).
    assert.match(out, /dispatchCap = 3 {2}\(default\)/);
    assert.match(out, /commandRouting = shift {2}\(default\)/);
    assert.match(out, /defPolicy = warn {2}\(default\)/);
    assert.match(out, /hubOrigin = \(unset\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('prints each known knob with its value + (settings) provenance', async () => {
  const xdg = xdgWith(
    JSON.stringify({
      hubOrigin: 'https://hub.example',
      dispatchCap: 5,
      commandRouting: 'manual',
      defPolicy: 'enforce',
      maxConcurrentAgents: 2,
    }),
  );
  try {
    const { code, out } = await runRole([], { XDG_CONFIG_HOME: xdg });
    assert.equal(code, 0);
    assert.match(out, /exists: yes/);
    assert.match(out, /hubOrigin = https:\/\/hub\.example {2}\(settings\)/);
    assert.match(out, /dispatchCap = 5 {2}\(settings\)/);
    assert.match(out, /commandRouting = manual {2}\(settings\)/);
    assert.match(out, /defPolicy = enforce {2}\(settings\)/);
    assert.match(out, /maxConcurrentAgents = 2 {2}\(settings\)/);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('surfaces unrecognized keys without failing (exit 0)', async () => {
  const xdg = xdgWith(JSON.stringify({ hubOrigin: 'https://h', typo: 1, huh: 'x' }));
  try {
    const { code, out } = await runRole([], { XDG_CONFIG_HOME: xdg });
    assert.equal(code, 0);
    assert.match(out, /unrecognized keys .*: (typo, huh|huh, typo)/);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('exits 1 on malformed JSON, naming the file on stderr', async () => {
  const xdg = xdgWith('{ not json');
  try {
    const { code, err } = await runRole([], { XDG_CONFIG_HOME: xdg });
    assert.equal(code, 1);
    assert.match(err, /malformed settings file/);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('exits 1 on an invalid known-key type', async () => {
  const xdg = xdgWith(JSON.stringify({ dispatchCap: -3 }));
  try {
    const { code, err } = await runRole([], { XDG_CONFIG_HOME: xdg });
    assert.equal(code, 1);
    assert.match(err, /'dispatchCap' must be a positive integer/);
  } finally {
    rmSync(xdg, { recursive: true, force: true });
  }
});

test('exits 2 on a stray argument', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-settings-role-'));
  try {
    const { code, err } = await runRole(['extra'], { HOME: home });
    assert.equal(code, 2);
    assert.match(err, /unexpected argument 'extra'/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
