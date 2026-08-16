import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { run as prepare } from '../src/roles/prepare.ts';
import { stripAmbientOwenloopEnv } from './helpers/ambient-env.ts';

// prepare is driven IN-PROCESS (not via spawnSync): the mock hub is an
// in-process node:http server, and a synchronous child (spawnSync) would freeze
// this event loop so the server could never answer the child's fetch. Calling
// the async `run` keeps the loop live. The binary's exit-code mapping is pinned
// separately in dispatch.test.ts.

const fixture = (p: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url)), 'utf8');
const DEMO = JSON.parse(fixture('demo-def.json')) as Record<string, unknown>;

let cacheDir: string;
let homeDir: string;
// OWENLOOP_CONFIG_DIR is in the list for hermeticity, not because the fixture
// sets it: the config-dir ladder is OWENLOOP_CONFIG_DIR > $XDG_CONFIG_HOME/owenloop
// > $HOME/.config/owenloop (`configDir` in src/hub.ts), so an ambient value
// OUTRANKS the XDG_CONFIG_HOME below and prepare reads the developer's REAL
// config dir — finding a real `hubOrigin` where the fixture wants none, and a
// real credential where the fixture wants an empty store. Every owenloop shift
// exports it, so the suite is red on an agent-driven build and green in CI,
// where the variable is unset. Listing it here deletes it in `beforeEach` and
// restores it in `afterEach` along with the rest.
/**
 * The NON-`OWENLOOP_*` variables this fixture manages by name. The whole
 * `OWENLOOP_*` namespace is denied wholesale by `stripAmbientOwenloopEnv`
 * instead of being enumerated here — enumerating it is what let
 * `OWENLOOP_CONFIG_DIR` through, and it outranks the `XDG_CONFIG_HOME` set below.
 */
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
let savedEnv: Record<string, string | undefined>;
let restoreOwenloopEnv: () => void;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'owenloop-prep-cache-'));
  homeDir = mkdtempSync(join(tmpdir(), 'owenloop-prep-home-'));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // A clean, fixture-controlled env: no ambient HOME/XDG leakage...
  for (const k of ENV_KEYS) delete process.env[k];
  // ...and no ambient OWENLOOP_* leakage either. Denied as a namespace, then set
  // back below, so a variable a future phase adds is hermetic on the day it
  // lands rather than the day someone debugs a red suite on a shift-run build.
  restoreOwenloopEnv = stripAmbientOwenloopEnv();
  process.env['HOME'] = homeDir;
  process.env['XDG_CONFIG_HOME'] = homeDir; // settings live under <homeDir>/owenloop/
  process.env['OWENLOOP_CACHE_DIR'] = cacheDir;
  process.env['OWENLOOP_TOKEN'] = 'tok-abc';
  // Hermetic credential store: force owenloop's file backend (no real keychain
  // shell-out) so an unseeded store reads as absent → the refuse path.
  process.env['OWENLOOP_NO_KEYCHAIN'] = '1';
});
afterEach(() => {
  restoreOwenloopEnv();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of [cacheDir, homeDir]) rmSync(d, { recursive: true, force: true });
});

/** A throwaway hub serving GET /api/workflows/:name with a mutable payload. */
function startHub(payload: () => { status: number; body: unknown }): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/workflows/')) {
        const { status, body } = payload();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Run prepare in-process, capturing stdout/stderr. */
async function runPrepare(args: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  try {
    const code = await prepare(args);
    return { code, stdout, stderr };
  } finally {
    (process.stdout.write as unknown) = origOut;
    (process.stderr.write as unknown) = origErr;
  }
}

const enrichedBody = (def: Record<string, unknown>) => ({ status: 200, body: { text: 'ok', ...def } });
const closed = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

/**
 * A hub that routes `GET /api/workflows/:name` to a per-name payload (so a test
 * can prepare a parent and later prepare a child directly). Unknown names 404.
 */
function startRoutingHub(routes: () => Record<string, Record<string, unknown>>): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const m = req.method === 'GET' ? req.url?.match(/^\/api\/workflows\/([^/?]+)/) : null;
      const name = m ? decodeURIComponent(m[1]!) : undefined;
      const def = name !== undefined ? routes()[name] : undefined;
      if (def === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'ok', ...def }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/** A parent pinning one calls-step child, whose child in turn pins a grandchild. */
const PINNED_PARENT = {
  name: 'parent',
  hash: 'parenthash01',
  version: 1,
  steps: [
    { name: 'plan', body: 'plan it', x: { harness: {} } },
    { name: 'sub', calls: 'child' },
  ],
  pins: [{ call: 'sub', name: 'child', version: 2, hash: 'childhash01' }],
  children: {
    childhash01: {
      name: 'child',
      hash: 'childhash01',
      version: 2,
      steps: [
        { name: 'work', body: 'child work', x: { harness: {} } },
        { name: 'deep', calls: 'grand' },
      ],
      pins: [{ call: 'deep', name: 'grand', version: 1, hash: 'grandhash1' }],
    },
    grandhash1: {
      name: 'grand',
      hash: 'grandhash1',
      version: 1,
      steps: [{ name: 'leaf', body: 'grand leaf', x: { harness: {} } }],
    },
  },
};
const bundleDir = (name: string, hash: string): string => join(cacheDir, 'bundles', name, hash);

/** Read one written `steps/<step>.json` back as data. */
const readSpec = (hashDir: string, step: string): unknown =>
  JSON.parse(readFileSync(join(hashDir, 'steps', `${step}.json`), 'utf8'));

test('prepare caches the parent AND each pinned child and grandchild with normalized step specs', async () => {
  const { server, origin } = await startHub(() => enrichedBody(PINNED_PARENT));
  try {
    const r = await runPrepare(['parent', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    // Parent: its one agent step normalized; the calls step yields no spec.
    assert.ok(existsSync(join(bundleDir('parent', 'parenthash01'), 'steps', 'plan.json')));
    assert.equal(existsSync(join(bundleDir('parent', 'parenthash01'), 'steps', 'sub.json')), false);
    // Child cached under its own hash dir with its agent step normalized.
    assert.ok(existsSync(join(bundleDir('child', 'childhash01'), 'bundle.json')), 'child bundle.json');
    assert.ok(existsSync(join(bundleDir('child', 'childhash01'), 'steps', 'work.json')), 'child step spec');
    // Grandchild cached too (flat map, no recursion needed).
    assert.ok(existsSync(join(bundleDir('grand', 'grandhash1'), 'bundle.json')), 'grandchild bundle.json');
    assert.ok(existsSync(join(bundleDir('grand', 'grandhash1'), 'steps', 'leaf.json')), 'grandchild step spec');
    assert.match(r.stdout, /cached pinned child 'child'@childhash01/);
    assert.match(r.stdout, /cached pinned child 'grand'@grandhash1/);
  } finally {
    await closed(server);
  }
});

test('the persisted parent bundle.json carries pins and does NOT carry children', async () => {
  const { server, origin } = await startHub(() => enrichedBody(PINNED_PARENT));
  try {
    await runPrepare(['parent', '--origin', origin]);
    const persisted = JSON.parse(readFileSync(join(bundleDir('parent', 'parenthash01'), 'bundle.json'), 'utf8')) as {
      def: { pins?: unknown; children?: unknown };
    };
    assert.deepEqual(persisted.def.pins, [{ call: 'sub', name: 'child', version: 2, hash: 'childhash01' }]);
    assert.equal('children' in persisted.def, false, 'children map is never persisted inside the parent');
    // The child's own bundle carries ITS pins (grandchild), not a children map.
    const childPersisted = JSON.parse(readFileSync(join(bundleDir('child', 'childhash01'), 'bundle.json'), 'utf8')) as {
      def: { pins?: unknown; children?: unknown };
    };
    assert.deepEqual(childPersisted.def.pins, [{ call: 'deep', name: 'grand', version: 1, hash: 'grandhash1' }]);
    assert.equal('children' in childPersisted.def, false);
  } finally {
    await closed(server);
  }
});

test('a second prepare of a pinned parent is idempotent (children untouched)', async () => {
  const { server, origin } = await startHub(() => enrichedBody(PINNED_PARENT));
  try {
    await runPrepare(['parent', '--origin', origin]);
    const r = await runPrepare(['parent', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /idempotent/);
    assert.match(r.stdout, /cached pinned child 'child'@childhash01 \(idempotent/);
  } finally {
    await closed(server);
  }
});

test('pruning is pin-aware: a pinned child hash survives a direct re-prepare of the child', async () => {
  // Serve the parent (pins child@childhash01) and, by name, the child itself at
  // successive hashes h2, h3 as an independent workflow (no pins on those).
  let childHash = 'childhash02';
  const routes = (): Record<string, Record<string, unknown>> => ({
    parent: PINNED_PARENT,
    child: { name: 'child', hash: childHash, version: 9, steps: [{ name: 'work', body: 'child work', x: { harness: {} } }] },
  });
  const { server, origin } = await startRoutingHub(routes);
  try {
    // 1) Prepare the parent → caches child@childhash01 (pinned).
    await runPrepare(['parent', '--origin', origin]);
    // 2) Prepare the child directly at childhash02 → h01 pinned survives beside h02.
    await runPrepare(['child', '--origin', origin]);
    let dirs = readdirSync(join(cacheDir, 'bundles', 'child')).sort();
    assert.deepEqual(dirs, ['childhash01', 'childhash02'], 'pinned childhash01 survives beside the freshly prepared childhash02');
    // 3) Prepare the child again at childhash03 → the UNPINNED childhash02 is pruned; the pinned childhash01 survives.
    childHash = 'childhash03';
    const r = await runPrepare(['child', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    dirs = readdirSync(join(cacheDir, 'bundles', 'child')).sort();
    assert.deepEqual(dirs, ['childhash01', 'childhash03'], 'unpinned childhash02 pruned; pinned childhash01 immortal');
    assert.match(r.stdout, /pruned superseded hash\(es\): childhash02/);
  } finally {
    await closed(server);
  }
});

test('a no-pins payload writes no child dirs and prints no pinned-child lines (byte-for-byte today)', async () => {
  const { server, origin } = await startHub(() => enrichedBody(DEMO));
  try {
    const r = await runPrepare(['demo', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /cached pinned child/);
    // Only the demo workflow dir exists — no phantom child dirs.
    assert.deepEqual(readdirSync(join(cacheDir, 'bundles')), ['demo']);
  } finally {
    await closed(server);
  }
});

test('prepare fetches, caches, and normalizes every agent step into steps/<step>.json', async () => {
  const { server, origin } = await startHub(() => enrichedBody(DEMO));
  try {
    const r = await runPrepare(['demo', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    const hd = join(cacheDir, 'bundles', 'demo', DEMO['hash'] as string);
    assert.ok(existsSync(join(hd, 'bundle.json')), 'bundle.json written');
    // The legacy per-step harness artifact is gone: nothing renders `.md` now.
    assert.equal(existsSync(join(hd, 'templates')), false, 'no templates/ dir is ever written');

    // The builder's full `x.harness` bag: neutral fields lifted, the step's own
    // `model` lifted, the one non-neutral key riding `extensions` verbatim. The
    // brief is the step body VERBATIM — no tokens, no MCP mount baked in.
    assert.deepEqual(readSpec(hd, 'builder'), {
      step: 'builder',
      brief: 'You are the builder. Implement the plan and open a PR.',
      permissions: {
        tools: ['Read', 'Edit', 'Bash'],
        permissionMode: 'plan',
        maxTurns: 40,
        model: 'opus',
        extensions: { mcpServers: { extra: { command: 'extra-server' } } },
      },
    });
    // An empty bag and NO bag at all both normalize to the same empty struct —
    // the difference is only what prepare reports, not what it writes.
    assert.deepEqual(readSpec(hd, 'reviewer'), {
      step: 'reviewer',
      brief: 'You are the reviewer. Judge the PR.',
      permissions: { extensions: {} },
    });
    assert.deepEqual(readSpec(hd, 'planner'), {
      step: 'planner',
      brief: 'You are the planner. Produce a plan.',
      permissions: { extensions: {} },
    });
    // A executor:command step is not an agent step and gets no spec.
    assert.equal(existsSync(join(hd, 'steps', 'deprovisioner.json')), false);

    assert.match(r.stdout, /normalized 3 step spec\(s\)/);
    // reviewer's `x.harness` is present but EMPTY, planner has none at all —
    // both carry zero options, so both are reported together.
    assert.match(r.stdout, /no harness options declared: reviewer, planner$/m);
    assert.match(r.stdout, /skipped \(executor:command\): deprovisioner/);
  } finally {
    await closed(server);
  }
});

test('a second prepare with the same hash is idempotent (not rewritten)', async () => {
  const { server, origin } = await startHub(() => enrichedBody(DEMO));
  try {
    await runPrepare(['demo', '--origin', origin]);
    const r = await runPrepare(['demo', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /idempotent/);
  } finally {
    await closed(server);
  }
});

test('a republished def (new hash) creates a new cache dir and prunes the old', async () => {
  let def = DEMO;
  const { server, origin } = await startHub(() => enrichedBody(def));
  try {
    await runPrepare(['demo', '--origin', origin]);
    def = { ...DEMO, hash: 'fedcba0987654321' };
    const r = await runPrepare(['demo', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    const dirs = readdirSync(join(cacheDir, 'bundles', 'demo')).sort();
    assert.deepEqual(dirs, ['fedcba0987654321'], 'old hash dir pruned, new one present');
    assert.match(r.stdout, /pruned superseded hash\(es\): abcdef1234567890/);
  } finally {
    await closed(server);
  }
});

test('the D1 hub gap (bodyless agent step) fails with exit 1 and caches nothing', async () => {
  const bodyless = { name: 'demo', hash: 'h1', steps: [{ name: 'builder', x: { harness: {} } }] };
  const { server, origin } = await startHub(() => enrichedBody(bodyless));
  try {
    const r = await runPrepare(['demo', '--origin', origin]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not serve step bodies yet/);
    assert.equal(existsSync(join(cacheDir, 'bundles', 'demo')), false, 'nothing cached on a fetch that cannot compile');
  } finally {
    await closed(server);
  }
});

test('a hub 404 surfaces as exit 1 with the status', async () => {
  const { server, origin } = await startHub(() => ({ status: 404, body: { error: 'not_found', message: 'no such workflow' } }));
  try {
    const r = await runPrepare(['demo', '--origin', origin]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /hub error 404/);
  } finally {
    await closed(server);
  }
});

test('missing --origin and missing settings hubOrigin is a usage error (exit 2)', async () => {
  const r = await runPrepare(['demo']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no hub origin/);
});

test('no Scoped Identity key stored (and no OWENLOOP_TOKEN override) is a refuse (exit 2)', async () => {
  // Empty override + a hermetic empty file store ⇒ the agent slot is absent.
  process.env['OWENLOOP_TOKEN'] = '';
  const r = await runPrepare(['demo', '--origin', 'http://127.0.0.1:1']);
  assert.equal(r.code, 2);
  assert.match(
    r.stderr,
    /no Scoped Identity key for http:\/\/127\.0\.0\.1:1 \(account "default"\) — run: owenloop login --hub http:\/\/127\.0\.0\.1:1 --as agent/,
  );
});

test('OWENLOOP_ACCOUNT names the slot in the refuse hint (agent:ci)', async () => {
  process.env['OWENLOOP_TOKEN'] = '';
  process.env['OWENLOOP_ACCOUNT'] = 'ci';
  const r = await runPrepare(['demo', '--origin', 'http://127.0.0.1:1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /account "ci"\) — run: owenloop login --hub http:\/\/127\.0\.0\.1:1 --as agent:ci/);
});

test('with no OWENLOOP_TOKEN, prepare authenticates with the agent slot token from the store', async () => {
  const { server, origin } = await startHub(() => enrichedBody(DEMO));
  // Seed the agent:default slot for this origin; drop the override.
  const dir = join(homeDir, 'owenloop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ version: 2, hubs: { [origin]: { 'agent:default': { kind: 'agent', accessToken: 'olp_from_store' } } } }),
  );
  process.env['OWENLOOP_TOKEN'] = '';
  try {
    const r = await runPrepare(['demo', '--origin', origin]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /normalized 3 step spec\(s\)/);
  } finally {
    await closed(server);
  }
});

test('prepare reads hubOrigin from settings when --origin is omitted', async () => {
  const { server, origin } = await startHub(() => enrichedBody(DEMO));
  try {
    const cfgDir = join(homeDir, 'owenloop');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify({ hubOrigin: origin }));
    const r = await runPrepare(['demo']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /normalized 3 step spec\(s\)/);
  } finally {
    await closed(server);
  }
});
