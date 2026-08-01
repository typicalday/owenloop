/**
 * Brief rendering + the born-bound work-holder MCP mount, for the `agent-run`
 * runner (Phase 3).
 *
 * Two pure functions, no I/O:
 *
 *  - `renderBrief(templateContent, spec)` — the SAME four-token substitution the
 *    legacy stamp path performs when it writes a per-order Step Agent file,
 *    minus the file. The runner hands the result straight to
 *    `HarnessAdapter.start` as `StartArgs.brief`.
 *  - `buildOwenworkMcp(spec)` — the `{command, args}` stdio mount for owenwork's
 *    own work-holder MCP surface, byte-identical to the `mcpServers.owenwork`
 *    literal the legacy host adapter injects into stamped frontmatter today.
 *
 * WHY THE TOKENS ARE DECLARED HERE AND NOT IMPORTED (plan D4): the legacy
 * host-adapter module under `src/adapters/` is what Phase 5 deletes, and it is
 * vendor-named. Importing from it would point new code at a module on its way
 * out. The duplication is deliberate and `test/agent-brief.test.ts` asserts the
 * two sets are equal strings, so it cannot drift silently.
 *
 * Phase 4 adds a third pure function, `renderRejection` — see its own header.
 *
 * CREDENTIAL STANCE: `buildOwenworkMcp` puts NO credential in argv. The mount
 * carries `--as <account>` — a Scoped Identity *selector*, not a secret — and
 * the mounted work-holder resolves its own bearer from owenloop's credential
 * store. `test/agent-brief.test.ts` asserts this. `renderRejection` reads only
 * `OrderPacket.owes`, which carries no credential either, and
 * `test/agent-rejection.test.ts` asserts that too. The separate, environmental
 * `OWENWORK_TOKEN` inheritance problem — Phase 3 pointed it at Phase 4, Phase 4
 * re-deferred it — is CLOSED as of Phase 6: `filterOwenworkEnv`
 * (`src/harness/child-env.ts`) is an allowlist over the `OWENWORK_*` namespace,
 * both adapters pass their child `env` through it, and `agent-run` stopped
 * honouring the override on its own side in the same commit so the two sides
 * cannot authenticate as different principals. See `docs/agent-runner.md`.
 */
import type { OrderPacket, ReasonEntry } from '../hub/types.ts';

/** The composite `<workflow>/<run>` order id token. */
export const ORDER_TOKEN = '__OWENWORK_ORDER__';
/** The hub origin token. */
export const ORIGIN_TOKEN = '__OWENWORK_ORIGIN__';
/** The Scoped Identity account token. */
export const ACCOUNT_TOKEN = '__OWENWORK_ACCOUNT__';
/** The dispatching Conductor's self-declared id token (advisory only). */
export const CONDUCTOR_TOKEN = '__OWENWORK_CONDUCTOR__';

/**
 * Everything the four-token substitution and the MCP mount need.
 *
 * `run` is the BARE run id; it composes with `workflow` into the
 * `<workflow>/<run>` composite every hub verb wants. `conductorId` is advisory
 * attribution only (D8/INV-82) and absent resolves to the empty string.
 */
export interface BriefSpec {
  workflow: string;
  run: string;
  origin: string;
  account: string;
  conductorId?: string;
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
  return templateContent
    .split(ORDER_TOKEN)
    .join(composite(spec))
    .split(ORIGIN_TOKEN)
    .join(spec.origin)
    .split(ACCOUNT_TOKEN)
    .join(spec.account)
    .split(CONDUCTOR_TOKEN)
    .join(spec.conductorId ?? '');
}

/**
 * The born-bound work-holder mount handed to `HarnessAdapter.start` as
 * `StartArgs.owenworkMcp`. The adapter mounts it verbatim and never builds it.
 *
 * `--conductor=<cid>` is ONE argv element, not two. An absent cid then degrades
 * to the single well-formed string `"--conductor="` instead of a dangling flag
 * with no value or a null array entry, which is what `hold`'s parser expects.
 * (The shape originated with the deleted stamp path, which had to survive a YAML
 * args array; it is kept because it is still the correct, unambiguous form.)
 */
export function buildOwenworkMcp(spec: BriefSpec): { command: string; args: string[] } {
  return {
    command: 'owenloop',
    args: [
      'work',
      'hold',
      '--order',
      composite(spec),
      '--origin',
      spec.origin,
      '--as',
      spec.account,
      `--conductor=${spec.conductorId ?? ''}`,
      '--mcp',
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
 * reason the runner resumes instead of restarting. Re-sending the brief would
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
