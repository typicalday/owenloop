/**
 * `owenloop work approvals` — THE OPERATOR SURFACE for the tool-approval gate.
 *
 * WHY THIS EXISTS AT ALL. Without it the channel is write-only: a worker blocks
 * on a person, the hub records the question, and nothing on any human's machine
 * ever displays it. That is the exact failure this whole feature was built to
 * end, so the reader half ships in the same change as the writer half rather
 * than in a follow-up.
 *
 * WHAT AN APPROVAL IS, AND WHAT IT IS NOT. Three human-in-the-loop mechanisms
 * exist and they are not interchangeable:
 *
 *   - a pending GATE is an input nobody has provided yet; answered with
 *     `owenloop provide`.
 *   - an `ask` is a worker saying it cannot honestly build what it OWES. The
 *     step ends, the run closes `no_work`, and the answer reaches a FRESH
 *     worker later; answered with `owenloop retry --text`.
 *   - an APPROVAL — this file — is a worker that is STILL RUNNING and blocked
 *     mid-flight on one tool call. Its session is alive and stays alive, the run
 *     does not close, and the answer goes back to that very call.
 *
 * The practical consequence for whoever is reading this list: an approval is the
 * only one of the three where somebody is waiting RIGHT NOW. Every one shown
 * here has a worker parked on it.
 *
 * WHY THERE IS A DEADLINE ON THE WORKER SIDE AND NOT HERE. The waiting process
 * gives up after its own window and treats the non-answer as a denial, so an
 * unanswered approval costs the run one honest `ask` rather than a hang. This
 * command therefore cannot promise that an answer will land — it can only
 * deliver one while the worker is still listening. Answering promptly is the
 * whole point of the list.
 *
 * COMMANDS
 *   owenloop work approvals [--json]              every approval a worker is blocked on
 *   owenloop work approvals approve <wf>/<run> <tool-use-id> [--note <text>]
 *   owenloop work approvals deny    <wf>/<run> <tool-use-id> [--note <text>]
 *
 * The decision is a positional VERB rather than an `--approve` flag, because a
 * flag that grants a dangerous command is one typo away from being omitted, and
 * an omitted flag has to mean something. A verb cannot be omitted.
 *
 * Origin and bearer resolve exactly as in `release`: `--origin` → settings
 * `hubOrigin`, and the `agent:<account>` credential slot for `OWENLOOP_ACCOUNT`
 * (default `default`). The hub refuses `answer_approval` to an agent token by
 * design — this verb is for a person's key.
 *
 * Exit codes: 0 on success (including an empty list) · 1 on a hub/network error
 * · 2 on a usage error.
 */
import { createHubClient, type HubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import type { ApprovalView } from '../hub/types.ts';

type Action = 'list' | 'approve' | 'deny';

interface ParsedArgs {
  action: Action;
  order?: string;
  toolUseId?: string;
  note?: string;
  origin?: string;
  json?: boolean;
  error?: string;
}

/** Parse the subcommand and its flags, in both `--flag value` and `--flag=value` forms. */
export function parseArgs(args: string[]): ParsedArgs {
  const first = args[0];
  const action: Action =
    first === 'approve' ? 'approve' : first === 'deny' ? 'deny' : 'list';
  // `list` is the default AND an explicit word; anything else that is not a flag
  // is a positional belonging to the decision verbs.
  const rest = first === 'approve' || first === 'deny' || first === 'list' ? args.slice(1) : args;

  const parsed: ParsedArgs = { action };
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (name === '--json') {
      parsed.json = true;
      continue;
    }
    if (name !== '--note' && name !== '--origin') return { action, error: `unknown option '${a}'` };
    let value: string;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      const next = rest[i + 1];
      if (next === undefined) return { action, error: `missing value for ${a}` };
      value = next;
      i += 1;
    }
    if (name === '--note') parsed.note = value;
    else parsed.origin = value;
  }

  if (action === 'list') {
    if (positionals.length > 0) return { action, error: `unexpected argument '${positionals[0]}'` };
    return parsed;
  }

  const [order, toolUseId, extra] = positionals;
  if (order === undefined) return { action, error: 'missing <workflow>/<run>' };
  if (toolUseId === undefined) return { action, error: 'missing <tool-use-id>' };
  if (extra !== undefined) return { action, error: `unexpected argument '${extra}'` };
  parsed.order = order;
  parsed.toolUseId = toolUseId;
  return parsed;
}

/** Split `<workflow>/<run>`. A run id is opaque, so only the FIRST slash splits. */
export function splitOrder(order: string): { workflow: string; run: string } | undefined {
  const slash = order.indexOf('/');
  if (slash <= 0 || slash === order.length - 1) return undefined;
  return { workflow: order.slice(0, slash), run: order.slice(slash + 1) };
}

function usage(err: (line: string) => void): void {
  err('usage: owenloop work approvals [--json]');
  err('       owenloop work approvals approve <workflow>/<run> <tool-use-id> [--note <text>]');
  err('       owenloop work approvals deny    <workflow>/<run> <tool-use-id> [--note <text>]');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Render one waiting approval, ending with the exact command that answers it.
 *
 * Printing the answer command is not decoration. Whoever reads this list is
 * being asked to make a judgement under time pressure, and making them assemble
 * a three-part key by hand is how the wrong call gets approved.
 */
function renderApproval(a: ApprovalView, waitedMs: number): string[] {
  const order = `${a.workflow}/${a.run}`;
  const waited = waitedMs >= 0 ? `${Math.round(waitedMs / 1_000)}s` : 'unknown';
  const lines = [
    `${order}  step=${a.step}  ${a.toolName}  waiting ${waited}`,
    `  why: ${a.reason}`,
  ];
  if (a.title !== '') lines.push(`  call: ${a.title}`);
  lines.push(`  approve: owenloop work approvals approve ${order} ${a.toolUseId}`);
  lines.push(`  deny:    owenloop work approvals deny ${order} ${a.toolUseId}`);
  return lines;
}

export interface RunDeps {
  hub?: HubClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export async function run(args: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    err(`owenloop work approvals: ${parsed.error}`);
    usage(err);
    return 2;
  }

  let split: { workflow: string; run: string } | undefined;
  if (parsed.action !== 'list') {
    split = splitOrder(parsed.order!);
    if (split === undefined) {
      err(`owenloop work approvals: '${parsed.order}' is not <workflow>/<run>`);
      usage(err);
      return 2;
    }
  }

  let settings;
  try {
    settings = loadSettings(env);
  } catch (e) {
    err(`owenloop work approvals: ${errMsg(e)}`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    err('owenloop work approvals: no hub origin — pass --origin <url> or set hubOrigin in settings');
    return 2;
  }

  const account = env['OWENLOOP_ACCOUNT'] ?? 'default';
  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    err(`owenloop work approvals: ${bearer.message}`);
    return bearer.code;
  }
  const token = bearer.token;
  const hub = deps.hub ?? createHubClient({ origin, getToken: async () => token });

  if (parsed.action === 'list') {
    let approvals: ApprovalView[];
    try {
      approvals = (await hub.listPendingApprovals()).approvals;
    } catch (e) {
      err(`owenloop work approvals: ${errMsg(e)}`);
      return 1;
    }
    if (parsed.json === true) {
      out(JSON.stringify(approvals, null, 2));
      return 0;
    }
    if (approvals.length === 0) {
      out('no workers are blocked on an approval');
      return 0;
    }
    const at = now();
    for (const a of approvals) {
      for (const line of renderApproval(a, at - a.requestedAt)) out(line);
      out('');
    }
    return 0;
  }

  try {
    const res = await hub.answerApproval({
      workflow: split!.workflow,
      run: split!.run,
      tool_use_id: parsed.toolUseId!,
      decision: parsed.action === 'approve' ? 'approve' : 'deny',
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    });
    if (res.ok === false) {
      // The common case by far: the worker gave up waiting and the approval is
      // no longer live. Said plainly, because "failed" would read as a bug.
      err(`owenloop work approvals: not answered — ${res.reason ?? 'the approval is no longer pending'}`);
      return 1;
    }
    if (res.text !== '') out(res.text);
    out(`${parsed.action}d ${split!.workflow}/${split!.run} ${parsed.toolUseId}`);
    return 0;
  } catch (e) {
    err(`owenloop work approvals: ${errMsg(e)}`);
    return 1;
  }
}
