// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {MockToken, MockToken6Decimals} from "./mock/MockToken.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Escrow} from "../src/Escrow.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IEscrow} from "../src/interfaces/IEscrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DeployCoreContracts} from "../script/deploy/DeployCoreContracts.s.sol";
import {ITokenConfig} from "../src/interfaces/ITokenConfig.sol";

contract EscrowDepositTest is Test, TestHelpers {
    using SafeERC20 for IERC20;

    Escrow public s_escrow;
    IERC20 public s_token;
    IPermit2 public s_permit2;
    // Depositor wallet (who owns tokens and signs the permit)
    address public depositor;
    uint256 public depositorPrivateKey;
    address public reserver;
    uint256 public reserverPrivateKey;
    address public releaser;
    uint256 public releaserPrivateKey;
    address public settler = makeAddr("settler");

    address public s_pauser;
    address public s_treasurer;
    address public s_tokenConfig;

    // Fork mode support
    bool public isForkMode;
    uint8 public tokenDecimals;
    uint256 public DEPOSIT_AMOUNT;

    // Helper function to check if deposit was completed (storage cleared)
    function _depositWasCompleted(bytes32 depositId) internal view returns (bool) {
        return isDepositCompleted(s_escrow, depositId);
    }

    // DEFAULT_DEPOSIT_REQUEST_HASH / DEFAULT_DESTINATION / DEFAULT_DESTINATION_HASH live in
    // test/helpers/Signatures.sol alongside DEFAULT_QUOTE_HASH, so the release/refund helpers
    // there can rebuild the stored ActiveDeposit tuple with the values this fixture committed to.

    function _depositWitness(address token, uint256 amount, address _reserver, address _releaser, uint256 nonce)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory witness)
    {
        return _constructDepositPermitWitness(
            token, amount, _reserver, _releaser, nonce, DEFAULT_DEPOSIT_REQUEST_HASH, DEFAULT_DESTINATION
        );
    }

    // Wrapper for _constructReserveWitness
    function _reserveWitness(bytes32 depositId, address _settler)
        internal
        view
        returns (IEscrow.ReserveWitness memory witness)
    {
        return _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, _settler, DEPOSIT_AMOUNT);
    }

    function _reserveWitness(bytes32 depositId, bytes32 quoteHash, address _settler)
        internal
        view
        returns (IEscrow.ReserveWitness memory witness)
    {
        return _constructReserveWitness(depositId, quoteHash, _settler, DEPOSIT_AMOUNT);
    }

    function _releaseWitness(
        bytes32 depositId,
        bytes32 quoteHash,
        address _depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address _reserver,
        address _releaser,
        address _settler
    ) internal pure returns (IEscrow.ReleaseWitness memory) {
        return IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: quoteHash,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: _depositor,
            token: token,
            amount: amount,
            feeAmount: feeAmount,
            reserver: _reserver,
            releaser: _releaser,
            settler: _settler
        });
    }

    function _refundWitness(
        bytes32 depositId,
        bytes32 quoteHash,
        address _depositor,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address _reserver,
        address _releaser,
        address _settler
    ) internal pure returns (IEscrow.RefundWitness memory) {
        return IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: quoteHash,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: _depositor,
            token: token,
            amount: amount,
            feeAmount: feeAmount,
            reserver: _reserver,
            releaser: _releaser,
            settler: _settler
        });
    }

    function _activeDeposit(
        address _depositor,
        bytes32 quoteHash,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address _reserver,
        address _releaser,
        address _settler
    ) internal pure returns (IEscrow.ActiveDeposit memory) {
        return IEscrow.ActiveDeposit({
            depositor: _depositor,
            quoteHash: quoteHash,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            token: token,
            amount: amount,
            feeAmount: feeAmount,
            reserver: _reserver,
            releaser: _releaser,
            settler: _settler
        });
    }

    function setUp() public {
        string memory forkConfig = vm.envOr("FORK_CONFIG", string(""));

        if (bytes(forkConfig).length > 0) {
            _setUpForkMode(forkConfig);
        } else {
            _setUpDefaultMode();
        }

        _setUpCommon();
    }

    function _setUpForkMode(string memory forkConfig) private {
        isForkMode = true;

        // Read JSON config
        string memory json = vm.readFile(forkConfig);
        string memory rpcUrl = vm.parseJsonString(json, ".rpc_url");
        address escrowAddr = vm.parseJsonAddress(json, ".escrow");
        address tokenAddr = vm.parseJsonAddress(json, ".token_address");
        tokenDecimals = uint8(vm.parseJsonUint(json, ".token_decimals"));

        // Read fee configuration from JSON
        uint88 feePercentage = uint88(vm.parseJsonUint(json, ".fee_percentage"));
        uint80 minFee = uint80(vm.parseJsonUint(json, ".min_fee"));
        uint80 maxFee = uint80(vm.parseJsonUint(json, ".max_fee"));

        // Fork the network
        vm.createSelectFork(rpcUrl);

        // Use existing deployed contracts
        s_escrow = Escrow(escrowAddr);
        s_token = IERC20(tokenAddr);
        s_permit2 = s_escrow.i_permit2();

        // Get the defaultAdmin for role management
        address admin = s_escrow.defaultAdmin();

        // Create test role holder addresses
        s_pauser = makeAddr("pauser");
        s_treasurer = makeAddr("treasurer");
        s_tokenConfig = makeAddr("tokenConfig");

        // Impersonate defaultAdmin to grant roles to our test addresses
        vm.startPrank(admin);
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), s_pauser);
        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), s_treasurer);
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), s_tokenConfig);
        vm.stopPrank();

        // Configure token with fee settings from JSON
        // Always override to ensure consistent test conditions
        vm.startPrank(s_tokenConfig);
        if (s_escrow.isTokenAllowed(s_token)) {
            // Token already allowed - just update fee config
            s_escrow.setTokenFeeConfig(s_token, feePercentage, minFee, maxFee);
        } else {
            // Token not allowed - allow and set fee config atomically
            s_escrow.allowTokenAndSetFeeConfig(s_token, tokenDecimals, feePercentage, minFee, maxFee);
        }
        vm.stopPrank();

        // Calculate deposit amount based on token decimals
        DEPOSIT_AMOUNT = 1000 * (10 ** tokenDecimals); // 1000 tokens
    }

    function _setUpDefaultMode() private {
        isForkMode = false;
        tokenDecimals = 18;
        DEPOSIT_AMOUNT = 1000e18;

        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. FORK_CONFIG mode above keeps
        // its fork — it attaches to a real deployed escrow and reads live roles/token config, which
        // is not a Permit2 borrow.
        s_permit2 = LocalPermit2.etch();

        // Deploy our contracts
        MockToken mockToken = new MockToken("Test Token", "TEST");
        s_token = IERC20(address(mockToken));

        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run();

        // Grant roles
        s_pauser = makeAddr("pauser");
        s_treasurer = makeAddr("treasurer");
        s_tokenConfig = makeAddr("tokenConfig");

        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), s_pauser);
        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), s_treasurer);
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), s_tokenConfig);

        vm.startPrank(s_tokenConfig);
        s_escrow.allowToken(s_token, 18);
        s_escrow.setTokenFeeConfig(s_token, 20000, 0, 25000000);
        vm.stopPrank();
    }

    function _setUpCommon() private {
        // Create depositor wallet using Foundry's makeAddrAndKey
        (depositor, depositorPrivateKey) = makeAddrAndKey("depositor");

        // Create reserver and releaser wallets
        (reserver, reserverPrivateKey) = makeAddrAndKey("reserver");
        (releaser, releaserPrivateKey) = makeAddrAndKey("releaser");

        // Fund depositor with tokens using deal() (works on both mock and real tokens)
        deal(address(s_token), depositor, DEPOSIT_AMOUNT * 1000);

        // Approve Permit2 (using forceApprove for non-standard ERC20s like USDT)
        vm.startPrank(depositor);
        s_token.forceApprove(address(s_permit2), type(uint256).max);

        vm.stopPrank();

        // Consume nonce 0 for deterministic testing
        _permitTransferFromOnce(0);
    }

    /// @notice Mint tokens to an address (works in both fork and default mode)
    function _mintTokens(address to, uint256 amount) internal {
        if (isForkMode) {
            deal(address(s_token), to, s_token.balanceOf(to) + amount);
        } else {
            MockToken(address(s_token)).mint(to, amount);
        }
    }

    function _permitTransferFromOnce(uint256 nonce) private {
        uint256 transferAmount = 10 ** tokenDecimals;

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(s_token), amount: transferAmount}),
            nonce: nonce,
            deadline: block.timestamp + 100
        });

        bytes memory sig = getPermitTransferSignature(permit, depositorPrivateKey, s_permit2.DOMAIN_SEPARATOR());

        ISignatureTransfer.SignatureTransferDetails memory transferDetails =
            ISignatureTransfer.SignatureTransferDetails({to: settler, requestedAmount: transferAmount});

        s_permit2.permitTransferFrom(permit, transferDetails, depositor, sig);
    }

    // deposit TESTS - testing the deposit function

    function _deposit_success(uint256 nonce) private returns (bytes32 depositId, uint256 feeAmount) {
        // Setup permit data, transfer details, and witness
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);

        // Generate signature
        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        // Generate deposit ID
        depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(depositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        feeAmount = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));

        // Record balances before
        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Execute deposit
        vm.expectEmit(true, true, true, true);
        emit IEscrow.Deposited(
            depositId,
            DEFAULT_QUOTE_HASH,
            depositor,
            settler,
            address(s_token),
            DEPOSIT_AMOUNT,
            feeAmount,
            reserver,
            releaser
        );

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        vm.prank(settler);
        s_escrow.deposit(depositInput);
        vm.snapshotGasLastCall("deposit_success");

        // Verify balances after
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore - DEPOSIT_AMOUNT,
            "Depositor balance should decrease by deposit amount"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)),
            escrowBalanceBefore + DEPOSIT_AMOUNT,
            "Escrow balance should increase by deposit amount"
        );

        // Verify deposit is stored with settler
        bytes32 depositHash = s_escrow.getDepositHash(depositId);
        bytes32 expectedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
        assertEq(depositHash, expectedHash, "Deposit should be stored with settler");
    }

    function test_deposit_success() public returns (bytes32 depositId, uint256 feeAmount) {
        (depositId, feeAmount) = _deposit_success(1);
    }

    /// @notice CORE-2022: the payer authorizes a ceiling (max_source_amount) via the Permit2 permit,
    /// but the winning quote's source_amount is lower. Only the winning source_amount should leave the
    /// payer's wallet — the headroom is slippage tolerance, not a charge. Fails today: deposit() pulls
    /// the full permit.permitted.amount, so the payer overpays and the surplus is captured by the settler.
    function test_deposit_chargesWinningSourceAmount_notMaxCap() public {
        uint256 maxSourceAmount = DEPOSIT_AMOUNT; // ceiling the payer authorizes
        uint256 winningSourceAmount = DEPOSIT_AMOUNT / 2; // actual winning quote (lower)

        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), maxSourceAmount, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        // Reserver (the quote selector) attests the winning source amount.
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, winningSourceAmount);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });

        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        vm.prank(settler);
        s_escrow.deposit(depositInput);

        assertEq(
            depositorBalanceBefore - s_token.balanceOf(depositor),
            winningSourceAmount,
            "payer must be debited only the winning source_amount, not the max cap"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)) - escrowBalanceBefore,
            winningSourceAmount,
            "escrow must hold only the winning source_amount"
        );
    }

    /// @notice CORE-2022 (release side): with a winning source amount below the cap, the settler receives
    /// only sourceAmount - fee on release, and the payer's wallet was debited only sourceAmount.
    function test_release_paysWinningSourceAmount_notMaxCap() public {
        uint256 winningSourceAmount = DEPOSIT_AMOUNT / 2;

        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);
        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);
        bytes32 depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, winningSourceAmount);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);
        uint256 feeAmount = s_escrow.determineFee(winningSourceAmount, s_escrow.getTokenConfig(s_token));

        uint256 payerBefore = s_token.balanceOf(depositor);
        uint256 settlerBefore = s_token.balanceOf(settler);

        vm.prank(settler);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: depositor,
                depositWitness: depositWitness,
                depositSignature: depositSignature,
                reserveWitness: reserveWitness,
                reserveSignature: reserveSignature
            })
        );

        releaseDeposit(
            s_escrow,
            depositId,
            depositor,
            address(s_token),
            winningSourceAmount,
            feeAmount,
            reserver,
            releaser,
            settler,
            releaserPrivateKey
        );

        assertEq(
            payerBefore - s_token.balanceOf(depositor), winningSourceAmount, "payer debited only winning source_amount"
        );
        assertEq(
            s_token.balanceOf(settler) - settlerBefore,
            winningSourceAmount - feeAmount,
            "settler receives winning source_amount minus fee, not the cap"
        );
    }

    /// @notice CORE-2022 guard: a zero source amount (with a non-zero permit cap) is rejected.
    function test_deposit_sourceAmount_zero_reverts() public {
        _depositWithSourceAmount_expectRevert(0, IEscrow.InvalidSourceAmount.selector);
    }

    /// @notice CORE-2022 guard: a source amount above the permit cap is rejected.
    function test_deposit_sourceAmount_exceeds_cap_reverts() public {
        _depositWithSourceAmount_expectRevert(DEPOSIT_AMOUNT + 1, IEscrow.InvalidSourceAmount.selector);
    }

    function _depositWithSourceAmount_expectRevert(uint256 sourceAmount, bytes4 selector) private {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);
        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);
        bytes32 depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);
        IEscrow.ReserveWitness memory reserveWitness =
            _constructReserveWitness(depositId, DEFAULT_QUOTE_HASH, settler, sourceAmount);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        vm.expectRevert(selector);
        s_escrow.deposit(
            IEscrow.DepositInput({
                permit: permit,
                depositor: depositor,
                depositWitness: depositWitness,
                depositSignature: depositSignature,
                reserveWitness: reserveWitness,
                reserveSignature: reserveSignature
            })
        );
    }

    function test_deposit_after_first_deposit_success() public {
        _deposit_success(1);

        // Setup second deposit with different nonce
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 2);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        uint256 feeAmount = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));
        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Execute second deposit - should succeed
        vm.prank(settler);
        bytes32 depositId = s_escrow.deposit(depositInput);

        // Verify second deposit is stored correctly
        bytes32 depositHash = s_escrow.getDepositHash(depositId);
        bytes32 expectedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
        assertEq(depositHash, expectedHash, "Second deposit should be stored correctly");
    }

    function test_deposit_paused_reverts() public {
        // Setup permit and witnesses
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();
        vm.stopPrank();

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try to deposit - should revert
        vm.expectRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        s_escrow.deposit(depositInput);
    }

    function test_depositMany_paused_reverts() public {
        // Setup permit and witnesses for 2 deposits
        IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](2);

        for (uint256 i = 0; i < 2; i++) {
            depositInputs[i] = _createDepositInput(address(s_token), i + 1);
        }

        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();
        vm.stopPrank();

        // Try to depositMany - should revert
        vm.expectRevert(abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        s_escrow.depositMany(depositInputs);
    }

    function test_depositMany_token_not_allowed_reverts() public {
        // Skip in fork mode - can't deploy new mock tokens
        if (isForkMode) {
            vm.skip(true);
        }

        // Deploy a new token that's not allowlisted
        MockToken6Decimals notAllowedToken = new MockToken6Decimals("NotAllowed Token", "NAT");

        // Setup 3 deposits: first uses allowed token, second uses non-allowed token, third uses allowed token
        IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](3);

        depositInputs[0] = _createDepositInput(address(s_token), 1);
        depositInputs[1] = _createDepositInput(address(notAllowedToken), 2);
        depositInputs[2] = _createDepositInput(address(s_token), 3);

        // Try to depositMany - should revert with TokenNotAllowed for the non-allowed token
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenNotAllowed.selector, IERC20(address(notAllowedToken))));
        s_escrow.depositMany(depositInputs);
    }

    // this should be the same as test_depositMany_token_not_allowed_reverts, but with the first token not allowed
    function test_depositMany_first_token_not_allowed_reverts() public {
        // Setup 2 deposits: first uses non-allowed token, second uses allowed token
        IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](2);

        depositInputs[0] = _createDepositInput(address(0), 1);
        depositInputs[1] = _createDepositInput(address(s_token), 2);

        // Try to depositMany - should revert with TokenNotAllowed for the non-allowed token
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenNotAllowed.selector, IERC20(address(0))));
        s_escrow.depositMany(depositInputs);
    }

    function test_deposit_depositor_zero_address_reverts() public {
        // Setup permit and witnesses
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, address(0), depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: address(0),
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try with zero address depositor - should revert
        vm.expectRevert(IEscrow.DepositCannotBeZeroAddress.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_reserver_zero_address_reverts() public {
        // Setup permit and witnesses with zero address reserver
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, address(0), releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try with zero address reserver - should revert
        vm.expectRevert(IEscrow.ReserverCannotBeZeroAddress.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_releaser_zero_address_reverts() public {
        // Setup permit and witnesses with zero address releaser
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, address(0), 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try with zero address releaser - should revert
        vm.expectRevert(IEscrow.ReleaserCannotBeZeroAddress.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_settler_zero_address_reverts() public {
        // Setup permit and witnesses with zero address settler
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, address(0));
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try with zero address settler - should revert
        vm.expectRevert(IEscrow.SettlerCannotBeZeroAddress.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_quoteHash_empty_reverts() public {
        // Setup permit and witnesses with empty offchain quote hash
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, bytes32(0), settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });

        vm.expectRevert(IEscrow.QuoteHashCannotBeEmpty.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_amount_zero_reverts() public {
        // Setup permit and witnesses with zero amount
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), 0, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try with zero amount - should revert
        vm.expectRevert(IEscrow.DepositAmountCannotBeZero.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_token_not_allowed_reverts() public {
        // Skip in fork mode - can't deploy new mock tokens
        if (isForkMode) {
            vm.skip(true);
        }

        // Deploy a new token that's not allowlisted
        MockToken6Decimals token6 = new MockToken6Decimals("6Decimal Token", "6DT");

        // Setup permit and witnesses with non-allowed token
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(token6), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try with non-allowed token - should revert
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenNotAllowed.selector, IERC20(address(token6))));
        s_escrow.deposit(depositInput);
    }

    function test_deposit_deposit_already_exists_reverts() public {
        // First deposit
        _deposit_success(1);

        // Try to use the same signature again
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Try to reuse the same signature - should revert
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositAlreadyExists.selector, expectedDepositId));
        s_escrow.deposit(depositInput);
    }

    // Additional deposit tests from deposit/reserve/release/refund flows

    function test_deposit_expired_permit_signature_reverts() public {
        // Setup permit with expired deadline
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        // Set deadline to past
        permit.deadline = block.timestamp - 1;

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Should revert due to expired permit deadline
        vm.expectRevert(abi.encodeWithSignature("SignatureExpired(uint256)", permit.deadline));
        s_escrow.deposit(depositInput);
    }

    function test_deposit_exactly_at_deadline_succeeds() public {
        // Setup permit with deadline exactly at current timestamp
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        permit.deadline = block.timestamp;

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Should succeed at exact deadline
        vm.prank(settler);
        bytes32 depositId = s_escrow.deposit(depositInput);

        // Verify deposit was created
        assertTrue(s_escrow.getDepositHash(depositId) != bytes32(0), "Deposit should exist");
    }

    function test_deposit_nonces_executed_out_of_order_success() public {
        (bytes32 depositId3,) = _deposit_success(3);
        (bytes32 depositId2,) = _deposit_success(2);
        (bytes32 depositId1,) = _deposit_success(1);

        // Verify all deposits exist
        assertTrue(s_escrow.getDepositHash(depositId1) != bytes32(0), "Deposit 1 should exist");
        assertTrue(s_escrow.getDepositHash(depositId2) != bytes32(0), "Deposit 2 should exist");
        assertTrue(s_escrow.getDepositHash(depositId3) != bytes32(0), "Deposit 3 should exist");
    }

    function test_deposit_reserve_invalid_signature_reverts() public {
        // Setup permit and witnesses
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);

        // Use wrong private key for reserve signature
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, depositorPrivateKey); // Wrong key!
        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });

        // Should revert due to invalid signature
        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_reserve_with_releaser_signature_fails() public {
        // Setup permit and witnesses
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);

        // Use releaser's key for reserve signature (should fail)
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, releaserPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Should revert - wrong signer
        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.deposit(depositInput);
    }

    function test_deposit_settler_frontrun_protection() public {
        // This test validates that the system is protected against settler front-running attacks
        // An attacker cannot modify the settler address after the reserver has signed

        // Setup permit and witnesses
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        // Create reserve witness with the legitimate settler
        address legitimateSettler = makeAddr("legitimateSettler");
        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, legitimateSettler);

        // Reserver signs for the legitimate settler
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        // Attacker attempts to front-run by modifying the settler address
        address attackerSettler = makeAddr("attackerSettler");
        reserveWitness.settler = attackerSettler; // Modify settler after signature

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });

        // Should revert because the signature was for a different settler
        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.deposit(depositInput);

        // Verify that using the original settler works
        reserveWitness.settler = legitimateSettler; // Reset to original
        depositInput.reserveWitness = reserveWitness;

        // This should succeed
        bytes32 depositId = s_escrow.deposit(depositInput);

        // Verify the deposit was created with the correct settler
        assertEq(depositId, expectedDepositId, "Deposit ID should match expected");
        assertTrue(s_escrow.getDepositHash(depositId) != bytes32(0), "Deposit should exist");
    }

    function test_deposit_quoteHash_frontrun_protection() public {
        // This test validates that quoteHash is bound into the reserver signature
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);
        bytes32 legitimateQuoteHash = keccak256("legitimate payment request");
        bytes32 attackerQuoteHash = keccak256("attacker payment request");

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, legitimateQuoteHash, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        reserveWitness.quoteHash = attackerQuoteHash;

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });

        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.deposit(depositInput);

        reserveWitness.quoteHash = legitimateQuoteHash;
        depositInput.reserveWitness = reserveWitness;

        bytes32 depositId = s_escrow.deposit(depositInput);
        assertEq(depositId, expectedDepositId, "Deposit ID should match expected");
        assertTrue(s_escrow.getDepositHash(depositId) != bytes32(0), "Deposit should exist");
    }

    function test_deposit_depositId_mismatch_reverts() public {
        // Setup permit and witnesses
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 wrongDepositId = keccak256("wrong");

        // Create reserve witness with wrong depositId
        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(wrongDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Should revert with DepositNotFound error for wrong depositId
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, wrongDepositId));
        s_escrow.deposit(depositInput);
    }

    function test_deposit_works_after_unpause() public {
        // Setup permit and witnesses
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Pause and unpause
        vm.startPrank(s_pauser);
        s_escrow.pause();
        s_escrow.unpause();
        vm.stopPrank();

        // Should work after unpause
        vm.prank(settler);
        bytes32 depositId = s_escrow.deposit(depositInput);

        // Verify deposit was created
        assertTrue(s_escrow.getDepositHash(depositId) != bytes32(0), "Deposit should exist after unpause");
    }

    function test_deposit_with_same_reserver_releaser() public {
        // Test when reserver and releaser are the same address
        address sameAddress = makeAddr("sameAddress");
        uint256 sameAddressKey = uint256(keccak256("sameAddress"));

        // Setup permit and witnesses with same reserver/releaser
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, sameAddress, sameAddress, 1);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, sameAddressKey);
        uint256 feeAmount = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        // Should succeed - same address for reserver/releaser is allowed
        vm.prank(settler);
        bytes32 depositId = s_escrow.deposit(depositInput);

        // Verify deposit was created with same reserver/releaser
        bytes32 depositHash = s_escrow.getDepositHash(depositId);
        bytes32 expectedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: sameAddress,
                    releaser: sameAddress,
                    settler: settler
                })
            )
        );
        assertEq(depositHash, expectedHash, "Deposit should have same reserver/releaser");
    }

    // RELEASE TESTS

    function test_release_success() public returns (bytes32 depositId, uint256 feeAmount) {
        // First create a deposit and set settler
        (depositId, feeAmount) = test_deposit_success();
        // Get the settler that was set in the reserve test
        bytes32 depositHash = s_escrow.getDepositHash(depositId);
        bytes32 expectedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
        assertEq(depositHash, expectedHash, "Deposit hash should match");

        // Check balances before release
        uint256 settlerBalanceBefore = s_token.balanceOf(settler);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Use helper to release
        releaseDeposit(
            s_escrow,
            depositId,
            depositor,
            address(s_token),
            DEPOSIT_AMOUNT,
            feeAmount,
            reserver,
            releaser,
            settler,
            releaserPrivateKey
        );

        // Verify token transfer
        assertEq(
            s_token.balanceOf(settler),
            settlerBalanceBefore + DEPOSIT_AMOUNT - feeAmount,
            "Settler should receive tokens"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)),
            escrowBalanceBefore - DEPOSIT_AMOUNT + feeAmount,
            "Escrow balance should decrease"
        );

        // Verify deposit status
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    function test_release_token_not_allowed_enables_release_success() public {
        // First create a deposit and set settler
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Get the settler that was set in the reserve test
        bytes32 depositHash = s_escrow.getDepositHash(depositId);
        bytes32 expectedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
        assertEq(depositHash, expectedHash, "Deposit hash should match");

        // Remove the token from the allowlist
        vm.startPrank(s_tokenConfig);
        s_escrow.disallowToken(s_token);
        vm.stopPrank();

        // Create release witness
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);

        // Check balances before release
        uint256 settlerBalanceBefore = s_token.balanceOf(settler);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});
        // Execute release as settler
        vm.prank(settler);
        vm.expectEmit(true, true, true, true);
        emit IEscrow.Released(depositId, settler, address(s_token), DEPOSIT_AMOUNT, feeAmount);
        s_escrow.release(releaseInput);
        vm.snapshotGasLastCall("release_token_not_allowed_enables_release_success");

        // Verify token transfer
        assertEq(
            s_token.balanceOf(settler),
            settlerBalanceBefore + DEPOSIT_AMOUNT - feeAmount,
            "Settler should receive tokens"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)),
            escrowBalanceBefore - DEPOSIT_AMOUNT + feeAmount,
            "Escrow balance should decrease"
        );

        // Verify deposit status
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    function test_release_deposit_not_found_reverts() public {
        bytes32 nonExistentId = keccak256("nonexistent");

        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: nonExistentId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: 0,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);

        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, nonExistentId));
        s_escrow.release(releaseInput);
    }

    function test_release_invalid_witness_values_reverts() public {
        // First create a deposit
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create release witness with invalid values
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT + 1,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes32 passedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: witness.depositor,
                    quoteHash: witness.quoteHash,
                    depositRequestHash: witness.depositRequestHash,
                    destinationHash: witness.destinationHash,
                    token: witness.token,
                    amount: witness.amount,
                    feeAmount: witness.feeAmount,
                    reserver: witness.reserver,
                    releaser: witness.releaser,
                    settler: witness.settler
                })
            )
        );
        bytes32 expectedHash = s_escrow.getDepositHash(depositId);
        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);

        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.InvalidWitnessValues.selector, witness.depositId, expectedHash, passedHash)
        );
        s_escrow.release(releaseInput);
    }

    function test_release_quoteHash_empty_reverts() public {
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: bytes32(0),
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(IEscrow.QuoteHashCannotBeEmpty.selector);
        s_escrow.release(releaseInput);
    }

    function test_release_quoteHash_mismatch_reverts() public {
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: keccak256("wrong payment request"),
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes32 passedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: witness.depositor,
                    quoteHash: witness.quoteHash,
                    depositRequestHash: witness.depositRequestHash,
                    destinationHash: witness.destinationHash,
                    token: witness.token,
                    amount: witness.amount,
                    feeAmount: witness.feeAmount,
                    reserver: witness.reserver,
                    releaser: witness.releaser,
                    settler: witness.settler
                })
            )
        );
        bytes32 expectedHash = s_escrow.getDepositHash(depositId);
        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.InvalidWitnessValues.selector, witness.depositId, expectedHash, passedHash)
        );
        s_escrow.release(releaseInput);
    }

    function test_release_already_released_reverts() public {
        // First release successfully
        (bytes32 depositId, uint256 feeAmount) = test_release_success();
        // Try to release again
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositId));
        s_escrow.release(releaseInput);
    }

    function test_release_settler_not_set_no_witness_settler_reverts() public {
        // Create deposit but don't set settler
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: address(0)
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);

        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(abi.encodeWithSelector(IEscrow.NotReserved.selector, depositId));
        s_escrow.release(releaseInput);
    }

    function test_release_invalid_signature_reverts() public {
        // First create a deposit and set settler
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create signature with wrong private key (using depositor instead of releaser)
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), depositorPrivateKey); // Wrong key!

        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.release(releaseInput);
    }

    function test_release_already_refunded_reverts() public {
        // First refund the deposit
        (bytes32 depositId, uint256 feeAmount) = test_refund_success();
        // Try to release after refund
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositId));
        s_escrow.release(releaseInput);
    }

    function test_release_paused_reverts() public {
        // First create a deposit and set settler
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create releaser signature for release
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();
        vm.stopPrank();

        // Should revert with EnforcedPause
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_escrow.release(releaseInput);
    }

    function test_releaseMany_paused_reverts() public {
        // First create deposits to release
        bytes32[] memory depositIds = new bytes32[](2);
        uint256[] memory feeAmounts = new uint256[](2);
        (depositIds[0], feeAmounts[0]) = test_deposit_success();

        // Create second deposit with different nonce
        uint256 nonce = 2;
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        depositIds[1] = expectedDepositId(permit, depositor, depositWitness, depositSignature);
        feeAmounts[1] = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(depositIds[1], settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        s_escrow.deposit(depositInput);

        // Create release inputs for both deposits
        IEscrow.ReleaseInput[] memory releaseInputs = new IEscrow.ReleaseInput[](2);

        for (uint256 i = 0; i < 2; i++) {
            IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
                depositId: depositIds[i],
                quoteHash: DEFAULT_QUOTE_HASH,
                depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                destinationHash: DEFAULT_DESTINATION_HASH,
                depositor: depositor,
                token: address(s_token),
                amount: DEPOSIT_AMOUNT,
                feeAmount: feeAmounts[i],
                reserver: reserver,
                releaser: releaser,
                settler: settler
            });

            bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);
            releaseInputs[i] = IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});
        }

        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();
        vm.stopPrank();

        // Should revert with EnforcedPause
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_escrow.releaseMany(releaseInputs);
    }

    function test_release_works_after_unpause() public {
        // First create a deposit and set settler
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Get the settler that was set in the reserve test
        bytes32 depositHash = s_escrow.getDepositHash(depositId);
        bytes32 expectedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                })
            )
        );
        assertEq(depositHash, expectedHash, "Deposit hash should match");

        // Create releaser signature for release
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructReleaseSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: signature});

        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();

        // Unpause the contract
        s_escrow.unpause();
        vm.stopPrank();
        // Check balances before release
        uint256 settlerBalanceBefore = s_token.balanceOf(settler);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Should now work normally
        vm.prank(settler);
        vm.expectEmit(true, true, true, true);
        emit IEscrow.Released(depositId, settler, address(s_token), DEPOSIT_AMOUNT, feeAmount);
        s_escrow.release(releaseInput);
        vm.snapshotGasLastCall("release_works_after_unpause");

        // Verify token transfer
        assertEq(
            s_token.balanceOf(settler),
            settlerBalanceBefore + DEPOSIT_AMOUNT - feeAmount,
            "Settler should receive tokens"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)),
            escrowBalanceBefore - DEPOSIT_AMOUNT + feeAmount,
            "Escrow balance should decrease"
        );

        // Verify deposit status
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    // REFUND TESTS

    function test_refund_success() public returns (bytes32 depositId, uint256 feeAmount) {
        // First create a deposit (but don't reserve/release it)
        (depositId, feeAmount) = test_deposit_success();

        // Check balances before refund
        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Use helper to refund
        refundDeposit(
            s_escrow,
            depositId,
            depositor,
            address(s_token),
            DEPOSIT_AMOUNT,
            feeAmount,
            reserver,
            releaser,
            settler,
            releaserPrivateKey
        );

        // Verify token transfer back to depositor
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore + DEPOSIT_AMOUNT,
            "Depositor should receive refunded tokens"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)), escrowBalanceBefore - DEPOSIT_AMOUNT, "Escrow balance should decrease"
        );

        // Verify deposit status
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    function test_refund_after_deposit_token_not_allowed_enables_refund_success() public {
        // First create a deposit (but don't reserve/release it)
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();

        // Remove the token from the allowlist
        vm.startPrank(s_tokenConfig);
        s_escrow.disallowToken(s_token);
        vm.stopPrank();

        // Create refund witness and signature
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        // Check balances before refund
        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Execute refund as settler
        vm.prank(settler);
        vm.expectEmit(true, true, true, true);
        emit IEscrow.Refunded(depositId, depositor, address(s_token), DEPOSIT_AMOUNT);
        s_escrow.refund(refundInput);
        vm.snapshotGasLastCall("refund_after_deposit_token_not_allowed_enables_refund_success");

        // Verify token transfer back to depositor
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore + DEPOSIT_AMOUNT,
            "Depositor should receive refunded tokens"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)), escrowBalanceBefore - DEPOSIT_AMOUNT, "Escrow balance should decrease"
        );

        // Verify deposit status
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    function test_refund_after_reserve_token_not_allowed_enables_refund_success() public {
        // Reserve the deposit
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();

        // Remove the token from the allowlist
        vm.startPrank(s_tokenConfig);
        s_escrow.disallowToken(s_token);
        vm.stopPrank();

        // Create refund witness and signature
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        // Check balances before refund
        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Execute refund as settler
        vm.prank(settler);
        vm.expectEmit(true, true, true, true);
        emit IEscrow.Refunded(depositId, depositor, address(s_token), DEPOSIT_AMOUNT);
        s_escrow.refund(refundInput);
        vm.snapshotGasLastCall("refund_after_reserve_token_not_allowed_enables_refund_success");
        // Verify token transfer back to depositor
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore + DEPOSIT_AMOUNT,
            "Depositor should receive refunded tokens"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)), escrowBalanceBefore - DEPOSIT_AMOUNT, "Escrow balance should decrease"
        );

        // Verify deposit status
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    function test_refund_deposit_not_found_reverts() public {
        bytes32 nonExistentId = keccak256("nonexistent");

        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: nonExistentId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: 0,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, nonExistentId));
        s_escrow.refund(refundInput);
    }

    function test_refund_invalid_witness_values_reverts() public {
        // First create a deposit
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create refund witness with invalid values
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT + 1,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes32 passedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: witness.depositor,
                    quoteHash: witness.quoteHash,
                    depositRequestHash: witness.depositRequestHash,
                    destinationHash: witness.destinationHash,
                    token: witness.token,
                    amount: witness.amount,
                    feeAmount: witness.feeAmount,
                    reserver: witness.reserver,
                    releaser: witness.releaser,
                    settler: witness.settler
                })
            )
        );
        bytes32 expectedHash = s_escrow.getDepositHash(depositId);

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.InvalidWitnessValues.selector, witness.depositId, expectedHash, passedHash)
        );
        s_escrow.refund(refundInput);
    }

    // The depositor cannot refund a Permit2 deposit alone: `refundUnreserved` rebuilds a tuple with
    // zero quoteHash, settler and fee, and `deposit()` never stores one.
    function test_refundUnreserved_permit2DepositReverts() public {
        (bytes32 depositId,) = test_deposit_success();

        vm.expectPartialRevert(IEscrow.InvalidWitnessValues.selector);
        vm.prank(depositor);
        s_escrow.refundUnreserved(
            IEscrow.RefundUnreservedInput({
                depositId: depositId,
                depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                destinationHash: DEFAULT_DESTINATION_HASH,
                token: address(s_token),
                amount: DEPOSIT_AMOUNT,
                reserver: reserver,
                releaser: releaser
            })
        );
    }

    function test_refund_quoteHash_empty_reverts() public {
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: bytes32(0),
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        vm.expectRevert(IEscrow.QuoteHashCannotBeEmpty.selector);
        s_escrow.refund(refundInput);
    }

    function test_refund_quoteHash_mismatch_reverts() public {
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: keccak256("wrong payment request"),
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes32 passedHash = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: witness.depositor,
                    quoteHash: witness.quoteHash,
                    depositRequestHash: witness.depositRequestHash,
                    destinationHash: witness.destinationHash,
                    token: witness.token,
                    amount: witness.amount,
                    feeAmount: witness.feeAmount,
                    reserver: witness.reserver,
                    releaser: witness.releaser,
                    settler: witness.settler
                })
            )
        );
        bytes32 expectedHash = s_escrow.getDepositHash(depositId);
        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        vm.expectRevert(
            abi.encodeWithSelector(IEscrow.InvalidWitnessValues.selector, witness.depositId, expectedHash, passedHash)
        );
        s_escrow.refund(refundInput);
    }

    function test_refund_already_released_reverts() public {
        // First release the deposit
        (bytes32 depositId, uint256 feeAmount) = test_release_success();
        // Try to refund after release
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositId));
        s_escrow.refund(refundInput);
    }

    function test_refund_already_refunded_reverts() public {
        // First refund successfully
        (bytes32 depositId, uint256 feeAmount) = test_refund_success();
        // Try to refund again
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});

        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositId));
        s_escrow.refund(refundInput);
    }

    function test_refund_invalid_signature_reverts() public {
        // First create a deposit
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create signature with wrong private key (using depositor instead of releaser)
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), depositorPrivateKey); // Wrong key!
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});
        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.refund(refundInput);
    }

    function test_refund_paused_reverts() public {
        // First create a deposit
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create releaser signature for refund
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});
        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();
        vm.stopPrank();

        // Should revert with EnforcedPause
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        vm.prank(settler);
        s_escrow.refund(refundInput);
    }

    function test_refundMany_paused_reverts() public {
        // First create deposits to refund
        bytes32[] memory depositIds = new bytes32[](2);
        uint256[] memory feeAmounts = new uint256[](2);
        (depositIds[0], feeAmounts[0]) = test_deposit_success();

        // Create second deposit with different nonce
        uint256 nonce = 2;
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        depositIds[1] = expectedDepositId(permit, depositor, depositWitness, depositSignature);
        feeAmounts[1] = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(depositIds[1], settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        s_escrow.deposit(depositInput);

        // Create refund inputs for both deposits
        IEscrow.RefundInput[] memory refundInputs = new IEscrow.RefundInput[](2);

        for (uint256 i = 0; i < 2; i++) {
            IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
                depositId: depositIds[i],
                quoteHash: DEFAULT_QUOTE_HASH,
                depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                destinationHash: DEFAULT_DESTINATION_HASH,
                depositor: depositor,
                token: address(s_token),
                amount: DEPOSIT_AMOUNT,
                feeAmount: feeAmounts[i],
                reserver: reserver,
                releaser: releaser,
                settler: settler
            });

            bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
            refundInputs[i] = IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});
        }

        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();
        vm.stopPrank();

        // Should revert with EnforcedPause
        vm.prank(settler);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_escrow.refundMany(refundInputs);
    }

    function test_refund_works_after_unpause() public {
        // First create a deposit
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create releaser signature for refund
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});
        // Pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();

        // Unpause the contract
        s_escrow.unpause();
        vm.stopPrank();

        // Check balances before refund
        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        // Should now work normally
        vm.prank(settler);
        vm.expectEmit(true, true, true, true);
        emit IEscrow.Refunded(depositId, depositor, address(s_token), DEPOSIT_AMOUNT);
        s_escrow.refund(refundInput);
        vm.snapshotGasLastCall("refund_works_after_unpause");
        // Verify token transfer back to depositor
        assertEq(
            s_token.balanceOf(depositor),
            depositorBalanceBefore + DEPOSIT_AMOUNT,
            "Depositor should receive refunded tokens"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)), escrowBalanceBefore - DEPOSIT_AMOUNT, "Escrow balance should decrease"
        );

        // Verify deposit status
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    // withdrawFeeRevenue

    function test_withdrawFeeRevenue_success() public {
        address treasury = makeAddr("treasury");
        (, uint256 feeAmount) = test_release_success();
        assertEq(s_escrow.getFeeRevenue(s_token), feeAmount);
        vm.startPrank(s_treasurer);
        s_escrow.withdrawFeeRevenue(s_token, treasury);
        vm.stopPrank();
        assertEq(s_token.balanceOf(treasury), feeAmount);
        assertEq(s_token.balanceOf(address(s_escrow)), 0);
    }

    function test_withdrawFeeRevenue_non_owner_reverts() public {
        address random = makeAddr("random");
        test_release_success();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, random, s_escrow.TREASURER_ROLE()
            )
        );
        vm.prank(random);
        s_escrow.withdrawFeeRevenue(s_token, random);
    }

    function test_withdrawFeeRevenue_recipient_cannot_be_zero_address_reverts() public {
        address treasury = makeAddr("treasury");
        vm.startPrank(s_treasurer);
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.RecipientCannotBeZeroAddress.selector));
        s_escrow.withdrawFeeRevenue(s_token, address(0));
        vm.stopPrank();
    }

    function test_withdrawFeeRevenue_recipient_cannot_be_self_reverts() public {
        address treasury = makeAddr("treasury");
        vm.startPrank(s_treasurer);
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.RecipientCannotBeSelf.selector));
        s_escrow.withdrawFeeRevenue(s_token, address(s_escrow));
        vm.stopPrank();
    }

    function test_withdrawFeeRevenue_no_fees_to_withdraw_reverts() public {
        address treasury = makeAddr("treasury");
        vm.startPrank(s_treasurer);
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.NoFeesToWithdraw.selector, s_token));
        s_escrow.withdrawFeeRevenue(s_token, treasury);
        vm.stopPrank();
    }

    // ADDITIONAL EDGE CASE TESTS

    function test_getActiveDeposit_nonexistent_deposit() public view {
        bytes32 nonExistentId = keccak256("nonexistent");

        // Getting info for non-existent deposit should return empty struct
        bytes32 activeDeposit = s_escrow.getDepositHash(nonExistentId);

        assertEq(activeDeposit, bytes32(0), "Deposit hash should be zero");
    }

    function _makeAndCheckDeposit(uint256 nonce, bytes32 quoteHash, bytes32 expectedHash)
        private
        returns (bytes32 depositId)
    {
        // Create first deposit
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);
        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);
        depositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(depositId, quoteHash, settler);
        bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

        IEscrow.DepositInput memory depositInput = IEscrow.DepositInput({
            permit: permit,
            depositor: depositor,
            depositWitness: depositWitness,
            depositSignature: depositSignature,
            reserveWitness: reserveWitness,
            reserveSignature: reserveSignature
        });
        vm.prank(settler);
        s_escrow.deposit(depositInput);

        bytes32 depositHash = s_escrow.getDepositHash(depositId);
        assertEq(depositHash, expectedHash, "Deposit hash should match");

        return depositId;
    }

    function test_multiple_deposits_different_quoteHashes() public {
        uint256 feeAmount = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));
        bytes32 quoteHash1 = keccak256("payment request 1");
        bytes32 quoteHash2 = keccak256("payment request 2");
        bytes32 expectedHash1 = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: quoteHash1,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler // settler is now set via deposit
                })
            )
        );
        bytes32 expectedHash2 = keccak256(
            abi.encode(
                IEscrow.ActiveDeposit({
                    depositor: depositor,
                    quoteHash: quoteHash2,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler // settler is now set via deposit
                })
            )
        );

        bytes32 depositId1 = _makeAndCheckDeposit(2, quoteHash1, expectedHash1);
        bytes32 depositId2 = _makeAndCheckDeposit(3, quoteHash2, expectedHash2);

        assertTrue(depositId1 != depositId2, "Deposit IDs should be different");
        assertTrue(expectedHash1 != expectedHash2, "Deposit hashes should bind quote hashes");
    }

    function test_refund_after_reservation() public {
        // Create deposit and reserve it
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();

        uint256 depositorBalanceBefore = s_token.balanceOf(depositor);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));

        refundDeposit(
            s_escrow,
            depositId,
            depositor,
            address(s_token),
            DEPOSIT_AMOUNT,
            feeAmount,
            reserver,
            releaser,
            settler,
            releaserPrivateKey
        );

        // Verify refund succeeded even though settler was set
        assertEq(
            s_token.balanceOf(depositor), depositorBalanceBefore + DEPOSIT_AMOUNT, "Depositor should receive refund"
        );
        assertEq(
            s_token.balanceOf(address(s_escrow)), escrowBalanceBefore - DEPOSIT_AMOUNT, "Escrow balance should decrease"
        );

        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    function test_invariant_deposit_cannot_be_both_released_and_refunded() public {
        // This test verifies the critical invariant that a deposit cannot be both released and refunded

        // Create deposit
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();

        // Release it
        IEscrow.ReleaseWitness memory releaseWitness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
        bytes memory releaseSignature =
            _constructReleaseSignature(releaseWitness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: releaseWitness, releaseSignature: releaseSignature});

        vm.prank(settler);
        s_escrow.release(releaseInput);

        // Verify it's released
        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");

        // Now try to refund - should fail
        IEscrow.RefundWitness memory refundWitness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
        bytes memory refundSignature = _constructRefundSignature(refundWitness, address(s_escrow), releaserPrivateKey);
        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: refundWitness, refundSignature: refundSignature});
        vm.expectRevert(abi.encodeWithSelector(IEscrow.DepositNotFound.selector, depositId));
        s_escrow.refund(refundInput);
        // Final verification - invariant holds
        assertTrue(_depositWasCompleted(depositId), "Deposit should remain completed");
    }

    // SIGNATURE EXPIRATION TESTS

    function test_release_with_reserver_signature_fails() public {
        // Test that trying to release with reserver's signature fails
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create signature with reserver's private key (should fail)
        IEscrow.ReleaseWitness memory witness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
        bytes memory releaseSignature = _constructReleaseSignature(witness, address(s_escrow), reserverPrivateKey); // Wrong key for release!
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: witness, releaseSignature: releaseSignature});

        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.release(releaseInput);
    }

    function test_refund_with_reserver_signature_fails() public {
        // Test that trying to refund with reserver's signature fails
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();
        // Create signature with reserver's private key (should fail)
        IEscrow.RefundWitness memory witness = IEscrow.RefundWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });

        bytes memory signature = _constructRefundSignature(witness, address(s_escrow), reserverPrivateKey); // Wrong key for refund!

        IEscrow.RefundInput memory refundInput =
            IEscrow.RefundInput({refundWitness: witness, refundSignature: signature});
        vm.expectRevert(IEscrow.InvalidSignature.selector);
        s_escrow.refund(refundInput);
    }

    function test_full_flow_with_different_reserver_releaser() public {
        // Test the full flow with different reserver and releaser addresses
        (bytes32 depositId, uint256 feeAmount) = test_deposit_success();

        // 2. Release with releaser's signature
        IEscrow.ReleaseWitness memory releaseWitness = IEscrow.ReleaseWitness({
            depositId: depositId,
            quoteHash: DEFAULT_QUOTE_HASH,
            depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
            destinationHash: DEFAULT_DESTINATION_HASH,
            depositor: depositor,
            token: address(s_token),
            amount: DEPOSIT_AMOUNT,
            feeAmount: feeAmount,
            reserver: reserver,
            releaser: releaser,
            settler: settler
        });
        bytes memory releaseSignature =
            _constructReleaseSignature(releaseWitness, address(s_escrow), releaserPrivateKey);
        IEscrow.ReleaseInput memory releaseInput =
            IEscrow.ReleaseInput({releaseWitness: releaseWitness, releaseSignature: releaseSignature});
        uint256 settlerBalanceBefore = s_token.balanceOf(settler);

        vm.prank(settler);
        s_escrow.release(releaseInput);

        // Verify successful release
        assertEq(
            s_token.balanceOf(settler),
            settlerBalanceBefore + DEPOSIT_AMOUNT - feeAmount,
            "Settler should receive tokens"
        );

        assertTrue(_depositWasCompleted(depositId), "Deposit should be marked as completed");
    }

    // function test_play() public {
    //     address a = address(0x123);
    //     bytes memory b = abi.encode("I want to ride my bycicle");
    //     uint256 c = 123;
    //     assertEq(hash(a, b, c), keccak256(abi.encode(a, b, c)));
    // }

    // function hash(uint256 v0, uint256 v1, uint256 v2) internal pure returns (bytes32 result) {
    //     /// @solidity memory-safe-assembly
    //     assembly {
    //         let m := mload(0x40)
    //         mstore(m, v0)
    //         mstore(add(m, 0x20), v1)
    //         mstore(add(m, 0x40), v2)
    //         result := keccak256(m, 0x60)
    //     }
    // }

    struct Benchmark {
        uint256 numDeposits;
        string gassnapshotName;
    }

    function test_depositMany_benchmarking() public {
        Benchmark[] memory benchmarks = new Benchmark[](12);
        benchmarks[0] = Benchmark({numDeposits: 2, gassnapshotName: "depositMany_2_deposits_success"});
        benchmarks[1] = Benchmark({numDeposits: 3, gassnapshotName: "depositMany_3_deposits_success"});
        benchmarks[2] = Benchmark({numDeposits: 5, gassnapshotName: "depositMany_5_deposits_success"});
        benchmarks[3] = Benchmark({numDeposits: 7, gassnapshotName: "depositMany_7_deposits_success"});
        benchmarks[4] = Benchmark({numDeposits: 10, gassnapshotName: "depositMany_10_deposits_success"});
        benchmarks[5] = Benchmark({numDeposits: 15, gassnapshotName: "depositMany_15_deposits_success"});
        benchmarks[6] = Benchmark({numDeposits: 20, gassnapshotName: "depositMany_20_deposits_success"});
        benchmarks[7] = Benchmark({numDeposits: 30, gassnapshotName: "depositMany_30_deposits_success"});
        benchmarks[8] = Benchmark({numDeposits: 40, gassnapshotName: "depositMany_40_deposits_success"});
        benchmarks[9] = Benchmark({numDeposits: 50, gassnapshotName: "depositMany_50_deposits_success"});
        benchmarks[10] = Benchmark({numDeposits: 75, gassnapshotName: "depositMany_75_deposits_success"});
        benchmarks[11] = Benchmark({numDeposits: 100, gassnapshotName: "depositMany_100_deposits_success"});

        for (uint256 i = 0; i < benchmarks.length; i++) {
            IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](benchmarks[i].numDeposits);

            for (uint256 j = 0; j < benchmarks[i].numDeposits; j++) {
                // Each deposit needs a unique nonce
                uint256 nonce = i * 100 + j + 1; // Ensure unique nonces across all tests

                // Setup permit data and witness for this deposit
                (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
                    _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);

                // Generate deposit signature
                bytes memory depositSignature = _constructDepositSignature(
                    permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey
                );

                // Generate expected deposit ID
                bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

                // Construct reserve witness
                IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);

                // Generate reserve signature
                bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

                // Build the deposit input
                depositInputs[j] = IEscrow.DepositInput({
                    permit: permit,
                    depositor: depositor,
                    depositWitness: depositWitness,
                    depositSignature: depositSignature,
                    reserveWitness: reserveWitness,
                    reserveSignature: reserveSignature
                });
            }

            // Execute depositMany and capture gas
            s_escrow.depositMany(depositInputs);
            vm.snapshotGasLastCall(benchmarks[i].gassnapshotName);
        }
    }

    function test_releaseMany_benchmarking() public {
        Benchmark[] memory benchmarks = new Benchmark[](12);
        benchmarks[0] = Benchmark({numDeposits: 2, gassnapshotName: "releaseMany_2_releases_success"});
        benchmarks[1] = Benchmark({numDeposits: 3, gassnapshotName: "releaseMany_3_releases_success"});
        benchmarks[2] = Benchmark({numDeposits: 5, gassnapshotName: "releaseMany_5_releases_success"});
        benchmarks[3] = Benchmark({numDeposits: 7, gassnapshotName: "releaseMany_7_releases_success"});
        benchmarks[4] = Benchmark({numDeposits: 10, gassnapshotName: "releaseMany_10_releases_success"});
        benchmarks[5] = Benchmark({numDeposits: 15, gassnapshotName: "releaseMany_15_releases_success"});
        benchmarks[6] = Benchmark({numDeposits: 20, gassnapshotName: "releaseMany_20_releases_success"});
        benchmarks[7] = Benchmark({numDeposits: 30, gassnapshotName: "releaseMany_30_releases_success"});
        benchmarks[8] = Benchmark({numDeposits: 40, gassnapshotName: "releaseMany_40_releases_success"});
        benchmarks[9] = Benchmark({numDeposits: 50, gassnapshotName: "releaseMany_50_releases_success"});
        benchmarks[10] = Benchmark({numDeposits: 75, gassnapshotName: "releaseMany_75_releases_success"});
        benchmarks[11] = Benchmark({numDeposits: 100, gassnapshotName: "releaseMany_100_releases_success"});

        uint256 feeAmount = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));

        for (uint256 i = 0; i < benchmarks.length; i++) {
            // First, create the deposits using depositMany
            IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](benchmarks[i].numDeposits);
            bytes32[] memory depositIds = new bytes32[](benchmarks[i].numDeposits);

            for (uint256 j = 0; j < benchmarks[i].numDeposits; j++) {
                // Each deposit needs a unique nonce
                uint256 nonce = 1000 + i * 100 + j + 1; // Ensure unique nonces, offset from deposit test

                // Setup permit data and witness for this deposit
                (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
                    _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);

                // Generate deposit signature
                bytes memory depositSignature = _constructDepositSignature(
                    permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey
                );

                // Generate expected deposit ID
                depositIds[j] = expectedDepositId(permit, depositor, depositWitness, depositSignature);

                // Construct reserve witness
                IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(depositIds[j], settler);

                // Generate reserve signature
                bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

                // Build the deposit input
                depositInputs[j] = IEscrow.DepositInput({
                    permit: permit,
                    depositor: depositor,
                    depositWitness: depositWitness,
                    depositSignature: depositSignature,
                    reserveWitness: reserveWitness,
                    reserveSignature: reserveSignature
                });
            }

            // Create all deposits first
            s_escrow.depositMany(depositInputs);

            // Now prepare release inputs
            IEscrow.ReleaseInput[] memory releaseInputs = new IEscrow.ReleaseInput[](benchmarks[i].numDeposits);

            for (uint256 j = 0; j < benchmarks[i].numDeposits; j++) {
                // Construct release witness
                IEscrow.ReleaseWitness memory releaseWitness = IEscrow.ReleaseWitness({
                    depositId: depositIds[j],
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    depositor: depositor,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                });

                // Generate release signature
                bytes memory releaseSignature =
                    _constructReleaseSignature(releaseWitness, address(s_escrow), releaserPrivateKey);

                // Build the release input
                releaseInputs[j] =
                    IEscrow.ReleaseInput({releaseWitness: releaseWitness, releaseSignature: releaseSignature});
            }

            // Execute releaseMany and capture gas
            s_escrow.releaseMany(releaseInputs);
            vm.snapshotGasLastCall(benchmarks[i].gassnapshotName);
        }
    }

    function test_refundMany_benchmarking() public {
        Benchmark[] memory benchmarks = new Benchmark[](12);
        benchmarks[0] = Benchmark({numDeposits: 2, gassnapshotName: "refundMany_2_refunds_success"});
        benchmarks[1] = Benchmark({numDeposits: 3, gassnapshotName: "refundMany_3_refunds_success"});
        benchmarks[2] = Benchmark({numDeposits: 5, gassnapshotName: "refundMany_5_refunds_success"});
        benchmarks[3] = Benchmark({numDeposits: 7, gassnapshotName: "refundMany_7_refunds_success"});
        benchmarks[4] = Benchmark({numDeposits: 10, gassnapshotName: "refundMany_10_refunds_success"});
        benchmarks[5] = Benchmark({numDeposits: 15, gassnapshotName: "refundMany_15_refunds_success"});
        benchmarks[6] = Benchmark({numDeposits: 20, gassnapshotName: "refundMany_20_refunds_success"});
        benchmarks[7] = Benchmark({numDeposits: 30, gassnapshotName: "refundMany_30_refunds_success"});
        benchmarks[8] = Benchmark({numDeposits: 40, gassnapshotName: "refundMany_40_refunds_success"});
        benchmarks[9] = Benchmark({numDeposits: 50, gassnapshotName: "refundMany_50_refunds_success"});
        benchmarks[10] = Benchmark({numDeposits: 75, gassnapshotName: "refundMany_75_refunds_success"});
        benchmarks[11] = Benchmark({numDeposits: 100, gassnapshotName: "refundMany_100_refunds_success"});

        uint256 feeAmount = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig((s_token)));

        for (uint256 i = 0; i < benchmarks.length; i++) {
            // First, create the deposits using depositMany
            IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](benchmarks[i].numDeposits);
            bytes32[] memory depositIds = new bytes32[](benchmarks[i].numDeposits);

            for (uint256 j = 0; j < benchmarks[i].numDeposits; j++) {
                // Each deposit needs a unique nonce
                uint256 nonce = 2000 + i * 100 + j + 1; // Ensure unique nonces, offset from other tests

                // Setup permit data and witness for this deposit
                (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
                    _depositWitness(address(s_token), DEPOSIT_AMOUNT, reserver, releaser, nonce);

                // Generate deposit signature
                bytes memory depositSignature = _constructDepositSignature(
                    permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey
                );

                // Generate expected deposit ID
                depositIds[j] = expectedDepositId(permit, depositor, depositWitness, depositSignature);

                // Construct reserve witness
                IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(depositIds[j], settler);

                // Generate reserve signature
                bytes memory reserveSignature = _constructReserveSignature(s_escrow, reserveWitness, reserverPrivateKey);

                // Build the deposit input
                depositInputs[j] = IEscrow.DepositInput({
                    permit: permit,
                    depositor: depositor,
                    depositWitness: depositWitness,
                    depositSignature: depositSignature,
                    reserveWitness: reserveWitness,
                    reserveSignature: reserveSignature
                });
            }

            // Create all deposits first
            s_escrow.depositMany(depositInputs);

            // Now prepare refund inputs
            IEscrow.RefundInput[] memory refundInputs = new IEscrow.RefundInput[](benchmarks[i].numDeposits);

            for (uint256 j = 0; j < benchmarks[i].numDeposits; j++) {
                // Construct refund witness
                IEscrow.RefundWitness memory refundWitness = IEscrow.RefundWitness({
                    depositId: depositIds[j],
                    quoteHash: DEFAULT_QUOTE_HASH,
                    depositRequestHash: DEFAULT_DEPOSIT_REQUEST_HASH,
                    destinationHash: DEFAULT_DESTINATION_HASH,
                    depositor: depositor,
                    token: address(s_token),
                    amount: DEPOSIT_AMOUNT,
                    feeAmount: feeAmount,
                    reserver: reserver,
                    releaser: releaser,
                    settler: settler
                });

                // Generate refund signature
                bytes memory refundSignature =
                    _constructRefundSignature(refundWitness, address(s_escrow), releaserPrivateKey);

                // Build the refund input
                refundInputs[j] = IEscrow.RefundInput({refundWitness: refundWitness, refundSignature: refundSignature});
            }

            // Execute refundMany and capture gas
            s_escrow.refundMany(refundInputs);
            vm.snapshotGasLastCall(benchmarks[i].gassnapshotName);
        }
    }

    function test_depositMany_mixed_tokens() public {
        // Skip in fork mode - can't deploy new mock tokens or allowlist them
        if (isForkMode) {
            vm.skip(true);
        }

        // Deploy token2 and setup fees
        MockToken token2 = new MockToken("Test Token 2", "TEST2");
        address token2Addr = address(token2);
        vm.startPrank(s_tokenConfig);
        s_escrow.allowToken(token2, 18);
        s_escrow.setTokenFeeConfig(token2, 50000, 0, 25000000);
        vm.stopPrank();

        // Mint and approve
        token2.mint(depositor, type(uint128).max);
        vm.prank(depositor);
        token2.approve(address(s_permit2), type(uint256).max);

        uint256 numDeposits = 4;
        IEscrow.DepositInput[] memory depositInputs = new IEscrow.DepositInput[](numDeposits);

        // Create inputs using a helper to keep stack usage low in the main test function
        for (uint256 i = 0; i < numDeposits; i++) {
            address token = (i % 2 == 0) ? address(s_token) : token2Addr;
            depositInputs[i] = _createDepositInput(token, i + 1);
        }

        // Execute
        vm.prank(settler);
        bytes32[] memory depositIds = s_escrow.depositMany(depositInputs);

        // Verify
        for (uint256 i = 0; i < numDeposits; i++) {
            address token = (i % 2 == 0) ? address(s_token) : token2Addr;
            uint256 expectedFee = s_escrow.determineFee(DEPOSIT_AMOUNT, s_escrow.getTokenConfig(IERC20(token)));

            // We trust the helper constructed the rest correctly, just check fee amount in the hash
            // But we can't easily extract fee from hash without reconstructing the whole struct.
            // Instead, we'll check that the fee determined by the contract matches our expectation for that token type.

            if (token == address(s_token)) {
                assertEq(expectedFee, 0.2e18, "Token 1 fee incorrect");
            } else {
                assertEq(expectedFee, 0.5e18, "Token 2 fee incorrect");
            }

            // Verify the deposit exists (hash is non-zero)
            bytes32 hash = s_escrow.getDepositHash(depositIds[i]);
            assertTrue(hash != bytes32(0), "Deposit should exist");
        }
    }

    // Helper to move stack-heavy construction out of the main test
    function _createDepositInput(address token, uint256 nonce) internal view returns (IEscrow.DepositInput memory) {
        (ISignatureTransfer.PermitTransferFrom memory permit, IEscrow.DepositWitness memory depositWitness) =
            _depositWitness(token, DEPOSIT_AMOUNT, reserver, releaser, nonce);

        bytes memory depositSignature =
            _constructDepositSignature(permit, depositWitness, s_permit2, address(s_escrow), depositorPrivateKey);

        bytes32 expectedDepositId = expectedDepositId(permit, depositor, depositWitness, depositSignature);

        IEscrow.ReserveWitness memory reserveWitness = _reserveWitness(expectedDepositId, settler);
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
}

contract MaliciousERC1271 {
    // Always return valid signature regardless of actual validity
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0x1626ba7e; // IERC1271.isValidSignature.selector
    }
}
