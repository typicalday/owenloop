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
servers, and only its read-only local built-ins; Codex receives a fresh private
`CODEX_HOME` containing no user configuration, credentials, plugins, skills, or
MCP servers. Both sessions therefore expose the fixture mount and their
intentionally limited built-ins, rather than an operator's configured Owenloop
server. The trace records the full SHA-256 of the exact UTF-8 instructions value returned by the
real initialize handler, then each received MCP call as ordered sequence, name,
and arguments. Scores use only that structured wire log. Response evidence
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

This branch intentionally has no committed baseline yet. The Codex evaluation
session initialized the local fixture but made no tool calls and never emitted
`turn_ended` after several minutes, so it was unscorable. No score was
invented and no partial baseline was written.

## Safety and baseline updates

The mounted entry point is test/fixtures/mcp-charter-eval-server.ts, not
bin/owenloop.mjs. It imports only the local MCP transport core and local fixture
helpers; every handler is a fixed local response, and start_run only records its
selected workflow. It has no CLI, hub, REST, credential, or settings fallback
path. Claude ignores ambient settings and MCP configuration, and Codex receives
an empty private configuration root; both mounts are the fixture entry point.
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
