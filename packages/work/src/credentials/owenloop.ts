/**
 * Live credential reader backed by owenloop 0.4.0's `readStoredCredential`.
 *
 * This is the ONE enforcement point for "owenwork never reads the human slot":
 * it always addresses `principal: 'agent'` with the configured account. A
 * human-only origin therefore reads as absent (`null`) — owenloop's slots are
 * distinct storage keys, so a Scoped Identity read never falls back to `human`.
 *
 * `read()` lets owenloop's THROWS propagate: a remote-plaintext / invalid
 * origin (SEC-2) or an external-credential-command failure are genuine errors,
 * distinct from the `null` "no Scoped Identity key" case that the resolver turns into a
 * refuse-to-start. Read-only by contract — owenwork never writes credentials.
 */
import { readStoredCredential } from '../../../../src/hub.ts';
import type { Credential, Keychain } from '../../../../src/hub.ts';
import type { CredentialReader } from './reader.ts';

export class OwenloopCredentialReader implements CredentialReader {
  private readonly opts: { account: string; env?: Record<string, string | undefined>; keychain?: Keychain };

  constructor(opts: { account: string; env?: Record<string, string | undefined>; keychain?: Keychain }) {
    this.opts = opts;
  }

  async read(origin: string): Promise<Credential | null> {
    return readStoredCredential(origin, {
      principal: 'agent',
      account: this.opts.account,
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
      ...(this.opts.keychain !== undefined ? { keychain: this.opts.keychain } : {}),
    });
  }
}
