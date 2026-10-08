/** HubClient surface for a nested routed hold. Every operation uses a
 * holder-only broker cap; unimplemented verbs refuse without a network fallback. */
import type { HubClient } from './client.ts';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createRoutingChildClient } from './routing-child-client.ts';
import type { PutFileArtifactResponse } from './types.ts';
import { resolveContainedPath } from '../contained-path.ts';
import { isInside } from '../harness/gatekeeper.ts';

export interface RoutingHolderClient extends HubClient {
  /** Reads a local, contained file as bounded chunks; the path never crosses the broker. */
  uploadFile(req: { workflow: string; workdir: string; file: string; contentType: string;
    filename?: string }): Promise<PutFileArtifactResponse>;
}

export function createRoutingHolderClient(binding: {
  workflow: string; run: string; broker: { socketPath: string; cap: string };
}, seams: { afterFileOpen?: () => Promise<void> | void } = {}): RoutingHolderClient {
  const child = createRoutingChildClient({ reservation: binding, broker: binding.broker });
  const supported = {
    getOrder: child.getOrder,
    heartbeat: child.heartbeat,
    submit: child.submit,
    ask: child.ask,
    reject: child.reject,
    putFileArtifact: child.putFileArtifact,
    async uploadFile(req: { workflow: string; workdir: string; file: string;
      contentType: string; filename?: string }) {
      // Pin the workdir inode before resolving the model's path. Rechecking
      // the name after open catches an ancestor swapped to a symlink between
      // containment and open; the upload always reads the original file fd.
      const root = await realpath(req.workdir);
      const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
	const pinnedRoot = await rootHandle.stat();
	const file = await resolveContainedPath(root, req.file, 'file-artifact');
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
	  await seams.afterFileOpen?.();
	  const [rootNow, rootPath, filePath, pathInfo, info] = await Promise.all([
	    stat(root), realpath(root), realpath(file), stat(file), handle.stat(),
	  ]);
	  if (rootNow.dev !== pinnedRoot.dev || rootNow.ino !== pinnedRoot.ino
	    || rootPath !== root || !isInside(root, filePath)
	    || pathInfo.dev !== info.dev || pathInfo.ino !== info.ino)
	    throw new Error('file-artifact-outside-workdir: file changed before upload');
	  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0
	    || info.size > 500_000_000) throw new Error('file-artifact-invalid: file size refused');
	  return await child.putFileArtifactStream({ workflow: req.workflow, size: info.size,
	    chunks: handle.createReadStream({ autoClose: false }), contentType: req.contentType,
	    ...(req.filename === undefined ? {} : { filename: req.filename }) });
	} finally { await handle.close(); }
      } finally { await rootHandle.close(); }
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
