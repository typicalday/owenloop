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
2026-08-20 run for charter hash
`35773e2e269844fbb81acec0c07774f5674d51aa47304f6e0346458a13f9a2a2`.
Claude Code 2.1.236 using `claude-opus-5` passed 4/4 clear tasks, and Codex
0.147.0 using `gpt-5.6-sol` also passed 4/4.

One run is one sample. Codex's score moves between runs at a fixed charter hash,
so read any single number as a point in a range, and re-run before concluding
that a charter edit helped or hurt. Six runs on 2026-08-20, all on the same
harness versions and models:

| charter hash | runs | Claude | Codex |
| --- | --- | --- | --- |
| `dfb67821` (previous charter) | 2 | 4/4, 4/4 | 1/4, 2/4 |
| `bdbd33e3` (discarded wording) | 1 | 4/4 | 2/4 |
| `35773e2e` (this charter) | 3 | 4/4, 4/4, 4/4 | 3/4, 4/4, 4/4 |

Only the committed run's JSON lives in this repository. The other five were kept
outside it and are quoted here for the range, not as artifacts you can re-read.
Codex's range under this charter does not overlap its range under the previous
one, which is the evidence that moving the catalog rule to the front of the
charter changed behaviour. Three runs in an arm is a direction, not a
significance claim.

The retained no-match and ambiguous responses were reviewed. Claude calls the
catalog first on all four and says plainly that no published playbook fits.
Codex now calls the catalog first on both no-match tasks, which is what the
score measures, but its prose is weaker: it names the mismatch on the finance
task and simply asks for missing inputs on the operations one. On the unscored
`ambiguous-launch` task Codex still makes no call at all, so the charter's
every-request rule is not fully carried even in the runs that score 4/4. The
prose review does not alter either harness's numeric score.

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
