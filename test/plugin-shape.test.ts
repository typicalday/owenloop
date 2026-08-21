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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/** The authoritative author skill plus both committed materializations. */
const AUTHOR_SKILL_PATHS = [
  'plugins/_skills/author/SKILL.md',
  'plugins/claude-code/plugin/skills/author/SKILL.md',
  'plugins/codex/plugins/owenloop/skills/author/SKILL.md',
] as const;

/** ephemeral's governed hub lifecycle surface under both plugin spellings. */
const EPHEMERAL_ALLOWED_TOOLS = [
  'mcp__plugin_owenloop_owenloop__list_workflows',
  'mcp__plugin_owenloop_owenloop__create_workflow',
  'mcp__plugin_owenloop_owenloop__get_workflow',
  'mcp__plugin_owenloop_owenloop__start_run',
  'mcp__plugin_owenloop_owenloop__whats_next',
  'mcp__plugin_owenloop_owenloop__heartbeat',
  'mcp__plugin_owenloop_owenloop__get_order',
  'mcp__plugin_owenloop_owenloop__submit',
  'mcp__plugin_owenloop_owenloop__reject_artifact',
  'mcp__plugin_owenloop_owenloop__get_status',
  'mcp__plugin_owenloop_owenloop__delete_workflow',
  'mcp__owenloop__list_workflows',
  'mcp__owenloop__create_workflow',
  'mcp__owenloop__get_workflow',
  'mcp__owenloop__start_run',
  'mcp__owenloop__whats_next',
  'mcp__owenloop__heartbeat',
  'mcp__owenloop__get_order',
  'mcp__owenloop__submit',
  'mcp__owenloop__reject_artifact',
  'mcp__owenloop__get_status',
  'mcp__owenloop__delete_workflow',
] as const;

/** The hub skill needs its own list: AUTHOR_SKILL_PATHS carries author-only
 * harness assertions, while SKILL_CASES intentionally rejects all MCP names. */
const EPHEMERAL_SKILL_PATHS = [
  'plugins/_skills/ephemeral/SKILL.md',
  'plugins/claude-code/plugin/skills/ephemeral/SKILL.md',
  'plugins/codex/plugins/owenloop/skills/ephemeral/SKILL.md',
] as const;

/** plan's governed mixed MCP/CLI/file compiler surface under both spellings. */
const PLAN_ALLOWED_TOOLS = [
  'mcp__plugin_owenloop_owenloop__list_workflows',
  'mcp__plugin_owenloop_owenloop__search_workflows',
  'mcp__plugin_owenloop_owenloop__get_workflow',
  'mcp__plugin_owenloop_owenloop__create_workflow',
  'mcp__plugin_owenloop_owenloop__start_run',
  'mcp__plugin_owenloop_owenloop__pending_gates',
  'mcp__plugin_owenloop_owenloop__provide_input',
  'mcp__plugin_owenloop_owenloop__get_status',
  'mcp__plugin_owenloop_owenloop__delete_workflow',
  'mcp__owenloop__list_workflows',
  'mcp__owenloop__search_workflows',
  'mcp__owenloop__get_workflow',
  'mcp__owenloop__create_workflow',
  'mcp__owenloop__start_run',
  'mcp__owenloop__pending_gates',
  'mcp__owenloop__provide_input',
  'mcp__owenloop__get_status',
  'mcp__owenloop__delete_workflow',
  'Write',
  'Bash(mktemp:*)',
  'Bash(owenloop:*)',
  'Bash(rm:*)',
] as const;

/** The canonical compiler skill plus both committed materializations. */
const PLAN_SKILL_PATHS = [
  'plugins/_skills/plan/SKILL.md',
  'plugins/claude-code/plugin/skills/plan/SKILL.md',
  'plugins/codex/plugins/owenloop/skills/plan/SKILL.md',
] as const;

/** graduate's governed evidence/read-only MCP and scoped local-check surface. */
const GRADUATE_ALLOWED_TOOLS = [
  'mcp__plugin_owenloop_owenloop__get_workflow',
  'mcp__plugin_owenloop_owenloop__get_status',
  'mcp__owenloop__get_workflow',
  'mcp__owenloop__get_status',
  'Write',
  'Bash(mktemp:*)',
  'Bash(owenloop:*)',
  'Bash(rm:*)',
] as const;

/** The authoritative graduate skill plus both committed materializations. */
const GRADUATE_SKILL_PATHS = [
  'plugins/_skills/graduate/SKILL.md',
  'plugins/claude-code/plugin/skills/graduate/SKILL.md',
  'plugins/codex/plugins/owenloop/skills/graduate/SKILL.md',
] as const;

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

test('both .mcp.json owenloop entries launch exactly owenloop mcp through PATH (INV-38)', () => {
  for (const { harness, config } of MCP_MANIFESTS) {
    const owenloop = config.mcpServers['owenloop']!;
    assert.equal(owenloop['command'], 'owenloop', `${harness} command`);
    assert.deepEqual(owenloop['args'], ['mcp'], `${harness} arguments`);
  }
});

test('Claude Code .mcp.json keeps its stdio shape and only the plugin version env (INV-38)', () => {
  const owenloop = MCP_MANIFESTS[0]!.config.mcpServers['owenloop']!;
  assert.equal(owenloop['type'], 'stdio');
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

test('Codex .mcp.json allowlists PATH lookup plus the hub-resolution env vars', () => {
  const owenloop = MCP_MANIFESTS[1]!.config.mcpServers['owenloop']!;
  assert.deepEqual(owenloop['env_vars'], ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'OWENLOOP_HUB', 'OWENLOOP_NO_KEYCHAIN']);
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

test('the Claude Code plugin packages no static workflow worker', () => {
  assert.equal(
    existsSync(resolve(ROOT, 'plugins/claude-code/plugin/agents/owenloop-worker.md')),
    false,
  );
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

test('all shipped author skills teach the neutral harness carrier and agent-run dispatcher', () => {
  for (const path of AUTHOR_SKILL_PATHS) {
    const content = readText(path);
    assert.ok(content.includes('x.harness'), `${path} must teach x.harness`);
    assert.ok(content.includes('owenloop work agent-run'), `${path} must name the supported dispatcher`);
    assert.ok(content.includes('advisory.tools'), `${path} must distinguish advisory tool guidance`);
    assert.ok(content.includes('not a security boundary'), `${path} must state the advisory boundary`);
    assert.ok(!content.includes('x.claude-code'), `${path} must not teach the retired carrier`);
    assert.ok(!content.includes('Stamped-agent dispatch'), `${path} must not teach stamped dispatch`);
    assert.doesNotMatch(
      content,
      /\bstamp(?:ed|s|ing)?\b[\s\S]{0,160}\bper-order agent files?\b/i,
      `${path} must not instruct the daemon to stamp per-order agent files`,
    );
  }
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

test('all shipped ephemeral skills have the governed identity and exact lifecycle tool set', () => {
  for (const path of EPHEMERAL_SKILL_PATHS) {
    const { data } = parseFrontmatter(readText(path));
    assert.equal(data.name, 'ephemeral');
    assert.match(String(data.description), /collision-safe hub ephemeral workflow/u);
    assert.deepEqual(new Set(splitToolList(data['allowed-tools'])), new Set(EPHEMERAL_ALLOWED_TOOLS));
  }
});

test('all shipped ephemeral skills keep the decision gate, capability preflight, and publication proof', () => {
  for (const path of EPHEMERAL_SKILL_PATHS) {
    const body = parseFrontmatter(readText(path)).body;
    for (const rule of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) assert.ok(body.includes(rule), path + ' must retain ' + rule);
    for (const condition of [
      'Straight line of at most about five steps',
      'Steps are smaller than one coherent agent turn',
      'cannot yet name each step',
      'Everything fits comfortably',
    ]) assert.ok(body.includes(condition), path + ' must retain every never-use condition');
    assert.ok(body.includes('include_ephemeral: true'), path + ' must preflight inclusive discovery');
    assert.ok(body.includes('remote MCP capability preflight'), path + ' must attest the selected remote hub, not only the local proxy');
    assert.ok(body.includes('A 200 inclusive listing is **not** a capability\nattestation'), path + ' must not mistake an ignored inclusive query for support');
    assert.ok(body.includes('ephemeral: true'), path + ' must create an ephemeral definition');
    assert.ok(body.includes('eph-<short-task-slug>-<unix-ms>-<random-hex>'), path + ' must require collision-safe names');
    assert.ok(body.includes('version, and hash'), path + ' must record publication identity');
    assert.ok(body.includes('compare its name,\nversion, and hash'), path + ' must recheck publication identity before retirement');
  }
});

test('all shipped ephemeral skills prescribe honest self-execution and safe retirement', () => {
  for (const path of EPHEMERAL_SKILL_PATHS) {
    const body = parseFrontmatter(readText(path)).body;
    assert.match(body, /start_run[\s\S]*whats_next[\s\S]*heartbeat[\s\S]*get_order[\s\S]*submit/u, path + ' must prescribe the self-execution sequence');
    assert.ok(body.includes('Stop only after terminal\ncompletion'), path + ' must require terminal completion');
    assert.ok(body.indexOf('After terminal status') < body.indexOf('call \`delete_workflow\` exactly once'), path + ' must check terminal status before deletion');
    assert.ok(body.includes('live catalog pointer'), path + ' must explain live-pointer-only retirement');
    assert.ok(body.includes('Historical pinned definition\nversions remain reachable and are never deleted'), path + ' must preserve immortal history semantics');
    for (const refusal of ['Active root references', 'No live definition', 'not ephemeral']) {
      assert.ok(body.includes(refusal), path + ' must classify ' + refusal + ' refusal');
    }
    assert.ok(body.includes('never its HTTP\nstatus alone'), path + ' must classify 409s by message');
  }
});

test('all shipped plan skills have the governed compiler identity and exact mixed tool set', () => {
  for (const path of PLAN_SKILL_PATHS) {
    const { data } = parseFrontmatter(readText(path));
    assert.equal(data.name, 'plan');
    assert.match(String(data.description), /checked, approval-gated ephemeral composite/u);
    const tools = splitToolList(data['allowed-tools']);
    assert.deepEqual(new Set(tools), new Set(PLAN_ALLOWED_TOOLS));
    for (const forbidden of [
      'Edit',
      'Bash',
      'mcp__plugin_owenloop_owenloop__whats_next',
      'mcp__plugin_owenloop_owenloop__heartbeat',
      'mcp__plugin_owenloop_owenloop__get_order',
      'mcp__plugin_owenloop_owenloop__submit',
      'mcp__plugin_owenloop_owenloop__reject_artifact',
      'mcp__owenloop__whats_next',
      'mcp__owenloop__heartbeat',
      'mcp__owenloop__get_order',
      'mcp__owenloop__submit',
      'mcp__owenloop__reject_artifact',
    ]) {
      assert.ok(!tools.includes(forbidden), `${path} must not grant ${forbidden}`);
    }
  }
});

test('all shipped plan skills retain compiler selection, full-closure, and clean-check rules', () => {
  for (const path of PLAN_SKILL_PATHS) {
    const body = parseFrontmatter(readText(path)).body;
    for (const clause of [
      'no single catalog definition covers the task',
      '`list_workflows` first',
      '`search_workflows`',
      '`get_workflow` for every promising candidate',
      'candidates',
      'coordinate',
      'selected',
      'reason',
      'collision-safe root name',
      'Refuse an exact-name\ncollision',
      'create_workflow({ yaml, ephemeral: true })',
      'remote ephemeral preflight',
      'expected name, version, and content hash',
      'complete exact calls closure',
      'owenloop lint --defs <staging-dir>',
      'owenloop check <composite-name> --defs <staging-dir> --format json',
      'completable === true',
      'bounded === false',
      'deadlocks',
      'stallStates',
      'stuck',
      'structurallyDeadSteps',
      'unreachedSteps',
      'invariantViolations',
    ]) {
      assert.ok(body.includes(clause), `${path} must retain ${clause}`);
    }
    assert.match(
      body,
      /candidates:[\s\S]*coordinate[\s\S]*selected[\s\S]*reason[\s\S]*additionalProperties: false/u,
      `${path} must keep the closed structural selection rationale`,
    );
    assert.ok(body.includes('outside the\nrepository'), `${path} must stage definitions outside the repo`);
    assert.ok(body.includes('Do not silently rewrite a\ntarget'), `${path} must preserve exact calls targets`);
  }
});

test('all shipped plan skills prescribe the parked gate lifecycle and delegated execution', () => {
  for (const path of PLAN_SKILL_PATHS) {
    const body = parseFrontmatter(readText(path)).body;
    assert.match(
      body,
      /name: planApproval\n  seedOwed: true\n  producer: human[\s\S]*required: \[approved\]/u,
      `${path} must define an object-valued human approval input`,
    );
    assert.match(
      body,
      /first executable\nbespoke step consumes `task`, `compiledPlan`, and `planApproval`/u,
      `${path} must place all work after approval`,
    );
    assert.ok(body.includes('onCancel:'), `${path} must retain the cancellation cleanup contract`);
    assert.ok(body.includes('owenloop cancel <workflow>'), `${path} must cancel a declined plan`);
    assert.ok(body.includes('never performs composite step work inline'), `${path} must prohibit inline step work`);
    assert.ok(body.includes('never submits\nartifacts for a composite run'), `${path} must prohibit composite submission`);
    assert.ok(body.includes('`conduct` or `shift`'), `${path} must hand supervision to the crew tools`);
    assert.ok(!body.includes('approval-envelope'), `${path} must not teach an approval envelope`);
    assert.ok(!body.includes('conversational-only approval'), `${path} must not teach a conversational-only gate`);

    const lifecycle = body.slice(body.indexOf('## Publish, park, present, and release'));
    const markers = [
      'Call `create_workflow`',
      'Call `get_workflow`',
      'Call `start_run`',
      'Require `eligible: []`',
      'call\n   `pending_gates`',
      'Present the exact `compiledPlan`',
      'call `provide_input`',
      'intended first step to be eligible',
    ];
    let previous = -1;
    for (const marker of markers) {
      const current = lifecycle.indexOf(marker);
      assert.ok(current > previous, `${path} must order ${marker} after the preceding lifecycle action`);
      previous = current;
    }
  }
});

test('all shipped graduate skills have the governed identity and exact evidence/check tool set', () => {
  for (const path of GRADUATE_SKILL_PATHS) {
    const { data } = parseFrontmatter(readText(path));
    assert.equal(data.name, 'graduate');
    assert.match(String(data.description), /successful completed ephemeral composite/u);
    const tools = splitToolList(data['allowed-tools']);
    assert.deepEqual(new Set(tools), new Set(GRADUATE_ALLOWED_TOOLS));
    for (const forbidden of [
      'Edit',
      'Bash',
      'mcp__plugin_owenloop_owenloop__whats_next',
      'mcp__plugin_owenloop_owenloop__heartbeat',
      'mcp__plugin_owenloop_owenloop__get_order',
      'mcp__plugin_owenloop_owenloop__submit',
      'mcp__plugin_owenloop_owenloop__reject_artifact',
      'mcp__owenloop__whats_next',
      'mcp__owenloop__heartbeat',
      'mcp__owenloop__get_order',
      'mcp__owenloop__submit',
      'mcp__owenloop__reject_artifact',
    ]) {
      assert.ok(!tools.includes(forbidden), `${path} must not grant ${forbidden}`);
    }
  }
});

test('all shipped graduate skills retain capture, generalization, discovery, and handoff rules', () => {
  for (const path of GRADUATE_SKILL_PATHS) {
    const body = parseFrontmatter(readText(path)).body;
    for (const clause of [
      'before retirement',
      'publication-time full bundle was preserved',
      'ephemeral: true',
      'name, version, and content hash',
      'terminal === true',
      'instanceStatus === "done"',
      'Failed or cancelled terminal runs are not\n   graduation evidence',
      'preserved `compiledPlan`',
      'does not return artifact payloads',
      'never use it to read',
      'task`: replace the one-off value',
      'compiledPlan`: remove it from candidate runtime inputs',
      'planApproval`: remove the ephemeral compiler-release gate',
      'explicit JSON Schema',
      'every authored `produces`/`generates` artifact',
      'every top-level output name to resolve to a schema-bearing',
      'exact `calls:` closure',
      'complete clean-export workflow set',
      'exactly\n`description`, non-empty `whenToUse`, non-empty `notFor`, and',
      'exactly once, with no unknown or duplicate',
      'non-empty `name`, non-empty',
      'beginning `#/`',
      'owenloop lint --defs <staging-dir>',
      'owenloop check <candidate-name> --defs <staging-dir> --format json',
      'zero errors and zero warnings',
      'completable === true',
      'bounded === false',
      'deadlocks',
      'stallStates',
      'stuck',
      'structurallyDeadSteps',
      'unreachedSteps',
      'invariantViolations',
      'Cite the originating workflow ID',
      'Do not attempt a receipt read',
      'workflowCoordinate',
      'workflowVersion',
      'originatingWorkflowId',
      'completionResult',
      'YYYY-MM-DD',
      'Do not pack',
      'publication boundary',
    ]) {
      assert.ok(body.includes(clause), `${path} must retain ${clause}`);
    }
    assert.ok(
      body.indexOf('before retirement') < body.indexOf('After `delete_workflow` removes an ephemeral live pointer'),
      `${path} must capture the live bundle before explaining retirement`,
    );
  }
});

test('ephemeral skill is hub-native and the legacy local skill is gone', () => {
  for (const path of EPHEMERAL_SKILL_PATHS) {
    const content = readText(path);
    for (const forbidden of ['SQLite', 'OWENLOOP_DB', '.owenloop-eph', 'owenloop create', 'owenloop tick', 'owenloop delete']) {
      assert.ok(!content.includes(forbidden), path + ' must not teach retired local transport: ' + forbidden);
    }
  }
  assert.equal(existsSync(resolve(ROOT, 'skills/owenloop-ephemeral/SKILL.md')), false);
  assert.equal(existsSync(resolve(ROOT, 'skills/owenloop-author/SKILL.md')), false);
  assert.equal(existsSync(resolve(ROOT, 'skills/owenloop-conduct/SKILL.md')), false);
});

test('retirement docs list every plugin skill and describe conduct as Shift supervision', () => {
  const readme = readText('README.md');
  for (const [name, path] of [
    ['author', 'plugins/_skills/author/SKILL.md'],
    ['conduct', 'plugins/_skills/conduct/SKILL.md'],
    ['ephemeral', 'plugins/_skills/ephemeral/SKILL.md'],
    ['graduate', 'plugins/_skills/graduate/SKILL.md'],
    ['plan', 'plugins/_skills/plan/SKILL.md'],
    ['shift', 'plugins/_skills/shift/SKILL.md'],
  ]) {
    assert.ok(readme.includes(`[\`${name}\`](${path})`), `README must link the ${name} plugin skill`);
  }

  const shipExample = readText('examples/workflows/ship.yaml');
  assert.ok(shipExample.includes('scoped Shift'), 'ship example must describe conduct as scoped Shift supervision');
  assert.ok(shipExample.includes('`agent-run`'), 'ship example must name Shift-dispatched agent workers');
  assert.ok(!shipExample.includes('one fresh subagent per order'), 'ship example must not teach the retired dispatch model');
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
