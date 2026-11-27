import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { hashPermitWitnessTransferFrom } from '@atum-labs/evm-escrow-encoding';
import { evmAdapter } from './evm.js';
import type { ChainDefaults, SourceRef } from '../types.js';

import type { CommitmentExpectation } from '../commitment-rules.js';

/** The commitment this file's fixtures sign: their destination and request id. */
const COMMITMENT: CommitmentExpectation = {
  destinations: [
    {
      asset_identifier: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    },
  ],
  requestId: 'req_test',
};

// Every deployed escrow pins the four-member witness, so it is the only one built, and a deposit
// without the commitment is refused at verify.

const baseDefaults: ChainDefaults = {
  escrowContract: '0x1111111111111111111111111111111111111111',
  quoteSelector: '0x2222222222222222222222222222222222222222',
  fulfillmentVerifierAccount: '0x3333333333333333333333333333333333333333',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x4444444444444444444444444444444444444444',
};
const TOKEN = '0x5555555555555555555555555555555555555555';
const CANONICAL_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

async function buildWith(defaults: ChainDefaults, depositor: string) {
  return evmAdapter.buildAuthMessage({
    sourceAsset: `eip155:1/erc20:${TOKEN}`,
    depositor,
    maxSourceAmount: '1000000',
    requestId: 'req_test',
    destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
    sourceDefaults: defaults,
    nonce: 123n,
    deadline: 1924991999n,
  });
}

function witnessOf(messagePrehash: string) {
  return JSON.parse(messagePrehash).message.witness as Record<string, unknown>;
}

function witnessTypesOf(messagePrehash: string) {
  return JSON.parse(messagePrehash).types.DepositWitness as { name: string; type: string }[];
}

describe('evmAdapter witness', () => {
  it('signs the four-member witness', async () => {
    const built = await buildWith(baseDefaults, Wallet.createRandom().address);

    expect(witnessTypesOf(built.messagePrehash).map((t) => t.name)).toEqual([
      'depositRequestHash',
      'destination',
      'reserver',
      'releaser',
    ]);
    const witness = witnessOf(built.messagePrehash);
    expect(witness.depositRequestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(witness.destination).toBe(
      'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979',
    );
  });
});

describe('evmAdapter permit2 address', () => {
  it('uses the permit2 the gateway published for this chain', async () => {
    const custom = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const built = await buildWith(
      { ...baseDefaults, permit2Contract: custom },
      Wallet.createRandom().address,
    );

    // The builder normalises to an EIP-55 checksum, so compare case-insensitively — an EVM
    // address is the same address whatever its casing.
    expect(JSON.parse(built.messagePrehash).domain.verifyingContract.toLowerCase()).toBe(custom);
  });

  it('falls back to the canonical permit2 when the gateway published none', async () => {
    const built = await buildWith(baseDefaults, Wallet.createRandom().address);

    expect(JSON.parse(built.messagePrehash).domain.verifyingContract.toLowerCase()).toBe(
      CANONICAL_PERMIT2.toLowerCase(),
    );
  });
});

describe('evmAdapter verify', () => {
  async function roundTrip() {
    const wallet = Wallet.createRandom();
    const built = await buildWith(baseDefaults, wallet.address);
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
    return evmAdapter.recoverAndVerify(signed, source, COMMITMENT, {
      ...baseDefaults,
      maxSourceAmount: '1000000',
      reserver: baseDefaults.quoteSelector,
      releaser: baseDefaults.fulfillmentVerifierAccount,
    });
  }

  it('verifies a four-member deposit', async () => {
    const terms = await roundTrip();
    expect(terms.amount).toBe('1000000');
  });

  it('refuses a two-member deposit: it commits no destination', async () => {
    const wallet = Wallet.createRandom();
    // The two-member shape: a four-member prehash with both commitments taken out.
    const built = await buildWith(baseDefaults, wallet.address);
    const prehash = JSON.parse(built.messagePrehash);
    delete prehash.message.witness.depositRequestHash;
    delete prehash.message.witness.destination;
    prehash.types.DepositWitness = prehash.types.DepositWitness.filter(
      (member: { name: string }) => member.name === 'reserver' || member.name === 'releaser',
    );
    const signed = {
      message: hashPermitWitnessTransferFrom(prehash),
      message_prehash: JSON.stringify(prehash),
      signature: '',
    };
    signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
    expect(() =>
      evmAdapter.recoverAndVerify(signed, source, COMMITMENT, {
        ...baseDefaults,
        maxSourceAmount: '1000000',
      }),
    ).toThrow(/commits no destination/);
  });
});

describe('evmAdapter rejects a half-populated witness', () => {
  // Exactly one commitment present is not a shape the escrow pins, so it is refused rather than
  // guessing which half to trust.
  it('rejects a witness carrying destination but no depositRequestHash', async () => {
    const wallet = Wallet.createRandom();
    const built = await buildWith(baseDefaults, wallet.address);
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await evmAdapter.sign(signed, wallet.privateKey);

    const mutated = JSON.parse(signed.message_prehash);
    delete mutated.message.witness.depositRequestHash;
    signed.message_prehash = JSON.stringify(mutated);

    const source: SourceRef = { network: 'eip155:1', asset: TOKEN, account: wallet.address };
    expect(() =>
      evmAdapter.recoverAndVerify(signed, source, COMMITMENT, {
        ...baseDefaults,
        maxSourceAmount: '1000000',
      }),
    ).toThrow(/commits no depositRequestHash/);
  });
});

// Build and verify must use the same Permit2: it is the EIP-712 verifying contract.
describe('evmAdapter permit2 build/verify symmetry', () => {
  const custom = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const source = (depositor: string): SourceRef => ({
    network: 'eip155:1',
    asset: TOKEN,
    account: depositor,
  });
  const expectationsFor = (extra: Record<string, unknown> = {}) => ({
    maxSourceAmount: '1000000',
    escrowContract: baseDefaults.escrowContract,
    reserver: baseDefaults.quoteSelector,
    releaser: baseDefaults.fulfillmentVerifierAccount,
    nowSec: 1_700_000_000,
    ...extra,
  });

  async function signBuilt(
    wallet: ReturnType<typeof Wallet.createRandom>,
    defaults: ChainDefaults,
  ) {
    const built = await buildWith(defaults, wallet.address);
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await evmAdapter.sign(signed, wallet.privateKey);
    return signed;
  }

  it('round-trips a non-canonical permit2 when verify is told the same address', async () => {
    const wallet = Wallet.createRandom();
    const signed = await signBuilt(wallet, { ...baseDefaults, permit2Contract: custom });

    // recoverAndVerify throws on a signer mismatch, so returning terms at all is the assertion
    // that the rebuilt digest matched what was signed.
    const result = evmAdapter.recoverAndVerify(
      signed,
      source(wallet.address),
      COMMITMENT,
      expectationsFor({ permit2Contract: custom }),
    );

    expect(result.amount).toBe('1000000');
    expect(JSON.parse(signed.message_prehash).domain.verifyingContract.toLowerCase()).toBe(custom);
  });

  it('REJECTS when build used a non-canonical permit2 and verify was not told', async () => {
    // Verify rebuilds the digest over the canonical Permit2, which is not the digest that was signed.
    const wallet = Wallet.createRandom();
    const signed = await signBuilt(wallet, { ...baseDefaults, permit2Contract: custom });

    expect(() =>
      evmAdapter.recoverAndVerify(signed, source(wallet.address), COMMITMENT, expectationsFor()),
    ).toThrow(/is not the EIP-712 hash of message_prehash/);
  });

  it('still round-trips the canonical permit2 when neither side names one', async () => {
    // The over-rejection counterpart: the default path must be untouched.
    const wallet = Wallet.createRandom();
    const signed = await signBuilt(wallet, baseDefaults);

    const result = evmAdapter.recoverAndVerify(
      signed,
      source(wallet.address),
      COMMITMENT,
      expectationsFor(),
    );

    expect(result.amount).toBe('1000000');
    expect(JSON.parse(signed.message_prehash).domain.verifyingContract.toLowerCase()).toBe(
      CANONICAL_PERMIT2.toLowerCase(),
    );
  });
});
