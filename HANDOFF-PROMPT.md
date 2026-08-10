# Handoff prompt — hub-resolution fallback for `push` / `publish` / `connect`

Paste everything below this line into a fresh Claude Code session started in
`/Users/alexrojas/code/owenloop/wt/push-hub-fallback` (the worktree already
exists on branch `push-hub-fallback`; do not cut a new one).

---

Implement a hub-resolution fallback in the owenloop CLI so the happy path needs
no per-project setup. Work in this worktree
(`/Users/alexrojas/code/owenloop/wt/push-hub-fallback`, branch
`push-hub-fallback`). The repo root is `src/cli.ts` + `src/hub.ts`; docs live in
`docs/cli.md`.

## The problem

Today `owenloop push` and `owenloop publish` hard-fail unless the project was
bound with `owenloop connect` (which writes `.owenloop/hub.json`). The error is
`this project is not bound to a hub — run \`owenloop connect\` first`. For a
user with exactly one hub credential, that per-project step is pure friction:
the global state already identifies the hub unambiguously. Rule to implement:
a global definition applies unless a project definition overrides it.

## The resolution ladder (applies to `push` and `publish`; `connect` uses it to
default its target when `--hub` is omitted)

1. `--hub <origin>` flag — always wins.
2. Project binding `.owenloop/hub.json` (read via `readHubBinding`,
   `src/hub.ts:829`) — the project override.
3. Global fallback, exactly one candidate origin:
   - File credential store: `listStoredHubOrigins()` (`src/hub.ts:792`)
     returns the origins. Exactly one → use it. More than one → exit 2,
     listing the stored origins and naming both remedies (`--hub <origin>` or
     `owenloop connect`).
   - Keychain / external-command credential backends CANNOT enumerate origins
     (`listStoredHubOrigins` returns null for them — verify this in
     `src/hub.ts` before relying on it). For those backends, fall back to
     `hubOrigin` from the execution settings file
     (`packages/work/src/settings/settings.ts`, `loadSettings` —
     `$XDG_CONFIG_HOME/owenloop/settings.json` else
     `~/.config/owenloop/settings.json`). Present → use it (and verify a
     credential exists for that origin before proceeding). Absent → exit 2
     demanding `--hub`.
4. Nothing resolved → exit 2. NEVER fall back to the built-in `DEFAULT_HUB`
   for `push`/`publish` — publishing to a silently-guessed hub is the failure
   mode this ladder exists to prevent (same reasoning `agent new` already
   documents in `docs/cli.md`).

## Where the code is (line numbers from a recent read — re-verify with grep,
they may have drifted)

- `resolveHub` — `src/cli.ts:3103` (`--hub > OWENLOOP_HUB > DEFAULT_HUB`).
  This is the generic hub-command resolver; do NOT reuse it for push/publish —
  its `DEFAULT_HUB` tail is exactly what push/publish must not do.
- `dispatchPublish` binding check — `src/cli.ts:861-862`.
- `dispatchConnect` — `src/cli.ts:3627`.
- `dispatchPush` — `src/cli.ts:3664`; its binding check at `:3672-3673` emits
  the "not bound" error quoted above.
- Existing single-origin patterns to mirror: `resolveAgentHub`
  (`src/cli.ts:3957`) and `resolveSetupHub` (`src/cli.ts:4707`). Extract one
  shared helper rather than adding a third copy.
- `listStoredHubOrigins` — `src/hub.ts:792`; `hubBindingPath` — `:819`;
  `readHubBinding` — `:829`; keychain service naming — `:310`.

## Deliverables

1. The shared resolver helper + wiring into `push`, `publish`, and `connect`.
2. Error messages that name the exact remedy (list ambiguous origins; name the
   settings file path when suggesting `hubOrigin`; suggest `--hub` and
   `connect` as the explicit overrides).
3. Unit tests covering: flag wins; project binding wins over global; file store
   with one origin resolves; file store with two origins exits 2 listing both;
   keychain backend + settings `hubOrigin` resolves; keychain backend + no
   settings exits 2; no DEFAULT_HUB fallback ever fires for push/publish.
4. `docs/cli.md`: update the `connect` and `push` sections to document the
   ladder; state explicitly that `connect` remains the per-project OVERRIDE
   (multi-org repos), not a prerequisite.
5. Run the repo's full check suite before finishing.
6. PR title must carry a conventional-commit prefix, e.g.
   `feat: resolve push/publish hub from the global credential when the project is unbound`.
