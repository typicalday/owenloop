/** Stable bundle failure codes shared by readers and the portable call parser. */
export type BundleErrorCode =
  | 'BUNDLE_IO'
  | 'BUNDLE_NOT_GZIP'
  | 'BUNDLE_LIMIT'
  | 'ARCHIVE_TOO_MANY_ENTRIES'
  | 'ARCHIVE_ENTRY_TOO_LARGE'
  | 'ARCHIVE_PATH_TOO_LONG'
  | 'ARCHIVE_PATH_VIOLATION'
  | 'ARCHIVE_DUPLICATE_PATH'
  | 'ARCHIVE_PATH_PREFIX_COLLISION'
  | 'ARCHIVE_TRUNCATED'
  | 'ARCHIVE_BAD_CHECKSUM'
  | 'ARCHIVE_BAD_OCTAL'
  | 'ARCHIVE_BAD_PAX'
  | 'ARCHIVE_DANGLING_PAX'
  | 'ARCHIVE_TRAILING_BYTES'
  | 'UNSUPPORTED_ENTRY_TYPE'
  | 'NON_CANONICAL_HEADER'
  | 'MANIFEST_ERROR'
  | 'RUNTIME_INCOMPATIBLE'
  | 'UNSUPPORTED_FORMAT_VERSION'
  | 'MANIFEST_MISSING'
  | 'WORKFLOW_MISSING'
  | 'WORKFLOW_INVALID'
  | 'INTEGRITY_MISMATCH'
  | 'SOURCE_NOT_A_DIRECTORY'
  | 'SOURCE_NOT_A_FILE'
  | 'SOURCE_SYMLINK'
  | 'SOURCE_INVALID_PATH'
  | 'SOURCE_FILE_CHANGED'
  | 'OUTPUT_INSIDE_SOURCE'
  | 'OUTPUT_INVALID'
  | 'DESTINATION_EXISTS'
  | 'DESTINATION_PARENT_INVALID'
  | 'WORKFLOW_ERROR';

/** A typed bundle failure. */
export class BundleError extends Error {
  readonly code: BundleErrorCode;
  readonly entryPath?: string;
  constructor(code: BundleErrorCode, message: string, entryPath?: string) {
    super(message);
    this.code = code;
    if (entryPath !== undefined) this.entryPath = entryPath;
  }
}
