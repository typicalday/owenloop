/**
 * The worker half of the deterministic tool-approval gate: raise one escalated
 * tool call to the hub, wait for a person, and hand the answer back to the
 * BLOCKED CALL — not to a future attempt.
 *
 * WHY WAITING HERE IS SAFE, WHICH IS THE WHOLE PREMISE. Two independent facts
 * have to hold at once, and both were verified before this was written:
 *
 *   1. The harness has no park deadline on a permission prompt. The host
 *      callback may take as long as it takes; what it must never do is fail to
 *      answer at all, because an unanswered prompt blocks that tool call
 *      forever with nothing recorded.
 *   2. The lease keeps heartbeating while the agent is blocked. The worker's
 *      lease loop runs on its own timer, started but never awaited by the agent
 *      loop, so it is not suspended by a blocked callback. Without this, waiting
 *      would let the hub reap the very claim the approval is stamped to.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not model the deadline hub-side.
 * The hub has no view of how long a given worker is willing to wait, and a
 * hub-side expiry racing this one would produce the single outcome that must not
 * exist: an approval marked answered that no worker ever received. The deadline
 * lives here, with the process that is actually waiting.
 *
 * EVERY NON-ANSWER IS A DENIAL. Deadline reached, hub unreachable, lease gone,
 * caller aborted — all of them return `denied` with a reason. The adapter then
 * does exactly what it did before this existed: refuse the call and route the
 * agent to `ask`. That is the degradation path, and it is the pre-existing
 * behavior rather than a new one, which is why adding this cannot make a
 * deployment worse than it was.
 */
import type { ApprovalOutcome, ApprovalRequest, ApprovalRequester } from '../harness/contract.ts';
import type { HubClient } from '../hub/client.ts';
import { HubError } from '../hub/types.ts';

/** Emitted so a blocked worker is visible in the shift log rather than looking
 *  hung. The worker supplies its own event sink. */
export interface ApprovalEvent {
  kind: 'raised' | 'waiting' | 'decided' | 'failed';
  text: string;
}

export interface ApprovalRequesterOptions {
  client: HubClient;
  workflow: string;
  run: string;
  /** How long to wait for a person before denying. */
  deadlineMs?: number;
  /** How often to re-send the (idempotent) request while waiting. */
  pollIntervalMs?: number;
  onEvent?: (e: ApprovalEvent) => void;
  /** Injected in tests. Defaults to an unref'd `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Twenty minutes. Long enough that a person who is at their desk but not
 * watching this specific run can still answer, short enough that a run left
 * blocked overnight does not hold a worker slot until the shift is restarted.
 * A denial at the deadline costs the run one honest `ask`, not a failure.
 */
const DEFAULT_DEADLINE_MS = 20 * 60 * 1_000;

/**
 * Five seconds. The poll is the same idempotent request as the raise, so its
 * only cost is one small round trip; the reason not to go faster is that a
 * person cannot answer faster than this anyway.
 */
const DEFAULT_POLL_MS = 5_000;

/** A timer that cannot by itself keep the event loop alive — a blocked approval
 *  must never be the reason a worker process refuses to exit. */
function sleepUnref(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

function errText(err: unknown): string {
  if (err instanceof HubError) return `${err.status} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * A hub error while WAITING is not necessarily fatal — a hub restart, a network
 * blip, or a 5xx are all things the next poll may well ride through, and denying
 * on the first one would make the gate useless on any imperfect link. A 4xx is
 * different: the request itself is wrong or refused (bad scope, unknown run),
 * and repeating it cannot change that.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof HubError)) return true;
  return err.status >= 500 || err.status === 429;
}

export function createApprovalRequester(opts: ApprovalRequesterOptions): ApprovalRequester {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const sleep = opts.sleep ?? sleepUnref;
  const now = opts.now ?? Date.now;
  const emit = (e: ApprovalEvent): void => opts.onEvent?.(e);

  return async function request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    const started = now();
    let raised = false;
    let consecutiveErrors = 0;

    for (;;) {
      if (req.signal?.aborted === true) {
        return { decision: 'denied', reason: 'the session ended before anyone answered' };
      }

      let res;
      try {
        // The SAME call every time. Raise and poll are one verb, keyed on
        // `toolUseId`, so a retry after a network failure cannot open a second
        // question and a poll cannot ask about one nobody raised.
        res = await opts.client.requestApproval({
          workflow: opts.workflow,
          run: opts.run,
          tool_use_id: req.toolUseId,
          tool_name: req.toolName,
          tool_input: req.toolInput,
          reason: req.reason,
          ...(req.title !== undefined ? { title: req.title } : {}),
        });
        consecutiveErrors = 0;
      } catch (err) {
        if (!isRetryable(err)) {
          emit({ kind: 'failed', text: `approval refused by the hub: ${errText(err)}` });
          return { decision: 'denied', reason: `the hub refused the approval request (${errText(err)})` };
        }
        consecutiveErrors += 1;
        if (now() - started >= deadlineMs) {
          return {
            decision: 'denied',
            reason: `the hub was unreachable for the whole wait (${consecutiveErrors} attempts, last: ${errText(err)})`,
          };
        }
        await sleep(pollMs);
        continue;
      }

      // The claim ended underneath us. Nothing was written and there is nobody
      // left for an answer to reach, so waiting longer cannot help.
      if (res.ok === false || res.approval === undefined) {
        const why = res.reason ?? 'the hub did not record the request';
        emit({ kind: 'failed', text: `approval not open: ${why}` });
        return { decision: 'denied', reason: `this run no longer holds its claim (${why})` };
      }

      const state = res.approval.state;
      if (state === 'approved') {
        emit({
          kind: 'decided',
          text: `approved by ${res.approval.decidedBy ?? 'a person'}: ${req.toolName}`,
        });
        return {
          decision: 'approved',
          ...(res.approval.note !== null ? { note: res.approval.note } : {}),
        };
      }
      if (state === 'denied' || state === 'expired') {
        emit({
          kind: 'decided',
          text: `${state} by ${res.approval.decidedBy ?? 'the hub'}: ${req.toolName}`,
        });
        return {
          decision: 'denied',
          reason: state === 'denied' ? 'a person denied this call' : 'the approval is no longer live',
          ...(res.approval.note !== null ? { note: res.approval.note } : {}),
        };
      }

      // Still pending.
      if (!raised) {
        raised = true;
        emit({
          kind: 'raised',
          text: `waiting on a human decision: ${req.toolName} — ${req.reason}`,
        });
      }
      if (now() - started >= deadlineMs) {
        emit({ kind: 'waiting', text: `nobody answered within the wait window: ${req.toolName}` });
        return {
          decision: 'denied',
          reason: `nobody answered within ${Math.round(deadlineMs / 60_000)} minutes`,
        };
      }
      await sleep(pollMs);
    }
  };
}
