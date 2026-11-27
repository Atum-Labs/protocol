/**
 * Inputs the payer must refuse before they reach any comparison or the signer.
 *
 * The role and markup checks are only as sound as the values they compare. Three inputs can
 * slip past them if taken at face value:
 *
 * - `extra.fulfillmentAmount` is a merchant-supplied string. `BigInt` accepts far more than plain
 *   decimal (hex, binary, octal, surrounding whitespace, the empty string), so a lenient parse
 *   lets a merchant state one amount to a human reader and have the bound evaluate another. Only
 *   the canonical `^[0-9]+$` form is accepted.
 * - A trust resolver is third-party code and may resolve with something that is not a roles
 *   object. That is an unavailable trust source, not "no constraints", and it must never be
 *   papered over with another chain's roles.
 * - A chain in a namespace the package cannot sign for must be refused before the trust source
 *   is consulted: asking about it leaks the payer's intent and wastes a lookup on a payment that
 *   can never be built.
 *
 * Every refusal also asserts that the signer was never called: the signature is the irreversible
 * step.
 */
import { describe, it, expect, vi } from 'vitest';
import { AtumEscrowTrustError, type TrustResolver, type TrustedRoles } from './client.js';
import type { AtumEscrowChallenge } from './index.js';
import {
  corridor,
  challenge,
  fixtureTrustTable,
  attemptAgainst,
  failure,
  priced,
  withExtra,
} from './test-helpers.js';

const BASE = corridor.sources[0]!.network;
const ARBITRUM = corridor.destination.network;
const UNSUPPORTED = 'cosmos:cosmoshub-4';

// Every challenge here pays from the EVM fixture payer, so the signer is pinned to the Base
// chain even when the challenge names a chain the package cannot sign for.
const attempt = attemptAgainst(fixtureTrustTable, { signAs: BASE });

describe('createCredential — canonical fulfillmentAmount', () => {
  // Each `amount` is chosen so that, were the price parsed leniently by `BigInt`, the deposit
  // would sit within the default markup bound: a refusal can then only come from the format check.
  it.each([
    { label: 'hex', fulfillmentAmount: '0xffffffffffff', amount: '1000000000000' },
    { label: 'binary', fulfillmentAmount: '0b1111', amount: '15' },
    { label: 'octal', fulfillmentAmount: '0o17', amount: '15' },
    { label: 'surrounding whitespace', fulfillmentAmount: ' 10000000 ', amount: '10000000' },
    { label: 'empty', fulfillmentAmount: '', amount: '0' },
    { label: 'decimal fraction', fulfillmentAmount: '10000000.5', amount: '10000000' },
    { label: 'negative', fulfillmentAmount: '-1', amount: '10000000' },
    { label: 'exponent', fulfillmentAmount: '1e7', amount: '10000000' },
  ])('refuses a $label fulfillmentAmount ($fulfillmentAmount), without signing', async (c) => {
    const { result, sign } = attempt(
      priced({ amount: c.amount, fulfillmentAmount: c.fulfillmentAmount }),
    );
    const err = await failure(result);

    expect(err).toBeInstanceOf(Error);
    // A malformed price is a bad request, not a trust verdict; a trust error here would mean
    // the markup bound evaluated a leniently parsed value instead of the format check refusing.
    expect(err).not.toBeInstanceOf(AtumEscrowTrustError);
    expect((err as Error).message.startsWith('atum-escrow: ')).toBe(true);
    expect((err as Error).message).toMatch(/fulfillmentAmount/);
    expect(sign).not.toHaveBeenCalled();
  });

  it('accepts a plain decimal with leading zeros and signs it', async () => {
    // `^[0-9]+$` admits leading zeros; the value is still unambiguous decimal.
    const { result, sign } = attempt(
      priced({ amount: '10300000', fulfillmentAmount: '010000000' }),
    );

    await expect(result).resolves.toBeTypeOf('string');
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('createCredential — a trust resolver answering a non-object', () => {
  const nonObjects: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'a string', value: 'trusted' },
    { label: 'a number', value: 42 },
  ];

  it.each(nonObjects)(
    'refuses TRUST_SOURCE_UNAVAILABLE for the source chain when it answers $label, without signing',
    async ({ value }) => {
      const trust = vi.fn<TrustResolver>(async (network: string) => {
        if (network === BASE) return value as TrustedRoles;
        return fixtureTrustTable[network]!;
      });
      const { result, sign } = attempt(challenge, { trust });
      const err = await failure(result);

      expect(err).toBeInstanceOf(AtumEscrowTrustError);
      expect((err as AtumEscrowTrustError).code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect((err as AtumEscrowTrustError).network).toBe(BASE);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it.each(nonObjects)(
    'refuses TRUST_SOURCE_UNAVAILABLE for the destination chain when it answers $label, never falling back to the source roles',
    async ({ value }) => {
      // The challenge is built so the SOURCE chain's roles would make it payable: its proxy is the
      // source chain's trusted proxy and its destination asset is a source-listed token. Only a
      // client that refuses the missing destination answer, rather than reusing the source
      // chain's, refuses it.
      const sourceRoles = fixtureTrustTable[BASE]!;
      const chg = withExtra(challenge, {
        fulfillmentProxy: sourceRoles.fulfillmentProxy,
        destination: {
          ...challenge.request.extra.destination,
          asset: sourceRoles.tokens[0]!.address,
        },
      });
      const trust = vi.fn<TrustResolver>(async (network: string) => {
        if (network === ARBITRUM) return value as TrustedRoles;
        return fixtureTrustTable[network]!;
      });
      const { result, sign } = attempt(chg, { trust });
      const err = await failure(result);

      expect(err).toBeInstanceOf(AtumEscrowTrustError);
      expect((err as AtumEscrowTrustError).code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect((err as AtumEscrowTrustError).network).toBe(ARBITRUM);
      expect(sign).not.toHaveBeenCalled();
    },
  );
});

describe('createCredential — an unsupported chain is refused before any trust lookup', () => {
  // The resolver vouches for every chain, the unsupported one included, so nothing but the
  // client's own namespace check can stop the payment before the lookup happens.
  const permissiveTrust = () =>
    vi.fn<TrustResolver>(
      async (network: string) => fixtureTrustTable[network] ?? fixtureTrustTable[BASE]!,
    );

  it('refuses an unsupported source chain without consulting the trust source or signing', async () => {
    const chg = {
      ...challenge,
      request: {
        ...challenge.request,
        source: { ...challenge.request.source, network: UNSUPPORTED },
      },
    } as AtumEscrowChallenge;
    const trust = permissiveTrust();
    const { result, sign } = attempt(chg, { trust });
    const err = await failure(result);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AtumEscrowTrustError);
    expect(trust).toHaveBeenCalledTimes(0);
    expect(sign).not.toHaveBeenCalled();
  });

  it('refuses an unsupported destination chain without consulting the trust source or signing', async () => {
    const chg = withExtra(challenge, {
      destination: { ...challenge.request.extra.destination, network: UNSUPPORTED },
    });
    const trust = permissiveTrust();
    const { result, sign } = attempt(chg, { trust });
    const err = await failure(result);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AtumEscrowTrustError);
    expect(trust).toHaveBeenCalledTimes(0);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('createCredential — a trust error from another copy of the package', () => {
  /**
   * Each published Atum package bundles its own copy of the trust error class, so a resolver taken
   * from a sibling package rejects with an error that is not `instanceof` this package's class. It
   * is recognised by its `name` and a known `code`; this local class stands in for that copy.
   */
  class ForeignTrustError extends Error {
    readonly code: string;
    readonly network: string;
    field?: string;
    expected?: string;
    actual?: string;
    constructor(code: string, network: string) {
      super('foreign: ' + code);
      this.name = 'AtumEscrowTrustError';
      this.code = code;
      this.network = network;
    }
  }

  function rejectingFor(network: string, error: unknown) {
    return vi.fn<TrustResolver>(async (n: string) => {
      if (n === network) throw error;
      return fixtureTrustTable[n]!;
    });
  }

  it('is not a subclass of the package error, so the client cannot rely on instanceof', () => {
    expect(new ForeignTrustError('CHAIN_NOT_TRUSTED', BASE)).not.toBeInstanceOf(
      AtumEscrowTrustError,
    );
  });

  it.each([
    { label: 'source', network: BASE },
    { label: 'destination', network: ARBITRUM },
  ])(
    'keeps a foreign CHAIN_NOT_TRUSTED for the $label chain rather than reporting the source unavailable, without signing',
    async ({ network }) => {
      const foreign = new ForeignTrustError('CHAIN_NOT_TRUSTED', network);
      const { result, sign } = attempt(challenge, { trust: rejectingFor(network, foreign) });
      const err = await failure(result);

      expect(err).toBeInstanceOf(AtumEscrowTrustError);
      expect((err as AtumEscrowTrustError).code).toBe('CHAIN_NOT_TRUSTED');
      expect((err as AtumEscrowTrustError).network).toBe(network);
      expect((err as Error).cause).toBe(foreign);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it('keeps the field, expected and actual values of a foreign UNTRUSTED_ESCROW, without signing', async () => {
    const foreign = new ForeignTrustError('UNTRUSTED_ESCROW', BASE);
    foreign.field = 'escrowContract';
    foreign.expected = '0x1111111111111111111111111111111111111111';
    foreign.actual = '0x2222222222222222222222222222222222222222';
    const { result, sign } = attempt(challenge, { trust: rejectingFor(BASE, foreign) });
    const err = await failure(result);

    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    const trustErr = err as AtumEscrowTrustError;
    expect(trustErr.code).toBe('UNTRUSTED_ESCROW');
    expect(trustErr.network).toBe(BASE);
    expect(trustErr.field).toBe('escrowContract');
    expect(trustErr.expected).toBe('0x1111111111111111111111111111111111111111');
    expect(trustErr.actual).toBe('0x2222222222222222222222222222222222222222');
    expect(trustErr.cause).toBe(foreign);
    expect(sign).not.toHaveBeenCalled();
  });

  it('reports the chain that was looked up, not the network the foreign error names', async () => {
    // A sibling resolver's error is third-party data; the chain the client asked about is the
    // only network it can vouch for.
    const foreign = new ForeignTrustError('CHAIN_NOT_TRUSTED', 'eip155:1');
    const { result, sign } = attempt(challenge, { trust: rejectingFor(BASE, foreign) });
    const err = await failure(result);

    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as AtumEscrowTrustError).code).toBe('CHAIN_NOT_TRUSTED');
    expect((err as AtumEscrowTrustError).network).toBe(BASE);
    expect(sign).not.toHaveBeenCalled();
  });

  it('keeps a foreign message that already carries the package prefix, without doubling it', async () => {
    const foreign = new ForeignTrustError('CHAIN_NOT_TRUSTED', BASE);
    foreign.message = 'atum-escrow: no trusted gateway serves eip155:8453';
    const { result } = attempt(challenge, { trust: rejectingFor(BASE, foreign) });
    const err = await failure(result);

    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as Error).message).toBe('atum-escrow: no trusted gateway serves eip155:8453');
  });

  it('prefixes a foreign message that lacks the package prefix', async () => {
    const foreign = new ForeignTrustError('CHAIN_NOT_TRUSTED', BASE);
    const { result } = attempt(challenge, { trust: rejectingFor(BASE, foreign) });
    const err = await failure(result);

    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as Error).message).toBe('atum-escrow: foreign: CHAIN_NOT_TRUSTED');
  });

  it('still raises the package trust error when the foreign message is not a string, without signing', async () => {
    // `message` is an ordinary writable property on third-party errors; a non-string there must
    // not turn a trust verdict into a raw TypeError from string handling.
    const foreign = new ForeignTrustError('CHAIN_NOT_TRUSTED', BASE);
    foreign.message = 42 as unknown as string;
    const { result, sign } = attempt(challenge, { trust: rejectingFor(BASE, foreign) });
    const err = await failure(result);

    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as AtumEscrowTrustError).code).toBe('CHAIN_NOT_TRUSTED');
    expect((err as AtumEscrowTrustError).network).toBe(BASE);
    expect((err as Error).message).toBeTypeOf('string');
    expect((err as Error).message.startsWith('atum-escrow:')).toBe(true);
    expect(sign).not.toHaveBeenCalled();
  });

  // A name alone, a code alone, or neither must not let an arbitrary rejection choose the verdict:
  // anything short of a recognisable trust error means the trust source could not answer.
  const unrecognised: ReadonlyArray<{ label: string; make: () => unknown }> = [
    {
      label: 'the trust error name with an unknown code',
      make: () => new ForeignTrustError('SOMETHING_ELSE', BASE),
    },
    { label: 'a plain Error', make: () => new Error('resolver blew up') },
    {
      label: 'a plain Error carrying a valid code but not the trust error name',
      make: () => Object.assign(new Error('not a trust error'), { code: 'CHAIN_NOT_TRUSTED' }),
    },
  ];

  it.each(unrecognised)(
    'reports TRUST_SOURCE_UNAVAILABLE for $label, without signing',
    async ({ make }) => {
      const original = make();
      const { result, sign } = attempt(challenge, { trust: rejectingFor(BASE, original) });
      const err = await failure(result);

      expect(err).toBeInstanceOf(AtumEscrowTrustError);
      expect((err as AtumEscrowTrustError).code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect((err as AtumEscrowTrustError).network).toBe(BASE);
      expect((err as Error).cause).toBe(original);
      expect(sign).not.toHaveBeenCalled();
    },
  );
});

describe('createCredential — a trust resolver answering a malformed roles object', () => {
  type Mutate = (roles: Record<string, unknown>) => unknown;
  const withToken =
    (patch: (token: Record<string, unknown>) => Record<string, unknown>): Mutate =>
    (roles) => ({
      ...roles,
      tokens: (roles.tokens as ReadonlyArray<Record<string, unknown>>).map(patch),
    });
  const without =
    (key: string): Mutate =>
    (roles) => {
      const copy = { ...roles };
      delete copy[key];
      return copy;
    };

  const malformed: ReadonlyArray<{ label: string; mutate: Mutate }> = [
    { label: 'tokens missing', mutate: without('tokens') },
    { label: 'tokens an object', mutate: (r) => ({ ...r, tokens: {} }) },
    { label: 'tokens a string', mutate: (r) => ({ ...r, tokens: 'USDC' }) },
    {
      label: 'a token missing its symbol',
      mutate: withToken(({ symbol: _symbol, ...rest }) => rest),
    },
    { label: 'a token with an empty address', mutate: withToken((t) => ({ ...t, address: '' })) },
    {
      label: 'a token with fractional decimals',
      mutate: withToken((t) => ({ ...t, decimals: 1.5 })),
    },
    { label: 'a token with negative decimals', mutate: withToken((t) => ({ ...t, decimals: -1 })) },
    { label: 'a token with decimals above 77', mutate: withToken((t) => ({ ...t, decimals: 78 })) },
    {
      label: 'a token with string decimals',
      mutate: withToken((t) => ({ ...t, decimals: '6' })),
    },
    { label: 'escrowContract missing', mutate: without('escrowContract') },
    { label: 'escrowContract empty', mutate: (r) => ({ ...r, escrowContract: '' }) },
    { label: 'escrowContract a number', mutate: (r) => ({ ...r, escrowContract: 42 }) },
    // Every role is shape-checked, not only the escrow: a check on one field alone would let a
    // blank reserver, releaser or proxy through as an empty-string "trusted" address.
    { label: 'quoteSelector empty', mutate: (r) => ({ ...r, quoteSelector: '' }) },
    {
      label: 'fulfillmentVerifierAccount empty',
      mutate: (r) => ({ ...r, fulfillmentVerifierAccount: '' }),
    },
    { label: 'fulfillmentProxy empty', mutate: (r) => ({ ...r, fulfillmentProxy: '' }) },
    { label: 'an array', mutate: () => [] },
  ];

  /** Answer every chain from the fixture table except `network`, whose answer is mutated. */
  function malformedFor(network: string, mutate: Mutate) {
    return vi.fn<TrustResolver>(async (n: string) => {
      const roles = fixtureTrustTable[n]!;
      if (n !== network) return roles;
      return mutate({ ...roles } as unknown as Record<string, unknown>) as TrustedRoles;
    });
  }

  it.each(malformed)(
    'refuses TRUST_SOURCE_UNAVAILABLE for the source chain when it answers with $label, without signing',
    async ({ mutate }) => {
      const { result, sign } = attempt(challenge, { trust: malformedFor(BASE, mutate) });
      const err = await failure(result);

      expect(err).toBeInstanceOf(AtumEscrowTrustError);
      expect((err as AtumEscrowTrustError).code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect((err as AtumEscrowTrustError).network).toBe(BASE);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  it.each(malformed)(
    'refuses TRUST_SOURCE_UNAVAILABLE for the destination chain when it answers with $label, without signing',
    async ({ mutate }) => {
      // The source chain's answer is well-formed, so only the destination answer is at fault.
      const { result, sign } = attempt(challenge, { trust: malformedFor(ARBITRUM, mutate) });
      const err = await failure(result);

      expect(err).toBeInstanceOf(AtumEscrowTrustError);
      expect((err as AtumEscrowTrustError).code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect((err as AtumEscrowTrustError).network).toBe(ARBITRUM);
      expect(sign).not.toHaveBeenCalled();
    },
  );

  // An empty token list is a valid answer that vouches for no token: the trust source did answer,
  // so the refusal is about the asset, not about the source being unavailable.
  it.each([
    { label: 'source', network: BASE },
    { label: 'destination', network: ARBITRUM },
  ])(
    'refuses UNTRUSTED_ASSET, not TRUST_SOURCE_UNAVAILABLE, when the $label chain vouches for no token',
    async ({ network }) => {
      const trust = malformedFor(network, (r) => ({ ...r, tokens: [] }));
      const { result, sign } = attempt(challenge, { trust });
      const err = await failure(result);

      expect(err).toBeInstanceOf(AtumEscrowTrustError);
      expect((err as AtumEscrowTrustError).code).toBe('UNTRUSTED_ASSET');
      expect((err as AtumEscrowTrustError).network).toBe(network);
      expect(sign).not.toHaveBeenCalled();
    },
  );
});
