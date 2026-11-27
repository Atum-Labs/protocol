import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, toUtf8Bytes, Wallet } from 'ethers';
import nacl from 'tweetnacl';
import { Address, Pubkey } from '@atum-labs/stellar-escrow-encoding';
// From the package entry point, so these tests also hold the export in place.
import { buildReserveMessage, localKeySigner, verifyReserveAuth } from './index.js';
import type { ReserveAuthReason, ReserveMessageInput } from './index.js';

// The reserve the Foundry test runs through the real escrow (Escrow.directDepositVectors.t.sol).
const DIRECT_DEPOSIT = resolve(
  __dirname,
  '../../../../../../../../contracts/evm/conformance/direct-deposit-vectors.json',
);
const RESERVE_VECTORS = resolve(__dirname, '../../../../conformance/reserve-auth-vectors.json');

const dd = JSON.parse(readFileSync(DIRECT_DEPOSIT, 'utf8')) as {
  chainID: number;
  escrow: string;
  depositId: string;
  reserve: { quoteHash: string; settler: string; sourceAmount: string; reserveSignature: string };
};
type ReserveVector = {
  name: string;
  input: {
    auth: { message: string; message_prehash: string; signature: string };
    expected: ReserveMessageInput & { reserver: string };
  };
};
const reserveVectors = (
  JSON.parse(readFileSync(RESERVE_VECTORS, 'utf8')) as { vectors: ReserveVector[] }
).vectors;
const vector = (name: string) => reserveVectors.find((v) => v.name === name)!.input;
const anchor = vector('evm-eoa-verified').auth;

// Foundry's makeAddrAndKey('reserver'), the key that signed the contract-bound reserve.
const RESERVER_KEY = keccak256(toUtf8Bytes('reserver'));
const RESERVER = new Wallet(RESERVER_KEY).address;

const INPUT: ReserveMessageInput = {
  network: `eip155:${dd.chainID}`,
  escrowContract: dd.escrow,
  depositId: dd.depositId,
  quoteHash: dd.reserve.quoteHash,
  settler: dd.reserve.settler,
  sourceAmount: dd.reserve.sourceAmount,
};

async function signed(input: ReserveMessageInput, key = RESERVER_KEY) {
  const built = buildReserveMessage(input);
  const { signature } = await localKeySigner(input.network, key).sign({
    ...built,
    signature: '',
  });
  return { ...built, signature };
}

describe('buildReserveMessage on EVM', () => {
  it('builds the contract-bound reserve: the same digest, and the reserver key signs the same bytes', async () => {
    const auth = await signed(INPUT);

    expect(RESERVER).toBe('0x9139213bE0cF31C8B1bD609f1d953605e20bD2Cb');
    expect(auth.message).toBe(anchor.message);
    expect(JSON.parse(auth.message_prehash)).toEqual(JSON.parse(anchor.message_prehash));
    expect(auth.signature).toBe(dd.reserve.reserveSignature);
  });

  it('verifies to its signer', async () => {
    const got = await verifyReserveAuth(await signed(INPUT), { ...INPUT, reserver: RESERVER });

    expect(got).toEqual({
      valid: true,
      path: 'eoa',
      reason: 'verified',
      detail: 'the signature recovers to the reserver',
    });
  });

  it('reads addresses and hashes in any case', () => {
    const upper = buildReserveMessage({
      ...INPUT,
      escrowContract: dd.escrow.toUpperCase().replace('0X', '0x'),
      depositId: dd.depositId.toUpperCase().replace('0X', '0x'),
      settler: dd.reserve.settler.toLowerCase(),
    });

    expect(upper.message).toBe(anchor.message);
  });

  // Each value the reserver signs is bound: a reserve built for another value is refused by a
  // verifier that expects this one, for that value's own reason.
  const tampered: [string, Partial<ReserveMessageInput>, ReserveAuthReason][] = [
    ['depositId', { depositId: '0x' + '01'.repeat(32) }, 'deposit_id_mismatch'],
    ['quoteHash', { quoteHash: '0x' + '02'.repeat(32) }, 'quote_hash_mismatch'],
    ['settler', { settler: '0x' + '03'.repeat(20) }, 'settler_mismatch'],
    ['sourceAmount', { sourceAmount: '600000000000000000001' }, 'source_amount_mismatch'],
    ['escrow', { escrowContract: '0x' + '04'.repeat(20) }, 'domain_mismatch'],
    ['chain', { network: 'eip155:1' }, 'domain_mismatch'],
  ];
  for (const [field, change, reason] of tampered) {
    it(`a reserve for another ${field} is refused as ${reason}`, async () => {
      const got = await verifyReserveAuth(await signed({ ...INPUT, ...change }), {
        ...INPUT,
        reserver: RESERVER,
      });

      expect(got.reason).toBe(reason);
      expect(got.valid).toBe(false);
    });
  }

  const invalid: [string, Partial<ReserveMessageInput>, string][] = [
    [
      'a zero depositId',
      { depositId: '0x' + '0'.repeat(64) },
      'reserve_auth: the depositId is not a non-zero 0x-prefixed 32-byte hex value',
    ],
    [
      'an unprefixed quoteHash',
      { quoteHash: dd.reserve.quoteHash.slice(2) },
      'reserve_auth: the quoteHash is not a non-zero 0x-prefixed 32-byte hex value',
    ],
    [
      'a settler that is not hex',
      { settler: 'not-an-address' },
      'reserve_auth: the settler is not a non-zero address on this chain',
    ],
    [
      'the zero settler',
      { settler: '0x' + '0'.repeat(40) },
      'reserve_auth: the settler is not a non-zero address on this chain',
    ],
    [
      'an escrow that is not an address',
      { escrowContract: '0x1234' },
      'reserve_auth: the escrow is not an address on this chain',
    ],
    [
      'a zero sourceAmount',
      { sourceAmount: '0' },
      'reserve_auth: the sourceAmount is not a positive decimal integer string',
    ],
    [
      'a sourceAmount above uint256',
      { sourceAmount: (1n << 256n).toString() },
      'reserve_auth: the sourceAmount exceeds uint256',
    ],
    [
      'a chain id that is not a number',
      { network: 'eip155:abc' },
      'reserve_auth: the network is not a known eip155 chain',
    ],
    [
      'a network of another family',
      { network: 'cosmos:hub-4' },
      'reserve_auth: the network is not an eip155, tron, solana or stellar chain',
    ],
  ];
  for (const [name, change, message] of invalid) {
    it(`refuses ${name} before anything is signed`, () => {
      expect(() => buildReserveMessage({ ...INPUT, ...change })).toThrow(message);
    });
  }
});

// The Tron reserves in reserve-auth-vectors.json are signed by the same reserver key over typed data
// from an independent TIP-712 encoder.
describe('buildReserveMessage on Tron', () => {
  const shasta = vector('tron-eoa-verified');
  const { reserver: TRON_RESERVER, ...TRON_INPUT } = shasta.expected;

  it('builds the frozen Tron reserve: the same digest, and the reserver key signs the same bytes', async () => {
    const auth = await signed(TRON_INPUT);

    expect(TRON_INPUT.settler).toMatch(/^T/);
    expect(auth.message).toBe(shasta.auth.message);
    // The frozen prehash checksums its addresses; an address is signed as 20 bytes, so case is not.
    expect(JSON.parse(auth.message_prehash.toLowerCase())).toEqual(
      JSON.parse(shasta.auth.message_prehash.toLowerCase()),
    );
    expect(auth.signature).toBe(shasta.auth.signature);
  });

  it('verifies to its base58 signer', async () => {
    const got = await verifyReserveAuth(await signed(TRON_INPUT), {
      ...TRON_INPUT,
      reserver: TRON_RESERVER,
    });

    expect(got).toEqual({
      valid: true,
      path: 'eoa',
      reason: 'verified',
      detail: 'the signature recovers to the reserver',
    });
  });

  it('signs base58 and 41-prefixed hex addresses as the same 20-byte hex', () => {
    const { reserver: _hexReserver, ...hex41 } = vector(
      'tron-hex41-expectations-verified',
    ).expected;
    const built = buildReserveMessage(hex41);

    expect(hex41.settler).toMatch(/^41/);
    expect(built.message).toBe(shasta.auth.message);
    expect(JSON.parse(built.message_prehash).message.settler.toLowerCase()).toBe(
      '0x' + hex41.settler.slice(2),
    );
  });

  it('builds a local node reserve with the chain id the caller supplies', async () => {
    const localnet = vector('tron-localnet-supplied-chain-id-verified');
    const { reserver: _reserver, ...input } = localnet.expected;
    const auth = await signed(input);

    expect(auth.message).toBe(localnet.auth.message);
    expect(auth.signature).toBe(localnet.auth.signature);
  });

  const tampered: [string, Partial<ReserveMessageInput>, ReserveAuthReason][] = [
    ['depositId', { depositId: '0x' + '01'.repeat(32) }, 'deposit_id_mismatch'],
    ['quoteHash', { quoteHash: '0x' + '02'.repeat(32) }, 'quote_hash_mismatch'],
    ['settler', { settler: '41' + '03'.repeat(20) }, 'settler_mismatch'],
    ['sourceAmount', { sourceAmount: '25000001' }, 'source_amount_mismatch'],
    ['escrow', { escrowContract: '41' + '04'.repeat(20) }, 'domain_mismatch'],
    ['chain', { network: 'tron:mainnet' }, 'domain_mismatch'],
  ];
  for (const [field, change, reason] of tampered) {
    it(`a reserve for another ${field} is refused as ${reason}`, async () => {
      const got = await verifyReserveAuth(await signed({ ...TRON_INPUT, ...change }), {
        ...TRON_INPUT,
        reserver: TRON_RESERVER,
      });

      expect(got.reason).toBe(reason);
      expect(got.valid).toBe(false);
    });
  }

  const invalid: [string, Partial<ReserveMessageInput>, string][] = [
    [
      'a Tron cluster the table does not know, without tronChainIds',
      { network: 'tron:nile' },
      'reserve_auth: the network is not a known tron chain',
    ],
    [
      'a supplied chain id that conflicts with the table',
      { tronChainIds: { shasta: 1 } },
      'reserve_auth: the Tron chain id supplied for cluster "shasta" is 1, but the built-in table has 2494104990',
    ],
    [
      'a base58 settler with a bad checksum',
      { settler: TRON_INPUT.settler.slice(0, -1) + (TRON_INPUT.settler.endsWith('x') ? 'y' : 'x') },
      'reserve_auth: the settler is not a non-zero address on this chain',
    ],
    [
      'the zero settler',
      { settler: '41' + '0'.repeat(40) },
      'reserve_auth: the settler is not a non-zero address on this chain',
    ],
    [
      'an escrow that is not a Tron address',
      { escrowContract: 'TNotAnAddress' },
      'reserve_auth: the escrow is not an address on this chain',
    ],
  ];
  for (const [name, change, message] of invalid) {
    it(`refuses ${name} before anything is signed`, () => {
      expect(() => buildReserveMessage({ ...TRON_INPUT, ...change })).toThrow(message);
    });
  }
});

// The Solana reserves in reserve-auth-vectors.json sign the frozen V5 reserve hash with this ed25519
// seed's key: the bytes 1 to 32.
describe('buildReserveMessage on Solana', () => {
  const SOLANA_RESERVER_SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString(
    'hex',
  );
  const devnet = vector('solana-verified');
  const { reserver: SOLANA_RESERVER, ...SOLANA_INPUT } = devnet.expected;
  const signedSolana = (input: ReserveMessageInput) => signed(input, SOLANA_RESERVER_SEED);

  it('builds the frozen V5 reserve: the same hash and record, and the reserver key signs the same bytes', async () => {
    const auth = await signedSolana(SOLANA_INPUT);

    expect(auth.message).toBe(devnet.auth.message);
    expect(auth.message_prehash).toBe(devnet.auth.message_prehash);
    expect(auth.signature).toBe(devnet.auth.signature);
  });

  it('verifies to its ed25519 signer', async () => {
    const got = await verifyReserveAuth(await signedSolana(SOLANA_INPUT), {
      ...SOLANA_INPUT,
      reserver: SOLANA_RESERVER,
    });

    expect(got).toEqual({
      valid: true,
      path: 'eoa',
      reason: 'verified',
      detail: 'the signature verifies against the reserver',
    });
  });

  it('builds the u64 maximum amount the escrow accepts', async () => {
    const max = vector('solana-source-amount-u64-max-verified');
    const { reserver: _reserver, ...input } = max.expected;
    const auth = await signedSolana(input);

    expect(input.sourceAmount).toBe(((1n << 64n) - 1n).toString());
    expect(auth.message).toBe(max.auth.message);
    expect(auth.signature).toBe(max.auth.signature);
  });

  it('reads hashes in any case and writes them in lowercase', () => {
    const upper = buildReserveMessage({
      ...SOLANA_INPUT,
      depositId: SOLANA_INPUT.depositId.toUpperCase().replace('0X', '0x'),
      quoteHash: SOLANA_INPUT.quoteHash.toUpperCase().replace('0X', '0x'),
    });

    expect(upper).toEqual(buildReserveMessage(SOLANA_INPUT));
  });

  const OTHER_ACCOUNT = '3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy4';
  const tampered: [string, Partial<ReserveMessageInput>, ReserveAuthReason][] = [
    ['depositId', { depositId: '0x' + '01'.repeat(32) }, 'deposit_id_mismatch'],
    ['quoteHash', { quoteHash: '0x' + '02'.repeat(32) }, 'quote_hash_mismatch'],
    ['settler', { settler: OTHER_ACCOUNT }, 'settler_mismatch'],
    ['sourceAmount', { sourceAmount: '90001' }, 'source_amount_mismatch'],
    ['escrow program', { escrowContract: OTHER_ACCOUNT }, 'message_mismatch'],
    ['cluster id', { svmSignatureClusterId: 'other' }, 'message_mismatch'],
    ['domain version', { svmSignatureDomainVersion: 6 }, 'message_mismatch'],
  ];
  for (const [field, change, reason] of tampered) {
    it(`a reserve for another ${field} is refused as ${reason}`, async () => {
      const got = await verifyReserveAuth(await signedSolana({ ...SOLANA_INPUT, ...change }), {
        ...SOLANA_INPUT,
        reserver: SOLANA_RESERVER,
      });

      expect(got.reason).toBe(reason);
      expect(got.valid).toBe(false);
    });
  }

  const invalid: [string, Partial<ReserveMessageInput>, string][] = [
    [
      'a network without a cluster',
      { network: 'solana:' },
      'reserve_auth: the network is not a known solana chain',
    ],
    [
      'a missing signature domain',
      { svmSignatureDomainVersion: undefined },
      'reserve_auth: the Solana escrow domain (program id, cluster, domain version) was not supplied',
    ],
    [
      'a domain version that does not bind the amount',
      { svmSignatureDomainVersion: 4 },
      'reserve_auth: the Solana escrow signature domain version must be 5 or later to bind the source amount',
    ],
    [
      'an escrow program id that is not a key',
      { escrowContract: 'not-a-key' },
      'reserve_auth: the Solana escrow program id is not a base58 32-byte public key',
    ],
    [
      'a zero depositId',
      { depositId: '0x' + '0'.repeat(64) },
      'reserve_auth: the depositId is not a non-zero 0x-prefixed 32-byte hex value',
    ],
    [
      'a settler that is not base58',
      { settler: '0x' + '22'.repeat(32) },
      'reserve_auth: the settler is not a non-zero base58 32-byte public key',
    ],
    [
      'the zero settler',
      { settler: '11111111111111111111111111111111' },
      'reserve_auth: the settler is not a non-zero base58 32-byte public key',
    ],
    [
      'a zero sourceAmount',
      { sourceAmount: '0' },
      'reserve_auth: the sourceAmount is not a positive decimal integer string',
    ],
    [
      'a sourceAmount above u64',
      { sourceAmount: (1n << 64n).toString() },
      'reserve_auth: the sourceAmount exceeds u64',
    ],
  ];
  for (const [name, change, message] of invalid) {
    it(`refuses ${name} before anything is signed`, () => {
      expect(() => buildReserveMessage({ ...SOLANA_INPUT, ...change })).toThrow(message);
    });
  }
});

// The Stellar reserve digest is pinned by contracts/stellar/source/docs/witness-layouts.md (golden
// vectors derived out of band) and the contract's own test anchors.
describe('buildReserveMessage on Stellar', () => {
  const fill = (byte: number) => new Uint8Array(32).fill(byte);
  const ESCROW = Address.contract(fill(0xc0)).toString();
  const SETTLER = Address.account(fill(0xa5)).toString();
  const DEPOSIT_ID = '0xd28667e7c40efa69ab7ba45db817a82044cb10840fe95a45425e7b99556f6a65';
  const GOLDEN_RESERVE_DIGEST =
    '0x827560933bcd171fc0ac5eb23d176b7fc5f0b2e5fbb7e84fd1d10acb99fb146f';
  const STELLAR_INPUT: ReserveMessageInput = {
    network: 'stellar:testnet',
    escrowContract: ESCROW,
    depositId: DEPOSIT_ID,
    quoteHash: '0x' + '33'.repeat(32),
    settler: SETTLER,
    sourceAmount: '1000000',
  };
  const SEED = '77'.repeat(32);

  it('builds the golden reserve digest and the record it is computed from', () => {
    const built = buildReserveMessage(STELLAR_INPUT);

    expect(built.message).toBe(GOLDEN_RESERVE_DIGEST);
    expect(JSON.parse(built.message_prehash)).toEqual({
      deposit_id: DEPOSIT_ID,
      quote_hash: '0x' + '33'.repeat(32),
      settler: SETTLER,
      source_amount: '1000000',
    });
  });

  it("is signed by the reserver's ed25519 key over the 32 digest bytes", async () => {
    const built = buildReserveMessage(STELLAR_INPUT);
    const { signature } = await localKeySigner('stellar:testnet', SEED).sign({
      ...built,
      signature: '',
    });
    const publicKey = nacl.sign.keyPair.fromSeed(Buffer.from(SEED, 'hex')).publicKey;

    expect(
      nacl.sign.detached.verify(
        Buffer.from(built.message.slice(2), 'hex'),
        Buffer.from(signature.slice(2), 'hex'),
        publicKey,
      ),
    ).toBe(true);
    expect(Pubkey.fromBytes(publicKey).toString()).toMatch(/^G/);
  });

  it('reads hashes in any case and a contract settler', () => {
    const built = buildReserveMessage({
      ...STELLAR_INPUT,
      depositId: DEPOSIT_ID.toUpperCase().replace('0X', '0x'),
    });
    expect(built.message).toBe(GOLDEN_RESERVE_DIGEST);
    expect(
      buildReserveMessage({ ...STELLAR_INPUT, settler: Address.contract(fill(0xa5)).toString() })
        .message,
    ).not.toBe(GOLDEN_RESERVE_DIGEST);
  });

  it('refuses the escrow contract as a settler but accepts an account with the same key bytes', () => {
    expect(() => buildReserveMessage({ ...STELLAR_INPUT, settler: ESCROW })).toThrow(
      /the Stellar settler cannot be the escrow itself/,
    );
    expect(() =>
      buildReserveMessage({ ...STELLAR_INPUT, settler: Address.account(fill(0xc0)).toString() }),
    ).not.toThrow();
  });

  // Each value the reserver signs changes the digest, and so cannot be swapped under a signature.
  const bound: [string, Partial<ReserveMessageInput>][] = [
    ['depositId', { depositId: '0x' + '01'.repeat(32) }],
    ['quoteHash', { quoteHash: '0x' + '02'.repeat(32) }],
    ['settler', { settler: Address.account(fill(0xa6)).toString() }],
    ['sourceAmount', { sourceAmount: '999999' }],
    ['escrow', { escrowContract: Address.contract(fill(0xc1)).toString() }],
    ['network', { network: 'stellar:pubnet' }],
  ];
  for (const [field, change] of bound) {
    it(`binds the ${field}`, () => {
      expect(buildReserveMessage({ ...STELLAR_INPUT, ...change }).message).not.toBe(
        GOLDEN_RESERVE_DIGEST,
      );
    });
  }

  const invalid: [string, Partial<ReserveMessageInput>, string][] = [
    [
      'a zero depositId',
      { depositId: '0x' + '0'.repeat(64) },
      'reserve_auth: the depositId is not a non-zero 0x-prefixed 32-byte hex value',
    ],
    [
      'an unprefixed quoteHash',
      { quoteHash: '33'.repeat(32) },
      'reserve_auth: the quoteHash is not a non-zero 0x-prefixed 32-byte hex value',
    ],
    [
      'a settler that is not a strkey',
      { settler: 'not-an-address' },
      'reserve_auth: the settler is not a Stellar G... or C... address',
    ],
    [
      'an escrow that is an account',
      { escrowContract: SETTLER },
      'reserve_auth: the Stellar escrow is not a contract (C...) address',
    ],
    [
      'a missing escrow',
      { escrowContract: '' },
      'reserve_auth: the Stellar escrow contract was not supplied',
    ],
    [
      'a Stellar network the table does not know',
      { network: 'stellar:mars' },
      'reserve_auth: the Stellar network is not one the verifier knows',
    ],
    [
      'a zero sourceAmount',
      { sourceAmount: '0' },
      'reserve_auth: the sourceAmount is not a positive decimal integer string',
    ],
    [
      'a hex sourceAmount',
      { sourceAmount: '0x10' },
      'reserve_auth: the sourceAmount is not a positive decimal integer string',
    ],
  ];
  for (const [name, change, message] of invalid) {
    it(`refuses ${name} before anything is signed`, () => {
      expect(() => buildReserveMessage({ ...STELLAR_INPUT, ...change })).toThrow(message);
    });
  }

  it('refuses a sourceAmount the escrow cannot hold', () => {
    expect(() =>
      buildReserveMessage({ ...STELLAR_INPUT, sourceAmount: (1n << 127n).toString() }),
    ).toThrow(/^reserve_auth: /);
  });
});
