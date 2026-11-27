// The entry points, not the parser, own canonicalization and validation: they parse before they
// touch the gateway, and the spelling they emit is what ComputeRequestHash hashes verbatim.
// asset-identifier.test.ts pins the exact wording of every rejection, so the assertions here derive
// the message from the parser rather than restating it. Nothing is mocked: a stubbed adapter
// registry accepts any spelling, and the real sender_auth SDK is the only thing that can observe a
// non-canonical asset reaching the deposit builder.
import { buildEscrowDestination } from '@atum-labs/payment-request-sender-auth';

import { PaymentGatewayClient, parseAssetIdentifier } from './index';
import type { ChainDefaults } from './chain-adapters';

// Frozen: one object is served to every test, so a builder writing to its defaults would leak.
// permit2Contract stays absent, since the Tron cases depend on the SDK resolving Permit2 by
// chain-id key, which a supplied address would short-circuit.
const evmDefaults: ChainDefaults = Object.freeze({
  escrowContract: '0x0000000000000000000000000000000000000001',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
  quoteSelector: '0x0000000000000000000000000000000000000003',
  fulfillmentVerifierAccount: '0x0000000000000000000000000000000000000004',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
});

// A Solana deposit hash binds to the escrow domain, so its defaults carry the svm fields and
// base58 corridor addresses.
const solanaDefaults: ChainDefaults = Object.freeze({
  escrowContract: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  quoteSelector: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
  fulfillmentVerifierAccount: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
  svmSignatureClusterId: 'devnet',
  svmSignatureDomainVersion: 5,
});

// Per-instance stub, so each test reads its own call record and nothing leaks between tests. BASE
// is unreachable on purpose: the stub is the only thing standing in for the gateway.
class StubDefaultsClient extends PaymentGatewayClient {
  constructor(private readonly served: ChainDefaults = evmDefaults) {
    super({ BASE: 'https://gateway.invalid' });
  }

  fetchChainDefaults = jest.fn(async (_chainId: string): Promise<ChainDefaults> => this.served);
}

function newClient(served?: ChainDefaults): StubDefaultsClient {
  return new StubDefaultsClient(served);
}

// Uppercase in both segments CAIP pins to lowercase, and a mixed-case address whose EIP-55 checksum
// holds. Both halves matter: the namespaces must come back lowercased and the address byte for
// byte, so lowercasing the identifier as a whole fails here too.
const SOURCE_IN = 'EIP155:42161/ERC20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const SOURCE_OUT = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const DEST_IN = 'EIP155:42220/ERC20:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const DEST_OUT = 'eip155:42220/erc20:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const TRON_TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_ACCOUNT = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
const SOLANA_MINT = 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN';
const SOLANA_ACCOUNT = 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse';

const MALFORMED_SHAPE = 'eip155:42161';
// Shouted on purpose: an address rule keyed off the raw namespace is skipped by shouting it, which
// is silent unless a malformed value arrives that way.
const MALFORMED_TOKEN = 'EIP155:42220/erc20:0xabc';
const BAD_CHECKSUM = 'eip155:42161/erc20:0xAf88d065e77c8cC2239327C5EDb3A432268e5831';
// A routable chain half on a non-EVM namespace, so only the parser can refuse the empty token.
const MALFORMED_NON_EVM = 'tron:shasta/trc20:';

const NOW_MS = Date.parse('2035-01-01T00:00:00.000Z');

type PaymentParams = Parameters<PaymentGatewayClient['preparePaymentRequest']>[0];
type QuoteParams = Parameters<PaymentGatewayClient['prepareQuoteRequest']>[0];

function paymentParams(overrides: Partial<PaymentParams> = {}): PaymentParams {
  return {
    depositor: '0x0000000000000000000000000000000000000005',
    fulfillmentAmount: '100000',
    maxSourceAmount: '103000',
    sourceAsset: SOURCE_IN,
    destinationAccount: '0x0000000000000000000000000000000000000007',
    destinationAsset: DEST_IN,
    requestId: 'entry-point-payment',
    quoteDeadlineSeconds: 20,
    fulfillmentDeadlineSeconds: 3600,
    now: () => NOW_MS,
    ...overrides,
  };
}

function quoteParams(overrides: Partial<QuoteParams> = {}): QuoteParams {
  return {
    depositor: '0x0000000000000000000000000000000000000005',
    fulfillmentAmount: '100000',
    maxSourceAmount: '103000',
    sourceAsset: SOURCE_IN,
    destinationAccount: '0x0000000000000000000000000000000000000007',
    destinationAsset: DEST_IN,
    requestId: 'entry-point-quote',
    ...overrides,
  };
}

/** Derived, not restated: a fixture that stopped being malformed fails here instead of passing. */
function parserMessage(value: string): string {
  try {
    parseAssetIdentifier(value);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`fixture is not malformed: ${value}`);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`rejected with a non-Error value: ${String(err)}`, { cause: err });
  }
  throw new Error('expected the call to reject');
}

const depositOf = (pr: { sender_auth?: { signed_messages?: { message?: string }[] } }): string =>
  pr.sender_auth!.signed_messages![0]!.message!;

/** The signed deposit's prehash — the typed data, so its witness can be read back. */
const prehashOf = (pr: {
  sender_auth?: { signed_messages?: { message_prehash?: string }[] };
}): string => pr.sender_auth!.signed_messages![0]!.message_prehash!;

describe('preparePaymentRequest/prepareQuoteRequest asset_identifier canonicalization', () => {
  it('preparePaymentRequest lowercases the namespaces, keeps the address, and routes on the canonical chain id', async () => {
    const client = newClient();

    const pr = await client.preparePaymentRequest(paymentParams());

    expect(pr.source.asset_identifier).toBe(SOURCE_OUT);
    expect(pr.destination[0]!.asset_identifier).toBe(DEST_OUT);
    // The gateway is asked about the lowercased chains, source first.
    expect(client.fetchChainDefaults.mock.calls.map(([chainId]) => chainId)).toEqual([
      'eip155:42161',
      'eip155:42220',
    ]);
  });

  it('signs a destination commitment composed from the destination the request body names', async () => {
    const client = newClient();

    const pr = await client.preparePaymentRequest(paymentParams());

    // The invariant, not the symptom. The escrow stores only keccak256(bytes(destination)) and
    // cannot tell a formatting disagreement from a wrong payee, so the payee the payer SIGNED and
    // the payee the request body NAMES must be the same one. Passing the caller's raw spelling to
    // the deposit builder instead of the parsed one breaks that: with DEST_IN's "EIP155:" the
    // commitment would cover a different string than destination[0] advertises, and the resulting
    // deposit could be neither released nor refunded.
    //
    // Derived through the shared composer rather than restated, for the reason this file already
    // derives its rejection messages: the one legitimate difference between the two spellings is
    // that eip155 token addresses are lowercased (base58 segments are NOT, being case-significant),
    // and hard-coding that here would pin a second, drifting copy of the grammar.
    const witness = JSON.parse(prehashOf(pr)).message.witness as { destination: string };
    expect(witness.destination).toBe(
      buildEscrowDestination(pr.destination[0]!.asset_identifier, pr.destination[0]!.account),
    );
    // And it is the canonical spelling that got signed, not the caller's.
    expect(pr.destination[0]!.asset_identifier).toBe(DEST_OUT);
  });

  it('prepareQuoteRequest emits the same canonical spelling as the payment path', async () => {
    const client = newClient();

    const quote = await client.prepareQuoteRequest(quoteParams());

    expect(quote.source.asset_identifier).toBe(SOURCE_OUT);
    expect(quote.destination[0]!.asset_identifier).toBe(DEST_OUT);
    expect(client.fetchChainDefaults.mock.calls.map(([chainId]) => chainId)).toEqual([
      'eip155:42161',
      'eip155:42220',
    ]);
  });

  // Both legs of both entry points, on a namespace whose address form is not EVM: canonicalization
  // that only holds for eip155 leaves the other three sites free to emit the raw input.
  it.each(['preparePaymentRequest', 'prepareQuoteRequest'] as const)(
    '%s canonicalizes a shouted non-EVM asset on both legs',
    async (method) => {
      const client = newClient();
      const shouted = `TRON:shasta/TRC20:${TRON_TOKEN}`;
      const expected = `tron:shasta/trc20:${TRON_TOKEN}`;
      const params = {
        sourceAsset: shouted,
        destinationAsset: shouted,
        depositor: TRON_ACCOUNT,
        destinationAccount: TRON_ACCOUNT,
      };

      const built =
        method === 'preparePaymentRequest'
          ? await client.preparePaymentRequest(paymentParams(params))
          : await client.prepareQuoteRequest(quoteParams(params));

      expect(built.source.asset_identifier).toBe(expected);
      expect(built.destination[0]!.asset_identifier).toBe(expected);
    },
  );

  it('a Tron source signs the same deposit whichever way its namespaces are capitalized', async () => {
    // Tron's Permit2 address resolves by exact chain-id key, so a shouted spelling throws instead of
    // signing. On EVM this is unobservable: the adapter re-splits and reads the reference as a number.
    const build = (sourceAsset: string) =>
      newClient().preparePaymentRequest(
        paymentParams({ sourceAsset, depositor: TRON_ACCOUNT, requestId: 'entry-point-tron' }),
      );

    const canonical = await build(`tron:shasta/trc20:${TRON_TOKEN}`);
    const shouted = await build(`TRON:shasta/TRC20:${TRON_TOKEN}`);
    const otherNetwork = await build(`tron:mainnet/trc20:${TRON_TOKEN}`);

    expect(shouted).toEqual(canonical);
    // The deposit is bound to the network it names, so the comparison above is not two builds of
    // the same thing.
    expect(depositOf(otherNetwork)).not.toBe(depositOf(canonical));
  });

  it('a Solana source signs the same deposit whichever way its namespaces are capitalized', async () => {
    // The namespace also selects the deposit's nonce shape and clock: read from the raw input, a
    // shouted Solana source takes the EVM branch and gets a 256-bit Permit2 nonce it cannot hold.
    const build = (sourceAsset: string) =>
      newClient(solanaDefaults).preparePaymentRequest(
        paymentParams({
          sourceAsset,
          depositor: SOLANA_ACCOUNT,
          requestId: 'entry-point-solana',
          solanaRpcUrl: 'http://localhost:8899',
          solanaClockReader: async () => 1700000000n,
        }),
      );

    const canonical = await build(`solana:mainnet/spl:${SOLANA_MINT}`);
    const shouted = await build(`SOLANA:mainnet/SPL:${SOLANA_MINT}`);

    expect(shouted).toEqual(canonical);
    expect(shouted.source.asset_identifier).toBe(`solana:mainnet/spl:${SOLANA_MINT}`);
  });
});

describe('preparePaymentRequest/prepareQuoteRequest reject a malformed asset identifier', () => {
  it.each([
    [
      'preparePaymentRequest',
      'source',
      MALFORMED_SHAPE,
      (v: string) => paymentParams({ sourceAsset: v }),
    ],
    [
      'preparePaymentRequest',
      'destination',
      MALFORMED_TOKEN,
      (v: string) => paymentParams({ destinationAsset: v }),
    ],
    [
      'preparePaymentRequest',
      'source',
      BAD_CHECKSUM,
      (v: string) => paymentParams({ sourceAsset: v }),
    ],
    [
      'preparePaymentRequest',
      'destination',
      MALFORMED_NON_EVM,
      (v: string) => paymentParams({ destinationAsset: v }),
    ],
    // The destination leg of the payment path is the one the gateway itself resolves, so its rules
    // are the client's own and have to stay pinned.
    [
      'preparePaymentRequest',
      'destination',
      BAD_CHECKSUM,
      (v: string) => paymentParams({ destinationAsset: v }),
    ],
    [
      'prepareQuoteRequest',
      'source',
      MALFORMED_TOKEN,
      (v: string) => quoteParams({ sourceAsset: v }),
    ],
    [
      'prepareQuoteRequest',
      'destination',
      MALFORMED_SHAPE,
      (v: string) => quoteParams({ destinationAsset: v }),
    ],
    [
      'prepareQuoteRequest',
      'destination',
      BAD_CHECKSUM,
      (v: string) => quoteParams({ destinationAsset: v }),
    ],
    [
      'prepareQuoteRequest',
      'source',
      MALFORMED_NON_EVM,
      (v: string) => quoteParams({ sourceAsset: v }),
    ],
  ] as const)('%s names %s asset "%s" and fetches nothing', async (method, _leg, value, build) => {
    const client = newClient();

    const params = build(value) as PaymentParams & QuoteParams;
    const err = await rejection(
      method === 'preparePaymentRequest'
        ? client.preparePaymentRequest(params)
        : client.prepareQuoteRequest(params),
    );

    expect(err.message).toContain(parserMessage(value));
    // None of ethers' own failures may be what the caller sees.
    expect(err.message).not.toMatch(/Cannot read properties|invalid address|bad address checksum/i);
    // Paired with the message assertion on purpose: zero calls alone would also hold if the
    // rejection came from an unrelated earlier guard, such as deadline resolution.
    expect(client.fetchChainDefaults).not.toHaveBeenCalled();
  });
});
