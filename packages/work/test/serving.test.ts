import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { crewRosterPath } from '../src/settings/roster.ts';
import { writeHubRosterCache } from '../src/settings/hub-roster-cache.ts';
import { computeServeCapabilities } from '../src/settings/serving.ts';

const origin = 'https://hub.example';
const account = 'default';
const candidate = [{ harness: 'test', model: 'test-model', effort: 'high' }] as const;

function writeCrew(env: NodeJS.ProcessEnv, crew: string, roster: Record<string, unknown>): void {
	const path = crewRosterPath(env, crew);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ roster }));
}

function writeSettings(env: NodeJS.ProcessEnv, roster: Record<string, unknown>): void {
	const path = join(env.HOME!, '.owenloop', 'settings.json');
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ roster }));
}

function writeCache(
	env: NodeJS.ProcessEnv,
	crews: Array<{ crewName: string | null; roster: Record<string, unknown> }>,
	global: Record<string, unknown> = {},
): void {
	writeHubRosterCache(env, {
		version: 1,
		origin,
		orgId: 'org_1',
		orgName: 'Example',
		account,
		fetchedAt: 1,
		global: global as never,
		crews: crews.map((crew, index) => ({
			crewId: `crew_${index}`,
			crewName: crew.crewName,
			roster: crew.roster as never,
		})),
	});
}

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
	const home = mkdtempSync(join(tmpdir(), 'owenloop-serving-'));
	try {
		fn({ HOME: home });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

test('computeServeCapabilities unions named crews, de-duplicates, and sorts', () => {
	withHome((env) => {
		writeCrew(env, 'alpha', { build: candidate, shared: candidate });
		writeCrew(env, 'beta', { review: candidate, shared: candidate });

		assert.deepEqual(
			computeServeCapabilities({ env, crews: ['beta', 'alpha'], hub: { origin, account } }),
			['build', 'review', 'shared'],
		);
	});
});

test('computeServeCapabilities retains bare and exact roster keys verbatim', () => {
	withHome((env) => {
		writeSettings(env, { build: candidate, 'build:deep': candidate });

		assert.deepEqual(
			computeServeCapabilities({ env, crews: ['alpha'], hub: { origin, account } }),
			['build', 'build:deep'],
		);
	});
});

test('computeServeCapabilities includes crew-independent layers for every named crew', () => {
	withHome((env) => {
		writeSettings(env, { common: candidate });
		writeCrew(env, 'alpha', { alpha: candidate });

		assert.deepEqual(
			computeServeCapabilities({ env, crews: ['alpha', 'beta'], hub: { origin, account } }),
			['alpha', 'common'],
		);
	});
});

test('computeServeCapabilities discovers local crews for an all-crews shift', () => {
	withHome((env) => {
		writeCrew(env, 'alpha', { build: candidate });
		writeCrew(env, 'beta', { review: candidate });

		assert.deepEqual(
			computeServeCapabilities({ env, crews: [], hub: { origin, account } }),
			['build', 'review'],
		);
	});
});

test('computeServeCapabilities discovers hub-cache-only crews for an all-crews shift', () => {
	withHome((env) => {
		writeCache(env, [{ crewName: 'remote', roster: { inspect: candidate } }]);

		assert.deepEqual(
			computeServeCapabilities({ env, crews: [], hub: { origin, account } }),
			['inspect'],
		);
	});
});

test('computeServeCapabilities falls back to crew-independent layers when no crew is known', () => {
	withHome((env) => {
		writeSettings(env, { common: candidate });

		assert.deepEqual(
			computeServeCapabilities({ env, crews: [], hub: { origin, account } }),
			['common'],
		);
	});
});

test('computeServeCapabilities warns for a corrupt crew without blanking other crews', () => {
	withHome((env) => {
		writeCrew(env, 'good', { build: candidate });
		const bad = crewRosterPath(env, 'bad');
		mkdirSync(dirname(bad), { recursive: true });
		writeFileSync(bad, '{not json');
		const warnings: string[] = [];

		assert.deepEqual(
			computeServeCapabilities({
				env,
				crews: ['good', 'bad'],
				hub: { origin, account },
				warn: (message) => warnings.push(message),
			}),
			['build'],
		);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /bad/);
	});
});

test('computeServeCapabilities keeps machine layers when no hub origin is configured', () => {
	withHome((env) => {
		writeSettings(env, { local: candidate });

		assert.deepEqual(
			computeServeCapabilities({ env, crews: ['alpha'], hub: { origin: undefined, account } }),
			['local'],
		);
	});
});
