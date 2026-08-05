/** Shared test fixtures — inline workflow/step builders and an artifact-map helper. */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { parseConsume, parseProduce } from '../src/paths.ts';
import type { ArtifactData, EffectDef, FiringTrigger, GroupDef, InputDef, Order, StepDef, WorkflowDef } from '../src/types.ts';
import type { ArtifactMap } from '../src/model.ts';

export interface StepSpec {
  name: string;
  consumes?: string[];
  produces?: string[];
  groups?: GroupDef[];
  invalidates?: string[];
  cadence?: string;
  cadenceSecs?: number;
  maxRunsPerDay?: number;
  parallel?: number;
  maxAttempts?: number;
  maxSchemaFailures?: number;
  model?: string;
  workdir?: string;
  executor?: string;
  command?: string;
  spec?: Record<string, unknown>;
  body?: string;
  terminal?: boolean;
  effect?: EffectDef;
  on?: FiringTrigger[];
  idleAfter?: string;
  idleAfterMs?: number;
  reapTtlMs?: number;
  capabilities?: string[];
  maxLeaseMs?: number;
  x?: Record<string, unknown>;
}

export function step(spec: StepSpec): StepDef {
  const consumes = (spec.consumes ?? []).map(parseConsume);
  const produces = (spec.produces ?? []).map(parseProduce);
  return {
    name: spec.name,
    consumes,
    produces,
    invalidates: spec.invalidates ?? consumes.map((c) => c.stem),
    cadence: spec.cadence ?? '0s',
    cadenceSecs: spec.cadenceSecs ?? 0,
    maxRunsPerDay: spec.maxRunsPerDay ?? 1000,
    parallel: spec.parallel ?? 100,
    maxAttempts: spec.maxAttempts ?? 3,
    maxSchemaFailures: spec.maxSchemaFailures ?? 5,
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.terminal !== undefined ? { terminal: spec.terminal } : {}),
    ...(spec.effect !== undefined ? { effect: spec.effect } : {}),
    ...(spec.on !== undefined ? { on: spec.on } : {}),
    ...(spec.idleAfter !== undefined ? { idleAfter: spec.idleAfter } : {}),
    ...(spec.idleAfterMs !== undefined ? { idleAfterMs: spec.idleAfterMs } : {}),
    ...(spec.reapTtlMs !== undefined ? { reapTtlMs: spec.reapTtlMs } : {}),
    ...(spec.capabilities !== undefined ? { capabilities: spec.capabilities } : {}),
    ...(spec.maxLeaseMs !== undefined ? { maxLeaseMs: spec.maxLeaseMs } : {}),
    ...(spec.groups !== undefined ? { groups: spec.groups } : {}),
    ...(spec.x !== undefined ? { x: spec.x } : {}),
    ...(spec.workdir !== undefined ? { workdir: spec.workdir } : {}),
    ...(spec.executor !== undefined ? { executor: spec.executor } : {}),
    ...(spec.command !== undefined ? { command: spec.command } : {}),
    ...(spec.spec !== undefined ? { spec: spec.spec } : {}),
    body: spec.body ?? `run ${spec.name}`,
  };
}

export function def(name: string, inputs: InputDef[], steps: StepDef[]): WorkflowDef {
  return { name, engine: 1, inputs, steps };
}

/**
 * WP-B1 broad invariant for every emitted-order assertion: a reference-mode
 * order carries `defDigest` and must NEVER re-grow authored instruction text —
 * no own `prompt`, no own `command`, no legacy `executor`, no
 * `owes[].acceptance`. Apply this to every order a new emission test emits so
 * a future order variant fails here instead of silently leaking channel-1
 * text back onto the wire.
 */
export function assertReferenceContract(o: Order): void {
  assert.equal(typeof o.defDigest, 'string');
  assert.ok(o.defDigest.length > 0, 'defDigest must be non-empty');
  assert.equal(Object.prototype.hasOwnProperty.call(o, 'prompt'), false, 'reference order must not carry prompt');
  assert.equal(Object.prototype.hasOwnProperty.call(o, 'command'), false, 'reference order must not carry command');
  assert.equal(Object.prototype.hasOwnProperty.call(o, 'executor'), false, 'reference order uses worker, not executor');
  for (const owed of o.owes) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(owed, 'acceptance'),
      false,
      `owes[${owed.path}] must not carry the lifecycle acceptance`,
    );
  }
}

export function input(name: string, opts: { producer?: string; seedOwed?: boolean } = {}): InputDef {
  return { name, producer: opts.producer ?? 'human', seedOwed: opts.seedOwed ?? false };
}

/** Build an artifact map from terse specs (defaults: producer 'p', owed, v0). */
export function arts(
  specs: Array<Partial<ArtifactData> & { path: string }>,
): ArtifactMap {
  const m = new Map<string, ArtifactData>();
  for (const s of specs) {
    m.set(s.path, {
      workflow: 'wf',
      path: s.path,
      producer: s.producer ?? 'p',
      acceptance: s.acceptance ?? 'owed',
      version: s.version ?? 0,
      reasons: s.reasons ?? [],
      judgmentRejects: s.judgmentRejects ?? 0,
      schemaRejects: s.schemaRejects ?? 0,
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.fingerprint !== undefined ? { fingerprint: s.fingerprint } : {}),
      ...(s.sealOf !== undefined ? { sealOf: s.sealOf } : {}),
      ...(s.terminal !== undefined ? { terminal: s.terminal } : {}),
    });
  }
  return m;
}

/**
 * Read every top-level `*.yaml` file directly under `dir` (skipping
 * subdirectories, and skipping a literal `workflow.yaml`, matching
 * loadDefs' own top-level file filter in src/defs.ts) and return the
 * sorted set of each file's declared `name:` field.
 *
 * Deliberately reads the raw YAML `name:` field rather than calling
 * loadDefs/buildDef — this stays faithful to how the loader names a def
 * (defs.ts: buildDef sets def.name from the YAML's name: field, not the
 * filename) without making the assertion circular (loadDefs output
 * compared to loadDefs output would not catch a def that fails to load).
 */
export function exampleDefNames(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue; // skip judges/ etc — subdirs hold non-def assets
    if (!/\.ya?ml$/.test(entry) || entry === 'workflow.yaml') continue;
    const raw = parseYaml(readFileSync(full, 'utf8')) as { name?: unknown };
    if (typeof raw?.name !== 'string') {
      throw new Error(`${full}: expected a top-level 'name:' string field`);
    }
    names.push(raw.name);
  }
  return names.sort();
}

// ---- USTAR/pax tar-gz writer (for test/untar.test.ts and test/add.test.ts) ---
//
// A minimal, from-scratch tar+gzip writer used to build fixture tarballs
// shaped like GitHub's codeload output: a single root dir prefix
// (`<owner>-<repo>-<sha>/…`), USTAR headers, and a pax extended header
// (typeflag 'x') for any path over 100 chars. Deliberately independent of
// `src/untar.ts` — it exists to exercise that reader, not share code with it.

const BLOCK = 512;

function octalField(value: number, length: number): string {
  // length includes the trailing NUL; e.g. length 12 -> 11 octal digits + '\0'.
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function writeField(buf: Buffer, str: string, offset: number, length: number): void {
  buf.write(str, offset, Math.min(Buffer.byteLength(str, 'ascii'), length), 'ascii');
}

function padTo512(data: Buffer): Buffer {
  const padded = Math.ceil(data.length / BLOCK) * BLOCK;
  const out = Buffer.alloc(padded);
  data.copy(out);
  return out;
}

/** Build one 512-byte USTAR header block (name truncated to 100 bytes — long names go via a pax 'x' entry instead). */
function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const buf = Buffer.alloc(BLOCK);
  writeField(buf, name, 0, 100);
  writeField(buf, octalField(0o644, 8), 100, 8); // mode
  writeField(buf, octalField(0, 8), 108, 8); // uid
  writeField(buf, octalField(0, 8), 116, 8); // gid
  writeField(buf, octalField(size, 12), 124, 12); // size
  writeField(buf, octalField(0, 12), 136, 12); // mtime
  buf.fill(0x20, 148, 156); // checksum field: spaces while computing
  buf[156] = typeflag.charCodeAt(0);
  writeField(buf, 'ustar', 257, 6); // magic "ustar\0" (rest zero-filled)
  writeField(buf, '00', 263, 2); // version

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] as number;
  writeField(buf, octalField(sum, 6) + ' ', 148, 8);
  return buf;
}

/** One pax extended-header data record: "<len> <key>=<value>\n", <len> self-inclusive. */
function paxRecord(key: string, value: string): string {
  const suffixLen = 1 + key.length + 1 + value.length + 1; // ' ' + key + '=' + value + '\n'
  let digits = String(suffixLen).length;
  let total = digits + suffixLen;
  // digit count of `total` can grow once (crossing a power-of-ten boundary) — settle it.
  while (String(total).length !== digits) {
    digits = String(total).length;
    total = digits + suffixLen;
  }
  return `${total} ${key}=${value}\n`;
}

function tarEntryBlocks(fullPath: string, data: Uint8Array): Buffer[] {
  const blocks: Buffer[] = [];
  if (Buffer.byteLength(fullPath, 'utf8') > 100) {
    const paxData = Buffer.from(paxRecord('path', fullPath), 'utf8');
    blocks.push(tarHeader('PaxHeader', paxData.length, 'x'), padTo512(paxData));
    // Name field is overridden by the pax record above; content is moot.
    blocks.push(tarHeader(fullPath.slice(0, 99), data.length, '0'), padTo512(Buffer.from(data)));
  } else {
    blocks.push(tarHeader(fullPath, data.length, '0'), padTo512(Buffer.from(data)));
  }
  return blocks;
}

/**
 * Build a gzipped USTAR archive shaped like a GitHub codeload tarball: every
 * file in `files` (relative path -> text contents) lands under
 * `<rootPrefix>/<relative path>`. Used to feed a fake injected `fetch` in
 * `test/add.test.ts`, and to round-trip against `extractTarGz` in
 * `test/untar.test.ts`.
 */
export function makeGithubTarball(rootPrefix: string, files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [relPath, contents] of Object.entries(files)) {
    blocks.push(...tarEntryBlocks(`${rootPrefix}/${relPath}`, Buffer.from(contents, 'utf8')));
  }
  blocks.push(Buffer.alloc(BLOCK * 2)); // two all-zero blocks mark end of archive
  return gzipSync(Buffer.concat(blocks));
}

// ---- hostile/canonical USTAR fixture builder (for test/bundle.test.ts) ------
//
// A second from-scratch tar writer, this one able to emit ARBITRARY (including
// malformed) headers: any typeflag, modes, uid/gid, uname/gname, mtime, pax
// records (well-formed or corrupt), duplicate paths, truncated entries, and
// arbitrary trailing bytes. It is deliberately independent of BOTH the
// production bundle writer (src/bundle/tar.ts) and the reader
// (src/archive.ts): hostile-corpus tests must exercise the reader against an
// implementation it shares no code with.

export interface HostileHeaderOpts {
  name?: string;
  size?: number;
  typeflag?: string;
  mode?: number;
  uid?: number;
  gid?: number;
  uname?: string;
  gname?: string;
  linkname?: string;
  mtime?: number;
  /** Corrupt the header AFTER the checksum is computed (for checksum tests). */
  mutate?: (buf: Buffer) => void;
  /** Overwrite an octal field with non-octal bytes (then recompute checksum). */
  badOctalField?: { offset: number; bytes: string };
}

/** Build one arbitrary 512-byte USTAR header block (full field control). */
export function hostileHeader(opts: HostileHeaderOpts): Buffer {
  const buf = Buffer.alloc(BLOCK);
  const name = opts.name ?? '';
  buf.write(name, 0, Math.min(Buffer.byteLength(name, 'utf8'), 100), 'utf8');
  buf.write(octalField(opts.mode ?? 0o644, 8), 100, 'ascii');
  buf.write(octalField(opts.uid ?? 0, 8), 108, 'ascii');
  buf.write(octalField(opts.gid ?? 0, 8), 116, 'ascii');
  buf.write(octalField(opts.size ?? 0, 12), 124, 'ascii');
  buf.write(octalField(opts.mtime ?? 0, 12), 136, 'ascii');
  buf.fill(0x20, 148, 156);
  buf[156] = (opts.typeflag ?? '0').charCodeAt(0);
  buf.write('ustar', 257, 'ascii');
  buf[262] = 0;
  buf.write('00', 263, 2, 'ascii');
  if (opts.uname) buf.write(opts.uname, 265, 'utf8');
  if (opts.gname) buf.write(opts.gname, 297, 'utf8');
  if (opts.linkname) buf.write(opts.linkname, 157, 'utf8');

  if (opts.badOctalField) {
    buf.write(opts.badOctalField.bytes, opts.badOctalField.offset, 'ascii');
  }

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] as number;
  // Tar checksums use six octal digits, then NUL and space. `octalField`'s
  // length includes its trailing NUL, so width 7 yields the six-digit field.
  buf.write(octalField(sum, 7) + ' ', 148, 'ascii');

  if (opts.mutate) opts.mutate(buf);
  return buf;
}

/** Pad `data` to a 512-byte boundary (empty content -> empty buffer). */
export function hostileData(data: Uint8Array): Buffer {
  return padTo512(Buffer.from(data));
}

export interface HostileTarballOpts {
  /** Append raw bytes AFTER the terminator blocks. */
  trailing?: Uint8Array;
  /** Emit only ONE zero block instead of two (or none: 'missing'). */
  terminator?: 'two' | 'one' | 'missing';
}

/**
 * Assemble blocks into a gzip stream. By default appends the canonical
 * two-zero-block terminator (see `terminator`).
 */
export function hostileTarball(blocks: Buffer[], opts: HostileTarballOpts = {}): Buffer {
  const all = [...blocks];
  if ((opts.terminator ?? 'two') === 'two') all.push(Buffer.alloc(BLOCK * 2));
  else if (opts.terminator === 'one') all.push(Buffer.alloc(BLOCK));
  if (opts.trailing) all.push(Buffer.from(opts.trailing));
  return gzipSync(Buffer.concat(all));
}

/** One canonical-shaped regular-file entry (mode 0644, zeros everywhere). */
export function hostileFileEntry(name: string, content: Uint8Array | string, extra: HostileHeaderOpts = {}): Buffer[] {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return [hostileHeader({ name, size: data.length, typeflag: '0', ...extra }), hostileData(data)];
}

/** One pax extended-header block pair with caller-controlled data bytes. */
export function hostilePaxBlocks(name: string, paxData: Uint8Array, extra: HostileHeaderOpts = {}): Buffer[] {
  return [hostileHeader({ name, size: paxData.length, typeflag: 'x', ...extra }), hostileData(paxData)];
}

/** The canonical single-record pax payload: `"<len> path=<value>\n"`. */
export function hostilePaxPathRecord(path: string): Buffer {
  const valueBytes = Buffer.byteLength(path, 'utf8');
  const suffixLen = 1 + 'path='.length + valueBytes + 1;
  let digits = String(suffixLen).length;
  let total = digits + suffixLen;
  while (String(total).length !== digits) {
    digits = String(total).length;
    total = digits + suffixLen;
  }
  return Buffer.from(`${total} path=${path}\n`, 'utf8');
}
