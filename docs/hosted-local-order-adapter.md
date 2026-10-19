# Local hosted order view and versioned Service references

## Held CLI input migration

`work hold --mcp --verified-hosted` explicitly selects the existing independent
Service v2 reader. It admits declared required inputs and explicit optional
absence using claim-version witnesses, the verified local declaration, and the
same hard signed producer-chain verifier used by the ordinary holder. Declared
values are labeled `trusted-service-claim-version`; producer artifacts retain
their signed-value label. `inputWitnesses` reports declared input versions and
presence without inventing a value for an absent input. A human `provideProof`
attached to a declared input remains advisory and is not producer authority.

The v2 reader is locally configured and uses its own HTTPS transport. MCP text
and a replaceable HubClient fetch cannot choose its origin, bearer, or response.
The wrapper binds claim fields and the complete input/workdir witness digest,
keeps its full private hold checks, and re-reads the independent witness after
asynchronous proof signing before conditional submission. Witness movement,
loss, unsupported feedback/routing, or a v1 response refuses exposure and
pending writes. There is no v1 fallback after v2 selection. The outer real read
deadline and wall/monotonic freshness checks still apply.

A parent-bound v2 request may resolve to a Service-authorized canonical child.
The private outer/inner order identities and independent witness must agree on
that child and the exact requested run. The child is pinned across subsequent
reads. MCP navigation, HTTPS requests, and conditional writes retain the
original requested root/run; neither private content nor a later child can
retarget them. Legacy v1 still requires its original exact workflow binding.

The verified holder also bounds the complete observation to five seconds,
including its initial and final private holder reads. A real deadline returns
a refusal when a private read stalls and cancels its normal HTTPS request.
The request signal also prevents a late credential lookup from starting an
expired private bearer request. Wall and monotonic elapsed checks cover
local work that delays the timer callback. Deadline expiry fences late private
results before exposure, signing, or a conditional write; a fresh healthy read
can recover. An already cancelled call does not invalidate healthy siblings
when its deadline expires. This does not forcibly terminate a private transport or verifier
that ignores cancellation.

Partial conditional submissions may advance only owed target versions. A
private `get_order`-only mount can refresh those versions; ordinary mutation
tools cannot select that mode. The wrapper keeps every other private field and
the input/workdir witness digest pinned, and checks the exact refreshed output
version again after signing. Each successful private read has a process-local
result gate, so overlapping reads do not depend on a temporarily empty shared
cache. A newer refusal or stopped hold invalidates those gates.

For API compatibility, `createDefaultHostedOrderAdapter` retains its existing
v1 contract unless the local caller explicitly supplies `referenceV2: true`;
the held CLI supplies that option. `createHostedOrderAdapter` accepts a locally
constructed v2 reader at its low-level integration seam. The constructor's
choice is fixed before reading untrusted preflight content. The existing
`local-hosted-order-v1` projection gains the explicit v2 reference marker and
declared-input witness labels; no new Service protocol or signer is introduced.

Local v2 optional-input and canonical-child tests do not establish hosted or
native child execution, signed-feedback authority, or full migration acceptance.

## Legacy v1 adapter contract

`createDefaultHostedOrderAdapter` is an opt-in local order-view component. It
treats a `client-preflight-v1` MCP reference as a navigation hint only. The
local host fixes the expected workflow and run at construction. A reference
outside that binding is refused before the client uses its bearer token. The
MCP response must be intercepted before reaching model context; only the
adapter's verified projection may be shown. A generic MCP client that has
already displayed raw preflight content is outside this boundary.

Every `open` makes a fresh bearer-authenticated HTTPS
`POST /api/reference_order/v1` request through `createHubClient`. The client
sets `redirect: error`; MCP content cannot select the origin or credentials.
The Service must return a `trusted-reference-read-v1` envelope for the bound
workflow and run with `state: "available"`, a claimed lease and no outcome.
The adapter checks the order's definition digest against the preflight
reference and refuses malformed or unreviewed fields. An older Service's 404,
an absent v1 method, a malformed acknowledgment, or an unsupported state
refuses with a fixed local code. There is no fallback to `/api/get_order`.
The Service acknowledgment is a trusted observation of an active claim, not
a cryptographic lease or exclusive holder attestation.

The v1 order contains dynamic identity, consumed values and proofs, and owed
paths and target versions. Authored text, `spec`, `x`, schema, prior values,
feedback, modifier, cause, execution stamps and routing fields do not inherit
trust from that dynamic response. The adapter re-verifies installed bundle
bytes and the execution-time publication verdict, resolves instructions and
static extensions from the local definition, requires verified calls-child
closure for calls-produced consumes, and applies the hard consumed-value
verifier. The model-facing projection labels local definition content,
service-observed substitutions and target versions, and checked consumed
values separately. Unsupported local modifier/cause/rework/routing shapes,
unreviewed raw fields, missing proofs, or mismatched input/output paths
refuse instead of producing a partial projection. Service v1 supplies no
authenticated feedback or prior value, so this path cannot present a rework
thread. The signature/value check does not independently attest this hosted
instance's producer workflow, run, or definition; the configured Service
selects that provenance.

The adapter starts an epoch and monotonic observation window before the v1
request, bounds fetch plus local verification to at most five seconds, and
caps the projected epoch expiry by remaining monotonic time. Unsafe clock
arithmetic, a delayed response, and expiry during verification refuse. A
retained projection needs a caller-side monotonic deadline or another `open`
immediately before use. A claim can change after return, so consequential
actions require a fresh read and local hold check. Each read also owns a real
deadline: expiry returns a bounded refusal and aborts the HTTPS request and
response body. A stalled credential lookup or local verifier cannot hold the
caller indefinitely. A late credential cannot start a bearer request, and a
late transport or verifier cannot publish a verified packet. This does not
forcibly terminate a credential reader or verifier that ignores cancellation.

The held CLI is read-only by default. Its native
`get_order` shows a reduced dynamic model view. The full previously gated
packet stays inside the process through `readGatedOrder()` and is never an MCP
registration. In the legacy adapter contract, the wrapper compares the first Service v1 dynamic
digest with that private hold, checks stable dynamic fields on later reads,
and hashes the *whole* local packet before and after verification and signing.
Only owed target versions may advance under the held claim. Hidden authored
fields therefore still fence drift even though Service v1 does not project
them. The accessor becomes unavailable when the local hold ends.

For an opt-in local MCP client, start this command only for the run whose
claim was handed to this process, from a directory with the locally installed
workflow definition (or with that definition in the global store):

```sh
owenloop work hold --order <workflow>/<run> --origin https://<service-origin> --as <account> --mcp --verified-hosted
```

The work-scoped agent credential is resolved from the local credential store;
it does not belong in MCP content or command arguments. The client sees only
`get_order` in `tools/list` by default. `--never-release` is refused in this
mode because it declares that another process holds the claim. The holder's
initial `get_order`, reference reads, and heartbeat contact the Service as
part of its lease lifecycle; MCP stdin EOF or a stop signal releases its
claim. This is a model-read-only surface, not a no-touch spectator read. The
Service's claimed bit and holder tag remain trusted observations, not proof
of exclusive holder identity. Do not mount a second client on the same claim.

Explicit `--mcp-tools get_order,submit` enables conditional submission. The
wrapper re-verifies the v1 order, takes path and version from its verified
output list, signs the private verified packet, and posts only to
`/api/submit/conditional-v1`. It requires the
`conditionApplied: "expected-version-v1"` acknowledgment and never retries
legacy `/api/submit`. Collection seal outputs remain unsupported. A stale
condition has a fixed refusal. After an ambiguous response, the wrapper
blocks another submit until the model sees a fresh `get_order` projection and
echoes its opaque `reconciliation.submitToken`; the token binds to that
projection's v1 dynamic digest. An older concurrent read cannot reconcile a
newer ambiguity, and a second submit cannot enter while one is in flight.
The holder stops without release if the Service reports `closed: true`, even
when the acknowledgment is otherwise refused. The model receives bounded
status only; raw packets, proof bytes, lease and Service response text remain
private.

This local source boundary still requires an admitted matching Service counterpart,
bearer-authenticated remote proof, signature and enrollment checks at submit
or downstream consumption, native Jev Linux proof, formal pstack maker/checker,
and staging and deployment gates before live use.

### Stopping a pending lease read

Hold and exec cancel an in-flight first-contact/lease-probe `get_order` or
heartbeat when stopped (including MCP stdin EOF). Normal HTTPS requests receive the
existing cancellation signal. A private client that ignores it cannot delay
shutdown or deliver a late order to the command runner. An established hold
still uses the bounded final-breath release unless `release:false` was requested;
a stop before first contact is confirmed remains `stopped`. Late probe results
cannot start another heartbeat. This does not roll back a request already sent
to the Service or force termination of opaque private client work.
