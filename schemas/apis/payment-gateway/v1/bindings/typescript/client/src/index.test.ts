import {
  PAYMENT_REQUEST_VERSION,
  PaymentGatewayClient,
  defaultGateway,
  OpenAPI,
  DEFAULT_QUOTE_DEADLINE_SECONDS,
  DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS,
  DEFAULT_FULFILLMENT_DEADLINE_SECONDS,
} from './index';
import {
  getChainAdapter,
  type ContractFieldOverrides,
  type ChainAdapter,
  type ChainDefaults,
} from './chain-adapters';
// Imported through the barrel, not the workspace sibling, so this exercises the surface a
// published consumer actually has.
import { InvalidAccountError } from './index';

jest.mock('./chain-adapters', () => ({
  getChainAdapter: jest.fn(),
}));

const getChainAdapterMock = getChainAdapter as jest.MockedFunction<typeof getChainAdapter>;

const chainDefaults: ChainDefaults = {
  escrowContract: '0x0000000000000000000000000000000000000001',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
  quoteSelector: '0x0000000000000000000000000000000000000003',
  fulfillmentVerifierAccount: '0x0000000000000000000000000000000000000004',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
};

class TestPaymentGatewayClient extends PaymentGatewayClient {
  async fetchChainDefaults(_chainId: string): Promise<ChainDefaults> {
    return chainDefaults;
  }
}

function mockChainAdapter(overrides?: ContractFieldOverrides): void {
  // Message building runs through the shared sender_auth SDK (not mocked here), so
  // the pgc adapter only needs its surviving surface: Turnkey mapping, key hygiene,
  // and the optional contract-field override.
  const adapter: ChainAdapter = {
    turnkeyAddressFormat: 'ADDRESS_FORMAT_ETHEREUM',
    formatPrivateKey: jest.fn((key: string) => key),
    ...(overrides ? { resolveContractOverrides: jest.fn(() => overrides) } : {}),
  };

  getChainAdapterMock.mockReturnValue(adapter);
}

async function preparePayment(fulfillmentAmount: string, maxSourceAmount = '103000') {
  const client = new TestPaymentGatewayClient({ BASE: 'https://gateway.example' });

  return client.preparePaymentRequest({
    depositor: '0x0000000000000000000000000000000000000005',
    fulfillmentAmount,
    sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
    destinationAccount: '0x0000000000000000000000000000000000000007',
    destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
    maxSourceAmount,
    requestId: 'req-1',
  });
}

describe('PaymentGatewayClient.preparePaymentRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChainAdapter();
  });

  it('when maxSourceAmount is provided, uses it as max_source_amount', async () => {
    const paymentRequest = await preparePayment('10000', '12345');

    expect(paymentRequest.max_source_amount).toBe('12345');
  });

  // The payment-gw server rejects any PaymentRequest without `version`
  // (schema validation: `version is required`). Pin the bindings constant
  // so a regression that drops the field — or drifts the producer away
  // from that constant — fails at the producer rather than as a cascade
  // of 400s downstream.
  it('emits the canonical PaymentRequest.version on every prepared request', async () => {
    const paymentRequest = await preparePayment('10000');

    expect(paymentRequest.version).toBe(PAYMENT_REQUEST_VERSION);
  });

  it('defaults both deadlines to the shared constants when omitted', async () => {
    const before = Date.now();
    const paymentRequest = await preparePayment('10000');
    const after = Date.now();

    const quoteMs = new Date(paymentRequest.quote_deadline).getTime();
    const fulfillMs = new Date(paymentRequest.fulfillment_deadline).getTime();
    expect(quoteMs).toBeGreaterThanOrEqual(before + DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS * 1000);
    expect(quoteMs).toBeLessThanOrEqual(after + DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS * 1000);
    expect(fulfillMs).toBeGreaterThanOrEqual(before + DEFAULT_FULFILLMENT_DEADLINE_SECONDS * 1000);
    expect(fulfillMs).toBeLessThanOrEqual(after + DEFAULT_FULFILLMENT_DEADLINE_SECONDS * 1000);
  });

  it('respects caller-supplied deadline windows (parity with request-quote)', async () => {
    const client = new TestPaymentGatewayClient({ BASE: 'https://gateway.example' });
    const before = Date.now();
    const paymentRequest = await client.preparePaymentRequest({
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: '10000',
      sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      maxSourceAmount: '103000',
      requestId: 'req-2',
      quoteDeadlineSeconds: 45,
      fulfillmentDeadlineSeconds: 120,
    });
    const after = Date.now();

    const quoteMs = new Date(paymentRequest.quote_deadline).getTime();
    const fulfillMs = new Date(paymentRequest.fulfillment_deadline).getTime();
    expect(quoteMs).toBeGreaterThanOrEqual(before + 45 * 1000);
    expect(quoteMs).toBeLessThanOrEqual(after + 45 * 1000);
    expect(fulfillMs).toBeGreaterThanOrEqual(before + 120 * 1000);
    expect(fulfillMs).toBeLessThanOrEqual(after + 120 * 1000);
    expect(quoteMs).toBeLessThan(fulfillMs);
  });

  it('rejects when quote_deadline would not be before fulfillment_deadline', async () => {
    const client = new TestPaymentGatewayClient({ BASE: 'https://gateway.example' });
    const base = {
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: '10000',
      sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      maxSourceAmount: '103000',
      requestId: 'req-3',
    };
    await expect(
      client.preparePaymentRequest({
        ...base,
        quoteDeadlineSeconds: 60,
        fulfillmentDeadlineSeconds: 60,
      }),
    ).rejects.toThrow(/strictly less than/);
    await expect(
      client.preparePaymentRequest({
        ...base,
        quoteDeadlineSeconds: 120,
        fulfillmentDeadlineSeconds: 60,
      }),
    ).rejects.toThrow(/strictly less than/);
  });

  // A long quote window alone outlasts the default fulfillment window. The error has to say the
  // fulfillment value it names is the default, which the caller never passed, and what to raise.
  it('names the default fulfillment window when only a long quote window is passed', async () => {
    const client = new TestPaymentGatewayClient({ BASE: 'https://gateway.example' });
    const error = client.preparePaymentRequest({
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: '10000',
      sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      maxSourceAmount: '103000',
      requestId: 'req-long-quote',
      quoteDeadlineSeconds: DEFAULT_FULFILLMENT_DEADLINE_SECONDS,
    });
    await expect(error).rejects.toThrow(
      `fulfillmentDeadlineSeconds (${DEFAULT_FULFILLMENT_DEADLINE_SECONDS}, the default)`,
    );
    await expect(error).rejects.toThrow(/raise fulfillmentDeadlineSeconds by the same amount/);
  });

  it('rejects non-positive deadline seconds (a negative would otherwise stamp a past quote_deadline)', async () => {
    const client = new TestPaymentGatewayClient({ BASE: 'https://gateway.example' });
    const base = {
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: '10000',
      sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      maxSourceAmount: '103000',
      requestId: 'req-4',
    };
    // A negative quote window passes the ordering check against a positive
    // fulfillment, so without the positivity guard it stamps a quote_deadline in the past.
    await expect(
      client.preparePaymentRequest({ ...base, quoteDeadlineSeconds: -5 }),
    ).rejects.toThrow(/positive/);
    await expect(
      client.preparePaymentRequest({ ...base, quoteDeadlineSeconds: 0 }),
    ).rejects.toThrow(/positive/);
    await expect(
      client.preparePaymentRequest({ ...base, fulfillmentDeadlineSeconds: -1 }),
    ).rejects.toThrow(/positive/);
  });
});

describe('PaymentGatewayClient.prepareQuoteRequest', () => {
  // prepareQuoteRequest fetches chain defaults (like preparePaymentRequest), so
  // use the TestPaymentGatewayClient that stubs fetchChainDefaults. It resolves
  // contract-field overrides via getChainAdapter (mocked here); the default EVM
  // mock sets none, so the fields fall back to the raw chain defaults.
  const client = new TestPaymentGatewayClient({ BASE: 'https://gateway.example' });

  beforeEach(() => {
    jest.clearAllMocks();
    mockChainAdapter();
  });

  function prepareQuote(
    overrides: Partial<Parameters<PaymentGatewayClient['prepareQuoteRequest']>[0]> = {},
  ) {
    return client.prepareQuoteRequest({
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: '100000',
      sourceAsset: 'eip155:42161/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:42220/erc20:0x0000000000000000000000000000000000000008',
      requestId: 'qr-1',
      ...overrides,
    });
  }

  // The single most important invariant: quote-time is unauthenticated, and the
  // gateway 400s a quote-request that carries sender_auth. CreateQuoteRequest has
  // no such field, so a regression that reintroduces it would be a type error —
  // this pins the runtime shape too.
  it('never emits sender_auth', async () => {
    const quoteRequest = await prepareQuote();
    expect((quoteRequest as Record<string, unknown>).sender_auth).toBeUndefined();
  });

  it('populates required corridor fields and the canonical version', async () => {
    const quoteRequest = await prepareQuote();
    expect(quoteRequest.version).toBe(PAYMENT_REQUEST_VERSION);
    expect(quoteRequest.request_id).toBe('qr-1');
    expect(quoteRequest.source).toEqual({
      asset_identifier: 'eip155:42161/erc20:0x0000000000000000000000000000000000000006',
      account: '0x0000000000000000000000000000000000000005',
    });
    expect(quoteRequest.destination).toEqual([
      {
        asset_identifier: 'eip155:42220/erc20:0x0000000000000000000000000000000000000008',
        account: '0x0000000000000000000000000000000000000007',
      },
    ]);
    expect(quoteRequest.fulfillment_amount).toBe('100000');
  });

  // Regression guard for the CORE-issue where prepareQuoteRequest omitted the
  // contract fields: the gateway requires fulfillment_verifier to broadcast the
  // quote to settlers, so the quote body MUST carry the same contract defaults
  // the payment flow does. These come from fetchChainDefaults (stubbed here).
  it('populates the same contract fields as the payment flow (from chain defaults)', async () => {
    const quoteRequest = await prepareQuote();
    expect(quoteRequest.escrow_contract_address).toBe(chainDefaults.escrowContract);
    expect(quoteRequest.fulfillment_verifier).toEqual({
      account: chainDefaults.fulfillmentVerifierAccount,
      endpoint: chainDefaults.fulfillmentVerifierEndpoint,
    });
    expect(quoteRequest.fulfillment_proxy).toBe(chainDefaults.fulfillmentProxy);
  });

  it('sets both required deadlines, in the future and correctly ordered', async () => {
    const before = Date.now();
    const quoteRequest = await prepareQuote({
      quoteDeadlineSeconds: 3,
      fulfillmentDeadlineSeconds: 3600,
    });
    const after = Date.now();

    const quoteMs = new Date(quoteRequest.quote_deadline).getTime();
    const fulfillMs = new Date(quoteRequest.fulfillment_deadline).getTime();

    expect(Number.isNaN(quoteMs)).toBe(false);
    expect(Number.isNaN(fulfillMs)).toBe(false);
    // Deadlines are now + N seconds, stamped between `before` and `after`.
    expect(quoteMs).toBeGreaterThanOrEqual(before + 3 * 1000);
    expect(quoteMs).toBeLessThanOrEqual(after + 3 * 1000);
    expect(fulfillMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
    // The gateway rejects quote_deadline that is not strictly before fulfillment_deadline.
    expect(quoteMs).toBeLessThan(fulfillMs);
  });

  it('defaults the deadlines to the shared DEFAULT_*_DEADLINE_SECONDS constants when omitted', async () => {
    const before = Date.now();
    const quoteRequest = await prepareQuote(); // no deadline overrides
    const after = Date.now();

    const quoteMs = new Date(quoteRequest.quote_deadline).getTime();
    const fulfillMs = new Date(quoteRequest.fulfillment_deadline).getTime();
    // Guards that the builder actually wires to the constant rather than a stray literal;
    // the value itself is pinned in 'default deadlines' below.
    expect(quoteMs).toBeGreaterThanOrEqual(before + DEFAULT_QUOTE_DEADLINE_SECONDS * 1000);
    expect(quoteMs).toBeLessThanOrEqual(after + DEFAULT_QUOTE_DEADLINE_SECONDS * 1000);
    expect(fulfillMs).toBeGreaterThanOrEqual(before + DEFAULT_FULFILLMENT_DEADLINE_SECONDS * 1000);
    expect(fulfillMs).toBeLessThanOrEqual(after + DEFAULT_FULFILLMENT_DEADLINE_SECONDS * 1000);
  });

  // Bidding closes at quote_deadline, so time spent fetching corridor addresses must not come
  // out of the window: the deadlines are stamped from a clock read taken after the fetch.
  it('stamps the deadlines after the chain-defaults fetch', async () => {
    let clock = Date.parse('2035-01-01T00:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    class SlowDefaultsClient extends PaymentGatewayClient {
      async fetchChainDefaults(): Promise<ChainDefaults> {
        clock += 5_000;
        return chainDefaults;
      }
    }
    try {
      const quoteRequest = await new SlowDefaultsClient({
        BASE: 'https://gateway.example',
      }).prepareQuoteRequest({
        depositor: '0x0000000000000000000000000000000000000005',
        fulfillmentAmount: '100000',
        sourceAsset: 'eip155:42161/erc20:0x0000000000000000000000000000000000000006',
        destinationAccount: '0x0000000000000000000000000000000000000007',
        destinationAsset: 'eip155:42220/erc20:0x0000000000000000000000000000000000000008',
        requestId: 'qr-slow-fetch',
      });

      expect(quoteRequest.quote_deadline).toBe(
        new Date(clock + DEFAULT_QUOTE_DEADLINE_SECONDS * 1000).toISOString(),
      );
      expect(quoteRequest.fulfillment_deadline).toBe(
        new Date(clock + DEFAULT_FULFILLMENT_DEADLINE_SECONDS * 1000).toISOString(),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('refuses invalid deadline budgets before fetching chain defaults', async () => {
    const fetchSpy = jest.spyOn(client, 'fetchChainDefaults');
    await expect(
      prepareQuote({ quoteDeadlineSeconds: 60, fulfillmentDeadlineSeconds: 60 }),
    ).rejects.toThrow(/strictly less than/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('respects custom deadline windows', async () => {
    const before = Date.now();
    const quoteRequest = await prepareQuote({
      quoteDeadlineSeconds: 5,
      fulfillmentDeadlineSeconds: 60,
    });
    const after = Date.now();

    const quoteMs = new Date(quoteRequest.quote_deadline).getTime();
    const fulfillMs = new Date(quoteRequest.fulfillment_deadline).getTime();
    expect(quoteMs).toBeGreaterThanOrEqual(before + 5 * 1000);
    expect(quoteMs).toBeLessThanOrEqual(after + 5 * 1000);
    expect(fulfillMs).toBeGreaterThanOrEqual(before + 60 * 1000);
    expect(fulfillMs).toBeLessThanOrEqual(after + 60 * 1000);
  });

  it('rejects when quote_deadline would not be before fulfillment_deadline', async () => {
    await expect(
      prepareQuote({ quoteDeadlineSeconds: 60, fulfillmentDeadlineSeconds: 60 }),
    ).rejects.toThrow(/strictly less than/);
    await expect(
      prepareQuote({ quoteDeadlineSeconds: 120, fulfillmentDeadlineSeconds: 60 }),
    ).rejects.toThrow(/strictly less than/);
  });

  it('uses an explicit max_source_amount when provided', async () => {
    const quoteRequest = await prepareQuote({ maxSourceAmount: '12345' });
    expect(quoteRequest.max_source_amount).toBe('12345');
  });

  // On a quote request an absent cap means "no cap applied" to the gateway, so any
  // SDK-invented value would silently narrow which settlers can quote. The key must
  // be absent from the body, not present-and-undefined, so the wire shape is unambiguous.
  it.each(['1', '10000', '2000000', '1000000000000000000'])(
    'omits max_source_amount entirely when no cap is given (fulfillment %s)',
    async (fulfillmentAmount) => {
      const quoteRequest = await prepareQuote({ fulfillmentAmount });
      expect(Object.prototype.hasOwnProperty.call(quoteRequest, 'max_source_amount')).toBe(false);
      expect(quoteRequest).not.toHaveProperty('max_source_amount');
      expect(JSON.stringify(quoteRequest)).not.toContain('max_source_amount');
    },
  );

  // Token amounts routinely exceed 2^53; a string cap must survive byte-for-byte
  // rather than round-tripping through a JS number.
  it('carries an explicit max_source_amount past 2^53 through exactly', async () => {
    const quoteRequest = await prepareQuote({ maxSourceAmount: '1000000000000000001' });
    expect(quoteRequest.max_source_amount).toBe('1000000000000000001');
  });

  // The cap is a positive integer in smallest units, written canonically. Anything
  // else is refused locally so a malformed cap never reaches the gateway, and plain-JS
  // callers passing a number (possibly already rounded) or null are refused too.
  it.each<[string, unknown]>([
    ['empty string', ''],
    ['zero', '0'],
    ['leading zero', '01'],
    ['decimal', '1.5'],
    ['negative', '-5'],
    ['leading whitespace', ' 5'],
    ['trailing whitespace', '5 '],
    ['non-numeric', 'abc'],
    ['exponent notation', '1e6'],
    ['hex', '0x10'],
    ['number', 5],
    // eslint-disable-next-line no-loss-of-precision -- deliberately imprecise, to prove a pre-rounded number is refused
    ['unsafe number', 9007199254740993],
    ['null', null],
  ])('rejects a malformed max_source_amount (%s)', async (_label, maxSourceAmount) => {
    const pending = prepareQuote({ maxSourceAmount: maxSourceAmount as unknown as string });
    await expect(pending).rejects.toBeInstanceOf(Error);
    await expect(pending).rejects.toThrow(/^payment-gateway-client:/);
  });

  it('includes settler_requirements only when provided', async () => {
    expect((await prepareQuote()).settler_requirements).toBeUndefined();
    const withWhitelist = await prepareQuote({
      settlerRequirements: { whitelist: ['did:example:settler'] },
    });
    expect(withWhitelist.settler_requirements).toEqual({ whitelist: ['did:example:settler'] });
  });

  // requestId is required and used verbatim — the library never invents one. Generating an id
  // on the caller's behalf would mean a rebuilt retry silently opened a SECOND batch, leaving
  // the first unreachable, which is exactly what reusing the id exists to prevent. This replaces
  // an earlier test that asserted a generated `requestIdPrefix` id; that behaviour is gone.
  // Typed as required, but also checked at runtime: an untyped JS caller or an `any` params
  // object would otherwise put an empty key on the wire and silently open a second batch.
  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])(
    'rejects a %s requestId instead of putting an empty key on the wire',
    async (_label, requestId) => {
      await expect(prepareQuote({ requestId } as { requestId: string })).rejects.toThrow(
        /requestId is required/,
      );
    },
  );

  // The gateway strict-reads the stored quote request when it saves a quote, so a request id
  // outside the pattern is refused here, as it is for a payment.
  it('refuses a request id outside the request_id pattern, naming it', async () => {
    await expect(prepareQuote({ requestId: 'order#1' })).rejects.toThrow(
      'requestId "order#1" does not match ^[A-Za-z0-9._-]{1,128}$',
    );
  });

  it('carries the caller request_id verbatim and never generates one', async () => {
    const quoteRequest = await prepareQuote({ requestId: 'qr-caller-supplied' });
    expect(quoteRequest.request_id).toBe('qr-caller-supplied');

    const again = await prepareQuote({ requestId: 'qr-caller-supplied' });
    expect(again.request_id).toBe(quoteRequest.request_id);
  });
});

describe('PaymentGatewayClient gateway base URL resolution', () => {
  const ORIGINAL_GATEWAY_URL = process.env.GATEWAY_URL;

  afterEach(() => {
    if (ORIGINAL_GATEWAY_URL === undefined) {
      delete process.env.GATEWAY_URL;
    } else {
      process.env.GATEWAY_URL = ORIGINAL_GATEWAY_URL;
    }
  });

  // There is now exactly ONE base URL: the generated request layer's `config.BASE`,
  // which carries every call including GET /v1/defaults. The old "prepare on one host,
  // submit on another" split is gone by construction rather than by assertion — the
  // wrapper no longer holds a second base URL that could disagree. What still needs
  // pinning is the resolution ORDER and the normalization, below.
  function baseOf(client: PaymentGatewayClient): string {
    return (client as unknown as { request: { config: { BASE: string } } }).request.config.BASE;
  }

  it('uses the built-in testnet default with no config and no env', () => {
    delete process.env.GATEWAY_URL;
    expect(baseOf(new PaymentGatewayClient())).toBe(defaultGateway);
  });

  it('honors an explicit { BASE } over the environment', () => {
    process.env.GATEWAY_URL = 'https://env.example';
    expect(baseOf(new PaymentGatewayClient({ BASE: 'https://explicit.example' }))).toBe(
      'https://explicit.example',
    );
  });

  it('falls back to GATEWAY_URL when no { BASE } is given', () => {
    process.env.GATEWAY_URL = 'https://env.example';
    expect(baseOf(new PaymentGatewayClient())).toBe('https://env.example');
  });

  // A set-but-blank GATEWAY_URL is the normal shape of an unset optional: a
  // copied `.env.example` line left empty, or `GATEWAY_URL: ${{ vars.GATEWAY_URL }}`
  // in CI resolving to "". It must read as unset, not as an empty base URL —
  // an empty base makes every request a relative URL, which throws
  // "Failed to parse URL" on the first call rather than falling back.
  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['tab and newline', '\t\n'],
  ])('treats a %s GATEWAY_URL as unset and uses the testnet default', (_label, value) => {
    process.env.GATEWAY_URL = value;
    expect(baseOf(new PaymentGatewayClient())).toBe(defaultGateway);
  });

  it('trims surrounding whitespace off a set GATEWAY_URL', () => {
    process.env.GATEWAY_URL = '  https://env.example  ';
    expect(baseOf(new PaymentGatewayClient())).toBe('https://env.example');
  });

  // An explicit BASE is a deliberate caller choice and is NOT normalized:
  // `BASE: ''` drives the SDK against a same-origin proxy, where relative
  // request URLs are what the caller wants.
  it('preserves an explicit empty { BASE } rather than falling back', () => {
    process.env.GATEWAY_URL = 'https://env.example';
    expect(baseOf(new PaymentGatewayClient({ BASE: '' }))).toBe('');
  });
});

describe('published OpenAPI request-layer defaults', () => {
  // The generated `OpenAPI.BASE` mirrors servers[0] in the spec (mainnet, matching
  // every other Atum service spec). This package re-exports it with BASE corrected
  // to its own default, so the advertised default can never contradict what a
  // zero-config client actually resolves — the contradiction that produced the
  // prepare-on-testnet / submit-to-mainnet split.
  it('advertises the same default gateway the client resolves', () => {
    expect(OpenAPI.BASE).toBe(defaultGateway);
  });

  it('advertises a testnet default, never a mainnet host', () => {
    expect(OpenAPI.BASE).toContain('production-testnet');
    expect(OpenAPI.BASE).not.toContain('mainnet');
  });

  it('preserves every other generated config field', () => {
    expect(OpenAPI).toMatchObject({
      CREDENTIALS: 'include',
      VERSION: '1.0.0',
      WITH_CREDENTIALS: false,
    });
    expect(OpenAPI.interceptors.request).toBeDefined();
    expect(OpenAPI.interceptors.response).toBeDefined();
  });
});

describe('default deadlines', () => {
  // Pinned as literals so that changing a default is a deliberate edit here, not a side effect.
  // The payment defaults are read from the API description, so this also catches an edit there.
  it('defaults both builders to a 3s quote deadline', () => {
    expect(DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS).toBe(3);
    expect(DEFAULT_QUOTE_DEADLINE_SECONDS).toBe(3);
  });

  it('defaults both builders to a 5-minute fulfillment deadline', () => {
    expect(DEFAULT_FULFILLMENT_DEADLINE_SECONDS).toBe(300);
  });
});

// The receiver gate runs before anything is signed or submitted, so a caller learns the
// destination cannot be paid here rather than through a 400 after building a request.
describe('PaymentGatewayClient receiver pre-flight', () => {
  const client = new PaymentGatewayClient({ BASE: 'https://gw.example' });

  const quote = (destinationAccount: string) =>
    client.prepareQuoteRequest({
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: '100000',
      sourceAsset: 'eip155:42161/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount,
      destinationAsset: 'eip155:42220/erc20:0x0000000000000000000000000000000000000008',
      // Required since the id became the caller's to supply. Fixed here because the receiver gate
      // runs before it, so these cases must fail on the account rather than on a missing key.
      requestId: 'qr-receiver-preflight',
    });

  it.each([
    ['not an address', 'nope'],
    ['the zero address', '0x0000000000000000000000000000000000000000'],
    ['surrounding whitespace', ' 0x0000000000000000000000000000000000000007'],
    ['empty', ''],
  ])('refuses %s before signing', async (_label, account) => {
    await expect(quote(account)).rejects.toThrow(InvalidAccountError);
  });

  // A payable receiver gets past the gate and on to the chain-defaults fetch, which has no
  // server here. Asserting the error is NOT an InvalidAccountError is what proves the gate
  // let it through rather than the request simply failing for another reason.
  it('lets a payable receiver through', async () => {
    const error = await quote('0x0000000000000000000000000000000000000007').catch((e) => e);

    expect(error).not.toBeInstanceOf(InvalidAccountError);
  });
});
