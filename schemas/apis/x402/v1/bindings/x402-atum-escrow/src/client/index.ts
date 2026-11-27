/**
 * atum-escrow client mechanism — the payer side.
 *
 * Implements the x402 SchemeNetworkClient for the `atum-escrow` scheme. Given a
 * selected 402 requirement (carrying `extra.atum`), it builds the Atum
 * PaymentRequest locally, builds the escrow-deposit authorization with the shared
 * sender_auth library, signs it with the payer's key, and returns the payload.
 */

import type {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadContext,
  PaymentPayloadResult,
} from '@x402/core/types';
import { assertAtumEscrowExtra, type AtumEscrowExtra, type PaymentRequest } from '../contract';
import { getChainAdapter } from '../chain-adapters';
import type { AuthSigner, EscrowSigner, SolanaSigner, StellarSigner } from '../chain-adapters';
import {
  assertStellarSignable,
  getChainAdapter as senderAuthAdapter,
  deterministicPermitNonce,
  deterministicSolanaNonce,
  deterministicStellarNonce,
} from '@atum-labs/payment-request-sender-auth';
import { atumEscrowRequestId, requireAtumResource } from '../request-id';
import { echoPaymentIdentifier, resolvePaymentIdentifier } from '../payment-identifier';
import { toSenderSigner } from './sender-signer';
import { caipEqual } from '../internal';
import {
  AtumEscrowTrustError,
  atumGatewayTrust,
  type AtumEscrowTrustErrorCode,
  type TrustResolver,
  type TrustedRoles,
} from './trust';
import { DEFAULT_MAX_MARKUP_BPS, assertCapWithinBound } from './cap';
import { DEFAULT_PEG_GROUPS } from '../peg';

export type { AuthSigner, EscrowSigner, SolanaSigner, StellarSigner };

/**
 * Configuration for {@link AtumEscrowClientScheme}.
 *
 * @public
 */
export interface AtumEscrowClientConfig {
  /**
   * Signs the source escrow-deposit authorization; its address is the payer/source
   * account. An `ethers` signer (EVM/Tron) or an Ed25519 `SolanaSigner` / `StellarSigner`, chosen to match
   * the source chain being paid from.
   */
  signer: AuthSigner;
  /**
   * Wall-clock source, in epoch milliseconds, used to materialize absolute
   * deadlines from the relative budgets in `extra.atum`. Injectable for
   * deterministic tests; defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Reads the Solana cluster's unix time, in epoch **seconds**, for the CAIP-2 source
   * network being paid from. Used to stamp the deposit authorization's `issued_at`.
   *
   * @remarks
   * The escrow admits a deposit only while `issued_at <= clusterNow <= issued_at + 128`, judged
   * against the cluster clock, which lags real time; an `issued_at` from a wall clock risks being
   * refused as issued in the future.
   *
   * Return a **safe lower bound** on cluster time: an RPC node slightly ahead in slots can answer
   * above consensus, which is the direction the escrow refuses, so trim a small guard. The value
   * is used verbatim.
   *
   * Optional. Without it, `issued_at` is the local clock back-dated by
   * {@link SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS}, which spends part of the settlement window.
   * Ignored for EVM and Tron sources, whose deposit deadline is absolute.
   */
  solanaClockReader?: (chainId: string) => Promise<bigint>;
  /**
   * Reads the Stellar ledger's close time, in epoch **seconds**, for the CAIP-2 source network
   * being paid from (for example `stellar:testnet`). Used to stamp the deposit's `issued_at`.
   *
   * @remarks
   * The escrow refuses a deposit whose `issued_at` is ahead of the ledger, and bounds
   * `deadline - issued_at` to a day. Return the latest closed ledger's close time, or a safe lower
   * bound on it; the value is used verbatim.
   *
   * Optional. Without it, `issued_at` is the shared sender_auth builder's own fallback, the local
   * clock back-dated by a few seconds. Ignored for every source but Stellar.
   */
  stellarClockReader?: (network: string) => Promise<bigint>;
  /**
   * Reads the `epoch` of the payer's delegate record on the Stellar escrow, from `get_delegate`
   * for the payer and the token. **Required for a Stellar source.**
   *
   * @remarks
   * The signed deposit commits to that epoch, which is on-chain state: a deposit signed under one
   * record is void under a later one, so the client does not guess it. A source with no delegate
   * registered for the payer (`create_delegate`) has no epoch to read, and the reader should throw.
   * Without this reader a Stellar payment is refused before anything is signed. Ignored for every
   * source but Stellar.
   */
  stellarDelegateEpochReader?: (
    query: StellarDelegateEpochQuery,
  ) => Promise<bigint | number | string>;
  /**
   * Where the payer learns which escrow, fulfillment proxy, reserver and releaser it trusts on a
   * chain. Every payment is checked against it before anything is signed, and a requirement naming
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
   * The most the cap (`amount`) may exceed `fulfillmentAmount`, in basis points, after both are
   * put in one unit. A larger cap is refused before signing. Defaults to
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
 * What {@link AtumEscrowClientConfig.stellarDelegateEpochReader} is asked: whose delegate record,
 * for which token, on which escrow.
 *
 * @public
 */
export interface StellarDelegateEpochQuery {
  /** The CAIP-2 source network, e.g. `stellar:testnet`. */
  readonly network: string;
  /** The escrow contract (`C…` strkey) the requirement names. */
  readonly escrow: string;
  /** The payer account (`G…` strkey), which is also the delegate key. */
  readonly depositor: string;
  /** The source token's contract id (`C…` strkey). */
  readonly token: string;
}

/**
 * Seconds by which the local clock is back-dated when no {@link
 * AtumEscrowClientConfig.solanaClockReader} is supplied.
 *
 * @remarks
 * An `issued_at` ahead of the Solana cluster clock is refused (`FutureTransaction`), and one far
 * enough behind puts the signed deadline (`issued_at + 120`) in the past. Back-dating by 45
 * seconds tolerates about 45 seconds of fast payer clock or cluster lag and about 75 of slow
 * clock, leaving 75 of the 120-second window for settlement.
 *
 * @public
 */
export const SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS = 45n;

/**
 * The payer side of the `atum-escrow` x402 scheme. Register one instance into an
 * `x402Client`; it answers a 402 by building and signing the payment locally.
 *
 * @remarks
 * Precondition: the source token must already have an `approve(Permit2)`
 * allowance covering the spend, or the escrow deposit reverts at settle. This
 * mechanism does not check that on-chain state; {@link ensureSourceApproval} is an
 * optional helper for granting it.
 *
 * @example
 * ```ts
 * import { ethers } from "ethers";
 * import { x402Client } from "@x402/core/client";
 * import { AtumEscrowClientScheme } from "@atumlabs/x402-atum-escrow/client";
 *
 * const scheme = new AtumEscrowClientScheme({ signer: new ethers.Wallet(PRIVATE_KEY) });
 * const client = new x402Client();
 * client.register("eip155:8453", scheme);
 * ```
 *
 * @public
 */
export class AtumEscrowClientScheme implements SchemeNetworkClient {
  readonly scheme = 'atum-escrow';

  private readonly signer: AuthSigner;
  private readonly now: () => number;
  private readonly solanaClockReader: (chainId: string) => Promise<bigint>;
  private readonly stellarClockReader: ((network: string) => Promise<bigint>) | undefined;
  private readonly stellarDelegateEpochReader: AtumEscrowClientConfig['stellarDelegateEpochReader'];
  private readonly trust: TrustResolver;
  private readonly maxMarkupBps: number;
  private readonly pegGroups: ReadonlyArray<ReadonlyArray<string>>;

  constructor(config: AtumEscrowClientConfig) {
    this.signer = config.signer;
    this.trust = config.trust ?? atumGatewayTrust();
    this.maxMarkupBps = config.maxMarkupBps ?? DEFAULT_MAX_MARKUP_BPS;
    if (!Number.isInteger(this.maxMarkupBps) || this.maxMarkupBps < 0) {
      throw new Error(
        'atum-escrow: maxMarkupBps must be a non-negative integer number of basis points',
      );
    }
    this.pegGroups = config.pegGroups ?? DEFAULT_PEG_GROUPS;
    this.now = config.now ?? (() => Date.now());
    // Defaulted here rather than left to the sender-auth adapter, whose own fallback is a raw
    // wall clock: unbuffered, that is the one reading the escrow refuses outright.
    this.stellarClockReader = config.stellarClockReader;
    this.stellarDelegateEpochReader = config.stellarDelegateEpochReader;
    this.solanaClockReader =
      config.solanaClockReader ??
      (async () => BigInt(Math.floor(this.now() / 1000)) - SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS);
  }

  /**
   * Build and sign the payment for a selected requirement.
   *
   * @param x402Version - the x402 protocol version (echoed into the payload)
   * @param paymentRequirements - the selected atum-escrow requirement (with `extra.atum`)
   * @param context - the extensions the resource server declared in its 402, which is where the
   *   purchase's identifier is read from
   * @returns the payload result; the framework wraps it with the `accepted` requirement and merges
   *   the returned extensions onto the server's declarations
   * @throws if no usable purchase identifier is available, if `extra.atum` is missing or malformed,
   *   or if the network is not supported
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const atum = requireAtumExtra(paymentRequirements);
    // Select the source-chain adapter first: it resolves the payer address in the
    // chain's form (EVM derives from the key; Solana reads the public key), so the
    // client never learns per-chain signer shapes. Selecting both adapters here also lets a chain
    // this package cannot pay on fail as unsupported, before any trust source is asked about it.
    const adapter = getChainAdapter(paymentRequirements.network);
    const destinationAdapter = getChainAdapter(atum.destination.network);
    // Before the payer's key is touched: these addresses decide where the deposit can go and who
    // may release it, so a corridor the payer does not trust is never signed.
    const corridor = await this.assertTrustedCorridor(paymentRequirements, atum);
    assertCapWithinBound({
      sourceNetwork: paymentRequirements.network,
      sourceAsset: paymentRequirements.asset,
      sourceTokens: corridor.source.tokens,
      destinationNetwork: atum.destination.network,
      destinationAsset: atum.destination.asset,
      destinationTokens: corridor.destination.tokens,
      amount: paymentRequirements.amount,
      fulfillmentAmount: atum.fulfillmentAmount,
      maxMarkupBps: this.maxMarkupBps,
      pegGroups: this.pegGroups,
    });
    const payer = await adapter.getAddress(this.signer);
    const sourceAssetId = adapter.assetIdentifier(
      paymentRequirements.network,
      paymentRequirements.asset,
    );
    // Bidding closes at quote_deadline, so every read the payer makes comes before the clock that
    // stamps it: a cluster-clock read (often an RPC call) must not come out of the window settlers
    // have to quote. The reader is asked for the chain id the deposit builder would pass it.
    const namespace = paymentRequirements.network.split(':')[0];
    const isSolana = namespace === 'solana';
    const isStellar = namespace === 'stellar';
    const solanaIssuedAt = isSolana
      ? await this.solanaClockReader(sourceAssetId.split('/')[0]!)
      : undefined;
    // Stellar: the deposit commits to the epoch of the payer's delegate record, which is on-chain
    // state, so it is read rather than assumed, and its issue time is the ledger's close time when
    // a reader is supplied.
    const stellarIssuedAt =
      isStellar && this.stellarClockReader !== undefined
        ? await this.stellarClockReader(paymentRequirements.network)
        : undefined;
    const stellarDelegateEpoch = isStellar
      ? await this.readStellarDelegateEpoch(paymentRequirements, atum.escrow, payer)
      : undefined;
    const nowMs = this.now();

    const quoteDeadlineMs = nowMs + atum.quoteDeadlineSeconds * 1000;
    const fulfillmentDeadlineMs = nowMs + atum.fulfillmentDeadlineSeconds * 1000;
    // A misconfigured corridor (quote budget >= fulfillment budget) fails here rather than
    // emitting a request the facilitator would reject.
    if (!(nowMs < quoteDeadlineMs && quoteDeadlineMs < fulfillmentDeadlineMs)) {
      throw new Error(
        `atum-escrow: deadline ordering violated (now < quote_deadline < fulfillment_deadline); ` +
          `quoteDeadlineSeconds=${atum.quoteDeadlineSeconds}, fulfillmentDeadlineSeconds=${atum.fulfillmentDeadlineSeconds}`,
      );
    }
    const quoteDeadline = new Date(quoteDeadlineMs).toISOString();
    const fulfillmentDeadline = new Date(fulfillmentDeadlineMs).toISOString();
    // The Permit2 authorization must stay valid until settlement completes, so its
    // deadline tracks the (later) fulfillment deadline, in absolute epoch seconds.
    const permitDeadlineSec = Math.floor(fulfillmentDeadlineMs / 1000);

    // `request_id` derives from the identifier and the page, so a re-attempt resolves to the
    // original payment. No generated fallback.
    const identifier = resolvePaymentIdentifier(context?.extensions);
    const requestId = atumEscrowRequestId(
      identifier,
      payer,
      requireAtumResource(paymentRequirements),
    );
    // The destination the signed deposit commits to, derived once and reused for
    // paymentRequest.destination[0]: the escrow stores only keccak256(bytes(destination)), so
    // any formatting difference between the two is a different payee. Built by the destination
    // chain's adapter, which may differ from the source's.
    const destinationAssetId = destinationAdapter.assetIdentifier(
      atum.destination.network,
      atum.destination.asset,
    );
    const destinationAccount = atum.destination.address;

    // Built by the shared sender_auth library that verifiers also use. The nonce is derived from
    // (request_id, depositor), so rebuilding the same payment yields the same authorization.
    // Each family has its own nonce space: a 256-bit Permit2 word on EVM/Tron, a replay-window
    // slot on Solana and an unordered u64 on Stellar.
    const depositNonce = isSolana
      ? deterministicSolanaNonce({ requestId, depositor: payer })
      : isStellar
        ? deterministicStellarNonce({ requestId, depositor: payer })
        : deterministicPermitNonce({ requestId, depositor: payer });
    // The body is final before the deposit is built: depositRequestHash v2 is the hash of its
    // terms, so the deposit signs exactly this body and sender_auth is the only member added after.
    const body = {
      version: '1.0',
      request_id: requestId,
      source: {
        asset_identifier: sourceAssetId,
        account: payer,
      },
      destination: [
        {
          // The destination the deposit commits to: the adapter reads it back from this body.
          asset_identifier: destinationAssetId,
          account: destinationAccount,
        },
      ],
      fulfillment_amount: atum.fulfillmentAmount,
      // The full advertised cap. The scheme allows a lower value, but that risks the auction
      // not clearing and never changes the receive side.
      max_source_amount: paymentRequirements.amount,
      quote_deadline: quoteDeadline,
      fulfillment_deadline: fulfillmentDeadline,
      // Corridor addresses from the 402's extra.atum, already checked against the trust source.
      // reserver is quote_selector and releaser is fulfillment_verifier.account; both are put in
      // the form the signed witness uses (Tron: base58 to hex). escrow_contract_address is left
      // as-is (base58 on Tron).
      escrow_contract_address: atum.escrow,
      quote_selector: adapter.normalizeRoleAddress(atum.reserver),
      fulfillment_verifier: {
        account: adapter.normalizeRoleAddress(atum.releaser),
        endpoint: atum.fulfillmentVerifierEndpoint,
      },
      fulfillment_proxy: atum.fulfillmentProxy,
    } satisfies Partial<PaymentRequest>;

    const authMessage = await senderAuthAdapter(paymentRequirements.network).buildAuthMessage({
      sourceAsset: sourceAssetId,
      depositor: payer,
      // The signed cap (== max_source_amount above).
      maxSourceAmount: paymentRequirements.amount,
      // The request id and the destination the escrow's witness commits are read from the body.
      paymentRequestJSON: JSON.stringify(body),
      // v2 only when the merchant's facilitator lists it; an absent list means [1].
      depositRequestHashVersion: atum.depositRequestHashVersions?.includes(2) ? 2 : 1,
      sourceDefaults: {
        escrowContract: atum.escrow,
        quoteSelector: atum.reserver,
        fulfillmentVerifierAccount: atum.releaser,
        fulfillmentVerifierEndpoint: atum.fulfillmentVerifierEndpoint,
        fulfillmentProxy: atum.fulfillmentProxy,
        svmSignatureClusterId: atum.svmSignatureClusterId,
        svmSignatureDomainVersion: atum.svmSignatureDomainVersion,
      },
      // Ignored by Solana (its deadline is the on-chain replay window off issued_at).
      deadline: permitDeadlineSec,
      nonce: depositNonce,
      // The Solana issue time, already read above. Unused for EVM/Tron.
      ...(solanaIssuedAt !== undefined ? { solanaClockReader: async () => solanaIssuedAt } : {}),
      // The Stellar issue time (when a reader was supplied) and the delegate record's epoch, both
      // read above. Unused for EVM, Tron and Solana.
      ...(stellarIssuedAt !== undefined ? { issuedAt: stellarIssuedAt } : {}),
      ...(stellarDelegateEpoch !== undefined ? { delegateEpoch: stellarDelegateEpoch } : {}),
    });

    const toSign = {
      message: authMessage.messageHash,
      message_prehash: authMessage.messagePrehash,
      signature: '',
    };
    // A Stellar key signs 32 bytes with plain ed25519, which is also how a Stellar transaction is
    // signed over its hash, so refuse to sign bytes that are not the deposit digest of their own
    // prehash under this network and escrow. The message was just built here, so this holds by
    // construction; it keeps the payer's key from signing anything else if that ever stops being so.
    if (paymentRequirements.network.startsWith('stellar:')) {
      assertStellarSignable(toSign, paymentRequirements.network, atum.escrow);
    }

    // Signs the digest the facilitator reconstructs on verify. Solana and Stellar disclose the
    // signer key as delegate_signer (Ed25519 is not recoverable); EVM/Tron return none.
    const { signature, delegateSigner } = await toSenderSigner(
      paymentRequirements.network,
      this.signer,
    ).sign(toSign);

    const paymentRequest: PaymentRequest = {
      ...body,
      sender_auth: {
        message_scheme: authMessage.messageScheme,
        // message is the digest; message_prehash is the JSON verifiers parse to recompute it.
        // payload.delegate_signer is present only for a non-recoverable (Solana, Stellar) signature.
        signed_messages: [
          {
            message: authMessage.messageHash,
            message_prehash: authMessage.messagePrehash,
            signature,
            ...(delegateSigner ? { payload: { delegate_signer: delegateSigner } } : {}),
          },
        ],
      },
    };

    // Echo the identifier so the resource server and the facilitator can re-derive
    // `request_id`. The resolver refuses any value the extension would not permit.
    return {
      x402Version,
      payload: { paymentRequest },
      extensions: echoPaymentIdentifier(identifier),
    };
  }

  /**
   * The `epoch` of the payer's delegate record on the Stellar escrow, which the signed deposit
   * commits to. Refused before anything is signed when no reader was configured, because the epoch
   * is on-chain state that a guess would sign wrongly.
   */
  private async readStellarDelegateEpoch(
    requirements: PaymentRequirements,
    escrow: string,
    depositor: string,
  ): Promise<bigint | number | string> {
    if (this.stellarDelegateEpochReader === undefined) {
      throw new Error(
        'atum-escrow: a Stellar source needs stellarDelegateEpochReader, which reads the epoch of ' +
          "the payer's delegate record from the escrow (get_delegate); the deposit commits to it",
      );
    }
    return this.stellarDelegateEpochReader({
      network: requirements.network,
      escrow,
      depositor,
      token: requirements.asset,
    });
  }

  /**
   * Refuse a requirement whose escrow, `payTo`, reserver or releaser is not what the trust source
   * vouches for on the source chain, or whose fulfillment proxy is not what it vouches for on the
   * destination chain, where the proxy runs.
   */
  private async assertTrustedCorridor(
    requirements: PaymentRequirements,
    atum: AtumEscrowExtra,
  ): Promise<{ source: TrustedRoles; destination: TrustedRoles }> {
    const source = requirements.network;
    const destination = atum.destination.network;
    const [onSource, onDestination] = await Promise.all([
      this.resolveTrust(source),
      destination === source ? undefined : this.resolveTrust(destination),
    ]);
    const destinationRoles = onDestination ?? onSource;

    const checks: Array<[AtumEscrowTrustErrorCode, string, string, string, string]> = [
      ['UNTRUSTED_ESCROW', 'extra.atum.escrow', source, onSource.escrowContract, atum.escrow],
      ['UNTRUSTED_PAY_TO', 'payTo', source, onSource.escrowContract, requirements.payTo],
      ['UNTRUSTED_RESERVER', 'extra.atum.reserver', source, onSource.quoteSelector, atum.reserver],
      [
        'UNTRUSTED_RELEASER',
        'extra.atum.releaser',
        source,
        onSource.fulfillmentVerifierAccount,
        atum.releaser,
      ],
      [
        'UNTRUSTED_FULFILLMENT_PROXY',
        'extra.atum.fulfillmentProxy',
        destination,
        destinationRoles.fulfillmentProxy,
        atum.fulfillmentProxy,
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

  private async resolveTrust(network: string): Promise<TrustedRoles> {
    try {
      return await this.trust(network);
    } catch (err) {
      if (err instanceof AtumEscrowTrustError) throw err;
      throw new AtumEscrowTrustError({
        code: 'TRUST_SOURCE_UNAVAILABLE',
        network,
        cause: err,
        message: `atum-escrow: the trust source failed for ${network}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

/**
 * Read and validate the `extra.atum` block of an inbound requirement against the published
 * AtumEscrowExtra schema, so a missing or malformed field fails here rather than during signing.
 */
function requireAtumExtra(pr: PaymentRequirements): AtumEscrowExtra {
  const atum = (pr.extra as { atum?: unknown } | undefined)?.atum;
  if (atum === undefined || atum === null) {
    throw new Error('atum-escrow: requirement is missing extra.atum');
  }
  assertAtumEscrowExtra(atum);
  return atum;
}

export {
  registerAtumEscrowScheme,
  type AtumEscrowClientRegistrar,
  type AtumEscrowClientRegistration,
} from './register';

/**
 * Permit2 approval for the source token, re-exported from the shared token-approval package.
 *
 * Optional: a payer whose wallet is already approved needs nothing from here. Pass an ethers
 * signer for an EVM source or a TronWeb instance for a Tron one; {@link needsSourceApproval}
 * checks without spending gas, and Solana needs no approval.
 *
 * {@link isUnconfirmed} tells a broadcast-but-unconfirmed approval apart from a failed one. The
 * confirmation wait is bounded and the transaction may still confirm, so do not send a second
 * approval on an unconfirmed result.
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

// For a payer that drives this client directly instead of through a payment-enabled fetch:
// names the purchase in the 402, which is still required.
export { withPaymentIdentifier } from '../payment-identifier';

export { DEFAULT_MAX_MARKUP_BPS } from './cap';
export { DEFAULT_PEG_GROUPS } from '../peg';

export {
  AtumEscrowTrustError,
  ATUM_DEFAULT_TRUST_GATEWAYS,
  atumGatewayTrust,
  type AtumEscrowTrustErrorCode,
  type AtumGatewayTrustOptions,
  type TrustResolver,
  type TrustedRoles,
  type TrustedToken,
} from './trust';
