/**
 * Disk cache for the hub-owned (therefore weakest) roster layers.
 *
 * A shift daemon refreshes this file, while the short-lived `agent-run` child
 * reads it without contacting the hub. The cache intentionally has no TTL:
 * stale hub rows still lose to every machine-owned row, while rejecting an old
 * cache would turn an ordinary hub outage into an order refusal.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Roster, validateRoster } from '../agent/capability-model.ts';
import type { HubClient } from '../hub/client.ts';
import { owenloopConfigDir } from '../../../../src/config-dir.ts';
import type { RosterLayer } from './roster.ts';

export interface HubRosterCacheCrew {
  crewId: string;
  crewName: string | null;
  roster: Roster;
}

export interface HubRosterCacheEntry {
  version: 1;
  origin: string;
  orgId: string;
  orgName: string;
  account: string;
  fetchedAt: number;
  global: Roster;
  crews: HubRosterCacheCrew[];
}

export type HubRosterCacheRead =
  | { kind: 'hit'; path: string; data: HubRosterCacheEntry }
  | { kind: 'miss'; path: string; reason: string };

type Env = Record<string, string | undefined>;

export function hubRosterCacheDir(env: Env): string {
  return join(owenloopConfigDir(env), 'hub-rosters');
}

/** A filename is an index only; readers always verify the fields inside it. */
export function sanitizeOriginForFilename(origin: string): string {
  return origin.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
}

export function hubRosterCachePath(env: Env, origin: string, orgId: string): string {
  return join(hubRosterCacheDir(env), `${sanitizeOriginForFilename(origin)}--${orgId}.json`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Decode and validate every field readers rely on. It deliberately throws so
 * `readHubRosterCache` can turn each failure into a non-throwing miss. */
function parseEntry(value: unknown): HubRosterCacheEntry {
  const row = asRecord(value);
  if (row === undefined) throw new Error('cache root must be an object');
  if (row['version'] !== 1) throw new Error(`unsupported cache version ${String(row['version'])}`);
  for (const key of ['origin', 'orgId', 'orgName', 'account'] as const) {
    if (typeof row[key] !== 'string' || row[key].trim() === '') throw new Error(`invalid cache ${key}`);
  }
  if (typeof row['fetchedAt'] !== 'number' || !Number.isFinite(row['fetchedAt'])) {
    throw new Error('invalid cache fetchedAt');
  }
  // `Date` accepts finite values outside its TimeClip range, but `toISOString`
  // then throws. The timestamp is displayed while constructing hub layers, so
  // make that display operation part of cache validation rather than letting a
  // corrupt disk cache escape the deliberately non-throwing reader.
  try {
    new Date(row['fetchedAt']).toISOString();
  } catch {
    throw new Error('invalid cache fetchedAt');
  }
  const global = asRecord(row['global']);
  if (global === undefined) throw new Error('invalid roster shape: global must be an object');
  const crews = row['crews'];
  if (!Array.isArray(crews)) throw new Error('invalid roster shape: crews must be an array');
  try {
    validateRoster(global, 'global');
    for (const [index, rawCrew] of crews.entries()) {
      const crew = asRecord(rawCrew);
      if (crew === undefined || typeof crew['crewId'] !== 'string' ||
	  !(typeof crew['crewName'] === 'string' || crew['crewName'] === null)) {
	throw new Error(`crews[${index}] must have crewId and crewName`);
      }
      const roster = asRecord(crew['roster']);
      if (roster === undefined) throw new Error(`crews[${index}].roster must be an object`);
      validateRoster(roster, `crews[${index}].roster`);
    }
  } catch (error) {
    throw new Error(`invalid roster shape: ${message(error)}`);
  }
  return {
    version: 1,
    origin: row['origin'] as string,
    orgId: row['orgId'] as string,
    orgName: row['orgName'] as string,
    account: row['account'] as string,
    fetchedAt: row['fetchedAt'] as number,
    global: global as Roster,
    crews: crews.map((raw) => {
      const crew = raw as Record<string, unknown>;
      return { crewId: crew['crewId'] as string, crewName: crew['crewName'] as string | null, roster: crew['roster'] as Roster };
    }),
  };
}

/** Atomically write a verified snapshot, then drop a prior org snapshot for
 * the same origin/account pair so a re-pointed token cannot be served stale. */
export function writeHubRosterCache(env: Env, entry: HubRosterCacheEntry): void {
  const verified = parseEntry(entry);
  const dir = hubRosterCacheDir(env);
  mkdirSync(dir, { recursive: true });
  const path = hubRosterCachePath(env, verified.origin, verified.orgId);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(verified, null, 2)}\n`, 'utf8');
  renameSync(temp, path);

  for (const name of readdirSync(dir)) {
    const sibling = join(dir, name);
    if (sibling === path || !name.endsWith('.json')) continue;
    try {
      const other = parseEntry(JSON.parse(readFileSync(sibling, 'utf8')) as unknown);
      if (other.origin === verified.origin && other.account === verified.account && other.orgId !== verified.orgId) rmSync(sibling);
    } catch {
      // A malformed unrelated file stays visible to an operator; it cannot make
      // a successful new snapshot fail.
    }
  }
}

/**
 * Find a cache by the information an offline child actually has (origin plus
 * account), never by trusting its filename. Every bad cache state degrades to
 * a miss; this is deliberately the opposite of `readCrewRoster`.
 */
export function readHubRosterCache(env: Env, origin: string, account: string): HubRosterCacheRead {
  const dir = hubRosterCacheDir(env);
  if (!existsSync(dir)) return { kind: 'miss', path: dir, reason: `no cache file at ${dir}` };
  let firstReason: string | undefined;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    return { kind: 'miss', path: dir, reason: `unreadable cache directory: ${message(error)}` };
  }
  if (names.length === 0) return { kind: 'miss', path: dir, reason: `no cache file at ${dir}` };
  for (const name of names) {
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
      firstReason ??= `unreadable JSON: ${message(error)}`;
      continue;
    }
    const row = asRecord(raw);
    if (row !== undefined && typeof row['origin'] === 'string' && row['origin'] !== origin) {
      firstReason ??= `cache is for origin ${row['origin']}, expected ${origin}`;
      continue;
    }
    if (row !== undefined && typeof row['account'] === 'string' && row['account'] !== account) {
      firstReason ??= `cache is for account ${row['account']}, expected ${account}`;
      continue;
    }
    if (row !== undefined && row['version'] !== 1) {
      firstReason ??= `unsupported cache version ${String(row['version'])}`;
      continue;
    }
    try {
      const entry = parseEntry(raw);
      return { kind: 'hit', path, data: entry };
    } catch (error) {
      const detail = message(error);
      firstReason ??= detail.startsWith('unsupported cache version') || detail.startsWith('invalid roster shape:')
	? detail
	: `invalid roster shape: ${detail}`;
    }
  }
  return { kind: 'miss', path: dir, reason: firstReason ?? `no cache file at ${dir}` };
}

function sourceWithFetch(prefix: string, entry: HubRosterCacheEntry): string {
  return `${prefix} (org ${entry.orgName}, fetched ${new Date(entry.fetchedAt).toISOString()})`;
}

/** The hub's two layers, strongest first. Missing cache remains visible as
 * absent layers, so `roster show` can explain an offline child's routing. */
export function hubRosterLayers(read: HubRosterCacheRead, crew: string | undefined): RosterLayer[] {
  if (read.kind === 'miss') {
    const unavailable = (label: string): RosterLayer => ({ source: `${label} (unavailable: ${read.reason})`, path: read.path });
    return crew === undefined
      ? [unavailable('hub org-global')]
      : [unavailable(`hub crew ${crew}`), unavailable('hub org-global')];
  }
  const layers: RosterLayer[] = [];
  if (crew !== undefined) {
    const match = read.data.crews.find((candidate) => candidate.crewName === crew);
    layers.push(match === undefined
      ? { source: `hub crew ${crew} — no hub roster for this crew (org ${read.data.orgName}, fetched ${new Date(read.data.fetchedAt).toISOString()})`, path: read.path }
      : { source: sourceWithFetch(`hub crew ${crew}`, read.data), path: read.path, roster: match.roster });
  }
  layers.push({ source: sourceWithFetch('hub org-global', read.data), path: read.path, roster: read.data.global });
  return layers;
}

/** Refresh the disk snapshot with the same agent credential a shift uses. */
export async function syncHubRosterCache(deps: {
  client: HubClient;
  env: Env;
  origin: string;
  account: string;
}): Promise<void> {
  if (deps.client.getRosters === undefined) throw new Error('hub client does not support get_rosters');
  const [identity, rosters] = await Promise.all([deps.client.whoami(), deps.client.getRosters()]);
  writeHubRosterCache(deps.env, {
    version: 1,
    origin: deps.origin,
    orgId: identity.orgId,
    orgName: identity.orgName,
    account: deps.account,
    fetchedAt: Date.now(),
    global: rosters.global,
    crews: rosters.crews,
  });
}
