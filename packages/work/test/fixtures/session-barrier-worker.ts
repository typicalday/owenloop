import { workerData } from 'node:worker_threads';

import { appendSession, type SessionRecord } from '../../src/harness/session-store.ts';

const data = workerData as {
  target: string;
  record: SessionRecord;
  barrier: SharedArrayBuffer;
};
const state = new Int32Array(data.barrier);

Atomics.wait(state, 0, 0);
Atomics.store(state, 1, 1);
Atomics.notify(state, 1);
appendSession(data.target, data.record);
