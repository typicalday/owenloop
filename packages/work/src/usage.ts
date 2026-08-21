/**
 * Single source of the CLI usage text. Printed by `--help`/`help` (to stdout,
 * exit 0) and on a dispatch error (to stderr, exit 2). Keeping it in one place
 * means the help output and the error output never drift apart.
 */
export const USAGE = `owenloop work — execution-side CLI companion to owenloop

Usage:
  owenloop work hold --order <id> [options]   hold an order with a heartbeating lease
  owenloop work exec <order-id> [options]     run a command order in a self-leasing loop
  owenloop work agent-run <order-id> [options]  host an agent order's step agent in a
                                         harness, in a self-leasing loop
  owenloop work prepare <workflow> [--origin <url>]
                                         fetch, cache & normalize step specs
  owenloop work lint <workflow-name | path>   lint x.harness option bags in a def
  owenloop work sessions [--all] [--json]     list this machine's recorded harness
                                         sessions and how to re-open them
  owenloop work approvals [--origin <url>] [--json]
${' '.repeat(41)}every tool call a worker is blocked on
                                         RIGHT NOW, waiting for a person
  owenloop work approvals approve <wf>/<run> <tool-use-id> [--origin <url>] [--note <text>]
  owenloop work approvals deny    <wf>/<run> <tool-use-id> [--origin <url>] [--note <text>]
                                         answer one; the answer goes back to the
                                         still-blocked call, not to a later attempt
  owenloop work release --session <id> [options]  drain a session's held claims
  owenloop work settings                      print the resolved settings file
  owenloop work join <code> [--hub <origin>] [--as <account>]
                                         redeem a join code and store the Scoped
                                         Identity credential (one-time provisioning)

Options:
  -h, --help                     show this help and exit 0
      --version                  print the owenloop work version and exit 0

  root shift options (run as owenloop shift start <crew...> | --all):
      <crew...>                  serve only these crews (positional, space
                                 separated); or --all for every crew on the key
      --all                      serve every crew on the key
      --origin <url>             hub origin (else settings.hubOrigin)
      --as <account>             Scoped Identity credential account to read + hand
                                 to dispatched holds/execs (default 'default')
      --name <n>                 Shift name (default <hostname>/<cwd>)
      --cap <n>                  max in-flight exec children (default 3)
      --poll-interval <ms>       wake poll cadence (default 5000)
      --once                     bootstrap wake + one sweep, then exit (demo/e2e)
      --max-agents <n>           max in-flight agent-run children, separate from
                                 --cap (default 4; else settings.maxConcurrentAgents)
		--exec-reserve <n>         slots inside --cap that agent-run children may
					not occupy, so exec orders always have room
					(default 1; else settings.execReserve; 0 disables)
      --local-queue-hold <ms>    retain an undispatchable claim locally before
					returning it to the hub (default 0; else
					settings.localQueueHoldMs; capped at 90000)
      --cache-dir/--state-dir <p>   override the resolved dirs

  hold options:
      --order <workflow>/<run>   the order to hold (or --order <run> --workflow)
      --workflow <wf>            required when --order is a bare run id
      --origin <url>             hub origin (else settings.hubOrigin)
      --as <account>             Scoped Identity credential account (default
                                 'default'; the shift stamps this into born-bound
                                 holds)
      --session <id>             session-holder tag (else env OWENLOOP_SESSION;
                                 else an anon:<hostname>:<pid> fallback — a
                                 holder is always sent)
      --shift <id>           dispatching Shift's self-declared id (else
                                 env OWENLOOP_SHIFT_ID); advisory only
      --heartbeat-interval <ms>  lease renew cadence (default 60000)
      --jump-tolerance <ms>      wall-gap slack before a tick is treated as a
                                 clock jump / laptop sleep (default 30000)
      --ignore-stdin             don't final-breath on stdin EOF (detached use)
      --never-release            another process holds the claim; stop without
                                 releasing it (agent-run spawns its --mcp child
                                 this way — see hold.ts HOLDER OF RECORD)
      --mcp                      run as a stdio-MCP work-holder: tools get_order /
                                 submit, lease kept warm underneath (mutually
                                 exclusive with --ignore-stdin — stdin is the
                                 transport)

  exec options (usually spawned by shift, not run by hand):
      <workflow>/<run>           the command order to run (positional order-id;
                                 or a bare <run> plus --workflow <wf>)
      --workflow <wf>            required when the order-id is a bare run id
      --origin <url>             hub origin (else settings.hubOrigin)
      --shift <id>           dispatching Shift's self-declared id (else
                                 env OWENLOOP_SHIFT_ID); advisory only
      --heartbeat-interval <ms>  lease renew cadence (default 60000)
      --jump-tolerance <ms>      wall-gap slack before a tick is treated as a
                                 clock jump / laptop sleep (default 30000)

  agent-run options (spawned by the shift, not run by hand):
      <workflow>/<run>           the agent order to host (positional order-id;
                                 or a bare <run> plus --workflow <wf>)
      --workflow <wf>            required when the order-id is a bare run id
      --origin <url>             hub origin (else settings.hubOrigin)
      --harness <id>             which registered harness hosts the step agent
                                 (below a selected roster candidate; else the
                                 step def's 'harness' field, then the first
                                 registered one)
      --shift <id>           dispatching Shift's self-declared id (else
                                 env OWENLOOP_SHIFT_ID); advisory only
      --heartbeat-interval <ms>  lease renew cadence (default 60000)
      --jump-tolerance <ms>      wall-gap slack before a tick is treated as a
                                 clock jump / laptop sleep (default 30000)
      --submit-grace <ms>        after the turn ends, how long to keep asking the
                                 hub whether the agent's submit landed (default
                                 15000). Task completion comes from the HUB, never
                                 from the harness stream.
      --confirm-interval <ms>    poll cadence inside that grace (default 1000)

  release options:
      --session <id>             session whose claims to drain (else env
                                 OWENLOOP_SESSION). Agent-held claims re-offer;
                                 exec-held claims are drain-exempt (B3).
      --origin <url>             hub origin (else settings.hubOrigin)

  settings (no options in v1):
      prints the resolved settings file path, whether it exists, each known
      knob (hubOrigin, cacheDir, stateDir, dispatchCap, commandRouting,
      maxConcurrentAgents, execReserve, localQueueHoldMs, workRoot, workRepo) with its value + provenance,
      and any unrecognized keys.
      settings.dispatchCap/stateDir are the lowest-precedence
      fallbacks for shift's --cap/--state-dir. NO secrets ever
      live in settings — credentials stay in owenloop's own store.

  sessions options:
      --all                      include 'dead' sessions (hidden by default —
                                 a dead session can no longer be resumed)
      --json                     print the raw newest-per-step records, tokens
                                 included, instead of the table
      --cache-dir <p>            override the resolved cache dir

  approvals options:
      --origin <url>             hub origin (else settings.hubOrigin)
      --json                     print pending approval rows as JSON (list only)
      --note <text>              attach an operator note (approve / deny only)
      credentials                list reads the agent:<account> slot selected by
${' '.repeat(33)}OWENLOOP_ACCOUNT (default 'default'); approve
${' '.repeat(33)}and deny read the stored human slot instead
      missing human credential   run: owenloop login --hub <origin> --as human

  join options:
      --hub <origin>             hub to redeem against (else settings.hubOrigin;
                                 one of the two is REQUIRED — the code never
                                 chooses the hub)
      --as <account>             credential account to store under (default:
                                 the Scoped Identity name the hub returns)

  shift/hold/exec/prepare/release and approvals-list env:
               credentials come from owenloop's store — each role reads the
               agent:<account> slot for its origin (never the human slot); a
               missing slot refuses with a runnable 'owenloop login' command.
${' '.repeat(15)}approvals approve/deny ignore OWENLOOP_ACCOUNT and OWENLOOP_TOKEN,
${' '.repeat(15)}never mint or log credentials, and refuse with 'owenloop login
${' '.repeat(15)}--hub <origin> --as human' when the human slot is absent. An
${' '.repeat(15)}expiring stored human OAuth credential may refresh and persist its
${' '.repeat(15)}rotation through owenloop's shared credential lock.
               OWENLOOP_ACCOUNT       Scoped Identity account for exec/prepare/release
${' '.repeat(38)}and approvals list (default 'default';
${' '.repeat(38)}shift uses --as, and stamps it onto
${' '.repeat(38)}dispatched holds/execs)
               OWENLOOP_TOKEN         dev-only bearer override — when set, used
                                      verbatim and the store + account are
${' '.repeat(38)}bypassed (NOT the primary path; never for
${' '.repeat(38)}approvals approve/deny)
               OWENLOOP_CACHE_DIR     cache root
               OWENLOOP_STATE_DIR     shift in-flight state dir
               OWENLOOP_SHIFT_LOG_DIR dir for the shift's shift.log and each
                                      worker's <run>.log; below --log-dir, above
                                      settings.shiftLogDir, default the state dir
               OWENLOOP_SHIFT_LOG_MAX_AGE_MS
                                      how long a worker's <run>.log is kept, in ms;
                                      below --log-max-age, above
                                      settings.shiftLogMaxAgeMs, default 14 days.
                                      Worker logs only — shift.log is never reaped
               OWENLOOP_SESSION       hold session-holder tag / release drain target
               OWENLOOP_SHIFT_ID  dispatching Shift's self-declared id for
                                      hold/exec/agent-run's --shift (advisory
                                      only, never for auth/routing/dispatch)
               OWENLOOP_WORK_ROOT     root for per-RUN agent work dirs
                                      (<workRoot>/<workflow>/<run>); above
                                      settings.workRoot, default <cacheDir>/work.
                                      A hub-supplied OrderPacket.workdir still
                                      wins, and is never reaped.
               OWENLOOP_WORK_REPO     local git repo to cut per-run work dirs from
                                      as worktrees instead of plain dirs; above
                                      settings.workRepo, default off

  Credentials / accounts:
      owenloop work's RUNTIME roles (shift/hold/exec/prepare/release and
      approvals list) are READ-ONLY over owenloop's credential store — they
      never write credentials. Each reads the agent:<account> slot for its
      origin (never the human slot); the account defaults to 'default'.
      Approval decisions require the stored human slot rather than an agent
      slot. They never mint or log credentials, but an expiring stored OAuth
      credential may refresh and persist its rotation under the shared lock; if
      the human slot is absent, run:
${' '.repeat(8)}owenloop login --hub <origin> --as human
      'owenloop work join' is the one deliberate provisioning-time writer: it
      stores the Scoped Identity token a hub redeem returns via owenloop's public
      storeCredential, once, at join time — not a runtime write.
        store / connect an account (run owenloop; owenloop work never writes it):
          owenloop login --hub <origin> --as agent:<account>
                                 (use --as agent for the default account)
        or provision a fresh box from a hub-issued join code:
          owenloop work join <code> --hub <origin>
        select an account at run time:
          --as <account>         on shift / hold
${' '.repeat(10)}OWENLOOP_ACCOUNT       on exec / prepare / release / approvals list
                                 (shift resolves once and threads both channels)
      owenloop work does NOT list stored accounts — enumerating an origin's accounts
      is an owenloop-side capability; check owenloop for which slots are stored.

Exit codes:
  0   success / help / version / lint clean or warnings-only
  1   runtime failure (fetch/hub error, cache write) / lint found an error
  2   usage error (unknown or missing role, missing required arg)
  3   role not implemented yet (skeleton stub — lands in a later delivery)
`;
