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

import { install, writeFixed, uninstall } from '../loader.mjs';
install();
// This separate private entry is selected only by the trusted local Shift
// composition. Public bin/owenloop.mjs is unchanged. FD4 belongs to this entry;
// the original IPC3 gate above must complete before loading any role code.
import { closeSync } from 'node:fs';
const ENTRY_CODES = new Set(['ACCESS','ALLOCATION','ARGUMENT','CAP','CHANNEL','CLEANUP',
  'CLOSED','COUNT','DEADLINE','DUPLICATE','FILESYSTEM','IDENTITY','NAPI','OWNERSHIP',
  'PAIR','SET_CHANGED','SHAPE','STATE','UID','UNSUPPORTED','UNKNOWN']);
function marker(stage, error) {
  let code = 'UNKNOWN';
  try {
    if (error && typeof error === 'object') {
      const d = Object.getOwnPropertyDescriptor(error, 'code');
      if (d && Object.hasOwn(d, 'value') && typeof d.value === 'string' && ENTRY_CODES.has(d.value)) code = d.value;
    }
  } catch { /* Descriptor traps cannot replace the initiating refusal. */ }
  try { process.stderr.write(`PRIVATE_ROLE_ENTRY_REFUSED/${stage}/${code}\n`); } catch { /* Passive only. */ }
}
function need(value) { if (!value) throw new Error('PRIVATE_ROLE_ENTRY_REFUSED'); }
function buildBinding(value) {
  need(value && typeof value === 'object');
  const d = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(d);
  need(names.every(key => typeof key === 'string') && names.sort().join(',') ===
    'artifact,artifactSha256,compiledSourceManifestSha256,enabled,protocol,sourceCompositionSha256');
  for (const key of names) need(Object.hasOwn(d[key], 'value'));
  const v = Object.fromEntries(names.map(key => [key, d[key].value]));
  need(v.protocol === 'private-routed-role-observer-build-v2' && v.enabled === true);
  need(typeof v.artifact === 'string' && v.artifact.startsWith('/') && !v.artifact.includes('\0'));
  need(typeof v.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(v.artifactSha256));
  need(v.sourceCompositionSha256 === 'b1a4c43f958917eefa203f7b9d836e8d643a4dd6299eaecbd9f99f59abd07008');
  need(typeof v.compiledSourceManifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(v.compiledSourceManifestSha256));
  return v;
}
async function privateMain(argv) {
  let stage = 'ENTRY';
  let rawFD4Owned = true;
  let observer;
  let closeObserver;
  let statusObserver;
  let returnedCode = 1;
  let fd4Adopted = false;
  let cleanupKnown = true;
  let refusal = null;
  try {
    // No ordinary-role fallback: only the actual routed agent-run grammar is
    // delegated. The existing role parser still validates its entire argv.
    need(Boolean(gatePath) && Boolean(routingHandoff));
    need(argv[0] === 'work' && argv[1] === 'agent-run');
    stage = 'BUILD_BINDING';
    const { ROLE_OBSERVER_BUILD } = await import('./private-role-observer-build.mjs');
    const binding = buildBinding(ROLE_OBSERVER_BUILD);
    stage = 'OBSERVER_IMPORT';
    const ownerModule = await import('../dist/packages/work/src/harness/routed-owner-observer.js');
    closeObserver = ownerModule.closeRoutedOwnerRoleObserver;
    statusObserver = ownerModule.roleOwnerObserverStatus;
    stage = 'FD4_ADOPTION';
    // Constructor owns raw FD4 on both load and native-adoption refusal.
    // Never close/retry FD4 again after transferring that obligation.
    rawFD4Owned = false;
    observer = ownerModule.createRoutedOwnerRoleObserver(binding.artifact, binding.artifactSha256);
    fd4Adopted = true;
    stage = 'ROLE_IMPORT';
    // This fixed emitted module and its runner resolve the very same observer
    // URL as above. No query/fragment, alias path, remote module or callback.
    const { run } = await import('../dist/packages/work/src/roles/agent-run.js');
    stage = 'ROLE_RUN';
    returnedCode = await run(argv.slice(2), { ownerObserver: observer });
  } catch (error) {
    marker(stage, error);
    if (error && typeof error === 'object') { try { const d = Object.getOwnPropertyDescriptor(error, 'code'); if (d && Object.hasOwn(d, 'value') && d.value === 'CLEANUP') { cleanupKnown = false; refusal = 'CLEANUP'; } } catch { /* Preserve original refusal. */ } }
    returnedCode = 1;
  } finally {
    if (observer !== undefined) {
      try { closeObserver(observer); const statusRefusal = statusObserver(observer).refusal; if (refusal !== 'CLEANUP') refusal = statusRefusal; if (refusal !== null) cleanupKnown = false; } catch (error) { cleanupKnown = false; refusal = 'CLEANUP'; marker('OBSERVER_CLEANUP', error); }
    } else if (!rawFD4Owned) {
      // Native adoption was attempted without a returned token. No raw retry.
      cleanupKnown = false; refusal = 'CLEANUP';
    } else if (rawFD4Owned) {
      rawFD4Owned = false;
      try { closeSync(4); } catch { cleanupKnown = false; refusal = 'CLEANUP'; marker('RAW_FD4_CLEANUP', { code: 'CLEANUP' }); }
    }
  }
  try { uninstall(); } catch { cleanupKnown = false; refusal = 'CLEANUP'; }
  if (!cleanupKnown) returnedCode = 1;
  try { writeFixed('entry-results/parse.json', { protocol: 'jev-private-entry-parse-result-v1', returnedCode, fd4Adopted, cleanupKnown, refusal, providerStarted: argv[2] === '/parse' && returnedCode === 2 ? false : 'UNPROVED', normalRecoveryAccepted: false }); } catch { returnedCode = 1; }
  return returnedCode;
}
// An ordinary invocation must never adopt or close an undeclared caller FD4.
if (!gatePath || !routingHandoff) process.exit(75);
privateMain(process.argv.slice(2)).then(async code => {
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(code);
});
