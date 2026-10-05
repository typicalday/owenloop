# Local hosted order view (issue #330 slice)

`createDefaultHostedOrderAdapter` is an opt-in **local order-view component**.
It accepts the service's `client-preflight-v1` reference only as a navigation
hint. At construction the local host must supply an exact `expected.workflowId`
and `expected.runId`; a preflight reference outside that binding is refused
**before** the adapter uses its bearer credential. The binding is copied at
construction and checked against the direct response. One run has one
persisted order packet in the trusted service, so this workflow/run pair is
the order identity; the adapter also compares the preflight definition digest.
The host must intercept that MCP response **before it reaches model
context**, pass only its `structuredContent` to `open`, and expose only the
adapter result. A generic MCP client that already displays the preflight
response is outside this component's protection, even though the service's
own preflight implementation is bounded. For every `open` call the adapter
uses a locally configured HTTPS origin and bearer
credential to fetch `/api/get_order` through `createHubClient`. The MCP preflight
cannot select an origin, supply credentials, or supply the packet that is
verified. The fetch sets `redirect: error`; no redirect may change the origin
or downgrade HTTPS. A local integration must put only the returned projection in both
model-facing MCP `content` and `structuredContent`; raw REST or MCP text must
stay inside the client process.

The component assumes the configured authenticated HTTPS service is trusted to
report the current claim and its claim-time version map. It compares the fetched
workflow, run, and definition digest with the preflight reference and requires
`lease.claimed === true` with no outcome. This is a **service observation**, not
a signed issuer or lease attestation. Each `open` fetches again and starts its
local observation window **before** the authenticated direct fetch. It refuses
if the fetch or subsequent local verification reaches the expiry, no more than
five seconds after that start, or if timestamp arithmetic is unsafe. A caller
must not treat the projection as authority after that expiry. This bounds the
freshness of a returned `ready` projection; the current `getOrder` client has
no abort signal, so a stalled fetch is still a separate liveness concern.

The instruction source re-verifies installed bundle bytes and requires a
verified execution-time publication verdict. The adapter forces definition and
artifact policy to `enforce`, and applies `originPolicy: enforce` where local
origin rules are configured. An empty origin-rules map imposes no origin
requirement; the verified publication remains the primary local authority.
It resolves the step and calls-child
facts from the verified local store, then runs the existing consume verifier
with its hard rule. A `ready` projection labels locally authored prompt,
`spec`, `x`, and schema separately from service-observed substitutions and
output versions (`versionTrust`). Dynamic values carry the signed-submission and locally
anchored producer-chain verdict at the version observed from the service.
For ordinary consumed artifacts, that verifier does not bind the signed
producer workflow/run/definition digest to this hosted instance. The trusted
service selects provenance and claim-time versions; the local verifier checks
the signature, value, version, and configured chain authority. The projection
does not claim independently attested instance provenance.
Unrecognized order fields, unsupported worker/step types, unverified consumed
values, and output lists that do not exactly match owed paths (including
duplicates) refuse with fixed codes. Consumed paths must include every
declared plain input and a reduce collection's exact seal; map input paths,
bare key, and index must bind the same member. Raw service
errors are never returned.

`owes[].reasons`, `owes[].proof`, and `previousValue` currently refuse the whole
order. There is no supported signed-reason or prior-value verification protocol
to make them safe for a model-facing rework view. The component also refuses
workdir-dependent steps and command/calls/judge steps as direct hosted agent
views. Calls-child **consumed proofs** are corroborated through the verified
store closure, but the component itself does not expose a calls step to a model.

This component has no submit API and is not wired into `createHoldMcp`'s
existing cached order path. It cannot authorize a submission or prove that a
lease remains live after `open` returns. A safe follow-on is an opt-in holder
integration that direct-fetches and repeats the adapter's identity, lease,
definition, and consume checks immediately before each model-visible order
read and before each submit; uses the fresh private packet for submit proof and
owed-path/version checks; refuses if the run has been released or re-offered;
and never exposes that packet in MCP content or `structuredContent`. The
holder's current cached `firstContact`/`captured` values cannot serve as fresh
lease evidence. Issue #330 remains open until that path, signed reason support,
deployed-client proof, and legacy retirement are complete.
