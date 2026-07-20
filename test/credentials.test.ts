/**
 * `readStoredCredential` — the public, read-only credential surface exported
 * from the package root, now keyed by SLOT (`human` / `agent:<account>`).
 * Exercises both backends (injected fake keychain and the 0600 file store under
 * a fixture `$HOME`), slot isolation, account defaulting and validation, the
 * REL-6 no-fallback rule, backend precedence, origin normalization, the
 * corrupt-entry-reads-as-absent guard, the deliberate invisibility of entries
 * written under the OLD one-slot-per-origin keying, the OPTIONAL external
 * credential command that sits in front of both stores, and that the exports +
 * their types resolve from the barrel (`src/index.ts`).
 *
 * Hermetic per project rule: every test materializes its own `$HOME` fixture
 * (mkdtemp) and either injects the fake keychain or forces the file backend
 * with `OWENLOOP_NO_KEYCHAIN=1` — never the developer's real keychain, never
 * their real `~/.config`, and never platform-dependent (`defaultKeychain` is
 * `undefined` off macOS, so backend choice here is always forced by injection
 * or the env flag, not by the runner's OS). The external-command tests hold to
 * the same bar: each writes its own helper script into its own temp dir and
 * invokes it through `process.execPath`, so nothing depends on the runner's
 * `PATH` or on any installed binary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialBackend,
  credentialFilePath,
  credentialSlot,
  externalCredentialCommand,
  keychainServiceFor,
  normalizeOrigin,
  readStoredCredential,
  writeCredentialFile,
} from '../src/hub.ts';
import type { Credential, CredentialSlotSelector } from '../src/hub.ts';
import { fakeKeychain } from './hubkit.ts';
// Consumer-style import of the package root, exactly as an external consumer resolves it.
import * as pub from '../src/index.ts';
// Type-level proof that the barrel re-exports `Credential` (typecheck fails if not).
import type { Credential as BarrelCredential, CredentialSlotSelector as BarrelSelector } from '../src/index.ts';

const ORIGIN = 'https://hub.example.com';
const KEY = normalizeOrigin(ORIGIN);
const CRED: Credential = { kind: 'agent', accessToken: 'olp_x' };

const HUMAN: CredentialSlotSelector = { principal: 'human' };
const AGENT: CredentialSlotSelector = { principal: 'agent' };
const AGENT_CI: CredentialSlotSelector = { principal: 'agent', account: 'ci' };

/** A fixture env with an isolated `$HOME`; opts merge on top (e.g. the NO_KEYCHAIN flag). */
function fixtureEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-home-'));
  return { HOME: home, ...extra };
}

/** Seed the keychain-backed store for `(origin, slot)`, mirroring what the CLI writes. */
function seedKeychain(kc: pub.Keychain, origin: string, slot: CredentialSlotSelector, cred: Credential): void {
  kc.set(keychainServiceFor(origin), credentialSlot(slot), JSON.stringify(cred));
}

/** Seed the file-backed store with a whole origin → slot → credential map. */
function seedFile(
  env: Record<string, string | undefined>,
  hubs: Record<string, Record<string, Credential>>,
): void {
  writeCredentialFile(credentialFilePath(env), { version: 2, hubs });
}

// ---- slot round-trips, both backends ----------------------------------------

const SLOT_CASES: [string, CredentialSlotSelector][] = [
  ['human', HUMAN],
  ['agent:default', AGENT],
  ['agent:custom', { principal: 'agent', account: 'custom' }],
];

for (const [label, slot] of SLOT_CASES) {
  test(`keychain backend: round-trips the ${label} slot`, () => {
    const env = fixtureEnv();
    const { keychain } = fakeKeychain();
    const cred: Credential = { kind: 'agent', accessToken: `olp_${label}` };
    seedKeychain(keychain, KEY, slot, cred);
    assert.deepEqual(readStoredCredential(ORIGIN, { ...slot, env, keychain }), cred);
    // Deleting the slot makes it absent again.
    keychain.delete(keychainServiceFor(KEY), credentialSlot(slot));
    assert.equal(readStoredCredential(ORIGIN, { ...slot, env, keychain }), null);
  });

  test(`file backend: round-trips the ${label} slot`, () => {
    const env = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
    const cred: Credential = { kind: 'agent', accessToken: `olp_${label}` };
    assert.equal(readStoredCredential(ORIGIN, { ...slot, env }), null);
    seedFile(env, { [KEY]: { [credentialSlot(slot)]: cred } });
    assert.deepEqual(readStoredCredential(ORIGIN, { ...slot, env }), cred);
    seedFile(env, { [KEY]: {} });
    assert.equal(readStoredCredential(ORIGIN, { ...slot, env }), null);
  });
}

test('two agent accounts on the same origin do not collide (both backends)', () => {
  const ciCred: Credential = { kind: 'agent', accessToken: 'olp_ci' };
  const relCred: Credential = { kind: 'agent', accessToken: 'olp_release' };
  const REL: CredentialSlotSelector = { principal: 'agent', account: 'release' };

  const kcEnv = fixtureEnv();
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, AGENT_CI, ciCred);
  seedKeychain(keychain, KEY, REL, relCred);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...AGENT_CI, env: kcEnv, keychain }), ciCred);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...REL, env: kcEnv, keychain }), relCred);

  const fileEnv = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
  seedFile(fileEnv, { [KEY]: { 'agent:ci': ciCred, 'agent:release': relCred } });
  assert.deepEqual(readStoredCredential(ORIGIN, { ...AGENT_CI, env: fileEnv }), ciCred);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...REL, env: fileEnv }), relCred);
});

test('human and agent:default on the same origin do not collide (both backends)', () => {
  const humanCred: Credential = { kind: 'oauth-pasted', accessToken: 'mcpat_human' };
  const agentCred: Credential = { kind: 'agent', accessToken: 'olp_agent' };

  const kcEnv = fixtureEnv();
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, HUMAN, humanCred);
  seedKeychain(keychain, KEY, AGENT, agentCred);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env: kcEnv, keychain }), humanCred);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...AGENT, env: kcEnv, keychain }), agentCred);

  const fileEnv = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
  seedFile(fileEnv, { [KEY]: { human: humanCred, 'agent:default': agentCred } });
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env: fileEnv }), humanCred);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...AGENT, env: fileEnv }), agentCred);
});

test('account defaulting: { principal: agent } and { account: "default" } address the same slot', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, { principal: 'agent', account: 'default' }, CRED);
  assert.deepEqual(readStoredCredential(ORIGIN, { principal: 'agent', env, keychain }), CRED);
  assert.equal(credentialSlot({ principal: 'agent' }), credentialSlot({ principal: 'agent', account: 'default' }));
});

// ---- the old keying is invisible (no migration, by design) -------------------

test('an entry written under the OLD keychain keying is invisible to the slot reader', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  // Pre-slot keying: service `owenloop-hub`, account = the origin.
  keychain.set('owenloop-hub', KEY, JSON.stringify(CRED));
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), null);
  assert.equal(readStoredCredential(ORIGIN, { ...AGENT, env, keychain }), null);
});

test('a v1 credential file reads as an empty store, so old file entries are invisible', () => {
  const env = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
  const path = credentialFilePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Hand-written v1 shape: origin → credential (no slot level).
  writeFileSync(path, `${JSON.stringify({ version: 1, hubs: { [KEY]: CRED } }, null, 2)}\n`, { mode: 0o600 });
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env }), null);
  assert.equal(readStoredCredential(ORIGIN, { ...AGENT, env }), null);
});

// ---- corrupt entries read as absent, symmetrically ---------------------------

test('corrupt keychain entry reads as absent, not a file fallthrough (REL-6)', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, HUMAN, CRED);
  keychain.set(keychainServiceFor(KEY), 'human', 'not-json-{'); // corrupt
  seedFile(env, { [KEY]: { human: CRED } });
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), null);
});

test('a well-formed-JSON but wrong-shape keychain entry also reads as absent', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  keychain.set(keychainServiceFor(KEY), 'human', JSON.stringify({ kind: 'agent' })); // no accessToken
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), null);
  keychain.set(keychainServiceFor(KEY), 'human', JSON.stringify({ kind: 'nope', accessToken: 'x' }));
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), null);
  // An `oauth` entry missing its refresh half is not a usable oauth credential.
  keychain.set(keychainServiceFor(KEY), 'human', JSON.stringify({ kind: 'oauth', accessToken: 'a', clientId: 'c' }));
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), null);
});

test('a corrupt FILE slot value reads as absent (not a throw, not a keychain fallthrough)', () => {
  const env = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
  seedFile(env, { [KEY]: { human: { kind: 'agent' } as unknown as Credential, 'agent:default': CRED } });
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env }), null);
  // The sibling slot is untouched by its neighbour's corruption.
  assert.deepEqual(readStoredCredential(ORIGIN, { ...AGENT, env }), CRED);
});

// ---- backend isolation (REL-6) ----------------------------------------------

test('REL-6: empty keychain never falls through to a populated file', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain(); // keychain EMPTY
  seedFile(env, { [KEY]: { human: CRED } });
  assert.equal(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), null);
});

test('backend precedence: OWENLOOP_NO_KEYCHAIN=1 forces the file backend even when a keychain is injected', () => {
  const env = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, HUMAN, { kind: 'agent', accessToken: 'olp_from_keychain' }); // should be IGNORED
  const fileCred: Credential = { kind: 'agent', accessToken: 'olp_from_file' };
  seedFile(env, { [KEY]: { human: fileCred } });
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), fileCred);
});

// ---- selector validation ------------------------------------------------------

test('invalid agent account names are rejected with a clear error', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  for (const bad of ['', '-leading', 'has space', 'has/slash', 'a'.repeat(65), 'agent:nested'.replace('agent', '@')]) {
    assert.throws(
      () => readStoredCredential(ORIGIN, { principal: 'agent', account: bad, env, keychain }),
      /invalid agent account/,
      `expected '${bad}' to be rejected`,
    );
  }
  // The boundary cases that ARE legal.
  assert.equal(credentialSlot({ principal: 'agent', account: 'a'.repeat(64) }), `agent:${'a'.repeat(64)}`);
  assert.equal(credentialSlot({ principal: 'agent', account: 'a.b_c-1' }), 'agent:a.b_c-1');
});

test('`account` supplied with principal human throws rather than being ignored', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  assert.throws(
    () =>
      readStoredCredential(ORIGIN, {
        ...({ principal: 'human', account: 'x' } as unknown as CredentialSlotSelector),
        env,
        keychain,
      }),
    /only meaningful with principal 'agent'/,
  );
});

test('agent:human does not collide with the human slot', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  const humanCred: Credential = { kind: 'oauth-pasted', accessToken: 'mcpat_h' };
  seedKeychain(keychain, KEY, HUMAN, humanCred);
  assert.equal(credentialSlot({ principal: 'agent', account: 'human' }), 'agent:human');
  assert.equal(readStoredCredential(ORIGIN, { principal: 'agent', account: 'human', env, keychain }), null);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), humanCred);
});

// ---- origin normalization (SEC-2) --------------------------------------------

test('origin is normalized before the slot lookup; an invalid remote origin throws', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, HUMAN, CRED); // stored under the normalized origin
  // A path-bearing, trailing-slash variant normalizes to the same key.
  assert.deepEqual(readStoredCredential('https://hub.example.com/some/path/', { ...HUMAN, env, keychain }), CRED);
  // A plaintext remote origin is rejected at normalization (SEC-2), exactly as the CLI would.
  assert.throws(
    () => readStoredCredential('http://remote.example.com', { ...HUMAN, env, keychain }),
    /http is only allowed for loopback/,
  );
});

test('keychainServiceFor namespaces the service per origin', () => {
  assert.equal(keychainServiceFor(KEY), 'owenloop:https://hub.example.com');
  assert.notEqual(keychainServiceFor(KEY), keychainServiceFor('https://other.example.com'));
});

// ---- the optional external credential command ---------------------------------

/**
 * Write `body` as a JS file in its own temp dir and return a shell command line
 * that runs it. `process.execPath` (not a bare `node`) is deliberate: the
 * fixture env is `{ HOME }` with no `PATH`, so the child could not resolve
 * `node` by name. `/bin/sh` is assumed present, as it already is for the
 * `security` shell-out.
 */
function commandPrinting(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-cred-cmd-'));
  const script = join(dir, 'helper.mjs');
  writeFileSync(script, body, { mode: 0o700 });
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

/** A helper that prints `cred` as JSON on stdout and exits 0. */
function commandEmitting(cred: Credential): string {
  return commandPrinting(`process.stdout.write(${JSON.stringify(JSON.stringify(cred))});\n`);
}

const EXTERNAL: Credential = { kind: 'agent', accessToken: 'olp_from_command' };
const STORED: Credential = { kind: 'agent', accessToken: 'olp_from_store' };

test('external command wins over a credential present in the keychain', () => {
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, HUMAN, STORED);
  const env = fixtureEnv({ OWENLOOP_CREDENTIAL_COMMAND: commandEmitting(EXTERNAL) });
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), EXTERNAL);
});

test('external command wins over a credential present in the file store', () => {
  const env = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
  seedFile(env, { [KEY]: { human: STORED } });
  env.OWENLOOP_CREDENTIAL_COMMAND = commandEmitting(EXTERNAL);
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env }), EXTERNAL);
});

/**
 * Every failure mode: the command is authoritative, so each one throws an error
 * naming the origin AND the slot, and NONE of them falls through to the seeded
 * store. The seeded store is the whole point — a returned `STORED` would be the
 * silent-stale-key bug this feature exists to prevent.
 */
const FAILURE_CASES: [string, string, RegExp][] = [
  ['nonzero exit', 'process.exit(1);\n', /command exited with status 1/],
  ['empty stdout', 'process.exit(0);\n', /produced no output/],
  ['whitespace-only stdout', 'process.stdout.write("  \\n ");\n', /produced no output/],
  ['unparseable stdout', 'process.stdout.write("not json");\n', /output that is not JSON/],
  [
    'well-formed JSON that is not a credential',
    'process.stdout.write(JSON.stringify({ accessToken: "" }));\n',
    /not a well-formed credential/,
  ],
  [
    'an oauth object missing its refresh half',
    'process.stdout.write(JSON.stringify({ kind: "oauth", accessToken: "a", clientId: "c" }));\n',
    /not a well-formed credential/,
  ],
];

for (const [label, body, expected] of FAILURE_CASES) {
  test(`external command failure (${label}) throws and never falls through to a store`, () => {
    const { keychain } = fakeKeychain();
    seedKeychain(keychain, KEY, HUMAN, STORED);
    const env = fixtureEnv({ OWENLOOP_CREDENTIAL_COMMAND: commandPrinting(body) });
    seedFile(env, { [KEY]: { human: STORED } });
    assert.throws(
      () => readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }),
      (e: Error) => {
        assert.match(e.message, expected);
        assert.match(e.message, new RegExp(KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(e.message, /slot `human`/);
        // The stale store value must never be echoed back in any form.
        assert.ok(!e.message.includes(STORED.accessToken), 'error must not carry the stored secret');
        return true;
      },
    );
  });
}

test('external command that hangs times out and throws, with no fallthrough', () => {
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, HUMAN, STORED);
  const env = fixtureEnv({
    OWENLOOP_CREDENTIAL_COMMAND: commandPrinting('setTimeout(() => {}, 60_000);\n'),
    OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS: '250',
  });
  assert.throws(
    () => readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }),
    /external credential command failed for .* slot `human`: command timed out after 250ms/,
  );
});

test('the slot and the normalized origin reach the command verbatim', () => {
  // The helper echoes its own context back through the credential it prints.
  const command = commandPrinting(
    'process.stdout.write(JSON.stringify({ kind: "agent", accessToken: ' +
      '`${process.env.OWENLOOP_CREDENTIAL_SLOT}|${process.env.OWENLOOP_CREDENTIAL_ORIGIN}` }));\n',
  );
  const env = fixtureEnv({ OWENLOOP_CREDENTIAL_COMMAND: command });
  for (const [expectedSlot, sel] of SLOT_CASES) {
    const got = readStoredCredential(ORIGIN, { ...sel, env });
    assert.deepEqual(got, { kind: 'agent', accessToken: `${expectedSlot}|${KEY}` });
  }
  // A path-bearing variant still hands the child the NORMALIZED origin.
  assert.deepEqual(readStoredCredential('https://hub.example.com/some/path/', { ...HUMAN, env }), {
    kind: 'agent',
    accessToken: `human|${KEY}`,
  });
});

test('the command does not inherit OWENLOOP_CREDENTIAL_COMMAND, so a helper cannot recurse', () => {
  const command = commandPrinting(
    'const leaked = process.env.OWENLOOP_CREDENTIAL_COMMAND !== undefined;\n' +
      'process.stdout.write(JSON.stringify({ kind: "agent", accessToken: leaked ? "leaked" : "absent" }));\n',
  );
  const env = fixtureEnv({ OWENLOOP_CREDENTIAL_COMMAND: command });
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env }), { kind: 'agent', accessToken: 'absent' });
});

test('a blank OWENLOOP_CREDENTIAL_COMMAND is not configured — the store answers as usual', () => {
  const { keychain } = fakeKeychain();
  seedKeychain(keychain, KEY, HUMAN, STORED);
  for (const blank of ['', '   ', '\t\n']) {
    const env = fixtureEnv({ OWENLOOP_CREDENTIAL_COMMAND: blank });
    assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env, keychain }), STORED);
  }
});

test('an invalid account and a plaintext remote origin still throw BEFORE the command runs', () => {
  // A command that would "succeed" — if either guard ran late, these would
  // return this credential instead of throwing.
  const env = fixtureEnv({ OWENLOOP_CREDENTIAL_COMMAND: commandEmitting(EXTERNAL) });
  assert.throws(
    () => readStoredCredential(ORIGIN, { principal: 'agent', account: 'has space', env }),
    /invalid agent account/,
  );
  assert.throws(
    () => readStoredCredential('http://remote.example.com', { ...HUMAN, env }),
    /http is only allowed for loopback/,
  );
});

test('OWENLOOP_NO_KEYCHAIN=1 does not disable the external command', () => {
  const env = fixtureEnv({
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENLOOP_CREDENTIAL_COMMAND: commandEmitting(EXTERNAL),
  });
  seedFile(env, { [KEY]: { human: STORED } });
  assert.deepEqual(readStoredCredential(ORIGIN, { ...HUMAN, env }), EXTERNAL);
});

test('externalCredentialCommand reports configuration exactly once, for every call site', () => {
  assert.equal(externalCredentialCommand({}), undefined);
  assert.equal(externalCredentialCommand({ OWENLOOP_CREDENTIAL_COMMAND: '  ' }), undefined);
  assert.equal(externalCredentialCommand({ OWENLOOP_CREDENTIAL_COMMAND: 'helper --x' }), 'helper --x');
  // …and the backend union reflects it, with external ahead of both stores.
  const { keychain } = fakeKeychain();
  assert.deepEqual(credentialBackend({ OWENLOOP_CREDENTIAL_COMMAND: 'helper' }, keychain), {
    kind: 'external',
    command: 'helper',
  });
  assert.equal(credentialBackend({}, keychain).kind, 'keychain');
  assert.equal(credentialBackend({ OWENLOOP_NO_KEYCHAIN: '1' }, keychain).kind, 'file');
});

// ---- the barrel ---------------------------------------------------------------

test('public surface: the barrel re-exports the read function, slot helpers, and the types', () => {
  assert.equal(typeof pub.readStoredCredential, 'function');
  assert.equal(typeof pub.normalizeOrigin, 'function');
  assert.equal(typeof pub.credentialSlot, 'function');
  assert.equal(typeof pub.keychainServiceFor, 'function');
  assert.equal(pub.credentialSlot({ principal: 'agent', account: 'ci' }), 'agent:ci');
  // Type-level use of the barrel's types — compiles only if they resolve from the barrel.
  const typed: BarrelCredential = { kind: 'oauth-pasted', accessToken: 'mcpat_x' };
  assert.equal(typed.kind, 'oauth-pasted');
  const sel: BarrelSelector = { principal: 'agent', account: 'ci' };
  assert.equal(sel.principal, 'agent');
});
