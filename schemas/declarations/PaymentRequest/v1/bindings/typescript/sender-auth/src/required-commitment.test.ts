import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// From the package entry point, so these tests also hold the export in place.
import {
  CommitmentError,
  commitmentResultOf,
  requiredCommitmentOf,
  verifyRequestCommitment,
} from './index.js';
import type {
  CommitmentOptions,
  CommitmentResult,
  RequiredCommitment,
  SolanaDomain,
} from './index.js';

// The shared vectors both languages assert. They are written by hand, not recorded from this
// function, so they are the oracle for both implementations.
const VECTORS = resolve(__dirname, '../../../../conformance/required-commitment-vectors.json');
const COMMITMENT_VECTORS = resolve(__dirname, '../../../../conformance/commitment-vectors.json');

interface Vector {
  name: string;
  request: string;
  solana?: SolanaDomain;
  tronChainIds?: Record<string, number>;
  want?: RequiredCommitment;
  result?: CommitmentResult;
}

const vectors = (JSON.parse(readFileSync(VECTORS, 'utf8')) as { vectors: Vector[] }).vectors;

/** The commitment returned, or the result the refusal carries: the two shapes a vector expects. */
function outcomeOf(
  request: string | Uint8Array,
  solana?: SolanaDomain,
  options?: CommitmentOptions,
): Pick<Vector, 'want' | 'result'> {
  try {
    return { want: requiredCommitmentOf(request, solana, options) };
  } catch (e) {
    expect(e).toBeInstanceOf(CommitmentError);
    return { result: commitmentResultOf(e) };
  }
}

// Whether the first signed message carries a prehash, read by exact name as the library reads it.
function carriesPrehash(request: string): boolean {
  let prehash: unknown;
  try {
    const doc = JSON.parse(request) as { sender_auth?: { signed_messages?: unknown[] } };
    prehash = (doc?.sender_auth?.signed_messages?.[0] as { message_prehash?: unknown })
      ?.message_prehash;
  } catch {
    return false;
  }
  return prehash !== undefined && prehash !== null;
}

/** What verifyRequestCommitment makes of the request, in the two shapes a vector expects. */
function verifiedOutcomeOf(
  request: string,
  solana?: SolanaDomain,
  options?: CommitmentOptions,
): Pick<Vector, 'want' | 'result'> {
  try {
    const r = verifyRequestCommitment(request, solana, options);
    return {
      want: {
        namespace: r.namespace,
        destination: r.expectedDestination,
        depositRequestHash: r.expectedDepositRequestHash,
      },
    };
  } catch (e) {
    expect(e).toBeInstanceOf(CommitmentError);
    return { result: commitmentResultOf(e) };
  }
}

// Mirrors the Go TestRequiredCommitmentVectors.
describe('required-commitment vectors', () => {
  let ran = 0;

  it('carries vectors with unique names, each expecting either a commitment or a refusal', () => {
    expect(vectors.length).toBeGreaterThan(0);
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
    for (const v of vectors) {
      const expects = v.want !== undefined ? 'want' : 'result';
      const members = [
        'name',
        'request',
        expects,
        ...('solana' in v ? ['solana'] : []),
        ...('tronChainIds' in v ? ['tronChainIds'] : []),
      ];
      expect(Object.keys(v).sort(), v.name).toEqual(members.sort());
      // A domain or chain ids are given as an object or left out, never as null, which TypeScript
      // would read as supplied and Go as none.
      if ('solana' in v) expect(v.solana, v.name).toBeInstanceOf(Object);
      if ('tronChainIds' in v) expect(v.tronChainIds, v.name).toBeInstanceOf(Object);
    }
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    ran++;
    const expected = v.want !== undefined ? { want: v.want } : { result: v.result };
    const options = { tronChainIds: v.tronChainIds };
    expect(outcomeOf(v.request, v.solana, options)).toEqual(expected);
    // The same request as bytes is the same text.
    expect(outcomeOf(new TextEncoder().encode(v.request), v.solana, options)).toEqual(expected);
    // With a prehash, or unreadable, the vector is verifyRequestCommitment's answer for the same
    // request and domain.
    if (carriesPrehash(v.request) || v.result?.outcome === 'request_malformed') {
      expect(verifiedOutcomeOf(v.request, v.solana, options)).toEqual(expected);
    }
  });

  it('ran every vector', () => {
    expect(ran).toBe(vectors.length);
  });
});

// On every commitment vector whose request carries a signed prehash, or cannot be read, the function
// is verifyRequestCommitment: the commitment compared when verified, the same refusal otherwise. On
// every other request no signed commitment can be read, and verifyRequestCommitment could only find none.
// Mirrors the Go TestRequiredCommitmentOfMatchesComparison.
describe('requiredCommitmentOf is verifyRequestCommitment on a signed request', () => {
  const requests = (
    JSON.parse(readFileSync(COMMITMENT_VECTORS, 'utf8')) as {
      requests: Array<{
        name: string;
        request: string;
        solana: SolanaDomain | null;
        tronChainIds?: Record<string, number>;
        result: CommitmentResult;
      }>;
    }
  ).requests;

  // The unsigned rows are an honest payment with its prehash, or its whole sender_auth, removed, so
  // the commitment they require is the one the honest payment of the same chain family was verified
  // against.
  const honest = new Map(
    requests
      .filter((c) => c.name.endsWith('-honest'))
      .map((c) => [
        c.name.slice(0, -'-honest'.length),
        {
          namespace: c.result.namespace,
          destination: c.result.expectedDestination,
          depositRequestHash: c.result.expectedDepositRequestHash,
        },
      ]),
  );
  const invalidDomain: SolanaDomain = {
    escrowProgramId: 'not-base58!',
    clusterId: 'devnet',
    domainVersion: 5,
  };

  let signed = 0;
  let unsigned = 0;
  it.each(requests.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const isSigned = carriesPrehash(c.request) || c.result.outcome === 'request_malformed';
    // An unsigned row's Tron chain ids are for verifyRequestCommitment, which reports the missing
    // signed messages before it reads them. The unsigned path here reads them for the
    // supported-chain rule, which required-commitment-vectors.json pins, so it is given none.
    // Mirrors the Go test.
    const options = { tronChainIds: isSigned ? c.tronChainIds : undefined };
    const got = outcomeOf(c.request, c.solana ?? undefined, options);
    if (isSigned) {
      signed++;
      expect(got).toEqual(
        c.result.outcome === 'verified'
          ? {
              want: {
                namespace: c.result.namespace,
                destination: c.result.expectedDestination,
                depositRequestHash: c.result.expectedDepositRequestHash,
              },
            }
          : { result: c.result },
      );
    } else {
      unsigned++;
      expect(c.result.outcome).toBe('commitment_absent');
      const want = honest.get(c.name.split('-')[0]);
      expect(want, `no honest payment for ${c.name}`).toBeDefined();
      expect(got).toEqual({ want });
      // No signed commitment can be read, so the Solana domain is never read: none, or an invalid one,
      // changes nothing.
      expect(outcomeOf(c.request, undefined, options)).toEqual({ want });
      expect(outcomeOf(c.request, invalidDomain, options)).toEqual({ want });
    }
  });

  it('covered both kinds', () => {
    expect(signed).toBeGreaterThan(0);
    expect(unsigned).toBeGreaterThan(0);
  });
});

// Bytes that are not valid UTF-8 are refused, as they are in Go. Mirrors the Go
// TestRequiredCommitmentOfBytes.
describe('requiredCommitmentOf on raw bytes', () => {
  it('refuses a request that is not valid UTF-8', () => {
    const honest = vectors.find((v) => v.name === 'eip155-unsigned')!.request;
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('{"note":"'),
      0xff,
      ...new TextEncoder().encode('",' + honest.slice(1)),
    ]);
    const { result } = outcomeOf(bytes);
    expect(result?.outcome).toBe('request_malformed');
    expect(result?.detail).toBe('the payment request is not a single valid JSON document');
  });
});
