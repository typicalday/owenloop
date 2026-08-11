import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { createRecoveryMarker, recordRecoveryMarkerPriorIdentity } from '../../src/install.ts';

const [root, markerDir, stagingId, destination, operation, phase] = process.argv.slice(2);
if (
  root === undefined ||
  markerDir === undefined ||
  stagingId === undefined ||
  destination === undefined ||
  (operation !== 'install' && operation !== 'repair') ||
  (phase !== 'created' && phase !== 'prior-recorded')
) {
  throw new Error(
    'usage: recovery-marker-crash <root> <marker-dir> <staging-id> <destination> <install|repair> <created|prior-recorded>',
  );
}

const marker = createRecoveryMarker({
  root,
  destSegments: destination.split('/'),
  stagingId,
  markerDir,
  operation,
  replacementDir: join(root, '.owenloop-staging', stagingId),
});
if (phase === 'prior-recorded') {
  if (operation !== 'repair') throw new Error('prior-recorded requires repair');
  recordRecoveryMarkerPriorIdentity(marker, join(root, ...destination.split('/')));
}
writeSync(1, `${marker.path}\n`);
process.kill(process.pid, 'SIGKILL');
throw new Error('marker crash hook did not terminate the process');
