import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pubkey } from './pubkey';
import { computeReserveHash } from './reserve-encoder';
import type { EscrowDomain } from './escrow-domain';

// Cross-side parity for the SVM reserve hash against the Go-authored, FROZEN
// vectors (the sibling Go package's reserve_parity_test.go writes &
// asserts the same file). The anchored vectors are independently pinned to the
// Rust on-chain compute_reserve_hash, so a bug shared by Go and TS is still
// caught. Frozen and committed — not regenerated in CI — so a TS-encoder
// regression turns this red.

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(
  __dirname,
  '../../../../conformance/vectors.json',
);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface ReserveVector {
  name: string;
  version: number;
  clusterId: string;
  programId: string;
  recipient: string;
  depositHash: string;
  expectedHash: string;
}

const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  reserve: ReserveVector[];
};

describe('SVM cross-side parity (frozen, Rust-anchored vectors)', () => {
  it('has a non-empty frozen vector set', () => {
    expect(vectors.reserve.length).toBeGreaterThan(0);
  });

  it.each(vectors.reserve)('reserve hash matches Go/Rust: $name', (v) => {
    const domain: EscrowDomain = {
      clusterId: hexToBytes(v.clusterId),
      signatureDomainVersion: v.version,
      programId: Pubkey.fromHex(v.programId),
    };
    const got = computeReserveHash(
      {
        depositHash: hexToBytes(v.depositHash),
        recipient: Pubkey.fromHex(v.recipient),
      },
      domain,
    );
    const gotHex = '0x' + Array.from(got).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(gotHex.toLowerCase()).toBe(v.expectedHash.toLowerCase());
  });
});
