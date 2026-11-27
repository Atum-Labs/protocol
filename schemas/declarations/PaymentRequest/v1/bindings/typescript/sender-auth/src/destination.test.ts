import { describe, it, expect } from 'vitest';
import { toUtf8Bytes } from 'ethers';

import {
  buildEscrowDestination,
  deriveDepositRequestHash,
  MAX_DESTINATION_BYTES,
} from './destination.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read the vectors from the shared conformance directory rather than a copy, so this suite and
// the Go suite are pinned to the same bytes. `__dirname`, not import.meta.url: the package builds
// to CommonJS, where tsc rejects import.meta.
const VECTORS_PATH = resolve(__dirname, '../../../../conformance/destination-vectors.json');

interface DestinationVector {
  asset: string;
  account: string;
  want?: string;
  wantErr: boolean;
}
interface HashVector {
  requestId: string;
  want?: string;
  wantErr: boolean;
}
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  maxDestinationBytes: number;
  destinations: DestinationVector[];
  depositRequestHashes: HashVector[];
};

/**
 * The shared vectors, asserted by this suite and the Go one. If a case fails, reconcile the
 * implementations against the vector; do not edit the expectation to match the code.
 */
describe('destination commitments match the Go implementation byte-for-byte', () => {
  it('agrees with Go on MAX_DESTINATION_BYTES', () => {
    expect(MAX_DESTINATION_BYTES).toBe(vectors.maxDestinationBytes);
  });

  describe('buildEscrowDestination', () => {
    for (const c of vectors.destinations) {
      const label = `${JSON.stringify(c.asset)} + ${JSON.stringify(c.account)}`;
      if (c.wantErr) {
        it(`rejects ${label} exactly as Go does`, () => {
          expect(() => buildEscrowDestination(c.asset, c.account)).toThrow();
        });
      } else {
        it(`composes ${label} identically to Go`, () => {
          expect(buildEscrowDestination(c.asset, c.account)).toBe(c.want);
        });
      }
    }
  });

  describe('deriveDepositRequestHash', () => {
    for (const c of vectors.depositRequestHashes) {
      if (c.wantErr) {
        it(`rejects request_id ${JSON.stringify(c.requestId)} exactly as Go does`, () => {
          expect(() => deriveDepositRequestHash(c.requestId)).toThrow();
        });
      } else {
        it(`hashes request_id ${JSON.stringify(c.requestId)} identically to Go`, () => {
          expect(deriveDepositRequestHash(c.requestId)).toBe(c.want);
        });
      }
    }
  });
});

describe('the deprecated Solana asset form is rejected with a migration hint', () => {
  // The `<chain>:<ref>:<asset>` form is the malformed identifier a caller is most likely to
  // produce, and other guards reject malformed shapes too, so assert the migration hint rather
  // than merely an error.
  it('names the deprecated form and the CAIP-19 shape to migrate to', () => {
    expect(() => buildEscrowDestination('solana:ref:mint', 'acct')).toThrow(
      /deprecated `<chain>:<ref>:<asset>` form/,
    );
  });

  it('does not offer that hint for an identifier that is merely malformed', () => {
    expect(() => buildEscrowDestination('eip155:1/erc20', '0xabc')).not.toThrow(/deprecated/);
  });
});

describe('a non-canonical asset namespace is rejected, not normalised', () => {
  // The asset namespace half of the same rule: "token" and "Token" would hash to two different
  // destinations for one payee. Assert the specific message, since the shared fixture's wantErr
  // rows check only for an error.
  for (const asset of [
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/Token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/TOKEN:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    'tron:0x2b6653dc/TRC20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    // eip155 is held to the rule too, although its branch lowercases the whole side, so the
    // grammar has one policy for both halves.
    'eip155:8453/ERC20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ]) {
    it(`rejects ${JSON.stringify(asset)}`, () => {
      expect(() =>
        buildEscrowDestination(asset, '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4'),
      ).toThrow(/non-canonical asset namespace/);
    });
  }

  // The over-rejection counterpart: the gate must not touch the asset reference, which is
  // case-significant base58.
  it('still composes a canonical lowercase asset namespace and preserves the mint', () => {
    const mint = 'A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo';
    const got = buildEscrowDestination(
      `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:${mint}`,
      '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4',
    );
    expect(got).toContain(`/token:${mint}`);
  });
});

describe('a non-canonical chain namespace is rejected, not normalised', () => {
  // A non-canonical chain namespace is rejected, never signed as written. Assert the specific
  // error: other guards reject malformed shapes too.
  for (const asset of [
    'EIP155:42220/erc20:0xabc',
    'Eip155:42220/erc20:0xabc',
    'SOLANA:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    'Solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo',
    'Tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  ]) {
    it(`rejects ${JSON.stringify(asset)}`, () => {
      expect(() => buildEscrowDestination(asset, '0xabc')).toThrow(/non-canonical chain namespace/);
    });
  }

  // The guard must not over-reject: eip155 still lowercases its hex (not EIP-55).
  it('still composes a canonical lowercase eip155 destination', () => {
    expect(
      buildEscrowDestination(
        'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
      ),
    ).toBe(
      'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@' +
        '0xc0ffee254729296a45a3885639ac7e10f9d54979',
    );
  });

  // Why non-canonical input is rejected rather than normalised: a Solana destination carries
  // three case-significant base58 segments (the chain reference, the SPL mint and the account),
  // and lowercasing would corrupt all three.
  it('preserves every base58 segment of a Solana destination byte-for-byte', () => {
    const genesisRef = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    const mint = 'A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo';
    const account = '7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4';

    const built = buildEscrowDestination(`solana:${genesisRef}/token:${mint}`, account);

    expect(built).toBe(`solana:${genesisRef}/token:${mint}@${account}`);
    // Asserted individually so a failure names WHICH segment was re-cased.
    expect(built).toContain(genesisRef);
    expect(built).toContain(mint);
    expect(built).toContain(account);
  });
});

describe('destination bounds', () => {
  // Solidity measures bytes(destination).length, and the destination is printable ASCII, so one
  // character is one byte.
  const prefix = 'eip155:1/erc20:0xab@';

  it('accepts a destination that is exactly at the byte cap', () => {
    const built = buildEscrowDestination(
      'eip155:1/erc20:0xab',
      'a'.repeat(MAX_DESTINATION_BYTES - prefix.length),
    );
    expect(toUtf8Bytes(built).length).toBe(MAX_DESTINATION_BYTES);
  });

  it('refuses a destination one byte over the cap', () => {
    expect(() =>
      buildEscrowDestination(
        'eip155:1/erc20:0xab',
        'a'.repeat(MAX_DESTINATION_BYTES - prefix.length + 1),
      ),
    ).toThrow(/256/);
  });

  it('refuses a multibyte character before measuring', () => {
    expect(() => buildEscrowDestination('eip155:1/erc20:0xab', '\u00e9'.repeat(10))).toThrow(
      /printable ASCII/,
    );
  });
});
