import { describe, it, expect } from 'vitest';
import { deriveEntries } from '../src/entries.mjs';

// Entry files are derived from the manifest, so the set the stamper and the guard
// operate on always matches what the package actually advertises.
describe('deriveEntries', () => {
  it('derives main + every bin target (payment-gateway-client shape)', () => {
    expect(
      deriveEntries({
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
        bin: {
          'send-payment': './dist/cli/send-payment.js',
          'request-quote': './dist/cli/request-quote.js',
          'quote-status': './dist/cli/quote-status.js',
          'payment-status': './dist/cli/payment-status.js',
        },
      }),
    ).toEqual([
      'cli/payment-status.js',
      'cli/quote-status.js',
      'cli/request-quote.js',
      'cli/send-payment.js',
      'index.js',
    ]);
  });

  it('derives main + every exports subpath (mppx-atum-escrow shape)', () => {
    expect(
      deriveEntries({
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './client': { types: './dist/client.d.ts', default: './dist/client.js' },
          './server': { types: './dist/server.d.ts', default: './dist/server.js' },
        },
      }),
    ).toEqual(['client.js', 'index.js', 'server.js']);
  });

  // x402-atum-escrow shape: role-separated, so there is deliberately no root entry —
  // importing the package name must not pull the facilitator into a payer's bundle.
  it('derives entries from subpath exports alone, with no main (x402-atum-escrow shape)', () => {
    expect(
      deriveEntries({
        exports: {
          './client': { types: './dist/client.d.ts', default: './dist/client.js' },
          './server': { types: './dist/server.d.ts', default: './dist/server.js' },
          './facilitator': { types: './dist/facilitator.d.ts', default: './dist/facilitator.js' },
          './fetch': { types: './dist/fetch.d.ts', default: './dist/fetch.js' },
        },
      }),
    ).toEqual(['client.js', 'facilitator.js', 'fetch.js', 'server.js']);
  });

  it('picks up a newly added bin automatically', () => {
    const before = deriveEntries({ main: 'dist/index.js', bin: { a: './dist/cli/a.js' } });
    const after = deriveEntries({
      main: 'dist/index.js',
      bin: { a: './dist/cli/a.js', b: './dist/cli/b.js' },
    });
    expect(before).not.toContain('cli/b.js');
    expect(after).toContain('cli/b.js');
  });

  it('ignores .d.ts targets — the header belongs on shipped runtime entries', () => {
    const entries = deriveEntries({
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    });
    expect(entries).toEqual(['index.js']);
    expect(entries.some((e) => e.endsWith('.d.ts'))).toBe(false);
  });

  it('deduplicates a target reachable through both main and exports', () => {
    expect(
      deriveEntries({
        main: 'dist/index.js',
        exports: { '.': './dist/index.js' },
      }),
    ).toEqual(['index.js']);
  });

  it('normalizes ./dist/, dist/ and bare forms to the same dist-relative path', () => {
    expect(deriveEntries({ bin: { a: './dist/x.js', b: 'dist/y.js' } })).toEqual(['x.js', 'y.js']);
  });

  it('returns a stable order regardless of manifest key ordering', () => {
    const a = deriveEntries({ bin: { z: './dist/z.js', a: './dist/a.js' } });
    const b = deriveEntries({ bin: { a: './dist/a.js', z: './dist/z.js' } });
    expect(a).toEqual(b);
  });

  it('yields nothing for a manifest that advertises no runtime entrypoint', () => {
    expect(deriveEntries({ types: 'dist/index.d.ts' })).toEqual([]);
  });
});
