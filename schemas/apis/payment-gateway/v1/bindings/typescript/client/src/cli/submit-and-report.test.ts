import { submitAndReport, type PaymentSubmitter } from './submit-and-report';
import {
  EXIT_COMPLETED,
  EXIT_FINALIZING,
  EXIT_PENDING,
  EXIT_REFUND_AVAILABLE,
  EXIT_TERMINAL_FAILURE,
} from './payment-outcome';
import type {
  PaymentRequest,
  PaymentResponse,
  GetPaymentStatusResponse,
  SubmitPaymentData,
} from '../generated';

/**
 * The submit-and-report path used to live inline in `send-payment`'s action handler, where nothing
 * could reach it: importing the entry point runs the CLI. These are the first tests of it, and they
 * matter more than their size suggests — this is the code that decides whether a script treats a
 * payment as paid.
 */

/** Only the fields this module reads. The rest of a PaymentRequest is irrelevant here. */
const REQUEST = { request_id: 'order-4711' } as unknown as PaymentRequest;

/** A client whose two calls are scripted, recording what it was asked. */
function fakeClient(script: {
  submit: PaymentResponse;
  statuses?: Array<GetPaymentStatusResponse | Error>;
}) {
  const statusCalls: string[] = [];
  const submitCalls: SubmitPaymentData[] = [];
  let next = 0;
  const client: PaymentSubmitter = {
    payments: {
      submitPayment: async (data) => {
        submitCalls.push(data);
        return script.submit;
      },
      getPaymentStatus: async ({ paymentId }) => {
        statusCalls.push(paymentId);
        const step = script.statuses?.[Math.min(next++, script.statuses.length - 1)];
        if (step instanceof Error) throw step;
        return (step ?? {}) as GetPaymentStatusResponse;
      },
    },
  };
  return { client, statusCalls, submitCalls };
}

/** Collects the two output streams separately, since which stream a line lands on is part of the contract. */
function sinks() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, writeOut: (l: string) => out.push(l), writeErr: (l: string) => err.push(l) };
}

const response = (over: Partial<PaymentResponse> = {}): PaymentResponse =>
  ({ payment_id: '0xpay', status: 'pending', ...over }) as PaymentResponse;

describe('submitAndReport', () => {
  it('prints the response to stdout and the summary to stderr', async () => {
    const { client } = fakeClient({ submit: response({ status: 'completed' }) });
    const s = sinks();

    const exitCode = await submitAndReport({ client, paymentRequest: REQUEST, ...s });

    expect(exitCode).toBe(EXIT_COMPLETED);
    // stdout carries JSON and nothing else, so `| jq` works.
    expect(JSON.parse(s.out.join('\n'))).toMatchObject({
      payment_id: '0xpay',
      status: 'completed',
    });
    expect(s.err.join('\n')).toContain('completed');
  });

  it('does not poll when --wait was not asked for', async () => {
    const { client, statusCalls } = fakeClient({ submit: response() });
    const s = sinks();

    const exitCode = await submitAndReport({ client, paymentRequest: REQUEST, ...s });

    expect(statusCalls).toEqual([]);
    expect(exitCode).toBe(EXIT_PENDING);
  });

  it('does not wait on a payment whose refund is already available', async () => {
    // Nothing changes until someone submits the refund, so waiting only burns the budget.
    const { client, statusCalls } = fakeClient({
      submit: response({ status: 'refund_available' }),
    });
    const s = sinks();

    const exitCode = await submitAndReport({ client, paymentRequest: REQUEST, wait: true, ...s });

    expect(statusCalls).toEqual([]);
    expect(exitCode).toBe(EXIT_REFUND_AVAILABLE);
  });

  it('does not poll when the submit already came back terminal', async () => {
    // Nothing to wait for, and asking anyway would be a wasted round trip on every settled payment.
    const { client, statusCalls } = fakeClient({ submit: response({ status: 'completed' }) });

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      ...sinks(),
    });

    expect(statusCalls).toEqual([]);
    expect(exitCode).toBe(EXIT_COMPLETED);
  });

  it('does not poll without a payment id, since there is nothing to ask about', async () => {
    const { client, statusCalls } = fakeClient({ submit: response({ payment_id: undefined }) });

    await submitAndReport({ client, paymentRequest: REQUEST, wait: true, ...sinks() });

    expect(statusCalls).toEqual([]);
  });

  it('waits for a terminal state and reports what the wait learned, not what the submit said', async () => {
    const { client, statusCalls } = fakeClient({
      submit: response({ status: 'pending' }),
      statuses: [{ status: 'completed', payment_id: '0xpay' } as GetPaymentStatusResponse],
    });
    const s = sinks();

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      waitSeconds: 5,
      // The polling loop itself is covered in payment-tracking.test.ts; these cases only need it to
      // turn over, so they poll fast rather than spending real seconds on the production interval.
      pollIntervalMs: 5,
      ...s,
    });

    expect(statusCalls).toEqual(['0xpay']);
    expect(exitCode).toBe(EXIT_COMPLETED);
    expect(JSON.parse(s.out.join('\n')).status).toBe('completed');
  });

  const PAYOUT = { transaction_hash: '0x' + 'ab'.repeat(32), chain_id: 'eip155:42220' };

  it('stops waiting at finalizing by default, with exit code 4', async () => {
    const { client, statusCalls } = fakeClient({
      submit: response({ status: 'pending' }),
      statuses: [
        { status: 'finalizing', transactions: { fulfillment: PAYOUT } } as GetPaymentStatusResponse,
        { status: 'completed' } as GetPaymentStatusResponse,
      ],
    });
    const s = sinks();

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      waitSeconds: 5,
      pollIntervalMs: 5,
      ...s,
    });

    expect(statusCalls).toHaveLength(1);
    expect(exitCode).toBe(EXIT_FINALIZING);
    expect(s.err.join('\n')).toContain(PAYOUT.transaction_hash);
  });

  it("with waitFor 'completed', keeps waiting through finalizing", async () => {
    const { client, statusCalls } = fakeClient({
      submit: response({ status: 'pending' }),
      statuses: [
        { status: 'finalizing' } as GetPaymentStatusResponse,
        { status: 'completed' } as GetPaymentStatusResponse,
      ],
    });

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      waitFor: 'completed',
      waitSeconds: 5,
      pollIntervalMs: 5,
      ...sinks(),
    });

    expect(statusCalls).toHaveLength(2);
    expect(exitCode).toBe(EXIT_COMPLETED);
  });

  it('does not poll when the submit already came back finalizing', async () => {
    const { client, statusCalls } = fakeClient({ submit: response({ status: 'finalizing' }) });

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      ...sinks(),
    });

    expect(statusCalls).toEqual([]);
    expect(exitCode).toBe(EXIT_FINALIZING);
  });

  it('keeps submit-only fields the status endpoint never returns', async () => {
    // idempotent_replay describes THIS request, not the payment, so the status response cannot
    // carry it. Replacing rather than merging would drop "you were handed an existing payment".
    const { client } = fakeClient({
      submit: response({ status: 'pending', idempotent_replay: true }),
      statuses: [{ status: 'completed' } as GetPaymentStatusResponse],
    });
    const s = sinks();

    await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      waitSeconds: 5,
      pollIntervalMs: 5,
      ...s,
    });

    const printed = JSON.parse(s.out.join('\n'));
    expect(printed.idempotent_replay).toBe(true);
    expect(printed.status).toBe('completed');
    expect(s.err.join('\n')).toContain('nothing additional was charged');
  });

  it('reports a payment that never settles as pending, saying it gave up', async () => {
    const { client } = fakeClient({
      submit: response(),
      statuses: [{ status: 'pending' } as GetPaymentStatusResponse],
    });
    const s = sinks();

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      // A budget under one interval: it gives up having learned nothing new.
      waitSeconds: 0.05,
      pollIntervalMs: 5,
      ...s,
    });

    expect(exitCode).toBe(EXIT_PENDING);
    expect(s.err.join('\n')).toContain('gave up waiting for finalizing after');
  });

  it('stops the wait on refund_available and tells the payer to submit the refund', async () => {
    const { client, statusCalls } = fakeClient({
      submit: response(),
      statuses: [
        { status: 'refund_available' } as GetPaymentStatusResponse,
        { status: 'completed' } as GetPaymentStatusResponse,
      ],
    });
    const s = sinks();

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      waitSeconds: 0.05,
      pollIntervalMs: 5,
      ...s,
    });

    // The refund is waiting on the payer, so the wait ends at the first refund_available.
    expect(statusCalls).toHaveLength(1);
    expect(exitCode).toBe(EXIT_REFUND_AVAILABLE);
    expect(s.err.join('\n')).toContain('submit it to the source escrow');
    expect(s.err.join('\n')).not.toContain('gave up waiting');
  });

  it('keeps waiting through a failed status check rather than giving up mid-settlement', async () => {
    const { client } = fakeClient({
      submit: response(),
      statuses: [new Error('socket hang up'), { status: 'completed' } as GetPaymentStatusResponse],
    });
    const s = sinks();

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      wait: true,
      waitSeconds: 5,
      pollIntervalMs: 5,
      ...s,
    });

    expect(exitCode).toBe(EXIT_COMPLETED);
    expect(s.err.join('\n')).toContain('status check failed, still waiting: socket hang up');
  });

  it('carries the request id into the summary, so a retry can reuse it', async () => {
    const { client } = fakeClient({ submit: response({ status: 'failed' }) });
    const s = sinks();

    const exitCode = await submitAndReport({
      client,
      paymentRequest: REQUEST,
      requestId: 'order-4711',
      ...s,
    });

    expect(exitCode).toBe(EXIT_TERMINAL_FAILURE);
    expect(s.err.join('\n')).toContain('order-4711');
  });

  it('surfaces the gateway failure code in the summary', async () => {
    const { client } = fakeClient({
      submit: response({
        status: 'failed',
        error: { code: 'SETTLEMENT_FAILED' },
      } as Partial<PaymentResponse>),
    });
    const s = sinks();

    await submitAndReport({ client, paymentRequest: REQUEST, ...s });

    expect(s.err.join('\n')).toContain('SETTLEMENT_FAILED');
  });

  it('submits the request it was given, unchanged', async () => {
    // --submit hands over a document built elsewhere; rewriting any part of it would
    // invalidate the signature.
    let submitted: SubmitPaymentData['requestBody'] | undefined;
    const client: PaymentSubmitter = {
      payments: {
        submitPayment: async ({ requestBody }) => {
          submitted = requestBody;
          return response({ status: 'completed' });
        },
        getPaymentStatus: async () => ({}) as GetPaymentStatusResponse,
      },
    };

    await submitAndReport({ client, paymentRequest: REQUEST, ...sinks() });

    expect(submitted).toBe(REQUEST);
  });

  it('passes auto-accept beside the request, never inside it', async () => {
    const { client, submitCalls } = fakeClient({ submit: response({ status: 'completed' }) });

    await submitAndReport({ client, paymentRequest: REQUEST, autoAccept: true, ...sinks() });

    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0].autoAccept).toBe(true);
    expect(submitCalls[0].requestBody).toBe(REQUEST);
    expect(submitCalls[0].requestBody).not.toHaveProperty('auto_accept');
  });
});
