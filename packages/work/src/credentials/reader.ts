/**
 * Credential read seam. owenwork reads hub credentials through owenloop's
 * store ONLY — it never writes, prints, or stores credentials itself, and it
 * never reads the keychain or `credentials.json` formats directly.
 *
 * The live wiring is against owenloop 0.4.0's `readStoredCredential`
 * (src/credentials/owenloop.ts → `OwenloopCredentialReader`). owenwork reads
 * ONLY the `agent:<account>` slots — never the `human` slot — so a human-only
 * origin reads as absent (`null`), which the roles surface as a clean refuse.
 * `Credential` is re-exported from owenloop below so this seam and the store
 * speak the exact same union.
 */

/** The root package's stored-credential union (agent / oauth / oauth-pasted). */
export type { Credential } from '../../../../src/hub.ts';
import type { Credential } from '../../../../src/hub.ts';

/**
 * Reads a stored credential for a hub origin. `read` resolves to `null` when
 * no credential is stored for that origin. Read-only by contract.
 */
export interface CredentialReader {
  read(origin: string): Promise<Credential | null>;
}

/**
 * In-memory reader seeded from a `Record<origin, Credential>`. Lives in `src`
 * (not `test/`) because C2+ role tests reuse it to stand in for the real store.
 */
export class FakeCredentialReader implements CredentialReader {
  private readonly store: Record<string, Credential>;

  constructor(store: Record<string, Credential> = {}) {
    this.store = store;
  }

  async read(origin: string): Promise<Credential | null> {
    return this.store[origin] ?? null;
  }
}

/**
 * Bridge from a stored credential to the bearer token the hub client's
 * `getToken` seam expects. Every credential kind carries an `accessToken`.
 */
export function credentialToToken(c: Credential): string {
  return c.accessToken;
}
