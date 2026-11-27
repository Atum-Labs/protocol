/**
 * The `payment-identifier` extension surface, and its conformance to the reference implementation.
 *
 * This package implements the parts of the extension the scheme needs rather than depending on
 * `@x402/extensions`, so that a published package does not carry that package's dependency tree for
 * a handful of constants. The conformance block below imports the reference implementation as a
 * dev-only dependency and asserts the two still agree — so a change upstream shows up as a failing
 * test here rather than as a payment a third party rejects.
 */
import { describe, it, expect } from 'vitest';
import {
  PAYMENT_IDENTIFIER as REFERENCE_KEY,
  PAYMENT_ID_MAX_LENGTH as REFERENCE_MAX,
  PAYMENT_ID_MIN_LENGTH as REFERENCE_MIN,
  PAYMENT_ID_PATTERN as REFERENCE_PATTERN,
  declarePaymentIdentifierExtension,
  generatePaymentId,
  isValidPaymentId as referenceIsValidPaymentId,
} from '@x402/extensions/payment-identifier';
import {
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_PATTERN,
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifier,
  echoPaymentIdentifier,
  isValidPaymentId,
  paymentIdentifierOf,
  rawPaymentIdentifierOf,
  resolvePaymentIdentifier,
} from './payment-identifier';

/** A well-formed identifier: 23 characters, letters/digits/underscore. */
const ID = 'pay_order_4711_a1b2c3d4';

describe('payment identifier — format rule', () => {
  it('accepts an identifier at both ends of the permitted length', () => {
    expect(isValidPaymentId('a'.repeat(PAYMENT_ID_MIN_LENGTH))).toBe(true);
    expect(isValidPaymentId('a'.repeat(PAYMENT_ID_MAX_LENGTH))).toBe(true);
  });

  it('rejects an identifier one character outside either end', () => {
    expect(isValidPaymentId('a'.repeat(PAYMENT_ID_MIN_LENGTH - 1))).toBe(false);
    expect(isValidPaymentId('a'.repeat(PAYMENT_ID_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects characters the extension does not permit', () => {
    // Real-world order ids routinely contain these, which is why a caller's own value may need
    // mapping onto a permitted one rather than being passed through.
    expect(isValidPaymentId('visa/order:88213xxxx')).toBe(false);
    expect(isValidPaymentId('order 4711 with sp')).toBe(false);
    expect(isValidPaymentId('order.4711.aaaaaaa')).toBe(false);
  });

  it('accepts letters, digits, hyphen and underscore', () => {
    expect(isValidPaymentId('Ab9-_Ab9-_Ab9-_Ab9')).toBe(true);
  });

  it('rejects anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(isValidPaymentId(value)).toBe(false);
    }
  });
});

describe('payment identifier — reading it out of an extensions map', () => {
  it('reads the identifier a payer or resource server put there', () => {
    expect(paymentIdentifierOf(echoPaymentIdentifier(ID))).toBe(ID);
  });

  it('treats a malformed identifier as absent, so it cannot reach a payment', () => {
    expect(
      paymentIdentifierOf({ [PAYMENT_IDENTIFIER]: { info: { id: 'too-short' } } }),
    ).toBeUndefined();
  });

  it('still exposes a malformed identifier to callers that must report it', () => {
    // The distinction matters: a resource server that declared an unusable identifier has to be
    // told so, because a payer cannot substitute a different one.
    expect(rawPaymentIdentifierOf({ [PAYMENT_IDENTIFIER]: { info: { id: 'too-short' } } })).toBe(
      'too-short',
    );
  });

  it('reads as absent for every shape that carries no identifier', () => {
    for (const value of [
      undefined,
      null,
      {},
      { [PAYMENT_IDENTIFIER]: null },
      { [PAYMENT_IDENTIFIER]: {} },
      { [PAYMENT_IDENTIFIER]: { info: null } },
      { [PAYMENT_IDENTIFIER]: { info: {} } },
      { 'other-extension': { info: { id: ID } } },
    ]) {
      expect(paymentIdentifierOf(value)).toBeUndefined();
      expect(rawPaymentIdentifierOf(value)).toBeUndefined();
    }
  });
});

describe('payment identifier — resolution shared by payer and facilitator', () => {
  it('reads the identifier out of the extension', () => {
    // Both sides resolve through this one function, so the value the payer derives `request_id`
    // from is by construction the value the facilitator checks it against.
    expect(resolvePaymentIdentifier(echoPaymentIdentifier(ID))).toBe(ID);
  });

  it('refuses when no identifier is available', () => {
    // Fail-closed, and with no generated fallback: an identifier invented here would look like an
    // idempotency key while letting every re-attempt become a second payment.
    expect(() => resolvePaymentIdentifier(undefined)).toThrow(/no purchase identifier/i);
    expect(() => resolvePaymentIdentifier({})).toThrow(/no purchase identifier/i);
  });

  it('refuses an identifier the extension does not permit, rather than ignoring it', () => {
    // A payer may not overwrite what the resource server declared, so it cannot be corrected —
    // failing here names the cause instead of surfacing later as an unrelated-looking rejection.
    // Ignoring it would be worse still: the payment would be made under a different identity than
    // the one the resource server named.
    expect(() =>
      resolvePaymentIdentifier({ [PAYMENT_IDENTIFIER]: { info: { id: 'too-short' } } }),
    ).toThrow(/cannot use/i);
  });
});

describe('payment identifier — declaration and echo shapes', () => {
  it('declares the extension as required, with a schema a payer can read', () => {
    const declaration = declarePaymentIdentifier(true);
    expect(declaration.info).toEqual({ required: true });
    expect(declaration.schema).toMatchObject({ type: 'object', required: ['required'] });
  });

  it("echoes only the identifier, leaving the server's own fields to the framework merge", () => {
    // A payer may add to a declaration but never remove or overwrite it, so the echo must not
    // restate `required` — the framework carries the server's value through.
    expect(echoPaymentIdentifier(ID)).toEqual({ [PAYMENT_IDENTIFIER]: { info: { id: ID } } });
  });
});

describe('payment identifier — conformance with the reference implementation', () => {
  it('uses the same extension key', () => {
    expect(PAYMENT_IDENTIFIER).toBe(REFERENCE_KEY);
  });

  it('uses the same length bounds and character rule', () => {
    expect(PAYMENT_ID_MIN_LENGTH).toBe(REFERENCE_MIN);
    expect(PAYMENT_ID_MAX_LENGTH).toBe(REFERENCE_MAX);
    expect(PAYMENT_ID_PATTERN.source).toBe(REFERENCE_PATTERN.source);
  });

  it('agrees with the reference validator on every case this suite covers', () => {
    const cases = [
      ID,
      'a'.repeat(PAYMENT_ID_MIN_LENGTH),
      'a'.repeat(PAYMENT_ID_MAX_LENGTH),
      'a'.repeat(PAYMENT_ID_MIN_LENGTH - 1),
      'a'.repeat(PAYMENT_ID_MAX_LENGTH + 1),
      'visa/order:88213xxxx',
      'order 4711 with sp',
      'Ab9-_Ab9-_Ab9-_Ab9',
    ];
    for (const value of cases) {
      expect(isValidPaymentId(value)).toBe(referenceIsValidPaymentId(value));
    }
  });

  it('accepts an identifier generated by the reference implementation', () => {
    expect(isValidPaymentId(generatePaymentId())).toBe(true);
  });

  it('declares the same shape the reference implementation declares', () => {
    const ours = declarePaymentIdentifier(true);
    const reference = declarePaymentIdentifierExtension(true);
    expect(ours.info).toEqual(reference.info);
    expect(ours.schema).toEqual(reference.schema);
  });

  it('produces an echo the reference reader can extract', () => {
    // Proves the wire shape is the one a third-party facilitator or resource server expects.
    const merged = { ...declarePaymentIdentifier(true), ...{} };
    const extensions = {
      [PAYMENT_IDENTIFIER]: { ...merged, info: { ...merged.info, ...{ id: ID } } },
    };
    expect(paymentIdentifierOf(extensions)).toBe(ID);
    expect(referenceIsValidPaymentId(String(rawPaymentIdentifierOf(extensions)))).toBe(true);
  });
});
