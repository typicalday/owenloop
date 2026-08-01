#!/usr/bin/env node
/**
 * Record a REAL Claude Code SDK message stream into a replayable fixture.
 *
 * WHY THIS SCRIPT EXISTS. `consumeTurn` in `src/harness/claude.ts` maps the
 * SDK's message stream onto this project's `AgentEvent` contract. That mapping
 * is written against a vendor's shape, and a vendor upgrade can change the shape
 * without changing anything in this repo. A recorded transcript, replayed
 * through `consumeTurn` in `test/harness-contract-fixtures.test.ts`, turns that
 * silent drift into a failing test. This script is how the transcript is made,
 * and re-made after every CLI bump — step 2 of the upgrade workflow written down
 * in `docs/agent-runner.md`.
 *
 * WHAT IT DOES. Runs ONE throwaway turn through the SDK exactly as the adapter
 * does (`query()` with a string prompt), captures every message verbatim,
 * scrubs it, and writes JSONL to the fixture path. It spends real subscription
 * quota — a few cents at most, one short turn with no tools.
 *
 *     node test/tools/record-claude-stream.mjs                    # default path
 *     node test/tools/record-claude-stream.mjs --out /tmp/x.jsonl --prompt '...'
 *
 * WHAT IT SCRUBS, AND WHY EACH. A raw SDK stream carries machine identity that
 * must not enter git:
 *   - session and message UUIDs   → stable placeholders. They are per-run and
 *                                   would make every re-recording a giant diff,
 *                                   which defeats "git diff the fixture".
 *   - the home directory and cwd  → `/fixture-home`, `/fixture-cwd`. These leak
 *                                   the operator's username and directory layout.
 *   - token-shaped strings        → `[redacted]`. Belt and braces: the adapter
 *                                   never puts a credential in a message, but a
 *                                   future SDK field might echo one back, and a
 *                                   committed fixture is forever.
 * Scrubbing is applied to the SERIALIZED json, so it reaches nested fields this
 * script has never heard of — which is the point, since the risk is a field
 * nobody anticipated.
 *
 * IT ALSO NEUTRALIZES THE OPERATOR'S INVENTORY. The `system/init` message
 * enumerates the machine's installed tools, MCP servers, slash commands,
 * subagents, skills and plugins. That is a private inventory — it names internal
 * projects and connected accounts — and Phase 2B deleted the equivalent frames
 * from the codex fixture for the same reason. Those fields are REPLACED with
 * shape-preserving synthetic values rather than deleted, because `consumeTurn`
 * reads `mcp_servers` and a fixture that dropped the key would stop testing the
 * mapping. The fields the mapping actually reads and that are NOT private —
 * `claude_code_version`, `model`, `apiKeySource`, `permissionMode` — are kept
 * verbatim; they are the whole reason to record a real stream.
 *
 * The output is reviewed BY A HUMAN before it is committed. This script reduces
 * the work; it is not a substitute for reading the file.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

const DEFAULT_OUT = resolve(import.meta.dirname, '..', 'fixtures', 'claude-sdk-stream.jsonl');
const DEFAULT_PROMPT =
  'Reply with exactly the word OWENWORK-FIXTURE and nothing else. Do not use any tools.';

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, prompt: DEFAULT_PROMPT, cwd: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--out' || flag === '--prompt' || flag === '--cwd') {
      if (value === undefined) {
        process.stderr.write(`record-claude-stream: ${flag} requires a value\n`);
        process.exit(2);
      }
      out[flag.slice(2)] = value;
      i++;
    } else {
      process.stderr.write(`record-claude-stream: unknown option '${flag}'\n`);
      process.exit(2);
    }
  }
  return out;
}

/** Stable placeholder UUIDs, assigned in first-seen order. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const seen = new Map();
function placeholderFor(uuid) {
  const key = uuid.toLowerCase();
  const existing = seen.get(key);
  if (existing !== undefined) return existing;
  const n = seen.size + 1;
  const d = String(n).padStart(2, '0');
  // Valid v4-shaped so any consumer that parses UUIDs still accepts it. The
  // group lengths are cut explicitly rather than assembled from repeats of `d`,
  // because the 4-character groups are an ODD number of `d`s wide and a naive
  // `4${d}${d}` produces a five-character group that no UUID parser accepts.
  const g = (len) => d.repeat(Math.ceil(len / d.length)).slice(0, len);
  const made = `${g(8)}-${g(4)}-4${g(3)}-8${g(3)}-${g(12)}`;
  seen.set(key, made);
  return made;
}

/**
 * Replace the operator's installed inventory with synthetic values of the same
 * SHAPE. Mutates a structuredClone, never the live message.
 */
function neutralizeInventory(message) {
  const m = structuredClone(message);
  if (m.type === 'system' && m.subtype === 'init') {
    // `mcp_servers` is READ by `consumeTurn`, so it keeps a realistic entry.
    m.mcp_servers = [{ name: 'owenwork', status: 'pending' }];
    m.tools = ['Bash', 'Read', 'Write'];
    m.slash_commands = [];
    m.agents = [];
    m.skills = [];
    m.plugins = [];
    m.capabilities = {};
  }
  if (m.type === 'rate_limit_event') {
    // Carries the org's overage policy. The message TYPE is what matters here —
    // it is one of the types `consumeTurn` must ignore without throwing.
    m.rate_limit_info = { status: 'allowed', resetsAt: 0, rateLimitType: 'five_hour' };
  }
  // Per-run vendor ids: not secret, but pure diff noise on a re-recording.
  if (m.message?.id !== undefined) m.message.id = 'msg_fixture';
  if (m.request_id !== undefined) m.request_id = 'req_fixture';
  return m;
}

function scrub(json, cwd) {
  let s = json;
  // Longest paths first, so the cwd inside the home dir is not half-replaced.
  for (const [from, to] of [
    [cwd, '/fixture-cwd'],
    [homedir(), '/fixture-home'],
    [tmpdir().replace(/\/$/, ''), '/fixture-tmp'],
  ]) {
    if (from) s = s.split(from).join(to);
  }
  s = s.replace(UUID_RE, (m) => placeholderFor(m));
  // Anything that looks like a credential, whatever field it arrived in.
  s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  s = s.replace(/(oauth[A-Za-z_-]*"\s*:\s*")[^"]+/gi, '$1[redacted]');
  s = s.replace(/([Tt]oken"\s*:\s*")[^"]+/g, '$1[redacted]');
  return s;
}

const args = parseArgs(process.argv.slice(2));
const cwd = args.cwd ?? mkdtempSync(join(tmpdir(), 'owenwork-record-'));

const started = Date.now();
const lines = [];
process.stderr.write(`record-claude-stream: recording one turn in ${cwd}\n`);

const q = query({
  prompt: args.prompt,
  options: {
    cwd,
    // No tools, no MCP mount: this fixture is about the MESSAGE SHAPE that
    // `consumeTurn` reads, and a tool-using turn adds cost and nondeterminism
    // without adding a single field the mapping looks at.
    permissionMode: 'bypassPermissions',
  },
});

for await (const message of q) {
  const safe = neutralizeInventory(message);
  lines.push(scrub(JSON.stringify({ t: Date.now() - started, message: safe }), cwd));
  process.stderr.write(`  ${message.type}${message.subtype ? `/${message.subtype}` : ''}\n`);
}

writeFileSync(args.out, `${lines.join('\n')}\n`);
process.stderr.write(
  `record-claude-stream: wrote ${lines.length} messages to ${args.out}\n` +
    'READ IT before committing — this script scrubs what it knows about, not what it does not.\n',
);
