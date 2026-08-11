import {
  DSSE_SSH_NAMESPACE,
  PrincipalKeyManager,
  buildSubmissionRecord,
  createSshSigner,
  signSubmission,
} from '../../../src/crypto/index.ts';
import type { SshProcessAdapter } from '../../../src/crypto/ssh.ts';
import type { OrderPacket } from './hub/types.ts';

export type SubmissionKeyManager = Pick<PrincipalKeyManager, 'inspect' | 'resolveRef' | 'withSigningKey'>;

export interface SubmitProofOptions {
  origin: string;
  order: OrderPacket;
  path: string;
  value: unknown;
  /** Exact target version issued by a version-aware, retry-safe hub protocol. */
  version?: number;
  now: () => number;
  warn: (line: string) => void;
  principalKeys?: SubmissionKeyManager;
  env?: Record<string, string | undefined>;
  /** Injectable ssh-keygen seam for hermetic callers and tests. */
  sshProcess?: SshProcessAdapter;
}

let warnedUnsigned = false;

/**
 * Sign one driver submit at the transport boundary. A missing machine key is
 * deliberately an unsigned fallback for WP-D2; signer/tool failures still
 * propagate because silently dropping a configured key would hide corruption.
 */
export async function buildSubmitProof(opts: SubmitProofOptions): Promise<string | undefined> {
  const version = outputVersionForSubmission(opts.order, opts.path, opts.version);
  if (version === undefined) {
    warnUnsigned(
      opts.warn,
      `order ${opts.order.workflow}/${opts.order.run} omitted authoritative version metadata for output '${opts.path}'; submitting without a proof`,
    );
    return undefined;
  }
  const consumedFingerprint = submissionFingerprint(opts.order, opts.warn);
  if (consumedFingerprint === undefined) return undefined;

  let keys: SubmissionKeyManager;
  try {
    keys = opts.principalKeys ?? new PrincipalKeyManager({ env: opts.env ?? process.env });
  } catch (error) {
    warnUnsigned(opts.warn, `machine signing is unavailable (${errorMessage(error)}); submitting without a proof`);
    return undefined;
  }
  const ref = keys.resolveRef(opts.origin, 'machine');
  if (ref === null) {
    warnUnsigned(opts.warn, `no machine signing key for ${opts.origin}; submitting without a proof`);
    return undefined;
  }

  const inspected = await keys.inspect(ref);
  if (!inspected.exists || inspected.publicKey === undefined) {
    warnUnsigned(opts.warn, `machine signing key for ${opts.origin} is unavailable; submitting without a proof`);
    return undefined;
  }

  const record = buildSubmissionRecord({
    run: opts.order.run,
    workflow: opts.order.workflow,
    defDigest: opts.order.defDigest,
    step: opts.order.step,
    key: opts.order.key,
    ...(opts.order.index !== undefined ? { index: opts.order.index } : {}),
    produced: [{ artifact: opts.path, version, value: opts.value }],
    consumedFingerprint,
    producerKeyId: inspected.publicKey.keyid,
    timestamp: opts.now(),
  });

  return keys.withSigningKey(ref, async (keyPath) => {
    const signer = createSshSigner({
      namespace: DSSE_SSH_NAMESPACE,
      signKeyPath: keyPath,
      ...(opts.sshProcess !== undefined ? { process: opts.sshProcess } : {}),
    });
    return signSubmission(record, signer);
  });
}

function submissionFingerprint(
  order: OrderPacket,
  warn: (line: string) => void,
): NonNullable<OrderPacket['consumedFingerprint']> | undefined {
  if (order.consumedFingerprint !== undefined) return order.consumedFingerprint;
  if (order.inputs.length > 0 || Object.keys(order.consumes).length > 0) {
    warnUnsigned(warn, `order ${order.workflow}/${order.run} omitted its consumed fingerprint; submitting without a proof`);
    return undefined;
  }
  return {};
}

/**
 * Resolve the version named by the next submission from authoritative lifecycle
 * metadata only. A judge approval attests the already-submitted version captured
 * in the claim fingerprint and does not increment it. A producer submit requires
 * an explicit target version issued by a retry-safe hub protocol: `owes[].version`
 * is immutable claim-time state and becomes stale after a refinement, lost
 * response, unsigned commit, or holder restart. Without an explicit target,
 * callers must submit without a proof rather than sign a process-local guess.
 */
export function outputVersionForSubmission(
  order: OrderPacket,
  path: string,
  explicit?: number,
): number | undefined {
  if (explicit !== undefined) return explicit;
  if (order.judge === path) return order.consumedFingerprint?.[path];
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnUnsigned(warn: (line: string) => void, reason: string): void {
  if (warnedUnsigned) return;
  warnedUnsigned = true;
  warn(`owenloop: ${reason}`);
}

/** Reset the process-local warning latch for hermetic tests. */
export function resetSubmitProofWarningForTests(): void {
  warnedUnsigned = false;
}
