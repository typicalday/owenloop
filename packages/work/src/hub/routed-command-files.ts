/** Command consumed-file staging. The original OWENLOOP_CONSUMES remains the
 * signed artifact value; this separate map names completed read-only bytes. */
import { isDeepStrictEqual } from 'node:util';
import { allocateRoutedFileCache, openRoutedFileCache } from './routed-file-cache.ts';
import type { RoutingChildClient } from './routing-child-client.ts';
import type { ContactHolder, FileArtifactPointer, OrderPacket } from './types.ts';

const MAX_FILES = 16;
const MAX_NODES = 10_000;
const MAX_DEPTH = 32;
const MAX_FILE = 500_000_000;
const refused = (): Error => new Error('routed consumed files refused');

interface SelectedFile { artifactPath: string; pointerKey: string; pointer: FileArtifactPointer }

function selectedFiles(order: OrderPacket): SelectedFile[] {
  if (!Array.isArray(order.inputs)
    || !order.consumes || typeof order.consumes !== 'object' || Array.isArray(order.consumes)) throw refused();
  const found = new Map<string, SelectedFile>();
  let nodes = 0;
  const walk = (artifactPath: string, value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw refused();
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (Object.hasOwn(row, '__file')) {
      const key = row['__file'];
      if (typeof key !== 'string' || !key || key.includes('\0')
		|| typeof row['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['hash'])
		|| typeof row['size'] !== 'number' || !Number.isSafeInteger(row['size'])
		|| row['size'] < 1 || row['size'] > MAX_FILE
		|| typeof row['contentType'] !== 'string' || !row['contentType'].trim()) throw refused();
      const id = `${artifactPath}\0${key}`;
      const entry = { artifactPath, pointerKey: key, pointer: row as unknown as FileArtifactPointer };
      const prior = found.get(id);
      if (prior && !isDeepStrictEqual(prior.pointer, entry.pointer)) throw refused();
      found.set(id, entry);
      if (found.size > MAX_FILES) throw refused();
      return;
    }
    if (Array.isArray(value)) for (const child of value) walk(artifactPath, child, depth + 1);
    else for (const child of Object.values(row)) walk(artifactPath, child, depth + 1);
  };
  if (new Set(order.inputs).size !== order.inputs.length) throw refused();
  for (const path of order.inputs) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw refused();
    if (Object.hasOwn(order.consumes, path)) walk(path, order.consumes[path], 0);
  }
  return [...found.values()].sort((a, b) => a.artifactPath.localeCompare(b.artifactPath)
    || a.pointerKey.localeCompare(b.pointerKey));
}

/** Parent-side bounded detector for agent cache policy selection. Malformed
 * pointer-shaped inputs throw, so callers cannot silently omit file authority. */
export function hasConsumedFilePointers(order: OrderPacket): boolean {
  return selectedFiles(order).length > 0;
}

/** Refresh the parent-verified current order through the scoped broker, then
 * stage every current pointer before returning any path to the shell. The
 * caller owns cleanup after the command exits or the lease terminates. */
export async function materializeRoutedCommandFiles(args: {
  order: OrderPacket;
  holder: ContactHolder;
  child: Pick<RoutingChildClient, 'getOrder' | 'getFileArtifactStream'>;
  privateBase: string;
  signal?: AbortSignal;
}): Promise<{ envValue: string; cleanup(): Promise<void> }> {
  if (args.signal?.aborted) throw refused();
  const current = await args.child.getOrder({ workflow: args.order.workflow, run: args.order.run,
    holder: args.holder });
  if (args.signal?.aborted || current.workflow !== args.order.workflow
    || current.run !== args.order.run || !current.lease.claimed
    || current.lease.outcome !== undefined || !current.order
    || !isDeepStrictEqual(current.order, args.order)
    || current.order.worker !== 'command') throw refused();
  const pointers = selectedFiles(current.order);
  if (pointers.length === 0) return { envValue: '[]', cleanup: async () => {} };
  const allocation = allocateRoutedFileCache(args.privateBase);
  let cache: ReturnType<typeof openRoutedFileCache>;
  try {
    cache = openRoutedFileCache((req, signal) => args.child.getFileArtifactStream(req, signal),
      allocation.custodyRoot);
  } catch {
    await allocation.cleanup();
    throw refused();
  }
  let closed = false;
  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { await cache.close(); }
    finally { await allocation.cleanup(); }
  };
  try {
    const entries: Array<{ artifactPath: string; pointerKey: string; file: string }> = [];
    for (const { artifactPath, pointerKey, pointer } of pointers) {
      if (args.signal?.aborted) throw refused();
      const ready = await cache.materialize({ workflow: args.order.workflow,
		run: args.order.run, path: artifactPath, pointer }, args.signal);
      entries.push({ artifactPath, pointerKey, file: ready.file });
    }
    if (args.signal?.aborted) throw refused();
    const envValue = JSON.stringify(entries);
    if (Buffer.byteLength(envValue, 'utf8') > 64 * 1024) throw refused();
    return { envValue, cleanup };
  } catch {
    await cleanup();
    throw refused();
  }
}
