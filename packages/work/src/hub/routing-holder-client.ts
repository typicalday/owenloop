/** HubClient surface for a nested routed hold. Every operation uses a
 * holder-only broker cap; unimplemented verbs refuse without a network fallback. */
import type { HubClient } from './client.ts';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRoutingChildClient } from './routing-child-client.ts';
import type { PutFileArtifactResponse } from './types.ts';

export interface RoutingHolderClient extends HubClient {
  /** Reads a local, contained file as bounded chunks; the path never crosses the broker. */
  uploadFile(req: { workflow: string; file: string; contentType: string;
    filename?: string }): Promise<PutFileArtifactResponse>;
}

export function createRoutingHolderClient(binding: {
  workflow: string; run: string; broker: { socketPath: string; cap: string };
}): RoutingHolderClient {
  const child = createRoutingChildClient({ reservation: binding, broker: binding.broker });
  const supported = {
    getOrder: child.getOrder,
    heartbeat: child.heartbeat,
    submit: child.submit,
    ask: child.ask,
    reject: child.reject,
    putFileArtifact: child.putFileArtifact,
    async uploadFile(req: { workflow: string; file: string; contentType: string; filename?: string }) {
      const handle = await open(req.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
	const info = await handle.stat();
	if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0
	  || info.size > 500_000_000) throw new Error('file-artifact-invalid: file size refused');
	return await child.putFileArtifactStream({ workflow: req.workflow, size: info.size,
	  chunks: handle.createReadStream({ autoClose: false }), contentType: req.contentType,
	  ...(req.filename === undefined ? {} : { filename: req.filename }) });
      } finally { await handle.close(); }
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
