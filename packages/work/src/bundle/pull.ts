/**
 * Authenticated, one-shot recovery of a workflow bundle missing from both
 * local stores. This is deliberately an internal store-miss adapter, not a
 * user-facing pull command: it obtains raw canonical bundle bytes and the
 * evidence that the normal install trust boundary must validate.
 */
import { defaultRecoveryMarkerDir } from '../../../../src/install.ts';
import { readBodyBounded } from '../../../../src/credentials.ts';
import {
  createBundleIngestor,
  createPreCommitVerifier,
  defDigest,
  globalStoreRoot,
  installWorkflowBundle,
  workflowStoreStatePaths,
} from '../../../../src/store/index.ts';
import type { MissingObjectHandler } from '../../../../src/store/index.ts';

const BUNDLE_MAX_BYTES = 25_000_000;
const EVIDENCE_MAX_BYTES = 64 * 1024;
const RECOVERY_TIMEOUT_MS = 30_000;

export interface HubBundleRecoveryOptions {
  /** Authenticated hub origin; a trailing slash is accepted. */
  origin: string;
  /** Scoped worker/shift bearer. It is sent only in the Authorization header. */
  token: string;
  /** Injected home, used for the global store and its recovery marker directory. */
  home: string;
  /** Current project root, used by install's exact-lock validation. */
  projectRoot: string;
  /** Environment used by the pre-commit trust policy. */
  env: Record<string, string | undefined>;
  /** Diagnostic sink for warn policy decisions. */
  warn?: (line: string) => void;
  /** Injectable transport for hermetic recovery tests. */
  fetchImpl?: typeof fetch;
  /** Per-request deadline; production uses the fixed 30-second default. */
  timeoutMs?: number;
}

function originBase(origin: string): string {
  const trimmed = origin.replace(/\/+$/, '');
  if (trimmed === '') throw new Error('cannot recover workflow bundle: hub origin is empty');
  return trimmed;
}

function routeFor(origin: string, resource: 'bundles' | 'publications' | 'origins', digest: string): string {
  return `${originBase(origin)}/api/${resource}/${encodeURIComponent(digest)}`;
}

function failure(route: string, detail: string): Error {
  // This deliberately names only a route and status/classification. Never pass
  // through fetch request options or headers: the bearer must not become error
  // text or a shift log record.
  return new Error(`workflow bundle recovery failed for ${route}: ${detail}`);
}

async function request(
  args: HubBundleRecoveryOptions,
  route: string,
): Promise<Response> {
  const timeoutMs = args.timeoutMs ?? RECOVERY_TIMEOUT_MS;
  try {
    return await (args.fetchImpl ?? globalThis.fetch)(route, {
      method: 'GET',
      headers: { Authorization: `Bearer ${args.token}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'request error';
    const detail = name === 'TimeoutError' || name === 'AbortError'
      ? `timed out after ${timeoutMs / 1_000}s`
      : 'request failed';
    throw failure(route, detail);
  }
}

async function bytesFrom(
  response: Response,
  route: string,
  cap: number,
): Promise<Uint8Array> {
  try {
    return await readBodyBounded(response, cap, route);
  } catch (error) {
    const detail = error instanceof Error && /cap/u.test(error.message)
      ? `response exceeds the ${cap}-byte cap`
      : 'could not read response body';
    throw failure(route, detail);
  }
}

/** Build the existing store's one-shot `onMissing` hook for a scoped worker. */
export function createHubBundleRecoveryHandler(args: HubBundleRecoveryOptions): MissingObjectHandler {
  return {
    async onMissing(requestedDigest: string): Promise<'retry'> {
      const digest = defDigest(requestedDigest);
      const bundleRoute = routeFor(args.origin, 'bundles', digest);
      const bundleResponse = await request(args, bundleRoute);
      if (!bundleResponse.ok) throw failure(bundleRoute, `hub returned HTTP ${bundleResponse.status}`);
      const bytes = await bytesFrom(bundleResponse, bundleRoute, BUNDLE_MAX_BYTES);

      const publicationRoute = routeFor(args.origin, 'publications', digest);
      const publicationResponse = await request(args, publicationRoute);
      if (!publicationResponse.ok) {
        throw failure(publicationRoute, `hub returned HTTP ${publicationResponse.status}`);
      }
      const state = publicationResponse.headers.get('x-owenloop-publication-state');
      if (state !== 'signed' && state !== 'unsigned') {
        throw failure(publicationRoute, 'missing or invalid X-Owenloop-Publication-State header');
      }
      const publicationBytes = await bytesFrom(publicationResponse, publicationRoute, EVIDENCE_MAX_BYTES);
      if (state === 'signed' && publicationBytes.byteLength === 0) {
        throw failure(publicationRoute, 'signed publication evidence is empty');
      }

      const originRoute = routeFor(args.origin, 'origins', digest);
      const originResponse = await request(args, originRoute);
      let originDsseBytes: Uint8Array | undefined;
      if (originResponse.status === 404) {
        await originResponse.body?.cancel().catch(() => {});
      } else {
        if (!originResponse.ok) throw failure(originRoute, `hub returned HTTP ${originResponse.status}`);
        originDsseBytes = await bytesFrom(originResponse, originRoute, EVIDENCE_MAX_BYTES);
        if (originDsseBytes.byteLength === 0) throw failure(originRoute, 'origin evidence is empty');
      }

      const globalRoot = globalStoreRoot(args.home);
      const statePaths = workflowStoreStatePaths(globalRoot);
      await installWorkflowBundle({
        bytes,
        source: { kind: 'url', url: bundleRoute },
        root: globalRoot,
        level: 'global',
        projectRoot: args.projectRoot,
        globalRoot,
        lockPath: statePaths.lockPath,
        journalPath: statePaths.journalPath,
        recoveryMarkerDir: defaultRecoveryMarkerDir(args.home),
        ingestor: createBundleIngestor(),
        verifier: createPreCommitVerifier({ env: args.env, ...(args.warn !== undefined ? { warn: args.warn } : {}) }),
        expectedDigest: digest,
        verificationEvidence: {
          publication: state === 'signed'
            ? { state, dsseBytes: publicationBytes }
            : { state, markerBytes: publicationBytes },
          ...(originDsseBytes !== undefined ? { originDsseBytes } : {}),
        },
      });
      return 'retry';
    },
  };
}
