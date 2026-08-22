/**
 * Test-only helpers for the REAL `--mcp` e2e drills (plan tests 4/5):
 *
 *  - `spawnMcp` — spawn the actual `bin/owenloop.mjs` as a child process and
 *    speak newline-delimited JSON-RPC 2.0 to it over its real stdin/stdout.
 *    This is the hand-rolled ~50-line stdio MCP client the plan calls for — a
 *    helper, deliberately NOT a dependency on the official SDK (the repo keeps
 *    one runtime dep).
 *  - `startMockHub` — a throwaway `node:http` hub that records every request
 *    (verb, auth, body, arrival time) and serves caller-scripted responses;
 *    the same shape `exec-e2e.test.ts` proves the wire against.
 *  - `until` — a poll-until-true with a timeout, for wire assertions.
 *
 * Lives under `test/helpers/` so the `test/*.test.ts` glob never runs it as a
 * suite of its own.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

const BIN = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'owenloop.mjs');

/** One inbound JSON-RPC frame (response or notification), loosely typed. */
export interface Frame {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: ReturnType<typeof JSON.parse>;
  result?: ReturnType<typeof JSON.parse>;
  error?: ReturnType<typeof JSON.parse>;
}

export interface McpChild {
  child: ChildProcess;
  /** Send a request (auto-assigned id) and await its response frame. */
  request(method: string, params?: unknown): Promise<Frame>;
  /**
   * Send a request with an auto-assigned id and return that id WITHOUT awaiting
   * a reply — for a call whose response the server legitimately suppresses (the
   * MCP client-cancel contract) or that stays parked. Scan `frames` by the
   * returned id to check whether a reply ever arrived.
   */
  fireRequest(method: string, params?: unknown): number;
  /** Send a notification (no id, no response). */
  notify(method: string, params?: unknown): void;
  /** Every inbound frame in arrival order — notifications included. */
  frames: Frame[];
  /** Everything the child wrote to stderr so far. */
  stderr(): string;
  /** Close the child's stdin — the MCP transport EOF. */
  endStdin(): void;
  /** Resolves with the exit code once the child exits. */
  exited: Promise<number | null>;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** Spawn `owenloop <args>` and wire a line-framed JSON-RPC client to it. */
export function spawnMcp(args: string[], env: Record<string, string | undefined>, cwd?: string): McpChild {
  const child = spawn(process.execPath, [BIN, 'work', ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(cwd !== undefined ? { cwd } : {}),
  });

  const frames: Frame[] = [];
  const pending = new Map<number, (f: Frame) => void>();
  let nextId = 1;
  let outBuf = '';
  let errBuf = '';

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    outBuf += chunk;
    let nl = outBuf.indexOf('\n');
    while (nl !== -1) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (line !== '') {
        try {
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          if (typeof frame.id === 'number') pending.get(frame.id)?.(frame);
        } catch {
          // a non-JSON stdout line would be a framing bug — keep it visible
          errBuf += `\n[non-JSON stdout] ${line}\n`;
        }
      }
      nl = outBuf.indexOf('\n');
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    errBuf += chunk;
  });

  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  function write(msg: unknown): void {
    child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  return {
    child,
    frames,
    stderr: () => errBuf,
    endStdin: () => child.stdin!.end(),
    exited,
    notify: (method, params) => write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
    fireRequest: (method, params) => {
      const id = nextId++;
      write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      return id;
    },
    request: (method, params) => {
      const id = nextId++;
      const p = new Promise<Frame>((resolve, reject) => {
        const t = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request ${method} (id ${id}) timed out after ${REQUEST_TIMEOUT_MS}ms; stderr:\n${errBuf}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, (f) => {
          clearTimeout(t);
          pending.delete(id);
          resolve(f);
        });
      });
      write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      return p;
    },
  };
}

/** Standard MCP session opener: initialize + initialized notification. */
export async function handshake(mcp: McpChild): Promise<Frame> {
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'owenloop-e2e', version: '0.0.0' },
  });
  mcp.notify('notifications/initialized');
  return init;
}

/** Call a tool and return the parsed first text content block + isError. */
export async function callTool(
  mcp: McpChild,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ body: ReturnType<typeof JSON.parse>; isError: boolean; frame: Frame }> {
  const frame = await mcp.request('tools/call', { name, arguments: args });
  if (frame.error !== undefined) throw new Error(`tools/call ${name} errored: ${JSON.stringify(frame.error)}`);
  const text = frame.result.content[0].text as string;
  return { body: JSON.parse(text), isError: frame.result.isError === true, frame };
}

// ---- mock hub ---------------------------------------------------------------

export interface HubReq {
  verb: string;
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
  at: number;
}

/**
 * A throwaway HTTP hub: records every request and serves whatever the
 * caller-supplied `respond(verb, body)` returns (JSON-serialized).
 */
export async function startMockHub(
  respond: (verb: string, body: Record<string, unknown> | undefined) => unknown,
): Promise<{ origin: string; reqs: HubReq[]; server: Server }> {
  const reqs: HubReq[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      const verb = (req.url ?? '').replace(/^\/api\//, '').replace(/\?.*$/, '');
      const body = raw === '' ? undefined : (JSON.parse(raw) as Record<string, unknown>);
      reqs.push({ verb, auth: req.headers.authorization, body, at: Date.now() });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(respond(verb, body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, reqs, server };
}

/** Poll until `cond` is true or `ms` elapses (then throw naming `what`). */
export async function until(cond: () => boolean, what: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
