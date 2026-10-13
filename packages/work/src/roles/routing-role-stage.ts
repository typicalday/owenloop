/** Public-only definition view in a routed worker. The Shift remains the live
 * trust authority; it verifies every claimed full order before broker reply. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { RoutedConcreteCallRequest, RoutedConcreteCallObservation,
  RoutedConcreteCallSelection } from '../../../../src/store/instruction-source.ts';
import type { ConcreteCallBindingKey, ConcreteCallBindingSource,
  VerifiedConcreteCallReceipt } from '../hosted/trusted-routed-concrete-binding.ts';
import { createBundleIngestor, createExecutionDefinitionVerifier,
  createExecutionOriginVerifier, createStoreInstructionSource, globalStoreRoot,
  resolveOriginRules } from '../../../../src/store/index.ts';
import { createConsumedVerifier } from '../consumed-verifier.ts';
import type { InvocationBindingSource } from '../../../../src/types.ts';
import { createStoreInstructionResolver, type InstructionResolver } from '../exec/instructions.ts';
import type { RoutingChildClient } from '../hub/routing-child-client.ts';
import type { RoutingHandoffV1 } from '../shift/runtime.ts';

const refused = (): Error => new Error('routing definition stage refused');

function privateDir(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (process.getuid && stat.uid !== process.getuid())) throw refused();
}

function descriptor(path: string, maxBytes = 16_384): unknown {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600 || before.size > maxBytes
    || (process.getuid && before.uid !== process.getuid())) throw refused();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw refused();
    const bytes = Buffer.alloc(before.size);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0)
      length += count;
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw refused();
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } finally { closeSync(fd); }
}

export function openRoutingRoleStage(handoff: RoutingHandoffV1,
  child?: Pick<RoutingChildClient, 'readInvocationBinding'>): {
  instructions: InstructionResolver;
  publicEnv: Record<string, string | undefined>;
  frameWorkflow: string;
  definitionName: string;
} {
  try {
    const stage = handoff.definitionStage;
    if (!stage || !/^\.routing-def-[A-Za-z0-9]{6}$/.test(basename(stage.path))
      || basename(dirname(stage.path)) !== '.routing-definitions') throw refused();
    privateDir(dirname(stage.path));
    privateDir(stage.path);
    privateDir(join(stage.path, 'public'));
    privateDir(join(stage.path, 'home'));
    const data = descriptor(join(stage.path, 'stage.json')) as Record<string, unknown>;
    if (!data || data.version !== 'routing-definition-stage-v2' || data.routed !== true
	|| data.rootWorkflow !== handoff.reservation.workflow
	|| typeof data.frameWorkflow !== 'string' || !data.frameWorkflow
	|| typeof data.definitionName !== 'string' || !data.definitionName
	|| data.run !== handoff.reservation.run
      || data.digest !== stage.digest || typeof data.step !== 'string' || !data.step
      || typeof data.bundleDigest !== 'string' || !/^[0-9a-f]{64}$/.test(data.bundleDigest)
      || typeof data.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(data.nonce)
      || !data.originRules || typeof data.originRules !== 'object'
      || Array.isArray(data.originRules)
      || typeof data.concreteCallsDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(data.concreteCallsDigest)
      || typeof data.concreteCallsBytes !== 'number'
      || !Number.isSafeInteger(data.concreteCallsBytes)
      || data.concreteCallsBytes < 2 || data.concreteCallsBytes > 1_000_000) throw refused();
    if (typeof data.concreteFoldedDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(data.concreteFoldedDigest)
      || typeof data.concreteFoldedBytes !== 'number'
      || !Number.isSafeInteger(data.concreteFoldedBytes)
      || data.concreteFoldedBytes < 2 || data.concreteFoldedBytes > 25_000_000) throw refused();
    const publicEnv = { HOME: join(stage.path, 'home'),
      OWENLOOP_CONFIG_DIR: join(stage.path, 'public') };
    const originRules = resolveOriginRules(publicEnv, data.originRules as Record<string, never>);
    const globalRoot = globalStoreRoot(publicEnv.HOME);
    const concreteFile = join(stage.path, 'concrete-calls.json');
    const concreteStat = lstatSync(concreteFile);
    if (concreteStat.size !== data.concreteCallsBytes) throw refused();
    const concrete = descriptor(concreteFile, 1_000_000);
    if (!Array.isArray(concrete) || concrete.length > 64
      || valueDigestHex(concrete) !== data.concreteCallsDigest) throw refused();
    const selections = concrete as Array<{ request: RoutedConcreteCallRequest;
      observation: RoutedConcreteCallObservation }>;
    const foldedFile = join(stage.path, 'concrete-folded.json');
    if (lstatSync(foldedFile).size !== data.concreteFoldedBytes) throw refused();
    const folded = descriptor(foldedFile, 25_000_000);
    if (!Array.isArray(folded) || folded.length > 64
      || valueDigestHex(folded) !== data.concreteFoldedDigest) throw refused();
    const foldedRows = folded as Array<{ key: ConcreteCallBindingKey;
      receipt: VerifiedConcreteCallReceipt }>;
    const concreteCallBindingSource: ConcreteCallBindingSource = { read: async key => {
      const matches = foldedRows.filter(row => row && typeof row === 'object'
	&& isDeepStrictEqual(row.key, key));
      if (matches.length !== 1 || !matches[0]?.receipt) throw refused();
      return matches[0].receipt;
    } };
    const routedConcreteCalls: RoutedConcreteCallSelection = {
      rootWorkflow: data.rootWorkflow as string,
      run: data.run as string,
      frameWorkflow: data.frameWorkflow,
      frameDefRef: { bundleDigest: data.digest as string,
	workflowName: data.definitionName },
      stillAuthorized: () => true,
      observe: async request => {
	const matches = selections.filter(row => row && typeof row === 'object'
	  && isDeepStrictEqual(row.request, request));
	if (matches.length !== 1 || !matches[0]?.observation) throw refused();
	return matches[0].observation;
      },
    };
    // This private snapshot is data-only. The parent re-observes each native
    // selection and the full signed/input witness before the start gate.
    const source = createStoreInstructionSource({ globalRoot,
      verifier: createBundleIngestor(), routedConcreteCalls });
    const invocationBindingSource: InvocationBindingSource | undefined = child ? {
      read: key => {
	if (key.parentWorkflow !== data.frameWorkflow
	  || key.parentDefRef.bundleDigest !== data.bundleDigest
	  || key.parentDefRef.workflowName !== data.definitionName
	  || !Number.isSafeInteger(key.parentArtifactVersion)
	  || key.parentArtifactVersion < 1) throw refused();
	return child.readInvocationBinding({ workflow: handoff.reservation.workflow,
	  orderId: handoff.reservation.run, parentWorkflow: key.parentWorkflow,
	  parentDefRef: key.parentDefRef, callPath: key.callPath,
	  parentArtifactVersion: key.parentArtifactVersion });
      },
    } : undefined;
    const strict = createStoreInstructionResolver({ globalRoot, source,
      verifier: createBundleIngestor(), env: publicEnv,
      routedSelection: { rootWorkflow: data.rootWorkflow as string,
	frameWorkflow: data.frameWorkflow, definitionName: data.definitionName,
	defDigest: data.digest as string, run: data.run as string },
      defPolicy: 'enforce', originPolicy: 'enforce', originRules,
      definitionVerifier: createExecutionDefinitionVerifier({ env: publicEnv }),
      originVerifier: createExecutionOriginVerifier({ env: publicEnv }),
      consumedVerifier: createConsumedVerifier({ env: publicEnv, now: Date.now,
	artifactPolicy: 'enforce' }),
      ...(invocationBindingSource ? { invocationBindingSource } : {}),
      concreteCallBindingSource, warn: () => {} });
    return { publicEnv, frameWorkflow: data.frameWorkflow,
      definitionName: data.definitionName, instructions: {
      ...strict,
      // Agent hosting needs the entire signed calls closure, not just one
      // prompt body. Command resolution already applies that hard boundary.
      resolveStep: async order => {
	const checked = await strict.resolveHostedStep!(order);
	return checked.ok ? { ok: true, step: checked.step, inputNames: checked.inputNames,
	  ...(checked.bundleDir ? { bundleDir: checked.bundleDir } : {}) } : checked;
      },
    } };
  } catch { throw refused(); }
}
