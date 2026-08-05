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
import type { StepDef } from '../../../../src/types.ts';
import type { OrderPacket } from '../hub/types.ts';

export type InstructionRefusalKind =
  | 'unknown-digest'
  | 'unknown-step'
  | 'integrity'
  | 'no-digest'
  | 'missing-command';

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

export interface StoreInstructionResolverOptions {
  projectRoot?: string;
  globalRoot: string;
  verifier: BundleIngestor;
  source?: StoreInstructionSource;
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

export function createStoreInstructionResolver(
  options: StoreInstructionResolverOptions,
): InstructionResolver {
  const source = options.source ?? createStoreInstructionSource({
    projectRoot: options.projectRoot,
    globalRoot: options.globalRoot,
    verifier: options.verifier,
  });

  const resolveVerifiedStep = async (order: OrderPacket): Promise<ResolvedStep | InstructionRefusal> => {
    const digest = digestFor(order);
    if (typeof digest !== 'string') return digest;
    try {
      const primed = await source.prime(digest);
      if (primed === 'unknown-digest') {
        return refusal('unknown-digest', order, 'no verified local workflow bundle matches the order digest');
      }
      const step = source.getVerifiedStep(digest, order.step);
      if (step === undefined) {
        return refusal('unknown-step', order, 'the verified workflow definition has no matching step');
      }
      return { ok: true, step };
    } catch (error) {
      return refusal('integrity', order, errorText(error));
    }
  };

  return {
    async resolveCommand(order: OrderPacket): Promise<ResolvedCommand | InstructionRefusal> {
      const resolved = await resolveVerifiedStep(order);
      if (!resolved.ok) return resolved;
      if (typeof resolved.step.command !== 'string' || resolved.step.command.trim() === '') {
        return refusal('missing-command', order, 'the verified step has no non-empty command text');
      }
      // Deliberately return the authored bytes exactly. Runtime substitutions
      // belong to prompts only; this string is passed to `/bin/sh -c`.
      return { ok: true, command: resolved.step.command };
    },

    resolveStep: resolveVerifiedStep,
  };
}

/** Build the production resolver from injected process environment and cwd. */
export function createDefaultStoreInstructionResolver(args: {
  cwd: string;
  env: Record<string, string | undefined>;
  verifier?: BundleIngestor;
}): InstructionResolver {
  const home = [args.env.HOME, args.env.USERPROFILE].find(
    (value) => value !== undefined && value.trim() !== '',
  );
  if (home === undefined) {
    throw new Error('cannot locate the global workflow store: set HOME or USERPROFILE');
  }
  return createStoreInstructionResolver({
    projectRoot: join(args.cwd, 'workflows'),
    globalRoot: globalStoreRoot(home),
    verifier: args.verifier ?? createBundleIngestor(),
  });
}
