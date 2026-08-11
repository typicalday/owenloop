import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const markerDir = process.env.DETACHED_MARKER_DIR;
const role = process.argv[3];
if (markerDir === undefined || (role !== 'exec' && role !== 'agent-run')) process.exit(2);

setTimeout(() => {
  process.stderr.write(`late ${role} diagnostic after Shift exit\n`);
  setTimeout(() => {
    writeFileSync(join(markerDir, `${role}.done`), 'completed\n');
  }, 100);
}, 250);
