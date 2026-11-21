import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shiftSocketAddress } from '../src/shift/socket-address.ts';

test('socket pathname limits count UTF-8 bytes and accept the exact platform boundary', () => {
  for (const [platform, limit] of [['darwin', 104], ['linux', 108]] as const) {
    const exact = '/' + 'é'.repeat((limit - 2) / 2) + 'x';
    assert.equal(Buffer.byteLength(exact), limit);
    assert.equal(shiftSocketAddress(exact, platform), exact);
    // The root directory itself would admit a shorter relative spelling.
    if (process.cwd() !== '/') {
      assert.throws(() => shiftSocketAddress(exact + 'x', platform), new RegExp(limit + '-byte limit'));
    }
  }
});
