import type { Signer } from "ethers";

/**
 * Result of an {@link ensureSourceApproval} call.
 */
export interface EnsureApprovalResult {
  /** The existing allowance already covered the requirement; no transaction was sent. */
  alreadySufficient: boolean;
  /** The approval transaction hash, when one was sent. */
  txHash?: string;
  /**
   * Set only when the token refused to overwrite a non-zero allowance and it had to be reset to
   * zero first: the hash of that reset. Its absence means one transaction was sent, not two.
   */
  resetTxHash?: string;
}

/**
 * A pending TronWeb contract method. `call()` reads; `send()` broadcasts and resolves to a
 * transaction id.
 */
export interface TronContractMethod<T> {
  call(): Promise<T>;
  send(options?: { feeLimit?: number }): Promise<string>;
}

/** The TRC-20 surface this package uses to read and set the escrow-deposit allowance. */
export interface TronTokenContract {
  allowance(owner: string, spender: string): TronContractMethod<unknown>;
  approve(spender: string, amount: string): TronContractMethod<unknown>;
}

/** What TronWeb reports about a broadcast transaction. Empty until it is confirmed. */
export interface TronTransactionInfo {
  receipt?: { result?: string };
}

/**
 * The slice of a TronWeb instance this package needs.
 *
 * Declared structurally rather than imported from `tronweb` on purpose: the package then
 * type-checks and builds with tronweb absent, and consumers that never pay from Tron do not
 * carry an 11 MB dependency they cannot reach. The caller constructs the instance and passes
 * it in, exactly as the EVM path takes a caller-constructed ethers signer.
 */
export interface TronWebLike {
  /**
   * The ABI-and-address form, which builds the handle locally. The `contract().at(address)`
   * form fetches the ABI from the node instead: a round trip per use, and an interface that
   * depends on what the chain happens to report for that address.
   *
   * Returns `unknown` on purpose. TronWeb types this as a contract whose methods are produced
   * dynamically from the ABI, so pinning it to {@link TronTokenContract} here would stop a real
   * TronWeb instance assigning to this interface at all and force every caller to write a cast.
   * The cast belongs in one place — next to the ABI we passed, which is what makes it true.
   */
  contract(abi: unknown, address: string): unknown;
  trx: { getTransactionInfo(txId: string): Promise<TronTransactionInfo> };
  /**
   * The account this instance signs as. Read to check it against `owner` before broadcasting,
   * since an approval only ever applies to the account that sends it.
   *
   * Optional, and `false` is TronWeb's own "not set": both mean the instance cannot say which
   * account it would use, and neither is treated as a mismatch.
   */
  defaultAddress?: { base58?: string | false };
}

/** How long to wait for a broadcast approval to confirm before giving up, on either chain. */
export interface ConfirmationOptions {
  /**
   * Default 60_000. On timeout the approval is reported as unconfirmed rather than failed: it
   * was broadcast and may still confirm, so the caller is told to check it before sending
   * another one.
   */
  timeoutMs?: number;
  /** Tron only: how often to poll for the receipt. Default 1_500, under Tron's ~3s block time. */
  pollIntervalMs?: number;
  /** Tron only: default 100_000_000 SUN. Tron charges the caller for contract execution. */
  feeLimit?: number;
}

/**
 * Inputs to {@link ensureSourceApproval} and {@link needsSourceApproval}.
 *
 * `signer` and `tronWeb` are both optional here because which one is required is decided by
 * `network`, a runtime string that no type can constrain. Supplying the wrong one for the
 * chain fails with a message naming the one that was needed.
 */
export interface ApprovalParams {
  /** CAIP-2 source chain id, e.g. `eip155:8453` or `tron:mainnet`. */
  network: string;
  /** Source token address. */
  token: string;
  /** The payer's account. */
  owner: string;
  /**
   * The contract to approve. Defaults to the canonical Permit2 for the chain: the EVM
   * deployment on `eip155:*`, and the pinned per-network address on `tron:*`.
   */
  spender?: string;
  /**
   * The minimum allowance this charge needs. Answers "is what I already have enough?".
   * When omitted, only an unlimited approval counts as sufficient, so a smaller leftover
   * allowance cannot be mistaken for enough and revert a larger later charge on-chain.
   */
  requiredAllowance?: bigint;
  /**
   * How much to approve when an approval IS sent. Defaults to unlimited, so later charges on
   * the same token need no further transaction.
   *
   * On its own, a bounded amount is treated as its own requirement: an allowance still holding
   * the full bound is left alone rather than re-approved. That is the right answer for a one-off
   * approval, where nothing else in the call says what a later charge would need.
   *
   * Across repeated payments, PAIR IT WITH `requiredAllowance`. Permit2 decrements the allowance
   * on every payment, so a bound measured against itself stops being sufficient the moment the
   * first charge lands, and every later call sends another approval. `requiredAllowance` states
   * what the NEXT charge needs, which is the question a partly spent bound can still answer yes
   * to.
   *
   * Trade-off: a bounded approval limits what the escrow can ever move, but it is consumed as it
   * is spent and eventually has to be granted again, whichever way it is used.
   */
  approvalAmount?: bigint;
  /** An ethers signer connected to the source chain. Required for `eip155:*`. */
  signer?: Signer;
  /** A TronWeb instance configured for the source chain. Required for `tron:*`. */
  tronWeb?: TronWebLike;
  /** Broadcast and confirmation tuning. Applies to both chains. */
  confirmation?: ConfirmationOptions;
  /**
   * Called with each transaction hash the moment it is broadcast, before the wait for it to
   * confirm. Without this a caller has nothing to show for a transaction that is already
   * spending their gas — and nothing to look up if the wait times out.
   *
   * `purpose` distinguishes the approval itself from the zero-reset some tokens demand first,
   * so two hashes in one call read as one deliberate sequence rather than a double spend.
   */
  onSubmitted?: (txHash: string, purpose: "approval" | "reset") => void;
}
