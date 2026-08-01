/**
 * The `owenloop work proxy --mcp` stdio-MCP mount (plan part 1).
 *
 * Makes the standing Conductor loop mountable: instead of `run()`'s self-driven
 * park, the SAME loop core (`createProxyLoop`) is driven on demand by a Conductor
 * calling MCP tools over stdio. Dormant until the first tool call — no hub
 * traffic until the Conductor asks. Four tools:
 *   - `whats_next`  → park up to `wait_ms`, running the loop's `iterate()`
 *     (presence → wake → sweep-if-changed → dispatch → reap) until a pass
 *     actually dispatches something, then return a CAPACITY VIEW
 *     `{cap, free, running}`. It hands back no order handles: the proxy spawns a
 *     detached child for every order it takes, of either kind, so there is
 *     nothing for the caller to run. Cancellable and progress-reporting.
 *   - `set_dispatch_cap` → adjust the live in-flight cap (`k = cap − inFlight`).
 *   - `submit` → post an artifact receipt through the proxy's hub connection.
 *   - `clock_in` → go on shift: set this shift's presence name and/or crew
 *     scope (`serve_pools`) on the live loop (shifts.md §8 item 4). Takes
 *     effect before the next park and the next presence ping; safe to call
 *     while a `whats_next` park is outstanding.
 *
 * Pure wiring + handlers — no stdio, no process, no timers of its own (the poll
 * wait uses the injected `sleep`). The role (`src/roles/proxy.ts`) owns the real
 * stdin/stdout pump; unit tests drive these tools with a fake loop + fake hub.
 */
import { textResult, type ToolCallContext, type ToolRegistration } from '../mcp/server.ts';
import type { HubClient } from '../hub/client.ts';
import type { ContactHolder } from '../hub/types.ts';
import type { ProxyLoop } from './loop.ts';

/** Default `whats_next` park ceiling — bounds a call so the Conductor re-polls. */
const DEFAULT_WAIT_MS = 25_000;

/**
 * Cadence of `notifications/progress` frames while a `whats_next` park is idle —
 * keepalives against the client's stdio idle timeout on long parks (plan
 * section 2). Only emitted when the caller supplied a progressToken
 * (`ctx.sendProgress` is a no-op otherwise).
 */
const PROGRESS_INTERVAL_MS = 25_000;

export interface ProxyMcpDeps {
  loop: ProxyLoop;
  hub: HubClient;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Poll cadence between `iterate()` attempts inside a `whats_next` park. */
  pollIntervalMs: number;
  /** Default park ceiling when the caller omits `wait_ms`. */
  defaultWaitMs?: number;
  /**
   * W7: the holder tag this proxy's `submit` calls carry (D4) — self-declared
   * and advisory only (D8/INV-82). The proxy has no session concept, so this is
   * built once at role-wiring time (`resolveHolder(undefined, env,
   * {conductorId})`), not per-call.
   */
  holder?: ContactHolder;
  /**
   * This Conductor process incarnation's self-declared id (`cnd_<uuid>`),
   * advisory/observability only (INV-82). Echoed on a `clock_in` reply so the
   * caller can see which shift it just clocked in — matching the `cnd_` id the
   * console shows. When absent, `clock_in` simply omits `conductor_id` from its
   * reply; nothing else is derived from another source.
   */
  conductorId?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A sleep that also resolves the moment the call is cancelled. */
function waitOrCancel(ms: number, ctx: ToolCallContext, sleep: (ms: number) => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    ctx.onCancel(finish);
    void sleep(ms).then(finish);
  });
}

/**
 * The whole `whats_next` reply (D7): pure capacity telemetry, no order handles.
 * `running` is derived, not separately tracked — `freeCapacity()` is
 * `cap − liveInFlight` against the SAME live `cap`, so `cap − free` is exactly
 * the number of live children.
 */
function capacityView(loop: ProxyLoop): unknown {
  const cap = loop.getCap();
  const free = loop.freeCapacity();
  return { cap, free, running: cap - free };
}

function numArg(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Build the proxy MCP tools. The `whats_next` handler parks by repeatedly running
 * the loop's `iterate()` (each pass may spawn `exec` children for command orders
 * and `agent-run` children for agent orders) until a pass dispatches something or
 * the wait ceiling elapses. Either way the reply is the capacity view.
 */
export function buildProxyTools(deps: ProxyMcpDeps): ToolRegistration[] {
  const defaultWait = deps.defaultWaitMs ?? DEFAULT_WAIT_MS;

  // One park at a time: the loop's cursor/presence state is a single closure, so
  // two concurrent whats_next calls would interleave iterate() unpredictably.
  // An overlapping call gets a fast isError instead of queueing silently.
  let parking = false;

  const whatsNext: ToolRegistration = {
    name: 'whats_next',
    description:
      'Park at the hub and dispatch whatever work is available, then report dispatch capacity as {cap, free, running}. Every order the proxy takes — command or agent — is run in a detached child, so no order handles are returned. Waits up to wait_ms for work before returning.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_ms: { type: 'number', description: `Max ms to park before returning empty (default ${defaultWait}).` },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      if (parking) {
        return textResult({ error: 'whats_next is already parked — one park at a time (cancel it or wait for it to return)' }, true);
      }
      parking = true;
      try {
        const waitMs = numArg(args['wait_ms'], defaultWait);
        const deadline = deps.now() + waitMs;
        let lastProgressAt = deps.now();
        for (;;) {
          if (ctx.cancelled) return textResult(capacityView(deps.loop));
          let dispatched: number;
          try {
            dispatched = await deps.loop.iterate();
          } catch (e) {
            return textResult({ error: errMsg(e) }, true);
          }
          if (dispatched > 0) {
            ctx.sendProgress({ message: `dispatched ${dispatched} order(s)` });
            return textResult(capacityView(deps.loop));
          }
          const remaining = deadline - deps.now();
          if (remaining <= 0 || ctx.cancelled) return textResult(capacityView(deps.loop));
          // Keepalive on long parks: a progress frame roughly every
          // PROGRESS_INTERVAL_MS so the client's stdio idle timeout never fires.
          if (deps.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            lastProgressAt = deps.now();
            ctx.sendProgress({ message: 'parked — no dispatchable work yet' });
          }
          await waitOrCancel(Math.min(deps.pollIntervalMs, remaining), ctx, deps.sleep);
        }
      } finally {
        parking = false;
      }
    },
  };

  const setDispatchCap: ToolRegistration = {
    name: 'set_dispatch_cap',
    description:
      'Set the live dispatch cap — the maximum orders in flight at once (exec + agent-run children). Takes effect on the next whats_next park.',
    inputSchema: {
      type: 'object',
      required: ['cap'],
      properties: { cap: { type: 'number', description: 'New cap (non-negative integer).' } },
      additionalProperties: false,
    },
    handler: (args) => {
      const raw = args['cap'];
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        return textResult({ error: 'set_dispatch_cap requires a non-negative integer "cap"' }, true);
      }
      deps.loop.setCap(raw);
      return textResult({ cap: deps.loop.getCap(), free: deps.loop.freeCapacity() });
    },
  };

  const clockIn: ToolRegistration = {
    name: 'clock_in',
    description:
      "Go on shift: set this shift's crew scope (serve_pools) and/or its presence name on the live loop. " +
      "A field you omit is left unchanged. serve_pools: [] means serve ALL of this identity's crews — it never means none. " +
      'Takes effect before the next park and the next presence ping: the next whats_next iteration pings presence with the ' +
      'new name and scope, and its sweep asks for the new crews. Safe to call while a whats_next park is outstanding — the ' +
      'park already in flight finishes under the previous scope and every later iteration uses the new one; work already ' +
      'dispatched keeps running. Renaming leaves the old presence row at the hub until it ages out (~3 min). Scope is what ' +
      'this shift ASKS for; the hub enforces what it may actually serve, per park.',
    inputSchema: {
      type: 'object',
      properties: {
        serve_pools: {
          type: 'array',
          items: { type: 'string' },
          description: "Crews (pools) to serve. [] = all of this identity's crews. Omit to leave the current scope unchanged.",
        },
        name: { type: 'string', description: 'Presence name for this shift (max 200 chars). Omit to leave it unchanged.' },
      },
      additionalProperties: false,
    },
    handler: (args) => {
      // D4: validate BOTH fields before mutating either — a call with a good
      // name and a bad serve_pools must change nothing at all.
      let servePools: string[] | undefined;
      const rawPools = args['serve_pools'];
      if (rawPools !== undefined) {
        if (!Array.isArray(rawPools) || !rawPools.every((s) => typeof s === 'string' && s.trim() !== '')) {
          return textResult({ error: 'clock_in serve_pools must be an array of non-empty crew names' }, true);
        }
        servePools = rawPools.map((s) => s.trim());
      }

      let name: string | undefined;
      const rawName = args['name'];
      if (rawName !== undefined) {
        if (typeof rawName !== 'string' || rawName.trim() === '' || rawName.trim().length > 200) {
          return textResult({ error: 'clock_in name must be a non-empty string of at most 200 characters' }, true);
        }
        name = rawName.trim();
      }

      const shift = deps.loop.setShift({
        ...(name !== undefined ? { name } : {}),
        ...(servePools !== undefined ? { servePools } : {}),
      });
      return textResult({
        name: shift.name,
        serve_pools: shift.servePools,
        scope_all: shift.servePools.length === 0,
        ...(deps.conductorId !== undefined ? { conductor_id: deps.conductorId } : {}),
      });
    },
  };

  const submit: ToolRegistration = {
    name: 'submit',
    description:
      "Submit an artifact receipt to the hub through the proxy's connection: post a value to an owed output path of a run.",
    inputSchema: {
      type: 'object',
      required: ['workflow', 'run', 'path', 'value'],
      properties: {
        workflow: { type: 'string' },
        run: { type: 'string' },
        path: { type: 'string' },
        value: { description: 'The receipt value (any JSON).' },
        done: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const workflow = args['workflow'];
      const run = args['run'];
      const path = args['path'];
      if (typeof workflow !== 'string' || workflow === '') return textResult({ error: 'submit requires a string "workflow"' }, true);
      if (typeof run !== 'string' || run === '') return textResult({ error: 'submit requires a string "run"' }, true);
      if (typeof path !== 'string' || path === '') return textResult({ error: 'submit requires a string "path"' }, true);
      if (!('value' in args)) return textResult({ error: 'submit requires a "value"' }, true);
      const done = args['done'];
      try {
        const res = await deps.hub.submit({
          workflow,
          run,
          path,
          value: args['value'],
          ...(typeof done === 'boolean' ? { done } : {}),
          ...(deps.holder !== undefined ? { holder: deps.holder } : {}),
        });
        // Run-ended reap: a closing submit is the proxy's in-process end-of-run
        // signal — free the run's dispatch slot now rather than TTL-later.
        if (res.closed === true) deps.loop.noteRunEnded(run);
        return textResult({ outcome: res.outcome, closed: res.closed ?? false, text: res.text });
      } catch (e) {
        return textResult({ error: errMsg(e) }, true);
      }
    },
  };

  return [whatsNext, setDispatchCap, submit, clockIn];
}
