/**
 * Minimal, dependency-free `.tar.gz` reader for GitHub codeload tarballs.
 *
 * GitHub's tarball endpoint (`/repos/:owner/:repo/tarball/:ref`) emits a
 * gzipped USTAR/pax stream: short ASCII paths as plain USTAR headers, and
 * paths over 100 chars as a pax extended header (typeflag `'x'`) followed by
 * the real entry. GitHub does NOT emit GNU longname (`'L'`) entries — this
 * reader does not implement that typeflag; a repo path that happens to need
 * it would be silently skipped (unrepresentable, not corrupt).
 *
 * This is intentionally narrow: just enough tar to unpack a GitHub tarball,
 * not a general-purpose tar library. The parsing, resource limits, and path
 * policy live in `src/archive.ts` (the ONE shared archive boundary, also
 * used by `src/bundle/` and `src/add.ts`); this module keeps the historical
 * `extractTarGz` API and compatible reading behavior.
 */

import { DEFAULT_TAR_LIMITS, inflateArchive, parseTar } from './archive.ts';
import type { TarLimits } from './archive.ts';

export type { TarLimits };
export { DEFAULT_TAR_LIMITS };

/**
 * Extract a gzipped tar archive into a flat map of in-archive path → file
 * bytes. Directory entries are dropped; only regular files are kept. Pax
 * extended headers (typeflag 'x') are honored for long paths; pax global
 * headers (typeflag 'g') are skipped. Any other typeflag is skipped (its
 * data block(s) consumed and discarded so the stream stays in sync).
 *
 * Returns keys as the raw in-archive paths, including the leading
 * `<owner>-<repo>-<sha>/` root-dir component GitHub tarballs always have —
 * callers strip that themselves.
 */
export function extractTarGz(bytes: Uint8Array, limits: Partial<TarLimits> = {}): Map<string, Uint8Array> {
  const lim = { ...DEFAULT_TAR_LIMITS, ...limits };
  const tar = inflateArchive(bytes, lim);
  const entries = parseTar(tar, lim, { policy: 'compatible' });
  const out = new Map<string, Uint8Array>();
  for (const e of entries) out.set(e.path, e.data);
  return out;
}
