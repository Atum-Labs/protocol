/**
 * Integration test against the REAL `@x402/core` resource server.
 *
 * The other server tests call the scheme's hooks directly, which bypasses the one thing that
 * constrains them: after `enrichPaymentRequiredResponse` runs, core asserts an additive-only
 * mutation policy (`assertAcceptsAdditiveExtraAfterSchemeEnrich`) against a `structuredClone`
 * baseline. Under that policy the `accepts` length is frozen, `payTo`/`amount`/`asset` are
 * immutable, and an `extra` key that already exists may be neither removed nor changed — only
 * brand-new keys may be added, and only on the accepts matching this scheme.
 *
 * `extra.atum` is built in `enhancePaymentRequirements`, which runs before that baseline is
 * taken, so the enrich hook leaves it alone and only adds the new `extra.atumResource` key. The
 * policy is what makes that the only safe arrangement: a hook that re-stamped the block — the
 * natural-looking "refresh it here" change — would be changing a key that already exists, and
 * core would reject the whole 402. Core also runs the hook once per accept and lets only that
 * accept's scheme and network gain keys, which a 402 offering several networks exercises. A
 * hand-rolled fake cannot catch those regressions; only driving real core can, so this file does.
 */
import { describe, it, expect } from 'vitest';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentRequirements } from '@x402/core/types';
import { AtumEscrowServerScheme, atumEscrowPrice, type AtumEscrowServerConfig } from './index';
import { httpRequest } from './test-support';

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

const RESOURCE = { url: 'https://example.test/paid' } as never;

/**
 * A resource server with the scheme registered. No facilitator client is needed:
 * `createPaymentRequiredResponse` takes pre-built requirements, so the supported-kinds
 * lookup (which would require `initialize()`) is not on this path.
 */
function resourceServer(scheme: AtumEscrowServerScheme): x402ResourceServer {
  return new x402ResourceServer().register(SOURCE_NETWORK as never, scheme);
}

async function baseRequirement(scheme: AtumEscrowServerScheme): Promise<PaymentRequirements> {
  const priced = await scheme.parsePrice(atumEscrowPrice(config), SOURCE_NETWORK as never);
  return scheme.enhancePaymentRequirements({
    scheme: 'atum-escrow',
    network: SOURCE_NETWORK as never,
    asset: priced.asset,
    amount: priced.amount,
    payTo: '',
    maxTimeoutSeconds: 60,
    extra: {},
  });
}

const atumOf = (r: PaymentRequirements) => (r.extra as { atum: Record<string, unknown> }).atum;
const identifierOf = (response: { extensions?: Record<string, unknown> }) =>
  (response.extensions?.['payment-identifier'] as { info: { required?: boolean; id?: string } })
    .info;

describe('enrichPaymentRequiredResponse under the real x402 mutation policy', () => {
  it('builds a complete 402 without tripping the policy', async () => {
    const scheme = new AtumEscrowServerScheme(config);
    const response = await resourceServer(scheme).createPaymentRequiredResponse(
      [await baseRequirement(scheme)],
      RESOURCE,
    );

    expect(response.accepts).toHaveLength(1);
    // The block really is complete — this is the 402 a payer receives.
    expect(atumOf(response.accepts[0]!).escrow).toBe(config.sources[SOURCE_NETWORK].escrow);
    expect(response.accepts[0]!.payTo).toBe(config.sources[SOURCE_NETWORK].escrow);
    // …and it asks the payer to name the purchase it is paying for.
    expect(identifierOf(response).required).toBe(true);
  });

  it('declares the extension on a response that had no extensions at all', async () => {
    // The declaration has to be created, not merely amended: core only populates
    // `response.extensions` when the caller passed some in.
    const scheme = new AtumEscrowServerScheme(config);
    const response = await resourceServer(scheme).createPaymentRequiredResponse(
      [await baseRequirement(scheme)],
      RESOURCE,
      undefined,
      undefined,
    );
    expect(identifierOf(response).required).toBe(true);
    expect(identifierOf(response).id).toBeUndefined();
  });

  it('keeps an identifier the resource server declared for itself', async () => {
    // A merchant that tracks the purchase server-side can name it in the 402. Core treats a
    // declared value as authoritative, so the scheme must not re-declare over it.
    const scheme = new AtumEscrowServerScheme(config);
    const response = await resourceServer(scheme).createPaymentRequiredResponse(
      [await baseRequirement(scheme)],
      RESOURCE,
      undefined,
      { 'payment-identifier': { info: { required: true, id: 'order_4711_a1b2c3d4' } } },
    );
    expect(identifierOf(response).id).toBe('order_4711_a1b2c3d4');
    expect(identifierOf(response).required).toBe(true);
  });

  it('forces required back to true when the resource server declared it false', async () => {
    // `required` is not the resource server's to choose. The client refuses a payment with no
    // identifier and the facilitator refuses to verify one, so a 402 advertising an OPTIONAL
    // identifier would be advertising something no part of the scheme honours — the payer would
    // follow the 402, omit the identifier, and be refused by the very server that said it was
    // optional. Merged field-by-field so a declared id still survives alongside the correction.
    const scheme = new AtumEscrowServerScheme(config);
    const response = await resourceServer(scheme).createPaymentRequiredResponse(
      [await baseRequirement(scheme)],
      RESOURCE,
      undefined,
      { 'payment-identifier': { info: { required: false, id: 'order_4711_a1b2c3d4' } } },
    );
    expect(identifierOf(response).required).toBe(true);
    expect(identifierOf(response).id).toBe('order_4711_a1b2c3d4');
  });

  it('survives a Solana source, and its block holds nothing a rebuild cannot reproduce', async () => {
    // A Solana block is where a clock reading would be reintroduced if anyone ever "refreshed"
    // it here, so the block is asserted to be a pure function of configuration.
    //
    // The clock ADVANCES on every read on purpose. Held at a fixed instant, a field derived from
    // it would look reproducible and this test would pass while production failed whenever two
    // builds landed either side of a second boundary. Advancing it makes any such field visible.
    const SOLANA_NETWORK = 'solana:localnet';
    const solanaConfig: AtumEscrowServerConfig = {
      ...config,
      now: (() => {
        let t = Date.parse('2026-07-08T12:00:00Z');
        return () => (t += 5_000);
      })(),
      reserver: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
      releaser: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
      sources: {
        [SOLANA_NETWORK]: {
          asset: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
          escrow: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
          symbol: 'USDC',
          decimals: 6,
          svmSignatureClusterId: 'localnet',
          svmSignatureDomainVersion: 5,
        },
      },
    };
    const scheme = new AtumEscrowServerScheme(solanaConfig);
    const priced = await scheme.parsePrice(atumEscrowPrice(solanaConfig), SOLANA_NETWORK as never);
    const base = await scheme.enhancePaymentRequirements({
      scheme: 'atum-escrow',
      network: SOLANA_NETWORK as never,
      asset: priced.asset,
      amount: priced.amount,
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    });
    const response = await new x402ResourceServer()
      .register(SOLANA_NETWORK as never, scheme)
      .createPaymentRequiredResponse([base], RESOURCE);

    const atum = atumOf(response.accepts[0]!);
    expect(atum.svmSignatureClusterId).toBe('localnet');
    expect(atum.svmSignatureDomainVersion).toBe(5);
    // Rebuilt under the same advancing clock, the block is byte-identical. This is the property
    // core's echo matcher depends on, asserted against the whole block rather than one field, so
    // any future clock-derived addition trips it.
    const rebuilt = await scheme.enhancePaymentRequirements({
      scheme: 'atum-escrow',
      network: SOLANA_NETWORK as never,
      asset: priced.asset,
      amount: priced.amount,
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    });
    expect(atumOf(rebuilt)).toStrictEqual(atum);
  });

  /**
   * Negative control. Without this, the tests above could pass vacuously — if core stopped
   * enforcing the policy, or if this suite were not really reaching it, nothing would notice.
   * These two cases reproduce the changes the design rules out and assert core rejects them,
   * which is what makes the assertions above meaningful.
   */
  describe('the rejected designs really are rejected by core', () => {
    it('throws if the enrich hook TOUCHES the extra.atum block built upstream', async () => {
      // The regression this guards against is a hook that "refreshes" the block it was handed —
      // the reason the scheme returns its accepts untouched instead.
      class RestampingScheme extends AtumEscrowServerScheme {
        override async enrichPaymentRequiredResponse(ctx: never): Promise<PaymentRequirements[]> {
          const context = ctx as unknown as { requirements: PaymentRequirements[] };
          return context.requirements.map((req) => ({
            ...req,
            extra: { ...req.extra, atum: { ...atumOf(req), issuedAt: '1780000000' } },
          }));
        }
      }
      const scheme = new RestampingScheme(config);
      await expect(
        resourceServer(scheme).createPaymentRequiredResponse(
          [await baseRequirement(scheme)],
          RESOURCE,
        ),
      ).rejects.toThrow(/extra\["atum"\] may not be changed/);
    });

    it('throws if the hook DROPS a requirement (so refusal cannot be expressed that way)', async () => {
      class DroppingScheme extends AtumEscrowServerScheme {
        override async enrichPaymentRequiredResponse(): Promise<PaymentRequirements[]> {
          return [];
        }
      }
      const scheme = new DroppingScheme(config);
      await expect(
        resourceServer(scheme).createPaymentRequiredResponse(
          [await baseRequirement(scheme)],
          RESOURCE,
        ),
      ).rejects.toThrow(/accepts length changed/);
    });
  });

  it('binds every atum-escrow accept to the page across several networks', async () => {
    // Two source networks, a second accept on the first network, and a foreign accept between
    // them: each atum-escrow call may only add the key to the accept it is for.
    const OTHER_NETWORK = 'eip155:10';
    const multi: AtumEscrowServerConfig = {
      ...config,
      sources: {
        ...config.sources,
        [OTHER_NETWORK]: {
          asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
          escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
          symbol: 'USDC',
          decimals: 6,
        },
      },
    };
    const scheme = new AtumEscrowServerScheme(multi);
    const build = async (network: string) => {
      const priced = await scheme.parsePrice(atumEscrowPrice(multi), network as never);
      return scheme.enhancePaymentRequirements({
        scheme: 'atum-escrow',
        network: network as never,
        asset: priced.asset,
        amount: priced.amount,
        payTo: '',
        maxTimeoutSeconds: 60,
        extra: {},
      });
    };
    const foreign: PaymentRequirements = {
      scheme: 'exact',
      network: SOURCE_NETWORK as never,
      asset: SOURCE_ASSET,
      amount: '10300000',
      payTo: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      maxTimeoutSeconds: 60,
      extra: { somethingElse: true },
    };
    const sameNetworkTwice = { ...(await build(SOURCE_NETWORK)), maxTimeoutSeconds: 120 };
    const response = await new x402ResourceServer()
      .register(SOURCE_NETWORK as never, scheme)
      .register(OTHER_NETWORK as never, scheme)
      .createPaymentRequiredResponse(
        [await build(SOURCE_NETWORK), sameNetworkTwice, foreign, await build(OTHER_NETWORK)],
        RESOURCE,
        undefined,
        undefined,
        httpRequest('https://example.test/paid?v=2'),
      );

    expect(response.accepts).toHaveLength(4);
    expect(response.accepts[0]!.extra.atumResource).toBe('GET /paid?{"v":"2"}');
    expect(response.accepts[1]!.extra.atumResource).toBe('GET /paid?{"v":"2"}');
    expect(response.accepts[2]!.extra).toEqual({ somethingElse: true });
    expect(response.accepts[3]!.extra.atumResource).toBe('GET /paid?{"v":"2"}');
    expect(atumOf(response.accepts[3]!).escrow).toBe(multi.sources[OTHER_NETWORK]!.escrow);
  });

  it('binds to the live request, not the route resource core put in resourceInfo', async () => {
    const scheme = new AtumEscrowServerScheme(config);
    const response = await resourceServer(scheme).createPaymentRequiredResponse(
      [await baseRequirement(scheme)],
      { url: 'https://example.test/configured-route' } as never,
      undefined,
      undefined,
      httpRequest('https://h.test/b'),
    );
    expect(response.accepts[0]!.extra.atumResource).toBe('GET /b');
  });

  it("leaves a foreign scheme's accept untouched when both are offered", async () => {
    // Core throws if a non-matching accept receives new extra fields, so this asserts the
    // scheme's own restraint, enforced by core rather than by our fake.
    const scheme = new AtumEscrowServerScheme(config);
    const foreign: PaymentRequirements = {
      scheme: 'exact',
      network: SOURCE_NETWORK as never,
      asset: SOURCE_ASSET,
      amount: '10300000',
      payTo: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      maxTimeoutSeconds: 60,
      extra: { somethingElse: true },
    };
    const response = await resourceServer(scheme).createPaymentRequiredResponse(
      [foreign, await baseRequirement(scheme)],
      RESOURCE,
    );

    expect(response.accepts).toHaveLength(2);
    expect(response.accepts[0]!.extra).toEqual({ somethingElse: true });
    expect(atumOf(response.accepts[1]!).escrow).toBe(config.sources[SOURCE_NETWORK].escrow);
  });
});
