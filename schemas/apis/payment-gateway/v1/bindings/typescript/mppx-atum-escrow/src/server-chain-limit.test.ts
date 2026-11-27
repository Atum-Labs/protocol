// Per-chain amount ceilings: an EVM or Tron token amount is a uint256 and a Solana token amount is
// a u64, so a price or cap past the chain's largest amount can never be deposited or filled. The
// merchant hears it when building the charge rather than from a payment that cannot settle.
// Expected values are computed here from the stated rule with BigInt, not read from the code.

import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import {
  buildChargeRequest,
  buildChargeChallenge,
  AtumEscrowConfigError,
  type AtumEscrowConfigErrorCode,
  type AtumEscrowCorridor,
  type AtumEscrowSource,
} from './server.js';

const UINT256_MAX = 2n ** 256n - 1n;
const U64_MAX = 2n ** 64n - 1n;

const EVM_SOURCE_NETWORK = 'eip155:8453';
const EVM_DEST_NETWORK = 'eip155:42161';
const TRON_NETWORK = 'tron:mainnet';
const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const COSMOS_NETWORK = 'cosmos:cosmoshub-4';

const EVM_SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EVM_DEST_ASSET = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const TRON_ASSET = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const COSMOS_ASSET = 'ibc/F663521BF1836B00F5F177680F74BFB9A8B5654A694D0D2BC249E03CF2509013';

/** A distinct, non-zero base58 32-byte value. */
const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));

type Family = 'evm' | 'tron' | 'solana' | 'cosmos';

/** A source on `family` whose one asset is `symbol` with `decimals`. */
function sourceOn(family: Family, symbol: string, decimals: number): AtumEscrowSource {
  const verifier = { fulfillmentVerifierEndpoint: 'https://verifier.example.com' };
  switch (family) {
    case 'evm':
      return {
        network: EVM_SOURCE_NETWORK,
        assets: [{ address: EVM_SOURCE_ASSET, symbol, decimals }],
        escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
        reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        ...verifier,
      };
    case 'tron':
      return {
        network: TRON_NETWORK,
        assets: [{ address: TRON_ASSET, symbol, decimals }],
        escrow: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
        reserver: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
        releaser: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
        ...verifier,
      };
    case 'solana':
      return {
        network: SOLANA_NETWORK,
        assets: [{ address: SOLANA_MINT, symbol, decimals }],
        escrow: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        reserver: b58(3),
        releaser: b58(4),
        svmSignatureClusterId: 'mainnet',
        svmSignatureDomainVersion: 5,
        ...verifier,
      };
    case 'cosmos':
      return {
        network: COSMOS_NETWORK,
        assets: [{ address: COSMOS_ASSET, symbol, decimals }],
        escrow: 'cosmos1escrow',
        reserver: 'cosmos1reserver',
        releaser: 'cosmos1releaser',
        ...verifier,
      };
  }
}

const EVM_DEST = {
  network: EVM_DEST_NETWORK,
  asset: EVM_DEST_ASSET,
  account: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
};
const SOLANA_DEST = { network: SOLANA_NETWORK, asset: SOLANA_MINT, account: b58(5) };

function corridorOf(opts: {
  source: AtumEscrowSource;
  destination?: { network: string; asset: string; account: string };
  destDecimals: number;
  markupBps?: number;
}): AtumEscrowCorridor {
  return {
    destination: { ...(opts.destination ?? EVM_DEST), symbol: 'USDC', decimals: opts.destDecimals },
    fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    markupBps: opts.markupBps ?? 0,
    quoteDeadlineSeconds: 20,
    // Inside the Solana replay window, so a Solana source is refused only by the rule under test.
    fulfillmentDeadlineSeconds: 100,
    sources: [opts.source],
  };
}

const selectOf = (c: AtumEscrowCorridor) => ({
  network: c.sources[0]!.network,
  asset: c.sources[0]!.assets[0]!.address,
});

const charge = (c: AtumEscrowCorridor, f: bigint) =>
  buildChargeRequest(c, selectOf(c), f.toString());

/** floor(F × (10000 + bps) × 10^s / (10000 × 10^d)). */
function formulaCap(f: bigint, bps: number, s: number, d: number): bigint {
  return (f * (10000n + BigInt(bps)) * 10n ** BigInt(s)) / (10000n * 10n ** BigInt(d));
}

/** Run `fn`, require a typed config error with `code`, and hand it back. */
function configError(fn: () => unknown, code: AtumEscrowConfigErrorCode): AtumEscrowConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected a config error, but nothing was thrown').toBeDefined();
  expect(caught).toBeInstanceOf(AtumEscrowConfigError);
  expect(caught).toBeInstanceOf(Error);
  const err = caught as AtumEscrowConfigError;
  expect(err.code).toBe(code);
  return err;
}

/**
 * Destination 0 decimals, source 1 decimal, no markup: the cap is 10F, so it reaches a uint256
 * ceiling long before the price does, and having more source decimals keeps the cap at or above
 * the price.
 */
const TEN_X = { destDecimals: 0, sourceDecimals: 1 } as const;
const largestTenXUnder = (ceiling: bigint) => ceiling / 10n;

describe.each<[string, Family, string]>([
  ['EVM', 'evm', EVM_SOURCE_NETWORK],
  ['Tron', 'tron', TRON_NETWORK],
])('buildChargeRequest — %s source uint256 ceiling', (_label, family, network) => {
  const c = corridorOf({
    source: sourceOn(family, 'USDT', TEN_X.sourceDecimals),
    destDecimals: TEN_X.destDecimals,
  });
  const atLimit = largestTenXUnder(UINT256_MAX);

  it('derives a price whose cap is at most the ceiling and the next whose cap is over it', () => {
    expect(formulaCap(atLimit, 0, 1, 0)).toBeLessThanOrEqual(UINT256_MAX);
    expect(formulaCap(atLimit + 1n, 0, 1, 0)).toBeGreaterThan(UINT256_MAX);
  });

  it('accepts the largest price whose cap fits a uint256', () => {
    expect(charge(c, atLimit).source.amount).toBe(formulaCap(atLimit, 0, 1, 0).toString());
  });

  it('refuses the next price, naming the source network', () => {
    const err = configError(() => charge(c, atLimit + 1n), 'AMOUNT_EXCEEDS_CHAIN_LIMIT');
    expect(err.network).toBe(network);
    expect(err.message).toContain(network);
  });

  it('accepts a cap above the u64 range, so the ceiling is not Solana’s', () => {
    const f = 2n ** 64n;
    expect(formulaCap(f, 0, 1, 0)).toBeGreaterThan(U64_MAX);
    expect(charge(c, f).source.amount).toBe(formulaCap(f, 0, 1, 0).toString());
  });
});

describe('buildChargeRequest — Solana source u64 ceiling', () => {
  // Equal decimals and no markup, so the cap is the price itself.
  const solana = corridorOf({ source: sourceOn('solana', 'USDC', 6), destDecimals: 6 });
  const evm = corridorOf({ source: sourceOn('evm', 'USDC', 6), destDecimals: 6 });

  it('accepts a cap of exactly 2^64 − 1', () => {
    expect(charge(solana, U64_MAX).source.amount).toBe('18446744073709551615');
  });

  it('refuses a cap of 2^64, naming the Solana source', () => {
    const err = configError(() => charge(solana, U64_MAX + 1n), 'AMOUNT_EXCEEDS_CHAIN_LIMIT');
    expect(err.network).toBe(SOLANA_NETWORK);
    expect(err.message).toContain(SOLANA_NETWORK);
  });

  it('accepts the same 2^64 cap on an EVM source', () => {
    expect(charge(evm, U64_MAX + 1n).source.amount).toBe((U64_MAX + 1n).toString());
  });
});

describe('buildChargeRequest — destination ceiling', () => {
  const evmToEvm = corridorOf({ source: sourceOn('evm', 'USDC', 6), destDecimals: 6 });

  it('refuses an EVM price of 2^256, naming the destination before any source check', () => {
    const err = configError(() => charge(evmToEvm, UINT256_MAX + 1n), 'AMOUNT_EXCEEDS_CHAIN_LIMIT');
    expect(err.network).toBe(EVM_DEST_NETWORK);
    expect(err.message).toContain('fulfillmentAmount');
  });

  it('accepts an EVM price of exactly 2^256 − 1', () => {
    expect(charge(evmToEvm, UINT256_MAX).source.amount).toBe(UINT256_MAX.toString());
  });

  const toSolana = corridorOf({
    source: sourceOn('evm', 'USDC', 6),
    destination: SOLANA_DEST,
    destDecimals: 6,
  });

  it('refuses a price of 2^64 on a Solana destination, naming it', () => {
    const err = configError(() => charge(toSolana, U64_MAX + 1n), 'AMOUNT_EXCEEDS_CHAIN_LIMIT');
    expect(err.network).toBe(SOLANA_NETWORK);
    expect(err.message).toContain('fulfillmentAmount');
  });

  it('accepts a price of exactly 2^64 − 1 on a Solana destination', () => {
    expect(charge(toSolana, U64_MAX).source.amount).toBe(U64_MAX.toString());
  });
});

describe('buildChargeRequest — Tron destination ceiling', () => {
  const toTron = corridorOf({
    source: sourceOn('evm', 'USDC', 6),
    destination: {
      network: TRON_NETWORK,
      asset: TRON_ASSET,
      account: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S',
    },
    destDecimals: 6,
  });

  it('refuses a price of 2^256 on a Tron destination, naming it', () => {
    const err = configError(() => charge(toTron, UINT256_MAX + 1n), 'AMOUNT_EXCEEDS_CHAIN_LIMIT');
    expect(err.network).toBe(TRON_NETWORK);
  });

  it('accepts a price of 2^64 on a Tron destination, so its ceiling is not Solana’s', () => {
    expect(charge(toTron, U64_MAX + 1n).source.amount).toBe((U64_MAX + 1n).toString());
  });
});

describe('buildChargeRequest — chain ceiling before cap-below-price', () => {
  it('reports a cap that is both over the source ceiling and below the price as over the ceiling', () => {
    // Source 0 decimals, destination 6, no markup: cap = floor(F / 10^6).
    const c = corridorOf({ source: sourceOn('solana', 'USDC', 0), destDecimals: 6 });
    const f = 2n ** 64n * 10n ** 6n + 1n;
    const cap = formulaCap(f, 0, 0, 6);
    // Discriminators: both refusals apply, so only their order decides the code.
    expect(cap).toBe(2n ** 64n);
    expect(cap).toBeGreaterThan(U64_MAX);
    expect(cap * 10n ** 6n).toBeLessThan(f);
    const err = configError(() => charge(c, f), 'AMOUNT_EXCEEDS_CHAIN_LIMIT');
    expect(err.network).toBe(SOLANA_NETWORK);
  });
});

describe('buildChargeRequest — a family with no known ceiling', () => {
  it('does not apply a ceiling to a namespace it does not know', () => {
    const c = corridorOf({
      source: sourceOn('cosmos', 'USDT', TEN_X.sourceDecimals),
      destDecimals: TEN_X.destDecimals,
    });
    const f = largestTenXUnder(UINT256_MAX) + 1n;
    const cap = formulaCap(f, 0, 1, 0);
    expect(cap).toBeGreaterThan(UINT256_MAX);
    expect(charge(c, f).source.amount).toBe(cap.toString());
  });
});

describe('buildChargeRequest — ordinary charges are unaffected', () => {
  it('keeps a 6/6 EVM charge at 300 bps', () => {
    const c = corridorOf({ source: sourceOn('evm', 'USDT', 6), destDecimals: 6, markupBps: 300 });
    expect(charge(c, 10_000_000n).source.amount).toBe('10300000');
  });
});

describe('buildChargeChallenge — inherits the chain ceilings', () => {
  it('refuses a Solana cap of 2^64', () => {
    const c = corridorOf({ source: sourceOn('solana', 'USDC', 6), destDecimals: 6 });
    const err = configError(
      () =>
        buildChargeChallenge(c, selectOf(c), (U64_MAX + 1n).toString(), { intentId: 'order-1' }),
      'AMOUNT_EXCEEDS_CHAIN_LIMIT',
    );
    expect(err.network).toBe(SOLANA_NETWORK);
  });
});
