/**
 * A per-call deadline for hub traffic.
 *
 * Issue #300: a shift daemon went silent for hours — no log lines, no hub
 * traffic, zero CPU — while its control socket still answered `shift status`.
 * The poll loop was awaiting one hub call that never settled. Nothing in the
 * loop ever bounded a call, so nothing could ever throw, log, or count it.
 *
 * This bounds one call two ways at once, mirroring the roster-sync deadline
 * this was generalised from: an `AbortController` so an abort-aware transport
 * (undici `fetch` honours `signal`) tears the request down, AND an explicit
 * race so a client that ignores the signal — a test fake, a non-fetch
 * transport — is still cut short. Both report the same Error, so the caller
 * sees one stable outcome whichever fired first.
 *
 * The timeout is a plain `Error`, never a `HubError`: it must be counted as an
 * ordinary (non-rate-limited) failure by whoever catches it, exactly like a
 * connection reset would be.
 */
export async function withHubCallTimeout<T>(
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      // Abort carries the same terminal error so an abort-aware transport and
      // the explicit race report one stable, useful timeout outcome.
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    // A pending deadline must never be what keeps the process alive.
    timer.unref?.();
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // A composite call can reject as soon as one request fails while a
    // sibling fetch is still waiting. Always cancel on settlement so that
    // sibling cannot outlive this call (and accumulate across polls).
    if (!controller.signal.aborted) controller.abort(new Error(`${label} finished`));
  }
}
