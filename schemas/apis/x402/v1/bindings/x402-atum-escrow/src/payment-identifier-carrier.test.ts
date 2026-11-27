/**
 * The purchase identifier's round trip, driven through the REAL `@x402/core` client and resource
 * server rather than hand-rolled doubles.
 *
 * The identifier is the payment's identity, so what matters is not only that each side reads and
 * writes the right shape but that the framework sitting between them preserves it. Three framework
 * behaviours are load-bearing and none of them can be verified against a fake:
 *
 *   - the resource server publishes the scheme's declaration in the 402
 *   - the client merges the payer's identifier onto that declaration rather than replacing it
 *   - the resource server accepts the merged result, having advertised only part of it
 *
 * A hand-written double would agree with whatever this package happens to do; only real core can
 * show that a third party would agree too.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { x402Client } from '@x402/core/client';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { AtumEscrowServerScheme, type AtumEscrowServerConfig } from './server';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from './client';
import { atumEscrowRequestId } from './request-id';
import { httpRequest } from './server/test-support';
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifier,
  echoPaymentIdentifier,
} from './payment-identifier';

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

/**
 * The roles this file's fixtures advertise, declared per chain as what the payer trusts. The
 * client refuses a 402 whose roles differ from its trust source, so each fixture states what it
 * expects to be trusted rather than reaching a live gateway. A source chain is checked on its
 * escrow, reserver and releaser and a destination chain only on its fulfillment proxy; every
 * field repeats the fixture's own value for that chain, and `tokens` lists the asset the
 * fixture moves there, so the payer's markup bound can price the corridor.
 */
const EVM_ROLES: Omit<TrustedRoles, 'tokens'> = {
  escrowContract: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  quoteSelector: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  fulfillmentVerifierAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};
const TRUSTED_ROLES: Record<string, TrustedRoles> = {
  'eip155:8453': {
    ...EVM_ROLES,
    tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    ],
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

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

/** A well-formed identifier: 23 characters, letters/digits/underscore. */
const ID = 'pay_order_4711_a1b2c3d4';
/** A second purchase, for the "two purchases stay distinct" property. */
const OTHER_ID = 'pay_order_4712_a1b2c3d4';

const baseOption = {
  scheme: 'atum-escrow',
  network: SOURCE_NETWORK,
  asset: SOURCE_ASSET,
  amount: '10300000',
  payTo: '',
  maxTimeoutSeconds: 60,
  extra: {},
} as const;

/**
 * Build a 402 the way the real resource server does: the scheme shapes each accept first
 * (`enhancePaymentRequirements`, as x402's middleware would), then core assembles the response.
 */
async function build402(
  declaredExtensions?: Record<string, unknown>,
): Promise<{ server: x402ResourceServer; paymentRequired: PaymentRequired }> {
  const scheme = new AtumEscrowServerScheme(config);
  const server = new x402ResourceServer();
  server.register(SOURCE_NETWORK, scheme);
  const paymentRequired = await server.createPaymentRequiredResponse(
    [await scheme.enhancePaymentRequirements({ ...baseOption } as PaymentRequirements)],
    { url: 'https://api.example.com/report', method: 'GET' } as never,
    undefined,
    declaredExtensions,
    httpRequest('https://api.example.com/report'),
  );
  return { server, paymentRequired };
}

/** Pay a 402 through the real client, returning the payload it produced. */
async function pay(paymentRequired: PaymentRequired): Promise<PaymentPayload> {
  const client = new x402Client();
  client.register(
    SOURCE_NETWORK,
    new AtumEscrowClientScheme({
      signer: wallet,
      now: () => Date.parse('2026-07-08T12:00:00Z'),
      trust,
    }),
  );
  return client.createPaymentPayload(paymentRequired);
}

/** The identifier a payload ended up carrying on the wire. */
function idOnWire(payload: PaymentPayload): unknown {
  const entry = payload.extensions?.[PAYMENT_IDENTIFIER] as { info?: { id?: unknown } } | undefined;
  return entry?.info?.id;
}

/** The `request_id` inside a payload's payment request. */
function requestIdOf(payload: PaymentPayload): string {
  return (payload.payload as { paymentRequest: { request_id: string } }).paymentRequest.request_id;
}

describe('purchase identifier — what the resource server advertises', () => {
  it('declares the extension as required, so a payer knows an identifier is expected', async () => {
    const { paymentRequired } = await build402();
    expect(paymentRequired.extensions?.[PAYMENT_IDENTIFIER]).toEqual(
      declarePaymentIdentifier(true),
    );
  });

  it('declares it even when the resource server passed no extensions of its own', async () => {
    // The scheme is responsible for the declaration, so a merchant needs no extra wiring to be safe.
    const { paymentRequired } = await build402(undefined);
    expect(paymentRequired.extensions?.[PAYMENT_IDENTIFIER]).toBeDefined();
  });

  it('leaves alongside any unrelated extension the resource server declared', async () => {
    const { paymentRequired } = await build402({ 'some-other-extension': { info: { a: 1 } } });
    expect(paymentRequired.extensions?.['some-other-extension']).toEqual({ info: { a: 1 } });
    expect(paymentRequired.extensions?.[PAYMENT_IDENTIFIER]).toBeDefined();
  });

  it('does not overwrite an identifier the resource server declared itself', async () => {
    // A resource server that already tracks the purchase may name it. The framework treats a
    // declared value as authoritative, so re-declaring here would discard it.
    const declared = { [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } } };
    const { paymentRequired } = await build402(declared);
    expect(
      (paymentRequired.extensions?.[PAYMENT_IDENTIFIER] as { info: { id: string } }).info.id,
    ).toBe(ID);
  });
});

describe("purchase identifier — the payer's round trip through real core", () => {
  it('derives request_id from an identifier the resource server declared', async () => {
    const { paymentRequired } = await build402({
      [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } },
    });
    const payload = await pay(paymentRequired);
    expect(requestIdOf(payload)).toBe(atumEscrowRequestId(ID, wallet.address, 'GET /report'));
  });

  it('echoes the identifier on the wire so the facilitator can re-derive from the same value', async () => {
    const { paymentRequired } = await build402({
      [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } },
    });
    expect(idOnWire(await pay(paymentRequired))).toBe(ID);
  });

  it("keeps the resource server's own fields intact through the framework merge", async () => {
    // A payer may add to a declaration but never remove or overwrite it. If the echo replaced the
    // declaration instead of merging onto it, `required` would be lost here.
    const { paymentRequired } = await build402({
      [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } },
    });
    const entry = (await pay(paymentRequired)).extensions?.[PAYMENT_IDENTIFIER] as {
      info: { required?: boolean; id?: string };
    };
    expect(entry.info.required).toBe(true);
    expect(entry.info.id).toBe(ID);
  });

  it("passes the resource server's own echo validation", async () => {
    // The end-to-end property: the resource server advertised only part of what came back, and it
    // must accept the payer's addition rather than reject it as a tampered echo.
    const { server, paymentRequired } = await build402({
      [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } },
    });
    const payload = await pay(paymentRequired);
    expect(server.validateExtensions(paymentRequired, payload)).toEqual({ valid: true });
  });

  it('re-attempting the same purchase reproduces the same request_id', async () => {
    // The whole point. A re-attempt re-fetches the resource and gets a FRESH 402; as long as the
    // purchase identifier is the same, the rebuilt payment has the same identity.
    const first = await pay(
      (await build402({ [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } } }))
        .paymentRequired,
    );
    const second = await pay(
      (await build402({ [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } } }))
        .paymentRequired,
    );
    expect(requestIdOf(second)).toBe(requestIdOf(first));
  });

  it('two distinct purchases get distinct request_ids', async () => {
    const a = await pay(
      (await build402({ [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } } }))
        .paymentRequired,
    );
    const b = await pay(
      (await build402({ [PAYMENT_IDENTIFIER]: { info: { required: true, id: OTHER_ID } } }))
        .paymentRequired,
    );
    expect(requestIdOf(a)).not.toBe(requestIdOf(b));
  });

  it('refuses to pay a 402 that names no purchase identifier', async () => {
    // Fail-closed, and it must fail at build time rather than producing a payment whose retry
    // would be charged again. The scheme declares `required: true`, and no identifier is supplied
    // here by either side.
    const { paymentRequired } = await build402();
    await expect(pay(paymentRequired)).rejects.toThrow(/no purchase identifier/i);
  });

  it('refuses a declared identifier the extension does not permit', async () => {
    // "order-4711" is a plausible order id and an invalid payment identifier — too short. The payer
    // cannot substitute one, so it must say so rather than fail later for an unrelated reason.
    const { paymentRequired } = await build402({
      [PAYMENT_IDENTIFIER]: { info: { required: true, id: 'order-4711' } },
    });
    await expect(pay(paymentRequired)).rejects.toThrow(/cannot use/i);
  });
});

describe("purchase identifier — the scheme's own returned extensions", () => {
  it('returns the identifier for merging, independently of what was declared', async () => {
    // Asserted on the scheme's direct return value rather than on the finished payload, because the
    // framework merges the payer's extensions onto the server's declarations: when the identifier
    // was declared, it reaches the wire either way, and an assertion on the payload alone would
    // pass even if the scheme returned nothing. This pins the scheme's own half of the contract, so
    // it stays correct for a caller that does not pre-merge the value.
    const scheme = new AtumEscrowClientScheme({
      signer: wallet,
      now: () => Date.parse('2026-07-08T12:00:00Z'),
      trust,
    });
    const { paymentRequired } = await build402();
    const result = await scheme.createPaymentPayload(2, paymentRequired.accepts[0]!, {
      extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id: ID } } },
    });
    expect(result.extensions).toEqual(echoPaymentIdentifier(ID));
  });
});

describe('purchase identifier — a payer that supplies its own, with nothing declared', () => {
  it("is accepted by the resource server's echo validation", async () => {
    // The ordinary case: the scheme declares `required` only, and the payer contributes the
    // identifier itself. Asserted through real core so the addition is provably not read as a
    // tampered echo — the case a payer-supplied identifier depends on entirely.
    const { server, paymentRequired } = await build402();
    const withPayerIdentifier: PaymentRequired = {
      ...paymentRequired,
      extensions: {
        ...paymentRequired.extensions,
        [PAYMENT_IDENTIFIER]: {
          ...(paymentRequired.extensions?.[PAYMENT_IDENTIFIER] as object),
          info: {
            ...(paymentRequired.extensions?.[PAYMENT_IDENTIFIER] as { info: object }).info,
            id: ID,
          },
        },
      },
    };
    const payload = await pay(withPayerIdentifier);

    expect(requestIdOf(payload)).toBe(atumEscrowRequestId(ID, wallet.address, 'GET /report'));
    expect(idOnWire(payload)).toBe(ID);
    expect(server.validateExtensions(paymentRequired, payload)).toEqual({ valid: true });
  });
});
