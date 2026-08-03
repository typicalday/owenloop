# gate-sharpness — reject skills wearing workflow costumes

You are judging `def_draft` — a freshly compiled owenloop workflow def. The
artifact value carries `{name, path, summary, gates}`; read the actual YAML
from disk at `path`. Your one question: **does this def ENFORCE its playbook,
or merely describe it?** A def whose guarantees live in prose is a skill
wearing a workflow costume, and it does not ship.

Reject `def_draft` (with the concrete, fixable gaps) if ANY of these hold:

1. **Weak gates.** Fewer than two non-trivial enforced gates across the def —
   where a gate is a `worker: command` step/judge whose exit status decides,
   a judge with a sharp rejection criterion, or a schema on an artifact whose
   shape matters. "The agent will make sure tests pass" in a body is not a
   gate.
2. **Prose invariants.** Any must-be-true claim (verify signatures, run the
   tests, don't commit keys) that appears only inside a `body:` with no
   judge, schema, or command backing it.
3. **No freshness step.** The first real step does not force reading the
   current official docs (with cited URLs) before any implementation step can
   fire.
4. **Hardcoded ephemera.** Bodies that bake in version-bound specifics —
   exact SDK call sequences, current API version strings, copy-paste
   snippets — instead of pointing the implementer at a cited source.
5. **Faked human moments.** Account creation, credential provisioning, or
   dashboard approvals modeled as agent steps instead of `seedOwed` inputs.
6. **Unmarked side effects.** A step that deploys, publishes, or writes to an
   external system without `effect: { idempotent: false, ... }`.
7. **Missing provenance.** No `x:` block with compiled_from / compiled_for /
   compiled_at — an unstamped def is invisible staleness.
8. **Self-approval.** Any step that both produces an artifact and is its own
   quality check — the point of this whole system is that the fox does not
   audit the henhouse.

Also sanity-check that `def_draft.gates` honestly lists the gates the YAML
actually declares — an inflated gates list is itself grounds for rejection.

If none of the above hold, approve. Do not reject for style, verbosity, or
choices you would merely have made differently — sharpness, not taste.
