# MCP charter evaluation baseline status

There is no `mcp-charter-baseline.json` for the charter evaluation introduced
in PR #226. No complete, scoreable two-harness report was produced, so there
are no measured numbers or no-match responses to record or review.

## Approved exception for PR #226

On 2026-08-20, the builder escalated that two live attempts had initialized the
local fixture with a valid charter hash, but the Codex session made no MCP calls
and never emitted `turn_ended` after several minutes. The exact elapsed times
were not persisted. The operator answered on the PR artifact's reason thread:

> Authorized: land this without a live Codex baseline. Do not invent one, and
> do not keep burning attempts on the live run.

The same decision directed that, when neither complete measurement is
available, no baseline file should be committed, the deterministic suite must
remain green without one, and the unscorable result must be stated plainly in
the PR. This approval supersedes the plan's baseline-file and no-match-review
requirements for PR #226 only. A future scoreable run should replace this
status with the generated `mcp-charter-baseline.json` and its reviewed
no-match evidence.
