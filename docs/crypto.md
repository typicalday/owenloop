# Signing and key storage (WP-A2)

The engine's public crypto surface: **principal signing keys**, **SSHSIG
signing/verification**, and **DSSE envelopes**. Everything here is exported
from the package entry (`src/crypto/index.ts`), covered by the `test/crypto-*.test.ts`
suites, and interoperates with stock OpenSSH `ssh-keygen` on macOS and Linux CI.

## Why stock OpenSSH, not a JS signature library

Signatures are produced and verified by **stock `ssh-keygen -Y`** (`sign` and
`verify`), not by a JavaScript crypto library. Every invocation uses
`shell: false` with an argument vector, through an injected process seam. The
signer also uses stock `ssh-keygen -y` to derive the public half of a private
key, and the feature probe invokes a harmless `-Y` command through the same
seam. Callers depend on the format-neutral `Signer` interface rather than on
this OpenSSH implementation. Three reasons:

1. **Format neutrality for free.** SSHSIG's armored format, namespace binding,
   and `allowed_signers` policy are implemented by OpenSSH itself; delegating
   means the policy authority is the same binary every operator already trusts
   for SSH. There is no custom authorization logic to keep in sync.
2. **Private material stays out of process interfaces.** The message rides on
   child stdin, the private key is referenced only by a filesystem path in
   `ssh-keygen` argv, and the armored signature is the only signing output
   captured. Generated private bytes may exist transiently in the manager while
   a record is written or a temporary signing file is materialized; the public
   API never returns those bytes, and private bytes never appear in argv,
   stdout, stderr, logs, thrown errors, or test snapshots.
3. **Portability cost is bounded and testable.** The requirement is one
   binary — `ssh-keygen` with `-Y` support (OpenSSH 8.1+, present on macOS
   and every mainstream Linux distro). When it is absent, crypto features fail
   loudly instead of silently degrading; the test suites skip interop cases
   with a named reason.

Private key bytes never appear in a repository, process arguments, stdout,
stderr, logs, thrown errors, or test snapshots. No public API returns a private
key; APIs return public descriptors or short-lived filesystem paths only.

The trade-off: every sign/verify spawns a child process (tens of
milliseconds). That is acceptable for the trust-surface call rates this layer
serves; a hot-path pure-JS signer can be added later behind the same `Signer`
interface without touching callers.

## The `Signer` interface

`Signer` is the format-neutral seam DSSE verification programs against:

- `sign(exactBytes: Buffer) → Promise<SignatureResult>` — sign the exact bytes
  (a pre-auth encoding); returns `{ keyid, sig }`.
- `verify(bytes: Buffer, sig: Buffer) → Promise<VerifiedSignature | null>` —
  `null` means "not this signer's signature" (a cryptographic miss), never an
  exception. A hit returns `{ keyid, principal, format }`.

`SshSigner` (created via `createSshSigner({ namespace, signKeyPath, verify })`)
is the stock-OpenSSH implementation. `verify` has the shape
`{ principal, allowedSignersText }`; omit `signKeyPath` for verify-only use, or
omit `verify` for sign-only use. Its configuration (`SshSignerConfig`) and
process seam (`SshProcessAdapter`) are exported for hermetic tests; production
callers use the defaults. All errors are `SshSignerError` with fixed messages —
child stderr is never interpolated into error text.

## Key lifecycle and storage selection

`PrincipalKeyManager` owns one Ed25519 key per **principal key ref** —
`{ origin, kind, id }` where `kind` is one of the three local principals:

| kind | id |
|---|---|
| `human` | the hub actor id (`whoami.actor.id`) |
| `machine` | the literal `"local"` |
| `agent` | the agent identity id |

`owenloop setup` step `[4/7] signing keys` ensures all three, in that order,
idempotently: a second run performs zero writes.

**One backend is selected once and never error-fallback.** A fallback after a
selected store fails could create two different private keys for the same
principal — a shadow identity. Selection:

1. **macOS:** `security` generic-password entries (service `owenloop-signing`,
   account = SHA-256 of the canonical ref).
2. **Linux:** `secret-tool` (libsecret) when the executable is on `PATH`.
3. **Otherwise:** one atomic `0600` record file under
   `$HOME/.owenloop/keys/<hash>.json`, with `$HOME/.owenloop` and `keys`
   forced to `0700`; symlinked or non-directory paths are refused.

`OWENLOOP_NO_KEYCHAIN=1` forces the file backend on any platform — the same
explicit override the credential store honors. A `secret-tool lookup` exit
status of `1` means that the item is not found, not that libsecret failed; any
other nonzero lookup status is a backend failure. A failing selected backend
produces a fixed `signing-key storage (<backend>) failed: …` error and setup
stops. The manager does not error-fallback to another backend.

**Secrets never ride on argv or pipes.** Store writes pass the record on child
**stdin**; lookups redirect the secret-bearing stdout straight into a
pre-opened `0600` temp file descriptor. Nothing captures the secret into a
pipe, log, or error message.

`ensure(ref)` is serialized per ref by a file lock
(`$HOME/.owenloop/keys/<hash>.lock`): acquire → re-read → generate only when
still absent, so concurrent setups generate exactly once.

`inspect(ref)` returns only non-secret state, but validation of a generated
record is not a zero-byte operation: the manager temporarily writes the stored
private material to a `0600` file in a `0700` directory, runs stock
`ssh-keygen -y`, compares the derived public key and fingerprint, and removes
the directory in `finally`. The private text never appears in the inspection
result or in an exception.

### Materialization

`withSigningKey(ref, callback)` hands the callback a **path** to a usable
private key and nothing more: a generated key materializes as a `0600` file in
a unique `0700` temp dir and is removed in `finally`; a reused key passes only
its canonical path. No API returns private-key text.

### Publish-time signing

`owenloop publish` signs locally with the human principal key selected by the
project's bound hub origin. The signing chain is deliberately narrow:

1. `resolveRef(origin, 'human')` discovers the non-secret principal reference
   from the local `<hash>.ref` pointer.
2. `inspect(ref)` read-only-confirms that setup already stored the key and
   returns only its public descriptor, including the `publisherKeyId`
   fingerprint. `publish` never calls `ensure`: publishing never creates or
   repairs a signing key. During setup, an older key record created before ref
   pointers existed is backfilled without changing the existing key.
3. `withSigningKey(ref, callback)` materializes the private key only for the
   callback's controlled lifetime.
4. `createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath })` probes and
   constructs the stock-OpenSSH signer.
5. `dsseSignPublication(payloadBytes, signer)` signs the canonical JSON bytes of
   the publication record under `application/vnd.owenloop.publication.v1+json`.
6. When `--source` is present, `dsseSignOrigin(originPayloadBytes, signer)` signs
   the canonical JSON bytes of a separate origin record under
   `application/vnd.owenloop.origin.v1+json`, using the same signer object and
   signing scope as the publication record.

Both records bind the 64-hex SHA-256 digest of the uncompressed canonical tar
returned by `packBundle`. The signer is constructed and the records are signed
before `publish` writes the `.wnlp` bundle or any sidecar. Signed output writes
the publication sidecar and, when `--source` is present, `<bundle>.origin.dsse`.
A publish without `--source` removes a stale origin sidecar; unsigned publish
also removes one because an unsigned origin would only be an unsigned label.
The hub is only a remote coordinator recorded by the project binding. The hub
stores or relays signed records but never signs, authors, derives, or defaults
origin data and cannot produce or complete either author signature.

The three origin source kinds are `git` (explicit repository identifier and
commit SHA), `console` (authoring user identity from a client-side signing
ceremony), and `agent` (agent identity and session). `attesterKeyId` is used only
to select verification candidates; verification cross-checks the hint against
the signer in the verified DSSE envelope.

### Submit-time signing

Remote drivers sign each `submit` at the driver boundary, before sending the
request to a hub. The key reference is `{ origin, kind: 'machine', id: 'local' }`.
The driver reads the public fingerprint with `inspect`, materializes the private
key only inside `withSigningKey`, builds the frozen `submission.v1` record, and
signs its canonical JSON payload with `dsseSignSubmission` under the
`owenloop-dsse-v1` namespace. The `proof` request field is the serialized DSSE
envelope for that one submitted artifact path.

The engine does not sign: local `Engine.green` is synchronous and commits inside
a synchronous store transaction. The hub does not sign: the hub stores the
opaque envelope beside the artifact version and relays the envelope on later
orders. `owenloop green` remains deliberately unsigned because local green does
not cross a wire; moving the command to an asynchronous signing path would add
no trust coverage. A driver without a configured machine key submits without a
proof and emits one warning per process; later policy work decides whether that
fallback becomes refusal.

#### Canonical submission values

`canonicalValueBytes(value)` recursively sorts plain-object keys, preserves array
order, applies each object's `toJSON(key)` hook with the same key semantics as
`JSON.stringify`, and emits separator-tight UTF-8 JSON. `valueDigestHex(value)`
is the lowercase SHA-256 digest of those bytes. The canonical bytes make a
produced-value digest reproducible after the value crosses the JSON submit
transport; the driver signs the same canonical record representation that the
wire envelope carries.

Canonicalization fails loudly with `TypeError` when a value cannot be represented
faithfully. `Map`, `Set`, `RegExp`, class instances with fields, non-finite
numbers (`NaN`, `Infinity`, and `-Infinity`), `bigint`, and circular references
are rejected rather than silently becoming `{}` or another lossy value. A
submission record also rejects an empty `produced` list and negative or
non-integer artifact versions.

`buildSubmissionRecord` constructs the frozen `submission.v1` shape without
signing. `signSubmission` canonicalizes that record, signs the payload as a DSSE
submission envelope, and returns the serialized opaque proof sent with one
artifact submission.

### Reusing an existing SSH key (human only)

`setup --reuse-ssh-key <path>` records the operator's own Ed25519 key for the
**human** principal instead of generating one. Before recording, the candidate
is validated with a non-secret sign/verify challenge against its own public
key (works for a private-key path, or a public-key path whose private half is
in ssh-agent). The record stores only the canonical `realpath` + public key + fingerprint —
the private bytes are never copied. For a private-key path, the public half is
derived with stock `ssh-keygen -y`; an adjacent `.pub` file is not trusted as
the identity source. Before every later signing callback, the manager resolves
the path again and checks that the current Ed25519 fingerprint still matches the
stored fingerprint.

Rules:

- **Human-only.** Machine and agent principals always get generated keys.
- **No rotation.** Passing `--reuse-ssh-key` when a human key already exists
  is a hard conflict error; the existing key is kept.
- **Ed25519 only** in this work package.

## WP-D1 machine enrollment grants

WP-D1 registers a machine public key in a signed organization roster. The
machine key is not the grantor. The local human principal signs a frozen
`EnrollmentGrantRecord` whose `newKey` is the machine's public descriptor:

```ts
{
  newKey: { keyid, keyType, openSshPublicKey, comment },
  principal: { kind: 'machine', id: 'local' },
  scope: {
    pools: '*',
    labels: '*',
    namespaces: [],
    delegation: { allowed: false },
  },
  grantedBy: '<human SHA256 fingerprint>',
  validFrom: <milliseconds since Unix epoch>,
}
```

`buildEnrollmentGrant` performs no I/O and never reads a private key. The
builder copies and freezes the public descriptor, principal, scope arrays, and
delegation object. `DEFAULT_MACHINE_SCOPE` is the least-privilege D1 scope
shown above: unrestricted pool and label matching for the machine's own
operation, no namespace grants, and delegation denied. The frozen wire shape
is specified in [`docs/wire-contracts.md`](wire-contracts.md); WP-D1 does not
change that contract.

### Local roster verification

`verifyRosterEntry` verifies a relayed envelope in a fixed trust order:

1. Decode and validate the DSSE envelope and enrollment-grant payload.
2. Resolve the grantor key named by `grantedBy` from the local
   `allowed_signers` trust root.
3. Verify the DSSE signature and cross-check the authenticated signer key ID
   against `grantedBy`.
4. Call the optional `EnrollmentChainValidator` seam.

The public result is one of four explicit states:

| verdict | meaning |
|---|---|
| `enrolled` | payload, schema, signature, local signer authorization, and chain validation all succeeded; `keyid` is the enrolled machine fingerprint and `principal` is the authenticated signer principal |
| `unenrolled` | no envelope was supplied |
| `unverifiable` | a trust prerequisite is absent, including no local `allowed_signers` root or no installed chain validator |
| `invalid` | the envelope, payload, schema, signer authorization, signature, or chain-validator result failed |

The chain seam is deliberately narrow:

```ts
interface EnrollmentChainValidator {
  validate(
    grant: EnrollmentGrantRecord,
    verifiedSignerKeyId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}
```

WP-D1 fails closed when `chainValidator` is absent. A valid signature proves
which key signed the grant; a signature does not prove that the signer chains
to the organization root. WP-D4 owns chain validation, attenuation, revocation,
and root trust. Until WP-D4 installs the validator, D1 entries remain
`unverifiable`, never `enrolled`.

The hub receives and relays the signed envelope only. The hub never receives a
private key, creates a grant, signs a grant, or endorses a grant. Setup's
registration path signs with `PrincipalKeyManager.withSigningKey`, so private
bytes remain inside the local key-manager callback and only `{ envelope }` is
sent over HTTP.

## DSSE envelopes

Records that cross a trust boundary are wrapped in [DSSE](https://github.com/secure-systems-lab/dsse)
envelopes. The pre-auth encoding the signature covers:

```
DSSEv1 SP len(typeBytes) SP typeBytes SP len(payloadBytes) SP payloadBytes
```

`typeBytes` is the UTF-8 encoding of the payload type; `payloadBytes` is the
exact binary payload. Both lengths are ASCII decimal byte counts. Base64 on the
wire is decoded strictly — standard **and** URL-safe alphabets accepted,
malformed input rejected — because Node's built-in decoder is permissive.
SSHSIG signs and verifies this encoding under the namespace
`owenloop-dsse-v1` (`DSSE_SSH_NAMESPACE`).

Exactly six launch payload types are supported by the DSSE framing, and all six
are bound record classes in this package:

| constant | value |
|---|---|
| `PAYLOAD_TYPE_ENROLLMENT_GRANT` | `application/vnd.owenloop.enrollment-grant.v1+json` |
| `PAYLOAD_TYPE_REVOCATION` | `application/vnd.owenloop.revocation.v1+json` |
| `PAYLOAD_TYPE_SUBMISSION` | `application/vnd.owenloop.submission.v1+json` |
| `PAYLOAD_TYPE_POLICY_FLOOR` | `application/vnd.owenloop.policy-floor.v1+json` |
| `PAYLOAD_TYPE_ORIGIN` | `application/vnd.owenloop.origin.v1+json` |
| `PAYLOAD_TYPE_PUBLICATION` | `application/vnd.owenloop.publication.v1+json` |

`DSSE_RECORD_PAYLOAD_TYPES` is the frozen, exported runtime allow-list, and
`isDsseRecordPayloadType` is the exported guard. The generic
`dsseSignRecord` and `dsseVerifyRecord` wrappers apply that allow-list at
runtime: an arbitrary payload-type string, including an empty string or a
v2/attacker value, is rejected rather than accepted only by the TypeScript
union. The six fixed wrappers use their own constants; the publication wrapper
is `dsseSignPublication` / `dsseVerifyPublication`.

`dsseVerifyEnvelope` runs a fixed order — Base64 decode → PAE → signature
verification → payload-type check — and returns the payload bytes **exactly**.
A failed verification throws `DsseEnvelopeError`; a successful verification of
an empty payload returns a result with `payloadBytes.length === 0` and verified
signers, so the two outcomes are unambiguous. Malformed shapes also throw
`DsseEnvelopeError`. Duplicate signatures from the same trusted key count once;
a `threshold` option requires that many distinct signers.

## Wire record shapes

The record shapes that ride these DSSE envelopes are documented in
[`docs/wire-contracts.md`](wire-contracts.md). That document is the public
reference for the six bound record contracts, their schemas, and the versioning
rule.

## The role of `allowed_signers`

`parseAllowedSigners` parses the stock OpenSSH `allowed_signers` format
(principals, one comma-separated options field, key type, standard Base64 blob,
and trailing comment) **structurally**. The supported option syntax is
`cert-authority`, `namespaces="..."`, `valid-after="..."`, and
`valid-before="..."`; assignment values must use the stock quoted form.
`touch-required` is rejected because it is not a stock option supported by the
OpenSSH verifier used here. Repeated `cert-authority` options and empty option
slots between commas are retained as stock-tolerated syntax; a trailing comma
still produces a parse error. Quotes in a trailing comment are opaque after the
key blob and do not affect option parsing. The parser never throws: malformed
lines come back with their line numbers alongside the well-formed entries. It
deliberately does **not** implement OpenSSH pattern matching or authorization —
`ssh-keygen -Y verify` remains the policy authority, and accepted policy text is
fed back to it unchanged.

The Ed25519 rule applies to the key actually used for the operation, not to
every entry in the policy file. `SshSigner.sign` refuses a non-Ed25519 signing
key. During verification, OpenSSH may select an Ed25519, RSA, or ECDSA entry
from a mixed `allowed_signers` policy; `SshSigner` accepts the policy file but
refuses a successful verification when the key embedded in the verified
signature is not Ed25519. The policy file is not globally restricted to
Ed25519 entries.

### Known parser differences from stock OpenSSH

`parseAllowedSigners` is line-tolerant, but `SshSigner.verify` currently
rejects the **entire** policy file when any line produces a parse error (or when
no entries parse). Stock OpenSSH skips an unparseable line and continues with
other lines. This is a known pre-existing divergence, including realistic
`touch-required` and `verify-required` option lines; the line-tolerant parser
result must not be read as equivalent to successful `SshSigner` verification.

The structural parser also does not cross-check the declared key type against
the key type embedded in the Base64 public-key blob. Parsed `principals` retain
literal surrounding quotes where stock OpenSSH strips them. These fields are
structural output only; OpenSSH remains the authorization authority.

## Definition publication policy

The install path verifies the mutually exclusive publication sidecars written by
`publish`: `<bundle>.wnlp.dsse` or `<bundle>.wnlp.unsigned`. A signed publish may
also write the optional `<bundle>.origin.dsse` sidecar. The publication `.dsse`
sidecar is checked against the bundle digest and the local `allowed_signers`
trust root. Origin verification is separate: `verifyOrigin` returns `absent`
when the origin sidecar is missing, `verified` only after DSSE signature, schema,
signer-key, and bundle-digest checks pass, and `unverifiable` or `invalid` for
the corresponding failures. The trust-root path is
`$XDG_CONFIG_HOME/owenloop/allowed_signers` when
`XDG_CONFIG_HOME` is non-blank, or `$HOME/.config/owenloop/allowed_signers`
otherwise. A missing or malformed trust root produces the distinct
`unverifiable` verdict; a present signature that fails verification produces
`invalid`.

The execution and install policy is `defPolicy`, with built-in default `warn`.
Set `defPolicy` in the JSON settings file at
`$XDG_CONFIG_HOME/owenloop/settings.json` (or
`$HOME/.config/owenloop/settings.json`), for example:

```json
{
  "defPolicy": "enforce"
}
```

`OWENLOOP_DEF_POLICY` overrides the settings file for a CLI invocation. The
precedence is explicit host-provided policy, then the environment, then the
settings file, then `warn`. An invalid policy value fails loudly rather than
weakening trust. The install-time and execution-time outcomes for `enforce`,
`warn`, and `off` are listed in [`docs/cli.md`](cli.md#definition-publication-policy).

`enforce` refuses unsigned and unverifiable definitions. `warn` warns and
permits those two verdicts for installation and agent work. `off` permits those
two verdicts silently for installation and agent work. `invalid` is refused at
every policy value. **Command workers always require `verified`; `off` never
relaxes that hard rule.** An execution resolver without a configured
publication verifier treats the definition as `unverifiable`, so command
workers refuse rather than assuming that integrity verification alone proves
publication trust.

The verifier does not write a verdict or sidecar into the immutable object
directory. The object remains governed by the bundle manifest integrity map.

## Enrollment chains, attenuation, and revocation

Enrollment trust is separate from publication-signature trust. A key is trusted
if and only if its enrollment chain terminates at the supplied local
organization-root anchor. A hub or other remote coordinator may relay signed
envelopes, but a remote assertion cannot make a key trusted.

`validateEnrollmentChain` is the pure validator. Its input contains the target
key ID, the org-root public-key text, signed grant envelopes, optional signed
revocation envelopes, and an explicit validation instant `at` in epoch
milliseconds. Every grant link is verified separately with a signer whose
`allowed_signers` text contains exactly that link's parent key. A roster entry
without a grant, a cycle, an ambiguous duplicate grant, or a chain that stops
before the anchor is `invalid`; the validator never picks a convenient chain.
A grant is also checked for its `validFrom` time and for the Ed25519 key type.

The org root is an injected local anchor, not a wire field. Neither an
`EnrollmentGrantRecord` nor a `RevocationRecord` contains an `org` field, and
the root has no grant record. The walk terminates when the current key ID
matches the key ID derived from the supplied anchor; that absence of a grant is
what makes the key the root. Asking to validate the root itself succeeds at
depth zero with `ORG_ROOT_SCOPE`.

The result has three states:

| verdict | meaning |
|---|---|
| `verified` | the chain reaches the local anchor, every link verifies, and all scope and revocation checks pass |
| `unverifiable` | a local prerequisite cannot be used, such as a missing or malformed anchor or unusable `ssh-keygen` |
| `invalid` | the supplied roster or revocation set is well-formed but does not establish the requested trust |

There is no `unsigned` chain verdict. An absent grant for a non-root target is
an invalid chain, not an unsigned one. `validateProducer` runs the same chain
validation and then checks a requested `{ pool?, label?, namespace? }` demand
against the target's effective scope.

### Scope attenuation

A child grant may be narrower than its parent's effective grant, never wider.
For each of `pools`, `labels`, and `namespaces`, the containment rule is:

| parent | child | result |
|---|---|---|
| `"*"` | any array or `"*"` | permitted |
| string array | `"*"` | rejected as widening |
| string array | string array | permitted only when every child value is in the parent array |

An empty array is distinct from `"*"`: an empty array permits no values. The
delegation limit attenuates separately. A parent with delegation disabled cannot
sign a grant; an unbounded parent may delegate any child scope; a numeric parent
with `maxDepth: N` may sign a non-delegating child or a child with numeric
`maxDepth: M` where `M <= N - 1`. A numeric parent never permits an unbounded
child. The org root starts with `ORG_ROOT_SCOPE`: all three axes are `"*"` and
delegation is unbounded.

### Revocation

Validation applies signed revocations at the explicit `at` instant. A verified
revocation whose `effectiveFrom <= at` kills the named key, and a chain with a
dead link is invalid. Because descendants must walk through their ancestors,
revocation cascades forward transitively without a separate descendant pass.
A grant or artifact evaluated at an earlier `at` remains valid before the cut;
revocation is forward-only.

The revocation signer must be the org root or an ancestor of the revoked key
whose delegation scope allows delegation. A backdated revocation
(`effectiveFrom < issuedAt`) is org-root-only and is reported through the
validator's injected backdated-revocation sink. The `backdated` field must agree
with the timestamp comparison before signer authority is considered. A
revocation of the org root itself is invalid rather than silently disabling the
whole organization.

### Local anchor and envelope files

The optional filesystem loader derives paths from injected environment state:
`XDG_CONFIG_HOME` wins over `HOME`; there is no ambient home-directory lookup.
The local layout is:

```text
<config>/owenloop/org-root.pub                     # public anchor, 0644
<config>/owenloop/org-root                         # private anchor, 0600
<config>/owenloop/roster/<sha256hex(keyid)>.grant.dsse
<config>/owenloop/revocations/<sha256hex(keyid)>.revocation.dsse
```

The root key is stored outside `PrincipalKeyManager` because the root is not a
hub-scoped principal key. The containing directory is `0700`; the private root
is never returned by the library or placed in an envelope. `loadRoster` and
`loadRevocations` return raw envelope bytes to the pure validator and refuse
symlinked or non-regular files.

## Admin-signed policy floors

A policy floor is an org-wide minimum for local enforcement. An org admin signs
one DSSE record with payload type
`application/vnd.owenloop.policy-floor.v1+json`. A driver verifies the exact
record against local trust material before using the record:

1. The DSSE envelope and policy-floor schema must verify.
2. The authenticated signer key must be present in the local enrollment
   material, and the signer's enrollment chain must terminate at the local
   organization-root anchor. Revocations are evaluated at the supplied
   validation instant.
3. The signer's effective scope must be unrestricted on all three axes:
   `pools`, `labels`, and `namespaces` must each be `"*"`. Under scope
   attenuation, that is genuine organization-wide admin scope; a narrower key
   cannot sign an organization-wide floor.

A hub or other remote coordinator relays the signed record but never authors,
derives, weakens, or signs the floor. The relaying transport is not a trust
anchor.

### Monotone merge with local policy

A verified floor can only raise local strictness, never lower it. The driver
maps the floor's `unsignedDefs` axis into the existing `defPolicy` vocabulary:

| floor `unsignedDefs` | minimum local `defPolicy` |
|---|---|
| `warn` | `warn` |
| `refuse` | `enforce` |

The effective policy is the stricter of local policy and the floor minimum:
`off < warn < enforce`. The floor vocabulary has no value that maps to `off`,
so a floor is structurally unable to lower policy. In particular, local `off`
plus a verified floor produces at least `warn`; the local operator cannot opt
out of that org floor.

### Failure behavior and current limits

Absence is never permission. A missing or failed floor supplies no floor to the
merge, so the driver's local policy remains exactly unchanged. For a delivered
envelope, verification reports `invalid` or `unverifiable` instead of throwing
for every failure path:

| situation | result |
|---|---|
| no floor delivered | local policy unchanged; no floor is merged |
| malformed envelope or payload, including wrong payload type or schema failure | `invalid`; local policy unchanged |
| unsigned floor or signature that does not verify | `invalid`; local policy unchanged |
| signer chain does not terminate at the local org root | `invalid`; local policy unchanged |
| signer lacks unrestricted admin scope | `invalid`; local policy unchanged |
| signer key is revoked at the validation instant | `invalid`; local policy unchanged |
| local org-root anchor or other verification prerequisite is unavailable | `unverifiable`; local policy unchanged |

The frozen floor has four axes, but this package has an enforcement mechanism
for only one axis, `unsignedDefs` → `defPolicy`:

| axis | current state |
|---|---|
| `unsignedDefs` | mapped into `defPolicy` and enforced |
| `trustMode` | accepted and carried, but not evaluated |
| `unsignedArtifacts` | accepted and carried, but no enforcement mechanism exists yet |
| `originRules` | accepted and carried, but no enforcement mechanism exists yet |

The merge result names the three unenforced axes in `gaps` rather than silently
dropping them. Both current integration call sites — installation and
execution — discard `.gaps`, so callers do not currently surface those
warnings. An administrator can therefore set a floor believing that
`trustMode`, `unsignedArtifacts`, or `originRules` is enforced when the axis is
not enforced. The feature is not wired into production configuration: the
`policyFloor` option is an injection seam only, so the feature is inert until a
host loads and verifies a floor and passes it through that seam.

L0, L1, and L2 are documented bundles of concrete floor values, not alternate
policy primitives:

| preset | `trustMode` | `unsignedDefs` | `unsignedArtifacts` | `originRules` |
|---|---|---|---|---|
| L0 | `seamless` | `warn` | `warn` | `advisory` |
| L1 | `seamless` | `refuse` | `refuse` | `advisory` |
| L2 | `strict` | `refuse` | `refuse` | `enforced` |

The preset values for the three unenforced axes are still only carried and
reported as gaps in this package.

**Command-worker hard rule.** A `worker: command` order still requires full
enforcement: a verified definition, a verified enrollment chain, and a
scope-checked signer. The gate runs before the floor-derived policy value is
read and fails closed regardless of local policy, including `off`, and
regardless of any floor. A floor cannot relax this rule.

## Out of scope (future work)

Publish-time author-side DSSE signing is implemented by `owenloop publish`.
Transport relay and the following extensions remain out of scope:

- Key **rotation** wiring for stored principal keys.
- Certificate (`cert-authority`) chains and hardware-backed signing flows.
- A pure-JS signer for hot paths (the `Signer` seam is already in place).
- Threshold schemes beyond "N distinct trusted keys".
