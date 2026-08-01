/**
 * The `owenloop work hold --mcp` stdio-MCP mount (plan part 2).
 *
 * A born-bound work-holder: the D2 stamped Step Agent's frontmatter declares
 * `mcpServers.owenwork = owenloop work hold --order <wf>/<run> --origin <url> --mcp`,
 * so when the Step Agent session boots it launches THIS as a stdio MCP server. The
 * server exposes two bare tools the model uses to do its order:
 *   - `get_order` → the order packet (prompt, inputs, owed outputs) for the run
 *     this holder is bound to. No ids are arguments — they came in on argv, never
 *     through the model.
 *   - `submit`    → post a receipt for an owed output path; when the hub reports
 *     the submit CLOSED the run, the lease loop is stopped with `release:false`
 *     (the claim is already gone).
 *
 * Underneath the tools, the SAME lease loop the CLI `hold` runs keeps the order's
 * lease warm: `createHoldMcp` builds the loop with `onOrder` wired to capture the
 * first-contact packet (so `get_order` needn't re-fetch) and both output sinks
 * routed to stderr (stdout is the JSON-RPC channel). The role starts the loop and
 * pumps stdin into the server; loop and server share one process, and stdin EOF
 * (the session died) stops the loop for its final-breath release.
 *
 * This module is pure wiring + tool handlers — no stdio, no process, no timers of
 * its own — so a unit test drives the tools with a fake hub and a scriptable
 * clock. The role (`src/roles/hold.ts`) owns the real stdin/stdout pump.
 */
import { textResult, type ToolRegistration, type ToolResult } from '../mcp/server.ts';
import type { HubClient } from '../hub/client.ts';
import type { ContactHolder, GetOrderResponse } from '../hub/types.ts';
import type { StopOptions } from '../lease/loop.ts';
import { createHoldLoop, type HoldLoop, type HoldOutcome } from './loop.ts';

export interface HoldMcpDeps {
  hub: HubClient;
  workflow: string;
  run: string;
  /** B3 holder tag; rides get_order/heartbeat when known. */
  holder?: ContactHolder;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Diagnostics sink — stderr (stdout is the MCP transport). */
  err: (line: string) => void;
  heartbeatIntervalMs?: number;
  /** Wall-gap slack before a tick is treated as a clock jump (default 30_000). */
  jumpToleranceMs?: number;
}

export interface HoldMcpMount {
  /** The two tools (`get_order`, `submit`) for the MCP server. */
  tools: ToolRegistration[];
  /** The lease loop kept warm underneath — the role runs and stops it. */
  loop: HoldLoop;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A lean, model-facing view of the order packet. */
function orderView(res: GetOrderResponse): unknown {
  return { workflow: res.workflow, run: res.run, order: res.order, text: res.text };
}

/**
 * Build the hold MCP mount: the lease loop plus its two tools. The caller (the
 * role) creates the MCP server around `tools`, starts `loop.run()`, and pumps
 * stdin — stopping the loop on stdin EOF.
 */
export function createHoldMcp(deps: HoldMcpDeps): HoldMcpMount {
  const { hub, workflow, run } = deps;
  const holderReq = deps.holder !== undefined ? { holder: deps.holder } : {};

  // Captured from the loop's first contact so `get_order` needn't re-fetch (and
  // re-contend the pickup window). Falls back to a live fetch if a tool call
  // beats first contact.
  let captured: GetOrderResponse | undefined;

  // Set the moment the lease loop's run() settles (lease-lost, completed,
  // released, …): from then on this mount no longer holds the order, so BOTH
  // tools fast-fail with isError and never touch the hub again (plan section 4
  // — a lost claim must not be worked or double-submitted).
  let terminal: HoldOutcome | undefined;

  const inner = createHoldLoop({
    hub,
    workflow,
    run,
    sleep: deps.sleep,
    now: deps.now,
    // Both sinks to stderr: stdout is the JSON-RPC frame channel.
    out: deps.err,
    err: deps.err,
    onOrder: (res) => {
      captured = res;
    },
    ...(deps.holder !== undefined ? { holder: deps.holder } : {}),
    ...(deps.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: deps.heartbeatIntervalMs } : {}),
    ...(deps.jumpToleranceMs !== undefined ? { jumpToleranceMs: deps.jumpToleranceMs } : {}),
  });

  // The loop the role runs is a thin wrapper that records the terminal outcome
  // when run() settles, so the tool guards see it without the role's help.
  const loop: HoldLoop = {
    run: async () => {
      const outcome = await inner.run();
      terminal = outcome;
      return outcome;
    },
    stop: (reason?: string, stopOpts?: StopOptions) => inner.stop(reason, stopOpts),
  };

  /** The fast-fail both tools apply once the hold is over. */
  function terminalGuard(): ToolResult | undefined {
    if (terminal === undefined) return undefined;
    return textResult({ error: `order no longer held (${terminal}) — stop` }, true);
  }

  const getOrderTool: ToolRegistration = {
    name: 'get_order',
    description:
      "Return this work-holder's order — the prompt, consumed inputs, and owed output paths for the run it is bound to. Takes no arguments (the run is fixed at launch).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const gone = terminalGuard();
      if (gone !== undefined) return gone;
      if (captured !== undefined) return textResult(orderView(captured));
      try {
        const res = await hub.getOrder({ workflow, run, ...holderReq });
        captured = res;
        return textResult(orderView(res));
      } catch (e) {
        return textResult({ error: errMsg(e) }, true);
      }
    },
  };

  const submitTool: ToolRegistration = {
    name: 'submit',
    description:
      'Submit a receipt for one owed output path of this order. Set done=true when this is the final value for the path. When the hub reports the run has closed, the holder releases and exits.',
    inputSchema: {
      type: 'object',
      required: ['path', 'value'],
      properties: {
        path: { type: 'string', description: 'The owed output path to submit a receipt for.' },
        value: { description: 'The receipt value (any JSON).' },
        done: { type: 'boolean', description: 'Mark this the final submit for the path.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const gone = terminalGuard();
      if (gone !== undefined) return gone;
      const path = args['path'];
      if (typeof path !== 'string' || path === '') {
        return textResult({ error: 'submit requires a non-empty string "path"' }, true);
      }
      if (!('value' in args)) {
        return textResult({ error: 'submit requires a "value"' }, true);
      }
      const done = args['done'];
      try {
        const res = await hub.submit({
          workflow,
          run,
          path,
          value: args['value'],
          ...(typeof done === 'boolean' ? { done } : {}),
          ...holderReq,
        });
        // The run closed — stop holding WITHOUT releasing (the claim is gone).
        if (res.closed === true) loop.stop('submitted', { release: false });
        return textResult({ outcome: res.outcome, closed: res.closed ?? false, text: res.text });
      } catch (e) {
        return textResult({ error: errMsg(e) }, true);
      }
    },
  };

  return { tools: [getOrderTool, submitTool], loop };
}
