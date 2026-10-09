/** Shift-owned, credential-free provisional definition snapshot for one routed
 * dispatch. Bytes enter this private store, never the operator's ordinary
 * store. Current roles remain fenced. Their future consume path must recheck
 * fresh parent trust and the full order's workdir against stage custody. */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, opendirSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync,
  fsyncSync, type Dir } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readRegularFileNoFollow } from '../../../../src/install.ts';
import { parseManifestBytes } from '../../../../src/bundle/manifest.ts';
import { allowedSignersPath } from '../../../../src/crypto/trust-roots.ts';
import { grantsDir, orgRootPublicKeyPath, revocationsDir } from '../../../../src/crypto/org-root.ts';
import { evaluateOriginRule, matchOriginRule } from '../../../../src/crypto/origin-rules.ts';
import { parseWorkdirFrom } from '../../../../src/paths.ts';
import { createHubBundleRecoveryHandler } from '../bundle/pull.ts';
import { createConsumedVerifier } from '../consumed-verifier.ts';
import { bindTrustedRoutedInputV2, type RoutedInputPair, type RoutedInputPhase } from '../hosted/trusted-input-admission.ts';
import { validModelOrderFields, outputFor } from '../order-definition-binding.ts';
import { createStoreInstructionResolver } from '../exec/instructions.ts';
import { createParentRoutedInvocationSource } from './routing-invocation-source.ts';
import { RoutedInputWitnessRefusal } from './routing-input-refusal.ts';
import { parseRoutedReferenceV2, parseRoutedClaimV2 } from '../hosted/trusted-routed-reference-v2.ts';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { DefRef, InvocationRelayKey, VerifiedInvocationReceipt } from '../../../../src/types.ts';
import type { RecordedBindingV2 } from '../hosted/trusted-routed-recorded-v2.ts';
import { HubError, type GetOrderResponse, type OrderPacket, type WorkOrder } from '../hub/types.ts';
import {
  createBundleIngestor, createExecutionDefinitionVerifier, createExecutionOriginVerifier,
  createPreCommitVerifier, createStoreInstructionSource, globalStoreRoot,
  parseWorkflowCoordinate, readWorkflowStoreIndex, resolveOriginRules, storeIndexPath,
} from '../../../../src/store/index.ts';

export interface RoutedDefinitionStage {
  path: string;
  digest: string;
  /** Parent-only, fresh full-order and current operator trust gate. */
  verifyOrder(response: GetOrderResponse): Promise<void>;
  /** Exact command from the currently verified signed stage, never from a child. */
  commandFor?(order: OrderPacket): Promise<string>;
  /** Full current trust plus exact Service input/value witness. */
  verifyRoutedInput?(response: GetOrderResponse, pair: RoutedInputPair,
    phase: RoutedInputPhase, started?: { wall: number; monotonic: number }): Promise<void>;
  /** Pure signed-stage key gate before the first parent Service read. */
  validateInvocationKey?(key: InvocationRelayKey): boolean;
  /** Parent-only first phase for a role's exact dynamic invocation key. */
  readInvocationBinding?(response: GetOrderResponse, pair: RoutedInputPair,
    phase: RoutedInputPhase, key: InvocationRelayKey): Promise<VerifiedInvocationReceipt | undefined>;
  /** Fixed-path submit remains restricted to singleton and judge outputs. */
  canSubmit(order: OrderPacket, path: string): boolean;
  /** The issued-member protocol requires an owed collection seal in signed source. */
  canCollect?(order: OrderPacket, sealPath: string): boolean;
  /** Only a verified singleton or judge output has replay-safe submit semantics. */
  canReplay(order: OrderPacket, path: string): boolean;
  /** Durable exact child owner, written before the start gate opens. */
  activate(owner: RoutedStageOwner): void;
  /** Persist uncertainty before the gate could expose authored work. */
  markGateMayOpen(owner: RoutedStageOwner): void;
  /** Before activation only; an active stage is retained until verified exit. */
  cleanup(): void;
  cleanupAfterExit(owner: RoutedStageOwner): void;
}

export interface RoutedStageOwner { workflow: string; run: string; pid: number; spawnedAt: number }

const STAGE_RETENTION_MS = 24 * 60 * 60_000;
const stageName = /^\.routing-def-[A-Za-z0-9]{6}$/;
const OWNER_FILE = 'owner.json';
const GATE_MARKER = 'gate-may-open';

/** Both the indexed package namespace and every signed authored Hub
 * namespace govern an object. A package coordinate alone cannot weaken the
 * policy for a second `other/child` definition in the same bundle. */
function originNamespacesForObject(
  object: { bundleDigest: string; objectPath: string },
  index: ReturnType<typeof readWorkflowStoreIndex>,
): string[] {
  const coordinates = Object.entries(index.entries)
    .filter(([, entry]) => entry.digest === object.bundleDigest)
    .map(([coordinate]) => coordinate);
  if (coordinates.length === 0) throw new Error('routed definition index refused');
  const bytes = readRegularFileNoFollow(join(object.objectPath, 'bundle.yaml'), 'routed bundle manifest');
  if (bytes === undefined) throw new Error('routed definition manifest refused');
  const manifest = parseManifestBytes(bytes);
  return [...new Set([
    ...coordinates.map(coordinate => parseWorkflowCoordinate(coordinate).namespace),
    ...Object.keys(manifest.workflows).filter(name => name.includes('/')).map(name => name.split('/')[0]!),
  ])];
}

function processLiveness(pid: number): boolean | undefined {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined; }
}

function gateMayOpen(stagePath: string): boolean {
  try { return lstatSync(join(stagePath, GATE_MARKER), { throwIfNoEntry: false }) !== undefined; }
  catch { return true; }
}

function ownerAt(stagePath: string): RoutedStageOwner | undefined | 'uncertain' {
  try {
    const bytes = readRegularFileNoFollow(join(stagePath, OWNER_FILE), 'routed stage owner');
    if (bytes === undefined) return undefined;
    if (bytes.length > 1024) return 'uncertain';
    const row = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
    if (!row || Object.keys(row).sort().join(',') !== 'pid,run,spawnedAt,workflow'
      || typeof row.workflow !== 'string' || !row.workflow
      || typeof row.run !== 'string' || !row.run
      || typeof row.pid !== 'number' || !Number.isSafeInteger(row.pid) || row.pid <= 0
      || typeof row.spawnedAt !== 'number' || !Number.isSafeInteger(row.spawnedAt)
      || row.spawnedAt < 0) return 'uncertain';
    return row as unknown as RoutedStageOwner;
  } catch { return 'uncertain'; }
}

function copyPublicFile(source: string, target: string, required: boolean): void {
  const bytes = readRegularFileNoFollow(source, 'routed public trust');
  if (bytes === undefined) {
    if (required) throw new Error('routed public trust unavailable');
    return;
  }
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
}

function copyEnvelopes(source: string, target: string, suffix: string): void {
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('routed public trust unavailable');
  mkdirSync(target, { mode: 0o700 });
  for (const name of readdirSync(source)) {
    const entry = join(source, name);
    const entryStat = lstatSync(entry);
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) throw new Error('routed public trust unavailable');
    if (name.endsWith(suffix)) copyPublicFile(entry, join(target, name), true);
  }
}

function copyPublicTrust(sourceEnv: Record<string, string | undefined>, target: string): void {
  mkdirSync(target, { mode: 0o700 });
  copyPublicFile(allowedSignersPath(sourceEnv), join(target, 'allowed_signers'), true);
  copyPublicFile(orgRootPublicKeyPath(sourceEnv), join(target, 'org-root.pub'), false);
  copyEnvelopes(grantsDir(sourceEnv), join(target, 'grants'), '.grant.dsse');
  copyEnvelopes(revocationsDir(sourceEnv), join(target, 'revocations'), '.revocation.dsse');
}

function makeOwnedDirectoriesWritable(root: string): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return;
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  for (const name of readdirSync(root)) makeOwnedDirectoriesWritable(join(root, name));
}

function exactOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && !parsed.username && !parsed.password
      && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function overlap(a: string, b: string): boolean {
  const within = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return within(a, b) || within(b, a);
}

function operatorStageRoot(stateDir: string, workRoot: string): string {
  const stat = lstatSync(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('routed stage root refused');
  const root = realpathSync(stateDir);
  const working = (() => { try { return realpathSync(workRoot); } catch { return resolve(workRoot); } })();
  if (overlap(root, working)) throw new Error('routed stage root overlaps worker directory');
  const stageRoot = join(root, '.routing-definitions');
  try { mkdirSync(stageRoot, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stageStat = lstatSync(stageRoot);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || (stageStat.mode & 0o777) !== 0o700
    || (process.getuid && stageStat.uid !== process.getuid())) throw new Error('routed stage root refused');
  return stageRoot;
}

/** Provisional retention while routed roles remain fenced. A future live role
 * must tie its stage to durable child ownership before extending retention. */
export function createRoutedDefinitionMaintenance(args: {
  stateDir: string; workRoot: string; now?: () => number;
  isAlive?: (pid: number) => boolean | undefined;
}): { sweep(): void; close(): void } {
  const root = operatorStageRoot(args.stateDir, args.workRoot);
  const now = args.now ?? Date.now;
  const isAlive = args.isAlive ?? processLiveness;
  let entries: Dir | undefined;
  const close = () => { entries?.closeSync(); entries = undefined; };
  return {
    sweep() {
      entries ??= opendirSync(root);
      for (let scanned = 0; scanned < 64; scanned++) {
	const entry = entries.readSync();
	if (!entry) { close(); break; }
	if (!entry.isDirectory() || !stageName.test(entry.name)) continue;
	const path = join(root, entry.name);
	try {
	  const stat = lstatSync(path);
	  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
	    || (process.getuid && stat.uid !== process.getuid())) continue;
	  const owner = ownerAt(path);
	  if (owner === 'uncertain') continue;
	  if (owner) {
	    // No gate marker means authored work could never start. A confirmed dead
	    // parked worker can be reaped after a Shift crash or canceled dispatch.
	    // Once the gate may have opened, role-PID death says nothing about its
	    // detached shell/provider descendants: retain until their termination
	    // is independently proven. A role exit, even status zero, is insufficient.
	    if (gateMayOpen(path) || isAlive(owner.pid) !== false) continue;
	  } else if (now() - stat.mtimeMs < STAGE_RETENTION_MS) continue;
	  makeOwnedDirectoriesWritable(path);
	  const current = lstatSync(path);
	  if (current.dev === stat.dev && current.ino === stat.ino)
	    rmSync(path, { recursive: true, force: true });
	} catch { /* Unknown or substituted entries do not authorize cleanup. */ }
      }
    },
    close,
  };
}

/** Fetch and verify the exact order digest and its locked calls closure. */
export async function stageRoutedDefinition(args: {
  /** Canonical Shift/Service request target; WorkOrder.workflow is the signed frame. */
  rootWorkflow: string;
  order: WorkOrder;
  origin: string;
  token: string;
  stateDir: string;
  workRoot: string;
  sourceEnv: Record<string, string | undefined>;
  beforeRequest: () => void;
  onRateLimit: (error: HubError) => void;
  stillAuthorized: () => boolean;
  readCurrentPair?: (phase: RoutedInputPhase, expected: { workflow: string; run: string }) =>
    Promise<RoutedInputPair>;
  readInvocationBinding?: (key: InvocationRelayKey, phase: RoutedInputPhase,
    expected: { workflow: string; run: string }, binding?: RecordedBindingV2) =>
      Promise<VerifiedInvocationReceipt | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<RoutedDefinitionStage> {
  const frameWorkflow = args.order.workflow;
  const routing = args.order.routing;
  const binding = routing?.claim.binding;
  const definitionName = binding?.def?.workflowName;
  if (!exactOrigin(args.origin) || !/^[0-9a-f]{64}$/.test(args.order.defDigest ?? '')
    || !args.rootWorkflow || !frameWorkflow || !args.order.run || !args.order.step
    || (routing !== undefined && (!binding || binding.runId !== args.rootWorkflow
      || binding.frameId !== frameWorkflow || !definitionName
      || binding.def.bundleDigest !== `sha256:${args.order.defDigest}`
      || routing.claim.orderId !== args.order.run || routing.claim.claimId !== args.order.run
      || !isDeepStrictEqual(binding, routing.decision.binding)))
    || (args.order.worker !== undefined && args.order.worker !== 'agent' && args.order.worker !== 'command'))
    throw new Error('routed definition staging refused');
  let root: string;
  try { root = operatorStageRoot(args.stateDir, args.workRoot); }
  catch { throw new Error('routed definition staging refused'); }
  const stagePath = mkdtempSync(join(root, '.routing-def-'));
  chmodSync(stagePath, 0o700);
  const inode = lstatSync(stagePath);
  const removeStage = () => {
    try {
      const current = lstatSync(stagePath);
      if (current.isDirectory() && !current.isSymbolicLink()
	&& current.dev === inode.dev && current.ino === inode.ino) {
	makeOwnedDirectoriesWritable(stagePath);
	rmSync(stagePath, { recursive: true, force: true });
      }
    } catch { /* Already removed or substituted: never follow a replacement. */ }
  };
  const cleanup = () => {
    if (ownerAt(stagePath) !== undefined) return;
    removeStage();
  };
  const activate = (owner: RoutedStageOwner) => {
    if (owner.workflow !== args.rootWorkflow || owner.run !== args.order.run
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isSafeInteger(owner.spawnedAt) || owner.spawnedAt < 0
      || ownerAt(stagePath) !== undefined) throw new Error('routed stage owner refused');
    const current = lstatSync(stagePath);
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== inode.dev || current.ino !== inode.ino)
      throw new Error('routed stage ownership changed');
    // The owner entry is durable before opening the child start gate. A crash
    // during this write leaves an uncertain marker that maintenance preserves.
    const fd = openSync(join(stagePath, OWNER_FILE), constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(JSON.stringify(owner));
      if (bytes.length > 1024 || writeSync(fd, bytes) !== bytes.length)
	throw new Error('routed stage owner write failed');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const directoryFd = openSync(stagePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  };
  const markGateMayOpen = (owner: RoutedStageOwner) => {
    if (!isDeepStrictEqual(ownerAt(stagePath), owner))
      throw new Error('routed stage owner changed');
    const fd = openSync(join(stagePath, GATE_MARKER), constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, Buffer.from('1')); fsyncSync(fd); }
    finally { closeSync(fd); }
    const directoryFd = openSync(stagePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  };
  const cleanupAfterExit = (owner: RoutedStageOwner) => {
    const stored = ownerAt(stagePath);
    if (stored === undefined || stored === 'uncertain' || !isDeepStrictEqual(stored, owner)) return;
    removeStage();
  };
  try {
    const deadline = performance.now() + 120_000;
    const beforeRequest = () => {
      if (performance.now() >= deadline || !args.stillAuthorized())
	throw new Error('routed definition staging expired');
      args.beforeRequest();
    };
    const publicConfig = join(stagePath, 'public');
    const stageHome = join(stagePath, 'home');
    mkdirSync(stageHome, { mode: 0o700 });
    copyPublicTrust(args.sourceEnv, publicConfig);
    const stageEnv = { OWENLOOP_CONFIG_DIR: publicConfig };
    const originRules = resolveOriginRules(args.sourceEnv);
    const projectRoot = join(stagePath, 'project-workflows');
    const root = globalStoreRoot(stageHome);
    const source = createStoreInstructionSource({
      globalRoot: root,
      verifier: createBundleIngestor(),
      onMissing: createHubBundleRecoveryHandler({
	origin: args.origin, token: args.token, home: stageHome, projectRoot,
	env: stageEnv, beforeRequest, onRateLimit: args.onRateLimit,
	recoverLockedDependencies: true,
	preCommitVerifier: createPreCommitVerifier({ env: stageEnv, policy: 'enforce',
	  originPolicy: 'enforce', originRules }),
	...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
      }),
    });
    // WorkOrder lacks the full get_order packet, so this gate checks only
    // definition identity and step text. The routed role must still bind the
    // fresh full order and verify consumed values before external start.
    if (await source.prime(args.order.defDigest!) !== 'resolved') throw new Error('routed definition unavailable');
    if (performance.now() >= deadline || !args.stillAuthorized()) throw new Error('routed definition staging expired');
    const selected = routing === undefined ? undefined
      : source.selectVerifiedDefinition(args.order.defDigest!, definitionName!, args.order.step);
    const resolved = routing === undefined ? source.getVerifiedObject(args.order.defDigest!) : selected;
    const support = routing === undefined
      ? source.getVerifiedSupport?.(args.order.defDigest!, args.order.step) : selected?.support;
    const definition = routing === undefined
      ? source.getVerifiedDefinition(args.order.defDigest!, args.order.step) : selected?.definition;
    const step = routing === undefined
      ? source.getVerifiedStep(args.order.defDigest!, args.order.step) : selected?.step;
    if (!resolved || !definition || !step || !support?.length
      || (routing !== undefined && definition.name !== definitionName))
      throw new Error('routed definition step unavailable');
    const allSupport = [...support];
    const dynamicChildren = new Map<string, DefRef>();
    // Apply all configured rules matching the installed namespace. WorkOrder
    // lacks workdir/inputs, so full step and consume binding is deferred.
    const stagedIndex = readWorkflowStoreIndex(storeIndexPath(root));
    const verifyDefinition = createExecutionDefinitionVerifier({ env: stageEnv });
    const verifyOrigin = createExecutionOriginVerifier({ env: stageEnv });
    for (const object of support) {
      if (performance.now() >= deadline || !args.stillAuthorized()) throw new Error('routed definition staging expired');
      // Recheck every object after the complete calls closure has downloaded.
      // A trust or publication change during a later fetch must not leave an
      // earlier child accepted under an obsolete snapshot.
      const verdict = await verifyDefinition(object);
      if (verdict.kind !== 'verified') throw new Error('routed definition publication refused');
      const originVerdict = await verifyOrigin(object);
      if (originVerdict.kind === 'invalid') throw new Error('routed definition origin refused');
      for (const namespace of originNamespacesForObject(object, stagedIndex)) {
	const rule = matchOriginRule(originRules, namespace);
	if (rule && !evaluateOriginRule(rule.value, originVerdict).ok)
	  throw new Error('routed definition origin refused');
      }
    }
    if (routing !== undefined && selected) {
      const dynamicPaths = Object.keys(args.order.consumes).filter(path =>
	selected.definition.steps.some(candidate => candidate.callsInterface?.selection === 'invocation'
	  && candidate.produces.some(produce => produce.stem === path)));
      if (dynamicPaths.length > 0) {
	if (!args.readCurrentPair || !args.readInvocationBinding) throw new Error('routed invocation source unavailable');
	const expected = { workflow: args.rootWorkflow, run: args.order.run };
	const pair = await args.readCurrentPair('prestart', expected);
	const reference = parseRoutedReferenceV2(pair.reference, expected);
	const claim = parseRoutedClaimV2(pair.claim, expected);
	if (reference.state !== 'available' || claim.state !== 'available'
	  || !isDeepStrictEqual(reference.binding, claim.binding)
	  || !isDeepStrictEqual(reference.order.routing, routing)
	  || !isDeepStrictEqual(claim.routing, routing)
	  || reference.order.workflow !== frameWorkflow || reference.order.run !== args.order.run
	  || reference.order.defDigest !== args.order.defDigest || reference.order.step !== args.order.step
	  || !isDeepStrictEqual(reference.order.consumes, args.order.consumes)
	  || !isDeepStrictEqual(reference.order.consumedFingerprint, args.order.consumedFingerprint))
	  throw new Error('routed invocation claim changed');
	const invocationSource = createParentRoutedInvocationSource({ expected,
	  order: reference.order, selected, pair,
	  phase: 'prestart', readDirect: args.readInvocationBinding,
	  readCurrentPair: args.readCurrentPair, stillAuthorized: args.stillAuthorized,
	  verifyChild: async child => {
	    if (await source.prime(child.bundleDigest) !== 'resolved')
	      throw new Error('routed invocation child unavailable');
	    const chosen = source.selectVerifiedWorkflow(child.bundleDigest, child.workflowName);
	    if (!chosen || chosen.bundleDigest !== child.bundleDigest) throw new Error('routed invocation child changed');
	    for (const object of chosen.support) {
	      if ((await verifyDefinition(object)).kind !== 'verified')
		throw new Error('routed invocation child publication refused');
	      const verdict = await verifyOrigin(object);
	      if (verdict.kind === 'invalid') throw new Error('routed invocation child origin refused');
	      for (const namespace of originNamespacesForObject(object,
		readWorkflowStoreIndex(storeIndexPath(root)))) {
		const rule = matchOriginRule(originRules, namespace);
		if (rule && !evaluateOriginRule(rule.value, verdict).ok)
		  throw new Error('routed invocation child origin refused');
	      }
	      if (!allSupport.some(existing => existing.bundleDigest === object.bundleDigest
		&& existing.objectPath === object.objectPath)) allSupport.push(object);
	    }
	  } });
	for (const path of dynamicPaths) {
	  const version = reference.order.consumedFingerprint?.[path];
	  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)
	    throw new Error('routed invocation version unavailable');
	  const key = { parentWorkflow: frameWorkflow,
	    parentDefRef: { bundleDigest: selected.bundleDigest, workflowName: selected.definition.name },
	    callPath: path, parentArtifactVersion: version };
	  const receipt = await invocationSource.read(key);
	  if (!receipt) throw new Error('routed invocation receipt unavailable');
	  dynamicChildren.set(path, receipt.receipt.childDefRef);
	}
      }
    }
    if ((args.order.worker === 'command') !== (step.command !== undefined))
      throw new Error('routed definition worker refused');
    // Snapshot verification is not a substitute for current operator trust.
    // Re-read public trust and the operator's applicable rules after all
    // downloads. Future role consumption must repeat this fresh parent check.
    const freshRules = resolveOriginRules(args.sourceEnv);
    const freshDefinition = createExecutionDefinitionVerifier({ env: args.sourceEnv });
    const freshOrigin = createExecutionOriginVerifier({ env: args.sourceEnv });
    for (const object of allSupport) {
      if (performance.now() >= deadline || !args.stillAuthorized()) throw new Error('routed definition staging expired');
      if ((await freshDefinition(object)).kind !== 'verified') throw new Error('routed definition publication changed');
      const verdict = await freshOrigin(object);
      if (verdict.kind === 'invalid') throw new Error('routed definition origin changed');
      for (const namespace of originNamespacesForObject(object, stagedIndex)) {
	const rule = matchOriginRule(freshRules, namespace);
	if (rule && !evaluateOriginRule(rule.value, verdict).ok)
	  throw new Error('routed definition origin changed');
      }
    }
    if (performance.now() >= deadline || !args.stillAuthorized()) throw new Error('routed definition staging expired');
    const descriptor = { version: 'routing-definition-stage-v2', rootWorkflow: args.rootWorkflow,
      frameWorkflow, definitionName: definition.name, routed: routing !== undefined,
      run: args.order.run, step: args.order.step, digest: args.order.defDigest,
      bundleDigest: resolved.bundleDigest, originRules: freshRules, nonce: randomBytes(16).toString('hex') };
    writeFileSync(join(stagePath, 'stage.json'), JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 });
    const supportIdentity = (items: NonNullable<typeof selected>['support']): string[] =>
      items.map(object => `${object.bundleDigest}:${object.objectPath}`).sort();
    const requireOriginalSelection = (candidate: typeof selected): void => {
      if (!selected || !candidate || candidate.bundleDigest !== selected.bundleDigest
	|| candidate.objectPath !== selected.objectPath
	|| candidate.definition.name !== selected.definition.name
	|| candidate.step.name !== selected.step.name
	|| candidate.step.command !== selected.step.command
	|| !isDeepStrictEqual(supportIdentity(candidate.support), supportIdentity(selected.support)))
	throw new Error('routed signed selection changed');
    };
      const verifyOrderInternal = async (response: GetOrderResponse,
      routed?: { pair: RoutedInputPair; phase: RoutedInputPhase;
	started?: { wall: number; monotonic: number };
	relayCache?: Map<string, VerifiedInvocationReceipt> }): Promise<void> => {
      const order = response.order;
      // The broker checks the exact original session incarnation around this
      // callback. The pre-start preference deadline must not terminate trust
      // checks for a long-running child after a launch report was accepted.
      if (!order || !response.lease.claimed || response.lease.outcome !== undefined
	|| response.workflow !== frameWorkflow || response.run !== args.order.run
	|| order.workflow !== frameWorkflow || order.run !== args.order.run
	|| order.step !== args.order.step || order.defDigest !== args.order.defDigest
	|| (args.order.key !== undefined && order.key !== args.order.key)
	|| (args.order.index !== undefined && order.index !== args.order.index)
	|| !isDeepStrictEqual(order.routing, args.order.routing)
	|| (order.worker ?? 'agent') !== (args.order.worker ?? 'agent'))
	throw new Error('routed order changed');
      const currentStage = lstatSync(stagePath);
      if (!currentStage.isDirectory() || currentStage.isSymbolicLink()
	|| currentStage.dev !== inode.dev || currentStage.ino !== inode.ino)
	throw new Error('routed definition stage changed');
      // The full packet alone reveals workdir. A workdir containing the stage,
      // or contained by it, would give authored code a mutable trust snapshot.
      // For an unspecified command workdir the shell inherits Shift's cwd.
      const actualWorkdir = order.workdir ?? (order.worker === 'command' ? process.cwd() : args.workRoot);
      const checkedWorkdir = order.workdir !== undefined || order.worker === 'command'
	? realpathSync(actualWorkdir) : (() => { try { return realpathSync(actualWorkdir); }
	  catch { return resolve(actualWorkdir); } })();
      if (overlap(checkedWorkdir, realpathSync(stagePath))
	|| overlap(checkedWorkdir, realpathSync(dirname(allowedSignersPath(args.sourceEnv)))))
	throw new Error('routed workdir overlaps definition trust');
      const freshRules = resolveOriginRules(args.sourceEnv);
      const freshIndex = readWorkflowStoreIndex(storeIndexPath(root));
      const freshDefinition = createExecutionDefinitionVerifier({ env: args.sourceEnv });
      const freshOrigin = createExecutionOriginVerifier({ env: args.sourceEnv });
      // Reopen the private bytes without the staging recovery hook. A stale
      // or removed object at execution time must refuse, never trigger a new
      // broad-bearer download from a submit/get_order callback.
      const readOnlySource = createStoreInstructionSource({ globalRoot: root,
	verifier: createBundleIngestor() });
      if (await readOnlySource.prime(order.defDigest) !== 'resolved')
	throw new Error('routed definition object changed');
      const currentSelection = routing === undefined ? undefined
	: readOnlySource.selectVerifiedDefinition(order.defDigest, definitionName!, order.step);
      if (routing !== undefined) requireOriginalSelection(currentSelection);
      const currentSupport = [...(routing === undefined
	? readOnlySource.getVerifiedSupport?.(order.defDigest, order.step) ?? []
	: currentSelection?.support ?? [])];
      if (!currentSupport?.length) throw new Error('routed definition closure unavailable');
      for (const child of dynamicChildren.values()) {
	if (await readOnlySource.prime(child.bundleDigest) !== 'resolved')
	  throw new Error('routed invocation child changed');
	const chosen = readOnlySource.selectVerifiedWorkflow(child.bundleDigest, child.workflowName);
	if (!chosen || chosen.bundleDigest !== child.bundleDigest)
	  throw new Error('routed invocation child changed');
	for (const object of chosen.support)
	  if (!currentSupport.some(existing => existing.bundleDigest === object.bundleDigest
	    && existing.objectPath === object.objectPath)) currentSupport.push(object);
      }
      for (const object of currentSupport) {
	if ((await freshDefinition(object)).kind !== 'verified')
	  throw new Error('routed definition trust changed');
	const verdict = await freshOrigin(object);
	if (verdict.kind === 'invalid') throw new Error('routed definition origin changed');
	for (const namespace of originNamespacesForObject(object, freshIndex)) {
	  const rule = matchOriginRule(freshRules, namespace);
	  if (rule && !evaluateOriginRule(rule.value, verdict).ok)
	    throw new Error('routed definition origin changed');
	}
      }
      const invocationSource = routed && currentSelection && dynamicChildren.size > 0
	&& args.readInvocationBinding && args.readCurrentPair
	? createParentRoutedInvocationSource({ expected: { workflow: args.rootWorkflow,
	    run: args.order.run }, order, selected: currentSelection, pair: routed.pair,
	  phase: routed.phase,
	  readDirect: async (key, phase, expected, binding) => {
	    const relay = await args.readInvocationBinding!(key, phase, expected, binding);
	    if (!relay || !isDeepStrictEqual(relay.receipt.childDefRef,
	      dynamicChildren.get(key.callPath))) throw new Error('routed invocation selection moved');
	    routed.relayCache?.set(valueDigestHex(key), relay);
	    return relay;
	  },
	  readCurrentPair: args.readCurrentPair,
	  stillAuthorized: () => routed.phase === 'recorded-live' || args.stillAuthorized(),
	  verifyChild: async child => {
	    const selectedChild = readOnlySource.selectVerifiedWorkflow(child.bundleDigest, child.workflowName);
	    if (!selectedChild || selectedChild.bundleDigest !== child.bundleDigest)
	      throw new Error('routed invocation child changed');
	    for (const object of selectedChild.support) {
	      if ((await freshDefinition(object)).kind !== 'verified')
		throw new Error('routed invocation child publication changed');
	      const verdict = await freshOrigin(object);
	      if (verdict.kind === 'invalid') throw new Error('routed invocation child origin changed');
	      for (const namespace of originNamespacesForObject(object, freshIndex)) {
		const rule = matchOriginRule(freshRules, namespace);
		if (rule && !evaluateOriginRule(rule.value, verdict).ok)
		  throw new Error('routed invocation child origin changed');
	      }
	    }
	  } }) : undefined;
      if (routed && dynamicChildren.size > 0 && !invocationSource)
	throw new Error('routed invocation source unavailable');
      const resolver = createStoreInstructionResolver({ globalRoot: root, source: readOnlySource,
	verifier: createBundleIngestor(), env: args.sourceEnv, defPolicy: 'enforce',
	...(routing === undefined ? {} : { routedSelection: {
	  rootWorkflow: args.rootWorkflow, frameWorkflow,
	  definitionName: definitionName!, defDigest: args.order.defDigest!, run: args.order.run } }),
	originPolicy: 'enforce', originRules: freshRules,
	definitionVerifier: freshDefinition, originVerifier: freshOrigin,
	consumedVerifier: createConsumedVerifier({ env: args.sourceEnv, now: Date.now,
	  artifactPolicy: 'enforce' }),
	...(invocationSource ? { invocationBindingSource: invocationSource } : {}),
	warn: () => {} });
      const verifiedStep = routing === undefined
	? readOnlySource.getVerifiedStep(order.defDigest, order.step) : currentSelection?.step;
      const verifiedDefinition = routing === undefined
	? readOnlySource.getVerifiedDefinition(order.defDigest, order.step) : currentSelection?.definition;
	if (!verifiedStep || !verifiedDefinition
	  || (routing !== undefined && verifiedDefinition.name !== definitionName)
	  || (!routed && !validModelOrderFields(verifiedStep, order,
	  verifiedDefinition.inputs.map(input => input.name))))
	throw new Error('routed order fields changed');
      // A declared optional input can set workdir without appearing in
      // `order.consumes`. Until Service supplies a canonical authenticated
      // input-value witness, the parent cannot bind that path before start.
      const workdirSource = verifiedStep.workdirFrom === undefined ? undefined
	: parseWorkdirFrom(verifiedStep.workdirFrom, verifiedStep.consumes,
	  verifiedDefinition.inputs.map(input => input.name));
      if (workdirSource?.source === 'input' && !routed) throw new Error('routed workdir witness unavailable');
      if (routed) {
	const admission = await bindTrustedRoutedInputV2({ phase: routed.phase, pair: routed.pair,
	  privateOrder: order, instructions: resolver,
	  consumedVerifier: createConsumedVerifier({ env: args.sourceEnv, now: Date.now,
	    artifactPolicy: 'enforce' }),
	  expected: { workflow: args.rootWorkflow, run: args.order.run },
	  ...(routed.started ? { startedAt: routed.started.wall,
	    startedMonotonic: routed.started.monotonic } : {}) });
	if (!admission.ok) throw new RoutedInputWitnessRefusal(admission.reason);
	if (order.worker === 'command'
	  && (typeof verifiedStep.command !== 'string' || !verifiedStep.command.trim()))
	  throw new RoutedInputWitnessRefusal('command-definition-missing');
      } else if (order.worker === 'command') {
	const checked = await resolver.resolveCommand(order);
	if (!checked.ok) throw new Error('routed command definition refused');
      } else {
	const checked = await resolver.resolveHostedStep!(order);
	if (!checked.ok || !validModelOrderFields(checked.step, order, checked.inputNames))
	  throw new Error('routed agent definition refused');
	const dynamic = Object.keys(order.consumes).length > 0
	  || order.owes.some(owed => owed.reasons.length > 0 || owed.proof !== undefined);
	if (dynamic) {
	  const consumed = await createConsumedVerifier({ env: args.sourceEnv, now: Date.now,
	    artifactPolicy: 'enforce' })(order, { hardRule: true,
	    callsProducers: checked.callsProducers });
	  if (!consumed.ok) throw new Error('routed consumed proof refused');
	}
      }
      if (routing !== undefined) {
	// The binder and trust checks above can await a direct invocation relay.
	// Reopen the exact signed member after those awaits; a moved index or
	// object path cannot turn the captured prestart command into a new grant.
	const finalSource = createStoreInstructionSource({ globalRoot: root,
	  verifier: createBundleIngestor() });
	if (await finalSource.prime(order.defDigest) !== 'resolved')
	  throw new Error('routed signed selection changed');
	requireOriginalSelection(finalSource.selectVerifiedDefinition(order.defDigest,
	  definitionName!, order.step));
      }
      // The binder and final source reopen can await. Check publication,
      // origin and every applicable operator rule after that reopen. Keep the
      // last index/rule read after the awaited verifiers so a rule change
      // during verification cannot reuse an earlier policy snapshot.
      const finalDefinition = createExecutionDefinitionVerifier({ env: args.sourceEnv });
      const finalOrigin = createExecutionOriginVerifier({ env: args.sourceEnv });
      const finalVerdicts: Array<{ object: (typeof currentSupport)[number];
	verdict: Awaited<ReturnType<typeof finalOrigin>> }> = [];
      for (const object of currentSupport) {
	if ((await finalDefinition(object)).kind !== 'verified')
	  throw new Error('routed definition trust changed');
	const verdict = await finalOrigin(object);
	if (verdict.kind === 'invalid') throw new Error('routed definition origin changed');
	finalVerdicts.push({ object, verdict });
      }
      const finalRules = resolveOriginRules(args.sourceEnv);
      const finalIndex = readWorkflowStoreIndex(storeIndexPath(root));
      for (const { object, verdict } of finalVerdicts) {
	for (const namespace of originNamespacesForObject(object, finalIndex)) {
	  const rule = matchOriginRule(finalRules, namespace);
	  if (rule && !evaluateOriginRule(rule.value, verdict).ok)
	    throw new Error('routed definition origin changed');
	}
      }
      const finalStage = lstatSync(stagePath);
      const finalWorkdir = order.workdir !== undefined || order.worker === 'command'
	? realpathSync(actualWorkdir) : (() => { try { return realpathSync(actualWorkdir); }
	  catch { return resolve(actualWorkdir); } })();
      if (!finalStage.isDirectory() || finalStage.isSymbolicLink()
	|| finalStage.dev !== inode.dev || finalStage.ino !== inode.ino
	|| overlap(finalWorkdir, realpathSync(stagePath))
	|| overlap(finalWorkdir, realpathSync(dirname(allowedSignersPath(args.sourceEnv)))))
	throw new Error('routed definition custody changed');
      if (routed && routed.started) {
	const elapsed = performance.now() - routed.started.monotonic;
	if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 5_000)
	  throw new Error('routed input observation expired');
      }
    };
    const canReplay = (order: OrderPacket, path: string): boolean => {
      if (order.defDigest !== args.order.defDigest || order.step !== args.order.step
	|| order.workflow !== args.order.workflow || order.run !== args.order.run
	|| (routing !== undefined && !isDeepStrictEqual(order.routing, routing))
	|| !order.owes.some(owed => owed.path === path)) return false;
      const verified = routing === undefined
	? source.getVerifiedStep(order.defDigest, order.step) : selected?.step;
      if (!verified) return false;
      return verified.judges === path || outputFor(verified, order, path)?.kind === 'singleton';
    };
    const canCollect = (order: OrderPacket, sealPath: string): boolean => {
      if (order.defDigest !== args.order.defDigest || order.step !== args.order.step
	|| order.workflow !== args.order.workflow || order.run !== args.order.run
	|| (routing !== undefined && !isDeepStrictEqual(order.routing, routing))
	|| !order.owes.some(owed => owed.path === sealPath)) return false;
      const verified = routing === undefined
	? source.getVerifiedStep(order.defDigest, order.step) : selected?.step;
      return !!verified && outputFor(verified, order, sealPath)?.kind === 'collection';
    };
    const validateInvocationKey = (key: InvocationRelayKey): boolean => !!selected
      && key.parentWorkflow === frameWorkflow
      && key.parentDefRef.bundleDigest === selected.bundleDigest
      && key.parentDefRef.workflowName === selected.definition.name
      && dynamicChildren.has(key.callPath)
      && Object.hasOwn(args.order.consumes, key.callPath)
      && typeof key.parentArtifactVersion === 'number'
      && Number.isSafeInteger(key.parentArtifactVersion) && key.parentArtifactVersion > 0
      && args.order.consumedFingerprint?.[key.callPath] === key.parentArtifactVersion
      && selected.definition.steps.filter(candidate =>
	candidate.callsInterface?.selection === 'invocation'
	&& candidate.produces.some(produce => produce.stem === key.callPath)).length === 1;
    return { path: stagePath, digest: args.order.defDigest!,
      verifyOrder: response => verifyOrderInternal(response),
      commandFor: async order => {
	if (order.worker !== 'command' || order.defDigest !== args.order.defDigest
	  || order.workflow !== frameWorkflow || order.step !== args.order.step
	  || order.run !== args.order.run)
	  throw new Error('routed command definition refused');
	if (routing !== undefined && (!selected || !isDeepStrictEqual(order.routing, args.order.routing)))
	  throw new Error('routed command definition refused');
	const verified = routing === undefined
	  ? source.getVerifiedStep(order.defDigest, order.step) : selected?.step;
	if (typeof verified?.command !== 'string' || !verified.command.trim())
	  throw new Error('routed command definition refused');
	return verified.command;
      },
      verifyRoutedInput: (response, pair, phase, started) => verifyOrderInternal(response,
	{ pair, phase, ...(started ? { started } : {}) }),
      validateInvocationKey,
      readInvocationBinding: async (response, pair, phase, key) => {
	if (!validateInvocationKey(key)) throw new Error('routed invocation key refused');
	const relays = new Map<string, VerifiedInvocationReceipt>();
	await verifyOrderInternal(response, { pair, phase, relayCache: relays });
	return relays.get(valueDigestHex(key));
      },
      canSubmit: canReplay, canReplay, canCollect, activate, markGateMayOpen, cleanup, cleanupAfterExit };
  } catch (error) {
    cleanup();
    if (error instanceof HubError) throw error;
    throw new Error('routed definition staging refused');
  }
}
