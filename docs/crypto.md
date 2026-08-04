# Signing and key storage (WP-A2)

The engine's public crypto surface: **principal signing keys**, **SSHSIG
signing/verification**, and **DSSE envelopes**. Everything here is exported
from the package entry (`src/crypto/index.ts`), covered by the `test/crypto-*.test.ts`
suites, and interoperates with stock OpenSSH `ssh-keygen` on macOS and Linux CI.

## Why stock OpenSSH, not a JS signature library

Signatures are produced and verified by **shelling out to stock `ssh-keygen
-Y`** (`sign`, `verify`, `check-novalidate`, `find-principals`), not by a
JavaScript crypto library. Three reasons:

1. **Format neutrality for free.** SSHSIG's armored format, namespace binding,
   and `allowed_signers` policy are implemented by OpenSSH itself; delegating
   means the policy authority is the same binary every operator already trusts
   for SSH. There is no custom authorization logic to keep in sync.
2. **No secret scalar in the Node heap.** Signing runs in a child process
   whose stdin carries the message and whose stdout carries the armored
   signature. Private bytes live inside `ssh-keygen`'s address space, not
   ours.
3. **Portability cost is bounded and testable.** The requirement is one
   binary — `ssh-keygen` with `-Y` support (OpenSSH 8.1+, present on macOS
   and every mainstream Linux distro). When it is absent, crypto features fail
   loudly instead of silently degrading; the test suites skip interop cases
   with a named reason.

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

`SshSigner` (created via `createSshSigner({ keyPath, principal, ... })`) is
the stock-OpenSSH implementation. Its configuration (`SshSignerConfig`) and
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
explicit override the credential store honors. A failing backend produces a
fixed `signing-key storage (<backend>) failed: …` error and setup stops.

**Secrets never ride on argv or pipes.** Store writes pass the record on child
**stdin**; lookups redirect the secret-bearing stdout straight into a
pre-opened `0600` temp file descriptor. Nothing captures the secret into a
pipe, log, or error message.

`ensure(ref)` is serialized per ref by a file lock
(`$HOME/.owenloop/keys/<hash>.lock`): acquire → re-read → generate only when
still absent, so concurrent setups generate exactly once.

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
in ssh-agent). The record stores only the canonical path + public key +
fingerprint — the private bytes are never copied.

Rules:

- **Human-only.** Machine and agent principals always get generated keys.
- **No rotation.** Passing `--reuse-ssh-key` when a human key already exists
  is a hard conflict error; the existing key is kept.
- **Ed25519 only** in this work package.

## DSSE envelopes

Records that cross a trust boundary are wrapped in [DSSE](https://github.com/secure-systems-lab/dsse)
envelopes. The pre-auth encoding the signature covers:

```
"DSSEv1" SP LEN(type) SP type SP LEN(payload) SP payload
```

(lengths are decimal byte counts of the UTF-8/binary fields). Base64 on the
wire is decoded strictly — standard **and** URL-safe alphabets accepted,
malformed input rejected — because Node's built-in decoder is permissive.

Five versioned payload types, one per signed record class:

| constant | value |
|---|---|
| `PAYLOAD_TYPE_ENROLLMENT_GRANT` | `application/vnd.owenloop.enrollment-grant.v1+json` |
| `PAYLOAD_TYPE_REVOCATION` | `application/vnd.owenloop.revocation.v1+json` |
| `PAYLOAD_TYPE_SUBMISSION` | `application/vnd.owenloop.submission.v1+json` |
| `PAYLOAD_TYPE_POLICY_FLOOR` | `application/vnd.owenloop.policy-floor.v1+json` |
| `PAYLOAD_TYPE_ORIGIN` | `application/vnd.owenloop.origin.v1+json` |

`dsseVerifyEnvelope` runs a fixed order — Base64 decode → PAE → signature
verification → payload-type check — and returns the payload bytes **exactly**;
a cryptographic miss yields zero signers (not an error), while malformed
shapes throw `DsseEnvelopeError`. Duplicate signatures from the same trusted
key count once; a `threshold` option requires that many distinct signers.
SSHSIG signatures are produced and verified under the namespace
`owenloop-dsse-v1` (`DSSE_SSH_NAMESPACE`).

## The role of `allowed_signers`

`parseAllowedSigners` parses the stock OpenSSH `allowed_signers` format
(principals, options — `cert-authority`, `touch-required`, `namespaces=`,
`valid-after=`, `valid-before=` — key type, blob, comment) **structurally**:
it never throws, reporting malformed lines with their line numbers alongside
the well-formed entries. It deliberately does **not** implement OpenSSH
pattern matching or authorization — `ssh-keygen -Y verify` remains the policy
authority, and parsed lines are fed back to it unchanged.

## Out of scope (future work)

- Key **rotation** and revocation wiring for stored principal keys.
- Certificate (`cert-authority`) chains and hardware (`touch-required`) flows
  beyond parsing.
- A pure-JS signer for hot paths (the `Signer` seam is already in place).
- Threshold schemes beyond "N distinct trusted keys".
