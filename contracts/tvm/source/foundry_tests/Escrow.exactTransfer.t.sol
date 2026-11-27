// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "@alexroan/permit2-tron/contracts/interfaces/ISignatureTransfer.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {IEscrow} from "../contracts/interfaces/IEscrow.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {DeployCoreContracts} from "../foundry_scripts/DeployCoreContracts.s.sol";
import {MockToken6DecimalsTransferReturnsFalse, MockTokenSkimming, MockTokenInflating} from "./mock/MockToken.sol";

/// @notice The escrow must credit a deposit only for what it actually received.
///
/// Every deposit shares one pooled token balance and the stored ActiveDeposit is credited with the
/// reserver-attested `sourceAmount`. If a token delivers less than the escrow asked for, the deposit
/// is credited for tokens that never arrived and the shortfall is paid out of other depositors'
/// funds, silently, until a later release or refund hits an empty pool and reverts. Refund is the
/// escape hatch and there is no rescue function, so those funds are stranded.
///
/// This mirrors the EVM escrow's guard. It matters at least as much on Tron: USDT is the dominant
/// stablecoin here and TetherToken carries an owner-settable transfer fee, currently zero — and the
/// escrow's allowlist is checked when a token is CONFIGURED, not on every transfer, so an
/// allowlisted token can acquire a fee afterwards.
contract EscrowExactTransferTest is Test, TestHelpers {
    Escrow private s_escrow;
    IPermit2 private s_permit2;

    MockToken6DecimalsTransferReturnsFalse private s_exactToken;
    MockTokenSkimming private s_skimmingToken;
    MockTokenInflating private s_inflatingToken;

    address private s_tokenConfig;
    address private settler = makeAddr("settler");
    address private depositor;
    uint256 private depositorPrivateKey;
    address private reserver;
    uint256 private reserverPrivateKey;
    address private releaser;
    uint256 private releaserPrivateKey;

    uint256 private constant DEPOSIT_AMOUNT = 1_000_000;
    /// @dev 1% skim, large enough that the shortfall is unmistakable in an assertion.
    uint256 private constant SKIM_BASIS_POINTS = 100;
    /// @dev Surplus the inflating token mints to the recipient on top of the requested amount.
    uint256 private constant INFLATION_BONUS = 1_000;

    function setUp() public {
        // Real Permit2, no RPC: see foundry_tests/helpers/LocalPermit2.sol. Nothing in this suite
        // reads any other chain state -- every token here is deployed locally, which is the point of
        // the fixtures.
        s_permit2 = LocalPermit2.etch();

        s_exactToken = new MockToken6DecimalsTransferReturnsFalse("Exact Token", "EXACT");
        s_skimmingToken = new MockTokenSkimming("Skimming Token", "SKIM", SKIM_BASIS_POINTS);
        s_inflatingToken = new MockTokenInflating("Inflating Token", "INFL", INFLATION_BONUS);

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run(IERC20(address(s_exactToken)));

        s_tokenConfig = makeAddr("tokenConfig");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), s_tokenConfig);

        vm.startPrank(s_tokenConfig);
        s_escrow.allowToken(IERC20(address(s_exactToken)), 6);
        s_escrow.allowToken(IERC20(address(s_skimmingToken)), 6);
        s_escrow.allowToken(IERC20(address(s_inflatingToken)), 6);
        vm.stopPrank();

        (depositor, depositorPrivateKey) = makeAddrAndKey("depositor");
        (reserver, reserverPrivateKey) = makeAddrAndKey("reserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("releaser");

        _fundDepositor(address(s_exactToken));
        _fundDepositor(address(s_skimmingToken));
        _fundDepositor(address(s_inflatingToken));
    }

    function _reserveWitness(bytes32 depositId) private view returns (IEscrow.ReserveWitness memory) {
        return _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, DEPOSIT_AMOUNT);
    }

    function _fundDepositor(address token) private {
        // Every mock exposes mint(address,uint256) through IMintable; the owner is this test.
        (bool ok,) = token.call(abi.encodeWithSignature("mint(address,uint256)", depositor, type(uint128).max));
        require(ok, "mint failed");
        vm.prank(depositor);
        (ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(s_permit2), type(uint256).max));
        require(ok, "approve failed");
    }

    /// @dev Built separately from submission on purpose: constructing the input calls
    /// `permit2.DOMAIN_SEPARATOR()`, and `vm.expectRevert` binds to the NEXT call — so building
    /// inside an expectRevert window would arm the cheatcode against the domain-separator read
    /// instead of against `deposit`, and the test would pass or fail for the wrong reason.
    function _buildDeposit(address token, uint256 nonce) private returns (IEscrow.DepositInput memory) {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _constructDepositPermitWitness(token, DEPOSIT_AMOUNT, reserver, releaser, nonce);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);
        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(depositId);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        return IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
    }

    function _submit(IEscrow.DepositInput memory input) private {
        vm.prank(settler);
        s_escrow.deposit(input);
    }

    function test_deposit_exactToken_succeeds() public {
        uint256 before = IERC20(address(s_exactToken)).balanceOf(address(s_escrow));
        _submit(_buildDeposit(address(s_exactToken), 0));
        assertEq(
            IERC20(address(s_exactToken)).balanceOf(address(s_escrow)) - before,
            DEPOSIT_AMOUNT,
            "an exact-delivering token must be credited for exactly what it delivered"
        );
    }

    function test_deposit_feeOnTransferToken_reverts() public {
        uint256 delivered = DEPOSIT_AMOUNT - (DEPOSIT_AMOUNT * SKIM_BASIS_POINTS) / 10_000;
        // Without the guard this deposit SUCCEEDS and is credited the full DEPOSIT_AMOUNT while only
        // `delivered` arrived — the shortfall silently borrowed from the pooled balance.
        IEscrow.DepositInput memory input = _buildDeposit(address(s_skimmingToken), 1);
        vm.expectRevert(abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, delivered));
        _submit(input);
    }

    function test_deposit_inflatingToken_reverts() public {
        // Equality, not `>=`: an over-delivery leaves dust no witness accounts for and no release or
        // refund can move, so it is rejected too.
        IEscrow.DepositInput memory input = _buildDeposit(address(s_inflatingToken), 2);
        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.NonExactTransfer.selector, DEPOSIT_AMOUNT, DEPOSIT_AMOUNT + INFLATION_BONUS)
        );
        _submit(input);
    }

    function test_skimmingToken_actuallyShortDelivers() public {
        // Proves the fixture, not the escrow: if the mock ever stopped skimming, the revert test
        // above would pass for the wrong reason.
        // Recipient must NOT be the token's owner: the skim is credited to the owner, so sending to
        // the owner would net out to the full amount and hide the shortfall.
        address sink = makeAddr("sink");
        uint256 before = IERC20(address(s_skimmingToken)).balanceOf(sink);
        vm.prank(depositor);
        IERC20(address(s_skimmingToken)).approve(address(this), DEPOSIT_AMOUNT);
        IERC20(address(s_skimmingToken)).transferFrom(depositor, sink, DEPOSIT_AMOUNT);
        uint256 received = IERC20(address(s_skimmingToken)).balanceOf(sink) - before;
        assertLt(received, DEPOSIT_AMOUNT, "the skimming mock must deliver less than requested");
    }
}
