// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IFulfillmentProxy} from "./interfaces/IFulfillmentProxy.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract FulfillmentProxy is IFulfillmentProxy, AccessControlDefaultAdminRules, Pausable {
    using SafeERC20 for IERC20;

    // Roles
    // Pauser role can pause and unpause the contract
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // Settler role is authorized to call strictFulfill when the allowlist is enforced. The strict
    // idempotency marker is keyed on the bare quoteHash, which is public before the destination
    // fulfill, so gating strictFulfill behind an authorized-settler allowlist prevents an arbitrary
    // caller from pre-setting the marker for a quote and permanently blocking the legitimate settler
    // (CORE-2116).
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");

    // When true, strictFulfill requires SETTLER_ROLE. Ships false (dormant) so a redeploy is
    // permissionless as before; the admin flips it on after settler wallets are granted the role,
    // and can flip it back off for an instant rollback without a redeploy (CORE-2116).
    //
    // Dormant is NOT behaviour-neutral against the contract this replaces. The deployed proxy keys
    // its marker on keccak256(paymentId, msg.sender), so a caller there can only ever burn its own
    // slot; this revision keys on the bare quoteHash, so while dormant it is strictly MORE exposed
    // than its predecessor, not equal to it. Enabling the allowlist is the step that closes that
    // gap, and it is a gated cutover step, not optional hardening.
    bool public s_settlerAllowlistEnforced;

    // Strict fulfillment mapping to prevent duplicate fulfillments for high-risk payments.
    mapping(bytes32 quoteHash => bool strictlyFulfilled) private s_strictlyFulfilled;

    constructor(address defaultAdmin) AccessControlDefaultAdminRules(1, defaultAdmin) {}

    /// @inheritdoc IFulfillmentProxy
    function fulfill(Fulfillment calldata params) public whenNotPaused {
        // ERC20 permits zero-value transfers, so without this anyone can emit a genuine Fulfilled
        // event carrying amount 0 and bound to any quoteHash, for the price of gas. On its own that
        // is indexer noise; the reason it is a guard and not a nit is what it feeds. An offchain
        // matcher that keys on quoteHash ALONE — rather than on recipient, token, amount and settler
        // together — would treat that free event as a real fulfillment and could authorise a
        // release. This makes the cheap primitive unavailable (Cantina F2, Jayfromthe13th).
        //
        // SVM has guarded both its paths since it shipped; this brings EVM to parity. TVM is still
        // UNGUARDED on all three of its entrypoints, and its suite currently asserts a zero-amount
        // strictFulfill emits a genuine Fulfilled, so closing it there means inverting a green test
        // rather than adding one (CORE-2072). Do not read this line as "all three VMs are covered".
        require(params.amount != 0, ZeroAmount());
        IERC20(params.token).safeTransferFrom(msg.sender, params.to, params.amount);
        emit Fulfilled(params.quoteHash, msg.sender, params.to, params.token, params.amount, block.timestamp);
    }

    /// @inheritdoc IFulfillmentProxy
    function fulfillMany(Fulfillment[] calldata params) external whenNotPaused {
        // An EMPTY array is the cheaper version of the same trick: it emits a genuine FulfilledMany
        // with nothing in it. Rejected for the same reason as the per-item guard below.
        require(params.length != 0, EmptyFulfillmentBatch());
        for (uint256 i; i < params.length; i++) {
            require(params[i].amount != 0, ZeroAmount());
            IERC20(params[i].token).safeTransferFrom(msg.sender, params[i].to, params[i].amount);
        }
        emit FulfilledMany(params, msg.sender, block.timestamp);
    }

    /// @inheritdoc IFulfillmentProxy
    function strictFulfill(Fulfillment calldata params, uint256 deadline) external whenNotPaused {
        // Authorization is toggled: dormant on a fresh redeploy (permissionless, as before), enforced
        // once the admin flips s_settlerAllowlistEnforced on (CORE-2116).
        if (s_settlerAllowlistEnforced) {
            _checkRole(SETTLER_ROLE);
        }
        require(block.timestamp <= deadline, DeadlineExpired(deadline, block.timestamp));
        // Unconditional validity checks, NOT cutover flags — and NOT a closure of the griefing
        // vector. They remove two specific cheap variants: a zero quoteHash would let any caller burn
        // the single zero-key marker, and a zero amount makes the marker settable for FREE.
        //
        // What REMAINS while the allowlist is dormant: params.token and params.to are unvalidated, so
        // a caller can pass amount 1 of a token it issues itself, with to = itself, satisfy both
        // guards, and set the marker for someone else's quoteHash for the price of gas. SafeERC20 only
        // requires a non-reverting transferFrom returning true, so no mint, balance or approval is
        // even needed. The marker is written just below and NEVER cleared — there is no setter, no
        // admin reset and no upgrade path — so the legitimate settler is blocked on the strict path
        // for that quoteHash permanently, and granting SETTLER_ROLE afterwards does not undo it.
        // The quoteHash is not secret either: the source chain emits it as an indexed topic in
        // Escrow.Deposited before the destination fulfill, so a target is published, not guessed.
        //
        // The vector is closed by SETTLER_ROLE, which ships dormant and is enabled at cutover, and
        // structurally by keying the marker per-sender as the TVM and SVM proxies already do.
        // test_strictFulfill_dormant_allowlist_attacker_burns_victim_quoteHash pins this residual.
        require(params.quoteHash != bytes32(0), QuoteHashCannotBeEmpty());
        require(params.amount != 0, ZeroAmount());
        require(!s_strictlyFulfilled[params.quoteHash], AlreadyFulfilled(params.quoteHash));
        s_strictlyFulfilled[params.quoteHash] = true;
        fulfill(params);
    }

    /// @inheritdoc IFulfillmentProxy
    function authorizeFulfillment(bytes32 quoteHash, bytes32 authorizationHash) external whenNotPaused {
        emit FulfillmentAuthorized(authorizationHash, quoteHash, msg.sender);
    }

    /// @inheritdoc IFulfillmentProxy
    function setSettlerAllowlistEnforced(bool enforced) external onlyRole(DEFAULT_ADMIN_ROLE) {
        s_settlerAllowlistEnforced = enforced;
        emit SettlerAllowlistEnforcementSet(enforced);
    }

    ///////////////// ///////
    /// PAUSE FUNCTIONS ///
    ////////////////////////

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
