import {
  waitForStatus,
  waitForTerminalStatus,
  isTerminalStatus,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_BUDGET_MS,
} from './payment-tracking';

/**
 * A fake clock that only advances when the code under test sleeps. A case using it runs instantly
 * and deterministically, and its assertions about *how long* the wait lasted are exact rather than
 * approximate.
 *
 * Supplying `sleep` is also what opts a case out of abort-aware sleeping, so the cases that need the
 * real delay do not use this — see "waitForTerminalStatus with the real delay" below.
 */
function fakeTime() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    elapsed: () => clock,
  };
}

describe('waitForTerminalStatus', () => {
  it('stops as soon as the payment settles', async () => {
    const time = fakeTime();
    const statuses = ['pending', 'pending', 'completed', 'completed'];
    let calls = 0;
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => ({ status: statuses[calls++] }),
      ...time,
    });

    expect(result.snapshot?.status).toBe('completed');
    expect(result.timedOut).toBe(false);
    // Three checks, not four: it must not keep polling after a terminal state.
    expect(calls).toBe(3);
    expect(time.elapsed()).toBe(3 * DEFAULT_POLL_INTERVAL_MS);
  });

  it("stops at finalizing when asked to with waitFor: 'finalizing'", async () => {
    const time = fakeTime();
    const statuses = ['pending', 'finalizing', 'completed'];
    let calls = 0;
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      waitFor: 'finalizing',
      fetchStatus: async () => ({ status: statuses[calls++] }),
      ...time,
    });

    expect(result.snapshot?.status).toBe('finalizing');
    expect(result.timedOut).toBe(false);
    expect(calls).toBe(2);
  });

  it('refuses an unknown waitFor before polling', async () => {
    let calls = 0;
    await expect(
      waitForTerminalStatus({
        waitFor: 'finalising' as 'finalizing',
        fetchStatus: async () => {
          calls++;
          return { status: 'pending' };
        },
        ...fakeTime(),
      }),
    ).rejects.toThrow(/waitFor must be 'finalizing' or 'completed'/);
    expect(calls).toBe(0);
  });

  it('is also exported as waitForStatus, the name that does not promise a terminal state', () => {
    expect(waitForTerminalStatus).toBe(waitForStatus);
  });

  it.each(['finalizing', 'completed'] as const)(
    'stops at refund_available when waiting for %s, since the refund is waiting on the payer',
    async (waitFor) => {
      const time = fakeTime();
      const statuses = ['pending', 'refund_available', 'completed'];
      let calls = 0;
      const result = await waitForStatus({
        budgetMs: 60_000,
        waitFor,
        fetchStatus: async () => ({ status: statuses[calls++] }),
        ...time,
      });

      expect(result.snapshot?.status).toBe('refund_available');
      expect(result.timedOut).toBe(false);
      expect(calls).toBe(2);
    },
  );

  it('waits through finalizing by default', async () => {
    const time = fakeTime();
    const statuses = ['finalizing', 'finalizing', 'completed'];
    let calls = 0;
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => ({ status: statuses[calls++] }),
      ...time,
    });

    expect(result.snapshot?.status).toBe('completed');
    expect(calls).toBe(3);
  });

  it.each(['failed'])('stops on a terminal failure (%s)', async (status) => {
    const time = fakeTime();
    let calls = 0;
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => {
        calls++;
        return { status };
      },
      ...time,
    });

    expect(result.snapshot?.status).toBe(status);
    expect(result.timedOut).toBe(false);
    expect(calls).toBe(1);
  });

  it('gives up when the budget runs out, reporting the last state it saw', async () => {
    const time = fakeTime();
    const result = await waitForTerminalStatus({
      budgetMs: 10_000,
      fetchStatus: async () => ({ status: 'pending' }),
      ...time,
    });

    expect(result.timedOut).toBe(true);
    expect(result.snapshot?.status).toBe('pending');
    // Bounded by the budget, not by the number of checks.
    expect(time.elapsed()).toBe(10_000);
  });

  it('never sleeps past the budget on the final interval', async () => {
    // A 5s budget with a 2s interval must not overshoot to 6s.
    const time = fakeTime();
    await waitForTerminalStatus({
      budgetMs: 5_000,
      intervalMs: 2_000,
      fetchStatus: async () => ({ status: 'pending' }),
      ...time,
    });
    expect(time.elapsed()).toBe(5_000);
  });

  it('checks nothing when the budget is zero', async () => {
    const time = fakeTime();
    const fetchStatus = jest.fn();
    const result = await waitForTerminalStatus({ budgetMs: 0, fetchStatus, ...time });

    expect(fetchStatus).not.toHaveBeenCalled();
    expect(result.timedOut).toBe(true);
    expect(result.snapshot).toBeUndefined();
  });

  it('sleeps before the first check rather than re-reading what the caller already has', async () => {
    const time = fakeTime();
    let elapsedAtFirstCheck = -1;
    await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => {
        if (elapsedAtFirstCheck < 0) elapsedAtFirstCheck = time.elapsed();
        return { status: 'completed' };
      },
      ...time,
    });
    expect(elapsedAtFirstCheck).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it('keeps waiting through a failed check', async () => {
    // A blip mid-settlement is the worst moment to give up: the payment is live and unresolved.
    const time = fakeTime();
    const outcomes = [
      () => {
        throw new Error('socket hang up');
      },
      () => ({ status: 'pending' }),
      () => ({ status: 'completed' }),
    ];
    let calls = 0;
    const seen: string[] = [];
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => outcomes[calls++](),
      onError: (err) => seen.push((err as Error).message),
      ...time,
    });

    expect(result.snapshot?.status).toBe('completed');
    expect(result.timedOut).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(seen).toEqual(['socket hang up']);
  });

  it('reports no snapshot when every check failed', async () => {
    const time = fakeTime();
    const result = await waitForTerminalStatus({
      budgetMs: 6_000,
      intervalMs: 2_000,
      fetchStatus: async () => {
        throw new Error('unreachable');
      },
      ...time,
    });

    expect(result.snapshot).toBeUndefined();
    expect(result.timedOut).toBe(true);
    expect(result.errorCount).toBe(3);
  });

  it("returns the caller's own response shape unchanged, not a narrowed copy", async () => {
    // The caller merges this into what it reports, so every field has to survive the round trip —
    // narrowing to just `status` would silently drop the receipt.
    const time = fakeTime();
    const full = {
      status: 'completed',
      payment_id: '0xpay',
      updated_at: '2026-08-04T07:50:19Z',
      transactions: { fulfillment: { transaction_hash: '0xdest', chain_id: 'eip155:42161' } },
    };
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => full,
      ...time,
    });
    expect(result.snapshot).toEqual(full);
    expect(result.snapshot?.transactions.fulfillment.transaction_hash).toBe('0xdest');
  });

  it('carries the recorded failure code through, so the caller can report it', async () => {
    const time = fakeTime();
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => ({ status: 'failed', error: { code: 'SETTLEMENT_FAILED' } }),
      ...time,
    });
    expect(result.snapshot?.error?.code).toBe('SETTLEMENT_FAILED');
  });

  it('defaults the budget to DEFAULT_WAIT_BUDGET_MS when the caller gives none', async () => {
    const time = fakeTime();
    const result = await waitForTerminalStatus({
      fetchStatus: async () => ({ status: 'pending' }),
      ...time,
    });
    // Proves the default is milliseconds. Passing the seconds constant by mistake would give up
    // after 60ms, i.e. a single poll.
    expect(result.timedOut).toBe(true);
    expect(time.elapsed()).toBe(DEFAULT_WAIT_BUDGET_MS);
    expect(DEFAULT_WAIT_BUDGET_MS).toBe(60_000);
  });

  it('stops when the signal is already aborted, without polling at all', async () => {
    const time = fakeTime();
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => {
        calls += 1;
        return { status: 'pending' };
      },
      signal: controller.signal,
      ...time,
    });
    expect(calls).toBe(0);
    expect(result.aborted).toBe(true);
    // An abort must never read as finished, or a caller branching on timedOut treats an
    // interrupted wait as a settled payment.
    expect(result.timedOut).toBe(true);
  });

  it('stops mid-wait when the signal fires, and keeps the last status it read', async () => {
    const time = fakeTime();
    const controller = new AbortController();
    let calls = 0;
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      fetchStatus: async () => {
        calls += 1;
        if (calls === 2) controller.abort();
        return { status: 'pending', payment_id: `0xpay${calls}` };
      },
      signal: controller.signal,
      ...time,
    });
    expect(calls).toBe(2);
    expect(result.aborted).toBe(true);
    expect(result.snapshot?.payment_id).toBe('0xpay2');
  });

  it('reports aborted false when the budget simply runs out', async () => {
    const time = fakeTime();
    const controller = new AbortController();
    const result = await waitForTerminalStatus({
      budgetMs: 10_000,
      fetchStatus: async () => ({ status: 'pending' }),
      signal: controller.signal,
      ...time,
    });
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });
});

/**
 * The cases above all inject `sleep`, which is documented as opting out of abort-aware sleeping —
 * so they only reach the `signal?.aborted` checks either side of the delay. These run the real
 * delay instead, which is where the signal actually does its work: waking the wait immediately
 * rather than sleeping out the interval, and taking its listener back off afterwards.
 *
 * They use the wall clock, so the assertions are "much sooner than" rather than exact. That is
 * enough: the failure they guard against is sleeping out a full interval, which is three orders of
 * magnitude away from the bound below.
 */
describe('waitForTerminalStatus with the real delay', () => {
  /** An AbortSignal that counts listener traffic, so a leak is visible. */
  function trackedSignal() {
    const controller = new AbortController();
    const added = jest.spyOn(controller.signal, 'addEventListener');
    const removed = jest.spyOn(controller.signal, 'removeEventListener');
    return { controller, added, removed };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('wakes as soon as the signal fires instead of sleeping out the interval', async () => {
    // A 30s interval inside a 60s budget: without abort-aware sleeping this cannot finish before
    // jest's own timeout, so a regression here fails loudly rather than merely slowly.
    const { controller, added } = trackedSignal();
    setTimeout(() => controller.abort(), 10);

    const startedAt = Date.now();
    const result = await waitForTerminalStatus({
      budgetMs: 60_000,
      intervalMs: 30_000,
      fetchStatus: async () => ({ status: 'pending' }),
      signal: controller.signal,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(true);
    // Never polled: the abort landed during the first sleep.
    expect(result.snapshot).toBeUndefined();
    expect(elapsed).toBeLessThan(1_000);
    // Proves the abort-aware branch ran rather than the plain-timer one. Whether the listener comes
    // back off is the next case's job: here `{ once: true }` takes care of it.
    expect(added).toHaveBeenCalledTimes(1);
  });

  it('removes its abort listener after every ordinary sleep, so a long wait does not leak them', async () => {
    // The listener is registered with `{ once: true }`, which covers the abort path on its own. This
    // is the other path: the timer fires, the signal never aborts, and the listener has to come off
    // explicitly. Without that, one listener accumulates per poll for the life of the signal.
    const { controller, added, removed } = trackedSignal();

    const result = await waitForTerminalStatus({
      // Budget fifty times the interval, so the "more than one sleep" assertion below still holds on
      // a loaded machine where every timer overruns many times over. The assertion that matters --
      // that each sleep removes its listener -- holds at any count; the margin is only there to keep
      // the "more than one" part from flaking.
      budgetMs: 500,
      intervalMs: 10,
      fetchStatus: async () => ({ status: 'pending' }),
      signal: controller.signal,
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    // Several polls happened, and every one cleaned up after itself.
    expect(added.mock.calls.length).toBeGreaterThan(1);
    expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
  });

  it('sleeps normally when no signal is given', async () => {
    // The no-signal branch returns a plain timer, and nothing else exercises it.
    const startedAt = Date.now();
    const result = await waitForTerminalStatus({
      budgetMs: 40,
      intervalMs: 10,
      fetchStatus: async () => ({ status: 'pending' }),
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    // It really waited rather than spinning: at least one interval elapsed.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10);
  });
});

/**
 * Moved here from `cli/payment-outcome.test.ts`, which used to re-export this function. The tests
 * follow the definition so the only import path to it is the one that owns it.
 */
describe('isTerminalStatus', () => {
  it.each(['completed', 'failed', 'refunded'])('%s is terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(true);
  });

  it.each([
    'pending',
    'finalizing',
    'refunding',
    'refund_available',
    undefined,
    '',
    'unheard-of',
    'COMPLETED',
  ])('%s is not terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(false);
  });
});
