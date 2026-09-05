/**
 * The `owenloop work hold --mcp` stdio-MCP mount (plan part 2).
 *
 * A born-bound work-holder: the D2 stamped Step Agent's frontmatter declares
 * `mcpServers.owenloop = owenloop work hold --order <wf>/<run> --origin <url> --mcp`,
 * so when the Step Agent session boots it launches THIS as a stdio MCP server. The
 * server exposes five bare tools the model uses to do its order:
 *   - `get_order` → the order packet (prompt, inputs, owed outputs) for the run
 *     this holder is bound to. No ids are arguments — they came in on argv, never
 *     through the model.
 *   - `submit`    → post a receipt for an owed output path; when the hub reports
 *     the submit CLOSED the run, the lease loop is stopped with `release:false`
 *     (the claim is already gone).
 *   - `reject`    → invalidate a consumed artifact through the claiming step's
 *     server-derived authority; the client never supplies `by`. A CLOSED reject
 *     also stops the lease loop without releasing the already-closed claim.
 *   - `ask`       → stop and escalate to a human about an OWED output path. The
 *     third exit. `submit` and `reject` both assume the worker can finish; until
 *     `ask` existed a worker that genuinely could not had only two moves, and
 *     both damaged the run: submit something it did not believe (greens a
 *     fabrication that every downstream step then builds on), or end its turn
 *     silently (the task re-arms and a fresh worker relearns the same blocker
 *     until the stall cap). `ask` holds the artifact with no counter movement
 *     and surfaces the question to an operator, who answers with
 *     `owenloop retry <workflow> <path> --text "<answer>"`.
 *   - `put_file_artifact` → store a file the step produced and get back the small
 *     JSON envelope that names it. An artifact value lives in the org's database
 *     and is size-capped for good reason, but a rendered video or a screenshot is
 *     an artifact too. Rather than let a step choose between truncating its own
 *     output and base64-inflating it past the cap, the bytes go to blob storage
 *     and the envelope — hash, size, content type — goes in the value, where a
 *     def's ordinary JSON Schema can still constrain it.
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
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { textResult, type ToolRegistration, type ToolResult } from '../mcp/server.ts';
import type { HubClient } from '../hub/client.ts';
import type { ContactHolder, GetOrderResponse } from '../hub/types.ts';
import type { StopOptions } from '../lease/loop.ts';
import { buildSubmitProof, type SubmissionKeyManager } from '../submit-proof.ts';
import { readSubmitValueFile } from '../submit-file.ts';
import { resolveContainedPath } from '../contained-path.ts';
import { normalizeSubmitValue } from '../submit-value.ts';
import type { SshProcessAdapter } from '../../../../src/crypto/ssh.ts';
import type { ConsumedVerifier } from '../consumed-verifier.ts';
import { createHoldLoop, type HoldLoop, type HoldOutcome } from './loop.ts';

export const HOLD_MCP_TOOL_NAMES = ['get_order', 'submit', 'reject', 'ask', 'put_file_artifact'] as const;
export type HoldMcpToolName = (typeof HOLD_MCP_TOOL_NAMES)[number];

export interface HoldMcpDeps {
  hub: HubClient;
  workflow: string;
  run: string;
  /** Sole containment root for submit value files. */
  workdir: string;
  /** Positive registration list. Absent exposes every tool in `HOLD_MCP_TOOL_NAMES`. */
  tools?: readonly HoldMcpToolName[];
  /** Hub origin used to resolve the local machine signing key. */
  origin?: string;
  principalKeys?: SubmissionKeyManager;
  env?: Record<string, string | undefined>;
  /** Injectable ssh-keygen seam for hermetic submit-proof tests. */
  sshProcess?: SshProcessAdapter;
  /** Gate dynamic consumed values before the packet reaches the model. */
  consumedVerifier?: ConsumedVerifier;
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
  /** Exactly the selected registrations; full mode has every tool. */
  tools: ToolRegistration[];
  /** The lease loop kept warm underneath — the role runs and stops it. */
  loop: HoldLoop;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Extension-to-MIME map for `put_file_artifact`'s optional `contentType`.
 *
 * Deliberately short. This is a convenience for the common case, not a content
 * sniffer: the map covers what a step actually renders — images, video, audio,
 * documents, archives, text — and everything else falls through to
 * `application/octet-stream`, which is the honest answer for bytes whose type
 * this process did not determine. A step that knows better passes `contentType`
 * explicitly and this map is never consulted.
 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.log': 'text/plain',
};

function guessContentType(path: string): string {
  return CONTENT_TYPE_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** A lean, model-facing view of the order packet. */
function orderView(res: GetOrderResponse): unknown {
  return { workflow: res.workflow, run: res.run, order: res.order, text: res.text };
}

/**
 * Build the hold MCP mount: the lease loop plus a positive tool selection. The
 * default selection is the full `get_order`/`submit`/`reject` surface. A caller
 * can request an exact subset; future registrations do not enter that subset
 * unless the caller names them. The role creates the MCP server around `tools`,
 * starts `loop.run()`, and pumps stdin — stopping the loop on stdin EOF.
 */
export function createHoldMcp(deps: HoldMcpDeps): HoldMcpMount {
  const { hub, workflow, run } = deps;
  const holderReq = deps.holder !== undefined ? { holder: deps.holder } : {};

  // The loop's first contact arrives synchronously, but consume-side verification
  // is asynchronous. Keep the unverified response in a private pending slot until
  // a tool call gates it; only a gated response may populate `captured` and reach
  // either the model or submit-proof construction.
  let firstContact: GetOrderResponse | undefined;
  let captured: GetOrderResponse | undefined;
  // Set the moment the lease loop's run() settles (lease-lost, completed,
  // released, …): from then on this mount no longer holds the order, so BOTH
  // registered tools fast-fail with isError and never touch the hub again (plan section 4
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
      firstContact = res;
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

  async function gate(res: GetOrderResponse): Promise<ToolResult | undefined> {
    if (res.order === null) return undefined;
    const hasConsumedData = Object.keys(res.order.consumes).length > 0
      || res.order.owes.some((owed) => owed.reasons.length > 0 || owed.proof !== undefined);
    if (deps.consumedVerifier === undefined) {
      if (!hasConsumedData) return undefined;
      return textResult({
        error: `consumed artifact refusal (prerequisite) for ${res.workflow}/${res.run}: consume-side verifier is not configured; dynamic values cannot be admitted to the MCP model`,
      }, true);
    }
    try {
      const checked = await deps.consumedVerifier(res.order, { hardRule: false });
      if (!checked.ok) return textResult({ error: checked.reason }, true);
      for (const warning of checked.warnings) deps.err(warning);
      return undefined;
    } catch (error) {
      return textResult({ error: `consumed artifact refusal (prerequisite) for ${res.workflow}/${res.run}: ${errMsg(error)}` }, true);
    }
  }

  const getOrderTool: ToolRegistration = {
    name: 'get_order',
    description:
      "Return this work-holder's order — the prompt, consumed inputs, and owed output paths for the run it is bound to. Takes no arguments (the run is fixed at launch).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const gone = terminalGuard();
      if (gone !== undefined) return gone;
      if (captured !== undefined) {
        const refused = await gate(captured);
        if (refused !== undefined) return refused;
        return textResult(orderView(captured));
      }
      if (firstContact !== undefined) {
        const refused = await gate(firstContact);
        if (refused !== undefined) return refused;
        captured = firstContact;
        return textResult(orderView(firstContact));
      }
      try {
        const res = await hub.getOrder({ workflow, run, ...holderReq });
        const refused = await gate(res);
        if (refused !== undefined) return refused;
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
      'Submit a receipt for one owed output path of this order. Provide exactly one of value or valueFile. valueFile names a UTF-8 JSON document inside the run working directory. Set done=true when this is the final value for the path. When the hub reports the run has closed, the holder releases and exits.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'The owed output path to submit a receipt for.' },
        value: { description: 'The receipt value (any JSON).' },
	valueFile: { type: 'string', description: 'A UTF-8 JSON file inside the run working directory.' },
        done: { type: 'boolean', description: 'Mark this the final submit for the path.' },
      },
      oneOf: [
	{ required: ['value'] },
	{ required: ['valueFile'] },
      ],
      additionalProperties: false,
    },
    handler: async (args) => {
      const gone = terminalGuard();
      if (gone !== undefined) return gone;
      const path = args['path'];
      if (typeof path !== 'string' || path === '') {
        return textResult({ error: 'submit requires a non-empty string "path"' }, true);
      }
      const hasValue = Object.prototype.hasOwnProperty.call(args, 'value');
      const hasValueFile = Object.prototype.hasOwnProperty.call(args, 'valueFile');
      if (hasValue === hasValueFile) {
	return textResult({ error: 'submit-value-source-invalid: provide exactly one of value or valueFile' }, true);
      }
      const valueFile = args['valueFile'];
      if (hasValueFile && (typeof valueFile !== 'string' || valueFile.trim() === '')) {
	return textResult({ error: 'submit-value-file-invalid: valueFile must be a non-empty string' }, true);
      }
      const done = args['done'];
      // Normalize a JSON-encoded string value to the object the hub would
      // store BEFORE signing it. Signing the string instead makes the hub drop
      // the proof (it stores normalized bytes the signature does not cover),
      // silently, on both sides — see `../submit-value.ts`. One value is used
      // for both the proof and the wire so the two can never diverge.
      try {
	const rawValue = hasValue
	  ? args['value']
	  : await readSubmitValueFile(deps.workdir, valueFile);
	const value = normalizeSubmitValue(rawValue);
        // Submit is also a dynamic-data boundary. Fetch and gate the bound
        // packet even when no origin was supplied for submit-proof signing;
        // otherwise a direct submit call could bypass MCP consume-side
        // verification without first calling get_order.
        let orderResponse = captured ?? firstContact;
        if (orderResponse === undefined) {
          orderResponse = await hub.getOrder({ workflow, run, ...holderReq });
        }
        const refused = await gate(orderResponse);
        if (refused !== undefined) return refused;
        captured = orderResponse;

        let proof: string | undefined;
        if (deps.origin !== undefined && orderResponse.order !== null) {
          proof = await buildSubmitProof({
            origin: deps.origin,
            order: orderResponse.order,
            path,
            value,
            now: deps.now,
            warn: deps.err,
            ...(deps.principalKeys !== undefined ? { principalKeys: deps.principalKeys } : {}),
            ...(deps.env !== undefined ? { env: deps.env } : {}),
            ...(deps.sshProcess !== undefined ? { sshProcess: deps.sshProcess } : {}),
          });
        }
        const res = await hub.submit({
          workflow,
          run,
          path,
          value,
          ...(typeof done === 'boolean' ? { done } : {}),
          ...(proof !== undefined ? { proof } : {}),
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

  const rejectTool: ToolRegistration = {
    name: 'reject',
    description:
      'Reject a consumed artifact path with a reason. The hub derives the rejecting step from this held run; the client cannot supply `by`.',
    inputSchema: {
      type: 'object',
      required: ['path', 'text'],
      properties: {
        path: { type: 'string', description: 'The consumed artifact path to reject.' },
        text: { type: 'string', description: 'The reason for rejecting the artifact.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const gone = terminalGuard();
      if (gone !== undefined) return gone;
      const path = args['path'];
      const text = args['text'];
      if (typeof path !== 'string' || path.trim() === '') {
        return textResult({ error: 'reject requires a non-empty string "path"' }, true);
      }
      if (typeof text !== 'string' || text.trim() === '') {
        return textResult({ error: 'reject requires a non-empty string "text"' }, true);
      }
      try {
        const res = await hub.reject({ workflow, run, path, text });
        if (res.closed === true) loop.stop('submitted', { release: false });
        return textResult({ ok: res.ok, closed: res.closed ?? false, text: res.text });
      } catch (e) {
        return textResult({ error: errMsg(e) }, true);
      }
    },
  };

  const askTool: ToolRegistration = {
    name: 'ask',
    description:
      'Stop and ask a human about an output path you OWE, when you cannot produce it honestly — a required input is missing, wrong, or contradictory, or the order asks for a decision only a person can make. Use this INSTEAD of submitting a guess and INSTEAD of ending your turn without submitting: a guess greens and poisons every step downstream, and ending silently just re-runs this same step until it burns its retry budget. Asking does not count as a failure and costs you no attempts. The step is held until a human answers; your run ends here.',
    inputSchema: {
      type: 'object',
      required: ['path', 'question'],
      properties: {
        path: {
          type: 'string',
          description: 'The owed output path you are blocked on (one of the `owes` paths from get_order).',
        },
        question: {
          type: 'string',
          description:
            'The specific question for the human. State what decision or fact you need, not just that you are stuck — this is the whole message they receive.',
        },
        context: {
          type: 'string',
          description:
            'Optional: what you already tried, what you read, and why it was not enough. Saves the human from reconstructing it from logs.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const gone = terminalGuard();
      if (gone !== undefined) return gone;
      const path = args['path'];
      const question = args['question'];
      const context = args['context'];
      if (typeof path !== 'string' || path.trim() === '') {
        return textResult({ error: 'ask requires a non-empty string "path"' }, true);
      }
      if (typeof question !== 'string' || question.trim() === '') {
        return textResult({ error: 'ask requires a non-empty string "question"' }, true);
      }
      if (context !== undefined && typeof context !== 'string') {
        return textResult({ error: 'ask "context" must be a string when present' }, true);
      }
      try {
        const res = await hub.ask({
          workflow,
          run,
          path,
          question,
          ...(typeof context === 'string' && context.trim() !== '' ? { context } : {}),
        });
        // Asking ENDS the run. Same shape as submit/reject's closed branch:
        // stop without releasing, because the hub already closed the claim.
        if (res.closed === true) loop.stop('asked', { release: false });
        return textResult({ ok: res.ok, closed: res.closed ?? false, text: res.text });
      } catch (e) {
        return textResult({ error: errMsg(e) }, true);
      }
    },
  };

  const putFileArtifactTool: ToolRegistration = {
    name: 'put_file_artifact',
    description:
      'Store a FILE you produced (image, video, PDF, archive, log, any bytes) and get back a small JSON envelope that names it. Use this whenever an owed output IS a file, or CONTAINS one: upload the file, then call submit with the envelope as the value, or embedded inside your value, e.g. {"summary": "...", "render": <envelope>}. The bytes are stored outside the database, so a large asset does not count against the artifact value size limit — the envelope is what the workflow stores, schema-checks and shows a judge. Do NOT base64 a file into a submit value; upload it here instead.',
    inputSchema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          description:
            'Path to the file to store. Relative paths resolve against the run working directory, and the file must be inside it.',
        },
        contentType: {
          type: 'string',
          description:
            'MIME type of the bytes, e.g. image/png or video/mp4. Inferred from the file extension when omitted.',
        },
        filename: {
          type: 'string',
          description: 'Optional display name recorded in the envelope. Defaults to the file name.',
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const gone = terminalGuard();
      if (gone !== undefined) return gone;
      const file = args['file'];
      if (typeof file !== 'string' || file.trim() === '') {
        return textResult({ error: 'file-artifact-invalid: file must be a non-empty string' }, true);
      }
      const contentTypeArg = args['contentType'];
      if (contentTypeArg !== undefined && (typeof contentTypeArg !== 'string' || contentTypeArg.trim() === '')) {
        return textResult({ error: 'file-artifact-invalid: contentType must be a non-empty string when present' }, true);
      }
      const filenameArg = args['filename'];
      if (filenameArg !== undefined && (typeof filenameArg !== 'string' || filenameArg.trim() === '')) {
        return textResult({ error: 'file-artifact-invalid: filename must be a non-empty string when present' }, true);
      }
      try {
        // Same two-phase containment as a submit value file, under this tool's
        // own error family: the working directory is the only root a step's
        // outputs may come from, and a symlink out of it is an exfiltration
        // path, not a convenience.
        const resolved = await resolveContainedPath(deps.workdir, file, 'file-artifact');
        const bytes = new Uint8Array(await readFile(resolved));
        if (bytes.byteLength === 0) {
          return textResult({ error: `file-artifact-empty: ${file} is zero bytes` }, true);
        }
        const contentType =
          typeof contentTypeArg === 'string' ? contentTypeArg.trim() : guessContentType(resolved);
        const filename = typeof filenameArg === 'string' ? filenameArg.trim() : basename(resolved);
        const res = await hub.putFileArtifact({ workflow, bytes, contentType, filename });
        // Hand back the envelope EXACTLY as it must be submitted. The hub's
        // `text` is dropped from the pointer so the model cannot paste a field
        // the artifact schema does not know about.
        const pointer = {
          __file: res.__file,
          hash: res.hash,
          size: res.size,
          contentType: res.contentType,
          ...(res.filename !== undefined ? { filename: res.filename } : {}),
        };
        return textResult({
          pointer,
          text: `Stored ${String(bytes.byteLength)} bytes as ${contentType}. Submit this pointer as your value, or embed it in one.`,
        });
      } catch (e) {
        return textResult({ error: errMsg(e) }, true);
      }
    },
  };

  const registrations: Record<HoldMcpToolName, ToolRegistration> = {
    get_order: getOrderTool,
    submit: submitTool,
    reject: rejectTool,
    ask: askTool,
    put_file_artifact: putFileArtifactTool,
  };
  const selected = deps.tools ?? HOLD_MCP_TOOL_NAMES;
  return { tools: selected.map((name) => registrations[name]), loop };
}
