import nacl from 'tweetnacl';
import { Pubkey } from '@atum-labs/stellar-escrow-encoding';
import { getChainAdapter, namespaceForTurnkeyAddressFormat } from './index';
import { stellarAdapter } from './stellar';
import {
  DEFAULT_STELLAR_RPC_URLS,
  STELLAR_ISSUED_AT_FALLBACK_SKEW_SECS,
  readLatestLedgerCloseTime,
  resolveStellarIssuedAt,
  resolveStellarRpcUrl,
} from './stellar-clock';

const HEX_KEY = '11'.repeat(32);
const ADDRESS = Pubkey.fromBytes(
  nacl.sign.keyPair.fromSeed(Uint8Array.from(Buffer.from(HEX_KEY, 'hex'))).publicKey,
).toString();

describe('stellar chain adapter', () => {
  it('is registered under the stellar namespace, case-insensitively', () => {
    expect(getChainAdapter('stellar:testnet')).toBe(stellarAdapter);
    expect(getChainAdapter('STELLAR:testnet')).toBe(stellarAdapter);
  });

  it('claims no Turnkey address format until one is confirmed', () => {
    expect(stellarAdapter.turnkeyAddressFormat).toBeUndefined();
    // Neither a plausible guess nor the empty string is mapped to stellar.
    for (const guess of ['ADDRESS_FORMAT_STELLAR', 'ADDRESS_FORMAT_XLM', '']) {
      expect(namespaceForTurnkeyAddressFormat(guess)).toBeUndefined();
    }
  });

  it('formats the key by dropping a 0x prefix', () => {
    expect(stellarAdapter.formatPrivateKey('0x' + HEX_KEY)).toBe(HEX_KEY);
    expect(stellarAdapter.formatPrivateKey(HEX_KEY)).toBe(HEX_KEY);
  });

  it('rejects a malformed key without echoing it', () => {
    for (const bad of [
      '',
      'zz'.repeat(32),
      '11'.repeat(31),
      'S' + 'A'.repeat(55),
      '11'.repeat(33),
    ]) {
      let message = '';
      try {
        stellarAdapter.validatePrivateKey!(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe('Invalid private key');
    }
    expect(() => stellarAdapter.validatePrivateKey!('0x' + HEX_KEY)).not.toThrow();
  });

  it('checks that a pinned sender is the key the signer holds', () => {
    expect(() => stellarAdapter.verifyAddressMatchesKey!(HEX_KEY, ADDRESS)).not.toThrow();
    expect(() => stellarAdapter.verifyAddressMatchesKey!('0x' + HEX_KEY, ADDRESS)).not.toThrow();
    const other = Pubkey.fromBytes(new Uint8Array(32).fill(7)).toString();
    expect(() => stellarAdapter.verifyAddressMatchesKey!(HEX_KEY, other)).toThrow(
      /does not match the sender address/,
    );
  });

  it('applies no contract-field override', () => {
    expect(stellarAdapter.resolveContractOverrides).toBeUndefined();
  });
});

describe('stellar issued_at', () => {
  it('has a default RPC for the test network only', () => {
    expect(resolveStellarRpcUrl('stellar:testnet')).toBe(DEFAULT_STELLAR_RPC_URLS['testnet']);
    expect(resolveStellarRpcUrl('stellar:pubnet')).toBeUndefined();
    expect(resolveStellarRpcUrl('stellar:pubnet', 'https://rpc.example')).toBe(
      'https://rpc.example',
    );
  });

  it('uses the ledger close time exactly, with no guard, since ledger time never moves back', async () => {
    const seen: string[] = [];
    const issuedAt = await resolveStellarIssuedAt({
      sourceChainId: 'stellar:standalone',
      rpcUrlOverride: 'http://localhost:8000/rpc',
      reader: async (url) => {
        seen.push(url);
        return 1793114064n;
      },
    });
    expect(issuedAt).toBe(1793114064n);
    expect(seen).toEqual(['http://localhost:8000/rpc']);
  });

  it('falls back to the back-dated local clock when no RPC resolves', async () => {
    const reader = jest.fn();
    const before = BigInt(Math.floor(Date.now() / 1000));
    const issuedAt = await resolveStellarIssuedAt({ sourceChainId: 'stellar:pubnet', reader });
    expect(reader).not.toHaveBeenCalled();
    expect(issuedAt).toBeLessThanOrEqual(before - STELLAR_ISSUED_AT_FALLBACK_SKEW_SECS + 2n);
    expect(issuedAt).toBeGreaterThan(before - STELLAR_ISSUED_AT_FALLBACK_SKEW_SECS - 5n);
  });

  it('falls back when the read fails', async () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const issuedAt = await resolveStellarIssuedAt({
      sourceChainId: 'stellar:testnet',
      reader: async () => {
        throw new Error('rpc down');
      },
    });
    expect(issuedAt).toBeLessThan(before);
  });

  describe('the default reader', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });
    const answer = (body: unknown, ok = true) => {
      globalThis.fetch = (async () => ({
        ok,
        status: ok ? 200 : 503,
        json: async () => body,
      })) as unknown as typeof fetch;
    };

    it('reads closeTime from getLatestLedger', async () => {
      answer({ result: { closeTime: '1793114064' } });
      await expect(readLatestLedgerCloseTime('http://rpc.invalid', 1000)).resolves.toBe(
        1793114064n,
      );
    });

    it.each([
      ['an HTTP error', { result: { closeTime: '1' } }, false],
      ['no closeTime', { result: {} }, true],
      ['a zero closeTime', { result: { closeTime: '0' } }, true],
    ])('refuses %s', async (_name, body, ok) => {
      answer(body, ok);
      await expect(readLatestLedgerCloseTime('http://rpc.invalid', 1000)).rejects.toThrow();
    });
  });
});
