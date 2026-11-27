/*
 * Copyright 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Payer-side entry point for the Atum escrow MPP payment method.
 *
 * Register the returned method into your `mppx` client to pay for `atum-escrow`
 * challenges. The source-chain authorization is built and signed through the Atum
 * payment-gateway client, so a single code path supports EVM, Tron, and Solana sources.
 *
 * @example
 * ```ts
 * import { registerClient } from '@atumlabs/mppx-atum-escrow/client'
 *
 * const method = registerClient({ signer: { privateKey }, account: '0x…' })
 * // register `method` into your mppx client
 * ```
 *
 * @packageDocumentation
 */

// The single shared derivation for the payment's idempotency key; see the SDK for why the anchor
// must be per-intent rather than per-attempt.
import { canonicalDepositor } from '@atum-labs/payment-request-sender-auth';
import {
  PaymentGatewayClient,
  createSenderSigner,
  signPaymentRequest,
  type SenderSigner,
  type SenderSignerOptions,
  type SolanaClusterUnixTimeReader,
} from '@atum-labs/payment-gateway-client';
import { Credential, Method } from 'mppx';
import {
  atumEscrowChargeMethod,
  assetIdentifier,
  chainDefaultsFromExtra,
  chargeRequestId,
  intentIdOf,
  namespaceOf,
  INTENT_ID_META_KEY,
  caipEqual,
  type AtumEscrowExtra,
  type PaymentRequest,
} from './internal.js';
import {
  AtumEscrowTrustError,
  atumGatewayTrust,
  readTrustRefusal,
  readTrustedRoles,
  type AtumEscrowTrustErrorCode,
  type TrustResolver,
  type TrustedRoles,
} from './trust.js';
import { DEFAULT_MAX_MARKUP_BPS, DEFAULT_PEG_GROUPS, assertCapWithinBound } from './cap.js';

// Re-export the shared building blocks a payer integration needs, so `/client` is a
// complete entry point without importing from the package root.
export {
  atumEscrowChargeMethod,
  ChargeRequestSchema,
  CredentialPayloadSchema,
  METHOD_NAME,
  INTENT,
  INTENT_ID_META_KEY,
} from './internal.js';
export type {
  AtumEscrowChallenge,
  AtumEscrowCredential,
  ChargeRequest,
  ChargeCredentialPayload,
  PaymentRequest,
} from './internal.js';
export type { SenderSigner, SenderSignerOptions };
export { AtumEscrowTrustError, ATUM_DEFAULT_TRUST_GATEWAYS, atumGatewayTrust } from './trust.js';
export type {
  AtumEscrowTrustErrorCode,
  AtumGatewayTrustOptions,
  TrustResolver,
  TrustedRoles,
  TrustedToken,
} from './trust.js';
export { DEFAULT_MAX_MARKUP_BPS, DEFAULT_PEG_GROUPS } from './cap.js';

/* ─────────────────────────── Client (payer) config ─────────────────────────── */

/** Configuration for the payer side of the method. */
export interface AtumEscrowClientConfig {
  /**
   * How to sign the source-chain deposit authorization. Either a ready-made
   * {@link SenderSigner}, or options selecting the built-in private-key or Turnkey
   * provider ({@link SenderSignerOptions}), which are bound to the challenge's source
   * chain automatically.
   */
  signer: SenderSigner | SenderSignerOptions;
  /**
   * The payer's source-chain account (the depositor). Its chain-native form must match
   * the signing key; the server rejects a credential whose signature does not recover to it.
   */
  account: string;
  /** Clock (epoch ms) used to derive absolute deadlines from the challenge budgets. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Solana-only: supplies the `issued_at` a Solana deposit is stamped with, keeping the
   * build fully offline. Used only when the challenge does not carry a merchant-stamped
   * `extra.issuedAt` (which takes precedence); if neither is present, the client clock is
   * used. Ignored for EVM/Tron.
   */
  solanaClockReader?: SolanaClusterUnixTimeReader;
  /**
   * Where the payer learns which escrow, fulfillment proxy, reserver and releaser it trusts on a
   * chain. Every challenge is checked against it before anything is signed, and a challenge naming
   * any other address is refused.
   *
   * @remarks
   * Optional. Without it, the client asks Atum's production gateways (see
   * {@link atumGatewayTrust} and {@link ATUM_DEFAULT_TRUST_GATEWAYS}). Pass your own resolver to
   * trust another deployment — staging, a local devnet (which reuses mainnet chain ids), or another
   * operator — or a fixed set of addresses. The check itself cannot be turned off.
   */
  trust?: TrustResolver;
  /**
   * The most the cap (`source.amount`) may exceed `fulfillmentAmount`, in basis points, after both
   * are put in one unit. A larger cap is refused before signing. Defaults to
   * {@link DEFAULT_MAX_MARKUP_BPS}.
   */
  maxMarkupBps?: number;
  /**
   * Groups of token symbols the payer treats as the same money, so a cap in one can be priced
   * against a fulfillment in another. Replaces {@link DEFAULT_PEG_GROUPS}; a token outside every
   * group is comparable only with itself.
   */
  pegGroups?: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * Configure the payer side of the method.
 *
 * The returned method builds and signs an Atum payment request from an incoming
 * challenge and serializes it into an MPP credential. The source-chain authorization is
 * built through the payment-gateway client's request builder, so the same call handles
 * EVM, Tron, and Solana sources.
 *
 * Idempotency: the `request_id` is derived from the challenge's per-intent identifier (see
 * {@link INTENT_ID_META_KEY}) via the shared sender_auth SDK, and `preparePaymentRequest` then
 * derives the deposit nonce from that `request_id` on every chain. So rebuilding the credential
 * for the same purchase reproduces the same payment identity, and the gateway de-duplicates the
 * retry onto the original payment instead of charging twice. On EVM/Tron the reused Permit2
 * nonce is a second, on-chain backstop (the duplicate deposit reverts); on Solana the replay
 * nonce is only remembered for 256-512s (the authorization itself is valid for 128s), so there
 * the gateway's `request_id` dedup is the durable protection.
 *
 * A challenge that carries no such identifier cannot be paid safely, so this client refuses it
 * rather than falling back to something per-attempt. See
 * {@link ../server!buildChargeChallenge | buildChargeChallenge} for the merchant side.
 *
 * @param config - the payer's signer, source account, and options.
 */
export function registerClient(config: AtumEscrowClientConfig) {
  const now = config.now ?? (() => Date.now());
  const trust = config.trust ?? atumGatewayTrust();
  const maxMarkupBps = config.maxMarkupBps ?? DEFAULT_MAX_MARKUP_BPS;
  if (!Number.isInteger(maxMarkupBps) || maxMarkupBps < 0) {
    throw new Error(
      'atum-escrow: maxMarkupBps must be a non-negative integer number of basis points',
    );
  }
  const pegGroups = config.pegGroups ?? DEFAULT_PEG_GROUPS;
  // A gateway client used only for its offline `preparePaymentRequest` assembly. Because
  // every corridor address comes from the challenge (passed in below, after the trust check),
  // prepare resolves nothing from the network — no base URL is used and no request is ever sent.
  const gateway = new PaymentGatewayClient();
  return Method.toClient(atumEscrowChargeMethod, {
    async createCredential({ challenge }): Promise<string> {
      const { source, extra } = challenge.request;
      const namespace = namespaceOf(source.network);
      const account = config.account;

      // The corridor's deadline budgets are relative seconds-from-now, and both are added to the
      // same `now`, so the ordering the gateway requires reduces here to quote < fulfillment with
      // both positive. Worth being precise about what this can and cannot catch: staleness is not
      // in scope, because the absolute timestamps are minted from `now` below, after the trust
      // lookup.
      // A failure means the CHALLENGE is misconfigured, so it is reported as that rather than
      // borrowing the server's ordering wording — the server checks signed absolute timestamps and
      // can additionally find them expired, which is a payer-recoverable situation. This one is not.
      if (!(
        extra.quoteDeadlineSeconds > 0 &&
        extra.quoteDeadlineSeconds < extra.fulfillmentDeadlineSeconds
      )) {
        throw new Error(
          "atum-escrow: the challenge's deadline budgets cannot produce a settleable payment. " +
            'quoteDeadlineSeconds must be above zero and below fulfillmentDeadlineSeconds, because ' +
            'quote collection has to close before settlement is due. Got ' +
            `quoteDeadlineSeconds=${extra.quoteDeadlineSeconds}, ` +
            `fulfillmentDeadlineSeconds=${extra.fulfillmentDeadlineSeconds}. These come from the ` +
            'corridor the resource server offered, so this is a merchant-side configuration ' +
            'problem rather than anything a payer can correct.',
        );
      }

      // Idempotency anchor. The request_id is derived deterministically from the merchant's
      // per-intent identifier, so a rebuild-on-retry reproduces the same payment identity and
      // the gateway resolves the retry to the original payment rather than charging again.
      //
      // The challenge id is deliberately NOT the anchor, even though it looks like a natural
      // one: it is an HMAC over the challenge's own fields, so it tracks the terms and the
      // expiry rather than the purchase. A merchant that stamps a rolling `expires` gets a new
      // id per attempt, which would make every retry a second payment; a merchant that stamps
      // nothing gets one shared id for two identical purchases, which would collapse them onto
      // a single payment and leave the second unpaid. Only an identifier whose lifetime IS the
      // purchase gets both cases right.
      //
      // Refusing an unstamped challenge is deliberate, and there is no per-attempt fallback: a
      // fresh value each build looks like an idempotency key while letting every retry become a
      // second payment — exactly the failure this derivation exists to prevent.
      //
      // Derivation lives in the shared sender_auth SDK rather than here, so mppx, x402 and any
      // other consumer share ONE recipe (address canonicalization included) instead of drifting
      // copies. `req_mpp_` marks MPP-originated payments in gateway/settler logs.
      const intentId = intentIdOf(challenge);
      if (intentId === undefined) {
        throw new Error(
          `atum-escrow: the challenge carries no '${INTENT_ID_META_KEY}' metadata, so this ` +
            'payment cannot be made retry-safe and is refused. The merchant must stamp a stable ' +
            'per-purchase identifier into the challenge metadata (see buildChargeChallenge); ' +
            'without it a retry would be charged as a second payment.',
        );
      }
      const requestId = chargeRequestId(intentId, account);

      // The price is checked for format first. It is not signed, and the cap bound below is
      // computed from it, so it must have exactly one reading: `BigInt` would also accept hex,
      // binary, octal, padding and the empty string, which a payer reading the price as decimal
      // would not see as the same number.
      if (
        typeof extra.fulfillmentAmount !== 'string' ||
        !/^[0-9]+$/.test(extra.fulfillmentAmount)
      ) {
        throw new Error(
          `atum-escrow: the challenge's fulfillmentAmount must be a base-10 integer in the ` +
            `destination token's smallest units, got ${JSON.stringify(extra.fulfillmentAmount)}`,
        );
      }
      // Built before the trust lookup because they reject a chain this package cannot pay on, so
      // a merchant-named unsupported chain fails here rather than being looked up first.
      const sourceAssetId = assetIdentifier(source.network, source.asset);
      const destinationAssetId = assetIdentifier(
        extra.destination.network,
        extra.destination.asset,
      );
      // Before anything is assembled or signed: these addresses decide where the deposit can go
      // and who may release it, and the merchant wrote them, so a corridor the payer's trust
      // source does not vouch for is refused here.
      const corridor = await assertTrustedCorridor(trust, source.network, extra);

      // Assemble the signable request through the payment-gateway client's
      // `preparePaymentRequest` in offline mode: we pass the challenge's own corridor
      // addresses (via `resolvedDefaults`), now checked against the trust source, and inject our
      // clock. It is passed live rather than read here: bidding closes at quote_deadline, and the
      // builder reads the clock only after its own reads (the Solana issue time included), so
      // neither those nor the trust lookup above (seconds on a cold cache) come out of the
      // window settlers have to quote. The trusted values are compared, never substituted, so
      // the signed digest and serialized prehash stay byte-identical to what the gateway and
      // settler reconstruct from the challenge on verify. The source cap is fed as the deposit
      // amount: the gateway pins the signed deposit amount to `max_source_amount`, which is the
      // cap.
      const sourceDefaults = chainDefaultsFromExtra(extra, source.network);
      const isSolana = namespace === 'solana';
      // Captured once so the async clock-reader closure below sees a non-optional string.
      const solanaIssuedAt = extra.issuedAt;
      const paymentRequestGw = await gateway.preparePaymentRequest({
        depositor: account,
        fulfillmentAmount: extra.fulfillmentAmount,
        sourceAsset: sourceAssetId,
        destinationAccount: extra.destination.address,
        destinationAsset: destinationAssetId,
        // The merchant's cap, held to fulfillmentAmount plus maxMarkupBps before it is signed.
        // It is the most the escrow may ever pull from the payer: an honest auction charges
        // less, but a merchant acting as reserver could charge all of it.
        maxSourceAmount: source.amount,
        requestId,
        quoteDeadlineSeconds: extra.quoteDeadlineSeconds,
        fulfillmentDeadlineSeconds: extra.fulfillmentDeadlineSeconds,
        now,
        resolvedDefaults: {
          source: sourceDefaults,
          destination: { fulfillmentProxy: extra.fulfillmentProxy },
        },
        // EVM/Tron: thread the deterministic nonce, and keep the deposit deadline at least
        // as late as the fulfillment deadline. The adapter floors the relative deadline, so
        // +1s guards against truncating below fulfillment_deadline.
        ...(isSolana
          ? {
              // Solana stamps issued_at and derives its own replay-window deadline. Prefer the
              // merchant-stamped `extra.issuedAt` (self-contained 402, no client RPC); fall back
              // to an injected reader, then the client clock, when the 402 doesn't carry it.
              solanaRpcUrl: 'atum-escrow:offline',
              solanaClockReader:
                solanaIssuedAt != null
                  ? async () => BigInt(solanaIssuedAt)
                  : (config.solanaClockReader ?? (async () => BigInt(Math.floor(now() / 1000)))),
            }
          : {
              // No explicit nonce: `preparePaymentRequest` derives it from
              // (request_id, depositor) via the shared sender_auth SDK — the same
              // Go-parity-locked derivation every consumer uses. Since request_id is itself
              // anchored on the intentId above, a rebuild reproduces the same single-use
              // permit. Overriding it here would fork a second nonce recipe for no gain.
              //
              // Keep the deposit deadline at least as late as fulfillment. pgc converts this
              // relative budget to an absolute permit deadline against the same clock; round
              // the budget up and add a second so it never truncates below fulfillment_deadline.
              deadlineSeconds: Math.ceil(extra.fulfillmentDeadlineSeconds) + 1,
            }),
      });

      // After prepare, which has refused a cap that is not a canonical positive integer with its
      // own error, and before the signer is built.
      assertCapWithinBound({
        sourceNetwork: source.network,
        sourceAsset: source.asset,
        sourceTokens: corridor.source.tokens,
        destinationNetwork: extra.destination.network,
        destinationAsset: extra.destination.asset,
        destinationTokens: corridor.destination.tokens,
        amount: source.amount,
        fulfillmentAmount: extra.fulfillmentAmount,
        maxMarkupBps,
        pegGroups,
        fields: {
          amount: 'source.amount',
          sourceAsset: 'source.asset',
          destinationAsset: 'extra.destination.asset',
        },
      });

      // Precondition (not verified here): the payer must have approved the source escrow to
      // move the source token (see `ensureSourceApproval`), or the deposit reverts at settle.

      // Sign every entry in sender_auth (Solana also attaches the delegate signer public
      // key, since ed25519 signatures are not recoverable). signPaymentRequest mutates the
      // request in place (filling each signature, and Solana's delegate_signer).
      const signer = buildSenderSigner(source.network, config.signer, account);
      await signPaymentRequest(paymentRequestGw, signer);

      // The gateway client and the schema-declarations binding describe the same wire
      // PaymentRequest with two nominally-distinct types; they are interchangeable here.
      const paymentRequest = paymentRequestGw as unknown as PaymentRequest;

      // Build the credential once per payment and resubmit the identical bytes on retry —
      // never rebuild — so the gateway's content-keyed dedup recognizes the retry.
      return Credential.serialize({
        challenge,
        payload: { paymentRequest },
        source: `did:pkh:${source.network}:${canonicalDepositor(account)}`,
      });
    },
  });
}

/* ─────────────────────────────── Corridor trust ─────────────────────────────── */

/**
 * Refuse a challenge whose escrow, reserver or releaser is not what the trust source vouches for
 * on the source chain, or whose fulfillment proxy is not what it vouches for on the destination
 * chain, where the proxy runs.
 */
async function assertTrustedCorridor(
  trust: TrustResolver,
  source: string,
  extra: AtumEscrowExtra,
): Promise<{ source: TrustedRoles; destination: TrustedRoles }> {
  const destination = extra.destination.network;
  const [onSource, onDestination] = await Promise.all([
    resolveTrust(trust, source),
    destination === source ? undefined : resolveTrust(trust, destination),
  ]);
  // Undefined only for a same-chain corridor: resolveTrust refuses an answer that is not
  // well-formed roles, so a chain the resolver has no entry for never borrows the source chain's.
  const destinationRoles = onDestination ?? onSource;

  const checks: Array<[AtumEscrowTrustErrorCode, string, string, string, string]> = [
    ['UNTRUSTED_ESCROW', 'extra.escrow', source, onSource.escrowContract, extra.escrow],
    ['UNTRUSTED_RESERVER', 'extra.reserver', source, onSource.quoteSelector, extra.reserver],
    [
      'UNTRUSTED_RELEASER',
      'extra.releaser',
      source,
      onSource.fulfillmentVerifierAccount,
      extra.releaser,
    ],
    [
      'UNTRUSTED_FULFILLMENT_PROXY',
      'extra.fulfillmentProxy',
      destination,
      destinationRoles.fulfillmentProxy,
      extra.fulfillmentProxy,
    ],
  ];
  for (const [code, field, network, expected, actual] of checks) {
    if (!caipEqual(network, expected, actual)) {
      throw new AtumEscrowTrustError({
        code,
        network,
        field,
        expected,
        actual,
        message: `atum-escrow: ${field} ${actual} is not trusted on ${network} (trusted: ${expected})`,
      });
    }
  }
  return { source: onSource, destination: destinationRoles };
}

async function resolveTrust(trust: TrustResolver, network: string): Promise<TrustedRoles> {
  let answer: unknown;
  try {
    answer = await trust(network);
  } catch (err) {
    if (err instanceof AtumEscrowTrustError) throw err;
    // A refusal from another copy of this module keeps its verdict: re-labelling a sibling
    // package's CHAIN_NOT_TRUSTED as unavailable would present a permanent refusal as retryable.
    const refusal = readTrustRefusal(err);
    if (refusal) {
      throw new AtumEscrowTrustError({
        code: refusal.code,
        network,
        field: refusal.field,
        expected: refusal.expected,
        actual: refusal.actual,
        cause: err,
        message: refusal.message.startsWith('atum-escrow:')
          ? refusal.message
          : `atum-escrow: ${refusal.message}`,
      });
    }
    throw new AtumEscrowTrustError({
      code: 'TRUST_SOURCE_UNAVAILABLE',
      network,
      cause: err,
      message: `atum-escrow: the trust source failed for ${network}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  // A custom resolver is not checked at run time: one can answer `undefined` for a chain it has no
  // entry for (an unchecked index into a table) or roles with a field missing, and neither is the
  // same as vouching for nothing.
  const roles = readTrustedRoles(answer);
  if (!roles) {
    throw new AtumEscrowTrustError({
      code: 'TRUST_SOURCE_UNAVAILABLE',
      network,
      message: `atum-escrow: the trust source answered ${network} with something other than well-formed roles`,
    });
  }
  return roles;
}

/* ─────────────────────────────── Signer resolution ─────────────────────────────── */

/** True if a value is a ready-made SenderSigner (rather than provider options). */
function isSenderSigner(signer: SenderSigner | SenderSignerOptions): signer is SenderSigner {
  return typeof (signer as SenderSigner).sign === 'function';
}

/**
 * Resolve a {@link SenderSigner} for the challenge's source chain. A ready-made signer is
 * used as-is; provider options (raw or Turnkey) are handed to the payment-gateway client's
 * `createSenderSigner`, which binds them to the source chain and checks them against the
 * payer account (pinnedAddress) so a wrong key/wallet fails fast. A malformed pin is refused
 * synchronously here; Turnkey's address comparison needs a network call, so a wallet that
 * resolves to a different address fails on first `sign()`.
 */
function buildSenderSigner(
  network: string,
  signer: SenderSigner | SenderSignerOptions,
  account: string,
): SenderSigner {
  if (isSenderSigner(signer)) {
    return signer;
  }
  // createSenderSigner formats/verifies a raw key, or constructs a TurnkeySenderSigner, per
  // `provider`. Default pinnedAddress to the payer's own account for either provider, so a
  // misconfigured signer fails fast regardless of which one is in use.
  //
  // Blank means the same thing here as it does in pgc, which reads it as trimming to empty. An
  // unset variable arrives as an empty string and a value read from a file arrives with a newline,
  // and both mean unpinned, so both fall back rather than one falling back and the other erroring.
  // A non string is forwarded untouched so pgc names the field instead of failing on `trim`, and a
  // padded but real address is forwarded as given, since only the branch uses the trimmed form.
  const pin = signer.pinnedAddress;
  const unpinned = pin == null || (typeof pin === 'string' && pin.trim() === '');
  return createSenderSigner(network, {
    ...signer,
    pinnedAddress: unpinned ? account : pin,
  });
}

/* ─────────────────────────── Payer wallet helpers ─────────────────────────── */

/**
 * Permit2 approval for the source token, re-exported from the shared token-approval package
 * so this method, the x402 scheme and payment-gateway-client cannot drift apart on it.
 *
 * On EVM and Tron the escrow moves the source token through Permit2, so the payer must have
 * approved Permit2 on that token before paying, or the deposit reverts at settlement. The
 * method validates only what it builds and signs, so it neither checks nor arranges this;
 * these are offered for payers who would rather not write the token calls themselves.
 *
 * Pass an ethers signer for an EVM source or a TronWeb instance for a Tron one.
 * {@link needsSourceApproval} answers the same question without sending anything, so it is
 * safe to call before every charge. Solana authorizes the transfer inside the signed deposit
 * itself and reports that no approval is needed.
 *
 * {@link isUnconfirmed} tells a broadcast-but-unseen approval apart from one that failed. The wait
 * for a confirmation is bounded, and hitting that bound is not a failure: the transaction may
 * confirm a moment later, so a caller that treats the two alike sends a second approval on top of
 * one already landing.
 */
export {
  ensureSourceApproval,
  needsSourceApproval,
  isUnconfirmed,
} from '@atum-labs/payment-request-token-approval';
export type {
  ApprovalParams,
  ConfirmationOptions,
  EnsureApprovalResult,
  TronWebLike,
} from '@atum-labs/payment-request-token-approval';
