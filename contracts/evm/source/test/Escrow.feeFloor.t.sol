// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {ITokenConfig} from "../src/interfaces/ITokenConfig.sol";
import {Escrow} from "../src/Escrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockToken6Decimals} from "./mock/MockToken.sol";
import {DeployCoreContracts} from "../script/deploy/DeployCoreContracts.s.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";

/// @notice The minimum-fee floor as reached THROUGH deposit(), and the fee basis it is measured
///         against.
///
/// @dev WHY THIS FILE EXISTS
///
/// The fee basis moved from the permit's authorization CEILING to the winning quote's
/// `reserveWitness.sourceAmount` (evm-contracts #84, arriving in production at this cutover — it is
/// not an ancestor of the sha atum-core currently pins, so today's production still charges off the
/// ceiling). That makes `FeeExceedsDepositAmount` newly reachable from `deposit()`: a quote whose
/// source amount is at or below the configured minimum fee now reverts the deposit, where before the
/// same quote under a large permit ceiling was charged a percentage of the ceiling and went through.
///
/// Nothing tested that. `Escrow.fees.t.sol` names `FeeExceedsDepositAmount` twenty times but calls
/// `determineFee` — a `public pure` function — 128 times and `deposit()` ZERO times, so the revert
/// was only ever exercised as arithmetic on a struct the caller built. Whether a real deposit
/// actually fails, at which boundary, and with which error, was unproven. It is a payer-visible
/// failure on a live path, so it gets tests that go through the real path.
///
/// Every case here drives `deposit()`/`depositMany()` end to end against real Permit2 (etched
/// locally, no RPC — see test/helpers/LocalPermit2.sol) with a genuine depositor signature, so a
/// pass means the whole ordering deposit → determineFee → _deposit behaves as claimed.
contract EscrowFeeFloorTest is Test, TestHelpers {
    using SafeERC20 for IERC20;

    /// @dev 6-decimal token: the fee config's min/max are expressed in 10^6 units, so at 6 decimals
    /// `minFee6Decimals` maps 1:1 onto token atomic units and the boundary arithmetic below is
    /// exact rather than a scaled approximation. `determineFee` scales by
    /// 10^tokenDecimals / 10^6, which is 1 here.
    uint8 private constant TOKEN_DECIMALS = 6;

    /// @dev $10.00 floor in 10^6 units == 10_000_000 atomic units at 6 decimals.
    uint80 private constant MIN_FEE = 10e6;
    /// @dev Deliberately zero: with no percentage component the fee IS the floor, so the boundary
    /// under test is exactly MIN_FEE and not MIN_FEE-or-the-percentage-whichever-is-larger. The
    /// percentage interaction is `Escrow.fees.t.sol`'s subject.
    uint88 private constant FEE_PERCENTAGE = 0;
    /// @dev NO cap. Deliberate, and forced: `_setTokenFeeConfig` rejects a zero percentage
    /// alongside a non-zero maxFee (FeePercentageCannotBeZeroWhenMaxFeeIsSet), so a zero percentage
    /// and an unset cap are the only combination that isolates the floor. It is also the shape that
    /// makes the boundary exact — with no cap the fee cannot be clamped away from MIN_FEE.
    uint80 private constant MAX_FEE = 0;

    /// @dev The permit CEILING every case authorizes. Comfortably above the floor on purpose: it is
    /// what makes the basis change observable. Under the old ceiling-based basis a deposit with this
    /// permit could never trip the floor.
    uint256 private constant PERMIT_CEILING = 1_000e6;

    Escrow private s_escrow;
    IERC20 private s_token;
    IPermit2 private s_permit2;

    address private s_tokenConfigAdmin;
    address private depositor;
    uint256 private depositorPrivateKey;
    address private reserver;
    uint256 private reserverPrivateKey;
    address private releaser;
    address private settler;

    function setUp() public {
        s_permit2 = LocalPermit2.etch();

        s_token = IERC20(address(new MockToken6Decimals("Fee Floor Token", "FLOOR")));

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run();

        s_tokenConfigAdmin = makeAddr("feeFloorTokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), s_tokenConfigAdmin);
        vm.startPrank(s_tokenConfigAdmin);
        s_escrow.allowTokenAndSetFeeConfig(s_token, TOKEN_DECIMALS, FEE_PERCENTAGE, MIN_FEE, MAX_FEE);
        vm.stopPrank();

        (depositor, depositorPrivateKey) = makeAddrAndKey("feeFloorDepositor");
        (reserver, reserverPrivateKey) = makeAddrAndKey("feeFloorReserver");
        releaser = makeAddr("feeFloorReleaser");
        settler = makeAddr("feeFloorSettler");

        deal(address(s_token), depositor, PERMIT_CEILING * 10);
        vm.prank(depositor);
        s_token.forceApprove(address(s_permit2), type(uint256).max);

        // Fixture guard: the floor must actually be the binding term, or every assertion below
        // would be about the percentage instead and would pass for the wrong reason.
        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(s_token);
        assertEq(config.minFee6Decimals, MIN_FEE, "min fee did not take");
        assertEq(config.feePercentage6Decimals, 0, "a non-zero percentage would mask the floor");
        assertEq(
            s_escrow.determineFee(PERMIT_CEILING, config),
            _scaledMinFee(),
            "with a zero percentage the fee must be exactly the scaled floor"
        );
    }

    /// @dev MIN_FEE scaled from 10^6 units into the token's atomic units, the same way
    /// determineFee does it. Derived rather than transcribed so a decimals change cannot leave a
    /// stale literal behind.
    function _scaledMinFee() private pure returns (uint256) {
        return (uint256(MIN_FEE) * (10 ** uint256(TOKEN_DECIMALS))) / 1_000_000;
    }

    function _buildDepositInput(uint256 nonce, uint256 sourceAmount)
        private
        view
        returns (IEscrow.DepositInput memory depositInput)
    {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) = _constructDepositPermitWitness(
            address(s_token),
            PERMIT_CEILING,
            reserver,
            releaser,
            nonce,
            DEFAULT_DEPOSIT_REQUEST_HASH,
            DEFAULT_DESTINATION
        );

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);
        bytes32 depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, sourceAmount);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
    }

    /// @notice A winning quote EQUAL to the fee floor reverts the deposit.
    /// @dev The boundary is `feeAmount >= amount`, so equality is the first failing value: the
    /// escrow refuses a deposit whose entire principal would be consumed by the fee, leaving a
    /// zero-value escrow that could still be released.
    function test_deposit_revertsWhenSourceAmountEqualsTheFeeFloor() public {
        uint256 sourceAmount = _scaledMinFee();
        // Built BEFORE arming the expectation: _buildDepositInput makes external view calls
        // (Permit2's DOMAIN_SEPARATOR, the escrow's domain separator) and vm.expectRevert binds to
        // the very next call, so constructing it inside the argument list would arm the expectation
        // against one of those views and the test would fail for an unrelated reason.
        IEscrow.DepositInput memory depositInput = _buildDepositInput(1, sourceAmount);

        vm.expectRevert(
            abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, sourceAmount, _scaledMinFee())
        );
        s_escrow.deposit(depositInput);
    }

    /// @notice A winning quote BELOW the fee floor reverts the deposit.
    function test_deposit_revertsWhenSourceAmountIsBelowTheFeeFloor() public {
        uint256 sourceAmount = _scaledMinFee() - 1;
        IEscrow.DepositInput memory depositInput = _buildDepositInput(2, sourceAmount);

        vm.expectRevert(
            abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, sourceAmount, _scaledMinFee())
        );
        s_escrow.deposit(depositInput);
    }

    /// @notice One atomic unit ABOVE the floor succeeds, and the fee charged is exactly the floor.
    /// @dev The success side of the boundary. Without it the two reverts above would also pass if
    /// deposit() rejected every amount, which would be a far worse bug than the one under test.
    function test_deposit_succeedsOneUnitAboveTheFeeFloor() public {
        uint256 sourceAmount = _scaledMinFee() + 1;

        bytes32 depositId = s_escrow.deposit(_buildDepositInput(3, sourceAmount));

        assertTrue(depositId != bytes32(0), "deposit did not return an id");
        assertTrue(s_escrow.getDepositHash(depositId) != bytes32(0), "no ActiveDeposit was stored");
        assertEq(
            s_escrow.determineFee(sourceAmount, s_escrow.getTokenConfig(s_token)),
            _scaledMinFee(),
            "just above the floor, the fee must be the floor itself"
        );
    }

    /// @notice THE BASIS TEST: the revert is decided by the winning source amount, not by the
    ///         permit ceiling.
    /// @dev This is the case that would have behaved differently before the basis moved. The permit
    /// authorizes PERMIT_CEILING (100x the floor), and `determineFee(PERMIT_CEILING)` is asserted
    /// here to be well under it — so a ceiling-based fee would have been charged happily and the
    /// deposit would have succeeded. It reverts, which is what proves the basis is the source
    /// amount. If someone reverts the basis to the ceiling, this test fails and the two boundary
    /// tests above do too.
    function test_deposit_feeFloorIsMeasuredAgainstSourceAmountNotThePermitCeiling() public {
        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(s_token);
        uint256 sourceAmount = _scaledMinFee() / 2;

        // Precondition, asserted rather than assumed: at the CEILING the fee is comfortably
        // affordable, so nothing about this deposit is intrinsically unpayable.
        assertLt(s_escrow.determineFee(PERMIT_CEILING, config), PERMIT_CEILING, "ceiling fee must be affordable");
        assertGt(_scaledMinFee(), sourceAmount, "fixture guard: the floor must exceed the source amount");

        IEscrow.DepositInput memory depositInput = _buildDepositInput(4, sourceAmount);
        vm.expectRevert(
            abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, sourceAmount, _scaledMinFee())
        );
        s_escrow.deposit(depositInput);
    }

    /// @notice In a batch, ONE under-floor item reverts the WHOLE call.
    /// @dev depositMany() calls determineFee per item with no per-item try/catch, so the batch is
    /// all-or-nothing. Worth pinning explicitly: a caller batching quotes from several solvers can
    /// have one dust-sized winner poison the batch, and that is the behaviour to build retry logic
    /// against.
    function test_depositMany_revertsWhenAnySingleItemIsBelowTheFeeFloor() public {
        IEscrow.DepositInput[] memory inputs = new IEscrow.DepositInput[](2);
        inputs[0] = _buildDepositInput(5, _scaledMinFee() * 10);
        uint256 badAmount = _scaledMinFee() - 1;
        inputs[1] = _buildDepositInput(6, badAmount);

        vm.expectRevert(
            abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, badAmount, _scaledMinFee())
        );
        s_escrow.depositMany(inputs);

        // And nothing partial was written: the healthy first item must not have been stored.
        assertTrue(
            s_escrow.getDepositHash(inputs[0].reserveWitness.depositId) == bytes32(0),
            "a reverted batch must leave no ActiveDeposit behind"
        );
    }
}
