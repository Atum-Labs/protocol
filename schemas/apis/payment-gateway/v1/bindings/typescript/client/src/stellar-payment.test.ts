// A Stellar payment built offline by the SDK, signed by the raw delegate signer, and verified by the
// shared sender_auth verifier. What it proves is the loop the live escrow depends on: the signature
// is over the digest the escrow encoder derives from the request's terms and the verifier's own
// network and escrow.
import nacl from 'tweetnacl';
import { Address } from '@atum-labs/stellar-escrow-encoding';
import {
  buildReserveMessage,
  getChainAdapter,
  verifyPaymentRequestJSON,
} from '@atum-labs/payment-request-sender-auth';
import { PaymentGatewayClient, createSenderSigner, signPaymentRequest } from './index';
import type { ChainDefaults } from './chain-adapters';
import { readAwardInputs } from './award-quote';
import type { AwardQuoteParams, CreateQuoteRequest } from './index';
import { startFakeGateway, type FakeGateway } from './test-support/fake-gateway';
import { quoteFor } from './test-support/quotes';

const fill = (byte: number) => new Uint8Array(32).fill(byte);
const account = (byte: number) => Address.account(fill(byte)).toString();
const contract = (byte: number) => Address.contract(fill(byte)).toString();

const HEX_KEY = '33'.repeat(32);
// The payer's own key is its delegate signer: the only shape an offline verifier admits.
const DELEGATE_KEYS = nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(HEX_KEY, 'hex')));
const DEPOSITOR = Address.account(DELEGATE_KEYS.publicKey).toString();
// A payer whose delegate is a separate key: built and signed, but refused by an offline verifier.
const OTHER_PAYER = account(0xd1);
const TOKEN = contract(0xe1);
const DEFAULTS: ChainDefaults = {
  escrowContract: contract(0xc0),
  quoteSelector: account(0x55),
  fulfillmentVerifierAccount: account(0x66),
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
};
const NOW_MS = Date.parse('2035-01-01T00:00:00.000Z');

class NoFetchClient extends PaymentGatewayClient {
  async fetchChainDefaults(): Promise<ChainDefaults> {
    throw new Error('fetchChainDefaults must not be called on the offline path');
  }
}

const params = (extra: Record<string, unknown> = {}) => ({
  depositor: DEPOSITOR,
  fulfillmentAmount: '100000',
  sourceAsset: `stellar:testnet/sep41:${TOKEN}`,
  destinationAccount: '0x0000000000000000000000000000000000000007',
  destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
  maxSourceAmount: '103000',
  requestId: 'req-stellar-sdk',
  quoteDeadlineSeconds: 20,
  fulfillmentDeadlineSeconds: 3600,
  now: () => NOW_MS,
  stellarRpcUrl: 'http://localhost:8000/rpc',
  stellarClockReader: async () => BigInt(NOW_MS / 1000),
  stellarDelegateEpoch: 3,
  resolvedDefaults: {
    source: DEFAULTS,
    destination: { fulfillmentProxy: DEFAULTS.fulfillmentProxy },
  },
  ...extra,
});

// The escrow's delegate record for DEPOSITOR: its own key registered, live for a year, with capacity.
const RECORD = (epoch: bigint, over: Record<string, unknown> = {}) => ({
  epoch,
  delegateSigner: DEPOSITOR,
  remainingCapacity: 10n ** 9n,
  maxTransferSize: 10n ** 9n,
  expiration: BigInt(NOW_MS / 1000) + 365n * 86400n,
  ...over,
});

const client = () => new NoFetchClient({ BASE: 'https://gateway.invalid' });
const expectations = {
  escrowContract: DEFAULTS.escrowContract,
  reserver: DEFAULTS.quoteSelector,
  releaser: DEFAULTS.fulfillmentVerifierAccount,
};

describe('Stellar payment through the SDK', () => {
  it('builds, signs and verifies, with the delegate named in the payload', async () => {
    const request = await client().preparePaymentRequest(params());
    expect(request.sender_auth.message_scheme).toBe('STELLAR');
    expect(request.escrow_contract_address).toBe(DEFAULTS.escrowContract);
    expect(request.quote_selector).toBe(DEFAULTS.quoteSelector);

    const prehash = JSON.parse(request.sender_auth.signed_messages[0]!.message_prehash!);
    expect(prehash.issued_at).toBe(String(NOW_MS / 1000));
    expect(prehash.token).toBe(TOKEN);
    expect(prehash.depositor).toBe(DEPOSITOR);
    expect(prehash.epoch).toBe('3');
    expect(Number(prehash.deadline) - Number(prehash.issued_at)).toBeLessThanOrEqual(86400);

    const signed = await signPaymentRequest(
      request,
      createSenderSigner('stellar:testnet', { privateKey: HEX_KEY }),
    );
    const delegate = Address.account(
      nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(HEX_KEY, 'hex'))).publicKey,
    ).toString();
    expect(signed.sender_auth.signed_messages[0]!.payload).toEqual({ delegate_signer: delegate });

    const result = verifyPaymentRequestJSON(JSON.stringify(signed), expectations);
    expect(result.results[0]!.amount).toBe('103000');
    expect(result.results[0]!.permit.scheme).toBe('STELLAR');
    // The verified permit names the delegate (the depositor's own key) and says its registration is
    // still unverified.
    expect(result.results[0]!.permit.delegateSigner).toBe(delegate);
    expect(result.results[0]!.permit.delegateOnchainUnverified).toBe(true);
    // ...and the epoch the digest commits to, for the party that reads the chain.
    expect(result.results[0]!.permit.delegateEpoch).toBe('3');
  });

  it('a separately delegated payer builds and signs, and an offline verifier refuses it', async () => {
    const signed = await signPaymentRequest(
      await client().preparePaymentRequest(params({ depositor: OTHER_PAYER })),
      createSenderSigner('stellar:testnet', { privateKey: HEX_KEY }),
    );
    expect(() => verifyPaymentRequestJSON(JSON.stringify(signed), expectations)).toThrow(
      /delegate signer is not source\.account/,
    );
  });

  it('a rebuild reproduces the same nonce and, with a pinned ledger time, the same signed bytes', async () => {
    const a = await client().preparePaymentRequest(params());
    const b = await client().preparePaymentRequest(params());
    expect(a.sender_auth.signed_messages[0]!.message).toBe(
      b.sender_auth.signed_messages[0]!.message,
    );
    const other = await client().preparePaymentRequest(params({ requestId: 'req-stellar-other' }));
    expect(other.sender_auth.signed_messages[0]!.message).not.toBe(
      a.sender_auth.signed_messages[0]!.message,
    );
  });

  it('a verifier that pins no reserver or releaser refuses, unlike EVM and Solana', async () => {
    const signed = await signPaymentRequest(
      await client().preparePaymentRequest(params()),
      createSenderSigner('stellar:testnet', { privateKey: HEX_KEY }),
    );
    expect(() =>
      verifyPaymentRequestJSON(JSON.stringify(signed), { escrowContract: DEFAULTS.escrowContract }),
    ).toThrow(/expected reserver and releaser/);
  });

  it('a verifier on another network or escrow refuses it', async () => {
    const signed = await signPaymentRequest(
      await client().preparePaymentRequest(params()),
      createSenderSigner('stellar:testnet', { privateKey: HEX_KEY }),
    );
    expect(() =>
      verifyPaymentRequestJSON(JSON.stringify(signed), {
        ...expectations,
        escrowContract: contract(0xc1),
      }),
    ).toThrow(/Stellar deposit digest/);
    const pubnet = JSON.parse(JSON.stringify(signed));
    pubnet.source.asset_identifier = `stellar:pubnet/sep41:${TOKEN}`;
    expect(() => verifyPaymentRequestJSON(JSON.stringify(pubnet), expectations)).toThrow(
      /Stellar deposit digest/,
    );
  });

  it('refuses a validity window over the escrow bound before anything is signed', async () => {
    await expect(
      client().preparePaymentRequest(
        params({ fulfillmentDeadlineSeconds: 90000, deadlineSeconds: 90000 }),
      ),
    ).rejects.toThrow(/exceeds the escrow's 86400s bound/);
  });

  it('refuses an unknown network and a missing escrow', async () => {
    await expect(
      client().preparePaymentRequest(params({ sourceAsset: `stellar:mainnet/sep41:${TOKEN}` })),
    ).rejects.toThrow(/network is not one the verifier knows/);
    await expect(
      client().preparePaymentRequest(
        params({
          resolvedDefaults: {
            source: { ...DEFAULTS, escrowContract: '' },
            destination: { fulfillmentProxy: DEFAULTS.fulfillmentProxy },
          },
        }),
      ),
    ).rejects.toThrow(/escrow contract was not supplied/);
  });

  describe('the delegate epoch', () => {
    const without = () => params({ stellarDelegateEpoch: undefined });

    it('is read from the escrow for the depositor and token when the caller supplies none', async () => {
      const seen: unknown[] = [];
      const request = await client().preparePaymentRequest({
        ...without(),
        stellarDelegateEpochReader: async (query: unknown) => {
          seen.push(query);
          return 7n;
        },
      });
      expect(JSON.parse(request.sender_auth.signed_messages[0]!.message_prehash!).epoch).toBe('7');
      expect(seen).toEqual([
        {
          rpcUrl: 'http://localhost:8000/rpc',
          escrow: DEFAULTS.escrowContract,
          depositor: DEPOSITOR,
          token: TOKEN,
          timeoutMs: 5000,
        },
      ]);
    });

    it('is not read when the caller supplies it, and a different epoch signs a different digest', async () => {
      const a = await client().preparePaymentRequest(params({ stellarDelegateEpoch: 1 }));
      const b = await client().preparePaymentRequest({
        ...params({ stellarDelegateEpoch: 2n }),
        stellarDelegateEpochReader: async () => {
          throw new Error('the reader must not run when the epoch is supplied');
        },
      });
      expect(a.sender_auth.signed_messages[0]!.message).not.toBe(
        b.sender_auth.signed_messages[0]!.message,
      );
    });

    // The escrow refuses each of these at `deposit`, after the request has passed the gateway and the
    // auction, so the build refuses them before the payer signs.
    it('refuses a record that has expired at issued_at, and a renounced or spent one', async () => {
      const read = (over: Record<string, unknown>) => ({
        ...without(),
        stellarDelegateRecordReader: async () => RECORD(7n, over),
      });
      await expect(
        client().preparePaymentRequest(read({ expiration: BigInt(NOW_MS / 1000) })),
      ).rejects.toThrow(/expired at/);
      await expect(client().preparePaymentRequest(read({ remainingCapacity: 0n }))).rejects.toThrow(
        /no capacity left/,
      );
      // Control: a live record with capacity builds, at the epoch the record carries.
      const ok = await client().preparePaymentRequest(read({}));
      expect(JSON.parse(ok.sender_auth.signed_messages[0]!.message_prehash!).epoch).toBe('7');
    });

    it('refuses a payer whose signing key is not the registered delegate, and builds when it is', async () => {
      const other = account(0x11);
      await expect(
        client().preparePaymentRequest({
          ...without(),
          stellarDelegateRecordReader: async () => RECORD(7n, { delegateSigner: other }),
          stellarSigningKey: DEPOSITOR,
        }),
      ).rejects.toThrow(
        new RegExp(
          `the key signing is ${DEPOSITOR}, but the delegate registered for ${DEPOSITOR} is ${other}`,
        ),
      );
      await expect(
        client().preparePaymentRequest({
          ...without(),
          stellarDelegateRecordReader: async () => RECORD(7n),
          stellarSigningKey: DEPOSITOR,
        }),
      ).resolves.toBeDefined();
      // Without a signing key the signer is not compared.
      await expect(
        client().preparePaymentRequest({
          ...without(),
          stellarDelegateRecordReader: async () => RECORD(7n, { delegateSigner: other }),
        }),
      ).resolves.toBeDefined();
    });

    it('cannot check a record it did not read: a supplied epoch or an epoch reader skips the checks', async () => {
      await expect(
        client().preparePaymentRequest(
          params({ stellarSigningKey: account(0x11), stellarDelegateEpoch: 3 }),
        ),
      ).resolves.toBeDefined();
      await expect(
        client().preparePaymentRequest({
          ...without(),
          stellarSigningKey: account(0x11),
          stellarDelegateEpochReader: async () => 7n,
        }),
      ).resolves.toBeDefined();
    });

    it('fails, rather than defaulting to 1, when the payer has no delegate', async () => {
      await expect(
        client().preparePaymentRequest({
          ...without(),
          stellarDelegateEpochReader: async () => undefined,
        }),
      ).rejects.toThrow(/no delegate registered/);
    });

    it('fails when the read fails, and when the supplied epoch is unusable', async () => {
      await expect(
        client().preparePaymentRequest({
          ...without(),
          stellarDelegateEpochReader: async () => {
            throw new Error('rpc down');
          },
        }),
      ).rejects.toThrow('rpc down');
      for (const bad of [0, -1, 1.5, '0x1', '', 2n ** 64n]) {
        await expect(
          client().preparePaymentRequest(params({ stellarDelegateEpoch: bad })),
        ).rejects.toThrow(/must be an integer from 1 to 2\^64-1/);
      }
    });
  });
});

// A Stellar key signs 32 bytes with plain ed25519, which is also how a Stellar transaction is signed
// (over its hash). A requester that hands the payer a request whose message is such a hash must not
// get the payer's key's signature on it.
describe('signing a Stellar request', () => {
  const stellarSigner = () => createSenderSigner('stellar:testnet', { privateKey: HEX_KEY });
  const TX_HASH = '0x' + 'ab'.repeat(32);

  it('refuses a message that is not the deposit digest of its prehash, and signs nothing', async () => {
    const request = await client().preparePaymentRequest(params());
    request.sender_auth.signed_messages[0]!.message = TX_HASH;
    await expect(signPaymentRequest(request, stellarSigner())).rejects.toThrow(
      /refusing to sign bytes that are not the deposit/,
    );
    expect(request.sender_auth.signed_messages[0]!.signature).toBe('');
  });

  it('refuses a message with its prehash removed', async () => {
    const request = await client().preparePaymentRequest(params());
    delete request.sender_auth.signed_messages[0]!.message_prehash;
    await expect(signPaymentRequest(request, stellarSigner())).rejects.toThrow(/message_prehash/);
  });

  it('rebuilds the digest under the request escrow: another escrow is not this deposit', async () => {
    const request = await client().preparePaymentRequest(params());
    request.escrow_contract_address = contract(0xc1);
    await expect(signPaymentRequest(request, stellarSigner())).rejects.toThrow(/refusing to sign/);
  });

  it('refuses a Stellar key for a request that says its source is another network', async () => {
    const request = await client().preparePaymentRequest(params());
    request.source.asset_identifier = 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    request.sender_auth.signed_messages[0]!.message = TX_HASH;
    await expect(signPaymentRequest(request, stellarSigner())).rejects.toThrow(
      /the signer is for stellar:testnet but the request's source is eip155:1/,
    );
    expect(request.sender_auth.signed_messages[0]!.signature).toBe('');
  });

  it('checks every message before signing any of them', async () => {
    const request = await client().preparePaymentRequest(params());
    const first = request.sender_auth.signed_messages[0]!;
    request.sender_auth.signed_messages.push({ ...first, message: TX_HASH });
    await expect(signPaymentRequest(request, stellarSigner())).rejects.toThrow(/refusing to sign/);
    expect(first.signature).toBe('');
  });

  it('exposes the network its key is for', () => {
    expect(stellarSigner().network).toBe('stellar:testnet');
  });
});

describe('awardQuote on Stellar', () => {
  const DELEGATE_SEED = HEX_KEY;
  const SELECTOR_SEED = '44'.repeat(32);
  const keyOf = (seed: string) => nacl.sign.keyPair.fromSeed(Buffer.from(seed, 'hex'));
  const SELECTOR = Address.account(keyOf(SELECTOR_SEED).publicKey).toString();
  const SETTLER = account(0xa5);
  const QUOTE_ID = '0x' + 'cd'.repeat(32);
  const QUOTE_AMOUNT = '99000';
  const CAP = '100000';
  // The quote request stamps its deadlines from the real clock, so the ledger time is the real one.
  const NOW = Math.floor(Date.now() / 1000);

  let gateway: FakeGateway;
  let gw: PaymentGatewayClient;
  const depositorSigner = () =>
    createSenderSigner('stellar:testnet', { privateKey: DELEGATE_SEED });
  const selectorSigner = () => createSenderSigner('stellar:testnet', { privateKey: SELECTOR_SEED });

  beforeEach(async () => {
    gateway = await startFakeGateway({
      responders: {
        'GET /v1/defaults': (req) => ({
          body: {
            chain_id: req.query.chain_id,
            escrow_contract: DEFAULTS.escrowContract,
            quote_selector: DEFAULTS.quoteSelector,
            fulfillment_verifier: {
              account: DEFAULTS.fulfillmentVerifierAccount,
              endpoint: DEFAULTS.fulfillmentVerifierEndpoint,
            },
            fulfillment_proxy: DEFAULTS.fulfillmentProxy,
            deposit_request_hash_versions: [1, 2],
          },
        }),
      },
    });
    gw = new PaymentGatewayClient({ BASE: gateway.url });
  });
  afterEach(() => gateway.close());

  const quoteRequest = (extra: Record<string, unknown> = {}) =>
    gw.prepareQuoteRequest({
      depositor: DEPOSITOR,
      fulfillmentAmount: '98000',
      sourceAsset: `stellar:testnet/sep41:${TOKEN}`,
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      maxSourceAmount: CAP,
      requestId: 'qr-stellar',
      quoteSelector: SELECTOR,
      ...extra,
    });

  const award = (qr: CreateQuoteRequest, extra: Partial<AwardQuoteParams> = {}) =>
    gw.awardQuote({
      requestId: 'award-stellar',
      quoteRequestId: 'qr_test',
      quoteRequest: qr,
      quote: quoteFor(qr, {
        quoteId: QUOTE_ID,
        sourceAmount: QUOTE_AMOUNT,
        settlerAddress: SETTLER,
      }),
      depositorSigner: depositorSigner(),
      selectorSigner: selectorSigner(),
      stellarClockReader: async () => BigInt(NOW),
      stellarDelegateEpoch: 3,
      ...extra,
    });

  it('signs the deposit for the quote amount, and the reserve over the deposit digest', async () => {
    const qr = await quoteRequest();
    const { paymentId, request, response } = await award(qr);

    const [posted] = gateway.received('POST', '/v1/payments/awards');
    expect(posted!.violation).toBeUndefined();
    expect(posted!.body).toEqual(request);
    expect(response.payment_id).toBe('0xpayment');
    expect(Object.keys(request).sort()).toEqual(
      ['quote_id', 'quote_request_id', 'request_id', 'reserve_auth', 'sender_auth'].sort(),
    );

    // The deposit: the quote's amount as the ceiling, the selector as reserver, the epoch read.
    const deposit = request.sender_auth!.signed_messages[0]!;
    const prehash = JSON.parse(deposit.message_prehash!);
    expect(request.sender_auth!.message_scheme).toBe('STELLAR');
    expect(prehash).toMatchObject({
      amount: QUOTE_AMOUNT,
      reserver: SELECTOR,
      releaser: DEFAULTS.fulfillmentVerifierAccount,
      epoch: '3',
      issued_at: String(NOW),
      depositor: DEPOSITOR,
      token: TOKEN,
    });
    expect(Number(prehash.deadline)).toBe(
      Math.floor(Date.parse(qr.fulfillment_deadline) / 1000) + 1,
    );
    const verified = verifyPaymentRequestJSON(
      JSON.stringify({ ...qr, sender_auth: request.sender_auth }),
      {
        quoteSourceAmount: QUOTE_AMOUNT,
        escrowContract: DEFAULTS.escrowContract,
        reserver: SELECTOR,
        releaser: DEFAULTS.fulfillmentVerifierAccount,
        depositRequestHashV2Mode: 'enforce',
      },
    );
    expect(verified.results[0]!.permit.amount).toBe(QUOTE_AMOUNT);
    expect(verified.results[0]!.permit.delegateEpoch).toBe('3');
    expect(deposit.payload).toEqual({
      delegate_signer: Address.account(keyOf(DELEGATE_SEED).publicKey).toString(),
    });

    // The deposit id is the signed deposit digest.
    expect(paymentId).toBe(deposit.message.toLowerCase());

    // The reserve: the escrow's reserve digest over that id, signed by the selector's key.
    const expected = buildReserveMessage({
      network: 'stellar:testnet',
      escrowContract: DEFAULTS.escrowContract,
      depositId: paymentId,
      quoteHash: QUOTE_ID,
      settler: SETTLER,
      sourceAmount: QUOTE_AMOUNT,
    });
    expect(request.reserve_auth!.message).toBe(expected.message);
    expect(JSON.parse(request.reserve_auth!.message_prehash)).toEqual(
      JSON.parse(expected.message_prehash),
    );
    expect(
      nacl.sign.detached.verify(
        Buffer.from(expected.message.slice(2), 'hex'),
        Buffer.from(request.reserve_auth!.signature.slice(2), 'hex'),
        keyOf(SELECTOR_SEED).publicKey,
      ),
    ).toBe(true);
  });

  it('starts the Stellar ledger clock and delegate reads independently', async () => {
    const qr = await quoteRequest();
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const waitForBoth = async () => {
      reads += 1;
      if (reads === 2) release();
      await started;
    };
    await expect(
      award(qr, {
        stellarDelegateEpoch: undefined,
        stellarRpcUrl: 'http://localhost:8000/rpc',
        stellarClockReader: async () => {
          await waitForBoth();
          return BigInt(NOW);
        },
        stellarDelegateRecordReader: async () => {
          await waitForBoth();
          return RECORD(7n);
        },
      }),
    ).resolves.toBeDefined();
    expect(reads).toBe(2);
  });

  it('reads the delegate epoch from the escrow the quote request names, for its depositor and token', async () => {
    const quoteEscrow = contract(0xc2);
    const qr = { ...(await quoteRequest()), escrow_contract_address: quoteEscrow };
    expect(quoteEscrow).not.toBe(DEFAULTS.escrowContract);
    const seen: unknown[] = [];
    const { request } = await award(qr, {
      stellarDelegateEpoch: undefined,
      stellarRpcUrl: 'http://localhost:8000/rpc',
      stellarDelegateEpochReader: async (query) => {
        seen.push(query);
        return 9n;
      },
    });
    expect(JSON.parse(request.sender_auth!.signed_messages[0]!.message_prehash!).epoch).toBe('9');
    expect(seen).toEqual([
      {
        rpcUrl: 'http://localhost:8000/rpc',
        escrow: qr.escrow_contract_address,
        depositor: DEPOSITOR,
        token: TOKEN,
        timeoutMs: 5000,
      },
    ]);
  });

  it('lets the depositor sign the reserve when its own key is the quote_selector', async () => {
    const own = Address.account(keyOf(DELEGATE_SEED).publicKey).toString();
    const qr = await quoteRequest({ depositor: own, quoteSelector: undefined });
    const { request } = await award(qr, { selectorSigner: undefined });
    expect(JSON.parse(request.sender_auth!.signed_messages[0]!.message_prehash!).reserver).toBe(
      own,
    );
  });

  describe('checks the delegate record and the signers before anything is signed', () => {
    const readOf = (over: Record<string, unknown>) => ({
      stellarDelegateEpoch: undefined,
      stellarRpcUrl: 'http://localhost:8000/rpc',
      stellarDelegateRecordReader: async () => RECORD(7n, over),
    });

    it('refuses a record that expired at issued_at, a renounced or spent one, and another signer', async () => {
      const qr = await quoteRequest();
      const wrongSigner = account(0x11);
      const cases: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
        [{ expiration: BigInt(NOW) }, {}, /expired at/],
        [{ remainingCapacity: 0n }, {}, /no capacity left/],
        [{ remainingCapacity: BigInt(QUOTE_AMOUNT) - 1n }, {}, /quote amount exceeds/],
        [{ maxTransferSize: BigInt(QUOTE_AMOUNT) - 1n }, {}, /quote amount exceeds/],
        [
          { delegateSigner: wrongSigner },
          { stellarSigningKey: DEPOSITOR },
          /the escrow would refuse/,
        ],
      ];
      for (const [over, extra, message] of cases) {
        const signer = { sign: jest.fn() };
        await expect(
          award(qr, { depositorSigner: signer, ...readOf(over), ...extra }),
        ).rejects.toThrow(message);
        expect(signer.sign).not.toHaveBeenCalled();
      }
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it('builds from a live record, at the epoch it carries, and with the signing key it names', async () => {
      const qr = await quoteRequest();
      const limit = BigInt(QUOTE_AMOUNT);
      const { request } = await award(qr, {
        ...readOf({ remainingCapacity: limit, maxTransferSize: limit }),
      });
      expect(JSON.parse(request.sender_auth!.signed_messages[0]!.message_prehash!).epoch).toBe('7');
    });

    it('refuses an unregistered signing key reported by the signer without a key hint', async () => {
      const qr = await quoteRequest();
      await expect(award(qr, { ...readOf({ delegateSigner: account(0x11) }) })).rejects.toThrow(
        /did not return the registered Stellar delegate key/,
      );
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it('cannot check a record it did not read: a supplied epoch skips the checks', async () => {
      const qr = await quoteRequest();
      await expect(
        award(qr, { stellarDelegateEpoch: 3, stellarSigningKey: account(0x11) }),
      ).resolves.toBeDefined();
    });

    it('refuses a signer bound to another network, for the deposit and for the reserve', async () => {
      const qr = await quoteRequest();
      const pubnet = () => createSenderSigner('stellar:pubnet', { privateKey: DELEGATE_SEED });
      await expect(award(qr, { depositorSigner: pubnet() })).rejects.toThrow(
        /depositorSigner is for stellar:pubnet but the quote request's source is stellar:testnet/,
      );
      await expect(award(qr, { selectorSigner: pubnet() })).rejects.toThrow(
        /selectorSigner is for stellar:pubnet/,
      );
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it.each(['digest', 'escrow'] as const)(
      'refuses a mismatched deposit %s before invoking the signer',
      async (mismatch) => {
        const qr = await quoteRequest();
        const adapter = getChainAdapter('stellar:testnet');
        const build = adapter.buildAuthMessage.bind(adapter);
        const mock = jest
          .spyOn(adapter, 'buildAuthMessage')
          .mockImplementationOnce(async (input) => {
            if (mismatch === 'escrow') {
              const wrongEscrow = contract(0xc1);
              const requestBytes = input.paymentRequestJSON!;
              const requestJson =
                typeof requestBytes === 'string'
                  ? requestBytes
                  : Buffer.from(requestBytes).toString('utf8');
              return build({
                ...input,
                sourceDefaults: { ...input.sourceDefaults!, escrowContract: wrongEscrow },
                paymentRequestJSON: JSON.stringify({
                  ...JSON.parse(requestJson),
                  escrow_contract_address: wrongEscrow,
                }),
              });
            }
            return { ...(await build(input)), messageHash: '0x' + '99'.repeat(32) };
          });
        try {
          const sign = jest.fn();
          await expect(award(qr, { depositorSigner: { sign } })).rejects.toThrow(
            /message_prehash implies deposit digest/,
          );
          expect(sign).not.toHaveBeenCalled();
          expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
        } finally {
          mock.mockRestore();
        }
      },
    );

    it('admits a signer that reports no network, and hands it exactly the deposit digest', async () => {
      const qr = await quoteRequest();
      const inner = depositorSigner();
      const seen: string[] = [];
      const unbound = {
        sign: async (m: { message: string }) => {
          seen.push(m.message);
          return inner.sign(m as Parameters<typeof inner.sign>[0]);
        },
      };
      expect(unbound).not.toHaveProperty('network');
      const { request } = await award(qr, { depositorSigner: unbound });
      expect(seen).toEqual([request.sender_auth!.signed_messages[0]!.message]);
      const prehash = JSON.parse(request.sender_auth!.signed_messages[0]!.message_prehash!);
      expect(prehash.depositor).toBe(DEPOSITOR);
    });
  });

  it('a separately delegated payer is awarded and signed, and an offline verifier refuses it', async () => {
    const qr = await quoteRequest({ depositor: OTHER_PAYER });
    const { request } = await award(qr);
    // Built and signed: the deposit names the payer and the separate delegate key that signed it.
    expect(JSON.parse(request.sender_auth!.signed_messages[0]!.message_prehash!).depositor).toBe(
      OTHER_PAYER,
    );
    expect(request.sender_auth!.signed_messages[0]!.payload).toEqual({
      delegate_signer: DEPOSITOR,
    });
    // Not verifiable offline: the escrow's delegate record is on chain, so only a verifier that reads
    // it can admit this award.
    expect(() =>
      verifyPaymentRequestJSON(JSON.stringify({ ...qr, sender_auth: request.sender_auth }), {
        quoteSourceAmount: QUOTE_AMOUNT,
        escrowContract: DEFAULTS.escrowContract,
        reserver: SELECTOR,
        releaser: DEFAULTS.fulfillmentVerifierAccount,
        depositRequestHashV2Mode: 'enforce',
      }),
    ).toThrow(/delegate signer is not source\.account/);
  });

  it('signs the same award again for the same award key, and another for another', async () => {
    const qr = await quoteRequest();
    const first = await award(qr);
    const again = await award(qr);
    expect(again.request).toEqual(first.request);
    const other = await award(qr, { requestId: 'award-other' });
    expect(other.paymentId).not.toBe(first.paymentId);
  });

  describe('refuses before anything is sent', () => {
    const signNothing = () => ({ sign: jest.fn() });

    it.each<[string, (qr: CreateQuoteRequest) => Partial<AwardQuoteParams>, RegExp]>([
      [
        'a selector without its signer',
        () => ({ selectorSigner: undefined }),
        /pass its signer as selectorSigner/,
      ],
      [
        'a quote above the cap',
        (qr) => ({
          quote: quoteFor(qr, {
            quoteId: QUOTE_ID,
            sourceAmount: '100001',
            settlerAddress: SETTLER,
          }),
        }),
        /is above the request's max_source_amount/,
      ],
      [
        'a delegate epoch of zero',
        () => ({ stellarDelegateEpoch: 0 }),
        /must be an integer from 1 to 2\^64-1/,
      ],
      [
        'a payer with no delegate registered',
        () => ({
          stellarDelegateEpoch: undefined,
          stellarRpcUrl: 'http://localhost:8000/rpc',
          stellarDelegateEpochReader: async () => undefined,
        }),
        /no delegate registered/,
      ],
      [
        'a delegate read that fails',
        () => ({
          stellarDelegateEpoch: undefined,
          stellarRpcUrl: 'http://localhost:8000/rpc',
          stellarDelegateEpochReader: async () => {
            throw new Error('rpc down');
          },
        }),
        /rpc down/,
      ],
      [
        'a settler that is not an address',
        (qr) => ({
          quote: quoteFor(qr, {
            quoteId: QUOTE_ID,
            sourceAmount: QUOTE_AMOUNT,
            settlerAddress: 'nope',
          }),
        }),
        /reserve_auth: the settler is not a Stellar G\.\.\. or C\.\.\. address/,
      ],
      [
        'an all-zero quote id',
        (qr) => ({
          quote: quoteFor(qr, {
            quoteId: '0x' + '0'.repeat(64),
            sourceAmount: QUOTE_AMOUNT,
            settlerAddress: SETTLER,
          }),
        }),
        /reserve_auth: the quoteHash is not a non-zero/,
      ],
    ])('%s', async (_name, change, message) => {
      const qr = await quoteRequest();
      const depositor = signNothing();
      await expect(award(qr, { depositorSigner: depositor, ...change(qr) })).rejects.toThrow(
        message,
      );
      // Nothing is signed or sent: a refusal that came after the deposit signature would cost one.
      expect(depositor.sign).not.toHaveBeenCalled();
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it('a deposit that would outlast the escrow validity bound', async () => {
      const qr = await quoteRequest({ fulfillmentDeadlineSeconds: 90000 });
      const depositor = signNothing();
      await expect(award(qr, { depositorSigner: depositor })).rejects.toThrow(
        /exceeds the escrow's 86400s bound/,
      );
      expect(depositor.sign).not.toHaveBeenCalled();
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it('a reserve signed by a key that is not the quote_selector', async () => {
      const qr = await quoteRequest();
      await expect(award(qr, { selectorSigner: depositorSigner() })).rejects.toThrow(
        /was not signed by the quote_selector/,
      );
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it('the delegate key signing the reserve for a selector that is the depositor account', async () => {
      // A payer with a separate delegate (OTHER_PAYER; the shared DEPOSITOR is its own delegate, whose
      // key would match) names itself as the quote_selector, as prepareQuoteRequest does by default.
      // Its G account's key is not the delegate's, so the delegate key's reserve is refused here
      // instead of reverting on chain.
      const qr = await quoteRequest({ depositor: OTHER_PAYER, quoteSelector: OTHER_PAYER });
      await expect(award(qr, { selectorSigner: undefined })).rejects.toThrow(
        /was not signed by the quote_selector/,
      );
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it('a quote request that names no quote_selector', async () => {
      const { quote_selector: _unset, ...open } = await quoteRequest();
      await expect(award(open as CreateQuoteRequest)).rejects.toThrow(/names no quote_selector/);
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });

    it('a quote_selector that is a contract address', async () => {
      const qr = { ...(await quoteRequest()), quote_selector: contract(0x77) };
      await expect(award(qr as CreateQuoteRequest)).rejects.toThrow(
        /is not a Stellar G\.\.\. account/,
      );
    });
  });

  it('is no longer refused by readAwardInputs', () => {
    const qr = {
      source: {
        asset_identifier: `stellar:testnet/sep41:${TOKEN}`,
        account: DEPOSITOR,
      },
    } as unknown as CreateQuoteRequest;
    // It reads the quote like any other chain, so an empty one fails on its own contents.
    expect(() =>
      readAwardInputs({ quoteRequestId: 'qr', quoteRequest: qr, quote: {} as never, now: 0 }),
    ).toThrow(/quote_id is not a 0x-prefixed 32-byte hex value/);
  });
});
