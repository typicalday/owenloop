# Wire contracts

This document describes the versioned records that cross an owenloop trust
boundary. The checked-in TypeScript definitions in `src/crypto/records.ts` and
the JSON Schemas in `src/schemas/` describe the same fields. The test suite
checks both directions: a field added to one side without the other fails the
build.

This package defines shapes only. Signing, verification, enrollment, revocation
processing, scope attenuation, origin recording, and policy evaluation are
separate responsibilities.

## DSSE envelope

The records use a DSSEv1 envelope with this shape:

```json
{
  "payloadType": "application/vnd.owenloop.submission.v1+json",
  "payload": "<base64 payload bytes>",
  "signatures": [{ "keyid": "<optional hint>", "sig": "<base64 signature>" }]
}
```

`payloadType` is part of the signed data. The type is bound to the record class,
so a valid signature for one class cannot be consumed as another class.
`payload` and `sig` are standard Base64 when produced. Verification accepts the
standard and URL-safe alphabets but rejects malformed encodings.

The DSSE pre-authentication encoding is:

```text
DSSEv1 SP len(typeBytes) SP typeBytes SP len(payloadBytes) SP payloadBytes
```

Both lengths are ASCII decimal **byte counts**. `typeBytes` is the UTF-8 byte
sequence for `payloadType`; the payload length is the exact number of payload
bytes. The length is not the number of characters in a string. This distinction
matters for non-ASCII payload types or payload data.

## Versioned payload types

The six bound records defined here use the existing media types:

| Record | Payload type |
| --- | --- |
| Enrollment grant | `application/vnd.owenloop.enrollment-grant.v1+json` |
| Revocation | `application/vnd.owenloop.revocation.v1+json` |
| Submission | `application/vnd.owenloop.submission.v1+json` |
| Policy floor | `application/vnd.owenloop.policy-floor.v1+json` |
| Origin | `application/vnd.owenloop.origin.v1+json` |
| Publication | `application/vnd.owenloop.publication.v1+json` |

Origin is a bound record class, not a label. Its source fields are signed
content in a separate DSSE envelope, and the hub or another relay cannot write,
derive, or default them.

A contract change that removes a field, makes an optional field required, or
narrows an accepted value is breaking. Such a change requires a new payload
type at `.v2`; do not edit the meaning of `.v1`. Adding an optional field whose
absence preserves the old meaning is compatible and may update `.v1`, but the
TypeScript type, field manifest, schema, fixtures, and documentation must move
together in one commit.

## Submission record

Payload type: `application/vnd.owenloop.submission.v1+json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `run` | yes | Workflow run identifier. |
| `workflow` | yes | Workflow instance identifier. |
| `defDigest` | yes | Non-empty opaque reference to the instruction snapshot. The resolver seam does not require a fixed digest alphabet. |
| `step` | yes | Producing step name. |
| `key` | yes | Binding key, including the empty key used by non-map firings. |
| `index` | no | Map/index position when the firing has one. |
| `produced` | yes | One or more produced values. |
| `consumedFingerprint` | yes | Open artifact-path map to the non-negative input version consumed at claim time. |
| `producerKeyId` | yes | `SHA256:<unpadded-base64>` fingerprint of the producer key. |
| `timestamp` | yes | Epoch milliseconds. |

Each `produced` entry has `artifact`, non-negative integer `version`, and a
lowercase SHA-256 `valueDigest`.

A driver signs only when the driver can name the exact artifact version without
inferring mutable coordinator state. A judge approval can use the judged path's
claim-time `consumedFingerprint` entry because the approval attests that existing
version and does not allocate a new version. A producer submit uses
`owes[].version`, the target version the hub issues for that owed output: the
version the next successful commit lands (claim-time committed version + 1), and
therefore the version the consumer supplies to `verifyConsumed` as
`expectedVersion`.

The target is retry-safe because the engine computes it inside the claim
transaction and persists it with the immutable order. Every read of that claim
returns the same number, so a refinement, a committed submit whose response was
lost, an unsigned commit, or a client process restart cannot move it. Refusal
paths that leave the run open do not bump the artifact, and a refinement is a
new claim with a newly issued target. A stale target fails the consumer's
version check — a refusal, never an admitted unverified value.

A target counts as authoritative only when it is a positive integer, since the
smallest commit a producer can land is v1. Given an absent target, a `0`, or a
non-integer, built-in clients submit the producer value without a proof rather
than sign a number the consumer is guaranteed to reject.

A consuming driver verifies the envelope before trusting the value. The
verified signer key must equal `producerKeyId`; the signed `produced[]` entry
must cover the requested artifact path; and the signed `valueDigest` and
`version` must match the delivered value and the consumer's claim-time version
when supplied. The driver then validates the producer's local enrollment chain,
revocations, and any supplied demand's scope. These checks belong to the
consuming driver, not the hub or another transport relay.

The built-in production `exec`, `agent-run`, and `hold` roles currently supply
no pool, label, or namespace demand, and `OrderPacket` has no demand field from
which to derive one. Production consume gates therefore enforce chain
termination, per-link signatures, attenuation, and revocation, but the
demand-dependent `scopePermits` restriction is currently vacuous. A verifier
caller that supplies a demand receives the full scope check. This is a named
follow-up, not hub-side trust.

### Deployed hub compatibility

The schema above is the target wire contract, not evidence that every deployed
hub carries every optional field. As of 2026-08-12, hub-core projects
`consumedFingerprint`, `owes[].proof`, and `consumesProof` onto served orders and
persists a client-supplied submit `proof` beside the committed artifact. It still
omits `owes[].version`, for two independent reasons: the pinned engine copy under
`packages/engine-do/vendor/` predates the field, and the served-order projection
in `packages/hub-core/src/reference-order.ts` allow-lists `path`,
`judgmentRejects`, `schemaRejects`, `reasons`, and `proof` without it. Both must
change, and the change must be deployed, before a served order names a target
version.

Client transport types keep these fields optional so one client remains
compatible with both a pre-target-semantics hub and a version-aware hub. Against
a hub that serves no `owes[].version`, a producer submit carries no proof, and a
command step consuming that artifact refuses it — the hard rule for command
steps is never relaxed to admit an unverified value.

## Publication record

Payload type: `application/vnd.owenloop.publication.v1+json`.

A publication record binds one signed statement to one canonical workflow
bundle. The `digest` is the lowercase 64-hex SHA-256 digest of the exact
uncompressed canonical tar inside the `.wnlp` bundle. The record is serialized
with the package's canonical JSON rules before DSSE signing; the signature does
not cover a gzip wrapper hash or a compiled-definition hash.

| Field | Required | Meaning |
| --- | --- | --- |
| `digest` | yes | Canonical bundle digest: lowercase 64-hex SHA-256 over the uncompressed canonical tar. |
| `name` | yes | Package name from the bundle manifest. |
| `version` | yes | Package version from the bundle manifest. |
| `publisherKeyId` | yes | Publisher public-key fingerprint in `SHA256:<unpadded-base64>` form. |
| `timestamp` | yes | Unix epoch milliseconds when the author created the publication record. |

The v1 publication object is closed: unknown properties are rejected. The
publication payload type is bound to this record by the runtime DSSE allow-list,
field manifest, and JSON Schema together.

## Origin record

Payload type: `application/vnd.owenloop.origin.v1+json`.

An origin record is a signed provenance statement for one canonical workflow
bundle. Its `digest` is the lowercase 64-hex SHA-256 digest of the exact
uncompressed canonical tar inside the `.wnlp` bundle. The origin and publication
records use the same digest and are signed inside the same signing scope with the
same signer, but each record has its own DSSE envelope and sidecar.

| Field | Required | Meaning |
| --- | --- | --- |
| `digest` | yes | Canonical bundle digest: lowercase 64-hex SHA-256 over the uncompressed canonical tar. |
| `name` | yes | Package name from the bundle manifest. |
| `version` | yes | Package version from the bundle manifest. |
| `source` | yes | Signed provenance union; one of the `git`, `console`, or `agent` forms below. |
| `attesterKeyId` | yes | Untrusted candidate-selection hint for the signing key; verification cross-checks it against the verified signer. |
| `timestamp` | yes | Unix epoch milliseconds when the author created the origin record. |

`source` is a closed discriminated union:

- `{ "kind": "git", "repo": "...", "commit": "..." }` records the
  explicitly supplied repository identifier and a 40- or 64-hex commit SHA.
- `{ "kind": "console", "user": "..." }` records the authoring user
  identity from a client-side signing ceremony.
- `{ "kind": "agent", "agent": "...", "session": "..." }` records the
  agent identity and session.

The source value is not derived by the hub. A caller supplies source data (for
example through `owenloop publish --source '<json>'`), and the signer signs the
resulting origin record. A remote coordinator stores or relays the signed record
but never authors, stamps, or completes the origin.

## Enrollment grant

Payload type: `application/vnd.owenloop.enrollment-grant.v1+json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `newKey` | yes | Public descriptor for the key being granted: `keyid`, `keyType`, `openSshPublicKey`, and optional `comment`. |
| `principal` | yes | `{ kind, id }`, where `kind` is `human`, `machine`, or `agent`. |
| `scope` | yes | Complete claim, production, publication, and delegation scope. |
| `grantedBy` | yes | Grantor key fingerprint in `SHA256:<unpadded-base64>` form. |
| `validFrom` | yes | Epoch milliseconds at which the grant becomes valid. |

`scope.pools`, `scope.labels`, and `scope.namespaces` are each either an array
of strings or the literal `"*"`. The empty array means no values; `"*"` means
every value. Each axis is required so a reader never has to guess a default.

`scope.delegation` is a discriminated union:

```json
{ "allowed": false }
```

or:

```json
{ "allowed": true, "maxDepth": 2 }
```

`maxDepth` is a non-negative integer or `"unbounded"`. A non-delegating grant
has no `maxDepth` field.

The wire record does not identify an organization or mark an org root. Chain
validation receives the org-root public key as a local trust anchor; the root
has no grant record. See [Enrollment chains, attenuation, and revocation](crypto.md#enrollment-chains-attenuation-and-revocation)
for chain termination, per-link signature verification, and scope attenuation.

## Revocation

Payload type: `application/vnd.owenloop.revocation.v1+json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `revokedKey` | yes | Key fingerprint being revoked. |
| `principal` | yes | `{ kind, id }` for the principal that owns the key. |
| `revokedBy` | yes | Signer key fingerprint. |
| `issuedAt` | yes | Epoch milliseconds when the record was issued. |
| `effectiveFrom` | yes | Epoch milliseconds at which the revocation cut applies. |
| `backdated` | yes | Explicit marker for a cut earlier than issuance. |
| `reason` | no | Human-readable explanation. |

A normal forward cut uses `effectiveFrom === issuedAt` and
`backdated: false`. Verification must cross-check the boolean against the two
timestamps. JSON Schema checks each field's individual shape, while the
cross-field consistency rule is verification-time logic. A backdated cut is
structurally visible so the verifier can apply the stronger signer rule without
inferring intent from clock arithmetic alone.

Revocation cuts apply forward. An artifact that was valid before the cut is not
retroactively changed solely because a later revocation record exists. The
validator also checks timestamp consistency, signer authority, and the
org-root-only rule for backdated cuts. See [Enrollment chains, attenuation, and revocation](crypto.md#enrollment-chains-attenuation-and-revocation)
for those verification rules.

## Policy floor

Payload type: `application/vnd.owenloop.policy-floor.v1+json`.

| Field | Required | Meaning |
| --- | --- | --- |
| `org` | yes | Organization identifier. |
| `issuedAt` | yes | Epoch milliseconds when the floor was issued. |
| `signedBy` | yes | Admin key fingerprint. |
| `floor` | yes | Normative minimum settings. |
| `preset` | no | Optional `L0`, `L1`, or `L2` label. |

`floor` always carries the four normative axes. `trustMode` is a frozen wire
value; this package carries the value but does not evaluate trust-mode behavior.
The exact accepted literals are pinned in
`src/schemas/policy-floor.v1.schema.json`. The other three axes use these
literals:

- `unsignedDefs`: `warn` or `refuse`;
- `unsignedArtifacts`: `warn` or `refuse`;
- `originRules`: `advisory` or `enforced`.

A floor is a minimum. A driver may require a stricter local policy, and a
relaying transport cannot use this record to weaken that local policy. The
transport relays the record; the transport is not the signer. `preset` is only
a label for a set of floor values, never a replacement for those values, so a
future preset can change without changing the required wire fields.

## Reference-mode Order

`Order` is the sixth launch contract. The existing `Order` interface in
`src/types.ts` is authoritative; this package adds a schema and a manifest but
does not declare a second `Order` interface.

Required fields are `run`, `workflow`, `step`, `key`, `defDigest`, `inputs`,
`outputs`, `consumes`, and `owes`.

Optional fields are `index`, `workdir`, `model`, `worker`, `judge`, `spec`, `x`,
`consumedFingerprint`, `consumesProof`, and `cause`. `workdir` may be authored
as a literal `workdir:` or resolved by the engine from a step's `workdirFrom:`,
whose stem names either a consumed artifact or a declared input; the Order wire
shape remains unchanged. No proof field covers `workdir` in any case.

`defDigest` is a non-empty opaque reference. `inputs` and `outputs` are string
arrays. `consumes` is an open artifact-path map; `spec` and `x` are opaque
objects carried through without engine interpretation. `owes` contains the owed
path, an optional target `version` (the version the next successful commit for
that path lands, issued inside the claim transaction), judgment/schema rejection
counters, reason entries, and an optional opaque `proof` string. `cause`, when present, is
`inputsGreen`, `allGreen`, or `idle`.

**Decision A — version cross-check without fingerprint recomputation.** The
`consumedFingerprint`, when present, is an open artifact-path map whose values
are the non-negative versions captured when the engine claimed the order. The
producer covers the map in its `submission.v1` signature. A driver enforces the
versions supplied in this map against signed `produced[].version`, but does not
recompute the producer's complete map from consumed values. A driver
distinguishes an absent map from a genuinely empty map: if the order has
consumed inputs but omits the map, the driver submits without a proof and emits
a warning; when independent authoritative output-version metadata is available,
an order with no consumed inputs may sign an explicitly empty `{}` map.

An explicit `{}` or partial map alongside a non-empty consumed set is still a
signed assertion of the map supplied on the wire. A consuming driver verifies
the supplied entries and enforces the versions that are present; the driver
does not recompute the producer's complete fingerprint map from values that
arrived in the same order. A hub that implements this target contract stores and relays the signed
content; the hub does not verify, repair, or authorize the assertion. The
current production hub does not yet implement that proof transport.

`consumesProof` is a JSON-serialized map from artifact path to serialized DSSE
envelope:

```json
{"input":"{\"payloadType\":\"application/vnd.owenloop.submission.v1+json\",\"payload\":\"...\",\"signatures\":[...] }"}
```

The map lets one order carry proofs from multiple producers without changing
the frozen string slot. In the target service protocol, the hub stores each
accepted submit proof beside the exact committed artifact version and omits
paths with no stored proof; `consumesProof` never contains null or empty-string
entries. The current production service does not provide that persistence or
projection. A consuming driver treats a missing entry as the `absent` verdict
and applies the configured artifact policy rather than stripping that artifact
from the order.

`owes[].proof`, when present, uses the same serialized DSSE envelope format. The
signed `submission.v1` record contains one `produced[]` entry for the owed path;
its `valueDigest` covers the complete `owes[].reasons` array at signing time.
A driver verifies the complete reason thread before any prompt renderer
truncates or summarizes the thread. The `submission.v1` record shape itself is
unchanged.

**Decision B — consumer-owned revocation anchor.** At consume time, the driver
samples its own clock once for the complete gate and evaluates revocations at
that instant. A producer-signed timestamp cannot move the `effectiveFrom <= at`
boundary; a timestamp ahead of the consumer clock is diagnostic only. A prior
successful consumption is not rewritten, but a later consumption can refuse the
same producer's artifact after a forward revocation cut.

## Trust posture

A hub or other remote coordinator is a transport, not an integrity authority.
A compromised transport may delay or stall progress, but a driver must verify
that executable instructions, shell commands, dynamic artifact values, and
trusted signer identities were not altered before acting on them. These wire
contracts carry the data needed for those checks; consume-side verification is
implemented at the consuming driver boundary and never delegated to the hub.

## Command payload and worker reject contracts

A command worker may emit one payload marker line on stdout:

```text
##owenloop:payload## {"...json..."}
```

The worker scans stdout lines and uses the last line whose marker starts at the
beginning of the line. A marker in the middle of a line is not a match. The JSON
text after the marker is capped at 64 KiB. A missing marker leaves `payload`
out of the `CommandReceipt`; malformed or over-cap JSON produces
`payloadError` and no `payload`, while leaving the command exit code unchanged.
When the hub supplies authoritative output-version metadata and the driver can
sign, the parsed payload is part of the receipt value covered by the DSSE
submission proof. Current producer command receipts are unsigned because the
deployed hub does not supply a retry-safe target version.

A worker rejects an artifact through the `reject` verb. The request is exactly:

```json
{"workflow":"<workflow>","run":"<run>","path":"<artifact stem>","text":"<reasons>"}
```

The request has no `by` field. The hub derives the rejecting step from the
claiming run. The response carries the common `text` field plus `ok` and an
optional `closed`; `closed: true` means the claiming run is already closed and
the holder must stop without releasing it again.
