/** Routed agent process and terminal custody. The model sees none of the
 * original-session authority; this role owns one retained supervisor and the
 * broker owns every Service mutation and terminal classification. */
import { performance } from 'node:perf_hooks';
import type { RoutedAgentLifecycle } from '../agent/loop.ts';
import type { RoutingChildClient } from '../hub/routing-child-client.ts';
import type { HarnessAdapter, RoutedHarnessLaunch } from '../harness/contract.ts';

const TERMINAL_MS = 45_000;

export function createRoutedAgentLifecycle(args: {
  child: Pick<RoutingChildClient, 'quiesce' | 'agentOutcome' | 'agentFinish'>;
  generation: string;
  /** The exact selected adapter's retained routed start. No ordinary start
   * fallback is permitted after the parent accepts a launch occurrence. */
  start: NonNullable<HarnessAdapter['startRouted']>;
  terminalMs?: number;
}): RoutedAgentLifecycle {
  const budget = args.terminalMs ?? TERMINAL_MS;
  if (!Number.isFinite(budget) || budget <= 0 || budget > TERMINAL_MS)
    throw new Error('routed agent terminal budget refused');
  let startAttempted = false;
  let launch: RoutedHarnessLaunch | undefined;
  let stopped = false;
  let freeze: ReturnType<typeof args.child.quiesce> | undefined;
  let group: Promise<'empty' | 'uncertain'> | undefined;
  let terminal: Promise<'submitted' | 'released' | 'uncertain'> | undefined;
  const beginFreeze = () => {
    if (!freeze) {
      try { freeze = args.child.quiesce(); }
      catch (error) { freeze = Promise.reject(error); }
      // Stop can begin before the loop reaches complete(). Retain and observe
      // a lost ACK immediately rather than emitting an unhandled rejection.
      void freeze.catch(() => {});
    }
    return freeze;
  };
  const beginGroup = (reason: 'normal-exit' | 'stop' | 'setup-failed') => {
    if (!launch) return undefined;
    return group ??= launch.transport.settleEffects({ reason,
      deadlineAt: performance.now() + budget }).then(result =>
      result.scope === 'original-posix-group' && result.state === 'empty'
	? 'empty' : 'uncertain', () => 'uncertain');
  };
  const bounded = async <T>(start: () => Promise<T>, deadlineAt: number,
    onTimeout?: () => void): Promise<T> => {
    const remaining = deadlineAt - performance.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('routed agent deadline');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = start();
      return await Promise.race([work, new Promise<never>((_, reject) => {
	timer = setTimeout(() => { onTimeout?.(); reject(new Error('routed agent deadline')); }, remaining);
	timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  return {
    start(argsForAdapter, onEvent) {
      if (startAttempted || stopped) throw new Error('routed agent launch already attempted');
      startAttempted = true; // a synchronous spawn throw is still ambiguous
      return args.start(argsForAdapter, onEvent, { generation: args.generation,
	onLaunch(retained) {
	  if (launch || retained.generation !== args.generation)
	    throw new Error('routed agent launch generation changed');
	  launch = retained;
	  if (stopped) { beginFreeze(); beginGroup('stop'); }
	} });
    },
    requestStop() {
      stopped = true;
      // Start both retained cleanups now. Losing the broker ACK never strands
      // a live original group, and timing out the caller never cancels them.
      beginFreeze();
      beginGroup('stop');
    },
    complete(reason) {
      if (terminal) return terminal;
      const deadlineAt = performance.now() + budget;
      const consequenceAbort = new AbortController();
      const frozen = beginFreeze();
      const groupResult = startAttempted
	? beginGroup(stopped || reason === 'stop' ? 'stop'
	  : reason === 'turn-ended' ? 'normal-exit' : 'setup-failed')
	: undefined;
      terminal = (async () => {
	if (startAttempted && !groupResult) return 'uncertain';
	let freezeAck: Awaited<typeof frozen>;
	let empty: 'empty' | 'uncertain' | undefined;
	try {
	  [freezeAck, empty] = await bounded(() => Promise.all([frozen,
	    groupResult ?? Promise.resolve(undefined)]).then(([ack, state]) => [ack, state] as const), deadlineAt);
	} catch { return 'uncertain'; }
	if (!freezeAck.quiescing || empty === 'uncertain') return 'uncertain';
	// An uncertain ACK may be only one exact conditional submit. The
	// parent ledger, never this worker, decides whether it is recoverable.
	if (!startAttempted) {
	  try {
	    const finish = await bounded(() => args.child.agentFinish(
	      { observation: 'not-started' }, consequenceAbort.signal), deadlineAt,
	    () => consequenceAbort.abort());
	    return finish.state === 'released' || finish.state === 'already-closed'
	      ? 'released' : 'uncertain';
	  } catch { return 'uncertain'; }
	}
	if (empty !== 'empty') return 'uncertain';
	const observation = { group: { scope: 'original-posix-group' as const, state: 'empty' as const } };
	let outcome: Awaited<ReturnType<typeof args.child.agentOutcome>>;
	try { outcome = await bounded(() => args.child.agentOutcome(
	  observation, consequenceAbort.signal), deadlineAt, () => consequenceAbort.abort()); }
	catch { return 'uncertain'; }
	if (outcome.claim === 'uncertain') return 'uncertain';
	if (outcome.claim === 'closed') return 'submitted';
	if (reason === 'lease-ended' && !stopped) return 'uncertain';
	try {
	  const finish = await bounded(() => args.child.agentFinish(
	    observation, consequenceAbort.signal), deadlineAt, () => consequenceAbort.abort());
	  return finish.state === 'released' || finish.state === 'already-closed'
	    ? 'released' : 'uncertain';
	} catch { return 'uncertain'; }
      })();
      return terminal;
    },
  };
}
