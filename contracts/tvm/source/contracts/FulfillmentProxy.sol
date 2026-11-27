// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

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

    // When true, strictFulfill requires SETTLER_ROLE. Ships false (dormant) so a redeploy behaves
    // exactly like the prior contract; the admin flips it on after settler wallets are granted the
    // role, and can flip it back off for an instant rollback without a redeploy (CORE-2116).
    bool public s_settlerAllowlistEnforced;

    // Strict fulfillment mapping to prevent duplicate fulfillments for high-risk payments.
    mapping(bytes32 quoteHash => bool strictlyFulfilled) private s_strictlyFulfilled;

    constructor(address defaultAdmin) AccessControlDefaultAdminRules(1, defaultAdmin) {}

    /// @inheritdoc IFulfillmentProxy
    function fulfill(Fulfillment calldata params) public whenNotPaused {
        // A zero-value transfer is legal, so without this anyone can emit a genuine Fulfilled event
        // bound to any quoteHash for the price of gas. Indexer noise on its own — but an offchain
        // matcher keying on quoteHash ALONE, rather than on recipient, token, amount and settler
        // together, could read that free event as a real fulfillment and authorise a release.
        // strictFulfill already rejected it under CORE-2116; this closes the same hole on the
        // permissionless paths (Cantina F2, Jayfromthe13th).
        if (params.amount == 0) revert ZeroAmount();
        IERC20(params.token).safeTransferFrom(msg.sender, params.to, params.amount);
        emit Fulfilled(params.quoteHash, msg.sender, params.to, params.token, params.amount, block.timestamp);
    }

    /// @inheritdoc IFulfillmentProxy
    function fulfillMany(Fulfillment[] calldata params) external whenNotPaused {
        // An EMPTY array is the cheaper form of the same trick: a genuine FulfilledMany with nothing
        // in it.
        if (params.length == 0) revert EmptyFulfillmentBatch();
        for (uint256 i; i < params.length; i++) {
            if (params[i].amount == 0) revert ZeroAmount();
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
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        if (params.quoteHash == bytes32(0)) revert QuoteHashCannotBeEmpty();
        if (params.amount == 0) revert ZeroAmount();
        if (s_strictlyFulfilled[params.quoteHash]) revert AlreadyFulfilled(params.quoteHash);
        s_strictlyFulfilled[params.quoteHash] = true;
        fulfill(params);
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
