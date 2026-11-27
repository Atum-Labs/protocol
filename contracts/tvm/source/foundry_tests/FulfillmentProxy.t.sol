// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {FulfillmentProxy} from "../contracts/FulfillmentProxy.sol";
import {IFulfillmentProxy} from "../contracts/interfaces/IFulfillmentProxy.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IAccessControl, AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {DeployCoreContracts} from "../foundry_scripts/DeployCoreContracts.s.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {IFulfillmentProxy} from "../contracts/interfaces/IFulfillmentProxy.sol";
import {MockToken6DecimalsTransferReturnsFalse} from "./mock/MockToken.sol";

/**
 * @title FulfillmentProxyTest
 * @notice Test suite for FulfillmentProxy contract
 *
 */
contract FulfillmentProxyTest is Test {
    FulfillmentProxy public s_fp;
    MockToken6DecimalsTransferReturnsFalse public token;

    bytes32 public constant QUOTE_HASH = keccak256("payment");
    address public constant SETTLER = address(0x1);
    address public constant RECIPIENT = address(0x2);

    address public s_pauser;
    address public s_treasurer;
    address public s_tokenConfig;

    function setUp() public {
        token = new MockToken6DecimalsTransferReturnsFalse("MockToken", "MTK");
        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (, s_fp) = deployCoreContracts.run(IERC20(address(token)));

        s_pauser = makeAddr("pauser");
        s_treasurer = makeAddr("treasurer");
        s_tokenConfig = makeAddr("tokenConfig");

        s_fp.grantRole(s_fp.PAUSER_ROLE(), s_pauser);
        // CORE-2116: settler-allowlist enforcement ships dormant (default false), so strictFulfill is
        // permissionless here exactly like the prior contract. The enforcement-specific tests below
        // flip it on explicitly.
        token.mint(address(this), type(uint128).max);
        token.approve(address(s_fp), type(uint256).max);
        vm.snapshotGasLastCall("token_approve_success");
    }

    // OWNERSHIP TESTS

    function test_constructor_sets_owner_correctly() public view {
        // Test that the owner is set correctly during construction
        assertTrue(s_fp.hasRole(s_fp.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    function test_constructor_with_different_owner() public {
        address newOwner = makeAddr("newOwner");
        FulfillmentProxy newProxy = new FulfillmentProxy(newOwner);

        // The constructor should use the owner parameter passed to it
        assertTrue(newProxy.hasRole(newProxy.DEFAULT_ADMIN_ROLE(), newOwner));
    }

    // PAUSE/UNPAUSE TESTS

    function test_pause_only_owner() public {
        // Should succeed when called by owner
        vm.startPrank(s_pauser);
        s_fp.pause();
        vm.stopPrank();
        assertTrue(s_fp.paused());
    }

    function test_pause_non_owner_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_fp.PAUSER_ROLE()
            )
        );
        s_fp.pause();
    }

    function test_unpause_only_owner() public {
        // First pause the contract
        vm.startPrank(s_pauser);
        s_fp.pause();
        assertTrue(s_fp.paused());

        // Should succeed when called by owner
        s_fp.unpause();
        assertFalse(s_fp.paused());
        vm.stopPrank();
    }

    function test_unpause_non_owner_reverts() public {
        // First pause the contract
        vm.startPrank(s_pauser);
        s_fp.pause();
        vm.stopPrank();
        assertTrue(s_fp.paused());

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_fp.PAUSER_ROLE()
            )
        );
        s_fp.unpause();
    }

    function test_pause_when_already_paused_reverts() public {
        // First pause the contract
        vm.startPrank(s_pauser);
        s_fp.pause();
        assertTrue(s_fp.paused());

        // Try to pause again - should revert
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_fp.pause();
        vm.stopPrank();
    }

    function test_unpause_when_not_paused_reverts() public {
        // Contract is not paused by default
        assertFalse(s_fp.paused());

        vm.startPrank(s_pauser);
        // Try to unpause when not paused - should revert
        vm.expectRevert(abi.encodeWithSignature("ExpectedPause()"));
        s_fp.unpause();
        vm.stopPrank();
    }

    function test_contract_not_paused_by_default() public view {
        assertFalse(s_fp.paused());
    }

    function test_pause_unpause_cycle() public {
        vm.startPrank(s_pauser);
        // Initially not paused
        assertFalse(s_fp.paused());

        // Pause
        s_fp.pause();
        assertTrue(s_fp.paused());

        // Unpause
        s_fp.unpause();
        assertFalse(s_fp.paused());

        // Can pause again
        s_fp.pause();
        assertTrue(s_fp.paused());
        vm.stopPrank();
    }

    function test_fulfill_works_after_unpause() public {
        vm.startPrank(s_pauser);
        // Pause the contract
        s_fp.pause();

        // Unpause the contract
        s_fp.unpause();
        vm.stopPrank();

        // Should now work normally
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000})
        );
        vm.snapshotGasLastCall("fulfill_works_after_unpause");

        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    function test_strictFulfill_works_after_unpause() public {
        vm.startPrank(s_pauser);
        // Pause the contract
        s_fp.pause();

        // Unpause the contract
        s_fp.unpause();
        vm.stopPrank();

        // Should now work normally
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp + 1000
        );
        vm.snapshotGasLastCall("strictFulfill_works_after_unpause");
        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    function test_fulfillMany_paused_reverts() public {
        vm.startPrank(s_pauser);
        // Pause the contract
        s_fp.pause();
        vm.stopPrank();

        IFulfillmentProxy.Fulfillment[] memory params = new IFulfillmentProxy.Fulfillment[](1);
        params[0] =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000});

        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_fp.fulfillMany(params);
    }

    struct Benchmark {
        uint256 numFulfillments;
        string gassnapshotName;
    }

    function test_fulfillMany_benchmarking() public {
        Benchmark[] memory benchmarks = new Benchmark[](15);
        benchmarks[0] = Benchmark({numFulfillments: 2, gassnapshotName: "fulfillMany_2_fulfillments_success"});
        benchmarks[1] = Benchmark({numFulfillments: 3, gassnapshotName: "fulfillMany_3_fulfillments_success"});
        benchmarks[2] = Benchmark({numFulfillments: 5, gassnapshotName: "fulfillMany_5_fulfillments_success"});
        benchmarks[3] = Benchmark({numFulfillments: 7, gassnapshotName: "fulfillMany_7_fulfillments_success"});
        benchmarks[4] = Benchmark({numFulfillments: 10, gassnapshotName: "fulfillMany_10_fulfillments_success"});
        benchmarks[5] = Benchmark({numFulfillments: 15, gassnapshotName: "fulfillMany_15_fulfillments_success"});
        benchmarks[6] = Benchmark({numFulfillments: 20, gassnapshotName: "fulfillMany_20_fulfillments_success"});
        benchmarks[7] = Benchmark({numFulfillments: 30, gassnapshotName: "fulfillMany_30_fulfillments_success"});
        benchmarks[8] = Benchmark({numFulfillments: 40, gassnapshotName: "fulfillMany_40_fulfillments_success"});
        benchmarks[9] = Benchmark({numFulfillments: 50, gassnapshotName: "fulfillMany_50_fulfillments_success"});
        benchmarks[10] = Benchmark({numFulfillments: 75, gassnapshotName: "fulfillMany_75_fulfillments_success"});
        benchmarks[11] = Benchmark({numFulfillments: 100, gassnapshotName: "fulfillMany_100_fulfillments_success"});
        benchmarks[12] = Benchmark({numFulfillments: 1000, gassnapshotName: "fulfillMany_1000_fulfillments_success"});
        benchmarks[13] = Benchmark({numFulfillments: 5000, gassnapshotName: "fulfillMany_5000_fulfillments_success"});
        benchmarks[14] = Benchmark({numFulfillments: 10000, gassnapshotName: "fulfillMany_10000_fulfillments_success"});

        for (uint256 i = 0; i < benchmarks.length; i++) {
            IFulfillmentProxy.Fulfillment[] memory params =
                new IFulfillmentProxy.Fulfillment[](benchmarks[i].numFulfillments);
            for (uint256 j = 0; j < benchmarks[i].numFulfillments; j++) {
                params[j] = IFulfillmentProxy.Fulfillment({
                    quoteHash: bytes32(abi.encodePacked("payment", j)),
                    to: RECIPIENT,
                    token: address(token),
                    // (j + 1), not j: the first item would otherwise be a zero amount, which the
                    // ZeroAmount guard now rejects. Benchmarks must exercise the accepted path.
                    amount: 1000 * (j + 1)
                });
            }
            s_fp.fulfillMany(params);
            vm.snapshotGasLastCall(benchmarks[i].gassnapshotName);
        }
    }

    struct FuzzParams {
        address to;
        uint32 amount;
    }

    function test_fulfillMany_fuzz(bytes32 quoteHash, address settler, FuzzParams[] memory params) public {
        vm.assume(settler != address(0));
        // Empty batches and zero amounts are now rejected inputs with their own dedicated tests
        // (test_fulfillMany_empty_batch_reverts, test_fulfillMany_zero_amount_item_reverts_...).
        // This fuzz test covers the ACCEPTED domain, so it is bounded to it rather than left to
        // generate inputs whose expected outcome is a revert.
        vm.assume(params.length != 0);
        uint256 totalAmount = 0;
        IFulfillmentProxy.Fulfillment[] memory fulfillmentParams = new IFulfillmentProxy.Fulfillment[](params.length);
        for (uint256 i = 0; i < params.length; i++) {
            if (params[i].amount == 0) {
                params[i].amount = 1;
            }
            totalAmount += params[i].amount;
            if (params[i].to == address(0)) {
                params[i].to = makeAddr("to");
            }
            fulfillmentParams[i] = IFulfillmentProxy.Fulfillment({
                quoteHash: quoteHash, to: params[i].to, token: address(token), amount: params[i].amount
            });
        }
        uint256 balanceOfSettler = token.balanceOf(settler);
        if (balanceOfSettler < totalAmount) {
            token.mint(settler, totalAmount - balanceOfSettler);
        }
        uint256 allowance = token.allowance(settler, address(s_fp));
        if (allowance < totalAmount) {
            vm.prank(settler);
            token.approve(address(s_fp), type(uint256).max);
        }

        vm.prank(settler);
        s_fp.fulfillMany(fulfillmentParams);
    }

    // strictFulfill

    function test_strictFulfill_success() public {
        uint256 balanceBefore = token.balanceOf(address(this));
        vm.expectCall(
            address(token), abi.encodeWithSelector(IERC20.transferFrom.selector, address(this), RECIPIENT, 1000)
        );

        IFulfillmentProxy.Fulfillment memory fulfillment =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000});
        // expect the event to be emitted
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment.quoteHash, address(this), fulfillment.to, fulfillment.token, fulfillment.amount, block.timestamp
        );
        s_fp.strictFulfill(fulfillment, block.timestamp + 1000);
        vm.snapshotGasLastCall("strictFulfill_success");
        assertEq(token.balanceOf(RECIPIENT), 1000);
        assertEq(token.balanceOf(address(s_fp)), 0);
        assertEq(token.balanceOf(SETTLER), 0);
        assertEq(token.balanceOf(address(this)), balanceBefore - 1000);
    }

    function test_strictFulfill_expired_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IFulfillmentProxy.DeadlineExpired.selector, block.timestamp - 1, block.timestamp)
        );
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp - 1
        );
    }

    function test_strictFulfill_already_fulfilled_reverts() public {
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp + 1000
        );
        vm.expectRevert(abi.encodeWithSelector(IFulfillmentProxy.AlreadyFulfilled.selector, QUOTE_HASH));
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp + 1000
        );
    }

    function test_strictFulfill_not_approved_reverts() public {
        token.approve(address(s_fp), 0);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(s_fp), 0, 1000)
        );
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp + 1000
        );
    }

    function test_strictFulfill_not_enough_balance_reverts() public {
        uint256 balanceBefore = token.balanceOf(address(this));
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(this), balanceBefore, type(uint256).max
            )
        );
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({
                quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: type(uint256).max
            }),
            block.timestamp + 1000
        );
    }

    function test_strictFulfill_exact_deadline() public {
        // Test with deadline exactly equal to current timestamp
        IFulfillmentProxy.Fulfillment memory fulfillment =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment.quoteHash, address(this), fulfillment.to, fulfillment.token, fulfillment.amount, block.timestamp
        );

        s_fp.strictFulfill(
            fulfillment,
            block.timestamp // Exact deadline boundary
        );
        vm.snapshotGasLastCall("strictFulfill_exact_deadline");

        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    function test_strictFulfill_zero_amount_reverts() public {
        // CORE-2116: a zero amount is rejected (parity with Solana), closing the free-transfer
        // vector for poisoning the strict marker.
        vm.expectRevert(abi.encodeWithSelector(IFulfillmentProxy.ZeroAmount.selector));
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 0}),
            block.timestamp + 1000
        );
    }

    function test_strictFulfill_empty_quoteHash_reverts() public {
        // CORE-2116: an all-zero quoteHash is rejected so the zero-slot marker can't be consumed.
        vm.expectRevert(abi.encodeWithSelector(IFulfillmentProxy.QuoteHashCannotBeEmpty.selector));
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: bytes32(0), to: RECIPIENT, token: address(token), amount: 500}),
            block.timestamp + 1000
        );
    }

    function test_strictFulfill_dormant_allows_unauthorized_caller() public {
        // CORE-2116: with enforcement dormant (default), strictFulfill is permissionless — proving a
        // fresh redeploy is behavior-neutral until the admin flips enforcement on.
        assertFalse(s_fp.s_settlerAllowlistEnforced());
        address anyCaller = makeAddr("anyCaller");
        token.mint(anyCaller, 500);
        vm.prank(anyCaller);
        token.approve(address(s_fp), 500);

        vm.prank(anyCaller);
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 500}),
            block.timestamp + 1000
        );
        assertEq(token.balanceOf(RECIPIENT), 500);
    }

    function test_setSettlerAllowlistEnforced_admin_toggles() public {
        vm.expectEmit(false, false, false, true);
        emit IFulfillmentProxy.SettlerAllowlistEnforcementSet(true);
        s_fp.setSettlerAllowlistEnforced(true);
        assertTrue(s_fp.s_settlerAllowlistEnforced());

        s_fp.setSettlerAllowlistEnforced(false);
        assertFalse(s_fp.s_settlerAllowlistEnforced());
    }

    function test_setSettlerAllowlistEnforced_non_admin_reverts() public {
        address notAdmin = makeAddr("notAdmin");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, notAdmin, s_fp.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(notAdmin);
        s_fp.setSettlerAllowlistEnforced(true);
    }

    function test_strictFulfill_unauthorized_settler_reverts_when_enforced() public {
        // CORE-2116: once enforcement is on, an arbitrary caller cannot pre-set the strict marker for
        // a quote (the griefing DoS). A fully-funded, non-authorized caller is rejected on the role check.
        s_fp.setSettlerAllowlistEnforced(true);
        address attacker = makeAddr("attacker");
        token.mint(attacker, 500);
        vm.prank(attacker);
        token.approve(address(s_fp), 500);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, s_fp.SETTLER_ROLE()
            )
        );
        vm.prank(attacker);
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 500}),
            block.timestamp + 1000
        );
    }

    function test_strictFulfill_authorized_settler_succeeds_when_enforced() public {
        // With enforcement on, a SETTLER_ROLE holder strictly fulfills normally.
        s_fp.setSettlerAllowlistEnforced(true);
        s_fp.grantRole(s_fp.SETTLER_ROLE(), address(this));
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp + 1000
        );
        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    function test_strictFulfill_expired_with_zero_amount_reverts() public {
        // Test that deadline check happens BEFORE fulfill logic (even for zero amounts)
        vm.expectRevert(
            abi.encodeWithSelector(IFulfillmentProxy.DeadlineExpired.selector, block.timestamp - 1, block.timestamp)
        );
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 0}),
            block.timestamp - 1
        );
    }

    function test_strictFulfill_expired_without_approval_reverts() public {
        // Test that deadline check happens BEFORE token transfer checks
        // (Don't approve tokens to test order of validation)
        vm.expectRevert(
            abi.encodeWithSelector(IFulfillmentProxy.DeadlineExpired.selector, block.timestamp - 1, block.timestamp)
        );
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp - 1
        );
    }

    function test_strictFulfill_future_deadline() public {
        // Test with far future deadline
        uint256 futureDeadline = block.timestamp + 365 days;

        IFulfillmentProxy.Fulfillment memory fulfillment =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment.quoteHash, address(this), fulfillment.to, fulfillment.token, fulfillment.amount, block.timestamp
        );

        s_fp.strictFulfill(fulfillment, futureDeadline);
        vm.snapshotGasLastCall("strictFulfill_future_deadline");
        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    function test_strictFulfill_time_manipulation() public {
        uint256 deadline = block.timestamp + 100;

        // Warp time to just before deadline
        vm.warp(deadline - 1);

        // Should succeed
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 500}),
            deadline
        );

        assertEq(token.balanceOf(RECIPIENT), 500);

        // Mint more tokens for second test
        token.mint(address(this), 500);

        // Warp time to just after deadline
        vm.warp(deadline + 1);

        // Should fail
        vm.expectRevert(abi.encodeWithSelector(IFulfillmentProxy.DeadlineExpired.selector, deadline, deadline + 1));
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 500}),
            deadline
        );
    }

    function test_strictFulfill_paused_reverts() public {
        vm.startPrank(s_pauser);
        // Pause the contract
        s_fp.pause();
        vm.stopPrank();
        // Should revert with EnforcedPause
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            block.timestamp + 1000
        );
    }

    // fulfill (direct tests)

    function test_fulfill_success() public {
        uint256 balanceBefore = token.balanceOf(address(this));
        vm.expectCall(
            address(token), abi.encodeWithSelector(IERC20.transferFrom.selector, address(this), RECIPIENT, 1000)
        );

        // expect the event to be emitted
        IFulfillmentProxy.Fulfillment memory fulfillment =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment.quoteHash, address(this), fulfillment.to, fulfillment.token, fulfillment.amount, block.timestamp
        );

        s_fp.fulfill(fulfillment);
        vm.snapshotGasLastCall("fulfill_success");

        assertEq(token.balanceOf(RECIPIENT), 1000);
        assertEq(token.balanceOf(address(s_fp)), 0);
        assertEq(token.balanceOf(SETTLER), 0);
        assertEq(token.balanceOf(address(this)), balanceBefore - 1000);
    }

    function test_fulfill_not_approved_reverts() public {
        token.approve(address(s_fp), 0);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(s_fp), 0, 1000)
        );
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000})
        );
    }

    function test_fulfill_not_enough_balance_reverts() public {
        uint256 balanceBefore = token.balanceOf(address(this));
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(this), balanceBefore, type(uint256).max
            )
        );
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({
                quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: type(uint256).max
            })
        );
    }

    /// @dev This test previously asserted that a zero-amount fulfill SUCCEEDED and emitted Fulfilled,
    /// with the comment "expect the event to be emitted even for zero amount". That was the finding:
    /// a zero-value transfer is legal, so the event was free to anyone, for any quoteHash
    /// (Cantina F2, Jayfromthe13th). strictFulfill already rejected it; fulfill now does too.
    function test_fulfill_zero_amount_reverts() public {
        uint256 balanceBefore = token.balanceOf(address(this));

        IFulfillmentProxy.Fulfillment memory fulfillment =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 0});

        vm.expectRevert(IFulfillmentProxy.ZeroAmount.selector);
        s_fp.fulfill(fulfillment);

        assertEq(token.balanceOf(RECIPIENT), 0);
        assertEq(token.balanceOf(address(this)), balanceBefore);
    }

    /// @notice The reason the zero-amount guard is a guard and not a nit.
    /// @dev Before it, an attacker holding NO tokens and NO approval could emit a genuine Fulfilled
    /// event bound to a victim's quoteHash for the price of gas. Proven by giving the attacker
    /// nothing at all: the revert is ZeroAmount, NOT a balance or allowance error, which is what
    /// shows the contract rejected it on the amount rather than incidentally failing the transfer.
    function test_fulfill_attacker_with_no_tokens_cannot_emit_a_free_Fulfilled() public {
        address attacker = makeAddr("freeEventAttacker");
        bytes32 victimQuoteHash = keccak256("victimQuote");

        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.allowance(attacker, address(s_fp)), 0);

        vm.prank(attacker);
        vm.expectRevert(IFulfillmentProxy.ZeroAmount.selector);
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: victimQuoteHash, to: attacker, token: address(token), amount: 0})
        );

        IFulfillmentProxy.Fulfillment[] memory batch = new IFulfillmentProxy.Fulfillment[](1);
        batch[0] =
            IFulfillmentProxy.Fulfillment({quoteHash: victimQuoteHash, to: attacker, token: address(token), amount: 0});
        vm.prank(attacker);
        vm.expectRevert(IFulfillmentProxy.ZeroAmount.selector);
        s_fp.fulfillMany(batch);

        vm.prank(attacker);
        vm.expectRevert(IFulfillmentProxy.EmptyFulfillmentBatch.selector);
        s_fp.fulfillMany(new IFulfillmentProxy.Fulfillment[](0));
    }

    /// @dev A zero item anywhere in the batch reverts the whole call — including in LAST position,
    /// which is the case a guard placed outside the loop would miss.
    function test_fulfillMany_zero_amount_item_reverts_and_transfers_nothing() public {
        IFulfillmentProxy.Fulfillment[] memory params = new IFulfillmentProxy.Fulfillment[](3);
        params[0] = IFulfillmentProxy.Fulfillment({
            quoteHash: keccak256("q0"), to: RECIPIENT, token: address(token), amount: 1000
        });
        params[1] = IFulfillmentProxy.Fulfillment({
            quoteHash: keccak256("q1"), to: RECIPIENT, token: address(token), amount: 2000
        });
        params[2] = IFulfillmentProxy.Fulfillment({
            quoteHash: keccak256("q2"), to: RECIPIENT, token: address(token), amount: 0
        });

        uint256 balanceBefore = token.balanceOf(RECIPIENT);
        vm.expectRevert(IFulfillmentProxy.ZeroAmount.selector);
        s_fp.fulfillMany(params);

        // The two valid transfers ahead of it are rolled back with the revert.
        assertEq(token.balanceOf(RECIPIENT), balanceBefore);
    }

    function test_fulfillMany_empty_batch_reverts() public {
        vm.expectRevert(IFulfillmentProxy.EmptyFulfillmentBatch.selector);
        s_fp.fulfillMany(new IFulfillmentProxy.Fulfillment[](0));
    }

    function test_fulfill_different_caller() public {
        address differentCaller = makeAddr("differentCaller");
        token.mint(differentCaller, 500);

        vm.prank(differentCaller);
        token.approve(address(s_fp), 500);

        // expect the event to be emitted with the different caller as the solver
        IFulfillmentProxy.Fulfillment memory fulfillment =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 500});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment.quoteHash,
            differentCaller,
            fulfillment.to,
            fulfillment.token,
            fulfillment.amount,
            block.timestamp
        );

        vm.prank(differentCaller);
        s_fp.fulfill(fulfillment);
        assertEq(token.balanceOf(RECIPIENT), 500);
        assertEq(token.balanceOf(differentCaller), 0);
    }

    function test_fulfill_paused_reverts() public {
        vm.startPrank(s_pauser);
        // Pause the contract
        s_fp.pause();
        vm.stopPrank();
        // Should revert with EnforcedPause
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000})
        );
    }

    // TRADITIONAL ERC20 EDGE CASES

    function test_fulfill_with_exact_allowance() public {
        uint256 amount = 1000;

        // Approve exactly the amount needed
        token.approve(address(s_fp), 0);
        token.approve(address(s_fp), amount);

        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: amount})
        );
        vm.snapshotGasLastCall("fulfill_with_exact_allowance");
        // Should consume entire allowance
        assertEq(token.allowance(address(this), address(s_fp)), 0);
        assertEq(token.balanceOf(RECIPIENT), amount);
    }

    function test_fulfill_to_zero_address_reverts() public {
        // This should revert - OpenZeppelin's ERC20 prevents transfers to zero address
        vm.expectRevert();
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: address(0), token: address(token), amount: 1000})
        );
    }

    function test_fulfill_to_contract_address() public {
        // Transfer to the contract itself
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({
                quoteHash: QUOTE_HASH, to: address(s_fp), token: address(token), amount: 1000
            })
        );
        vm.snapshotGasLastCall("fulfill_to_contract_address");
        assertEq(token.balanceOf(address(s_fp)), 1000);
    }

    // PARAMETER VALIDATION EDGE CASES

    function test_fulfill_with_different_payment_hashes() public {
        bytes32 quoteHash1 = keccak256("payment1");
        bytes32 quoteHash2 = keccak256("payment2");

        // First fulfillment
        IFulfillmentProxy.Fulfillment memory fulfillment1 =
            IFulfillmentProxy.Fulfillment({quoteHash: quoteHash1, to: RECIPIENT, token: address(token), amount: 500});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment1.quoteHash,
            address(this),
            fulfillment1.to,
            fulfillment1.token,
            fulfillment1.amount,
            block.timestamp
        );
        s_fp.fulfill(fulfillment1);

        // Second fulfillment with different hash
        IFulfillmentProxy.Fulfillment memory fulfillment2 =
            IFulfillmentProxy.Fulfillment({quoteHash: quoteHash2, to: RECIPIENT, token: address(token), amount: 500});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment2.quoteHash,
            address(this),
            fulfillment2.to,
            fulfillment2.token,
            fulfillment2.amount,
            block.timestamp
        );
        s_fp.fulfill(fulfillment2);

        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    function test_fulfill_with_different_settlers() public {
        address settler1 = makeAddr("settler1");
        address settler2 = makeAddr("settler2");
        token.mint(settler1, 1500);
        token.mint(settler2, 1500);
        vm.prank(settler1);
        token.approve(address(s_fp), type(uint256).max);
        vm.prank(settler2);
        token.approve(address(s_fp), type(uint256).max);

        // First fulfillment
        IFulfillmentProxy.Fulfillment memory fulfillment1 =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 500});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment1.quoteHash, settler1, fulfillment1.to, fulfillment1.token, fulfillment1.amount, block.timestamp
        );
        vm.prank(settler1);
        s_fp.fulfill(fulfillment1);

        // Second fulfillment with different settler
        IFulfillmentProxy.Fulfillment memory fulfillment2 =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 500});
        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.Fulfilled(
            fulfillment2.quoteHash, settler2, fulfillment2.to, fulfillment2.token, fulfillment2.amount, block.timestamp
        );
        vm.prank(settler2);
        s_fp.fulfill(fulfillment2);

        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    // GAS OPTIMIZATION EDGE CASES

    function test_fulfill_multiple_times_same_approval() public {
        // Approve large amount once
        token.approve(address(s_fp), 0);
        token.approve(address(s_fp), 10000);

        // Execute multiple small fulfillments
        for (uint256 i = 0; i < 5; i++) {
            s_fp.fulfill(
                IFulfillmentProxy.Fulfillment({
                    quoteHash: keccak256(abi.encode("payment", i)), to: RECIPIENT, token: address(token), amount: 100
                })
            );
        }

        assertEq(token.balanceOf(RECIPIENT), 500);
        assertEq(token.allowance(address(this), address(s_fp)), 9500);
    }

    // REENTRANCY PROTECTION TESTS (if any)

    // BOUNDARY VALUE TESTS

    function test_fulfill_max_uint256_amount() public {
        // This would normally fail due to insufficient balance, but let's test the parameter handling
        uint256 maxAmount = type(uint256).max;

        uint256 balanceBefore = token.balanceOf(address(this));

        // Should revert with insufficient balance, not overflow
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(this), balanceBefore, maxAmount
            )
        );
        s_fp.fulfill(
            IFulfillmentProxy.Fulfillment({
                quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: maxAmount
            })
        );
    }

    function test_strictFulfill_boundary_deadlines() public {
        // Test with maximum possible deadline
        uint256 maxDeadline = type(uint256).max;

        s_fp.strictFulfill(
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000}),
            maxDeadline
        );

        assertEq(token.balanceOf(RECIPIENT), 1000);
    }

    /// @notice The strict idempotency marker is keyed on the bare quoteHash, so it is
    /// sender-independent: once ANY settler strictly fulfills a quoteHash, a different,
    /// fully-funded settler cannot strictly fulfill that same quoteHash. This pins the one
    /// behavioral change from the pre-quoteHash `(depositId, msg.sender)` keying — the earlier
    /// strict tests all reuse one caller, so they pass under either keying and don't cover it.
    function test_strictFulfill_sender_independent_reverts() public {
        // The strict marker is keyed on the bare quoteHash, so it is sender-independent even among
        // authorized settlers. Verified under enforcement so the second revert is the marker, not the
        // role.
        s_fp.setSettlerAllowlistEnforced(true);
        s_fp.grantRole(s_fp.SETTLER_ROLE(), address(this));
        IFulfillmentProxy.Fulfillment memory fulfillment =
            IFulfillmentProxy.Fulfillment({quoteHash: QUOTE_HASH, to: RECIPIENT, token: address(token), amount: 1000});
        // Settler A (this contract) strictly fulfills quoteHash Q.
        s_fp.strictFulfill(fulfillment, block.timestamp + 1000);

        // Settler B is authorized (CORE-2116 role gate) and fully funded, so the only thing that
        // can stop it is the per-quote marker — proving the revert is the idempotency guard, not a
        // role or funding error.
        address settlerB = makeAddr("settlerB");
        s_fp.grantRole(s_fp.SETTLER_ROLE(), settlerB);
        token.mint(settlerB, 1000);
        vm.prank(settlerB);
        token.approve(address(s_fp), 1000);

        vm.expectRevert(abi.encodeWithSelector(IFulfillmentProxy.AlreadyFulfilled.selector, QUOTE_HASH));
        vm.prank(settlerB);
        s_fp.strictFulfill(fulfillment, block.timestamp + 1000);
    }

    /// @notice fulfillMany emits FulfilledMany(fulfillments, settler, timestamp). `settler` is the
    /// indexed msg.sender and is a verification input for atum-core's fulfillment verifier, so it is
    /// asserted here (it is the sole indexed param, so expectEmit checks it as topic1). Pins the batch
    /// event layout.
    /// @dev The declaration order below (`fulfillments` then `settler`) is the DEPLOYED order and is
    /// what keeps topic0 at the deployed 0xa55853fe; see IFulfillmentProxy.FulfilledMany.
    function test_fulfillMany_emits_FulfilledMany() public {
        IFulfillmentProxy.Fulfillment[] memory params = new IFulfillmentProxy.Fulfillment[](2);
        params[0] = IFulfillmentProxy.Fulfillment({
            quoteHash: keccak256("q0"), to: RECIPIENT, token: address(token), amount: 1000
        });
        params[1] = IFulfillmentProxy.Fulfillment({
            quoteHash: keccak256("q1"), to: RECIPIENT, token: address(token), amount: 2000
        });

        vm.expectEmit(true, true, true, true);
        emit IFulfillmentProxy.FulfilledMany(params, address(this), block.timestamp);
        s_fp.fulfillMany(params);

        assertEq(token.balanceOf(RECIPIENT), 3000);
    }
}
