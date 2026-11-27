// Pins sender-auth-verify.ts's MIRRORED types against the real upstream ones.
//
// sender-auth-verify.ts cannot import those types: doing so drags
// @atum-labs/schema-declarations' raw .ts into the DTS build and fails it (TS6059). So the
// shipped surface is a hand-written mirror, and a hand-written mirror drifts silently — the
// exact failure mode this file exists to prevent. Test files are excluded from the DTS build
// (tsconfig `exclude: ["**/*.test.ts"]`) but ARE type-checked by `pnpm run typecheck:tests`,
// so this is the one place the two can be compared.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  commitmentResultOf,
  verifyRequestCommitment,
  verifyPaymentRequest,
  verifyPaymentRequestJSON,
} from './sender-auth-verify';
import type {
  VerifyResult,
  VerifyPaymentRequestExpectations,
  VerifiedSenderAuth,
  ParsedPermit,
  AuthTerms,
  CommitmentOutcome,
  CommitmentResult,
  SolanaDomain,
} from './sender-auth-verify';
import type {
  VerifyResult as UpstreamVerifyResult,
  VerifyPaymentRequestExpectations as UpstreamExpectations,
  VerifiedSenderAuth as UpstreamVerifiedSenderAuth,
  ParsedPermit as UpstreamParsedPermit,
  AuthTerms as UpstreamAuthTerms,
  CommitmentOutcome as UpstreamCommitmentOutcome,
  CommitmentResult as UpstreamCommitmentResult,
  SolanaDomain as UpstreamSolanaDomain,
} from '@atum-labs/payment-request-sender-auth';

// A member upstream gains that the mirror lacks. Optional members do NOT break plain
// assignability, so key-set subtraction is what actually catches an addition: the compiler
// names the missing key in the error.
type MissingKeys<Upstream, Mirror> = Exclude<keyof Upstream, keyof Mirror>;
type AssertNever<T extends never> = T;

export type _NoMissingExpectationKeys = AssertNever<
  MissingKeys<UpstreamExpectations, VerifyPaymentRequestExpectations>
>;
export type _NoMissingResultKeys = AssertNever<MissingKeys<UpstreamVerifyResult, VerifyResult>>;
export type _NoMissingPermitKeys = AssertNever<MissingKeys<UpstreamParsedPermit, ParsedPermit>>;
export type _NoMissingTermsKeys = AssertNever<MissingKeys<UpstreamAuthTerms, AuthTerms>>;
export type _NoMissingVerifiedKeys = AssertNever<
  MissingKeys<UpstreamVerifiedSenderAuth, VerifiedSenderAuth>
>;

// And the other direction: a mirror key that upstream does not have is just as wrong, because
// it advertises an option the implementation ignores.
export type _NoExtraExpectationKeys = AssertNever<
  MissingKeys<VerifyPaymentRequestExpectations, UpstreamExpectations>
>;
export type _NoExtraPermitKeys = AssertNever<MissingKeys<ParsedPermit, UpstreamParsedPermit>>;
export type _NoMissingCommitmentKeys = AssertNever<
  MissingKeys<UpstreamCommitmentResult, CommitmentResult>
>;
export type _NoExtraCommitmentKeys = AssertNever<
  MissingKeys<CommitmentResult, UpstreamCommitmentResult>
>;
export type _NoMissingOutcomes = AssertNever<Exclude<UpstreamCommitmentOutcome, CommitmentOutcome>>;
export type _NoMissingDomainKeys = AssertNever<MissingKeys<UpstreamSolanaDomain, SolanaDomain>>;
export type _NoExtraDomainKeys = AssertNever<MissingKeys<SolanaDomain, UpstreamSolanaDomain>>;
export const _domainAcceptsUpstream: SolanaDomain = {} as UpstreamSolanaDomain;
export const _upstreamAcceptsDomain: UpstreamSolanaDomain = {} as SolanaDomain;
export type _NoExtraOutcomes = AssertNever<Exclude<CommitmentOutcome, UpstreamCommitmentOutcome>>;

// Value-level assignability, which catches a member whose TYPE changed while its name did not.
export const _mirrorAcceptsUpstream: VerifyResult = {} as UpstreamVerifyResult;
export const _upstreamAcceptsMirror: UpstreamVerifyResult = {} as VerifyResult;
export const _expectationsAcceptUpstream: VerifyPaymentRequestExpectations =
  {} as UpstreamExpectations;
export const _upstreamAcceptsExpectations: UpstreamExpectations =
  {} as VerifyPaymentRequestExpectations;

describe('verifyPaymentRequest: the require seam', () => {
  it('reaches the real upstream implementation', () => {
    // Not a stub: a request with no signed messages must throw upstream's own error, which is
    // what proves the require() resolved to the real module rather than silently to undefined.
    expect(() => verifyPaymentRequest({} as never)).toThrow(/sender_auth/);
  });

  it('reaches the upstream JSON entry point and reports the commitment outcome', () => {
    const twin = '{"request_id":"a","Request_Id":"b"}';
    let caught: unknown;
    try {
      verifyPaymentRequestJSON(twin);
    } catch (e) {
      caught = e;
    }
    expect(commitmentResultOf(caught)?.outcome).toBe('request_malformed');
    expect(commitmentResultOf(new Error('unrelated'))).toBeUndefined();
  });

  it('rejects a request with no source', () => {
    expect(() =>
      verifyPaymentRequest({
        sender_auth: { signed_messages: [{ message: '0x00' }] },
      } as never),
    ).toThrow(/source/);
  });
});

// A contract account (ERC-1271, such as a Safe) signs with an owner key, so its signer never
// recovers to the payer: the payee check admits it, and the signature-recovering entry points do not.
describe('a contract-account payer', () => {
  const { vectors } = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../../../../../schemas/declarations/PaymentRequest/v1/conformance/verify-json-vectors.json',
      ),
      'utf8',
    ),
  ) as { vectors: Array<{ name: string; request: string; expected: Record<string, unknown> }> };
  const safe = vectors.find((v) => v.name === 'contract-account-payer')!;

  it('passes verifyRequestCommitment', () => {
    expect(verifyRequestCommitment(safe.request).outcome).toBe('verified');
  });

  it('passes verifyRequestCommitment opted into depositRequestHash v2, and reports v1', () => {
    const result = verifyRequestCommitment(safe.request, undefined, {
      depositRequestHashV2Mode: 'audit',
    });
    expect(result.outcome).toBe('verified');
    expect(result.depositRequestHashVersion).toBe('v1');
  });

  it('is refused by verifyPaymentRequestJSON as signer_mismatch', () => {
    let caught: unknown;
    try {
      verifyPaymentRequestJSON(safe.request, safe.expected);
    } catch (e) {
      caught = e;
    }
    expect(commitmentResultOf(caught)?.outcome).toBe('signer_mismatch');
  });
});

describe('verifyRequestCommitment in retire mode', () => {
  const { requests } = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        '../../../../../../../../schemas/declarations/PaymentRequest/v1/conformance/commitment-v2-vectors.json',
      ),
      'utf8',
    ),
  ) as { requests: Array<{ name: string; request: string }> };
  const v1 = requests.find((c) => c.name === 'strict-evm-v1/retire')!;

  it('refuses a v1 deposit that enforce admits', () => {
    const enforced = verifyRequestCommitment(v1.request, undefined, {
      depositRequestHashV2Mode: 'enforce',
    });
    expect(enforced.depositRequestHashVersion).toBe('v1');
    let caught: unknown;
    try {
      verifyRequestCommitment(v1.request, undefined, { depositRequestHashV2Mode: 'retire' });
    } catch (e) {
      caught = e;
    }
    expect(commitmentResultOf(caught)).toMatchObject({
      outcome: 'request_hash_mismatch',
      detail: expect.stringMatching(/no longer accepts: sign depositRequestHash v2/),
    });
  });
});
