import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cachedPackageVersion: string | undefined;

/**
 * Read the package version from either the source or built package layout.
 *
 * The source file lives under `src/`, while the emitted file lives under
 * `dist/src/`. Keep the read runtime-based rather than importing JSON so the
 * build's `rootDir: "."` output layout stays unchanged. A missing or malformed
 * package manifest must not take down the stdio MCP server, so the helper
 * memoizes and returns the existing unknown-version sentinel instead.
 */
export function packageVersion(): string {
  if (cachedPackageVersion !== undefined) return cachedPackageVersion;

  try {
    const candidates = [
      new URL('../package.json', import.meta.url),
      new URL('../../package.json', import.meta.url),
    ];
    for (const candidate of candidates) {
      try {
        const path = fileURLToPath(candidate);
        if (!existsSync(path)) continue;
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.length > 0) {
          cachedPackageVersion = parsed.version;
          return cachedPackageVersion;
        }
      } catch {
        // Try the other layout, then fall back without throwing.
      }
    }
  } catch {
    // Keep the stdio server alive if URL/path resolution itself fails.
  }

  cachedPackageVersion = '0.0.0';
  return cachedPackageVersion;
}
