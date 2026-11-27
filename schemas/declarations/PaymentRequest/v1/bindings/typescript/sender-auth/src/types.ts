import type { CommitmentResult } from './commitment-rules.js';
import type {
  SenderAuthMessageScheme,
  SignedMessage,
} from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript';
import type { CommitmentExpectation } from './commitment-rules.js';

export type { SenderAuthMessageScheme, SignedMessage };

/**
 * Source-chain defaults (escrow contract, quote selector, verifier, etc.), in the shape the
 * gateway's `GET /v1/defaults` returns. Used to build and to rebuild-and-verify the signed message.
 */
export interface ChainDefaults {
  escrowContract: string;
  quoteSelector: string;
  fulfillmentVerifierAccount: string;
  fulfillmentVerifierEndpoint: string;
  fulfillmentProxy: string;
  permit2Contract?: string;
  /** Solana escrow domain-separation fields; absent for EVM/Tron. */
  svmSignatureClusterId?: string;
  svmSignatureDomainVersion?: number;
}

/** Result of building a sender_auth message for a specific chain. */
export interface AuthMessageResult {
  messageScheme: SenderAuthMessageScheme;
  messageHash: string;
  messagePrehash: string;
}

/** The signed terms recovered from a verified sender_auth message. */
export interface AuthTerms {
  /** Atomic units, decimal string. */
  amount: string;
  /** Unix seconds. */
  deadlineSec: number;
}

/**
 * The recovered + parsed permit, returned so a consumer can run its own scheme/policy
 * checks (e.g. against a challenge) without re-parsing `message_prehash`.
 */
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
  /**
   * Stellar only: the `payload.delegate_signer` (a G strkey) that signed the deposit digest. It
   * equals `depositor`: a different key throws `DelegateUnverifiedError`. Whether it is registered
   * for `depositor` (`create_delegate`) is on-chain state no offline check reads. The gateway
   * applies the offline verdict only; the party
   * that reads the chain (veri-fill, or the settler before it deposits) compares `delegateSigner`
   * and `delegateEpoch` with the escrow's `get_delegate` for (depositor, token), and until that
   * check has run the payer has not been shown to have consented.
   */
  delegateSigner?: string;
  /**
   * Stellar only, always `true`: the delegate's registration for the depositor was NOT verified
   * here, although the delegate is the depositor's own key; consent is established only by the
   * on-chain delegate registration. It is set on every Stellar permit, so it says no more than
   * `scheme === 'STELLAR'`, and it is not carried by `recoverSigner` or the commitment result: it
   * documents the gap, it does not enforce the check.
   */
  delegateOnchainUnverified?: true;
  /**
   * Stellar only: the delegate record `epoch` the deposit digest commits to, as a decimal string. A
   * party that reads the chain compares it with `get_delegate(depositor, token).epoch`: a deposit signed under an
   * earlier record is void on chain.
   */
  delegateEpoch?: string;
  /** The two escrow commitments as they were signed. */
  destination?: string;
  depositRequestHash?: string;
}

/** `recoverAndVerify` result: the signed terms plus the parsed permit. */
export interface VerifiedSenderAuth extends AuthTerms {
  permit: ParsedPermit;
  /** The verified destination commitment, for logging and counting admissions. */
  commitment: CommitmentResult;
}

/**
 * What a verifier binds a recovered sender_auth against. The destination commitment is not here:
 * `recoverAndVerify` takes it as its own required argument.
 *
 * - `maxSourceAmount` is always checked (permit amount must equal it), or `quoteSourceAmount`
 *   instead when set.
 * - `escrowContract` / `reserver` / `releaser` bind the atum-escrow roles when supplied:
 *   `spender == escrow` (EVM/Tron) and the witness roles.
 * - On Solana, `escrowContract` + the `svm*` fields are additionally **required** for the crypto
 *   (the deposit-hash domain).
 * - On Stellar, `escrowContract`, `reserver` and `releaser` are all **required**: the escrow is part
 *   of the signed digest, and the reserver and releaser are free members of the signed record, so a
 *   verifier that does not pin them would admit a deposit whose releaser the requester controls. A
 *   verifier that omits one is refused as `verifier_misconfigured`.
 */
export interface VerifyExpectations {
  maxSourceAmount: string;
  /**
   * When set, replaces `maxSourceAmount` for a deposit that pays a chosen quote: the permit must
   * authorize exactly the quote's `source_amount`, a decimal string above zero. `maxSourceAmount`
   * must then be empty, or the verifier is misconfigured.
   */
  quoteSourceAmount?: string;
  escrowContract?: string;
  reserver?: string;
  releaser?: string;
  svmSignatureClusterId?: string;
  svmSignatureDomainVersion?: number;
  /**
   * The Permit2 the escrow uses, for chains that do not run the canonical address (EVM) or the
   * pinned one (Tron); absent means that default. It is the EIP-712 verifying contract, so it must
   * match the one used to build, and it comes from the verifier's own configuration, never from
   * `message_prehash`.
   */
  permit2Contract?: string;
  /**
   * When set, pins the verify-time clock the EVM/Tron freshness check compares against
   * (unix seconds). Production verifiers omit it (real clock).
   */
  nowSec?: number;
}

/** The source asset reference a verifier binds a recovered signer against. */
export interface SourceRef {
  network: string;
  asset: string;
  account: string;
}

/** The decoded Permit2 (EVM/Tron) witness message carried in `message_prehash`. */
export interface PermitMessage {
  permitted: { token: string; amount: string };
  spender: string;
  nonce: string;
  deadline: string;
  /**
   * The four-member DepositWitness. `depositRequestHash` and `destination` are part of the signed
   * digest, so a prehash without them is refused, never hashed as zero values.
   */
  witness: {
    depositRequestHash: string;
    destination: string;
    reserver: string;
    releaser: string;
  };
}

/**
 * The Solana deposit prehash the builder emits in `message_prehash`. `deposit_request_hash`
 * matches the EVM and Tron witness member, and `destination` is carried because the deposit hash
 * folds in keccak256(destination); a verifier rebuilds the hash from these fields alone.
 */
export interface SolanaDepositPrehashV2 {
  deposit_request_hash: string;
  destination: string;
  depositor: string;
  mint: string;
  amount: string;
  reserver: string;
  releaser: string;
  nonce: string;
  issued_at: string;
  deadline: string;
}

/**
 * The Stellar deposit prehash the builder emits in `message_prehash`: the flat record the escrow's
 * deposit digest is computed from, so a verifier rebuilds the digest from these fields and the
 * network and escrow it is configured with. `depositor` and `token` are G (account) or C
 * (contract) strkeys, `reserver` and `releaser` G strkeys, and the numbers decimal strings.
 */
export interface StellarDepositPrehash {
  deposit_request_hash: string;
  destination: string;
  depositor: string;
  token: string;
  /** The `epoch` of the delegate record the deposit is signed under (`get_delegate(...).epoch`). */
  epoch: string;
  amount: string;
  reserver: string;
  releaser: string;
  nonce: string;
  issued_at: string;
  deadline: string;
}

/** The decoded Solana deposit prehash carried in `message_prehash`. */
export interface SolanaDepositPrehash {
  payment_id: string;
  depositor: string;
  mint: string;
  amount: string;
  reserver: string;
  releaser: string;
  nonce: string;
  issued_at: string;
  deadline: string;
}

/**
 * Chain-specific rewrites of the request-body contract fields. Some chains must
 * normalize the raw defaults before they go on the wire (e.g. Tron base58 → hex).
 */
export interface ContractFieldOverrides {
  quote_selector?: string;
  fulfillment_verifier?: {
    account: string;
    endpoint: string;
  };
}

/**
 * A single signed message from `sender_auth.signed_messages[]`, in the shape of the generated
 * wire type except that `message_prehash` stays optional, so a verifier can report a message
 * that arrived without one.
 */
export type SignedMessageInput = {
  message: string;
  signature: string;
  message_prehash?: string;
  payload?: SignedMessage['payload'];
  [k: string]: unknown;
};

/** The inputs to a chain adapter's `buildAuthMessage`. Mirrors the Go `BuildParams`. */
export interface BuildAuthMessageParams {
  sourceAsset: string;
  depositor: string;
  maxSourceAmount: string;
  /**
   * When set, the amount the permit authorizes for a deposit that pays a chosen quote: the quote's
   * `source_amount`, a decimal string above zero, at most the request's `max_source_amount` when
   * `paymentRequestJSON` commits one. `maxSourceAmount` must then be empty. Mirrors the verifier's
   * `quoteSourceAmount` and the Go `BuildParams.QuoteSourceAmount`.
   */
  quoteSourceAmount?: string;
  /**
   * The payment's request_id, whose keccak256 is depositRequestHash v1. Required without
   * `paymentRequestJSON`; with it, absent or equal to the request's request_id.
   *
   * @deprecated Pass `paymentRequestJSON`, which carries the request_id.
   */
  requestId?: string;
  sourceDefaults: ChainDefaults;
  /**
   * The payee the deposit commits to: the destination's CAIP-19 `asset_identifier` and its
   * account. Required without `paymentRequestJSON`; with it, absent or composing the request's
   * destination. They are passed separately so the adapter composes the destination through
   * `buildEscrowDestination` rather than each caller formatting it.
   *
   * @deprecated Pass `paymentRequestJSON`, which carries the destination.
   */
  destinationAsset?: string;
  /** @deprecated Pass `paymentRequestJSON`, which carries the destination. See `destinationAsset`. */
  destinationAccount?: string;
  /**
   * Absolute Permit2 deadline (Unix seconds). Required for EVM/Tron (the builder throws if
   * omitted); derive it from the payment's fulfillment deadline. Ignored by Solana, whose
   * deadline is the on-chain replay window from `issued_at`.
   */
  deadline?: bigint | number;
  /**
   * The permit nonce. Required for EVM/Tron (see `deterministicPermitNonce`). Optional for
   * Solana (see `deterministicSolanaNonce`); when omitted a random valid nonce is generated.
   */
  nonce?: bigint | string;
  /**
   * Stellar only: the deposit's `issued_at` (Unix seconds). The escrow requires it to be at or
   * before the ledger close time, so take it from the latest closed ledger, not the local clock.
   * Absent, the builder uses the local clock minus a 30 second skew allowance.
   */
  issuedAt?: bigint | number;
  /**
   * Stellar only, required: the `epoch` of the payer's delegate record for (depositor, token), from
   * the escrow's `get_delegate` (or the value `create_delegate` returned). The deposit digest commits
   * to it, so a deposit signed under one record is void under a later one.
   */
  delegateEpoch?: bigint | number | string;
  solanaRpcUrl?: string;
  solanaClockReader?: (chainId: string) => Promise<bigint>;
  /**
   * The assembled payment request, exactly as it will be posted once sender_auth is added: build
   * the final body first (defaults, deadlines and executor all fixed), then sign it, then post it
   * unchanged. The builder reads it with `readDepositRequest`, whatever version it signs, and takes
   * the request_id and destination it commits from that reading. A request `readDepositRequest`
   * refuses is refused here. The params that drive the permit, `sourceAsset`, `depositor`,
   * `maxSourceAmount` and the escrow, quote selector and fulfillment verifier in `sourceDefaults`,
   * must agree with the request where it commits them, or the builder refuses rather than sign a
   * deposit whose v2 commits terms its permit does not use. Mirrors the Go
   * `BuildParams.PaymentRequestJSON`.
   */
  paymentRequestJSON?: string | Uint8Array;
  /**
   * The depositRequestHash the deposit commits: 1 for v1, keccak256(request_id), or 2 for v2, the
   * hash of `paymentRequestJSON`'s terms, which needs `paymentRequestJSON`. Absent is 1, so v1
   * stays the default output.
   */
  depositRequestHashVersion?: 1 | 2;
}

/**
 * A chain adapter: builds + signs + recovers-and-verifies one sender_auth scheme.
 * Selected by CAIP-2 namespace via {@link getChainAdapter}.
 */
export interface ChainAdapter {
  buildAuthMessage(params: BuildAuthMessageParams): Promise<AuthMessageResult>;

  sign(signedMessage: SignedMessageInput, privateKey: string): Promise<string>;

  /**
   * Recover/verify the signer of ONE signed message and confirm it is `source.account`,
   * WITHOUT parsing or binding a permit — the recover-only primitive a multi-message
   * verifier runs over every `signed_messages[]` entry (including non-permit setup
   * approvals). Returns `source.account` on success; throws otherwise.
   */
  recoverSigner(signed: SignedMessageInput, source: SourceRef): string;

  /**
   * Recover the signer, bind the signed terms to `expected`, and require the signed deposit to commit
   * to `commitment` (the payment's own destination and request id, or its depositRequestHash v2 when
   * `commitment` carries one). A commitment failure throws `CommitmentError`.
   *
   * @deprecated The caller assembles `commitment` from the request itself. Use
   * `verifyPaymentRequestJSON` with the request as received, or `recoverSigner` for a message that
   * is not the deposit.
   */
  recoverAndVerify(
    signed: SignedMessageInput,
    source: SourceRef,
    commitment: CommitmentExpectation,
    expected: VerifyExpectations,
  ): VerifiedSenderAuth;

  deriveDelegateSigner?(privateKey: string): string;
}
