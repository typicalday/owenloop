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
 * not a general-purpose tar library.
 */

import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

/** Parse a NUL/space-padded octal field (tar's numeric encoding) into a number. */
function parseOctal(bytes: Uint8Array): number {
  let s = '';
  for (const b of bytes) {
    if (b === 0 || b === 32 /* space */) continue;
    s += String.fromCharCode(b);
  }
  return s.length ? parseInt(s, 8) : 0;
}

function readCString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const slice = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  return Buffer.from(slice).toString('utf8');
}

/** Parse a pax extended-header data block's `key=value` records, e.g. `path=...`. */
function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const text = Buffer.from(data).toString('utf8');
  const out = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    // Each record is "<len> <key>=<value>\n", <len> counts the whole record
    // (including the length prefix itself and the trailing newline).
    const spaceIdx = text.indexOf(' ', i);
    if (spaceIdx < 0) break;
    const len = parseInt(text.slice(i, spaceIdx), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(i, i + len);
    const eq = record.indexOf('=', spaceIdx - i + 1);
    if (eq >= 0) {
      const key = record.slice(spaceIdx - i + 1, eq);
      // record.slice(eq + 1) still has the trailing '\n' the pax format
      // mandates — strip it to get the bare value.
      const value = record.slice(eq + 1).replace(/\n$/, '');
      out.set(key, value);
    }
    i += len;
  }
  return out;
}

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
export function extractTarGz(bytes: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(bytes);
  const out = new Map<string, Uint8Array>();

  let offset = 0;
  let pendingLongPath: string | undefined;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    // Two consecutive all-zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;

    const nameField = readCString(header.subarray(0, 100));
    const sizeField = parseOctal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefixField = readCString(header.subarray(345, 500));

    offset += BLOCK;
    const dataStart = offset;
    const dataEnd = dataStart + sizeField;
    const data = tar.subarray(dataStart, dataEnd);
    // Data is padded up to the next 512-byte boundary.
    offset += Math.ceil(sizeField / BLOCK) * BLOCK;

    if (typeflag === '5') {
      // directory — nothing to keep
      continue;
    }
    if (typeflag === 'g') {
      // pax global extended header — applies to the whole archive; we don't
      // need any of its records (uid/gid/etc), just skip its data.
      continue;
    }
    if (typeflag === 'x') {
      // pax extended header for the NEXT entry — currently only 'path' matters.
      const records = parsePaxRecords(data);
      const p = records.get('path');
      if (p !== undefined) pendingLongPath = p;
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0') {
      // unsupported typeflag (symlink, hardlink, GNU longname, ...) — skip.
      pendingLongPath = undefined;
      continue;
    }

    // Regular file.
    const name = pendingLongPath ?? (prefixField ? `${prefixField}/${nameField}` : nameField);
    pendingLongPath = undefined;
    if (name) out.set(name, new Uint8Array(data));
  }

  return out;
}
