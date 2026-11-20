/** HubClient surface for a nested routed hold. Every operation uses a
 * holder-only broker cap; unimplemented verbs refuse without a network fallback. */
import type { HubClient } from './client.ts';
import { createRoutingChildClient } from './routing-child-client.ts';
import type { ContactHolder, FileArtifactPointer, PutFileArtifactResponse,
  RoutedCollectionWriteResponse, RoutedMemberIssueResponse } from './types.ts';
import { openRoutedFileSource, type RoutedFileSourceSeams } from './routed-file-source.ts';
import { openRoutedFileCache } from './routed-file-cache.ts';

export interface RoutingHolderClient extends HubClient {
  collectionTarget(req: { workflow: string; run: string; path: string; holder: ContactHolder }):
    Promise<{ collection: boolean }>;
  emitCollectionMember(req: { workflow: string; run: string; sealPath: string;
    emissionId: string; value: unknown; done: boolean; holder: ContactHolder }):
    Promise<{ member: RoutedCollectionWriteResponse; seal?: RoutedCollectionWriteResponse;
      issued: RoutedMemberIssueResponse }>;
  sealCollection(req: { workflow: string; run: string; sealPath: string;
    sealId: string; holder: ContactHolder }): Promise<RoutedCollectionWriteResponse>;
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
  cacheRoot?: string;
}, seams: RoutedFileSourceSeams = {}): RoutingHolderClient {
  const child = createRoutingChildClient({ reservation: binding, broker: binding.broker });
  // Old test fixtures may omit a cache root, but that capability can never
  // download. A production routed holder receives one through its v2 handoff.
  const cache = binding.cacheRoot === undefined ? undefined
    : openRoutedFileCache((req, signal) => child.getFileArtifactStream(req, signal), binding.cacheRoot);
  const supported = {
    getOrder: child.getOrder,
    heartbeat: child.heartbeat,
    submit: child.submit,
    collectionTarget: child.collectionTarget,
    emitCollectionMember: child.emitCollectionMember,
    sealCollection: child.sealCollection,
    ask: child.ask,
    reject: child.reject,
    putFileArtifact: child.putFileArtifact,
    downloadFile: (req: { workflow: string; run: string; path: string; pointer: FileArtifactPointer },
      signal?: AbortSignal) => {
      if (!cache) throw new Error('file-artifact-cache-unavailable');
      return cache.materialize(req, signal);
    },
    discardDownloadedFile: (file: string) => cache?.discard(file) ?? Promise.resolve(),
    closeDownloadedFiles: () => cache?.close() ?? Promise.resolve(),
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
