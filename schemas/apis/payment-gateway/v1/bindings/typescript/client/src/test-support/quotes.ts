// Settler quotes for tests: the fields a quote carries for a quote request, and the same quote
// signed by a test settler, as verifyFulfillmentQuote checks it.
import bs58 from 'bs58';
import { ethers } from 'ethers';
import type { AwardedQuote, CreateQuoteRequest } from '../generated/types.gen';

/* eslint-disable @typescript-eslint/no-require-imports -- the upstream package is loaded the way
   quote-verify.ts loads it */
const quoteSigning = require('@atum-labs/ld-signing');

/** The settler that signs {@link signedQuoteFor} quotes. */
export const TEST_SETTLER = new ethers.Wallet(ethers.id('pgc test settler'));

/** The Tron base58 form of a 20-byte hex address. */
export function tronBase58(evmAddress: string): string {
  const raw = '41' + evmAddress.slice(2).toLowerCase();
  const checksum = ethers.sha256(ethers.sha256('0x' + raw)).slice(2, 10);
  return bs58.encode(Buffer.from(raw + checksum, 'hex'));
}

export interface QuoteOptions {
  sourceAmount: string;
  quoteId?: string;
  settlerAddress?: string;
  /** Seconds until the quote's award_deadline. Default 60. */
  awardWithinSeconds?: number;
  /** Fields of fulfillment_quote to replace. */
  fields?: Record<string, unknown>;
}

/** An unsigned quote for `body`, as a settler quotes it: same source and destination, its body. */
export function quoteFor(body: CreateQuoteRequest, options: QuoteOptions): AwardedQuote {
  return {
    quote_id: options.quoteId ?? '0x' + 'cd'.repeat(32),
    awarded_payment_id: null,
    fulfillment_quote: {
      version: '1.0',
      source_amount: options.sourceAmount,
      award_deadline: new Date(
        Date.now() + (options.awardWithinSeconds ?? 60) * 1000,
      ).toISOString(),
      source: { id: body.source.asset_identifier, account: body.source.account },
      destination: {
        id: body.destination[0].asset_identifier,
        account: body.destination[0].account,
      },
      settler_address: options.settlerAddress ?? TEST_SETTLER.address,
      payment_request_json: JSON.stringify(body),
      ...options.fields,
    },
  };
}

/** {@link quoteFor}, signed by {@link TEST_SETTLER}, with `quote_id` its hash. */
export async function signedQuoteFor(
  body: CreateQuoteRequest,
  options: Omit<QuoteOptions, 'quoteId'>,
): Promise<AwardedQuote> {
  const { fulfillment_quote: unsigned } = quoteFor(body, options);
  const fulfillmentQuote = await quoteSigning.signQuote(unsigned, TEST_SETTLER.privateKey);
  return {
    quote_id: ((await quoteSigning.computeQuoteHash(fulfillmentQuote)) as string).toLowerCase(),
    awarded_payment_id: null,
    fulfillment_quote: fulfillmentQuote,
  };
}
