/** Read a bundle lock from verified CAS bytes without requiring an index row. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifestBytes } from '../bundle/manifest.ts';
import { verifyWorkflowObjectSync } from './ingestor.ts';
import { coordinateDigestReadSync, probeObjectDir, probeStoreRoot, projectStoreRoot } from './resolve.ts';
import { defDigest, objectDirForDigest, StoreIntegrityError } from './types.ts';

export function createVerifiedBundleLockReader(args: {
  projectRoot?: string;
  globalRoot: string;
}): (digest: string) => Readonly<Record<string, string>> {
  const roots = [args.projectRoot, args.globalRoot]
    .filter((root): root is string => root !== undefined)
    .map(projectStoreRoot)
    .filter((root, index, all) => all.indexOf(root) === index);
  return (rawDigest) => {
    const digest = defDigest(rawDigest);
    for (const [index, root] of roots.entries()) {
      const level = index === 0 && args.projectRoot !== undefined ? 'project' : 'global';
      if (probeStoreRoot(root) === 'absent') continue;
      const objectDir = objectDirForDigest(root, digest);
      try {
        const lock = coordinateDigestReadSync(root, digest, () => {
          if (probeObjectDir(objectDir, digest, level) === 'absent') return undefined;
          verifyWorkflowObjectSync(objectDir, digest, { coordinateRepair: false });
          return parseManifestBytes(readFileSync(join(objectDir, 'bundle.yaml'))).lock;
        });
        if (lock !== undefined) return lock;
      } catch (error) {
        if (error instanceof StoreIntegrityError) throw error;
        throw new StoreIntegrityError('object-corrupt', digest, `${level}-level object could not be verified: ${(error as Error).message}`);
      }
    }
    throw new StoreIntegrityError('object-missing', digest, 'parent bundle is absent from the project and global workflow stores');
  };
}
