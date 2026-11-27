/**
 * Unit tests for Solana on-chain clock resolution of `issued_at`.
 *
 * The escrow rejects a deposit whose issued_at is ahead of the cluster clock
 * (Escrow_FutureTransaction). These cover the RPC mapping, the sysvar parse, and
 * the best-effort resolution with its wall-clock fallback. No network is hit:
 * the reader is injected.
 */

import {
  DEFAULT_SOLANA_RPC_URLS,
  SOLANA_CLOCK_READ_GUARD_SECS,
  SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS,
  readClockUnixTimeFromBase64,
  readClusterUnixTime,
  resolveSolanaIssuedAt,
  resolveSolanaRpcUrl,
} from './solana-clock';
import type { Logger } from '@atum-labs/turnkey-signer';

describe('resolveSolanaRpcUrl', () => {
  it('prefers the explicit override', () => {
    expect(resolveSolanaRpcUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'http://my-rpc')).toBe(
      'http://my-rpc',
    );
  });

  it('maps mainnet / devnet / testnet references to their public endpoints', () => {
    expect(resolveSolanaRpcUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(
      DEFAULT_SOLANA_RPC_URLS['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
    );
    expect(resolveSolanaRpcUrl('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1')).toBe(
      DEFAULT_SOLANA_RPC_URLS['EtWTRABZaYq6iMfeYKouRu166VU2xqa1'],
    );
    expect(resolveSolanaRpcUrl('solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z')).toBe(
      DEFAULT_SOLANA_RPC_URLS['4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z'],
    );
  });

  it('returns undefined for an unknown cluster with no override', () => {
    expect(resolveSolanaRpcUrl('solana:localnetXXXXXXXXXXXXXXXXXXXXXXXX')).toBeUndefined();
  });

  // Guards against the CLI help / docs regressing to the non-canonical
  // solana:mainnet alias, which would silently drop to the wall-clock fallback.
  it('resolves the canonical genesis-hash id shown in the CLI docs, not the mainnet alias', () => {
    expect(resolveSolanaRpcUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe(
      'https://api.mainnet-beta.solana.com',
    );
    expect(resolveSolanaRpcUrl('solana:mainnet')).toBeUndefined();
  });
});

describe('readClockUnixTimeFromBase64', () => {
  it('parses the i64 unix_timestamp at byte offset 32', () => {
    const buf = Buffer.alloc(40);
    buf.writeBigInt64LE(1_800_000_000n, 32);
    expect(readClockUnixTimeFromBase64(buf.toString('base64'))).toBe(1_800_000_000n);
  });

  it('throws on truncated sysvar data', () => {
    expect(() => readClockUnixTimeFromBase64(Buffer.alloc(20).toString('base64'))).toThrow(
      /too short/,
    );
  });
});

describe('resolveSolanaIssuedAt', () => {
  const chainId = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

  it('uses the on-chain clock minus the read guard when the read succeeds', async () => {
    const reader = jest.fn(async () => 1_800_000_000n);
    const issuedAt = await resolveSolanaIssuedAt({ sourceChainId: chainId, reader });
    expect(issuedAt).toBe(1_800_000_000n - SOLANA_CLOCK_READ_GUARD_SECS);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('falls back to wall clock minus the skew buffer when the read fails', async () => {
    const reader = jest.fn(async () => {
      throw new Error('rpc down');
    });
    const before = BigInt(Math.floor(Date.now() / 1000)) - SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS;
    const issuedAt = await resolveSolanaIssuedAt({ sourceChainId: chainId, reader });
    const after = BigInt(Math.floor(Date.now() / 1000)) - SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS;
    expect(issuedAt).toBeGreaterThanOrEqual(before);
    expect(issuedAt).toBeLessThanOrEqual(after);
  });

  it('falls back without calling the reader when no RPC resolves', async () => {
    const reader = jest.fn(async () => 1_800_000_000n);
    const before = BigInt(Math.floor(Date.now() / 1000)) - SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS;
    const issuedAt = await resolveSolanaIssuedAt({
      sourceChainId: 'solana:unknownXXXXXXXXXXXXXXXXXXXXXX',
      reader,
    });
    const after = BigInt(Math.floor(Date.now() / 1000)) - SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS;
    expect(reader).not.toHaveBeenCalled();
    expect(issuedAt).toBeGreaterThanOrEqual(before);
    expect(issuedAt).toBeLessThanOrEqual(after);
  });

  it('reads through an override RPC even for an unmapped cluster', async () => {
    const reader = jest.fn(async () => 1_700_000_500n);
    const issuedAt = await resolveSolanaIssuedAt({
      sourceChainId: 'solana:unknownXXXXXXXXXXXXXXXXXXXXXX',
      rpcUrlOverride: 'http://my-rpc',
      reader,
    });
    expect(issuedAt).toBe(1_700_000_500n - SOLANA_CLOCK_READ_GUARD_SECS);
    expect(reader).toHaveBeenCalledWith('http://my-rpc', expect.any(Number));
  });

  it('warns through the logger when the read fails and falls back', async () => {
    const warn = jest.fn();
    const reader = jest.fn(async () => {
      throw new Error('boom');
    });
    await resolveSolanaIssuedAt({
      sourceChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      reader,
      logger: { warn } as unknown as Logger,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatch(/falling back to wall clock/);
  });
});

describe('readClusterUnixTime (fetch reader)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const clockResponse = (unixTime: bigint) => {
    const buf = Buffer.alloc(40);
    buf.writeBigInt64LE(unixTime, 32);
    return { result: { value: { data: [buf.toString('base64'), 'base64'] } } };
  };

  it('parses a well-formed Clock sysvar response to the unix timestamp', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => clockResponse(1_800_000_000n),
    })) as unknown as typeof fetch;
    await expect(readClusterUnixTime('http://rpc', 2000)).resolves.toBe(1_800_000_000n);
  });

  it('throws on a non-200 response', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(readClusterUnixTime('http://rpc', 2000)).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the response has no account data', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ result: { value: null } }),
    })) as unknown as typeof fetch;
    await expect(readClusterUnixTime('http://rpc', 2000)).rejects.toThrow(/missing/);
  });
});
