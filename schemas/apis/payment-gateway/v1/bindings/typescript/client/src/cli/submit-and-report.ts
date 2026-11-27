/**
 * Submitting a prepared payment and reporting what became of it.
 *
 * `send-payment` reaches this by two routes: having just built and signed the request, or having
 * been handed one built earlier through `--submit`. Everything from the POST onwards is identical
 * between them — the optional wait, what goes on which stream, and the mapping from the payment's
 * state onto an exit code — and that part is exactly where a divergence would be expensive, because
 * it decides whether a script treats a payment as paid.
 *
 * The process is not exited here. This returns the code and lets the entry point exit, which keeps
 * process control at the entry point and makes the whole path testable in-process.
 */

import type {
  PaymentRequest,
  PaymentResponse,
  GetPaymentStatusData,
  GetPaymentStatusResponse,
  SubmitPaymentData,
} from '../generated';
import { waitForStatus, hasReached, DEFAULT_WAIT_SECONDS } from '../payment-tracking';
import { describePaymentOutcome, type PaymentOutcomeInput } from './payment-outcome';

/**
 * The slice of {@link PaymentGatewayClient} this needs. Narrowed to two calls so a test can pass a
 * stub without standing up a client or a server.
 */
export interface PaymentSubmitter extends PaymentStatusReader {
  payments: PaymentStatusReader['payments'] & {
    submitPayment(data: SubmitPaymentData): Promise<PaymentResponse>;
  };
}

/** The slice of {@link PaymentGatewayClient} that {@link reportPayment} needs. */
export interface PaymentStatusReader {
  payments: {
    getPaymentStatus(data: GetPaymentStatusData): Promise<GetPaymentStatusResponse>;
  };
}

export interface SubmitAndReportParams extends Omit<ReportPaymentParams, 'client' | 'response'> {
  client: PaymentSubmitter;
  /** The signed request to submit. */
  paymentRequest: PaymentRequest;
  /** Ask the gateway to award the first valid quote at or under max_source_amount; not signed. */
  autoAccept?: boolean;
}

export interface ReportPaymentParams {
  client: PaymentStatusReader;
  /** What the gateway answered to the request that created or replayed the payment. */
  response: PaymentResponse;
  /** The idempotency key this payment is filed under, quoted in the summary so a retry can reuse it. */
  requestId?: string;
  /** Keep checking after the submit until the payment reaches {@link waitFor}. */
  wait?: boolean;
  /**
   * What {@link wait} waits for: `finalizing` (default), the payout on chain, or `completed`, the
   * payout final, which takes minutes on some chains. `failed`, `refunded` and `refund_available`
   * end the wait either way.
   */
  waitFor?: 'finalizing' | 'completed';
  /** How long {@link wait} keeps checking; defaults to {@link DEFAULT_WAIT_SECONDS}. */
  waitSeconds?: number;
  /**
   * Gap between status checks, in milliseconds. Defaults to the tracking module's own interval,
   * which is tuned for a person watching a terminal; the commands do not override it.
   */
  pollIntervalMs?: number;
  /** Machine-readable output. Defaults to stdout, which is what a caller pipes into `jq`. */
  writeOut?: (line: string) => void;
  /** Human-facing progress and the closing summary. Defaults to stderr, so it never pollutes a pipe. */
  writeErr?: (line: string) => void;
}

/**
 * Submit a signed payment request, optionally wait for it to settle, print the result, and return
 * the exit code the command should end with.
 *
 * @param params - the client, the signed request, and how long to wait
 * @returns the process exit code — see the `EXIT_*` constants in `payment-outcome`
 */
export async function submitAndReport(params: SubmitAndReportParams): Promise<number> {
  const { client, paymentRequest, autoAccept, ...report } = params;
  const response = await client.payments.submitPayment({ requestBody: paymentRequest, autoAccept });
  return reportPayment({ ...report, client, response });
}

/**
 * Optionally wait for a payment the gateway has accepted to settle, print it, and return the exit
 * code the command should end with. Shared by every command that creates a payment, so they all
 * map a payment's state onto the same exit codes.
 *
 * @param params - the client, the gateway's answer, and how long to wait
 * @returns the process exit code — see the `EXIT_*` constants in `payment-outcome`
 */
export async function reportPayment(params: ReportPaymentParams): Promise<number> {
  const {
    client,
    response,
    requestId,
    wait = false,
    waitFor = 'finalizing',
    waitSeconds = DEFAULT_WAIT_SECONDS,
    pollIntervalMs,
    writeOut = (line: string) => console.log(line),
    writeErr = (line: string) => console.error(line),
  } = params;

  // The payment as reported by the submit call. --wait may learn a later state below, and whatever
  // is known by the end is what gets printed — a caller that asked to wait should not be handed a
  // `status` the wait has already superseded.
  let reported = response;

  // --wait: keep checking until the payment reaches what was asked for. Skipped once it already
  // has, and skipped without a payment id, since there would be nothing to ask about.
  if (wait && response.payment_id && !hasReached(response.status, waitFor)) {
    writeErr(`waiting up to ${waitSeconds}s for ${response.payment_id} to reach ${waitFor}...`);
    const paymentId = response.payment_id;
    const waited = await waitForStatus({
      waitFor,
      budgetMs: waitSeconds * 1000,
      intervalMs: pollIntervalMs,
      fetchStatus: () => client.payments.getPaymentStatus({ paymentId }),
      // A blip mid-settlement is the worst moment to give up, so report and keep checking.
      onError: (err) =>
        writeErr(
          `status check failed, still waiting: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });
    if (waited.snapshot) {
      // Merge rather than replace: the status endpoint reports the payment, while fields such
      // as idempotent_replay describe this request and are only available from the submit.
      reported = { ...reported, ...waited.snapshot };
    }
    if (waited.timedOut) {
      writeErr(
        `gave up waiting for ${waitFor} after ${waitSeconds}s — reporting its current state.`,
      );
    }
  }

  writeOut(JSON.stringify(reported, null, 2));

  const outcome: PaymentOutcomeInput = {
    status: reported.status,
    paymentId: reported.payment_id,
    requestId,
    idempotentReplay: reported.idempotent_replay,
    // Present when the gateway has recorded a reason — which includes the case where this
    // submission was deduplicated onto a payment that had already failed.
    errorCode: reported.error?.code,
    payoutTransaction: reported.transactions?.fulfillment?.transaction_hash,
  };
  const { exitCode, summary } = describePaymentOutcome(outcome);
  writeErr(summary);
  return exitCode;
}
