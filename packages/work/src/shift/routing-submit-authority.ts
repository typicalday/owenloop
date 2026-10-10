/** Parent-only signing, never a general signing service for a child. */
import { buildSubmitProof, type SubmissionKeyManager } from '../submit-proof.ts';
import type { SshProcessAdapter } from '../../../../src/crypto/ssh.ts';
import type { GetOrderResponse, OrderPacket } from '../hub/types.ts';

export interface RoutedSubmissionAuthority {
  /** Validate the full current order against signed staged source and current
   * parent trust, including actual workdir and consumed-value provenance. */
  verifyOrder(response: GetOrderResponse): Promise<void>;
  sign(order: OrderPacket, path: string, value: unknown, issuedVersion?: number): Promise<string>;
  /** The signed source must identify an output the current protocol can sign.
   * Dynamic collection members need their own issued path/version protocol. */
  canSubmit(order: OrderPacket, path: string): boolean;
  /** True only for an owed collection seal in the signed staged definition. */
  canCollect?(order: OrderPacket, sealPath: string): boolean;
  /** Verified singleton/judge semantics only. A seal target does not dedupe
   * dynamic member emissions, so their uncertain outcomes must quarantine. */
  canReplay?(order: OrderPacket, path: string): boolean;
}

export function createRoutedSubmissionAuthority(args: {
  origin: string;
  env: Record<string, string | undefined>;
  verifyOrder: RoutedSubmissionAuthority['verifyOrder'];
  now: () => number;
  principalKeys?: SubmissionKeyManager;
  sshProcess?: SshProcessAdapter;
  canReplay?: RoutedSubmissionAuthority['canReplay'];
  canSubmit: RoutedSubmissionAuthority['canSubmit'];
  canCollect?: RoutedSubmissionAuthority['canCollect'];
}): RoutedSubmissionAuthority {
  return {
    verifyOrder: args.verifyOrder,
    ...(args.canReplay ? { canReplay: args.canReplay } : {}),
    canSubmit: args.canSubmit,
    ...(args.canCollect ? { canCollect: args.canCollect } : {}),
    async sign(order, path, value, issuedVersion) {
      const proof = await buildSubmitProof({
	origin: args.origin, env: args.env, order, path, value, now: args.now,
	...(issuedVersion === undefined ? {} : { version: issuedVersion }),
	warn: () => {}, required: true,
	...(args.principalKeys ? { principalKeys: args.principalKeys } : {}),
	...(args.sshProcess ? { sshProcess: args.sshProcess } : {}),
      });
      if (!proof) throw new Error('routed machine signer unavailable');
      return proof;
    },
  };
}
