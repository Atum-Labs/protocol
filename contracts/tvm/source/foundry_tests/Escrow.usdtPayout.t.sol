// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {IEscrow} from "../contracts/interfaces/IEscrow.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {MockToken6DecimalsTransferReturnsFalse, MockTokenTransferNoOp} from "./mock/MockToken.sol";

/// @notice The USDT payout path, which cannot use SafeERC20 and therefore has to establish success
///         some other way.
///
/// WHY THIS FILE EXISTS. Tron USDT (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, TetherToken) returns
/// **false from a SUCCESSFUL transfer** and REVERTS on failure — the opposite of the convention
/// `SafeERC20` encodes. Verified against the live contract: a simulated transfer from a funded
/// holder returns 32 bytes of zero with no revert, and an overdraw from an empty account returns
/// `REVERT opcode executed`. Routing USDT through `safeTransfer` would therefore revert on every
/// successful release, refund and fee withdrawal, freezing an escrow with no rescue function.
///
/// So `Escrow._usdtTransfer` ignores the return value — on this token it carries no information —
/// and checks the escrow's balance delta instead. These tests pin both halves of that: that a
/// false-returning transfer which MOVES funds is accepted, and that one which does not move funds
/// is rejected rather than being recorded as a completed settlement.
contract EscrowUsdtPayoutTest is Test {
    /// @dev Any non-zero address; the tests below etch token code onto it.
    address private constant USDT = 0x000000000000000000000000000000000000d102;
    address private constant RECIPIENT = address(0xBEEF);

    uint256 private constant FUNDED = 1_000_000;
    uint256 private constant PAYOUT = 250_000;

    Escrow private s_escrow;

    function setUp() public {
        s_escrow = new Escrow(IPermit2(vm.envAddress("PERMIT2_ADDRESS")), IERC20(USDT), address(this));
    }

    /// @dev `_usdtTransfer` is private, so drive it the way production does: through the fee
    /// withdrawal path, which is the shortest route to a USDT payout that needs no signature.
    function _seedFeeRevenue(uint256 amount) private {
        // s_tokenFeeRevenue[token] — mapping slot found via `forge inspect Escrow storageLayout`.
        // Seeded directly so this file tests the PAYOUT, not the accrual path that fills it.
        vm.store(address(s_escrow), keccak256(abi.encode(IERC20(USDT), uint256(6))), bytes32(amount));
        assertEq(s_escrow.getFeeRevenue(IERC20(USDT)), amount, "fee revenue seeding failed");
    }

    function test_usdtPayoutAcceptsAFalseReturnWhenTheBalanceActuallyMoves() public {
        MockToken6DecimalsTransferReturnsFalse usdt = new MockToken6DecimalsTransferReturnsFalse("Tether USD", "USDT");
        vm.etch(USDT, address(usdt).code);
        deal(USDT, address(s_escrow), FUNDED);
        _seedFeeRevenue(PAYOUT);

        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), address(this));
        // The transfer returns FALSE here. Accepting it is the point: this is what the real token
        // does on success, and a SafeERC20 route would revert instead.
        s_escrow.withdrawFeeRevenue(IERC20(USDT), RECIPIENT);

        assertEq(IERC20(USDT).balanceOf(address(s_escrow)), FUNDED - PAYOUT, "escrow balance did not fall");
        assertEq(IERC20(USDT).balanceOf(RECIPIENT), PAYOUT, "recipient was not paid");
    }

    function test_usdtPayoutRevertsWhenTheTransferMovesNothing() public {
        MockTokenTransferNoOp usdt = new MockTokenTransferNoOp("Tether USD", "USDT");
        vm.etch(USDT, address(usdt).code);
        deal(USDT, address(s_escrow), FUNDED);
        _seedFeeRevenue(PAYOUT);

        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), address(this));
        // Without the balance-delta check this call SUCCEEDS: the return value is ignored (it has to
        // be), s_tokenFeeRevenue has already been zeroed, and FeeRevenueWithdrawn is emitted — so the
        // accounting records a payout that never happened, with the tokens still in the escrow.
        vm.expectRevert(abi.encodeWithSelector(IEscrow.UsdtTransferDidNotMove.selector, PAYOUT, 0));
        s_escrow.withdrawFeeRevenue(IERC20(USDT), RECIPIENT);

        assertEq(IERC20(USDT).balanceOf(address(s_escrow)), FUNDED, "escrow balance should be untouched");
    }
}
