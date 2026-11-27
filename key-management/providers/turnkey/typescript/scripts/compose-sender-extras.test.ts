import { describe, expect, it } from 'vitest';

import { buildEscrowDestination } from '@atum-labs/payment-request-sender-auth';

import { composeSenderExtras } from './sender-config';

// The seam these tests exist for: the operator writes two CAIP components, and the ONLY thing that
// turns them into the string a policy compares is buildEscrowDestination. If this ever grows a
// second formatter, the policy stops matching what the payer signs and every payment on that chain
// is denied with no error anywhere.
//
// This imports `sender-config`, not `apply-policies`: the latter runs `main()` on import and exits
// the process on any error, which aborts the whole test run rather than failing one file.
describe('composeSenderExtras', () => {
  const cfg = (allowedDestinations: unknown) =>
    ({
      type: 'sender',
      chains: { Base: { kind: 'evm', chainId: 'eip155:8453' } },
      senderExtras: { network: 'mainnet', allowedTokens: {}, escrows: {}, allowedDestinations },
    }) as never;

  it('joins each pair through the shared composer', () => {
    const asset = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const account = '0xc0ffee254729296a45a3885639ac7e10f9d54979';
    const out = composeSenderExtras(cfg({ Base: [{ asset, account }] }));
    expect(out.allowedDestinations.Base).toEqual([buildEscrowDestination(asset, account)]);
  });

  it('applies the per-segment casing rule instead of folding the whole string', () => {
    // eip155 hex folds to lowercase...
    const evm = composeSenderExtras(
      cfg({
        Base: [
          {
            asset: 'eip155:8453/erc20:0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913',
            account: '0xC0FFEE254729296a45a3885639AC7E10F9d54979',
          },
        ],
      }),
    ).allowedDestinations.Base![0]!;
    expect(evm).toBe(evm.toLowerCase());

    // ...while every base58 segment of a Solana destination keeps its exact case. Folding this
    // one would corrupt the chain reference, the mint and the account at once.
    const sol = composeSenderExtras(
      cfg({
        Base: [
          {
            asset:
              'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            account: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
          },
        ],
      }),
    ).allowedDestinations.Base![0]!;
    expect(sol).toContain('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(sol).toContain('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  });

  it('refuses a pre-composed string, which is how the casing rule gets got wrong by hand', () => {
    expect(() =>
      composeSenderExtras(cfg({ Base: ['eip155:8453/erc20:0x8335@0xc0ffee'] })),
    ).toThrow(/must be \{ asset, account \}/);
    expect(() => composeSenderExtras(cfg({ Base: [{ asset: 'eip155:8453/erc20:0x8335' }] }))).toThrow(
      /must be \{ asset, account \}/,
    );
  });

  it('names the chain and index in the error, so a bad entry is findable in a long config', () => {
    const ok = {
      asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      account: '0xc0ffee254729296a45a3885639ac7e10f9d54979',
    };
    // Wrong shape.
    expect(() => composeSenderExtras(cfg({ Polygon: [ok, { asset: 'c' }] }))).toThrow(
      /allowedDestinations\["Polygon"\]\[1\]/,
    );
    // Right shape, invalid CAIP-19. The builder's own message says nothing about which entry it
    // came from, so the position has to be attached here or the operator hunts for it by hand.
    expect(() =>
      composeSenderExtras(cfg({ Polygon: [ok, { asset: 'not-caip19', account: '0xabc' }] })),
    ).toThrow(/allowedDestinations\["Polygon"\]\[1\] is not a valid destination/);
  });

  it('leaves a config with no destinations alone rather than inventing an empty map entry', () => {
    expect(composeSenderExtras(cfg(undefined)).allowedDestinations).toEqual({});
  });
});
