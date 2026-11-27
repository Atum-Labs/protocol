// awardQuote and prepareQuoteRequest's quote_selector, end to end against the contract-checked fake
// gateway, on every source chain family, with the real chain adapters and raw-key signers.
import bs58 from 'bs58';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';

import {
  deriveDepositRequestHash,
  verifyPaymentRequestJSON,
  verifyReserveAuth,
} from '@atum-labs/payment-request-sender-auth';
import { normalizeAddress } from '@atum-labs/tvm-escrow-encoding';
import { PaymentGatewayClient, createSenderSigner, getErrorResponse } from './index';
import type { AwardQuoteParams, AwardRequest, CreateQuoteRequest, SenderSigner } from './index';
import { readAwardInputs, signAward } from './award-quote';
import type { ChainDefaults } from './chain-adapters';
import { startFakeGateway, type FakeGateway, type Responder } from './test-support/fake-gateway';
import { quoteFor as settlerQuote, tronBase58 } from './test-support/quotes';

const depositorWallet = new ethers.Wallet(ethers.id('award-quote test depositor'));
const selectorWallet = new ethers.Wallet(ethers.id('award-quote test selector'));
const solanaDepositorSeed = ethers.id('award-quote test solana depositor').slice(2);
const solanaSelectorSeed = ethers.id('award-quote test solana selector').slice(2);
const solanaDepositor = nacl.sign.keyPair.fromSeed(Buffer.from(solanaDepositorSeed, 'hex'));
const solanaSelector = nacl.sign.keyPair.fromSeed(Buffer.from(solanaSelectorSeed, 'hex'));

const evmAccount = (byte: string) => '0x' + byte.repeat(20);
const solanaAccount = (byte: number) => bs58.encode(Buffer.alloc(32, byte));

interface Chain {
  name: 'eip155' | 'tron' | 'solana';
  chainId: string;
  sourceAsset: string;
  depositor: string;
  depositorKey: string;
  selector: string;
  selectorKey: string;
  /** The gateway's own selector, as /v1/defaults lists it. */
  gatewaySelector: string;
  settler: string;
  defaults: Record<string, unknown>;
}

const CHAINS: Chain[] = [
  {
    name: 'eip155',
    chainId: 'eip155:42161',
    sourceAsset: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    depositor: depositorWallet.address,
    depositorKey: depositorWallet.privateKey,
    selector: selectorWallet.address,
    selectorKey: selectorWallet.privateKey,
    gatewaySelector: evmAccount('3a'),
    settler: evmAccount('55'),
    defaults: {
      escrow_contract: evmAccount('11'),
      quote_selector: evmAccount('3a'),
      fulfillment_verifier: { account: evmAccount('44'), endpoint: 'https://verifier.example' },
      fulfillment_proxy: evmAccount('22'),
    },
  },
  {
    name: 'tron',
    chainId: 'tron:shasta',
    sourceAsset: 'tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
    depositor: tronBase58(depositorWallet.address),
    depositorKey: depositorWallet.privateKey,
    selector: tronBase58(selectorWallet.address),
    selectorKey: selectorWallet.privateKey,
    gatewaySelector: tronBase58(evmAccount('33')),
    settler: tronBase58(evmAccount('55')),
    defaults: {
      escrow_contract: tronBase58(evmAccount('11')),
      quote_selector: tronBase58(evmAccount('33')),
      fulfillment_verifier: {
        account: tronBase58(evmAccount('44')),
        endpoint: 'https://verifier.example',
      },
      fulfillment_proxy: tronBase58(evmAccount('22')),
    },
  },
  {
    name: 'solana',
    chainId: 'solana:devnet',
    sourceAsset: `solana:devnet/spl:${solanaAccount(0x66)}`,
    depositor: bs58.encode(solanaDepositor.publicKey),
    depositorKey: solanaDepositorSeed,
    selector: bs58.encode(solanaSelector.publicKey),
    selectorKey: solanaSelectorSeed,
    gatewaySelector: solanaAccount(0x33),
    settler: solanaAccount(0x55),
    defaults: {
      escrow_contract: solanaAccount(0x11),
      quote_selector: solanaAccount(0x33),
      fulfillment_verifier: { account: solanaAccount(0x44), endpoint: 'https://verifier.example' },
      fulfillment_proxy: solanaAccount(0x22),
      svm_signature_cluster_id: 'devnet',
      svm_signature_domain_version: 5,
    },
  },
];

const DESTINATION_ASSET = 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DESTINATION_ACCOUNT = evmAccount('77');
const CAP = '100000';
const QUOTE_AMOUNT = '99000';
const QUOTE_ID = '0x' + 'cd'.repeat(32);
const ISSUED_AT = BigInt(Math.floor(Date.now() / 1000));

function defaultsResponder(versions: number[]): Responder {
  return (req) => {
    const chainId = req.query.chain_id;
    const chain = CHAINS.find((c) => c.chainId === chainId);
    return {
      body: {
        chain_id: chainId,
        ...(chain?.defaults ?? CHAINS[0].defaults),
        deposit_request_hash_versions: versions,
      },
    };
  };
}

let gateway: FakeGateway;
let client: PaymentGatewayClient;

async function startGateway(
  responders: Record<string, Responder> = {},
  options: { allowInvalidResponses?: boolean; versions?: number[] } = {},
): Promise<void> {
  gateway = await startFakeGateway({
    responders: {
      'GET /v1/defaults': defaultsResponder(options.versions ?? [1, 2]),
      ...responders,
    },
    allowInvalidResponses: options.allowInvalidResponses,
  });
  client = new PaymentGatewayClient({ BASE: gateway.url });
}

afterEach(async () => {
  await gateway?.close();
});

function quoteRequestFor(chain: Chain, quoteSelector?: string): Promise<CreateQuoteRequest> {
  return client.prepareQuoteRequest({
    depositor: chain.depositor,
    fulfillmentAmount: '98000',
    sourceAsset: chain.sourceAsset,
    destinationAccount: DESTINATION_ACCOUNT,
    destinationAsset: DESTINATION_ASSET,
    maxSourceAmount: CAP,
    requestId: `qr-${chain.name}`,
    ...(quoteSelector !== undefined ? { quoteSelector } : {}),
  });
}

function quoteFor(
  chain: Chain,
  quoteRequest: CreateQuoteRequest,
  fields: Record<string, unknown> = {},
) {
  return settlerQuote(quoteRequest, {
    quoteId: QUOTE_ID,
    sourceAmount: QUOTE_AMOUNT,
    settlerAddress: chain.settler,
    fields,
  });
}

function signer(chain: Chain, key: string): SenderSigner {
  return createSenderSigner(chain.chainId, { privateKey: key });
}

function awardParams(
  chain: Chain,
  quoteRequest: CreateQuoteRequest,
  overrides: Partial<AwardQuoteParams> = {},
): AwardQuoteParams {
  return {
    requestId: `award-${chain.name}`,
    quoteRequestId: 'qr_test',
    quoteRequest,
    quote: quoteFor(chain, quoteRequest),
    depositorSigner: signer(chain, chain.depositorKey),
    // The reader is used only for a cluster with an RPC URL, and solana:devnet has no default one.
    solanaRpcUrl: 'http://solana-rpc.test',
    solanaClockReader: async () => ISSUED_AT,
    ...overrides,
  };
}

/** The award's sender_auth verified as the gateway verifies it: for the quote's amount. */
function verifyDeposit(
  chain: Chain,
  quoteRequest: CreateQuoteRequest,
  senderAuth: unknown,
  reserver: string,
) {
  return verifyPaymentRequestJSON(JSON.stringify({ ...quoteRequest, sender_auth: senderAuth }), {
    quoteSourceAmount: QUOTE_AMOUNT,
    escrowContract: quoteRequest.escrow_contract_address,
    reserver,
    releaser: quoteRequest.fulfillment_verifier.account,
    depositRequestHashV2Mode: 'enforce',
    ...(chain.name === 'solana'
      ? { svmSignatureClusterId: 'devnet', svmSignatureDomainVersion: 5 }
      : {}),
  });
}

function reserveExpectations(chain: Chain, quoteRequest: CreateQuoteRequest, depositId: string) {
  return {
    network: chain.chainId,
    escrowContract: quoteRequest.escrow_contract_address,
    depositId,
    quoteHash: QUOTE_ID,
    settler: chain.settler,
    sourceAmount: QUOTE_AMOUNT,
    ...(chain.name === 'solana'
      ? { svmSignatureClusterId: 'devnet', svmSignatureDomainVersion: 5 }
      : {}),
  };
}

describe('prepareQuoteRequest quote_selector', () => {
  beforeEach(() => startGateway());

  it.each(CHAINS)('$name: defaults to source.account', async (chain) => {
    const quoteRequest = await quoteRequestFor(chain);
    expect(quoteRequest.quote_selector).toBe(
      chain.name === 'tron' ? normalizeAddress(chain.depositor) : chain.depositor,
    );
  });

  it.each(CHAINS)('$name: sends a named selector, Tron in hex', async (chain) => {
    const quoteRequest = await quoteRequestFor(chain, chain.selector);
    expect(quoteRequest.quote_selector).toBe(
      chain.name === 'tron' ? normalizeAddress(chain.selector) : chain.selector,
    );
  });

  it.each(CHAINS)("$name: refuses the gateway's own selector", async (chain) => {
    const gatewaySelector =
      chain.name === 'eip155'
        ? chain.gatewaySelector.toUpperCase().replace('0X', '0x')
        : chain.gatewaySelector;
    await expect(quoteRequestFor(chain, gatewaySelector)).rejects.toThrow(
      "is the gateway's own selector",
    );
  });

  it('refuses a malformed selector before fetching defaults', async () => {
    await expect(quoteRequestFor(CHAINS[0], 'not-an-address')).rejects.toThrow();
    expect(gateway.received('GET', '/v1/defaults')).toHaveLength(0);
  });
});

describe('awardQuote', () => {
  describe.each(CHAINS)('$name', (chain) => {
    beforeEach(() => startGateway());

    it("signs the deposit for the quote's source_amount naming the selector, and the reserve over the derived payment id", async () => {
      const quoteRequest = await quoteRequestFor(chain);
      const { paymentId, request, response } = await client.awardQuote(
        awardParams(chain, quoteRequest),
      );

      const [posted] = gateway.received('POST', '/v1/payments/awards');
      expect(posted.violation).toBeUndefined();
      expect(posted.body).toEqual(request);
      expect(Object.keys(request).sort()).toEqual(
        ['quote_id', 'quote_request_id', 'request_id', 'reserve_auth', 'sender_auth'].sort(),
      );
      expect(request).toMatchObject({
        request_id: `award-${chain.name}`,
        quote_request_id: 'qr_test',
        quote_id: QUOTE_ID,
      });
      expect(response.payment_id).toBe('0xpayment');

      const deposit = verifyDeposit(
        chain,
        quoteRequest,
        request.sender_auth,
        quoteRequest.quote_selector!,
      );
      expect(deposit.results[0].permit.amount).toBe(QUOTE_AMOUNT);
      const signed = request.sender_auth!.signed_messages[0];
      if (chain.name === 'eip155') {
        const nonce = (JSON.parse(signed.message_prehash!) as { message: { nonce: string } })
          .message.nonce;
        expect(paymentId).toBe(
          ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ['address', 'bytes', 'uint256'],
              [chain.depositor, signed.signature, nonce],
            ),
          ),
        );
      }
      if (chain.name === 'solana') {
        expect(paymentId).toBe(signed.message.toLowerCase());
      }
      const reserve = await verifyReserveAuth(request.reserve_auth!, {
        ...reserveExpectations(chain, quoteRequest, paymentId),
        reserver: chain.depositor,
      });
      expect(reserve.reason).toBe('verified');
    });

    it('has a named selector sign the reserve and the depositor the deposit', async () => {
      const quoteRequest = await quoteRequestFor(chain, chain.selector);
      const { paymentId, request } = await client.awardQuote(
        awardParams(chain, quoteRequest, { selectorSigner: signer(chain, chain.selectorKey) }),
      );

      const deposit = verifyDeposit(
        chain,
        quoteRequest,
        request.sender_auth,
        quoteRequest.quote_selector!,
      );
      const canonical = (a: string) =>
        chain.name === 'tron' ? normalizeAddress(a) : a.toLowerCase();
      expect(canonical(deposit.recoveredAccount)).toBe(canonical(chain.depositor));
      const expectations = reserveExpectations(chain, quoteRequest, paymentId);
      const bySelector = await verifyReserveAuth(request.reserve_auth!, {
        ...expectations,
        reserver: chain.selector,
      });
      expect(bySelector.reason).toBe('verified');
      const byDepositor = await verifyReserveAuth(request.reserve_auth!, {
        ...expectations,
        reserver: chain.depositor,
      });
      expect(byDepositor.reason).not.toBe('verified');
    });

    it.each([
      ['absent', null],
      ['empty', ''],
      ['blank', '  '],
    ])(
      'refuses a quote request whose quote_selector is %s, before signing or posting',
      async (_label, value) => {
        const { quote_selector: _named, ...rest } = await quoteRequestFor(chain);
        const quoteRequest = (
          value === null ? rest : { ...rest, quote_selector: value }
        ) as CreateQuoteRequest;
        const sign = jest.fn();
        await expect(
          client.awardQuote(awardParams(chain, quoteRequest, { depositorSigner: { sign } })),
        ).rejects.toThrow('the quote request names no quote_selector');
        expect(sign).not.toHaveBeenCalled();
        expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
      },
    );

    it('refuses a named selector without its signer, before signing', async () => {
      const quoteRequest = await quoteRequestFor(chain, chain.selector);
      const sign = jest.fn();
      await expect(
        client.awardQuote(awardParams(chain, quoteRequest, { depositorSigner: { sign } })),
      ).rejects.toThrow('pass its signer as selectorSigner');
      expect(sign).not.toHaveBeenCalled();
    });
  });

  describe.each(CHAINS.filter((chain) => chain.name !== 'solana'))('$name retry', (chain) => {
    beforeEach(() => startGateway());

    it('signs the same deposit and payment id for the same award key', async () => {
      const quoteRequest = await quoteRequestFor(chain);
      const first = await client.awardQuote(awardParams(chain, quoteRequest));
      const again = await client.awardQuote(awardParams(chain, quoteRequest));
      expect(again.request).toEqual(first.request);
      expect(again.paymentId).toBe(first.paymentId);

      const other = await client.awardQuote(
        awardParams(chain, quoteRequest, { requestId: 'award-other' }),
      );
      expect(other.paymentId).not.toBe(first.paymentId);
    });
  });

  describe('solana retry', () => {
    const chain = CHAINS.find((c) => c.name === 'solana')!;
    beforeEach(() => startGateway());

    it('keeps the nonce and request id but signs a new deposit at a later issued_at', async () => {
      const quoteRequest = await quoteRequestFor(chain);
      const deposit = (request: AwardRequest) =>
        JSON.parse(request.sender_auth!.signed_messages[0].message_prehash!) as {
          nonce: string;
          issued_at: string;
        };
      const first = await client.awardQuote(awardParams(chain, quoteRequest));
      const later = await client.awardQuote(
        awardParams(chain, quoteRequest, { solanaClockReader: async () => ISSUED_AT + 5n }),
      );

      expect(deposit(later.request).nonce).toBe(deposit(first.request).nonce);
      expect(
        BigInt(deposit(later.request).issued_at) - BigInt(deposit(first.request).issued_at),
      ).toBe(5n);
      expect(later.paymentId).not.toBe(first.paymentId);
      expect(later.request.request_id).toBe(first.request.request_id);
    });
  });

  describe('refusals before signing', () => {
    const chain = CHAINS[0];
    beforeEach(() => startGateway());

    it.each<[string, (q: CreateQuoteRequest) => Partial<AwardQuoteParams>, string | RegExp]>([
      [
        'a quote for another quote request',
        (q) => ({
          quote: quoteFor(chain, q, {
            payment_request_json: JSON.stringify({ ...q, fulfillment_amount: '1' }),
          }),
        }),
        'the quote is not for this quote request',
      ],
      [
        'a quote naming another source account',
        (q) => ({
          quote: quoteFor(chain, q, {
            source: { id: q.source.asset_identifier, account: evmAccount('99') },
          }),
        }),
        "the quote's source.account is not the quote request's",
      ],
      [
        'a quote past its award_deadline',
        (q) => ({
          quote: quoteFor(chain, q, { award_deadline: new Date(Date.now() - 1000).toISOString() }),
        }),
        'has passed',
      ],
      [
        'a quote above the cap',
        (q) => ({ quote: quoteFor(chain, q, { source_amount: '100001' }) }),
        "is above the request's max_source_amount",
      ],
      [
        'a malformed quote_id',
        (q) => ({ quote: { ...quoteFor(chain, q), quote_id: '0x1234' } }),
        'quote_id is not a 0x-prefixed 32-byte hex value',
      ],
      [
        'an award request_id outside the pattern',
        () => ({ requestId: 'award#1' }),
        'does not match',
      ],
      ['an empty award request_id', () => ({ requestId: '' }), 'requestId is required'],
      ['an empty quoteRequestId', () => ({ quoteRequestId: '' }), 'quoteRequestId is required'],
      [
        'a quote with no fulfillment_quote',
        () => ({ quote: { quote_id: QUOTE_ID, fulfillment_quote: null as never } }),
        'the quote has no fulfillment_quote object',
      ],
      [
        'an award_deadline that is not a timestamp',
        (q) => ({ quote: quoteFor(chain, q, { award_deadline: 'soon' }) }),
        "the quote's award_deadline is not a timestamp",
      ],
      ...['', '0', '0x10', ' 5', '1e6'].map(
        (amount): [string, (q: CreateQuoteRequest) => Partial<AwardQuoteParams>, string] => [
          `a source_amount of ${JSON.stringify(amount)}`,
          (q) => ({ quote: quoteFor(chain, q, { source_amount: amount }) }),
          "the quote's source_amount is not a decimal integer above zero",
        ],
      ),
      [
        'a quote with no settler_address',
        (q) => ({ quote: quoteFor(chain, q, { settler_address: '' }) }),
        'the quote has no settler_address',
      ],
      [
        'a settler_address that is not an address on the source chain',
        (q) => ({ quote: quoteFor(chain, q, { settler_address: '0x1234' }) }),
        'reserve_auth: the settler is not a non-zero address on this chain',
      ],
      [
        'a fulfillment_deadline that is not a timestamp',
        (q) => {
          const quoteRequest = { ...q, fulfillment_deadline: '2026-13-45T25:61:00Z' };
          return { quoteRequest, quote: quoteFor(chain, quoteRequest) };
        },
        'fulfillment_deadline is not a valid date and time',
      ],
    ])('%s', async (_label, override, message) => {
      const quoteRequest = await quoteRequestFor(chain);
      const sign = jest.fn();
      await expect(
        client.awardQuote({
          ...awardParams(chain, quoteRequest, { depositorSigner: { sign } }),
          ...override(quoteRequest),
        }),
      ).rejects.toThrow(message);
      expect(sign).not.toHaveBeenCalled();
      expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(0);
    });
  });

  it("signs a permit for the quote's amount when the quote request sets no cap", async () => {
    const chain = CHAINS[0];
    await startGateway();
    const quoteRequest = await client.prepareQuoteRequest({
      depositor: chain.depositor,
      fulfillmentAmount: '98000',
      sourceAsset: chain.sourceAsset,
      destinationAccount: DESTINATION_ACCOUNT,
      destinationAsset: DESTINATION_ASSET,
      requestId: 'qr-no-cap',
    });
    expect(quoteRequest.max_source_amount).toBeUndefined();

    const { request } = await client.awardQuote(awardParams(chain, quoteRequest));

    const deposit = verifyDeposit(chain, quoteRequest, request.sender_auth, chain.depositor);
    expect(deposit.results[0].permit.amount).toBe(QUOTE_AMOUNT);
  });

  it('re-sends an awarded quote after its award_deadline, for the gateway to replay', async () => {
    const chain = CHAINS[0];
    await startGateway();
    const quoteRequest = await quoteRequestFor(chain);
    const listed = {
      ...quoteFor(chain, quoteRequest, {
        award_deadline: new Date(Date.now() - 60_000).toISOString(),
      }),
      awarded_payment_id: '0x' + '77'.repeat(32),
    };

    const { request } = await client.awardQuote(
      awardParams(chain, quoteRequest, { quote: listed }),
    );

    expect(request.quote_id).toBe(QUOTE_ID);
    expect(gateway.received('POST', '/v1/payments/awards')).toHaveLength(1);
  });

  // Guards of signAward that awardQuote's own checks reach first.
  it.each<[string, number, (q: CreateQuoteRequest) => CreateQuoteRequest, string]>([
    ['a Solana deposit whose issued_at was not resolved', 2, (q) => q, 'issued_at resolved'],
    [
      'a fulfillment_deadline that is not a timestamp',
      0,
      (q) => ({ ...q, fulfillment_deadline: 'soon' }),
      "the quote request's fulfillment_deadline is not a timestamp",
    ],
  ])('signAward refuses %s, before signing', async (_label, chainIndex, change, message) => {
    const chain = CHAINS[chainIndex];
    await startGateway();
    const quoteRequest = await quoteRequestFor(chain);
    const sign = jest.fn();
    const params = awardParams(chain, quoteRequest, { depositorSigner: { sign } });

    await expect(
      signAward({
        ...params,
        quoteRequest: change(quoteRequest),
        inputs: readAwardInputs({ ...params, now: Date.now() }),
        chainDefaults: {} as ChainDefaults,
        depositRequestHashVersion: 2,
      }),
    ).rejects.toThrow(message);
    expect(sign).not.toHaveBeenCalled();
  });

  it('commits the quote request body with depositRequestHash v2 when the gateway lists it', async () => {
    const chain = CHAINS[0];
    await startGateway({}, { versions: [1, 2] });
    const quoteRequest = await quoteRequestFor(chain);
    const { request } = await client.awardQuote(awardParams(chain, quoteRequest));

    expect(() =>
      verifyDeposit(
        chain,
        { ...quoteRequest, fulfillment_amount: '97000' },
        request.sender_auth,
        quoteRequest.quote_selector!,
      ),
    ).toThrow('request_hash_mismatch');
  });

  it('signs v1 when the gateway lists only v1', async () => {
    const chain = CHAINS[0];
    await startGateway({}, { versions: [1] });
    const quoteRequest = await quoteRequestFor(chain);
    const { request } = await client.awardQuote(awardParams(chain, quoteRequest));

    const deposit = verifyDeposit(
      chain,
      quoteRequest,
      request.sender_auth,
      quoteRequest.quote_selector!,
    );
    expect(deposit.results[0].permit.amount).toBe(QUOTE_AMOUNT);
    const prehash = JSON.parse(request.sender_auth!.signed_messages[0].message_prehash!);
    expect(prehash.message.witness.depositRequestHash).toBe(
      deriveDepositRequestHash(quoteRequest.request_id),
    );
  });

  it('sends wait=true and surfaces idempotent_replay', async () => {
    const chain = CHAINS[0];
    await startGateway({
      'POST /v1/payments/awards': () => ({
        body: { payment_id: '0xpayment', status: 'completed', idempotent_replay: true },
      }),
    });
    const quoteRequest = await quoteRequestFor(chain);
    const { response } = await client.awardQuote(awardParams(chain, quoteRequest, { wait: true }));

    expect(gateway.received('POST', '/v1/payments/awards')[0].query.wait).toBe('true');
    expect(response.idempotent_replay).toBe(true);
  });

  it("hands a refusal to the caller as an ApiError with the gateway's code", async () => {
    const chain = CHAINS[0];
    await startGateway(
      {
        'POST /v1/payments/awards': () => ({
          status: 409,
          body: {
            code: 'QUOTE_REQUEST_ALREADY_AWARDED',
            message: 'a quote of this quote request has already been awarded',
          },
        }),
      },
      { allowInvalidResponses: true },
    );
    const quoteRequest = await quoteRequestFor(chain);
    const error = await client
      .awardQuote(awardParams(chain, quoteRequest))
      .catch((e: unknown) => e);

    expect(getErrorResponse(error)?.code).toBe('QUOTE_REQUEST_ALREADY_AWARDED');
  });
});
