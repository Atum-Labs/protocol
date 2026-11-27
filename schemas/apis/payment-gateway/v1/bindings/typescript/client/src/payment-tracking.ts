/**
 * Polling a submitted payment until it reaches a state it cannot leave, or, when asked, until its
 * payout is on chain.
 *
 * The gateway holds a submission for its own synchronous window before answering, so a payment that
 * is still pending by the time the caller sees it settled more slowly than that window. A submission usually
 * comes back pending, so following one is the ordinary path rather than an edge case.
 *
 * The wait budget is a client-side convenience, not a deadline with any meaning to the network.
 * Nothing is affected by giving up: the payment continues, and re-submitting the same request id or
 * asking for the payment's status picks up wherever it got to. In particular a settlement that
 * stalls will never become terminal on its own, so no budget can promise a terminal answer — giving
 * up while still pending is a normal ending, not a failure.
 */

/**
 * True for the states a payment can never leave.
 *
 * An unrecognized or absent status is deliberately NOT terminal: a status this client does not
 * know is treated as still in flight, so a gateway that adds one does not make a caller report a
 * payment as finished on the strength of a value it cannot interpret.
 */
export function isTerminalStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'refunded';
}

/**
 * What a wait waits for: `finalizing`, the payout on chain, or `completed`, the payout final.
 * `failed`, `refunded` and `refund_available` end a wait either way: on `refund_available` the refund
 * is waiting on the payer.
 */
export type WaitFor = 'finalizing' | 'completed';

/** True once `status` is one a wait for `waitFor` stops at. */
export function hasReached(status: string | undefined, waitFor: WaitFor): boolean {
  return (
    isTerminalStatus(status) ||
    status === 'refund_available' ||
    (waitFor === 'finalizing' && status === 'finalizing')
  );
}

/**
 * Default wait, in seconds, for the command-line tools' `--wait-seconds` flag, where seconds is
 * the unit a person types. Not part of the SDK surface: {@link WaitParams.budgetMs} is in
 * milliseconds, and defaults to this same duration.
 */
export const DEFAULT_WAIT_SECONDS = 60;

/**
 * Default budget for {@link waitForStatus}, in milliseconds.
 *
 * The gateway has already held the submission for its own window by the time a caller sees a
 * pending payment, so anything still pending is settling slowly. A minute past that covers the
 * common case without holding a request handler open indefinitely.
 */
export const DEFAULT_WAIT_BUDGET_MS = DEFAULT_WAIT_SECONDS * 1_000;

/** Gap between status checks. Short enough to feel responsive, long enough not to hammer. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * All this module needs of a status response: something that reports a status. Deciding when to
 * stop is the only thing it does, so it constrains the shape rather than defining it, and callers
 * get their own richer type back unchanged.
 */
export interface StatusSnapshot {
  status?: string;
}

/** Outcome of a wait. */
export interface WaitOutcome<T extends StatusSnapshot> {
  /** The last status successfully read, or undefined if no check ever succeeded. */
  snapshot?: T;
  /**
   * Whether the wait ended before the payment reached a status it stops at (see
   * {@link WaitParams.waitFor}), because the budget ran out or {@link WaitParams.signal} was
   * aborted. False only when `snapshot` holds such a status, which may be `refund_available`.
   */
  timedOut: boolean;
  /** Whether {@link WaitParams.signal} ended the wait. Implies `timedOut`. */
  aborted: boolean;
  /** How many status checks failed outright (network or gateway errors). */
  errorCount: number;
}

/** Everything the wait needs, with time and I/O injected so it can be tested without a clock. */
export interface WaitParams<T extends StatusSnapshot> {
  /** Read the payment's current status. */
  fetchStatus: () => Promise<T>;
  /**
   * What to wait for: `completed` (default) or `finalizing`, which stops once the payout is on
   * chain but not yet final, minutes earlier on some chains. `failed`, `refunded` and
   * `refund_available` end the wait either way.
   */
  waitFor?: WaitFor;
  /**
   * How long to keep checking, in **milliseconds**; defaults to {@link DEFAULT_WAIT_BUDGET_MS}.
   * A budget of zero or less checks nothing.
   */
  budgetMs?: number;
  /** Gap between checks; defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Monotonic-enough clock, in milliseconds; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Test seam for the delay. Replacing it opts out of abort-aware sleeping, so a wait then ends
   * at the next check rather than immediately.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Called for each failed check, so a caller can report it without this module owning output. */
  onError?: (error: unknown) => void;
  /**
   * Ends the wait early, for a caller that must stop on shutdown or when its request is cancelled.
   * The outcome reports `aborted`, and carries the last status read.
   */
  signal?: AbortSignal;
}

/**
 * Poll a payment's status until it reaches `waitFor` (`completed` by default) or fails, the budget
 * runs out, or `signal` is aborted.
 *
 * A failed check does not end the wait: a blip while a payment is mid-settlement is exactly when
 * giving up is least useful, so failures are counted, reported through `onError`, and polling
 * continues until the budget is spent.
 *
 * @param params - the status reader, the budget, and injectable time
 * @returns the last status read, whether the wait ended before reaching a status it stops at,
 *          whether `signal` ended it, and how many checks failed
 */
export async function waitForStatus<T extends StatusSnapshot>(
  params: WaitParams<T>,
): Promise<WaitOutcome<T>> {
  const {
    fetchStatus,
    waitFor = 'completed',
    budgetMs = DEFAULT_WAIT_BUDGET_MS,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    signal,
    // Closes over `signal` so the default wakes on abort instead of sleeping out the interval.
    sleep = (ms: number) => defaultSleep(ms, signal),
    onError,
  } = params;
  if (waitFor !== 'finalizing' && waitFor !== 'completed') {
    throw new TypeError(
      `waitFor must be 'finalizing' or 'completed', not ${JSON.stringify(waitFor)}`,
    );
  }

  const deadline = now() + budgetMs;
  let snapshot: T | undefined;
  let errorCount = 0;

  // Sleep before the first check: the caller has just read the payment's state, so checking again
  // immediately would re-read what it already has.
  while (now() < deadline) {
    if (signal?.aborted) {
      return { snapshot, timedOut: true, aborted: true, errorCount };
    }

    const remaining = deadline - now();
    await sleep(Math.min(intervalMs, remaining));

    if (signal?.aborted) {
      return { snapshot, timedOut: true, aborted: true, errorCount };
    }

    try {
      snapshot = await fetchStatus();
    } catch (error) {
      errorCount += 1;
      onError?.(error);
      continue;
    }

    if (hasReached(snapshot.status, waitFor)) {
      return { snapshot, timedOut: false, aborted: false, errorCount };
    }
  }

  return { snapshot, timedOut: true, aborted: false, errorCount };
}

/**
 * @deprecated Use {@link waitForStatus}, the same function. With `waitFor: 'finalizing'` it can
 * stop before a terminal state, which this name does not suggest.
 */
export const waitForTerminalStatus = waitForStatus;

/** Real delay, cut short by an abort so a shutdown does not wait out the interval. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
