// buildAuthMessage from the assembled request, asserted against the build rows the Go SDK generates
// (conformance/commitment-v2-vectors.json). Mirrors producer_v2_test.go.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getChainAdapter } from './adapters/index.js';
import { depositAmount } from './build-commitments.js';
import { CommitmentError, emptyResult } from './commitment-rules.js';
import type { CommitmentResult } from './commitment-rules.js';
import type { AuthMessageResult, BuildAuthMessageParams, ChainDefaults } from './types.js';

const VECTORS = resolve(__dirname, '../../../../conformance/commitment-v2-vectors.json');

interface BuildCase {
  name: string;
  params: {
    sourceAsset: string;
    depositor: string;
    maxSourceAmount: string;
    quoteSourceAmount?: string;
    requestId?: string;
    sourceDefaults: ChainDefaults;
    destinationAsset?: string;
    destinationAccount?: string;
    deadline?: string;
    nonce?: string;
    solanaClock?: number;
    paymentRequestJSON?: string;
    depositRequestHashVersion?: number;
  };
  result?: AuthMessageResult;
  refusal?: Partial<CommitmentResult>;
  error?: string;
}

const { build } = JSON.parse(readFileSync(VECTORS, 'utf8')) as { build: BuildCase[] };

/** The Go row's inputs as buildAuthMessage params. */
function paramsOf(c: BuildCase): BuildAuthMessageParams {
  const { deadline, solanaClock, depositRequestHashVersion, ...rest } = c.params;
  return {
    ...rest,
    ...(deadline !== undefined && { deadline: BigInt(deadline) }),
    ...(solanaClock !== undefined && { solanaClockReader: async () => BigInt(solanaClock) }),
    ...(depositRequestHashVersion !== undefined && {
      depositRequestHashVersion: depositRequestHashVersion as 1 | 2,
    }),
  } as BuildAuthMessageParams;
}

async function assertBuild(c: BuildCase) {
  const network = c.params.sourceAsset.split('/')[0]!;
  const built = getChainAdapter(network).buildAuthMessage(paramsOf(c));
  if (c.result !== undefined) {
    // The digest is what the payer signs. The prehash is not compared byte for byte: Go and
    // TypeScript serialize the same EIP-712 typed data with different key order and empty fields.
    const { messageScheme, messageHash } = await built;
    expect({ messageScheme, messageHash }).toEqual({
      messageScheme: c.result.messageScheme,
      messageHash: c.result.messageHash,
    });
  } else if (c.refusal !== undefined) {
    const e = await built.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(CommitmentError);
    expect((e as CommitmentError).result).toEqual({ ...emptyResult(), ...c.refusal });
  } else {
    await expect(built).rejects.toThrow(c.error!);
  }
}

function rows(variant: string) {
  const picked = build.filter((c) => c.name.endsWith(`/${variant}`));
  expect(picked.length).toBe(3);
  return picked.map((c) => [c.name, c] as const);
}

describe('buildAuthMessage from the deprecated params is as before v2', () => {
  it.each(rows('deprecated-params'))('%s', (_name, c) => assertBuild(c));
});

describe('buildAuthMessage from the assembled request signs v1 by default', () => {
  it.each([...rows('request'), ...rows('request-v1'), ...rows('request-only-v1')])('%s', (_n, c) =>
    assertBuild(c),
  );
});

describe('buildAuthMessage from the assembled request signs v2 when asked', () => {
  it.each([...rows('request-v2'), ...rows('request-only-v2')])('%s', (_n, c) => assertBuild(c));
});

describe('buildAuthMessage refuses a version it cannot commit', () => {
  it.each([...rows('v2-without-request'), ...rows('version-3')])('%s', (_n, c) => assertBuild(c));
});

describe('buildAuthMessage refuses deprecated params the request contradicts', () => {
  it.each([...rows('request-id-contradicts'), ...rows('destination-contradicts')])('%s', (_n, c) =>
    assertBuild(c),
  );
});

describe('buildAuthMessage refuses permit params the request contradicts', () => {
  it.each([
    ...rows('source-asset-contradicts'),
    ...rows('depositor-contradicts'),
    ...rows('max-source-amount-contradicts'),
    ...rows('escrow-contradicts'),
    ...rows('reserver-contradicts'),
    ...rows('releaser-contradicts'),
  ])('%s', (_n, c) => assertBuild(c));
});

describe('buildAuthMessage compares permit params by value, not spelling', () => {
  it.each(rows('max-source-amount-leading-zero'))('%s', (_n, c) => assertBuild(c));
});

describe('buildAuthMessage refuses a request the strict reader refuses', () => {
  it.each(rows('strict-refusal'))('%s', (_n, c) => assertBuild(c));
});

describe('buildAuthMessage pays a chosen quote at its own amount', () => {
  it.each([...rows('quote-amount-v1'), ...rows('quote-amount-v2'), ...rows('quote-amount-at-cap')])(
    '%s',
    (_n, c) => assertBuild(c),
  );

  it.each(rows('quote-amount-v2'))('%s signs exactly the quote amount', async (_n, c) => {
    const network = c.params.sourceAsset.split('/')[0]!;
    const { messagePrehash } = await getChainAdapter(network).buildAuthMessage(paramsOf(c));
    const prehash = JSON.parse(messagePrehash) as {
      amount?: string;
      message?: { permitted: { amount: string } };
    };
    const signedAmount = prehash.message?.permitted.amount ?? prehash.amount;
    expect(signedAmount).toBe(c.params.quoteSourceAmount);
    expect(c.params.quoteSourceAmount).not.toBe(
      JSON.parse(c.params.paymentRequestJSON!).max_source_amount,
    );
  });
});

describe('buildAuthMessage refuses a quote amount it must not sign', () => {
  it.each([...rows('quote-above-cap'), ...rows('quote-and-cap'), ...rows('quote-not-positive')])(
    '%s',
    (_n, c) => assertBuild(c),
  );
});

describe('depositAmount refuses a malformed quote amount, as the Go builder does', () => {
  it.each(['0', '01', '-1', '1e6', ' 1'])('%j', (quote) => {
    expect(() => depositAmount({ maxSourceAmount: '', quoteSourceAmount: quote })).toThrow(
      'is not a decimal integer above zero',
    );
  });
});

describe('depositAmount refuses a deposit with no amount, as the Go builder does', () => {
  it.each([undefined, ''])('quoteSourceAmount %j', (quote) => {
    expect(() => depositAmount({ maxSourceAmount: '', quoteSourceAmount: quote })).toThrow(
      'set maxSourceAmount or quoteSourceAmount',
    );
  });
});
