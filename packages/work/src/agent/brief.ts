/**
 * Brief rendering + the born-bound work-holder MCP mount, for the `agent-run`
 * worker (Phase 3).
 *
 * Two pure functions, no I/O:
 *
 *  - `renderBrief(templateContent, spec)` — the SAME four-token substitution the
 *    legacy stamp path performs when it writes a per-order Step Agent file,
 *    minus the file. The worker hands the result straight to
 *    `HarnessAdapter.start` as `StartArgs.brief`.
 *  - `buildOwenloopMcp(spec)` — the `{command, args}` stdio mount for owenloop's
 *    own full work-holder MCP surface, byte-identical to the
 *    `mcpServers.owenloop` literal the legacy host adapter injects into stamped
 *    frontmatter today. A restricted adapter may append the hold role's positive
 *    tool selector without changing the born-bound identity arguments.
 *
 * WHY THE TOKENS ARE DECLARED HERE AND NOT IMPORTED (plan D4): the legacy
 * host-adapter module under `src/adapters/` is what Phase 5 deletes, and it is
 * vendor-named. Importing from it would point new code at a module on its way
 * out. The duplication is deliberate and `test/agent-brief.test.ts` asserts the
 * two sets are equal strings, so it cannot drift silently.
 *
 * Phase 4 adds a third pure function, `renderRejection` — see its own header.
 *
 * CREDENTIAL STANCE: `buildOwenloopMcp` puts NO credential in argv. The mount
 * carries `--as <account>` — a Scoped Identity *selector*, not a secret — and
 * the mounted work-holder resolves its own bearer from owenloop's credential
 * store. `test/agent-brief.test.ts` asserts this. `renderRejection` reads only
 * `OrderPacket.owes`, which carries no credential either, and
 * `test/agent-rejection.test.ts` asserts that too. The separate, environmental
 * `OWENLOOP_TOKEN` inheritance problem — Phase 3 pointed it at Phase 4, Phase 4
 * re-deferred it — is CLOSED as of Phase 6: `filterOwenloopEnv`
 * (`src/harness/child-env.ts`) is an allowlist over the `OWENLOOP_*` namespace,
 * both adapters pass their child `env` through it, and `agent-run` stopped
 * honouring the override on its own side in the same commit so the two sides
 * cannot authenticate as different principals. See `docs/agent-runner.md`.
 */
import type { OrderPacket, ReasonEntry } from '../hub/types.ts';
import { resolveOwenloopBin } from '../owenloop-bin.ts';

/** The composite `<workflow>/<run>` order id token. */
export const ORDER_TOKEN = '__OWENLOOP_ORDER__';
/** The hub origin token. */
export const ORIGIN_TOKEN = '__OWENLOOP_ORIGIN__';
/** The Scoped Identity account token. */
export const ACCOUNT_TOKEN = '__OWENLOOP_ACCOUNT__';
/** The dispatching Shift's self-declared id token (advisory only). */
export const SHIFT_TOKEN = '__OWENLOOP_SHIFT__';

/**
 * Everything the four-token substitution and the MCP mount need.
 *
 * `run` is the BARE run id; it composes with `workflow` into the
 * `<workflow>/<run>` composite every hub verb wants. `shiftId` is advisory
 * attribution only (D8/INV-82) and absent resolves to the empty string.
 */
export interface BriefSpec {
  workflow: string;
  run: string;
  origin: string;
  account: string;
  shiftId?: string;
  /**
   * The run's routing modifier (`express` | `standard` | `deep` — whatever the
   * def declared), as the caller asked for at `start_run`. Absent on a run
   * started without one.
   */
  modifier?: string;
  /**
   * `true` when the engine re-offered THIS step at its escalation target
   * instead of the run's own modifier — the step is on the recovery path after
   * repeated rejections, not a first attempt.
   */
  escalated?: boolean;
  /**
   * The owed output paths for this order, in packet order — `packet.owes`
   * mapped to its `path`. Feeds the submit contract; absent or empty renders
   * the contract without naming any path.
   */
  owes?: readonly string[];
}

/** The composite order id — the only form the hub verbs accept. */
function composite(spec: BriefSpec): string {
  return `${spec.workflow}/${spec.run}`;
}

/**
 * Substitute the four dispatch tokens into a step template.
 *
 * `split(...).join(...)` rather than a regex replace, mirroring the legacy
 * stamp exactly: it replaces every occurrence and treats the token as a literal
 * (no accidental `$&` expansion from template text the author controls).
 */
export function renderBrief(templateContent: string, spec: BriefSpec): string {
  const substituted = templateContent
    .split(ORDER_TOKEN)
    .join(composite(spec))
    .split(ORIGIN_TOKEN)
    .join(spec.origin)
    .split(ACCOUNT_TOKEN)
    .join(spec.account)
    .split(SHIFT_TOKEN)
    .join(spec.shiftId ?? '');
  const blocks = [
    renderRoutingLine(spec),
    renderSubmitContract(spec),
    renderEscalationContract(spec),
    substituted,
  ];
  return blocks.filter((b) => b !== '').join('\n\n');
}

/**
 * How an order is COMPLETED, stated to every agent on every run.
 *
 * WHY THIS EXISTS. Nothing else ever told an agent that finishing means calling
 * a tool. The engine mounts the work-holder MCP server and then relies entirely
 * on the def author's prose; owenloop's own house verb for it is "green <path>
 * with <value>", which names no tool and is not a phrase any model has seen
 * before. A strong enough model infers the tool call from the mounted surface
 * and submits; a weaker one reads the same sentence as "print this JSON",
 * writes the value into a code fence, and ends its turn. The hub then records
 * nothing, the confirm grace lapses, and the order is re-offered — so the step
 * loops forever while every attempt does the work correctly. That is a defect
 * in what the engine states, not in the def or the model: the engine is the
 * only party that knows the submit contract, so the engine has to state it.
 *
 * WHY IT NAMES THE OWED PATHS. `submit` is per-path and takes the path as an
 * argument, so "call submit" alone is not actionable — an agent that owes two
 * outputs and submits one is as stuck as one that submits none. The list comes
 * from `packet.owes`, which is the hub's own answer to "what does this order
 * still owe", so it stays correct on a re-offer where some paths are already
 * paid.
 *
 * WHY THE COUNTER-EXAMPLE IS SPELLED OUT. The observed failure is not a refusal
 * to submit — it is a belief that printing IS submitting. Naming the tool
 * without ruling out the near-miss leaves that belief intact.
 *
 * Vendor-neutral by construction: it names owenloop's own tool and mount, and
 * no harness. `test/vendor-gate.test.ts` fails any shipped file outside
 * `src/harness/` that names a vendor.
 */
function renderSubmitContract(spec: BriefSpec): string {
  const owed = (spec.owes ?? []).filter((p) => p !== '');
  // Nothing owed, nothing to say — the same stance the routing line takes on an
  // absent modifier. A contract with no path to name would have to write
  // `<path>` into its own example, which teaches the shape of the call while
  // leaving the one argument that matters unanswered.
  if (owed.length === 0) return '';
  return [
    `How this order completes: submit your result with the \`submit\` tool on the mounted \`owenloop\` MCP server. You owe ${owed.map((p) => `\`${p}\``).join(', ')} — call it once for each.`,
    `Example: \`submit({"path": "${owed[0]!}", "value": <the value this brief asks for>})\`.`,
    'Printing that value as text, or inside a code fence, does NOT submit it — the turn ends, the hub records nothing, and this order is re-offered from scratch. Wherever this brief says "green <path> with <value>", it means exactly this tool call.',
  ].join('\n');
}

/**
 * What an agent does when it CANNOT complete the order, stated to every agent on
 * every run, right after the submit contract.
 *
 * WHY THIS EXISTS. The submit contract closes one hole (an agent that finished
 * but did not know how to say so). This closes the opposite one: an agent that
 * did NOT finish and has no legal way to say so. Until `ask` shipped there were
 * exactly two exits from a step, and a blocked agent had to pick the less
 * damaging:
 *   - Submit anyway. The artifact goes green on a value the agent does not
 *     believe, and every downstream step builds on it. Observed on a real run:
 *     a planner that could read nothing produced a confident, fictional plan and
 *     a builder started executing it.
 *   - End the turn without submitting. The lease lapses, the task re-arms, and a
 *     fresh worker starts from the identical missing information. It repeats
 *     until the stall cap, spending a full model run per attempt to relearn the
 *     same blocker, and no human is ever told.
 * Neither reaches a person. Both were watched happening. The tool is the fix and
 * this paragraph is what makes the tool reachable — a mounted tool nobody is
 * told about is dead code.
 *
 * WHY IT NAMES THE COST. Models are heavily biased toward producing an answer,
 * and an escalation path that reads as failure will not be taken. So the text
 * states the two facts that make asking the correct move rather than the
 * cowardly one: it costs no attempts, and guessing is worse than asking.
 *
 * WHY IT STATES THE BAR. "Ask whenever unsure" would turn every ambiguity into a
 * human interrupt and the channel would be ignored within a day. The bar is
 * concrete: ask when the missing thing cannot be recovered by working — reading
 * the repo, running a read-only command, re-reading the inputs — because those
 * are exactly the cases where another attempt cannot help.
 *
 * Rendered only when the order owes something, for the same reason the submit
 * contract is: `ask` takes an owed path as its argument, and a contract that has
 * to write `<path>` into its own example teaches the call shape while leaving
 * the one argument that matters unanswered.
 *
 * Vendor-neutral by construction — names owenloop's own tool and mount only.
 */
function renderEscalationContract(spec: BriefSpec): string {
  const owed = (spec.owes ?? []).filter((p) => p !== '');
  if (owed.length === 0) return '';
  return [
    `If you CANNOT produce what this order asks for, do not guess and do not end your turn silently — call the \`ask\` tool on the same \`owenloop\` MCP server and stop.`,
    `Example: \`ask({"path": "${owed[0]!}", "question": "<the specific decision or fact you need from a person>", "context": "<what you already tried>"})\`.`,
    'Ask when the thing you are missing cannot be recovered by working: a required input is absent, wrong, or contradicts another input; the order asks for a judgment only the operator can make; or you cannot reach something the order depends on. Do NOT ask for anything you could resolve by reading the repository, re-reading your inputs, or running a read-only command — do that first.',
    'Asking costs you nothing: it is not a failed attempt, it consumes none of this step\'s retry budget, and it is the correct outcome when the honest answer is "I do not know". Submitting a value you do not believe is worse than asking — it goes green and every later step builds on it. Ending your turn without submitting is worse than asking — this step simply re-runs with the same information missing, and no person is ever told.',
    'After you ask, your run is over. A human answers on the same artifact and a fresh attempt starts with their answer attached.',
  ].join('\n');
}

/**
 * The run's depth, stated to the agent in one line, PREPENDED rather than
 * substituted into a token.
 *
 * A token would only reach agents whose def author remembered to write it, and
 * the whole point of the modifier is that the SAME step body runs at three
 * different depths — the author has one template and cannot mark every place
 * depth matters. Prepending puts it in front of every agent on every run at no
 * cost to existing bundles.
 *
 * It is deliberately DESCRIPTIVE, not directive: it tells the agent what depth
 * the run was started at and leaves the interpretation to the step's own body.
 * The modifier already decided the model and effort before this line was
 * written; restating it as an order ("think harder") would be the brief trying
 * to do the router's job.
 *
 * Empty string when the run carries no modifier — a run started without one has
 * nothing true to say here, and a line reading "modifier: none" would invite an
 * agent to reason about an absence that means nothing.
 */
function renderRoutingLine(spec: BriefSpec): string {
  if (spec.modifier === undefined || spec.modifier === '') return '';
  const escalated =
    spec.escalated === true
      ? ' This step was RE-OFFERED at a deeper modifier after repeated rejections of its output —' +
        ' it is a recovery attempt, not a first pass.'
      : '';
  return `Routing: this run was started at the '${spec.modifier}' depth modifier.${escalated}`;
}

/**
 * The born-bound work-holder mount handed to `HarnessAdapter.start` as
 * `StartArgs.owenloopMcp`. The adapter never constructs or changes the bound
 * identity. A restricted adapter may append the hold role's positive MCP tool
 * selector before mounting the command.
 *
 * `--shift=<cid>` is ONE argv element, not two. An absent cid then degrades
 * to the single well-formed string `"--shift="` instead of a dangling flag
 * with no value or a null array entry, which is what `hold`'s parser expects.
 * (The shape originated with the deleted stamp path, which had to survive a YAML
 * args array; it is kept because it is still the correct, unambiguous form.)
 *
 * `--never-release` is load-bearing. This child runs its own lease loop, but it
 * is NOT the holder of record: `agent-run`'s `exec` loop already claimed the
 * order and is the only thing entitled to hand it back. Without the flag the
 * child's stdin EOF — which in `--mcp` mode is just the harness closing the
 * JSON-RPC transport — fired a final-breath `release`, unclaiming a run the
 * agent was still working. The mount's terminal guard then fast-failed every
 * later get_order/submit, the agent finished with nothing, and the shift
 * re-dispatched the same order into a fresh worker that did it all again.
 */
export function buildOwenloopMcp(
  spec: BriefSpec,
  binPath: string = resolveOwenloopBin(),
  execPath: string = process.execPath,
): { command: string; args: string[] } {
  return {
    command: execPath,
    args: [
      binPath,
      'work',
      'hold',
      '--order',
      composite(spec),
      '--origin',
      spec.origin,
      '--as',
      spec.account,
      `--shift=${spec.shiftId ?? ''}`,
      '--mcp',
      '--never-release',
    ],
  };
}

// ---- Phase 4: the rejection delta -------------------------------------------

/**
 * What `renderRejection` produced, plus the watermark the caller must persist.
 *
 * `message` is `''` EXACTLY WHEN nothing new needed saying. The caller treats
 * that as "cold-start with the ordinary brief", never as "resume with an empty
 * message" — a resume that says nothing spends a whole turn to communicate
 * nothing.
 *
 * `deliveredReasonAt` is the largest `ReasonEntry.at` included in `message`, or
 * `undefined` when `message` is empty. It becomes `SessionRecord.deliveredReasonAt`
 * on the row written for the attempt this message opened.
 */
export interface RejectionDelta {
  message: string;
  deliveredReasonAt?: number;
  /** How many reason entries the message actually carries. Lets a caller log or
   *  assert the delta size without re-parsing the rendered text. */
  count: number;
}

/** Options for `renderRejection`. */
export interface RejectionSpec {
  /** The re-offered packet. Only `owes` is read. */
  packet: Pick<OrderPacket, 'owes'>;
  /**
   * The `at` of the newest reason ALREADY delivered into this session, from the
   * last `SessionRecord` for this `(workflow, run, step)`. Absent means nothing
   * has been delivered yet, so every reason is new — which is the correct read
   * for a record written before Phase 4 added the field.
   */
  deliveredReasonAt?: number;
  /**
   * Restrict rendering to these owed paths. Absent renders a section for EVERY
   * owed path that has new reasons, which is what a re-offer owing several paths
   * needs (one section per path, still delta-only, still one watermark).
   */
  paths?: readonly string[];
}

/** Rough token budget for the cold-replay brief, per the Phase 4 plan. */
export const REPLAY_TOKEN_BUDGET = 100_000;

/** chars/4 — the cheap, deliberately approximate token estimate. Nothing here
 *  needs a real tokenizer: the cap exists to avoid a pathological brief, not to
 *  hit a byte-exact ceiling. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One rendered reason line. `kind`/`by` are attribution the model needs to weigh
 *  a reason; `text` is the reason itself. */
function reasonLine(index: number, r: ReasonEntry): string {
  return `${index}. [${r.kind}, by ${r.by}] ${r.text}`;
}

/**
 * Render the REJECTION DELTA — the whole point of Phase 4.
 *
 * THE CENTRAL DESIGN POINT: this message is SHORT, and it deliberately does NOT
 * contain the brief. The session being resumed already holds the original brief,
 * the file reads, the tool results and the prior submission — that is the entire
 * reason the worker resumes instead of restarting. Re-sending the brief would
 * spend exactly the tokens this phase exists to save, and would leave the model
 * with two copies of its instructions and no way to tell which is current.
 *
 * WHAT IT MAY NOT CONTAIN, and why each is named rather than left to judgement:
 *  - `brief` / `material.templateContent` / `packet.prompt` — see above.
 *  - `packet.consumes` and any submit hint — the resumed session already has them.
 *  - any credential material. `OrderPacket.owes` carries none, and this function
 *    reads nothing else, so the property holds by construction rather than by
 *    filtering. `test/agent-rejection.test.ts` asserts it anyway.
 *
 * REASON SELECTION, restated from `docs/agent-runner.md` (c): the reasons come
 * from `OrderPacket.owes[].reasons`, filtered to `at > deliveredReasonAt` and, when
 * `spec.paths` is given, to those owed paths. NEVER from `WorkOrder.feedback` —
 * that is the flattened `whats_next` shape, it carries no `at`, and a shape with
 * no timestamp cannot be diffed against a watermark.
 *
 * PURE: packet + watermark in, string out. No I/O, no clock, no harness.
 */
export function renderRejection(spec: RejectionSpec): RejectionDelta {
  const since = spec.deliveredReasonAt;
  const wanted = spec.paths === undefined ? undefined : new Set(spec.paths);

  const sections: string[] = [];
  let newest: number | undefined;
  let count = 0;

  for (const owed of spec.packet.owes) {
    if (wanted !== undefined && !wanted.has(owed.path)) continue;

    const fresh = owed.reasons.filter((r) => since === undefined || r.at > since);
    // A schema reject with no text is a real shape: the owed entry exists, the
    // reason thread is empty. Filtering to nothing here is what makes the caller
    // cold-start rather than resume with a bare "you were rejected".
    if (fresh.length === 0) continue;

    const lines = fresh.map((r, i) => reasonLine(i + 1, r));
    sections.push(`Your submission for \`${owed.path}\` was rejected. Reasons:\n\n${lines.join('\n')}`);

    count += fresh.length;
    for (const r of fresh) {
      if (newest === undefined || r.at > newest) newest = r.at;
    }
  }

  if (sections.length === 0) return { message: '', count: 0 };

  const message = [
    ...sections,
    'Revise and submit again to the same path with the same tool. Do not start over —\n' +
      'keep everything you already have that was not called out above.',
  ].join('\n\n');

  return { message, count, ...(newest !== undefined ? { deliveredReasonAt: newest } : {}) };
}

/**
 * Assemble a COLD-REPLAY brief: the ordinary rendered brief plus the same
 * rejection body as a trailing section.
 *
 * Used when resume is impossible (no prior session, a different harness, a dead
 * session, a reaped cwd, a `replay`-tier adapter, or the provider rejecting the
 * resume with `ResumeUnavailableError`). The session is gone, so the brief has to
 * come back — but the reasons still have to arrive, or the fresh agent repeats
 * the rejected submission verbatim.
 *
 * THE CAP. The assembled text is held to roughly `REPLAY_TOKEN_BUDGET` tokens by
 * a chars/4 estimate. When it is over, WHOLE reason entries are dropped from the
 * OLDEST end first and the message says how many were dropped. Never a mid-entry
 * truncation: the kanna `handoff.ts` rule — never orphan a tool result from its
 * call — generalizes here to "never emit half a structured item", because half a
 * reason reads as a complete but different instruction.
 *
 * The BRIEF is never trimmed. If the brief alone exceeds the budget, the brief
 * wins and the rejection section is reduced to as many of the NEWEST reasons as
 * still fit, possibly none — losing the brief would leave the agent with no task
 * at all, which is strictly worse than losing old reasons.
 */
export function renderReplayBrief(brief: string, spec: RejectionSpec): string {
  const full = renderRejection(spec);
  if (full.message === '') return brief;

  const join = (body: string, dropped: number): string => {
    const note =
      dropped > 0
        ? `\n\n(${dropped} older rejection reason${dropped === 1 ? '' : 's'} omitted to fit the context budget.)`
        : '';
    return `${brief}\n\n---\n\n${body}${note}`;
  };

  let assembled = join(full.message, 0);
  if (estimateTokens(assembled) <= REPLAY_TOKEN_BUDGET) return assembled;

  // Over budget: re-render with progressively fewer reasons, oldest dropped
  // first. `ordered` is every candidate entry in ascending `at`, so slicing off
  // the FRONT drops the oldest and keeps whole entries.
  const since = spec.deliveredReasonAt;
  const wanted = spec.paths === undefined ? undefined : new Set(spec.paths);
  const ordered: ReasonEntry[] = spec.packet.owes
    .filter((o) => wanted === undefined || wanted.has(o.path))
    .flatMap((o) => o.reasons)
    .filter((r) => since === undefined || r.at > since)
    .sort((a, b) => a.at - b.at);

  for (let drop = 1; drop <= ordered.length; drop += 1) {
    const keep = new Set(ordered.slice(drop));
    const trimmed = renderRejection({
      ...spec,
      packet: {
        owes: spec.packet.owes.map((o) => ({ ...o, reasons: o.reasons.filter((r) => keep.has(r)) })),
      },
      // The watermark filter already ran; re-applying it is harmless but the
      // `keep` set is now the authority on which entries survive.
      ...(since !== undefined ? { deliveredReasonAt: since } : {}),
    });
    if (trimmed.message === '') break;
    assembled = join(trimmed.message, drop);
    if (estimateTokens(assembled) <= REPLAY_TOKEN_BUDGET) return assembled;
  }

  // Everything was dropped and it still does not fit — the brief alone is over
  // budget. Return the brief: an agent with a task and no reasons can still work.
  return brief;
}
