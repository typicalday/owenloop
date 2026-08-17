/**
 * Disk cache for the hub-owned (therefore weakest) roster layers.
 *
 * A shift daemon refreshes this file, while the short-lived `agent-run` child
 * reads it without contacting the hub. The cache intentionally has no TTL:
 * stale hub rows still lose to every machine-owned row, while rejecting an old
 * cache would turn an ordinary hub outage into an order refusal.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { type Roster, validateRoster } from '../agent/capability-model.ts';
import type { HubClient } from '../hub/client.ts';
import { owenloopConfigDir } from '../../../../src/config-dir.ts';
import { normalizeOrigin } from '../../../../src/hub.ts';
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

export const DEFAULT_HUB_ROSTER_SYNC_TIMEOUT_MS = 10_000;
const MAX_HUB_IDENTIFIER_LENGTH = 200;
const MAX_HUB_CAPABILITY_LENGTH = 64;
const MAX_HUB_CREW_LENGTH = 64;
const MAX_HUB_CANDIDATES = 32;
const HUB_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function isHubIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HUB_IDENTIFIER_LENGTH && value.trim() === value;
}

function isHubCapability(value: string): boolean {
  return value.length > 0 && value.length <= MAX_HUB_CAPABILITY_LENGTH && value.trim() === value && !value.startsWith('personal:');
}

function isHubCrewName(value: unknown): value is string {
  // Slash, backslash, and dot segments are valid hub data. The filesystem
  // resolver handles them later; this wire validator only mirrors the hub's
  // trimmed/non-empty/max-length crew rule.
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HUB_CREW_LENGTH && value.trim() === value;
}

function validateHubRoster(roster: Record<string, unknown>, context: string): Roster {
  validateRoster(roster, context);
  for (const [capability, candidates] of Object.entries(roster)) {
    if (!isHubCapability(capability)) throw new Error(`${context}: invalid capability`);
    if (!Array.isArray(candidates) || candidates.length > MAX_HUB_CANDIDATES) {
      throw new Error(`${context}: invalid candidate count`);
    }
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const row = candidate as Record<string, unknown>;
      if (!isHubIdentifier(row['harness']) || !isHubIdentifier(row['model']) || !HUB_EFFORTS.has(row['effort'] as string)) {
	throw new Error(`${context}: invalid candidate`);
      }
      const key = JSON.stringify([row['harness'], row['model'], row['effort']]);
      if (seen.has(key)) throw new Error(`${context}: duplicate candidate`);
      seen.add(key);
    }
  }
  return roster as Roster;
}

/** Bound a refresh even when a test seam or non-fetch client ignores abort. */
export async function withHubRosterSyncTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_HUB_ROSTER_SYNC_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`hub roster sync timed out after ${timeoutMs}ms`);
      // Abort carries the same terminal error so an abort-aware transport and
      // the explicit race report one stable, useful timeout outcome.
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A composite refresh can reject as soon as one request fails while a
    // sibling fetch is still waiting. Always cancel on settlement so that
    // sibling cannot outlive this refresh (and accumulate across polls).
    if (!controller.signal.aborted) controller.abort(new Error('hub roster sync finished'));
  }
}

export function hubRosterCacheDir(env: Env): string {
  return join(owenloopConfigDir(env), 'hub-rosters');
}

/** A filename is an index only; readers always verify the fields inside it. */
export function sanitizeOriginForFilename(origin: string): string {
  return origin.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
}

/** Org ids are hub data, so they are filename-encoded rather than interpolated. */
export function sanitizeOrgIdForFilename(orgId: string): string {
  return encodeURIComponent(orgId);
}

/**
 * An on-disk cache key must be injective, not merely path-safe. The historical
 * origin sanitizer remains exported for diagnostics/backward compatibility,
 * but it deliberately cannot be the key: distinct origins can sanitize to the
 * same string. A fixed-size digest avoids both those collisions and a
 * filesystem component overflow for a valid long origin. The file body is
 * still fully parsed and matched, so the digest is only an index.
 */
function cacheKey(origin: string, orgId: string, account: string): string {
  return createHash('sha256')
    .update(origin, 'utf8')
    .update('\0', 'utf8')
    .update(orgId, 'utf8')
    .update('\0', 'utf8')
    .update(account, 'utf8')
    .digest('base64url');
}

function containedChildPath(dir: string, filename: string): string {
  const root = resolve(dir);
  const path = resolve(root, filename);
  const fromRoot = relative(root, path);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`unsafe hub roster cache path for ${JSON.stringify(filename)}`);
  }
  return path;
}

export function hubRosterCachePath(env: Env, origin: string, orgId: string, account = 'default'): string {
  const canonicalOrigin = normalizeOrigin(origin);
  return containedChildPath(
    hubRosterCacheDir(env),
    `cache-v1--${cacheKey(canonicalOrigin, orgId, account)}.json`,
  );
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
  for (const key of ['origin', 'orgId', 'account'] as const) {
    if (typeof row[key] !== 'string' || row[key].trim() === '') throw new Error(`invalid cache ${key}`);
  }
  // The deployed whoami/roster contract permits an unnamed organization. Do
  // not turn its deliberate empty display name into a failed cache refresh.
  if (typeof row['orgName'] !== 'string') throw new Error('invalid cache orgName');
  let origin: string;
  try {
    origin = normalizeOrigin(row['origin'] as string);
  } catch (error) {
    throw new Error(`invalid cache origin: ${message(error)}`);
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
    validateHubRoster(global, 'global');
    for (const [index, rawCrew] of crews.entries()) {
      const crew = asRecord(rawCrew);
      if (crew === undefined || typeof crew['crewId'] !== 'string' || crew['crewId'] === '' ||
	  !(isHubCrewName(crew['crewName']) || crew['crewName'] === null)) {
	throw new Error(`crews[${index}] must have crewId and crewName`);
      }
      const roster = asRecord(crew['roster']);
      if (roster === undefined) throw new Error(`crews[${index}].roster must be an object`);
      validateHubRoster(roster, `crews[${index}].roster`);
    }
  } catch (error) {
    throw new Error(`invalid roster shape: ${message(error)}`);
  }
  return {
    version: 1,
    origin,
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

export interface HubRosterCacheWriteOptions {
  /** Test seam for an unlink failure after the new snapshot has landed. */
  remove?: (path: string) => void;
  /** Test seam; the production default makes concurrent writers distinct. */
  tempSuffix?: () => string;
}

/** Atomically write a verified snapshot, then drop a prior org snapshot for
 * the same origin/account pair so a re-pointed token cannot be served stale. */
export function writeHubRosterCache(
  env: Env,
  entry: HubRosterCacheEntry,
  options: HubRosterCacheWriteOptions = {},
): void {
  const verified = parseEntry(entry);
  const dir = hubRosterCacheDir(env);
  mkdirSync(dir, { recursive: true });
  // Account is part of the key as well as the reader's validity predicate:
  // two agent accounts can be attached to the same hub org concurrently.
  const path = hubRosterCachePath(env, verified.origin, verified.orgId, verified.account);
  const temp = `${path}.${(options.tempSuffix ?? randomUUID)()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(verified, null, 2)}\n`, 'utf8');
  renameSync(temp, path);

  for (const name of readdirSync(dir)) {
    const sibling = join(dir, name);
    if (sibling === path || !name.endsWith('.json')) continue;
    let other: HubRosterCacheEntry;
    try {
      other = parseEntry(JSON.parse(readFileSync(sibling, 'utf8')) as unknown);
    } catch {
      // A malformed unrelated file stays visible to an operator; it cannot make
      // a successful new snapshot fail.
      continue;
    }
    if (other.origin === verified.origin && other.account === verified.account && other.orgId !== verified.orgId) {
      // Deliberately outside the parse catch. Once the new snapshot has landed,
      // a failed prune must surface to the caller rather than masquerading as a
      // completed repoint; readers still select the newer valid file below.
      (options.remove ?? ((candidate: string) => rmSync(candidate)))(sibling);
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
  let expectedOrigin: string;
  try {
    expectedOrigin = normalizeOrigin(origin);
  } catch (error) {
    return { kind: 'miss', path: dir, reason: `invalid cache origin: ${message(error)}` };
  }
  let firstReason: string | undefined;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    return { kind: 'miss', path: dir, reason: `unreadable cache directory: ${message(error)}` };
  }
  if (names.length === 0) return { kind: 'miss', path: dir, reason: `no cache file at ${dir}` };
  let newest: Extract<HubRosterCacheRead, { kind: 'hit' }> | undefined;
  for (const name of names) {
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
      firstReason ??= `unreadable JSON: ${message(error)}`;
      continue;
    }
    let entry: HubRosterCacheEntry;
    try {
      entry = parseEntry(raw);
    } catch (error) {
      const detail = message(error);
      firstReason ??= detail.startsWith('unsupported cache version') || detail.startsWith('invalid roster shape:')
	? detail
	: `invalid roster shape: ${detail}`;
      continue;
    }
    if (entry.origin !== expectedOrigin) {
      firstReason ??= `cache is for origin ${entry.origin}, expected ${expectedOrigin}`;
      continue;
    }
    if (entry.account !== account) {
      firstReason ??= `cache is for account ${entry.account}, expected ${account}`;
      continue;
    }
    if (
      newest === undefined ||
      entry.fetchedAt > newest.data.fetchedAt ||
      (entry.fetchedAt === newest.data.fetchedAt && path < newest.path)
    ) {
      newest = { kind: 'hit', path, data: entry };
    }
  }
  if (newest !== undefined) return newest;
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
  signal?: AbortSignal;
}): Promise<void> {
  if (deps.client.getRosters === undefined) throw new Error('hub client does not support get_rosters');
  const [identity, rosters] = await Promise.all([deps.client.whoami(deps.signal), deps.client.getRosters(deps.signal)]);
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
