import { describe, it, expect } from 'vitest';
import { Address } from '@atum-labs/stellar-escrow-encoding';
import { STELLAR_DEFAULT_VALIDITY_SECS, stellarAdapter } from './adapters/stellar.js';
import type { BuildAuthMessageParams } from './types.js';

const fill = (byte: number) => new Uint8Array(32).fill(byte);
const account = (byte: number) => Address.account(fill(byte)).toString();
const contract = (byte: number) => Address.contract(fill(byte)).toString();

const U64_MAX = (1n << 64n) - 1n;
const VALIDITY = BigInt(STELLAR_DEFAULT_VALIDITY_SECS);

const params = (issuedAt: bigint, deadline?: bigint): BuildAuthMessageParams => ({
  sourceAsset: `stellar:testnet/sep41:${contract(0xe1)}`,
  depositor: account(0xd1),
  maxSourceAmount: '1000000',
  requestId: 'req_issued_at_range',
  destinationAsset: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  destinationAccount: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
  sourceDefaults: {
    escrowContract: contract(0xc0),
    quoteSelector: account(0x55),
    fulfillmentVerifierAccount: account(0x66),
    fulfillmentVerifierEndpoint: 'https://verifier.example',
    fulfillmentProxy: contract(0xf1),
  },
  nonce: 1n,
  issuedAt,
  deadline,
  delegateEpoch: 1n,
});

// The default deadline is issued_at + 3600. bigint does not wrap, so an issued_at within 3600 of
// 2^64-1 gives a deadline above u64, which the strict record reader refuses before the payer signs.
// Pins the Go builder's ErrStellarIssuedAtOverflow outcome: both languages refuse, neither signs.
describe('stellar buildAuthMessage default deadline near the u64 limit', () => {
  it.each([U64_MAX, U64_MAX - VALIDITY + 2n, U64_MAX - VALIDITY + 1n])(
    'refuses issued_at %s',
    async (issuedAt) => {
      await expect(stellarAdapter.buildAuthMessage(params(issuedAt))).rejects.toThrow(
        'deadline exceeds u64',
      );
    },
  );

  it('builds the largest issued_at whose default deadline fits', async () => {
    const built = await stellarAdapter.buildAuthMessage(params(U64_MAX - VALIDITY));
    expect(built.messagePrehash).toContain(`"deadline":"${U64_MAX}"`);
  });

  it('builds a large issued_at with an explicit deadline', async () => {
    await expect(
      stellarAdapter.buildAuthMessage(params(U64_MAX - 100n, U64_MAX - 50n)),
    ).resolves.toBeDefined();
  });
});
