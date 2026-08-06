/**
 * Driver-side instruction resolution.
 *
 * A worker packet is a reference packet. The packet's `defDigest` selects
 * instruction bytes from a verified local workflow-store object; command text,
 * prompt text, and step metadata supplied by a remote coordinator are never
 * authoritative. The command resolver returns the exact authored command and
 * does not perform placeholder substitution.
 */

import { join } from 'node:path';
import { createBundleIngestor, createStoreInstructionSource } from '../../../../src/store/index.ts';
import type { BundleIngestor, StoreInstructionSource } from '../../../../src/store/index.ts';
import { readWorkflowStoreIndex } from '../../../../src/store/index-file.ts';
import { projectStoreRoot, probeStoreRoot, storeIndexPath, globalStoreRoot } from '../../../../src/store/resolve.ts';
import { parseWorkflowCoordinate } from '../../../../src/store/types.ts';
import type { StepDef, WorkflowDef } from '../../../../src/types.ts';
import type { DefPolicy, DefVerdict } from '../../../../src/crypto/verify-publication.ts';
import { evaluateOriginRule, matchOriginRule } from '../../../../src/crypto/origin-rules.ts';
import type { OriginRuleMatch, OriginRules } from '../../../../src/crypto/origin-rules.ts';
import type { OriginVerdict } from '../../../../src/crypto/verify-origin.ts';
import { mergePolicyFloorWithLocal } from '../../../../src/crypto/policy-floor.ts';
import type { PolicyFloor } from '../../../../src/crypto/records.ts';
import {
  createExecutionDefinitionVerifier,
  createExecutionOriginVerifier,
  resolveDefPolicy,
  resolveOriginPolicy,
  resolveOriginRules,
} from '../../../../src/store/pre-commit-verifier.ts';
import type { OrderPacket } from '../hub/types.ts';

export type InstructionRefusalKind =
  | 'unknown-digest'
  | 'unknown-step'
  | 'integrity'
  | 'no-digest'
  | 'missing-command'
  | 'unverified-def'
  | 'origin-policy';

export interface InstructionRefusal {
  ok: false;
  reason: string;
  kind: InstructionRefusalKind;
}

export interface ResolvedCommand {
  ok: true;
  command: string;
}

export interface ResolvedStep {
  ok: true;
  step: StepDef;
}

export interface InstructionResolver {
  resolveCommand(order: OrderPacket): Promise<ResolvedCommand | InstructionRefusal>;
  resolveStep(order: OrderPacket): Promise<ResolvedStep | InstructionRefusal>;
}

export interface DefinitionVerifierInput {
  defDigest: string;
  definition: WorkflowDef;
  step: StepDef;
  /** Bundle digest and installed object path used to locate publication evidence. */
  bundleDigest: string;
  objectPath: string;
}

/**
 * Execution-time trust check. The verifier is called after the store has
 * re-verified the installed bytes and before instruction text is returned.
 * Returning a verdict keeps unsigned/unverifiable distinct from an invalid
 * present signature; throwing is treated as an integrity-style refusal.
 */
export type DefinitionVerifier = (input: DefinitionVerifierInput) => Promise<DefVerdict> | DefVerdict;

/** Execution-time origin verifier bound to installed bundle evidence. */
export interface OriginVerifierInput {
  bundleDigest: string;
  objectPath: string;
}

export type OriginVerifier = (input: OriginVerifierInput) => Promise<OriginVerdict> | OriginVerdict;

export interface StoreInstructionResolverOptions {
  projectRoot?: string;
  globalRoot: string;
  verifier: BundleIngestor;
  source?: StoreInstructionSource;
  /** Optional execution-time publication verifier. Omitted means publication trust is unverifiable and command orders refuse. */
  definitionVerifier?: DefinitionVerifier;
  /** Optional execution-time origin verifier. */
  originVerifier?: OriginVerifier;
  /** Explicit publication policy override; otherwise env > settings file > warn. */
  defPolicy?: DefPolicy;
  /** Explicit origin policy override; otherwise env > settings file > warn. */
  originPolicy?: DefPolicy;
  /** Explicit namespace-scoped origin rules. */
  originRules?: OriginRules;
  /** Already-verified organization floor; absent means local policy only. */
  policyFloor?: PolicyFloor;
  /** Diagnostic sink for `defPolicy=warn` and `originPolicy=warn`. Defaults to stderr. */
  warn?: (line: string) => void;
  /** Injected environment used for policy resolution. */
  env?: Record<string, string | undefined>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusal(
  kind: InstructionRefusalKind,
  order: OrderPacket,
  detail: string,
): InstructionRefusal {
  const digest = order.defDigest === undefined || order.defDigest === '' ? '<missing>' : order.defDigest;
  return {
    ok: false,
    kind,
    reason: `instruction refusal (${kind}) for ${order.workflow}/${order.run} step '${order.step}' defDigest '${digest}': ${detail}`,
  };
}

function digestFor(order: OrderPacket): string | InstructionRefusal {
  if (typeof order.defDigest !== 'string' || order.defDigest.trim() === '') {
    return refusal('no-digest', order, 'the order has no non-empty defDigest');
  }
  return order.defDigest;
}

interface ResolvedDefinition {
  ok: true;
  definition: WorkflowDef;
  step: StepDef;
  bundleDigest: string;
  objectPath: string;
}

type ResolvedDefinitionOrRefusal = ResolvedDefinition | InstructionRefusal;

function verdictDescription(verdict: DefVerdict): string {
  if (verdict.kind === 'verified') return 'definition is verified';
  if (verdict.kind === 'unsigned') return 'unsigned: definition has no publication signature';
  return `${verdict.kind}: ${verdict.reason}`;
}

export function createStoreInstructionResolver(
  options: StoreInstructionResolverOptions,
): InstructionResolver {
  const source = options.source ?? createStoreInstructionSource({
    projectRoot: options.projectRoot,
    globalRoot: options.globalRoot,
    verifier: options.verifier,
  });
  const env = options.env ?? {};
  let mergedPolicies: ReturnType<typeof mergePolicyFloorWithLocal> | undefined;
  const readPolicies = (): ReturnType<typeof mergePolicyFloorWithLocal> => {
    mergedPolicies ??= mergePolicyFloorWithLocal(
      resolveDefPolicy(env, options.defPolicy),
      options.policyFloor,
      resolveOriginPolicy(env, options.originPolicy),
    );
    return mergedPolicies;
  };
  const readPolicy = (): DefPolicy => readPolicies().effective;
  const readOriginPolicy = (): DefPolicy => readPolicies().originPolicy;
  let originRules: OriginRules | undefined;
  const readOriginRules = (): OriginRules => {
    originRules ??= resolveOriginRules(env, options.originRules);
    return originRules;
  };
  const warn = options.warn ?? ((line: string): void => void console.error(line));

  const resolveVerifiedStep = async (order: OrderPacket): Promise<ResolvedDefinitionOrRefusal> => {
    const digest = digestFor(order);
    if (typeof digest !== 'string') return digest;
    try {
      const primed = await source.prime(digest);
      if (primed === 'unknown-digest') {
        return refusal('unknown-digest', order, 'no verified local workflow bundle matches the order digest');
      }
      const definition = source.getVerifiedDefinition(digest);
      if (definition === undefined) return refusal('integrity', order, 'the verified workflow definition is unavailable after priming');
      const step = source.getVerifiedStep(digest, order.step);
      if (step === undefined) {
        return refusal('unknown-step', order, 'the verified workflow definition has no matching step');
      }
      const object = source.getVerifiedObject(digest);
      if (object === undefined) return refusal('integrity', order, 'the verified workflow object metadata is unavailable after priming');
      return { ok: true, definition, step, bundleDigest: object.bundleDigest, objectPath: object.objectPath };
    } catch (error) {
      return refusal('integrity', order, errorText(error));
    }
  };

  const trustFor = async (order: OrderPacket, resolved: ResolvedDefinition): Promise<DefVerdict> => {
    if (options.definitionVerifier === undefined) {
      return { kind: 'unverifiable', reason: 'execution-time publication verifier is not configured' };
    }
    try {
      return await options.definitionVerifier({ defDigest: order.defDigest, definition: resolved.definition, step: resolved.step, bundleDigest: resolved.bundleDigest, objectPath: resolved.objectPath });
    } catch (error) {
      return { kind: 'unverifiable', reason: errorText(error) };
    }
  };

  const refuseUnverified = (order: OrderPacket, verdict: DefVerdict): InstructionRefusal =>
    refusal('unverified-def', order, verdictDescription(verdict));

  interface IndexedOriginRule {
    coordinate: string;
    namespace: string;
    match: OriginRuleMatch;
  }

  type OriginRuleResolution =
    | { kind: 'none' }
    | { kind: 'unknown' }
    | { kind: 'match'; match: OriginRuleMatch; entries: IndexedOriginRule[] }
    | { kind: 'ambiguous'; entries: IndexedOriginRule[] };

  const recoverOriginRule = (
    bundleDigest: string,
    rules: OriginRules,
  ): OriginRuleResolution => {
    const roots = [
      options.projectRoot === undefined ? undefined : projectStoreRoot(options.projectRoot),
      projectStoreRoot(options.globalRoot),
    ].filter((root): root is string => root !== undefined);
    const uniqueRoots = [...new Set(roots)];
    const entries: IndexedOriginRule[] = [];
    let foundCoordinate = false;

    for (const root of uniqueRoots) {
      if (probeStoreRoot(root) !== 'dir') continue;
      const index = readWorkflowStoreIndex(storeIndexPath(root));
      for (const [coordinate, entry] of Object.entries(index.entries)) {
        if (entry.digest !== bundleDigest) continue;
        foundCoordinate = true;
        const { namespace } = parseWorkflowCoordinate(coordinate);
        const match = matchOriginRule(rules, namespace);
        if (match !== undefined) entries.push({ coordinate, namespace, match });
      }
    }

    if (!foundCoordinate) return { kind: 'unknown' };
    if (entries.length === 0) return { kind: 'none' };

    const requirements = new Set(entries.map((entry) => entry.match.value));
    if (requirements.size > 1) return { kind: 'ambiguous', entries };
    return { kind: 'match', match: entries[0]!.match, entries };
  };

  const originFor = async (
    resolved: ResolvedDefinition,
  ): Promise<OriginVerdict> => {
    if (options.originVerifier === undefined) {
      return { kind: 'unverifiable', reason: 'execution-time origin verifier is not configured' };
    }
    try {
      return await options.originVerifier({ bundleDigest: resolved.bundleDigest, objectPath: resolved.objectPath });
    } catch (error) {
      return { kind: 'unverifiable', reason: errorText(error) };
    }
  };

  const originPolicyWarning = (
    order: OrderPacket,
    detail: string,
  ): void => {
    warn(`workflow definition '${order.defDigest}' was not admitted by origin policy; originPolicy=warn allows execution: ${detail}`);
  };

  const checkOrigin = async (
    order: OrderPacket,
    resolved: ResolvedDefinition,
  ): Promise<InstructionRefusal | undefined> => {
    const rules = readOriginRules();
    const verdict = await originFor(resolved);
    if (verdict.kind === 'invalid') {
      return refusal('origin-policy', order, `invalid origin evidence: ${verdict.reason}`);
    }
    if (Object.keys(rules).length === 0) return undefined;

    let resolution: OriginRuleResolution;
    try {
      resolution = recoverOriginRule(resolved.bundleDigest, rules);
    } catch (error) {
      return refusal('origin-policy', order, `could not recover the definition namespace from workflow-store indexes: ${errorText(error)}`);
    }

    const selectedPolicy = readOriginPolicy();
    if (resolution.kind === 'none') return undefined;
    if (resolution.kind === 'unknown') {
      const detail = 'the definition digest is not indexed under any namespace, so its origin rule cannot be determined';
      if (selectedPolicy === 'enforce') return refusal('origin-policy', order, detail);
      if (selectedPolicy === 'warn') originPolicyWarning(order, detail);
      return undefined;
    }
    if (resolution.kind === 'ambiguous') {
      const detail = resolution.entries
        .map((entry) => `${entry.namespace}=${entry.match.key} (${entry.match.value})`)
        .join(', ');
      const message = `the definition digest is indexed under namespaces with different origin rules: ${detail}`;
      if (selectedPolicy === 'enforce') return refusal('origin-policy', order, message);
      if (selectedPolicy === 'warn') originPolicyWarning(order, message);
      return undefined;
    }

    const evaluation = evaluateOriginRule(resolution.match.value, verdict);
    if (evaluation.ok) return undefined;
    const detail = `${evaluation.kind} — ${evaluation.detail}; rule ${resolution.match.key} requires ${resolution.match.value}`;
    if (selectedPolicy === 'enforce') return refusal('origin-policy', order, detail);
    if (selectedPolicy === 'warn') originPolicyWarning(order, detail);
    return undefined;
  };

  const resolveAgentStep = async (order: OrderPacket): Promise<ResolvedStep | InstructionRefusal> => {
    const resolved = await resolveVerifiedStep(order);
    if (!resolved.ok) return resolved;
    const verdict = await trustFor(order, resolved);

    // Read the policy only after the execution-time verdict is known. This
    // keeps invalid signatures fail-closed and leaves command handling below
    // independent from policy lookup.
    if (verdict.kind !== 'verified') {
      const selected = readPolicy();
      if (verdict.kind === 'invalid' || selected === 'enforce') return refuseUnverified(order, verdict);
      if (selected === 'warn') {
        warn(`workflow definition '${order.defDigest}' is ${verdict.kind}; defPolicy=warn allows agent execution: ${verdict.kind === 'unverifiable' ? verdict.reason : 'no publication signature'}`);
      }
    }
    const originRefusal = await checkOrigin(order, resolved);
    if (originRefusal !== undefined) return originRefusal;
    return { ok: true, step: resolved.step };
  };

  return {
    async resolveCommand(order: OrderPacket): Promise<ResolvedCommand | InstructionRefusal> {
      const resolved = await resolveVerifiedStep(order);
      if (!resolved.ok) return resolved;
      const verdict = await trustFor(order, resolved);
      // HARD RULE: command orders never consult defPolicy before this gate.
      // An unverified definition must never reach `/bin/sh -c`, including off.
      if (verdict.kind !== 'verified') return refuseUnverified(order, verdict);
      const originRefusal = await checkOrigin(order, resolved);
      if (originRefusal !== undefined) return originRefusal;
      if (typeof resolved.step.command !== 'string' || resolved.step.command.trim() === '') {
        return refusal('missing-command', order, 'the verified step has no non-empty command text');
      }
      // Deliberately return the authored bytes exactly. Runtime substitutions
      // belong to prompts only; this string is passed to `/bin/sh -c`.
      return { ok: true, command: resolved.step.command };
    },

    resolveStep: resolveAgentStep,
  };
}

/** Build the production resolver from injected process environment and cwd. */
export function createDefaultStoreInstructionResolver(args: {
  cwd: string;
  env: Record<string, string | undefined>;
  verifier?: BundleIngestor;
  definitionVerifier?: DefinitionVerifier;
  originVerifier?: OriginVerifier;
  defPolicy?: DefPolicy;
  originPolicy?: DefPolicy;
  originRules?: OriginRules;
  policyFloor?: PolicyFloor;
  warn?: (line: string) => void;
}): InstructionResolver {
  const home = [args.env.HOME, args.env.USERPROFILE].find(
    (value) => value !== undefined && value.trim() !== '',
  );
  if (home === undefined) {
    throw new Error('cannot locate the global workflow store: set HOME or USERPROFILE');
  }
  const projectRoot = join(args.cwd, 'workflows');
  const globalRoot = globalStoreRoot(home);
  const verifier = args.verifier ?? createBundleIngestor();
  const source = createStoreInstructionSource({
    projectRoot,
    globalRoot,
    verifier,
  });
  return createStoreInstructionResolver({
    projectRoot,
    globalRoot,
    verifier,
    source,
    definitionVerifier: args.definitionVerifier ?? createExecutionDefinitionVerifier({ env: args.env }),
    originVerifier: args.originVerifier ?? createExecutionOriginVerifier({ env: args.env }),
    ...(args.defPolicy !== undefined ? { defPolicy: args.defPolicy } : {}),
    ...(args.originPolicy !== undefined ? { originPolicy: args.originPolicy } : {}),
    ...(args.originRules !== undefined ? { originRules: args.originRules } : {}),
    ...(args.policyFloor !== undefined ? { policyFloor: args.policyFloor } : {}),
    ...(args.warn !== undefined ? { warn: args.warn } : {}),
    env: args.env,
  });
}
