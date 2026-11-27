// Shared primitives of the destination-commitment check: outcomes, results and the comparison
// rules. The entry points are in commitment.ts. Mirrors commitment.go.

import type { SignedMessageInput } from './types.js';
import { buildEscrowDestination, deriveDepositRequestHash } from './destination.js';
import { wellFormed } from './json-members.js';
import { MalformedPrehashError } from './errors.js';

/** Verdict of a destination-commitment check. Only `verified` admits a payment. */
export type CommitmentOutcome =
  | 'verified'
  /** The source chain is unsupported, or message_scheme cannot authorise a payment from it. */
  | 'scheme_mismatch'
  /** The signed deposit commits no destination or no request hash. */
  | 'commitment_absent'
  /** message_prehash is unreadable, ambiguous, or not the document behind the signed digest. */
  | 'prehash_mismatch'
  /** The deposit is not signed by, or not made out to, the payment's source account. */
  | 'signer_mismatch'
  /** The signed destination is not the payment's destination. */
  | 'destination_mismatch'
  /**
   * The signed depositRequestHash is not keccak256 of the payment's request_id, nor the request's
   * depositRequestHash v2 once a v2 mode reads it. In `retire` mode it also refuses a deposit that
   * commits keccak256(request_id), which `retire` no longer accepts.
   */
  | 'request_hash_mismatch'
  /** The payment request document is unreadable or ambiguous. */
  | 'request_malformed'
  /** The verifier did not supply what the check needs. */
  | 'verifier_misconfigured'
  /**
   * A quote's payment_request_json does not commit the same terms as the stored payment request
   * (`verifyQuoteRequestBinding`).
   */
  | 'quote_request_mismatch';

/** One payment_request.destination entry, exactly as the request states it. */
export interface DestinationLeg {
  asset_identifier: string;
  account: string;
}

/** The payment's unsigned copy of the payee: its destination legs and request_id, exactly as sent. */
export interface CommitmentExpectation {
  destinations: readonly DestinationLeg[];
  requestId: string;
  /**
   * The request's depositRequestHash v2 (0x + 64 lowercase hex, from `readDepositRequest`), which a
   * deposit may commit instead of keccak256(request_id). Absent accepts only v1.
   */
  depositRequestHashV2?: string;
}

/**
 * The payment's signed side. `signedMessages[0]` is the deposit. `sourceAccount` is the payer; a
 * Solana deposit signature is verified against it.
 */
export interface SignedDeposit {
  sourceAssetIdentifier: string;
  sourceAccount: string;
  messageScheme: string;
  signedMessages: readonly SignedMessageInput[];
}

/** The Solana escrow's signature domain, from the verifier's own configuration, never the payment. */
export interface SolanaDomain {
  escrowProgramId: string;
  clusterId: string;
  domainVersion: number;
}

/** Verifier configuration for a commitment check beyond the Solana domain. Mirrors the Go `CommitmentOption`s. */
export interface CommitmentOptions {
  /**
   * TIP-712 chain ids by Tron cluster, from the verifier's own configuration, for networks the
   * built-in table (`TRON_CHAIN_IDS`) does not know, such as a local node's `tron:localnet`. The
   * table stays authoritative: an entry for a cluster it knows must repeat its id, an entry for
   * any other cluster must not repeat an id it gives a cluster, and an entry must be an integer in
   * 1..MAX_TRON_CHAIN_ID, or a payment sourced on that cluster is refused as
   * `verifier_misconfigured`. Only the entry for a Tron source's own cluster is read. Mirrors
   * the Go `WithTronChainIDs`.
   */
  tronChainIds?: Readonly<Record<string, number>>;
  /**
   * How the check reads depositRequestHash v2. Absent, `''` or null, it is exactly as before v2.
   * `enforce` reads the request with `readDepositRequest` first and refuses what it refuses as
   * `request_malformed`.
   * `audit` reads it with `readDepositRequest` too, but does not refuse what it refuses: the check
   * reads the request as before v2 and reports the refusal in `CommitmentResult.strictDetail`.
   * `retire` is `enforce` with depositRequestHash v1 retired: only a deposit that commits the
   * request's v2 is admitted, and one committing keccak256(request_id) is refused as
   * `request_hash_mismatch`. `verifyRequestCommitment` and `requiredCommitmentOf` read it;
   * `verifyCommitment` and `verifyPaymentRequestJSON` refuse it as `verifier_misconfigured`.
   * Mirrors the Go `WithDepositRequestHashV2`.
   */
  depositRequestHashV2Mode?: 'audit' | 'enforce' | 'retire';
  /**
   * The Stellar escrow's contract id (a C... strkey), from the verifier's own configuration, never
   * from the payment. The network id comes from the payment's own `stellar:<reference>` source chain.
   * Absent, a Stellar payment is refused as `verifier_misconfigured`. Mirrors the Go `WithStellarEscrow`.
   */
  stellarEscrow?: string;
}

/**
 * Whether a depositRequestHash v2 mode is off: absent, the empty string, Go's zero value, or null,
 * which Go decodes as the zero value, so a mode read from shared configuration means the same in
 * both languages.
 */
export function depositRequestHashV2Off(mode: unknown): boolean {
  return mode === undefined || mode === null || mode === '';
}

/** The outcome of a check plus the values it compared, for admissions and refusals alike. */
export interface CommitmentResult {
  outcome: CommitmentOutcome;
  detail: string;
  namespace: string;
  scheme: string;
  signedDestination: string;
  expectedDestination: string;
  signedDepositRequestHash: string;
  expectedDepositRequestHash: string;
  /** The request's depositRequestHash v2, when the check was given one (`CommitmentExpectation.depositRequestHashV2`). */
  expectedDepositRequestHashV2?: string;
  /**
   * Why `readDepositRequest` refused the request, with `depositRequestHashV2Mode: 'audit'`. The check then
   * read it as before v2. Absent in every other mode.
   */
  strictDetail?: string;
  /**
   * The depositRequestHash version the deposit matched once the check is opted in with
   * `depositRequestHashV2Mode`. Absent otherwise, and on a refusal. The values are the version label of
   * the deposit_request_hash.match metric; absent is none.
   */
  depositRequestHashVersion?: 'v1' | 'v2';
}

/** Thrown with every refusal; `result` carries the outcome. Mirrors the Go `CommitmentError`. */
export class CommitmentError extends Error {
  readonly result: CommitmentResult;
  constructor(result: CommitmentResult) {
    super(`sender_auth: ${result.outcome}: ${result.detail}`);
    this.name = 'CommitmentError';
    this.result = result;
  }
}

/**
 * The commitment result an error carries, if any. Refusals from `verifyCommitment`,
 * `verifyRequestCommitment`, `compareCommitment`, `requiredCommitmentOf` and the commitment rules
 * of `recoverAndVerify` all carry one. Mirrors the Go `CommitmentResultOf`.
 */
export function commitmentResultOf(error: unknown): CommitmentResult | undefined {
  if (error instanceof CommitmentError) return error.result;
  if (error instanceof MalformedPrehashError) return error.result;
  return undefined;
}

export const DETAIL_NO_PREHASH =
  'no message_prehash, so the destination the payer signed cannot be read';
export const DETAIL_NO_DESTINATION =
  'the deposit witness commits no destination, and every deployed escrow requires one';
export const DETAIL_NO_REQUEST_HASH =
  'the deposit witness commits no depositRequestHash, and every deployed escrow requires one';
export const DETAIL_BAD_REQUEST_HASH = 'the signed depositRequestHash is not a 32-byte hex value';
export const DETAIL_BAD_DIGEST = 'the signed message is not a 32-byte hex digest';
export const DETAIL_PERMIT_DIGEST_MISMATCH =
  'the signed digest is not the EIP-712 hash of message_prehash';
export const DETAIL_SIGNER_MISMATCH =
  "the deposit signature does not recover to the payment's source account";
export const DETAIL_DEADLINE_RANGE = 'the signed deadline is beyond the largest supported value';
export const DETAIL_NO_TRON_PERMIT2 =
  'no Permit2 contract is known for this Tron network; the verifier must supply one';

/** Applies the comparison rules to values already read and validated. `signedHash` is 0x + 64 lowercase hex. */
export function compareExpected(
  r: CommitmentResult,
  signedDestination: string,
  signedHash: string,
  expected: CommitmentExpectation,
): CommitmentResult {
  r.signedDestination = echo(signedDestination);
  if (!isWellFormedText(signedDestination)) {
    // Reported as Go decodes it, so both languages log the same value.
    r.signedDestination = echo(wellFormed(signedDestination));
    return withOutcome(r, 'prehash_mismatch', 'the signed destination is not well-formed text');
  }
  if (
    !Array.isArray(expected.destinations) ||
    !expected.destinations.every(isLeg) ||
    typeof expected.requestId !== 'string' ||
    !(
      expected.depositRequestHashV2 === undefined ||
      typeof expected.depositRequestHashV2 === 'string'
    )
  ) {
    return withOutcome(
      r,
      'request_malformed',
      'the commitment inputs do not have the expected types',
    );
  }
  const destination = requestDestination(expected.destinations);
  if (typeof destination !== 'string')
    return withOutcome(r, destination.outcome, destination.detail);
  r.expectedDestination = destination;
  if (signedDestination !== destination) {
    return withOutcome(
      r,
      'destination_mismatch',
      `the payer signed a deposit payable to ${quoteValue(signedDestination)}, but this payment pays ${quoteValue(destination)}`,
    );
  }
  const want = requestDepositRequestHash(expected.requestId);
  if (typeof want !== 'string') return withOutcome(r, want.outcome, want.detail);
  r.expectedDepositRequestHash = want;
  const v2 = expected.depositRequestHashV2 ?? '';
  if (v2 !== '') r.expectedDepositRequestHashV2 = v2;
  if (signedHash === want) {
    if (v2 !== '') r.depositRequestHashVersion = 'v1';
  } else if (v2 !== '' && signedHash === v2) {
    r.depositRequestHashVersion = 'v2';
  } else if (v2 !== '') {
    return withOutcome(
      r,
      'request_hash_mismatch',
      `the payer signed a deposit for another request: depositRequestHash ${r.signedDepositRequestHash} is neither keccak256 of request_id ${quoteValue(expected.requestId)} nor this request's depositRequestHash v2 ${v2}`,
    );
  } else {
    return withOutcome(
      r,
      'request_hash_mismatch',
      `the payer signed a deposit for another request: depositRequestHash ${r.signedDepositRequestHash} is not keccak256 of request_id ${quoteValue(expected.requestId)}`,
    );
  }
  return withOutcome(r, 'verified', '');
}

// The payment's side of the comparison: two rules that read the request alone, one per signed value.
// `requiredCommitmentOf` applies them to a request with no signed prehash, so it returns exactly what
// `compareExpected` compares against rather than a copy of the rules. They are two, not one,
// because `compareExpected` compares the destination before it reads request_id, and that order
// decides which refusal a payment wrong in both gets.

/**
 * The destination a deposit for this payment must commit: `buildEscrowDestination` of its one leg.
 * Refuses a payment that does not name exactly one destination, or whose destination cannot be
 * composed. Mirrors the Go `requestDestination`.
 */
export function requestDestination(
  legs: readonly DestinationLeg[],
): string | { outcome: CommitmentOutcome; detail: string } {
  if (legs.length !== 1) {
    return {
      outcome: 'destination_mismatch',
      detail: `the payment names ${legs.length} destinations; exactly one can be committed to`,
    };
  }
  const leg = legs[0]!;
  try {
    return buildEscrowDestination(leg.asset_identifier, leg.account);
  } catch (e) {
    return {
      outcome: 'destination_mismatch',
      detail: echo(`the payment's destination cannot be committed to: ${(e as Error).message}`),
    };
  }
}

/**
 * The depositRequestHash a deposit for this payment must commit: keccak256(request_id) as 0x + 64
 * lowercase hex, the form `parseHash32` gives a signed hash. Refuses a request_id that is not
 * well-formed text, since Go and TypeScript would hash different bytes, or that is empty, since
 * every empty id would commit to the same hash. Mirrors the Go `requestDepositRequestHash`.
 */
export function requestDepositRequestHash(
  requestId: string,
): string | { outcome: CommitmentOutcome; detail: string } {
  if (!isWellFormedText(requestId)) {
    return {
      outcome: 'request_hash_mismatch',
      detail: "the payment's request_id is not well-formed text",
    };
  }
  if (requestId === '') {
    return {
      outcome: 'request_hash_mismatch',
      detail: "the payment's request_id is empty, so no deposit request hash can be derived",
    };
  }
  return deriveDepositRequestHash(requestId).toLowerCase();
}

function isLeg(value: unknown): boolean {
  const leg = value as { asset_identifier?: unknown; account?: unknown } | null;
  return (
    typeof leg === 'object' &&
    leg !== null &&
    typeof leg.asset_identifier === 'string' &&
    typeof leg.account === 'string'
  );
}

const HASH32 = /^(?:0x)?([0-9a-fA-F]{64})$/;

/** Why `message` is not the signed digest `digestHex`, or "" when it is. Mirrors the Go `signedDigestProblem`. */
export function signedDigestProblem(message: unknown, digestHex: string, mismatch: string): string {
  if (typeof message !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(message)) return DETAIL_BAD_DIGEST;
  return message.slice(2).toLowerCase() === digestHex.replace(/^0x/, '').toLowerCase()
    ? ''
    : mismatch;
}

/** Reads a 32-byte hex value (optional lowercase 0x, no whitespace) as 0x + 64 lowercase hex. */
export function parseHash32(text: string): string | undefined {
  const match = HASH32.exec(text);
  return match ? '0x' + match[1]!.toLowerCase() : undefined;
}

/** Whether `text` is empty or only JSON whitespace (space, tab, LF, CR). */
export function isJsonBlank(text: string): boolean {
  return /^[ \t\n\r]*$/.test(text);
}

/**
 * Bound, in code points, on every input value a result or detail echoes, so an oversized input cannot
 * bloat logs. Every honest value is far shorter.
 */
const MAX_ECHO_LENGTH = 512;

/**
 * `text`, cut to MAX_ECHO_LENGTH code points. It reads no further than the cut, so an oversized
 * value costs no more than the part it keeps.
 */
export function echo(text: string): string {
  let count = 0;
  let end = 0;
  for (const codePoint of text) {
    if (count === MAX_ECHO_LENGTH) return text.slice(0, end) + '...';
    count++;
    end += codePoint.length;
  }
  return text;
}

const REPLACEMENT_CODE = 0xfffd;

/**
 * Whether `text` has no lone surrogate and no U+FFFD. A lone surrogate escape decodes to U+FFFD in Go
 * but stays a lone surrogate in JavaScript, so neither may reach a comparison.
 */
export function isWellFormedText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === REPLACEMENT_CODE) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return false;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Quotes a value for a detail message, escaping only '"', '\' and control characters, as Go does. */
export function quoteValue(text: string): string {
  let out = '"';
  for (const character of echo(text)) {
    const code = character.codePointAt(0)!;
    if (character === '"' || character === '\\') out += '\\' + character;
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += character;
  }
  return out + '"';
}

/** A result that refuses until a rule admits it. */
export function emptyResult(): CommitmentResult {
  return {
    outcome: 'commitment_absent',
    detail: '',
    namespace: '',
    scheme: '',
    signedDestination: '',
    expectedDestination: '',
    signedDepositRequestHash: '',
    expectedDepositRequestHash: '',
  };
}

export function withOutcome(
  r: CommitmentResult,
  outcome: CommitmentOutcome,
  detail: string,
): CommitmentResult {
  return { ...r, outcome, detail };
}

export function refuse(r: CommitmentResult, outcome: CommitmentOutcome, detail: string): never {
  throw new CommitmentError(withOutcome(r, outcome, detail));
}

export function finish(r: CommitmentResult): CommitmentResult {
  if (r.outcome !== 'verified') throw new CommitmentError(r);
  return r;
}

/** The bytes of a 0x-prefixed hex string already checked against its pattern. */
export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}
