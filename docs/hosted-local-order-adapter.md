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
if the fetch or subsequent local verification reaches the configured window,
no more than five seconds after that start, or if timestamp arithmetic is
unsafe. A monotonic clock enforces this elapsed bound through return; the
epoch clock remains necessary for signed chain dates. The returned epoch
`expiresAt` is capped by the monotonic time remaining at return, but an
epoch-only comparison can overstate the real time remaining if the wall clock
moves backward afterward. An integrating caller that retains a projection
must enforce its own monotonic deadline, measured before `open` and no later
than that start plus the configured observation window, or call `open` again
immediately before use. It must also recheck the lease before consequential
actions because a claim can change after return. The adapter bounds fetch and
verification through return; it does not continuously validate a retained
projection. The current `getOrder` client has no abort signal, so a stalled
fetch is still a separate liveness concern.

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

The bound `work hold --mcp --verified-hosted` mount remains read-only by default.
Explicit `--mcp-tools get_order,submit` enables one signed mutation. Before
every call it fetches and verifies the current order directly from the trusted
service, selects a path and version from the verified output list, signs the
private verified packet, and posts only to `/api/submit/conditional-v1`. It
requires a machine signing key and the endpoint's
`conditionApplied: "expected-version-v1"` response marker. An older service
has no such route; the client never retries legacy `/api/submit`. After an open
submit it reads the next order from the direct service, not the holder's cached
`firstContact`/`captured` packet. The model receives only bounded status;
raw order, proof, lease, and service response text stay private.

This first submit slice refuses collection seal outputs because a member has a
different proof target. It also retains the adapter's refusal of feedback and
prior values, including re-armed route siblings. A 409 stale condition is a
fixed refusal; transport failures or a missing response marker leave the
result uncertain. The holder refuses another submit until the model explicitly
calls `get_order`, receives a freshly verified projection with an opaque
`reconciliation.submitToken`, and echoes that token in the next submit. The
token binds that submit to the packet digest the model was shown. A lost
`get_order` response or an internal submit-time re-fetch cannot clear the
requirement. An order read started before a newer uncertain submit is refused
as superseded, even if it finishes later. Concurrent submits are refused while
one conditional mutation is in flight. An acknowledged non-success
response or a response missing its marker still stops the holder lease without
release when it reports `closed: true`. This is a native local holder
path, not a public hosted MCP gateway. It does not attest exclusive holder
identity or establish a deployed Jev proof. Issue #330 remains open for those
boundaries, signed reason support, collection handling, and legacy retirement.
