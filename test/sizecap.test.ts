/**
 * Response-size caps enforced DURING download by `readBodyBounded` (the bounded
 * streaming reader behind `hubFetch` and the `add` tarball read). A hostile
 * server must never make the CLI allocate an oversized body: an advertised
 * oversize `Content-Length` is rejected before the body is read, and a body that
 * LIES about its size (small/absent header, then streams past the cap) is
 * rejected mid-stream with the stream cancelled — never fully buffered. A
 * well-behaved small body must still download and parse exactly as before.
 *
 * Hub side (a/b/c): driven through `push` over the REAL `node:http` loopback
 * (`realHttpServer`) and the platform's real global fetch (opts.fetch unset) —
 * the only way to exercise real streaming/cancel behavior, mirroring
 * redirect.test.ts. An `agent` credential is used so no OAuth refresh
 * (discovery/token round-trip) runs before the `GET /api/workflows` fetch under
 * test. Add side (d/e): driven through `add` with an injected `io.fetch`
 * (add.test.ts pattern) because the GitHub URLs are hardcoded and a loopback
 * server cannot intercept them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, makeIo, realHttpServer } from './hubkit.ts';
import type { HubIo } from './hubkit.ts';

// ---- shared fixtures ---------------------------------------------------------

function validDef(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '',
  ].join('\n');
}

function writeDefs(cwd: string, defs: Record<string, string>): void {
  const dir = join(cwd, 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(defs)) writeFileSync(join(dir, file), body);
}

/** Bind the cwd + a stored credential to a hub origin (inline of push.test's `bind`). */
function bindReal(t: HubIo, origin: string, cred: Credential): void {
  t.store.set(kcHuman(origin), JSON.stringify(cred));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: origin });
}

const AGENT_CRED: Credential = { kind: 'agent', accessToken: 'olp_test' };

// ---- (a) hub: declared oversize Content-Length -------------------------------

test('hub: a response advertising an oversize Content-Length is rejected up front, body never read', async () => {
  const declared = 50 * 1024 * 1024; // 50 MiB, far above the test cap
  const hub = await realHttpServer({
    'GET /api/workflows': () => ({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(declared) },
      // Advertise a huge body. undici only resolves the Response once some body
      // bytes flow, so write ONE small chunk (well under the cap) to hand the
      // client its Response — it must then bail on the declared Content-Length
      // before reading any more. End once the client cancels so teardown is clean.
      stream: (res) => {
        res.on('close', () => {
          if (!res.writableEnded) res.end();
        });
        res.write(Buffer.alloc(1024));
      },
    }),
  });
  try {
    const t = makeIo({ env: { OWENLOOP_HUB_MAX_RESPONSE_BYTES: '65536' } });
    writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
    bindReal(t, hub.origin, AGENT_CRED);

    const code = await mainAsync(['push'], t.io);
    assert.equal(code, 1, t.err.join('\n'));
    const err = t.err.join('\n');
    assert.match(err, /exceeds the 65536-byte cap/, 'names the cap');
    assert.match(err, new RegExp(`declared Content-Length ${declared}`), 'names the declared Content-Length');
  } finally {
    await hub.close();
  }
});

// ---- (b) hub: lying stream (no Content-Length, streams past the cap) ----------

test('hub: a body that streams past the cap with no Content-Length is rejected mid-stream and cancelled', async () => {
  const cap = 65536;
  const chunk = new Uint8Array(16 * 1024); // 16 KiB
  let bytesWritten = 0;
  let closed = false;
  const hub = await realHttpServer({
    'GET /api/workflows': () => ({
      status: 200,
      headers: { 'content-type': 'application/json' }, // no content-length → chunked
      stream: (res) => {
        res.on('close', () => {
          closed = true;
        });
        const pump = (): void => {
          if (closed || res.writableEnded || res.destroyed) return;
          if (bytesWritten > cap * 8) {
            // Safety hard-stop so a regression (cancel never observed) can't hang
            // the suite — the assertion below proves the cancel fired far earlier.
            res.end();
            return;
          }
          res.write(chunk);
          bytesWritten += chunk.byteLength;
          setTimeout(pump, 10);
        };
        pump();
      },
    }),
  });
  try {
    const t = makeIo({ env: { OWENLOOP_HUB_MAX_RESPONSE_BYTES: String(cap) } });
    writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
    bindReal(t, hub.origin, AGENT_CRED);

    const code = await mainAsync(['push'], t.io);
    assert.equal(code, 1, t.err.join('\n'));
    assert.match(t.err.join('\n'), new RegExp(`exceeds the ${cap}-byte cap`), 'names the cap');
    // The cancel really stopped the writer: it never reached a large multiple of
    // the cap before the response closed.
    assert.ok(bytesWritten < cap * 4, `writer kept going past the cancel: ${bytesWritten} bytes`);
  } finally {
    await hub.close();
  }
});

// ---- (c) hub: well-behaved small JSON still succeeds -------------------------

test('hub: a normal small JSON response over real fetch still succeeds unchanged', async () => {
  const hub = await realHttpServer({
    'GET /api/workflows': () => ({ status: 200, json: { text: '', workflows: [] } }),
    'POST /api/create_workflow': (req) => {
      const yaml = (JSON.parse(req.body ?? '{}') as { yaml?: string }).yaml ?? '';
      const name = /^name:\s*(\S+)/m.exec(yaml)?.[1] ?? '';
      return { status: 200, json: { ok: true, name, version: 1, hash: 'h' } };
    },
  });
  try {
    const t = makeIo({});
    writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
    bindReal(t, hub.origin, AGENT_CRED);

    const code = await mainAsync(['push'], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    const result = JSON.parse(t.out.join('\n')) as { pushed: string[] };
    assert.deepEqual(result.pushed, ['foo']);
  } finally {
    await hub.close();
  }
});

// ---- add side (injected fetch — GitHub URLs are hardcoded) --------------------

const OWNER = 'acme';
const REPO = 'widgets';
const SHA = 'a'.repeat(40);
const shaUrl = `https://api.github.com/repos/${OWNER}/${REPO}/commits/HEAD`;
const tarballUrl = `https://api.github.com/repos/${OWNER}/${REPO}/tarball/${SHA}`;

function makeAddIo(
  fetchFn: typeof globalThis.fetch,
  env: Record<string, string | undefined> = {},
): { io: CliIO; out: string[]; err: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-sizecap-add-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { cwd, env, out: (s) => out.push(s), err: (s) => err.push(s), fetch: fetchFn };
  return { io, out, err };
}

// ---- (d) add: declared oversize tarball --------------------------------------

test('add: a tarball advertising an oversize Content-Length is rejected before the body is read', async () => {
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === shaUrl) return new Response(SHA);
    if (url === tarballUrl) {
      // A tiny in-memory body but a declared Content-Length above the cap — the
      // reader must refuse on the header before the body is ever read.
      return new Response(new Uint8Array(8), { headers: { 'content-length': '5000' } });
    }
    throw new Error(`no canned response for ${url}`);
  }) as typeof globalThis.fetch;

  const { io, err } = makeAddIo(fetchFn, { OWENLOOP_TARBALL_MAX_BYTES: '4096' });
  const code = await mainAsync(['add', `${OWNER}/${REPO}`], io);
  assert.equal(code, 1, err.join('\n'));
  assert.match(err.join('\n'), /exceeds the 4096-byte cap/, 'names the cap');
  assert.match(err.join('\n'), /declared Content-Length 5000/, 'names the declared Content-Length');
});

// ---- (e) add: lying tarball stream -------------------------------------------

test('add: a tarball streaming past the cap with no Content-Length is cancelled mid-stream', async () => {
  const cap = 4096;
  let pulled = 0;
  let cancelled = false;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === shaUrl) return new Response(SHA);
    if (url === tarballUrl) {
      const rs = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          if (pulled > 100) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array(1024)); // 1 KiB per pull
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(rs); // no content-length → the counting path is the guard
    }
    throw new Error(`no canned response for ${url}`);
  }) as typeof globalThis.fetch;

  const { io, err } = makeAddIo(fetchFn, { OWENLOOP_TARBALL_MAX_BYTES: String(cap) });
  const code = await mainAsync(['add', `${OWNER}/${REPO}`], io);
  assert.equal(code, 1, err.join('\n'));
  assert.match(err.join('\n'), new RegExp(`exceeds the ${cap}-byte cap`), 'names the cap');
  assert.ok(cancelled, 'the source stream observed cancellation');
  assert.ok(pulled < 100, `stopped pulling once the cap was crossed (pulled ${pulled})`);
});
