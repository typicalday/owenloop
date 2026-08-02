/**
 * The ONE place the bearer-token resolution / refuse / dev-override logic lives,
 * so all five roles share identical precedence instead of re-deriving it:
 *
 *   1. `OWENLOOP_TOKEN` (trimmed, non-empty) — an EXPLICIT dev-only override.
 *      When set, it is used verbatim and the store + account are skipped.
 *   2. Otherwise read the `agent:<account>` slot from owenloop's store:
 *      - a `Credential`  → its bearer token (`credentialToToken`).
 *      - `null`          → refuse (code 2): no Scoped Identity key for this origin/account,
 *                          naming a runnable `owenloop login` connect command.
 *      - a THROW         → error (code 1): a genuine read failure (bad origin /
 *                          external-command failure), surfaced with its message.
 *
 * The refuse (code 2) is a refuse-to-start precondition, mirroring the old
 * "no token" exit code, so existing exit-code assertions stay valid — only the
 * message text changes. owenloop stays read-only w.r.t. credentials.
 */
import { OwenloopCredentialReader } from './owenloop.ts';
import { credentialToToken } from './reader.ts';

export type BearerResult = { ok: true; token: string } | { ok: false; code: number; message: string };

/**
 * The owenloop `--as <slot>` argument for an account: `agent` for the default
 * account, `agent:<account>` otherwise. Grounded from owenloop's `--as`
 * semantics (`human` | `agent` | `agent:<account>`).
 */
export function slotArg(account: string): string {
  return account === 'default' ? 'agent' : `agent:${account}`;
}

export async function resolveBearer(args: {
  origin: string;
  account: string;
  env: Record<string, string | undefined>;
}): Promise<BearerResult> {
  const { origin, account, env } = args;

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
