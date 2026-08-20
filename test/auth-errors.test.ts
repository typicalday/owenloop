import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mainAsync } from '../src/cli.ts';
import { makeIo, routedFetch } from './hubkit.ts';

const HUB = 'http://127.0.0.1:9';

async function failedTokenLogin(status: number, token: string, headers?: Record<string, string>): Promise<string> {
  const { fetch } = routedFetch({
    'GET /api/whoami': () => ({ status, json: { error: 'request failed' }, ...(headers === undefined ? {} : { headers }) }),
  });
  const t = makeIo({ fetch, stdin: token });

  const code = await mainAsync(['login', '--hub', HUB, '--with-token'], t.io);
  assert.equal(code, 1);
  assert.equal(t.store.size, 0, 'an unverified credential is never stored');
  return t.err.join('\n');
}

test('login --with-token: a 429 with Retry-After reports a hub rate limit without credential wording', async () => {
  const stderr = await failedTokenLogin(429, 'olp_rate_limited', { 'retry-after': '30' });

  assert.equal(stderr, 'error: rate limited by the hub (retry after 30)');
  assert.doesNotMatch(stderr, /credential/i);
});

test('login --with-token: a 429 without Retry-After omits the suffix and credential wording', async () => {
  const stderr = await failedTokenLogin(429, 'olp_rate_limited');

  assert.equal(stderr, 'error: rate limited by the hub');
  assert.doesNotMatch(stderr, /retry after|\(\)|credential/i);
});

test('login --with-token: a 401 for an agent credential keeps its revoked-token message', async () => {
  const stderr = await failedTokenLogin(401, 'olp_invalid');

  assert.equal(stderr, 'error: token revoked or invalid — re-mint it in the console or run `owenloop login`');
});

test('login --with-token: a 401 for a non-agent credential keeps its rejected-credential message', async () => {
  const stderr = await failedTokenLogin(401, 'mcpat_invalid');

  assert.equal(stderr, 'error: credential rejected by the hub — run `owenloop login`');
});

test('login --with-token: a generic non-401/non-429 failure keeps its credential fallback', async () => {
  const stderr = await failedTokenLogin(500, 'olp_server_error');

  assert.equal(stderr, 'error: hub http://127.0.0.1:9 rejected the credential (HTTP 500)');
});
