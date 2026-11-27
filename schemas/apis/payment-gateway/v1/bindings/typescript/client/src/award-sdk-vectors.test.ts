// The awards this SDK builds, frozen in PaymentRequest/v1/conformance/award-sdk-vectors.json for
// the verifier suites (Go and TypeScript) and the escrow tests to check. This suite fails when the
// SDK builds anything else; REGEN_VECTORS=1 rewrites the file.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';

import { verifyReserveAuth } from '@atum-labs/payment-request-sender-auth';
import type { ReserveAuthExpectations } from '@atum-labs/payment-request-sender-auth';
import { PaymentGatewayClient, createSenderSigner } from './index';
import type { AwardedQuote, CreateQuoteRequest, ReserveAuth, SenderSigner } from './index';
import { signReserveAuth } from './reserve-auth';
import { startFakeGateway, type FakeGateway } from './test-support/fake-gateway';
import { TEST_SETTLER, signedQuoteFor, tronBase58 } from './test-support/quotes';

const VECTORS_PATH = resolve(
  __dirname,
  '../../../../../../../declarations/PaymentRequest/v1/conformance/award-sdk-vectors.json',
);

// Every clock the award reads: deadlines, award_deadline, the quote proof's created, issued_at.
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const ERC1271_MAGIC = '0x1626ba7e' + '0'.repeat(56);

const evmAccount = (byte: string) => '0x' + byte.repeat(20);
const solanaAccount = (byte: number) => bs58.encode(Buffer.alloc(32, byte));
const seedOf = (label: string) => ethers.id(label).slice(2);
const solanaKey = (label: string) =>
  bs58.encode(nacl.sign.keyPair.fromSeed(Buffer.from(seedOf(label), 'hex')).publicKey);

const depositor = new ethers.Wallet(ethers.id('award-sdk depositor'));
const selector = new ethers.Wallet(ethers.id('award-sdk selector'));
const walletOwner = new ethers.Wallet(ethers.id('award-sdk contract reserver owner'));
const CONTRACT_RESERVER = '0x5afe00000000000000000000000000000000c0de';

interface Chain {
  namespace: 'eip155' | 'tron' | 'solana';
  chainId: string;
  sourceAsset: string;
  depositor: string;
  depositorKey: string;
  selector: string;
  selectorKey: string;
  settler: string;
  otherSettler: string;
  defaults: Record<string, unknown>;
}

const CHAINS: Chain[] = [
  {
    namespace: 'eip155',
    chainId: 'eip155:1',
    sourceAsset: 'eip155:1/erc20:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    depositor: depositor.address,
    depositorKey: depositor.privateKey,
    selector: selector.address,
    selectorKey: selector.privateKey,
    settler: TEST_SETTLER.address,
    otherSettler: evmAccount('56'),
    defaults: {
      escrow_contract: evmAccount('e5'),
      quote_selector: evmAccount('3a'),
      fulfillment_verifier: { account: evmAccount('44'), endpoint: 'https://verifier.example' },
      fulfillment_proxy: evmAccount('22'),
    },
  },
  {
    namespace: 'tron',
    chainId: 'tron:mainnet',
    sourceAsset: 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    depositor: tronBase58(depositor.address),
    depositorKey: depositor.privateKey,
    selector: tronBase58(selector.address),
    selectorKey: selector.privateKey,
    settler: tronBase58(TEST_SETTLER.address),
    otherSettler: tronBase58(evmAccount('56')),
    defaults: {
      escrow_contract: tronBase58(evmAccount('e5')),
      quote_selector: tronBase58(evmAccount('3a')),
      fulfillment_verifier: {
        account: tronBase58(evmAccount('44')),
        endpoint: 'https://verifier.example',
      },
      fulfillment_proxy: tronBase58(evmAccount('22')),
    },
  },
  {
    namespace: 'solana',
    chainId: 'solana:devnet',
    sourceAsset: `solana:devnet/spl:${solanaAccount(0x66)}`,
    depositor: solanaKey('award-sdk solana depositor'),
    depositorKey: seedOf('award-sdk solana depositor'),
    selector: solanaKey('award-sdk solana selector'),
    selectorKey: seedOf('award-sdk solana selector'),
    settler: solanaKey('award-sdk solana settler'),
    otherSettler: solanaAccount(0x56),
    defaults: {
      escrow_contract: solanaAccount(0xe5),
      quote_selector: solanaAccount(0x3a),
      fulfillment_verifier: { account: solanaAccount(0x44), endpoint: 'https://verifier.example' },
      fulfillment_proxy: solanaAccount(0x22),
      svm_signature_cluster_id: 'devnet',
      svm_signature_domain_version: 5,
    },
  },
];

type Route = 'depositor' | 'selector' | 'contract-selector';

interface Tampered {
  field: 'settler' | 'sourceAmount';
  reserve_auth: ReserveAuth;
  reason: string;
}

interface AwardVector {
  name: string;
  route: Route;
  /** The source chain's /v1/defaults the SDK read. */
  defaults: Record<string, unknown>;
  depositRequestHashVersion: 2;
  quoteRequestId: string;
  quoteRequest: CreateQuoteRequest;
  quote: AwardedQuote;
  award: unknown;
  paymentId: string;
  reserve: { expected: ReserveAuthExpectations; message: string; message_prehash?: string };
  tampered: Tampered[];
  /** On the contract-selector route: the key that signs for the ERC-1271 reserver. */
  contractReserverOwner?: string;
}

interface AwardVectors {
  _comment: string;
  vectors: AwardVector[];
}

const COMMENT =
  'Awards built by payment-gateway-client awardQuote, one per source chain family and reserve ' +
  "route: the quote request, the settler's signed quote, the award body, the payment id the SDK " +
  'derives, and the reserve witness a verifier expects. Each tampered entry is a reserve the SDK ' +
  'builds for another settler or for one unit less, with the reason the verifier refuses it. Read ' +
  'by the sender-auth Go and TypeScript suites and the EVM escrow test. Regenerate: ' +
  'REGEN_VECTORS=1 pnpm --filter @atum-labs/payment-gateway-client exec jest ' +
  'src/award-sdk-vectors.test.ts';

const QUOTE_AMOUNT = '99000000';

function contractChecker(owner: string) {
  return {
    async hasCode() {
      return true;
    },
    async isValidSignatureFrom(_n: string, _a: string, digest: string, signature: string) {
      const signer = ethers.recoverAddress(digest, signature);
      return {
        reverted: false,
        returnData: signer.toLowerCase() === owner.toLowerCase() ? ERC1271_MAGIC : '0x',
      };
    },
  };
}

async function buildVector(gateway: FakeGateway, chain: Chain, route: Route): Promise<AwardVector> {
  const client = new PaymentGatewayClient({ BASE: gateway.url });
  const name = `${chain.namespace}-${route}`;
  const reserver =
    route === 'depositor'
      ? chain.depositor
      : route === 'selector'
        ? chain.selector
        : CONTRACT_RESERVER;
  const quoteRequest = await client.prepareQuoteRequest({
    depositor: chain.depositor,
    fulfillmentAmount: '98000000',
    sourceAsset: chain.sourceAsset,
    destinationAccount: evmAccount('77'),
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    maxSourceAmount: '100000000',
    requestId: `qr-sdk-${name}`,
    ...(route === 'depositor' ? {} : { quoteSelector: reserver }),
  });
  const quote = await signedQuoteFor(quoteRequest, {
    sourceAmount: QUOTE_AMOUNT,
    settlerAddress: chain.settler,
  });
  const reserveSigner: SenderSigner = createSenderSigner(chain.chainId, {
    privateKey:
      route === 'depositor'
        ? chain.depositorKey
        : route === 'selector'
          ? chain.selectorKey
          : walletOwner.privateKey,
  });
  const quoteRequestId = `qr_sdk_${name.replace(/-/g, '_')}`;
  const { request, paymentId } = await client.awardQuote({
    requestId: `award-sdk-${name}`,
    quoteRequestId,
    quoteRequest,
    quote,
    depositorSigner: createSenderSigner(chain.chainId, { privateKey: chain.depositorKey }),
    ...(route === 'depositor' ? {} : { selectorSigner: reserveSigner }),
    solanaRpcUrl: 'http://solana-rpc.test',
    solanaClockReader: async () => BigInt(NOW / 1000),
  });

  const solana = chain.namespace === 'solana';
  const svm = solana ? { svmSignatureClusterId: 'devnet', svmSignatureDomainVersion: 5 } : {};
  const fq = quote.fulfillment_quote as { settler_address: string; source_amount: string };
  const expected: ReserveAuthExpectations = {
    network: chain.chainId,
    escrowContract: quoteRequest.escrow_contract_address,
    depositId: paymentId,
    quoteHash: quote.quote_id,
    settler: fq.settler_address,
    sourceAmount: fq.source_amount,
    reserver,
    ...svm,
  };
  const checker = route === 'contract-selector' ? contractChecker(walletOwner.address) : undefined;
  const verdict = await verifyReserveAuth(request.reserve_auth!, expected, checker);
  if (verdict.reason !== 'verified') {
    throw new Error(`${name}: the SDK's own reserve does not verify: ${verdict.detail}`);
  }

  const { reserver: _reserver, ...input } = expected;
  const tampered: Tampered[] = [];
  for (const [field, change] of [
    ['settler', { settler: chain.otherSettler }],
    ['sourceAmount', { sourceAmount: (BigInt(fq.source_amount) - 1n).toString() }],
  ] as const) {
    const auth = await signReserveAuth({ ...input, ...change }, reserveSigner);
    const refused = await verifyReserveAuth(auth, expected, checker);
    if (refused.valid) throw new Error(`${name}: a reserve for another ${field} verifies`);
    tampered.push({ field, reserve_auth: auth, reason: refused.reason });
  }

  const reserveAuth = request.reserve_auth!;
  return {
    name,
    route,
    defaults: { chain_id: chain.chainId, ...chain.defaults, deposit_request_hash_versions: [1, 2] },
    depositRequestHashVersion: 2,
    quoteRequestId,
    quoteRequest,
    quote,
    award: request,
    paymentId,
    reserve: {
      expected,
      message: reserveAuth.message,
      ...(reserveAuth.message_prehash !== undefined
        ? { message_prehash: reserveAuth.message_prehash }
        : {}),
    },
    tampered,
    ...(route === 'contract-selector' ? { contractReserverOwner: walletOwner.address } : {}),
  };
}

async function buildVectors(): Promise<AwardVectors> {
  const gateway = await startFakeGateway({
    responders: {
      'GET /v1/defaults': (req) => {
        const chain = CHAINS.find((c) => c.chainId === req.query.chain_id);
        return {
          body: {
            chain_id: req.query.chain_id,
            ...(chain ?? CHAINS[0]).defaults,
            deposit_request_hash_versions: [1, 2],
          },
        };
      },
    },
  });
  try {
    const vectors: AwardVector[] = [];
    for (const chain of CHAINS) {
      vectors.push(await buildVector(gateway, chain, 'depositor'));
      vectors.push(await buildVector(gateway, chain, 'selector'));
      if (chain.namespace === 'eip155') {
        vectors.push(await buildVector(gateway, chain, 'contract-selector'));
      }
    }
    // Through JSON, so absent members compare as the file holds them.
    return JSON.parse(JSON.stringify({ _comment: COMMENT, vectors })) as AwardVectors;
  } finally {
    await gateway.close();
  }
}

describe('award SDK vectors', () => {
  let built: AwardVectors;

  beforeAll(async () => {
    // Only Date is faked: the fake gateway still needs real timers and I/O.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    built = await buildVectors();
    if (process.env.REGEN_VECTORS === '1') {
      writeFileSync(VECTORS_PATH, JSON.stringify(built, null, 2) + '\n');
    }
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('the committed file is what awardQuote builds today', () => {
    const committed = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as AwardVectors;
    expect(committed).toEqual(built);
  });

  it('rows cover each chain with both routes and an EVM contract reserver', () => {
    expect(built.vectors.map((v) => v.name)).toEqual([
      'eip155-depositor',
      'eip155-selector',
      'eip155-contract-selector',
      'tron-depositor',
      'tron-selector',
      'solana-depositor',
      'solana-selector',
    ]);
    for (const v of built.vectors) {
      expect(v.tampered.map((t) => t.field)).toEqual(['settler', 'sourceAmount']);
      expect(v.tampered.map((t) => t.reason)).toEqual([
        'settler_mismatch',
        'source_amount_mismatch',
      ]);
    }
  });
});
