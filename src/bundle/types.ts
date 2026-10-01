/**
 * Public types for the deterministic `.wnlp` bundle format (WP-A1).
 *
 * A `.wnlp` file is gzip-compressed canonical POSIX/PAX tar; its identity
 * ("def digest") is the lowercase SHA-256 of the UNCOMPRESSED canonical tar
 * bytes. See `docs/bundles.md` for the full format contract.
 */

import type { TarLimits } from '../archive.ts';
export { BundleError } from './error.ts';
export type { BundleErrorCode } from './error.ts';

/** Compatibility requirements that a format-v2 bundle places on its reader/runtime. */
export interface BundleRuntimeRequirements {
  /** Minimum canonical Owenloop SemVer accepted by the bundle. */
  minVersion?: string;
  /** Versioned runtime feature identifiers that the reader must implement. */
  features?: string[];
}

/**
 * The v2 package-only manifest (`bundle.yaml`). All collections are
 * duplicate-free; serialization order is deterministic (see
 * `docs/bundles.md` §Manifest).
 */
export interface BundleManifest {
  /** Always `2` in this format version. */
  formatVersion: 2;
  package: {
    /** Portable package namespace. */
    name: string;
    /** Non-empty version string. */
    version: string;
  };
  /** Optional reader/runtime compatibility requirements. */
  runtime?: BundleRuntimeRequirements;
  /** Workflow name to archive-relative definition path. */
  workflows: Record<string, string>;
  /** Optional default workflow name. */
  default?: string;
  /** Platform selectors this package targets (may be empty). */
  platforms: string[];
  integrity: {
    /** Always `'sha256'`. */
    algorithm: 'sha256';
    /**
     * Lowercase 64-hex SHA-256 for every regular archive file EXCEPT
     * `bundle.yaml` (self-hash is recursive; the def digest still covers the
     * manifest through the canonical tar).
     */
    files: Record<string, string>;
  };
  /**
   * Requested capability classes and values — REQUESTS only; this format
   * neither grants nor enforces them.
   */
  capabilities: Record<string, string[]>;
  /**
   * Digest-pinned cross-bundle references: base `namespace/name@version`
   * coordinate → lowercase 64-hex def digest of the called bundle, including
   * `#workflow` calls into that bundle.
   */
  lock: Record<string, string>;
}

/** One regular-file entry of a bundle, as returned by pack/inspect. */
export interface BundleEntryInfo {
  path: string;
  size: number;
  /** True when the source carried any execute bit (canonical mode 0755). */
  executable: boolean;
  /** Lowercase 64-hex SHA-256 of the entry's bytes. */
  sha256: string;
}

/** Result of {@link packBundle}. */
export interface PackResult {
  /** The complete `.wnlp` bytes (gzip of the canonical tar). */
  bytes: Uint8Array;
  /** Lowercase 64-hex SHA-256 over the uncompressed canonical tar bytes. */
  digest: string;
  /** The canonical manifest actually archived (source manifest regenerated). */
  manifest: BundleManifest;
  /** Archive entries in canonical (sorted) order, including `bundle.yaml`. */
  entries: BundleEntryInfo[];
}

/** Result of {@link inspectBundle}. */
export interface InspectResult {
  digest: string;
  manifest: BundleManifest;
  entries: BundleEntryInfo[];
}

/** Resource bounds for reading/writing bundles (the shared archive limits). */
export type BundleLimits = TarLimits;

/** Options for {@link packBundle}. */
export interface PackOptions {
  limits?: Partial<BundleLimits>;
}

/** Options for {@link inspectBundle} / {@link digestBundle} / {@link unpackBundle}. */
export interface InspectOptions {
  limits?: Partial<BundleLimits>;
}
