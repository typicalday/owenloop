/**
 * Deterministic `.wnlp` archive writer (WP-A1).
 *
 * Canonical tar rules (see `docs/bundles.md`): regular-file entries only,
 * `/`-separated paths sorted by ascending UTF-8 bytes, uid/gid 0, empty
 * uname/gname, mtime 0, mode 0755 when any source execute bit is set and
 * 0644 otherwise, USTAR name when it fits (UTF-8 bytes ≤ 100), else ONE
 * deterministic POSIX PAX `path` extended record in a `PaxHeader` block
 * (mode 0644, uid/gid 0, mtime 0), exactly two trailing zero blocks. The
 * gzip wrapper uses fixed options, zero mtime bytes, and OS byte 0 (patched
 * explicitly — Node reports OS 19 on Darwin). The raw header helpers are
 * deliberately module-private: the public bundle surface exposes only the
 * high-level pack/inspect/digest/unpack API.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { archivePathViolation, canonicalPaxNamePlaceholder, DEFAULT_TAR_LIMITS } from '../archive.ts';
import type { TarLimits } from '../archive.ts';
import { BundleError } from './types.ts';

const BLOCK = 512;

/** One file to archive: archive path (already validated + sorted), bytes, canonical mode. */
export interface CanonicalFile {
  path: string;
  bytes: Uint8Array;
  /** 0o644 or 0o755. */
  mode: number;
}

/** Fixed gzip level for canonical output. */
export const BUNDLE_GZIP_LEVEL = 9;

/** An octal header field: `width - 1` zero-padded octal digits plus a trailing NUL. */
function octalField(value: number, width: number): Buffer {
  const digits = value.toString(8);
  if (digits.length > width - 1) {
    throw new BundleError('MANIFEST_ERROR', `tar field overflow: ${value} does not fit ${width} bytes`);
  }
  return Buffer.from(digits.padStart(width - 1, '0') + '\0', 'ascii');
}

function padBlock(data: Uint8Array): Buffer {
  const padded = Math.ceil(data.length / BLOCK) * BLOCK;
  const out = Buffer.alloc(padded);
  Buffer.from(data).copy(out);
  return out;
}

/**
 * One 512-byte canonical USTAR header: name (ASCII, ≤100 bytes), mode,
 * uid/gid 0, size, mtime 0, checksum, typeflag, magic `ustar\0`, version
 * `00`, empty uname/gname and blank prefix/dev fields (zero-filled).
 */
function buildHeader(name: string, size: number, typeflag: string, mode: number): Buffer {
  const buf = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) {
    throw new BundleError('ARCHIVE_PATH_TOO_LONG', `tar name field cannot hold '${name}'`);
  }
  nameBytes.copy(buf, 0);
  octalField(mode, 8).copy(buf, 100);
  octalField(0, 8).copy(buf, 108); // uid
  octalField(0, 8).copy(buf, 116); // gid
  octalField(size, 12).copy(buf, 124);
  octalField(0, 12).copy(buf, 136); // mtime
  buf.fill(0x20, 148, 156); // checksum field: spaces while computing
  buf[156] = typeflag.charCodeAt(0);
  buf.write('ustar', 257, 'ascii'); // magic "ustar\0" (rest zero-filled)
  buf[262] = 0;
  buf.write('00', 263, 2, 'ascii'); // version
  // uname/gname (265..329), linkname (329..400), prefix (345..500), devmajor/
  // devminor stay zero — canonical.

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] as number;
  const chksum = Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii');
  chksum.copy(buf, 148);
  return buf;
}

/** The one canonical pax extended-header data block: a single self-inclusive `path` record. */
function buildPaxPathRecord(path: string): Buffer {
  const valueBytes = Buffer.byteLength(path, 'utf8');
  // Record: "<len> path=<value>\n"; len counts every byte of the record.
  const suffixLen = 1 + 'path='.length + valueBytes + 1;
  let digits = String(suffixLen).length;
  let total = digits + suffixLen;
  while (String(total).length !== digits) {
    digits = String(total).length;
    total = digits + suffixLen;
  }
  return Buffer.from(`${total} path=${path}\n`, 'utf8');
}

/**
 * Build the canonical uncompressed tar bytes for a set of files. The input
 * MUST already be sorted by ascending UTF-8 byte order of `path` and carry
 * canonical modes; the bundle packer guarantees both.
 */
export function buildCanonicalTar(files: CanonicalFile[], limits: TarLimits = DEFAULT_TAR_LIMITS): Buffer {
  let headerCount = 0;
  const chunks: Buffer[] = [];
  for (const f of files) {
    const violation = archivePathViolation(f.path);
    if (violation) {
      throw new BundleError('SOURCE_INVALID_PATH', `unsafe path '${f.path}': ${violation}`, f.path);
    }
    if (f.path.length > limits.maxPathLength) {
      throw new BundleError('ARCHIVE_PATH_TOO_LONG', `archive entry path length ${f.path.length} exceeds limit of ${limits.maxPathLength} chars`, f.path);
    }
    if (f.bytes.length > limits.maxFileBytes) {
      throw new BundleError('ARCHIVE_ENTRY_TOO_LARGE', `archive entry '${f.path}' is ${f.bytes.length} bytes; limit is ${limits.maxFileBytes}`, f.path);
    }
    if (f.mode !== 0o644 && f.mode !== 0o755) {
      throw new BundleError('NON_CANONICAL_HEADER', `archive entry '${f.path}' must use mode 0644 or 0755`, f.path);
    }
    const nameBytes = Buffer.byteLength(f.path, 'utf8');
    if (nameBytes > 100) {
      // USTAR name cannot hold it — emit a deterministic PAX path header.
      headerCount += 2;
      const paxData = buildPaxPathRecord(f.path);
      chunks.push(buildHeader('PaxHeader', paxData.length, 'x', 0o644));
      chunks.push(padBlock(paxData));
      // The 100-byte name field is only a deterministic placeholder; the PAX
      // record carries the effective UTF-8 path. Use the shared placeholder
      // rule so the strict reader requires exactly what the writer emits.
      chunks.push(buildHeader(canonicalPaxNamePlaceholder(f.path), f.bytes.length, '0', f.mode));
    } else {
      headerCount += 1;
      chunks.push(buildHeader(f.path, f.bytes.length, '0', f.mode));
    }
    if (headerCount > limits.maxFileCount) {
      throw new BundleError('ARCHIVE_TOO_MANY_ENTRIES', `archive entry count exceeds limit of ${limits.maxFileCount}`);
    }
    chunks.push(padBlock(f.bytes));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks end the archive
  const tar = Buffer.concat(chunks);
  if (tar.length > limits.maxExpandedBytes) {
    throw new BundleError('BUNDLE_LIMIT', `expanded archive size ${tar.length} exceeds limit of ${limits.maxExpandedBytes} bytes`);
  }
  return tar;
}

/**
 * Gzip `tar` with fixed options and a normalized header: no FEXTRA/FNAME/
 * FCOMMENT, mtime bytes zeroed, OS byte forced to 0. Node's zlib reports
 * OS 19 on Darwin and embeds the clock in mtime by default — patch both so
 * the output is byte-identical across platforms and times.
 */
export function gzipDeterministic(tar: Uint8Array): Buffer {
  const gz = gzipSync(Buffer.from(tar), { level: BUNDLE_GZIP_LEVEL });
  gz[4] = 0; // mtime byte 0
  gz[5] = 0; // mtime byte 1
  gz[6] = 0; // mtime byte 2
  gz[7] = 0; // mtime byte 3
  gz[9] = 0; // OS byte (Darwin reports 19; the format fixes 0)
  return gz;
}

/** A file collected from a bundle source tree. */
export interface SourceFile {
  /** Archive-relative path with `/` separators (validated, sorted by callers). */
  rel: string;
  abs: string;
  /** True when any execute bit was set on the source file. */
  executable: boolean;
}

const byNameBytes = (a: { name: string }, b: { name: string }): number =>
  Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8'));

/**
 * Recursively walk `sourceRoot` WITHOUT following symlinks and collect every
 * regular file. Refuses: a missing/non-directory/symlinked root; any symlink,
 * or any non-regular/non-directory node, found below it; any path that
 * violates the shared archive path policy. Returns files sorted by ascending
 * UTF-8 byte order of their archive path.
 */
export function collectSourceFiles(sourceRoot: string, limits: TarLimits = DEFAULT_TAR_LIMITS): SourceFile[] {
  const root = resolve(sourceRoot);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new BundleError('SOURCE_NOT_A_DIRECTORY', `source directory '${sourceRoot}' does not exist`);
  }
  if (rootStat.isSymbolicLink()) {
    throw new BundleError('SOURCE_SYMLINK', `source root '${sourceRoot}' is a symbolic link`);
  }
  if (!rootStat.isDirectory()) {
    throw new BundleError('SOURCE_NOT_A_DIRECTORY', `source '${sourceRoot}' is not a directory`);
  }

  const out: SourceFile[] = [];
  let archiveEntryCount = 0;
  const walk = (dirAbs: string, relPrefix: string): void => {
    let dirents;
    try {
      dirents = readdirSync(dirAbs, { withFileTypes: true });
    } catch (e) {
      throw new BundleError('SOURCE_NOT_A_DIRECTORY', `cannot read '${dirAbs}': ${(e as Error).message}`);
    }
    dirents.sort(byNameBytes);
    for (const d of dirents) {
      const abs = join(dirAbs, d.name);
      const rel = relPrefix === '' ? d.name : `${relPrefix}/${d.name}`;
      const violation = archivePathViolation(rel);
      if (violation) {
	throw new BundleError('SOURCE_INVALID_PATH', `unsafe path '${rel}': ${violation}`, rel);
      }
      if (rel.length > limits.maxPathLength) {
	throw new BundleError('ARCHIVE_PATH_TOO_LONG', `archive entry path length ${rel.length} exceeds limit of ${limits.maxPathLength} chars`, rel);
      }
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
	throw new BundleError('SOURCE_SYMLINK', `symbolic link '${rel}' cannot be packed`, rel);
      }
      if (st.isDirectory()) {
	walk(abs, rel);
	continue;
      }
      if (!st.isFile()) {
	throw new BundleError('SOURCE_NOT_A_FILE', `'${rel}' is not a regular file or directory`, rel);
      }
      if (st.size > limits.maxFileBytes) {
	throw new BundleError('ARCHIVE_ENTRY_TOO_LARGE', `archive entry '${rel}' is ${st.size} bytes; limit is ${limits.maxFileBytes}`, rel);
      }
      out.push({ rel, abs, executable: (st.mode & 0o111) !== 0 });
      archiveEntryCount += Buffer.byteLength(rel, 'utf8') > 100 ? 2 : 1;
      if (archiveEntryCount > limits.maxFileCount) {
	throw new BundleError('ARCHIVE_TOO_MANY_ENTRIES', `archive entry count exceeds limit of ${limits.maxFileCount}`);
      }
    }
  };
  walk(root, '');
  out.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')));
  return out;
}
