import { spawn, ChildProcess } from 'node:child_process';
import { openSync, closeSync, readFileSync, fstatSync, lstatSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REFUSALS = Object.freeze(['ARGUMENT','OWNERSHIP','UNSUPPORTED','ALLOCATION','FILESYSTEM','IDENTITY','CLEANUP','NAPI','CLOSED','CHANNEL','PAIR','ACCESS','SHAPE','CAP','COUNT','STATE','SET_CHANGED','UID','DUPLICATE','DEADLINE','UNKNOWN','FIXTURE']);
export function fixedCode(error) {
  try {
    const d = Object.getOwnPropertyDescriptors(error);
    const v = d.code?.value;
    return typeof v === 'string' && REFUSALS.includes(v) ? v : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}
function need(value) {
  if (!value) throw Object.assign(new Error('FIXTURE'), { code: 'FIXTURE' });
}
function same(a, b) {
  return ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
}
export function loadPrivateBacking(path, sha) {
  need(process.platform === 'linux' && process.versions.node === '22.23.0' && /^[a-f0-9]{64}$/.test(sha));
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const a = fstatSync(fd, { bigint: true });
    need(a.isFile() && a.size > 0n && a.size <= 8388608n && a.nlink === 1n);
    const bytes = readFileSync(fd);
    need(createHash('sha256').update(bytes).digest('hex') === sha);
    need(same(a, fstatSync(fd, { bigint: true })) && same(a, lstatSync(path, { bigint: true })));
    const module = { exports: {} };
    process.dlopen(module, `/proc/self/fd/${fd}`);
    need(same(a, fstatSync(fd, { bigint: true })) && same(a, lstatSync(path, { bigint: true })));
    return createFacade(module.exports, path, sha);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function createFacade(native, artifact, sha) {
  const pairs = new WeakMap(), channels = new WeakMap();
  const target = fileURLToPath(new URL('./target.mjs', import.meta.url));
  const nested = fileURLToPath(new URL('./nested-owner.mjs', import.meta.url));
  function token(map, value) { const t = Object.freeze({}); map.set(t, value); return t; }
  function pair(t) { need(pairs.has(t)); return pairs.get(t); }
  function channel(t) { need(channels.has(t)); return channels.get(t); }
  function genuineSpawn(kind, output) {
    let original;
    try {
      const bound = native.spawnAndBind(() => {
        /* The native function calls this once and binds before returning.
           No yield, next-tick, wait, user callback or nested loop here. */
        original = spawn(process.execPath, [kind === 'TARGET' ? target : nested], {
          detached: false,
          env: kind === 'TARGET' ? {} : { JEV_DESCRIPTOR_ARTIFACT: artifact, JEV_DESCRIPTOR_SHA: sha },
          stdio: kind === 'TARGET' ? ['pipe','pipe','pipe'] : ['pipe','pipe','pipe','ignore',native.senderFD(channel(output))],
        });
        need(Object.getPrototypeOf(original) === ChildProcess.prototype);
        const d = Object.getOwnPropertyDescriptors(original);
        need(Number.isSafeInteger(d.pid?.value) && d.pid.value > 0 && d.exitCode?.value === null && d.signalCode?.value === null);
        return original;
      });
      need(bound.child === original);
      monitor(original);
      return Object.freeze({ original, capability: token(pairs, bound.handle) });
    } catch (error) {
      /* Do not lose the genuine original when acquisition is refused. */
      if (original) {
        monitor(original);
        try { original.stdin.end(); } catch { /* external owner settles uncertainty */ }
      }
      if (original) return Object.freeze({ original, capability: null, refusal: fixedCode(error) });
      throw error;
    }
  }
  return Object.freeze({
    openChannel: () => token(channels, native.createChannel()),
    adoptInheritedChannel: () => token(channels, native.inheritedSender()),
    spawnTarget: () => genuineSpawn('TARGET'),
    spawnNested: output => {
      const bound = genuineSpawn('NESTED', output);
      if (!bound.capability) return bound;
      try { native.attributeOwner(channel(output), pair(bound.capability)); }
      catch (error) {
        try { bound.original.stdin.end(); } catch {}
        return Object.freeze({ ...bound, refusal: fixedCode(error) });
      }
      return bound;
    },
    send: (output, capability) => native.sendPair(channel(output), pair(capability)),
    /* Finite, own-channel negative fixture port; never a general FD sender. */
    sendNegative: (output, capability, mode) => {
      need(['MALFORMED_FRAME','EXTRA_RIGHTS','TRUNCATED_RIGHTS'].includes(mode));
      return native.sendNegative(channel(output), pair(capability), mode);
    },
    negativeDetail: output => {
      const detail = native.negativeDetail(channel(output));
      need(['MALFORMED_FRAME','EXTRA_RIGHTS','CONTROL_TRUNCATED','UNKNOWN'].includes(detail));
      return detail;
    },
    receive: output => token(pairs, native.receivePair(channel(output))),
    sample: capability => native.sample(pair(capability)),
    closePair: capability => native.close(pair(capability)),
    closeChannel: output => native.closeChannel(channel(output)),
  });
}
const streamRecords = new WeakMap();
function monitor(original) {
  let r = streamRecords.get(original);
  if (r) return r;
  r = { bytes: 0, stderr: 0, text: '', stdoutEOF: false, stderrEOF: false,
    stdoutPresent: false, stderrPresent: false, stdinPresent: false,
    closed: false, terminal: false, bad: false, pipeFailed: false,
    setupFailed: false, readyUsed: false, waiters: new Set() };
  /* Store custody before inspecting any optional stream. This never throws
     away an already-created genuine original on absent/failed pipes. */
  streamRecords.set(original, r);
  let resolveClose;
  r.close = new Promise(resolve => { resolveClose = resolve; });
  const wake = () => { for (const fn of [...r.waiters]) { try { fn(); } catch { r.bad = true; } } };
  const attach = (emitter, event, fn, once = false) => {
    try { emitter[once ? 'once' : 'on'](event, fn); return true; }
    catch { r.setupFailed = true; r.bad = true; return false; }
  };
  attach(original, 'error', () => { r.bad = true; wake(); });
  attach(original, 'exit', () => { r.terminal = true; wake(); }, true);
  attach(original, 'close', (code, signal) => {
    r.closed = true; r.terminal = true; r.code = code; r.signal = signal;
    wake(); resolveClose();
  }, true);
  for (const name of ['stdin','stdout','stderr']) {
    let stream;
    try { stream = original[name]; } catch { r.setupFailed = true; }
    const present = stream !== null && stream !== undefined;
    r[`${name}Present`] = present;
    if (!present) { r.bad = true; continue; }
    attach(stream, 'error', () => { r.pipeFailed = true; r.bad = true; wake(); });
    if (name === 'stdin') continue;
    attach(stream, 'end', () => { r[`${name}EOF`] = true; wake(); }, true);
    attach(stream, 'close', () => { if (!r[`${name}EOF`]) { r.pipeFailed = true; r.bad = true; } wake(); }, true);
    attach(stream, 'data', b => {
      if (name === 'stderr') { r.stderr = Math.min(65, r.stderr + b.length); r.bad = true; }
      else {
        r.bytes = Math.min(65, r.bytes + b.length);
        if (r.bytes > 64 || b.some(v => v > 127)) r.bad = true;
        else r.text += b.toString('ascii');
      }
      wake();
    });
  }
  return r;
}
export async function ready(original, word) {
  need(Object.getPrototypeOf(original) === ChildProcess.prototype && (word === 'READY\n' || word === 'NESTED_READY\n'));
  const r = monitor(original);
  need(!r.readyUsed && r.waiters.size === 0);
  r.readyUsed = true;
  let check;
  try {
    await new Promise((resolve, reject) => {
      check = () => {
        if (r.bad || r.setupFailed || r.terminal || r.closed || r.stdoutEOF || r.stderrEOF || !word.startsWith(r.text)) reject(Object.assign(new Error('FIXTURE'), { code: 'FIXTURE' }));
        else if (r.text === word) resolve();
      };
      r.waiters.add(check); check();
    });
  } finally { if (check) r.waiters.delete(check); }
}
export async function endOriginal(original) {
  const r = monitor(original);
  if (!r.closed && r.stdinPresent) {
    try { original.stdin.end(); } catch { r.pipeFailed = true; r.bad = true; }
  }
  await r.close;
  /* Missing pipes on failed spawn are unsupported, not invented EOF. */
  need(r.closed && !r.setupFailed);
  const presentPipeEOF = (!r.stdoutPresent || r.stdoutEOF) && (!r.stderrPresent || r.stderrEOF);
  return Object.freeze({ terminal: true, nodeCloseObserved: true,
    bothPipesEOF: r.stdoutPresent && r.stderrPresent && r.stdoutEOF && r.stderrEOF,
    presentPipeEOF, absentPipe: !r.stdinPresent || !r.stdoutPresent || !r.stderrPresent,
    pipeFailed: r.pipeFailed, code: r.code, signal: r.signal === null ? 'NONE' : 'SIGNAL',
    streamPolicyValid: !r.bad && presentPipeEOF && r.stderr === 0 });
}
