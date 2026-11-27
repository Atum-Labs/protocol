/**
 * Unit tests for the atum-escrow server scheme. Structural conformance of the
 * emitted `extra.atum` to the published schema is enforced at compile time (the
 * block is typed as the schema-generated `AtumEscrowExtra`); these tests cover the
 * behavior: the markup math, that `payTo` points at the escrow, and that the
 * corridor config is carried through faithfully.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import type { Network, PaymentRequirements, SchemeNetworkServer } from '@x402/core/types';
import {
  AtumEscrowConfigError,
  AtumEscrowServerScheme,
  DEFAULT_PEG_GROUPS as SERVER_DEFAULT_PEG_GROUPS,
  atumEscrowPrice,
  registerAtumEscrowScheme,
  type AtumEscrowServerConfig,
} from './index';
import {
  buildRequirement,
  expectConfigError,
  expressTransport,
  httpRequest,
  rejectionOf,
  thrownBy,
  type ExpressLikeRequest,
} from './test-support';
import { assertCapWithinBound } from '../client/cap';
import { AtumEscrowTrustError } from '../client/trust';
import { DEFAULT_PEG_GROUPS as CLIENT_DEFAULT_PEG_GROUPS } from '../client';
import { DEFAULT_PEG_GROUPS } from '../peg';

const SOURCE_NETWORK = 'eip155:8453';
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
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      symbol: 'USDC',
      decimals: 6,
    },
  },
};

const scheme = new AtumEscrowServerScheme(config);

describe('AtumEscrowServerScheme', () => {
  it('prices the source cap as fulfillmentAmount + markup, in the source asset', async () => {
    const { asset, amount } = await scheme.parsePrice(atumEscrowPrice(config), SOURCE_NETWORK);
    expect(asset).toBe(config.sources[SOURCE_NETWORK].asset);
    expect(amount).toBe('10300000'); // 10_000_000 * (1 + 300/10000)
  });

  it('points payTo at the source escrow and attaches the extra.atum block', async () => {
    const base: PaymentRequirements = {
      scheme: 'atum-escrow',
      network: SOURCE_NETWORK,
      asset: config.sources[SOURCE_NETWORK].asset,
      amount: '10300000',
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const { requirement: enhanced } = await buildRequirement(scheme, base);

    expect(enhanced.payTo).toBe(config.sources[SOURCE_NETWORK].escrow);

    const atum = (enhanced.extra as { atum: Record<string, unknown> }).atum;
    expect(atum.escrow).toBe(config.sources[SOURCE_NETWORK].escrow);
    // The destination's symbol and decimals are merchant-side config for the peg check, not
    // part of the wire block; only the chain, token and receive address are carried.
    expect(atum.destination).toEqual({
      network: config.destination.network,
      asset: config.destination.asset,
      address: config.destination.address,
    });
    expect(atum.fulfillmentAmount).toBe('10000000');
    expect(atum.reserver).toBe(config.reserver);
    expect(atum.releaser).toBe(config.releaser);
    expect(atum.fulfillmentProxy).toBe(config.fulfillmentProxy);
  });

  it('rejects a network with no configured source option as SOURCE_NOT_CONFIGURED, naming it', async () => {
    const err = await rejectionOf(scheme.parsePrice(atumEscrowPrice(config), 'eip155:999999'));
    const configError = expectConfigError(err, 'SOURCE_NOT_CONFIGURED', 'eip155:999999');
    expect(configError.message).toMatch(/no source option/);
  });

  it('rejects a malformed config at construction', () => {
    expect(() => new AtumEscrowServerScheme({ ...config, reserver: 'not-an-address' })).toThrow(
      /invalid atum-escrow server config/,
    );
    expect(() => new AtumEscrowServerScheme({ ...config, markupBps: -5 })).toThrow(
      /invalid atum-escrow server config/,
    );
  });

  it('rejects a config whose quote deadline is not strictly before the fulfillment deadline', () => {
    // Both are positive ints, so the shape passes — only the relationship is wrong. Left
    // unchecked, the merchant boots and every payment fails (client build + facilitator both
    // require now < quote_deadline < fulfillment_deadline).
    expect(
      () =>
        new AtumEscrowServerScheme({
          ...config,
          quoteDeadlineSeconds: 300,
          fulfillmentDeadlineSeconds: 20,
        }),
    ).toThrow(/invalid atum-escrow server config.*(quote|fulfillment|deadline)/i);
    // Equal is also invalid (must be strictly less).
    expect(
      () =>
        new AtumEscrowServerScheme({
          ...config,
          quoteDeadlineSeconds: 60,
          fulfillmentDeadlineSeconds: 60,
        }),
    ).toThrow(/invalid atum-escrow server config/);
  });
});

/**
 * Declaring the purchase identifier. The identifier itself is the payer's to choose — these
 * tests pin that the merchant asks for one, says it is mandatory, never invents one, and never
 * discards an identifier a merchant that tracks the purchase itself has already declared.
 */
describe('AtumEscrowServerScheme — declaring the purchase identifier', () => {
  const base: PaymentRequirements = {
    scheme: 'atum-escrow',
    network: SOURCE_NETWORK,
    asset: config.sources[SOURCE_NETWORK].asset,
    amount: '10300000',
    payTo: '',
    maxTimeoutSeconds: 60,
    extra: {},
  };
  const identifierOf = (extensions: Record<string, unknown>) =>
    (extensions['payment-identifier'] as { info: { required?: boolean; id?: string } }).info;

  it('declares the payment-identifier extension as required', async () => {
    // Declaring it is what tells a payer — including one that knows nothing about this scheme —
    // that a payment without an identifier will be refused.
    const { extensions } = await buildRequirement(scheme, base);
    expect(identifierOf(extensions).required).toBe(true);
  });

  it("publishes the identifier's schema alongside the declaration", async () => {
    // So a payer can validate what it is being asked for without knowing this scheme.
    const { extensions } = await buildRequirement(scheme, base);
    const declaration = extensions['payment-identifier'] as { schema?: { properties?: unknown } };
    expect(declaration.schema).toBeDefined();
    expect(
      (declaration.schema as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty('id');
  });

  it('never names the purchase itself', async () => {
    // Guards against a well-meaning "just generate one" regression. A merchant-invented
    // identifier looks like an idempotency key but is stable only for a payer that reuses one
    // 402, so any payer whose re-attempt re-fetches the 402 gets a second payment.
    const a = await buildRequirement(scheme, base);
    const b = await buildRequirement(scheme, base);
    expect(identifierOf(a.extensions).id).toBeUndefined();
    expect(identifierOf(b.extensions).id).toBeUndefined();
  });

  it('leaves a declaration the merchant already made untouched', async () => {
    // A merchant that tracks the purchase server-side may name it in the 402 itself. The
    // framework treats a declared value as authoritative — a payer may add to it but not
    // overwrite it — so re-declaring here would discard the merchant's own identifier.
    const declared = {
      'payment-identifier': { info: { required: true, id: 'order_4711_a1b2c3d4' } },
    };
    const enhanced = await scheme.enhancePaymentRequirements(base);
    const paymentRequiredResponse = { x402Version: 2, accepts: [enhanced], extensions: declared };
    await scheme.enrichPaymentRequiredResponse({
      requirements: [enhanced],
      resourceInfo: { url: 'https://example.test/paid' },
      paymentRequiredResponse,
    } as never);
    expect(identifierOf(paymentRequiredResponse.extensions).id).toBe('order_4711_a1b2c3d4');
  });

  it('leaves extra.atum as built and adds only the page the payment is bound to', async () => {
    // Core asserts an additive-only mutation policy on `extra` after this hook, so the atum block
    // must come back as the very object enhancePaymentRequirements built, never re-stamped.
    const enhanced = await scheme.enhancePaymentRequirements(base);
    const accepts = await scheme.enrichPaymentRequiredResponse({
      requirements: [enhanced],
      resourceInfo: { url: 'https://example.test/configured' },
      paymentRequiredResponse: { x402Version: 2, accepts: [enhanced] },
      transportContext: httpRequest('https://shop.example/a/b?q=1&r=%20x', 'post'),
    } as never);
    expect((accepts[0]!.extra as { atum: unknown }).atum).toBe(
      (enhanced.extra as { atum: unknown }).atum,
    );
    expect(Object.keys(accepts[0]!.extra)).toEqual(['atum', 'atumResource']);
    // The routed path and parsed query of the live request win over the route's configured resource.
    expect(accepts[0]!.extra.atumResource).toBe('POST /a/b?{"q":"1","r":" x"}');
  });

  const resourceFor = async (transportContext: unknown) => {
    const enhanced = await scheme.enhancePaymentRequirements(base);
    const accepts = await scheme.enrichPaymentRequiredResponse({
      requirements: [enhanced],
      resourceInfo: { url: 'https://example.test/configured' },
      paymentRequiredResponse: { x402Version: 2, accepts: [enhanced] },
      transportContext,
    } as never);
    return accepts[0]!.extra.atumResource;
  };
  const report = (id: unknown, more: Partial<ExpressLikeRequest> = {}) =>
    expressTransport({
      originalUrl: `/reports?id=${id}`,
      path: '/reports',
      query: { id },
      ...more,
    });

  it('reads the page from req.path and req.query, which is mount-relative', async () => {
    // app.use('/tenants/:id', paymentMiddleware): req.path drops the mount prefix.
    const mounted = expressTransport({
      originalUrl: '/tenants/7/report?id=1',
      path: '/report',
      query: { id: '1' },
    });
    expect(await resourceFor(mounted)).toBe('GET /report?{"id":"1"}');
  });

  it.each([
    ['X-Forwarded-Proto', { protocol: 'http://x/?id=1#' }],
    ['X-Forwarded-Proto blanking the query', { protocol: 'http://x/#' }],
    ['Host', { host: 'x/reports?id=1#' }],
    ['Host and X-Forwarded-Proto', { host: 'x\\y', protocol: 'https://a/b?' }],
  ])('ignores a hostile %s', async (_label, hostile) => {
    expect(await resourceFor(report('2', hostile))).toBe('GET /reports?{"id":"2"}');
  });

  it('gives ?id=1 and ?id=2 different pages, and the same request the same page', async () => {
    const one = await resourceFor(report('1'));
    expect(one).toBe('GET /reports?{"id":"1"}');
    expect(await resourceFor(report('2'))).not.toBe(one);
    expect(await resourceFor(report('1'))).toBe(one);
  });

  it('gives the same parameters in another key order the same page', async () => {
    const ab = expressTransport({
      originalUrl: '/r?a=1&b=2',
      path: '/r',
      query: { a: '1', b: { y: '2', x: '3' } },
    });
    const ba = expressTransport({
      originalUrl: '/r?b=2&a=1',
      path: '/r',
      query: { b: { x: '3', y: '2' }, a: '1' },
    });
    expect(await resourceFor(ab)).toBe('GET /r?{"a":"1","b":{"x":"3","y":"2"}}');
    expect(await resourceFor(ba)).toBe(await resourceFor(ab));
  });

  it('keeps the order of repeated parameters', async () => {
    const a12 = expressTransport({
      originalUrl: '/r?a=1&a=2',
      path: '/r',
      query: { a: ['1', '2'] },
    });
    const a21 = expressTransport({
      originalUrl: '/r?a=2&a=1',
      path: '/r',
      query: { a: ['2', '1'] },
    });
    expect(await resourceFor(a12)).toBe('GET /r?{"a":["1","2"]}');
    expect(await resourceFor(a21)).not.toBe(await resourceFor(a12));
  });

  it('reads a null-prototype query object', async () => {
    const query = Object.assign(Object.create(null) as Record<string, unknown>, { id: '1' });
    expect(await resourceFor(report('1', { query }))).toBe('GET /reports?{"id":"1"}');
  });

  it('binds a request without a query to the bare path', async () => {
    const bare = expressTransport({ originalUrl: '/reports', path: '/reports', query: {} });
    expect(await resourceFor(bare)).toBe('GET /reports');
  });

  it('refuses a URL with a query that the framework did not parse', async () => {
    // A disabled query parser would otherwise collapse every query onto one page.
    const unparsed = expressTransport({
      originalUrl: '/reports?id=1',
      path: '/reports',
      query: {},
    });
    const err = await rejectionOf(resourceFor(unparsed));
    expect((err as Error).message).toMatch(/has a query but none was parsed/);
  });

  it('binds a request without a query to the bare path when the Host header has a ?', async () => {
    const hostile = expressTransport({
      host: 'x?y',
      originalUrl: '/reports',
      path: '/reports',
      query: {},
    });
    expect(await resourceFor(hostile)).toBe('GET /reports');
  });

  it.each(['x?y', 'x/reports?id=1#', ''])(
    'refuses an unparsed query when the Host header is %j',
    async (host) => {
      const unparsed = expressTransport({
        host,
        originalUrl: '/reports?id=1',
        path: '/reports',
        query: {},
      });
      const err = await rejectionOf(resourceFor(unparsed));
      expect((err as Error).message).toMatch(/has a query but none was parsed/);
    },
  );

  it('refuses an unparsed query when the URL host is normalised and the query repeats the Host', async () => {
    // A WHATWG-style getUrl() lower-cases the host, so the Host only appears inside the query.
    const transport = expressTransport({
      host: 'SHOP.TEST',
      originalUrl: '/paid?item=a&x=://SHOP.TEST',
      path: '/paid',
      query: {},
    });
    transport.request.adapter.getUrl = () => 'http://shop.test/paid?item=a&x=://SHOP.TEST';
    const err = await rejectionOf(resourceFor(transport));
    expect((err as Error).message).toMatch(/has a query but none was parsed/);
  });

  it('binds a URL whose query is empty or only separators to the bare path', async () => {
    for (const suffix of ['?', '?&', '?&&']) {
      const empty = expressTransport({
        originalUrl: `/reports${suffix}`,
        path: '/reports',
        query: {},
      });
      expect(await resourceFor(empty)).toBe('GET /reports');
    }
  });

  it('refuses an HTTP adapter without getQueryParams', async () => {
    const context = report('1');
    const { getQueryParams: _dropped, ...adapter } = context.request.adapter;
    const err = await rejectionOf(resourceFor({ request: { ...context.request, adapter } }));
    expect((err as Error).message).toMatch(/no getQueryParams/);
  });

  it('counts the 2048 limit in UTF-8 bytes', async () => {
    // "é" is 2 bytes: `GET /` is 5, so 1021 of them plus one ASCII byte is exactly 2048.
    const atLimit = `/${'é'.repeat(1021)}a`;
    expect(new TextEncoder().encode(`GET ${atLimit}`).length).toBe(2048);
    expect(atLimit.length).toBeLessThan(2048);
    const page = expressTransport({ originalUrl: atLimit, path: atLimit, query: {} });
    expect(await resourceFor(page)).toBe(`GET ${atLimit}`);

    const over = `${atLimit}b`;
    const err = await rejectionOf(
      resourceFor(expressTransport({ originalUrl: over, path: over, query: {} })),
    );
    expect((err as Error).message).toMatch(/1 to 2048 UTF-8 bytes/);
  });

  it('refuses a route that sets extra.atumResource itself', async () => {
    const err = await rejectionOf(
      scheme.enhancePaymentRequirements({ ...base, extra: { atumResource: 'GET /elsewhere' } }),
    );
    expectConfigError(err, 'INVALID_CONFIG', SOURCE_NETWORK);
  });

  it('binds to resourceInfo.url when the 402 is not for an HTTP request', async () => {
    const enhanced = await scheme.enhancePaymentRequirements(base);
    const accepts = await scheme.enrichPaymentRequiredResponse({
      requirements: [enhanced],
      resourceInfo: { url: 'mcp://tools/report' },
      paymentRequiredResponse: { x402Version: 2, accepts: [enhanced] },
    } as never);
    expect(accepts[0]!.extra.atumResource).toBe('mcp://tools/report');
  });

  it('refuses to publish a 402 it cannot bind to a page', async () => {
    const enhanced = await scheme.enhancePaymentRequirements(base);
    const err = await rejectionOf(
      scheme.enrichPaymentRequiredResponse({
        requirements: [enhanced],
        resourceInfo: { url: '' },
        paymentRequiredResponse: { x402Version: 2, accepts: [enhanced] },
      } as never),
    );
    expect((err as Error).message).toMatch(/cannot bind the 402 to its page/);
  });

  it('does not touch accepts belonging to another scheme', async () => {
    // Core forbids adding extra fields to non-matching accepts, so a foreign entry must pass
    // through byte-identical.
    const foreign: PaymentRequirements = {
      scheme: 'exact',
      network: SOURCE_NETWORK,
      asset: config.sources[SOURCE_NETWORK].asset,
      amount: '10300000',
      payTo: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      maxTimeoutSeconds: 60,
      extra: { somethingElse: true },
    };
    const accepts = await scheme.enrichPaymentRequiredResponse({
      requirements: [foreign, await scheme.enhancePaymentRequirements(base)],
      resourceInfo: { url: 'https://example.test/paid' },
      paymentRequiredResponse: { x402Version: 2, accepts: [] },
    } as never);
    expect(accepts[0]).toEqual(foreign);
  });

  it('refuses to build an accept on a network this merchant offers no source for', async () => {
    // The atum block names a source escrow, so there is nothing to emit without one. Failing
    // here beats serving a 402 whose corridor data is missing.
    const err = await rejectionOf(
      scheme.enhancePaymentRequirements({ ...base, network: 'eip155:999999' }),
    );
    const configError = expectConfigError(err, 'SOURCE_NOT_CONFIGURED', 'eip155:999999');
    expect(configError.message).toMatch(/no source option/);
  });

  it('preserves a route-level extra instead of replacing it', async () => {
    // The atum block is merged in alongside whatever the merchant set on the route, so replacing
    // `extra` wholesale would discard the route's own fields.
    const withRouteExtra: PaymentRequirements = { ...base, extra: { routeHint: 'abc' } };
    const { requirement } = await buildRequirement(scheme, withRouteExtra);
    expect((requirement.extra as Record<string, unknown>).routeHint).toBe('abc');
    expect((requirement.extra as { atum: unknown }).atum).toBeDefined();
  });
});

describe('AtumEscrowServerScheme (Solana source)', () => {
  const SOLANA_NETWORK = 'solana:localnet';
  // A Solana → EVM corridor: base58 source-side roles/escrow, EVM destination.
  const solanaConfig: AtumEscrowServerConfig = {
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
    reserver: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
    releaser: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
    fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
    quoteDeadlineSeconds: 20,
    fulfillmentDeadlineSeconds: 300,
    // Pinned so a clock-derived field, were one ever added to the block, would still be
    // reproducible here and fail the assertions below rather than passing by luck.
    now: () => Date.parse('2026-07-08T12:00:00Z'),
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

  it('emits base58 roles and the svm signature-domain fields, and no issue time', async () => {
    const scheme = new AtumEscrowServerScheme(solanaConfig);
    const base: PaymentRequirements = {
      scheme: 'atum-escrow',
      network: SOLANA_NETWORK,
      asset: solanaConfig.sources[SOLANA_NETWORK].asset,
      amount: '10300000',
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const { requirement: enhanced } = await buildRequirement(scheme, base);
    const atum = (enhanced.extra as { atum: Record<string, unknown> }).atum;

    expect(enhanced.payTo).toBe(solanaConfig.sources[SOLANA_NETWORK].escrow);
    expect(atum.escrow).toBe(solanaConfig.sources[SOLANA_NETWORK].escrow);
    expect(atum.reserver).toBe(solanaConfig.reserver);
    expect(atum.releaser).toBe(solanaConfig.releaser);
    expect(atum.svmSignatureClusterId).toBe('localnet');
    expect(atum.svmSignatureDomainVersion).toBe(5);
    // The signature-domain fields are properties of the deployed escrow, so a rebuild reproduces
    // them. The deposit's issue time is not: it comes from a clock, the payer stamps it at signing
    // time, and a value here would make any payment crossing a second boundary unmatchable.
    expect(atum).not.toHaveProperty('issuedAt');
  });

  it('rejects a Solana source that is missing the svm signature-domain fields at construction', () => {
    // svm fields are optional on the shape, but a solana: source without them serves 402s
    // every client rejects ("Solana source requires svm_signature_cluster_id…"). Catch at boot.
    const noSvm = {
      ...solanaConfig,
      sources: {
        [SOLANA_NETWORK]: {
          asset: solanaConfig.sources[SOLANA_NETWORK].asset,
          escrow: solanaConfig.sources[SOLANA_NETWORK].escrow,
          symbol: solanaConfig.sources[SOLANA_NETWORK].symbol,
          decimals: solanaConfig.sources[SOLANA_NETWORK].decimals,
        },
      },
    } as AtumEscrowServerConfig;
    expect(() => new AtumEscrowServerScheme(noSvm)).toThrow(
      /invalid atum-escrow server config.*(svm|solana|signature)/i,
    );
  });

  it('does not emit svm fields or issuedAt for an EVM source', async () => {
    const scheme = new AtumEscrowServerScheme(config);
    const base: PaymentRequirements = {
      scheme: 'atum-escrow',
      network: SOURCE_NETWORK,
      asset: config.sources[SOURCE_NETWORK].asset,
      amount: '10300000',
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const { requirement: enhanced } = await buildRequirement(scheme, base);
    const atum = (enhanced.extra as { atum: Record<string, unknown> }).atum;
    expect(atum.svmSignatureClusterId).toBeUndefined();
    expect(atum.svmSignatureDomainVersion).toBeUndefined();
    expect(atum.issuedAt).toBeUndefined();
  });
});

/** Records the (network) keys a scheme is registered under; stands in for x402ResourceServer. */
class ServerRecorder {
  readonly networks: string[] = [];
  register(network: Network, _server: SchemeNetworkServer): this {
    this.networks.push(network);
    return this;
  }
}

describe('registerAtumEscrowScheme (server)', () => {
  it('registers under the eip155 wildcard by default', () => {
    const recorder = new ServerRecorder();
    const returned = registerAtumEscrowScheme(recorder, config);
    expect(returned).toBe(recorder); // chainable: returns the same server
    expect(recorder.networks).toEqual(['eip155:*']);
  });

  it('registers under explicit networks when provided', () => {
    const recorder = new ServerRecorder();
    registerAtumEscrowScheme(recorder, config, ['eip155:8453', 'eip155:42161']);
    expect(recorder.networks).toEqual(['eip155:8453', 'eip155:42161']);
  });
});

/** A second EVM source, so a refusal can be attributed to one source rather than to the config. */
const OTHER_SOURCE_NETWORK = 'eip155:10';
const otherSource = {
  asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  symbol: 'USDC',
  decimals: 6,
};

/** `config` with its single source's token metadata replaced; `undefined` deletes the field. */
function withSourceToken(token: { symbol?: unknown; decimals?: unknown }): AtumEscrowServerConfig {
  const source: Record<string, unknown> = { ...config.sources[SOURCE_NETWORK] };
  for (const [key, value] of Object.entries(token)) {
    if (value === undefined) delete source[key];
    else source[key] = value;
  }
  return { ...config, sources: { [SOURCE_NETWORK]: source } } as unknown as AtumEscrowServerConfig;
}

/** `config` with the destination's token metadata replaced; `undefined` deletes the field. */
function withDestinationToken(token: {
  symbol?: unknown;
  decimals?: unknown;
}): AtumEscrowServerConfig {
  const destination: Record<string, unknown> = { ...config.destination };
  for (const [key, value] of Object.entries(token)) {
    if (value === undefined) delete destination[key];
    else destination[key] = value;
  }
  return { ...config, destination } as unknown as AtumEscrowServerConfig;
}

/**
 * Token metadata on the corridor config. The merchant declares each token's symbol and decimals
 * so that construction can refuse a corridor whose source and destination tokens are not the
 * same money — a misconfiguration that would otherwise surface only as a client refusing every
 * 402 at pay time.
 */
describe('AtumEscrowServerScheme — token metadata validation', () => {
  const malformedTokenFields: ReadonlyArray<
    [label: string, field: 'symbol' | 'decimals', token: { symbol?: unknown; decimals?: unknown }]
  > = [
    ['a missing symbol', 'symbol', { symbol: undefined }],
    ['an empty symbol', 'symbol', { symbol: '' }],
    ['missing decimals', 'decimals', { decimals: undefined }],
    ['non-integer decimals', 'decimals', { decimals: 6.5 }],
    ['negative decimals', 'decimals', { decimals: -1 }],
    // 77 is the most decimals a uint256 amount can meaningfully carry (10^77 < 2^256 < 10^78).
    ['decimals above 77', 'decimals', { decimals: 78 }],
  ];

  for (const [label, field, token] of malformedTokenFields) {
    it(`rejects ${label} on the destination as INVALID_CONFIG naming the field`, () => {
      const err = thrownBy(() => new AtumEscrowServerScheme(withDestinationToken(token)));
      const configError = expectConfigError(err, 'INVALID_CONFIG');
      expect(configError.message).toMatch(/invalid atum-escrow server config/);
      expect(configError.message).toContain('destination');
      expect(configError.message).toContain(field);
    });

    it(`rejects ${label} on a source as INVALID_CONFIG naming the field`, () => {
      const err = thrownBy(() => new AtumEscrowServerScheme(withSourceToken(token)));
      const configError = expectConfigError(err, 'INVALID_CONFIG');
      expect(configError.message).toMatch(/invalid atum-escrow server config/);
      expect(configError.message).toContain('sources');
      expect(configError.message).toContain(field);
    });
  }

  // A Stellar strkey is accepted wherever the wire schema accepts one: a G account or a C contract.
  const STELLAR_ACCOUNT = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH';
  const STELLAR_CONTRACT = 'CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5';
  it('accepts a Stellar account and contract in the destination, the roles and a Stellar source', () => {
    expect(
      () =>
        new AtumEscrowServerScheme({
          ...config,
          destination: {
            ...config.destination,
            network: 'stellar:testnet',
            asset: STELLAR_CONTRACT,
            address: STELLAR_ACCOUNT,
          },
          fulfillmentProxy: STELLAR_CONTRACT,
          reserver: STELLAR_ACCOUNT,
          releaser: STELLAR_ACCOUNT,
          sources: {
            'stellar:testnet': {
              ...config.sources[SOURCE_NETWORK]!,
              asset: STELLAR_CONTRACT,
              escrow: STELLAR_CONTRACT,
            },
          },
        }),
    ).not.toThrow();
  });

  // The pattern is the strkey's shape (G or C, then 55 base32 characters); anything else is refused.
  for (const [label, address] of [
    ['a muxed M address', `M${STELLAR_ACCOUNT.slice(1)}`],
    ['a lowercase strkey', STELLAR_ACCOUNT.toLowerCase()],
    ['a strkey one character short', STELLAR_ACCOUNT.slice(0, 55)],
    ['a strkey one character long', `${STELLAR_ACCOUNT}A`],
    ['a strkey with a base32-invalid character', `${STELLAR_ACCOUNT.slice(0, 55)}1`],
  ] as const) {
    it(`refuses ${label} as the destination address, a fail-closed INVALID_CONFIG`, () => {
      const err = thrownBy(
        () =>
          new AtumEscrowServerScheme({
            ...config,
            destination: { ...config.destination, address },
          }),
      );
      const configError = expectConfigError(err, 'INVALID_CONFIG');
      expect(configError.message).toContain('destination');
    });
    it(`refuses ${label} as a source escrow`, () => {
      const err = thrownBy(
        () =>
          new AtumEscrowServerScheme({
            ...config,
            sources: { [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK]!, escrow: address } },
          }),
      );
      expectConfigError(err, 'INVALID_CONFIG');
    });
  }

  // A Stellar deposit's deadline is the fulfillment deadline, and the escrow bounds it to a day
  // after the issue time, so a longer budget on a Stellar source could never be paid.
  describe('the fulfillment deadline on a Stellar source', () => {
    const stellarConfig = (fulfillmentDeadlineSeconds: number) => ({
      ...config,
      fulfillmentDeadlineSeconds,
      sources: {
        'stellar:testnet': {
          ...config.sources[SOURCE_NETWORK]!,
          asset: STELLAR_CONTRACT,
          escrow: STELLAR_CONTRACT,
        },
      },
    });

    it('accepts exactly a day', () => {
      expect(() => new AtumEscrowServerScheme(stellarConfig(86_400))).not.toThrow();
    });

    it('refuses a day and a second, naming the field', () => {
      const err = thrownBy(() => new AtumEscrowServerScheme(stellarConfig(86_401)));
      const configError = expectConfigError(err, 'INVALID_CONFIG');
      expect(configError.message).toContain('fulfillmentDeadlineSeconds');
      expect(configError.message).toContain('Stellar source stellar:testnet');
    });

    it('does not bound the budget of a source that is not Stellar', () => {
      expect(
        () => new AtumEscrowServerScheme({ ...config, fulfillmentDeadlineSeconds: 86_401 }),
      ).not.toThrow();
    });

    it('bounds a Stellar source added next to another chain, whatever its position', () => {
      const err = thrownBy(
        () =>
          new AtumEscrowServerScheme({
            ...config,
            fulfillmentDeadlineSeconds: 90_000,
            sources: {
              ...config.sources,
              ...stellarConfig(90_000).sources,
            },
          }),
      );
      expectConfigError(err, 'INVALID_CONFIG');
    });
  });

  it('accepts the decimals bounds 0 and 77 on both the destination and a source', () => {
    // A 77-decimal destination against a 6-decimal source needs a fulfillment of at least 10^71
    // atoms for the cap to be worth one source atom; the base fulfillment would floor the cap to
    // zero and be refused for coverage, which is not what this test is about.
    const coveringFulfillment: Record<number, string> = {
      0: config.fulfillmentAmount,
      77: `1${'0'.repeat(71)}`,
    };
    for (const decimals of [0, 77]) {
      expect(
        () =>
          new AtumEscrowServerScheme({
            ...withDestinationToken({ decimals }),
            fulfillmentAmount: coveringFulfillment[decimals]!,
          }),
      ).not.toThrow();
      expect(() => new AtumEscrowServerScheme(withSourceToken({ decimals }))).not.toThrow();
    }
  });

  it('reports every malformed-field failure as an INVALID_CONFIG AtumEscrowConfigError', () => {
    // One error type for every boot failure lets a merchant catch config problems without
    // matching on message text.
    const solanaWithoutSvm = {
      ...config,
      sources: {
        'solana:localnet': {
          asset: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
          escrow: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
          symbol: 'USDC',
          decimals: 6,
        },
      },
    } as AtumEscrowServerConfig;
    const malformed: AtumEscrowServerConfig[] = [
      { ...config, reserver: 'not-an-address' },
      { ...config, markupBps: -5 },
      { ...config, quoteDeadlineSeconds: 300, fulfillmentDeadlineSeconds: 20 },
      { ...config, quoteDeadlineSeconds: 60, fulfillmentDeadlineSeconds: 60 },
      solanaWithoutSvm,
    ];
    for (const bad of malformed) {
      const err = thrownBy(() => new AtumEscrowServerScheme(bad));
      const configError = expectConfigError(err, 'INVALID_CONFIG');
      expect(configError.message).toMatch(/invalid atum-escrow server config/);
    }
  });

  it('reports a shape failure ahead of a peg mismatch in the same config', () => {
    // The peg check reads symbols, so it is only meaningful on a config whose shape is valid.
    const err = thrownBy(
      () =>
        new AtumEscrowServerScheme({
          ...withSourceToken({ symbol: 'EURC' }),
          markupBps: -5,
        }),
    );
    expectConfigError(err, 'INVALID_CONFIG');
  });
});

/**
 * Peg comparability between each source token and the destination token. A source is
 * comparable iff its symbol equals the destination's, or both symbols sit in one peg group.
 */
describe('AtumEscrowServerScheme — source/destination peg check', () => {
  it('refuses a source pegged to a different currency, naming that source network', () => {
    // Two sources, only the second incomparable: the error must point at the offending one so
    // an operator with many corridors knows which entry to fix.
    const err = thrownBy(
      () =>
        new AtumEscrowServerScheme({
          ...config,
          sources: {
            [SOURCE_NETWORK]: config.sources[SOURCE_NETWORK],
            [OTHER_SOURCE_NETWORK]: { ...otherSource, symbol: 'EURC' },
          },
        }),
    );
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', OTHER_SOURCE_NETWORK);
  });

  it('names the incomparable source even when it is not the last one configured', () => {
    const err = thrownBy(
      () =>
        new AtumEscrowServerScheme({
          ...config,
          sources: {
            [OTHER_SOURCE_NETWORK]: { ...otherSource, symbol: 'EURC' },
            [SOURCE_NETWORK]: config.sources[SOURCE_NETWORK],
          },
        }),
    );
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', OTHER_SOURCE_NETWORK);
  });

  it('refuses a destination outside every peg group paired with a USD source', () => {
    const err = thrownBy(
      () => new AtumEscrowServerScheme(withDestinationToken({ symbol: 'EURC' })),
    );
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', SOURCE_NETWORK);
  });

  it('compares symbols case-sensitively', () => {
    // A lowercase "usdc" is not a listed peg member, and is not equal to "USDC".
    const err = thrownBy(() => new AtumEscrowServerScheme(withSourceToken({ symbol: 'usdc' })));
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', SOURCE_NETWORK);
  });

  it('accepts two different stablecoins from the default USD peg group', () => {
    expect(() => new AtumEscrowServerScheme(withSourceToken({ symbol: 'USDT' }))).not.toThrow();
    expect(
      () =>
        new AtumEscrowServerScheme({
          ...withDestinationToken({ symbol: 'PYUSD' }),
          sources: {
            [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK], symbol: 'USDT0' },
            [OTHER_SOURCE_NETWORK]: { ...otherSource, symbol: 'USDC.e' },
          },
        }),
    ).not.toThrow();
  });

  it('accepts a token outside every peg group paired with itself', () => {
    expect(
      () =>
        new AtumEscrowServerScheme({
          ...withDestinationToken({ symbol: 'EURC' }),
          sources: { [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK], symbol: 'EURC' } },
        }),
    ).not.toThrow();
  });

  it('accepts the same token at different decimals on each side', () => {
    // A USDC bridged at 18 decimals is the same money as native 6-decimal USDC; decimals differ
    // per deployment and are not a reason to refuse the corridor.
    expect(() => new AtumEscrowServerScheme(withSourceToken({ decimals: 18 }))).not.toThrow();
  });

  it('widens what is comparable when the merchant supplies its own peg groups', () => {
    const eurcSource = withSourceToken({ symbol: 'EURC' });
    expect(() => new AtumEscrowServerScheme(eurcSource)).toThrow(AtumEscrowConfigError);
    expect(
      () => new AtumEscrowServerScheme({ ...eurcSource, pegGroups: [['USDC', 'EURC']] }),
    ).not.toThrow();
  });

  it('replaces the default peg groups rather than adding to them', () => {
    const pegGroups = [['EURC', 'EURe']];
    const err = thrownBy(
      () => new AtumEscrowServerScheme({ ...withSourceToken({ symbol: 'USDT' }), pegGroups }),
    );
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', SOURCE_NETWORK);
    // Equal symbols stay comparable whatever the groups say.
    expect(() => new AtumEscrowServerScheme({ ...config, pegGroups })).not.toThrow();
  });

  it('accepts empty peg groups, leaving only equal symbols comparable', () => {
    // An explicit empty list is a valid way to opt out of every default group.
    expect(() => new AtumEscrowServerScheme({ ...config, pegGroups: [] })).not.toThrow();
    const err = thrownBy(
      () => new AtumEscrowServerScheme({ ...withSourceToken({ symbol: 'USDT' }), pegGroups: [] }),
    );
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', SOURCE_NETWORK);
  });
});

/**
 * The merchant's peg groups are config like any other field, so a malformed value must fail
 * construction as a shape error rather than silently matching nothing (or everything).
 */
describe('AtumEscrowServerScheme — pegGroups shape validation', () => {
  const malformedPegGroups: ReadonlyArray<[label: string, pegGroups: unknown]> = [
    ['a group containing an empty symbol', [['USDC', '']]],
    ['a bare string instead of a list of groups', 'USDC'],
    ['a group that is a string rather than a list', ['USDC']],
    ['a group containing a non-string member', [['USDC', 5]]],
  ];

  for (const [label, pegGroups] of malformedPegGroups) {
    it(`rejects ${label} as INVALID_CONFIG naming pegGroups`, () => {
      const err = thrownBy(
        () =>
          new AtumEscrowServerScheme({ ...config, pegGroups } as unknown as AtumEscrowServerConfig),
      );
      const configError = expectConfigError(err, 'INVALID_CONFIG');
      expect(configError.message).toMatch(/invalid atum-escrow server config/);
      expect(configError.message).toContain('pegGroups');
    });
  }
});

/**
 * Token metadata is merchant-side configuration consumed at construction; none of it reaches
 * the 402. A payer cannot rely on merchant-declared metadata anyway, so emitting it would only
 * enlarge the block the resource server must reproduce on rebuild.
 */
describe('AtumEscrowServerScheme — token metadata stays off the wire', () => {
  const base: PaymentRequirements = {
    scheme: 'atum-escrow',
    network: SOURCE_NETWORK,
    asset: config.sources[SOURCE_NETWORK].asset,
    amount: '10300000',
    payTo: '',
    maxTimeoutSeconds: 60,
    extra: {},
  };

  it('prices and builds the same requirement regardless of the token metadata', async () => {
    const plain = new AtumEscrowServerScheme(config);
    const varied = new AtumEscrowServerScheme({
      ...withSourceToken({ symbol: 'USDT', decimals: 6 }),
      pegGroups: [['USDT', 'USDC']],
    });

    // Both share the destination and fulfillment, so one merchant price fits either.
    const plainPrice = await plain.parsePrice(atumEscrowPrice(config), SOURCE_NETWORK);
    expect(plainPrice).toEqual({ asset: config.sources[SOURCE_NETWORK].asset, amount: '10300000' });
    expect(await varied.parsePrice(atumEscrowPrice(config), SOURCE_NETWORK)).toEqual(plainPrice);

    const plainBuilt = await buildRequirement(plain, base);
    const variedBuilt = await buildRequirement(varied, base);
    expect(variedBuilt.requirement).toEqual(plainBuilt.requirement);
    expect(variedBuilt.extensions).toEqual(plainBuilt.extensions);
  });

  it('scales the source cap by the declared decimals, yet emits none of them', async () => {
    // fulfillmentAmount is in destination atoms and the cap in source atoms, so a cap that
    // ignored decimals would be worth 10^12 times too much or too little across a 6/18 corridor.
    // The decimals change that one number and nothing else: every other field of the requirement
    // and the declared extensions match a corridor with equal decimals and the same fulfillment.
    const variants: ReadonlyArray<
      [label: string, varied: AtumEscrowServerConfig, expectedAmount: string]
    > = [
      [
        'source at 18 decimals, destination at 6',
        withSourceToken({ decimals: 18 }),
        '10300000000000000000',
      ],
      [
        'destination at 18 decimals, source at 6',
        { ...withDestinationToken({ decimals: 18 }), fulfillmentAmount: '10000000000000000000' },
        '10300000',
      ],
    ];
    for (const [label, variedConfig, expectedAmount] of variants) {
      const varied = new AtumEscrowServerScheme(variedConfig);
      // Same fulfillment, both tokens at 6 decimals: the build the varied one must match.
      const comparator = new AtumEscrowServerScheme({
        ...config,
        fulfillmentAmount: variedConfig.fulfillmentAmount,
      });

      const variedPrice = await varied.parsePrice(atumEscrowPrice(variedConfig), SOURCE_NETWORK);
      expect(variedPrice, label).toEqual({
        asset: config.sources[SOURCE_NETWORK].asset,
        amount: expectedAmount,
      });
      // The comparator shares the varied config's destination token and fulfillment.
      const comparatorPrice = await comparator.parsePrice(
        atumEscrowPrice(variedConfig),
        SOURCE_NETWORK,
      );

      const variedBuilt = await buildRequirement(varied, { ...base, ...variedPrice });
      const comparatorBuilt = await buildRequirement(comparator, { ...base, ...comparatorPrice });
      expect(variedBuilt.requirement, label).toEqual({
        ...comparatorBuilt.requirement,
        amount: expectedAmount,
      });
      expect(variedBuilt.extensions, label).toEqual(comparatorBuilt.extensions);
      expect(JSON.stringify(variedBuilt.requirement.extra), label).not.toMatch(
        /symbol|decimals|pegGroups/,
      );
    }
  });

  it('emits no symbol, decimals or pegGroups anywhere in extra.atum', async () => {
    const scheme = new AtumEscrowServerScheme({ ...config, pegGroups: [['USDC', 'EURC']] });
    const { requirement } = await buildRequirement(scheme, base);
    const atum = (requirement.extra as { atum: Record<string, unknown> }).atum;

    for (const key of ['symbol', 'decimals', 'pegGroups']) {
      expect(atum).not.toHaveProperty(key);
      expect(atum.destination as Record<string, unknown>).not.toHaveProperty(key);
    }
    // Also catches the metadata turning up under some other nested member.
    expect(JSON.stringify(requirement.extra)).not.toMatch(/symbol|decimals|pegGroups/);
  });
});

describe('registerAtumEscrowScheme (server) — config errors', () => {
  it('surfaces a malformed config as an INVALID_CONFIG AtumEscrowConfigError', () => {
    const err = thrownBy(() =>
      registerAtumEscrowScheme(new ServerRecorder(), withSourceToken({ decimals: 78 })),
    );
    const configError = expectConfigError(err, 'INVALID_CONFIG');
    expect(configError.message).toMatch(/invalid atum-escrow server config/);
  });

  it('surfaces an incomparable source as an ASSETS_NOT_COMPARABLE AtumEscrowConfigError', () => {
    const recorder = new ServerRecorder();
    const err = thrownBy(() =>
      registerAtumEscrowScheme(recorder, withSourceToken({ symbol: 'EURC' })),
    );
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', SOURCE_NETWORK);
  });
});

/** `config` re-declared as one corridor with the given decimals on each side. */
function corridor(opts: {
  sourceDecimals: number;
  destinationDecimals: number;
  fulfillmentAmount: string;
  markupBps: number;
}): AtumEscrowServerConfig {
  return {
    ...config,
    destination: { ...config.destination, decimals: opts.destinationDecimals },
    fulfillmentAmount: opts.fulfillmentAmount,
    markupBps: opts.markupBps,
    sources: {
      [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK], decimals: opts.sourceDecimals },
    },
  };
}

/**
 * The source cap is fulfillmentAmount plus markup, converted from destination atoms into source
 * atoms and floored: floor(F × (10000 + markupBps) × 10^s / (10000 × 10^d)). Flooring never
 * overshoots the payer's bound, which is floored the same way.
 */
describe('AtumEscrowServerScheme — source cap across decimals', () => {
  it('prices each source in its own decimals when one config mixes them', async () => {
    // 0 decimals also pins the floor: 10.3 source units round down to 10, never up.
    const mixed: AtumEscrowServerConfig = {
      ...config,
      sources: {
        [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK], decimals: 18 },
        [OTHER_SOURCE_NETWORK]: { ...otherSource, decimals: 0 },
      },
    };
    const scheme = new AtumEscrowServerScheme(mixed);
    expect(await scheme.parsePrice(atumEscrowPrice(mixed), SOURCE_NETWORK)).toEqual({
      asset: config.sources[SOURCE_NETWORK].asset,
      amount: '10300000000000000000',
    });
    expect(await scheme.parsePrice(atumEscrowPrice(mixed), OTHER_SOURCE_NETWORK)).toEqual({
      asset: otherSource.asset,
      amount: '10',
    });
  });
});

/**
 * A cap that floors below the fulfillment cannot fund it: every payment on that corridor would
 * be underfunded. Construction refuses such a source so the merchant learns at boot, not at
 * settlement.
 */
describe('AtumEscrowServerScheme — cap coverage guard', () => {
  it('refuses a source whose cap floors to zero, naming that source', () => {
    const err = thrownBy(
      () =>
        new AtumEscrowServerScheme(
          corridor({
            sourceDecimals: 6,
            destinationDecimals: 18,
            fulfillmentAmount: '1',
            markupBps: 300,
          }),
        ),
    );
    expectConfigError(err, 'CAP_BELOW_PRICE', SOURCE_NETWORK);
  });

  it('accepts a cap that exactly covers the fulfillment', async () => {
    // 10^12 destination atoms at 18 decimals are exactly one source atom at 6 decimals.
    const exact = corridor({
      sourceDecimals: 6,
      destinationDecimals: 18,
      fulfillmentAmount: '1000000000000',
      markupBps: 0,
    });
    const scheme = new AtumEscrowServerScheme(exact);
    expect(await scheme.parsePrice(atumEscrowPrice(exact), SOURCE_NETWORK)).toEqual({
      asset: config.sources[SOURCE_NETWORK].asset,
      amount: '1',
    });
  });

  it('refuses a cap one destination atom short of covering, with or without a small markup', () => {
    // One source atom is worth 10^12 destination atoms; 10^12 + 1 floors back to one atom, and a
    // 1 bps markup adds only 10^8 destination atoms — not enough to reach a second source atom.
    for (const markupBps of [0, 1]) {
      const err = thrownBy(
        () =>
          new AtumEscrowServerScheme(
            corridor({
              sourceDecimals: 6,
              destinationDecimals: 18,
              fulfillmentAmount: '1000000000001',
              markupBps,
            }),
          ),
      );
      expect(err, `markupBps ${markupBps}`).toBeInstanceOf(AtumEscrowConfigError);
      expect((err as AtumEscrowConfigError).code, `markupBps ${markupBps}`).toBe('CAP_BELOW_PRICE');
      expect((err as AtumEscrowConfigError).network, `markupBps ${markupBps}`).toBe(SOURCE_NETWORK);
    }
  });

  it('accepts equal decimals with no markup, where the cap equals the fulfillment', async () => {
    const noMarkup: AtumEscrowServerConfig = { ...config, markupBps: 0 };
    const scheme = new AtumEscrowServerScheme(noMarkup);
    expect(await scheme.parsePrice(atumEscrowPrice(noMarkup), SOURCE_NETWORK)).toEqual({
      asset: config.sources[SOURCE_NETWORK].asset,
      amount: config.fulfillmentAmount,
    });
  });

  it('names the one source that fails coverage, wherever it sits in the config', () => {
    // At 10^12 + 1 atoms of an 18-decimal destination, an 18-decimal source covers exactly and a
    // 6-decimal source falls one destination atom short.
    const covering = { ...config.sources[SOURCE_NETWORK], decimals: 18 };
    const failing = { ...otherSource, decimals: 6 };
    const orders: ReadonlyArray<AtumEscrowServerConfig['sources']> = [
      { [SOURCE_NETWORK]: covering, [OTHER_SOURCE_NETWORK]: failing },
      { [OTHER_SOURCE_NETWORK]: failing, [SOURCE_NETWORK]: covering },
    ];
    for (const sources of orders) {
      const err = thrownBy(
        () =>
          new AtumEscrowServerScheme({
            ...withDestinationToken({ decimals: 18 }),
            fulfillmentAmount: '1000000000001',
            markupBps: 0,
            sources,
          }),
      );
      expectConfigError(err, 'CAP_BELOW_PRICE', OTHER_SOURCE_NETWORK);
    }
  });

  it('reports an incomparable source ahead of a coverage failure in the same config', () => {
    // Coverage converts amounts between the two tokens, which is meaningless unless they are the
    // same money. The coverage-failing comparable source is listed first so that a per-source
    // check interleaving the two rules would wrongly report it.
    const err = thrownBy(
      () =>
        new AtumEscrowServerScheme({
          ...withDestinationToken({ decimals: 18 }),
          fulfillmentAmount: '1',
          sources: {
            [SOURCE_NETWORK]: config.sources[SOURCE_NETWORK],
            [OTHER_SOURCE_NETWORK]: { ...otherSource, symbol: 'EURC' },
          },
        }),
    );
    expectConfigError(err, 'ASSETS_NOT_COMPARABLE', OTHER_SOURCE_NETWORK);
  });

  it('reports a shape failure ahead of both a peg mismatch and a coverage failure', () => {
    const err = thrownBy(
      () =>
        new AtumEscrowServerScheme({
          ...withDestinationToken({ decimals: 18 }),
          fulfillmentAmount: '1',
          markupBps: -5,
          sources: {
            [SOURCE_NETWORK]: config.sources[SOURCE_NETWORK],
            [OTHER_SOURCE_NETWORK]: { ...otherSource, symbol: 'EURC' },
          },
        }),
    );
    expectConfigError(err, 'INVALID_CONFIG');
  });

  it('surfaces a coverage failure through registerAtumEscrowScheme', () => {
    const err = thrownBy(() =>
      registerAtumEscrowScheme(
        new ServerRecorder(),
        corridor({
          sourceDecimals: 6,
          destinationDecimals: 18,
          fulfillmentAmount: '1',
          markupBps: 300,
        }),
      ),
    );
    expectConfigError(err, 'CAP_BELOW_PRICE', SOURCE_NETWORK);
  });
});

/**
 * The decimals the merchant declared for a token it configured, looked up by the same chain-aware
 * address rule the rest of the scheme uses: EVM hex addresses are case-insensitive, Solana base58
 * addresses are not.
 */
describe('AtumEscrowServerScheme — getAssetDecimals', () => {
  // Three distinct decimals so a lookup returning the wrong side cannot pass by coincidence; 0 also
  // catches a falsy-value fallback.
  const mixed = new AtumEscrowServerScheme({
    ...config,
    sources: {
      [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK], decimals: 18 },
      [OTHER_SOURCE_NETWORK]: { ...otherSource, decimals: 0 },
    },
  });
  const sourceAsset = config.sources[SOURCE_NETWORK].asset;
  const hexBodyUpper = (address: string): string => `0x${address.slice(2).toUpperCase()}`;

  it("returns each configured source's decimals", () => {
    expect(mixed.getAssetDecimals(sourceAsset, SOURCE_NETWORK)).toBe(18);
    expect(mixed.getAssetDecimals(otherSource.asset, OTHER_SOURCE_NETWORK)).toBe(0);
  });

  it("returns the destination's decimals", () => {
    expect(mixed.getAssetDecimals(config.destination.asset, config.destination.network)).toBe(6);
  });

  it('matches an EVM address regardless of case', () => {
    expect(mixed.getAssetDecimals(sourceAsset.toLowerCase(), SOURCE_NETWORK)).toBe(18);
    expect(mixed.getAssetDecimals(hexBodyUpper(sourceAsset), SOURCE_NETWORK)).toBe(18);
    expect(
      mixed.getAssetDecimals(hexBodyUpper(config.destination.asset), config.destination.network),
    ).toBe(6);
  });

  it('matches a Solana address only in its exact case', () => {
    const solanaNetwork = 'solana:localnet';
    const solanaAsset = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
    const scheme = new AtumEscrowServerScheme({
      ...config,
      reserver: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
      releaser: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
      sources: {
        [solanaNetwork]: {
          asset: solanaAsset,
          escrow: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
          symbol: 'USDC',
          decimals: 9,
          svmSignatureClusterId: 'localnet',
          svmSignatureDomainVersion: 5,
        },
      },
    });
    expect(scheme.getAssetDecimals(solanaAsset, solanaNetwork)).toBe(9);
    // Base58 is case-significant: a case-changed string is a different address.
    const caseChanged = solanaAsset.toLowerCase();
    expect(() => scheme.getAssetDecimals(caseChanged, solanaNetwork)).toThrow(Error);
    expect(() => scheme.getAssetDecimals(caseChanged, solanaNetwork)).toThrow(caseChanged);
  });

  it('throws, naming the asset, for an asset not configured on that network', () => {
    const unknown = '0x1111111111111111111111111111111111111111';
    expect(() => mixed.getAssetDecimals(unknown, SOURCE_NETWORK)).toThrow(Error);
    expect(() => mixed.getAssetDecimals(unknown, SOURCE_NETWORK)).toThrow(unknown);
    // A configured token is still unknown on a network it is not configured on.
    expect(() => mixed.getAssetDecimals(sourceAsset, config.destination.network)).toThrow(
      sourceAsset,
    );
  });

  it('throws, naming the asset, for a network with nothing configured', () => {
    expect(() => mixed.getAssetDecimals(sourceAsset, 'eip155:999999')).toThrow(Error);
    expect(() => mixed.getAssetDecimals(sourceAsset, 'eip155:999999')).toThrow(sourceAsset);
  });

  // The destination's decimals belong to the destination network alone: a lookup keyed on the
  // address without the network would answer 6 here, which differs from both sources' decimals.
  it("throws, naming the asset, for the destination's asset on any network but the destination's", () => {
    const destinationAsset = config.destination.asset;
    expect(() => mixed.getAssetDecimals(destinationAsset, SOURCE_NETWORK)).toThrow(Error);
    expect(() => mixed.getAssetDecimals(destinationAsset, SOURCE_NETWORK)).toThrow(
      destinationAsset,
    );
    expect(() => mixed.getAssetDecimals(destinationAsset, OTHER_SOURCE_NETWORK)).toThrow(
      destinationAsset,
    );
    expect(() => mixed.getAssetDecimals(destinationAsset, 'eip155:999999')).toThrow(Error);
    expect(() => mixed.getAssetDecimals(destinationAsset, 'eip155:999999')).toThrow(
      destinationAsset,
    );
  });
});

/**
 * The server's cap must be one the payer accepts. Both sides compute it with the same shared
 * conversion, and here the payer is handed the same token decimals the merchant declared, so
 * this does not test two independent implementations. What it pins is the wiring: when both
 * use the same decimals, the cap the server emits passes the payer's real bound at the merchant's
 * exact markup and at a looser one, and fails it one bps tighter wherever that lowers the bound,
 * across every corridor shape in the table.
 */
describe("AtumEscrowServerScheme — agreement with the payer's cap bound", () => {
  const DESTINATION_NETWORK = config.destination.network;
  const sourceAsset = config.sources[SOURCE_NETWORK].asset;
  const destinationAsset = config.destination.asset;

  const decimalPairs: ReadonlyArray<[source: number, destination: number]> = [
    [6, 6],
    [6, 18],
    [18, 6],
    [0, 9],
    [9, 0],
    [18, 18],
  ];
  const markups = [0, 1, 299, 300, 500];
  // Multiplied by 10^(d - s) when the destination is finer, so every fulfillment is a whole
  // number of source atoms and passes the coverage guard; awkward multipliers exercise the floor.
  const multipliers = [1n, 7n, 999_999n, 1_000_001n, 123_456_789n, 10_000_000n];

  function fulfillmentsFor(s: number, d: number): string[] {
    const scale = d > s ? 10n ** BigInt(d - s) : 1n;
    return multipliers.map((k) => (k * scale).toString());
  }

  function payerCheck(input: {
    s: number;
    d: number;
    amount: string;
    fulfillmentAmount: string;
    maxMarkupBps: number;
  }): () => void {
    return () =>
      assertCapWithinBound({
        sourceNetwork: SOURCE_NETWORK,
        sourceAsset,
        sourceTokens: [{ symbol: 'USDC', address: sourceAsset, decimals: input.s }],
        destinationNetwork: DESTINATION_NETWORK,
        destinationAsset,
        destinationTokens: [{ symbol: 'USDC', address: destinationAsset, decimals: input.d }],
        amount: input.amount,
        fulfillmentAmount: input.fulfillmentAmount,
        pegGroups: DEFAULT_PEG_GROUPS,
        maxMarkupBps: input.maxMarkupBps,
      });
  }

  it('produces a cap the payer accepts on every corridor, at the default and the tightest bound', async () => {
    let checked = 0;
    for (const [s, d] of decimalPairs) {
      for (const markupBps of markups) {
        for (const fulfillmentAmount of fulfillmentsFor(s, d)) {
          const label = `s=${s} d=${d} bps=${markupBps} F=${fulfillmentAmount}`;
          const corridorConfig = corridor({
            sourceDecimals: s,
            destinationDecimals: d,
            fulfillmentAmount,
            markupBps,
          });
          const scheme = new AtumEscrowServerScheme(corridorConfig);
          const { amount } = await scheme.parsePrice(
            atumEscrowPrice(corridorConfig),
            SOURCE_NETWORK,
          );
          for (const maxMarkupBps of [500, markupBps]) {
            expect(
              payerCheck({ s, d, amount, fulfillmentAmount, maxMarkupBps }),
              `${label} maxMarkupBps=${maxMarkupBps}`,
            ).not.toThrow();
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(decimalPairs.length * markups.length * multipliers.length);
  });

  it('is a harness that can fail: a payer allowing one bps less refuses the cap', async () => {
    // Without this, a payer check that never threw would make the agreement test vacuous.
    const scheme = new AtumEscrowServerScheme(config);
    const { amount } = await scheme.parsePrice(atumEscrowPrice(config), SOURCE_NETWORK);
    const err = thrownBy(
      payerCheck({
        s: 6,
        d: 6,
        amount,
        fulfillmentAmount: config.fulfillmentAmount,
        maxMarkupBps: config.markupBps - 1,
      }),
    );
    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as AtumEscrowTrustError).code).toBe('MARKUP_EXCEEDED');

    // Across the scaled corridors too: wherever one bps less lowers the payer's bound, the cap
    // sits above it and is refused.
    let refused = 0;
    for (const [s, d] of decimalPairs) {
      for (const markupBps of markups.filter((bps) => bps >= 1)) {
        for (const fulfillmentAmount of fulfillmentsFor(s, d)) {
          const corridorConfig = corridor({
            sourceDecimals: s,
            destinationDecimals: d,
            fulfillmentAmount,
            markupBps,
          });
          const corridorScheme = new AtumEscrowServerScheme(corridorConfig);
          const price = await corridorScheme.parsePrice(
            atumEscrowPrice(corridorConfig),
            SOURCE_NETWORK,
          );
          const tighter = thrownBy(
            payerCheck({
              s,
              d,
              amount: price.amount,
              fulfillmentAmount,
              maxMarkupBps: markupBps - 1,
            }),
          );
          if (tighter !== undefined) {
            expect(tighter).toBeInstanceOf(AtumEscrowTrustError);
            expect((tighter as AtumEscrowTrustError).code).toBe('MARKUP_EXCEEDED');
            refused++;
          }
        }
      }
    }
    expect(refused).toBeGreaterThan(0);
  });
});

/**
 * The route price a merchant writes is not what the payer is charged: the payer funds the source
 * cap, which the scheme derives from the configured fulfillment and markup. A price the scheme
 * silently ignored would let a route read "$0.10" while charging ten dollars, so the only price
 * accepted is the one that restates the corridor — the destination token and fulfillment — and
 * anything else is refused when the requirement is built rather than misleading the merchant.
 */
describe('AtumEscrowServerScheme — the route price must restate the corridor', () => {
  it('atumEscrowPrice names exactly the destination asset and the fulfillment amount', () => {
    const price = atumEscrowPrice(config);
    expect(price).toStrictEqual({
      asset: config.destination.asset,
      amount: config.fulfillmentAmount,
    });
    // No `extra`: parsePrice refuses any price carrying one. Core never reads a route price's
    // extra (it merges the scheme's returned extra with the route option's), so an extra here
    // would otherwise be dropped silently rather than reach the requirement.
    expect(Object.keys(price).sort()).toEqual(['amount', 'asset']);
  });

  it('atumEscrowPrice needs only the destination asset and the fulfillment amount', () => {
    const price = atumEscrowPrice({
      destination: { asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
      fulfillmentAmount: '42',
    });
    expect(price).toStrictEqual({
      asset: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      amount: '42',
    });
  });

  it('accepts atumEscrowPrice on every configured source, each priced in its own asset', async () => {
    const twoSources: AtumEscrowServerConfig = {
      ...config,
      sources: { ...config.sources, [OTHER_SOURCE_NETWORK]: otherSource },
    };
    const scheme = new AtumEscrowServerScheme(twoSources);
    expect(await scheme.parsePrice(atumEscrowPrice(twoSources), SOURCE_NETWORK)).toEqual({
      asset: config.sources[SOURCE_NETWORK].asset,
      amount: '10300000',
    });
    expect(await scheme.parsePrice(atumEscrowPrice(twoSources), OTHER_SOURCE_NETWORK)).toEqual({
      asset: otherSource.asset,
      amount: '10300000',
    });
  });

  it('matches an EVM destination asset regardless of letter case', async () => {
    // EVM addresses are case-insensitive hex; the checksum casing is presentation only, so a
    // merchant copying the checksummed form names the same token as the configured lowercase one.
    const scheme = new AtumEscrowServerScheme(config);
    const lower = config.destination.asset.toLowerCase();
    const upper = '0x' + lower.slice(2).toUpperCase();
    const checksummed = ethers.getAddress(lower);
    // Guards the premise: a checksum equal to the configured form would make this vacuous.
    expect(checksummed).not.toBe(config.destination.asset);
    for (const asset of [upper, checksummed]) {
      expect(
        await scheme.parsePrice({ asset, amount: config.fulfillmentAmount }, SOURCE_NETWORK),
        asset,
      ).toEqual({ asset: config.sources[SOURCE_NETWORK].asset, amount: '10300000' });
    }
  });

  const refused: ReadonlyArray<[label: string, price: Parameters<typeof scheme.parsePrice>[0]]> = [
    ['a dollar Money string', '$0.10'],
    ['a bare Money string', '10'],
    ['a Money string equal to the fulfillment amount', '10000000'],
    ['a Money number', 0.1],
    ['a Money number equal to the fulfillment amount', 10000000],
    [
      'the source asset instead of the destination asset',
      { asset: config.sources[SOURCE_NETWORK].asset, amount: '10000000' },
    ],
    ['one atom more than the fulfillment', { asset: config.destination.asset, amount: '10000001' }],
    [
      'the source cap instead of the fulfillment',
      { asset: config.destination.asset, amount: '10300000' },
    ],
    [
      'the fulfillment with a leading zero',
      { asset: config.destination.asset, amount: '010000000' },
    ],
    [
      'a matching price carrying an empty extra',
      { asset: config.destination.asset, amount: '10000000', extra: {} },
    ],
    [
      'a matching price carrying extra fields',
      { asset: config.destination.asset, amount: '10000000', extra: { foo: 1 } },
    ],
  ];

  for (const [label, price] of refused) {
    it(`refuses ${label} as PRICE_CONFLICT naming the network`, async () => {
      const err = await rejectionOf(scheme.parsePrice(price, SOURCE_NETWORK));
      expectConfigError(err, 'PRICE_CONFLICT', SOURCE_NETWORK);
    });
  }

  it('names the network it was asked to price, not the first configured source', async () => {
    const twoSources: AtumEscrowServerConfig = {
      ...config,
      sources: { ...config.sources, [OTHER_SOURCE_NETWORK]: otherSource },
    };
    const err = await rejectionOf(
      new AtumEscrowServerScheme(twoSources).parsePrice('$0.10', OTHER_SOURCE_NETWORK),
    );
    expectConfigError(err, 'PRICE_CONFLICT', OTHER_SOURCE_NETWORK);
  });

  it('reports an unconfigured network before judging the price', async () => {
    // A network with no source cannot be priced at all, so that is the error the merchant needs:
    // reporting a price conflict there would send them to fix the wrong thing.
    for (const price of ['$0.10', atumEscrowPrice(config)] as const) {
      const err = await rejectionOf(scheme.parsePrice(price, 'eip155:999999'));
      expectConfigError(err, 'SOURCE_NOT_CONFIGURED', 'eip155:999999');
    }
  });

  // A price value that cannot be serialized must still be refused as the config error: if
  // describing the bad price in the message threw first, the merchant would get a bare
  // TypeError with no code or network pointing at the route to fix.
  const circularExtra: Record<string, unknown> = {};
  circularExtra.self = circularExtra;
  const circularPrice: Record<string, unknown> = {
    asset: config.destination.asset,
    amount: config.fulfillmentAmount,
  };
  circularPrice.self = circularPrice;
  const unserializable: ReadonlyArray<[label: string, price: unknown]> = [
    ['a BigInt amount', { asset: config.destination.asset, amount: 10000000n }],
    ['a price that references itself', circularPrice],
    [
      'a matching price whose extra references itself',
      { asset: config.destination.asset, amount: config.fulfillmentAmount, extra: circularExtra },
    ],
  ];

  for (const [label, price] of unserializable) {
    it(`refuses ${label} as PRICE_CONFLICT rather than throwing while describing it`, async () => {
      const err = await rejectionOf(
        scheme.parsePrice(price as Parameters<typeof scheme.parsePrice>[0], SOURCE_NETWORK),
      );
      const configError = expectConfigError(err, 'PRICE_CONFLICT', SOURCE_NETWORK);
      expect(typeof configError.message).toBe('string');
    });
  }

  describe('with a Solana destination priced on an EVM source', () => {
    // The destination asset is an address on the DESTINATION chain, so its case rule is that
    // chain's: base58 is case-sensitive. Comparing it under the source's EVM rule would accept a
    // re-cased mint, which on Solana names a different (or no) token.
    const solanaDestination: AtumEscrowServerConfig = {
      ...config,
      destination: {
        network: 'solana:localnet',
        asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        address: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
        symbol: 'USDC',
        decimals: 6,
      },
    };

    it('accepts atumEscrowPrice', async () => {
      const scheme = new AtumEscrowServerScheme(solanaDestination);
      expect(await scheme.parsePrice(atumEscrowPrice(solanaDestination), SOURCE_NETWORK)).toEqual({
        asset: config.sources[SOURCE_NETWORK].asset,
        amount: '10300000',
      });
    });

    it('refuses the destination mint with its base58 letter case changed', async () => {
      const scheme = new AtumEscrowServerScheme(solanaDestination);
      const lowered = solanaDestination.destination.asset.toLowerCase();
      // Guards the premise: an all-lowercase mint would make this vacuous.
      expect(lowered).not.toBe(solanaDestination.destination.asset);
      const err = await rejectionOf(
        scheme.parsePrice({ asset: lowered, amount: config.fulfillmentAmount }, SOURCE_NETWORK),
      );
      expectConfigError(err, 'PRICE_CONFLICT', SOURCE_NETWORK);
    });
  });
});

// A facilitator that does not recognise depositRequestHashVersions refuses a requirement carrying
// it, so the merchant publishes it per source, only once configured, and a source without it emits
// nothing.
describe('AtumEscrowServerScheme depositRequestHashVersions', () => {
  const base: PaymentRequirements = {
    scheme: 'atum-escrow',
    network: SOURCE_NETWORK,
    asset: config.sources[SOURCE_NETWORK].asset,
    amount: '10300000',
    payTo: '',
    maxTimeoutSeconds: 60,
    extra: {},
  };
  const atumOf = async (scheme: AtumEscrowServerScheme) =>
    ((await buildRequirement(scheme, base)).requirement.extra as { atum: Record<string, unknown> })
      .atum;

  it('publishes the versions a source is configured with', async () => {
    const scheme = new AtumEscrowServerScheme({
      ...config,
      sources: {
        [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK], depositRequestHashVersions: [1, 2] },
      },
    });
    expect((await atumOf(scheme)).depositRequestHashVersions).toEqual([1, 2]);
  });

  it('publishes nothing for a source configured without them', async () => {
    expect(await atumOf(new AtumEscrowServerScheme(config))).not.toHaveProperty(
      'depositRequestHashVersions',
    );
  });

  it.each([[[]], [[0]], [[1, 1]], [[1.5]]])(
    'refuses %j at construction',
    (depositRequestHashVersions) => {
      const bad = {
        ...config,
        sources: {
          [SOURCE_NETWORK]: { ...config.sources[SOURCE_NETWORK], depositRequestHashVersions },
        },
      } as AtumEscrowServerConfig;
      expect(() => new AtumEscrowServerScheme(bad)).toThrow(/invalid atum-escrow server config/);
    },
  );
});

describe('server entry point — DEFAULT_PEG_GROUPS', () => {
  // A merchant extending the default groups must start from exactly what the payer client
  // enforces, without importing payer code; a copy could drift from the payer's groups.
  it('exports the same DEFAULT_PEG_GROUPS value as the payer client entry point', () => {
    expect(SERVER_DEFAULT_PEG_GROUPS).toBeDefined();
    expect(SERVER_DEFAULT_PEG_GROUPS).toBe(CLIENT_DEFAULT_PEG_GROUPS);
  });
});
