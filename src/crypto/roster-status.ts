import { canonicalValueBytes } from './canonical.ts';
import { inspectEnrollmentChain } from './chain.ts';
import { decodeDsseEnvelope, PAYLOAD_TYPE_ENROLLMENT_GRANT, PAYLOAD_TYPE_REVOCATION } from './dsse.ts';
import { publicKeyDescriptor } from './keys.ts';
import type { EnrollmentGrantRecord, RevocationRecord } from './records.ts';
import { summarizeIssues, validateValue } from '../schema.ts';
import { enrollmentGrantSchema, revocationSchema } from '../schemas/index.ts';

type ListingStatus =
  | { kind: 'enrolled'; keyid: string; principal: string }
  | { kind: 'revocation'; keyid: string; effectiveFrom: number }
  | { kind: 'invalid' | 'unverifiable'; reason: string };

interface RosterSource {
  envelopes: unknown[];
  localGrants: Uint8Array[];
  localRevocations: Uint8Array[];
  orgRootPublicKey?: string;
  at: number;
}

function decodeRow(raw: unknown) {
  const envelope: unknown = typeof raw === 'string' || raw instanceof Uint8Array
    ? JSON.parse(Buffer.from(raw).toString('utf8'))
    : raw;
  const { payloadType, payloadBytes } = decodeDsseEnvelope(envelope);
  if (payloadType !== PAYLOAD_TYPE_ENROLLMENT_GRANT && payloadType !== PAYLOAD_TYPE_REVOCATION) {
    throw new Error('unexpected enrollment roster payload type');
  }
  const payload: unknown = JSON.parse(payloadBytes.toString('utf8'));
  const isGrant = payloadType === PAYLOAD_TYPE_ENROLLMENT_GRANT;
  const shape = validateValue(isGrant ? enrollmentGrantSchema : revocationSchema, payload);
  if (!shape.valid) throw new Error(`malformed enrollment roster record: ${summarizeIssues(shape.issues)}`);
  // Canonicalize only the outer JSON representation for local/relay equality.
  // The original DSSE payload and signature strings remain intact.
  const bytes = Buffer.from(canonicalValueBytes(envelope));
  if (isGrant) return { kind: 'grant' as const, keyid: (payload as EnrollmentGrantRecord).newKey.keyid, bytes };
  const cut = payload as RevocationRecord;
  return { kind: 'revocation' as const, keyid: cut.revokedKey, effectiveFrom: cut.effectiveFrom, issuer: cut.revokedBy, bytes };
}

/** Classify only the listed rows, in relay order. Local records can supply
 * missing links or revocations but cannot manufacture an entry in the listing. */
export async function enrollmentRosterStatuses(input: RosterSource): Promise<ListingStatus[]> {
  const grants = new Map<string, Buffer>();
  const revocations = new Map<string, Buffer>();
  const rows: ReturnType<typeof decodeRow>[] = [];
  try {
    for (const [kind, records] of [['grant', input.localGrants], ['revocation', input.localRevocations], ['relay', input.envelopes]] as const) {
      const seen = new Set<string>();
      for (const raw of records) {
	const row = decodeRow(raw);
	if (kind !== 'relay' && kind !== row.kind) throw new Error('local roster record has the wrong payload type');
	const identity = `${row.kind}:${row.keyid}`;
	const map = row.kind === 'grant' ? grants : revocations;
	const previous = map.get(row.keyid);
	if (seen.has(identity) || (previous && !previous.equals(row.bytes))) {
	  throw new Error(`ambiguous roster: multiple ${row.kind} records for '${row.keyid}'`);
	}
	seen.add(identity);
	map.set(row.keyid, row.bytes);
	if (kind === 'relay') rows.push(row);
      }
    }
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'malformed JSON in the enrollment roster' : (error as Error).message;
    return input.envelopes.map(() => ({ kind: 'invalid', reason }));
  }
  if (!input.orgRootPublicKey) return rows.map(() => ({ kind: 'unverifiable', reason: 'no local organization root is configured' }));
  let rootId: string;
  try {
    rootId = publicKeyDescriptor(input.orgRootPublicKey).keyid;
  } catch {
    return rows.map(() => ({ kind: 'unverifiable', reason: 'local organization root is malformed' }));
  }
  if (grants.has(rootId) || revocations.has(rootId)) {
    return rows.map(() => ({ kind: 'invalid', reason: 'the organization root cannot be a roster subject' }));
  }
  const material = { orgRootPublicKey: input.orgRootPublicKey, grants: [...grants.values()], at: input.at };
  const cuts = [...revocations.values()];
  const decisions = new Map<string, Awaited<ReturnType<typeof inspectEnrollmentChain>>>();
  async function currentChain(keyid: string) {
    let decision = decisions.get(keyid);
    if (!decision) {
      decision = await inspectEnrollmentChain({ ...material, targetKeyId: keyid, revocations: cuts });
      decisions.set(keyid, decision);
    }
    return decision;
  }

  const statuses: ListingStatus[] = [];
  for (const row of rows) {
    if (row.kind === 'grant') {
      const chain = await currentChain(row.keyid);
      statuses.push(chain.kind === 'verified'
	? { kind: 'enrolled', keyid: row.keyid, principal: `${chain.principal.kind}:${chain.principal.id}` }
	: { kind: chain.kind === 'revoked' ? 'invalid' : chain.kind, reason: chain.reason });
      continue;
    }
    // The issuer must still have authority. An independent cut below that
    // issuer may invalidate the subject's grant without invalidating this record.
    const issuer = await currentChain(row.issuer);
    if (issuer.kind !== 'verified') {
      statuses.push({ kind: issuer.kind === 'revoked' ? 'invalid' : issuer.kind, reason: issuer.reason });
      continue;
    }
    const cut = await inspectEnrollmentChain({ ...material, targetKeyId: row.keyid, revocations: [row.bytes] });
    if (cut.kind === 'verified' || cut.kind === 'revoked') {
      statuses.push({ kind: 'revocation', keyid: row.keyid, effectiveFrom: row.effectiveFrom });
    } else {
      statuses.push({ kind: cut.kind, reason: cut.reason });
    }
  }
  return statuses;
}
