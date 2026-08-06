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

Optional fields are `index`, `workdir`, `model`, `worker`, `spec`, `x`,
`consumedFingerprint`, `consumesProof`, and `cause`.

`defDigest` is a non-empty opaque reference. `inputs` and `outputs` are string
arrays. `consumes` is an open artifact-path map; `spec` and `x` are opaque
objects carried through without engine interpretation. `owes` contains the
owed path, judgment/schema rejection counters, reason entries, and an optional
opaque `proof` string. `cause`, when present, is `inputsGreen`, `allGreen`, or
`idle`.

The `consumedFingerprint`, when present, is an open artifact-path map whose values
are the non-negative versions captured when the engine claimed the order. The
producer covers the map in its `submission.v1` signature; a driver does not
recompute the map from consumed values.

`owes[].proof` remains unpopulated in this work package. `consumesProof` remains
a frozen string field, but its concrete encoding is a JSON-serialized map from
artifact path to serialized DSSE envelope:

```json
{"input":"{\"payloadType\":\"application/vnd.owenloop.submission.v1+json\",\"payload\":\"...\",\"signatures\":[...] }"}
```

The map lets one order carry proofs from multiple producers without changing
the frozen string slot. A hub stores each submit proof beside the committed
artifact version and omits paths with no stored proof; `consumesProof` never
contains null or empty-string entries. The `submission.v1` record shape itself
is unchanged.

## Trust posture

A hub or other remote coordinator is a transport, not an integrity authority.
A compromised transport may delay or stall progress, but a driver must verify
that executable instructions, shell commands, dynamic artifact values, and
trusted signer identities were not altered before acting on them. These wire
contracts carry the data needed for those later checks; this package does not
perform the checks itself.
