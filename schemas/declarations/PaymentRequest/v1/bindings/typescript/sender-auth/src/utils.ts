// Shared sender_auth utilities: permit nonce/deadline resolution, address comparison and the
// permit binding checks every adapter runs.

import { keccak256, toUtf8Bytes } from 'ethers';
import { CommitmentError, emptyResult } from './commitment-rules.js';
import { PermitAmountMismatchError } from './errors.js';
import type { VerifyExpectations } from './types.js';

/**
 * Solana replay horizon in seconds: a deposit's `deadline` must be within this window of its
 * `issued_at`. Mirrors the value the on-chain program enforces.
 */
export const REPLAY_HORIZON_SECS = 128;

/**
 * Normalizes a caller-supplied absolute permit deadline (Unix seconds). It is required: a low-level
 * builder cannot know a payment's settlement horizon, so the calling layer derives it from the
 * payment's `fulfillment_deadline`. A value outside 0..2^53-1 is refused, since no verifier reads it
 * exactly.
 */
export function resolvePermitDeadline(deadline: bigint | number): bigint {
  const value = BigInt(deadline);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `sender_auth: permit deadline ${value} is outside 0..${Number.MAX_SAFE_INTEGER}`,
    );
  }
  return value;
}

/**
 * Unique permit nonce: ms timestamp in the high bits, 32 random low bits so permits signed in
 * the same millisecond never collide. It is the explicit opt-in for one-shot builds; a retryable
 * build needs {@link deterministicPermitNonce}.
 */
export function generatePermitNonce(): bigint {
  const rand = new Uint32Array(1);
  globalThis.crypto.getRandomValues(rand);
  return (BigInt(Date.now()) << 32n) + BigInt(rand[0]!);
}

/**
 * Normalizes a caller-supplied Permit2 nonce (a `bigint`, or a decimal or `0x`-hex string). The
 * nonce is required, with no random fallback: a random nonce is not retry-safe, so derive it from
 * a stable request id ({@link deterministicPermitNonce}) so a retry reproduces the same permit.
 * One-shot builds opt in via {@link generatePermitNonce}.
 */
export function resolvePermitNonce(nonce: bigint | string): bigint {
  return BigInt(nonce);
}

// ─── Deterministic permit nonce ──────────────────────────────────────────────
// Derived from the payment's stable identity (`request_id` + `depositor` only, not the full
// parameter set) so a rebuild on retry produces the same single-use permit. The permit already
// binds token, amount and deadline, so the nonce needs only uniqueness and reproducibility.

/** Domain separator for the deterministic permit-nonce seed. */
export const PERMIT_NONCE_DOMAIN = 'atum-permit:v1:';

/** On-chain Solana replay-nonce layout (mirrors the escrow program / nonce-generator). */
export const SOLANA_REPLAY_SLOTS = 235n;
/** Bounded bucket set so the replay PDAs are reused instead of one created per payment. */
export const SOLANA_REPLAY_BUCKETS = 256n;

/**
 * Canonicalizes a depositor address for the nonce and `request_id` seeds. EVM `0x` hex is
 * case-insensitive (EIP-55 casing is only a checksum), so it is lowercased; base58 (Solana, Tron)
 * is case-sensitive, so it is used verbatim. A caller that checksums the address on one attempt
 * and lowercases it on the retry therefore derives the same values. Lowercasing before the prefix
 * test also covers an uppercase `0X` prefix. Must stay byte-identical to the Go
 * `canonicalDepositor`.
 *
 * Exported so a consumer that needs the same canonical account form (for example a `did:pkh:`
 * source) reuses this rule.
 */
export function canonicalDepositor(depositor: string): string {
  const lower = depositor.toLowerCase();
  return lower.startsWith('0x') ? lower : depositor;
}

/** keccak256 of the domain-separated (request_id, depositor) identity, as a 256-bit bigint. */
function permitNonceSeed(requestId: string, depositor: string): bigint {
  if (!requestId) {
    throw new Error('sender_auth: request_id is required to derive a deterministic permit nonce');
  }
  return BigInt(
    keccak256(toUtf8Bytes(`${PERMIT_NONCE_DOMAIN}${requestId}:${canonicalDepositor(depositor)}`)),
  );
}

/**
 * Deterministic EVM/Tron Permit2 nonce (unordered 256-bit, single-use on-chain) for a stable
 * `request_id` + `depositor`; the full 256-bit seed is used directly.
 *
 * One `request_id` pins exactly one payment's permit: reusing a `request_id` for different terms
 * reproduces the same nonce, so the second deposit is rejected on-chain as a duplicate. Use a
 * fresh `request_id` per distinct payment.
 */
export function deterministicPermitNonce(params: { requestId: string; depositor: string }): bigint {
  return permitNonceSeed(params.requestId, params.depositor);
}

/**
 * Deterministic Solana deposit nonce in the on-chain replay layout: low byte = slot (`< 235`),
 * bits 32-63 = bucket from the bounded set (the replay PDA seed). The same `request_id` +
 * `depositor` yields the same slot and bucket, so a rebuild, or a reused `request_id` with
 * different terms, is rejected on-chain as a duplicate, but only while the program still remembers
 * the nonce (the 256s slice it was issued in and the next one, so 256 to 512s): a signed
 * authorization is valid for 128 seconds and the program then forgets its nonce. Unlike the EVM
 * and Tron Permit2 nonce ({@link deterministicPermitNonce}), it is not single-use forever. A
 * rebuild signed after that window, with a fresh `issued_at`, is a new authorization and can
 * create a second deposit. One request, one deposit therefore rests on resubmitting the same
 * signed credential and on the gateway's `request_id` dedup, not on the chain. Two distinct
 * requests from one depositor that hash to the same bucket and slot collide for that long, and a
 * retry repeats the collision until it ages out. Use a fresh `request_id` per distinct payment.
 *
 * The pair is publicly derivable, but the replay PDA is seeded per depositor
 * (`["replay", escrow_delegate.authority, bucket]`), so another party's deposit cannot occupy it.
 */
export function deterministicSolanaNonce(params: { requestId: string; depositor: string }): bigint {
  const seed = permitNonceSeed(params.requestId, params.depositor);
  const slot = seed % SOLANA_REPLAY_SLOTS; // 0..234, fits the low byte
  const bucket = (seed >> 8n) % SOLANA_REPLAY_BUCKETS;
  return (bucket << 32n) | slot;
}

/**
 * Deterministic Stellar deposit nonce: the escrow keeps an unordered per-depositor bitmap over u64
 * nonces and never reuses one, so any u64 is valid. It is the top 64 bits of the same seed the
 * other chains use, so one `request_id` + `depositor` pins exactly one deposit: reusing a
 * `request_id` for different terms reproduces the nonce and the second deposit is refused on chain.
 */
export function deterministicStellarNonce(params: {
  requestId: string;
  depositor: string;
}): bigint {
  return permitNonceSeed(params.requestId, params.depositor) >> 192n;
}

// ─── Deterministic request id ────────────────────────────────────────────────

/**
 * Domain separator for the `request_id` derivation. It names the derivation rather than a payment
 * scheme, is versioned like {@link PERMIT_NONCE_DOMAIN}, and differs from it so the two
 * derivations never share a preimage. Changing it changes every derived `request_id` (an
 * idempotency key), so treat it as a wire change.
 */
export const REQUEST_ID_DOMAIN = 'atum-request:v1:';

/**
 * Deterministic `request_id` derived from a per-intent anchor and the payer account.
 *
 * The gateway de-duplicates on (`source_account`, `originator_did`, `request_id`), so rebuilding
 * the payment for the same intent resolves to the original payment instead of creating a second
 * one.
 *
 * The anchor must be per intent, not per attempt or per challenge: an anchor that changes when the
 * payer re-fetches its challenge derives a new `request_id` on retry, and the payer is charged
 * twice. An anchor on the payment terms instead makes two identical purchases collide, and the
 * second is swallowed as a retry. mppx anchors on the merchant's per-purchase `intentId`; x402 on
 * the payer's `payment-identifier` extension value.
 *
 * The account is folded in, canonicalized like the nonce seed, so two payers sharing an anchor
 * cannot collide. The prefix is an origin marker for logs, prepended after the digest so it never
 * enters the hash. The domain is fixed, not a parameter. The digest is truncated to 96 bits
 * (~2^48 payments for an even chance of a collision).
 *
 * @param params.anchor - the per-intent identifier (e.g. an order id or a merchant-stamped intent id)
 * @param params.account - the payer's source account, in its chain's address form
 * @param params.prefix - short origin marker for logs (e.g. `req_mpp_`, `req_x402_`). Letters,
 *   digits, `_` and `-` only; may be empty
 * @returns `prefix` followed by 24 hex characters of the domain-separated digest
 * @throws if the anchor or the account is empty, or if the prefix contains characters outside
 *   the allowed set
 */
export function deterministicRequestId(params: {
  anchor: string;
  account: string;
  prefix: string;
}): string {
  return deterministicFullRequestId(params).slice(0, params.prefix.length + 24);
}

/**
 * {@link deterministicRequestId} without the truncation: the same preimage, all 256 bits of the
 * digest (64 hex characters). For anchors the payer chooses freely, where 96 bits would let it
 * search for two anchors that collide.
 *
 * @returns `prefix` followed by 64 hex characters; its first 24 equal {@link deterministicRequestId}
 * @throws on the same inputs as {@link deterministicRequestId}
 */
export function deterministicFullRequestId(params: {
  anchor: string;
  account: string;
  prefix: string;
}): string {
  if (!params.anchor) {
    throw new Error(
      'sender_auth: a per-intent anchor is required to derive a deterministic request_id ' +
        '(a random one would silently break idempotency and let a retry double-charge)',
    );
  }
  if (!params.account) {
    throw new Error('sender_auth: account is required to derive a deterministic request_id');
  }
  // The prefix is the only caller-supplied part that survives verbatim into the returned id, and
  // `request_id` carries no character constraint of its own on the wire. Restrict it so a stray
  // separator or control character cannot travel into the gateway's dedup key or a log line.
  if (!/^[A-Za-z0-9_-]*$/.test(params.prefix)) {
    throw new Error(
      `sender_auth: request_id prefix must contain only letters, digits, '_' or '-' (got ${JSON.stringify(params.prefix)})`,
    );
  }
  const digest = keccak256(
    toUtf8Bytes(`${REQUEST_ID_DOMAIN}${params.anchor}:${canonicalDepositor(params.account)}`),
  );
  return `${params.prefix}${digest.slice(2)}`;
}

/**
 * Splits a CAIP asset identifier (`<network>/<ns>:<address>`) into its network and bare address,
 * or throws naming the offending value. Every segment is required and none may be empty. Mirrors
 * the Go `assetAddress` error surface.
 */
export function parseSourceAsset(assetIdentifier: string): { network: string; asset: string } {
  const parts = typeof assetIdentifier === 'string' ? assetIdentifier.split('/') : [];
  const nsParts = parts[1]?.split(':');
  // The CAIP-19 token-id form names one token of a non-fungible collection. A deposit binds a
  // fungible amount, so reading its collection address as the token would sign a permit for
  // something this flow cannot settle.
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    throw new Error(
      `sender_auth: source asset ${JSON.stringify(assetIdentifier)} names a token id, which a deposit cannot bind`,
    );
  }
  // Exactly two segments on each separator, none empty, so a second separator cannot make the
  // two bindings read different addresses.
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !nsParts ||
    nsParts.length !== 2 ||
    !nsParts[0] ||
    !nsParts[1]
  ) {
    throw new Error(`sender_auth: invalid source asset ${JSON.stringify(assetIdentifier)}`);
  }
  return { network: parts[0], asset: nsParts[1] };
}

/**
 * Address equality that is case-insensitive for EVM `0x` hex and exact for case-sensitive
 * base58 (Solana, Tron). Mirrors the Go `sameAddress`.
 */
export function sameAddress(a: string, b: string): boolean {
  if (a.startsWith('0x') && b.startsWith('0x')) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Throw a key-free mismatch error when a private key does not derive the expected sender. */
export function assertKeyMatchesSender(matches: boolean, sender: string, derived: string): void {
  if (!matches) {
    throw new Error(
      `sender_auth: private key derives ${derived}, not the expected sender ${sender}`,
    );
  }
}

// ─── Binding checks ─────────────────────────────────────────────────────────
// `normalize` maps an expected address into the signed message's canonical form
// (identity for EVM; base58→hex for Tron), so both sides compare in the same form.

/** UNIVERSAL: the permit token must equal the payment's source asset. */
export function assertToken(
  token: string,
  sourceAsset: string,
  normalize: (a: string) => string,
): void {
  if (!sameAddress(token, normalize(sourceAsset))) {
    throw new Error('sender_auth: permit token does not match the source asset');
  }
}

const DECIMAL_UINT = /^(?:0|[1-9][0-9]*)$/;

export const POSITIVE_DECIMAL_UINT = /^[1-9][0-9]*$/;

const DETAIL_QUOTE_AND_MAX_AMOUNT =
  'a quote source amount and a max source amount were both supplied';
const DETAIL_QUOTE_AMOUNT_MALFORMED =
  'the quote source amount is not a positive decimal integer string';

/**
 * Binds the permit amount: to `expected.quoteSourceAmount` when it is set, else to
 * `expected.maxSourceAmount`. Mirrors the Go `assertPermitAmount`.
 */
export function assertPermitAmount(
  namespace: string,
  amount: string,
  expected: Pick<VerifyExpectations, 'maxSourceAmount' | 'quoteSourceAmount'>,
): void {
  const quote = expected.quoteSourceAmount;
  if (!quote) {
    assertAmountMatches(amount, expected.maxSourceAmount);
    return;
  }
  const misconfigured = (detail: string) =>
    new CommitmentError({ ...emptyResult(), outcome: 'verifier_misconfigured', detail, namespace });
  if (expected.maxSourceAmount) throw misconfigured(DETAIL_QUOTE_AND_MAX_AMOUNT);
  if (typeof quote !== 'string' || !POSITIVE_DECIMAL_UINT.test(quote)) {
    throw misconfigured(DETAIL_QUOTE_AMOUNT_MALFORMED);
  }
  if (!sameDecimal(amount, quote)) throw new PermitAmountMismatchError('the quote source_amount');
}

/** UNIVERSAL: the permit amount must equal the payment's `max_source_amount`. */
export function assertAmountMatches(amount: string, maxSourceAmount: string): void {
  if (typeof maxSourceAmount !== 'string' || !DECIMAL_UINT.test(maxSourceAmount)) {
    throw new Error('sender_auth: max_source_amount is not a decimal integer string');
  }
  if (!sameDecimal(amount, maxSourceAmount)) {
    throw new PermitAmountMismatchError('max_source_amount');
  }
}

/** Whether `amount`, spelled as a decimal integer with no leading zero, equals the validated `want`. */
function sameDecimal(amount: string, want: string): boolean {
  return typeof amount === 'string' && DECIMAL_UINT.test(amount) && BigInt(amount) === BigInt(want);
}

/**
 * UNIVERSAL (EVM/Tron): the permit deadline must be in the future (anti stale-replay). Solana
 * relies on its on-chain issued_at/nonce replay window instead.
 */
export function assertFresh(deadlineSec: number, nowSec: number): void {
  if (deadlineSec <= nowSec) {
    throw new Error('sender_auth: permit deadline is not in the future');
  }
}

/** OPT-IN (atum-escrow scheme): the Permit2 spender must be the source escrow. */
export function assertSpender(
  spender: string,
  escrow: string,
  normalize: (a: string) => string,
): void {
  if (!sameAddress(spender, normalize(escrow))) {
    throw new Error('sender_auth: permit spender is not the source escrow');
  }
}

/** OPT-IN (atum-escrow scheme): the deposit witness roles must match the challenge. */
export function assertWitnessRoles(
  reserver: string,
  releaser: string,
  expectedReserver: string,
  expectedReleaser: string,
  normalize: (a: string) => string,
): void {
  if (
    !sameAddress(reserver, normalize(expectedReserver)) ||
    !sameAddress(releaser, normalize(expectedReleaser))
  ) {
    throw new Error('sender_auth: deposit witness roles do not match the challenge');
  }
}

/**
 * Guards the opt-in witness binding: `reserver` and `releaser` must be supplied together, so a
 * half-configured verifier is rejected rather than skipping the witness-role check.
 */
export function assertRolePairComplete(reserver?: string, releaser?: string): void {
  if ((reserver === undefined) !== (releaser === undefined)) {
    throw new Error('sender_auth: reserver and releaser must be supplied together');
  }
}

/** Current unix time in seconds (verify-time clock; not part of any signed output). */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
