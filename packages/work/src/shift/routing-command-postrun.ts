/** Parent-owned copy of a routed command's asserted result. The role supplies
 * bytes, never a target, holder, signer, URL or physical-start proof. */
import { isDeepStrictEqual } from 'node:util';
import { canonicalValueBytes, valueDigestHex } from '../../../../src/crypto/canonical.ts';
import { buildReceipt, type CommandReceipt } from '../exec/receipt.ts';
import type { ParsedPayload, RejectDirective } from '../exec/payload.ts';
import type { CommandResult } from '../exec/runner.ts';

export type CommandPostrunResult = Omit<CommandResult, 'payloadLine' | 'payloadOverCap'>;
export interface CommandPostrunRequest {
  result: CommandPostrunResult;
  receipt: CommandReceipt;
  parsed: { reject?: RejectDirective; payloadError?: string };
  group: { scope: 'original-posix-group'; state: 'empty' };
}
export interface CommandPostrunResponse {
  outcome: 'submitted' | 'submit-rejected' | 'rejected' | 'judge-rejected' | 'command-failed';
  claim: 'closed' | 'held' | 'uncertain';
}
export type CommandPostrunStatus = { state: 'pending' | 'unavailable' }
  | { state: 'committed'; result: CommandPostrunResponse };

/** Hash the exact JSON-shaped child packet, including JSON omission of undefined
 * fields. The parent hashes the parsed socket body with the same function. */
export function commandPostrunBodyDigest(value: CommandPostrunRequest | unknown): string {
  return valueDigestHex(JSON.parse(JSON.stringify(value)));
}
export interface CommandPostrunSnapshot {
  /** Exact canonical bytes retained for signing and identical uncertain replay. */
  canonical: string;
  receipt(): CommandReceipt;
  parsed: ParsedPayload;
  result: CommandPostrunResult;
}

const MAX_ARTIFACT_BYTES = 25_000_000;
const HASH = /^sha256:[a-f0-9]{64}(?:\+[a-f0-9]{64})?$/;
const own = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

export function snapshotCommandPostrun(value: unknown, expected: {
  command: string; orchestrator: string; workflow: string; run: string; step: string;
}): CommandPostrunSnapshot {
  if (!own(value, ['result', 'receipt', 'parsed', 'group']))
    throw new Error('routed command result refused');
  if (!own(value.group, ['scope', 'state'])
    || value.group.scope !== 'original-posix-group' || value.group.state !== 'empty')
    throw new Error('routed command group unsettled');
  const result = value.result as Record<string, unknown>;
  const required = ['exitCode', 'outputHash', 'stdoutBytes', 'stderrBytes',
    'outputTail', 'startedAt', 'finishedAt', 'durationMs'];
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !isDeepStrictEqual(Object.keys(result).sort(), required.sort())
    || !Number.isSafeInteger(result.exitCode) || (result.exitCode as number) < 0
    || typeof result.outputHash !== 'string' || !HASH.test(result.outputHash)
    || !Number.isSafeInteger(result.stdoutBytes) || (result.stdoutBytes as number) < 0
    || !Number.isSafeInteger(result.stderrBytes) || (result.stderrBytes as number) < 0
    || typeof result.outputTail !== 'string'
    || Buffer.byteLength(result.outputTail, 'utf8') > 4096
    || !Number.isSafeInteger(result.startedAt) || !Number.isSafeInteger(result.finishedAt)
    || !Number.isSafeInteger(result.durationMs)
    || (result.startedAt as number) < 0 || (result.finishedAt as number) < (result.startedAt as number)
    || (result.durationMs as number) < 0)
    throw new Error('routed command result refused');
  const parsed = value.parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some(key => key !== 'reject' && key !== 'payloadError'))
    throw new Error('routed command payload refused');
  const payload = parsed as Record<string, unknown>;
  if (payload.payloadError !== undefined && (typeof payload.payloadError !== 'string'
    || Buffer.byteLength(payload.payloadError, 'utf8') > 16_384))
    throw new Error('routed command payload refused');
  if (payload.reject !== undefined && (!own(payload.reject, ['path', 'text'])
    || typeof payload.reject.path !== 'string' || !payload.reject.path
    || typeof payload.reject.text !== 'string' || !payload.reject.text.trim()
    || Buffer.byteLength(payload.reject.text, 'utf8') > 65_536))
    throw new Error('routed command payload refused');
  const asserted = value.receipt;
  if (!asserted || typeof asserted !== 'object' || Array.isArray(asserted))
    throw new Error('routed command receipt refused');
  const assertedPayload = (asserted as CommandReceipt).payload;
  const rawReject = assertedPayload && typeof assertedPayload === 'object'
    && !Array.isArray(assertedPayload) && Object.hasOwn(assertedPayload, 'reject')
    ? (assertedPayload as Record<string, unknown>).reject : undefined;
  const derivedReject = rawReject !== undefined && rawReject !== null
    && typeof rawReject === 'object' && !Array.isArray(rawReject)
    && typeof (rawReject as Record<string, unknown>).path === 'string'
    && !!(rawReject as Record<string, string>).path?.trim()
    && typeof (rawReject as Record<string, unknown>).text === 'string'
    && !!(rawReject as Record<string, string>).text?.trim()
    ? { path: (rawReject as Record<string, string>).path,
      text: (rawReject as Record<string, string>).text } : undefined;
  if (!isDeepStrictEqual(payload.reject, derivedReject))
    throw new Error('routed command reject changed');
  const parsedPayload: ParsedPayload = {
    ...(Object.hasOwn(asserted, 'payload') ? { payload: (asserted as CommandReceipt).payload } : {}),
    ...(payload.payloadError === undefined ? {} : { payloadError: payload.payloadError as string }),
    ...(payload.reject === undefined ? {} : { reject: payload.reject as unknown as RejectDirective }),
  };
  const rebuilt = buildReceipt(result as unknown as CommandPostrunResult, expected, parsedPayload);
  if (!isDeepStrictEqual(rebuilt, asserted)) throw new Error('routed command receipt changed');
  const bytes = canonicalValueBytes(rebuilt);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new Error('routed command receipt too large');
  // Retain a primitive string; each use obtains a fresh parsed copy. Neither
  // the role nor an asynchronous signer can mutate the retained bytes.
  const canonical = Buffer.from(bytes).toString('utf8');
  const frozenResult = JSON.parse(JSON.stringify(result)) as CommandPostrunResult;
  const frozenParsed = JSON.parse(JSON.stringify(parsedPayload)) as ParsedPayload;
  return { canonical, receipt: () => JSON.parse(canonical) as CommandReceipt,
    parsed: frozenParsed, result: frozenResult };
}
