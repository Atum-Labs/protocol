import bs58 from 'bs58';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';

import { verifyFulfillmentQuote } from './signing';

/* eslint-disable @typescript-eslint/no-require-imports -- the upstream package is loaded the way
   quote-verify.ts loads it */
const quoteSigning = require('@atum-labs/ld-signing');

const settler = new ethers.Wallet(ethers.id('quote-verify test settler'));

const QUOTE = {
  version: '1.0',
  source_amount: '1000000',
  award_deadline: '2035-01-15T11:00:00Z',
  source: {
    id: 'eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    account: '0x742d35CC6634c0532925a3B8d8c5e48C4e6B4A72',
  },
  destination: {
    id: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    account: '0x0707070707070707070707070707070707070707',
  },
  payment_request_json: '{"request_id":"qr-1"}',
};

async function signedQuote() {
  const fulfillmentQuote = await quoteSigning.signQuote(
    { ...QUOTE, settler_address: settler.address },
    settler.privateKey,
    { created: '2035-01-15T10:00:00Z' },
  );
  const quoteId = (await quoteSigning.computeQuoteHash(fulfillmentQuote)) as string;
  return { quote_id: quoteId, fulfillment_quote: fulfillmentQuote as Record<string, unknown> };
}

describe('verifyFulfillmentQuote', () => {
  it("accepts a settler-signed quote whose quote_id is its hash, naming the signer's DID", async () => {
    const quote = await signedQuote();

    expect(await verifyFulfillmentQuote(quote)).toEqual({
      valid: true,
      quoteHash: quote.quote_id.toLowerCase(),
      signerDID: `did:pkh:eip155:1:${settler.address.toLowerCase()}`,
    });
  });

  it('refuses a quote whose source_amount was changed after signing', async () => {
    const quote = await signedQuote();
    const got = await verifyFulfillmentQuote({
      ...quote,
      fulfillment_quote: { ...quote.fulfillment_quote, source_amount: '1' },
    });

    expect(got.valid).toBe(false);
    expect(got.reason).toMatch(/it is not by the key its proof names$/);
  });

  it('refuses a quote whose proof names a key other than the one that signed it', async () => {
    const quote = await signedQuote();
    const other = new ethers.Wallet(ethers.id('quote-verify test other settler'));
    const proof = quote.fulfillment_quote.proof as Record<string, unknown>;
    const got = await verifyFulfillmentQuote({
      ...quote,
      fulfillment_quote: {
        ...quote.fulfillment_quote,
        proof: {
          ...proof,
          verificationMethod: `did:pkh:eip155:1:${other.address.toLowerCase()}#blockchainAccountId`,
        },
      },
    });

    expect(got).toEqual({
      valid: false,
      reason: "the quote's signature does not verify: it is not by the key its proof names",
    });
  });

  it("accepts a Solana settler's Ed25519 quote", async () => {
    const key = nacl.sign.keyPair.fromSeed(
      Buffer.from(ethers.id('quote-verify test solana settler').slice(2), 'hex'),
    );
    const signerDID = `did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${bs58.encode(key.publicKey)}`;
    const fulfillmentQuote = await quoteSigning.signQuoteEd25519(
      { ...QUOTE, settler_address: bs58.encode(key.publicKey) },
      key.secretKey,
      { verificationMethod: `${signerDID}#blockchainAccountId`, created: '2035-01-15T10:00:00Z' },
    );
    const quoteId = (await quoteSigning.computeQuoteHash(fulfillmentQuote)) as string;

    expect(
      await verifyFulfillmentQuote({ quote_id: quoteId, fulfillment_quote: fulfillmentQuote }),
    ).toEqual({ valid: true, quoteHash: quoteId.toLowerCase(), signerDID });
  });

  it('refuses a quote_id that is not the quote hash', async () => {
    const quote = await signedQuote();
    const got = await verifyFulfillmentQuote({ ...quote, quote_id: '0x' + 'cd'.repeat(32) });

    expect(got).toMatchObject({ valid: false, reason: "quote_id is not the quote's hash" });
    expect(got.quoteHash).toBe(quote.quote_id.toLowerCase());
  });
});
