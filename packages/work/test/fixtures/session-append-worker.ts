import { appendSession, orderId, type SessionRecord } from '../../src/harness/session-store.ts';

const [file, workerId, countText] = process.argv.slice(2);
if (file === undefined || workerId === undefined || countText === undefined) {
  throw new Error('usage: session-append-worker <file> <worker-id> <count>');
}
const count = Number.parseInt(countText, 10);
if (!Number.isSafeInteger(count) || count < 0) throw new Error('count must be a nonnegative integer');

for (let index = 0; index < count; index++) {
  const run = `run-${workerId}-${index}`;
  const record: SessionRecord = {
    workflow: 'wf-concurrent',
    run,
    step: 'builder',
    order: orderId('wf-concurrent', run),
    attempt: 1,
    harness: 'fake',
    token: `token-${workerId}-${index}`,
    cwd: '/work',
    status: 'active',
    createdAt: index,
    updatedAt: index,
  };
  appendSession(file, record, { maxBytes: 1, warn: () => {} });
}
