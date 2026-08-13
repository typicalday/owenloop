/**
 * `.dev/hooks/pre-deprovision` — the worktree lifecycle hook `dev remove`
 * invokes to reclaim a worktree's port allocation.
 *
 * The hook is shell, not TypeScript, so these are black-box tests: build a
 * throwaway project container on disk, run the hook with cwd set inside it
 * exactly as `bin/dev`'s `run_lifecycle_hook` does, and assert on the resulting
 * `.ports` file, the exit status, and the diagnostics.
 *
 * Two safety rules shape the whole file:
 *
 * 1. **No real `lsof`, ever.** Every run gets a stub `lsof` first on PATH. A
 *    test that consulted the real one would discover whatever the developer
 *    happens to be running on those ports and kill it. The stub also makes the
 *    kill path deterministic on Linux CI, where `lsof` may not be installed at
 *    all.
 * 2. **The only processes signalled are ones these tests spawned.** The kill
 *    tests start a disposable Node process, point the stub at it, and assert it
 *    died. Nothing else on the machine is reachable from here.
 *
 * The hook is invoked through `/bin/bash` rather than by its shebang, because
 * `#!/usr/bin/env bash` picks up Homebrew's Bash 5 on a developer Mac and hides
 * every Bash 3.2 violation — and macOS `/bin/bash` is 3.2.57, which is the
 * floor the hook has to hold. One test deliberately runs it the other way, by
 * its shebang, so the shebang itself stays covered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, '.dev/hooks/pre-deprovision');

/** Default project config: exactly what owenloop's real `.dev/project.sh` declares. */
const EMPTY_PROJECT_PORTS = 'PROJECT_PORTS=()\nPROJECT_DIST_FILES=()\n';

/** One port per block keeps the diagnostics in the kill tests to a single line per pass. */
const ONE_PORT_BLOCKS = 'fixture 47100 1 10\n';

type Fixture = {
  root: string;
  projectRoot: string;
  registryPath: string;
  portsPath: string;
  binDir: string;
};

/**
 * A throwaway `<root>/fixture/` container in the worktree layout the hook
 * expects: `.ports` and `ports.registry` at the container root, `main/` beside
 * `wt/<name>/`. The registry's project column must equal the container's
 * directory name — that is how the hook keys the lookup.
 */
function makeFixture(opts: {
  ports: string;
  registry?: string;
  projectConfig?: string;
  worktrees?: string[];
}): Fixture {
  // realpath up front: macOS `$TMPDIR` is a symlink into `/private/var`, and the
  // hook resolves cwd with `pwd -P`. Without this the paths in the hook's
  // diagnostics would not match the paths the assertions were built from.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owenloop-hooks-')));
  const projectRoot = join(root, 'fixture');
  const binDir = join(root, 'bin');

  mkdirSync(join(projectRoot, 'main/.dev'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  for (const name of opts.worktrees ?? ['feature']) {
    mkdirSync(join(projectRoot, 'wt', name), { recursive: true });
  }

  writeFileSync(join(projectRoot, 'main/.dev/project.sh'), opts.projectConfig ?? EMPTY_PROJECT_PORTS);
  writeFileSync(join(projectRoot, '.ports'), opts.ports);
  writeFileSync(join(projectRoot, 'ports.registry'), opts.registry ?? ONE_PORT_BLOCKS);

  // The stub stands in for lsof on PATH. With no FAKE_LISTENER_PID set it
  // reports nothing and exits 1, which is what real lsof does for an idle port.
  // With one set, it reports that PID only while the process still HOLDS ITS
  // SOCKETS, so the hook's post-SIGTERM re-derivation sees the listener
  // disappear rather than a list frozen before the signal.
  //
  // The zombie check is what makes that faithful, and it is not a detail.
  // `kill -0` alone succeeds against a zombie — a process that has exited but
  // whose parent has not reaped it — and these tests spawn the sleeper from the
  // very process that then blocks in `spawnSync`, so it CANNOT reap until the
  // hook returns. A `kill -0` stub therefore reports a dead listener for the
  // whole run and provokes a SIGKILL at a PID the kernel has already freed:
  // exactly the stale-PID kill the hook re-derives to avoid. The kernel closes
  // sockets at exit, well before reaping, so real lsof goes quiet immediately;
  // matching that is the difference between testing the hook and testing the
  // stub's bug.
  const stub = join(binDir, 'lsof');
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      '[ -n "${FAKE_LISTENER_PID:-}" ] || exit 1',
      'state=$(ps -o stat= -p "$FAKE_LISTENER_PID" 2>/dev/null) || exit 1',
      'case "$state" in "" | Z*) exit 1 ;; esac',
      'echo "$FAKE_LISTENER_PID"',
      '',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);

  return { root, projectRoot, registryPath: join(projectRoot, 'ports.registry'), portsPath: join(projectRoot, '.ports'), binDir };
}

/**
 * A PATH holding exactly the external commands the hook uses — and no `lsof`.
 *
 * Filtering `lsof`'s directory out of the real PATH would not work: on Linux it
 * sits in `/usr/bin` next to `awk` and `mv`, so removing that directory would
 * starve the hook of everything and the test would pass for the wrong reason.
 * Symlinking the wanted tools into a fresh directory makes the absence of
 * `lsof` the only variable, on both macOS and Linux.
 */
function makeLsoflessBinDir(root: string): string {
  const dir = join(root, 'no-lsof-bin');
  mkdirSync(dir, { recursive: true });
  for (const tool of ['awk', 'mv', 'rm', 'sleep']) {
    const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    assert.ok(resolved, `cannot resolve ${tool} to build the lsof-less PATH`);
    symlinkSync(resolved, join(dir, tool));
  }
  return dir;
}

function worktreePath(f: Fixture, name: string): string {
  return name === 'main' ? join(f.projectRoot, 'main') : join(f.projectRoot, 'wt', name);
}

/**
 * Run the hook exactly as `run_lifecycle_hook` does: no arguments, cwd set to
 * the worktree being reclaimed, and `DEV_HOME` / `DEV_REPO_ROOT` /
 * `DEV_PORTS_REGISTRY` exported.
 */
function runHook(f: Fixture, worktree: string, extraEnv: Record<string, string> = {}, viaShebang = false) {
  const argv = viaShebang ? [] : [HOOK];
  const command = viaShebang ? HOOK : '/bin/bash';
  return spawnSync(command, argv, {
    cwd: worktreePath(f, worktree),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.binDir}:${process.env.PATH ?? ''}`,
      DEV_HOME: f.root,
      DEV_REPO_ROOT: f.projectRoot,
      DEV_PORTS_REGISTRY: f.registryPath,
      ...extraEnv,
    },
  });
}

function ports(f: Fixture): string {
  return readFileSync(f.portsPath, 'utf8');
}

/**
 * A disposable process for the kill tests to signal. `ignoreTerm` installs a
 * no-op SIGTERM handler, which is how a process gets to prove the hook escalates
 * to SIGKILL.
 */
function spawnSleeper(ignoreTerm: boolean): { pid: number; exited: Promise<NodeJS.Signals | null> } {
  const script = ignoreTerm
    ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
    : 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.on('exit', (_code, signal) => resolve(signal));
  });
  assert.ok(typeof child.pid === 'number', 'sleeper failed to spawn');
  return { pid: child.pid, exited };
}

/** Reject rather than hang if the hook failed to signal the sleeper at all. */
async function exitedWithin(exited: Promise<NodeJS.Signals | null>, ms: number): Promise<NodeJS.Signals | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`process still alive after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([exited, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('removes the worktree row and leaves main, siblings, comments and blanks byte-identical', () => {
  const f = makeFixture({
    ports: '# port map\nmain 0\nfeature 1\n\nother 2\n',
    worktrees: ['feature', 'other'],
  });
  try {
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ports(f), '# port map\nmain 0\n\nother 2\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('removes every duplicate row left by an interrupted provision', () => {
  const f = makeFixture({ ports: 'main 0\nfeature 1\nfeature 2\n' });
  try {
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ports(f), 'main 0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('refuses to touch .ports when invoked from the main worktree', () => {
  const before = 'main 0\nfeature 1\n';
  const f = makeFixture({ ports: before });
  try {
    const result = runHook(f, 'main');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ports(f), before);
    assert.match(result.stderr, /refusing to reclaim the main port mapping/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('matches the worktree name as a whole field, so `api` never removes `api-v2`', () => {
  const f = makeFixture({ ports: 'main 0\napi-v2 1\napi 2\n', worktrees: ['api', 'api-v2'] });
  try {
    const result = runHook(f, 'api');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ports(f), 'main 0\napi-v2 1\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('tolerates an empty PROJECT_PORTS array under set -u on Bash 3.2', () => {
  // The named hard constraint. macOS /bin/bash is 3.2.57, where expanding an
  // EMPTY array as "${arr[@]}" under `set -u` aborts the script — Bash 4.4+
  // expands it to nothing instead. owenloop's real .dev/project.sh declares
  // PROJECT_PORTS=(), so this is the live configuration, not a hypothetical.
  const f = makeFixture({ ports: 'main 0\nfeature 1\n', projectConfig: EMPTY_PROJECT_PORTS });
  try {
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /unbound variable/);
    assert.equal(ports(f), 'main 0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a .dev/project.sh that trips set -u still cannot block the row removal', () => {
  // project.sh is local, gitignored, hand-edited state. Sourcing it must not be
  // able to abort the hook before the row is reclaimed, or one bad local file
  // reinstates the exact leak this hook fixes.
  const f = makeFixture({ ports: 'main 0\nfeature 1\n', projectConfig: 'BROKEN="${THIS_IS_NOT_SET}"\n' });
  try {
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ports(f), 'main 0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a worktree with no row is a silent no-op', () => {
  const before = 'main 0\nother 2\n';
  const f = makeFixture({ ports: before, worktrees: ['feature', 'other'] });
  try {
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ports(f), before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a missing .ports file is a no-op, not an error', () => {
  const f = makeFixture({ ports: 'main 0\nfeature 1\n' });
  try {
    rmSync(f.portsPath);
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /nothing to reclaim/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a non-numeric registry allocation skips the kill but still reclaims the row', () => {
  // The safety case: nothing derived from a malformed registry may reach `kill`,
  // where a negative value would be read as a process GROUP. The row still has
  // to go — a registry needing cleanup is what this hook is for.
  const f = makeFixture({ ports: 'main 0\nfeature 1\n', registry: 'fixture not-a-number 10 10\n' });
  try {
    const sleeper = spawnSleeper(false);
    try {
      const result = runHook(f, 'feature', { FAKE_LISTENER_PID: String(sleeper.pid) });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /invalid numeric port allocation/);
      assert.doesNotMatch(result.stderr, /SIGTERM|SIGKILL/);
      assert.equal(ports(f), 'main 0\n');
      assert.doesNotThrow(() => process.kill(sleeper.pid, 0), 'the sleeper must not have been signalled');
    } finally {
      process.kill(sleeper.pid, 'SIGKILL');
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a non-numeric .ports index skips the kill but still reclaims the row', () => {
  const f = makeFixture({ ports: 'main 0\nfeature notanindex\n' });
  try {
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /invalid numeric port allocation/);
    assert.equal(ports(f), 'main 0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('reports no listeners and reclaims the row when the block is idle', () => {
  const f = makeFixture({ ports: 'main 0\nfeature 1\n' });
  try {
    const result = runHook(f, 'feature');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no listeners on ports 47101-47101/);
    assert.equal(ports(f), 'main 0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('skips the kill phase entirely when lsof is unavailable', () => {
  const f = makeFixture({ ports: 'main 0\nfeature 1\n' });
  try {
    const result = runHook(f, 'feature', { PATH: makeLsoflessBinDir(f.root) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /lsof unavailable/);
    assert.equal(ports(f), 'main 0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('sends SIGTERM to a listener and does not escalate when it exits', async () => {
  const f = makeFixture({ ports: 'main 0\nfeature 1\n' });
  const sleeper = spawnSleeper(false);
  try {
    const result = runHook(f, 'feature', { FAKE_LISTENER_PID: String(sleeper.pid) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`sending SIGTERM to pid ${sleeper.pid}`));
    assert.doesNotMatch(result.stderr, /SIGKILL/);
    assert.match(result.stderr, /exited after SIGTERM/);
    assert.equal(await exitedWithin(sleeper.exited, 5_000), 'SIGTERM');
    assert.equal(ports(f), 'main 0\n');
  } finally {
    try {
      process.kill(sleeper.pid, 'SIGKILL');
    } catch {
      // already gone — the expected outcome
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('escalates to SIGKILL for a listener that ignores SIGTERM', async () => {
  const f = makeFixture({ ports: 'main 0\nfeature 1\n' });
  const sleeper = spawnSleeper(true);
  try {
    const result = runHook(f, 'feature', { FAKE_LISTENER_PID: String(sleeper.pid) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`sending SIGTERM to pid ${sleeper.pid}`));
    assert.match(result.stderr, new RegExp(`sending SIGKILL to pid ${sleeper.pid}`));
    assert.equal(await exitedWithin(sleeper.exited, 5_000), 'SIGKILL');
    assert.equal(ports(f), 'main 0\n');
  } finally {
    try {
      process.kill(sleeper.pid, 'SIGKILL');
    } catch {
      // already gone — the expected outcome
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('runs through its own shebang, not just through an explicit interpreter', () => {
  const f = makeFixture({ ports: 'main 0\nfeature 1\n' });
  try {
    const result = runHook(f, 'feature', {}, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ports(f), 'main 0\n');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('is executable on disk and recorded executable by git', () => {
  // `bin/dev` tests `[[ ! -x "${hook}" ]]` and silently skips a non-executable
  // hook. A mode-644 checkout is therefore indistinguishable from having no
  // hook at all — the exact bug this file fixes — while every test above still
  // passes, because they all hand the script to an interpreter explicitly.
  assert.equal(statSync(HOOK).mode & 0o111, 0o111, 'hook is not executable on disk');

  const ls = spawnSync('git', ['ls-files', '-s', '--', '.dev/hooks/pre-deprovision'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (ls.status !== 0 || ls.stdout.trim() === '') return; // not a git checkout (packed tarball) — the disk mode above still held
  assert.match(ls.stdout, /^100755 /, `git recorded the wrong mode: ${ls.stdout.trim()}`);
});
