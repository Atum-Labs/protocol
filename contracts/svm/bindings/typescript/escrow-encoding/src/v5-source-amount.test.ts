import { describe, expect, it } from 'vitest';

import { computeReserveHashV3 } from './reserve-encoder';
import { keccak256, stringToBytes, encodeU64LE } from './encoding-utils';
import { EscrowDomain } from './escrow-domain';
import { Pubkey } from './pubkey';
import { ZeroSourceAmountError } from './errors';

/**
 * Solana parity: the v5 reserve preimage binds the charged source amount.
 *
 * These pin the SAME fixture and the SAME value as the on-chain program
 * (`reserve_hash_matches_the_documented_v5_layout`) and the Go encoder
 * (`TestComputeReserveHashV3_CrossSideAnchor`). All three agreeing on one input is what rules out
 * a wire-format split between the party that signs a reserve and the program that verifies it —
 * each side pinning only its own derivation would not.
 */

// The escrow program's declared ID, 44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs, as raw hex so no
// base58 decoder sits in the derivation path.
const PROGRAM_ID_HEX = '2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238';

/**
 * Authoritative, from the on-chain Rust `compute_reserve_hash` at domain version 5, and pinned
 * identically by the Go encoder. If this disagrees, one side drifted from the documented preimage
 * layout — re-derive out of band and fix that side rather than pasting the computed value in.
 */
const ANCHOR_RESERVE_V5 = 'd9f194eb2cdbbb060453ee08633a736adbbdb5efd7bf680de0997b18b145daf4';

const SOURCE_AMOUNT = 90_000n;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function filled(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function clusterId(name: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(name));
  return out;
}

/** The domain the v5 reserve anchor was derived against. */
function testV5Domain(): EscrowDomain {
  return {
    clusterId: clusterId('test'),
    signatureDomainVersion: 5,
    programId: new Pubkey(hexToBytes(PROGRAM_ID_HEX)),
  };
}

const RESERVE_PARAMS = {
  depositHash: filled(0x11),
  recipient: new Pubkey(filled(0x22)),
};
const QUOTE_HASH = filled(0x33);

describe('computeReserveHashV3 (domain version 5)', () => {
  it('reproduces the anchor the program and the Go encoder pin for an identical input', () => {
    const got = computeReserveHashV3(RESERVE_PARAMS, QUOTE_HASH, SOURCE_AMOUNT, testV5Domain());
    expect(toHex(got)).toBe(ANCHOR_RESERVE_V5);
  });

  it('matches the documented layout re-assembled field by field', () => {
    // Independent of computeReserveHashV3's own ordering, so a reordered, dropped or re-encoded
    // field still fails even if every side were changed together.
    const domain = testV5Domain();
    const expected = keccak256(
      stringToBytes('escrow'),
      new Uint8Array([5]),
      domain.clusterId,
      domain.programId.toBytes(),
      stringToBytes('reserve'),
      RESERVE_PARAMS.recipient.toBytes(),
      RESERVE_PARAMS.depositHash,
      QUOTE_HASH,
      encodeU64LE(SOURCE_AMOUNT),
    );

    const got = computeReserveHashV3(RESERVE_PARAMS, QUOTE_HASH, SOURCE_AMOUNT, testV5Domain());
    expect(toHex(got)).toBe(toHex(expected));
  });

  it('binds the source amount — two charges must not share a signature', () => {
    // Without this the field could be accepted and dropped before hashing, and every other test
    // here would still pass while a reserver signature for one charge authorized any other.
    const a = computeReserveHashV3(RESERVE_PARAMS, QUOTE_HASH, 90_000n, testV5Domain());
    const b = computeReserveHashV3(RESERVE_PARAMS, QUOTE_HASH, 100_000n, testV5Domain());
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('preserves precision above 2^53, where a JS number silently would not', () => {
    // The reason the parameter is a bigint. Number(2n**53n + 1n) === Number(2n**53n), so a
    // number-typed charge would sign a different amount than the caller passed.
    const big = 2n ** 53n + 1n;
    const alsoBig = 2n ** 53n;
    expect(Number(big)).toBe(Number(alsoBig)); // the hazard, made explicit
    const a = computeReserveHashV3(RESERVE_PARAMS, QUOTE_HASH, big, testV5Domain());
    const b = computeReserveHashV3(RESERVE_PARAMS, QUOTE_HASH, alsoBig, testV5Domain());
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('rejects a zero source amount, as the program does', () => {
    expect(() =>
      computeReserveHashV3(RESERVE_PARAMS, QUOTE_HASH, 0n, testV5Domain()),
    ).toThrow(ZeroSourceAmountError);
  });
});
