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

Exactly five record classes are supported, each bound to one versioned
payload-type constant:

| constant | value |
|---|---|
| `PAYLOAD_TYPE_ENROLLMENT_GRANT` | `application/vnd.owenloop.enrollment-grant.v1+json` |
| `PAYLOAD_TYPE_REVOCATION` | `application/vnd.owenloop.revocation.v1+json` |
| `PAYLOAD_TYPE_SUBMISSION` | `application/vnd.owenloop.submission.v1+json` |
| `PAYLOAD_TYPE_POLICY_FLOOR` | `application/vnd.owenloop.policy-floor.v1+json` |
| `PAYLOAD_TYPE_ORIGIN` | `application/vnd.owenloop.origin.v1+json` |

`DSSE_RECORD_PAYLOAD_TYPES` is the frozen, exported runtime allow-list, and
`isDsseRecordPayloadType` is the exported guard. The generic
`dsseSignRecord` and `dsseVerifyRecord` wrappers apply that allow-list at
runtime: an arbitrary payload-type string, including an empty string or a
v2/attacker value, is rejected rather than accepted only by the TypeScript
union. The five fixed record wrappers use their own constants.

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
reference for the five launch contracts, their schemas, and the versioning
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

## Out of scope (future work)

- Key **rotation** and revocation wiring for stored principal keys.
- Certificate (`cert-authority`) chains and hardware-backed signing flows.
- A pure-JS signer for hot paths (the `Signer` seam is already in place).
- Threshold schemes beyond "N distinct trusted keys".
