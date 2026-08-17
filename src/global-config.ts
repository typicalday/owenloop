/**
 * `~/.owenloop/config.json` — the CONTROL plane's non-secret configuration file.
 *
 * Sole writer: `owenloop login` (`dispatchLogin` in `src/cli.ts`), which records
 * the hub origin it just authenticated against here, best-effort, after the
 * credential itself has already been stored. Sole reader: `owenloop mcp`'s
 * origin ladder (`resolveMcpOrigin` in `src/mcp/serve.ts`), which needs to know
 * which hub the operator is using WITHOUT enumerating the credential store —
 * the store's `keychain` and `external` backends cannot be listed at all (see
 * `listStoredHubOrigins` in `src/hub.ts`), so a value that lived only inside
 * the credential vault would be unreadable to the server on the majority of
 * real installs (macOS defaults to the keychain backend).
 *
 * This is deliberately a SEPARATE file from `src/work-settings.ts`'s
 * `~/.owenloop/settings.json`. That file belongs to the EXECUTION plane: `owenloop setup` is its
 * sole writer, and `owenloop work` role resolution and pre-commit verification
 * are its readers. This file belongs to the CONTROL plane: `owenloop login`
 * writes it, `owenloop mcp` reads it. Nothing reconciles the two if they
 * disagree — e.g. after `owenloop login --hub A` followed by
 * `owenloop setup --hub B` — and that is an accepted cost, not an oversight:
 * the two files answer different questions ("what hub does an agent shift run
 * against" vs. "what hub does the human's MCP session talk to") for two
 * independently-evolving call paths, and forcing one file to answer both would
 * couple them for no benefit. Both files are HOME-rooted siblings in the same
 * directory; their control-plane versus execution-plane responsibilities, not
 * their location, keep them separate.
 *
 * Never holds a secret: `hub` is an origin URL, nothing else. A read failure
 * of any kind (file absent, invalid JSON, wrong shape, blank `hub`, or a
 * `hub` value that does not normalize to a valid http(s) origin) is reported
 * as `null`, never thrown — this file is one rung of a fallback ladder
 * (`resolveMcpOrigin`), and a corrupt or half-written config must not be able
 * to crash `owenloop mcp` at startup; the ladder simply falls through to the
 * next rung instead.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirRefusingSymlink } from './util.ts';
import { normalizeOrigin, writeFileAtomic } from './hub.ts';

/** The shape of `~/.owenloop/config.json`. `version` is reserved for a future migration. */
export interface GlobalConfig {
  version: 1;
  hub: string;
}

/** `<home>/.owenloop/config.json` — `home` is the caller-resolved `HOME`/`USERPROFILE` value. */
export function globalConfigPath(home: string): string {
  return join(home, '.owenloop', 'config.json');
}

/**
 * Read and validate `path`. Returns `null` — never throws — when the file is
 * absent, is not valid JSON, is not a JSON object, its `hub` field is
 * missing, non-string, or blank, or `hub` does not normalize to a valid
 * http(s) origin (`normalizeOrigin`, `src/hub.ts` — e.g. `"not a url"` or a
 * bare hostname with no scheme). Callers treat `null` as "this rung has
 * nothing to offer" and fall through to the next one. The `hub` on a non-null
 * return is always normalized (scheme required, trailing slash/path
 * stripped) — the same guarantee every other rung of `resolveMcpOrigin`
 * provides, so callers never need to re-normalize what this returns.
 */
export function readGlobalConfig(path: string): GlobalConfig | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const hub = (parsed as Record<string, unknown>).hub;
  if (typeof hub !== 'string' || hub.trim() === '') return null;
  try {
    return { version: 1, hub: normalizeOrigin(hub) };
  } catch {
    return null;
  }
}

/** Write `config` to `path`, creating its parent directory if needed. Atomic (see `writeFileAtomic`). */
export function writeGlobalConfig(path: string, config: GlobalConfig): void {
  mkdirRefusingSymlink(dirname(path));
  writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
}
