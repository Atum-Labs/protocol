/**
 * A paid request driven through the real `@x402/core` HTTP resource server and the real
 * `@x402/express` adapter, so the page published in `extra.atumResource` is the one core reads
 * from an Express request, and the payment for one page is checked against another page's 402.
 *
 * The Express request is a plain object carrying only the fields the adapter reads; the
 * facilitator is a fake that records what it was asked to verify and settle.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { ExpressAdapter } from '@x402/express';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import type { FacilitatorClient, HTTPProcessResult, HTTPRequestContext } from '@x402/core/server';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { AtumEscrowServerScheme, atumEscrowPrice, type AtumEscrowServerConfig } from './index';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from '../client';
import { withPaymentIdentifier } from '../payment-identifier';

const SOURCE_NETWORK = 'eip155:8453';
const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const config: AtumEscrowServerConfig = {
  destination: {
    network: 'eip155:42161',
    asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    symbol: 'USDC',
    decimals: 6,
  },
  fulfillmentAmount: '10000000',
  markupBps: 300,
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
  quoteDeadlineSeconds: 20,
  fulfillmentDeadlineSeconds: 300,
  sources: {
    [SOURCE_NETWORK]: {
      asset: SOURCE_ASSET,
      escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      symbol: 'USDC',
      decimals: 6,
    },
  },
};

const EVM_ROLES: Omit<TrustedRoles, 'tokens'> = {
  escrowContract: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  quoteSelector: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  fulfillmentVerifierAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};
const TRUSTED_ROLES: Record<string, TrustedRoles> = {
  'eip155:8453': {
    ...EVM_ROLES,
    tokens: [{ symbol: 'USDC', address: SOURCE_ASSET, decimals: 6 }],
  },
  'eip155:42161': {
    ...EVM_ROLES,
    tokens: [
      { symbol: 'USDC', address: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3', decimals: 6 },
    ],
  },
};
const trust: TrustResolver = async (network) => {
  const roles = TRUSTED_ROLES[network];
  if (roles === undefined) throw new Error(`no trusted roles declared for ${network}`);
  return roles;
};

// Well-known anvil account #0, a throwaway dev key.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

const PAGE = 'GET /reports/42?{"format":"pdf"}';

/** A facilitator that supports atum-escrow on the source network and records each call. */
function fakeFacilitator() {
  const verified: PaymentRequirements[] = [];
  const settled: PaymentRequirements[] = [];
  const client: FacilitatorClient = {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'atum-escrow', network: SOURCE_NETWORK }],
      extensions: [],
      signers: {},
    }),
    verify: async (_payload, requirements) => {
      verified.push(requirements);
      return { isValid: true, payer: wallet.address };
    },
    settle: async (_payload, requirements) => {
      settled.push(requirements);
      return { success: true, transaction: '0x01', network: SOURCE_NETWORK, payer: wallet.address };
    },
  };
  return { client, verified, settled };
}

async function httpServer(facilitator: FacilitatorClient): Promise<x402HTTPResourceServer> {
  const server = new x402ResourceServer(facilitator).register(
    SOURCE_NETWORK,
    new AtumEscrowServerScheme(config),
  );
  const http = new x402HTTPResourceServer(server, {
    'GET /reports/*': {
      accepts: {
        scheme: 'atum-escrow',
        network: SOURCE_NETWORK,
        price: atumEscrowPrice(config),
        payTo: '',
      },
    },
  });
  await http.initialize();
  return http;
}

/** The core request context `@x402/express` builds for a request, from the fields it reads. */
function expressContext(
  originalUrl: string,
  headers: Record<string, string> = {},
): HTTPRequestContext {
  const url = new URL(originalUrl, 'https://shop.example');
  const lower: Record<string, string> = { host: 'shop.example' };
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const req = {
    method: 'GET',
    protocol: 'https',
    headers: lower,
    originalUrl,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    header: (name: string) => lower[name.toLowerCase()],
  };
  const adapter = new ExpressAdapter(
    req as unknown as ConstructorParameters<typeof ExpressAdapter>[0],
  );
  return {
    adapter,
    path: req.path,
    method: req.method,
    paymentHeader: adapter.getHeader('payment-signature'),
  };
}

function paymentRequiredOf(result: HTTPProcessResult): PaymentRequired {
  expect(result.type).toBe('payment-error');
  const { response } = result as Extract<HTTPProcessResult, { type: 'payment-error' }>;
  expect(response.status).toBe(402);
  return decodePaymentRequiredHeader(response.headers['PAYMENT-REQUIRED']!);
}

async function pay(offer: PaymentRequired): Promise<PaymentPayload> {
  const client = new x402Client();
  client.register(
    SOURCE_NETWORK,
    new AtumEscrowClientScheme({
      signer: wallet,
      trust,
      now: () => Date.parse('2026-07-08T12:00:00Z'),
    }),
  );
  return client.createPaymentPayload(withPaymentIdentifier(offer, 'order-4711'));
}

describe('atum-escrow through @x402/core and @x402/express', () => {
  it('binds the 402 to the Express page and settles the payment against that page', async () => {
    const facilitator = fakeFacilitator();
    const http = await httpServer(facilitator.client);

    const offer = paymentRequiredOf(
      await http.processHTTPRequest(expressContext('/reports/42?format=pdf')),
    );
    expect(offer.accepts).toHaveLength(1);
    expect(offer.accepts[0]!.extra.atumResource).toBe(PAGE);

    const payment = await pay(offer);
    expect(payment.accepted.extra.atumResource).toBe(PAGE);

    const paid = await http.processHTTPRequest(
      expressContext('/reports/42?format=pdf', {
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment),
      }),
    );
    expect(paid.type).toBe('payment-verified');
    const verified = paid as Extract<HTTPProcessResult, { type: 'payment-verified' }>;
    expect(verified.paymentRequirements.extra.atumResource).toBe(PAGE);
    expect(facilitator.verified.map((r) => r.extra.atumResource)).toEqual([PAGE]);

    const settlement = await http.processSettlement(
      verified.paymentPayload,
      verified.paymentRequirements,
      verified.declaredExtensions,
    );
    expect(settlement.success).toBe(true);
    expect(facilitator.settled.map((r) => r.extra.atumResource)).toEqual([PAGE]);
  });

  it('answers 402 for a page without a query when the Host header has a ?', async () => {
    const http = await httpServer(fakeFacilitator().client);
    const offer = paymentRequiredOf(
      await http.processHTTPRequest(expressContext('/reports/42', { Host: 'x?y' })),
    );
    expect(offer.accepts[0]!.extra.atumResource).toBe('GET /reports/42');
  });

  it.each(['/reports/43?format=pdf', '/reports/42?format=csv', '/reports/42'])(
    'refuses the payment for the page when presented on %s',
    async (elsewhere) => {
      const facilitator = fakeFacilitator();
      const http = await httpServer(facilitator.client);
      const offer = paymentRequiredOf(
        await http.processHTTPRequest(expressContext('/reports/42?format=pdf')),
      );
      const header = encodePaymentSignatureHeader(await pay(offer));

      const refused = paymentRequiredOf(
        await http.processHTTPRequest(expressContext(elsewhere, { 'PAYMENT-SIGNATURE': header })),
      );
      expect(refused.error).toBe('No matching payment requirements');
      expect(refused.accepts[0]!.extra.atumResource).not.toBe(PAGE);
      expect(facilitator.verified).toEqual([]);
      expect(facilitator.settled).toEqual([]);
    },
  );
});
