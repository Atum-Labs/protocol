/**
 * A payment-enabled `fetch` that names the purchase each call is paying for.
 *
 * An `atum-escrow` payment derives its identity from an identifier for the purchase and the page
 * paid for, and the Atum network de-duplicates on that identity. Re-attempting a purchase of the
 * same page under the same identifier therefore resolves to the original payment instead of taking
 * a second one, and a new identifier, or another page, starts a new payment. The identifier is the payer's to choose, which means the application has to
 * be able to say, per call, which purchase is being paid for.
 *
 * `wrapFetchWithPayment` from `@x402/fetch` offers no per-call channel — a scheme sees only the
 * requirement and the server's declared extensions — so this wrapper adds one:
 *
 * ```ts
 * // built once; every payment goes through this same client
 * const client = new x402Client().register(network, new AtumEscrowClientScheme({ signer }));
 * const pay = wrapFetchWithAtumPayment(fetch, client);
 *
 * await pay("/report", {}, { paymentIdentifier: "order-4711" });   // one purchase
 * await pay("/report", {}, { paymentIdentifier: "order-4712" });   // a different purchase
 * ```
 *
 * The identifier is scoped to the individual call rather than held on the client or the scheme, so
 * one long-lived client serves any number of distinct payments and concurrent calls cannot pick up
 * each other's identifier. Holding it on the client instead would make every purchase share one
 * identity and collapse onto a single payment.
 */

import { wrapFetchWithPayment, x402Client, x402HTTPClient } from '@x402/fetch';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { withPaymentIdentifier } from '../payment-identifier';

/**
 * Per-call options for a payment-enabled `fetch`.
 *
 * @public
 */
export interface AtumPaymentOptions {
  /**
   * Names the purchase this call is paying for. Use the application's own reference — an order,
   * invoice or cart id: one value per purchase, the same value every time that purchase is
   * re-attempted, and never shared between two purchases.
   *
   * Any non-empty string is accepted; a value the x402 payment-identifier extension would not permit
   * is mapped onto one that would, deterministically, so the same reference always yields the same
   * payment identity.
   *
   * May be omitted only when the resource server names the purchase itself in its 402.
   */
  paymentIdentifier?: string;
}

/** A `fetch` that pays for the resources it requests, told per call what it is paying for. */
export type FetchWithAtumPayment = (
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: AtumPaymentOptions,
) => Promise<Response>;

/**
 * Wrap `fetch` so that it settles `402` responses for `atum-escrow` resources.
 *
 * @param fetch - the `fetch` implementation to wrap
 * @param client - a client with an {@link ../client!AtumEscrowClientScheme | AtumEscrowClientScheme}
 *   registered for every network to be paid from. Build it once and reuse it; the purchase
 *   identifier is supplied per call, not held on the client.
 * @returns a `fetch` taking {@link AtumPaymentOptions} as a third argument
 * @public
 */
export function wrapFetchWithAtumPayment(
  fetch: typeof globalThis.fetch,
  client: x402Client | x402HTTPClient,
): FetchWithAtumPayment {
  return (input, init, options) =>
    wrapFetchWithPayment(fetch, scopeToPurchase(client, options?.paymentIdentifier))(input, init);
}

/**
 * View a client as being about one particular purchase.
 *
 * The returned value forwards everything to the client it wraps, except that it names the purchase
 * in the `402` before the client builds a payment for it. Nothing is stored on the client, so a
 * separate view per call is what keeps concurrent payments from sharing an identifier.
 */
function scopeToPurchase(
  client: x402Client | x402HTTPClient,
  reference: string | undefined,
): x402Client | x402HTTPClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'createPaymentPayload') {
        return (paymentRequired: PaymentRequired): Promise<PaymentPayload> =>
          target.createPaymentPayload(withPaymentIdentifier(paymentRequired, reference));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
