/**
 * The capability keys a shift can advertise from its effective roster layers.
 *
 * This is deliberately advisory: roster resolution and authorization remain
 * with the worker. A broken local roster must never stop a shift's poll loop.
 */
import { discoverCrewRosterFiles, effectiveRosterLayers, mergeRosterLayers } from './roster.ts';
import { readHubRosterCache } from './hub-roster-cache.ts';

type Env = NodeJS.ProcessEnv;
type Hub = { origin: string | undefined; account: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function servingSetForCrewUnsafe(env: Env, crew: string | undefined, hub: Hub): string[] {
	return Object.keys(mergeRosterLayers(effectiveRosterLayers(env, crew, hub)));
}

/** The capability keys one crew's effective merged roster serves. Never throws. */
export function servingSetForCrew(env: Env, crew: string | undefined, hub: Hub): string[] {
	try {
		return servingSetForCrewUnsafe(env, crew, hub).sort();
	} catch {
		return [];
	}
}

/** The union across every crew the shift serves. Never throws. */
export function computeServeCapabilities(opts: {
	env: Env;
	/** The shift's live serve crews. EMPTY MEANS ALL CREWS, never none. */
	crews: readonly string[];
	hub: Hub;
	/** One line per unreadable crew. Optional; default no-op. */
	warn?: (message: string) => void;
}): string[] {
	const warn = opts.warn ?? (() => {});
	const scopes = new Set<string>();

	if (opts.crews.length > 0) {
		for (const crew of opts.crews) scopes.add(crew);
	} else {
		try {
			for (const file of discoverCrewRosterFiles(opts.env)) scopes.add(file.crew);
		} catch (error) {
			warn(`could not discover local crew rosters: ${errorMessage(error)}`);
		}
		if (opts.hub.origin !== undefined && opts.hub.origin.trim() !== '') {
			const cached = readHubRosterCache(opts.env, opts.hub.origin, opts.hub.account);
			if (cached.kind === 'hit') {
				for (const crew of cached.data.crews) {
					if (crew.crewName !== null) scopes.add(crew.crewName);
				}
			}
		}
	}

	const result = new Set<string>();
	const targets: Array<string | undefined> = scopes.size === 0 ? [undefined] : [...scopes];
	for (const crew of targets) {
		try {
			for (const capability of servingSetForCrewUnsafe(opts.env, crew, opts.hub)) result.add(capability);
		} catch (error) {
			warn(`could not compute serving capabilities for ${crew === undefined ? 'crew-independent layers' : JSON.stringify(crew)}: ${errorMessage(error)}`);
		}
	}
	return [...result].sort();
}
