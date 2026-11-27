import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// From the package entry point, so these tests also hold the export in place.
import { verifyReserveAuth } from './index.js';
import type { ReserveAuth, ReserveAuthExpectations, ReserveAuthResult } from './index.js';
import { fakeChecker } from './test-helpers.js';
import type { CheckerCall, FakeChain } from './test-helpers.js';

// The shared vectors both languages assert. See the fixture's _comment for how they were made.
const CONFORMANCE = resolve(__dirname, '../../../../conformance');
const DIRECT_DEPOSIT = resolve(
  __dirname,
  '../../../../../../../../contracts/evm/conformance/direct-deposit-vectors.json',
);

interface Vector {
  name: string;
  input: { auth: ReserveAuth; expected: ReserveAuthExpectations };
  offline?: boolean;
  chain?: FakeChain;
  result: ReserveAuthResult;
  calls: CheckerCall[];
}

const vectors = (
  JSON.parse(readFileSync(resolve(CONFORMANCE, 'reserve-auth-vectors.json'), 'utf8')) as {
    vectors: Vector[];
  }
).vectors;
const signatureMaxLength = (
  JSON.parse(readFileSync(resolve(CONFORMANCE, 'depositor-signature-vectors.json'), 'utf8')) as {
    signatureMaxLength: number;
  }
).signatureMaxLength;

// Mirrors the Go TestReserveAuthVectors.
describe('reserve-auth vectors', () => {
  let ran = 0;

  it('carries vectors with unique names', () => {
    expect(vectors.length).toBeGreaterThan(0);
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
  });

  for (const v of vectors) {
    it(v.name, async () => {
      ran++;
      const fake = fakeChecker(v.chain);
      const got = await verifyReserveAuth(
        v.input.auth,
        v.input.expected,
        v.offline === true ? undefined : fake,
      );
      // Go and TypeScript must return the same result.
      expect(got).toEqual(v.result);
      expect(fake.calls).toEqual(v.calls);
    });
  }

  it('ran every vector', () => {
    expect(ran).toBe(vectors.length);
  });
});

// The EVM anchor is the reserve the Foundry test runs through the real escrow. Mirrors the Go
// TestReserveAuthEVMAnchorIsTheContractBoundVector.
it('anchors the EVM vector to the contract-bound reserve signature', () => {
  const dd = JSON.parse(readFileSync(DIRECT_DEPOSIT, 'utf8')) as {
    chainID: number;
    escrow: string;
    depositId: string;
    reserve: { quoteHash: string; settler: string; sourceAmount: string; reserveSignature: string };
  };
  const v = vectors.find((x) => x.name === 'evm-eoa-verified')!;
  expect(v.input.expected.network).toBe(`eip155:${dd.chainID}`);
  expect(v.input.expected.escrowContract.toLowerCase()).toBe(dd.escrow.toLowerCase());
  expect(v.input.expected.depositId).toBe(dd.depositId);
  expect(v.input.expected.quoteHash).toBe(dd.reserve.quoteHash);
  expect(v.input.expected.settler.toLowerCase()).toBe(dd.reserve.settler.toLowerCase());
  expect(v.input.expected.sourceAmount).toBe(dd.reserve.sourceAmount);
  expect(v.input.auth.signature).toBe(dd.reserve.reserveSignature);
});

// The Solana vectors sign the frozen V5 reserve anchor that the encoders and the program pin
// (v5-source-amount.test.ts). Mirrors the Go TestReserveAuthSolanaAnchorIsTheFrozenV5Hash.
it('anchors the Solana vectors to the frozen V5 reserve hash', () => {
  const v = vectors.find((x) => x.name === 'solana-verified')!;
  expect(v.input.auth.message).toBe(
    '0xd9f194eb2cdbbb060453ee08633a736adbbdb5efd7bf680de0997b18b145daf4',
  );
});

// The two length cases the fixture leaves to the suites. Mirrors the Go
// TestReserveAuthSignatureLengthBound.
describe('the signature length bound', () => {
  const base = vectors.find((v) => v.name === 'evm-contract-magic-verified')!;
  const atBound = '0x' + 'ab'.repeat((signatureMaxLength - 2) / 2);

  it('passes a signature exactly at the bound through whole', async () => {
    const fake = fakeChecker(base.chain);
    const got = await verifyReserveAuth(
      { ...base.input.auth, signature: atBound },
      base.input.expected,
      fake,
    );
    expect(got.reason).toBe('verified');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.signature).toBe(atBound);
  });

  it('refuses a signature a byte over the bound before any chain read', async () => {
    const fake = fakeChecker(base.chain);
    const got = await verifyReserveAuth(
      { ...base.input.auth, signature: atBound + 'ab' },
      base.input.expected,
      fake,
    );
    expect(got).toEqual({
      valid: false,
      path: 'none',
      reason: 'malformed',
      detail: 'the signature is longer than 65536 characters',
    });
    expect(fake.calls).toEqual([]);
  });
});
