/**
 * Stock `allowed_signers` parser tests. The parser is STRUCTURAL — principals,
 * options, key type, key blob, comment, line numbers — and never throws: bad
 * lines become `{ line, message }` errors. The committed corpus lives at
 * `test/fixtures/crypto/allowed_signers.txt` (public keys only). An
 * integration test passes an accepted fixture line unchanged to stock
 * `ssh-keygen` and proves stock accepts it (skipped when the host lacks a
 * working `ssh-keygen -Y`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllowedSigners } from '../src/crypto/allowed-signers.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'crypto');
const CORPUS = readFileSync(join(FIXTURES, 'allowed_signers.txt'), 'utf8');

/** Does this host run a stock `ssh-keygen` that supports `-Y`? */
function sshKeygenWorks(): boolean {
  try {
    execFileSync('ssh-keygen', ['-Y', 'find-principals'], { stdio: 'ignore', timeout: 5_000 });
    return true; // exit 0 impossible here (missing -s), but any run means the binary exists
  } catch (e) {
    const err = e as { status?: unknown };
    return typeof err.status === 'number'; // a real exit status = the -Y group parsed
  }
}

test('corpus: five entries, zero errors, blank/comment lines skipped with line numbers', () => {
  const { entries, errors } = parseAllowedSigners(CORPUS);
  assert.deepEqual(errors, [], 'corpus is clean');
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((e) => e.line), [5, 7, 8, 9, 10], 'line numbers skip comments/blanks');
});

test('corpus entry 1: bare line — principals, key type, blob, trailing comment', () => {
  const { entries } = parseAllowedSigners(CORPUS);
  const e = entries[0]!;
  assert.deepEqual(e.principals, ['alice']);
  assert.equal(e.keyType, 'ssh-ed25519');
  assert.equal(e.comment, 'alice@example');
  assert.deepEqual(e.options, { certAuthority: false, namespaces: undefined, validAfter: undefined, validBefore: undefined });
  assert.ok(e.keyBlob.equals(Buffer.from(e.keyBase64, 'base64')), 'blob is the strict-decoded key');
});

test('corpus entry 2: multiple principals + namespaces option', () => {
  const { entries } = parseAllowedSigners(CORPUS);
  const e = entries[1]!;
  assert.deepEqual(e.principals, ['alice', 'bob']);
  assert.deepEqual(e.options.namespaces, ['owenloop-dsse-v1', 'other-ns']);
  assert.equal(e.comment, 'two principals with namespaces');
});

test('corpus entry 3: cert-authority singleton', () => {
  const e = parseAllowedSigners(CORPUS).entries[2]!;
  assert.equal(e.options.certAuthority, true);
});

test('corpus entry 4: comma-joined options with quoted comma/space values', () => {
  const e = parseAllowedSigners(CORPUS).entries[3]!;
  assert.deepEqual(e.options.namespaces, ['a', 'b c'], 'quoted value keeps its inner comma+space');
  assert.equal(e.options.validAfter, '20200101000000Z');
  assert.equal(e.options.validBefore, '20300101000000Z');
});

test('corpus entry 5: one comma-separated options field', () => {
  const e = parseAllowedSigners(CORPUS).entries[4]!;
  assert.deepEqual(e.options.namespaces, ['ns1']);
  assert.equal(e.options.certAuthority, true);
  assert.equal(e.comment, 'comma-joined options');
});

test('CRLF input parses identically to LF', () => {
  const lf = 'alice ssh-ed25519 QUJD x\nbob ssh-ed25519 QUJD y\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const a = parseAllowedSigners(lf);
  const b = parseAllowedSigners(crlf);
  assert.equal(b.entries.length, 2);
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.entries.map((e) => e.principals), [['alice'], ['bob']]);
  assert.deepEqual(a.entries.map((e) => e.keyBlob), b.entries.map((e) => e.keyBlob));
});

test('quotes in a trailing comment are opaque after the key blob', () => {
  const key = 'AAAAC3NzaC1lZDI1NTE5AAAAIDspeZ1e+CYKy4Q2CXCbjI4xVqWr0xcPIPCjTml0KCdT';
  const res = parseAllowedSigners(`alice ssh-ed25519 ${key} my "unbalanced comment\n`);
  assert.deepEqual(res.errors, []);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0]!.comment, 'my "unbalanced comment');
});

test('stock-tolerated repeated and empty option slots are accepted', () => {
  const key = 'AAAAC3NzaC1lZDI1NTE5AAAAIDspeZ1e+CYKy4Q2CXCbjI4xVqWr0xcPIPCjTml0KCdT';
  const text = [
    `alice cert-authority,cert-authority ssh-ed25519 ${key}`,
    `bob cert-authority,,namespaces="a" ssh-ed25519 ${key}`,
  ].join('\n');
  const res = parseAllowedSigners(text);
  assert.deepEqual(res.errors, []);
  assert.equal(res.entries.length, 2);
  assert.equal(res.entries[0]!.options.certAuthority, true);
  assert.equal(res.entries[1]!.options.certAuthority, true);
  assert.deepEqual(res.entries[1]!.options.namespaces, ['a']);
});

test('empty and comment-only files yield no entries and no errors', () => {
  assert.deepEqual(parseAllowedSigners(''), { entries: [], errors: [] });
  assert.deepEqual(parseAllowedSigners('# only a comment\n\n'), { entries: [], errors: [] });
});

test('malformed lines produce line-numbered errors and never throw', () => {
  const text = [
    'one-token-only', // 1: missing fields
    'p keyonly', // 2: missing fields
    'p cert-authority ssh-ed25519', // 3: missing base64 key
    'p foobar ssh-ed25519 QUJD', // 4: unsupported option
    'p namespaces="unterminated ssh-ed25519 QUJD', // 5: unterminated quote
    'p ssh-ed25519 !!!', // 6: bad base64 blob
    'p cert-authority, ssh-ed25519 QUJD', // 7: trailing comma
    'p touch-required ssh-ed25519 QUJD', // 8: unsupported stock option
    'p namespaces=ns ssh-ed25519 QUJD', // 9: unquoted assignment
    'p namespaces="a" cert-authority ssh-ed25519 QUJD', // 10: whitespace-separated options
    'p ssh-ed25519 ____', // 11: URL-safe/non-standard Base64
  ].join('\n');
  const res = parseAllowedSigners(text);
  assert.deepEqual(res.entries, [], 'no line is well-formed');
  assert.deepEqual(res.errors.map((e) => e.line), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'one error per bad line, numbered');
  assert.match(res.errors[0]!.message, /missing fields/);
  assert.match(res.errors[2]!.message, /missing base64 key/);
  assert.match(res.errors[3]!.message, /unsupported option syntax: 'foobar'/);
  assert.match(res.errors[4]!.message, /unterminated quoted option value/);
  assert.match(res.errors[5]!.message, /bad base64 key blob/);
  assert.match(res.errors[6]!.message, /empty option/);
  assert.match(res.errors[7]!.message, /unsupported option syntax/);
  assert.match(res.errors[8]!.message, /assignment value must be quoted/);
  assert.match(res.errors[9]!.message, /options must be one comma-separated field/);
  assert.match(res.errors[10]!.message, /bad base64 key blob/);
});

test('a good line next to a bad one: the good one survives with its line number', () => {
  const res = parseAllowedSigners('broken line\nalice ssh-ed25519 QUJD ok\n');
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0]!.line, 2);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0]!.line, 1);
});

// ---- integration: the parser's output reconstructs a stock-accepted line -----

test('integration: every accepted fixture line is passed unchanged to stock find-principals', { skip: !sshKeygenWorks() && 'host ssh-keygen lacks -Y' }, () => {
  const lines = CORPUS.split(/\r?\n/);
  const entries = parseAllowedSigners(CORPUS).entries;
  const armored = readFileSync(join(FIXTURES, 'sshsig-hello.armored'));
  for (const entry of entries) {
    const line = lines[entry.line - 1]!;
    const dir = mkdtempSync(join(tmpdir(), 'owenloop-allowed-int-'));
    try {
      const allowedPath = join(dir, 'allowed_signers');
      const sigPath = join(dir, 'sig.armored');
      writeFileSync(allowedPath, `${line}\n`, { mode: 0o600 });
      writeFileSync(sigPath, armored, { mode: 0o600 });
      const result = spawnSync(
        'ssh-keygen',
        ['-Y', 'find-principals', '-f', allowedPath, '-s', sigPath],
        { encoding: 'utf8', timeout: 10_000, shell: false },
      );
      assert.equal(result.error, undefined, `stock ssh-keygen launched for line ${entry.line}`);
      const principals = result.stdout.trim() === '' ? [] : result.stdout.trim().split(/\r?\n/);
      const expected = entry.options.certAuthority ? [] : entry.principals;
      assert.deepEqual(principals, expected, `stock principal set for fixture line ${entry.line}`);
      if (expected.length === 0) {
        assert.equal(result.status, 255, `no-match status for certificate-authority line ${entry.line}`);
        assert.equal(result.stderr.trim(), 'No principal matched.');
      } else {
        assert.equal(result.status, 0, `stock accepted fixture line ${entry.line}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
