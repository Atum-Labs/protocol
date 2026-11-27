import { describe, it, expect } from 'vitest';
import { SigningKey, Wallet, getBytes, sha256 } from 'ethers';
import bs58 from 'bs58';
import { hashTvmPermitWitnessTransferFrom } from '@atum-labs/tvm-escrow-encoding';
import { tronAdapter } from './tron.js';
import type { ChainDefaults, SourceRef } from '../types.js';

import type { CommitmentExpectation } from '../commitment-rules.js';

/** The commitment this file's fixtures sign: their destination and request id. */
const COMMITMENT: CommitmentExpectation = {
  destinations: [
    {
      asset_identifier: 'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      account: 'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
    },
  ],
  requestId: 'req_test',
};

/** Derive the base58 (base58check) Tron address for an EVM-form address (mirrors mppx test-helpers). */
function evmToTronAddress(evmAddress: string): string {
  const payload = new Uint8Array([0x41, ...getBytes(evmAddress)]);
  const checksum = getBytes(sha256(sha256(payload))).slice(0, 4);
  return bs58.encode(new Uint8Array([...payload, ...checksum]));
}

// Real base58 Tron addresses (from mppx tron fixtures). permit2Contract is intentionally
// unset so buildAuthMessage falls back to the pinned mainnet Permit2 — the same address
// recoverAndVerify rebuilds with via resolveTronPermit2 — so the digest matches.
const defaults: ChainDefaults = {
  escrowContract: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
  quoteSelector: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
  fulfillmentVerifierAccount: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
  fulfillmentVerifierEndpoint: 'https://verifier.example.com',
  fulfillmentProxy: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
};
const TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const expected = {
  ...defaults,
  maxSourceAmount: '10000000',
  reserver: defaults.quoteSelector,
  releaser: defaults.fulfillmentVerifierAccount,
};

// The one builder the positive and negative cases share. buildAuthMessage's params are a shared
// type, so every extra literal is another call site to update when a required param is added.
async function build(sourceAsset = `tron:mainnet/trc20:${TOKEN}`, sourceDefaults = defaults) {
  return tronAdapter.buildAuthMessage({
    sourceAsset,
    depositor: 'unused',
    maxSourceAmount: '10000000',
    requestId: 'req_test',
    destinationAsset: 'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    destinationAccount: 'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
    // The parameter, not the outer `defaults`, so a caller's own defaults are honoured.
    sourceDefaults,
    nonce: 123n,
    deadline: 1924991999n,
  });
}

async function buildWithNonce(nonce: bigint) {
  return tronAdapter.buildAuthMessage({
    sourceAsset: `tron:mainnet/trc20:${TOKEN}`,
    depositor: 'unused',
    maxSourceAmount: '10000000',
    requestId: 'req_test',
    destinationAsset: 'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    destinationAccount: 'TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
    sourceDefaults: defaults,
    nonce,
    deadline: 1924991999n,
  });
}

describe('tronAdapter typed-data signing', () => {
  it('is byte-identical to raw-signing the TIP-712 digest', async () => {
    // hashTvmPermitWitnessTransferFrom IS TypedDataEncoder.hash over the same prehash, so signing
    // the struct and signing the digest must agree exactly. Pins the signature a Tron escrow
    // recovers, so the typed-data path can never silently change it.
    const wallet = Wallet.createRandom();
    const built = await build();
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };

    const viaTypedData = await tronAdapter.sign(signed, wallet.privateKey);
    const viaRawDigest = new SigningKey(wallet.privateKey).sign(built.messageHash).serialized;

    expect(viaTypedData).toBe(viaRawDigest);
  });

  it('rejects a message without message_prehash', async () => {
    const wallet = Wallet.createRandom();
    const built = await build();
    await expect(
      tronAdapter.sign({ message: built.messageHash, signature: '' }, wallet.privateKey),
    ).rejects.toThrow(/message_prehash is required/);
  });

  it('refuses to sign a prehash that disagrees with the advertised digest', async () => {
    // Both fields are caller-supplied. Pairing one permit's digest with a different permit's
    // prehash would sign the second while every verifier reads the first.
    const wallet = Wallet.createRandom();
    const permitA = await build();
    const permitB = await buildWithNonce(456n);
    expect(permitA.messageHash).not.toBe(permitB.messageHash);

    await expect(
      tronAdapter.sign(
        { message: permitA.messageHash, message_prehash: permitB.messagePrehash, signature: '' },
        wallet.privateKey,
      ),
    ).rejects.toThrow(/implies digest/);
  });
});

describe('tronAdapter round-trip', () => {
  it('build → sign → recoverAndVerify recovers the signer and returns the terms', async () => {
    const wallet = Wallet.createRandom();
    const built = await build();
    expect(built.messageScheme).toBe('EVM_PERMIT2');
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await tronAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = {
      network: 'tron:mainnet',
      asset: TOKEN,
      account: evmToTronAddress(wallet.address),
    };
    const terms = tronAdapter.recoverAndVerify(signed, source, COMMITMENT, expected);
    expect(terms.amount).toBe('10000000');
    expect(typeof terms.deadlineSec).toBe('number');
  });

  it('rejects a signature from the wrong signer', async () => {
    const wallet = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const built = await build();
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await tronAdapter.sign(signed, attacker.privateKey);
    const source: SourceRef = {
      network: 'tron:mainnet',
      asset: TOKEN,
      account: evmToTronAddress(wallet.address),
    };
    expect(() => tronAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /does not recover to the payment's source account/,
    );
  });
});

describe('tronAdapter negative paths', () => {
  async function signed() {
    const wallet = Wallet.createRandom();
    const built = await build();
    const s = { message: built.messageHash, message_prehash: built.messagePrehash, signature: '' };
    s.signature = await tronAdapter.sign(s, wallet.privateKey);
    return {
      s,
      source: {
        network: 'tron:mainnet',
        asset: TOKEN,
        account: evmToTronAddress(wallet.address),
      } as SourceRef,
    };
  }

  it('rejects mismatched witness roles (Tron)', async () => {
    const { s, source } = await signed();
    expect(() =>
      tronAdapter.recoverAndVerify(s, source, COMMITMENT, {
        ...expected,
        reserver: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      }),
    ).toThrow(/witness roles do not match/);
  });

  it('rejects a wrong escrow (opt-in spender, Tron)', async () => {
    const { s, source } = await signed();
    expect(() =>
      tronAdapter.recoverAndVerify(s, source, COMMITMENT, {
        ...expected,
        escrowContract: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
      }),
    ).toThrow(/permit spender is not the source escrow/);
  });

  it('rejects a wrong amount (Tron)', async () => {
    const { s, source } = await signed();
    expect(() =>
      tronAdapter.recoverAndVerify(s, source, COMMITMENT, { ...expected, maxSourceAmount: '999' }),
    ).toThrow(/permit amount does not match max_source_amount/);
  });
  it('names a malformed source asset instead of failing inside the chain library', async () => {
    // Shared with the EVM and Solana adapters. The Go mirror reports the offending value here.
    await expect(build('tron:mainnet')).rejects.toThrow(/invalid source asset/);
  });
  it('refuses a non-tron source network even when permit2Contract is supplied', async () => {
    // With permit2Contract set, the namespace check alone stops a Tron TIP-712 domain being signed
    // for a network the identifier does not name. The Go mirror asserts the same case.
    await expect(
      build(`eip155:mainnet/trc20:${TOKEN}`, {
        ...defaults,
        permit2Contract: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
      }),
    ).rejects.toThrow(/expected a tron network/);
  });
});

// Tron builds only the four-member witness, as EVM does.
describe('tronAdapter witness', () => {
  function witnessTypesOf(messagePrehash: string) {
    return JSON.parse(messagePrehash).types.DepositWitness as { name: string; type: string }[];
  }

  it('signs the four-member witness', async () => {
    const built = await build(`tron:mainnet/trc20:${TOKEN}`, defaults);
    expect(witnessTypesOf(built.messagePrehash).map((t) => t.name)).toEqual([
      'depositRequestHash',
      'destination',
      'reserver',
      'releaser',
    ]);
  });

  it('refuses a two-member deposit: it commits no destination', async () => {
    const wallet = Wallet.createRandom();
    // The two-member shape: a four-member prehash with both commitments taken out.
    const built = await build();
    const prehash = JSON.parse(built.messagePrehash);
    delete prehash.message.witness.depositRequestHash;
    delete prehash.message.witness.destination;
    prehash.types.DepositWitness = prehash.types.DepositWitness.filter(
      (member: { name: string }) => member.name === 'reserver' || member.name === 'releaser',
    );
    const signed = {
      message: hashTvmPermitWitnessTransferFrom(prehash),
      message_prehash: JSON.stringify(prehash),
      signature: '',
    };
    signed.signature = await tronAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = {
      network: 'tron:mainnet',
      asset: TOKEN,
      account: evmToTronAddress(wallet.address),
    };

    expect(() => tronAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /commits no destination/,
    );
  });

  it('rejects a half-populated witness rather than guessing which half to trust', async () => {
    const wallet = Wallet.createRandom();
    const built = await build();
    const prehash = JSON.parse(built.messagePrehash);
    delete prehash.message.witness.destination; // one commitment present, the other not
    const signed = {
      message: built.messageHash,
      message_prehash: JSON.stringify(prehash),
      signature: '',
    };
    signed.signature = await tronAdapter.sign(
      { message: built.messageHash, message_prehash: built.messagePrehash, signature: '' },
      wallet.privateKey,
    );
    const source: SourceRef = {
      network: 'tron:mainnet',
      asset: TOKEN,
      account: evmToTronAddress(wallet.address),
    };

    expect(() => tronAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /commits no destination/,
    );
  });
});

// Build and verify must use the same Permit2: it is the TIP-712 verifying contract.
describe('tronAdapter permit2 build/verify symmetry', () => {
  // MUST differ from TRON_PERMIT2_FALLBACKS["tron:mainnet"], which is
  // TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m. Picking that value makes build and verify agree by
  // accident and the negative case below passes while asserting nothing.
  const custom = 'TSdZwNqpHofzP6BsBKGQUWdBeJphLmF6id';

  it('round-trips a non-canonical permit2 when verify is told the same address', async () => {
    const wallet = Wallet.createRandom();
    const built = await build(`tron:mainnet/trc20:${TOKEN}`, {
      ...defaults,
      permit2Contract: custom,
    });
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await tronAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = {
      network: 'tron:mainnet',
      asset: TOKEN,
      account: evmToTronAddress(wallet.address),
    };

    const terms = tronAdapter.recoverAndVerify(signed, source, COMMITMENT, {
      ...expected,
      permit2Contract: custom,
    });

    expect(terms.amount).toBe('10000000');
  });

  it('REJECTS when build used a non-canonical permit2 and verify was not told', async () => {
    const wallet = Wallet.createRandom();
    const built = await build(`tron:mainnet/trc20:${TOKEN}`, {
      ...defaults,
      permit2Contract: custom,
    });
    const signed = {
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    };
    signed.signature = await tronAdapter.sign(signed, wallet.privateKey);
    const source: SourceRef = {
      network: 'tron:mainnet',
      asset: TOKEN,
      account: evmToTronAddress(wallet.address),
    };

    expect(() => tronAdapter.recoverAndVerify(signed, source, COMMITMENT, expected)).toThrow(
      /is not the EIP-712 hash of message_prehash/,
    );
  });
});
