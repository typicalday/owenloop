/** HubClient surface for a nested routed hold. Every operation uses a
 * holder-only broker cap; unimplemented verbs refuse without a network fallback. */
import type { HubClient } from './client.ts';
import { createRoutingChildClient } from './routing-child-client.ts';
import type { FileArtifactPointer, PutFileArtifactResponse } from './types.ts';
import { openRoutedFileSource, type RoutedFileSourceSeams } from './routed-file-source.ts';
import { createRoutedFileCache } from './routed-file-cache.ts';

export interface RoutingHolderClient extends HubClient {
  /** Reads a file under the holder's pinned workdir as bounded chunks. */
  uploadFile(req: { workflow: string; workdir: string; file: string; contentType: string;
    filename?: string }): Promise<PutFileArtifactResponse>;
  downloadFile(req: { workflow: string; run: string; path: string; pointer: FileArtifactPointer },
    signal?: AbortSignal): Promise<{ file: string; size: number; contentType: string }>;
  discardDownloadedFile(file: string): Promise<void>;
  closeDownloadedFiles(): Promise<void>;
}

export function createRoutingHolderClient(binding: {
  workflow: string; run: string; broker: { socketPath: string; cap: string };
}, seams: RoutedFileSourceSeams = {}): RoutingHolderClient {
  const child = createRoutingChildClient({ reservation: binding, broker: binding.broker });
  const cache = createRoutedFileCache((req, signal) => child.getFileArtifactStream(req, signal));
  const supported = {
    getOrder: child.getOrder,
    heartbeat: child.heartbeat,
    submit: child.submit,
    ask: child.ask,
    reject: child.reject,
    putFileArtifact: child.putFileArtifact,
    downloadFile: cache.materialize,
    discardDownloadedFile: cache.discard,
    closeDownloadedFiles: cache.close,
    async uploadFile(req: { workflow: string; workdir: string; file: string;
      contentType: string; filename?: string }) {
      const source = await openRoutedFileSource(req, seams);
      try {
	const response = await child.putFileArtifactStream({ workflow: req.workflow, size: source.size,
	  chunks: source.chunks, contentType: req.contentType,
	  ...(req.filename === undefined ? {} : { filename: req.filename }) });
	await source.complete();
	return response;
      } finally { source.close(); }
    },
  };
  return new Proxy(supported, {
    get(target, property) {
      if (typeof property === 'string' && Object.hasOwn(target, property))
	return target[property as keyof typeof target];
      return async () => { throw new Error('routed holder verb unavailable'); };
    },
  }) as RoutingHolderClient;
}
