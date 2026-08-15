/**
 * The tool-call gatekeeper: the decision an adapter makes when its harness asks
 * "may this tool call run?".
 *
 * WHY THIS EXISTS. `permissionMode` names three positions — `ask` (a human is
 * the gate), `auto-safe` (a classifier is the gate, a human is the exception
 * path), `full-access` (nothing is gated). Until this module, only the third
 * one was real:
 *
 * - `ask` mapped to the SDK's `default` mode, which routes every unapproved
 *   tool call to a `canUseTool` callback and DENIES when no callback is wired.
 *   No callback was wired anywhere in this codebase. So `ask` denied everything,
 *   silently and finally: the agent saw a bare tool error, nobody was prompted,
 *   and nothing was recorded. That is the mechanism behind a planner step
 *   reporting that every read of its own target repository was blocked.
 * - `auto-safe` mapped to the SDK's `auto` mode, whose model-side classifier was
 *   measured (SDK 0.3.220, callback wired throughout) to consult the host on
 *   NONE of five probe actions and to auto-deny none of them: four ran,
 *   including a recursive delete on an absolute path outside the session working
 *   directory, an outbound network request, and a read under `$HOME`. `auto`
 *   never reaches the callback at all, so no amount of host-side wiring gives it
 *   an exception path.
 *
 * The practical response to both was to write `permissionMode: full-access` on
 * every step, because it was the only value whose behavior matched its name.
 * That is a workflow author turning permissions off to get work done, which is
 * the failure this module exists to end.
 *
 * WHAT THIS MODULE DECIDES, AND WHAT IT DOES NOT. It answers one question per
 * tool call — allow it, or escalate it — against a stated policy. It does NOT
 * decide what escalation means: the adapter owns that, because the useful
 * answers differ by deployment. Today every adapter denies an escalated call
 * with guidance routing the agent to the `ask` MCP tool, which puts the question
 * to a person through the hub. A worker that can block on a hub-side approval
 * gate would instead wait here and resolve the original call. Keeping that
 * choice out of this module is what lets the second shape land without
 * reopening the classification.
 *
 * HONESTY ABOUT THE CLASSIFIER. Two of the three checks below are decidable and
 * one is not. Path containment is decidable: a resolved path either is or is not
 * inside the tree this step was given. A shell command is not — no pattern list
 * decides whether an arbitrary `bash -c` string is safe, and this one does not
 * pretend to. `dangerousCommand` is a DENY-LIST of high-signal, rarely-legitimate
 * patterns. It catches the measured probes and the ordinary footguns; a
 * deliberately obfuscated command gets past it. The deny-list is kept short on
 * purpose: under `classifier` policy a false positive stops real work in a
 * headless run, and the honest posture for a mode documented as "proceeds on
 * ordinary work" is to allow what it cannot judge. A step whose commands must
 * genuinely all be reviewed should say `permissionMode: ask`, which escalates
 * every shell call without consulting the deny-list at all.
 */

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * How much the gatekeeper escalates, derived by the adapter from the step's
 * authored `permissionMode`.
 *
 * - `human-gate` — the `ask` position. Everything beyond a trivially safe read
 *   inside the step's own directory escalates. The classifier is not consulted:
 *   the point of `ask` is that a person sees the call, not that a pattern list
 *   approves of it first.
 * - `classifier` — the `auto-safe` position, and the right reading of a step
 *   that named the vendor's own `default`/`acceptEdits` or named nothing at all.
 *   Ordinary work proceeds; the checks below escalate what they can actually
 *   establish is dangerous.
 * - `deny-unapproved` — the vendor's `dontAsk`, whose documented meaning is to
 *   deny an unapproved call rather than consult anyone. Present so that value
 *   keeps its meaning rather than being quietly widened into `classifier`. In
 *   practice the SDK short-circuits this mode before the callback, so it is a
 *   statement of intent more than a live path.
 */
export type GatePolicy = 'human-gate' | 'classifier' | 'deny-unapproved';

/** One tool call, as much as the gatekeeper needs to judge it. */
export interface GateCall {
  /** The harness's own tool name, e.g. `Read`, `Bash`, `mcp__owenloop__submit`. */
  toolName: string;
  /** The tool's arguments, unvalidated — this is a model-authored bag. */
  input: Record<string, unknown>;
  /**
   * The directory this step was placed in and is entitled to work inside. For
   * an owenloop order this is the resolved `workdir`; containment is measured
   * against it and nothing else.
   */
  workdir: string;
  /**
   * A path the harness itself already determined to be outside the directories
   * it allows, when it says so. Authoritative when present: the harness sees
   * shell commands this module deliberately does not try to parse.
   */
  blockedPath?: string;
}

/** The gatekeeper's answer. `reason` is written to be shown to a person and to
 *  the agent, so it names the specific thing that triggered it. */
export type GateVerdict =
  | { decision: 'allow' }
  | { decision: 'escalate'; reason: string };

const ALLOW: GateVerdict = { decision: 'allow' };

/**
 * Tools that read without mutating anything. Under `human-gate` these are the
 * "trivially safe reads" the `ask` position exempts — but only inside the
 * step's own directory; a read of an arbitrary absolute path is exactly the
 * probe that ran unchallenged under `auto`.
 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead']);

/**
 * Where each tool names a filesystem path. Only tools whose path argument is a
 * plain string are listed: containment is checked where it can be checked, and
 * a tool absent from this table simply is not path-checked rather than being
 * guessed at.
 */
const PATH_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookRead: ['notebook_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
});

/**
 * The owenloop MCP mount, which is ALWAYS allowed under every policy.
 *
 * This is not a convenience. `submit` is how a step discharges what it owes and
 * `ask` is how it escalates to a person — including how it escalates a call this
 * very gatekeeper just refused. Gating either one makes an escalated step unable
 * to report that it is stuck, which converts a recoverable stall into a silent
 * one. The mount is worker-owned and its surface is fixed at four tools
 * (`get_order`, `submit`, `reject`, `ask`), none of which touch the filesystem
 * or the network beyond the hub, so there is nothing here for a human to weigh.
 */
const OWENLOOP_MCP_PREFIX = 'mcp__owenloop__';

/**
 * Shell patterns the deny-list escalates. Each entry has to clear a high bar:
 * genuinely destructive or exfiltrating, AND essentially never legitimate in a
 * step doing repository work. Anything that merely LOOKS alarming but has an
 * ordinary use in this pipeline is deliberately absent — `git push --force`, for
 * one, is routine on a step's own branch, and escalating it would stop real work
 * every run in exchange for no safety.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly { pattern: RegExp; what: string }[] = Object.freeze([
  { pattern: /\b(?:sudo|doas)\b/u, what: 'runs a command as another user' },
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/u,
    what: 'is a recursive force-delete',
  },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//u, what: 'writes directly to a device' },
  { pattern: /\b(?:mkfs(?:\.\w+)?|diskutil\s+erase\w*)\b/u, what: 'erases or formats a volume' },
  { pattern: /\bchown\b/u, what: 'changes file ownership' },
  { pattern: /\bchmod\s+(?:[0-7]*777|a\+[rwx]*w)/u, what: 'makes a file world-writable' },
  {
    pattern: /\b(?:curl|wget)\b[^\n]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--(?:data|upload-file|post-file)\b|\s-d\s)/u,
    what: 'sends data to a remote host',
  },
  {
    pattern: /\b(?:crontab|launchctl|systemctl|schtasks)\b/u,
    what: 'changes what runs on this machine outside this step',
  },
  {
    pattern: /(?:>>?\s*)(?:~|\$HOME)?\/?\.(?:zshrc|bashrc|bash_profile|zprofile|profile)\b/u,
    what: 'writes to a shell startup file',
  },
]);

/** Every string in a model-authored argument bag, at the top level. Enough for
 *  the path table (whose arguments are all top-level strings) without walking an
 *  arbitrary nested value. */
function stringArg(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Whether `candidate` resolves inside `root`.
 *
 * Resolved against `root` first, so a relative path means what the harness will
 * mean by it. The `..` test is on the RELATIVE result rather than on the input
 * string: `a/../../b` contains no leading `..` but lands outside, and a string
 * test would pass it.
 */
export function isInside(root: string, candidate: string): boolean {
  const absRoot = resolve(root);
  const absCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(absRoot, candidate);
  if (absCandidate === absRoot) return true;
  const rel = relative(absRoot, absCandidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The first deny-list pattern this command matches, or `undefined`.
 *
 * Exported for the tests, which assert the list's shape directly: the value of a
 * deny-list is entirely in which patterns are on it, so those assertions are the
 * documentation of what it does and does not claim to catch.
 */
export function dangerousCommand(command: string): string | undefined {
  for (const { pattern, what } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return what;
  }
  return undefined;
}

/**
 * Judge one tool call.
 *
 * ORDER MATTERS. The owenloop mount is cleared first so no later rule can strand
 * a step's ability to submit or escalate. The harness's own `blockedPath` is
 * consulted next because it is authoritative and covers cases this module cannot
 * see. Only then does policy divide: `human-gate` escalates everything but a
 * contained read, `classifier` runs the two checks it can actually decide.
 */
export function classifyToolCall(call: GateCall, policy: GatePolicy): GateVerdict {
  if (call.toolName.startsWith(OWENLOOP_MCP_PREFIX)) return ALLOW;

  if (policy === 'deny-unapproved') {
    return { decision: 'escalate', reason: `permissionMode denies unapproved tool calls` };
  }

  // The harness saw something this module did not — trust it.
  if (call.blockedPath !== undefined && call.blockedPath !== '') {
    return {
      decision: 'escalate',
      reason: `the harness flagged \`${call.blockedPath}\` as outside the directories this step may touch`,
    };
  }

  const paths = (PATH_ARGS[call.toolName] ?? [])
    .map((key) => stringArg(call.input, key))
    .filter((p): p is string => p !== undefined);

  for (const p of paths) {
    if (!isInside(call.workdir, p)) {
      return {
        decision: 'escalate',
        reason: `\`${p}\` is outside this step's working directory (\`${call.workdir}\`)`,
      };
    }
  }

  if (policy === 'human-gate') {
    // Every path this tool named is contained, or it named none. A read is the
    // one thing `ask` lets through; anything that can mutate or reach the
    // network is what the position exists to put in front of a person.
    if (READ_ONLY_TOOLS.has(call.toolName)) return ALLOW;
    return {
      decision: 'escalate',
      reason: `permissionMode is \`ask\`, so \`${call.toolName}\` needs a person's approval`,
    };
  }

  const command = stringArg(call.input, 'command');
  if (call.toolName === 'Bash' && command !== undefined) {
    const what = dangerousCommand(command);
    if (what !== undefined) {
      return { decision: 'escalate', reason: `the command ${what}` };
    }
  }

  return ALLOW;
}
