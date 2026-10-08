/** Parent-only signing, never a general signing service for a child. */
import { buildSubmitProof, type SubmissionKeyManager } from '../submit-proof.ts';
import type { SshProcessAdapter } from '../../../../src/crypto/ssh.ts';
import type { GetOrderResponse, OrderPacket } from '../hub/types.ts';

export interface RoutedSubmissionAuthority {
  /** Validate the full current order against signed staged source and current
   * parent trust, including actual workdir and consumed-value provenance. */
  verifyOrder(response: GetOrderResponse): Promise<void>;
  sign(order: OrderPacket, path: string, value: unknown): Promise<string>;
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
}): RoutedSubmissionAuthority {
  return {
    verifyOrder: args.verifyOrder,
    ...(args.canReplay ? { canReplay: args.canReplay } : {}),
    async sign(order, path, value) {
      const proof = await buildSubmitProof({
	origin: args.origin, env: args.env, order, path, value, now: args.now,
	warn: () => {}, required: true,
	...(args.principalKeys ? { principalKeys: args.principalKeys } : {}),
	...(args.sshProcess ? { sshProcess: args.sshProcess } : {}),
      });
      if (!proof) throw new Error('routed machine signer unavailable');
      return proof;
    },
  };
}
