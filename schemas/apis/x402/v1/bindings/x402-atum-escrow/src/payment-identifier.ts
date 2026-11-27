/**
 * The `payment-identifier` x402 extension — how an `atum-escrow` payment carries its
 * idempotency key.
 *
 * A resource server advertises the extension in its `402` response; the payer echoes it back in
 * the payment payload with an `id` of its own. That `id` names the *purchase* being paid for, and
 * the payment's `request_id` is derived from it and from the page paid for (see `./request-id`).
 * The Atum network de-duplicates on `request_id`, so an identifier reused when re-attempting a
 * purchase of the same page resolves to the original payment rather than taking a second one, and
 * a fresh identifier, or the same one on another page, starts a new payment.
 *
 * This module implements the parts of the extension the scheme needs, rather than depending on the
 * reference implementation, so that a published package does not carry that package's dependency
 * tree for a handful of constants. A conformance test asserts the values here still agree with the
 * reference implementation, so the two cannot drift apart unnoticed.
 */

import { sha256, toUtf8Bytes } from 'ethers';

/** The extension's key in an `extensions` map. */
export const PAYMENT_IDENTIFIER = 'payment-identifier';

/** Shortest identifier the extension permits. */
export const PAYMENT_ID_MIN_LENGTH = 16;

/** Longest identifier the extension permits. */
export const PAYMENT_ID_MAX_LENGTH = 128;

/** Characters an identifier may consist of: letters, digits, hyphen and underscore. */
export const PAYMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * The extension's data. A resource server advertises `required`; a payer adds `id`.
 *
 * @internal
 */
export interface PaymentIdentifierInfo {
  /** Whether the resource server requires payers to supply an identifier. */
  required: boolean;
  /** The payer's identifier for the purchase being paid for. */
  id?: string;
}

/**
 * One entry of an `extensions` map, under the {@link PAYMENT_IDENTIFIER} key.
 *
 * @internal
 */
export interface PaymentIdentifierExtension {
  /** The extension's data. */
  info: PaymentIdentifierInfo;
  /** JSON Schema describing {@link PaymentIdentifierExtension.info}. */
  schema?: unknown;
}

/**
 * JSON Schema for the extension's `info`, published in the `402` alongside the declaration so a
 * payer can validate what it is being asked for without knowing this scheme.
 */
const PAYMENT_IDENTIFIER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    required: { type: 'boolean' },
    id: {
      type: 'string',
      minLength: PAYMENT_ID_MIN_LENGTH,
      maxLength: PAYMENT_ID_MAX_LENGTH,
      pattern: PAYMENT_ID_PATTERN.source,
    },
  },
  required: ['required'],
} as const;

/**
 * Report whether an identifier is one the extension permits: {@link PAYMENT_ID_MIN_LENGTH} to
 * {@link PAYMENT_ID_MAX_LENGTH} characters, drawn from {@link PAYMENT_ID_PATTERN}.
 *
 * @param id - the value to check
 * @returns `true` when `id` is a well-formed identifier
 * @internal
 */
export function isValidPaymentId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length >= PAYMENT_ID_MIN_LENGTH &&
    id.length <= PAYMENT_ID_MAX_LENGTH &&
    PAYMENT_ID_PATTERN.test(id)
  );
}

/**
 * Build the declaration a resource server puts in its `402` to advertise the extension.
 *
 * @param required - whether payers must supply an identifier
 * @returns the declaration, ready to place under {@link PAYMENT_IDENTIFIER} in `extensions`
 * @internal
 */
export function declarePaymentIdentifier(required: boolean): PaymentIdentifierExtension {
  return { info: { required }, schema: PAYMENT_IDENTIFIER_SCHEMA };
}

/**
 * Read the identifier out of an `extensions` map, from either side of the exchange: a declaration
 * the resource server already filled in, or a payer's echo.
 *
 * The value is validated before it is returned, so a malformed identifier reads as absent rather
 * than being carried further into a payment. Callers therefore only have to distinguish "usable
 * identifier" from "none".
 *
 * @param extensions - an `extensions` map from a `402` response or a payment payload
 * @returns the identifier, or `undefined` when there is none or it is malformed
 * @internal
 */
export function paymentIdentifierOf(extensions: unknown): string | undefined {
  const id = rawPaymentIdentifierOf(extensions);
  return isValidPaymentId(id) ? id : undefined;
}

/**
 * Read the identifier out of an `extensions` map **without** validating it.
 *
 * Used where a malformed identifier has to be reported as an error rather than ignored — a resource
 * server that advertises an identifier the extension does not permit cannot be corrected by the
 * payer, because a payer may not overwrite what the server declared, so the payment has to be
 * refused with an explanation instead of failing later for an unrelated-looking reason.
 *
 * @param extensions - an `extensions` map from a `402` response or a payment payload
 * @returns whatever is present under the extension's `info.id`, unvalidated
 * @internal
 */
export function rawPaymentIdentifierOf(extensions: unknown): unknown {
  if (typeof extensions !== 'object' || extensions === null) {
    return undefined;
  }
  const entry = (extensions as Record<string, unknown>)[PAYMENT_IDENTIFIER];
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const info = (entry as { info?: unknown }).info;
  if (typeof info !== 'object' || info === null) {
    return undefined;
  }
  return (info as { id?: unknown }).id;
}

/**
 * Map any value a caller uses to name a purchase onto an identifier the extension permits.
 *
 * The extension constrains identifiers to {@link PAYMENT_ID_MIN_LENGTH}-{@link PAYMENT_ID_MAX_LENGTH}
 * characters drawn from {@link PAYMENT_ID_PATTERN}, and real order references frequently fall outside
 * that — too short, or containing separators such as `/` or `:`. Rejecting them would let a formatting
 * rule decide whether a payment can be safely re-attempted, so a value that does not already conform
 * is mapped onto one that does.
 *
 * The mapping is a digest of the caller's value, so it is stable: the same input always yields the
 * same identifier, which is what makes re-attempting a purchase resolve to the original payment.
 * Different inputs yield different identifiers, so distinct purchases stay distinct.
 *
 * A value that already conforms is returned unchanged, so a caller that wants the identifier on the
 * wire to match its own reference can arrange that by supplying a conforming one.
 *
 * @param value - the caller's own reference for the purchase, such as an order id
 * @returns an identifier the extension permits
 * @throws if `value` is not a non-empty string
 * @internal
 */
export function toPaymentIdentifier(value: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      'atum-escrow: a purchase identifier must be a non-empty string naming what is being bought',
    );
  }
  if (isValidPaymentId(value)) {
    return value;
  }
  return `pay_${sha256(toUtf8Bytes(value)).slice(2)}`;
}

/**
 * Determine the identifier a payment's identity derives from, given the extensions in play.
 *
 * Shared by the payer and the facilitator so that the value one side derives `request_id` from is
 * the value the other side checks it against. Were each to resolve the identifier its own way, the
 * check could drift into one that silently passes everything.
 *
 * A malformed declared identifier is reported rather than ignored: a payer cannot correct one,
 * because the framework forbids overwriting a value the resource server declared, so continuing
 * would fail later for a reason that does not point back to the cause.
 *
 * @param extensions - the `extensions` map from the 402 or from the payment payload
 * @returns the identifier to derive `request_id` from
 * @throws if no identifier is available, or one is present but not well-formed
 * @internal
 */
export function resolvePaymentIdentifier(extensions: unknown): string {
  const declared = rawPaymentIdentifierOf(extensions);
  if (declared !== undefined) {
    if (!isValidPaymentId(declared)) {
      throw new Error(
        `atum-escrow: the ${PAYMENT_IDENTIFIER} extension carries an identifier this scheme cannot ` +
          `use (${JSON.stringify(declared)}). It must be ${PAYMENT_ID_MIN_LENGTH}-${PAYMENT_ID_MAX_LENGTH} ` +
          `characters of letters, digits, hyphen or underscore, and it cannot be substituted here ` +
          `because a payer may not overwrite a value the resource server declared.`,
      );
    }
    return declared;
  }

  throw new Error(
    `atum-escrow: no purchase identifier is available, so this payment cannot be made ` +
      `re-attemptable and is refused. Supply one through the ${PAYMENT_IDENTIFIER} extension — a ` +
      `stable per-purchase value such as an order id — so that re-attempting the same purchase ` +
      `resolves to the same payment instead of taking a second one.`,
  );
}

/**
 * Build the payer's echo of the extension, carrying its identifier.
 *
 * Only `info.id` is set: the resource server's own `info` fields travel back unchanged because the
 * framework merges the payer's echo onto the declaration, and a payer may add to that declaration
 * but never remove or overwrite it.
 *
 * @param id - the identifier to echo
 * @returns an `extensions` fragment to merge into the payment payload
 * @internal
 */
export function echoPaymentIdentifier(id: string): Record<string, unknown> {
  return { [PAYMENT_IDENTIFIER]: { info: { id } } };
}

/**
 * Return a `402` with the purchase this payment is for named in its extensions.
 *
 * Every payment needs an identifier, and the payer is normally the one who knows it, so it has to be
 * attached to the `402` before a payment is built from it. A payment-enabled `fetch` does this for
 * the caller; code that drives a client directly — building a payload from a `402` it fetched
 * itself — needs to do it explicitly, and should do it through here rather than by writing the
 * extension by hand, so the reconciliation rules below stay in one place.
 *
 * The purchase is named by *adding* to the resource server's own declarations, never by replacing
 * them: the x402 specification lets a payer append to what a server declared but not remove or
 * overwrite it, and a payload that overwrote a declared value would be rejected as a tampered echo.
 *
 * @param paymentRequired - the `402` to name the purchase in
 * @param reference - the caller's own reference for the purchase (an order, invoice or cart id).
 *   Omit it only when the resource server named the purchase itself.
 * @returns a copy of the `402` carrying the identifier, or the original when the resource server
 *   already named the purchase
 * @throws if neither side named the purchase, or if both did and they disagree
 * @public
 */
export function withPaymentIdentifier<T extends { extensions?: Record<string, unknown> }>(
  paymentRequired: T,
  reference: string | undefined,
): T {
  const declared = rawPaymentIdentifierOf(paymentRequired.extensions);

  if (reference === undefined) {
    if (declared !== undefined) {
      // The resource server named the purchase itself, so the caller needs no identifier of its own.
      return paymentRequired;
    }
    throw new Error(
      'atum-escrow: this payment was not told which purchase it is paying for, and the resource ' +
        'server did not name one either, so it cannot be made re-attemptable and is refused. ' +
        "Supply the purchase's identifier — your own order id — when paying. With the fetch " +
        'returned by wrapFetchWithAtumPayment, that is `{ paymentIdentifier: <your order id> }` as ' +
        'its third argument; note that a wrapped fetch called as a plain `fetch(url, init)` — for ' +
        'instance by a library that accepts a fetch implementation — cannot receive it.',
    );
  }

  const identifier = toPaymentIdentifier(reference);

  if (declared !== undefined) {
    // Both sides named the purchase. The resource server's value wins and cannot be substituted, so
    // silently discarding the caller's would leave it believing it had paid under an identity it
    // chose. Agreement is harmless; disagreement has to be reported.
    if (declared !== identifier) {
      throw new Error(
        `atum-escrow: this payment named the purchase ${JSON.stringify(reference)} but the resource ` +
          `server already named it ${JSON.stringify(declared)}. A payer may not overwrite an ` +
          `identifier the resource server declared, so the two cannot both be honoured. Omit the ` +
          `identifier to accept the resource server's, or pay a resource that does not declare one.`,
      );
    }
    return paymentRequired;
  }

  const entry = (paymentRequired.extensions?.[PAYMENT_IDENTIFIER] ?? {}) as {
    info?: Record<string, unknown>;
  };
  // A copy, not an in-place edit: a caller that holds a `402` and pays for two purchases from it
  // must not have the first purchase's identifier leak into the second.
  return {
    ...paymentRequired,
    extensions: {
      ...paymentRequired.extensions,
      [PAYMENT_IDENTIFIER]: { ...entry, info: { ...entry.info, id: identifier } },
    },
  };
}
