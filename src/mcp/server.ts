/**
 * A minimal, dependency-light MCP server core — newline-delimited JSON-RPC 2.0
 * over stdio, hand-rolled (O2 plan Decision 1).
 *
 * PROVENANCE: this transport core was ported from the execution subsystem's
 * proven `src/mcp/server.ts` implementation (`createMcpServer` / `pumpStdin` /
 * `textResult` / the error-code consts / `LineStream`). The implementation now
 * lives in the root package so engine and execution commands ship together.
 * `test/mcpcore.test.ts` re-proves the transport behavior against this file,
 * so later changes are caught rather than assumed.
 *
 * WHY hand-rolled, not `@modelcontextprotocol/sdk`: this repo's posture is two
 * runtime deps (`@cfworker/json-schema` + `yaml`). The SDK drags zod and a
 * transport stack for a surface we need only a few hundred lines of. The hub
 * side already proves interop against the official SDK client, so drift is
 * tested rather than assumed.
 *
 * The core is transport-agnostic and side-effect-injected: it exposes
 * `handleLine(line)` (feed it one framed JSON-RPC line) and `close(reason)`
 * (transport EOF), and it emits every outbound frame through the injected
 * `write(msg)`. Unit tests feed lines and inspect writes with no child process;
 * `pumpStdin` wires the real `process.stdin`/`process.stdout` in the roles.
 *
 * Supported methods (the subset an MCP host needs):
 *   - `initialize`            → capabilities `{tools:{}}`, serverInfo,
 *                               instructions, and the agreed protocolVersion
 *                               (echo the client's when recognized, else
 *                               answer with ours).
 *   - `notifications/initialized` → no-op (no response; it is a notification).
 *   - `ping`                  → `{}`.
 *   - `tools/list`            → the registered tool defs.
 *   - `tools/call`            → validate arguments against the registered
 *                               input schema, then dispatch to the handler;
 *                               the result is `{content:[{type:'text',text:<JSON>}], isError?}`.
 *   - `notifications/cancelled` → abort a tracked in-flight `tools/call`; the
 *                               aborted call sends NO response frame.
 *   - outbound `notifications/progress` when a call carried
 *     `params._meta.progressToken` (via `ctx.sendProgress`).
 *
 * Errors: unknown method → -32601; malformed JSON / bad envelope → -32700;
 * invalid params (including a tool-schema mismatch) → -32602. A notification
 * (no `id`) never gets a response, even on error. The process must never crash
 * on a bad line.
 */

import { summarizeIssues, validateValue } from '../schema.ts';

/** The MCP revisions this server will agree to echo back on `initialize`. */
const RECOGNIZED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);

/** The version we answer with when the client's is missing or unrecognized. */
const OUR_PROTOCOL_VERSION = '2025-06-18';

// The charter is served verbatim at MCP initialization and its bytes are hashed
// into docs/evals/mcp-charter-baseline.json. Any edit here invalidates that
// baseline. Regenerating it needs the --output flag — a bare
// `npm run eval:mcp-charter` prints the report and writes nothing:
//
//   npm run eval:mcp-charter -- --output docs/evals/mcp-charter-baseline.json
//
// Commit the charter edit and the regenerated baseline together.
//
// One run is one sample, not a measurement. Codex's score moves between runs
// at a FIXED charter sha: 35773e2e scored 3/4, 4/4 and 4/4 on three runs
// across fifteen minutes. Read the committed number as a point in a range, and
// re-run before concluding an edit helped or hurt. The run history and the
// per-arm ranges live in docs/mcp-charter-eval.md.
//
// search_workflows is deliberately NOT named here. The eval scores the first
// tool call, and offering a second discovery verb in the charter competes with
// the catalog read this paragraph exists to force. Its own tool description
// carries when to prefer it.
const CHIEF_OF_STAFF_INSTRUCTIONS = `Owenloop is a control plane for delegated multi-step work. Act as the human's chief of staff, not as an inline worker.

Call \`list_workflows\` on every request, before you answer it, before you ask the human for missing inputs, and before you start any work. There is no request too small, too urgent, or too far outside software for this: you cannot know what the human has published without reading the catalog. Then inspect promising definitions; an existing playbook beats freelancing. When one fits, use \`start_run\` and let its crews execute. Do not perform step work inline unless no available crew serves the required capability. \`submit\` is for a crew member returning a held order, not for a chief of staff to fabricate progress.

After starting or attending runs, park on \`wake\`; when its cursor changes, call \`whats_next\`. Use \`whats_next\` directly when a workflow needs a tick or the human asks for their inbox. Relay gates, worker asks, receipts, and status clearly to the human. Use \`provide_input\` for seeded or owed human inputs. Use \`retry_artifact\` with the human's answer when a worker escalated with an ask.

Treat rejection as feedback that must be surfaced and resolved. Never bypass a rejected artifact to force progress; use \`reject_artifact\` only to send an actual upstream defect back with a concrete reason.

For your own complex one-off work that needs a workflow, use the ephemeral skill. Its explicitly ephemeral, caller-owned run is the exception: the caller may execute its served orders and return their real outputs with \`submit\` before retiring the name. Ordinary durable runs remain crew-first and never justify fabricated progress.

Only after the mandatory catalog read, when no single listed playbook fits, use the plan skill solely if the inspected catalog itself contains at least two distinct, compatible playbooks that together cover the work except for one coherent bespoke gap. Compile only those catalog pieces into their checked, approval-gated ephemeral composite, surface its parked approval gate, and release it only after explicit approval. Otherwise, state plainly that the catalog has no fitting playbook or composite and ask the human how to proceed; do not offer, begin, or describe doing any of the requested work inline.`;

// ---- JSON-RPC error codes ---------------------------------------------------

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/** A tool result as MCP serves it: text content blocks, optional error flag. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Convenience: wrap a JSON-able value as a single text content block. */
export function textResult(value: unknown, isError = false): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

/** The per-call context handed to a tool handler. */
export interface ToolCallContext {
  /** True once the caller cancelled this request (`notifications/cancelled`). */
  readonly cancelled: boolean;
  /** Register a callback fired when this request is cancelled. */
  onCancel(cb: () => void): void;
  /**
   * Emit a `notifications/progress` frame for this call. A no-op when the caller
   * supplied no `progressToken` (progress is meaningless without one).
   */
  sendProgress(payload: { progress?: number; total?: number; message?: string }): void;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult> | ToolResult;

/** A registered tool: its advertised shape plus the handler that runs it. */
export interface ToolRegistration {
  name: string;
  description: string;
  /** JSON-Schema for the tool's arguments (advertised via `tools/list`). */
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: ToolRegistration[];
  /** Outbound frame sink — the caller JSON-serializes + newline-terminates. */
  write: (msg: unknown) => void;
  /** Diagnostic sink (stderr); protocol frames never go here. */
  err?: (line: string) => void;
}

export interface McpServer {
  /** Feed one framed JSON-RPC line (no trailing newline required). */
  handleLine(line: string): Promise<void>;
  /**
   * Transport EOF — cancels in-flight calls so parked handlers unblock. Their
   * replies are still flushed (close-cancel ≠ client-cancel; see `InFlight`).
   */
  close(reason?: string): void;
}

interface InFlight {
  cancelled: boolean;
  /**
   * The cancellation came from transport close (EOF), not a client
   * `notifications/cancelled`. A CLIENT cancel suppresses the response frame
   * (the JSON-RPC/MCP cancel contract); a CLOSE cancel only exists to unpark
   * the call so EOF can complete — its reply is still flushed to the pipe,
   * because a call received before EOF deserves its answer (the client may
   * well still be reading; a submit reply racing EOF must not be swallowed).
   */
  byClose: boolean;
  cancelCbs: Array<() => void>;
}

export function createMcpServer(opts: McpServerOptions): McpServer {
  const err = opts.err ?? ((): void => {});
  // A plugin supplies its manifest version through the MCP environment. An
  // absent expectation leaves hand-run and headless MCP servers unchanged;
  // only a supplied value can describe a plugin/CLI drift. The comparison is
  // deferred to tools/call instead of rejecting startup, because startup
  // rejection surfaces as the opaque "server transport closed unexpectedly".
  const expectedPluginVersion = process.env['OWENLOOP_PLUGIN_VERSION'];
  const tools = new Map<string, ToolRegistration>();
  for (const t of opts.tools) tools.set(t.name, t);

  // Tracks in-flight tools/call requests by id so notifications/cancelled can
  // abort them (and so we can suppress the response frame of a cancelled call).
  const inFlight = new Map<string, InFlight>();
  let closed = false;

  // NOTE: deliberately NOT gated on `closed` — a reply whose handler settled a
  // microtask after transport EOF must still reach the pipe (the cancel
  // contract already suppresses replies of cancelled calls, and sendProgress
  // gates on `closed` itself). A write to a gone pipe lands in the catch.
  function send(msg: unknown): void {
    try {
      opts.write(msg);
    } catch (e) {
      err(`mcp: write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function reply(id: JsonRpcId, result: unknown): void {
    send({ jsonrpc: '2.0', id, result });
  }

  function replyError(id: JsonRpcId, code: number, message: string): void {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function keyOf(id: JsonRpcId): string {
    return typeof id === 'number' ? `n:${id}` : `s:${String(id)}`;
  }

  async function handleToolsCall(id: JsonRpcId, params: unknown): Promise<void> {
    if (!isObject(params) || typeof params['name'] !== 'string') {
      replyError(id, INVALID_PARAMS, 'tools/call requires a string "name"');
      return;
    }
    const name = params['name'];
    const reg = tools.get(name);
    if (reg === undefined) {
      replyError(id, METHOD_NOT_FOUND, `unknown tool '${name}'`);
      return;
    }
    const hasArguments = 'arguments' in params;
    const rawArgs = params['arguments'];
    if (hasArguments && !isObject(rawArgs)) {
      replyError(id, INVALID_PARAMS, 'tools/call "arguments" must be an object when supplied');
      return;
    }
    const args: Record<string, unknown> = hasArguments ? rawArgs as Record<string, unknown> : {};
    const shape = validateValue(reg.inputSchema, args);
    if (!shape.valid) {
      replyError(id, INVALID_PARAMS, `invalid arguments for tool '${name}': ${summarizeIssues(shape.issues)}`);
      return;
    }

    const progressToken = readProgressToken(params);
    const tracked: InFlight = { cancelled: false, byClose: false, cancelCbs: [] };
    // Only tracked when it has a concrete id (a notification cannot be cancelled).
    if (id !== null && id !== undefined) inFlight.set(keyOf(id), tracked);

    const ctx: ToolCallContext = {
      get cancelled() {
        return tracked.cancelled;
      },
      onCancel(cb) {
        if (tracked.cancelled) cb();
        else tracked.cancelCbs.push(cb);
      },
      sendProgress(payload) {
        if (progressToken === undefined || tracked.cancelled || closed) return;
        send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, ...payload },
        });
      },
    };

    try {
      // Keep the check at the transport choke point so every registered tool is
      // covered, but leave unknown tools on the normal -32601 path above.
      if (expectedPluginVersion !== undefined && expectedPluginVersion !== opts.version) {
        throw new Error(
          `owenloop plugin ${expectedPluginVersion} does not match owenloop CLI ${opts.version}. Run: owenloop setup`,
        );
      }
      const result = await reg.handler(args, ctx);
      // A CLIENT-cancelled call sends NO response frame (the JSON-RPC/MCP
      // cancel contract). A close-cancelled call still replies — see InFlight.
      if (tracked.cancelled && !tracked.byClose) return;
      reply(id, result);
    } catch (e) {
      if (tracked.cancelled && !tracked.byClose) return;
      err(`mcp: tool '${name}' threw: ${e instanceof Error ? e.message : String(e)}`);
      reply(id, textResult({ error: e instanceof Error ? e.message : String(e) }, true));
    } finally {
      if (id !== null && id !== undefined) inFlight.delete(keyOf(id));
    }
  }

  function handleCancelled(params: unknown): void {
    if (!isObject(params)) return;
    const requestId = params['requestId'];
    if (requestId === undefined || requestId === null) return;
    const tracked = inFlight.get(keyOf(requestId as JsonRpcId));
    if (tracked === undefined) return;
    tracked.cancelled = true;
    for (const cb of tracked.cancelCbs.splice(0)) {
      try {
        cb();
      } catch {
        // a cancel callback must never take the server down
      }
    }
  }

  function handleInitialize(id: JsonRpcId, params: unknown): void {
    const requested = isObject(params) ? params['protocolVersion'] : undefined;
    const agreed =
      typeof requested === 'string' && RECOGNIZED_PROTOCOL_VERSIONS.has(requested) ? requested : OUR_PROTOCOL_VERSION;
    reply(id, {
      protocolVersion: agreed,
      capabilities: { tools: {} },
      serverInfo: { name: opts.name, version: opts.version },
      instructions: CHIEF_OF_STAFF_INSTRUCTIONS,
    });
  }

  function handleToolsList(id: JsonRpcId): void {
    reply(id, {
      tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // No id is recoverable from an unparseable line — reply with a null-id
      // parse error per JSON-RPC and keep serving.
      replyError(null, PARSE_ERROR, 'parse error: line was not valid JSON');
      return;
    }
    if (!isObject(msg) || typeof msg.method !== 'string') {
      const id = isObject(msg) && 'id' in msg ? (msg.id as JsonRpcId) : null;
      replyError(id ?? null, INVALID_REQUEST, 'invalid request: missing "method"');
      return;
    }

    const isNotification = !('id' in msg) || msg.id === undefined;
    const id = (msg.id ?? null) as JsonRpcId;

    switch (msg.method) {
      case 'initialize':
        if (!isNotification) handleInitialize(id, msg.params);
        return;
      case 'notifications/initialized':
      case 'initialized':
        return; // no-op notification
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list':
        if (!isNotification) handleToolsList(id);
        return;
      case 'tools/call':
        if (isNotification) return; // a call with no id has nowhere to answer
        await handleToolsCall(id, msg.params);
        return;
      case 'notifications/cancelled':
      case 'cancelled':
        handleCancelled(msg.params);
        return;
      default:
        if (!isNotification) replyError(id, METHOD_NOT_FOUND, `unknown method '${msg.method}'`);
        return;
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const tracked of inFlight.values()) {
      tracked.cancelled = true;
      tracked.byClose = true;
      for (const cb of tracked.cancelCbs.splice(0)) {
        try {
          cb();
        } catch {
          // best-effort
        }
      }
    }
    inFlight.clear();
  }

  return { handleLine, close };
}

// ---- helpers ----------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pull `params._meta.progressToken` (string|number) when present. */
function readProgressToken(params: Record<string, unknown>): string | number | undefined {
  const meta = params['_meta'];
  if (!isObject(meta)) return undefined;
  const tok = meta['progressToken'];
  return typeof tok === 'string' || typeof tok === 'number' ? tok : undefined;
}

// ---- real-stdio pump --------------------------------------------------------

/** The slice of a readable stream `pumpStdin` needs — injectable for tests. */
export interface LineStream {
  on(event: 'data', handler: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'close', handler: () => void): unknown;
  setEncoding?(enc: string): void;
  resume?(): void;
}

/**
 * Wire a real byte stream (`process.stdin`) into a server: buffer bytes, split
 * on newlines, feed each complete line to `server.handleLine`, and call
 * `server.close` + `onEof` once on EOF. A trailing partial line at EOF is
 * flushed if non-empty.
 *
 * Every line is DISPATCHED THE MOMENT IT ARRIVES — never queued behind an
 * in-flight `tools/call`. JSON-RPC over MCP is a concurrent protocol: while a
 * long call is outstanding, `notifications/cancelled` must reach the server to
 * abort it and `ping` must still answer. Serializing the pump behind the
 * in-flight call chain would deadlock exactly those frames on the real
 * transport. Per-frame ordering still holds for the non-parking methods because
 * `handleLine` runs synchronously up to the first tool-handler await, and
 * responses are matched by id, not by order.
 *
 * EOF flushes the tail line, then calls `server.close` RIGHT AWAY — `close()`
 * cancels any parked in-flight call, which is what lets a process waiting on
 * this pump actually exit (chaining the close behind a parked call would
 * deadlock EOF against the very call only the close can unpark). A close-cancel
 * does NOT suppress the call's reply the way a client cancel does — every call
 * received before EOF still answers. `onEof` fires only after every dispatched
 * line has settled, so those reply frames are on the pipe before the caller
 * acts on EOF (e.g. exits the process).
 */
export function pumpStdin(stream: LineStream, server: McpServer, onEof?: () => void): void {
  stream.setEncoding?.('utf8');
  let buffer = '';
  let ended = false;
  const pending = new Set<Promise<void>>();

  const dispatch = (line: string): void => {
    const p = Promise.resolve(server.handleLine(line)).catch(() => {});
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      dispatch(line);
      nl = buffer.indexOf('\n');
    }
  });

  const finish = (): void => {
    if (ended) return;
    ended = true;
    const tail = buffer;
    buffer = '';
    if (tail.trim() !== '') dispatch(tail);
    // Snapshot BEFORE close: close() cancels parked calls, which is what makes
    // these settle. A handler that ignores cancellation would stall EOF — ours
    // all resolve on cancel or are bounded hub calls.
    const flushed = Promise.allSettled([...pending]);
    server.close('stdin-eof');
    void flushed.then(() => onEof?.());
  };
  stream.on('end', finish);
  stream.on('close', finish);
  stream.resume?.();
}
