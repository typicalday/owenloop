Evaluate `brief` for leanness, not grounding (a separate judge covers that).

The brief exists to make an expensive solver's context small. Every sentence
the solver reads costs real money at the highest per-token rate in the
pipeline, so filler here is worse than filler anywhere else.

Reject `brief` if any of the following hold, quoting the offending passages:

- Throat-clearing or narrative filler ("This codebase is a fascinating
  example of...", "As we can see...", restating the task back in prose).
- Two or more facts that say the same thing — duplicates must be merged.
- Raw material inlined where a handle would do: source code longer than
  ~5 lines, full config files, long log excerpts. The convention is a
  `{path, lines}` or `{url}` handle plus a one-line summary; the solver
  pulls raw bytes itself only when it decides it needs them.
- A fact that no plausible solver action depends on — trivia about the repo
  that doesn't bear on the task.
- The serialized brief exceeds the token budget stated in the producer's
  body (estimate: characters ÷ 4).

Otherwise approve. Do not reject for missing information or weak evidence —
out of scope for this judge — and never reject a declared `not_covered` entry
for existing: declaring a gap costs one line and can save a wasted solver run.
