/**
 * What a 402's `accepts` entry promises, beyond its field values: that the resource server can
 * reproduce it.
 *
 * The payer echoes the entry it selected back verbatim as `paymentPayload.accepted`. The resource
 * server does not keep it — it rebuilds its requirements from configuration on the next request
 * and asks core which advertised requirement this payment answers. Core's matcher
 * (`findMatchingRequirements` -> `paymentRequirementsMatchAccepted`) compares the core fields for
 * deep equality and then requires the rebuilt `extra` to be a subset of the echoed one, so any
 * field in `extra.atum` that a rebuild cannot reproduce byte-for-byte breaks the match.
 *
 * A field read from a clock is exactly that kind of field. Two builds a few hundred milliseconds
 * apart agree whenever they land in the same wall-clock second and disagree when they straddle a
 * boundary, which makes the failure rare, load-dependent, and impossible to reproduce on demand:
 * a payer that signed a correct payment is told no requirement matches. So the block has to be a
 * pure function of configuration, and the issue time has to come from whoever reads a clock at
 * signing time instead.
 *
 * Driven through the real `@x402/core` resource server, as `enrich-policy.test.ts` is, because the
 * matcher belongs to core: a hand-rolled comparison here would only re-test the test.
 */
import { describe, it, expect } from 'vitest';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { AtumEscrowServerScheme, atumEscrowPrice, type AtumEscrowServerConfig } from './index';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';

const SOLANA_NETWORK = 'solana:localnet';
const RESOURCE = { url: 'https://example.test/paid' } as never;
const ANCHOR = 'pay_order_test_0001';

// The two instants the merchant builds at. They are 250ms apart and straddle a second boundary,
// which is the only interesting case: an advance of a whole multiple of 1000ms leaves the
// truncated second equal, so such a test would pass even against a clock-stamped block and prove
// nothing about reproducibility.
const FIRST_BUILD_MS = Date.parse('2026-07-08T12:00:00.800Z');
const SECOND_BUILD_MS = Date.parse('2026-07-08T12:00:01.050Z');

// A settable cell rather than a self-advancing counter, so each build happens at an instant this
// test names outright and the assertions do not depend on how many times the scheme reads `now`.
let clockMs = FIRST_BUILD_MS;

// A Solana → EVM corridor: base58 source-side escrow/roles, EVM destination, and the svm
// signature-domain fields a Solana source is required to carry.
const config: AtumEscrowServerConfig = {
  destination: {
    network: 'eip155:42161',
    asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    symbol: 'USDC',
    decimals: 6,
  },
  fulfillmentAmount: '10000000',
  markupBps: 300,
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  reserver: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
  releaser: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
  fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
  quoteDeadlineSeconds: 20,
  fulfillmentDeadlineSeconds: 300,
  now: () => clockMs,
  sources: {
    [SOLANA_NETWORK]: {
      asset: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
      escrow: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
      symbol: 'USDC',
      decimals: 6,
      svmSignatureClusterId: 'localnet',
      svmSignatureDomainVersion: 5,
    },
  },
};

const atumOf = (r: PaymentRequirements) => (r.extra as { atum: Record<string, unknown> }).atum;

/**
 * One full 402 build, through core, exactly as a request for the paid resource would produce it.
 * No facilitator client is needed: `createPaymentRequiredResponse` takes pre-built requirements.
 */
async function build(server: x402ResourceServer, scheme: AtumEscrowServerScheme) {
  const priced = await scheme.parsePrice(atumEscrowPrice(config), SOLANA_NETWORK as never);
  const base = await scheme.enhancePaymentRequirements({
    scheme: 'atum-escrow',
    network: SOLANA_NETWORK as never,
    asset: priced.asset,
    amount: priced.amount,
    payTo: '',
    maxTimeoutSeconds: 60,
    extra: {},
  });
  return server.createPaymentRequiredResponse([base], RESOURCE);
}

describe("a rebuilt requirement still matches the payer's echo", () => {
  it('matches an echo built in an earlier wall-clock second', async () => {
    // Guards the premise: if these truncated to the same second the test would be vacuous.
    expect(Math.floor(FIRST_BUILD_MS / 1000)).not.toBe(Math.floor(SECOND_BUILD_MS / 1000));

    const scheme = new AtumEscrowServerScheme(config);
    const server = new x402ResourceServer().register(SOLANA_NETWORK as never, scheme);

    clockMs = FIRST_BUILD_MS;
    const advertised = await build(server, scheme);
    expect(advertised.accepts).toHaveLength(1);

    // The payer echoes the selected accept verbatim. Sent through a JSON round trip because that
    // is what the wire does, and because core's matcher compares by value — object identity here
    // would let a match pass for the wrong reason.
    const payload: PaymentPayload = {
      x402Version: 2,
      payload: {},
      extensions: { [PAYMENT_IDENTIFIER]: { info: { id: ANCHOR } } },
      resource: advertised.resource,
      accepted: JSON.parse(JSON.stringify(advertised.accepts[0])) as PaymentRequirements,
    };

    // A later request rebuilds the requirements from configuration; the merchant kept nothing.
    clockMs = SECOND_BUILD_MS;
    const rebuilt = await build(server, scheme);

    const match = server.findMatchingRequirements(rebuilt.accepts, payload);
    expect(match).toEqual(rebuilt.accepts[0]);
  });

  it('builds a Solana-source extra.atum with no issue time at all', async () => {
    // The issue time is not the merchant's to declare, so the property must be absent rather than
    // present-and-empty: the client reads its presence, and the published `extra` schema is closed.
    // The svm domain fields stay — those are static properties of the source escrow, reproducible
    // by any rebuild, and the client cannot compose the signature domain without them.
    const scheme = new AtumEscrowServerScheme(config);
    const server = new x402ResourceServer().register(SOLANA_NETWORK as never, scheme);

    clockMs = FIRST_BUILD_MS;
    const atum = atumOf((await build(server, scheme)).accepts[0]!);

    expect(atum).not.toHaveProperty('issuedAt');
    expect(atum.svmSignatureClusterId).toBe('localnet');
    expect(atum.svmSignatureDomainVersion).toBe(5);
  });
});
