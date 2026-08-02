# Shift walkthrough coverage

This runbook records which parts of the Phase-7 shift walkthrough are automated in this repository and which parts require an interactive harness. The automated tests use only throwaway local state, a scripted HTTP hub, and local child processes.

## Coverage map

| Scenario | Coverage | Status |
| --- | --- | --- |
| 1. Terminal-only shift with no agent attending | `terminal-only daemon dispatches before any shift next and keeps presence unattended` in `shift-blocking-acceptance.test.ts` | Automated |
| 2. Attended shift with a forced mid-shift turn end | `attending shift survives cancellation and dispatches while no client is parked` in `shift-blocking-acceptance.test.ts`, plus the Claude Code drill below for the harness-side backstop | Daemon half automated; harness half manual |
| 3. Codex attended shift | The same test-controlled CLI child in the scenario-2 test covers the shared command and socket transport; the Codex drill below covers Codex-specific behavior | Transport automated; harness behavior manual |
| 4. Gate round-trip through a poll-reply event | `status, atomic clock-in validation, attendance, typed gate event drain, and wait timeout` in `shift-server.test.ts`; the live hub round-trip remains a residual production gap | Protocol drain automated; live round-trip unavailable |
| 5. `shift end` from another terminal resolves an in-flight poll | `idle next blocks, dispatch wakes it, a second next parks, and a third terminal ends the shift` in `shift-blocking-acceptance.test.ts` | Pre-existing automated coverage |

## Simulation contract

The automated tests start a real foreground daemon and a real `owenloop shift next` operating-system child. The child is a harness-neutral stand-in for an attending agent. The tests prove the following daemon and CLI behavior:

- A daemon polls the scripted hub and claims a visible order before any `shift next` client exists.
- Presence requests made before attendance omit the `attended_at` field.
- A later `shift next` receives a queued `dispatched` event.
- A `shift next --wait 90` child records attendance, parks on the Unix socket, and can be terminated without stopping the daemon.
- After the attending child exits, the daemon releases the single parked-client slot, continues dispatching, and retains the dispatch until a replacement poll drains it.
- A typed gate-shaped event passes through the local FIFO exactly once.

The simulation does not prove Claude Code or Codex skill loading, model behavior, interactive TUI continuation, human-question relay, `owenloop provide`, Claude `/goal` reinjection, Codex `create_goal`, or that a model chooses to poll again. The tests do not invoke a real `claude` or `codex` binary and do not contact a live hub.

## Claude Code forced-turn-end drill

Run this drill manually when the following preconditions hold:

- The installed shift skill is the version under test.
- The workspace is trusted and disposable.
- The authenticated CLI and the Claude Code subscription/session are available.
- The crew and workflow are disposable and can be ended after the drill.

1. Start the shift through the interactive harness with `/goal run a shift on <crew>`.
2. Observe the repeated `owenloop shift next --wait 90` calls and confirm the shift status becomes attended.
3. Interrupt one active model turn without ending the daemon and without clearing the goal.
4. Make one order visible while the model turn is absent.
5. Record evidence that the daemon dispatched the order during the gap.
6. Record evidence that the goal judge started a later turn and that the later turn re-entered the same `owenloop shift next --wait 90` poll loop.
7. End the shift explicitly.

CI cannot run this drill. The drill requires a real interactive harness, subscription and session state, skill loading, and goal-judge behavior. The scenario-2 automated test proves only the daemon-side cancellation and dispatch behavior that the drill relies on.

## Codex attended-shift drill

Run this drill manually when the following preconditions hold:

- An interactive Codex TUI or app-server is available.
- The shared shift skill is installed in the Codex environment.
- The authenticated CLI is available.
- The crew and workflow are disposable.

1. Ask Codex to `run a shift on <crew>`.
2. Verify that `create_goal` receives exactly `the shift on <crew> has been explicitly stopped by the human` as its objective.
3. Verify that the session uses the same `owenloop shift next --wait 90` loop.
4. Verify that shift status becomes attended.
5. End the shift explicitly.

The automated CLI-child simulation proves the shared command and Unix-socket transport only. The automated simulation does not prove Codex skill loading, Codex goal creation or continuation, Codex model behavior, or interactive TUI continuation.

## Gate residual gap

The current repository has no pending-gates method in `packages/work/src/hub/client.ts`, and `packages/work/src/proxy/loop.ts` does not construct a `gate` event. The server test `status, atomic clock-in validation, attendance, typed gate event drain, and wait timeout` covers the existing typed event FIFO and local poll-reply path without inventing a hub integration.

A real `gate arrives -> shift next returns the gate -> a human replies -> owenloop provide -> polling resumes` drill cannot run until a separate scoped change adds hub polling and a gate producer in this repository. The current test must not be read as end-to-end gate coverage.
