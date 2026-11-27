// Checking a collected quote before awarding it: the settler's signature over the quote, and that
// the quote_id the gateway lists for it is that quote's hash.

import type { AwardedQuote, Quote } from './generated/types.gen';

/* eslint-disable @typescript-eslint/no-require-imports -- a static import would create a type
   edge into @atum-labs/schema-declarations, whose raw .ts entry points fail the DTS build with
   TS6059. See declaration-signing.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const quoteSigning: any = require('@atum-labs/ld-signing');

/** What {@link verifyFulfillmentQuote} found. */
export interface FulfillmentQuoteVerification {
  /** The settler's signature verifies and `quote_id` is the quote's hash. */
  valid: boolean;
  /** The quote's hash, the value the escrow commits on chain. Absent when it cannot be computed. */
  quoteHash?: string;
  /** The DID whose key signed the quote. Absent when the signature does not verify. */
  signerDID?: string;
  /** Why the quote is not valid. Absent when it is. */
  reason?: string;
}

/**
 * Checks a quote from `GET /v1/payments/quote-requests/{id}` or the quote request's response
 * before you award it: the settler's signature over `fulfillment_quote` verifies, and `quote_id`
 * is the quote's hash. It does not decide whom to trust: compare `signerDID` with the settlers you
 * accept. Never throws on a bad quote; it answers `valid: false` with a `reason`.
 */
export async function verifyFulfillmentQuote(
  quote: Quote | AwardedQuote,
): Promise<FulfillmentQuoteVerification> {
  let verified: { cryptosuite: string; signerDID: string; signerAddress: string };
  try {
    verified = await quoteSigning.verifyQuote(quote.fulfillment_quote);
  } catch (e) {
    return { valid: false, reason: `the quote's signature does not verify: ${messageOf(e)}` };
  }
  // A secp256k1 proof recovers some key from any document; it is the settler's only when the
  // recovered key is the one its verificationMethod names.
  if (
    verified.cryptosuite === 'EcdsaSecp256k1RecoverySignature2020' &&
    !quoteSigning.matchesSecp256k1DID(verified.signerAddress, verified.signerDID)
  ) {
    return {
      valid: false,
      reason: "the quote's signature does not verify: it is not by the key its proof names",
    };
  }
  const { signerDID } = verified;
  let quoteHash: string;
  try {
    quoteHash = (
      (await quoteSigning.computeQuoteHash(quote.fulfillment_quote)) as string
    ).toLowerCase();
  } catch (e) {
    return {
      valid: false,
      signerDID,
      reason: `the quote's hash cannot be computed: ${messageOf(e)}`,
    };
  }
  if (typeof quote.quote_id !== 'string' || quote.quote_id.toLowerCase() !== quoteHash) {
    return { valid: false, quoteHash, signerDID, reason: "quote_id is not the quote's hash" };
  }
  return { valid: true, quoteHash, signerDID };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
