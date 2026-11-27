// The compatibility headers a client may send with a payment request: which library built the body,
// and the depositRequestHash v2 it computed over it. They never change how the payment is processed.

import {
  depositRequestHashShadowOf,
  type DepositRequestHashShadow,
} from '@atum-labs/payment-request-sender-auth';
import type { CancelablePromise } from './generated/core/CancelablePromise';
import { PaymentsService } from './generated/services.gen';
import type {
  SubmitPaymentRequest,
  SubmitPaymentData,
  SubmitPaymentResponse,
} from './generated/types.gen';

export type { DepositRequestHashShadow };

/**
 * The `X-Atum-Producer` and `X-Atum-Deposit-Request-Hash-V2` parameters of `payments.submitPayment`
 * for a shadow. Used for compatibility diagnostics only; they never change how the payment is
 * processed. Spread them into the call:
 * `client.payments.submitPayment({ requestBody, ...submitPaymentShadow(shadow) })`.
 *
 * @param shadow - what `depositRequestHashShadowOf` returns for the body as posted, or the shadow an
 *   x402 facilitator or MPP server hands its submitter. Absent sends neither.
 */
export function submitPaymentShadow(
  shadow: DepositRequestHashShadow | undefined,
): Pick<SubmitPaymentData, 'xAtumProducer' | 'xAtumDepositRequestHashV2'> {
  if (shadow === undefined) return {};
  return {
    xAtumProducer: shadow.producer,
    ...(shadow.depositRequestHashV2 !== undefined && {
      xAtumDepositRequestHashV2: shadow.depositRequestHashV2,
    }),
  };
}

/** The shadow this SDK sends with a payment request, as `sdk-ts`. */
export function sdkPaymentShadow(paymentRequest: SubmitPaymentRequest): DepositRequestHashShadow {
  return depositRequestHashShadowOf(JSON.stringify(paymentRequest), 'sdk-ts');
}

/**
 * The `payments` service of a `PaymentGatewayClient`. `submitPayment` adds this SDK's shadow
 * ({@link sdkPaymentShadow}) to a call that names no `xAtumProducer`, so every payment the SDK
 * submits carries both headers. A call that names one, such as an x402 facilitator or MPP server
 * forwarding its own shadow, is sent as given.
 */
export class ShadowingPaymentsService extends PaymentsService {
  override submitPayment(data: SubmitPaymentData): CancelablePromise<SubmitPaymentResponse> {
    if (data.xAtumProducer !== undefined) return super.submitPayment(data);
    let shadow: DepositRequestHashShadow | undefined;
    try {
      shadow = sdkPaymentShadow(data.requestBody);
    } catch {
      // A body that does not serialize fails in the request below, as it did without the headers.
    }
    return super.submitPayment({ ...data, ...submitPaymentShadow(shadow) });
  }
}
