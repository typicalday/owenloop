/**
 * Crew-roster disk layout and layered merge.
 *
 * This module owns where machine roster layers come from and their
 * strongest-first cascade. Shape validation and capability lookup remain in
 * `agent/capability-model.ts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  type Roster,
  type RosterCandidate,
  validateRoster,
} from '../agent/capability-model.ts';
import { owenloopConfigDir } from '../../../../src/config-dir.ts';
import { loadSettings } from './settings.ts';
import { hubRosterLayers, readHubRosterCache } from './hub-roster-cache.ts';

export interface RosterLayer {
  /** Provenance printed verbatim by `owenloop roster show`. */
  source: string;
  /** Inspected even if absent, so diagnostics can state where they looked. */
  path?: string;
  /** Absent when the layer does not exist on this machine. */
  roster?: Roster;
}

/** One on-disk strongest-layer roster the resolver can actually select. */
export interface CrewRosterFile {
  /** The exact hub crew name represented by this file. */
  crew: string;
  path: string;
  /** Literal/nested legacy path, or the dedicated codec namespace. */
  kind: 'legacy' | 'encoded';
}

export interface MergedRosterEntry {
  candidates: readonly RosterCandidate[];
  source: string;
}

export type MergedRoster = Readonly<Record<string, MergedRosterEntry>>;

/** Merge key-by-key. `layers` is ordered STRONGEST FIRST. */
export function mergeRosterLayers(layers: readonly RosterLayer[]): MergedRoster {
  // Capability names are arbitrary strings, including Object.prototype names.
  // A null prototype keeps every own key routable and makes `__proto__` data,
  // rather than a request to mutate the result's prototype.
  const merged = Object.create(null) as Record<string, MergedRosterEntry>;
  for (const layer of layers) {
    if (layer.roster === undefined) continue;
    for (const [capability, candidates] of Object.entries(layer.roster)) {
      if (!Object.prototype.hasOwnProperty.call(merged, capability)) {
        // Candidate arrays are atomic: a winning layer replaces every weaker
        // candidate, never concatenating or element-merging with it.
        merged[capability] = { candidates, source: layer.source };
      }
    }
  }
  return merged;
}

function readCrewRoster(path: string): Roster {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid crew roster at ${path}: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid crew roster at ${path}: expected an object with a 'roster' key`);
  }
  const roster = (parsed as Record<string, unknown>)['roster'];
  if (typeof roster !== 'object' || roster === null || Array.isArray(roster)) {
    throw new Error(`invalid crew roster at ${path}: 'roster' must be a JSON object`);
  }
  try {
    validateRoster(roster as Record<string, unknown>, 'roster');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid crew roster at ${path}: ${message}`);
  }
  return roster as Roster;
}

/** The directory containing operator-owned strongest-layer crew files. */
export function crewRosterDir(env: Record<string, string | undefined>): string {
  return join(owenloopConfigDir(env), 'crews');
}

const CREW_ROSTER_FILENAME_PREFIX = 'crew--';
const CREW_ROSTER_HASH_FILENAME_PREFIX = 'crew-hash--';
// POSIX filesystems commonly cap a path component at 255 bytes. Leave margin
// below that limit so the codec cannot turn a hub-valid crew into ENAMETOOLONG.
const MAX_CREW_ROSTER_FILENAME_BYTES = 240;
// This is a directory, not a filename prefix, so the codec namespace cannot
// overlap any legacy one-segment `crews/<crew>.json` filename. In particular,
// `delivery` and a legacy crew literally named `crew--ZGVsaXZlcnk` remain two
// distinct files.
const CREW_ROSTER_ENCODED_DIR = '.owenloop-encoded-rosters';
const WINDOWS_RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * Path-segment-safe filename codec for crews that cannot use their legacy
 * literal filename. Short names retain the reversible form. Extremely large
 * names use a fixed-size content-addressed form; setup writes the crew name in
 * the file's note, while ordinary safe names remain literal for rollback.
 */
export function encodeCrewRosterFilename(crew: string): string {
  const reversible = `${CREW_ROSTER_FILENAME_PREFIX}${Buffer.from(crew, 'utf8').toString('base64url')}.json`;
  if (Buffer.byteLength(reversible, 'utf8') <= MAX_CREW_ROSTER_FILENAME_BYTES) return reversible;
  return `${CREW_ROSTER_HASH_FILENAME_PREFIX}${createHash('sha256').update(crew, 'utf8').digest('base64url')}.json`;
}

/** Decode only an exact codec output; ordinary legacy basenames stay literal. */
export function decodeCrewRosterFilename(filename: string): string | undefined {
  if (!filename.startsWith(CREW_ROSTER_FILENAME_PREFIX) || !filename.endsWith('.json')) return undefined;
  const encoded = filename.slice(CREW_ROSTER_FILENAME_PREFIX.length, -'.json'.length);
  try {
    const crew = Buffer.from(encoded, 'base64url').toString('utf8');
    return encodeCrewRosterFilename(crew) === filename ? crew : undefined;
  } catch {
    return undefined;
  }
}

/** Map a root-level legacy filename to its literal crew name. */
export function crewNameFromRosterFilename(filename: string): string | undefined {
  return filename.endsWith('.json') ? filename.slice(0, -'.json'.length) : undefined;
}

/** Map a filename within the codec-only directory back to its crew name. */
export function crewNameFromEncodedRosterFilename(filename: string): string | undefined {
  return decodeCrewRosterFilename(filename);
}

/**
 * Return the crew identity stored by a codec-only roster. Reversible codec
 * names carry their identity in the basename; bounded hash names carry it in
 * the JSON document because a hash is intentionally not reversible. Checking
 * that the recorded identity resolves back to this filename prevents a stale
 * or hand-edited document from making doctor inspect a different crew.
 */
export function crewNameFromEncodedRosterFile(path: string): string | undefined {
  const filename = basename(path);
  const decoded = decodeCrewRosterFilename(filename);
  if (decoded !== undefined) return decoded;
  if (!filename.startsWith(CREW_ROSTER_HASH_FILENAME_PREFIX) || !filename.endsWith('.json')) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const crew = (parsed as Record<string, unknown>)['crew'];
    return typeof crew === 'string' && encodeCrewRosterFilename(crew) === filename ? crew : undefined;
  } catch {
    return undefined;
  }
}

function containedCrewPath(dir: string, filename: string): string {
  const root = resolve(dir);
  const path = resolve(root, filename);
  const fromRoot = relative(root, path);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`unsafe crew roster path for ${JSON.stringify(filename)}`);
  }
  return path;
}

/** Directory reserved for the reversible codec; disjoint from legacy files. */
export function encodedCrewRosterDir(env: Record<string, string | undefined>): string {
  return containedCrewPath(crewRosterDir(env), CREW_ROSTER_ENCODED_DIR);
}

function encodedCrewRosterPath(env: Record<string, string | undefined>, crew: string): string {
  return containedCrewPath(encodedCrewRosterDir(env), encodeCrewRosterFilename(crew));
}

function isWindowsNativePathComponent(component: string): boolean {
  const hasControlCharacter = [...component].some((char) => char.codePointAt(0)! < 0x20);
  return component !== '' && component !== '.' && component !== '..' &&
    !hasControlCharacter && !/[<>:"|?*]/u.test(component) && !/[. ]$/u.test(component) &&
    !WINDOWS_RESERVED_BASENAMES.test(component);
}

/**
 * Whether this crew can be CREATED as one literal filename. This is separate
 * from legacy discovery: a pre-codec nested `crews/foo/bar.json` is a valid
 * POSIX/Windows path to preserve, but a new `foo/bar` roster must use the
 * codec-only directory instead of growing a hand-edited subtree.
 */
export function isNativeCrewRosterFilename(crew: string, platform: NodeJS.Platform = process.platform): boolean {
  if (crew === '' || crew.includes('/') || crew.includes('\\') || crew.includes('\0') || Buffer.byteLength(`${crew}.json`, 'utf8') > MAX_CREW_ROSTER_FILENAME_BYTES) return false;
  return platform !== 'win32' || isWindowsNativePathComponent(crew);
}

/** A contained deployed legacy path may be preserved even when new files encode it. */
function legacyCrewRosterPath(dir: string, crew: string): string | undefined {
  if (crew === '' || crew.includes('\0')) return undefined;
  // On Windows a backslash is a path separator, not an ordinary filename
  // character. Preserve deployed slash-separated legacy trees there, but
  // encode a hub name that contains a literal backslash so distinct hub names
  // cannot alias one legacy target.
  if (process.platform === 'win32' && crew.includes('\\')) return undefined;
  const segments = crew.split(process.platform === 'win32' ? /[\\/]/u : /\//u);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' ||
    (process.platform === 'win32' && !isWindowsNativePathComponent(segment)))) return undefined;
  try {
    return containedCrewPath(dir, `${crew}.json`);
  } catch {
    // A traversal-shaped name that would leave `crews/` is never a legacy
    // migration target; it receives an encoded path below.
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function legacyCrewNameForPath(root: string, path: string): string | undefined {
  const relativePath = relative(root, path);
  if (!relativePath.endsWith('.json')) return undefined;
  // Hub crew names use `/` even on Windows; legacy paths use the current
  // platform separator. This is the only representation conversion, and the
  // final round trip through `legacyCrewRosterPath` proves containment.
  const crew = relativePath.slice(0, -'.json'.length).split(sep).join('/');
  const resolved = legacyCrewRosterPath(root, crew);
  return resolved !== undefined && samePath(resolved, path) ? crew : undefined;
}

function walkCrewRosterFiles(
  root: string,
  current: string,
  visit: (path: string) => void,
  skipDirectory?: string,
): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (current === root && entry.name === skipDirectory) continue;
      walkCrewRosterFiles(root, path, visit, skipDirectory);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      visit(path);
    }
  }
}

/**
 * Discover the same set of on-disk files that `machineRosterLayers` can use.
 *
 * This is intentionally the one source of truth for both the resolver and
 * doctor: literal root files, contained pre-codec nested files, reversible
 * codec files, and bounded hash files (whose JSON records the crew identity)
 * all enter through this function. A future naming rule cannot make doctor
 * omit a file the resolver reads without changing this shared function.
 */
export function discoverCrewRosterFiles(env: Record<string, string | undefined>): CrewRosterFile[] {
  const root = crewRosterDir(env);
  if (!existsSync(root)) return [];
  const found: CrewRosterFile[] = [];

  // Legacy is scanned first so an existing literal/nested operator file keeps
  // the precedence promised by `crewRosterPath` over a later codec target.
  walkCrewRosterFiles(root, root, (path) => {
    const crew = legacyCrewNameForPath(root, path);
    if (crew !== undefined) found.push({ crew, path, kind: 'legacy' });
  }, CREW_ROSTER_ENCODED_DIR);

  const encodedDir = encodedCrewRosterDir(env);
  if (!existsSync(encodedDir)) return found;
  walkCrewRosterFiles(encodedDir, encodedDir, (path) => {
    // Codec files only live at the codec root. A nested or malformed file in
    // this directory is still a pre-existing contained legacy file and must
    // remain discoverable rather than disappearing during an upgrade.
    const crew = relative(encodedDir, path) === basename(path)
      ? crewNameFromEncodedRosterFile(path)
      : undefined;
    if (crew !== undefined && samePath(encodedCrewRosterPath(env, crew), path)) {
      found.push({ crew, path, kind: 'encoded' });
      return;
    }
    const legacyCrew = legacyCrewNameForPath(root, path);
    if (legacyCrew !== undefined) found.push({ crew: legacyCrew, path, kind: 'legacy' });
  });
  return found;
}

/** Find one discovered roster, preserving legacy's upgrade precedence. */
export function findCrewRosterFile(
  env: Record<string, string | undefined>,
  crew: string,
): CrewRosterFile | undefined {
  return discoverCrewRosterFiles(env).find((file) => file.crew === crew);
}

/**
 * Resolve an untrusted crew name to one file beneath `crews/`, preserving a
 * pre-codec operator file when it exists. This makes an upgrade non-destructive
 * for names such as spaces, colons, percent signs, and Unicode; setup uses this
 * same resolver, so it cannot create an empty encoded duplicate over an existing
 * strongest-layer override.
 *
 * A new name that is safe as a single native path component remains a literal
 * root-level file for rollback compatibility. Unsafe or too-wide names use the
 * codec-only subdirectory plus `encodeCrewRosterFilename`; hub names are always
 * data, never path segments, and every target has an explicit containment
 * proof.
 */
export function crewRosterPath(env: Record<string, string | undefined>, crew: string): string {
  const dir = crewRosterDir(env);
  const existing = findCrewRosterFile(env, crew);
  if (existing !== undefined) return existing.path;
  const legacy = legacyCrewRosterPath(dir, crew);
  // Earlier builds of this feature used the reversible codec for every new
  // crew. Retain an already-materialized file through the upgrade before
  // choosing today's literal-or-bounded representation.
  const encoded = encodedCrewRosterPath(env, crew);
  if (existsSync(encoded)) return encoded;
  return isNativeCrewRosterFilename(crew) ? legacy! : encoded;
}

/**
 * The machine's layers for one crew, strongest first. When no crew is known,
 * only the machine-global `settings.json` roster participates.
 */
export function machineRosterLayers(
  env: Record<string, string | undefined>,
  crew: string | undefined,
): RosterLayer[] {
  const layers: RosterLayer[] = [];
  if (crew !== undefined) {
    // Do not use discovery as the read gate. Bounded hash filenames need the
    // JSON's `crew` field for doctor to associate them with their intended
    // name, but that field is unavailable precisely when a truncated/corrupt
    // strongest-layer file must fail closed. The requested crew resolves its
    // own deterministic target, and any existing target is always parsed by
    // readCrewRoster.
    const path = crewRosterPath(env, crew);
    layers.push({
      source: `machine crews/${crew}.json`,
      path,
      ...(existsSync(path) ? { roster: readCrewRoster(path) } : {}),
    });
  }
  const path = join(owenloopConfigDir(env), 'settings.json');
  const settings = loadSettings(env);
  layers.push({
    source: 'machine settings.json',
    path,
    ...(settings.roster !== undefined ? { roster: settings.roster } : {}),
  });
  return layers;
}

/** One composition point shared by the offline child and CLI diagnostics. */
export function effectiveRosterLayers(
  env: Record<string, string | undefined>,
  crew: string | undefined,
  hub: { origin: string | undefined; account: string },
): RosterLayer[] {
  const machine = machineRosterLayers(env, crew);
  if (hub.origin === undefined || hub.origin.trim() === '') {
    const unavailable = (source: string): RosterLayer => ({ source: `${source} (unavailable: no hub origin configured)` });
    return crew === undefined
      ? [...machine, unavailable('hub org-global')]
      : [...machine, unavailable(`hub crew ${crew}`), unavailable('hub org-global')];
  }
  return [...machine, ...hubRosterLayers(readHubRosterCache(env, hub.origin, hub.account), crew)];
}

/** Explain all weaker rows hidden by a stronger layer, without changing merge. */
export function explainRosterShadows(
  layers: readonly RosterLayer[],
): Record<string, { winner: string; shadowed: Array<{ source: string; candidateCount: number }> }> {
  const result: Record<string, { winner: string; shadowed: Array<{ source: string; candidateCount: number }> }> = Object.create(null);
  for (const layer of layers) {
    if (layer.roster === undefined) continue;
    for (const [capability, candidates] of Object.entries(layer.roster)) {
      const existing = result[capability];
      if (existing === undefined) result[capability] = { winner: layer.source, shadowed: [] };
      else existing.shadowed.push({ source: layer.source, candidateCount: candidates.length });
    }
  }
  return result;
}
