/**
 * How the CLIs report a payment's outcome: an exit code a script can branch on, and a one-line
 * summary saying what to do next.
 *
 * A submitted payment has genuinely different endings, and collapsing them loses money in both
 * directions. Reporting a still-settling payment as success releases goods against a payment
 * that has not landed; reporting it as failure invites a second payment for the same thing. So each
 * ending gets its own exit code, and the summary spells out the one action that is safe.
 *
 * Kept separate from the commands themselves so the mapping can be tested directly.
 */

/** Settled and final. Safe to act on. */
export const EXIT_COMPLETED = 0;

/**
 * No outcome was obtained — the request was rejected, the gateway was unreachable, or the arguments
 * were wrong.
 *
 * This does **not** mean no payment exists. A request that timed out or lost its connection may
 * still have been accepted, so treat this as "unknown", not "nothing happened", and recover the
 * same way as a pending payment: re-submit under the same idempotency key, which resolves to the
 * payment if one was created and creates it if not.
 */
export const EXIT_ERROR = 1;

/**
 * Accepted and still settling. The payment is real and may already be moving funds; it simply has
 * no result yet.
 */
export const EXIT_PENDING = 2;

/** Reached a terminal state without settling. This payment can never complete. */
export const EXIT_TERMINAL_FAILURE = 3;

/**
 * Not delivered, and the refund is authorized but not submitted. The funds are still in escrow:
 * submit the refund signature, and do not pay again under a new request id.
 */
export const EXIT_REFUND_AVAILABLE = 4;

/**
 * Paid on chain, not yet final. It normally becomes `completed`; acting on it before then is
 * accepting the risk that a chain reorganization drops it.
 */
export const EXIT_FINALIZING = 5;

/** What the CLI should print and exit with for one payment. */
export interface PaymentOutcome {
  /** Process exit code — see the EXIT_* constants. */
  exitCode: number;
  /** One-line human summary, written to stderr. */
  summary: string;
}

/** Inputs the summary is built from. Everything is optional, as the gateway's fields are. */
export interface PaymentOutcomeInput {
  /** The payment's status as reported by the gateway. */
  status?: string;
  /** The gateway's payment id, quoted so the reader can check on it later. */
  paymentId?: string;
  /** The idempotency key this payment is filed under, quoted so a retry can reuse it. */
  requestId?: string;
  /**
   * Whether the response described a payment that already existed rather than one this request
   * created. Worth saying out loud: it is the difference between "you just paid" and "you were
   * handed the payment you made earlier".
   */
  idempotentReplay?: boolean;
  /** The failure code the gateway recorded, when it recorded one. */
  errorCode?: string;
  /** The payout transaction hash, from `transactions.fulfillment`, when the gateway reported it. */
  payoutTransaction?: string;
}

/**
 * Map a payment's reported state onto an exit code and a summary.
 *
 * An unrecognized or absent status is treated as still settling. That is deliberate and not
 * merely defensive: of the two ways to be wrong about a live payment, calling it failed is the
 * one with no safe recovery, because it invites paying again.
 *
 * @param input - the fields the gateway returned for this payment
 * @returns the exit code to use and the line to print
 */
export function describePaymentOutcome(input: PaymentOutcomeInput): PaymentOutcome {
  const { status, paymentId, requestId, idempotentReplay, errorCode, payoutTransaction } = input;
  const payment = paymentId ? `payment ${paymentId}` : 'the payment';
  const replay = idempotentReplay
    ? ' This is the payment your earlier attempt created — nothing additional was charged.'
    : '';

  if (status === 'completed') {
    return {
      exitCode: EXIT_COMPLETED,
      summary: `completed: ${payment} settled.${replay}`,
    };
  }

  if (status === 'finalizing') {
    const tx = payoutTransaction ? ` (transaction ${payoutTransaction})` : '';
    const resubmit = requestId ? `request id ${requestId}` : 'the same request id';
    return {
      exitCode: EXIT_FINALIZING,
      summary:
        `finalizing: ${payment} is paid on chain${tx} but not yet final.${replay} It normally ` +
        `becomes completed; keep checking its status, or re-submit ${resubmit}. Do not start a ` +
        `new payment under a different request id — that would pay twice.`,
    };
  }

  if (status === 'failed') {
    const reason = errorCode ? ` (${errorCode})` : '';
    return {
      exitCode: EXIT_TERMINAL_FAILURE,
      summary:
        `${status}: ${payment} ended without settling${reason}. This is final — re-submitting ` +
        `${requestId ? `request id ${requestId}` : 'the same request id'} returns this same ` +
        `failed payment, so a fresh attempt needs a NEW request id.`,
    };
  }

  if (status === 'refunded') {
    return {
      exitCode: EXIT_TERMINAL_FAILURE,
      summary:
        `${status}: ${payment} was not delivered and your funds were returned from escrow. This ` +
        `is final — re-submitting ${requestId ? `request id ${requestId}` : 'the same request id'} ` +
        `returns this same payment, so a fresh attempt needs a NEW request id.`,
    };
  }

  if (status === 'refund_available') {
    return {
      exitCode: EXIT_REFUND_AVAILABLE,
      summary:
        `${status}: ${payment} was not delivered and its funds are still in escrow. Read ` +
        `refund_signature from its status and submit it to the source escrow to return them. Do ` +
        `not pay again under a different request id until it is refunded — a late delivery can ` +
        `still complete it.`,
    };
  }

  // Anything else, including an absent status: still in flight.
  //
  // Checking the payment's status comes first because it is the direct way to watch a payment you
  // already hold an id for. Re-submitting also returns the current state, but it rebuilds and
  // re-sends a whole payment to do it, so it belongs second — it earns its place when the id is all
  // that is left, for instance after a request whose response never arrived.
  //
  // The wording stays generic about *where* to look, so the same line reads correctly whether it
  // comes from the command that submitted the payment or one that only inspected it.
  const resubmit = requestId ? `request id ${requestId}` : 'the same request id';
  return {
    exitCode: EXIT_PENDING,
    summary:
      `pending: ${payment} was accepted and is still settling.${replay} To collect the result, keep ` +
      `checking its status, or re-submit ${resubmit}. Do not start a new payment under a different ` +
      `request id — that would pay twice.`,
  };
}
