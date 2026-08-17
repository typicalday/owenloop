/**
 * Crew-roster disk layout and layered merge.
 *
 * This module owns where machine roster layers come from and their
 * strongest-first cascade. Shape validation and capability lookup remain in
 * `agent/capability-model.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/** Reversible, path-segment-safe filename codec for newly materialized crews. */
export function encodeCrewRosterFilename(crew: string): string {
  return `${CREW_ROSTER_FILENAME_PREFIX}${Buffer.from(crew, 'utf8').toString('base64url')}.json`;
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

/** Map a filename from either the reversible codec or the legacy layout to its crew. */
export function crewNameFromRosterFilename(filename: string): string | undefined {
  const decoded = decodeCrewRosterFilename(filename);
  if (decoded !== undefined) return decoded;
  return filename.endsWith('.json') ? filename.slice(0, -'.json'.length) : undefined;
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

/** A pre-codec file is safe to preserve only when its raw name is one segment. */
function legacyCrewRosterPath(dir: string, crew: string): string | undefined {
  if (crew.includes('/') || crew.includes('\\')) return undefined;
  return containedCrewPath(dir, `${crew}.json`);
}

/**
 * Resolve an untrusted crew name to one file beneath `crews/`, preserving a
 * pre-codec operator file when it exists. This makes an upgrade non-destructive
 * for names such as spaces, colons, percent signs, and Unicode; setup uses this
 * same resolver, so it cannot create an empty encoded duplicate over an existing
 * strongest-layer override.
 *
 * New files use `encodeCrewRosterFilename`; hub names are always data, never
 * path segments, and every target has an explicit containment proof.
 */
export function crewRosterPath(env: Record<string, string | undefined>, crew: string): string {
  const dir = crewRosterDir(env);
  const legacy = legacyCrewRosterPath(dir, crew);
  if (legacy !== undefined && existsSync(legacy)) return legacy;
  return containedCrewPath(dir, encodeCrewRosterFilename(crew));
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
