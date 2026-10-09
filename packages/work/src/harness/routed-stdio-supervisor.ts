/** Retained leader for one routed JSON-RPC provider process group.
 *
 * The helper is embedded in the tracked build. It forwards stdio as byte
 * streams and keeps the original group identity alive after provider exit.
 * Only this leader signals its own group; its parent never signals a stale
 * negative PID after a direct provider exit.
 */
export const ROUTED_STDIO_SUPERVISOR = String.raw`
const { spawn, execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');

let token;
let provider;
let providerExit;
let forwardedStdoutBytes = 0;
let forwardedStderrBytes = 0;
let started = false;
let settling = false;
let graceMs = 2000;

function send(type, detail = {}) {
  if (process.connected) process.send({ token, type, ...detail });
}

function fail(type) {
  if (process.connected) process.send({ token, type }, () => process.exit(2));
  else process.exit(2);
}

function ownGroup() {
  const ps = existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps';
  try {
    const group = Number(execFileSync(ps, ['-o', 'pgid=', '-p', String(process.pid)],
      { encoding: 'utf8', timeout: 1000 }).trim());
    return Number.isSafeInteger(group) && group === process.pid;
  } catch { return false; }
}

function settle() {
  if (settling) return;
  settling = true;
  if (!ownGroup()) { fail('unsafe-group'); return; }
  send('teardown-started');
  try { process.kill(0, 'SIGTERM'); }
  catch { fail('signal-error'); return; }
  setTimeout(() => {
    if (!ownGroup()) { fail('unsafe-group'); return; }
    // This is the last group signal. The retained leader dies with the group.
    try { process.kill(0, 'SIGKILL'); }
    catch { fail('signal-error'); }
  }, graceMs);
}

process.on('SIGTERM', () => {});
process.on('disconnect', settle);
process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'start' && !started) {
    started = true;
    token = message.token;
    graceMs = Number.isSafeInteger(message.graceMs) && message.graceMs >= 0 && message.graceMs <= 30000
      ? message.graceMs : 2000;
    if (typeof token !== 'string' || token.length < 16 ||
      typeof message.command !== 'string' || !Array.isArray(message.args) || !ownGroup()) {
      fail('unsafe-group'); return;
    }
    try {
      provider = spawn(message.command, message.args, {
	cwd: message.cwd, env: message.env, detached: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      provider.stdin.on('error', () => {});
      process.stdin.pipe(provider.stdin);
      provider.stdout.pipe(process.stdout, { end: false });
      provider.stderr.pipe(process.stderr, { end: false });
      provider.stdout.on('data', chunk => { forwardedStdoutBytes += chunk.length; });
      provider.stderr.on('data', chunk => { forwardedStderrBytes += chunk.length; });
      provider.on('error', error => {
	send('provider-error', { error: String(error) });
	if (provider.pid === undefined) settle();
      });
      provider.on('exit', (code, signal) => { providerExit = { code, signal }; });
      provider.on('close', (code, signal) => {
	// Provider exit can precede the final stdout JSON-RPC frame. Close tells us
	// source pipes ended; empty writes then wait for forwarded bytes to flush.
	const result = providerExit || { code, signal };
	let pending = 2;
	const flushed = () => { if (--pending === 0) send('provider-exit', {
	  ...result, stdoutBytes: forwardedStdoutBytes, stderrBytes: forwardedStderrBytes,
	}); };
	process.stdout.write('', flushed);
	process.stderr.write('', flushed);
      });
      send('ready', { pgid: process.pid, providerPid: provider.pid ?? null });
    } catch (error) {
      send('provider-error', { error: String(error) });
      settle();
    }
  } else if (message.type === 'settle' && message.token === token) {
    settle();
  }
});
`;
