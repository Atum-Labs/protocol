import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { evmAdapter } from './evm.js';
import { tronAdapter } from './tron.js';
import { solanaAdapter } from './solana.js';
import { stellarAdapter } from './stellar.js';
import { Address } from '@atum-labs/stellar-escrow-encoding';
import { CHAIN_ADAPTERS } from './index.js';
import { MalformedPrehashError, PermitAmountMismatchError } from '../errors.js';
import { buildEscrowDestination, deriveDepositRequestHash } from '../destination.js';
import { CommitmentError, commitmentResultOf } from '../commitment-rules.js';
import type { CommitmentExpectation, CommitmentOutcome } from '../commitment-rules.js';
import type { ChainAdapter, SignedMessageInput, SourceRef, VerifyExpectations } from '../types.js';

// recoverAndVerify requires the signed deposit to commit to the payment's own destination and
// request id, on every chain, after every other check. Mirrors commitment_binding_test.go.

const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

interface Fixture {
  adapter: ChainAdapter;
  signed: SignedMessageInput;
  source: SourceRef;
  expected: VerifyExpectations;
  commitment: CommitmentExpectation;
  otherAccount: string;
}

async function evmFixture(): Promise<Fixture> {
  const wallet = Wallet.createRandom();
  const defaults = {
    escrowContract: '0x1111111111111111111111111111111111111111',
    quoteSelector: '0x2222222222222222222222222222222222222222',
    fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: '0x4444444444444444444444444444444444444444',
  };
  const token = '0x5555555555555555555555555555555555555555';
  const commitment: CommitmentExpectation = {
    destinations: [
      {
        asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
      },
    ],
    requestId: 'req_binding_evm',
  };
  const built = await evmAdapter.buildAuthMessage({
    sourceAsset: `eip155:1/erc20:${token}`,
    depositor: wallet.address,
    maxSourceAmount: '1000000',
    requestId: commitment.requestId,
    destinationAsset: commitment.destinations[0]!.asset_identifier,
    destinationAccount: commitment.destinations[0]!.account,
    sourceDefaults: defaults,
    nonce: 123n,
    deadline: 1924991999n,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
  return {
    adapter: CHAIN_ADAPTERS['eip155']!,
    signed,
    commitment,
    source: { network: 'eip155:1', asset: token, account: wallet.address },
    expected: {
      ...defaults,
      maxSourceAmount: '1000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
    },
    otherAccount: '0x1111111111111111111111111111111111111111',
  };
}

async function tronFixture(): Promise<Fixture> {
  const wallet = Wallet.createRandom();
  const defaults = {
    escrowContract: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
    quoteSelector: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
    fulfillmentVerifierAccount: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
    fulfillmentVerifierEndpoint: 'https://verifier.example.com',
    fulfillmentProxy: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  };
  const token = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const commitment: CommitmentExpectation = {
    destinations: [
      {
        asset_identifier: 'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        account: 'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
      },
    ],
    requestId: 'req_binding_tron',
  };
  const built = await tronAdapter.buildAuthMessage({
    sourceAsset: `tron:mainnet/trc20:${token}`,
    depositor: 'unused',
    maxSourceAmount: '10000000',
    requestId: commitment.requestId,
    destinationAsset: commitment.destinations[0]!.asset_identifier,
    destinationAccount: commitment.destinations[0]!.account,
    sourceDefaults: defaults,
    nonce: 456n,
    deadline: 1924991999n,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
  };
  signed.signature = await tronAdapter.sign(signed, wallet.privateKey);
  return {
    adapter: CHAIN_ADAPTERS['tron']!,
    signed,
    commitment,
    source: { network: 'tron:mainnet', asset: token, account: wallet.address },
    expected: {
      ...defaults,
      maxSourceAmount: '10000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
    },
    otherAccount: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
  };
}

async function solanaFixture(): Promise<Fixture> {
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
  const payer = bs58.encode(keys.publicKey);
  const defaults = {
    escrowContract: b58(1),
    quoteSelector: b58(2),
    fulfillmentVerifierAccount: b58(3),
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: b58(4),
    svmSignatureClusterId: 'devnet',
    svmSignatureDomainVersion: 5,
  };
  const commitment: CommitmentExpectation = {
    destinations: [
      {
        asset_identifier:
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
        account: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
      },
    ],
    requestId: 'req_binding_sol',
  };
  const built = await solanaAdapter.buildAuthMessage({
    sourceAsset: `solana:mainnet/spl:${b58(9)}`,
    depositor: payer,
    maxSourceAmount: '1000000',
    requestId: commitment.requestId,
    destinationAsset: commitment.destinations[0]!.asset_identifier,
    destinationAccount: commitment.destinations[0]!.account,
    sourceDefaults: defaults,
    nonce: 5n,
    solanaClockReader: async () => 1700000000n,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
    payload: { delegate_signer: payer },
  };
  signed.signature = await solanaAdapter.sign(signed, bs58.encode(keys.secretKey));
  return {
    adapter: CHAIN_ADAPTERS['solana']!,
    signed,
    commitment,
    source: { network: 'solana:mainnet', asset: b58(9), account: payer },
    expected: {
      ...defaults,
      maxSourceAmount: '1000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
    },
    otherAccount: b58(7),
  };
}

async function stellarFixture(): Promise<Fixture> {
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(0x77));
  const account = (fill: number) => Address.account(new Uint8Array(32).fill(fill)).toString();
  const contract = (fill: number) => Address.contract(new Uint8Array(32).fill(fill)).toString();
  // The payer's own key is its delegate: the only shape an offline verifier admits.
  const depositor = Address.account(keys.publicKey).toString();
  const token = contract(0xe1);
  const defaults = {
    escrowContract: contract(0xc0),
    quoteSelector: account(0x55),
    fulfillmentVerifierAccount: account(0x66),
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: contract(0xf1),
  };
  const commitment: CommitmentExpectation = {
    destinations: [
      {
        asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
      },
    ],
    requestId: 'req_binding_stellar',
  };
  const built = await stellarAdapter.buildAuthMessage({
    sourceAsset: `stellar:testnet/sep41:${token}`,
    depositor,
    maxSourceAmount: '1000000',
    requestId: commitment.requestId,
    destinationAsset: commitment.destinations[0]!.asset_identifier,
    destinationAccount: commitment.destinations[0]!.account,
    sourceDefaults: defaults,
    nonce: 5n,
    issuedAt: 1700000000n,
    delegateEpoch: 1n,
    deadline: 1700000128n,
  });
  const signed: SignedMessageInput = {
    message: built.messageHash,
    message_prehash: built.messagePrehash,
    signature: '',
    payload: { delegate_signer: Address.account(keys.publicKey).toString() },
  };
  signed.signature = await stellarAdapter.sign(
    signed,
    Buffer.from(keys.secretKey.slice(0, 32)).toString('hex'),
  );
  return {
    adapter: CHAIN_ADAPTERS['stellar']!,
    signed,
    commitment,
    source: { network: 'stellar:testnet', asset: token, account: depositor },
    expected: {
      ...defaults,
      maxSourceAmount: '1000000',
      reserver: defaults.quoteSelector,
      releaser: defaults.fulfillmentVerifierAccount,
    },
    otherAccount: '0x1111111111111111111111111111111111111111',
  };
}

function outcomeOf(run: () => unknown): CommitmentOutcome {
  try {
    run();
  } catch (e) {
    if (e instanceof CommitmentError) return e.result.outcome;
    throw e;
  }
  throw new Error('expected a CommitmentError');
}

/** One fixture per registered adapter, keyed by namespace. */
const FIXTURES: Record<string, () => Promise<Fixture>> = {
  eip155: evmFixture,
  tron: tronFixture,
  solana: solanaFixture,
  stellar: stellarFixture,
};

// Every registered adapter must have a fixture, so an adapter that ignored the commitment could not
// pass unnoticed.
it('has a commitment fixture for every registered adapter', () => {
  expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(CHAIN_ADAPTERS).sort());
});

describe.each(Object.entries(FIXTURES))(
  'recoverAndVerify requires the commitment (%s)',
  (namespace, fixture) => {
    it("admits the payment's own commitment and reports it as signed", async () => {
      const f = await fixture();
      const r = f.adapter.recoverAndVerify(f.signed, f.source, f.commitment, f.expected);
      expect(r.commitment.outcome).toBe('verified');
      expect(r.commitment.namespace).toBe(namespace);
      const leg = f.commitment.destinations[0]!;
      expect(r.permit.destination).toBe(buildEscrowDestination(leg.asset_identifier, leg.account));
      expect(r.permit.depositRequestHash!.toLowerCase()).toBe(
        deriveDepositRequestHash(f.commitment.requestId).toLowerCase(),
      );
    });

    it('refuses another payee, another request id and a missing commitment', async () => {
      const f = await fixture();
      const leg = f.commitment.destinations[0]!;
      const verify = (c: CommitmentExpectation) => () =>
        f.adapter.recoverAndVerify(f.signed, f.source, c, f.expected);
      expect(
        outcomeOf(
          verify({
            destinations: [{ ...leg, account: f.otherAccount }],
            requestId: f.commitment.requestId,
          }),
        ),
      ).toBe('destination_mismatch');
      expect(
        outcomeOf(verify({ destinations: f.commitment.destinations, requestId: 'req_other' })),
      ).toBe('request_hash_mismatch');
      expect(outcomeOf(verify({ destinations: [], requestId: '' }))).toBe('destination_mismatch');
    });
  },
);

// A deposit that pays a chosen quote binds the permit to the quote's source_amount. Mirrors
// quote_amount_test.go.
describe.each(Object.entries(FIXTURES))(
  'recoverAndVerify quote source amount (%s)',
  (_ns, fixture) => {
    const inQuoteMode = (f: Fixture, quote: string): VerifyExpectations => ({
      ...f.expected,
      maxSourceAmount: '',
      quoteSourceAmount: quote,
    });

    // The refusals (above, below, misconfigured) are shared vectors in sender-auth-vectors.json.
    it('admits a permit for exactly the quote amount', async () => {
      const f = await fixture();
      const amount = f.expected.maxSourceAmount;
      const r = f.adapter.recoverAndVerify(
        f.signed,
        f.source,
        f.commitment,
        inQuoteMode(f, amount),
      );
      expect(r.amount).toBe(amount);
    });

    it('keeps the max_source_amount refusal text and types it', async () => {
      const f = await fixture();
      const run = () =>
        f.adapter.recoverAndVerify(f.signed, f.source, f.commitment, {
          ...f.expected,
          maxSourceAmount: '999',
        });
      expect(run).toThrow(PermitAmountMismatchError);
      expect(run).toThrow('sender_auth: permit amount does not match max_source_amount');
    });
  },
);

describe('recoverAndVerify commitment order and shape', () => {
  it('refuses a witness with no commitment as commitment_absent', async () => {
    const f = await evmFixture();
    const signed = {
      ...f.signed,
      message_prehash: f.signed.message_prehash!.replace('"destination":', '"retired":'),
    };
    expect(
      outcomeOf(() => f.adapter.recoverAndVerify(signed, f.source, f.commitment, f.expected)),
    ).toBe('commitment_absent');
  });

  it('checks the commitment last, so an earlier failure keeps its reason', async () => {
    const f = await evmFixture();
    expect(() =>
      f.adapter.recoverAndVerify(
        f.signed,
        f.source,
        { destinations: [], requestId: '' },
        { ...f.expected, maxSourceAmount: '1' },
      ),
    ).toThrow(/permit amount does not match/);
  });
});

describe('recoverAndVerify refuses a malformed signature and a non-string destination', () => {
  it.each([
    ['evm', evmFixture],
    ['tron', tronFixture],
  ] as const)('%s: a signature that is not 65 bytes recovers nothing', async (_name, fixture) => {
    const f = await fixture();
    expect(() =>
      f.adapter.recoverAndVerify(
        { ...f.signed, signature: '0x12' },
        f.source,
        f.commitment,
        f.expected,
      ),
    ).toThrow(/does not recover to the payment's source account/);
  });

  it('refuses a commitment whose account is not a string', async () => {
    const f = await evmFixture();
    const leg = f.commitment.destinations[0]!;
    const commitment = {
      destinations: [{ ...leg, account: [leg.account] as unknown as string }],
      requestId: f.commitment.requestId,
    };
    expect(
      outcomeOf(() => f.adapter.recoverAndVerify(f.signed, f.source, commitment, f.expected)),
    ).toBe('request_malformed');
  });
});

// An unusable prehash is reported both as MalformedPrehashError and with its commitment outcome, the
// same outcome verifyCommitment gives it. Mirrors TestRecoverAndVerifyReportsCommitmentOutcomes.
describe('recoverAndVerify reports commitment outcomes', () => {
  const failure = (run: () => unknown): unknown => {
    try {
      run();
    } catch (e) {
      return e;
    }
    throw new Error('expected a refusal');
  };

  it('reports a missing or unreadable prehash with its outcome', async () => {
    const f = await evmFixture();
    const missing = failure(() =>
      f.adapter.recoverAndVerify(
        { ...f.signed, message_prehash: undefined },
        f.source,
        f.commitment,
        f.expected,
      ),
    );
    expect(missing).toBeInstanceOf(MalformedPrehashError);
    expect(commitmentResultOf(missing)?.outcome).toBe('commitment_absent');
    const unreadable = failure(() =>
      f.adapter.recoverAndVerify(
        { ...f.signed, message_prehash: '{' },
        f.source,
        f.commitment,
        f.expected,
      ),
    );
    expect(unreadable).toBeInstanceOf(MalformedPrehashError);
    expect(commitmentResultOf(unreadable)?.outcome).toBe('prehash_mismatch');
  });

  it('reports a Solana domain below version 4 as commitment_absent', async () => {
    const f = await solanaFixture();
    const low = failure(() =>
      f.adapter.recoverAndVerify(f.signed, f.source, f.commitment, {
        ...f.expected,
        svmSignatureDomainVersion: 3,
      }),
    );
    expect(low).toBeInstanceOf(CommitmentError);
    expect(commitmentResultOf(low)?.outcome).toBe('commitment_absent');
  });
});
