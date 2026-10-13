/** Opens a routed artifact under the holder's pinned working directory.
 * The native helper owns the descriptor-relative walk and streams one held fd. */
import { spawn } from 'node:child_process';
import { constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, type Readable } from 'node:stream';

function helperPath(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      try {
	if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'owenloop') {
	  return join(directory, 'native', 'bin', `${process.platform}-${process.arch}`, 'routing-file-open');
	}
      } catch { /* Not this package root. */ }
    }
    directory = dirname(directory);
  }
  throw new Error('file-artifact-helper-unavailable: package root missing');
}

export interface RoutedFileSource {
  size: number;
  chunks: AsyncIterable<Uint8Array>;
  complete(): Promise<void>;
  close(): void;
}

export interface RoutedFileSourceSeams {
  /** Tests only: production always anchors the holder process's CWD inode. */
  openRoot?: (workdir: string) => Promise<FileHandle>;
  helperPath?: string;
  afterRootOpen?: () => Promise<void> | void;
}

async function metadataLine(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let line = '';
  for await (const bytes of stream) {
    line += Buffer.from(bytes).toString('utf8');
    if (line.length > 128) throw new Error('file-artifact-helper-unavailable: invalid metadata');
    if (line.includes('\n')) {
      if (!line.endsWith('\n') || line.indexOf('\n') !== line.length - 1)
	throw new Error('file-artifact-helper-unavailable: invalid metadata');
      return line.slice(0, -1);
    }
  }
  throw new Error('file-artifact-helper-unavailable: missing metadata');
}

export async function openRoutedFileSource(req: { workdir: string; file: string },
  seams: RoutedFileSourceSeams = {}): Promise<RoutedFileSource> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('file-artifact-helper-unavailable: unsupported platform');
  if (process.arch !== 'arm64' && process.arch !== 'x64')
    throw new Error('file-artifact-helper-unavailable: unsupported architecture');
  if (typeof req.file !== 'string' || !req.file || req.file.includes('\0')
    || typeof req.workdir !== 'string' || !req.workdir.startsWith('/'))
    throw new Error('file-artifact-invalid: invalid file path');
  // req.workdir comes from this process's CWD in the production MCP mount.
  // Opening '.' pins that directory object even if its name is later moved.
  if (!seams.openRoot && resolve(req.workdir) !== process.cwd())
    throw new Error('file-artifact-outside-workdir: holder workdir mismatch');
  const executable = seams.helperPath ?? helperPath();
  if (!existsSync(executable))
    throw new Error('file-artifact-helper-unavailable: native helper missing');
  // The executable is server infrastructure, never a file in the model's
  // writable workdir. Deployment must keep its package tree trusted as well.
  let helperReal: string;
  let rootReal: string;
  try {
    helperReal = realpathSync(executable);
    rootReal = realpathSync(req.workdir);
  } catch { throw new Error('file-artifact-helper-unavailable: helper or workdir unavailable'); }
  const helperRelative = relative(rootReal, helperReal);
  if (helperRelative === '' || (helperRelative !== '..'
    && !helperRelative.startsWith(`..${sep}`) && !isAbsolute(helperRelative)))
    throw new Error('file-artifact-helper-unavailable: helper is inside workdir');
  let root: FileHandle;
  try {
    root = await (seams.openRoot?.(req.workdir)
      ?? open('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  } catch { throw new Error('file-artifact-outside-workdir: holder root unavailable'); }
  try {
    await seams.afterRootOpen?.();
    const child = spawn(executable, [req.file, req.workdir], {
      stdio: ['ignore', 'pipe', 'pipe', root.fd, 'pipe'], env: {},
    });
    const output = new PassThrough({ highWaterMark: 64 * 1024 });
    child.stdout?.pipe(output);
    const exited = new Promise<void>((accept, reject) => {
      child.once('error', () => reject(new Error('file-artifact-helper-unavailable: launch failed')));
      child.once('close', code => code === 0 ? accept()
	: reject(new Error('file-artifact-read-failed: native helper refused file')));
    });
    void exited.catch(() => {});
    try {
      const metadata = child.stdio[4] as Readable | null;
      if (!metadata || !child.stdout)
	throw new Error('file-artifact-helper-unavailable: helper pipes missing');
      let timer: NodeJS.Timeout | undefined;
      let line: string;
      try {
	line = await Promise.race([
	  metadataLine(metadata),
	  new Promise<never>((_accept, reject) => {
	    timer = setTimeout(() => reject(
	      new Error('file-artifact-helper-unavailable: helper timeout')), 5_000);
	    timer.unref();
	  }),
	]);
      } finally { if (timer) clearTimeout(timer); }
      if (line.startsWith('ERR ')) throw new Error(line === 'ERR file'
	? 'file-artifact-invalid: file size or type refused'
	: 'file-artifact-outside-workdir: confined open refused');
      if (!/^OK (?:[1-9][0-9]*)$/.test(line))
	throw new Error('file-artifact-helper-unavailable: invalid metadata');
      const size = Number(line.slice(3));
      if (!Number.isSafeInteger(size) || size > 500_000_000)
	throw new Error('file-artifact-helper-unavailable: invalid size');
      return {
	size, chunks: output, complete: () => exited,
	close() { output.destroy(); child.stdout?.destroy(); child.kill('SIGTERM'); },
      };
    } catch (error) {
      output.destroy();
      child.stdout?.destroy();
      child.kill('SIGTERM');
      void exited.catch(() => {});
      throw error;
    }
  } finally { await root.close(); }
}
