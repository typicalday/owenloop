/**
 * The ONE settings writer in owenwork, provisioning-time only.
 *
 * `settings/settings.ts` is deliberately read-only (see its HARD RULE comment)
 * — every role loads settings, no role writes them. `owenloop work join` is the sole
 * exception: it is a one-time provisioning act, not a runtime write, so its
 * write path lives in this separate module rather than growing a write
 * function onto `settings.ts` itself.
 *
 * FIRST WRITE WINS: `recordHubOrigin` never overwrites a differing existing
 * `hubOrigin`. A box that has already recorded a hub is not silently
 * re-pointed at another one by a second `join` run; the caller (join.ts)
 * surfaces a `conflict` as a non-fatal warning instead.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeOrigin } from '../../../../src/hub.ts';

import { inspectSettings, settingsPath } from './settings.ts';

export type RecordHubOriginResult =
  | { outcome: 'written'; path: string }
  | { outcome: 'unchanged'; path: string }
  | { outcome: 'conflict'; path: string; existing: string };

/**
 * Record `origin` (already `normalizeOrigin`d by the caller) as
 * `settings.hubOrigin`, first-write-wins:
 *   - absent/blank `hubOrigin`  → merge-write `{ ...settings, hubOrigin: origin }`,
 *     creating the settings directory if needed. Unknown keys already in the
 *     file are preserved (`inspectSettings` retains them on `settings`).
 *   - present, normalizes equal → `unchanged`, no write (file byte-identical).
 *   - present, differs (or does not itself normalize) → `conflict`, no write.
 */
export function recordHubOrigin(env: Record<string, string | undefined>, origin: string): RecordHubOriginResult {
  const path = settingsPath(env);
  const { settings } = inspectSettings(env);
  const existing = settings.hubOrigin;

  if (existing === undefined || existing.trim() === '') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...settings, hubOrigin: origin }, null, 2)}\n`);
    return { outcome: 'written', path };
  }

  let normalizedExisting: string;
  try {
    normalizedExisting = normalizeOrigin(existing);
  } catch {
    return { outcome: 'conflict', path, existing };
  }

  if (normalizedExisting === origin) return { outcome: 'unchanged', path };
  return { outcome: 'conflict', path, existing };
}
