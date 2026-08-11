import { acquireFileLockSync } from '../../src/lock.ts';

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error('usage: file-lock-holder <lock-path>');

acquireFileLockSync(lockPath, { waitMs: 5_000, pollMs: 5, label: 'test child' });
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
