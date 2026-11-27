import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deriveDirectDeposit, DirectDepositError } from './direct-deposit.js';

// The Go-generated vectors (senderauth/direct_deposit_vectors_test.go), so the two derivations are
// pinned to the same bytes. The "known answer" row is the contract's own vector.
const VECTORS_PATH = resolve(
  __dirname,
  '../../../../conformance/direct-deposit-derivation-vectors.json',
);

interface Golden {
  name: string;
  request: string;
  chainId: string;
  escrow: string;
  version: 1 | 2;
  depositId: string;
  token: string;
  amount: string;
  nonce: string;
  depositRequestHash: string;
  destination: string;
  reserver: string;
  releaser: string;
  unreservedHash: string;
}
interface Refused {
  name: string;
  request: string;
  chainId: string;
  escrow: string;
  version: number;
  reason: string;
}
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  golden: Golden[];
  refused: Refused[];
};

describe('deriveDirectDeposit matches the Go derivation', () => {
  it('has golden and refused vectors', () => {
    expect(vectors.golden.length).toBeGreaterThan(0);
    expect(vectors.refused.length).toBeGreaterThan(0);
  });

  it.each(vectors.golden.map((v) => [v.name, v] as const))('derives %s', (_name, v) => {
    const got = deriveDirectDeposit(v.request, BigInt(v.chainId), v.escrow, v.version);
    expect(got.depositId).toBe(v.depositId);
    expect(got.input.token).toBe(v.token);
    expect(got.input.amount.toString()).toBe(v.amount);
    expect(got.input.nonce.toString()).toBe(v.nonce);
    expect(got.input.depositWitness).toEqual({
      depositRequestHash: v.depositRequestHash,
      destination: v.destination,
      reserver: v.reserver,
      releaser: v.releaser,
    });
    expect(got.unreservedHash).toBe(v.unreservedHash);
  });

  it.each(vectors.refused.map((v) => [v.name, v] as const))('refuses %s', (_name, v) => {
    let thrown: unknown;
    try {
      deriveDirectDeposit(v.request, BigInt(v.chainId), v.escrow, v.version as 1 | 2);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DirectDepositError);
    expect((thrown as DirectDepositError).reason).toBe(v.reason);
  });
});
