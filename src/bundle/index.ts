/**
 * High-level `.wnlp` bundle API (WP-A1): pack, inspect, digest, unpack.
 *
 * The API is byte-oriented and store-independent on purpose: WP-A2 (signing)
 * signs the digest returned here, WP-A3 (trust/installation) inspects and
 * unpacks bytes BEFORE installation, WP-B1 (transport) carries the digest —
 * none of them need the CLI, a local store, or each other.
 *
 * Reading is strict and fail-closed (see `src/archive.ts` strict policy):
 * every failure is a {@link BundleError} with a stable `code`.
 */

import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_TAR_LIMITS, archivePathViolation, inflateArchive, parseTar } from '../archive.ts';
import type { TarEntry, TarLimits } from '../archive.ts';
import { parseDef } from '../defs.ts';
import { loadDefFile } from '../defs.ts';
import { parse as parseYaml } from 'yaml';
import {
  assertLockCoverage,
  manifestIsCanonical,
  manifestToBytes,
  parseManifestBytes,
  sha256Hex,
} from './manifest.ts';
import { buildCanonicalTar, collectSourceFiles, gzipDeterministic } from './tar.ts';
import { BundleError } from './types.ts';
import type {
  BundleEntryInfo,
  BundleLimits,
  BundleManifest,
  InspectOptions,
  InspectResult,
  PackOptions,
  PackResult,
} from './types.ts';

export type {
  BundleEntryInfo,
  BundleErrorCode,
  BundleLimits,
  BundleManifest,
  BundleRuntimeRequirements,
  InspectOptions,
  InspectResult,
  PackOptions,
  PackResult,
} from './types.ts';
export { BundleError } from './types.ts';

/** Default resource bounds for bundle reading/writing (the shared archive limits). */
export const DEFAULT_BUNDLE_LIMITS: BundleLimits = { ...DEFAULT_TAR_LIMITS };

function mergeLimits(partial?: Partial<BundleLimits>): TarLimits {
  const limits = { ...DEFAULT_BUNDLE_LIMITS, ...partial };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BundleError('BUNDLE_LIMIT', `${name} must be a positive safe integer`);
    }
  }
  return limits;
}

/** Wrap a DefError/parse failure into a stable-code BundleError. */
function workflowError(message: string, entryPath: string): BundleError {
  return new BundleError('WORKFLOW_ERROR', `${entryPath}: ${message}`, entryPath);
}

/**
 * Bounded inflation + SHA-256 over the EXACT uncompressed canonical tar
 * bytes. No files are written. This digest — not the gzip bytes — is the
 * bundle's identity.
 */
export function digestBundle(bytes: Uint8Array, opts: InspectOptions = {}): { digest: string } {
  const lim = mergeLimits(opts.limits);
  let tar: Buffer;
  try {
    tar = inflateArchive(bytes, lim);
  } catch (e) {
    throw limitOrArchiveError(e);
  }
  return { digest: sha256Hex(tar) };
}

/** Convert archive/limit failures into stable-code BundleErrors. */
function limitOrArchiveError(e: unknown): BundleError {
  if (e instanceof BundleError) return e;
  const err = e as NodeJS.ErrnoException;
  const msg = err?.message ?? String(e);
  // archive.ts strict violations carry a stable code; surface it as-is.
  const code = (err as { code?: string })?.code;
  const known: ReadonlyArray<string> = [
    'ARCHIVE_TOO_MANY_ENTRIES',
    'ARCHIVE_ENTRY_TOO_LARGE',
    'ARCHIVE_PATH_TOO_LONG',
    'ARCHIVE_PATH_VIOLATION',
    'ARCHIVE_DUPLICATE_PATH',
    'ARCHIVE_TRUNCATED',
    'ARCHIVE_BAD_CHECKSUM',
    'ARCHIVE_BAD_OCTAL',
    'ARCHIVE_BAD_PAX',
    'ARCHIVE_DANGLING_PAX',
    'ARCHIVE_TRAILING_BYTES',
    'UNSUPPORTED_ENTRY_TYPE',
    'NON_CANONICAL_HEADER',
  ];
  if (code && known.includes(code)) {
    return new BundleError(code as BundleError['code'], msg, (err as { entryPath?: string }).entryPath);
  }
  // gzip failures (corrupt/non-gzip input) and inflate limit refusals.
  if (msg.includes('expanded archive size exceeds limit') || msg.includes('compressed archive size')) {
    return new BundleError('BUNDLE_LIMIT', msg);
  }
  return new BundleError('BUNDLE_NOT_GZIP', `cannot read archive: ${msg}`);
}

/** Strict parse result carrying entry DATA (internal — inspect drops it). */
interface StrictRead {
  digest: string;
  entries: TarEntry[];
  manifest: BundleManifest;
}

function readBundleStrict(bytes: Uint8Array, lim: TarLimits): StrictRead {
  let tar: Buffer;
  let entries: TarEntry[];
  try {
    tar = inflateArchive(bytes, lim);
    entries = parseTar(tar, lim, { policy: 'strict' });
  } catch (e) {
    throw limitOrArchiveError(e);
  }

  const manifests = entries.filter((e) => e.path === 'bundle.yaml');
  if (manifests.length === 0) {
    throw new BundleError('MANIFEST_MISSING', "bundle has no root 'bundle.yaml' manifest");
  }
  const manifestEntry = manifests[0]!;
  const manifest = parseManifestBytes(manifestEntry.data);
  if (!manifestIsCanonical(manifestEntry.data)) {
    throw new BundleError('MANIFEST_ERROR', 'bundle.yaml: not in canonical form (pack it with owenloop bundle pack)');
  }
  return { digest: sha256Hex(tar), entries, manifest };
}

/**
 * Replace archive-contained `bodyFile` references with their file text before
 * calling the normal definition parser. The disk loader resolves these paths
 * against the workflow directory; an archive reader has no directory, so the
 * equivalent in-memory operation must enforce the same relative-path policy,
 * require a regular archive entry, and then provide the resolved body string.
 */
function inlineArchiveBodyFiles(
  value: unknown,
  files: Map<string, TarEntry>,
  workflowPath: string,
  context: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => inlineArchiveBodyFiles(item, files, workflowPath, `${context}[${i}]`));
  }
  if (typeof value !== 'object' || value === null) return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const hasBody = Object.prototype.hasOwnProperty.call(source, 'body');
  const escapedWorkflowPath = workflowPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const canResolveBodyFile = new RegExp(
    `^${escapedWorkflowPath}\\.steps\\[\\d+\\](?:\\.produces\\[\\d+\\]\\.judges\\[\\d+\\])?$`,
  ).test(context);
  const slash = workflowPath.lastIndexOf('/');
  const workflowDirectory = slash === -1 ? '' : workflowPath.slice(0, slash);
  for (const [key, item] of Object.entries(source)) {
    if (canResolveBodyFile && key === 'bodyFile' && typeof item === 'string' && !hasBody) {
      const violation = archivePathViolation(item);
      if (violation) {
	throw new Error(`${context}.bodyFile '${item}' is unsafe: ${violation}`);
      }
      const targetPath = workflowDirectory === '' ? item : `${workflowDirectory}/${item}`;
      const targetViolation = archivePathViolation(targetPath);
      if (targetViolation) {
	throw new Error(`${context}.bodyFile '${item}' is unsafe after resolving against '${workflowDirectory}': ${targetViolation}`);
      }
      const target = files.get(targetPath);
      if (!target) {
	throw new Error(`${context}.bodyFile '${item}' is missing from the archive`);
      }
      let body: string;
      try {
	body = new TextDecoder('utf-8', { fatal: true }).decode(target.data);
      } catch {
	throw new Error(`${context}.bodyFile '${item}' is not valid UTF-8`);
      }
      out.body = body;
      continue;
    }
    out[key] = inlineArchiveBodyFiles(item, files, workflowPath, `${context}.${key}`);
  }
  return out;
}

/** Workflow validation shared by inspect and unpack (in-memory; no disk). */
function validateWorkflowsBytes(entries: TarEntry[], manifest: BundleManifest): void {
  const files = new Map(entries.map((entry) => [entry.path, entry]));
  const callsTargets: string[] = [];
  for (const [workflowName, workflowPath] of Object.entries(manifest.workflows)) {
    const workflowEntry = files.get(workflowPath);
    if (!workflowEntry) {
      throw new BundleError(
        'WORKFLOW_MISSING',
        `bundle is missing workflow '${workflowName}' at '${workflowPath}'`,
        workflowPath,
      );
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(workflowEntry.data);
    } catch {
      throw workflowError('not valid UTF-8', workflowPath);
    }
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (e) {
      throw workflowError(`YAML parse error: ${(e as Error).message.split('\n')[0]}`, workflowPath);
    }
    let def;
    try {
      const inlined = inlineArchiveBodyFiles(raw, files, workflowPath, workflowPath);
      def = parseDef(inlined, workflowPath, undefined);
    } catch (e) {
      throw workflowError((e as Error).message, workflowPath);
    }
    if (def.name !== workflowName) {
      throw new BundleError(
        'WORKFLOW_ERROR',
        `${workflowPath}: definition name '${def.name}' must equal workflow map key '${workflowName}'`,
        workflowPath,
      );
    }
    callsTargets.push(...def.steps.map((step) => step.calls).filter((target): target is string => typeof target === 'string'));
  }
  assertLockCoverage(manifest, callsTargets);
}

/** Exact-set integrity coverage + per-file hash verification. */
function verifyIntegrity(entries: TarEntry[], manifest: BundleManifest): void {
  const archivePaths = new Set(entries.map((e) => e.path));
  const integrityKeys = Object.keys(manifest.integrity.files);

  for (const key of integrityKeys) {
    if (!archivePaths.has(key)) {
      throw new BundleError('INTEGRITY_MISMATCH', `integrity lists '${key}' which is not in the archive`, key);
    }
  }
  for (const e of entries) {
    if (e.path === 'bundle.yaml') continue; // excluded: recursive self-hash
    if (!Object.prototype.hasOwnProperty.call(manifest.integrity.files, e.path)) {
      throw new BundleError('INTEGRITY_MISMATCH', `archive file '${e.path}' has no integrity entry`, e.path);
    }
    const expected = manifest.integrity.files[e.path]!;
    const actual = sha256Hex(e.data);
    if (actual !== expected) {
      throw new BundleError('INTEGRITY_MISMATCH', `integrity mismatch for '${e.path}' (expected ${expected}, got ${actual})`, e.path);
    }
  }
}

function entryInfos(entries: TarEntry[]): BundleEntryInfo[] {
  return entries.map((e) => ({
    path: e.path,
    size: e.size,
    executable: e.mode === 0o755,
    sha256: sha256Hex(e.data),
  }));
}

const ROOT_PATH_ALIASES = ['/var', '/tmp'] as const;

/**
 * Normalize the two conventional root aliases before checking ancestors. On
 * systems where an alias is a real directory this is a no-op. On systems where
 * an alias resolves elsewhere, the resolved path is checked instead, so the
 * ancestor validation has one rule on every platform. User-created symlinks
 * below the normalized root remain visible to the lexical lstat walk and are
 * refused.
 */
function normalizeRootAliases(absolute: string): string {
  let normalized = absolute;
  for (const alias of ROOT_PATH_ALIASES) {
    let target: string;
    try {
      target = realpathSync(alias);
    } catch {
      continue;
    }
    if (target === alias) continue;
    if (dirname(target) !== '/private' || basename(target) !== basename(alias)) continue;
    if (normalized === alias || normalized.startsWith(`${alias}/`)) {
      normalized = `${target}${normalized.slice(alias.length)}`;
    }
  }
  return normalized;
}

function assertDestinationParent(parent: string): string {
  const absolute = normalizeRootAliases(resolve(parent));
  let resolved: string;
  try {
    // Resolve before validating the canonical path. A dangling ancestor is an
    // invalid destination, not a request to create a new parent tree.
    resolved = realpathSync(absolute);
  } catch {
    throw new BundleError('DESTINATION_PARENT_INVALID', `unpack destination parent '${parent}' does not exist`);
  }

  const components: string[] = [];
  let current = absolute;
  while (true) {
    components.push(current);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  for (const component of components.reverse()) {
    let st;
    try {
      st = lstatSync(component, { throwIfNoEntry: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BundleError('DESTINATION_PARENT_INVALID', `cannot inspect unpack destination parent '${parent}': ${message}`);
    }
    if (!st) {
      throw new BundleError('DESTINATION_PARENT_INVALID', `unpack destination parent '${parent}' does not exist`);
    }
    if (st.isSymbolicLink()) {
      throw new BundleError('DESTINATION_PARENT_INVALID', `unpack destination ancestor '${component}' is a symbolic link`);
    }
    if (!st.isDirectory()) {
      throw new BundleError('DESTINATION_PARENT_INVALID', `unpack destination ancestor '${component}' is not a directory`);
    }
  }
  return resolved;
}

function lstatDestination(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BundleError('DESTINATION_PARENT_INVALID', `cannot inspect unpack destination '${path}': ${message}`);
  }
}

/**
 * Strictly validate a `.wnlp` bundle from its bytes, WITHOUT filesystem
 * extraction: bounded inflate, strict tar parse, one canonical root
 * `bundle.yaml`, every declared workflow validation, exact integrity coverage,
 * and per-file hash verification. Returns the digest, the manifest, and
 * sorted entry metadata.
 */
export function inspectBundle(bytes: Uint8Array, opts: InspectOptions = {}): InspectResult {
  const lim = mergeLimits(opts.limits);
  const { digest, entries, manifest } = readBundleStrict(bytes, lim);
  validateWorkflowsBytes(entries, manifest);
  verifyIntegrity(entries, manifest);
  return { digest, manifest, entries: entryInfos(entries) };
}

/**
 * Materialize a `.wnlp` bundle onto disk — archive materialization only (NOT
 * a local-store installation: no install lockfile, engine validation
 * pipeline, or crash journal).
 *
 * Runs the same strict inspection first; then requires the destination to be
 * ABSENT, stages under a fresh sibling directory using only validated paths,
 * and atomically renames staging to destination. Cleans the staging
 * directory on every failure. Refuses a symlinked destination parent before
 * staging.
 */
export function unpackBundle(bytes: Uint8Array, destination: string, opts: InspectOptions = {}): InspectResult & { path: string } {
  const lim = mergeLimits(opts.limits);
  const { digest, entries, manifest } = readBundleStrict(bytes, lim);
  validateWorkflowsBytes(entries, manifest);
  verifyIntegrity(entries, manifest);

  const destAbs = resolve(destination);
  const parent = dirname(destAbs);
  // Destination must not exist (any kind).
  const existing = lstatDestination(destAbs);
  if (existing) {
    throw new BundleError('DESTINATION_EXISTS', `unpack destination '${destination}' already exists`);
  }
  // Resolve the existing parent before checking its components. Staging uses
  // the resolved sibling path, while the public result retains the caller's
  // absolute spelling of the destination.
  const resolvedParent = assertDestinationParent(parent);

  // mkdtempSync creates a fresh sibling even when another process is unpacking
  // the same destination concurrently; the predictable pid/timestamp name
  // used by older partial code could collide.
  const staging = mkdtempSync(join(resolvedParent, `.${basename(destAbs)}.owenloop-unpack-`));
  let staged = true;
  try {

    for (const e of entries) {
      // Paths are already strict-validated (no traversal/absolute/NUL);
      // re-check against the shared policy as defense-in-depth.
      const violation = archivePathViolation(e.path);
      if (violation) {
	throw new BundleError('ARCHIVE_PATH_VIOLATION', `unsafe archive path '${e.path}': ${violation}`, e.path);
      }
      const target = join(staging, e.path);
      const targetDir = dirname(target);
      mkdirSync(targetDir, { recursive: true, mode: 0o755 });
      const fd = openSync(target, 'wx', e.mode === 0o755 ? 0o755 : 0o644);
      try {
	// fs.writeSync from a Uint8Array view.
	const buf = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
	let written = 0;
	while (written < buf.length) {
	  written += writeSync(fd, buf.subarray(written));
	}
      } finally {
	closeSync(fd);
      }
    }
    if (lstatDestination(destAbs)) {
      throw new BundleError('DESTINATION_EXISTS', `unpack destination '${destination}' already exists`);
    }
    renameSync(staging, destAbs);
    staged = false;
  } finally {
    if (staged) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { digest, manifest, entries: entryInfos(entries), path: destAbs };
}


/**
 * Pack a bundle source directory into deterministic `.wnlp` bytes.
 *
 * - Walks the source without following symlinks; refuses symlinked roots or
 *   members and unsafe paths (shared archive policy).
 * - Requires exactly one root `bundle.yaml` and every workflow path listed by
 *   that manifest.
 * - Validates the source manifest, loads every listed workflow with the engine's
 *   definition loader (retaining contained-`bodyFile` checks), requires
 *   each def name to equal its workflow map key, and requires a lock entry for
 *   each explicit `namespace/name@version` `calls:` target.
 * - Regenerates `integrity.files` from the actual file bytes (author-supplied
 *   hashes are replaceable generated data) and serializes a canonical
 *   manifest IN MEMORY — the source directory is never modified.
 * - Builds the canonical tar, computes the digest over those exact bytes,
 *   and gzips deterministically.
 */
export function packBundle(sourceDir: string, opts: PackOptions = {}): PackResult {
  const lim = mergeLimits(opts.limits);
  const files = collectSourceFiles(sourceDir, lim);

  const sourcePaths = new Set(files.map((f) => f.rel));
  if (!sourcePaths.has('bundle.yaml')) {
    throw new BundleError('MANIFEST_MISSING', `source '${sourceDir}' has no root 'bundle.yaml'`);
  }

  // Read file bytes, re-checking each node is still the same regular file it
  // was during the walk (reduces TOCTOU ambiguity).
  const contents = new Map<string, Uint8Array>();
  for (const f of files) {
    let st;
    try {
      st = lstatSync(f.abs);
    } catch {
      throw new BundleError('SOURCE_FILE_CHANGED', `'${f.rel}' disappeared during packing`, f.rel);
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new BundleError('SOURCE_FILE_CHANGED', `'${f.rel}' changed type during packing`, f.rel);
    }
    if (st.size > lim.maxFileBytes) {
      throw new BundleError('ARCHIVE_ENTRY_TOO_LARGE', `archive entry '${f.rel}' is ${st.size} bytes; limit is ${lim.maxFileBytes}`, f.rel);
    }
    try {
      contents.set(f.rel, new Uint8Array(readFileSync(f.abs)));
    } catch {
      throw new BundleError('SOURCE_FILE_CHANGED', `'${f.rel}' could not be read during packing`, f.rel);
    }
  }

  const sourceManifest = parseManifestBytes(contents.get('bundle.yaml')!);

  // Load every declared workflow with the disk loader so bodyFile paths use
  // the workflow file's own directory, then check the union of all calls.
  const callsTargets: string[] = [];
  for (const [workflowName, workflowPath] of Object.entries(sourceManifest.workflows)) {
    if (!sourcePaths.has(workflowPath)) {
      throw new BundleError(
        'WORKFLOW_MISSING',
        `source '${sourceDir}' is missing workflow '${workflowName}' at '${workflowPath}'`,
        workflowPath,
      );
    }
    let def;
    try {
      def = loadDefFile(join(resolve(sourceDir), workflowPath));
    } catch (e) {
      throw workflowError((e as Error).message, workflowPath);
    }
    if (def.name !== workflowName) {
      throw new BundleError(
        'WORKFLOW_ERROR',
        `${workflowPath}: definition name '${def.name}' must equal workflow map key '${workflowName}'`,
        workflowPath,
      );
    }
    callsTargets.push(...def.steps.map((step) => step.calls).filter((target): target is string => typeof target === 'string'));
  }
  assertLockCoverage(sourceManifest, callsTargets);

  // Regenerate the integrity map from the actual bytes (bundle.yaml excluded:
  // recursive self-hash; the digest covers it through the canonical tar).
  const integrityFiles: Record<string, string> = {};
  for (const f of files) {
    if (f.rel === 'bundle.yaml') continue;
    integrityFiles[f.rel] = sha256Hex(contents.get(f.rel)!);
  }
  const canonicalManifest: BundleManifest = {
    ...sourceManifest,
    ...(sourceManifest.runtime === undefined
      ? {}
      : {
          runtime: {
            ...(sourceManifest.runtime.minVersion === undefined
              ? {}
              : { minVersion: sourceManifest.runtime.minVersion }),
            ...(sourceManifest.runtime.features === undefined
              ? {}
              : {
                  features: [...sourceManifest.runtime.features].sort((a, b) =>
                    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
                  ),
                }),
          },
        }),
    integrity: { algorithm: 'sha256', files: integrityFiles },
  };
  const canonicalBytes = manifestToBytes(canonicalManifest);

  // Replace the manifest entry ONLY in the in-memory file set.
  const executableByPath = new Map(files.map((f) => [f.rel, f.executable]));
  const tarFiles = files.map((f) => ({
    path: f.rel,
    bytes: f.rel === 'bundle.yaml' ? canonicalBytes : contents.get(f.rel)!,
    mode: (executableByPath.get(f.rel) ?? false) ? 0o755 : 0o644,
  }));
  // files is already sorted by ascending UTF-8 path order; bundle.yaml
  // participates in that sort as one entry among the rest.

  const tar = buildCanonicalTar(tarFiles, lim);
  const digest = sha256Hex(tar);
  const bytes = gzipDeterministic(tar);
  if (bytes.length > lim.maxCompressedBytes) {
    throw new BundleError('BUNDLE_LIMIT', `compressed archive size ${bytes.length} exceeds limit of ${lim.maxCompressedBytes} bytes`);
  }

  return {
    bytes,
    digest,
    manifest: canonicalManifest,
    entries: tarFiles.map((f) => ({
      path: f.path,
      size: f.bytes.length,
      executable: f.mode === 0o755,
      sha256: sha256Hex(f.bytes),
    })),
  };
}
