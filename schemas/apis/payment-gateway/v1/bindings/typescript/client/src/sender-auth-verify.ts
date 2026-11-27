// Verifies what a sender_auth signature commits to.
//
// signPaymentRequest signs every signed_messages[] entry exactly as given, so this check is
// exported for consumers to run before signing (see docs/signing.md). The implementing package
// is bundled (tsup noExternal) and not separately installable.
//
// The types are declared here over this package's own generated types rather than re-exported:
// the upstream package's types reference @atum-labs/schema-declarations, whose raw .ts entry
// points fail the DTS build under a tsconfig rootDir (TS6059). The upstream module is loaded
// through require so no type edge is created. sender-auth-verify.test.ts pins these
// declarations against the upstream types in both directions.

import type { PaymentRequest, SenderAuthMessageScheme } from './generated/types.gen';

/* eslint-disable @typescript-eslint/no-require-imports -- a static import would create a type
   edge into @atum-labs/schema-declarations (TS6059); see the comment above. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const senderAuth: any = require('@atum-labs/payment-request-sender-auth');

/** The signed terms a recovered permit carries. */
export interface AuthTerms {
  /** Atomic units, decimal string. */
  amount: string;
  /** Unix seconds. */
  deadlineSec: number;
}

/** The recovered and parsed permit, so a consumer can run its own policy checks. */
export interface ParsedPermit {
  scheme: SenderAuthMessageScheme;
  /** EVM/Tron: permit token; Solana: mint. */
  token: string;
  amount: string;
  deadlineSec: number;
  reserver: string;
  releaser: string;
  /** EVM/Tron only (Permit2 spender). */
  spender?: string;
  /** Solana and Stellar (the signed depositor). */
  depositor?: string;
  /** Stellar only: the delegate signer (G strkey), equal to the depositor; its registration still has to be checked against the escrow's `get_delegate`. */
  delegateSigner?: string;
  /** Stellar only, always `true`: the delegate's on-chain registration was NOT verified, although the delegate is the depositor's own key. */
  delegateOnchainUnverified?: true;
  /** Stellar only: the delegate record epoch the digest commits to; compare it with `get_delegate(depositor, token).epoch`. */
  delegateEpoch?: string;
  /** The escrow commitments as signed: the payee and the hash of the request id. */
  destination?: string;
  depositRequestHash?: string;
}

/** How the destination commitment check ended. Only `verified` admits a payment. */
export type CommitmentOutcome =
  | 'verified'
  | 'scheme_mismatch'
  | 'commitment_absent'
  | 'prehash_mismatch'
  | 'signer_mismatch'
  | 'destination_mismatch'
  | 'request_hash_mismatch'
  | 'request_malformed'
  | 'verifier_misconfigured'
  | 'quote_request_mismatch';

/** The destination commitment check's result: the outcome and both copies of the payee. */
export interface CommitmentResult {
  outcome: CommitmentOutcome;
  detail: string;
  namespace: string;
  scheme: string;
  signedDestination: string;
  expectedDestination: string;
  signedDepositRequestHash: string;
  expectedDepositRequestHash: string;
  /** The request's depositRequestHash v2, when the check was given one (opted in, and the strict reader admitted the request). */
  expectedDepositRequestHashV2?: string;
  /** Why the strict reader refused the request, with `depositRequestHashV2Mode: 'audit'`. */
  strictDetail?: string;
  /** The depositRequestHash version the deposit matched, once opted in with `depositRequestHashV2Mode`. */
  depositRequestHashVersion?: 'v1' | 'v2';
}

/** The Solana escrow signature domain, from your chain configuration. */
export interface SolanaDomain {
  escrowProgramId: string;
  clusterId: string;
  domainVersion: number;
}

/** One verified `signed_messages[]` entry: the signed terms, the parsed permit and the commitment. */
export interface VerifiedSenderAuth extends AuthTerms {
  permit: ParsedPermit;
  commitment: CommitmentResult;
}

/** What {@link verifyPaymentRequest} returns. */
export interface VerifyResult {
  /** One entry per `sender_auth.signed_messages[]`, in order. */
  results: VerifiedSenderAuth[];
  /** The `source.account` every signature was verified to recover to. */
  recoveredAccount: string;
  /**
   * The commitment check's result, once {@link verifyPaymentRequestJSON} is opted in with
   * `depositRequestHashV2Mode`: the depositRequestHash version the deposit matched and, in audit mode,
   * `strictDetail`. Absent otherwise.
   */
  commitment?: CommitmentResult;
}

/**
 * Expectations for {@link verifyPaymentRequest}.
 *
 * Pass the first three to check the signatures against your own terms. When omitted, the token,
 * network and amount are taken from the request itself, which proves only that the signatures
 * are consistent with fields the request's author controls.
 */
export interface VerifyPaymentRequestExpectations {
  /** Authoritative source-asset address (bare token, no CAIP prefix). */
  sourceAsset?: string;
  /** Authoritative CAIP-2 network. Parsed from the request when omitted. */
  network?: string;
  /** Authoritative max source amount to bind the permit amount against. */
  maxSourceAmount?: string;
  /**
   * For a deposit that pays a chosen quote: the permit must authorize exactly the quote's
   * `source_amount`, a decimal string above zero, and the request's `max_source_amount` is not
   * read. Leave `maxSourceAmount` unset with it.
   */
  quoteSourceAmount?: string;
  /**
   * Opt-in atum-escrow-scheme fail-fast checks. On Stellar all three of `escrowContract`,
   * `reserver` and `releaser` are required: a verifier that omits one is refused as
   * `verifier_misconfigured`.
   */
  escrowContract?: string;
  reserver?: string;
  releaser?: string;
  /** Solana: additionally required by the deposit-hash domain, independent of role binding. */
  svmSignatureClusterId?: string;
  svmSignatureDomainVersion?: number;
  /** EVM/Tron: the Permit2 contract the signature is bound to. */
  permit2Contract?: string;
  /** Freshness reference, Unix seconds. Defaults to now. */
  nowSec?: number;
  /**
   * How {@link verifyPaymentRequestJSON} reads depositRequestHash v2. Absent, only v1 is accepted, as
   * before v2. `audit` also accepts v2 and reports a request the strict reader refuses; `enforce`
   * also accepts v2 and refuses such a request. {@link verifyPaymentRequest} accepts only v1 and
   * refuses it as `verifier_misconfigured`.
   */
  depositRequestHashV2Mode?: 'audit' | 'enforce';
}

/**
 * Recovers every `sender_auth.signed_messages[]` entry and binds the signed terms to
 * `expected`, returning the parsed permits and the account they all recover to.
 *
 * Every deposit must commit to the request's own `destination` and `request_id`, so a request
 * whose payee or request id was changed after signing is refused.
 *
 * Every entry must be a bindable permit; a malformed entry throws. A caller with mixed messages
 * (for example an EVM setup approval alongside the permit) composes the per-entry adapter calls
 * itself. Request-shape and policy checks remain the caller's.
 *
 * @throws If any entry fails to recover, bind, or match `expected`.
 * @deprecated A parsed request keeps one value for a member name that appears twice, so this
 * checks a copy of the request rather than the text received, and it accepts only
 * depositRequestHash v1. Use {@link verifyPaymentRequestJSON} with the request as received.
 */
export function verifyPaymentRequest(
  request: PaymentRequest,
  expected: VerifyPaymentRequestExpectations = {},
): VerifyResult {
  return senderAuth.verifyPaymentRequest(request, expected) as VerifyResult;
}

/**
 * Recovers every `sender_auth.signed_messages[]` entry of the request as received and binds the
 * signed terms to `expected`, returning the parsed permits and the account they all recover to. It
 * refuses a repeated member name, including names that differ only in letter case, where it reads,
 * and every deposit must commit to the request's own `destination` and request: depositRequestHash
 * v1 by default, v1 or v2 with `expected.depositRequestHashV2Mode`, which also returns the commitment
 * check's result as `commitment`.
 *
 * @throws If the JSON is ambiguous or does not decode, or if any entry fails to recover, bind, or
 * match `expected`; {@link commitmentResultOf} returns the outcome.
 */
export function verifyPaymentRequestJSON(
  request: string | Uint8Array,
  expected: VerifyPaymentRequestExpectations = {},
): VerifyResult {
  return senderAuth.verifyPaymentRequestJSON(request, expected) as VerifyResult;
}

/**
 * The payee check alone, over the request's JSON: the deposit must commit to the request's own
 * `destination` and `request_id`. It does not recover the signer, so it also serves a
 * contract-account payer (ERC-1271, such as a Safe), whose signature Permit2 checks on chain.
 * `solana` is required for a Solana source. `options.depositRequestHashV2Mode` also accepts a deposit
 * that commits depositRequestHash v2, as it does for {@link verifyPaymentRequestJSON}. `retire`, which
 * only this check reads, accepts only that: it is `enforce` with a deposit committing v1 refused as
 * `request_hash_mismatch`.
 *
 * @throws If the check refuses; {@link commitmentResultOf} returns the outcome.
 */
export function verifyRequestCommitment(
  request: string | Uint8Array,
  solana?: SolanaDomain,
  options?: { depositRequestHashV2Mode?: 'audit' | 'enforce' | 'retire' },
): CommitmentResult {
  return senderAuth.verifyRequestCommitment(request, solana, options) as CommitmentResult;
}

/** The commitment result a verification error carries, if any; log its outcome and detail. */
export function commitmentResultOf(error: unknown): CommitmentResult | undefined {
  return senderAuth.commitmentResultOf(error) as CommitmentResult | undefined;
}
