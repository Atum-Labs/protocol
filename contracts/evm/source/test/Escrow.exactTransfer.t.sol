// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {Escrow} from "../src/Escrow.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {DeployCoreContracts} from "../script/deploy/DeployCoreContracts.s.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {
    MockToken,
    SkimmingToken,
    SkimsAfterFirstTransferToken,
    InflatingToken,
    FeeRevenueObserverToken
} from "./mock/MockToken.sol";

/// @notice The escrow must credit a deposit only for what it actually received, and must book the
/// release fee before it hands control to the token.
///
/// Every deposit shares one pooled token balance and the stored ActiveDeposit is credited with the
/// reserver-attested sourceAmount. If a token delivers less than the escrow asked for, the deposit
/// is credited for tokens that never arrived and the shortfall is paid out of other depositors'
/// funds, silently, until a later release or refund hits an empty pool and reverts. Refund is the
/// escape hatch and there is no rescue function, so those funds are stranded. USDT is named as a
/// supported token in IEscrow's TOKEN REQUIREMENTS block and carries an owner-settable transfer fee
/// that is currently, but not permanently, zero.
contract EscrowExactTransferTest is Test, TestHelpers {
    using SafeERC20 for IERC20;

    Escrow private s_escrow;
    IPermit2 private s_permit2;

    MockToken private s_exactToken;
    SkimmingToken private s_skimmingToken;
    SkimsAfterFirstTransferToken private s_lateSkimToken;
    InflatingToken private s_inflatingToken;
    FeeRevenueObserverToken private s_observerToken;

    address private s_depositor;
    uint256 private s_depositorPrivateKey;
    address private s_reserver;
    uint256 private s_reserverPrivateKey;
    address private s_releaser;
    uint256 private s_releaserPrivateKey;
    address private s_settler = makeAddr("settler");
    address private s_tokenConfigAdmin;

    uint256 private constant DEPOSIT_AMOUNT = 1000e18;
    /// @dev 1% skim, chosen large enough that the shortfall is unmistakable in an assertion
    uint256 private constant SKIM_BASIS_POINTS = 100;
    /// @dev Surplus the InflatingToken hands the recipient on top of the requested amount
    uint256 private constant INFLATION_BONUS = 1e18;

    function setUp() public {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. The escrow constructor requires
        // code at PERMIT2_ADDRESS; nothing in this suite reads any other chain state -- every token
        // here is deployed locally, which is the whole point of the fixtures.
        s_permit2 = LocalPermit2.etch();

        s_exactToken = new MockToken("Exact Token", "EXACT");
        s_skimmingToken = new SkimmingToken("Skimming Token", "SKIM", SKIM_BASIS_POINTS);
        s_lateSkimToken = new SkimsAfterFirstTransferToken("Late Skim Token", "LATE");
        s_inflatingToken = new InflatingToken("Inflating Token", "INFL", INFLATION_BONUS);
        s_observerToken = new FeeRevenueObserverToken("Observer Token", "OBS");

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run();

        s_observerToken.setEscrow(address(s_escrow));

        s_tokenConfigAdmin = makeAddr("tokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), s_tokenConfigAdmin);

        vm.startPrank(s_tokenConfigAdmin);
        _allowToken(address(s_exactToken));
        _allowToken(address(s_skimmingToken));
        _allowToken(address(s_lateSkimToken));
        _allowToken(address(s_inflatingToken));
        _allowToken(address(s_observerToken));
        vm.stopPrank();

        (s_depositor, s_depositorPrivateKey) = makeAddrAndKey("depositor");
        (s_reserver, s_reserverPrivateKey) = makeAddrAndKey("reserver");
        (s_releaser, s_releaserPrivateKey) = makeAddrAndKey("releaser");

        _fundDepositor(address(s_exactToken));
        _fundDepositor(address(s_skimmingToken));
        _fundDepositor(address(s_lateSkimToken));
        _fundDepositor(address(s_inflatingToken));
        _fundDepositor(address(s_observerToken));
    }

    // ---------------------------------------------------------------------------------------
    // The mocks themselves. Without these the guard tests below could pass for the wrong reason.
    // ---------------------------------------------------------------------------------------

    /// @notice The skimming mock genuinely short-delivers, with the escrow nowhere in the picture.
    /// @dev This is the load-bearing half of test_deposit_feeOnTransferToken_reverts: it proves the
    /// revert there is caused by a real shortfall, not by the mock being broken in some other way.
    function test_skimmingToken_shortDelivers() public {
        address recipient = makeAddr("recipient");
        uint256 expectedSkim = (DEPOSIT_AMOUNT * SKIM_BASIS_POINTS) / 10_000;

        uint256 senderBefore = s_skimmingToken.balanceOf(s_depositor);

        vm.prank(s_depositor);
        s_skimmingToken.transfer(recipient, DEPOSIT_AMOUNT);

        assertEq(
            s_skimmingToken.balanceOf(recipient),
            DEPOSIT_AMOUNT - expectedSkim,
            "mock must deliver strictly less than requested"
        );
        assertLt(s_skimmingToken.balanceOf(recipient), DEPOSIT_AMOUNT, "mock must short-deliver");
        assertEq(
            senderBefore - s_skimmingToken.balanceOf(s_depositor),
            DEPOSIT_AMOUNT,
            "sender must still be debited the full requested amount"
        );
        assertEq(s_skimmingToken.balanceOf(s_skimmingToken.FEE_SINK()), expectedSkim, "skim must land in the fee sink");
    }

    /// @notice The inflating mock genuinely over-delivers.
    /// @dev The reason the escrow's check is an equality and not a `>=`.
    function test_inflatingToken_overDelivers() public {
        address recipient = makeAddr("recipient");

        vm.prank(s_depositor);
        s_inflatingToken.transfer(recipient, DEPOSIT_AMOUNT);

        assertEq(
            s_inflatingToken.balanceOf(recipient),
            DEPOSIT_AMOUNT + INFLATION_BONUS,
            "mock must deliver strictly more than requested"
        );
    }

    // ---------------------------------------------------------------------------------------
    // TASK 1 -- the escrow must verify it actually received sourceAmount.
    // ---------------------------------------------------------------------------------------

    /// @notice A fee-on-transfer token cannot be deposited: the escrow refuses to credit a deposit
    /// for more than the balance it actually gained.
    function test_deposit_feeOnTransferToken_reverts() public {
        (IEscrow.DepositInput memory input,) = _buildDeposit(address(s_skimmingToken), DEPOSIT_AMOUNT, 1);

        uint256 skim = (DEPOSIT_AMOUNT * SKIM_BASIS_POINTS) / 10_000;
        uint256 escrowBalanceBefore = s_skimmingToken.balanceOf(address(s_escrow));

        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT - skim)
        );
        s_escrow.deposit(input);

        // Nothing was credited and nothing was kept.
        assertEq(
            s_skimmingToken.balanceOf(address(s_escrow)), escrowBalanceBefore, "escrow must not retain a short delivery"
        );
    }

    /// @notice A token that over-delivers is rejected too -- the check is an equality, so it cannot
    /// be gamed from either direction.
    /// @dev Under a `>=` check this deposit would succeed and leave INFLATION_BONUS of unattributed
    /// dust in the shared pool that no release or refund witness can move.
    function test_deposit_inflatingToken_reverts() public {
        (IEscrow.DepositInput memory input,) = _buildDeposit(address(s_inflatingToken), DEPOSIT_AMOUNT, 2);

        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT + INFLATION_BONUS)
        );
        s_escrow.deposit(input);
    }

    /// @notice Happy-path regression: an exact-transfer token still deposits, and the escrow's
    /// balance moves by exactly the source amount.
    function test_deposit_exactTransferToken_succeeds() public {
        (IEscrow.DepositInput memory input, bytes32 depositId) = _buildDeposit(address(s_exactToken), DEPOSIT_AMOUNT, 3);

        uint256 escrowBalanceBefore = s_exactToken.balanceOf(address(s_escrow));
        uint256 depositorBalanceBefore = s_exactToken.balanceOf(s_depositor);

        bytes32 returnedDepositId = s_escrow.deposit(input);

        assertEq(returnedDepositId, depositId, "deposit id");
        assertTrue(s_escrow.getDepositHash(depositId) != bytes32(0), "deposit must be stored");
        assertEq(
            s_exactToken.balanceOf(address(s_escrow)) - escrowBalanceBefore,
            DEPOSIT_AMOUNT,
            "escrow must gain exactly the source amount"
        );
        assertEq(
            depositorBalanceBefore - s_exactToken.balanceOf(s_depositor),
            DEPOSIT_AMOUNT,
            "depositor must be debited exactly the source amount"
        );
    }

    /// @notice A source amount below the permit ceiling still has to arrive in full.
    /// @dev sourceAmount, not the permit cap, is what the deposit is credited for, so it is
    /// sourceAmount the balance delta must equal.
    function test_deposit_sourceAmountBelowPermitCap_succeeds() public {
        uint256 sourceAmount = DEPOSIT_AMOUNT / 4;
        (IEscrow.DepositInput memory input,) =
            _buildDepositWithCap(address(s_exactToken), DEPOSIT_AMOUNT, sourceAmount, 4);

        uint256 escrowBalanceBefore = s_exactToken.balanceOf(address(s_escrow));
        s_escrow.deposit(input);

        assertEq(
            s_exactToken.balanceOf(address(s_escrow)) - escrowBalanceBefore,
            sourceAmount,
            "escrow must gain exactly the source amount, not the permit cap"
        );
    }

    /// @notice The balance snapshot is taken per deposit, not once around the depositMany loop.
    /// @dev The token delivers the first item honestly and skims the second. The error names the
    /// SECOND item's amounts, which is only reachable if each item is measured against its own
    /// delta. A snapshot hoisted outside the loop sees one aggregate delta and cannot produce this.
    function test_depositMany_balanceIsCheckedPerItem() public {
        uint256 firstAmount = DEPOSIT_AMOUNT;
        uint256 secondAmount = DEPOSIT_AMOUNT / 2;

        IEscrow.DepositInput[] memory inputs = new IEscrow.DepositInput[](2);
        (inputs[0],) = _buildDeposit(address(s_lateSkimToken), firstAmount, 5);
        (inputs[1],) = _buildDeposit(address(s_lateSkimToken), secondAmount, 6);

        uint256 secondSkim = (secondAmount * s_lateSkimToken.FEE_BASIS_POINTS()) / 10_000;

        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, secondAmount, secondAmount - secondSkim)
        );
        s_escrow.depositMany(inputs);
    }

    /// @notice The same token in the same batch, both items honest, still deposits.
    /// @dev The companion to the test above: proves the per-item window is not merely stricter but
    /// correct, i.e. the second item is measured from the first item's end state rather than zero.
    function test_depositMany_sameTokenTwice_succeeds() public {
        IEscrow.DepositInput[] memory inputs = new IEscrow.DepositInput[](2);
        (inputs[0],) = _buildDeposit(address(s_exactToken), DEPOSIT_AMOUNT, 7);
        (inputs[1],) = _buildDeposit(address(s_exactToken), DEPOSIT_AMOUNT / 2, 8);

        uint256 escrowBalanceBefore = s_exactToken.balanceOf(address(s_escrow));
        s_escrow.depositMany(inputs);

        assertEq(
            s_exactToken.balanceOf(address(s_escrow)) - escrowBalanceBefore,
            DEPOSIT_AMOUNT + DEPOSIT_AMOUNT / 2,
            "escrow must gain the sum of both source amounts"
        );
    }

    // ---------------------------------------------------------------------------------------
    // TASK 2 -- Checks-Effects-Interactions on the release path.
    // ---------------------------------------------------------------------------------------

    /// @notice The release fee is booked in storage BEFORE the outbound transfer hands control to
    /// the token.
    /// @dev The token reads the escrow's own getFeeRevenue from inside the transfer it is being
    /// asked to perform. With the accrual after the transfer, that read returns 0.
    function test_release_feeIsAccountedBeforeOutboundTransfer() public {
        (IEscrow.DepositInput memory input, bytes32 depositId) =
            _buildDeposit(address(s_observerToken), DEPOSIT_AMOUNT, 9);
        s_escrow.deposit(input);

        uint256 feeAmount =
            s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(IERC20(address(s_observerToken))));
        assertGt(feeAmount, 0, "fee must be non-zero or this test asserts nothing");
        assertEq(s_escrow.getFeeRevenue(IERC20(address(s_observerToken))), 0, "fee revenue must start at zero");

        _release(depositId, address(s_observerToken), DEPOSIT_AMOUNT, feeAmount);

        assertTrue(s_observerToken.s_observed(), "the escrow's outbound transfer must have been observed");
        assertEq(
            s_observerToken.s_feeRevenueDuringTransfer(),
            feeAmount,
            "fee revenue must already be booked when the outbound transfer runs"
        );
    }

    // ---------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------

    /// @dev Deliberately not TestHelpers.releaseDeposit: that helper records a gas snapshot, which
    /// would mint a whole snapshots/ file for this suite over one incidental release.
    function _release(bytes32 depositId, address token, uint256 amount, uint256 feeAmount) private {
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: s_depositor,
            token: token,
            amount: amount,
            feeAmount: feeAmount,
            reserver: s_reserver,
            releaser: s_releaser,
            settler: s_settler
        });
        s_escrow.release(
            IEscrow.ReleaseInput({
                releaseWitness: witness,
                releaseSignature: _constructReleaseSignature(witness, address(s_escrow), s_releaserPrivateKey)
            })
        );
    }

    // ---------------------------------------------------------------------------------------
    // The same guard on `directDeposit`, which pulls with the owner's approval instead of Permit2.
    // ---------------------------------------------------------------------------------------

    /// @notice A fee-on-transfer token cannot be direct-deposited either.
    function test_directDeposit_feeOnTransferToken_reverts() public {
        uint256 skim = (DEPOSIT_AMOUNT * SKIM_BASIS_POINTS) / 10_000;

        vm.startPrank(s_depositor);
        s_skimmingToken.approve(address(s_escrow), DEPOSIT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT - skim)
        );
        s_escrow.directDeposit(_directInput(address(s_skimmingToken)));
        vm.stopPrank();
    }

    /// @notice Nor can a token that over-delivers.
    function test_directDeposit_inflatingToken_reverts() public {
        vm.startPrank(s_depositor);
        s_inflatingToken.approve(address(s_escrow), DEPOSIT_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT + INFLATION_BONUS)
        );
        s_escrow.directDeposit(_directInput(address(s_inflatingToken)));
        vm.stopPrank();
    }

    function _allowToken(address token) private {
        s_escrow.allowToken(IERC20(token), 18);
        // Same fee configuration the other deposit suites use: 0.02%, no floor, 25.000000 ceiling.
        s_escrow.setTokenFeeConfig(IERC20(token), 20000, 0, 25000000);
    }

    function _fundDepositor(address token) private {
        // mint(), not deal(): deal writes balances directly and would bypass the mocks' transfer
        // behaviour, but more importantly the mocks must be funded through their own mint path so
        // their transfer counters and supply accounting stay honest.
        MockToken(token).mint(s_depositor, DEPOSIT_AMOUNT * 100);
        vm.prank(s_depositor);
        IERC20(token).forceApprove(address(s_permit2), type(uint256).max);
    }

    function _buildDeposit(address token, uint256 amount, uint256 nonce)
        private
        view
        returns (IEscrow.DepositInput memory input, bytes32 depositId)
    {
        return _buildDepositWithCap(token, amount, amount, nonce);
    }

    /// @param permitCap The ceiling the depositor authorises via Permit2
    /// @param sourceAmount The amount actually charged, attested by the reserver (<= permitCap)
    function _buildDepositWithCap(address token, uint256 permitCap, uint256 sourceAmount, uint256 nonce)
        private
        view
        returns (IEscrow.DepositInput memory input, bytes32 depositId)
    {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) = _constructDepositPermitWitness(
            token, permitCap, s_reserver, s_releaser, nonce, DEFAULT_DEPOSIT_REQUEST_HASH, DEFAULT_DESTINATION
        );

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), s_depositorPrivateKey);

        depositId = keccak256(abi.encode(s_depositor, depositSignature, permit.nonce));

        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, s_settler, sourceAmount);

        input = IEscrow.DepositInput({
            permit: permit,
            depositor: s_depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: _constructReserveSignature(s_escrow, reserveWitness, s_reserverPrivateKey)
        });
    }

    function _directInput(address token) private view returns (IEscrow.DirectDepositInput memory) {
        return IEscrow.DirectDepositInput({
            token: token,
            amount: DEPOSIT_AMOUNT,
            nonce: 1,
            depositWitness: IEscrow.DepositWitness({
                depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                destination: DEFAULT_DESTINATION,
                reserver: s_reserver,
                releaser: s_releaser
            })
        });
    }
}
