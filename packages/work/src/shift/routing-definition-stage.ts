/** Shift-owned, credential-free provisional definition snapshot for one routed
 * dispatch. Bytes enter this private store, never the operator's ordinary
 * store. Current roles remain fenced. Their future consume path must recheck
 * fresh parent trust and the full order's workdir against stage custody. */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, opendirSync, readdirSync, realpathSync, rmSync, writeFileSync, type Dir } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readRegularFileNoFollow } from '../../../../src/install.ts';
import { allowedSignersPath } from '../../../../src/crypto/trust-roots.ts';
import { grantsDir, orgRootPublicKeyPath, revocationsDir } from '../../../../src/crypto/org-root.ts';
import { evaluateOriginRule, matchOriginRule } from '../../../../src/crypto/origin-rules.ts';
import { createHubBundleRecoveryHandler } from '../bundle/pull.ts';
import { HubError, type WorkOrder } from '../hub/types.ts';
import {
  createBundleIngestor, createExecutionDefinitionVerifier, createExecutionOriginVerifier,
  createPreCommitVerifier, createStoreInstructionSource, globalStoreRoot,
  parseWorkflowCoordinate, readWorkflowStoreIndex, resolveOriginRules, storeIndexPath,
} from '../../../../src/store/index.ts';

export interface RoutedDefinitionStage {
  path: string;
  digest: string;
  cleanup(): void;
}

const STAGE_RETENTION_MS = 24 * 60 * 60_000;
const stageName = /^\.routing-def-[A-Za-z0-9]{6}$/;

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
}): { sweep(): void; close(): void } {
  const root = operatorStageRoot(args.stateDir, args.workRoot);
  const now = args.now ?? Date.now;
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
	    || (process.getuid && stat.uid !== process.getuid())
	    || now() - stat.mtimeMs < STAGE_RETENTION_MS) continue;
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
  order: WorkOrder;
  origin: string;
  token: string;
  stateDir: string;
  workRoot: string;
  sourceEnv: Record<string, string | undefined>;
  beforeRequest: () => void;
  onRateLimit: (error: HubError) => void;
  stillAuthorized: () => boolean;
  fetchImpl?: typeof fetch;
}): Promise<RoutedDefinitionStage> {
  if (!exactOrigin(args.origin) || !/^[0-9a-f]{64}$/.test(args.order.defDigest ?? '')
    || !args.order.workflow || !args.order.run || !args.order.step
    || (args.order.worker !== undefined && args.order.worker !== 'agent' && args.order.worker !== 'command'))
    throw new Error('routed definition staging refused');
  let root: string;
  try { root = operatorStageRoot(args.stateDir, args.workRoot); }
  catch { throw new Error('routed definition staging refused'); }
  const stagePath = mkdtempSync(join(root, '.routing-def-'));
  chmodSync(stagePath, 0o700);
  const inode = lstatSync(stagePath);
  const cleanup = () => {
    try {
      const current = lstatSync(stagePath);
      if (current.isDirectory() && !current.isSymbolicLink()
	&& current.dev === inode.dev && current.ino === inode.ino) {
	makeOwnedDirectoriesWritable(stagePath);
	rmSync(stagePath, { recursive: true, force: true });
      }
    } catch { /* Already removed or substituted: never follow a replacement. */ }
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
    const resolved = source.getVerifiedObject(args.order.defDigest!);
    const support = source.getVerifiedSupport?.(args.order.defDigest!, args.order.step);
    const definition = source.getVerifiedDefinition(args.order.defDigest!, args.order.step);
    const step = source.getVerifiedStep(args.order.defDigest!, args.order.step);
    if (!resolved || !definition || !step || !support?.length) throw new Error('routed definition step unavailable');
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
      const coordinates = Object.entries(stagedIndex.entries)
	.filter(([, entry]) => entry.digest === object.bundleDigest)
	.map(([coordinate]) => coordinate);
      if (coordinates.length === 0) throw new Error('routed definition index refused');
      for (const coordinate of coordinates) {
	const rule = matchOriginRule(originRules, parseWorkflowCoordinate(coordinate).namespace);
	if (rule && !evaluateOriginRule(rule.value, originVerdict).ok)
	  throw new Error('routed definition origin refused');
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
    for (const object of support) {
      if (performance.now() >= deadline || !args.stillAuthorized()) throw new Error('routed definition staging expired');
      if ((await freshDefinition(object)).kind !== 'verified') throw new Error('routed definition publication changed');
      const verdict = await freshOrigin(object);
      if (verdict.kind === 'invalid') throw new Error('routed definition origin changed');
      const coordinates = Object.entries(stagedIndex.entries)
	.filter(([, entry]) => entry.digest === object.bundleDigest)
	.map(([coordinate]) => coordinate);
      for (const coordinate of coordinates) {
	const rule = matchOriginRule(freshRules, parseWorkflowCoordinate(coordinate).namespace);
	if (rule && !evaluateOriginRule(rule.value, verdict).ok)
	  throw new Error('routed definition origin changed');
      }
    }
    if (performance.now() >= deadline || !args.stillAuthorized()) throw new Error('routed definition staging expired');
    const descriptor = { version: 'routing-definition-stage-v1', workflow: args.order.workflow,
      run: args.order.run, step: args.order.step, digest: args.order.defDigest,
      bundleDigest: resolved.bundleDigest, originRules: freshRules, nonce: randomBytes(16).toString('hex') };
    writeFileSync(join(stagePath, 'stage.json'), JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 });
    return { path: stagePath, digest: args.order.defDigest!, cleanup };
  } catch (error) {
    cleanup();
    if (error instanceof HubError) throw error;
    throw new Error('routed definition staging refused');
  }
}
