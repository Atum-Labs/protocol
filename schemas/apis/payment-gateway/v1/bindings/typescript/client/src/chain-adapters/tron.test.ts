import { tronAdapter } from './tron';
import { normalizeAddress } from '../sender_auth_schemes/tron';
import type { ChainDefaults } from './types';

// Real base58 (base58check) Tron addresses — normalizeAddress validates the
// checksum, so these must be genuine. (Reused from tron.ts's Permit2 fallbacks.)
const TRON_QUOTE_SELECTOR = 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp';
const TRON_VERIFIER_ACCOUNT = 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';

const tronDefaults: ChainDefaults = {
  escrowContract: TRON_QUOTE_SELECTOR,
  fulfillmentProxy: TRON_QUOTE_SELECTOR,
  quoteSelector: TRON_QUOTE_SELECTOR,
  fulfillmentVerifierAccount: TRON_VERIFIER_ACCOUNT,
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  permit2Contract: TRON_QUOTE_SELECTOR,
};

describe('tronAdapter.resolveContractOverrides', () => {
  it('normalizes base58 quote_selector + fulfillment_verifier.account to canonical hex', () => {
    const overrides = tronAdapter.resolveContractOverrides?.(tronDefaults);

    expect(overrides).toBeDefined();
    expect(overrides!.quote_selector).toBe(normalizeAddress(TRON_QUOTE_SELECTOR));
    expect(overrides!.quote_selector).toMatch(/^0x[0-9a-f]{40}$/);
    expect(overrides!.fulfillment_verifier).toEqual({
      account: normalizeAddress(TRON_VERIFIER_ACCOUNT),
      endpoint: 'https://verifier.example',
    });
  });

  // The whole point of #1: both send-payment (preparePaymentRequest) and
  // request-quote (prepareQuoteRequest) resolve the body's contract fields
  // through this ONE method, so a base58 default becomes the identical
  // canonical-hex value on both paths — no divergence.
  it('rewrites base58 → hex (so the quote path matches the signed payment path)', () => {
    const overrides = tronAdapter.resolveContractOverrides?.(tronDefaults);

    expect(overrides!.quote_selector).not.toBe(TRON_QUOTE_SELECTOR); // actually rewritten
    expect(overrides!.quote_selector!.startsWith('0x')).toBe(true);
    expect(overrides!.fulfillment_verifier!.account.startsWith('0x')).toBe(true);
  });
});
