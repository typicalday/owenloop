import assert from 'node:assert/strict';
import { test } from 'node:test';

import { watchStdinEof, type StdinHost } from '../src/roles/signals.ts';

// ---- fakes ------------------------------------------------------------------

/** A fake stdin-shaped stream: hand-driven `end`/`close`, counted `resume`. */
function fakeStdin(withResume = true): {
  host: StdinHost;
  state: { resumed: number };
  emit: (ev: 'end' | 'close') => void;
} {
  const handlers: Record<'end' | 'close', Array<() => void>> = { end: [], close: [] };
  const state = { resumed: 0 };
  const host: StdinHost = {
    on(ev, h) {
      handlers[ev].push(h);
      return host;
    },
    ...(withResume
      ? {
          resume(): void {
            state.resumed++;
          },
        }
      : {}),
  };
  return {
    host,
    state,
    emit: (ev) => {
      for (const h of [...handlers[ev]]) h();
    },
  };
}

// ---- watchStdinEof ----------------------------------------------------------

test('watchStdinEof: `end` fires the callback', () => {
  const s = fakeStdin();
  let fired = 0;
  watchStdinEof(s.host, () => fired++);
  s.emit('end');
  assert.equal(fired, 1);
});

test('watchStdinEof: `close` fires the callback', () => {
  const s = fakeStdin();
  let fired = 0;
  watchStdinEof(s.host, () => fired++);
  s.emit('close');
  assert.equal(fired, 1);
});

test('watchStdinEof: a stream emitting both `end` AND `close` fires exactly once', () => {
  const s = fakeStdin();
  let fired = 0;
  watchStdinEof(s.host, () => fired++);
  s.emit('end');
  s.emit('close');
  assert.equal(fired, 1);

  // And in the other arrival order.
  const s2 = fakeStdin();
  let fired2 = 0;
  watchStdinEof(s2.host, () => fired2++);
  s2.emit('close');
  s2.emit('end');
  assert.equal(fired2, 1);
});

test('watchStdinEof: calls resume() when present, and tolerates its absence', () => {
  const s = fakeStdin();
  watchStdinEof(s.host, () => {});
  assert.equal(s.state.resumed, 1);

  // A host without resume() must not throw (the seam declares it optional).
  const bare = fakeStdin(false);
  assert.doesNotThrow(() => watchStdinEof(bare.host, () => {}));
});
