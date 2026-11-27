// Wire-level types for Turnkey API responses we consume. Kept narrow on purpose — we only
// model the fields the client and chain shims actually read.

export interface TurnkeyAccount {
  /** Account UUID (Turnkey-internal, not the chain-native address). */
  readonly accountId?: string;
  /** Chain-native address (0x… for EVM, T-prefixed base58 for Tron, base58 pubkey for Solana). */
  readonly address: string;
  /** `ADDRESS_FORMAT_ETHEREUM` | `ADDRESS_FORMAT_TRON` | `ADDRESS_FORMAT_SOLANA` | …. */
  readonly addressFormat: string;
  /** `CURVE_SECP256K1` | `CURVE_ED25519`. */
  readonly curve: string;
}

export interface TurnkeyWallet {
  readonly walletId: string;
  readonly walletName?: string;
}

/**
 * Shape of a Turnkey activity. Most signing activities resolve synchronously to status
 * `ACTIVITY_STATUS_COMPLETED`; long-running flows transit `ACTIVITY_STATUS_PENDING` while
 * awaiting approvals or co-signer execution.
 */
export interface TurnkeyActivity<TResult = unknown> {
  readonly id: string;
  readonly status: string;
  readonly type?: string;
  readonly result?: TResult;
  /** `sha256:…` digest of the intent. This, not the activity id, is what APPROVE_ACTIVITY takes. */
  readonly fingerprint?: string;
  /** False once the caller has already voted, so the submitter cannot approve its own activity. */
  readonly canApprove?: boolean;
  readonly canReject?: boolean;
  readonly votes?: ReadonlyArray<{
    readonly userId?: string;
    readonly selection?: string;
    readonly user?: { readonly userName?: string };
  }>;
  readonly failure?: {
    readonly code?: number | string;
    readonly message?: string;
    readonly details?: unknown;
  };
}

export interface SignRawPayloadResult {
  readonly signRawPayloadResult: {
    readonly r: string;
    readonly s: string;
    readonly v: string;
  };
}

export interface SignTransactionResult {
  readonly signTransactionResult: {
    readonly signedTransaction: string;
  };
}

/** Inputs to `signRawPayload`. Field names mirror Turnkey's REST schema verbatim. */
export interface SignRawPayloadInput {
  readonly signWith: string;
  readonly payload: string;
  /**
   * `PAYLOAD_ENCODING_EIP712` is what makes typed-data policies possible: Turnkey parses the
   * payload as EIP-712 JSON server-side and exposes `eth.eip_712.primary_type`,
   * `eth.eip_712.domain.*` and `eth.eip_712.message['field']` to the policy engine. The
   * HEXADECIMAL path hands Turnkey an opaque blob it cannot introspect, so no field-level
   * policy can be written against it.
   *
   * Turnkey also accepts `PAYLOAD_ENCODING_EIP7702_AUTHORIZATION`, deliberately omitted here: a
   * 7702 authorization delegates the EOA's execution to a contract, so one signature is an
   * account-takeover primitive, and no policy blocks it. Leaving it out of the union makes sending
   * it a compile error, which is the only guard we have.
   */
  readonly encoding:
    | 'PAYLOAD_ENCODING_HEXADECIMAL'
    | 'PAYLOAD_ENCODING_TEXT_UTF8'
    | 'PAYLOAD_ENCODING_EIP712';
  readonly hashFunction:
    | 'HASH_FUNCTION_NO_OP'
    | 'HASH_FUNCTION_NOT_APPLICABLE'
    | 'HASH_FUNCTION_KECCAK256'
    | 'HASH_FUNCTION_SHA256';
}

/** Inputs to `signTransaction`. */
export interface SignTransactionInput {
  readonly signWith: string;
  /** Hex without `0x` prefix. */
  readonly unsignedTransaction: string;
  readonly type: 'TRANSACTION_TYPE_ETHEREUM' | 'TRANSACTION_TYPE_TRON' | 'TRANSACTION_TYPE_SOLANA';
}
