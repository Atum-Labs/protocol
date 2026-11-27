import {
  describePaymentOutcome,
  EXIT_COMPLETED,
  EXIT_FINALIZING,
  EXIT_PENDING,
  EXIT_REFUND_AVAILABLE,
  EXIT_TERMINAL_FAILURE,
} from './payment-outcome';

describe('describePaymentOutcome', () => {
  const base = { paymentId: '0xpay', requestId: 'order-4711' };

  it('reports a settled payment as success', () => {
    const { exitCode, summary } = describePaymentOutcome({ ...base, status: 'completed' });
    expect(exitCode).toBe(EXIT_COMPLETED);
    expect(summary).toContain('completed');
    expect(summary).toContain('0xpay');
  });

  it('reports a still-settling payment as pending, not success', () => {
    // The distinction that matters: exit 0 here would tell `send-payment && ship` to ship the
    // goods against a payment that has not landed.
    const { exitCode, summary } = describePaymentOutcome({ ...base, status: 'pending' });
    expect(exitCode).toBe(EXIT_PENDING);
    expect(exitCode).not.toBe(EXIT_COMPLETED);
    expect(summary).toContain('still settling');
  });

  it('reports a finalizing payment with its own exit code and its payout transaction', () => {
    // Paid on chain, not yet final: never 0, which a script reads as final, and never 2, which
    // says nothing has been paid yet.
    const { exitCode, summary } = describePaymentOutcome({
      ...base,
      status: 'finalizing',
      payoutTransaction: '0xpayout',
    });
    expect(exitCode).toBe(EXIT_FINALIZING);
    expect(exitCode).not.toBe(EXIT_COMPLETED);
    expect(exitCode).not.toBe(EXIT_PENDING);
    expect(summary).toContain('0xpayout');
    expect(summary).toContain('not yet final');
    // It can still fail, so the summary never promises completion, and paying again is the
    // mistake to warn against at exactly this point.
    expect(summary).toContain('normally becomes completed');
    expect(summary).not.toMatch(/on its own/);
    expect(summary).toMatch(/do not start a new payment/i);
    expect(summary).toContain('order-4711');
  });

  it('tells a pending caller to reuse the same request id, and not to start a new payment', () => {
    const { summary } = describePaymentOutcome({ ...base, status: 'pending' });
    expect(summary).toContain('order-4711');
    expect(summary).toMatch(/do not start a new payment/i);
  });

  it('offers checking the status before re-submitting, since re-submitting resends a payment', () => {
    const { summary } = describePaymentOutcome({ ...base, status: 'pending' });
    expect(summary.indexOf('checking its status')).toBeGreaterThan(-1);
    expect(summary.indexOf('checking its status')).toBeLessThan(summary.indexOf('re-submit'));
  });

  it.each(['failed', 'refunded'])('reports %s as a distinct terminal failure', (status) => {
    const { exitCode, summary } = describePaymentOutcome({ ...base, status });
    expect(exitCode).toBe(EXIT_TERMINAL_FAILURE);
    expect(exitCode).not.toBe(EXIT_PENDING);
    expect(summary).toContain(status);
  });

  it('tells a terminally-failed caller that a fresh attempt needs a NEW request id', () => {
    // The inverse instruction to the pending case. Getting these two the wrong way round is how a
    // caller either double-pays or waits forever, so both are pinned.
    const { summary } = describePaymentOutcome({ ...base, status: 'failed' });
    expect(summary).toMatch(/NEW request id/);
    expect(summary).toContain('order-4711');
  });

  it('tells a refunded caller the payment is final and needs a NEW request id', () => {
    const { summary } = describePaymentOutcome({ ...base, status: 'refunded' });
    expect(summary).toMatch(/NEW request id/);
    expect(summary).not.toMatch(/still settling/);
  });

  it('gives refund_available its own exit code and points at the refund signature', () => {
    // The funds are still in escrow and a late delivery can still complete it, so a script must
    // not read this as a failure and pay again under a new request id.
    const { exitCode, summary } = describePaymentOutcome({ ...base, status: 'refund_available' });
    expect(exitCode).toBe(EXIT_REFUND_AVAILABLE);
    expect(new Set([EXIT_TERMINAL_FAILURE, EXIT_PENDING]).has(exitCode)).toBe(false);
    expect(summary).toContain('refund_signature');
    expect(summary).toMatch(/Do not pay again/);
  });

  it('includes the recorded failure code when there is one', () => {
    const { summary } = describePaymentOutcome({
      ...base,
      status: 'failed',
      errorCode: 'SETTLEMENT_FAILED',
    });
    expect(summary).toContain('SETTLEMENT_FAILED');
  });

  it('treats an absent status as pending, never as failed', () => {
    // Of the two ways to be wrong about a live payment, calling it failed is the unsafe one: it
    // invites paying again.
    const { exitCode } = describePaymentOutcome(base);
    expect(exitCode).toBe(EXIT_PENDING);
  });

  it('treats an unrecognized status as pending', () => {
    const { exitCode } = describePaymentOutcome({ ...base, status: 'reticulating' });
    expect(exitCode).toBe(EXIT_PENDING);
  });

  it('says when the response was a replay of a payment that already existed', () => {
    const { summary } = describePaymentOutcome({
      ...base,
      status: 'completed',
      idempotentReplay: true,
    });
    expect(summary).toMatch(/nothing additional was charged/i);
  });

  it('does not claim a replay when the payment was newly created', () => {
    const { summary } = describePaymentOutcome({
      ...base,
      status: 'completed',
      idempotentReplay: false,
    });
    expect(summary).not.toMatch(/nothing additional was charged/i);
  });

  it('stays readable with no payment id and no request id', () => {
    // Both fields are optional on the wire, so the summary must not render "payment undefined".
    const { summary } = describePaymentOutcome({ status: 'pending' });
    expect(summary).not.toContain('undefined');
    expect(summary).toContain('re-submit the same request id');
  });

  it('never suggests a specific command, so one line serves every caller', () => {
    // payment-status prints this too; telling its user to run payment-status would be nonsense.
    for (const status of ['completed', 'pending', 'failed']) {
      expect(describePaymentOutcome({ ...base, status }).summary).not.toContain('payment-status');
    }
  });

  it('gives the three endings three different exit codes', () => {
    const codes = ['completed', 'pending', 'failed'].map(
      (status) => describePaymentOutcome({ ...base, status }).exitCode,
    );
    expect(new Set(codes).size).toBe(3);
  });
});
