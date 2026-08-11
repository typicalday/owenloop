/**
 * `.wnlp` manifest (`bundle.yaml`) — strict fail-closed parsing, schema
 * validation, cross-reference lock checks, integrity construction, and
 * canonical YAML serialization (WP-A1, see `docs/bundles.md`).
 *
 * The manifest is package-only: it carries identity, platform selectors, a
 * named workflow-to-path map, a per-file integrity map, REQUESTED capabilities
 * (never granted here), and a digest-pinned `lock` map for explicit
 * `namespace/name@version` call references. Execution fields (`worker`,
 * `command`, interpreter, script…) are unknown keys and refused — workflow
 * files remain the only execution surface.
 *
 * Parsing is fail-closed on the YAML AST: parse errors AND warnings refuse
 * the document; aliases, merge keys, tags (custom or built-in), non-string
 * map keys, and duplicate keys are all named refusals. Canonical
 * serialization is deterministic: fixed key order, sorted map keys and list
 * values (ascending UTF-8 bytes), every string double-quoted, two-space
 * indent, one final newline.
 */

import { createHash } from 'node:crypto';
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
} from 'yaml';
import type { ParsedNode, Pair } from 'yaml';
import { archivePathViolation } from '../archive.ts';
import { assertCurrentRuntimeCompatible, isCanonicalSemver } from './runtime.ts';
import { BundleError } from './types.ts';
import type { BundleManifest, BundleRuntimeRequirements } from './types.ts';

/** Lowercase 64-hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const DIGEST_RE = /^[0-9a-f]{64}$/;
/** Portable package namespace. */
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Workflow map keys: lowercase-start, lowercase alphanumeric and hyphen. */
export const WORKFLOW_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** Version: printable ASCII, no separators that would break filenames or lock keys. */
const VERSION_RE = /^[!-~]{1,128}$/;
/** Versioned runtime feature identifier ending in a positive `.vN` version. */
const RUNTIME_FEATURE_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[1-9][0-9]*$/;
/** Platform selector: `os-arch`-style identifier. */
const PLATFORM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Capability class identifier. */
const CAPABILITY_CLASS_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
/** Explicit cross-bundle reference: `namespace/name@version`. */
const VERSIONED_REF_RE = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)@([!-~]+)$/;

/** True when `text` is the explicit `namespace/name@version` reference form. */
export function isVersionedReference(text: string): boolean {
  return VERSIONED_REF_RE.test(text);
}

/**
 * Walk a yaml AST into plain JS values, fail-closed: refuses aliases, merge
 * keys, any tag (custom `!x` or built-in `!!x`), and non-string map keys.
 * Plain scalars keep their parsed type (string/number/boolean/null); quoted
 * scalars are always strings.
 */
function astToPlain(node: ParsedNode | Pair<ParsedNode, ParsedNode | null> | null, ctx: string): unknown {
  if (node === null) {
    throw new BundleError('MANIFEST_ERROR', `${ctx}: empty value is not allowed`);
  }
  if (isPair(node)) {
    throw new BundleError('MANIFEST_ERROR', `${ctx}: unexpected key/value pair outside a mapping`);
  }
  if (isAlias(node)) {
    throw new BundleError('MANIFEST_ERROR', `${ctx}: YAML aliases are not allowed`);
  }
  const tag = (node as { tag?: string | null }).tag;
  if (tag !== undefined && tag !== null) {
    throw new BundleError('MANIFEST_ERROR', `${ctx}: tagged YAML nodes are not allowed`);
  }
  if (isMap(node)) {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const item of node.items) {
      const keyNode = item.key;
      if (isAlias(keyNode)) {
	throw new BundleError('MANIFEST_ERROR', `${ctx}: YAML aliases are not allowed`);
      }
      if (!isScalar(keyNode) || typeof keyNode.value !== 'string') {
	throw new BundleError('MANIFEST_ERROR', `${ctx}: mapping keys must be strings`);
      }
      const key = keyNode.value;
      if (key === '<<') {
	throw new BundleError('MANIFEST_ERROR', `${ctx}: YAML merge keys are not allowed`);
      }
      out[key] = astToPlain(item.value, `${ctx}.${key}`);
    }
    return out;
  }
  if (isSeq(node)) {
    return node.items.map((item, i) => astToPlain(item, `${ctx}[${i}]`));
  }
  if (isScalar(node)) {
    if (node.tag !== undefined && node.tag !== null) {
      throw new BundleError('MANIFEST_ERROR', `${ctx}: tagged scalar '${node.tag}' is not allowed`);
    }
    return node.value;
  }
  throw new BundleError('MANIFEST_ERROR', `${ctx}: unsupported YAML node`);
}

function asString(value: unknown, ctx: string): string {
  if (typeof value !== 'string') {
    throw new BundleError('MANIFEST_ERROR', `${ctx}: must be a string`);
  }
  return value;
}

function asMap(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BundleError('MANIFEST_ERROR', `${ctx}: must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  ctx: string,
  optionalKeys: readonly string[] = [],
): void {
  const allowed = new Set([...keys, ...optionalKeys]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new BundleError('MANIFEST_ERROR', `${ctx}: unknown key '${k}'`);
    }
  }
  for (const k of keys) {
    if (!(k in obj)) {
      throw new BundleError('MANIFEST_ERROR', `${ctx}: missing required key '${k}'`);
    }
  }
}

/** Assert a string list is duplicate-free; returns it. */
function assertDuplicateFree(values: string[], ctx: string): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      throw new BundleError('MANIFEST_ERROR', `${ctx}: duplicate value '${v}'`);
    }
    seen.add(v);
  }
  return values;
}

const sortedByUtf8 = (values: string[]): string[] =>
  [...values].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));

/**
 * Parse and validate `.wnlp` manifest bytes, fail-closed. Refuses non-UTF-8
 * input, a missing (or double) final newline, any YAML parse error or
 * warning, and every shape violation. Returns the validated manifest; the
 * source byte order of collections is NOT enforced here — canonicality is a
 * separate concern ({@link manifestIsCanonical}).
 */
export function parseManifestBytes(bytes: Uint8Array): BundleManifest {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BundleError('MANIFEST_ERROR', 'bundle.yaml: not valid UTF-8');
  }
  if (!text.endsWith('\n')) {
    throw new BundleError('MANIFEST_ERROR', 'bundle.yaml: must end with exactly one final newline');
  }
  if (text.endsWith('\n\n')) {
    throw new BundleError('MANIFEST_ERROR', 'bundle.yaml: must end with exactly one final newline');
  }

  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new BundleError('MANIFEST_ERROR', `bundle.yaml: YAML parse error: ${doc.errors[0]!.message.split('\n')[0]}`);
  }
  if (doc.warnings.length > 0) {
    throw new BundleError('MANIFEST_ERROR', `bundle.yaml: YAML rejected: ${doc.warnings[0]!.message.split('\n')[0]}`);
  }

  const plain = astToPlain(doc.contents as ParsedNode | null, 'bundle.yaml');
  const root = asMap(plain, 'bundle.yaml');
  assertExactKeys(
    root,
    ['formatVersion', 'package', 'workflows', 'platforms', 'integrity', 'capabilities', 'lock'],
    'bundle.yaml',
    ['runtime', 'default'],
  );

  // formatVersion — refuse future versions rather than guess.
  const formatVersion = root['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    throw new BundleError('MANIFEST_ERROR', 'bundle.yaml.formatVersion: must be an integer');
  }
  if (formatVersion !== 2) {
    throw new BundleError('UNSUPPORTED_FORMAT_VERSION', `bundle.yaml.formatVersion: unsupported format version ${formatVersion} (this reader supports 2)`);
  }

  // package identity.
  const pkg = asMap(root['package'], 'bundle.yaml.package');
  assertExactKeys(pkg, ['name', 'version'], 'bundle.yaml.package');
  const name = asString(pkg['name'], 'bundle.yaml.package.name');
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new BundleError('MANIFEST_ERROR', `bundle.yaml.package.name: '${name}' must be 1-128 chars of letters, digits, '-', '_' (starting alphanumeric)`);
  }
  const version = asString(pkg['version'], 'bundle.yaml.package.version');
  if (!VERSION_RE.test(version) || version.includes('/') || version.includes('\\')) {
    throw new BundleError('MANIFEST_ERROR', `bundle.yaml.package.version: '${version}' must be 1-128 printable ASCII chars with no '/' or '\\'`);
  }

  // runtime — an optional closed compatibility declaration. Shape errors are
  // MANIFEST_ERROR; a well-formed declaration unsupported by this process is
  // RUNTIME_INCOMPATIBLE. Evaluate before workflow fields are consumed so all
  // admission paths refuse an incompatible bundle before loading definitions.
  let runtime: BundleRuntimeRequirements | undefined;
  if (Object.prototype.hasOwnProperty.call(root, 'runtime')) {
    const runtimeRaw = asMap(root['runtime'], 'bundle.yaml.runtime');
    assertExactKeys(runtimeRaw, [], 'bundle.yaml.runtime', ['minVersion', 'features']);
    if (!Object.prototype.hasOwnProperty.call(runtimeRaw, 'minVersion') &&
				!Object.prototype.hasOwnProperty.call(runtimeRaw, 'features')) {
      throw new BundleError('MANIFEST_ERROR', 'bundle.yaml.runtime: must declare minVersion, features, or both');
    }

    let minVersion: string | undefined;
    if (Object.prototype.hasOwnProperty.call(runtimeRaw, 'minVersion')) {
      minVersion = asString(runtimeRaw['minVersion'], 'bundle.yaml.runtime.minVersion');
      if (!isCanonicalSemver(minVersion)) {
				throw new BundleError(
					'MANIFEST_ERROR',
					`bundle.yaml.runtime.minVersion: '${minVersion}' must be one canonical strict SemVer value with no range, prefix, or whitespace`,
				);
      }
    }

    let features: string[] | undefined;
    if (Object.prototype.hasOwnProperty.call(runtimeRaw, 'features')) {
      const featuresRaw = runtimeRaw['features'];
      if (!Array.isArray(featuresRaw)) {
				throw new BundleError('MANIFEST_ERROR', 'bundle.yaml.runtime.features: must be a list');
      }
      if (featuresRaw.length === 0) {
				throw new BundleError('MANIFEST_ERROR', 'bundle.yaml.runtime.features: must contain at least one feature');
      }
      features = assertDuplicateFree(
				featuresRaw.map((feature, i) => asString(feature, `bundle.yaml.runtime.features[${i}]`)),
				'bundle.yaml.runtime.features',
      );
      for (const feature of features) {
				if (!RUNTIME_FEATURE_RE.test(feature) || Buffer.byteLength(feature, 'utf8') > 128) {
					throw new BundleError(
						'MANIFEST_ERROR',
						`bundle.yaml.runtime.features: feature '${feature}' must be a lowercase versioned identifier ending in '.vN' (maximum 128 UTF-8 bytes)`,
					);
				}
      }
    }

    runtime = {
      ...(minVersion === undefined ? {} : { minVersion }),
      ...(features === undefined ? {} : { features }),
    };
    assertCurrentRuntimeCompatible(runtime);
  }

  // workflows — at least one named, archive-relative definition path.
  const workflowsRaw = asMap(root['workflows'], 'bundle.yaml.workflows');
  const workflowEntries = Object.entries(workflowsRaw);
  if (workflowEntries.length === 0) {
    throw new BundleError('MANIFEST_ERROR', 'bundle.yaml.workflows: must contain at least one workflow');
  }
  const workflows: Record<string, string> = Object.create(null) as Record<string, string>;
  const workflowPaths = new Set<string>();
  for (const [workflowName, workflowPathRaw] of workflowEntries) {
    if (!WORKFLOW_NAME_RE.test(workflowName)) {
      throw new BundleError(
        'MANIFEST_ERROR',
        `bundle.yaml.workflows: name '${workflowName}' must match /^[a-z][a-z0-9-]*$/`,
      );
    }
    const workflowPath = asString(workflowPathRaw, `bundle.yaml.workflows['${workflowName}']`);
    const violation = archivePathViolation(workflowPath);
    if (violation) {
      throw new BundleError(
        'MANIFEST_ERROR',
        `bundle.yaml.workflows['${workflowName}']: unsafe path '${workflowPath}': ${violation}`,
        workflowPath,
      );
    }
    if (workflowPaths.has(workflowPath)) {
      throw new BundleError(
        'MANIFEST_ERROR',
        `bundle.yaml.workflows: duplicate path '${workflowPath}'`,
        workflowPath,
      );
    }
    workflowPaths.add(workflowPath);
    workflows[workflowName] = workflowPath;
  }

  let defaultWorkflow: string | undefined;
  if (Object.prototype.hasOwnProperty.call(root, 'default')) {
    defaultWorkflow = asString(root['default'], 'bundle.yaml.default');
    if (!Object.prototype.hasOwnProperty.call(workflows, defaultWorkflow)) {
      throw new BundleError(
        'MANIFEST_ERROR',
        `bundle.yaml.default: '${defaultWorkflow}' is not a workflow name`,
      );
    }
  }

  // platforms — duplicate-free string selectors.
  const platformsRaw = root['platforms'];
  if (!Array.isArray(platformsRaw)) {
    throw new BundleError('MANIFEST_ERROR', 'bundle.yaml.platforms: must be a list');
  }
  const platforms = assertDuplicateFree(
    platformsRaw.map((p, i) => asString(p, `bundle.yaml.platforms[${i}]`)),
    'bundle.yaml.platforms',
  );
  for (const p of platforms) {
    if (!PLATFORM_RE.test(p)) {
      throw new BundleError('MANIFEST_ERROR', `bundle.yaml.platforms: selector '${p}' must be 1-128 chars of letters, digits, '.', '_', '-' (starting alphanumeric)`);
    }
  }

  // integrity — algorithm fixed; per-file digests validated here and the
  // exact coverage is cross-checked against archive entries by the caller.
  const integrity = asMap(root['integrity'], 'bundle.yaml.integrity');
  assertExactKeys(integrity, ['algorithm', 'files'], 'bundle.yaml.integrity');
  if (integrity['algorithm'] !== 'sha256') {
    throw new BundleError('MANIFEST_ERROR', `bundle.yaml.integrity.algorithm: must be 'sha256' (got '${String(integrity['algorithm'])}')`);
  }
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [path, digest] of Object.entries(asMap(integrity['files'], 'bundle.yaml.integrity.files'))) {
    const violation = archivePathViolation(path);
    if (violation) {
      throw new BundleError('MANIFEST_ERROR', `bundle.yaml.integrity.files: unsafe path '${path}': ${violation}`, path);
    }
    if (path === 'bundle.yaml') {
      throw new BundleError('MANIFEST_ERROR', "bundle.yaml.integrity.files: must not list 'bundle.yaml' (recursive self-hash)");
    }
    const d = asString(digest, `bundle.yaml.integrity.files['${path}']`);
    if (!DIGEST_RE.test(d)) {
      throw new BundleError('MANIFEST_ERROR', `bundle.yaml.integrity.files['${path}']: digest must be lowercase 64-hex SHA-256`);
    }
    files[path] = d;
  }

  // capabilities — requested classes → requested values (requests only).
  const capabilities: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [cls, values] of Object.entries(asMap(root['capabilities'], 'bundle.yaml.capabilities'))) {
    if (!CAPABILITY_CLASS_RE.test(cls)) {
      throw new BundleError('MANIFEST_ERROR', `bundle.yaml.capabilities: class '${cls}' must be 1-128 chars of letters, digits, '.', '_', '-' (starting with a letter)`);
    }
    if (!Array.isArray(values)) {
      throw new BundleError('MANIFEST_ERROR', `bundle.yaml.capabilities['${cls}']: must be a list`);
    }
    const vals = assertDuplicateFree(
      values.map((v, i) => asString(v, `bundle.yaml.capabilities['${cls}'][${i}]`)),
      `bundle.yaml.capabilities['${cls}']`,
    );
    for (const v of vals) {
      const hasControl = [...v].some((ch) => {
	const code = ch.codePointAt(0) ?? 0;
	return code === 0 || code < 0x20 || code === 0x7f;
      });
      if (v === '' || hasControl || v.length > 1024) {
	throw new BundleError('MANIFEST_ERROR', `bundle.yaml.capabilities['${cls}']: value '${v}' must be a non-empty printable string (<= 1024 chars)`);
      }
    }
    capabilities[cls] = vals;
  }

  // lock — explicit versioned reference text → def digest.
  const lock: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [ref, digestRaw] of Object.entries(asMap(root['lock'], 'bundle.yaml.lock'))) {
    if (!isVersionedReference(ref)) {
      throw new BundleError('MANIFEST_ERROR', `bundle.yaml.lock: key '${ref}' must be an explicit 'namespace/name@version' reference`);
    }
    const digest = asString(digestRaw, `bundle.yaml.lock['${ref}']`);
    if (!DIGEST_RE.test(digest)) {
      throw new BundleError('MANIFEST_ERROR', `bundle.yaml.lock['${ref}']: digest must be lowercase 64-hex SHA-256`);
    }
    lock[ref] = digest;
  }

  return {
    formatVersion: 2,
    package: { name, version },
    ...(runtime === undefined ? {} : { runtime }),
    workflows,
    ...(defaultWorkflow === undefined ? {} : { default: defaultWorkflow }),
    platforms,
    integrity: { algorithm: 'sha256', files },
    capabilities,
    lock,
  };
}

/** Double-quote a string for canonical YAML output (JSON escaping is valid YAML). */
const q = (s: string): string => JSON.stringify(s);

/**
 * Serialize a manifest to its canonical bytes: fixed top-level key order,
 * map keys and list values sorted by ascending UTF-8 bytes, every string
 * double-quoted, two-space indent, one final newline. Deterministic across
 * platforms — the checked-in golden vector freezes the result.
 */
export function manifestToBytes(manifest: BundleManifest): Uint8Array {
  const lines: string[] = [];
  lines.push(`formatVersion: ${manifest.formatVersion}`);
  lines.push('package:');
  lines.push(`  name: ${q(manifest.package.name)}`);
  lines.push(`  version: ${q(manifest.package.version)}`);
  if (manifest.runtime !== undefined) {
    lines.push('runtime:');
    if (manifest.runtime.minVersion !== undefined) {
      lines.push(`  minVersion: ${q(manifest.runtime.minVersion)}`);
    }
    if (manifest.runtime.features !== undefined) {
      lines.push('  features:');
      for (const feature of sortedByUtf8(manifest.runtime.features)) {
				lines.push(`    - ${q(feature)}`);
      }
    }
  }
  const workflowKeys = sortedByUtf8(Object.keys(manifest.workflows));
  lines.push('workflows:');
  for (const workflowName of workflowKeys) {
    lines.push(`  ${q(workflowName)}: ${q(manifest.workflows[workflowName]!)}`);
  }
  if (manifest.default !== undefined) lines.push(`default: ${q(manifest.default)}`);

  const platforms = sortedByUtf8(manifest.platforms);
  if (platforms.length === 0) {
    lines.push('platforms: []');
  } else {
    lines.push('platforms:');
    for (const p of platforms) lines.push(`  - ${q(p)}`);
  }

  lines.push('integrity:');
  lines.push('  algorithm: "sha256"');
  const fileKeys = sortedByUtf8(Object.keys(manifest.integrity.files));
  if (fileKeys.length === 0) {
    lines.push('  files: {}');
  } else {
    lines.push('  files:');
    for (const k of fileKeys) lines.push(`    ${q(k)}: ${q(manifest.integrity.files[k]!)}`);
  }

  const capKeys = sortedByUtf8(Object.keys(manifest.capabilities));
  if (capKeys.length === 0) {
    lines.push('capabilities: {}');
  } else {
    lines.push('capabilities:');
    for (const cls of capKeys) {
      const vals = sortedByUtf8(manifest.capabilities[cls]!);
      if (vals.length === 0) {
	lines.push(`  ${q(cls)}: []`);
      } else {
	lines.push(`  ${q(cls)}:`);
	for (const v of vals) lines.push(`    - ${q(v)}`);
      }
    }
  }

  const lockKeys = sortedByUtf8(Object.keys(manifest.lock));
  if (lockKeys.length === 0) {
    lines.push('lock: {}');
  } else {
    lines.push('lock:');
    for (const k of lockKeys) lines.push(`  ${q(k)}: ${q(manifest.lock[k]!)}`);
  }

  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** True when `bytes` is exactly the canonical serialization of the manifest it parses to. */
export function manifestIsCanonical(bytes: Uint8Array): boolean {
  const manifest = parseManifestBytes(bytes);
  const canonical = manifestToBytes(manifest);
  return Buffer.compare(Buffer.from(bytes), Buffer.from(canonical)) === 0;
}

/**
 * Cross-reference check: every `calls:` target in `callsTargets` that uses
 * the explicit `namespace/name@version` form must carry a `lock` entry. Bare
 * (same-package) calls stay governed by the existing def grammar and need no
 * lock. A1 does not resolve or fetch locks — it only validates coverage.
 */
export function assertLockCoverage(manifest: BundleManifest, callsTargets: string[]): void {
  for (const target of callsTargets) {
    if (!isVersionedReference(target)) continue;
    if (!Object.prototype.hasOwnProperty.call(manifest.lock, target)) {
      throw new BundleError(
	'MANIFEST_ERROR',
	`bundle.yaml.lock: calls: target '${target}' uses the explicit 'namespace/name@version' form and requires a lock entry`,
      );
    }
  }
}
