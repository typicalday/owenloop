/** Private holder cache. A returned path appears only after the scoped stream's
 * complete byte count and digest have been verified. No path in the mutable
 * workdir is opened or written by this module. */
import { randomBytes } from 'node:crypto';
import { constants, chmodSync, lstatSync, mkdtempSync, mkdirSync } from 'node:fs';
import { chmod, open, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import type { FileArtifactPointer } from './types.ts';

const MAX_FILE = 500_000_000;
const MAX_CACHE_BYTES = 2_000_000_000;
const MAX_CACHE_FILES = 16;

export interface RoutedFileDownload {
  size: number;
  contentType: string;
  chunks: AsyncIterable<Uint8Array>;
  /** Resolves only after exact EOF, size and SHA-256 verification. */
  verified: Promise<void>;
}

export interface RoutedFileRequest {
  workflow: string;
  run: string;
  path: string;
  pointer: FileArtifactPointer;
}

/** Allocate before adapter start. Only `publishedRoot` may enter an adapter's
 * read policy; staging stays outside that subtree. The parent owns cleanup if
 * the nested holder exits without doing it. */
export function allocateRoutedFileCache(base: string): {
  custodyRoot: string; publishedRoot: string; cleanup(): Promise<void>;
} {
  if (!isAbsolute(base) || normalize(base) !== base) throw new Error('file-artifact-cache-unavailable: invalid base');
  const parent = lstatSync(base);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700
    || (process.getuid && parent.uid !== process.getuid()))
    throw new Error('file-artifact-cache-unavailable: base is not private');
  const custodyRoot = mkdtempSync(join(base, 'ol-rfc-'));
  chmodSync(custodyRoot, 0o700);
  mkdirSync(join(custodyRoot, 'staging'), { mode: 0o700 });
  const publishedRoot = join(custodyRoot, 'verified');
  mkdirSync(publishedRoot, { mode: 0o700 });
  return { custodyRoot, publishedRoot,
    cleanup: () => rm(custodyRoot, { recursive: true, force: true }) };
}

export function validateRoutedFileCacheRoot(root: string): void {
  if (!isAbsolute(root) || normalize(root) !== root
    || !/^ol-rfc-[A-Za-z0-9]{6}$/.test(basename(root)))
    throw new Error('file-artifact-cache-unavailable: invalid root');
  for (const path of [root, join(root, 'staging'), join(root, 'verified')]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('file-artifact-cache-unavailable: root changed');
  }
}

export function validateRoutedPublishedRoot(root: string): void {
  if (!isAbsolute(root) || normalize(root) !== root || basename(root) !== 'verified')
    throw new Error('file-artifact-cache-unavailable: invalid published root');
  validateRoutedFileCacheRoot(join(root, '..'));
}

export function createRoutedFileCache(
  download: (req: RoutedFileRequest, signal: AbortSignal) => Promise<RoutedFileDownload>,
  base: string,
) {
  return openRoutedFileCache(download, allocateRoutedFileCache(base).custodyRoot);
}

export function openRoutedFileCache(
  download: (req: RoutedFileRequest, signal: AbortSignal) => Promise<RoutedFileDownload>,
  root: string,
) {
  validateRoutedFileCacheRoot(root);
  const staging = join(root, 'staging');
  const verified = join(root, 'verified');
  let closed = false;
  let reservedBytes = 0;
  let reservedFiles = 0;
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const published = new Map<string, number>();

  async function materialize(req: RoutedFileRequest, signal?: AbortSignal): Promise<{
    file: string; size: number; contentType: string;
  }> {
    const size = req.pointer.size;
    if (closed || signal?.aborted || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE
      || reservedFiles >= MAX_CACHE_FILES || reservedBytes + size > MAX_CACHE_BYTES)
      throw new Error('file-artifact-cache-unavailable: capacity or lifetime refused');
    reservedFiles++;
    reservedBytes += size;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const id = randomBytes(16).toString('hex');
    const stage = join(staging, id);
    const final = join(verified, id);
    const work = (async () => {
      let source: RoutedFileDownload | undefined;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let committed = false;
      try {
        if (signal?.aborted || closed) throw new Error('file-artifact-download-cancelled');
        source = await download(req, controller.signal);
        // The broker may discover a bad digest while the writer is still
        // draining buffered chunks. Observe early refusal before awaiting it.
        void source.verified.catch(() => {});
        if (closed || controller.signal.aborted || source.size !== size
          || source.contentType !== req.pointer.contentType)
          throw new Error('file-artifact-download-refused');
        handle = await open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let count = 0;
        for await (const chunk of source.chunks) {
          if (closed || controller.signal.aborted || !(chunk instanceof Uint8Array)
            || count + chunk.byteLength > size) throw new Error('file-artifact-download-refused');
          let offset = 0;
          while (offset < chunk.byteLength) {
            const wrote = await handle.write(chunk, offset, chunk.byteLength - offset);
            if (wrote.bytesWritten < 1) throw new Error('file-artifact-cache-write-failed');
            offset += wrote.bytesWritten;
          }
          count += chunk.byteLength;
        }
        await source.verified;
        if (count !== size || closed || controller.signal.aborted)
          throw new Error('file-artifact-download-refused');
        await handle.close();
        handle = undefined;
        await chmod(stage, 0o400);
        if (closed || controller.signal.aborted) throw new Error('file-artifact-download-cancelled');
        await rename(stage, final);
        committed = true;
        published.set(final, size);
        return { file: final, size, contentType: req.pointer.contentType };
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (!committed) {
          if (source?.chunks instanceof Readable) source.chunks.destroy();
          await rm(stage, { force: true }).catch(() => {});
          reservedFiles--;
          reservedBytes -= size;
        }
      }
    })();
    pending.add(work);
    try { return await work; }
    finally {
      pending.delete(work);
      controllers.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function discard(file: string): Promise<void> {
    const size = published.get(file);
    if (size === undefined) return;
    published.delete(file);
    await rm(file, { force: true });
    reservedFiles--;
    reservedBytes -= size;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...pending]);
    await rm(root, { recursive: true, force: true });
    published.clear();
  }

  return { root, materialize, discard, close };
}
