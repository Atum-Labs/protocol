import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';

import { computeActiveDepositHash, type EscrowActiveDeposit } from './active-deposit';
import { ACCOUNT_ADDRESS, Address, CONTRACT_ADDRESS } from './address';
import { computeDepositHash, computeDestinationHash } from './deposit-encoder';
import { encodeAmount16, encodeU64LE, keccak256, MAX_I128, stringToBytes } from './encoding-utils';
import {
  escrowDomainPrefixBytes,
  newEscrowDomain,
  networkIdFromPassphrase,
  PASSPHRASE_PUBLIC,
  PASSPHRASE_TESTNET,
  SIGNATURE_DOMAIN_VERSION,
  type EscrowDomain,
} from './escrow-domain';
import { EncodingError, InvalidStrkeyError, UnsupportedAddressError } from './errors';
import { Pubkey } from './pubkey';
import { computeRefundHash } from './refund-encoder';
import { computeReleaseHash } from './release-encoder';
import { computeRenounceHash } from './renounce-encoder';
import { computeReserveHash } from './reserve-encoder';

/**
 * Asserts contracts/stellar/conformance/vectors.json, the one fixture the Rust contract tests, the Go
 * encoder and this encoder all reproduce. None of the three produces it: regenerate_vectors.py derives it
 * from docs/witness-layouts.md with its own keccak-256, so a digest that differs here means this encoder
 * drifted, not that the file is stale.
 */

interface VectorCase {
  name: string;
  kind: string;
  network: string;
  contractId: string;
  input: Record<string, string>;
  digest: string;
  mutates?: string;
  signature?: string;
}

interface VectorFile {
  signatureDomainVersion: number;
  networks: Record<string, { passphrase: string; networkId: string }>;
  delegate: { seed: string; publicKey: string };
  addresses: { strkey: string; type: 'account' | 'contract'; key: string }[];
  rejectedAddresses: Record<string, string>;
  cases: VectorCase[];
}

const REGEN = 'run contracts/stellar/conformance/regenerate_vectors.py only for an intended layout change';

const vectors: VectorFile = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'conformance', 'vectors.json'), 'utf8'),
);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

function domainOf(c: VectorCase): EscrowDomain {
  return newEscrowDomain(vectors.networks[c.network].passphrase, Address.fromStrkey(c.contractId));
}

function activeFrom(i: Record<string, string>): EscrowActiveDeposit {
  return {
    depositor: Address.fromStrkey(i.depositor),
    quoteHash: unhex(i.quoteHash),
    depositRequestHash: unhex(i.depositRequestHash),
    destinationHash: unhex(i.destinationHash),
    token: Address.fromStrkey(i.token),
    amount: BigInt(i.amount),
    feeAmount: BigInt(i.feeAmount),
    reserver: Pubkey.fromHex(i.reserver),
    releaser: Pubkey.fromHex(i.releaser),
    settler: Address.fromStrkey(i.settler),
  };
}

function digestOf(c: VectorCase): Uint8Array {
  const i = c.input;
  switch (c.kind) {
    case 'destinationHash':
      return computeDestinationHash(i.destination);
    case 'deposit':
      return computeDepositHash(
        {
          depositRequestHash: unhex(i.depositRequestHash),
          destination: i.destination,
          depositor: Address.fromStrkey(i.depositor),
          token: Address.fromStrkey(i.token),
          epoch: BigInt(i.epoch),
          amount: BigInt(i.amount),
          reserver: Pubkey.fromHex(i.reserver),
          releaser: Pubkey.fromHex(i.releaser),
          nonce: BigInt(i.nonce),
          issuedAt: BigInt(i.issuedAt),
          deadline: BigInt(i.deadline),
        },
        domainOf(c),
      );
    case 'reserve':
      return computeReserveHash(
        {
          depositId: unhex(i.depositId),
          quoteHash: unhex(i.quoteHash),
          settler: Address.fromStrkey(i.settler),
          sourceAmount: BigInt(i.sourceAmount),
        },
        domainOf(c),
      );
    case 'release':
      return computeReleaseHash({ depositId: unhex(i.depositId), ...activeFrom(i) }, domainOf(c));
    case 'refund':
      return computeRefundHash({ depositId: unhex(i.depositId), ...activeFrom(i) }, domainOf(c));
    case 'renounce':
      return computeRenounceHash(
        {
          depositor: Address.fromStrkey(i.depositor),
          token: Address.fromStrkey(i.token),
          epoch: BigInt(i.epoch),
          nonce: BigInt(i.nonce),
          deadline: BigInt(i.deadline),
        },
        domainOf(c),
      );
    case 'activeDeposit':
      return computeActiveDepositHash(activeFrom(i));
    default:
      // A new kind in the fixture must be taught to every implementation, so it fails loudly here
      throw new Error(`${c.name}: vectors.json has kind "${c.kind}" this test does not implement`);
  }
}

describe('conformance vectors (shared with the Rust contract tests and the Go encoder)', () => {
  it('is for the signature domain version this encoder implements', () => {
    expect(vectors.signatureDomainVersion, REGEN).toBe(SIGNATURE_DOMAIN_VERSION);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(hex(digestOf(c)), `encoder drifted from the vector; ${REGEN}`).toBe(c.digest);
  });

  it('covers every digest kind and enough cases', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(90);
    expect([...new Set(vectors.cases.map((c) => c.kind))].sort()).toEqual([
      'activeDeposit',
      'deposit',
      'destinationHash',
      'refund',
      'release',
      'renounce',
      'reserve',
    ]);
  });

  it('changes the digest when any single field changes, so every member is bound', () => {
    const byName = new Map(vectors.cases.map((c) => [c.name, c]));
    const mutated = vectors.cases.filter((c) => c.mutates);
    expect(mutated.length).toBeGreaterThanOrEqual(40);
    for (const c of mutated) {
      const base = byName.get(c.mutates!);
      expect(base, `${c.name} mutates unknown case ${c.mutates}`).toBeDefined();
      expect(c.digest, `${c.name} does not change the digest of ${c.mutates}`).not.toBe(base!.digest);
    }
    // Release and refund share every input, so a release signature must not validate as a refund
    expect(byName.get('release/base')!.digest).not.toBe(byName.get('refund/base')!.digest);
  });

  it('derives the network ids from the passphrases', () => {
    for (const [name, n] of Object.entries(vectors.networks)) {
      expect(hex(sha256(stringToBytes(n.passphrase))), name).toBe(n.networkId);
    }
    expect(hex(networkIdFromPassphrase(PASSPHRASE_TESTNET))).toBe(vectors.networks.testnet.networkId);
    expect(hex(networkIdFromPassphrase(PASSPHRASE_PUBLIC))).toBe(vectors.networks.public.networkId);
  });

  it('decodes the strkey table to the documented addr33 bytes and encodes it back', () => {
    expect(vectors.addresses.length).toBeGreaterThan(0);
    for (const a of vectors.addresses) {
      const addr = Address.fromStrkey(a.strkey);
      expect(addr.type).toBe(a.type === 'account' ? ACCOUNT_ADDRESS : CONTRACT_ADDRESS);
      expect(hex(addr.toBytes())).toBe(a.key);
      expect(hex(addr.toBytes33())).toBe(`${a.type === 'account' ? '00' : '01'}${a.key}`);
      expect(addr.toString()).toBe(a.strkey);
    }
  });

  it('rejects the muxed, claimable-balance and secret-seed strkeys', () => {
    expect(() => Address.fromStrkey(vectors.rejectedAddresses.muxed)).toThrow(UnsupportedAddressError);
    expect(() => Address.fromStrkey(vectors.rejectedAddresses.claimableBalance)).toThrow(UnsupportedAddressError);
    expect(() => Address.fromStrkey(vectors.rejectedAddresses.secretSeed)).toThrow(InvalidStrkeyError);
  });

  it('verifies the pinned delegate signatures and reproduces them from the seed', () => {
    const seed = unhex(vectors.delegate.seed);
    const pub = ed25519.getPublicKey(seed);
    expect(hex(pub)).toBe(vectors.delegate.publicKey);
    const signed = vectors.cases.filter((c) => c.signature);
    // deposit and renounce are the delegate's digests
    expect(signed.map((c) => c.kind).sort()).toEqual(['deposit', 'renounce']);
    for (const c of signed) {
      const digest = unhex(c.digest);
      expect(ed25519.verify(unhex(c.signature!), digest, pub), c.name).toBe(true);
      expect(hex(ed25519.sign(digest, seed)), c.name).toBe(c.signature);
    }
  });
});

describe('encoding primitives', () => {
  it('encodes amounts as 16 little-endian bytes and rejects what no i128 transaction can hold', () => {
    expect(hex(encodeAmount16(0n))).toBe('00000000000000000000000000000000');
    expect(hex(encodeAmount16(0x0102n))).toBe('02010000000000000000000000000000');
    expect(hex(encodeAmount16(1n << 64n))).toBe('00000000000000000100000000000000');
    expect(hex(encodeAmount16(MAX_I128))).toBe('ffffffffffffffffffffffffffffff7f');
    expect(() => encodeAmount16(1n << 127n)).toThrow();
    expect(() => encodeAmount16(-1n)).toThrow();
    // A JS number is not a bigint: refuse it rather than guessing a width
    expect(() => encodeAmount16(5 as unknown as bigint)).toThrow();
  });

  it('encodes u64 little-endian and rejects out-of-range values', () => {
    expect(hex(encodeU64LE(0x0000000100000007n))).toBe('0700000001000000');
    expect(() => encodeU64LE(1n << 64n)).toThrow(EncodingError);
    expect(() => encodeU64LE(-1n)).toThrow('u64 out of range');
  });

  // Only what strkey-vectors.json cannot express lives here; every other malformed or unsupported strkey
  // (including the non-zero spare bits case) belongs in that file.
  it('rejects every wrong last character of a checksummed strkey', () => {
    const good = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    // A 56-character strkey is exactly 280 bits, so there are no spare bits to make non-canonical:
    // changing the last character has to fail the checksum, whatever base32 digit it becomes.
    for (const alt of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567') {
      if (alt === good.at(-1)) continue;
      expect(() => Address.fromStrkey(good.slice(0, -1) + alt), alt).toThrow(InvalidStrkeyError);
    }
  });

  it('prefixes every digest with "escrow", the version, the network id and the contract id', () => {
    const d = newEscrowDomain(PASSPHRASE_TESTNET, Address.contract(new Uint8Array(32).fill(0xc0)));
    const prefix = escrowDomainPrefixBytes(d);
    expect(prefix.map((p) => p.length)).toEqual([6, 1, 32, 32]);
    expect(Buffer.from(prefix[0]).toString()).toBe('escrow');
    expect(prefix[1][0]).toBe(2);
  });
});

describe('network passphrase', () => {
  // network_id is sha256 of the bytes as given (witness-layouts.md): whitespace is part of the network, so
  // nothing trims it, and a whitespace-only passphrase is a distinct network, not an empty one.
  it('is hashed exactly as given, never trimmed', () => {
    const escrow = Address.contract(new Uint8Array(32).fill(0xc0));
    const testnet = newEscrowDomain(PASSPHRASE_TESTNET, escrow);
    for (const p of [`${PASSPHRASE_TESTNET} `, ` ${PASSPHRASE_TESTNET}`, `${PASSPHRASE_TESTNET}\n`]) {
      const d = newEscrowDomain(p, escrow);
      expect(hex(d.networkId), JSON.stringify(p)).not.toBe(hex(testnet.networkId));
      expect(hex(d.networkId)).toBe(hex(sha256(stringToBytes(p))));
    }
    expect(hex(newEscrowDomain(' ', escrow).networkId)).toBe(hex(sha256(stringToBytes(' '))));
  });
});

/**
 * The hash-first rule: the same deposit with the destination fed raw is the unsound value
 * witness-layouts.md lists, and it must differ from the real digest.
 */
describe('destination commitment', () => {
  it('is hashed before it enters the digest', () => {
    const base = vectors.cases.find((c) => c.name === 'deposit/base')!;
    const i = base.input;
    const raw = keccak256(
      ...escrowDomainPrefixBytes(domainOf(base)),
      stringToBytes('deposit'),
      unhex(i.depositRequestHash),
      stringToBytes(i.destination),
      Address.fromStrkey(i.depositor).toBytes33(),
      Address.fromStrkey(i.token).toBytes33(),
      encodeU64LE(BigInt(i.epoch)),
      encodeAmount16(BigInt(i.amount)),
      unhex(i.reserver),
      unhex(i.releaser),
      encodeU64LE(BigInt(i.nonce)),
      encodeU64LE(BigInt(i.issuedAt)),
      encodeU64LE(BigInt(i.deadline)),
    );
    expect(hex(raw)).toBe('a27e5b952663bace502540b5a9f2d6d0ec8e414639741daa9cfdfa3b3abe7fdd');
    expect(hex(raw)).not.toBe(base.digest);
  });
});
