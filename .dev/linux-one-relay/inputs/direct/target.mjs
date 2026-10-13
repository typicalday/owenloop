import { Worker } from 'node:worker_threads';
const worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
worker.once('online', () => process.stdout.write('READY\n'));
let ending = false;
process.stdin.resume();
process.stdin.once('end', async () => {
  ending = true;
  await worker.terminate();
});
worker.once('error', () => { process.exitCode = 2; });
process.once('beforeExit', () => { if (!ending) process.exitCode = 2; });
