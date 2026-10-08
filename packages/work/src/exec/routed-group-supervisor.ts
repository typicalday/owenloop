/**
 * Source for the routed command's retained POSIX process-group leader.
 *
 * Kept as a string so the published TypeScript build carries the exact helper
 * bytes; no untracked executable or runtime path lookup is involved. The
 * parent starts it with Node's own executable and a dedicated IPC descriptor.
 */
export const ROUTED_GROUP_SUPERVISOR = String.raw`
const { spawn, execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');

let token;
let shell;
let shellResult;
let shellExit;
let shellResultSent = false;
let forwardedStdoutBytes = 0;
let forwardedStderrBytes = 0;
let settling = false;
let graceMs = 5000;

function send(message) {
  if (process.connected) process.send({ token, ...message });
}

function fail(type) {
  if (process.connected) process.send({ token, type }, () => process.exit(2));
  else process.exit(2);
}

function sendShellResult() {
  if (shellResultSent || !shellExit) return;
  shellResultSent = true;
  // The shell's pipes may stay open through a background descendant. Bound
  // direct-result capture after the shell exits; settlement owns that group.
  shell.stdout?.destroy();
  shell.stderr?.destroy();
  let pending = 2;
  const flushed = () => {
    if (--pending === 0) send({ ...shellExit, stdoutBytes: forwardedStdoutBytes, stderrBytes: forwardedStderrBytes });
  };
  process.stdout.write('', flushed);
  process.stderr.write('', flushed);
}

function ownGroup() {
  const ps = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  try {
    const group = Number(execFileSync(ps, ['-o', 'pgid=', '-p', String(process.pid)],
      { encoding: 'utf8', timeout: 1000 }).trim());
    return Number.isSafeInteger(group) && group === process.pid;
  } catch {
    return false;
  }
}

function teardown() {
  if (settling) return;
  settling = true;
  if (!ownGroup()) {
    fail('unsafe-group');
    return;
  }
  send({ type: 'teardown-started' });
  // The retained leader is still a member of this group. It survives TERM.
  // Only this leader sends group signals; its parent never signals a stale PGID.
  try { process.kill(0, 'SIGTERM'); } catch { fail('signal-error'); return; }
  setTimeout(() => {
    if (!ownGroup()) {
      fail('unsafe-group');
      return;
    }
    // This is the last signal. SIGKILL necessarily kills this sentinel too.
    try { process.kill(0, 'SIGKILL'); } catch { fail('signal-error'); }
  }, graceMs);
}

process.on('SIGTERM', () => {});
process.on('disconnect', () => teardown());
process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start' && token === undefined) {
    token = message.token;
    graceMs = Number.isSafeInteger(message.graceMs) && message.graceMs >= 0 && message.graceMs <= 30000
      ? message.graceMs : 5000;
    if (typeof token !== 'string' || token.length < 16 || typeof message.command !== 'string' || !ownGroup()) {
      fail('unsafe-group');
      return;
    }
    try {
      shell = spawn('/bin/sh', ['-c', message.command], {
        cwd: message.cwd, env: message.env, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      send({ type: 'shell-result', code: null, signal: null, error: String(error) });
      return;
    }
    shell.stdout.pipe(process.stdout, { end: false });
    shell.stderr.pipe(process.stderr, { end: false });
    shell.stdout.on('data', (chunk) => { forwardedStdoutBytes += chunk.length; });
    shell.stderr.on('data', (chunk) => { forwardedStderrBytes += chunk.length; });
    shell.on('error', (error) => {
      if (!shellResult) {
        shellResult = { type: 'shell-result', code: null, signal: null, error: String(error) };
        shellExit = shellResult;
        if (shell.pid === undefined) {
          // No shell or descendant was created. Do not retain an idle sentinel
          // after an asynchronous spawn failure.
          if (process.connected) process.send({ token, ...shellResult, stdoutBytes: 0, stderrBytes: 0 },
            () => process.exit(1));
          else process.exit(1);
        } else {
          sendShellResult();
          teardown();
        }
      }
    });
    shell.on('exit', (code, signal) => {
      if (!shellResult) {
        shellResult = { type: 'shell-result', code, signal };
        shellExit = shellResult;
        // A descendant inheriting stdout/stderr must not hold direct-shell
        // completion open. Normal shell output drains before this fallback.
        setTimeout(sendShellResult, 200).unref();
      }
    });
    shell.on('close', (code, signal) => {
      if (!shellResult) {
        shellResult = { type: 'shell-result', code, signal };
        shellExit = shellResult;
      }
      sendShellResult();
    });
    send({ type: 'ready', pgid: process.pid, shellPid: shell.pid });
  } else if (message.type === 'settle' && message.token === token) {
    teardown();
  }
});
`;
