import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  createTvmPermitWitnessTransferFromPrehashWithDestination,
  hashTvmPermitWitnessTransferFrom,
  PERMIT_WITNESS_TYPES_WITH_DESTINATION,
} from './deposit-encoder';

// Oracle: the digest the Go encoder's DigestWithDestination produces for the same inputs (given as
// hex there), pinned by TestDepositWithDestinationGolden in ../../go/encoding/deposit_encoder_test.go.
const ORACLE = {
  chainId: 2494104990, // Shasta block.chainid
  permit2Address: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
  tokenAddress: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
  amount: '100000000',
  spenderAddress: 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py',
  nonce: 1776340107514n,
  deadline: 1776343707n,
  depositRequestHash: keccak256(toUtf8Bytes('req-golden-tron')),
  destination: 'tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB',
  reserverAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
  releaserAddress: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
  expectedDigest: '0xe3d341e43876778976d830aa30cd15f97a7874030e8e9c6e31faa36043a98791',
};

describe('createTvmPermitWitnessTransferFromPrehashWithDestination + hashTvmPermitWitnessTransferFrom', () => {
  it('matches the Go encoder digest', () => {
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(hashTvmPermitWitnessTransferFrom(prehash)).toBe(ORACLE.expectedDigest);
  });

  it('masks chainId to 4 bytes and serializes it as a lowercase hex string', () => {
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(prehash.domain.chainId).toBe('0x94a9059e');
  });

  it('normalizes every address to bare 0x + 20-byte hex and leaves the destination untouched', () => {
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(prehash.domain.verifyingContract).toMatch(/^0x[0-9a-f]{40}$/);
    expect(prehash.message.permitted.token).toMatch(/^0x[0-9a-f]{40}$/);
    expect(prehash.message.spender).toMatch(/^0x[0-9a-f]{40}$/);
    expect(prehash.message.witness.reserver).toMatch(/^0x[0-9a-f]{40}$/);
    expect(prehash.message.witness.releaser).toMatch(/^0x[0-9a-f]{40}$/);
    expect(prehash.message.witness.destination).toBe(ORACLE.destination);
  });

  it('keeps the serialized key order and omits an explicit EIP712Domain', () => {
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(Object.keys(prehash)).toEqual(['types', 'primaryType', 'domain', 'message']);
    expect(Object.keys(prehash.domain)).toEqual(['name', 'chainId', 'verifyingContract']);
    expect(Object.keys(prehash.message)).toEqual(['permitted', 'spender', 'nonce', 'deadline', 'witness']);
    expect(prehash.types).toBe(PERMIT_WITNESS_TYPES_WITH_DESTINATION);
    expect('EIP712Domain' in prehash.types).toBe(false);
  });

  it('stringifies numeric fields as decimal strings', () => {
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination(ORACLE);
    expect(prehash.message.nonce).toBe('1776340107514');
    expect(prehash.message.deadline).toBe('1776343707');
    expect(prehash.message.permitted.amount).toBe(ORACLE.amount);
  });

  it('is sensitive to the chain id', () => {
    const base = hashTvmPermitWitnessTransferFrom(createTvmPermitWitnessTransferFromPrehashWithDestination(ORACLE));
    const other = hashTvmPermitWitnessTransferFrom(
      createTvmPermitWitnessTransferFromPrehashWithDestination({ ...ORACLE, chainId: 728126428 }),
    );
    expect(other).not.toBe(base);
  });
});
