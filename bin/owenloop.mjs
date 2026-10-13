#!/usr/bin/env node
// Thin shim: all real logic lives in src/cli.ts (so it stays testable) and is
// shipped compiled to dist/src/cli.js. Node cannot type-strip files under
// node_modules, so the published package runs plain JS, not TypeScript source.
import { readFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const START_GATE_TIMEOUT_MS = 2 * 60_000;

/**
 * A Shift-spawned worker cannot import or execute the CLI until the parent has
 * durably replaced its reservation with a PID-bearing record. Missing,
 * cancelled, or expired gates fail closed before any role can contact the hub.
 */
async function waitForStartGate(path) {
  const deadline = performance.now() + START_GATE_TIMEOUT_MS;
  for (;;) {
    let signal;
    try {
      signal = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (signal === 'start') {
      await rm(path, { force: true });
      return true;
    }
    if (signal === 'cancel') {
      await rm(path, { force: true });
      return false;
    }
    if (performance.now() >= deadline) {
      await rm(path, { force: true });
      return false;
    }
    await sleep(25);
  }
}

/** The direct routed child must receive Shift's allow before importing CLI code. */
async function acknowledgeRoutedGate(gatePath, handoffPath) {
  const match = /^\.([a-f0-9]{32})\.gate$/.exec(basename(gatePath));
  if (!match || !handoffPath || typeof process.send !== 'function' || !process.connected) return false;
  return new Promise(resolve => {
    let settled = false;
    let parentAllowed = false;
    const finish = allowed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      if (!allowed) {
	try { if (process.connected) process.disconnect(); } catch { /* Parent already closed. */ }
      }
      resolve(allowed);
    };
    const onMessage = message => {
      if (!(message && typeof message === 'object'
	&& Object.keys(message).sort().join(',') === 'dispatchToken,type'
	&& message.type === 'routing-gate-entry-allowed' && message.dispatchToken === match[1])) {
	finish(false);
	return;
      }
      parentAllowed = true;
    };
    const onDisconnect = () => finish(parentAllowed);
    const timer = setTimeout(() => finish(false), 5_000);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    try {
      process.send({ type: 'routing-gate-entered', dispatchToken: match[1],
	routingHandoff: handoffPath }, error => { if (error) finish(false); });
    } catch { finish(false); }
  });
}

const gatePath = process.env.OWENLOOP_START_GATE;
const routingHandoff = process.env.OWENLOOP_ROUTING_HANDOFF;
if (routingHandoff && !gatePath) process.exit(75);
if (gatePath !== undefined && gatePath !== '') {
  let allowed = false;
  try {
    allowed = await waitForStartGate(gatePath);
  } catch (error) {
    process.stderr.write(`owenloop: start gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!allowed) process.exit(75);
  if (routingHandoff && !(await acknowledgeRoutedGate(gatePath, routingHandoff))) process.exit(75);
  delete process.env.OWENLOOP_START_GATE;
}

function handleStreamError(error) {
  if (error?.code === 'EPIPE') return;
  throw error;
}

function drain(stream) {
  return new Promise((resolve) => stream.write('', resolve));
}

process.stdout.on('error', handleStreamError);
process.stderr.on('error', handleStreamError);

const { mainAsync } = await import('../dist/src/cli.js');
mainAsync(process.argv.slice(2)).then(async (code) => {
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
});
