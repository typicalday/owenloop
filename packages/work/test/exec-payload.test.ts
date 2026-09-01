import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PAYLOAD_FILE_ENV,
  PAYLOAD_FILE_MAX_BYTES,
  PAYLOAD_MARKER,
  PAYLOAD_MAX_BYTES,
  parsePayloadLine,
  readPayloadFile,
  resolvePayload,
} from '../src/exec/payload.ts';

// The payload channel in isolation. Every fixture here is a file in a
// test-created temp directory — no child process, no hub, no repo mutation.
// The loop-level wiring (that exec always sets the variable, creates the
// directory and removes it) is asserted in exec-loop.test.ts instead.

const DIR = mkdtempSync(join(tmpdir(), 'owenloop-payload-test-'));
let nextFixture = 0;

// Not optional housekeeping: the cap fixtures below are sparse files the size of
// the cap, so every run of this suite that skipped cleanup would leave two
// 24 MB apparent files behind. `force` because a test that already removed its
// own fixture must not turn into a suite failure here.
after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

/** Write `content` to a fresh path and return the path. */
function fixture(content: string): string {
  const path = join(DIR, `payload-${++nextFixture}.json`);
  writeFileSync(path, content);
  return path;
}

/** A path inside DIR that nothing has written. */
function absentPath(): string {
  return join(DIR, `absent-${++nextFixture}.json`);
}

// ---- readPayloadFile --------------------------------------------------------

test('an unset variable is an absence, not an error', () => {
  assert.deepEqual(readPayloadFile(undefined), {});
});

test('a path nothing wrote is the ordinary absence — the command used stdout, or returned nothing', () => {
  assert.deepEqual(readPayloadFile(absentPath()), {});
});

test('a written file comes back trimmed, and reports the bytes it held', () => {
  const raw = '  {"answer":42}\n';
  const read = readPayloadFile(fixture(raw));
  assert.equal(read.text, '{"answer":42}');
  assert.equal(read.error, undefined);
  // Property assertions rather than a whole-object comparison. `PayloadFileRead`
  // is a shape that grows — `bytes` was added to it after these tests existed,
  // and a `deepEqual` against a literal fails on the addition alone even though
  // nothing it was written to check has changed.
  //
  // The count is of the bytes ON DISK, not of the trimmed text: a conflict
  // message has to describe the file as the command wrote it, and by the time
  // anyone reads that message the file is gone.
  assert.equal(read.bytes, Buffer.byteLength(raw, 'utf8'));
});

test('an empty or whitespace-only file reads as an absence', () => {
  // Deliberately asymmetric with the marker line, where empty is an error:
  // `> "$OWENLOOP_PAYLOAD_FILE"` is what a shell does to a path it is about to
  // MAYBE write, so truncating it states no intent at all.
  for (const content of ['', '\n', '   \n\t\n']) {
    const read = readPayloadFile(fixture(content));
    const label = JSON.stringify(content);
    assert.equal('text' in read, false, label);
    assert.equal(read.error, undefined, label);
    // The measured size rides along, but an absence is what the resolver sees:
    // a file with a byte count and no text is a file the command did not use.
    assert.deepEqual(resolvePayload({ file: read }), {}, label);
  }
});

test('a directory at the payload path is an error, not an absence', () => {
  const path = join(DIR, `dir-${++nextFixture}`);
  mkdirSync(path);
  const read = readPayloadFile(path);
  assert.match(read.error ?? '', /not a regular file/);
  assert.equal('text' in read, false);
});

test('a file one byte over the cap is refused, and the refusal names the size and the cap', () => {
  // Sparse: the point is that the size is read from the stat, so the bytes are
  // never pulled into memory to find out they are too many.
  const path = absentPath();
  writeFileSync(path, '');
  truncateSync(path, PAYLOAD_FILE_MAX_BYTES + 1);
  const read = readPayloadFile(path);
  assert.equal('text' in read, false);
  assert.match(read.error ?? '', new RegExp(String(PAYLOAD_FILE_MAX_BYTES + 1)));
  assert.match(read.error ?? '', new RegExp(String(PAYLOAD_FILE_MAX_BYTES)));
  assert.match(read.error ?? '', /must be written as an artifact/);
});

test('a file at exactly the cap is accepted — the comparison is >, not >=', () => {
  const path = absentPath();
  writeFileSync(path, '');
  truncateSync(path, PAYLOAD_FILE_MAX_BYTES);
  const read = readPayloadFile(path);
  assert.equal(read.error, undefined);
  assert.ok('text' in read, 'a file at the cap is a payload, not an absence');
  // The read loop drained the whole file, not just the first chunk `readSync`
  // happened to return. Asserted on the byte count rather than on the decoded
  // string's length: the two are equal only for ASCII, and holding a
  // 24-million-character string just to call `.length` on it is a needless
  // allocation in a suite that runs on every commit.
  assert.equal(read.bytes, PAYLOAD_FILE_MAX_BYTES);
});

test('the cap is far above the stdout cap and safely below the hub artifact cap', () => {
  // Literals, deliberately, and the only place in this file that uses them.
  // Every other assertion about the cap derives its expectation from
  // PAYLOAD_FILE_MAX_BYTES itself, so silently shrinking the constant — which
  // reopens the exact gap this channel exists to close — passes all of them.
  //
  // 25_000_000 is MAX_ARTIFACT_BYTES in owenloop-service
  // `packages/hub-core/src/artifacts.ts`, enforced by `verbs/submit.ts` against
  // the whole serialized CommandReceipt, NOT against the payload alone. That is
  // why headroom is required rather than equality: the receipt carries the
  // command, the output tail and the run identifiers around the payload, and a
  // payload sized at the hub's cap is therefore guaranteed to be refused. A
  // refusal there is not a clean error either — `submit` returns it as a
  // rejection on the owed path, the step is re-offered, the command
  // deterministically regenerates the same oversized payload, and the run burns
  // its attempts. Restated here rather than imported because this repo cannot
  // see that one; the same pattern pins BUNDLE_MAX_BYTES in
  // hub-bundle-recovery.test.ts.
  const HUB_MAX_ARTIFACT_BYTES = 25_000_000;
  assert.ok(
    PAYLOAD_FILE_MAX_BYTES < HUB_MAX_ARTIFACT_BYTES,
    'a payload the worker accepts must still be submittable',
  );
  assert.ok(
    HUB_MAX_ARTIFACT_BYTES - PAYLOAD_FILE_MAX_BYTES >= 1_000_000,
    'leave room for the receipt envelope around the payload',
  );
  assert.ok(
    PAYLOAD_FILE_MAX_BYTES >= 16 * 1024 * 1024,
    'the file channel exists to lift the 64 KiB stdout ceiling — a small cap defeats it',
  );
});

test('a symbolic link at the payload path is refused, not followed', () => {
  // O_NOFOLLOW, not a post-open check: `statSync` and `fstat`-after-a-following
  // -open both report the TARGET, so a "regular file" guard written with either
  // one silently publishes whatever the link points at. Same user, so this is
  // not privilege escalation — it is that the code said regular file and did
  // something else.
  const target = fixture('{"from":"the link target"}');
  const link = join(DIR, `link-${++nextFixture}.json`);
  symlinkSync(target, link);
  const read = readPayloadFile(link);
  assert.equal('text' in read, false, 'the target must not be published');
  assert.match(read.error ?? '', /symbolic link/);
  assert.ok(read.error?.includes(PAYLOAD_FILE_ENV));
});

test('an open failure that is not ENOENT is an error, not an absence', () => {
  // Only a missing file means "the command did not use this channel". Every
  // other reason the path will not open is something the operator has to see:
  // reporting it as an absence turns a broken environment into a step that
  // quietly produces nothing.
  //
  // ENOTDIR rather than EACCES: a permission fixture is silently a no-op when
  // the suite runs as root, which is the ordinary case inside a container.
  const notADirectory = fixture('{"ok":true}');
  const read = readPayloadFile(join(notADirectory, 'child.json'));
  assert.equal('text' in read, false);
  assert.match(read.error ?? '', /cannot read/);
  assert.ok(read.error?.includes(PAYLOAD_FILE_ENV));
  assert.equal(read.bytes, undefined, 'nothing was measured, so nothing may be claimed');
});

// ---- the gap this channel exists to close -----------------------------------

test('a payload well over the stdout cap round-trips through the file', () => {
  // The whole reason the file exists. This exact value has no way home through
  // the marker line: the scanner drops it and the step produces nothing.
  const big = { note: 'x'.repeat(PAYLOAD_MAX_BYTES * 2) };
  const json = JSON.stringify(big);
  assert.ok(Buffer.byteLength(json, 'utf8') > PAYLOAD_MAX_BYTES);

  const overStdout = parsePayloadLine(json);
  assert.match(overStdout.payloadError ?? '', /exceeds the 64 KiB cap/);
  assert.equal('payload' in overStdout, false);

  const throughFile = resolvePayload({ file: readPayloadFile(fixture(json)) });
  assert.deepEqual(throughFile.payload, big);
  assert.equal(throughFile.payloadError, undefined);
});

// ---- resolvePayload: which transport, and what it means ---------------------

test('neither transport used is an empty parse, not an error', () => {
  assert.deepEqual(resolvePayload({}), {});
  assert.deepEqual(resolvePayload({ file: readPayloadFile(absentPath()) }), {});
});

test('the stdout marker still works untouched when the file is unused', () => {
  const resolved = resolvePayload({ payloadLine: '{"answer":42}', file: {} });
  assert.deepEqual(resolved.payload, { answer: 42 });
  assert.equal(resolved.payloadError, undefined);
});

test('an over-cap marker line still reports the marker error when the file is unused', () => {
  const resolved = resolvePayload({ payloadOverCap: true, file: {} });
  assert.match(resolved.payloadError ?? '', /exceeds the 64 KiB cap/);
});

test('a file read error is surfaced verbatim rather than falling back to stdout', () => {
  const path = join(DIR, `dir-err-${++nextFixture}`);
  mkdirSync(path);
  const resolved = resolvePayload({ file: readPayloadFile(path) });
  assert.match(resolved.payloadError ?? '', /not a regular file/);
  assert.equal('payload' in resolved, false);
});

test('a payload through both transports is refused by name, not silently ranked', () => {
  const resolved = resolvePayload({
    payloadLine: '{"from":"stdout"}',
    file: readPayloadFile(fixture('{"from":"file"}')),
  });
  assert.equal('payload' in resolved, false, 'neither statement may be published');
  assert.ok(resolved.payloadError?.includes(PAYLOAD_MARKER));
  assert.ok(resolved.payloadError?.includes(PAYLOAD_FILE_ENV));
  assert.match(resolved.payloadError ?? '', /exactly one of them/);
});

test('an over-cap marker line plus a file is still a conflict', () => {
  // The command stated a result on stdout. That the statement was too long to
  // read does not turn it into a command that only used the file.
  const resolved = resolvePayload({
    payloadOverCap: true,
    file: readPayloadFile(fixture('{"from":"file"}')),
  });
  assert.match(resolved.payloadError ?? '', /exactly one of them/);
});

test('an unusable file plus a marker line is a conflict, not a fallback', () => {
  const path = join(DIR, `dir-conflict-${++nextFixture}`);
  mkdirSync(path);
  const resolved = resolvePayload({ payloadLine: '{"from":"stdout"}', file: readPayloadFile(path) });
  assert.match(resolved.payloadError ?? '', /exactly one of them/);
});

test('an empty file alongside a marker line is NOT a conflict — the file was not used', () => {
  const resolved = resolvePayload({
    payloadLine: '{"answer":42}',
    file: readPayloadFile(fixture('   \n')),
  });
  assert.deepEqual(resolved.payload, { answer: 42 });
  assert.equal(resolved.payloadError, undefined);
});

// ---- the file carries the same meanings the marker line does ----------------

test('malformed JSON in the file is an error naming the file, not a crash', () => {
  const resolved = resolvePayload({ file: readPayloadFile(fixture('{"broken"')) });
  assert.match(resolved.payloadError ?? '', /payload JSON is malformed/);
  assert.equal('payload' in resolved, false);
});

test('a reject directive means the same thing through either transport', () => {
  const json = '{"reject":{"path":"input","text":"upstream is invalid"}}';
  const viaFile = resolvePayload({ file: readPayloadFile(fixture(json)) });
  const viaLine = resolvePayload({ payloadLine: json });
  assert.deepEqual(viaFile.reject, { path: 'input', text: 'upstream is invalid' });
  assert.deepEqual(viaFile, viaLine);
});

test('a malformed reject directive in the file keeps the payload and refuses the directive', () => {
  const resolved = resolvePayload({ file: readPayloadFile(fixture('{"reject":{"path":"","text":"bad"}}')) });
  assert.deepEqual(resolved.payload, { reject: { path: '', text: 'bad' } });
  assert.match(resolved.payloadError ?? '', /non-empty string/);
  assert.equal(resolved.reject, undefined);
});

test('a non-object reject directive in the file is refused the same way', () => {
  const resolved = resolvePayload({ file: readPayloadFile(fixture('{"reject":"nope"}')) });
  assert.deepEqual(resolved.payload, { reject: 'nope' });
  assert.match(resolved.payloadError ?? '', /must be an object/);
  assert.equal(resolved.reject, undefined);
});

test('a JSON primitive in the file is a payload, not an error', () => {
  assert.equal(resolvePayload({ file: readPayloadFile(fixture('null')) }).payload, null);
  assert.equal(resolvePayload({ file: readPayloadFile(fixture('7')) }).payload, 7);
});
