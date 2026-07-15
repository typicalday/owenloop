/** Shared test fixtures — inline workflow/step builders and an artifact-map helper. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { parseConsume, parseProduce } from '../src/paths.ts';
import type { ArtifactData, EffectDef, FiringTrigger, GroupDef, InputDef, StepDef, WorkflowDef } from '../src/types.ts';
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
  worker?: string;
  command?: string;
  spec?: Record<string, unknown>;
  body?: string;
  terminal?: boolean;
  effect?: EffectDef;
  on?: FiringTrigger[];
  idleAfter?: string;
  idleAfterMs?: number;
  reapTtlMs?: number;
  labels?: string[];
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
    ...(spec.labels !== undefined ? { labels: spec.labels } : {}),
    ...(spec.maxLeaseMs !== undefined ? { maxLeaseMs: spec.maxLeaseMs } : {}),
    ...(spec.groups !== undefined ? { groups: spec.groups } : {}),
    ...(spec.x !== undefined ? { x: spec.x } : {}),
    ...(spec.workdir !== undefined ? { workdir: spec.workdir } : {}),
    ...(spec.worker !== undefined ? { worker: spec.worker } : {}),
    ...(spec.command !== undefined ? { command: spec.command } : {}),
    ...(spec.spec !== undefined ? { spec: spec.spec } : {}),
    body: spec.body ?? `run ${spec.name}`,
  };
}

export function def(name: string, inputs: InputDef[], steps: StepDef[]): WorkflowDef {
  return { name, engine: 1, inputs, steps };
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
