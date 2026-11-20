import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
if (!isMainThread) {
  parentPort.postMessage('READY');
  parentPort.on('message', value => { if (value === 'END') parentPort.close(); });
} else {
  const worker = new Worker(fileURLToPath(import.meta.url));
  let ready=false, ending=false;
  worker.once('message', value => {
    if (value !== 'READY') process.exitCode=2;
    else { ready=true; process.stdout.write('READY\n'); }
  });
  worker.once('error', () => { process.exitCode=2; process.stdin.destroy(); });
  process.stdin.resume();
  process.stdin.once('end', () => {
    ending=true; if (!ready) process.exitCode=2; worker.postMessage('END');
  });
  worker.once('exit', code => { if (!ending || code !== 0) process.exitCode=2; });
}
