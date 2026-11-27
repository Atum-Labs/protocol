/*
 * Copyright 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Settlement outcomes that are not a receipt.
 *
 * MPP models a completed payment and nothing else: a receipt's status is the literal
 * `"success"`, so a payment that has not settled cannot be expressed as one and has to leave
 * `verify()` as a throw. What matters is that the two non-success outcomes stay
 * distinguishable, because they call for opposite responses:
 *
 * - {@link SettlementPendingError} — the payment is still settling. Retrying the SAME purchase
 *   is safe and is how the payer collects the result: the identifier it derives from resolves to
 *   this same payment, so the gateway returns the original rather than charging again.
 * - {@link SettlementFailedError} — the payment reached a terminal failure. Retrying the same
 *   purchase resolves to the dead payment forever, so recovering means starting a NEW purchase
 *   under a new identifier.
 *
 * Both carry the gateway's payment id when one was issued, so a merchant can reconcile the
 * attempt against the gateway without parsing a message.
 *
 * Both extend the framework's error types, so a merchant that does not distinguish them still
 * gets the standard `402` + problem-details response.
 *
 * Two more errors are refusals: the gateway did not take the payment, so nothing was charged and
 * nothing is in flight. They too call for different responses:
 *
 * - {@link PaymentRejectedError} — the request itself is at fault, and fixing it makes the same
 *   purchase payable.
 * - {@link PaymentRetryableError} — the gateway could not take the payment this time. The same
 *   purchase, re-attempted shortly and unchanged, can go through.
 *
 * {@link gatewayRefusalOf} tells them apart for an error the gateway answered with.
 *
 * @packageDocumentation
 */

import { Errors } from 'mppx';

/** Fields shared by both settlement outcomes. */
export interface SettlementErrorDetails {
  /** The gateway's payment id, when the payment was accepted and given one. */
  readonly paymentId: string | undefined;
}

/**
 * Each class carries a literal marker property, and the guards below test that rather than
 * `instanceof`. The framework's base classes pin their own `name`, so the subclass name is not
 * available to discriminate on, and a bundler that ends up with two copies of this module would
 * break `instanceof` while a property check keeps working.
 */
function hasMarker(err: unknown, marker: string): boolean {
  return (
    typeof err === 'object' && err !== null && (err as Record<string, unknown>)[marker] === true
  );
}

/** True if the payment is still settling — a retry of the same purchase is safe. */
export function isSettlementPending(err: unknown): err is SettlementPendingError {
  return hasMarker(err, 'isSettlementPending');
}

/** True if the payment reached a terminal failure — the same purchase can never settle. */
export function isSettlementFailed(err: unknown): err is SettlementFailedError {
  return hasMarker(err, 'isSettlementFailed');
}

/** True if the gateway refused the request outright — nothing was charged. */
export function isPaymentRejected(err: unknown): err is PaymentRejectedError {
  return hasMarker(err, 'isPaymentRejected');
}

/**
 * True if the gateway could not take the payment this time — nothing was charged, and the same
 * purchase can be re-attempted shortly.
 */
export function isPaymentRetryable(err: unknown): err is PaymentRetryableError {
  return hasMarker(err, 'isPaymentRetryable');
}

/**
 * The payment was accepted but had not settled when the merchant's synchronous window closed.
 *
 * Not a failure: the payment is in flight. Re-attempting the same purchase is safe — it resolves to
 * this payment and returns its result once settled.
 *
 * **What re-attempting means.** Run the purchase again: request a fresh challenge and sign it again,
 * keeping the same intent id. The intent id is what makes the re-attempt resolve onto the payment
 * already in flight rather than taking a second one, so it must not change — while everything
 * time-bound about the authorization must, because the deadlines are absolute timestamps fixed when
 * it was signed. A stored credential therefore cannot simply be presented a second time; once its
 * quote window has closed it is refused, and on Solana the deposit authorization carries its own
 * replay window that expires with it.
 *
 * A payment-enabled `fetch` does this for the caller, since each attempt fetches a new challenge.
 * Code that drives the client directly has to rebuild.
 */
export class SettlementPendingError
  extends Errors.PaymentActionRequiredError
  implements SettlementErrorDetails
{
  /** Discriminant; test it with {@link isSettlementPending}. */
  readonly isSettlementPending = true as const;
  readonly paymentId: string | undefined;
  /** The state the gateway reported, when it reported one. */
  readonly state: string | undefined;

  /**
   * @param options.detail Why no receipt could be issued, when the reason is more specific than
   *   the payment still being in flight. Appended to the message as given.
   */
  constructor(
    options: {
      paymentId?: string | undefined;
      state?: string | undefined;
      detail?: string | undefined;
    } = {},
  ) {
    super({
      reason:
        'the payment is still settling' +
        (options.paymentId ? ` (payment ${options.paymentId})` : '') +
        (options.detail ? `. ${options.detail}` : '') +
        '; re-attempt the purchase to collect the result — request a fresh challenge and sign it ' +
        'again, keeping the SAME intent id, and it resolves onto this payment rather than charging ' +
        'again. Do not re-present the credential already signed: its deadlines are fixed' +
        (options.state === 'refund_available'
          ? '. It was not delivered and its deposit is still in escrow: read refund_signature from ' +
            "the payment's status and submit it to the source escrow to return the funds"
          : ''),
    });
    this.paymentId = options.paymentId;
    this.state = options.state;
  }

  /**
   * Adds `paymentId` as its own field, not just interpolated into `detail`'s prose. A merchant
   * catching this in-process already has `.paymentId`; a real cross-network payer only ever
   * sees this JSON body, and without a dedicated field would have to parse it out of a sentence
   * to reconcile the attempt against the gateway. The return type is declared (not left to
   * inference) so a TypeScript merchant that re-serializes through the base type still sees
   * `paymentId` in intellisense.
   */
  override toProblemDetails(
    challengeId?: string,
  ): Errors.PaymentError.ProblemDetails & { paymentId?: string; state?: string } {
    return {
      ...super.toProblemDetails(challengeId),
      ...(this.paymentId !== undefined ? { paymentId: this.paymentId } : {}),
      ...(this.state !== undefined ? { state: this.state } : {}),
    };
  }
}

/**
 * The payment reached a terminal failure state and will not settle.
 *
 * A retry of the same purchase cannot recover it: that purchase's identifier now resolves to
 * this failed payment. Recovering means a new purchase under a new identifier.
 */
export class SettlementFailedError
  extends Errors.VerificationFailedError
  implements SettlementErrorDetails
{
  /** Discriminant; test it with {@link isSettlementFailed}. */
  readonly isSettlementFailed = true as const;
  readonly paymentId: string | undefined;
  /** The terminal state the gateway reported. */
  readonly state: string;

  constructor(options: { paymentId?: string | undefined; state: string }) {
    super({
      reason:
        `the payment ${options.state}` +
        (options.paymentId ? ` (payment ${options.paymentId})` : '') +
        '; retrying this purchase resolves to the same payment, so recovering requires a ' +
        'new purchase under a new identifier',
    });
    this.paymentId = options.paymentId;
    this.state = options.state;
  }

  /**
   * Adds `paymentId` and `state` as their own fields, not just interpolated into `detail`'s
   * prose — see {@link SettlementPendingError.toProblemDetails} for why a payer needs this on
   * the wire, not only a same-process merchant. Return type declared for the same reason: so a
   * TypeScript merchant sees `paymentId`/`state` in intellisense, not only at runtime.
   */
  override toProblemDetails(
    challengeId?: string,
  ): Errors.PaymentError.ProblemDetails & { paymentId?: string; state: string } {
    return {
      ...super.toProblemDetails(challengeId),
      ...(this.paymentId !== undefined ? { paymentId: this.paymentId } : {}),
      state: this.state,
    };
  }
}

/**
 * The gateway refused the payment outright — it never entered settlement.
 *
 * Distinct from {@link SettlementFailedError}: nothing was charged and nothing is in flight, so
 * the fault is in the request and fixing it makes the same purchase payable. The most common
 * cause is reusing one purchase identifier for two different sets of terms, which the gateway
 * rejects rather than silently resolving to the first payment.
 *
 * Distinct from {@link PaymentRetryableError} too: when the gateway classifies its refusal as
 * transient and leaves the purchase identifier unused, nothing about the request has to change,
 * so that refusal is a `PaymentRetryableError` and not this one.
 *
 * Thrown by a {@link ../server!PaymentSubmitter | PaymentSubmitter} — the submitter owns the
 * gateway call, so it is the only place that can tell a refusal (the request was rejected) from
 * a transport or server failure (the outcome is unknown, and reporting it as a refusal would
 * invite a second payment). {@link gatewayRefusalOf} says which answers are this refusal. Raising
 * it preserves the gateway's error code through to the payer instead of flattening every cause
 * into one generic verification failure.
 */
export class PaymentRejectedError extends Errors.BadRequestError {
  /** Discriminant; test it with {@link isPaymentRejected}. */
  readonly isPaymentRejected = true as const;
  /** The gateway's error code, for programmatic handling. */
  readonly code: string;

  constructor(options: { code: string; detail: string }) {
    super({ reason: `${options.detail} (${options.code})` });
    this.code = options.code;
  }
}

/**
 * The gateway could not take the payment this time. Nothing was charged and nothing is in
 * flight, and the same purchase, re-attempted shortly, can go through without any change.
 *
 * The gateway answers this way when its error is classified `RETRY_AFTER_DELAY` with
 * `request_id_reusable: true`: the condition is transient and the purchase identifier is still
 * unused. The most common case is `503 AUTHORIZATION_UNAVAILABLE`, a check on the payment that
 * could not be completed this time, which is not a decline. {@link gatewayRefusalOf} says which
 * answers are this one.
 *
 * Re-attempting means what it means for {@link SettlementPendingError}: request a fresh challenge
 * and sign it again, keeping the same intent id, a moment later. A payment-enabled `fetch` does
 * this on its own, but at once and a fixed number of times; a payer that drives its own retries
 * should wait between them.
 *
 * Thrown by a {@link ../server!PaymentSubmitter | PaymentSubmitter};
 * {@link gatewayRefusalOf} returns it for such an answer. It extends the framework's
 * `PaymentActionRequiredError`, the error a payment still settling uses too, because the payer's
 * next step is the same: the payer receives a `402` with a fresh challenge and the
 * `payment-action-required` problem type, and tells this answer apart by its `code` field.
 */
export class PaymentRetryableError extends Errors.PaymentActionRequiredError {
  /** Discriminant; test it with {@link isPaymentRetryable}. */
  readonly isPaymentRetryable = true as const;
  /** The gateway's error code, for programmatic handling. */
  readonly code: string;

  constructor(options: { code: string; detail: string }) {
    super({
      reason:
        `${options.detail} (${options.code}); nothing was charged. Re-attempt the same purchase ` +
        'in a moment: request a fresh challenge and sign it again, keeping the SAME intent id',
    });
    this.code = options.code;
  }

  /**
   * Adds `code` as its own field, not just interpolated into `detail`'s prose. A payment still
   * settling shares this problem type, and a payer that only sees this JSON body tells the two
   * apart by `code` without parsing a sentence. Return type declared for the same reason as
   * {@link SettlementPendingError.toProblemDetails}.
   */
  override toProblemDetails(
    challengeId?: string,
  ): Errors.PaymentError.ProblemDetails & { code: string } {
    return { ...super.toProblemDetails(challengeId), code: this.code };
  }
}

/**
 * The refusal a {@link ../server!PaymentSubmitter | PaymentSubmitter} throws for an error the
 * gateway answered with, or `undefined` when the answer does not show the payment was refused.
 *
 * Pass what the gateway client threw — the error `@atumlabs/payment-gateway-client` throws for a
 * non-2xx answer carries its `status` and parsed `body` — or `{ status, body }` from your own
 * HTTP call. It returns:
 *
 * - {@link PaymentRetryableError} when the gateway's error is classified `RETRY_AFTER_DELAY` with
 *   `request_id_reusable: true`, at any status but `429`, such as `503 AUTHORIZATION_UNAVAILABLE`;
 * - {@link PaymentRejectedError} for any other `4xx`. That includes a `429`, which a
 *   payment-enabled `fetch` would otherwise re-attempt at once, and a `4xx` whose body is not the
 *   gateway's error, such as an HTML 403 or 429 page from a proxy in front of the gateway, whose
 *   code is then built from its status (`HTTP_429`);
 * - `undefined` for anything else: an error that names a `payment_id`, which comes from after the
 *   payment was created, or that is classified `RECONCILE_THEN_DECIDE`, such as `409 CONFLICT`,
 *   since only the payment's own state can say whether anything was charged; a `5xx` without the
 *   retryable classification, whatever its body; or a value with no HTTP status (a timeout or a
 *   transport failure). Rethrow the original then, and the payment is reported as an unknown
 *   outcome.
 *
 * It classifies on the response status wherever it can, so an intermediary that rewrites or
 * replaces the error payload cannot turn a refusal into an unknown outcome; from the gateway's body
 * it reads only the classification and the `payment_id`. Both errors keep the gateway's `code` and
 * `message` when it sent them.
 *
 * @example
 * ```ts
 * const submitter: PaymentSubmitter = {
 *   async submit(request) {
 *     try {
 *       const res = await gateway.payments.submitPayment({ requestBody: request });
 *       return { payment_id: res.payment_id, status: res.status, transactions: res.transactions };
 *     } catch (err) {
 *       throw gatewayRefusalOf(err) ?? err;
 *     }
 *   },
 * };
 * ```
 */
export function gatewayRefusalOf(
  answer: unknown,
): PaymentRejectedError | PaymentRetryableError | undefined {
  // Read structurally rather than with instanceof: the merchant installs its own copy of the
  // gateway client, so the error class it throws is never one bundled into this package.
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { status, body } = answer as { status?: unknown; body?: unknown };
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
    return undefined;
  }
  const refused = status < 500;
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const { code, message } = fields;
  if (typeof code !== 'string' || typeof message !== 'string') {
    // Not the gateway's error: a page from a proxy in front of it, such as an HTML 403 or 429. A
    // 4xx is still a refusal by its status, so a request that may never have reached the gateway
    // is not reported as an unknown outcome. It names no cause, so the status stands in for the
    // code.
    if (!refused) return undefined;
    return new PaymentRejectedError({
      code: `HTTP_${status}`,
      detail: `The payment was refused with HTTP ${status}, and the answer named no cause`,
    });
  }
  // Not a refusal when a payment may exist: an error naming a payment_id comes from after the
  // payment was created, and RECONCILE_THEN_DECIDE (a 409 CONFLICT among them) says the same
  // purchase may already be in flight. Only the payment's own state can say whether anything was
  // charged, so neither is told "nothing was charged" or "fix the request".
  const paymentId = fields.payment_id;
  if (
    (typeof paymentId === 'string' && paymentId !== '') ||
    fields.retry_classification === 'RECONCILE_THEN_DECIDE'
  ) {
    return undefined;
  }
  // Retryable only when the gateway says the identifier is still free, by both fields: a 503 can
  // also mean it is spent (RETRY_WITH_NEW_IDENTIFIER, request_id_reusable false), and an absent
  // request_id_reusable means undetermined. And never a 429, whatever its classification: a
  // payment-enabled fetch re-attempts a payment-action-required answer at once, with no wait, and
  // the limit belongs to the merchant's server, so each re-attempt also spends the budget of the
  // merchant's other payers. It stays a rejection, with its code, until the payer can be made to
  // wait.
  if (
    status !== 429 &&
    fields.retry_classification === 'RETRY_AFTER_DELAY' &&
    fields.request_id_reusable === true
  ) {
    return new PaymentRetryableError({ code, detail: message });
  }
  if (refused) return new PaymentRejectedError({ code, detail: message });
  return undefined;
}
