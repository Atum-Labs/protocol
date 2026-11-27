// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0; // @aderyn-ignore

/**
 * @title IFulfillmentProxy
 * @notice Interface for fulfilling payment requests with traditional ERC20 authorization
 *
 * IMPLEMENTATION NOTE:
 * This is a simplified version for pilot deployment. Additional fulfillment methods
 * (Permit2 signature-based, Permit2 allowance-based, and EIP-2612 permit) were
 * removed for simplicity and will be reintroduced later. See git history for
 * complete implementation reference.
 *
 * CURRENT FULFILLMENT METHOD:
 *
 * Traditional ERC20 (fulfill/strictFulfill):
 *    - Requires: Prior token approval to this contract
 *    - Transactions: 2 (approve + fulfill)
 *    - Best for: Repeated usage with same spender
 */
interface IFulfillmentProxy {
    error DeadlineExpired(uint256 deadline, uint256 currentTime);

    error AlreadyFulfilled(bytes32 quoteHash);

    /// @notice Thrown when strictFulfill is called with an empty (all-zero) quoteHash.
    error QuoteHashCannotBeEmpty();

    /// @notice Thrown when a fulfillment is attempted with a zero amount.
    /// @dev Applies to fulfill, every item of fulfillMany, and strictFulfill. A zero-value ERC20
    /// transfer is legal, so without this a genuine Fulfilled event bound to any quoteHash costs
    /// only gas — which an offchain matcher keying on quoteHash alone could mistake for a real
    /// fulfillment (Cantina F2).
    error ZeroAmount();

    /// @notice Thrown when fulfillMany is called with an empty array.
    /// @dev The cheaper form of the same problem: it emits a genuine FulfilledMany carrying nothing.
    error EmptyFulfillmentBatch();

    /// @notice Emitted when the admin toggles settler-allowlist enforcement on strictFulfill.
    /// @param enforced True when strictFulfill requires SETTLER_ROLE, false when permissionless.
    event SettlerAllowlistEnforcementSet(bool enforced);

    /// @notice Emitted when a fulfillment is completed
    /// @param quoteHash The quote hash used by the offchain system to identify the fulfillment
    /// @param settler The address that funded the fulfillment (msg.sender of fulfill()).
    ///
    /// Redundant with the transaction sender, and deliberately so: atum-core's block scanner filters
    /// logs by topic0 and never sees the ERC-20 Transfer in the same transaction, so without this it
    /// would need an extra eth_getTransactionByHash per event purely to learn who settled. The
    /// fulfillment verifier compares it against the expected settler
    /// (atum-core core/block-scanner-orchestrator/monitor.go), so it is a verification input, not
    /// decoration.
    /// @param to The recipient address (non-indexed, readable in logs)
    /// @param token The token address (non-indexed, readable in logs)
    /// @param amount The amount transferred (non-indexed, readable in logs)
    /// @param timestamp The block timestamp of the fulfillment
    event Fulfilled(
        bytes32 indexed quoteHash, address indexed settler, address to, address token, uint256 amount, uint256 timestamp
    );

    /// @notice Emitted when multiple fulfillments are completed in a batch
    /// @dev Individual fulfillment data is ABI-encoded in the fulfillments array (non-indexed, fully readable)
    /// @param fulfillments The array of fulfillment structs (non-indexed to preserve data)
    /// @param settler The address that funded every fulfillment in the batch (msg.sender of fulfillMany()).
    ///        Same reasoning as Fulfilled.settler above.
    ///
    /// PARAMETER ORDER IS LOAD-BEARING: `settler` sits SECOND, after `fulfillments`, because that is the
    /// order of the DEPLOYED event. topic0 is keccak of the type-only signature, and a typed parameter's
    /// POSITION is part of that signature even though its name and `indexed` flag are not:
    ///
    ///   FulfilledMany((bytes32,address,address,uint256)[],address,uint256) -> 0xa55853fe...  (deployed)
    ///   FulfilledMany(address,(bytes32,address,address,uint256)[],uint256) -> 0x4033e344...  (settler 1st)
    ///
    /// The atum-core block scanner pre-filters logs on the exact deployed topic0, so transposing these two
    /// parameters rotates topic0 and silently drops every batch fulfillment. Do not reorder them.
    /// @param timestamp The block timestamp of the fulfillments
    event FulfilledMany(Fulfillment[] fulfillments, address indexed settler, uint256 timestamp);

    /// @notice Struct for the parameters of the fulfill function
    /// @param quoteHash The quote hash used by the offchain system to identify the fulfillment
    /// @param to The recipient address
    /// @param token The token address to transfer
    /// @param amount The amount of tokens to transfer
    struct Fulfillment {
        bytes32 quoteHash;
        address to;
        address token;
        uint256 amount;
    }

    /// @notice Sends the tokens to the recipient without checks.
    /// WARNING: This does not guarantee idempotency, or deadline protection for fulfillments
    /// of payments that are consistently fulfilled using this function.
    /// @param params The parameters for the fulfill function
    /// @dev Tokens are transferred from msg.sender to params.to
    /// @dev The msg.sender must have given approval to this contract to spend the token
    function fulfill(Fulfillment calldata params) external;

    /// @notice Fulfill multiple requests in a single transaction without checks.
    /// WARNING: This does not guarantee idempotency, or deadline protection for fulfillments
    /// of payments that are consistently fulfilled using this function.
    /// @param params The array of fulfillment parameters
    /// @dev Tokens are transferred from msg.sender for each fulfillment
    /// @dev The msg.sender must have given approval to this contract to spend all tokens
    function fulfillMany(Fulfillment[] calldata params) external;

    /// @notice This function should be used to fulfill high-risk payments (above a certain value).
    /// For low-risk transactions, use `fulfill` instead, as it is more gas efficient.
    /// It checks the deadline has not expired and that the quote hash has not been fulfilled yet.
    /// If the deadline has expired or the quote hash has been previously strictly fulfilled,
    /// the function reverts.
    /// This guarantees idempotency for fulfillments of payments that are consistently fulfilled using this function.
    /// If a settler uses `strictFulfill` to fulfill a payment, then retries with `fulfill`, or vice-versa, idempotency is not guaranteed.
    /// @param params The parameters for the fulfill function
    /// @param deadline The deadline timestamp (block.timestamp must be <= deadline)
    /// @dev Tokens are transferred from msg.sender to params.to
    /// @dev The msg.sender must have given approval to this contract to spend the token
    function strictFulfill(Fulfillment calldata params, uint256 deadline) external;

    /// @notice Emitted when a settler authorizes a fulfillment without moving tokens.
    /// @param authorizationHash Hash of the fulfillment authorization.
    /// @param quoteHash Hash of the fulfillment quote the authorization covers.
    /// @param settler msg.sender. All three fields are indexed.
    event FulfillmentAuthorized(bytes32 indexed authorizationHash, bytes32 indexed quoteHash, address indexed settler);

    /// @notice Records that msg.sender authorizes fulfillment of quoteHash under authorizationHash.
    /// @dev Emits FulfillmentAuthorized and returns. Does not move tokens, write storage, or check a deadline.
    ///      Reverts with EnforcedPause while the proxy is paused, like fulfill and strictFulfill.
    /// @param quoteHash Hash of the fulfillment quote.
    /// @param authorizationHash Hash of the fulfillment authorization.
    function authorizeFulfillment(bytes32 quoteHash, bytes32 authorizationHash) external;

    /// @notice Toggle whether strictFulfill enforces the settler allowlist (SETTLER_ROLE).
    /// @dev Restricted to DEFAULT_ADMIN_ROLE. Ships dormant (false) so a redeploy is permissionless as
    ///      before; flip on after granting SETTLER_ROLE to settler wallets. Flipping off is an instant
    ///      rollback.
    /// @dev Dormant is NOT behaviour-neutral: this revision keys the strictFulfill marker on the bare
    ///      quoteHash, whereas the deployed proxy keys it per-sender, so while dormant any caller can
    ///      permanently burn a published quoteHash for the price of gas. Grant SETTLER_ROLE and enable
    ///      enforcement in ONE admin batch before routing any payment to this deployment; enabling
    ///      before granting only blocks the strict path (recoverable in one call), whereas granting
    ///      before enabling leaves a window in which a burned marker cannot be undone at all.
    /// @param enforced True to require SETTLER_ROLE on strictFulfill, false for permissionless.
    function setSettlerAllowlistEnforced(bool enforced) external;
}
