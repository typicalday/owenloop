/**
 * The ONE place the bearer-token resolution / refusal logic lives. Agent
 * runtime roles share one precedence here; human-only decisions use their own
 * explicit credential boundary rather than re-deriving either path.
 *
 * Agent mode:
 *   1. `OWENLOOP_TOKEN` (trimmed, non-empty) — an EXPLICIT dev-only override.
 *      When set, it is used verbatim and the store + account are skipped.
 *   2. Otherwise read the `agent:<account>` slot from owenloop's store:
 *      - a `Credential`  → its bearer token (`credentialToToken`).
 *      - `null`          → refuse (code 2): no Scoped Identity key for this origin/account,
 *                          naming a runnable `owenloop login` connect command.
 *      - a THROW         → error (code 1): a genuine read failure (bad origin /
 *                          external-command failure), surfaced with its message.
 *
 * Human mode reads ONLY the `human` slot. It deliberately does not honor the
 * principal-ambiguous dev override or an agent account: callers use it for
 * human-only hub verbs and must either supply a human credential or refuse
 * locally with an actionable login command. A stored human OAuth credential may
 * refresh and persist its rotation through the root package's shared lock; this
 * resolver never mints, logs, or otherwise exposes credentials.
 *
 * The refuse (code 2) is a refuse-to-start precondition, mirroring the old
 * "no token" exit code, so existing exit-code assertions stay valid. Agent
 * mode is read-only; human decision mode may persist a rotation of a credential
 * the user already stored.
 */
import { OwenloopCredentialReader } from './owenloop.ts';
import { credentialToToken } from './reader.ts';
import { ensureFreshOAuth, readStoredCredential } from '../../../../src/index.ts';
import type { CredentialIO } from '../../../../src/index.ts';

export type BearerResult = { ok: true; token: string } | { ok: false; code: number; message: string };

export type ResolveBearerArgs =
  | {
      origin: string;
      account: string;
      env: Record<string, string | undefined>;
      principal?: 'agent';
    }
  | {
      origin: string;
      env: Record<string, string | undefined>;
      principal: 'human';
      account?: never;
      credentialIo?: Omit<CredentialIO, 'env'>;
    };

/**
 * The owenloop `--as <slot>` argument for an account: `agent` for the default
 * account, `agent:<account>` otherwise. Grounded from owenloop's `--as`
 * semantics (`human` | `agent` | `agent:<account>`).
 */
export function slotArg(account: string): string {
  return account === 'default' ? 'agent' : `agent:${account}`;
}

export async function resolveBearer(args: ResolveBearerArgs): Promise<BearerResult> {
  const { origin, env } = args;

  if (args.principal === 'human') {
    const io: CredentialIO = { env, ...args.credentialIo };
    let cred;
    try {
      cred = readStoredCredential(origin, { principal: 'human', env: io.env, keychain: io.keychain });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
	ok: false,
	code: 1,
	message: `human credential read failed for ${origin}: ${detail}`,
      };
    }

    if (cred === null) {
      return {
	ok: false,
	code: 2,
	message: `no human credential for ${origin} — run: owenloop login --hub ${origin} --as human`,
      };
    }

    try {
      const fresh = await ensureFreshOAuth(io, origin, { principal: 'human' }, cred);
      return { ok: true, token: credentialToToken(fresh) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
	ok: false,
	code: 1,
	message: `human credential refresh failed for ${origin}: ${detail}`,
      };
    }
  }

  const { account } = args;

  // 1. Dev-only override: explicit OWENLOOP_TOKEN bypasses the store + account.
  const override = env['OWENLOOP_TOKEN']?.trim();
  if (override !== undefined && override !== '') {
    return { ok: true, token: override };
  }

  // 2. The store: read ONLY the agent:<account> slot (never human).
  let cred;
  try {
    cred = await new OwenloopCredentialReader({ account, env }).read(origin);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 1,
      message: `credential read failed for ${origin} (account "${account}"): ${detail}`,
    };
  }

  if (cred === null) {
    return {
      ok: false,
      code: 2,
      message: `no Scoped Identity key for ${origin} (account "${account}") — run: owenloop login --hub ${origin} --as ${slotArg(account)}`,
    };
  }

  return { ok: true, token: credentialToToken(cred) };
}
