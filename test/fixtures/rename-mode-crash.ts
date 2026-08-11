import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [src, dst, persistedModeRaw] = process.argv.slice(2);
if (src === undefined || dst === undefined) {
  throw new Error('usage: rename-mode-crash <source> <destination> [persisted-mode]');
}
const persistedMode = persistedModeRaw === undefined ? undefined : Number(persistedModeRaw);
const originalRename = fs.renameSync;
fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
  originalRename(from, to);
  process.kill(process.pid, 'SIGKILL');
}) as typeof fs.renameSync;
syncBuiltinESMExports();

const { renameDirRestoringWrite } = await import('../../src/install.ts');
renameDirRestoringWrite(src, dst, persistedMode);
throw new Error('rename crash hook did not terminate the process');
