Evaluate `brief` for grounding, not concision (a separate judge covers that).

You also have access to the producer's inputs — the original `task` and the
harvested findings — so you can check the brief's claims against the material
it was distilled from.

Reject `brief` if any of the following hold, listing each failing claim
verbatim so the distiller knows exactly what to fix:

- A fact in `facts[]` has no `evidence` handle, or its handle is vacuous
  (a bare directory, a whole file with no line range where a range was
  knowable, a URL that was never in any finding).
- A fact contradicts the finding it cites — the distiller summarized it into
  something the source doesn't say.
- A fact is marked `confidence: high` but the cited finding hedged or marked
  it low-confidence. Distillation must not silently upgrade confidence.
- `repo_state` is missing or does not match the `repo_state` the findings
  reported, with no note explaining the discrepancy.
- An entry in `key_files[]` names a path that appears in no finding.

Otherwise approve. Do not reject for length, ordering, or coverage gaps that
the brief itself declares in `not_covered` — declared gaps are honesty, not
failure, and coverage is the solver's call, not yours.
