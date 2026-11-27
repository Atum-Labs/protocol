import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TypedDataEncoder } from 'ethers';
import { computePaymentId } from './payment-id';
import { maskChainId } from './chain-id';

// Contract-published Escrow TIP-712 domain separator for the Shasta-deployed
// Escrow (TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py == 0x2e9fbe…b9fc, chainId 2494104990).
// Source: encoding-examples.json#domainSeparators.escrow from the TVM escrow
// contract project, produced by the contract's own Foundry suite — NOT by this encoder.
// Asserting our domain construction reproduces it proves we hash the same domain
// the contract does (incl. the 20-byte verifyingContract form), so the anchor is
// tied to the contract rather than circularly to our own output.
const SHASTA_ESCROW = '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc';
const SHASTA_CHAIN_ID = 2494104990;
const CONTRACT_ESCROW_DOMAIN_SEPARATOR =
  '0x43cd45f97265fa0fc229571347a828eb18224cf3c1020e12017f491e9a50e3a0';

// Cross-side parity: the TS deposit id and its refusals reproduce the committed vectors the Go
// encoder is pinned to (../../go/encoding/reserve_parity_test.go asserts the same file).

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(
  __dirname,
  '../../../../conformance/vectors.json',
);

interface PaymentIdVector {
  name: string;
  depositor: string;
  signature: string;
  nonce: string;
  expectedPaymentId: string;
}

interface RejectVector {
  name: string;
  depositor: string;
  reason: string;
}

const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  paymentId: PaymentIdVector[];
  rejectPaymentId: RejectVector[];
};

describe('TVM cross-side parity (committed vectors)', () => {
  it('has a non-empty vector set', () => {
    expect(vectors.paymentId.length).toBeGreaterThan(0);
  });

  it('reproduces the contract-published Escrow domain separator (anchor is not circular)', () => {
    const domain = {
      name: 'Escrow',
      version: '3',
      chainId: maskChainId(SHASTA_CHAIN_ID),
      verifyingContract: SHASTA_ESCROW,
    };
    expect(TypedDataEncoder.hashDomain(domain).toLowerCase()).toBe(
      CONTRACT_ESCROW_DOMAIN_SEPARATOR,
    );
  });

  it.each(vectors.paymentId)('deposit id matches Go (Tron normalization): $name', (v) => {
    const id = computePaymentId(v.depositor, v.signature, v.nonce);
    expect(id.toLowerCase()).toBe(v.expectedPaymentId.toLowerCase());
  });

  // Every depositor the Go encoder refuses, the TS encoder refuses too.
  it.each(vectors.rejectPaymentId)('rejects what Go rejects: $name', (v) => {
    expect(() => computePaymentId(v.depositor, '0x', '1')).toThrow();
  });
});
