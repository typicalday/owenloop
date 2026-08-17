/**
 * `owenloop doctor` — the read-only probe of the five install surfaces plus the
 * (non-fatal) Claude Code and Codex plugin checks, driven through `mainAsync` against `makeIdentityHub`.
 * Each ✗ path is asserted on its DISTINGUISHING substring so the wording stays
 * pairwise-distinct. The all-green case additionally asserts a strict zero-write
 * (the store is byte-identical after the run — fresh tokens, so no refresh).
 *
 * `assertNoOlp(t)` ends every test: no `olp_` token may reach stdout/stderr.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { kcHuman, kcKey, makeIdentityHub, makeIo, routedFetch } from './hubkit.ts';
import { owenloopSettingsPath } from '../src/work-settings.ts';
import { crewRosterPath, encodedCrewRosterDir, encodeCrewRosterFilename } from '../packages/work/src/settings/roster.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** Seed a fresh, non-expiring human oauth credential. */
function seedHuman(store: Map<string, string>): void {
  store.set(
    kcHuman(ORIGIN),
    JSON.stringify({ kind: 'oauth', accessToken: 'mcpat_seeded', refreshToken: 'rt_seeded', expiresAt: Date.now() + 3_600_000, clientId: 'client-abc' }),
  );
}

/** Seed an expired human oauth credential (forces a refresh attempt). */
function seedExpiredHuman(store: Map<string, string>): void {
  store.set(
    kcHuman(ORIGIN),
    JSON.stringify({ kind: 'oauth', accessToken: 'mcpat_stale', refreshToken: 'rt_stale', expiresAt: Date.now() - 10_000, clientId: 'client-abc' }),
  );
}

/** Seed a local agent slot holding `plaintext`. */
function seedAgentSlot(store: Map<string, string>, account: string, plaintext: string): void {
  store.set(kcKey(ORIGIN, { principal: 'agent', account }), JSON.stringify({ kind: 'agent', accessToken: plaintext }));
}

/** Write an owenloop settings file with the given hubOrigin under `env`'s HOME. */
function writeSettings(env: Record<string, string | undefined>, hubOrigin: string): void {
  const path = owenloopSettingsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ hubOrigin }));
}

/** A PATH fixture dir with executable harness stubs; PATH scans never execute these files. */
function pathDir(withClaude: boolean, withCodex = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-doctor-path-'));
  if (withClaude) writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (withCodex) writeFileSync(join(dir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

test('doctor: empty store → ✗ human credential none stored, exit 1', async () => {
  const { fetch } = routedFetch({});
  const t = makeIo({ fetch, env: { PATH: pathDir(false) } });

  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 1);
  assert.match(t.err.join('\n'), /human credential: none stored for/);
  assertNoOlpErr(t);
});

test('doctor: expired human oauth + refresh 400 → ✗ irrecoverable (refresh failed), distinct from "none stored"', async () => {
  const { routes, state } = makeIdentityHub();
  state.refreshGrantStatus = 400;
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, env: { PATH: pathDir(false) } });
  seedExpiredHuman(t.store);

  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 1);
  const err = t.err.join('\n');
  assert.match(err, /irrecoverable \(refresh failed\)/);
  assert.doesNotMatch(err, /none stored/, 'distinct from the missing-credential wording');
  assertNoOlpErr(t);
});

test('doctor: valid human + agent but settings hubOrigin mismatch → ✗ names both origins, exit 1', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_live' } }] });
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, env: { PATH: pathDir(true) }, runCommand: () => ({ status: 0, stdout: 'owenloop@owenloop', stderr: '' }) });
  seedHuman(t.store);
  seedAgentSlot(t.store, 'worker', 'olp_live');
  writeSettings(t.io.env, 'http://other');

  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 1);
  const err = t.err.join('\n');
  assert.match(err, /hubOrigin is http:\/\/other, expected http:\/\/127\.0\.0\.1:9/, 'names both origins');
  assertNoOlpErr(t);
});

test('doctor: plugin missing is NON-FATAL — ✗ plugin line but exit 0, in both binary-absent and not-installed variants', async () => {
  // (a) claude not on PATH.
  {
    const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_live' } }] });
    const { fetch } = routedFetch(routes);
    const t = makeIo({ fetch, env: { PATH: pathDir(false) } });
    seedHuman(t.store);
    seedAgentSlot(t.store, 'worker', 'olp_live');
    writeSettings(t.io.env, ORIGIN);

    assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.match(t.err.join('\n'), /plugin \(claude-code\): Claude Code \(claude\) not on PATH/);
    assertNoOlpErr(t);
  }

  // (b) claude present, plugin list lacks owenloop.
  {
    const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_live' } }] });
    const { fetch } = routedFetch(routes);
    const t = makeIo({ fetch, env: { PATH: pathDir(true) }, runCommand: () => ({ status: 0, stdout: '[]', stderr: '' }) });
    seedHuman(t.store);
    seedAgentSlot(t.store, 'worker', 'olp_live');
    writeSettings(t.io.env, ORIGIN);

    assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.match(t.err.join('\n'), /plugin \(claude-code\): not installed/);
    assertNoOlpErr(t);
  }
});

test('doctor: agent slot present but hub 401s the token → ✗ revoked or invalid, distinct from missing-slot wording', async () => {
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, env: { PATH: pathDir(false) } });
  seedHuman(t.store);
  seedAgentSlot(t.store, 'default', 'olp_stale_unknown'); // not a live token in the fake → whoami 401
  writeSettings(t.io.env, ORIGIN);

  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 1);
  const err = t.err.join('\n');
  assert.match(err, /agent (token )?revoked or invalid/);
  assert.doesNotMatch(err, /no agent credential stored/, 'distinct from the missing-slot wording');
  assertNoOlpErr(t);
});

test('doctor: all green → every line ✓, exit 0, and a strict zero-write', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_live' } }] });
  const { fetch } = routedFetch(routes);
  const t = makeIo({
    fetch,
    env: { PATH: pathDir(true, true) },
    runCommand: (cmd, args) => {
      if (args[0] === '--version') {
        return {
          status: 0,
          stdout: cmd === 'claude' ? '2.1.222 (Claude Code)\nUpdate available: 2.2.0\n' : 'codex-cli 0.146.0\n',
          stderr: '',
        };
      }
      if (cmd === 'claude') {
        return { status: 0, stdout: JSON.stringify([{ id: 'owenloop@owenloop', version: PACKAGE_VERSION }]), stderr: '' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ installed: [{ pluginId: 'owenloop@owenloop', version: PACKAGE_VERSION, installed: true }], available: [] }),
        stderr: '',
      };
    },
  });
  seedHuman(t.store);
  seedAgentSlot(t.store, 'worker', 'olp_live');
  writeSettings(t.io.env, ORIGIN);

  const before = [...t.store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 0, t.err.join('\n'));

  const err = t.err.join('\n');
  assert.doesNotMatch(err, /✗/, 'no failing check lines');
  for (const label of [
    'human credential',
    'human plane',
    'agent slot',
    'agent plane',
    'owenloop settings',
    'plugin (claude-code)',
    'plugin (codex)',
  ]) {
    assert.ok(err.includes(`✓ ${label}`), `${label} passed`);
  }
  assert.ok(err.includes(`✓ plugin (claude-code): owenloop ${PACKAGE_VERSION} · claude 2.1.222 (Claude Code)`));
  assert.ok(err.includes(`✓ plugin (codex): owenloop ${PACKAGE_VERSION} · codex codex-cli 0.146.0`));
  assert.doesNotMatch(err, /Update available: 2\.2\.0/, 'only the first CLI version output line is reported');

  assert.deepEqual([...t.store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), before, 'doctor performed no writes');
  assertNoOlpErr(t);
});

test('doctor keeps a codec-looking legacy crew literal and separately inspects the encoded crew', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: ['ops'], token: { plaintext: 'olp_live' } }] });
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, env: { PATH: pathDir(false) } });
  seedHuman(t.store);
  seedAgentSlot(t.store, 'worker', 'olp_live');
  writeSettings(t.io.env, ORIGIN);

  const delivery = 'delivery';
  const literalLegacyCrew = encodeCrewRosterFilename(delivery).slice(0, -'.json'.length);
  const legacyPath = join(t.io.env.HOME!, '.owenloop', 'crews', `${literalLegacyCrew}.json`);
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, JSON.stringify({ roster: {} }));
  const encodedPath = crewRosterPath(t.io.env, delivery);
  mkdirSync(dirname(encodedPath), { recursive: true });
  writeFileSync(encodedPath, JSON.stringify({ roster: {} }));

  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 0, t.err.join('\n'));
  const err = t.err.join('\n');
  assert.match(err, /crew roster \(delivery\)/u);
  assert.ok(err.includes(`crew roster (${literalLegacyCrew})`));
  assert.doesNotMatch(err, /%253A/u, 'diagnostics never encode an already encoded-looking legacy name twice');
  assertNoOlpErr(t);
});

test('doctor seeds verified agent crews so a malformed bounded-hash roster is reported', async () => {
  const crew = `../${'語'.repeat(61)}`;
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: [crew], token: { plaintext: 'olp_live' } }] });
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, env: { PATH: pathDir(false) } });
  seedHuman(t.store);
  seedAgentSlot(t.store, 'worker', 'olp_live');
  writeSettings(t.io.env, ORIGIN);

  const path = crewRosterPath(t.io.env, crew);
  assert.match(path, /crew-hex-hash--/u);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{"crew":');

  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 0, t.err.join('\n'));
  const err = t.err.join('\n');
  assert.ok(err.includes(`✗ crew roster (${crew}): invalid crew roster at ${path}`), 'doctor reports the same malformed strongest-layer target agent-run would fail closed on');
  assertNoOlpErr(t);
});

test('doctor reports a boundary-length legacy roster inside the reserved codec directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-doctor-codec-boundary-'));
  const codecDir = encodedCrewRosterDir({ HOME: home });
  const crew = `${basename(codecDir)}/x`;
  assert.equal(crew.length, 64, 'the legacy spelling is within the hub crew-name limit');
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', crews: [crew], token: { plaintext: 'olp_live' } }] });
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch, env: { HOME: home, PATH: pathDir(false) } });
  seedHuman(t.store);
  seedAgentSlot(t.store, 'worker', 'olp_live');
  writeSettings(t.io.env, ORIGIN);

  const path = join(codecDir, 'x.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ roster: {} }));
  assert.equal(crewRosterPath(t.io.env, crew), path);

  assert.equal(await mainAsync(['doctor', '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.ok(t.err.join('\n').includes(`✓ crew roster (${crew})`));
  assertNoOlpErr(t);
});

/** doctor prints its report to stderr and a JSON summary to stdout — scan both for leaks. */
function assertNoOlpErr(t: { out: string[]; err: string[] }): void {
  assert.doesNotMatch([...t.out, ...t.err].join('\n'), /olp_/, 'no olp_ token on stdout/stderr');
}
