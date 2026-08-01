/**
 * Single source of the CLI usage text. Printed by `--help`/`help` (to stdout,
 * exit 0) and on a dispatch error (to stderr, exit 2). Keeping it in one place
 * means the help output and the error output never drift apart.
 */
export const USAGE = `owenloop work — execution-side CLI companion to owenloop

Usage:
  owenloop work proxy [options]               park at the hub and dispatch orders
  owenloop work hold --order <id> [options]   hold an order with a heartbeating lease
  owenloop work exec <order-id> [options]     run a command order in a self-leasing loop
  owenloop work agent-run <order-id> [options]  host an agent order's step agent in a
                                         harness, in a self-leasing loop
  owenloop work prepare <workflow> [--origin <url>]
                                         fetch, cache & normalize step specs
  owenloop work lint <workflow-name | path>   lint x.harness option bags in a def
  owenloop work sessions [--all] [--json]     list this machine's recorded harness
                                         sessions and how to re-open them
  owenloop work release --session <id> [options]  drain a session's held claims
  owenloop work settings                      print the resolved settings file
  owenloop work join <code> [--hub <origin>] [--as <account>]
                                         redeem a join code and store the Scoped
                                         Identity credential (one-time provisioning)

Options:
  -h, --help                     show this help and exit 0
      --version                  print the owenloop work version and exit 0

  proxy options:
      --origin <url>             hub origin (else settings.hubOrigin)
      --as <account>             Scoped Identity credential account to read + hand
                                 to dispatched holds/execs (default 'default')
      --name <n>                 Conductor name (default <hostname>/<cwd>)
      --serve-pools a,b          serve only these pools (comma list; default:
                                 all pools on the key)
      --cap <n>                  max in-flight exec children (default 3)
      --workflow <id>            poll only this instance (default: inbox — all)
      --poll-interval <ms>       wake poll cadence (default 5000)
      --once                     bootstrap wake + one sweep, then exit (demo/e2e)
      --mcp                      run as a stdio-MCP server instead of a self-driven
                                 park: tools whats_next / set_dispatch_cap / submit
                                 (mutually exclusive with --once)
      --max-agents <n>           max in-flight agent-run children, separate from
                                 --cap (default 4; else settings.maxConcurrentAgents)
      --cache-dir/--state-dir <p>   override the resolved dirs

  hold options:
      --order <workflow>/<run>   the order to hold (or --order <run> --workflow)
      --workflow <wf>            required when --order is a bare run id
      --origin <url>             hub origin (else settings.hubOrigin)
      --as <account>             Scoped Identity credential account (default
                                 'default'; the proxy stamps this into born-bound
                                 holds)
      --session <id>             session-holder tag (else env OWENWORK_SESSION;
                                 else an anon:<hostname>:<pid> fallback — a
                                 holder is always sent)
      --conductor <id>           dispatching Conductor's self-declared id (else
                                 env OWENWORK_CONDUCTOR_ID); advisory only
      --heartbeat-interval <ms>  lease renew cadence (default 60000)
      --jump-tolerance <ms>      wall-gap slack before a tick is treated as a
                                 clock jump / laptop sleep (default 30000)
      --ignore-stdin             don't final-breath on stdin EOF (detached use)
      --mcp                      run as a stdio-MCP work-holder: tools get_order /
                                 submit, lease kept warm underneath (mutually
                                 exclusive with --ignore-stdin — stdin is the
                                 transport)

  exec options (usually spawned by proxy, not run by hand):
      <workflow>/<run>           the command order to run (positional order-id;
                                 or a bare <run> plus --workflow <wf>)
      --workflow <wf>            required when the order-id is a bare run id
      --origin <url>             hub origin (else settings.hubOrigin)
      --conductor <id>           dispatching Conductor's self-declared id (else
                                 env OWENWORK_CONDUCTOR_ID); advisory only
      --heartbeat-interval <ms>  lease renew cadence (default 60000)
      --jump-tolerance <ms>      wall-gap slack before a tick is treated as a
                                 clock jump / laptop sleep (default 30000)

  agent-run options (spawned by the proxy, not run by hand):
      <workflow>/<run>           the agent order to host (positional order-id;
                                 or a bare <run> plus --workflow <wf>)
      --workflow <wf>            required when the order-id is a bare run id
      --origin <url>             hub origin (else settings.hubOrigin)
      --harness <id>             which registered harness hosts the step agent
                                 (else env OWENWORK_HARNESS, else the step def's
                                 'harness' field, else the first registered one)
      --conductor <id>           dispatching Conductor's self-declared id (else
                                 env OWENWORK_CONDUCTOR_ID); advisory only
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
                                 OWENWORK_SESSION). Agent-held claims re-offer;
                                 exec-held claims are drain-exempt (B3).
      --origin <url>             hub origin (else settings.hubOrigin)

  settings (no options in v1):
      prints the resolved settings file path, whether it exists, each known
      knob (hubOrigin, cacheDir, stateDir, dispatchCap, commandRouting,
      maxConcurrentAgents, workRoot, workRepo) with its value + provenance,
      and any unrecognized keys.
      settings.dispatchCap/stateDir are the lowest-precedence
      fallbacks for proxy's --cap/--state-dir. NO secrets ever
      live in settings — credentials stay in owenloop's own store.

  sessions options:
      --all                      include 'dead' sessions (hidden by default —
                                 a dead session can no longer be resumed)
      --json                     print the raw newest-per-step records, tokens
                                 included, instead of the table
      --cache-dir <p>            override the resolved cache dir

  join options:
      --hub <origin>             hub to redeem against (else settings.hubOrigin;
                                 one of the two is REQUIRED — the code never
                                 chooses the hub)
      --as <account>             credential account to store under (default:
                                 the Scoped Identity name the hub returns)

  proxy/hold/exec/prepare/release env:
               credentials come from owenloop's store — each role reads the
               agent:<account> slot for its origin (never the human slot); a
               missing slot refuses with a runnable 'owenloop login' command.
               OWENWORK_ACCOUNT       Scoped Identity account for exec/prepare/release
                                      (default 'default'; proxy uses --as, and
                                      stamps it onto dispatched holds/execs)
               OWENWORK_TOKEN         dev-only bearer override — when set, used
                                      verbatim and the store + account are
                                      bypassed (NOT the primary path)
               OWENWORK_CACHE_DIR     cache root
               OWENWORK_STATE_DIR     proxy in-flight state dir
               OWENWORK_SESSION       hold session-holder tag / release drain target
               OWENWORK_CONDUCTOR_ID  dispatching Conductor's self-declared id for
                                      hold/exec/agent-run's --conductor (advisory
                                      only, never for auth/routing/dispatch)
               OWENWORK_HARNESS       agent-run harness id; below --harness, above
                                      the step def's 'harness' field
               OWENWORK_WORK_ROOT     root for per-RUN agent work dirs
                                      (<workRoot>/<workflow>/<run>); above
                                      settings.workRoot, default <cacheDir>/work.
                                      A hub-supplied OrderPacket.workdir still
                                      wins, and is never reaped.
               OWENWORK_WORK_REPO     local git repo to cut per-run work dirs from
                                      as worktrees instead of plain dirs; above
                                      settings.workRepo, default off

  Credentials / accounts:
      owenloop work's RUNTIME roles (proxy/hold/exec/prepare/release) are READ-ONLY
      over owenloop's credential store — they never write credentials. Each
      role reads the agent:<account> slot for its origin (never the human
      slot); the account defaults to 'default'. 'owenloop work join' is the one
      deliberate provisioning-time writer: it stores the Scoped Identity token a hub
      redeem returns via owenloop's public storeCredential, once, at join time
      — not a runtime write.
        store / connect an account (run owenloop; owenloop work never writes it):
          owenloop login --hub <origin> --as agent:<account>
                                 (use --as agent for the default account)
        or provision a fresh box from a hub-issued join code:
          owenloop work join <code> --hub <origin>
        select an account at run time:
          --as <account>         on proxy / hold
          OWENWORK_ACCOUNT       on exec / prepare / release
                                 (proxy resolves once and threads both channels)
      owenloop work does NOT list stored accounts — enumerating an origin's accounts
      is an owenloop-side capability; check owenloop for which slots are stored.

Exit codes:
  0   success / help / version / lint clean or warnings-only
  1   runtime failure (fetch/hub error, cache write) / lint found an error
  2   usage error (unknown or missing role, missing required arg)
  3   role not implemented yet (skeleton stub — lands in a later delivery)
`;
