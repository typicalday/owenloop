# MCP chief-of-staff charter evaluation

eval:mcp-charter measures whether a fresh Claude Code or Codex session acts on
the chief-of-staff guidance delivered by MCP initialization. It is a live,
opt-in evaluation: it spends real model quota and requires both harnesses to be
logged in. It is deliberately outside the normal test and CI commands.

Run the evaluation from a checked-out repository:

    npm run eval:mcp-charter -- --output docs/evals/mcp-charter-baseline.json

To pin a model for one harness, pass --claude-model <model> and/or
--codex-model <model>. The same choices can be supplied with
OWENLOOP_MCP_CHARTER_CLAUDE_MODEL and OWENLOOP_MCP_CHARTER_CODEX_MODEL. Each
task has a five-minute deadline by default; pass --task-timeout-ms <positive
integer> (or set OWENLOOP_MCP_CHARTER_TASK_TIMEOUT_MS) to set a different
bounded budget.

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

For the two clear match tasks, a pass requires list_workflows with an empty
object as the first call, then a later start_run for the expected workflow, with
no conflicting workflow selection. For the two clear no-match tasks, a pass
requires list_workflows with an empty object first and no start_run. The
remaining two ambiguous tasks are recorded as observations only. Each harness
therefore reports passed / 4, not passed / 6.

The report records the run timestamp, Node version, fixture catalog digest,
charter hash, configured/reported model and harness version where available,
ordered calls, response evidence, classifications, and score. A charter edit
changes the served-byte hash, so it creates a new attributable score rather
than inheriting an old baseline.

The committed [baseline](evals/mcp-charter-baseline.json) records a complete
2026-08-21T05:40:09.335Z run for charter hash
`03ac02a08d1df19033c793c4b9bad3ca0bce894ec13530638c4c8e1635629096`,
generated with Node v22.22.3. Claude Code 2.1.236 using `claude-opus-5` and
Codex 0.147.0 using `gpt-5.6-sol` each passed 4/4 clear tasks. Both harnesses
were complete and scoreable.

One run is one sample. Codex's score moves between runs at a fixed charter hash,
so read any single number as a point in a range, and re-run before concluding
that a charter edit helped or hurt. Eight 2026-08-21 controls used the unedited
`35773e2e` charter, and six treatment reports used the new `03ac02a0` charter;
each report identifies the same harness versions and models named above:

| charter hash | runs | Claude | Codex |
| --- | --- | --- | --- |
| `dfb67821` (previous charter) | 2 | 4/4, 4/4 | 1/4, 2/4 |
| `bdbd33e3` (discarded wording) | 1 | 4/4 | 2/4 |
| `35773e2e` (pre-compose charter, including five new controls) | 8 | 4/4, 4/4, 4/4, 4/4, 4/4, 4/4, 4/4, 4/4 | 3/4, 4/4, 4/4, 2/4, 3/4, 2/4, 2/4, 3/4 |
| `03ac02a0` (compose clause) | 6 | 4/4, 4/4, 4/4, 4/4, 4/4, 4/4 | 2/4, 2/4, 2/4, 2/4, 3/4, 4/4 |

Only the committed run's JSON lives in this repository; this table is the durable
record of the other samples. The human-directed three-report fixed-charter
control was 2/4, 3/4, 2/4 for Codex, and the fresh fixed-charter control was
3/4. The controls therefore show the same first-call variance independently of
the compose clause. The final generated treatment happened to be 4/4 for Codex,
but it does not erase the observed 2/4–3/4 fixed-charter regression or establish
that a charter edit caused any score movement. Three runs in an arm is a
direction, not a significance claim.

The retained no-match and ambiguous responses were reviewed. In the final
treatment, both harnesses call the catalog first, start only the expected
clear-match workflow, and make zero starts for the no-match tasks. Claude's
migration response identifies `library-build` evidence gathering plus a bespoke
synthesis step as an approval-gated composite, while its launch response names
the same collection-plus-bespoke-brief composition. Codex's current ambiguous
responses remain input/tooling-oriented rather than evidence that a composite
was compiled. The fixture exposes neither the plan skill nor `create_workflow`,
so neither harness actually compiled, surfaced, or released an approval gate;
the observed prose is not proof of composite execution. Ambiguous observations
do not change the numeric 4-task denominator.

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
