/**
 * The route price, driven through the REAL `@x402/core` resource server.
 *
 * A merchant does not call `parsePrice` — core does, while building a route's requirements from
 * its payment options, and it spreads whatever the scheme returns into the 402. So the price a
 * route declares is only proven harmless end to end: `atumEscrowPrice(config)` must produce the
 * same 402 the scheme builds directly and carry a payment through verify and settle, and a
 * placeholder price must stop the route from building at all rather than advertise a cap the
 * merchant never wrote.
 *
 * The facilitator is the real atum-escrow facilitator mechanism behind core's own
 * `x402Facilitator`, with only the payment gateway faked, so `initialize()` learns the supported
 * kinds the way it would from a deployed facilitator.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { x402Client } from '@x402/core/client';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { Network, PaymentPayload, PaymentRequirements, Price } from '@x402/core/types';
import { AtumEscrowServerScheme, atumEscrowPrice, type AtumEscrowServerConfig } from './index';
import { buildRequirement, expectConfigError, httpRequest, rejectionOf } from './test-support';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from '../client';
import { AtumEscrowFacilitatorScheme, type PaymentSubmitter } from '../facilitator';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';

const SOURCE_NETWORK: Network = 'eip155:8453';
const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEST_NETWORK = 'eip155:42161';
const DEST_ASSET = '0x52e52f345139e57b87d288c9ea794bb3fbe591c3';
/** An 18-decimal USDC on the destination chain, for a corridor whose two sides differ in decimals. */
const DEST_ASSET_18 = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

const config: AtumEscrowServerConfig = {
  destination: {
    network: DEST_NETWORK,
    asset: DEST_ASSET,
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

/**
 * The same corridor paying out in an 18-decimal destination token: ten whole tokens, so the
 * source cap is the same 10.3 tokens as the 6-decimal corridor, stated in the source's 6 decimals.
 */
const config18: AtumEscrowServerConfig = {
  ...config,
  destination: { ...config.destination, asset: DEST_ASSET_18, decimals: 18 },
  fulfillmentAmount: '10000000000000000000',
};

/**
 * The roles this file's fixtures advertise, declared per chain as what the payer and the
 * facilitator trust. Every field repeats the fixture's own value for that chain, and `tokens`
 * lists the asset the fixture moves there, so the markup bound can price the corridor.
 */
const EVM_ROLES: Omit<TrustedRoles, 'tokens'> = {
  escrowContract: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  quoteSelector: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  fulfillmentVerifierAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};
const TRUSTED_ROLES: Record<string, TrustedRoles> = {
  [SOURCE_NETWORK]: {
    ...EVM_ROLES,
    tokens: [{ symbol: 'USDC', address: SOURCE_ASSET, decimals: 6 }],
  },
  [DEST_NETWORK]: {
    ...EVM_ROLES,
    tokens: [
      { symbol: 'USDC', address: DEST_ASSET, decimals: 6 },
      { symbol: 'USDC', address: DEST_ASSET_18, decimals: 18 },
    ],
  },
};
const trust: TrustResolver = async (network) => {
  const roles = TRUSTED_ROLES[network];
  if (roles === undefined) throw new Error(`no trusted roles declared for ${network}`);
  return roles;
};

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

const RESOURCE_URL = 'https://api.example.com/report';
const RESOURCE = { url: RESOURCE_URL, method: 'GET' } as never;
/** The HTTP request the 402 answers, as core's HTTP layer passes it to the scheme. */
const HTTP_GET = httpRequest(RESOURCE_URL);
const PURCHASE_ID = 'pay_order_test_0001';
const SIGNED_AT = Date.parse('2026-07-08T12:00:00Z');
// Just after signing, so the payment's deadlines are still ahead when it is verified.
const VERIFIED_AT = Date.parse('2026-07-08T12:00:10Z');

// A gateway that always settles synchronously: a completed payment with its transactions.
const okSubmitter: PaymentSubmitter = {
  submit: async () => ({
    payment_id: 'pay_abc',
    status: 'completed',
    transactions: {
      deposit: { transaction_hash: '0x' + 'cd'.repeat(32), chain_id: SOURCE_NETWORK },
      fulfillment: { transaction_hash: '0x' + 'ab'.repeat(32), chain_id: DEST_NETWORK },
    },
  }),
};

/** Core's facilitator with the atum-escrow mechanism, exposed through the client interface. */
function localFacilitator(): FacilitatorClient {
  const facilitator = new x402Facilitator().register(
    SOURCE_NETWORK,
    new AtumEscrowFacilitatorScheme({ submitter: okSubmitter, now: () => VERIFIED_AT, trust }),
  );
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as never,
  };
}

/** A resource server with the scheme registered and the facilitator's supported kinds loaded. */
async function initializedServer(
  serverConfig: AtumEscrowServerConfig = config,
): Promise<x402ResourceServer> {
  const server = new x402ResourceServer(localFacilitator()).register(
    SOURCE_NETWORK,
    new AtumEscrowServerScheme(serverConfig),
  );
  await server.initialize();
  return server;
}

/** The route's payment options, as a merchant declares them; only the price varies. */
function routeOptions(price: Price) {
  return [
    { scheme: 'atum-escrow', network: SOURCE_NETWORK, payTo: '', price, maxTimeoutSeconds: 60 },
  ];
}

/**
 * Advertises a route priced with `atumEscrowPrice(serverConfig)`, has the payer sign for it, then
 * matches, verifies and settles that payment against a fresh build of the same route. Returns the
 * advertised 402 so a caller can assert what the payer was asked for.
 */
async function carryPayment(serverConfig: AtumEscrowServerConfig) {
  const server = await initializedServer(serverConfig);
  const options = routeOptions(atumEscrowPrice(serverConfig));
  const advertised = await server.createPaymentRequiredResponse(
    await server.buildPaymentRequirementsFromOptions(options, undefined),
    RESOURCE,
    undefined,
    { [PAYMENT_IDENTIFIER]: { info: { required: true, id: PURCHASE_ID } } },
    HTTP_GET,
  );

  const client = new x402Client().register(
    SOURCE_NETWORK,
    new AtumEscrowClientScheme({ signer: wallet, now: () => SIGNED_AT, trust }),
  );
  // Through a JSON round trip, because that is what the wire does to the payment.
  const payload = JSON.parse(
    JSON.stringify(await client.createPaymentPayload(advertised)),
  ) as PaymentPayload;

  // The merchant keeps nothing between requests: it rebuilds the route's 402 for the paid request,
  // as core's HTTP layer does, and matches the echo against it.
  const rebuilt = await server.createPaymentRequiredResponse(
    await server.buildPaymentRequirementsFromOptions(options, undefined),
    RESOURCE,
    undefined,
    { [PAYMENT_IDENTIFIER]: { info: { required: true, id: PURCHASE_ID } } },
    HTTP_GET,
  );
  const match = server.findMatchingRequirements(rebuilt.accepts, payload) as PaymentRequirements;
  expect(match).toBeDefined();

  const verified = await server.verifyPayment(payload, match);
  expect(verified.isValid, JSON.stringify(verified)).toBe(true);
  const settled = await server.settlePayment(payload, match);
  expect(settled.success, JSON.stringify(settled)).toBe(true);
  return advertised;
}

describe('a route priced through the real x402 resource server', () => {
  it('builds the same 402 from atumEscrowPrice as the scheme builds directly', async () => {
    const server = await initializedServer();
    const accepts = await server.buildPaymentRequirementsFromOptions(
      routeOptions(atumEscrowPrice(config)),
      undefined,
    );
    const response = await server.createPaymentRequiredResponse(
      accepts,
      RESOURCE,
      undefined,
      undefined,
      HTTP_GET,
    );

    // The scheme's own build, which a route priced with atumEscrowPrice must reproduce.
    const { requirement: direct } = await buildRequirement(
      new AtumEscrowServerScheme(config),
      {
        scheme: 'atum-escrow',
        network: SOURCE_NETWORK,
        asset: SOURCE_ASSET,
        amount: '10300000',
        payTo: '',
        maxTimeoutSeconds: 60,
        extra: {},
      },
      RESOURCE_URL,
    );
    expect(response.accepts).toEqual([direct]);
    expect(response.accepts[0]!.asset).toBe(SOURCE_ASSET);
    expect(response.accepts[0]!.amount).toBe('10300000');
    expect(response.accepts[0]!.payTo).toBe(config.sources[SOURCE_NETWORK].escrow);
  });

  it('carries a payment for that 402 through match, verify and settle', async () => {
    await carryPayment(config);
  });

  it('carries a payment through match, verify and settle on an 18-to-6-decimal corridor, capped in source units', async () => {
    // The fulfillment is in destination atoms and the cap the payer funds is in source atoms, so
    // across differing decimals the cap must be converted: floor(F × (10000 + bps) × 10^s /
    // (10000 × 10^d)). Stated in destination atoms it would ask for 10^12 times too much, and the
    // payer's own bound, priced from its trusted decimals, would refuse the 402.
    const expectedCap =
      (BigInt(config18.fulfillmentAmount) *
        (10000n + BigInt(config18.markupBps)) *
        10n ** BigInt(config18.sources[SOURCE_NETWORK].decimals)) /
      (10000n * 10n ** BigInt(config18.destination.decimals));
    expect(expectedCap.toString()).toBe('10300000');

    const advertised = await carryPayment(config18);
    expect(advertised.accepts).toHaveLength(1);
    expect(advertised.accepts[0]!.asset).toBe(SOURCE_ASSET);
    expect(advertised.accepts[0]!.amount).toBe(expectedCap.toString());
    const atum = (advertised.accepts[0]!.extra as { atum: Record<string, unknown> }).atum;
    expect(atum.fulfillmentAmount).toBe(config18.fulfillmentAmount);
    expect(atum.destination).toEqual({
      network: DEST_NETWORK,
      asset: DEST_ASSET_18,
      address: config18.destination.address,
    });
  });

  it('refuses to build a route priced with a placeholder Money string', async () => {
    const server = await initializedServer();
    const err = await rejectionOf(
      server.buildPaymentRequirementsFromOptions(routeOptions('$0.10'), undefined),
    );
    expectConfigError(err, 'PRICE_CONFLICT', SOURCE_NETWORK);
  });
});
