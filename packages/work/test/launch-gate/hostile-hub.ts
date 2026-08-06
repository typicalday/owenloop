import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { GetOrderResponse } from '../../src/hub/types.ts';

export type HostileHubPath =
  | 'get_order'
  | 'heartbeat'
  | 'release'
  | 'submit'
  | 'whats_next'
  | 'whoami'
  | 'wake'
  | 'presence_ping';

export interface HubRequest {
  path: HostileHubPath | string;
  body: unknown;
}

export interface HostileHubOptions {
  order: GetOrderResponse;
  /** The adversary receives the response body before it is written to the socket. */
  tamper?: (path: HostileHubPath | string, body: unknown) => unknown;
  /** Response paths whose normal response is replaced by an explicit withheld shape. */
  withhold?: readonly HostileHubPath[];
}

export interface HostileHub {
  origin: string;
  server: Server;
  requests: HubRequest[];
  /** Exact JSON response bodies written after tampering, in socket order. */
  served: unknown[];
  /** The same evidence with the response path retained for readable assertions. */
  servedByPath: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}

function defaultResponse(path: HostileHubPath | string, order: GetOrderResponse): unknown {
  switch (path) {
    case 'get_order':
      return order;
    case 'submit':
      return { text: '', outcome: 'green' };
    case 'release':
      return { text: '' };
    case 'heartbeat':
      return { text: '' };
    case 'whoami':
      return {
        text: '',
        orgId: '',
        orgName: '',
        actor: { id: '', kind: 'agent', role: 'agent', scopes: [] },
        tokenStatus: 'active',
        authMethod: 'token',
      };
    case 'wake':
      return { text: '', cursor: 0, changed: false };
    case 'presence_ping':
      return { text: '', ok: true, name: 'hostile-hub-fixture', lastSeen: 0 };
    case 'whats_next':
      return { text: '' };
    default:
      return { text: '' };
  }
}

function withheldResponse(path: HostileHubPath | string, order: GetOrderResponse): unknown {
  if (path === 'get_order') {
    return {
      text: '',
      workflow: order.workflow,
      run: order.run,
      order: null,
      lease: { claimed: false },
    } satisfies GetOrderResponse;
  }
  return { text: '' };
}

function parseBody(raw: string): unknown {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function startHostileHub(options: HostileHubOptions): Promise<HostileHub> {
  const requests: HubRequest[] = [];
  const served: unknown[] = [];
  const servedByPath: Array<{ path: string; body: unknown }> = [];
  const withhold = new Set(options.withhold ?? []);

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/api\//, '').split('?')[0] ?? '';
      requests.push({ path, body: parseBody(raw) });

      const base = withhold.has(path as HostileHubPath)
        ? withheldResponse(path, options.order)
        : defaultResponse(path, options.order);
      const tamperInput = structuredClone(base);
      const body = options.tamper?.(path, tamperInput) ?? tamperInput;
      served.push(body);
      servedByPath.push({ path, body });

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    requests,
    served,
    servedByPath,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  };
}
