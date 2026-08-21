# MCP chief-of-staff charter evaluation

eval:mcp-charter measures whether a fresh Claude Code or Codex session acts on
the chief-of-staff guidance delivered by MCP initialization. It is a live,
opt-in evaluation: it spends real model quota and requires both harnesses to be
logged in. It is deliberately outside the normal test and CI commands.

Run the evaluation from a checked-out repository:

    npm run eval:mcp-charter -- --expected-node-version v22.22.3 --output docs/evals/mcp-charter-baseline.json

To pin a model for one harness, pass --claude-model <model> and/or
--codex-model <model>. The same choices can be supplied with
OWENLOOP_MCP_CHARTER_CLAUDE_MODEL and OWENLOOP_MCP_CHARTER_CODEX_MODEL. Each
task has a five-minute deadline by default; pass --task-timeout-ms <positive
integer> (or set OWENLOOP_MCP_CHARTER_TASK_TIMEOUT_MS) to set a different
bounded budget. Every live invocation must also pass an exact
--expected-node-version value (or set
OWENLOOP_MCP_CHARTER_EXPECTED_NODE_VERSION). The runner refuses to create a
harness session unless that declared value equals `process.version`; it never
derives the pin from the current process. Reuse the same literal pin for every
report in a cohort.

## Method

The fixed versioned fixture contains two catalog definitions and six neutral
user requests. Every task runs in a newly created harness session. The runner
only supplies Handle this request for the user followed by the task; it never
names an expected workflow or asks the model to use a tool.

The mounted MCP process writes a JSONL trace in a random harness-owned
directory outside the model session workspace. The evaluated session receives
only its workspace path; it cannot reach the trace through its normal workspace
authority. Claude runs with isolated settings, no skills, no ambient MCP
servers, and an explicit empty built-in tool set. A Claude SDK init status of
`failed`, `needs-auth`, `disabled`, or any other non-healthy value for the
fixture mount makes the task unscorable; the SDK's normal `pending` and
`connected` states are accepted. Codex receives a fresh private
`CODEX_HOME` containing no user configuration, plugins, skills, or MCP servers.
If the operator uses file authentication, the runner stages `auth.json` there
with owner-only permissions so the app-server remains logged in; it disables
Codex's shell, exec, file/image, web, app, and subagent surfaces and subprocess
environment inheritance, so the evaluated model can reach the fixture MCP but
cannot read that staged credential. The private root is removed after the task.
Both sessions therefore expose the fixture mount without ambient or built-in
tools, rather than an operator's configured Owenloop server. The trace
records the full SHA-256 of the exact UTF-8 instructions value returned by the
real initialize handler, then each received named `tools/call` as ordered
sequence, name, and exact arguments at the inbound wire boundary before schema
validation. Schema-rejected calls therefore remain visible and are never
mistaken for no call. Scores use only that structured wire log. Response evidence
retains only the final assembled assistant reply (the Claude SDK's final
top-level text or Codex's completed final-answer item); reasoning, stderr, tool
output, MCP metadata, and streamed/intermediate text are excluded. Neither
response text nor generic telemetry is used for a numeric score.

For every non-ambiguous task, the scorer records two independent dimensions:
**catalog discovery** records whether the first call is
`list_workflows({})`; **task safety** records whether a no-match task makes no
`start_run`, or whether a match task starts its expected workflow without any
conflicting or malformed selection. A malformed, schema-rejected `start_run`
still counts as a received start and is unsafe. The headline `passed` remains
the conjunction of both dimensions. The rejected alternative was a safety-only
headline for no-match tasks: that would allow a safe zero-call refusal to pass
without measuring adherence to catalog discovery. The remaining two ambiguous
tasks are recorded as observations only. Each harness therefore reports passed
/ 4, not passed / 6.

Schema v2 reports record both the declared `expectedNodeVersion` and actual
`nodeVersion`, alongside the run timestamp, fixture catalog digest, charter
hash, configured/reported model and harness version where available, ordered
calls, response evidence, classifications, dimensions, and score. The
preflight check prevents a wrong-treatment run before it spends model quota;
`assertComparableNodeTreatment` then rejects cohorts with missing pins,
expected/actual mismatches, or different declared or actual Node versions. A
charter edit changes the served-byte hash, so it creates a new attributable
score rather than inheriting an old baseline.

## W3.3b negative result

W3.3b does **not** ship a compose-clause charter change. The pre-compose
charter and its generated baseline are restored because this evaluation provides
no evidence that the candidate clause helps. That negative-result unit
authorized no further cohort, Node pinning, charter wording iteration, or
baseline generation.
The completed deliverable is this reproducible negative result and its separate
evaluator finding.

The committed [baseline](evals/mcp-charter-baseline.json) is restored exactly to
the generated pre-compose sample at
`35773e2e269844fbb81acec0c07774f5674d51aa47304f6e0346458a13f9a2a2`, generated
at 2026-08-20T13:53:53.975Z with Node v22.22.3. It is a historical generated
point and a hash-consistency anchor, not a stable both-harness floor. This unit
generated no new baseline and did not hand-edit or substitute report JSON.

### Corrected control record

The earlier description of `35773e2e` as a both-harness 4/4 floor came from one
lucky draw and is corrected here. The full unchanged-control record supersedes
that claim: Claude Code scored 4/4 in all ten samples, while Codex scored
`3, 4, 4, 2, 3, 2, 2, 3, 3, 3`. The original both-harness 4/4 gate is therefore
unsatisfiable by the unmodified control as a reliable acceptance rule. The
builder correctly stopped on that gate; the problem was the instrument, not a
failure to complete an authorized clause iteration.

| charter | status | samples | Claude Code | Codex |
| --- | --- | ---: | --- | --- |
| `35773e2e` | unchanged pre-compose control | 10 | 4/4, 4/4, 4/4, 4/4, 4/4, 4/4, 4/4, 4/4, 4/4, 4/4 | 3/4, 4/4, 4/4, 2/4, 3/4, 2/4, 2/4, 3/4, 3/4, 3/4 |

This is aggregate historical evidence, not a same-environment
candidate/control cohort. Claude has no scored headroom to demonstrate an
improvement, while Codex's unchanged-control variation swamps a possible clause
effect. The candidate neither caused a Codex regression nor passed by avoiding
unsafe starts: its score differences cannot be attributed to the wording.

### What the scorer measures

At the time of the W3.3b negative result, `discoveredFirst` and `scoreTask`
required every non-ambiguous task to start with `list_workflows({})` before the
no-match branch tested `starts.length === 0`. A zero-call refusal consequently
failed because `calls[0]` was absent even when it made no unsafe `start_run`.
The landed evaluator now records catalog discovery and no-start safety
independently, as described in [Method](#method), without changing the
conjunctive headline. The structured trace remains the score; refusal prose,
catalog language, or a no-inline promise cannot substitute for an observed
first tool call or prove a zero-call trace. Raw response evidence remains
qualitative and separate from the score.

### Fixed-fixture limitation

The ambiguous tasks cannot validate W3.3a composition. The fixture exposes only
`code-delivery` and `library-build`; it supplies no two compatible targets for
these requests and does not mount the plan skill or the compiler/approval
lifecycle. No ambiguous response proves that a composite compiled, parked,
released, or executed. Those tasks remain non-gating observations, and the
four-task denominator is unchanged.

### Stopped protocol and historical-only reports

The earlier counterbalanced protocol is preserved as historical context, not as
an instruction to sample again. Its symmetric stop rule fired on a Node-version
treatment drift. All four completed reports are complete and scoreable, retain
the same fixture digest, reported models, and harness versions, and remain
trustworthy measurements of their actual executions. They are historical-only
because the cross-arm Node difference makes them invalid as a treatment
comparison; no report was dropped, replaced, normalized, or reinterpreted.

| report | charter | Node | Claude Code | Codex |
| --- | --- | --- | --- | --- |
| control-1 | control `35773e2e` | v26.5.0 | 4/4 | 3/4 |
| candidate-1 | candidate `8f08991d` | v22.22.3 | 4/4 | 2/4 |
| candidate-2 | candidate `8f08991d` | v22.22.3 | 4/4 | 3/4 |
| control-2 | control `35773e2e` | v26.5.0 | 4/4 | 3/4 |

`control-3` was interrupted with exit 130 and produced no report;
`candidate-3` never ran. The four verbatim raw reports and the original protocol
comment remain attached to PR #255 as evidence. Node drift is a secondary run
limitation, not a reason to authorize another cohort: pinning Node would not
give this fixture a discriminating acceptance gate.

## Landed 2026-08-21: separate no-start safety from catalog-discovery adherence, and make the evaluator runtime treatment explicit

This follow-up unit discharged two independent evaluator defects:

- **Conflated no-match criterion.** The scorer combines “did not start an
  unsupported workflow” and “called `list_workflows({})` first” into one pass.
  A correct zero-call refusal is safe on the first dimension but fails the
  combined score on the second. The scorer now records and tests both dimensions
  explicitly, while retaining their conjunction as the headline result.
- **Uncontrolled Node treatment.** The harness and protocol previously did not
  pin Node or enforce arm-local Node provenance as a treatment invariant.
  Schema v2 now requires a preflight pin and rejects incomparable report cohorts.

The fixed fixture, denominator, ambiguous-task treatment, served charter, and
historical baseline remain unchanged. The schema v1
[baseline](evals/mcp-charter-baseline.json) is immutable; its stored traces
re-score under schema v2 to the same Claude Code 4/4 and Codex 4/4 headline
totals, with both clear dimensions passing.

### Outcome

The compose clause and its candidate baseline are dropped. PR #255 remains the
reviewable negative-result deliverable: it preserves the raw evidence and
documents the evaluation's limits; this unit implements the named follow-up
without reopening the stopped protocol.

## Safety and baseline updates

The mounted entry point is test/fixtures/mcp-charter-eval-server.ts, not
bin/owenloop.mjs. It imports only the local MCP transport core and local fixture
helpers; every handler is a fixed local response, and start_run only records its
selected workflow. It has no CLI, hub, REST, credential, or settings fallback
path. Claude ignores ambient settings and MCP configuration, and Codex receives
a private minimal configuration root with only its supported login cache; both
mounts are the fixture entry point. Codex's model-visible tools and subprocess
environment are disabled apart from that mount, so the login cache is not model
evidence.
The fixture itself has no production-hub code path, so ambient `OWENLOOP_HUB`
cannot reach production through this evaluation.

An absent or malformed initialization marker, charter-hash mismatch, mount
startup failure, adapter exit or failure, deadline, or incomplete turn makes
that task unscorable. On deadline the runner stops the session from the
synchronous started reference and preserves any trace already written. The
command exits nonzero and, when --output is supplied, first validates the
complete report before atomically replacing the requested baseline. It never
replaces a baseline with fabricated zeroes or a partial result.

When the charter changes, run the command above with working credentials,
inspect the no-match response evidence to confirm the refusal is plain, and
commit the generated JSON together with any charter change only after both
harnesses are scoreable. Do not hand-author scores or substitute transcript
matching when a harness cannot be evaluated.
