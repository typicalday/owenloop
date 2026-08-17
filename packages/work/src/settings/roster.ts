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
// This was the first codec directory used on the feature branch. It can name a
// valid pre-codec nested legacy crew, so files in it need an explicit `crew`
// owner before they are treated as codec files.
const HISTORICAL_CREW_ROSTER_ENCODED_DIR = '.owenloop-encoded-rosters';
// Hub crew names are at most 64 characters. The directory itself can still be
// the prefix of a valid nested legacy crew (`<directory>/x` is 64 characters),
// so discovery classifies every file in it by its recorded codec owner. A real
// codec basename is long enough that `<directory>/<codec-basename>` cannot be
// a hub-valid legacy crew name.
const CREW_ROSTER_ENCODED_DIR = '.owenloop-machine-roster-codec-namespace-reserved-v1-ownership';
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
 * Return the authoritative crew identity stored by a codec-only roster.
 * Reversible basenames are deliberately not authority by themselves: an old
 * nested legacy path can have the same basename. Every codec file therefore
 * carries the crew it owns, and that identity must reproduce the basename.
 */
export function crewNameFromEncodedRosterFile(path: string): string | undefined {
  const filename = basename(path);
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

function historicalEncodedCrewRosterDir(env: Record<string, string | undefined>): string {
  return containedCrewPath(crewRosterDir(env), HISTORICAL_CREW_ROSTER_ENCODED_DIR);
}

function encodedCrewRosterPathIn(
  env: Record<string, string | undefined>,
  crew: string,
  dir: string,
): string {
  return containedCrewPath(dir, encodeCrewRosterFilename(crew));
}

function encodedCrewRosterPath(env: Record<string, string | undefined>, crew: string): string {
  return encodedCrewRosterPathIn(env, crew, encodedCrewRosterDir(env));
}

function isOwnedCodecRoster(path: string, crew: string): boolean {
  return crewNameFromEncodedRosterFile(path) === crew;
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

/**
 * A contained deployed legacy path may be preserved even when new files
 * encode it. This deliberately follows the pre-codec `path.join` behavior:
 * `foo/../bar`, `foo/./bar`, and `foo//bar` preserve their existing normalized
 * target when it remains below `crews/`. Segment eligibility is a
 * rule for creating new names (`isNativeCrewRosterFilename`), never a reason
 * to stop reading an existing strongest-layer override.
 */
function legacyCrewRosterPath(dir: string, crew: string): string | undefined {
  if (crew === '' || crew.includes('\0')) return undefined;
  try {
    // Preserve the literal pre-codec construction before proving containment.
    // Unlike resolve(), join() treats a leading separator in the crew as a
    // nested path below `dir`, so `/bar` retains an existing `crews/bar.json`.
    return containedCrewPath(dir, join(dir, `${crew}.json`));
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
  skipDirectories?: ReadonlySet<string>,
): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (current === root && skipDirectories?.has(entry.name)) continue;
      walkCrewRosterFiles(root, path, visit, skipDirectories);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      visit(path);
    }
  }
}

/**
 * Classify one file inside a codec directory. A matching JSON `crew` identity
 * plus its canonical codec path is the only authority that makes it encoded;
 * all other contained files remain ordinary nested legacy entries. Keeping
 * this classification shared by both codec directories prevents a directory
 * name from becoming an ownership claim.
 */
function classifyCodecDirectoryFile(
  env: Record<string, string | undefined>,
  root: string,
  codecDir: string,
  path: string,
): CrewRosterFile | undefined {
  const crew = relative(codecDir, path) === basename(path)
    ? crewNameFromEncodedRosterFile(path)
    : undefined;
  if (crew !== undefined && samePath(encodedCrewRosterPathIn(env, crew, codecDir), path)) {
    return { crew, path, kind: 'encoded' };
  }

  const legacyCrew = legacyCrewNameForPath(root, path);
  return legacyCrew === undefined ? undefined : { crew: legacyCrew, path, kind: 'legacy' };
}

/**
 * Discover crew roster files for global doctor diagnostics. Routing never calls
 * this function: it directly probes only the requested crew's legacy and codec
 * targets, so an unrelated unreadable or racing subtree cannot refuse an
 * agent-run before settings and hub layers get a chance to participate.
 */
export function discoverCrewRosterFiles(env: Record<string, string | undefined>): CrewRosterFile[] {
  const root = crewRosterDir(env);
  if (!existsSync(root)) return [];
  const found: CrewRosterFile[] = [];

  const historicalDir = historicalEncodedCrewRosterDir(env);
  const encodedDir = encodedCrewRosterDir(env);

  // Literal/nested legacy files are independent of codec parsing. Keep both
  // codec directories out of this pass; each is considered below, where an
  // explicit owner distinguishes an encoded file from a shorter legacy entry.
  walkCrewRosterFiles(root, root, (path) => {
    const crew = legacyCrewNameForPath(root, path);
    if (crew !== undefined) found.push({ crew, path, kind: 'legacy' });
  }, new Set([HISTORICAL_CREW_ROSTER_ENCODED_DIR, CREW_ROSTER_ENCODED_DIR]));

  if (existsSync(historicalDir)) {
    walkCrewRosterFiles(historicalDir, historicalDir, (path) => {
      const file = classifyCodecDirectoryFile(env, root, historicalDir, path);
      if (file !== undefined) found.push(file);
    });
  }

  if (existsSync(encodedDir)) {
    walkCrewRosterFiles(encodedDir, encodedDir, (path) => {
      const file = classifyCodecDirectoryFile(env, root, encodedDir, path);
      if (file !== undefined) found.push(file);
    });
  }
  return found;
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
  const legacy = legacyCrewRosterPath(dir, crew);
  if (legacy !== undefined && existsSync(legacy)) return legacy;

  // Retain only historical files that declare this exact codec ownership.
  // A basename that merely decodes to `crew` can be a pre-upgrade nested
  // legacy crew, and must never be stolen from it.
  const historical = encodedCrewRosterPathIn(env, crew, historicalEncodedCrewRosterDir(env));
  if (existsSync(historical) && isOwnedCodecRoster(historical, crew)) return historical;

  const encoded = encodedCrewRosterPath(env, crew);
  // Probe the deterministic codec target even when corrupt: machineRosterLayers
  // must parse and fail closed rather than hiding a malformed strongest-layer
  // file behind an absent layer.
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
