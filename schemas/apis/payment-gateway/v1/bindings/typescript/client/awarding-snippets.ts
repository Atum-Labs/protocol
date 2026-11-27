// The TypeScript from docs/awarding.md, compiled against the PACKED TARBALL by
// `pnpm run check:publishable` (see publish-guard.config.mjs `consumer.snippetFiles`).
//
// Same contract as readme-snippets.ts: the code we tell customers to write is checked against the
// published types, not against `src/`.
//
// EDIT THIS FILE WHENEVER YOU EDIT A TYPESCRIPT BLOCK IN docs/awarding.md.
//
// It mirrors the block rather than copying it byte for byte: imports are hoisted and the code that
// awaits is wrapped in an exported function. Nothing else should differ.
//
// This file is not part of `src/`, is not in the package `files` allowlist, and ships to nobody.
//
// NOTE: comments are NOT mirrored and are NOT covered by the guard.

import { PaymentGatewayClient, createSenderSigner } from '@atumlabs/payment-gateway-client';
import { verifyFulfillmentQuote } from '@atumlabs/payment-gateway-client/signing';

// --- Awarding from the SDK -------------------------------------------------------
export async function awardCheapestQuote() {
  const client = new PaymentGatewayClient({
    BASE: 'https://payment-gw.production-testnet.atum.xyz',
  });

  const quoteRequest = await client.prepareQuoteRequest({
    depositor: '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
    fulfillmentAmount: '100000',
    sourceAsset: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    destinationAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    destinationAsset: 'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    maxSourceAmount: '101000',
    requestId: 'quote-order-1234',
  });
  const opened = await client.quoteRequests.createQuoteRequest({
    requestBody: quoteRequest,
    wait: true,
  });

  const batch = await client.quoteRequests.getQuoteRequestStatus({
    quoteRequestId: opened.quote_request_id,
  });

  const trustedSettlers = new Set(['did:pkh:eip155:1:0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc']);
  let chosen;
  for (const quote of batch.quotes ?? []) {
    const check = await verifyFulfillmentQuote(quote);
    if (!check.valid || !trustedSettlers.has(check.signerDID!)) continue;
    const amount = BigInt(quote.fulfillment_quote.source_amount as string);
    if (!chosen || amount < BigInt(chosen.fulfillment_quote.source_amount as string)) {
      chosen = quote;
    }
  }
  if (!chosen) throw new Error('no quote to award');

  const { paymentId, response } = await client.awardQuote({
    requestId: 'award-order-1234',
    quoteRequestId: opened.quote_request_id,
    quoteRequest,
    quote: chosen,
    depositorSigner: createSenderSigner('eip155:42161', { privateKey: process.env.PRIVATE_KEY! }),
  });
  console.log(paymentId, response.status);
}
