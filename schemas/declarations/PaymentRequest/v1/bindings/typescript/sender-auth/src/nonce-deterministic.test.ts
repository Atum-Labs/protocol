import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  deterministicPermitNonce,
  deterministicSolanaNonce,
  SOLANA_REPLAY_BUCKETS,
} from './utils.js';
import { solanaAdapter } from './adapters/solana.js';

describe('deterministicPermitNonce (EVM/Tron)', () => {
  const id = { requestId: 'req_A', depositor: '0xAbC0000000000000000000000000000000000001' };

  it('is stable for the same identity (retry-safe)', () => {
    expect(deterministicPermitNonce(id)).toBe(deterministicPermitNonce(id));
  });

  it('differs by request_id and by depositor', () => {
    expect(deterministicPermitNonce(id)).not.toBe(
      deterministicPermitNonce({ ...id, requestId: 'req_B' }),
    );
    expect(deterministicPermitNonce(id)).not.toBe(
      deterministicPermitNonce({ ...id, depositor: '0xdEf' }),
    );
  });

  it('fits a uint256 and requires request_id', () => {
    expect(deterministicPermitNonce(id) < 1n << 256n).toBe(true);
    expect(() => deterministicPermitNonce({ requestId: '', depositor: '0x1' })).toThrow(
      /request_id is required/,
    );
  });
});

describe('deterministicSolanaNonce', () => {
  const id = { requestId: 'req_A', depositor: 'DepositoR1111111111111111111111111111111111' };

  it('is stable and respects the on-chain slot(<235)/bounded-bucket layout', () => {
    const n = deterministicSolanaNonce(id);
    expect(deterministicSolanaNonce(id)).toBe(n);
    const slot = n & 0xffn;
    const bucket = n >> 32n;
    expect(slot < 235n).toBe(true);
    expect(bucket < SOLANA_REPLAY_BUCKETS).toBe(true);
    // Bits 8..31 are unused (matches generateNonce's layout: slot in the low byte, bucket at bit 32).
    expect((n >> 8n) & 0xffffffn).toBe(0n);
  });

  it('differs by request_id', () => {
    expect(deterministicSolanaNonce(id)).not.toBe(
      deterministicSolanaNonce({ ...id, requestId: 'req_B' }),
    );
  });

  it('makes the Solana build deterministic when the derived nonce is supplied', async () => {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const depositor = bs58.encode(kp.publicKey);
    const b58 = (fill: number) => bs58.encode(new Uint8Array(32).fill(fill));
    const defaults = {
      escrowContract: b58(1),
      quoteSelector: b58(2),
      fulfillmentVerifierAccount: b58(3),
      fulfillmentVerifierEndpoint: 'https://verifier.example',
      fulfillmentProxy: b58(4),
      svmSignatureClusterId: 'devnet',
      svmSignatureDomainVersion: 5,
    };
    const requestId = 'req_det_sol';
    const nonce = deterministicSolanaNonce({ requestId, depositor });
    const build = () =>
      solanaAdapter.buildAuthMessage({
        sourceAsset: `solana:mainnet/spl:${b58(9)}`,
        depositor,
        maxSourceAmount: '1000000',
        requestId,
        sourceDefaults: defaults,
        nonce,
        solanaClockReader: async () => 1700000000n,
        destinationAsset:
          'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
        destinationAccount: '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
      });
    const a = await build();
    const b = await build();
    expect(a.messageHash).toBe(b.messageHash); // same identity + nonce → identical deposit
  });
});
