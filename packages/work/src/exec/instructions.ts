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
import { globalStoreRoot } from '../../../../src/store/resolve.ts';
import type { StepDef, WorkflowDef } from '../../../../src/types.ts';
import type { DefPolicy, DefVerdict } from '../../../../src/crypto/verify-publication.ts';
import { mergePolicyFloorWithLocal } from '../../../../src/crypto/policy-floor.ts';
import type { PolicyFloor } from '../../../../src/crypto/records.ts';
import {
  createExecutionDefinitionVerifier,
  resolveDefPolicy,
} from '../../../../src/store/pre-commit-verifier.ts';
import type { OrderPacket } from '../hub/types.ts';

export type InstructionRefusalKind =
  | 'unknown-digest'
  | 'unknown-step'
  | 'integrity'
  | 'no-digest'
  | 'missing-command'
  | 'unverified-def';

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

export interface StoreInstructionResolverOptions {
  projectRoot?: string;
  globalRoot: string;
  verifier: BundleIngestor;
  source?: StoreInstructionSource;
  /** Optional execution-time publication verifier. Omitted means publication trust is unverifiable and command orders refuse. */
  definitionVerifier?: DefinitionVerifier;
  /** Explicit policy override; otherwise env > settings file > warn. */
  defPolicy?: DefPolicy;
  /** Already-verified organization floor; absent means local policy only. */
  policyFloor?: PolicyFloor;
  /** Diagnostic sink for `defPolicy=warn`. Defaults to stderr. */
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
  let policy: DefPolicy | undefined;
  const readPolicy = (): DefPolicy => {
    policy ??= mergePolicyFloorWithLocal(
      resolveDefPolicy(env, options.defPolicy),
      options.policyFloor,
    ).effective;
    return policy;
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

  const resolveAgentStep = async (order: OrderPacket): Promise<ResolvedStep | InstructionRefusal> => {
    const resolved = await resolveVerifiedStep(order);
    if (!resolved.ok) return resolved;
    const verdict = await trustFor(order, resolved);
    if (verdict.kind === 'verified') return { ok: true, step: resolved.step };

    // Read the policy only after the execution-time verdict is known. This
    // keeps invalid signatures fail-closed and leaves command handling below
    // independent from policy lookup.
    const selected = readPolicy();
    if (verdict.kind === 'invalid' || selected === 'enforce') return refuseUnverified(order, verdict);
    if (selected === 'warn') {
      warn(`workflow definition '${order.defDigest}' is ${verdict.kind}; defPolicy=warn allows agent execution: ${verdict.kind === 'unverifiable' ? verdict.reason : 'no publication signature'}`);
    }
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
  defPolicy?: DefPolicy;
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
    ...(args.defPolicy !== undefined ? { defPolicy: args.defPolicy } : {}),
    ...(args.policyFloor !== undefined ? { policyFloor: args.policyFloor } : {}),
    ...(args.warn !== undefined ? { warn: args.warn } : {}),
    env: args.env,
  });
}
