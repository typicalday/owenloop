/**
 * Hermetic config-shape assertions for the Claude Code and Codex driver packs'
 * static files (plain `node:test` — no Cloudflare bindings, no `workerd`).
 *
 * IMPORTANT SCOPE LIMIT: these tests only assert that the packs' static
 * config is internally consistent (e.g. the agent frontmatter's `tools:`
 * allowlist is exactly the governed set; `.mcp.json` entries carry no
 * credential, per the OAuth-default contract). They do NOT prove Claude Code or Codex actually
 * resolves the plugin, installs the marketplace, or namespaces its tools the
 * way it really behaves at runtime — that live verification is exactly what
 * `docs/runbooks/claude-code-driver-check.md` (semi-manual, never CI) is
 * for. Do not mistake a passing test here for a live proof.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dirname, '..');

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf8'));
}

function readText(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

/** Splits a Markdown file with YAML frontmatter (`---\n...\n---\n`) into
 *  the parsed frontmatter object and the remaining Markdown body. */
function parseFrontmatter(markdown: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!match) throw new Error('no YAML frontmatter block found');
  const [, frontmatterYaml, body] = match;
  return { data: parseYaml(frontmatterYaml!) as Record<string, unknown>, body: body! };
}

/** Parse a comma-separated `tools:`/`allowed-tools:` frontmatter scalar into a
 *  trimmed, non-empty token list. Scoped tokens like `Bash(owenwork:*)` carry
 *  no top-level comma, so a plain comma split is safe. */
function splitToolList(field: unknown): string[] {
  return String(field)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Recursively list every file (not directory) under `dir`, absolute paths. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const GOVERNED_HUB_WORKER_TOOLS = [
  'mcp__plugin_owenloop_owenloop__submit',
  'mcp__plugin_owenloop_owenloop__get_status',
  'mcp__owenloop__submit',
  'mcp__owenloop__get_status',
  'WebSearch',
  'WebFetch',
  'Read',
  'Bash',
];

/** conduct's governed `allowed-tools` set (order-insensitive). The skill
 *  uses only the merged CLI, so the Claude Code frontmatter grants one
 *  tightly scoped Bash prefix. */
const CONDUCT_ALLOWED_TOOLS = ['Bash(owenloop:*)'];

/** author's governed `allowed-tools` set (order-insensitive). */
const AUTHOR_ALLOWED_TOOLS = [
  'mcp__plugin_owenloop_owenloop__create_workflow',
  'mcp__plugin_owenloop_owenloop__start_run',
  'mcp__owenloop__create_workflow',
  'mcp__owenloop__start_run',
];

/** shift's governed `allowed-tools` set (order-insensitive). The skill
 *  uses only the merged CLI, so the Claude Code frontmatter grants one
 *  tightly scoped Bash prefix. */
const SHIFT_ALLOWED_TOOLS = ['Bash(owenloop:*)'];

test('plugin.json parses and has name "owenloop"', () => {
  const plugin = readJson('plugins/claude-code/plugin/.claude-plugin/plugin.json') as { name: string };
  assert.equal(plugin.name, 'owenloop');
});

test('Claude Code plugin.json version equals the package.json version (§7 check 1)', () => {
  const pkg = readJson('package.json') as { version: string };
  const plugin = readJson('plugins/claude-code/plugin/.claude-plugin/plugin.json') as { version: string };
  assert.equal(plugin.version, pkg.version);
});

test('Codex plugin.json version equals the package.json version (§7 check 2)', () => {
  const pkg = readJson('package.json') as { version: string };
  const plugin = readJson('plugins/codex/plugins/owenloop/.codex-plugin/plugin.json') as { version: string };
  assert.equal(plugin.version, pkg.version);
});

test('marketplace.json parses, has exactly one plugin entry, and its source resolves INSIDE the marketplace root (CC v2.1.201 rejects sources that escape it)', () => {
  const marketplace = readJson('plugins/claude-code/.claude-plugin/marketplace.json') as {
    name: string;
    plugins: Array<{ name: string; source: string }>;
  };
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0]!;
  assert.equal(entry.name, 'owenloop');

  // Claude Code resolves a marketplace entry's `source` relative to the
  // marketplace ROOT (the directory containing `.claude-plugin/`), and
  // v2.1.201 refuses any source that escapes that root ("This plugin uses
  // a source type your Claude Code version does not support"). Assert
  // containment, existence, and a valid plugin manifest — the assertion
  // that would have caught the old `../plugin`.
  const marketplaceRootDir = resolve(ROOT, 'plugins/claude-code');
  const resolvedSourceDir = resolve(marketplaceRootDir, entry.source);

  // (b) contained within the marketplace root — rejects any `../` escape
  const rel = relative(marketplaceRootDir, resolvedSourceDir);
  assert.equal(rel.startsWith('..'), false);
  assert.equal(isAbsolute(rel), false);

  // (a) the resolved source exists and is a directory
  assert.equal(statSync(resolvedSourceDir).isDirectory(), true);

  // (c) it contains a valid plugin manifest
  const pluginManifest = JSON.parse(
    readFileSync(resolve(resolvedSourceDir, '.claude-plugin/plugin.json'), 'utf8'),
  ) as { name: string };
  assert.equal(pluginManifest.name, 'owenloop');
});

const MCP_MANIFESTS = [
  {
    harness: 'Claude Code',
    path: 'plugins/claude-code/plugin/.mcp.json',
    raw: readText('plugins/claude-code/plugin/.mcp.json'),
    config: readJson('plugins/claude-code/plugin/.mcp.json') as {
      mcpServers: Record<string, Record<string, unknown>>;
    },
  },
  {
    harness: 'Codex',
    path: 'plugins/codex/plugins/owenloop/.mcp.json',
    raw: readText('plugins/codex/plugins/owenloop/.mcp.json'),
    config: readJson('plugins/codex/plugins/owenloop/.mcp.json') as {
      mcpServers: Record<string, Record<string, unknown>>;
    },
  },
] as const;

test('both .mcp.json plugin versions equal the package.json version (§7 check 9)', () => {
  const pkg = readJson('package.json') as { version: string };
  for (const { harness, config } of MCP_MANIFESTS) {
    const owenloop = config.mcpServers['owenloop']!;
    const env = owenloop['env'] as Record<string, unknown>;
    assert.equal(env['OWENLOOP_PLUGIN_VERSION'], pkg.version, `${harness} plugin version`);
  }
});

/**
 * Both harnesses expose one PATH-resolved `owenloop mcp` entry. The Claude Code
 * manifest is stdio-shaped; Codex adds its environment-name allowlist. The
 * shared assertions below keep both manifests free of credentials and retired
 * launch forms.
 */

for (const { harness, config } of MCP_MANIFESTS) {
  test(`${harness} .mcp.json declares exactly one server: the owenloop control plane (INV-41)`, () => {
    // Asserted as an array, not a Set — this pins the NAME and the COUNT, so
    // re-adding a second server fails loudly rather than silently passing.
    assert.deepEqual(Object.keys(config.mcpServers), ['owenloop']);
  });
}

test('Claude Code .mcp.json owenloop entry uses the PATH CLI and only the plugin version env (INV-38)', () => {
  const owenloop = MCP_MANIFESTS[0]!.config.mcpServers['owenloop']!;
  assert.equal(owenloop['type'], 'stdio');
  assert.equal(owenloop['command'], 'owenloop');
  assert.deepEqual(owenloop['args'], ['mcp']);
  assert.equal(owenloop['url'], undefined);
  assert.equal(owenloop['headers'], undefined);
  assert.deepEqual(Object.keys(owenloop['env'] as Record<string, unknown>), ['OWENLOOP_PLUGIN_VERSION']);
});

test('both .mcp.json owenloop entries expose exactly the plugin version env key', () => {
  for (const { harness, config } of MCP_MANIFESTS) {
    const owenloop = config.mcpServers['owenloop']!;
    assert.deepEqual(
      Object.keys(owenloop['env'] as Record<string, unknown>),
      ['OWENLOOP_PLUGIN_VERSION'],
      `${harness} env keys`,
    );
  }
});

for (const { harness, raw } of MCP_MANIFESTS) {
  test(`${harness} .mcp.json carries no token-like literal anywhere in the file`, () => {
    assert.ok(!raw.includes('olp_'));
  });

  test(`${harness} .mcp.json carries no --origin flag or OWENLOOP_URL reference anywhere in the file`, () => {
    assert.ok(!raw.includes('--origin'));
    assert.ok(!raw.includes('OWENLOOP_URL'));
  });

  test(`${harness} .mcp.json carries no reference to the retired owenwork binary (INV-41)`, () => {
    // Positive assertion that the retired mount is GONE, not merely unpinned:
    // the retired dispatcher mount was deleted upstream, so any reappearance of the
    // retired binary name here would re-declare a server that cannot start.
    assert.ok(!raw.includes('owenwork'));
  });
}

test('Codex plugin.json declares skills and MCP paths that resolve inside the plugin', () => {
  const plugin = readJson('plugins/codex/plugins/owenloop/.codex-plugin/plugin.json') as {
    name: string;
    version: string;
    skills: string;
    mcpServers: string;
  };
  assert.equal(plugin.name, 'owenloop');
  assert.equal(plugin.skills, './skills/');
  assert.equal(plugin.mcpServers, './.mcp.json');

  const pluginRoot = resolve(ROOT, 'plugins/codex/plugins/owenloop');
  assert.equal(statSync(resolve(pluginRoot, plugin.skills)).isDirectory(), true);
  assert.equal(statSync(resolve(pluginRoot, plugin.mcpServers)).isFile(), true);
});

test('Codex plugin.json version matches the Claude Code plugin.json version', () => {
  const claude = readJson('plugins/claude-code/plugin/.claude-plugin/plugin.json') as { version: string };
  const codex = readJson('plugins/codex/plugins/owenloop/.codex-plugin/plugin.json') as { version: string };
  assert.equal(codex.version, claude.version);
});

test('Codex marketplace.json parses and its local plugin source stays inside the marketplace root', () => {
  const marketplace = readJson('plugins/codex/.agents/plugins/marketplace.json') as {
    name: string;
    plugins: Array<{ name: string; source: { source: string; path: string } }>;
  };
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0]!;
  assert.equal(entry.name, 'owenloop');
  assert.equal(entry.source.source, 'local');

  const marketplaceRootDir = resolve(ROOT, 'plugins/codex');
  const resolvedSourceDir = resolve(marketplaceRootDir, entry.source.path);
  const rel = relative(marketplaceRootDir, resolvedSourceDir);
  assert.equal(rel.startsWith('..'), false);
  assert.equal(isAbsolute(rel), false);
  assert.equal(statSync(resolvedSourceDir).isDirectory(), true);
  const pluginManifest = JSON.parse(
    readFileSync(resolve(resolvedSourceDir, '.codex-plugin/plugin.json'), 'utf8'),
  ) as { name: string };
  assert.equal(pluginManifest.name, 'owenloop');
});

test('both marketplace manifests use the owenloop@owenloop selector', () => {
  const manifests = [
    readJson('plugins/claude-code/.claude-plugin/marketplace.json') as {
      name: string;
      plugins: Array<{ name: string }>;
    },
    readJson('plugins/codex/.agents/plugins/marketplace.json') as {
      name: string;
      plugins: Array<{ name: string }>;
    },
  ];
  for (const marketplace of manifests) {
    assert.equal(marketplace.name, 'owenloop');
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0]!.name, 'owenloop');
  }
});

test('Codex .mcp.json uses the PATH lookup environment allowlist', () => {
  const owenloop = MCP_MANIFESTS[1]!.config.mcpServers['owenloop']!;
  assert.deepEqual(owenloop['env_vars'], ['HOME', 'PATH', 'XDG_CONFIG_HOME']);
  assert.equal(owenloop['cwd'], undefined);
});

const HOOKS = readJson('plugins/claude-code/plugin/hooks/hooks.json') as {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
};

test('hooks/hooks.json declares exactly the SessionStart and SessionEnd events', () => {
  // The old SessionStart was retired because its sole action was `mkdir -p` on
  // the agents dir for a deleted session dispatcher. This SessionStart is new,
  // with a different purpose: checking the CLI/plugin version relationship.
  assert.deepEqual(new Set(Object.keys(HOOKS.hooks)), new Set(['SessionStart', 'SessionEnd']));
});

test('hooks/hooks.json commands are plugin-root-relative executable scripts', () => {
  const commands: string[] = [];
  for (const matchers of Object.values(HOOKS.hooks)) {
    for (const matcher of matchers) {
      for (const h of matcher.hooks) {
        assert.equal(h.type, 'command');
        commands.push(h.command);
      }
    }
  }
  assert.ok(commands.length > 0);
  for (const command of commands) {
    // Referenced via ${CLAUDE_PLUGIN_ROOT}, never an absolute or bare path.
    assert.equal(command.startsWith('${CLAUDE_PLUGIN_ROOT}/'), true);
    const relScript = command.replace('${CLAUDE_PLUGIN_ROOT}/', 'plugins/claude-code/plugin/');
    const abs = resolve(ROOT, relScript);
    const st = statSync(abs); // throws if the script does not exist
    // Some executable bit is set (owner/group/other) — the mode bits matter
    // because Claude Code shells the script directly.
    assert.notEqual(st.mode & 0o111, 0);
  }
});

for (const script of ['session-end.sh', 'session-start.sh']) {
  test(`hook script ${script} has no personal path or token literal`, () => {
    const content = readText(`plugins/claude-code/plugin/hooks/${script}`);
    assert.ok(!((content)).includes('/Users/'));
    assert.ok(!((content)).includes('olp_'));
  });
}

const { data: frontmatter } = parseFrontmatter(readText('plugins/claude-code/plugin/agents/owenloop-worker.md'));

test('agents/owenloop-worker.md tools are exactly the governed allowlist (order-insensitive) — INV-39', () => {
  const tools = splitToolList(frontmatter.tools);
  assert.deepEqual(new Set(tools), new Set(GOVERNED_HUB_WORKER_TOOLS));
});

test('agents/owenloop-worker.md does NOT include Agent, Task, Edit, or Write', () => {
  const tools = splitToolList(frontmatter.tools);
  for (const forbidden of ['Agent', 'Task', 'Edit', 'Write']) {
    assert.ok(!((tools)).includes(forbidden));
  }
});

test('agents/owenloop-worker.md has no mcpServers/hooks/permissionMode frontmatter keys (Claude Code plugin agent-frontmatter convention)', () => {
  assert.ok(!('mcpServers' in (frontmatter)));
  assert.ok(!('hooks' in (frontmatter)));
  assert.ok(!('permissionMode' in (frontmatter)));
});

const CLI_COMMANDS = {
  conduct: [
    'owenloop work prepare <workflow>',
    'owenloop shift status',
    'owenloop shift start <crew...>',
    'owenloop shift start --all',
    'owenloop create <workflow>',
    'owenloop shift next --wait 90',
    'owenloop status <wf>',
    "owenloop provide <wf> <name> --value '<json>'",
    'owenloop shift end',
  ],
  shift: [
    'owenloop shift status',
    'owenloop shift start <crew...>',
    'owenloop shift start --all',
    'owenloop shift next --wait 90',
    "owenloop provide <wf> <name> --value '<json>'",
    'owenloop shift end',
  ],
} as const;

const LOAD_BEARING_CLAUSES = [
  /Starting is not running\./,
  /Never schedule a wakeup, reminder, cron job,\s*scheduler, timeout, interval, or cadence/,
  /`--wait 90` is the blocking CLI park itself, not\s*an external timer or scheduler\./,
  /`owenloop shift next --wait 90` blocks/,
  /Blocking is\s+standing by\./,
  /the goal\s+is unmet until a human explicitly asks to end that shift/,
] as const;

const LOOP_ORDER = {
  conduct: [
    /When the command returns, process the result, run\s+`owenloop status <wf>` for the captured target, handle that status, and only\s+then run the command again if the target remains open\./,
    /After each\s+park returns, follow this order before any next\s+park:/,
    /Run `owenloop status <wf>` for the captured target, including after a normal\s+or empty event result\./,
    /If the target remains open, only then run the next blocking park\./,
  ],
  shift: [
    /When the command returns, parse and report its capacity and\s+events, then immediately run it again after normal or empty results\./,
  ],
} as const;

const OPERATING_RULES = [
  /one park at a time/,
  /verbatim/,
  /auto-answer a gate/,
  /last\s+\*\*4 lines\*\* per item/,
] as const;

const SKILL_CASES = [
  { name: 'conduct', path: 'plugins/claude-code/plugin/skills/conduct/SKILL.md' },
  { name: 'shift', path: 'plugins/claude-code/plugin/skills/shift/SKILL.md' },
] as const;

test('author/SKILL.md exists and references the owenloop tool namespace', () => {
  const content = readText('plugins/claude-code/plugin/skills/author/SKILL.md');
  assert.ok((content).includes('mcp__plugin_owenloop_owenloop__'));
});

test('author/SKILL.md allowed-tools is exactly the governed set — no Edit/Write, no bare unscoped Bash', () => {
  const { data } = parseFrontmatter(readText('plugins/claude-code/plugin/skills/author/SKILL.md'));
  assert.ok('allowed-tools' in (data));
  const tools = splitToolList(data['allowed-tools']);
  assert.deepEqual(new Set(tools), new Set(AUTHOR_ALLOWED_TOOLS));
  assert.ok(!((tools)).includes('Edit'));
  assert.ok(!((tools)).includes('Write'));
  assert.ok(!((tools)).includes('Bash'));
});

for (const { path, name } of SKILL_CASES) {
  test(`${name}/SKILL.md allowed-tools is exactly the scoped CLI Bash token`, () => {
    const { data } = parseFrontmatter(readText(path));
    assert.ok('allowed-tools' in (data));
    const tools = splitToolList(data['allowed-tools']);
    const expected = name === 'conduct' ? CONDUCT_ALLOWED_TOOLS : SHIFT_ALLOWED_TOOLS;
    assert.deepEqual(new Set(tools), new Set(expected));
    assert.deepEqual(tools, ['Bash(owenloop:*)']);
  });
}

for (const { path, name } of SKILL_CASES) {
  test(`${name}/SKILL.md contains the canonical CLI commands`, () => {
    const content = readText(path);
    for (const command of CLI_COMMANDS[name]) assert.ok(content.includes(command));
  });
}

for (const { path, name } of SKILL_CASES) {
  test(`${name}/SKILL.md repeats every load-bearing clause`, () => {
    const content = readText(path);
    for (const clause of LOAD_BEARING_CLAUSES) assert.match(content, clause);
    assert.ok((content).includes('A no-work or empty event return is normal duty, not a blocking condition, not'));
    assert.ok((content).includes('an error, and never a reason for Codex to mark the goal `blocked`.'));
  });
}

for (const { path, name } of SKILL_CASES) {
  test(`${name}/SKILL.md preserves its park ordering`, () => {
    const content = readText(path);
    for (const rule of LOOP_ORDER[name]) assert.match(content, rule);
  });
}

for (const { path, name } of SKILL_CASES) {
  test(`${name}/SKILL.md states the operating safety rules`, () => {
    const content = readText(path);
    for (const rule of OPERATING_RULES) assert.match(content, rule);
  });
}

for (const { path, name } of SKILL_CASES) {
  test(`${name}/SKILL.md has no MCP or legacy command reference`, () => {
    const content = readText(path);
    assert.ok(!((content)).includes('mcp__'));
    assert.ok(!((content)).includes('owenwork'));
  });
}

test('shift/SKILL.md wires the exact Claude Code goal', () => {
  const content = readText('plugins/claude-code/plugin/skills/shift/SKILL.md');
  assert.ok((content).includes('/goal run a shift on <crew>'));
  assert.ok((content).includes('The model cannot invoke `/goal` itself'));
});

test('shift/SKILL.md wires the exact Codex objective and blocked guard', () => {
  const content = readText('plugins/claude-code/plugin/skills/shift/SKILL.md');
  assert.ok((content).includes('the shift on <crew> has been explicitly stopped by the human'));
  assert.ok((content).includes('never a reason for Codex to mark the goal `blocked`'));
});

for (const { path, name } of SKILL_CASES) {
  test(`${name}/SKILL.md separates an absent daemon from an incompatible daemon scope`, () => {
    const content = readText(path);
    assert.match(content, /If the status reports no daemon,[\s\S]*start `owenloop shift start <crew\.\.\.>` as\s+a background process/);
    assert.match(content, /If the status reports an existing daemon serving an incompatible scope,[\s\S]*ask the human how to proceed before ending,\s+restarting, or changing that daemon's scope\.[\s\S]*Do not start a second daemon\s+or silently repurpose the existing daemon\./);
    assert.doesNotMatch(content, /If the status reports an existing daemon serving an incompatible scope,[\s\S]*?start `owenloop shift start <crew\.\.\.>` as\s+a background process/);
    assert.ok(!((content)).includes('If no compatible daemon exists,'));
  });
}

test('conduct/SKILL.md relays waitingOnLabels without attempting repair', () => {
  const content = readText('plugins/claude-code/plugin/skills/conduct/SKILL.md');
  assert.ok((content).includes('`waitingOnLabels` as `[{ step, labels }]`'));
  assert.match(content, /name the\s+exact step and exact label or labels/);
  assert.match(content, /run\s+resumes when an admin re-binds the label/);
  assert.match(content, /Do not restart the run, repair\s+the\s+binding, or treat the run as a crashed worker\./);
});

test('shift/SKILL.md does not contain conduct-only completion guidance', () => {
  const content = readText('plugins/claude-code/plugin/skills/shift/SKILL.md');
  assert.ok(!((content)).includes('For conduct,'));
  assert.ok(!((content)).includes('target workflow closed'));
});

test('shift/SKILL.md never uses the prose word "conductor"', () => {
  const content = readText('plugins/claude-code/plugin/skills/shift/SKILL.md');
  assert.doesNotMatch(content, /conductor/i);
});

test('no file under plugins/ leaks a personal path or a local-only decision-doc reference', () => {
  const marketplaceDir = resolve(ROOT, 'plugins');
  for (const file of walkFiles(marketplaceDir)) {
    const content = readFileSync(file, 'utf8');
    const where = relative(ROOT, file);
    assert.ok(!content.includes('/Users/'), `${where} must not contain /Users/`);
    assert.ok(!content.includes('integration-build-plan'), `${where} must not cite integration-build-plan`);
    assert.ok(!content.includes('integration-experience'), `${where} must not cite integration-experience`);
    assert.ok(!content.includes('docs/decisions'), `${where} must not cite a repo-local decision doc (docs/decisions)`);
    assert.ok(!content.includes('shifts.md'), `${where} must not cite shifts.md`);
    // The retired dispatcher binary and its MCP mount were deleted
    // upstream. Nothing that ships to end users may name the retired binary — not the
    // manifest, not a skill's allowed-tools or body, not a hook script.
    // This one assertion covers the whole shipped tree (INV-41).
    assert.ok(!content.includes('owenwork'), `${where} must not reference the retired owenwork binary`);
  }
});
