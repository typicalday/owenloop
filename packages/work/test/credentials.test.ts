import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHubClient } from '../src/hub/client.ts';
import { FakeCredentialReader, credentialToToken, type Credential } from '../src/credentials/reader.ts';

test('FakeCredentialReader returns the seeded credential and null for unknown origins', async () => {
  const cred: Credential = { kind: 'agent', accessToken: 'olp_abc' };
  const reader = new FakeCredentialReader({ 'https://hub.example': cred });
  assert.deepEqual(await reader.read('https://hub.example'), cred);
  assert.equal(await reader.read('https://other.example'), null);
});

test('credentialToToken returns the access token across all three credential kinds', () => {
  const oauth: Credential = { kind: 'oauth', accessToken: 'a1', refreshToken: 'r1', expiresAt: 1, clientId: 'c1' };
  const agent: Credential = { kind: 'agent', accessToken: 'a2' };
  const pasted: Credential = { kind: 'oauth-pasted', accessToken: 'a3' };
  assert.equal(credentialToToken(oauth), 'a1');
  assert.equal(credentialToToken(agent), 'a2');
  assert.equal(credentialToToken(pasted), 'a3');
});

test('the seam composes: reader -> token -> hub client bearer header', async () => {
  const origin = 'https://hub.example';
  const reader = new FakeCredentialReader({ [origin]: { kind: 'agent', accessToken: 'olp_seam' } });
  let seenAuth: string | undefined;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenAuth = headers['authorization'];
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
  }) as typeof fetch;

  const client = createHubClient({
    origin,
    getToken: async () => {
      const cred = await reader.read(origin);
      assert.ok(cred, 'expected a seeded credential');
      return credentialToToken(cred);
    },
    fetchImpl,
  });
  await client.whoami();
  assert.equal(seenAuth, 'Bearer olp_seam');
});
