/**
 * CI check 3 from the one-command plugin plan: every MCP manifest in this
 * repository must launch the PATH CLI rather than a version-pinned package.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const PRUNED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.dev']);

function findMcpManifests(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!PRUNED_DIRECTORIES.has(entry.name)) found.push(...findMcpManifests(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name === '.mcp.json') {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

test('no .mcp.json carries npx or a version-pinned package launch', () => {
  const found = findMcpManifests(ROOT);
  assert.ok(found.length >= 2, `expected at least two manifests, found ${found.length}`);

  const relativePaths = new Set(found.map((file) => relative(ROOT, file)));
  for (const expected of [
    'plugins/claude-code/plugin/.mcp.json',
    'plugins/codex/plugins/owenloop/.mcp.json',
  ]) {
    assert.ok(relativePaths.has(expected), `${expected} must be included in the repository walk`);
  }

  for (const file of found) {
    const where = relative(ROOT, file);
    const raw = readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, /npx/, `${where} must not invoke npx`);
    assert.doesNotMatch(raw, /@\^/, `${where} must not contain a caret package range`);
    assert.doesNotMatch(raw, /@~/, `${where} must not contain a tilde package range`);

    const parsed: unknown = JSON.parse(raw);
    assert.ok(isRecord(parsed), `${where} must contain a JSON object`);
    const servers = parsed['mcpServers'];
    assert.ok(isRecord(servers), `${where} must contain an mcpServers object`);
    for (const [name, server] of Object.entries(servers)) {
      assert.ok(isRecord(server), `${where} server ${name} must be an object`);
      assert.notEqual(server['command'], 'npx', `${where} server ${name} must not use npx`);
      const args = server['args'];
      if (!Array.isArray(args)) continue;
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        const at = arg.indexOf('@');
        assert.ok(at <= 0, `${where} server ${name} has a version-bearing argument: ${arg}`);
      }
    }
  }
});
