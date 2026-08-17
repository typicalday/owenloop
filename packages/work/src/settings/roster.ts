/**
 * Crew-roster disk layout and layered merge.
 *
 * This module owns where machine roster layers come from and their
 * strongest-first cascade. Shape validation and capability lookup remain in
 * `agent/capability-model.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * The machine's layers for one crew, strongest first. When no crew is known,
 * only the machine-global `settings.json` roster participates.
 */
export function machineRosterLayers(
  env: Record<string, string | undefined>,
  crew: string | undefined,
): RosterLayer[] {
  const configDir = owenloopConfigDir(env);
  const layers: RosterLayer[] = [];
  if (crew !== undefined) {
    const path = join(configDir, 'crews', `${crew}.json`);
    layers.push({
      source: `machine crews/${crew}.json`,
      path,
      ...(existsSync(path) ? { roster: readCrewRoster(path) } : {}),
    });
  }
  const path = join(configDir, 'settings.json');
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
