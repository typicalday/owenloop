# Local hosted order view and Service v1 reference

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
actions require a fresh read and local hold check. A stalled request remains
a separate liveness concern; the Hub client does not provide an abort signal.

`work hold --mcp --verified-hosted` is read-only by default. Its native
`get_order` shows a reduced dynamic model view. The full previously gated
packet stays inside the process through `readGatedOrder()` and is never an MCP
registration. The verified wrapper compares the first Service v1 dynamic
digest with that private hold, checks stable dynamic fields on later reads,
and hashes the *whole* local packet before and after verification and signing.
Only owed target versions may advance under the held claim. Hidden authored
fields therefore still fence drift even though Service v1 does not project
them. The accessor becomes unavailable when the local hold ends.

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

This local source boundary still requires an admitted Service v1 counterpart,
bearer-authenticated remote proof, signature and enrollment checks at submit
or downstream consumption, native Jev Linux proof, formal pstack maker/checker,
and staging and deployment gates before live use.
