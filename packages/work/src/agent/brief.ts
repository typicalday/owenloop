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
   * The owed outputs for this order, in packet order. Feeds the submit contract
   * (which names every path) and the attempt history (which reads the two reject
   * counters); absent or empty renders neither.
   *
   * The caller is responsible for the FALLBACK: `packet.owes` is the hub's live
   * answer to "what does this order still owe" and is the right source, but a
   * hub old enough to project no `owes` array at all leaves it empty while
   * `packet.outputs` still names the same paths. See `agent/loop.ts` — an empty
   * list here silently deletes both contracts, which is the exact failure they
   * were written to close.
   */
  owes?: readonly OwedBrief[];
}

/**
 * One owed output as the brief sees it: the path, plus how many times a prior
 * submission to it was knocked back.
 *
 * Both counters are optional because a hub that does not project them is not a
 * hub reporting zero — it is a hub with nothing to say, and the attempt history
 * stays silent rather than telling an agent on its fourth attempt that this is
 * its first.
 */
export interface OwedBrief {
  path: string;
  /** Consumer/judge verdicts against a submitted value (`packet.owes[].judgmentRejects`). */
  judgmentRejects?: number;
  /** Engine refusals of a malformed value against the path's declared JSON
   *  Schema (`packet.owes[].schemaRejects`). */
  schemaRejects?: number;
  /**
   * The JSON Schema the engine will enforce on this path at commit time
   * (`packet.owes[].schema`). Optional for the same reason the counters are: a
   * hub that does not project it is not a hub reporting "no constraint", so the
   * shape contract stays silent rather than telling an agent its output is
   * unconstrained when it may not be.
   */
  schema?: unknown;
  /** What `schema` governs (`packet.owes[].schemaAppliesTo`) — `'value'` for the
   *  submitted value itself, `'member'` for each member emitted into a
   *  collection. Read only when `schema` is present. */
  schemaAppliesTo?: 'value' | 'member';
}

/** The composite order id — the only form the hub verbs accept. */
function composite(spec: BriefSpec): string {
  return `${spec.workflow}/${spec.run}`;
}

/** The owed paths worth naming: every non-empty `path`, in packet order. An
 *  empty string is not a path a `submit` or `ask` call could be made against, so
 *  it is dropped here once rather than guarded at each use. */
function owedPaths(spec: BriefSpec): string[] {
  return (spec.owes ?? []).map((o) => o.path).filter((p) => p !== '');
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
    renderInputContract(spec),
    renderSubmitContract(spec),
    renderShapeContract(spec),
    renderAttemptHistory(spec),
    renderEscalationContract(spec),
    substituted,
  ];
  return blocks.filter((b) => b !== '').join('\n\n');
}

/**
 * Where this order's INPUTS are, stated to every agent on every run.
 *
 * WHY THIS EXISTS. The brief and the mounted work-holder are two halves of one
 * order and nothing ever joined them. The brief is a rendered template; the
 * order's actual data — the resolved `consumes` map, the owed paths, each path's
 * reason thread — lives on the hub behind `get_order`, a tool the agent is
 * mounted with and was never told about. So an agent whose template says "review
 * the plan" has no stated way to obtain the plan, and the two things it does
 * instead are both silent: it looks in its working directory and finds nothing,
 * or it writes what a plan would plausibly say. Observed live: a planner whose
 * working directory was empty produced a confident, fully-fabricated plan, and a
 * builder began executing it. The working-directory half of that run was a
 * separate defect and is fixed; this half is not, and it is the half that turns
 * "I have no inputs" into fiction rather than into a question.
 *
 * WHEN IT RENDERS. On the same condition as the submit and escalation contracts
 * — the order owes at least one named path — even though `get_order` itself
 * takes no arguments and could always be stated. Two reasons, both concrete:
 * this block's closing sentence sends the agent to `ask`, and `ask` is only
 * described when there is an owed path for it to name, so an unconditional
 * version would point at a section that is not there; and an order owing nothing
 * has no work to orient for. The tool it names is always mounted — every agent
 * order gets the full work-holder surface, because `buildOwenloopMcp` passes no
 * tool selector.
 *
 * WHY IT RANKS `get_order` ABOVE THE BRIEF. The brief is rendered once at
 * dispatch and is a summary; the packet is live and authoritative, and on a
 * re-offer it carries reason threads this text cannot. Telling the agent which
 * of the two wins removes the judgement call.
 *
 * WHY THE LAST LINE POINTS AT `ask`. Naming the source of inputs without saying
 * what to do when an input is missing from it just relocates the guess.
 *
 * Vendor-neutral by construction: names owenloop's own tool and mount, no
 * harness. `test/vendor-gate.test.ts` enforces this.
 */
function renderInputContract(spec: BriefSpec): string {
  if (owedPaths(spec).length === 0) return '';
  return [
    'Before you start: call the `get_order` tool on the mounted `owenloop` MCP server. It takes no arguments and returns THIS order in full — the inputs you were given (`consumes`), the exact output paths you owe, and each path\'s reason thread, including why any previous attempt was rejected.',
    'That packet is authoritative. This brief is a summary of it, rendered once when the order was dispatched; where the two disagree, the packet is right.',
    'If something you need is not in what `get_order` returns and you cannot recover it by working — reading the repository, re-reading your inputs, running a read-only command — then it was not given to you. Do not invent it and do not proceed on an assumption: use `ask` (below).',
  ].join('\n');
}

/**
 * How much rope is left, stated only when some has already been used.
 *
 * WHY THIS EXISTS, GIVEN THE REJECTION DELTA ALREADY SHIPS. `renderRejection` /
 * `renderReplayBrief` tell a re-offered agent WHAT was wrong with its last
 * submission. Neither tells it that the retrying is BOUNDED. Those are different
 * facts and they drive different behaviour: the reasons make an agent revise,
 * and revising is right up until the point where the blocker is not something
 * revision can fix — at which point the agent needs to know that grinding out
 * one more attempt is not free. Without a count, every attempt looks like the
 * first one, so an agent has no reason to ever switch from retrying to asking,
 * and the step burns its whole budget rediscovering the same blocker. The
 * counter is the input to that decision and the packet has carried it all along.
 *
 * WHY IT DOES NOT NAME THE CAP. The cap is `maxAttempts` / `maxSchemaFailures`,
 * resolved per-produce from the def (`model.ts`'s `effectiveMaxAttempts`), and
 * the order packet does not carry it. Rendering a guessed number would be worse
 * than rendering none: an agent told it has "2 of 5" left when it has 2 of 3
 * will keep grinding. So this states the counts, which are true, and states that
 * the budget is finite, which is also true, and states neither more precisely
 * than the packet allows.
 *
 * WHY IT SEPARATES THE TWO COUNTERS. They mean opposite things to the agent. A
 * judgment reject is a reader disagreeing with the CONTENT of a value that was
 * otherwise well-formed. A schema reject is the engine refusing the SHAPE before
 * anybody read it — rewriting the content again cannot help, and the fix is the
 * structure of what was submitted. Reporting them as one number would send an
 * agent to revise prose that was never read.
 *
 * Silent when every counter is zero or absent: a first attempt has no history,
 * and "0 previous rejections" is a sentence that costs tokens to say nothing.
 */
function renderAttemptHistory(spec: BriefSpec): string {
  const lines: string[] = [];
  for (const owed of spec.owes ?? []) {
    if (owed.path === '') continue;
    const judgment = owed.judgmentRejects ?? 0;
    const schema = owed.schemaRejects ?? 0;
    if (judgment === 0 && schema === 0) continue;
    const parts: string[] = [];
    if (judgment > 0) {
      parts.push(
        `${judgment} rejected on judgment (a reader disagreed with the value — see its reason thread via \`get_order\`)`,
      );
    }
    if (schema > 0) {
      parts.push(
        `${schema} rejected on schema (the value did not match the declared shape — the fix is the STRUCTURE of what you submit, not its wording)`,
      );
    }
    lines.push(`- \`${owed.path}\`: ${parts.join('; ')}.`);
  }
  if (lines.length === 0) return '';
  return [
    'Attempt history for this order — previous submissions that were knocked back:',
    ...lines,
    'This retrying is bounded. After enough rejections on a path the engine stops re-arming this step entirely and it sits until a person intervenes, so a further attempt that repeats the last one costs a real attempt and gains nothing. If you now believe the blocker is something another attempt cannot fix, `ask` instead of resubmitting.',
  ].join('\n');
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
  const owed = owedPaths(spec);
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
 * The SHAPE each owed value must have, stated before the agent produces one.
 *
 * WHY THIS EXISTS. The attempt history already tells a re-offered agent that its
 * last submission failed its schema, and how many refusals remain before the
 * step freezes. It never tells it the schema. So the agent on attempt two knows
 * only that something about the shape was wrong, holds exactly the information
 * it held on attempt one, and the most available move is to resubmit a near
 * variant — which is how a step burns its whole `maxSchemaFailures` budget on
 * one misunderstanding. The counter and the reasons are the symptom channel;
 * this is the requirement channel, and only one of them was wired.
 *
 * A schema refusal is also the CHEAPEST failure to prevent and the most
 * pointless to suffer: the engine rejects the value structurally, so no
 * consumer and no judge ever sees it, no reviewer time is spent, and the agent
 * learns nothing it could not have been told for free at dispatch.
 *
 * WHEN IT RENDERS. Only for owed paths whose produce actually declares a
 * schema. Most do not, and for those the engine accepts any JSON — so silence
 * here is correct, and a blanket "no schema declared" line would be worse than
 * nothing: a hub too old to project the field looks identical to a produce with
 * no schema, and only one of those two justifies telling an agent its output is
 * unconstrained. Neither gets that claim.
 *
 * WHY IT PRINTS THE SCHEMA WHOLE. A truncated JSON Schema is not a smaller
 * requirement, it is a different and wrong one — an agent that reads a clipped
 * `required` array will confidently omit a field. If a schema is large, large
 * is what the contract is.
 *
 * WHY `member` IS SPELLED OUT. A collection's owed path is its seal, but the
 * declared schema is checked against each member emitted into it, never against
 * the seal value. Printing the schema under the seal path without that sentence
 * would tell the agent to shape the wrong thing.
 */
function renderShapeContract(spec: BriefSpec): string {
  const constrained = (spec.owes ?? []).filter((o) => o.path !== '' && o.schema !== undefined);
  if (constrained.length === 0) return '';
  const blocks = constrained.map((o) => {
    const governs =
      o.schemaAppliesTo === 'member'
        ? `Each member you emit into \`${o.path}\` must satisfy this JSON Schema — it is checked per member, NOT against the sealed collection itself.`
        : `The value you submit to \`${o.path}\` must satisfy this JSON Schema.`;
    return `${governs}\n\`\`\`json\n${JSON.stringify(o.schema, null, 2)}\n\`\`\``;
  });
  return [
    'The shape of what you owe:',
    ...blocks,
    'The engine checks these at submit time, before any consumer or judge sees the value. A value that does not match is refused structurally — it is not reviewed, not partially accepted, and the refusal spends one of this order\'s limited schema attempts. Match the schema exactly rather than submitting something close and waiting to be told.',
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
  const owed = owedPaths(spec);
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
