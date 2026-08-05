/**
 * Shared archive safety primitives: the ONE archive/path security policy used
 * by `add` (GitHub tarball installs, via `src/untar.ts`), the `.wnlp` bundle
 * reader/writer (`src/bundle/`), and the CLI glue around them.
 *
 * Two reading policies share one parser:
 *
 * - `compatible` — the historical `extractTarGz` behavior for GitHub
 *   tarballs: regular files are returned, directory and pax-global metadata is
 *   ignored after validation, and unsupported content entries are skipped.
 * - `strict` — the `.wnlp` bundle policy: only canonical regular-file entries
 *   and their deterministic POSIX PAX path headers are accepted. Unsafe types,
 *   malformed headers, duplicate paths, non-canonical order, and trailing
 *   bytes are rejected with stable named codes.
 *
 * Resource bounds are checked before the parser copies entry data. Compressed
 * input is bounded before inflation; gzip inflation is capped by zlib; every
 * tar header counts toward the entry bound; and regular-file sizes and paths
 * are checked before a returned entry is allocated.
 */

import { gunzipSync } from 'node:zlib';

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/**
 * Resource bounds enforced while reading an archive. Defaults are sized for
 * GitHub codeload output and are deliberately generous; tests inject tiny
 * values to exercise the limits without building giant fixtures.
 */
export interface TarLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  /** Counts every non-terminator tar header, including PAX headers. */
  maxFileCount: number;
  maxFileBytes: number;
  maxPathLength: number;
}

export const DEFAULT_TAR_LIMITS: TarLimits = {
  maxCompressedBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxFileCount: 50_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxPathLength: 1024,
};

/** Max length for an in-archive relative path we are willing to join and write. */
export const MAX_ARCHIVE_PATH_LENGTH = 1024;

/**
 * Returns `undefined` if `relPath` is safe to `join()` under a destination
 * directory, else a human-readable reason it must be rejected. This is
 * reject-don't-normalize: an unnormalized archive name is refused outright,
 * never canonicalized into a safe-looking path.
 */
export function archivePathViolation(relPath: string): string | undefined {
  if (relPath === '') return 'empty path';
  if (relPath.includes('\0')) return 'contains a NUL byte';
  if (isAbsoluteArchivePath(relPath)) return 'is an absolute path';
  // Split on both separators so `..\\` tricks cannot evade the check.
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((s) => s === '.' || s === '..')) {
    return "contains a '.' or '..' segment";
  }
  if (relPath.length > MAX_ARCHIVE_PATH_LENGTH) {
    return `exceeds ${MAX_ARCHIVE_PATH_LENGTH}-char path length limit`;
  }
  return undefined;
}

/** POSIX-absolute, UNC-absolute, or Windows-drive-absolute path test. */
function isAbsoluteArchivePath(relPath: string): boolean {
  return /^[\\/]/.test(relPath) || /^[A-Za-z]:/.test(relPath);
}

/**
 * Bounded gzip inflation. The compressed-size check happens before zlib sees
 * the input, and `maxOutputLength` caps expansion itself.
 */
export function inflateArchive(bytes: Uint8Array, limits: TarLimits): Buffer {
  if (bytes.length > limits.maxCompressedBytes) {
    throw new Error(
      `compressed archive size ${bytes.length} exceeds limit of ${limits.maxCompressedBytes} bytes`,
    );
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: limits.maxExpandedBytes });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`expanded archive size exceeds limit of ${limits.maxExpandedBytes} bytes`);
    }
    throw e;
  }
}

/** Stable violation codes for strict archive parsing (`.wnlp` reading). */
export type ArchiveViolationCode =
  | 'ARCHIVE_TOO_MANY_ENTRIES'
  | 'ARCHIVE_ENTRY_TOO_LARGE'
  | 'ARCHIVE_PATH_TOO_LONG'
  | 'ARCHIVE_PATH_VIOLATION'
  | 'ARCHIVE_DUPLICATE_PATH'
  | 'ARCHIVE_TRUNCATED'
  | 'ARCHIVE_BAD_CHECKSUM'
  | 'ARCHIVE_BAD_OCTAL'
  | 'ARCHIVE_BAD_PAX'
  | 'ARCHIVE_DANGLING_PAX'
  | 'ARCHIVE_TRAILING_BYTES'
  | 'UNSUPPORTED_ENTRY_TYPE'
  | 'NON_CANONICAL_HEADER';

/** A strict-policy archive violation with machine-readable detail. */
export class ArchiveViolation extends Error {
  readonly code: ArchiveViolationCode;
  readonly entryPath?: string;
  readonly typeflag?: string;

  constructor(
    code: ArchiveViolationCode,
    message: string,
    detail?: { entryPath?: string; typeflag?: string },
  ) {
    super(message);
    this.name = 'ArchiveViolation';
    this.code = code;
    if (detail?.entryPath !== undefined) this.entryPath = detail.entryPath;
    if (detail?.typeflag !== undefined) this.typeflag = detail.typeflag;
  }
}

/** Parse a NUL/space-padded octal field (historical compatible behavior). */
function parseOctal(bytes: Uint8Array): number {
  let s = '';
  for (const b of bytes) {
    if (b === 0 || b === 32) continue;
    s += String.fromCharCode(b);
  }
  return s.length ? parseInt(s, 8) : 0;
}

function isOctalField(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b === 0 || b === 32) continue;
    if (b < 0x30 || b > 0x37) return false;
  }
  return true;
}

function canonicalOctalField(value: number, width: number): Buffer {
  const digits = value.toString(8);
  if (digits.length > width - 1) return Buffer.alloc(0);
  return Buffer.from(`${digits.padStart(width - 1, '0')}\0`, 'ascii');
}

function fieldEquals(actual: Uint8Array, expected: Uint8Array): boolean {
  return actual.length === expected.length && actual.every((b, i) => b === expected[i]);
}

/**
 * The deterministic USTAR name placeholder paired with a canonical PAX path.
 * The writer uses the first 100 UTF-8 bytes when that slice ends on a
 * character boundary; otherwise it uses the fixed ASCII `PaxData` marker.
 */
export function canonicalPaxNamePlaceholder(path: string): string {
  const rawPath = Buffer.from(path, 'utf8');
  const prefixBytes = rawPath.subarray(0, 100);
  const prefix = Buffer.from(prefixBytes).toString('utf8');
  const prefixField = Buffer.from(prefix, 'utf8');
  return prefixField.length === prefixBytes.length ? prefix : 'PaxData';
}

function readCStringCompatible(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const slice = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  return Buffer.from(slice).toString('utf8');
}

function readCStringStrict(bytes: Uint8Array, label: string): string {
  const nul = bytes.indexOf(0);
  const slice = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  // Canonical USTAR fields are NUL padded; bytes after the first NUL are not
  // meaningful and must not contain hidden alternate names.
  if (nul >= 0 && bytes.subarray(nul + 1).some((b) => b !== 0)) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', `${label} field contains non-zero bytes after its NUL terminator`);
  }
  try {
    return UTF8_FATAL.decode(slice);
  } catch {
    throw new ArchiveViolation('ARCHIVE_PATH_VIOLATION', `${label} field is not valid UTF-8`);
  }
}

function readAsciiStrict(bytes: Uint8Array, label: string): string {
  for (const b of bytes) {
    if (b > 0x7f) {
      throw new ArchiveViolation('NON_CANONICAL_HEADER', `${label} field contains non-ASCII bytes`);
    }
  }
  return Buffer.from(bytes).toString('ascii');
}

/**
 * Parse PAX records using byte lengths. PAX record lengths count bytes, not
 * JavaScript UTF-16 code units, so this implementation remains correct for a
 * UTF-8 path containing multi-byte characters.
 */
function parsePaxRecordsStrict(data: Uint8Array): Array<{ key: string; value: string }> {
  if (data.length === 0) {
    throw new ArchiveViolation('ARCHIVE_BAD_PAX', 'pax extended header has an empty data block');
  }
  const records: Array<{ key: string; value: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: missing length separator`);
    }
    const lenBytes = data.subarray(offset, space);
    const lenText = readAsciiStrict(lenBytes, 'pax length');
    if (!/^[0-9]+$/.test(lenText)) {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: length '${lenText}' is not decimal`);
    }
    // Canonical writer output has no leading zeroes and a self-consistent
    // decimal length. Refusing a non-canonical representation keeps the bytes
    // unambiguous even when stock tar accepts the record.
    if (String(Number(lenText)) !== lenText || !Number.isSafeInteger(Number(lenText))) {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: invalid length '${lenText}'`);
    }
    const length = Number(lenText);
    const remaining = data.length - offset;
    if (length < lenText.length + 4 || length > remaining) {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: length ${length} is out of range`);
    }
    const record = data.subarray(offset, offset + length);
    if (record[length - 1] !== 0x0a) {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: missing trailing newline`);
    }
    const body = record.subarray(space - offset + 1, length - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: missing key or '='`);
    }
    const key = readAsciiStrict(body.subarray(0, equals), 'pax key');
    if (key.length === 0) {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: empty key`);
    }
    let value: string;
    try {
      value = UTF8_FATAL.decode(body.subarray(equals + 1));
    } catch {
      throw new ArchiveViolation('ARCHIVE_BAD_PAX', `malformed pax record at byte ${offset}: value is not valid UTF-8`);
    }
    records.push({ key, value });
    offset += length;
  }
  return records;
}

/** Compatible PAX parsing: malformed records are ignored like the old reader. */
function parsePaxRecordsLenient(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const lenText = Buffer.from(data.subarray(offset, space)).toString('ascii');
    const length = Number.parseInt(lenText, 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(offset, offset + length);
    if (record[length - 1] !== 0x0a) break;
    const body = record.subarray(space - offset + 1, length - 1);
    const equals = body.indexOf(0x3d);
    if (equals > 0) {
      const key = Buffer.from(body.subarray(0, equals)).toString('utf8');
      const value = Buffer.from(body.subarray(equals + 1)).toString('utf8');
      out.set(key, value);
    }
    offset += length;
  }
  return out;
}

function assertCanonicalHeaderFields(
  header: Uint8Array,
  storedChecksum: number,
  paxPath?: string,
): void {
  const checksumField = header.subarray(148, 156);
  if (checksumField[6] !== 0 || checksumField[7] !== 0x20 || !/^[0-7]{6}$/.test(Buffer.from(checksumField.subarray(0, 6)).toString('ascii'))) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', 'tar checksum field is not canonical');
  }
  if (!fieldEquals(header.subarray(257, 263), Buffer.from('ustar\0', 'ascii'))) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', "tar magic must be 'ustar\\0'");
  }
  if (!fieldEquals(header.subarray(263, 265), Buffer.from('00', 'ascii'))) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', "tar version must be '00'");
  }
  // Canonical regular and PAX headers do not carry links, devices, or a
  // prefix field. A long path is represented by a PAX path record instead of
  // the USTAR prefix field in the production writer.
  if (header.subarray(157, 257).some((b) => b !== 0)) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', 'tar linkname field must be empty');
  }
  if (paxPath !== undefined) {
    const expected = Buffer.alloc(100);
    Buffer.from(canonicalPaxNamePlaceholder(paxPath), 'utf8').copy(expected);
    if (!fieldEquals(header.subarray(0, 100), expected)) {
      throw new ArchiveViolation(
	'NON_CANONICAL_HEADER',
	`tar name field is not the canonical PAX placeholder for '${paxPath}'`,
      );
    }
  }
  if (header.subarray(329, 500).some((b) => b !== 0)) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', 'tar device or prefix fields must be empty');
  }
  if (header.subarray(500, 512).some((b) => b !== 0)) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', 'tar reserved header bytes must be zero');
  }
  const canonical = canonicalOctalField(storedChecksum, 8);
  if (!fieldEquals(checksumField.subarray(0, 6), canonical.subarray(1, 7))) {
    throw new ArchiveViolation('NON_CANONICAL_HEADER', 'tar checksum field is not zero-padded canonical octal');
  }
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
  return sum;
}

function effectiveName(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

/** One parsed regular-file entry (the only entry kind returned to callers). */
export interface TarEntry {
  path: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  uname: string;
  gname: string;
  mtime: number;
  typeflag: '0';
  hadPaxPath: boolean;
  data: Uint8Array;
}

export interface ParseTarOptions {
  policy: 'compatible' | 'strict';
}

/**
 * Parse an UNCOMPRESSED tar stream. Compatible mode retains the historical
 * extractor contract; strict mode accepts only canonical package archives.
 */
export function parseTar(tar: Uint8Array, limits: TarLimits, opts: ParseTarOptions): TarEntry[] {
  const strict = opts.policy === 'strict';
  const out: TarEntry[] = [];
  let offset = 0;
  let headerCount = 0;
  let pendingPaxPath: string | undefined;
  let lastPath: string | undefined;

  const failCompat = (message: string): never => {
    throw new Error(message);
  };
  const failStrict = (
    code: ArchiveViolationCode,
    message: string,
    detail?: { entryPath?: string; typeflag?: string },
  ): never => {
    throw new ArchiveViolation(code, message, detail);
  };

  while (true) {
    if (offset + BLOCK > tar.length) {
      if (strict) {
	failStrict('ARCHIVE_TRUNCATED', offset < tar.length
	  ? `archive ends mid-block at byte ${offset} (${tar.length - offset} trailing bytes)`
	  : 'archive is missing the two-zero-block terminator');
      }
      break;
    }

    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) {
      if (!strict) break;
      if (pendingPaxPath !== undefined) {
	failStrict('ARCHIVE_DANGLING_PAX', `pax extended header for path '${pendingPaxPath}' has no following entry`);
      }
      const remaining = tar.length - offset;
      if (remaining < BLOCK * 2) {
	failStrict('ARCHIVE_TRUNCATED', 'archive terminator must be two consecutive zero blocks');
      }
      const second = tar.subarray(offset + BLOCK, offset + BLOCK * 2);
      if (!second.every((b) => b === 0)) {
	failStrict('ARCHIVE_TRUNCATED', 'archive terminator must be two consecutive zero blocks');
      }
      if (remaining !== BLOCK * 2) {
	failStrict('ARCHIVE_TRAILING_BYTES', `bytes follow the exact two-block archive terminator at byte ${offset + BLOCK * 2}`);
      }
      return out;
    }

    headerCount += 1;
    if (headerCount > limits.maxFileCount) {
      const message = `archive file count exceeds limit of ${limits.maxFileCount}`;
      if (strict) failStrict('ARCHIVE_TOO_MANY_ENTRIES', message);
      failCompat(message);
    }

    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (strict) {
      if (!isOctalField(header.subarray(148, 156))) {
	failStrict('ARCHIVE_BAD_CHECKSUM', 'tar header checksum field is not valid octal');
      }
      const stored = parseOctal(header.subarray(148, 156));
      const computed = checksum(header);
      if (stored !== computed) {
	failStrict('ARCHIVE_BAD_CHECKSUM', `tar header checksum mismatch (stored ${stored}, computed ${computed})`);
      }
      assertCanonicalHeaderFields(
	header,
	stored,
	(typeflag === '0' || typeflag === '\\0') ? pendingPaxPath : undefined,
      );
      for (const [label, start, end] of [
	['mode', 100, 108],
	['uid', 108, 116],
	['gid', 116, 124],
	['size', 124, 136],
	['mtime', 136, 148],
      ] as const) {
	const field = header.subarray(start, end);
	if (!isOctalField(field)) {
	  failStrict('ARCHIVE_BAD_OCTAL', `tar header '${label}' field is not valid octal`);
	}
	const value = parseOctal(field);
	if (!fieldEquals(field, canonicalOctalField(value, end - start))) {
	  failStrict('NON_CANONICAL_HEADER', `tar header '${label}' field is not canonical`);
	}
      }
    }

    const nameField = strict
      ? readCStringStrict(header.subarray(0, 100), 'tar name')
      : readCStringCompatible(header.subarray(0, 100));
    const prefixField = strict
      ? readCStringStrict(header.subarray(345, 500), 'tar prefix')
      : readCStringCompatible(header.subarray(345, 500));
    const unameField = strict
      ? readCStringStrict(header.subarray(265, 297), 'tar uname')
      : readCStringCompatible(header.subarray(265, 297));
    const gnameField = strict
      ? readCStringStrict(header.subarray(297, 329), 'tar gname')
      : readCStringCompatible(header.subarray(297, 329));
    const sizeField = parseOctal(header.subarray(124, 136));
    const modeField = parseOctal(header.subarray(100, 108));
    const uidField = parseOctal(header.subarray(108, 116));
    const gidField = parseOctal(header.subarray(116, 124));
    const mtimeField = parseOctal(header.subarray(136, 148));

    if (!Number.isInteger(sizeField) || sizeField < 0) {
      const message = `corrupt tar header: invalid size field (got ${sizeField})`;
      if (strict) failStrict('ARCHIVE_BAD_OCTAL', message, { entryPath: nameField });
      failCompat(message);
    }

    offset += BLOCK;
    const dataStart = offset;
    const dataEnd = dataStart + sizeField;
    const paddedEnd = dataEnd + ((BLOCK - (sizeField % BLOCK)) % BLOCK);
    if (dataEnd > tar.length || paddedEnd > tar.length) {
      const message = `corrupt tar archive: entry data (${sizeField} bytes) extends past end of archive`;
      if (strict) failStrict('ARCHIVE_TRUNCATED', message, { entryPath: nameField });
      failCompat(message);
    }
    const data = tar.subarray(dataStart, dataEnd);
    offset = paddedEnd;

    if (typeflag === 'x') {
      if (strict) {
	if (nameField !== 'PaxHeader') {
	  failStrict('NON_CANONICAL_HEADER', `pax extended header name must be 'PaxHeader' (got '${nameField}')`);
	}
	if (modeField !== 0o644 || uidField !== 0 || gidField !== 0 || mtimeField !== 0 || unameField !== '' || gnameField !== '') {
	  failStrict('NON_CANONICAL_HEADER', 'pax extended header must use mode 0644, uid/gid 0, mtime 0, empty uname/gname');
	}
	if (pendingPaxPath !== undefined) {
	  failStrict('ARCHIVE_DANGLING_PAX', `pax extended header for path '${pendingPaxPath}' has no following entry`);
	}
	const records = parsePaxRecordsStrict(data);
	if (records.length !== 1 || records[0]!.key !== 'path') {
	  failStrict('ARCHIVE_BAD_PAX', `bundle pax extended header must carry exactly one 'path' record (got ${records.map((r) => r.key).join(', ') || 'none'})`);
	}
	const p = records[0]!.value;
	if (p === '') failStrict('ARCHIVE_BAD_PAX', "pax 'path' record is empty");
	pendingPaxPath = p;
	continue;
      }
      const records = parsePaxRecordsLenient(data);
      const p = records.get('path');
      if (p !== undefined) pendingPaxPath = p;
      continue;
    }

    const rawName = effectiveName(prefixField, nameField);
    const candidateName = pendingPaxPath ?? rawName;
    if (candidateName) {
      if (candidateName.length > limits.maxPathLength) {
	const message = `archive entry path length ${candidateName.length} exceeds limit of ${limits.maxPathLength} chars`;
	if (strict) failStrict('ARCHIVE_PATH_TOO_LONG', message, { entryPath: candidateName });
	failCompat(message);
      }
      if (strict) {
	const violation = archivePathViolation(candidateName);
	if (violation) {
	  const message = `unsafe archive path '${candidateName}': ${violation}`;
	  failStrict('ARCHIVE_PATH_VIOLATION', message, { entryPath: candidateName });
	}
      }
    }
    if (typeflag === '5') {
      if (strict) {
	failStrict('UNSUPPORTED_ENTRY_TYPE', 'bundle entries must be regular files; got a directory entry', {
	  entryPath: pendingPaxPath ?? rawName,
	  typeflag: '5',
	});
      }
      continue;
    }
    if (typeflag === 'g') {
      if (strict) {
	failStrict('UNSUPPORTED_ENTRY_TYPE', 'bundle entries must be regular files; got a pax global extended header', { typeflag: 'g' });
      }
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0') {
      if (strict) {
	failStrict('UNSUPPORTED_ENTRY_TYPE', `bundle entries must be regular files; got typeflag '${typeflag}'`, {
	  entryPath: pendingPaxPath ?? rawName,
	  typeflag,
	});
      }
      pendingPaxPath = undefined;
      continue;
    }

    if (strict && typeflag !== '0') {
      failStrict('NON_CANONICAL_HEADER', 'canonical regular files must use typeflag 0', {
	entryPath: pendingPaxPath ?? rawName,
	typeflag,
      });
    }

    if (sizeField > limits.maxFileBytes) {
      const message = `archive entry exceeds per-file size limit of ${limits.maxFileBytes} bytes (${sizeField} bytes)`;
      if (strict) failStrict('ARCHIVE_ENTRY_TOO_LARGE', message, { entryPath: pendingPaxPath ?? rawName });
      failCompat(message);
    }

    const name = pendingPaxPath ?? rawName;
    const hadPaxPath = pendingPaxPath !== undefined;
    pendingPaxPath = undefined;

    if (strict) {
      if (name.length > limits.maxPathLength) {
	failStrict('ARCHIVE_PATH_TOO_LONG', `archive entry path length ${name.length} exceeds limit of ${limits.maxPathLength} chars`, { entryPath: name.slice(0, 128) });
      }
      const violation = archivePathViolation(name);
      if (violation) {
	failStrict('ARCHIVE_PATH_VIOLATION', `unsafe archive path '${name}': ${violation}`, { entryPath: name });
      }
      if (!name || name.endsWith('/')) {
	failStrict('ARCHIVE_PATH_VIOLATION', `unsafe archive path '${name}': directory-like names are not regular files`, { entryPath: name });
      }
      if (modeField !== 0o644 && modeField !== 0o755) {
	failStrict('NON_CANONICAL_HEADER', `bundle entry '${name}' must use mode 0644 or 0755 (got 0${modeField.toString(8)})`, { entryPath: name });
      }
      if (uidField !== 0 || gidField !== 0 || mtimeField !== 0 || unameField !== '' || gnameField !== '') {
	failStrict('NON_CANONICAL_HEADER', `bundle entry '${name}' must use uid/gid 0, mtime 0, empty uname/gname`, { entryPath: name });
      }
      if (lastPath !== undefined) {
	const order = Buffer.compare(Buffer.from(lastPath, 'utf8'), Buffer.from(name, 'utf8'));
	if (order === 0) {
	  failStrict('ARCHIVE_DUPLICATE_PATH', `duplicate archive path '${name}'`, { entryPath: name });
	}
	if (order > 0) {
	  failStrict('NON_CANONICAL_HEADER', `archive entries are not sorted by UTF-8 path: '${name}' follows '${lastPath}'`, { entryPath: name });
	}
      }
      lastPath = name;
      out.push({
	path: name,
	size: sizeField,
	mode: modeField,
	uid: uidField,
	gid: gidField,
	uname: unameField,
	gname: gnameField,
	mtime: mtimeField,
	typeflag: '0',
	hadPaxPath,
	data: new Uint8Array(data),
      });
      continue;
    }

    if (name) {
      if (name.length > limits.maxPathLength) {
	failCompat(`archive entry path length ${name.length} exceeds limit of ${limits.maxPathLength} chars`);
      }
      out.push({
	path: name,
	size: sizeField,
	mode: modeField,
	uid: uidField,
	gid: gidField,
	uname: unameField,
	gname: gnameField,
	mtime: mtimeField,
	typeflag: '0',
	hadPaxPath,
	data: new Uint8Array(data),
      });
    }
  }

  if (strict) {
    if (pendingPaxPath !== undefined) {
      failStrict('ARCHIVE_DANGLING_PAX', `pax extended header for path '${pendingPaxPath}' has no following entry`);
    }
    failStrict('ARCHIVE_TRUNCATED', 'archive is missing the two-zero-block terminator');
  }
  return out;
}
