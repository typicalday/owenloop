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
  /** Explicit committed version when the caller has a version-aware hub packet. */
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
    produced: [{ artifact: opts.path, version: outputVersionForSubmission(opts.order, opts.path, opts.version), value: opts.value }],
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
 * Infer the version that the next producer commit will name when the reduced
 * driver packet has no explicit version hint. Fresh artifact rows start at
 * version zero, so the first commit is version one. A judged approval reuses
 * the submitted stem's version, which is present in the claim fingerprint.
 * A retry after an earlier committed/rejected version advances from the latest
 * reason's source version. This is a best-effort inference because the reduced
 * packet does not carry the coordinator's post-commit version; callers with an
 * authoritative version must pass `version` explicitly.
 */
export function outputVersionForSubmission(order: OrderPacket, path: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const consumed = order.consumedFingerprint?.[path];
  if (consumed !== undefined) return consumed;
  const owe = order.owes.find((entry) => entry.path === path);
  const fromVersion = owe?.reasons.at(-1)?.fromVersion;
  return fromVersion === undefined ? 1 : fromVersion + 1;
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
