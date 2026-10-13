/** Explicit private composition only. No environment-driven addon loading.
 * This module observes originals; normal process/pipe/lifecycle custody remains
 * with the actual spawner. No PID inspector, callback port or fixture monitor. */
import { spawn, ChildProcess, type SpawnOptions } from 'node:child_process';
import { openSync, closeSync, readSync, fstatSync, lstatSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';

type Native = Readonly<Record<string, (...args: unknown[]) => unknown>>;
const CODES = new Set(['ACCESS','ALLOCATION','ARGUMENT','CAP','CHANNEL','CLEANUP','CLOSED',
  'COUNT','DEADLINE','DUPLICATE','FILESYSTEM','IDENTITY','NAPI','OWNERSHIP','PAIR',
  'SET_CHANGED','SHAPE','STATE','UID','UNSUPPORTED','UNKNOWN']);
type RecordState = { child?: ChildProcess; pair?: unknown; channel?: unknown;
  chain?: unknown; refusal?: string; forwarded: boolean };
export interface RoutedOwnerRoleObserver { readonly kind: 'private-role-owner-observer-v1' }
export interface RoutedOwnerOuterObserver { readonly kind: 'private-outer-owner-observer-v1' }
type Role = { native: Native; artifact: string; sha: string; sender: unknown;
  used: boolean; records: WeakMap<ChildProcess, RecordState>; active: Set<RecordState>; refusal?: string };
type Outer = { native: Native; records: WeakMap<ChildProcess, RecordState>; refusal?: string };
const roles = new WeakMap<RoutedOwnerRoleObserver, Role>();
const outers = new WeakMap<RoutedOwnerOuterObserver, Outer>();
function need(value: unknown): asserts value { if (!value) throw new Error('OWNER_OBSERVER_REFUSED'); }
function data(value: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(value, key);
  need(d && Object.hasOwn(d, 'value')); return d.value;
}
function fixed(error: unknown): string {
  try { if (error && typeof error === 'object') {
    const d = Object.getOwnPropertyDescriptor(error, 'code');
    if (d && Object.hasOwn(d, 'value') && typeof d.value === 'string' && CODES.has(d.value)) return d.value;
  } } catch { /* Proxy descriptor traps are caught, never treated as authority. */ }
  return 'UNKNOWN';
}
function joinRefusal(left: string | undefined, right: string | undefined): string | undefined {
  return left === 'CLEANUP' || right === 'CLEANUP' ? 'CLEANUP' : left ?? right;
}
function latch(state: { refusal?: string }, error: unknown): void {
  state.refusal = joinRefusal(state.refusal, fixed(error));
}
function same(a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>): boolean {
  return ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].every(key =>
    Reflect.get(a, key) === Reflect.get(b, key));
}
function load(artifact: string, sha: string): Native {
  need(process.platform === 'linux' && process.versions.node === '22.23.0');
  need(typeof artifact === 'string' && artifact.startsWith('/') && /^[a-f0-9]{64}$/.test(sha));
  let fd: number | undefined;
  let methods: Native | undefined;
  let failed = false;
  let failure: unknown;
  try {
    fd = openSync(artifact, constants.O_RDONLY | constants.O_NOFOLLOW);
    const a = fstatSync(fd, { bigint: true });
    need(a.isFile() && a.nlink === 1n && a.size > 0n && a.size <= 8388608n);
    const bytes = Buffer.alloc(Number(a.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (n === 0) break; count += n;
    }
    need(count === Number(a.size));
    need(createHash('sha256').update(bytes.subarray(0, count)).digest('hex') === sha);
    need(same(a, fstatSync(fd, { bigint: true })) && same(a, lstatSync(artifact, { bigint: true })));
    const module = { exports: {} as object }; process.dlopen(module, `/proc/self/fd/${fd}`);
    need(same(a, fstatSync(fd, { bigint: true })) && same(a, lstatSync(artifact, { bigint: true })));
    const loaded: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of ['spawnAndBind','createChannel','inheritedSender','senderFD','attributeOwner',
      'receiveImportedPair','sendBoundOwnerChain','receiveBoundOwnerChain','sampleBoundOwnerChain',
      'close','closeChannel','closeRelay']) {
      const method = data(module.exports, name); need(typeof method === 'function');
      loaded[name] = (...args) => Reflect.apply(method, module.exports, args);
    }
    methods = Object.freeze(loaded);
  } catch (error) {
    failed = true; failure = error;
  }
  // Close the held descriptor once before returning or rethrowing. A close
  // refusal takes precedence over load failure and cannot be masked by it.
  if (fd !== undefined) try { closeSync(fd); } catch {
    throw Object.assign(new Error('OWNER_OBSERVER_REFUSED'), { code: 'CLEANUP' });
  }
  if (failed) throw failure;
  return methods!;
}
function capture(native: Native, command: string, args: string[], options: SpawnOptions,
  state: RecordState): ChildProcess {
  try {
    const result = native.spawnAndBind!(() => {
      // Exactly one real spawn, on this stack; no user callback or PID input.
      state.child = spawn(command, args, options);
      need(Object.getPrototypeOf(state.child) === ChildProcess.prototype);
      const pid = data(state.child, 'pid');
      need(Number.isSafeInteger(pid) && (pid as number) > 0
        && data(state.child, 'exitCode') === null && data(state.child, 'signalCode') === null);
      return state.child;
    });
    need(result && typeof result === 'object' && data(result, 'child') === state.child);
    state.pair = data(result, 'handle'); need(state.pair);
  } catch (error) {
    latch(state, error);
    // Acquisition refusal never abandons a successfully created original.
    // A real spawn throw before returning a ChildProcess keeps its error.
    if (!state.child) throw error;
  }
  return state.child!;
}
function close(native: Native, state: { refusal?: string }, method: string, value: unknown): void {
  if (value === undefined) return;
  try { native[method]!(value); } catch (error) {
    if (fixed(error) !== 'CLOSED') latch(state, error);
  }
}
export function createRoutedOwnerOuterObserver(artifact: string, sha: string): RoutedOwnerOuterObserver {
  const token = Object.freeze({ kind: 'private-outer-owner-observer-v1' as const });
  outers.set(token, { native: load(artifact, sha), records: new WeakMap() }); return token;
}
export function createRoutedOwnerRoleObserver(artifact: string, sha: string): RoutedOwnerRoleObserver {
  let native: Native;
  try { native = load(artifact, sha); } catch (error) {
    // The trusted private entry owns inherited FD4 even if addon loading fails.
    // No native adoption was attempted, so this is one close, not a retry.
    try { closeSync(4); } catch {
      throw Object.assign(new Error('OWNER_OBSERVER_REFUSED'), { code: 'CLEANUP' });
    }
    throw error;
  }
  // This explicit trusted entry must run before any nested spawn. The native
  // method checks the direct parent's socket creator and closes inherited FD4.
  const sender = native.inheritedSender!();
  const token = Object.freeze({ kind: 'private-role-owner-observer-v1' as const });
  roles.set(token, { native, artifact, sha, sender, used: false, records: new WeakMap(), active: new Set() }); return token;
}
export function spawnObservedRole(observer: RoutedOwnerOuterObserver, command: string,
  args: string[], options: SpawnOptions): ChildProcess {
  const owner = outers.get(observer); need(owner);
  const state: RecordState = { forwarded: false };
  let observedOptions = options;
  try {
    need(Array.isArray(options.stdio) && options.stdio.length === 4 && options.stdio[3] === 'ipc');
    state.channel = owner.native.createChannel!();
    observedOptions = { ...options, stdio: [...options.stdio, owner.native.senderFD!(state.channel) as number] };
  } catch (error) {
    latch(state, error); close(owner.native, state, 'closeChannel', state.channel);
    // No child was started. Normal spawn still occurs exactly once, without
    // observer configuration or extra descriptors when setup refused.
    owner.refusal = joinRefusal(owner.refusal, state.refusal);
    state.child = spawn(command, args, options); owner.records.set(state.child, state); return state.child;
  }
  let child: ChildProcess;
  try { child = capture(owner.native, command, args, observedOptions, state); }
  catch (error) { close(owner.native, state, 'closeChannel', state.channel);
    owner.refusal = joinRefusal(owner.refusal, state.refusal); throw error; }
  owner.records.set(child, state);
  try { if (!state.refusal) owner.native.attributeOwner!(state.channel, state.pair); }
  catch (error) { latch(state, error); }
  if (state.refusal) {
    close(owner.native, state, 'closeChannel', state.channel);
    close(owner.native, state, 'close', state.pair);
    owner.refusal = joinRefusal(owner.refusal, state.refusal);
  }
  return child;
}
export function spawnObservedSupervisor(observer: RoutedOwnerRoleObserver,
  source: string, env: Record<string, string | undefined>): ChildProcess {
  const owner = roles.get(observer); need(owner);
  const state: RecordState = { forwarded: false };
  const options: SpawnOptions = { detached: true, stdio: ['pipe','pipe','pipe','ipc'], env };
  let observedOptions = options;
  let args = ['-e', source];
  try {
    need(!owner.used); owner.used = true;
    state.channel = owner.native.createChannel!();
    observedOptions = { ...options, stdio: ['pipe','pipe','pipe','ipc', owner.native.senderFD!(state.channel) as number] };
    args = ['-e', source, '--', '--private-owner-observer-v1', owner.artifact, owner.sha];
  } catch (error) {
    latch(state, error); latch(owner, error); close(owner.native, state, 'closeChannel', state.channel);
    close(owner.native, state, 'closeChannel', owner.sender);
    owner.refusal = joinRefusal(owner.refusal, state.refusal);
    state.child = spawn(process.execPath, ['-e', source], options);
    owner.records.set(state.child, state); owner.active.add(state); return state.child;
  }
  let child: ChildProcess;
  try { child = capture(owner.native, process.execPath, args, observedOptions, state); }
  catch (error) { close(owner.native, state, 'closeChannel', state.channel);
    owner.refusal = joinRefusal(owner.refusal, state.refusal); throw error; }
  owner.records.set(child, state); owner.active.add(state);
  try { if (!state.refusal) owner.native.attributeOwner!(state.channel, state.pair); }
  catch (error) { latch(state, error); latch(owner, error); }
  if (state.refusal) {
    close(owner.native, state, 'closeChannel', state.channel);
    close(owner.native, state, 'close', state.pair);
    close(owner.native, state, 'closeChannel', owner.sender);
    owner.refusal = joinRefusal(owner.refusal, state.refusal);
  }
  return child;
}
/** Called on the existing valid ready message, without a wait/retry/hold.
 * Failure changes observer evidence only; normal ready/stream custody proceeds. */
export function forwardObservedProvider(observer: RoutedOwnerRoleObserver, child: ChildProcess): void {
  const owner = roles.get(observer); if (!owner) return;
  const state = owner.records.get(child); if (!state || state.forwarded) return;
  state.forwarded = true;
  let imported: unknown;
  try {
    need(!state.refusal && state.channel && state.pair && !owner.refusal);
    imported = owner.native.receiveImportedPair!(state.channel, state.pair);
    owner.native.sendBoundOwnerChain!(owner.sender, imported);
  } catch (error) { latch(state, error); latch(owner, error); }
  finally {
    close(owner.native, state, 'closeRelay', imported);
    close(owner.native, state, 'closeChannel', state.channel);
    close(owner.native, state, 'closeChannel', owner.sender);
    owner.refusal = joinRefusal(owner.refusal, state.refusal);
  }
}
export function closeObservedSupervisor(observer: RoutedOwnerRoleObserver, child: ChildProcess): void {
  const owner = roles.get(observer); if (!owner) return;
  const state = owner.records.get(child); if (!state) return;
  close(owner.native, state, 'closeChannel', state.channel);
  close(owner.native, state, 'closeChannel', owner.sender);
  close(owner.native, state, 'close', state.pair);
  owner.refusal = joinRefusal(owner.refusal, state.refusal);
}
/** Private synchronous collector: accepts only the retained original object.
 * No exception is a production restart/stop instruction or absence proof. */
export function sampleObservedRole(observer: RoutedOwnerOuterObserver, child: ChildProcess): unknown {
  const owner = outers.get(observer); need(owner);
  const state = owner.records.get(child); need(state && !state.refusal && state.channel && state.pair);
  try {
    state.chain ??= owner.native.receiveBoundOwnerChain!(state.channel, state.pair);
    return owner.native.sampleBoundOwnerChain!(state.chain);
  } catch (error) {
    latch(state, error);
    close(owner.native, state, 'closeRelay', state.chain);
    close(owner.native, state, 'closeChannel', state.channel);
    close(owner.native, state, 'close', state.pair);
    owner.refusal = joinRefusal(owner.refusal, state.refusal);
    throw error; // cleanup classification never replaces initiating sample error
  }
}
export function closeObservedRole(observer: RoutedOwnerOuterObserver, child: ChildProcess): void {
  const owner = outers.get(observer); if (!owner) return;
  const state = owner.records.get(child); if (!state) return;
  close(owner.native, state, 'closeRelay', state.chain);
  close(owner.native, state, 'closeChannel', state.channel);
  close(owner.native, state, 'close', state.pair);
  owner.refusal = joinRefusal(owner.refusal, state.refusal);
}
export function observedOwnerStatus(observer: RoutedOwnerOuterObserver | RoutedOwnerRoleObserver,
  child: ChildProcess): Readonly<{ protocol: string; state: string; refusal: string | null; runtimeAccepted: false }> {
  const owner = outers.get(observer as RoutedOwnerOuterObserver) ?? roles.get(observer as RoutedOwnerRoleObserver);
  const record = owner?.records.get(child);
  const refusal = joinRefusal(owner?.refusal, record?.refusal);
  return Object.freeze({ protocol: 'private-original-owner-observer-status-v1',
    state: !record ? 'UNAVAILABLE' : refusal ? 'REFUSED' : record.forwarded || record.chain ? 'CAPTURED' : 'PENDING',
    refusal: refusal ?? null, runtimeAccepted: false });
}

export function closeRoutedOwnerRoleObserver(observer: RoutedOwnerRoleObserver): void {
  const owner = roles.get(observer); if (!owner) return;
  for (const state of owner.active) {
    close(owner.native, state, 'closeChannel', state.channel);
    close(owner.native, state, 'close', state.pair);
    owner.refusal = joinRefusal(owner.refusal, state.refusal);
  }
  owner.active.clear();
  close(owner.native, owner, 'closeChannel', owner.sender);
}

/** Fixed status even when normal startup returns no issued custody token. */
export function outerOwnerObserverStatus(observer: RoutedOwnerOuterObserver):
  Readonly<{ protocol: string; refusal: string | null; runtimeAccepted: false }> {
  const owner = outers.get(observer); need(owner);
  return Object.freeze({ protocol: 'private-outer-owner-observer-status-v1',
    refusal: owner.refusal ?? null, runtimeAccepted: false });
}
